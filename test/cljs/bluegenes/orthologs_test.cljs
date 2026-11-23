(ns bluegenes.orthologs-test
  (:require [cljs.test :refer-macros [deftest is testing use-fixtures]]
            [bluegenes.test-utils :as utils :refer [stub-fetch-fn]]
            [re-frame.core :as rf]
            [day8.re-frame.test :refer-macros [run-test-sync run-test-async wait-for]]
            [imcljs.fetch :as fetch]
            [imcljs.save :as save]
            [bluegenes.pages.results.orthologs :as orthologs]
            [bluegenes.pages.results.orthologs-preview :as preview]))

(use-fixtures :each utils/fixtures)

(def model
  "Model with the paths the conversion queries."
  {:Gene {:attributes {:id {}}
          :collections {:homologues {:referencedType "Homologue"}}}
   :Homologue {:references {:homologue {:referencedType "Gene"}}}})

(def model-with-organism
  (-> model
      (assoc-in [:Gene :references :organism] {:referencedType "Organism"})
      (assoc :Organism {:attributes {:shortName {}}})))

(deftest availability
  (testing "Gene list with Gene.homologues.homologue and its organism"
    (is (true? (orthologs/available? model-with-organism {:type "Gene"}))))
  (testing "other list types"
    (is (false? (orthologs/available? model-with-organism {:type "Protein"}))))
  (testing "model without homologues"
    (is (false? (orthologs/available? {:Gene {:collections {}}} {:type "Gene"}))))
  (testing "Gene.homologues present but the homologue's organism is not"
    (is (false? (orthologs/available? model {:type "Gene"}))))
  (testing "no list"
    (is (false? (orthologs/available? model-with-organism nil)))))

(deftest blocked-reasons
  (testing "nothing blocks a model with the paths, or an unknown model"
    (is (nil? (orthologs/blocked-reason model-with-organism "WormMine")))
    (is (nil? (orthologs/blocked-reason nil "WormMine"))))
  (testing "a missing path is named with the mine"
    (is (= "ToyMine has no Gene.homologues.homologue.organism.shortName"
           (orthologs/blocked-reason model "ToyMine")))
    (is (= "ToyMine has no Gene.homologues.homologue.organism.shortName, Gene.homologues.homologue.id"
           (orthologs/blocked-reason {:Gene {:attributes {:id {}}}} "ToyMine")))))

(def type-constraint
  {:path "Gene.homologues.type" :op "ONE OF" :values ["orthologue" "least diverged orthologue"]})

(deftest queries
  (is (= {:from "Gene"
          :select ["Gene.homologues.homologue.organism.shortName"]
          :where [{:path "Gene" :op "IN" :value "my list"}]}
         (orthologs/organisms-query "my list")))
  (testing "organisms, count and saved list all carry the ortholog type constraint"
    (is (= [{:path "Gene" :op "IN" :value "my list"} type-constraint]
           (:where (orthologs/organisms-query "my list" {:type? true}))))
    (is (= type-constraint
           (last (:where (orthologs/orthologs-query "my list" "M. musculus" {} {:type? true})))))
    (is (= type-constraint
           (nth (:where (orthologs/orthologs-query "my list" "M. musculus" {:best-only? true}
                                                   {:type? true :best? true}))
                2))))
  (is (= {:from "Gene"
          :select ["Gene.homologues.homologue.id"]
          :where [{:path "Gene" :op "IN" :value "my list"}
                  {:path "Gene.homologues.homologue.organism.shortName"
                   :op "="
                   :value "M. musculus"}]}
         (orthologs/orthologs-query "my list" "M. musculus"))))

(deftest list-names
  (is (= "my list orthologs in M. musculus"
         (orthologs/default-list-name "my list" "M. musculus")))
  (testing "default follows the organism until the user types a name"
    (is (= "L orthologs in D. melanogaster"
           (orthologs/effective-list-name {:list-source "L" :organism "D. melanogaster"})))
    (is (= "mine"
           (orthologs/effective-list-name {:list-source "L" :organism "D. melanogaster"
                                           :list-name "mine"})))
    (is (nil? (orthologs/effective-list-name {:list-source "L"})))))

(deftest organisms-summary
  (is (= ["D. melanogaster" "M. musculus"]
         (orthologs/organisms-from-summary
          {:results [{:item "M. musculus" :count 3}
                     {:item "D. melanogaster" :count 1}
                     {:item "" :count 1}]}))))

(rf/reg-event-db ::seed (fn [_ [_ db]] db))
(rf/reg-sub ::orthologs #(get-in % [:results :orthologs]))
(rf/reg-event-db ::noop (fn [db _] db))

(def seeded-db
  {:current-mine :test
   :mines {:test {:service {:root "http://example.org"}}}
   :assets {:lists {:test [{:name "L orthologs in M. musculus"}]}}})

(deftest stale-count-is-ignored
  (run-test-sync
   (rf/dispatch [::seed (assoc seeded-db :results
                               {:orthologs {:open? true :list-source "L"
                                            :organism "M. musculus"}})])
   (testing "count for another organism is dropped"
     (rf/dispatch [::orthologs/count-success "L" "D. rerio" {:uniqueValues 9}])
     (is (nil? (:count @(rf/subscribe [::orthologs])))))
   (testing "count for the selected organism is stored"
     (rf/dispatch [::orthologs/count-success "L" "M. musculus" {:uniqueValues 4}])
     (is (= 4 (:count @(rf/subscribe [::orthologs])))))))

(deftest open-fetches-organisms-and-select-fetches-count
  (run-test-async
   (let [fetch-calls (atom [])
         orig-rows fetch/rows
         rows-stub (fn [_service query options]
                     (swap! fetch-calls conj [query options])
                     ((stub-fetch-fn
                       (if (= (:summaryPath options) orthologs/organism-path)
                         {:results [{:item "M. musculus" :count 2}
                                    {:item "D. melanogaster" :count 1}]}
                         {:uniqueValues 3}))))]
     (rf/dispatch-sync [::seed seeded-db])
     ;; Chained handlers run after dispatch returns, so with-redefs would not
     ;; cover them. Use set! and restore in the fixture.
     (set! fetch/rows rows-stub)
     (swap! utils/stubbed-variables conj #(set! fetch/rows orig-rows))
     (rf/dispatch [::orthologs/toggle "L"])
     (wait-for [::orthologs/organisms-success]
       (is (= ["D. melanogaster" "M. musculus"]
              (:organisms @(rf/subscribe [::orthologs]))))
       (rf/dispatch [::orthologs/select-organism "M. musculus"])
       (wait-for [::orthologs/count-success]
         (let [state @(rf/subscribe [::orthologs])]
           (is (= 3 (:count state)))
           (is (false? (:loading-count? state))))
         (wait-for [::orthologs/list-genes-success]
           (is (= [(orthologs/organisms-query "L" (:features @(rf/subscribe [::orthologs])))
                   (orthologs/orthologs-query "L" "M. musculus" {} (:features @(rf/subscribe [::orthologs])))]
                  (keep (fn [[query options]] (when (:summaryPath options) query))
                        @fetch-calls)))
           (is (some #(= (preview/preview-query "L" "M. musculus"
                                                (:features @(rf/subscribe [::orthologs])))
                         (first %))
                     @fetch-calls)
               "the mapping preview is fetched for the organism")
           (is (some #(= (orthologs/list-genes-query "L") (first %)) @fetch-calls)
               "the list genes are fetched once the rows are in")))))))

(deftest save-chain
  (run-test-async
   (let [saved (atom nil)
         orig-save save/im-list-from-query]
     (rf/dispatch-sync [::seed (assoc seeded-db :results
                                      {:orthologs {:open? true :list-source "L"
                                                   :organism "M. musculus"
                                                   :count 3}})])
     (rf/reg-event-fx :assets/fetch-lists
                      (fn [_ [_ next-evt]]
                        {:dispatch [::noop next-evt]}))
     (set! save/im-list-from-query
           (fn [_service name query & [options]]
             (reset! saved [name query options])
             ((stub-fetch-fn {:listName name}))))
     (swap! utils/stubbed-variables conj #(set! save/im-list-from-query orig-save))
     (rf/dispatch [::orthologs/save])
     (wait-for [::orthologs/save-success]
       (testing "name clashes with an existing list get a suffix"
         (is (= "L orthologs in M. musculus_1" (first @saved))))
       (testing "the saved query is the orthologs query"
         (is (= (orthologs/orthologs-query "L" "M. musculus") (second @saved))))
       (testing "the list records its source and filters"
         (let [options (nth @saved 2)]
           (is (= "orthologs" (:tags options)))
           (is (re-matches #"Orthologs of L in M\. musculus; \d{4}-\d{2}-\d{2}" (:description options)))))
       (testing "state is cleared and lists are refetched"
         (is (nil? @(rf/subscribe [::orthologs]))))))))

(deftest save-failure-reports-error
  (run-test-sync
   (let [messages (atom [])]
     (rf/reg-event-fx :messages/add (fn [_ [_ m]] (swap! messages conj m) {}))
     (rf/dispatch [::seed (assoc seeded-db :results
                                 {:orthologs {:open? true :saving? true}})])
     (rf/dispatch [::orthologs/save-failure {:body {:error "boom"}}])
     (is (false? (:saving? @(rf/subscribe [::orthologs]))))
     (is (= "danger" (:style (first @messages))))
     (is (= [:code "boom"] (last (:markup (first @messages))))))))

(deftest results-clear-resets-panel
  (run-test-sync
   (rf/dispatch [::seed (assoc seeded-db :results
                               {:orthologs {:open? true :list-source "A"}})])
   (rf/dispatch [:results/clear])
   (is (nil? @(rf/subscribe [::orthologs]))
       "panel state of list A is gone after navigating away")))

(deftest save-needs-count-and-name
  (run-test-sync
   (rf/dispatch [::seed (assoc seeded-db :results
                               {:orthologs {:open? true :list-source "L"}})])
   (rf/dispatch [::orthologs/save])
   (is (not (:saving? @(rf/subscribe [::orthologs])))
       "no organism selected, nothing saved")))

(deftest filtered-query
  (let [all {:methods? true :best? true}]
    (is (= (orthologs/orthologs-query "L" "M. musculus")
           (orthologs/orthologs-query "L" "M. musculus" {:min-methods 0 :best-only? false} all)))
    (is (= [{:path "Gene" :op "IN" :value "L"}
            {:path "Gene.homologues.homologue.organism.shortName" :op "=" :value "M. musculus"}
            {:path "Gene.homologues.algorithmsMatch" :op ">=" :value "5"}
            {:path "Gene.homologues.isBestScore" :op "=" :value "true"}]
           (:where (orthologs/orthologs-query "L" "M. musculus"
                                              {:min-methods 5 :best-only? true} all))))))

(deftest model-features
  (let [classes {:Gene {:collections {:homologues {:referencedType "Homologue"}}}
                 :Homologue {:attributes {:type {} :isBestScore {}}
                             :references {:homologue {:referencedType "Gene"}}}}]
    (is (= {:type? true :methods? false :best? true :best-reverse? false :stringency? false}
           (orthologs/model-features classes)))
    (is (every? true? (vals (orthologs/model-features nil))) "unknown model offers all")))

(deftest shown-targets
  (let [rows (preview/parse-rows [[1 "G1" "g1" 10 "T10" "t10" "orthologue" 9 10 true false]
                                  [2 "G2" "g2" 11 "T11" "t11" "orthologue" 2 10 false false]]
                                 {:methods? true :best? true :best-reverse? true :type? true})]
    (is (= 7 (orthologs/shown-targets {:count 7})) "server count without rows")
    (is (= 2 (orthologs/shown-targets {:count 7 :rows rows})))
    (is (= 1 (orthologs/shown-targets {:count 7 :rows rows :min-methods 5})))
    (is (= 1 (orthologs/shown-targets {:count 7 :rows rows :best-only? true})))
    (is (= 0 (orthologs/shown-targets {:count 7 :rows rows :min-methods 10 :best-only? true})))))

(deftest descriptions
  (is (= "Orthologs of L in M. musculus, at least 6 methods, best matches only, stringent only; 2026-11-23"
         (orthologs/description {:list-source "L" :organism "M. musculus" :min-methods 6
                                 :best-only? true :stringent-only? true}
                                "2026-11-23")))
  (is (= "Orthologs of L in D. rerio; 2026-11-23"
         (orthologs/description {:list-source "L" :organism "D. rerio" :min-methods 0}
                                "2026-11-23"))))

(deftest truncated-preview
  (run-test-sync
   (rf/dispatch [::seed (assoc seeded-db :results
                               {:orthologs {:open? true :list-source "L" :organism "M. musculus"
                                            :features preview-features :loading-preview? true
                                            :genes []}})])
   (testing "a response at the limit is flagged and the preview data is withheld"
     (rf/dispatch [::orthologs/preview-success "L" "M. musculus"
                   {:results (repeat orthologs/fetch-limit [1 "G1" "g1" 10 "T10" "t10" 9 10 true])}])
     (is (true? (:truncated? @(rf/subscribe [::orthologs]))))
     (is (= {:truncated? true} @(rf/subscribe [::orthologs/preview-data])))
     (is (= 7 (orthologs/shown-targets (assoc @(rf/subscribe [::orthologs]) :count 7 :min-methods 5)))
         "the server count stands in"))
   (testing "a short response is not flagged"
     (rf/dispatch [::orthologs/preview-success "L" "M. musculus"
                   {:results [[1 "G1" "g1" 10 "T10" "t10" 9 10 true]]}])
     (is (false? (:truncated? @(rf/subscribe [::orthologs]))))
     (is (= 1 (count (:rows @(rf/subscribe [::orthologs/preview-data]))))))
   (testing "list genes at the limit are flagged"
     (rf/dispatch [::orthologs/list-genes-success "L" {:results (repeat orthologs/fetch-limit [1 "G1" "g1"])}])
     (is (true? (:genes-truncated? @(rf/subscribe [::orthologs]))))
     (is (nil? (:unmapped @(rf/subscribe [::orthologs/preview-data])))))))

(def preview-features {:methods? true :best? true})

(deftest preview-events
  (run-test-sync
   (rf/dispatch [::seed (assoc seeded-db :results
                               {:orthologs {:open? true :list-source "L" :organism "M. musculus"
                                            :features preview-features :loading-preview? true}})])
   (testing "rows for another organism are dropped"
     (rf/dispatch [::orthologs/preview-success "L" "D. rerio" {:results [[1 "G1" "g1" 10 "T10" "t10" 9 10 true]]}])
     (is (nil? (:rows @(rf/subscribe [::orthologs])))))
   (testing "min-methods and best-only? are stored"
     (rf/dispatch [::orthologs/set-min-methods "6"])
     (rf/dispatch [::orthologs/set-best-only true])
     (is (= 6 (:min-methods @(rf/subscribe [::orthologs]))))
     (is (true? (:best-only? @(rf/subscribe [::orthologs])))))
   (testing "a non-numeric slider value means no cutoff"
     (rf/dispatch [::orthologs/set-min-methods ""])
     (is (= 0 (:min-methods @(rf/subscribe [::orthologs])))))))

(deftest preview-data-sub
  (run-test-sync
   (let [rows (preview/flag-relations
               (preview/parse-rows [[1 "G1" "g1" 10 "T10" "t10" 9 10 true]
                                    [2 "G2" "g2" 10 "T10" "t10" 3 10 false]]
                                   preview-features))]
     (rf/dispatch [::seed (assoc seeded-db :results
                                 {:orthologs {:rows rows
                                              :genes (preview/parse-genes [[1 "G1" "g1"] [2 "G2" "g2"] [3 "G3" "g3"]])}})])
     (let [data @(rf/subscribe [::orthologs/preview-data])]
       (is (= [:many-to-one :many-to-one] (map :relation (:rows data))))
       (is (= ["g3"] (map :label (:none (:unmapped data)))))
       (is (empty? (:dropped (:unmapped data))))
       (is (= 10 (:max-methods data))))
     (rf/dispatch [::orthologs/set-min-methods "5"])
     (let [data @(rf/subscribe [::orthologs/preview-data])]
       (is (= [:many-to-one] (map :relation (:rows data))) "relation does not follow the cutoff")
       (is (= ["g3"] (map :label (:none (:unmapped data)))) "g2 has an ortholog")
       (is (= ["g2"] (map :label (:dropped (:unmapped data)))))))))
