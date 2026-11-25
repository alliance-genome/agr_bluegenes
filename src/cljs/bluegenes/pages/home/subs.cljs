(ns bluegenes.pages.home.subs
  (:require [re-frame.core :refer [reg-sub subscribe]]
            [clojure.string :as str]
            [bluegenes.events.blog :refer [get-rss-from-db]]
            [bluegenes.utils :refer [parse-template-rank]]))

(defn mine-template-picks
  "Templates a configured mine shows on the home page: the named ones, in
  config order, or its 10 best ranked when :home-templates is true."
  [home-templates templates]
  (let [by-name (into {} (map (juxt :name identity)) (vals templates))]
    (if (sequential? home-templates)
      (keep by-name home-templates)
      (->> (vals templates)
           (sort-by (comp parse-template-rank :rank))
           (take 10)))))

(defn template-tabs
  "Tabs for the home page template panel, as {:id :label :mine :templates}.
  Order: the current mine's aspect tabs, then one tab per configured mine
  sorted by name, then aspect tabs named after a mine (e.g. YeastMine)."
  [category->templates mines current-mine mine-templates]
  (let [mine-names (set (map :name (vals mines)))
        aspect-labels (set (map #(str/replace (key %) #"^im:aspect:" "") category->templates))
        aspect-tab (fn [[category templates]]
                     {:id category
                      :label (str/replace category #"^im:aspect:" "")
                      :templates templates})
        aspect-tabs (map aspect-tab category->templates)
        mine-tabs (->> mines
                       (keep (fn [[mine-kw {mine-name :name :keys [home-templates external?] :as mine}]]
                               ;; An aspect tab named after the mine stands in for it.
                               (when-let [picks (and home-templates
                                                     (not= mine-kw current-mine)
                                                     (not (aspect-labels mine-name))
                                                     (seq (mine-template-picks
                                                           home-templates
                                                           (get mine-templates mine-kw))))]
                                 (cond-> {:id (str "mine:" (name mine-kw))
                                          :label mine-name
                                          :mine mine-kw
                                          :templates picks}
                                   external? (assoc :webapp-root (get-in mine [:service :root]))))))
                       (sort-by :label))]
    (vec (concat (remove (comp mine-names :label) aspect-tabs)
                 mine-tabs
                 (filter (comp mine-names :label) aspect-tabs)))))

(reg-sub
 :home/mine-templates
 (fn [db]
   (get-in db [:home :mine-templates])))

(reg-sub
 :home/template-tabs
 :<- [:templates-by-popularity]
 :<- [:env/mines]
 :<- [:current-mine-name]
 :<- [:home/mine-templates]
 (fn [[category->templates mines current-mine mine-templates]]
   (template-tabs category->templates mines current-mine mine-templates)))

(reg-sub
 :home/root
 (fn [db]
   (:home db)))

(reg-sub
 :home/feedback-response
 :<- [:home/root]
 (fn [home]
   (:feedback-response home)))

(reg-sub
 :home/active-template-category
 :<- [:home/root]
 (fn [home]
   (:active-template-category home)))

(reg-sub
 :home/active-mine-neighbourhood
 :<- [:home/root]
 (fn [home]
   (:active-mine-neighbourhood home)))

(reg-sub
 :home/all-registry-mine-neighbourhoods
 :<- [:registry]
 (fn [registry]
   (->> registry
        (mapcat (comp :neighbours val))
        (set)
        (sort)
        (cons "All"))))

(reg-sub
 :home/mines-by-neighbourhood
 :<- [:registry+configured-mines]
 :<- [:home/active-mine-neighbourhood]
 (fn [[mines active-neighbourhood]]
   (cond->> (sort-by #(or (-> % val :name)
                          (-> % key name str/capitalize))
                     mines)
     ((every-pred not-empty (partial not= "All")) active-neighbourhood)
     (filter #(contains? (-> % val :neighbours set) active-neighbourhood)))))

(reg-sub
 :home/active-preview-mine
 :<- [:home/root]
 (fn [home]
   (:active-preview-mine home)))

;; Note that a random preview mine from the active neighbourhood filter
;; will be returned if one hasn't been selected by the user. Think of this
;; like showcasing what's available.
(reg-sub
 :home/preview-mine
 :<- [:home/active-preview-mine]
 :<- [:registry+configured-mines]
 :<- [:home/mines-by-neighbourhood]
 (fn [[active-preview-mine mines sorted-mines]]
   (get mines active-preview-mine (-> sorted-mines rand-nth val))))

;; Be wary that this can return `false`, which many seq functions throw on.
(reg-sub
 :home/latest-posts
 (fn [db]
   (let [rss (get-rss-from-db db)]
     (get-in db [:cache :rss rss]))))

(reg-sub
 :home/customisations
 :<- [:current-mine/customisation]
 (fn [custom]
   (:homepage custom)))

(reg-sub
 :home/customisation
 :<- [:home/customisations]
 (fn [home [_ kw]]
   (get home kw)))

(reg-sub
 :home/custom-cta
 (fn [_]
   (subscribe [:home/customisation :cta]))
 (fn [cta]
   cta))
