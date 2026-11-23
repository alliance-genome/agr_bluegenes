(ns bluegenes.pages.results.track-export
  "Track export for Gene lists and Gene results: BED or GFF3 of the gene
  locations with an optional flank, one file per organism. The file is built
  from tabular rows because the mine has no bed or gff3 exporter."
  (:require [re-frame.core :refer [reg-event-db reg-event-fx reg-fx reg-sub subscribe dispatch]]
            [clojure.string :as str]
            [oops.core :refer [oget]]
            [imcljs.fetch :as fetch]
            [bluegenes.mine-support :as mine-support]
            [bluegenes.pages.results.bundle :as bundle]))

(def max-flank 100000)

(def max-rows 100000)

(def organism-path "Gene.organism.shortName")

(def row-paths
  ["Gene.primaryIdentifier" "Gene.symbol" organism-path
   "Gene.chromosome.primaryIdentifier" "Gene.chromosomeLocation.start"
   "Gene.chromosomeLocation.end" "Gene.chromosomeLocation.strand"
   "Gene.chromosome.length"])

(def outer-joins ["Gene.chromosome" "Gene.chromosomeLocation"])

(def source-name "BlueGenes")

(def chrom-styles
  [["mine" "As in the mine"]
   ["ucsc" "UCSC (chr1, chrM)"]
   ["ensembl" "Ensembl (1, MT)"]])

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
  clamped at 1 and the end at the chromosome `length` when it is known."
  ([start end flank] (flank-span start end flank nil))
  ([start end flank length]
   (let [flank (clamp-flank flank)
         e (+ end flank)]
     [(max 1 (- start flank))
      (if (and length (>= length end)) (min e length) e)])))

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
  [[id symbol organism chromosome start end strand length]]
  (let [start (number-or-nil start)
        end (number-or-nil end)]
    (when (and (not (str/blank? chromosome)) start end)
      {:id id
       :symbol symbol
       :organism organism
       :chromosome chromosome
       :start start
       :end end
       :strand (strand-symbol strand)
       :length (number-or-nil length)})))

(defn- mito? [name]
  (contains? #{"m" "mt" "mtdna" "mitochondrion" "mitochondrial"}
             (str/lower-case (str/replace name #"^[Cc][Hh][Rr]" ""))))

(defn chrom-name
  "Chromosome name in the naming `style`: \"mine\" keeps it, \"ucsc\" has a
  lower case chr prefix and chrM, \"ensembl\" has no prefix and MT."
  [style name]
  (case style
    "ucsc" (cond
             (mito? name) "chrM"
             (re-find #"^[Cc][Hh][Rr]" name) (str/replace name #"^[Cc][Hh][Rr]" "chr")
             :else (str "chr" name))
    "ensembl" (if (mito? name) "MT" (str/replace name #"^[Cc][Hh][Rr]" ""))
    name))

(defn chrom-sort-key
  "Natural order: numbered chromosomes by number, then the others by name."
  [name]
  (let [[_ digits rest] (re-matches #"(\d*)(.*)" (str/replace name #"^[Cc][Hh][Rr]" ""))]
    [(if (str/blank? digits) 1 0)
     (if (str/blank? digits) 0 (js/parseInt digits 10))
     rest]))

(defn sort-genes
  "Genes by chromosome in natural order, then start and end."
  [genes]
  (sort-by (juxt (comp chrom-sort-key :chromosome) :start :end) genes))

(defn gene-label [{:keys [symbol id]}]
  (if (str/blank? symbol) id symbol))

(defn- clean-label
  "Assembly and track labels go into a quoted or space separated header, so
  quotes and whitespace runs are replaced."
  [label]
  (-> (or label "") (str/replace #"[\"\s]+" "_") (str/replace #"^_+|_+$" "")))

(defn bed-line
  "BED is 0-based and half-open, so the 1-based start is lowered by one."
  [flank {:keys [chromosome start end strand length] :as gene}]
  (let [[s e] (flank-span start end flank length)]
    (str/join "\t" [chromosome (dec s) e (str/replace (gene-label gene) #"\s+" "_") 0 strand])))

(defn bed-header [title assembly]
  (let [assembly (clean-label assembly)]
    (str "track name=\"" (clean-label title) "\" description=\"" (clean-label title)
         (when-not (str/blank? assembly) (str " " assembly))
         "\"" (when-not (str/blank? assembly) (str " db=" assembly)))))

(defn bed-file [{:keys [title assembly flank genes]}]
  (str (str/join "\n" (cons (bed-header title assembly)
                            (map #(bed-line flank %) genes)))
       "\n"))

(defn- attribute
  "GFF3 column 9 value with only the reserved characters percent-encoded."
  [v]
  (str/replace (or v "") #"[;=&,%\t\r\n]"
               #(str "%" (.padStart (.toString (.charCodeAt % 0) 16) 2 "0"))))

(defn gff3-line [flank {:keys [chromosome start end strand id symbol organism length] :as gene}]
  (let [[s e] (flank-span start end flank length)]
    (str/join "\t" [chromosome source-name "gene" s e "." strand "."
                    (str/join ";" (concat [(str "ID=" (attribute id))
                                           (str "Name=" (attribute (gene-label gene)))]
                                          (when-not (str/blank? symbol) [(str "Alias=" (attribute id))])
                                          [(str "Dbxref=" (attribute id))]
                                          (when-not (str/blank? organism)
                                            [(str "Note=" (attribute organism))])))])))

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

(defn parse-assemblies
  "Assembly labels from the text field: a bare label, or `organism=label`
  entries separated by semicolons."
  [text]
  (reduce (fn [acc part]
            (let [part (str/trim part)
                  [k v] (str/split part #"=" 2)]
              (cond
                (str/blank? part) acc
                (some? v) (assoc-in acc [:by-organism (str/trim k)] (str/trim v))
                :else (assoc acc :default part))))
          {:default nil :by-organism {}}
          (str/split (or text "") #";")))

(defn assembly-for
  "Label for one organism. A bare label is only used when a single organism is
  exported, because it names one genome."
  [{:keys [default by-organism]} organism multiple?]
  (or (get by-organism organism)
      (when-not multiple? default)))

(defn- safe-name [s]
  (str/replace (or s "") #"[^A-Za-z0-9._-]+" "_"))

(defn file-name
  "The organism is part of the name only when several files are written."
  [{:keys [label organism format flank multiple?]}]
  (str (safe-name (or label "genes"))
       (when multiple? (str "_" (safe-name organism)))
       (when (pos? flank) (str "_flank" flank))
       "." format))

(defn jbrowse-link
  "JBrowse location URL for a gene, or nil without a base URL."
  [base assembly flank {:keys [chromosome start end length]}]
  (when-not (str/blank? base)
    (let [[s e] (flank-span start end flank length)]
      (str base (if (str/includes? base "?") "&" "?")
           "loc=" (js/encodeURIComponent (str chromosome ":" s ".." e))
           (when-not (str/blank? assembly)
             (str "&assembly=" (js/encodeURIComponent assembly)))))))

(defn base-query
  "Query for the export rows of a list or of the Gene results. The location
  paths are outer joins so that genes without a location stay in the rows."
  [{:keys [kind name query]}]
  (let [q (if (= :list kind)
            {:from "Gene" :where [{:path "Gene" :op "IN" :value name}]}
            (select-keys query [:from :where :constraintLogic :joins]))]
    (-> q
        (assoc :from "Gene" :select row-paths)
        (update :joins #(vec (distinct (concat % outer-joins)))))))

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

(defn export-files
  "Track files, one per organism, with genes in chromosome order."
  [{:keys [format flank assemblies label]} genes]
  (let [groups (by-organism genes)
        multiple? (> (count groups) 1)
        parsed (parse-assemblies assemblies)]
    (vec (for [[organism org-genes] groups
               :let [assembly (assembly-for parsed organism multiple?)]]
           {:organism organism
            :assembly assembly
            :name (file-name {:label label :organism organism :format format
                              :flank flank :multiple? multiple?})
            :text (build-file format {:title (str label " " organism)
                                      :assembly assembly :flank flank
                                      :genes (sort-genes org-genes)})}))))

(defn export-outcome
  "Everything an export produces from the response rows and the options taken
  when the download started."
  [{:keys [chrom-style assemblies label] :as opts} rows]
  (let [truncated? (> (count rows) max-rows)
        rows (take max-rows rows)
        genes (->> rows
                   (keep row->gene)
                   (mapv #(update % :chromosome (partial chrom-name chrom-style))))
        skipped-ids (vec (keep (fn [row] (when-not (row->gene row) (first row))) rows))
        files (export-files opts genes)
        parsed (parse-assemblies assemblies)
        unlabelled (when (and (:default parsed) (> (count files) 1))
                     (count (remove :assembly files)))]
    {:genes (count genes)
     :files files
     :skipped-file (when (seq skipped-ids)
                     {:name (str (safe-name (or label "genes")) "_no_location.txt")
                      :text (str (str/join "\n" skipped-ids) "\n")})
     :links (vec (for [[organism org-genes] (by-organism genes)]
                   {:organism organism
                    :gene (first (sort-genes org-genes))
                    :assembly (assembly-for parsed organism (> (count files) 1))
                    :flank (:flank opts)}))
     :message (str (count genes) " genes in " (count files)
                   (if (= 1 (count files)) " file" " files")
                   (when (seq skipped-ids)
                     (str ", " (count skipped-ids) " without a location skipped"))
                   (when truncated?
                     (str ", cut at the first " max-rows " genes"))
                   (when (pos? (or unlabelled 0))
                     (str ". The assembly label names one genome, so it was not applied; use organism=label entries"))
                   ".")}))

;;; Events ;;;

(def state-path [:results :track-export])

(defn- service [db]
  (get-in db [:mines (:current-mine db) :service]))

(reg-event-db
 ::toggle
 (fn [db _]
   (if (get-in db (conj state-path :open?))
     (assoc-in db state-path nil)
     (assoc-in db state-path {:open? true :format "bed" :flank 0 :assembly ""
                              :chrom-style "mine"}))))

(reg-event-db
 ::set-field
 (fn [db [_ k v]]
   (if (get-in db (conj state-path :busy?))
     db
     (update-in db state-path assoc k v :error nil))))

(reg-fx
 ::save-files
 (fn [files]
   (doseq [{:keys [name text]} files]
     (bundle/save-blob! (js/Blob. #js [text] #js {:type "text/plain"}) name))))

(reg-event-fx
 ::download
 (fn [{db :db} [_ source]]
   (let [{:keys [busy? format flank assembly chrom-style]} (get-in db state-path)
         opts {:format format :flank (clamp-flank flank) :assemblies assembly
               :chrom-style chrom-style :label (:label source)}]
     (when-not busy?
       {:db (update-in db state-path assoc :busy? true :error nil :message nil
                       :files nil :skipped-file nil :links nil :flank (:flank opts))
        :im-chan {:chan (fetch/rows (service db) (base-query source)
                                    {:format "json" :size (inc max-rows)})
                  :on-success [::rows-success opts]
                  :on-failure [::failure]}}))))

(reg-event-fx
 ::rows-success
 (fn [{db :db} [_ opts res]]
   (let [{:keys [genes files skipped-file links message]} (export-outcome opts (:results res))]
     (if (zero? genes)
       {:db (update-in db state-path assoc :busy? false
                       :error "None of the genes has a chromosome location.")}
       (cond-> {:db (update-in db state-path assoc
                               :busy? false :message message
                               :files files :skipped-file skipped-file :links links)}
         (= 1 (count files)) (assoc ::save-files files))))))

(reg-event-fx
 ::save-file
 (fn [{db :db} [_ file-name]]
   (let [{:keys [files skipped-file]} (get-in db state-path)]
     {::save-files (filter #(= file-name (:name %)) (conj (vec files) skipped-file))})))

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
  (let [{:keys [format flank assembly chrom-style busy? error message files skipped-file links]}
        @(subscribe [::state])
        base @(subscribe [::jbrowse-url])]
    [:section.agr-section.track-export-panel {:id "track-export-panel"}
     [:h3.agr-section-title "Track export"]
     [:div.agr-filter-bar
      [:label "Format"
       [:select.form-control
        {:value format :disabled busy?
         :on-change #(dispatch [::set-field :format (oget % :target :value)])}
        [:option {:value "bed"} "BED"]
        [:option {:value "gff3"} "GFF3"]]]
      [:label "Flank (bp)"
       [:input.form-control
        {:type "number" :min 0 :max max-flank :step 100
         :value flank :disabled busy?
         :on-change #(dispatch [::set-field :flank (oget % :target :value)])}]]
      [:label "Chromosome names"
       [:select.form-control
        {:value chrom-style :disabled busy?
         :on-change #(dispatch [::set-field :chrom-style (oget % :target :value)])}
        (for [[k label] chrom-styles]
          ^{:key k} [:option {:value k} label])]]
      [:label "Assembly label"
       [:input.form-control
        {:type "text" :placeholder "GRCh38, or H. sapiens=GRCh38; M. musculus=GRCm39"
         :value assembly :disabled busy?
         :on-change #(dispatch [::set-field :assembly (oget % :target :value)])}]]
      [:button.agr-btn-primary
       {:type "button" :disabled busy? :aria-busy (boolean busy?)
        :on-click #(dispatch [::download source])}
       (if busy? "Preparing" "Download")]]
     [:p.agr-note
      "Flanks are not cut at the chromosome end unless the mine stores the chromosome length."]
     (when error [:p.agr-error {:role "alert"} error])
     (when message [:p.agr-note {:role "status"} message])
     (when (> (count files) 1)
       [:ul.list-unstyled
        (for [{:keys [name]} files]
          ^{:key name}
          [:li [:button.agr-btn {:type "button" :on-click #(dispatch [::save-file name])}
                (str "Download " name)]])])
     (when skipped-file
       [:p.agr-note
        [:button.agr-btn {:type "button" :on-click #(dispatch [::save-file (:name skipped-file)])}
         "Download the genes without a location"]])
     (when (and (seq links) (not (str/blank? base)))
       [:ul.list-unstyled
        (for [{:keys [organism gene assembly flank]} links]
          ^{:key organism}
          [:li [:a {:href (jbrowse-link base assembly flank gene) :target "_blank" :rel "noopener"}
                (str "Open the first " organism " gene in JBrowse")]])])]))

(defn track-button
  "Toggle button and panel. Renders nothing unless the results are a Gene list
  or Gene results and the model has the location paths."
  []
  (when-let [source @(subscribe [::source])]
    [:div.track-export
     [:button.agr-btn
      {:type "button" :on-click #(dispatch [::toggle])
       :aria-expanded (boolean (:open? @(subscribe [::state])))
       :aria-controls "track-export-panel"}
      "Track export"]
     (when (:open? @(subscribe [::state]))
       [track-panel source])]))
