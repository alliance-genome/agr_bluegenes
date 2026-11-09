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
 * Reads orthologs.tsv (emitted by scripts/fetch_orthologs.py from the Alliance
 * /gene/{id}/orthologs endpoint) and produces partial Homologue items
 * carrying the per-algorithm method breakdown that the FMS DiOPT TSV doesn't
 * surface.
 *
 * The InterMine integration engine merges these partial Homologue items into
 * the ones produced by alliance-orthologs via Homologue.key_pair = gene,
 * homologue.
 *
 * @author
 */
public class AllianceOrthologDetailConverter extends BioFileConverter
{
    private static final Logger LOG = Logger.getLogger(AllianceOrthologDetailConverter.class);

    private static final String DATASET_TITLE = "Alliance Ortholog Detail";
    private static final String DATA_SOURCE_NAME = "Alliance of Genome Resources";

    // Must match scripts/fetch_orthologs.py COLUMNS
    private static final int COL_SUBJECT_GENE_ID    = 0;
    private static final int COL_SUBJECT_GENE_TAXON = 1;
    private static final int COL_ORTHOLOG_GENE_ID   = 2;
    private static final int COL_ORTHOLOG_GENE_TAXON = 3;
    private static final int COL_STRINGENCY_FILTER  = 4;
    private static final int COL_METHODS_MATCHED    = 5;
    private static final int COL_METHODS_NOT_MATCHED = 6;
    private static final int COL_METHODS_NOT_CALLED = 7;
    private static final int MIN_COLUMNS            = 8;

    private final Map<String, String> genes = new HashMap<String, String>();

    public AllianceOrthologDetailConverter(ItemWriter writer, Model model) {
        super(writer, model, DATA_SOURCE_NAME, DATASET_TITLE);
    }

    /**
     * {@inheritDoc}
     */
    public void process(Reader reader) throws Exception {
        LOG.info("Processing Alliance ortholog detail...");
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
            String geneId = line[COL_SUBJECT_GENE_ID].trim();
            String orthologId = line[COL_ORTHOLOG_GENE_ID].trim();
            if (geneId.isEmpty() || orthologId.isEmpty()) {
                continue;
            }
            String geneRef = getGene(geneId, line[COL_SUBJECT_GENE_TAXON].trim());
            String orthologRef = getGene(orthologId, line[COL_ORTHOLOG_GENE_TAXON].trim());

            Item h = createItem("Homologue");
            h.setReference("gene", geneRef);
            h.setReference("homologue", orthologRef);
            setIfPresent(h, "stringencyFilter", line[COL_STRINGENCY_FILTER]);
            setIfPresent(h, "predictionMethodsMatched", line[COL_METHODS_MATCHED]);
            setIfPresent(h, "predictionMethodsNotMatched", line[COL_METHODS_NOT_MATCHED]);
            setIfPresent(h, "predictionMethodsNotCalled", line[COL_METHODS_NOT_CALLED]);
            store(h);
            rows++;
        }
        LOG.info("OrthologDetail: emitted " + rows + " partial Homologue items");
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
}
