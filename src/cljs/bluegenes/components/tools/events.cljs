(ns bluegenes.components.tools.events
  (:require [re-frame.core :as re-frame :refer [reg-cofx reg-event-db reg-event-fx reg-fx inject-cofx dispatch subscribe]]
            [bluegenes.effects :as fx]
            [bluegenes.crud.tools :as crud]
            [bluegenes.components.tools.utils :as utils]
            [bluegenes.route :as route]
            [imcljs.fetch :as fetch]
            [imcljs.save :as save]))

;;; Collapse state in localStorage ;;;

(def ^:private collapse-storage-key "bluegenes/tools-collapsed")

(reg-cofx
 ::stored-collapse
 (fn [coeffects _]
   (assoc coeffects ::stored-collapse
          (try
            (some-> (.getItem js/localStorage collapse-storage-key)
                    js/JSON.parse
                    (js->clj :keywordize-keys true)
                    utils/sanitize-collapse)
            (catch :default _ nil)))))

(reg-fx
 ::persist-collapse
 (fn [state]
   (try
     (.setItem js/localStorage collapse-storage-key
               (js/JSON.stringify (clj->js (utils/collapse->storable state))))
     (catch :default _ nil))))

(defn- collapse-state [db]
  (select-keys (:tools db) [:collapsed :collapsed-groups]))

(defn- with-persisted-collapse [db]
  {:db db
   ::persist-collapse (collapse-state db)})

(reg-event-fx
 ::fetch-tools
 (fn [{db :db} [evt]]
   {:db db
    ::fx/http {:method :get
               :uri "/api/tools/all"
               :on-success [::success-fetch-tools]
               :on-unauthorised [::error-fetch-tools evt]
               :on-failure [::error-fetch-tools evt]}}))

(reg-event-fx
 ::success-fetch-tools
 [(inject-cofx ::stored-collapse)]
 (fn [{db :db stored ::stored-collapse} [_ {:keys [tools]}]]
   {:db (-> (crud/update-installed-tools db tools)
            (update-in [:tools :collapsed] #(or % (:collapsed stored)))
            (update-in [:tools :collapsed-groups] #(or % (:collapsed-groups stored))))}))

(reg-event-fx
 ::error-fetch-tools
 (fn [{db :db} [_ evt res]]
   (let [text (case evt
                ::fetch-tools "Failed to fetch BlueGenes Tools - visualizations may not show. This indicates a problem with the BlueGenes backend. "
                "Error occurred when communicating with the BlueGenes Tool backend. ")]
     {:dispatch [:messages/add
                 {:markup [:span text
                           (when-let [err (get-in res [:body :error])]
                             [:code err])]
                  :style "warning"
                  :timeout 0}]})))

(reg-event-fx
 ::fetch-npm-tools
 (fn [_ [evt]]
   {::fx/http {:method :get
               :uri (str "https://api.npms.io/v2/search"
                         "?q=keywords:bluegenes-intermine-tool")
               :on-success [::success-fetch-npm-tools]
               :on-unauthorised [::error-fetch-tools evt]
               :on-failure [::error-fetch-tools evt]}}))

(reg-event-db
 ::success-fetch-npm-tools
 (fn [db [_ {:keys [results]}]]
   (assoc-in db [:tools :available] results)))

(reg-event-fx
 ::navigate-query
 (fn [{db :db} [_ query source]]
   (let [source (or source (:current-mine db))
         set-current-mine [:set-current-mine source]
         history+         [:results/history+ {:source source
                                              :type :query
                                              :intent :tool
                                              :value query}]
         new-source?      (not= source (:current-mine db))]
     {:dispatch (if new-source? set-current-mine history+)
      ;; Use :dispatch-after-boot since [:results :queries] is cleared when switching mines.
      :db (cond-> db
            new-source? (update :dispatch-after-boot (fnil conj []) history+))})))

(reg-event-fx
 ::fetch-tool-path
 (fn [_ [evt]]
   {::fx/http {:method :get
               :uri "/api/tools/path"
               :on-success [::success-fetch-tool-path]
               :on-unauthorised [::error-fetch-tools evt]
               :on-failure [::error-fetch-tools evt]}}))

(reg-event-db
 ::success-fetch-tool-path
 (fn [db [_ {:keys [path]}]]
   (assoc-in db [:tools :path] path)))

(reg-event-fx
 ::init-tool
 (fn [{db :db} [_ tool-details tool-id]]
   (let [mine     (get-in db [:mines (:current-mine db)])
         service  (get mine :service)]
     {:load-tool {:tool tool-details
                  :tool-id tool-id
                  :service service
                  :context (utils/build-context db)}})))

(reg-event-fx
 ::collapse-tool
 (fn [{db :db} [_ tool-name-cljs]]
   (with-persisted-collapse (update-in db [:tools :collapsed] (fnil conj #{}) tool-name-cljs))))

(reg-event-fx
 ::expand-tool
 (fn [{db :db} [_ tool-name-cljs]]
   (with-persisted-collapse (update-in db [:tools :collapsed] (fnil disj #{}) tool-name-cljs))))

(reg-event-fx
 ::collapse-group
 (fn [{db :db} [_ group]]
   (with-persisted-collapse (update-in db [:tools :collapsed-groups] (fnil conj #{}) group))))

(reg-event-fx
 ::expand-group
 (fn [{db :db} [_ group]]
   (with-persisted-collapse (update-in db [:tools :collapsed-groups] (fnil disj #{}) group))))

(reg-event-db
 ::override-threshold
 (fn [db [_ tool-name-cljs entity]]
   (assoc-in db [:tools :threshold-overrides tool-name-cljs] entity)))

;;; context.saveList ;;;

(defn- settle
  "Effect that calls the resolve or reject function of a tool's saveList promise."
  [f value]
  {:settle-promise {:f f :value value}})

(defn- failure-error [res]
  (js/Error. (or (get-in res [:body :error]) "Failed to save list")))

(defn- mine-label [db mine]
  (or (get-in db [:env :mines mine :name])
      (get-in db [:mines mine :name])
      (name mine)))

(defn- login-message [db mine]
  (let [mine (keyword mine)]
    {:markup [:span "You are not logged in to " [:strong (mine-label db mine)] ". "
              [:a {:href (route/href ::route/home {:mine mine})}
               (str "Log in to " (mine-label db mine))]
              " to save a list."]
     :style "warning"
     :timeout 10000}))

(reg-event-fx
 ::save-list
 (fn [{db :db} [_ mine args resolve reject]]
   (let [service (get-in db [:mines (:current-mine db) :service])
         problem (utils/save-problem db mine args)]
     (if problem
       (cond-> (settle reject (js/Error. problem))
         (= problem utils/login-required-message) (assoc :dispatch [:messages/add (login-message db mine)]))
       {:im-chan {:chan (fetch/lists service)
                  :on-success [::save-list-lists service mine args resolve reject]
                  :on-failure [::save-list-failure reject]
                  :on-unauthorised [::save-list-unauthorised reject]}}))))

(reg-event-fx
 ::save-list-lists
 (fn [_ [_ service mine {list-name :name :keys [class ids tags] :as args} resolve reject lists]]
   {:im-chan {:chan (save/im-list-from-query service
                                             (utils/unique-list-name lists list-name)
                                             (utils/ids-query class ids)
                                             (utils/save-options tags))
              :on-success [::save-list-success resolve mine args]
              :on-failure [::save-list-failure reject]
              :on-unauthorised [::save-list-unauthorised reject]}}))

(defn saved-message
  "Toast for a list a tool saved, linking to it. Says so when the name was taken."
  [mine {list-name :name :keys [class ids]} saved-name]
  (let [n (count (distinct (map str ids)))]
    {:markup [:span "Saved list "
              [:a {:href (route/href ::route/results {:mine (keyword mine) :title saved-name})}
               [:strong saved-name]]
              (str " (" n " " class (when (not= n 1) "s") ")")
              (when (not= list-name saved-name)
                (str ". The name " list-name " was already taken"))
              "."]
     :style "success"
     :timeout 10000}))

(reg-event-fx
 ::save-list-success
 (fn [_ [_ resolve mine args {:keys [listName]}]]
   (assoc (settle resolve listName)
          :dispatch-n [[:assets/fetch-lists]
                       [:messages/add (saved-message mine args listName)]])))

(reg-event-fx
 ::save-list-failure
 (fn [_ [_ reject res]]
   (settle reject (failure-error res))))

(reg-event-fx
 ::save-list-unauthorised
 (fn [_ [_ reject _res]]
   (settle reject (js/Error. utils/login-required-message))))
