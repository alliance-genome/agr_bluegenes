(ns bluegenes.ws.bundle-test
  (:require [clojure.test :refer [deftest is testing]]
            [clojure.string :as str]
            [bluegenes.ws.bundle :as bundle]
            [clj-http.client :as client]
            [cheshire.core :as json])
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

(defn- status-of [f]
  (try (f) nil (catch clojure.lang.ExceptionInfo e (:status (ex-data e)))))

(deftest mine-get-status-mapping
  (let [call (fn [status]
               (with-redefs [client/get (fn [_ _] {:status status :body "b"})]
                 (status-of #(#'bundle/mine-get "http://m/mine" "t" "/x" {}))))]
    (is (= 404 (call 404)))
    (is (= 401 (call 401)))
    (is (= 401 (call 403)))
    (is (= 400 (call 400)))
    (is (= 502 (call 500))))
  (testing "a thrown exception becomes 502"
    (with-redefs [client/get (fn [_ _] (throw (java.io.IOException. "down")))]
      (is (= 502 (status-of #(#'bundle/mine-get "http://m/mine" "t" "/x" {})))))))

(defn- list-body [& lists] (json/generate-string {:lists lists}))

(deftest fetch-list-checks
  (let [fetch (fn [res]
                (with-redefs [client/get (fn [_ _] res)]
                  (bundle/fetch-list "http://m/mine" "t" "L")))
        status (fn [res] (status-of #(fetch res)))]
    (testing "found"
      (is (= 3 (:size (fetch {:status 200 :body (list-body {:name "L" :type "Gene" :size 3})})))))
    (testing "missing list, by 404 or by empty result"
      (is (= 404 (status {:status 404 :body ""})))
      (is (= 404 (status {:status 200 :body (list-body)}))))
    (testing "non-Gene list"
      (is (= 400 (status {:status 200 :body (list-body {:name "L" :type "Protein" :size 3})}))))
    (testing "oversize list"
      (is (= 413 (status {:status 200 :body (list-body {:name "L" :type "Gene" :size (inc bundle/max-genes)})}))))))

(deftest fetch-rows-unwraps-and-truncates
  (let [rows (fn [n] (json/generate-string
                      {:results (for [i (range n)] [{:value (str "g" i)} "plain" nil])}))]
    (testing "cell maps are unwrapped"
      (with-redefs [client/get (fn [_ _] {:status 200 :body (rows 2)})]
        (is (= {:rows [["g0" "plain" nil] ["g1" "plain" nil]] :truncated? false}
               (bundle/fetch-rows "http://m/mine" "t" "<query/>")))))
    (testing "more than max-rows is cut"
      (with-redefs [client/get (fn [_ _] {:status 200 :body (rows (inc bundle/max-rows))})]
        (let [res (bundle/fetch-rows "http://m/mine" "t" "<query/>")]
          (is (= bundle/max-rows (count (:rows res))))
          (is (:truncated? res)))))))

(deftest optional-file-skipped-on-400
  (let [optional ["d.tsv" {:view ["A.b"] :list-path "A" :optional? true}]
        required ["g.tsv" {:view ["A.b"] :list-path "A"}]]
    (with-redefs [client/get (fn [_ _] {:status 400 :body ""})]
      (is (:skipped? (bundle/fetch-file "http://m/mine" "t" optional "L")))
      (is (= 400 (status-of #(bundle/fetch-file "http://m/mine" "t" required "L")))))
    (with-redefs [client/get (fn [_ _] {:status 500 :body ""})]
      (is (= 502 (status-of #(bundle/fetch-file "http://m/mine" "t" optional "L")))))))

(deftest build-bundle-without-annotation-classes
  (with-redefs [client/get
                (fn [url opts]
                  (cond
                    (str/ends-with? url "/lists") {:status 200 :body (list-body {:name "L" :type "Gene" :size 1})}
                    (str/includes? url "/version/") {:status 200 :body "x"}
                    (str/includes? (get-in opts [:query-params "query"]) "Annotation.") {:status 400 :body ""}
                    :else {:status 200 :body (json/generate-string {:results [["a"]]})}))]
    (let [bytes (bundle/build-bundle {:root "http://m/mine" :name "M"} "t" "L")
          zis (ZipInputStream. (ByteArrayInputStream. bytes))
          names (loop [acc []] (if-let [e (.getNextEntry zis)] (recur (conj acc (.getName e))) acc))]
      (is (= ["README.txt" "genes.tsv" "orthologs.tsv"] names)))))
