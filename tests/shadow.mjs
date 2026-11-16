// Evaluate → Shadow (§9c): task shadow, event shadow and the comparison.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, testClock, patient, BACKEND } from './support/helpers.mjs';
import { classifyImpression, comparePaths } from '../agent-operations/server/shadow.mjs';

const rad = { 'X-Role': 'physician', 'X-User-Id': 'dr-reader' };
const T = 'urn:hospital-desktop:report-technique';
const F = 'urn:hospital-desktop:report-findings';

async function setup() {
  const clock = testClock('2026-04-01T09:00:00.000Z');
  const s = await startTestServer({ clock });
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Shadow'))).json;
  const study = async (reason, started = '2026-04-01T08:30:00Z') => (await s.call('POST', '/fhir/R4/ImagingStudy', {
    resourceType: 'ImagingStudy', status: 'available', subject: { reference: `Patient/${p.id}` }, started, description: 'Chest X-ray',
    modality: [{ system: 'http://dicom.nema.org/resources/ontology/DCM', code: 'DX' }], reasonCode: [{ text: reason }], numberOfSeries: 1, numberOfInstances: 2,
  }, { 'X-Role': 'nurse', 'X-User-Id': 'tech-one' })).json;
  const open = async (st) => { const r = await s.call('POST', `/api/pacs/studies/${st.id}/open`, {}, rad); assert.equal(r.status, 200); await s.agents.idle(); };
  const read = async (st, impression) => {
    const draft = (await s.call('POST', '/fhir/R4/DiagnosticReport', { resourceType: 'DiagnosticReport', status: 'preliminary', code: { text: 'Chest X-ray' }, subject: { reference: `Patient/${p.id}` }, imagingStudy: [{ reference: `ImagingStudy/${st.id}` }], conclusion: impression, extension: [{ url: T, valueString: 'PA and lateral' }, { url: F, valueString: 'As below' }] }, rad)).json;
    clock.advance(60_000);
    const signed = await s.call('POST', `/fhir/R4/DiagnosticReport/${draft.id}/$transition`, { to: 'final' }, rad);
    assert.equal(signed.status, 200, signed.text);
    return signed.json;
  };
  const runs = async () => (await s.call('GET', '/agent-ops/runs')).json.runs.filter((r) => r.id !== 'live');
  const shadow = async (agentId) => (await s.call('GET', `/agent-ops/shadow?agentId=${agentId}`)).json.agents[0];
  return { s, p, clock, study, open, read, runs, shadow };
}

test('impression classes and path comparison are deterministic', () => {
  assert.equal(classifyImpression('No acute cardiopulmonary abnormality.'), 'normal');
  assert.equal(classifyImpression('Lungs are clear. No pleural effusion or pneumothorax.'), 'normal');
  assert.equal(classifyImpression('Right lower lobe consolidation.'), 'abnormal');
  assert.equal(classifyImpression('No fracture. Small left pleural effusion.'), 'abnormal');
  assert.equal(classifyImpression(''), 'unknown');
  const step = (token) => ({ token, label: token, why: `why ${token}` });
  const same = comparePaths([step('read A'), step('write B')], [step('read A'), step('write B')]);
  assert.deepEqual([same.similarity, same.split], [1, null]);
  const diff = comparePaths([step('read A'), step('search B'), step('write B')], [step('read A'), step('write B'), step('sign B')]);
  assert.equal(diff.split.step, 2);
  assert.equal(diff.split.agent.why, 'why search B');
  assert.equal(diff.similarity, 0.67);
  assert.equal(comparePaths([step('read A')], [step('read A'), step('write B')]).split.agent.did, 'Stopped here');
});

test(`[${BACKEND}] task shadow: opening a study forks the chart and the agent drafts out of sight`, async () => {
  const { s, p, clock, study, open, read, runs, shadow } = await setup();
  const normal = await study('Cough for two weeks');
  await open(normal);
  let all = await runs();
  assert.equal(all.length, 1);
  const run = all[0];
  assert.deepEqual([run.mode, run.agentId, run.status, run.subject, run.trigger.kind, run.trigger.actor], ['shadow-task', 'report-drafter', 'completed', `ImagingStudy/${normal.id}`, 'study-open', 'dr-reader']);
  assert.match(run.branch, /^shadow-/);
  assert.match(run.policyHash, /^[a-f0-9]{16}$/);
  assert.equal(run.result.label, 'normal');

  const drafts = await s.store.query('DiagnosticReport', {}, { branch: run.branch });
  assert.equal(drafts.length, 1);
  assert.deepEqual([drafts[0].status, drafts[0]._shadow, drafts[0]._branch, Boolean(drafts[0]._released)], ['preliminary', true, run.branch, false]);
  assert.equal((await s.call('GET', `/fhir/R4/DiagnosticReport?patient=${p.id}`, undefined, rad)).json.total, 0, 'hidden from clinicians');
  assert.equal((await s.call('GET', `/api/pacs/studies/${normal.id}`, undefined, rad)).json.report, null);
  assert.equal((await s.call('GET', `/fhir/R4/Task`)).json.total, 0);

  const trace = (await s.call('GET', `/agent-ops/trace?runId=${run.id}`)).json.steps;
  assert.deepEqual(trace.map((t) => t.did.type), ['run.start', 'turn.start', 'fhir.read', 'chart.open', 'fhir.search', 'fhir.create', 'system.derive', 'turn.end', 'run.end']);
  assert.ok(trace.filter((t) => t.who.kind === 'agent' && t.did.type !== 'run.end' && t.did.type !== 'system.derive').every((t) => t.why), 'every agent step says why');
  assert.match(trace[5].why, /did not analyse the images/);
  assert.ok(trace.slice(1, -1).every((t) => t.saw.branch === run.branch));

  await open(normal);
  assert.equal((await runs()).length, 1, 'reopening the same study does not start a second shadow');

  clock.advance(120_000);
  await read(normal, 'No acute cardiopulmonary abnormality.');
  const flagged = await study('Follow-up of right upper lobe nodule', '2026-04-01T08:45:00Z');
  await open(flagged);
  clock.advance(30_000);
  await read(flagged, 'Lungs are clear. No nodule seen.');
  const pending = await study('Shortness of breath', '2026-04-01T08:50:00Z');
  await open(pending);

  const g = await shadow('report-drafter');
  assert.deepEqual([g.summary.runs, g.summary.compared, g.summary.awaitingClinician, g.summary.agree, g.summary.agreementRate], [3, 2, 1, 1, 0.5]);
  const byStudy = (st) => g.cases.find((c) => c.subject === `ImagingStudy/${st.id}`);
  const a = byStudy(normal);
  assert.deepEqual([a.status, a.outcome.agent, a.outcome.human, a.outcome.agree], ['compared', 'normal', 'normal', true]);
  assert.deepEqual([a.cost.agentSeconds, a.cost.humanSeconds, a.cost.timeDeltaSeconds], [0, 180, -180]);
  assert.deepEqual(a.path.human, ['Read the imaging study', 'Wrote the report', 'Signed the report']);
  assert.deepEqual(a.path.agent, ['Read the imaging study', 'Read the patient chart', 'Looked up the report', 'Wrote the report']);
  assert.equal(a.path.split.step, 2);
  assert.equal(a.path.split.agent.why, 'Confirm which patient this study belongs to');
  assert.equal(a.path.split.human.did, 'Wrote the report');
  assert.deepEqual([a.cost.agentSteps, a.cost.humanSteps, a.cost.agentWrites, a.cost.humanWrites], [4, 3, 1, 2]);
  const b = byStudy(flagged);
  assert.deepEqual([b.outcome.agent, b.outcome.human, b.outcome.agree], ['abnormal', 'normal', false]);
  assert.equal(byStudy(pending).status, 'awaiting-clinician');
  assert.equal(g.summary.meanTimeDeltaSeconds, -135);

  const signedStudy = await s.call('POST', `/api/pacs/studies/${normal.id}/open`, {}, rad);
  assert.equal(signedStudy.status, 200);
  await s.agents.idle();
  assert.equal((await runs()).length, 3, 'a study that is already reported is not shadowed');
  await s.close();
});

test(`[${BACKEND}] the fork is taken when the clinician starts: the agent cannot see later work`, async () => {
  const { s, p, clock, study, open, read } = await setup();
  const st = await study('Cough');
  await open(st);
  clock.advance(1000);
  const signed = await read(st, 'Left lower lobe pneumonia.');
  const run = (await s.call('GET', '/agent-ops/runs')).json.runs.find((r) => r.mode === 'shadow-task');
  const seen = await s.call('GET', `/fhir/R4/DiagnosticReport?patient=${p.id}&_branch=${run.branch}`);
  assert.deepEqual(seen.json.entry.map((e) => e.resource.status), ['preliminary'], 'only the agent draft exists on the fork');
  assert.equal((await s.call('GET', `/fhir/R4/DiagnosticReport/${signed.id}?_branch=${run.branch}`)).status, 404);
  await s.close();
});

test(`[${BACKEND}] event shadow: a patient message is triaged on a shadow branch and compared with the clinician`, async () => {
  const { s, p, clock, shadow } = await setup();
  const send = async (text) => {
    const r = await s.call('POST', '/fhir/R4/Communication', { resourceType: 'Communication', status: 'completed', subject: { reference: `Patient/${p.id}` }, sender: { reference: `Patient/${p.id}` }, sent: clock.now(), topic: { text: 'Question' }, payload: [{ contentString: text }] }, { 'X-Role': 'patient', 'X-User-Id': `Patient/${p.id}` });
    assert.equal(r.status, 201);
    await s.agents.idle();
    return r.json;
  };
  const decide = async (message, label) => {
    const t = (await s.call('POST', '/fhir/R4/Task', { resourceType: 'Task', status: 'requested', intent: 'order', code: { coding: [{ system: 'urn:hospital-desktop:task', code: 'message-triage' }] }, focus: { reference: `Communication/${message.id}` }, for: { reference: `Patient/${p.id}` }, output: [{ type: { text: 'triage-label' }, valueString: label }] })).json;
    await s.call('POST', `/fhir/R4/Task/${t.id}/$transition`, { to: 'completed' });
  };
  const urgent = await send('I have had chest pain since this morning.');
  const routine = await send('Can I get a refill of my medication?');
  await s.call('POST', '/fhir/R4/Communication', { resourceType: 'Communication', status: 'completed', subject: { reference: `Patient/${p.id}` }, sender: { display: 'Dr Reply' }, payload: [{ contentString: 'Reply from the care team' }] });
  await s.agents.idle();

  const runs = (await s.call('GET', '/agent-ops/runs')).json.runs.filter((r) => r.mode === 'shadow-event');
  assert.equal(runs.length, 2, 'only patient messages trigger the triager');
  assert.ok(runs.every((r) => r.status === 'completed' && r.agentId === 'inbox-triager'));
  assert.equal((await s.call('GET', '/fhir/R4/Task')).json.total, 0, 'shadow Tasks never reach the Inbox');
  const proposal = (await s.store.query('Task', {}, { branch: runs.find((r) => r.subject === `Communication/${urgent.id}`).branch }))[0];
  assert.deepEqual([proposal._shadow, proposal.status, proposal.intent, proposal.priority, proposal.output[0].valueString], [true, 'requested', 'proposal', 'urgent', 'urgent']);
  assert.match(proposal.output[1].valueString, /emergency/);

  clock.advance(300_000);
  await decide(urgent, 'urgent');
  await decide(routine, 'low');
  const g = await shadow('inbox-triager');
  assert.deepEqual([g.summary.runs, g.summary.compared, g.summary.agree, g.summary.agreementRate], [2, 2, 1, 0.5]);
  const u = g.cases.find((c) => c.subject === `Communication/${urgent.id}`);
  assert.deepEqual([u.outcome.agent, u.outcome.human, u.outcome.agree, u.cost.humanSeconds], ['urgent', 'urgent', true, 300]);
  const r = g.cases.find((c) => c.subject === `Communication/${routine.id}`);
  assert.deepEqual([r.outcome.agent, r.outcome.human, r.outcome.agree], ['routine', 'low', false]);
  assert.ok(r.path.agent.includes('Looked up the medication list'));
  await s.close();
});

test(`[${BACKEND}] shadow respects the registry toggles and the kill switches`, async () => {
  const { s, study, open, runs } = await setup();
  await s.call('PUT', '/agent-ops/agents/report-drafter', { shadow: { event: false, task: false } });
  await open(await study('Cough'));
  assert.equal((await runs()).length, 0, 'switched off in the registry');
  await s.call('PUT', '/agent-ops/agents/report-drafter', { shadow: { event: false, task: true } });
  await s.call('POST', '/agent-ops/kill-switches', { scope: 'mode', target: 'shadow-task', engaged: true });
  await open(await study('Cough', '2026-04-01T08:40:00Z'));
  assert.equal((await runs()).length, 0, 'stopped by the mode kill switch');
  await s.call('POST', '/agent-ops/kill-switches', { scope: 'mode', target: 'shadow-task', engaged: false });
  await open(await study('Cough', '2026-04-01T08:41:00Z'));
  assert.equal((await runs()).length, 1);
  await s.close();
});

test(`[${BACKEND}] the launcher can start a shadow run by hand`, async () => {
  const { s, study } = await setup();
  const st = await study('Follow-up of known mass');
  const run = (await s.call('POST', '/agent-ops/agents/report-drafter/run', { mode: 'shadow-task', subject: `ImagingStudy/${st.id}`, friction: 'high' })).json;
  assert.deepEqual([run.status, run.trigger.kind, run.friction, run.result.label], ['completed', 'manual', 'high', 'abnormal']);
  assert.equal((await s.call('POST', '/agent-ops/agents/report-drafter/run', { mode: 'shadow-task', subject: 'ImagingStudy/missing' })).status, 422);
  assert.equal((await s.call('POST', '/agent-ops/agents/report-drafter/run', { mode: 'hitl', subject: `ImagingStudy/${st.id}` })).status, 403, 'not promoted: no proposals on the live chart');
  assert.equal((await s.call('POST', '/agent-ops/agents/report-drafter/run', { mode: 'rl-generate', subject: `ImagingStudy/${st.id}` })).status, 422);
  const wrong = (await s.call('POST', '/agent-ops/agents/inbox-triager/run', { mode: 'sandbox', subject: `ImagingStudy/${st.id}` })).json;
  assert.equal(wrong.status, 'failed', 'an agent given the wrong kind of subject fails cleanly');
  await s.close();
});
