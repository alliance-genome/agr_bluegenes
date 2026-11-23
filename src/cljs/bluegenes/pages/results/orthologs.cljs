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
            [bluegenes.mine-support :as mine-support]
            [bluegenes.pages.results.orthologs-preview :as preview]
            [bluegenes.pages.lists.utils :refer [copy-list-name]]))

(def organism-path "Gene.homologues.homologue.organism.shortName")
(def homologue-id-path "Gene.homologues.homologue.id")

(def fetch-limit
  "Rows asked for by the preview and the list-gene queries."
  100000)

(def required-paths
  "Paths the conversion queries in the current mine: the organism summary, the
  ortholog count and the saved list all use these."
  [organism-path homologue-id-path])

(defn blocked-reason
  "Why the conversion cannot run in a mine with model `model-classes`, or nil.
  WormMine, FlyMine and YeastMine have Gene.homologues, so only a model without
  it (or without the homologue's id or organism) blocks."
  [model-classes mine-label]
  (mine-support/blocked-reason model-classes mine-label required-paths))

(defn available?
  "True when the list is a Gene list and every path the conversion queries
  resolves in the model."
  [model-classes {:keys [type] :as list}]
  (boolean
   (and list
        (= type "Gene")
        (empty? (mine-support/missing-paths model-classes required-paths)))))

(defn list-constraint [list-name]
  {:path "Gene" :op "IN" :value list-name})

(defn organisms-query
  "Distinct organisms are summarised from this query's single column. With the
  type feature only organisms holding orthologs are offered."
  ([list-name]
   (organisms-query list-name {}))
  ([list-name features]
   {:from "Gene"
    :select [organism-path]
    :where (into [(list-constraint list-name)] (preview/type-constraints features))}))

(defn orthologs-query
  "Homologue genes of `organism` for the genes in the list. Used both to count
  the orthologs and as the query saved as the new list. `opts` (:min-methods,
  :best-only?) narrow the homologues the mine has the columns for, `features`."
  ([list-name organism]
   (orthologs-query list-name organism {} {}))
  ([list-name organism opts features]
   {:from "Gene"
    :select [homologue-id-path]
    :where (into [(list-constraint list-name)
                  {:path organism-path :op "=" :value organism}]
                 (concat (preview/type-constraints features)
                         (preview/filter-constraints opts features)))}))

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

(defn model-features
  "Preview features (:type? :methods? :best? :best-reverse? :stringency?) whose path
  resolves in the model. An unknown model offers all of them."
  [classes]
  (let [missing (set (mine-support/missing-paths classes (vals preview/optional-paths)))]
    (into {} (map (fn [[feature path]] [feature (not (contains? missing path))]))
          preview/optional-paths)))

(defn list-genes-query [list-name]
  {:from "Gene"
   :select ["Gene.id" "Gene.primaryIdentifier" "Gene.symbol"]
   :where [(list-constraint list-name)]})

(defn- filter-opts [{:keys [min-methods best-only? stringent-only?]}]
  {:min-methods min-methods :best-only? best-only? :stringent-only? stringent-only?})

(defn shown-targets
  "Number of orthologs after the preview filters, or the server count while
  the preview rows are not loaded."
  [{:keys [rows count truncated?] :as state}]
  (if (and rows (not truncated?))
    (preview/target-count (preview/filter-rows (filter-opts state) rows))
    count))

(defn description
  "Provenance stored with the saved list."
  [{:keys [list-source organism min-methods best-only? stringent-only?]} date]
  (str "Orthologs of " list-source " in " organism
       (when (pos? (or min-methods 0)) (str ", at least " min-methods " methods"))
       (when best-only? ", best matches only")
       (when stringent-only? ", stringent only")
       "; " date))

(defn failure-message [title res]
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
                     :features (model-features (mine-support/mine-classes db (:current-mine db)))
                     :loading-organisms? true})
      :im-chan {:chan (fetch/rows (service db)
                                  (organisms-query list-name (model-features (mine-support/mine-classes db (:current-mine db))))
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
   (let [{:keys [list-source features]} (get-in db [:results :orthologs])]
     (if (str/blank? organism)
       {:db (update-in db [:results :orthologs] assoc
                       :organism nil :count nil :loading-count? false
                       :rows nil :truncated? false :min-methods 0 :best-only? false
                       :stringent-only? false :relation-filter nil :show-all-unmapped? false)}
       {:db (update-in db [:results :orthologs] assoc
                       :organism organism :count nil :loading-count? true
                       :loading-preview? true :rows nil :truncated? false
                       :min-methods 0 :best-only? false :stringent-only? false
                       :relation-filter nil :show-all-unmapped? false)
        :dispatch [::fetch-preview organism]
        :im-chan {:chan (fetch/rows (service db)
                                    (orthologs-query list-source organism {} features)
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

;; Preview rows and the list's own genes

(reg-event-fx
 ::fetch-preview
 (fn [{db :db} [_ organism]]
   (let [{:keys [list-source features]} (get-in db [:results :orthologs])]
     {:im-chan {:chan (fetch/rows (service db)
                                  (preview/preview-query list-source organism features)
                                  {:format "json" :size fetch-limit})
                :abort ::preview
                :on-success [::preview-success list-source organism]
                :on-failure [::preview-failure list-source organism]}})))

(reg-event-fx
 ::preview-success
 (fn [{db :db} [_ list-source organism res]]
   (when (current? db list-source organism)
     (let [{:keys [features genes]} (get-in db [:results :orthologs])]
       (cond-> {:db (update-in db [:results :orthologs] assoc
                               :loading-preview? false
                               :truncated? (preview/truncated? (:results res) fetch-limit)
                               :rows (preview/flag-relations
                                      (preview/parse-rows (:results res) features)))}
         (nil? genes) (assoc :im-chan {:chan (fetch/rows (service db)
                                                         (list-genes-query list-source)
                                                         {:format "json" :size fetch-limit})
                                       :abort ::list-genes
                                       :on-success [::list-genes-success list-source]
                                       :on-failure [::list-genes-failure list-source]}))))))

(reg-event-fx
 ::preview-failure
 (fn [{db :db} [_ list-source organism res]]
   (when (current? db list-source organism)
     {:db (update-in db [:results :orthologs] assoc :loading-preview? false)
      :dispatch (failure-message "Failed to load the ortholog preview." res)})))

(reg-event-db
 ::list-genes-success
 (fn [db [_ list-source res]]
   (if (= list-source (get-in db [:results :orthologs :list-source]))
     (update-in db [:results :orthologs] assoc
                :genes (preview/parse-genes (:results res))
                :genes-truncated? (preview/truncated? (:results res) fetch-limit))
     db)))

(reg-event-fx
 ::list-genes-failure
 (fn [{db :db} [_ list-source res]]
   (when (= list-source (get-in db [:results :orthologs :list-source]))
     {:db (assoc-in db [:results :orthologs :genes-failed?] true)
      :dispatch (failure-message "Failed to load the genes of the list." res)})))

(reg-event-db
 ::set-min-methods
 (fn [db [_ value]]
   (let [n (js/parseInt value 10)]
     (assoc-in db [:results :orthologs :min-methods] (if (js/isNaN n) 0 n)))))

(reg-event-db
 ::set-best-only
 (fn [db [_ value]]
   (assoc-in db [:results :orthologs :best-only?] (boolean value))))

(reg-event-db
 ::set-stringent-only
 (fn [db [_ value]]
   (assoc-in db [:results :orthologs :stringent-only?] (boolean value))))

(reg-event-db
 ::set-relation-filter
 (fn [db [_ value]]
   (assoc-in db [:results :orthologs :relation-filter]
             (some-> value not-empty keyword))))

(reg-event-db
 ::toggle-unmapped
 (fn [db _]
   (update-in db [:results :orthologs :show-all-unmapped?] not)))

(reg-event-db
 ::set-list-name
 (fn [db [_ value]]
   (assoc-in db [:results :orthologs :list-name] value)))

(reg-event-fx
 ::save
 (fn [{db :db} _]
   (let [{:keys [list-source organism features] :as state}
         (get-in db [:results :orthologs])
         lists (get-in db [:assets :lists (:current-mine db)])
         typed (effective-list-name state)
         list-name (if (some (comp #{typed} :name) lists)
                     (copy-list-name lists typed)
                     typed)]
     (when (and organism (not (str/blank? typed)) (not (:saving? state)))
       {:db (assoc-in db [:results :orthologs :saving?] true)
        :im-chan {:chan (save/im-list-from-query (service db) list-name
                                                 (orthologs-query list-source organism (filter-opts state) features)
                                                 {:description (description state (subs (.toISOString (js/Date.)) 0 10))
                                                  :tags "orthologs"})
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

(reg-sub
 ::blocked-reason
 :<- [:results/current-list]
 :<- [:model]
 :<- [:current-mine-name]
 (fn [[list model mine-kw]]
   (when (and list (= "Gene" (:type list)))
     (blocked-reason model (some-> mine-kw name)))))

(reg-sub
 ::preview-data
 :<- [::state]
 (fn [{:keys [rows genes truncated? genes-truncated?] :as state}]
   (when rows
     (if truncated?
       {:truncated? true}
       (let [kept (preview/filter-rows (filter-opts state) rows)]
         {:rows kept
          :max-methods (preview/max-methods rows)
          :no-methods (preview/without-methods rows)
          :relation-counts (preview/relation-counts kept)
          :unmapped (when (and genes (not genes-truncated?))
                      {:none (preview/unmapped-genes genes rows)
                       :dropped (preview/dropped-genes genes rows kept)})})))))

(def ^:private max-preview-rows 200)
(def ^:private max-unmapped-rows 100)

(defn- yes-no [v] (if v "yes" "no"))

(defn- methods-cell [{:keys [match attempted]}]
  (if (nil? match) "" (str match (when attempted (str " of " attempted)))))

(defn- download!
  "Hand `text` to the browser as a file called `filename`."
  [filename text]
  (let [url (.createObjectURL js/URL (js/Blob. #js [text] #js {:type "text/tab-separated-values"}))
        link (.createElement js/document "a")]
    (set! (.-href link) url)
    (set! (.-download link) filename)
    (.click link)
    (js/setTimeout #(.revokeObjectURL js/URL url) 1000)))

(defn preview-table [rows features]
  [:div.agr-table-wrap
   [:table.agr-table.agr-table-sm.agr-table-striped.ortholog-preview
    [:caption.sr-only "Source genes of the list and their orthologs in the chosen organism"]
    [:thead
     [:tr [:th "Source gene"] [:th "Target gene"]
      (when (:type? features) [:th "Type"])
      (when (:methods? features) [:th.num "Methods"])
      (when (:best? features) [:th "Best score"])
      (when (:best-reverse? features) [:th "Best reverse"])
      (when (:stringency? features) [:th "Stringency"])
      [:th "Relation within list"]]]
    [:tbody
     (for [{:keys [gene-id target-id gene target type best? best-reverse? stringency relation] :as row}
           (take max-preview-rows rows)]
       ^{:key (str gene-id "-" target-id)}
       [:tr {:class (when-not (= :one-to-one relation) "ortholog-flagged")}
        [:td gene] [:td target]
        (when (:type? features) [:td type])
        (when (:methods? features) [:td.num (methods-cell row)])
        (when (:best? features) [:td (yes-no best?)])
        (when (:best-reverse? features) [:td (yes-no best-reverse?)])
        (when (:stringency? features) [:td stringency])
        [:td (preview/relation-labels relation)]])]]])

(defn unmapped-list [{:keys [none dropped]} show-all?]
  (let [shown (fn [genes] (if show-all? genes (take max-unmapped-rows genes)))
        more (- (+ (count none) (count dropped))
                (+ (count (shown none)) (count (shown dropped))))]
    (if (and (empty? none) (empty? dropped))
      [:p.agr-note "Every gene in the list has an ortholog."]
      [:details.ortholog-unmapped
       [:summary
        (str (preview/plural (count none) "gene" "genes") " without an ortholog"
             (when (seq dropped)
               (str ", " (preview/plural (count dropped) "gene" "genes") " removed by the filters")))]
       [:ul.list-unstyled
        (for [{:keys [id label]} (shown none)]
          ^{:key id} [:li label])
        (for [{:keys [id label]} (shown dropped)]
          ^{:key (str "dropped-" id)} [:li label " (removed by the filters)"])]
       (when (or (pos? more) show-all?)
         [:button.agr-btn {:type "button" :on-click #(dispatch [::toggle-unmapped])}
          (if show-all? "Show fewer" (str "Show all (" more " more)"))])
       [:button.agr-btn {:type "button"
                         :on-click #(download! "unmapped-genes.tsv" (preview/unmapped-tsv none dropped))}
        "Download unmapped genes (TSV)"]])))

(defn preview-filters [{:keys [min-methods best-only? stringent-only? relation-filter]}
                       max-methods no-methods features]
  [:div.agr-filter-bar
   (when (and (:methods? features) (pos? max-methods))
     [:label (str "At least " (or min-methods 0) " of " (preview/plural max-methods "method" "methods"))
      [:input {:type "range" :min 0 :max max-methods :step 1
               :value (or min-methods 0)
               :aria-valuetext (str (or min-methods 0) " of " (preview/plural max-methods "method" "methods"))
               :on-change #(dispatch [::set-min-methods (oget % :target :value)])}]])
   (when (:best? features)
     [:label
      [:input {:type "checkbox"
               :checked (boolean best-only?)
               :on-change #(dispatch [::set-best-only (oget % :target :checked)])}]
      " Best matches only"])
   (when (:stringency? features)
     [:label
      [:input {:type "checkbox"
               :checked (boolean stringent-only?)
               :on-change #(dispatch [::set-stringent-only (oget % :target :checked)])}]
      " Stringent only"])
   [:label "Show relation"
    [:select.form-control
     {:value (if relation-filter (name relation-filter) "")
      :on-change #(dispatch [::set-relation-filter (oget % :target :value)])}
     [:option {:value ""} "All"]
     (for [[k l] preview/relation-labels]
       ^{:key k} [:option {:value (name k)} l])]]
   (when (and (:methods? features) (pos? (or no-methods 0)))
     [:span.agr-note {:role "status"}
      (str (preview/plural no-methods "pair" "pairs") " without method data fail any cutoff above 0.")])])

(defn preview-section
  "Mapping table, relation flags, unmapped genes and filters for the chosen
  organism."
  [{:keys [loading-preview? features relation-filter show-all-unmapped? genes genes-failed? genes-truncated?] :as state}]
  (let [{:keys [rows max-methods no-methods relation-counts unmapped truncated?]} @(subscribe [::preview-data])]
    (cond
      loading-preview? [:p.agr-loading {:role "status" :aria-live "polite"} "Loading the mapping"]
      truncated? [:p.agr-note {:role "status"}
                  (str "The mapping has " fetch-limit " rows or more, so the preview, filters, "
                       "relations and unmapped genes are not shown. The saved list is not affected.")]
      (nil? rows) nil
      :else
      (let [shown (preview/by-relation relation-filter rows)]
        [:div.ortholog-preview-section
         [preview-filters state max-methods no-methods features]
         [:p.agr-note {:role "status" :aria-live "polite"}
          (str (preview/plural (count rows) "mapping" "mappings") ". "
               (:one-to-many relation-counts 0) " one-to-many, "
               (:many-to-one relation-counts 0) " many-to-one, "
               (:many-to-many relation-counts 0) " many-to-many.")]
         (when (> (count shown) max-preview-rows)
           [:p.agr-note (str "Showing the first " max-preview-rows " of " (count shown) " mappings.")])
         (when (seq rows)
           [:button.agr-btn {:type "button"
                             :on-click #(download! "ortholog-mapping.tsv" (preview/mapping-tsv rows features))}
            "Download mapping (TSV)"])
         [preview-table shown features]
         (cond
           unmapped [unmapped-list unmapped show-all-unmapped?]
           genes-truncated? [:p.agr-note (str "The list has " fetch-limit " genes or more, so unmapped genes are not shown.")]
           (and (nil? genes) (not genes-failed?))
           [:p.agr-loading {:role "status" :aria-live "polite"} "Checking the genes of the list"])]))))

(defn convert-panel
  "Organism picker, ortholog count, mapping preview, list name input and save
  button."
  []
  (let [{:keys [organisms organism loading-organisms?
                loading-count? loading-preview? saving?] :as state} @(subscribe [::state])
        list-name (effective-list-name state)
        targets (shown-targets state)]
    [:section.agr-section.orthologs-panel
     [:h3.agr-section-title "Convert to orthologs"]
     (cond
       loading-organisms? [:p.agr-loading {:role "status" :aria-live "polite"} "Looking for orthologs"]
       (empty? organisms) [:p.agr-empty "No orthologs found for the genes in this list."]
       :else
       [:<>
        [:div.agr-filter-bar
         [:label "Target organism"
          [:select.form-control
           {:value (or organism "")
            :on-change #(dispatch [::select-organism (oget % :target :value)])}
           [:option {:value ""} "Select an organism"]
           (for [o organisms]
             ^{:key o} [:option {:value o} o])]]
         (when organism
           (if loading-count?
             [:span.agr-loading {:role "status" :aria-live "polite"} "Counting orthologs"]
             [:span.ortholog-count {:role "status" :aria-live "polite"}
              [:strong targets] " " (if (= 1 targets) "ortholog gene" "ortholog genes") " found"]))]
        (when organism [preview-section state])
        [:div.agr-filter-bar
         [:label "New list name"
          [:input.form-control
           {:type "text"
            :value (or list-name "")
            :on-change #(dispatch [::set-list-name (oget % :target :value)])}]]
         [:button.agr-btn-primary
          {:type "button"
           :disabled (or saving?
                         loading-count?
                         loading-preview?
                         (not organism)
                         (not (pos? (or targets 0)))
                         (str/blank? list-name))
           :on-click #(dispatch [::save])}
          (if saving? "Saving" "Save list")]]])]))

(defn convert-button
  "Toggle button and panel. For a Gene list in a mine whose model lacks a path
  the conversion queries, a short reason is shown in place of the button."
  [list-name]
  (if @(subscribe [::available?])
    (let [open? (:open? @(subscribe [::state]))]
      [:div.convert-to-orthologs
       [:button.agr-btn
        {:type "button"
         :on-click #(dispatch [::toggle list-name])}
        "Convert to orthologs"]
       (when open?
         [convert-panel])])
    (when-let [reason @(subscribe [::blocked-reason])]
      [:p.agr-note.convert-to-orthologs
       "Convert to orthologs is not available. " reason "."])))
