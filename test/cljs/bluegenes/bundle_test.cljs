(ns bluegenes.bundle-test
  (:require [cljs.test :refer-macros [deftest is testing use-fixtures]]
            [bluegenes.test-utils :as utils]
            [re-frame.core :as rf]
            [re-frame.db :refer [app-db]]
            [day8.re-frame.test :refer-macros [run-test-sync]]
            [bluegenes.pages.results.bundle :as bundle]))

(use-fixtures :each utils/fixtures)

(deftest file-names
  (is (= "My_list_bundle.zip" (bundle/file-name "My list")))
  (is (= "a_b_bundle.zip" (bundle/file-name "a/b")))
  (is (= "list_bundle.zip" (bundle/file-name nil))))

(deftest request-bodies
  (is (= {:root "http://m/mine" :listName "L" :token "t"}
         (bundle/request-body {:root "http://m/mine" :token "t"} "L")))
  (testing "no token key when logged out"
    (is (= {:root "http://m/mine" :listName "L"}
           (bundle/request-body {:root "http://m/mine"} "L")))))

(deftest size-cap
  (is (not (bundle/too-large? 5000)))
  (is (bundle/too-large? 5001))
  (is (not (bundle/too-large? nil))))

(deftest error-messages
  (is (= "Unknown mine." (bundle/error-message 400 {:error "Unknown mine."})))
  (is (= "The download failed (status 500)." (bundle/error-message 500 nil))))

(deftest download-event
  (run-test-sync
   (reset! app-db {:current-mine :m
                   :mines {:m {:service {:root "http://m/mine" :token "t"}}}})
   (let [fx (atom nil)]
     (rf/reg-fx ::bundle/download #(reset! fx %))
     (rf/dispatch-sync [::bundle/download "L"])
     (is (:downloading? @(rf/subscribe [::bundle/state])))
     (is (= "L_bundle.zip" (:filename @fx)))
     (is (= {:root "http://m/mine" :listName "L" :token "t"} (:body @fx)))
     (rf/dispatch-sync [::bundle/download-failure "boom"])
     (is (= {:error "boom"} @(rf/subscribe [::bundle/state])))
     (rf/dispatch-sync [::bundle/download-success])
     (is (nil? @(rf/subscribe [::bundle/state]))))))
