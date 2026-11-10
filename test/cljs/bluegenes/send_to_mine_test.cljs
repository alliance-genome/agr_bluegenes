(ns bluegenes.send-to-mine-test
  (:require [cljs.test :refer-macros [deftest is testing use-fixtures]]
            [bluegenes.test-utils :as utils :refer [stub-fetch-fn]]
            [re-frame.core :as rf]
            [day8.re-frame.test :refer-macros [run-test-sync run-test-async wait-for]]
            [imcljs.fetch :as fetch]
            [imcljs.save :as save]
            [bluegenes.subs]
            [bluegenes.pages.results.events]
            [bluegenes.pages.results.subs]
            [bluegenes.pages.results.send-to-mine :as stm]))

(use-fixtures :each utils/fixtures)

(deftest identifier-candidates
  (testing "prefixed identifier is tried as is and without prefix"
    (is (= ["MGI:104537" "104537"] (stm/id-candidates "MGI:104537")))
    (is (= ["ZFIN:ZDB-GENE-000616-13" "ZDB-GENE-000616-13"]
           (stm/id-candidates "ZFIN:ZDB-GENE-000616-13"))))
  (testing "only the first colon splits"
    (is (= ["A:B:C" "B:C"] (stm/id-candidates "A:B:C"))))
  (testing "no prefix, or nothing after the colon"
    (is (= ["FBgn0003731"] (stm/id-candidates "FBgn0003731")))
    (is (= ["MGI:"] (stm/id-candidates "MGI:"))))
  (testing "candidates of several identifiers are distinct"
    (is (= ["MGI:1" "1" "WB:1"]
           (stm/all-candidates ["MGI:1" "WB:1"])))))

(def response
  {:matches {:MATCH [{:input ["MGI:104537"] :id 11}
                     {:input ["109257"] :id 12}]
             :OTHER [{:input ["old"] :id 13}]
             :DUPLICATE [{:input ["dup"] :matches [{:id 14} {:id 15}]}]
             :WILDCARD []
             :TYPE_CONVERTED []}
   :unresolved ["nonexist" "dup" "MGI:109257"]})

(deftest classification
  (let [result (stm/classify-resolution
                ["MGI:104537" "MGI:109257" "old" "dup" "nonexist"]
                response)]
    (testing "a candidate without prefix counts as resolved"
      (is (= 3 (:resolved result))))
    (testing "ambiguous and missing identifiers are unresolved"
      (is (= ["dup" "nonexist"] (:unresolved result))))
    (testing "object ids come from matches and synonym matches"
      (is (= [11 12 13] (:object-ids result))))
    (is (= 5 (:source-count result))))
  (testing "no identifiers"
    (is (= {:source-count 0 :resolved 0 :unresolved [] :object-ids []}
           (stm/classify-resolution [] nil)))))

(deftest queries
  (is (= {:from "Gene"
          :select ["Gene.primaryIdentifier"]
          :where [{:path "Gene" :op "IN" :value "L"}]}
         (stm/source-ids-query "L" :same nil)))
  (is (= {:from "Gene"
          :select ["Gene.homologues.homologue.primaryIdentifier"]
          :where [{:path "Gene" :op "IN" :value "L"}
                  {:path "Gene.homologues.homologue.organism.shortName"
                   :op "="
                   :value "M. musculus"}]}
         (stm/source-ids-query "L" :orthologs "M. musculus")))
  (is (= {:from "Gene"
          :select ["Gene.id"]
          :where [{:path "Gene.id" :op "ONE OF" :values ["1" "2"]}]}
         (stm/object-ids-query [1 2]))))

(deftest list-names
  (is (= "L from AllianceMine" (stm/default-list-name "L" :same nil "AllianceMine")))
  (is (= "L orthologs in M. musculus from AllianceMine"
         (stm/default-list-name "L" :orthologs "M. musculus" "AllianceMine")))
  (is (= "typed" (stm/effective-list-name {:list-name "typed" :default-name "d"})))
  (is (= "d" (stm/effective-list-name {:default-name "d"}))))

(deftest readiness
  (testing "resolve needs a target, and an organism for orthologs"
    (is (false? (stm/ready-to-resolve? {:mode :same})))
    (is (true? (stm/ready-to-resolve? {:target :mouse :mode :same})))
    (is (false? (stm/ready-to-resolve? {:target :mouse :mode :orthologs})))
    (is (true? (stm/ready-to-resolve? {:target :mouse :mode :orthologs :organism "M. musculus"})))
    (is (false? (stm/ready-to-resolve? {:target :mouse :mode :same :resolving? true}))))
  (testing "save needs a login, resolved genes and a name"
    (let [ok {:logged-in? true :default-name "n" :result {:object-ids [1]}}]
      (is (true? (stm/ready-to-save? ok)))
      (is (false? (stm/ready-to-save? (assoc ok :logged-in? false))))
      (is (false? (stm/ready-to-save? (assoc ok :result {:object-ids []}))))
      (is (false? (stm/ready-to-save? (assoc ok :saving? true))))
      (is (false? (stm/ready-to-save? (assoc ok :list-name "")))))))

(deftest target-service-token
  (let [db {:env {:mines {:mouse {:service {:root "http://mouse.example"}}}}}]
    (is (= {:root "http://mouse.example" :token "t"}
           (stm/target-service db {:mouse {:token "t"}} :mouse)))
    (is (= {:root "http://mouse.example"}
           (stm/target-service db {:other {:token "t"}} :mouse))
        "login for another mine is not used")))

(rf/reg-event-db ::seed (fn [_ [_ db]] db))
(rf/reg-sub ::state #(get-in % [:results :send-to-mine]))
(rf/reg-event-db ::noop (fn [db _] db))

(def seeded-db
  {:current-mine :main
   :env {:mines {:main {:name "Main" :service {:root "http://main.example"}}
                 :mouse {:name "Mouse" :service {:root "http://mouse.example"}}}}
   :mines {:main {:name "Main" :service {:root "http://main.example"}}}})

(def open-state
  {:open? true :list-source "L" :run 1 :target :mouse
   :target-service {:root "http://mouse.example" :token "t"}
   :logged-in? true})

(deftest target-mines-exclude-current
  (run-test-sync
   (rf/dispatch [::seed seeded-db])
   (is (= [{:id :mouse :label "Mouse"}]
          @(rf/subscribe [::stm/target-mines])))))

(deftest select-mine-reads-login-and-fetches-organisms
  (run-test-async
   (utils/stub-local-storage)
   (let [calls (atom [])
         orig-rows fetch/rows]
     (rf/dispatch-sync [:save-login :mouse {:token "mouse-token"}])
     (rf/dispatch-sync [::seed (assoc seeded-db :results
                                      {:send-to-mine {:open? true :list-source "L" :run 0}})])
     (set! fetch/rows (fn [service query options]
                        (swap! calls conj [service query options])
                        ((stub-fetch-fn {:results [{:item "M. musculus" :count 2}
                                                   {:item "D. rerio" :count 1}]}))))
     (swap! utils/stubbed-variables conj #(set! fetch/rows orig-rows))
     (rf/dispatch [::stm/select-mine "mouse"])
     (wait-for [::stm/organisms-success]
       (let [state @(rf/subscribe [::state])]
         (is (= :mouse (:target state)))
         (is (true? (:logged-in? state)))
         (is (= ["D. rerio" "M. musculus"] (:organisms state)))
         (is (false? (:loading-organisms? state))))
       (is (= {:root "http://mouse.example" :token "mouse-token"}
              (ffirst @calls)))
       (is (= (stm/target-organisms-query) (second (first @calls))))))))

(deftest select-mine-without-login
  (run-test-sync
   (utils/stub-local-storage)
   (rf/dispatch [::seed (assoc seeded-db :results
                               {:send-to-mine {:open? true :list-source "L" :run 0}})])
   (with-redefs [fetch/rows (stub-fetch-fn {:results []})]
     (rf/dispatch [::stm/select-mine "mouse"]))
   (let [state @(rf/subscribe [::state])]
     (is (false? (:logged-in? state)))
     (is (= {:root "http://mouse.example"} (:target-service state))))
   (testing "choosing the empty option resets the target"
     (rf/dispatch [::stm/select-mine ""])
     (is (nil? (:target @(rf/subscribe [::state]))))
     (is (true? (:open? @(rf/subscribe [::state])))))))

(deftest stale-resolution-is-ignored
  (run-test-sync
   (rf/dispatch [::seed (assoc seeded-db :results {:send-to-mine open-state})])
   (testing "result of an older run is dropped"
     (rf/dispatch [::stm/resolve-success :mouse 0 ["MGI:1"] response])
     (is (nil? (:result @(rf/subscribe [::state])))))
   (testing "result for another target is dropped"
     (rf/dispatch [::stm/resolve-success :fly 1 ["MGI:1"] response])
     (is (nil? (:result @(rf/subscribe [::state])))))
   (testing "current run is stored"
     (rf/dispatch [::stm/resolve-success :mouse 1 ["MGI:104537"] response])
     (is (= 1 (:resolved (:result @(rf/subscribe [::state]))))))))

(deftest unauthorised-does-not-touch-current-mine-login
  (run-test-sync
   (let [messages (atom [])]
     (rf/reg-event-fx :messages/add (fn [_ [_ m]] (swap! messages conj m) {}))
     (rf/dispatch [::seed (assoc seeded-db :results
                                 {:send-to-mine (assoc open-state :saving? true)})])
     (rf/dispatch [::stm/unauthorised :mouse 1 {:status 401}])
     (let [state @(rf/subscribe [::state])]
       (is (false? (:logged-in? state)))
       (is (false? (:saving? state))))
     (is (= "warning" (:style (first @messages)))))))

(deftest save-chain
  (run-test-async
   (let [saved (atom nil)
         saved-service (atom nil)
         messages (atom [])
         orig-lists fetch/lists
         orig-save save/im-list-from-query]
     (rf/reg-event-fx :messages/add (fn [_ [_ m]] (swap! messages conj m) {}))
     (rf/dispatch-sync [::seed (assoc seeded-db :results
                                      {:send-to-mine
                                       (assoc open-state
                                              :default-name "L from Main"
                                              :result {:source-count 3 :resolved 2
                                                       :unresolved ["x"] :object-ids [11 12]})})])
     (set! fetch/lists (stub-fetch-fn [{:name "L from Main"}]))
     (set! save/im-list-from-query
           (fn [service name query]
             (reset! saved-service service)
             (reset! saved [name query])
             ((stub-fetch-fn {:listName name}))))
     (swap! utils/stubbed-variables conj #(set! fetch/lists orig-lists))
     (swap! utils/stubbed-variables conj #(set! save/im-list-from-query orig-save))
     (rf/dispatch [::stm/save])
     (wait-for [::stm/save-success]
       (testing "list is saved in the target mine with its token"
         (is (= {:root "http://mouse.example" :token "t"} @saved-service)))
       (testing "name clash in the target mine gets a suffix"
         (is (= "L from Main_1" (first @saved))))
       (testing "the saved query holds the resolved object ids"
         (is (= (stm/object-ids-query [11 12]) (second @saved))))
       (testing "state keeps the saved list for the switch link"
         (let [state @(rf/subscribe [::state])]
           (is (= {:name "L from Main_1" :mine :mouse} (:saved state)))
           (is (false? (:saving? state)))))
       (testing "success goes through the message system"
         (is (= "success" (:style (first @messages)))))))))

(deftest save-needs-login
  (run-test-sync
   (rf/dispatch [::seed (assoc seeded-db :results
                               {:send-to-mine
                                (assoc open-state
                                       :logged-in? false
                                       :default-name "n"
                                       :result {:object-ids [1]})})])
   (rf/dispatch [::stm/save])
   (is (not (:saving? @(rf/subscribe [::state]))))))

(deftest save-failure-reports-error
  (run-test-sync
   (let [messages (atom [])]
     (rf/reg-event-fx :messages/add (fn [_ [_ m]] (swap! messages conj m) {}))
     (rf/dispatch [::seed (assoc seeded-db :results
                                 {:send-to-mine (assoc open-state :saving? true)})])
     (rf/dispatch [::stm/save-failure :mouse 1 {:body {:error "boom"}}])
     (is (false? (:saving? @(rf/subscribe [::state]))))
     (is (= "danger" (:style (first @messages))))
     (is (= [:code "boom"] (last (:markup (first @messages))))))))

(deftest results-clear-resets-panel
  (run-test-sync
   (rf/dispatch [::seed (assoc seeded-db :results {:send-to-mine open-state})])
   (rf/dispatch [:results/clear])
   (is (nil? @(rf/subscribe [::state])))))
