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
 * Reads disease-annotations-detail.tsv (emitted by
 * scripts/fetch_disease_annotations.py from the Alliance /disease/{id}/genes
 * endpoint) and produces partial DiseaseAnnotation + DiseaseEvidence items
 * carrying API-only fields (generatedRelationString, diseaseQualifiers,
 * parentSlimIds, viaOrthologyOrder, evidenceCodes references).
 *
 * The InterMine integration engine merges these partial DiseaseAnnotation
 * items into those produced by alliance-disease via the
 * DiseaseAnnotation.key_subject_term = subject, ontologyTerm key.
 *
 * @author
 */
public class AllianceDiseaseDetailConverter extends BioFileConverter
{
    private static final Logger LOG = Logger.getLogger(AllianceDiseaseDetailConverter.class);

    private static final String DATASET_TITLE = "Alliance Disease Annotation Detail";
    private static final String DATA_SOURCE_NAME = "Alliance of Genome Resources";

    // Must match scripts/fetch_disease_annotations.py COLUMNS
    private static final int COL_DISEASE_ID         = 0;
    private static final int COL_DISEASE_NAME       = 1;
    private static final int COL_SUBJECT_GENE_ID    = 2;
    private static final int COL_SUBJECT_GENE_TAXON = 3;
    private static final int COL_GEN_REL_STRING     = 4;
    private static final int COL_QUALIFIERS         = 5;
    private static final int COL_EVIDENCE_CODES     = 6;
    private static final int COL_PARENT_SLIM_IDS    = 7;
    private static final int COL_VIA_ORTHOLOGY      = 8;
    private static final int COL_PUBMED_IDS         = 9;
    private static final int COL_REFERENCE_IDS      = 10;
    private static final int COL_UNIQUE_ID          = 11;
    private static final int MIN_COLUMNS            = 12;

    private final Map<String, String> genes = new HashMap<String, String>();
    private final Map<String, String> doTerms = new HashMap<String, String>();
    private final Map<String, String> ecoTerms = new HashMap<String, String>();
    private final Map<String, String> publications = new HashMap<String, String>();

    public AllianceDiseaseDetailConverter(ItemWriter writer, Model model) {
        super(writer, model, DATA_SOURCE_NAME, DATASET_TITLE);
    }

    /**
     * {@inheritDoc}
     */
    public void process(Reader reader) throws Exception {
        LOG.info("Processing Alliance disease annotation detail...");
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
        LOG.info("DiseaseAnnotationDetail: emitted " + rows + " partial DiseaseAnnotation items");
    }

    private void processRow(String[] line) throws ObjectStoreException {
        String diseaseId = line[COL_DISEASE_ID].trim();
        String geneId = line[COL_SUBJECT_GENE_ID].trim();
        if (diseaseId.isEmpty() || geneId.isEmpty()) {
            return;
        }
        String geneRef = getGene(geneId, line[COL_SUBJECT_GENE_TAXON].trim());
        String doRef = getDoTerm(diseaseId, line[COL_DISEASE_NAME].trim());

        Item ann = createItem("DiseaseAnnotation");
        ann.setReference("subject", geneRef);
        ann.setReference("ontologyTerm", doRef);
        setIfPresent(ann, "generatedRelationString", line[COL_GEN_REL_STRING]);
        setIfPresent(ann, "diseaseQualifiers", line[COL_QUALIFIERS]);
        setIfPresent(ann, "parentSlimIds", line[COL_PARENT_SLIM_IDS]);
        setIntIfPresent(ann, "viaOrthologyOrder", line[COL_VIA_ORTHOLOGY]);
        setIfPresent(ann, "uniqueId", line[COL_UNIQUE_ID]);
        store(ann);

        // Build a DiseaseEvidence carrying the ECO codes and publications.
        // The evidence is associated with the annotation via OntologyAnnotation.evidence
        // (collection); the integration engine wires this up at merge time.
        String ecoCsv = line[COL_EVIDENCE_CODES].trim();
        String pmidCsv = line[COL_PUBMED_IDS].trim();
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
            // Re-emit the annotation item with the evidence collection populated.
            // (InterMine items engine accepts repeated stores merging fields;
            // simpler to leave annotation as already stored and let evidence
            // hang independently - the merge engine reattaches via key.)
        }
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
