(ns bluegenes.track-export-test
  (:require [cljs.test :refer-macros [deftest is testing use-fixtures]]
            [clojure.string :as str]
            [bluegenes.test-utils :as utils]
            [bluegenes.pages.results.track-export :as te]))

(use-fixtures :each utils/fixtures)

(def gene {:id "HGNC:1" :symbol "ABC" :organism "H. sapiens" :chromosome "chr1"
           :start 1000 :end 2000 :strand "+"})

(deftest flank-clamp
  (is (= 0 (te/clamp-flank -5)))
  (is (= 0 (te/clamp-flank "abc")))
  (is (= 0 (te/clamp-flank nil)))
  (is (= 250 (te/clamp-flank "250")))
  (is (= 100000 (te/clamp-flank 250000)))
  (is (= 12 (te/clamp-flank 12.9))))

(deftest flank-arithmetic
  (is (= [900 2100] (te/flank-span 1000 2000 100)))
  (testing "start is clamped at 1"
    (is (= [1 2500] (te/flank-span 50 2000 500)))
    (is (= [1 1100] (te/flank-span 1 1000 100)))
    (is (= [1 1000] (te/flank-span 1 1000 0)))))

(deftest strands
  (is (= "+" (te/strand-symbol 1)))
  (is (= "+" (te/strand-symbol "1")))
  (is (= "-" (te/strand-symbol "-1")))
  (is (= "." (te/strand-symbol "0")))
  (is (= "." (te/strand-symbol nil))))

(deftest rows-to-genes
  (is (= gene (te/row->gene ["HGNC:1" "ABC" "H. sapiens" "chr1" 1000 2000 1])))
  (testing "numeric strings are read"
    (is (= 1000 (:start (te/row->gene ["a" "b" "o" "chr1" "1000" "2000" "1"])))))
  (testing "genes without a location are dropped"
    (is (nil? (te/row->gene ["a" "b" "o" nil 1 2 1])))
    (is (nil? (te/row->gene ["a" "b" "o" "chr1" nil 2 1])))))

(deftest bed-lines
  (testing "0-based start, name is the symbol"
    (is (= "chr1\t999\t2000\tABC\t0\t+" (te/bed-line 0 gene))))
  (testing "flank widens both sides"
    (is (= "chr1\t899\t2100\tABC\t0\t+" (te/bed-line 100 gene))))
  (testing "flank clamps at BED start 0"
    (is (= "chr1\t0\t7000\tABC\t0\t+" (te/bed-line 5000 (assoc gene :start 50 :end 2000 :strand "+")))))
  (testing "identifier when the symbol is blank"
    (is (= "chr1\t999\t2000\tHGNC:1\t0\t-"
           (te/bed-line 0 (assoc gene :symbol "" :strand "-"))))))

(deftest bed-files
  (let [text (te/bed-file {:title "My list" :assembly "GRCh38" :flank 0 :genes [gene]})
        lines (str/split-lines text)]
    (is (= 2 (count lines)))
    (is (= "track name=\"My_list\" description=\"My_list GRCh38\" db=GRCh38" (first lines)))
    (is (= "chr1\t999\t2000\tABC\t0\t+" (second lines)))
    (is (str/ends-with? text "\n")))
  (testing "no db without an assembly label"
    (is (not (str/includes? (te/bed-header "x" "") "db=")))))

(deftest gff3-files
  (let [lines (str/split-lines (te/gff3-file {:assembly "GRCh38" :flank 100 :genes [gene]}))]
    (is (= "##gff-version 3" (first lines)))
    (is (= "##genome-build BlueGenes GRCh38" (second lines)))
    (is (= "chr1\tBlueGenes\tgene\t900\t2100\t.\t+\t.\tID=HGNC%3A1;Name=ABC;Alias=HGNC%3A1"
           (nth lines 2))))
  (testing "no genome-build without an assembly label"
    (is (= 2 (count (str/split-lines (te/gff3-file {:assembly "" :flank 0 :genes [gene]})))))))

(deftest grouping-and-names
  (let [genes [gene (assoc gene :organism "M. musculus") (assoc gene :id "x")]
        groups (te/by-organism genes)]
    (is (= ["H. sapiens" "M. musculus"] (keys groups)))
    (is (= 2 (count (get groups "H. sapiens")))))
  (is (= "My_list.bed" (te/file-name {:label "My list" :organism "H. sapiens" :format "bed"
                                      :flank 0 :multiple? false})))
  (is (= "My_list_H._sapiens_flank500.gff3"
         (te/file-name {:label "My list" :organism "H. sapiens" :format "gff3"
                        :flank 500 :multiple? true}))))

(deftest server-export
  (is (te/server-eligible? 0 ""))
  (is (te/server-eligible? 0 nil))
  (is (not (te/server-eligible? 10 "")))
  (is (not (te/server-eligible? 0 "GRCh38")))
  (let [q (te/server-query (te/base-query {:kind :list :name "L"}) "H. sapiens")]
    (is (= ["Gene.primaryIdentifier"] (:select q)))
    (is (= [{:path "Gene" :op "IN" :value "L"}
            {:path te/organism-path :op "=" :value "H. sapiens"}]
           (:where q))))
  (is (= "chr1\t1\t2" (te/usable-server-text "chr1\t1\t2")))
  (is (nil? (te/usable-server-text "  ")))
  (is (nil? (te/usable-server-text {:status 400}))))

(deftest sources
  (let [list {:name "L" :title "My list" :type "Gene"}]
    (is (= {:kind :list :name "L" :label "My list"} (te/export-source list nil :list)))
    (is (nil? (te/export-source (assoc list :type "Protein") nil :list)))
    (is (= :query (:kind (te/export-source nil {:from "Gene" :where []} :query))))
    (is (= :query (:kind (te/export-source nil {:select ["Gene.symbol"]} :template))))
    (is (nil? (te/export-source nil {:from "Protein"} :query)))
    (is (nil? (te/export-source nil nil :query))))
  (testing "results query keeps constraints and replaces the columns"
    (let [q (te/base-query {:kind :query
                            :query {:from "Gene" :select ["Gene.symbol"] :orderBy [1]
                                    :where [{:path "Gene.symbol" :op "=" :value "x"}]}})]
      (is (= te/row-paths (:select q)))
      (is (nil? (:orderBy q)))
      (is (= 1 (count (:where q)))))))

(deftest jbrowse-links
  (is (nil? (te/jbrowse-link nil "" 0 gene)))
  (is (= "http://jb/?loc=chr1%3A900..2100&assembly=GRCh38"
         (te/jbrowse-link "http://jb/" "GRCh38" 100 gene)))
  (is (= "http://jb/?a=1&loc=chr1%3A1000..2000"
         (te/jbrowse-link "http://jb/?a=1" "" 0 gene))))
