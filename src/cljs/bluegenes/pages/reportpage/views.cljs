(ns bluegenes.pages.reportpage.views
  (:require [re-frame.core :as re-frame :refer [subscribe dispatch]]
            [reagent.core :as r]
            [bluegenes.pages.reportpage.components.toc :as toc]
            [bluegenes.pages.reportpage.components.sidebar :as sidebar]
            [bluegenes.pages.reportpage.utils :as utils :refer [description-dropdown]]
            #_[bluegenes.components.table :as table]
            [bluegenes.components.lighttable :as lighttable]
            [bluegenes.components.loader :refer [loader]]
            [bluegenes.components.tools.views :as tools]
            [bluegenes.pages.reportpage.events :as events]
            [bluegenes.pages.reportpage.subs :as subs]
            [im-tables.views.core :as im-table]
            [bluegenes.route :as route]
            [bluegenes.components.viz.views :as viz]
            [bluegenes.components.icons :refer [icon icon-comp]]
            [clojure.string :as str]
            [bluegenes.components.bootstrap :refer [poppable]]
            [oops.core :refer [ocall oget]]
            [goog.functions :refer [debounce]]))

(defn tbl [{:keys [loc collapse]}]
  (let [data (subscribe [::subs/a-table loc])
        is-collapsed* (r/atom collapse)]
    (r/create-class
     {:component-did-mount (fn [this]
                             (let [{:keys [loc] :as props} (r/props this)]
                               (when-not @is-collapsed*
                                 (dispatch [:im-tables/load loc (dissoc props :loc)]))))
      :reagent-render (fn [{:keys [loc title id description] :as props}]
                        ;; result-count will be `nil` if query hasn't been loaded.
                        (let [result-count (get-in @data [:response :iTotalRecords])]
                          [:div.report-item
                           {:class [(when (or @is-collapsed* (zero? result-count))
                                      :report-item-collapsed)
                                    (when (zero? result-count)
                                      :report-item-no-results)]
                            :id id}
                           [:h4.report-item-heading
                            {:on-click (fn []
                                         ;; Run query if it hasn't been run due to being collapsed.
                                         (when (and (nil? result-count) @is-collapsed*)
                                           (dispatch [:im-tables/load loc (dissoc props :loc)]))
                                         (swap! is-collapsed* not))}
                            [:span.report-item-title
                             (str title (when result-count (str " (" result-count ")")))
                             (when description [description-dropdown description])]
                            (when ((some-fn nil? pos?) result-count)
                              [:span.report-item-toggle
                               (if @is-collapsed*
                                 [icon "expand-folder"]
                                 [icon "collapse-folder"])])]
                           (cond
                             @is-collapsed* nil
                             (zero? result-count) nil
                             :else [:div
                                    [im-table/main loc]])]))})))

(defn ->report-table-settings [current-mine-name]
  {:pagination {:limit 5}
   :compact true
   :links {:vocab {:mine (name (or current-mine-name ""))}
           :url (fn [{:keys [mine class objectId] :as vocab}]
                  (route/href ::route/report
                              {:mine mine
                               :type class
                               :id objectId}))}})

(defn tool-report [{:keys [collapse id description] tool-cljs-name :value}]
  (let [tool-details @(subscribe [::subs/a-tool tool-cljs-name])]
    [tools/tool tool-details
     :collapse collapse
     :id id
     :description description]))

(defn template-report [{:keys [id collapse description] template-name :value}]
  (let [summary-fields @(subscribe [:current-summary-fields])
        service (:service @(subscribe [:current-mine]))
        current-mine-name @(subscribe [:current-mine-name])
        {:keys [title] :as template} @(subscribe [::subs/a-template template-name])]
    [tbl {:loc [:report :im-tables id]
          :service (merge service {:summary-fields summary-fields})
          :title title
          :collapse collapse
          :description description
          :query template
          :settings (->report-table-settings current-mine-name)
          :id id}]))

(defn class-report [{:keys [id collapse description] nom :value}]
  (let [{object-type :type object-id :id} @(subscribe [:panel-params])
        summary-fields @(subscribe [:current-summary-fields])
        service (:service @(subscribe [:current-mine]))
        current-mine-name @(subscribe [:current-mine-name])
        {:keys [displayName] :as ref+coll} @(subscribe [::subs/a-ref+coll nom])]
    [tbl {:loc [:report :im-tables id]
          :service (merge service {:summary-fields summary-fields})
          :title displayName
          :collapse collapse
          :description description
          :query (utils/->query-ref+coll summary-fields object-type object-id ref+coll)
          :settings (->report-table-settings current-mine-name)
          :id id}]))

(defn section []
  (let [collapsed* (r/atom false)]
    (fn [{:keys [title id]} & children]
      (into [:div.report-table {:id id}
             [:h3.report-table-heading
              title
              [:button.btn.btn-link.pull-right.collapse-table
               {:on-click #(swap! collapsed* not)}
               [icon-comp "chevron-up"
                :classes [(when @collapsed* "collapsed")]]]]]
            (when-not @collapsed* children)))))

(defn report []
  (let [{:keys [rootClass]} @(subscribe [::subs/report-summary])
        categories @(subscribe [:current-mine/report-layout rootClass])
        filter-text @(subscribe [::subs/report-filter-text])]
    [:div
     (doall
      (for [{:keys [category id children]} categories
            ;; This might seem heavy, but most of the signal graph is already
            ;; cached due to `:current-mine/report-layout` subscribing to the
            ;; fallback layout.  What this does is make sure report item is
            ;; "available" for this class (mostly to avoid showing parts of the
            ;; default layout that doesn't apply to this class).
            :let [children (filter (fn [{:keys [type value] :as child}]
                                     (and (contains? (case type
                                                       "class"    @(subscribe [::subs/ref+coll-for-class? rootClass])
                                                       "template" @(subscribe [::subs/template-for-class? rootClass])
                                                       "tool"     @(subscribe [::subs/tool-for-class? rootClass]))
                                                     value)
                                          (if (not-empty filter-text)
                                            (let [label (toc/parse-item-name child)]
                                              (str/includes? (str/lower-case label) (str/lower-case filter-text)))
                                            true)))
                                   children)]
            :when (seq children)] ; No point having a section without children.
        ^{:key id}
        [section
         {:title category
          :id id}
         [:div
          (doall
           (for [{:keys [_label _value type _collapse _description id] :as child} children
                 :let [report-comp (case type
                                     "class"    class-report
                                     "template" template-report
                                     "tool"     tool-report)]]
             ^{:key id}
             [report-comp child]))]]))]))

(defn summary-location [[label value]]
  [:<>
   [:div.report-table-cell.report-table-header
    label]
   [:div.report-table-cell
    [:span.report-table-link
     {:on-click #(dispatch [::events/open-in-region-search value])}
     [poppable {:data "Perform a search of this region"
                :children value}]]]])

(defn encode-file
  "Encode a stringified text file such that it can be downloaded by the browser.
  Results must be stringified - don't pass objects / vectors / arrays / whatever."
  [data filetype]
  (ocall js/URL "createObjectURL"
         (js/Blob. (clj->js [data])
                   {:type (str "text/" filetype)})))

(defn fasta-download []
  (let [id           (subscribe [::subs/fasta-identifier])
        fasta        (subscribe [::subs/fasta])
        download-ref (atom nil)
        download!    #(let [el @download-ref]
                        (ocall el :setAttribute "href" (encode-file @fasta "fasta"))
                        (ocall el :setAttribute "download" (str @id ".fasta"))
                        (ocall el :click))]
    (fn []
      [:<>
       [:a.hidden-download {:download "download" :ref (fn [el] (reset! download-ref el))}]
       [:a.fasta-download {:role "button" :on-click download!}
        [icon-comp "download"]
        "FASTA"]])))

(defn summary-fasta [[label value]]
  (let [fasta @(subscribe [::subs/fasta])]
    [:<>
     [:div.report-table-cell.report-table-header
      label]
     (if (= fasta :too-long)
       ;; Fasta exists but is too long and should be fetched manually.
       (let [{:keys [mine type id]} @(subscribe [:panel-params])]
         [:div.report-table-cell.fasta-value
          [:a.fasta-download
           {:role "button"
            :on-click #(dispatch [:fetch-fasta (keyword mine) type id])}
           [icon-comp "my-data"]
           "LOAD FASTA"]])
       [:div.report-table-cell.fasta-value
        [:span.dropdown
         [:a.dropdown-toggle.fasta-button
          {:data-toggle "dropdown" :role "button"}
          [poppable {:data "Show sequence"
                     :children [:span value [icon-comp "caret-down"]]}]]
         [:div.dropdown-menu.fasta-dropdown
          [:form ; Top secret technique to avoid closing the dropdown when clicking inside.
           [:pre.fasta-sequence fasta]]]]
        [fasta-download]])]))

(defn anchor-if-url [x]
  (if (string? x)
    (let [s (str/trim x)]
      (if (re-matches #"https?://[^\s]*" s)
        [:a {:href s :target "_blank"} s]
        x))
    x))

(defn summary []
  (let [{:keys [columnHeaders results]} @(subscribe [::subs/report-summary])
        fasta               @(subscribe [::subs/fasta])
        chromosome-location @(subscribe [::subs/chromosome-location])
        fasta-length        @(subscribe [::subs/fasta-length])
        entries (->> (concat (filter val (zipmap columnHeaders (first results)))
                             (when (not-empty chromosome-location)
                               [^{:type :location} ["Chromosome Location" chromosome-location]])
                             (when fasta
                               [^{:type :fasta} ["Sequence Length" fasta-length]]))
                     (partition-all 2))]
    [section
     {:title utils/pre-section-title
      :id utils/pre-section-id}
     (into [:div.report-table-body]
           (for [row entries]
             (into [:div.report-table-row]
                   (for [cell row
                         :let [meta-type (-> cell meta :type)]]
                     (case meta-type
                       :location [summary-location cell]
                       :fasta [summary-fasta cell]
                       [:<>
                        [:div.report-table-cell.report-table-header
                         (-> cell key (str/split " > ") last)]
                        [:div.report-table-cell
                         (-> cell val (or "N/A") anchor-if-url)]])))))
     [:div.hidden-lg
      [sidebar/main]]]))

(defn filter-input []
  (let [input (r/atom @(subscribe [::subs/report-filter-text]))
        debounced (debounce #(dispatch [::events/set-filter-text %]) 500)
        on-change (fn [e]
                    (let [value (oget e :target :value)]
                      (reset! input value)
                      (debounced value)))]
    (fn []
      [:div.report-page-filter
       [:input.form-control
        {:type "text"
         :placeholder "Find keywords..."
         :on-change on-change
         :value @input}]])))

(defn heading []
  (let [{:keys [rootClass]} @(subscribe [::subs/report-summary])
        title @(subscribe [::subs/report-title])]
    [:h1.report-page-heading
     title
     [:code.start {:class (str "start-" rootClass)} rootClass]]))

(defn invalid-object []
  (let [{error-type :type ?message :message} @(subscribe [::subs/report-error])]
    [:div.row
     [:div.col-xs-8.col-xs-offset-2
      [:div.well.well-lg.invalid-object-container
       [:h2 (case error-type
              :not-found "Object not found"
              :ws-failure "Failed to retrieve object")]
       [:p (case error-type
             :not-found "It may have existed before and been assigned a new ID after a database rebuild. If you remember one of its identifiers, you can search for it. You can also see if any lists contain it. Please export a permanent URL next time you want to keep a link to an object."
             :ws-failure "This may be due to a network error, invalid URL or server issues. Please verify that the URL is correct and try again later.")]
       (when-let [msg (not-empty ?message)]
         [:pre msg])
       [:a.btn.btn-primary.btn-lg
        {:href (route/href ::route/home)}
        "Go to homepage"]]]]))

(defn main []
  (let [fetching-report? @(subscribe [:fetching-report?])
        error @(subscribe [::subs/report-error])
        params @(subscribe [:panel-params])]
    [:div.container-fluid.report-page
     (cond
       fetching-report? [loader (str (:type params) " Report")]
       error [invalid-object]
       :else [:<>
              [:div.row
               [:div.col-xs-2
                [filter-input]]
               [:div.col-xs-8
                [heading]]]
              [:div.row.report-row
               [:div.col-xs-2
                [toc/main]]
               [:div.col-xs-10.col-lg-8
                [summary]
                [report]]
               [:div.col-lg-2.visible-lg-block
                [sidebar/main]]]])]))
