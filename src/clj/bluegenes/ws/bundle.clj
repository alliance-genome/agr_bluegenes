(ns bluegenes.ws.bundle
  "Download bundle for a Gene list: a zip of TSV files plus a README.txt.
  The server only calls service roots that are configured mines, so the
  endpoint cannot be used to make requests to arbitrary hosts."
  (:require [compojure.core :refer [POST defroutes]]
            [ring.util.http-response :as response]
            [config.core :refer [env]]
            [cheshire.core :as json]
            [clj-http.client :as client]
            [clojure.string :as str]
            [bluegenes.utils :refer [env->mines]])
  (:import [java.io ByteArrayInputStream ByteArrayOutputStream]
           [java.time LocalDate]
           [java.util.zip ZipEntry ZipOutputStream]))

(def max-genes 5000)

;; Annotation files can hold several rows per gene. Beyond this the file is
;; cut and the README says so.
(def max-rows 200000)

(defn normalise-root
  "Drops trailing slashes, so `http://host/mine/` equals `http://host/mine`."
  [root]
  (when (string? root)
    (str/replace (str/trim root) #"/+$" "")))

(defn find-mine
  "Returns the configured mine whose root equals `root`, or nil. Comparison is
  exact after dropping trailing slashes, so prefixes and look-alike hosts such
  as `http://mine.org@evil.com/` never match."
  [mines root]
  (when-let [wanted (normalise-root root)]
    (first (filter #(= wanted (normalise-root (:root %))) mines))))

(defn resolve-mine
  "The mine to call for the root the browser sent. The browser sends the
  public default service root, while the backend may be configured with a
  different root for server-side requests (`:bluegenes-backend-service-root`),
  so the public default maps to the backend root. Returns nil for any other
  root."
  [env root]
  (let [mines (env->mines env)
        default (normalise-root (:bluegenes-default-service-root env))]
    (or (find-mine mines root)
        (when (and default (= default (normalise-root root)))
          (first mines)))))

(defn xml-escape [s]
  (-> (str s)
      (str/replace "&" "&amp;")
      (str/replace "<" "&lt;")
      (str/replace ">" "&gt;")
      (str/replace "\"" "&quot;")))

(defn query-xml
  "PathQuery XML for `view` constrained to `list-name` through `list-path`.
  `outer` is a collection of paths to join with an outer join. `subclass` is a
  collection of [path type] pairs, needed where a path is typed by a
  superclass such as DiseaseAnnotation.subject (Annotatable)."
  [{:keys [view list-path outer subclass]} list-name]
  (str "<query name=\"\" model=\"genomic\" view=\""
       (str/join " " view)
       "\" sortOrder=\"" (first view) " asc\">"
       (apply str (for [p outer]
                    (str "<join path=\"" p "\" style=\"OUTER\"/>")))
       (apply str (for [[p t] subclass]
                    (str "<constraint path=\"" p "\" type=\"" t "\"/>")))
       "<constraint path=\"" list-path "\" op=\"IN\" value=\""
       (xml-escape list-name) "\"/>"
       "</query>"))

(def files
  "File name -> query description. Column headers are the view paths.
  `:optional-view` lists columns left out when the mine's model lacks them.
  Any other view path missing from the model drops the whole file when the
  file is `:optional?` and fails the bundle otherwise."
  [["genes.tsv" {:view ["Gene.primaryIdentifier" "Gene.symbol" "Gene.name"
                        "Gene.organism.shortName"]
                 :optional-view #{"Gene.name"}
                 :list-path "Gene"}]
   ["orthologs.tsv" {:view ["Gene.primaryIdentifier" "Gene.symbol"
                            "Gene.homologues.homologue.primaryIdentifier"
                            "Gene.homologues.homologue.symbol"
                            "Gene.homologues.homologue.organism.shortName"
                            "Gene.homologues.type"
                            "Gene.homologues.algorithmsMatch"
                            "Gene.homologues.algorithmsAttempted"
                            "Gene.homologues.isBestScore"
                            "Gene.homologues.isBestReverseScore"]
                     :optional-view #{"Gene.homologues.type"
                                      "Gene.homologues.algorithmsMatch"
                                      "Gene.homologues.algorithmsAttempted"
                                      "Gene.homologues.isBestScore"
                                      "Gene.homologues.isBestReverseScore"}
                     :list-path "Gene"}]
   ["disease_annotations.tsv" {:view ["DiseaseAnnotation.subject.primaryIdentifier"
                                      "DiseaseAnnotation.subject.symbol"
                                      "DiseaseAnnotation.qualifier"
                                      "DiseaseAnnotation.ontologyTerm.identifier"
                                      "DiseaseAnnotation.ontologyTerm.name"
                                      "DiseaseAnnotation.evidence.code.code"
                                      "DiseaseAnnotation.evidence.publications.pubMedId"]
                               :optional-view #{"DiseaseAnnotation.qualifier"
                                                "DiseaseAnnotation.evidence.code.code"
                                                "DiseaseAnnotation.evidence.publications.pubMedId"}
                               :outer ["DiseaseAnnotation.evidence"
                                       "DiseaseAnnotation.evidence.publications"]
                               :subclass [["DiseaseAnnotation.subject" "Gene"]]
                               :optional? true
                               :list-path "DiseaseAnnotation.subject"}]
   ["phenotype_annotations.tsv" {:view ["PhenotypeAnnotation.subject.primaryIdentifier"
                                        "PhenotypeAnnotation.subject.symbol"
                                        "PhenotypeAnnotation.phenotypeStatement"
                                        "PhenotypeAnnotation.ontologyTerm.identifier"
                                        "PhenotypeAnnotation.ontologyTerm.name"]
                                 :outer ["PhenotypeAnnotation.ontologyTerm"]
                                 :subclass [["PhenotypeAnnotation.subject" "Gene"]]
                                 :optional? true
                                 :list-path "PhenotypeAnnotation.subject"}]])

;; Model gating. `classes` is the :classes map of the mine's model JSON with
;; keyword keys. A class can be present while a path through it is not (FlyMine
;; has PhenotypeAnnotation without PhenotypeAnnotation.subject), so every view
;; path is walked through references and collections, with inherited fields.

(defn- class-field [classes class-kw field]
  (let [k (get classes class-kw)]
    (or (some #(get (get k %) field) [:attributes :references :collections])
        (some #(class-field classes (keyword %) field) (:extends k)))))

(defn path-resolves?
  "True when the dotted `path` resolves in `classes`. `subclass` is a seq of
  [path type] pairs that retype a reference, as in the query's constraints."
  ([classes path] (path-resolves? classes path nil))
  ([classes path subclass]
   (let [retype (into {} subclass)
         [root & fields] (str/split path #"\.")]
     (and (contains? classes (keyword root))
          (loop [cls (keyword root) prefix root [f & more] fields]
            (let [field (class-field classes cls (keyword f))
                  here (str prefix "." f)]
              (cond (nil? field) false
                    (empty? more) true
                    :else (if-let [t (or (get retype here) (:referencedType field))]
                            (recur (keyword t) here more)
                            false))))))))

(defn adapt-spec
  "Fits a file spec to the model. Returns {:spec s :dropped [paths]} with the
  optional columns the model lacks removed, or {:missing [paths]} when a
  required column is absent. A nil `classes` (model unavailable) changes
  nothing."
  [classes {:keys [view optional-view outer subclass] :as spec}]
  (if (nil? classes)
    {:spec spec :dropped []}
    (let [missing (remove #(path-resolves? classes % subclass) view)
          required-missing (remove #(contains? optional-view %) missing)
          kept (vec (remove (set missing) view))]
      (if (seq required-missing)
        {:missing (vec required-missing)}
        {:spec (assoc spec
                      :view kept
                      :outer (vec (filter (fn [o] (some #(str/starts-with? % (str o ".")) kept))
                                          outer)))
         :dropped (vec missing)}))))

(defn tsv-cell
  "Tabs and line breaks would shift columns, so they become spaces."
  [v]
  (if (nil? v)
    ""
    (str/replace (str v) #"[\t\r\n]+" " ")))

(defn rows->tsv [header rows]
  (str (str/join "\t" header) "\n"
       (apply str (for [row rows]
                    (str (str/join "\t" (map tsv-cell row)) "\n")))))

(defn ex
  "An exception carrying the HTTP status for the route to return."
  [status message]
  (ex-info message {:status status}))

(defn- service-url [root path]
  (str (normalise-root root) "/service" path))

(defn- mine-get
  "GET against an already allowlisted mine. The token goes in the
  Authorization header only, redirects are not followed so the token cannot
  be forwarded to another host, and failures carry no request details."
  [root token path params]
  (let [res (try
              (client/get (service-url root path)
                          {:query-params params
                           :headers (cond-> {}
                                      (not (str/blank? token))
                                      (assoc "Authorization" (str "Token " token)))
                           :redirect-strategy :none
                           :socket-timeout 120000
                           :connection-timeout 10000
                           :throw-exceptions false})
              (catch Exception _
                (throw (ex 502 "The mine could not be reached."))))]
    (case (long (:status res))
      200 (:body res)
      400 (throw (ex 400 "The mine rejected the query."))
      404 (throw (ex 404 "The mine has no such resource."))
      (401 403) (throw (ex 401 "The mine rejected the token. Log in again."))
      (throw (ex 502 (str "The mine answered with status " (:status res) "."))))))

(defn fetch-list
  "The list's metadata map, or an error if it is missing or not a Gene list
  within the size cap."
  [root token list-name]
  (let [body (try (mine-get root token "/lists" {"name" list-name "format" "json"})
                  (catch clojure.lang.ExceptionInfo e
                    (if (= 404 (:status (ex-data e)))
                      (throw (ex 404 (str "List not found: " list-name)))
                      (throw e))))
        lst (->> (json/parse-string body true) :lists
                 (filter #(= list-name (:name %))) first)]
    (cond
      (nil? lst) (throw (ex 404 (str "List not found: " list-name)))
      (not= "Gene" (:type lst)) (throw (ex 400 "Only Gene lists can be bundled."))
      (> (:size lst) max-genes) (throw (ex 413 (str "The list has " (:size lst)
                                                    " genes. The limit is " max-genes ".")))
      :else lst)))

(defn fetch-rows
  "Runs a PathQuery and returns {:rows [...] :truncated? bool}."
  [root token xml]
  (let [body (mine-get root token "/query/results"
                       {"query" xml "format" "json" "size" (inc max-rows)})
        rows (mapv #(mapv (fn [cell] (if (map? cell) (:value cell) cell)) %)
                   (:results (json/parse-string body true)))]
    {:rows (vec (take max-rows rows))
     :truncated? (> (count rows) max-rows)}))

(defn- version [root token endpoint]
  (try (str/trim (mine-get root token (str "/version/" endpoint) {}))
       (catch Exception _ "unknown")))

(defn readme-text
  [{:keys [mine-name root release intermine list-name list-size date entries]}]
  (str "BlueGenes list download bundle\n"
       "=============================\n\n"
       "Mine: " mine-name "\n"
       "URL: " root "\n"
       "Release: " release "\n"
       "InterMine version: " intermine "\n"
       "List: " list-name "\n"
       "List size: " list-size "\n"
       "Date: " date "\n\n"
       "Files\n-----\n"
       (apply str
              (for [{:keys [file rows truncated? skipped? missing dropped xml]} entries]
                (cond
                  (seq missing)
                  (str "\n" file " (not included: the mine's model lacks "
                       (str/join ", " missing) ")\n")

                  skipped?
                  (str "\n" file " (not included: the mine rejected the query, "
                       "its model probably lacks these classes)\nPathQuery XML:\n" xml "\n")

                  :else
                  (str "\n" file " (" rows " rows"
                       (when truncated? (str ", cut at " max-rows " rows"))
                       ")\n"
                       (when (seq dropped)
                         (str "Columns left out, not in the mine's model: "
                              (str/join ", " dropped) "\n"))
                       "PathQuery XML:\n" xml "\n"))))))

(defn zip-bytes
  "`entries` is a seq of [file-name string]."
  [entries]
  (let [out (ByteArrayOutputStream.)]
    (with-open [zip (ZipOutputStream. out)]
      (doseq [[file-name content] entries]
        (.putNextEntry zip (ZipEntry. ^String file-name))
        (.write zip (.getBytes ^String content "UTF-8"))
        (.closeEntry zip)))
    (.toByteArray out)))

(defn fetch-model-classes
  "The :classes map of the mine's model, or nil when it cannot be read, in
  which case no gating happens and the 400 fallback of `fetch-file` applies."
  [root token]
  (try (-> (mine-get root token "/model" {"format" "json"})
           (json/parse-string true) :model :classes not-empty)
       (catch Exception _ nil)))

(defn fetch-file
  "Rows for one file. An optional file whose query the mine rejects with 400
  (its model lacks the classes) comes back as {:skipped? true}. A file whose
  required paths are not in the model comes back as {:missing [...]} without
  a request. `classes` is the model's class map or nil."
  [root token classes [file spec] list-name]
  (let [{adapted :spec :keys [missing dropped]} (adapt-spec classes spec)]
    (if (seq missing)
      (if (:optional? spec)
        {:file file :missing missing :rows []}
        (throw (ex 400 (str "The mine's model lacks " (str/join ", " missing) "."))))
      (let [xml (query-xml adapted list-name)
            base {:file file :xml xml :header (:view adapted) :dropped dropped}]
        (try
          (merge base (fetch-rows root token xml))
          (catch clojure.lang.ExceptionInfo e
            (if (and (:optional? spec) (= 400 (:status (ex-data e))))
              (assoc base :skipped? true :rows [])
              (throw e))))))))

(defn build-bundle
  "Returns the zip as a byte array for a configured `mine`."
  [mine token list-name]
  (let [root (normalise-root (:root mine))
        lst (fetch-list root token list-name)
        classes (fetch-model-classes root token)
        results (doall (map #(fetch-file root token classes % list-name) files))
        readme (readme-text
                {:mine-name (:name mine)
                 :root root
                 :release (version root token "release")
                 :intermine (version root token "intermine")
                 :list-name list-name
                 :list-size (:size lst)
                 :date (str (LocalDate/now))
                 :entries (for [{:keys [rows] :as r} results]
                            (assoc r :rows (count rows)))})]
    (zip-bytes (cons ["README.txt" readme]
                     (for [{:keys [file header rows skipped? missing]} results
                           :when (not (or skipped? (seq missing)))]
                       [file (rows->tsv header rows)])))))

(defn bundle-handler
  [{{:keys [root listName token]} :body-params}]
  (let [mine (resolve-mine env root)]
    (cond
      (nil? mine) (response/bad-request {:error "Unknown mine."})
      (str/blank? listName) (response/bad-request {:error "Missing list name."})
      :else
      (try
        (let [bytes (build-bundle mine token listName)]
          (-> (response/ok (ByteArrayInputStream. bytes))
              (response/content-type "application/zip")
              (response/header "Content-Disposition"
                               (str "attachment; filename=\"bundle.zip\""))))
        (catch clojure.lang.ExceptionInfo e
          {:status (or (:status (ex-data e)) 500)
           :headers {"Content-Type" "application/json"}
           :body (json/generate-string {:error (.getMessage e)})})))))

(defroutes routes
  (POST "/bundle" req (bundle-handler req)))
