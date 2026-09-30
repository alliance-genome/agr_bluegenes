// Ported from cypress/integration/search_test.js
const { test, expect } = require('@playwright/test');
const { expectUrlIncludes, searchKeyword, valueAfterLabel } = require('./helpers');

const results = (page) => page.locator('.results > form > *');

async function openFirstResult(page) {
  await results(page).first().click();
  await expectUrlIncludes(page, '/report');
}

test.describe('Search', () => {
  test('can be accessed from navigation bar', async ({ page }) => {
    await searchKeyword(page, 'Ma*');
    await expectUrlIncludes(page, '/search?keyword');
    await openFirstResult(page);
  });

  test('can search a single term', async ({ page }) => {
    await searchKeyword(page, 'ABRA');
    await expectUrlIncludes(page, '/search?keyword');
    await openFirstResult(page);
    await expect(valueAfterLabel(page, 'Symbol')).toHaveText('ABRA');
  });

  test('can search two terms with OR', async ({ page }) => {
    await searchKeyword(page, 'CDPK1 OR CDPK4');
    await expectUrlIncludes(page, '/search?keyword');
    await expect(valueAfterLabel(results(page).first(), 'Symbol')).toHaveText('CDPK1');
    await expect(valueAfterLabel(results(page).last(), 'Symbol')).toHaveText('CDPK4');
  });

  test('can search a phrase with quotation marks', async ({ page }) => {
    await searchKeyword(page, '"DNA binding"');
    await expectUrlIncludes(page, '/search?keyword');
    await openFirstResult(page);
    await expect(valueAfterLabel(page, 'Name')).toHaveText('DNA binding');
  });

  test('can search for partial matches', async ({ page }) => {
    await searchKeyword(page, 'MAL*');
    await expectUrlIncludes(page, '/search?keyword');
    await openFirstResult(page);
    await expect(
      page.locator('.report-table-body .report-table-cell').filter({ hasText: /MAL/ }).first()
    ).toBeVisible();
  });

  test('can search with boolean search syntax', async ({ page }) => {
    await searchKeyword(page, 'protein AND PLA*');
    await expectUrlIncludes(page, '/search?keyword');
    await openFirstResult(page);
    await expect(page.locator('.report-page-heading > .start')).toContainText('Protein');
    await expect(
      page.locator('.report-table-body .report-table-cell').filter({ hasText: /PLA/ }).first()
    ).toBeVisible();
  });

  test('can filter search results by category and organism', async ({ page }) => {
    await searchKeyword(page, 'MAL*');
    await expectUrlIncludes(page, '/search?keyword');

    await page.locator('td').filter({ hasText: /Gene/ }).first().click();
    await page.locator('td').filter({ hasText: /P\. falciparum 3D7/ }).first().click();

    await openFirstResult(page);
    await expect(valueAfterLabel(page, 'Organism')).toContainText('P. falciparum 3D7');
    await expect(page.locator('.report-page-heading > .start')).toContainText('Gene');
  });
});
