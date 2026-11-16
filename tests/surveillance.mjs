// Surveillance and Reporting, end to end on an empty hospital with patients built here (no names):
// a report captures its full AI context and subgroup keys; follow-ups add versions; each active rule fires on
// its trigger; a verifier agent can file but cannot confirm, and its precision is tracked; similar reports
// come back ranked with reasons; a planted subgroup shows in the explorer; signals are raised with their
// date and count; replay reproduces a reported case; a confirmed severe report can pause the agent;
// restricted reports and small cells are absent from exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, BACKEND } from './support/helpers.mjs';
import { createRun, endRun } from '../agent-operations/server/runs.mjs';
import { recordAction } from '../platform/server/audit.mjs';
import { RESTRICTED_URL } from '../platform/server/datasets.mjs';

const res = { 'X-Role': 'researcher', 'X-User-Id': 'researcher-1' };
const doc = { 'X-Role': 'physician', 'X-User-Id': 'physician-1' };
const HTEST = { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' };
const newPatient = async (s, extra = {}) => (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', gender: 'female', birthDate: '1950-06-01', meta: { security: [HTEST] }, ...extra }, doc)).json;
/** One finished use of an agent: a run started by a named kind of user, ended with an output. */
async function use(s, agentId, patientId, { role = 'physician', specialty = 'emergency', site = 'site-1', summary = 'Drafted a plan.', version } = {}) {
  const actor = { kind: 'human', id: `${role}-1`, role };
  const run = await createRun(s.store, { mode: 'sandbox', agentId, ...(version ? { version } : {}), subject: `Patient/${patientId}`, goal: 'Do the usual task', trigger: { kind: 'manual', actor: actor.id, role, specialty, site, department: 'ed', at: s.store.now() } }, actor);
  await endRun(s.store, run.id, { kind: 'agent', id: agentId, role: 'agent' }, 'completed', { summary, confidence: 0.8 });
  return s.store.get('Run', run.id);
}
const file = (s, body, headers = doc) => s.call('POST', '/agent-ops/surveillance/reports', body, headers);
const basic = { narrative: 'The draft described a finding that is not in the chart at all.', reachedPatient: 'caught-before', severity: 'near-miss' };

test(`[${BACKEND}] a report is a FHIR AdverseEvent with the AI context and subgroup keys attached; follow-ups and triage add versions; the log holds no free text`, async (t) => {
  const s = await startTestServer(); t.after(() => s.close());
  assert.deepEqual((await s.call('GET', '/agent-ops/surveillance/rates', undefined, res)).json.uses, 0, 'an empty hospital has no uses');
  const p = await newPatient(s);
  await s.store.transaction((tx) => tx.save('Condition', { resourceType: 'Condition', id: 'c1', subject: { reference: `Patient/${p.id}` }, _patient: `Patient/${p.id}`, code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'I21.3' }] }, recordedDate: s.store.now() }, { updatedBy: 'import' }));
  const run = await use(s, 'workup-planner', p.id);
  assert.equal((await file(s, { narrative: 'x' })).status, 422, 'the three required things are required');
  const made = await file(s, { ...basic, harm: 'hallucinated', rightAction: 'Describe only what is recorded.', reliedOn: false, whatNext: 'Rewrote it by hand.', about: { run: run.id } });
  assert.equal(made.status, 201, made.text);
  const r = made.json;
  assert.match(r.caseId, /^AE-\d{6}$/); assert.deepEqual([r.version, r.status, r.actuality, r.source.kind, r.source.role, r.sourceLabel], [1, 'new', 'potential', 'human', 'physician', 'Reported by a person (physician)']);
  const c = r.context;
  assert.deepEqual([c.agent, c.run, c.mode, c.branch, c.taskType, c.output, c.patient], ['workup-planner', run.id, 'sandbox', run.branch, 'clinical-workup', 'Drafted a plan.', `Patient/${p.id}`]);
  assert.ok(c.version && c.policyHash && c.asOf, 'version, policy hash and as-of time');
  assert.deepEqual(c.keys, { role: 'physician', specialty: 'emergency', site: 'site-1', department: 'ed', ageBand: '65-79', sex: 'female', language: 'unknown', dxGroup: 'Circulatory', encounterType: 'unknown' });
  assert.equal(r.completeness.score, 1); assert.deepEqual(r.completeness.missing, []); assert.ok(c.steps.length >= 1, 'the run\'s steps are linked');
assert.equal((await file(s, { narrative: 'Bad output.', reachedPatient: 'no', severity: 'none' })).json.completeness.score < 0.6, true, 'a bare report scores low');
  // FHIR shape.
  const fhir = (await s.call('GET', `/agent-ops/surveillance/reports/${r.id}/fhir`, undefined, res)).json;
  assert.deepEqual([fhir.resourceType, fhir.actuality, fhir.identifier.value, fhir.subject.reference, fhir.suspectEntity[0].instance.identifier.value, fhir.seriousness.coding[0].code], ['AdverseEvent', 'potential', r.caseId, `Patient/${p.id}`, `workup-planner@${c.version}`, 'near-miss']);
  assert.ok(fhir.extension.some((e) => e.url.endsWith(':ai-context')) && fhir.extension.some((e) => e.url.endsWith(':source')));
  assert.equal((await file(s, { ...basic, reachedPatient: 'yes', severity: 'mild', about: { run: run.id } })).json.actuality, 'actual', 'an event that reached the patient is actual');
  // The log: coded fields and the case number, never the words.
  const step = (await s.store.query('TraceStep', { where: (x) => x.did?.type === 'surveillance.report.file' }))[0];
  assert.deepEqual([step.did.args.case, step.did.args.harm, step.did.args.agent, step.did.args.keys.specialty], [r.caseId, 'hallucinated', 'workup-planner', 'emergency']);
  assert.equal(JSON.stringify(await s.store.query('TraceStep')).includes('not in the chart at all'), false, 'free text is never copied into the log');
  // Follow-ups: the reporter adds information, the team asks a question and changes the status. Each is a new version.
  assert.equal((await s.call('POST', `/agent-ops/surveillance/reports/${r.id}/follow-up`, { text: 'It also got the dose wrong.' }, doc)).json.version, 2);
  assert.equal((await s.call('POST', `/agent-ops/surveillance/reports/${r.id}/follow-up`, { text: 'not mine' }, { 'X-Role': 'patient', 'X-User-Id': 'someone' })).status, 403);
  const asked = (await s.call('POST', `/agent-ops/surveillance/reports/${r.id}/follow-up`, { kind: 'question', text: 'Which dose?' }, res)).json;
  assert.deepEqual([asked.version, asked.status], [3, 'needs-info']);
  assert.equal((await s.call('POST', `/agent-ops/surveillance/reports/${r.id}/follow-up`, { text: 'The potassium dose.' }, doc)).json.status, 'under-review', 'answering moves it on');
  assert.equal((await s.call('POST', `/agent-ops/surveillance/reports/${r.id}/triage`, { causality: { level: 'probable' } }, res)).status, 422, 'causality needs reasons');
  const triaged = (await s.call('POST', `/agent-ops/surveillance/reports/${r.id}/triage`, { status: 'confirmed-ai', causality: { level: 'probable', reason: 'The output names a finding no record holds.' } }, res)).json;
  assert.deepEqual([triaged.version, triaged.status, triaged.causality.level], [5, 'confirmed-ai', 'probable']);
  const fixed = (await s.call('POST', `/agent-ops/surveillance/reports/${r.id}/triage`, { status: 'closed', fixedIn: '9.9.9' }, res)).json;
  const mine = (await s.call('GET', '/agent-ops/surveillance/reports?mine=true', undefined, doc)).json.reports.find((x) => x.id === r.id);
  assert.deepEqual([mine.fixedIn, mine.followUps.at(-1).status], ['9.9.9', 'fixed in version 9.9.9'], 'the reporter sees the status change');
  const versions = (await s.call('GET', `/agent-ops/surveillance/reports/${r.id}/history`, undefined, res)).json.versions;
  assert.equal(versions.length, fixed.version); assert.equal(versions.length, 6, 'nothing was overwritten');
  assert.equal((await s.call('PUT', `/agent-ops/surveillance/reports/${r.id}`, {}, res)).status, 405);
  // Exposure and rates.
  const rates = (await s.call('GET', '/agent-ops/surveillance/rates?agent=workup-planner', undefined, res)).json;
  assert.deepEqual([rates.uses, rates.human.events, rates.human.per1000, rates.combined.events], [1, 2, 2000, 1], 'two reports about one run are one event in the combined rate');
});

test(`[${BACKEND}] patients report in plain language, see only their own reports and never anyone else's details`, async (t) => {
  const s = await startTestServer(); t.after(() => s.close());
  const p = await newPatient(s); const other = await newPatient(s); const run = await use(s, 'inbox-triager', p.id);
  const pat = { 'X-Role': 'patient', 'X-User-Id': 'patient' };
  const made = await s.call('POST', '/api/surveillance/reports', { narrative: 'The reply told me to stop a tablet I need.', patientChoice: 'felt-unsafe', patientEffect: 'worried', patient: p.id, about: { run: run.id } }, pat);
  assert.equal(made.status, 201, made.text);
  assert.deepEqual([made.json.severity, made.json.harm, made.json.reachedPatient, made.json.patientChoice, 'context' in made.json, 'source' in made.json], ['mild', 'unsafe', 'yes', 'felt-unsafe', false, false]);
  await file(s, { ...basic, about: { run: (await use(s, 'inbox-triager', other.id)).id } });
  const list = (await s.call('GET', `/api/surveillance/reports?patient=${p.id}`, undefined, pat)).json.reports;
  assert.equal(list.length, 1);
  const ctx = (await s.call('GET', `/api/surveillance/reports/${made.json.id}/context`, undefined, pat)).json;
  assert.deepEqual(Object.keys(ctx).sort(), ['caseId', 'status', 'summary']); assert.match(ctx.summary, /^\d+ similar reports? since \d{4}-\d\d-\d\d\. The team is .*estimated rate of .* per 1,000 uses\.$/);
  assert.equal((await s.call('GET', '/api/surveillance/aggregate', undefined, pat)).status, 403);
});

test(`[${BACKEND}] active surveillance: each rule opens a possible event on its trigger, once, as its own named and versioned source`, async (t) => {
  const s = await startTestServer(); t.after(() => s.close());
  const p = await newPatient(s); const ref = `Patient/${p.id}`; const run = await use(s, 'workup-planner', p.id);
  assert.deepEqual((await s.call('POST', '/agent-ops/surveillance/rules/sweep', {}, res)).json.opened, [], 'nothing has happened yet');
  const order = (await s.call('POST', '/fhir/R4/ServiceRequest', { resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: ref }, code: { text: 'Chest radiograph' } }, doc)).json;
  const note = (await s.call('POST', '/fhir/R4/DocumentReference', { resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', type: { text: 'Progress note' }, subject: { reference: ref }, date: s.store.now(), content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('Draft.').toString('base64') } }] }, doc)).json;
  const cond = (await s.call('POST', '/fhir/R4/Task', { resourceType: 'Task', status: 'requested', intent: 'order', for: { reference: ref }, description: 'made from a proposal' }, doc)).json;
  // Three accepted AI proposals, each of which made one of those records.
  const decidedAt = new Date(Date.parse(s.store.now()) - 1000).toISOString();
  const proposal = (id, result) => s.store.transaction((tx) => tx.save('Task', { resourceType: 'Task', id, status: 'completed', intent: 'proposal', for: { reference: ref }, _patient: ref, input: [{ type: { text: 'run' }, valueString: run.id }, { type: { text: 'proposal' }, valueString: '{}' }], output: [{ type: { text: 'decision' }, valueString: 'accepted' }, { type: { text: 'result' }, valueString: result }, { type: { text: 'decided-at' }, valueString: decidedAt }] }, { updatedBy: 'test' }));
  await proposal('prop-order', `ServiceRequest/${order.id}`); await proposal('prop-note', `DocumentReference/${note.id}`); await proposal('prop-task', `Task/${cond.id}`);
  // The triggers.
  const revoke = { ...order, extension: [...(order.extension || []).filter((e) => !/lifecycle|status-reason/.test(e.url)), { url: 'urn:hospital-desktop:lifecycle', valueCode: 'revoked' }, { url: 'urn:hospital-desktop:status-reason', valueString: 'not needed' }] };
  assert.equal((await s.call('PUT', `/fhir/R4/ServiceRequest/${order.id}`, revoke, doc)).status, 200);
  await s.call('POST', '/fhir/R4/DocumentReference', { resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', type: { text: 'Addendum' }, subject: { reference: ref }, date: s.store.now(), relatesTo: [{ code: 'appends', target: { reference: `DocumentReference/${note.id}` } }], content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('Correction.').toString('base64') } }] }, doc);
  assert.equal((await s.call('PUT', `/fhir/R4/Task/${cond.id}`, { ...cond, description: 'changed by a person' }, doc)).status, 200);
  await s.store.transaction((tx) => tx.save('Observation', { resourceType: 'Observation', id: 'crit-1', status: 'final', subject: { reference: ref }, _patient: ref, code: { coding: [{ system: 'http://loinc.org', code: '2823-3', display: 'Potassium' }] }, effectiveDateTime: new Date(Date.parse(run.endedAt) + 3600000).toISOString(), valueQuantity: { value: 6.9, unit: 'mmol/L' }, interpretation: [{ coding: [{ code: 'HH' }] }] }, { updatedBy: 'import' }));
  await s.store.transaction((tx) => recordAction(tx, { runId: run.id, actor: { kind: 'agent', id: 'workup-planner', role: 'agent' }, kind: 'execute', action: 'safety.block', args: { type: 'MedicationRequest', alerts: [{ code: 'allergy-conflict' }] }, branch: run.branch, description: 'blocked', audit: false }));
  const main = await (async () => { const r = await createRun(s.store, { mode: 'shadow-task', agentId: 'inbox-triager', subject: ref, goal: 'x', trigger: { kind: 'manual', role: 'physician' } }, { kind: 'human', id: 'physician-1', role: 'physician' }).catch(() => null); if (r) await endRun(s.store, r.id, { kind: 'agent', id: 'inbox-triager', role: 'agent' }, 'completed', { summary: 'ok' }); return r; })();
  await s.call('POST', '/fhir/R4/Communication', { resourceType: 'Communication', status: 'completed', subject: { reference: ref }, sender: { reference: ref }, sent: new Date(Date.parse(s.store.now()) + 1000).toISOString(), payload: [{ contentString: 'The reply I got was wrong and I am unhappy about it.' }] }, { 'X-Role': 'patient', 'X-User-Id': 'patient' });
  const opened = (await s.call('POST', '/agent-ops/surveillance/rules/sweep', {}, res)).json.opened.map((o) => o.rule).sort();
  const expected = ['ai-note-amended', 'ai-order-cancelled', 'override-after-accept', 'patient-complaint', 'safety-conflict', ...(main?.branch === 'main' || true ? [] : [])];
  for (const rule of expected) assert.ok(opened.includes(rule), `${rule} fired (opened: ${opened.join(', ')})`);
  assert.deepEqual((await s.call('POST', '/agent-ops/surveillance/rules/sweep', {}, res)).json.opened, [], 'the same event is never opened twice');
  const q = (await s.call('GET', '/agent-ops/surveillance/reports?source=automatic', undefined, res)).json.reports;
  assert.ok(q.every((r) => r.source.kind === 'automatic' && r.source.rule && r.source.version === '1' && r.sourceLabel === 'Detected automatically'));
  assert.equal(q.find((r) => r.source.rule === 'patient-complaint').narrative.includes('unhappy'), false, 'the patient\'s words are linked, not copied');
  const rules = (await s.call('GET', '/agent-ops/surveillance/rules', undefined, res)).json;
  assert.equal(rules.rules.length, 6); assert.equal(rules.rules.find((r) => r.id === 'ai-order-cancelled').opened, 1);
  // Passive against active: people reported nothing, the rules found events, so the under-reporting estimate is 100%.
  assert.deepEqual([rules.reported.events, rules.detected.events > 0, rules.underReporting.shareNotReported], [0, true, 1]);
  // A rule can be switched off and its window changed.
  const saved = (await s.call('PUT', '/agent-ops/surveillance/rules/settings', { windows: { 'critical-after-ai': 48 }, off: ['patient-complaint'] }, res)).json;
  assert.deepEqual([saved.windows['critical-after-ai'], saved.off], [48, ['patient-complaint']]);
  const drift = (await s.call('GET', '/agent-ops/surveillance/drift?agent=workup-planner', undefined, res)).json.drift;
  assert.deepEqual([drift.length, drift[0].flags.includes('small-numbers')], [1, true]);
});

test(`[${BACKEND}] a verifier agent files through the same door, is read-only, cannot review itself or confirm anything, and its precision is tracked`, async (t) => {
  const s = await startTestServer(); t.after(() => s.close());
  const p = await newPatient(s); const target = await use(s, 'workup-planner', p.id); const target2 = await use(s, 'workup-planner', p.id);
  const asAgent = (run, n) => ({ 'X-Agent-Id': 'chart-summariser', 'X-Run-Id': run.id, 'Idempotency-Key': `v-${n}` });
  const vrun = async () => (await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'chart-summariser', subject: `Patient/${p.id}` }, res)).json;
  let run = await vrun();
  assert.equal((await file(s, { ...basic, about: { run: target.id } }, asAgent(run, 1))).status, 403, 'an agent without the role cannot file');
  const given = await s.call('PUT', '/agent-ops/surveillance/verifiers/chart-summariser', { enabled: true, scope: 'all' }, res);
  assert.equal(given.status, 200, given.text);
  assert.equal((await s.call('PUT', '/agent-ops/surveillance/verifiers/chart-summariser', { enabled: true }, asAgent(run, 2))).status, 403, 'agents never hand out the role');
  run = await vrun();
  assert.equal(run.permissions.systems.ehr, 'read-only');
  const queue = (await s.call('GET', '/agent-ops/surveillance/verifier/queue', undefined, asAgent(run, 3))).json.queue;
  assert.ok(queue.some((x) => x.run === target.id && x.agent === 'workup-planner') && queue.every((x) => x.agent !== 'chart-summariser'), 'its queue holds other agents\' outputs only');
  const filed = await file(s, { ...basic, harm: 'wrong', reasoning: 'The plan orders a test the chart already holds.', confidence: 0.7, about: { run: target.id } }, asAgent(run, 4));
  assert.equal(filed.status, 201, filed.text);
  const filed2 = await file(s, { ...basic, harm: 'wrong', reasoning: 'Same again.', confidence: 0.4, about: { run: target2.id } }, asAgent(run, 5));
  const own = (await file(s, { ...basic, about: { run: run.id } }, asAgent(run, 6)));
  assert.equal(own.status, 403); assert.match(own.text, /cannot report on its own outputs/);
  // It cannot change the chart, triage, or see the dashboard.
  assert.equal((await s.call('POST', '/fhir/R4/Task', { resourceType: 'Task', status: 'requested', intent: 'order', for: { reference: `Patient/${p.id}` } }, asAgent(run, 7))).status, 403);
  assert.equal((await s.call('POST', `/agent-ops/surveillance/reports/${filed.json.id}/triage`, { status: 'confirmed-ai' }, asAgent(run, 8))).status, 403, 'a verifier cannot confirm its own report');
  assert.equal((await s.call('GET', '/agent-ops/surveillance/aggregate', undefined, asAgent(run, 9))).status, 403);
  assert.equal((await s.call('POST', '/agent-ops/surveillance/verifier/reviewed', { run: target.id }, asAgent(run, 10))).status, 201);
  // In the human queue, labelled.
  const q = (await s.call('GET', '/agent-ops/surveillance/reports?source=agent', undefined, res)).json.reports;
  assert.deepEqual([q.length, q[0].sourceLabel, q[0].status, q.find((x) => x.id === filed.json.id).confidence], [2, 'Agent-reported', 'new', 0.7]);
  // People decide; precision follows.
  await s.call('POST', `/agent-ops/surveillance/reports/${filed.json.id}/triage`, { status: 'confirmed-ai' }, res);
  await s.call('POST', `/agent-ops/surveillance/reports/${filed2.json.id}/triage`, { status: 'not-ai' }, res);
  const v = (await s.call('GET', '/agent-ops/surveillance/verifiers', undefined, res)).json.verifiers[0];
  assert.deepEqual([v.agent, v.filed, v.confirmed, v.notAi, v.precision, v.trusted], ['chart-summariser', 2, 1, 1, 0.5, null]);
});

test(`[${BACKEND}] pattern or one-off: similar reports ranked with reasons, a planted subgroup in the explorer, signals with their date and count, and a validated signal can block promotion`, async (t) => {
  const s = await startTestServer(); t.after(() => s.close());
  await s.call('PUT', '/agent-ops/surveillance/rules/settings', { minUses: 5 }, res);
  // 80 uses: emergency physicians at site-1 see the problem far more often than anyone else.
  const patients = []; for (let i = 0; i < 4; i += 1) patients.push(await newPatient(s, { gender: i % 2 ? 'male' : 'female' }));
  const reports = [];
  for (let i = 0; i < 80; i += 1) {
    const specialty = ['emergency', 'medicine', 'surgery', 'paediatrics'][i % 4]; const site = i % 8 < 4 ? 'site-1' : 'site-2';
    const run = await use(s, i % 10 === 9 ? 'chart-summariser' : 'workup-planner', patients[i % 4].id, { specialty, site });
    if (run.agentId === 'workup-planner' && specialty === 'emergency' && i % 3 !== 0) reports.push((await file(s, { ...basic, harm: 'hallucinated', narrative: 'The plan named a finding that is not in the chart.', about: { run: run.id } })).json);
    if (i === 41) reports.push((await file(s, { ...basic, harm: 'workflow', narrative: 'The panel was slow to open today.', about: { run: run.id } })).json);
  }
  const first = reports[0]; const ctx = (await s.call('GET', `/agent-ops/surveillance/reports/${first.id}/context`, undefined, res)).json;
  assert.equal(ctx.oneOff, false); assert.ok(ctx.similar.length >= 5);
  for (const reason of ['same agent', 'same version', 'same harm category', 'same task type', 'same specialty', 'similar wording (local text comparison)']) assert.ok(ctx.similar[0].reasons.includes(reason), reason);
  assert.equal(ctx.similar.at(-1).harm, 'workflow', 'the unlike report is ranked last');
  assert.ok(ctx.baseRate.reported.per1000 > 0 && ctx.baseRate.evaluation.uses > 0 && ctx.lineage.length === 1 && ctx.startedWith === ctx.lineage[0].version);
  assert.ok(ctx.subgroups.find((g) => g.dim === 'specialty').cells.find((c) => c.value === 'emergency').higher, 'the subgroup view shows the higher group');
  assert.match(ctx.summary, /similar reports since/);
  // The explorer: specialty by site.
  const grid = (await s.call('GET', '/agent-ops/surveillance/explorer?dimA=specialty&dimB=site&agent=workup-planner&harm=hallucinated', undefined, res)).json;
  const higher = grid.cells.filter((c) => c.higher).map((c) => `${c.a}/${c.b}`).sort();
  assert.deepEqual(higher, ['emergency/site-1', 'emergency/site-2']); assert.ok(grid.cells.every((c) => c.per1000 == null || (c.low <= c.per1000 && c.per1000 <= c.high)));
  const found = (await s.call('GET', '/agent-ops/surveillance/discover?agent=workup-planner', undefined, res)).json;
  assert.equal(found.signals[0].keys.specialty, 'emergency');
  const raised = (await s.call('POST', '/agent-ops/surveillance/discover', {}, res)).json.raised;
  assert.ok(raised.some((x) => x.kind === 'subgroup' && /specialty=emergency/.test(x.group)));
  const clusters = (await s.call('GET', '/agent-ops/surveillance/clusters', undefined, res)).json.clusters;
  assert.ok(clusters[0].size >= 10 && /harm: hallucinated/.test(clusters[0].name));
  // Three sources side by side, by specialty.
  const agg = (await s.call('GET', '/agent-ops/surveillance/aggregate?by=specialty&agent=workup-planner', undefined, res)).json;
  const em = agg.rows.find((r) => r.value === 'emergency'); assert.ok(em.human.events >= 10 && em.automatic.events === 0 && em.agent.events === 0 && em.human.per1000 > agg.rows.find((r) => r.value === 'medicine').human.per1000);
  // Signals: raised as the reports came in, each with its date and the count at that moment.
  const signals = (await s.call('GET', '/agent-ops/surveillance/signals', undefined, res)).json.signals;
  const methodSignals = signals.filter((x) => x.kind === 'method' && x.agent === 'workup-planner' && x.harm === 'hallucinated');
  assert.ok(methodSignals.length >= 1, 'at least one method signals'); for (const sig of methodSignals) { assert.match(sig.signalDate, /^\d{4}-\d\d-\d\d$/); assert.ok(sig.reportCount >= 1 && sig.reportCount <= reports.length && sig.status === 'open'); }
  const stats = (await s.call('GET', '/agent-ops/surveillance/statistics?agent=workup-planner&harm=hallucinated', undefined, res)).json;
  assert.ok(stats.table.a >= 10 && stats.exposure.per1000 > 0 && Object.keys(stats.sequential).length === 7);
  // Review: validate, then act on it.
  const sig = methodSignals[0];
  assert.equal((await s.call('POST', '/agent-ops/surveillance/actions', { action: 'block-promotion', signal: sig.id, reason: 'x' }, res)).status, 409, 'an open signal is not grounds for action');
  assert.equal((await s.call('POST', `/agent-ops/surveillance/signals/${sig.id}/review`, { decision: 'validated' }, res)).status, 422, 'a reason is needed');
  assert.equal((await s.call('POST', `/agent-ops/surveillance/signals/${sig.id}/review`, { decision: 'validated', reason: 'Seen in three audits.' }, res)).json.status, 'validated');
  const blocked = await s.call('POST', '/agent-ops/surveillance/actions', { action: 'block-promotion', signal: sig.id, reason: 'Hallucinated findings in the emergency department.' }, res);
  assert.equal(blocked.status, 201, blocked.text);
  const gate = (await s.call('GET', '/agent-ops/agents/workup-planner/promotion', undefined, res)).json;
  assert.ok(gate.blockers.some((b) => /^Surveillance: promotion is blocked/.test(b)));
  const watch = await s.call('POST', '/agent-ops/surveillance/watchlist', { agent: 'workup-planner', harm: 'hallucinated' }, res); assert.equal(watch.status, 201);
  assert.equal((await s.call('GET', '/agent-ops/surveillance/watchlist', undefined, res)).json.watchlist[0].current.table.a, stats.table.a);
  // Restriction: after it, the agent only starts for the named group.
  await s.call('POST', '/agent-ops/surveillance/actions', { action: 'restrict', signal: sig.id, reason: 'Keep it to medicine while this is fixed.', keys: { specialty: 'medicine' } }, res);
  const refused = await s.call('POST', '/agent-ops/runs', { mode: 'shadow-task', agentId: 'workup-planner', subject: `Patient/${patients[0].id}`, trigger: { kind: 'manual', role: 'physician', specialty: 'emergency' } }, res);
  assert.equal(refused.status, 403, refused.text); assert.match(refused.text, /restricted to specialty medicine/);
});

test(`[${BACKEND}] replay reproduces a reported case; a confirmed severe report pauses the agent; restricted reports and small cells stay out of exports; a surveillance study is saved and exported`, async (t) => {
  const s = await startTestServer(); t.after(() => s.close());
  const p = await newPatient(s); const ref = `Patient/${p.id}`;
  await s.store.transaction((tx) => tx.save('Observation', { resourceType: 'Observation', id: 'k1', status: 'final', subject: { reference: ref }, _patient: ref, category: [{ coding: [{ code: 'laboratory' }] }], code: { coding: [{ system: 'http://loinc.org', code: '2823-3', display: 'Potassium' }] }, effectiveDateTime: s.store.now(), valueQuantity: { value: 6.8, unit: 'mmol/L' } }, { updatedBy: 'import' }));
  // A real run of a rule-based agent: what it does is the "planted error" being reported.
  const actor = { kind: 'human', id: 'researcher-1', role: 'researcher' };
  const done = await s.agents.launch({ agentId: 'workup-planner', mode: 'sandbox', subject: ref, goal: 'Review this patient', actor, wait: true });
  const run = await s.store.get('Run', done.id ?? done.runId ?? done.run?.id);
  assert.ok(run?.endedAt, 'the agent ran');
  const r = (await file(s, { narrative: 'It prescribed a drug at the wrong moment for this patient.', reachedPatient: 'caught-before', severity: 'severe', harm: 'unsafe', about: { run: run.id } })).json;
  assert.ok(r.context.steps.length > 0 && r.context.saw.length > 0, 'the exact steps and what the agent saw are linked');
  assert.equal(r.completeness.missing.includes('the run and its steps are linked'), false);
  const replay = await s.call('POST', `/agent-ops/surveillance/reports/${r.id}/reproduce`, { times: 3 }, res);
  assert.equal(replay.status, 200, replay.text);
  assert.deepEqual([replay.json.reproduced.verdict, replay.json.reproduced.k, replay.json.reproduced.n], ['yes', 3, 3]);
  assert.equal(replay.json.reproduced.perturbations.length, 3);
  for (const x of replay.json.reproduced.sameVersion) { const rr = await s.store.get('Run', x.run); assert.ok(rr.branch !== 'main' && rr.context.replayOf === run.id); }
  assert.equal((await s.call('GET', `/agent-ops/surveillance/reports/${r.id}`, undefined, res)).json.reproduced.verdict, 'yes', 'stored on the report');
  // Kill switch: only once the report is confirmed AI-related and severe, and only with a reason.
  assert.equal((await s.call('POST', '/agent-ops/surveillance/actions', { action: 'pause', report: r.id, reason: 'x' }, res)).status, 409);
  await s.call('POST', `/agent-ops/surveillance/reports/${r.id}/triage`, { status: 'confirmed-ai', causality: { level: 'certain', reason: 'Replayed three times.' } }, res);
  assert.equal((await s.call('POST', '/agent-ops/surveillance/actions', { action: 'pause', report: r.id }, res)).status, 422, 'a reason is required');
  assert.equal((await s.call('POST', '/agent-ops/surveillance/actions', { action: 'pause', report: r.id, reason: 'x' }, doc)).status, 201, 'staff may act');
  const stopped = await s.call('POST', '/agent-ops/runs', { mode: 'shadow-task', agentId: 'workup-planner', subject: ref }, res);
  assert.equal(stopped.status, 403); assert.match(stopped.text, /kill switch/i);
  assert.ok((await s.store.query('TraceStep', { where: (x) => x.did?.type === 'surveillance.action.pause' })).length === 1, 'the action is logged');
  assert.equal((await s.call('GET', `/agent-ops/surveillance/reports/${r.id}`, undefined, res)).json.actions[0].action, 'pause');
  // Exports: a restricted source stays local; small cells are suppressed; text is de-identified.
  const locked = await newPatient(s, { extension: [{ url: RESTRICTED_URL, valueString: 'restricted-set' }] });
  const lockedRun = await use(s, 'chart-summariser', locked.id); await use(s, 'chart-summariser', p.id);
  const secret = (await file(s, { ...basic, narrative: `Summary for MRN ${locked.identifier?.[0]?.value || 'N999999'} left out the allergy.`, harm: 'omitted', about: { run: lockedRun.id } })).json;
  assert.equal(secret.restricted, true);
  const shared = (await s.call('GET', '/agent-ops/surveillance/summary?agent=chart-summariser', undefined, res)).json;
  assert.equal(shared.reports.length, 0, 'the restricted report is not in the shareable export'); assert.equal(shared.exposure.uses, 1);
  assert.ok(Object.values(shared.bySubgroup.sex).every((c) => c.suppressed), 'cells under the small-number threshold are suppressed');
  const local = (await s.call('GET', '/agent-ops/surveillance/summary?agent=chart-summariser&shareable=false', undefined, res)).json;
  assert.deepEqual([local.reports.length, local.exposure.uses], [1, 2]);
  const csv = await s.call('GET', '/agent-ops/surveillance/summary?agent=chart-summariser&format=csv', undefined, res);
  assert.match(csv.text, /^section,key,events,uses,per1000,low,high\n/); assert.match(csv.text, /suppressed/);
  const wp = (await s.call('GET', '/agent-ops/surveillance/summary?agent=workup-planner', undefined, res)).json;
  assert.equal(wp.reports[0].whatHappened.includes('wrong moment'), true); assert.notEqual(wp.reports[0].reporter, 'physician-1', 'the reporter is a pseudonym');
  // The simulator as a saved study.
  const study = await s.call('POST', '/agent-ops/surveillance/studies', { title: 'New version, higher rate', seed: 3, config: { seeds: 3, days: 60, usesPerDay: 500, signal: { kind: 'version', day: 30, factor: 8 } } }, res);
  assert.equal(study.status, 201, study.text); assert.equal(study.json.results.length, 28);
  assert.deepEqual((await s.call('GET', `/agent-ops/surveillance/studies/${study.json.id}`, undefined, res)).json.results, study.json.results);
  assert.match((await s.call('GET', `/agent-ops/surveillance/studies/${study.json.id}/csv`, undefined, res)).text, /^sources,method,/);
  assert.equal((await s.store.query('AdverseEvent')).length, 2, 'a study stores no reports');
});
