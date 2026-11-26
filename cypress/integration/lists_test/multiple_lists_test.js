describe("Multiple Lists Test", function() {
    beforeEach(function() {
      cy.visit("/");
      cy.createGeneList("SODB, GBP, GST, CDPK1");
      cy.createGeneList("CDPK1, CDPK4, ERD2, PFF1575w");
      cy.url().should("include","/lists");
      cy.get(".lists-item").should('have.length',2);
    });

    it("can combine two lists", function(){
        cy.get('.lists-headers').within(() => {
            cy.get('[type="checkbox"]').check();
        })
        cy.get('.selection-bar').within(() => {
            cy.contains("Combine").click();
        })
        cy.get('.modal-footer').within(() => {
            cy.contains("Save new list").click();
        })

        cy.contains("Combined Gene List").click();
        cy.url().should("include","/results");
        cy.get('.query-title').should("include.text","Combined Gene List");
        cy.get('.list-size-auth > span').should("include.text","7");
    })   

    it("can intersect two lists", function(){
        cy.get('.lists-headers').within(() => {
            cy.get('[type="checkbox"]').check();
        })
        cy.get('.selection-bar').within(() => {
            cy.contains("Intersect").click();
        })
        cy.get('.modal-footer').within(() => {
            cy.contains("Save new list").click();
        })

        cy.contains("Intersected Gene List").click();
        cy.url().should("include","/results");
        cy.get('.query-title').should("include.text","Intersected Gene List");
        cy.get('.list-size-auth > span').should("include.text","1");
    })   

    it("can difference two lists", function(){
        cy.get('.lists-headers').within(() => {
            cy.get('[type="checkbox"]').check();
        })
        cy.get('.selection-bar').within(() => {
            cy.contains("Difference").click();
        })
        cy.get('.modal-footer').within(() => {
            cy.contains("Save new list").click();
        })

        cy.contains("Differenced Gene List").click();
        cy.url().should("include","/results");
        cy.get('.query-title').should("include.text","Differenced Gene List");
        cy.get('.list-size-auth > span').should("include.text","6");
    })   

    it("can subtract two lists", function(){
        cy.get('.lists-headers').within(() => {
            cy.get('[type="checkbox"]').check();
        })
        cy.get('.selection-bar').within(() => {
            cy.contains("Subtract").click();
        })
        cy.get('.modal-footer').within(() => {
            cy.contains("Save new list").click();
        })

        cy.contains("Subtracted Gene List").click();
        cy.url().should("include","/results");
        cy.get('.query-title').should("include.text","Subtracted Gene List");
        cy.get('.list-size-auth > span').should("include.text","3");
    })   

    it("can search for list by keyword",function(){
        cy.createProteinList("Q8ID23_PLAF7, Q6LFN1");
        cy.get('.lists-item').should('have.length',3);

        cy.get("#lists-keyword-filter").type("Protein{enter}",{delay:100});
        cy.get('.lists-item').should('have.length',1);
        cy.get('.lists-item').find(".list-title").should("include.text","Protein");
    })

    it("can filter lists by type",function(){
        cy.createProteinList("Q8ID23_PLAF7, Q6LFN1");
        cy.get('.lists-item').should('have.length',3);

        cy.get("#lists-filter-type").select("Protein");
        cy.get('.lists-item').should('have.length',1);
        cy.get('.lists-item').find(".list-title").should("include.text","Protein");
    })

    it("can filter lists by list details",function(){
        cy.get("#lists-filter-lists").select("Public lists");
        cy.get('.no-lists').should('exist');
    })
});