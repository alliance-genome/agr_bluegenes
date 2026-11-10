(ns bluegenes.ws.bundle-test
  (:require [clojure.test :refer [deftest is testing]]
            [clojure.string :as str]
            [bluegenes.ws.bundle :as bundle])
  (:import [java.io ByteArrayInputStream]
           [java.util.zip ZipInputStream]))

(def mines
  [{:root "https://alliancemine.example.org/alliancemine" :name "AllianceMine" :namespace "alliancemine"}
   {:root "http://localhost:9999/testmine/" :name "Test" :namespace "test"}])

(deftest find-mine-allowlist
  (testing "configured roots match"
    (is (= "AllianceMine" (:name (bundle/find-mine mines "https://alliancemine.example.org/alliancemine"))))
    (is (= "Test" (:name (bundle/find-mine mines "http://localhost:9999/testmine")))))
  (testing "trailing slashes are ignored on both sides"
    (is (= "AllianceMine" (:name (bundle/find-mine mines "https://alliancemine.example.org/alliancemine///"))))
    (is (= "Test" (:name (bundle/find-mine mines "http://localhost:9999/testmine/")))))
  (testing "anything else is rejected"
    (is (nil? (bundle/find-mine mines "http://evil.example.com/alliancemine")))
    (is (nil? (bundle/find-mine mines "https://alliancemine.example.org/alliancemine/service")))
    (is (nil? (bundle/find-mine mines "https://alliancemine.example.org")))
    (is (nil? (bundle/find-mine mines "https://alliancemine.example.org@evil.com/alliancemine")))
    (is (nil? (bundle/find-mine mines "https://alliancemine.example.org/alliancemine.evil")))
    (is (nil? (bundle/find-mine mines "")))
    (is (nil? (bundle/find-mine mines nil)))
    (is (nil? (bundle/find-mine mines {:root "x"})))))

(deftest tsv-output
  (is (= "a\tb\nx\t\ny z\t1\n"
         (bundle/rows->tsv ["a" "b"] [["x" nil] ["y\tz" 1]])))
  (is (= "a b" (bundle/tsv-cell "a\r\nb"))))

(deftest query-xml-escapes-list-name
  (let [xml (bundle/query-xml {:view ["Gene.symbol"] :list-path "Gene"} "a\"<b>&")]
    (is (str/includes? xml "value=\"a&quot;&lt;b&gt;&amp;\""))
    (is (str/includes? xml "view=\"Gene.symbol\""))))

(deftest query-xml-outer-joins
  (is (str/includes? (bundle/query-xml {:view ["A.b"] :list-path "A.s" :outer ["A.c"]} "l")
                     "<join path=\"A.c\" style=\"OUTER\"/>")))

(deftest zip-round-trip
  (let [zis (ZipInputStream. (ByteArrayInputStream. (bundle/zip-bytes [["a.tsv" "x\n"] ["README.txt" "r"]])))
        names (loop [acc []]
                (if-let [e (.getNextEntry zis)] (recur (conj acc (.getName e))) acc))]
    (is (= ["a.tsv" "README.txt"] names))))

(deftest readme-contents
  (let [text (bundle/readme-text {:mine-name "M" :root "http://m" :release "r1" :intermine "5.1.0"
                                  :list-name "L" :list-size 3 :date "2026-01-01"
                                  :entries [{:file "genes.tsv" :rows 3 :xml "<query/>"}]})]
    (is (str/includes? text "Mine: M"))
    (is (str/includes? text "InterMine version: 5.1.0"))
    (is (str/includes? text "genes.tsv (3 rows)"))
    (is (str/includes? text "<query/>"))))

(deftest query-xml-subclass
  (let [xml (bundle/query-xml {:view ["A.s.x"] :list-path "A.s" :subclass [["A.s" "Gene"]]} "l")]
    (is (< (.indexOf xml "<constraint path=\"A.s\" type=\"Gene\"/>")
           (.indexOf xml "op=\"IN\"")))))

(deftest annotation-queries-constrain-subject-to-gene
  (doseq [[file spec] bundle/files
          :when (str/includes? (first (:view spec)) "Annotation.subject")]
    (is (some #{[(:list-path spec) "Gene"]} (:subclass spec)) file)))

(deftest resolve-mine-with-backend-root
  (let [env {:bluegenes-default-service-root "https://public.example.org/mine"
             :bluegenes-backend-service-root "http://internal:8080/mine"
             :bluegenes-default-mine-name "Default"
             :bluegenes-default-namespace "default"
             :bluegenes-additional-mines [{:root "https://other.example.org/o" :name "Other" :namespace "o"}]}]
    (testing "public default maps to the backend root"
      (is (= "http://internal:8080/mine" (:root (bundle/resolve-mine env "https://public.example.org/mine/")))))
    (testing "additional mines and the backend root itself match"
      (is (= "Other" (:name (bundle/resolve-mine env "https://other.example.org/o"))))
      (is (= "Default" (:name (bundle/resolve-mine env "http://internal:8080/mine")))))
    (testing "unknown roots are rejected"
      (is (nil? (bundle/resolve-mine env "http://evil.example.com/mine"))))
    (testing "no backend root"
      (is (= "Default" (:name (bundle/resolve-mine (dissoc env :bluegenes-backend-service-root)
                                                   "https://public.example.org/mine")))))))
