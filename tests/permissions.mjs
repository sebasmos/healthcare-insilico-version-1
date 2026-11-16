// Agent permissions: each level is enforced on each system, read only
// refuses and logs every write, read and write never reaches the live record, record-type and patient
// scopes hold, an agent waiting for approval cannot run, and the write report counts what happened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, patient, BACKEND } from './support/helpers.mjs';
import { refuseWrite, refuseRead, normalizePermissions, narrowTo, highestLevel, SYSTEMS, systemOfPath, systemOfType } from '../agent-operations/server/permissions.mjs';

const res = { 'X-Role': 'researcher', 'X-User-Id': 'owner-one' };
const TYPE = { ehr: 'ServiceRequest', pacs: 'ImagingStudy', lab: 'Specimen', pharmacy: 'MedicationDispense', payer: 'InsCase', 'business-office': 'InsClaim', scheduling: 'Appointment' };
const SCOPES = ['ServiceRequest', 'MedicationRequest', 'Condition', 'Task', 'Appointment', 'Communication'].map((type) => ({ type, interactions: ['create', 'update'] }));

test('every level is enforced on every system', () => {
  for (const system of SYSTEMS) {
    const type = TYPE[system]; assert.equal(systemOfType(type), system, `${type} belongs to ${system}`);
    const at = (level, extra = {}) => normalizePermissions({ systems: { [system]: level }, ...extra });
    const w = (perms, over = {}) => refuseWrite(perms, { type, doc: { status: 'draft' }, branch: 'run-1', ...over });
    assert.equal(w(at('none')).rule, 'permission');
    assert.equal(w(at('read-only')).rule, 'permission');
    assert.equal(w(at('read-propose')), null, `${system}: a proposal is allowed`);
    assert.match(w(at('read-propose'), { doc: { status: 'revoked' }, existed: true }).message, /needs read and write/);
    assert.equal(w(at('read-write'), { doc: { status: 'revoked' }, existed: true }), null);
    assert.match(w(at('read-write'), { branch: 'main' }).message, /never on the live record/);
    assert.match(w(at('read-write', { recordTypes: ['Task'] })).message, /may write only Task/);
    assert.match(w(at('read-write', { patients: 'all-synthetic' }), { patientRef: 'Patient/x', synthetic: false }).message, /synthetic patients only/);
    assert.match(w(at('read-write', { patients: 'scenario' }), { patientRef: 'Patient/x', runPatient: 'Patient/y' }).message, /patient of its scenario only/);
    // Other systems stay closed.
    for (const other of SYSTEMS.filter((o) => o !== system)) assert.equal(refuseWrite(at('read-write'), { type: TYPE[other], doc: {}, branch: 'run-1' }).rule, 'permission');
  }
  const p = normalizePermissions({ systems: { ehr: 'read-only', payer: 'read-propose' } });
  assert.equal(refuseRead(p, '/fhir/R4/Patient/1'), null);
  assert.equal(refuseRead(p, '/api/lab/worklist').rule, 'permission');
  assert.equal(systemOfPath('/api/ins/claims'), 'business-office');
  assert.equal(highestLevel(p), 'read-propose');
  const narrowed = narrowTo(normalizePermissions({ systems: { ehr: 'read-propose' } }), { systems: { ehr: 'read-write', lab: 'read-write' } });
  assert.deepEqual([narrowed.systems.ehr, narrowed.systems.lab], ['read-propose', 'none'], 'a narrower set can never widen what was granted');
});

const SYN = { meta: { security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST', display: 'test health data' }] } };
const revoke = (doc) => ({ ...doc, extension: [...(doc.extension || []).filter((e) => !/lifecycle|status-reason/.test(e.url)), { url: 'urn:hospital-desktop:lifecycle', valueCode: 'revoked' }, { url: 'urn:hospital-desktop:status-reason', valueString: 'no longer needed' }] });
const order = (pid, extra = {}) => ({ resourceType: 'ServiceRequest', status: 'draft', intent: 'order', subject: { reference: `Patient/${pid}` }, code: { text: 'Chest radiograph' }, ...extra });

test(`[${BACKEND}] read only refuses and logs every write; read and propose drafts but cannot settle; read and write works on its branch and never on the live record`, async (t) => {
  const s = await startTestServer(); t.after(() => s.close());
  const pid = (await s.call('POST', '/fhir/R4/Patient', patient('Permit', SYN))).json.id;
  const other = (await s.call('POST', '/fhir/R4/Patient', patient('Other', SYN))).json.id;
  const live = (await s.call('POST', '/fhir/R4/ServiceRequest', order(pid, { status: 'active' }))).json;
  const reg = await s.call('POST', '/agent-ops/agents', { id: 'writer', name: 'Writer', version: '1.0', adapter: { kind: 'external' }, connection: 'environment-api', scopes: SCOPES, requested: { systems: { ehr: 'read-write', scheduling: 'read-propose', lab: 'read-only' }, patients: 'scenario' } }, res);
  assert.equal(reg.status, 201, reg.text);
  assert.equal(reg.json.approval.status, 'approved', 'added by the owner: granted at once');
  const start = async (permissions) => { const r = await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'writer', subject: `Patient/${pid}`, ...(permissions ? { permissions } : {}) }, res); assert.equal(r.status, 201, r.text); return r.json; };
  let n = 0; const as = (run) => ({ 'X-Agent-Id': 'writer', 'X-Run-Id': run.id, 'Idempotency-Key': `k-${n += 1}` });

  // The same agent at three levels, side by side.
  const ro = await start({ systems: { ehr: 'read-only' } }); const rp = await start({ systems: { ehr: 'read-propose' } }); const rw = await start();
  assert.deepEqual([ro.permissionLevel, rp.permissionLevel, rw.permissionLevel], ['read-only', 'read-propose', 'read-write']);
  assert.equal(ro.permissions.systems.lab, 'none', 'a narrowed run keeps only what was named');

  assert.equal((await s.call('GET', `/fhir/R4/Patient/${pid}`, undefined, as(ro))).status, 200, 'read only can read');
  for (const attempt of [() => s.call('POST', '/fhir/R4/ServiceRequest', order(pid), as(ro)), () => s.call('PUT', `/fhir/R4/ServiceRequest/${live.id}`, revoke(live), as(ro)), () => s.call('POST', '/fhir/R4/Task', { resourceType: 'Task', status: 'requested', intent: 'order', for: { reference: `Patient/${pid}` } }, as(ro))]) {
    const r = await attempt(); assert.equal(r.status, 403, r.text); assert.match(r.text, /read only/i);
  }
  const roReport = (await s.call('GET', `/agent-ops/write-report?run=${ro.id}`, undefined, res)).json;
  assert.deepEqual([roReport.attempted, roReport.allowed, roReport.refusedByPermissions], [3, 0, 3], 'every refused write is logged');
  assert.equal(roReport.permissionLevel, 'read-only');

  const draft = await s.call('POST', '/fhir/R4/ServiceRequest', order(pid), as(rp));
  assert.equal(draft.status, 201, draft.text);
  const cancel = await s.call('PUT', `/fhir/R4/ServiceRequest/${live.id}`, revoke(live), as(rp));
  assert.equal(cancel.status, 403, cancel.text); assert.match(cancel.text, /needs read and write/);
  assert.equal((await s.call('GET', '/api/lab/worklist', undefined, as(rp))).status, 403, 'no access to a system that was not granted');

  const done = await s.call('PUT', `/fhir/R4/ServiceRequest/${live.id}`, revoke(live), as(rw));
  assert.equal(done.status, 200, done.text);
  assert.equal((await s.store.get('ServiceRequest', live.id)).status, 'active', 'the live record is untouched');
  assert.equal((await s.store.get('ServiceRequest', live.id, { branch: rw.branch })).status, 'revoked');
  const wrong = await s.call('POST', '/fhir/R4/ServiceRequest', order(other), as(rw));
  assert.equal(wrong.status, 403, wrong.text); assert.match(wrong.text, /patient of its scenario only/);
  assert.equal((await s.call('POST', '/fhir/R4/Appointment', { resourceType: 'Appointment', status: 'proposed', participant: [{ actor: { reference: `Patient/${pid}` }, status: 'needs-action' }] }, as(rw))).status, 201, 'read and propose on scheduling');
  assert.equal((await s.call('GET', '/api/lab/worklist', undefined, as(rw))).status, 200);
  const rwReport = (await s.call('GET', `/agent-ops/write-report?run=${rw.id}`, undefined, res)).json;
  assert.equal(rwReport.allowed, 2); assert.equal(rwReport.refusedByPermissions, 1); assert.equal(rwReport.destructiveAttempts, 1);
  const changed = rwReport.diff.find((d) => d.ref === `ServiceRequest/${live.id}`);
  assert.deepEqual([changed.change, changed.statusBefore, changed.statusAfter], ['changed', 'active', 'revoked']);

  // Synthetic patients only, unless the record says otherwise.
  const real = (await s.call('POST', '/fhir/R4/Patient', patient('Untagged'))).json.id;
  const wide = await s.call('POST', '/agent-ops/agents', { id: 'wide', name: 'Wide', version: '1.0', adapter: { kind: 'external' }, connection: 'environment-api', scopes: SCOPES, requested: { systems: { ehr: 'read-write' } } }, res);
  assert.equal(wide.json.granted.patients, 'all-synthetic');
  const wideRun = (await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'wide' }, res)).json;
  const notSyn = await s.call('POST', '/fhir/R4/ServiceRequest', order(real), { 'X-Agent-Id': 'wide', 'X-Run-Id': wideRun.id, 'Idempotency-Key': 'w1' });
  assert.equal(notSyn.status, 403); assert.match(notSyn.text, /synthetic patients only/);
  // A record-type scope.
  const typed = await start({ systems: { ehr: 'read-write' }, recordTypes: ['Task'] });
  const refused = await s.call('POST', '/fhir/R4/ServiceRequest', order(pid), as(typed));
  assert.equal(refused.status, 403); assert.match(refused.text, /may write only Task/);
});

test(`[${BACKEND}] an agent waiting for approval cannot run; narrowing its permissions makes a new version`, async (t) => {
  const s = await startTestServer(); t.after(() => s.close());
  const asked = await s.call('POST', '/connect/v1/agents', { id: 'outsider', name: 'Outsider', organisation: 'Outside Team', requested: { systems: { ehr: 'read-write', payer: 'read-write' }, mustCite: true } });
  assert.equal(asked.status, 202, asked.text);
  assert.equal(asked.json.approval.status, 'pending');
  const blocked = await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'outsider' }, res);
  assert.equal(blocked.status, 409, blocked.text); assert.match(blocked.text, /not approved yet/);
  assert.equal((await s.call('POST', '/agent-ops/agents/outsider/approve', {}, { 'X-Agent-Id': 'workup-planner', 'X-Run-Id': 'live', 'Idempotency-Key': 'a1' })).status, 403, 'agents never approve agents');
  const ok = await s.call('POST', '/agent-ops/agents/outsider/approve', { granted: { systems: { ehr: 'read-propose', payer: 'read-only' } } }, res);
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual([ok.json.granted.systems.ehr, ok.json.granted.systems.payer, ok.json.approval.how, ok.json.granted.mustCite], ['read-propose', 'read-only', 'narrowed', true]);
  const run = await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'outsider' }, res);
  assert.equal(run.status, 201, run.text);
  assert.equal(run.json.permissionLevel, 'read-propose');
  const again = await s.call('POST', '/agent-ops/agents/outsider/approve', { granted: { systems: { ehr: 'read-only', payer: 'read-only' } } }, res);
  assert.match(again.json.version, /\+p1$/, 'changed permissions are a new version');
  const refused = await s.call('POST', '/agent-ops/agents/outsider/approve', { refuse: true, reason: 'not needed' }, res);
  assert.equal(refused.json.approval.status, 'refused');
  assert.equal((await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'outsider' }, res)).status, 409);
});
