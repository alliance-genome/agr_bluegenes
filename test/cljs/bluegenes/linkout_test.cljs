(ns bluegenes.linkout-test
  (:require [cljs.test :refer-macros [deftest is testing]]
            [clojure.string :as str]
            [bluegenes.pages.results.linkout :as linkout]
            [imcljs.fetch :as fetch]
            [re-frame.core :as rf]
            [re-frame.db :as rf-db]
            [day8.re-frame.test :refer-macros [run-test-sync]]))

(def genes
  [{:id "HGNC:1" :symbol "TP53" :organism "H. sapiens"}
   {:id "HGNC:2" :symbol "BRCA1" :organism "H. sapiens"}
   {:id "MGI:1" :symbol "Trp53" :organism "M. musculus"}
   {:id "HGNC:3" :symbol nil :organism "H. sapiens"}
   {:id "HGNC:4" :symbol "TP53" :organism "H. sapiens"}])

;; Rows of AllianceMine, Gene.symbol IS NULL, S. cerevisiae.
(def yeast-rows
  [["S000002344_intein_encoding_region_127636_129000" nil nil "S. cerevisiae"]
   ["SGD:L000003336" nil "YCLX01W" "S. cerevisiae"]
   ["SGD:S000000035" nil "YAL037W" "S. cerevisiae"]])

(defn- db-with [state]
  {:results {:linkout state}
   :current-mine :alliance
   :mines {:alliance {:name "AllianceMine" :service {:root "r"}}}})

(deftest species-mapping
  (is (= "9606" (:taxon (linkout/species-of "H. sapiens"))))
  (is (= "mmusculus" (:gprofiler (linkout/species-of "Mus musculus"))))
  (is (= "4932" (:taxon (linkout/species-of " s. cerevisiae "))))
  (testing "S. pombe and X. tropicalis are supported"
    (is (= "spombe" (:gprofiler (linkout/species-of "S. pombe"))))
    (is (= "4896" (:taxon (linkout/species-of "Schizosaccharomyces pombe"))))
    (is (= "xtropicalis" (:gprofiler (linkout/species-of "X. tropicalis"))))
    (is (= "8364" (:taxon (linkout/species-of "X. tropicalis")))))
  (is (nil? (linkout/species-of "A. thaliana")))
  (is (nil? (linkout/species-of nil))))

(deftest genes-queries
  (is (= {:from "Gene"
          :select ["Gene.primaryIdentifier" "Gene.symbol" "Gene.secondaryIdentifier" "Gene.organism.shortName"]
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
  (let [parsed (linkout/parse-rows [["HGNC:1" "TP53" nil "H. sapiens"] ["HGNC:3" " " nil "H. sapiens"] ["X" nil nil nil]])]
    (is (= {:id "HGNC:1" :symbol "TP53" :secondary-id nil :organism "H. sapiens"} (first parsed)))
    (is (nil? (:symbol (second parsed))))
    (is (nil? (:organism (nth parsed 2)))))
  (is (= ["TP53" "BRCA1" "Trp53"] (linkout/symbols genes)))
  (is (= 1 (linkout/without-symbol-count genes)))
  (is (= ["H. sapiens" "M. musculus"] (linkout/organisms genes)))
  (is (= 4 (count (linkout/genes-for genes "H. sapiens"))))
  (is (= 5 (count (linkout/genes-for genes nil)))))

(deftest systematic-names
  (let [parsed (linkout/parse-rows (conj yeast-rows ["SGD:S1" "ACT1" "YFL039C" "S. cerevisiae"]))]
    (is (= ["YCLX01W" "YAL037W" "ACT1"] (linkout/symbols parsed)))
    (is (= 2 (linkout/systematic-count parsed)))
    (is (= 1 (linkout/without-symbol-count parsed)))))

(deftest whitespace-symbols
  (let [parsed (linkout/parse-rows [["a" "prokr1l.2 .L" nil "X. laevis"]
                                    ["b" "a\tb" "YAL037W" "S. cerevisiae"]
                                    ["c" "ok" "x\ny" "S. cerevisiae"]])]
    (is (nil? (:symbol (first parsed))))
    (is (= ["YAL037W" "ok"] (linkout/symbols parsed)))
    (is (= 1 (linkout/without-symbol-count parsed)))
    (is (= "S. cerevisiae" (:organism (second parsed))))))

(deftest cap
  (is (not (linkout/too-many? 5000)))
  (is (linkout/too-many? 5001))
  (let [human (linkout/species-of "H. sapiens")
        syms (mapv #(str "G" %) (range 5001))]
    (testing "the cap applies to every third-party service"
      (doseq [k [:gprofiler :enrichr :string]]
        (is (not (:enabled? (linkout/action-state k human syms))))
        (is (str/includes? (:reason (linkout/action-state k human syms)) "5000"))))
    (testing "5000 symbols still go to Enrichr and STRING"
      (is (:enabled? (linkout/action-state :enrichr human (subvec syms 0 5000))))
      (is (:enabled? (linkout/action-state :string human (subvec syms 0 5000)))))))

(deftest service-urls
  (let [human (linkout/species-of "H. sapiens")]
    (is (= "https://biit.cs.ut.ee/gprofiler/gost?organism=hsapiens&query=TP53+BRCA1"
           (linkout/gprofiler-url human ["TP53" "BRCA1"])))
    (is (= {:action "https://string-db.org/cgi/network"
            :fields {"species" "9606" "identifiers" "TP53\nBRCA1"}}
           (linkout/string-form human ["TP53" "BRCA1"])))
    (testing "symbols are encoded"
      (is (str/ends-with? (linkout/gprofiler-url human ["a b" "c&d"]) "query=a%20b+c%26d")))
    (is (= {:action "https://maayanlab.cloud/Enrichr/enrich"
            :fields {"list" "TP53\nBRCA1" "description" "d"}}
           (linkout/enrichr-form human ["TP53" "BRCA1"] "d")))))

(deftest enrichr-hosts
  (testing "each species posts to its own Enrichr site"
    (doseq [[organism host] {"H. sapiens" "Enrichr" "M. musculus" "Enrichr" "R. norvegicus" "Enrichr"
                             "D. rerio" "FishEnrichr" "D. melanogaster" "FlyEnrichr"
                             "C. elegans" "WormEnrichr" "S. cerevisiae" "YeastEnrichr"}]
      (is (= (str "https://maayanlab.cloud/" host "/enrich")
             (:action (linkout/enrichr-form (linkout/species-of organism) ["x"] "d"))))))
  (testing "Enrichr is off with no organism and for species without a site"
    (is (not (:enabled? (linkout/action-state :enrichr nil ["unc-22"]))))
    (let [pombe (linkout/species-of "S. pombe")
          state (linkout/action-state :enrichr pombe ["cdc2"])]
      (is (not (:enabled? state)))
      (is (str/includes? (:reason state) "S. pombe"))
      (is (:enabled? (linkout/action-state :gprofiler pombe ["cdc2"]))))))

(deftest gmt
  (is (= "My list\tdesc\tTP53\tBRCA1\n" (linkout/gmt-text "My list" "desc" ["TP53" "BRCA1"])))
  (testing "tabs and newlines in names are flattened"
    (is (= "a b\tc d\tX\n" (linkout/gmt-text "a\tb" "c\nd" ["X"]))))
  (is (= "L from AllianceMine, 2 genes, H. sapiens"
         (linkout/gmt-description {:title "L" :mine "AllianceMine" :gene-count 2 :organism "H. sapiens"})))
  (is (= "L from M, 2 genes"
         (linkout/gmt-description {:title "L" :mine "M" :gene-count 2})))
  (is (= "My_list.gmt" (linkout/gmt-file-name "My list")))
  (is (= "My_list_H._sapiens.gmt" (linkout/gmt-file-name "My list" "H. sapiens")))
  (is (= "genes.gmt" (linkout/gmt-file-name nil))))

(deftest gmt-organism-sets
  (let [base {:genes genes :title "L" :mine "M"}]
    (testing "all organisms gives one set per organism"
      (let [sets (linkout/gmt-sets (assoc base :organism nil))]
        (is (= 2 (count sets)))
        (is (= ["L|H. sapiens" "L|M. musculus"] (mapv :name sets)))
        (is (= [["TP53" "BRCA1"] ["Trp53"]] (mapv :syms sets)))))
    (testing "one organism gives one set named by the title"
      (let [sets (linkout/gmt-sets (assoc base :organism "M. musculus"))]
        (is (= [{:name "L" :description "L from M, 1 genes, M. musculus" :syms ["Trp53"]}] sets))))
    (testing "genes of one organism with none selected stay one set"
      (is (= 1 (count (linkout/gmt-sets {:genes (take 2 genes) :organism nil :title "L" :mine "M"})))))))

(deftest gmt-effect
  (let [db (db-with {:source {:list "L"} :genes genes :organism nil})
        {:keys [text filename]} (:bluegenes.pages.results.linkout/save-text (linkout/gmt-fx db))]
    (is (= 2 (count (str/split-lines text))))
    (is (= "L_all_organisms.gmt" filename))))

(deftest notices
  (is (nil? (linkout/organism-notice ["H. sapiens"])))
  (is (str/includes? (linkout/organism-notice ["H. sapiens" "M. musculus"]) "2 organisms"))
  (is (str/includes? (linkout/third-party-notice :string 3 {}) "string-db.org"))
  (testing "the Enrichr confirmation names the real host and the description"
    (let [fly (linkout/species-of "D. melanogaster")
          text (linkout/third-party-notice :enrichr 12 {:species fly :description "My list from AllianceMine, 12 genes"})]
      (is (str/includes? text "12 gene symbols to Enrichr"))
      (is (str/includes? text "maayanlab.cloud/FlyEnrichr"))
      (is (str/includes? text "My list from AllianceMine, 12 genes")))))

(deftest action-states
  (let [human (linkout/species-of "H. sapiens")]
    (is (:enabled? (linkout/action-state :gprofiler human ["TP53"])))
    (is (:enabled? (linkout/action-state :enrichr human ["TP53"])))
    (is (not (:enabled? (linkout/action-state :string nil ["TP53"]))))
    (is (not (:enabled? (linkout/action-state :enrichr human []))))
    (testing "an unknown organism is named in the reason"
      (is (str/includes? (:reason (linkout/action-state :string nil ["x"] "A. thaliana")) "A. thaliana")))
    (testing "a g:Profiler link past the length limit gives the computed limit; forms have none"
      (let [many (mapv #(str "GENE" %) (range 2000))
            state (linkout/action-state :gprofiler human many)
            capacity (linkout/gprofiler-capacity human many)]
        (is (not (:enabled? state)))
        (is (< 700 capacity 1400))
        (is (str/includes? (:reason state) (str "about " capacity)))
        (is (str/includes? (:reason state) "2000"))
        (is (:enabled? (linkout/action-state :enrichr human many)))
        (is (:enabled? (linkout/action-state :string human many)))))))

(deftest open-and-close
  (let [source {:list "L"}
        calls (atom [])]
    (with-redefs [fetch/rows (fn [& args] (swap! calls conj args) :chan)]
      (let [opened (linkout/toggle-fx (db-with nil) source)]
        (is (= :chan (get-in opened [:im-chan :chan])))
        (is (= source (get-in opened [:db :results :linkout :source])))
        (is (= 50001 (:size (nth (first @calls) 2))))
        (testing "a second click closes the panel and reads nothing"
          (let [closed (linkout/toggle-fx (:db opened) source)]
            (is (nil? (get-in closed [:db :results :linkout])))
            (is (nil? (:im-chan closed)))
            (is (= 1 (count @calls)))))))))

(deftest genes-loaded
  (let [source {:list "L"}
        db (db-with {:source source :loading? true})]
    (testing "the default organism is the most frequent one"
      (let [rows [["a" "Trp53" nil "M. musculus"] ["b" "TP53" nil "H. sapiens"] ["c" "BRCA1" nil "H. sapiens"]]
            state (get-in (linkout/genes-loaded db source {:results rows}) [:results :linkout])]
        (is (= "H. sapiens" (:organism state)))
        (is (false? (:loading? state)))
        (is (false? (:truncated? state)))))
    (testing "a result for another source is ignored"
      (is (= db (linkout/genes-loaded db {:list "other"} {:results [["a" "x" nil "H. sapiens"]]}))))
    (testing "rows past the read limit are dropped and flagged"
      (let [rows (mapv #(vector (str "id" %) (str "G" %) nil "H. sapiens") (range 50001))
            state (get-in (linkout/genes-loaded db source {:results rows}) [:results :linkout])]
        (is (:truncated? state))
        (is (= 50000 (count (:genes state))))))
    (testing "a list over the send cap is kept whole for GMT and copy"
      (let [rows (mapv #(vector (str "id" %) (str "G" %) nil "H. sapiens") (range 6000))
            state (get-in (linkout/genes-loaded db source {:results rows}) [:results :linkout])]
        (is (not (:truncated? state)))
        (is (= 6000 (count (linkout/symbols (:genes state)))))))))

(deftest send-effects
  (let [human (linkout/species-of "H. sapiens")
        db (db-with {:source {:list "My list"} :organism "H. sapiens"
                     :genes (linkout/parse-rows [["a" "TP53" nil "H. sapiens"] ["b" "BRCA1" nil "H. sapiens"]
                                                 ["c" "Trp53" nil "M. musculus"]])})
        no-organism (assoc-in db [:results :linkout :organism] nil)]
    (testing "Enrichr sends the description once, without the title in front"
      (let [fx (linkout/send-fx db :enrichr)
            form (:bluegenes.pages.results.linkout/post-form fx)]
        (is (= "My list from AllianceMine, 2 genes, H. sapiens" (get-in form [:fields "description"])))
        (is (= "TP53\nBRCA1" (get-in form [:fields "list"])))
        (is (= (:action (linkout/enrichr-form human [] "")) (:action form)))))
    (testing "STRING posts a form"
      (is (= "9606" (get-in (linkout/send-fx db :string) [:bluegenes.pages.results.linkout/post-form :fields "species"]))))
    (testing "a service that needs one organism does nothing for All"
      (is (nil? (linkout/send-fx no-organism :gprofiler)))
      (is (nil? (linkout/send-fx no-organism :enrichr))))))

(deftest copy-text
  (testing "no navigator.clipboard (http page) still reports a result and does not throw"
    (let [results (atom [])]
      (linkout/copy-text! nil "TP53" #(swap! results conj :ok) #(swap! results conj :fail))
      (is (= 1 (count @results)))))
  (testing "a clipboard that throws reports a failure"
    (let [results (atom [])]
      (linkout/copy-text! #js {:writeText (fn [_] (throw (js/Error. "denied")))}
                          "TP53" #(swap! results conj :ok) #(swap! results conj :fail))
      (is (= [:fail] @results)))))

(deftest reset-on-leave
  (run-test-sync
   (reset! rf-db/app-db (db-with {:source {:list "L"} :genes genes :organism "H. sapiens"}))
   (rf/dispatch-sync [::linkout/reset])
   (is (nil? (get-in @rf-db/app-db [:results :linkout])))))
