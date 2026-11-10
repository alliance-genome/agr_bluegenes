(ns bluegenes.pages.reportpage.events
  (:require [re-frame.core :as re-frame :refer [reg-event-db reg-event-fx dispatch]]
            [imcljs.fetch :as fetch]
            [bluegenes.components.tools.events :as tools]
            [bluegenes.effects :refer [document-title]]
            [clojure.string :as string]
            [clojure.set :as set]
            [bluegenes.pages.reportpage.utils :as utils]
            [bluegenes.route :as route]
            [goog.dom :as gdom]
            [oops.core :refer [oget ocall]]
            [bluegenes.utils :refer [rows->maps compatible-version?]]))

(defn views->results
  "Convert a `fetch/rows` response map into a vector of maps from keys
  corresponding to the `rest` of the view, and values being the pair of the key.
  Ex. [{:name 'BioGRID interaction data set' :url 'http://www.thebiogrid.org/downloads.php'}
       {:name 'Panther orthologue and paralogue predictions' :url 'http://pantherdb.org/'}]"
  [{:keys [views results] :as _res}]
  ;; Views will be transformed:
  ;; "Gene.symbol" -> "symbol"
  ;; "Gene.organism.shortName" -> "organism.shortName"
  (let [concise-views (map #(keyword (string/replace % #"^[^.]*\." ""))
                           views)]
    (mapv (partial zipmap concise-views)
          results)))

(defn current-report?
  "Whether `report-key` identifies the report currently loaded by
  `:load-report`. Responses for an earlier report must not overwrite it."
  [db report-key]
  (= report-key (get-in db [:report :key])))

(reg-event-fx
 :fetch-fasta
 (fn [{db :db} [_ mine-kw type id]]
   (let [service (get-in db [:mines mine-kw :service])
         q {:from type
            :select [(str type ".id")]
            :where [{:path (str type ".id")
                     :op "="
                     :value id}]}]
     ;; :fasta/fetch will likely already be set; this is just to make sure the
     ;; spinner shows after clicking LOAD FASTA, which dispatches this event.
     {:db (assoc-in db [:report :fasta] :fasta/fetch)
      :im-chan {:chan (fetch/fasta service q)
                :on-success [:handle-fasta [mine-kw type id]]}})))

(reg-event-db
 :handle-fasta
 (fn [db [_ report-key fasta]]
   ;; If there's no FASTA the API will return "Nothing was found for export".
   (cond-> db
     (current-report? db report-key)
     (assoc-in [:report :fasta]
               (if (string/starts-with? fasta ">")
                 fasta
                 :fasta/none)))))

(reg-event-fx
 ::fetch-strand
 (fn [{db :db} [_ mine-kw type id]]
   (let [service (get-in db [:mines mine-kw :service])
         q {:from type
            :select ["chromosomeLocation.strand"]
            :where [{:path "id"
                     :op "="
                     :value id}]}]
     {:im-chan {:chan (fetch/rows service q {:format "json"})
                :on-success [::handle-strand [mine-kw type id]]}})))

(reg-event-db
 ::handle-strand
 (fn [db [_ report-key {:keys [results]}]]
   (cond-> db
     (current-report? db report-key)
     (assoc-in [:report :strand] (get-in results [0 0])))))

(defn class-has-fasta? [hier class-kw]
  (or (= class-kw :Protein)
      (isa? hier class-kw :SequenceFeature)))

(defn check-fasta
  "Check state of fasta for an object's summary:
  :fasta/long - Fasta exists but is too long and should be fetched manually.
  :fasta/fetch - Fasta exists and will be fetched automatically.
  :fasta/none - The object should have had fasta, but it's not available.
  nil - Fasta does not apply to the object."
  [model-hier class-kw summary]
  (let [sequence-class? (class-has-fasta? model-hier class-kw)
        fasta-length (when sequence-class? (get-in (rows->maps summary) [0 :length]))
        has-fasta? (number? fasta-length)
        ;; There's likely no FASTA available if it has no length.
        too-long-fasta? (> fasta-length 1e6)]
    (cond
      (and has-fasta? too-long-fasta?) :fasta/long
      has-fasta? :fasta/fetch
      sequence-class? :fasta/none)))

(defn lookup-value
  "Takes a gene summary response and returns the values best used for a LOOKUP
  query, as a vector of value and extraValue."
  [summary]
  (let [results (first (views->results summary))]
    [(some results [:primaryIdentifier :secondaryIdentifier :symbol])
     (some results [:organism.shortName :organism.name])]))

(reg-event-fx
 :handle-report-summary
 [document-title]
 (fn [{db :db} [_ mine-kw type id summary]]
   (cond
     (not (current-report? db [mine-kw type id]))
     {}

     (seq (:results summary))
     (let [hier (get-in db [:mines mine-kw :model-hier])
           class-kw (keyword type)
           fasta-action (check-fasta hier class-kw summary)]
       {:db (-> db
                (assoc-in [:report :summary] summary)
                (assoc-in [:report :title] (utils/title-column type summary))
                (assoc-in [:report :active-toc] utils/pre-section-id)
                (assoc-in [:report :fasta] fasta-action)
                (assoc :fetching-report? false))
        :dispatch-n [[:viz/run-queries]
                     (when (= fasta-action :fasta/fetch)
                       [:fetch-fasta mine-kw type id])
                     (when (= type "Gene")
                       [:report-alliance-summary/start [mine-kw type id]])
                     (when (= type "Gene")
                       [::fetch-homologues [mine-kw type id] (lookup-value summary)])
                     (when (and (= type "Gene")
                                (get-in db [:mines mine-kw :service :model :classes :Gene :collections :homologues]))
                       [:report-other-mines/start [mine-kw type id]])
                     (when (isa? hier class-kw :SequenceFeature)
                       [::fetch-strand mine-kw type id])]})
     ;; No results mean the object ID likely doesn't exist.
     :else
     {:db (-> db
              (assoc-in [:report :error] {:type :not-found})
              (assoc :fetching-report? false))})))

(reg-event-db
 :fetch-report-failure
 (fn [db [_ report-key res]]
   (cond-> db
     (current-report? db report-key)
     (-> (assoc-in [:report :error] {:type :ws-failure
                                     :message (get-in res [:body :error])})
         (assoc :fetching-report? false)))))

(defn outer-join-classes
  "Primitive approach to creating outer join consisting of all parent classes
  of `views` attributes, excluding the root class. This is necessary when a
  summary field is null, which would give no results with an inner join.
  Note that this will likely not give results in the scenario where there's a
  null class referenced in a longer path, which doesn't have an attribute in
  the view. In the future, we'll want to disallow nullable summary fields, so
  this should only be a temporary solution."
  [type views]
  (->> views
       (map (comp #(string/join "." %) drop-last #(string/split % #"\.")))
       (distinct)
       (remove #{type})
       (vec)))

(reg-event-fx
 :fetch-report
 (fn [{db :db} [_ mine-kw type id]]
   (let [service (get-in db [:mines mine-kw :service])
         views (get-in db [:assets :summary-fields mine-kw (keyword type)])
         q       {:from type
                  :select views
                  :joins (outer-join-classes type views)
                  :where [{:path (str type ".id")
                           :op "="
                           :value id}]}]
     {:im-chan {:chan (fetch/rows service q {:format "json"})
                :on-success [:handle-report-summary mine-kw type id]
                :on-failure [:fetch-report-failure [mine-kw type id]]}})))

(defn class-has-dataset? [model-classes class-kw]
  (contains? (get-in model-classes [class-kw :collections])
             :dataSets))

(reg-event-fx
 :load-report
 (fn [{db :db} [_ mine type id]]
   (let [entity {:class type
                 :format "id"
                 :value id}]
     {:db (-> db
              (assoc :fetching-report? true)
              (assoc :report {:key [(keyword mine) type id]})
              (assoc-in [:tools :entities (keyword type)] entity))
      :dispatch-n [[:fetch-report (keyword mine) type id]
                   [::fetch-lists [(keyword mine) type id]]
                   (when (compatible-version? "5.0.0" (get-in db [:assets :intermine-version (keyword mine)]))
                     [::fetch-external-links [(keyword mine) type id]])
                   (when (class-has-dataset? (get-in db [:mines (keyword mine) :service :model :classes])
                                             (keyword type))
                     [::fetch-sources [(keyword mine) type id]])]})))

(reg-event-fx
 ::fetch-lists
 (fn [{db :db} [_ [mine-kw _type id :as report-key]]]
   (let [service (get-in db [:mines mine-kw :service])]
     {:im-chan {:chan (fetch/lists-containing service {:id id})
                :on-success [::handle-lists report-key]}})))

(reg-event-db
 ::handle-lists
 (fn [db [_ report-key lists]]
   (cond-> db
     (current-report? db report-key)
     (assoc-in [:report :lists] lists))))

(reg-event-fx
 ::fetch-sources
 (fn [{db :db} [_ [mine-kw class id :as report-key]]]
   (let [service (get-in db [:mines mine-kw :service])
         q {:from class
            :select ["dataSets.description"
                     "dataSets.url"
                     "dataSets.name"
                     "dataSets.id"]
            :where [{:path (str class ".id")
                     :op "="
                     :value id}]}]
     {:im-chan {:chan (fetch/rows service q {:format "json"})
                :on-success [::handle-sources report-key]}})))

(reg-event-db
 ::handle-sources
 (fn [db [_ report-key res]]
   (cond-> db
     (current-report? db report-key)
     (assoc-in [:report :sources] (views->results res)))))

(reg-event-fx
 ::open-in-region-search
 (fn [{db :db} [_ chromosome-location]]
   {:dispatch-n [[::route/navigate ::route/regions]
                 [:regions/set-to-search chromosome-location]
                 [:regions/run-query]]}))

(reg-event-db
 ::set-active-toc
 (fn [db [_ active-toc-id]]
   (assoc-in db [:report :active-toc] active-toc-id)))

(reg-event-db
 ::set-filter-text
 (fn [db [_ text]]
   (assoc-in db [:report :filter-text] text)))

(defn scrollspy
  "Returns a function (partially applied with a seq of string element IDs) to
  be called on document scroll. Will go through every element until it finds
  one that hasn't been scrolled passed, then dispatches an event with its ID."
  [ids]
  ;; Predefined top section is always initial value.
  (let [last-scrolled-id* (atom utils/pre-section-id)]
    (fn [_evt]
      (loop [ids ids]
        (when (seq ids)
          (let [id (first ids)
                ;; An element can be nil in the following scenarios
                ;; - it's a category with a collapsed parent section
                ;; - it's a category not "available" for the active class (usually from default layout)
                ;; - it's a section with no children (and therefore not shown)
                ;; in which case we should skip to the next ID.
                top (some-> (gdom/getElement id)
                            (ocall :getBoundingClientRect)
                            (oget :top))]
            (if (pos? ^number top) ; We'll get a nil warning without the typehint.
              (when (not= id @last-scrolled-id*)
                (reset! last-scrolled-id* id)
                (dispatch [::set-active-toc id]))
              (recur (rest ids)))))))))

(defn categories->ids
  "Returns a seq of all the IDs of sections/categories and their children, in
  order of placement from top to bottom."
  [cats]
  (concat [(symbol utils/pre-section-id)] ; Predefined section on the report page.
          (mapcat #(cons (:id %) (map :id (:children %))) cats)))

;; Working around crappy DOM API... (we have to create an anonymous function to
;; pass arguments to the listener, and keep a reference to that so we can
;; remove it later)
(defonce scrollspy-fn* (atom nil))

(reg-event-fx
 ::start-scroll-handling
 (fn [{db :db} [_ categories]]
   (let [ids (map str (categories->ids categories))]
     (.addEventListener js/window "scroll" (reset! scrollspy-fn* (scrollspy ids)))
     {})))

(reg-event-fx
 ::stop-scroll-handling
 (fn [_ [_]]
   (.removeEventListener js/window "scroll" @scrollspy-fn*)
   {}))

(reg-event-fx
 ::generate-permanent-url
 (fn [{db :db} [_ api-version type]]
   (if (>= api-version 30)
     (let [{:keys [id] object-type :type} (:panel-params db)
           service (get-in db [:mines (:current-mine db) :service])
           ?options (cond
                      (> api-version 30) (when type {:type (name type)})
                      ;; On API version 30, type needed to be the object type
                      ;; (e.g. gene). The parameter was later removed, then
                      ;; added back to ask for a specific type of URL.
                      (= api-version 30) {:type object-type})]
       {:db (assoc-in db [:report :share] nil)
        :im-chan {:chan (fetch/permanent-url service id ?options)
                  :on-success [::show-permanent-url]
                  :on-failure [::show-permanent-url-error]}})
     {:dispatch [::show-permanent-url-error
                 {:body {:error (str "This feature isn't supported on " (name (:current-mine db)) " due to using an InterMine API version below 30.")}}]})))

(reg-event-db
 ::show-permanent-url
 (fn [db [_ url]]
   (assoc-in db [:report :share] {:status :success
                                  :url url})))

(reg-event-db
 ::show-permanent-url-error
 (fn [db [_ res]]
   (assoc-in db [:report :share] {:status :failure
                                  :error (get-in res [:body :error])})))

(reg-event-fx
 ::fetch-external-links
 (fn [{db :db} [_ [mine-kw _type id :as report-key]]]
   (let [service (get-in db [:mines mine-kw :service])]
     {:im-chan {:chan (fetch/external-links service id)
                :on-success [::handle-external-links report-key]}})))

(reg-event-db
 ::handle-external-links
 (fn [db [_ report-key links]]
   (cond-> db
     (current-report? db report-key)
     (assoc-in [:report :external-links] links))))

(defn env->registry
  "Adds keys where they're expected for a registry mine to a configured mine."
  [env-mine]
  (assoc env-mine
         :namespace (-> env-mine :id name)
         :url (-> env-mine :service :root)))

(defn shim-homologue-path
  [mine-namespace]
  (case mine-namespace
    "phytomine" "homolog.gene"
    "homologues.homologue"))

(defn homologue-query
  [[value extraValue] {mine-ns :namespace ?organisms :organisms :as _mine}]
  {:from "Gene"
   :select ["id"
            "symbol"
            "primaryIdentifier"
            "secondaryIdentifier"
            "organism.shortName"]
   :where (cond-> [{:path (shim-homologue-path mine-ns)
                    :op "LOOKUP"
                    :value value
                    :extraValue extraValue}]
            (seq ?organisms) ; Won't exist for env mines.
            (conj {:path "organism"
                   :op "LOOKUP"
                   :value (string/join ", " ?organisms)}))})

(reg-event-fx
 ::fetch-homologues
 (fn [{db :db} [_ [mine-kw :as report-key] lookup]]
   (let [env-mines (into {} (map #(update % 1 env->registry)
                                 (get-in db [:env :mines])))
         registry-mines (get db :registry)
         neighbourhood (set (get-in registry-mines [mine-kw :neighbours]))
         ;; Neighbourhood is empty in the scenario that current mine isn't on the registry.
         ;; That means we can't tell its neighbours, so we use env mines instead.
         neighbour-mines (if (empty? neighbourhood)
                           ;; `merge-with merge` does a merge with a depth of
                           ;; one. This means mine properties from the registry
                           ;; will be kept unless an env mine defines the same
                           ;; property (as opposed to all registry properties
                           ;; being replaced by only env properties).
                           (merge-with merge
                                       ;; If env-mines are in the registry, we want their extra metadata.
                                       (select-keys registry-mines (keys env-mines))
                                       env-mines)
                           (merge-with merge
                                       (into {}
                                             (remove (fn [[_ {:keys [neighbours]}]]
                                                       (empty? (set/intersection neighbourhood (set neighbours))))
                                                     registry-mines))
                                       ;; We interpret the env mines as more final than registry, and prefer the env namespace and url (service root).
                                       env-mines))]
     {:dispatch-n (for [mine (-> neighbour-mines (dissoc mine-kw) vals)]
                    [::fetch-mine-homologues
                     report-key
                     {:root (:url mine)
                      :model {:name "genomic"}}
                     (homologue-query lookup mine)
                     mine])})))

(reg-event-fx
 ::fetch-mine-homologues
 (fn [{db :db} [_ report-key service query mine]]
   (let [mine-kw (-> mine :namespace keyword)]
     {:db (assoc-in db [:report :homologues mine-kw]
                    {:mine mine
                     :loading? true})
      :im-chan {:chan (fetch/rows service query {:format "json"})
                :on-success [::handle-mine-homologues report-key mine-kw]
                :on-failure [::handle-mine-homologues-failure report-key mine-kw]}})))

(reg-event-db
 ::handle-mine-homologues
 (fn [db [_ report-key mine-kw res]]
   (cond-> db
     (current-report? db report-key)
     (update-in [:report :homologues mine-kw] assoc
                :loading? false
                :homologues (when (seq (:results res))
                              (group-by :organism.shortName (views->results res)))))))

(reg-event-db
 ::handle-mine-homologues-failure
 (fn [db [_ report-key mine-kw res]]
   (cond-> db
     (current-report? db report-key)
     (update-in [:report :homologues mine-kw] assoc
                :loading? false
                :error (or (get-in res [:body :error])
                           "Error response to query")))))
