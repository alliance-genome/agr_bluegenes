(ns bluegenes.pages.home.events
  (:require [re-frame.core :refer [reg-event-db reg-event-fx reg-fx]]
            [re-frame.std-interceptors :refer [path]]
            [imcljs.save :as im-save]
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
