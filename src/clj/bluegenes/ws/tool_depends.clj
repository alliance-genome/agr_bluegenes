(ns bluegenes.ws.tool-depends
  "Adds `depends` to installed tools whose config.json declares none or too few,
  and a `group` to tools whose config.json declares none.
  The @intermine tools list no `depends`, so BlueGenes would offer them on mines
  whose model lacks the paths they query. The overrides live in
  resources/tool-depends.edn, keyed by npm package name, so they survive tool
  reinstalls. Its `:groups` entry maps npm package name to the results page group."
  (:require [clojure.edn :as edn]
            [clojure.java.io :as io]
            [bluegenes-tool-store.tools :as tools]))

(defn- load-config []
  (some-> (io/resource "tool-depends.edn") slurp edn/read-string))

(defn load-overrides
  "Read the npm name -> depends map from the classpath resource."
  []
  (dissoc (load-config) :groups))

(defn load-groups
  "Read the npm name -> group map from the classpath resource."
  []
  (:groups (load-config)))

(def ^:private overrides (delay (load-overrides)))
(def ^:private groups (delay (load-groups)))

(defn merge-depends
  "Union of a tool's own `depends` and the override, own entries first."
  [own extra]
  (vec (distinct (concat own extra))))

(defn apply-overrides
  "Merge `overrides` (npm name -> depends) into each tool's `[:config :depends]`.
  Tools without an entry are returned unchanged."
  [overrides tool-list]
  (mapv (fn [tool]
          (if-let [extra (get overrides (get-in tool [:package :name]))]
            (update-in tool [:config :depends] merge-depends extra)
            tool))
        tool-list))

(defn apply-groups
  "Set `[:config :group]` from `groups` (npm name -> group) on tools whose own
  config declares no group."
  [groups tool-list]
  (mapv (fn [tool]
          (let [group (get groups (get-in tool [:package :name]))]
            (cond-> tool
              (and group (nil? (get-in tool [:config :group])))
              (assoc-in [:config :group] group))))
        tool-list))

(defn get-all-tools
  "Same response as the tool store's /api/tools/all, with overrides and groups applied."
  []
  (update-in (tools/get-all-tools) [:body :tools]
             #(->> % (apply-overrides @overrides) (apply-groups @groups))))
