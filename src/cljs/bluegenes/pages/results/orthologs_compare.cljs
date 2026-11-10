(ns bluegenes.pages.results.orthologs-compare
  "Compare the orthologs of a Gene list across all organisms in the mine.
  Homologue is pairwise, so each list gene gets its own set of organisms in
  which it has at least one ortholog. No transitive rule is applied. The set
  and intersection logic is pure; events and views follow it."
  (:require [re-frame.core :refer [reg-event-db reg-event-fx reg-sub subscribe dispatch]]
            [clojure.string :as str]
            [oops.core :refer [oget]]
            [imcljs.fetch :as fetch]
            [imcljs.save :as save]
            [bluegenes.route :as route]
            [bluegenes.pages.lists.utils :refer [copy-list-name]]
            [bluegenes.pages.results.orthologs :as orthologs]))

;;; Model gating

(defn- class-field
  "Field map (with :referencedType for references and collections) of `field`
  on the class or any class it extends, or nil."
  [model-classes class-kw field]
  (let [k (get model-classes class-kw)]
    (or (some #(get (get k %) field) [:attributes :references :collections])
        (some #(class-field model-classes (keyword %) field) (:extends k)))))

(defn path-resolves?
  "True when the dotted path (Gene.homologues.homologue.id) resolves in the
  model. Each segment must be a field of the class reached so far, including
  inherited ones. All segments but the last must be references or collections."
  [model-classes path]
  (let [[root & fields] (str/split path #"\.")]
    (and (contains? model-classes (keyword root))
         (loop [cls (keyword root) [f & more] fields]
           (let [field (class-field model-classes cls (keyword f))]
             (cond (nil? field) false
                   (empty? more) true
                   (:referencedType field) (recur (keyword (:referencedType field)) more)
                   :else false))))))

(def required-paths
  "Paths the comparison cannot work without."
  ["Gene.id" "Gene.primaryIdentifier" "Gene.symbol" "Gene.organism.shortName"
   "Gene.homologues.homologue.id" "Gene.homologues.homologue.organism.shortName"])

(def stringency-path "Gene.homologues.stringencyFilter")
(def best-score-path "Gene.homologues.isBestScore")

(defn compare-available?
  "True for a Gene list in a mine whose model has every required path."
  [model-classes {:keys [type] :as list}]
  (boolean
   (and list
        (= type "Gene")
        (every? #(path-resolves? model-classes %) required-paths))))

(defn pair-features
  "Optional pair columns the model has: {:stringency? .. :best-score? ..}.
  WormMine has neither, FlyMine and YeastMine have only the best score."
  [model-classes]
  {:stringency? (path-resolves? model-classes stringency-path)
   :best-score? (path-resolves? model-classes best-score-path)})

;;; Pure logic

(def max-intersections 15)

(def stringency-order
  "Known Homologue.stringencyFilter values, strictest first. A row labelled
  with a stricter level also passes every looser one."
  ["stringent" "moderate"])

(defn stringency-rank
  "Position of a stringency value in the strictness order. Unknown values
  rank after the known ones, in no particular order among themselves."
  [value]
  (let [idx (.indexOf stringency-order value)]
    (if (neg? idx) (count stringency-order) idx)))

(defn genes-query
  "List genes with the columns shown in the gene table."
  [list-name]
  {:from "Gene"
   :select ["Gene.id" "Gene.primaryIdentifier" "Gene.symbol" "Gene.organism.shortName"]
   :orderBy [{:path "Gene.symbol" :direction "ASC"}]
   :where [(orthologs/list-constraint list-name)]})

(def all-features {:stringency? true :best-score? true})

(defn pairs-query
  "One row per list gene and homologue. Genes without homologues are absent.
  Stringency and best score columns are selected only when `features` says
  the mine has them, in that order after the organism."
  ([list-name] (pairs-query list-name all-features))
  ([list-name {:keys [stringency? best-score?]}]
   {:from "Gene"
    :select (cond-> ["Gene.id"
                     "Gene.homologues.homologue.id"
                     "Gene.homologues.homologue.organism.shortName"]
              stringency? (conj stringency-path)
              best-score? (conj best-score-path))
    :where [(orthologs/list-constraint list-name)]}))

(defn genes-by-id-query
  "Query saved as a list for the genes of one intersection."
  [gene-ids]
  {:from "Gene"
   :select ["Gene.id"]
   :where [{:path "Gene.id" :op "ONE OF" :values (mapv str gene-ids)}]})

(defn parse-genes
  "Rows of `genes-query` as maps."
  [rows]
  (mapv (fn [[id identifier symbol organism]]
          {:id id :identifier identifier :symbol symbol :organism organism})
        rows))

(defn- true-value?
  "isBestScore is a Boolean in AllianceMine and FlyMine, a String in YeastMine."
  [v]
  (or (true? v) (and (string? v) (= "true" (str/lower-case v)))))

(defn parse-pairs
  "Rows of `pairs-query` run with the same `features` as maps. Rows without an
  organism are dropped. Missing columns give a nil stringency and false best?."
  ([rows] (parse-pairs rows all-features))
  ([rows {:keys [stringency? best-score?]}]
   (into []
         (comp (filter (fn [[_ _ organism]] (not (str/blank? organism))))
               (map (fn [[gene ortholog organism & more]]
                      (let [stringency (when stringency? (first more))
                            best (when best-score? (nth more (if stringency? 1 0) nil))]
                        {:gene gene :ortholog ortholog :organism organism
                         :stringency stringency :best? (true-value? best)}))))
         rows)))

(defn stringency-values
  "Distinct stringency values present in the pairs, strictest first."
  [pairs]
  (->> pairs (keep :stringency) (remove str/blank?) distinct
       (sort-by (juxt stringency-rank identity)) vec))

(defn pair-passes?
  "True when the pair meets the chosen stringency (at least as strict) and,
  with `best-only?`, is the best score. A nil `stringency` accepts any."
  [{:keys [stringency best-only?]} pair]
  (and (or (nil? stringency)
           (and (:stringency pair)
                (<= (stringency-rank (:stringency pair)) (stringency-rank stringency))))
       (or (not best-only?) (:best? pair))))

(defn filter-pairs [opts pairs]
  (filterv #(pair-passes? opts %) pairs))

(defn organisms
  "All organisms: those of the list genes and those of the orthologs, sorted."
  [genes pairs]
  (->> (concat (keep :organism genes) (map :organism pairs))
       (remove str/blank?) distinct sort vec))

(defn organism-sets
  "Map of list gene id to the set of organisms where it has an ortholog.
  Every list gene is a key, with an empty set when it has none."
  [genes pairs]
  (let [by-gene (reduce (fn [m {:keys [gene organism]}]
                          (update m gene (fnil conj #{}) organism))
                        {} pairs)]
    (into {} (map (fn [{:keys [id]}] [id (get by-gene id #{})])) genes)))

(defn organism-counts
  "For one organism, how many list genes have exactly one ortholog (:one-to-one),
  more than one (:one-to-many) or none (:none). Orthologs count by distinct id."
  [genes pairs organism]
  (let [n-by-gene (->> pairs
                       (filter #(= organism (:organism %)))
                       (reduce (fn [m {:keys [gene ortholog]}]
                                 (update m gene (fnil conj #{}) ortholog))
                               {})
                       (into {} (map (fn [[g s]] [g (count s)]))))]
    (reduce (fn [acc {:keys [id]}]
              (let [n (get n-by-gene id 0)]
                (update acc (cond (zero? n) :none (= 1 n) :one-to-one :else :one-to-many)
                        inc)))
            {:one-to-one 0 :one-to-many 0 :none 0}
            genes)))

(defn counts-by-organism
  "Vector of {:organism .. :one-to-one .. :one-to-many .. :none ..}."
  [genes pairs orgs]
  (mapv #(assoc (organism-counts genes pairs %) :organism %) orgs))

(defn intersections
  "Genes grouped by their exact organism set, empty sets left out. Largest
  group first, then fewer organisms, then organism names. At most `limit`."
  ([sets] (intersections sets max-intersections))
  ([sets limit]
   (->> sets
        (remove (fn [[_ orgs]] (empty? orgs)))
        (group-by (fn [[_ orgs]] (vec (sort orgs))))
        (map (fn [[orgs entries]]
               {:organisms orgs
                :genes (vec (sort (map first entries)))
                :size (count entries)}))
        (sort-by (juxt (comp - :size) (comp count :organisms) :organisms))
        (take limit)
        vec)))

(defn default-list-name [list-name organisms]
  (str list-name " orthologs in " (str/join ", " organisms)))

(defn selected-genes
  "Gene maps of the genes in the intersection with these organisms."
  [genes ints selected]
  (let [ids (set (some #(when (= selected (:organisms %)) (:genes %)) ints))]
    (filterv #(contains? ids (:id %)) genes)))

;;; Events

(def state-path [:results :orthologs-compare])

(defn- service [db]
  (get-in db [:mines (:current-mine db) :service]))

(defn- model-classes [db]
  (get-in db [:mines (:current-mine db) :service :model :classes]))

(defn- current? [db list-source]
  (= list-source (get-in db (conj state-path :list-source))))

(reg-event-fx
 ::toggle
 (fn [{db :db} [_ list-name]]
   (if (get-in db (conj state-path :open?))
     {:db (assoc-in db state-path nil)}
     {:db (assoc-in db state-path {:open? true
                                   :list-source list-name
                                   :features (pair-features (model-classes db))
                                   :loading? true})
      :im-chan {:chan (fetch/rows (service db) (genes-query list-name)
                                  {:format "json" :size 100000})
                :abort ::genes
                :on-success [::genes-success list-name]
                :on-failure [::failure list-name]}})))

(reg-event-fx
 ::genes-success
 (fn [{db :db} [_ list-name res]]
   (when (current? db list-name)
     {:db (assoc-in db (conj state-path :genes) (parse-genes (:results res)))
      :im-chan {:chan (fetch/rows (service db)
                                  (pairs-query list-name (get-in db (conj state-path :features)))
                                  {:format "json" :size 1000000})
                :abort ::pairs
                :on-success [::pairs-success list-name]
                :on-failure [::failure list-name]}})))

(reg-event-db
 ::pairs-success
 (fn [db [_ list-name res]]
   (if (current? db list-name)
     (update-in db state-path assoc
                :loading? false
                :pairs (parse-pairs (:results res)
                                    (get-in db (conj state-path :features))))
     db)))

(reg-event-fx
 ::failure
 (fn [{db :db} [_ list-name res]]
   (when (current? db list-name)
     {:db (update-in db state-path assoc :loading? false :genes [] :pairs [])
      :dispatch (orthologs/failure-message "Failed to compare orthologs." res)})))

(reg-event-db
 ::set-stringency
 (fn [db [_ value]]
   (update-in db state-path assoc
              :stringency (when-not (str/blank? value) value)
              :selected nil)))

(reg-event-db
 ::set-best-only
 (fn [db [_ value]]
   (update-in db state-path assoc :best-only? (boolean value) :selected nil)))

(reg-event-db
 ::select-intersection
 (fn [db [_ organisms]]
   (update-in db state-path
              (fn [state]
                (assoc state
                       :selected (when (not= organisms (:selected state)) organisms)
                       :list-name nil)))))

(reg-event-db
 ::set-list-name
 (fn [db [_ value]]
   (assoc-in db (conj state-path :list-name) value)))

(reg-event-fx
 ::save
 (fn [{db :db} [_ gene-ids]]
   (let [{:keys [list-source selected list-name saving?]} (get-in db state-path)
         lists (get-in db [:assets :lists (:current-mine db)])
         typed (if (some? list-name) list-name (default-list-name list-source selected))
         name (if (some (comp #{typed} :name) lists)
                (copy-list-name lists typed)
                typed)]
     (when (and (seq gene-ids) (not (str/blank? typed)) (not saving?))
       {:db (assoc-in db (conj state-path :saving?) true)
        :im-chan {:chan (save/im-list-from-query (service db) name (genes-by-id-query gene-ids))
                  :on-success [::save-success]
                  :on-failure [::save-failure]}}))))

(reg-event-fx
 ::save-success
 (fn [{db :db} [_ {:keys [listName]}]]
   {:db (assoc-in db state-path nil)
    :dispatch [:assets/fetch-lists
               [::route/navigate ::route/results {:title listName}]]}))

(reg-event-fx
 ::save-failure
 (fn [{db :db} [_ res]]
   {:db (assoc-in db (conj state-path :saving?) false)
    :dispatch (orthologs/failure-message "Failed to save list of genes." res)}))

;;; Subscriptions

(reg-sub ::state (fn [db] (get-in db state-path)))

(reg-sub
 ::available?
 :<- [:results/current-list]
 :<- [:model]
 (fn [[list model]]
   (compare-available? model list)))

(reg-sub
 ::view-data
 :<- [::state]
 (fn [{:keys [genes pairs stringency best-only? features]}]
   (let [orgs (organisms genes pairs)
         kept (filter-pairs {:stringency stringency :best-only? best-only?} pairs)]
     {:organisms orgs
      :stringencies (stringency-values pairs)
      :features features
      :counts (counts-by-organism genes kept orgs)
      :intersections (intersections (organism-sets genes kept))
      :gene-count (count genes)})))

;;; Views

(def ^:private col-w 30)
(def ^:private row-h 22)
(def ^:private bar-h 140)
(def ^:private label-w 120)
(def ^:private pad 24)

(defn upset-geometry
  "Pixel layout of the UpSet plot. Pure so it can be tested."
  [orgs ints]
  (let [max-size (apply max 1 (map :size ints))]
    {:width (+ label-w (* col-w (count ints)) 8)
     :height (+ pad bar-h (* row-h (count orgs)) 4)
     :bars (map-indexed
            (fn [i {:keys [size organisms]}]
              (let [h (Math/round (* bar-h (/ size max-size)))]
                {:organisms organisms
                 :size size
                 :x (+ label-w (* i col-w) 4)
                 :w (- col-w 8)
                 :y (- (+ pad bar-h) h)
                 :h h
                 :cx (+ label-w (* i col-w) (/ col-w 2))}))
            ints)
     :rows (map-indexed (fn [j o] {:organism o :cy (+ pad bar-h (* row-h j) (/ row-h 2))})
                        orgs)}))

(defn upset-plot [orgs ints selected]
  (let [{:keys [width height bars rows]} (upset-geometry orgs ints)]
    [:svg.upset {:width width :height height :role "img"
                 :aria-label "Overlap of list genes by organisms with orthologs"}
     (for [{:keys [organism cy]} rows]
       ^{:key organism}
       [:g
        [:text {:x (- label-w 8) :y (+ cy 4) :text-anchor "end" :font-size 11} organism]
        [:line {:x1 label-w :x2 width :y1 cy :y2 cy :stroke "#ddd"}]])
     (for [{:keys [organisms size x w y h cx]} bars
           :let [sel? (= organisms selected)
                 members (set organisms)
                 member-ys (keep (fn [{:keys [organism cy]}]
                                   (when (members organism) cy))
                                 rows)]]
       ^{:key (str/join "|" organisms)}
       [:g {:style {:cursor "pointer"}
            :on-click #(dispatch [::select-intersection organisms])}
        [:title (str size " genes: " (str/join ", " organisms))]
        [:rect {:x (- cx (/ col-w 2)) :y 0 :width col-w :height height
                :fill (if sel? "#e8f0fe" "transparent")}]
        [:rect {:x x :y y :width w :height h :fill (if sel? "#1a4f8b" "#4a7fb5")}]
        [:text {:x cx :y (- y 3) :text-anchor "middle" :font-size 10} size]
        (when (> (count member-ys) 1)
          [:line {:x1 cx :x2 cx :y1 (apply min member-ys) :y2 (apply max member-ys)
                  :stroke "#333" :stroke-width 2}])
        (for [{:keys [organism cy]} rows]
          ^{:key organism}
          [:circle {:cx cx :cy cy :r 5
                    :fill (if (members organism) "#333" "#ddd")}])])]))

(defn counts-table [counts gene-count]
  [:table.table.table-condensed.ortholog-compare-counts
   [:caption (str gene-count " genes in the list")]
   [:thead
    [:tr [:th "Organism"] [:th "1:1"] [:th "1:many"] [:th "No ortholog"]]]
   [:tbody
    (for [{:keys [organism one-to-one one-to-many none]} counts]
      ^{:key organism}
      [:tr [:td organism] [:td one-to-one] [:td one-to-many] [:td none]])]])

(defn selection-panel [{:keys [genes selected list-name saving?]} ints list-source]
  (let [chosen (selected-genes genes ints selected)
        typed (if (some? list-name) list-name (default-list-name list-source selected))]
    [:div.ortholog-compare-selection
     [:h4 (str (count chosen) " genes with orthologs in exactly " (str/join ", " selected))]
     [:ul.list-unstyled
      (for [{:keys [id symbol identifier]} chosen]
        ^{:key id} [:li (or symbol identifier)])]
     [:div.form-group
      [:label "New list name"]
      [:input.form-control
       {:type "text"
        :value typed
        :on-change #(dispatch [::set-list-name (oget % :target :value)])}]]
     [:button.btn.btn-primary.btn-raised
      {:type "button"
       :disabled (or saving? (str/blank? typed))
       :on-click #(dispatch [::save (mapv :id chosen)])}
      (if saving? "Saving..." "Save as list")]]))

(defn compare-panel []
  (let [{:keys [loading? stringency best-only? selected list-source pairs] :as state}
        @(subscribe [::state])
        {:keys [organisms stringencies counts intersections gene-count features]}
        @(subscribe [::view-data])]
    [:div.orthologs-compare-panel
     (cond
       loading? [:p "Comparing orthologs..."]
       (empty? pairs) [:p "No orthologs found for the genes in this list."]
       :else
       [:<>
        [:div.form-inline
         (when (and (:stringency? features) (seq stringencies))
           [:div.form-group
            [:label "Stringency "]
            [:select.form-control
             {:value (or stringency "")
              :on-change #(dispatch [::set-stringency (oget % :target :value)])}
             [:option {:value ""} "Any"]
             (for [s stringencies]
               ^{:key s} [:option {:value s} s])]])
         (when (:best-score? features)
           [:label.checkbox-inline
            [:input {:type "checkbox"
                     :checked (boolean best-only?)
                     :on-change #(dispatch [::set-best-only (oget % :target :checked)])}]
            " Best score only"])]
        [counts-table counts gene-count]
        (if (empty? intersections)
          [:p "No list gene has an ortholog with these settings."]
          [:<>
           [:p (str "Top " (count intersections) " overlaps. Click a bar for its genes.")]
           [:div {:style {:overflow-x "auto"}}
            [upset-plot organisms intersections selected]]])
        (when selected
          [selection-panel state intersections list-source])])]))

(defn compare-button
  "Toggle button and panel. Renders nothing unless the current list is a Gene
  list in a mine whose model has every path in `required-paths`."
  [list-name]
  (when @(subscribe [::available?])
    [:div.compare-orthologs
     [:button.btn.btn-slim
      {:type "button"
       :on-click #(dispatch [::toggle list-name])}
      "Compare across species"]
     (when (:open? @(subscribe [::state]))
       [compare-panel])]))
