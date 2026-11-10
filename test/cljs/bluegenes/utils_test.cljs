(ns bluegenes.utils-test
  (:require [cljs.test :refer-macros [deftest is are testing]]
            [bluegenes.utils :as utils]
            [bluegenes.version :as version]
            [bluegenes.events.boot :refer [extends-hierarchy]]))

(deftest read-xml-query
  (testing "Missing fields are correctly nulled"
    (are [xml m] (= (utils/read-xml-query xml) m)
      "<query name=\"\" model=\"genomic\" view=\"Gene.secondaryIdentifier Gene.symbol Gene.organism.name Gene.primaryIdentifier\" longDescription=\"\"></query>"
      {:from "Gene",
       :select
       ["Gene.secondaryIdentifier"
        "Gene.symbol"
        "Gene.organism.name"
        "Gene.primaryIdentifier"],
       :orderBy [],
       :constraintLogic nil,
       :joins [],
       :where []}
      "<query name=\"\" model=\"genomic\" view=\"Gene.secondaryIdentifier Gene.symbol Gene.organism.name Gene.primaryIdentifier\" longDescription=\"\" sortOrder=\"Gene.symbol desc\"></query>"
      {:from "Gene",
       :select
       ["Gene.secondaryIdentifier"
        "Gene.symbol"
        "Gene.organism.name"
        "Gene.primaryIdentifier"],
       :orderBy [{:Gene.symbol "DESC"}],
       :constraintLogic nil,
       :joins [],
       :where []}
      "<query name=\"\" model=\"genomic\" view=\"Gene.secondaryIdentifier Gene.symbol Gene.organism.name Gene.primaryIdentifier\" longDescription=\"\" sortOrder=\"Gene.symbol desc\">
  <constraint path=\"Gene.symbol\" code=\"A\" op=\"CONTAINS\" value=\"ab\"/>
  <constraint path=\"Gene\" code=\"B\" op=\"IN\" value=\"PL FlyAtlas_brain_top\"/>
</query>"
      {:from "Gene",
       :select
       ["Gene.secondaryIdentifier"
        "Gene.symbol"
        "Gene.organism.name"
        "Gene.primaryIdentifier"],
       :orderBy [{:Gene.symbol "DESC"}],
       :constraintLogic nil,
       :joins [],
       :where
       [{:path "Gene.symbol", :code "A", :op "CONTAINS", :value "ab"}
        {:path "Gene", :code "B", :op "IN", :value "PL FlyAtlas_brain_top"}]}
      "<query name=\"\" model=\"genomic\" view=\"Gene.secondaryIdentifier Gene.symbol Gene.organism.name Gene.primaryIdentifier\" longDescription=\"\" sortOrder=\"Gene.symbol desc\" constraintLogic=\"A or B\">
  <constraint path=\"Gene.symbol\" code=\"A\" op=\"CONTAINS\" value=\"ab\"/>
  <constraint path=\"Gene\" code=\"B\" op=\"IN\" value=\"PL FlyAtlas_brain_top\"/>
</query>"
      {:from "Gene",
       :select
       ["Gene.secondaryIdentifier"
        "Gene.symbol"
        "Gene.organism.name"
        "Gene.primaryIdentifier"],
       :orderBy [{:Gene.symbol "DESC"}],
       :constraintLogic "A or B",
       :joins [],
       :where
       [{:path "Gene.symbol", :code "A", :op "CONTAINS", :value "ab"}
        {:path "Gene", :code "B", :op "IN", :value "PL FlyAtlas_brain_top"}]}))
  (testing "Can handle ONE OF constraints"
    (is (= (utils/read-xml-query "<query model=\"genomic\" view=\"Gene.primaryIdentifier Gene.secondaryIdentifier Gene.symbol Gene.name Gene.length Gene.organism.shortName\" constraintLogic=\"(A and B)\">)))
   <constraint path=\"Gene.symbol\" op=\"ONE OF\" code=\"B\"><value>CDPK1</value><value>CK1</value><value>ENO</value><value>CDPK4</value><value>ABRA</value><value>ERD2</value><value>CRK2</value></constraint>))
</query>")
           {:from "Gene"
            :select
            ["Gene.primaryIdentifier"
             "Gene.secondaryIdentifier"
             "Gene.symbol"
             "Gene.name"
             "Gene.length"
             "Gene.organism.shortName"],
            :orderBy []
            :constraintLogic "(A and B)",
            :joins [],
            :where
            [{:path "Gene.symbol",
              :values '("CDPK1" "CK1" "ENO" "CDPK4" "ABRA" "ERD2" "CRK2"),
              :op "ONE OF",
              :code "B"}]})))
  (testing "Can handle OUTER JOIN"
    (is (= (utils/read-xml-query "<query model=\"genomic\" view=\"Gene.symbol Gene.pathways.identifier\">))))
  <join path=\"Gene.pathways\" style=\"OUTER\"/>)
</query>")
           {:from "Gene",
            :select ["Gene.symbol" "Gene.pathways.identifier"],
            :orderBy [],
            :constraintLogic nil,
            :joins ["Gene.pathways"],
            :where []})))
  (testing "Can handle OUTER JOIN mixed with constraints"
    (is (= (utils/read-xml-query "<query name=\"\" model=\"genomic\" view=\"Gene.secondaryIdentifier Gene.symbol Gene.organism.name Gene.primaryIdentifier Gene.proteins.primaryIdentifier Gene.proteins.primaryAccession Gene.proteins.organism.name\" longDescription=\"\" sortOrder=\"Gene.symbol desc\" constraintLogic=\"A and B\">))))
  <constraint path=\"Gene.symbol\" code=\"A\" op=\"CONTAINS\" value=\"ab\"/>
  <join path=\"Gene.proteins\" style=\"OUTER\"/>
  <constraint path=\"Gene\" code=\"B\" op=\"IN\" value=\"PL FlyAtlas_brain_top\"/>)
</query>")
           {:from "Gene",
            :select
            ["Gene.secondaryIdentifier"
             "Gene.symbol"
             "Gene.organism.name"
             "Gene.primaryIdentifier"
             "Gene.proteins.primaryIdentifier"
             "Gene.proteins.primaryAccession"
             "Gene.proteins.organism.name"],
            :orderBy [{:Gene.symbol "DESC"}],
            :constraintLogic "A and B",
            :joins ["Gene.proteins"],
            :where
            [{:path "Gene.symbol", :code "A", :op "CONTAINS", :value "ab"}
             {:path "Gene", :code "B", :op "IN", :value "PL FlyAtlas_brain_top"}]})))
  (testing "Can handle longer paths"
    (is (= (utils/read-xml-query "<query name=\"\" model=\"genomic\" view=\"Gene.homologues.homologue.secondaryIdentifier Gene.homologues.homologue.symbol Gene.homologues.homologue.primaryIdentifier Gene.homologues.homologue.organism.name Gene.secondaryIdentifier Gene.symbol Gene.primaryIdentifier Gene.organism.name\" longDescription=\"\">)))
  <join path=\"Gene.homologues\" style=\"OUTER\"/>
  <constraint path=\"Gene.symbol\" op=\"CONTAINS\" value=\"ab\"/>))
</query>")
           {:from "Gene",
            :select
            ["Gene.homologues.homologue.secondaryIdentifier"
             "Gene.homologues.homologue.symbol"
             "Gene.homologues.homologue.primaryIdentifier"
             "Gene.homologues.homologue.organism.name"
             "Gene.secondaryIdentifier"
             "Gene.symbol"
             "Gene.primaryIdentifier"
             "Gene.organism.name"],
            :orderBy [],
            :constraintLogic nil,
            :joins ["Gene.homologues"],
            :where [{:path "Gene.symbol", :op "CONTAINS", :value "ab"}]}))))

(def paths-model
  "Mock model with fields. `Homologue.homologue` refers back to Gene, ORF is a
  Gene subclass, and PhenotypeAnnotation exists without a Gene collection to it
  (the FlyMine case)."
  {:BioEntity {:attributes {:primaryIdentifier {:type "java.lang.String"}}}
   :Organism {:attributes {:shortName {:type "java.lang.String"}}}
   :Gene {:extends ["BioEntity"]
          :attributes {:symbol {:type "java.lang.String"}}
          :references {:organism {:referencedType "Organism"}}
          :collections {:homologues {:referencedType "Homologue"}
                        :diseaseAnnotation {:referencedType "DiseaseAnnotation"}}}
   :ProteinCodingGene {:extends ["Gene"]
                       :attributes {:length {:type "java.lang.Integer"}}}
   :ORF {:extends ["ProteinCodingGene"]}
   :Homologue {:attributes {:isBestScore {:type "java.lang.Boolean"}}
               :references {:gene {:referencedType "Gene"}
                            :homologue {:referencedType "Gene"}}}
   :DiseaseAnnotation {:attributes {:qualifier {:type "java.lang.String"}}}
   :PhenotypeAnnotation {:attributes {:phenotypeStatement {:type "java.lang.String"}}}})

(deftest path-in-model
  (testing "class names"
    (is (utils/path-in-model? paths-model "Gene"))
    (is (not (utils/path-in-model? paths-model "NotInModel"))))
  (testing "valid paths"
    (are [path] (utils/path-in-model? paths-model path)
      "Gene.symbol"
      "Gene.organism"
      "Gene.organism.shortName"
      "Gene.homologues.homologue"
      "Gene.homologues.homologue.organism.shortName"
      "Gene.diseaseAnnotation.qualifier"))
  (testing "inherited fields resolve"
    (are [path] (utils/path-in-model? paths-model path)
      "Gene.primaryIdentifier"
      "ORF.homologues.homologue.symbol"
      "ORF.length"
      "Gene.homologues.homologue.primaryIdentifier"))
  (testing "a field of a subclass does not resolve from its superclass"
    (is (not (utils/path-in-model? paths-model "Gene.length")))
    (is (not (utils/path-in-model? paths-model "Gene.homologues.homologue.length"))))
  (testing "missing paths"
    (are [path] (not (utils/path-in-model? paths-model path))
      "Gene.alleles"
      "Gene.homologues.stringencyFilter"
      "Gene.symbol.length"
      "Gene.organism.shortName.x"
      "Gene.homologues.homologue.notThere"
      "NotInModel.symbol"
      ""))
  (testing "a class present with the collection absent (FlyMine phenotypes)"
    (is (utils/path-in-model? paths-model "PhenotypeAnnotation"))
    (is (not (utils/path-in-model? paths-model "Gene.phenotypeAnnotations")))
    (is (not (utils/path-in-model? paths-model "Gene.phenotypeAnnotations.phenotypeStatement"))))
  (testing "unmet-depends lists the failing entries in order"
    (is (= ["Gene.alleles" "Nope"]
           (utils/unmet-depends paths-model ["Gene.symbol" "Gene.alleles" "Gene" "Nope"])))
    (is (= [] (utils/unmet-depends paths-model nil)))
    (is (utils/depends-met? paths-model ["Gene" "Gene.homologues.homologue"]))))

(deftest suitable-entities-depends-paths
  (let [hier (extends-hierarchy paths-model)
        entities {:Gene {:class "Gene" :format "id" :value 1}}
        config (fn [depends] {:accepts ["id"] :classes ["Gene"] :depends depends})]
    (with-redefs [version/tool-api 2]
      (is (= entities
             (utils/suitable-entities paths-model hier entities
                                      (assoc (config ["Gene" "Gene.homologues.homologue" "Gene.diseaseAnnotation.qualifier"])
                                             :version 2)))
          "Class names and valid paths together")
      (is (nil? (utils/suitable-entities paths-model hier entities
                                         (assoc (config ["Gene.homologues.homologue" "Gene.alleles"])
                                                :version 2)))
          "One missing path hides the tool")
      (is (nil? (utils/suitable-entities paths-model hier entities
                                         (assoc (config ["Gene.phenotypeAnnotations"])
                                                :version 2)))
          "FlyMine case: class present, collection absent")
      (is (= entities
             (utils/suitable-entities paths-model hier entities
                                      (assoc (config []) :version 2)))
          "Empty depends"))))

(deftest suitable-entities
  ;; Mock for model classes. We only check that the key is present.
  (let [model {:BioEntity {} :Gene {:extends ["BioEntity"]} :Protein {:extends ["BioEntity"]}
               :ProteinCodingGene {:extends ["Gene"]} :ORF {:extends ["ProteinCodingGene"]}}
        hier (extends-hierarchy model)]
    (with-redefs [version/tool-api 1]
      (is (= (utils/suitable-entities
              model
              hier
              {:Gene {:class "Gene" :format "id" :value 1}
               :Protein {:class "Protein" :format "ids" :value [1 2 3]}}
              {:accepts ["id"]
               :classes ["Gene" "Protein"]})
             {:Gene {:class "Gene" :format "id" :value 1}})
          "Should remove invalid formats when accepts id")
      (is (= (utils/suitable-entities
              model
              hier
              {:Gene {:class "Gene" :format "id" :value 1}
               :Protein {:class "Protein" :format "ids" :value [1 2 3]}}
              {:accepts ["ids"]
               :classes ["Gene" "Protein"]})
             {:Protein {:class "Protein" :format "ids" :value [1 2 3]}})
          "Should remove invalid formats when accepts ids")
      (is (= (utils/suitable-entities
              model
              hier
              {:Gene {:class "Gene" :format "id" :value 1}
               :Protein {:class "Protein" :format "id" :value 2}}
              {:accepts ["id"]
               :classes ["Protein"]})
             {:Protein {:class "Protein" :format "id" :value 2}})
          "Should filter down to config's classes")
      (is (= (utils/suitable-entities
              model
              hier
              {:Gene {:class "Gene" :format "id" :value 1}
               :Protein {:class "Protein" :format "ids" :value [1 2 3]}}
              {:accepts ["id" "ids"]
               :classes ["*"]})
             {:Gene {:class "Gene" :format "id" :value 1}
              :Protein {:class "Protein" :format "ids" :value [1 2 3]}})
          "Should handle wildcard in config's classes")
      (is (= (utils/suitable-entities
              model
              hier
              {:Gene {:class "Gene" :format "id" :value 1}
               :Protein {:class "Protein" :format "ids" :value [1 2 3]}}
              {:accepts ["id" "ids"]
               :classes ["Gene" "Protein"]
               :depends ["Gene" "Protein"]})
             {:Gene {:class "Gene" :format "id" :value 1}
              :Protein {:class "Protein" :format "ids" :value [1 2 3]}})
          "Should handle depends")
      (testing "Handle subclasses correctly"
        (is (= (utils/suitable-entities
                model
                hier
                {:ORF {:class "ORF" :format "id" :value 1}}
                {:accepts ["id" "ids"]
                 :classes ["Protein" "Gene"]})
               {:Gene {:class "ORF" :format "id" :value 1}})
            "Should keep entities that are a subclass to one or more of classes, with the key set to the expected class")
        (is (= (utils/suitable-entities
                model
                hier
                {:ORF {:class "ORF" :format "id" :value 1}
                 :ProteinCodingGene {:class "ProteinCodingGene" :format "ids" :value [1 2 3]}}
                {:accepts ["id" "ids"]
                 :classes ["Protein" "Gene"]})
               {:Gene {:class "ProteinCodingGene" :format "ids" :value [1 2 3]}})
            "Should keep entities that are a subclass to one or more of classes, with the last entity for a superclass overriding")
        (is (= (utils/suitable-entities
                model
                hier
                {:ORF {:class "ORF" :format "id" :value 1}
                 :ProteinCodingGene {:class "ProteinCodingGene" :format "ids" :value [1 2 3]}
                 :Protein {:class "Protein" :format "ids" :value [1 2 3]}}
                {:accepts ["id" "ids"]
                 :classes ["Protein"]})
               {:Protein {:class "Protein" :format "ids" :value [1 2 3]}})
            "Should remove subclass entities that are not a subclass to one or more of classes"))
      (testing "Should return nil when no entities are valid"
        (are [entities config suitable]
             (= (utils/suitable-entities model hier entities config) suitable)

          {:Gene {:class "Gene" :format "id" :value 1}
           :Protein {:class "Protein" :format "id" :value 2}}
          {:accepts ["ids"]
           :classes ["Gene" "Protein"]}
          nil

          {:Gene {:class "Gene" :format "id" :value 1}
           :Protein {:class "Protein" :format "id" :value 2}}
          {:accepts ["id"]
           :classes ["OtherClass"]}
          nil

          {:Gene {:class "Gene" :format "id" :value 1}
           :Protein {:class "Protein" :format "id" :value 2}}
          {:accepts ["id"]
           :classes ["Gene" "Protein"]
           :depends ["NotInModel"]}
          nil

          {:Gene {:class "Gene" :format "id" :value 1}
           :Protein {:class "Protein" :format "id" :value 2}}
          {:accepts ["id"]
           :classes ["*"]
           :depends ["NotInModel"]}
          nil

          {:ORF {:class "ORF" :format "id" :value 1}
           :ProteinCodingGene {:class "ProteinCodingGene" :format "ids" :value [1 2 3]}}
          {:accepts ["id" "ids"]
           :classes ["Protein"]}
          nil))
      (is (= (utils/suitable-entities
              model
              hier
              {:Gene {:class "Gene" :format "id" :value 1}
               :Protein {:class "Protein" :format "id" :value 2}}
              {:accepts ["id"]
               :classes ["Gene" "Protein"]
               :version 2})
             nil)
          "Should return nil when tool version is above bluegenes"))
    (with-redefs [version/tool-api 2]
      (is (= (utils/suitable-entities
              model
              hier
              {:Gene {:class "Gene" :format "id" :value 1}
               :Protein {:class "Protein" :format "id" :value 2}}
              {:accepts ["id"]
               :classes ["Gene" "Protein"]
               :version 1})
             nil)
          "Should return nil when tool version is below bluegenes")
      (is (= (utils/suitable-entities
              model
              hier
              {:Gene {:class "Gene" :format "id" :value 1}
               :Protein {:class "Protein" :format "id" :value 2}}
              {:accepts ["id"]
               :classes ["Gene" "Protein"]})
             nil)
          "Should return nil when inferred tool version is below bluegenes")
      (is (= (utils/suitable-entities
              model
              hier
              {:Gene {:class "Gene" :format "id" :value 1}
               :Protein {:class "Protein" :format "id" :value 2}}
              {:accepts ["id"]
               :classes ["Gene" "Protein"]
               :version 2})
             {:Gene {:class "Gene" :format "id" :value 1}
              :Protein {:class "Protein" :format "id" :value 2}})
          "Should return entities when tool version is equal to bluegenes"))))

(deftest version-string->vec
  (is (= (utils/version-string->vec "\"4.2.0\"\n") [4 2 0])
      "Handles intermine version strings")
  (is (= (utils/version-string->vec "31\n") [31])
      "Handles web service version strings")
  (is (= (utils/version-string->vec "\"0.10.0\"\n") [0 10 0])
      "Handles double digits and zeros")
  (is (= (utils/version-string->vec "4.1.3") [4 1 3])
      "Handles handwritten version strings")
  (is (= (utils/version-string->vec "\"0.01\"\n") [0 1])
      "Handles leading zeros")
  (is (nil? (utils/version-string->vec ""))
      "Returns nil when no version found"))

(deftest compatible-version?
  (is (true? (utils/compatible-version? [4 2 0] [4 2 0]))
      "Returns true when identical arguments")
  (is (true? (utils/compatible-version? "\"4.2.0\"\n" "4.2.0"))
      "Handles string arguments")
  (is (true? (utils/compatible-version? "\"4.2.0\"\n" [4 2 0]))
      "Handles mixed arguments")
  (testing "Correctly handles differing versions"
    (are [reqv v res] (= (utils/compatible-version? reqv v) res)
      [4 2 0] [5 2 0] true
      [4 2 0] [3 2 0] false
      [4 2 0] [4 3 0] true
      [4 2 0] [4 1 0] false
      [4 2 1] [4 2 2] true
      [4 2 1] [4 2 0] false
      [4 2 0] [5 1 0] true
      [4 2 0] [3 3 0] false
      [4 2 0] [3 20 0] false
      [4 2 10] [4 2 9] false
      [4 2 10] [4 3 0] true
      [4 1 3] [4 2 0] true)))

(deftest highlight-substring
  (testing "Handles common cases and edge cases"
    (are [in out] (= (utils/highlight-substring in "rna") out)
      "miRNA Targets" [[:span "mi"] [:span {:class :text-highlight} "RNA"] [:span " Targets"]]
      "Rna Seq Results" [[:span {:class :text-highlight} "Rna"] [:span " Seq Results"]]
      "microRNA (miRNA)" [[:span "micro"] [:span {:class :text-highlight} "RNA"] [:span " (mi"] [:span {:class :text-highlight} "RNA"] [:span ")"]]
      "seq result rna" [[:span "seq result "] [:span {:class :text-highlight} "rna"]]
      "RnaRNA" [[:span {:class :text-highlight} "Rna"] [:span {:class :text-highlight} "RNA"]]
      "something unrelated" [[:span "something unrelated"]]))
  (is (= (utils/highlight-substring "something unrelated" "") [[:span "something unrelated"]])
      "Returns the string inside a span element in a sequential if substring is empty")
  (is (= (utils/highlight-substring "" "rna") [])
      "Returns an empty sequential if string is empty")
  (is (= (utils/highlight-substring "" "") [])
      "Returns an empty sequential if string and substring are empty"))

(deftest sanitize-html
  (testing "Keeps formatting markup"
    (is (= (utils/sanitize-html "Genes with <b>GO</b> term <i>x</i>")
           "Genes with <b>GO</b> term <i>x</i>")))
  (testing "Strips scripts and event handlers"
    (is (not (re-find #"(?i)<script" (utils/sanitize-html "a<script>alert(1)</script>b"))))
    (is (not (re-find #"(?i)onerror" (utils/sanitize-html "<img src=x onerror=alert(1)>"))))
    (is (not (re-find #"(?i)javascript:" (utils/sanitize-html "<a href=\"javascript:alert(1)\">x</a>")))))
  (is (nil? (utils/sanitize-html nil)) "Returns nil for nil input"))

(deftest resolve-class-name
  (let [classes {:Gene {:name "Gene"}
                 :MRNA {:name "MRNA"}
                 :ThreePrimeUTR {:name "ThreePrimeUTR"}}]
    (testing "Class names resolve ignoring case"
      (are [s res] (= (utils/resolve-class-name classes s) res)
        "gene" "Gene"
        "GENE" "Gene"
        "mrna" "MRNA"
        "MRNA" "MRNA"
        "threeprimeutr" "ThreePrimeUTR"
        "ThreePrimeUTR" "ThreePrimeUTR"))
    (testing "Unknown or blank class names return nil"
      (are [s] (nil? (utils/resolve-class-name classes s))
        "Protein"
        ""
        nil))
    (testing "Missing model returns nil"
      (is (nil? (utils/resolve-class-name nil "Gene"))))))
