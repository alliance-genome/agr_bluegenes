(ns bluegenes.orthologs-compare-test
  (:require [cljs.test :refer-macros [deftest is testing use-fixtures]]
            [bluegenes.test-utils :as utils :refer [stub-fetch-fn]]
            [re-frame.core :as rf]
            [day8.re-frame.test :refer-macros [run-test-sync run-test-async wait-for]]
            [imcljs.fetch :as fetch]
            [imcljs.save :as save]
            [bluegenes.pages.results.orthologs-compare :as compare]))

(use-fixtures :each utils/fixtures)

(def genes
  [{:id 1 :symbol "A" :organism "H. sapiens"}
   {:id 2 :symbol "B" :organism "H. sapiens"}
   {:id 3 :symbol "C" :organism "H. sapiens"}
   {:id 4 :symbol "D" :organism "H. sapiens"}])

(def pairs
  [{:gene 1 :ortholog 10 :organism "M. musculus" :stringency "stringent" :best? true}
   {:gene 1 :ortholog 11 :organism "D. rerio" :stringency "moderate" :best? false}
   {:gene 2 :ortholog 12 :organism "M. musculus" :stringency "moderate" :best? true}
   {:gene 2 :ortholog 13 :organism "M. musculus" :stringency "stringent" :best? false}
   {:gene 2 :ortholog 11 :organism "D. rerio" :stringency "stringent" :best? true}
   {:gene 3 :ortholog 14 :organism "M. musculus" :stringency "stringent" :best? true}])

(deftest queries
  (is (= ["Gene.id" "Gene.homologues.homologue.id"
          "Gene.homologues.homologue.organism.shortName"
          "Gene.homologues.stringencyFilter" "Gene.homologues.isBestScore"]
         (:select (compare/pairs-query "L"))))
  (is (= [{:path "Gene" :op "IN" :value "L"}] (:where (compare/pairs-query "L"))))
  (is (= {:from "Gene" :select ["Gene.id"]
          :where [{:path "Gene.id" :op "ONE OF" :values ["1" "2"]}]}
         (compare/genes-by-id-query [1 2]))))

(deftest parsing
  (is (= [{:gene 1 :ortholog 10 :organism "M. musculus" :stringency "stringent" :best? true}
          {:gene 2 :ortholog 11 :organism "D. rerio" :stringency nil :best? false}]
         (compare/parse-pairs [[1 10 "M. musculus" "stringent" true]
                               [1 12 "" "stringent" true]
                               [2 11 "D. rerio" nil nil]])))
  (is (= [{:id 1 :identifier "X:1" :symbol "A" :organism "H. sapiens"}]
         (compare/parse-genes [[1 "X:1" "A" "H. sapiens"]]))))

(deftest filtering
  (testing "stringency values come strictest first"
    (is (= ["stringent" "moderate" "weird"]
           (compare/stringency-values [{:stringency "weird"} {:stringency "moderate"}
                                       {:stringency "stringent"} {:stringency nil}]))))
  (testing "no options keeps all"
    (is (= pairs (compare/filter-pairs {} pairs))))
  (testing "stringent keeps only stringent rows"
    (is (= #{10 13 11 14}
           (set (map :ortholog (compare/filter-pairs {:stringency "stringent"} pairs))))))
  (testing "moderate keeps moderate and stringent"
    (is (= (count pairs) (count (compare/filter-pairs {:stringency "moderate"} pairs)))))
  (testing "best-only"
    (is (= #{10 12 11 14}
           (set (map :ortholog (compare/filter-pairs {:best-only? true} pairs))))))
  (testing "both"
    (is (= #{10 11 14}
           (set (map :ortholog (compare/filter-pairs {:stringency "stringent" :best-only? true}
                                                     pairs)))))))

(deftest organism-sets-and-counts
  (is (= ["D. rerio" "H. sapiens" "M. musculus"] (compare/organisms genes pairs)))
  (is (= {1 #{"M. musculus" "D. rerio"}
          2 #{"M. musculus" "D. rerio"}
          3 #{"M. musculus"}
          4 #{}}
         (compare/organism-sets genes pairs)))
  (is (= {:one-to-one 2 :one-to-many 1 :none 1}
         (compare/organism-counts genes pairs "M. musculus")))
  (is (= {:one-to-one 2 :one-to-many 0 :none 2}
         (compare/organism-counts genes pairs "D. rerio")))
  (testing "duplicate rows for one ortholog count once"
    (is (= {:one-to-one 1 :one-to-many 0 :none 3}
           (compare/organism-counts genes
                                    [{:gene 1 :ortholog 10 :organism "M. musculus"}
                                     {:gene 1 :ortholog 10 :organism "M. musculus"}]
                                    "M. musculus"))))
  (testing "the list's own organism has all genes with none"
    (is (= {:one-to-one 0 :one-to-many 0 :none 4}
           (compare/organism-counts genes pairs "H. sapiens")))))

(deftest intersection-groups
  (let [sets (compare/organism-sets genes pairs)
        ints (compare/intersections sets)]
    (is (= [{:organisms ["D. rerio" "M. musculus"] :genes [1 2] :size 2}
            {:organisms ["M. musculus"] :genes [3] :size 1}]
           ints)
        "genes with no ortholog are left out, largest group first"))
  (testing "ties sort by fewer organisms, then names"
    (is (= [["B"] ["A" "B"] ["A" "C"]]
           (map :organisms
                (compare/intersections {1 #{"A" "B"} 2 #{"B"} 3 #{"A" "C"}})))))
  (testing "limit"
    (is (= 2 (count (compare/intersections {1 #{"A"} 2 #{"B"} 3 #{"C"}} 2))))
    (is (= 15 (count (compare/intersections
                      (into {} (map (fn [i] [i #{(str "O" i)}])) (range 40))))))))

(deftest selection
  (let [ints (compare/intersections (compare/organism-sets genes pairs))]
    (is (= [1 2] (map :id (compare/selected-genes genes ints ["D. rerio" "M. musculus"]))))
    (is (empty? (compare/selected-genes genes ints ["nope"])))))

(deftest upset-layout
  (let [ints [{:organisms ["A" "B"] :genes [1 2 3 4] :size 4}
              {:organisms ["A"] :genes [5 6] :size 2}]
        {:keys [bars rows width]} (compare/upset-geometry ["A" "B"] ints)]
    (is (= 2 (count bars)))
    (is (= 2 (count rows)))
    (is (= 140 (:h (first bars))) "largest bar fills the height")
    (is (= 70 (:h (second bars))))
    (is (< (:cx (first bars)) (:cx (second bars))))
    (is (pos? width))))

(rf/reg-event-db ::seed (fn [_ [_ db]] db))
(rf/reg-sub ::compare #(get-in % [:results :orthologs-compare]))
(rf/reg-event-db ::noop (fn [db _] db))

(def seeded-db
  {:current-mine :test
   :mines {:test {:service {:root "http://example.org"}}}
   :assets {:lists {:test [{:name "L orthologs in M. musculus"}]}}})

(deftest stale-results-are-ignored
  (run-test-sync
   (rf/dispatch [::seed (assoc seeded-db :results
                               {:orthologs-compare {:open? true :list-source "L" :loading? true}})])
   (rf/dispatch [::compare/pairs-success "other" {:results [[1 10 "M. musculus" "stringent" true]]}])
   (is (nil? (:pairs @(rf/subscribe [::compare]))))
   (rf/dispatch [::compare/pairs-success "L" {:results [[1 10 "M. musculus" "stringent" true]]}])
   (is (= 1 (count (:pairs @(rf/subscribe [::compare])))))
   (is (false? (:loading? @(rf/subscribe [::compare]))))))

(deftest changing-filters-clears-selection
  (run-test-sync
   (rf/dispatch [::seed (assoc seeded-db :results
                               {:orthologs-compare {:open? true :selected ["A"]}})])
   (rf/dispatch [::compare/set-stringency "stringent"])
   (is (= "stringent" (:stringency @(rf/subscribe [::compare]))))
   (is (nil? (:selected @(rf/subscribe [::compare]))))
   (rf/dispatch [::compare/select-intersection ["A"]])
   (is (= ["A"] (:selected @(rf/subscribe [::compare]))))
   (rf/dispatch [::compare/select-intersection ["A"]])
   (is (nil? (:selected @(rf/subscribe [::compare]))) "second click deselects")))

(deftest open-fetches-genes-then-pairs
  (run-test-async
   (let [calls (atom [])
         orig-rows fetch/rows
         rows-stub (fn [_service query _options]
                     (swap! calls conj query)
                     ((stub-fetch-fn
                       (if (= ["Gene.id" "Gene.primaryIdentifier" "Gene.symbol"
                               "Gene.organism.shortName"]
                              (:select query))
                         {:results [[1 "X:1" "A" "H. sapiens"]]}
                         {:results [[1 10 "M. musculus" "stringent" true]]}))))]
     (rf/dispatch-sync [::seed seeded-db])
     (set! fetch/rows rows-stub)
     (swap! utils/stubbed-variables conj #(set! fetch/rows orig-rows))
     (rf/dispatch [::compare/toggle "L"])
     (wait-for [::compare/pairs-success]
       (let [state @(rf/subscribe [::compare])]
         (is (= 1 (count (:genes state))))
         (is (= 1 (count (:pairs state))))
         (is (false? (:loading? state))))
       (is (= [(compare/genes-query "L") (compare/pairs-query "L")] @calls))))))

(deftest save-chain
  (run-test-async
   (let [saved (atom nil)
         orig-save save/im-list-from-query]
     (rf/dispatch-sync [::seed (assoc seeded-db :results
                                      {:orthologs-compare {:open? true :list-source "L"
                                                           :selected ["M. musculus"]}})])
     (rf/reg-event-fx :assets/fetch-lists
                      (fn [_ [_ next-evt]]
                        {:dispatch [::noop next-evt]}))
     (set! save/im-list-from-query
           (fn [_service name query]
             (reset! saved [name query])
             ((stub-fetch-fn {:listName name}))))
     (swap! utils/stubbed-variables conj #(set! save/im-list-from-query orig-save))
     (rf/dispatch [::compare/save [3 5]])
     (wait-for [::compare/save-success]
       (is (= "L orthologs in M. musculus_1" (first @saved)) "name clash gets a suffix")
       (is (= (compare/genes-by-id-query [3 5]) (second @saved)))
       (is (nil? @(rf/subscribe [::compare])))))))

(deftest save-needs-genes
  (run-test-sync
   (rf/dispatch [::seed (assoc seeded-db :results
                               {:orthologs-compare {:open? true :list-source "L"
                                                    :selected ["A"]}})])
   (rf/dispatch [::compare/save []])
   (is (not (:saving? @(rf/subscribe [::compare]))))))

(deftest results-clear-resets-panel
  (run-test-sync
   (rf/dispatch [::seed (assoc seeded-db :results {:orthologs-compare {:open? true}})])
   (rf/dispatch [:results/clear])
   (is (nil? @(rf/subscribe [::compare])))))
