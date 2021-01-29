(ns bluegenes.pages.results.events
  (:require-macros [cljs.core.async.macros :refer [go go-loop]])
  (:require [re-frame.core :refer [reg-event-db reg-event-fx reg-fx dispatch subscribe]]
            [cljs.core.async :refer [put! chan <! close!]]
            [clojure.string :as s]
            [imcljs.fetch :as fetch]
            [imcljs.path :as path]
            [imcljs.query :as q]
            [imcljs.save :as save]
            [bluegenes.interceptors :refer [clear-tooltips]]
            [bluegenes.interceptors :refer [abort-spec]]
            [cljs-time.core :as time]
            [cljs-time.coerce :as time-coerce]
            [bluegenes.route :as route]
            [bluegenes.components.tools.events :as tools]
            [bluegenes.effects :refer [document-title]]))

(comment
  "To automatically display some results in this section (the Results / List Analysis page),
  fire the :results/history+ event with a package that represents a query, like so:"
  (dispatch [:results/history+ {:source :flymine
                                :type :query
                                ;; The `intent` should signify what is creating the query.
                                ;; Currently this is only used to filter away queries from
                                ;; other sources when deciding what to include in "Recent
                                ;; Queries" in the querybuilder page. You should check the
                                ;; other uses of `:results/history+` and see if you find a
                                ;; suitable intent to reuse, or make up a new one.
                                :intent :query
                                :value {:title "Appears in Breadcrumb"
                                        :from "Gene"
                                        :select ["Gene.symbol"]
                                        :where {:path "Gene.symbol" :op "=" :value "runt"}}}])
  "
  Doing so will automatically direct the browser to the /results/[latest-history-index] route
  which in turn fires the [:results/load-history latest-history-index]. This triggers the fetching
  of enrichment results and boots the im-table
  ")

(defn build-matches-query [query path-constraint identifier]
  (update-in (js->clj (.parse js/JSON query) :keywordize-keys true) [:where]
             conj {:path path-constraint
                   :op "ONE OF"
                   :values [identifier]}))

(reg-event-db
 :save-summary-fields
 (fn [db [_ identifier response]]
   (assoc-in db [:results :summary-values identifier] response)))

(reg-fx
 :get-summary-values
 (fn [[identifier c]]
   (go (dispatch [:save-summary-fields identifier (<! c)]))))

(reg-event-fx
 :results/get-item-details
 (fn [{db :db} [_ identifier path-constraint]]
   (let [source (get-in db [:results :package :source])
         model (assoc (get-in db [:mines source :service :model])
                      :type-constraints (get-in db [:results :package :value :where]))
         classname (keyword (path/class model path-constraint))
         summary-fields (get-in db [:assets :summary-fields source classname])
         service (get-in db [:mines source :service])
         summary-chan (fetch/rows
                       service
                       {:from classname
                        :select summary-fields
                        :where [{:path (last (clojure.string/split path-constraint "."))
                                 :op "="
                                 :value identifier}]})]
     {:db (assoc-in db [:results :summary-chan] summary-chan)
      :get-summary-values [identifier summary-chan]})))

; Fire this event to append a query package to the BlueGenes list analysis history
; and then route the browser to a URL that displays the last package in history (the one we just added)
(reg-event-fx
 :results/history+
 (fn [{db :db} [_ {:keys [source value type] :as package} no-route?]]
   (cond-> {:db (-> db
                    (update-in [:results :history] conj package)
                    (assoc-in [:results :queries (:title value)]
                              (assoc package
                                     :last-executed
                                     (time-coerce/to-long (time/now)))))}
     (not no-route?)
           ;; Our route runs `:results/load-history`.
     (assoc :dispatch [::route/navigate ::route/results {:title (:title value)}]))))

(def im-table-location [:results :table])

(defn unorder-query-parts
  "There's a bug with the webservices that doesn't let us sort by an attribute
  not present in the view. This is a workaround to remove ordering, as we
  currently don't see it as a necessary feature for Bluegenes tools/viz to have
  ordering that is consistend with the im-table."
  [query-parts]
  (reduce (fn [qp k]
            (update qp k
                    (partial mapv
                             #(update % :query dissoc :sortOrder :orderBy))))
          query-parts
          (keys query-parts)))

; Load one package at a particular index from the list analysis history collection
(reg-event-fx
 :results/load-history
 [(clear-tooltips) document-title]
 (fn [{db :db} [_ title]]
   (let [; Get the details of the current package
         {:keys [source type value] :as package} (get-in db [:results :queries title])
          ; Get the current model
         model          (assoc (get-in db [:mines source :service :model])
                               :type-constraints (:where value))
         service        (get-in db [:mines source :service])
         summary-fields (get-in db [:assets :summary-fields source])]
     (if (nil? package)
       ;; The query result doesn't exist. Fail gracefully!
       ;; This should only happen when trying to access a list that doesn't exist via deep linking.
       {:dispatch-n [[::route/navigate ::route/lists]
                     [:messages/add
                      {:markup [:span "Failed to find a list with the name: " [:em title]]
                       :style "danger"}]]}
       ; Store the values in app-db.
       ; TODO - 99% of this can be factored out by passing the package to the :enrichment/enrich and parsing it there
       {:db (-> db
                (assoc-in [:results :queries title :last-executed] (time-coerce/to-long (time/now)))
                (update :results assoc
                        :table nil
                        :query value
                        :package package
                        ; The index is used to highlight breadcrumbs
                        :history-index title
                        :query-parts (unorder-query-parts (q/group-views-by-class model value))
                        ; Clear the enrichment results before loading any new ones
                        :enrichment-results nil))
        :dispatch-n [; Fetch IDs to build tool entity
                     [:fetch-ids-tool-entities]
                     ; Fire the enrichment event (see the TODO above)
                     [:enrichment/enrich]
                     [:im-tables/load
                      im-table-location
                      {:service (merge service {:summary-fields summary-fields})
                       :query value
                       :settings {:pagination {:limit 10}
                                  :links {:vocab {:mine (name source)}
                                          :url (fn [{:keys [mine class objectId] :as vocab}]
                                                 (route/href ::route/report
                                                             {:mine mine
                                                              :type class
                                                              :id objectId}))}}}]]}))))

(reg-event-fx
 :results/listen-im-table-changes
 (fn [{db :db} [_]]
   {:forward-events {:register :results-page-im-table-listener
                     ;; These fire whenever the query in im-tables is changed,
                     ;; and runs successfully.
                     :events #{:main/replace-query-response
                               :main/merge-query-response}
                     :dispatch-to [:results/update-tool-entities]}}))

(reg-event-fx
 :results/unlisten-im-table-changes
 (fn [{db :db} [_]]
   {:forward-events {:unregister :results-page-im-table-listener}}))

(reg-event-fx
 :results/update-tool-entities
 (fn [{db :db} [_]]
   (let [source (get-in db [:results :package :source])
         ;; We have to reach into the im-table to get the updated query,
         ;; as it's not passed via event handlers we can intercept.
         query (get-in db (conj im-table-location :query))
         model (assoc (get-in db [:mines source :service :model])
                      :type-constraints (:where query))]
     ;; We wouldn't need to update db if we passed query-parts directly to the
     ;; two events dispatched below (see TODO above).
     {:db (update db :results assoc
                  :query-parts (unorder-query-parts (q/group-views-by-class model query)))
      :dispatch-n [[:fetch-ids-tool-entities]
                   [:enrichment/enrich]]})))

(reg-event-fx
 :fetch-ids-tool-entities
 (fn [{db :db} _]
   (let [{:keys [source]} (get-in db [:results :package])
         query-parts (get-in db [:results :query-parts])]
     {;; Initialise entities map with keys and nil values, to track progress.
      :db (assoc-in db [:tools :entities]
                    (zipmap (keys query-parts) (repeat nil)))
      :dispatch-n (reduce (fn [events [class parts]]
                            ;; `parts` is a vector of one map. It shouldn't be
                            ;; possible to have more than one part for a class.
                            ;; While it's handled here, it's not later on.
                            (into events (map (fn [{:keys [query]}]
                                                [:fetch-ids-tool-entity class source query])
                                              parts)))
                          []
                          query-parts)})))

(reg-event-fx
 :fetch-ids-tool-entity
 (fn [{db :db} [_ class source query]]
   (let [service (get-in db [:mines source :service])]
     {:im-chan {:chan (fetch/rows service query)
                :on-success [:success-fetch-ids-tool-entity class]}})))

(reg-event-fx
 :success-fetch-ids-tool-entity
 (fn [{db :db} [_ class {:keys [results]}]]
   (let [entity {:class (name class)
                 :format "ids"
                 :value (reduce into results)}
         entities (assoc (get-in db [:tools :entities])
                         class entity)]
     (cond-> {:db (assoc-in db [:tools :entities] entities)}
       ;; If there are no nil values, we know all entities
       ;; are done fetching and can load the viz/tools.
       (every? some? (vals entities))
       (assoc :dispatch-n [[:viz/run-queries]
                           [::tools/load-tools]])))))

(reg-event-db
 :clear-ids-tool-entity
 (fn [db]
   (update db :tools dissoc :entity :entities)))

(reg-event-fx
 :fetch-enrichment-ids-from-query
 (fn [world [_ service query what-to-enrich]]
   {:im-chan {:chan (fetch/rows service query)
              :on-success [:success-fetch-enrichment-ids-from-query]}}))

(reg-event-fx
 :success-fetch-enrichment-ids-from-query
 (fn [{db :db} [_ results]]
   {:db (assoc-in db [:results :ids-to-enrich] (flatten (:results results)))
    :dispatch [:enrichment/run-all-enrichment-queries]}))

(defn service [db mine-kw]
  (get-in db [:mines mine-kw :service]))

(reg-event-fx
 :results/run
 (fn [{db :db} [_ params]]
   (let [enrichment-chan (fetch/enrichment (service db (get-in db [:results :package :source])) params)]
     {:db (assoc-in db [:results
                        :enrichment-results
                        (keyword (:widget params))] nil)
      :enrichment/get-enrichment [(:widget params) enrichment-chan]})))

(reg-event-db
 :results/clear
 (fn [db]
   (assoc-in db [:results :query] nil)))

(reg-event-db
 :list-description/edit
 (fn [db [_ state]]
   (-> db
       (assoc-in [:results :description :editing?] state)
       (assoc-in [:results :errors :description] false))))

(reg-event-fx
 :list-description/update
 (fn [{db :db} [_ list-name new-description]]
   (let [service (get-in db [:mines (:current-mine db) :service])]
     {:im-chan {:chan (save/im-list-update service list-name {:newDescription new-description})
                :on-success [:list-description/update-success]
                :on-failure [:list-description/update-failure]}})))

(reg-event-fx
 :list-description/update-success
 (fn [{db :db} [_ {list-name :name list-description :description}]]
   {:dispatch [:list-description/edit false]
    :db (update-in db [:assets :lists (:current-mine db)]
                   (fn [lists]
                     (let [index (first (keep-indexed (fn [i {:keys [name]}]
                                                        (when (= name list-name) i))
                                                      lists))]
                       (assoc-in lists [index :description] list-description))))}))

(reg-event-db
 :list-description/update-failure
 (fn [db [_ {:keys [status body] :as res}]]
   (assoc-in db [:results :errors :description]
             (cond
               (string? body)
               ;; Server returned HTML as it didn't understand the request.
               "This feature is not supported in this version of InterMine."
               (= status 400)
               "You are not authorised to edit this description."
               :else
               (do (.error js/console "Failed imcljs request" res)
                   "An error occured. Please check your connection and try again.")))))
