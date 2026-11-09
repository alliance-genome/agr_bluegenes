(ns bluegenes.pages.results.orthologs
  "Convert a Gene list into a new list of its orthologs in one organism.
  AllianceMine holds all species in one mine, so the new list is saved in
  the current mine."
  (:require [re-frame.core :refer [reg-event-db reg-event-fx reg-sub subscribe dispatch]]
            [clojure.string :as str]
            [oops.core :refer [oget]]
            [imcljs.fetch :as fetch]
            [imcljs.save :as save]
            [bluegenes.route :as route]
            [bluegenes.pages.lists.utils :refer [copy-list-name]]))

(def organism-path "Gene.homologues.homologue.organism.shortName")
(def homologue-id-path "Gene.homologues.homologue.id")

(defn available?
  "True when the list is a Gene list and the model has Gene.homologues."
  [model-classes {:keys [type] :as list}]
  (boolean
   (and list
        (= type "Gene")
        (let [gene (get model-classes :Gene)]
          (or (contains? (:collections gene) :homologues)
              (contains? (:references gene) :homologues))))))

(defn list-constraint [list-name]
  {:path "Gene" :op "IN" :value list-name})

(defn organisms-query
  "Distinct organisms are summarised from this query's single column."
  [list-name]
  {:from "Gene"
   :select [organism-path]
   :where [(list-constraint list-name)]})

(defn orthologs-query
  "Homologue genes of `organism` for the genes in the list. Used both to count
  the orthologs and as the query saved as the new list."
  [list-name organism]
  {:from "Gene"
   :select [homologue-id-path]
   :where [(list-constraint list-name)
           {:path organism-path :op "=" :value organism}]})

(defn default-list-name [list-name organism]
  (str list-name " orthologs in " organism))

(defn effective-list-name
  "The name the user typed, or the default for the chosen organism."
  [{:keys [list-source list-name organism]}]
  (if (some? list-name)
    list-name
    (when organism (default-list-name list-source organism))))

(defn organisms-from-summary
  "Organism names from a jsonrows summary response, sorted."
  [{:keys [results]}]
  (->> results (keep :item) (remove str/blank?) sort vec))

(defn- service [db]
  (get-in db [:mines (:current-mine db) :service]))

(defn- failure-message [title res]
  [:messages/add
   {:markup [:span [:strong title] " "
             [:code (if-let [err (not-empty (get-in res [:body :error]))]
                      err
                      "Please check your connection and try again later.")]]
    :timeout 10000
    :style "danger"}])

(reg-event-fx
 ::toggle
 (fn [{db :db} [_ list-name]]
   (if (get-in db [:results :orthologs :open?])
     {:db (assoc-in db [:results :orthologs] nil)}
     {:db (assoc-in db [:results :orthologs]
                    {:open? true
                     :list-source list-name
                     :loading-organisms? true})
      :im-chan {:chan (fetch/rows (service db)
                                  (organisms-query list-name)
                                  {:summaryPath organism-path
                                   :size 1000
                                   :format "jsonrows"})
                :abort ::organisms
                :on-success [::organisms-success list-name]
                :on-failure [::organisms-failure list-name]}})))

(reg-event-fx
 ::organisms-success
 (fn [{db :db} [_ list-name res]]
   (when (= list-name (get-in db [:results :orthologs :list-source]))
     (let [organisms (organisms-from-summary res)]
       (cond-> {:db (update-in db [:results :orthologs] assoc
                               :loading-organisms? false
                               :organisms organisms)}
         ;; With a single choice there is nothing to pick.
         (= 1 (count organisms)) (assoc :dispatch [::select-organism (first organisms)]))))))

(reg-event-fx
 ::organisms-failure
 (fn [{db :db} [_ list-name res]]
   (when (= list-name (get-in db [:results :orthologs :list-source]))
     {:db (update-in db [:results :orthologs] assoc
                     :loading-organisms? false
                     :organisms [])
      :dispatch (failure-message "Failed to fetch organisms with orthologs." res)})))

(reg-event-fx
 ::select-organism
 (fn [{db :db} [_ organism]]
   (let [{:keys [list-source]} (get-in db [:results :orthologs])]
     (if (str/blank? organism)
       {:db (update-in db [:results :orthologs] assoc
                       :organism nil :count nil :loading-count? false)}
       {:db (update-in db [:results :orthologs] assoc
                       :organism organism :count nil :loading-count? true)
        :im-chan {:chan (fetch/rows (service db)
                                    (orthologs-query list-source organism)
                                    {:summaryPath homologue-id-path
                                     :size 1
                                     :format "jsonrows"})
                  :abort ::count
                  :on-success [::count-success list-source organism]
                  :on-failure [::count-failure list-source organism]}}))))

(defn- current? [db list-source organism]
  (let [state (get-in db [:results :orthologs])]
    (and (= list-source (:list-source state))
         (= organism (:organism state)))))

(reg-event-db
 ::count-success
 (fn [db [_ list-source organism res]]
   (if (current? db list-source organism)
     (update-in db [:results :orthologs] assoc
                :loading-count? false
                :count (or (:uniqueValues res) 0))
     db)))

(reg-event-fx
 ::count-failure
 (fn [{db :db} [_ list-source organism res]]
   (when (current? db list-source organism)
     {:db (update-in db [:results :orthologs] assoc :loading-count? false)
      :dispatch (failure-message "Failed to count orthologs." res)})))

(reg-event-db
 ::set-list-name
 (fn [db [_ value]]
   (assoc-in db [:results :orthologs :list-name] value)))

(reg-event-fx
 ::save
 (fn [{db :db} _]
   (let [{:keys [list-source organism] :as state} (get-in db [:results :orthologs])
         lists (get-in db [:assets :lists (:current-mine db)])
         typed (effective-list-name state)
         list-name (if (some (comp #{typed} :name) lists)
                     (copy-list-name lists typed)
                     typed)]
     (when (and organism (not (str/blank? typed)) (not (:saving? state)))
       {:db (assoc-in db [:results :orthologs :saving?] true)
        :im-chan {:chan (save/im-list-from-query (service db) list-name
                                                 (orthologs-query list-source organism))
                  :on-success [::save-success]
                  :on-failure [::save-failure]}}))))

(reg-event-fx
 ::save-success
 (fn [{db :db} [_ {:keys [listName]}]]
   {:db (assoc-in db [:results :orthologs] nil)
    :dispatch [:assets/fetch-lists
               [::route/navigate ::route/results {:title listName}]]}))

(reg-event-fx
 ::save-failure
 (fn [{db :db} [_ res]]
   {:db (assoc-in db [:results :orthologs :saving?] false)
    :dispatch (failure-message "Failed to save list of orthologs." res)}))

(reg-sub
 ::state
 (fn [db]
   (get-in db [:results :orthologs])))

(reg-sub
 ::available?
 :<- [:results/current-list]
 :<- [:model]
 (fn [[list model]]
   (available? model list)))

(defn convert-panel
  "Organism picker, ortholog count, list name input and save button."
  []
  (let [{:keys [organisms organism count loading-organisms?
                loading-count? saving?] :as state} @(subscribe [::state])
        list-name (effective-list-name state)]
    [:div.orthologs-panel
     (cond
       loading-organisms? [:p "Looking for orthologs..."]
       (empty? organisms) [:p "No orthologs found for the genes in this list."]
       :else
       [:<>
        [:div.form-group
         [:label "Target organism"]
         [:select.form-control
          {:value (or organism "")
           :on-change #(dispatch [::select-organism (oget % :target :value)])}
          [:option {:value ""} "Select an organism"]
          (for [o organisms]
            ^{:key o} [:option {:value o} o])]]
        (when organism
          [:p.ortholog-count
           (cond
             loading-count? "Counting orthologs..."
             :else [:<> [:strong count] " ortholog genes found"])])
        [:div.form-group
         [:label "New list name"]
         [:input.form-control
          {:type "text"
           :value (or list-name "")
           :on-change #(dispatch [::set-list-name (oget % :target :value)])}]]
        [:button.btn.btn-primary.btn-raised
         {:type "button"
          :disabled (or saving?
                        loading-count?
                        (not organism)
                        (not (pos? (or count 0)))
                        (str/blank? list-name))
          :on-click #(dispatch [::save])}
         (if saving? "Saving..." "Save list")]])]))

(defn convert-button
  "Toggle button and panel. Renders nothing unless the current list is a Gene
  list in a mine whose model has Gene.homologues."
  [list-name]
  (when @(subscribe [::available?])
    (let [open? (:open? @(subscribe [::state]))]
      [:div.convert-to-orthologs
       [:button.btn.btn-slim
        {:type "button"
         :on-click #(dispatch [::toggle list-name])}
        "Convert to orthologs"]
       (when open?
         [convert-panel])])))
