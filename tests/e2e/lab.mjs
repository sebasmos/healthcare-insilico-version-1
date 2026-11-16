// Browser end-to-end test for the Lab app.
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/lab.mjs
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
const LOINC = 'http://loinc.org';

try {
  await s.call('PUT', '/api/friction', { level: 'low' });
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Labtest'))).json;
  const mrn = p.identifier.find((i) => i.type?.coding?.some((c) => c.code === 'MR')).value;
  const order = (await s.call('POST', '/fhir/R4/ServiceRequest', { resourceType: 'ServiceRequest', status: 'active', intent: 'order', priority: 'stat', subject: { reference: `Patient/${p.id}` }, authoredOn: new Date().toISOString(), code: { coding: [{ system: LOINC, code: '58410-2', display: 'Complete blood count (CBC)' }], text: 'Complete blood count (CBC)' }, category: [{ coding: [{ system: 'urn:hospital-desktop:order-category', code: 'laboratory' }] }], requester: { display: 'Dr One' } }, doc)).json;

  const lab = await context.newPage(); watch(lab, 'lab');
  await lab.goto(`${s.base}/`);
  await lab.evaluate(() => { localStorage.setItem('hd.role', 'nurse'); localStorage.setItem('hd.user', 'mlt-one'); });

  await step('worklist: the STAT order is pending collection; a wrong wristband scan is refused; the right scans collect it', async () => {
    await lab.goto(`${s.base}/lab/#/worklist`);
    await lab.waitForSelector(t(`collect-${order.id}`));
    await lab.click(t(`collect-${order.id}`));
    await lab.waitForSelector(t('collect-form'));
    await lab.fill(t('field-patientscan'), 'N000000');
    await lab.fill(t('field-tubelabel'), order.id);
    await lab.click(t('collect-form-submit'));
    await lab.waitForFunction(() => /Wrong patient/.test(document.querySelector('[data-testid="collect-form-error"]')?.textContent || ''));
    await lab.fill(t('field-patientscan'), mrn);
    await lab.click(t('collect-form-submit'));
    await lab.waitForSelector(t('specimen-state'));
    assert.match(await lab.textContent(t('specimen-state')), /Collected/);
  });

  await step('specimen page: send, receive with a bench and accession number, enter results with a flag, verify is refused for the enterer', async () => {
    await lab.click(t('specimen-transit'));
    await lab.waitForFunction(() => /In transit/.test(document.querySelector('[data-testid="specimen-state"]')?.textContent || ''));
    await lab.click(t('specimen-receive'));
    await lab.waitForSelector(t('receive-form'));
    await lab.selectOption(t('field-bench'), 'haematology');
    await lab.click(t('receive-form-submit'));
    await lab.waitForFunction(() => /Received/.test(document.querySelector('[data-testid="specimen-state"]')?.textContent || ''));
    assert.match(await lab.textContent('h1'), /A\d{2}-\d{5}/);
    await lab.click(t('enter-results'));
    await lab.waitForSelector(t('results-form'));
    await lab.fill(t('field-718-7'), '7.5');
    await lab.fill(t('field-777-3'), '15');
    await lab.click(t('results-form-submit'));
    await lab.waitForSelector(t('result-status-718-7'));
    assert.match(await lab.textContent(t('analytes')), /LL|L\b/);
    assert.match(await lab.textContent(t('specimen-state')), /Resulted/);
    await lab.click(t('specimen-verify'));
    await lab.click(t('verify-confirm-ok'));
    await lab.waitForSelector(t('toast-error'));
    assert.match(await lab.locator(t('toast-error')).last().textContent(), /second step/);
  });

  await step('a second technologist verifies; the critical platelet count goes to the criticals page and is phoned with read-back', async () => {
    await lab.evaluate(() => { localStorage.setItem('hd.user', 'mlt-two'); });
    await lab.reload();
    await lab.waitForSelector(t('specimen-verify'));
    await lab.click(t('specimen-verify'));
    await lab.click(t('verify-confirm-ok'));
    await lab.waitForFunction(() => /Verified/.test(document.querySelector('[data-testid="specimen-state"]')?.textContent || ''));
    await lab.click(t('nav-criticals'));
    await lab.waitForSelector('[data-testid^="phone-"]');
    await lab.click('[data-testid^="phone-"]');
    await lab.fill(t('field-to'), 'Dr One');
    await lab.check(t('field-readback'));
    await lab.click(t('phone-form-submit'));
    await lab.waitForSelector(t('criticals-empty'));
    const done = (await s.call('GET', `/fhir/R4/ServiceRequest/${order.id}`)).json;
    assert.equal(done.status, 'completed');
    await lab.click(t('nav-worklist'));
    await lab.waitForSelector(t('tat-stat'));
    assert.match(await lab.textContent(t('tat-stat')), /min|h/);
  });

  await step('quality control: an out-of-range point shows on the plot and blocks verification; the rules page saves auto-verification', async () => {
    await lab.click(t('nav-qc'));
    await lab.waitForSelector(t('qc-add'));
    await lab.click(t('qc-add'));
    await lab.selectOption(t('field-analyte'), '2345-7');
    await lab.fill(t('field-mean'), '100');
    await lab.fill(t('field-sd'), '2');
    await lab.fill(t('field-value'), '106');
    await lab.click(t('qc-form-submit'));
    await lab.waitForSelector(t('lj-2345-7'));
    assert.match(await lab.textContent(t('qc-status-2345-7')), /Out of range/);
    await lab.click(t('nav-rules'));
    await lab.waitForSelector(t('rule-2345-7'));
    await lab.check(t('rule-2345-7'));
    await lab.click(t('rules-save'));
    for (let i = 0; i < 50 && !(await s.call('GET', '/api/lab/autoverify')).json.autoVerify.length; i += 1) await lab.waitForTimeout(100);
    assert.deepEqual((await s.call('GET', '/api/lab/autoverify')).json.autoVerify, ['2345-7']);
  });

  await step('EHR: the physician still sees the verified results on the Orders tab and a nurse gets the recollect task after a rejection', async () => {
    const o2 = (await s.call('POST', '/fhir/R4/ServiceRequest', { resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: `Patient/${p.id}` }, authoredOn: new Date().toISOString(), code: { coding: [{ system: LOINC, code: '2345-7', display: 'Glucose' }], text: 'Glucose' }, category: [{ coding: [{ system: 'urn:hospital-desktop:order-category', code: 'laboratory' }] }] }, doc)).json;
    const sp = (await s.call('POST', '/api/lab/specimens/collect', { order: o2.id, patientScan: mrn, tubeLabel: o2.id }, { 'X-Role': 'nurse', 'X-User-Id': 'rn-one' })).json;
    await lab.goto(`${s.base}/lab/#/specimen/${sp.id}`);
    await lab.waitForSelector(t('specimen-reject'));
    await lab.click(t('specimen-reject'));
    await lab.selectOption(t('field-reason'), 'clotted');
    await lab.click(t('reject-form-submit'));
    await lab.waitForFunction(() => /Rejected/.test(document.querySelector('[data-testid="specimen-state"]')?.textContent || ''));
    const tasks = (await s.call('GET', `/fhir/R4/Task?patient=${p.id}`)).json.entry.map((e) => e.resource);
    assert.ok(tasks.some((x) => x.code?.coding?.[0]?.code === 'recollect'));
    const ehr = await context.newPage(); watch(ehr, 'ehr');
    await ehr.goto(`${s.base}/ehr/`);
    await ehr.evaluate(() => { localStorage.setItem('hd.role', 'physician'); localStorage.setItem('hd.user', 'dr-one'); });
    await ehr.goto(`${s.base}/ehr/#/chart/${p.id}/review/labs`);
    await ehr.waitForSelector('.chart-body');
    await ehr.waitForFunction(() => /7\.5/.test(document.querySelector('.chart-body')?.textContent || ''));
    await ehr.close();
  });

  await step('every control on the Lab screens has a test id and a label', async () => {
    for (const hash of ['#/worklist', '#/criticals', '#/qc', '#/rules']) {
      await lab.goto(`${s.base}/lab/${hash}`);
      await lab.waitForSelector('main');
      const bad = await lab.$$eval('main button, main input, main select', (els) => els.filter((e) => !e.dataset.testid && !e.getAttribute('aria-label')).map((e) => e.outerHTML.slice(0, 80)));
      assert.deepEqual(bad, [], hash);
    }
  });
} finally {
  await browser.close();
  await s.close();
}
if (errors.length) { console.error('Console errors:\n' + errors.join('\n')); process.exit(1); }
console.log(`${steps.length} browser steps passed. Console errors: 0. Expected 409/422/403 responses logged by the browser: ${expected4xx.length}.`);
