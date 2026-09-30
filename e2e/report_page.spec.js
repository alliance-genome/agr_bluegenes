// Ported from cypress/integration/report_page_test.js
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { expectUrlIncludes, searchKeyword, createGeneList } = require('./helpers');

// Stubbed FlyMine response for the "homologues in other mines" displayer.
const FLYMINE_RESULTS = {
  modelName: 'genomic',
  columnHeaders: ['Gene > Id', 'Gene > Symbol', 'Gene > DB identifier',
    'Gene > Secondary Identifier', 'Gene > Organism > Short Name'],
  rootClass: 'Gene',
  start: 0,
  views: ['Gene.id', 'Gene.symbol', 'Gene.primaryIdentifier',
    'Gene.secondaryIdentifier', 'Gene.organism.shortName'],
  results: [[1029368, 'Eip75B', 'FBgn0000568', 'CG8127', 'D. melanogaster']],
  executionTime: '2021.08.12 13:10::26',
  wasSuccessful: true,
  error: null,
  statusCode: 200,
};

// The report-table section whose heading contains `heading`.
const section = (page, heading) =>
  page.locator('.report-table')
    .filter({ has: page.locator('.report-table-heading', { hasText: heading }) })
    .first();

const summary = (page) => page.locator('.report-table#summary');

test.describe('Report page', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://www.flymine.org/flymine/service/query/results', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 200, json: FLYMINE_RESULTS })
        : route.continue());
    await searchKeyword(page, 'GST');
    await page.locator('.result').first().click();
    await expectUrlIncludes(page, '/report');
    await expect(page.locator('.report-page-heading')).toBeVisible();
  });

  test('can filter the topic of a search result', async ({ page }) => {
    const filter = page.locator('.report-page-filter input');
    await filter.pressSequentially('Publications', { delay: 50 });
    await filter.press('Enter');
    const highlight = page.locator('.text-highlight').first();
    await expect(highlight).toContainText('Publications');
    await highlight.click();
    const item = page.locator('.report-item').first();
    await expect(item.locator('.report-item-title')).toContainText('Publications');
    await expect(item.locator('.im-table').first()).toBeVisible();
  });

  test('can access a topic from the left sidebar', async ({ page }) => {
    const toc = page.locator('.toc');
    await toc.getByText('Data').first().click();
    await toc.getByText('Exons').first().click();
    const exons = page.locator('.report-item')
      .filter({ has: page.locator('.report-item-title', { hasText: 'Exons' }) })
      .first();
    await expect(exons).toBeInViewport();
  });

  test('can collapse and expand a section on report page', async ({ page }) => {
    const data = section(page, 'Data');
    await expect(data.locator('.report-item-title').first()).toBeVisible();
    await data.locator('.icon-chevron-up').first().click();
    await expect(data.locator('.report-item')).toHaveCount(0);
  });

  test('can perform a region search with its sequence', async ({ page }) => {
    await expect(page.locator('.report-table').first()).toHaveId('summary');
    await summary(page).locator('.report-table-link > span').click();
    await expectUrlIncludes(page, '/regions');
  });

  test('can view the sequence of a gene', async ({ page }) => {
    await summary(page).locator('.fasta-value > .dropdown').click();
    await expect(page.locator('.fasta-sequence')).toBeInViewport();
  });

  test('can download the sequence of a gene in FASTA format', async ({ page }) => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      summary(page).locator('.fasta-value > .fasta-download').click(),
    ]);
    expect(download.suggestedFilename()).toBe('PF14_0187.fasta');
    expect(fs.readFileSync(await download.path(), 'utf8')).toContain('PF14_0187');
  });

  test('can expand a section to view the data displayer', async ({ page }) => {
    const exons = section(page, 'Data').locator('.report-item').filter({ hasText: 'Exons' }).first();
    await expect(exons.locator('.im-table').first()).toBeVisible();
    await exons.locator('.report-item-toggle').click();
    await expect(exons.locator('.im-table')).toHaveCount(0);
  });

  test('can copy the permanent URL of the report page of the object', async ({ page }) => {
    const actions = page.locator('.sidebar-actions:visible');
    await actions.getByText('Copy permanent URL').first().click();
    const container = actions.locator('.permanent-url-container');
    await expect(container).toBeVisible();
    // The Cypress spec pinned the Biotestmine host (localhost:9999); only the
    // mine-relative part is asserted so a Biotestmine elsewhere also passes.
    await expect(container.locator('input.form-control')).toHaveValue(/\/biotestmine\/gene:PF14_0187/);
    const copy = container.locator('button', { hasText: 'Copy' });
    for (const button of await copy.all()) await button.click();
  });

  test('can check if the gene is present in any list', async ({ page }) => {
    const lists = page.locator('.sidebar-entry:visible').filter({ hasText: 'Lists' });
    await expect(lists.locator('p')).toContainText("This Gene isn't in any lists.");

    await createGeneList(page, 'CK1,ABRA,GST');
    const search = page.locator('.typeahead-search');
    await search.fill('');
    await search.pressSequentially('GST', { delay: 50 });
    await search.press('Enter');
    await page.locator('.result').first().click();
    await expectUrlIncludes(page, '/report');

    await lists.locator('a').first().click();
    await expectUrlIncludes(page, '/results');
    await expect(page.locator('.query-title')).toContainText('Gene list');
  });

  test('can access the list of data sources', async ({ page }) => {
    await page.getByText('View all').first().click();
    await expectUrlIncludes(page, '/results');
    await expect(page.locator('.im-table').first()).toBeVisible();
  });

  test('can access homologue of the gene in other mines', async ({ page }) => {
    const otherMine = page.locator('.other-mine');
    await expect(otherMine.locator('.mine')).toContainText('FlyMine');
    await expect(otherMine.locator('img').first()).toBeVisible();
    // An example FlyMine gene served by the stub above, not necessarily the homologue.
    await otherMine.getByText('Eip75B').first().click();
    await expectUrlIncludes(page, '/flymine/report/Gene/1029368');
  });
});
