(ns bluegenes.ws.rss
  "Our Wordpress blog doesn't allow CORS, so we need to use the backend as a
  proxy to fetch the RSS feed. Since we're already doing this, we might as well
  parse the RSS here to reduce the payload back to the frontend."
  (:require [compojure.core :refer [defroutes GET]]
            [clojure.string :as str]
            [ring.middleware.params :refer [wrap-params]]
            [ring.middleware.keyword-params :refer [wrap-keyword-params]]
            [ring.util.http-response :as response]
            [ring.util.http-predicates :as predicates]
            [clj-http.client :as client]
            [clojure.data.xml :as xml]
            [clojure.zip :as z]
            [config.core :refer [env]]
            [bluegenes.utils :refer [env->mines]])
  (:import [java.net URI]))

;; The frontend falls back to this feed when a mine's web-properties set no
;; project.rss (bluegenes.events.blog/default-rss).
(def default-feed-host "intermineorg.wordpress.com")

(defn- url-host [url]
  (try (.getHost (URI. url))
       (catch Exception _ nil)))

(defn allowed-hosts
  "Hosts the proxy may fetch from: the default blog feed, every configured
  mine, and any extra hosts listed in :bluegenes-rss-allowed-hosts."
  [env]
  (into #{default-feed-host}
        (keep url-host)
        (concat (map :root (env->mines env))
                (map #(str "https://" %) (:bluegenes-rss-allowed-hosts env)))))

(defn allowed-url?
  "True when url is http(s) and its host is in hosts."
  [hosts url]
  (try
    (let [uri (URI. url)]
      (and (contains? #{"http" "https"} (some-> (.getScheme uri) str/lower-case))
           (contains? hosts (.getHost uri))))
    (catch Exception _ false)))

(defn find-items
  "Returns a seq of item nodes for a zipper location."
  [loc]
  (cond
    (z/end? loc) nil
    (= :item (:tag (z/node loc))) (cons (z/node loc)
                                        (filter map? (z/rights loc)))
    :else (recur (z/next loc))))

(defn find-tags
  "Returns a map from tags to values for a zipper location."
  ([loc tags] (find-tags loc tags {}))
  ([loc tags m]
   (cond
     ;; z/right returns nil after the last sibling.
     (or (nil? loc) (z/end? loc)) m
     (empty? tags) m
     (contains? tags (:tag (z/node loc)))
     (let [{:keys [tag content]} (z/node loc)]
       (recur (z/right loc) (disj tags tag) (assoc m tag (first content))))
     :else (recur (z/next loc) tags m))))

(defn parse-rss [xml-feed]
  (->> (-> xml-feed (xml/parse-str :support-dtd false) z/xml-zip find-items)
       (map z/xml-zip)
       (map #(find-tags % #{:title :link :pubDate :description}))))

(defn fetch-rss [req]
  (let [url (get-in req [:params :url])]
    (cond
      (nil? url)
      (response/bad-request "Please pass a `url` query parameter pointing to an RSS feed.")

      (not (allowed-url? (allowed-hosts env) url))
      (response/forbidden "This RSS feed host is not allowed.")

      :else
      (try
        (let [res (client/get url {:connection-timeout 5000
                                   :socket-timeout 5000
                                   :redirect-strategy :none
                                   :throw-exceptions false})]
          (if (predicates/ok? res)
            (if-let [parsed-items (not-empty (doall (parse-rss (:body res))))]
              (response/ok parsed-items)
              (response/bad-request "Failed to parse RSS feed."))
            (response/bad-gateway (str "RSS feed responded with status " (:status res) "."))))
        (catch Exception e
          (response/bad-request
           (str "Error occured when fetching or parsing RSS feed: " (.getMessage e))))))))

(defroutes routes
  (wrap-params
   (wrap-keyword-params
    (GET "/parse" [] fetch-rss))))
