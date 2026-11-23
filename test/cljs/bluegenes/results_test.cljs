(ns bluegenes.results-test
  (:require [cljs.test :refer-macros [deftest is are testing use-fixtures]]
            [bluegenes.test-utils :as utils]
            [re-frame.core :as rf]
            [day8.re-frame.test :refer-macros [run-test-sync]]
            [bluegenes.pages.results.events :refer [clean-query-parts history-key open-panels newly-opened close-event close-others-events missing-list-message gene-list-select logged-in?]]))

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

(def gene-summary-fields
  ["Gene.primaryIdentifier" "Gene.secondaryIdentifier" "Gene.organism.shortName" "Gene.symbol" "Gene.name"])

(deftest gene-list-select-test
  (testing "Gene lists lead with the symbol and drop the secondary identifier"
    (is (= ["Gene.symbol" "Gene.primaryIdentifier" "Gene.organism.shortName" "Gene.name"]
           (gene-list-select "Gene" gene-summary-fields))))
  (testing "other classes keep their summary fields"
    (is (= ["Protein.primaryAccession" "Protein.name"]
           (gene-list-select "Protein" ["Protein.primaryAccession" "Protein.name"]))))
  (testing "a Gene field set without a symbol is left alone"
    (is (= ["Gene.primaryIdentifier" "Gene.secondaryIdentifier"]
           (gene-list-select "Gene" ["Gene.primaryIdentifier" "Gene.secondaryIdentifier"])))))

(deftest missing-list-message-test
  (let [text (fn [msg] (pr-str (get-in msg [1 :markup])))]
    (testing "names the list and says an unsaved list lives only in the session"
      (let [msg (missing-list-message "Gene list for H. sapiens 23 Nov 2026 14:13:41" true)]
        (is (= :messages/add (first msg)))
        (is (re-find #"only in the session" (text msg)))
        (is (re-find #"Gene list for H. sapiens" (text msg)))
        (is (not (re-find #"Log in" (text msg))))))
    (testing "asks anonymous users to log in"
      (is (re-find #"Log in to keep lists" (text (missing-list-message "x" false)))))))

(deftest logged-in-test
  (is (true? (logged-in? {:current-mine :alliancemine
                          :mines {:alliancemine {:auth {:identity {:username "a"}}}}})))
  (is (false? (logged-in? {:current-mine :alliancemine
                           :mines {:alliancemine {:auth {}}}}))))

(deftest toolbar-panels-test
  (let [db {:results {:orthologs {:open? true}
                      :track-export {:open? true}
                      :linkout {:source {:list "My genes"}}
                      :cite {:open? false}}}]
    (testing "open panels are listed in toolbar order"
      (is (= [:convert :track :linkout] (open-panels db)))
      (is (= [] (open-panels {}))))
    (testing "the newly opened panel is the one missing from the old set"
      (is (= :cite (newly-opened [:convert] [:convert :cite])))
      (is (nil? (newly-opened [:convert :cite] [:cite]))))
    (testing "linkout closes with its own source"
      (is (= [:bluegenes.pages.results.linkout/toggle {:list "My genes"}]
             (close-event db :linkout))))
    (testing "opening a panel closes every other open panel"
      (is (= [[:bluegenes.pages.results.orthologs/toggle nil]
              [:bluegenes.pages.results.linkout/toggle {:list "My genes"}]]
             (close-others-events db :track)))
      (is (= [] (close-others-events {:results {:cite {:open? true}}} :cite))))))
