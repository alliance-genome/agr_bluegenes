(ns bluegenes.pages.results.linkout
  "Send the gene symbols of a Gene list or Gene results to g:Profiler, Enrichr
  or STRING, download them as a GMT file, or copy them. Symbols are sent, not
  the CURIE identifiers, because the three services match on symbols. The
  builders below are pure; the events and the panel at the end do the I/O."
  (:require [clojure.string :as str]
            [re-frame.core :refer [reg-event-db reg-event-fx reg-fx reg-sub subscribe dispatch]]
            [oops.core :refer [oget ocall]]
            [imcljs.fetch :as fetch]))

(def max-genes
  "Matches the cap of the bundle download."
  5000)

(def max-link-length
  "Longest GET link offered. Longer ones are refused by common servers."
  8000)

(def gene-paths ["Gene.primaryIdentifier" "Gene.symbol" "Gene.organism.shortName"])

(def species
  [{:label "H. sapiens" :taxon "9606" :gprofiler "hsapiens" :names #{"h. sapiens" "homo sapiens"}}
   {:label "M. musculus" :taxon "10090" :gprofiler "mmusculus" :names #{"m. musculus" "mus musculus"}}
   {:label "R. norvegicus" :taxon "10116" :gprofiler "rnorvegicus" :names #{"r. norvegicus" "rattus norvegicus"}}
   {:label "D. rerio" :taxon "7955" :gprofiler "drerio" :names #{"d. rerio" "danio rerio"}}
   {:label "D. melanogaster" :taxon "7227" :gprofiler "dmelanogaster" :names #{"d. melanogaster" "drosophila melanogaster"}}
   {:label "C. elegans" :taxon "6239" :gprofiler "celegans" :names #{"c. elegans" "caenorhabditis elegans"}}
   {:label "S. cerevisiae" :taxon "4932" :gprofiler "scerevisiae" :names #{"s. cerevisiae" "saccharomyces cerevisiae"}}])

(def services
  {:gprofiler {:label "g:Profiler" :host "biit.cs.ut.ee" :needs-species? true}
   :enrichr {:label "Enrichr" :host "maayanlab.cloud" :needs-species? false}
   :string {:label "STRING" :host "string-db.org" :needs-species? true}})

;;; Pure builders ;;;

(defn species-of
  "Species entry for an organism short name or full name, or nil."
  [organism]
  (let [k (str/lower-case (str/trim (str organism)))]
    (some #(when ((:names %) k) %) species)))

(defn genes-query
  "PathQuery that reads the genes of a list (`{:list name}`) or of the Gene
  results query (`{:query q}`). One more than the cap is requested by the
  caller to tell a full result from a truncated one."
  [{:keys [list query]}]
  (if list
    {:from "Gene"
     :select gene-paths
     :where [{:path "Gene" :op "IN" :value list}]}
    (-> query
        (select-keys [:from :where :constraintLogic])
        (assoc :select gene-paths))))

(defn parse-rows
  "Rows of `gene-paths` as maps. Blank values become nil."
  [rows]
  (mapv (fn [[id symbol organism]]
          (let [clean #(when-not (str/blank? (str %)) (str/trim (str %)))]
            {:id (clean id) :symbol (clean symbol) :organism (clean organism)}))
        rows))

(defn organisms
  "Organisms of the genes, most frequent first."
  [genes]
  (->> genes (keep :organism) frequencies (sort-by (juxt (comp - val) key)) (mapv key)))

(defn genes-for
  "Genes of `organism`, or all genes when it is nil."
  [genes organism]
  (if organism (filterv #(= organism (:organism %)) genes) genes))

(defn symbols
  "Distinct non-blank symbols in order of appearance."
  [genes]
  (vec (distinct (keep :symbol genes))))

(defn without-symbol-count [genes]
  (count (remove :symbol genes)))

(defn too-many? [n]
  (> n max-genes))

(defn gprofiler-url
  "g:Profiler gost link for the symbols of one species."
  [{:keys [gprofiler]} syms]
  (str "https://biit.cs.ut.ee/gprofiler/gost?organism=" gprofiler
       "&query=" (str/join "+" (map js/encodeURIComponent syms))))

(defn string-url
  "STRING network link for the symbols of one species, by NCBI taxon id."
  [{:keys [taxon]} syms]
  (str "https://string-db.org/cgi/network?species=" taxon
       "&identifiers=" (str/join "%0d" (map js/encodeURIComponent syms))))

(defn link-too-long? [url]
  (> (count url) max-link-length))

(defn enrichr-form
  "Form post of the Enrichr list: one symbol per line and a description."
  [syms description]
  {:action "https://maayanlab.cloud/Enrichr/enrich"
   :fields {"list" (str/join "\n" syms)
            "description" description}})

(defn- one-line [s]
  (str/trim (str/replace (str s) #"\s+" " ")))

(defn gmt-description
  "Description column: the title or name of the source, the mine and counts."
  [{:keys [title mine gene-count organism]}]
  (one-line (str title " from " mine ", " gene-count " genes"
                 (when organism (str ", " organism)))))

(defn gmt-text
  "One GMT line: set name, description, then the symbols, tab separated."
  [set-name description syms]
  (str (str/join "\t" (concat [(one-line set-name) (one-line description)] syms)) "\n"))

(defn gmt-file-name [set-name]
  (str (str/replace (or (not-empty (one-line set-name)) "genes") #"[^A-Za-z0-9._-]+" "_") ".gmt"))

(defn organism-notice
  "Warning text when the genes span more than one organism, else nil."
  [organism-list]
  (when (> (count organism-list) 1)
    (str "These genes span " (count organism-list) " organisms (" (str/join ", " organism-list)
         "). g:Profiler and STRING take one species, so choose one organism for them.")))

(defn third-party-notice
  "Confirmation text before gene symbols leave BlueGenes."
  [service-key n]
  (let [{:keys [label host]} (get services service-key)]
    (str "This sends " n " gene symbols to " label " (" host "), a third party outside the Alliance. Continue?")))

(defn action-state
  "Whether a service button is enabled and why not. `species` is the species
  entry of the selected organism, nil when none is selected or it is unknown."
  [service-key species-entry syms]
  (let [{:keys [needs-species?]} (get services service-key)
        url (case service-key
              :gprofiler (when species-entry (gprofiler-url species-entry syms))
              :string (when species-entry (string-url species-entry syms))
              nil)]
    (cond
      (empty? syms) {:enabled? false :reason "No gene symbols."}
      (and needs-species? (nil? species-entry))
      {:enabled? false :reason "Choose one of the seven Alliance species."}
      (and url (link-too-long? url))
      {:enabled? false :reason "Too many genes for a link. Download the GMT file instead."}
      :else {:enabled? true})))

;;; Events ;;;

(defn- state-path [& ks]
  (into [:results :linkout] ks))

(defn- service [db]
  (get-in db [:mines (:current-mine db) :service]))

(defn- mine-label [db]
  (or (get-in db [:env :mines (:current-mine db) :name])
      (get-in db [:mines (:current-mine db) :name])
      (name (:current-mine db))))

(defn source-title [source]
  (or (:list source) (get-in source [:query :title]) "Gene results"))

(reg-fx
 ::open-url
 (fn [url]
   (ocall js/window :open url "_blank" "noopener")))

(reg-fx
 ::post-form
 (fn [{:keys [action fields]}]
   (let [form (ocall js/document :createElement "form")]
     (doto form
       (.setAttribute "method" "post")
       (.setAttribute "action" action)
       (.setAttribute "enctype" "multipart/form-data")
       (.setAttribute "target" "_blank"))
     (doseq [[k v] fields]
       (let [input (ocall js/document :createElement "input")]
         (doto input
           (.setAttribute "type" "hidden")
           (.setAttribute "name" k)
           (.setAttribute "value" v))
         (ocall form :appendChild input)))
     (ocall js/document.body :appendChild form)
     (ocall form :submit)
     (ocall js/document.body :removeChild form))))

(reg-fx
 ::save-text
 (fn [{:keys [text filename]}]
   (let [blob (js/Blob. #js [text] #js {:type "text/plain"})
         url (ocall js/URL :createObjectURL blob)
         a (ocall js/document :createElement "a")]
     (set! (.-href a) url)
     (set! (.-download a) filename)
     (ocall js/document.body :appendChild a)
     (ocall a :click)
     (ocall js/document.body :removeChild a)
     (js/setTimeout #(ocall js/URL :revokeObjectURL url) 10000))))

(reg-fx
 ::copy
 (fn [{:keys [text on-success on-failure]}]
   (-> (ocall js/navigator.clipboard :writeText text)
       (.then #(dispatch on-success))
       (.catch #(dispatch on-failure)))))

(reg-event-fx
 ::toggle
 (fn [{db :db} [_ source]]
   (if (= source (get-in db (state-path :source)))
     {:db (assoc-in db (state-path) nil)}
     {:db (assoc-in db (state-path) {:source source :loading? true})
      :im-chan {:chan (fetch/rows (service db) (genes-query source)
                                  {:format "json" :size (inc max-genes)})
                :on-success [::genes-success source]
                :on-failure [::genes-failure source]}})))

(reg-event-db
 ::genes-success
 (fn [db [_ source res]]
   (if (= source (get-in db (state-path :source)))
     (let [genes (parse-rows (:results res))
           orgs (organisms genes)]
       (update-in db (state-path) assoc
                  :loading? false
                  :genes genes
                  :organism (first orgs)))
     db)))

(reg-event-db
 ::genes-failure
 (fn [db [_ source]]
   (if (= source (get-in db (state-path :source)))
     (update-in db (state-path) assoc :loading? false :error "The genes could not be read.")
     db)))

(reg-event-db
 ::select-organism
 (fn [db [_ organism]]
   (update-in db (state-path) assoc :organism (not-empty organism) :confirm nil :notice nil)))

(reg-event-db
 ::ask
 (fn [db [_ service-key]]
   (update-in db (state-path) assoc :confirm service-key :notice nil)))

(reg-event-db
 ::cancel
 (fn [db _]
   (assoc-in db (state-path :confirm) nil)))

(defn- selection [db]
  (let [{:keys [genes organism source]} (get-in db (state-path))
        chosen (genes-for genes organism)]
    {:syms (symbols chosen)
     :species (species-of organism)
     :organism organism
     :title (source-title source)
     :mine (mine-label db)}))

(defn- description [{:keys [title mine syms organism]}]
  (gmt-description {:title title :mine mine :gene-count (count syms) :organism organism}))

(reg-event-fx
 ::send
 (fn [{db :db} [_ service-key]]
   (let [{:keys [syms species title] :as sel} (selection db)
         done (assoc-in db (state-path :confirm) nil)]
     (when (:enabled? (action-state service-key species syms))
       (case service-key
         :gprofiler {:db done ::open-url (gprofiler-url species syms)}
         :string {:db done ::open-url (string-url species syms)}
         :enrichr {:db done ::post-form (enrichr-form syms (str title ": " (description sel)))})))))

(reg-event-fx
 ::download-gmt
 (fn [{db :db} _]
   (let [{:keys [syms title] :as sel} (selection db)]
     (when (seq syms)
       {::save-text {:text (gmt-text title (description sel) syms)
                     :filename (gmt-file-name title)}}))))

(reg-event-fx
 ::copy-symbols
 (fn [{db :db} _]
   (let [{:keys [syms]} (selection db)]
     (when (seq syms)
       {::copy {:text (str/join "\n" syms)
                :on-success [::notice (str (count syms) " symbols copied.")]
                :on-failure [::notice "The browser refused to copy."]}}))))

(reg-event-db
 ::notice
 (fn [db [_ message]]
   (assoc-in db (state-path :notice) message)))

(reg-sub
 ::state
 (fn [db]
   (get-in db (state-path))))

;;; Views ;;;

(defn- service-button [service-key species-entry syms]
  (let [{:keys [enabled? reason]} (action-state service-key species-entry syms)]
    [:button.agr-btn
     {:type "button"
      :disabled (not enabled?)
      :title (or reason (str "Open " (get-in services [service-key :label])))
      :on-click #(dispatch [::ask service-key])}
     (get-in services [service-key :label])]))

(defn- organism-select [org-list organism]
  (when (seq org-list)
    [:label "Organism"
     [:select.form-control
      {:value (or organism "")
       :on-change #(dispatch [::select-organism (oget % :target :value)])}
      (when (> (count org-list) 1)
        [:option {:value ""} (str "All " (count org-list) " organisms")])
      (for [o org-list]
        ^{:key o} [:option {:value o} o])]]))

(defn- confirm-bar [service-key n]
  [:div.linkout-confirm
   [:p.agr-note (third-party-notice service-key n)]
   [:button.agr-btn-primary
    {:type "button" :on-click #(dispatch [::send service-key])}
    (str "Send to " (get-in services [service-key :label]))]
   [:button.agr-btn
    {:type "button" :on-click #(dispatch [::cancel])}
    "Cancel"]])

(defn- ready-panel [{:keys [genes organism confirm notice]}]
  (let [org-list (organisms genes)
        chosen (genes-for genes organism)
        syms (symbols chosen)
        species-entry (species-of organism)
        missing (without-symbol-count chosen)]
    [:div.linkout-ready
     (if (too-many? (count genes))
       [:p.agr-error (str "Sending is limited to " max-genes " genes.")]
       [:<>
        [:p (str (count syms) " gene symbols.")]
        (when-let [n (organism-notice org-list)]
          [:p.agr-note n])
        (when (pos? missing)
          [:p.agr-note (str missing " genes have no symbol and are left out.")])
        [:div.agr-filter-bar
         [organism-select org-list organism]
         (for [k [:gprofiler :enrichr :string]]
           ^{:key k} [service-button k species-entry syms])
         [:button.agr-btn
          {:type "button" :disabled (empty? syms) :on-click #(dispatch [::download-gmt])}
          "Download GMT"]
         [:button.agr-btn
          {:type "button" :disabled (empty? syms) :on-click #(dispatch [::copy-symbols])}
          "Copy symbols"]]
        (when confirm [confirm-bar confirm (count syms)])
        (when notice [:p.agr-note notice])])]))

(defn- panel [{:keys [loading? error] :as state}]
  [:section.agr-section.linkout-panel
   [:h3.agr-section-title "Send gene symbols to"]
   (cond
     loading? [:p "Reading genes"]
     error [:p.agr-error error]
     :else [ready-panel state])])

(defn send-button
  "Toggle button and panel. `source` is `{:list name}` or `{:query q}`."
  [source]
  (let [state @(subscribe [::state])
        open? (= source (:source state))]
    [:div.linkout
     [:button.agr-btn
      {:type "button" :on-click #(dispatch [::toggle source])}
      "Send to"]
     (when open? [panel state])]))
