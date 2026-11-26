(ns bluegenes.components.tools.views
  (:require [re-frame.core :refer [subscribe dispatch dispatch-sync]]
            [reagent.core :as reagent]
            [clojure.string :as str]
            [bluegenes.components.tools.subs :as subs]
            [bluegenes.components.tools.events :as events]
            [bluegenes.components.tools.effects :refer [run-destroy-hooks!]]
            [bluegenes.components.icons :refer [icon]]
            [bluegenes.components.bootstrap :refer [poppable]]
            [bluegenes.utils :refer [clean-tool-name]]
            [bluegenes.components.tools.utils :refer [threshold-halted? threshold-notice group-tools active-group]]
            [bluegenes.pages.reportpage.utils :refer [description-dropdown toggle-props chevron]]))

;; The following component may be used by itself to display one tool.
(defn tool [{{:keys [cljs]} :names :as tool-details} & {:keys [collapse id card]}]

  ;; We don't have a nil state so we use an atom to check if the user has
  ;; overridden the layout-provided collapse value.
  (let [override-collapse* (reagent/atom nil)
        collapsed-tool? (subscribe [::subs/collapsed-tool? cljs])
        overrides (subscribe [::subs/threshold-overrides])
        tool-id (cond->> cljs id (str id "-"))
        ;; React calls a ref with nil on unmount. The function must stay the
        ;; same between renders, or tools would be told to clean up on each one.
        unmounted (fn [el] (when (nil? el) (run-destroy-hooks! tool-id)))]
    ;; id is either a symbol, when this tool is on the report page;
    ;; or nil, when this tool is on the results page.

    (when-not (or collapse @collapsed-tool? (threshold-halted? @overrides tool-details))
      (dispatch [::events/init-tool tool-details tool-id]))

    (fn [{{:keys [cljs human]} :names :as tool-details} & {:keys [collapse id description card]}]
      (let [halted? (threshold-halted? @overrides tool-details)
            collapsed? (or @collapsed-tool?
                           halted?
                           (and (not @override-collapse*)
                                collapse))
            description (or description (get-in tool-details [:config :description]))
            run-anyway! (fn []
                          (dispatch [::events/override-threshold cljs (:entity tool-details)])
                          (reagent/after-render #(dispatch [::events/init-tool tool-details tool-id]))
                          (when @collapsed-tool?
                            (dispatch [::events/expand-tool cljs]))
                          (reset! override-collapse* true))]
        [:div.report-item
         {:class (when collapsed? :report-item-collapsed)
          :id (or id (str tool-id "-container"))}
         [:h4.report-item-heading
          (toggle-props
           (fn []
             (if halted?
               (run-anyway!)
               (let [stored-collapsed? @collapsed-tool?]
                 ;; Only init the tool if it had been initially collapsed
                 ;; (and therefore not previously initialised).
                 (if (and (or collapse stored-collapsed?)
                          (not @override-collapse*))
                   (do
                     ;; Store the expanded state synchronously, then init after
                     ;; render. Reagent has removed .hidden by then, so the
                     ;; tool measures a container with a width.
                     (when stored-collapsed?
                       (dispatch-sync [::events/expand-tool cljs]))
                     (reagent/after-render #(dispatch [::events/init-tool tool-details tool-id])))
                   (when collapsed?
                     (reagent/after-render #(.dispatchEvent js/window (js/Event. "resize")))))
                 (when-not (and stored-collapsed? (not @override-collapse*) collapsed?)
                   (dispatch [(if collapsed? ::events/expand-tool ::events/collapse-tool) cljs]))
                 (reset! override-collapse* true))))
           (not collapsed?))
          [:span.report-item-title
           (clean-tool-name human)
           (when (not-empty description)
             [description-dropdown description])
           [poppable {:data [:span (if card
                                     "This is a visualization and may take longer to load. It loads when you expand it."
                                     "This is a visualization and may take longer to load. If you click to collapse, it will stay hidden on all pages until you expand it again.")]
                      :children [icon "bar-chart"]}]]
          (when halted?
            [:span.report-item-threshold
             (str "Not started: " (threshold-notice tool-details) ". ")
             [:button.btn.btn-default.btn-xs
              {:type "button"
               :on-click (fn [e]
                           (.stopPropagation e)
                           (run-anyway!))}
              "Run anyway"]])
          [chevron collapsed?]]
         (when (and card collapsed? (not-empty description))
           [:p.report-item-summary description])
         [:div.report-item-tool {:class (when collapsed? :hidden)}
          [:div {:class cljs
                 :id tool-id
                 :ref unmounted}]]]))))

(defn- group-container-id [group]
  (str "tool-group-" (str/lower-case group)))

(defn- select-group! [group]
  (dispatch [::events/set-active-group group])
  (reagent/after-render #(.dispatchEvent js/window (js/Event. "resize"))))

(defn- arrow-nav
  "Key handler moving between group tabs with ArrowLeft and ArrowRight."
  [grouped group]
  (fn [e]
    (let [names (mapv first grouped)
          idx (.indexOf names group)
          step (case (.-key e) "ArrowLeft" -1 "ArrowRight" 1 nil)]
      (when step
        (.preventDefault e)
        (let [target (nth names (mod (+ idx step) (count names)))]
          (select-group! target)
          (reagent/after-render
           #(some-> (.getElementById js/document (str (group-container-id target) "-tab"))
                    .focus)))))))

(defn- tool-tabs [grouped active]
  (into [:ul.agr-tabs.tool-tabs {:role "tablist"}]
        (for [[group tools] grouped
              :let [on? (= group active)]]
          [:li {:class (when on? :active) :role "presentation"}
           [:button {:type "button"
                     :role "tab"
                     :id (str (group-container-id group) "-tab")
                     :aria-selected on?
                     :aria-controls (group-container-id group)
                     :tab-index (if on? 0 -1)
                     :on-click #(select-group! group)
                     :on-key-down (arrow-nav grouped group)}
            group [:span.agr-count (count tools)]]])))

(defn main []
  (let [suitable @(subscribe [::subs/suitable-tools])
        grouped (group-tools suitable)
        active (active-group @(subscribe [::subs/active-group]) grouped)]
    (when (seq grouped)
      [:section.results-tools
       [:div.tools-head
        [:h3.results-heading.agr-section-title "Tools"]
        [:span.agr-count (count suitable)]
        [:button.agr-btn.agr-btn-sm.tools-top
         {:type "button"
          :on-click #(.scrollTo js/window #js {:top 0 :behavior "smooth"})}
         "Top"]]
       [tool-tabs grouped active]
       (for [[group tools] grouped]
         ^{:key group}
         [:div.tool-grid {:id (group-container-id group)
                          :role "tabpanel"
                          :tab-index 0
                          :aria-labelledby (str (group-container-id group) "-tab")
                          :hidden (not= group active)}
          (for [t tools]
            ^{:key (get-in t [:names :cljs])}
            [tool t :collapse true :card true])])])))
