(ns bluegenes.reportpage-test
  (:require [cljs.test :refer-macros [deftest is testing use-fixtures]]
            [bluegenes.test-utils :as utils]
            [re-frame.core :as rf]
            [re-frame.db :refer [app-db]]
            [day8.re-frame.test :refer-macros [run-test-sync]]
            [bluegenes.pages.reportpage.events :as events]))

(use-fixtures :each utils/fixtures)

(rf/reg-event-db
 ::seed-db
 (fn [_ [_ db]] db))

(deftest stale-report-responses
  (run-test-sync
   (rf/dispatch [::seed-db {:report {:key [:biotestmine "Gene" 2]}}])
   (testing "responses for an earlier report are dropped"
     (rf/dispatch [::events/handle-lists [:biotestmine "Gene" 1] ["stale"]])
     (rf/dispatch [:handle-fasta [:biotestmine "Gene" 1] ">stale"])
     (rf/dispatch [:fetch-report-failure [:biotestmine "Gene" 1] {}])
     (rf/dispatch [:handle-report-summary :biotestmine "Gene" 1 {:results [[1]]}])
     (is (= {:key [:biotestmine "Gene" 2]} (:report @app-db))))
   (testing "responses for the current report are stored"
     (rf/dispatch [::events/handle-lists [:biotestmine "Gene" 2] ["fresh"]])
     (rf/dispatch [:handle-fasta [:biotestmine "Gene" 2] ">fresh"])
     (is (= ["fresh"] (get-in @app-db [:report :lists])))
     (is (= ">fresh" (get-in @app-db [:report :fasta]))))))
