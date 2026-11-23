(ns bluegenes.lists-upset-test
  (:require [cljs.test :refer-macros [deftest is testing use-fixtures]]
            [clojure.core.async :as async]
            [re-frame.core :as rf]
            [reagent.core :as r]
            [reagent.ratom :as ratom]
            [day8.re-frame.test :refer-macros [run-test-sync]]
            [imcljs.fetch :as fetch]
            [imcljs.save :as save]
            [bluegenes.test-utils :as utils :refer [stub-fetch-fn]]
            [bluegenes.pages.lists.upset :as upset]))

(use-fixtures :each utils/fixtures)

(def three-sets
  [{:name "a" :ids [1 2 3 4 5]}
   {:name "b" :ids [3 4 5 6]}
   {:name "c" :ids [5 6 7]}])

(deftest regions-of-three-sets
  (let [regions (upset/regions three-sets)
        by-members (into {} (map (juxt :members identity)) regions)]
    (testing "every non-empty exclusive region is present"
      (is (= #{[0] [0 1] [0 1 2] [1 2] [2]} (set (keys by-members)))))
    (testing "ids are exclusive to the region"
      (is (= [1 2] (:ids (by-members [0]))))
      (is (= [3 4] (:ids (by-members [0 1]))))
      (is (= [5] (:ids (by-members [0 1 2]))))
      (is (= [6] (:ids (by-members [1 2]))))
      (is (= [7] (:ids (by-members [2])))))
    (testing "region sizes add up to the size of the union"
      (is (= 7 (reduce + (map :size regions)))))
    (testing "sorted by size, then fewer members, then members"
      (is (= [[0] [0 1] [2] [1 2] [0 1 2]]
             (mapv :members regions)))
      (is (= [2 2 1 1 1] (mapv :size regions))))))

(deftest regions-edge-cases
  (testing "duplicate ids inside a set count once"
    (is (= [{:members [0] :ids [1 2] :size 2}]
           (upset/regions [{:name "a" :ids [1 1 2 2]}]))))
  (testing "empty sets give no regions"
    (is (= [] (upset/regions [{:name "a" :ids []} {:name "b" :ids []}]))))
  (testing "disjoint sets give one region each"
    (is (= [[0] [1]] (mapv :members (upset/regions [{:name "a" :ids [1]}
                                                    {:name "b" :ids [2]}])))))
  (testing "identical sets give the full intersection only"
    (is (= [{:members [0 1] :ids [1 2] :size 2}]
           (upset/regions [{:name "a" :ids [1 2]} {:name "b" :ids [2 1]}])))))

(deftest regions-of-five-sets
  (let [sets (mapv (fn [i] {:name (str i) :ids (range 0 31)}) (range 5))
        distinct-sets (mapv (fn [i]
                              {:name (str i)
                               :ids (filter #(bit-test % i) (range 1 32))})
                            (range 5))]
    (is (= 1 (count (upset/regions sets))))
    (testing "31 ids with distinct membership patterns give 31 regions"
      (is (= 31 (count (upset/regions distinct-sets))))
      (is (every? #(= 1 (:size %)) (upset/regions distinct-sets))))))

(deftest set-sizes
  (is (= [5 4 3] (upset/set-sizes three-sets)))
  (is (= [2] (upset/set-sizes [{:name "a" :ids [1 1 2]}]))))

(def gene-lists
  [{:name "a" :type "Gene" :size 10}
   {:name "b" :type "Gene" :size 20}])

(deftest selection-errors
  (is (nil? (upset/selection-error gene-lists)))
  (is (nil? (upset/selection-error (repeat 5 {:type "Gene" :size 1}))))
  (is (re-find #"at least 2" (upset/selection-error [(first gene-lists)])))
  (is (re-find #"at most 5" (upset/selection-error (repeat 6 {:type "Gene" :size 1}))))
  (is (re-find #"same type" (upset/selection-error [(first gene-lists)
                                                    {:name "p" :type "Protein" :size 1}])))
  (is (re-find #"more than 1000 items"
               (upset/selection-error [(first gene-lists)
                                       {:name "big" :type "Gene" :size 1001}]
                                      1000))))

(deftest queries
  (is (= {:from "Gene"
          :select ["Gene.id"]
          :where [{:path "Gene" :op "IN" :value "my list"}]}
         (upset/ids-query "Gene" "my list")))
  (is (= {:from "Gene"
          :select ["Gene.id"]
          :where [{:path "Gene.id" :op "ONE OF" :values ["1" "2"]}]}
         (upset/ids-by-id-query "Gene" [1 2]))))

(deftest default-names
  (is (= "a and b" (upset/region-title ["a" "b"] [0 1] 2)))
  (is (= "a only" (upset/region-title ["a" "b"] [0] 2)))
  (is (= "a, b and c" (upset/region-title ["a" "b" "c"] [0 1 2] 3)))
  (is (= "b and c only" (upset/region-title ["a" "b" "c"] [1 2] 3))))

(deftest geometry
  (let [regions (upset/regions three-sets)
        {:keys [bars rows set-bars width height]} (upset/geometry three-sets regions)]
    (is (= 5 (count bars)))
    (is (= 3 (count rows)))
    (is (= 3 (count set-bars)))
    (testing "the tallest bar and the largest set bar fill their maximum"
      (is (= (apply max (map :h bars)) (:h (first bars))))
      (is (= (apply max (map :w set-bars)) (:w (first set-bars)))))
    (testing "bar heights follow region sizes"
      (is (= (:h (first bars)) (* 2 (:h (nth bars 2))))))
    (testing "every drawn element stays inside the canvas"
      (is (every? #(<= (+ (:x %) (:w %)) width) bars))
      (is (every? #(<= (:cy %) height) rows)))))

(deftest assign-ids-by-list-name
  (let [state {:loading? true :lists [{:name "a"} {:name "b"}]}
        after-b (upset/assign-ids state "b" {:results [[7] [8]]})
        after-a (upset/assign-ids after-b "a" {:results [[1]]})]
    (is (= [{:name "a"} {:name "b" :ids [7 8]}] (:lists after-b)))
    (is (true? (:loading? after-b)))
    (is (= [{:name "a" :ids [1]} {:name "b" :ids [7 8]}] (:lists after-a)))
    (is (false? (:loading? after-a)))))

(deftest tiny-regions-keep-a-visible-bar
  (let [sets [{:name "a" :ids (range 5000)}
              {:name "b" :ids [0 99999]}]
        {:keys [bars]} (upset/geometry sets (upset/regions sets))
        by-size (into {} (map (juxt :size identity)) bars)]
    (is (= 130 (:h (by-size 4999))))
    (is (>= (:h (by-size 1)) 2))
    (is (= (+ 20 130) (+ (:y (by-size 1)) (:h (by-size 1)))))))

(deftest selection-error-names-lists
  (let [msg (upset/selection-error [{:name "a" :title "Human genes" :type "Gene" :size 1}
                                    {:name "p" :type "Protein" :size 1}])]
    (is (re-find #"Human genes \(Gene\)" msg))
    (is (re-find #"p \(Protein\)" msg))))

(deftest inclusive-selection
  (let [regions (upset/regions three-sets)]
    (is (= [5] (upset/selected-ids regions [0 1 2] false)))
    (is (= [3 4] (upset/selected-ids regions [0 1] false)))
    (is (= [3 4 5] (upset/selected-ids regions [0 1] true)))
    (is (= [3 4 5 6] (upset/selected-ids regions [1] true)))
    (is (= [1 2] (upset/selected-ids regions [0] false)))))

(deftest region-heading-pluralises
  (is (= "1 item in a and b only" (upset/region-heading ["a" "b" "c"] [0 1] 3 1 false)))
  (is (= "2 items in a and b" (upset/region-heading ["a" "b" "c"] [0 1] 3 2 true)))
  (is (= "3 items in a and b" (upset/region-heading ["a" "b"] [0 1] 2 3 false))))

(defn- seed-db [db _]
  (assoc db
         :current-mine :main
         :mines {:main {:service {:root "http://mine.example"}}}
         :assets {:lists {:main [{:name "A and B"}]}}
         :lists {:by-id {"a" {:name "a" :title "A" :type "Gene" :size 3}
                         "b" {:name "b" :title "B" :type "Gene" :size 2}}
                 :selected-lists ["a" "b"]}))

(rf/reg-event-db ::seed seed-db)
(rf/reg-sub ::upset-state (fn [db _] (get db :lists-upset)))
(rf/reg-sub ::upset-token (fn [db _] (get db :lists-upset-token)))

(defn- stub-rows []
  (let [orig fetch/rows]
    (set! fetch/rows (fn [_ _ _] (async/chan)))
    (swap! utils/stubbed-variables conj #(set! fetch/rows orig))))

(def ^:private seeded-db (seed-db {} nil))

(defn- opened []
  (:db (upset/open-fx {:db seeded-db} [::upset/open])))

(defn- token-of [db] (get-in db [:lists-upset :token]))

(deftest failures-keep-the-panel-and-toast-once
  (let [db (opened)
        token (token-of db)
        first-fail (upset/failure-fx {:db db} [::upset/failure token {}])
        db' (:db first-fail)
        again (upset/failure-fx {:db db'} [::upset/failure token {}])]
    (is (some? (:dispatch first-fail)))
    (is (true? (get-in db' [:lists-upset :open?])))
    (is (true? (get-in db' [:lists-upset :failed?])))
    (is (false? (get-in db' [:lists-upset :loading?])))
    (is (nil? again))))

(deftest stale-responses-are-ignored
  (let [old-db (opened)
        old (token-of old-db)
        failed (:db (upset/failure-fx {:db old-db} [::upset/failure old {}]))
        new-db (:db (upset/open-fx {:db failed} [::upset/open]))
        new (token-of new-db)]
    (is (not= old new))
    (is (nil? (upset/failure-fx {:db new-db} [::upset/failure old {}])))
    (is (= new-db (upset/loaded-db new-db [::upset/loaded old "a" {:results [[1]]}])))
    (is (true? (get-in new-db [:lists-upset :loading?])))
    (is (= [1] (get-in (upset/loaded-db new-db [::upset/loaded new "a" {:results [[1]]}])
                       [:lists-upset :lists 0 :ids])))))

(deftest open-while-loading-does-not-refetch
  (let [{:keys [db dispatch-n]} (upset/open-fx {:db seeded-db} [::upset/open])]
    (is (= 2 (count dispatch-n)))
    (is (nil? (upset/open-fx {:db db} [::upset/open])))))

(deftest typing-a-name-does-not-recompute-regions
  (run-test-sync
   (stub-rows)
   (rf/dispatch-sync [::seed])
   (rf/dispatch-sync [::upset/open])
   (let [token @(rf/subscribe [::upset-token])
         calls (atom 0)
         orig upset/regions]
     (set! upset/regions (fn [lists] (swap! calls inc) (orig lists)))
     (swap! utils/stubbed-variables conj #(set! upset/regions orig))
     (let [live (ratom/run! @(rf/subscribe [::upset/view-data]))]
       (rf/dispatch-sync [::upset/loaded token "a" {:results [[1] [2] [3]]}])
       (rf/dispatch-sync [::upset/loaded token "b" {:results [[3] [4]]}])
       (r/flush)
       (let [before @calls]
         (rf/dispatch-sync [::upset/set-list-name "x"])
         (rf/dispatch-sync [::upset/set-list-name "xy"])
         (r/flush)
         (is (pos? before))
         (is (= before @calls)))
       (ratom/dispose! live)))))

(deftest save-avoids-name-collision-and-region-change-clears-note
  (run-test-sync
   (let [saved (atom nil)
         orig save/im-list-from-query]
     (rf/reg-event-fx :assets/fetch-lists (fn [_ _] {}))
     (stub-rows)
     (set! save/im-list-from-query
           (fn [_ name query]
             (reset! saved [name query])
             ((stub-fetch-fn {:listName name}))))
     (swap! utils/stubbed-variables conj #(set! save/im-list-from-query orig))
     (rf/dispatch-sync [::seed])
     (rf/dispatch-sync [::upset/open])
     (let [token @(rf/subscribe [::upset-token])]
       (rf/dispatch-sync [::upset/loaded token "a" {:results [[1] [2] [3]]}])
       (rf/dispatch-sync [::upset/loaded token "b" {:results [[3] [4]]}])
       (rf/dispatch-sync [::upset/select-region [0 1]])
       (rf/dispatch-sync [::upset/set-inclusive true])
       (rf/dispatch-sync [::upset/save])
       (is (= "A and B_1" (first @saved)))
       (is (= ["3"] (get-in (second @saved) [:where 0 :values])))
       (rf/dispatch-sync [::upset/save-success {:listName "A and B_1"}])
       (is (= "A and B_1" (:saved @(rf/subscribe [::upset-state]))))
       (rf/dispatch-sync [::upset/select-region [0]])
       (is (nil? (:saved @(rf/subscribe [::upset-state]))))))))
