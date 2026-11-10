(ns bluegenes.alliance-summary-test
  (:require [cljs.test :refer-macros [deftest is testing use-fixtures]]
            [bluegenes.test-utils :as utils]
            [re-frame.core :as rf]
            [re-frame.db :refer [app-db]]
            [day8.re-frame.test :refer-macros [run-test-sync]]
            [bluegenes.alliance-curie :refer [to-alliance-curie]]
            [bluegenes.pages.reportpage.alliance-summary :as as]))

(use-fixtures :each utils/fixtures)

(rf/reg-event-db
 ::seed-db
 (fn [_ [_ db]] db))

;; Trimmed from the response of GET /api/gene/HGNC:11998
;; (test/fixtures/alliance-gene-HGNC-11998.json).
(def tp53-response
  {:category "gene_summary"
   :gene {:primaryExternalId "HGNC:11998"
          :relatedNotes [{:freeText "This gene encodes a tumor suppressor protein."
                          :noteType {:name "MOD_provided_gene_description"}}
                         {:freeText "Enables several functions, including DNA binding activity."
                          :noteType {:name "automated_gene_description"}}]
          :geneType {:curie "SO:0001217" :name "protein_coding_gene"}
          :geneSynonyms [{:formatText "LFS1" :displayText "LFS1"}
                         {:formatText "TRP53" :displayText "TRP53"}
                         {:formatText "LFS1" :displayText "LFS1"}]}})

(deftest curies-for-seven-species
  (testing "AllianceMine identifiers are kept"
    (is (= "HGNC:11998" (to-alliance-curie "HGNC:11998" "H. sapiens")))
    (is (= "MGI:104537" (to-alliance-curie "MGI:104537" "M. musculus")))
    (is (= "RGD:2018" (to-alliance-curie "RGD:2018" "R. norvegicus")))
    (is (= "ZFIN:ZDB-GENE-000616-13" (to-alliance-curie "ZFIN:ZDB-GENE-000616-13" "D. rerio")))
    (is (= "FB:FBgn0003731" (to-alliance-curie "FB:FBgn0003731" "D. melanogaster")))
    (is (= "WB:WBGene00000913" (to-alliance-curie "WB:WBGene00000913" "C. elegans")))
    (is (= "SGD:S000001855" (to-alliance-curie "SGD:S000001855" "S. cerevisiae"))))
  (testing "bare identifiers are prefixed by shape"
    (is (= "FB:FBgn0003731" (to-alliance-curie "FBgn0003731" "D. melanogaster")))
    (is (= "WB:WBGene00000913" (to-alliance-curie "WBGene00000913" "C. elegans")))
    (is (= "SGD:S000001855" (to-alliance-curie "S000001855" "S. cerevisiae")))
    (is (= "ZFIN:ZDB-GENE-000616-13" (to-alliance-curie "ZDB-GENE-000616-13" "D. rerio"))))
  (testing "bare numbers are never prefixed: in the MOD mines they are Entrez ids"
    (is (nil? (to-alliance-curie "2018" "R. norvegicus")))
    (is (nil? (to-alliance-curie "2018" 10116)))
    (is (nil? (to-alliance-curie "104537" "Mus musculus")))
    (is (nil? (to-alliance-curie "110292" "D. rerio")))
    (is (nil? (to-alliance-curie "113563677" "D. erecta"))))
  (testing "bare numbers for human are not mapped (HumanMine uses Entrez ids)"
    (is (nil? (to-alliance-curie "7157" "H. sapiens")))
    (is (nil? (to-alliance-curie "11998" "9606"))))
  (testing "taxon ids"
    (is (= "SGD:S000001855" (to-alliance-curie "S000001855" "559292")))
    (is (= "ZFIN:ZDB-GENE-000616-13" (to-alliance-curie "ZDB-GENE-000616-13" "7955"))))
  (testing "unmappable input gives nil"
    (is (nil? (to-alliance-curie "2018" "D. melanogaster")))
    (is (nil? (to-alliance-curie "2018" nil)))
    (is (nil? (to-alliance-curie "PFI1105w" "P. falciparum 3D7")))
    (is (nil? (to-alliance-curie "" "R. norvegicus")))
    (is (nil? (to-alliance-curie nil nil)))))

(deftest curie-from-query-rows
  (is (= "HGNC:11998" (as/curie-from-rows {:results [["HGNC:11998" "H. sapiens" "9606"]]})))
  (is (= "FB:FBgn0003731" (as/curie-from-rows {:results [["FBgn0003731" "D. melanogaster" 7227]]})))
  (testing "short name is used when the taxon id is missing"
    (is (= "FB:FBgn0003731" (as/curie-from-rows {:results [["FBgn0003731" "D. melanogaster" nil]]}))))
  (is (nil? (as/curie-from-rows {:results []}))))

(deftest urls
  (is (= "https://www.alliancegenome.org/api/gene/HGNC%3A11998"
         (as/api-url "https://www.alliancegenome.org/api" "HGNC:11998")))
  (is (= "https://x.org/api/gene/MGI%3A1" (as/api-url "https://x.org/api/" "MGI:1")))
  (is (nil? (as/api-url "" "MGI:1")))
  (is (nil? (as/api-url nil "MGI:1")))
  (is (= "https://www.alliancegenome.org/gene/HGNC:11998" (as/gene-url "HGNC:11998"))))

(deftest parsing
  (is (= {:curie "HGNC:11998"
          :description "Enables several functions, including DNA binding activity."
          :synonyms ["LFS1" "TRP53"]
          :gene-type "protein_coding_gene"}
         (as/parse-gene tp53-response "HGNC:11998")))
  (testing "missing fields give nil and no synonyms"
    (is (= {:curie "X:1" :description nil :synonyms [] :gene-type nil}
           (as/parse-gene {:gene {}} "X:1")))))

(deftest stale-responses
  (run-test-sync
   (rf/dispatch [::seed-db {:report {:key [:alliancetestmine "Gene" "2"]}}])
   (testing "responses for an earlier report are dropped"
     (rf/dispatch [::as/success [:alliancetestmine "Gene" "1"] "HGNC:11998" tp53-response])
     (rf/dispatch [::as/not-found [:alliancetestmine "Gene" "1"]])
     (rf/dispatch [::as/failure [:alliancetestmine "Gene" "1"] "request failed"])
     (is (= {:key [:alliancetestmine "Gene" "2"]} (:report @app-db))))
   (testing "responses for the current report are stored"
     (rf/dispatch [::as/success [:alliancetestmine "Gene" "2"] "HGNC:11998" tp53-response])
     (is (= :done (:status @(rf/subscribe [::as/block]))))
     (is (= "protein_coding_gene" (:gene-type @(rf/subscribe [::as/block])))))))

(deftest rows-failure
  (run-test-sync
   (let [key [:alliancetestmine "Gene" "2"]]
     (rf/dispatch [::seed-db {:report {:key key}}])
     (rf/dispatch [::as/rows-failure key {:status 500}])
     (is (= {:status :error :message "HTTP 500"} @(rf/subscribe [::as/block])))
     (rf/dispatch [::as/rows-failure key {}])
     (is (= {:status :error :message "request failed"} @(rf/subscribe [::as/block]))))))

(deftest outcomes
  (run-test-sync
   (let [key [:alliancetestmine "Gene" "2"]]
     (rf/dispatch [::seed-db {:report {:key key}}])
     (rf/dispatch [::as/not-found key])
     (is (= {:status :not-found} @(rf/subscribe [::as/block])))
     (rf/dispatch [::as/failure key "HTTP 500"])
     (is (= {:status :error :message "HTTP 500"} @(rf/subscribe [::as/block]))))))

(deftest observed-mod-mine-rows
  ;; Gene.primaryIdentifier, Gene.organism.shortName, Gene.organism.taxonId as
  ;; read from the production mines.
  (testing "WormMine"
    (is (= "WB:WBGene00000001" (as/curie-from-rows {:results [["WBGene00000001" "C. elegans" "6239"]]})))
    (is (nil? (as/curie-from-rows {:results [["110292" "D. rerio" "7955"]]})) "Entrez id")
    (is (nil? (as/curie-from-rows {:results [["Cang_2012_03_13_00001.g1" "C. angaria" "860376"]]})))
    (is (nil? (as/curie-from-rows {:results [["WBGene00026000" "C. briggsae" "6238"]]}))
        "a WBGene id of another nematode is not an Alliance gene"))
  (testing "FlyMine"
    (is (= "FB:FBgn0000001" (as/curie-from-rows {:results [["FBgn0000001" "D. melanogaster" "7227"]]})))
    (is (nil? (as/curie-from-rows {:results [["113563677" "D. erecta" "7220"]]}))))
  (testing "YeastMine"
    (is (= "SGD:S000000001" (as/curie-from-rows {:results [["S000000001" "S. cerevisiae" "4932"]]})))
    (is (nil? (as/curie-from-rows {:results [["L000003336" "S. cerevisiae" "4932"]]})) "legacy id")
    (is (nil? (as/curie-from-rows {:results [["AFLA_000690" "A. flavus NRRL3357" "332952"]]}))))
  (testing "a bare accession of the wrong species is not mapped"
    (is (nil? (to-alliance-curie "FBgn0000001" "C. elegans")))
    (is (nil? (to-alliance-curie "S000000001" "D. melanogaster")))))
