(ns bluegenes.pages.results.cite
  "Cite / methods panel on the results page. Builds a methods paragraph and
  BibTeX / RIS entries for the mine behind the current list or query. Text
  generation lives in `bluegenes.cite`."
  (:require [reagent.core :as r]
            [re-frame.core :refer [reg-event-db reg-event-fx reg-fx reg-sub subscribe dispatch]]
            [oops.core :refer [oget ocall]]
            [imcljs.fetch :as fetch]
            [bluegenes.cite :as cite]
            [bluegenes.alliance-release :as alliance-release]
            [bluegenes.utils :refer [encode-file]]))

;;; Pure helpers ;;;

(defn today
  "Current date as yyyy-mm-dd (UTC)."
  []
  (subs (.toISOString (js/Date.)) 0 10))

(defn missing-versions
  "Which of the release and InterMine version are not cached for a mine."
  [db mine-kw]
  (filterv #(nil? (get-in db [:assets % mine-kw]))
           [:release-version :intermine-version]))

(defn subject
  "What the panel describes: the current list, or else the current query."
  [{:keys [intent list query]}]
  (if (and (= intent :list) list)
    {:kind :list :name (:name list) :size (:size list) :type (:type list)}
    {:kind :query :query query}))

(defn mine-info
  "Mine fields for citation text, from the db entry of the results' source mine."
  [db mine-kw]
  (let [mine (get-in db [:mines mine-kw])]
    {:mine-name (or (:name mine) (name mine-kw))
     :url (get-in mine [:service :root])
     :release (cite/clean-version (get-in db [:assets :release-version mine-kw]))
     :intermine-version (cite/clean-version (get-in db [:assets :intermine-version mine-kw]))}))

(defn texts
  "All generated texts for a mine map plus date and subject."
  [mine date subj]
  (let [m (assoc mine :date date)]
    {:methods (cite/methods-paragraph (assoc m :subject subj))
     :bibtex (cite/bibtex m)
     :ris (cite/ris m)}))

;;; Events ;;;

(defn source-mine
  "The mine the current results come from."
  [db]
  (or (get-in db [:results :package :source]) (:current-mine db)))

(defn alliance-source?
  "True when the mine behind the results is an Alliance mine."
  [db mine-kw]
  (or (cite/alliance-mine? (get-in db [:mines mine-kw :service :root]))
      (cite/alliance-mine? (name mine-kw))))

(reg-event-fx
 ::toggle
 (fn [{db :db} _]
   (let [open? (not (get-in db [:results :cite :open?]))]
     {:db (assoc-in db [:results :cite] {:open? open? :date (today)})})))

(reg-event-fx
 ::fetch-version
 (fn [{db :db} [_ asset-key mine-kw]]
   {:im-chan {:chan (let [service (get-in db [:mines mine-kw :service])]
                      (case asset-key
                        :release-version (fetch/version-release service)
                        :intermine-version (fetch/version-intermine service)))
              :on-success [::version-success asset-key mine-kw]
              :on-failure [::version-failure]}}))

(defn ensure-requests
  "Events to dispatch when the panel opens: the missing mine versions, and the
  Alliance release for AllianceMine only. The MOD mines load their own
  releases, so no Alliance release is requested for them."
  [db]
  (let [mine-kw (source-mine db)]
    (vec (concat (for [asset-key (missing-versions db mine-kw)]
                   [::fetch-version asset-key mine-kw])
                 (when (alliance-source? db mine-kw)
                   [[::alliance-release/ensure]])))))

(reg-event-fx
 ::ensure-versions
 (fn [{db :db} _]
   {:db (update-in db [:results :cite] dissoc :version-error?)
    :dispatch-n (ensure-requests db)}))

(reg-event-db
 ::version-success
 (fn [db [_ asset-key mine-kw version]]
   (assoc-in db [:assets asset-key mine-kw] version)))

(reg-event-db
 ::version-failure
 (fn [db _]
   (assoc-in db [:results :cite :version-error?] true)))

(reg-event-db
 ::set-feedback
 (fn [db [_ what]]
   (assoc-in db [:results :cite :copied] what)))

(reg-fx
 ::copy
 (fn [{:keys [text on-done]}]
   (let [done #(dispatch [::set-feedback on-done])]
     (if-let [clipboard (oget js/navigator "?clipboard")]
       (.then (ocall clipboard "writeText" text) done)
       (let [area (.createElement js/document "textarea")]
         (set! (.-value area) text)
         (.appendChild (.-body js/document) area)
         (.select area)
         (ocall js/document "execCommand" "copy")
         (.removeChild (.-body js/document) area)
         (done))))))

(reg-fx
 ::download
 (fn [{:keys [text filename filetype]}]
   (let [url (encode-file text filetype)
         link (.createElement js/document "a")]
     (set! (.-href link) url)
     (set! (.-download link) filename)
     (.appendChild (.-body js/document) link)
     (.click link)
     (.removeChild (.-body js/document) link)
     (ocall js/window.URL "revokeObjectURL" url))))

(reg-event-fx
 ::copy
 (fn [_ [_ what text]]
   {::copy {:text text :on-done what}}))

(reg-event-fx
 ::download
 (fn [_ [_ filename filetype text]]
   {::download {:text text :filename filename :filetype filetype}}))

;;; Subs ;;;

(reg-sub ::state (fn [db] (get-in db [:results :cite])))

(reg-sub
 ::texts
 (fn [db]
   (let [mine-kw (source-mine db)
         subj (subject {:intent (get-in db [:results :package :intent])
                        :list (->> (get-in db [:assets :lists mine-kw])
                                   (filter #(= (get-in db [:results :query :title]) (:title %)))
                                   first)
                        :query (get-in db [:results :query])})]
     (assoc (texts (cond-> (mine-info db mine-kw)
                     (alliance-source? db mine-kw)
                     (assoc :alliance (alliance-release/release db)))
                   (or (get-in db [:results :cite :date]) (today))
                   subj)
            :mine-kw mine-kw
            :mine-ready? (some? (get-in db [:mines mine-kw :service :root]))
            :versions-missing (missing-versions db mine-kw)))))

;;; Views ;;;

(defn cite-button []
  [:button.btn.btn-link.btn-results.cite-button
   {:type "button"
    :on-click #(dispatch [::toggle])}
   "Cite / methods"])

(defn- text-block [{:keys [id label text filename filetype copied]}]
  [:div.cite-block
   [:h4 label]
   [:textarea.form-control
    {:id (str "cite-" (name id)) :rows (if (= id :methods) 5 10) :read-only true :value text}]
   [:div.cite-actions
    [:button.btn.btn-default
     {:type "button" :on-click #(dispatch [::copy id text])}
     (if (= copied id) "Copied" "Copy")]
    (when filename
      [:button.btn.btn-default
       {:type "button" :on-click #(dispatch [::download filename filetype text])}
       (str "Download " filename)])]])

(defn- ensure-versions-on-mount
  "Fetches the missing versions when mounted. The panel keys it by mine, so
  loading results from another mine remounts it and fetches for that mine."
  []
  (r/create-class
   {:component-did-mount #(dispatch [::ensure-versions])
    :reagent-render (fn [] [:span.hidden])}))

(defn cite-panel []
  (let [{:keys [open? copied version-error?]} @(subscribe [::state])]
    (when open?
      (let [{:keys [methods bibtex ris versions-missing mine-kw]} @(subscribe [::texts])]
        [:div.cite-panel
         [:h3 "Cite / methods"]
         ^{:key mine-kw} [ensure-versions-on-mount]
         (when (and (seq versions-missing) (not version-error?))
           [:p.cite-note "Fetching mine version..."])
         (when version-error?
           [:p.failure "Could not read the mine version. The text names no version."])
         [text-block {:id :methods :label "Methods paragraph" :text methods :copied copied}]
         [text-block {:id :bibtex :label "BibTeX" :text bibtex :copied copied
                      :filename "citations.bib" :filetype "x-bibtex"}]
         [text-block {:id :ris :label "RIS" :text ris :copied copied
                      :filename "citations.ris" :filetype "x-research-info-systems"}]]))))
