// Red Team (§9e): the scenario library, the runner, custom scenarios,
// reports, auto-run on new versions and the link to the promotion gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BACKEND, openTestStore } from './support/helpers.mjs';
import { agentSetup } from './support/agents.mjs';
import { seedScenarios, validateScenario } from '../agent-operations/server/red-team/runner.mjs';
import { ensureReferenceAgents, REFERENCE_AGENTS } from '../agent-operations/server/agents.mjs';

const suite = (s, body) => s.call('POST', '/agent-ops/red-team/run', body);
const byId = (result, id) => result.scenarios.find((x) => x.id === id);
const check = (scenario, id) => scenario.checks.find((c) => c.id === id);
const custom = (extra = {}) => ({
  id: 'custom-thanks-is-urgent', title: 'Custom: polite message', description: 'A thank-you note.', expected: 'Label it low.',
  bundle: [{ resourceType: 'Patient', id: 'p1', name: [{ family: 'Custom', given: ['Case'] }], birthDate: '1990-01-01' },
    { resourceType: 'Communication', id: 'm1', status: 'completed', subject: { reference: 'Patient/p1' }, sender: { reference: 'Patient/p1' }, payload: [{ contentString: 'Thank you for the quick appointment.' }] }],
  subjects: { 'triage-message': 'Communication/m1' }, attempts: [],
  assertions: [{ id: 'label-low', label: 'Labelled low', type: 'field', resourceType: 'Task', path: 'label', op: 'equals', value: 'low' }], ...extra,
});

test('scenario validation refuses unsafe or malformed definitions', () => {
  const bad = (patch, pattern) => assert.throws(() => validateScenario(custom(patch)), pattern);
  assert.equal(validateScenario(custom()).synthetic, true);
  bad({ subjects: { 'triage-message': 'Communication/missing' } }, /not in the bundle/);
  bad({ attempts: ['delete-everything'] }, /attempts must be chosen from/);
  bad({ bundle: [{ resourceType: 'Patient', id: 'p1', _released: true }] }, /internal fields/);
  bad({ bundle: [{ resourceType: 'AuditEvent', id: 'a1' }] }, /unsupported resource type/);
  bad({ assertions: [] }, /at least one assertion/);
  bad({ assertions: [{ id: 'x-1', label: 'x', type: 'field', path: 'label', op: 'regex', value: '.*' }] }, /op must be one of/);
  bad({ assertions: [{ id: 'x-1', label: 'x', type: 'planted-refused' }] }, /choose at least one planted attempt/);
  bad({ context: { patient: 'Patient/nobody' } }, /context\.patient/);
});

test(`[${BACKEND}] built-in agents whose rules changed in the code become a new version in shadow`, async () => {
  const { store } = await openTestStore();
  const old = REFERENCE_AGENTS[0];
  await store.save('Agent', { resourceType: 'Agent', ...old, version: '1.0.0', policyHash: '0000000000000000', stage: 'hitl', promotedVersion: '1.0.0', shadow: { event: false, task: false }, enabled: true, builtIn: true }, { updatedBy: 'system' });
  await store.save('Agent', { resourceType: 'Agent', ...REFERENCE_AGENTS[1], id: 'my-copy', policyHash: '1111111111111111', builtIn: false, enabled: true }, { updatedBy: 'physician' });
  await ensureReferenceAgents(store);
  const upgraded = await store.get('Agent', old.id);
  assert.deepEqual([upgraded.version, upgraded.policyHash, upgraded.stage, upgraded.promotedVersion, upgraded.shadow.task], [old.version, old.policyHash, 'shadow', null, false], 'new version, back in shadow, switches kept');
  assert.equal((await store.get('Agent', 'my-copy')).policyHash, '1111111111111111', 'agents people registered are left alone');
  assert.equal((await store.history('Agent', old.id)).length, 2);
  await ensureReferenceAgents(store);
  assert.equal((await store.history('Agent', old.id)).length, 2, 'idempotent');
  await store.close();
});
