describe("Sort Lists Test", function() {
    beforeEach(function() {
      cy.visit("/");
      cy.createGeneList("SODB, GBP, GST, CDPK1");
      cy.createProteinList("Q8ID23_PLAF7, Q6LFN1");
      cy.url().should("include","/lists");
      cy.get(".lists-item").should('have.length',2);
    });

    it("can sort lists by name in ascending order", function(){
        cy.get(".lists-headers").contains(".sort-button", "List").as("sortButton");
        cy.get("@sortButton").click();
        cy.get("@sortButton").find(".active-asc-sort").should("exist");
        cy.get(".list-title").eq(0).should("include.text","Gene list");
    })

    it("can sort lists by name in descending order", function(){
        cy.get(".lists-headers").contains(".sort-button", "List").as("sortButton");
        cy.get("@sortButton").dblclick();
        cy.get("@sortButton").find(".active-desc-sort").should("exist");
        cy.get(".list-title").eq(0).should("include.text","Protein list");
    })

    it("can sort lists by date in ascending order", function(){
        cy.get(".lists-headers").contains(".sort-button", "Date").as("sortButton");
        cy.get("@sortButton").click();
        cy.get("@sortButton").find(".active-asc-sort").should("exist");
        cy.get(".list-title").eq(0).should("include.text","Gene list");
    })

    it("can sort lists by date in descending order", function(){
        cy.get(".lists-headers").contains(".sort-button", "Date").as("sortButton");
        cy.get("@sortButton").dblclick();
        cy.get("@sortButton").find(".active-desc-sort").should("exist");
        cy.get(".list-title").eq(0).should("include.text","Protein list");
    })

    it("can sort lists by type in ascending order", function(){
        cy.get(".lists-headers").contains(".sort-button", "Type").as("sortButton");
        cy.get("@sortButton").click();
        cy.get("@sortButton").find(".active-asc-sort").should("exist");
        cy.get(".list-title").eq(0).should("include.text","Gene list");
    })

    it("can sort lists by type in descending order", function(){
        cy.get(".lists-headers").contains(".sort-button", "Type").as("sortButton");
        cy.get("@sortButton").dblclick();
        cy.get("@sortButton").find(".active-desc-sort").should("exist");
        cy.get(".list-title").eq(0).should("include.text","Protein list");
    })
});
