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

/*
 *
 * @author
 */
public class AllianceAllelesConverter extends BioFileConverter {

    private static final Logger LOG = Logger.getLogger(AllianceAllelesConverter.class);

    private static final String DATASET_TITLE = "Alliance Alleles data set";
    private static final String DATA_SOURCE_NAME = "DiOPT";
    private String licence;
    private Map<String, Item> genes = new HashMap<String, Item>();
    private Map<String, Item> alleles = new HashMap<String, Item>();
    private Map<String, Item> variants = new HashMap<String, Item>();
    private Map<String, Item> variantdetails = new HashMap<String, Item>();
    private Map<String, Item> alleleNames = new HashMap<String, Item>();
    // Synonym + CrossReference items reference a parent (Allele / Variant)
    // via `subject`. The parents are not stored until the end of process();
    // attempting to store the child inline (as the legacy code did) makes
    // the items DB's ProxyReference lookup return null at loadSingleSource
    // once the items DB grows beyond a few thousand rows. Buffer them and
    // store after the parents are written.
    private java.util.List<Item> pendingSynonyms = new java.util.ArrayList<Item>();
    private java.util.List<Item> pendingCrossRefs = new java.util.ArrayList<Item>();

    /**
     * Construct a new AllianceGenesConverter.
     *
     * @param database the database to read from
     * @param model    the Model used by the object store we will write to with the ItemWriter
     * @param writer   an ItemWriter used to handle Items created
     */
    public AllianceAllelesConverter(ItemWriter writer, Model model) {
        super(writer, model, DATA_SOURCE_NAME, DATASET_TITLE);
    }

    /**
     * {@inheritDoc}
     */
    public void process(Reader reader) throws Exception, ObjectStoreException {

        /*Taxon	SpeciesName	AlleleId	AlleleSymbol	AlleleSynonyms
        VariantId	VariantSymbol	VariantSynonyms	VariantCrossReferences
        AlleleAssociatedGeneId	AlleleAssociatedGeneSymbol	VariantAffectedGeneId
        VariantAffectedGeneSymbol	Category	VariantsTypeId	VariantsTypeName
        VariantsHgvsNames	Assembly	Chromosome	StartPosition
        EndPosition	SequenceOfReference	SequenceOfVariant	MostSevereConsequenceName
        VariantInformationReference	HasDiseaseAnnotations	HasPhenotypeAnnotations
         */
        Iterator<?> lineIter = FormattedTextParser.parseTabDelimitedReader(reader);
        boolean headerSeen = false;
        LOG.info("Processing Variant-Alleles...");
        while (lineIter.hasNext()) {

            String[] line = (String[]) lineIter.next();
            // Skip the FMS-shaped comment block (`#` rows) and the
            // column-header line. The legacy implementation skipped a
            // fixed 15 lines, which broke when the header block grew or
            // shrank between FMS releases.
            if (line.length == 0 || line[0].startsWith("#")) {
                continue;
            }
            if (!headerSeen && "Taxon".equalsIgnoreCase(line[0])) {
                headerSeen = true;
                continue;
            }
            if (!headerSeen) {
                // Pre-header padding line that isn't a comment — skip.
                continue;
            }
            //allele information
            String origspecies1 = line[0].trim().trim();
            String species = origspecies1.replace("NCBITaxon:", "").trim();
            String org = getOrganism(species).trim();
            String alleleId = line[2].trim();
            String alleleSymbol = line[3].trim();
            String alleleSynonym = line[4].trim();
            String variantId = line[5].trim();
            String variantSymbol = line[6].trim();
            String variantSynonym = line[7].trim();
            String variantCrossRefs = line[8].trim();
            String geneId = line[9].trim();
            String affectedGeneId = line[11].trim();
            String alleleType = line[13].trim();
            String variantsTypeId = line[14].trim();
            String variantType = line[15].trim();
            String variantHgvsName = line[16].trim();
            String assembly = line[17].trim();
            String chr = line[18].trim();
            String chrStart = line[19].trim();
            String chrEnd = line[20].trim();
            String seqRef = line[21].trim();
            String seqVariant = line[22].trim();
            String mostSevere = line[23].trim();
            String variantReference = line[24].trim();
            String hasDisease = line[25].trim();
            String hasPhenotype = line[26].trim();

            Item gene = null;
            if (StringUtils.isNotEmpty(geneId)) {
                gene = getGene(geneId, org);
            }
            // AlleleAssociatedGeneId (line 9) and VariantAffectedGeneId (line 11) can be distinct:
            // the allele is *associated* with one gene but the variant may *affect* another.
            Item affectedGene = null;
            if (StringUtils.isNotEmpty(affectedGeneId) && !"-".equals(affectedGeneId)
                    && !affectedGeneId.equals(geneId)) {
                affectedGene = getGene(affectedGeneId, org);
            }
            Item allele = processAlleles(alleleId, alleleSymbol, alleleSynonym, alleleType, variantId, variantSymbol, variantSynonym, variantCrossRefs, variantHgvsName, variantType, variantsTypeId, assembly, chr,
                    chrStart, chrEnd, seqRef, seqVariant, mostSevere, variantReference, hasDisease, hasPhenotype, affectedGene);
            if (gene != null) {
                allele.setReference("gene", gene);
                gene.addToCollection("alleles", allele);
            }
        }
        LOG.info("size of alleles: " + alleles.size());

        storeVariants();
        storeAlleles();
        storeGenes();
        // Flush pending Synonym + CrossReference items now that every parent
        // (Allele / Variant / Gene) is in the items DB. Storing children
        // inline above caused loadSingleSource to NPE on ProxyReference
        // resolution once the items DB grew past ~5k rows.
        LOG.info("flushing " + pendingSynonyms.size() + " synonyms + "
                 + pendingCrossRefs.size() + " cross-references");
        for (Item syn : pendingSynonyms) {
            store(syn);
        }
        pendingSynonyms.clear();
        for (Item cref : pendingCrossRefs) {
            store(cref);
        }
        pendingCrossRefs.clear();
    }

    /**
     * @param g1
     * @param s1
     * @param g2
     * @param s2
     * @param algorithm
     * @param match
     * @param total
     * @param best
     * @param reverse
     * @throws ObjectStoreException
     */
    private Item processAlleles(String alleleId, String alleleSymbol, String alleleSynonym, String alleleType,
                                String variantId, String variantSymbol, String variantSynonym, String variantCrossRefs,
                                String variantHgvsName, String variantType, String variantsTypeId, String assembly, String chr,
                                String chrStart, String chrEnd, String seqRef, String seqVariant, String mostSevere,
                                String variantReference, String hasDisease, String hasPhenotype, Item affectedGene)
            throws ObjectStoreException {

        Item allele = alleles.get(alleleId);

        if (allele == null) {

            allele = createItem("Allele");
            allele.setAttribute("featureType", "Allele");
            // D2: primaryIdentifier must be set so the integration engine can
            // merge AGR-source alleles with SGD-source alleles via the unified
            // Allele.key_primaryidentifier = primaryIdentifier, organism key.
            if (StringUtils.isNotEmpty(alleleId)) allele.setAttribute("primaryIdentifier", alleleId);
            if (StringUtils.isNotEmpty(alleleId)) allele.setAttribute("alleleId", alleleId);
            if (StringUtils.isNotEmpty(alleleSymbol)) allele.setAttribute("alleleSymbol", alleleSymbol);
            // Allele.synonyms is inherited from BioEntity; emit one Synonym item per pipe-separated token.
            createSynonyms(allele, alleleSynonym);
            if (StringUtils.isNotEmpty(alleleType)) allele.setAttribute("alleleType", alleleType);
            //String refId = allele.getIdentifier();
                    /*if(pmrefNo != null ) {
                        Item publication = publications.get(pmrefNo);
                        if (publication == null) {
                            publication = createItem("Publication");
                            publication.setAttribute("pubMedId", pmid);
                            publications.put(pmrefNo, publication);
                        }
                        allele.addToCollection("publications", publication);
                    }
                    if(gene != null) {
                        allele.setReference("gene", gene);
                        gene.addToCollection("alleles", allele);
                    }*/
            alleles.put(alleleId, allele);
            alleleNames.put(alleleId, allele);
        } //allele

        // Variant + VariantDetails emission removed 2026-05-14. The
        // sibling `alliance-variants` source loads the same Variants
        // from VARIANT-ALLELE-JSON via fetch_variants.py with the
        // current model shape (Variant + VariantConsequence) and merges
        // on Allele.primaryIdentifier. Emitting variants here too
        // caused load-time ProxyReference failures
        // ("Error retrieving object from Items database with identifier
        // 7_1") once the items DB grew past ~30k rows: the Variant
        // referenced from Allele.variants couldn't be resolved by
        // ParallelBatchingFetcher. Letting the dedicated Variant
        // source own that surface eliminates the conflict and the
        // duplicate work.
        return allele;
    }

    /**
     *
     * @param g
     * @param org
     * @return
     * @throws Exception
     */
    private Item getGene(String g, String org) throws ObjectStoreException {

        Item gene  = genes.get(g);
        if(gene == null) {
            gene = createItem("Gene");
            gene.setAttribute("primaryIdentifier", g);
            gene.setReference("organism", org);
            genes.put(g, gene);
        }
        return gene; //.getIdentifier();
    }

    // Split pipe-separated synonym list and emit one Synonym item per token, linked to the subject
    // via the inherited BioEntity.synonyms collection (Synonym.subject reverse-reference).
    private void createSynonyms(Item subject, String value) throws ObjectStoreException {
        if (StringUtils.isEmpty(value) || "-".equals(value)) {
            return;
        }
        for (String part : value.split("\\|")) {
            String v = part.trim();
            if (v.isEmpty() || "-".equals(v)) {
                continue;
            }
            Item syn = createItem("Synonym");
            syn.setReference("subject", subject);
            syn.setAttribute("value", v);
            pendingSynonyms.add(syn);
        }
    }

    // Split pipe-separated xref list and emit one CrossReference per token, linked to the subject
    // via the inherited BioEntity.crossReferences collection. Tokens in "DB:ID" form get their
    // prefix captured as dbxreftype.
    private void createCrossReferences(Item subject, String value) throws ObjectStoreException {
        if (StringUtils.isEmpty(value) || "-".equals(value)) {
            return;
        }
        for (String part : value.split("\\|")) {
            String v = part.trim();
            if (v.isEmpty() || "-".equals(v)) {
                continue;
            }
            Item cref = createItem("CrossReference");
            cref.setReference("subject", subject);
            cref.setAttribute("identifier", v);
            int colon = v.indexOf(':');
            if (colon > 0 && colon < v.length() - 1) {
                cref.setAttribute("dbxreftype", v.substring(0, colon));
            }
            pendingCrossRefs.add(cref);
        }
    }


    /**
     *
     * @throws ObjectStoreException
     */

    private void storeGenes() throws ObjectStoreException {
        for (Item gene : genes.values()) {
            try {
                store(gene);
            } catch (ObjectStoreException e) {
                throw new ObjectStoreException(e);
            }
        }
    }
    /**
     *
     * @throws ObjectStoreException
     */

    private void storeAlleles() throws ObjectStoreException {
        for (Item allele : alleles.values()) {
            try {
                store(allele);
            } catch (ObjectStoreException e) {
                throw new ObjectStoreException(e);
            }
        }
    }

    /**
     *
     * @throws ObjectStoreException
     */

    private void storeVariants() throws ObjectStoreException {
        for (Item variant : variants.values()) {
            try {
                store(variant);
            } catch (ObjectStoreException e) {
                throw new ObjectStoreException(e);
            }
        }
    }

}
