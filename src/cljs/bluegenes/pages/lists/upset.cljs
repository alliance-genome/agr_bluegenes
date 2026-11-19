(ns bluegenes.pages.lists.upset
  "Overlap of 2 to 5 lists of the same type as an UpSet chart. A region is the
  set of ids that belong to exactly the lists of its members. The region logic
  and the chart layout are pure; events, subscriptions and views follow."
  (:require [re-frame.core :refer [reg-event-db reg-event-fx reg-sub subscribe dispatch]]
            [clojure.string :as str]
            [oops.core :refer [oget]]
            [imcljs.fetch :as fetch]
            [imcljs.save :as save]
            [bluegenes.components.icons :refer [icon]]
            [bluegenes.pages.lists.utils :refer [copy-list-name folder?]]))

;;; Regions

(def min-lists 2)
(def max-lists 5)
(def max-ids 100000)

(defn- membership
  "Map of id to the sorted vector of indices of the sets containing it."
  [sets]
  (reduce (fn [acc [i {:keys [ids]}]]
            (reduce #(update %1 %2 (fnil conj []) i) acc (distinct ids)))
          {}
          (map-indexed vector sets)))

(defn regions
  "Non-empty exclusive regions of `sets`, each a map of :members (set indices),
  :ids (sorted) and :size. Largest first, then fewer members, then members."
  [sets]
  (->> (membership sets)
       (group-by val)
       (map (fn [[members entries]]
              {:members members
               :ids (vec (sort (map key entries)))
               :size (count entries)}))
       (sort-by (juxt (comp - :size) (comp count :members) :members))
       vec))

(defn set-sizes
  "Number of distinct ids in each set."
  [sets]
  (mapv (comp count distinct :ids) sets))

(defn selection-error
  "Why `lists` cannot be compared, or nil. Lists are maps with :type and :size."
  ([lists] (selection-error lists max-ids))
  ([lists limit]
   (let [n (count lists)]
     (cond
       (< n min-lists) (str "Select at least " min-lists " lists to compare.")
       (> n max-lists) (str "Select at most " max-lists " lists to compare.")
       (not (apply = (map :type lists))) "Lists must be of the same type to compare."
       (some #(> (:size %) limit) lists) (str "A list has more than " limit " items.")))))

(defn- join-names [names]
  (if (> (count names) 1)
    (str (str/join ", " (butlast names)) " and " (last names))
    (first names)))

(defn region-title
  "Default name for the list saved from a region."
  [titles members total]
  (cond-> (join-names (mapv titles members))
    (< (count members) total) (str " only")))

;;; Queries

(defn ids-query [type list-name]
  {:from type
   :select [(str type ".id")]
   :where [{:path type :op "IN" :value list-name}]})

(defn ids-by-id-query [type ids]
  {:from type
   :select [(str type ".id")]
   :where [{:path (str type ".id") :op "ONE OF" :values (mapv str ids)}]})

;;; Layout

(def ^:private col-w 28)
(def ^:private row-h 24)
(def ^:private bar-h 130)
(def ^:private top-pad 20)
(def ^:private size-w 90)
(def ^:private label-w 130)

(defn geometry
  "Pixel layout of the chart: region bars, matrix rows and set size bars."
  [sets regions]
  (let [max-region (apply max 1 (map :size regions))
        sizes (set-sizes sets)
        max-set (apply max 1 sizes)
        x0 (+ size-w label-w)
        row-y (fn [j] (+ top-pad bar-h (* row-h j) (/ row-h 2)))]
    {:width (+ x0 (* col-w (count regions)) 8)
     :height (+ top-pad bar-h (* row-h (count sets)) 4)
     :x0 x0
     :label-x (+ size-w 6)
     :bars (map-indexed
            (fn [i {:keys [size members]}]
              (let [h (Math/round (* bar-h (/ size max-region)))]
                {:members members
                 :size size
                 :x (+ x0 (* i col-w) 4)
                 :w (- col-w 8)
                 :y (- (+ top-pad bar-h) h)
                 :h h
                 :cx (+ x0 (* i col-w) (/ col-w 2))}))
            regions)
     :rows (map-indexed (fn [j {:keys [name]}] {:index j :name name :cy (row-y j)}) sets)
     :set-bars (map-indexed
                (fn [j size]
                  (let [w (Math/round (* (- size-w 30) (/ size max-set)))]
                    {:size size :w w :x (- size-w w) :y (- (row-y j) 6) :h 12}))
                sizes)}))

;;; Events

(def state-path [:lists-upset])

(defn- service [db]
  (get-in db [:mines (:current-mine db) :service]))

(defn- failure-message [title res]
  [:messages/add
   {:markup [:span [:strong title] " "
             [:code (or (not-empty (get-in res [:body :error]))
                        "Please check your connection and try again later.")]]
    :timeout 10000
    :style "danger"}])

(defn- selected-details [db]
  (let [{:keys [by-id selected-lists]} (:lists db)]
    (->> selected-lists (map by-id) (remove folder?) vec)))

(reg-sub
 ::selection-error
 :<- [:lists/selected-lists-details]
 (fn [lists]
   (selection-error (vec (remove folder? lists)))))

(reg-event-fx
 ::open
 (fn [{db :db} _]
   (let [lists (selected-details db)
         error (selection-error lists)
         type (:type (first lists))]
     (if error
       {:db (assoc-in db state-path {:open? true :error error})}
       {:db (assoc-in db state-path {:open? true
                                     :loading? true
                                     :type type
                                     :lists (mapv #(select-keys % [:name :title]) lists)})
        :im-chan {:chans (map #(fetch/rows (service db) (ids-query type (:name %))
                                           {:format "json" :size max-ids})
                              lists)
                  :on-success [::loaded]
                  :on-failure [::failure]}}))))

(defn- parse-ids [rows]
  (mapv first rows))

(reg-event-db
 ::loaded
 (fn [db [_ responses]]
   (if (get-in db (conj state-path :open?))
     (update-in db state-path
                (fn [state]
                  (-> state
                      (assoc :loading? false)
                      (update :lists
                              (fn [lists]
                                (mapv #(assoc %1 :ids (parse-ids (:results %2))) lists responses))))))
     db)))

(reg-event-fx
 ::failure
 (fn [{db :db} [_ res]]
   {:db (assoc-in db state-path nil)
    :dispatch (failure-message "Failed to fetch list contents." (if (sequential? res) (first res) res))}))

(reg-event-db
 ::close
 (fn [db _]
   (assoc-in db state-path nil)))

(reg-event-db
 ::select-region
 (fn [db [_ members]]
   (update-in db state-path
              (fn [state]
                (assoc state
                       :selected (when (not= members (:selected state)) members)
                       :list-name nil)))))

(reg-event-db
 ::set-list-name
 (fn [db [_ value]]
   (assoc-in db (conj state-path :list-name) value)))

(defn- region-ids [state members]
  (some #(when (= members (:members %)) (:ids %))
        (regions (:lists state))))

(defn- region-name [{:keys [lists list-name]} members]
  (if (some? list-name)
    list-name
    (region-title (mapv :title lists) members (count lists))))

(reg-event-fx
 ::save
 (fn [{db :db} _]
   (let [{:keys [selected type saving?] :as state} (get-in db state-path)
         ids (region-ids state selected)
         typed (region-name state selected)
         existing (get-in db [:assets :lists (:current-mine db)])
         name (if (some (comp #{typed} :name) existing)
                (copy-list-name existing typed)
                typed)]
     (when (and (seq ids) (not (str/blank? typed)) (not saving?))
       {:db (assoc-in db (conj state-path :saving?) true)
        :im-chan {:chan (save/im-list-from-query (service db) name (ids-by-id-query type ids))
                  :on-success [::save-success]
                  :on-failure [::save-failure]}}))))

(reg-event-fx
 ::save-success
 (fn [{db :db} [_ {:keys [listName]}]]
   {:db (update-in db state-path assoc :saving? false :list-name nil :saved listName)
    :dispatch [:assets/fetch-lists]}))

(reg-event-fx
 ::save-failure
 (fn [{db :db} [_ res]]
   {:db (assoc-in db (conj state-path :saving?) false)
    :dispatch (failure-message "Failed to save list." res)}))

(reg-event-fx
 ::view
 (fn [{db :db} _]
   (let [{:keys [selected type] :as state} (get-in db state-path)
         ids (region-ids state selected)]
     (when (seq ids)
       {:dispatch [:results/history+
                   {:source (:current-mine db)
                    :type :query
                    :intent :list-overlap
                    :value (assoc (ids-by-id-query type ids)
                                  :title (region-name (dissoc state :list-name) selected))}]}))))

;;; Subscriptions

(reg-sub ::state (fn [db] (get-in db state-path)))

(reg-sub
 ::view-data
 :<- [::state]
 (fn [{:keys [lists]}]
   (let [regions (regions lists)]
     {:regions regions
      :geometry (geometry lists regions)})))

;;; Views

(defn chart [lists {:keys [geometry]} selected]
  (let [{:keys [width height bars rows set-bars x0 label-x]} geometry]
    [:svg.upset {:width width :height height :role "img"
                 :aria-label "Overlap of the selected lists"}
     (for [{:keys [index name cy]} rows
           :let [{:keys [x y w h size]} (nth set-bars index)]]
       ^{:key index}
       [:g
        [:rect {:x x :y y :width w :height h :fill "var(--agr-secondary)"}]
        [:text {:x (- x 3) :y (+ y 10) :text-anchor "end" :font-size 10
                :fill "var(--agr-text)"} size]
        [:text {:x label-x :y (+ cy 4) :font-size 11 :fill "var(--agr-text)"}
         (let [title (:title (nth lists index) name)]
           (if (> (count title) 20) (str (subs title 0 19) "...") title))]
        [:line {:x1 x0 :x2 width :y1 cy :y2 cy :stroke "var(--agr-border)"}]])
     (for [{:keys [members size x w y h cx]} bars
           :let [sel? (= members selected)
                 member? (set members)
                 member-ys (keep (fn [{:keys [index cy]}] (when (member? index) cy)) rows)]]
       ^{:key (str/join "-" members)}
       [:g {:style {:cursor "pointer"}
            :on-click #(dispatch [::select-region members])}
        [:title (str size " items in " (str/join ", " (map #(:title (nth lists %)) members)))]
        [:rect {:x (- cx (/ col-w 2)) :y 0 :width col-w :height height
                :fill (if sel? "var(--agr-primary-light)" "transparent")}]
        [:rect {:x x :y y :width w :height h :fill "var(--agr-primary)"}]
        [:text {:x cx :y (- y 3) :text-anchor "middle" :font-size 10
                :fill "var(--agr-text)"} size]
        (when (> (count member-ys) 1)
          [:line {:x1 cx :x2 cx :y1 (apply min member-ys) :y2 (apply max member-ys)
                  :stroke "var(--agr-text)" :stroke-width 2}])
        (for [{:keys [index cy]} rows]
          ^{:key index}
          [:circle {:cx cx :cy cy :r 5
                    :fill (if (member? index) "var(--agr-text)" "var(--agr-border)")}])])]))

(defn region-panel [{:keys [lists selected list-name saving? saved] :as state} regions]
  (let [{:keys [size]} (some #(when (= selected (:members %)) %) regions)
        typed (region-name state selected)]
    [:div.upset-selection
     [:h4.upset-selected
      (str size " items in " (str/join ", " (map #(:title (nth lists %)) selected)))
      (when (< (count selected) (count lists)) " only")]
     [:div.agr-filter-bar
      [:label "New list name"
       [:input.form-control
        {:type "text"
         :value typed
         :on-change #(dispatch [::set-list-name (oget % :target :value)])}]]
      [:button.agr-btn-primary
       {:type "button"
        :disabled (or saving? (str/blank? typed))
        :on-click #(dispatch [::save])}
       (if saving? "Saving" "Save as list")]
      [:button.agr-btn
       {:type "button"
        :on-click #(dispatch [::view])}
       "View"]]
     (when saved
       [:p.agr-note (str "Saved list " saved ".")])]))

(defn panel []
  (let [{:keys [open? loading? error selected] :as state} @(subscribe [::state])
        {:keys [regions] :as data} @(subscribe [::view-data])]
    (when open?
      [:section.agr-section.upset-panel
       [:div.upset-heading
        [:h3.agr-section-title "List overlap"]
        [:button.agr-btn {:type "button" :on-click #(dispatch [::close])} "Close"]]
       (cond
         error [:p.agr-empty error]
         loading? [:p.agr-loading "Fetching list contents"]
         (empty? regions) [:p.agr-empty "The selected lists are empty."]
         :else
         [:<>
          [:p.agr-note "Click a bar to save or view the items in that region."]
          [:div {:style {:overflow-x "auto"}}
           [chart (:lists state) data selected]]
          (when selected
            [region-panel state regions])])])))

(defn button
  "Entry point next to the list operations. Disabled with the reason as its
  tooltip while the selection cannot be compared."
  []
  (let [error @(subscribe [::selection-error])]
    [:button.agr-btn
     {:type "button"
      :disabled (boolean error)
      :title error
      :on-click #(dispatch [::open])}
     "Compare overlap"
     [icon "venn-intersection"]]))
