package org.intermine.bio.dataconversion;

/*
 * Copyright (C) 2002-2026 AllianceMine
 *
 * This code may be freely distributed and modified under the
 * terms of the GNU Lesser General Public Licence.  This should
 * be distributed with the code.  See the LICENSE file for more
 * information or http://www.gnu.org/copyleft/lesser.html.
 *
 */

import java.io.Reader;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

import org.apache.commons.lang.StringUtils;
import org.apache.log4j.Logger;
import org.intermine.dataconversion.ItemWriter;
import org.intermine.metadata.Model;
import org.intermine.objectstore.ObjectStoreException;
import org.intermine.util.FormattedTextParser;
import org.intermine.xml.full.Item;

/**
 * Reads phenotypes.tsv (emitted by scripts/fetch_phenotypes.py from the
 * Alliance /gene/{id}/phenotypes endpoint) and produces PhenotypeAnnotation
 * items attached to their subject Gene.
 *
 * @author
 */
public class AlliancePhenotypesConverter extends BioFileConverter
{
    private static final Logger LOG = Logger.getLogger(AlliancePhenotypesConverter.class);

    private static final String DATASET_TITLE = "Alliance Phenotype Annotations";
    private static final String DATA_SOURCE_NAME = "Alliance of Genome Resources";

    // Must match scripts/fetch_phenotypes.py COLUMNS
    private static final int COL_SUBJECT_GENE_ID     = 0;
    private static final int COL_SUBJECT_GENE_TAXON  = 1;
    private static final int COL_CATEGORY            = 2;
    private static final int COL_PHENOTYPE_STATEMENT = 3;
    private static final int COL_RELATION            = 4;
    private static final int COL_UNIQUE_ID           = 5;
    private static final int COL_PUBMED_IDS          = 6;
    private static final int COL_REFERENCE_IDS       = 7;
    private static final int MIN_COLUMNS             = 8;

    private final Map<String, String> genes = new HashMap<String, String>();
    private final Map<String, String> publications = new HashMap<String, String>();

    public AlliancePhenotypesConverter(ItemWriter writer, Model model) {
        super(writer, model, DATA_SOURCE_NAME, DATASET_TITLE);
    }

    /**
     * {@inheritDoc}
     */
    public void process(Reader reader) throws Exception {
        LOG.info("Processing Alliance phenotypes...");
        Iterator<?> lineIter = FormattedTextParser.parseTabDelimitedReader(reader);
        int rows = 0;
        while (lineIter.hasNext()) {
            String[] line = (String[]) lineIter.next();
            if (line.length < MIN_COLUMNS) {
                continue;
            }
            if ("subjectGeneId".equals(line[COL_SUBJECT_GENE_ID])) {
                continue;
            }
            processRow(line);
            rows++;
        }
        LOG.info("Phenotypes: processed " + rows + " rows");
    }

    private void processRow(String[] line) throws ObjectStoreException {
        String geneId = line[COL_SUBJECT_GENE_ID].trim();
        if (geneId.isEmpty()) {
            return;
        }
        String geneRef = getGene(geneId, line[COL_SUBJECT_GENE_TAXON].trim());

        Item pheno = createItem("PhenotypeAnnotation");
        pheno.setReference("subject", geneRef);
        setIfPresent(pheno, "phenotypeStatement", line[COL_PHENOTYPE_STATEMENT]);
        setIfPresent(pheno, "relation", line[COL_RELATION]);
        setIfPresent(pheno, "category", line[COL_CATEGORY]);
        setIfPresent(pheno, "uniqueId", line[COL_UNIQUE_ID]);

        // Pipe-separated list of PMIDs -> collection of Publication items
        String pmids = line[COL_PUBMED_IDS];
        if (StringUtils.isNotEmpty(pmids)) {
            for (String token : pmids.split("\\|")) {
                String pubRef = getPublication(token.trim());
                if (pubRef != null) {
                    pheno.addToCollection("publications", pubRef);
                }
            }
        }

        store(pheno);
    }

    private String getGene(String primaryId, String taxon) throws ObjectStoreException {
        String ref = genes.get(primaryId);
        if (ref != null) {
            return ref;
        }
        Item gene = createItem("Gene");
        gene.setAttribute("primaryIdentifier", primaryId);
        if (StringUtils.isNotEmpty(taxon)) {
            String taxonId = taxon.contains(":") ? taxon.substring(taxon.indexOf(':') + 1) : taxon;
            gene.setReference("organism", getOrganism(taxonId));
        }
        store(gene);
        genes.put(primaryId, gene.getIdentifier());
        return gene.getIdentifier();
    }

    private String getPublication(String pubToken) throws ObjectStoreException {
        if (pubToken == null) {
            return null;
        }
        String p = pubToken.trim();
        if (p.isEmpty() || "-".equals(p)) {
            return null;
        }
        String ref = publications.get(p);
        if (ref != null) {
            return ref;
        }
        Item pub = createItem("Publication");
        if (p.startsWith("PMID:")) {
            pub.setAttribute("pubMedId", p.substring("PMID:".length()));
        } else {
            pub.setAttribute("pubXrefId", p);
        }
        store(pub);
        publications.put(p, pub.getIdentifier());
        return pub.getIdentifier();
    }

    private static void setIfPresent(Item item, String attrName, String value) {
        if (value != null) {
            String v = value.trim();
            if (!v.isEmpty() && !"-".equals(v)) {
                item.setAttribute(attrName, v);
            }
        }
    }
}
