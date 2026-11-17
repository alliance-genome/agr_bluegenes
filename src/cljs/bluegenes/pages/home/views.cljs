(ns bluegenes.pages.home.views
  (:require [re-frame.core :refer [subscribe dispatch]]
            [reagent.core :as r]
            [bluegenes.route :as route]
            [bluegenes.components.icons :refer [icon icon-comp]]
            [bluegenes.components.navbar.nav :refer [mine-icon mine-wordmark-src]]
            [bluegenes.components.search.typeahead :as search]
            [clojure.string :as str]
            [bluegenes.utils :refer [ascii-arrows ascii->svg-arrows md-paragraph md-element
                                     get-mine-ns get-mine-url]]
            [goog.string :as gstring]
            [cljs-time.format :as time-format]
            [cljs-time.coerce :as time-coerce]
            [oops.core :refer [oget]]
            [bluegenes.components.bootstrap :refer [poppable]]
            [bluegenes.config :refer [server-vars]]))

(defn mine-intro []
  (let [mine-name @(subscribe [:current-mine-human-name])
        wordmark (mine-wordmark-src @(subscribe [:current-mine])
                                    (:bluegenes-deploy-path @server-vars))
        description @(subscribe [:current-mine/description])
        notice @(subscribe [:current-mine/notice])
        release @(subscribe [:current-mine/release])]
    [:div.section.mine-intro
     [:div.mine-intro-body
      (when-not @(subscribe [:home/customisation :hideMineIntro])
        [:<>
         [:h1.mine-name
          (if wordmark
            [:img.mine-wordmark {:src wordmark :alt mine-name}]
            mine-name)]
         (when (not-empty release)
           [:div.mine-release
            [:span.agr-badge
             ;; Only prepend 'v' if release starts with a digit.
             (cond->> release
               (some->> release (re-find #"^\d")) (str "v"))]])
         [:div.mine-description
          (md-paragraph description)]])
      (when notice
        [:div.well.well-sm.well-warning.text-center
         [md-element notice]])
      (when-not @(subscribe [:home/customisation :hideSearch])
        [:div.search
         [search/main]
         [:div.search-info
          [icon "info"]
          [:span "Genes, proteins, pathways, ontology terms, authors, etc."]]])]]))

(defn template-queries []
  (let [categories @(subscribe [:templates-by-popularity/all-categories])
        current-category (or @(subscribe [:home/active-template-category])
                             (first categories))
        templates @(subscribe [:templates-by-popularity/category current-category])]
    [:div.section
     [:h2.agr-section-title "Go by Most Popular Queries"]
     [:div.template-preview
      [:ul.agr-tabs.template-tabs {:role "tablist"}
       (doall
        (for [category categories
              :let [selected? (= category current-category)]]
          ^{:key category}
          [:li {:class (when selected? "active")}
           [:button {:type "button"
                     :role "tab"
                     :aria-selected selected?
                     :on-click #(dispatch [:home/select-template-category category])}
            (str/replace category #"^im:aspect:" "")]]))]
      [:ul.template-list
       (doall
        (for [{:keys [title name]} templates]
          ^{:key name}
          [:li
           (into [:a {:href (route/href ::route/template {:template name})}]
                 (if (ascii-arrows title)
                   (ascii->svg-arrows title)
                   [[:span title]]))]))]
      [:a.more-queries {:href (route/href ::route/templates)}
       "More queries here"]]]))

(def post-time-formatter (time-format/formatter "MMMM d, Y"))

(defn latest-news []
  (let [posts (take 3 (or @(subscribe [:home/latest-posts]) nil))]
    (if (empty? posts)
      [:p "Latest news from the InterMine community."]
      (into [:ul.latest-news]
            (for [{:keys [title link pubDate description]} posts]
              [:li
               [:span (time-format/unparse post-time-formatter
                                           (time-coerce/from-string pubDate))]
               [:a {:href link :target "_blank"} title]
               [:p (-> description gstring/unescapeEntities str/trim (subs 0 100))]])))))

(defn convert-custom-cta
  "Convert the custom CTA format used in web.properties to the one used for rendering."
  [{:keys [label text]
    route-value :route dispatch-value :dispatch url-value :url}]
  {:label label
   :props (cond
            route-value {:href (route/href (keyword "bluegenes.route" route-value))}
            dispatch-value {:on-click #(dispatch [(keyword dispatch-value)])
                            :role "button"}
            url-value {:href url-value
                       :target "_blank"})
   :body (md-paragraph text)})

;; This MUST be a function, as otherwise `route/href` would get invoked when
;; the namespace is required, which depends on a subscription which might not
;; be registered in time, causing a crash.
(defn default-cta []
  [{:label "Analyse data"
    :props {:href (route/href ::route/upload)}
    :body [:p [:strong "Upload"] " your own sets of genes, proteins, transcripts or other data type to analyse against the integrated data."]}
   {:label "Browse sources"
    :props {:on-click #(dispatch [:home/query-data-sources])
            :role "button"}
    :body [:p "Browse the full set of data available including versions, publications and links to the " [:strong "original data"] "."]}
   {:label "Build your own query"
    :props {:href (route/href ::route/querybuilder)}
    :body [:p "The " [:strong "Query Builder"] " allows you to select and combine data classes, apply filters and configure the result table.  For a full set of pre-built searches, see the " [:a {:href (route/href ::route/templates)} "Templates"] "."]}
   {:label "Tutorials"
    :props {:href "http://intermine.org/intermine-user-docs/"
            :target "_blank"}
    :body [:p "Learn more about InterMine and how to search and analyse the data with a comprehensive set of " [:strong "written and video tutorials"] "."]}
   {:label "Web services"
    :props {:href "http://intermine.org/im-docs/docs/web-services/index"
            :target "_blank"}
    :body [:p "The " [:strong "InterMine API"] " has language bindings for Perl, Python, Ruby and Java, allowing you to easily run queries directly from scripts.  All queries available in the user interface can also be run through the API with results being returned in a number of formats."]}])

(defn call-to-action []
  (let [custom-cta @(subscribe [:home/custom-cta])
        cta (if (seq custom-cta)
              (map convert-custom-cta custom-cta)
              (default-cta))]
    (into [:div.section.cta-cards]
          (for [{:keys [label props body]} cta]
            [:div.cta-block
             [:a.cta-title props label]
             body]))))

(defn mine-selector-filter []
  (let [all-neighbourhoods @(subscribe [:home/all-registry-mine-neighbourhoods])
        current-neighbourhood (or @(subscribe [:home/active-mine-neighbourhood])
                                  (first all-neighbourhoods))]
    (into [:div.mine-neighbourhood-filter]
          (for [neighbourhood all-neighbourhoods]
            [:label
             [:input {:type "radio"
                      :name neighbourhood
                      :checked (= neighbourhood current-neighbourhood)
                      :on-change #(dispatch [:home/select-mine-neighbourhood neighbourhood])}]
             neighbourhood]))))

(defn short-description
  "Mine description with markdown links reduced to their text, or nil when empty."
  [description]
  (some-> description
          (str/replace #"\[([^\]]*)\]\([^)]*\)" "$1")
          str/trim
          not-empty))

(defn mine-selector-entry [[mine-key details] & {:keys [active?]}]
  (let [{:keys [name description]} details]
    [:button.mine-card
     {:type "button"
      :class (when active? "mine-card-active")
      :aria-pressed (boolean active?)
      :on-click #(dispatch [:home/select-preview-mine mine-key])}
     [mine-icon details :class "mine-card-logo"]
     [:span.mine-card-text
      [:span.mine-card-name (or name "default")]
      (when-let [desc (short-description description)]
        [:span.mine-card-desc desc])]]))

(defn mine-selector-preview []
  (let [{:keys [description name] :as preview-mine} @(subscribe [:home/preview-mine])
        mine-ns (get-mine-ns preview-mine)
        external? (or (:external? preview-mine)
                      (contains? @(subscribe [:registry-external]) mine-ns))]
    [:div.mine-preview
     [:div.preview-image
      [mine-icon preview-mine :class "img-responsive"]]
     [:h4 name]
     (md-paragraph description)
     (if external?
       [poppable
        {:data (if (:external? preview-mine)
                 "This mine has been configured to open in a new tab."
                 "This mine will open in a new tab as it's incompatible due to either running an InterMine API version below 27 or being only available through unsecured HTTP when BlueGenes is accessed through HTTPS.")
         :options {:data-placement "bottom"}
         :children [:a.agr-btn-primary.mine-preview-action
                    {:target "_blank"
                     :href (get-mine-url preview-mine)}
                    (str "Open " name)
                    [icon "external"]]}]
       [:button.agr-btn-primary.mine-preview-action
        {:type "button"
         :on-click (fn [_]
                     (dispatch [::route/navigate ::route/home {:mine mine-ns}])
                     (dispatch [:scroll-to-top]))}
        (str "Switch to " name)])]))

(defn mine-selector []
  (let [mines @(subscribe [:home/mines-by-neighbourhood])
        active-ns (get-mine-ns @(subscribe [:home/preview-mine]))]
    [:div.section
     [:h2.agr-section-title "InterMine for all"]
     [:div.mine-selector
      [mine-selector-filter]
      [:div.mine-selector-body
       [:div.mine-selector-entries
        (for [mine mines]
          ^{:key (key mine)}
          [mine-selector-entry mine :active? (= active-ns (key mine))])]
       [mine-selector-preview]]]]))

(def credits-intermine
  [{:text "The [InterMine](http://intermine.org/) integrated data warehouse has been developed principally through support of the [Wellcome Trust](https://wellcome.ac.uk/). Complementary projects have been funded by the [NIH/NHGRI](https://www.nih.gov/) and the [BBSRC](https://bbsrc.ukri.org/)."
    :image (str (:bluegenes-deploy-path @server-vars) "/images/intermine-logo.png")
    :url "http://intermine.org/"}
   {:text "The [BlueGenes](https://github.com/intermine/bluegenes) frontend for InterMine has been developed through the support of the [Wellcome Trust](https://wellcome.ac.uk/)."
    :image [icon-comp "bluegenes-logo-text"
            :style {:width 240 :height "auto"}]
    :url "http://intermine.org/"}])

(defn credits-fallback []
  (let [mine-name @(subscribe [:current-mine-human-name])
        current-mine @(subscribe [:current-mine-name])
        {:keys [maintainerUrl maintainerOrgName]}
        (get @(subscribe [:registry]) current-mine)]
    (when (not= maintainerOrgName "InterMine")
      [:h4.credits-fallback
       [:a {:href maintainerUrl
            :target "_blank"}
        (if (empty? maintainerOrgName)
          (str "The maintainers and funders of " mine-name)
          (str maintainerOrgName " and its funders"))]])))

(defn credits-entry [{:keys [text image url]}]
  [:div.credits-col
   [:div.credits-entry
    [:a {:href url
         :target "_blank"}
     (if (vector? image)
       image  ; For component images like icon-comp
       [:img.img-responsive {:src image}])]
    [md-element text]]])

(defn credits []
  (let [mine-name @(subscribe [:current-mine-human-name])
        entries @(subscribe [:current-mine/credits])
        all-entries (concat entries credits-intermine)]
    [:div.section.credits
     [:h2.agr-section-title (str mine-name " is made possible by")]
     (when (empty? entries)
       [credits-fallback])
     (into [:div.credits-list]
           (for [entry all-entries]
             [credits-entry entry]))]))

(defn main []
  [:div.container.home
   [mine-intro]
   (when-not @(subscribe [:home/customisation :hideTemplateQueries]) [template-queries])
   (when-not @(subscribe [:home/customisation :hideCTA]) [call-to-action])
   (when-not @(subscribe [:home/customisation :hideMineSelector]) [mine-selector])
   (when-not @(subscribe [:home/customisation :hideCredits]) [credits])])
