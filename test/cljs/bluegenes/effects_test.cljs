(ns bluegenes.effects-test
  (:require [cljs.test :refer-macros [deftest is testing use-fixtures]]
            [bluegenes.test-utils :as utils]
            [re-frame.core :as rf]
            [day8.re-frame.test :refer-macros [run-test-sync run-test-async wait-for]]
            [cljs.core.async :refer [chan put!]]
            [cljs-http.client :as http]
            [bluegenes.effects :as fx]))

(use-fixtures :each utils/fixtures)

(deftest retry
  (run-test-async
   (rf/reg-event-fx :test-retry (fn [_ _] {:retry {:event [:test-retry-success "melon"]}}))
   (rf/reg-event-fx :test-retry-success (fn [_ [_ secret]]
                                          {:db {:done secret}
                                           :retry {:event [:test-retry-success]
                                                   :success? true}}))
   (rf/reg-sub :done (fn [db] (:done db)))
   (rf/dispatch-sync [:test-retry])
   (wait-for [:test-retry-success]
     (let [code @(rf/subscribe [:done])]
       (is (= code "melon") "Retry effect should dispatch event")))))

(defn- assert-http-outcome
  "Run the :http effect against a stubbed response and check which callback fires."
  [response request expected]
  (run-test-async
   (rf/reg-event-db :test-http-result (fn [db [_ outcome]] (assoc db :outcome outcome)))
   (rf/reg-sub :outcome (fn [db] (:outcome db)))
   (with-redefs [http/get (fn [& _]
                            (let [c (chan 1)]
                              (put! c response)
                              c))]
     (fx/http-fxfn (merge {:method :get
                           :uri "http://example.org/api"
                           :on-success [:test-http-result :success]
                           :on-failure [:test-http-result :failure]}
                          request)))
   (wait-for [:test-http-result]
     (is (= expected @(rf/subscribe [:outcome]))))))

(deftest http-network-error
  (assert-http-outcome {:status 0 :body ""} {} :failure))

(deftest http-4xx-without-on-unauthorised
  (assert-http-outcome {:status 404 :body ""} {} :failure))

(deftest http-4xx-with-on-unauthorised
  (assert-http-outcome {:status 401 :body ""}
                       {:on-unauthorised [:test-http-result :unauthorised]}
                       :unauthorised))
