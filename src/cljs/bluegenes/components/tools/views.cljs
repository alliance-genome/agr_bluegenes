(ns bluegenes.components.tools.views
  (:require [re-frame.core :refer [subscribe dispatch]]
            [reagent.core :as reagent]
            [bluegenes.components.tools.subs :as subs]
            [bluegenes.components.tools.events :as events]
            [bluegenes.components.icons :refer [icon]]
            [bluegenes.components.bootstrap :refer [poppable]]
            [bluegenes.utils :refer [clean-tool-name]]
            [bluegenes.components.tools.utils :refer [above-threshold? group-tools]]
            [bluegenes.pages.reportpage.utils :refer [description-dropdown toggle-props chevron]]))

;; The following component may be used by itself to display one tool.
(defn tool [{{:keys [cljs]} :names :as tool-details} & {:keys [collapse id]}]

  ;; We don't have a nil state so we use an atom to check if the user has
  ;; overridden the layout-provided collapse value.
  (let [override-collapse* (reagent/atom nil)
        collapsed-tool? (subscribe [::subs/collapsed-tool? cljs])
        tool-id (cond->> cljs id (str id "-"))]
    ;; id is either a symbol, when this tool is on the report page;
    ;; or nil, when this tool is on the results page.

    (when-not (or collapse @collapsed-tool? (above-threshold? tool-details))
      (dispatch [::events/init-tool tool-details tool-id]))

    (fn [{{:keys [cljs human]} :names :as tool-details} & {:keys [collapse id description]}]
      (let [threshold-halted? (if @override-collapse* false (above-threshold? tool-details))
            collapsed? (or @collapsed-tool?
                           threshold-halted?
                           (and (not @override-collapse*)
                                collapse))
            description (or description (get-in tool-details [:config :description]))]
        [:div.report-item
         {:class (when collapsed? :report-item-collapsed)
          :id (or id (str tool-id "-container"))}
         [:h4.report-item-heading
          (toggle-props
           (fn []
                       ;; Only init the tool if it had been initially collapsed
                       ;; (and therefore not previously initialised).
             (when (and (or collapse @collapsed-tool? threshold-halted?)
                        (not @override-collapse*))
               (dispatch [::events/init-tool tool-details tool-id]))
             (when-not threshold-halted?
               (if collapsed?
                 (dispatch [::events/expand-tool cljs])
                 (dispatch [::events/collapse-tool cljs])))
             (reset! override-collapse* true))
           (not collapsed?))
          [:span.report-item-title
           (clean-tool-name human)
           (when (not-empty description)
             [description-dropdown description])
           [poppable {:data [:span "This is a visualization and may take longer to load. If you click to collapse, it will stay hidden on all pages until you expand it again."]
                      :children [icon "bar-chart"]}]]
          (when threshold-halted?
            [:span.report-item-threshold
             "Results exceed recommended amount for this tool - you can still load it by clicking this header"])
          [chevron collapsed?]]
         [:div.report-item-tool {:class (when collapsed? :hidden)}
          [:div {:class cljs
                 :id tool-id}]]]))))

(defn- group-heading [group collapsed?]
  [:h3.report-item-heading.tool-group-heading
   (toggle-props
    #(dispatch [(if collapsed? ::events/expand-group ::events/collapse-group) group])
    (not collapsed?))
   [:span.report-item-title group]
   [chevron collapsed?]])

(defn- tool-group [group tools]
  (let [collapsed? @(subscribe [::subs/collapsed-group? group])]
    [:div.tool-group
     [group-heading group collapsed?]
     (when-not collapsed?
       (for [tool-details tools]
         ^{:key (get-in tool-details [:names :cljs])}
         [tool tool-details]))]))

(defn main []
  (let [suitable-tools @(subscribe [::subs/suitable-tools])]
    [:div
     (for [[group tools] (group-tools suitable-tools)]
       ^{:key group}
       [tool-group group tools])]))
