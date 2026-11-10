#!/usr/bin/env python3
"""Regenerate the test-mine input files under dev/testmine/mine/data/.

Real rows (disease annotations, mouse and yeast alleles, expression, disease
alleles, AGM names) are cut from the AllianceMine bio-sources
data checkout. Genes, orthologs, paralogs, phenotypes, disease models, allele
phenotypes and the small ontologies are hand-built from the tables below. Nothing
here contacts a network. Committed output is the source of truth for a normal build; run this only
to change the gene set.

    python3 -I dev/testmine/make_data.py [path/to/alliancemine-bio-sources/data]
"""
import random
import sys
from collections import OrderedDict, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "mine" / "data"
DEFAULT_SRC = Path.home() / "Projects/alliance/new_alliancemine/alliancemine-bio-sources/data"

# taxon -> (genus, species, shortName, commonName, data provider)
SPECIES = OrderedDict([
    ("9606", ("Homo", "sapiens", "H. sapiens", "human", "HGNC")),
    ("10090", ("Mus", "musculus", "M. musculus", "mouse", "MGI")),
    ("10116", ("Rattus", "norvegicus", "R. norvegicus", "rat", "RGD")),
    ("7955", ("Danio", "rerio", "D. rerio", "zebrafish", "ZFIN")),
    ("7227", ("Drosophila", "melanogaster", "D. melanogaster", "fruit fly", "FB")),
    ("6239", ("Caenorhabditis", "elegans", "C. elegans", "nematode", "WB")),
    ("559292", ("Saccharomyces", "cerevisiae", "S. cerevisiae", "yeast", "SGD")),
])
SPECIES_NAME = {t: "%s %s" % (v[0], v[1]) for t, v in SPECIES.items()}

# Family: (name, human chr, mouse chr, [(taxon, id, symbol), ...]). Ids are the
# Alliance primary identifiers found in the disease data.
FAMILIES = OrderedDict([
    ("TP53", ("tumor protein p53", "17", "11", [
        ("9606", "HGNC:11998", "TP53"), ("10090", "MGI:98834", "Trp53"), ("10116", "RGD:3889", "Tp53"),
        ("7955", "ZFIN:ZDB-GENE-990415-270", "tp53"), ("7227", "FB:FBgn0039044", "p53"),
        ("6239", "WB:WBGene00000467", "cep-1")])),
    ("BRCA2", ("BRCA2 DNA repair associated", "13", "5", [
        ("9606", "HGNC:1101", "BRCA2"), ("10090", "MGI:109337", "Brca2"), ("10116", "RGD:2219", "Brca2"),
        ("7955", "ZFIN:ZDB-GENE-060510-3", "brca2"), ("7227", "FB:FBgn0050169", "Brca2")])),
    ("PTEN", ("phosphatase and tensin homolog", "10", "19", [
        ("9606", "HGNC:9588", "PTEN"), ("10090", "MGI:109583", "Pten"), ("10116", "RGD:61995", "Pten"),
        ("7227", "FB:FBgn0026379", "Pten"), ("6239", "WB:WBGene00000913", "daf-18")])),
    ("APP", ("amyloid beta precursor protein", "21", "16", [
        ("9606", "HGNC:620", "APP"), ("10090", "MGI:88059", "App"), ("10116", "RGD:2139", "App"),
        ("7955", "ZFIN:ZDB-GENE-000616-13", "appa"), ("7227", "FB:FBgn0000108", "Appl"),
        ("6239", "WB:WBGene00000149", "apl-1")])),
    ("SOD1", ("superoxide dismutase 1", "21", "16", [
        ("9606", "HGNC:11179", "SOD1"), ("10090", "MGI:98351", "Sod1"), ("10116", "RGD:3731", "Sod1"),
        ("7955", "ZFIN:ZDB-GENE-990415-258", "sod1"), ("7227", "FB:FBgn0003462", "Sod1"),
        ("6239", "WB:WBGene00004930", "sod-1"), ("559292", "SGD:S000003865", "SOD1")])),
    ("HTT", ("huntingtin", "4", "5", [
        ("9606", "HGNC:4851", "HTT"), ("10090", "MGI:96067", "Htt"), ("10116", "RGD:68337", "Htt"),
        ("7955", "ZFIN:ZDB-GENE-990415-131", "htt"), ("7227", "FB:FBgn0027655", "htt")])),
    ("CFTR", ("CF transmembrane conductance regulator", "7", "6", [
        ("9606", "HGNC:1884", "CFTR"), ("10090", "MGI:88388", "Cftr"), ("10116", "RGD:2332", "Cftr"),
        ("7955", "ZFIN:ZDB-GENE-050517-20", "cftr"), ("7227", "FB:FBgn0039207", "Cftr")])),
    ("PINK1", ("PTEN induced kinase 1", "1", "4", [
        ("9606", "HGNC:14581", "PINK1"), ("10090", "MGI:1916193", "Pink1"), ("10116", "RGD:1305769", "Pink1"),
        ("7955", "ZFIN:ZDB-GENE-041212-53", "pink1"), ("7227", "FB:FBgn0029891", "Pink1"),
        ("6239", "WB:WBGene00017137", "pink-1")])),
    ("PARK7", ("Parkinsonism associated deglycase", "1", "4", [
        ("9606", "HGNC:16369", "PARK7"), ("10090", "MGI:2135637", "Park7"), ("10116", "RGD:621808", "Park7"),
        ("7955", "ZFIN:ZDB-GENE-041010-5", "park7"), ("6239", "WB:WBGene00015184", "djr-1.1")])),
    ("LRRK2", ("leucine rich repeat kinase 2", "12", "15", [
        ("9606", "HGNC:18618", "LRRK2"), ("10090", "MGI:1913975", "Lrrk2"), ("10116", "RGD:1561168", "Lrrk2"),
        ("7955", "ZFIN:ZDB-GENE-071218-6", "lrrk2"), ("7227", "FB:FBgn0038816", "Lrrk"),
        ("6239", "WB:WBGene00003068", "lrk-1")])),
    ("EGFR", ("epidermal growth factor receptor", "7", "11", [
        ("9606", "HGNC:3236", "EGFR"), ("10090", "MGI:95294", "Egfr"), ("10116", "RGD:2543", "Egfr"),
        ("7955", "ZFIN:ZDB-GENE-030918-1", "egfra"), ("7227", "FB:FBgn0003731", "Egfr"),
        ("6239", "WB:WBGene00002299", "let-23")])),
    ("KRAS", ("KRAS proto-oncogene, GTPase", "12", "6", [
        ("9606", "HGNC:6407", "KRAS"), ("10090", "MGI:96680", "Kras"), ("10116", "RGD:2981", "Kras"),
        ("7955", "ZFIN:ZDB-GENE-040808-67", "kras"), ("7227", "FB:FBgn0003205", "Ras85D"),
        ("6239", "WB:WBGene00002335", "let-60")])),
    ("MTOR", ("mechanistic target of rapamycin kinase", "1", "4", [
        ("9606", "HGNC:3942", "MTOR"), ("10090", "MGI:1928394", "Mtor"), ("10116", "RGD:68371", "Mtor"),
        ("7955", "ZFIN:ZDB-GENE-030131-2974", "mtor"), ("6239", "WB:WBGene00002583", "let-363")])),
    ("FMR1", ("FMRP translational regulator 1", "X", "X", [
        ("9606", "HGNC:3775", "FMR1"), ("10090", "MGI:95564", "Fmr1"), ("10116", "RGD:2623", "Fmr1"),
        ("7955", "ZFIN:ZDB-GENE-020731-6", "fmr1"), ("7227", "FB:FBgn0028734", "Fmr1")])),
    ("SMN1", ("survival of motor neuron 1, telomeric", "5", "13", [
        ("9606", "HGNC:11117", "SMN1"), ("10090", "MGI:109257", "Smn1"), ("10116", "RGD:620755", "Smn1"),
        ("7955", "ZFIN:ZDB-GENE-990715-16", "smn1"), ("7227", "FB:FBgn0036641", "Smn"),
        ("6239", "WB:WBGene00004887", "smn-1")])),
    ("TARDBP", ("TAR DNA binding protein", "1", "4", [
        ("9606", "HGNC:11571", "TARDBP"), ("10090", "MGI:2387629", "Tardbp"), ("10116", "RGD:1310906", "Tardbp"),
        ("7227", "FB:FBgn0025790", "TBPH"), ("6239", "WB:WBGene00006514", "tdp-1")])),
    ("NOTCH1", ("notch receptor 1", "9", "2", [
        ("9606", "HGNC:7881", "NOTCH1"), ("10090", "MGI:97363", "Notch1"), ("10116", "RGD:3187", "Notch1"),
        ("7955", "ZFIN:ZDB-GENE-990415-173", "notch1a"), ("7227", "FB:FBgn0004647", "N"),
        ("6239", "WB:WBGene00003001", "lin-12")])),
    ("NF1", ("neurofibromin 1", "17", "11", [
        ("9606", "HGNC:7765", "NF1"), ("10090", "MGI:97306", "Nf1"), ("10116", "RGD:3168", "Nf1"),
        ("7955", "ZFIN:ZDB-GENE-030131-4907", "nf1a"), ("7227", "FB:FBgn0015269", "Nf1")])),
    ("GBA1", ("glucosylceramidase beta 1", "1", "3", [
        ("9606", "HGNC:4177", "GBA1"), ("10090", "MGI:95665", "Gba1"), ("10116", "RGD:1589149", "Gba1"),
        ("7955", "ZFIN:ZDB-GENE-100922-270", "gba1"), ("7227", "FB:FBgn0051414", "Gba1b")])),
    ("ATM", ("ATM serine/threonine kinase", "11", "9", [
        ("9606", "HGNC:795", "ATM"), ("10090", "MGI:107202", "Atm"), ("10116", "RGD:1593265", "Atm"),
        ("7955", "ZFIN:ZDB-GENE-040809-1", "atm"), ("7227", "FB:FBgn0045035", "tefu"),
        ("6239", "WB:WBGene00000227", "atm-1")])),
    ("MECP2", ("methyl-CpG binding protein 2", "X", "X", [
        ("9606", "HGNC:6990", "MECP2"), ("10090", "MGI:99918", "Mecp2"), ("10116", "RGD:3075", "Mecp2"),
        ("7955", "ZFIN:ZDB-GENE-030131-7190", "mecp2")])),
    ("SNCA", ("synuclein alpha", "4", "6", [
        ("9606", "HGNC:11138", "SNCA"), ("10090", "MGI:1277151", "Snca"), ("10116", "RGD:3729", "Snca")])),
    ("MAPT", ("microtubule associated protein tau", "17", "11", [
        ("9606", "HGNC:6893", "MAPT"), ("10090", "MGI:97180", "Mapt"), ("10116", "RGD:69329", "Mapt"),
        ("7227", "FB:FBgn0266579", "tau")])),
    ("BRCA1", ("BRCA1 DNA repair associated", "17", "11", [
        ("9606", "HGNC:1100", "BRCA1"), ("10090", "MGI:104537", "Brca1"), ("10116", "RGD:2218", "Brca1"),
        ("6239", "WB:WBGene00000264", "brc-1")])),
    ("PAX6", ("paired box 6", "11", "2", [
        ("9606", "HGNC:8620", "PAX6"), ("10090", "MGI:97490", "Pax6"), ("10116", "RGD:3258", "Pax6"),
        ("7955", "ZFIN:ZDB-GENE-990415-200", "pax6a"), ("7955", "ZFIN:ZDB-GENE-001031-1", "pax6b"),
        ("7227", "FB:FBgn0005558", "ey"), ("6239", "WB:WBGene00006870", "vab-3")])),
])

# Human cross references (NCBI Gene, Ensembl, UniProtKB) for the human member of a family.
HUMAN_XREFS = {
    "TP53": ("7157", "ENSG00000141510", "P04637"), "BRCA2": ("675", "ENSG00000139618", "P51587"),
    "PTEN": ("5728", "ENSG00000171862", "P60484"), "APP": ("351", "ENSG00000142192", "P05067"),
    "SOD1": ("6647", "ENSG00000142168", "P00441"), "HTT": ("3064", "ENSG00000197386", "P42858"),
    "CFTR": ("1080", "ENSG00000001626", "P13569"), "PINK1": ("65018", "ENSG00000158828", "Q9BXM7"),
    "PARK7": ("11315", "ENSG00000116288", "Q99497"), "LRRK2": ("120892", "ENSG00000188906", "Q5S007"),
    "EGFR": ("1956", "ENSG00000146648", "P00533"), "KRAS": ("3845", "ENSG00000133703", "P01116"),
    "MTOR": ("2475", "ENSG00000198793", "P42345"), "FMR1": ("2332", "ENSG00000102081", "Q06787"),
    "SMN1": ("6606", "ENSG00000172062", "Q16637"), "TARDBP": ("23435", "ENSG00000120948", "Q13148"),
    "NOTCH1": ("4851", "ENSG00000148400", "P46531"), "NF1": ("4763", "ENSG00000196712", "P21359"),
    "GBA1": ("2629", "ENSG00000177628", "P04062"), "ATM": ("472", "ENSG00000149311", "Q13315"),
    "MECP2": ("4204", "ENSG00000169057", "P51608"), "SNCA": ("6622", "ENSG00000145335", "P37840"),
    "MAPT": ("4137", "ENSG00000186868", "P10636"), "BRCA1": ("672", "ENSG00000012048", "P38398"),
    "PAX6": ("5080", "ENSG00000007372", "P26367"),
}

# Two generic phenotype statements per family, reused with a species flavour.
PHENOTYPES = {
    "TP53": ["increased tumor incidence", "abnormal apoptosis"],
    "BRCA2": ["abnormal DNA repair", "embryonic lethality"],
    "PTEN": ["increased cell size", "abnormal growth"],
    "APP": ["abnormal synaptic transmission", "abnormal locomotor behavior"],
    "SOD1": ["decreased lifespan", "motor neuron degeneration"],
    "HTT": ["abnormal motor coordination", "neuron degeneration"],
    "CFTR": ["abnormal ion transport", "abnormal intestine morphology"],
    "PINK1": ["abnormal mitochondrion morphology", "dopaminergic neuron degeneration"],
    "PARK7": ["increased sensitivity to oxidative stress", "abnormal locomotor behavior"],
    "LRRK2": ["abnormal dopamine level", "abnormal locomotor behavior"],
    "EGFR": ["abnormal epithelium development", "decreased viability"],
    "KRAS": ["abnormal cell proliferation", "embryonic lethality"],
    "MTOR": ["decreased body size", "abnormal autophagy"],
    "FMR1": ["abnormal learning", "abnormal neuron morphology"],
    "SMN1": ["abnormal neuromuscular junction", "decreased lifespan"],
    "TARDBP": ["abnormal motor behavior", "protein aggregation"],
    "NOTCH1": ["abnormal cell fate specification", "abnormal vasculature development"],
    "NF1": ["abnormal growth", "increased tumor incidence"],
    "GBA1": ["abnormal lipid level", "neuron degeneration"],
    "ATM": ["abnormal DNA damage response", "abnormal cerebellum morphology"],
    "MECP2": ["abnormal social behavior", "abnormal breathing pattern"],
    "SNCA": ["abnormal dopamine level", "abnormal motor behavior"],
    "MAPT": ["abnormal axon morphology", "abnormal learning"],
    "BRCA1": ["abnormal DNA repair", "embryonic lethality"],
    "PAX6": ["abnormal eye development", "abnormal brain development"],
}

# Paralog partners that are not in a family above: (taxon, id, symbol, name). They are
# loaded as genes so Gene.paralogues.paralogue.symbol resolves.
PARTNERS = [
    ("9606", "HGNC:15979", "TP63", "tumor protein p63"), ("9606", "HGNC:12003", "TP73", "tumor protein p73"),
    ("9606", "HGNC:3430", "ERBB2", "erb-b2 receptor tyrosine kinase 2"),
    ("9606", "HGNC:3431", "ERBB3", "erb-b2 receptor tyrosine kinase 3"),
    ("9606", "HGNC:3432", "ERBB4", "erb-b2 receptor tyrosine kinase 4"),
    ("9606", "HGNC:5173", "HRAS", "HRas proto-oncogene, GTPase"),
    ("9606", "HGNC:7989", "NRAS", "NRAS proto-oncogene, GTPase"),
    ("9606", "HGNC:11181", "SOD3", "superoxide dismutase 3"), ("9606", "HGNC:11140", "SNCB", "synuclein beta"),
    ("9606", "HGNC:11141", "SNCG", "synuclein gamma"), ("9606", "HGNC:7882", "NOTCH2", "notch receptor 2"),
    ("9606", "HGNC:7883", "NOTCH3", "notch receptor 3"), ("9606", "HGNC:597", "APLP1", "amyloid beta precursor like protein 1"),
    ("9606", "HGNC:598", "APLP2", "amyloid beta precursor like protein 2"),
    ("9606", "HGNC:6839", "MAP2", "microtubule associated protein 2"),
    ("9606", "HGNC:6862", "MAP4", "microtubule associated protein 4"),
    ("9606", "HGNC:18608", "LRRK1", "leucine rich repeat kinase 1"),
    ("9606", "HGNC:4023", "FXR1", "FMR1 autosomal homolog 1"), ("9606", "HGNC:4024", "FXR2", "FMR1 autosomal homolog 2"),
    ("9606", "HGNC:11118", "SMN2", "survival of motor neuron 2, centromeric"),
    ("10090", "MGI:1330810", "Trp63", "transformation related protein 63"),
    ("10090", "MGI:1336991", "Trp73", "transformation related protein 73"),
    ("10090", "MGI:95410", "Erbb2", "erb-b2 receptor tyrosine kinase 2"),
    ("10090", "MGI:95411", "Erbb3", "erb-b2 receptor tyrosine kinase 3"),
    ("10090", "MGI:96224", "Hras", "Harvey rat sarcoma virus oncogene"),
    ("10090", "MGI:97376", "Nras", "neuroblastoma ras oncogene"),
    ("10090", "MGI:103181", "Sod3", "superoxide dismutase 3, extracellular"),
    ("10090", "MGI:1889011", "Sncb", "synuclein, beta"), ("10090", "MGI:97364", "Notch2", "notch 2"),
    ("10090", "MGI:99460", "Notch3", "notch 3"), ("10090", "MGI:88046", "Aplp1", "amyloid beta precursor-like protein 1"),
    ("10090", "MGI:88047", "Aplp2", "amyloid beta precursor-like protein 2"),
    ("10090", "MGI:97175", "Map2", "microtubule-associated protein 2"),
    ("10090", "MGI:2142227", "Lrrk1", "leucine-rich repeat kinase 1"),
    ("10090", "MGI:104860", "Fxr1", "FMR1 autosomal homolog 1"), ("10090", "MGI:1346074", "Fxr2", "FMR1 autosomal homolog 2"),
]

# Paralog pairs, written in both directions: (gene id, [partner ids]). Zebrafish
# pax6a and pax6b are both family members, so they need no partner rows.
PARALOG_PAIRS = [
    ("HGNC:11998", ["HGNC:15979", "HGNC:12003"]), ("HGNC:3236", ["HGNC:3430", "HGNC:3431", "HGNC:3432"]),
    ("HGNC:6407", ["HGNC:5173", "HGNC:7989"]), ("HGNC:11179", ["HGNC:11181"]),
    ("HGNC:11138", ["HGNC:11140", "HGNC:11141"]), ("HGNC:7881", ["HGNC:7882", "HGNC:7883"]),
    ("HGNC:620", ["HGNC:597", "HGNC:598"]), ("HGNC:6893", ["HGNC:6839", "HGNC:6862"]),
    ("HGNC:18618", ["HGNC:18608"]), ("HGNC:3775", ["HGNC:4023", "HGNC:4024"]),
    ("HGNC:11117", ["HGNC:11118"]),
    ("MGI:98834", ["MGI:1330810", "MGI:1336991"]), ("MGI:95294", ["MGI:95410", "MGI:95411"]),
    ("MGI:96680", ["MGI:96224", "MGI:97376"]), ("MGI:98351", ["MGI:103181"]),
    ("MGI:1277151", ["MGI:1889011"]), ("MGI:97363", ["MGI:97364", "MGI:99460"]),
    ("MGI:88059", ["MGI:88046", "MGI:88047"]), ("MGI:97180", ["MGI:97175"]),
    ("MGI:1913975", ["MGI:2142227"]), ("MGI:95564", ["MGI:104860", "MGI:1346074"]),
    ("ZFIN:ZDB-GENE-990415-200", ["ZFIN:ZDB-GENE-001031-1"]),
]
# Identity overrides in percent for pairs that are near copies; every other pair gets 24 to 62.
IDENTITY_OVERRIDE = {frozenset(("HGNC:11117", "HGNC:11118")): 99, frozenset(("HGNC:6407", "HGNC:5173")): 86,
                     frozenset(("HGNC:6407", "HGNC:7989")): 85, frozenset(("MGI:96680", "MGI:96224")): 86,
                     frozenset(("MGI:96680", "MGI:97376")): 85}
PARALOG_METHODS = ["Ensembl Compara", "HGNC", "OMA", "OrthoFinder", "PANTHER", "PhylomeDB", "SonicParanoid",
                   "TreeFam", "ZFIN"]

# Real tissue-level expression is cut from the Alliance expression file. Rows per gene:
MAX_EXPR_ANATOMY_ROWS = 6
MAX_EXPR_OTHER_ROWS = 3
MAX_MODELS_PER_GENE = 2

ALGOS = ["Ensembl Compara", "Hieranoid", "InParanoid", "OMA", "OrthoFinder", "OrthoInspector",
         "PANTHER", "PhylomeDB", "Roundup", "SonicParanoid", "TreeFam", "ZFIN"]

MAX_DISEASE_ROWS_PER_GENE = 5


def write_tsv(path, rows, comments=()):
    with open(path, "w", newline="") as fh:
        for c in comments:
            fh.write(c + "\n")
        for r in rows:
            fh.write("\t".join(str(x) for x in r) + "\n")


def build_genes():
    header = ["Id", "SecondaryID", "Synonyms", "CrossRefs", "Name", "Symbol", "MOD-Description",
              "Auto-Description", "Species", "Chromosome", "Start", "End", "Strand", "SoTerm",
              "DateProduced", "DataProvider", "ModCrossRefCompleteUrl"]
    rows = [header]
    genes = []
    for fam, (name, hchr, mchr, members) in FAMILIES.items():
        for taxon, gid, sym in members:
            chrom = {"9606": hchr, "10090": mchr}.get(taxon, "Unassigned")
            xrefs = "[]"
            if taxon == "9606":
                n, e, u = HUMAN_XREFS[fam]
                xrefs = "[NCBI_Gene:%s, ENSEMBL:%s, UniProtKB:%s]" % (n, e, u)
            prov = SPECIES[taxon][4]
            rows.append([gid, "", "[]", xrefs, name, sym,
                         "Test mine entry for %s (%s)." % (sym, SPECIES[taxon][3]),
                         "%s is a member of the %s family." % (sym, fam),
                         "NCBITaxon:" + taxon, chrom, "null", "null", "+", "protein_coding_gene",
                         "2026-03-01T02:48:00.000+00:00", prov, ""])
            genes.append((fam, taxon, gid, sym))
    for taxon, gid, sym, name in PARTNERS:
        rows.append([gid, "", "[]", "[]", name, sym, "Test mine paralog partner %s (%s)." % (sym, SPECIES[taxon][3]),
                     "%s is a paralog partner gene." % sym, "NCBITaxon:" + taxon, "Unassigned", "null", "null", "+",
                     "protein_coding_gene", "2026-03-01T02:48:00.000+00:00", SPECIES[taxon][4], ""])
    write_tsv(OUT / "alliance-genes.tsv", rows)
    return genes


def build_orthologs(genes):
    rng = random.Random(20260301)
    by_fam = defaultdict(list)
    for fam, taxon, gid, sym in genes:
        by_fam[fam].append((taxon, gid, sym))
    comments = ["#" * 74, "#", "# Data type: Orthology", "# Data format: tsv",
                "# README: hand-built test data in the Alliance ORTHOLOGY-ALLIANCE layout",
                "# Source: dev/testmine/make_data.py", "# Orthology Filter: Stringent",
                "# Taxon IDs: " + ", ".join("NCBITaxon:" + t for t in SPECIES),
                "# Species: " + ", ".join(SPECIES_NAME[t] for t in SPECIES),
                "# Alliance Database Version: test", "# Date file generated (UTC): 2026-03-01 02:48",
                "#", "#" * 74]
    header = ["Gene1ID", "Gene1Symbol", "Gene1SpeciesTaxonID", "Gene1SpeciesName", "Gene2ID",
              "Gene2Symbol", "Gene2SpeciesTaxonID", "Gene2SpeciesName", "Algorithms", "AlgorithmsMatch",
              "OutOfAlgorithms", "IsBestScore", "IsBestRevScore"]
    rows = []
    detail = [["subjectGeneId", "subjectGeneTaxon", "orthologGeneId", "orthologGeneTaxon",
               "stringencyFilter", "predictionMethodsMatched", "predictionMethodsNotMatched",
               "predictionMethodsNotCalled"]]
    pairs = 0
    for fam, members in by_fam.items():
        for t1, g1, s1 in members:
            for t2, g2, s2 in members:
                if t1 == t2:
                    continue
                n = rng.randint(5, 12)
                matched = sorted(rng.sample(ALGOS, n))
                not_matched = [a for a in ALGOS if a not in matched]
                rows.append([g1, s1, "NCBITaxon:" + t1, SPECIES_NAME[t1], g2, s2, "NCBITaxon:" + t2,
                             SPECIES_NAME[t2], "|".join(matched), n, len(ALGOS),
                             "Yes" if rng.random() < 0.8 else "No", "Yes" if rng.random() < 0.8 else "No"])
                stringency = "stringent" if n >= 9 else ("moderate" if n >= 5 else "")
                detail.append([g1, "NCBITaxon:" + t1, g2, "NCBITaxon:" + t2, stringency,
                               "|".join(matched), "|".join(not_matched), ""])
                pairs += 1
    # AllianceOrthologsConverter drops the first 16 non-comment lines (header plus 15
    # rows). Repeat the last 15 rows up front so none of the pairs are lost; the
    # converter de-duplicates pairs.
    write_tsv(OUT / "ORTHOLOGY-ALLIANCE_COMBINED.tsv", [header] + rows[-15:] + rows, comments)
    write_tsv(OUT / "orthologs.tsv", detail)
    return pairs


def build_disease(genes, src, extra_doids=()):
    ids = {g[2]: (g[1], g[3]) for g in genes}
    per_gene = defaultdict(list)
    extra_names = {}
    comments = []
    header = None
    with open(src / "disease-alliance.tsv") as fh:
        for line in fh:
            if line.startswith("#"):
                comments.append(line.rstrip("\n"))
                continue
            r = line.rstrip("\n").split("\t")
            if r[0] == "Taxon":
                header = r
                continue
            if len(r) >= 18 and r[6] in extra_doids and r[7]:
                extra_names[r[6]] = r[7]
            if len(r) < 18 or r[2] != "gene" or r[3] not in ids:
                continue
            per_gene[r[3]].append(r)
    out = []
    terms = OrderedDict()
    detail = [["diseaseId", "diseaseName", "subjectGeneId", "subjectGeneTaxon", "generatedRelationString",
               "diseaseQualifiers", "evidenceCodes", "parentSlimIds", "viaOrthologyOrder", "pubmedIds",
               "referenceIds", "uniqueId"]]
    for gid, rows in per_gene.items():
        seen = set()
        picked = []
        # direct, PMID-referenced rows first, then one row per distinct disease
        for r in sorted(rows, key=lambda x: ("via_orthology" in x[5], bool(x[8]),
                                                 not x[15].startswith("PMID:"), x[6], x[15])):
            if r[6] in seen:
                continue
            seen.add(r[6])
            picked.append(r)
            if len(picked) == MAX_DISEASE_ROWS_PER_GENE:
                break
        for r in picked:
            out.append(r)
            terms[r[6]] = r[7]
            detail.append([r[6], r[7], gid, r[0], r[5], "", r[13], "", "0", r[15], r[15],
                           "%s|%s|%s" % (gid, r[6], r[15])])
    for doid in sorted(extra_doids):
        terms.setdefault(doid, extra_names.get(doid, doid))
    out.sort(key=lambda r: (r[0], r[3], r[6]))
    write_tsv(OUT / "disease-alliance.tsv", [header] + out, comments)
    write_tsv(OUT / "disease-annotations-detail.tsv", detail)
    with open(OUT / "ONTOLOGY_DOID.obo", "w") as fh:
        fh.write("format-version: 1.2\ndata-version: test\nontology: doid\n"
                 "default-namespace: disease_ontology\n\n")
        for doid, name in terms.items():
            fh.write("[Term]\nid: %s\nname: %s\nnamespace: disease_ontology\n\n" % (doid, name))
    return per_gene, len(out), len(terms)


def build_phenotypes(genes, per_gene):
    rows = [["subjectGeneId", "subjectGeneTaxon", "category", "phenotypeStatement", "relation", "uniqueId",
             "pubmedIds", "referenceIds"]]
    for fam, taxon, gid, sym in genes:
        pmids = []
        for r in per_gene.get(gid, []):
            if r[15].startswith("PMID:") and r[15] not in pmids:
                pmids.append(r[15])
        for i, stmt in enumerate(PHENOTYPES[fam]):
            pm = pmids[i] if i < len(pmids) else ""
            rows.append([gid, "NCBITaxon:" + taxon, "gene_phenotype_annotation", stmt, "has_phenotype",
                         "%s|%s|%s" % (gid, stmt.replace(" ", "_"), pm), pm, pm])
    write_tsv(OUT / "phenotypes.tsv", rows)
    return len(rows) - 1


def build_alleles(genes, src):
    wanted = {g[2] for g in genes}
    keep = defaultdict(list)
    comments = []
    header = None
    with open(src / "alliance-alleles.tsv") as fh:
        for line in fh:
            if line.startswith("#"):
                comments.append(line.rstrip("\n"))
                continue
            r = line.rstrip("\n").split("\t")
            if r[0] == "Taxon":
                header = r
                continue
            if len(r) >= 27 and r[9] in wanted and r[13] == "allele":
                keep[r[9]].append(r)
    out = []
    for gid, rows in keep.items():
        out.extend(rows[:4])
    write_tsv(OUT / "alliance-alleles.tsv", [header] + out, comments)
    return out


def build_organisms():
    rows = [["taxonId", "genus", "species", "name", "shortName", "commonName"]]
    for t, (g, s, short, common, _) in SPECIES.items():
        rows.append([t, g, s, "%s %s" % (g, s), short, common])
    write_tsv(OUT / "organisms.tsv", rows)


def read_tsv(path, skip_comments=True):
    with open(path) as fh:
        for line in fh:
            if skip_comments and line.startswith("#"):
                continue
            yield line.rstrip("\n").split("\t")


def build_disease_alleles(alleles, src):
    """Real DAF rows for alleles that are already loaded. The allele symbol and the empty taxon
    column are filled from alliance-alleles, so the two sources agree and the allele key
    (primaryIdentifier, organism) is complete."""
    symbol = {a[2]: (a[3], a[0]) for a in alleles}
    rows = [["diseaseId", "diseaseName", "alleleId", "alleleSymbol", "alleleTaxon", "relationName",
             "evidenceCodes", "evidencePmids", "evidenceCurie", "negated", "dataProvider"]]
    for r in read_tsv(src / "disease-alleles.tsv"):
        if r[0] == "diseaseId" or len(r) < 11 or r[2] not in symbol:
            continue
        r[3], r[4] = symbol[r[2]]
        rows.append(r[:11])
    write_tsv(OUT / "disease-alleles.tsv", rows)
    return rows[1:]


def build_allele_phenotypes(alleles, src):
    """Gives each mouse allele up to 3 phenotype terms. The terms, statements and PMIDs are real
    MGI allele-phenotype rows of the same gene. Which allele gets which row is arbitrary,
    because the real alleles with phenotype rows are not in the loaded allele set."""
    by_gene = defaultdict(list)
    wanted = {a[9] for a in alleles if a[0] == "NCBITaxon:10090"}
    for r in read_tsv(src / "allele-phenotypes.tsv"):
        if len(r) >= 6 and r[0] in wanted and r[4].startswith("PMID:"):
            by_gene[r[0]].append(r)
    rows = [["geneId", "alleleId", "termId", "phenotypeStatement", "evidencePmid", "dataProvider"]]
    for a in alleles:
        if a[0] != "NCBITaxon:10090":
            continue
        pool = {}
        for r in sorted(by_gene.get(a[9], []), key=lambda x: (x[2], x[4])):
            pool.setdefault(r[2], r)
        terms = sorted(pool)
        if not terms:
            continue
        start = int(a[2].split(":")[1]) % len(terms)
        for i in range(min(3, len(terms))):
            r = pool[terms[(start + i) % len(terms)]]
            rows.append([a[9], a[2], r[2], r[3], r[4], r[5]])
    write_tsv(OUT / "allele-phenotypes.tsv", rows)
    return len(rows) - 1


def build_paralogs(genes):
    rng = random.Random(20260310)
    sym = {g[2]: (g[1], g[3]) for g in genes}
    for taxon, gid, s_, _ in PARTNERS:
        sym[gid] = (taxon, s_)
    header = ["subjectGeneId", "subjectGeneSymbol", "subjectGeneTaxon", "paralogGeneId", "paralogGeneSymbol",
              "paralogGeneTaxon", "identity", "similarity", "length", "rank", "predictionMethodsMatched",
              "predictionMethodsNotMatched", "predictionMethodsNotCalled"]
    pairs = {}
    for gid, partners in PARALOG_PAIRS:
        for p in partners:
            key = frozenset((gid, p))
            ident = IDENTITY_OVERRIDE.get(key, rng.randint(24, 62))
            sim = min(99, ident + rng.randint(8, 18))
            pairs[key] = (ident, sim, rng.randint(180, 1600))
    per_subject = defaultdict(list)
    for key, (ident, sim, length) in pairs.items():
        a, b = sorted(key)
        per_subject[a].append((b, ident, sim, length))
        per_subject[b].append((a, ident, sim, length))
    rows = [header]
    for subj in sorted(per_subject):
        for rank, (par, ident, sim, length) in enumerate(sorted(per_subject[subj], key=lambda x: (-x[1], x[0])), 1):
            n = rng.randint(4, len(PARALOG_METHODS))
            matched = sorted(rng.sample(PARALOG_METHODS, n))
            rows.append([subj, sym[subj][1], "NCBITaxon:" + sym[subj][0], par, sym[par][1],
                         "NCBITaxon:" + sym[par][0], ident, sim, length, rank, "|".join(matched),
                         "|".join(m for m in PARALOG_METHODS if m not in matched), ""])
    write_tsv(OUT / "paralogs.tsv", rows)
    return len(rows) - 1, len(per_subject)


def build_disease_models(genes, per_gene, src):
    """Real AGM ids and names whose name starts with the gene symbol, linked to a real disease of
    the gene. Association type and the phenotype list are hand-built."""
    by_symbol = defaultdict(list)
    symbols = {(g[3], "NCBITaxon:" + g[1]) for g in genes}
    for r in read_tsv(src / "agms.tsv"):
        if len(r) < 5 or r[0] == "modelId":
            continue
        name = r[1]
        end = len(name)
        for ch in "<[/ ":
            i = name.find(ch)
            if i > 0:
                end = min(end, i)
        sym = name[:end]
        if (sym, r[3]) in symbols and r[2] == "genotype" and "[background:]" in name:
            by_symbol[(sym, r[3])].append(r)
    rows = [["subjectGeneId", "subjectGeneTaxon", "modelId", "modelName", "modelSubtype", "dataProvider",
             "diseaseId", "diseaseName", "associationType", "associatedPhenotypes", "modifierRelationshipTypes",
             "hasDiseaseAnnotations", "hasPhenotypeAnnotations"]]
    for fam, taxon, gid, sym in genes:
        diseases = []
        for r in per_gene.get(gid, []):
            if r[6] not in [d[0] for d in diseases]:
                diseases.append((r[6], r[7]))
        models = sorted(by_symbol.get((sym, "NCBITaxon:" + taxon), []), key=lambda r: r[0])[:MAX_MODELS_PER_GENE]
        if not diseases or not models:
            continue
        for i, m in enumerate(models):
            d = diseases[i % len(diseases)]
            rows.append([gid, "NCBITaxon:" + taxon, m[0], m[1], m[2], m[4], d[0], d[1], "is_model_of",
                         "|".join(PHENOTYPES[fam]), "", "true", "true"])
    write_tsv(OUT / "disease-models.tsv", rows)
    return len(rows) - 1, len({r[0] for r in rows[1:]})


ONTOLOGY_FILES = OrderedDict([("EMAPA", "ONTOLOGY_EMAPA.obo"), ("ZFA", "ONTOLOGY_ZFA.obo"),
                              ("WBbt", "ONTOLOGY_WBBT.obo"), ("FBbt", "ONTOLOGY_FBBT.obo"),
                              ("MMO", "ONTOLOGY_MMO.obo")])


def build_expression(genes, src):
    """Real Alliance expression rows. Genes with anatomy rows: up to 6 rows with distinct anatomy
    terms that have stage, assay and PMIDs. Other genes: up to 3 rows."""
    wanted = {g[2] for g in genes}
    head = []
    colhead = None
    per_gene = defaultdict(list)
    for line in open(src / "expression-alliance.tsv"):
        if line.startswith("#"):
            head.append(line.rstrip("\n"))
            continue
        r = line.rstrip("\n").split("\t")
        if r[0] == "Species":
            colhead = r
            continue
        if len(r) >= 23 and r[2] in wanted:
            per_gene[r[2]].append(r)
    names = defaultdict(dict)
    out = []
    for gid in sorted(per_gene):
        rows = per_gene[gid]
        full = sorted((r for r in rows if r[16] and r[5] and r[22] and r[6]), key=lambda r: (r[16], r[5]))
        picked, seen = [], set()
        for r in full:
            if r[16] in seen:
                continue
            seen.add(r[16])
            picked.append(r)
            if len(picked) == MAX_EXPR_ANATOMY_ROWS:
                break
        if not picked:
            seen_rows = set()
            for r in sorted((r for r in rows if r[22] and r[6]), key=lambda r: (r[4], r[6], r[8])):
                if tuple(r[4:22]) not in seen_rows and len(picked) < MAX_EXPR_OTHER_ROWS:
                    seen_rows.add(tuple(r[4:22]))
                    picked.append(r)
        for r in picked:
            out.append(r[:23])
            if r[16]:
                names[r[16].split(":")[0]][r[16]] = r[17]
            names["MMO"][r[6]] = r[7]
    # The converter skips the first 15 lines (14 comment lines plus the column header).
    write_tsv(OUT / "expression-alliance.tsv", [colhead[:23]] + out, head[:14])
    for prefix, fname in ONTOLOGY_FILES.items():
        with open(OUT / fname, "w") as fh:
            fh.write("format-version: 1.2\ndata-version: test\nontology: %s\n\n" % prefix.lower())
            for tid, name in sorted(names.get(prefix, {}).items()):
                fh.write("[Term]\nid: %s\nname: %s\n\n" % (tid, name))
    return len(out), len({r[2] for r in out}), {k: len(v) for k, v in names.items()}


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC
    OUT.mkdir(parents=True, exist_ok=True)
    genes = build_genes()
    pairs = build_orthologs(genes)
    alleles = build_alleles(genes, src)
    disease_alleles = build_disease_alleles(alleles, src)
    per_gene, ndis, nterms = build_disease(genes, src, {r[0] for r in disease_alleles})
    nph = build_phenotypes(genes, per_gene)
    build_organisms()
    nexp, nexp_genes, nterm_by_ont = build_expression(genes, src)
    npar, npar_genes = build_paralogs(genes)
    nmod, nmod_genes = build_disease_models(genes, per_gene, src)
    nap = build_allele_phenotypes(alleles, src)
    print("genes=%d partners=%d orthologs=%d disease_rows=%d do_terms=%d phenotypes=%d alleles=%d"
          % (len(genes), len(PARTNERS), pairs, ndis, nterms, nph, len(alleles)))
    print("expression_rows=%d expression_genes=%d ontology_terms=%s" % (nexp, nexp_genes, nterm_by_ont))
    print("paralog_rows=%d paralog_genes=%d disease_model_rows=%d disease_model_genes=%d"
          % (npar, npar_genes, nmod, nmod_genes))
    print("allele_phenotype_rows=%d disease_allele_rows=%d" % (nap, len(disease_alleles)))
    missing = [g[3] for g in genes if g[2] not in per_gene]
    print("genes without disease rows:", missing)


if __name__ == "__main__":
    main()
