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
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;

import org.apache.commons.collections.keyvalue.MultiKey;
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
public class AllianceOrthologsConverter extends BioFileConverter {

    private static final Logger LOG = Logger.getLogger(AllianceOrthologsConverter.class);

    private static final String DATASET_TITLE = "Alliance Orthologs data set";
    private static final String DATA_SOURCE_NAME = "DiOPT";
    private String licence;
    private Map<String, Item> genes = new HashMap<String, Item>();
    private Map<String, Item> homologues = new HashMap<String, Item>();
    private Set<MultiKey> homologuePairs = new HashSet<MultiKey>();

    /**
     * Construct a new AllianceGenesConverter.
     * @param database the database to read from
     * @param model the Model used by the object store we will write to with the ItemWriter
     * @param writer an ItemWriter used to handle Items created
     */
    public AllianceOrthologsConverter(ItemWriter writer, Model model) {
        super(writer, model, DATA_SOURCE_NAME, DATASET_TITLE);
    }

    /**
     * {@inheritDoc}
     */
    public void process(Reader reader) throws Exception, ObjectStoreException{

        /*Gene1ID Gene1Symbol     Gene1SpeciesTaxonID     Gene1SpeciesName
        Gene2ID Gene2Symbol  Gene2SpeciesTaxonID  Gene2SpeciesName
        Algorithms      AlgorithmsMatch OutOfAlgorithms  IsBestScore     IsBestRevScore
         */
        Iterator<?> lineIter = FormattedTextParser.parseTabDelimitedReader(reader);
        int count = 0;
        LOG.info("Processing Orthologs...");
        while (lineIter.hasNext()) {

            String[] line = (String[]) lineIter.next();
            if(count < 16 ) { count++; continue;}
            String gene1id = line[0].trim();
            String gene2id = line[4].trim();
            String origspecies1 = line[2].trim().trim();
            String species1 = origspecies1.replace("NCBITaxon:","").trim();
            String org1 = getOrganism(species1).trim();
            String origspecies2 = line[6].trim();
            String species2 = origspecies2.replace("NCBITaxon:","").trim();
            String org2 = getOrganism(species2).trim();
            String algorithms = line[8].trim();
            String matchCount = line[9].trim();
            String totalCount = line[10].trim();
            String bestScore = line[11].trim();
            String revScore = line[12].trim();

            processHomologues(gene1id, org1, gene2id, org2, algorithms, matchCount, totalCount, bestScore, revScore);

            }
        LOG.info("size of orthologs: " + genes.size());
        storeGenes();
        storeHomologues();

        }

    /**
     *
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
    private void processHomologues(String g1, String o1, String g2, String o2, String algorithm, String match, String total, String best, String reverse)
            throws ObjectStoreException {

        String gene1 = getGene(g1, o1);
        String gene2 = getGene(g2, o2);

        if (gene1 == null || gene2 == null || homologuePairs.contains(new MultiKey(gene1, gene2)) || gene1.equals(gene2)) {
            return;
        }

        Item homologue = createItem("Homologue");
        homologue.setReference("gene", gene1);
        homologue.setReference("homologue", gene2);
        homologue.setAttribute("algorithms", algorithm);
        homologue.setAttribute("algorithmsMatch", match);
        homologue.setAttribute("algorithmsAttempted", total);
        // DiOPT encodes boolean as "Yes" / "No"; translate to canonical true/false.
        if ("Yes".equalsIgnoreCase(best)) {
            homologue.setAttribute("isBestScore", "true");
        } else if ("No".equalsIgnoreCase(best)) {
            homologue.setAttribute("isBestScore", "false");
        }
        if ("Yes".equalsIgnoreCase(reverse)) {
            homologue.setAttribute("isBestReverseScore", "true");
        } else if ("No".equalsIgnoreCase(reverse)) {
            homologue.setAttribute("isBestReverseScore", "false");
        }
        homologues.put(homologue.getIdentifier(), homologue);
        homologuePairs.add(new MultiKey(gene1, gene2));
    }

    /**
     *
     * @param g
     * @param org
     * @return
     * @throws Exception
     */
    private String getGene(String g, String org) throws ObjectStoreException {

        Item gene  = genes.get(g);
        if(gene == null) {
            gene = createItem("Gene");
            gene.setAttribute("primaryIdentifier", g);
            gene.setReference("organism", org);
            genes.put(g, gene);
        }
        return gene.getIdentifier();
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

    private void storeHomologues() throws ObjectStoreException {
        for (Item homolog : homologues.values()) {
            try {
                store(homolog);
            } catch (ObjectStoreException e) {
                throw new ObjectStoreException(e);
            }
        }
    }

}
