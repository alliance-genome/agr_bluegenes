(ns bluegenes.pages.templates.views
  (:require [reagent.core :as reagent]
            [re-frame.core :refer [subscribe dispatch]]
            [clojure.string :as s :refer [split join blank?]]
            [json-html.core :as json-html]
            [bluegenes.components.lighttable :as lighttable]
            [imcljs.path :as im-path]
            [bluegenes.components.ui.constraint :refer [constraint]]
            [bluegenes.components.ui.results_preview :refer [fmt-num preview-table]]
            [oops.core :refer [oget ocall]]
            [bluegenes.utils :refer [ascii->svg-arrows compatible-version? sanitize-html
                                     italicize-species-html
                                     webapp-template-url]]
            [bluegenes.pages.templates.helpers :refer [categories-from-tags category-colour]]
            [bluegenes.components.top-scroll :as top-scroll]
            [bluegenes.route :as route]
            [bluegenes.components.icons :refer [icon]]
            [bluegenes.components.loader :refer [mini-loader]]
            [goog.functions :refer [debounce]]
            [bluegenes.components.bootstrap :refer [poppable]]
            [bluegenes.components.ui.autocomplete :as autocomplete]))

(defn categories []
  (let [categories @(subscribe [:template-chooser-categories])
        selected-category @(subscribe [:selected-template-category])]
    (into [:select.form-control.template-category-select
           {:id "template-category-filter"
            :value (or selected-category "")
            :on-change #(dispatch [:template-chooser/set-category-filter
                                   (not-empty (oget % :target :value))])}
           [:option {:value ""} "All"]]
          (for [category categories]
            [:option {:value category} category]))))

(defn sources
  "Mine buttons; each opens this page on that mine's templates."
  []
  (let [mines @(subscribe [:template-chooser/sources])
        current-mine @(subscribe [:current-mine-name])]
    (when (next mines)
      [:div.template-filter.source-filter
       [:span.control-label "Source"]
       (into [:div.template-sources {:role "group"}]
             (for [{:keys [id external? service] mine-name :name} mines
                   :let [active? (= id current-mine)]]
               (if external?
                 ;; BlueGenes cannot run this mine; open its own webapp.
                 [:a {:href (webapp-template-url (:root service) nil)
                      :target "_blank" :rel "noopener"}
                  mine-name [icon "external"]]
                 [:a {:href (route/href ::route/templates {:mine (name id)})
                      :class (when active? "active")
                      :aria-current (when active? "page")
                      ;; Categories differ per mine, so the filter starts over.
                      :on-click #(dispatch [:template-chooser/set-category-filter nil])}
                  mine-name])))])))

(def css-transition-group
  (reagent/adapt-react-class js/ReactTransitionGroup.CSSTransitionGroup))

(defn web-service-url []
  (let [input-ref* (atom nil)
        url (subscribe [:template-chooser/web-service-url])]
    (fn []
      [:span.dropdown
       [:a.dropdown-toggle.action-button
        {:data-toggle "dropdown"
         :role "button"}
        [icon "code"] [:span "Web service URL"]]
       [:div.dropdown-menu.dropdown-menu-right
        [:form {:on-submit #(.preventDefault %)}
         [:div.web-service-url-container
          [:p "Use the URL below to fetch the first " [:strong "10"] " records for this template from the command line or a script " [:em "(authentication needed for private templates and lists)"] " :"]
          [:div.url-row
           [:input.form-control
            {:type "text"
             :ref (fn [el]
                    (when el
                      (reset! input-ref* el)
                      (.focus el)
                      (.select el)))
             :autoFocus true
             :readOnly true
             :value @url}]
           [:button.agr-btn-primary
            {:type "button"
             :on-click (fn [_]
                         (when-let [input-el @input-ref*]
                           (.focus input-el)
                           (.select input-el)
                           (try
                             (ocall js/document :execCommand "copy")
                             (catch js/Error _))))}
            "Copy"]]]]]])))

(defn preview-results
  "Preview results of template as configured by the user or default config"
  []
  (let [authed? @(subscribe [:bluegenes.subs.auth/authenticated?])
        fetching-preview? @(subscribe [:template-chooser/fetching-preview?])
        results-preview @(subscribe [:template-chooser/results-preview])
        preview-error @(subscribe [:template-chooser/preview-error])
        changed-selected? @(subscribe [:template-chooser/changed-selected?])
        loading? (if preview-error
                   false
                   fetching-preview?)
        results-count (:iTotalRecords results-preview)
        ;; This differs from authed? in that it's whether the logged in user is
        ;; authorized to delete the template.
        authorized? @(subscribe [:template-chooser/authorized?])]
    [:div.col-xs-8.preview
     [:h4.preview-title "Results preview"]
     [:div.preview-table-container
      (cond
        preview-error [:div
                       [:pre.well.text-danger preview-error]]
        :else [preview-table
               :query-results results-preview
               :loading? loading?])]
     [:div.template-actions
      [:button.agr-btn-primary
       {:type "button"
        :on-click (fn [] (dispatch [:templates/send-off-query]))}
       (if (or loading? preview-error (< results-count 1))
         "Open in results page"
         (str "View "
              (fmt-num results-count)
              (if (> results-count 1) " rows" " row")))]
      [:button.agr-btn
       {:type "button"
        :on-click (fn [] (dispatch [:templates/edit-query]))}
       "Edit query"]
      (when authed?
        [:button.agr-btn
         {:type "button"
          :on-click (fn [] (dispatch [:templates/edit-template]))}
         "Edit template"])
      ;; Reset appears once a constraint has changed.
      (when changed-selected?
        [:button.btn-link.template-reset
         {:type "button"
          :on-click (fn [] (dispatch [:templates/reset-template]))}
         "Reset"])
      (when authorized?
        [:button.btn-link
         {:type "button"
          :aria-label "Delete template"
          :on-click (fn [] (dispatch [:templates/delete-template]))}
         [icon "bin"]])
      [:span.more-actions
       [web-service-url]]]]))

(defn toggle []
  (fn [{:keys [status on-change]}]
    [:div.switch-container
     [:span.switch-label "Optional"]
     [:span.switch
      [:input {:type "checkbox"
               :role "switch"
               :aria-label "Optional"
               :checked (case status "ON" true "OFF" false false)
               :on-change on-change}]
      [:span.slider.round {:on-click on-change :title status}]]]))

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
                                                (dispatch [:template-chooser/update-preview
                                                           idx (assoc con :switched (case switched "ON" "OFF" "ON"))]))}])]))))]))

(defn tags
  "UI element to visually output all aspect tags into each template card for easy scanning / identification of tags.
  ** Expects: vector of strings 'im:aspect:thetag'."
  [tagvec authorized]
  (let [aspects (for [category (categories-from-tags tagvec)]
                  [:span.tag-type
                   {:class (str "tag-colour-" (category-colour category))
                    :on-click (fn [evt]
                                (.stopPropagation evt)
                                (dispatch [:template-chooser/set-category-filter category]))}
                   category])]
    (into [:div.template-tags
           [:div.permissions
            ;; Most templates are public, so only the private ones get a mark.
            (when-not (contains? (set tagvec) "im:public")
              [:span.permission
               [poppable {:data "This is a private template, visible only to you."
                          :children [icon "lock"]}]])
            (when authorized
              [:span.permission
               [poppable {:data "This template is owned by you."
                          :children [icon "user-circle" nil ["authorized"]]}]])]]

          aspects)))

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
      (into [:h4] (ascii->svg-arrows title))
      [:div.description
       {:dangerouslySetInnerHTML {:__html (italicize-species-html (sanitize-html (:description query)))}}]
      (when selected?
        ;; Few constraints sit in a row above a full-width preview.
        [:div.body {:class (when (<= (count (filter :editable (:where query))) 3) "stacked")}
         [select-template-settings]
         [preview-results]])
      [:div.template-footer
       (if selected?
         [:button.view
          {:type "button"
           :on-click #(dispatch [::route/navigate ::route/templates])}
          "Close"]
         [:button.view {:type "button"} "View"])
       [tags (:tags query) (:authorized query)]]]]))

(defn templates
  "Outputs all the templates that match the user's chosen filters."
  []
  (fn [templates]
    (cond
      @(subscribe [:template-chooser/loading?])
      [:div.templates-loading
       [mini-loader]
       [:span "Loading templates"]]

      (seq templates)
      ;;return the list of templates if there are some
      (into [:div.template-list] (map (fn [t] [template t]) templates))
      :else
      [:div.no-results
       [:svg.icon.icon-wondering [:use {:xlinkHref "#icon-wondering"}]]
       " No templates available"
       (let [category-filter @(subscribe [:selected-template-category])
             text-filter @(subscribe [:template-chooser/text-filter])
             authorized-filter @(subscribe [:template-chooser/authorized-filter])
             filters-active? (or (some? category-filter)
                                 (not (blank? text-filter))
                                 authorized-filter)]
         (cond filters-active?

               [:span
                [:span
                 (cond category-filter
                       (str " in the '" category-filter "' category"))
                 (cond (not-empty text-filter)
                       (str " containing the text '" text-filter "'"))
                 (cond authorized-filter
                       (str " which are owned by you"))
                 "."]
                [:br]
                [:span "Try "
                 [:a {:on-click
                      (fn []
                        (dispatch [:template-chooser/clear-text-filter])
                        (dispatch [:template-chooser/set-category-filter nil])
                        (when authorized-filter
                          (dispatch [:template-chooser/toggle-authorized-filter])))}
                  "removing the filters"]
                 " to view more results. "]]))])))

(defn template-filter []
  (let [input (reagent/atom @(subscribe [:template-chooser/text-filter]))
        debounced (debounce #(dispatch [:template-chooser/set-text-filter %]) 500)
        on-change (fn [value]
                    (reset! input value)
                    (debounced value))]
    (fn []
      [autocomplete/input
       {:id "template-text-filter"
        :value @input
        :placeholder "Search for keywords"
        :aria-label "Filter templates"
        :autoFocus true
        :on-change on-change
        :items (for [[id {:keys [title]}] @(subscribe [:templates])
                     :when title]
                 {:key (name id)
                  :label (-> title (s/replace #"-+>" "→") (s/replace #"<-+" "←"))
                  :on-pick #(dispatch [::route/navigate ::route/template {:template (name id)}])})}])))

(defn authorized-filter []
  (let [filter-authorized? @(subscribe [:template-chooser/authorized-filter])
        authed? @(subscribe [:bluegenes.subs.auth/authenticated?])
        im-version @(subscribe [:current-intermine-version])
        not-compatible? (not (compatible-version? "5.0.4" im-version))]
    (when authed?
      [:button.btn.btn-link.btn-slim
       {:on-click #(dispatch [:template-chooser/toggle-authorized-filter])
        :disabled not-compatible?}
       [poppable {:data (if not-compatible?
                          "This mine is running an older InterMine version which does not support filtering to templates owned by you."
                          "Click to toggle filtering of templates to only those owned by you")
                  :options {:data-placement "bottom"}
                  :children [icon "user-circle" 2 (when filter-authorized? ["authorized"])]}]])))

(defn filters []
  [:div.template-filters
   [:div.template-filter-container.agr-page
    [sources]
    [:div.template-filter.text-filter
     [:label.control-label
      {:for "template-text-filter"}
      "Filter"]
     [:div.filter-input
      [template-filter]
      [authorized-filter]]]
    [:div.template-filter.category-filter
     [:label.control-label {:for "template-category-filter"} "Category"]
     [categories]]]])

(defn main []
  (let [im-templates (subscribe [:templates-by-category])]
    (fn []
      [:div.template-component-container
       [:div.agr-page.agr-page-head
        [:h2.agr-page-title "Templates"]]
       [filters]
       [:div.agr-page.template-container
        [:div.templates
         [:div.template-list
          [templates @im-templates]]]]
       [top-scroll/main]])))
