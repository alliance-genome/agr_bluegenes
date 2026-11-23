(ns bluegenes.components.tools.effects
  (:require [re-frame.core :as rf :refer [dispatch reg-fx]]
            [oops.core :refer [ocall+ oset!]]
            [bluegenes.components.tools.events :as events]
            [bluegenes.route :as route]
            [bluegenes.utils :refer [suitable-entities]]
            [clojure.string :as str]
            [bluegenes.config :refer [server-vars]]))

(defmulti navigate
  "Can be used from JS like this:
      navigate('report', {type: 'Gene', id: 1018204}, 'humanmine');
      navigate('query', myQueryObj, 'flymine');
      navigate('list', 'PL_GenomicsEngland_GenePanel:Radial_dysplasia');
  Note that the third argument specifying the mine namespace is optional."
  (fn [target data mine] (keyword target)))

(defmethod navigate :report [_ report-data mine]
  (let [{:keys [type id]} (js->clj report-data :keywordize-keys true)
        source (keyword mine)]
    (dispatch [::route/navigate ::route/report {:type type, :id id, :mine source}])))

(defmethod navigate :query [_ query-data mine]
  (let [query (js->clj query-data :keywordize-keys true)
        source (keyword mine)]
    (dispatch [::events/navigate-query query source])))

(defmethod navigate :list [_ list-name mine]
  (dispatch [::route/navigate ::route/results {:title list-name :mine (keyword mine)}]))

(defn navigate!
  "JS can't call `navigate` if we pass it the multimethod directly, so wrap it!"
  [target data mine]
  (navigate target data mine))

(defn save-list!
  "The `context.saveList` function given to tools, bound to the mine the tool
  runs in. Returns a Promise that resolves with the saved list name, see
  docs/tool-api.md."
  [mine args]
  (js/Promise.
   (fn [resolve reject]
     (dispatch [::events/save-list mine (js->clj args :keywordize-keys true) resolve reject]))))

;;; Cleanup callbacks registered through `context.onDestroy` ;;;

(defonce destroy-hooks (atom {}))

(defn register-destroy!
  "Remembers `f` to call when the tool in `tool-id` is unmounted or started again."
  [tool-id f]
  (when (fn? f)
    (swap! destroy-hooks update tool-id (fnil conj []) f)))

(defn run-destroy-hooks!
  "Calls and forgets the callbacks of `tool-id`. One throwing does not stop the rest."
  [tool-id]
  (let [fs (get @destroy-hooks tool-id)]
    (swap! destroy-hooks dissoc tool-id)
    (doseq [f fs]
      (try
        (f)
        (catch :default e
          (.error js/console e))))))

(defn context->js
  "Converts the context map to the JS object tools receive and adds `saveList`
  and `onDestroy`."
  [context tool-id]
  (doto (clj->js context)
    (oset! "saveList" (partial save-list! (:mine context)))
    (oset! "onDestroy" (partial register-destroy! tool-id))))

(reg-fx
 :settle-promise
 (fn [{:keys [f value]}]
   (f value)))

(defn navigate-in
  "`navigate!` that uses `mine`, the mine of the tool, when the tool names none."
  [mine]
  (fn [target data target-mine]
    (navigate target data (or target-mine mine))))

;;; Failure shown in the tool element ;;;

(defn- tool-label [tool]
  (or (get-in tool [:names :human]) (get-in tool [:names :npm])))

(defn- show-error!
  "Replaces the content of the tool element with a message and a Retry button."
  [el tool tool-id reason]
  (when el
    (let [box (.createElement js/document "div")
          text (.createElement js/document "span")
          retry (.createElement js/document "button")]
      (oset! box "className" "alert alert-warning tool-error")
      (oset! text "textContent" (str "Could not start " (tool-label tool) ": " reason ". "))
      (oset! retry "type" "button")
      (oset! retry "className" "btn btn-default btn-sm")
      (oset! retry "textContent" "Retry")
      (oset! retry "onclick" #(dispatch [::events/init-tool tool tool-id]))
      (.appendChild box text)
      (.appendChild box retry)
      (oset! el "textContent" "")
      (.appendChild el box))))

(defn- report-failure!
  [tool tool-id reason]
  (show-error! (.getElementById js/document tool-id) tool tool-id reason)
  (dispatch [:messages/add {:markup [:span "Could not start the tool " [:strong (tool-label tool)] ": " reason "."]
                            :style "warning"
                            :timeout 10000}]))

;;; Script loading state ;;;

(def load-timeout-ms 20000)

(defonce script-states (atom {}))

(defn- loading? [states script-id attempt]
  (and (= :loading (get-in states [script-id :status]))
       (= attempt (get-in states [script-id :attempt]))))

(defn request-run
  "Decides what to do when a tool asks to run. Returns [states action]: :run when
  the script is loaded, :wait when it is loading (the latest args of each tool
  are kept for when it is), :load when the caller has to add the script tag."
  [states script-id tool-id args attempt]
  (case (get-in states [script-id :status])
    :loaded [states :run]
    :loading [(assoc-in states [script-id :pending tool-id] args) :wait]
    [(assoc states script-id {:status :loading :attempt attempt :pending {tool-id args}}) :load]))

(defn script-loaded
  "Returns [states pending], pending being the tool-id -> args to run now. It is
  empty when `attempt` is no longer the one being waited for."
  [states script-id attempt]
  (if (loading? states script-id attempt)
    [(assoc states script-id {:status :loaded}) (get-in states [script-id :pending])]
    [states nil]))

(defn script-failed
  "Returns [states pending] like `script-loaded`, and forgets the script so the
  next request loads it again."
  [states script-id attempt]
  (if (loading? states script-id attempt)
    [(dissoc states script-id) (get-in states [script-id :pending])]
    [states nil]))

(defn- settle-script!
  "Applies `f` (script-loaded or script-failed) to the state, returns the pending runs."
  [f script-id attempt]
  (let [[states pending] (f @script-states script-id attempt)]
    (reset! script-states states)
    pending))

(defn start-tool!
  [el tool tool-id {:keys [service entity context]}]
  (run-destroy-hooks! tool-id)
  (let [main (str (get-in tool [:names :cljs]) ".main")]
    ;; If we don't wrap in a try-catch, errors thrown from tools can cause
    ;; Bluegenes to halt execution.
    (try
      (ocall+ js/window main el (clj->js service) (clj->js entity) (clj->js {})
              (clj->js (:config tool)) (navigate-in (:mine context)) (context->js context tool-id))
      (catch :default e
        (.error js/console e)
        (report-failure! tool tool-id (or (some-> e .-message not-empty) "the tool raised an error"))))))

(defn run-script!
  "Executes a tool-api compliant main method to initialise a tool"
  [tool tool-id & {:keys [tries] :as args}]
  (let [el (.getElementById js/document tool-id)
        tries (or tries 0)]
    ;; It may occur that the element isn't mounted in the DOM when this runs.
    ;; In this case, try again later!
    (cond
      el (start-tool! el tool tool-id args)
      (< tries 5) (.setTimeout js/window
                               #(run-script! tool tool-id
                                             :service (:service args) :entity (:entity args)
                                             :context (:context args)
                                             :tries (inc tries))
                               1000)
      :else (.warn js/console "Tool API: no element for" tool-id))))

(defn- run-pending! [pending]
  (doseq [[tool-id {:keys [tool-details service entity context]}] pending]
    (run-script! tool-details tool-id :service service :entity entity :context context)))

(defn- fail-pending! [pending reason]
  (doseq [[tool-id {:keys [tool-details]}] pending]
    (report-failure! tool-details tool-id reason)))

(defn fetch-script!
  ;; inspired by https://stackoverflow.com/a/31374433/1542891
  "Dynamically inserts the tool api script into the head of the document.
  A tool that asks to run while the script is still loading is run when it
  has loaded, with the arguments of its latest request. If the script is
  already present, re-run the tool's main function."
  [tool tool-id & {:keys [service entity context]}]
  (let [script-id (str "script-" (get-in tool [:names :cljs]))
        args {:tool-details tool :service service :entity entity :context context}
        attempt (random-uuid)
        present? (some? (.getElementById js/document script-id))]
    (when (and present? (not (contains? @script-states script-id)))
      (swap! script-states assoc script-id {:status :loaded}))
    (let [[states action] (request-run @script-states script-id tool-id args attempt)
          tool-path (get-in tool [:config :files :js])]
      (reset! script-states states)
      (case action
        :run (run-script! tool tool-id :service service :entity entity :context context)
        :wait nil
        :load
        (if-not tool-path
          (do (swap! script-states dissoc script-id)
              (.error js/console "%cTool API: No script path provided for %s" "background:#ccc;border-bottom:solid 3px indianred; border-radius:2px;" (get-in tool [:names :npm]))
              ;; The element is mounted after this render, so report once it exists.
              (.setTimeout js/window #(report-failure! tool tool-id "it has no script") 0))
          (let [script-tag (.createElement js/document "script")
                head (aget (.getElementsByTagName js/document "head") 0)
                fail! (fn [reason]
                        (let [pending (settle-script! script-failed script-id attempt)]
                          (when (some? pending)
                            (.remove script-tag)
                            (.error js/console "Tool API: Failed to load script for" (get-in tool [:names :npm]))
                            (fail-pending! pending reason))))]
            (oset! script-tag "id" script-id)
            ;;fetch script from bluegenes-tool-store backend
            (oset! script-tag "src" (str (:bluegenes-deploy-path @server-vars)
                                         "/tools/" (get-in tool [:names :npm])
                                         "/" tool-path
                                         "?v=" (get-in tool [:package :version])))
            (oset! script-tag "onload" #(run-pending! (settle-script! script-loaded script-id attempt)))
            ;;remove the tag on a failed load, so the next call fetches it again
            (oset! script-tag "onerror" #(fail! "its script did not load"))
            (.setTimeout js/window #(fail! "its script took too long to load") load-timeout-ms)
            ;;append script to dom
            (.appendChild head script-tag)))))))

(defn fetch-styles!
  "If the tool api script has a stylesheet as well, load it and insert into the doc"
  [tool _tool-id]
  (let [style-id (str "style-" (get-in tool [:names :cljs]))
        style-elem (.getElementById js/document style-id)]
    ;; Do not add the style tag if it's already there.
    (when-not style-elem
      (let [style-tag (.createElement js/document "link")
            head (aget (.getElementsByTagName js/document "head") 0)
            style-path (get-in tool [:config :files :css])]
        (when style-path
          ;;fetch stylesheet and set some properties
          (oset! style-tag "id" style-id)
          (oset! style-tag "href" (str (:bluegenes-deploy-path @server-vars)
                                       "/tools/" (get-in tool [:names :npm])
                                       "/" style-path
                                       "?v=" (get-in tool [:package :version])))
          (oset! style-tag "type" "text/css")
          (oset! style-tag "rel" "stylesheet")
          ;;append to dom
          (.appendChild head style-tag))))))

;; This effect should be used to invoke the above functions. It can be run
;; both when initially loading the tools and when the input data has changed,
;; to pass the new entity to the tools (eg. opening a different report or
;; results page, or modifying the contents of the result page's im-table).
;; In the latter case, it will merely call the tool's main function.
(reg-fx
 :load-tool
 (fn [{:keys [tool tool-id service context]}]
   ;; `entity` is nil if tool is not suitable to be displayed.
   ;; Although this shouldn't be called if that's the case.
   (when-let [entity (:entity tool)]
     (fetch-script! tool tool-id :service service :entity entity :context context)
     (fetch-styles! tool tool-id))))
