(ns bluegenes.ws.auth-test
  (:require [clojure.test :refer [deftest is testing]]
            [bluegenes.ws.auth :as auth]
            [imcljs.auth :as im-auth]))

(def ^:private service {:root "https://example.org/mine"})

(defn- request [username password]
  {:params {:username username :password password :service service}})

(deftest empty-credentials-rejected
  (let [calls (atom 0)
        count-call (fn [& _] (swap! calls inc) (throw (ex-info "mine called" {})))]
    (with-redefs [im-auth/login count-call
                  im-auth/basic-auth count-call
                  im-auth/register count-call]
      (doseq [[handler label] [[auth/handle-auth "login"] [auth/register "register"]]
              [username password] [["" "secret"] ["alice" ""] [nil "secret"] ["alice" nil]]]
        (testing (str label " with username " (pr-str username) " and password " (pr-str password))
          (let [res (handler (request username password))]
            (is (= 400 (:status res)))
            (is (= "missing parameters. name and password required" (get-in res [:body :error]))))))
      (is (zero? @calls) "the mine is never called"))))
