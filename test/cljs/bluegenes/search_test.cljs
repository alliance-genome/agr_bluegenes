(ns bluegenes.search-test
  (:require [cljs.test :refer-macros [deftest is testing use-fixtures]]
            [bluegenes.test-utils :as utils]
            [re-frame.core :as rf]
            [re-frame.db :refer [app-db]]
            [day8.re-frame.test :refer-macros [run-test-sync]]
            [bluegenes.events]
            [bluegenes.components.search.events]))

(use-fixtures :each utils/fixtures)

(rf/reg-event-db
 ::seed-db
 (fn [_ [_ db]] db))

(deftest stale-page-responses
  (run-test-sync
   (rf/dispatch [::seed-db {:search-results {:generation 2
                                             :results [:a]
                                             :count 10
                                             :loading-more? true
                                             :loading-remaining? true}}])
   (testing "pages from an earlier search are dropped"
     (rf/dispatch [:search/save-more-results 1 {:results [:stale]}])
     (rf/dispatch [:search/save-remaining-results 1 {:on-success nil} {:results [:stale]}])
     (rf/dispatch [:search/more-results-failure 1 {}])
     (is (= [:a] (get-in @app-db [:search-results :results])))
     (is (true? (get-in @app-db [:search-results :loading-more?]))))
   (testing "failures for the current search clear the loading flags"
     (rf/dispatch [:search/more-results-failure 2 {}])
     (rf/dispatch [:search/remaining-results-failure 2 {}])
     (is (false? (get-in @app-db [:search-results :loading-more?])))
     (is (false? (get-in @app-db [:search-results :loading-remaining?]))))))

(deftest select-all-stops-on-empty-page
  (run-test-sync
   (rf/dispatch [::seed-db {:search-results {:generation 1
                                             :results [:a :b]
                                             :count 5
                                             :loading-remaining? true}}])
   (rf/dispatch [:search/save-remaining-results 1
                 {:on-success [:search/select-all-results]}
                 {:results []}])
   (is (= 2 (get-in @app-db [:search-results :count])))
   (is (false? (get-in @app-db [:search-results :loading-remaining?])))
   (is (= #{:a :b} (get-in @app-db [:search :selected-results])))))

(deftest new-suggestions-reset-selection
  (run-test-sync
   (rf/dispatch [::seed-db {:quicksearch-selected-index 3}])
   (rf/dispatch [:handle-suggestions {:results [:x]}])
   (is (= -1 (:quicksearch-selected-index @app-db)))))
