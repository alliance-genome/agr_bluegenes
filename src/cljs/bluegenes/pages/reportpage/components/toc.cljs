(ns bluegenes.pages.reportpage.components.toc
  (:require [re-frame.core :refer [subscribe dispatch]]
            [reagent.core :as reagent]
            [bluegenes.components.icons :refer [icon-comp]]
            [bluegenes.pages.reportpage.events :as events]
            [bluegenes.pages.reportpage.subs :as subs]
            [bluegenes.pages.reportpage.utils :as utils]
            [goog.dom :as gdom]
            [goog.fx.dom :as gfx]
            [goog.fx.easing :as geasing]
            [goog.style :as gstyle]
            [oops.core :refer [ocall oget]]
            [bluegenes.utils :refer [clean-tool-name highlight-substring]]
            [clojure.string :as str]))

(defn scroll-into-view! [id & [parent-id]]
  ;; If the table's parent section is collapsed, we scroll to the parent instead.
  (when-let [elem (or (nil? id) (gdom/getElement id) (gdom/getElement parent-id))]
    (let [current-scroll (clj->js ((juxt #(oget % :x) #(oget % :y))
                                   (gdom/getDocumentScroll)))
          target-scroll (if (nil? id)
                          #js [0 0] ; Scroll to top if no ID specified.
                          (clj->js ((juxt #(- (oget % :x) 60) #(- (oget % :y) 60))
                                    (gstyle/getRelativePosition elem (gdom/getDocumentScrollElement)))))]
      (doto (gfx/Scroll. (gdom/getDocumentScrollElement)
                         current-scroll
                         target-scroll
                         300
                         geasing/inAndOut)
        (.play)))))

(defn- link-props
  "Props that make a TOC link a keyboard-reachable button: focusable, and
  activated by Enter or Space as well as click."
  [on-activate active?]
  {:role "button"
   :tab-index 0
   :class (when active? :active)
   :on-click (fn [_] (on-activate))
   :on-key-down (fn [e]
                  (when (#{"Enter" " "} (oget e :key))
                    (ocall e :preventDefault)
                    (on-activate)))})

(defn parse-item-name [{:keys [type label value]}]
  (case type
    "class" (:displayName @(subscribe [::subs/a-ref+coll value]))
    "tool" (clean-tool-name label)
    label))

(defn main []
  (let [summary (subscribe [::subs/report-summary])
        {:keys [rootClass]} @summary
        categories (subscribe [:current-mine/report-layout rootClass])]
    ;; Usually we'd dispatch this in the route controller, but we really need
    ;; this subscription in this case.
    (dispatch [::events/start-scroll-handling @categories])

    (fn []
      (let [title @(subscribe [::subs/report-title])
            active-toc @(subscribe [::subs/report-active-toc])
            filter-text @(subscribe [::subs/report-filter-text])]
        [:<>
         [:div.toc-container {:role "navigation" :aria-label (str title " sections")}
          (into [:ul.toc]
                (doall
                 (for [{:keys [category children] parent-id :id}
                       (cons {:category utils/pre-section-title :id utils/pre-section-id} @categories)
                       :let [children (filter (fn [{:keys [type value] :as child}]
                                                (and (contains? (case type
                                                                  "class"    @(subscribe [::subs/ref+coll-for-class? rootClass])
                                                                  "template" @(subscribe [::subs/template-for-class? rootClass])
                                                                  "tool"     @(subscribe [::subs/tool-for-class? rootClass]))
                                                                value)
                                                     (if (not-empty filter-text)
                                                       (let [label (parse-item-name child)]
                                                         (str/includes? (str/lower-case label) (str/lower-case filter-text)))
                                                       true)))
                                              children)]
                       :when (or (= parent-id utils/pre-section-id)
                                 (seq children))]
                   [:<>
                    [:a (link-props #(scroll-into-view! (str parent-id))
                                    (= active-toc (str parent-id)))
                     [:li category]]
                    (when (and (seq children)
                               ;; Only show children if filter is active, or they or their parent is active.
                               (or (not-empty filter-text)
                                   (= active-toc (str parent-id))
                                   (some #{active-toc} (map (comp str :id) children))))
                      (into [:ul]
                            (for [{:keys [id] :as child} children
                                  ;; For the default layout, the label will be general for the model instead of the
                                  ;; specific ref/coll for this class (e.g.  Protein instead of Isoforms). For this
                                  ;; reason, we get the displayName from the ref/coll.
                                  :let [label (parse-item-name child)]]
                              [:a (link-props #(scroll-into-view! (str id) (str parent-id))
                                              (= active-toc (str id)))
                               (if (not-empty filter-text)
                                 (into [:li] (highlight-substring label filter-text))
                                 [:li label])])))])))]]))))
