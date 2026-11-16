// Browser end-to-end test for Data Annotation: recording a clinician across
// apps (indicator, think-aloud, "why?" prompt, deletion) and labelling
// (project, blind double-read workbench, agreement, adjudication, export).
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/annotation.mjs
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

const work = tempDir('hd-ann-e2e-');
process.env.DICOM_DIR = path.join(work, 'dicom');
const s = await startTestServer({ webRoot: REPO_ROOT });

// The Agent Dashboard organises work into studies: the old launcher routes open the current study's Setup.
const STUDY = (await s.call('POST', '/agent-ops/research/studies', { title: 'Browser test study', question: 'Does the launcher still work inside a study?', mode: 'annotate' }, { 'X-Role': 'researcher', 'X-User-Id': 'e2e' })).json.id;
const twinOf = async (type, id) => (await s.call('GET', `/agent-ops/studies/twin?type=${type}&id=${id}`, undefined, { 'X-Role': 'researcher' })).json.id; // the study page that holds an earlier study's or project's tools
const TWIN = await twinOf('Study', STUDY);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome' });
const errors = [];
const watch = (page) => {
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (403|404|409|422|423)/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  if (process.env.E2E_DEBUG) { page.on('console', (m) => console.log('  [console]', m.type(), m.text())); page.on('response', (r) => { if (r.url().includes('/capture')) console.log('  [http]', r.request().method(), r.status(), r.url().split('/agent-ops')[1]); }); }
};
// Each person is a separate browser profile with their own name in "Work as".
const person = async (name, role = 'physician') => {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  context.setDefaultTimeout(15000);
  await context.addInitScript(([n, r, sid]) => { localStorage.setItem('hd.role', r); localStorage.setItem('hd.user', n); localStorage.setItem('hd.study', sid); }, [name, role, STUDY]);
  return context;
};
const shots = process.env.E2E_SHOTS ? tempDir('hd-ann-shots-') : null;
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true }); };
const t = (id) => `[data-testid="${id}"]`;
const steps = [];
const step = async (name, fn) => { await fn(); steps.push(name); console.log(`ok - ${name}`); };
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const trace = async (runId) => (await s.call('GET', `/agent-ops/trace?runId=${runId}`)).json.steps;

try {
  const patient = (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', name: [{ family: 'Zzlabel', given: ['Test'] }], birthDate: '1958-05-05', gender: 'female' })).json;
  await s.call('PUT', '/api/friction', { level: 'low' });
  const mrn = patient.identifier.find((i) => i.type.coding[0].code === 'MR').value;
  const notes = ['Chest clear. No acute findings.', 'Right lower lobe consolidation, likely pneumonia.', 'Mrs Zzlabel has no pleural effusion. Plan: repeat film in six weeks.'];
  for (const [i, text] of notes.entries()) {
    await s.call('POST', '/fhir/R4/DocumentReference', { resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', subject: { reference: `Patient/${patient.id}` }, date: `2026-02-0${i + 1}T10:00:00.000Z`,
      type: { coding: [{ system: 'http://loinc.org', code: '11506-3', display: 'Progress note' }] }, content: [{ attachment: { contentType: 'text/plain', data: b64(text) } }] });
  }
  const files = buildPhantom({ mrn, name: 'Zzlabel^Test' });
  const boundary = 'b-e2e';
  const body = Buffer.concat([...files.flatMap((f) => [Buffer.from(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`), Buffer.from(f.bytes), Buffer.from('\r\n')]), Buffer.from(`--${boundary}--\r\n`)]);
  assert.equal((await fetch(`${s.base}/dicom-web/studies`, { method: 'POST', headers: { 'Content-Type': `multipart/related; type="application/dicom"; boundary=${boundary}`, 'X-Role': 'nurse' }, body })).status, 200);

  const ann = await person('Dr Four');
  const ops = await ann.newPage(); watch(ops);
  let runId;

  await step('launcher: "Record a clinician working" starts a recording only after agreement', async () => {
    // The old launcher route opens the annotation study's Setup: what turns on, the one consent tick, Start recording.
    await ops.goto(`${s.base}/agent-ops/#/s/${TWIN}/setup`);
    await ops.waitForSelector(t('annotate-setup'));
    assert.equal(await ops.isDisabled(t('annotate-consent')), true, 'free text cannot be kept while the content policy is off');
    assert.match(await ops.textContent(t('annotate-setup')), /only actions are kept/);
    assert.equal(await ops.isHidden(t('recording-indicator')), true);
    // The full agreement dialog (title, friction, practice copy) is on the Sessions tab.
    await ops.click(t('study-tab-sessions'));
    await ops.click(t('recordings-start'));
    await ops.waitForSelector(t('record-start'));
    assert.equal(await ops.locator(t('field-thinkaloud')).count(), 0, 'no free-text options while the content policy is off');
    assert.match(await ops.textContent(t('record-start-note')), /switched off/);
    await ops.fill(t('field-title'), 'Ordering on the ward');
    await ops.selectOption(t('field-friction'), 'low');
    await ops.click(t('record-start-submit'));
    assert.match(await ops.textContent(t('record-start-error')), /has agreed/);
    await ops.check(t('field-acknowledged'));
    await ops.click(t('record-start-submit'));
    await ops.waitForSelector(t('recordings-live'));
    runId = (await s.call('GET', '/agent-ops/capture')).json.recordings[0].id;
    await ops.goto(`${s.base}/agent-ops/#/annotate/recordings/${runId}`);
    await ops.waitForSelector(t('rec-length'));
    await ops.waitForSelector(`${t('recording-indicator')}:not([hidden])`);
    assert.match(await ops.textContent(t('recording-detail')), /clicks and actions$/);
    assert.equal(await ops.locator(t('recording-think-aloud')).count(), 0);
    await shot(ops, '1-recording-started');
  });

  const ehr = await ann.newPage(); watch(ehr);
  await step('the Recording marker follows the clinician into the EHR, and their order is logged under the recording', async () => {
    await ehr.goto(`${s.base}/ehr/#/chart/${patient.id}`);
    await ehr.waitForSelector(`${t('recording-indicator')}:not([hidden])`);
    await ehr.click(t('chart-tab-orders'));
    await ehr.click(t('order-panel-cmp'));
    await ehr.waitForFunction(() => /Comprehensive|CMP/i.test(document.body.textContent) && document.querySelectorAll('[data-testid^="order-"][class~="card"]').length > 1);
    assert.equal(await ehr.locator(t('why-prompt')).count(), 0, 'no "why?" prompt without consent');
    await ehr.waitForTimeout(2600);
    const log = await trace(runId);
    assert.ok(log.some((x) => x.did.type === 'fhir.create' && x.did.args.type === 'ServiceRequest' && x.who.id === 'Dr Four'), 'the order is in the recording');
    assert.ok(log.some((x) => x.did.type === 'ui.click' && x.did.args.target === 'order-panel-cmp' && x.did.args.app === 'ehr'), 'so is the click that placed it');
    assert.doesNotMatch(JSON.stringify(log.filter((x) => x.source === 'ui')), /Zzlabel|Test/, 'UI events carry identifiers only');
    await shot(ehr, '2-ehr-recording');
  });

  await step('stopping from the marker ends the recording in every tab', async () => {
    await ehr.click(t('recording-stop'));
    await ehr.waitForSelector(t('recording-indicator'), { state: 'hidden' });
    await ops.waitForSelector(t('recording-indicator'), { state: 'hidden' });
    assert.ok((await s.call('GET', `/agent-ops/runs/${runId}`)).json.endedAt);
    await ops.reload();
    await ops.waitForSelector(t('rec-gold'));
    assert.match(await ops.textContent(t('rec-gold')), /order: .*LOINC:24323-8/);
    assert.match(await ops.textContent(t('rec-written')), /1 × ServiceRequest/);
    assert.match(await ops.textContent(t('rec-no-content')), /No written content/);
  });

  await step('a finished recording becomes a case in the case bank', async () => {
    await ops.click(t('rec-make-case'));
    await ops.fill(t('field-title'), 'Routine chemistry on the ward');
    await ops.fill(t('field-scenario'), 'Stable inpatient due routine bloods.');
    await ops.click(t('rec-case-submit'));
    await ops.waitForSelector(t('rec-cases'));
    const made = (await s.call('GET', '/agent-ops/cases')).json.cases.find((c) => c.title === 'Routine chemistry on the ward');
    assert.ok(made, 'the case is in the case bank');
    assert.equal(made.split, 'train');
  });

  await step('with the content policy on and consent given: think-aloud and one "why?" at ordering', async () => {
    await ops.goto(`${s.base}/agent-ops/#/annotate/recordings`);
    await ops.waitForSelector(t('policy-content'));
    await ops.check(t('policy-content'));
    await ops.waitForFunction(() => document.querySelector('[data-testid="policy-content"]')?.checked === true);
    await ops.click(t('recordings-start'));
    await ops.waitForSelector(t('field-thinkaloud'));
    assert.equal(await ops.isDisabled(t('field-dictation')), true, 'dictation needs a practice copy');
    await ops.selectOption(t('field-friction'), 'low');
    await ops.check(t('field-acknowledged'));
    await ops.check(t('field-thinkaloud'));
    await ops.check(t('field-why'));
    await ops.click(t('record-start-submit'));
    await ops.waitForSelector(t('recordings-live'));
    await ehr.waitForSelector(t('recording-think-aloud'));
    assert.match(await ehr.textContent(t('recording-detail')), /think-aloud notes, "why" answers/);
    await ehr.click(t('recording-think-aloud'));
    await ehr.fill(t('field-text'), 'Mrs Zzlabel looks dry, so I want a lipid panel as well.');
    await ehr.click(t('think-aloud-submit'));
    await ehr.waitForSelector(t('think-aloud'), { state: 'detached' });
    await ehr.click(t('order-panel-lipid'));
    await ehr.waitForSelector(t('why-prompt'));
    await ehr.fill(t('why-text'), 'Cardiovascular risk review is due.');
    await shot(ehr, '3-why-prompt');
    await ehr.click(t('why-save'));
    await ehr.waitForSelector(t('why-prompt'), { state: 'detached' });
    await ehr.click(t('recording-stop'));
    await ehr.waitForSelector(t('recording-indicator'), { state: 'hidden' });
  });

  await step('written content: masked, shown only on request, and deletable', async () => {
    // The recordings page noticed the stop made in the EHR tab without a reload.
    await ops.waitForFunction(() => /2 items/.test(document.querySelector('[data-testid="recordings-table"]')?.textContent || ''));
    assert.equal(await ops.locator(t('recordings-live')).count(), 0);
    const second = (await s.call('GET', '/agent-ops/capture')).json.recordings[0];
    await ops.goto(`${s.base}/agent-ops/#/annotate/recordings/${second.id}`);
    await ops.waitForSelector(t('rec-content-table'));
    assert.equal(await ops.textContent(t('rec-content')), '2');
    assert.doesNotMatch(await ops.textContent(t('rec-content-table')), /lipid panel|Cardiovascular/, 'text is not shown until asked for');
    await ops.click(t('rec-show-text'));
    await ops.waitForFunction(() => /lipid panel/.test(document.querySelector('[data-testid="rec-content-table"]')?.textContent || ''));
    const shown = await ops.textContent(t('rec-content-table'));
    assert.match(shown, /Mrs \[name\] looks dry/, 'the patient name was masked before storage');
    assert.match(shown, /Cardiovascular risk review is due\./);
    assert.match(shown, /ServiceRequest\//, 'the "why?" answer points at the order it was about');
    await shot(ops, '4-recording-content');
    await ops.click(t('rec-delete-all'));
    await ops.click(t('rec-delete-confirm-ok'));
    await ops.waitForSelector(t('rec-no-content'));
    assert.match(await ops.textContent(t('rec-no-content')), /2 items of written content were deleted/);
    await ops.click(t('rec-trace'));
    await ops.waitForSelector(t('trace-table'));
    const table = await ops.textContent(t('trace-table'));
    assert.match(table, /Think-aloud note \(\d+ characters, kept separately\)/);
    assert.match(table, /Written content deleted \(2\)/);
    assert.doesNotMatch(table, /lipid panel as well|Cardiovascular risk/);
  });

  await step('a recording on a practice copy keeps the clinical apps off the live chart until it stops', async () => {
    await ops.goto(`${s.base}/agent-ops/#/annotate/recordings`);
    await ops.waitForSelector(t('recordings-start'));
    await ops.click(t('recordings-start'));
    await ops.waitForSelector(t('field-dictation'));
    await ops.selectOption(t('field-friction'), 'low');
    await ops.check(t('field-acknowledged'));
    await ops.check(t('field-practice'));
    assert.equal(await ops.isDisabled(t('field-dictation')), false, 'dictation can be kept on a practice copy');
    await ops.check(t('field-dictation'));
    await ops.click(t('record-start-submit'));
    await ops.waitForSelector(t('recordings-live'));
    const rec = (await s.call('GET', '/agent-ops/capture')).json.recordings[0];
    assert.match(rec.context.practiceBranch, /^sandbox-/);
    assert.equal(rec.context.consent.dictation, true);
    await ehr.reload();
    await ehr.waitForSelector(t('time-strip'));
    assert.match(await ehr.textContent(t('time-strip')), /Practice copy/);
    assert.match(await ehr.textContent(t('recording-detail')), /dictation · practice copy$/);
    await ehr.click(t('chart-tab-orders'));
    await ehr.click(t('order-panel-cbc'));
    await ehr.waitForFunction(() => /Complete blood count/i.test(document.body.textContent || ''));
    assert.doesNotMatch(await ehr.textContent(t('recording-indicator')), /null|undefined/);
    const count = async (branch) => (await s.call('GET', `/fhir/R4/ServiceRequest?patient=${patient.id}${branch ? `&_branch=${branch}` : ''}`)).json.entry.length;
    const live = await count();
    const practice = await count(rec.context.practiceBranch);
    assert.equal(practice, live + 1, 'the order exists only on the practice copy');
    await ehr.click(t('recording-stop'));
    await ehr.waitForSelector(t('recording-indicator'), { state: 'hidden' });
    await ehr.waitForSelector(t('time-strip'), { state: 'detached' });
    await ops.waitForFunction(() => !document.querySelector('[data-testid="recordings-live"]'));
  });

  let projectId; let projectTwin = null;
  await step('labelling: a project is created from a fixed sample of notes', async () => {
    await ops.goto(`${s.base}/agent-ops/#/annotate/projects`);
    await ops.waitForSelector(t('projects-empty'));
    await ops.click(t('project-create'));
    await ops.fill(t('field-name'), 'Chest note triage');
    await ops.fill(t('field-limit'), '3');
    await ops.fill(t('field-labels'), 'normal, abnormal');
    await ops.click(t('project-new-submit'));
    assert.match(await ops.textContent(t('project-new-error')), /JSON array/);
    await ops.fill(t('field-labels'), '[{"id":"normal","label":"Normal"},{"id":"abnormal","label":"Abnormal"}]');
    await ops.click(t('project-new-submit'));
    await ops.waitForSelector(t('proj-items'));
    projectId = (await s.store.query('AnnotationProject')).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).pop().id; projectTwin = await twinOf('AnnotationProject', projectId);
    assert.equal(await ops.textContent(t('proj-items')), '3');
    assert.equal(await ops.textContent(t('proj-reads')), '0 / 6');
    assert.equal(await ops.textContent(t('proj-kappa')), '—');
    assert.equal(await ops.isDisabled(t('proj-adjudicate')), true);
  });

  const order = [];
  await step('workbench: one item at a time, keyboard only (1 to 9, Enter, S)', async () => {
    await ops.click(t('proj-label'));
    await ops.waitForSelector(t('wb-panel'));
    assert.match(await ops.textContent(t('wb-progress')), /Labelling as "Dr Four"\. You have labelled 0 of 3; 3 items left for you\./);
    assert.match(await ops.textContent(t('wb-keys')), /You will not see anyone else's answer/);
    const current = async () => (await ops.getAttribute('.wbgrid', 'data-testid')).replace('wb-item-', '');
    const firstId = await current();
    await ops.keyboard.press('Enter');
    assert.equal(await ops.textContent(t('wb-error')), 'Choose a label first');
    await ops.keyboard.press('s');
    await ops.waitForFunction((id) => document.querySelector('.wbgrid')?.dataset.testid !== `wb-item-${id}`, firstId);
    assert.notEqual(await current(), firstId, 'S moves on without answering');
    for (let i = 0; i < 3; i += 1) {
      const id = await current();
      order.push(id);
      await ops.keyboard.press('1');
      await ops.waitForSelector(`${t('label-normal')}[aria-checked="true"]`);
      if (i === 0) await shot(ops, '5-workbench');
      await ops.keyboard.press('Enter');
      if (i < 2) await ops.waitForFunction((was) => document.querySelector('.wbgrid')?.dataset.testid !== `wb-item-${was}`, id);
    }
    await ops.waitForSelector(t('wb-done'));
    assert.equal(order.at(-1), firstId, 'the skipped item came back last');
    assert.equal(new Set(order).size, 3);
  });

  const ben = await person('Dr Six');
  const benPage = await ben.newPage(); watch(benPage);
  await step('a second reader labels blind; agreement appears and disagreements wait for adjudication', async () => {
    await benPage.goto(`${s.base}/agent-ops/#/s/${projectTwin}/label`);
    await benPage.waitForSelector(t('wb-panel'));
    assert.match(await benPage.textContent(t('wb-progress')), /Labelling as "Dr Six"\. You have labelled 0 of 3/);
    assert.doesNotMatch(await benPage.textContent('main'), /Dr Four/);
    for (let i = 0; i < 3; i += 1) {
      const id = (await benPage.getAttribute('.wbgrid', 'data-testid')).replace('wb-item-', '');
      // The second reader agrees on one item and disagrees on two.
      await benPage.click(t(i === 0 ? 'label-normal' : 'label-abnormal'));
      await benPage.click(t('wb-submit'));
      if (i < 2) await benPage.waitForFunction((was) => document.querySelector('.wbgrid')?.dataset.testid !== `wb-item-${was}`, id);
    }
    await benPage.waitForSelector(t('wb-done'));
    await benPage.click(t('wb-back'));
    await benPage.waitForSelector(t('proj-kappa'));
    assert.equal(await benPage.textContent(t('proj-kappa')), '0.00');
    assert.equal(await benPage.textContent(t('proj-waiting')), '2');
    assert.match(await benPage.textContent(t('proj-agreement-note')), /Cohen's κ between 2 annotators/);
    assert.match(await benPage.textContent(t('proj-adjudication-required')), /Agreement is below 0\.6/);
    await shot(benPage, '6-project-agreement');
    await benPage.click(t('proj-adjudicate'));
    await benPage.waitForSelector(t('adj-done'));
    assert.match(await benPage.textContent(t('adj-done')), /ones you read yourself/);
  });

  const cat = await person('Dr Eight');
  const catPage = await cat.newPage(); watch(catPage);
  await step('a third person adjudicates without seeing who said what', async () => {
    await catPage.goto(`${s.base}/agent-ops/#/s/${projectTwin}/adjudicate`);
    await catPage.waitForSelector(t('adj-panel'));
    assert.match(await catPage.textContent(t('adj-progress')), /Adjudicating as "Dr Eight"\. 2 items waiting\./);
    const reads = `${await catPage.textContent(t('adj-read-0'))} ${await catPage.textContent(t('adj-read-1'))}`;
    assert.match(reads, /Reader A/); assert.match(reads, /Reader B/);
    assert.doesNotMatch(reads, /Dr Four|Dr Six/);
    await shot(catPage, '7-adjudication');
    await catPage.keyboard.press('2');
    await catPage.keyboard.press('Enter');
    await catPage.waitForFunction(() => /1 item waiting/.test(document.querySelector('[data-testid="adj-progress"]')?.textContent || ''));
    await catPage.click(t('label-normal'));
    await catPage.click(t('adj-submit'));
    await catPage.waitForSelector(t('adj-done'));
    await catPage.click(t('adj-back'));
    await catPage.waitForSelector(t('proj-resolved'));
    assert.equal(await catPage.textContent(t('proj-resolved')), '3');
    assert.equal(await catPage.textContent(t('proj-waiting')), '0');
  });

  await step('export: a de-identified JSONL download, logged', async () => {
    const [download] = await Promise.all([catPage.waitForEvent('download'), catPage.click(t('export-labels-jsonl'))]);
    assert.match(download.suggestedFilename(), /^labels-.*\.jsonl$/);
    const text = fs.readFileSync(await download.path(), 'utf8');
    const lines = text.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].manifest, true);
    assert.equal(lines[0].resolved, 3);
    assert.equal(lines.length, 4);
    assert.doesNotMatch(text, /Zzlabel|Dr Four|Dr Six|Dr Eight/);
    assert.match(text, /Mrs XXXXXXX has no pleural effusion/);
    assert.equal(lines.slice(1).filter((l) => l.final.source === 'adjudicated').length, 2);
    const run = (await s.call('GET', `/agent-ops/annotation/projects/${projectId}`)).json.runId;
    assert.ok((await trace(run)).some((x) => x.did.type === 'annotation.export'));
  });

  await step('span labelling: click the first and last word of a phrase', async () => {
    const made = (await s.call('POST', '/agent-ops/annotation/projects', { name: 'Negations', taskType: 'span', labels: [{ id: 'negated', label: 'Negated finding' }, { id: 'plan', label: 'Plan' }], annotatorsPerItem: 1, sampling: { resourceType: 'DocumentReference', limit: 1, seed: 3 } }, { 'X-User-Id': 'Dr Four' })).json;
    await ops.goto(`${s.base}/agent-ops/#/s/${await twinOf('AnnotationProject', made.id)}/label`);
    await ops.waitForSelector(t('span-text'));
    const words = await ops.locator(`${t('span-text')} .tok`).allTextContents();
    assert.ok(words.length >= 3);
    await ops.click(t('tok-0'));
    assert.match(await ops.textContent(t('span-count')), /Now click the last word/);
    await ops.click(t('tok-1'));
    assert.match(await ops.textContent(t('span-count')), /^1 span marked/);
    await ops.keyboard.press('2');
    await ops.click(t('tok-2'));
    await ops.click(t('tok-2'));
    assert.match(await ops.textContent(t('span-count')), /^2 spans marked/);
    await ops.click(t('tok-2'));
    assert.match(await ops.textContent(t('span-count')), /^1 span marked/, 'clicking a marked word removes its span');
    await shot(ops, '8-span-tool');
    await ops.click(t('wb-submit'));
    await ops.waitForSelector(t('wb-done'));
    const saved = (await s.call('GET', '/fhir/R4/Observation?category=annotation')).json.entry.map((e) => e.resource).find((o) => o.code.coding[0].code === made.id);
    assert.equal(saved.component.length, 1);
    assert.equal(saved.component[0].code.coding[0].code, 'negated');
    assert.equal(saved.component[0].extension.find((e) => e.url.endsWith('span-start')).valueInteger, 0);
  });

  await step('bounding boxes: draw on the image; the embedded viewer takes no reading lock', async () => {
    const made = (await s.call('POST', '/agent-ops/annotation/projects', { name: 'Findings on film', taskType: 'bbox', labels: [{ id: 'finding', label: 'Finding' }, { id: 'device', label: 'Line or device' }], annotatorsPerItem: 1, sampling: { resourceType: 'ImagingStudy', limit: 1, seed: 1 } }, { 'X-User-Id': 'Dr Four' })).json;
    await ops.goto(`${s.base}/agent-ops/#/s/${await twinOf('AnnotationProject', made.id)}/label`);
    await ops.waitForSelector(`${t('box-canvas')}[data-loaded="1"]`);
    await ops.locator(t('box-canvas')).scrollIntoViewIfNeeded(); await ops.evaluate(() => document.querySelector('[data-testid="box-canvas"]').scrollIntoView({ block: 'center' })); await ops.waitForTimeout(200); // the whole image must be on screen before dragging on it
    const box = await ops.locator(t('box-canvas')).boundingBox();
    const drag = async (x1, y1, x2, y2) => { await ops.mouse.move(box.x + box.width * x1, box.y + box.height * y1); await ops.mouse.down(); await ops.mouse.move(box.x + box.width * x2, box.y + box.height * y2, { steps: 5 }); await ops.mouse.up(); };
    await drag(0.2, 0.2, 0.5, 0.5);
    await ops.keyboard.press('2');
    await drag(0.6, 0.6, 0.8, 0.9);
    assert.match(await ops.textContent(t('box-count')), /^2 boxes/);
    await ops.keyboard.press('Delete');
    assert.match(await ops.textContent(t('box-count')), /^1 box\./, 'Delete removes the selected box');
    await shot(ops, '9-box-tool');
    await ops.click(t('wb-open-viewer'));
    const frame = ops.frameLocator(t('item-viewer'));
    await frame.locator(t('viewer')).waitFor();
    assert.equal(await frame.locator('.topbar').isHidden(), true, 'the embedded viewer shows images only');
    const study = (await s.call('GET', '/api/pacs/worklist?queue=all')).json.rows[0];
    assert.equal(study.lock, null, 'no reading lock was taken');
    await ops.click(t('wb-submit'));
    await ops.waitForSelector(t('wb-done'));
    const saved = (await s.call('GET', '/fhir/R4/Observation?category=annotation')).json.entry.map((e) => e.resource).find((o) => o.code.coding[0].code === made.id);
    assert.equal(saved.component.length, 1);
    assert.equal(saved.component[0].code.coding[0].code, 'finding');
    const coco = (await s.call('GET', `/agent-ops/annotation/projects/${made.id}/export.coco.json`)).json;
    assert.equal(coco.annotations.length, 1);
    assert.ok(coco.annotations[0].bbox[2] > 10);
  });

  await step('launcher: "Label clinical data" opens the chosen project; accessibility hooks are present', async () => {
    await ops.goto(`${s.base}/agent-ops/#/annotate/new/label`);
    await ops.waitForSelector(t('label-card'));
    assert.ok((await ops.locator(`${t('launch-project')} option`).count()) >= 1);
    for (const [hash, ready] of [['#/annotate/new/label', 'label-card'], ['#/annotate/recordings', 'recordings-table'], ['#/annotate/projects', 'projects-table'], [`#/s/${projectTwin}/project`, 'proj-items'], [`#/s/${projectTwin}/adjudicate`, 'adj-done']]) {
      await ops.goto(`${s.base}/agent-ops/${hash}`);
      await ops.waitForSelector(t(ready));
      const missing = await ops.evaluate(() => [...document.querySelectorAll('button, input, select, textarea')].filter((el) => !el.dataset.testid || !el.getAttribute('aria-label')).map((el) => el.outerHTML.slice(0, 120)));
      assert.deepEqual(missing, [], `controls without test id or label on ${hash}`);
    }
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
