(ns bluegenes.results-test
  (:require [cljs.test :refer-macros [deftest is are testing use-fixtures]]
            [bluegenes.test-utils :as utils]
            [re-frame.core :as rf]
            [day8.re-frame.test :refer-macros [run-test-sync]]
            [bluegenes.pages.results.events :refer [clean-query-parts history-key]]))

(use-fixtures :each utils/fixtures)

(def query-parts
  {:Gene [{:path "Gene.id",
           :type :Gene,
           :query {:title "PL FBgg0000203: U-BOX UBIQUITIN LIGASES",
                   :from "Gene",
                   :select ["Gene.id"],
                   :where [{:path "Gene", :op "IN", :value "PL FBgg0000203: U-BOX UBIQUITIN LIGASES", :code "A"}],
                   :sortOrder ["Gene.symbol" "DESC"]
                   :constraintLogic "A"}}],
   :Organism [{:path "Gene.organism.id",
               :type :Organism,
               :query {:title "PL FBgg0000203: U-BOX UBIQUITIN LIGASES",
                       :from "Gene",
                       :select ["Gene.organism.id"],
                       :orderBy ["Gene.organism.name" "ASC"]
                       :where [{:path "Gene", :op "IN", :value "PL FBgg0000203: U-BOX UBIQUITIN LIGASES", :code "A"}],
                       :constraintLogic "A"
                       :joins ["Gene.organism"]}}]})

(def query-parts-cleaned
  {:Gene [{:path "Gene.id",
           :type :Gene,
           :query {:from "Gene",
                   :select ["Gene.id"],
                   :where [{:path "Gene", :op "IN", :value "PL FBgg0000203: U-BOX UBIQUITIN LIGASES", :code "A"}],
                   :constraintLogic "A"}}],
   :Organism [{:path "Gene.organism.id",
               :type :Organism,
               :query {:from "Gene",
                       :select ["Gene.organism.id"],
                       :where [{:path "Gene", :op "IN", :value "PL FBgg0000203: U-BOX UBIQUITIN LIGASES", :code "A"}],
                       :constraintLogic "A"}}]})

(deftest clean-query-parts-test
  (is (= (clean-query-parts query-parts) query-parts-cleaned)))

(deftest history-key-test
  (let [q1 {:title "Gene_Pathways" :from "Gene" :where [{:value "a"}]}
        q2 (assoc q1 :where [{:value "b"}])
        queries {"Gene_Pathways" {:intent :template :value q1}}]
    (testing "an unused title is the key"
      (is (= "Gene_Pathways" (history-key {} {:intent :template :value q1}))))
    (testing "rerunning the same query reuses its key"
      (is (= "Gene_Pathways" (history-key queries {:intent :template :value q1}))))
    (testing "a different query with the same title gets its own stable key"
      (let [k (history-key queries {:intent :template :value q2})]
        (is (not= "Gene_Pathways" k))
        (is (= k (history-key queries {:intent :template :value q2})))))
    (testing "lists always use their name, as routes link to it"
      (is (= "Gene_Pathways" (history-key queries {:intent :list :value q2}))))))

(rf/reg-event-db ::seed (fn [_ [_ db]] db))
(rf/reg-sub ::entities #(get-in % [:tools :entities]))

(deftest stale-tool-entity-response-is-ignored
  (run-test-sync
   (testing "a response after entities were cleared leaves them cleared"
     (rf/dispatch [::seed {}])
     (rf/dispatch [:success-fetch-ids-tool-entity :Gene {:results [[1] [2]]}])
     (is (nil? @(rf/subscribe [::entities]))))
   (testing "a response for a class missing from the current query is dropped"
     (rf/dispatch [::seed {:tools {:entities {:Protein nil}}}])
     (rf/dispatch [:success-fetch-ids-tool-entity :Gene {:results [[1] [2]]}])
     (is (= {:Protein nil} @(rf/subscribe [::entities]))))
   (testing "a response for a current class is stored"
     (rf/dispatch [::seed {:tools {:entities {:Gene nil :Protein nil}}}])
     (rf/dispatch [:success-fetch-ids-tool-entity :Gene {:results [[1] [2]]}])
     (is (= [1 2] (get-in @(rf/subscribe [::entities]) [:Gene :value]))))))
