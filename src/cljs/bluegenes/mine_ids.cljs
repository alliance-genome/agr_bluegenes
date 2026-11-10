(ns bluegenes.mine-ids
  "Gene identifier forms across the Alliance mines. AllianceMine stores CURIEs
  (HGNC:11998, WB:WBGene00006759). WormMine, FlyMine and YeastMine store bare
  identifiers for their own species (WBGene00006759, FBgn0003996, S000001855)
  and CURIEs for the genes of other Alliance species (WormMine holds FB:FBgn...,
  HGNC:, MGI:, RGD: and ZFIN:ZDB-GENE-... genes). Other genes carry NCBI numbers
  or locus tags that map to no CURIE."
  (:require [clojure.string :as str]))

(def ^:private bare->curie-prefix
  "Shape of a bare identifier and the CURIE prefix AllianceMine gives it."
  [[#"FBgn\d+" "FB"]
   [#"WBGene\d+" "WB"]
   [#"S000\d+" "SGD"]
   [#"ZDB-GENE-.+" "ZFIN"]])

(defn strip-prefix
  "The identifier without its CURIE prefix (\"WB:WBGene1\" gives \"WBGene1\"), or
  nil. A numeric remainder is not returned: the MOD mines keep HGNC:, MGI: and
  RGD: identifiers with their prefix, and a bare number would match an unrelated
  gene with that number as its NCBI id."
  [id]
  (let [[_ remainder] (re-matches #"[A-Za-z][A-Za-z0-9_.-]*:(.+)" id)]
    (when (and remainder (not (re-matches #"\d+" remainder)))
      remainder)))

(defn add-prefix
  "The CURIE of a bare identifier of a known shape (\"WBGene1\" gives
  \"WB:WBGene1\"), or nil."
  [id]
  (some (fn [[shape prefix]]
          (when (re-matches shape id)
            (str prefix ":" id)))
        bare->curie-prefix))

(defn candidates
  "Identifiers to try in another mine for one identifier, in order of
  preference: as given, without CURIE prefix, with CURIE prefix. Blank gives []."
  [id]
  (let [id (str/trim (str id))]
    (if (str/blank? id)
      []
      (vec (distinct (remove nil? [id (strip-prefix id) (add-prefix id)]))))))
