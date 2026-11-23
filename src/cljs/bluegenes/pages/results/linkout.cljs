(ns bluegenes.pages.results.linkout
  "Send the gene symbols of a Gene list or Gene results to g:Profiler, Enrichr
  or STRING, download them as a GMT file, or copy them. Symbols are sent, not
  the CURIE identifiers, because the three services match on symbols. A gene
  without a symbol is sent by its systematic name. The
  builders below are pure; the events and the panel at the end do the I/O."
  (:require [clojure.string :as str]
            [reagent.core :as r]
            [re-frame.core :refer [reg-event-db reg-event-fx reg-fx reg-sub subscribe dispatch]]
            [oops.core :refer [oget ocall]]
            [imcljs.fetch :as fetch]))

(def max-genes
  "Most symbols sent to one third-party service."
  5000)

(def max-read
  "Most genes read from the mine for the GMT file and the copy button."
  50000)

(def max-link-length
  "Longest GET link offered. Longer ones are refused by common servers."
  8000)

(def gene-paths
  ["Gene.primaryIdentifier" "Gene.symbol" "Gene.secondaryIdentifier" "Gene.organism.shortName"])

(def species
  [{:label "H. sapiens" :taxon "9606" :gprofiler "hsapiens" :enrichr-host "Enrichr"
    :names #{"h. sapiens" "homo sapiens"}}
   {:label "M. musculus" :taxon "10090" :gprofiler "mmusculus" :enrichr-host "Enrichr"
    :names #{"m. musculus" "mus musculus"}}
   {:label "R. norvegicus" :taxon "10116" :gprofiler "rnorvegicus" :enrichr-host "Enrichr"
    :names #{"r. norvegicus" "rattus norvegicus"}}
   {:label "D. rerio" :taxon "7955" :gprofiler "drerio" :enrichr-host "FishEnrichr"
    :names #{"d. rerio" "danio rerio"}}
   {:label "D. melanogaster" :taxon "7227" :gprofiler "dmelanogaster" :enrichr-host "FlyEnrichr"
    :names #{"d. melanogaster" "drosophila melanogaster"}}
   {:label "C. elegans" :taxon "6239" :gprofiler "celegans" :enrichr-host "WormEnrichr"
    :names #{"c. elegans" "caenorhabditis elegans"}}
   {:label "S. cerevisiae" :taxon "4932" :gprofiler "scerevisiae" :enrichr-host "YeastEnrichr"
    :names #{"s. cerevisiae" "saccharomyces cerevisiae"}}
   {:label "S. pombe" :taxon "4896" :gprofiler "spombe"
    :names #{"s. pombe" "schizosaccharomyces pombe"}}
   {:label "X. tropicalis" :taxon "8364" :gprofiler "xtropicalis"
    :names #{"x. tropicalis" "xenopus tropicalis"}}])

(def services
  {:gprofiler {:label "g:Profiler" :host "biit.cs.ut.ee"}
   :enrichr {:label "Enrichr" :host "maayanlab.cloud"}
   :string {:label "STRING" :host "string-db.org"}})

;;; Pure builders ;;;

(defn species-of
  "Species entry for an organism short name or full name, or nil."
  [organism]
  (let [k (str/lower-case (str/trim (str organism)))]
    (some #(when ((:names %) k) %) species)))

(defn genes-query
  "PathQuery that reads the genes of a list (`{:list name}`) or of the Gene
  results query (`{:query q}`). One more than `max-read` is requested by the
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
  "Rows of `gene-paths` as maps. Blank values become nil. A symbol or systematic
  name that contains whitespace is not a usable gene name and becomes nil."
  [rows]
  (let [clean #(when-not (str/blank? (str %)) (str/trim (str %)))
        token #(when-let [v (clean %)] (when-not (re-find #"\s" v) v))]
    (mapv (fn [[id symbol secondary organism]]
            {:id (clean id)
             :symbol (token symbol)
             :secondary-id (token secondary)
             :organism (clean organism)})
          rows)))

(defn organisms
  "Organisms of the genes, most frequent first."
  [genes]
  (->> genes (keep :organism) frequencies (sort-by (juxt (comp - val) key)) (mapv key)))

(defn genes-for
  "Genes of `organism`, or all genes when it is nil."
  [genes organism]
  (if organism (filterv #(= organism (:organism %)) genes) genes))

(defn- gene-label [{:keys [symbol secondary-id]}]
  (or symbol secondary-id))

(defn symbols
  "Distinct gene names in order of appearance: the symbol, or the systematic
  name when a gene has no symbol."
  [genes]
  (vec (distinct (keep gene-label genes))))

(defn without-symbol-count
  "Genes with neither a symbol nor a systematic name."
  [genes]
  (count (remove gene-label genes)))

(defn systematic-count
  "Genes that are sent by systematic name because they have no symbol."
  [genes]
  (count (filter #(and (nil? (:symbol %)) (:secondary-id %)) genes)))

(defn too-many? [n]
  (> n max-genes))

(defn gprofiler-url
  "g:Profiler gost link for the symbols of one species."
  [{:keys [gprofiler]} syms]
  (str "https://biit.cs.ut.ee/gprofiler/gost?organism=" gprofiler
       "&query=" (str/join "+" (map js/encodeURIComponent syms))))

(defn gprofiler-capacity
  "About how many of these symbols fit in one g:Profiler link."
  [species-entry syms]
  (let [prefix (count (gprofiler-url species-entry []))
        per-symbol (/ (- (count (gprofiler-url species-entry syms)) prefix) (max 1 (count syms)))]
    (js/Math.floor (/ (- max-link-length prefix) per-symbol))))

(defn string-form
  "Form post of the STRING symbols of one species, by NCBI taxon id. A form has
  no link length limit."
  [{:keys [taxon]} syms]
  {:action "https://string-db.org/cgi/network"
   :fields {"species" taxon
            "identifiers" (str/join "\n" syms)}})

(defn link-too-long? [url]
  (> (count url) max-link-length))

(defn enrichr-form
  "Form post of the Enrichr list: one symbol per line and a description. The
  host is the Enrichr site of the species."
  [{:keys [enrichr-host]} syms description]
  {:action (str "https://maayanlab.cloud/" enrichr-host "/enrich")
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

(defn gmt-sets
  "GMT sets of the genes. One set for a selected organism. With no organism
  selected and several present, one set per organism named `title|organism`,
  because GSEA tools take one species per set."
  [{:keys [genes organism title mine]}]
  (let [orgs (organisms genes)
        per-org? (and (nil? organism) (> (count orgs) 1))
        groups (if per-org?
                 (map (fn [o] [o (genes-for genes o)]) orgs)
                 [[organism (genes-for genes organism)]])]
    (->> groups
         (map (fn [[o gs]]
                (let [syms (symbols gs)]
                  {:name (if per-org? (str title "|" o) title)
                   :description (gmt-description {:title title :mine mine
                                                  :gene-count (count syms) :organism o})
                   :syms syms})))
         (filterv (comp seq :syms)))))

(defn gmt-file-name
  ([set-name] (gmt-file-name set-name nil))
  ([set-name organism]
   (let [base (or (not-empty (one-line set-name)) "genes")
         full (if organism (str base " " (one-line organism)) base)]
     (str (str/replace full #"[^A-Za-z0-9._-]+" "_") ".gmt"))))

(defn organism-notice
  "Warning text when the genes span more than one organism, else nil."
  [organism-list]
  (when (> (count organism-list) 1)
    (str "These genes span " (count organism-list) " organisms (" (str/join ", " organism-list)
         "). g:Profiler, Enrichr and STRING take one species, so choose one organism for them.")))

(defn third-party-notice
  "Confirmation text before gene symbols leave BlueGenes. For Enrichr it also
  names the description that is sent with them."
  [service-key n {:keys [species description]}]
  (let [{:keys [label host]} (get services service-key)
        host (if (and (= :enrichr service-key) (:enrichr-host species))
               (str host "/" (:enrichr-host species))
               host)]
    (str "This sends " n " gene symbols to " label " (" host "), a third party outside the Alliance."
         (when (and (= :enrichr service-key) description)
           (str " The description \"" description "\" is sent with them."))
         " Continue?")))

(defn action-state
  "Whether a service button is enabled and why not. `species-entry` is the
  species entry of the selected organism, nil when none is selected or it is
  unknown. `organism` names the selection in the reason."
  ([service-key species-entry syms] (action-state service-key species-entry syms nil))
  ([service-key species-entry syms organism]
   (let [label (get-in services [service-key :label])
         supported? (case service-key
                      :enrichr (:enrichr-host species-entry)
                      species-entry)]
     (cond
       (empty? syms) {:enabled? false :reason "No gene symbols."}
       (nil? species-entry)
       {:enabled? false
        :reason (if organism
                  (str label " does not support " organism ".")
                  (str label " takes one organism. Choose one."))}
       (not supported?)
       {:enabled? false :reason (str label " does not support " (:label species-entry) ".")}
       (too-many? (count syms))
       {:enabled? false
        :reason (str "Sending is limited to " max-genes " symbols and this selection has "
                     (count syms) ". Download the GMT file instead.")}
       (and (= :gprofiler service-key) (link-too-long? (gprofiler-url species-entry syms)))
       {:enabled? false
        :reason (str "A g:Profiler link holds about " (gprofiler-capacity species-entry syms)
                     " of these symbols and this selection has " (count syms)
                     ". Use Enrichr or STRING, or download the GMT file.")}
       :else {:enabled? true}))))

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

(defn- copy-with-textarea
  "Copy through a hidden textarea and execCommand, for pages where
  navigator.clipboard does not exist. True when the browser copied."
  [text]
  (let [el (ocall js/document :createElement "textarea")]
    (set! (.-value el) text)
    (.setAttribute el "readonly" "")
    (set! (.. el -style -position) "fixed")
    (set! (.. el -style -opacity) "0")
    (ocall js/document.body :appendChild el)
    (try
      (.select el)
      (boolean (ocall js/document :execCommand "copy"))
      (catch :default _ false)
      (finally (ocall js/document.body :removeChild el)))))

(defn copy-text!
  "Copy `text` with `clipboard` (navigator.clipboard, nil on an http page), else
  through a textarea. Calls `on-success` or `on-failure` exactly once and never
  throws."
  [clipboard text on-success on-failure]
  (try
    (if (and clipboard (fn? (.-writeText clipboard)))
      (-> (.writeText clipboard text)
          (.then #(on-success))
          (.catch #(on-failure)))
      (if (copy-with-textarea text) (on-success) (on-failure)))
    (catch :default _ (on-failure))))

(reg-fx
 ::copy
 (fn [{:keys [text on-success on-failure]}]
   (copy-text! (.-clipboard js/navigator) text #(dispatch on-success) #(dispatch on-failure))))

(defn toggle-fx
  "Close the panel when `source` is open, else open it and read its genes."
  [db source]
  (if (= source (get-in db (state-path :source)))
    {:db (assoc-in db (state-path) nil)}
    {:db (assoc-in db (state-path) {:source source :loading? true})
     :im-chan {:chan (fetch/rows (service db) (genes-query source)
                                 {:format "json" :size (inc max-read)})
               :on-success [::genes-success source]
               :on-failure [::genes-failure source]}}))

(defn genes-loaded
  "State after the rows of `source` arrive. Rows past `max-read` are dropped and
  flagged. A result for a source that is no longer open is ignored."
  [db source res]
  (if (= source (get-in db (state-path :source)))
    (let [rows (:results res)
          genes (parse-rows (take max-read rows))
          orgs (organisms genes)]
      (update-in db (state-path) assoc
                 :loading? false
                 :genes genes
                 :truncated? (> (count rows) max-read)
                 :organism (first orgs)))
    db))

(reg-event-fx ::toggle (fn [{db :db} [_ source]] (toggle-fx db source)))

(reg-event-db ::genes-success (fn [db [_ source res]] (genes-loaded db source res)))

(reg-event-db
 ::genes-failure
 (fn [db [_ source]]
   (if (= source (get-in db (state-path :source)))
     (update-in db (state-path) assoc :loading? false :error "The genes could not be read.")
     db)))

(reg-event-db
 ::reset
 (fn [db _]
   (assoc-in db (state-path) nil)))

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
    {:genes genes
     :syms (symbols chosen)
     :species (species-of organism)
     :organism organism
     :title (source-title source)
     :mine (mine-label db)}))

(defn- description [{:keys [title mine syms organism]}]
  (gmt-description {:title title :mine mine :gene-count (count syms) :organism organism}))

(defn send-fx
  "Effects of sending the selection to `service-key`, nil when it is disabled."
  [db service-key]
  (let [{:keys [syms species organism] :as sel} (selection db)
        done (assoc-in db (state-path :confirm) nil)]
    (when (:enabled? (action-state service-key species syms organism))
      (case service-key
        :gprofiler {:db done ::open-url (gprofiler-url species syms)}
        :string {:db done ::post-form (string-form species syms)}
        :enrichr {:db done ::post-form (enrichr-form species syms (description sel))}))))

(reg-event-fx ::send (fn [{db :db} [_ service-key]] (send-fx db service-key)))

(defn gmt-fx
  "Save-file effect of the GMT download, nil when there is nothing to save."
  [db]
  (let [{:keys [genes organism title mine]} (selection db)
        sets (gmt-sets {:genes genes :organism organism :title title :mine mine})]
    (when (seq sets)
      {::save-text {:text (apply str (map #(gmt-text (:name %) (:description %) (:syms %)) sets))
                    :filename (gmt-file-name title (or organism (when (> (count sets) 1) "all organisms")))}})))

(reg-event-fx ::download-gmt (fn [{db :db} _] (gmt-fx db)))

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
 ::mine-label
 (fn [db]
   (mine-label db)))

(reg-sub
 ::state
 (fn [db]
   (get-in db (state-path))))

;;; Views ;;;

(defn- service-button [service-key enabled?]
  [:button.agr-btn
   {:type "button"
    :disabled (not enabled?)
    :on-click #(dispatch [::ask service-key])}
   (get-in services [service-key :label])])

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

(defn- confirm-bar [service-key n context]
  [:div.linkout-confirm {:role "status"}
   [:p.agr-note (third-party-notice service-key n context)]
   [:button.agr-btn-primary
    {:type "button"
     :ref #(when % (.focus %))
     :on-click #(dispatch [::send service-key])}
    (str "Send to " (get-in services [service-key :label]))]
   [:button.agr-btn
    {:type "button" :on-click #(dispatch [::cancel])}
    "Cancel"]])

(defn- ready-panel [{:keys [genes organism confirm notice truncated? source]} mine]
  (let [org-list (organisms genes)
        chosen (genes-for genes organism)
        syms (symbols chosen)
        species-entry (species-of organism)
        left-out (without-symbol-count chosen)
        systematic (systematic-count chosen)
        states (into {} (for [k [:gprofiler :enrichr :string]]
                          [k (action-state k species-entry syms organism)]))
        context {:species species-entry
                 :description (description {:title (source-title source) :mine mine
                                            :syms syms :organism organism})}]
    [:div.linkout-ready
     [:p (str (count syms) " gene symbols.")]
     (when truncated?
       [:p.agr-error (str "Only the first " max-read " genes were read.")])
     (when-let [n (organism-notice org-list)]
       [:p.agr-note n])
     (when (pos? systematic)
       [:p.agr-note (str systematic " genes have no symbol and are sent by systematic name.")])
     (when (pos? left-out)
       [:p.agr-note (str left-out " genes have neither a symbol nor a systematic name and are left out.")])
     [:div.agr-filter-bar
      [organism-select org-list organism]
      (for [k [:gprofiler :enrichr :string]]
        ^{:key k} [service-button k (:enabled? (states k))])
      [:button.agr-btn
       {:type "button" :disabled (empty? syms) :on-click #(dispatch [::download-gmt])}
       "Download GMT"]
      [:button.agr-btn
       {:type "button" :disabled (empty? syms) :on-click #(dispatch [::copy-symbols])}
       "Copy symbols"]]
     (for [k [:gprofiler :enrichr :string]
           :let [{:keys [enabled? reason]} (states k)]
           :when (not enabled?)]
       ^{:key k} [:p.agr-note.linkout-reason (str (get-in services [k :label]) ": " reason)])
     (when confirm [confirm-bar confirm (count syms) context])
     (when notice [:p.agr-note {:role "status"} notice])]))

(defn- panel [{:keys [loading? error] :as state} mine]
  [:section.agr-section.linkout-panel
   [:h3.agr-section-title "Send gene symbols to"]
   (cond
     loading? [:p {:role "status"} "Reading genes"]
     error [:p.agr-error {:role "alert"} error]
     :else [ready-panel state mine])])

(defn send-button
  "Toggle button and panel. `source` is `{:list name}` or `{:query q}`. The
  state is cleared when the button leaves the page, so a return reads the genes
  again."
  [source]
  (r/with-let [_ nil]
    (let [state @(subscribe [::state])
          mine @(subscribe [::mine-label])
          open? (= source (:source state))]
      [:div.linkout
       [:button.agr-btn
        {:type "button"
         :aria-expanded (boolean open?)
         :on-click #(dispatch [::toggle source])}
        "Send to"]
       (when open? [panel state mine])])
    (finally (dispatch [::reset]))))
