(ns bluegenes.mine-logo-test
  (:require [cljs.test :refer [deftest is testing]]
            [bluegenes.components.navbar.nav :as nav]))

(def mine
  {:name "AllianceMine"
   :service {:root "https://am.example.org/alliancemine"}
   :logo "/images/mines/alliancemine-icon.png"
   :wordmark "/images/mines/alliancemine-wordmark.png"})

(deftest config-asset-url-test
  (testing "paths go under the deploy path"
    (is (= "/bluegenes/images/a.png" (nav/config-asset-url "/bluegenes" "/images/a.png")))
    (is (= "/images/a.png" (nav/config-asset-url nil "/images/a.png"))))
  (testing "absolute URLs are kept"
    (is (= "https://x.org/a.png" (nav/config-asset-url "/bluegenes" "https://x.org/a.png"))))
  (testing "blank gives nil"
    (is (nil? (nav/config-asset-url "/bluegenes" nil)))
    (is (nil? (nav/config-asset-url "/bluegenes" "")))))

(deftest mine-icon-src-test
  (testing "configured logo wins over branding"
    (is (= "/bluegenes/images/mines/alliancemine-icon.png"
           (nav/mine-icon-src (assoc-in mine [:branding :images :logo] "https://b/logo.png")
                              "/bluegenes"))))
  (testing "branding logo is used without a configured one"
    (is (= "https://b/logo.png"
           (nav/mine-icon-src {:service {:root "https://m"}
                               :branding {:images {:logo "https://b/logo.png"}}}
                              "/bluegenes"))))
  (testing "registry logo is used without a configured one"
    (is (= "https://r/logo.png"
           (nav/mine-icon-src {:url "https://m" :images {:logo "https://r/logo.png"}}
                              "/bluegenes"))))
  (testing "falls back to the service root logo"
    (is (= "https://m/model/images/logo.png"
           (nav/mine-icon-src {:service {:root "https://m"}} "/bluegenes")))
    (is (= "https://m/model/images/logo.png"
           (nav/mine-icon-src {:service {:root "https://m"}
                               :images {:logo nav/ignore-logo-path}}
                              "/bluegenes")))))

(deftest mine-wordmark-src-test
  (is (= "/bluegenes/images/mines/alliancemine-wordmark.png"
         (nav/mine-wordmark-src mine "/bluegenes")))
  (is (nil? (nav/mine-wordmark-src (dissoc mine :wordmark) "/bluegenes")))
  (is (nil? (nav/mine-wordmark-src {:name "YeastMine"} "/bluegenes"))))
