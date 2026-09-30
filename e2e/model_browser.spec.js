// Ported from cypress/integration/query_builder_test/model_browser_test.js
const { test, expect } = require('@playwright/test');
const { MINE } = require('./helpers');

test.describe('Model browser', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${MINE}/querybuilder`);
  });

  test('can select data type and summary attributes with model browser', async ({ page }) => {
    const root = page.locator('.model-browser-root');
    await root.locator('select').first().selectOption('Protein');
    await root.getByText('Add summary').first().click();
  });

  test('can select specific attributes', async ({ page }) => {
    const root = page.locator('.model-browser-root');
    const select = root.locator('select').first();
    await select.selectOption('Gene');
    await expect(select).toHaveValue('Gene');
    await root.getByText('Add summary').first().click();

    const browser = page.locator('.model-browser');
    await expect(browser.locator('ul').first()).toBeVisible();
    await browser.locator('.qb-class', { hasText: 'UTRs' }).first().click();
    const attributes = browser.locator('.expanded-group > ul .qb-label');
    for (const name of ['Name', 'Length', 'DB identifier']) {
      await attributes.filter({ hasText: name }).first().click();
    }

    const labels = page.locator('.query-view-column .qb-label');
    for (const name of ['Name', 'Length', 'DB identifier']) {
      await expect(labels.filter({ hasText: name }).first()).toBeVisible();
    }
  });

  test('can clear selected attributes on model browser', async ({ page }) => {
    const column = page.locator('.model-browser-column');
    const select = column.locator('select').first();
    await select.selectOption('Protein');
    await expect(select).toHaveValue('Protein');
    await column.getByText('Add summary').first().click();
    await column.locator('[title="Remove all selected attributes"]').click();
  });

  test('allows selection of data type from data model', async ({ page }) => {
    await expect(page.locator('.model-browser-column > h4')).toContainText('Model Browser');
    await page.getByText('Data Model').first().click();
    await page.getByText('Gene', { exact: true }).first().click();
    await page.getByText('Add summary').first().click();
    await expect(
      page.locator('.query-view-column .qb-label').filter({ hasText: 'Gene' }).first()
    ).toBeVisible();
  });

  test('can return to model browser from data browser', async ({ page }) => {
    const heading = page.locator('.model-browser-column > h4');
    await expect(heading).toContainText('Model Browser');
    await page.getByText('Data Model').first().click();
    const header = page.locator('.header-group');
    await expect(header.locator('h4')).toContainText('Data Browser');
    await header.getByText('Back to query').first().click();
    await expect(heading).toContainText('Model Browser');
  });
});
