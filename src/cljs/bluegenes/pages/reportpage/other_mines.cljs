(ns bluegenes.pages.reportpage.other-mines
  "Gene report panel linking the current gene and its orthologs to the other
  configured mines. A mine covers a gene when its organism list (fetched once
  per session) contains the gene's organism. Gene lookups run in parallel up
  to `max-parallel`, and responses for an earlier report are dropped."
  (:require [re-frame.core :refer [reg-event-fx reg-sub]]
            [imcljs.fetch :as fetch]
            [clojure.string :as str]
            [bluegenes.mine-ids :as mine-ids]
            [bluegenes.mine-support :as mine-support]))

(def ^:const max-parallel 4)

(def ^:private gene-views
  ["Gene.primaryIdentifier"
   "Gene.symbol"
   "Gene.organism.shortName"
   "Gene.organism.taxonId"])

(def ^:private ortholog-views
  (mapv #(str/replace % "Gene." "Gene.homologues.homologue.") gene-views))

;; Pure functions.

(defn identifier-candidates
  "Identifiers to try in a target mine, in order of preference: as given, then
  without a CURIE prefix (WB:WBGene1 -> WBGene1) as MOD mines store bare ids for
  their own species, then with one (WBGene1 -> WB:WBGene1) as AllianceMine
  stores CURIEs. See `bluegenes.mine-ids/candidates`."
  [id]
  (mine-ids/candidates id))

;; Model gates. Each returns a short reason, or nil when the paths resolve or
;; the model is unknown.

(def target-paths
  "Paths queried in a target mine: the organism list and the gene lookup."
  ["Organism.shortName" "Organism.taxonId"
   "Gene.id" "Gene.primaryIdentifier" "Gene.symbol"
   "Gene.organism.shortName" "Gene.organism.taxonId"])

(defn target-blocked-reason
  "Why `target-classes` (the model of a target mine) cannot be looked up in."
  [target-classes mine-label]
  (mine-support/blocked-reason target-classes mine-label target-paths))

(defn current-blocked-reasons
  "Reasons the queries in the current mine cannot run: `:self` for the gene
  itself, `:orthologs` for its orthologs (they need Gene.homologues.homologue)."
  [current-classes mine-label]
  (let [reason (fn [paths] (mine-support/blocked-reason current-classes mine-label paths))]
    (cond-> {}
      (reason gene-views) (assoc :self (reason gene-views))
      (reason ortholog-views) (assoc :orthologs (reason ortholog-views)))))

(defn row->gene
  "Row in the order of `gene-views`."
  [[primary-identifier symbol short-name taxon-id]]
  {:primaryIdentifier primary-identifier
   :symbol symbol
   :shortName short-name
   :taxonId (some-> taxon-id str)})

(defn rows->genes
  "Distinct genes from a `fetch/rows` json response using `gene-views`."
  [{:keys [results]}]
  (->> results
       (map row->gene)
       (filter :primaryIdentifier)
       (distinct)
       (vec)))

(defn covers?
  "Whether a collection of {:shortName :taxonId} organisms includes the organism
  of `gene`. Matches on taxon id, or on short name if the gene has no taxon id."
  [organisms {:keys [shortName taxonId]}]
  (boolean
   (some (fn [organism]
           (if (str/blank? taxonId)
             (and (some? shortName) (= shortName (:shortName organism)))
             (= taxonId (:taxonId organism))))
         organisms)))

(defn covering-mines
  "Mine keywords, sorted by name, whose organisms cover the organism of `gene`."
  [organisms-by-mine gene]
  (->> organisms-by-mine
       (filter (fn [[_ organisms]] (covers? organisms gene)))
       (map key)
       (sort-by name)
       (vec)))

(defn plan-tasks
  "Vector of [mine-kw gene] lookups, in gene order, skipping `current-mine`."
  [genes organisms-by-mine current-mine]
  (let [organisms-by-mine (dissoc organisms-by-mine current-mine)]
    (vec (for [gene genes
               mine-kw (covering-mines organisms-by-mine gene)]
           [mine-kw gene]))))

(defn task-key [[mine-kw gene]]
  [mine-kw (:primaryIdentifier gene)])

(def ^:private xml-escapes {\& "&amp;" \< "&lt;" \> "&gt;" \" "&quot;"})

(defn escape-xml
  "Escape a value for use as XML text. imcljs writes ONE OF values into the
  query XML as they are, so they must be escaped here."
  [s]
  (str/escape (str s) xml-escapes))

(defn lookup-query
  "Query finding the gene in a target mine by any of `candidates`, restricted to
  the organism of `gene`."
  [candidates {:keys [shortName taxonId]}]
  {:from "Gene"
   :select ["Gene.id" "Gene.primaryIdentifier" "Gene.symbol"]
   :where [{:path "Gene.primaryIdentifier"
            :op "ONE OF"
            :values (mapv escape-xml candidates)}
           (if (str/blank? taxonId)
             {:path "Gene.organism.shortName" :op "=" :value shortName}
             {:path "Gene.organism.taxonId" :op "=" :value taxonId})]})

(defn pick-resolved
  "First row, in candidate order, whose primary identifier is a candidate.
  Rows are [id primaryIdentifier symbol]. Returns {:id :symbol} or nil."
  [candidates rows]
  (some (fn [candidate]
          (when-let [[id _ symbol] (first (filter #(= candidate (second %)) rows))]
            {:id id :symbol symbol}))
        candidates))

(defn panel-rows
  "Rows for the panel: one per gene and covering mine, with lookup status."
  [{:keys [genes results organisms-by-mine current-mine mine-names]}]
  (let [organisms-by-mine (dissoc organisms-by-mine current-mine)]
    (vec (for [gene genes
               mine-kw (covering-mines organisms-by-mine gene)]
           (merge {:self? (boolean (:self? gene))
                   :gene gene
                   :mine-kw mine-kw
                   :mine-name (get mine-names mine-kw (name mine-kw))
                   :status :queued}
                  (get results [mine-kw (:primaryIdentifier gene)]))))))

(defn order-genes
  "The current gene first, then orthologs by organism and symbol. The current
  gene is dropped from the orthologs if it is listed there."
  [self orthologs]
  (let [self-ids (set (map :primaryIdentifier self))]
    (into (mapv #(assoc % :self? true) self)
          (->> orthologs
               (remove (comp self-ids :primaryIdentifier))
               (sort-by (juxt :shortName #(or (:symbol %) (:primaryIdentifier %))))))))

;; Events.

(defn- current-report? [db report-key]
  (= report-key (get-in db [:report :key])))

(defn- other-mines-env
  "Configured mines except the one the report belongs to."
  [db mine-kw]
  (dissoc (get-in db [:env :mines]) mine-kw))

(defn- mine-service [db mine-kw]
  {:root (get-in db [:env :mines mine-kw :service :root])
   :model {:name "genomic"}})

(defn- mine-label [db mine-kw]
  (or (get-in db [:env :mines mine-kw :name]) (name mine-kw)))

(reg-event-fx
 :report-other-mines/start
 (fn [{db :db} [_ [mine-kw _type id :as report-key]]]
   (let [others (other-mines-env db mine-kw)
         to-fetch (remove #(#{:loading :done :skipped} (get-in db [:other-mines :organisms % :status]))
                          (keys others))
         ;; A slot that the current mine's model cannot answer is filled with
         ;; no genes and the reason is shown in the panel.
         reasons (current-blocked-reasons (mine-support/mine-classes db mine-kw)
                                          (mine-label db mine-kw))
         gene-query (fn [select]
                      {:from "Gene"
                       :select select
                       :where [{:path "Gene.id" :op "=" :value id}]})]
     (when (and (current-report? db report-key) (seq others))
       {:db (reduce #(assoc-in %1 [:other-mines :organisms %2] {:status :loading})
                    (assoc-in db [:report :other-mines]
                              (cond-> {:inflight 0}
                                (:self reasons) (assoc :self [] :self-reason (:self reasons))
                                (:orthologs reasons) (assoc :orthologs [] :orthologs-reason (:orthologs reasons))))
                    to-fetch)
        :dispatch-n (-> []
                        (cond-> (not (:self reasons))
                          (conj [::fetch-genes report-key :self (gene-query gene-views)]))
                        (cond-> (not (:orthologs reasons))
                          (conj [::fetch-genes report-key :orthologs (gene-query ortholog-views)]))
                        (into (map (fn [k] [::fetch-organisms k])) to-fetch))}))))

(reg-event-fx
 ::fetch-genes
 (fn [{db :db} [_ [mine-kw :as report-key] slot query]]
   {:im-chan {:chan (fetch/rows (mine-service db mine-kw) query {:format "json"})
              :on-success [::genes-success report-key slot]
              :on-failure [::genes-failure report-key slot]}}))

(reg-event-fx
 ::genes-success
 (fn [{db :db} [_ report-key slot res]]
   (when (current-report? db report-key)
     {:db (assoc-in db [:report :other-mines slot] (rows->genes res))
      :dispatch [::maybe-plan report-key]})))

(reg-event-fx
 ::genes-failure
 (fn [{db :db} [_ report-key slot _res]]
   (when (current-report? db report-key)
     {:db (assoc-in db [:report :other-mines slot] [])
      :dispatch [::maybe-plan report-key]})))

(reg-event-fx
 ::fetch-organisms
 ;; Loads the model of the mine first, to skip a mine that lacks a queried path.
 (fn [_ [_ mine-kw]]
   {:dispatch [::mine-support/fetch mine-kw [::fetch-organisms-checked mine-kw]]}))

(reg-event-fx
 ::fetch-organisms-checked
 (fn [{db :db} [_ mine-kw]]
   (if-let [reason (target-blocked-reason (mine-support/mine-classes db mine-kw)
                                          (mine-label db mine-kw))]
     {:db (assoc-in db [:other-mines :organisms mine-kw] {:status :skipped :reason reason})
      :dispatch [::maybe-plan (get-in db [:report :key])]}
     {:im-chan {:chan (fetch/rows (mine-service db mine-kw)
                                  {:from "Organism"
                                   :select ["Organism.shortName" "Organism.taxonId"]}
                                  {:format "json" :size 1000})
                :on-success [::organisms-success mine-kw]
                :on-failure [::organisms-failure mine-kw]}})))

(reg-event-fx
 ::organisms-success
 (fn [{db :db} [_ mine-kw {:keys [results]}]]
   {:db (assoc-in db [:other-mines :organisms mine-kw]
                  {:status :done
                   :organisms (mapv (fn [[short-name taxon-id]]
                                      {:shortName short-name
                                       :taxonId (some-> taxon-id str)})
                                    results)})
    :dispatch [::maybe-plan (get-in db [:report :key])]}))

(reg-event-fx
 ::organisms-failure
 (fn [{db :db} [_ mine-kw _res]]
   {:db (assoc-in db [:other-mines :organisms mine-kw] {:status :error})
    :dispatch [::maybe-plan (get-in db [:report :key])]}))

(reg-event-fx
 ::maybe-plan
 (fn [{db :db} [_ [mine-kw :as report-key]]]
   (let [{:keys [self orthologs planned?]} (get-in db [:report :other-mines])
         others (keys (other-mines-env db mine-kw))
         organisms (into {} (map (fn [k] [k (get-in db [:other-mines :organisms k])])) others)]
     (when (and report-key
                (current-report? db report-key)
                (some? self) (some? orthologs)
                (not planned?)
                (every? (comp #{:done :error :skipped} :status) (vals organisms)))
       (let [genes (order-genes self orthologs)
             tasks (plan-tasks genes
                               (into {} (map (fn [[k v]] [k (:organisms v)])) organisms)
                               mine-kw)]
         {:db (update-in db [:report :other-mines] assoc
                         :planned? true
                         :genes genes
                         :queue tasks
                         :results (zipmap (map task-key tasks) (repeat {:status :queued})))
          :dispatch [::pump report-key]})))))

(reg-event-fx
 ::pump
 (fn [{db :db} [_ report-key]]
   (when (current-report? db report-key)
     (let [{:keys [queue inflight]} (get-in db [:report :other-mines])
           [batch remaining] (split-at (max 0 (- max-parallel inflight)) queue)]
       (when (seq batch)
         {:db (-> (reduce #(assoc-in %1 [:report :other-mines :results (task-key %2)] {:status :loading})
                          db batch)
                  (assoc-in [:report :other-mines :queue] (vec remaining))
                  (update-in [:report :other-mines :inflight] + (count batch)))
          :dispatch-n (for [task batch] [::lookup report-key task])})))))

(reg-event-fx
 ::lookup
 (fn [{db :db} [_ report-key [mine-kw gene :as task]]]
   (when (current-report? db report-key)
     (let [candidates (identifier-candidates (:primaryIdentifier gene))]
       {:im-chan {:chan (fetch/rows (mine-service db mine-kw)
                                    (lookup-query candidates gene)
                                    {:format "json"})
                  :on-success [::lookup-success report-key task candidates]
                  :on-failure [::lookup-failure report-key task]}}))))

(defn- settle
  "Store the outcome of a lookup, free its slot and start the next one."
  [db report-key task result]
  (when (current-report? db report-key)
    {:db (-> db
             (assoc-in [:report :other-mines :results (task-key task)] result)
             (update-in [:report :other-mines :inflight] dec))
     :dispatch [::pump report-key]}))

(reg-event-fx
 ::lookup-success
 (fn [{db :db} [_ report-key task candidates {:keys [results]}]]
   (settle db report-key task
           (if-let [{:keys [id symbol]} (pick-resolved candidates results)]
             {:status :found :id id :symbol symbol}
             {:status :not-found}))))

(reg-event-fx
 ::lookup-failure
 (fn [{db :db} [_ report-key task res]]
   (settle db report-key task
           {:status :error
            :message (or (get-in res [:body :error]) "Error response to query")})))

;; Subscriptions.

(reg-sub
 ::panel
 (fn [db]
   (let [{:keys [planned?] :as state} (get-in db [:report :other-mines])
         current-mine (:current-mine db)
         env-mines (get-in db [:env :mines])]
     (when (and state (seq (dissoc env-mines current-mine)))
       {:loading? (not planned?)
        :unavailable (->> (dissoc env-mines current-mine)
                          (filter #(= :error (get-in db [:other-mines :organisms (key %) :status])))
                          (map (comp :name val))
                          (sort)
                          (vec))
        :skipped (->> (dissoc env-mines current-mine)
                      (keep (fn [[k m]]
                              (let [{:keys [status reason]} (get-in db [:other-mines :organisms k])]
                                (when (= :skipped status)
                                  {:name (:name m) :reason reason}))))
                      (sort-by :name)
                      (vec))
        :orthologs-reason (:orthologs-reason state)
        :rows (panel-rows
               {:genes (:genes state)
                :results (:results state)
                :current-mine current-mine
                :mine-names (into {} (map (fn [[k m]] [k (:name m)])) env-mines)
                :organisms-by-mine (into {} (map (fn [[k v]] [k (:organisms v)]))
                                         (get-in db [:other-mines :organisms]))})}))))
