(ns bluegenes.querybuilder-test
  (:require [cljs.test :refer-macros [deftest is are testing use-fixtures]]
            [re-frame.core :as rf]
            [re-frame.db :as rf-db]
            [day8.re-frame.test :refer-macros [run-test-sync]]
            [bluegenes.test-utils :as utils]
            [bluegenes.pages.querybuilder.logic :as logic]
            [bluegenes.pages.querybuilder.events :as events]))

(use-fixtures :each utils/fixtures)

(def qb-menu
  {"Gene" {"alleles" {}
           "childFeatures" {"organism" {}
                            :subclass "Chromosome"
                            "locations" {}}
           "chromosome" {}
           "interactions" {"participant2" {:subclass "Gene"}}}})

(def qb-menu-multiple-parent-subclasses
  {"Gene" {"alleles" {}
           "childFeatures" {"organism" {}
                            :subclass "Chromosome"
                            "locations" {}}
           "chromosome" {}
           "interactions" {"participant2" {:subclass "Gene"
                                           "childFeatures" {:subclass "Allele"}}}}})

(def qb-menu-no-subclass
  {"Gene" {"alleles" {}
           "childFeatures" {"organism" {}
                            "locations" {}}
           "chromosome" {}
           "interactions" {"participant2" {}}}})

(deftest qb-menu->type-constraints
  (is (= (logic/qb-menu->type-constraints qb-menu)
         [{:path "Gene.childFeatures", :type "Chromosome"}
          {:path "Gene.interactions.participant2", :type "Gene"}]))
  (is (= (logic/qb-menu->type-constraints qb-menu-no-subclass)
         [])))

(deftest get-all-subclasses
  (is (= (events/get-all-subclasses qb-menu-multiple-parent-subclasses
                                    ["Gene" "interactions" "participant2" "childFeatures" "name"])
         '([["Gene" "interactions" "participant2" "childFeatures"] "Allele"]
           [["Gene" "interactions" "participant2"] "Gene"]))))

(deftest remove-code
  (testing "nil or empty logic stays empty"
    (is (nil? (logic/remove-code nil 'A)))
    (is (nil? (logic/remove-code '() 'A)))
    (is (nil? (logic/remove-code [] 'A))))
  (testing "removing codes"
    (is (= '[B] (logic/remove-code '[A and B] 'A)))
    (is (= '[A or C] (logic/remove-code '[A or [B and C]] 'B)))
    (is (= [] (logic/remove-code '[A] 'A))))
  (testing "appending after removing the last code starts a new logic"
    (is (= '[B] (logic/append-code (logic/remove-code '[A] 'A) 'B)))
    (is (= '[B] (logic/append-code (logic/remove-code nil 'A) 'B)))))

(deftest append-code
  (is (= '[A] (logic/append-code nil 'A)))
  (is (= '[A and B] (logic/append-code '[A] 'B)))
  (is (= '[[A or B] and C] (logic/append-code '[A or B] 'C))))

(deftest parse-logic-string
  (testing "valid input"
    (is (= [] (logic/parse-logic-string "")))
    (is (= [] (logic/parse-logic-string "  ")))
    (is (= '[A] (logic/parse-logic-string "A")))
    (is (= '[A] (logic/parse-logic-string "(A)")))
    (is (= '[A and B] (logic/parse-logic-string "A and B")))
    (is (= '[A and B] (logic/parse-logic-string "A AND B")))
    (is (= '[A or [B and C]] (logic/parse-logic-string "A or (B and C)")))
    (is (= '[[A and B] or [C and D]] (logic/parse-logic-string "(A and B) or (C and D)"))))
  (testing "invalid input returns nil without throwing"
    (are [s] (nil? (logic/parse-logic-string s))
      "A and (B"
      "A) or (B"
      "A and 1"
      "A and"
      "or A"
      "A B"
      "A and and B"
      "[A] or [B]"
      "A and {B}"
      "()")))

(deftest logic-codes
  (is (= #{"A" "B" "C"} (logic/logic-codes '[A or [B and C]])))
  (is (= #{} (logic/logic-codes []))))

(deftest constraint-key
  (is (= ["Gene.symbol" "A"]
         (logic/constraint-key {:path "Gene.symbol" :code "A" :op "=" :value "x"}))))

(def qb-db
  {:current-mine :default
   :mines {:default {:service {:root "http://localhost/mine" :model {}}}}
   :qb {:root-class :Gene
        :enhance-query {"Gene" {"symbol" {:visible true}
                                "name" {:visible true}
                                "organism" {"name" {:constraints [{:code "A" :op "=" :value "M. musculus"}]}}}}
        :order ["Gene.symbol" "Gene.name"]
        :constraint-logic '[A]
        :joins #{}}})

(defn- setup-qb-db []
  (rf/reg-event-db ::set-db (fn [_ _] qb-db))
  (rf/reg-fx :im-chan (fn [_]))
  (rf/reg-event-fx :messages/add (fn [_ _] {}))
  (rf/dispatch [::set-db]))

(deftest enhance-query-remove-view
  (run-test-sync
   (setup-qb-db)
   (rf/dispatch [:qb/enhance-query-remove-view ["Gene" "name"]])
   (let [qb (:qb @rf-db/app-db)]
     (testing "constraint-only paths are not added to the order"
       (is (= ["Gene.symbol"] (:order qb)))
       (is (= ["Gene.symbol"] (get-in qb [:im-query :select]))))
     (testing "the constraint on a non-selected path is kept"
       (is (= '[A] (:constraint-logic qb)))
       (is (= ["Gene.organism.name"] (map :path (get-in qb [:im-query :where]))))))))

(deftest format-constraint-logic
  (run-test-sync
   (setup-qb-db)
   (testing "invalid input leaves the logic unchanged"
     (rf/dispatch [:qb/format-constraint-logic "A and (B"])
     (is (= '[A] (get-in @rf-db/app-db [:qb :constraint-logic])))
     (rf/dispatch [:qb/format-constraint-logic "A or Z"])
     (is (= '[A] (get-in @rf-db/app-db [:qb :constraint-logic]))))
   (testing "missing codes are appended"
     (rf/dispatch [:qb/format-constraint-logic ""])
     (is (= '[A] (get-in @rf-db/app-db [:qb :constraint-logic]))))))
