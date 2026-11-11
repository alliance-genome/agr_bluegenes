(ns bluegenes.send-to-mine-test
  (:require [cljs.test :refer-macros [deftest is testing use-fixtures]]
            [clojure.core.async :as async]
            [bluegenes.test-utils :as utils :refer [stub-fetch-fn]]
            [re-frame.core :as rf]
            [day8.re-frame.test :refer-macros [run-test-sync run-test-async wait-for]]
            [imcljs.fetch :as fetch]
            [imcljs.save :as save]
            [bluegenes.subs]
            [bluegenes.events]
            [bluegenes.pages.results.events]
            [bluegenes.pages.results.subs]
            [bluegenes.pages.results.send-to-mine :as stm]))

(use-fixtures :each utils/fixtures)

(deftest identifier-candidates
  (testing "prefixed identifier is tried as is and without prefix"
    (is (= ["ZFIN:ZDB-GENE-000616-13" "ZDB-GENE-000616-13"]
           (stm/id-candidates "ZFIN:ZDB-GENE-000616-13")))
    (is (= ["WB:WBGene00006759" "WBGene00006759"]
           (stm/id-candidates "WB:WBGene00006759"))))
  (testing "a bare MOD identifier also gets its CURIE, for AllianceMine"
    (is (= ["WBGene00006759" "WB:WBGene00006759"] (stm/id-candidates "WBGene00006759")))
    (is (= ["FBgn0003996" "FB:FBgn0003996"] (stm/id-candidates "FBgn0003996")))
    (is (= ["S000001855" "SGD:S000001855"] (stm/id-candidates "S000001855"))))
  (testing "a number is never stripped: the MOD mines keep HGNC:, MGI: and RGD: prefixes"
    (is (= ["MGI:104537"] (stm/id-candidates "MGI:104537")))
    (is (= ["HGNC:11998"] (stm/id-candidates "HGNC:11998"))))
  (testing "only the first colon splits"
    (is (= ["A:B:C" "B:C"] (stm/id-candidates "A:B:C"))))
  (testing "locus tags, bare numbers, nothing after the colon"
    (is (= ["CAGL0K12694g"] (stm/id-candidates "CAGL0K12694g")))
    (is (= ["113563677"] (stm/id-candidates "113563677")))
    (is (= ["MGI:"] (stm/id-candidates "MGI:"))))
  (testing "candidates of several identifiers are distinct"
    (is (= ["WB:WBGene1" "WBGene1" "MGI:1"]
           (stm/all-candidates ["WB:WBGene1" "MGI:1" "WBGene1"])))))

(def response
  {:matches {:MATCH [{:input ["MGI:104537"] :id 11}
                     {:input ["ZDB-GENE-1"] :id 12}]
             :OTHER [{:input ["old"] :id 13}]
             :DUPLICATE [{:input ["dup"] :matches [{:id 14} {:id 15}]}]
             :WILDCARD []
             :TYPE_CONVERTED []}
   :unresolved ["nonexist" "dup" "ZFIN:ZDB-GENE-1"]})

(deftest classification
  (let [result (stm/classify-resolution
                ["MGI:104537" "ZFIN:ZDB-GENE-1" "old" "dup" "nonexist"]
                response)]
    (testing "a candidate without prefix counts as resolved"
      (is (= 3 (:resolved result))))
    (testing "ambiguous and missing identifiers are unresolved"
      (is (= ["dup" "nonexist"] (:unresolved result))))
    (testing "object ids come from matches and synonym matches"
      (is (= [11 12 13] (:object-ids result))))
    (is (= 5 (:source-count result))))
  (testing "no identifiers"
    (is (= {:source-count 0 :resolved 0 :unresolved [] :multi-mapped [] :object-ids []}
           (stm/classify-resolution [] nil)))))

(deftest classification-prefers-as-is-candidate
  (let [resp {:matches {:MATCH [{:input ["ZFIN:ZDB-GENE-1"] :id 1}
                                {:input ["ZDB-GENE-1"] :id 2}
                                {:input ["ZDB-GENE-2"] :id 3}]}}
        result (stm/classify-resolution ["ZFIN:ZDB-GENE-1" "ZFIN:ZDB-GENE-2"] resp)]
    (testing "stripped candidate is ignored when the as-is one matched"
      (is (= [1 3] (:object-ids result))))
    (is (= 2 (:resolved result)))
    (is (= [] (:multi-mapped result))))
  (testing "a numeric remainder is not tried, so it cannot hit an unrelated gene"
    (let [resp {:matches {:MATCH [{:input ["11998"] :id 9}]}}
          result (stm/classify-resolution ["HGNC:11998"] resp)]
      (is (= [] (:object-ids result)))
      (is (= ["HGNC:11998"] (:unresolved result)))))
  (testing "a bare WormMine identifier resolves in AllianceMine through its CURIE"
    (let [resp {:matches {:MATCH [{:input ["WB:WBGene00006759"] :id 5}]}}
          result (stm/classify-resolution ["WBGene00006759"] resp)]
      (is (= [5] (:object-ids result)))
      (is (= 1 (:resolved result)))))
  (testing "one identifier hitting two genes is reported"
    (let [resp {:matches {:MATCH [{:input ["X:1"] :id 1}]
                          :OTHER [{:input ["X:1"] :id 2}]}}
          result (stm/classify-resolution ["X:1"] resp)]
      (is (= ["X:1"] (:multi-mapped result)))
      (is (= [1 2] (:object-ids result))))))

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
        "login for another mine is not used")
    (is (= {:root "http://mouse.example" :model {:name "genomic"}}
           (stm/target-service
            (assoc-in (assoc db :current-mine :main)
                      [:mines :main :service :model :name] "genomic")
            nil :mouse))
        "model name comes from the current mine when the target is not loaded")))

(rf/reg-event-db ::seed (fn [_ [_ db]] db))
(rf/reg-sub ::state #(get-in % [:results :send-to-mine]))
(rf/reg-event-db ::noop (fn [db _] db))

(def seeded-db
  {:current-mine :main
   :send-to-mine-run 1
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
         orig-rows fetch/rows
         orig-model fetch/model]
     (rf/dispatch-sync [:save-login :mouse {:token "mouse-token"}])
     (rf/dispatch-sync [::seed (assoc seeded-db :results
                                      {:send-to-mine {:open? true :list-source "L" :run 0}})])
     (set! fetch/rows (fn [service query options]
                        (swap! calls conj [service query options])
                        ((stub-fetch-fn {:results [{:item "M. musculus" :count 2}
                                                   {:item "D. rerio" :count 1}]}))))
     (swap! utils/stubbed-variables conj #(set! fetch/rows orig-rows))
     (set! fetch/model (stub-fetch-fn {:classes {}}))
     (swap! utils/stubbed-variables conj #(set! fetch/model orig-model))
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
   ;; Channels that never deliver: a stubbed response would arrive after this
   ;; sync test ends and reach the wait-for of the next async test.
   (let [orig-model fetch/model]
     (set! fetch/model (fn [& _] (async/chan)))
     (swap! utils/stubbed-variables conj #(set! fetch/model orig-model)))
   (rf/dispatch [::seed (assoc seeded-db :results
                               {:send-to-mine {:open? true :list-source "L" :run 0}})])
   (with-redefs [fetch/rows (fn [& _] (async/chan))]
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
     ;; ::save-success dispatches the message, so wait for that last event.
     (wait-for [:messages/add]
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

(deftest changing-inputs-invalidates-pending-resolution
  (doseq [[label event] [["organism" [::stm/select-organism "D. rerio"]]
                         ["mode" [::stm/set-mode :same]]]]
    (run-test-sync
     (rf/dispatch [::seed (assoc seeded-db :results
                                 {:send-to-mine (assoc open-state :resolving? true :mode :orthologs
                                                       :organism "M. musculus")})])
     (rf/dispatch event)
     (testing (str "old response after changing " label " is dropped")
       (rf/dispatch [::stm/resolve-success :mouse 1 ["MGI:104537"] response])
       (let [state @(rf/subscribe [::state])]
         (is (nil? (:result state)))
         (is (false? (:resolving? state))))))))

(deftest run-counter-survives-reopening-panel
  (run-test-sync
   (utils/stub-local-storage)
   (rf/dispatch [::seed (assoc seeded-db :results {:send-to-mine open-state})])
   (rf/dispatch [::stm/toggle "L"])
   (rf/dispatch [::stm/toggle "L"])
   (let [run (:run @(rf/subscribe [::state]))]
     (is (> run 1))
     (rf/dispatch [::stm/select-mine ""])
     (is (> (:run @(rf/subscribe [::state])) run)))))

;;; Model gates ;;;

(def gene-model
  "Model with what both modes read in the current mine."
  {:Gene {:attributes {:id {} :primaryIdentifier {}}
          :references {:organism {:referencedType "Organism"}}
          :collections {:homologues {:referencedType "Homologue"}}}
   :Organism {:attributes {:shortName {}}}
   :Homologue {:references {:homologue {:referencedType "Gene"}}}})

(def no-homologues-model
  (update gene-model :Gene dissoc :collections))

(deftest source-gate
  (testing "same genes only needs Gene.primaryIdentifier"
    (is (nil? (stm/source-blocked-reason no-homologues-model "WormMine" :same))))
  (testing "orthologs need the homologue's identifier and organism"
    (is (nil? (stm/source-blocked-reason gene-model "AllianceMine" :orthologs)))
    (is (= "ToyMine has no Gene.homologues.homologue.primaryIdentifier, Gene.homologues.homologue.organism.shortName"
           (stm/source-blocked-reason no-homologues-model "ToyMine" :orthologs))))
  (testing "an unknown model blocks nothing"
    (is (nil? (stm/source-blocked-reason nil "ToyMine" :orthologs)))))

(deftest target-gate
  (testing "a target needs Gene.id and Gene.organism.shortName"
    (is (nil? (stm/target-blocked-reason gene-model "WormMine")))
    (is (= "ToyMine has no Gene.organism.shortName"
           (stm/target-blocked-reason {:Gene {:attributes {:id {}}}} "ToyMine")))
    (is (= "ToyMine has no Gene.id, Gene.organism.shortName"
           (stm/target-blocked-reason {:Gene {:attributes {}}} "ToyMine"))))
  (testing "an unknown model blocks nothing"
    (is (nil? (stm/target-blocked-reason nil "ToyMine")))))

(deftest target-mines-carry-the-reason
  (run-test-sync
   (rf/dispatch [::seed (-> seeded-db
                            (assoc-in [:env :mines :worm] {:name "Worm" :service {:root "http://worm.example"}})
                            (assoc-in [:mine-models :worm :classes] {:Gene {:attributes {:id {}}}})
                            (assoc-in [:mine-models :mouse :classes] gene-model))])
   (is (= [{:id :mouse :label "Mouse"}
           {:id :worm :label "Worm" :reason "Worm has no Gene.organism.shortName"}]
          @(rf/subscribe [::stm/target-mines])))))

(deftest orthologs-mode-reason-follows-the-current-mine
  (run-test-sync
   (rf/dispatch [::seed (assoc-in seeded-db [:mines :main :service :model :classes] no-homologues-model)])
   (is (= [:orthologs] (keys @(rf/subscribe [::stm/source-reasons]))))
   (rf/dispatch [::seed (assoc-in seeded-db [:mines :main :service :model :classes] gene-model)])
   (is (= {} @(rf/subscribe [::stm/source-reasons])))))

(deftest resolve-does-not-run-against-a-blocked-model
  (run-test-sync
   (let [fetched (atom 0)]
     (rf/dispatch [::seed (-> seeded-db
                              (assoc-in [:mine-models :mouse :classes] {:Gene {:attributes {}}})
                              (assoc :results {:send-to-mine (assoc open-state :mode :same)}))])
     (with-redefs [fetch/rows (fn [& _] (swap! fetched inc) (async/chan))]
       (rf/dispatch [::stm/resolve]))
     (is (zero? @fetched))
     (is (nil? (:resolving? @(rf/subscribe [::state])))))))
