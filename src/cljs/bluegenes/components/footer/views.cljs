(ns bluegenes.components.footer.views
  (:require [re-frame.core :refer [subscribe dispatch]]
            [bluegenes.version :as version]
            [clojure.string :as str]
            [bluegenes.config :refer [server-vars]]
            [bluegenes.components.bootstrap :refer [poppable]]
            [bluegenes.utils :refer [version-string->vec height-publisher]]
            [bluegenes.route :as route]))

(defn link [href label]
  [:a {:href href :target "_blank"} label])

(defn pretty-version [vstring]
  (->> vstring version-string->vec (str/join ".")))

(def ^:private agr "https://www.alliancegenome.org")

;; Link groups copied from the alliancegenome.org footer. A column holds
;; [heading links] groups, or [heading path] for a heading that is a link.
;; An :external link opens a new tab.
(def link-columns
  [[["Data and Tools"
     [["Downloads" "/downloads"]
      ["API" "/swagger-ui" :external]
      ["AllianceMine" "/bluegenes/alliancemine" :external]
      ["JBrowse 2" "/jbrowse2/" :external]
      ["Disease Portal" "/disease-portal"]
      ["Ontology Browser" "/ontology/disease"]
      ["SimpleMine" "/agr_simplemine.cgi" :external]
      ["Submit Data" "/submit-data"]
      ["Textpresso" "/textpresso"]
      ["BLAST Service" "/blastservice"]
      ["Tools" "/prototypes"]
      ["Pavi" "/pavi" :external]]]]
   [["Members"
     [["FlyBase" "/members/flybase"]
      ["MGD" "/members/mgd"]
      ["RGD" "/members/rgd"]
      ["SGD" "/members/sgd"]
      ["WormBase" "/members/wormbase"]
      ["Xenbase" "/members/xenbase"]
      ["ZFIN" "/members/zfin"]
      ["GOC" "/members/goc"]]]]
   [["News"
     [["News / Events" "/news"]
      ["Release Notes" "/release-notes"]
      ["Event Calendar" "/event-calendar"]]]
    ["About"
     [["About Us" "/about-us"]
      ["Funding" "/funding"]
      ["Publications" "/publications"]
      ["Organization" "/organization-and-governance"]
      ["Licensing, Privacy" "/privacy-warranty-licensing"]]]]
   [["Help"
     [["FAQ" "/faq"]
      ["Glossary" "/glossary"]
      ["Tutorials" "/tutorials"]
      ["User Docs" "/help"]]]
    ["Community"
     [["Alliance Users" "https://community.alliancegenome.org/categories" :external]
      ["Facebook" "https://www.facebook.com/AllianceOfGenomeResources" :external]
      ["Mastodon" "https://genomic.social/@AllianceGenome" :external]
      ["Bluesky" "https://bsky.app/profile/alliancegenome.bsky.social" :external]
      ["Github" "https://github.com/alliance-genome" :external]]]
    ["Contact Us" "/contact-us"]]
   [["Cite Us" "/cite-us"]]])

(defn- href [path]
  (if (str/starts-with? path "http") path (str agr path)))

(defn- link-group [[heading links]]
  (if (string? links)
    [:div.footer-group
     [:a.footer-heading {:href (href links)} heading]]
    [:div.footer-group
     [:span.footer-heading heading]
     (into [:ul]
           (for [[label path external?] links]
             [:li
              (if external?
                [:a.external {:href (href path) :target "_blank" :rel "noopener"} label]
                [:a {:href (href path)} label])]))]))

;; The query builder's fixed panel ends above the footer.
(defonce ^:private publish-footer-height! (height-publisher "--agr-footer-height"))

(defn main []
  (let [short-version     (nth (re-matches #"v?([0-9\.]+)(?:-.*)?" version/release) 1 "dev")
        ;; Note that the following versions can be nil when switching mines.
        intermine-version (some-> @(subscribe [:version]) pretty-version)
        api-version       @(subscribe [:api-version])
        release-version   (when-let [v @(subscribe [:release-version])]
                            (nth (re-find #"\"(.*)\"" v) 1 (str/trim v)))
        ;; The query builder fills the window above the footer, so it gets
        ;; only the version row.
        compact?          (= @(subscribe [:active-panel]) :querybuilder-panel)]
    [:footer.footer {:ref publish-footer-height!}
     (when-not compact?
       [:div.footer-main
        [:a.footer-logo {:href agr}
         [:img {:src (str (:bluegenes-deploy-path @server-vars) "/images/alliance-logo-light.png")
                :alt "Alliance of Genome Resources"}]]
        (into [:div.footer-columns]
              (for [column link-columns]
                (into [:div.footer-column]
                      (for [group column] [link-group group]))))])
     [:div.footer-base
      [:span.version
       "BlueGenes "
       [:span
        ;; Secret way to access developer page. Sshhhh.
        {:on-click #(dispatch [::route/navigate ::route/debug {:panel "main"}])}
        short-version]
       " powered by "
       [poppable {:data [:span (str "Version: " intermine-version)
                         [:br] (str "API: " api-version)
                         [:br] (str "Build: " release-version)]
                  :children [link "http://www.intermine.org" "InterMine"]}]]]]))
