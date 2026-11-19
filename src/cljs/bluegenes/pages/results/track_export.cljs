(ns bluegenes.pages.results.track-export
  "Track export for Gene lists and Gene results: BED or GFF3 of the gene
  locations with an optional flank, one file per organism. The mine's own
  bed/gff3 export is tried when no flank and no assembly label are asked for;
  otherwise, and whenever it fails, the file is built from tabular rows."
  (:require-macros [cljs.core.async.macros :refer [go]])
  (:require [cljs.core.async :refer [<!]]
            [re-frame.core :refer [reg-event-db reg-event-fx reg-fx reg-sub subscribe dispatch]]
            [clojure.string :as str]
            [oops.core :refer [oget]]
            [imcljs.fetch :as fetch]
            [bluegenes.mine-support :as mine-support]
            [bluegenes.pages.results.bundle :as bundle]))

(def max-flank 100000)

(def organism-path "Gene.organism.shortName")

(def row-paths
  ["Gene.primaryIdentifier" "Gene.symbol" organism-path
   "Gene.chromosome.primaryIdentifier" "Gene.chromosomeLocation.start"
   "Gene.chromosomeLocation.end" "Gene.chromosomeLocation.strand"])

(def source-name "BlueGenes")

;;; Pure helpers ;;;

(defn clamp-flank
  "Flank size as an integer from 0 to `max-flank`. Anything that is not a
  number gives 0."
  [value]
  (let [n (if (string? value) (js/parseInt value 10) value)]
    (if (and (number? n) (js/isFinite n))
      (-> n js/Math.floor (max 0) (min max-flank))
      0)))

(defn flank-span
  "1-based inclusive [start end] widened by `flank` on both sides. The start is
  clamped at 1."
  [start end flank]
  [(max 1 (- start flank)) (+ end flank)])

(defn strand-symbol
  "InterMine strands are 1, -1 and 0 (as numbers or strings)."
  [strand]
  (case (str strand)
    "1" "+"
    "-1" "-"
    "."))

(defn- number-or-nil [v]
  (let [n (if (string? v) (js/parseInt v 10) v)]
    (when (and (number? n) (js/isFinite n)) n)))

(defn row->gene
  "Gene map from a row in the order of `row-paths`, or nil when the gene has no
  chromosome or no start and end."
  [[id symbol organism chromosome start end strand]]
  (let [start (number-or-nil start)
        end (number-or-nil end)]
    (when (and (not (str/blank? chromosome)) start end)
      {:id id
       :symbol symbol
       :organism organism
       :chromosome chromosome
       :start start
       :end end
       :strand (strand-symbol strand)})))

(defn gene-label [{:keys [symbol id]}]
  (if (str/blank? symbol) id symbol))

(defn- clean-label
  "Assembly and track labels go into a quoted or space separated header, so
  quotes and whitespace runs are replaced."
  [label]
  (-> (or label "") (str/replace #"[\"\s]+" "_") (str/replace #"^_+|_+$" "")))

(defn bed-line
  "BED is 0-based and half-open, so the 1-based start is lowered by one."
  [flank {:keys [chromosome start end strand] :as gene}]
  (let [[s e] (flank-span start end flank)]
    (str/join "\t" [chromosome (dec s) e (gene-label gene) 0 strand])))

(defn bed-header [title assembly]
  (let [assembly (clean-label assembly)]
    (str "track name=\"" (clean-label title) "\" description=\"" (clean-label title)
         (when-not (str/blank? assembly) (str " " assembly))
         "\"" (when-not (str/blank? assembly) (str " db=" assembly)))))

(defn bed-file [{:keys [title assembly flank genes]}]
  (str (str/join "\n" (cons (bed-header title assembly)
                            (map #(bed-line flank %) genes)))
       "\n"))

(defn- attribute [v]
  (js/encodeURIComponent (or v "")))

(defn gff3-line [flank {:keys [chromosome start end strand id symbol] :as gene}]
  (let [[s e] (flank-span start end flank)]
    (str/join "\t" [chromosome source-name "gene" s e "." strand "."
                    (str "ID=" (attribute id) ";Name=" (attribute (gene-label gene))
                         (when-not (str/blank? symbol) (str ";Alias=" (attribute id))))])))

(defn gff3-file [{:keys [assembly flank genes]}]
  (let [assembly (clean-label assembly)]
    (str (str/join "\n" (concat ["##gff-version 3"]
                                (when-not (str/blank? assembly)
                                  [(str "##genome-build " source-name " " assembly)])
                                (map #(gff3-line flank %) genes)))
         "\n")))

(defn build-file [format opts]
  (if (= "gff3" format) (gff3-file opts) (bed-file opts)))

(defn by-organism
  "Genes grouped by organism, as a sorted map."
  [genes]
  (into (sorted-map) (group-by #(or (:organism %) "unknown") genes)))

(defn- safe-name [s]
  (str/replace (or s "") #"[^A-Za-z0-9._-]+" "_"))

(defn file-name
  "The organism is part of the name only when several files are written."
  [{:keys [label organism format flank multiple?]}]
  (str (safe-name (or label "genes"))
       (when multiple? (str "_" (safe-name organism)))
       (when (pos? flank) (str "_flank" flank))
       "." format))

(defn server-eligible?
  "The server formats carry no flank and no assembly label."
  [flank assembly]
  (and (zero? flank) (str/blank? assembly)))

(defn server-query
  "Query for the mine's bed/gff3 export of the genes of one organism."
  [base-query organism]
  (-> base-query
      (assoc :select ["Gene.primaryIdentifier"])
      (update :where (fnil conj []) {:path organism-path :op "=" :value organism})))

(defn usable-server-text
  "The server answer when it is a non-blank text, else nil."
  [res]
  (when (and (string? res) (not (str/blank? res))) res))

(defn jbrowse-link
  "JBrowse location URL for a gene, or nil without a base URL."
  [base assembly flank {:keys [chromosome start end]}]
  (when-not (str/blank? base)
    (let [[s e] (flank-span start end flank)]
      (str base (if (str/includes? base "?") "&" "?")
           "loc=" (js/encodeURIComponent (str chromosome ":" s ".." e))
           (when-not (str/blank? assembly)
             (str "&assembly=" (js/encodeURIComponent assembly)))))))

(defn base-query
  "Query for the export rows of a list or of the Gene results."
  [{:keys [kind name query]}]
  (if (= :list kind)
    {:from "Gene" :select row-paths :where [{:path "Gene" :op "IN" :value name}]}
    (-> (select-keys query [:from :where :constraintLogic :joins])
        (assoc :from "Gene" :select row-paths))))

(defn gene-root?
  "True when the query is on Gene, by its root class or its first column."
  [{:keys [from select]}]
  (= "Gene" (or from (first (str/split (str (first select)) #"\.")))))

(defn export-source
  "What to export: a Gene list, Gene results, or nil."
  [list query intent]
  (cond
    (and list (= "Gene" (:type list)))
    {:kind :list :name (:name list) :label (or (:title list) (:name list))}

    (and (not= :list intent) query (gene-root? query))
    {:kind :query :query query :label (or (:title query) "gene_results")}))

;;; Events ;;;

(def state-path [:results :track-export])

(defn- service [db]
  (get-in db [:mines (:current-mine db) :service]))

(reg-event-db
 ::toggle
 (fn [db _]
   (if (get-in db (conj state-path :open?))
     (assoc-in db state-path nil)
     (assoc-in db state-path {:open? true :format "bed" :flank 0 :assembly ""}))))

(reg-event-db
 ::set-field
 (fn [db [_ k v]]
   (update-in db state-path assoc k v :error nil)))

(defn- export-files
  "Files to save: one per organism, server text taken where available."
  [{:keys [format flank assembly label]} genes server-texts]
  (let [groups (by-organism genes)
        multiple? (> (count groups) 1)]
    (for [[organism org-genes] groups]
      {:name (file-name {:label label :organism organism :format format
                         :flank flank :multiple? multiple?})
       :text (or (get server-texts organism)
                 (build-file format {:title (str label " " organism)
                                     :assembly assembly :flank flank
                                     :genes org-genes}))})))

(reg-fx
 ::server-export
 (fn [{:keys [service query organisms format on-done]}]
   (go
     (let [texts (loop [[o & more] organisms acc {}]
                   (if-not o
                     acc
                     (let [res (<! (fetch/fetch-custom-format
                                    service (server-query query o) {:format format}))]
                       (recur more (if-let [t (usable-server-text res)] (assoc acc o t) acc)))))]
       (dispatch (conj on-done texts))))))

(reg-fx
 ::save-files
 (fn [files]
   (doseq [[i {:keys [name text]}] (map-indexed vector files)]
     (js/setTimeout
      #(bundle/save-blob! (js/Blob. #js [text] #js {:type "text/plain"}) name)
      (* i 400)))))

(reg-event-fx
 ::download
 (fn [{db :db} [_ source]]
   (let [{:keys [busy? flank]} (get-in db state-path)]
     (when-not busy?
       {:db (update-in db state-path assoc :busy? true :error nil :message nil :flank (clamp-flank flank))
        :im-chan {:chan (fetch/rows (service db) (base-query source)
                                    {:format "json" :size max-flank})
                  :on-success [::rows-success source]
                  :on-failure [::failure]}}))))

(defn- finish
  "Saves the files and records what was written."
  [db {:keys [label] :as opts} genes skipped texts]
  (let [files (export-files opts genes texts)]
    {:db (update-in db state-path assoc
                    :busy? false
                    :first-gene (first genes)
                    :message (str (count genes) " genes in " (count files)
                                  (if (= 1 (count files)) " file" " files")
                                  (when (pos? skipped) (str ", " skipped " without a location skipped"))
                                  "."))
     ::save-files files}))

(reg-event-fx
 ::rows-success
 (fn [{db :db} [_ source res]]
   (let [{:keys [format flank assembly]} (get-in db state-path)
         rows (:results res)
         genes (vec (keep row->gene rows))
         opts {:format format :flank flank :assembly assembly :label (:label source)}
         skipped (- (count rows) (count genes))]
     (cond
       (empty? genes)
       {:db (update-in db state-path assoc :busy? false
                       :error "None of the genes has a chromosome location.")}

       (server-eligible? flank assembly)
       {:db db
        ::server-export {:service (service db) :query (base-query source)
                         :organisms (keys (by-organism genes)) :format format
                         :on-done [::server-done opts genes skipped]}}

       :else (finish db opts genes skipped {})))))

(reg-event-fx
 ::server-done
 (fn [{db :db} [_ opts genes skipped texts]]
   (finish db opts genes skipped texts)))

(reg-event-db
 ::failure
 (fn [db [_ res]]
   (update-in db state-path assoc :busy? false
              :error (or (not-empty (get-in res [:body :error]))
                         "Could not read the gene locations. Please try again later."))))

;;; Subs and views ;;;

(reg-sub ::state (fn [db] (get-in db state-path)))

(reg-sub
 ::jbrowse-url
 (fn [db]
   (get-in db [:mines (:current-mine db) :jbrowse-url])))

(reg-sub
 ::source
 :<- [:results/current-list]
 :<- [:results/query]
 :<- [:results/intent]
 :<- [:model]
 (fn [[list query intent classes]]
   (when (empty? (mine-support/missing-paths classes row-paths))
     (export-source list query intent))))

(defn track-panel [source]
  (let [{:keys [format flank assembly busy? error message first-gene]} @(subscribe [::state])
        jbrowse (when first-gene
                  (jbrowse-link @(subscribe [::jbrowse-url]) assembly (clamp-flank flank) first-gene))]
    [:section.agr-section.track-export-panel
     [:h3.agr-section-title "Track export"]
     [:div.agr-filter-bar
      [:label "Format"
       [:select.form-control
        {:value format
         :on-change #(dispatch [::set-field :format (oget % :target :value)])}
        [:option {:value "bed"} "BED"]
        [:option {:value "gff3"} "GFF3"]]]
      [:label "Flank (bp)"
       [:input.form-control
        {:type "number" :min 0 :max max-flank :step 100
         :value flank
         :on-change #(dispatch [::set-field :flank (oget % :target :value)])}]]
      [:label "Assembly label"
       [:input.form-control
        {:type "text" :placeholder "e.g. GRCh38"
         :value assembly
         :on-change #(dispatch [::set-field :assembly (oget % :target :value)])}]]
      [:button.agr-btn-primary
       {:type "button" :disabled busy?
        :on-click #(dispatch [::download source])}
       (if busy? "Preparing" "Download")]]
     (when error [:p.agr-error error])
     (when message [:p.agr-note message])
     (when jbrowse
       [:p.agr-note [:a {:href jbrowse :target "_blank" :rel "noopener"} "Open the first gene in JBrowse"]])]))

(defn track-button
  "Toggle button and panel. Renders nothing unless the results are a Gene list
  or Gene results and the model has the location paths."
  []
  (when-let [source @(subscribe [::source])]
    [:div.track-export
     [:button.agr-btn
      {:type "button" :on-click #(dispatch [::toggle])}
      "Track export"]
     (when (:open? @(subscribe [::state]))
       [track-panel source])]))
