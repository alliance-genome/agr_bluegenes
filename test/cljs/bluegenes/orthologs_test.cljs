(ns bluegenes.orthologs-test
  (:require [cljs.test :refer-macros [deftest is testing use-fixtures]]
            [bluegenes.test-utils :as utils :refer [stub-fetch-fn]]
            [re-frame.core :as rf]
            [day8.re-frame.test :refer-macros [run-test-sync run-test-async wait-for]]
            [imcljs.fetch :as fetch]
            [imcljs.save :as save]
            [bluegenes.pages.results.orthologs :as orthologs]))

(use-fixtures :each utils/fixtures)

(def model {:Gene {:collections {:homologues {}}}})

(deftest availability
  (testing "Gene list with Gene.homologues"
    (is (true? (orthologs/available? model {:type "Gene"}))))
  (testing "other list types"
    (is (false? (orthologs/available? model {:type "Protein"}))))
  (testing "model without homologues"
    (is (false? (orthologs/available? {:Gene {:collections {}}} {:type "Gene"}))))
  (testing "no list"
    (is (false? (orthologs/available? model nil)))))

(deftest queries
  (is (= {:from "Gene"
          :select ["Gene.homologues.homologue.organism.shortName"]
          :where [{:path "Gene" :op "IN" :value "my list"}]}
         (orthologs/organisms-query "my list")))
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
         (is (= [(orthologs/organisms-query "L")
                 (orthologs/orthologs-query "L" "M. musculus")]
                (map first @fetch-calls))))))))

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
           (fn [_service name query]
             (reset! saved [name query])
             ((stub-fetch-fn {:listName name}))))
     (swap! utils/stubbed-variables conj #(set! save/im-list-from-query orig-save))
     (rf/dispatch [::orthologs/save])
     (wait-for [::orthologs/save-success]
       (testing "name clashes with an existing list get a suffix"
         (is (= "L orthologs in M. musculus_1" (first @saved))))
       (testing "the saved query is the orthologs query"
         (is (= (orthologs/orthologs-query "L" "M. musculus") (second @saved))))
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
