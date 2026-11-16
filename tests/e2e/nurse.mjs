// Browser end-to-end test for the nurse tabs, the MAR and NEWS2.
// Needs Playwright and a Chromium-family browser, which are not project dependencies:
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/nurse.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTestServer, patient } from '../support/helpers.mjs';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';
const DEFAULT_LAYOUT = { site: { id: 'site-main', name: 'Main' }, units: [{ id: 'ed', name: 'Emergency department', alias: 'ED', rooms: 12, bedsPerRoom: 1, roomLabel: 'Bay' }, { id: 'med', name: 'Medical ward', alias: 'MED', rooms: 6, bedsPerRoom: 4, sexOfBay: true }, { id: 'surg', name: 'Surgical ward', alias: 'SURG', rooms: 5, bedsPerRoom: 4 }, { id: 'icu', name: 'Intensive care unit', alias: 'ICU', rooms: 8, bedsPerRoom: 1, isolation: true, isolationRooms: [7, 8] }] };

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
const RX = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const doc = { 'X-Role': 'physician', 'X-User-Id': 'dr-one' };
const rph = { 'X-Role': 'nurse', 'X-User-Id': 'rph-one-a' };

try {
  await s.call('PUT', '/api/friction', { level: 'low' });
  assert.equal((await s.call('POST', '/api/beds/seed', { layout: DEFAULT_LAYOUT }, { 'X-Role': 'physician' })).status, 200, 'the default hospital layout gives the unit filter its units');
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Nursecasetwo'))).json;
  const mrn = p.identifier.find((i) => i.type?.coding?.some((c) => c.code === 'MR')).value;
  assert.equal((await s.call('POST', '/fhir/R4/Encounter', { resourceType: 'Encounter', status: 'in-progress', class: { code: 'IMP', display: 'inpatient' }, subject: { reference: `Patient/${p.id}` }, period: { start: new Date().toISOString() }, location: [{ status: 'active', location: { display: 'Medical ward / Room 1 / Bed A' } }] }, doc)).status, 201);
  const order = (code, display, frequency, dose, unit, route) => s.call('POST', '/fhir/R4/MedicationRequest', { resourceType: 'MedicationRequest', status: 'draft', intent: 'order', priority: 'routine', subject: { reference: `Patient/${p.id}` }, requester: { display: 'Dr One' }, medicationCodeableConcept: { coding: [{ system: RX, code, display }], text: display }, extension: [{ url: 'urn:hospital-desktop:lifecycle', valueCode: 'pending-verification' }], dosageInstruction: [{ text: `${dose} ${unit} ${route} ${frequency}`, timing: { code: { text: frequency } }, route: { text: route }, doseAndRate: [{ doseQuantity: { value: dose, unit } }], ...(frequency === 'PRN' ? { asNeededBoolean: true } : {}) }] }, doc);
  const amox = (await order('723', 'Amoxicillin', 'TID', 500, 'mg', 'oral')).json;
  const morphine = (await order('7052', 'Morphine', 'PRN', 2, 'mg', 'intravenous')).json;
  const unverified = (await order('2231', 'Cephalexin', 'QID', 500, 'mg', 'oral')).json;
  for (const o of [amox, morphine]) assert.equal((await s.call('POST', `/api/pharmacy/orders/${o.id}/decision`, { decision: 'verify', reasoning: 'Checked' }, rph)).status, 200);
  const lab = (await s.call('POST', '/fhir/R4/ServiceRequest', { resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: `Patient/${p.id}` }, code: { coding: [{ system: 'http://loinc.org', code: '58410-2', display: 'CBC' }], text: 'CBC' }, category: [{ coding: [{ code: 'laboratory' }] }], authoredOn: new Date().toISOString() }, doc)).json;

  const ehr = await context.newPage(); watch(ehr, 'ehr');
  await ehr.goto(`${s.base}/ehr/`);
  await ehr.evaluate(() => { localStorage.setItem('hd.role', 'nurse'); localStorage.setItem('hd.user', 'rn-one'); });

  await step('nurse lands on Tasks; the inpatient is listed with items due; the unit filter works', async () => {
    await ehr.goto(`${s.base}/ehr/#/worklist`);
    await ehr.waitForSelector(t('worklist-table'));
    assert.ok(await ehr.isVisible(t(`worklist-patient-${p.id}`)));
    assert.match(await ehr.textContent(t('worklist-summary')), /1 patient/);
    await ehr.selectOption(t('worklist-unit-filter'), 'Medical ward');
    await ehr.waitForSelector(t('worklist-table'));
    assert.ok(await ehr.isVisible(t(`worklist-patient-${p.id}`)));
  });

  await step('chart: the nurse has full access, so the tab bar has every tab, the nursing ones included', async () => {
    await ehr.click(t(`worklist-patient-${p.id}`));
    await ehr.waitForSelector(t('chart'));
    const ids = await ehr.$$eval('[data-testid^="chart-tab-"]', (els) => els.map((e) => e.dataset.testid.replace('chart-tab-', '')));
    for (const id of ['summary', 'review', 'worklist', 'mar', 'flowsheets', 'io', 'notes', 'orders', 'problems', 'medications']) assert.ok(ids.includes(id), `the nurse sees the ${id} tab`);
    await ehr.click(t('chart-tab-summary'));
    await ehr.waitForSelector(t('summary-news2'));
    assert.match(await ehr.textContent(t('summary-news2')), /not scored/);
  });

  await step('MAR: verified orders show as verified, an unverified one as awaiting pharmacy with no Record button; scheduled cells exist', async () => {
    await ehr.click(t('chart-tab-mar'));
    await ehr.waitForSelector(t('mar-grid'));
    assert.match(await ehr.textContent(t(`mar-row-${amox.id}`)), /Verified/);
    assert.match(await ehr.textContent(t(`mar-row-${unverified.id}`)), /Awaiting pharmacy/);
    assert.equal(await ehr.locator(`${t(`mar-row-${unverified.id}`)} button`).count(), 0, 'no dose can be recorded before verification');
    const cells = (await Promise.all(['day', 'night'].map(async (shift) => (await s.call('GET', `/api/nursing/mar?patient=${p.id}&shift=${shift}`, undefined, { 'X-Role': 'nurse' })).json.rows.find((r) => r.id === amox.id).cells.length))).reduce((a, b) => a + b, 0);
    assert.ok(cells >= 1, 'a TID order has at least one due cell across the two shifts (which shift depends on the clock)');
    assert.match(await ehr.textContent(t(`mar-row-${morphine.id}`)), /High alert/);
  });

  await step('MAR: a wrong wristband scan is a red blocking dialog; the right scan with a witness and PRN reason records the dose', async () => {
    await ehr.click(t(`mar-record-${morphine.id}`));
    await ehr.waitForSelector(t('mar-form'));
    await ehr.fill(t('field-patientscan'), 'N999999');
    await ehr.fill(t('field-medicationscan'), '7052');
    await ehr.fill(t('field-prnreason'), 'Pain 8 of 10');
    await ehr.fill(t('field-witness'), 'rn-two');
    await ehr.click(t('mar-form-submit'));
    await ehr.waitForSelector(t('mar-block'));
    assert.match(await ehr.textContent(t('mar-block-list')), /Wrong patient/);
    assert.ok(await ehr.locator(`${t('mar-block')}.alert-danger`).count() === 1, 'the blocking dialog is red');
    await ehr.click(`${t('mar-block')} button:has-text("Cancel")`);
    await ehr.waitForSelector(t('mar-block'), { state: 'detached' });
    await ehr.fill(t('field-patientscan'), mrn);
    await ehr.click(t('mar-form-submit'));
    await ehr.waitForSelector(t('mar-form'), { state: 'detached' });
    await ehr.waitForSelector(t('mar-grid'));
    assert.match(await ehr.textContent(t(`mar-row-${morphine.id}`)), /2/);
    const admins = (await s.call('GET', `/fhir/R4/MedicationAdministration?patient=${p.id}`)).json.entry.map((e) => e.resource);
    assert.equal(admins.length, 1);
    assert.equal(admins[0].performer[1].actor.display, 'rn-two');
  });

  await step('Flowsheets: adding a complete column scores NEWS2; a high score shows its band and opens an escalation on the Work List', async () => {
    await ehr.click(t('chart-tab-flowsheets'));
    await ehr.waitForSelector(t('flowsheet-empty'));
    await ehr.click(t('flowsheet-add'));
    await ehr.waitForSelector(t('flowsheet-form'));
    for (const [k, v] of [['hr', '118'], ['rr', '24'], ['sbp', '96'], ['temp', '38.6'], ['spo2', '92']]) await ehr.fill(t(`field-${k}`), v);
    await ehr.selectOption(t('field-consciousness'), 'A');
    await ehr.selectOption(t('field-o2device'), 'Nasal cannula');
    await ehr.click(t('flowsheet-form-submit'));
    await ehr.waitForSelector(t('flowsheet-grid'));
    assert.match(await ehr.textContent(t('flowsheet-news2-0')), /^11 high$/, 'RR 24 (2), SpO2 92 (2), oxygen (2), SBP 96 (2), HR 118 (2), temperature 38.6 (1), alert (0)');
    await ehr.click(t('chart-tab-worklist'));
    await ehr.waitForSelector(t('worklist-escalation'));
    assert.match(await ehr.textContent(t('worklist-news2')), /NEWS2 \d+ \(high\)/);
  });

  await step('Intake/Output: entries add up per shift and since admission', async () => {
    await ehr.click(t('chart-tab-io'));
    await ehr.waitForSelector(t('io-record'));
    await ehr.click(t('io-record'));
    await ehr.waitForSelector(t('io-form'));
    await ehr.selectOption(t('field-item'), 'iv');
    await ehr.fill(t('field-ml'), '750');
    await ehr.click(t('io-form-submit'));
    await ehr.waitForSelector(t('io-form'), { state: 'detached' });
    await ehr.waitForSelector(t('io-table'));
    await ehr.click(t('io-record'));
    await ehr.selectOption(t('field-item'), 'urine');
    await ehr.fill(t('field-ml'), '300');
    await ehr.click(t('io-form-submit'));
    await ehr.waitForSelector(t('io-form'), { state: 'detached' });
    await ehr.waitForFunction(() => document.querySelector('[data-testid="io-admission-balance"]')?.textContent === '+450 mL');
  });

  // Education and Care Plan no longer have chart tabs (their records stay reachable through the API, covered by tests/nursing.mjs).

  await step('Orders: the nurse acknowledges a new order; Notes offers the SBAR handover template and only nursing note types', async () => {
    await ehr.click(t('chart-tab-orders'));
    await ehr.waitForSelector(t(`order-ack-${lab.id}`));
    await ehr.click(t(`order-ack-${lab.id}`));
    await ehr.waitForSelector(t(`order-acked-${lab.id}`));
    await ehr.click(t('chart-tab-notes'));
    await ehr.waitForSelector(t('note-handover'));
    await ehr.click(t('note-handover'));
    await ehr.waitForSelector(t('note-form'));
    assert.match(await ehr.inputValue(t('field-text')), /Situation:/);
    const types = await ehr.$$eval(`${t('field-type')} option`, (els) => els.map((e) => e.textContent));
    assert.ok(types.every((x) => /Nursing/.test(x)), `nurse note types only: ${types.join(', ')}`);
    await ehr.click(t('note-form-submit'));
    await ehr.waitForSelector(t('note-form'), { state: 'detached' });
  });

  await step('physician has full access on MAR and Intake/Output (Record buttons shown), with the escalation task in the work list data', async () => {
    await ehr.evaluate(() => { localStorage.setItem('hd.role', 'physician'); });
    await ehr.goto(`${s.base}/ehr/#/chart/${p.id}/mar`);
    await ehr.waitForSelector(t('mar-grid'));
    await ehr.waitForSelector('[data-testid^="mar-record-"]');
    assert.ok(await ehr.locator('[data-testid^="mar-record-"]').count() > 0, 'Record buttons for a physician');
    await ehr.click(t('chart-tab-io'));
    await ehr.waitForSelector(t('io-table'));
    assert.equal(await ehr.locator(t('io-record')).count(), 1, 'Record intake or output for a physician');
    const tasks = (await s.call('GET', `/fhir/R4/Task?patient=${p.id}`)).json.entry.map((e) => e.resource);
    assert.ok(tasks.some((x) => x.code?.coding?.[0]?.code === 'news2-escalation'));
  });

  await step('every control on the nurse screens has a test id and a label', async () => {
    await ehr.evaluate(() => { localStorage.setItem('hd.role', 'nurse'); });
    for (const tab of ['worklist', 'mar', 'flowsheets', 'io']) {
      await ehr.goto(`${s.base}/ehr/#/chart/${p.id}/${tab}`);
      await ehr.waitForSelector(t('chart-body'), { state: 'attached' }).catch(() => {});
      await ehr.waitForSelector('.chart-body');
      const bad = await ehr.$$eval('.chart-body button, .chart-body input, .chart-body select', (els) => els.filter((e) => !e.dataset.testid && !e.getAttribute('aria-label')).map((e) => e.outerHTML.slice(0, 80)));
      assert.deepEqual(bad, [], `${tab}: ${bad.join(' | ')}`);
    }
  });
} finally {
  await browser.close();
  await s.close();
}
if (errors.length) { console.error('Console errors:\n' + errors.join('\n')); process.exit(1); }
console.log(`${steps.length} browser steps passed. Console errors: 0. Expected 409/422/403 responses logged by the browser: ${expected4xx.length}.`);
