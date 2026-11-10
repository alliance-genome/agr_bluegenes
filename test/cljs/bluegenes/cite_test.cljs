(ns bluegenes.cite-test
  (:require [cljs.test :refer-macros [deftest is testing use-fixtures]]
            [clojure.string :as str]
            [bluegenes.test-utils :as utils :refer [stub-fetch-fn]]
            [re-frame.core :as rf]
            [day8.re-frame.test :refer-macros [run-test-sync run-test-async wait-for]]
            [imcljs.fetch :as fetch]
            [bluegenes.effects]
            [bluegenes.cite :as cite]
            [bluegenes.pages.results.cite :as page]))

(use-fixtures :each utils/fixtures)

(def mine
  {:mine-name "Test Mine"
   :url "http://localhost:9999/alliancetestmine"
   :release "test"
   :intermine-version "5.1.0"
   :date "2026-11-10"})

(deftest constraints-in-words
  (is (= "Gene.organism.shortName equals \"M. musculus\""
         (cite/describe-constraint {:path "Gene.organism.shortName" :op "=" :value "M. musculus"})))
  (is (= "Gene is in the list \"my genes\""
         (cite/describe-constraint {:path "Gene" :op "IN" :value "my genes"})))
  (is (= "Gene.symbol is one of \"a\", \"b\""
         (cite/describe-constraint {:path "Gene.symbol" :op "ONE OF" :values ["a" "b"]})))
  (is (= "Gene.name is empty"
         (cite/describe-constraint {:path "Gene.name" :op "IS NULL"}))))

(deftest subclass-and-disabled-constraints
  (is (= "Gene is of type Protein"
         (cite/describe-constraint {:path "Gene" :type "Protein"})))
  (let [q {:from "Gene" :select ["Gene.symbol"]
           :where [{:path "Gene" :type "Protein"}
                   {:path "Gene.length" :op ">" :value "100" :switched "OFF"}
                   {:path "Gene.symbol" :op "=" :value "a" :switched "ON"}]}]
    (is (= (str "a query on the Gene class returning 1 column (Gene.symbol), with the constraints: "
                "Gene is of type Protein and Gene.symbol equals \"a\"")
           (cite/describe-query q))))
  (is (= "a query on the Gene class returning 1 column (Gene.symbol), with no constraints"
         (cite/describe-query {:from "Gene" :select ["Gene.symbol"]
                               :where [{:path "Gene.length" :op ">" :value "1" :switched "OFF"}]}))))

(deftest version-text-is-cleaned
  (is (= "test" (cite/clean-version "\"test\"\n")))
  (is (= "5.1.0" (cite/clean-version "5.1.0\n")))
  (is (= "5.1.0" (cite/clean-version "\"5.1.0\"")))
  (is (= "test" (cite/clean-version "test")))
  (is (nil? (cite/clean-version nil)))
  (is (nil? (cite/clean-version "\"\"\n")))
  (let [info (page/mine-info {:mines {:m {:name "M" :service {:root "http://m"}}}
                              :assets {:release-version {:m "\"test\"\n"}
                                       :intermine-version {:m "\"5.1.0\"\n"}}}
                             :m)]
    (is (= "test" (:release info)))
    (is (= "5.1.0" (:intermine-version info)))))

(deftest query-in-words
  (let [q {:from "Gene"
           :select ["Gene.symbol" "Gene.primaryIdentifier"]
           :where [{:path "Gene.organism.shortName" :op "=" :value "H. sapiens"}
                   {:path "Gene.length" :op ">" :value "100"}]
           :constraintLogic "A and B"}]
    (is (= (str "a query on the Gene class returning 2 columns (Gene.symbol, Gene.primaryIdentifier), "
                "with the constraints: Gene.organism.shortName equals \"H. sapiens\" and "
                "Gene.length is greater than \"100\" (constraint logic A and B)")
           (cite/describe-query q))))
  (is (= "a query on the Gene class returning 1 column (Gene.symbol), with no constraints"
         (cite/describe-query {:from "Gene" :select ["Gene.symbol"]}))))

(deftest methods-text
  (testing "list subject"
    (let [text (cite/methods-paragraph
                (assoc mine :subject {:kind :list :name "Brca set" :size 12 :type "Gene"}))]
      (is (str/includes? text "Data were retrieved from Test Mine (http://localhost:9999/alliancetestmine), release test and InterMine 5.1.0, using the list \"Brca set\" (12 Genes)."))
      (is (str/includes? text "Data were accessed on 2026-11-10."))
      (is (str/includes? text "Bioinformatics 28(23):3163-3165"))))
  (testing "query subject"
    (is (str/includes?
         (cite/methods-paragraph
          (assoc mine :subject {:kind :query
                                :query {:from "Gene" :select ["Gene.symbol"]}}))
         "using a query on the Gene class")))
  (testing "missing versions are left out"
    (let [text (cite/methods-paragraph
                (-> mine (dissoc :release :intermine-version)
                    (assoc :subject {:kind :list :name "L" :size 1 :type "Gene"})))]
      (is (str/includes? text "(http://localhost:9999/alliancetestmine), using the list \"L\" (1 Gene)."))
      (is (not (str/includes? text "release"))))))

(deftest bibtex-text
  (let [bib (cite/bibtex mine)]
    (testing "mine entry"
      (is (str/includes? bib "@misc{TestMine2026,"))
      (is (str/includes? bib "title = {Test Mine}"))
      (is (str/includes? bib "url = {http://localhost:9999/alliancetestmine}"))
      (is (str/includes? bib "version = {test}"))
      (is (str/includes? bib "urldate = {2026-11-10}")))
    (testing "papers"
      (is (str/includes? bib "@article{Smith2012,"))
      (is (str/includes? bib "doi = {10.1093/bioinformatics/bts577}"))
      (is (str/includes? bib "volume = {28}"))
      (is (str/includes? bib "pages = {3163--3165}"))
      (is (str/includes? bib "@article{Kalderimis2014,"))
      (is (str/includes? bib "doi = {10.1093/nar/gku301}"))
      (is (str/includes? bib "{\\v{S}}t{\\v{e}}p{\\'a}n, Radek")))
    (testing "three entries"
      (is (= 3 (count (re-seq #"(?m)^@" bib))))))
  (testing "no release gives no version field"
    (is (not (str/includes? (cite/bibtex-mine (dissoc mine :release)) "version")))))

(deftest bibtex-escaping
  (is (= "A \\& B 100\\% \\#1 x\\_y \\$" (cite/bibtex-escape "A & B 100% #1 x_y $")))
  (is (= "{\\v{S}}" (cite/bibtex-escape "Š"))))

(deftest ris-text
  (let [ris (cite/ris mine)]
    (testing "mine entry"
      (is (str/starts-with? ris "TY  - ELEC\nTI  - Test Mine\nUR  - http://localhost:9999/alliancetestmine\nET  - test\nY2  - 2026/11/10/"))
      (is (str/includes? ris "ER  - ")))
    (testing "papers"
      (is (str/includes? ris "TY  - JOUR"))
      (is (str/includes? ris "AU  - Smith, Richard N"))
      (is (str/includes? ris "AU  - Štěpán, Radek"))
      (is (str/includes? ris "SP  - 3163\nEP  - 3165"))
      (is (str/includes? ris "DO  - 10.1093/nar/gku301")))
    (testing "one terminator per entry"
      (is (= 3 (count (re-seq #"ER  - " ris))))))
  (testing "no release gives no ET line"
    (is (not (str/includes? (cite/ris-mine (dissoc mine :release)) "ET  -")))))

;;; Page namespace ;;;

(deftest subject-choice
  (is (= {:kind :list :name "L" :size 3 :type "Gene"}
         (page/subject {:intent :list :list {:name "L" :size 3 :type "Gene"} :query {:from "Gene"}})))
  (is (= {:kind :query :query {:from "Gene"}}
         (page/subject {:intent :query :query {:from "Gene"}}))
      "a query is described even when a list is around")
  (is (= {:kind :query :query {:from "Gene"}}
         (page/subject {:intent :list :list nil :query {:from "Gene"}}))))

(deftest missing-versions-lists-uncached
  (is (= [:release-version :intermine-version] (page/missing-versions {} :main)))
  (is (= [:intermine-version]
         (page/missing-versions {:assets {:release-version {:main "x"}}} :main)))
  (is (= [] (page/missing-versions
             {:assets {:release-version {:main "x"} :intermine-version {:main "y"}}} :main))))

(rf/reg-event-db ::seed (fn [_ [_ db]] db))

(def seeded-db
  {:current-mine :main
   :mines {:main {:name "Main Mine" :service {:root "http://main.example"}}}
   :results {:package {:source :main :intent :query}
             :query {:from "Gene" :select ["Gene.symbol"]}}})

(deftest toggle-skips-fetch-when-cached
  (run-test-sync
   (rf/dispatch [::seed (-> seeded-db
                            (assoc-in [:assets :release-version :main] "r1")
                            (assoc-in [:assets :intermine-version :main] "5.1.0"))])
   (with-redefs [fetch/version-release (fn [& _] (throw (js/Error. "refetched")))
                 fetch/version-intermine (fn [& _] (throw (js/Error. "refetched")))]
     (rf/dispatch [::page/toggle]))
   (let [state @(rf/subscribe [::page/state])
         texts @(rf/subscribe [::page/texts])]
     (is (true? (:open? state)))
     (is (str/includes? (:methods texts) "Main Mine (http://main.example), release r1 and InterMine 5.1.0"))
     (is (= [] (:versions-missing texts))))
   (rf/dispatch [::page/toggle])
   (is (false? (:open? @(rf/subscribe [::page/state]))))))

(deftest ensure-versions-fetches-and-caches
  (run-test-async
   (rf/dispatch-sync [::seed seeded-db])
   (let [orig-release fetch/version-release
         orig-intermine fetch/version-intermine]
     (set! fetch/version-release (stub-fetch-fn "test"))
     (set! fetch/version-intermine (stub-fetch-fn "5.1.0"))
     (swap! utils/stubbed-variables conj
            #(set! fetch/version-release orig-release)
            #(set! fetch/version-intermine orig-intermine))
     (rf/dispatch [::page/ensure-versions])
     (wait-for [::page/version-success]
       (wait-for [::page/version-success]
         (let [texts @(rf/subscribe [::page/texts])]
           (is (= [] (:versions-missing texts)))
           (is (str/includes? (:methods texts) "release test and InterMine 5.1.0"))
           (is (str/includes? (:bibtex texts) "version = {test}"))))))))
