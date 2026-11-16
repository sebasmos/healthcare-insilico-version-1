// Library records (docs/STUDY-DESIGN.md 3): tasks have versions, a rubric and one of three splits; a task set
// names each task at one version; validation work is never exported as training data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, patient } from './support/helpers.mjs';
import { splitOf, allowedInRun, exportableForTraining, normalizeRubric } from '../agent-operations/server/tasks.mjs';

const res = { 'X-Role': 'researcher', 'X-User-Id': 'res-one' };
const gold = [{ type: 'lab-order', code: 'LOINC:2160-0', label: 'Creatinine' }];

test('the three splits and what each allows', () => {
  assert.deepEqual(['train', 'validation', 'eval', 'held-out', 'practice', undefined].map((split) => splitOf({ split })), ['train', 'validation', 'eval', 'eval', 'train', 'train']);
  assert.deepEqual(['train', 'validation', 'eval'].map((split) => [allowedInRun({ split }), exportableForTraining({ split })]), [[true, true], [true, false], [false, false]]);
  assert.deepEqual(normalizeRubric([{ label: 'Reasoning is sound' }, { id: 'safe', label: 'Safe', min: 0, max: 2 }]), [{ id: 'reasoning-is-sound', label: 'Reasoning is sound', min: 1, max: 5 }, { id: 'safe', label: 'Safe', min: 0, max: 2 }]);
  assert.throws(() => normalizeRubric([{ label: 'A' }, { label: 'A' }]), /twice/); assert.throws(() => normalizeRubric([{ label: 'A', min: 5, max: 1 }]), /scale/);
});

test('a task is never changed in place: each change is a new version and the old one stays readable', async () => {
  const s = await startTestServer();
  try {
    const p = (await s.call('POST', '/fhir/R4/Patient', patient())).json;
    const types = (await s.call('POST', '/agent-ops/cases', { patient: `Patient/${p.id}`, title: 'T', scenario: 'S', task: 'Do it', split: 'train', goldActions: [{ type: 'no-such-type', code: 'LOINC:2160-0' }] }, res)).text.match(/one of ([a-z, -]+)/)?.[1].split(', ') || [];
    const g = [{ ...gold[0], type: types[0] }];
    const make = (extra) => s.call('POST', '/agent-ops/cases', { patient: `Patient/${p.id}`, title: 'Kidney check', scenario: 'Creatinine has risen.', task: 'Decide what to order.', split: 'validation', goldActions: g, ...extra }, res);
    assert.equal((await make({ split: 'held-out' })).status, 422);
    const made = await make({ rubric: [{ label: 'Reasoning is sound' }] });
    assert.equal(made.status, 201, made.text);
    const t = made.json; assert.deepEqual([t.taskVersion, t.split, t.rubric.length], [1, 'validation', 1]);
    assert.equal((await s.call('PUT', `/agent-ops/cases/${t.id}`, { patient: 'Patient/other' }, res)).status, 422, 'the patient and time of a task cannot change');
    assert.equal((await s.call('PUT', `/agent-ops/cases/${t.id}`, { task: 'Decide what to order and why.' }, { 'X-Role': 'researcher', 'X-Agent-Id': 'workup-planner' })).status >= 400, true, 'agents do not change tasks');
    const v2 = await s.call('PUT', `/agent-ops/cases/${t.id}`, { task: 'Decide what to order and why.', rubric: [{ label: 'Reasoning is sound' }, { label: 'Safe', min: 0, max: 2 }], split: 'eval' }, res);
    assert.equal(v2.status, 200, v2.text); assert.deepEqual([v2.json.taskVersion, v2.json.split, v2.json.rubric.length], [2, 'eval', 2]);
    const list = (await s.call('GET', `/agent-ops/cases/${t.id}/versions`, undefined, res)).json.versions;
    assert.deepEqual(list.map((v) => [v.version, v.task, v.split, Boolean(v.current)]), [[1, 'Decide what to order.', 'validation', false], [2, 'Decide what to order and why.', 'eval', true]]);
    const one = (await s.call('GET', `/agent-ops/cases/${t.id}/versions/1`, undefined, res)).json;
    assert.deepEqual([one.version, one.task, one.rubric.length, one.current], [1, 'Decide what to order.', 1, false]);
    assert.equal((await s.call('GET', `/agent-ops/cases/${t.id}/versions/9`, undefined, res)).status, 404);
    assert.equal((await s.call('DELETE', `/agent-ops/cases/${t.id}`, undefined, res)).status, 405);
    // A task set names each task at the version current when it was added, and keeps it when the task moves on.
    const set = await s.call('POST', '/agent-ops/task-sets', { name: 'Kidney set', tasks: [{ taskId: t.id }] }, res);
    assert.equal(set.status, 201, set.text); assert.deepEqual(set.json.tasks.map((x) => [x.taskId, x.version]), [[t.id, 2]]);
    await s.call('PUT', `/agent-ops/cases/${t.id}`, { title: 'Kidney check, reworded' }, res);
    const again = (await s.call('GET', `/agent-ops/task-sets/${set.json.id}`, undefined, res)).json;
    assert.deepEqual(again.tasks.map((x) => x.version), [2], 'the set still points at version 2');
    assert.equal((await s.call('POST', '/agent-ops/task-sets', { name: 'Bad set', tasks: [{ taskId: t.id, version: 7 }] }, res)).status, 422);
  } finally { await s.close(); }
});
