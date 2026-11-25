(ns bluegenes.components.ui.results_preview
  (:require [bluegenes.components.loader :refer [bar-loader]]
            [bluegenes.utils :refer [italicize-species]]
            [clojure.string :refer [split join]]))

(defn fmt-num
  "Group thousands in numbers; pass other values through."
  [n]
  (if (number? n)
    (.toLocaleString n "en-US")
    n))

(defn header-labels
  "Pairs of [full-path label]. The label is the last path segment, or the
  last two when another column ends in the same word."
  [headers]
  (let [tails (map #(last (split % " > ")) headers)
        dupes (set (for [[t n] (frequencies tails) :when (> n 1)] t))]
    (map (fn [h t]
           [h (join " > " (take-last (if (contains? dupes t) 2 1) (split h " > ")))])
         headers tails)))

(defn table-header [full label]
  [:th {:title full} label])

(defn table-row [row]
  (into [:tr]
        (map (fn [d]
               ;; No thousands separators: numeric IDs (taxon, PubMed) must stay as is.
               (let [s (str (:value d))]
                 (into [:td {:title s}] (italicize-species s))))
             row)))

(defn preview-table
  "Table of the first rows of a query's results.
  :query-results  The results map returned by the table-rows service"
  []
  (fn [& {:keys [query-results loading? hide-count?]}]
    (if loading?
      [:div.preview-loading [bar-loader]]
      (let [headers (:columnHeaders query-results)
            total (:iTotalRecords query-results)]
        [:<>
         [:table.table.small
          [:thead
           (into [:tr]
                 (map-indexed (fn [idx [full label]]
                                ^{:key idx} [table-header full label])
                              (header-labels headers)))]
          [:tbody
           (if (< total 1)
             [:tr
              [:td {:col-span (count headers)}
               [:h4 "Query returned no results"]]]
             (doall (map-indexed
                     (fn [idx r]
                       ^{:key idx} [table-row r])
                     (:results query-results))))]]
         (when (and (not hide-count?) (> total 5))
           [:div.preview-more
            (str "Showing " (count (:results query-results)) " of " (fmt-num total) " rows")])]))))
