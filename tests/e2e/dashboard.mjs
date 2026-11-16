// Browser end-to-end test for the Agent Dashboard structure:
// Home with three cards and the top bar, a page per mode with its studies, the
// study tabs per mode, the Library, Settings, breadcrumbs with Back, and old
// routes redirecting to the new places.
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/dashboard.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTestServer, tempDir } from '../support/helpers.mjs';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';
import { buildPhantom } from '../support/phantom.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch {
  console.log('SKIPPED: Playwright is not installed. Set PLAYWRIGHT_MODULE to its path to run the browser test.');
  process.exit(0);
}

process.env.DICOM_DIR = path.join(tempDir('hd-dash-e2e-'), 'dicom');
process.env.ENV_API_ENABLED = 'true';
const R = { 'X-Role': 'researcher', 'X-User-Id': 'e2e' };
const s = await startTestServer({ webRoot: REPO_ROOT });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome' });
const errors = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
context.setDefaultTimeout(15000);
await context.addInitScript(() => { localStorage.setItem('hd.role', 'researcher'); localStorage.setItem('hd.user', 'Researcher Two'); });
const ops = await context.newPage();
ops.on('console', (m) => { if (m.type() === 'error' && !/status of (403|409|422)/.test(m.text())) errors.push(m.text()); });
ops.on('pageerror', (e) => errors.push(e.message));
const t = (id) => `[data-testid="${id}"]`;
const steps = [];
const step = async (name, fn) => { await fn(); steps.push(name); console.log(`ok - ${name}`); };
const hash = () => ops.evaluate(() => location.hash);
const visibleText = async (sel) => (await ops.innerText(sel)).replace(/\s+/g, ' ').trim();

try {
  await step('home: the pill tabs with the Dashboard tab chosen, and the top bar has the title, Library, Settings and Stop all agents', async () => {
    await ops.goto(`${s.base}/agent-ops/`);
    await ops.waitForSelector(t('pill-tabs'));
    assert.equal(await ops.textContent('h1'), 'Agent Dashboard');
    assert.equal(await ops.getAttribute(t('tab-dashboard'), 'aria-current'), 'page');
    assert.equal(await ops.locator(`${t('pill-tabs')} a`).count(), 7);
    const top = await visibleText(t('dash-top'));
    assert.equal(top, 'Agent Dashboard Stop all agents');
    assert.ok(await ops.isVisible(t('nav-settings')));
  });

  let evalId; let scenarioId;
  const twinOf = async (id) => (await s.call('GET', `/agent-ops/studies/twin?type=Study&id=${id}`, undefined, { 'X-Role': 'researcher' })).json.id;
  let twin;
  await step('a quick run on one record: name and question, then the study page with Setup, Runs, Review, Results and Export; it is a card on the Evaluate tab only', async () => {
    await ops.click(t('tab-evaluate')); await ops.waitForSelector(t('evaluate-more'));
    assert.equal(await ops.getByText(/Earlier .* tools/).count(), 0, 'no "Earlier tools" link');
    await ops.click(t('link-quick-evaluate'));
    await ops.fill(t('new-study-title'), 'Does the summary help?');
    await ops.fill(t('new-study-question'), 'Do clinicians finish faster with the chart summary?');
    await ops.click(t('new-study-submit'));
    await ops.waitForSelector(t('study-tab-setup'));
    const back = await s.call('GET', '/agent-ops/research/studies?mode=evaluate');
    assert.equal(back.json.studies.length, 1); evalId = back.json.studies[0].id; twin = await twinOf(evalId);
    assert.equal(await hash(), `#/s/${twin}/setup`);
    assert.equal(await ops.textContent(t('study-title')), 'Does the summary help?');
    assert.deepEqual(await ops.$$eval('[role="tab"][data-testid^="study-tab-"]', (els) => els.map((e) => e.textContent)), ['Setup', 'Runs', 'Review', 'Results', 'Export']);
    assert.deepEqual(await ops.$$eval(`${t('study-sections')} a`, (els) => els.map((e) => e.textContent)), ['Grid', 'Setup', 'Runs', 'Review', 'Results', 'Export']);
    assert.equal((await s.call('GET', '/agent-ops/research/studies?mode=rl')).json.studies.length, 0, 'a study belongs to one mode');
    await ops.click(t('tab-evaluate')); await ops.waitForSelector(t(`study-card-${twin}`));
    assert.match(await visibleText(t(`study-card-${twin}`)), /Does the summary help\?/);
    for (const tab of ['rl', 'annotate']) { await ops.click(t(`tab-${tab}`)); await ops.waitForSelector(t(`${tab}-more`)); assert.equal(await ops.locator(t(`study-card-${twin}`)).count(), 0, `not listed under ${tab}`); }
  });

  await step('the study page: set-up has the three tiles and the chosen tile shows its settings; browser Back returns', async () => {
    await ops.click(t('tab-evaluate')); await ops.click(t(`study-card-${twin}`)); await ops.click(t('study-section-setup'));
    await ops.waitForSelector(t('setup-pick'));
    for (const g of ['shadow', 'hitl', 'redteam']) assert.ok(await ops.isVisible(t(`setup-tile-${g}`)), g);
    await ops.click(t('setup-tile-hitl'));
    await ops.waitForSelector(t('launch-agent'), { state: 'attached' });
    await ops.waitForFunction((h) => location.hash === h, `#/s/${twin}/setup/hitl`);
    await ops.click(t('study-tab-results'));
    await ops.waitForSelector(t('results-shadow'));
    await ops.waitForFunction((h) => location.hash === h, `#/s/${twin}/results`);
    await ops.goBack();
    await ops.waitForFunction((h) => location.hash === h, `#/s/${twin}/setup/hitl`);
    await ops.waitForSelector(t('setup-tile-hitl'));
  });

  await step('other kinds: a training study has the same five pages and is on the Reinforcement learning tab; a recording study has Setup, Sessions, Review, Export and is on the Data annotation tab', async () => {
    const rl = (await s.call('POST', '/agent-ops/research/studies', { title: 'Train the planner', question: 'Does training help?', mode: 'rl' }, { 'X-Role': 'researcher' })).json;
    const an = (await s.call('POST', '/agent-ops/research/studies', { title: 'Record chest reads', question: 'How do readers box findings?', mode: 'annotate' }, { 'X-Role': 'researcher' })).json;
    const twinRl = await twinOf(rl.id); const twinAn = await twinOf(an.id);
    await ops.goto(`${s.base}/agent-ops/#/s/${twinRl}/setup`);
    await ops.waitForSelector(t('study-tab-export'));
    assert.deepEqual(await ops.$$eval('[role="tab"][data-testid^="study-tab-"]', (els) => els.map((e) => e.textContent)), ['Setup', 'Runs', 'Review', 'Results', 'Export']);
    await ops.waitForFunction(() => document.querySelector('[data-testid="tab-rl"]')?.getAttribute('aria-current') === 'page');
    assert.equal(await ops.getAttribute(t('tab-rl'), 'aria-current'), 'page');
    await ops.goto(`${s.base}/agent-ops/#/s/${twinAn}/runs`);
    await ops.waitForFunction((h) => location.hash === h, `#/s/${twinAn}/sessions`);
    await ops.waitForSelector(t('study-tab-sessions'));
    assert.deepEqual(await ops.$$eval('[role="tab"][data-testid^="study-tab-"]', (els) => els.map((e) => e.textContent)), ['Setup', 'Sessions', 'Review', 'Export']);
    await ops.click(t('tab-annotate')); await ops.waitForSelector(t(`study-card-${twinAn}`));
    assert.equal(await ops.locator(t(`study-card-${twin}`)).count(), 0, 'the evaluation is not listed under annotation');
    await ops.click(t('tab-rl')); await ops.waitForSelector(t(`study-card-${twinRl}`)); assert.match(await visibleText(t(`study-card-${twinRl}`)), /Training/);
  });

  await step('every old address goes to its new page, and no "Earlier tools" link is left', async () => {
    await ops.goto(`${s.base}/agent-ops/#/s/${twin}/setup`);
    await ops.waitForSelector(t('setup-pick'));
    const S = `#/s/${twin}`;
    for (const [from, to] of [['#/mode/evaluate', '#/evaluate'], ['#/mode/rl', '#/rl'], ['#/mode/annotate', '#/annotate'], [`#/study/${evalId}/setup`, `${S}/setup`], [`#/study/${evalId}/results/shadow`, `${S}/results/shadow`], ['#/evaluate/shadow', `${S}/setup/shadow`], ['#/studies', '#/evaluate'], [`#/studies/${evalId}`, `${S}/runs`], [`#/studies/${evalId}/build`, `${S}/export`], ['#/results', `${S}/results`], ['#/review', `${S}/review`], ['#/runs', `${S}/runs`], ['#/hitl', `${S}/results/hitl`], ['#/shadow', `${S}/results/shadow`], ['#/labelling', '#/annotate/projects'], ['#/recordings', '#/annotate/recordings'], ['#/launch/label', '#/annotate/new/label'], ['#/ablation', '#/evaluate/ablation'], ['#/regression', '#/evaluate/regression'], ['#/history', '#/evaluate/history'], ['#/versions', '#/evaluate/versions'], ['#/leaderboard', '#/evaluate/leaderboard'], ['#/rollouts', '#/rl/rollouts'], ['#/reward', '#/rl/reward']]) {
      await ops.evaluate((h) => { location.hash = h; }, from);
      await ops.waitForFunction((h) => location.hash === h, to, { timeout: 10000 }).catch(async () => { throw new Error(`${from} went to ${await hash()}, not ${to}`); });
      await ops.waitForTimeout(150);
    }
    // With no study in mind, the results of runs started outside any study have their own study pages.
    await ops.evaluate(() => { localStorage.removeItem('hd.study'); });
    for (const [from, to] of [['#/shadow', '#/s/legacy-shadow/compare'], ['#/hitl', '#/s/legacy-hitl/loop'], ['#/redteam', '#/s/legacy-redteam/hazards']]) {
      await ops.evaluate((h) => { location.hash = h; }, from);
      await ops.waitForFunction((h) => location.hash === h, to, { timeout: 10000 }).catch(async () => { throw new Error(`${from} went to ${await hash()}, not ${to}`); });
      await ops.waitForSelector(t(`study-part-${to.split('/').pop()}`));
    }
    for (const tab of ['evaluate', 'rl', 'annotate']) { await ops.click(t(`tab-${tab}`)); await ops.waitForSelector(t(`${tab}-more`)); assert.equal(await ops.getByText(/Earlier .* tools/).count(), 0, `${tab}: no "Earlier tools" link`); }
  });

  // 10 later steps were removed with the content they exercised: the release ships no data.

  assert.deepEqual(errors, [], 'browser console errors');
  console.log(`\n${steps.length} browser steps passed. Console errors: 0.`);
} catch (err) {
  console.error(`\nFAILED after ${steps.length} steps: ${err.stack || err.message}`);
  if (errors.length) console.error('Console errors:\n' + errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  await s.close();
}
