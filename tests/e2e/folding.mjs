// Earlier screens folded into studies: the human-in-the-loop proposal cards in My work, marking spans in a note,
// red-team hazards in the study grid, and a study brought over from an earlier screen.
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/folding.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { startTestServer, patient } from '../support/helpers.mjs';
import { res, makeTasks, makePeople, makeReportTasks } from '../support/study-fixtures.mjs';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch { console.log('SKIPPED: Playwright is not installed. Set PLAYWRIGHT_MODULE to its path to run the browser test.'); process.exit(0); }
const s = await startTestServer({ webRoot: REPO_ROOT });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome' });
const t = (id) => `[data-testid="${id}"]`;
const steps = []; const step = async (name, fn) => { await fn(); steps.push(name); console.log(`ok - ${name}`); };
const errors = []; const shots = process.env.SHOTS_DIR || null;
const open = async (role, user, hash) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(([r, u]) => { localStorage.setItem('hd.role', r); localStorage.setItem('hd.user', u); localStorage.setItem('hd.session', 'in'); }, [role, user]);
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (409|422|423|403)/.test(m.text())) errors.push(m.text()); }); page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${s.base}/agent-ops/${hash}`); await page.waitForSelector(t('pill-tabs'));
  return { context, page };
};
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
const start = async (body) => { const st = (await s.call('POST', '/agent-ops/studies', body, res)).json; assert.ok(st.id, JSON.stringify(st)); const r = await s.call('POST', `/agent-ops/studies/${st.id}/start`, {}, res); assert.equal(r.status, 200, r.text); return st.id; };
try {
  const [r1] = await makePeople(s, 1);
  await step('human in the loop in My work: the proposal card is edited (the change is shown), rejected with a reason, and accepted', async () => {
    const films = await makeReportTasks(s, 3);
    const id = await start({ title: 'Report loop', taskSet: films.set.id, participants: [{ kind: 'agent', id: 'report-drafter' }, { kind: 'person', id: r1.id }], conditions: ['hitl'], humanBaseline: false });
    const { context, page } = await open('physician', r1.id, '#/my-work');
    await page.click(t('work-start')); await page.waitForSelector('[data-testid^="proposal-accept-"]');
    const pid = async () => page.$eval('[data-testid^="proposal-accept-"]', (el) => el.dataset.testid.replace('proposal-accept-', ''));
    let p = await pid(); assert.match(await page.textContent(t(`proposal-${p}`)), /Proposed by/); await shot(page, 'proposal-card');
    // Edit: the fields open, the saved version shows what changed.
    await page.click(t(`proposal-editbtn-${p}`)); const box = t(`proposal-edit-${p}-impression`); await page.waitForSelector(box);
    await page.fill(box, `${await page.inputValue(box)} Follow-up film in six weeks.`); await page.click(t(`proposal-editbtn-${p}`));
    await page.waitForSelector(t(`proposal-diff-${p}`)); assert.match(await page.textContent(t(`proposal-status-${p}`)), /Edited by you/); assert.match(await page.textContent(t(`proposal-diff-${p}`)), /impression \(\d+ characters\)/); await shot(page, 'proposal-edited');
    await page.click(t('work-next'));
    // Reject: a reason is required.
    await page.waitForFunction((old) => { const el = document.querySelector('[data-testid^="proposal-accept-"]'); return el && !el.dataset.testid.endsWith(old); }, p); p = await pid();
    await page.click(t(`proposal-reject-${p}`)); assert.equal(await page.locator(t(`proposal-status-${p}`)).count(), 0, 'not rejected without a reason');
    await page.fill(t(`proposal-reason-${p}`), 'The film shows a clear effusion.'); await page.click(t(`proposal-reject-${p}`));
    await page.waitForSelector(t(`proposal-status-${p}`)); assert.match(await page.textContent(t(`proposal-status-${p}`)), /Rejected.*clear effusion/);
    await page.click(t('work-next'));
    // Accept.
    await page.waitForFunction((old) => { const el = document.querySelector('[data-testid^="proposal-accept-"]'); return el && !el.dataset.testid.endsWith(old); }, p); p = await pid();
    await page.click(t(`proposal-accept-${p}`)); await page.waitForSelector(t(`proposal-status-${p}`)); assert.match(await page.textContent(t(`proposal-status-${p}`)), /Accepted/);
    await page.click(t('work-next')); await page.waitForSelector(t('work-empty'));
    const done = await s.studies.attemptsOf(id); assert.ok(done.every((a) => a.state === 'closed'));
    const kinds = (await s.store.query('TraceStep', { groupKey: done[0].runId })).map((x) => `${x.who.kind}:${x.did.type}`);
    assert.ok(kinds.some((k) => k.startsWith('agent:')) && kinds.some((k) => k === 'human:proposal.edit'), `agent and person in one trace: ${kinds.join(' ')}`);
    await context.close();
  });
  await step('marking words in a note: select, label, add; the spans are the answer handed in with Next task', async () => {
    const p = (await s.call('POST', '/fhir/R4/Patient', patient())).json; const text = 'Cough for three days. No fever. Mild wheeze on the left.';
    const note = await s.call('POST', '/fhir/R4/DocumentReference', { resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', type: { text: 'Clinic note' }, subject: { reference: `Patient/${p.id}` }, content: [{ attachment: { contentType: 'text/plain', data: Buffer.from(text).toString('base64') } }] });
    assert.equal(note.status, 201, note.text);
    const c = await s.call('POST', '/agent-ops/cases', { patient: `Patient/${p.id}`, subject: `DocumentReference/${note.json.id}`, title: 'Mark symptoms', scenario: 'A clinic note.', task: 'Mark every symptom.', split: 'eval', goldActions: [{ type: 'order', code: 'LOINC:2160-0', label: 'none' }] }, res); assert.equal(c.status, 201, c.text);
    const set = (await s.call('POST', '/agent-ops/task-sets', { name: 'Notes', tasks: [{ taskId: c.json.id }] }, res)).json;
    const id = await start({ title: 'Symptom spans', kind: 'annotation', labelScheme: { type: 'spans', labels: ['symptom', 'negated'] }, taskSet: set.id, participants: [{ kind: 'person', id: r1.id }] });
    const { context, page } = await open('physician', r1.id, '#/my-work');
    await page.click(t('work-start')); await page.waitForSelector(t('span-text')); assert.equal(await page.textContent(t('span-text')), text);
    const select = (from, to) => page.evaluate(([a, b]) => { const node = document.querySelector('[data-testid="span-text"]').firstChild; const r = document.createRange(); r.setStart(node, a); r.setEnd(node, b); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); }, [from, to]);
    await page.click(t('span-add')); assert.equal(await page.locator(`${t('span-list')} li`).count(), 0, 'nothing is added without a selection');
    await select(0, 5); await page.click(t('span-add'));
    await select(22, 30); await page.selectOption(t('span-label'), 'negated'); await page.click(t('span-add'));
    await select(text.indexOf('wheeze'), text.indexOf('wheeze') + 6); await page.selectOption(t('span-label'), 'symptom'); await page.click(t('span-add'));
    assert.deepEqual(await page.$$eval(`${t('span-list')} li`, (li) => li.map((x) => x.textContent.replace(/\s*Remove\s*$/, '').trim())), ['symptom: "Cough"', 'negated: "No fever"', 'symptom: "wheeze"']); await shot(page, 'spans');
    await page.click(t('work-next')); await page.waitForSelector(t('work-empty'));
    const [a] = await s.studies.attemptsOf(id); assert.deepEqual(a.answer.spans, [{ start: 0, end: 5, label: 'symptom' }, { start: 22, end: 30, label: 'negated' }, { start: 37, end: 43, label: 'symptom' }]); assert.equal(a.answer.mask.length, 19);
    await context.close();
  });
  await step('red team in the grid: the cell counts hazards passed, and opens the list with each hazard\'s result and trace', async () => {
    const { set } = await makeTasks(s, 1);
    const id = await start({ title: 'Hazards', taskSet: set.id, participants: [{ kind: 'agent', id: 'workup-planner' }], conditions: ['redteam'] }); await s.studies.idle(id);
    const [a] = await s.studies.attemptsOf(id); const hz = a.scores.hazards;
    const { context, page } = await open('researcher', 'res-one', `#/s/${id}`);
    await page.waitForSelector(t(`cell-${a.id}`)); assert.equal((await page.textContent(t(`cell-${a.id}`))).trim(), `${hz.filter((h) => h.pass).length}/${hz.length}`);
    await page.click(t(`cell-${a.id}`)); await page.waitForSelector(t('hazard-list')); assert.equal(await page.locator(`${t('hazard-list')} tbody tr`).count(), hz.length);
    assert.match(await page.textContent(t('hazard-list')), /Pass|Fail/); await shot(page, 'hazards');
    await page.click(t(`hazard-trace-${hz[0].test}`)); await page.waitForFunction((rid) => location.hash === `#/trace/${rid}`, hz[0].runId);
    await context.close();
  });
  await step('work from an earlier screen shows as a study: a reader study by case, opened from the Evaluate tab', async () => {
    const old = randomUUID();
    await s.store.transaction(async (tx) => { await tx.save('Study', { resourceType: 'Study', id: old, title: 'Chest readers', status: 'active', kind: 'multi-reader' }, { updatedBy: 'test' }); for (const [reader, c, correct] of [['reader-a', 'case-1', true], ['reader-b', 'case-1', false], ['reader-a', 'case-2', true]]) await tx.save('ReaderAnswer', { resourceType: 'ReaderAnswer', id: randomUUID(), study: old, reader, case: c, answer: correct ? 'abnormal' : 'normal', correct, seconds: 30 }, { updatedBy: 'test' }); });
    assert.equal((await s.call('POST', '/agent-ops/studies/migrate', {}, res)).json.readerAnswers, 3);
    const { context, page } = await open('researcher', 'res-one', '#/evaluate');
    const card = page.locator('.hx-card', { hasText: 'Chest readers' }); await card.waitFor(); assert.match(await card.textContent(), /Reader study/); await card.click();
    await page.waitForSelector(t('study-grid')); assert.deepEqual(await page.$$eval(`${t('study-grid')} thead th[scope="col"]`, (c) => c.map((x) => x.textContent)), ['case-1', 'case-2']);
    assert.equal(await page.locator(`${t('study-grid')} tbody tr`).count(), 2); assert.equal(await page.locator(`${t('study-grid')} button.pass`).count(), 2); assert.equal(await page.locator(`${t('study-grid')} button.fail`).count(), 1);
    assert.match(await page.textContent(t('study-progress')), /brought over from an earlier screen/);
    await page.waitForSelector(t('study-agreement')); assert.match(await page.textContent(t('study-agreement')), /Agreement between readers/); assert.match(await page.textContent(t('agreement-cases')), /case-1\s*2\s*0%/, 'the two readers of case-1 disagreed'); assert.equal(await page.locator(t('study-stop')).count(), 0); await shot(page, 'legacy-grid');
    await context.close();
  });
  await step('side by side on the study page: the agent against a person on the same task, with the first divergence', async () => {
    const { tasks, set, patient: p } = await makeTasks(s, 1);
    const id = await start({ title: 'Versus', taskSet: set.id, participants: [{ kind: 'agent', id: 'workup-planner' }, { kind: 'person', id: r1.id }], conditions: ['shadow'] }); await s.studies.idle(id);
    const mine = (await s.studies.queueOf(r1.id)).find((x) => x.study === id); const as1 = { 'X-Role': 'physician', 'X-User-Id': r1.id };
    const o = (await s.call('POST', `/agent-ops/attempts/${mine.id}/open`, {}, as1)).json; const [, code] = tasks[0].goldActions[0].code.split(':');
    await s.call('POST', `/fhir/R4/ServiceRequest?_branch=${o.branch}`, { resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: `Patient/${p.id}` }, code: { coding: [{ system: 'http://loinc.org', code }], text: 'Creatinine' }, category: [{ coding: [{ code: 'laboratory' }] }] }, as1);
    await s.call('POST', `/agent-ops/attempts/${mine.id}/next`, {}, as1);
    const { context, page } = await open('researcher', 'res-one', `#/s/${id}`);
    await page.waitForSelector(t('compare-table')); assert.match(await page.textContent(t('compare-table')), /Step \d+: agent ".+", person ".+"/);
    await page.click('[data-testid^="compare-open-"]'); await page.waitForSelector(t('compare-side-by-side')); assert.match(await page.textContent(t('compare-split')), /They part at step \d+/);
    assert.equal(await page.locator(`${t('compare-side-by-side')} ol`).count(), 2); await shot(page, 'side-by-side'); await page.click(t('compare-close'));
    await context.close();
  });
  await step('an earlier study has its pages under the new study page: set-up, runs, review, results and export', async () => {
    const made = await s.call('POST', '/agent-ops/research/studies', { title: 'Earlier evaluation', question: 'Does it help?', mode: 'evaluate' }, res); assert.ok(made.json?.id || made.json?.study?.id, made.text);
    const oldId = made.json.id || made.json.study.id;
    const twin = (await s.call('GET', `/agent-ops/studies/twin?type=Study&id=${oldId}`, undefined, res)).json.id;
    const { context, page } = await open('researcher', 'res-one', '#/evaluate');
    const card = page.locator('.hx-card', { hasText: 'Earlier evaluation' }); await card.waitFor(); await card.click();
    await page.waitForSelector(t('study-sections')); assert.deepEqual(await page.$$eval(`${t('study-sections')} a`, (els) => els.map((e) => e.textContent)), ['Grid', 'Setup', 'Runs', 'Review', 'Results', 'Export']);
    await page.click(t('study-section-setup')); await page.waitForSelector(t('setup-pick')); assert.equal(await page.evaluate(() => location.hash), `#/s/${twin}/setup`);
    for (const tile of ['shadow', 'hitl', 'redteam']) assert.ok(await page.isVisible(t(`setup-tile-${tile}`)), `${tile} can be started from the study page`);
    await page.click(t('study-section-results')); await page.waitForSelector(t('study-panel-results')); await page.click(t('study-section-export')); await page.waitForSelector(t('study-panel-export'));
    await shot(page, 'earlier-study'); await context.close();
  });
  assert.deepEqual(errors, []);
} finally { await browser.close(); await s.close(); }
console.log(`${steps.length} browser steps passed. Console errors: 0.`);
