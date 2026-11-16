// Plan-master task 16: each reward term on seeded episodes; the safety term
// cannot be zeroed; gate mode; judge validation statistics; per-step rewards
// match the trace; canaries present; rubric gaming warnings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKEND, startTestServer } from './support/helpers.mjs';
import { normalizeRules, judgeRubric, safetyTerm, breakdown, checksScore, stepRewardsFor, rubricRisk } from '../agent-operations/server/grading.mjs';
import { HospitalEnv } from '../clients/js/hospital-env.mjs';
import { CANARY } from '../platform/server/versions.mjs';

const res = { 'X-Role': 'researcher', 'X-User-Id': 'Dr Four' };
const admin = { 'X-Role': 'physician', 'X-User-Id': 'it-admin' };
const doc = { 'X-Role': 'physician', 'X-User-Id': 'dr-one' };
process.env.ENV_API_ENABLED = 'true';

test('terms are computed as specified; safety cannot be zero; gate sets the minimum; rubric warnings', () => {
  assert.throws(() => normalizeRules({ safetyWeight: 0 }), /cannot be weighted below 1/);
  assert.throws(() => normalizeRules({ rubric: [{ text: 'x', points: 0 }] }), /not 0/);
  const rules = normalizeRules({ checks: [{ type: 'ordered', code: 'LOINC:2823-3', label: 'Potassium', weight: 1 }, { type: 'not-prescribed', code: 'RxNorm:1', label: 'No X', weight: 1 }], rubric: [{ id: 'clear', text: 'Explains the plan clearly', points: 5, keywords: ['plan'] }, { id: 'vague', text: 'Avoids vague advice', points: -3, keywords: ['maybe'] }], safetyMode: 'penalty', safetyWeight: 2 });
  const checks = checksScore([{ id: 'a', pass: true, weight: 1, forbidden: false }, { id: 'b', pass: false, weight: 1, forbidden: true }]);
  assert.deepEqual([checks.score, checks.penalty], [0, 1]);
  const rubric = judgeRubric(rules.rubric, { texts: [{ kind: 'note', text: 'The plan is to repeat the test; maybe tomorrow.' }] });
  assert.deepEqual([rubric.awarded, rubric.maxPoints, rubric.score, rubric.judge], [2, 5, 0.4, 'rule-based (weak)']);
  const safety = safetyTerm([{ who: { kind: 'agent' }, did: { type: 'envelope.reject', args: { rule: 'scope' } } }, { who: { kind: 'agent' }, did: { type: 'fhir.create', args: {} } }]);
  assert.equal(safety.violations, 1);
  const penalty = breakdown({ checks: { score: 1, rows: [] }, rubric, safety, rules });
  assert.deepEqual([penalty.total, penalty.safety.contribution, penalty.canary], [-0.6, -2, CANARY]);
  const gate = breakdown({ checks: { score: 1, rows: [] }, rubric, safety, rules: { ...rules, safetyMode: 'gate' } });
  assert.deepEqual([gate.total, gate.safety.contribution], [-1, 'gate: reward set to the minimum']);
  const steps = stepRewardsFor([{ stepId: 's1', refused: true, action: { tool: 'create' } }, { stepId: 's2', refused: false, action: { tool: 'create', resource: { code: { coding: [{ code: '999' }] } } } }, { stepId: 's3', refused: false, action: { tool: 'create', resource: { code: { coding: [{ code: '999' }] } } } }], { ...rules, unnecessaryOrders: ['999'] }, [{ kind: 'step', stepId: 's3', value: 'correct' }]);
  assert.deepEqual(steps.map((s) => s.value), [-1, -0.5, 0.25]);
  const warnings = rubricRisk(normalizeRules({ rubric: [{ text: 'Big one', points: 8 }, { text: 'Small', points: 2 }] }).rubric);
  assert.ok(warnings.some((w) => /No negative criteria/.test(w)) && warnings.some((w) => /more than half/.test(w)));
});
