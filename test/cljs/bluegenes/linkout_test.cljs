(ns bluegenes.linkout-test
  (:require [cljs.test :refer-macros [deftest is testing]]
            [clojure.string :as str]
            [bluegenes.pages.results.linkout :as linkout]))

(def genes
  [{:id "HGNC:1" :symbol "TP53" :organism "H. sapiens"}
   {:id "HGNC:2" :symbol "BRCA1" :organism "H. sapiens"}
   {:id "MGI:1" :symbol "Trp53" :organism "M. musculus"}
   {:id "HGNC:3" :symbol nil :organism "H. sapiens"}
   {:id "HGNC:4" :symbol "TP53" :organism "H. sapiens"}])

(deftest species-mapping
  (is (= "9606" (:taxon (linkout/species-of "H. sapiens"))))
  (is (= "mmusculus" (:gprofiler (linkout/species-of "Mus musculus"))))
  (is (= "4932" (:taxon (linkout/species-of " s. cerevisiae "))))
  (is (= 7 (count linkout/species)))
  (is (nil? (linkout/species-of "A. thaliana")))
  (is (nil? (linkout/species-of nil))))

(deftest genes-queries
  (is (= {:from "Gene"
          :select ["Gene.primaryIdentifier" "Gene.symbol" "Gene.organism.shortName"]
          :where [{:path "Gene" :op "IN" :value "My list"}]}
         (linkout/genes-query {:list "My list"})))
  (testing "results query keeps constraints and replaces the view"
    (let [q {:from "Gene" :select ["Gene.length"] :title "t"
             :where [{:path "Gene.length" :op ">" :value "5"}]
             :constraintLogic "A"}]
      (is (= {:from "Gene" :select linkout/gene-paths
              :where (:where q) :constraintLogic "A"}
             (linkout/genes-query {:query q}))))))

(deftest rows-and-symbols
  (let [parsed (linkout/parse-rows [["HGNC:1" "TP53" "H. sapiens"] ["HGNC:3" " " "H. sapiens"] ["X" nil nil]])]
    (is (= {:id "HGNC:1" :symbol "TP53" :organism "H. sapiens"} (first parsed)))
    (is (nil? (:symbol (second parsed))))
    (is (nil? (:organism (nth parsed 2)))))
  (is (= ["TP53" "BRCA1" "Trp53"] (linkout/symbols genes)))
  (is (= 1 (linkout/without-symbol-count genes)))
  (is (= ["H. sapiens" "M. musculus"] (linkout/organisms genes)))
  (is (= 4 (count (linkout/genes-for genes "H. sapiens"))))
  (is (= 5 (count (linkout/genes-for genes nil)))))

(deftest cap
  (is (not (linkout/too-many? 5000)))
  (is (linkout/too-many? 5001)))

(deftest service-urls
  (let [human (linkout/species-of "H. sapiens")]
    (is (= "https://biit.cs.ut.ee/gprofiler/gost?organism=hsapiens&query=TP53+BRCA1"
           (linkout/gprofiler-url human ["TP53" "BRCA1"])))
    (is (= "https://string-db.org/cgi/network?species=9606&identifiers=TP53%0dBRCA1"
           (linkout/string-url human ["TP53" "BRCA1"])))
    (testing "symbols are encoded"
      (is (str/ends-with? (linkout/gprofiler-url human ["a b" "c&d"]) "query=a%20b+c%26d")))
    (is (= {:action "https://maayanlab.cloud/Enrichr/enrich"
            :fields {"list" "TP53\nBRCA1" "description" "d"}}
           (linkout/enrichr-form ["TP53" "BRCA1"] "d")))))

(deftest gmt
  (is (= "My list\tdesc\tTP53\tBRCA1\n" (linkout/gmt-text "My list" "desc" ["TP53" "BRCA1"])))
  (testing "tabs and newlines in names are flattened"
    (is (= "a b\tc d\tX\n" (linkout/gmt-text "a\tb" "c\nd" ["X"]))))
  (is (= "L from AllianceMine, 2 genes, H. sapiens"
         (linkout/gmt-description {:title "L" :mine "AllianceMine" :gene-count 2 :organism "H. sapiens"})))
  (is (= "L from M, 2 genes"
         (linkout/gmt-description {:title "L" :mine "M" :gene-count 2})))
  (is (= "My_list.gmt" (linkout/gmt-file-name "My list")))
  (is (= "genes.gmt" (linkout/gmt-file-name nil))))

(deftest notices
  (is (nil? (linkout/organism-notice ["H. sapiens"])))
  (is (str/includes? (linkout/organism-notice ["H. sapiens" "M. musculus"]) "2 organisms"))
  (is (str/includes? (linkout/third-party-notice :enrichr 12) "12 gene symbols to Enrichr"))
  (is (str/includes? (linkout/third-party-notice :string 3) "string-db.org")))

(deftest action-states
  (let [human (linkout/species-of "H. sapiens")]
    (is (:enabled? (linkout/action-state :gprofiler human ["TP53"])))
    (is (:enabled? (linkout/action-state :enrichr nil ["TP53"])))
    (is (not (:enabled? (linkout/action-state :string nil ["TP53"]))))
    (is (not (:enabled? (linkout/action-state :enrichr human []))))
    (testing "a link past the length limit is refused, Enrichr is a form post"
      (let [many (mapv #(str "GENE" %) (range 2000))]
        (is (not (:enabled? (linkout/action-state :gprofiler human many))))
        (is (:enabled? (linkout/action-state :enrichr human many)))))))
