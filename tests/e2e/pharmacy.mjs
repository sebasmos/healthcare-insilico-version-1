// Browser end-to-end test for the Pharmacy app: a physician
// prescribes STAT over an allergy, the pharmacist opens the queue, the review
// shows the allergy check, a query goes to the physician who answers from the
// EHR Inbox, the order is verified with a change, the prescriber sees the
// notice, the order is dispensed with lot, expiry and a second checker, the
// label preview and ward view show it, and a nurse's emergency override sits
// at the top of the queue. Run it with:
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/pharmacy.mjs
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
    if (/status of (409|422|423)/.test(m.text())) expected4xx.push(m.text()); else errors.push(`${name}: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
};
const shots = process.env.E2E_SHOTS ? tempDir('hd-shots-') : null;
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
const t = (id) => `[data-testid="${id}"]`;
const steps = [];
const step = async (name, fn) => { await fn(); steps.push(name); console.log(`ok - ${name}`); };
const RX = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const doc = { 'X-Role': 'physician', 'X-User-Id': 'dr-ui' };
// Four roles now (2026-11-12): the person doing the pharmacist's work logs in as a nurse, with full access.
const rph = { 'X-Role': 'nurse', 'X-User-Id': 'rph-ui' };

try {
  await s.call('PUT', '/api/friction', { level: 'low' });
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Pharmcase', { name: [{ family: 'Pharmcase', given: ['Test'] }], gender: 'female', birthDate: '1960-01-01' }))).json;
  await s.call('POST', '/fhir/R4/AllergyIntolerance', { resourceType: 'AllergyIntolerance', patient: { reference: `Patient/${p.id}` }, clinicalStatus: { coding: [{ code: 'active' }] }, criticality: 'high', code: { coding: [{ system: RX, code: '7984', display: 'Penicillin V' }] }, reaction: [{ manifestation: [{ coding: [{ system: 'http://snomed.info/sct', code: '39579001', display: 'Anaphylaxis' }] }] }] });
  await s.call('POST', '/fhir/R4/Encounter', { resourceType: 'Encounter', status: 'in-progress', class: { code: 'IMP', display: 'inpatient' }, subject: { reference: `Patient/${p.id}` }, location: [{ location: { display: 'Ward 3B' }, status: 'active' }] });
  const obs = (code, name, value, unit, cat, status) => ({ resourceType: 'Observation', status, category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: cat }] }], code: { coding: [{ system: 'http://loinc.org', code, display: name }] }, subject: { reference: `Patient/${p.id}` }, effectiveDateTime: '2026-05-01T08:00:00Z', valueQuantity: { value, unit } });
  assert.equal((await s.call('POST', '/fhir/R4/Observation', obs('29463-7', 'Body weight', 70, 'kg', 'vital-signs', 'final'))).status, 201);
  assert.equal((await s.call('POST', '/fhir/R4/Observation', obs('2160-0', 'Creatinine', 1.1, 'mg/dL', 'laboratory', 'preliminary'))).status, 201);

  const desktop = await context.newPage(); watch(desktop, 'desktop');
  const ehr = await context.newPage(); watch(ehr, 'ehr');
  const ph = await context.newPage(); watch(ph, 'pharmacy');
  await desktop.goto(`${s.base}/`);
  // The desktop now starts at a lock screen (plan-master task 1): log in as a role, and read the dock instead of tiles.
  const loginAs = async (role, name) => {
    if (await desktop.locator(t('dock')).count() && await desktop.locator(t('dock')).isVisible().catch(() => false)) { await desktop.click(t('system-menu')); await desktop.click(t('menu-logout')); }
    await desktop.waitForSelector(t('lock-screen'));
    await demoLogin(desktop, role, { name });
    await desktop.waitForSelector(t('dock'));
  };
  const dockEnabled = async (app) => (await desktop.locator(t(`dock-${app}`)).getAttribute('aria-disabled')) !== 'true';
  const PEOPLE = { physician: ['physician', 'dr-ui'], pharmacist: ['nurse', 'rph-ui'], nurse: ['nurse', 'rn-ui'], researcher: ['researcher', 'res-ui'] };
  const workAs = async (who) => loginAs(...PEOPLE[who]);
  let orderId;

  await step('physician: a STAT prescription over an allergy override goes straight to "Awaiting pharmacy"; the Pharmacy tile is live on the desktop', async () => {
    await workAs('physician');
    assert.equal(await dockEnabled('pharmacy'), true, 'the physician has every app in the dock, the pharmacy included');
    await ehr.goto(`${s.base}/ehr/#/chart/${p.id}/medications`); await ehr.reload();
    await ehr.waitForSelector(t('prescribe'));
    await ehr.click(t('prescribe'));
    await ehr.fill(t('field-medication'), 'Amoxicillin (RxNorm 723)');
    await ehr.selectOption(t('prescribe-priority'), 'stat');
    await ehr.click(t('prescribe-form-submit'));
    await ehr.waitForSelector(t('allergy-modal'));
    await ehr.fill(t('allergy-reason'), 'tolerated amoxicillin before; allergy entry disputed');
    await ehr.click(t('allergy-override'));
    await ehr.waitForSelector('[data-testid^="verification-"]');
    assert.match(await ehr.textContent(t('medications-current')), /Awaiting pharmacy/);
    assert.match(await ehr.textContent(t('medications-current')), /STAT/);
    assert.equal(await ehr.locator('[data-testid^="sign-"]').count(), 0, 'no Sign button: pharmacy verifies');
    const meds = (await s.call('GET', `/fhir/R4/MedicationRequest?patient=${p.id}`)).json.entry.map((e) => e.resource);
    assert.equal(meds.length, 1);
    orderId = meds[0].id;
    assert.equal(meds[0].priority, 'stat');
    assert.equal(meds[0].extension.find((e) => e.url === 'urn:hospital-desktop:lifecycle').valueCode, 'pending-verification');
    await shot(ehr, '01-awaiting-pharmacy');
  });

  await step('pharmacist: lands on the verification queue; the STAT order is listed with patient, unit, dose, prescriber, age and target; metrics strip', async () => {
    await workAs('pharmacist');
    assert.equal(await dockEnabled('pharmacy'), true);
    await ph.goto(`${s.base}/pharmacy/`); await ph.reload();
    await ph.waitForSelector(t('queue-table'));
    assert.equal(ph.url().split('#')[1], '/queue');
    const row = await ph.textContent(t(`queue-table-row-${orderId}`));
    for (const part of ['STAT', 'Patient N1', 'Ward 3B', 'Amoxicillin', '500 mg · oral · TID', 'dr-ui', '15 min', 'Awaiting verification']) assert.ok(row.includes(part), `${part} in "${row}"`);
    assert.ok(await ph.isVisible(t('metrics')));
    assert.equal(await ph.textContent(t('metric-verified')), '0');
    assert.ok(await ph.isVisible(t('queue-my')));
    assert.ok(await ph.isVisible(t('queue-all')));
    await shot(ph, '02-queue');
  });

  await step('review: the allergy check is a DetectedIssue beside allergies, weight, creatinine with an estimated eGFR and the unverified-tables note; the order is locked to this pharmacist', async () => {
    await ph.click(t(`open-${orderId}`));
    await ph.waitForSelector(t('decision-bar'));
    assert.ok(ph.url().includes(`#/review/${orderId}`));
    await ph.waitForSelector('[data-testid^="issue-allergy"]');
    assert.match(await ph.textContent('[data-testid^="issue-allergy"]'), /Allergy.*high.*same class \(penicillins\)/s);
    assert.match(await ph.textContent(t('review-allergies')), /Penicillin V \(high\) · Anaphylaxis/);
    assert.match(await ph.textContent(t('review-egfr')), /\d+ mL\/min\/1\.73m2 · CKD-EPI 2021 \(estimated, unverified formula\)/);
    assert.match(await ph.textContent(t('tables-note')), /Unverified starter tables/);
    assert.match(await ph.textContent(t('review-allergy-override')), /tolerated amoxicillin before/);
    assert.match(await ph.textContent(t('review-patient')), /Patient N1/);
    const issues = (await s.call('GET', `/fhir/R4/DetectedIssue?patient=${p.id}`)).json;
    assert.equal(issues.total, 1);
    assert.equal(issues.entry[0].resource.status, 'preliminary');
    const q = (await s.call('GET', '/api/pharmacy/queue?queue=all', undefined, rph)).json;
    assert.equal(q.rows[0].lock.by, 'rph-ui');
    await shot(ph, '03-review');
  });

  await step('query: the pharmacist asks the prescriber; the queue shows "Awaiting prescriber"', async () => {
    await ph.click(t('review-query'));
    await ph.waitForSelector(t('query-form'));
    await ph.fill(t('query-message'), 'Documented penicillin anaphylaxis. Is a non-beta-lactam an option?');
    await ph.fill(t('decision-reasoning'), 'high-criticality allergy with an override; confirm with the prescriber before verifying');
    await ph.click(t('query-form-submit'));
    await ph.waitForSelector(t('queue-table'));
    await ph.waitForSelector(t(`state-${orderId}`));
    assert.equal(await ph.textContent(t(`state-${orderId}`)), 'Awaiting prescriber');
    assert.equal((await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.filter((x) => x.did.type === 'pharmacy.query').length, 1);
  });

  await step('physician: answers the question from the Inbox "Pharmacy changes" folder; the chart showed "Queried"', async () => {
    await workAs('physician');
    await ehr.goto(`${s.base}/ehr/#/chart/${p.id}/medications`); await ehr.reload();
    await ehr.waitForSelector(t(`verification-${orderId}`));
    assert.match(await ehr.textContent(t(`verification-${orderId}`)), /^Queried: Documented penicillin anaphylaxis/);
    assert.ok(await ehr.isVisible(t(`answer-${orderId}`)));
    await ehr.goto(`${s.base}/ehr/#/inbox?folder=pharmacy`); await ehr.reload();
    await ehr.waitForSelector(t('inbox-pharmacy-queries'));
    assert.match(await ehr.textContent(t('inbox-pharmacy-queries')), /Amoxicillin.*non-beta-lactam/s);
    await ehr.click(t(`answer-${orderId}`));
    await ehr.waitForSelector(t('answer-form'));
    await ehr.fill(t('answer-message'), 'Yes, please verify amoxicillin: the allergy entry is disputed and she tolerated it in 2024.');
    await ehr.click(t('answer-form-submit'));
    await ehr.waitForSelector(t('inbox-pharmacy-queries-empty'));
    const o = (await s.call('GET', `/fhir/R4/MedicationRequest/${orderId}`)).json;
    assert.ok(!o.extension.some((e) => e.url === 'urn:hospital-desktop:queried'), 'the question is answered');
    await shot(ehr, '04-inbox-answer');
  });

  await step('pharmacist: verifies with a change; the order is active with the new dose; the check is closed with the decision', async () => {
    await workAs('pharmacist');
    await ph.goto(`${s.base}/pharmacy/#/queue`); await ph.reload();
    await ph.waitForSelector(t(`open-${orderId}`));
    await ph.click(t(`open-${orderId}`));
    await ph.waitForSelector(t('decision-bar'));
    assert.match(await ph.textContent(t('thread')), /non-beta-lactam.*tolerated it in 2024/s);
    await ph.click(t('review-verify-change'));
    await ph.waitForSelector(t('change-form'));
    await ph.fill(t('field-dose'), '250');
    await ph.fill(t('decision-reasoning'), 'prescriber confirmed; dose reduced for estimated renal function');
    await ph.click(t('change-form-submit'));
    await ph.waitForSelector(t('queue-table-empty'));
    assert.equal(await ph.textContent(t('metric-verified')), '1');
    assert.equal(await ph.textContent(t('metric-interventions')), '2');
    const o = (await s.call('GET', `/fhir/R4/MedicationRequest/${orderId}`)).json;
    assert.deepEqual([o.status, o.dosageInstruction[0].doseAndRate[0].doseQuantity.value], ['active', 250]);
    assert.match(o.extension.find((e) => e.url === 'urn:hospital-desktop:verified').valueString, /^rph-ui at /);
    assert.equal((await s.call('GET', `/fhir/R4/DetectedIssue?patient=${p.id}`)).json.entry[0].resource.status, 'final');
    await shot(ph, '05-verified');
  });

  await step('physician: the Inbox notice and the chart badge "Verified by rph-ui"', async () => {
    await workAs('physician');
    await ehr.goto(`${s.base}/ehr/#/inbox?folder=pharmacy`); await ehr.reload();
    await ehr.waitForSelector(t('inbox-pharmacy'));
    assert.match(await ehr.textContent(t('inbox-pharmacy')), /Pharmacy verified with a change.*dose 250/s);
    await ehr.locator('[data-testid^="task-completed-"]').first().click();
    await ehr.waitForFunction(() => /completed/.test(document.querySelector('[data-testid="inbox-pharmacy"]')?.textContent || ''));
    await ehr.goto(`${s.base}/ehr/#/chart/${p.id}/medications`); await ehr.reload();
    await ehr.waitForSelector(t(`verification-${orderId}`));
    assert.equal(await ehr.textContent(t(`verification-${orderId}`)), 'Verified by rph-ui');
    await ehr.waitForSelector(`[data-testid="hold-${orderId}"]`);
  });

  let dispenseId;
  await step('dispense: start with quantity and lot, complete with expiry; a controlled order needs the second checker; label preview; ward view by unit', async () => {
    const morphine = (await s.call('POST', '/fhir/R4/MedicationRequest', { resourceType: 'MedicationRequest', status: 'draft', intent: 'order', priority: 'routine', subject: { reference: `Patient/${p.id}` }, requester: { display: 'dr-ui' }, medicationCodeableConcept: { coding: [{ system: RX, code: '7052', display: 'Morphine' }] }, extension: [{ url: 'urn:hospital-desktop:lifecycle', valueCode: 'pending-verification' }], dosageInstruction: [{ text: '2 mg intravenously every 4 hours', timing: { code: { text: 'Q4H' } }, route: { text: 'intravenous' }, doseAndRate: [{ doseQuantity: { value: 2, unit: 'mg' } }] }] }, doc)).json;
    assert.equal((await s.call('POST', `/api/pharmacy/orders/${morphine.id}/decision`, { decision: 'verify', reasoning: 'pain regimen reviewed' }, rph)).status, 200);
    await workAs('pharmacist');
    await ph.goto(`${s.base}/pharmacy/#/dispense`); await ph.reload();
    await ph.waitForSelector(t(`dispense-start-${orderId}`));
    assert.ok(await ph.isVisible(t(`controlled-${morphine.id}`)), 'morphine is marked controlled');
    await ph.click(t(`dispense-start-${orderId}`));
    await ph.waitForSelector(t('dispense-form'));
    await ph.fill(t('field-quantity'), '21');
    await ph.fill(t('field-lot'), 'AMX-2201');
    await ph.click(t('dispense-form-submit'));
    await ph.waitForSelector('[data-testid^="dispense-complete-"]');
    dispenseId = (await ph.getAttribute('[data-testid^="dispense-complete-"]', 'data-testid')).slice('dispense-complete-'.length);
    await ph.click(t(`dispense-complete-${dispenseId}`));
    await ph.waitForSelector(t('complete-form'));
    assert.equal(await ph.inputValue(t('field-lot')), 'AMX-2201');
    await ph.fill(t('field-expiry'), '2027-06');
    await ph.fill(t('field-checkedby'), 'rph-two');
    await ph.click(t('complete-form-submit'));
    await ph.waitForSelector(t(`label-${dispenseId}`));
    assert.match(await ph.textContent(t('recent-table')), /AMX-2201 \/ 2027-06.*rph-ui \/ rph-two/s);
    // The controlled order: the form demands a second checker, the server refuses the same person.
    await ph.click(t(`dispense-start-${morphine.id}`));
    await ph.waitForSelector(t('dispense-form'));
    await ph.fill(t('field-lot'), 'MOR-1');
    await ph.click(t('dispense-form-submit'));
    await ph.waitForSelector(`[data-testid^="dispense-complete-"]`);
    const morphineDispense = (await ph.getAttribute('[data-testid^="dispense-complete-"]', 'data-testid')).slice('dispense-complete-'.length);
    await ph.click(t(`dispense-complete-${morphineDispense}`));
    await ph.waitForSelector(t('complete-form'));
    assert.match(await ph.textContent(t('complete-form')), /Controlled drug: name the second checker/);
    await ph.fill(t('field-expiry'), '2027-01');
    await ph.fill(t('field-checkedby'), 'rph-ui');
    await ph.click(t('complete-form-submit'));
    await ph.waitForFunction(() => /different person/.test(document.querySelector('[data-testid="complete-form-error"]')?.textContent || ''));
    await ph.fill(t('field-checkedby'), 'rph-two');
    await ph.click(t('complete-form-submit'));
    await ph.waitForSelector(t(`label-${morphineDispense}`));
    await shot(ph, '06-dispense');

    await ph.click(t(`label-${dispenseId}`));
    await ph.waitForSelector(t('label-page'));
    const label = await ph.textContent(t('label-page'));
    for (const part of ['Patient N1', 'Amoxicillin', '250 mg by mouth three times daily', 'Lot AMX-2201', 'Expires 2027-06', 'Filled by rph-ui / checked by rph-two', 'Ward 3B']) assert.ok(label.includes(part), `${part} on the label`);
    assert.match(await ph.textContent(t('label-note')), /Nothing is printed/);
    await shot(ph, '07-label');
    await ph.click(t('nav-wards'));
    await ph.waitForSelector(t('ward-ward-3b'));
    const ward = await ph.textContent(t('ward-ward-3b'));
    assert.ok(ward.includes('Amoxicillin') && ward.includes('Morphine') && ward.includes('Not yet given'));
    await shot(ph, '08-wards');
  });

  let statId;
  await step('nurse: records an emergency override on a STAT order from the chart; the pharmacist sees it at the top of the queue; the chart shows the badge', async () => {
    statId = (await s.call('POST', '/fhir/R4/MedicationRequest', { resourceType: 'MedicationRequest', status: 'draft', intent: 'order', priority: 'routine', subject: { reference: `Patient/${p.id}` }, requester: { display: 'dr-ui' }, medicationCodeableConcept: { coding: [{ system: RX, code: '26225', display: 'Ondansetron' }] }, extension: [{ url: 'urn:hospital-desktop:lifecycle', valueCode: 'pending-verification' }], dosageInstruction: [{ text: '4 mg by mouth every 8 hours', timing: { code: { text: 'Q8H' } }, route: { text: 'oral' }, doseAndRate: [{ doseQuantity: { value: 4, unit: 'mg' } }] }] }, doc)).json.id;
    const stat = (await s.call('POST', '/fhir/R4/MedicationRequest', { resourceType: 'MedicationRequest', status: 'draft', intent: 'order', priority: 'stat', subject: { reference: `Patient/${p.id}` }, requester: { display: 'dr-ui' }, medicationCodeableConcept: { coding: [{ system: RX, code: '161', display: 'Acetaminophen' }] }, extension: [{ url: 'urn:hospital-desktop:lifecycle', valueCode: 'pending-verification' }], dosageInstruction: [{ text: '650 mg by mouth every 6 hours', timing: { code: { text: 'Q6H' } }, route: { text: 'oral' }, doseAndRate: [{ doseQuantity: { value: 650, unit: 'mg' } }] }] }, doc)).json;
    await workAs('nurse');
    await ehr.goto(`${s.base}/ehr/#/chart/${p.id}/orders`); await ehr.reload();
    await ehr.waitForSelector(t('orders-medications'));
    assert.equal(await ehr.locator(t(`override-${statId}`)).count(), 0, 'no override button on a routine order');
    await ehr.click(t(`override-${stat.id}`));
    await ehr.waitForSelector(t('override-reason'));
    await ehr.fill(t('field-reason'), 'fever 39.5, physician at bedside asked for it now');
    await ehr.click(t('override-reason-submit'));
    await ehr.waitForFunction((id) => /Emergency override/.test(document.querySelector(`[data-testid="verification-${id}"]`)?.textContent || ''), stat.id);
    const log = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.find((x) => x.did.type === 'safety.override' && x.did.args.alert === 'unverified-stat');
    assert.deepEqual([log.who.role, log.why], ['nurse', 'fever 39.5, physician at bedside asked for it now']);
    await shot(ehr, '09-override');
    await workAs('pharmacist');
    await ph.goto(`${s.base}/pharmacy/#/queue`); await ph.reload();
    await ph.waitForSelector(t(`override-${stat.id}`));
    const first = await ph.getAttribute(`${t('queue-table')} tbody tr`, 'data-testid');
    assert.equal(first, `queue-table-row-${stat.id}`, 'the overridden order is first');
    assert.equal(await ph.textContent(t(`override-${stat.id}`)), 'Given before verification: retrospective review');
    await ph.click(t(`open-${stat.id}`));
    await ph.waitForSelector(t('review-override'));
    assert.match(await ph.textContent(t('review-override')), /physician at bedside/);
    await ph.click(t('review-verify'));
    await ph.waitForSelector(t('verify-form'));
    await ph.fill(t('decision-reasoning'), 'retrospective review: appropriate dose');
    await ph.click(t('verify-form-submit'));
    await ph.waitForSelector(t(`open-${statId}`));
    await shot(ph, '10-queue-after');
  });

  await step('full access: the researcher sees the queue with Open and the decision controls enabled', async () => {
    await workAs('researcher');
    await ph.goto(`${s.base}/pharmacy/#/queue`); await ph.reload();
    await ph.waitForSelector(t(`open-${statId}`));
    await ph.click(t(`open-${statId}`));
    await ph.waitForSelector(t('decision-bar'));
    assert.ok(await ph.isEnabled(t('review-verify')), 'the researcher may verify');
    assert.notEqual(await ph.getAttribute(t('review-verify'), 'title'), 'Researcher is read-only outside Agent Dashboard');
    const q = (await s.call('GET', '/api/pharmacy/queue?queue=all', undefined, rph)).json;
    assert.equal(q.rows.find((r) => r.id === statId).lock?.by, 'res-ui', 'opening takes the lock, as for any role that may decide');
    await workAs('pharmacist');
  });

  await step('accessibility hooks: every button, input, select and link in the pharmacy app has a data-testid or an aria-label', async () => {
    for (const hash of ['#/queue', `#/review/${statId}`, '#/dispense', `#/label/${dispenseId}`, '#/wards']) {
      await ph.goto(`${s.base}/pharmacy/${hash}`); await ph.reload();
      await ph.waitForSelector('main.content');
      const missing = await ph.$$eval('button, input, select, a', (els) => els.filter((e) => !e.dataset.testid && !e.getAttribute('aria-label')).map((e) => e.outerHTML.slice(0, 80)));
      assert.deepEqual(missing, [], `${hash}: controls without testid or aria-label`);
    }
  });

  assert.deepEqual(errors, [], 'browser console errors');
  console.log(`\n${steps.length} browser steps passed. Console errors: 0. Expected 409/422/423 responses logged by the browser: ${expected4xx.length}.`);
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
