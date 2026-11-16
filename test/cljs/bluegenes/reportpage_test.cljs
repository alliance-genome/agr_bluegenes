(ns bluegenes.reportpage-test
  (:require [cljs.test :refer-macros [deftest is testing use-fixtures]]
            [bluegenes.test-utils :as utils]
            [re-frame.core :as rf]
            [re-frame.db :refer [app-db]]
            [day8.re-frame.test :refer-macros [run-test-sync]]
            [bluegenes.pages.reportpage.events :as events]))

(use-fixtures :each utils/fixtures)

(rf/reg-event-db
 ::seed-db
 (fn [_ [_ db]] db))

(deftest stale-report-responses
  (run-test-sync
   (rf/dispatch [::seed-db {:report {:key [:biotestmine "Gene" 2]}}])
   (testing "responses for an earlier report are dropped"
     (rf/dispatch [::events/handle-lists [:biotestmine "Gene" 1] ["stale"]])
     (rf/dispatch [:handle-fasta [:biotestmine "Gene" 1] ">stale"])
     (rf/dispatch [:fetch-report-failure [:biotestmine "Gene" 1] {}])
     (rf/dispatch [:handle-report-summary :biotestmine "Gene" 1 {:results [[1]]}])
     (is (= {:key [:biotestmine "Gene" 2]} (:report @app-db))))
   (testing "responses for the current report are stored"
     (rf/dispatch [::events/handle-lists [:biotestmine "Gene" 2] ["fresh"]])
     (rf/dispatch [:handle-fasta [:biotestmine "Gene" 2] ">fresh"])
     (is (= ["fresh"] (get-in @app-db [:report :lists])))
     (is (= ">fresh" (get-in @app-db [:report :fasta]))))))

(def ^:private yeast-gene ["S000001855" "S. cerevisiae" "S000001855"])

(defn- gene-constraint [lookup mine]
  (first (:where (events/homologue-query lookup mine))))

(def ^:private yeast-one-of
  {:path "homologues.homologue.primaryIdentifier"
   :op "ONE OF"
   :values ["S000001855" "SGD:S000001855"]})

(deftest homologue-query-per-mine
  (testing "AllianceMine gets the bare and CURIE forms"
    (is (= yeast-one-of (gene-constraint yeast-gene {:namespace "alliancemine"}))))
  (testing "FlyMine, WormMine, MouseMine and HumanMine use the same ONE OF"
    (doseq [mine-ns ["flymine" "wormmine" "mousemine" "humanmine"]]
      (is (= yeast-one-of (gene-constraint yeast-gene {:namespace mine-ns}))
          mine-ns)))
  (testing "a CURIE gene is tried as given and without its prefix"
    (is (= ["WB:WBGene00006759" "WBGene00006759"]
           (:values (gene-constraint ["WB:WBGene00006759" "C. elegans" "WB:WBGene00006759"]
                                     {:namespace "alliancemine"}))))
    (is (= ["HGNC:11998"]
           (:values (gene-constraint ["HGNC:11998" "H. sapiens" "HGNC:11998"]
                                     {:namespace "flymine"})))))
  (testing "no primaryIdentifier falls back to LOOKUP with the organism"
    (is (= {:path "homologues.homologue"
            :op "LOOKUP"
            :value "ACT1"
            :extraValue "S. cerevisiae"}
           (gene-constraint ["ACT1" "S. cerevisiae" nil] {:namespace "flymine"}))))
  (testing "phytomine keeps its shim path and LOOKUP"
    (is (= {:path "homolog.gene"
            :op "LOOKUP"
            :value "S000001855"
            :extraValue "S. cerevisiae"}
           (gene-constraint yeast-gene {:namespace "phytomine"})))))

(deftest homologue-query-organisms
  (is (= {:path "organism" :op "LOOKUP" :value "H. sapiens, M. musculus"}
         (second (:where (events/homologue-query
                          yeast-gene
                          {:namespace "alliancemine"
                           :organisms ["H. sapiens" "M. musculus"]}))))))

(deftest lookup-value-primary-identifier
  (let [summary {:views ["Gene.primaryIdentifier" "Gene.organism.shortName"]
                 :results [["S000001855" "S. cerevisiae"]]}]
    (is (= yeast-gene (events/lookup-value summary)))))
