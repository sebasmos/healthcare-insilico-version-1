// Browser end-to-end test for human in the loop: practice runs, proposal cards
// in PACS and the Inbox, planted errors, the promotion gate and live proposals.
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/hitl.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTestServer, tempDir } from '../support/helpers.mjs';
import { buildPhantom } from '../support/phantom.mjs';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch {
  console.log('SKIPPED: Playwright is not installed. Set PLAYWRIGHT_MODULE to its path to run the browser test.');
  process.exit(0);
}

const work = tempDir('hd-hitl-e2e-');
process.env.DICOM_DIR = path.join(work, 'dicom');
const s = await startTestServer({ webRoot: REPO_ROOT });

// The Agent Dashboard organises work into studies: the old launcher routes open the current study's Setup.
const STUDY = (await s.call('POST', '/agent-ops/research/studies', { title: 'Browser test study', question: 'Does the launcher still work inside a study?', mode: 'evaluate' }, { 'X-Role': 'researcher', 'X-User-Id': 'e2e' })).json.id;
const twinOf = async (type, id) => (await s.call('GET', `/agent-ops/studies/twin?type=${type}&id=${id}`, undefined, { 'X-Role': 'researcher' })).json.id; // the study page that holds an earlier study's or project's tools
const TWIN = await twinOf('Study', STUDY);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome' });
const errors = [];
const newPage = async (role, user, name) => {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  context.setDefaultTimeout(15000);
  await context.addInitScript(([r, u, sid]) => { localStorage.setItem('hd.role', r); localStorage.setItem('hd.user', u); localStorage.setItem('hd.study', sid); }, [role, user, STUDY]);
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (403|409|422|423)/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return page;
};
const shots = process.env.E2E_SHOTS ? tempDir('hd-hitl-shots-') : null;
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true }); };
const t = (id) => `[data-testid="${id}"]`;
const steps = [];
const step = async (name, fn) => { await fn(); steps.push(name); console.log(`ok - ${name}`); };
const runs = async () => (await s.call('GET', '/agent-ops/runs')).json.runs.filter((r) => r.id !== 'live');

try {
  await s.call('PUT', '/api/friction', { level: 'low' });
  const patient = (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', name: [{ family: 'Zzshadow', given: ['Sample'] }], birthDate: '1961-05-05', gender: 'male' })).json;
  const mrn = patient.identifier.find((i) => i.type.coding[0].code === 'MR').value;
  const boundary = 'e2e-boundary';
  const parts = [];
  for (const f of buildPhantom({ mrn, name: 'Zzshadow^Sample' })) parts.push(Buffer.from(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`), Buffer.from(f.bytes), Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const stow = await fetch(`${s.base}/dicom-web/studies`, { method: 'POST', headers: { 'Content-Type': `multipart/related; type="application/dicom"; boundary=${boundary}`, 'X-Role': 'nurse' }, body: Buffer.concat(parts) });
  assert.equal(stow.status, 200);
  const worklist = (await s.call('GET', '/api/pacs/worklist?queue=all')).json.rows;
  const xr = worklist.filter((r) => r.modality !== 'CT').sort((a, b) => String(b.started).localeCompare(String(a.started)))[0];
  const ct = worklist.find((r) => r.modality === 'CT');
  const message = (await s.call('POST', '/fhir/R4/Communication', { resourceType: 'Communication', status: 'completed', subject: { reference: `Patient/${patient.id}` }, sender: { reference: `Patient/${patient.id}` }, sent: new Date().toISOString(), topic: { text: 'Chest symptoms' }, payload: [{ contentString: 'I have had chest pain since this morning.' }] }, { 'X-Role': 'patient', 'X-User-Id': `Patient/${patient.id}` })).json;
  await s.agents.idle();

  const ops = await newPage('researcher', 'Researcher Two', 'agent-ops');
  const pacs = await newPage('physician', 'Dr Reader', 'pacs');
  const ehr = await newPage('physician', 'Dr Chart', 'ehr');
  const rad = { 'X-Role': 'physician', 'X-User-Id': 'Dr Reader' };
  const startRun = async (agentId, subject, extra = async () => {}) => {
    await ops.goto(`${s.base}/agent-ops/#/s/${TWIN}/setup/hitl`);
    await ops.waitForSelector(t('launch-start'));
    await ops.waitForSelector(t('launch-where'));
    await ops.selectOption(t('launch-agent'), agentId);
    await ops.waitForFunction((v) => [...(document.querySelector('[data-testid="launch-subject"]')?.options || [])].some((o) => o.value === v), subject);
    await ops.selectOption(t('launch-subject'), subject);
    await extra();
    await ops.click(t('launch-start'));
    await ops.waitForSelector(t('run-proposals'));
    const id = ops.url().split('#/runs/')[1];
    return (await s.call('GET', `/agent-ops/runs/${id}`)).json;
  };

  let first;
  await step('launcher: an unpromoted agent can only be tried on a practice copy', async () => {
    await ops.goto(`${s.base}/agent-ops/#/s/${TWIN}/setup/hitl`);
    await ops.waitForSelector(t('launch-start'));
    await ops.waitForSelector(t('launch-where'));
    await ops.selectOption(t('launch-agent'), 'report-drafter');
    await ops.waitForSelector(t('launch-not-promoted'));
    assert.deepEqual(await ops.locator(`${t('launch-where')} option`).allTextContents(), ['Practice copy of the chart (sandbox)']);
    assert.match(await ops.textContent(t('launch-not-promoted')), /has not been promoted, so the live chart is locked/);
    first = await startRun('report-drafter', `ImagingStudy/${xr.id}`);
    assert.deepEqual([first.status, first.mode], ['awaiting-decision', 'hitl']);
    assert.match(first.targetBranch, /^sandbox-/);
    assert.match(await ops.textContent(t('run-target')), /Practice copy/);
    assert.match(await ops.textContent(t('run-proposals')), /Imaging report.*Waiting for a clinician/s);
    assert.equal(await ops.getAttribute(t('run-open-app'), 'href'), `/pacs/?branch=${first.targetBranch}#/study/${xr.id}`);
    await shot(ops, '01-run-waiting');
  });

  await step('PACS on the practice copy: proposal card with watermark and what the agent saw', async () => {
    await pacs.goto(`${s.base}/pacs/?branch=${first.targetBranch}#/study/${xr.id}`);
    await pacs.waitForSelector('[data-testid^="proposal-watermark-"]');
    assert.match(await pacs.textContent(t('time-strip')), /Practice copy .*Nothing here reaches the live chart/);
    const id = (await s.call('GET', `/agent-ops/proposals?_branch=${first.targetBranch}`)).json.proposals[0].id;
    assert.equal(await pacs.textContent(t(`proposal-watermark-${id}`)), 'AI-drafted — not signed');
    const border = await pacs.locator(t(`proposal-${id}`)).evaluate((el) => getComputedStyle(el).borderLeftWidth);
    assert.equal(border, '4px');
    assert.match(await pacs.textContent(t(`proposal-impression-${id}`)), /Requires radiologist review/);
    assert.equal(await pacs.isVisible(t(`proposal-saw-${id}`)), false);
    await pacs.click(t(`proposal-saw-toggle-${id}`));
    assert.match(await pacs.textContent(t(`proposal-saw-${id}`)), /Imaging study:.*Patient chart: Patient N100001/s);
    assert.equal(await pacs.inputValue(t('report-impression')), '', 'the report fields stay empty until the clinician decides');
    await shot(pacs, '02-card');
    first.proposal = id;
  });

  await step('edit, then sign: the clinician signs, the diff is kept, the live chart is untouched', async () => {
    const id = first.proposal;
    await pacs.click(t(`proposal-edit-${id}`));
    await pacs.waitForSelector(t('proposal-edit-form'));
    await pacs.fill(`${t('proposal-edit-form')} [name="impression"]`, 'No acute cardiopulmonary abnormality.');
    await pacs.click(t('proposal-edit-form-submit'));
    await pacs.waitForSelector(t('report-status'));
    assert.equal(await pacs.textContent(t('ro-impression')), 'No acute cardiopulmonary abnormality.');
    assert.match(await pacs.textContent(t('report-pane')), /Signed by\s*Dr Reader/);
    assert.equal(await pacs.locator(t(`proposal-${id}`)).count(), 0);
    assert.equal((await s.call('GET', '/fhir/R4/DiagnosticReport')).json.total, 0, 'nothing on the live chart');
    await ops.reload();
    await ops.waitForSelector(t(`proposal-state-${id}`));
    assert.equal(await ops.textContent(t(`proposal-state-${id}`)), 'Edited, then accepted');
    assert.match(await ops.textContent(t('run-proposals')), /Dr Reader.*characters/s);
    assert.match(await ops.textContent(t('trace-table')), /Proposal shown to clinicians.*Clinician saw the proposal.*Clinician edited, then accepted/s);
    assert.match(await ops.textContent(t('run-status-' + first.id)), /completed/);
    await pacs.click(t('return-to-live'));
    await pacs.waitForSelector(t('report-technique'));
    assert.equal(await pacs.locator(t('time-strip')).count(), 0);
    assert.equal(await pacs.inputValue(t('report-impression')), '');
  });

  await step('Inbox on a practice copy: triage proposal, rejected with a reason', async () => {
    const run = await startRun('inbox-triager', `Communication/${message.id}`);
    assert.equal(await ops.getAttribute(t('run-open-app'), 'href'), `/ehr/?branch=${run.targetBranch}#/inbox`);
    await ehr.goto(`${s.base}/ehr/?branch=${run.targetBranch}#/inbox`);
    await ehr.waitForSelector(t('inbox-proposals'));
    const id = (await s.call('GET', `/agent-ops/proposals?_branch=${run.targetBranch}`)).json.proposals[0].id;
    assert.match(await ehr.textContent(t('inbox-proposals')), /Patient N100001 wrote: "I have had chest pain/);
    assert.equal(await ehr.textContent(t(`proposal-label-${id}`)), 'Urgent');
    assert.match(await ehr.textContent(t(`proposal-reply-${id}`)), /call your local emergency number/);
    await ehr.click(t(`proposal-reject-${id}`));
    await ehr.fill(`${t('proposal-reject-reason')} input`, 'Already spoke to the patient by phone');
    await ehr.click(t('proposal-reject-reason-submit'));
    await ehr.waitForSelector(t('inbox-proposals'), { state: 'detached' });
    const card = (await s.call('GET', `/agent-ops/proposals?_branch=${run.targetBranch}`)).json.proposals[0];
    assert.deepEqual([card.status, card.reason, card.decidedBy], ['rejected', 'Already spoke to the patient by phone', 'Dr Chart']);
    assert.equal((await s.call('GET', `/fhir/R4/Communication?_branch=${run.targetBranch}`)).json.total, 1, 'no reply was sent');
    await ehr.click(t('return-to-live'));
    await ehr.waitForSelector(t('inbox-messages'));
    assert.equal(await ehr.locator(t('inbox-proposals')).count(), 0);
  });

  await step('planted error on a practice copy: needs the synthetic confirmation, looks like any other card, debrief after', async () => {
    await ops.goto(`${s.base}/agent-ops/#/s/${TWIN}/setup/hitl`);
    await ops.waitForSelector(t('launch-start'));
    await ops.waitForSelector(t('launch-probe'));
    await ops.selectOption(t('launch-agent'), 'report-drafter');
    await ops.waitForFunction((v) => [...(document.querySelector('[data-testid="launch-subject"]')?.options || [])].some((o) => o.value === v), `ImagingStudy/${ct.id}`);
    await ops.selectOption(t('launch-subject'), `ImagingStudy/${ct.id}`);
    await ops.check(t('launch-probe'));
    await ops.waitForSelector(t('launch-synthetic'));
    await ops.click(t('launch-start'));
    await ops.waitForSelector(t('toast-error'));
    assert.match(await ops.locator(t('toast-error')).last().textContent(), /Confirm that the patient is synthetic/);
    await ops.check(t('launch-synthetic'));
    await ops.click(t('launch-start'));
    await ops.waitForSelector(t('run-proposals'));
    const run = (await s.call('GET', `/agent-ops/runs/${ops.url().split('#/runs/')[1]}`)).json;
    await pacs.goto(`${s.base}/pacs/?branch=${run.targetBranch}#/study/${ct.id}`);
    await pacs.waitForSelector('[data-testid^="proposal-accept-"]');
    const id = (await s.call('GET', `/agent-ops/proposals?_branch=${run.targetBranch}`)).json.proposals[0].id;
    assert.match(await pacs.textContent(t(`proposal-impression-${id}`)), /Large right pneumothorax/);
    assert.doesNotMatch(await pacs.textContent(t(`proposal-${id}`)), /planted|deliberately|test/i);
    await pacs.click(t(`proposal-accept-${id}`));
    await pacs.click(t('proposal-sign-ok'));
    await pacs.waitForSelector(t('planted-debrief'));
    assert.match(await pacs.textContent(t('planted-debrief')), /deliberately wrong.*automation-bias test.*You accepted it unchanged/s);
    await pacs.click(t('planted-debrief-close'));
    await pacs.click(t('return-to-live'));
    await pacs.waitForSelector(t('report-technique'));
  });

  await step('review results: acceptance, edit size, decision time, asks per case and the planted-error count', async () => {
    await ops.goto(`${s.base}/agent-ops/#/s/${TWIN}/results/hitl`);
    await ops.waitForSelector(t('hitl-agent-report-drafter-1-2-0'));
    assert.match(await ops.textContent(t('hitl-note')), /not whether the agent was right/);
    const key = 'report-drafter-1-2-0-practice';
    assert.equal(await ops.textContent(t(`hitl-cases-${key}`)), '1');
    assert.equal(await ops.textContent(t(`hitl-acceptance-${key}`)), '100%');
    assert.equal(await ops.textContent(t(`hitl-unchanged-${key}`)), '0%');
    assert.match(await ops.textContent(t(`hitl-edit-${key}`)), /^\d+(\.\d+)? chars$/);
    assert.match(await ops.textContent(t(`hitl-time-${key}`)), /^[\d.]+ s$/);
    assert.equal(await ops.textContent(t(`hitl-asks-${key}`)), '1');
    assert.match(await ops.textContent(t('hitl-bias-report-drafter-1-2-0')), /1 deliberately wrong proposal planted on practice copies: 1 accepted unchanged, 0 caught/);
    assert.equal(await ops.textContent(t('hitl-acceptance-inbox-triager-1-1-0-practice')), '0%');
    assert.equal(await ops.locator(t('hitl-cases-report-drafter-1-2-0-live')).count(), 0);
    await shot(ops, '03-review-results');
  });

  await step('promotion gate: refused without evidence; thresholds are editable; red team cannot be skipped', async () => {
    await ops.goto(`${s.base}/agent-ops/#/library/agents`); // Agents live in the Library now
    await ops.waitForSelector(t('agents-table'));
    assert.equal(await ops.textContent(t('agent-stage-report-drafter')), 'Shadow only');
    assert.deepEqual([await ops.textContent(t('gate-agreement')), await ops.textContent(t('gate-cases'))], ['85%', '50']);
    await ops.click(t('agent-promotion-report-drafter'));
    await ops.waitForSelector(t('promotion-dialog'));
    assert.match(await ops.textContent(t('promotion-shadow')), /Not met.*0 cases compared.*Needs at least 50 cases and 85%/s);
    assert.match(await ops.textContent(t('promotion-redteam')), /Not met.*no run exists for this version/s);
    await ops.click(t('promotion-promote'));
    await ops.waitForFunction(() => [...document.querySelectorAll('[data-testid="toast-error"]')].some((el) => /cannot be promoted yet/.test(el.textContent)));
    assert.match((await ops.locator(t('toast-error')).allTextContents()).join('\n'), /cannot be promoted yet.*no red-team run exists/s);
    await ops.click(t('promotion-dialog-close'));
    await shot(ops, '04-promotion-refused');
    await ops.click(t('gate-edit'));
    await ops.fill(`${t('gate-form')} [name="minAgreement"]`, '50');
    await ops.fill(`${t('gate-form')} [name="minCases"]`, '1');
    await ops.click(t('gate-form-submit'));
    await ops.waitForFunction(() => document.querySelector('[data-testid="gate-cases"]')?.textContent === '1');

    // One real shadow case on the live chart: the radiologist opens and signs the chest study.
    assert.equal((await s.call('POST', `/api/pacs/studies/${xr.id}/open`, {}, rad)).status, 200);
    await s.agents.idle();
    const draft = (await s.call('POST', '/fhir/R4/DiagnosticReport', { resourceType: 'DiagnosticReport', status: 'preliminary', code: { text: 'Chest' }, subject: { reference: `Patient/${patient.id}` }, imagingStudy: [{ reference: `ImagingStudy/${xr.id}` }], conclusion: 'No acute abnormality.', extension: [{ url: 'urn:hospital-desktop:report-technique', valueString: 'PA' }, { url: 'urn:hospital-desktop:report-findings', valueString: 'Clear' }] }, rad)).json;
    assert.equal((await s.call('POST', `/fhir/R4/DiagnosticReport/${draft.id}/$transition`, { to: 'final' }, rad)).status, 200);
    await ops.click(t('agent-promotion-report-drafter'));
    await ops.waitForSelector(t('promotion-dialog'));
    assert.match(await ops.textContent(t('promotion-shadow')), /^Met/);
    assert.match(await ops.textContent(t('promotion-redteam')), /^Not met/);
    await ops.click(t('promotion-promote'));
    await ops.waitForSelector(t('toast-error'));
    assert.equal((await s.store.get('Agent', 'report-drafter')).stage, 'shadow', 'shadow evidence alone does not promote');
    await ops.click(t('promotion-dialog-close'));
  });

  // 3 later steps were removed with the content they exercised: the release ships no data.

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
