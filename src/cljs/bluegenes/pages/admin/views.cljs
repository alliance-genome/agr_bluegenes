(ns bluegenes.pages.admin.views
  (:require [re-frame.core :refer [subscribe dispatch]]
            [reagent.core :as reagent]
            [bluegenes.pages.admin.events :as events]
            [bluegenes.pages.admin.subs :as subs]
            [bluegenes.components.icons :refer [icon]]
            [oops.core :refer [oget ocall]]
            [bluegenes.components.bootstrap :refer [poppable]]
            [bluegenes.utils :refer [md-element]]))

(defn on-enter [f]
  (fn [e]
    (when (= 13 (oget e :charCode))
      (f e))))

(defn report-layout-dropdown []
  (let [categorize-class (subscribe [::subs/categorize-class])
        options (subscribe [::subs/categorize-options])]
    (when (nil? @categorize-class)
      (dispatch [::events/set-categorize-class (->> @options first key name)]))
    (fn []
      [:div.input-group.categories-dropdown
       [:label.control-label
        {:for "admin__report-category"}
        "Manage layout"]
       (into [:select.form-control
              {:id "admin__report-category"
               :on-change #(dispatch [::events/set-categorize-class (oget % :target :value)])
               :value @categorize-class}]
             (map (fn [[class-kw details :as item]]
                    (if (map-entry? item)
                      [:option {:value (name class-kw)} (:displayName details)]
                      [:option {:disabled true :role "separator"} "─────────────────────────"]))
                  @options))])))

(defn report-layout-child [_ {:keys [description]}]
  (let [edit-description* (reagent/atom false)
        description* (reagent/atom (or description ""))
        show-preview* (reagent/atom false)]
    (fn [[category-index child-index] {:keys [label type collapse description]}]
      (let [dispatch-idx (fn [[evt & args]]
                           (dispatch (into [evt category-index child-index] args)))]
        [:<>
         [:li.class-entry
          [:div
           [:span label]
           [:span.type type]]
          [:div.btn-group-sm.class-options
           [:button.btn.btn-default.btn-fab
            {:on-click (fn [_evt]
                         (swap! edit-description* not)
                         (reset! description* description))}
            [poppable {:data [:span (if (seq description)
                                      "Edit the description that can be viewed from header"
                                      "Add a description that can be viewed from header")]
                       :children [icon "info" 2 (when (seq description) [:enabled-icon])]}]]
           [:button.btn.btn-default.btn-fab
            {:on-click #(dispatch-idx [::events/child-set-collapse (not collapse)])}
            [poppable {:data [:span (if collapse
                                      "Header will be visible but content needs to be toggled to show"
                                      "Header and content will be visible")]
                       :children [icon (if collapse "eye-blocked" "eye") 2 (when-not collapse [:enabled-icon])]}]]
           [:button.btn.btn-default.btn-fab
            {:on-click #(dispatch-idx [::events/child-move-up])}
            [icon "move-up-list" 2]]
           [:button.btn.btn-default.btn-fab
            {:on-click #(dispatch-idx [::events/child-move-down])}
            [icon "move-down-list" 2]]
           [:button.btn.btn-default.btn-fab
            {:on-click #(dispatch-idx [::events/child-remove])}
            [icon "remove-list" 2]]]]
         (when @edit-description*
           [:div
            (when @show-preview*
              [md-element @description*])
            [:textarea.form-control.class-description
             {:rows 2
              :autoFocus true
              :placeholder (str "Describe the contents of this " type " (markdown supported).")
              :value @description*
              :on-change #(reset! description* (oget % :target :value))}]
            [:div.btn-group.btn-group-lg
             [:button.btn.btn-primary.btn-raised.btn-sm
              {:on-click (fn [_evt]
                           (dispatch-idx [::events/child-set-description @description*])
                           (reset! edit-description* false))}
              "Save"]
             [:button.btn.btn-default.btn-raised.btn-sm
              {:on-click (fn [_evt]
                           (reset! edit-description* false)
                           (reset! description* description))}
              "Cancel"]
             [:button.btn.btn-warning.btn-raised.btn-sm
              {:on-click (fn [_evt]
                           (dispatch-idx [::events/child-set-description nil])
                           (reset! description* "")
                           (reset! edit-description* false))}
              "Clear"]
             [:label.description-preview-checkbox
              [:input
               {:type "checkbox"
                :checked @show-preview*
                :on-change #(swap! show-preview* not)}]
              "Show preview"]]])]))))

(defn report-layout-category []
  (let [cat-class (subscribe [::subs/categorize-class])
        available-classes (subscribe [::subs/available-class-names @cat-class])
        available-tools (subscribe [::subs/available-tool-names @cat-class])
        available-templates (subscribe [::subs/available-template-names @cat-class])
        active* (reagent/atom false)
        renaming* (reagent/atom false)
        rename-ref* (reagent/atom nil)
        select-ref* (reagent/atom nil)]
    (fn [category-index {:keys [category children]}]
      [:li {:class (when @active* :active)}
       (if @renaming*
         [:a.rename-category.input-group-sm
          {:on-click #(swap! active* not)}
          [:input.form-control.input-sm
           {:ref #(when %
                    (reset! rename-ref* %)
                    (.focus %))
            :placeholder category
            :on-key-press (on-enter (fn [e]
                                      (when-let [value (not-empty (oget e :target :value))]
                                        (dispatch [::events/category-rename category-index value]))
                                      (reset! renaming* false)))
            :on-click #(.stopPropagation %)
            :default-value category}]
          [:button.btn.btn-default.btn-raised.btn-xs
           {:on-click (fn [e]
                        (.stopPropagation e)
                        (when-let [rename-elem @rename-ref*]
                          (when-let [value (not-empty (oget rename-elem :value))]
                            (dispatch [::events/category-rename category-index value]))
                          (reset! renaming* false)))}
           "Save"]
          [:button.btn.btn-default.btn-raised.btn-xs
           {:on-click (fn [e]
                        (.stopPropagation e)
                        (reset! renaming* false))}
           "Cancel"]]
         [:a {:on-click #(swap! active* not)}
          category
          [:div
           [:button.btn.btn-default.btn-raised.btn-xs
            {:on-click (fn [e]
                         (.stopPropagation e)
                         (reset! renaming* true))}
            "Rename"]
           [:button.btn.btn-default.btn-raised.btn-xs
            {:on-click (fn [e]
                         (.stopPropagation e)
                         (dispatch [::events/category-move-up category-index]))}
            "Move up"]
           [:button.btn.btn-default.btn-raised.btn-xs
            {:on-click (fn [e]
                         (.stopPropagation e)
                         (dispatch [::events/category-move-down category-index]))}
            "Move down"]
           [:button.btn.btn-danger.btn-raised.btn-xs
            {:on-click (fn [e]
                         (.stopPropagation e)
                         (dispatch [::events/category-remove category-index]))}
            "Delete"]]])
       (when @active*
         [:ul.classes
          (concat
           (for [[i child] (map-indexed vector children)]
             ^{:key (:id child)}
             [report-layout-child [category-index i] child])
           [[:li.add-child
             {:key "addchild"}
             [:div.full-width
              [:> js/Select
               {:placeholder "Available classes, tools and templates"
                :isMulti true
                :ref #(when % (reset! select-ref* %))
                :options [{:label "Classes"
                           :options @available-classes}
                          {:label "Tools"
                           :options @available-tools}
                          {:label "Templates"
                           :options @available-templates}]}]]
             [:div.btn-group-sm
              [:button.btn.btn-default.btn-fab
               {:on-click #(when-let [select-elem @select-ref*]
                             (when-let [children (seq (js->clj (oget select-elem :state :value) :keywordize-keys true))]
                               (dispatch [::events/children-add category-index children])
                               (ocall (oget select-elem :select) :clearValue)))}
               [icon "plus"]]]]])])])))

(defn report-layout-selector []
  (let [categories (subscribe [::subs/categories])
        new-category (subscribe [::subs/new-category])
        input-ref* (reagent/atom nil)]
    (fn []
      [:div.categories-selector
       (when (seq @categories)
         [:em "Click on a category to expand/collapse its children"])
       [:ul.nav.nav-pills.nav-stacked
        (concat
         (for [[i category] (map-indexed vector @categories)]
           ^{:key (:id category)}
           [report-layout-category i category])
         [[:li.add-category.input-group-sm
           {:key "addcat"}
           [:input.form-control.input-sm
            {:ref #(when % (reset! input-ref* %))
             :placeholder "New category"
             :on-change #(dispatch [::events/set-new-category (oget % :target :value)])
             :on-key-press (on-enter
                            #(do (dispatch [::events/category-add @new-category])
                                 (some-> @input-ref* .focus)))
             :value @new-category}]
           [:button.btn.btn-default.btn-raised.btn-xs
            {:on-click #(do (dispatch [::events/category-add @new-category])
                            (some-> @input-ref* .focus))
             :disabled (empty? @new-category)}
            "Add category"]]])]])))

(defn runnable-templates-tooltip []
  [poppable {:data [:div
                    [:p "Some templates can automatically be run on a report page if they meet certain conditions."]
                    [:ol
                     [:li "They must have a single editable constraint"]
                     [:li "That single constraint must be of type LOOKUP"]
                     [:li "That single constraint must be backed by the same class as the item on the report page"]]]
             :children [icon "info"]}])

(defn report-layout []
  (let [bg-properties-support? @(subscribe [:bg-properties-support?])
        response @(subscribe [::subs/responses :report-layout])
        dirty? @(subscribe [::subs/dirty?])]
    [:div.well.well-lg
     [:h3 "Report page layout"]
     [:p "Create categories containing classes (references/collections in the model), tools (visualizations) and/or runnable templates " [runnable-templates-tooltip] ", to be used to determine the layout of report pages. Each layout applies to all report pages for a specific " [:strong "class"] " (e.g. " [:em "Gene"] "). If a class doesn't have a layout created for it, one will be autogenerated when opening the report page."]
     [report-layout-dropdown]
     [report-layout-selector]
     (when (not bg-properties-support?)
       [:div.alert.alert-warning
        [:strong "This InterMine is running an older version which does not support saving BlueGenes layouts. You will still be able to create layouts for testing, but they will disappear when refreshing or closing the browser tab. The layouts you create will also not be available to other users."]])
     [:div.flex-row
      [:button.btn.btn-primary.btn-raised
       {:on-click #(dispatch [::events/save-layout bg-properties-support?])}
       "Save changes"]
      (when-let [{:keys [type message]} (if dirty?
                                          {:type "failure"
                                           :message "You have unsaved changes!"}
                                          response)]
        [:p {:class type} message])]]))

(defn main []
  [:div.admin-page.container
   [report-layout]])
