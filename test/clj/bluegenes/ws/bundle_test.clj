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
      (is (:skipped? (bundle/fetch-file "http://m/mine" "t" nil optional "L")))
      (is (= 400 (status-of #(bundle/fetch-file "http://m/mine" "t" nil required "L")))))
    (with-redefs [client/get (fn [_ _] {:status 500 :body ""})]
      (is (= 502 (status-of #(bundle/fetch-file "http://m/mine" "t" nil optional "L")))))))

(deftest build-bundle-without-annotation-classes
  (with-redefs [client/get
                (fn [url opts]
                  (cond
                    (str/ends-with? url "/lists") {:status 200 :body (list-body {:name "L" :type "Gene" :size 1})}
                    (str/includes? url "/version/") {:status 200 :body "x"}
                    (str/ends-with? url "/model") {:status 404 :body ""}
                    (str/includes? (get-in opts [:query-params "query"]) "Annotation.") {:status 400 :body ""}
                    :else {:status 200 :body (json/generate-string {:results [["a"]]})}))]
    (let [bytes (bundle/build-bundle {:root "http://m/mine" :name "M"} "t" "L")
          zis (ZipInputStream. (ByteArrayInputStream. bytes))
          names (loop [acc []] (if-let [e (.getNextEntry zis)] (recur (conj acc (.getName e))) acc))]
      (is (= ["README.txt" "genes.tsv" "orthologs.tsv"] names)))))

;; Models are reduced from the production JSON. Gene extends SequenceFeature,
;; which carries the shared attributes, as in the MOD mines.
(defn- attrs [& ks] (into {} (map (fn [k] [k {}])) ks))

(defn- model [& {:keys [homologue disease phenotype]}]
  (cond-> {:SequenceFeature {:attributes (attrs :primaryIdentifier :symbol :name)
                             :references {:organism {:referencedType "Organism"}}}
           :Organism {:attributes (attrs :shortName)}
           :Gene {:extends ["SequenceFeature"]
                  :collections {:homologues {:referencedType "Homologue"}}}
           :Homologue {:attributes homologue
                       :references {:homologue {:referencedType "Gene"}}}}
    disease (assoc :DiseaseAnnotation
                   {:attributes (attrs :qualifier)
                    :references {:subject {:referencedType "Annotatable"}
                                 :ontologyTerm {:referencedType "OntologyTerm"}}
                    :collections {:evidence {:referencedType "OntologyEvidence"}}}
                   :Annotatable {:attributes {}}
                   :OntologyTerm {:attributes (attrs :identifier :name)}
                   :OntologyEvidence {:references {:code {:referencedType "EvidenceCode"}}
                                      :collections {:publications {:referencedType "Publication"}}}
                   :EvidenceCode {:attributes (attrs :code)}
                   :Publication {:attributes (attrs :pubMedId)})
    phenotype (assoc :PhenotypeAnnotation phenotype)))

(def all-homologue (attrs :type :algorithmsMatch :algorithmsAttempted :isBestScore :isBestReverseScore))

(def alliance-model
  (model :homologue all-homologue :disease true
         :phenotype {:attributes (attrs :phenotypeStatement)
                     :references {:subject {:referencedType "Annotatable"}
                                  :ontologyTerm {:referencedType "OntologyTerm"}}}))
(def worm-model (model :homologue (attrs :type)))
;; FlyMine: PhenotypeAnnotation exists but has no subject or ontologyTerm.
(def fly-model (model :homologue (attrs :type :isBestScore :algorithmsMatch :algorithmsAttempted :isBestReverseScore)
                      :disease true
                      :phenotype {:attributes (attrs :description)
                                  :references {:anatomyTerm {:referencedType "OntologyTerm"}}}))

(defn- spec-of [file] (second (first (filter #(= file (first %)) bundle/files))))

(deftest path-resolution-through-references-and-inheritance
  (is (bundle/path-resolves? alliance-model "Gene.symbol"))
  (is (bundle/path-resolves? alliance-model "Gene.homologues.homologue.organism.shortName"))
  (is (not (bundle/path-resolves? worm-model "Gene.homologues.isBestScore")))
  (is (not (bundle/path-resolves? fly-model "PhenotypeAnnotation.subject.symbol")))
  (testing "a retyped reference resolves only with the subclass"
    (let [p "DiseaseAnnotation.subject.symbol"]
      (is (not (bundle/path-resolves? alliance-model p)))
      (is (bundle/path-resolves? alliance-model p [["DiseaseAnnotation.subject" "Gene"]]))))
  (is (not (bundle/path-resolves? alliance-model "Nope.id")))
  (is (not (bundle/path-resolves? alliance-model "Gene.symbol.x"))))

(deftest adapt-spec-per-mine
  (testing "AllianceMine keeps every file whole"
    (doseq [[file spec] bundle/files]
      (let [{:keys [dropped missing]} (bundle/adapt-spec alliance-model spec)]
        (is (empty? dropped) file)
        (is (empty? missing) file))))
  (testing "WormMine: orthologs lose the algorithm columns, annotations are missing"
    (let [ortho (bundle/adapt-spec worm-model (spec-of "orthologs.tsv"))]
      (is (= ["Gene.homologues.algorithmsMatch" "Gene.homologues.algorithmsAttempted"
              "Gene.homologues.isBestScore" "Gene.homologues.isBestReverseScore"]
             (:dropped ortho)))
      (is (not (some #{"Gene.homologues.isBestScore"} (get-in ortho [:spec :view])))))
    (is (seq (:missing (bundle/adapt-spec worm-model (spec-of "disease_annotations.tsv")))))
    (is (seq (:missing (bundle/adapt-spec worm-model (spec-of "phenotype_annotations.tsv"))))))
  (testing "FlyMine: disease file stays, phenotype file is missing at path level"
    (is (empty? (:missing (bundle/adapt-spec fly-model (spec-of "disease_annotations.tsv")))))
    (is (some #{"PhenotypeAnnotation.subject.primaryIdentifier"}
              (:missing (bundle/adapt-spec fly-model (spec-of "phenotype_annotations.tsv"))))))
  (testing "an unreadable model changes nothing"
    (is (= {:spec (spec-of "orthologs.tsv") :dropped []}
           (bundle/adapt-spec nil (spec-of "orthologs.tsv"))))))

(deftest dropped-columns-take-their-outer-joins
  (let [no-evidence (update-in alliance-model [:DiseaseAnnotation :collections] dissoc :evidence)
        {:keys [spec dropped]} (bundle/adapt-spec no-evidence (spec-of "disease_annotations.tsv"))]
    (is (= 2 (count dropped)))
    (is (empty? (:outer spec)))
    (is (not (str/includes? (bundle/query-xml spec "L") "OUTER")))))

(defn- bundle-names [classes]
  (with-redefs [client/get
                (fn [url opts]
                  (cond
                    (str/ends-with? url "/lists") {:status 200 :body (list-body {:name "L" :type "Gene" :size 1})}
                    (str/includes? url "/version/") {:status 200 :body "x"}
                    (str/ends-with? url "/model") {:status 200 :body (json/generate-string {:model {:classes classes}})}
                    :else {:status 200 :body (json/generate-string {:results [["a"]]})}))]
    (let [zis (ZipInputStream. (ByteArrayInputStream. (bundle/build-bundle {:root "http://m/mine" :name "M"} "t" "L")))]
      (loop [acc []] (if-let [e (.getNextEntry zis)] (recur (conj acc (.getName e))) acc)))))

(deftest bundle-files-per-mine-model
  (is (= ["README.txt" "genes.tsv" "orthologs.tsv" "disease_annotations.tsv" "phenotype_annotations.tsv"]
         (bundle-names alliance-model)))
  (is (= ["README.txt" "genes.tsv" "orthologs.tsv"] (bundle-names worm-model)))
  (is (= ["README.txt" "genes.tsv" "orthologs.tsv" "disease_annotations.tsv"] (bundle-names fly-model))))

(deftest allowlist-accepts-all-configured-mine-roots
  (let [env {:bluegenes-default-service-root "https://www.alliancegenome.org/alliancemine"
             :bluegenes-default-mine-name "AllianceMine"
             :bluegenes-default-namespace "alliancemine"
             :bluegenes-additional-mines
             [{:root "https://wormmine.alliancegenome.org/wormmine" :name "WormMine" :namespace "wormmine"}
              {:root "https://flymine.alliancegenome.org/flymine" :name "FlyMine" :namespace "flymine"}
              {:root "https://yeastmine.alliancegenome.org/yeastmine" :name "YeastMine" :namespace "yeastmine"}]}]
    (doseq [[root nom] [["https://www.alliancegenome.org/alliancemine" "AllianceMine"]
                        ["https://wormmine.alliancegenome.org/wormmine" "WormMine"]
                        ["https://flymine.alliancegenome.org/flymine/" "FlyMine"]
                        ["https://yeastmine.alliancegenome.org/yeastmine" "YeastMine"]]]
      (is (= nom (:name (bundle/resolve-mine env root))) root))
    (is (nil? (bundle/resolve-mine env "https://wormmine.alliancegenome.org/flymine")))))
