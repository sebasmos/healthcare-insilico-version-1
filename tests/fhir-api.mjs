import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, patient, lab, BACKEND } from './support/helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test(`[${BACKEND}] healthz, roles and CapabilityStatement`, async () => {
  const s = await startTestServer();
  const health = await s.call('GET', '/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(typeof health.json.uptime, 'number');
  const meta = await s.call('GET', '/fhir/R4/metadata');
  assert.equal(meta.json.resourceType, 'CapabilityStatement');
  assert.equal(meta.json.fhirVersion, '4.0.1');
  assert.ok(meta.json.rest[0].resource.some((r) => r.type === 'Patient'));
  const roles = await s.call('GET', '/auth/roles');
  assert.ok(roles.json.roles.some((r) => r.id === 'physician'));
  await s.close();
});

test(`[${BACKEND}] create, read, update, history; internal fields never leave the server`, async () => {
  const s = await startTestServer();
  const created = await s.call('POST', '/fhir/R4/Patient', { ...patient('Alpha'), _released: true, _branch: 'evil', id: 'client-chosen' });
  assert.equal(created.status, 201);
  assert.notEqual(created.json.id, 'client-chosen');
  assert.equal(created.headers.get('etag'), 'W/"1"');
  assert.ok(Object.keys(created.json).every((k) => !k.startsWith('_')), 'no underscore fields in the response');
  assert.equal((await s.store.get('Patient', created.json.id))._released, false, 'client cannot set _released');
  const id = created.json.id;

  const updated = await s.call('PUT', `/fhir/R4/Patient/${id}`, { ...created.json, gender: 'male' }, { 'If-Match': 'W/"1"' });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.meta.versionId, '2');
  const stale = await s.call('PUT', `/fhir/R4/Patient/${id}`, { ...created.json, gender: 'other' }, { 'If-Match': 'W/"1"' });
  assert.equal(stale.status, 412);
  assert.equal(stale.json.resourceType, 'OperationOutcome');

  const read = await s.call('GET', `/fhir/R4/Patient/${id}`);
  assert.equal(read.json.gender, 'male');
  const history = await s.call('GET', `/fhir/R4/Patient/${id}/_history`);
  assert.equal(history.json.type, 'history');
  assert.deepEqual(history.json.entry.map((e) => e.resource.meta.versionId), ['2', '1']);
  assert.ok(history.json.entry.every((e) => Object.keys(e.resource).every((k) => !k.startsWith('_'))));

  const upsert = await s.call('PUT', '/fhir/R4/Patient/chosen-id-1', patient('Beta'));
  assert.equal(upsert.status, 201);
  await s.close();
});

test(`[${BACKEND}] _asOf shows the chart as recorded; writes are refused in a past view`, async () => {
  const s = await startTestServer();
  const p = (await s.call('POST', '/fhir/R4/Patient', patient())).json;
  const prelim = (await s.call('POST', '/fhir/R4/Observation', lab(p.id, 4.1))).json;
  const o = (await s.call('POST', `/fhir/R4/Observation/${prelim.id}/$transition`, { to: 'final' })).json;
  assert.equal(o.status, 'final');
  await sleep(15);
  const between = new Date().toISOString();
  await sleep(15);
  await s.call('PUT', `/fhir/R4/Observation/${o.id}`, { ...o, status: 'corrected', valueQuantity: { value: 1.4, unit: 'mg/dL' } });

  const past = await s.call('GET', `/fhir/R4/Observation/${o.id}?_asOf=${encodeURIComponent(between)}`);
  assert.equal(past.json.valueQuantity.value, 4.1);
  assert.equal(past.json.status, 'final');
  const now = await s.call('GET', `/fhir/R4/Observation/${o.id}`);
  assert.equal(now.json.status, 'corrected');
  const search = await s.call('GET', `/fhir/R4/Observation?patient=${p.id}&_asOf=${encodeURIComponent(between)}`);
  assert.equal(search.json.entry[0].resource.valueQuantity.value, 4.1);
  const tooEarly = await s.call('GET', `/fhir/R4/Observation/${o.id}?_asOf=2000-01-01T00:00:00Z`);
  assert.equal(tooEarly.status, 404);
  const write = await s.call('POST', `/fhir/R4/Observation?_asOf=${encodeURIComponent(between)}`, lab(p.id, 9));
  assert.equal(write.status, 409);
  assert.equal((await s.call('GET', '/fhir/R4/Observation?_asOf=not-a-date')).status, 400);
  await s.close();
});

test(`[${BACKEND}] _branch isolates writes; a Run forks its own branch`, async () => {
  const s = await startTestServer();
  const p = (await s.call('POST', '/fhir/R4/Patient', patient())).json;
  const registered = await s.call('POST', '/agent-ops/agents', { id: 'lab-agent', name: 'Lab test agent', version: '1.0', scopes: [{ type: 'Observation', interactions: ['create'] }], adapter: { kind: 'stub', stub: 'report-drafter' } });
  assert.equal(registered.status, 201);
  const run = (await s.call('POST', '/agent-ops/runs', { mode: 'shadow-task', agentId: 'lab-agent' })).json;
  assert.match(run.branch, /^shadow-/);
  assert.equal(run.version, '1.0');
  assert.equal(run.friction, 'realistic');

  const onBranch = await s.call('POST', `/fhir/R4/Observation?_branch=${run.branch}`, lab(p.id, 7));
  assert.equal(onBranch.status, 201);
  assert.equal((await s.call('GET', `/fhir/R4/Observation/${onBranch.json.id}`)).status, 404);
  assert.equal((await s.call('GET', `/fhir/R4/Observation/${onBranch.json.id}?_branch=${run.branch}`)).status, 200);
  assert.equal((await s.call('GET', `/fhir/R4/Observation?patient=${p.id}`)).json.total, 0);

  const base = { 'X-Agent-Id': 'lab-agent', 'X-Run-Id': run.id };
  let n = 0;
  const agent = new Proxy({}, { ownKeys: () => [...Object.keys(base), 'Idempotency-Key'], getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }), get: (_, k) => (k === 'Idempotency-Key' ? `key-${n += 1}` : base[k]) });
  const viaRun = await s.call('POST', '/fhir/R4/Observation', lab(p.id, 8), agent);
  assert.equal(viaRun.status, 201, 'agent writes land on the run branch by default');
  assert.equal((await s.store.get('Observation', viaRun.json.id, { branch: run.branch }))._branch, run.branch);
  const toMain = await s.call('POST', '/fhir/R4/Observation?_branch=main', lab(p.id, 8), agent);
  assert.equal(toMain.status, 403);
  assert.equal(toMain.json.resourceType, 'OperationOutcome');
  assert.equal((await s.call('POST', '/fhir/R4/Observation', lab(p.id, 8), { 'X-Agent-Id': 'lab-agent' })).status, 400, 'agent without a run');

  const ended = await s.call('POST', `/agent-ops/runs/${run.id}/end`, { reason: 'test' });
  assert.ok(ended.json.endedAt);
  assert.equal((await s.call('POST', '/fhir/R4/Observation', lab(p.id, 8), agent)).status, 409);

  const trace = (await s.call('GET', `/agent-ops/trace?runId=${run.id}`)).json;
  assert.deepEqual(trace.steps.map((t) => t.did.type), ['run.start', 'fhir.create', 'system.derive', 'envelope.reject', 'run.end']);
  assert.ok(trace.steps.every((t) => t.runId === run.id));
  assert.deepEqual(trace.steps.map((t) => t.who.kind), ['human', 'agent', 'agent', 'agent', 'human']);
  await s.close();
});

test(`[${BACKEND}] every write and chart open produces an AuditEvent and a TraceStep`, async () => {
  const s = await startTestServer();
  const p = (await s.call('POST', '/fhir/R4/Patient', patient())).json;
  await s.call('POST', '/fhir/R4/Observation', lab(p.id, 1));
  await s.call('GET', `/fhir/R4/Patient/${p.id}`);
  await s.call('GET', `/fhir/R4/Patient/${p.id}/$everything`);
  await s.call('GET', `/fhir/R4/Observation?patient=${p.id}`);

  const audits = (await s.call('GET', '/fhir/R4/AuditEvent')).json.entry.map((e) => e.resource);
  assert.deepEqual(audits.map((a) => a.action), ['C', 'C', 'R', 'R']);
  const steps = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps;
  assert.deepEqual(steps.map((t) => t.did.type), ['fhir.create', 'fhir.create', 'chart.open', 'chart.open']);
  assert.deepEqual(steps[2].saw.resources, [{ ref: `Patient/${p.id}`, versionId: '1' }]);
  assert.equal(steps[3].saw.resources.length, 2);
  for (const step of steps) {
    assert.ok(step.saw && step.did && step.who && step.when && step.runId && 'why' in step);
    assert.equal(step.who.role, 'physician');
  }
  assert.equal((await s.call('POST', '/fhir/R4/AuditEvent', audits[0])).status, 405);
  await s.close();
});

test(`[${BACKEND}] $everything, search parameters and error shapes`, async () => {
  const s = await startTestServer();
  const a = (await s.call('POST', '/fhir/R4/Patient', patient('Acase', { identifier: [{ type: { coding: [{ code: 'MR' }] }, value: 'N000001' }] }))).json;
  const b = (await s.call('POST', '/fhir/R4/Patient', patient('Bcase'))).json;
  await s.call('POST', '/fhir/R4/Observation', lab(a.id, 1));
  await s.call('POST', '/fhir/R4/Observation', lab(a.id, 2, { status: 'registered' }));
  await s.call('POST', '/fhir/R4/Observation', lab(b.id, 3));

  const everything = (await s.call('GET', `/fhir/R4/Patient/${a.id}/$everything`)).json;
  assert.deepEqual(everything.entry.map((e) => e.resource.resourceType).sort(), ['Observation', 'Observation', 'Patient']);
  assert.ok(everything.entry.every((e) => e.resource.resourceType === 'Patient' || e.resource.subject.reference === `Patient/${a.id}`), 'no other patient leaks in');

  assert.equal((await s.call('GET', '/fhir/R4/Patient?family=ac')).json.total, 0, 'patients are found by number, never by name');
  assert.equal((await s.call('GET', '/fhir/R4/Patient?identifier=N000001')).json.entry[0].resource.id, a.id);
  assert.equal((await s.call('GET', `/fhir/R4/Observation?patient=${a.id}&status=registered`)).json.total, 1);
  assert.equal((await s.call('GET', '/fhir/R4/Observation?code=http://loinc.org|2160-0')).json.total, 3);
  assert.equal((await s.call('GET', '/fhir/R4/Observation?category=laboratory&_count=2')).json.entry.length, 2);

  for (const [method, url, body, status] of [
    ['GET', '/fhir/R4/Observation?bogus=1', undefined, 400],
    ['GET', '/fhir/R4/Patient/does-not-exist', undefined, 404],
    ['GET', '/fhir/R4/Nonsense', undefined, 404],
    ['POST', '/fhir/R4/Observation', { resourceType: 'Observation' }, 422],
    ['POST', '/fhir/R4/Observation', lab('missing-patient', 1), 422],
    ['POST', '/fhir/R4/Observation', patient(), 400],
    ['GET', '/fhir/R4/Run', undefined, 404],
    ['GET', '/fhir/R4/TraceStep', undefined, 404],
  ]) {
    const r = await s.call(method, url, body);
    assert.equal(r.status, status, `${method} ${url}`);
    assert.equal(r.json.resourceType, 'OperationOutcome');
  }
  const bad = await fetch(`${s.base}/fhir/R4/Patient`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
  assert.equal(bad.status, 400);

  const patients = (await s.call('GET', '/auth/patients')).json.patients;
  assert.deepEqual(patients.map((x) => x.family.startsWith('Patient N')), [true, true], 'the sign-in list shows numbers, not names');
  assert.equal(patients[0].mrn, 'N000001');
  await s.close();
});

test(`[${BACKEND}] dry run returns what would be written and writes nothing`, async () => {
  const s = await startTestServer();
  const before = await s.store.stats();
  const dry = await s.call('POST', '/fhir/R4/Patient?dry=true', patient('Dry'));
  assert.equal(dry.status, 200);
  assert.equal(dry.json.dryRun, true);
  assert.match(dry.json.wouldWrite.name[0].family, /^Patient /, 'even a dry run shows the number, not the name');
  assert.deepEqual(await s.store.stats(), before);
  await s.close();
});

test(`[${BACKEND}] telemetry: batches are idempotent and ordered; values and free text are refused`, async () => {
  const s = await startTestServer();
  const batch = {
    batchId: 'batch-0000-0001',
    events: [
      { seq: 2, type: 'change', app: 'ehr', field: 'vitals-heart-rate', clientTime: new Date().toISOString() },
      { seq: 1, type: 'click', app: 'ehr', target: 'chart-tab-vitals', route: '/ehr/#/chart', uiStateHash: 'deadbeef' },
    ],
  };
  const first = await s.call('POST', '/agent-ops/trace', batch);
  assert.equal(first.status, 200);
  assert.equal(first.json.accepted, 2);
  const again = await s.call('POST', '/agent-ops/trace', batch);
  assert.equal(again.json.replayed, true);
  assert.deepEqual(again.json.traceStepIds, first.json.traceStepIds);
  const steps = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps;
  assert.deepEqual(steps.map((t) => [t.did.type, t.client.seq]), [['ui.click', 1], ['ui.change', 2]]);
  assert.equal(steps[0].saw.uiStateHash, 'deadbeef');
  assert.equal(steps[0].source, 'ui');

  for (const event of [
    { seq: 1, type: 'change', field: 'note-body', value: 'patient reports chest pain' },
    { seq: 1, type: 'keydown', key: 'a' },
    { seq: 1, type: 'click', target: 'free text with spaces' },
    { seq: 1, type: 'click', text: 'Family, Given' },
    { seq: 1, type: 'click', password: 'hunter2' },
  ]) {
    const r = await s.call('POST', '/agent-ops/trace', { batchId: `batch-bad-${Math.random().toString(16).slice(2, 10)}`, events: [event] });
    assert.equal(r.status, 422, JSON.stringify(event));
  }
  const stored = JSON.stringify((await s.call('GET', '/agent-ops/trace?runId=live')).json);
  for (const secret of ['chest pain', 'hunter2', 'Family, Given']) assert.ok(!stored.includes(secret));
  assert.equal((await s.call('GET', '/agent-ops/trace?runId=live')).json.count, 2);
  await s.close();
});

test(`[${BACKEND}] branches API, CORS allowlist and static files`, async () => {
  const s = await startTestServer();
  const created = await s.call('POST', '/agent-ops/branches', { kind: 'sandbox' });
  assert.equal(created.status, 201);
  assert.equal(created.json.kind, 'sandbox');
  assert.equal((await s.call('GET', '/agent-ops/branches')).json.branches.length, 2);
  const dropped = await s.call('DELETE', `/agent-ops/branches/${created.json.id}`);
  assert.ok(dropped.json.droppedAt);
  assert.equal((await s.call('GET', `/fhir/R4/Patient?_branch=${created.json.id}`)).status, 410);
  assert.equal((await s.call('POST', '/agent-ops/branches', { kind: 'main' })).status, 422);

  const blocked = await s.call('GET', '/healthz', undefined, { Origin: 'http://evil.test' });
  assert.equal(blocked.status, 403);
  const allowed = await s.call('GET', '/healthz', undefined, { Origin: 'http://allowed.test' });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://allowed.test');

  const recorder = await s.call('GET', '/shared/recorder.js');
  assert.equal(recorder.status, 200);
  assert.match(recorder.headers.get('content-type'), /javascript/);
  assert.equal((await s.call('GET', '/../package.json')).status, 404);
  assert.equal((await s.call('GET', '/%2e%2e/package.json')).status, 404);
  await s.close();
});

test(`[${BACKEND}] change marks: a cached top-bar result changes on a write to its resource types and not on reads that only log`, async () => {
  const s = await startTestServer();
  const before = await s.store.changeMark(['Observation', 'DocumentReference']);
  await s.call('GET', '/api/badges');
  await s.call('GET', '/api/badges');
  assert.equal(await s.store.changeMark(['Observation', 'DocumentReference']), before, 'reading (and its trace steps) does not change the mark');
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Zzmark'))).json;
  const crit = await s.call('POST', '/fhir/R4/Observation', { resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '2823-3', display: 'Potassium' }] }, subject: { reference: `Patient/${p.id}` }, valueQuantity: { value: 7.1, unit: 'mmol/L' }, interpretation: [{ coding: [{ code: 'HH' }] }] });
  assert.equal(crit.status, 201, crit.text);
  assert.notEqual(await s.store.changeMark(['Observation', 'DocumentReference']), before);
  const badges = (await s.call('GET', '/api/badges')).json;
  assert.ok(badges.criticalUnacknowledged.some((o) => o.id === crit.json.id), 'a new critical result shows on the next request, never a stale cached list');
  await assert.rejects(() => s.store.changeMark([]));
  await s.close();
});
