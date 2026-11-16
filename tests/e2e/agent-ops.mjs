// Browser end-to-end test for Agent Dashboard: launcher, registry, kill switches,
// runs, and the shadow dashboard fed by real clinician work in PACS and the EHR.
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/agent-ops.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTestServer, tempDir } from '../support/helpers.mjs';
import { demoLogin } from '../support/demo-login.mjs';
import { buildPhantom } from '../support/phantom.mjs';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch {
  console.log('SKIPPED: Playwright is not installed. Set PLAYWRIGHT_MODULE to its path to run the browser test.');
  process.exit(0);
}

const work = tempDir('hd-ops-e2e-');
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
const shots = process.env.E2E_SHOTS ? tempDir('hd-ops-shots-') : null;
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true }); };
const t = (id) => `[data-testid="${id}"]`;
const steps = [];
const step = async (name, fn) => { await fn(); steps.push(name); console.log(`ok - ${name}`); };
const runs = async () => (await s.call('GET', '/agent-ops/runs')).json.runs.filter((r) => r.id !== 'live');

try {
  await s.call('PUT', '/api/friction', { level: 'low' });
  const patient = (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', name: [{ family: 'Zzshadow', given: ['Test'] }], birthDate: '1961-05-05', gender: 'male' })).json;
  const mrn = patient.identifier.find((i) => i.type.coding[0].code === 'MR').value;
  const boundary = 'e2e-boundary';
  const parts = [];
  for (const f of buildPhantom({ mrn, name: 'Zzshadow^Test' })) parts.push(Buffer.from(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`), Buffer.from(f.bytes), Buffer.from('\r\n'));
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

  await step('desktop tile opens Agent Dashboard; the launcher offers only what is built', async () => {
    await ops.goto(`${s.base}/`);
    await ops.waitForSelector(t('lock-screen'));
    await demoLogin(ops, 'researcher', { name: 'Researcher Two' });
    assert.notEqual(await ops.locator(t('dock-agent-ops')).getAttribute('aria-disabled'), 'true', 'the researcher has the Agent Dashboard in the dock');
    await ops.goto(`${s.base}/agent-ops/#/s/${TWIN}/setup/shadow`);
    await ops.waitForSelector(t('launch-start'));
    assert.equal(await ops.textContent('.appname'), 'Agent Dashboard');
    assert.ok(await ops.isVisible(t('launch-condition')), 'the condition choice is on the launcher');
    await ops.goto(`${s.base}/agent-ops/#/evaluate`);
    await ops.waitForSelector(t('card-new-evaluation'));
    await ops.locator('.hx-card', { hasText: 'Browser test study' }).click(); await ops.waitForSelector(t('study-sections')); // the earlier study is a card on the Evaluate tab, with its tools under its own page
    await ops.goto(`${s.base}/agent-ops/#/s/${TWIN}/setup`);
    await ops.waitForSelector(t('setup-pick'));
    for (const id of ['shadow', 'hitl', 'redteam']) assert.ok(await ops.isVisible(t(`setup-tile-${id}`)), `${id} can be chosen`);
    await ops.goto(`${s.base}/agent-ops/#/s/${TWIN}/setup/shadow`);
    await ops.waitForSelector(t('launch-start'));
    assert.deepEqual(await ops.locator(`${t('launch-agent')} option`).allTextContents(), ['Ambient Scribe v1.0.0', 'Chart Summariser v1.0.0', 'Inbox Triager v1.1.0', 'Report Drafter v1.2.0', 'Workup Planner v1.1.0']);
    await ops.selectOption(t('launch-agent'), 'inbox-triager');
    // Inside a study the task list also has Library tasks, after the live work items: wait for the messages to load.
    await ops.waitForFunction(() => [...document.querySelectorAll('[data-testid="launch-subject"] option')].some((o) => /Chest symptoms/.test(o.textContent)));
    assert.match(await ops.locator(`${t('launch-subject')} option`).first().textContent(), /Chest symptoms: I have had chest pain/);
    await shot(ops, '01-launcher');
  });

  await step('the patient message was triaged in shadow without anyone asking', async () => {
    await ops.goto(`${s.base}/agent-ops/#/evaluate/history`); // every run, from Settings → All runs
    await ops.waitForSelector(t('runs-table'));
    const all = await runs();
    assert.equal(all.length, 1);
    const row = await ops.textContent(t(`runs-table-row-${all[0].id}`));
    assert.match(row, /Shadow: reacts to live events.*Inbox Triager v1\.1\.0.*Patient message arrived.*completed.*Labelled urgent/s);
  });

  await step('agents page: registry with scopes and policy hash; shadow switches persist', async () => {
    await ops.goto(`${s.base}/agent-ops/#/library/agents`); // Agents live in the Library now
    await ops.waitForSelector(t('agents-table'));
    const row = await ops.textContent(t('agents-table-row-report-drafter'));
    assert.match(row, /Report Drafter.*1\.2\.0.*[a-f0-9]{16}.*DiagnosticReport: create, update.*Built-in rules, offline/s);
    assert.equal(await ops.getAttribute(t('agent-shadow-task-report-drafter'), 'aria-pressed'), 'true');
    await ops.click(t('agent-shadow-task-report-drafter'));
    await ops.waitForSelector(`${t('agent-shadow-task-report-drafter')}[aria-pressed="false"]`);
    assert.equal((await s.store.get('Agent', 'report-drafter')).shadow.task, false);
    await ops.click(t('agent-shadow-task-report-drafter'));
    await ops.waitForSelector(`${t('agent-shadow-task-report-drafter')}[aria-pressed="true"]`);
    await shot(ops, '02-agents');
  });

  await step('task shadow: the radiologist opens a study in PACS; the agent drafts on a hidden branch', async () => {
    await pacs.goto(`${s.base}/pacs/#/study/${xr.id}`);
    await pacs.waitForSelector(t('report-technique'));
    await s.agents.idle();
    const run = (await runs()).find((r) => r.mode === 'shadow-task');
    assert.deepEqual([run.status, run.subject, run.trigger.actor], ['completed', `ImagingStudy/${xr.id}`, 'Dr Reader']);
    assert.equal(await pacs.inputValue(t('report-impression')), '', 'the agent draft is not shown to the radiologist');
    await pacs.reload();
    await pacs.waitForSelector(t('report-technique'));
    assert.equal(await pacs.inputValue(t('report-findings')), '');
    await pacs.fill(t('report-technique'), 'PA chest radiograph.');
    await pacs.fill(t('report-findings'), 'Heart size normal. Lungs clear.');
    await pacs.fill(t('report-impression'), 'No acute cardiopulmonary abnormality.');
    await pacs.click(t('report-sign'));
    await pacs.click(t('sign-report-ok'));
    await pacs.waitForSelector(t('report-status'));
  });

  await step('the clinician triages the same message in the EHR Inbox', async () => {
    await ehr.goto(`${s.base}/ehr/#/inbox`);
    await ehr.waitForSelector(t(`message-triage-${message.id}`));
    assert.equal(await ehr.inputValue(t(`message-triage-${message.id}`)), '', 'the agent label is not shown to the clinician');
    await ehr.selectOption(t(`message-triage-${message.id}`), 'urgent');
    await ehr.waitForFunction((id) => document.querySelector(`[data-testid="message-triage-${id}"]`)?.value === 'urgent', message.id);
    await ehr.click(t('inbox-folder-followups'));
    await ehr.waitForSelector(t('inbox-followups'));
    assert.match(await ehr.textContent(t('inbox-followups')), /Nothing here/, 'triage decisions do not clutter the follow-up folder');
  });

  await step('shadow dashboard: agreement, time and path for each agent, with the first split and both reasonings', async () => {
    await ops.goto(`${s.base}/agent-ops/#/s/${TWIN}/results/shadow`);
    // The old results page opens the study's Results tab; these runs were started by workflow events, outside the study.
    await ops.click(t('results-scope-all'));
    await ops.waitForSelector(t('shadow-agent-report-drafter-1-2-0'));
    assert.match(await ops.textContent(t('shadow-note')), /rule-based proxy.*does not establish clinical correctness or safety/);
    for (const key of ['report-drafter-1-2-0', 'inbox-triager-1-1-0']) {
      assert.equal(await ops.textContent(t(`shadow-runs-${key}`)), '1');
      assert.equal(await ops.textContent(t(`shadow-compared-${key}`)), '1');
      assert.equal(await ops.textContent(t(`shadow-agreement-${key}`)), '100%');
      assert.match(await ops.textContent(t(`shadow-time-${key}`)), /^-[\d.]+ s$/, 'the agent decided sooner than the clinician');
    }
    const run = (await runs()).find((r) => r.mode === 'shadow-task');
    assert.match(await ops.textContent(t(`shadow-case-${run.id}`)), /normal.*normal.*Agree.*Step 2/s);
    await ops.click(t(`shadow-case-${run.id}`));
    await ops.waitForSelector(t(`shadow-detail-${run.id}`));
    const detail = await ops.textContent(t(`shadow-detail-${run.id}`));
    assert.match(detail, /What the agent did.*Read the imaging study.*Read the patient chart.*What the clinician did.*Read the imaging study.*Wrote the report.*Signed the report/s);
    assert.match(detail, /They first went different ways at step 2/);
    assert.equal(await ops.textContent(t(`split-agent-why-${run.id}`)), 'Confirm which patient this study belongs to');
    await shot(ops, '03-shadow');
    await ops.click(t(`shadow-trace-${run.id}`));
    await ops.waitForSelector(t('tv-timeline'));
    await ops.click(t('tv-run'));
    await ops.waitForSelector(t('trace-table'));
    assert.match(await ops.textContent(t('trace-table')), /Run started.*Read imaging study.*Wrote a new report.*I did not analyse the images.*Run ended \(completed\)/s);
    assert.match(await ops.textContent(t('run-branch')), /^shadow-/);
    await shot(ops, '04-trace');
  });

  await step('launcher: start a shadow run by hand and land on its trace', async () => {
    await ops.goto(`${s.base}/agent-ops/#/s/${TWIN}/setup/shadow`);
    await ops.waitForSelector(t('launch-start'));
    await ops.selectOption(t('launch-agent'), 'report-drafter');
    await ops.waitForFunction(() => /CT/.test(document.querySelector('[data-testid="launch-subject"]')?.textContent || ''));
    assert.ok(!(await ops.locator(`${t('launch-subject')} option`).evaluateAll((els) => els.map((e) => e.value))).includes(`ImagingStudy/${xr.id}`), 'a reported study is no longer offered');
    await ops.selectOption(t('launch-subject'), `ImagingStudy/${ct.id}`);
    await ops.click(t('setup-more-open'));
    await ops.selectOption(t('launch-friction'), 'high');
    await ops.click(t('launch-start'));
    await ops.waitForSelector(t('trace-table'));
    const run = (await runs()).find((r) => r.subject === `ImagingStudy/${ct.id}` && r.trigger.kind === 'manual');
    assert.deepEqual([run.status, run.friction, run.trigger.actor], ['completed', 'high', 'Researcher Two']);
    assert.ok(ops.url().endsWith(`#/runs/${run.id}`));
  });

  await step('Stop all agents: one click, the count is shown, nothing can run until released', async () => {
    const hanging = (await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'report-drafter' })).json;
    await ops.goto(`${s.base}/agent-ops/#/evaluate/history`);
    await ops.waitForSelector(t(`run-pause-${hanging.id}`));
    assert.equal(await ops.getAttribute(t('stop-all-agents'), 'title'), '1 running');
    await ops.click(t('stop-all-agents'));
    await ops.waitForSelector(t('stopped-strip'));
    assert.match(await ops.locator(t('toast')).last().textContent(), /All agents stopped\. 1 running run ended\./);
    assert.match(await ops.textContent(t(`run-status-${hanging.id}`)), /stopped by kill switch/);
    assert.equal(await ops.isDisabled(t('stop-all-agents')), true);
    await ops.goto(`${s.base}/agent-ops/#/s/${TWIN}/setup/shadow`);
    await ops.waitForSelector(t('launch-start'));
    const before = (await runs()).length;
    await ops.click(t('launch-start'));
    await ops.waitForSelector(t('toast-error'));
    assert.match(await ops.locator(t('toast-error')).last().textContent(), /kill switch/i);
    assert.equal((await runs()).length, before);
    await shot(ops, '05-stopped');
    await ops.click(t('release-all-agents'));
    await ops.waitForSelector(t('stopped-strip'), { state: 'detached' });
    const audit = (await s.call('GET', '/fhir/R4/AuditEvent')).json.entry.map((e) => e.resource.outcomeDesc).filter((d) => /^kill switch/.test(d));
    assert.deepEqual(audit.sort(), ['kill switch engaged: global', 'kill switch released: global']);
  });

  await step('pause, resume and cancel a run; stop one agent with a reason; register a new agent', async () => {
    const run = (await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'inbox-triager' })).json;
    await ops.goto(`${s.base}/agent-ops/#/evaluate/history`);
    await ops.click(t(`run-pause-${run.id}`));
    await ops.waitForSelector(t(`run-resume-${run.id}`));
    assert.equal(await ops.textContent(t(`run-status-${run.id}`)), 'paused');
    await ops.click(t(`run-resume-${run.id}`));
    await ops.waitForSelector(t(`run-cancel-${run.id}`));
    await ops.click(t(`run-cancel-${run.id}`));
    await ops.waitForFunction((id) => document.querySelector(`[data-testid="run-status-${id}"]`)?.textContent === 'cancelled', run.id);

    await ops.goto(`${s.base}/agent-ops/#/library/agents`); // Agents live in the Library now
    await ops.click(t('agent-kill-inbox-triager'));
    await ops.fill(`${t('kill-reason')} input`, 'Wrong labels on Monday');
    await ops.click(t('kill-reason-submit'));
    await ops.waitForFunction(() => /allow again/.test(document.querySelector('[data-testid="agent-kill-inbox-triager"]')?.textContent || ''));
    assert.equal((await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'inbox-triager' })).status, 403);
    await ops.click(t('mode-kill-shadow-task'));
    await ops.fill(`${t('kill-reason')} input`, 'Pause task shadow');
    await ops.click(t('kill-reason-submit'));
    await ops.waitForFunction(() => /Stopped/.test(document.querySelector('[data-testid="mode-switches-row-shadow-task"]')?.textContent || ''));
    assert.match(await ops.textContent(t('mode-switches-row-shadow-task')), /Pause task shadow/);

    await ops.click(t('agent-register'));
    await ops.waitForSelector(t('agent-form'));
    const fill = async (name, value) => ops.fill(`${t('agent-form')} [name="${name}"]`, value);
    await fill('id', 'second-reader'); await fill('name', 'Second Reader'); await fill('scopes', 'DiagnosticReport: create');
    await ops.click(t('agent-form-submit'));
    await ops.waitForSelector(t('agents-table-row-second-reader'));
    assert.match(await ops.textContent(t('agents-table-row-second-reader')), /Second Reader.*DiagnosticReport: create/s);
    await shot(ops, '06-agents-after');
  });

  await step('accessibility hooks and themes on every Agent Dashboard page', async () => {
    for (const hash of [`#/s/${TWIN}/setup/shadow`, '#/library/agents', '#/evaluate/history', `#/s/${TWIN}/results/shadow`, '#/', '#/evaluate', `#/s/${TWIN}`, '#/library/scenarios', '#/settings']) {
      await ops.goto(`${s.base}/agent-ops/${hash}`);
      await ops.waitForSelector('.topbar');
      await ops.waitForTimeout(400);
      const missing = await ops.evaluate(() => [...document.querySelectorAll('button, input, select, textarea')].filter((el) => !el.dataset.testid || !el.getAttribute('aria-label')).map((el) => el.outerHTML.slice(0, 120)));
      assert.deepEqual(missing, [], `controls without testid and aria-label on ${hash}`);
    }
    assert.equal(await ops.evaluate(() => document.documentElement.dataset.theme), 'light');
    await ops.goto(`${s.base}/agent-ops/#/settings`); await ops.waitForSelector(t('theme-toggle')); // the theme switch is in Settings
    await ops.click(t('theme-toggle'));
    assert.equal(await ops.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.equal(await ops.evaluate(() => localStorage.getItem('hd.theme.agent-ops')), 'dark');
  });

  await step('telemetry from Agent Dashboard carries control ids only', async () => {
    await ops.waitForTimeout(2500);
    const ui = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.filter((x) => x.source === 'ui' && x.did.args.app === 'agent-ops');
    assert.ok(ui.some((x) => x.did.args.target === 'stop-all-agents'));
    const dump = JSON.stringify(ui);
    assert.ok(!dump.includes('Wrong labels on Monday') && !dump.includes('Second Reader'), 'typed text never reaches telemetry');
  });

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
