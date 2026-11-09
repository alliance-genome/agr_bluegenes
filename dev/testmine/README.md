# AllianceMine test mine

A small local InterMine with the AllianceMine data model and 133 genes from 7 species. It
is for building BlueGenes features that read `Gene.homologues`, `Gene.diseaseAnnotation`,
`Gene.phenotypeAnnotations` and `Gene.alleles` without a 32 GB AllianceMine.

Service root: `http://localhost:9999/alliancetestmine`

## Start

Needs Docker and `intermine_boot` (`pip install intermine_boot 'setuptools<81'`).

    dev/testmine/start.sh        # full rebuild, replaces whatever runs on port 9999
    dev/testmine/start.sh stop
    lein testmine                # BlueGenes against it (no additional mines)

`start.sh` deletes `~/.local/share/intermine_boot` (a running Biotestmine goes with it),
builds the mine and starts Postgres, Solr and Tomcat containers. Set `INTERMINE_BOOT` if
the executable is not on `PATH`. The build takes 15 to 25 minutes (13 minutes on the last
run, amd64 builder image emulated on Apple silicon). The first run downloads the Maven
dependencies.

## How it is built

- `mine/bio-sources/` holds the AllianceMine bio-sources `alliance-genes`,
  `alliance-orthologs`, `alliance-ortholog-detail`, `alliance-disease`,
  `alliance-disease-detail`, `alliance-phenotypes`, `alliance-alleles` (unchanged copies,
  tests dropped) plus `testmine-organisms`, a 50-line loader for organism names so the build
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
| `alliance-alleles.tsv` | real rows (mouse and yeast) | up to 4 per gene |
| `organisms.tsv` | hand-built | 7 species |

Species: human HGNC, mouse MGI, rat RGD, zebrafish ZFIN, fly FB, worm WB, yeast SGD.
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

## Differences from AllianceMine

- `Homologue.type` is empty. `alliance-orthologs` does not set it in AllianceMine either.
- Gene classes and `ProteinCodingGene` follow `alliance-genes`; no Chromosome sequences,
  locations, GO, interactions, expression, publications metadata or SO terms are loaded.
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
