(ns bluegenes.pages.results.send-to-mine
  "Send a Gene list to another configured mine. The identifiers of the list
  genes (or of their homologues in one organism) are read in the current mine,
  mapped to the target mine's identifier style, resolved there and saved as a
  list under the user's login for the target mine."
  (:require [cljs.core.async :refer [chan go alts! put! close! timeout]]
            [re-frame.core :refer [reg-event-db reg-event-fx reg-sub subscribe dispatch inject-cofx]]
            [clojure.string :as str]
            [oops.core :refer [oget]]
            [imcljs.fetch :as fetch]
            [imcljs.save :as save]
            [bluegenes.route :as route]
            [bluegenes.pages.results.orthologs :as orthologs]
            [bluegenes.pages.lists.utils :refer [copy-list-name]]))

(def organism-path "Gene.organism.shortName")
(def homologue-identifier-path "Gene.homologues.homologue.primaryIdentifier")
(def max-shown-unresolved 200)
(def resolve-timeout-ms 60000)
;; Longer than imcljs's own job polling timeout, so imcljs answers first when it can.
(def resolve-guard-ms 65000)

;;; Pure helpers ;;;

(defn id-candidates
  "Identifiers to try in the target mine for one source identifier: as is, and
  without a CURIE prefix (\"MGI:104537\" gives \"MGI:104537\" and \"104537\")."
  [id]
  (let [idx (str/index-of id ":")
        stripped (when idx (subs id (inc idx)))]
    (cond-> [id]
      (not (str/blank? stripped)) (conj stripped))))

(defn all-candidates
  "Distinct candidate identifiers for all source identifiers."
  [ids]
  (vec (distinct (mapcat id-candidates ids))))

(defn- matched-groups [response]
  (let [{:keys [MATCH OTHER]} (:matches response)]
    (concat MATCH OTHER)))

(defn- ids-by-input
  "Map of each matched input identifier to the distinct target object ids."
  [response]
  (reduce (fn [m {:keys [input id]}]
            (if (some? id)
              (reduce (fn [m i] (update m i (fnil conj []) id)) m input)
              m))
          {}
          (matched-groups response)))

(defn classify-resolution
  "Splits source identifiers into resolved and unresolved given an id
  resolution response from the target mine. For each source identifier the
  as-is candidate is used when it has hits, otherwise the prefix-stripped one,
  so one source identifier never adds genes from both forms. Ambiguous
  (duplicate) and wildcard hits count as unresolved. `:object-ids` are the
  distinct target object ids. `:multi-mapped` lists source identifiers that hit
  more than one target gene."
  [source-ids response]
  (let [by-input (ids-by-input response)
        hits (fn [id] (some (fn [c] (some-> (get by-input c) distinct seq)) (id-candidates id)))
        chosen (map (juxt identity hits) source-ids)]
    {:source-count (count source-ids)
     :resolved (count (filter second chosen))
     :unresolved (vec (keep (fn [[id h]] (when-not h id)) chosen))
     :multi-mapped (vec (keep (fn [[id h]] (when (> (count h) 1) id)) chosen))
     :object-ids (->> chosen (mapcat second) distinct vec)}))

(defn source-ids-query
  "Query run in the current mine to get the identifiers to send."
  [list-name mode organism]
  (let [in-list {:path "Gene" :op "IN" :value list-name}]
    (if (= mode :orthologs)
      {:from "Gene"
       :select [homologue-identifier-path]
       :where [in-list
               {:path orthologs/organism-path :op "=" :value organism}]}
      {:from "Gene"
       :select ["Gene.primaryIdentifier"]
       :where [in-list]})))

(defn target-organisms-query []
  {:from "Gene" :select [organism-path]})

(defn object-ids-query
  "Query run in the target mine to save the resolved genes as a list."
  [object-ids]
  {:from "Gene"
   :select ["Gene.id"]
   :where [{:path "Gene.id" :op "ONE OF" :values (mapv str object-ids)}]})

(defn default-list-name [list-name mode organism source-mine-name]
  (str list-name
       (when (= mode :orthologs)
         (str " orthologs in " organism))
       " from " source-mine-name))

(defn effective-list-name
  "The name the user typed, or the default built when identifiers were resolved."
  [{:keys [list-name default-name]}]
  (if (some? list-name) list-name default-name))

(defn ready-to-resolve? [{:keys [target mode organism resolving?]}]
  (boolean (and target
                (not resolving?)
                (or (= mode :same)
                    (and (= mode :orthologs) (not (str/blank? organism)))))))

(defn ready-to-save?
  [{:keys [logged-in? saving? result] :as state}]
  (boolean (and logged-in?
                (not saving?)
                (pos? (count (:object-ids result)))
                (not (str/blank? (effective-list-name state))))))

(defn target-service
  "Service map for a target mine: its configured root plus the token of the
  user's persisted login for that mine, if any. Queries need the model name
  (imcljs writes it into the query XML), and the mines of an Alliance share
  the model, so the current mine's model name is used when the target mine
  has not been loaded."
  [db login mine-kw]
  (let [root (or (get-in db [:env :mines mine-kw :service :root])
                 (get-in db [:mines mine-kw :service :root]))
        model-name (or (get-in db [:mines mine-kw :service :model :name])
                       (get-in db [:mines (:current-mine db) :service :model :name]))
        token (get-in login [mine-kw :token])]
    (cond-> {:root root}
      model-name (assoc :model {:name model-name})
      token (assoc :token token))))

;;; Events ;;;

(defn- state-path [& ks]
  (into [:results :send-to-mine] ks))

(defn- service [db]
  (get-in db [:mines (:current-mine db) :service]))

(defn- mine-label [db mine-kw]
  (or (get-in db [:env :mines mine-kw :name])
      (get-in db [:mines mine-kw :name])
      (name mine-kw)))

(defn- bump-run
  "Gives the panel a fresh run number from a counter that outlives the panel
  state, and drops in-flight work: responses carrying an older run are ignored."
  [db]
  (let [run (inc (or (:send-to-mine-run db) 0))]
    (-> db
        (assoc :send-to-mine-run run)
        (update-in (state-path) assoc :run run :resolving? false :saving? false))))

(defn with-timeout
  "Channel that carries the value of `ch`, or a 408 response after `ms`, so a
  request that never answers still reaches the failure handler."
  [ch ms]
  (let [out (chan 1)]
    (go
      (let [[v port] (alts! [ch (timeout ms)])]
        (put! out (if (= port ch)
                    v
                    {:status 408 :body {:error "Timed out waiting for the identifier resolution job."}}))
        (close! out)))
    out))

(defn- current? [db target run]
  (let [state (get-in db (state-path))]
    (and (= target (:target state))
         (= run (:run state)))))

(reg-event-db
 ::toggle
 (fn [db [_ list-name]]
   (if (get-in db (state-path :open?))
     (assoc-in db (state-path) nil)
     (-> db
         (assoc-in (state-path) {:open? true :list-source list-name})
         bump-run))))

(reg-event-fx
 ::select-mine
 [(inject-cofx :local-store :bluegenes/login)]
 (fn [{db :db login :local-store} [_ mine]]
   (let [base (select-keys (get-in db (state-path)) [:open? :list-source])]
     (if (str/blank? mine)
       {:db (bump-run (assoc-in db (state-path) base))}
       (let [target (keyword mine)
             svc (target-service db login target)]
         {:db (-> db
                  (assoc-in (state-path)
                            (assoc base
                                   :target target
                                   :target-service svc
                                   :logged-in? (contains? svc :token)
                                   :mode :same
                                   :loading-organisms? true))
                  bump-run)
          :im-chan {:chan (fetch/rows svc (target-organisms-query)
                                      {:summaryPath organism-path
                                       :size 1000
                                       :format "jsonrows"})
                    :abort ::target-organisms
                    :on-success [::organisms-success target]
                    :on-failure [::organisms-failure target]
                    :on-unauthorised [::organisms-failure target]}})))))

(reg-event-db
 ::organisms-success
 (fn [db [_ target res]]
   (if (= target (get-in db (state-path :target)))
     (update-in db (state-path) assoc
                :loading-organisms? false
                :organisms (orthologs/organisms-from-summary res))
     db)))

(reg-event-fx
 ::organisms-failure
 (fn [{db :db} [_ target res]]
   (when (= target (get-in db (state-path :target)))
     {:db (update-in db (state-path) assoc
                     :loading-organisms? false
                     :organisms [])
      :dispatch (orthologs/failure-message
                 (str "Failed to fetch organisms of " (mine-label db target) ".") res)})))

(reg-event-db
 ::set-mode
 (fn [db [_ mode]]
   (-> db
       (update-in (state-path) assoc
                  :mode (keyword mode) :organism nil :result nil :saved nil)
       bump-run)))

(reg-event-db
 ::select-organism
 (fn [db [_ organism]]
   (-> db
       (update-in (state-path) assoc
                  :organism (when-not (str/blank? organism) organism)
                  :result nil :saved nil)
       bump-run)))

(reg-event-db
 ::set-list-name
 (fn [db [_ value]]
   (assoc-in db (state-path :list-name) value)))

(reg-event-fx
 ::resolve
 (fn [{db :db} _]
   (let [{:keys [target list-source mode organism] :as state} (get-in db (state-path))]
     (when (ready-to-resolve? state)
       (let [db (bump-run db)
             run (get-in db (state-path :run))
             source-name (mine-label db (:current-mine db))]
         {:db (update-in db (state-path) assoc
                         :resolving? true
                         :result nil
                         :saved nil
                         :default-name (default-list-name list-source mode organism source-name))
          :im-chan {:chan (fetch/rows (service db)
                                      (source-ids-query list-source mode organism)
                                      {:format "json"})
                    :abort ::source-ids
                    :on-success [::source-ids-success target run]
                    :on-failure [::resolve-failure target run]}})))))

(reg-event-fx
 ::source-ids-success
 (fn [{db :db} [_ target run res]]
   (when (current? db target run)
     (let [ids (->> (:results res) (keep first) (remove str/blank?) distinct vec)
           svc (get-in db (state-path :target-service))]
       (if (empty? ids)
         {:db (update-in db (state-path) assoc
                         :resolving? false
                         :result (classify-resolution [] nil))}
         {:im-chan {:chan (with-timeout
                            (fetch/resolve-identifiers svc {:identifiers (all-candidates ids)
                                                            :type "Gene"
                                                            :timeout-ms resolve-timeout-ms})
                            resolve-guard-ms)
                    :abort ::target-resolve
                    :on-success [::resolve-success target run ids]
                    :on-failure [::resolve-failure target run]
                    :on-unauthorised [::unauthorised target run]}})))))

(reg-event-db
 ::resolve-success
 (fn [db [_ target run ids res]]
   (if (current? db target run)
     (update-in db (state-path) assoc
                :resolving? false
                :result (classify-resolution ids res))
     db)))

(reg-event-fx
 ::resolve-failure
 (fn [{db :db} [_ target run res]]
   (when (current? db target run)
     {:db (assoc-in db (state-path :resolving?) false)
      :dispatch (orthologs/failure-message
                 (str "Failed to resolve identifiers in " (mine-label db target) ".") res)})))

(reg-event-fx
 ::unauthorised
 ;; The target mine rejected the stored token. Handling it here keeps the
 ;; generic invalid-token flow from resetting the current mine's login.
 (fn [{db :db} [_ target run _res]]
   (when (current? db target run)
     {:db (update-in db (state-path) assoc
                     :resolving? false
                     :saving? false
                     :logged-in? false)
      :dispatch [:messages/add
                 {:markup [:span "Your login for " [:strong (mine-label db target)]
                           " has expired. Log in there again to save the list."]
                  :timeout 10000
                  :style "warning"}]})))

(reg-event-fx
 ::save
 (fn [{db :db} _]
   (let [{:keys [target target-service run] :as state} (get-in db (state-path))]
     (when (ready-to-save? state)
       {:db (assoc-in db (state-path :saving?) true)
        :im-chan {:chan (fetch/lists target-service)
                  :on-success [::save-with-lists target run]
                  :on-failure [::save-failure target run]
                  :on-unauthorised [::unauthorised target run]}}))))

(reg-event-fx
 ::save-with-lists
 (fn [{db :db} [_ target run lists]]
   (when (current? db target run)
     (let [{:keys [target-service result] :as state} (get-in db (state-path))
           typed (effective-list-name state)
           list-name (if (some (comp #{typed} :name) lists)
                       (copy-list-name lists typed)
                       typed)]
       {:im-chan {:chan (save/im-list-from-query target-service list-name
                                                 (object-ids-query (:object-ids result)))
                  :on-success [::save-success target run]
                  :on-failure [::save-failure target run]
                  :on-unauthorised [::unauthorised target run]}}))))

(reg-event-fx
 ::save-success
 (fn [{db :db} [_ target run {:keys [listName]}]]
   (when (current? db target run)
     {:db (update-in db (state-path) assoc
                     :saving? false
                     :saved {:name listName :mine target})
      :dispatch [:messages/add
                 {:markup [:span "Saved list " [:strong listName] " in "
                           [:strong (mine-label db target)] "."]
                  :timeout 10000
                  :style "success"}]})))

(reg-event-fx
 ::save-failure
 (fn [{db :db} [_ target run res]]
   (when (current? db target run)
     {:db (assoc-in db (state-path :saving?) false)
      :dispatch (orthologs/failure-message
                 (str "Failed to save list in " (mine-label db target) ".") res)})))

;;; Subscriptions ;;;

(reg-sub
 ::state
 (fn [db]
   (get-in db (state-path))))

(reg-sub
 ::target-mines
 :<- [:env/mines]
 :<- [:current-mine-name]
 (fn [[env-mines current]]
   (->> env-mines
        (remove (fn [[k _]] (= k current)))
        (map (fn [[k m]] {:id k :label (or (:name m) (name k))}))
        (sort-by :label)
        vec)))

(reg-sub
 ::available?
 :<- [:results/current-list]
 :<- [::target-mines]
 (fn [[list mines]]
   (boolean (and list (= "Gene" (:type list)) (seq mines)))))

;;; Views ;;;

(defn- label-of [mines id]
  (some #(when (= (:id %) id) (:label %)) mines))

(defn- unresolved-list [unresolved]
  [:div.unresolved-ids
   [:p [:strong (count unresolved)] " unresolved"]
   [:textarea.form-control
    {:read-only true
     :rows 4
     :value (str/join "\n" (take max-shown-unresolved unresolved))}]
   (when (> (count unresolved) max-shown-unresolved)
     [:p.text-muted (str "Showing the first " max-shown-unresolved ".")])])

(defn login-notice [target label]
  [:p.alert.alert-warning
   "You are not logged in to " [:strong label] ". "
   [:a {:href (route/href ::route/home {:mine target})}
    (str "Log in to " label)]
   ", then come back to save the list."])

(defn send-panel []
  (let [{:keys [target organisms organism mode loading-organisms? resolving?
                result saving? logged-in? saved] :as state} @(subscribe [::state])
        mines @(subscribe [::target-mines])
        list-name (effective-list-name state)]
    [:div.send-to-mine-panel
     [:div.form-group
      [:label "Target mine"]
      [:select.form-control
       {:value (if target (name target) "")
        :on-change #(dispatch [::select-mine (oget % :target :value)])}
       [:option {:value ""} "Select a mine"]
       (for [{:keys [id label]} mines]
         ^{:key id} [:option {:value (name id)} label])]]
     (when target
       [:<>
        (when-not logged-in? [login-notice target (label-of mines target)])
        [:div.form-group
         [:label "Genes to send"]
         [:div.radio
          [:label [:input {:type "radio" :name "send-mode" :checked (= mode :same)
                           :on-change #(dispatch [::set-mode :same])}]
           " Same genes"]]
         [:div.radio
          [:label [:input {:type "radio" :name "send-mode" :checked (= mode :orthologs)
                           :disabled (or loading-organisms? (empty? organisms))
                           :on-change #(dispatch [::set-mode :orthologs])}]
           " Orthologs in a species of the target mine"]]
         (when (= mode :orthologs)
           [:select.form-control
            {:value (or organism "")
             :on-change #(dispatch [::select-organism (oget % :target :value)])}
            [:option {:value ""} "Select an organism"]
            (for [o organisms]
              ^{:key o} [:option {:value o} o])])]
        [:button.btn.btn-default
         {:type "button"
          :disabled (not (ready-to-resolve? state))
          :on-click #(dispatch [::resolve])}
         (if resolving? "Resolving..." "Resolve identifiers")]
        (when result
          [:div.resolution-result
           [:p [:strong (:resolved result)] " of " [:strong (:source-count result)]
            " identifiers resolved in the target mine."]
           (when (seq (:multi-mapped result))
             [:p.text-muted
              (str (count (:multi-mapped result))
                   " identifiers matched more than one gene in the target mine: "
                   (str/join ", " (take 10 (:multi-mapped result)))
                   (when (> (count (:multi-mapped result)) 10) ", ...")
                   ". All matched genes are saved.")])
           (when (seq (:unresolved result))
             [unresolved-list (:unresolved result)])
           (when (pos? (count (:object-ids result)))
             [:<>
              [:div.form-group
               [:label "New list name"]
               [:input.form-control
                {:type "text"
                 :value (or list-name "")
                 :on-change #(dispatch [::set-list-name (oget % :target :value)])}]]
              [:button.btn.btn-primary.btn-raised
               {:type "button"
                :disabled (not (ready-to-save? state))
                :on-click #(dispatch [::save])}
               (if saving? "Saving..." "Save list in target mine")]])])
        (when saved
          [:p.saved-list
           "Saved. "
           [:a {:href (route/href ::route/results {:mine (:mine saved) :title (:name saved)})}
            "Switch to " (label-of mines (:mine saved)) " and open " (:name saved)]])])]))

(defn send-button
  "Toggle button and panel. Renders nothing unless the current list is a Gene
  list and another mine is configured."
  [list-name]
  (when @(subscribe [::available?])
    [:div.send-to-mine
     [:button.btn.btn-slim
      {:type "button"
       :on-click #(dispatch [::toggle list-name])}
      "Send to another mine"]
     (when (:open? @(subscribe [::state]))
       [send-panel])]))
