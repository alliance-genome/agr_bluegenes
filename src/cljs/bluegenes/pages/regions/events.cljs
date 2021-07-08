(ns bluegenes.pages.regions.events
  (:require [re-frame.core :refer [reg-event-db reg-event-fx reg-fx dispatch subscribe]]
            [imcljs.entity :as entity]
            [imcljs.fetch :as fetch]
            [imcljs.save :as save]
            [clojure.string :as str]
            [bluegenes.route :as route]
            [bluegenes.pages.lists.utils :refer [copy-list-name]]))

(defn parse-region [coordinate-system region-string]
  (let [parsed (str/split region-string (re-pattern "(?::|\\.\\.|-|\t)"))]
    (when (= (count parsed) 3)
      (let [ch (nth parsed 0)
            n1 (int (nth parsed 1))
            n2 (int (nth parsed 2))]
        {:chromosome ch
         :from (cond-> (min n1 n2)
                 (= coordinate-system :interbase) (inc))
         :to (max n1 n2)}))))
;; TODO when adding strand-specific search, add a :strand key to the returned
;; map based on n1 -> n2 ascending vs descending.

(defn overlaps-region? [{:keys [chromosome from to] :as _region}
                        {{:keys [start end locatedOn]} :chromosomeLocation :as _feature}]
  (and (= (:primaryIdentifier locatedOn) chromosome) ; Same chromosome and...
       (or (<= from (int start) to)   ; ...starts within region...
           (<= from (int end) to)     ; ...or ends within region...
           (and (<= (int start) from) ; ...or starts before region...
                (<= to (int end)))))) ; ...and ends after region (i.e., encompasses).

(reg-event-db
 :regions/save-results
 (fn [db [_ searched-for result-response]]
   (let [mapped-results (mapv (fn [region]
                                (assoc region :results
                                       (filterv (partial overlaps-region? region)
                                                (:results result-response))))
                              searched-for)]
     (-> db
         (assoc-in [:regions :results] mapped-results)
         (assoc-in [:regions :loading] false)))))

(reg-event-db
 :regions/query-failure
 (fn [db [_ res]]
   (-> db
       (assoc-in [:regions :loading] false)
       (assoc-in [:regions :error] (or (get-in res [:body :error])
                                       "Region search failed")))))

(reg-event-db
 :regions/set-selected-organism
 (fn [db [_ organism]]
   (assoc-in db [:regions :settings :organism] organism)))

(reg-event-db
 :regions/set-coordinates
 (fn [db [_ coord-kw]]
   (assoc-in db [:regions :settings :coordinates] coord-kw)))

(reg-event-db
 :regions/toggle-feature-type
 (fn [db [_ class]]
   (let [class-kw (keyword (:name class))
         m (get-in db [:mines (get db :current-mine) :service :model])
         descendants (keys (entity/extended-by m class-kw))
         status (get-in db [:regions :settings :feature-types class-kw])]
     (update-in db [:regions :settings :feature-types]
                merge
                (reduce (fn [total next]
                          (assoc total next (not status)))
                        {class-kw (not status)} descendants)))))

(reg-event-db
 :regions/select-all-feature-types
 (fn [db]
   (let [model (get-in db [:mines (get db :current-mine) :service :model])
         feature-types (entity/extended-by model :SequenceFeature)]
     (assoc-in db [:regions :settings :feature-types]
               (reduce (fn [total [name]]
                         (assoc total (keyword name) true)) {} feature-types)))))

(reg-event-db
 :regions/deselect-all-feature-types
 (fn [db]
   (let [feature-types (get-in db [:regions :settings :feature-types])]
     (assoc-in db [:regions :settings :feature-types]
               (reduce (fn [new-map [k v]]
                         (assoc new-map k false)) {} feature-types)))))

(reg-event-db
 :regions/set-to-search
 (fn [db [_ val]]
   (assoc-in db [:regions :to-search] val)))

(defn add-type-constraints [query types]
  (if types
    (update query :where conj {:path "SequenceFeature"
                               :op "ISA"
                               :values types})
    query))

(defn add-organism-constraint [query short-name]
  (if short-name
    (update query :where conj {:path "SequenceFeature.organism.shortName"
                               :op "="
                               :value short-name})
    query))

(defn build-region [{:keys [chromosome from to] :as _region}]
  (str chromosome ":" from ".." to))

(defn build-feature-query [regions]
  {:from "SequenceFeature"
   :select ["SequenceFeature.id"
            "SequenceFeature.name"
            "SequenceFeature.primaryIdentifier"
            "SequenceFeature.symbol"
            "SequenceFeature.chromosomeLocation.start"
            "SequenceFeature.chromosomeLocation.end"
            "SequenceFeature.chromosomeLocation.locatedOn.primaryIdentifier"]
   :where [{:path "SequenceFeature.chromosomeLocation"
            :op "OVERLAPS"
            :values (if (map? regions)
                      [(build-region regions)]
                      (mapv build-region regions))}]
   :sortOrder [{:path "SequenceFeature.chromosomeLocation.start"
                :direction "ASC"}]})
;; TODO when adding strand-specific search, check the :strand key and add a constraint for chromosomelocation.strand.

(defn prepare-export-query [query]
  (assoc query
         :select ["SequenceFeature.primaryIdentifier"
                  "SequenceFeature.symbol"
                  "SequenceFeature.chromosomeLocation.locatedOn.primaryIdentifier"
                  "SequenceFeature.chromosomeLocation.start"
                  "SequenceFeature.chromosomeLocation.end"
                  "SequenceFeature.organism.name"]))

(reg-event-fx
 :regions/run-query
 (fn [{db :db} [_]]
   (let [to-search (remove str/blank? (str/split-lines (get-in db [:regions :to-search])))
         selected-coordinates (get-in db [:regions :settings :coordinates])
         parsed-regions (mapv (partial parse-region selected-coordinates) to-search)]
     (if (some nil? parsed-regions)
       (let [invalid-regions (remove nil? (map #(when (nil? %2) %1) to-search parsed-regions))]
         {:db (assoc-in db [:regions :error] (str "Invalid regions: " (str/join ", " invalid-regions)))})
       (let [feature-types (get-in db [:regions :settings :feature-types])
             selected-feature-types (keep (fn [[feature-kw enabled?]]
                                            (when enabled? (name feature-kw)))
                                          feature-types)
             selected-organism (get-in db [:regions :settings :organism :shortName])
             query (-> (build-feature-query parsed-regions)
                       (add-type-constraints selected-feature-types)
                       (add-organism-constraint selected-organism))
             subqueries (mapv (fn [region]
                                (-> (build-feature-query region)
                                    (add-type-constraints selected-feature-types)
                                    (add-organism-constraint selected-organism)))
                              parsed-regions)]
         {:db (-> db
                  (assoc-in [:regions :query] query)
                  (assoc-in [:regions :subqueries] subqueries)
                  (assoc-in [:regions :results] [])
                  (assoc-in [:regions :loading] true)
                  (assoc-in [:regions :error] nil))
          :im-chan {:chan (fetch/records (get-in db [:mines (get db :current-mine) :service]) query)
                    :on-success [:regions/save-results parsed-regions]
                    :on-failure [:regions/query-failure]}})))))

(reg-event-db
 :regions/set-highlight
 (fn [db [_ idx loc]]
   (assoc-in db [:regions :highlight idx] loc)))

(reg-event-db
 :regions/clear-highlight
 (fn [db [_ idx]]
   (assoc-in db [:regions :highlight idx] nil)))

(reg-event-fx
 :regions/view-query
 (fn [{db :db} [_ query {:keys [chromosome from to] :as feature}]]
   {:dispatch [:results/history+
               {:source (:current-mine db)
                :type :query
                :intent :region
                :value (assoc query
                              :title (if feature
                                       (str chromosome ":" from ".." to)
                                       "Region search results"))}]}))

(reg-event-fx
 :regions/create-list
 (fn [{db :db} [_ ids type list-name]]
   (let [current-mine (get db :current-mine)
         service (get-in db [:mines current-mine :service])
         lists (get-in db [:assets :lists current-mine])
         list-name (if (some (comp #{list-name} :name) lists)
                     (copy-list-name lists list-name)
                     list-name)]
     {:im-chan {:chan (save/im-list-from-query service list-name
                                               {:from type
                                                :select ["id"]
                                                :where [{:path "id"
                                                         :op "ONE OF"
                                                         :values ids}]})
                :on-success [:regions/create-list-success]
                :on-failure [:regions/create-list-failure]}})))

(reg-event-fx
 :regions/create-list-success
 (fn [{db :db} [_ {:keys [listName]}]]
   {:dispatch [:assets/fetch-lists
               [::route/navigate ::route/results {:title listName}]]}))

(reg-event-fx
 :regions/create-list-failure
 (fn [{db :db} [_ res]]
   {:dispatch [:messages/add
               {:markup [:span "Failed to create list by feature type "
                         (when-let [error (get-in res [:body :error])]
                           [:code error])]
                :style "warning"
                :timeout 10000}]}))
