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
 * Reads allele-phenotypes.tsv (emitted by
 * scripts/fetch_allele_phenotypes.py from the Alliance FMS PHENOTYPE
 * bulk files, filtered to rows with non-empty primaryGeneticEntityIDs)
 * and produces partial PhenotypeAnnotation items linking alleles to
 * phenotype ontology terms (MP/WBPhenotype/ZP/APO/FBcv depending on MOD).
 *
 * Merged with sibling PhenotypeAnnotation items via integration key
 * PhenotypeAnnotation.key_allele_term = alleleSubject, ontologyTerm.
 */
public class AllianceAllelePhenotypesConverter extends BioFileConverter
{
    private static final Logger LOG = Logger.getLogger(AllianceAllelePhenotypesConverter.class);

    private static final String DATASET_TITLE = "Alliance Allele Phenotype Annotations";
    private static final String DATA_SOURCE_NAME = "Alliance of Genome Resources";

    // Must match scripts/fetch_allele_phenotypes.py COLUMNS
    private static final int COL_GENE_ID       = 0;
    private static final int COL_ALLELE_ID     = 1;
    private static final int COL_TERM_ID       = 2;
    private static final int COL_STATEMENT     = 3;
    private static final int COL_PMID          = 4;
    private static final int COL_DATA_PROVIDER = 5;
    private static final int MIN_COLUMNS       = 6;

    private final Map<String, String> alleles = new HashMap<String, String>();
    private final Map<String, String> genes = new HashMap<String, String>();
    private final Map<String, String> terms = new HashMap<String, String>();
    private final Map<String, String> publications = new HashMap<String, String>();

    public AllianceAllelePhenotypesConverter(ItemWriter writer, Model model) {
        super(writer, model, DATA_SOURCE_NAME, DATASET_TITLE);
    }

    public void process(Reader reader) throws Exception {
        LOG.info("Processing Alliance allele phenotypes...");
        Iterator<?> lineIter = FormattedTextParser.parseTabDelimitedReader(reader);
        int rows = 0;
        while (lineIter.hasNext()) {
            String[] line = (String[]) lineIter.next();
            if (line.length < MIN_COLUMNS) {
                continue;
            }
            if ("geneId".equals(line[COL_GENE_ID])) {
                continue;
            }
            processRow(line);
            rows++;
        }
        LOG.info("AllelePhenotypes: emitted " + rows + " partial PhenotypeAnnotation items");
    }

    private void processRow(String[] line) throws ObjectStoreException {
        String alleleId = line[COL_ALLELE_ID].trim();
        String termId = line[COL_TERM_ID].trim();
        if (alleleId.isEmpty() || termId.isEmpty()) {
            return;
        }
        String alleleRef = getAllele(alleleId);
        String termRef = getOntologyTerm(termId);

        Item ann = createItem("PhenotypeAnnotation");
        ann.setReference("alleleSubject", alleleRef);
        ann.setReference("ontologyTerm", termRef);
        setIfPresent(ann, "phenotypeStatement", line[COL_STATEMENT]);

        // Subject = gene for downstream traversals.
        String geneId = line[COL_GENE_ID].trim();
        if (!geneId.isEmpty()) {
            ann.setReference("subject", getGene(geneId));
        }

        String pmid = line[COL_PMID].trim();
        if (!pmid.isEmpty() && pmid.startsWith("PMID:")) {
            String pubRef = getPublication(pmid);
            if (pubRef != null) {
                ann.addToCollection("publications", pubRef);
            }
        }
        store(ann);
    }

    private String getAllele(String primaryId) throws ObjectStoreException {
        String ref = alleles.get(primaryId);
        if (ref != null) {
            return ref;
        }
        Item item = createItem("Allele");
        item.setAttribute("primaryIdentifier", primaryId);
        store(item);
        alleles.put(primaryId, item.getIdentifier());
        return item.getIdentifier();
    }

    private String getGene(String primaryId) throws ObjectStoreException {
        String ref = genes.get(primaryId);
        if (ref != null) {
            return ref;
        }
        Item item = createItem("Gene");
        item.setAttribute("primaryIdentifier", primaryId);
        store(item);
        genes.put(primaryId, item.getIdentifier());
        return item.getIdentifier();
    }

    private String getOntologyTerm(String identifier) throws ObjectStoreException {
        String ref = terms.get(identifier);
        if (ref != null) {
            return ref;
        }
        Item term = createItem("OntologyTerm");
        term.setAttribute("identifier", identifier);
        store(term);
        terms.put(identifier, term.getIdentifier());
        return term.getIdentifier();
    }

    private String getPublication(String pubToken) throws ObjectStoreException {
        String ref = publications.get(pubToken);
        if (ref != null) {
            return ref;
        }
        Item pub = createItem("Publication");
        if (pubToken.startsWith("PMID:")) {
            pub.setAttribute("pubMedId", pubToken.substring("PMID:".length()));
        } else {
            return null;
        }
        store(pub);
        publications.put(pubToken, pub.getIdentifier());
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
