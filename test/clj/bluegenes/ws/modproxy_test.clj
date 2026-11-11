(ns bluegenes.ws.modproxy-test
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [bluegenes.ws.modproxy :as proxy]
            [cheshire.core :as json])
  (:import [java.io ByteArrayInputStream]))

(use-fixtures :each (fn [t] (proxy/clear-cache!) (t)))

(defn- stream [^String s] (ByteArrayInputStream. (.getBytes s "UTF-8")))

(defn- body-str [res] (slurp (:body res)))

(defn- stub
  "A client stub answering `res`, recording requested urls in `calls`."
  [calls res]
  (fn [url opts]
    (swap! calls conj [url opts])
    (if (fn? res) (res) res)))

(deftest id-validation
  (doseq [id ["S000001855" "S000000001"]]
    (is (nil? (:error (proxy/validate "sgd" id "neighbor_sequence_details"))) id))
  (doseq [id ["s000001855" "S00000185" "S0000018555" "SGD:S000001855" "S000001855 "
              "S000001855\n" "../S000001855" "S00000185a" "" nil]]
    (is (some? (:error (proxy/validate "sgd" id "neighbor_sequence_details"))) (pr-str id))))

(deftest resource-allowlist
  (is (nil? (:error (proxy/validate "sgd" "S000001855" "protein_experiment_details"))))
  (is (nil? (:error (proxy/validate "sgd" "S000001855" "neighbor_sequence_details"))))
  (doseq [r ["go_details" "../go_details" "protein_experiment_details/x" "" nil]]
    (is (some? (:error (proxy/validate "sgd" "S000001855" r))) (pr-str r)))
  (testing "unknown MOD"
    (is (some? (:error (proxy/validate "mgi" "S000001855" "protein_experiment_details"))))))

(deftest upstream-url-is-fixed
  (let [{:keys [source id resource]} (proxy/validate "sgd" "S000001855" "protein_experiment_details")]
    (is (= "https://www.yeastgenome.org/backend/locus/S000001855/protein_experiment_details"
           (proxy/upstream-url source id resource)))))

(deftest handler-rejects-before-any-request
  (let [calls (atom [])]
    (binding [proxy/*http-get* (stub calls {:status 200 :body (stream "[]")})]
      (is (= 400 (:status (proxy/handler "sgd" "bad" "protein_experiment_details"))))
      (is (= 400 (:status (proxy/handler "sgd" "S000001855" "nope"))))
      (is (= 400 (:status (proxy/handler "x" "S000001855" "protein_experiment_details"))))
      (is (empty? @calls)))))

(deftest success-passes-json-through
  (let [calls (atom [])]
    (binding [proxy/*http-get* (stub calls {:status 200 :body (stream "[{\"a\":1}]")})]
      (let [res (proxy/handler "sgd" "S000001855" "protein_experiment_details")]
        (is (= 200 (:status res)))
        (is (= "application/json" (get-in res [:headers "Content-Type"])))
        (is (= "[{\"a\":1}]" (body-str res)))
        (let [[url opts] (first @calls)]
          (is (= "https://www.yeastgenome.org/backend/locus/S000001855/protein_experiment_details" url))
          (is (= :none (:redirect-strategy opts)))
          (is (= 20000 (:socket-timeout opts)))
          (is (= 20000 (:connection-timeout opts))))))))

(deftest status-mapping
  (doseq [status [301 302 400 403 404 429 500 503]]
    (proxy/clear-cache!)
    (binding [proxy/*http-get* (stub (atom []) {:status status :body (stream "[]")})]
      (let [res (proxy/handler "sgd" "S000001855" "protein_experiment_details")]
        (is (= 502 (:status res)) (str status))
        (is (= "application/json" (get-in res [:headers "Content-Type"])))
        (is (contains? (json/parse-string (:body res)) "error")))))
  (testing "client exception"
    (proxy/clear-cache!)
    (binding [proxy/*http-get* (fn [_ _] (throw (java.net.SocketTimeoutException. "t")))]
      (is (= 502 (:status (proxy/handler "sgd" "S000001855" "protein_experiment_details"))))))
  (testing "200 with a non-JSON body"
    (proxy/clear-cache!)
    (binding [proxy/*http-get* (stub (atom []) {:status 200 :body (stream "<html>")})]
      (is (= 502 (:status (proxy/handler "sgd" "S000001855" "protein_experiment_details")))))))

(deftest size-cap
  (let [at-cap (str "[\"" (apply str (repeat (- proxy/max-bytes 4) \a)) "\"]")
        over (str "[\"" (apply str (repeat (- proxy/max-bytes 3) \a)) "\"]")]
    (is (= proxy/max-bytes (count at-cap)))
    (binding [proxy/*http-get* (stub (atom []) {:status 200 :body (stream at-cap)})]
      (is (= 200 (:status (proxy/handler "sgd" "S000001855" "protein_experiment_details")))))
    (proxy/clear-cache!)
    (binding [proxy/*http-get* (stub (atom []) {:status 200 :body (stream over)})]
      (let [res (proxy/handler "sgd" "S000001855" "protein_experiment_details")]
        (is (= 502 (:status res)))
        (is (re-find #"too large" (:body res)))))))

(deftest cache-serves-repeat-requests
  (let [calls (atom [])]
    (binding [proxy/*http-get* (stub calls (fn [] {:status 200 :body (stream "[1]")}))]
      (proxy/handler "sgd" "S000001855" "protein_experiment_details")
      (is (= "[1]" (body-str (proxy/handler "sgd" "S000001855" "protein_experiment_details"))))
      (is (= 1 (count @calls)))
      (proxy/handler "sgd" "S000001855" "neighbor_sequence_details")
      (is (= 2 (count @calls))))))

(deftest errors-are-not-cached
  (let [calls (atom [])]
    (binding [proxy/*http-get* (stub calls {:status 500 :body (stream "")})]
      (proxy/handler "sgd" "S000001855" "protein_experiment_details")
      (proxy/handler "sgd" "S000001855" "protein_experiment_details")
      (is (= 2 (count @calls))))))

(deftest cache-is-bounded
  (with-redefs [proxy/cache-max-entries 3]
    (binding [proxy/*http-get* (stub (atom []) (fn [] {:status 200 :body (stream "[]")}))]
      (doseq [i (range 6)]
        (proxy/handler "sgd" (format "S%09d" i) "protein_experiment_details")
        (Thread/sleep 2))
      (is (<= (count @@#'proxy/cache) 3)))))
