// Research data model (plan-master task 5): the log never changes under
// review, a snapshot hashes the same twice, excluded steps, redacted fields
// and the evaluation split never appear in any format, CSV columns are
// exact, and replay returns the chart version a step saw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, patient, BACKEND } from './support/helpers.mjs';
import { pseudonym, canonical, STEP_COLUMNS, RUN_COLUMNS } from '../agent-operations/server/research.mjs';

const res = { 'X-Role': 'researcher', 'X-User-Id': 'Researcher One' };
const doc = { 'X-Role': 'physician', 'X-User-Id': 'dr-one' };

test('pseudonyms are stable, never the name; canonical JSON is order-free', () => {
  assert.equal(pseudonym('Researcher One'), pseudonym('researcher one '));
  assert.match(pseudonym('Researcher One'), /^R-\d\d$/);
  assert.notEqual(pseudonym('Userone'), 'Userone');
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), canonical({ a: [2, { c: 2, d: 1 }], b: 1 }));
});

test(`[${BACKEND}] studies, reviews, corrections, redactions and snapshots: the log is untouched, exports are frozen and clean`, async () => {
  const s = await startTestServer();
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Zzresearch', { name: [{ family: 'Zzresearch', given: ['Test'] }] }))).json;
  const study = (await s.call('POST', '/agent-ops/research/studies', { title: 'Report drafting on chest X-ray', question: 'Does the drafter match the radiologist?' }, res)).json;
  assert.equal(study.owner, pseudonym('Researcher One'));
  assert.notEqual(JSON.stringify(study).includes('Userone'), true, 'the owner is a pseudonym');
  const refused = await s.call('POST', '/agent-ops/research/studies', { title: 'x', question: '' }, res); assert.equal(refused.status, 422);
  // Two human runs in the study (sandbox mode needs no agent), with a few logged steps each.
  const mk = async (n) => (await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', study: study.id, goal: `run ${n}`, subject: `Patient/${p.id}` }, res)).json;
  const r1 = await mk(1); const r2 = await mk(2);
  for (const r of [r1, r2]) for (let i = 0; i < 3; i += 1) assert.equal((await s.call('POST', '/agent-ops/trace', { batchId: `batch-${r.id.slice(0, 8)}-${i}`, events: [{ seq: i, type: 'click', app: 'ehr', sessionId: 'sess', clientTime: new Date().toISOString(), target: `button-${i}`, route: '/ehr/#/chart' }] }, { ...doc, 'X-Run-Id': r.id })).status, 200);
  const contents0 = (await s.call('GET', `/agent-ops/research/studies/${study.id}`, undefined, res)).json;
  assert.deepEqual(contents0.runs.map((r) => r.id).sort(), [r1.id, r2.id].sort(), 'runs started with a study join it');
  const steps1 = (await s.call('GET', `/agent-ops/trace?runId=${r1.id}`)).json.steps;
  const before = JSON.stringify(steps1.map(({ seq, ...x }) => x));
  const stepToExclude = steps1.find((x) => x.did.type === 'ui.click');
  const stepToRedact = steps1.filter((x) => x.did.type === 'ui.click')[1];
  // Reviews, a correction and a redaction, all as new records.
  assert.equal((await s.call('POST', '/agent-ops/research/reviews', { target: stepToExclude.id, decision: 'exclude', reason: 'Mis-click, not part of the task' }, res)).status, 201);
  assert.equal((await s.call('POST', '/agent-ops/research/reviews', { target: stepToExclude.id, decision: 'exclude' }, res)).status, 422, 'a reason is required');
  assert.equal((await s.call('POST', '/agent-ops/research/reviews', { target: r2.id, decision: 'exclude', reason: 'Duplicate session' }, res)).status, 201);
  assert.equal((await s.call('POST', '/agent-ops/research/reviews', { target: r1.id, decision: 'include' }, res)).status, 201);
  const corr = (await s.call('POST', '/agent-ops/research/corrections', { target: stepToRedact.id, correctAction: { type: 'ServiceRequest', code: '24725-4', label: 'Order a CT head instead' }, note: 'Should have ordered imaging first' }, res)).json;
  assert.equal((await s.call('POST', '/agent-ops/research/redactions', { target: stepToRedact.id, path: 'did.args.target', reason: 'Contains a free-text id' }, res)).status, 201);
  assert.equal((await s.call('POST', '/agent-ops/research/reviews', { target: r1.id, decision: 'include' }, { 'X-Agent-Id': 'agent-1' })).status >= 400, true, 'agents cannot review (refused by the envelope or the research guard)');
  const after = JSON.stringify((await s.call('GET', `/agent-ops/trace?runId=${r1.id}`)).json.steps.filter((x) => steps1.some((y) => y.id === x.id)).map(({ seq, ...x }) => x));
  assert.equal(after, before, 'reviewing, correcting and redacting never change the TraceSteps');
  const overlay = (await s.call('GET', `/agent-ops/research/overlay/${r1.id}`, undefined, res)).json;
  assert.equal(overlay.runReview.decision, 'include');
  assert.equal(overlay.stepReviews[stepToExclude.id].decision, 'exclude');
  assert.equal(overlay.corrections[stepToRedact.id][0].id, corr.id);
  assert.equal(overlay.runReview.reviewer, pseudonym('Researcher One'));
  // An evaluation-split case run must never be exported.
  const evalCase = (await s.call('POST', '/agent-ops/cases', { title: 'Held-out case', split: 'eval', scenario: 'A test case', task: 'Do the right thing', patientRef: `Patient/${p.id}`, verifier: { kind: 'none' } }, res)).json;
  let r3 = null;
  if (evalCase?.id) { r3 = (await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', study: study.id, caseId: evalCase.id, goal: 'held out' }, res)).json; if (r3?.id) await s.call('POST', '/agent-ops/trace', { batchId: 'batch-eval-0', events: [{ seq: 0, type: 'click', app: 'ehr', sessionId: 'sess', clientTime: new Date().toISOString(), target: 'secret-eval-button', route: '/ehr/#/chart' }] }, { ...doc, 'X-Run-Id': r3.id }); }
  // Preview, then freeze twice: same hash, and the excluded step, redacted field and eval run are absent in every format.
  const body = { study: study.id, title: 'First cut', exportType: 'steps', reviewRules: { requireReview: false } };
  const preview = (await s.call('POST', '/agent-ops/research/snapshots/preview', body, res)).json;
  assert.ok(preview.sha256 && preview.sample.length >= 1);
  const snapA = (await s.call('POST', '/agent-ops/research/snapshots', body, res)).json;
  const snapB = (await s.call('POST', '/agent-ops/research/snapshots', body, res)).json;
  assert.equal(snapA.sha256, snapB.sha256, 'the same selection hashes the same twice');
  assert.equal(snapA.sha256, preview.sha256);
  assert.deepEqual(snapA.runIds, [r1.id], 'the excluded run and the evaluation-split run are out');
  assert.equal(snapA.stepCount, steps1.length - 1, 'the excluded step is dropped');
  assert.ok(snapA.dataCard.exclusions.some((e) => e.run === r2.id && /Duplicate/.test(e.reason)));
  if (r3?.id) assert.equal(snapA.dataCard.evaluationSplitExcluded.runsHeldOut, 1, 'the held-out run is counted, never named');
  for (const format of ['jsonl', 'json', 'csv']) {
    const out = await s.call('GET', `/agent-ops/research/snapshots/${snapA.id}/export?format=${format}`, undefined, res);
    assert.equal(out.status, 200, out.text);
    assert.ok(!out.text.includes(stepToExclude.id), `${format}: excluded step absent`);
    assert.ok(!out.text.includes(`button-1`) || !out.text.includes(stepToRedact.did.args.target), `${format}: redacted field absent`);
    assert.ok(out.text.includes('[redacted]'), `${format}: redaction marker present`);
    assert.ok(!out.text.includes('secret-eval-button') && (!r3?.id || !out.text.includes(r3.id)), `${format}: evaluation split absent`);
    assert.ok(out.text.includes('Order a CT head instead'), `${format}: the correction is attached`);
    assert.ok(!out.text.includes('Userone Researcher'), `${format}: no reviewer names`);
    assert.ok(!out.text.includes('Zzresearch'), `${format}: no patient names`);
  }
  const csv = (await s.call('GET', `/agent-ops/research/snapshots/${snapA.id}/export?format=csv`, undefined, res)).text;
  assert.equal(csv.split('\n')[0], STEP_COLUMNS.join(','), 'exact step columns');
  const runsCsv = (await s.call('GET', `/agent-ops/research/snapshots/${snapA.id}/export?format=csv&which=runs`, undefined, res)).text;
  assert.equal(runsCsv.split('\n')[0], RUN_COLUMNS.join(','), 'exact run columns');
  assert.equal(runsCsv.trim().split('\n').length, 2);
  const again = (await s.call('GET', `/agent-ops/research/snapshots/${snapA.id}/export?format=jsonl`, undefined, res)).text;
  const first = (await s.call('GET', `/agent-ops/research/snapshots/${snapA.id}/export?format=jsonl`, undefined, res)).text;
  assert.equal(again, first, 're-exporting a snapshot gives identical bytes');
  assert.equal((await s.call('GET', `/agent-ops/research/studies/${study.id}`, undefined, res)).json.snapshots.length, 2);
  // Replay returns the chart version the step saw.
  const chartRead = (await s.call('GET', `/fhir/R4/Patient/${p.id}`, undefined, { ...doc, 'X-Run-Id': r1.id })).json;
  assert.ok(chartRead.id);
  await s.call('PUT', `/fhir/R4/Patient/${p.id}`, { ...chartRead, name: [{ family: 'Zzresearch', given: ['Test', 'Changed'] }] }, doc);
  const stepsNow = (await s.call('GET', `/agent-ops/trace?runId=${r1.id}`)).json.steps;
  const readStep = stepsNow.find((x) => (x.saw?.resources || []).some((r) => r.ref === `Patient/${p.id}`));
  assert.ok(readStep, 'the chart read is a step with what it saw');
  const replay = (await s.call('GET', `/agent-ops/replay/${r1.id}/${readStep.id}`, undefined, res)).json;
  const seen = replay.resources.find((r) => r.ref === `Patient/${p.id}`);
  assert.equal(String(seen.versionId), '1', 'the version the step saw, not the latest');
  assert.match(seen.body.name[0].family, /^Patient /);
  assert.equal((await s.call('POST', `/agent-ops/research/studies/${study.id}/archive`, {}, res)).json.status, 'archived');
  assert.equal((await s.call('POST', `/agent-ops/research/studies/${study.id}/links`, { kind: 'run', ref: r2.id }, res)).status, 409, 'archived studies take nothing new');
  const steps = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.map((x) => x.did.type);
  for (const a of ['study.create', 'review.decide', 'review.correct', 'review.redact', 'snapshot.freeze', 'snapshot.download', 'trace.replay']) assert.ok(steps.includes(a), `${a} is logged`);
  await s.close();
});
