(ns bluegenes.components.tools.events
  (:require [re-frame.core :as re-frame :refer [reg-event-db reg-event-fx reg-fx dispatch subscribe]]
            [bluegenes.effects :as fx]
            [bluegenes.crud.tools :as crud]
            [bluegenes.components.tools.utils :as utils]
            [imcljs.fetch :as fetch]
            [imcljs.save :as save]))

(reg-event-fx
 ::fetch-tools
 (fn [{db :db} [evt]]
   {:db db
    ::fx/http {:method :get
               :uri "/api/tools/all"
               :on-success [::success-fetch-tools]
               :on-unauthorised [::error-fetch-tools evt]
               :on-failure [::error-fetch-tools evt]}}))

(reg-event-db
 ::success-fetch-tools
 (fn [db [_ {:keys [tools]}]]
   (crud/update-installed-tools db tools)))

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

(reg-event-db
 ::collapse-tool
 (fn [db [_ tool-name-cljs]]
   (update-in db [:tools :collapsed] (fnil conj #{}) tool-name-cljs)))

(reg-event-db
 ::expand-tool
 (fn [db [_ tool-name-cljs]]
   (update-in db [:tools :collapsed] (fnil disj #{}) tool-name-cljs)))

(reg-event-db
 ::collapse-group
 (fn [db [_ group]]
   (update-in db [:tools :collapsed-groups] (fnil conj #{}) group)))

(reg-event-db
 ::expand-group
 (fn [db [_ group]]
   (update-in db [:tools :collapsed-groups] (fnil disj #{}) group)))

;;; context.saveList ;;;

(defn- settle
  "Effect that calls the resolve or reject function of a tool's saveList promise."
  [f value]
  {:settle-promise {:f f :value value}})

(defn- failure-error [res]
  (js/Error. (or (get-in res [:body :error]) "Failed to save list")))

(reg-event-fx
 ::save-list
 (fn [{db :db} [_ args resolve reject]]
   (let [service (get-in db [:mines (:current-mine db) :service])
         problem (if (:token service)
                   (utils/validate-save-args args)
                   utils/login-required-message)]
     (if problem
       (settle reject (js/Error. problem))
       {:im-chan {:chan (fetch/lists service)
                  :on-success [::save-list-lists service args resolve reject]
                  :on-failure [::save-list-failure reject]
                  :on-unauthorised [::save-list-unauthorised reject]}}))))

(reg-event-fx
 ::save-list-lists
 (fn [_ [_ service {list-name :name :keys [class ids tags]} resolve reject lists]]
   {:im-chan {:chan (save/im-list-from-query service
                                             (utils/unique-list-name lists list-name)
                                             (utils/ids-query class ids)
                                             (utils/save-options tags))
              :on-success [::save-list-success resolve]
              :on-failure [::save-list-failure reject]
              :on-unauthorised [::save-list-unauthorised reject]}}))

(reg-event-fx
 ::save-list-success
 (fn [_ [_ resolve {:keys [listName]}]]
   (assoc (settle resolve listName)
          :dispatch [:assets/fetch-lists])))

(reg-event-fx
 ::save-list-failure
 (fn [_ [_ reject res]]
   (settle reject (failure-error res))))

(reg-event-fx
 ::save-list-unauthorised
 (fn [_ [_ reject _res]]
   (settle reject (js/Error. utils/login-required-message))))
