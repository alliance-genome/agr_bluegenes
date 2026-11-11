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

(def base-classes
  {:SequenceFeature {:attributes {:primaryIdentifier {} :symbol {}}
                     :references {:organism {:referencedType "Organism"}}}
   :Organism {:attributes {:shortName {}}}
   :Gene {:extends ["SequenceFeature"]
          :collections {:homologues {:referencedType "Homologue"}}}
   :Homologue {:references {:homologue {:referencedType "Gene"}}}})

(deftest model-support
  (testing "WormMine, FlyMine and YeastMine shaped models get the button"
    (is (bundle/supports-bundle? {:classes base-classes}))
    (is (bundle/supports-bundle? {:classes (assoc base-classes :PhenotypeAnnotation {})})
        "an annotation class without the subject path changes nothing"))
  (testing "no homologues or no Gene hides it"
    (is (not (bundle/supports-bundle? {:classes (update base-classes :Gene dissoc :collections)})))
    (is (not (bundle/supports-bundle? {:classes (dissoc base-classes :Gene)})))
    (is (not (bundle/supports-bundle? nil)))))

(deftest path-resolution
  (is (bundle/path-resolves? base-classes "Gene.symbol") "inherited")
  (is (bundle/path-resolves? base-classes "Gene.homologues.homologue.organism.shortName"))
  (is (not (bundle/path-resolves? base-classes "Gene.homologues.isBestScore")))
  (is (not (bundle/path-resolves? base-classes "Gene.symbol.x"))))

(deftest error-messages
  (is (= "Unknown mine." (bundle/error-message 400 {:error "Unknown mine."})))
  (is (= "The download failed (status 500)." (bundle/error-message 500 nil))))

(deftest download-event
  ;; The page normally defines serverVars; config/server-vars reads it.
  (when-not (exists? js/serverVars)
    (set! (.-serverVars js/window) "{}"))
  (run-test-sync
   (reset! app-db {:current-mine :m
                   :mines {:m {:service {:root "http://m/mine" :token "t"}}}})
   (let [fx (atom nil)]
     (rf/reg-fx ::bundle/download #(reset! fx %))
     (rf/dispatch-sync [::bundle/download "L"])
     (is (:downloading? @(rf/subscribe [::bundle/state "L"])))
     (is (= "L_bundle.zip" (:filename @fx)))
     (is (= {:root "http://m/mine" :listName "L" :token "t"} (:body @fx)))
     (rf/dispatch-sync [::bundle/download-failure "L" "boom"])
     (is (= {:error "boom"} @(rf/subscribe [::bundle/state "L"])))
     (rf/dispatch-sync [::bundle/download-success "L"])
     (is (nil? @(rf/subscribe [::bundle/state "L"]))))))
