(ns bluegenes.pages.results.orthologs-preview
  "Pure logic behind the preview of a list conversion to orthologs. Rows are
  Gene.homologues pairs for one target organism. Relations, unmapped genes and
  the method-count and best-score filters are computed here from those rows."
  (:require [clojure.string :as str]))

(def homologues "Gene.homologues")

(def columns
  "Preview columns in select order: [key path feature]. A column with a
  feature is selected only when the model has its path."
  [[:gene-id "Gene.id" nil]
   [:gene-identifier "Gene.primaryIdentifier" nil]
   [:gene-symbol "Gene.symbol" nil]
   [:target-id "Gene.homologues.homologue.id" nil]
   [:target-identifier "Gene.homologues.homologue.primaryIdentifier" nil]
   [:target-symbol "Gene.homologues.homologue.symbol" nil]
   [:type "Gene.homologues.type" :type?]
   [:match "Gene.homologues.algorithmsMatch" :methods?]
   [:attempted "Gene.homologues.algorithmsAttempted" :methods?]
   [:best? "Gene.homologues.isBestScore" :best?]
   [:best-reverse? "Gene.homologues.isBestReverseScore" :best-reverse?]])

(def optional-paths
  "Feature -> the path that must resolve for the feature to be offered."
  (into {} (keep (fn [[_ path feature]] (when feature [feature path]))) columns))

(def match-path "Gene.homologues.algorithmsMatch")
(def best-path "Gene.homologues.isBestScore")

(defn- selected? [features [_ _ feature]]
  (or (nil? feature) (get features feature)))

(defn selected-columns [features]
  (filterv #(selected? features %) columns))

(defn preview-query
  "One row per list gene and homologue in `organism`."
  [list-name organism features]
  {:from "Gene"
   :select (mapv second (selected-columns features))
   :orderBy [{:path "Gene.symbol" :direction "ASC"}]
   :where [{:path "Gene" :op "IN" :value list-name}
           {:path "Gene.homologues.homologue.organism.shortName" :op "=" :value organism}]})

(defn true-value?
  "isBestScore is a Boolean in AllianceMine and FlyMine, a String in YeastMine."
  [v]
  (or (true? v) (and (string? v) (= "true" (str/lower-case v)))))

(defn- label [identifier symbol]
  (if (str/blank? symbol) identifier symbol))

(defn- row-map [features cols row]
  (let [m (zipmap (map first cols) row)]
    (-> m
        (assoc :gene (label (:gene-identifier m) (:gene-symbol m))
               :target (label (:target-identifier m) (:target-symbol m))
               :best? (true-value? (:best? m))
               :best-reverse? (true-value? (:best-reverse? m)))
        (cond-> (not (:methods? features)) (dissoc :match :attempted)))))

(defn- match-rank [row] (or (:match row) -1))

(defn- richer [a b]
  (if (>= (match-rank a) (match-rank b)) a b))

(defn parse-rows
  "Rows of `preview-query` as maps. The mine repeats a pair with empty scores,
  so one row is kept per gene and target, the one with the most methods."
  [rows features]
  (let [cols (selected-columns features)]
    (->> rows
         (map #(row-map features cols %))
         (reduce (fn [m r] (update m [(:gene-id r) (:target-id r)]
                                   #(if % (richer % r) r)))
                 {})
         vals
         (sort-by (juxt :gene :target))
         vec)))

(defn relation
  "Relation of a row given the number of targets of its gene and sources of its
  target."
  [targets-of-gene sources-of-target]
  (case [(> targets-of-gene 1) (> sources-of-target 1)]
    [false false] :one-to-one
    [true false] :one-to-many
    [false true] :many-to-one
    :many-to-many))

(defn- counts-by [rows from to]
  (->> rows
       (group-by from)
       (reduce-kv (fn [m k rs] (assoc m k (count (set (map to rs))))) {})))

(defn flag-relations
  "Rows with :relation set from the distinct genes on each side of the rows."
  [rows]
  (let [targets (counts-by rows :gene-id :target-id)
        sources (counts-by rows :target-id :gene-id)]
    (mapv #(assoc % :relation (relation (get targets (:gene-id %))
                                        (get sources (:target-id %))))
          rows)))

(defn passes?
  "True when the row has at least :min-methods matching methods and, with
  :best-only?, is the best score."
  [{:keys [min-methods best-only?]} row]
  (and (or (not (pos? (or min-methods 0)))
           (>= (or (:match row) 0) min-methods))
       (or (not best-only?) (:best? row))))

(defn filter-rows [opts rows]
  (filterv #(passes? opts %) rows))

(defn unmapped-genes
  "List genes that have no row, sorted by label. `genes` are maps with :id
  and :label."
  [genes rows]
  (let [mapped (set (map :gene-id rows))]
    (->> genes (remove #(contains? mapped (:id %))) (sort-by :label) vec)))

(defn parse-genes
  "Rows of [id identifier symbol] as {:id :label}."
  [rows]
  (mapv (fn [[id identifier symbol]] {:id id :label (label identifier symbol)}) rows))

(defn max-methods
  "Highest number of methods attempted in the rows, 0 when none is known."
  [rows]
  (apply max 0 (keep #(or (:attempted %) (:match %)) rows)))

(defn target-count [rows]
  (count (set (map :target-id rows))))

(defn relation-counts
  "Number of rows per relation."
  [rows]
  (frequencies (map :relation rows)))

(defn filter-constraints
  "Constraints that make the saved query match the preview filters."
  [{:keys [min-methods best-only?]} features]
  (cond-> []
    (and (:methods? features) (pos? (or min-methods 0)))
    (conj {:path match-path :op ">=" :value (str min-methods)})
    (and (:best? features) best-only?)
    (conj {:path best-path :op "=" :value "true"})))
