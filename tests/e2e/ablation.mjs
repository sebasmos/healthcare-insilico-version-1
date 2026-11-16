// Browser end-to-end test for ablation: hiding data from the launcher, the
// what-if tests page and its report.
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/ablation.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTestServer, tempDir } from '../support/helpers.mjs';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch {
  console.log('SKIPPED: Playwright is not installed. Set PLAYWRIGHT_MODULE to its path to run the browser test.');
  process.exit(0);
}

const work = tempDir('hd-abl-e2e-');
process.env.DICOM_DIR = path.join(work, 'dicom');
const s = await startTestServer({ webRoot: REPO_ROOT });

// The Agent Dashboard organises work into studies: the old launcher routes open the current study's Setup.
const STUDY = (await s.call('POST', '/agent-ops/research/studies', { title: 'Browser test study', question: 'Does the launcher still work inside a study?', mode: 'evaluate' }, { 'X-Role': 'researcher', 'X-User-Id': 'e2e' })).json.id;
const twinOf = async (type, id) => (await s.call('GET', `/agent-ops/studies/twin?type=${type}&id=${id}`, undefined, { 'X-Role': 'researcher' })).json.id; // the study page that holds an earlier study's or project's tools
const TWIN = await twinOf('Study', STUDY);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome' });
const errors = [];
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
context.setDefaultTimeout(15000);
await context.addInitScript((sid) => { localStorage.setItem('hd.role', 'researcher'); localStorage.setItem('hd.user', 'Researcher Two'); localStorage.setItem('hd.study', sid); }, STUDY);
const ops = await context.newPage();
ops.on('console', (m) => { if (m.type() === 'error' && !/status of (403|404|409|422)/.test(m.text())) errors.push(m.text()); });
ops.on('pageerror', (e) => errors.push(e.message));
const shots = process.env.E2E_SHOTS ? tempDir('hd-abl-shots-') : null;
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true }); };
const t = (id) => `[data-testid="${id}"]`;
const steps = [];
const step = async (name, fn) => { await fn(); steps.push(name); console.log(`ok - ${name}`); };
const rad = { 'X-Role': 'physician', 'X-User-Id': 'Dr Reader' };

try {
  const patient = (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', name: [{ family: 'Zzwhatif', given: ['Test'] }], birthDate: '1962-02-02', gender: 'male' })).json;
  const study = async (reason, started, accession) => (await s.call('POST', '/fhir/R4/ImagingStudy', { resourceType: 'ImagingStudy', status: 'available', subject: { reference: `Patient/${patient.id}` }, started, description: 'Chest X-ray', modality: [{ code: 'DX' }], reasonCode: [{ text: reason }],
    identifier: [{ type: { coding: [{ code: 'ACSN' }] }, value: accession }], numberOfSeries: 1, numberOfInstances: 2 }, { 'X-Role': 'nurse', 'X-User-Id': 'tech-one' })).json;
  const prior = await study('Cough', '2026-01-01T09:00:00Z', 'ACC-PRIOR');
  const report = (await s.call('POST', '/fhir/R4/DiagnosticReport', { resourceType: 'DiagnosticReport', status: 'preliminary', code: { text: 'Chest' }, subject: { reference: `Patient/${patient.id}` }, imagingStudy: [{ reference: `ImagingStudy/${prior.id}` }], conclusion: 'Right upper lobe nodule, 8 mm.', extension: [{ url: 'urn:hospital-desktop:report-technique', valueString: 'PA' }, { url: 'urn:hospital-desktop:report-findings', valueString: 'Nodule' }] }, rad)).json;
  assert.equal((await s.call('POST', `/fhir/R4/DiagnosticReport/${report.id}/$transition`, { to: 'final' }, rad)).status, 200);
  const followUp = await study('Follow-up of known right upper lobe nodule', '2026-06-01T09:00:00Z', 'ACC-FOLLOWUP');
  const routine = await study('Cough for two weeks', '2026-06-02T09:00:00Z', 'ACC-ROUTINE');
  const loaded = (await s.call('POST', '/agent-ops/cases/load', {})).json.loaded;
  const aki = loaded.find((c) => c.slug === 'acute-kidney-injury');

  await step('launcher: "Hide from agent" is live; a shadow run with priors hidden flags what it cannot find', async () => {
    await ops.goto(`${s.base}/agent-ops/#/s/${TWIN}/setup/shadow`);
    await ops.waitForSelector(t('launch-start'));
    await ops.click(t('setup-more-open'));
    for (const k of ['priors', 'labs', 'notes']) assert.equal(await ops.isDisabled(t(`launch-hide-${k}`)), false);
    await ops.selectOption(t('launch-agent'), 'report-drafter');
    await ops.waitForFunction((v) => [...(document.querySelector('[data-testid="launch-subject"]')?.options || [])].some((o) => o.value === v), `ImagingStudy/${followUp.id}`);
    await ops.selectOption(t('launch-subject'), `ImagingStudy/${followUp.id}`);
    await ops.check(t('launch-hide-priors'));
    await ops.click(t('launch-start'));
    await ops.waitForSelector(t('run-overlays'));
    assert.equal(await ops.textContent(t('run-overlays')), 'Hidden: prior imaging and its reports');
    const table = await ops.textContent(t('trace-table'));
    assert.match(table, /The request refers to earlier imaging, so look for the earlier study/);
    const run = (await s.call('GET', `/agent-ops/runs/${ops.url().split('#/runs/')[1]}`)).json;
    assert.deepEqual([run.mode, run.result.flags[0].code, run.overlays], ['shadow-task', 'missing-data', [{ type: 'hide', what: 'priors' }]]);
    await ops.goto(`${s.base}/agent-ops/#/s/${TWIN}/setup/shadow`);
    await ops.waitForSelector(t('launch-start'));
    await ops.uncheck(t('launch-hide-priors'));
  });

  await step('what-if test: priors hidden on a routine study, the agent does not notice and answers differently', async () => {
    await ops.goto(`${s.base}/agent-ops/#/evaluate/ablation`);
    await ops.waitForSelector(t('ablation-card'));
    assert.match(await ops.textContent(t('ablation-note')), /does not mean clinically correct/);
    assert.equal(await ops.textContent(t('ablation-runs')), '1', 'the launcher run is listed');
    await ops.selectOption(t('ablation-agent'), 'report-drafter');
    await ops.waitForFunction((v) => [...(document.querySelector('[data-testid="ablation-target"]')?.options || [])].some((o) => o.value === v), `ImagingStudy/${routine.id}`);
    await ops.selectOption(t('ablation-target'), `ImagingStudy/${routine.id}`);
    await ops.check(t('ablation-hide-priors'));
    await ops.click(t('ablation-start'));
    await ops.waitForFunction(() => document.querySelector('[data-testid="ablation-wrong"]')?.textContent === '1');
    assert.match(await ops.locator(t('toast-error')).last().textContent(), /Did not notice, and answered differently/);
    const row = (await s.call('GET', '/agent-ops/ablation')).json.rows[0];
    assert.equal(await ops.textContent(t(`ablation-verdict-${row.runId}`)), 'Did not notice, and answered differently');
    const detail = await ops.textContent(t(`ablation-detail-${row.runId}`));
    assert.match(detail, /With nothing changed.*Answer: abnormal.*With the changes.*Answer: normal.*The agent raised no flag.*removed \d+ records? from what the agent read/s);
    await shot(ops, '01-confidently-wrong');
  });

  await step('same test on the follow-up study: the agent notices and keeps its answer', async () => {
    await ops.selectOption(t('ablation-target'), `ImagingStudy/${followUp.id}`);
    await ops.click(t('ablation-start'));
    await ops.waitForFunction(() => document.querySelector('[data-testid="ablation-noticed-right"]')?.textContent === '1');
    const row = (await s.call('GET', '/agent-ops/ablation')).json.rows[0];
    assert.match(await ops.textContent(t(`ablation-flags-${row.runId}`)), /missing-data: The request refers to earlier imaging, but there is no earlier study or report/);
    assert.match(await ops.textContent(t('ablation-by-overlay')), /Hidden: prior imaging and its reports\s*3\s*1\s*2\s*1/);
    await ops.uncheck(t('ablation-hide-priors'));
  });

  // 2 later steps were removed with the content they exercised: the release ships no data.

  assert.deepEqual(errors, [], 'browser console errors');
  console.log(`\n${steps.length} browser steps passed. Console errors: 0.`);
  if (shots) console.log(`Screenshots: ${shots}`);
} catch (err) {
  console.error(`\nFAILED after ${steps.length} steps: ${err.stack || err.message}`);
  if (errors.length) console.error('Console errors:\n' + errors.join('\n'));
  if (shots) { let i = 0; for (const c of browser.contexts()) for (const p of c.pages()) { await p.screenshot({ path: path.join(shots, `fail-${i}.png`) }).catch(() => {}); i += 1; } console.error(`Screenshots: ${shots}`); }
  process.exitCode = 1;
} finally {
  await browser.close();
  await s.close();
  fs.rmSync(work, { recursive: true, force: true });
}
