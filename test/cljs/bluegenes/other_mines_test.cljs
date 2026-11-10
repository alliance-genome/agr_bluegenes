(ns bluegenes.other-mines-test
  (:require [cljs.test :refer-macros [deftest is testing use-fixtures]]
            [bluegenes.test-utils :as utils]
            [re-frame.core :as rf]
            [re-frame.db :refer [app-db]]
            [day8.re-frame.test :refer-macros [run-test-sync]]
            [bluegenes.pages.reportpage.other-mines :as om]))

(use-fixtures :each utils/fixtures)

(rf/reg-event-db
 ::seed-db
 (fn [_ [_ db]] db))

(deftest candidates
  (testing "CURIE prefix is stripped as a second candidate"
    (is (= ["WB:WBGene00000913" "WBGene00000913"] (om/identifier-candidates "WB:WBGene00000913")))
    (is (= ["FB:FBgn0003731" "FBgn0003731"] (om/identifier-candidates "FB:FBgn0003731")))
    (is (= ["SGD:S000001855" "S000001855"] (om/identifier-candidates "SGD:S000001855")))
    (is (= ["ZFIN:ZDB-GENE-000616-13" "ZDB-GENE-000616-13"]
           (om/identifier-candidates "ZFIN:ZDB-GENE-000616-13"))))
  (testing "only the first prefix is stripped"
    (is (= ["A:B:C" "B:C"] (om/identifier-candidates "A:B:C"))))
  (testing "bare and blank ids"
    (is (= ["YAL001C"] (om/identifier-candidates "YAL001C")))
    (is (= [] (om/identifier-candidates "")))
    (is (= [] (om/identifier-candidates nil)))
    (is (= ["WB:"] (om/identifier-candidates "WB:")))))

(deftest resolving
  (let [rows [[2 "104537" "Bare"] [1 "MGI:104537" "Full"]]]
    (testing "the as-is candidate wins over the bare one"
      (is (= {:id 1 :symbol "Full"}
             (om/pick-resolved ["MGI:104537" "104537"] rows))))
    (testing "falls back to the bare candidate"
      (is (= {:id 2 :symbol "Bare"}
             (om/pick-resolved ["MGI:1" "104537"] rows))))
    (testing "no match"
      (is (nil? (om/pick-resolved ["x"] rows)))
      (is (nil? (om/pick-resolved ["x"] []))))))

(deftest rows
  (is (= [{:primaryIdentifier "MGI:1" :symbol "a" :shortName "M. musculus" :taxonId "10090"}
          {:primaryIdentifier "WB:2" :symbol nil :shortName "C. elegans" :taxonId nil}]
         (om/rows->genes {:results [["MGI:1" "a" "M. musculus" 10090]
                                    ["MGI:1" "a" "M. musculus" 10090]
                                    [nil "x" "y" 1]
                                    ["WB:2" nil "C. elegans" nil]]}))))

(def mouse {:primaryIdentifier "MGI:1" :symbol "a" :shortName "M. musculus" :taxonId "10090"})
(def worm {:primaryIdentifier "WB:2" :symbol "b" :shortName "C. elegans" :taxonId "6239"})
(def no-taxon {:primaryIdentifier "X:3" :shortName "D. melanogaster" :taxonId nil})

(def organisms
  {:mousemine [{:shortName "M. musculus" :taxonId "10090"}]
   :wormmine [{:shortName "C. elegans" :taxonId "6239"}]
   :flymine [{:shortName "D. melanogaster" :taxonId "7227"}]
   :broken nil})

(deftest coverage
  (is (= [:mousemine] (om/covering-mines organisms mouse)))
  (is (= [:wormmine] (om/covering-mines organisms worm)))
  (testing "short name is used when the gene has no taxon id"
    (is (= [:flymine] (om/covering-mines organisms no-taxon))))
  (testing "no mine covers the organism"
    (is (= [] (om/covering-mines organisms {:taxonId "9606" :shortName "H. sapiens"}))))
  (testing "results are sorted by mine name"
    (is (= [:a :b] (om/covering-mines {:b [{:taxonId "1"}] :a [{:taxonId "1"}]}
                                      {:taxonId "1"})))))

(deftest planning
  (is (= [[:mousemine mouse] [:wormmine worm]]
         (om/plan-tasks [mouse worm] organisms :flymine)))
  (testing "the current mine is skipped"
    (is (= [[:wormmine worm]]
           (om/plan-tasks [mouse worm] organisms :mousemine)))))

(deftest queries
  (is (= {:from "Gene"
          :select ["Gene.id" "Gene.primaryIdentifier" "Gene.symbol"]
          :where [{:path "Gene.primaryIdentifier" :op "ONE OF" :values ["WB:2" "2"]}
                  {:path "Gene.organism.taxonId" :op "=" :value "6239"}]}
         (om/lookup-query ["WB:2" "2"] worm)))
  (is (= {:path "Gene.organism.shortName" :op "=" :value "D. melanogaster"}
         (second (:where (om/lookup-query ["X:3"] no-taxon))))))

(deftest ordering
  (is (= [mouse worm no-taxon]
         (om/order-genes [mouse] [no-taxon mouse worm]))))

(deftest panel
  (let [rows (om/panel-rows {:genes [mouse worm]
                             :results {[:mousemine "MGI:1"] {:status :found :id 5 :symbol "a"}}
                             :organisms-by-mine organisms
                             :current-mine :flymine
                             :mine-names {:mousemine "MouseMine"}})]
    (is (= [[true :mousemine "MouseMine" :found]
            [false :wormmine "wormmine" :queued]]
           (map (juxt :self? :mine-kw :mine-name :status) rows)))))

(defn- seed [other-mines]
  (rf/dispatch [::seed-db {:report {:key [:alliancetestmine "Gene" "7"]
                                    :other-mines other-mines}
                           :env {:mines {:alliancetestmine {:service {:root "x"}}
                                         :mousemine {:service {:root "y"}}}}}]))

(deftest stale-responses
  (run-test-sync
   (seed {:inflight 1 :results {}})
   (rf/dispatch [::om/lookup-success [:alliancetestmine "Gene" "6"] [:mousemine mouse]
                 ["MGI:1"] {:results [[1 "MGI:1" "a"]]}])
   (rf/dispatch [::om/genes-success [:alliancetestmine "Gene" "6"] :self
                 {:results [["MGI:1" "a" "M. musculus" 1]]}])
   (is (= {:inflight 1 :results {}} (get-in @app-db [:report :other-mines])))))

(deftest current-responses
  (run-test-sync
   (seed {:inflight 2 :results {}})
   (rf/dispatch [::om/lookup-success [:alliancetestmine "Gene" "7"] [:mousemine mouse]
                 ["MGI:1"] {:results [[1 "MGI:1" "a"]]}])
   (is (= {:status :found :id 1 :symbol "a"}
          (get-in @app-db [:report :other-mines :results [:mousemine "MGI:1"]])))
   (is (= 1 (get-in @app-db [:report :other-mines :inflight])))
   (rf/dispatch [::om/lookup-success [:alliancetestmine "Gene" "7"] [:mousemine worm]
                 ["WB:2" "2"] {:results []}])
   (is (= {:status :not-found}
          (get-in @app-db [:report :other-mines :results [:mousemine "WB:2"]])))
   (is (zero? (get-in @app-db [:report :other-mines :inflight])))))

(deftest pump-cap
  (run-test-sync
   ;; Replace the network lookup so the pump only does its bookkeeping.
   (rf/reg-event-fx ::om/lookup (fn [_ _] nil))
   (seed {:inflight 0
          :queue (vec (for [i (range 10)]
                        [:mousemine {:primaryIdentifier (str "G" i)}]))
          :results {}})
   (rf/dispatch [::om/pump [:alliancetestmine "Gene" "7"]])
   (is (= om/max-parallel (get-in @app-db [:report :other-mines :inflight])))
   (is (= (- 10 om/max-parallel) (count (get-in @app-db [:report :other-mines :queue]))))
   (is (= :loading (get-in @app-db [:report :other-mines :results [:mousemine "G0"] :status])))
   (testing "a full pump does not start more"
     (rf/dispatch [::om/pump [:alliancetestmine "Gene" "7"]])
     (is (= om/max-parallel (get-in @app-db [:report :other-mines :inflight]))))))

(deftest hidden-with-one-mine
  (run-test-sync
   (rf/dispatch [::seed-db {:current-mine :alliancetestmine
                            :report {:key [:alliancetestmine "Gene" "7"]
                                     :other-mines {:inflight 0}}
                            :env {:mines {:alliancetestmine {:service {:root "x"}}}}}])
   (is (nil? @(rf/subscribe [::om/panel])))
   (rf/dispatch [:report-other-mines/start [:alliancetestmine "Gene" "7"]])
   (is (nil? (:other-mines @app-db)))))
