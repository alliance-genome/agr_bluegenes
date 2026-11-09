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
import java.text.SimpleDateFormat;
import java.util.Date;
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
public class AllianceGenesConverter extends BioFileConverter {

    private static final Logger LOG = Logger.getLogger(AllianceGenesConverter.class);

    private static final String DATASET_TITLE = "Alliance Gene data set";
    private static final String DATA_SOURCE_NAME = "AGR";

    // TSV column layout (first 14 columns are the legacy schema; columns 14-16
    // are appended by scripts/fetch_genes.py and stay optional so legacy
    // FMS-produced TSVs still load unchanged):
    // Id  SecondaryID  Synonyms  CrossRefs  Name  Symbol  MOD-Description
    // Auto-Description  Species  Chromosome  Start  End  Strand  SoTerm
    // [DateProduced  DataProvider  ModCrossRefCompleteUrl]
    private static final int COL_PRIMARY_ID = 0;
    private static final int COL_SECONDARY_ID = 1;
    private static final int COL_SYNONYMS = 2;
    private static final int COL_CROSSREFS = 3;
    private static final int COL_NAME = 4;
    private static final int COL_SYMBOL = 5;
    private static final int COL_DESCRIPTION = 6;
    private static final int COL_AUTO_DESCRIPTION = 7;
    private static final int COL_SPECIES = 8;
    private static final int COL_CHROMOSOME = 9;
    private static final int COL_START = 10;
    private static final int COL_END = 11;
    private static final int COL_STRAND = 12;
    private static final int COL_FEATURE_TYPE = 13;
    private static final int COL_COUNT = 14;
    // Optional API-enrichment columns appended by the Python fetcher.
    private static final int COL_DATE_PRODUCED = 14;
    private static final int COL_DATA_PROVIDER = 15;
    private static final int COL_MOD_URL = 16;

    private String licence;
    private Map<String, String> chromosomes = new HashMap<String, String>();
    private Map<String, String> plasmids = new HashMap<String, String>();
    private Map<String, String> sequences = new HashMap<String, String>();
    private Map<String, Item> genes = new HashMap<String, Item>();
    private Map<String, String> geneschromosomes = new HashMap<String, String>();
    private Map<Item, String> synonyms = new HashMap<Item, String>();
    private Map<Item, String> crossrefs = new HashMap<Item, String>();

    /**
     * Construct a new AllianceGenesConverter.
     * @param database the database to read from
     * @param model the Model used by the object store we will write to with the ItemWriter
     * @param writer an ItemWriter used to handle Items created
     */
    public AllianceGenesConverter(ItemWriter writer, Model model) {
        super(writer, model, DATA_SOURCE_NAME, DATASET_TITLE);
    }

    /**
     * {@inheritDoc}
     */
    public void process(Reader reader) throws Exception, ObjectStoreException {

        Iterator<?> lineIter = FormattedTextParser.parseTabDelimitedReader(reader);
        int count = 0;
        LOG.info("Processing Genes...");
        while (lineIter.hasNext()) {

            String[] line = (String[]) lineIter.next();
            if (count == 0) {
                count++;
                continue;
            }
            if (line.length < COL_COUNT) {
                continue;
            }
            String primaryIdentifier = line[COL_PRIMARY_ID].trim();
            String secondaryIdentifier = line[COL_SECONDARY_ID].trim();
            String synonyms = line[COL_SYNONYMS].trim();
            String crossrefs = line[COL_CROSSREFS].trim();
            String name = line[COL_NAME].trim();
            String symbol = line[COL_SYMBOL].trim();
            String description = line[COL_DESCRIPTION].trim();
            String autoDescription = line[COL_AUTO_DESCRIPTION].trim();
            String origspecies = line[COL_SPECIES].trim();
            if (!origspecies.startsWith("NCBITaxon:")) {
                continue;
            }
            String species = origspecies.replace("NCBITaxon:", "");
            String chromosome = line[COL_CHROMOSOME].trim();
            String start = line[COL_START].trim();
            String end = line[COL_END].trim();
            String strand = line[COL_STRAND].trim();
            String feature_type = line[COL_FEATURE_TYPE].trim();

            String chr = "";
            if (species.equals("559292")) {
                if (chromosome.equals("Mito")) {
                    chr = "chrmt";
                } else {
                    chr = "chr" + chromosome;
                }
            } else {
                chr = chromosome;
            }

            // ~~~ MOD and Chromosome ~~~
            String organism = getOrganism(species);
            String chrId = getChromosome(chr, organism);

            Item g = genes.get(primaryIdentifier);
            if (g != null) {
                String mcm = geneschromosomes.get(primaryIdentifier);
                if (!mcm.equals(chrId)) {
                    g.setReference("chromosome", mcm);
                }
                // ~~~ location ~~~
                if (!start.equals("null") || !end.equals("null")) {
                    String locationRefId = getLocation(g, chrId, start, end, strand);
                    g.setReference("chromosomeLocation", locationRefId);
                }
                continue;
            }
            Item item = null;
            if (feature_type.equalsIgnoreCase("RNase_MRP_RNA_gene")) {
                item = createItem("RNaseMRPRNAGene");
            } else if (feature_type.equalsIgnoreCase("RNase_P_RNA_gene")) {
                item = createItem("RNasePRNAGene");
            } else if (feature_type.equalsIgnoreCase("SRP_RNA_gene")) {
                item = createItem("SRPRNAGene");
            } else if (feature_type.equalsIgnoreCase("antisense_lncRNA_gene")) {
                item = createItem("AntisenseLncRNAGene");
            } else if (feature_type.equalsIgnoreCase("bidirectional_promoter_lncRNA")) {
                item = createItem("BidirectionalPromoterLncRNA");
            } else if (feature_type.equalsIgnoreCase("biological_region")) {
                item = createItem("BiologicalRegion");
            } else if (feature_type.equalsIgnoreCase("blocked_reading_frame")) {
                item = createItem("BlockedReadingFrame");
            } else if (feature_type.equalsIgnoreCase("gene")) {
                item = createItem("Gene");
            } else if (feature_type.equalsIgnoreCase("gene_segment")) {
                item = createItem("GeneSegment");
            } else if (feature_type.equalsIgnoreCase("heritable_phenotypic_marker")) {
                item = createItem("HeritablePhenotypicMarker");
            } else if (feature_type.equalsIgnoreCase("lincRNA_gene")) {
                item = createItem("LincRNAGene");
            } else if (feature_type.equalsIgnoreCase("lncRNA_gene")) {
                item = createItem("LncRNAGene");
            } else if (feature_type.equalsIgnoreCase("miRNA_gene")) {
                item = createItem("MiRNAGene");
            } else if (feature_type.equalsIgnoreCase("mt_rRNA")) {
                item = createItem("MtRRNA");
            } else if (feature_type.equalsIgnoreCase("mt_tRNA")) {
                item = createItem("MtTRNA");
            } else if (feature_type.equalsIgnoreCase("ncRNA_gene")) {
                item = createItem("NcRNAGene");
            } else if (feature_type.equalsIgnoreCase("piRNA_gene")) {
                item = createItem("PiRNAGene");
            } else if (feature_type.equalsIgnoreCase("polymorphic_pseudogene")) {
                item = createItem("PolymorphicPseudogene");
            } else if (feature_type.equalsIgnoreCase("polypeptide")) {
                item = createItem("Polypeptide");
            } else if (feature_type.equalsIgnoreCase("protein_coding_gene")) {
                item = createItem("ProteinCodingGene");
            } else if (feature_type.equalsIgnoreCase("pseudogene")) {
                item = createItem("Pseudogene");
            } else if (feature_type.equalsIgnoreCase("processed_pseudogene")) {
                item = createItem("ProcessedPseudogene");
            } else if (feature_type.equalsIgnoreCase("transcribed_processed_pseudogene")) {
                item = createItem("TranscribedProcessedPseudogene");
            }
            /*else if (feature_type.equalsIgnoreCase("transcribed_unprocessed_pseudogene")) {
                item = createItem("TranscribedUnprocessedPseudogene");
            }*/
            else if (feature_type.equalsIgnoreCase("non_processed_pseudogene")) {
                item = createItem("NonProcessedPseudogene");
            } else if (feature_type.equalsIgnoreCase("pseudogenic_gene_segment")) {
                item = createItem("PseudogenicGeneSegment");
            } else if (feature_type.equalsIgnoreCase("rRNA_gene")) {
                item = createItem("RRNAGene");
            } else if (feature_type.equalsIgnoreCase("cytosolic_rRNA_18S_gene")) {
                item = createItem("RRNAGene");
            } else if (feature_type.equalsIgnoreCase("cytosolic_rRNA_28S_gene")) {
                item = createItem("RRNAGene");
            } else if (feature_type.equalsIgnoreCase("cytosolic_rRNA_5S_gene")) {
                item = createItem("RRNAGene");
            } else if (feature_type.equalsIgnoreCase("cytosolic_rRNA_5_8S_gene")) {
                item = createItem("RRNAGene");
            } else if (feature_type.equalsIgnoreCase("cytosolic_rRNA_2S_gene")) {
                item = createItem("RRNAGene");
            } else if (feature_type.equalsIgnoreCase("ribozyme_gene")) {
                item = createItem("RibozymeGene");
            } else if (feature_type.equalsIgnoreCase("scRNA_gene")) {
                item = createItem("ScRNAGene");
            } else if (feature_type.equalsIgnoreCase("sbRNA_gene")) {
                item = createItem("SbRNAGene");
            } else if (feature_type.equalsIgnoreCase("sense_intronic_ncRNA_gene")) {
                item = createItem("SenseIntronicNcRNAGene");
            } else if (feature_type.equalsIgnoreCase("sense_overlap_ncRNA_gene")) {
                item = createItem("SenseOverlapNcRNAGene");
            } else if (feature_type.equalsIgnoreCase("snRNA_gene")) {
                item = createItem("SnRNAGene");
            } else if (feature_type.equalsIgnoreCase("snoRNA_gene")) {
                item = createItem("SnoRNAGene");
            } else if (feature_type.equalsIgnoreCase("scaRNA")) {
                item = createItem("ScaRNAGene");
            } else if (feature_type.equalsIgnoreCase("tRNA_gene")) {
                item = createItem("TRNAGene");
            } else if (feature_type.equalsIgnoreCase("telomerase_RNA_gene")) {
                item = createItem("TelomeraseRNAGene");
            } else if (feature_type.equalsIgnoreCase("transposable_element_gene")) {
                item = createItem("TransposableElementGene");
            } else if (feature_type.equalsIgnoreCase("non_transcribed_region")) {
                item = createItem("NonTranscribedRegion");
            } else if (feature_type.equalsIgnoreCase("unconfirmed_transcript")) {
                item = createItem("UnconfirmedTranscript");
            } else if (feature_type.equalsIgnoreCase("processed_transcript")) {
                item = createItem("ProcessedTranscript");
            } else if (feature_type.equalsIgnoreCase("antisense")) {
                item = createItem("Antisense");
            } else if (feature_type.equalsIgnoreCase("mt_LSU_rRNA_gene")) {
                item = createItem("MtLSURRNAGene");
            } else if (feature_type.equalsIgnoreCase("mt_SSU_rRNA_gene")) {
                item = createItem("MtSSURRNAGene");
            } else if (feature_type.equalsIgnoreCase("hpRNA_gene")) {
                item = createItem("HpRNAGene");
            } else if (feature_type.equalsIgnoreCase("C_D_box_scaRNA_gene")) {
                item = createItem("CDBoxScaRNAGene");
            } else if (feature_type.equalsIgnoreCase("C_D_box_snoRNA_gene")) {
                item = createItem("CDBoxSnoRNAGene");
            } else if (feature_type.equalsIgnoreCase("H_ACA_box_scaRNA_gene")) {
                item = createItem("HACABoxScaRNAGene");
            } else if (feature_type.equalsIgnoreCase("H_ACA_box_snoRNA_gene")) {
                item = createItem("HACABoxSnoRNAGene");
            } else if (feature_type.equalsIgnoreCase("IG_V_gene")) {
                item = createItem("IGVGene");
            } else if (feature_type.equalsIgnoreCase("RNA_7SK_gene")) {
                item = createItem("RNA7SKGene");
            } else if (feature_type.equalsIgnoreCase("TR_C_Gene")) {
                item = createItem("TRCGene");
            } else if (feature_type.equalsIgnoreCase("TR_J_Gene")) {
                item = createItem("TRJGene");
            } else if (feature_type.equalsIgnoreCase("TR_V_Gene")) {
                item = createItem("TRVGene");
            } else if (feature_type.equalsIgnoreCase("Y_RNA")) {
                item = createItem("YRNA");
            }
            if (item == null) {
                continue;
            }

            if (StringUtils.isNotEmpty(primaryIdentifier)) {
                item.setAttribute("primaryIdentifier", primaryIdentifier);
            }
            if (StringUtils.isNotEmpty(secondaryIdentifier) && !primaryIdentifier.startsWith("SGD:")) {
                item.setAttribute("secondaryIdentifier", secondaryIdentifier);
            }
            if (StringUtils.isNotEmpty(symbol)) {
                item.setAttribute("symbol", symbol);
            }
            if (StringUtils.isNotEmpty(name)) {
                item.setAttribute("name", name);
            }
            if (StringUtils.isNotEmpty(feature_type)) {
                item.setAttribute("featureType", feature_type);
            }
            if (StringUtils.isNotEmpty(description)) {
                item.setAttribute("modDescription", description);
            }
            if (StringUtils.isNotEmpty(autoDescription)) {
                item.setAttribute("automatedDescription", autoDescription);
            }
            // Optional API-enrichment columns (absent in legacy FMS-produced TSVs).
            if (line.length > COL_DATE_PRODUCED) {
                String dateProduced = line[COL_DATE_PRODUCED].trim();
                if (StringUtils.isNotEmpty(dateProduced)) {
                    try {
                        Date d = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX").parse(dateProduced);
                        item.setAttribute("dateProduced", new SimpleDateFormat("yyyy-MM-dd").format(d));
                    } catch (java.text.ParseException e) {
                        LOG.warn("Could not parse dateProduced '" + dateProduced + "': " + e.getMessage());
                    }
                }
            }
            if (line.length > COL_DATA_PROVIDER) {
                String dataProvider = line[COL_DATA_PROVIDER].trim();
                if (StringUtils.isNotEmpty(dataProvider)) {
                    item.setAttribute("dataProvider", dataProvider);
                }
            }
            if (line.length > COL_MOD_URL) {
                String modUrl = line[COL_MOD_URL].trim();
                if (StringUtils.isNotEmpty(modUrl)) {
                    item.setAttribute("modCrossRefCompleteUrl", modUrl);
                }
            }
            item.setReference("organism", organism);
            item.setReference("chromosome", chrId);
            // ~~~ location ~~~
            if (!start.equals("null") || !end.equals("null")) {
                String locationRefId = getLocation(item, chrId, start, end, strand);
                item.setReference("chromosomeLocation", locationRefId);
            }
            String refId = item.getIdentifier();
            //~~~synonyms~~~
            if (!synonyms.equals("[]")) {
                getSynonyms(refId, synonyms);
            }
            //~~~crossrefs~~~
            if (!crossrefs.equals("[]")) {
                getCrossReference(primaryIdentifier, refId, crossrefs);
            }
            genes.put(primaryIdentifier, item);
            geneschromosomes.put(primaryIdentifier, chrId);

        }
        LOG.info("size of genes: " + genes.size());
        storeSynonyms();
        storeCrossrefs();
        storeGenes();
    }

    /**
     *
     * @param subjectId
     * @param id
     * @throws ObjectStoreException
     */
    private void getCrossReference(String Id, String subjectId, String ids)
            throws ObjectStoreException {

        String start = ids.replace("[","");
        String end = start.replace("]","");
        String[] vals = end.split(",");

        for(int i=0; i<vals.length; i++) {

            String type = "";
            String identifier = "";
            if(vals[i].contains(":")) {
                String[] t = vals[i].split(":");
                type = t[0].trim();
                identifier = t[1].trim();
            }else{
                identifier = vals[i].trim();
            }

            if(Id.equalsIgnoreCase(identifier)){ continue; }

            Item crf = createItem("CrossReference");
            crf.setReference("subject", subjectId);
            crf.setAttribute("identifier", identifier);
            if(StringUtils.isNotEmpty(type)) { crf.setAttribute("dbxreftype", type);}

            crossrefs.put(crf, identifier);
        }

    }
    /**
     * [SGD:L000000542, TEF5, YAL003W, EF-1beta, eEF1Balpha]
     * @param subjectId
     * @param value
     * @return
     * @throws ObjectStoreException
     */
    private void getSynonyms(String subjectId, String value)
            throws ObjectStoreException {

       String start = value.replace("[","");
       String end = start.replace("]","");
       String[] vals = end.split(",");
       for(int i=0; i<vals.length; i++) {
           Item syn = createItem("Synonym");
           syn.setReference("subject", subjectId);
           if(StringUtils.isNotEmpty(vals[i]) && !vals[i].equals(" ")) syn.setAttribute("value", vals[i].trim());
           synonyms.put(syn, vals[i]);
       }
    }

    private String getLocation(Item subject, String chromosomeRefId,
                               String startCoord, String stopCoord, String strand)
            throws ObjectStoreException {

        String start = startCoord;
        String end = stopCoord;

        if (!StringUtils.isEmpty(start) && !StringUtils.isEmpty(end)) {
            subject.setAttribute("length", getLength(start, end));
        }

        Item location = createItem("Location");

        if (!StringUtils.isEmpty(start))
            location.setAttribute("start", start);
        if (!StringUtils.isEmpty(end))
            location.setAttribute("end", end);
        if (!StringUtils.isEmpty(strand))
            location.setAttribute("strand", strand);

        location.setReference("feature", subject);
        location.setReference("locatedOn", chromosomeRefId);

        try {
            store(location);
        } catch (ObjectStoreException e) {
            throw new ObjectStoreException(e);
        }
        return location.getIdentifier();
    }


    private String getChromosome(String chr, String org) throws Exception {

        if (StringUtils.isEmpty(chr)) {
            return null;
        }
        String unq = chr+":"+org;
        String chrId  = chromosomes.get(unq);

        if(chrId == null) {
            Item chromosome = createItem("Chromosome");
            chromosome.setAttribute("primaryIdentifier", chr);
            chromosome.setReference("organism", org);
            try {
                store(chromosome);
            } catch (ObjectStoreException e) {
                throw new ObjectStoreException(e);
            }
            chrId = chromosome.getIdentifier();
            chromosomes.put(unq, chrId);
        }
        return chrId;
    }


    private String getLength(String start, String end)
            throws NumberFormatException {
        Integer a = new Integer(start);
        Integer b = new Integer(end);

        // if the coordinates are on the crick strand, they need to be reversed
        // or they result in a negative number
        if (a.compareTo(b) > 0) {
            a = new Integer(end);
            b = new Integer(start);
        }
        Integer length = new Integer(b.intValue() - a.intValue());
        return length.toString();
    }

    /**
     *
     * @throws ObjectStoreException
     */

    private void storeSynonyms() throws ObjectStoreException {
        for (Item syn : synonyms.keySet()) {
            try {
                store(syn);
            } catch (ObjectStoreException e) {
                throw new ObjectStoreException(e);
            }
        }
    }
    /**
     *
     * @throws ObjectStoreException
     */

    private void storeCrossrefs() throws ObjectStoreException {
        for (Item cr : crossrefs.keySet()) {
            try {
                store(cr);
            } catch (ObjectStoreException e) {
                throw new ObjectStoreException(e);
            }
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



}
