(ns bluegenes.components.loader
  (:require [re-frame.core :refer [subscribe]]))

(defn bar-loader
  "The seven bars of the start-up loader."
  []
  [:div.bar-loader {:role "status" :aria-label "Loading"}
   (for [i (range 7)]
     ^{:key i} [:span.bar-loader-bar])])

(defn loader [whatever]
  [:div
   [:div.loading (str "LOADING " whatever)]
   [bar-loader]])

(defn mini-loader [size]
  [:div.mini-loader {:class size :role "status" :aria-label "Loading"}
   [:span.mini-loader-bar]
   [:span.mini-loader-bar]
   [:span.mini-loader-bar]
   [:span.mini-loader-bar]])

(defn mine-loader []
  (let [show? @(subscribe [:show-mine-loader?])
        {:keys [logo name]} @(subscribe [:current-mine])]
    (when show?
      [:div.mine-loader
       [:div.mine-loader-dialog
        (if (not-empty logo)
          [:img {:src logo}]
          [:svg.icon-2x.icon-intermine [:use {:xlinkHref "#icon-intermine"}]])
        [loader name]
        [:p "It's taking an unusual amount of time to load this mine."]
        [:p "Consider contacting the maintainers or switching to a different mine."]]])))
