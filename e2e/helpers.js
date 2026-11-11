// Shared helpers ported from cypress/support/commands.js.
const { expect } = require('@playwright/test');

const MINE = process.env.BLUEGENES_MINE || 'biotestmine';

// Biotestmine's built-in test account (public fixture data, not a secret).
const ADMIN_EMAIL = process.env.BLUEGENES_TEST_USER || 'test_user@mail_account';
const ADMIN_PASSWORD = process.env.BLUEGENES_TEST_PASSWORD || 'secret';

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Equivalent of cy.url().should("include", fragment).
async function expectUrlIncludes(page, fragment) {
  await expect(page).toHaveURL(new RegExp(escapeRegExp(fragment)));
}

// Equivalent of cy.contains(label).next(): the element right after a label.
function valueAfterLabel(scope, label) {
  return scope
    .getByText(new RegExp(escapeRegExp(label)))
    .first()
    .locator('xpath=following-sibling::*[1]');
}

async function openLoginDialogue(page) {
  await page.goto(MINE);
  await page.locator('.dropdown-toggle', { hasText: 'Login' }).first().click();
}

async function searchKeyword(page, keyword) {
  await page.goto(`${MINE}/search`);
  const input = page.locator('.searchform > input');
  await input.pressSequentially(keyword, { delay: 50 });
  await input.press('Enter');
}

function mainNav(page) {
  return page.locator('#bluegenes-main-nav');
}

async function createGeneList(page, geneList) {
  await mainNav(page).getByText('Upload').first().click();
  await page.locator('.wizard textarea').fill(geneList);
  await page.getByText('Continue').first().click();
  await expect(page.locator('.title').first()).toBeVisible();
  await expectUrlIncludes(page, '/save');
  await page.getByText('Save List').first().click();
  await expectUrlIncludes(page, '/results');
  await mainNav(page).getByText('Lists').first().click();
}

async function submitLogin(page, { email, password }) {
  await expect(page.locator('.login-form')).toContainText('Login to BioTestMine');
  if (email !== undefined) await page.locator('input#email').fill(email);
  if (password !== undefined) await page.locator("input[type='password']").fill(password);
  await page.locator('.login-form button', { hasText: 'Login' }).first().click();
}

async function loginToUserAccount(page, email, password) {
  await openLoginDialogue(page);
  const login = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes('/api/auth/login'));
  await submitLogin(page, { email, password });
  await login;
  const logon = page.locator('.logon.dropdown.success');
  await logon.click();
  await expect(logon).toContainText(email);
}

async function loginToAdminAccount(page) {
  await loginToUserAccount(page, ADMIN_EMAIL, ADMIN_PASSWORD);
}

module.exports = {
  MINE,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  expectUrlIncludes,
  valueAfterLabel,
  openLoginDialogue,
  searchKeyword,
  mainNav,
  createGeneList,
  submitLogin,
  loginToUserAccount,
  loginToAdminAccount,
};
