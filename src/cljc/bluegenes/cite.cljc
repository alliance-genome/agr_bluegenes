(ns bluegenes.cite
  "Pure text generation for the Cite / methods panel: a methods paragraph,
  BibTeX entries and RIS entries. No db or browser access. The caller passes
  the access date as a yyyy-mm-dd string."
  (:require [clojure.string :as str]))

(def intermine-papers
  "The InterMine papers to cite. Authors are [family given] pairs."
  [{:key "Smith2012"
    :authors [["Smith" "Richard N"] ["Aleksic" "Jelena"] ["Butano" "Daniela"]
              ["Carr" "Adrian"] ["Contrino" "Sergio"] ["Hu" "Fengyuan"]
              ["Lyne" "Mike"] ["Lyne" "Rachel"] ["Kalderimis" "Alex"]
              ["Rutherford" "Kim"] ["Štěpán" "Radek"] ["Sullivan" "Julie"]
              ["Wakeling" "Mark"] ["Watkins" "Xavier"] ["Micklem" "Gos"]]
    :title "InterMine: a flexible data warehouse system for the integration and analysis of heterogeneous biological data"
    :journal "Bioinformatics"
    :year "2012"
    :volume "28"
    :number "23"
    :pages ["3163" "3165"]
    :doi "10.1093/bioinformatics/bts577"}
   {:key "Kalderimis2014"
    :authors [["Kalderimis" "Alex"] ["Lyne" "Rachel"] ["Butano" "Daniela"]
              ["Contrino" "Sergio"] ["Lyne" "Mike"] ["Heimbach" "Joshua"]
              ["Hu" "Fengyuan"] ["Smith" "Richard"] ["Štěpán" "Radek"]
              ["Sullivan" "Julie"] ["Micklem" "Gos"]]
    :title "InterMine: extensive web services for modern biology"
    :journal "Nucleic Acids Research"
    :year "2014"
    :volume "42"
    :number "W1"
    :pages ["W468" "W472"]
    :doi "10.1093/nar/gku301"}])

(def alliance-paper
  "The Alliance of Genome Resources paper, cited when the release is known."
  {:key "AllianceConsortium2024"
   :authors [["Alliance of Genome Resources Consortium" ""]]
   :title "Updates to the Alliance of Genome Resources central infrastructure"
   :journal "Genetics"
   :year "2024"
   :volume "227"
   :number "1"
   :pages ["iyae049"]
   :doi "10.1093/genetics/iyae049"})

;;; Alliance release ;;;

(defn alliance-mine?
  "True when a mine's service root or namespace names the Alliance."
  [root-or-name]
  (boolean (re-find #"(?i)alliance" (str root-or-name))))

(defn parse-release-info
  "{:version :date} from the Alliance /releaseInfo response (a map with
  releaseVersion and releaseDate, string or keyword keys). Nil without a version."
  [info]
  (let [get* #(or (get info %) (get info (keyword %)))
        version (get* "releaseVersion")
        date (str (get* "releaseDate"))]
    (when-not (str/blank? (str version))
      {:version (str version)
       :date (when-not (str/blank? date) (subs date 0 (min 10 (count date))))})))

(defn alliance-release-text
  "`Alliance of Genome Resources data release 9.2.0 (2026-10-28)`, or nil."
  [{:keys [version date]}]
  (when-not (str/blank? version)
    (str "Alliance of Genome Resources data release " version
         (when-not (str/blank? date) (str " (" date ")")))))

;;; Query and list descriptions ;;;

(def op-words
  {"=" "equals"
   "!=" "does not equal"
   "<" "is less than"
   "<=" "is at most"
   ">" "is greater than"
   ">=" "is at least"
   "LIKE" "matches"
   "NOT LIKE" "does not match"
   "CONTAINS" "contains"
   "DOES NOT CONTAIN" "does not contain"
   "IN" "is in the list"
   "NOT IN" "is not in the list"
   "ONE OF" "is one of"
   "NONE OF" "is none of"
   "IS NULL" "is empty"
   "IS NOT NULL" "is not empty"
   "LOOKUP" "is a lookup match for"
   "ISA" "is of type"
   "ISNT" "is not of type"
   "WITHIN" "is within"
   "OVERLAPS" "overlaps"
   "DOES NOT OVERLAP" "does not overlap"
   "OUTSIDE" "is outside"})

(defn- quoted [s] (str "\"" s "\""))

(defn clean-version
  "Version text from /service/version/*. The services return a JSON string
  (\"test\") with trailing whitespace; this drops both. Nil when blank."
  [v]
  (when (some? v)
    (let [cleaned (-> (str/trim (str v))
                      (->> (re-find #"^\"?(.*?)\"?$"))
                      second
                      str/trim)]
      (when-not (str/blank? cleaned) cleaned))))

(defn describe-constraint
  "One constraint in words, e.g. `Gene.organism.shortName equals \"M. musculus\"`.
  A subclass constraint (a :type and no :op) reads `Gene is of type Protein`."
  [{:keys [path op value values extraValue type]}]
  (if (and (nil? op) (some? type))
    (str path " is of type " type)
    (let [object (cond
                   (seq values) (str/join ", " (map quoted values))
                   (#{"IS NULL" "IS NOT NULL"} op) nil
                   (some? value) (quoted value))]
      (str/join " " (remove nil? [path
                                  (get op-words op (str/lower-case (str op)))
                                  object
                                  (when-not (str/blank? extraValue)
                                    (str "(" extraValue ")"))])))))

(defn- active? [constraint]
  (not= "OFF" (:switched constraint)))

(defn- join-and [items]
  (case (count items)
    0 ""
    1 (first items)
    2 (str (first items) " and " (second items))
    (str (str/join ", " (butlast items)) ", and " (last items))))

(defn describe-query
  "A query as a sentence fragment: class, columns and constraints in words.
  Constraints switched off (:switched \"OFF\") are left out."
  [{:keys [from select where constraintLogic]}]
  (let [n (count select)
        where (filter active? where)]
    (str "a query on the " from " class returning "
         n (if (= n 1) " column" " columns")
         (when (seq select) (str " (" (str/join ", " select) ")"))
         (if (seq where)
           (str ", with the constraints: "
                (join-and (map describe-constraint where))
                (when-not (str/blank? constraintLogic)
                  (str " (constraint logic " constraintLogic ")")))
           ", with no constraints"))))

(defn describe-subject
  "Subject is {:kind :list :name :size :type} or {:kind :query :query query}."
  [{:keys [kind name size type query]}]
  (if (= kind :list)
    (str "the list " (quoted name)
         (when (some? size)
           (str " (" size " " (or type "item") (if (= size 1) "" "s") ")")))
    (describe-query query)))

;;; Methods paragraph ;;;

(defn methods-paragraph
  "Methods text naming the mine, its versions, the subject and the access date.
  Missing versions are left out."
  [{:keys [mine-name url release intermine-version date subject alliance]}]
  (let [versions (remove nil?
                         [(when-not (str/blank? release) (str "release " release))
                          (when-not (str/blank? intermine-version)
                            (str "InterMine " intermine-version))])]
    (str "Data were retrieved from " mine-name " (" url ")"
         (when (seq versions) (str ", " (join-and versions)))
         ", using " (describe-subject subject)
         ". Data were accessed on " date ". "
         (when-let [text (alliance-release-text alliance)]
           (str "The mine integrates " text
                " (Alliance of Genome Resources Consortium 2024, Genetics 227(1):iyae049). "))
         "The mine runs on the InterMine platform (Smith et al. 2012, Bioinformatics 28(23):3163-3165; "
         "Kalderimis et al. 2014, Nucleic Acids Research 42(W1):W468-W472).")))

;;; BibTeX ;;;

(def ^:private tex-accents
  {"Š" "{\\v{S}}" "š" "{\\v{s}}" "ě" "{\\v{e}}" "á" "{\\'a}"})

(defn bibtex-escape
  "Escape the characters TeX treats as special and replace accented letters."
  [s]
  (-> (str s)
      (str/replace #"\\" (fn [_] "\\textbackslash{}"))
      (str/replace #"[&%#_$]" #(str "\\" %))
      (str/replace #"[Ššěá]" #(get tex-accents % %))))

(defn- bibtex-name [[family given]]
  (if (str/blank? given)
    (str "{" (bibtex-escape family) "}")
    (str (bibtex-escape family) ", " given)))

(defn- bibtex-fields [fields]
  (->> fields
       (remove (comp str/blank? second))
       (map (fn [[k v]] (str "  " (name k) " = {" v "}")))
       (str/join ",\n")))

(defn mine-key
  "Citation key from the mine name and the access year, e.g. `AllianceMine2026`."
  [mine-name date]
  (str (str/replace (str mine-name) #"[^A-Za-z0-9]" "")
       (subs (str date) 0 (min 4 (count (str date))))))

(defn bibtex-mine [{:keys [mine-name url release date alliance]}]
  (str "@misc{" (mine-key mine-name date) ",\n"
       (bibtex-fields [[:title (bibtex-escape mine-name)]
                       [:url url]
                       [:version (bibtex-escape release)]
                       [:urldate date]
                       [:note (str "InterMine data warehouse"
                                   (when-let [text (alliance-release-text alliance)]
                                     (str "; " text)))]])
       "\n}"))

(defn bibtex-paper [{:keys [key authors title journal year volume number pages doi]}]
  (str "@article{" key ",\n"
       (bibtex-fields [[:author (str/join " and " (map bibtex-name authors))]
                       [:title (str "{" title "}")]
                       [:journal journal]
                       [:year year]
                       [:volume volume]
                       [:number number]
                       [:pages (str/join "--" pages)]
                       [:doi doi]])
       "\n}"))

(defn bibtex
  "BibTeX for the mine and both InterMine papers, plus the Alliance paper
  when the mine map carries an :alliance release."
  [{:keys [alliance] :as mine}]
  (str/join "\n\n" (concat [(bibtex-mine mine)]
                           (map bibtex-paper intermine-papers)
                           (when (alliance-release-text alliance)
                             [(bibtex-paper alliance-paper)]))))

;;; RIS ;;;

(defn- ris-line [tag v]
  (when-not (str/blank? (str v)) (str tag "  - " v)))

(defn- ris-date [date]
  (when-let [[_ y m d] (re-matches #"(\d{4})-(\d{2})-(\d{2})" (str date))]
    (str y "/" m "/" d "/")))

(defn- ris-record [lines]
  (str (str/join "\n" (remove nil? lines)) "\nER  - "))

(defn ris-mine [{:keys [mine-name url release date alliance]}]
  (ris-record [(ris-line "TY" "ELEC")
               (ris-line "TI" mine-name)
               (ris-line "UR" url)
               (ris-line "ET" release)
               (ris-line "Y2" (ris-date date))
               (ris-line "N1" (str "InterMine data warehouse"
                                   (when-let [text (alliance-release-text alliance)]
                                     (str "; " text))))]))

(defn ris-paper [{:keys [authors title journal year volume number pages doi]}]
  (ris-record (concat [(ris-line "TY" "JOUR")]
                      (map (fn [[family given]]
                             (ris-line "AU" (if (str/blank? given) family (str family ", " given))))
                           authors)
                      [(ris-line "TI" title)
                       (ris-line "JO" journal)
                       (ris-line "PY" year)
                       (ris-line "VL" volume)
                       (ris-line "IS" number)
                       (ris-line "SP" (first pages))
                       (ris-line "EP" (second pages))
                       (ris-line "DO" doi)
                       (ris-line "UR" (str "https://doi.org/" doi))])))

(defn ris
  "RIS for the mine and both InterMine papers, plus the Alliance paper
  when the mine map carries an :alliance release."
  [{:keys [alliance] :as mine}]
  (str/join "\n\n" (concat [(ris-mine mine)]
                           (map ris-paper intermine-papers)
                           (when (alliance-release-text alliance)
                             [(ris-paper alliance-paper)]))))
