// Ported from cypress/integration/main_page_test.js
const { test, expect } = require('@playwright/test');
const { expectUrlIncludes, mainNav } = require('./helpers');

test.describe('Main page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./');
  });

  test('can browse the data sources from the main page', async ({ page }) => {
    await page.getByText('Browse sources').first().click();
    await expectUrlIncludes(page, '/results');
    await expect(page.locator('.im-table').first()).toBeVisible();
  });

  for (const [tab, path] of [
    ['Upload', '/upload'],
    ['Lists', '/lists'],
    ['Templates', '/templates'],
    ['Regions', '/regions'],
    ['Query Builder', '/querybuilder'],
  ]) {
    test(`can access ${tab.toLowerCase()} tab from the navigation bar`, async ({ page }) => {
      await mainNav(page).getByText(tab).first().click();
      await expectUrlIncludes(page, path);
    });
  }

  for (const [link, path, target] of [
    ['More queries here', '/templates', 'templates'],
    ['Analyse data', '/upload', 'upload'],
    ['Build your own query', '/querybuilder', 'query builder'],
  ]) {
    test(`can access ${target} from the main page`, async ({ page }) => {
      await page.getByText(link).first().click();
      await expectUrlIncludes(page, path);
    });
  }

  test('can access other intermine instances', async ({ page }) => {
    await page.locator('.minename > .dropdown-toggle').click();
    await page.getByText('FlyMine').first().click();
    await expectUrlIncludes(page, '/flymine');
  });
});
