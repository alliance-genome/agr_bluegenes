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
 * Reads paralogs.tsv (emitted by scripts/fetch_paralogs.py from the Alliance
 * /gene/{id}/paralogs endpoint) and produces Paralogue items.
 *
 * @author
 */
public class AllianceParalogsConverter extends BioFileConverter
{
    private static final Logger LOG = Logger.getLogger(AllianceParalogsConverter.class);

    private static final String DATASET_TITLE = "Alliance Paralogs";
    private static final String DATA_SOURCE_NAME = "Alliance of Genome Resources";

    // Must match scripts/fetch_paralogs.py COLUMNS
    private static final int COL_SUBJECT_GENE_ID      = 0;
    private static final int COL_SUBJECT_GENE_SYMBOL  = 1;
    private static final int COL_SUBJECT_GENE_TAXON   = 2;
    private static final int COL_PARALOG_GENE_ID      = 3;
    private static final int COL_PARALOG_GENE_SYMBOL  = 4;
    private static final int COL_PARALOG_GENE_TAXON   = 5;
    private static final int COL_IDENTITY             = 6;
    private static final int COL_SIMILARITY           = 7;
    private static final int COL_LENGTH               = 8;
    private static final int COL_RANK                 = 9;
    private static final int COL_METHODS_MATCHED      = 10;
    private static final int COL_METHODS_NOT_MATCHED  = 11;
    private static final int COL_METHODS_NOT_CALLED   = 12;
    private static final int MIN_COLUMNS              = 13;

    private final Map<String, String> genes = new HashMap<String, String>();

    public AllianceParalogsConverter(ItemWriter writer, Model model) {
        super(writer, model, DATA_SOURCE_NAME, DATASET_TITLE);
    }

    /**
     * {@inheritDoc}
     */
    public void process(Reader reader) throws Exception {
        LOG.info("Processing Alliance paralogs...");
        Iterator<?> lineIter = FormattedTextParser.parseTabDelimitedReader(reader);
        int rows = 0;
        while (lineIter.hasNext()) {
            String[] line = (String[]) lineIter.next();
            if (line.length < MIN_COLUMNS) {
                continue;
            }
            if ("subjectGeneId".equals(line[COL_SUBJECT_GENE_ID])) {
                continue;  // TSV header
            }
            processRow(line);
            rows++;
        }
        LOG.info("Paralogs: processed " + rows + " rows");
    }

    private void processRow(String[] line) throws ObjectStoreException {
        String subjectId = line[COL_SUBJECT_GENE_ID].trim();
        String paralogId = line[COL_PARALOG_GENE_ID].trim();
        if (subjectId.isEmpty() || paralogId.isEmpty()) {
            return;
        }
        String subjectRef = getGene(subjectId, line[COL_SUBJECT_GENE_TAXON].trim());
        String paralogRef = getGene(paralogId, line[COL_PARALOG_GENE_TAXON].trim());

        Item para = createItem("Paralogue");
        para.setReference("gene", subjectRef);
        para.setReference("paralogue", paralogRef);
        setIntIfPresent(para, "identity", line[COL_IDENTITY]);
        setIntIfPresent(para, "similarity", line[COL_SIMILARITY]);
        setIntIfPresent(para, "length", line[COL_LENGTH]);
        setIntIfPresent(para, "rank", line[COL_RANK]);
        setIfPresent(para, "predictionMethodsMatched", line[COL_METHODS_MATCHED]);
        setIfPresent(para, "predictionMethodsNotMatched", line[COL_METHODS_NOT_MATCHED]);
        setIfPresent(para, "predictionMethodsNotCalled", line[COL_METHODS_NOT_CALLED]);
        store(para);
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

    private static void setIfPresent(Item item, String attrName, String value) {
        if (value != null) {
            String v = value.trim();
            if (!v.isEmpty() && !"-".equals(v)) {
                item.setAttribute(attrName, v);
            }
        }
    }

    private static void setIntIfPresent(Item item, String attrName, String value) {
        if (value == null) {
            return;
        }
        String v = value.trim();
        if (v.isEmpty() || "-".equals(v)) {
            return;
        }
        try {
            Integer.parseInt(v);
        } catch (NumberFormatException e) {
            return;
        }
        item.setAttribute(attrName, v);
    }
}
