(ns bluegenes.track-export-test
  (:require [cljs.test :refer-macros [deftest is are testing use-fixtures]]
            [clojure.string :as str]
            [re-frame.core :as rf]
            [re-frame.db :as rf-db]
            [day8.re-frame.test :refer-macros [run-test-sync]]
            [imcljs.fetch :as fetch]
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
  (is (= (assoc gene :length nil) (te/row->gene ["HGNC:1" "ABC" "H. sapiens" "chr1" 1000 2000 1])))
  (is (= 46709983 (:length (te/row->gene ["a" "b" "o" "13" 1 2 "1" 46709983]))))
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

(deftest flank-end-and-types
  (testing "end is clamped at a known chromosome length"
    (is (= [900 5000] (te/flank-span 1000 4900 100 5000)))
    (is (= [900 5100] (te/flank-span 1000 4900 100 nil)))
    (is (= [900 5100] (te/flank-span 1000 4900 100 4000))))
  (testing "a bad flank is zero, not NaN"
    (is (= [1000 2000] (te/flank-span 1000 2000 "abc")))
    (is (= [900 2100] (te/flank-span 1000 2000 "100"))))
  (is (= "13\t999\t2000\tABC\t0\t+" (te/bed-line "abc" (assoc gene :chromosome "13"))))
  (is (= "chr1\t0\t1500\tABC\t0\t+" (te/bed-line 5000 (assoc gene :end 1400 :length 1500)))))

(deftest chromosome-names
  (are [style in out] (= out (te/chrom-name style in))
    "mine" "13" "13"
    "ucsc" "13" "chr13"
    "ucsc" "IV" "chrIV"
    "ucsc" "chrVI" "chrVI"
    "ucsc" "Chr1L" "chr1L"
    "ucsc" "MT" "chrM"
    "ucsc" "MtDNA" "chrM"
    "ensembl" "chrVI" "VI"
    "ensembl" "Chr01" "01"
    "ensembl" "chrM" "MT"
    "ensembl" "13" "13"))

(deftest sorting
  (is (= ["chr1" "chr2" "chr10" "chrX"]
         (map :chromosome (te/sort-genes (map #(assoc gene :chromosome %) ["chrX" "chr10" "chr2" "chr1"])))))
  (is (= ["1L" "2L" "10L"]
         (map :chromosome (te/sort-genes (map #(assoc gene :chromosome %) ["10L" "1L" "2L"])))))
  (is (= [5 20]
         (map :start (te/sort-genes [(assoc gene :start 20 :end 30) (assoc gene :start 5 :end 6)])))))

(deftest gff3-attributes
  (let [line (te/gff3-line 0 (assoc gene :symbol "a;b c" :id "HGNC:1"))
        attrs (last (str/split line #"\t"))]
    (is (= "ID=HGNC:1;Name=a%3Bb c;Alias=HGNC:1;Dbxref=HGNC:1;Note=H. sapiens" attrs)))
  (testing "bed names carry no whitespace"
    (is (= "chr1\t999\t2000\ta_b\t0\t+" (te/bed-line 0 (assoc gene :symbol "a b"))))))

(deftest gff3-files
  (let [lines (str/split-lines (te/gff3-file {:assembly "GRCh38" :flank 100 :genes [gene]}))]
    (is (= "##gff-version 3" (first lines)))
    (is (= "##genome-build BlueGenes GRCh38" (second lines)))
    (is (= "chr1\tBlueGenes\tgene\t900\t2100\t.\t+\t.\tID=HGNC:1;Name=ABC;Alias=HGNC:1;Dbxref=HGNC:1;Note=H. sapiens"
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

(deftest assembly-labels
  (is (= {:default "GRCh38" :by-organism {}} (te/parse-assemblies "GRCh38")))
  (is (= {:default nil :by-organism {"H. sapiens" "GRCh38" "M. musculus" "GRCm39"}}
         (te/parse-assemblies "H. sapiens=GRCh38; M. musculus = GRCm39")))
  (is (= "GRCh38" (te/assembly-for (te/parse-assemblies "GRCh38") "M. musculus" false)))
  (is (nil? (te/assembly-for (te/parse-assemblies "GRCh38") "M. musculus" true)))
  (is (= "GRCm39" (te/assembly-for (te/parse-assemblies "M. musculus=GRCm39") "M. musculus" true))))

(def live-rows
  [["FB:FBgn0050169" "Brca2" "D. melanogaster" "2R" 24526172 24529581 "1" nil]
   ["HGNC:1101" "BRCA2" "H. sapiens" "13" 32315077 32400268 "1" nil]
   ["MGI:109337" "Brca2" "M. musculus" "5" 150445759 150493794 "1" nil]
   ["HGNC:99" "NOLOC" "H. sapiens" nil nil nil nil nil]])

(deftest outcome-from-live-rows
  (let [{:keys [genes files skipped-file message links]}
        (te/export-outcome {:format "bed" :flank 0 :assemblies "H. sapiens=GRCh38"
                            :chrom-style "ucsc" :label "L"}
                           live-rows)]
    (is (= 3 genes))
    (is (= 3 (count files)))
    (testing "assembly only in the file of its organism"
      (let [by-org (into {} (map (juxt :organism identity) files))]
        (is (str/includes? (:text (by-org "H. sapiens")) "db=GRCh38"))
        (is (not (str/includes? (:text (by-org "M. musculus")) "db=")))
        (is (str/includes? (:text (by-org "H. sapiens")) "chr13\t32315076\t32400268\tBRCA2"))))
    (testing "genes without a location are listed, not lost"
      (is (= "HGNC:99\n" (:text skipped-file)))
      (is (str/includes? message "1 without a location skipped")))
    (is (= 3 (count links)))))

(deftest bare-label-with-several-organisms
  (let [{:keys [files message]} (te/export-outcome {:format "gff3" :flank 0 :assemblies "GRCh38"
                                                    :chrom-style "mine" :label "L"}
                                                   live-rows)]
    (is (every? #(not (str/includes? (:text %) "##genome-build")) files))
    (is (str/includes? message "not applied"))))

(deftest outcome-row-cap
  (let [rows (vec (repeat (inc te/max-rows) ["a" "b" "H. sapiens" "1" 1 2 "1" nil]))
        {:keys [genes message]} (te/export-outcome {:format "bed" :flank 0 :assemblies ""
                                                    :chrom-style "mine" :label "L"}
                                                   rows)]
    (is (= te/max-rows genes))
    (is (str/includes? message "cut at the first 100000 genes"))))

(deftest joins
  (let [q (te/base-query {:kind :list :name "L"})]
    (is (= ["Gene.chromosome" "Gene.chromosomeLocation"] (:joins q))))
  (let [q (te/base-query {:kind :query :query {:from "Gene" :joins ["Gene.homologues"]}})]
    (is (= ["Gene.homologues" "Gene.chromosome" "Gene.chromosomeLocation"] (:joins q)))))

(def db-with-panel
  {:current-mine :default
   :mines {:default {:service {:root "http://localhost/mine"}}}
   :results {:track-export {:open? true :format "bed" :flank "abc" :assembly ""
                            :chrom-style "mine"}}})

(deftest download-events
  (run-test-sync
   (let [saved (atom nil)
         request (atom nil)]
     (rf/reg-event-db ::set-db (fn [_ _] db-with-panel))
     (rf/reg-fx :im-chan (fn [m] (reset! request m)))
     (rf/reg-fx ::te/save-files (fn [files] (reset! saved files)))
     (rf/dispatch [::set-db])
     (with-redefs [fetch/rows (utils/stub-fetch-fn nil)]
       (rf/dispatch [::te/download {:kind :list :name "L" :label "L"}]))
     (testing "options are taken once, a bad flank is zero"
       (is (true? (get-in @rf-db/app-db [:results :track-export :busy?])))
       (is (= 0 (get-in @rf-db/app-db [:results :track-export :flank])))
       (is (= [::te/rows-success {:format "bed" :flank 0 :assemblies ""
                                  :chrom-style "mine" :label "L"}]
              (:on-success @request))))
     (testing "inputs are locked while busy"
       (rf/dispatch [::te/set-field :format "gff3"])
       (is (= "bed" (get-in @rf-db/app-db [:results :track-export :format]))))
     (testing "later input changes do not change the export"
       (rf/dispatch (conj (:on-success @request) {:results live-rows}))
       (is (= 3 (count (get-in @rf-db/app-db [:results :track-export :files]))))
       (is (nil? @saved))
       (is (false? (get-in @rf-db/app-db [:results :track-export :busy?]))))
     (testing "one organism is saved at once"
       (rf/dispatch (conj (:on-success @request) {:results (take 1 live-rows)}))
       (is (= 1 (count @saved)))
       (is (str/starts-with? (:text (first @saved)) "track name="))))))

(deftest no-location-error
  (run-test-sync
   (rf/reg-event-db ::set-db (fn [_ _] db-with-panel))
   (rf/dispatch [::set-db])
   (rf/dispatch [::te/rows-success {:format "bed" :flank 0 :assemblies "" :chrom-style "mine" :label "L"}
                 {:results [["HGNC:99" "N" "H. sapiens" nil nil nil nil nil]]}])
   (is (= "None of the genes has a chromosome location."
          (get-in @rf-db/app-db [:results :track-export :error])))))

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
  (is (= "http://jb/?loc=chr1%3A900..1500&assembly=GRCh38"
         (te/jbrowse-link "http://jb/" "GRCh38" 100 (assoc gene :length 1500 :end 1400))))
  (is (= "http://jb/?loc=chr1%3A900..2100&assembly=GRCh38"
         (te/jbrowse-link "http://jb/" "GRCh38" 100 gene)))
  (is (= "http://jb/?a=1&loc=chr1%3A1000..2000"
         (te/jbrowse-link "http://jb/?a=1" "" 0 gene))))
