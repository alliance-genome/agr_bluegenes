(ns bluegenes.mine-support-test
  (:require [cljs.test :refer-macros [deftest is testing use-fixtures]]
            [bluegenes.test-utils :as utils :refer [stub-fetch-fn]]
            [re-frame.core :as rf]
            [re-frame.db :refer [app-db]]
            [day8.re-frame.test :refer-macros [run-test-sync run-test-async wait-for]]
            [imcljs.fetch :as fetch]
            [bluegenes.mine-support :as ms]))

(use-fixtures :each utils/fixtures)

(rf/reg-event-db ::seed (fn [_ [_ db]] db))
(rf/reg-event-db ::probe (fn [db _] (assoc db :probed true)))

;; Shaped like WormMine: homologues exist, alleles do not.
(def worm-like
  {:Gene {:attributes {:id {} :primaryIdentifier {}}
          :collections {:homologues {:referencedType "Homologue"}}}
   :Homologue {:references {:homologue {:referencedType "Gene"}}}})

(deftest mine-classes
  (testing "model of a mine that has been current"
    (is (= worm-like (ms/mine-classes {:mines {:worm {:service {:model {:classes worm-like}}}}} :worm))))
  (testing "model fetched for another mine"
    (is (= worm-like (ms/mine-classes {:mine-models {:worm {:classes worm-like}}} :worm))))
  (testing "unknown"
    (is (nil? (ms/mine-classes {} :worm)))))

(deftest missing-paths
  (is (= ["Gene.alleles.id"]
         (ms/missing-paths worm-like ["Gene.homologues.homologue.id" "Gene.alleles.id"])))
  (testing "an unknown or empty model is not a reason to block"
    (is (= [] (ms/missing-paths nil ["Gene.alleles.id"])))
    (is (= [] (ms/missing-paths {} ["Gene.alleles.id"])))))

(deftest reasons
  (is (nil? (ms/reason "WormMine" [])))
  (is (= "WormMine has no Gene.alleles" (ms/reason "WormMine" ["Gene.alleles"])))
  (is (= "WormMine has no A, B and 1 more" (ms/reason "WormMine" ["A" "B" "C"])))
  (is (= "This mine has no A" (ms/reason nil ["A"])))
  (is (= "WormMine has no Gene.alleles.id"
         (ms/blocked-reason worm-like "WormMine" ["Gene.primaryIdentifier" "Gene.alleles.id"])))
  (is (nil? (ms/blocked-reason worm-like "WormMine" ["Gene.primaryIdentifier"])))
  (is (nil? (ms/blocked-reason nil "WormMine" ["Gene.alleles.id"]))))

(deftest fetch-skips-a-known-model
  (run-test-sync
   (rf/dispatch [::seed {:mines {:worm {:service {:model {:classes worm-like}}}}}])
   (rf/dispatch [::ms/fetch :worm [::probe]])
   (is (true? (:probed @app-db)))))

(deftest fetch-loads-an-unknown-model
  (run-test-async
   (let [orig-model fetch/model
         called (atom nil)]
     (rf/dispatch-sync [::seed {:env {:mines {:worm {:service {:root "http://worm.example"}}}}}])
     (set! fetch/model (fn [service]
                         (reset! called service)
                         ((stub-fetch-fn {:classes worm-like}))))
     (swap! utils/stubbed-variables conj #(set! fetch/model orig-model))
     (rf/dispatch [::ms/fetch :worm [::probe]])
     (wait-for [::ms/success]
       (is (= {:root "http://worm.example"} @called))
       (is (= worm-like (ms/mine-classes @app-db :worm)))))))
