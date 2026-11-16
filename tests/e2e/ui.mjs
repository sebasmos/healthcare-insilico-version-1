// Browser end-to-end test for the desktop, EHR and portal.
// Needs Playwright and a Chromium-family browser, which are not project
// dependencies. Run it with:
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/ui.mjs
// It starts its own server on a temporary database and exits non-zero on failure.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTestServer, tempDir } from '../support/helpers.mjs';
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
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const local = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

try {
  await s.call('PUT', '/api/friction', { level: 'low' });
  const ehr = await context.newPage(); watch(ehr, 'ehr');
  const desktop = await context.newPage(); watch(desktop, 'desktop');

  await step('desktop: greeting, role dropdown, four tiles, role fades tiles, patient role lists patients', async () => {
    await desktop.goto(`${s.base}/`);
  // The desktop now starts at a lock screen (plan-master task 1): log in as a role, and read the dock instead of tiles.
  const loginAs = async (role, name) => {
    if (await desktop.locator(t('dock')).count() && await desktop.locator(t('dock')).isVisible().catch(() => false)) { await desktop.click(t('system-menu')); await desktop.click(t('menu-logout')); }
    await desktop.waitForSelector(t('lock-screen'));
    await demoLogin(desktop, role, { name });
    await desktop.waitForSelector(t('dock'));
  };
  const dockEnabled = async (app) => (await desktop.locator(t(`dock-${app}`)).getAttribute('aria-disabled')) !== 'true';
    await desktop.waitForSelector(t('lock-screen'));
    await loginAs('physician', 'Dr Reader');
    for (const app of ['ehr', 'pacs', 'agent-ops']) assert.ok(await desktop.locator(t(`dock-${app}`)).count(), `${app} is in the dock`);
    for (const app of ['ehr', 'pacs', 'pathology', 'lab', 'pharmacy', 'beds', 'monitoring', 'portal', 'agent-ops']) assert.equal(await dockEnabled(app), true, `a physician has ${app} in the dock, not greyed out`);
    assert.equal(await dockEnabled('pacs'), true);
    await desktop.click(t('system-menu')); await desktop.click(t('menu-logout')); await desktop.waitForSelector(t('lock-screen'));
    for (const r of ['researcher', 'physician', 'nurse', 'coder', 'patient', 'payer-medical-director']) assert.ok(await desktop.isVisible(t(`try-as-${r}`)), `Try as ${r} is offered`);
    assert.equal(await desktop.locator(`${t('demo-form')} button`).count(), 6, 'six buttons: five roles and one Payer button');
    await loginAs('physician', 'Dr Chart');
    await shot(desktop, '01-desktop');
  });

  await step('ehr: loads, register a patient, MRN generated, chart opens with sidebar', async () => {
    await ehr.goto(`${s.base}/ehr/`);
    await ehr.waitForSelector(t('stat-patients'));
    await ehr.click(t('nav-patients'));
    await ehr.click(t('register-patient'));
    assert.equal(await ehr.locator(t('field-family')).count() + await ehr.locator(t('field-given')).count(), 0, 'no name is asked for');
    await ehr.fill(t('field-birthdate'), '1961-04-12');
    await ehr.click(t('register-form-submit'));
    await ehr.waitForSelector(t('patient-sidebar'));
    assert.match(await ehr.textContent(t('patient-name')), /^Patient N\d{6}$/, 'known by number');
    assert.match(await ehr.textContent(t('patient-mrn')), /^N\d{6}$/);
    assert.ok(await ehr.isVisible(t('badge-allergies-unknown')));
  });
  const patientId = ehr.url().match(/chart\/([^/]+)/)[1];

  await step('vitals: one dialog, auto-BMI, range flag, flowsheet, explicit release', async () => {
    await ehr.click(t('chart-tab-vitals'));
    await ehr.click(t('vitals-record'));
    await ehr.fill(t('field-hr'), '118');
    await ehr.fill(t('field-weight'), '80');
    await ehr.fill(t('field-height'), '180');
    assert.equal(await ehr.inputValue(t('field-bmi')), '24.7');
    assert.match(await ehr.textContent(t('vitals-flags')), /Heart rate/);
    await ehr.click(t('vitals-form-submit'));
    await ehr.waitForSelector(t('vitals-flowsheet'));
    assert.match(await ehr.textContent(t('flow-bmi')), /24\.7/);
    assert.match(await ehr.textContent(t('flow-hr')), /118/);
    assert.equal((await s.call('GET', `/fhir/R4/Observation?patient=${patientId}&_released=true`)).json.total, 0, 'vitals are not released automatically');
    await ehr.click(t('vitals-release-0'));
    await ehr.waitForSelector(t('vitals-hide-0'));
    await shot(ehr, '02-vitals');
  });

  await step('notes: draft shows unsigned badge, sign locks it, release to portal', async () => {
    await ehr.click(t('chart-tab-notes'));
    await ehr.click(t('note-new'));
    await ehr.fill(t('field-text'), 'Subjective: cough for three days.\nAssessment: viral URI.\nPlan: fluids, rest.');
    await ehr.click(t('note-form-submit'));
    await ehr.waitForSelector(t('badge-unsigned'));
    await ehr.locator('[data-testid^="notes-table-row-"]').first().click();
    await ehr.waitForSelector(t('note-reader'));
    await ehr.locator('[data-testid^="note-sign-"]').first().click();
    await ehr.click(t('sign-note-ok'));
    await ehr.waitForSelector('[data-testid^="note-addendum-"]');
    assert.equal(await ehr.locator('[data-testid^="note-edit-"]').count(), 0, 'signed notes have no Edit');
    assert.equal(await ehr.locator(t('badge-unsigned')).count(), 0);
    await ehr.locator('[data-testid^="release-"]').first().click();
    await ehr.waitForSelector('[data-testid^="hide-"]');
  });

  await step('allergy conflict: red blocking modal, cancel writes nothing, override needs a reason', async () => {
    await ehr.click(t('chart-tab-allergies'));
    await ehr.click(t('allergy-add'));
    await ehr.fill(t('field-allergen'), 'Penicillin V (medication)');
    await ehr.click(t('allergy-form-submit'));
    await ehr.waitForSelector(t('badge-allergies'));
    await ehr.click(t('chart-tab-medications'));
    await ehr.click(t('prescribe'));
    await ehr.fill(t('field-medication'), 'Amoxicillin (RxNorm 723)');
    assert.equal(await ehr.inputValue(t('field-sig')), '500 mg by mouth three times daily');
    await ehr.click(t('prescribe-form-submit'));
    await ehr.waitForSelector(t('allergy-modal'));
    assert.match(await ehr.textContent(t('allergy-message')), /Penicillin V.*same class/);
    await shot(ehr, '03-allergy-modal');
    await ehr.keyboard.press('Escape');
    assert.ok(await ehr.isVisible(t('allergy-modal')), 'Escape does not dismiss the blocking modal');
    await ehr.click(t('allergy-override'));
    assert.ok(await ehr.isVisible(t('allergy-modal')), 'no override without a reason');
    await ehr.click(t('allergy-cancel'));
    await ehr.waitForFunction(() => !document.querySelector('dialog[open]'));
    assert.equal((await s.call('GET', `/fhir/R4/MedicationRequest?patient=${patientId}`)).json.total, 0);

    await ehr.click(t('prescribe'));
    await ehr.fill(t('field-medication'), 'Amoxicillin (RxNorm 723)');
    await ehr.click(t('prescribe-form-submit'));
    await ehr.fill(t('allergy-reason'), 'tolerated previously, allergy entry disputed');
    await ehr.click(t('allergy-override'));
    // Part A.3: the order is created in pending-verification and waits for pharmacy; there is no "Sign" on the chart any more.
    await ehr.waitForSelector('[data-testid^="verification-"]');
    assert.match(await ehr.textContent(t('medications-current')), /Awaiting pharmacy/);
    const pending = (await s.call('GET', `/fhir/R4/MedicationRequest?patient=${patientId}`)).json.entry[0].resource;
    assert.equal(pending.extension.find((e) => e.url === 'urn:hospital-desktop:lifecycle').valueCode, 'pending-verification');
    const verified = await s.call('POST', `/api/pharmacy/orders/${pending.id}/decision`, { decision: 'verify', reasoning: 'allergy override reviewed with the prescriber' }, { 'X-Role': 'nurse', 'X-User-Id': 'rph-ui' });
    assert.equal(verified.status, 200, verified.text);
    await ehr.reload();
    await ehr.waitForSelector('[data-testid^="hold-"]');
    assert.match(await ehr.textContent(t('medications-current')), /active/);
    assert.match(await ehr.textContent(t('medications-current')), /Verified by rph-ui/);
  });

  let beforeCorrection;
  await step('orders: panel, duplicate banner, prelim results, sign final, critical acknowledgment', async () => {
    await ehr.click(t('chart-tab-orders'));
    await ehr.click(t('order-panel-cmp'));
    await ehr.waitForSelector('[data-testid^="order-enter-"]');
    await ehr.click(t('order-panel-cmp'));
    await ehr.waitForSelector(t('duplicate-banner'));
    assert.match(await ehr.textContent(t('duplicate-banner')), /already active.*Existing order date/s);
    await ehr.click(t('duplicate-order-anyway'));
    assert.ok(await ehr.isVisible(t('duplicate-dialog')), 'a typed reason is required');
    await ehr.click(t('duplicate-cancel'));
    assert.equal((await s.call('GET', `/fhir/R4/ServiceRequest?patient=${patientId}`)).json.total, 1);

    await ehr.locator('[data-testid^="order-enter-"]').first().click();
    await ehr.fill(t('field-2160-0'), '1.0');
    await ehr.fill(t('field-2823-3'), '6.9');
    await ehr.click(t('results-form-submit'));
    await ehr.waitForSelector('[data-testid^="order-signresults-"]');
    await ehr.locator('[data-testid^="order-signresults-"]').first().click();
    await ehr.click(t('sign-results-ok'));
    await ehr.waitForSelector(t('critical-ack'));
    assert.match(await ehr.textContent(t('critical-ack')), /Potassium.*6\.9.*HH/s);
    await ehr.click(t('critical-ack-ok'));
    // The lab order is complete. The Orders tab also lists medication orders, so the tab is not empty: the verified amoxicillin stays.
    await ehr.waitForFunction(() => !document.querySelector('[data-testid^="order-details-"]'));
    assert.match(await ehr.textContent(t('orders-medications')), /Amoxicillin.*Verified by rph-ui/s);
    assert.equal((await s.call('GET', '/api/badges')).json.criticalUnacknowledged.length, 0);
  });

  await step('labs grid, correction keeps history, time travel shows the original with no Corrected badge', async () => {
    await ehr.goto(`${s.base}/ehr/#/chart/${patientId}/review/labs`);
    await ehr.waitForSelector(t('labs-grid'));
    assert.match(await ehr.textContent(t('lab-row-2823-3')), /6\.9 ▲!/);
    await sleep(1200);
    beforeCorrection = new Date();
    await sleep(1200);
    await ehr.locator(`${t('lab-row-2160-0')} td.cell`).click();
    await ehr.waitForSelector(t('lab-dialog'));
    await ehr.click(t('lab-correct'));
    await ehr.fill(t('field-value'), '1.2');
    await ehr.click(t('correct-form-submit'));
    await ehr.waitForSelector('[data-testid^="corrected-"]');
    assert.match(await ehr.textContent(t('lab-row-2160-0')), /1\.2/);
    await shot(ehr, '04-labs-corrected');

    await ehr.fill(t('time-travel-input'), local(beforeCorrection));
    await ehr.locator(t('time-travel-input')).dispatchEvent('change');
    await ehr.waitForSelector(t('time-strip'));
    await ehr.waitForFunction(() => !document.querySelector('[data-testid^="corrected-"]'));
    const row = await ehr.textContent(t('lab-row-2160-0'));
    assert.match(row, /(^|[^.\d])1($|[^.\d])/, `original value shown, got: ${row}`);
    assert.ok(!/1\.2/.test(row));
    await ehr.click(t('chart-tab-medications'));
    await ehr.waitForSelector(t('prescribe'));
    assert.ok(await ehr.isDisabled(t('prescribe')), 'writes are disabled in the past view');
    await shot(ehr, '05-time-travel');
    await ehr.click(t('time-travel-live'));
    await ehr.waitForFunction(() => !document.querySelector('[data-testid="time-strip"]'));
    assert.ok(await ehr.isEnabled(t('prescribe')));

    await ehr.goto(`${s.base}/ehr/#/chart/${patientId}/review/labs`);
    await ehr.locator(`${t('lab-row-2160-0')} td.cell`).click();
    await ehr.click(t('lab-release'));
    await ehr.waitForFunction(() => !document.querySelector('dialog[open]'));
  });

  const portal = await context.newPage(); watch(portal, 'portal');
  await step('portal: released vitals, released result and released note are visible; unreleased result is not', async () => {
    await portal.goto(`${s.base}/portal/`);
    await portal.waitForSelector(t('portal-welcome'));
    assert.match(await portal.textContent(t('portal-welcome')), /Welcome, Patient N\d{6}/);
    assert.match(await portal.textContent(t('home-result')), /Creatinine: 1\.2/);
    await portal.click(t('portal-nav-results'));
    await portal.waitForSelector(t('results-caveat'));
    const body = await portal.textContent('main');
    assert.match(body, /Creatinine/);
    assert.ok(!/Potassium/.test(body), 'the unreleased critical result is not shown');
    assert.match(await portal.textContent(t('portal-vitals')), /Heart rate.*118/s);
    assert.match(await portal.textContent(t('portal-vitals')), /Body mass index.*24\.7/s);
    await portal.selectOption(t('portal-menu'), 'notes');
    await portal.waitForSelector(t('portal-note-text'));
    assert.match(await portal.textContent(t('portal-note-text')), /viral URI/);
    await shot(portal, '06-portal-results');
  });

  await step('portal to EHR: message and refill request reach the Inbox; approve the refill', async () => {
    await portal.click(t('portal-nav-messages'));
    await portal.waitForSelector(t('emergency-banner'));
    await portal.click(t('portal-message-new'));
    await portal.fill(t('field-topic'), 'Question about my cough');
    await portal.fill(t('field-text'), 'Is it normal after one week?');
    await portal.click(t('portal-message-form-submit'));
    await portal.waitForSelector(t('portal-thread'));
    await portal.click(t('portal-nav-medications'));
    await portal.locator('[data-testid^="refill-"]').first().click();
    await portal.waitForSelector('[data-testid^="refill-pending-"]');

    await ehr.goto(`${s.base}/ehr/#/inbox`);
    await ehr.waitForSelector(t('inbox-messages'));
    assert.match(await ehr.textContent(t('inbox-messages')), /Question about my cough/);
    await ehr.click(t('inbox-folder-refills'));
    await ehr.waitForSelector(t('inbox-refills'));
    assert.match(await ehr.textContent(t('inbox-refills')), /Amoxicillin/);
    await ehr.locator('[data-testid^="task-completed-"]').first().click();
    await ehr.waitForFunction(() => /completed/.test(document.querySelector('[data-testid="inbox-refills"]')?.textContent || ''));

    await ehr.goto(`${s.base}/ehr/#/chart/${patientId}/messages`);
    await ehr.waitForSelector(t('thread'));
    await ehr.fill(t('message-reply'), 'Yes, that can be normal. Message again if it worsens.');
    await ehr.click(t('message-send'));
    await ehr.waitForFunction(() => /can be normal/.test(document.querySelector('[data-testid="thread"]')?.textContent || ''));
    await portal.goto(`${s.base}/portal/#/home`);
    await portal.waitForSelector(t('home-unread'));
  });

  await step('shared patient context: opening another chart in the EHR switches the portal', async () => {
    const second = (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', name: [{ family: 'Zzother', given: ['Test'] }], birthDate: '1990-01-01', gender: 'male' })).json;
    await ehr.goto(`${s.base}/ehr/#/patients`);
    await ehr.click(t(`patient-open-${second.id}`));
    await ehr.waitForFunction(() => document.querySelector('[data-testid="patient-name"]')?.textContent === 'Patient N100002');
    await portal.waitForFunction(() => /Welcome, Patient N100002/.test(document.querySelector('[data-testid="portal-welcome"]')?.textContent || ''));
    await sleep(2600);
    const contextSteps = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.filter((x) => x.did.type === 'ui.context');
    assert.ok(contextSteps.some((x) => x.did.args.patient === `Patient/${second.id}`), 'the context change is a TraceStep');
  });

  await step('schedule: book an appointment, check in from the week grid', async () => {
    await ehr.click(t('nav-schedule'));
    await ehr.click(t('book-appointment'));
    const noon = new Date(); noon.setHours(12, 0, 0, 0);
    await ehr.fill(t('field-start'), local(noon).slice(0, 16));
    await ehr.click(t('booking-form-submit'));
    await ehr.waitForSelector('button.appt');
    await ehr.locator('button.appt').first().click();
    await ehr.click(t('appt-arrived'));
    await ehr.waitForSelector('button.appt.arrived');
    await ehr.click(t('schedule-view-day'));
    await ehr.waitForSelector(t('day-list'));
    assert.match(await ehr.textContent(t('day-list')), /arrived/);
    await shot(ehr, '07-schedule');
  });

  await step('friction: high shows advisory cards on chart open; the response is logged', async () => {
    await s.call('PUT', '/api/friction', { level: 'high' });
    await ehr.goto(`${s.base}/ehr/#/chart/${patientId}/summary`);
    await ehr.waitForSelector(t('advisories'));
    await shot(ehr, '08-advisories');
    await ehr.locator('[data-testid$="-ignore"]').first().click();
    await ehr.click(t('advisories-accept'));
    await ehr.waitForFunction(() => !document.querySelector('dialog[open]'));
    const responses = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.filter((x) => x.did.type === 'advisory.respond');
    assert.ok(responses.length >= 1);
    await s.call('PUT', '/api/friction', { level: 'low' });
    await shot(ehr, '09-summary');
  });

  await step('worklist, audit log, placeholders and theme toggle', async () => {
    await ehr.click(t('nav-orders'));
    await ehr.selectOption(t('orders-filter-status'), 'all');
    await ehr.waitForFunction(() => /Comprehensive metabolic panel/.test(document.querySelector('[data-testid="orders-table"]')?.textContent || ''));
    await ehr.click(t('nav-admin'));
    await ehr.waitForSelector(t('audit-table'));
    assert.ok((await ehr.locator(`${t('audit-table')} tbody tr`).count()) > 20);
    // A physician has full access: Billing and Front desk are in the navigation too.
    await ehr.waitForSelector(t('nav-billing'));
    await ehr.click(t('nav-billing'));
    await ehr.waitForSelector(t('ins-tabs')); assert.match(await ehr.textContent(t('ins-note')), /Only the insurer approves or denies/);
    await ehr.click(t('nav-frontdesk'));
    assert.match(await ehr.textContent(t('frontdesk-notice')), /Layout only/);
    // Every staff role has every screen, so switching between them stays on the screen.
    await ehr.selectOption(t('role-select'), 'nurse');
    await ehr.waitForSelector(t('frontdesk-notice'));
    assert.equal(ehr.url().split('#')[1], '/frontdesk', 'a nurse stays on Front desk');
    await ehr.selectOption(t('role-select'), 'physician');
    await ehr.waitForSelector(t('frontdesk-notice'));
    await ehr.click(t('theme-toggle'));
    assert.equal(await ehr.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await shot(ehr, '10-frontdesk-dark');
    await ehr.click(t('theme-toggle'));
  });

  await step('telemetry: UI events were recorded with identifiers only', async () => {
    await ehr.evaluate(() => new Promise((r) => setTimeout(r, 2500)));
    const trace = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps;
    const ui = trace.filter((x) => x.source === 'ui');
    assert.ok(ui.some((x) => x.did.type === 'ui.click' && x.did.args.target === 'register-form-submit'));
    assert.ok(ui.some((x) => x.did.type === 'ui.change' && x.did.args.field === 'field-birthdate'));
    const wire = JSON.stringify(ui);
    for (const secret of ['Zztest', 'viral URI', 'tolerated previously', 'Is it normal']) assert.ok(!wire.includes(secret), `telemetry must not contain "${secret}"`);
  });

  await step('accessibility hooks: every button, input, select and link has a data-testid or an aria-label', async () => {
    for (const hash of ['#/dashboard', `#/chart/${patientId}/summary`, `#/chart/${patientId}/orders`, '#/schedule']) {
      await ehr.goto(`${s.base}/ehr/${hash}`);
      await ehr.waitForSelector('.topbar');
      await sleep(300);
      const missing = await ehr.evaluate(() => [...document.querySelectorAll('button, input, select, textarea')].filter((el) => !el.dataset.testid || !el.getAttribute('aria-label')).map((el) => el.outerHTML.slice(0, 120)));
      assert.deepEqual(missing, [], `controls without testid and aria-label on ${hash}`);
    }
  });

  assert.deepEqual(errors, [], 'browser console errors');
  console.log(`\n${steps.length} browser steps passed. Console errors: 0. Expected 409/422 responses logged by the browser: ${expected4xx.length}.`);
  if (shots) console.log(`Screenshots: ${shots}`);
} catch (err) {
  console.error(`\nFAILED after ${steps.length} steps: ${err.stack || err.message}`);
  if (errors.length) console.error('Console errors:\n' + errors.join('\n'));
  if (shots) { for (const [i, p] of context.pages().entries()) await p.screenshot({ path: path.join(shots, `fail-${i}.png`) }).catch(() => {}); console.error(`Screenshots: ${shots}`); }
  process.exitCode = 1;
} finally {
  await browser.close();
  await s.close();
  if (!shots) fs.rmSync(path.dirname(s.file), { recursive: true, force: true });
}
