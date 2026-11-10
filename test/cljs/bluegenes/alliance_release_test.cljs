(ns bluegenes.alliance-release-test
  (:require [cljs.test :refer-macros [deftest is use-fixtures]]
            [clojure.string :as str]
            [bluegenes.test-utils :as utils]
            [re-frame.core :as rf]
            [day8.re-frame.test :refer-macros [run-test-sync]]
            [bluegenes.cite :as cite]
            [bluegenes.alliance-release :as ar]
            [bluegenes.pages.results.cite :as page]))

(use-fixtures :each utils/fixtures)

(rf/reg-event-db ::seed (fn [_ [_ db]] db))

;; Response of GET https://www.alliancegenome.org/api/releaseInfo (recorded 2026-11-10).
(def release-info-fixture
  {:category "release_info"
   :searchable false
   :releaseVersion "9.2.0"
   :releaseDate "2026-10-28T05:01:35.521+00:00"})

(def release {:version "9.2.0" :date "2026-10-28"})

(def mine
  {:mine-name "AllianceMine"
   :url "https://www.alliancegenome.org/alliancemine"
   :release "r1"
   :intermine-version "5.1.0"
   :date "2026-11-10"
   :subject {:kind :list :name "my genes" :size 3 :type "Gene"}})

(deftest parse-release-info
  (is (= release (cite/parse-release-info release-info-fixture)))
  (is (= release (cite/parse-release-info {"releaseVersion" "9.2.0" "releaseDate" "2026-10-28"})))
  (is (= {:version "9.2.0" :date nil} (cite/parse-release-info {:releaseVersion "9.2.0"})))
  (is (nil? (cite/parse-release-info {:releaseDate "2026-10-28"})))
  (is (nil? (cite/parse-release-info nil))))

(deftest release-text
  (is (= "Alliance of Genome Resources data release 9.2.0 (2026-10-28)"
         (cite/alliance-release-text release)))
  (is (= "Alliance of Genome Resources data release 9.2.0"
         (cite/alliance-release-text {:version "9.2.0"})))
  (is (nil? (cite/alliance-release-text nil)))
  (is (nil? (cite/alliance-release-text {:version ""}))))

(deftest alliance-mine-detection
  (is (cite/alliance-mine? "https://www.alliancegenome.org/alliancemine"))
  (is (cite/alliance-mine? "https://alliancemine.alliancegenome.org/alliancemine/"))
  (is (cite/alliance-mine? "http://localhost:9999/alliancetestmine/service"))
  (is (cite/alliance-mine? "alliancemine"))
  (testing "the MOD mines run on alliancegenome.org hosts but load their own releases"
    (is (not (cite/alliance-mine? "https://wormmine.alliancegenome.org/wormmine")))
    (is (not (cite/alliance-mine? "https://flymine.alliancegenome.org/flymine")))
    (is (not (cite/alliance-mine? "https://yeastmine.alliancegenome.org/yeastmine")))
    (is (not (cite/alliance-mine? "https://yeastmine.alliancegenome.org/yeastmine/service")))
    (is (not (cite/alliance-mine? "wormmine"))))
  (is (not (cite/alliance-mine? "https://www.flymine.org/flymine")))
  (is (not (cite/alliance-mine? nil))))

(deftest methods-with-release
  (let [text (cite/methods-paragraph (assoc mine :alliance release))]
    (is (str/includes? text "The current Alliance of Genome Resources data release at access time was 9.2.0 (2026-10-28)"))
    (is (str/includes? text "Genetics 227(1):iyae049"))
    (is (str/includes? text "Data were accessed on 2026-11-10. The current"))))

(deftest methods-without-release
  (is (not (str/includes? (cite/methods-paragraph mine) "Alliance of Genome Resources"))))

(deftest bibtex-with-release
  (let [text (cite/bibtex (assoc mine :alliance release))]
    (is (str/includes? text "@article{AllianceConsortium2024,"))
    (is (str/includes? text "author = {{Alliance of Genome Resources Consortium}}"))
    (is (str/includes? text "doi = {10.1093/genetics/iyae049}"))
    (is (str/includes? text "note = {InterMine data warehouse; the current Alliance of Genome Resources data release at access time was 9.2.0 (2026-10-28)}"))))

(deftest bibtex-without-release
  (let [text (cite/bibtex mine)]
    (is (not (str/includes? text "AllianceConsortium2024")))
    (is (str/includes? text "note = {InterMine data warehouse}"))))

(deftest ris-with-release
  (let [text (cite/ris (assoc mine :alliance release))]
    (is (str/includes? text "AU  - Alliance of Genome Resources Consortium\n"))
    (is (str/includes? text "DO  - 10.1093/genetics/iyae049"))
    (is (str/includes? text "N1  - InterMine data warehouse; the current Alliance of Genome Resources data release at access time was 9.2.0 (2026-10-28)"))
    (is (= 4 (count (re-seq #"ER  - " text))))))

(deftest ris-without-release
  (let [text (cite/ris mine)]
    (is (not (str/includes? text "Alliance of Genome Resources")))
    (is (= 3 (count (re-seq #"ER  - " text))))))

(deftest release-url
  (is (= "https://www.alliancegenome.org/api/releaseInfo"
         (ar/release-url "https://www.alliancegenome.org/api"))))

(deftest release-cache-states
  (run-test-sync
   (rf/dispatch-sync [::seed {}])
   (is (nil? @(rf/subscribe [::ar/release])))
   (rf/dispatch-sync [::ar/success release-info-fixture])
   (is (= release @(rf/subscribe [::ar/release])))
   (rf/dispatch-sync [::ar/failure])
   (is (= release @(rf/subscribe [::ar/release])))))

(deftest release-failure-without-cache
  (run-test-sync
   (rf/dispatch-sync [::seed {}])
   (rf/dispatch-sync [::ar/failure])
   (is (nil? @(rf/subscribe [::ar/release])))))

(deftest unparseable-response-leaves-no-release
  (run-test-sync
   (rf/dispatch-sync [::seed {}])
   (rf/dispatch-sync [::ar/success {:unexpected true}])
   (is (nil? @(rf/subscribe [::ar/release])))))

(deftest alliance-source-from-db
  (let [db {:mines {:alliancemine {:service {:root "https://www.alliancegenome.org/alliancemine"}}
                    :flymine {:service {:root "https://flymine.alliancegenome.org/flymine"}}
                    :wormmine {:service {:root "https://wormmine.alliancegenome.org/wormmine"}}
                    :yeastmine {:service {:root "https://yeastmine.alliancegenome.org/yeastmine"}}}}]
    (is (true? (page/alliance-source? db :alliancemine)))
    (is (false? (page/alliance-source? db :flymine)))
    (is (false? (page/alliance-source? db :wormmine)))
    (is (false? (page/alliance-source? db :yeastmine)))))

(defn- texts-db [mine-kw]
  {:current-mine mine-kw
   :alliance-release {:status :done :release release}
   :mines {:alliancemine {:name "AllianceMine" :service {:root "https://www.alliancegenome.org/alliancemine"}}
           :wormmine {:name "WormMine" :service {:root "https://wormmine.alliancegenome.org/wormmine"}}}
   :results {:query {:from "Gene" :select ["Gene.symbol"]}}})

(deftest release-text-only-for-alliancemine
  (run-test-sync
   (rf/dispatch-sync [::seed (texts-db :alliancemine)])
   (let [texts @(rf/subscribe [::page/texts])]
     (is (str/includes? (:methods texts) "Alliance of Genome Resources data release 9.2.0"))
     (is (str/includes? (:bibtex texts) "iyae049")))
   (rf/dispatch-sync [::seed (texts-db :wormmine)])
   (let [texts @(rf/subscribe [::page/texts])]
     (is (not (str/includes? (:methods texts) "Alliance of Genome Resources")))
     (is (not (str/includes? (:bibtex texts) "iyae049")))
     (is (not (str/includes? (:ris texts) "Alliance of Genome Resources"))))))

(deftest no-release-request-for-mod-mines
  (let [cached (fn [kw] {:release-version {kw "t"} :intermine-version {kw "5.1.0"}})]
    (is (= [] (page/ensure-requests (assoc (texts-db :wormmine) :alliance-release nil
                                           :assets (cached :wormmine))))
        "no version fetch and no Alliance release fetch")
    (is (= [[::ar/ensure]] (page/ensure-requests (assoc (texts-db :alliancemine) :alliance-release nil
                                                        :assets (cached :alliancemine)))))
    (is (= [[::page/fetch-version :release-version :wormmine]
            [::page/fetch-version :intermine-version :wormmine]]
           (page/ensure-requests (assoc (texts-db :wormmine) :assets {}))))))
