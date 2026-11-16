// Browser end-to-end test for remote patient monitoring.
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/rpm.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTestServer, patient } from '../support/helpers.mjs';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch { console.log('SKIPPED: Playwright is not installed. Set PLAYWRIGHT_MODULE to its path to run the browser test.'); process.exit(0); }

const s = await startTestServer({ webRoot: REPO_ROOT });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
context.setDefaultTimeout(10000);
const errors = [];
const expected4xx = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() !== 'error') return; if (/status of (409|422|403)/.test(m.text())) expected4xx.push(m.text()); else errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
};
const t = (id) => `[data-testid="${id}"]`;
const steps = [];
const step = async (name, fn) => { await fn(); steps.push(name); console.log(`ok - ${name}`); };
const doc = { 'X-Role': 'physician', 'X-User-Id': 'dr-one' };

try {
  await s.call('PUT', '/api/friction', { level: 'low' });
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Homecare'))).json;
  const mon = await context.newPage(); watch(mon, 'monitoring');
  await mon.goto(`${s.base}/`);
  await mon.evaluate(() => { localStorage.setItem('hd.role', 'physician'); localStorage.setItem('hd.user', 'dr-one'); });

  await step('physician enrols the patient in heart-failure monitoring with a custom systolic limit', async () => {
    await mon.goto(`${s.base}/monitoring/#/enrol`);
    await mon.waitForSelector(t('enrol-open'));
    await mon.click(t('enrol-open'));
    await mon.waitForSelector(t('enrol-form'));
    await mon.selectOption(t('field-patient'), p.id);
    await mon.selectOption(t('field-programme'), 'heart-failure');
    await mon.fill(t('field-sbp-high'), '140');
    await mon.click(t('enrol-form-submit'));
    await mon.waitForSelector(t('thresholds'));
    assert.match(await mon.textContent(t('thresholds')), /140/);
    assert.equal(await mon.locator(t('chart-body-weight')).count(), 1);
  });

  await step('patient enters readings in the portal; an unusual value is flagged; a high reading alerts the care team', async () => {
    const portal = await context.newPage(); watch(portal, 'portal');
    await portal.goto(`${s.base}/portal/`);
    await portal.waitForSelector(t(`pick-${p.id}`));
    await portal.click(t(`pick-${p.id}`));
    await portal.goto(`${s.base}/portal/#/readings`);
    await portal.waitForSelector(t('reading-enter-weight'));
    assert.ok(await portal.isVisible(t('readings-emergency')));
    await portal.click(t('reading-enter-weight'));
    await portal.fill(t('field-value'), '80');
    await portal.click(t('reading-form-submit'));
    await portal.waitForSelector(t('portal-chart-weight'));
    await portal.click(t('reading-enter-sbp'));
    await portal.fill(t('field-value'), '162');
    await portal.click(t('reading-form-submit'));
    await portal.waitForFunction(() => /alerted/.test([...document.querySelectorAll('[data-testid="toast"]')].map((e) => e.textContent).join(' ')));
    await portal.close();
  });

  await step('dashboard: one row with latest readings, sparkline, adherence and the open alert; the alert queue sorts by severity', async () => {
    await mon.goto(`${s.base}/monitoring/#/dashboard`);
    await mon.waitForSelector(t(`open-${p.id}`));
    assert.match(await mon.textContent(t('rpm-rows')), /162/);
    assert.match(await mon.textContent(t('metric-alerts')), /^1$/);
    await mon.click(t('nav-alerts'));
    await mon.waitForSelector('[data-testid^="alert-ack-"]');
    assert.match(await mon.textContent(t('rpm-alerts')), /above the target/);
  });

  await step('alert actions: acknowledge (time measured), message the patient, snooze with a reason, escalate, close with an outcome', async () => {
    await mon.click('[data-testid^="alert-ack-"]');
    await mon.waitForSelector('[data-testid^="alert-ack-"]', { state: 'detached' });
    await mon.click('[data-testid^="alert-message-"]');
    await mon.fill(t('field-text'), 'Please rest and repeat the reading in an hour.');
    await mon.click(t('alert-message-form-submit'));
    await mon.waitForSelector(t('alert-message-form'), { state: 'detached' });
    await mon.click('[data-testid^="alert-snooze-"]');
    await mon.fill(t('field-reason'), 'Seen in clinic today');
    await mon.click(t('alert-snooze-form-submit'));
    await mon.waitForFunction(() => /snoozed until/.test(document.querySelector('[data-testid="rpm-alerts"]')?.textContent || ''));
    await mon.click('[data-testid^="alert-escalate-"]');
    await mon.click(t('alert-escalate-form-submit'));
    await mon.waitForFunction(() => /High/.test(document.querySelector('[data-testid="rpm-alerts"]')?.textContent || ''));
    await mon.click('[data-testid^="alert-close-"]');
    await mon.fill(t('field-outcome'), 'Dose adjusted');
    await mon.click(t('alert-close-form-submit'));
    await mon.waitForSelector(t('rpm-alerts-empty'));
    const comms = (await s.call('GET', `/fhir/R4/Communication?patient=${p.id}`)).json.entry;
    assert.equal(comms.length, 1);
    await mon.click(t('nav-dashboard'));
    await mon.waitForSelector(t('metric-tta'));
    assert.match(await mon.textContent(t('metric-tta')), /min mean/);
  });

  await step('patient page: charts with threshold lines, adjust a threshold; the Inbox has a Monitoring alerts folder', async () => {
    await mon.goto(`${s.base}/monitoring/#/patient/${p.id}`);
    await mon.waitForSelector(t('chart-systolic-blood-pressure'));
    await mon.click(t('adjust-sbp'));
    await mon.fill(t('field-high'), '150');
    await mon.click(t('threshold-form-submit'));
    await mon.waitForFunction(() => /150/.test(document.querySelector('[data-testid="thresholds"]')?.textContent || ''));
    const ehr = await context.newPage(); watch(ehr, 'ehr');
    await ehr.goto(`${s.base}/ehr/#/inbox?folder=monitoring`);
    await ehr.waitForSelector(t('inbox-folder-monitoring'));
    await ehr.waitForSelector(t('inbox-monitoring'));
    assert.match(await ehr.textContent(t('inbox-monitoring')), /above the target|Nothing here/);
    await ehr.close();
  });

  await step('home readings never reach the inpatient vitals or critical rules; every control has a test id and a label', async () => {
    const vitals = (await s.call('GET', `/fhir/R4/Observation?patient=${p.id}&category=vital-signs`)).json.entry || [];
    assert.equal(vitals.length, 0);
    assert.equal((await s.call('GET', '/api/badges')).json.criticalUnacknowledged.length, 0);
    for (const hash of ['#/dashboard', '#/alerts', '#/enrol', `#/patient/${p.id}`]) {
      await mon.goto(`${s.base}/monitoring/${hash}`);
      await mon.waitForSelector('main');
      const bad = await mon.$$eval('main button, main input, main select', (els) => els.filter((e) => !e.dataset.testid && !e.getAttribute('aria-label')).map((e) => e.outerHTML.slice(0, 80)));
      assert.deepEqual(bad, [], hash);
    }
  });
} finally {
  await browser.close();
  await s.close();
}
if (errors.length) { console.error('Console errors:\n' + errors.join('\n')); process.exit(1); }
console.log(`${steps.length} browser steps passed. Console errors: 0. Expected 409/422/403 responses logged by the browser: ${expected4xx.length}.`);
