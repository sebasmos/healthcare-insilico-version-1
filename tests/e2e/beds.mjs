// Browser end-to-end test for bed management: seed the
// hospital, admit two patients, request a bed from the EHR, assign from the
// waiting list in the Beds app, see the bed in the EHR banner and the By-unit
// patient list, transfer, discharge, clean, block with a reason, reserve,
// expected discharges, the movement record, and the as-of (read-only) view.
// Run it with:
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/beds.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTestServer, tempDir, patient } from '../support/helpers.mjs';
import { demoLogin } from '../support/demo-login.mjs';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';
// A layout for this test only: no layout ships with the release.
const DEFAULT_LAYOUT = { site: { id: 'site-main', name: 'Main' }, units: [{ id: 'ed', name: 'Emergency department', alias: 'ED', rooms: 12, bedsPerRoom: 1, roomLabel: 'Bay' }, { id: 'med', name: 'Medical ward', alias: 'MED', rooms: 6, bedsPerRoom: 4, sexOfBay: true }, { id: 'surg', name: 'Surgical ward', alias: 'SURG', rooms: 5, bedsPerRoom: 4 }, { id: 'icu', name: 'Intensive care unit', alias: 'ICU', rooms: 8, bedsPerRoom: 1, isolation: true, isolationRooms: [7, 8] }] };

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const local = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
// Four roles now (2026-11-12): seeding runs as a physician; the bed manager's work is done by a nurse with full access.
const admin = { 'X-Role': 'physician' };

try {
  await s.call('PUT', '/api/friction', { level: 'low' });
  const seed = await s.call('POST', '/api/beds/seed', { layout: DEFAULT_LAYOUT }, admin);
  assert.equal(seed.status, 200, seed.text);
  const admit = async (family, given, gender, status) => {
    const p = (await s.call('POST', '/fhir/R4/Patient', patient(family, { name: [{ family, given: [given] }], gender }))).json;
    const e = (await s.call('POST', '/fhir/R4/Encounter', { resourceType: 'Encounter', status, subject: { reference: `Patient/${p.id}` }, period: { start: new Date().toISOString() }, class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'IMP', display: 'inpatient' }, type: [{ text: 'Admission' }] })).json;
    return { p, e };
  };
  const ava = await admit('Bedtest', 'First', 'female', 'arrived');
  const ben = await admit('Bedtest', 'Second', 'male', 'in-progress');
  await sleep(1100);
  const beforeAssign = new Date();
  await sleep(1100);

  const desktop = await context.newPage(); watch(desktop, 'desktop');
  const ehr = await context.newPage(); watch(ehr, 'ehr');
  const beds = await context.newPage(); watch(beds, 'beds');

  // The desktop now starts at a lock screen (plan-master task 1): log in as a role, and read the dock instead of tiles.
  const loginAs = async (role, name) => {
    if (await desktop.locator(t('dock')).count() && await desktop.locator(t('dock')).isVisible().catch(() => false)) { await desktop.click(t('system-menu')); await desktop.click(t('menu-logout')); }
    await desktop.waitForSelector(t('lock-screen'));
    await demoLogin(desktop, role, { name });
    await desktop.waitForSelector(t('dock'));
  };
  const dockEnabled = async (app) => (await desktop.locator(t(`dock-${app}`)).getAttribute('aria-disabled')) !== 'true';

  await step('desktop: the Beds app is live in the dock for the nurse doing bed management', async () => {
    await desktop.goto(`${s.base}/`);
    await loginAs('nurse', 'Bed Manager');
    assert.equal(await dockEnabled('beds'), true, 'the Beds app is live in the dock');
    await shot(desktop, '01-desktop');
  });

  await step('beds: the board shows four units, 64 beds, occupancy per unit, the legend and the turnaround strip', async () => {
    await beds.goto(`${s.base}/beds/#/dashboard`);
    await beds.waitForSelector(t('units'));
    assert.equal(await beds.locator('[data-testid^="bed-state-"]').count(), 64);
    for (const [unit, text] of [['unit-ed', '0 of 12'], ['unit-med', '0 of 24'], ['unit-surg', '0 of 20'], ['unit-icu', '0 of 8']]) assert.equal(await beds.textContent(t(`unit-occupancy-${unit}`)), text);
    assert.equal(await beds.textContent(t('hospital-occupancy')), '0 of 64');
    assert.equal(await beds.textContent(t('bed-state-bed-med-1a')), 'Available');
    assert.match(await beds.getAttribute(t('bed-bed-med-1a'), 'aria-label'), /Medical ward \/ Room 1 \/ Bed 1A: Available/);
    assert.equal(await beds.textContent(t('turn-clean-today')), 'none yet');
    assert.equal(await beds.textContent(t('waiting-count')), '2', 'two admitted patients with no bed');
    assert.ok(await beds.isVisible(t(`waiting-assign-${ava.e.id}`)));
    await shot(beds, '02-board');
  });

  await step('ehr: the banner says "No bed"; a physician requests a bed with isolation from the Encounters tab', async () => {
    await ehr.goto(`${s.base}/ehr/#/chart/${ava.p.id}/summary`);
    await ehr.waitForSelector(t('patient-sidebar'));
    await ehr.selectOption(t('role-select'), 'physician');
    await ehr.waitForSelector(t('chart-tab-encounters'));
    assert.equal(await ehr.textContent(t('patient-bed')), 'No bed');
    await ehr.click(t('chart-tab-encounters'));
    await ehr.waitForSelector(t(`encounter-request-bed-${ava.e.id}`));
    await ehr.click(t(`encounter-request-bed-${ava.e.id}`));
    await ehr.waitForSelector(t('bed-request-form'));
    await ehr.selectOption(t('field-unit'), 'unit-med');
    await ehr.fill(t('field-isolation'), 'Contact precautions');
    await ehr.click(t('bed-request-form-submit'));
    await ehr.waitForSelector(t(`encounter-bed-requested-${ava.e.id}`));
    assert.equal(await ehr.textContent(t('badge-isolation')), 'Isolation: Contact precautions');
    await shot(ehr, '03-request');
  });

  await step('beds: the waiting list shows the request; assign from it picks a bed in the requested unit; the tile and occupancy update', async () => {
    await beds.selectOption(t('role-select'), 'nurse');
    await beds.waitForSelector(t('units'));
    const row = beds.locator(t(`waiting-table-row-${ava.e.id}`));
    await beds.waitForFunction((id) => /Medical ward/.test(document.querySelector(`[data-testid="waiting-table-row-${id}"]`)?.textContent || ''), ava.e.id); // the board redraws after the role changes
    assert.match(await row.textContent(), /Patient N100001/);
    assert.match(await row.textContent(), /Medical ward/);
    assert.match(await row.textContent(), /Isolation/);
    await beds.click(t(`waiting-assign-${ava.e.id}`));
    await beds.waitForSelector(t('assign-dialog'));
    assert.equal(await beds.inputValue(t('field-unit')), 'unit-med', 'the requested unit is preselected');
    assert.equal(await beds.inputValue(t('field-bed')), 'bed-med-1a');
    await beds.click(t('assign-dialog-submit'));
    await beds.waitForSelector(t('toast'));
    await beds.waitForFunction(() => document.querySelector('[data-testid="bed-state-bed-med-1a"]')?.textContent === 'Occupied');
    assert.match(await beds.textContent(t('bed-patient-bed-med-1a')), /Patient N100001 · N\d{6}/);
    assert.equal(await beds.textContent(t('unit-occupancy-unit-med')), '1 of 24');
    assert.equal(await beds.textContent(t('hospital-occupancy')), '1 of 64');
    assert.equal(await beds.textContent(t('waiting-count')), '1');
    assert.match(await beds.textContent(t('turn-assign-today')), /median \d+ min, mean \d+ min \(1\)/);
    await shot(beds, '04-assigned');
  });

  await step('ehr: the banner shows unit, room and bed; the Encounters tab lists the movement; Patients "By unit" lists the inpatient with the bed', async () => {
    await ehr.goto(`${s.base}/ehr/#/chart/${ava.p.id}/summary`);
    await ehr.waitForSelector(t('patient-sidebar'));
    await ehr.waitForFunction(() => document.querySelector('[data-testid="patient-bed"]')?.textContent === 'Medical ward / Room 1 / Bed 1A');
    await ehr.click(t('chart-tab-encounters'));
    await ehr.waitForSelector(t(`encounter-bed-${ava.e.id}`));
    assert.equal(await ehr.textContent(t(`encounter-bed-${ava.e.id}`)), 'Medical ward / Room 1 / Bed 1A');
    await ehr.click(t(`encounter-movements-${ava.e.id}`));
    await ehr.waitForSelector(t('movements-dialog'));
    assert.equal(await ehr.locator(`${t('movements-table')} tbody tr`).count(), 1);
    await ehr.click(t('movements-dialog-close'));
    await ehr.click(t('nav-patients'));
    await ehr.waitForSelector(t('patients-unit-filter'));
    await ehr.selectOption(t('patients-unit-filter'), 'unit-med');
    await ehr.waitForSelector(t(`patient-bed-${ava.p.id}`));
    assert.equal(await ehr.textContent(t(`patient-bed-${ava.p.id}`)), 'Medical ward / Room 1 / Bed 1A');
    assert.equal(await ehr.locator(`${t('patients-table')} tbody tr`).count(), 1, 'only the inpatient in that unit');
    await ehr.selectOption(t('patients-unit-filter'), 'unit-surg');
    await ehr.waitForSelector(t('patients-table-empty'));
    await shot(ehr, '05-by-unit');
  });

  await step('beds: transfer from the tile dialog sends the old bed to cleaning; the movement history page lists both beds', async () => {
    await beds.click(t('bed-bed-med-1a'));
    await beds.waitForSelector(t('bed-dialog'));
    assert.equal(await beds.textContent(t('bed-dialog-state')), 'Occupied');
    assert.match(await beds.textContent(t('bed-dialog-patient')), /Patient N100001/);
    await beds.click(t('bed-transfer'));
    await beds.waitForSelector(t('transfer-dialog'));
    await beds.selectOption(t('field-unit'), 'unit-surg');
    await beds.waitForFunction(() => document.querySelector('[data-testid="field-bed"]')?.value === 'bed-surg-1a');
    await beds.fill(t('field-reason'), 'Post-operative care');
    await beds.click(t('transfer-dialog-submit'));
    await beds.waitForFunction(() => document.querySelector('[data-testid="bed-state-bed-surg-1a"]')?.textContent === 'Occupied');
    assert.equal(await beds.textContent(t('bed-state-bed-med-1a')), 'Cleaning');
    assert.equal(await beds.textContent(t('unit-occupancy-unit-surg')), '1 of 20');
    await beds.click(t('bed-bed-surg-1a'));
    await beds.waitForSelector(t('bed-movements'));
    await beds.click(t('bed-movements'));
    await beds.waitForSelector(t('movements-table'));
    assert.equal(await beds.locator(`${t('movements-table')} tbody tr`).count(), 2);
    assert.match(await beds.textContent(t('movements-table-row-1')), /Surgical ward \/ Room 1 \/ Bed 1A/);
    await shot(beds, '06-movements');
    await beds.click(t('back-to-board'));
    await beds.waitForSelector(t('units'));
  });

  await step('beds: discharge sends the bed to cleaning; mark clean makes it available; the turnaround strip counts it', async () => {
    await beds.click(t('bed-bed-surg-1a'));
    await beds.waitForSelector(t('bed-discharge'));
    await beds.click(t('bed-discharge'));
    await beds.waitForSelector(t('discharge-confirm-ok'));
    await beds.click(t('discharge-confirm-ok'));
    await beds.waitForFunction(() => document.querySelector('[data-testid="bed-state-bed-surg-1a"]')?.textContent === 'Cleaning');
    assert.equal(await beds.textContent(t('unit-occupancy-unit-surg')), '0 of 20');
    assert.equal((await s.call('GET', `/fhir/R4/Encounter/${ava.e.id}`)).json.status, 'finished');
    await beds.click(t('bed-bed-med-1a'));
    await beds.waitForSelector(t('bed-clean'));
    await beds.click(t('bed-clean'));
    await beds.waitForFunction(() => document.querySelector('[data-testid="bed-state-bed-med-1a"]')?.textContent === 'Available');
    assert.match(await beds.textContent(t('turn-clean-today')), /median \d+ min, mean \d+ min \(1\)/);
  });

  await step('beds: block needs a reason and shows it on the tile; unblock needs a reason; reserve and release', async () => {
    await beds.click(t('bed-bed-ed-1'));
    await beds.waitForSelector(t('bed-block'));
    await beds.click(t('bed-block'));
    await beds.waitForSelector(t('block-reason'));
    await beds.fill(t('field-reason'), 'Broken bed rail');
    await beds.click(t('block-reason-submit'));
    await beds.waitForFunction(() => document.querySelector('[data-testid="bed-state-bed-ed-1"]')?.textContent === 'Blocked');
    assert.match(await beds.textContent(t('bed-bed-ed-1')), /Broken bed rail/);
    assert.match(await beds.getAttribute(t('bed-bed-ed-1'), 'aria-label'), /Blocked/);
    await beds.click(t('bed-bed-ed-1'));
    await beds.waitForSelector(t('bed-unblock'));
    await beds.click(t('bed-unblock'));
    await beds.waitForSelector(t('unblock-reason'));
    await beds.fill(t('field-reason'), 'Rail replaced');
    await beds.click(t('unblock-reason-submit'));
    await beds.waitForFunction(() => document.querySelector('[data-testid="bed-state-bed-ed-1"]')?.textContent === 'Available');
    await beds.click(t('bed-bed-icu-1'));
    await beds.waitForSelector(t('bed-reserve'));
    await beds.click(t('bed-reserve'));
    await beds.waitForFunction(() => document.querySelector('[data-testid="bed-state-bed-icu-1"]')?.textContent === 'Reserved');
    await beds.click(t('bed-bed-icu-1'));
    await beds.waitForSelector(t('bed-release'));
    await beds.click(t('bed-release'));
    await beds.waitForFunction(() => document.querySelector('[data-testid="bed-state-bed-icu-1"]')?.textContent === 'Available');
    await shot(beds, '07-block');
  });

  await step('ehr: a clinician sets the expected discharge date; the Beds app lists it under expected discharges today', async () => {
    await ehr.goto(`${s.base}/ehr/#/chart/${ben.p.id}/encounters`);
    await ehr.waitForSelector(t(`encounter-expected-set-${ben.e.id}`));
    await ehr.click(t(`encounter-expected-set-${ben.e.id}`));
    await ehr.waitForSelector(t('expected-form'));
    const today = new Date().toISOString().slice(0, 10);
    await ehr.fill(t('field-date'), today);
    await ehr.click(t('expected-form-submit'));
    await ehr.waitForFunction((id) => document.querySelector(`[data-testid="encounter-expected-${id}"]`)?.textContent.length > 0, ben.e.id);
    assert.equal(await ehr.textContent(t(`encounter-expected-${ben.e.id}`)), today);
    await beds.click(t('refresh'));
    await beds.waitForSelector(t(`expected-table-row-${ben.e.id}`));
    assert.match(await beds.textContent(t(`expected-table-row-${ben.e.id}`)), /Patient N100002.*No bed/);
  });

  await step('beds: "View as of" before the assignment shows the bed available, the time strip, and every move disabled; back to live', async () => {
    await beds.fill(t('time-travel-input'), local(beforeAssign));
    await beds.dispatchEvent(t('time-travel-input'), 'change');
    await beds.waitForSelector(t('time-strip'));
    assert.match(await beds.textContent(t('time-strip')), /Read-only/);
    await beds.waitForFunction(() => document.querySelector('[data-testid="bed-state-bed-med-1a"]')?.textContent === 'Available' && document.querySelector('[data-testid="waiting-count"]')?.textContent === '2');
    assert.equal(await beds.textContent(t('bed-state-bed-surg-1a')), 'Available');
    assert.ok(await beds.isDisabled(t(`waiting-assign-${ava.e.id}`)), 'writes are disabled in an as-of view');
    await beds.click(t('bed-bed-med-1a'));
    await beds.waitForSelector(t('bed-reserve'));
    assert.ok(await beds.isDisabled(t('bed-reserve')));
    assert.ok(await beds.isDisabled(t('bed-block')));
    await shot(beds, '08-as-of');
    await beds.click(t('bed-dialog-close'));
    await beds.click(t('time-travel-live'));
    await beds.waitForFunction(() => !document.querySelector('[data-testid="time-strip"]') && document.querySelector('[data-testid="bed-state-bed-med-1a"]')?.textContent === 'Available' && document.querySelector('[data-testid="waiting-count"]')?.textContent === '1');
  });

  await step('beds: a researcher has full access, every move enabled; a patient cannot open the app at all', async () => {
    await beds.selectOption(t('role-select'), 'researcher');
    await beds.waitForFunction((id) => document.querySelector(`[data-testid="waiting-assign-${id}"]`)?.disabled === false, ben.e.id);
    assert.notEqual(await beds.getAttribute(t(`waiting-assign-${ben.e.id}`), 'title'), 'Researcher is read-only outside Agent Dashboard');
    await beds.click(t('bed-bed-ed-1'));
    await beds.waitForSelector(t('bed-reserve'));
    assert.ok(await beds.isEnabled(t('bed-reserve')) && await beds.isEnabled(t('bed-block')), 'reserve and block are enabled');
    await beds.click(t('bed-dialog-close'));
    await beds.selectOption(t('role-select'), 'patient');
    await beds.waitForURL((u) => u.pathname.startsWith('/portal/'));
    await loginAs('nurse', 'Bed Manager');
    await beds.goto(`${s.base}/beds/#/dashboard`);
    await beds.waitForFunction((id) => document.querySelector(`[data-testid="waiting-assign-${id}"]`)?.disabled === false, ben.e.id);
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
