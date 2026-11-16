// Browser test for the email sign-in: the email and role form, a patient who sees only their number, and Log out
// in an app's top bar.
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/hosted-signin.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTestServer } from '../support/helpers.mjs';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch { console.log('SKIPPED: Playwright is not installed. Set PLAYWRIGHT_MODULE to its path to run the browser test.'); process.exit(0); }
const dns = { resolveMx: async (d) => (d === 'mail.test' ? [{ exchange: 'mx.mail.test', priority: 1 }] : Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))), resolve4: async () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' })), resolve6: async () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' })) };
const s = await startTestServer({ webRoot: REPO_ROOT, auth: { email: { secret: 'browser-test-secret-browser-test-secret-01', dns, restricted: true } } });
for (let i = 0; i < 3; i += 1) await s.store.save('Patient', { resourceType: 'Patient', gender: 'female', birthDate: '1970-01-01', identifier: [{ system: 'urn:hospital-desktop:mrn', type: { coding: [{ code: 'MR' }] }, value: `N20000${i}` }] }, { branch: 'main', updatedBy: 'test' });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome' });
const t = (id) => `[data-testid="${id}"]`; const errors = []; const steps = [];
const step = async (name, fn) => { try { await fn(); steps.push(name); console.log(`ok - ${name}`); } catch (err) { console.log(`FAILED after ${steps.length} steps: ${name}\n${err.stack || err}`); if (errors.length) console.log(`Console errors:\n${errors.join('\n')}`); await browser.close(); await s.close(); process.exit(1); } };
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } }); const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
const unlabelled = () => page.evaluate(() => [...document.querySelectorAll('button, input, select, textarea')].filter((el) => el.offsetParent !== null && (!el.dataset.testid || !el.getAttribute('aria-label'))).map((el) => el.outerHTML.slice(0, 120)));

await step('the address opens the sign-in page with the six roles', async () => {
  await page.goto(`${s.base}/`); await page.waitForSelector(t('email-form')); assert.equal(new URL(page.url()).pathname, '/');
  assert.equal(await page.locator(t('restricted-strip')).count(), 0, 'no restricted-data strip');
  assert.equal(await page.isVisible(t('demo-form')), false, 'no "Try as"'); assert.deepEqual(await page.$$eval(`${t('login-role')} option`, (o) => o.map((x) => x.textContent)), ['Researcher', 'Physician', 'Nurse', 'Coder', 'Patient', 'Insurance Payer']);
  assert.deepEqual(await unlabelled(), []);
});
await step('a made-up address is refused; an email is trimmed and lowercased', async () => {
  await page.fill(t('email-input'), 'someone@made-up.test'); await page.click(t('login-submit')); await page.waitForFunction(() => /Please enter a real email address\./.test(document.querySelector('[data-testid="login-note"]').textContent));
  await page.fill(t('email-input'), '  Someone@Mail.Test '); await page.locator(t('email-input')).blur(); await page.waitForFunction(() => document.querySelector('[data-testid="email-input"]').value === 'someone@mail.test');
  await page.waitForTimeout(300); assert.equal(await page.locator(`${t('login-role')} option[value="admin"]`).count(), 0);
});
await step('Patient: no further question; the portal shows the patient number and a Log out button', async () => {
  await page.fill(t('email-input'), 'p@mail.test'); await page.locator(t('email-input')).blur();
  await page.selectOption(t('login-role'), 'patient'); await page.click(t('login-submit')); await page.waitForSelector(t('dock'));
  await page.goto(`${s.base}/portal/`); await page.waitForSelector(t('signed-in-as')); const who = await page.textContent(t('signed-in-as')); assert.match(who, /^Signed in as patient N20000\d$/);
  await page.reload(); await page.waitForSelector(t('signed-in-as')); assert.equal(await page.textContent(t('signed-in-as')), who, 'the same patient after a reload');
  assert.equal(await page.locator(t('switch-patient')).count(), 0); assert.equal(await page.locator(t('restricted-strip')).count(), 0);
  await page.goto(`${s.base}/portal/`); await page.click(t('logout')); await page.waitForSelector(t('email-form')); assert.equal((await page.goto(`${s.base}/portal/`)).url().replace(s.base, ''), '/', 'sent back to the sign-in page');
});
await step('Researcher: the role is fixed in the top bar', async () => {
  await page.goto(`${s.base}/`); await page.waitForSelector(t('email-form')); await page.fill(t('email-input'), 'r@mail.test'); await page.selectOption(t('login-role'), 'researcher'); await page.click(t('login-submit')); await page.waitForSelector(t('dock'));
  assert.equal(await page.locator(t('admin-link')).count(), 0);
  await page.goto(`${s.base}/ehr/`); await page.waitForSelector(t('logout')); assert.equal(await page.locator(t('role-select')).count(), 0, 'the role cannot be switched in the top bar');
});
if (errors.length) { console.log(`Console errors:\n${errors.join('\n')}`); await browser.close(); await s.close(); process.exit(1); }
await browser.close(); await s.close();
console.log(`${steps.length} browser steps passed. Console errors: 0.`);
