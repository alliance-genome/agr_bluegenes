(ns bluegenes.orthologs-preview-test
  (:require [cljs.test :refer-macros [deftest is testing]]
            [clojure.string :as str]
            [bluegenes.pages.results.orthologs-preview :as preview]))

(def all {:type? true :methods? true :best? true :best-reverse? true})

(defn raw
  "Query row: gene id, identifier, symbol, target id, identifier, symbol, then
  type, match, attempted, best, best reverse."
  [gene target & [match best]]
  [gene (str "G" gene) (str "g" gene) target (str "T" target) (str "t" target)
   "orthologue" match 10 best (boolean best)])

(def rows
  (preview/parse-rows
   [(raw 1 10 9 true)
    (raw 2 10 4 false)
    (raw 3 11 8 true)
    (raw 3 12 3 false)
    (raw 4 13 1 false)]
   all))

(deftest query-columns
  (is (= ["Gene.id" "Gene.primaryIdentifier" "Gene.symbol"
          "Gene.homologues.homologue.id"
          "Gene.homologues.homologue.primaryIdentifier"
          "Gene.homologues.homologue.symbol"
          "Gene.homologues.type"
          "Gene.homologues.algorithmsMatch" "Gene.homologues.algorithmsAttempted"
          "Gene.homologues.isBestScore" "Gene.homologues.isBestReverseScore"]
         (:select (preview/preview-query "L" "M. musculus" all))))
  (testing "columns of missing features are left out"
    (is (= 6 (count (:select (preview/preview-query "L" "M. musculus" {})))))
    (is (not-any? #{"Gene.homologues.algorithmsMatch"}
                  (:select (preview/preview-query "L" "X" {:best? true})))))
  (is (= [{:path "Gene" :op "IN" :value "L"}
          {:path "Gene.homologues.homologue.organism.shortName" :op "=" :value "M. musculus"}
          {:path "Gene.homologues.type" :op "ONE OF" :values ["orthologue" "least diverged orthologue"]}]
         (:where (preview/preview-query "L" "M. musculus" all)))
      "paralogues and generic homologues are left out")
  (testing "no type constraint when the model has no type"
    (is (= 2 (count (:where (preview/preview-query "L" "M. musculus" {})))))))

(deftest parse-keeps-richest-duplicate
  (let [parsed (preview/parse-rows [(raw 1 10 nil nil) (raw 1 10 9 true) (raw 1 10 nil nil)] all)]
    (is (= 1 (count parsed)))
    (is (= 9 (:match (first parsed))))
    (is (true? (:best? (first parsed))))))

(def live-hnf1a
  "Gene.homologues rows of HGNC:11621 to M. musculus as the mine returns them:
  type, match, attempted, best, best reverse, stringency."
  [["least diverged orthologue" nil nil nil nil nil "MGI:98504"]
   ["orthologue" 10 10 true true "stringent" "MGI:98504"]
   ["orthologue" nil nil nil nil nil "MGI:98504"]
   ["orthologue" nil nil nil nil nil "MGI:98505"]])

(defn live-row [[type match attempted best best-reverse stringency target]]
  [1 "HGNC:11621" "HNF1A" target target nil type match attempted best best-reverse stringency])

(deftest parse-live-rows
  (let [feats (assoc all :stringency? true)
        parsed (preview/parse-rows (map live-row live-hnf1a) feats)
        by-target (into {} (map (juxt :target-id identity)) parsed)]
    (is (= 2 (count parsed)))
    (testing "scores of the scored row, type and flag of the least diverged row"
      (let [r (by-target "MGI:98504")]
        (is (= 10 (:match r)))
        (is (true? (:best? r)))
        (is (= "stringent" (:stringency r)))
        (is (true? (:least-diverged? r)))
        (is (= "least diverged orthologue" (:type r)))))
    (testing "a pair with no scores stays unscored and is not least diverged"
      (is (nil? (:match (by-target "MGI:98505"))))
      (is (false? (:least-diverged? (by-target "MGI:98505")))))
    (testing "row order does not change the result"
      (is (= parsed (preview/parse-rows (reverse (map live-row live-hnf1a)) feats))))))

(deftest parse-labels-and-strings
  (let [r (first (preview/parse-rows [[1 "G1" nil 10 "T10" "t10" "orthologue" 5 10 "true" "false"]] all))]
    (is (= "G1" (:gene r)) "identifier when the symbol is blank")
    (is (= "t10" (:target r)))
    (is (true? (:best? r)))
    (is (false? (:best-reverse? r)))))

(deftest parse-without-methods
  (let [r (first (preview/parse-rows [[1 "G1" "g1" 10 "T10" "t10"]] {}))]
    (is (nil? (:match r)))
    (is (false? (:best? r)))))

(deftest relations
  (is (= :one-to-one (preview/relation 1 1)))
  (is (= :one-to-many (preview/relation 2 1)))
  (is (= :many-to-one (preview/relation 1 2)))
  (is (= :many-to-many (preview/relation 2 2)))
  (let [flagged (preview/flag-relations rows)
        by-gene (group-by :gene-id flagged)]
    (testing "genes 1 and 2 share target 10"
      (is (= :many-to-one (:relation (first (by-gene 1)))))
      (is (= :many-to-one (:relation (first (by-gene 2))))))
    (testing "gene 3 has two targets"
      (is (= [:one-to-many :one-to-many] (map :relation (by-gene 3)))))
    (testing "gene 4 maps alone"
      (is (= :one-to-one (:relation (first (by-gene 4))))))
    (is (= {:many-to-one 2 :one-to-many 2 :one-to-one 1}
           (preview/relation-counts flagged)))))

(deftest relations-ignore-the-filter
  (let [kept (preview/filter-rows {:min-methods 5} (preview/flag-relations rows))]
    (is (= [:many-to-one :one-to-many] (map :relation kept))
        "relations are computed on all rows, so a cutoff does not change them")))

(deftest relation-filter
  (let [flagged (preview/flag-relations rows)]
    (is (= 5 (count (preview/by-relation nil flagged))))
    (is (= [3 3] (map :gene-id (preview/by-relation :one-to-many flagged))))))

(deftest filters
  (is (= 5 (count (preview/filter-rows {} rows))))
  (is (= [1 3] (map :gene-id (preview/filter-rows {:min-methods 8} rows))))
  (testing "nil match fails any positive cutoff"
    (is (empty? (preview/filter-rows {:min-methods 1}
                                     (preview/parse-rows [(raw 1 10 nil nil)] all)))))
  (is (= [1 3] (map :gene-id (preview/filter-rows {:best-only? true} rows))))
  (is (= [1 3] (map :gene-id (preview/filter-rows {:best-only? true :min-methods 8} rows))))
  (is (empty? (preview/filter-rows {:best-only? true :min-methods 10} rows))))

(deftest unmapped
  (let [genes (preview/parse-genes [[1 "G1" "g1"] [2 "G2" "g2"] [3 "G3" "g3"]
                                    [4 "G4" "g4"] [5 "G5" "g5"] [6 "G6" nil]])
        kept (preview/filter-rows {:min-methods 8} rows)]
    (is (= ["G6" "g5"] (map :label (preview/unmapped-genes genes rows))))
    (testing "genes whose rows were filtered out are not unmapped"
      (is (= ["G6" "g5"] (map :label (preview/unmapped-genes genes rows))))
      (is (= ["g2" "g4"] (map :label (preview/dropped-genes genes rows kept)))))
    (is (empty? (preview/dropped-genes genes rows rows)))
    (is (= (count genes) (count (preview/unmapped-genes genes []))))))

(deftest truncation
  (is (false? (preview/truncated? (repeat 99999 []) 100000)))
  (is (true? (preview/truncated? (repeat 100000 []) 100000)))
  (is (true? (preview/truncated? (repeat 3 []) 3))))

(deftest method-data-count
  (is (= 1 (preview/without-methods (preview/parse-rows [(raw 1 10 nil nil) (raw 2 11 5 true)] all)))))

(deftest plurals
  (is (= "1 gene" (preview/plural 1 "gene")))
  (is (= "0 genes" (preview/plural 0 "gene")))
  (is (= "2 mappings" (preview/plural 2 "mapping" "mappings")))
  (is (= "1 mapping" (preview/plural 1 "mapping" "mappings"))))

(deftest stringency-filter
  (let [feats (assoc all :stringency? true)
        parsed (preview/parse-rows (map live-row live-hnf1a) feats)]
    (is (= ["MGI:98504"] (map :target-id (preview/filter-rows {:stringent-only? true} parsed))))
    (is (= 2 (count (preview/filter-rows {} parsed))))
    (is (= [{:path "Gene.homologues.stringencyFilter" :op "=" :value "stringent"}]
           (preview/filter-constraints {:stringent-only? true} feats)))
    (is (= [] (preview/filter-constraints {:stringent-only? true} all)))))

(deftest exports
  (let [feats (assoc all :stringency? true)
        parsed (preview/flag-relations (preview/parse-rows (map live-row live-hnf1a) feats))
        lines (str/split-lines (preview/mapping-tsv parsed feats))]
    (is (= "Source id\tSource symbol\tTarget id\tTarget symbol\tType\tMethods matching\tMethods attempted\tBest score\tBest reverse score\tStringency\tRelation within list"
           (first lines)))
    (is (= "HGNC:11621\tHNF1A\tMGI:98504\t\tleast diverged orthologue\t10\t10\ttrue\ttrue\tstringent\t1:many"
           (second lines)))
    (is (= 3 (count lines))))
  (testing "no feature columns without features"
    (is (= "Source id\tSource symbol\tTarget id\tTarget symbol\tRelation within list"
           (first (str/split-lines (preview/mapping-tsv [] {}))))))
  (testing "unmapped genes carry the reason"
    (let [genes (preview/parse-genes [[1 "G1" "g\t1"] [2 "G2" nil]])]
      (is (= "Gene id\tGene symbol\tReason\nG1\tg 1\tno ortholog\nG2\t\tremoved by the filters\n"
             (preview/unmapped-tsv (take 1 genes) (drop 1 genes)))))))

(deftest summaries
  (is (= 10 (preview/max-methods rows)))
  (is (= 0 (preview/max-methods [])))
  (is (= 4 (preview/target-count rows)))
  (is (= 1 (preview/target-count (preview/filter-rows {:min-methods 8} (take 1 rows))))))

(deftest saved-query-constraints
  (is (= [] (preview/filter-constraints {} all)))
  (is (= [{:path "Gene.homologues.algorithmsMatch" :op ">=" :value "6"}
          {:path "Gene.homologues.isBestScore" :op "=" :value "true"}]
         (preview/filter-constraints {:min-methods 6 :best-only? true} all)))
  (testing "unavailable features add nothing"
    (is (= [] (preview/filter-constraints {:min-methods 6 :best-only? true} {})))))
