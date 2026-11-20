(ns bluegenes.components.tools.utils
  "Pure helpers for the tool host: the context passed to tools, validation of
  `context.saveList` arguments, tool groups and the id threshold."
  (:require [clojure.string :as str]
            [bluegenes.pages.lists.utils :refer [copy-list-name]]))

;;; Threshold ;;;

(def global-threshold 1000)

(defn greatest-count
  "Returns the greatest count of IDs across all entities."
  [entities]
  (apply max (map (comp #(if (coll? %) (count %) 1) :value val) entities)))

(defn above-threshold?
  "Returns whether a tool has surpassed its config's `threshold`, or the global
  threshold, for automatic initialisation."
  [{:keys [entity config] :as _tool-details}]
  (> (greatest-count entity) (:threshold config global-threshold)))

;;; Groups ;;;

(def groups ["Annotation" "Enrichment" "Export" "Other"])

(def default-group "Other")

(defn tool-group
  "The group name of a tool: `group` in its config when it is one of `groups`,
  otherwise \"Other\"."
  [tool-details]
  (let [group (get-in tool-details [:config :group])]
    (if (some #{group} groups) group default-group)))

(defn group-tools
  "Vector of [group-name tools] in the order of `groups`, omitting empty groups.
  Tools keep their order within a group."
  [tools]
  (let [by-group (group-by tool-group tools)]
    (into [] (keep (fn [group] (when-let [ts (get by-group group)] [group ts]))) groups)))

;;; Context ;;;

(defn- where-of [query]
  (:where query))

(defn- in-list-name
  "Name of the list when `query` is exactly one IN constraint on a list."
  [query]
  (let [[constraint & more] (where-of query)]
    (when (and (nil? more) (= "IN" (:op constraint)))
      (:value constraint))))

(defn- current-query
  "The query behind the results page. The im-table copy follows edits, the
  package copy is the query the page was opened with."
  [db]
  (or (get-in db [:results :table :query])
      (get-in db [:results :package :value])))

(defn- list-context
  "The saved list the results page is showing, or nil once the query was edited
  to something that is not that list."
  [db query]
  (let [{:keys [intent value]} (get-in db [:results :package])
        list-name (in-list-name query)]
    (when (and (= intent :list) list-name (= list-name (in-list-name value)))
      (when-let [{:keys [title size type]} (->> (get-in db [:assets :lists (:current-mine db)])
                                                (filter #(= list-name (:name %)))
                                                first)]
        {:name list-name :title title :size size :type type}))))

(defn- page-of [db saved-list]
  (cond
    (= :reportpage-panel (:active-panel db)) "report"
    saved-list "list"
    :else "results"))

(defn build-context
  "Data behind the 7th argument of a tool's main function, except `saveList`.
  `query` and `list` are nil on the report page."
  [db]
  (let [report? (= :reportpage-panel (:active-panel db))
        query (when-not report? (current-query db))
        saved-list (when-not report? (list-context db query))]
    {:mine (some-> (:current-mine db) name)
     :list saved-list
     :query query
     :intent (when-not report? (some-> (get-in db [:results :package :intent]) name))
     :page (page-of db saved-list)}))

;;; saveList ;;;

(def login-required-message "login required")

(def ^:private class-name-re #"[A-Za-z][A-Za-z0-9_]*")

(defn- id? [x]
  (or (and (number? x) (integer? x) (pos? x))
      (and (string? x) (some? (re-matches #"\d+" x)))))

(defn validate-save-args
  "Returns a message for the first problem in the `saveList` argument map
  ({:name :class :ids :tags}), or nil when it is valid."
  [{list-name :name :keys [class ids tags]}]
  (cond
    (not (and (string? list-name) (not (str/blank? list-name)))) "saveList: name must be a non-empty string"
    (not (and (string? class) (re-matches class-name-re class))) "saveList: class must be a class name such as Gene"
    (not (and (sequential? ids) (seq ids))) "saveList: ids must be a non-empty array"
    (not (every? id? ids)) "saveList: ids must be InterMine object ids"
    (not (or (nil? tags) (and (sequential? tags) (every? string? tags)))) "saveList: tags must be an array of strings"))

(defn ids-query
  "Query listing the objects of `class` with the given object ids."
  [class ids]
  (let [path (str class ".id")]
    {:from class
     :select [path]
     :where [{:path path :op "ONE OF" :values (mapv str ids)}]}))

(defn unique-list-name
  "`list-name`, or a numbered copy name when a list with that name exists."
  [lists list-name]
  (if (some (comp #{list-name} :name) lists)
    (copy-list-name lists list-name)
    list-name))

(defn save-options
  "Options for the tolist request, carrying tags as one `;` separated string."
  [tags]
  (when (seq tags)
    {:tags (str/join ";" tags)}))
