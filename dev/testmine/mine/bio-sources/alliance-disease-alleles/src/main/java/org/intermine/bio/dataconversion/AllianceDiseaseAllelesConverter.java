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
 * Reads disease-alleles.tsv (emitted by scripts/fetch_disease_alleles.py
 * from the Alliance /disease/{id}/alleles endpoint) and produces partial
 * DiseaseAnnotation items linking alleles to diseases.
 *
 * Merged with sibling DiseaseAnnotation items via the integration key
 * DiseaseAnnotation.key_allele_term = alleleSubject, ontologyTerm.
 */
public class AllianceDiseaseAllelesConverter extends BioFileConverter
{
    private static final Logger LOG = Logger.getLogger(AllianceDiseaseAllelesConverter.class);

    private static final String DATASET_TITLE = "Alliance Disease-Allele Associations";
    private static final String DATA_SOURCE_NAME = "Alliance of Genome Resources";

    // Must match scripts/fetch_disease_alleles.py COLUMNS
    private static final int COL_DISEASE_ID    = 0;
    private static final int COL_DISEASE_NAME  = 1;
    private static final int COL_ALLELE_ID     = 2;
    private static final int COL_ALLELE_SYMBOL = 3;
    private static final int COL_ALLELE_TAXON  = 4;
    private static final int COL_RELATION      = 5;
    private static final int COL_ECO_CODES     = 6;
    private static final int COL_PMIDS         = 7;
    private static final int COL_EV_CURIE      = 8;
    private static final int COL_NEGATED       = 9;
    private static final int COL_DATA_PROVIDER = 10;
    private static final int MIN_COLUMNS       = 11;

    private final Map<String, String> alleles = new HashMap<String, String>();
    private final Map<String, String> doTerms = new HashMap<String, String>();
    private final Map<String, String> ecoTerms = new HashMap<String, String>();
    private final Map<String, String> publications = new HashMap<String, String>();

    public AllianceDiseaseAllelesConverter(ItemWriter writer, Model model) {
        super(writer, model, DATA_SOURCE_NAME, DATASET_TITLE);
    }

    public void process(Reader reader) throws Exception {
        LOG.info("Processing Alliance disease-allele associations...");
        Iterator<?> lineIter = FormattedTextParser.parseTabDelimitedReader(reader);
        int rows = 0;
        while (lineIter.hasNext()) {
            String[] line = (String[]) lineIter.next();
            if (line.length < MIN_COLUMNS) {
                continue;
            }
            if ("diseaseId".equals(line[COL_DISEASE_ID])) {
                continue;
            }
            processRow(line);
            rows++;
        }
        LOG.info("DiseaseAlleles: emitted " + rows + " partial DiseaseAnnotation items");
    }

    private void processRow(String[] line) throws ObjectStoreException {
        String diseaseId = line[COL_DISEASE_ID].trim();
        String alleleId = line[COL_ALLELE_ID].trim();
        if (diseaseId.isEmpty() || alleleId.isEmpty()) {
            return;
        }
        String alleleRef = getAllele(alleleId, line[COL_ALLELE_TAXON].trim(),
                                    line[COL_ALLELE_SYMBOL].trim());
        String doRef = getDoTerm(diseaseId, line[COL_DISEASE_NAME].trim());

        Item ann = createItem("DiseaseAnnotation");
        ann.setReference("alleleSubject", alleleRef);
        ann.setReference("ontologyTerm", doRef);
        setIfPresent(ann, "generatedRelationString", line[COL_RELATION]);
        store(ann);

        String ecoCsv = line[COL_ECO_CODES].trim();
        String pmidCsv = line[COL_PMIDS].trim();
        if (!ecoCsv.isEmpty() || !pmidCsv.isEmpty()) {
            Item ev = createItem("DiseaseEvidence");
            if (!ecoCsv.isEmpty()) {
                for (String token : ecoCsv.split("\\|")) {
                    String t = token.trim();
                    if (!t.isEmpty()) {
                        ev.addToCollection("evidenceCodes", getEcoTerm(t));
                    }
                }
            }
            if (!pmidCsv.isEmpty()) {
                for (String token : pmidCsv.split("\\|")) {
                    String pubRef = getPublication(token.trim());
                    if (pubRef != null) {
                        ev.addToCollection("publications", pubRef);
                    }
                }
            }
            store(ev);
            ann.addToCollection("evidence", ev);
        }
    }

    private String getAllele(String primaryId, String taxon, String symbol)
        throws ObjectStoreException {
        String ref = alleles.get(primaryId);
        if (ref != null) {
            return ref;
        }
        Item item = createItem("Allele");
        item.setAttribute("primaryIdentifier", primaryId);
        if (!symbol.isEmpty()) {
            item.setAttribute("alleleSymbol", symbol);
        }
        if (StringUtils.isNotEmpty(taxon)) {
            String taxonId = taxon.contains(":") ? taxon.substring(taxon.indexOf(':') + 1) : taxon;
            item.setReference("organism", getOrganism(taxonId));
        }
        store(item);
        alleles.put(primaryId, item.getIdentifier());
        return item.getIdentifier();
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

    private String getEcoTerm(String identifier) throws ObjectStoreException {
        String ref = ecoTerms.get(identifier);
        if (ref != null) {
            return ref;
        }
        Item term = createItem("ECOTerm");
        term.setAttribute("identifier", identifier);
        store(term);
        ecoTerms.put(identifier, term.getIdentifier());
        return term.getIdentifier();
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
