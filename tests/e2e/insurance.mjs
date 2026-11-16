// Browser test for the insurance environment: a nurse asks for authorization from the EHR, the insurer's medical
// director reviews it in the three-pane workbench and denies it against a named criterion, the coder codes the visit,
// builds and sends the claim, and the patient sees the card, the letter and the explanation of benefits.
// No names anywhere: every fixture is made here, by number.
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/insurance.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTestServer, tempDir } from '../support/helpers.mjs';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';

process.env.PAYER_REFERENCE_FILE = path.join(tempDir('hd-ref-'), 'ref.sqlite');
const ref = await import('../../insurance-and-billing/server/reference.mjs');
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch { console.log('SKIPPED: Playwright is not installed. Set PLAYWRIGHT_MODULE to its path to run the browser test.'); process.exit(0); }
const db = ref.openReference(); const rel = Number(db.prepare('INSERT INTO releases (kind, release, source, file, checksum, rows, imported_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run('pfs-rvu', '2024A', 'test fixture built at run time', 'pfs.csv', 'x', '2024-01-01T00:00:00Z').lastInsertRowid);
for (const [code, w, pe] of [['99213', 1.30, 1.33], ['70553', 2.29, 7.0]]) db.prepare('INSERT INTO pfs_rvu (code, modifier, status, work, pe_nonfac, pe_fac, mp, conversion, release) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(code, '', 'A', w, pe, pe, 0.1, 32.7442, rel);

const s = await startTestServer({ webRoot: REPO_ROOT });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome' });
const t = (id) => `[data-testid="${id}"]`;
const errors = []; const steps = [];
const step = async (name, fn) => { try { await fn(); steps.push(name); console.log(`ok - ${name}`); } catch (err) { console.log(`FAILED after ${steps.length} steps: ${name}\n${err.stack || err}`); if (errors.length) console.log(`Console errors:\n${errors.join('\n')}`); await browser.close(); await s.close(); process.exit(1); } };
const newPage = async (user, role, extra = {}) => { const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } }); await ctx.addInitScript(([u, r, x]) => { localStorage.setItem('hd.role', r); localStorage.setItem('hd.user', u); localStorage.setItem('hd.session', 'in'); localStorage.setItem('hd.wallpaper', 'builtin'); for (const [k, v] of Object.entries(x)) localStorage.setItem(k, v); }, [user, role, extra]); const page = await ctx.newPage(); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); }); page.on('pageerror', (e) => errors.push(String(e))); return page; };
const unlabelled = (page) => page.evaluate(() => [...document.querySelectorAll('button, input, select, textarea')].filter((el) => !el.dataset.testid || !el.getAttribute('aria-label')).map((el) => el.outerHTML.slice(0, 120)));
const RES = { 'X-Role': 'researcher', 'X-User-Id': 'researcher-1' };
const D0 = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);

await s.call('POST', '/api/ins/profile', { kind: 'academic-medical-center', npi: '1234567893', payerMix: { 'commercial-employer': 1 } }, RES);
const plan = (await s.call('POST', '/api/ins/plans', { type: 'commercial-employer', benefits: { deductible: 50, coinsurance: 0.2, oopMax: 5000 }, network: { all: true }, authRequired: ['70553'], rateSource: 'fee-schedule' }, RES)).json;
await s.call('POST', '/api/ins/policies/confirm', { id: 'head-imaging', version: '1', effective: '2025-01-01', title: 'Imaging of the head', appliesTo: [{ code: '70553' }], criteria: [{ id: 'dx', text: 'A diagnosis of headache or migraine', evidence: { kind: 'diagnosis', codes: ['R51', 'G43'] } }, { id: 'tried', text: 'First-line treatment was tried', evidence: { kind: 'text', any: ['first-line treatment was tried'] } }] }, RES);
const p = (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', gender: 'female', birthDate: '1980-02-03', identifier: [{ type: { coding: [{ code: 'MR' }] }, value: 'N100130' }] })).json;
await s.call('POST', `/api/ins/coverage/${p.id}`, { plan: plan.id }, RES);
const enc = (await s.call('POST', '/fhir/R4/Encounter', { resourceType: 'Encounter', status: 'in-progress', class: { code: 'AMB' }, subject: { reference: `Patient/${p.id}` }, period: { start: `${D0}T09:00:00Z`, end: `${D0}T09:30:00Z` } })).json;
const note = await s.store.save('DocumentReference', { resourceType: 'DocumentReference', status: 'current', docStatus: 'final', subject: { reference: `Patient/${p.id}` }, context: { encounter: [{ reference: `Encounter/${enc.id}` }] }, type: { text: 'Clinic note' }, content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('Low back pain for two weeks. First-line treatment was tried without relief.').toString('base64') } }] }, { branch: 'main', updatedBy: 'test' });

const nurse = await newPage('nurse-1', 'nurse');
await step('Nurse: the insurance desk says authorization is needed, shows the plan\'s questions, and sends the request with the chosen note', async () => {
  await nurse.goto(`${s.base}/ehr/#/billing`); await nurse.waitForSelector(t('auth-queue'));
  await nurse.click(t('auth-new')); await nurse.waitForSelector(t('auth-form'));
  await nurse.fill(t('field-codes'), '70553'); await nurse.fill(t('field-diagnoses'), 'M54.5'); await nurse.fill(t('field-date'), D0);
  await nurse.click(t('crd-check')); await nurse.waitForFunction(() => /Authorization is needed/.test(document.querySelector('[data-testid="crd-result"]')?.textContent || ''));
  await nurse.waitForSelector(t('dtr-item-tried')); await nurse.check(t(`auth-doc-${note.id}`));
  assert.deepEqual(await unlabelled(nurse), []);
  await nurse.click(t('auth-form-submit')); await nurse.waitForFunction(() => /Patient N100130/.test(document.querySelector('[data-testid="auth-queue"]')?.textContent || ''));
  assert.equal(await nurse.locator(t('decide-approve')).count(), 0, 'no approve or deny on the hospital side');
});
const director = await newPage('director-1', 'payer-medical-director');
await step('Medical director: the workbench shows the request, the records with the evidence marked, and the criteria; a denial names the unmet criterion', async () => {
  await director.goto(`${s.base}/payer/#/bench`); await director.waitForSelector(t('bench-queue'));
  await director.click(`${t('bench-queue')} tbody tr`); await director.waitForSelector(t('bench-panes'));
  assert.match(await director.textContent(t('pane-request')), /Patient N100130/); assert.match(await director.textContent(t('pane-records')), /First-line treatment was tried/);
  assert.equal(await director.locator(`${t('pane-records')} mark`).count(), 1, 'the quoted evidence is marked in the note');
  assert.match(await director.textContent(t('criterion-dx')), /Not met/); assert.equal(await director.isChecked(t('unmet-dx')), true);
  assert.deepEqual(await unlabelled(director), []);
  await director.click(t('decide-deny')); await director.fill(t('field-reason'), 'The diagnosis sent is low back pain, not headache or migraine.'); await director.click(t('decide-denied-submit'));
  await director.waitForSelector(t('bench-queue-empty'));
});
const coder = await newPage('coder-1', 'coder');
await step('Coder: codes the visit from the signed note, builds the claim, sends it, and sees it paid with the reasons', async () => {
  await coder.goto(`${s.base}/ehr/#/billing`); await coder.click(t('ins-tab-coding'));
  await coder.click(`${t('coding-queue')} tbody tr`); await coder.waitForSelector(t('coding-form'));
  assert.match(await coder.textContent(t(`coding-note-${note.id}`)), /Low back pain/);
  await coder.fill(t('field-diagnoses'), 'M54.5'); await coder.fill(t('field-lines'), '99213 - 1 150'); await coder.click(t('coding-form-submit'));
  await coder.waitForFunction(() => /Coded/.test(document.querySelector('[data-testid="coding-queue"]')?.textContent || ''));
  await coder.click(`${t('coding-queue')} tbody tr`); await coder.click(t('coding-build')); await coder.waitForSelector(t('claims-table'));
  await coder.click(`${t('claims-table')} tbody tr`); await coder.click(t('claim-send'));
  await coder.waitForFunction(() => /Paid/.test(document.querySelector('[data-testid="claims-table"]')?.textContent || ''));
  await coder.click(`${t('claims-table')} tbody tr`); await coder.waitForSelector(t('ins-wire'));
  const lines = await coder.textContent(t('claim-lines')); assert.match(lines, /\$31\.51/); assert.match(lines, /PR-1 \$50\.00/);
  const wire = await coder.textContent(t('ins-wire')); for (const m of ['837P', '999', '277CA', '835']) assert.ok(wire.includes(m), m);
  assert.deepEqual(await unlabelled(coder), []);
});
const pt = await newPage('physician-1', 'physician', { 'hd.patient': p.id });
await step('Patient Portal: the card with the deductible met, the denial in plain words with its letter, and the explanation of benefits', async () => {
  await pt.goto(`${s.base}/portal/#/insurance`); await pt.waitForSelector(t('my-card'));
  assert.match(await pt.textContent(t('my-accumulators')), /\$50\.00 of \$50\.00/); assert.match(await pt.textContent(t('my-auths')), /Not approved/);
  assert.ok(await pt.locator(`${t('my-letters')} tbody tr`).count() >= 1); assert.match(await pt.textContent(t('my-eobs')), /\$57\.88/);
  assert.ok(!/"family"|undefined|null/.test(await pt.textContent(t('my-insurance'))));
  assert.deepEqual(await unlabelled(pt), []);
});
const doc = await newPage('physician-1', 'physician');
await step('Physician: the order check says authorization is needed; Inbox has the coding question to answer and the letter to sign; the chart has a Coverage tab', async () => {
  const hook = await s.call('POST', '/api/cds/invoke', { hook: 'order-select', context: { patientId: p.id, selections: ['ServiceRequest/d1'], draftOrders: { resourceType: 'Bundle', entry: [{ resource: { resourceType: 'ServiceRequest', id: 'd1', status: 'draft', intent: 'order', subject: { reference: `Patient/${p.id}` }, code: { coding: [{ code: '70553' }] } } }] } } }, { 'X-Role': 'physician', 'X-User-Id': 'physician-1' });
  assert.ok((hook.json.cards || []).some((c) => /Authorization needed/.test(c.summary)), hook.text.slice(0, 400));
  await s.call('POST', `/api/ins/coding/${enc.id}/query`, { question: 'What is the cause of the back pain, if known?', indicators: ['Pain for two weeks'] }, { 'X-Role': 'coder', 'X-User-Id': 'coder-1' });
  const claims = (await s.call('GET', '/api/ins/claims', undefined, RES)).json; const auths = (await s.call('GET', '/api/ins/auth', undefined, RES)).json;
  await s.call('POST', '/api/ins/letters', { about: { kind: 'auth', ref: auths[0].id }, kind: 'appeal', text: 'The scan is needed.' }, { 'X-Role': 'nurse', 'X-User-Id': 'nurse-1' });
  await doc.goto(`${s.base}/ehr/#/inbox?folder=ins-queries`); await doc.waitForSelector(t('inbox-ins-queries'));
  await doc.click(`${t('inbox-ins-queries')} button`); await doc.fill(t('field-answer'), 'Mechanical low back pain.'); await doc.click(t('query-answer-form-submit')); await doc.waitForSelector(t('inbox-ins-queries-empty'));
  await doc.click(t('inbox-folder-ins-denials')); await doc.waitForFunction(() => /not headache or migraine|A diagnosis of headache/.test(document.querySelector('[data-testid="inbox-ins-denials"]')?.textContent || ''));
  await doc.click(t('inbox-folder-ins-letters')); await doc.click(`${t('inbox-ins-letters')} button`); await doc.waitForSelector(t('inbox-ins-letters-empty'));
  await doc.goto(`${s.base}/ehr/#/chart/${p.id}/coverage`); await doc.waitForSelector(t('chart-coverage'));
  assert.match(await doc.textContent(t('chart-auths')), /Denied/); assert.match(await doc.textContent(t('chart-claims')), /\$31\.51/);
  await doc.click(t('chart-estimate')); await doc.fill(t('field-lines'), '99213 150'); await doc.click(t('estimate-form-submit')); await doc.waitForSelector(t('estimate-result')); await doc.click(t('estimate-close'));
  assert.deepEqual(await unlabelled(doc), []);
  assert.equal(claims.length, 1);
});
await step('Audit and recovery: the insurer finds an overpayment, the hospital disputes it, recovery waits; stays show the two-midnight rule; the patient sees the estimate', async () => {
  await director.goto(`${s.base}/payer/#/bench`); await director.click(t('bench-tab-paid')); await director.click(`${t('bench-queue')} tbody tr`); await director.click(t('claim-audit'));
  await director.fill(t('field-reason'), 'Sampled for review.'); await director.click(t('audit-open-form-submit')); await director.waitForSelector(t('audits-table'));
  await director.click(`${t('audits-table')} [data-testid^="audit-finding-"]`); await director.fill(t('field-amount'), '10'); await director.fill(t('field-reason'), 'The level billed is not supported.'); await director.click(t('audit-finding-form-submit'));
  await director.waitForFunction(() => /Finding/.test(document.querySelector('[data-testid="audits-table"]')?.textContent || '')); await director.waitForSelector(t('patterns-table'));
  await coder.reload(); await coder.click(t('ins-tab-audits')); await coder.click(`${t('audits-table')} [data-testid^="audit-dispute-"]`); await coder.fill(t('field-reason'), 'The note supports the level.'); await coder.click(t('audit-dispute-form-submit'));
  await coder.waitForFunction(() => /no recovery meanwhile/.test(document.querySelector('[data-testid="audits-table"]')?.textContent || ''));
  const e2 = (await s.call('POST', '/fhir/R4/Encounter', { resourceType: 'Encounter', status: 'in-progress', class: { code: 'IMP' }, subject: { reference: `Patient/${p.id}` }, period: { start: `${D0}T09:00:00Z` } })).json;
  await coder.click(t('ins-tab-stays')); await coder.waitForSelector(t(`stays-table-row-${e2.id}`)); assert.match(await coder.textContent(t('stays-table')), /Expected midnights not recorded/);
  await coder.click(t('ins-tab-disputes')); await coder.waitForSelector(t('disputes-table-empty')); assert.deepEqual(await unlabelled(coder), []); assert.deepEqual(await unlabelled(director), []);
  await pt.reload(); await pt.waitForSelector(t('my-estimates')); assert.match(await pt.textContent(t('my-estimates')), /99213/);
});
await step('Insurer roles reach only the workbench: the chart, images and other apps refuse them', async () => {
  const dir = { 'X-Role': 'payer-medical-director', 'X-User-Id': 'director-1' };
  for (const url of [`/fhir/R4/Patient/${p.id}`, '/fhir/R4/DocumentReference', '/api/pharmacy/queue', '/dicom-web/studies', `/api/ins/auth`, `/api/ins/claims`, `/api/ins/coverage/${p.id}`]) assert.equal((await s.call('GET', url, undefined, dir)).status, 403, url);
  assert.equal((await s.call('GET', '/api/ins/payer/queue', undefined, dir)).status, 200);
});
if (errors.length) { console.log(`Console errors:\n${errors.join('\n')}`); await browser.close(); await s.close(); process.exit(1); }
await browser.close(); await s.close();
console.log(`\nAll ${steps.length} steps passed`);
