package org.intermine.bio.dataconversion;

/*
 * Test-mine only. Loads Organism names from a local TSV so the build needs no
 * entrez-organism call to NCBI.
 *
 * Columns: taxonId, genus, species, name, shortName, commonName (first row is a header).
 */
import java.io.IOException;
import java.io.Reader;
import java.util.Iterator;

import org.apache.commons.lang.StringUtils;
import org.intermine.dataconversion.ItemWriter;
import org.intermine.metadata.Model;
import org.intermine.objectstore.ObjectStoreException;
import org.intermine.util.FormattedTextParser;
import org.intermine.xml.full.Item;

public class TestmineOrganismsConverter extends BioFileConverter
{
    private static final String DATASET_TITLE = "Test mine organisms";
    private static final String DATA_SOURCE_NAME = "Test mine";
    private static final int MIN_COLUMNS = 6;

    public TestmineOrganismsConverter(ItemWriter writer, Model model) {
        super(writer, model, DATA_SOURCE_NAME, DATASET_TITLE);
    }

    /**
     * {@inheritDoc}
     */
    public void process(Reader reader) throws IOException, ObjectStoreException {
        Iterator<?> lineIter = FormattedTextParser.parseTabDelimitedReader(reader);
        while (lineIter.hasNext()) {
            String[] line = (String[]) lineIter.next();
            if (line.length < MIN_COLUMNS || "taxonId".equals(line[0])) {
                continue;
            }
            storeOrganism(line);
        }
    }

    private void storeOrganism(String[] line) throws ObjectStoreException {
        Item organism = createItem("Organism");
        organism.setAttribute("taxonId", line[0].trim());
        setIfPresent(organism, "genus", line[1]);
        setIfPresent(organism, "species", line[2]);
        setIfPresent(organism, "name", line[3]);
        setIfPresent(organism, "shortName", line[4]);
        setIfPresent(organism, "commonName", line[5]);
        store(organism);
    }

    private static void setIfPresent(Item item, String attribute, String value) {
        if (StringUtils.isNotBlank(value)) {
            item.setAttribute(attribute, value.trim());
        }
    }
}
