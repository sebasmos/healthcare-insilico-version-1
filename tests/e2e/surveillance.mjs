// Browser test for Surveillance and Reporting: an empty hospital shows empty tables; "Report a problem" on a
// run files a report with its context attached; the patient reports in plain language from the Portal and sees
// only a plain summary; the report page answers "one-off or pattern?"; triage, replay and the kill switch;
// automatic surveillance, verifier agents, the subgroup explorer, signals, a surveillance study and the export.
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/surveillance.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTestServer } from '../support/helpers.mjs';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch { console.log('SKIPPED: Playwright is not installed. Set PLAYWRIGHT_MODULE to its path to run the browser test.'); process.exit(0); }
const s = await startTestServer({ webRoot: REPO_ROOT });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome' });
const t = (id) => `[data-testid="${id}"]`;
const errors = []; const steps = [];
const step = async (name, fn) => { try { await fn(); steps.push(name); console.log(`ok - ${name}`); } catch (err) { console.log(`FAILED after ${steps.length} steps: ${err.stack || err}`); if (errors.length) console.log(`Console errors:\n${errors.join('\n')}`); await browser.close(); await s.close(); process.exit(1); } };
const newPage = async (user, role, extra = {}) => { const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); await ctx.addInitScript(([u, r, x]) => { localStorage.setItem('hd.role', r); localStorage.setItem('hd.user', u); localStorage.setItem('hd.session', 'in'); for (const [k, v] of Object.entries(x)) localStorage.setItem(k, v); }, [user, role, extra]); const page = await ctx.newPage(); page.on('console', (m) => { if (m.type() === 'error' && !/status of (409|422|403|404)/.test(m.text())) errors.push(`${user}: ${m.text()}`); }); page.on('pageerror', (e) => errors.push(`${user}: ${e.message}`)); return page; };
const unlabelled = (page) => page.evaluate(() => [...document.querySelectorAll('button, input, select, textarea')].filter((el) => el.offsetParent && (!el.dataset.testid || !el.getAttribute('aria-label'))).map((el) => el.outerHTML.slice(0, 120)));
const res = { 'X-Role': 'researcher', 'X-User-Id': 'researcher-1' };

const ops = await newPage('researcher-1', 'researcher');
await step('an empty hospital: the area opens from the home page and every tab shows an empty table, not an error', async () => {
  await ops.goto(`${s.base}/agent-ops/`);
  await ops.click(t('tab-surveillance'));
  await ops.waitForSelector(t('surv-tabs'));
  assert.equal(await ops.locator(`${t('surv-tabs')} a`).count(), 9);
  for (const tab of ['overview', 'reports', 'aggregate', 'subgroups', 'signals', 'automatic', 'verifiers', 'studies', 'export']) { await ops.click(t(`surv-tab-${tab}`)); await ops.waitForFunction((x) => document.querySelector(`[data-testid="surv-tab-${x}"]`)?.getAttribute('aria-current') === 'page', tab); await ops.waitForTimeout(250); assert.deepEqual(await unlabelled(ops), [], tab); }
  await ops.click(t('surv-tab-reports'));
  await ops.waitForSelector(t('surv-queue-empty'));
  assert.equal(await ops.textContent(t('surv-queue-empty')), 'No data to display');
});

// One patient (no name) with a potassium result, and a real run of a rule-based agent on it.
const p = (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', gender: 'female', birthDate: '1950-06-01', meta: { security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }] } }, { 'X-Role': 'physician', 'X-User-Id': 'physician-1' })).json;
await s.store.transaction((tx) => tx.save('Observation', { resourceType: 'Observation', id: 'k1', status: 'final', subject: { reference: `Patient/${p.id}` }, _patient: `Patient/${p.id}`, category: [{ coding: [{ code: 'laboratory' }] }], code: { coding: [{ system: 'http://loinc.org', code: '2823-3', display: 'Potassium' }] }, effectiveDateTime: s.store.now(), valueQuantity: { value: 6.8, unit: 'mmol/L' } }, { updatedBy: 'import' }));
const done = await s.agents.launch({ agentId: 'workup-planner', mode: 'sandbox', subject: `Patient/${p.id}`, goal: 'Review this patient', actor: { kind: 'human', id: 'researcher-1', role: 'researcher' }, trigger: { kind: 'manual', role: 'physician', specialty: 'emergency', site: 'site-1' }, wait: true });
const runId = done.id ?? done.runId ?? done.run?.id;
let caseId; let reportId;

await step('"Report a problem" on an agent run: three required answers, optional detail, context attached automatically', async () => {
  await ops.goto(`${s.base}/agent-ops/#/runs/${runId}`);
  await ops.click(t('run-report-problem'));
  await ops.waitForSelector(t('report-problem'));
  assert.deepEqual(await unlabelled(ops), []);
  await ops.click(t('rp-send'));
  await ops.waitForFunction(() => /what happened/i.test(document.querySelector('[data-testid="rp-error"]').textContent));
  await ops.fill(t('rp-what'), 'It prescribed a drug at the wrong moment for this patient.');
  await ops.selectOption(t('rp-reached'), 'caught-before');
  await ops.selectOption(t('rp-severity'), 'severe');
  await ops.click(t('rp-more-open'));
  await ops.selectOption(t('rp-harm'), 'unsafe');
  await ops.fill(t('rp-right'), 'Wait for the repeat result.');
  await ops.click(t('rp-send'));
  await ops.waitForSelector(t('report-problem'), { state: 'detached' });
  const all = (await s.call('GET', '/agent-ops/surveillance/reports', undefined, res)).json.reports;
  assert.equal(all.length, 1); caseId = all[0].caseId; reportId = all[0].id;
  assert.deepEqual([all[0].context.agent, all[0].context.run, all[0].context.keys.specialty, all[0].context.keys.ageBand, all[0].harm], ['workup-planner', runId, 'emergency', '65-79', 'unsafe']);
  // The trace viewer has the same button on a step.
  await ops.goto(`${s.base}/agent-ops/#/trace/${runId}`);
  await ops.waitForSelector(t('tv-timeline'));
  await ops.click(`${t('tv-timeline')} .tvrow`);
  await ops.waitForSelector(t('tv-report-problem'));
});

const portal = await newPage('patient', 'patient', { 'hd.patient': p.id, 'hd.portalPatient': p.id });
await step('Patient Portal: a plain-language form with choices; the patient sees their report, its status and a plain summary, and nothing about anyone else', async () => {
  await portal.goto(`${s.base}/portal/#/report`);
  await portal.waitForSelector(t('portal-report-problem'));
  await portal.click(t('portal-report-problem'));
  await portal.waitForSelector(t('report-problem'));
  assert.match(await portal.textContent(t('report-problem')), /What happened\?.*How did it affect you\?/s);
  assert.equal(await portal.locator(t('rp-severity')).count(), 0, 'no clinical grading asked of a patient');
  await portal.selectOption(t('rp-choice'), 'wrong-information');
  await portal.fill(t('rp-what'), 'The summary said I take a tablet that I stopped last year.');
  await portal.selectOption(t('rp-effect'), 'worried');
  assert.deepEqual(await unlabelled(portal), []);
  await portal.click(t('rp-send'));
  await portal.waitForSelector(t('report-problem'), { state: 'detached' });
  await portal.waitForSelector('[data-testid^="my-report-AE-"]');
  const text = await portal.textContent(t('portal-my-reports'));
  assert.match(text, /AE-000002.*New/s); assert.equal(text.includes(caseId), false, 'the other report is not shown to the patient');
  const mine = (await s.call('GET', '/agent-ops/surveillance/reports?source=human', undefined, res)).json.reports.find((r) => r.source.role === 'patient');
  assert.deepEqual([mine.severity, mine.harm, mine.patientChoice], ['mild', 'wrong', 'wrong-information']);
});

await step('the report page: one-off or pattern, the AI context, base rate, lineage, subgroups; triage with causality; a question to the reporter; replay; the kill switch once confirmed and severe', async () => {
  await ops.goto(`${s.base}/agent-ops/#/surveillance/reports`);
  await ops.waitForSelector(`${t('surv-queue')} tbody tr`);
  assert.equal(await ops.textContent(t(`surv-source-${caseId}`)), 'Reported by a person');
  await ops.click(`${t('surv-queue')} tbody tr:has-text("${caseId}")`);
  await ops.waitForSelector(t('surv-summary'));
  assert.match(await ops.textContent(t('surv-summary')), /similar reports? since .* per 1,000 uses\..*one-off/s);
  assert.match(await ops.textContent(t('surv-context')), /workup-planner v.*Policy hash.*Steps linked/s);
  { const keys = await ops.textContent(t('surv-keys')); assert.match(keys, /User specialty: emergency/); assert.match(keys, /Patient age: 65-79/); }
  assert.match(await ops.textContent(t('surv-completeness')), /\d+%/);
  assert.match(await ops.textContent(t('surv-actions-note')), /confirmed AI-related and severe/);
  for (const id of ['surv-similar', 'surv-base-rate', 'surv-lineage', 'surv-ood', 'surv-subgroup-view', 'surv-reproduce']) assert.ok(await ops.isVisible(t(id)), id);
  assert.deepEqual(await unlabelled(ops), []);
  await ops.click(t('surv-ask'));
  await ops.fill(t('surv-question-text'), 'Which drug?');
  await ops.click(t('surv-question-send'));
  await ops.waitForFunction(() => document.querySelector('[data-testid="surv-report-status"]')?.textContent === 'Needs information');
  await ops.click(t('surv-replay'));
  await ops.waitForSelector(t('surv-reproduced'), { timeout: 60000 });
  assert.match(await ops.textContent(t('surv-reproduced')), /Reproduced: yes \(3 of 3\)/);
  await ops.click(t('surv-causality-open'));
  await ops.selectOption(t('surv-causality-level'), 'certain');
  await ops.fill(t('surv-causality-reason'), 'Replayed three times.');
  await ops.click(t('surv-causality-ok'));
  await ops.waitForSelector(t('surv-causality'), { state: 'detached' });
  await ops.selectOption(t('surv-set-status'), 'confirmed-ai');
  await ops.waitForSelector(t('surv-actions'));
  await ops.click(t('surv-action-pause'));
  await ops.fill(t('surv-action-pause-form-reason'), 'Unsafe prescribing reproduced.');
  await ops.click(t('surv-action-pause-form-ok'));
  await ops.waitForSelector(t('surv-actions-taken'));
  const blocked = await s.call('POST', '/agent-ops/runs', { mode: 'shadow-task', agentId: 'workup-planner', subject: `Patient/${p.id}` }, res);
  assert.equal(blocked.status, 403); assert.match(blocked.text, /kill switch/i);
  assert.match(await ops.textContent(t('surv-versions')), /\d+ versions/);
});

await step('automatic surveillance and verifier agents: a rule opens a possible event on Check now; an agent given the Verifier role becomes read-only and shows in the table', async () => {
  await s.call('POST', '/fhir/R4/Communication', { resourceType: 'Communication', status: 'completed', subject: { reference: `Patient/${p.id}` }, sender: { reference: `Patient/${p.id}` }, sent: new Date(Date.now() + 1000).toISOString(), payload: [{ contentString: 'That was wrong and I am unhappy.' }] }, { 'X-Role': 'patient', 'X-User-Id': 'patient' });
  await ops.goto(`${s.base}/agent-ops/#/surveillance/automatic`);
  await ops.waitForSelector(t('surv-rules-table'));
  assert.equal(await ops.locator(`${t('surv-rules-table')} tbody tr`).count(), 6);
  await ops.click(t('surv-sweep'));
  await ops.waitForFunction(() => /Detected by rules: [0-9.]+ per 1,000/.test(document.querySelector('[data-testid="surv-gap"]')?.textContent || '') && !/Detected by rules: 0 per/.test(document.querySelector('[data-testid="surv-gap"]').textContent));
  assert.deepEqual(await unlabelled(ops), []);
  await ops.click(t('surv-tab-reports'));
  await ops.waitForSelector(`${t('surv-queue')} tbody tr:has-text("Detected automatically")`);
  await ops.click(t('surv-tab-verifiers'));
  await ops.waitForSelector(t('surv-verifier-give'));
  await ops.selectOption(t('surv-verifier-agent'), 'chart-summariser');
  await ops.click(t('surv-verifier-give'));
  await ops.waitForSelector(`${t('surv-verifier-table')} tbody tr:has-text("Chart Summariser")`);
  assert.equal((await s.store.get('Agent', 'chart-summariser')).granted.systems.ehr, 'read-only');
  assert.deepEqual(await unlabelled(ops), []);
});

await step('subgroups, signals, a surveillance study with its export, and the summary export', async () => {
  await ops.click(t('surv-tab-subgroups'));
  await ops.waitForSelector(t('surv-explorer'));
  await ops.selectOption(t('surv-dim-a'), 'specialty'); await ops.waitForSelector(t('surv-grid'));
  assert.match(await ops.textContent(t('surv-grid')), /emergency/); assert.match(await ops.textContent(t('surv-grid')), /small numbers/);
  await ops.click(t('surv-tab-signals'));
  await ops.waitForSelector(t('surv-signals'));
  await ops.selectOption(t('surv-agent'), 'workup-planner'); await ops.waitForSelector(t('surv-statistics-pick'));
  await ops.selectOption(t('surv-harm'), 'unsafe');
  await ops.waitForSelector(t('surv-methods'));
  assert.equal(await ops.locator(`${t('surv-methods')} .badge`).count(), 7);
  await ops.click(t('surv-watch-add'));
  await ops.waitForSelector(`${t('surv-watch-table')} tbody tr:has-text("workup-planner")`);
  await ops.click(t('surv-tab-studies'));
  await ops.waitForSelector(t('sim-run'));
  await ops.fill(t('sim-seeds'), '3'); await ops.fill(t('sim-days'), '60'); await ops.fill(t('sim-signal-day'), '30'); await ops.fill(t('sim-factor'), '8'); await ops.fill(t('sim-uses'), '500');
  await ops.check(t('sim-notoriety'));
  assert.deepEqual(await unlabelled(ops), []);
  await ops.click(t('sim-run'));
  await ops.waitForSelector(t('sim-results'), { timeout: 60000 });
  assert.equal(await ops.locator(`${t('sim-results')} tbody tr`).count(), 28);
  assert.match(await ops.textContent(t('sim-truth')), /Truth: version signal from day 30, rate × 8/);
  const csv = await (await fetch(`${s.base}${await ops.getAttribute(t('sim-csv'), 'href')}`, { headers: res })).text();
  assert.match(csv, /^sources,method,runs,detected/);
  await ops.click(t('surv-tab-export'));
  await ops.waitForSelector(t('surv-export-csv'));
  assert.match(await ops.textContent(t('surv-export-notes')), /restricted sources are not in this export.*suppressed.*de-identification/s);
  const out = await (await fetch(`${s.base}${await ops.getAttribute(t('surv-export-csv'), 'href')}`, { headers: res })).text();
  assert.match(out, /^section,key,events,uses,per1000,low,high/);
});

await browser.close(); await s.close();
if (errors.length) { console.log(`Console errors:\n${errors.join('\n')}`); process.exit(1); }
console.log(`${steps.length} browser steps passed. Console errors: 0.`);
