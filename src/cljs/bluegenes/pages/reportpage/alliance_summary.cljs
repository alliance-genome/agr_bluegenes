(ns bluegenes.pages.reportpage.alliance-summary
  "Gene report block with the Alliance of Genome Resources gene summary:
  automated description, synonyms and gene type. The gene is read in the
  current mine, mapped to an Alliance CURIE and fetched from the Alliance API
  with a 20 s timeout. A 404 hides the block and other errors show a muted
  line. Responses for an earlier report are dropped. An empty
  `:bluegenes-alliance-api-base` disables the block."
  (:require [re-frame.core :refer [reg-event-fx reg-fx reg-sub dispatch]]
            [clojure.string :as str]
            [imcljs.fetch :as fetch]
            [bluegenes.alliance-curie :refer [to-alliance-curie]]
            [bluegenes.config :as config]))

(def timeout-ms 20000)
(def attribution "Data from the Alliance of Genome Resources API")

(def ^:private gene-views
  ["Gene.primaryIdentifier" "Gene.organism.shortName" "Gene.organism.taxonId"])

;; Pure functions.

(defn gene-url
  "Alliance gene page for a CURIE."
  [curie]
  (str "https://www.alliancegenome.org/gene/" curie))

(defn api-url
  "URL of the gene endpoint, or nil when `base` is blank."
  [base curie]
  (let [base (str/replace (str/trim (str base)) #"/+$" "")]
    (when-not (str/blank? base)
      (str base "/gene/" (js/encodeURIComponent curie)))))

(defn curie-from-rows
  "CURIE of the gene from `fetch/rows` results of `gene-views`."
  [{:keys [results]}]
  (let [[primary-identifier short-name taxon-id] (first results)]
    (or (to-alliance-curie primary-identifier taxon-id)
        (to-alliance-curie primary-identifier short-name))))

(defn- display-text [x]
  (some-> (if (map? x) (:displayText x) x) str str/trim not-empty))

(defn parse-gene
  "Block data from the response of the Alliance gene endpoint."
  [response curie]
  (let [{:keys [relatedNotes geneSynonyms geneType]} (:gene response)
        description (->> relatedNotes
                         (filter #(= "automated_gene_description" (get-in % [:noteType :name])))
                         (keep #(some-> (:freeText %) str str/trim not-empty))
                         first)]
    {:curie curie
     :description description
     :synonyms (vec (distinct (keep display-text geneSynonyms)))
     :gene-type (display-text (:name geneType))}))

;; Effects.

(defn- fetch-json
  "GET `url` with a 20 s timeout. Dispatches `on-success` with the parsed body,
  `on-not-found` on a 404 and `on-failure` with a message otherwise."
  [{:keys [url on-success on-not-found on-failure]}]
  (let [controller (js/AbortController.)
        timer (js/setTimeout #(.abort controller) timeout-ms)
        fail (fn [msg] (dispatch (conj on-failure msg)))]
    (-> (js/fetch url #js {:signal (.-signal controller)
                           :headers #js {"Accept" "application/json"}})
        (.then (fn [res]
                 (cond
                   (= 404 (.-status res)) (dispatch on-not-found)
                   (.-ok res) (-> (.json res)
                                  (.then #(dispatch (conj on-success (js->clj % :keywordize-keys true)))))
                   :else (fail (str "HTTP " (.-status res))))))
        (.catch (fn [err]
                  (fail (if (= "AbortError" (.-name err)) "request timed out" "request failed"))))
        (.finally #(js/clearTimeout timer)))))

(reg-fx ::fetch-json fetch-json)

;; Events.

(defn- current-report? [db report-key]
  (= report-key (get-in db [:report :key])))

(defn- store [db state]
  (assoc-in db [:report :alliance-summary] state))

(reg-event-fx
 :report-alliance-summary/start
 (fn [{db :db} [_ [mine-kw _type id :as report-key]]]
   (when (and (current-report? db report-key)
              (not (str/blank? (config/alliance-api-base))))
     {:db (store db {:status :loading})
      :im-chan {:chan (fetch/rows {:root (get-in db [:mines mine-kw :service :root])
                                   :model {:name "genomic"}}
                                  {:from "Gene"
                                   :select gene-views
                                   :where [{:path "Gene.id" :op "=" :value id}]}
                                  {:format "json"})
                :on-success [::gene-success report-key]
                :on-failure [::rows-failure report-key]}})))

(reg-event-fx
 ::gene-success
 (fn [{db :db} [_ report-key res]]
   (when (current-report? db report-key)
     (let [curie (curie-from-rows res)
           url (some->> curie (api-url (config/alliance-api-base)))]
       (if url
         {::fetch-json {:url url
                        :on-success [::success report-key curie]
                        :on-not-found [::not-found report-key]
                        :on-failure [::failure report-key]}}
         {:db (store db {:status :not-found})})))))

(reg-event-fx
 ::rows-failure
 (fn [{db :db} [_ report-key res]]
   (when (current-report? db report-key)
     {:db (store db {:status :error
                     :message (if-let [status (:status res)]
                                (str "HTTP " status)
                                "request failed")})})))

(reg-event-fx
 ::success
 (fn [{db :db} [_ report-key curie response]]
   (when (current-report? db report-key)
     {:db (store db (assoc (parse-gene response curie) :status :done))})))

(reg-event-fx
 ::not-found
 (fn [{db :db} [_ report-key]]
   (when (current-report? db report-key)
     {:db (store db {:status :not-found})})))

(reg-event-fx
 ::failure
 (fn [{db :db} [_ report-key message]]
   (when (current-report? db report-key)
     {:db (store db {:status :error :message message})})))

;; Subscriptions.

(reg-sub
 ::block
 (fn [db]
   (get-in db [:report :alliance-summary])))
