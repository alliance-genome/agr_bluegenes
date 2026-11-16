(ns bluegenes.pages.reportpage.views
  (:require [re-frame.core :as re-frame :refer [subscribe dispatch]]
            [reagent.core :as r]
            [bluegenes.pages.reportpage.components.toc :as toc]
            [bluegenes.pages.reportpage.components.sidebar :as sidebar]
            [bluegenes.pages.reportpage.utils :as utils :refer [description-dropdown toggle-props chevron]]
            #_[bluegenes.components.table :as table]
            [bluegenes.components.lighttable :as lighttable]
            [bluegenes.components.loader :refer [loader mini-loader]]
            [bluegenes.components.tools.views :as tools]
            [bluegenes.pages.reportpage.events :as events]
            [bluegenes.pages.reportpage.subs :as subs]
            [bluegenes.pages.reportpage.other-mines :as other-mines]
            [bluegenes.pages.reportpage.alliance-summary :as alliance-summary]
            [bluegenes.components.cart :as cart]
            [im-tables.views.core :as im-table]
            [bluegenes.route :as route]
            [bluegenes.components.viz.views :as viz]
            [bluegenes.components.icons :refer [icon-comp]]
            [bluegenes.pages.regions.utils :refer [strand-cell]]
            [clojure.string :as str]
            [bluegenes.components.bootstrap :refer [poppable]]
            [bluegenes.utils :refer [encode-file]]
            [oops.core :refer [ocall oget]]
            [goog.functions :refer [debounce]]))

(defn tbl [{:keys [loc collapse]}]
  (let [data (subscribe [::subs/a-table loc])
        is-collapsed* (r/atom collapse)]
    (r/create-class
     {:component-did-mount (fn [this]
                             (let [{:keys [loc] :as props} (r/props this)]
                               (when-not @is-collapsed*
                                 (dispatch [:im-tables/load loc (dissoc props :loc)]))))
      :reagent-render (fn [{:keys [loc title id description] :as props}]
                        ;; result-count will be `nil` if query hasn't been loaded.
                        (let [result-count (get-in @data [:response :iTotalRecords])]
                          [:div.report-item
                           {:class [(when (or @is-collapsed* (zero? result-count))
                                      :report-item-collapsed)
                                    (when (zero? result-count)
                                      :report-item-no-results)]
                            :id id}
                           [:h4.report-item-heading
                            (toggle-props
                             (fn []
                               ;; Run query if it hasn't been run due to being collapsed.
                               (when (and (nil? result-count) @is-collapsed*)
                                 (dispatch [:im-tables/load loc (dissoc props :loc)]))
                               (swap! is-collapsed* not))
                             (not @is-collapsed*))
                            [:span.report-item-title
                             title
                             (when result-count
                               [:span.agr-badge.report-item-count result-count])
                             (when description [description-dropdown description])]
                            (when ((some-fn nil? pos?) result-count)
                              [chevron @is-collapsed*])]
                           (cond
                             @is-collapsed* nil
                             (zero? result-count) nil
                             :else [:div
                                    [im-table/main loc]])]))})))

(defn ->report-table-settings [current-mine-name]
  {:pagination {:limit 5}
   :compact true
   :links {:vocab {:mine (name (or current-mine-name ""))}
           :url (fn [{:keys [mine class objectId] :as vocab}]
                  (route/href ::route/report
                              {:mine mine
                               :type class
                               :id objectId}))}})

(defn tool-report [{:keys [collapse id description] tool-cljs-name :value}]
  (let [tool-details @(subscribe [::subs/a-tool tool-cljs-name])
        ;; The line below relies on the fact that a report page is always one entity.
        ;; If there could be multiple, we'd have to use `utils/suitable-entities`.
        entity @(subscribe [:bluegenes.components.tools.subs/entities])]
    [tools/tool (assoc tool-details :entity entity)
     :collapse collapse
     :id id
     :description description]))

(defn template-report [{:keys [id collapse description] template-name :value}]
  (let [summary-fields @(subscribe [:current-summary-fields])
        service (:service @(subscribe [:current-mine]))
        current-mine-name @(subscribe [:current-mine-name])
        {:keys [title] :as template} @(subscribe [::subs/a-template template-name])]
    [tbl {:loc [:report :im-tables id]
          :service (merge service {:summary-fields summary-fields})
          :title title
          :collapse collapse
          :description description
          :query template
          :settings (->report-table-settings current-mine-name)
          :id id}]))

(defn class-report [{:keys [id collapse description] nom :value}]
  (let [{object-type :type object-id :id} @(subscribe [:panel-params])
        summary-fields @(subscribe [:current-summary-fields])
        service (:service @(subscribe [:current-mine]))
        current-mine-name @(subscribe [:current-mine-name])
        {:keys [displayName] :as ref+coll} @(subscribe [::subs/a-ref+coll nom])]
    [tbl {:loc [:report :im-tables id]
          :service (merge service {:summary-fields summary-fields})
          :title displayName
          :collapse collapse
          :description description
          :query (utils/->query-ref+coll summary-fields object-type object-id ref+coll)
          :settings (->report-table-settings current-mine-name)
          :id id}]))

(defn section []
  (let [collapsed* (r/atom false)]
    (fn [{:keys [title id]} & children]
      (into [:section.report-table.agr-section {:id id}
             [:h3.report-table-heading.agr-section-title
              title
              [:button.btn.btn-link.pull-right.collapse-table
               {:on-click #(swap! collapsed* not)
                :aria-expanded (not @collapsed*)
                :aria-label (str (if @collapsed* "Expand " "Collapse ") title)}
               [icon-comp "chevron-up"
                :classes [(when @collapsed* "collapsed")]]]]]
            (when-not @collapsed* children)))))

(defn report []
  (let [{:keys [rootClass]} @(subscribe [::subs/report-summary])
        categories @(subscribe [:current-mine/report-layout rootClass])
        filter-text @(subscribe [::subs/report-filter-text])]
    [:div
     (doall
      (for [{:keys [category id children]} categories
            ;; This might seem heavy, but most of the signal graph is already
            ;; cached due to `:current-mine/report-layout` subscribing to the
            ;; fallback layout.  What this does is make sure report item is
            ;; "available" for this class (mostly to avoid showing parts of the
            ;; default layout that doesn't apply to this class).
            :let [children (filter (fn [{:keys [type value] :as child}]
                                     (and (contains? (case type
                                                       "class"    @(subscribe [::subs/ref+coll-for-class? rootClass])
                                                       "template" @(subscribe [::subs/template-for-class? rootClass])
                                                       "tool"     @(subscribe [::subs/tool-for-class? rootClass]))
                                                     value)
                                          (if (not-empty filter-text)
                                            (let [label (toc/parse-item-name child)]
                                              (str/includes? (str/lower-case label) (str/lower-case filter-text)))
                                            true)))
                                   children)]
            :when (seq children)] ; No point having a section without children.
        ^{:key id}
        [section
         {:title category
          :id id}
         [:div
          (doall
           (for [{:keys [_label _value type _collapse _description id] :as child} children
                 :let [report-comp (case type
                                     "class"    class-report
                                     "template" template-report
                                     "tool"     tool-report)]]
             ^{:key id}
             [report-comp child]))]]))]))

(defn other-mines-status [{:keys [status message]}]
  (case status
    :found nil
    :not-found [:span.text-muted "not found"]
    :error [poppable {:data message :children [:span.text-danger "error"]}]
    [mini-loader "tiny"]))

(defn other-mines-panel []
  (let [{:keys [loading? rows unavailable skipped orthologs-reason]} @(subscribe [::other-mines/panel])]
    (when (or loading? (seq rows) (seq unavailable) (seq skipped) orthologs-reason)
      [section
       {:title "In other Alliance mines"
        :id "other-alliance-mines"}
       (cond
         loading? [mini-loader "tiny"]
         :else
         [:table.agr-table.agr-table-sm.other-alliance-mines
          [:thead
           [:tr [:th "Species"] [:th "Symbol"] [:th "Mine"]]]
          [:tbody
           (for [{:keys [gene mine-kw mine-name self? id] :as row} rows
                 :let [nom (some gene [:symbol :primaryIdentifier])]]
             ^{:key (str mine-kw "/" (:primaryIdentifier gene))}
             [:tr
              [:td (:shortName gene)]
              [:td nom (when self? [:span.text-muted " (this gene)"])]
              [:td (if (= :found (:status row))
                     [:a {:href (route/href ::route/report {:mine mine-kw
                                                            :type "Gene"
                                                            :id id})}
                      (str (or (:symbol row) nom) " in " mine-name)]
                     [:span mine-name " " [other-mines-status row]])]])]])
       (when (seq unavailable)
         [:p.agr-note.other-alliance-mines-unavailable
          "Unavailable: " (str/join ", " unavailable)])
       (when (seq skipped)
         [:p.agr-note.other-alliance-mines-skipped
          "Skipped. " (str/join ". " (map :reason skipped)) "."])
       (when orthologs-reason
         [:p.agr-note.other-alliance-mines-orthologs
          "Orthologs not listed. " orthologs-reason "."])])))

(defn summary-location [[label value]]
  [:<>
   [:dt label]
   [:dd
    [:span.report-table-link
     {:on-click #(dispatch [::events/open-in-region-search value])}
     [poppable {:data "Perform a search of this region"
                :children value}]]]])

(defn fasta-download []
  (let [id           (subscribe [::subs/fasta-identifier])
        fasta        (subscribe [::subs/fasta])
        download-ref (atom nil)
        download!    #(let [el @download-ref
                            url (encode-file @fasta "fasta")]
                        (ocall el :setAttribute "href" url)
                        (ocall el :setAttribute "download" (str @id ".fasta"))
                        (ocall el :click)
                        (ocall js/window.URL :revokeObjectURL url))]
    (fn []
      [:<>
       [:a.hidden-download {:download "download" :ref (fn [el] (reset! download-ref el))}]
       [:a.fasta-download {:role "button" :on-click download!}
        [icon-comp "download"]
        "FASTA"]])))

(defn summary-fasta [[label value]]
  (let [fasta @(subscribe [::subs/fasta])]
    [:<>
     [:dt label]
     (case fasta
       :fasta/fetch
       [:dd.fasta-value
        [mini-loader "tiny"]]

       :fasta/none
       [:dd.agr-na "Not available"]

       :fasta/long
       (let [{:keys [mine type id]} @(subscribe [:panel-params])]
         [:dd.fasta-value
          [:a.fasta-download
           {:role "button"
            :on-click #(dispatch [:fetch-fasta (keyword mine) type id])}
           [icon-comp "my-data"]
           "Load FASTA"]])

       ;; In this branch, fasta will be a string containing the fasta.
       [:dd.fasta-value
        [:span.dropdown
         [:a.dropdown-toggle.fasta-button
          {:data-toggle "dropdown" :role "button"}
          [poppable {:data "Show sequence"
                     :children [:span value [icon-comp "caret-down"]]}]]
         [:div.dropdown-menu.fasta-dropdown
          [:form ; Top secret technique to avoid closing the dropdown when clicking inside.
           [:pre.fasta-sequence fasta]]]]
        [fasta-download]])]))

(defn anchor-if-url [x ?limit]
  (let [limited (cond-> (str x)
                  ?limit (-> (subs 0 ?limit)
                             (str "...")))]
    (if (string? x)
      (let [s (str/trim x)]
        (if (re-matches #"https?://[^\s]*" s)
          [:a {:href s :target "_blank"}
           limited]
          limited))
      limited)))

(let [limit 200]
  (defn summary-cell []
    (let [show-more* (r/atom false)]
      (fn [cell]
        (let [value (second cell)
              missing? (or (nil? value) (and (string? value) (str/blank? value)))
              too-long? (< limit (-> value str count))
              cell-header (-> cell first (str/split " > ") last)
              ?limit (when (and too-long? (not @show-more*)) limit)]
          [:<>
           [:dt cell-header]
           (if missing?
             [:dd.agr-na "Not available"]
             [:dd
              (anchor-if-url value ?limit)
              (when too-long?
                [:button.btn.btn-link.show-more-button
                 {:on-click #(swap! show-more* not)}
                 (if @show-more* "Show less" "Show more")])])])))))

(defn alliance-summary-row [label value]
  [:<>
   [:dt label]
   [:dd value]])

(defn alliance-summary-block []
  (let [{:keys [status curie description synonyms gene-type message]}
        @(subscribe [::alliance-summary/block])]
    (case status
      :loading [:div.alliance-summary [mini-loader "tiny"]]
      :error [:p.agr-note.alliance-summary
              (str "Alliance summary unavailable (" message ").")]
      :done [:div.alliance-summary
             [:dl.agr-attrs
              (when description
                [alliance-summary-row "Alliance summary" description])
              (when (seq synonyms)
                [alliance-summary-row "Alliance synonyms" (str/join ", " synonyms)])
              (when gene-type
                [alliance-summary-row "Gene type" gene-type])]
             [:p.agr-note
              alliance-summary/attribution ": "
              [:a {:href (alliance-summary/gene-url curie)
                   :target "_blank"
                   :rel "noopener noreferrer"}
               (str curie " at alliancegenome.org")]]]
      nil)))

(defn summary []
  (let [{:keys [columnHeaders results]} @(subscribe [::subs/report-summary])
        fasta               @(subscribe [::subs/fasta])
        chromosome-location @(subscribe [::subs/chromosome-location])
        fasta-length        @(subscribe [::subs/fasta-length])
        strand              @(subscribe [::subs/strand])
        entries (concat (sort-by key (filter val (zipmap columnHeaders (first results))))
                        (when (not-empty chromosome-location)
                          [^{:type :location} ["Chromosome Location" chromosome-location]])
                        (when strand
                          [["Strand" (strand-cell strand)]])
                        (when fasta
                          [^{:type :fasta} ["Sequence Length" fasta-length]]))]
    [section
     {:title utils/pre-section-title
      :id utils/pre-section-id}
     (into [:dl.agr-attrs.report-attrs]
           (for [cell entries]
             (case (-> cell meta :type)
               :location [summary-location cell]
               :fasta [summary-fasta cell]
               [summary-cell cell])))
     [alliance-summary-block]
     [:div.hidden-lg.sidebar-collapsed
      [sidebar/main]]]))

(defn filter-input []
  (let [input (r/atom @(subscribe [::subs/report-filter-text]))
        debounced (debounce #(dispatch [::events/set-filter-text %]) 500)
        on-change (fn [e]
                    (let [value (oget e :target :value)]
                      (reset! input value)
                      (debounced value)))]
    (fn []
      [:div.report-page-filter
       [poppable {:data "This will search for keywords in the section titles, use the browser search to find text anywhere in the page."
                  :children [icon-comp "info"]}]
       [:input.form-control
        {:type "text"
         :placeholder "Topic filter"
         :on-change on-change
         :value @input}]])))

(defn- summary-value
  "First non-blank value in the summary row whose view path is `path`."
  [{:keys [views results]} path]
  (let [v (get (zipmap views (first results)) path)]
    (when-not (str/blank? (str v)) v)))

(defn heading []
  (let [{:keys [rootClass] :as summary} @(subscribe [::subs/report-summary])
        title @(subscribe [::subs/report-title])
        species (or (summary-value summary (str rootClass ".organism.shortName"))
                    (summary-value summary (str rootClass ".organism.name")))
        primary-id (summary-value summary (str rootClass ".primaryIdentifier"))]
    [:header.report-header
     [:div.report-header-main
      [:p.report-class-label rootClass]
      [:h1.report-page-heading title]
      (when species
        [:p.report-species species])
      (when (and primary-id (not= primary-id title))
        [:p.report-primary-id primary-id])]
     [:div.report-header-actions
      [cart/add-button]]]))

(defn invalid-object []
  (let [{error-type :type ?message :message} @(subscribe [::subs/report-error])]
    [:div.row
     [:div.col-xs-8.col-xs-offset-2
      [:div.well.well-lg.invalid-object-container
       [:h2 (case error-type
              :not-found "Object not found"
              :ws-failure "Failed to retrieve object")]
       [:p (case error-type
             :not-found "It may have existed before and been assigned a new ID after a database rebuild. If you remember one of its identifiers, you can search for it. You can also see if any lists contain it. Please export a permanent URL next time you want to keep a link to an object."
             :ws-failure "This may be due to a network error, invalid URL or server issues. Please verify that the URL is correct and try again later.")]
       (when-let [msg (not-empty ?message)]
         [:pre msg])
       [:a.btn.btn-primary.btn-lg
        {:href (route/href ::route/home)}
        "Go to homepage"]]]]))

(defn main []
  (let [fetching-report? @(subscribe [:fetching-report?])
        error @(subscribe [::subs/report-error])
        params @(subscribe [:panel-params])]
    [:div.container-fluid.report-page
     (cond
       fetching-report? [loader (str (:type params) " Report")]
       error [invalid-object]
       :else [:<>
              [:div.row.report-row
               [:div.col-sm-3.col-md-2.report-nav
                [filter-input]
                [toc/main]]
               [:div.col-sm-9.col-md-10.col-lg-8
                [heading]
                [summary]
                [report]
                [other-mines-panel]]
               [:div.col-lg-2.visible-lg-block.sidebar-container
                [sidebar/main]]]])]))
