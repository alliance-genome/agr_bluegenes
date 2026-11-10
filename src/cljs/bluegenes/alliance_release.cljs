(ns bluegenes.alliance-release
  "Fetches the Alliance of Genome Resources data release once per session and
  caches it in the db under :alliance-release. A failed or slow request leaves
  no release and shows no error."
  (:require [re-frame.core :refer [reg-event-db reg-event-fx reg-fx reg-sub dispatch]]
            [bluegenes.config :as config]
            [bluegenes.cite :as cite]))

(def timeout-ms 20000)

(defn release-url
  "URL of the release endpoint under an API base."
  [api-base]
  (str api-base "/releaseInfo"))

(defn status
  "One of nil (never requested), :loading, :done or :failed."
  [db]
  (get-in db [:alliance-release :status]))

(defn release
  "The cached {:version :date}, or nil."
  [db]
  (get-in db [:alliance-release :release]))

(reg-fx
 ::fetch
 (fn [{:keys [url on-success on-failure]}]
   (let [controller (js/AbortController.)
         timer (js/setTimeout #(.abort controller) timeout-ms)]
     (-> (js/fetch url #js {:signal (.-signal controller)})
         (.then (fn [response]
                  (if (.-ok response)
                    (.json response)
                    (throw (js/Error. (str "HTTP " (.-status response)))))))
         (.then #(dispatch (conj on-success (js->clj % :keywordize-keys true))))
         (.catch #(dispatch on-failure))
         (.finally #(js/clearTimeout timer))))))

(reg-event-fx
 ::ensure
 (fn [{db :db} _]
   (when-let [base (and (not (status db)) (config/alliance-api-base))]
     {:db (assoc-in db [:alliance-release :status] :loading)
      ::fetch {:url (release-url base)
               :on-success [::success]
               :on-failure [::failure]}})))

(reg-event-db
 ::success
 (fn [db [_ info]]
   (if-let [parsed (cite/parse-release-info info)]
     (assoc db :alliance-release {:status :done :release parsed})
     (assoc-in db [:alliance-release :status] :failed))))

(reg-event-db
 ::failure
 (fn [db _]
   (assoc-in db [:alliance-release :status] :failed)))

(reg-sub ::release (fn [db] (release db)))
