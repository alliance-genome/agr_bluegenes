(ns bluegenes.orthologs-preview-test
  (:require [cljs.test :refer-macros [deftest is testing]]
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
          {:path "Gene.homologues.homologue.organism.shortName" :op "=" :value "M. musculus"}]
         (:where (preview/preview-query "L" "M. musculus" all)))))

(deftest parse-keeps-richest-duplicate
  (let [parsed (preview/parse-rows [(raw 1 10 nil nil) (raw 1 10 9 true) (raw 1 10 nil nil)] all)]
    (is (= 1 (count parsed)))
    (is (= 9 (:match (first parsed))))
    (is (true? (:best? (first parsed))))))

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

(deftest relations-follow-the-filter
  (let [kept (preview/filter-rows {:min-methods 5} rows)
        flagged (preview/flag-relations kept)]
    (is (= [:one-to-one :one-to-one] (map :relation flagged))
        "gene 2 and gene 3's second target are gone")))

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
                                    [4 "G4" "g4"] [5 "G5" "g5"] [6 "G6" nil]])]
    (is (= ["G6" "g5"] (map :label (preview/unmapped-genes genes rows))))
    (testing "genes whose rows were filtered out become unmapped"
      (is (= ["G6" "g2" "g4" "g5"]
             (map :label (preview/unmapped-genes genes (preview/filter-rows {:min-methods 8} rows))))))
    (is (= (count genes) (count (preview/unmapped-genes genes []))))))

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
