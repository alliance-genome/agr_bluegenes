(ns bluegenes.cart-test
  (:require [cljs.test :refer-macros [deftest is testing use-fixtures]]
            [bluegenes.test-utils :as utils :refer [stub-fetch-fn]]
            [re-frame.core :as rf]
            [day8.re-frame.test :refer-macros [run-test-sync run-test-async wait-for]]
            [imcljs.fetch :as fetch]
            [imcljs.save :as save]
            [bluegenes.subs]
            [bluegenes.components.cart :as cart]))

(use-fixtures :each utils/fixtures)

(def brca1 {:mine :main :class "Gene" :id "8000268" :primaryIdentifier "MGI:104537"
            :symbol "Brca1" :organism "M. musculus"})
(def tp53 {:mine :human :class "Gene" :id "8000038" :primaryIdentifier "HGNC:11998"
           :symbol "TP53" :organism "H. sapiens"})
(def atm {:mine :main :class "Gene" :id "8000200" :primaryIdentifier "MGI:107202"
          :symbol "Atm" :organism "M. musculus"})

(deftest add-remove-dedupe
  (testing "add appends and ignores an item with the same key"
    (is (= [brca1 tp53] (cart/add-item [brca1] tp53)))
    (is (= [brca1] (cart/add-item [brca1] brca1)))
    (is (= [brca1] (cart/add-item [brca1] (assoc brca1 :id 8000268)))
        "id type does not matter"))
  (testing "same id in another mine is another item"
    (is (= 2 (count (cart/add-item [brca1] (assoc brca1 :mine :human))))))
  (testing "remove by key"
    (is (= [tp53] (cart/remove-item [brca1 tp53] (cart/item-key brca1))))
    (is (= [brca1] (cart/remove-item [brca1] (cart/item-key tp53)))))
  (testing "dedupe keeps the first of duplicates, in order"
    (is (= [brca1 tp53] (cart/dedupe-items [brca1 tp53 (assoc brca1 :symbol "x")]))))
  (testing "membership"
    (is (true? (cart/in-cart? [brca1] brca1)))
    (is (false? (cart/in-cart? [brca1] tp53)))
    (is (false? (cart/in-cart? [] tp53)))))

(deftest sanitize-stored
  (is (= [brca1] (cart/sanitize [brca1 brca1 {:mine "x"} nil "s" {:mine :a :id 1}])))
  (is (= [] (cart/sanitize nil)))
  (is (= [] (cart/sanitize {:not "a vector"}))))

(deftest grouping
  (is (= [[:main [brca1 atm]] [:human [tp53]]]
         (cart/group-by-mine [brca1 tp53 atm])))
  (is (= [] (cart/group-by-mine [])))
  (is (= [brca1 atm] (cart/mine-items [brca1 tp53 atm] :main)))
  (is (= [tp53] (cart/foreign-items [brca1 tp53 atm] :main))))

(deftest ids-and-identifiers
  (is (= ["8000268" "8000200"] (cart/object-ids [brca1 atm brca1])))
  (is (= ["MGI:104537"] (cart/source-identifiers [brca1 (assoc atm :primaryIdentifier nil)
                                                  (assoc atm :primaryIdentifier "") brca1])))
  (is (= ["8000268" "8000200"] (cart/combine-object-ids ["8000268"] [8000200 8000268]))))

(deftest report-summary-to-item
  (let [summary {:views ["Gene.primaryIdentifier" "Gene.symbol" "Gene.organism.shortName"]
                 :results [["MGI:104537" "Brca1" "M. musculus"]]}]
    (is (= brca1 (cart/summary->item :main "Gene" 8000268 summary)))
    (is (nil? (cart/summary->item :main "Gene" 1 {:views [] :results []})))
    (is (= {:mine :main :class "Gene" :id "1" :primaryIdentifier "X" :symbol nil :organism "Human"}
           (cart/summary->item :main "Gene" 1 {:views ["Gene.primaryIdentifier" "Gene.symbol" "Gene.organism.name"]
                                               :results [["X" "" "Human"]]}))
        "blank symbol is nil and organism falls back to its name")))

(deftest labels-and-names
  (is (= "Brca1" (cart/item-label brca1)))
  (is (= "MGI:1" (cart/item-label {:primaryIdentifier "MGI:1" :id "1"})))
  (is (= "7" (cart/item-label {:id 7})))
  (is (= "Gene cart, 1 gene" (cart/default-list-name 1)))
  (is (= "Gene cart, 3 genes" (cart/default-list-name 3)))
  (is (= "mine" (cart/effective-list-name {:list-name "mine" :default-name "d"})))
  (is (= "" (cart/effective-list-name {:list-name "" :default-name "d"})))
  (is (= "d" (cart/effective-list-name {:default-name "d"}))))

(rf/reg-event-db ::seed (fn [_ [_ db]] db))

(def seeded-db
  {:current-mine :main
   :env {:mines {:main {:name "Main" :service {:root "http://main.example"}}
                 :human {:name "Human" :service {:root "http://human.example"}}}}
   :mines {:main {:name "Main" :service {:root "http://main.example" :model {:name "genomic"}}}}})

(defn- stored []
  (get @utils/stubbed-storage (str cart/storage-key)))

(deftest persistence
  (run-test-sync
   (utils/stub-local-storage)
   (rf/dispatch-sync [::cart/add brca1])
   (rf/dispatch-sync [::cart/add tp53])
   (rf/dispatch-sync [::cart/add brca1])
   (testing "items are mirrored in the db and persisted once each"
     (is (= [brca1 tp53] @(rf/subscribe [::cart/items])))
     (is (= [brca1 tp53] (stored)))
     (is (= 2 @(rf/subscribe [::cart/count]))))
   (testing "remove updates both"
     (rf/dispatch-sync [::cart/remove (cart/item-key brca1)])
     (is (= [tp53] (stored)))
     (is (= [tp53] @(rf/subscribe [::cart/items]))))
   (testing "load reads what storage holds"
     (reset! utils/stubbed-storage {(str cart/storage-key) [atm]})
     (rf/dispatch-sync [::cart/load])
     (is (= [atm] @(rf/subscribe [::cart/items]))))
   (testing "an add works on the stored items, as another tab may have changed them"
     (reset! utils/stubbed-storage {(str cart/storage-key) [atm]})
     (rf/dispatch-sync [::cart/add tp53])
     (is (= [atm tp53] (stored))))
   (testing "clear empties the cart"
     (rf/dispatch-sync [::cart/clear])
     (is (= [] (stored)))
     (is (= 0 @(rf/subscribe [::cart/count]))))))

(deftest groups-sub
  (run-test-sync
   (utils/stub-local-storage)
   (rf/dispatch-sync [::seed seeded-db])
   (rf/dispatch-sync [::cart/add tp53])
   (rf/dispatch-sync [::cart/add brca1])
   (rf/dispatch-sync [::cart/add (assoc atm :mine :gone)])
   (is (= [{:mine :human :label "Human" :items [tp53]}
           {:mine :main :label "Main" :items [brca1]}
           {:mine :gone :label "gone" :items [(assoc atm :mine :gone)]}]
          @(rf/subscribe [::cart/groups])))))

(deftest report-item-sub
  (run-test-sync
   (utils/stub-local-storage)
   (rf/dispatch-sync [::seed (assoc seeded-db :report
                                    {:key [:main "Gene" "8000268"]
                                     :summary {:views ["Gene.primaryIdentifier" "Gene.symbol" "Gene.organism.shortName"]
                                               :results [["MGI:104537" "Brca1" "M. musculus"]]}})])
   (is (= brca1 @(rf/subscribe [::cart/report-item])))
   (is (false? @(rf/subscribe [::cart/report-in-cart?])))
   (rf/dispatch-sync [::cart/add brca1])
   (is (true? @(rf/subscribe [::cart/report-in-cart?])))
   (testing "other classes have no item"
     (rf/dispatch-sync [::seed (assoc seeded-db :report {:key [:main "Allele" "1"] :summary {}})])
     (is (nil? @(rf/subscribe [::cart/report-item]))))))

(deftest save-needs-login
  (run-test-sync
   (utils/stub-local-storage)
   (rf/dispatch-sync [::seed seeded-db])
   (rf/dispatch-sync [::cart/add tp53])
   (with-redefs [fetch/lists (fn [& _] (throw (js/Error. "no request without a login")))]
     (rf/dispatch-sync [::cart/save :human]))
   (is (false? (:logged-in? @(rf/subscribe [::ui :human]))))
   (is (not (:saving? @(rf/subscribe [::ui :human]))))))

(rf/reg-sub ::ui (fn [db [_ scope]] (get-in db [:gene-cart :ui scope])))

(deftest save-as-list-in-its-own-mine
  (run-test-async
   (utils/stub-local-storage)
   (let [saved (atom nil)
         orig-lists fetch/lists
         orig-save save/im-list-from-query]
     (rf/reg-event-fx :messages/add (fn [_ _] {}))
     (rf/dispatch-sync [::seed seeded-db])
     (rf/dispatch-sync [:save-login :human {:token "human-token"}])
     (rf/dispatch-sync [::cart/add tp53])
     (rf/dispatch-sync [::cart/add brca1])
     (set! fetch/lists (stub-fetch-fn [{:name "Gene cart, 1 gene"}]))
     (set! save/im-list-from-query
           (fn [service name query]
             (reset! saved [service name query])
             ((stub-fetch-fn {:listName name}))))
     (swap! utils/stubbed-variables conj #(set! fetch/lists orig-lists))
     (swap! utils/stubbed-variables conj #(set! save/im-list-from-query orig-save))
     (rf/dispatch [::cart/save :human])
     (wait-for [::cart/saved]
       (let [[service name query] @saved]
         (is (= "human-token" (:token service)) "uses the login of that mine")
         (is (= "http://human.example" (:root service)))
         (is (= "Gene cart, 1 gene_1" name) "name clash gets a suffix")
         (is (= ["8000038"] (get-in query [:where 0 :values])) "only the ids of that mine"))
       (is (= {:name "Gene cart, 1 gene_1" :mine :human}
              (:saved @(rf/subscribe [::ui :human]))))))))

(deftest save-all-resolves-other-mines
  (run-test-async
   (utils/stub-local-storage)
   (let [saved (atom nil)
         resolve-args (atom nil)
         orig-lists fetch/lists
         orig-resolve fetch/resolve-identifiers
         orig-save save/im-list-from-query]
     (rf/reg-event-fx :messages/add (fn [_ _] {}))
     (rf/dispatch-sync [::seed seeded-db])
     (rf/dispatch-sync [:save-login :main {:token "main-token"}])
     (rf/dispatch-sync [::cart/add brca1])
     (rf/dispatch-sync [::cart/add tp53])
     (set! fetch/resolve-identifiers
           (fn [service opts]
             (reset! resolve-args [service opts])
             ((stub-fetch-fn {:matches {:MATCH [{:input ["HGNC:11998"] :id 77}]}}))))
     (set! fetch/lists (stub-fetch-fn []))
     (set! save/im-list-from-query
           (fn [service name query]
             (reset! saved [service name query])
             ((stub-fetch-fn {:listName name}))))
     (swap! utils/stubbed-variables conj #(set! fetch/lists orig-lists))
     (swap! utils/stubbed-variables conj #(set! fetch/resolve-identifiers orig-resolve))
     (swap! utils/stubbed-variables conj #(set! save/im-list-from-query orig-save))
     (rf/dispatch [::cart/save :all])
     (wait-for [::cart/saved]
       (let [[service opts] @resolve-args]
         (is (= "http://main.example" (:root service)) "resolved in the current mine")
         (is (= ["HGNC:11998" "11998"] (:identifiers opts)) "uses the send-to-mine candidates")
         (is (= "Gene" (:type opts))))
       (let [[_ name query] @saved]
         (is (= "Gene cart, 2 genes" name))
         (is (= ["8000268" "77"] (get-in query [:where 0 :values]))
             "own ids first, then the resolved ids")
         (is (= {:name "Gene cart, 2 genes" :mine :main}
                (:saved @(rf/subscribe [::ui :all])))))))))
