import test from 'node:test';
import assert from 'node:assert/strict';
import { openTestStore, testClock, patient, lab, BACKEND } from './support/helpers.mjs';

async function setup() {
  const clock = testClock('2026-01-01T00:00:00.000Z');
  const { store, adapter } = await openTestStore({ clock });
  return { store, adapter, clock };
}

test(`[${BACKEND}] save appends versions and never overwrites`, async () => {
  const { store, clock } = await setup();
  const p = await store.save('Patient', patient());
  assert.equal(p.meta.versionId, '1');
  assert.equal(p._branch, 'main');
  assert.equal(p._patient, `Patient/${p.id}`);
  assert.equal(p._released, false);
  clock.advance(1000);
  const v2 = await store.save('Patient', { ...p, gender: 'male' });
  assert.equal(v2.meta.versionId, '2');
  const history = await store.history('Patient', p.id);
  assert.deepEqual(history.map((h) => [h.meta.versionId, h.gender]), [['1', 'female'], ['2', 'male']]);
  assert.equal((await store.get('Patient', p.id)).gender, 'male');
  await store.close();
});

test(`[${BACKEND}] as-of read returns the pre-correction lab and never a later version`, async () => {
  const { store, clock } = await setup();
  const p = await store.save('Patient', patient());
  clock.set('2026-01-01T08:00:00.000Z');
  const original = await store.save('Observation', lab(p.id, 4.1, { status: 'final' }));
  clock.set('2026-01-01T10:00:00.000Z');
  await store.save('Observation', { ...original, status: 'corrected', valueQuantity: { value: 1.4, unit: 'mg/dL' } });

  const before = await store.get('Observation', original.id, { asOf: '2026-01-01T09:00:00.000Z' });
  assert.equal(before.valueQuantity.value, 4.1);
  assert.equal(before.status, 'final');
  assert.equal(before.meta.versionId, '1');
  const after = await store.get('Observation', original.id, { asOf: '2026-01-01T10:00:00.000Z' });
  assert.equal(after.valueQuantity.value, 1.4);
  assert.equal(await store.get('Observation', original.id, { asOf: '2026-01-01T07:59:59.999Z' }), null);

  // Leakage rule 1: no as-of result is recorded after asOf, across many cut points.
  for (const asOf of ['2025-12-31T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T08:00:00.000Z', '2026-01-01T09:59:59.999Z', '2026-01-02T00:00:00.000Z']) {
    for (const type of ['Patient', 'Observation']) {
      for (const doc of await store.query(type, {}, { asOf })) {
        assert.ok(doc._recordedAt <= asOf, `${type} v${doc.meta.versionId} recorded ${doc._recordedAt} leaked into asOf ${asOf}`);
      }
    }
  }
  await store.close();
});

test(`[${BACKEND}] branch sees parent only up to forkedAt; main never sees branch writes`, async () => {
  const { store, clock } = await setup();
  const p = await store.save('Patient', patient());
  clock.set('2026-01-02T00:00:00.000Z');
  const obs = await store.save('Observation', lab(p.id, 1.0));
  clock.set('2026-01-03T00:00:00.000Z');
  const branch = await store.fork({ kind: 'shadow' });
  assert.equal((await store.getBranch(branch)).forkedAt, '2026-01-03T00:00:00.000Z');

  clock.set('2026-01-04T00:00:00.000Z');
  await store.save('Observation', { ...obs, valueQuantity: { value: 2.0, unit: 'mg/dL' } });
  const mainOnly = await store.save('Observation', lab(p.id, 9.9));

  // Leakage rule 2: parent versions written after the fork are invisible on the branch.
  assert.equal((await store.get('Observation', obs.id, { branch })).valueQuantity.value, 1.0);
  assert.equal(await store.get('Observation', mainOnly.id, { branch }), null);
  assert.equal((await store.query('Observation', {}, { branch })).length, 1);
  assert.equal((await store.history('Observation', obs.id, { branch })).length, 1);

  clock.set('2026-01-05T00:00:00.000Z');
  const onBranch = await store.save('Observation', { ...(await store.get('Observation', obs.id, { branch })), valueQuantity: { value: 3.0, unit: 'mg/dL' } }, { branch });
  const branchOnly = await store.save('Observation', lab(p.id, 7.7), { branch });
  assert.equal(onBranch.meta.versionId, '2');
  assert.equal(onBranch._branch, branch);
  assert.equal((await store.get('Observation', obs.id, { branch })).valueQuantity.value, 3.0);

  // Leakage rule 3: main never sees branch writes.
  assert.equal((await store.get('Observation', obs.id)).valueQuantity.value, 2.0);
  assert.equal(await store.get('Observation', branchOnly.id), null);
  assert.ok((await store.head('Observation')).every((o) => o._branch === 'main'));
  assert.ok((await store.history('Observation', obs.id)).every((o) => o._branch === 'main'));

  // As-of on the branch before its own write shows the forked state.
  assert.equal((await store.get('Observation', obs.id, { branch, asOf: '2026-01-04T12:00:00.000Z' })).valueQuantity.value, 1.0);
  await store.close();
});

test(`[${BACKEND}] fork at a past time and nested branches respect every ancestor cap`, async () => {
  const { store, clock } = await setup();
  const p = await store.save('Patient', patient());
  clock.set('2026-02-01T00:00:00.000Z');
  const a = await store.save('Observation', lab(p.id, 1));
  clock.set('2026-02-02T00:00:00.000Z');
  await store.save('Observation', { ...a, valueQuantity: { value: 2, unit: 'mg/dL' } });
  clock.set('2026-02-03T00:00:00.000Z');

  const past = await store.fork({ kind: 'rollout', forkedAt: '2026-02-01T12:00:00.000Z' });
  assert.equal((await store.get('Observation', a.id, { branch: past })).valueQuantity.value, 1);

  const parent = await store.fork({ kind: 'sandbox' });
  clock.set('2026-02-04T00:00:00.000Z');
  await store.save('Observation', { ...a, valueQuantity: { value: 3, unit: 'mg/dL' } });
  const sandboxWrite = await store.save('Observation', lab(p.id, 50), { branch: parent });
  assert.equal(sandboxWrite._sandbox, true);
  clock.set('2026-02-05T00:00:00.000Z');
  const child = await store.fork({ kind: 'redteam', parentBranch: parent });
  clock.set('2026-02-06T00:00:00.000Z');
  const late = await store.save('Observation', lab(p.id, 60), { branch: parent });

  assert.equal((await store.get('Observation', a.id, { branch: child })).valueQuantity.value, 2, 'grandparent capped at the parent fork time');
  assert.ok(await store.get('Observation', sandboxWrite.id, { branch: child }), 'parent write before child fork is visible');
  assert.equal(await store.get('Observation', late.id, { branch: child }), null, 'parent write after child fork is hidden');

  await assert.rejects(store.fork({ kind: 'shadow', forkedAt: '2099-01-01T00:00:00.000Z' }), /future/);
  await assert.rejects(store.fork({ kind: 'main' }), /kind/);
  await store.close();
});

test(`[${BACKEND}] dropped branch refuses reads and writes; its history stays in the log`, async () => {
  const { store, adapter } = await setup();
  const p = await store.save('Patient', patient());
  const branch = await store.fork({ kind: 'shadow' });
  await store.save('Observation', lab(p.id, 5), { branch });
  await store.dropBranch(branch);
  await assert.rejects(store.query('Observation', {}, { branch }), /dropped/);
  await assert.rejects(store.save('Observation', lab(p.id, 6), { branch }), /dropped/);
  await assert.rejects(store.dropBranch('main'), /main/);
  const row = await adapter.get('SELECT COUNT(*) AS n FROM resource_versions WHERE branch = ?', [branch]);
  assert.equal(Number(row.n), 1);
  await store.close();
});

test(`[${BACKEND}] the version log rejects UPDATE and DELETE at the database level`, async () => {
  const { store, adapter } = await setup();
  await store.save('Patient', patient());
  await assert.rejects(adapter.run("UPDATE resource_versions SET body = '{}'", []), /append-only/);
  await assert.rejects(adapter.run('DELETE FROM resource_versions', []), /append-only/);
  assert.equal((await store.head('Patient')).length, 1);
  await store.close();
});

test(`[${BACKEND}] recorded time cannot run backwards for a resource`, async () => {
  const { store, clock } = await setup();
  clock.set('2026-03-02T00:00:00.000Z');
  const p = await store.save('Patient', patient());
  await assert.rejects(store.save('Patient', p, { recordedAt: '2026-03-01T00:00:00.000Z' }), /earlier/);
  const branch = await store.fork({ kind: 'shadow' });
  await assert.rejects(store.save('Patient', patient('Other'), { branch, recordedAt: '2026-03-01T00:00:00.000Z' }), /fork time/);
  await store.close();
});

test(`[${BACKEND}] validation: wrong type, missing required fields, unknown branch`, async () => {
  const { store } = await setup();
  await assert.rejects(store.save('Observation', { resourceType: 'Observation' }), /status is required/);
  await assert.rejects(store.save('Patient', { resourceType: 'Observation' }), /does not match/);
  await assert.rejects(store.save('Nonsense', { resourceType: 'Nonsense' }), /Unsupported/);
  await assert.rejects(store.save('Patient', patient(), { branch: 'nope' }), /Unknown branch/);
  await store.close();
});
