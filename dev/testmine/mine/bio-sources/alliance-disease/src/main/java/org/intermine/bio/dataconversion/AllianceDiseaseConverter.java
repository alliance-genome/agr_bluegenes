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

import org.apache.commons.lang.StringUtils;
import org.apache.log4j.Logger;
import org.intermine.dataconversion.ItemWriter;
import org.intermine.metadata.Model;
import org.intermine.metadata.StringUtil;
import org.intermine.metadata.TypeUtil;
import org.intermine.model.bio.BioEntity;
import org.intermine.objectstore.ObjectStoreException;
import org.intermine.xml.full.Item;
import org.intermine.xml.full.ReferenceList;
import org.intermine.util.FormattedTextParser;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.io.Reader;


/**
 *
 * @author
 */
public class AllianceDiseaseConverter extends BioFileConverter {


    // configuration maps
    private static final Map<String, String> WITH_TYPES = new LinkedHashMap<String, String>();

    // maps retained across all files
    protected Map<String, String> doTerms = new LinkedHashMap<String, String>();
    private Map<String, String> evidenceCodes = new LinkedHashMap<String, String>();
    private Map<String, String> dataSets = new LinkedHashMap<String, String>();
    private Map<String, String> publications = new LinkedHashMap<String, String>();
    private Map<String, Item> organisms = new LinkedHashMap<String, Item>();
    protected Map<String, String> productMap = new LinkedHashMap<String, String>();
    private Set<String> dbRefs = new HashSet<String>();
    private Map<String, String> databaseAbbreviations = new HashMap<String, String>();
    private Map<String, String> dataSources = new HashMap<String, String>();

    // maps renewed for each file
    private Map<DoTermToGene, Set<Evidence>> doTermGeneToEvidence = new LinkedHashMap<DoTermToGene, Set<Evidence>>();
    private Map<Integer, List<String>> productCollectionsMap = new LinkedHashMap<Integer, List<String>>();
    private Map<String, Integer> storedProductIds = new HashMap<String, Integer>();

    // These should be altered for different ontologies:
    protected String termClassName = "DOTerm";
    protected String termCollectionName = "diseaseAnnotation";
    protected String annotationClassName = "DiseaseAnnotation";
    private String gaff = "2.0";
    private static final String DEFAULT_ANNOTATION_TYPE = "gene";
    private static final String DEFAULT_IDENTIFIER_FIELD = "primaryIdentifier";

    private static final Logger LOG = Logger.getLogger(AllianceDiseaseConverter.class);

    private static final String DATASET_TITLE = "Alliance Disease data";
    private static final String DATA_SOURCE_NAME = "Alliance Disease data";
    private Map<String, Item> genes = new HashMap<String, Item>();
    private static final Integer TAXON_ID = 4932;
    private static final Integer HUMAN_TAXON_ID = 9606;

    /**
     * Construct a new DiseaseConverter.
     * @param database the database to read from
     * @param model the Model used by the object store we will write to with the ItemWriter
     * @param writer an ItemWriter used to handle Items created
     */
    public AllianceDiseaseConverter(ItemWriter writer, Model model) throws ObjectStoreException {
        super(writer, model);
    }

    static {
        WITH_TYPES.put("HGNC", "Gene");
    }
    /**
     * {@inheritDoc}
     */
    public void process(Reader reader) throws Exception {

        /*
        Taxon SpeciesName	DBobjectType	DBObjectID
        DBObjectSymbol	AssociationType	DOID	DOtermName
        WithOrthologs	InferredFromID	InferredFromSymbol
        ExperimentalCondition   Modifier
        EvidenceCode	EvidenceCodeName	Reference	Date	Source
         */
        Iterator<?> lineIter = FormattedTextParser.parseTabDelimitedReader(reader);
        int count = 0;
        LOG.info("Processing DiseaseCombined.tsv...");
        while (lineIter.hasNext()) {
            count++;
            if (count < 15) { continue;}
            String[] line = (String[]) lineIter.next();
            String origspecies = line[0].trim();
            String taxonId = origspecies.replace("NCBITaxon:", "");
            if(taxonId.equalsIgnoreCase("Taxon")){ continue; }
            Item organism = newOrganism(taxonId);
            String productType = line[2].trim();
            if(!productType.equalsIgnoreCase("gene")) { continue; }
            String productId = line[3].trim();
            if( productId.equalsIgnoreCase("RGD:39457950")) { continue; }
            String qualifier = line[5].trim();
            String doId = line[6].trim();
            String withText = line[8].trim();
            String inferredFrom = line[9].trim();
            String expCondition = line[11].trim();
            String modifier = line[12].trim();
            String strEvidence = line[13].trim();
            String annotType = "manually curated";
            String pub = line[15].trim();
            String date_assigned = line[16].trim();
            String created_by = "alliance";
            String dataSourceCode = line[17].trim();

            //String qualifier = "";
            String annotationExtension = "";

            if (StringUtils.isNotEmpty(strEvidence)) {
                storeEvidenceCode(strEvidence, inferredFrom, withText, expCondition, modifier);
            } else {
                throw new IllegalArgumentException("Evidence is a required column but not "
                        + "found for doterm " + doId + " and productId " + productId);
            }


            // create unique key for do annotation
            DoTermToGene key = new DoTermToGene(productId, doId, qualifier, withText, annotationExtension, pub);

            String dataSource = DATA_SOURCE_NAME;
            String type = "gene";

            String productIdentifier = newProduct(productId, type, organism,
                    dataSource, dataSourceCode, true,"primaryIdentifier");

            // null if resolver could not resolve an identifier
            if (productIdentifier != null) {

                // null if no pub found
                String pubRefId = newPublication(pub);

                // get evidence codes for this goterm|gene pair
                Set<Evidence> allEvidenceForAnnotation = doTermGeneToEvidence.get(key);

                if (allEvidenceForAnnotation == null ) { //|| !StringUtils.isEmpty(withText)
                    String goTermIdentifier = newDoTerm(doId, dataSource, dataSourceCode);
                    Evidence evidence = new Evidence(strEvidence, pubRefId, withText, annotType, organism,
                            dataSource, dataSourceCode, date_assigned);
                    allEvidenceForAnnotation = new LinkedHashSet<Evidence>();
                    allEvidenceForAnnotation.add(evidence);
                    doTermGeneToEvidence.put(key, allEvidenceForAnnotation);
                    Integer storedAnnotationId =  createGoAnnotation(productIdentifier, type,
                            goTermIdentifier, organism, qualifier, dataSource, dataSourceCode,
                            annotationExtension);
                    evidence.setStoredAnnotationId(storedAnnotationId);
                } else {
                    boolean seenEvidenceCode = false;
                    Integer storedAnnotationId = null;

                    for (Evidence evidence : allEvidenceForAnnotation) {
                        String evidenceCode = evidence.getEvidenceCode();
                        storedAnnotationId = evidence.storedAnnotationId;
                        // already have evidence code, just add pub
                        if (evidenceCode.equals(strEvidence)) {
                            evidence.addPublicationRefId(pubRefId);
                            seenEvidenceCode = true;
                        }
                    }
                    if (!seenEvidenceCode) {
                        Evidence evidence = new Evidence(strEvidence, pubRefId, withText, annotType, organism,
                                dataSource, dataSourceCode, date_assigned);   //was strEvidence
                        evidence.storedAnnotationId = storedAnnotationId;
                        allEvidenceForAnnotation.add(evidence);
                    }
                }
            }
        }
        storeProductCollections();
        storeEvidence();

    }

    private void storeProductCollections() throws ObjectStoreException {
        for (Map.Entry<Integer, List<String>> entry : productCollectionsMap.entrySet()) {
            Integer storedProductId = entry.getKey();
            List<String> annotationIds = entry.getValue();
            ReferenceList doAnnotation = new ReferenceList(termCollectionName, annotationIds);
            store(doAnnotation, storedProductId);
        }
    }

    private void storeEvidence() throws ObjectStoreException {
        for (Set<Evidence> annotationEvidence : doTermGeneToEvidence.values()) {
            List<String> evidenceRefIds = new ArrayList<String>();
            Integer goAnnotationRefId = null;
            for (Evidence evidence : annotationEvidence) {
                Item goevidence = createItem("DiseaseEvidence");
                goevidence.setReference("code", evidenceCodes.get(evidence.getEvidenceCode()));
                List<String> publicationEvidence = evidence.getPublications();
                if (!publicationEvidence.isEmpty()) {
                    goevidence.setCollection("publications", publicationEvidence);
                }
                if (!StringUtils.isEmpty(evidence.inferredFrom)) {
                    goevidence.setAttribute("inferredFrom", evidence.inferredFrom);
                }
                // with objects
				/*if (!StringUtils.isEmpty(evidence.withText)) {
					goevidence.setAttribute("withText", evidence.withText);
					List<String> with = createWithObjects(evidence.withText, evidence.organism,
							evidence.dataSource, evidence.dataSourceCode);
					if (!with.isEmpty()) {
						goevidence.addCollection(new ReferenceList("with", with));
					}
				}*/
                if(!StringUtils.isEmpty(evidence.withText)) {
                    goevidence.setAttribute("withText", evidence.withText);
                }
                // DISEASE TSV encodes Date as YYYYMMDD; translate to java.util.Date for the model field.
                if (!StringUtils.isEmpty(evidence.dateAssigned)) {
                    try {
                        Date d = new SimpleDateFormat("yyyyMMdd").parse(evidence.dateAssigned);
                        goevidence.setAttribute("dateAssigned", new SimpleDateFormat("yyyy-MM-dd").format(d));
                    } catch (java.text.ParseException e) {
                        LOG.warn("Could not parse DateAssigned '" + evidence.dateAssigned + "': " + e.getMessage());
                    }
                }
                store(goevidence);
                evidenceRefIds.add(goevidence.getIdentifier());
                goAnnotationRefId = evidence.getStoredAnnotationId();
            }

            ReferenceList refIds = new ReferenceList("evidence",
                    new ArrayList<String>(evidenceRefIds));
            store(refIds, goAnnotationRefId);
        }
    }

    private Integer createGoAnnotation(String productIdentifier, String productType,
                                       String termIdentifier, Item organism, String qualifier, String dataSource,
                                       String dataSourceCode, String annotationExtension) throws ObjectStoreException {
        Item goAnnotation = createItem(annotationClassName);
        goAnnotation.setReference("subject", productIdentifier);
        goAnnotation.setReference("ontologyTerm", termIdentifier);

        if (!StringUtils.isEmpty(qualifier)) {
            goAnnotation.setAttribute("qualifier", qualifier);
        }
        if (!StringUtils.isEmpty(annotationExtension)) {
            goAnnotation.setAttribute("annotationExtension", annotationExtension);
        }

        goAnnotation.addToCollection("dataSets", getDataset(dataSource, dataSourceCode));
        if ("gene".equals(productType)) {
            addProductCollection(productIdentifier, goAnnotation.getIdentifier());
        }
        Integer storedAnnotationId = store(goAnnotation);
        return storedAnnotationId;
    }

    private void addProductCollection(String productIdentifier, String goAnnotationIdentifier) {
        Integer storedProductId = storedProductIds.get(productIdentifier);
        List<String> annotationIds = productCollectionsMap.get(storedProductId);
        if (annotationIds == null) {
            annotationIds = new ArrayList<String>();
            productCollectionsMap.put(storedProductId, annotationIds);
        }
        annotationIds.add(goAnnotationIdentifier);
    }

    /**
     * Given the 'with' text from a gene_association entry parse for recognised identifier
     * types and create Gene or Protein items accordingly.
     *
     * @param withText string from the gene_association entry
     * @param organism organism to reference
     * @param dataSource the name of goa file source
     * @param dataSourceCode short code to describe data source
     * @throws ObjectStoreException if problem when storing
     * @return a list of Items
     */
    protected List<String> createWithObjects(String withText, Item organism,
                                             String dataSource, String dataSourceCode) throws ObjectStoreException {

        Item humorganism = newOrganism("9606");

        List<String> withProductList = new ArrayList<String>();
        try {
            String[] elements = withText.split("[; |,]");
            for (int i = 0; i < elements.length; i++) {
                String entry = elements[i].trim();
                // rely on the format being type:identifier
                if (entry.indexOf(':') > 0) {
                    String prefix = entry.substring(0, entry.indexOf(':'));
                    String value = entry.substring(entry.indexOf(':') + 1);

                    if (WITH_TYPES.containsKey(prefix) && StringUtils.isNotEmpty(value)) {
                        String className = WITH_TYPES.get(prefix);
                        String productIdentifier = null;
                        if ("HGNC".equals(prefix)) {
                            productIdentifier = newProduct(value, className, humorganism,
                                    "HGNC", "HGNC", true, "primaryIdentifier");

                        }
                        if (productIdentifier != null) {
                            withProductList.add(productIdentifier);
                        }
                    } else {
                        LOG.debug("createWithObjects skipping a withType prefix:" + prefix);
                    }
                }
            }
        } catch (RuntimeException e) {
            LOG.error("createWithObjects broke with: " + withText);
            throw e;
        }
        return withProductList;
    }
    private String newProduct(String identifier, String type, Item organism,
                              String dataSource, String dataSourceCode, boolean createOrganism,
                              String field) throws ObjectStoreException {
        String idField = field;
        String accession = identifier;
        String clsName = null;
        // find gene attribute first to see if organism should be part of key
        if ("gene".equalsIgnoreCase(type)) {
            clsName = "Gene";
            String taxonId = organism.getAttribute("taxonId").getValue();
        } else if ("protein".equalsIgnoreCase(type)) {
            clsName = "Protein";
            idField = "primaryAccession";
        } else {
            String typeCls = TypeUtil.javaiseClassName(type);

            if (getModel().getClassDescriptorByName(typeCls) != null) {
                Class<?> cls = getModel().getClassDescriptorByName(typeCls).getType();
                if (BioEntity.class.isAssignableFrom(cls)) {
                    clsName = typeCls;
                }
            }
            if (clsName == null) {
                throw new IllegalArgumentException("Unrecognised annotation type '" + type + "'");
            }
        }

        boolean includeOrganism = false;

        String key = makeProductKey(accession, type, organism, includeOrganism);

        //Have we already seen this product somewhere before?
        // if so, return the product rather than creating a new one...
        if (productMap.containsKey(key)) {
            return productMap.get(key);
        }

        Item product = createItem(clsName);
        if (organism != null && createOrganism) {
            product.setReference("organism", organism.getIdentifier());
        }
        product.setAttribute(idField, accession);

        String dataSetIdentifier = getDataset(dataSource, dataSourceCode);
        product.addToCollection("dataSets", dataSetIdentifier);

        Integer storedProductId = store(product);
        storedProductIds.put(product.getIdentifier(), storedProductId);
        productMap.put(key, product.getIdentifier());
        return product.getIdentifier();
    }

    private String makeProductKey(String identifier, String type, Item organism,
                                  boolean createOrganism) {
        if (type == null) {
            throw new IllegalArgumentException("No type provided when creating " + organism
                    + ": " + identifier);
        } else if (identifier == null) {
            throw new IllegalArgumentException("No identifier provided when creating "
                    + organism + ": " + type);
        }

        return identifier + type.toLowerCase() + ((createOrganism)
                ? organism.getIdentifier() : "");
    }


    private String newDoTerm(String identifier, String dataSource,
                             String dataSourceCode) throws ObjectStoreException {
        if (identifier == null) {
            return null;
        }

        String doTermIdentifier = doTerms.get(identifier);
        if (doTermIdentifier == null) {
            Item item = createItem(termClassName);
            item.setAttribute("identifier", identifier);
            item.addToCollection("dataSets", getDataset(dataSource, dataSourceCode));
            store(item);

            doTermIdentifier = item.getIdentifier();
            doTerms.put(identifier, doTermIdentifier);
        }
        return doTermIdentifier;
    }

    private void storeEvidenceCode(String code, String inferredFrom, String withText, String expCondition, String modifier) throws ObjectStoreException {

        if (evidenceCodes.get(code) == null) {
            Item item = createItem("DiseaseEvidenceCode");
            item.setAttribute("code", code);
            if(StringUtils.isNotEmpty(withText)) item.setAttribute("withText", withText);
            if(StringUtils.isNotEmpty(inferredFrom)) item.setAttribute("inferredFrom", inferredFrom);
            if(StringUtils.isNotEmpty(expCondition)) item.setAttribute("experimentCondition", expCondition);
            if(StringUtils.isNotEmpty(modifier)) item.setAttribute("modifier", modifier);

            evidenceCodes.put(code, item.getIdentifier());
            store(item);
        }

    }

    private String getDataSourceCodeName(String sourceCode) {
        String title = sourceCode;
        // re-write some codes to better data source names
        // if ("SGD".equalsIgnoreCase(sourceCode)) {
        //title = "SGD curated Disease data";
        //}
        return title;
    }

    private String getDataset(String dataSource, String code)
            throws ObjectStoreException {
        String dataSetIdentifier = dataSets.get(code);
        if (dataSetIdentifier == null) {
            String dataSourceName = getDataSourceCodeName(code);
            String title = "DO Annotation from " + dataSourceName;
            Item item = createItem("DataSet");
            item.setAttribute("name", title);
            item.setReference("dataSource", getDataSource(getDataSourceCodeName(dataSource)));
            dataSetIdentifier = item.getIdentifier();
            dataSets.put(code, dataSetIdentifier);
            store(item);
        }
        return dataSetIdentifier;
    }


    /**
     * Return a DataSource item for the given title
     * @param name the DataSource name
     * @return the DataSource Item
     */
    public String getDataSource(String name) {
        if (name == null) {
            return null;
        }
        String refId = dataSources.get(name);
        if (refId == null) {
            Item dataSource = createItem("DataSource");
            dataSource.setAttribute("name", name);
            try {
                store(dataSource);
            } catch (ObjectStoreException e) {
                throw new RuntimeException("failed to store DataSource with name: " + name, e);
            }
            refId = dataSource.getIdentifier();
            dataSources.put(name, refId);
        }
        return refId;
    }

    private String newPublication(String pubMedId) throws ObjectStoreException {

        String pubRefId = null;
        String pmid = null;
        String otherId = null;

        if (pubMedId.startsWith("PMID:")) {
            pmid = pubMedId.substring(5);
        }else{
            otherId = pubMedId;
        }
        if (StringUtil.allDigits(pmid)) {
            pubRefId = publications.get(pmid);
            if (pubRefId == null) {
                Item item = createItem("Publication");
                item.setAttribute("pubMedId", pmid);
                pubRefId = item.getIdentifier();
                publications.put(pmid, pubRefId);
                store(item);
            }
        }else if(otherId != null) {
            Item item = createItem("Publication");
            item.setAttribute("pubXrefId", otherId);
            pubRefId = item.getIdentifier();
            publications.put(pmid, pubRefId);
            store(item);
        }
        return pubRefId;
    }

    private Item newOrganism(String taxonId) throws ObjectStoreException {
        Item item = organisms.get(taxonId);
        if (item == null) {
            item = createItem("Organism");
            item.setAttribute("taxonId", taxonId);
            organisms.put(taxonId, item);
            store(item);
        }
        return item;
    }

    private String parseTaxonId(String input) {
        if ("TAX:".equals(input)) {
            throw new IllegalArgumentException("Invalid taxon id read: " + input);
        }
        String taxonId = input.split(":")[1];
        if (taxonId.contains("|")) {
            taxonId = taxonId.split("\\|")[0];
        }
        return taxonId;
    }

    private class Evidence
    {
        private List<String> publicationRefIds = new ArrayList<String>();
        private String evidenceCode = null;
        private Integer storedAnnotationId = null;
        private String withText = null;
        private String inferredFrom = null;
        private Item organism = null;
        private String dataSourceCode = null;
        private String dataSource = null;
        private String dateAssigned = null;

        protected Evidence(String evidenceCode, String publicationRefId, String withText, String inferredFrom,
                           Item organism, String dataset, String datasource, String dateAssigned) {
            this.evidenceCode = evidenceCode;
            this.withText = withText;
            this.inferredFrom = inferredFrom;
            this.organism = organism;
            this.dataSourceCode = dataset;
            this.dataSource = datasource;
            this.dateAssigned = dateAssigned;
            addPublicationRefId(publicationRefId);
        }

        protected void addPublicationRefId(String publicationRefId) {
            if (publicationRefId != null) {
                publicationRefIds.add(publicationRefId);
            }
        }

        protected List<String> getPublications() {

            return publicationRefIds;
        }

        protected String getEvidenceCode() {
            return evidenceCode;
        }

        @SuppressWarnings("unused")
        protected String getWithText() {
            return withText;
        }

        @SuppressWarnings("unused")
        protected String getInferredFrom() {
            return inferredFrom;
        }

        @SuppressWarnings("unused")
        protected String getDataset() {
            return dataSourceCode;
        }

        @SuppressWarnings("unused")
        protected String getDatasource() {
            return dataSource;
        }

        @SuppressWarnings("unused")
        protected Item getOrganism() {
            return organism;
        }


        /**
         * @return the storedAnnotationId
         */
        protected Integer getStoredAnnotationId() {
            return storedAnnotationId;
        }

        /**
         * @param storedAnnotationId the storedAnnotationId to set
         */
        protected void setStoredAnnotationId(Integer storedAnnotationId) {
            this.storedAnnotationId = storedAnnotationId;
        }
    }



    /**
     * Identify a GoTerm/geneProduct pair with qualifier
     * used to also use evidence code
     */
    private class DoTermToGene
    {
        private String productId;
        private String goId;
        private String qualifier;
        private String withText;
        private String annotationExtension;
        private String pub;

        /**
         * Constructor
         *
         * @param productId gene/protein identifier
         * @param goId      GO term id
         * @param qualifier qualifier
         */
        DoTermToGene(String productId, String goId, String qualifier, String withText, String annotationExtension, String pub) {
            this.productId = productId;
            this.goId = goId;
            this.qualifier = qualifier;
            this.withText = withText;
            this.annotationExtension = annotationExtension;
            this.pub = pub;
        }

        /**
         * {@inheritDoc}
         */
        @Override
        public boolean equals(Object o) {
            if (o instanceof DoTermToGene) {
                DoTermToGene go = (DoTermToGene) o;
                if(annotationExtension == null) {
                    return productId.equals(go.productId)
                            && goId.equals(go.goId)
                            && qualifier.equals(go.qualifier)
                            && withText.equals(go.withText)
                            && pub.equals(go.pub);
                }else{
                    return productId.equals(go.productId)
                            && goId.equals(go.goId)
                            && qualifier.equals(go.qualifier)
                            && withText.equals(go.withText)
                            && pub.equals(go.pub)
                            && annotationExtension.equals(go.annotationExtension);
                }
            }
            return false;
        }

    }

}
