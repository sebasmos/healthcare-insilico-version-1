import test from 'node:test';
import assert from 'node:assert/strict';
import { openTestStore, startTestServer, patient, lab, BACKEND } from './support/helpers.mjs';
import { recordAction, ensureLiveRun } from '../platform/server/audit.mjs';

const actor = { kind: 'human', id: 'tester', role: 'physician' };

test(`[${BACKEND}] a failed step rolls back the clinical write, AuditEvent and TraceStep together`, async () => {
  const { store } = await openTestStore();
  await ensureLiveRun(store);
  const before = await store.stats();
  await assert.rejects(store.transaction(async (tx) => {
    const p = await tx.save('Patient', patient());
    await recordAction(tx, { actor, kind: 'create', action: 'fhir.create', entityRef: `Patient/${p.id}`, patientRef: p._patient });
    assert.equal((await tx.query('Patient')).length, 1, 'visible inside the transaction');
    throw new Error('simulated failure after staging all three');
  }), /simulated failure/);
  assert.deepEqual(await store.stats(), before);
  assert.equal((await store.head('Patient')).length, 0);
  assert.equal((await store.head('AuditEvent')).length, 0);
  assert.equal((await store.query('TraceStep')).length, 0);
  await store.close();
});

test(`[${BACKEND}] an invalid TraceStep aborts the whole clinical transaction`, async () => {
  const { store } = await openTestStore();
  await assert.rejects(store.transaction(async (tx) => {
    await tx.save('Patient', patient());
    await tx.save('TraceStep', { resourceType: 'TraceStep', runId: 'live', did: { type: 'x' } });
  }), /TraceStep\.saw is required/);
  assert.equal((await store.head('Patient')).length, 0);
  await store.close();
});

test(`[${BACKEND}] a successful write commits all three and the TraceStep carries all six parts`, async () => {
  const { store } = await openTestStore();
  await ensureLiveRun(store);
  const p = await store.transaction(async (tx) => {
    const saved = await tx.save('Patient', patient());
    await recordAction(tx, {
      actor, kind: 'create', action: 'fhir.create', args: { type: 'Patient', id: saved.id },
      entityRef: `Patient/${saved.id}`, versionId: '1', patientRef: saved._patient, why: 'registering a new patient',
    });
    return saved;
  });
  const [audit] = await store.head('AuditEvent');
  const [step] = await store.query('TraceStep');
  assert.equal(audit.entity[0].what.reference, `Patient/${p.id}`);
  assert.equal(audit.entity[1].what.identifier.value, step.id);
  assert.equal(step.auditEvent, `AuditEvent/${audit.id}`);
  assert.equal(step.saw.branch, 'main');
  assert.equal(step.did.type, 'fhir.create');
  assert.equal(step.why, 'registering a new patient');
  assert.deepEqual([step.who.kind, step.who.id, step.who.role], ['human', 'tester', 'physician']);
  assert.ok(step.when.wall && step.when.chartAsOf);
  assert.equal(step.runId, 'live');
  assert.equal((await store.get('Run', step.runId)).branch, 'main');
  await store.close();
});

test(`[${BACKEND}] TraceStep and AuditEvent are append-only: no second version`, async () => {
  const { store } = await openTestStore();
  await ensureLiveRun(store);
  await store.transaction((tx) => recordAction(tx, { actor, kind: 'execute', action: 'test.action' }));
  const [step] = await store.query('TraceStep');
  const [audit] = await store.head('AuditEvent');
  await assert.rejects(store.save('TraceStep', { ...step, why: 'rewritten' }), /append-only/);
  await assert.rejects(store.save('AuditEvent', { ...audit, outcome: '8' }), /append-only/);
  await store.close();
});

test(`[${BACKEND}] optimistic concurrency: stale ifMatch is refused`, async () => {
  const { store } = await openTestStore();
  const p = await store.save('Patient', patient());
  await store.save('Patient', { ...p, gender: 'male' }, { ifMatch: '1' });
  await assert.rejects(store.save('Patient', { ...p, gender: 'other' }, { ifMatch: '1' }), /Version conflict/);
  assert.equal((await store.get('Patient', p.id)).gender, 'male');
  await store.close();
});

test(`[${BACKEND}] concurrent saves to one resource each get a distinct version`, async () => {
  const { store } = await openTestStore();
  const p = await store.save('Patient', patient());
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) => store.save('Patient', { ...p, birthDate: `19${String(50 + i)}-01-01` })),
  );
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => Number(r.value.meta.versionId));
  assert.ok(ok.length >= 1);
  assert.equal(new Set(ok).size, ok.length, 'no duplicate version ids');
  const history = await store.history('Patient', p.id);
  assert.deepEqual(history.map((h) => Number(h.meta.versionId)), Array.from({ length: history.length }, (_, i) => i + 1));
  for (const r of results.filter((x) => x.status === 'rejected')) assert.equal(r.reason.code, 'conflict');
  await store.close();
});

test(`[${BACKEND}] API: failure injected before commit leaves no resource, audit or trace`, async () => {
  let fail = true;
  const server = await startTestServer({ hooks: { beforeCommit: async () => { if (fail) throw new Error('disk full (simulated)'); } } });
  const failed = await server.call('POST', '/fhir/R4/Patient', patient('Rollback'));
  assert.equal(failed.status, 500);
  assert.equal(failed.json.resourceType, 'OperationOutcome');
  assert.equal((await server.store.head('Patient')).length, 0);
  assert.equal((await server.store.head('AuditEvent')).length, 0);
  assert.equal((await server.store.query('TraceStep')).length, 0);
  fail = false;
  const ok = await server.call('POST', '/fhir/R4/Patient', patient('Committed'));
  assert.equal(ok.status, 201);
  assert.equal((await server.store.head('AuditEvent')).length, 1);
  assert.equal((await server.store.query('TraceStep')).length, 1);
  await server.close();
});

test(`[${BACKEND}] API: Idempotency-Key replays the original response without a second write`, async () => {
  const server = await startTestServer();
  const headers = { 'Idempotency-Key': 'key-0001' };
  const first = await server.call('POST', '/fhir/R4/Patient', patient('Once'), headers);
  const second = await server.call('POST', '/fhir/R4/Patient', patient('Once'), headers);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.json.id, first.json.id);
  assert.equal((await server.store.head('Patient')).length, 1);
  const o = await server.call('POST', '/fhir/R4/Observation', lab(first.json.id, 1), { 'Idempotency-Key': 'key-0001' });
  assert.equal(o.status, 201, 'the same key on a different resource type is a different request');
  await server.close();
});
