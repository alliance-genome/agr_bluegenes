(ns bluegenes.ws.modproxy
  "Read-only proxy for locus data of model organism databases (MODs). The MOD
  sites send no CORS headers, so a browser tool cannot call them directly.

  Every request is built from the `sources` table: a fixed host, a fixed path
  template, an id pattern and a resource allowlist. The caller supplies only
  an id and a resource name, both validated against the table, so the proxy
  cannot be pointed at another host or path. Adding a MOD is a new entry in
  `sources`, no code change."
  (:require [compojure.core :refer [defroutes GET]]
            [ring.util.http-response :as response]
            [cheshire.core :as json]
            [clj-http.client :as client])
  (:import [java.io ByteArrayInputStream ByteArrayOutputStream InputStream]))

(def sources
  "MOD key -> upstream description. `:url` is a format string taking the id
  and the resource, so the host and path prefix are fixed."
  {"sgd" {:url "https://www.yeastgenome.org/backend/locus/%s/%s"
          :id-pattern #"S\d{9}"
          :resources #{"protein_experiment_details" "neighbor_sequence_details"}}})

(def max-bytes (* 5 1024 1024))
(def timeout-ms 20000)
(def cache-ttl-ms (* 60 60 1000))
(def cache-max-entries 200)

(defonce ^:private cache (atom {}))

(defn clear-cache! [] (reset! cache {}))

(defn- now [] (System/currentTimeMillis))

(defn- fresh? [t {:keys [at]}] (< (- t at) cache-ttl-ms))

(defn- cache-get [k]
  (let [entry (get @cache k)]
    (when (and entry (fresh? (now) entry))
      (:bytes entry))))

(defn- cache-put!
  "Stores `bytes`, dropping expired entries first and then the oldest ones, so
  the map never holds more than `cache-max-entries`."
  [k bytes]
  (swap! cache
         (fn [m]
           (let [t (now)
                 live (into {} (filter #(fresh? t (val %))) m)
                 room (if (>= (count live) cache-max-entries)
                        (->> live
                             (sort-by (comp :at val))
                             (drop (inc (- (count live) cache-max-entries)))
                             (into {}))
                        live)]
             (assoc room k {:at t :bytes bytes})))))

(defn validate
  "Returns {:source s :id id :resource r} for a known MOD, an id matching the
  MOD's pattern and an allowlisted resource, else {:error message}."
  [mod-key id resource]
  (let [source (get sources mod-key)]
    (cond
      (nil? source) {:error "Unknown MOD."}
      (not (and (string? id) (re-matches (:id-pattern source) id))) {:error "Invalid locus id."}
      (not (contains? (:resources source) resource)) {:error "Resource not allowed."}
      :else {:source source :id id :resource resource})))

(defn upstream-url [{:keys [url]} id resource]
  (format url id resource))

(defn- read-capped
  "Reads at most `limit` bytes. Returns a byte array, or nil when the stream
  holds more."
  [^InputStream in limit]
  (let [out (ByteArrayOutputStream.)
        buf (byte-array 8192)]
    (loop [total 0]
      (let [n (.read in buf)]
        (cond
          (neg? n) (.toByteArray out)
          (> (+ total n) limit) nil
          :else (do (.write out buf 0 n)
                    (recur (+ total n))))))))

(defn- body-bytes
  "The response body as bytes, or nil when it exceeds `limit`."
  [body limit]
  (cond
    (instance? InputStream body) (with-open [in ^InputStream body] (read-capped in limit))
    (string? body) (let [b (.getBytes ^String body "UTF-8")] (when (<= (count b) limit) b))
    (bytes? body) (when (<= (count body) limit) body)
    :else (byte-array 0)))

(defn- error [status message]
  {:status status
   :headers {"Content-Type" "application/json"}
   :body (json/generate-string {:error message})})

(defn- json-bytes? [^bytes b]
  (try (json/parse-string (String. b "UTF-8")) true
       (catch Exception _ false)))

(defn- json-ok [^bytes b]
  {:status 200
   :headers {"Content-Type" "application/json" "Cache-Control" "public, max-age=3600"}
   :body (ByteArrayInputStream. b)})

(def ^:dynamic *http-get*
  "The HTTP client call. Rebound in tests."
  client/get)

(defn fetch
  "Fetches the validated upstream URL. Redirects are not followed, so the
  request can only reach the table's host. Returns {:bytes b} or {:error
  response}."
  [url]
  (let [res (try
              (*http-get* url {:as :stream
                               :headers {"Accept" "application/json"}
                               :redirect-strategy :none
                               :socket-timeout timeout-ms
                               :connection-timeout timeout-ms
                               :throw-exceptions false})
              (catch Exception _ nil))
        body (:body res)]
    (cond
      (nil? res)
      {:error (error 502 "The upstream database could not be reached.")}

      (not= 200 (:status res))
      (do (when (instance? InputStream body) (.close ^InputStream body))
          {:error (error 502 (str "The upstream database answered with status " (:status res) "."))})

      :else
      (let [bytes (try (body-bytes body max-bytes)
                       (catch Exception _ ::failed))]
        (cond
          (= ::failed bytes) {:error (error 502 "The upstream response could not be read.")}
          (nil? bytes) {:error (error 502 "The upstream response is too large.")}
          (not (json-bytes? bytes)) {:error (error 502 "The upstream response is not JSON.")}
          :else {:bytes bytes})))))

(defn handler
  [mod-key id resource]
  (let [{:keys [source] :as v} (validate mod-key id resource)]
    (if (:error v)
      (response/bad-request {:error (:error v)})
      (let [url (upstream-url source id resource)]
        (if-let [cached (cache-get url)]
          (json-ok cached)
          (let [{:keys [bytes error]} (fetch url)]
            (if error
              error
              (do (cache-put! url bytes)
                  (json-ok bytes)))))))))

(defroutes routes
  (GET "/:mod-key/locus/:id/:resource" [mod-key id resource] (handler mod-key id resource)))
