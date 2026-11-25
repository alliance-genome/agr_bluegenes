(ns bluegenes.pages.home.events
  (:require [re-frame.core :refer [reg-event-db reg-event-fx reg-fx]]
            [re-frame.std-interceptors :refer [path]]
            [imcljs.save :as im-save]
            [imcljs.fetch :as fetch]
            [clojure.string :as str]
            [goog.style :as gstyle]
            [goog.dom :as gdom]))

(def root [:home])

(reg-event-db
 :home/clear
 (path root)
 (fn [home [_]]
   (dissoc home :feedback-response)))

(reg-event-db
 :home/select-template-category
 (path root)
 (fn [home [_ category]]
   (assoc home :active-template-category category)))

;; Templates of configured mines with :home-templates, for their home page
;; tabs. Fetched once per mine; a failed fetch stores {} so the tab stays hidden.
(reg-event-fx
 :home/fetch-mine-templates
 (fn [{db :db} _]
   {:dispatch-n (for [[mine-kw {:keys [home-templates service]}] (get-in db [:env :mines])
                      :when (and home-templates
                                 (not= mine-kw (:current-mine db))
                                 (not (contains? (get-in db [:home :mine-templates]) mine-kw)))]
                  [:home/fetch-templates-for-mine mine-kw service])}))

(reg-event-fx
 :home/fetch-templates-for-mine
 (fn [_ [_ mine-kw service]]
   {:im-chan {:chan (fetch/templates service)
              :on-success [:home/store-mine-templates mine-kw]
              :on-failure [:home/store-mine-templates mine-kw {}]}}))

(reg-event-db
 :home/store-mine-templates
 (path root)
 (fn [home [_ mine-kw templates]]
   (assoc-in home [:mine-templates mine-kw] (or templates {}))))

(reg-event-db
 :home/select-mine-neighbourhood
 (path root)
 (fn [home [_ neighbourhood]]
   (assoc home :active-mine-neighbourhood neighbourhood)))

(reg-event-db
 :home/select-preview-mine
 (path root)
 (fn [home [_ mine-ns]]
   (assoc home :active-preview-mine mine-ns)))

(reg-event-fx
 :home/query-data-sources
 (fn [{db :db} [_]]
   {:dispatch [:results/history+
               {:source (:current-mine db)
                :type :query
                :intent :predefined
                :value {:from "DataSet"
                        :select ["DataSet.name"
                                 "DataSet.url"
                                 "DataSet.dataSource.name"
                                 "DataSet.publication.title"]
                        :constraintLogic nil
                        :where []
                        :sortOrder []
                        :joins ["DataSet.dataSource" "DataSet.publication"]
                        :title "All data sources"}}]}))
