(ns bluegenes.alliance-curie
  "Maps a mine gene identifier to the CURIE the Alliance of Genome Resources
  uses for the gene (HGNC:11998, MGI:104537, FB:FBgn0003731). AllianceMine
  stores CURIEs already. Other mines store bare identifiers (FBgn..., WBGene...,
  S000...), which are prefixed by their shape, or by organism (MGI, RGD) for bare numbers."
  (:require [clojure.string :as str]))

(def ^:private species
  [{:prefix "HGNC" :taxon-ids #{"9606"} :names #{"h. sapiens" "homo sapiens"}}
   {:prefix "MGI" :taxon-ids #{"10090"} :names #{"m. musculus" "mus musculus"}}
   {:prefix "RGD" :taxon-ids #{"10116"} :names #{"r. norvegicus" "rattus norvegicus"}}
   {:prefix "ZFIN" :taxon-ids #{"7955"} :names #{"d. rerio" "danio rerio"}}
   {:prefix "FB" :taxon-ids #{"7227"} :names #{"d. melanogaster" "drosophila melanogaster"}}
   {:prefix "WB" :taxon-ids #{"6239"} :names #{"c. elegans" "caenorhabditis elegans"}}
   {:prefix "SGD" :taxon-ids #{"559292" "4932"} :names #{"s. cerevisiae" "saccharomyces cerevisiae"}}])

(def ^:private shapes
  [[#"FBgn\d+" "FB"]
   [#"WBGene\d+" "WB"]
   [#"S\d{9}" "SGD"]
   [#"ZDB-GENE-[\w-]+" "ZFIN"]])

(def ^:private numeric-prefixes
  "Bare numbers are only prefixed for these. HGNC is excluded because HumanMine
  primaryIdentifier is an Entrez id, which would map to a different HGNC gene."
  #{"MGI" "RGD"})

(defn species-prefix
  "CURIE prefix of the species given as a short name, full name or taxon id
  (string or number), or nil."
  [organism]
  (let [k (str/lower-case (str/trim (str organism)))]
    (some (fn [{:keys [prefix taxon-ids names]}]
            (when (or (taxon-ids k) (names k)) prefix))
          species)))

(defn- shape-prefix [id]
  (some (fn [[re prefix]] (when (re-matches re id) prefix)) shapes))

(defn to-alliance-curie
  "Alliance gene CURIE for `primary-identifier` of an organism given by short
  name or taxon id, or nil when it can not be mapped."
  [primary-identifier organism]
  (let [id (str/trim (str primary-identifier))
        prefix (or (shape-prefix id)
                   (let [p (species-prefix organism)]
                     (when (and (numeric-prefixes p) (re-matches #"\d+" id)) p)))]
    (cond
      (str/blank? id) nil
      (str/includes? id ":") id
      prefix (str prefix ":" id))))
