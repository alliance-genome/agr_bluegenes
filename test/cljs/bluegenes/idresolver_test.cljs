(ns bluegenes.idresolver-test
  (:require [cljs.test :refer-macros [deftest is testing use-fixtures]]
            [bluegenes.test-utils :as utils]
            [re-frame.core :as rf]
            [day8.re-frame.test :refer-macros [run-test-sync]]
            [bluegenes.components.idresolver.events :as evts]))

(use-fixtures :each utils/fixtures)

(defn- duplicates [n]
  (mapv (fn [i] {:input [(str "id" i)]
                 :matches [{:id (* 10 i)} {:id (inc (* 10 i))}]})
        (range n)))

(deftest toggle-keep-duplicate-uses-absolute-index
  (run-test-sync
   (rf/reg-sub ::dups #(get-in % [:idresolver :response :matches :DUPLICATE]))
   (rf/dispatch [::evts/store-identifiers "Gene" nil
                 {:matches {:DUPLICATE (duplicates 7)}}])
   (testing "an index past the first page toggles only that row"
     ;; Row 1 of page 2 with 5 rows per page is absolute index 6.
     (rf/dispatch [::evts/toggle-keep-duplicate 6 1])
     (let [dups @(rf/subscribe [::dups])]
       (is (true? (get-in dups [6 :matches 1 :keep?])))
       (is (empty? (filter :keep? (mapcat :matches (subvec dups 0 6)))))))))
