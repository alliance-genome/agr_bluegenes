(ns bluegenes.templates-test
  (:require [cljs.test :refer-macros [deftest is are testing use-fixtures]]
            [bluegenes.test-utils :as utils]
            [re-frame.core :as rf]
            [day8.re-frame.test :refer-macros [run-test-sync]]
            [bluegenes.pages.templates.events]
            [bluegenes.pages.templates.helpers :as helpers]))

(use-fixtures :each utils/fixtures)

(comment
  "Use this to get current template to add more tests."
  (require '[re-frame.core :refer [subscribe]])
  (select-keys @(subscribe [:selected-template]) [:name :where]))

(deftest web-service-url
  (let [service {:root "https://beta.flymine.org/flymine"}]
    (are [tmpl url] (= (helpers/web-service-url service tmpl) url)
      {:name "Gene_transcriptionFactors",
       :where [{:path "Gene.regulatoryRegions", :type "TFBindingSite"}
               {:path "Gene",
                :op "LOOKUP",
                :code "A",
                :editable true,
                :switchable false,
                :switched "LOCKED",
                :value "dpp"}
               {:path "Gene.organism.name",
                :op "=",
                :code "C",
                :editable true,
                :switchable false,
                :switched "LOCKED",
                :value "Drosophila melanogaster"}]}
      "https://beta.flymine.org/flymine/service/template/results?name=Gene_transcriptionFactors&constraint1=Gene&op1=LOOKUP&value1=dpp&extra1=&constraint2=Gene.organism.name&op2=eq&value2=Drosophila+melanogaster&format=tab&size=10"
      {:name "Tissue_Flyatlas",
       :where [{:path "FlyAtlasResult.tissue.name",
                :op "=",
                :code "A",
                :editable true,
                :switchable false,
                :switched "LOCKED",
                :value "Ovary"}
               {:path "FlyAtlasResult.affyCall",
                :op "=",
                :code "E",
                :editable true,
                :switchable true,
                :switched "ON",
                :value "Up"}
               {:path "FlyAtlasResult.presentCall",
                :op ">=",
                :code "C",
                :editable true,
                :switchable true,
                :switched "OFF",
                :value "3"}
               {:path "FlyAtlasResult.enrichment",
                :op ">",
                :code "B",
                :editable true,
                :switchable true,
                :switched "OFF",
                :value "2.0"}
               {:path "FlyAtlasResult.mRNASignal",
                :op ">=",
                :code "D",
                :editable true,
                :switchable true,
                :switched "OFF",
                :value "100.0"}]}
      "https://beta.flymine.org/flymine/service/template/results?name=Tissue_Flyatlas&constraint1=FlyAtlasResult.tissue.name&op1=eq&value1=Ovary&constraint2=FlyAtlasResult.affyCall&op2=eq&value2=Up&format=tab&size=10")))

(rf/reg-event-db ::seed (fn [_ [_ db]] db))
(rf/reg-sub ::chooser #(get-in % [:components :template-chooser]))

(deftest unsatisfied-constraint-forgets-previous-query
  (run-test-sync
   (rf/dispatch [::seed {:components {:template-chooser {:previously-ran {:from "Gene"}
                                                         :results-preview {:results []}}}}])
   (rf/dispatch [:template-chooser/update-preview 0 {:path "Gene.symbol" :op "=" :value ""}])
   (let [chooser @(rf/subscribe [::chooser])]
     (is (nil? (:results-preview chooser)))
     (is (nil? (:previously-ran chooser))))))
