(ns bluegenes.ws.auth-test
  (:require [clojure.test :refer [deftest is testing]]
            [bluegenes.ws.auth :as auth]
            [config.core]
            [imcljs.auth :as im-auth]))

(def ^:private root "https://alliancemine.alliancegenome.org/alliancemine")

(def ^:private service {:root root})

(def ^:private user {:username "alice@example.org" :preferences {}})

(defn- request [username password]
  {:params {:username username :password password :service service}})

(defn- count-call [calls]
  (fn [& _] (swap! calls inc) (throw (ex-info "mine called" {}))))

(deftest invalid-credentials-rejected
  (let [calls (atom 0)
        count-call (count-call calls)]
    (with-redefs [im-auth/login count-call
                  im-auth/basic-auth count-call
                  im-auth/register count-call]
      (doseq [[handler label] [[auth/handle-auth "login"] [auth/register "register"]]
              [username password] [["" "secret"] ["alice" ""] [nil "secret"] ["alice" nil]
                                   ["   " "secret"] ["alice" "\t "]
                                   [5 "secret"] ["alice" 5] [["alice"] "secret"] [{:a 1} "secret"]]]
        (testing (str label " with username " (pr-str username) " and password " (pr-str password))
          (let [res (handler (request username password))]
            (is (= 400 (:status res)))
            (is (= "missing parameters. name and password required" (get-in res [:body :error]))))))
      (is (zero? @calls) "the mine is never called"))))

(deftest login-success
  (let [seen (atom nil)]
    (with-redefs [im-auth/login (fn [svc u p]
                                  (reset! seen [svc u p])
                                  {:output {:user user :token "tok" :renamedLists {"old" "new"}}})]
      (let [res (auth/handle-auth (request "alice@example.org" "secret"))
            identity (assoc user :token "tok")]
        (is (= [service "alice@example.org" "secret"] @seen))
        (is (= 200 (:status res)))
        (is (= {:identity identity :renamedLists {"old" "new"}} (:body res)))
        (is (= {:identity identity} (:session res)))))))

(deftest login-falls-back-to-basic-auth-on-302
  (let [seen (atom nil)]
    (with-redefs [im-auth/login (fn [& _] {:status 302})
                  im-auth/basic-auth (fn [svc u p] (reset! seen [svc u p]) "basic-tok")
                  im-auth/who-am-i? (fn [svc token]
                                      (is (= "basic-tok" (:token svc) token))
                                      user)]
      (let [res (auth/handle-auth (request "alice@example.org" "secret"))]
        (is (= [service "alice@example.org" "secret"] @seen))
        (is (= 200 (:status res)))
        (is (= {:identity (assoc user :token "basic-tok") :renamedLists nil} (:body res)))))))

(deftest mine-error-status-passes-through
  (let [mine-res {:status 401 :body {:error "bad credentials"}}]
    (with-redefs [im-auth/login (fn [& _] (throw (ex-info "unauthorized" mine-res)))]
      (is (= mine-res (auth/handle-auth (request "alice@example.org" "wrong")))))))

(deftest error-without-status-is-500
  (with-redefs [im-auth/login (fn [& _] (throw (ex-info "connection refused" {})))]
    (let [res (auth/handle-auth (request "alice@example.org" "secret"))]
      (is (= 500 (:status res)))
      (is (= "connection refused" (get-in res [:body :error]))))))

(deftest register-registers-then-logs-in
  (let [order (atom [])]
    (with-redefs [im-auth/register (fn [& _] (swap! order conj :register) {:temporaryToken "t"})
                  im-auth/login (fn [& _]
                                  (swap! order conj :login)
                                  {:output {:user user :token "tok"}})]
      (let [res (auth/register (request "alice@example.org" "secret"))]
        (is (= [:register :login] @order))
        (is (= 200 (:status res)))
        (is (= (assoc user :token "tok") (get-in res [:body :identity])))))))

(deftest wrap-configured-service-checks-the-root
  (let [handler (#'auth/wrap-configured-service (fn [_] {:status 200}))
        with-root (fn [r] {:params {:service {:root r}}})
        env {:bluegenes-default-service-root root
             :bluegenes-default-mine-name "AllianceMine"
             :bluegenes-default-namespace "alliancemine"
             :bluegenes-additional-mines [{:root "https://www.flymine.org/flymine"
                                           :name "FlyMine" :namespace "flymine"}]}]
    (with-redefs [config.core/env env]
      (is (= 200 (:status (handler (with-root root)))))
      (is (= 200 (:status (handler (with-root "https://www.flymine.org/flymine")))))
      (is (= 400 (:status (handler (with-root "https://evil.example.org/mine")))))
      (is (= 400 (:status (handler {:params {}})))))
    (with-redefs [config.core/env (dissoc env :bluegenes-default-service-root)]
      (is (= 400 (:status (handler (with-root nil)))) "unconfigured service root is rejected"))))
