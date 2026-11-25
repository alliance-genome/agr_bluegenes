(ns bluegenes.components.export-query
  (:require [re-frame.core :refer [subscribe dispatch]]
            [reagent.core :as reagent]
            [imcljs.query :as im-query]))

(def export-types
  ^{:doc "Supported export types as map with keys:
    label , format | endpoint , [update-query-fn] , [rdf-required]"}
  [{:label "TAB" :format "tab"}
   {:label "CSV" :format "csv"}
   {:label "GFF3" :endpoint "gff3"}
   {:label "BED" :endpoint "bed"}
   {:label "FASTA" :endpoint "fasta"}
    ;; Does not seem to be necessary for the use case of region search.
    ; :update-query-fn #(-> % (assoc :select ["id" "symbol" "organism.name"]) (dissoc :sortOrder :orderBy))}
   {:label "RDF" :format "rdf" :rdf-required true}
   {:label "N-Triples" :format "ntriples" :rdf-required true}])

(defn export-url
  "URL that downloads the results of query in the given export type."
  [query {:keys [format endpoint update-query-fn] :or {update-query-fn identity}}]
  (let [{:keys [root model token]} @(subscribe [:active-service])]
    (str root "/service/query/results" (when endpoint (str "/" endpoint))
         "?query=" (js/encodeURIComponent
                    (im-query/->xml model (update-query-fn query)))
         (when format (str "&format=" format))
         (when-not endpoint (str "&columnheaders=" "friendly"))
         "&token=" token)))

(defn export-button [query {:keys [label] :as export-type}]
  [:a.btn.btn-default.btn-raised.btn-xs
   {:href (export-url query export-type)}
   label])

(defn export-select
  "Compact export control: a format select and one download link."
  [query & {:keys [label]}]
  (let [selected (reagent/atom (:label (first export-types)))]
    (fn [query & {:keys [label]}]
      (let [rdf-support? @(subscribe [:rdf-support?])
            types (cond->> export-types (not rdf-support?) (remove :rdf-required))
            current (or (first (filter #(= @selected (:label %)) types)) (first types))]
        [:div.export-select
         (when label [:span.export-label label])
         (into [:select.form-control
                {:aria-label "Export format"
                 :value (:label current)
                 :on-change #(reset! selected (.. % -target -value))}]
               (map (fn [{l :label}] [:option {:key l :value l} l]) types))
         [:a.agr-btn.agr-btn-sm {:href (export-url query current)} "Download"]]))))

(defn main [query & {:keys [label]}]
  (let [rdf-support? @(subscribe [:rdf-support?])]
    (into [:div
           (when label [:label label])]
          (for [export-data (cond->> export-types
                              (not rdf-support?) (remove :rdf-required))]
            [export-button query export-data]))))
