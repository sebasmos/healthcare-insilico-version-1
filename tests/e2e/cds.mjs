// Browser end-to-end test for CDS Hooks in the EHR.
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/cds.mjs
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
// Under high friction the chart-open advisories dialog can appear first (its set depends on the day); accept it so the CDS call follows.
const acceptAdvisories = async (page) => { const dlg = page.locator(t('advisories-accept')); try { await dlg.waitFor({ timeout: 2500 }); await dlg.click(); } catch { /* none today */ } };
const steps = [];
const step = async (name, fn) => { await fn(); steps.push(name); console.log(`ok - ${name}`); };
const doc = { 'X-Role': 'physician', 'X-User-Id': 'dr-one' };
const nurse = { 'X-Role': 'nurse', 'X-User-Id': 'rn-one' };
const RX = 'http://www.nlm.nih.gov/research/umls/rxnorm';

try {
  await s.call('PUT', '/api/friction', { level: 'high' });
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Cardcase', { gender: 'male', birthDate: '1948-01-01' }))).json;
  await s.call('POST', '/api/nursing/flowsheet', { patient: p.id, at: new Date().toISOString(), vitals: { rr: 25, spo2: 91, sbp: 96, hr: 118, temp: 38.4 }, assessments: { consciousness: 'A', o2device: 'Nasal cannula' } }, nurse);
  const aspirin = await s.call('POST', '/fhir/R4/MedicationRequest', { resourceType: 'MedicationRequest', status: 'draft', intent: 'order', subject: { reference: `Patient/${p.id}` }, medicationCodeableConcept: { coding: [{ system: RX, code: '1191', display: 'Aspirin' }], text: 'Aspirin' }, extension: [{ url: 'urn:hospital-desktop:lifecycle', valueCode: 'pending-verification' }], dosageInstruction: [{ text: '81 mg oral daily', timing: { code: { text: 'daily' } }, route: { text: 'oral' }, doseAndRate: [{ doseQuantity: { value: 81, unit: 'mg' } }] }] }, doc);
  assert.equal(aspirin.status, 201, aspirin.text);
  const ehr = await context.newPage(); watch(ehr, 'ehr');
  await ehr.goto(`${s.base}/ehr/`);
  await ehr.evaluate(() => { localStorage.setItem('hd.role', 'physician'); localStorage.setItem('hd.user', 'dr-one'); });

  await step('opening the chart fires patient-view: a critical NEWS2 card shows with a link; it is dismissed with an override reason', async () => {
    await ehr.goto(`${s.base}/ehr/#/chart/${p.id}/summary`);
    await acceptAdvisories(ehr);
    await ehr.waitForSelector(t('cds-cards'));
    const card = ehr.locator('[data-testid^="cds-card-"][data-service="news2-card"]');
    assert.equal(await card.count(), 1);
    assert.match(await card.textContent(), /NEWS2 \d+/);
    await card.locator('[data-testid^="cds-dismiss-"]').click();
    await ehr.waitForSelector(t('cds-override'));
    await ehr.fill(t('field-reason'), 'Already reviewed at the bedside');
    await ehr.click(t('cds-override-submit'));
    await ehr.waitForFunction(() => /Overridden/.test(document.querySelector('[data-testid^="cds-status-"]')?.textContent || ''));
    await ehr.click(t('cds-continue'));
    await ehr.waitForSelector(t('cds-cards'), { state: 'detached' });
  });

  await step('choosing an imaging order fires order-select: an appropriateness reminder appears and is dismissed', async () => {
    await ehr.click(t('chart-tab-orders'));
    await ehr.waitForSelector(t('order-search'));
    await ehr.fill(t('order-search'), 'CT Head (CT) · LOINC 24725-4');
    await ehr.dispatchEvent(t('order-search'), 'change');
    await ehr.waitForSelector(t('cds-cards'));
    assert.ok((await ehr.locator('[data-service="imaging-appropriateness"]').count()) >= 1);
    await ehr.click(t('cds-continue'));
    await ehr.waitForSelector(t('cds-cards'), { state: 'detached' });
  });

  await step('signing a warfarin prescription fires order-sign: the interaction card must be overridden before continuing; the order is then written as a draft', async () => {
    await ehr.click(t('prescribe'));
    await acceptAdvisories(ehr);
    await ehr.waitForSelector(t('prescribe-form'));
    await ehr.fill(t('field-medication'), 'Warfarin (RxNorm 11289)');
    await ehr.fill(t('field-dose'), '5');
    await ehr.click(t('prescribe-form-submit'));
    await acceptAdvisories(ehr);
    await ehr.waitForSelector(t('cds-cards'));
    const card = ehr.locator('[data-service="interaction-check"]');
    assert.ok((await card.count()) >= 1, 'interaction card on order-sign');
    await ehr.click(t('cds-continue'));
    assert.ok(await ehr.isVisible(t('toast-error')), 'a critical card must be overridden first');
    await card.first().locator('[data-testid^="cds-dismiss-"]').click();
    await ehr.fill(t('field-reason'), 'Cardiology advised, INR monitored');
    await ehr.click(t('cds-override-submit'));
    await ehr.waitForFunction(() => /Overridden/.test(document.querySelector('[data-service="interaction-check"] [data-testid^="cds-status-"]')?.textContent || ''));
    await ehr.click(t('cds-continue'));
    await ehr.waitForSelector(t('cds-cards'), { state: 'detached' });
    await ehr.waitForFunction(() => /Warfarin/.test(document.querySelector('.chart-body')?.textContent || ''));
    const meds = (await s.call('GET', `/fhir/R4/MedicationRequest?patient=${p.id}`)).json.entry.map((e) => e.resource);
    assert.ok(meds.some((m) => /Warfarin/.test(m.medicationCodeableConcept?.text || m.medicationCodeableConcept?.coding?.[0]?.display)));
  });

  await step('the Agent Dashboard CDS report counts calls, cards and override reasons', async () => {
    const ops = await context.newPage(); watch(ops, 'ops');
    await ops.goto(`${s.base}/agent-ops/#/cds`);
    await ops.waitForSelector(t('cds-report'));
    const text = await ops.textContent(t('cds-report'));
    assert.match(text, /news2-card/);
    assert.match(text, /interaction-check/);
    assert.match(text, /Cardiology advised|other/);
    assert.ok(await ops.isVisible(t('cds-services')));
    await ops.close();
  });

  await step('every CDS control has a test id and a label', async () => {
    await s.call('PUT', '/api/friction', { level: 'high' });
    // A fresh page: cards already decided in this page are not shown again.
    const fresh = await context.newPage(); watch(fresh, 'ehr-fresh');
    await fresh.goto(`${s.base}/ehr/#/chart/${p.id}/summary`);
    await acceptAdvisories(fresh);
    await fresh.waitForSelector(t('cds-cards'));
    const bad = await fresh.$$eval('[data-testid="cds-cards"] button, [data-testid="cds-cards"] a', (els) => els.filter((e) => !e.dataset.testid && !e.getAttribute('aria-label')).map((e) => e.outerHTML.slice(0, 80)));
    assert.deepEqual(bad, []);
  });
} finally {
  await browser.close();
  await s.close();
}
if (errors.length) { console.error('Console errors:\n' + errors.join('\n')); process.exit(1); }
console.log(`${steps.length} browser steps passed. Console errors: 0. Expected 409/422/403 responses logged by the browser: ${expected4xx.length}.`);
