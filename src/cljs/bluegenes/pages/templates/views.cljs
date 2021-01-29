(ns bluegenes.pages.templates.views
  (:require [reagent.core :as reagent]
            [re-frame.core :refer [subscribe dispatch]]
            [clojure.string :as s :refer [split join blank?]]
            [json-html.core :as json-html]
            [bluegenes.components.lighttable :as lighttable]
            [imcljs.path :as im-path]
            [bluegenes.components.ui.constraint :refer [constraint]]
            [bluegenes.components.ui.results_preview :refer [preview-table]]
            [oops.core :refer [oget ocall]]
            [bluegenes.components.loader :refer [mini-loader]]
            [bluegenes.utils :refer [ascii-arrows ascii->svg-arrows]]
            [bluegenes.pages.templates.helpers :refer [categories-from-tags]]
            [bluegenes.components.top-scroll :as top-scroll]
            [bluegenes.route :as route]))

(defn categories []
  (let [categories (subscribe [:template-chooser-categories])
        selected-category (subscribe [:selected-template-category])]
    (fn []
      (into [:ul.nav.nav-pills.template-categories
             [:li {:on-click #(dispatch [:template-chooser/set-category-filter nil])
                   :class (if (nil? @selected-category) "active")}
              [:a.type-all "All"]]]
            (map (fn [category]
                   [:li {:on-click #(dispatch [:template-chooser/set-category-filter category])
                         :class
                         (if (= category @selected-category) " active")}
                    [:a {:class (str
                                 "type-" category)} category]])
                 @categories)))))

(def css-transition-group
  (reagent/adapt-react-class js/ReactTransitionGroup.CSSTransitionGroup))

(defn preview-results
  "Preview results of template as configured by the user or default config"
  []
  (let [fetching-preview? @(subscribe [:template-chooser/fetching-preview?])
        results-preview @(subscribe [:template-chooser/results-preview])
        preview-error @(subscribe [:template-chooser/preview-error])
        loading? (if preview-error
                   false
                   fetching-preview?)
        results-count (:iTotalRecords results-preview)]
    [:div.col-xs-8.preview
     [:div.preview-header
      [:h4 "Results Preview"]
      (when loading?
        [:div.preview-header-loader
         [mini-loader "tiny"]])]
     [:div.preview-table-container
      (cond
        preview-error [:div
                       [:pre.well.text-danger preview-error]]
        :else [preview-table
               :query-results results-preview
               :loading? loading?])]
     [:div.btn-group
      [:button.btn.btn-primary.btn-raised.view-results
       {:type "button"
        :on-click (fn [] (dispatch [:templates/send-off-query]))}
       (cond
         loading? "Loading"
         (or preview-error
             (< results-count 1)) "Open in results page"
         :else (str "View "
                    results-count
                    (if (> results-count 1) " rows" " row")))]
      [:button.btn.btn-default.btn-raised
       {:type "button"
        :on-click (fn [] (dispatch [:templates/edit-query]))}
       "Edit query"]]]))

(defn toggle []
  (fn [{:keys [status on-change]}]
    [:div.switch-container
     [:span.switch-label "Optional"]
     [:span.switch
      [:input {:type "checkbox" :checked (case status "ON" true "OFF" false false)}]
      [:span.slider.round {:on-click on-change}]]
     [:span.switch-status status]]))

(defn select-template-settings
  "UI component to allow users to select template details, e.g. select a list to be in, lookup value greater than, less than, etc."
  []
  (let [selected-template @(subscribe [:selected-template])
        service @(subscribe [:selected-template-service])
        lists @(subscribe [:current-lists])
        all-constraints (:where selected-template)
        model (assoc (:model service) :type-constraints all-constraints)]
    [:div.col-xs-4.border-right
     (into [:div.form]
           ; Only show editable constraints, but don't filter because we want the index!
           (->> (keep-indexed (fn [idx con] (if (:editable con) [idx con])) all-constraints)
                (map (fn [[idx {:keys [switched switchable] :as con}]]
                       [:div.template-constraint-container
                        [constraint
                         :model model
                         :typeahead? true
                         :path (:path con)
                         :value (or (:value con) (:values con))
                         :op (:op con)
                         :label (s/join " > " (take-last 2 (s/split (im-path/friendly model (:path con)) #" > ")))
                         :code (:code con)
                         :hide-code? true
                         :label? true
                         :disabled (= switched "OFF")
                         :lists lists
                         :on-blur (fn [new-constraint]
                                    (dispatch [:template-chooser/replace-constraint
                                               idx (merge (cond-> con
                                                            (contains? new-constraint :values) (dissoc :value)
                                                            (contains? new-constraint :value) (dissoc :values)) new-constraint)])
                                    (dispatch [:template-chooser/update-preview
                                               idx (merge (cond-> con
                                                            (contains? new-constraint :values) (dissoc :value)
                                                            (contains? new-constraint :value) (dissoc :values)) new-constraint)]))
                         :on-change (fn [new-constraint]
                                      (dispatch [:template-chooser/replace-constraint
                                                 idx (merge (cond-> con
                                                              (contains? new-constraint :values) (dissoc :value)
                                                              (contains? new-constraint :value) (dissoc :values)) new-constraint)]))]
                        (when switchable
                          [toggle {:status switched
                                   :on-change (fn [new-constraint]
                                                (dispatch [:template-chooser/replace-constraint
                                                           idx (assoc con :switched (case switched "ON" "OFF" "ON"))])
                                                (dispatch [:template-chooser/update-preview]))}])]))))]))

(defn tags
  "UI element to visually output all aspect tags into each template card for easy scanning / identification of tags.
  ** Expects: vector of strings 'im:aspect:thetag'."
  [tagvec]
  (let [aspects (for [category (categories-from-tags tagvec)]
                  [:span.tag-type
                   {:class (str "type-" category)
                    :on-click (fn [evt]
                                (.stopPropagation evt)
                                (dispatch [:template-chooser/set-category-filter category]))}
                   category])]
    ;; This element should still be present even when it has no contents.
    ;; The "View >>" button is absolute positioned, so otherwise it would
    ;; overlap with the template's description.
    (into [:div.template-tags]
          (when (seq aspects)
            (cons "Categories: " aspects)))))

(defn template
  "UI element for a single template."
  [[id query]]
  (let [title (:title query)
        selected-template-name @(subscribe [:selected-template-name])
        selected? (= id selected-template-name)]
    [:div.grid-1
     [:div.col.ani.template
      {:class (when selected? "selected")
       :id (name id)
       :on-click #(when (not selected?)
                    (dispatch [::route/navigate ::route/template {:template (name id)}]))}
      (into [:h4]
            (if (ascii-arrows title)
              (ascii->svg-arrows title)
              [[:span title]]))
      [:div.description
       {:dangerouslySetInnerHTML {:__html (:description query)}}]
      (when selected?
        [:div.body
         [select-template-settings]
         [preview-results]])
      (if selected?
        [:button.view
         {:on-click #(dispatch [::route/navigate ::route/templates])}
         "Close <<"]
        [:button.view
         "View >>"])
      [tags (:tags query)]]]))

(defn templates
  "Outputs all the templates that match the user's chosen filters."
  []
  (fn [templates]
    (if (seq templates)
      ;;return the list of templates if there are some
      (into [:div.template-list] (map (fn [t] [template t]) templates))
      ;;if there are no templates, perhaps because of filters or perhaps not...
      [:div.no-results
       [:svg.icon.icon-wondering [:use {:xlinkHref "#icon-wondering"}]]
       " No templates available"
       (let [category-filter (subscribe [:selected-template-category])
             text-filter (subscribe [:template-chooser/text-filter])
             filters-active? (or (some? @category-filter) (not (blank? @text-filter)))]
         (cond filters-active?

               [:span
                [:span
                 (cond @category-filter
                       (str " in the '" @category-filter "' category"))
                 (cond @text-filter
                       (str " containing the text '" @text-filter "'"))]
                [:span ". Try "
                 [:a {:on-click
                      (fn []
                        (dispatch [:template-chooser/set-text-filter ""])
                        (dispatch [:template-chooser/set-category-filter nil]))} "removing the filters"]
                 " to view more results. "]]))])))

(defn template-filter []
  (let [text-filter (subscribe [:template-chooser/text-filter])]
    (fn []
      [:input.form-control.input-lg
       {:type "text"
        :value @text-filter
        :placeholder "Filter text..."
        :on-change (fn [e]
                     (dispatch [:template-chooser/set-text-filter (.. e -target -value)]))}])))

(defn filters []
  (let [me (reagent/atom nil)]
    (reagent/create-class
     {:component-did-mount (fn []
                             (let [nav-height (-> "#bluegenes-main-nav" js/$ (ocall :outerHeight true))]
                               (some-> @me (ocall :affix (clj->js {:offset {:top nav-height}})))))
      :reagent-render (fn [categories template-filter filter-state]
                        [:div.template-filters.container-fluid
                         {:ref (fn [e] (some->> e js/$ (reset! me)))}
                         [:div.template-filter
                          [:label.control-label "Filter by category"]
                          [categories]]
                         [:div.template-filter
                          [:label.control-label "Filter by description"]
                          [template-filter filter-state]]])})))

(defn main []
  (let [im-templates (subscribe [:templates-by-category])
        filter-state (reagent/atom nil)
        me (reagent/atom nil)
        filters-are-fixed? (reagent/atom nil)
        filter-height (reagent/atom nil)
        on-resize (fn []
                    ; Store the height of the child .template-filters element
                    (reset! filter-height
                            (-> @me
                                (ocall :find ".template-filters")
                                (ocall :outerHeight true))))
        on-scroll (fn []
                    ; Store whether the child .template-filers element is affixed or not
                    (reset! filters-are-fixed?
                            (-> @me
                                (ocall :find ".template-filters")
                                (ocall :hasClass "affix"))))]
    (reagent/create-class
     {:component-did-mount (fn []
                              ; Call the resize function when the component mounts
                             (on-resize)
                              ; On resize update the known value of the child filters element
                             (-> js/window js/$ (ocall :on "resize" on-resize))
                              ; On scroll update the known value of the child filters element affixed status
                             (-> js/window js/$ (ocall :on "scroll" on-scroll)))
      :component-will-unmount (fn []
                                 ; Remove the events when the component unmounts
                                (-> js/window js/$ (ocall :off "resize" on-resize))
                                (-> js/window js/$ (ocall :off "scroll" on-scroll)))
      :reagent-render (fn []
                        [:div.template-component-container
                          ; Store a reference to this element so we can find the child filters container
                         [:div {:ref (fn [e] (some->> e js/$ (reset! me)))}
                          [filters categories template-filter filter-state]]
                         [:div.container.template-container
                           ; Dynamically push this container down when the filters element is fixed
                          {:style {:padding-top (if @filters-are-fixed? (str @filter-height "px") 0)}}
                          [:div.row
                           [:div.col-xs-12.templates
                            [:div.template-list
                             [templates @im-templates]]]]]
                         [top-scroll/main]])})))
