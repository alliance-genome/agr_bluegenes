(ns bluegenes.pages.regions.views
  (:require [re-frame.core :refer [subscribe dispatch]]
            [reagent.core :as reagent]
            [reagent.dom :as dom]
            [bluegenes.pages.regions.graphs :as graphs]
            [bluegenes.components.table :as table]
            [bluegenes.pages.regions.events]
            [bluegenes.pages.regions.subs :as subs]
            [bluegenes.pages.regions.results :refer [results-section]]
            [bluegenes.components.bootstrap :refer [poppable]]
            [bluegenes.components.icons :refer [icon]]
            [bluegenes.pages.regions.utils :refer [parse-bp]]
            [clojure.string :as str]
            [oops.core :refer [oget ocall]]
            [goog.functions :refer [debounce]]))

(defn dropdown-hover [{:keys [data children]}]
  [:span.dropdown.dropdown-hover
   [:a.dropdown-toggle
    {:data-toggle "dropdown"
     :role "button"
     :on-click #(.stopPropagation %)}
    children]
   [:div.dropdown-menu.report-item-description
    [:form {:on-submit #(.preventDefault %)
            :on-click #(.stopPropagation %)}
     data]]])

(defn link [text url]
  [:a {:href url :target "_blank"} text])

(def region-search-help
  [:div.region-help
   [:p "Genome regions in the following formats are accepted:"]
   [:ul
    [:li [:strong "chromosome:start..end"] ", e.g. 2L:11334..12296"]
    [:li [:strong "chromosome:start-end"] ", e.g. 2R:5866746-5868284 or chrII:14646344-14667746"]
    [:li [:strong "chromosome:start:end:strand"] ", e.g. 3R:2578486:2580016:-1 or 2L:14615455:14619002:1"]
    [:li [:strong "tab delimited"]]]
   [:p "Both " [:strong "base coordinate"] " (e.g. " [link "BLAST" "https://www.ncbi.nlm.nih.gov/BLAST/blastcgihelp.shtml#get_subsequence"] ", " [link "GFF/GFF3" "http://www.sequenceontology.org/gff3.shtml"] ") and " [:strong "interbase coordinate"] " (e.g. " [link "UCSC BED" "http://genome.ucsc.edu/FAQ/FAQformat#format1"] ", " [link "Chado" "http://gmod.org/wiki/Introduction_to_Chado#Interbase_Coordinates"] ") systems are supported, e.g. for a DNA piece " [:strong "GCCATGTA"] ", the position of the " [:strong "ATG"] " in interbase is [3, 6], and in base coordinates is [4, 6]. Users need to explicitly select one. By default, the base coordinate is selected."]
   [:p "Each genome region needs to take a "  [:strong "new line"] "."]])

(defn non-empty-classes
  "Given an intermine model (or submodel), only keep classes that have data"
  [model]
  (->> model
       (filter (comp pos? :count second))
       (sort-by (comp :displayName second))))

(defn node-state
  "One of :all, :some or :none, from the selection state of a node and its visible descendants."
  [feature-types node]
  (let [ks (subs/visible-feature-keys node)
        selected (count (filter feature-types ks))]
    (cond
      (zero? selected) :none
      (= selected (count ks)) :all
      :else :some)))

(defn feature-branch
  "Recursively building a tree of user-selectable features as checkboxes"
  [expanded*]
  (let [feature-types (subscribe [:regions/feature-types])]
    (fn [expanded* [class-kw {:keys [displayName descendants] :as n}]]
      (let [children (non-empty-classes descendants)
            state (node-state @feature-types [class-kw n])
            open? (contains? @expanded* class-kw)
            id (str "ft-" (name class-kw))]
        [:li.ft-row-item
         [:div.ft-row {:class (when (seq children) "ft-parent")}
          (if (seq children)
            [:button.ft-chevron
             {:type "button"
              :class (when open? "open")
              :aria-expanded (boolean open?)
              :aria-label (str (if open? "Collapse " "Expand ") displayName)
              :on-click #(swap! expanded* (fn [s] (if open? (disj s class-kw) (conj s class-kw))))}
             [icon "chevron-right"]]
            [:span.ft-spacer])
          [:input {:type "checkbox"
                   :id id
                   :checked (= state :all)
                   :ref (fn [el] (when el (set! (.-indeterminate el) (= state :some))))
                   :on-change #(dispatch [:regions/set-feature-type-branch n (not= state :all)])}]
          [:label {:for id} displayName]]
         (when (and (seq children) open?)
           (into [:ul.features-tree]
                 (map (fn [d] [feature-branch expanded* d]) children)))]))))

(defn feature-types-tree
  "UI component for checkbox features selection"
  []
  (let [known-feature-types (subscribe [:regions/sequence-feature-types])
        expanded* (reagent/atom #{})]
    (fn []
      ;; Branches start collapsed so the top level fits on screen; chevrons open them.
      (into [:ul.features-tree.features-tree-root]
            (map (fn [f] [feature-branch expanded* f]) (non-empty-classes @known-feature-types))))))

(def coordinate-systems
  ^{:doc "Supported genomic coordinate systems. First element is the default."}
  [:base :interbase])

(def coordinate-labels {:base "Base" :interbase "Interbase"})

(defn coordinate-system-selection
  "UI component allowing user to choose which genomic coordinate system. Defaults to base."
  []
  (let [coordinates (subscribe [:regions/coordinates])]
    (fn []
      [:div.region-field
       [:div.region-label "Coordinates"]
       (into [:div.region-radios]
             (for [coord-kw coordinate-systems]
               [:label.region-radio
                [:input {:type "radio"
                         :name "coordinates"
                         :value (name coord-kw)
                         :checked (= coord-kw (or @coordinates
                                                  (first coordinate-systems)))
                         :on-change #(dispatch [:regions/set-coordinates coord-kw])}]
                (coordinate-labels coord-kw)]))])))

(def strand-specific-help
  [:div
   [:p "Perform a strand-specific region search (search " [:strong "+"] " strand if region start<end; search " [:strong "–"] " strand if region end<start). Regions that explicitly specify strand using the " [:strong "chromosome:start:end:strand"] " notation will override this behaviour."]
   [:p [:em "Note: Not all features have strand information, so this will lead to fewer results."]]])

(defn strand-specific-selection
  "UI component allowing user to choose to perform a strand-specific region search. Defaults to off."
  []
  (let [strand-specific (subscribe [:regions/strand-specific])]
    (fn []
      [:div.region-field
       [:div.switch-container.region-strand
        [:span.switch-label.region-label "Strand-specific"]
        [:span.switch
         [:input {:type "checkbox"
                  :role "switch"
                  :aria-label "Strand-specific"
                  :checked (true? @strand-specific)
                  :on-change #(dispatch [:regions/toggle-strand-specific])}]
         [:span.slider.round]]
        [dropdown-hover
         {:data strand-specific-help
          :children [icon "question"]}]]])))

(def !dispatch
  (debounce dispatch 250))

(defn extend-input
  "Text input for one side of the extension. Updates the local input atom and the debounced app-db event."
  [input* label side lock?]
  [:div.extend-side
   [:label.extend-sublabel label]
   [:input.form-control
    {:type "text"
     :placeholder "0"
     :aria-label (str label " extension")
     :value (get @input* side)
     :on-change (fn [e]
                  (when-let [[string _] (parse-bp (oget e :target :value))]
                    (!dispatch [(cond
                                  lock? :regions/extend-region-both
                                  (= side :start) :regions/extend-region-start
                                  :else :regions/extend-region-end) string])
                    (swap! input* (if lock?
                                    #(assoc % :start string :end string)
                                    #(assoc % side string)))))}]])

(defn extend-region-selection
  "UI component allowing user to extend search region, on one of both sides."
  []
  (let [unlock-extend (subscribe [:regions/unlock-extend])
        extend-start (subscribe [:regions/extend-start])
        extend-end (subscribe [:regions/extend-end])
        input* (reagent/atom {:start (or (not-empty @extend-start) 0) :end (or (not-empty @extend-end) 0)})]
    (fn []
      (let [lock? (not @unlock-extend)]
        [:div.region-field.extend-region
         [:div.region-label "Extend regions"]
         [:div.extend-row
          [extend-input input* "Upstream" :start lock?]
          [:button.agr-btn.agr-btn-sm.extend-lock
           {:type "button"
            :class (when lock? :linked)
            :aria-pressed (boolean lock?)
            :aria-label "Link both sides"
            :title "Link both sides"
            :on-click #(dispatch [:regions/toggle-unlock-extend])}
           [icon "lock"]]
          [extend-input input* "Downstream" :end lock?]]
         [:div.region-hint "Accepts bp, 1k, 10k, 1M"]]))))

(defn dedupe-by
  "Keeps the first item for each distinct value of f."
  [f coll]
  (vals (reduce (fn [m x] (if (contains? m (f x)) m (assoc m (f x) x))) (array-map) coll)))

(defn organism-selection
  "UI component allowing user to choose which organisms to search. Defaults to all."
  []
  (let [organism (subscribe [:regions/organism])
        organisms (subscribe [:cache/organisms])
        organisms-with-data (subscribe [:regions/organisms])]
    (fn []
      (let [pred (when-let [orgs (not-empty @organisms-with-data)]
                   (comp orgs :shortName))
            selected (:shortName @organism)
            ;; Keep a stored organism selectable even when the filter drops it,
            ;; so the select always shows what the search will use.
            listed (cond->> @organisms pred (filter pred))
            options (->> (cond-> (vec listed)
                           (and selected (not-any? #(= selected (:shortName %)) listed))
                           (conj @organism))
                         (sort-by :shortName)
                         (dedupe-by :shortName))]
        [:div.region-field
         [:label.region-label {:for "region-organism"} "Organism"]
         (into [:select.form-control
                {:id "region-organism"
                 :class (when selected "organism-set")
                 :value (or selected "")
                 :on-change (fn [e]
                              (let [sn (oget e :target :value)]
                                (dispatch [:regions/set-selected-organism
                                           (when-not (str/blank? sn)
                                             (first (filter #(= sn (:shortName %)) options)))])))}
                [:option {:value ""} "All organisms"]]
               (map (fn [{sn :shortName}] [:option {:key sn :value sn} sn]) options))]))))

; Input box for regions
(defn region-input-box
  "UI component allowing user to type in the regions they wish to search for"
  []
  (reagent/create-class
   (let [to-search (subscribe [:regions/to-search])]
     {:reagent-render
      (fn []
        [:textarea.form-control.region-textarea
         {:rows 6
          :id "region-textarea"
          :placeholder "One region per line, for example 2L:11334..12296"
          :value (or @to-search "")
          :on-change (fn [e]
                       (dispatch [:regions/set-to-search (oget e "target" "value")]))}])
      :component-did-mount (fn [this] (.focus (dom/dom-node this)))})))

(defn region-input []
  (let [search-example (subscribe [:regions/example-search])]
    (fn []
      (let [example-text @search-example]
        [:div.region-field
         [:div.region-label-row
          [:label.region-label {:for "region-textarea"}
           "Regions to search"
           [dropdown-hover
            {:data region-search-help
             :children [icon "question"]}]]
          [:div.region-helpers
           [:button.agr-btn.agr-btn-sm
            {:type "button"
             :disabled (empty? example-text)
             :title (when (empty? example-text) "No example available")
             :on-click #(dispatch [:regions/set-to-search (str/replace example-text "\\n" "\n")])}
            "Show example"]
           [:button.agr-btn.agr-btn-sm
            {:type "button"
             :on-click #(dispatch [:regions/clear-inputs])}
            "Clear"]]]
         [region-input-box]]))))

(defn checkboxes
  "UI component ot allow user to select which types of overlapping features to find"
  []
  (let [counts (subscribe [:regions/feature-type-counts])
        results (subscribe [:regions/results])]
    (fn []
      (let [{:keys [selected total]} @counts]
        [:div.region-card.features-card
         [:div.region-label-row
          [:div.region-label "Features to include"]
          [:span.region-count (str selected " of " total " selected")]]
         [:div.region-helpers.region-field
          [:button.agr-btn.agr-btn-sm
           {:type "button"
            :disabled (= selected total)
            :on-click #(dispatch [:regions/select-all-feature-types])}
           "Select all"]
          [:button.agr-btn.agr-btn-sm
           {:type "button"
            :disabled (zero? selected)
            :on-click #(dispatch [:regions/deselect-all-feature-types])}
           "Select none"]]
         ;; having the container around the tree is important because the tree is recursive
         ;; and we know for sure that the container is the final parent! :)
         [:div.feature-tree-container
          {:class (when-not @results :no-results)}
          [feature-types-tree]]]))))

(defn input-section
  "Entire UI input section / top half of the region search"
  []
  (let [feature-types (subscribe [:regions/feature-types])
        to-search (subscribe [:regions/to-search])
        force-remount-extend-region (subscribe [:regions/force-remount-extend-region])]
    (fn []
      [:div.input-section
       [:div.region-card.form-card
        [region-input]
        [:div.form-options
         [:div.region-row
          [coordinate-system-selection]
          [organism-selection]]
         [strand-specific-selection]
         ;; This is a clever trick to force `extend-region-selection` to
         ;; remount, which causes its inputs to reload their state from app-db.
         ;; Used to reset them back to defaults.
         ^{:key @force-remount-extend-region}
         [extend-region-selection]]
        [:div.region-actions
         [:button.agr-btn.agr-btn-primary
          {:type "button"
           :disabled (or (str/blank? @to-search)
                         (empty? (filter (fn [[_ enabled?]] enabled?) @feature-types)))
           :on-click (fn [e] (dispatch [:regions/run-query])
                       (ocall (oget e "target") "blur"))
           :title "Enter regions or use Show example"}
          "Search"]
         (when (str/blank? @to-search)
           [:span.region-hint.region-actions-hint "Enter at least one region"])]]
       [checkboxes]])))

(defn main []
  [:div.agr-page.regionsearch
   [:h2.agr-page-title "Region search"]
   [input-section]
   [results-section]])
