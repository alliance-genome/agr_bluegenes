(ns bluegenes.lists-upset-test
  (:require [cljs.test :refer-macros [deftest is testing]]
            [bluegenes.pages.lists.upset :as upset]))

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
