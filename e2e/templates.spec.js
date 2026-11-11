// Ported from cypress/integration/templates_test.js
const { test, expect } = require('@playwright/test');
const { MINE, expectUrlIncludes, createGeneList, mainNav } = require('./helpers');

test.describe('Templates', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${MINE}/templates`);
  });

  test('can filter templates by search', async ({ page }) => {
    await page.getByText('Filter by text')
      .locator('xpath=following-sibling::*[1]')
      .pressSequentially('organism proteins', { delay: 50 });
    const templates = page.locator('.template');
    await expect(templates.nth(0)).toHaveId('All_Proteins_In_Organism_To_Publications');
    await expect(templates.nth(1)).toHaveId('Organism_Protein');
  });

  test('can search templates by categories', async ({ page }) => {
    await expect(page.locator('.template')).toHaveCount(3);
    await page.getByText('Genomics').first().click();
    await expect(page.locator('.template')).toHaveCount(1);
  });

  test('can load predefined template and show results', async ({ page }) => {
    await page.getByText(/View/).first().click();
    await expectUrlIncludes(page, '/All_Proteins_In_Organism_To_Publications');
    const template = page.locator('#All_Proteins_In_Organism_To_Publications');
    await template.locator('select').first().selectOption('!=');
    await expect(template.locator('td').filter({ hasText: 'Query returned no results' })).not.toHaveCount(0);
    await template.getByText('Open in results page').first().click();
    await expectUrlIncludes(page, '/results');
  });

  test('can run a template search with a list', async ({ page }) => {
    await createGeneList(page, 'ABRA,PFB0815w,PFF1275c,gene.60087');
    await mainNav(page).getByText('Templates').first().click();
    await expectUrlIncludes(page, '/templates');

    const template = page.locator('#Gene_Protein');
    await template.click();
    await template.locator('select').first().selectOption('IN');
    await template.getByText('Choose a list').first().click();
    await expect(template.locator('.dropdown-menu').first()).toBeVisible();
    await template.locator('.list-selection').first().click();
    const viewResults = template.locator('.view-results');
    await expect(viewResults).toContainText('4');
    await viewResults.click();
    await expectUrlIncludes(page, '/results');
  });

  test('can view and close a template', async ({ page }) => {
    await page.getByText(/View/).first().click();
    const selected = page.locator('.template.selected');
    await selected.getByText('Close').first().click();
    await expect(selected).toHaveCount(0);
  });

  test('can edit a templated query', async ({ page }) => {
    const template = page.locator('#All_Proteins_In_Organism_To_Publications');
    await template.click();
    await template.getByText('Edit query').first().click();
    await expectUrlIncludes(page, '/querybuilder');
    const labels = page.locator('.query-browser .qb-label');
    await expect(labels.filter({ hasText: 'Protein' }).first()).toBeVisible();
    await expect(labels.filter({ hasText: 'Publications' }).first()).toBeVisible();
  });

  test('can lookup a gene with a template search', async ({ page }) => {
    const template = page.locator('#Gene_Protein');
    await template.click();
    const input = template.locator('.constraint-input input');
    await input.fill('');
    await input.pressSequentially('MA*', { delay: 50 });
    await input.press('Enter');
    await template.locator('.view-results').click();
    await expectUrlIncludes(page, '/results');
  });
});
