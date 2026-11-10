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
 * Reads disease-models.tsv (emitted by scripts/fetch_disease_models.py from
 * the Alliance /gene/{id}/models endpoint) and produces DiseaseModel items
 * linking a gene to an Affected Genomic Model and a DO disease term.
 *
 * @author
 */
public class AllianceDiseaseModelsConverter extends BioFileConverter
{
    private static final Logger LOG = Logger.getLogger(AllianceDiseaseModelsConverter.class);

    private static final String DATASET_TITLE = "Alliance Disease Models";
    private static final String DATA_SOURCE_NAME = "Alliance of Genome Resources";

    // Must match scripts/fetch_disease_models.py COLUMNS
    private static final int COL_SUBJECT_GENE_ID       = 0;
    private static final int COL_SUBJECT_GENE_TAXON    = 1;
    private static final int COL_MODEL_ID              = 2;
    private static final int COL_MODEL_NAME            = 3;
    private static final int COL_MODEL_SUBTYPE         = 4;
    private static final int COL_DATA_PROVIDER         = 5;
    private static final int COL_DISEASE_ID            = 6;
    private static final int COL_DISEASE_NAME          = 7;
    private static final int COL_ASSOCIATION_TYPE      = 8;
    private static final int COL_ASSOCIATED_PHENOTYPES = 9;
    private static final int COL_MODIFIERS             = 10;
    private static final int COL_HAS_DISEASE           = 11;
    private static final int COL_HAS_PHENOTYPE         = 12;
    private static final int MIN_COLUMNS               = 13;

    private final Map<String, String> genes = new HashMap<String, String>();
    private final Map<String, String> doTerms = new HashMap<String, String>();

    public AllianceDiseaseModelsConverter(ItemWriter writer, Model model) {
        super(writer, model, DATA_SOURCE_NAME, DATASET_TITLE);
    }

    /**
     * {@inheritDoc}
     */
    public void process(Reader reader) throws Exception {
        LOG.info("Processing Alliance disease models...");
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
        LOG.info("DiseaseModels: processed " + rows + " rows");
    }

    private void processRow(String[] line) throws ObjectStoreException {
        String geneId = line[COL_SUBJECT_GENE_ID].trim();
        String modelId = line[COL_MODEL_ID].trim();
        if (geneId.isEmpty() || modelId.isEmpty()) {
            return;
        }
        String geneRef = getGene(geneId, line[COL_SUBJECT_GENE_TAXON].trim());

        Item dm = createItem("DiseaseModel");
        dm.setReference("gene", geneRef);
        dm.setAttribute("modelId", modelId);
        setIfPresent(dm, "modelName", line[COL_MODEL_NAME]);
        setIfPresent(dm, "modelSubtype", line[COL_MODEL_SUBTYPE]);
        setIfPresent(dm, "dataProvider", line[COL_DATA_PROVIDER]);
        setIfPresent(dm, "associationType", line[COL_ASSOCIATION_TYPE]);
        setIfPresent(dm, "associatedPhenotypes", line[COL_ASSOCIATED_PHENOTYPES]);
        setIfPresent(dm, "modifierRelationshipTypes", line[COL_MODIFIERS]);
        setBoolIfPresent(dm, "hasDiseaseAnnotations", line[COL_HAS_DISEASE]);
        setBoolIfPresent(dm, "hasPhenotypeAnnotations", line[COL_HAS_PHENOTYPE]);

        String diseaseId = line[COL_DISEASE_ID].trim();
        if (!diseaseId.isEmpty()) {
            dm.setReference("disease", getDoTerm(diseaseId, line[COL_DISEASE_NAME].trim()));
        }
        store(dm);
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

    private String getDoTerm(String identifier, String name) throws ObjectStoreException {
        String ref = doTerms.get(identifier);
        if (ref != null) {
            return ref;
        }
        Item term = createItem("DOTerm");
        term.setAttribute("identifier", identifier);
        if (StringUtils.isNotEmpty(name)) {
            term.setAttribute("name", name);
        }
        store(term);
        doTerms.put(identifier, term.getIdentifier());
        return term.getIdentifier();
    }

    private static void setIfPresent(Item item, String attrName, String value) {
        if (value != null) {
            String v = value.trim();
            if (!v.isEmpty() && !"-".equals(v)) {
                item.setAttribute(attrName, v);
            }
        }
    }

    private static void setBoolIfPresent(Item item, String attrName, String value) {
        if (value == null) {
            return;
        }
        String v = value.trim().toLowerCase();
        if ("true".equals(v) || "false".equals(v)) {
            item.setAttribute(attrName, v);
        }
    }
}
