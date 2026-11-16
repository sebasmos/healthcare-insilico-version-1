// The lock screen in the three ways the platform runs: open (continue as Researcher, or sign in with an
// invitation), locked (admin password), and demo ("Try as").
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/signin.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTestServer } from '../support/helpers.mjs';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch { console.log('SKIPPED: Playwright is not installed. Set PLAYWRIGHT_MODULE to its path to run the browser test.'); process.exit(0); }
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome' });
const t = (id) => `[data-testid="${id}"]`;
const steps = []; const step = async (name, fn) => { await fn(); steps.push(name); console.log(`ok - ${name}`); };
const webRoot = REPO_ROOT;
const secret = () => `pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const fresh = async (s) => { const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => { localStorage.setItem('hd.wallpaper', 'builtin'); localStorage.setItem('hd.lockWallpaper', 'builtin'); }); const page = await context.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message)); await page.goto(`${s.base}/`); await page.waitForSelector(t('lock-screen')); return { context, page, errors }; };
try {
  await step('open: Continue as Researcher needs no password; an invited person sets a password and signs in', async () => {
    const s = await startTestServer({ webRoot, auth: {} });
    try {
      const a = await fresh(s);
      assert.equal(await a.page.isVisible(t('signin-form')), true); assert.equal(await a.page.isVisible(t('login-form')), false, 'no pick-a-role outside a demonstration');
      await a.page.click(t('continue-researcher')); await a.page.waitForSelector(t('dock'));
      assert.match(await a.page.textContent('#who'), /^Researcher/);
      const made = await s.call('POST', '/agent-ops/people', { name: 'Reader 1', email: 'reader1@example.test', role: 'nurse' });
      assert.equal(made.status, 201, made.text);
      await a.context.close();
      const b = await fresh(s); const pw = secret();
      await b.page.goto(`${s.base}${made.json.inviteLink}`); await b.page.waitForSelector(t('accept-form')); assert.equal(await b.page.inputValue(t('accept-code')), made.json.inviteCode, 'the invitation link fills in the code');
      await b.page.fill(t('accept-password'), 'short'); await b.page.click(t('accept-submit'));
      await b.page.waitForFunction(() => document.querySelector('[data-testid="accept-note"]').textContent.includes('at least 10'));
      await b.page.fill(t('accept-password'), pw); await b.page.click(t('accept-submit')); await b.page.waitForSelector(t('dock'));
      assert.equal(await b.page.textContent('#who'), 'Nurse · Reader 1');
      await b.page.click(t('system-menu')); await b.page.click(t('menu-logout')); await b.page.waitForSelector(t('signin-form'));
      await b.page.fill(t('signin-email'), 'reader1@example.test'); await b.page.fill(t('signin-password'), 'wrong-password-1'); await b.page.click(t('signin-submit'));
      await b.page.waitForFunction(() => document.querySelector('[data-testid="signin-note"]').textContent.includes('not right'));
      assert.equal(await b.page.inputValue(t('signin-password')), '', 'the password box is cleared');
      await b.page.fill(t('signin-password'), pw); await b.page.click(t('signin-submit')); await b.page.waitForSelector(t('dock'));
      await b.page.reload(); await b.page.waitForSelector(t('dock')); assert.equal(await b.page.textContent('#who'), 'Nurse · Reader 1', 'still signed in after a reload');
      assert.equal(await b.page.evaluate((p) => JSON.stringify({ ...localStorage }).includes(p) || document.cookie.includes('hd_session'), pw), false, 'the password is not kept in the browser and the session cookie cannot be read by scripts');
      assert.deepEqual([...a.errors, ...b.errors], []);
      await b.context.close();
    } finally { await s.close(); }
  });
  await step('a signed-in patient: the Portal shows their own record, the Agent Dashboard shows only My work, and nothing they load is refused', async () => {
    const s = await startTestServer({ webRoot, auth: {} });
    try {
      const mine = (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', gender: 'female', birthDate: '1970-01-01' })).json;
      const other = (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', gender: 'male', birthDate: '1960-01-01' })).json;
      await s.call('POST', '/fhir/R4/Condition', { resourceType: 'Condition', subject: { reference: `Patient/${other.id}` }, code: { text: 'Zzother finding' }, clinicalStatus: { coding: [{ code: 'active' }] } });
      const made = (await s.call('POST', '/agent-ops/people', { email: 'pt@example.test', role: 'patient', patientId: mine.id })).json;
      const b = await fresh(s); const refused = []; b.page.on('response', (r) => { if (r.status() >= 400) refused.push(`${r.status()} ${new URL(r.url()).pathname}`); });
      await b.page.goto(`${s.base}${made.inviteLink}`); await b.page.waitForSelector(t('accept-form')); await b.page.fill(t('accept-password'), secret()); await b.page.click(t('accept-submit')); await b.page.waitForSelector(t('dock'));
      assert.equal(await b.page.evaluate(() => localStorage.getItem('hd.patient')), mine.id);
      for (const url of ['/portal/#/home', '/portal/#/notes', '/portal/#/messages', '/portal/#/profile', '/agent-ops/#/', '/agent-ops/#/evaluate']) { await b.page.goto(s.base + url); await b.page.waitForTimeout(900); assert.ok(!(await b.page.evaluate(() => document.body.innerText)).includes('Zzother'), url); }
      assert.equal(await b.page.locator(`${t('pill-tabs')} a`).count(), 1, 'only the Dashboard tab'); assert.equal(await b.page.locator(t('stop-all-agents')).count(), 0);
      assert.deepEqual(refused, [], 'the Portal and My work ask for nothing a patient may not have');
      const tried = await b.page.evaluate(async (id) => { const out = {}; for (const u of [`/fhir/R4/Patient/${id}`, `/fhir/R4/Condition?patient=${id}`, '/auth/patients', '/agent-ops/people']) out[u] = (await fetch(u)).status; return Object.values(out); }, other.id);
      assert.deepEqual(tried, [403, 403, 403, 403], 'another patient\'s record cannot be fetched from the browser');
      assert.deepEqual(b.errors, []); await b.context.close();
    } finally { await s.close(); }
  });
  await step('locked: no way in without the password; the admin password opens the Researcher desktop', async () => {
    const admin = secret(); const s = await startTestServer({ webRoot, auth: { adminPassword: admin } });
    try {
      const a = await fresh(s);
      assert.equal(await a.page.isVisible(t('continue-researcher')), false);
      await a.page.fill(t('signin-password'), 'not-the-password'); await a.page.click(t('signin-submit'));
      await a.page.waitForFunction(() => document.querySelector('[data-testid="signin-note"]').textContent.length > 0);
      await a.page.fill(t('signin-password'), admin); await a.page.click(t('signin-submit')); await a.page.waitForSelector(t('dock'));
      assert.match(await a.page.textContent('#who'), /^Researcher/);
      // A browser that only claims to be signed in is sent back to the lock screen.
      const c = await browser.newContext(); await c.addInitScript(() => { localStorage.setItem('hd.session', 'in'); localStorage.setItem('hd.role', 'researcher'); });
      const p = await c.newPage(); await p.goto(`${s.base}/`); await p.waitForSelector(t('signin-form')); assert.equal(await p.isVisible(t('dock')), false);
      await c.close(); await a.context.close();
    } finally { await s.close(); }
  });
  await step('demo: Try as Researcher, Physician, Nurse or Patient, labelled Demo', async () => {
    const s = await startTestServer({ webRoot, auth: { demo: true } });
    try {
      const a = await fresh(s);
      assert.equal(await a.page.isVisible(t('demo-form')), true); assert.equal(await a.page.isVisible(t('signin-form')), false); assert.equal(await a.page.isVisible(t('login-form')), false);
      assert.deepEqual(await a.page.$$eval(`${t("demo-form")} button`, (b) => b.map((x) => x.textContent)), ['Try as Researcher', 'Try as Physician', 'Try as Nurse', 'Try as Coder', 'Try as Patient', 'Try as Insurance Payer'], 'six buttons');
      await a.page.click(t('try-as-patient')); await a.page.waitForFunction(() => /no patients yet/i.test(document.querySelector('[data-testid="demo-note"]').textContent));
      const made = await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', gender: 'female', birthDate: '1970-01-01', identifier: [{ system: 'urn:hospital-desktop:mrn', value: 'N700009' }] });
      await a.page.click(t('try-as-patient')); await a.page.waitForSelector(t('dock'));
      assert.equal(await a.page.textContent('#who'), 'Demo · Patient'); assert.equal(await a.page.evaluate(() => localStorage.getItem('hd.patient')), made.json.id, 'the patient is one of the imported ones');
      await a.page.click(t('system-menu')); await a.page.click(t('menu-logout')); await a.page.waitForSelector(t('demo-form'));
      await a.page.click(t('try-as-nurse')); await a.page.waitForSelector(t('dock')); assert.equal(await a.page.textContent('#who'), 'Demo · Nurse');
      await a.context.close();
    } finally { await s.close(); }
  });
} finally { await browser.close(); }
console.log(`${steps.length} browser steps passed. Console errors: 0.`);
