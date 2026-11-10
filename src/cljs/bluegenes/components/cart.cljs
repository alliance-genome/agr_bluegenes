(ns bluegenes.components.cart
  "Gene cart that spans the configured mines. Items are kept in localStorage
  under `storage-key` and mirrored in the app db under `:gene-cart`. The tray
  lists items by mine and saves them as a list in a mine with the login the
  user has for it. \"Save all to current mine\" resolves the identifiers of
  items from other mines in the current mine with the helpers of send-to-mine."
  (:require [re-frame.core :refer [reg-event-db reg-event-fx reg-sub subscribe dispatch inject-cofx]]
            [reagent.core :as r]
            [clojure.string :as str]
            [oops.core :refer [oget]]
            [imcljs.fetch :as fetch]
            [imcljs.save :as save]
            [bluegenes.route :as route]
            [bluegenes.pages.lists.utils :refer [copy-list-name]]
            [bluegenes.pages.results.orthologs :as orthologs]
            [bluegenes.pages.results.send-to-mine :as stm]))

(def storage-key :bluegenes/gene-cart)
(def cart-class "Gene")

;;; Pure functions ;;;

(defn item-key
  "Identity of an item: the mine, the class and the internal id as a string."
  [{:keys [mine class id]}]
  [mine class (str id)])

(defn in-cart? [items item]
  (let [k (item-key item)]
    (boolean (some #(= k (item-key %)) items))))

(defn dedupe-items
  "Drops later items with the same key as an earlier one."
  [items]
  (second (reduce (fn [[seen out] item]
                    (let [k (item-key item)]
                      (if (contains? seen k)
                        [seen out]
                        [(conj seen k) (conj out item)])))
                  [#{} []]
                  items)))

(defn add-item
  "Appends `item` unless an item with the same key is already in the cart."
  [items item]
  (if (in-cart? items item)
    (vec items)
    (conj (vec items) item)))

(defn remove-item
  "Removes the item with key `k`."
  [items k]
  (vec (remove #(= k (item-key %)) items)))

(defn sanitize
  "Items read back from storage: only maps with a mine, class and id are kept,
  duplicates are dropped."
  [stored]
  (->> (when (sequential? stored) stored)
       (filter #(and (map? %) (keyword? (:mine %)) (some? (:id %)) (string? (:class %))))
       dedupe-items))

(defn group-by-mine
  "Vector of [mine items], in the order mines first appear in the cart."
  [items]
  (mapv (fn [m] [m (filterv #(= m (:mine %)) items)])
        (distinct (map :mine items))))

(defn mine-items [items mine]
  (filterv #(= mine (:mine %)) items))

(defn foreign-items [items mine]
  (filterv #(not= mine (:mine %)) items))

(defn object-ids
  "Distinct internal ids of items, as strings."
  [items]
  (->> items (map (comp str :id)) distinct vec))

(defn source-identifiers
  "Distinct non-blank primaryIdentifiers of items."
  [items]
  (->> items (map :primaryIdentifier) (remove str/blank?) distinct vec))

(defn summary->item
  "Cart item for the object a report page shows, from its summary response
  (`:views` and `:results`). Nil when the summary has no row."
  [mine class id {:keys [views results]}]
  (when-let [row (first results)]
    (let [by-view (zipmap views row)
          pick (fn [& paths]
                 (some #(let [v (get by-view %)]
                          (when-not (str/blank? (str v)) v))
                       paths))]
      {:mine mine
       :class class
       :id (str id)
       :primaryIdentifier (pick (str class ".primaryIdentifier"))
       :symbol (pick (str class ".symbol"))
       :organism (pick (str class ".organism.shortName") (str class ".organism.name"))})))

(defn item-label [{:keys [symbol primaryIdentifier id]}]
  (or symbol primaryIdentifier (str id)))

(defn default-list-name [item-count]
  (str "Gene cart, " item-count (if (= 1 item-count) " gene" " genes")))

(defn effective-list-name [{:keys [list-name default-name]}]
  (if (some? list-name) list-name default-name))

(defn combine-object-ids
  "Ids of own items plus ids resolved in the same mine, as distinct strings."
  [own-ids resolved-ids]
  (->> (concat own-ids resolved-ids) (map str) distinct vec))

;;; Events ;;;

(defn- ui-path [scope & ks]
  (into [:gene-cart :ui scope] ks))

(defn- mine-label [db mine-kw]
  (or (get-in db [:env :mines mine-kw :name])
      (get-in db [:mines mine-kw :name])
      (name mine-kw)))

(defn- update-items
  "Applies `f` to the items in storage, the source of truth when several tabs
  are open, then mirrors and persists the result."
  [{db :db stored :local-store} f]
  (let [items (f (sanitize stored))]
    {:db (assoc-in db [:gene-cart :items] items)
     :persist [storage-key items]}))

(reg-event-fx
 ::load
 [(inject-cofx :local-store storage-key)]
 (fn [{db :db stored :local-store} _]
   {:db (assoc-in db [:gene-cart :items] (sanitize stored))}))

(reg-event-fx
 ::add
 [(inject-cofx :local-store storage-key)]
 (fn [cofx [_ item]]
   (update-items cofx #(add-item % item))))

(reg-event-fx
 ::remove
 [(inject-cofx :local-store storage-key)]
 (fn [cofx [_ k]]
   (update-items cofx #(remove-item % k))))

(reg-event-fx
 ::clear
 [(inject-cofx :local-store storage-key)]
 (fn [cofx _]
   (-> (update-items cofx (constantly []))
       (update-in [:db :gene-cart] assoc :ui {}))))

(reg-event-db
 ::toggle-tray
 (fn [db _]
   (update-in db [:gene-cart :open?] not)))

(reg-event-db
 ::set-list-name
 (fn [db [_ scope value]]
   (assoc-in db (ui-path scope :list-name) value)))

(reg-event-fx
 ::save
 [(inject-cofx :local-store :bluegenes/login)]
 (fn [{db :db login :local-store} [_ scope]]
   (let [items (get-in db [:gene-cart :items])
         target (if (= scope :all) (:current-mine db) scope)
         svc (stm/target-service db login target)
         own (mine-items items target)
         others (if (= scope :all) (foreign-items items target) [])
         source-ids (source-identifiers others)
         base (assoc-in db (ui-path scope)
                        {:list-name (get-in db (ui-path scope :list-name))
                         :default-name (default-list-name (count (concat own others)))})]
     (cond
       (not (contains? svc :token)) {:db (assoc-in base (ui-path scope :logged-in?) false)}
       (get-in db (ui-path scope :saving?)) {}
       (empty? (concat own source-ids)) {}
       :else
       (let [db (update-in base (ui-path scope) assoc :logged-in? true :saving? true)]
         (if (seq source-ids)
           {:db db
            :im-chan {:chan (fetch/resolve-identifiers svc {:identifiers (stm/all-candidates source-ids)
                                                            :type cart-class
                                                            :timeout-ms stm/resolve-timeout-ms})
                      :abort ::resolve
                      :on-success [::resolved scope target svc (object-ids own) source-ids]
                      :on-failure [::save-failure scope target]
                      :on-unauthorised [::unauthorised scope target]}}
           {:db db
            :dispatch [::fetch-lists scope target svc (object-ids own) 0]}))))))

(reg-event-fx
 ::resolved
 (fn [{db :db} [_ scope target svc own-ids source-ids res]]
   (let [{:keys [object-ids unresolved] :as result} (stm/classify-resolution source-ids res)
         ids (combine-object-ids own-ids object-ids)
         db (assoc-in db (ui-path scope :result) (select-keys result [:resolved :source-count :unresolved]))]
     (if (empty? ids)
       {:db (assoc-in db (ui-path scope :saving?) false)
        :dispatch [:messages/add
                   {:markup [:span "None of the " [:strong (count source-ids)]
                             " genes could be found in " [:strong (mine-label db target)] "."]
                    :timeout 10000
                    :style "warning"}]}
       {:db db
        :dispatch [::fetch-lists scope target svc ids (count unresolved)]}))))

(reg-event-fx
 ::fetch-lists
 (fn [_ [_ scope target svc ids unresolved-count]]
   {:im-chan {:chan (fetch/lists svc)
              :on-success [::create scope target svc ids unresolved-count]
              :on-failure [::save-failure scope target]
              :on-unauthorised [::unauthorised scope target]}}))

(reg-event-fx
 ::create
 (fn [{db :db} [_ scope target svc ids unresolved-count lists]]
   (let [typed (effective-list-name (get-in db (ui-path scope)))
         list-name (if (some (comp #{typed} :name) lists)
                     (copy-list-name lists typed)
                     typed)]
     {:im-chan {:chan (save/im-list-from-query svc list-name (stm/object-ids-query ids))
                :on-success [::saved scope target unresolved-count]
                :on-failure [::save-failure scope target]
                :on-unauthorised [::unauthorised scope target]}})))

(reg-event-fx
 ::saved
 (fn [{db :db} [_ scope target unresolved-count {:keys [listName]}]]
   {:db (update-in db (ui-path scope) assoc
                   :saving? false
                   :saved {:name listName :mine target})
    :dispatch [:messages/add
               {:markup [:span "Saved list " [:strong listName] " in "
                         [:strong (mine-label db target)] "."
                         (when (pos? unresolved-count)
                           (str " " unresolved-count " genes could not be resolved and were skipped."))]
                :timeout 10000
                :style "success"}]}))

(reg-event-fx
 ::save-failure
 (fn [{db :db} [_ scope target res]]
   {:db (assoc-in db (ui-path scope :saving?) false)
    :dispatch (orthologs/failure-message
               (str "Failed to save list in " (mine-label db target) ".") res)}))

(reg-event-fx
 ::unauthorised
 ;; Handled here so the generic invalid-token flow leaves the login of the
 ;; current mine alone.
 (fn [{db :db} [_ scope target _res]]
   {:db (-> db
            (assoc-in (ui-path scope :saving?) false)
            (assoc-in (ui-path scope :logged-in?) false))
    :dispatch [:messages/add
               {:markup [:span "Your login for " [:strong (mine-label db target)]
                         " has expired. Log in there again to save the list."]
                :timeout 10000
                :style "warning"}]}))

;;; Subscriptions ;;;

(reg-sub ::items (fn [db] (get-in db [:gene-cart :items] [])))
(reg-sub ::open? (fn [db] (boolean (get-in db [:gene-cart :open?]))))
(reg-sub ::ui (fn [db [_ scope]] (get-in db (ui-path scope))))

(reg-sub
 ::count
 :<- [::items]
 (fn [items] (count items)))

(reg-sub
 ::groups
 :<- [::items]
 :<- [:env/mines]
 (fn [[items env-mines]]
   (mapv (fn [[mine mine-items]]
           {:mine mine
            :label (or (get-in env-mines [mine :name]) (name mine))
            :items mine-items})
         (group-by-mine items))))

(reg-sub
 ::report-item
 (fn [db]
   (let [[mine class id] (get-in db [:report :key])]
     (when (and (= class cart-class) (not (get-in db [:report :error])))
       (summary->item mine class id (get-in db [:report :summary]))))))

(reg-sub
 ::report-in-cart?
 :<- [::items]
 :<- [::report-item]
 (fn [[items item]]
   (and (some? item) (in-cart? items item))))

;;; Views ;;;

(defn add-button
  "Button for a Gene report page header. Renders nothing for other classes."
  []
  (let [item @(subscribe [::report-item])
        in? @(subscribe [::report-in-cart?])]
    (when item
      [:button.btn.btn-slim.cart-add
       {:type "button"
        :on-click #(dispatch [(if in? ::remove ::add) (if in? (item-key item) item)])}
       (if in? "Remove from cart" "Add to cart")])))

(defn- save-controls [scope target label n]
  (let [{:keys [saving? logged-in? saved result] :as ui} @(subscribe [::ui scope])
        name* (or (effective-list-name ui) (default-list-name n))]
    [:div.cart-save
     (when (false? logged-in?) [stm/login-notice target label])
     [:input.form-control
      {:type "text"
       :aria-label "List name"
       :value name*
       :on-change #(dispatch [::set-list-name scope (oget % :target :value)])}]
     [:button.btn.btn-default
      {:type "button"
       :disabled (or saving? (str/blank? name*))
       :on-click #(dispatch [::save scope])}
      (cond
        saving? "Saving..."
        (= scope :all) (str "Save all to " label)
        :else "Save as list")]
     (when (seq (:unresolved result))
       [:p.text-muted (count (:unresolved result)) " not found in " label ": "
        (str/join ", " (take 10 (:unresolved result)))
        (when (> (count (:unresolved result)) 10) ", ...")])
     (when saved
       [:p.saved-list
        "Saved. "
        [:a {:href (route/href ::route/results {:mine (:mine saved) :title (:name saved)})}
         "Open " (:name saved)]])]))

(defn- item-row [{:keys [mine class id organism] :as item}]
  [:li.cart-item
   [:a {:href (route/href ::route/report {:mine mine :type class :id id})}
    (item-label item)]
   (when organism [:span.text-muted " " organism])
   [:button.btn.btn-link.btn-xs.cart-remove
    {:type "button"
     :aria-label (str "Remove " (item-label item))
     :on-click #(dispatch [::remove (item-key item)])}
    "Remove"]])

(defn tray []
  (let [groups @(subscribe [::groups])
        current @(subscribe [:current-mine-name])
        n @(subscribe [::count])
        current-label @(subscribe [::mine-label current])
        others? (some #(not= current (:mine %)) groups)]
    [:div.cart-tray
     {:style {:position "absolute" :right 0 :top "100%" :z-index 1100
              :width "22em" :max-height "70vh" :overflow-y "auto"
              :padding "1em" :background "#fff" :color "#333"
              :box-shadow "0 2px 8px rgba(0,0,0,.3)" :text-align "left"}}
     (if (zero? n)
       [:p "The cart is empty. Use Add to cart on a gene report page."]
       [:<>
        (for [{:keys [mine label items]} groups]
          ^{:key mine}
          [:div.cart-mine
           [:h4 label " " [:small (count items)]]
           (into [:ul.list-unstyled]
                 (map (fn [i] ^{:key (item-key i)} [item-row i]) items))
           [save-controls mine mine label (count items)]])
        (when others?
          [:div.cart-all
           [:h4 "Current mine"]
           [save-controls :all current current-label n]])
        [:button.btn.btn-link.cart-clear
         {:type "button" :on-click #(dispatch [::clear])}
         "Clear cart"]])]))

(reg-sub
 ::mine-label
 :<- [:env/mines]
 (fn [env-mines [_ mine]]
   (or (get-in env-mines [mine :name]) (name mine))))

(defn nav-item
  "Navbar entry: cart icon with the item count, opening the tray."
  []
  (r/create-class
   {:component-did-mount #(dispatch [::load])
    :reagent-render
    (fn []
      (let [n @(subscribe [::count])
            open? @(subscribe [::open?])]
        [:li.primary-nav.cart-nav {:style {:position "relative"}}
         [:a {:role "button"
              :title "Gene cart"
              :on-click #(dispatch [::toggle-tray])}
          [:svg.icon.icon-selection {:aria-hidden true :focusable false}
           [:use {:xlinkHref "#icon-selection"}]]
          [:span.cart-count (str " Cart (" n ")")]]
         (when open? [tray])]))}))
