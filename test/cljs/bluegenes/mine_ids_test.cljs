(ns bluegenes.mine-ids-test
  (:require [cljs.test :refer-macros [deftest is testing]]
            [bluegenes.mine-ids :as mine-ids]))

;; Identifier formats observed in the production mines: AllianceMine stores
;; CURIEs. WormMine stores bare WBGene ids for C. elegans, FB:FBgn, HGNC:, MGI:,
;; RGD: and ZFIN:ZDB-GENE ids for other Alliance species, and numbers for others.
;; FlyMine stores bare FBgn ids and HGNC: ids for human genes, and numbers for
;; other Drosophila. YeastMine stores bare S000 ids and locus tags for other fungi.

(deftest strip-prefix
  (testing "prefix of a non-numeric remainder"
    (is (= "WBGene00006759" (mine-ids/strip-prefix "WB:WBGene00006759")))
    (is (= "FBgn0003996" (mine-ids/strip-prefix "FB:FBgn0003996")))
    (is (= "S000001855" (mine-ids/strip-prefix "SGD:S000001855")))
    (is (= "ZDB-GENE-990415-270" (mine-ids/strip-prefix "ZFIN:ZDB-GENE-990415-270"))))
  (testing "numeric remainders stay, they would match NCBI ids of other genes"
    (is (nil? (mine-ids/strip-prefix "HGNC:11998")))
    (is (nil? (mine-ids/strip-prefix "MGI:98834")))
    (is (nil? (mine-ids/strip-prefix "RGD:3889"))))
  (testing "no prefix, or nothing after it"
    (is (nil? (mine-ids/strip-prefix "WBGene00006759")))
    (is (nil? (mine-ids/strip-prefix "WB:")))
    (is (nil? (mine-ids/strip-prefix "orf19.5007")))))

(deftest add-prefix
  (is (= "WB:WBGene00006759" (mine-ids/add-prefix "WBGene00006759")))
  (is (= "FB:FBgn0003996" (mine-ids/add-prefix "FBgn0003996")))
  (is (= "SGD:S000001855" (mine-ids/add-prefix "S000001855")))
  (is (= "ZFIN:ZDB-GENE-990415-270" (mine-ids/add-prefix "ZDB-GENE-990415-270")))
  (testing "ids of no known shape get no prefix"
    (is (nil? (mine-ids/add-prefix "113563677")))
    (is (nil? (mine-ids/add-prefix "CAGL0K12694g")))
    (is (nil? (mine-ids/add-prefix "Cang_2012_03_13_00001.g1")))
    (is (nil? (mine-ids/add-prefix "WB:WBGene00006759")))))

(deftest candidates
  (testing "AllianceMine to a MOD mine: CURIE first, bare second"
    (is (= ["WB:WBGene00006759" "WBGene00006759"] (mine-ids/candidates "WB:WBGene00006759")))
    (is (= ["FB:FBgn0003996" "FBgn0003996"] (mine-ids/candidates "FB:FBgn0003996")))
    (is (= ["SGD:S000001855" "S000001855"] (mine-ids/candidates "SGD:S000001855"))))
  (testing "a MOD mine to AllianceMine: bare first, CURIE second"
    (is (= ["WBGene00006759" "WB:WBGene00006759"] (mine-ids/candidates "WBGene00006759")))
    (is (= ["FBgn0003996" "FB:FBgn0003996"] (mine-ids/candidates "FBgn0003996")))
    (is (= ["S000001855" "SGD:S000001855"] (mine-ids/candidates "S000001855"))))
  (testing "CURIEs of species whose MOD mine keeps the prefix are tried as they are"
    (is (= ["HGNC:11998"] (mine-ids/candidates "HGNC:11998")))
    (is (= ["MGI:98834"] (mine-ids/candidates "MGI:98834")))
    (is (= ["RGD:3889"] (mine-ids/candidates "RGD:3889"))))
  (testing "numbers and locus tags have no other form"
    (is (= ["113563677"] (mine-ids/candidates "113563677")))
    (is (= ["CAGL0K12694g"] (mine-ids/candidates "CAGL0K12694g")))
    (is (= ["orf19.5007"] (mine-ids/candidates "orf19.5007"))))
  (testing "whitespace is trimmed, blank gives nothing"
    (is (= ["WBGene1" "WB:WBGene1"] (mine-ids/candidates "  WBGene1 ")))
    (is (= [] (mine-ids/candidates "")))
    (is (= [] (mine-ids/candidates "  ")))
    (is (= [] (mine-ids/candidates nil)))))
