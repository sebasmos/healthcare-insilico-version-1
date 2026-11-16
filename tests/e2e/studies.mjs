// The Agent Dashboard's front (docs/STUDY-DESIGN.md 9): pill tabs, card grids, the set-up flow, My work,
// and a study's grid. Fixtures are built here at run time, with no names.
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/studies.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTestServer } from '../support/helpers.mjs';
import { res, makeTasks, makePeople } from '../support/study-fixtures.mjs';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch { console.log('SKIPPED: Playwright is not installed. Set PLAYWRIGHT_MODULE to its path to run the browser test.'); process.exit(0); }
const s = await startTestServer({ webRoot: REPO_ROOT });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome' });
const t = (id) => `[data-testid="${id}"]`;
const steps = []; const step = async (name, fn) => { await fn(); steps.push(name); console.log(`ok - ${name}`); };
const errors = [];
const shots = process.env.SHOTS_DIR || null;
const open = async (role, user, hash = '#/') => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(([r, u]) => { localStorage.setItem('hd.role', r); localStorage.setItem('hd.user', u); localStorage.setItem('hd.session', 'in'); }, [role, user]);
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (409|422|423|403)/.test(m.text())) errors.push(m.text()); }); page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${s.base}/agent-ops/${hash}`); await page.waitForSelector(t('pill-tabs'));
  return { context, page };
};
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
try {
  const { set } = await makeTasks(s, 3); const [r1, r2] = await makePeople(s, 2);
  let studyId = null;
  await step('pill tabs and an empty dashboard: each tab opens with its coloured action card', async () => {
    const { context, page } = await open('researcher', 'res-one');
    assert.deepEqual(await page.$$eval(`${t('pill-tabs')} a`, (els) => els.map((e) => e.textContent)), ['Dashboard', 'Evaluate an agent', 'Reinforcement learning', 'Data annotation', 'Surveillance and reporting', 'Time machine', 'Library']);
    assert.equal(await page.getAttribute(t('tab-dashboard'), 'aria-current'), 'page');
    await page.waitForSelector(t('dashboard-empty')); await shot(page, 'dashboard-empty');
    for (const [tab, card, emptyId] of [['evaluate', 'card-new-evaluation', 'evaluate-empty'], ['rl', 'card-new-run', 'rl-empty'], ['annotate', 'card-new-annotation', 'annotate-empty']]) {
      await page.click(t(`tab-${tab}`)); await page.waitForSelector(t(card)); await page.waitForSelector(t(emptyId));
      assert.equal(await page.getAttribute(t(`tab-${tab}`), 'aria-current'), 'page');
      assert.equal(await page.$$eval('.hx-grid > *', (els) => els.length), 0, 'no study cards yet: modes are not separate cards');
      assert.match(await page.textContent(t(card)), /Start a new study/, 'every section starts with the same Start a new study button as the Dashboard');
      const colours = await page.$eval(t(card), (el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).borderTopLeftRadius]);
      assert.notEqual(colours[0], 'rgb(255, 255, 255)'); assert.ok(parseFloat(colours[1]) >= 24, 'rounded pill button');
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
    await shot(page, 'annotate-empty'); await context.close();
  });
  await step('set-up: task set, participants, conditions, order and assignment, review, start', async () => {
    const { context, page } = await open('researcher', 'res-one', '#/evaluate');
    await page.click(t('card-new-evaluation')); await page.waitForSelector(t('setup-step-1'));
    await page.click(t('setup-next')); assert.match(await page.textContent(t('setup-error')), /title/);
    await page.fill(t('setup-title'), 'Planner against readers'); await page.selectOption(t('setup-taskset'), set.id); await page.click(t('setup-next'));
    await page.waitForSelector(t('setup-step-2')); await page.click(t('setup-next')); assert.match(await page.textContent(t('setup-error')), /participant/);
    await page.check(t('setup-agent-workup-planner')); await page.check(t(`setup-person-${r1.id}`)); await page.check(t(`setup-person-${r2.id}`)); await page.click(t('setup-next'));
    await page.waitForSelector(t('setup-step-3')); assert.equal(await page.isChecked(t('setup-condition-autonomous')), true);
    await page.check(t('setup-condition-shadow')); await shot(page, 'setup-conditions'); await page.click(t('setup-next'));
    await page.waitForSelector(t('setup-step-4')); await page.selectOption(t('setup-order'), 'counterbalanced'); await page.selectOption(t('setup-assignment'), 'k'); await page.fill(t('setup-k'), '1'); await page.click(t('setup-next'));
    await page.waitForSelector(t('setup-review')); const review = await page.textContent(t('setup-review'));
    assert.match(review, /Planner against readers/); assert.match(review, /Autonomous, Shadow/); assert.match(review, /1 readers per case/); assert.match(review, /Counterbalanced/);
    await page.click(t('setup-start')); await page.waitForFunction(() => location.hash.startsWith('#/s/'));
    studyId = await page.evaluate(() => location.hash.split('/')[2]);
    await s.studies.idle(studyId);
    const made = (await s.call('GET', `/agent-ops/studies/${studyId}`, undefined, res)).json;
    assert.deepEqual([made.study.status, made.study.attempts, made.study.order, made.study.assignment.mode], ['started', 9, 'counterbalanced', 'k'], '2 conditions x 3 tasks for the agent, 3 tasks shared between two readers');
    await page.goto(`${s.base}/agent-ops/#/evaluate`); await page.waitForSelector(t(`study-card-${studyId}`));
    const card = await page.textContent(t(`study-card-${studyId}`)); assert.match(card, /Autonomous/); assert.match(card, /Shadow/); assert.match(card, /6 of 9 attempts closed/);
    assert.equal(await page.getAttribute(`${t(`study-card-${studyId}`)} [role="progressbar"]`, 'aria-valuenow'), '67');
    await shot(page, 'evaluate-with-study');
    await page.click(t('tab-dashboard')); await page.waitForSelector(t('dashboard-recent')); await page.waitForSelector(t(`study-card-${studyId}`)); await shot(page, 'dashboard');
    await context.close();
  });
  await step('My work: a reader sees the next task, opens it, and "Next task" closes it and opens the next', async () => {
    const mine = await s.studies.queueOf(r1.id); assert.ok(mine.length >= 1);
    const { context, page } = await open('physician', r1.id);
    await page.waitForSelector(t('dash-my-work')); assert.match((await page.textContent(t('dash-my-work'))).trim(), new RegExp(`^${mine.length}My work`));
    await page.click(t('dash-my-work')); await page.waitForSelector(t('work-start')); await page.click(t('work-start'));
    await page.waitForSelector(t('work-open')); assert.match(await page.textContent(t('work-instruction')), /Decide what to order/);
    assert.match(await page.getAttribute(t('work-open-chart'), 'href'), /\/ehr\/\?branch=sandbox-/);
    { const chart = await context.newPage(); await chart.goto(`${s.base}${await page.getAttribute(t('work-open-chart'), 'href')}`); await chart.waitForSelector(`${t('task-strip')}:not([hidden])`);
      assert.match(await chart.textContent(t('task-strip')), /Your task:/); assert.ok(await chart.isVisible(t('task-strip-done')), 'the task and a Done button are on the chart'); await chart.close(); }
    await shot(page, 'my-work-open');
    await page.fill(t('work-why'), 'Enough for now.'); await page.click(t('work-next'));
    if (mine.length > 1) { await page.waitForFunction((id) => !document.querySelector(`[data-testid="work-item-${id}"]`), mine[1].id); await page.waitForSelector(t('work-open')); }
    else await page.waitForSelector(t('work-empty'));
    const after = await s.studies.queueOf(r1.id); assert.equal(after[0].state, 'closed'); if (mine.length > 1) assert.equal(after[1].state, 'open');
    await context.close();
  });
  await step('a study opens as a grid: rows are participants, columns are tasks, a cell opens that attempt\'s trace', async () => {
    const { context, page } = await open('researcher', 'res-one', `#/s/${studyId}`);
    await page.waitForSelector(t('study-grid'));
    assert.equal(await page.$$eval(`${t('study-grid')} tbody tr`, (r) => r.length), 3, 'one agent and two readers');
    assert.equal(await page.$$eval(`${t('study-grid')} thead th[scope="col"]`, (c) => c.length), 3);
    assert.equal((await page.textContent(t('study-status'))).trim(), 'Running');
    const agentCells = await page.$$eval(`${t('study-row-agent-workup-planner')} button`, (b) => b.map((x) => x.dataset.state)); assert.deepEqual(agentCells, ['closed', 'closed', 'closed']);
    await page.selectOption(t('study-condition'), 'shadow'); await page.waitForSelector(t('study-grid'));
    const closedOne = (await s.studies.attemptsOf(studyId)).find((a) => a.participant.kind === 'agent' && a.condition === 'shadow');
    await shot(page, 'study-grid');
    assert.match(await page.getAttribute(t(`cell-${closedOne.id}`), 'aria-label'), /Open the trace/);
    await page.click(t(`cell-${closedOne.id}`)); await page.waitForFunction((rid) => location.hash === `#/trace/${rid}`, closedOne.runId);
    await page.goBack(); await page.waitForSelector(t('study-grid'));
    await page.click(t('study-copy')); await page.waitForSelector(t('study-draft')); assert.equal((await page.textContent(t('study-status'))).trim(), 'Draft');
    await context.close();
  });
  await step('Library: agents and people by default; adding a person shows an invitation code once; search and filters switch to results', async () => {
    const { context, page } = await open('researcher', 'res-one', '#/library');
    await page.waitForSelector(t('library-list'));
    const rows = await page.$$eval(`${t('library-list')} tbody tr`, (trs) => trs.map((r) => r.children[1].textContent));
    assert.ok(rows.includes('Agent') && rows.filter((k) => k === 'Person').length === 2, rows.join());
    assert.match(await page.textContent(t(`library-row-person-${r1.id}`)), /Physician, medicine/);
    await page.click(t('person-add')); await page.fill(t('field-name'), 'Reader 3'); await page.fill(t('field-email'), 'reader-three@example.test'); await page.selectOption(t('field-role'), 'nurse'); await page.click(t('person-form-submit'));
    await page.waitForSelector(t('invite-code')); assert.ok((await page.textContent(t('invite-code'))).trim().length >= 10); await page.click(t('invite-done'));
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="library-list"] tbody tr').length >= 1 && [...document.querySelectorAll('[data-testid="library-list"] tbody tr')].filter((r) => r.children[1].textContent === 'Person').length === 3);
    await shot(page, 'library');
    await page.selectOption(t('filter-mode'), 'shadow'); await page.waitForSelector(t('search-results'));
    assert.match(await page.textContent(t('search-count')), /^3 attempts found/);
    await page.selectOption(t('filter-outcome'), 'pass'); await page.waitForSelector(t('search-empty')); assert.equal((await page.textContent(t('search-empty'))).trim(), 'No data to display');
    await page.selectOption(t('filter-outcome'), ''); await page.selectOption(t('filter-mode'), ''); await page.selectOption(t('filter-study'), studyId); await page.waitForFunction(() => /^9 attempts found/.test(document.querySelector('[data-testid="search-count"]')?.textContent || '')); // each filter change redraws
    assert.match(await page.textContent(t('search-count')), /^9 attempts found/); await shot(page, 'library-search');
    await page.click(t('library-clear')); await page.waitForSelector(t('library-list'));
    await page.fill(t('library-search'), 'Task 2'); await page.click(t('library-search-go')); await page.waitForSelector(t('search-results')); assert.match(await page.textContent(t('search-count')), /^[1-9]\d* attempts? found/);
    await page.click(t('library-clear')); await page.waitForSelector(t('agent-card-workup-planner')); await page.click(t('agent-card-workup-planner'));
    await page.waitForSelector(t('report-card')); assert.equal((await page.textContent(t('card-autonomous-0'))).trim(), '3'); assert.equal((await page.textContent(t('card-hitl-0'))).trim(), '—'); await shot(page, 'report-card');
    await context.close();
  });
  await step('People: email, role, linked patient, status, last sign-in and studies; a link can be revoked; the sign-in log is shown', async () => {
    const { context, page } = await open('researcher', 'res-one', '#/people');
    await page.waitForSelector(t('people-table'));
    const row = await page.textContent(t(`people-row-${r1.id}`)); assert.match(row, /example\.test/); assert.match(row, /Physician/); assert.match(row, /Planner against readers/, 'the studies the person is in');
    const invited = (await s.call('GET', '/agent-ops/people', undefined, res)).json.people.find((p) => p.email === 'reader-three@example.test');
    await page.click(t(`person-revoke-${invited.id}`)); await page.waitForFunction((id) => document.querySelector(`[data-testid="people-status-${id}"]`)?.textContent === 'Off', invited.id);
    await page.click(t(`person-invite-${invited.id}`)); await page.waitForSelector(t('invite-link')); assert.match(await page.textContent(t('invite-link')), /\/#invite=[A-Za-z0-9_-]{20,}$/); await page.click(t('invite-done'));
    await page.waitForSelector(t('signin-log')); await shot(page, 'people');
    await context.close();
  });
  await step('Surveillance tab: the always-on status card with counts comes first, then signals and reports', async () => {
    const { context, page } = await open('researcher', 'res-one', '#/surveillance');
    await page.waitForSelector(t('surv-status')); await page.waitForSelector(t('surv-tabs'));
    assert.equal(await page.getAttribute(t('tab-surveillance'), 'aria-current'), 'page');
    for (const id of ['reports', 'open', 'overdue', 'signals', 'watches']) assert.equal((await page.textContent(t(`surv-count-${id}`))).trim(), '0');
    assert.ok(await page.evaluate(() => { const a = document.querySelector('[data-testid="surv-status"]').getBoundingClientRect(); const b = document.querySelector('[data-testid="surv-tabs"]').getBoundingClientRect(); return a.bottom <= b.top; }), 'the status card is above the signals and reports');
    await shot(page, 'surveillance'); await context.close();
  });
  await step('Reinforcement learning: a run launched from the dashboard appears as a card and opens to its attempts; expert grades are given from the queue', async () => {
    const train = await makeTasks(s, 2, { split: 'train' });
    const { context, page } = await open('researcher', 'res-one', '#/rl');
    await page.click(t('card-new-run')); await page.fill(t('field-name'), 'desk-run-1'); await page.selectOption(t('field-agentid'), 'workup-planner'); await page.selectOption(t('field-taskset'), train.set.id); await page.click(t('run-form-submit'));
    const run = (await s.call('GET', '/agent-ops/training-runs', undefined, res)).json.runs.find((r) => r.name === 'desk-run-1') || { id: null };
    const runs = async () => (await s.call('GET', '/agent-ops/training-runs', undefined, res)).json.runs;
    for (let i = 0; i < 50 && !(await runs()).some((r) => r.name === 'desk-run-1' && r.status === 'finished'); i += 1) await page.waitForTimeout(200);
    const done = (await runs()).find((r) => r.name === 'desk-run-1'); assert.deepEqual([done.attempts, done.tags, done.status], [2, ['Dashboard'], 'finished']); void run;
    await page.goto(`${s.base}/agent-ops/#/rl`); await page.waitForSelector(t(`run-card-${done.id}`)); assert.match(await page.textContent(t(`run-card-${done.id}`)), /Dashboard/); await shot(page, 'rl');
    await page.click(t(`run-card-${done.id}`)); await page.waitForSelector(t('run-attempts')); assert.equal(await page.$$eval(`${t('run-attempts')} tbody tr`, (r) => r.length), 2);
    // The report card says plainly when a study used train tasks, and training runs have their own learning-curve view.
    const trainStudy = (await s.call('POST', '/agent-ops/studies', { title: 'On train tasks', taskSet: train.set.id, participants: [{ kind: 'agent', id: 'workup-planner' }], conditions: ['autonomous'] }, res)).json;
    await s.call('POST', `/agent-ops/studies/${trainStudy.id}/start`, {}, res); await s.studies.idle(trainStudy.id);
    await page.goto(`${s.base}/agent-ops/#/report/workup-planner`); await page.waitForSelector(t('card-train-note'));
    assert.match(await page.textContent(t('card-train-note')), /2 attempts in "On train tasks" were on train or validation tasks/); await shot(page, 'report-card-train-note');
    await page.click(t('card-curves')); await page.waitForSelector(t(`curve-${done.id}`));
    assert.equal(await page.locator(`${t(`curve-${done.id}`)} svg circle`).count(), 2, 'one point per part of the run'); assert.match(await page.getAttribute(`${t(`curve-${done.id}`)} svg`, 'aria-label'), /Task success over the run desk-run-1/);
    assert.equal(await page.locator(`${t(`curve-table-${done.id}`)} tbody tr`).count(), 2); assert.match(await page.textContent(t('curve-note')), /not how good the agent is/); await shot(page, 'learning-curves');
    await page.goto(`${s.base}/agent-ops/#/grade`); await page.waitForFunction(() => document.querySelectorAll('[data-testid^="grade-item-"]').length > 0);
    const first = await page.$eval('[data-testid^="grade-item-"]', (el) => el.dataset.testid.replace('grade-item-', ''));
    await page.fill(t(`grade-${first}-reasoning-is-sound`), '4'); await page.click(t(`grade-save-${first}`));
    await page.waitForFunction((id) => !document.querySelector(`[data-testid="grade-item-${id}"]`), first);
    assert.equal((await s.studies.getAttempt(first)).scores.expertGrade.value, 0.75);
    await context.close();
  });
  await step('a patient has only My work in the Agent Dashboard', async () => {
    const { context, page } = await open('patient', 'someone', '#/evaluate');
    await page.waitForSelector(t('tabpage-dashboard'));
    assert.deepEqual(await page.$$eval(`${t('pill-tabs')} a`, (els) => els.map((e) => e.textContent)), ['Dashboard']);
    assert.equal((await s.call('GET', '/agent-ops/studies', undefined, { 'X-Role': 'patient' })).status, 403);
    await context.close();
  });
  await step('Delete study: the dialog shows the counts, and after confirming the study is gone; Clear all test data is on the People page', async () => {
    const { context, page } = await open('researcher', 'res-one', `#/s/${studyId}`);
    await page.click(t('study-delete')); await page.waitForSelector(t('delete-dialog'));
    assert.match(await page.textContent(t('delete-counts')), /attempts/); assert.match(await page.textContent(t('delete-counts')), /branches/);
    await page.click(t('delete-confirm')); await page.waitForFunction(() => !location.hash.startsWith('#/s/'));
    assert.equal(await s.store.get('EvalStudy', studyId), null);
    await page.goto(`${s.base}/agent-ops/#/people`); await page.click(t('clear-all')); await page.waitForSelector(t('delete-dialog')); assert.match(await page.textContent(t('delete-dialog')), /Patients, the main chart, agents and the Library are kept/); await page.click(t('delete-cancel'));
    await context.close();
  });
  assert.deepEqual(errors, []);
} finally { await browser.close(); await s.close(); }
console.log(`${steps.length} browser steps passed. Console errors: 0.`);
