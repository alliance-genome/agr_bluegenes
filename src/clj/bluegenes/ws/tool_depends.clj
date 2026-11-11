(ns bluegenes.ws.tool-depends
  "Adds `depends` to installed tools whose config.json declares none or too few.
  The @intermine tools list no `depends`, so BlueGenes would offer them on mines
  whose model lacks the paths they query. The overrides live in
  resources/tool-depends.edn, keyed by npm package name, so they survive tool
  reinstalls."
  (:require [clojure.edn :as edn]
            [clojure.java.io :as io]
            [bluegenes-tool-store.tools :as tools]))

(defn load-overrides
  "Read the npm name -> depends map from the classpath resource."
  []
  (some-> (io/resource "tool-depends.edn") slurp edn/read-string))

(def ^:private overrides (delay (load-overrides)))

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

(defn get-all-tools
  "Same response as the tool store's /api/tools/all, with overrides applied."
  []
  (update-in (tools/get-all-tools) [:body :tools] #(apply-overrides @overrides %)))
