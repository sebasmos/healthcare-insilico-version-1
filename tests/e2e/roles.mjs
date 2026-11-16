// Browser end-to-end test for the role framework:
// four roles (redesign of 2026-11-12): Physician, Nurse and Researcher see
// every app, every chart tab and every EHR screen with write controls enabled;
// Patient sees only the Portal, and an app opened directly hands over to it.
// Run it with:
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/roles.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTestServer, tempDir, patient } from '../support/helpers.mjs';
import { demoLogin } from '../support/demo-login.mjs';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'));
} catch {
  console.log('SKIPPED: Playwright is not installed. Set PLAYWRIGHT_MODULE to its path to run the browser test.');
  process.exit(0);
}

const s = await startTestServer({ webRoot: REPO_ROOT });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
context.setDefaultTimeout(10000);
const errors = [];
const expected4xx = [];
const watch = (page, name) => {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/status of (409|422)/.test(m.text())) expected4xx.push(m.text()); else errors.push(`${name}: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
};
const shots = process.env.E2E_SHOTS ? tempDir('hd-shots-') : null;
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
const t = (id) => `[data-testid="${id}"]`;
const steps = [];
const step = async (name, fn) => { await fn(); steps.push(name); console.log(`ok - ${name}`); };

// What the pages have built so far; the map may list more (those tabs and sections are not rendered yet).
const BUILT_TABS = ['summary', 'review', 'problems', 'allergies', 'medications', 'vitals', 'notes', 'orders', 'encounters', 'messages', 'worklist', 'mar', 'flowsheets', 'io', 'ecg', 'coverage'];
const BUILT_NAV = ['dashboard', 'worklist', 'patients', 'schedule', 'frontdesk', 'orders', 'inbox', 'billing', 'admin'];

try {
  await s.call('PUT', '/api/friction', { level: 'low' });
  const { roles, built, apps } = (await s.call('GET', '/auth/roles')).json;
  assert.deepEqual(roles.map((r) => r.id).sort(), ['coder', 'nurse', 'patient', 'payer-medical-director', 'physician', 'researcher'], 'six roles');
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Rolecase', { name: [{ family: 'Rolecase', given: ['Test'] }] }))).json;
  const desktop = await context.newPage(); watch(desktop, 'desktop');
  const page = await context.newPage(); watch(page, 'app');
  await desktop.goto(`${s.base}/`);
  // The desktop now starts at a lock screen (plan-master task 1): log in as a role, and read the dock instead of tiles.
  const loginAs = async (role, name) => {
    if (await desktop.locator(t('dock')).count() && await desktop.locator(t('dock')).isVisible().catch(() => false)) { await desktop.click(t('system-menu')); await desktop.click(t('menu-logout')); }
    await desktop.waitForSelector(t('lock-screen'));
    await demoLogin(desktop, role, { name });
    await desktop.waitForSelector(t('dock'));
  };
  const dockEnabled = async (app) => (await desktop.locator(t(`dock-${app}`)).getAttribute('aria-disabled')) !== 'true';

  const tabIds = () => page.$$eval('[data-testid^="chart-tab-"]', (els) => els.map((e) => e.dataset.testid.slice('chart-tab-'.length)));
  const navIds = () => page.$$eval('[data-testid^="nav-"]', (els) => els.map((e) => e.dataset.testid.slice('nav-'.length)));

  for (const role of roles) {
    await step(`${role.id}: desktop tiles follow the map, landing page opens, EHR navigation and chart tabs match the map`, async () => {
      await loginAs(role.id, `Test ${role.label}`);
      for (const app of apps) {
        const enabled = await dockEnabled(app);
        assert.equal(enabled, role.apps.includes(app) && Boolean(built[app]), `${role.id}: dock ${app} ${enabled ? 'enabled' : 'greyed out'}`);
      }
      const landing = built[role.landing.app] ? role.landing : { app: 'ehr', hash: '#/dashboard' };
      await shot(desktop, `desktop-${role.id}`);

      await page.goto(`${s.base}/${landing.app}/${landing.hash}`);
      await page.waitForSelector('.topbar');
      assert.ok(page.url().includes(`/${landing.app}/`), `${role.id}: landing app ${landing.app} opens`);
      if (!role.apps.includes('ehr')) {
        // Opened directly, an app the role has no use for hands over to the landing app.
        await page.goto(`${s.base}/ehr/#/dashboard`);
        await page.waitForURL((u) => u.pathname.startsWith(`/${landing.app}/`));
        return;
      }
      await page.goto(`${s.base}/ehr/#/chart/${p.id}/summary`);
      await page.waitForSelector(t('patient-sidebar'));
      assert.deepEqual(await tabIds(), role.chartTabs.filter((id) => BUILT_TABS.includes(id)), `${role.id}: chart tab bar`);
      assert.deepEqual(await navIds(), BUILT_NAV.filter((id) => role.nav.includes(id)), `${role.id}: EHR navigation`);
      await shot(page, `chart-${role.id}`);
    });
  }

  for (const id of ['physician', 'nurse', 'researcher']) {
    await step(`${id}: every app in the dock, every built tab and screen, and write controls enabled (prescribe, add a problem, register a patient)`, async () => {
      await loginAs(id, `Test ${id}`);
      for (const app of apps) assert.equal(await dockEnabled(app), Boolean(built[app]), `${id}: dock ${app}`);
      await page.goto(`${s.base}/ehr/#/chart/${p.id}/summary`);
      await page.selectOption(t('role-select'), id);
      await page.goto(`${s.base}/ehr/#/chart/${p.id}/problems`);
      await page.waitForSelector(t('problem-add'));
      assert.deepEqual([...await tabIds()].sort(), [...BUILT_TABS].sort(), `${id}: every built chart tab`);
      assert.ok(await page.isEnabled(t('problem-add')), `${id}: Add problem is enabled`);
      await page.goto(`${s.base}/ehr/#/chart/${p.id}/medications`);
      await page.waitForSelector(t('prescribe'));
      assert.ok(await page.isEnabled(t('prescribe')), `${id}: Prescribe is enabled`);
      assert.equal(await page.locator(t('prescribe-by-mode')).count(), 0, `${id}: no verbal-order detour`);
      await page.goto(`${s.base}/ehr/#/patients`);
      await page.waitForSelector(t('register-patient'));
      assert.ok(await page.isEnabled(t('register-patient')), `${id}: Register patient is enabled`);
      assert.deepEqual(await navIds(), BUILT_NAV, `${id}: every EHR screen`);
    });
  }

  await step('switching "Work as" to the patient moves to the Portal', async () => {
    await page.goto(`${s.base}/ehr/#/dashboard`);
    await page.waitForSelector(t('role-select'));
    await page.selectOption(t('role-select'), 'patient');
    await page.waitForURL((u) => u.pathname.startsWith('/portal/'));
  });

  assert.deepEqual(errors, [], 'browser console errors');
  console.log(`\n${steps.length} browser steps passed. Console errors: 0. Expected 409/422 responses logged by the browser: ${expected4xx.length}.`);
  if (shots) console.log(`Screenshots: ${shots}`);
} catch (err) {
  console.error(`\nFAILED after ${steps.length} steps: ${err.stack || err.message}`);
  if (errors.length) console.error('Console errors:\n' + errors.join('\n'));
  if (shots) { for (const [i, pg] of context.pages().entries()) await pg.screenshot({ path: path.join(shots, `fail-${i}.png`) }).catch(() => {}); console.error(`Screenshots: ${shots}`); }
  process.exitCode = 1;
} finally {
  await browser.close();
  await s.close();
  if (!shots) fs.rmSync(path.dirname(s.file), { recursive: true, force: true });
}
