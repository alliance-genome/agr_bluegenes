(ns bluegenes.home-templates-test
  (:require [cljs.test :refer-macros [deftest is testing]]
            [bluegenes.pages.home.subs :as subs]
            [bluegenes.pages.templates.helpers :as helpers]))

(def fly-templates
  {:Gene_GO {:name "Gene_GO" :title "Gene --> GO" :rank "2"}
   :Gene_Alleles {:name "Gene_Alleles" :title "Gene --> Alleles" :rank "1"}
   :Old {:name "Old" :title "Old" :rank "unranked"}})

(deftest mine-template-picks-test
  (testing "true takes the best ranked templates, unranked last"
    (is (= ["Gene_Alleles" "Gene_GO" "Old"]
           (map :name (subs/mine-template-picks true fly-templates)))))
  (testing "a vector picks templates by name in config order, skipping missing ones"
    (is (= ["Gene_GO" "Gene_Alleles"]
           (map :name (subs/mine-template-picks ["Gene_GO" "Missing" "Gene_Alleles"]
                                                fly-templates)))))
  (testing "true keeps at most 10"
    (is (= 10 (count (subs/mine-template-picks
                      true
                      (into {} (for [i (range 15)]
                                 [(keyword (str "T" i)) {:name (str "T" i) :rank (str i)}]))))))))

(def mines
  {:alliancemine {:name "AllianceMine"}
   :flymine {:name "FlyMine" :home-templates true}
   :wormmine {:name "WormMine" :home-templates true}
   :yeastmine {:name "YeastMine"}
   :mousemine {:name "MouseMine" :home-templates true}})

(def aspects
  {"im:aspect:YeastMine" [{:name "Y1"}]
   "im:aspect:Genome" [{:name "G1"}]
   "im:aspect:Downloads" [{:name "D1"}]})

(deftest template-tabs-test
  (let [tabs (subs/template-tabs aspects mines :alliancemine
                                 {:flymine fly-templates
                                  :wormmine {:W {:name "W1" :rank "1"}}
                                  :mousemine {}})]
    (testing "aspect tabs, then mine tabs by name, then the mine-named aspect last"
      (is (= ["Genome" "Downloads" "FlyMine" "WormMine" "YeastMine"]
             (map :label tabs))))
    (testing "mine tabs carry the mine for their links; aspect tabs do not"
      (is (= :flymine (:mine (nth tabs 2))))
      (is (nil? (:mine (first tabs)))))
    (testing "a mine with no templates gets no tab"
      (is (not-any? #{"MouseMine"} (map :label tabs))))))

(deftest template-tabs-skip-current-mine-test
  (testing "the current mine does not get a mine tab of its own"
    (is (not-any? #{"FlyMine"}
                  (map :label (subs/template-tabs {} mines :flymine
                                                  {:flymine fly-templates}))))))

(deftest mine-categories-last-test
  (testing "the templates page lists mine-named categories after the others"
    (is (= ["Downloads" "Genome" "YeastMine"]
           (helpers/mine-categories-last ["YeastMine" "FlyMine"]
                                         ["Downloads" "YeastMine" "Genome"])))))

(deftest template-sources-test
  (testing "the default mine first, then mines with :home-templates by name"
    (is (= [:alliancemine :flymine :mousemine :wormmine]
           (map :id (helpers/template-sources
                     {:alliancemine {:id :alliancemine :name "AllianceMine"}
                      :wormmine {:id :wormmine :name "WormMine" :home-templates true}
                      :yeastmine {:id :yeastmine :name "YeastMine"}
                      :flymine {:id :flymine :name "FlyMine" :home-templates true}
                      :mousemine {:id :mousemine :name "MouseMine" :home-templates true}}
                     :alliancemine))))))

(deftest external-mine-tab-test
  (testing "a tab for a mine BlueGenes cannot run links to the mine's webapp"
    (let [[tab] (subs/template-tabs {}
                                    {:mousemine {:name "MouseMine" :home-templates true :external? true
                                                 :service {:root "https://mm.example/mousemine"}}}
                                    :alliancemine
                                    {:mousemine fly-templates})]
      (is (= "https://mm.example/mousemine" (:webapp-root tab))))))

(deftest aspect-tab-stands-in-for-mine-test
  (testing "a mine with an aspect tab of its name gets no second tab"
    (is (= ["Genome" "Downloads" "YeastMine"]
           (map :label (subs/template-tabs aspects
                                           {:yeastmine {:name "YeastMine" :home-templates true}}
                                           :alliancemine
                                           {:yeastmine fly-templates}))))))

(deftest category-colour-test
  (testing "mine categories get their own colour; unknown ones are grey"
    (is (= ["yeast" "worm" "fly" "mouse" "gene" "literature" "disease" "other"]
           (map helpers/category-colour
                ["YeastMine" "WormMine" "FlyMine" "MouseMine" "Genome" "Literature" "Disease"
                 "Downloads"])))))
