// The agent safety envelope (§9b): every rule is enforced by the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, testClock, patient, BACKEND } from './support/helpers.mjs';

let keyCount = 0;
const key = () => `k-${process.pid}-${keyCount += 1}`;
const as = (agentId, run, extra = {}) => ({ 'X-Agent-Id': agentId, 'X-Run-Id': run.id, 'Idempotency-Key': key(), ...extra });
const report = (patientId, extra = {}) => ({ resourceType: 'DiagnosticReport', status: 'preliminary', code: { text: 'Chest X-ray' }, subject: { reference: `Patient/${patientId}` }, conclusion: 'Draft', ...extra });
const task = (extra = {}) => ({ resourceType: 'Task', status: 'requested', intent: 'proposal', code: { text: 'Message triage' }, ...extra });
const rules = async (s, run) => (await s.call('GET', `/agent-ops/trace?runId=${run.id}`)).json.steps.filter((t) => t.did.type === 'envelope.reject').map((t) => t.did.args.rule);

async function setup(options = {}) {
  const s = await startTestServer(options);
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Envelope'))).json;
  const start = async (agentId, mode = 'sandbox') => {
    const r = await s.call('POST', '/agent-ops/runs', { mode, agentId });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return r.json;
  };
  return { s, p, start };
}

test(`[${BACKEND}] reference agents are registered with version, policy hash and declared scopes`, async () => {
  const { s } = await setup();
  const { agents } = (await s.call('GET', '/agent-ops/agents')).json;
  assert.deepEqual(agents.map((a) => a.id).sort(), ['chart-summariser', 'inbox-triager', 'note-scribe', 'report-drafter', 'workup-planner']);
  for (const a of agents) {
    assert.match(a.policyHash, /^[a-f0-9]{16}$/);
    assert.equal(a.adapter.kind, 'stub');
    assert.ok(a.scopes.length && a.version && a.enabled);
  }
  const bad = async (body) => (await s.call('POST', '/agent-ops/agents', { id: 'x-agent', name: 'X', version: '1', adapter: { kind: 'stub', stub: 'report-drafter' }, scopes: [], ...body })).status;
  assert.equal(await bad({ scopes: [{ type: 'Patient', interactions: ['update'] }] }), 422, 'no agent can be given Patient scope');
  assert.equal(await bad({ scopes: [{ type: 'AuditEvent', interactions: ['create'] }] }), 422);
  assert.equal(await bad({ scopes: [{ type: 'Task', interactions: ['delete'] }] }), 422);
  assert.equal(await bad({ adapter: { kind: 'python' } }), 422);
  assert.equal(await bad({ id: 'report-drafter' }), 409, 'ids are unique');
  assert.equal((await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'nobody' })).status, 422, 'a run needs a registered agent');
  await s.close();
});

test(`[${BACKEND}] scope whitelist: an agent can only write the resource types and interactions it declared`, async () => {
  const { s, p, start } = await setup();
  const run = await start('report-drafter');
  const ok = await s.call('POST', '/fhir/R4/DiagnosticReport', report(p.id), as('report-drafter', run));
  assert.equal(ok.status, 201);
  assert.equal((await s.store.get('DiagnosticReport', ok.json.id, { branch: run.branch }))._branch, run.branch);
  assert.equal((await s.call('GET', `/fhir/R4/DiagnosticReport/${ok.json.id}`)).status, 404, 'invisible on main');

  const outOfScope = await s.call('POST', '/fhir/R4/Task', task(), as('report-drafter', run));
  assert.equal(outOfScope.status, 403);
  assert.equal(outOfScope.json.resourceType, 'OperationOutcome');
  assert.match(outOfScope.json.issue[0].diagnostics, /not allowed to create Task/);

  const triage = await start('inbox-triager');
  const made = await s.call('POST', '/fhir/R4/Task', task(), as('inbox-triager', triage));
  assert.equal(made.status, 201);
  const update = await s.call('PUT', `/fhir/R4/Task/${made.json.id}`, { ...made.json, description: 'changed' }, as('inbox-triager', triage));
  assert.equal(update.status, 403, 'create scope does not include update');
  const bundle = await s.call('POST', '/fhir/R4', { resourceType: 'Bundle', type: 'transaction', entry: [{ request: { method: 'POST', url: 'Task' }, resource: task() }, { request: { method: 'POST', url: 'Observation' }, resource: { resourceType: 'Observation', status: 'preliminary', code: { text: 'x' } } }] }, as('inbox-triager', triage));
  assert.equal(bundle.status, 403, 'a transaction cannot smuggle an out-of-scope write');
  assert.equal((await s.store.query('Task', {}, { branch: triage.branch })).length, 1, 'the whole bundle rolled back');

  assert.deepEqual(await rules(s, run), ['scope']);
  assert.deepEqual(await rules(s, triage), ['scope', 'scope']);
  const prov = await s.store.query('Provenance', {}, { branch: run.branch });
  assert.equal(prov.length, 1, 'agent writes carry Provenance');
  assert.equal(prov[0].agent[0].who.identifier.value, 'report-drafter');
  assert.equal((await s.call('GET', '/fhir/R4/Provenance')).json.total, 0);
  await s.close();
});

test(`[${BACKEND}] branch rule: writes land only on the agent's own run branch, never on main`, async () => {
  const { s, p, start } = await setup();
  const run = await start('report-drafter');
  const other = await start('report-drafter');
  const triage = await start('inbox-triager');
  const toMain = await s.call('POST', '/fhir/R4/DiagnosticReport?_branch=main', report(p.id), as('report-drafter', run));
  assert.equal(toMain.status, 403);
  assert.equal((await s.call('POST', `/fhir/R4/DiagnosticReport?_branch=${other.branch}`, report(p.id), as('report-drafter', run))).status, 403, "another run's branch");
  assert.equal((await s.call('POST', '/fhir/R4/DiagnosticReport', report(p.id), as('report-drafter', triage))).status, 403, "another agent's run");
  assert.equal((await s.call('GET', `/fhir/R4/Patient/${p.id}`, undefined, as('report-drafter', triage))).status, 403, 'reads are gated too');
  assert.equal((await s.call('POST', '/fhir/R4/DiagnosticReport', report(p.id), as('ghost', run))).status, 403, 'unregistered agent');
  assert.equal((await s.call('GET', '/fhir/R4/DiagnosticReport')).json.total, 0);
  assert.deepEqual(await rules(s, run), ['branch', 'branch', 'unregistered-agent']);
  assert.deepEqual(await rules(s, triage), ['run-mismatch', 'run-mismatch']);

  await s.call('PUT', '/agent-ops/agents/report-drafter', { enabled: false });
  assert.equal((await s.call('POST', '/fhir/R4/DiagnosticReport', report(p.id), as('report-drafter', run))).status, 403, 'disabled agent');
  assert.equal((await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'report-drafter' })).status, 409);
  await s.close();
});

test(`[${BACKEND}] forbidden fields: agents cannot sign, release, acknowledge or touch demographics`, async () => {
  const { s, p, start } = await setup();
  await s.call('POST', '/agent-ops/agents', { id: 'wide-agent', name: 'Wide', version: '1', adapter: { kind: 'stub', stub: 'report-drafter' }, scopes: ['DiagnosticReport', 'DocumentReference', 'Observation'].map((type) => ({ type, interactions: ['create', 'update'] })) });
  const run = await start('wide-agent');
  const h = () => as('wide-agent', run);
  const draft = (await s.call('POST', '/fhir/R4/DiagnosticReport', report(p.id, { extension: [{ url: 'urn:hospital-desktop:report-technique', valueString: 't' }, { url: 'urn:hospital-desktop:report-findings', valueString: 'f' }] }), h())).json;

  const refused = [
    ['create as final', await s.call('POST', '/fhir/R4/DiagnosticReport', report(p.id, { status: 'final' }), h())],
    ['update to final', await s.call('PUT', `/fhir/R4/DiagnosticReport/${draft.id}`, { ...draft, status: 'final' }, h())],
    ['$transition to final', await s.call('POST', `/fhir/R4/DiagnosticReport/${draft.id}/$transition`, { to: 'final' }, h())],
    ['_released: true', await s.call('PUT', `/fhir/R4/DiagnosticReport/${draft.id}`, { ...draft, _released: true }, h())],
    ['released tag', await s.call('PUT', `/fhir/R4/DiagnosticReport/${draft.id}`, { ...draft, meta: { tag: [{ system: 'urn:hospital-desktop:flags', code: 'released' }] } }, h())],
    ['$release', await s.call('POST', `/fhir/R4/DiagnosticReport/${draft.id}/$release`, { released: true }, h())],
    ['note docStatus final', await s.call('POST', '/fhir/R4/DocumentReference', { resourceType: 'DocumentReference', status: 'current', docStatus: 'final', subject: { reference: `Patient/${p.id}` }, content: [{ attachment: { data: 'eA==' } }] }, h())],
    ['lab final', await s.call('POST', '/fhir/R4/Observation', { resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject: { reference: `Patient/${p.id}` } }, h())],
    ['$acknowledge', await s.call('POST', `/fhir/R4/DiagnosticReport/${draft.id}/$acknowledge`, {}, h())],
    ['demographics update', await s.call('PUT', `/fhir/R4/Patient/${p.id}`, { ...p, birthDate: '1900-01-01' }, h())],
    ['demographics create', await s.call('POST', '/fhir/R4/Patient', patient('Fake'), h())],
  ];
  for (const [name, r] of refused) {
    assert.equal(r.status, 403, `${name} must be refused, got ${r.status} ${r.text}`);
    assert.equal(r.json.resourceType, 'OperationOutcome', name);
  }
  const now = await s.store.get('DiagnosticReport', draft.id, { branch: run.branch });
  assert.deepEqual([now.status, Boolean(now._released), now.meta.versionId], ['preliminary', false, '1'], 'nothing changed');
  assert.equal((await s.store.get('Patient', p.id)).birthDate, '1970-01-01');
  assert.equal((await rules(s, run)).length, refused.length);
  assert.deepEqual([...new Set(await rules(s, run))].sort(), ['demographics', 'forbidden-field']);

  const audit = (await s.store.query('AuditEvent', {}, { branch: run.branch })).filter((a) => a.outcome === '4');
  assert.equal(audit.length, refused.length, 'each refusal has an AuditEvent');
  assert.match(audit[0].outcomeDesc, /agent action refused/);

  const edit = await s.call('PUT', `/fhir/R4/DiagnosticReport/${draft.id}`, { ...draft, conclusion: 'Better draft' }, h());
  assert.equal(edit.status, 200, 'an allowed edit still works');
  await s.close();
});

test(`[${BACKEND}] agents may only write through the FHIR API and cannot change registry, runs or kill switches`, async () => {
  const { s, start } = await setup();
  const run = await start('report-drafter');
  const h = () => as('report-drafter', run);
  for (const [method, url, body] of [
    ['POST', '/api/pacs/studies/abc/open', {}], ['POST', '/agent-ops/kill-switches', { scope: 'global', engaged: false }],
    ['PUT', '/agent-ops/agents/report-drafter', { scopes: [{ type: 'Task', interactions: ['create'] }] }], ['POST', `/agent-ops/runs/${run.id}/resume`, {}],
    ['POST', '/agent-ops/runs', { mode: 'sandbox' }], ['POST', '/api/friction', { level: 'low' }],
  ]) {
    const r = await s.call(method, url, body, h());
    assert.equal(r.status, 403, `${method} ${url} → ${r.status}`);
  }
  assert.equal((await s.call('GET', '/api/pacs/worklist?queue=all', undefined, h())).status, 200, 'reads outside FHIR are allowed');
  assert.ok((await rules(s, run)).every((r) => r === 'out-of-scope'));
  await s.close();
});

test(`[${BACKEND}] rate limit: at most 30 Task creates per agent per minute, sliding window`, async () => {
  const clock = testClock('2026-03-01T10:00:00.000Z');
  const { s, start } = await setup({ clock });
  const run = await start('inbox-triager');
  for (let i = 0; i < 30; i += 1) {
    clock.advance(1000);
    assert.equal((await s.call('POST', '/fhir/R4/Task', task(), as('inbox-triager', run))).status, 201, `task ${i + 1}`);
  }
  const over = await s.call('POST', '/fhir/R4/Task', task(), as('inbox-triager', run));
  assert.equal(over.status, 429);
  assert.equal(over.json.issue[0].code, 'throttled');
  assert.equal((await s.call('POST', '/fhir/R4/Task?dry=true', task(), as('inbox-triager', run))).status, 429, 'dry runs obey the limit');
  const second = await start('inbox-triager');
  assert.equal((await s.call('POST', '/fhir/R4/Task', task(), as('inbox-triager', second))).status, 429, 'the limit is per agent, not per run');
  clock.advance(32_000);
  assert.equal((await s.call('POST', '/fhir/R4/Task', task(), as('inbox-triager', run))).status, 201, 'the two oldest creates left the window');
  assert.equal((await s.call('POST', '/fhir/R4/Task', task(), as('inbox-triager', run))).status, 201);
  assert.equal((await s.call('POST', '/fhir/R4/Task', task(), as('inbox-triager', run))).status, 429);
  assert.equal((await s.store.query('Task', {}, { branch: run.branch })).length, 32);
  assert.equal((await s.call('POST', '/fhir/R4/Task', task(), { 'X-Role': 'physician' })).status, 201, 'people are not rate limited');
  await s.close();
});

test(`[${BACKEND}] idempotency: a repeat within 60 seconds returns the original Task with HTTP 200`, async () => {
  const clock = testClock('2026-03-01T10:00:00.000Z');
  const { s, start } = await setup({ clock });
  const run = await start('inbox-triager');
  const headers = { 'X-Agent-Id': 'inbox-triager', 'X-Run-Id': run.id, 'Idempotency-Key': 'same-key-1' };
  const first = await s.call('POST', '/fhir/R4/Task', task(), headers);
  assert.equal(first.status, 201);
  clock.advance(59_000);
  const again = await s.call('POST', '/fhir/R4/Task', task(), headers);
  assert.equal(again.status, 200);
  assert.equal(again.json.id, first.json.id);
  assert.equal((await s.store.query('Task', {}, { branch: run.branch })).length, 1);
  clock.advance(2_000);
  const later = await s.call('POST', '/fhir/R4/Task', task(), headers);
  assert.equal(later.status, 201, 'after 60 seconds the key is new again');
  assert.notEqual(later.json.id, first.json.id);
  const { 'Idempotency-Key': _drop, ...noKey } = headers;
  const missing = await s.call('POST', '/fhir/R4/Task', task(), noKey);
  assert.equal(missing.status, 400, 'agents must send an Idempotency-Key');
  await s.close();
});

test(`[${BACKEND}] dry-run: full checks, the would-be resource returned, zero store writes`, async () => {
  const { s, p, start } = await setup();
  const run = await start('report-drafter');
  const before = (await s.store.stats()).versions;
  const dry = await s.call('POST', '/fhir/R4/DiagnosticReport?dry=true', report(p.id), as('report-drafter', run));
  assert.equal(dry.status, 200);
  assert.equal(dry.json.dryRun, true);
  assert.equal(dry.json.wouldWrite.resourceType, 'DiagnosticReport');
  assert.equal(dry.json.wouldWrite.conclusion, 'Draft');
  assert.equal((await s.store.stats()).versions, before, 'nothing was written: no resource, AuditEvent, TraceStep or Provenance');
  const refused = await s.call('POST', '/fhir/R4/DiagnosticReport?dry=true', report(p.id, { status: 'final' }), as('report-drafter', run));
  assert.equal(refused.status, 403, 'a dry run still applies the envelope');
  await s.close();
});

test(`[${BACKEND}] kill switches: global, per agent and per mode; every toggle is audited`, async () => {
  const { s, p, start } = await setup();
  const drafter = await start('report-drafter', 'shadow-task');
  const triager = await start('inbox-triager', 'sandbox');
  const human = (await s.call('POST', '/agent-ops/runs', { mode: 'sandbox' })).json;

  const perAgent = await s.call('POST', '/agent-ops/kill-switches', { scope: 'agent', target: 'report-drafter', engaged: true, reason: 'misbehaving' });
  assert.equal(perAgent.status, 200);
  assert.deepEqual([perAgent.json.stopped, perAgent.json.stoppedRuns], [1, [drafter.id]]);
  assert.equal((await s.call('GET', `/agent-ops/runs/${drafter.id}`)).json.status, 'kill-switch');
  assert.equal((await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'report-drafter' })).status, 403, 'no new runs for a stopped agent');
  assert.equal((await s.call('POST', '/fhir/R4/Task', task(), as('inbox-triager', triager))).status, 201, 'other agents carry on');
  await s.call('POST', '/agent-ops/kill-switches', { scope: 'agent', target: 'report-drafter', engaged: false });

  const perMode = await s.call('POST', '/agent-ops/kill-switches', { scope: 'mode', target: 'sandbox', engaged: true, reason: 'pause sandboxes' });
  assert.deepEqual(perMode.json.stoppedRuns, [triager.id], 'only agent runs in that mode stop');
  assert.equal((await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'inbox-triager' })).status, 403);
  const shadow = await start('report-drafter', 'shadow-task');
  await s.call('POST', '/agent-ops/kill-switches', { scope: 'mode', target: 'sandbox', engaged: false });

  const sandbox = await start('inbox-triager', 'sandbox');
  const all = await s.call('POST', '/agent-ops/kill-switches', { scope: 'global', engaged: true, reason: 'Stop all agents pressed' });
  assert.equal(all.json.stopped, 2, 'the global switch reports how many runs it stopped');
  assert.deepEqual(all.json.stoppedRuns.sort(), [shadow.id, sandbox.id].sort());
  assert.equal((await s.call('GET', `/agent-ops/runs/${human.id}`)).json.endedAt, null, 'runs without an agent are left alone');
  for (const agentId of ['report-drafter', 'inbox-triager']) {
    assert.equal((await s.call('POST', '/agent-ops/runs', { mode: 'shadow-task', agentId })).status, 403);
    assert.equal((await s.call('POST', `/agent-ops/agents/${agentId}/run`, { mode: 'sandbox', subject: `Patient/${p.id}` })).status, 403);
  }
  const state = (await s.call('GET', '/agent-ops/kill-switches')).json;
  assert.deepEqual([state.global.engaged, state.global.reason, state.running], [true, 'Stop all agents pressed', 0]);

  const released = await s.call('POST', '/agent-ops/kill-switches', { scope: 'global', engaged: false });
  assert.equal(released.json.stopped, 0);
  const fresh = await start('inbox-triager');
  assert.equal((await s.call('POST', '/fhir/R4/Task', task(), as('inbox-triager', fresh))).status, 201);

  await s.call('POST', '/agent-ops/kill-switches', { scope: 'global', engaged: true });
  const blocked = await s.call('POST', '/fhir/R4/Task', task(), as('inbox-triager', fresh));
  assert.equal(blocked.status, 403, 'refused while the switch is engaged');
  assert.equal((await s.call('GET', `/agent-ops/runs/${fresh.id}`)).json.status, 'kill-switch');
  await s.call('POST', '/agent-ops/kill-switches', { scope: 'global', engaged: false });

  const steps = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.filter((t) => t.did.type.startsWith('kill-switch.'));
  assert.deepEqual(steps.map((t) => `${t.did.type}:${t.did.args.scope}`), [
    'kill-switch.engage:agent', 'kill-switch.release:agent', 'kill-switch.engage:mode', 'kill-switch.release:mode',
    'kill-switch.engage:global', 'kill-switch.release:global', 'kill-switch.engage:global', 'kill-switch.release:global',
  ]);
  const audits = (await s.call('GET', '/fhir/R4/AuditEvent')).json.entry.map((e) => e.resource).filter((a) => /^kill switch/.test(a.outcomeDesc));
  assert.equal(audits.length, 8, 'every toggle has an AuditEvent');
  assert.equal((await s.call('POST', '/agent-ops/kill-switches', { scope: 'planet', engaged: true })).status, 422);
  await s.close();
});

test(`[${BACKEND}] a kill switch stops an agent in the middle of its work`, async () => {
  const { s, start } = await setup();
  const run = await start('inbox-triager');
  assert.equal((await s.call('POST', '/fhir/R4/Task', task(), as('inbox-triager', run))).status, 201);
  await s.call('POST', '/agent-ops/kill-switches', { scope: 'global', engaged: true });
  await s.call('POST', '/agent-ops/runs', { mode: 'sandbox' });
  const forced = await s.store.save('Run', { resourceType: 'Run', id: 'stale-run', umbrella: 'sandbox', mode: 'sandbox', agentId: 'inbox-triager', version: '1.1.0', branch: run.branch, startedAt: s.store.now(), endedAt: null }, { updatedBy: 'test' });
  const r = await s.call('POST', '/fhir/R4/Task', task(), as('inbox-triager', forced));
  assert.equal(r.status, 403, 'even a run that slipped past is refused on its next request');
  assert.match(r.json.issue[0].diagnostics, /kill switch/);
  assert.equal((await s.call('GET', '/fhir/R4/Task', undefined, as('inbox-triager', forced))).status, 403, 'reads stop too');
  await s.close();
});

test(`[${BACKEND}] pause holds an agent, resume lets it continue, cancel ends the run`, async () => {
  const { s, start } = await setup();
  const run = await start('inbox-triager');
  assert.equal((await s.call('POST', `/agent-ops/runs/${run.id}/pause`, {})).json.status, 'paused');
  const held = await s.call('POST', '/fhir/R4/Task', task(), as('inbox-triager', run));
  assert.equal(held.status, 409);
  assert.equal((await s.call('POST', `/agent-ops/runs/${run.id}/resume`, {})).json.status, 'running');
  assert.equal((await s.call('POST', '/fhir/R4/Task', task(), as('inbox-triager', run))).status, 201);
  assert.equal((await s.call('POST', `/agent-ops/runs/${run.id}/cancel`, {})).json.status, 'cancelled');
  assert.equal((await s.call('POST', '/fhir/R4/Task', task(), as('inbox-triager', run))).status, 409);
  assert.equal((await s.call('POST', `/agent-ops/runs/${run.id}/pause`, {})).status, 409, 'an ended run cannot be paused');
  const types = (await s.call('GET', `/agent-ops/trace?runId=${run.id}`)).json.steps.map((t) => t.did.type);
  assert.deepEqual(types, ['run.start', 'run.pause', 'envelope.reject', 'run.resume', 'fhir.create', 'system.derive', 'run.end']);
  await s.close();
});

test(`[${BACKEND}] execution limits: a run that exceeds its step budget is stopped`, async () => {
  const { s, p } = await setup();
  const study = (await s.call('POST', '/fhir/R4/ImagingStudy', { resourceType: 'ImagingStudy', status: 'available', subject: { reference: `Patient/${p.id}` }, started: '2026-02-01T09:00:00Z', description: 'Chest X-ray', modality: [{ system: 'http://dicom.nema.org/resources/ontology/DCM', code: 'DX' }] }, { 'X-Role': 'nurse', 'X-User-Id': 'tech-one' })).json;
  await s.call('PUT', '/agent-ops/agents/report-drafter', { limits: { maxSteps: 2, timeoutMs: 30000 } });
  const run = (await s.call('POST', '/agent-ops/agents/report-drafter/run', { mode: 'sandbox', subject: `ImagingStudy/${study.id}` })).json;
  assert.equal(run.status, 'max-steps');
  assert.match(run.result.error, /limit of 2 steps/);
  assert.equal((await s.store.query('DiagnosticReport', {}, { branch: run.branch })).length, 0);
  await s.call('PUT', '/agent-ops/agents/report-drafter', { limits: { maxSteps: 20, timeoutMs: 30000 } });
  const ok = (await s.call('POST', '/agent-ops/agents/report-drafter/run', { mode: 'sandbox', subject: `ImagingStudy/${study.id}` })).json;
  assert.equal(ok.status, 'completed');
  assert.equal((await s.store.query('DiagnosticReport', {}, { branch: ok.branch })).length, 1);
  await s.close();
});

test(`[${BACKEND}] external agents are off by default; when allowed they run through the same envelope`, async () => {
  const { s, p } = await setup();
  const study = (await s.call('POST', '/fhir/R4/ImagingStudy', { resourceType: 'ImagingStudy', status: 'available', subject: { reference: `Patient/${p.id}` }, description: 'Chest X-ray' }, { 'X-Role': 'nurse', 'X-User-Id': 'tech-one' })).json;
  // A stand-in for an external model service, on the loopback interface.
  const script = [
    { tool: 'read', args: { type: 'ImagingStudy', id: study.id }, why: 'look at the study' },
    { tool: 'create', args: { resource: { resourceType: 'DiagnosticReport', status: 'final', code: { text: 'x' }, subject: { reference: `Patient/${p.id}` } } }, why: 'try to sign' },
    { tool: 'create', args: { resource: { resourceType: 'DiagnosticReport', status: 'preliminary', code: { text: 'x' }, subject: { reference: `Patient/${p.id}` }, conclusion: 'External draft' } }, why: 'draft instead' },
    { done: true, result: { summary: 'drafted' } },
  ];
  const seen = [];
  const external = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { seen.push(JSON.parse(raw).observation); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(script[seen.length - 1])); });
  });
  await new Promise((resolve) => external.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${external.address().port}/act`;
  const reg = await s.call('POST', '/agent-ops/agents', { id: 'external-drafter', name: 'External', version: '0.1', capability: 'custom', adapter: { kind: 'http', endpoint }, scopes: [{ type: 'DiagnosticReport', interactions: ['create'] }] });
  assert.equal(reg.status, 201);

  delete process.env.ALLOW_EXTERNAL_AGENTS;
  const off = await s.call('POST', '/agent-ops/agents/external-drafter/run', { mode: 'sandbox', subject: `ImagingStudy/${study.id}` });
  assert.equal(off.status, 409, 'no outbound calls unless explicitly allowed');
  assert.equal(seen.length, 0);

  process.env.ALLOW_EXTERNAL_AGENTS = 'true';
  try {
    const run = (await s.call('POST', '/agent-ops/agents/external-drafter/run', { mode: 'sandbox', subject: `ImagingStudy/${study.id}` })).json;
    assert.equal(run.status, 'completed');
    assert.equal(seen[2].status, 403, 'the refused write came back to the agent as an observation');
    const drafts = await s.store.query('DiagnosticReport', {}, { branch: run.branch });
    assert.deepEqual(drafts.map((d) => [d.status, d.conclusion]), [['preliminary', 'External draft']]);
    const steps = (await s.call('GET', `/agent-ops/trace?runId=${run.id}`)).json.steps;
    assert.deepEqual(steps.map((t) => t.did.type), ['run.start', 'turn.start', 'fhir.read', 'envelope.reject', 'fhir.create', 'system.derive', 'turn.end', 'run.end']);
    assert.equal(steps[2].why, 'look at the study');
    assert.equal(steps[3].why, 'try to sign');
  } finally {
    delete process.env.ALLOW_EXTERNAL_AGENTS;
    await new Promise((resolve) => external.close(resolve));
  }
  await s.close();
});
