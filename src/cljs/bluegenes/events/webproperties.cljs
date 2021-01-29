(ns bluegenes.events.webproperties
  (:require [re-frame.core :refer [reg-event-db reg-event-fx subscribe]]
            [bluegenes.db :as db]
            [imcljs.fetch :as fetch]
            [bluegenes.events.registry :as registry]
            [clojure.set :refer [rename-keys]]
            [clojure.string :as string]))

(defn capitalize-kw [kw]
  (->> (name kw)
       string/capitalize
       keyword))

(defn parse-citation
  "Returns a URL citation or the URL of the first anchor element if it's HTML."
  [citation]
  (when-let [cit (not-empty citation)]
    (or (re-matches #"\S+" cit) ;; If there are no spaces, it's probably a URL.
        ;; Otherwise, extract it from the href attribute.
        (second (re-find #"href=[\"']([^\"']+)" cit)))))

(defn web-properties-to-bluegenes
  "Map intermine web properties to bluegenes properties"
  [web-properties]
  {:name                         (get-in web-properties [:project :title])
   :description                  (get-in web-properties [:project :subTitle])
   :default-organism             (get-in web-properties [:genomicRegionSearch :defaultOrganisms])
   ;;todo - set sane default programmatically or default to first.
   :default-selected-object-type (first (get-in web-properties [:genomicRegionSearch :defaultOrganisms]))
   :regionsearch-example         (get-in web-properties [:genomicRegionSearch :defaultSpans])
   :rss                          (get-in web-properties [:project :rss])
   :citation                     (parse-citation (get-in web-properties [:project :citation]))
   :credits                      (get-in web-properties [:project :credits])
   :idresolver-example           (let [ids (get-in web-properties [:bag :example :identifiers])]
                                   ;; ids can be one of the following:
                                   ;;     {:default "foo bar"
                                   ;;      :protein "baz boz"} ; post im 4.1.0?
                                   ;;     "foo bar"            ; pre  im 4.1.0?
                                   ;; When it's a map, we capitalize the keys
                                   ;; and rename :Default to :Gene; otherwise
                                   ;; we make a map with ids assigned to :Gene.
                                   (if (map? ids)
                                     (-> (reduce-kv (fn [m k v]
                                                      (assoc m (capitalize-kw k) v))
                                                    {} ids)
                                         (rename-keys {:Default :Gene}))
                                     {:Gene ids}))})
;   :default-query-example        {;;we need json queries to use the endpoint properly
                                  ;;https://github.com/intermine/intermine/issues/1770
                                  ;;note that the default query button won't appear
                                  ;;until we fix this issue
                                ;}


; Fetch web properties
(reg-event-db
 :assets/success-fetch-web-properties
 (fn [db [_ mine-kw web-properties]]
   (let [original-properties (get-in db [:mines mine-kw])
         fetched-properties  (web-properties-to-bluegenes web-properties)]
     (assoc-in db [:mines mine-kw] (merge original-properties fetched-properties)))))

(reg-event-fx
 :assets/fetch-web-properties
 (fn [{db :db} [evt]]
   (let [current-mine (:current-mine db)
         service      (get-in db [:mines current-mine :service])]
     {:im-chan {:chan (fetch/web-properties service)
                :on-success [:assets/success-fetch-web-properties current-mine]
                :on-failure [:assets/failure evt]}})))
