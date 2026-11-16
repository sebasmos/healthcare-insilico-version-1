// Ablation overlays and the ablation report (§9g).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKEND } from './support/helpers.mjs';
import { agentSetup, rad } from './support/agents.mjs';
import { validateOverlays, describeOverlay, createLens } from '../agent-operations/server/ablation.mjs';

const LOINC = 'http://loinc.org';
async function setup() {
  const ctx = await agentSetup();
  const { s, p, clock } = ctx;
  const post = async (resource, headers) => { const r = await s.call('POST', `/fhir/R4/${resource.resourceType}`, resource, headers); assert.equal(r.status, 201, r.text); return r.json; };
  const subject = { reference: `Patient/${p.id}` };
  const lab = (code, value) => post({ resourceType: 'Observation', status: 'preliminary', category: [{ coding: [{ code: 'laboratory' }] }], code: { coding: [{ system: LOINC, code }] }, subject, valueQuantity: { value, unit: 'x' } });
  const vital = (code, value) => post({ resourceType: 'Observation', status: 'preliminary', category: [{ coding: [{ code: 'vital-signs' }] }], code: { coding: [{ system: LOINC, code }] }, subject, valueQuantity: { value } });
  const note = (type) => post({ resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', type: { coding: [{ system: LOINC, code: type }] }, subject, content: [{ attachment: { contentType: 'text/plain', data: 'bm90ZQ==' } }] });
  await s.call('POST', '/agent-ops/agents', { id: 'reader', name: 'Reader', version: '1', capability: 'custom', adapter: { kind: 'stub', stub: 'report-drafter' }, scopes: [{ type: 'Task', interactions: ['create'] }] });
  const runWith = async (overlays, extra = {}) => { const r = await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'reader', overlays, ...extra }); assert.equal(r.status, 201, r.text); return r.json; };
  let n = 0;
  const as = (run) => ({ 'X-Agent-Id': 'reader', 'X-Run-Id': run.id, 'Idempotency-Key': `abl-${n += 1}` });
  const read = async (run, path) => s.call('GET', `/fhir/R4/${path}`, undefined, as(run));
  const ids = async (run, path) => ((await read(run, path)).json.entry || []).map((e) => e.resource.id).sort();
  return { ...ctx, s, p, clock, post, lab, vital, note, runWith, as, read, ids, subject, sign: ctx.read };
}

test('overlay validation and plain-English descriptions', () => {
  const ok = validateOverlays([{ type: 'hide', what: 'priors' }, { type: 'hide', what: 'notes', noteType: '11506-3' }, { type: 'hide', what: 'images' }, { type: 'delay', what: 'labs', afterSteps: 3 }, { type: 'delay', resourceType: 'Observation', code: '2160-0', afterSeconds: 30 }, { type: 'change', resourceType: 'Observation', code: '2160-0', path: 'valueQuantity.value', multiply: 10 }, { type: 'change', resourceType: 'Observation', code: '2823-3', path: 'valueQuantity.value', value: 2.1 }]);
  assert.deepEqual(ok.map(describeOverlay), [
    'Hidden: prior imaging and its reports', 'Hidden: clinical notes', 'Hidden: the images themselves (the study record stays, without its series)', 'Delayed: laboratory results appear only after 3 steps',
    'Delayed: Creatinine (2160-0) records appear only after 30 seconds', 'Changed: Creatinine (2160-0) multiplied by 10', 'Changed: Potassium (2823-3) set to 2.1',
  ]);
  assert.deepEqual(validateOverlays(null), []);
  for (const bad of [[{ type: 'erase', what: 'labs' }], [{ type: 'hide', what: 'everything' }], [{ type: 'hide', resourceType: 'Patient' }], [{ type: 'delay', what: 'labs' }], [{ type: 'delay', what: 'labs', afterSteps: 2, afterSeconds: 2 }], [{ type: 'delay', what: 'labs', afterSteps: 0 }],
    [{ type: 'change', resourceType: 'Observation', code: 'x', path: 'valueQuantity.value' }], [{ type: 'change', resourceType: 'Observation', code: 'x', path: '__proto__.x', value: 1 }], [{ type: 'change', resourceType: 'Observation', path: 'valueQuantity.value', value: 1 }], [{ type: 'change', resourceType: 'Observation', code: 'x', path: 'valueQuantity.value', multiply: 1 }], 'hide labs', Array(13).fill({ type: 'hide', what: 'labs' })]) {
    assert.throws(() => validateOverlays(bad), /overlay/i, JSON.stringify(bad).slice(0, 60));
  }
});

test(`[${BACKEND}] hide: the run's agent cannot see the hidden kind by search, by id, by history or by $everything; everyone else can`, async () => {
  const { s, p, lab, vital, note, runWith, read, ids, post, subject } = await setup();
  const k = await lab('2823-3', 6.8); const hr = await vital('8867-4', 118); const progress = await note('11506-3'); const discharge = await note('18842-5');
  const cond = await post({ resourceType: 'Condition', subject, code: { text: 'Diabetes' } });
  const run = await runWith([{ type: 'hide', what: 'labs' }, { type: 'hide', what: 'notes', noteType: '11506-3' }]);
  assert.equal(run.overlays.length, 2, 'overlays are stored on the Run');
  assert.deepEqual(await ids(run, `Observation?patient=${p.id}`), [hr.id], 'labs are gone, vitals stay');
  assert.deepEqual(await ids(run, `DocumentReference?patient=${p.id}`), [discharge.id], 'only the named note type is hidden');
  assert.equal((await read(run, `Observation/${k.id}`)).status, 404, 'no way round by id');
  assert.equal((await read(run, `Observation/${k.id}/_history`)).status, 404);
  assert.equal((await read(run, `Observation?_id=${k.id}`)).json.total, 0);
  const everything = ((await read(run, `Patient/${p.id}/$everything`)).json.entry || []).map((e) => e.resource.id);
  assert.ok(!everything.includes(k.id) && !everything.includes(progress.id) && everything.includes(hr.id) && everything.includes(cond.id) && everything.includes(p.id));
  assert.equal((await read(run, `Patient/${p.id}`)).status, 200, 'the patient is never hidden');

  const plain = await runWith([]);
  assert.equal((await ids(plain, `Observation?patient=${p.id}`)).length, 2, 'another run sees everything');
  assert.equal((await s.call('GET', `/fhir/R4/Observation?patient=${p.id}&_branch=${run.branch}`)).json.total, 2, 'a person looking at the same branch sees everything');
  assert.equal((await s.store.query('Observation', { patient: `Patient/${p.id}` }, { branch: run.branch })).length, 2, 'the store itself is unchanged, so verifiers see the truth');

  const history = await runWith([{ type: 'hide', what: 'history' }, { type: 'hide', what: 'vitals' }]);
  assert.deepEqual([await ids(history, `Condition?patient=${p.id}`), await ids(history, `Observation?patient=${p.id}`)], [[], [k.id]]);
  const steps = (await s.call('GET', `/agent-ops/trace?runId=${run.id}`)).json.steps.filter((t) => t.did.type === 'fhir.search');
  assert.deepEqual(steps[0].did.args.ablated, { hidden: 1, delayed: 0, changed: 0 }, 'the trace records that the overlay removed something from this read');
  assert.deepEqual(steps[0].saw.resources.map((r) => r.ref), [`Observation/${hr.id}`], 'what the agent saw is what it was actually given');
  assert.equal((await s.call('GET', '/api/pacs/worklist?queue=all', undefined, { 'X-Agent-Id': 'reader', 'X-Run-Id': run.id })).status, 403, 'under an ablation the agent reads only through FHIR, so nothing leaks by another door');
  assert.equal((await s.call('GET', '/api/pacs/worklist?queue=all', undefined, { 'X-Agent-Id': 'reader', 'X-Run-Id': plain.id })).status, 200);
  assert.equal((await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'reader', overlays: [{ type: 'hide', what: 'secrets' }] })).status, 422);
  await s.close();
});

test(`[${BACKEND}] hide priors and images: the study being read stays, earlier imaging goes, pixels are withheld`, async () => {
  const { s, p, study, read, ids, runWith, post, subject } = await setup();
  const prior = await study('Earlier film'); const current = await study('Follow-up');
  await s.store.save('ImagingStudy', { ...(await s.store.get('ImagingStudy', current.id)), series: [{ uid: '1.2.3', instance: [{ uid: '1.2.3.1' }] }], numberOfSeries: 1, numberOfInstances: 1 });
  const priorReport = await post({ resourceType: 'DiagnosticReport', status: 'preliminary', code: { text: 'x' }, subject, imagingStudy: [{ reference: `ImagingStudy/${prior.id}` }], conclusion: 'Nodule' }, rad);
  const ownDraft = await post({ resourceType: 'DiagnosticReport', status: 'preliminary', code: { text: 'x' }, subject, imagingStudy: [{ reference: `ImagingStudy/${current.id}` }] }, rad);
  const run = await runWith([{ type: 'hide', what: 'priors' }], { subject: `ImagingStudy/${current.id}` });
  assert.deepEqual(await ids(run, `ImagingStudy?patient=${p.id}`), [current.id]);
  assert.deepEqual(await ids(run, `DiagnosticReport?patient=${p.id}`), [ownDraft.id], 'reports of earlier studies are hidden with them');
  assert.equal((await read(run, `DiagnosticReport/${priorReport.id}`)).status, 404);
  const blind = await runWith([{ type: 'hide', what: 'images' }], { subject: `ImagingStudy/${current.id}` });
  const seen = (await read(blind, `ImagingStudy/${current.id}`)).json;
  assert.deepEqual([seen.series, seen.numberOfInstances, seen.description], [undefined, 0, 'Chest X-ray'], 'the study record is there, its images are not');
  assert.equal((await s.call('GET', '/dicom-web/studies', undefined, { 'X-Agent-Id': 'reader', 'X-Run-Id': blind.id })).status, 403);
  await s.close();
});

test(`[${BACKEND}] delay: a record appears only after N agent steps, or after S seconds`, async () => {
  const { s, p, clock, lab, vital, runWith, read, ids } = await setup();
  const k = await lab('2823-3', 6.8); const hr = await vital('8867-4', 118);
  const bySteps = await runWith([{ type: 'delay', what: 'labs', afterSteps: 3 }]);
  assert.deepEqual(await ids(bySteps, `Observation?patient=${p.id}`), [hr.id], 'step 1: not yet');
  assert.equal((await read(bySteps, `Observation/${k.id}`)).status, 404, 'step 2: not yet (a refused read is not a step)');
  assert.deepEqual(await ids(bySteps, `Observation?patient=${p.id}`), [hr.id], 'step 2 again');
  await read(bySteps, `Patient/${p.id}`);
  assert.deepEqual(await ids(bySteps, `Observation?patient=${p.id}`), [hr.id, k.id].sort(), 'three steps taken: now visible');
  const trace = (await s.call('GET', `/agent-ops/trace?runId=${bySteps.id}`)).json.steps.filter((t) => t.who.kind === 'agent');
  assert.deepEqual(trace.map((t) => t.did.args.ablated?.delayed ?? 0), [1, 1, 0, 0]);

  const byTime = await runWith([{ type: 'delay', resourceType: 'Observation', code: '2823-3', afterSeconds: 60 }]);
  assert.deepEqual(await ids(byTime, `Observation?patient=${p.id}`), [hr.id]);
  clock.advance(59_000);
  assert.equal((await read(byTime, `Observation/${k.id}`)).status, 404);
  clock.advance(1_000);
  assert.equal((await read(byTime, `Observation/${k.id}`)).status, 200, 'sixty seconds after the run started');
  await s.close();
});

test(`[${BACKEND}] change: one value is altered for the run's agent only`, async () => {
  const { s, p, lab, runWith, read } = await setup();
  const creat = await lab('2160-0', 1.1); const k = await lab('2823-3', 4.0);
  const run = await runWith([{ type: 'change', resourceType: 'Observation', code: '2160-0', path: 'valueQuantity.value', multiply: 10 }, { type: 'change', resourceType: 'Observation', code: '2823-3', path: 'valueQuantity.value', value: 6.9 }]);
  assert.equal((await read(run, `Observation/${creat.id}`)).json.valueQuantity.value, 11);
  const found = (await read(run, `Observation?patient=${p.id}`)).json.entry.map((e) => [e.resource.id, e.resource.valueQuantity.value]).sort();
  assert.deepEqual(found, [[creat.id, 11], [k.id, 6.9]].sort());
  assert.equal((await s.call('GET', `/fhir/R4/Observation/${creat.id}`)).json.valueQuantity.value, 1.1, 'the real chart is untouched');
  assert.equal((await s.store.get('Observation', creat.id, { branch: run.branch })).valueQuantity.value, 1.1);
  assert.equal((await s.store.history('Observation', creat.id)).length, 1, 'no new version was written');
  const step = (await s.call('GET', `/agent-ops/trace?runId=${run.id}`)).json.steps.find((t) => t.did.type === 'fhir.read');
  assert.deepEqual(step.did.args.ablated, { hidden: 0, delayed: 0, changed: 1 });
  const lens = createLens(s.store, { ...run, overlays: [{ type: 'change', resourceType: 'Observation', code: '2160-0', path: 'valueString.deep', value: 'x' }] }, { steps: async () => 0, now: () => s.store.now() });
  assert.equal((await lens.get('Observation', creat.id)).valueQuantity.value, 1.1, 'a path that does not exist changes nothing');
  await s.close();
});

test(`[${BACKEND}] report, hide priors: the Report Drafter notices when the request refers to earlier imaging that it cannot find`, async () => {
  const { s, study, open, sign } = await setup();
  const prior = await study('Cough'); await open(prior); await sign(prior, 'Right upper lobe nodule, 8 mm.');
  const followUp = await study('Follow-up of known right upper lobe nodule');
  const unrelated = await study('Cough for two weeks');
  const hide = [{ type: 'hide', what: 'priors' }];
  const a = await s.call('POST', '/agent-ops/ablation/run', { agentId: 'report-drafter', subject: `ImagingStudy/${followUp.id}`, overlays: hide });
  assert.equal(a.status, 201, a.text);
  const row = a.json.row;
  assert.deepEqual([row.verdict, row.rightAnswer, row.noticed, row.baseline.answer, row.ablated.answer, row.ablated.flags[0].code], ['noticed-and-right', true, true, 'abnormal', 'abnormal', 'missing-data']);
  assert.ok(row.ablated.confidence < row.baseline.confidence, 'and it lowers its confidence');
  assert.deepEqual([row.applied.hidden > 0, row.overlayText], [true, ['Hidden: prior imaging and its reports']]);
  const draft = (await s.store.query('DiagnosticReport', {}, { branch: (await s.store.get('Run', row.runId)).branch })).find((r) => r._updatedBy === 'agent');
  assert.match(draft.extension.find((e) => e.url.endsWith('report-findings')).valueString, /refers to earlier imaging, but none could be found/);

  const b = (await s.call('POST', '/agent-ops/ablation/run', { agentId: 'report-drafter', subject: `ImagingStudy/${unrelated.id}`, overlays: hide })).json.row;
  assert.deepEqual([b.verdict, b.rightAnswer, b.noticed, b.baseline.answer, b.ablated.answer], ['confidently-wrong', false, false, 'abnormal', 'normal'], 'nothing in this request hints at a prior, so the agent answers as if there were none');
  const again = (await s.call('POST', '/agent-ops/ablation/run', { agentId: 'report-drafter', subject: `ImagingStudy/${unrelated.id}`, overlays: [{ type: 'hide', what: 'labs' }] })).json;
  assert.deepEqual([again.row.verdict, again.baselineRunId], ['not-applied', b.baselineRunId], 'hiding something the agent never asks for is reported as such; the baseline is reused');

  const report = (await s.call('GET', '/agent-ops/ablation')).json;
  assert.match(report.note, /does not mean clinically correct/);
  assert.deepEqual(report.summary, { runs: 3, unaffected: 0, noticedAndRight: 1, noticed: 0, confidentlyWrong: 1, notApplied: 1, noComparison: 0 });
  assert.deepEqual(report.byOverlay.find((g) => g.overlay === 'Hidden: prior imaging and its reports'), { overlay: 'Hidden: prior imaging and its reports', runs: 2, right: 1, noticed: 1, confidentlyWrong: 1, notApplied: 0 });
  assert.equal((await s.call('GET', '/agent-ops/ablation?agentId=inbox-triager')).json.rows.length, 0);
  assert.equal((await s.call('GET', '/fhir/R4/DiagnosticReport')).json.total, 1, 'only the clinician\'s report is on the live chart');
  await s.close();
});

test(`[${BACKEND}] overlays from the launcher: shadow and training attempts can run with data hidden`, async () => {
  const { s, study } = await setup();
  const st = await study('Follow-up of known mass');
  const run = (await s.call('POST', '/agent-ops/agents/report-drafter/run', { mode: 'shadow-task', subject: `ImagingStudy/${st.id}`, overlays: [{ type: 'hide', what: 'priors' }] })).json;
  assert.deepEqual([run.status, run.overlays, run.result.flags[0].code], ['completed', [{ type: 'hide', what: 'priors' }], 'missing-data']);
  const listed = (await s.call('GET', '/agent-ops/ablation')).json.rows.find((r) => r.runId === run.id);
  assert.deepEqual([listed.baseline, listed.verdict, listed.noticed], [null, 'no-comparison', true], 'a one-off run with overlays is listed without a comparison');
  assert.equal((await s.call('POST', '/agent-ops/ablation/run', { agentId: 'report-drafter', subject: `ImagingStudy/${st.id}`, overlays: [] })).status, 422);
  assert.equal((await s.call('POST', '/agent-ops/ablation/run', { agentId: 'report-drafter', subject: 'ImagingStudy/none', overlays: [{ type: 'hide', what: 'labs' }] })).status, 422);
  const sandbox = (await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'report-drafter' })).json;
  assert.equal((await s.call('POST', '/agent-ops/ablation/run', { agentId: 'report-drafter', subject: `ImagingStudy/${st.id}`, overlays: [{ type: 'hide', what: 'labs' }] }, { 'X-Agent-Id': 'report-drafter', 'X-Run-Id': sandbox.id, 'Idempotency-Key': 'a1' })).status, 403);
  await s.close();
});
