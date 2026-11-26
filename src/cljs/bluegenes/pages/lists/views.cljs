(ns bluegenes.pages.lists.views
  (:require [re-frame.core :refer [subscribe dispatch]]
            [reagent.core :as r]
            [bluegenes.components.icons :refer [icon icon-comp]]
            [bluegenes.components.loader :refer [mini-loader]]
            [bluegenes.pages.lists.utils :refer [folder? internal-tag?]]
            [bluegenes.pages.lists.upset :as upset]
            [cljs-time.format :as time-format]
            [cljs-time.coerce :as time-coerce]
            [oops.core :refer [oget oset!]]
            [goog.functions :refer [debounce]]
            [bluegenes.components.select-tags :as select-tags]
            [bluegenes.subs.auth :as auth]
            [clojure.string :as str]
            [bluegenes.route :as route]
            [bluegenes.components.bootstrap :refer [poppable]]
            [bluegenes.components.ui.autocomplete :as autocomplete]
            [bluegenes.utils :refer [italicize-species]])
  (:import goog.date.Date))

(def set-operations [:combine :intersect :difference :subtract])

(def set-operations->assets
  {:combine {:text "Combine lists"
             :icon [icon "venn-combine"]}
   :intersect {:text "Intersect lists"
               :icon [icon "venn-intersection"]}
   :difference {:text "Difference lists"
                :icon [icon "venn-disjunction"]}
   :subtract {:text "Subtract lists"
              :icon [icon "venn-difference"]}})

(def set-operations->labels
  {:combine "Combine"
   :intersect "Intersect"
   :difference "Difference"
   :subtract "Subtract"})

(defn find-set-op [f set-op]
  (let [target-index (some (fn [[i op]]
                             (when (= op set-op) (f i)))
                           (map-indexed vector set-operations))]
    (when (contains? set-operations target-index)
      (get set-operations target-index))))

(defn filter-lists []
  (let [input (r/atom @(subscribe [:lists/keywords-filter]))
        debounced (debounce #(dispatch [:lists/set-keywords-filter %]) 500)
        on-change (fn [value]
                    (reset! input value)
                    (debounced value))]
    (fn []
      (let [type-names @(subscribe [:lists/type-names])
            items (for [{:keys [title type size status]} (vals @(subscribe [:lists/by-id]))
                        :when (and title (not= status "TO_UPGRADE"))]
                    {:key title
                     :label title
                     :meta (str (.toLocaleString size) " " (get type-names type type))
                     :on-pick #(dispatch [::route/navigate ::route/results {:title title}])})]
        [:div.filter-lists
         [:h2.lists-title.agr-page-title "Lists"]
         [:div.filter-input.agr-filter-bar
          [autocomplete/input
           {:id "lists-keyword-filter"
            :aria-label "Search lists"
            :placeholder "Search lists"
            :on-change on-change
            :value @input
            :items items}]
          [icon "search"]]]))))

(defn filter-select
  "A labelled select for one list filter. Option values are strings; the empty
  string maps to nil (no filter) and `keywordize?` turns the rest into the
  keywords `->filterf` expects."
  [{:keys [filter-name label options keywordize?]}]
  (let [active (some-> @(subscribe [:lists/filter filter-name]) name)
        id (str "lists-filter-" (name filter-name))]
    [:div.list-filter
     [:label {:for id} label]
     (into [:select.form-control
            {:id id
             :value (or active "")
             :on-change (fn [e]
                          (let [value (oget e :target :value)]
                            (dispatch [:lists/set-filter filter-name
                                       (cond
                                         (empty? value) nil
                                         keywordize? (keyword value)
                                         :else value)])))}]
           (for [{:keys [text value]} options]
             ^{:key value}
             [:option {:value value} text]))]))

(defn filter-band []
  (let [all-types @(subscribe [:lists/all-types])
        type-names @(subscribe [:lists/type-names])
        all-tags @(subscribe [:lists/all-tags])
        filters @(subscribe [:lists/filters])
        fetching-lists? @(subscribe [:lists/fetching?])
        filtered? (some #(if (string? %) (seq %) (some? %)) (vals filters))]
    [:div.list-filters
     [filter-select
      {:filter-name :lists
       :label "Show"
       :keywordize? true
       :options [{:text "All lists" :value ""}
                 {:text "Your lists" :value "private"}
                 {:text "Public lists" :value "public"}
                 {:text "Folders first" :value "folder"}
                 {:text "Needs upgrade" :value "upgrade"}]}]
     [filter-select
      {:filter-name :date
       :label "Date"
       :keywordize? true
       :options [{:text "Any time" :value ""}
                 {:text "Last day" :value "day"}
                 {:text "Last week" :value "week"}
                 {:text "Last month" :value "month"}
                 {:text "Last year" :value "year"}]}]
     [filter-select
      {:filter-name :type
       :label "Type"
       :options (cons {:text "All types" :value ""}
                      (sort-by :text
                               (map (fn [type] {:text (get type-names type type) :value type})
                                    all-types)))}]
     (when (seq all-tags)
       [filter-select
        {:filter-name :tags
         :label "Tag"
         :options (cons {:text "All tags" :value ""}
                        (map (fn [tag] {:text tag :value tag}) all-tags))}])
     [:div.list-filters-end
      (when filtered?
        [:button.link-button
         {:type "button"
          :on-click #(dispatch [:lists/reset-filters])}
         "Clear filters"])
      [:button.agr-btn.agr-btn-sm
       {:type "button"
        :disabled fetching-lists?
        :on-click #(dispatch [:assets/fetch-lists])}
       (if fetching-lists?
         [:<> [mini-loader "tiny"] "Refreshing"]
         "Refresh")]]]))

(defn selection-bar []
  (let [selected-count (count @(subscribe [:lists/selected-lists]))
        operation? @(subscribe [:lists/selected-operation?])
        deletable? @(subscribe [:lists/selected-deletable?])]
    (when (pos? selected-count)
      [:div.selection-bar
       [:div.selection-count
        [:strong (str selected-count " selected")]
        [:button.link-button
         {:type "button"
          :on-click #(dispatch [:lists/clear-selected])}
         "Clear"]]
       (into [:div.selection-group]
             (concat
              (for [set-op set-operations]
                [:button.agr-btn.agr-btn-sm
                 {:type "button"
                  :disabled (not operation?)
                  :title (when-not operation? "Select 2 or more lists")
                  :on-click #(dispatch [:lists/open-modal set-op])}
                 (get-in set-operations->labels [set-op])])
              [[upset/button]]))
       [:div.selection-group
        [:button.agr-btn.agr-btn-sm
         {:type "button"
          :on-click #(dispatch [:lists/open-modal :copy])}
         "Copy"]
        [:button.agr-btn.agr-btn-sm
         {:type "button"
          :on-click #(dispatch [:lists/open-modal :move])}
         "Move"]
        [:button.agr-btn.agr-btn-sm.danger
         {:type "button"
          :disabled (not deletable?)
          :title (when-not deletable? "You can only delete lists you own")
          :on-click #(dispatch [:lists/open-modal :delete])}
         "Delete"]]])))

(defn pagination-items [p pages]
  (concat
   [{:disabled (= p 1) :label "‹" :value (dec p)}]
   (when (> p 1) [{:label 1 :value 1}])
   (when (= p 3) [{:label 2 :value 2}])
   (when (> p 3) [{:label "..."}])
   (for [i (range p (min (inc pages) (+ p 3)))]
     {:active (= i p) :label i :value i})
   (when (< p (- pages 4)) [{:label "..."}])
   (when (= p (- pages 4)) [{:label (dec pages) :value (dec pages)}])
   (when (< p (- pages 2)) [{:label pages :value pages}])
   [{:disabled (= p pages) :label "›" :value (inc p)}]))

(defn list-footer []
  (let [per-page @(subscribe [:lists/per-page])
        page-count @(subscribe [:lists/page-count])
        current-page @(subscribe [:lists/current-page])
        total @(subscribe [:lists/top-level-count])]
    ;; This is a guard to switch to the last page if the current one no
    ;; longer exists. The right place to put it would be in :lists/initialize
    ;; but we have to normalize-lists to tell the page count. As a future
    ;; refactoring improvement, you could compute page count as part of
    ;; denormalization and put it in app-db, instead of using it as a sub.
    (when (and (pos? page-count) (> current-page page-count))
      (dispatch [:lists/set-current-page page-count]))
    ;; Nothing to page through when everything fits on one page of the default size.
    (when (and (pos? page-count)
               (or (> page-count 1) (> total 20)))
      [:div.list-footer
       [:div.list-footer-info
        [:span (str "Showing " (inc (* per-page (dec current-page))) " to "
                    (min total (* per-page current-page)) " of " total)]
        [:label.list-rows
         [:span "Rows"]
         (into [:select.form-control
                {:value per-page
                 :on-change #(dispatch [:lists/set-per-page
                                        (js/parseInt (oget % :target :value) 10)])}]
               (for [value [20 50 100]]
                 ^{:key value}
                 [:option {:value value} value]))]]
       (into [:ul.pagination]
             (map (fn [{:keys [disabled active label value]}]
                    [:li {:class (cond disabled :disabled
                                       active :active)}
                     (if value
                       [:button {:type "button"
                                 :disabled (boolean disabled)
                                 :aria-label (if (number? label)
                                               (str "Page " label)
                                               (if (= label "‹") "Previous page" "Next page"))
                                 :aria-current (when active "page")
                                 :on-click #(dispatch [:lists/set-current-page value true])}
                        label]
                       [:span.pagination-gap label])])
                  (pagination-items current-page page-count)))])))

(def list-time-formatter (time-format/formatters :mysql))
(def list-date-formatter (time-format/formatter "d MMM Y"))

(let [minute 60000
      hour 3.6e+6
      day 8.64e+7]
  (defn pretty-timestamp [ts]
    (let [now (.getTime (js/Date.))
          ago (- now ts)
          today (.getTime (Date.)) ; Uses goog.date.Date for midnight time.
          yesterday (- today day)]
      (cond
        (< ago minute) "Just now"
        (< ago hour) (let [amount (quot ago minute)]
                       (str amount " min" (when (> amount 1) "s") " ago"))
        (>= ts today) (let [amount (quot ago hour)]
                        (str amount " hour" (when (> amount 1) "s") " ago"))
        (>= ts yesterday) "Yesterday"
        :else (time-format/unparse list-date-formatter
                                   (time-coerce/from-long ts))))))

(defn readable-time [ts]
  [poppable {:data (time-format/unparse list-time-formatter
                                        (time-coerce/from-long ts))
             :children (pretty-timestamp ts)}])

;; Colour carries meaning only for the main InterMine data types.
(def type-colours
  {"Gene" "gene"
   "Protein" "protein"
   "Publication" "publication"
   "Interaction" "interaction"
   "Organism" "organism"
   "GOTerm" "go"})

(defn list-type [type-names type]
  [:span.list-type
   {:class (some->> (type-colours type) (str "lt-"))}
   (get type-names type type)])

(defn list-tags [tags]
  (into [:div.list-tags]
        ;; Hide internal tags.
        (for [tag (remove internal-tag? tags)]
          ^{:key tag}
          [:span.list-tag tag])))

(defn sort-button [column label]
  (let [{active-column :column order :order} @(subscribe [:lists/sort])
        active? (= column active-column)]
    [:button.sort-button
     {:type "button"
      :class (when active? "active")
      :on-click #(dispatch [:lists/toggle-sort column])}
     label
     [:span.sort-chevron
      {:class (when active?
                (case order
                  :asc "active-asc-sort"
                  :desc "active-desc-sort"))}]]))

(defn list-row-controls [{:keys [id authorized status name]} labels?]
  (let [upgrade? (= status "TO_UPGRADE")
        action (fn [action-name label icon-name modal]
                 [:button.list-action
                  {:type "button"
                   :class action-name
                   :title label
                   :aria-label label
                   :disabled (and upgrade? (= modal :copy))
                   :on-click #(dispatch [:lists/open-modal modal id])}
                  [icon icon-name]
                  (when labels? [:span label])])]
    [:<>
     (when upgrade?
       [:a.list-action.list-action-upgrade
        {:href (route/href ::route/upgrade nil {:name name})
         :title "Upgrade list"
         :aria-label "Upgrade list"}
        [icon "arrow-up"]
        (when labels? [:span "Upgrade list"])])
     [action "action-copy" "Copy list" "list-copy" :copy]
     (when authorized
       [:<>
        [action "action-edit" "Edit list" "list-edit" :edit]
        [action "action-delete" "Delete list" "list-delete" :delete]])]))

(defn list-row [item show-tags?]
  (let [{:keys [id title size authorized description timestamp type tags status
                path is-last]} item
        expanded-paths @(subscribe [:lists/expanded-paths])
        selected-lists @(subscribe [:lists/selected-lists])
        new-lists @(subscribe [:lists/new-lists])
        type-names @(subscribe [:lists/type-names])
        logged-in? @(subscribe [::auth/authenticated?])
        is-folder (folder? item)
        is-expanded (and is-folder (contains? expanded-paths path))
        is-selected (contains? selected-lists id)
        is-new (contains? new-lists {:id id})
        is-public (contains? (set tags) "im:public")]
    [:div.lists-row.lists-item
     {:class [(when (or is-expanded is-last) :separator)
              (when is-selected :selected)]}

     [:div.lists-col.col-check
      (if is-folder
        [:button.folder-toggle
         {:type "button"
          :aria-label (if is-expanded "Collapse folder" "Expand folder")
          :aria-expanded (boolean is-expanded)
          :on-click #(dispatch [(if is-expanded :lists/collapse-path :lists/expand-path) path])}
         [icon (if is-expanded "collapse-folder" "expand-folder")]]
        [:input {:type "checkbox"
                 :aria-label (str "Select " title)
                 :disabled (= status "TO_UPGRADE")
                 :checked is-selected
                 :on-change #(dispatch [(if (oget % :target :checked)
                                          :lists/select-list
                                          :lists/deselect-list)
                                        id])}])]

     [:div.lists-col.col-list
      [:div.list-detail
       (cond
         is-folder [:button.list-title.folder-title
                    {:type "button"
                     :on-click #(dispatch [(if is-expanded :lists/collapse-path :lists/expand-path) path])}
                    [icon (if is-expanded "folder-open-item" "folder-item")]
                    title]
         (= status "TO_UPGRADE") [poppable {:data "This list contains outdated identifiers. Use Upgrade list in the row actions to start the upgrade."
                                            :options {:class [:list-title :disabled]}
                                            :children title}]
         :else (into [:a.list-title
                      {:href (route/href ::route/results {:title title})}]
                     (italicize-species title)))
       (when is-new
         [poppable {:data "This list was just created by you."
                    :options {:class [:list-badge :list-badge-new]}
                    :children "New"}])
       (when-not is-folder
         (cond
           is-public
           [poppable {:data "This is a public list, visible to all users whether logged in or not. Users that do not own it can still make a copy or use it for set operations."
                      :options {:class [:list-badge]}
                      :children "Public"}]
           (and authorized logged-in?)
           [poppable {:data "This list is owned by you."
                      :options {:class [:list-badge]}
                      :children "Yours"}]))]
      (when (seq (str/trim (str description)))
        (into [:p.list-description {:title description}]
              (italicize-species description)))]

     [:div.lists-col.lists-meta
      [:div.lists-col.col-items
       (.toLocaleString size "en-US")]
      [:div.lists-col.col-type
       (when-not is-folder
         [list-type type-names type])]
      [:div.lists-col.col-date
       [readable-time timestamp]]]

     (when show-tags?
       [:div.lists-col.col-tags
        [list-tags tags]])

     [:div.lists-col.col-actions
      (when-not is-folder
        [:<>
         [:div.list-controls.list-controls-inline
          [list-row-controls item false]]
         [:div.list-controls-kebab.dropdown
          [:button.list-action.dropdown-toggle
           {:type "button"
            :title "List actions"
            :aria-label "List actions"
            :data-toggle "dropdown"}
           [icon "list-more"]]
          [:div.dropdown-menu.dropdown-menu-controls
           [:div.list-controls
            [list-row-controls item true]]]]])]]))

(defn lists []
  (let [filtered-lists @(subscribe [:lists/filtered-lists])
        all-selected? @(subscribe [:lists/all-selected?])
        new-hidden-lists @(subscribe [:lists/new-hidden-lists])
        show-tags? @(subscribe [:lists/show-tags?])]
    [:section.lists-table
     {:class (when-not show-tags? "lists-table--no-tags")}

     [:header.lists-row.lists-headers
      [:div.lists-col.col-check
       [:input {:type "checkbox"
                :aria-label "Select all lists"
                :checked all-selected?
                :on-change (if all-selected?
                             #(dispatch [:lists/clear-selected])
                             #(dispatch [:lists/select-all-lists]))}]]
      [:div.lists-col.col-list
       [sort-button :title "List"]]
      [:div.lists-col.lists-meta
       [:div.lists-col.col-items
        [sort-button :size "Items"]]
       [:div.lists-col.col-type
        [sort-button :type "Type"]]
       [:div.lists-col.col-date
        [sort-button :timestamp "Date"]]]
      (when show-tags?
        [:div.lists-col.col-tags
         [sort-button :tags "Tags"]])
      [:div.lists-col.col-actions]]

     (when (seq new-hidden-lists)
       (let [amount (count new-hidden-lists)
             plural? (> amount 1)]
         [:div.new-lists-note.agr-note
          (str "You have " amount " new list"
               (when plural? "s")
               " hidden by the current filters. ")
          [:button.link-button
           {:type "button"
            :on-click #(dispatch [:lists/show-new-lists])}
           "Clear filters"]]))

     (for [{:keys [id] :as item} filtered-lists]
       ^{:key id}
       [list-row item show-tags?])]))

(defn no-lists []
  (let [no-lists? @(subscribe [:lists/no-lists?])
        no-filtered-lists? @(subscribe [:lists/no-filtered-lists?])
        is-empty (or no-lists? no-filtered-lists?)
        mine-name @(subscribe [:current-mine-human-name])]
    (when is-empty
      [:div.no-lists
       (cond
         no-lists? [:p.agr-empty (str mine-name " has no public lists available")]
         no-filtered-lists? [:p.agr-empty "No list matches active filters"])
       [:p.agr-note "You may have lists saved to your account. Login to access them."]
       (when-not no-lists?
         [:p [:a {:role "button"
                  :on-click #(dispatch [:lists/reset-filters])}
              "Click here"]
          " to clear all filters."])])))

(defn modal-list-row [item & {:keys [subop single?]}]
  (let [{:keys [id title timestamp type tags]} item]
    [:tr
     [:td.title (italicize-species title)]
     [:td [readable-time timestamp]]
     [:td
      [list-type @(subscribe [:lists/type-names]) type]]
     [:td
      [list-tags tags]]
     [:td
      (case subop
        :down [:button.btn.pull-right
               {:type "button"
                :on-click #(dispatch [:lists-modal/keep-list id])}
               [icon "move-down-list" 2]]
        :up   [:button.btn.pull-right
               {:type "button"
                :on-click #(dispatch [:lists-modal/subtract-list id])}
               [icon "move-up-list" 2]]
        nil)
      (when-not single?
        [:button.btn.pull-right
         {:type "button"
          :on-click #(dispatch [:lists/deselect-list id])}
         [icon "remove-list" 2]])]]))

(defn modal-table [items & {:keys [subop single?]}]
  [:table.table.table-hover
   [:thead
    [:tr
     [:th "Title"]
     [:th "Date"]
     [:th "Type"]
     [:th "Tags"]
     [:th]]] ; Empty header for row buttons.
   [:tbody
    (for [{:keys [id] :as item} items]
      ^{:key id}
      [modal-list-row item :subop subop :single? single?])]])

(defn modal-new-list [& {:keys [edit-list?]}]
  (let [all-tags @(subscribe [:lists/all-tags])
        new-list-title @(subscribe [:lists-modal/new-list-title])
        new-list-tags @(subscribe [:lists-modal/new-list-tags])
        new-list-description @(subscribe [:lists-modal/new-list-description])
        list-tags-support? @(subscribe [:list-tags-support?])
        logged-in? @(subscribe [::auth/authenticated?])]
    [:<>
     (when-not edit-list?
       [:p "New list"])
     [:div.list-title-tags
      [:div.title-input-container
       [:label {:for "modal-new-list-title"}
        "Title"]
       [:input.form-control
        {:type "text"
         :id "modal-new-list-title"
         :on-change #(dispatch [:lists-modal/set-new-list-title
                                (oget % :target :value)])
         :value new-list-title}]]
      [:div
       [:label {:for "modal-new-list-tags"}
        (str "Tags" (when-not edit-list? " (optional)"))]
       [select-tags/main
        :disabled-tooltip (cond
                            (not list-tags-support?) "This InterMine is running an older version which does not support adding tags"
                            (not logged-in?) "You need to login to edit tags")
        :disabled (or (not list-tags-support?) (not logged-in?))
        :id "modal-new-list-tags"
        :on-change #(dispatch [:lists-modal/set-new-list-tags %])
        :value new-list-tags
        :options all-tags]]]
     [:div.list-description
      [:label {:for "modal-new-list-description"}
       (str "Description" (when-not edit-list? " (optional)"))]
      [:textarea.form-control
       {:id "modal-new-list-description"
        :rows 2
        :on-change #(dispatch [:lists-modal/set-new-list-description
                               (oget % :target :value)])
        :value new-list-description}]]]))

(defn modal-set-operation []
  (let [active-modal @(subscribe [:lists/active-modal])
        different-types? @(subscribe [:lists/selected-lists-different-types?])]
    [:<>
     (when different-types?
       [:div.alert.alert-warning.extra-message
        [icon-comp "info" :enlarge 2]
        [:p "You are performing a set operation on lists of different types. This will create a new list of the common ancestor type, if one exists. Unless this is your intention, we recommend opening the lists and saving them again as the same type."]])

     (case active-modal
       (:combine :intersect :difference)
       [:div
        (case active-modal
          :combine [:p "The new list will contain " [:em "all items"] " from the following lists"]
          :intersect [:p "The new list will contain only " [:em "items common"] " to all the following lists"]
          :difference [:p "The new list will contain only " [:em "items unique"] " to each of the following lists"
                       (when-let [selected-lists (not-empty @(subscribe [:lists/selected-lists]))]
                         (when (> (count selected-lists) 2)
                           [:a.notice {:href "https://en.wikipedia.org/wiki/Symmetric_difference" :target "_blank"}
                            " (this will perform a mathematical symmetric difference, which means members of an odd amount of lists will be kept)"
                            [icon "external"]]))])
        [modal-table @(subscribe [:lists/selected-lists-details])]]

       (:subtract)
       [:div.subtract-container
        [:p "The items from these lists"]
        [:div.table-container
         [modal-table @(subscribe [:lists-modal/subtract-lists-details]) :subop :down]]
        [:p "will be removed from these lists to give the new list."]
        [:div.table-container
         [modal-table @(subscribe [:lists-modal/keep-lists-details]) :subop :up]]])

     [modal-new-list]]))

(defn valid-folder?
  "Whether a folder name is valid. Full stops and colons are excluded since
  `split-path` treats both as path separators."
  [s]
  (re-matches #"[A-Za-z0-9 \-]+" s))

(def invalid-folder-message
  "Folder names may only contain letters, numbers, spaces and hyphens.")

(defn modal-select-folder []
  (let [folder-path @(subscribe [:lists-modal/folder-path])
        folder-suggestions @(subscribe [:lists-modal/folder-suggestions])
        list-tags-support? @(subscribe [:list-tags-support?])
        logged-in? @(subscribe [::auth/authenticated?])
        disable-tags? (or (not list-tags-support?) (not logged-in?))
        select [:> js/Select.Creatable
                {:className "folder-selector"
                 :placeholder "Choose folder"
                 :isValidNewOption #(valid-folder? %1)
                 :formatCreateLabel #(str "Create new \"" % "\" folder")
                 :noOptionsMessage #(if ((some-fn empty? valid-folder?) (oget % :inputValue))
                                      "No existing folders"
                                      invalid-folder-message)
                 :onChange #(dispatch [:lists-modal/nest-folder (oget % :value)])
                 :value nil ; Required or else it will keep its own state.
                 :options (map (fn [v] {:value v :label v}) folder-suggestions)
                 :isDisabled disable-tags?
                 ;; The two lines below makes it use a React portal to attach the element to
                 ;; the document body. This means it won't disappear at modal-body edges,
                 ;; which are set to overflow:auto to facilitate scrolling.
                 :styles {:menuPortal (fn [base] (oset! base :zIndex 9999))}
                 :menuPortalTarget js/document.body}]]
    [:div.select-folder
     [icon "modal-folder" 2]
     [:span.folder-path (str/join " / " (conj folder-path ""))]
     (if disable-tags?
       [poppable {:data (cond
                          (not list-tags-support?) "This InterMine is running an older version which does not support creating folders"
                          (not logged-in?) "You need to login to create folders")
                  :children select}]
       select)
     [:button.btn.button-folder-up
      {:disabled (or (empty? folder-path) disable-tags?)
       :on-click #(dispatch [:lists-modal/denest-folder])}
      [icon "modal-folder-up" nil ["folder-up"]]]]))

(defn modal-other-operation []
  (let [active-modal @(subscribe [:lists/active-modal])
        selected-lists @(subscribe [:lists/selected-lists-details])
        target-list @(subscribe [:lists-modal/target-list])
        list-items (if target-list [target-list] selected-lists)]
    [:<>
     (case active-modal
       :delete
       [modal-table list-items :single? (boolean target-list)]
       :edit
       [:div
        [modal-new-list :edit-list? true]
        [:p "Current folder"]
        [modal-select-folder]]
       (:copy :move)
       [:div
        [:div.table-container
         [modal-table list-items :single? (boolean target-list)]]
        [:p (case active-modal
              :copy "Copy to folder"
              :move "Move to folder")]
        [modal-select-folder]])]))

(defn modal []
  (let [modal-open? @(subscribe [:lists/modal-open?])
        active-modal @(subscribe [:lists/active-modal])
        error-message @(subscribe [:lists-modal/error])
        list-tags-support? @(subscribe [:list-tags-support?])
        logged-in? @(subscribe [::auth/authenticated?])]
    [:<>
     [:div.fade.modal-backdrop
      {:class (when modal-open? :show)}]
     [:div.modal.fade.show
      {:class (when modal-open? :in)
       :tab-index "-1"
       :role "dialog"}
      [:div.modal-dialog.modal-lg
       [:div.modal-content
        [:div.modal-header
         [:button.close
          {:aria-hidden "true"
           :type "button"
           :on-click #(dispatch [:lists/close-modal])}
          "×"]
         [:h3.modal-title.text-center
          (case active-modal
            (:combine :intersect :difference :subtract)
            [:button.btn.btn-slim.change-set-operation
             (if-let [prev-set-op (find-set-op dec active-modal)]
               {:on-click #(dispatch [:lists/open-modal prev-set-op])}
               {:disabled true})
             [icon "chevron-left"]]
            [:span])
          (case active-modal
            (:combine :intersect :difference :subtract)
            [:span
             (get-in set-operations->assets [active-modal :text])
             (get-in set-operations->assets [active-modal :icon])]
            :delete "Delete list(s)"
            :edit "Edit list"
            :copy "Copy list(s)"
            :move "Move list(s)"
            nil)
          (case active-modal
            (:combine :intersect :difference :subtract)
            [:button.btn.btn-slim.change-set-operation
             (if-let [next-set-op (find-set-op inc active-modal)]
               {:on-click #(dispatch [:lists/open-modal next-set-op])}
               {:disabled true})
             [icon "chevron-right"]]
            [:span])]]

        [:div.modal-body
         (case active-modal
           (:combine :intersect :difference :subtract)
           [modal-set-operation]
           (:delete :edit :copy :move)
           [modal-other-operation]
           nil)

         (when (not-empty error-message)
           [:div.alert.alert-danger
            [:strong error-message]])]

        [:div.modal-footer
         [:div.btn-toolbar.pull-right
          [:button.btn.btn-default
           {:type "button"
            :on-click #(dispatch [:lists/close-modal])}
           "Cancel"]
          [:button.btn.btn-primary.btn-raised
           {:type "button"
            :on-click
            (case active-modal
              (:combine :intersect :difference :subtract)
              #(dispatch [:lists/set-operation active-modal])
              :delete
              #(dispatch [:lists/delete-lists])
              :edit
              #(dispatch [:lists/edit-list])
              :copy
              #(dispatch [:lists/copy-lists])
              :move
              #(dispatch [:lists/move-lists])
              #())}
           (case active-modal
             (:combine :intersect :difference :subtract) "Save new list"
             :delete "Delete list(s)"
             :edit "Save"
             :copy "Copy list(s)"
             :move "Move list(s)"
             nil)]]]]]]]))

(defn main []
  [:div.lists.agr-page
   [filter-lists]
   [:p.agr-note.lists-note "Select two or more lists to combine, intersect, subtract or compare them."]
   [upset/panel]
   [:div.lists-card
    [filter-band]
    [selection-bar]
    [lists]
    [no-lists]
    [list-footer]]
   [modal]])
