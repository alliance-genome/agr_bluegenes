# AllianceMine test mine

A small local InterMine with the AllianceMine data model and 169 genes from 7 species. It
is for building BlueGenes features that read `Gene.homologues`, `Gene.diseaseAnnotation`,
`Gene.phenotypeAnnotations`, `Gene.alleles`, `Gene.expressionAnnotations`, `Gene.paralogues`
and `Gene.diseaseModels` without a 32 GB AllianceMine.

Service root: `http://localhost:9999/alliancetestmine`

## Start

Needs Docker and `intermine_boot` (`pip install intermine_boot 'setuptools<81'`).

    dev/testmine/start.sh        # full rebuild, replaces whatever runs on port 9999
    dev/testmine/start.sh stop
    lein testmine                # BlueGenes against it (no additional mines)

`start.sh` deletes `~/.local/share/intermine_boot` (a running Biotestmine goes with it),
builds the mine and starts Postgres, Solr and Tomcat containers. Set `INTERMINE_BOOT` if
the executable is not on `PATH`. The build takes 15 to 30 minutes (about 30 minutes on the last
run, amd64 builder image emulated on Apple silicon). The first run downloads the Maven
dependencies.

## How it is built

- `mine/bio-sources/` holds the AllianceMine bio-sources `alliance-genes`,
  `alliance-orthologs`, `alliance-ortholog-detail`, `alliance-disease`,
  `alliance-disease-detail`, `alliance-phenotypes`, `alliance-alleles`, `alliance-expression`,
  `alliance-paralogs`, `alliance-disease-models`, `alliance-allele-phenotypes`,
  `alliance-disease-alleles` and the ontology sources `mmo`, `emapa`, `zfa`, `wbbt`, `fbbt`
  (copies, tests dropped, two edits listed under Differences) plus `testmine-organisms`, a 50-line loader for organism names so the build
  needs no NCBI call. The root `build.gradle` is the AllianceMine one with `jcenter()`
  replaced by `mavenCentral()`.
- `mine/project_build` runs `gradlew install` on `bio-sources/` inside the builder
  container, then the stock `project_build_im`. The model is the genomic model merged with
  the AllianceMine `global_additions.xml`, so class and field names match AllianceMine.
- The mine folder is staged as `biotestmine` because the intermine_boot builder image only
  works with that mine name. The Postgres databases and Solr cores are called `biotestmine`
  too. The web context is `alliancetestmine` (`webapp.path` in `mine/data/biotestmine.properties`).
- `mine/data/` is the input. Regenerate it with `python3 -I dev/testmine/make_data.py`.

## Data

| File | Source | Content |
|---|---|---|
| `alliance-genes.tsv` | hand-built, real Alliance ids | 133 genes, 25 families |
| `ORTHOLOGY-ALLIANCE_COMBINED.tsv`, `orthologs.tsv` | hand-built | every cross-species pair inside a family, both directions |
| `disease-alliance.tsv`, `disease-annotations-detail.tsv`, `ONTOLOGY_DOID.obo` | real rows cut from the AllianceMine data checkout | at most 5 diseases per gene |
| `phenotypes.tsv` | hand-built statements, PMIDs from the disease rows | 2 per gene |
| `alliance-alleles.tsv` | real rows (mouse and yeast) | up to 4 per gene, 104 alleles |
| `expression-alliance.tsv` | real rows from the Alliance expression file | 497 rows, 100 genes; up to 6 distinct anatomy terms per gene |
| `ONTOLOGY_MMO/EMAPA/ZFA/WBBT/FBBT.obo` | hand-built from the expression rows | id and name of each term used (14 MMO, 53 EMAPA, 47 ZFA, 38 WBbt, 49 FBbt) |
| `paralogs.tsv` | hand-built pairs, random identity, similarity and methods | 74 rows (both directions of 37 pairs) |
| `disease-models.tsv` | real AGM ids and names, real gene diseases, hand-built association type | 50 rows, 25 mouse genes, 2 models each |
| `disease-alleles.tsv` | real rows for the loaded alleles | 34 rows, 16 alleles |
| `allele-phenotypes.tsv` | real MP terms, statements and PMIDs of the gene, assigned to alleles by hand | 300 rows, 100 mouse alleles, 3 each |
| `organisms.tsv` | hand-built | 7 species |

Species: human HGNC, mouse MGI, rat RGD, zebrafish ZFIN, fly FB, worm WB, yeast SGD.
133 genes are in the 25 families. 36 more (20 human, 16 mouse) are paralog partners that
have no other data, such as `HGNC:3430` ERBB2 and `MGI:96224` Hras.
Chromosome is set for human and mouse only, other species use `Unassigned`. No gene has
coordinates.

## Sample genes

| Use | Gene | Id |
|---|---|---|
| orthologs | TP53 (human) | `HGNC:11998` |
| orthologs | Trp53 (mouse) | `MGI:98834` |
| orthologs | p53 (fly) | `FB:FBgn0039044` |
| disease | SOD1 (human) | `HGNC:11179` |
| disease | Pten (mouse) | `MGI:109583` |
| disease | Pink1 (fly) | `FB:FBgn0029891` |
| phenotype | APP (human) | `HGNC:620` |
| phenotype | Kras (mouse) | `MGI:96680` |
| phenotype | daf-18 (worm) | `WB:WBGene00000913` |
| alleles | SOD1 (yeast) | `SGD:S000003865` |
| expression | Brca1 (mouse) | `MGI:104537` |
| expression | Egfr (fly) | `FB:FBgn0003731` |
| expression | daf-18 (worm) | `WB:WBGene00000913` |
| expression | appa (zebrafish) | `ZFIN:ZDB-GENE-000616-13` |
| paralogues | EGFR (human, 3 paralogues) | `HGNC:3236` |
| paralogues | TP53 (human) | `HGNC:11998` |
| paralogues | pax6a (zebrafish) | `ZFIN:ZDB-GENE-990415-200` |
| disease models | Atm (mouse) | `MGI:107202` |
| disease models | Smn1 (mouse) | `MGI:109257` |
| allele phenotypes | Brca1 (mouse, 12) | `MGI:104537` |
| allele diseases | Pten (mouse, 18) | `MGI:109583` |

## Counts

Queried from the service after the build.

| Class | Rows |
|---|---|
| Gene | 169 |
| ExpressionAnnotation | 483 (429 with anatomy and stage) |
| Paralogue | 74 (59 genes: 31 human, 26 mouse, 2 zebrafish) |
| DiseaseModel | 50 (25 mouse genes) |
| Allele | 104 (100 with phenotype annotations, 16 with disease annotations, 16 with both) |
| PhenotypeAnnotation | 566 (300 on alleles) |
| DiseaseAnnotation | 684 (34 on alleles) |

Expression covers mouse 25, zebrafish 21, fly 18, worm 15, rat 20 and yeast 1 genes. Rat and
yeast rows have an assay, a location and PMIDs but no anatomy or stage.

## Differences from AllianceMine

- `Homologue.type` is empty. `alliance-orthologs` does not set it in AllianceMine either.
- Gene classes and `ProteinCodingGene` follow `alliance-genes`; no Chromosome sequences,
  locations, GO, interactions, publications metadata or SO terms are loaded.
- `alliance-expression` is edited in one line: it stored one annotation per gene (a map keyed
  by the gene item), so the other annotations were dangling references. The copy keys the map
  by the annotation. 483 of the 497 rows load.
- `alliance-disease-alleles_keys.properties` keys `Allele` on `primaryIdentifier` alone.
  `alliance-alleles` sets no organism on alleles, so the stock key `primaryIdentifier, organism`
  never matches and the source adds 16 alleles without a gene.
- `ExpressionAnnotation.publications` have `pubMedId` values with the `PMID:` prefix, as the
  AllianceMine converter writes them. Publications from the other sources have no prefix.
- Gene attributes `autoDescription`, `goDescription` and the other description fields are
  empty. `alliance-gene-descriptions` and `alliance-allele-detail` are not loaded: the data
  tracker records every field of a Gene or Allele created by `alliance-genes` or
  `alliance-alleles`, set or not, so a later source cannot fill them. Ranking them first in
  `genomic_priorities.properties` stops them matching their key, which doubled the genes.
  `Allele.alterationType`, `apiCategory` and `apiCrossReference` are empty for the same reason.
- Anatomy and assay names come from small OBO files built from the expression rows, not the
  full ontologies. The expression terms merge into them by identifier, so the ontology
  sources load before `alliance-expression`. GO terms of the cellular component column have
  no name.
- The real alleles that have phenotype rows are not in `alliance-alleles`, so the allele
  phenotype rows pair the real terms of the gene with the loaded alleles.
- Paralog pairs are real family relations (TP53 and TP63, EGFR and ERBB2, KRAS and HRAS).
  Identity, similarity, length and methods are random, except SMN1 and SMN2 (99) and KRAS
  with HRAS and NRAS (85 to 86).
- Only mouse genes have disease models. The matcher takes AGM names that start with the gene
  symbol and contain `[background:]`, and no non-mouse name matched.
- DOTerm names come from a small OBO built from the disease rows, not the full DOID file.
- Templates are the Biotestmine defaults, not the AllianceMine ones.
- `ORTHOLOGY-ALLIANCE_COMBINED.tsv` repeats its last 15 rows after the header, because
  `AllianceOrthologsConverter` drops the first 16 non-comment lines.
- The model lacks 3 of 236 AllianceMine classes (`CRISPRScreen`, `Component`, `Construct`)
  and 59 classes differ in reverse references added by sources that are not loaded, such as
  `Gene.variants`, `Gene.rnaiResults`, `Gene.crisprScreenResults`, `Allele.diseases`,
  `Allele.interactionsAsAllele1`, `DiseaseAnnotation.slimTerms`. `Homologue`,
  `PhenotypeAnnotation` and the fields behind `Gene.homologues`, `Gene.diseaseAnnotation`,
  `Gene.phenotypeAnnotations` and `Gene.alleles` are identical.
- `webconfig-model.xml` is the AllianceMine file minus its second `DiseaseAnnotation` block.
  The duplicate stops the webapp from starting.
- Solr can fail to start on the first try with `cp: preserving permissions ... zoo.cfg`.
  If so, delete `~/.local/share/intermine_boot/docker/data/solr/data/zoo.cfg` and
  `docker start solr` while the build runs.
