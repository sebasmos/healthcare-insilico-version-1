// Regression replay across agent versions, and the benchmark leaderboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startTestServer, tempDir, BACKEND } from './support/helpers.mjs';
import { diffChecks, classify } from '../agent-operations/server/regression.mjs';

test('check diffs and change labels', () => {
  const before = [{ id: 'a', label: 'A', pass: true }, { id: 'b', label: 'B', pass: false }, { id: 'c', label: 'C', pass: true }];
  const after = [{ id: 'a', label: 'A', pass: false }, { id: 'b', label: 'B', pass: true }, { id: 'c', label: 'C', pass: true }, { id: 'd', label: 'D', pass: true }];
  assert.deepEqual(diffChecks(before, after).map((c) => [c.id, c.change]), [['a', 'broke'], ['b', 'fixed'], ['c', 'same'], ['d', 'new-check']]);
  assert.deepEqual(diffChecks(before, []).map((c) => c.change), ['removed-check', 'removed-check', 'removed-check']);
  const score = (value) => ({ kind: 'score', value });
  assert.equal(classify(null, score(1)), 'new');
  assert.equal(classify(score(0.5), score(0.5)), 'same');
  assert.equal(classify(score(0.5), score(0.75)), 'improved');
  assert.equal(classify(score(1), score(0.75)), 'regressed');
  assert.equal(classify({ kind: 'label', value: 'normal' }, { kind: 'label', value: 'normal' }), 'same');
  assert.equal(classify({ kind: 'label', value: 'normal' }, { kind: 'label', value: 'abnormal' }), 'changed');
});

test(`[${BACKEND}] regression replay covers items an earlier version shadowed`, async () => {
  const s = await startTestServer();
  try {
    const p = (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', name: [{ family: 'Zzreplay', given: ['Test'] }], gender: 'male', birthDate: '1960-01-01' })).json;
    const msg = (await s.call('POST', '/fhir/R4/Communication', { resourceType: 'Communication', status: 'completed', subject: { reference: `Patient/${p.id}` }, sender: { reference: `Patient/${p.id}` }, sent: new Date().toISOString(), topic: { text: 'Question' }, payload: [{ contentString: 'I have crushing chest pain right now.' }] }, { 'X-Role': 'patient' })).json;
    await s.agents.idle();
    const shadowed = (await s.call('GET', '/agent-ops/runs')).json.runs.filter((r) => r.agentId === 'inbox-triager' && r.mode === 'shadow-event');
    assert.equal(shadowed.length, 1);
    const agent = (await s.call('GET', '/agent-ops/agents/inbox-triager')).json;
    assert.equal((await s.call('PUT', '/agent-ops/agents/inbox-triager', { ...agent, version: '1.2.0' })).status, 200);
    const r = (await s.call('POST', '/agent-ops/regression/run', { agentId: 'inbox-triager' })).json;
    assert.deepEqual([r.previous, r.summary.cases, r.summary.shadowCases], [agent.version, 0, 1]);
    assert.deepEqual([r.rows[0].kind, r.rows[0].target, r.rows[0].change], ['shadow', `Communication/${msg.id}`, 'same']);
    assert.equal(r.rows[0].before.value, r.rows[0].after.value);
    const replayed = (await s.call('GET', `/agent-ops/runs/${r.rows[0].after.runId}`)).json;
    assert.deepEqual([replayed.mode, replayed.version], ['sandbox', '1.2.0']);
    assert.equal((await s.call('GET', '/fhir/R4/Task')).json.entry?.length ?? 0, 0, 'the replay wrote nothing to the live chart');
  } finally { await s.close(); }
});
