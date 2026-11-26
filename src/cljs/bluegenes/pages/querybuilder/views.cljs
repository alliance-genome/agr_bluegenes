(ns bluegenes.pages.querybuilder.views
  (:require [re-frame.core :refer [subscribe dispatch]]
            [reagent.core :as reagent]
            [clojure.string :as string :refer [split join lower-case]]
            [oops.core :refer [ocall oget]]
            [bluegenes.components.ui.constraint :refer [constraint]]
            [bluegenes.components.bootstrap :refer [tooltip poppable]]
            [imcljs.path :as im-path]
            [imcljs.query :refer [->xml]]
            [bluegenes.components.loader :refer [mini-loader]]
            [bluegenes.components.ui.results_preview :refer [preview-table]]
            [inflections.core :refer [ordinalize plural]]
            [bluegenes.components.icons :refer [icon]]
            [bluegenes.pages.querybuilder.logic :refer [constraint-key]]))

(defn query=
  "Returns whether `queries` are all =, ignoring empty values like [] and nil."
  [& queries]
  (apply =
         (map #(into {} (remove (comp empty? val)) %)
              queries)))

(def aquery {:from "Gene"
             :constraintLogic "A or B"
             :select ["symbol"
                      "organism.name"
                      "alleles.symbol"
                      "alleles.phenotypeAnnotations.annotationType"
                      "alleles.phenotypeAnnotations.description"]
             :where [{:path "Gene.symbol"
                      :op "="
                      :code "A"
                      :value "zen"}
                     {:path "Gene.symbol"
                      :op "="
                      :code "B"
                      :value "mad"}]})

(defn sort-classes
  [classes]
  (sort-by (comp string/lower-case :displayName val) compare classes))

(defn filter-populated
  [classes]
  (filter (comp pos? :count val)
          classes))

(defn filter-preferred
  [classes]
  (filter #(contains? (-> % val :tags set) "im:preferredBagType")
          classes))

(defn root-class-dropdown []
  (let [model @(subscribe [:model])
        root-class @(subscribe [:qb/root-class])
        classes (-> model filter-populated sort-classes)
        preferred (filter-preferred classes)]
    (into [:select.form-control
           {:on-change (fn [e] (dispatch [:qb/set-root-class (oget e :target :value)]))
            :value (or root-class "")}
           (when (nil? root-class)
             [:<>
              [:option {:value ""} "Select to start query"]
              [:option {:disabled true :role "separator"} "─────────────────────────"]])]
          (map (fn [[class-kw details :as item]]
                 (if (map-entry? item)
                   [:option {:value class-kw} (:displayName details)]
                   [:option {:disabled true :role "separator"} "─────────────────────────"]))
               (concat preferred [[:separator]] classes)))))

(defn dotsplit [string] (split string "."))

(defn im-query->map [{:keys [select]}]
  (reduce (fn [total next] (assoc-in total next {})) {} (map dotsplit select)))

(defn attributes-first [[_ v]] (empty? v))

(defn has-children? [[_ v]] (some? (not-empty v)))

(defn display-name [model class]
  (let [class-kw (cond-> class
                   (string? class) keyword)]
    (get-in model [:classes class-kw :displayName])))

;; I think we can replace this function with `im-path/walk`.
(defn rel-prop-fn [prop]
  (fn [model path]
    (let [class (->> (drop-last 1 path)
                     (im-path/walk model)
                     (last))
          ;; `path` can point to either an attribute or a class.
          attrib+class (last path)
          ;; We don't use `im-path/properties` as we need to support subclasses.
          properties (apply merge (map class [:attributes :references :collections]))]
      (get-in properties [attrib+class prop]))))

(def rel-display-name (rel-prop-fn :displayName))
(def rel-referenced-type (rel-prop-fn :referencedType))

(defn attribute []
  (let [enhance-query (subscribe [:qb/enhance-query])]
    (fn [model [k properties] & [trail sub]]
      (let [path (conj trail (name k))
            selected? (get-in @enhance-query path)
            toggle! (fn []
                      (if selected?
                        (dispatch [:qb/enhance-query-remove-view path])
                        (dispatch [:qb/enhance-query-add-view path])))]
        [:li.haschildren
         {:class (when selected? "is-selected")}
         [:span.qb-attr-row
          {:role "checkbox"
           :tabIndex 0
           :aria-checked (boolean selected?)
           :on-click toggle!
           :on-key-down (fn [e]
                          (when (#{"Enter" " "} (oget e :key))
                            (ocall e :preventDefault)
                            (toggle!)))}
          (if (get-in @enhance-query path)
            [:svg.icon.icon-checkbox-checked [:use {:xlinkHref "#icon-checkbox-checked"}]]
            [:svg.icon.icon-checkbox-unchecked [:use {:xlinkHref "#icon-checkbox-unchecked"}]])
          [:span.qb-label (:displayName properties)]]]))))

(defn reverse-reference
  "Return the properties of a `reverseReference` of `referencedType` if it
  is or extends `originalType`. If not, return nil."
  [model hier originalType [_ {:keys [referencedType reverseReference]}]]
  (when (and reverseReference (isa? hier originalType (keyword referencedType)))
    (let [refs+colls (->> [:references :collections]
                          (map (get-in model [:classes (keyword referencedType)]))
                          (apply merge))]
      (get refs+colls (keyword reverseReference)))))

(defn node []
  (let [menu (subscribe [:qb/menu])
        hier (subscribe [:current-model-hier])]
    (fn [model [k properties :as entry] & [trail hits]]
      (let [path (vec (conj trail (name k)))
            open? (get-in @menu path)
            str-path (join "." path)
            sub (get-in @menu (conj path :subclass))
            {:keys [displayName referencedType]} properties
            class (im-path/class model (join "." (pop trail)))
            rev-props (reverse-reference model @hier class entry)]
        [:li.haschildren.qb-group
         {:class (cond open? "expanded-group")}
         [:div.group-title
          {:on-click (fn []
                       (if open?
                         (dispatch [:qb/collapse-path path])
                         (dispatch [:qb/expand-path path])))}
          [icon (if open? "minus" "plus")]
          (when rev-props [icon "modal-folder-up" nil ["reverse-reference"]])
          [:span.qb-class
           {:class (when rev-props :empty-class)}
           displayName]
          (when (and (coll? hits) (seq hits))
            [:span.qb-match-hint (join ", " hits)])
          (when-not rev-props
            [:span.label-button
             {:on-click (fn [e]
                          (ocall e :stopPropagation)
                          (dispatch [:qb/enhance-query-add-summary-views path sub]))
              :title (str "Add summary fields of " str-path " to query view")}
             "+ Summary"])]
         (when open?
           (let [class (im-path/class model (join "." trail))]
             (into [:ul]
                   (concat
                     ;; We remove :type-constraints from the model in these two instances
                     ;; as we want to find the subclasses of the superclass. Otherwise the
                     ;; list of subclasses would grow smaller when one is selected.
                    (when (im-path/class? (dissoc model :type-constraints) str-path)
                      (let [class (im-path/class (dissoc model :type-constraints) str-path)]
                        (when-let [subclasses (seq (sort (descendants @hier class)))]
                          [[:li
                            [:span
                             (into [:select.form-control.input-sm
                                    {:on-change (fn [e]
                                                  (dispatch [:qb/enhance-query-choose-subclass path (oget e :target :value) referencedType]))
                                     :value (or sub referencedType)}
                                    [:option {:value referencedType}
                                     displayName]
                                    [:option {:disabled true :role "separator"}
                                     "─────────────────────────"]]
                                   (map (fn [subclass]
                                          [:option {:value subclass}
                                           (display-name model subclass)])
                                        subclasses))]]])))
                    ;; Reverse reference
                    (if sub
                      (map (fn [i]
                             [node model i path])
                           (->> (im-path/relationships model sub)
                                (filter (partial reverse-reference model @hier class))
                                (sort-classes)))
                      (map (fn [i]
                             [node model i path])
                           (->> (im-path/relationships model referencedType)
                                (filter (partial reverse-reference model @hier class))
                                (sort-classes))))
                    ;; Attributes
                    (if sub
                      (map (fn [i]
                             [attribute model i path sub])
                           (->> (im-path/attributes model sub)
                                (remove (comp (partial = :id) first))
                                (sort-classes)))
                      (map (fn [i]
                             [attribute model i path sub])
                           (->> (im-path/attributes model referencedType)
                                (remove (comp (partial = :id) first))
                                (sort-classes))))
                    ;; References and collections
                    (if sub
                      (map (fn [i]
                             [node model i path])
                           (->> (im-path/relationships model sub)
                                (remove (partial reverse-reference model @hier class))
                                (sort-classes)))
                      (map (fn [i]
                             [node model i path])
                           (->> (im-path/relationships model referencedType)
                                (remove (partial reverse-reference model @hier class))
                                (sort-classes))))))))]))))

(defn- hit?
  "Whether the lower-case query `q` occurs in the string `s`."
  [q s]
  (string/includes? (lower-case (or s "")) q))

(defn- related-hits
  "Up to two display names of attributes of the class a relationship points at
  that match the lower-case query `q`."
  [model [_ {:keys [referencedType]}] q]
  (->> (im-path/attributes model referencedType)
       (remove (comp #{:id} key))
       (map (comp :displayName val))
       (filter (partial hit? q))
       sort
       (take 2)))

(defn- section-head [{:keys [open? on-toggle label n total selected]}]
  [:button.qb-section
   {:type "button"
    :aria-expanded (boolean open?)
    :on-click on-toggle}
   [icon (if open? "minus" "plus")]
   label
   [:span.agr-count (if (and total (not= n total)) (str n " of " total) n)]
   (when (pos? (or selected 0))
     [:span.qb-selected (str selected " selected")])])

(defn model-browser [_model _root-class _q _set-q!]
  (let [open* (reagent/atom #{:attrs :refs})
        enhance-query (subscribe [:qb/enhance-query])
        toggle! (fn [k] (swap! open* #(if (contains? % k) (disj % k) (conj % k))))]
    (fn [model root-class q set-q!]
      (let [path [root-class]
            ql (lower-case (string/trim q))
            filtering? (not (string/blank? ql))
            all-attributes (->> (im-path/attributes model root-class)
                                (remove (comp #{:id} key)) ; Hide id attribute.
                                (sort-classes))
            all-relationships (->> (im-path/relationships model root-class)
                                   ;; Make sure class is present in model.
                                   ;; (If the class has no members, it won't be.)
                                   (filter #(contains? (:classes model)
                                                       (-> % val :referencedType keyword)))
                                   (sort-classes))
            attributes (if filtering?
                         (filter #(hit? ql (-> % val :displayName)) all-attributes)
                         all-attributes)
            relationships (if filtering?
                            (keep (fn [entry]
                                    (let [hits (related-hits model entry ql)]
                                      (when (or (hit? ql (-> entry val :displayName))
                                                (seq hits))
                                        [entry hits])))
                                  all-relationships)
                            (map vector all-relationships (repeat nil)))
            selected (count (filter #(get-in @enhance-query [root-class (name (key %))])
                                    all-attributes))
            open-attrs? (or filtering? (contains? @open* :attrs))
            open-refs? (or filtering? (contains? @open* :refs))]
        [:<>
         [:div.qb-tree-tools
          [:div.qb-filter
           [icon "search"]
           [:input.form-control.input-sm
            {:type "search"
             :placeholder "Filter fields and related data"
             :aria-label "Filter fields"
             :value q
             :on-change #(set-q! (oget % :target :value))
             :on-key-down #(when (= (oget % :key) "Escape") (set-q! ""))}]
           (when (seq q)
             [:button.qb-filter-clear
              {:type "button"
               :aria-label "Clear filter"
               :on-click #(set-q! "")}
              [icon "close"]])]
          [:div.qb-tree-buttons
           [:button.agr-btn.agr-btn-sm.qb-tool
            {:on-click #(dispatch [:qb/expand-all])
             :title "Expand the Model Browser tree to show all selected attributes"}
            [icon "enlarge2"] "Expand"]
           [:button.agr-btn.agr-btn-sm.qb-tool
            {:on-click #(dispatch [:qb/collapse-all])
             :title "Collapse the Model Browser tree to the top level"}
            [icon "shrink"] "Collapse"]
           [:button.agr-btn.agr-btn-sm.qb-tool
            {:on-click #(dispatch [:qb/enhance-query-clear-query])
             :title "Remove all selected attributes"}
            [icon "bin"] "Clear"]]]
         [:div.model-browser
          [section-head {:open? open-attrs?
                         :on-toggle #(toggle! :attrs)
                         :label "Attributes"
                         :n (count attributes)
                         :total (count all-attributes)
                         :selected selected}]
          (when open-attrs?
            (into [:ul.qb-attrs]
                  (map (fn [class-entry] [attribute model class-entry path]) attributes)))
          [section-head {:open? open-refs?
                         :on-toggle #(toggle! :refs)
                         :label "Related data"
                         :n (count relationships)
                         :total (count all-relationships)}]
          (when open-refs?
            (into [:ul.qb-refs]
                  (map (fn [[class-entry hits]] [node model class-entry path hits])
                       relationships)))
          (when (and filtering? (empty? attributes) (empty? relationships))
            [:p.qb-no-match (str "No fields match '" q "'.")])]]))))

(defn data-browser-node []
  (let [open? (reagent/atom true)]
    (fn [close! model hier tag]
      (let [;; To get the immediate children, we filter the descendants down to
            ;; those which have `tag` as immediate parent.
            children (filter #(contains? (parents hier %) tag)
                             (descendants hier tag))
            {:keys [count displayName]} (get model tag)
            is-nonempty (when (number? count) (pos? count))]
        [:li.haschildren.qb-group
         {:class (when @open? "expanded-group")}
         [:div.group-title
          (if (seq children)
            {:class "is-parent"
             :role "treeitem"
             :aria-expanded true}
            {:class "is-closed"
             :role "treeitem"
             :aria-expanded false})
          (when (seq children)
            [:a.expand-close {:on-click #(swap! open? not)}
             [icon (if @open? "minus" "plus")]])
          (if is-nonempty
            [:a.qb-class
             {:class (when (empty? children) "no-icon")
              :on-click #(do (dispatch [:qb/set-root-class tag]) (close!))}
             displayName]
            [:span.qb-class.empty-class
             {:class (when (empty? children) "no-icon")}
             displayName])
          (when is-nonempty
            [:span.class-count count])]
         (when (and (seq children) @open?)
           (into [:ul]
                 (for [child (sort children)]
                   [data-browser-node close! model hier child])))]))))

(defn data-browser [close!]
  (let [model @(subscribe [:model])
        hier @(subscribe [:current-model-hier])]
    [:div.model-browser-column
     [:div.header-group
      [:h4 "Data Browser"]
      [:button.agr-btn.agr-btn-sm.browse-button
       {:on-click close!}
       [:svg.icon.icon-arrow-left [:use {:xlinkHref "#icon-arrow-left"}]]
       "Back to query"]]
     [:div.model-browser.class-browser
      (into [:ul]
            (for [root (->> (keys model)
                            (filter #(empty? (parents hier %)))
                            (sort))]
              [data-browser-node close! model hier root]))]]))

(defn browser-pane []
  (let [current-model (subscribe [:current-model])
        type-constraints (subscribe [:qb/menu-type-constraints])
        root-class (subscribe [:qb/root-class])
        browse-model? (reagent/atom true)
        ;; The filter text is tied to the root class it was typed under, so it
        ;; reads as empty once the root class changes.
        filter* (reagent/atom {:root nil :q ""})]
    (fn []
      (if @browse-model?
        (let [root @root-class
              q (if (= (:root @filter*) root) (:q @filter*) "")]
          [:div.model-browser-column
           [:h4 "Model Browser"]
           [:div.model-browser-root
            [root-class-dropdown]
            (when root
              [:button.label-button.qb-add-summary.agr-btn.agr-btn-primary.agr-btn-sm
               {:on-click #(dispatch [:qb/enhance-query-add-summary-views [(name root)]])
                :title (str "Add summary fields of " (name root) " to query view")}
               "Add summary"])]
           [:p.qb-intro-line
            "Pick a type, or browse the "
            [:button.qb-link-btn
             {:on-click #(swap! browse-model? not)}
             [icon "tree"]
             "Data Model"]]
           (if root
             [model-browser
              (assoc @current-model :type-constraints @type-constraints)
              (name root)
              q
              #(reset! filter* {:root root :q %})]
             [:div.qb-help
              [:p.text-muted "Build your own queries: browse the data model, add constraints, choose output columns and export queries to share. "
               [:a {:href "http://intermine.org/intermine-user-docs/docs/the-query-builder" :target "_blank"} "Query Builder guide"]
               " · "
               [:a {:href "http://intermine.org/intermine-user-docs/docs/the-query-builder#video-tutorial" :target "_blank"} "video tutorial"]]])])
        [data-browser #(swap! browse-model? not)]))))

(defn steps-bar
  "Four-step strip above the query builder. It shows the stage of the current
  query and one hint under the active step."
  []
  (let [root-class (subscribe [:qb/root-class])
        enhance-query (subscribe [:qb/enhance-query])
        constraint-count (subscribe [:qb/constraint-count])]
    (fn []
      (let [stage (cond (nil? @root-class) 1
                        (empty? @enhance-query) 2
                        :else 4)
            n @constraint-count
            steps [{:label "Data type"
                    :state (if (= stage 1) :active :done)
                    :hint "Choose a data type in the Model Browser, or reuse a recent or saved query."}
                   {:label "Columns"
                    :state (cond (= stage 2) :active (= stage 4) :done :else :todo)
                    :hint "Tick the fields you want as columns. The summary button adds a standard set."}
                   {:label "Filters"
                    :state (cond (pos? n) :done (= stage 4) :optional :else :todo)}
                   {:label "Run"
                    :state (if (= stage 4) :active :todo)
                    :hint (if (pos? n)
                            (str "Ready to run with " n (if (= n 1) " filter." " filters."))
                            "Run the query, or click a funnel icon in the editor to filter first.")}]]
        (into [:ol.qb-steps]
              (map-indexed
               (fn [i {:keys [label state hint]}]
                 [:li.qb-step {:class (str "is-" (name state))}
                  [:span.qb-step-num (if (= state :done) [icon "checkmark"] (inc i))]
                  [:span.qb-step-label label]
                  (when (and hint (= state :active))
                    [:span.qb-step-hint hint])])
               steps))))))

(defn dissoc-keywords [m]
  (apply dissoc m (filter keyword? (keys m))))

(defn queryview-node []
  (let [lists (subscribe [:current-lists])
        class-keys (subscribe [:current-class-keys])]
    (fn [model [k properties] & [trail]]
      (let [path (vec (conj trail (name k)))
            class-node? (im-path/class? model (join "." path))
            non-root-class? (and class-node? (> (count path) 1))
            path-kw (map keyword path)
            [{referenced-name :displayName, referenced-class :name}
             {parent-name :displayName}] (reverse (im-path/walk model path-kw))
            relational-name (if non-root-class?
                              (rel-display-name model path-kw)
                              referenced-name)]
        [:li.tree.haschildren
         [:div.flexmex
          [:span.lab {:class (if class-node? "qb-class" "qb-attribute")}
           [:span.qb-label {:style {:margin-left 5}}
            [tooltip {:on-click #(dispatch [:qb/expand-path path])
                      :title (str "Show " relational-name " in the model browser")}
             [:span {:role "button"
                     :tabIndex 0
                     :on-key-down (fn [e]
                                    (when (#{"Enter" " "} (oget e :key))
                                      (ocall e :preventDefault)
                                      (dispatch [:qb/expand-path path])))}
              relational-name]]]
           (when (and non-root-class? (not= (lower-case referenced-class)
                                            (lower-case k)))
             [:span.qb-type (str "(" (rel-referenced-type model path-kw) ")")])
           (when-let [s (:subclass properties)]
             [:span.label.label-default (display-name model s)])
           [:svg.icon.icon-bin
            {:on-click (if (> (count path) 1)
                         (fn [] (dispatch [:qb/enhance-query-remove-view path]))
                         (fn [] (dispatch [:qb/enhance-query-clear-query path])))}
            [:use {:xlinkHref "#icon-bin"}]]

           (when non-root-class?
             (let [outer-join? @(subscribe [:qb/active-outer-join (join "." path)])]
               [:a.outer-join-button
                {:role "button"
                 :class (when outer-join? "active")
                 :title (if outer-join?
                          (str "Show all " (plural parent-name) " and show " (plural referenced-name) " if they are present")
                          (str "Only show " (plural parent-name) " if they have an associated " referenced-name))
                 :on-click #(dispatch [(if outer-join?
                                         :qb/remove-outer-join
                                         :qb/add-outer-join) path])}
                (if outer-join?
                  [:svg.icon.icon-venn-combine [:use {:xlinkHref "#icon-venn-combine"}]]
                  [:svg.icon.icon-venn-intersection [:use {:xlinkHref "#icon-venn-intersection"}]])]))

           ;; Disallow adding constraints to classes without class keys.
           (when (or (not class-node?)
                     (contains? @class-keys (keyword referenced-class)))
             [:svg.icon.icon-filter
              {:role "button"
               :tabIndex 0
               :aria-label "Add constraint"
               :on-click (fn []
                           (dispatch [:qb/enhance-query-add-constraint path]))
               :on-key-down (fn [e]
                              (when (#{"Enter" " "} (oget e :key))
                                (ocall e :preventDefault)
                                (dispatch [:qb/enhance-query-add-constraint path])))}
              [:title "Add constraint"]
              [:use {:xlinkHref "#icon-filter"}]])

           (when-let [c (:id-count properties)]
             [:span.label.label-soft
              {:class (when (= 0 c) "label-no-results")
               :style {:margin-left 5}} (str c " row" (when (not= c 1) "s"))])]]
         (when-let [constraints (:constraints properties)]
           (into [:ul.tree.banana]
                 (map-indexed (fn [idx con]
                                [:li
                                 [:div.contract
                                  {:class (when (empty? (:value con)) "empty")}
                                  [constraint
                                   :model model
                                   :path (join "." path)
                                   :lists @lists
                                   :code (:code con)
                                   :on-remove (fn [] (dispatch [:qb/enhance-query-remove-constraint path idx]))
                                   :possible-values (when (some? (:possible-values properties)) (map :item (:possible-values properties)))
                                   :typeahead? true
                                   :value (or (:value con) (:values con))
                                   :op (:op con)
                                   ;; Do we need all these? I think it would be simpler to just have:
                                   ;;     on-change - update state
                                   ;;     on-blur   - update state and rerun query
                                   ;; If you find you need to refactor these, try converting it to the above.
                                   :on-select-list (fn [c]
                                                     (dispatch [:qb/enhance-query-update-constraint path idx c])
                                                     (dispatch [:qb/enhance-query-build-im-query true]))
                                   :on-change-operator (fn [x]
                                                         (dispatch [:qb/enhance-query-update-constraint path idx x])
                                                         (dispatch [:qb/enhance-query-build-im-query true]))
                                   :on-change (fn [c]
                                                (dispatch [:qb/enhance-query-update-constraint path idx c]))
                                   :on-blur (fn [c]
                                              (dispatch [:qb/enhance-query-update-constraint path idx c])
                                              (dispatch [:qb/enhance-query-build-im-query true]))
                                   :label? false]]]) constraints)))
         (when (not-empty (dissoc-keywords properties))
           (let [classes (filter (fn [[k p]] (im-path/class? model (join "." (conj path k)))) (dissoc-keywords properties))
                 attributes (filter (fn [[k p]] ((complement im-path/class?) model (join "." (conj path k)))) (dissoc-keywords properties))]
             (into [:ul.tree.banana2]
                   (concat
                    (map (fn [n] [queryview-node model n path])
                         (sort-by (comp string/lower-case key) attributes))
                    (map (fn [n] [queryview-node model n path])
                         (sort-by (comp string/lower-case key) classes))))))]))))

(defn example-button []
  [:button.agr-btn.agr-btn-sm
   {:on-click (fn [] (dispatch [:qb/load-example aquery]))}
   "Example"])

(defn start-chips
  "Buttons for the preferred data types, shown until a root class is chosen."
  []
  [:div.qb-start-chips
   [:span.qb-start-label "Start with:"]
   (for [[class-kw {:keys [displayName]}] (->> @(subscribe [:model])
                                               filter-populated
                                               sort-classes
                                               filter-preferred
                                               (take 6))]
     ^{:key class-kw}
     [:button.agr-btn.agr-btn-sm
      {:on-click #(dispatch [:qb/set-root-class class-kw])}
      displayName])])

(defn queryview-browser []
  (let [enhance-query (subscribe [:qb/enhance-query])
        default-query? (subscribe [:qb/example])
        root-class (subscribe [:qb/root-class])
        constraint-count (subscribe [:qb/constraint-count])]
    (fn [model]
      (if (not-empty @enhance-query)
        [:div
         [:div.query-browser
          (into [:ul.tree]
                (map (fn [n]
                       [queryview-node model n]) @enhance-query))]
         (when (zero? @constraint-count)
           [:p.qb-hint "Click the funnel icon on a row to add a filter."])]
        [:div.qb-empty
         [:p.qb-empty-lead "Please select at least one attribute from the Model Browser on the left."]
         (when (nil? @root-class)
           [start-chips])
         (when (seq @default-query?) [example-button])]))))

(def <sub (comp deref subscribe))

(defn logic-box []
  (let [editing? (reagent/atom false)
        ;; Edits stay local until :qb/format-constraint-logic validates them.
        draft (reagent/atom "")
        logic (subscribe [:qb/constraint-logic])]
    (fn []
      [:div.logic-container
       [:label {:for "logic-input"} "Constraint Logic:"]
       [:div.logic-box
        {:ref (fn [x]
                (some-> x (ocall :getElementsByTagName "input") array-seq first (ocall :focus)))}
        (if @editing?
          [:input.form-control.input-sm
           {:type "text"
            :value @draft
            :id "logic-input"
            :on-key-down (fn [e] (when (= (oget e :keyCode) 13)
                                   (reset! editing? false)
                                   (dispatch [:qb/format-constraint-logic @draft])))
            :on-blur (fn []
                       (when @editing?
                         (reset! editing? false)
                         (dispatch [:qb/format-constraint-logic @draft])))
            :on-change (fn [e] (reset! draft (oget e :target :value)))}]
          [:pre
           [:a {:role "button"
                :id "logic-input"
                :title "Edit constraint logic"
                :on-click (fn []
                            (reset! draft @logic)
                            (reset! editing? true))}
            [:svg.icon.icon-edit [:use {:xlinkHref "#icon-edit"}]]]
           [:span#logic-input @logic]])]])))

(defn controls []
  (let [saving-query? (reagent/atom false)
        query-title (reagent/atom "")
        results-preview (subscribe [:qb/preview])
        submit-fn #(when-let [title (not-empty @query-title)]
                     (swap! saving-query? not)
                     (reset! query-title "")
                     (dispatch [:qb/save-query title]))
        fetching-preview? (subscribe [:qb/fetching-preview?])]
    (fn []
      (if @saving-query?
        [:div.button-group.qb-runbar
         [:div.input-group
          [:label {:for "query-title-input"} "Title:"]
          [:input#query-title-input.form-control
           {:type "text"
            :autoFocus true
            :value @query-title
            :on-change #(reset! query-title (oget % :target :value))
            :on-key-up #(when (= (oget % :keyCode) 13)
                          (submit-fn))}]]
         [:button.agr-btn.agr-btn-primary
          {:on-click submit-fn}
          "Save Query"]
         [:button.agr-btn
          {:on-click (fn [] (swap! saving-query? not))}
          "Cancel"]]
        [:div.button-group.qb-runbar
         [:button.agr-btn.agr-btn-primary
          {:on-click (fn [] (dispatch [:qb/export-query]))}
          (str "Show All " (when-let [c (:iTotalRecords @results-preview)] (str (if (number? c) (.toLocaleString c) c) " ")) "Rows")]
         [:button.agr-btn
          {:on-click (fn [] (swap! saving-query? not))}
          "Save Query"]
         [:button.agr-btn
          {:on-click (fn [] (dispatch [:qb/enhance-query-clear-query]))}
          "Clear Query"]
         (when @fetching-preview?
           [:div.query-preview-loader
            [mini-loader "tiny"]])]))))

(defn preview []
  (let [results-preview @(subscribe [:qb/preview])
        preview-error @(subscribe [:qb/preview-error])]
    [:div.preview-container
     (cond
       preview-error [:div
                      [:p "Error occured when running query."]
                      [:pre.well.text-danger preview-error]]
       results-preview [preview-table
                        :loading? false ; The loader is ugly.
                        :hide-count? false
                        :query-results results-preview]
       :else [:p.qb-muted "No query available for generating preview."])]))

(defn move-vec-elem
  "Moves an element in a vector `v` from index `i` to `i'`."
  [v i i']
  (let [e (nth v i)
        v' (into (subvec v 0 i)
                 (subvec v (inc i)))]
    (into [] cat
          [(subvec v' 0 i')
           [e]
           (subvec v' i')])))

(defn manage-columns []
  (let [order (subscribe [:qb/order])
        current-model (subscribe [:current-model])
        current-constraints (subscribe [:qb/im-query-constraints])
        selected* (reagent/atom nil)]
    (fn []
      (into [:div.sort-order-container
             {:class (when (some? @selected*) "dragtest")}]
            (map-indexed
             (fn [idx path]
               [:div.sort-item
                {:class (when (= idx @selected*) "dragging")
                 :draggable true
                 :on-drag-start (fn [e]
                                  (ocall e :stopPropagation)
                                  (reset! selected* idx))
                 :on-drag-enter (fn [e]
                                  (ocall e :preventDefault)
                                  (ocall e :stopPropagation)
                                  (let [new-order (move-vec-elem @order @selected* idx)]
                                    (reset! selected* idx)
                                    (dispatch [:qb/set-order new-order])))
                 :on-drag-end (fn [] (reset! selected* nil))
                 ;; The remaining two listeners only exist to prevent the animation of the
                 ;; dragged element returning to its original position. Silly, I know.
                 :on-drop (fn [e]
                            (ocall e :preventDefault))
                 :on-drag-over (fn [e]
                                 (ocall e :preventDefault))}
                [:span.drag-bar {:aria-hidden true} "≡"]
                (into [:div.path-parts]
                      (let [model (assoc @current-model
                                         :type-constraints @current-constraints)]
                        (map (fn [part]
                               [:span.part part])
                             (->> (split path #"\.")
                                  (map keyword)
                                  (im-path/walk model)
                                  (map :displayName)
                                  (interpose ">")))))
                (let [subpaths (->> (split path #"\.") (iterate drop-last) (take-while not-empty) (set))
                      outer-joined-section? (some #(contains? subpaths %)
                                                  (map #(split % #"\.") @(subscribe [:qb/joins])))]
                  (if outer-joined-section?
                    [:span.outerjoined-section {:title "Optional attributes cannot be sorted"}
                     [:svg.icon.icon-venn-combine [:use {:xlinkHref "#icon-venn-combine"}]]]
                    [:div.button-group
                     (when-let [sort-priority @(subscribe [:qb/sort-priority path])]
                       [:span.sort-priority (str "Sort " (-> sort-priority inc ordinalize))])
                     [:a.sort-button {:role "button"
                                      :title "Sort ascending"
                                      :class (when (= "ASC" @(subscribe [:qb/active-sort path]))
                                               "active")
                                      :on-click #(dispatch [:qb/set-sort path "ASC"])}
                      [:svg.icon.icon-sort-alpha-asc [:use {:xlinkHref "#icon-sort-alpha-asc"}]]]
                     [:a.sort-button {:role "button"
                                      :title "Sort descending"
                                      :class (when (= "DESC" @(subscribe [:qb/active-sort path]))
                                               "active")
                                      :on-click #(dispatch [:qb/set-sort path "DESC"])}
                      [:svg.icon.icon-sort-alpha-desc [:use {:xlinkHref "#icon-sort-alpha-desc"}]]]]))]))
            @order))))

(defn xml-view []
  (let [query (subscribe [:qb/im-query])
        current-mine (subscribe [:current-mine])
        clipboard (atom nil)
        msg (reagent/atom nil)]
    (fn []
      (let [xml (str (->xml (get-in @current-mine [:service :model]) @query))]
        [:div
         [:textarea.hidden-clipboard
          {:ref #(reset! clipboard %) :value xml :read-only true}]
         [:pre xml]
         [:div.flex-row
          [:button.agr-btn.agr-btn-sm
           {:type "button"
            :on-click
            #(when-let [clip @clipboard]
               (.focus clip)
               (.select clip)
               (try
                 (ocall js/document :execCommand "copy")
                 (reset! msg {:type "success" :text "Copied to clipboard"})
                 (catch js/Error _
                   (reset! msg {:type "failure" :text "Failed to copy to clipboard"}))))}
           "Copy XML"]
          (when-let [{:keys [type text]} @msg]
            [:p {:class type} text])]]))))

(defn joins-list []
  (let [joins @(subscribe [:qb/joins])]
    (when (not-empty joins)
      (into [:ul.joins-list]
            (for [path joins]
              [:li
               [:svg.icon.icon-venn-combine [:use {:xlinkHref "#icon-venn-combine"}]]
               [:span [:code path] "will show as a subtable if present"]])))))

(defn query-editor []
  (let [current-model @(subscribe [:current-model])
        current-constraints @(subscribe [:qb/im-query-constraints])
        constraint-count @(subscribe [:qb/constraint-count])]
    [:div
     [queryview-browser (assoc current-model :type-constraints current-constraints)]
     [joins-list]
     (when (>= constraint-count 2)
       [logic-box])]))

(defn tabs
  "Tab strip. `labels` is a vector and `tab-index` a reagent atom holding the
  active index. `on-select` is called with the clicked index before the atom
  changes."
  [labels tab-index & [on-select]]
  (into [:ul.agr-tabs {:role "tablist"}]
        (for [[i title] (map-indexed vector labels)]
          [:li {:role "presentation"
                :class (when (= @tab-index i) "active")}
           [:button {:type "button"
                     :role "tab"
                     :aria-selected (= @tab-index i)
                     :on-click #(do (when on-select (on-select i))
                                    (reset! tab-index i))}
            title]])))

(defn query-viewer []
  (let [enhance-query (subscribe [:qb/enhance-query])
        tab-index (reagent/atom 0)]
    (fn []
      [:div.panel.panel-default.qb-card
       [:div.panel-body
        [tabs ["Query Editor" "Manage Columns"] tab-index]
        (case @tab-index
          0 [query-editor]
          1 [manage-columns])
        (when (not-empty @enhance-query) [controls])]])))

(defn column-order-preview []
  (let [tab-index (reagent/atom 0)]
    (fn []
      [:div.panel.panel-default.qb-card
       [:div.panel-body
        [tabs ["Preview" "XML"] tab-index]
        (case @tab-index
          0 [preview]
          1 [xml-view])]])))

(defn short-readable-path
  "Takes a path and returns a concise abbreviated version.
  (short-readable-path 'Gene.homologues.homologue.symbol')
  => 'G.h.homologue.symbol'"
  [path]
  (let [pathv (string/split path #"\.")]
    (if (> (count pathv) 2)
      (let [[pre-path class-attr] (split-at (- (count pathv) 2) pathv)]
        (string/join "." [(string/join "." (map first pre-path))
                          (string/join "." class-attr)]))
      path)))

(defn truncate-path [path]
  (string/join "." (take-last 2 (string/split path #"\."))))

(defn recent-queries []
  (let [queries (take 5 @(subscribe [:results/historical-custom-queries]))
        active-query @(subscribe [:qb/im-query])]
    (if (empty? queries)
      [:p "Queries that you have run during this session will appear here."]
      [:table.table.query-table.agr-table.agr-table-sm
       [:thead
        [:tr
         [:th "Start"]
         [:th "Results Format"]
         [:th "Last Run"]]]
       (into [:tbody]
             (for [[_ {:keys [value last-executed]}] queries
                   :let [{:keys [from select]} value
                         active? (query= active-query (dissoc value :title))]]
               [:tr {:role "button"
                     :title (if active? "This query is active" "Load this query")
                     :class (when active? "active-query")
                     :on-click #(dispatch [:qb/load-query value])}
                [:td [:code.start {:class (str "start-" from)} from]]
                [:td (into [:<>] (for [path select]
                                   [:code {:title path} (truncate-path path)]))]
                [:td [:span.date (.toLocaleTimeString (js/Date. last-executed))]]]))])))

(defn saved-query [title _query]
  (let [renaming? (reagent/atom false)
        rename-input (reagent/atom title)]
    (fn [title {:keys [from select] :as query} & {:keys [active? any-renaming*]}]
      (let [toggle-rename! #(do (.stopPropagation %)
                                (swap! any-renaming* not)
                                (swap! renaming? not)
                                (reset! rename-input title))
            rename! #(do (.stopPropagation %)
                         (when-let [new-title (not-empty @rename-input)]
                           (when (not= title new-title)
                             (dispatch [:qb/rename-query title new-title])))
                         (toggle-rename! %))]
        [:tr {:role "button"
              :title (if active? "This query is active" "Load this query")
              :class (when active? "active-query")
              :on-click #(dispatch [:qb/load-query query])}
         (if @renaming?
           [:td
            [:input.form-control
             {:type "text"
              :placeholder title
              :value @rename-input
              :autoFocus true
              :aria-label "New title for query"
              :title "New title for query"
              :on-change #(reset! rename-input (oget % :target :value))
              :on-key-up #(when (= (oget % :keyCode) 13) (rename! %))}]]
           [:td (str title)])
         [:td [:code.start {:class (str "start-" from)} from]]
         [:td.hidden-lg {:class (when-not @any-renaming* "hidden")}
          [:code {:title (string/join " " select)} "..."]]
         [:td {:class (when @any-renaming* "visible-lg-block")}
          (into [:<>] (for [path select]
                        [:code {:title path} (truncate-path path)]))]
         [:td
          (when-not @any-renaming*
            [:<>
             [:a.qb-row-action {:role "button"
                                :title ""
                                :on-click #(do (.stopPropagation %)
                                               (dispatch [:qb/load-query query]))}
              "Load"]
             " "
             [:a.qb-row-action {:role "button"
                                :title ""
                                :on-click toggle-rename!}
              "Rename"]
             " "
             [:a.qb-row-action {:role "button"
                                :title ""
                                :on-click #(do (.stopPropagation %)
                                               (dispatch [:qb/delete-query title]))}
              "Delete"]])
          (when @renaming?
            [:<>
             [:a.qb-row-action {:role "button"
                                :title ""
                                :on-click rename!}
              "Save"]
             " "
             [:a.qb-row-action {:role "button"
                                :title ""
                                :on-click toggle-rename!}
              "Cancel"]])]]))))

(defn saved-queries []
  (let [queries (subscribe [:qb/saved-queries])
        active-query (subscribe [:qb/im-query])
        authed? (subscribe [:bluegenes.subs.auth/authenticated?])
        any-renaming? (reagent/atom false)]
    (fn []
      (if (empty? @queries)
        [:p "Queries that you have saved will appear here."]
        [:table.table.query-table.agr-table.agr-table-sm
         [:thead
          (when (and (not-empty @queries) (not @authed?))
            [:tr.danger
             [:th {:colSpan 4}
              "Warning: Since you're not logged in, these queries have been saved to your session and may disappear when exiting BlueGenes."]])
          [:tr
           ;; Remember to update colspan if you change the amount of columns.
           [:th "Title"]
           [:th "Start"]
           [:th "Results Format"]
           [:th "Actions"]]]
         (into [:tbody]
               (for [[title query] @queries]
                 ^{:key title}
                 [saved-query title query
                  :active? (query= @active-query query)
                  :any-renaming* any-renaming?]))]))))

(defn import-from-xml []
  (let [query-input (reagent/atom "")]
    (fn []
      [:div.qb-import
       [:p "Paste your InterMine PathQuery XML here."
        [:a {:href "http://intermine.org/im-docs/docs/api/pathquery/"
             :target "_blank"
             :title "More information on the PathQuery API"}
         [:svg.icon.icon-external [:use {:xlinkHref "#icon-external"}]]]]
       [:textarea.form-control
        {:rows 10
         :autoFocus true
         :value @query-input
         :on-change #(reset! query-input (oget % :target :value))}]
       [:div.flex-row
        [:button.agr-btn.agr-btn-primary
         {:type "button"
          :on-click #(when-let [query (not-empty @query-input)]
                       (reset! query-input "")
                       (dispatch [:qb/import-xml-query query]))}
         "Load query"]
        (when-let [{:keys [type text]} @(subscribe [:qb/import-result])]
          [:p {:class type} text])]])))

(defn inline-input [& {:keys [id label helptext warntext state* textarea?]}]
  [:div
   [:div.input-group
    [:label {:for id} label]
    (if textarea?
      [:textarea.form-control
       {:id id
        :rows 3
        :value @state*
        :on-change #(reset! state* (oget % :target :value))}]
      [:input.form-control
       {:id id
        :type "text"
        :value @state*
        :on-change #(reset! state* (oget % :target :value))}])]
   (when helptext
     [:span.helptext helptext])
   (when warntext
     [:em.helptext warntext])])

(defn toggle [& {:keys [label value on-change]}]
  [:div.switch-container
   [:span.switch-label label]
   [:span.switch
    [:input {:type "checkbox" :checked (boolean value)}]
    [:span.slider.round {:on-click on-change}]]
   [:span.switch-status (if value "ON" "OFF")]])

(defn radio [& {:keys [label items value on-change]}]
  (into [:div.radio-group
         (when label
           [:label label])]
        (for [{lab :label val :value} items]
          [:label.radio-inline
           [:input {:type "radio"
                    :checked (= val value)
                    :on-change #(on-change val)}]
           [:span.circle]
           [:span.check]
           lab])))

(defn template-constraint [const & {:keys [index meta set-meta! drag*]}]
  (let [current-model @(subscribe [:current-model])
        current-constraints @(subscribe [:qb/im-query-constraints])
        model (assoc current-model :type-constraints current-constraints)
        lists @(subscribe [:current-lists])]
    [:div.const
     {:draggable true
      :on-drag-start (fn [e]
                       (ocall e :stopPropagation)
                       (reset! drag* index))
      :on-drag-enter (fn [e]
                       (ocall e :preventDefault)
                       (ocall e :stopPropagation)
                       (let [current @drag*
                             target index]
                         (when (not= current target)
                           (reset! drag* index)
                           (dispatch [:qb/swap-constraints-ordering current target]))))
      :on-drag-end (fn [_e]
                     (reset! drag* nil))
      ;; The remaining two listeners only exist to prevent the animation of the
      ;; dragged element returning to its original position. Silly, I know.
      :on-drop (fn [e]
                 (ocall e :preventDefault))
      :on-drag-over (fn [e]
                      (ocall e :preventDefault))}
     [:div.const-reorder
      [:span.drag-bar "≡"]]
     [:div.const-group
      {:class (when (:editable meta) :editable)}
      [constraint
       :model model
       :typeahead? false
       :path (:path const)
       :value (or (:value const) (:values const))
       :op (:op const)
       :label (join " > " (take-last 2 (split (im-path/friendly model (:path const)) #" > ")))
       ; :label (im-path/friendly model (:path const))
       :code (:code const)
       :hide-code? true
       :label? true
       :disabled true
       :lists lists
       :on-blur #()
       :on-change #()]
      [:div.const-options
       (if (:editable meta)
         [radio
          :items [{:label "Required" :value nil}
                  {:label "Optional: ON" :value "on"}
                  {:label "Optional: OFF" :value "off"}]
          :value (:switchable meta)
          :on-change #(set-meta! (assoc meta :switchable %))]
         ;; Empty div so flexbox sill works.
         [:div])
       [toggle
        :label "Editable"
        :value (:editable meta)
        :on-change #(set-meta! (update meta :editable not))]]]]))

(defn create-template []
  (let [init-data (subscribe [:qb/template-meta])
        name* (reagent/atom (or (:name @init-data) ""))
        title* (reagent/atom (or (:title @init-data) ""))
        description* (reagent/atom (or (:description @init-data) ""))
        comment* (reagent/atom (or (:comment @init-data) ""))
        collect-inputs (fn [] {:name @name*
                               :title @title*
                               :description @description*
                               :comment @comment*})
        invalid? #(cond
                    (not (re-matches #"\w+" @name*)) "Invalid name. Must only consist of letters, numbers and underscores."
                    (string/blank? @title*) "Title cannot be left blank.")
        drag* (reagent/atom nil)
        error* (reagent/atom nil)
        ;; Currently active constraints.
        constraints* (subscribe [:qb/im-query-constraints])
        ;; Map of constraint-key (path and code) to a map with keys:
        ;; editable=true|false [switchable=on|off]
        ;; Keying by constraint keeps meta attached when the where clause is
        ;; rebuilt in tree order or constraints are added and removed.
        constraints-meta* (reagent/atom (or (:const->meta @init-data) {}))
        meta-of (fn [const] (get @constraints-meta* (constraint-key const) {}))]
    (reagent/create-class
     {:display-name "create-template"
      :component-will-unmount
      (fn []
         ;; Save local state to template-meta when dismounting, so we can restore it on mount.
        (dispatch [:qb/update-template-meta (collect-inputs) @constraints-meta*]))
      :reagent-render
      (fn []
        [:div
         [:p.template-intro "You can save your query as a template, allowing you to specify which constraints are "
          [poppable {:data "Users of this template will be able to change the constraint operator and/or value. You can also make the editable constraint optional (either ON or OFF by default) so the user can decide by themselves whether to include it. You can change the order of constraints by drag and dropping."
                     :children [:span [:strong "editable"] [icon "question"]]}]
          "to rerun the query with only changes to these. Your template will be private to your account unless made public."]
         [:div.create-template
          [:div
           [inline-input
            :id "template-name-input"
            :label "Name*:"
            :helptext "Unique name to identify the template. Use underscores and no special characters, e.g. Gene_proteins"
            :warntext "Note: Will overwrite any existing template with the same name."
            :state* name*]
           [inline-input
            :id "template-title-input"
            :label "Title*:"
            :helptext "Name that's displayed to the user. Arrows will be made into a symbol, e.g. Gene --> Proteins"
            :state* title*]
           [inline-input
            :id "template-description-textarea"
            :label "Description:"
            :state* description*
            :textarea? true]
           [inline-input
            :id "template-comment-input"
            :label "Comment:"
            :state* comment*]]
          (into [:div.template-constraints]
                (for [[index const] (map-indexed vector @constraints*)
                       ;; Type constraints shouldn't be editable.
                      :when (not (:type const))
                      :let [set-const-meta! #(dispatch [:qb/update-template-meta-consts (swap! constraints-meta* assoc (constraint-key const) %)])]]
                  [template-constraint const
                   :index index
                   :meta (meta-of const)
                   :set-meta! set-const-meta!
                   :drag* drag*]))]
         [:div.template-actions
          [:button.agr-btn.agr-btn-primary
           {:on-click #(if-let [err (invalid?)]
                         (reset! error* err)
                         (do (reset! error* nil)
                             (dispatch [:qb/save-template (collect-inputs)
                                        (mapv (fn [c] (merge c (meta-of c))) @constraints*)])))}
           "Save template"]
          [:button.agr-btn
           {:on-click (fn []
                        (reset! error* nil)
                        (doseq [a [name* title* description* comment*]]
                          (reset! a "")))}
           "Clear"]
          (when-let [err @error*]
            [:p.failure err])]])})))

(defn other-query-options []
  (let [tab-index (reagent/atom (if @(subscribe [:qb/template-in-progress?]) 3 0))
        authed? (subscribe [:bluegenes.subs.auth/authenticated?])
        labels ["Recent Queries"
                "Saved Queries"
                "Import from XML"
                "Create Template"]]
    (fn []
      [:div.panel.panel-default.qb-card
       [:div.panel-body
        [tabs labels tab-index
         (fn [_i]
           (when (= @tab-index (.indexOf labels "Import from XML"))
             (dispatch [:qb/clear-import-result])))]
        (case @tab-index
          0 [recent-queries]
          1 [saved-queries]
          2 [import-from-xml]
          3 (if @authed?
              [create-template]
              [:p "You need to be logged in to create templates."]))]])))

(defn main []
  [:div.agr-page.qb-page
   [:h2.agr-page-title "Query Builder"]
   [steps-bar]
   [:div.qb-layout
    [browser-pane]
    [:div.query-view-column
     [query-viewer]
     [column-order-preview]
     [other-query-options]]]])
