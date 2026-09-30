// Ported from cypress/integration/user_account/login_logout_user.spec.js
const { test, expect } = require('@playwright/test');
const { ADMIN_EMAIL, ADMIN_PASSWORD, openLoginDialogue, submitLogin } = require('./helpers');

test.describe('Login and logout', () => {
  test.beforeEach(async ({ page }) => {
    await openLoginDialogue(page);
  });

  test('logs the user in', async ({ page }) => {
    await submitLogin(page, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const logon = page.locator('.logon.dropdown');
    await logon.click();
    await expect(logon).toContainText(ADMIN_EMAIL);
  });

  test('logs the user out', async ({ page }) => {
    await submitLogin(page, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const logon = page.locator('.logon.dropdown');
    await logon.click();
    await logon.getByText('Logout').first().click({ force: true });
    await expect(page.locator('.main-nav')).toContainText('Login');
  });

  const errors = [
    ['requires a password', { email: ADMIN_EMAIL }, "Missing parameter: 'password'"],
    ['requires a username', { password: 'test_password' }, "Missing parameter: 'username'"],
    ['rejects an unknown user', { email: 'test_user@gmail.com', password: ADMIN_PASSWORD },
      'Unknown username: test_user@gmail.com'],
    ['rejects an invalid password', { email: ADMIN_EMAIL, password: 'test' },
      'Invalid password supplied'],
  ];
  for (const [name, credentials, message] of errors) {
    test(name, async ({ page }) => {
      await submitLogin(page, credentials);
      await expect(page.locator('.error-box')).toContainText(message);
    });
  }
});
