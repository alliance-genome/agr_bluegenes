(ns bluegenes.tool-host-test
  (:require [cljs.test :refer-macros [deftest is testing use-fixtures]]
            [bluegenes.test-utils :as utils :refer [stub-fetch-fn]]
            [re-frame.core :as rf]
            [day8.re-frame.test :refer-macros [run-test-sync run-test-async wait-for]]
            [imcljs.fetch :as fetch]
            [imcljs.save :as save]
            [bluegenes.components.tools.effects]
            [bluegenes.components.tools.events :as events]
            [bluegenes.components.tools.utils :as tu]))

(use-fixtures :each utils/fixtures)

(def list-query {:from "Gene"
                 :select ["Gene.primaryIdentifier"]
                 :where [{:path "Gene" :op "IN" :value "my_genes"}]})

(def other-query {:from "Gene"
                  :select ["Gene.symbol"]
                  :where [{:path "Gene.symbol" :op "=" :value "zen"}]})

(defn results-db [intent table-query]
  {:current-mine :agr
   :active-panel :results-panel
   :assets {:lists {:agr [{:name "my_genes" :title "My genes" :size 12 :type "Gene"}]}}
   :results {:package {:intent intent :value list-query}
             :table {:query table-query}}})

;;; Context ;;;

(deftest context-for-saved-list
  (is (= {:mine "agr"
          :list {:name "my_genes" :title "My genes" :size 12 :type "Gene"}
          :query list-query
          :intent "list"
          :page "list"}
         (tu/build-context (results-db :list list-query)))))

(deftest context-for-edited-list-query
  (testing "a list page whose query was edited is a results page without a list"
    (let [ctx (tu/build-context (results-db :list other-query))]
      (is (nil? (:list ctx)))
      (is (= other-query (:query ctx)))
      (is (= "results" (:page ctx))))))

(deftest context-for-query-results
  (let [ctx (tu/build-context (results-db :query other-query))]
    (is (= "results" (:page ctx)))
    (is (= "query" (:intent ctx)))
    (is (nil? (:list ctx)))))

(deftest context-falls-back-to-package-query
  (is (= list-query (:query (tu/build-context (update (results-db :list nil) :results dissoc :table))))))

(deftest context-for-report
  (is (= {:mine "agr" :list nil :query nil :intent nil :page "report"}
         (tu/build-context (assoc (results-db :list list-query) :active-panel :reportpage-panel)))))

;;; Threshold and groups ;;;

(defn tool-with [config n]
  {:config config :entity {:Gene {:value (vec (range n))}}})

(deftest threshold
  (is (not (tu/above-threshold? (tool-with {} 1000))) "default is 1000 ids")
  (is (tu/above-threshold? (tool-with {} 1001)))
  (is (tu/above-threshold? (tool-with {:threshold 50} 51)) "config.json threshold wins")
  (is (not (tu/above-threshold? (tool-with {:threshold 5000} 4000))))
  (is (not (tu/above-threshold? {:config {} :entity {:Gene {:value 42}}})) "a report id counts as one"))

(deftest tool-groups
  (let [t (fn [n g] {:names {:cljs n} :config {:group g}})
        grouped (tu/group-tools [(t "a" "Other") (t "b" "Enrichment") (t "c" "Annotation")
                                 (t "d" "Bogus") (t "e" nil) (t "f" "Annotation")])]
    (is (= ["Annotation" "Enrichment" "Other"] (map first grouped)) "fixed order, empty groups dropped")
    (is (= ["c" "f"] (map (comp :cljs :names) (second (first grouped)))))
    (is (= ["a" "d" "e"] (map (comp :cljs :names) (second (last grouped)))) "unknown groups fall to Other")))

(deftest collapse-groups
  (run-test-sync
   (rf/dispatch-sync [::events/collapse-group "Export"])
   (is (= #{"Export"} (get-in @re-frame.db/app-db [:tools :collapsed-groups])))
   (rf/dispatch-sync [::events/expand-group "Export"])
   (is (empty? (get-in @re-frame.db/app-db [:tools :collapsed-groups])))))

;;; saveList arguments ;;;

(def valid-args {:name "x" :class "Gene" :ids [1 2 "3"] :tags ["t"]})

(deftest save-args-validation
  (is (nil? (tu/validate-save-args valid-args)))
  (is (nil? (tu/validate-save-args (dissoc valid-args :tags))))
  (is (some? (tu/validate-save-args (assoc valid-args :name " "))))
  (is (some? (tu/validate-save-args (dissoc valid-args :name))))
  (is (some? (tu/validate-save-args (assoc valid-args :class "Gene.id"))))
  (is (some? (tu/validate-save-args (assoc valid-args :ids []))))
  (is (some? (tu/validate-save-args (assoc valid-args :ids "1,2"))))
  (is (some? (tu/validate-save-args (assoc valid-args :ids [1 "FBgn1"]))))
  (is (some? (tu/validate-save-args (assoc valid-args :ids [1.5]))))
  (is (some? (tu/validate-save-args (assoc valid-args :tags "t")))))

(deftest save-query-and-names
  (is (= {:from "Gene"
          :select ["Gene.id"]
          :where [{:path "Gene.id" :op "ONE OF" :values ["1" "2"]}]}
         (tu/ids-query "Gene" [1 "2"])))
  (is (= "x" (tu/unique-list-name [{:name "y"}] "x")))
  (is (= "x_2" (tu/unique-list-name [{:name "x"} {:name "x_1"}] "x")))
  (is (= {:tags "a;b"} (tu/save-options ["a" "b"])))
  (is (nil? (tu/save-options []))))

;;; saveList events ;;;

(rf/reg-event-db ::seed (fn [_ [_ db]] db))

(defn mine-db [token]
  {:current-mine :agr
   :mines {:agr {:service (cond-> {:root "http://agr.example"} token (assoc :token token))}}})

(defn- run-save [db args]
  (let [outcome (atom nil)]
    (rf/dispatch-sync [::seed db])
    (rf/dispatch-sync [::events/save-list args
                       #(reset! outcome [:resolved %])
                       #(reset! outcome [:rejected (.-message %)])])
    outcome))

(deftest save-list-anonymous
  (run-test-sync
   (with-redefs [fetch/lists (fn [& _] (throw (js/Error. "no request without a login")))]
     (is (= [:rejected "login required"] @(run-save (mine-db nil) valid-args))))))

(deftest save-list-invalid-arguments
  (run-test-sync
   (with-redefs [fetch/lists (fn [& _] (throw (js/Error. "no request for invalid arguments")))]
     (let [[state message] @(run-save (mine-db "tok") (assoc valid-args :ids []))]
       (is (= :rejected state))
       (is (re-find #"ids" message))))))

(deftest save-list-resolves-with-unique-name
  (run-test-async
   (let [saved (atom nil)
         orig-lists fetch/lists
         orig-save save/im-list-from-query]
     (set! fetch/lists (stub-fetch-fn [{:name "x"}]))
     (set! save/im-list-from-query
           (fn [service name query options]
             (reset! saved [service name query options])
             ((stub-fetch-fn {:listName name}))))
     (swap! utils/stubbed-variables conj #(set! fetch/lists orig-lists))
     (swap! utils/stubbed-variables conj #(set! save/im-list-from-query orig-save))
     (let [outcome (run-save (mine-db "tok") valid-args)]
       (wait-for [::events/save-list-success]
         (let [[service name query options] @saved]
           (is (= "tok" (:token service)))
           (is (= "x_1" name) "name clash gets a suffix")
           (is (= ["1" "2" "3"] (get-in query [:where 0 :values])))
           (is (= {:tags "t"} options))
           (is (= [:resolved "x_1"] @outcome))))))))

(deftest save-list-failure-rejects
  (run-test-sync
   (let [outcome (atom nil)]
     (rf/dispatch-sync [::events/save-list-failure #(reset! outcome (.-message %)) {:body {:error "boom"}}])
     (is (= "boom" @outcome))
     (rf/dispatch-sync [::events/save-list-unauthorised #(reset! outcome (.-message %)) nil])
     (is (= "login required" @outcome)))))
