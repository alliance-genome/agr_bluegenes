(ns bluegenes.tool-host-test
  (:require [cljs.test :refer-macros [deftest is testing use-fixtures]]
            [bluegenes.test-utils :as utils :refer [stub-fetch-fn]]
            [re-frame.core :as rf]
            [day8.re-frame.test :refer-macros [run-test-sync run-test-async wait-for]]
            [imcljs.fetch :as fetch]
            [imcljs.save :as save]
            [bluegenes.components.tools.effects :as effects]
            [bluegenes.components.tools.events :as events]
            [bluegenes.components.tools.utils :as tu]
            [bluegenes.route :as route]
            [bluegenes.utils :as bu]
            [bluegenes.events.boot :refer [extends-hierarchy]]
            [bluegenes.version :as version]))

(def collapse-key "bluegenes/tools-collapsed")

(defn- clear-collapse-storage! []
  (try (.removeItem js/localStorage collapse-key) (catch :default _ nil)))

(use-fixtures :each
  {:before (fn [] (clear-collapse-storage!) ((:before utils/fixtures)))
   :after clear-collapse-storage!})

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

(deftest threshold-without-entities
  (is (= 0 (tu/greatest-count {})))
  (is (= 0 (tu/greatest-count nil)))
  (is (not (tu/above-threshold? {:config {} :entity nil}))))

(deftest threshold-override
  (let [tool (assoc (tool-with {} 1500) :names {:cljs "viz"})
        entity (:entity tool)]
    (is (tu/threshold-halted? nil tool))
    (is (not (tu/threshold-halted? {"viz" entity} tool)) "the chosen entity runs")
    (is (tu/threshold-halted? {"viz" entity} (assoc tool :entity {:Gene {:value (vec (range 1600))}}))
        "a new query halts the tool again")
    (is (tu/threshold-halted? {"other" entity} tool) "overrides are per tool")
    (is (not (tu/threshold-halted? nil (assoc (tool-with {} 5) :names {:cljs "viz"}))))))

(deftest threshold-notice-text
  (is (= "4,213 ids, recommended up to 1,000" (tu/threshold-notice (tool-with {} 4213))))
  (is (= "21 ids, recommended up to 20" (tu/threshold-notice (tool-with {:threshold 20} 21)))))

(deftest suitable-entities-skip-entities-still-loading
  (let [model {:Gene {}}
        hier (extends-hierarchy model)
        config {:accepts ["ids"] :classes ["Gene"] :version 2}]
    (with-redefs [version/tool-api 2]
      (is (nil? (bu/suitable-entities model hier {:Gene nil} config))
          "entities reset to nil on a query change hide every tool, which remounts them")
      (is (some? (bu/suitable-entities model hier {:Gene {:class "Gene" :format "ids" :value [1]}} config))))))

(deftest query-change-resets-entities
  (run-test-sync
   (rf/dispatch-sync [::seed {:current-mine :agr
                              :results {:package {:source :agr}
                                        :query-parts {:Gene []}}
                              :tools {:entities {:Gene {:class "Gene" :format "ids" :value [1]}}}}])
   (rf/dispatch-sync [:fetch-ids-tool-entities])
   (is (= {:Gene nil} (get-in @re-frame.db/app-db [:tools :entities])))))

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

(defn- stored-collapse []
  (some-> (.getItem js/localStorage collapse-key) js/JSON.parse (js->clj :keywordize-keys true)))

(deftest collapse-state-persists
  (run-test-sync
   (rf/dispatch-sync [::events/collapse-group "Export"])
   (rf/dispatch-sync [::events/collapse-tool "viz"])
   (is (= {:collapsed ["viz"] :collapsed-groups ["Export"]} (stored-collapse)))
   (rf/dispatch-sync [::events/expand-tool "viz"])
   (is (= {:collapsed [] :collapsed-groups ["Export"]} (stored-collapse)))))

(deftest collapse-state-loads-with-the-tools
  (run-test-sync
   (.setItem js/localStorage collapse-key
             (js/JSON.stringify (clj->js {:collapsed ["viz" 7] :collapsed-groups ["Export"]})))
   (rf/dispatch-sync [::events/success-fetch-tools {:tools []}])
   (is (= #{"viz"} (get-in @re-frame.db/app-db [:tools :collapsed])) "non-strings are dropped")
   (is (= #{"Export"} (get-in @re-frame.db/app-db [:tools :collapsed-groups])))))

(deftest collapse-state-survives-bad-storage
  (run-test-sync
   (.setItem js/localStorage collapse-key "{not json")
   (rf/dispatch-sync [::events/success-fetch-tools {:tools []}])
   (is (empty? (get-in @re-frame.db/app-db [:tools :collapsed])))
   (is (nil? (tu/sanitize-collapse "text")))
   (is (= {:collapsed #{} :collapsed-groups #{}} (tu/sanitize-collapse {:collapsed "x"})))))

(deftest collapse-state-keeps-the-session-value
  (run-test-sync
   (.setItem js/localStorage collapse-key
             (js/JSON.stringify (clj->js {:collapsed ["old"] :collapsed-groups []})))
   (rf/dispatch-sync [::seed {:tools {:collapsed #{"new"}}}])
   (rf/dispatch-sync [::events/success-fetch-tools {:tools []}])
   (is (= #{"new"} (get-in @re-frame.db/app-db [:tools :collapsed])))))

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
  (is (some? (tu/validate-save-args (assoc valid-args :ids [0]))))
  (is (some? (tu/validate-save-args (assoc valid-args :ids ["0"]))) "strings follow the same rule as numbers")
  (is (some? (tu/validate-save-args (assoc valid-args :ids ["007"]))))
  (is (some? (tu/validate-save-args (assoc valid-args :ids [-4]))))
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

(defn mine-db
  "Db of the :agr mine. `token` is the session token, which anonymous sessions
  have too; `identity` is set once a user has logged in."
  [token identity]
  {:current-mine :agr
   :mines {:agr (cond-> {:service (cond-> {:root "http://agr.example"} token (assoc :token token))}
                  identity (assoc-in [:auth :identity] identity))}})

(def logged-in {:username "user@example.org"})

(defn- run-save
  ([db args] (run-save db "agr" args))
  ([db mine args]
   (let [outcome (atom nil)]
     (rf/dispatch-sync [::seed db])
     (rf/dispatch-sync [::events/save-list mine args
                        #(reset! outcome [:resolved %])
                        #(reset! outcome [:rejected (.-message %)])])
     outcome)))

(defn- message-markup [db]
  (pr-str (map :markup (vals (:messages db)))))

(deftest save-problem-checks
  (is (nil? (tu/save-problem (mine-db "tok" logged-in) "agr" valid-args)))
  (is (= tu/login-required-message (tu/save-problem (mine-db "tok" nil) "agr" valid-args))
      "a session token alone is not a login")
  (is (= tu/login-required-message (tu/save-problem (mine-db "tok" {}) "agr" valid-args)))
  (is (= tu/wrong-mine-message (tu/save-problem (mine-db "tok" logged-in) "other" valid-args)))
  (is (= tu/wrong-mine-message (tu/save-problem (mine-db "tok" logged-in) nil valid-args)))
  (is (re-find #"ids" (tu/save-problem (mine-db "tok" logged-in) "agr" (assoc valid-args :ids [])))))

(deftest save-list-anonymous-session
  (run-test-sync
   (with-redefs [fetch/lists (fn [& _] (throw (js/Error. "no request without a login")))
                 route/href (fn [& args] (pr-str args))]
     (let [outcome (run-save (mine-db "anon-token" nil) valid-args)]
       (is (= [:rejected "login required"] @outcome))
       (is (re-find #"Log in" (message-markup @re-frame.db/app-db)) "the user is told to log in")))))

(deftest save-list-without-token
  (run-test-sync
   (with-redefs [fetch/lists (fn [& _] (throw (js/Error. "no request without a login")))
                 route/href (fn [& args] (pr-str args))]
     (is (= [:rejected "login required"] @(run-save (mine-db nil nil) valid-args))))))

(deftest save-list-other-mine
  (run-test-sync
   (with-redefs [fetch/lists (fn [& _] (throw (js/Error. "no request for another mine")))]
     (is (= [:rejected tu/wrong-mine-message]
            @(run-save (mine-db "tok" logged-in) "other" valid-args))))))

(deftest save-list-invalid-arguments
  (run-test-sync
   (with-redefs [fetch/lists (fn [& _] (throw (js/Error. "no request for invalid arguments")))]
     (let [[state message] @(run-save (mine-db "tok" logged-in) (assoc valid-args :ids []))]
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
     (let [orig-href route/href]
       (set! route/href (fn [_ params] (str "#/" (:title params))))
       (swap! utils/stubbed-variables conj #(set! route/href orig-href)))
     (let [outcome (run-save (mine-db "tok" logged-in) valid-args)]
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

(deftest save-list-success-message
  (run-test-sync
   (with-redefs [route/href (fn [_ params] (str "#/" (:title params)))]
     (let [outcome (atom nil)]
       (rf/dispatch-sync [::seed {:current-mine :agr}])
       (rf/dispatch-sync [::events/save-list-success #(reset! outcome %) "agr" valid-args {:listName "x_1"}])
       (is (= "x_1" @outcome))
       (let [[message & more] (vals (:messages @re-frame.db/app-db))
             text (pr-str (:markup message))]
         (is (nil? more))
         (is (= "success" (:style message)))
         (is (re-find #"x_1" text))
         (is (re-find #"#/x_1" text) "links to the list")
         (is (re-find #"3 Genes" text) "counts the ids")
         (is (re-find #"already taken" text) "says the name was taken"))))))

(deftest saved-message-exact-name
  (with-redefs [route/href (fn [_ params] (str "#/" (:title params)))]
    (let [text (pr-str (:markup (events/saved-message "agr" (assoc valid-args :ids [5]) "x")))]
      (is (re-find #"1 Gene\b" text))
      (is (not (re-find #"already taken" text))))))

;;; Script loading ;;;

(def args-a {:entity :a})
(def args-b {:entity :b})

(deftest second-request-while-loading-waits
  (let [[s1 action1] (effects/request-run {} "script-t" "t" args-a :one)
        [s2 action2] (effects/request-run s1 "script-t" "t" args-b :two)
        [s3 pending] (effects/script-loaded s2 "script-t" :one)]
    (is (= :load action1))
    (is (= :wait action2) "no run while main is undefined")
    (is (= {"t" args-b} pending) "the latest request is the one that runs")
    (is (= :run (second (effects/request-run s3 "script-t" "t" args-a :three))))))

(deftest every-waiting-tool-element-runs
  (let [[s1 _] (effects/request-run {} "script-t" "t-1" args-a :one)
        [s2 _] (effects/request-run s1 "script-t" "t-2" args-b :one)
        [_ pending] (effects/script-loaded s2 "script-t" :one)]
    (is (= {"t-1" args-a "t-2" args-b} pending))))

(deftest failed-script-loads-again
  (let [[s1 _] (effects/request-run {} "script-t" "t" args-a :one)
        [s2 pending] (effects/script-failed s1 "script-t" :one)]
    (is (= {"t" args-a} pending))
    (is (= :load (second (effects/request-run s2 "script-t" "t" args-a :two))) "a retry adds the tag again")))

(deftest late-events-of-an-old-attempt-are-ignored
  (let [[s1 _] (effects/request-run {} "script-t" "t" args-a :one)
        [s2 _] (effects/script-failed s1 "script-t" :one)
        [s3 _] (effects/request-run s2 "script-t" "t" args-b :two)]
    (is (= [s3 nil] (effects/script-loaded s3 "script-t" :one)) "a late onload of attempt one")
    (is (= [s3 nil] (effects/script-failed s3 "script-t" :one)) "a late timeout of attempt one")
    (is (= {"t" args-b} (second (effects/script-loaded s3 "script-t" :two))))))

;;; onDestroy ;;;

(deftest destroy-hooks-run-once
  (let [calls (atom [])]
    (effects/register-destroy! "tool-a" #(swap! calls conj :first))
    (effects/register-destroy! "tool-a" #(throw (js/Error. "broken tool")))
    (effects/register-destroy! "tool-a" #(swap! calls conj :last))
    (effects/register-destroy! "tool-a" "not a function")
    (effects/register-destroy! "tool-b" #(swap! calls conj :other))
    (effects/run-destroy-hooks! "tool-a")
    (is (= [:first :last] @calls) "a throwing callback does not stop the others")
    (effects/run-destroy-hooks! "tool-a")
    (is (= [:first :last] @calls) "callbacks run once")
    (effects/run-destroy-hooks! "tool-b")
    (is (= [:first :last :other] @calls))))

(deftest context-js-carries-mine-bound-functions
  (let [ctx (effects/context->js {:mine "agr" :page "report"} "tool-c")
        calls (atom 0)]
    (is (= "agr" (.-mine ctx)))
    (is (fn? (.-saveList ctx)))
    (.onDestroy ctx #(swap! calls inc))
    (effects/run-destroy-hooks! "tool-c")
    (is (= 1 @calls))))
