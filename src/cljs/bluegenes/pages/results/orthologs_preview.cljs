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
   [:best-reverse? "Gene.homologues.isBestReverseScore" :best-reverse?]
   [:stringency "Gene.homologues.stringencyFilter" :stringency?]])

(def optional-paths
  "Feature -> the path that must resolve for the feature to be offered."
  (into {} (keep (fn [[_ path feature]] (when feature [feature path]))) columns))

(def match-path "Gene.homologues.algorithmsMatch")
(def best-path "Gene.homologues.isBestScore")
(def type-path "Gene.homologues.type")
(def stringency-path "Gene.homologues.stringencyFilter")

(def least-diverged "least diverged orthologue")

(def ortholog-types
  "Homologue types that are orthologs. The mine also holds paralogues and
  generic homologues."
  ["orthologue" least-diverged])

(defn type-constraints
  "Restrict Gene.homologues to orthologs when the model has the type."
  [features]
  (if (:type? features)
    [{:path type-path :op "ONE OF" :values ortholog-types}]
    []))

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
   :where (into [{:path "Gene" :op "IN" :value list-name}
                 {:path "Gene.homologues.homologue.organism.shortName" :op "=" :value organism}]
                (type-constraints features))})

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
               :best-reverse? (true-value? (:best-reverse? m))
               :least-diverged? (= least-diverged (:type m)))
        (cond-> (not (:methods? features)) (dissoc :match :attempted)))))

(defn- rank [row]
  [(or (:match row) -1) (if (:best? row) 1 0) (if (:stringency row) 1 0)])

(defn- merge-rows
  "Scores of the row with the most methods. The pair is least diverged when any
  of its rows is."
  [a b]
  (let [richer (if (>= (compare (rank a) (rank b)) 0) a b)]
    (if (or (:least-diverged? a) (:least-diverged? b))
      (assoc richer :least-diverged? true :type least-diverged)
      richer)))

(defn parse-rows
  "Rows of `preview-query` as maps. The mine repeats a pair with empty scores,
  so one row is kept per gene and target: the scores of the row with the most
  methods, flagged :least-diverged? when any row of the pair is."
  [rows features]
  (let [cols (selected-columns features)]
    (->> rows
         (map #(row-map features cols %))
         (reduce (fn [m r] (update m [(:gene-id r) (:target-id r)]
                                   #(if % (merge-rows % r) r)))
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
  "True when the row has at least :min-methods matching methods, with
  :best-only? is the best score and with :stringent-only? has the stringent
  filter."
  [{:keys [min-methods best-only? stringent-only?]} row]
  (and (or (not (pos? (or min-methods 0)))
           (>= (or (:match row) 0) min-methods))
       (or (not best-only?) (:best? row))
       (or (not stringent-only?) (= "stringent" (:stringency row)))))

(defn filter-rows [opts rows]
  (filterv #(passes? opts %) rows))

(defn unmapped-genes
  "List genes that have no row, sorted by label. `genes` are maps with :id
  and :label."
  [genes rows]
  (let [mapped (set (map :gene-id rows))]
    (->> genes (remove #(contains? mapped (:id %))) (sort-by :label) vec)))

(defn dropped-genes
  "List genes that have rows, none of which is in `kept`, sorted by label."
  [genes rows kept]
  (let [with-rows (set (map :gene-id rows))
        kept-ids (set (map :gene-id kept))]
    (->> genes
         (filter #(and (contains? with-rows (:id %)) (not (contains? kept-ids (:id %)))))
         (sort-by :label)
         vec)))

(defn parse-genes
  "Rows of [id identifier symbol] as {:id :label :identifier :symbol}."
  [rows]
  (mapv (fn [[id identifier symbol]]
          {:id id :label (label identifier symbol) :identifier identifier :symbol symbol})
        rows))

(defn truncated?
  "True when a response holds as many rows as were asked for, so rows may be
  missing."
  [results limit]
  (>= (count results) limit))

(defn without-methods
  "Number of rows with no method data. They fail any method cutoff above 0."
  [rows]
  (count (filter #(nil? (:match %)) rows)))

(defn plural
  "\"1 gene\" or \"2 genes\"."
  ([n noun] (plural n noun (str noun "s")))
  ([n noun many] (str n " " (if (= 1 n) noun many))))

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
  [{:keys [min-methods best-only? stringent-only?]} features]
  (cond-> []
    (and (:methods? features) (pos? (or min-methods 0)))
    (conj {:path match-path :op ">=" :value (str min-methods)})
    (and (:best? features) best-only?)
    (conj {:path best-path :op "=" :value "true"})
    (and (:stringency? features) stringent-only?)
    (conj {:path stringency-path :op "=" :value "stringent"})))

(def relation-labels
  {:one-to-one "1:1" :one-to-many "1:many" :many-to-one "many:1" :many-to-many "many:many"})

(defn by-relation
  "Rows with `relation`, or all rows when it is nil."
  [relation rows]
  (if relation (filterv #(= relation (:relation %)) rows) rows))

(defn- tsv [header lines]
  (let [cell #(str/replace (if (nil? %) "" (str %)) #"[\t\r\n]" " ")]
    (str (str/join "\n" (map #(str/join "\t" (map cell %)) (cons header lines))) "\n")))

(defn mapping-tsv
  "Tab separated source to target pairs of `rows`, with the columns of the
  features the mine has."
  [rows features]
  (let [cols (cond-> [["Source id" :gene-identifier] ["Source symbol" :gene-symbol]
                      ["Target id" :target-identifier] ["Target symbol" :target-symbol]]
               (:type? features) (conj ["Type" :type])
               (:methods? features) (conj ["Methods matching" :match] ["Methods attempted" :attempted])
               (:best? features) (conj ["Best score" :best?])
               (:best-reverse? features) (conj ["Best reverse score" :best-reverse?])
               (:stringency? features) (conj ["Stringency" :stringency])
               true (conj ["Relation within list" (comp relation-labels :relation)]))]
    (tsv (map first cols)
         (map (fn [row] (map #((second %) row) cols)) rows))))

(defn unmapped-tsv
  "Tab separated list genes without a row, with the reason."
  [no-ortholog dropped]
  (tsv ["Gene id" "Gene symbol" "Reason"]
       (concat (map (juxt :identifier :symbol (constantly "no ortholog")) no-ortholog)
               (map (juxt :identifier :symbol (constantly "removed by the filters")) dropped))))
