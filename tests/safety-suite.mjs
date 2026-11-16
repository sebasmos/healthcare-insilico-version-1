// The ready-made safety suite: the built-in tests
// across all nine families, versioned, run with no setup; own tests can be
// added; held-out tests run but show nothing; the result lands on the agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, BACKEND } from './support/helpers.mjs';
import { builtinTests, defaultSuite, maskHeldOut, suiteSummary, applyPerturbations, evaluateChecks, FAMILIES, SAFETY_SUITE_ID } from '../agent-operations/server/red-team/tests.mjs';

test('the ready-made suite: every built-in test, all nine families, and a version that changes only when a built-in test changes', () => {
  const tests = builtinTests();
  const suite = defaultSuite(tests);
  assert.equal(suite.id, SAFETY_SUITE_ID);
  assert.equal(Object.keys(FAMILIES).length, 9);
  assert.deepEqual(suite.families, Object.keys(FAMILIES).sort(), 'all nine families');
  assert.equal(suite.testIds.length, tests.length);
  assert.match(suite.version, /^[0-9a-f]{12}$/);
  assert.equal(defaultSuite(builtinTests()).version, suite.version, 'stable for the same tests');
  assert.equal(defaultSuite([...tests].reverse()).version, suite.version, 'order does not matter');
  const changed = tests.map((t, i) => (i === 0 ? { ...t, checks: [...t.checks, 'refused'] } : t));
  assert.notEqual(defaultSuite(changed).version, suite.version, 'a changed built-in test changes the version');
  const withOwn = [...tests, { ...tests[0], id: 'my-own-test', source: 'authored' }];
  assert.equal(defaultSuite(withOwn).version, suite.version, 'an own test is not part of the ready-made suite');
});

test('held-out tests show nothing but their family and rates; the weakest test is never a held-out one', () => {
  const secret = { test: 'secret-1', title: 'The secret wording', family: 'pressure', heldOut: true, variants: 3, failed: 3, attackSuccessRate: 1, weakest: { runId: 'r1' }, results: [{ runId: 'r1' }] };
  const masked = maskHeldOut(secret);
  assert.deepEqual(Object.keys(masked).sort(), ['attackSuccessRate', 'failed', 'family', 'heldOut', 'test', 'title', 'variants']);
  assert.equal(masked.title, 'Held-out test');
  assert.equal(JSON.stringify(masked).includes('secret'), false);
  const shown = { test: 't2', title: 'Dose ten times', family: 'unsafe-requests', variants: 4, failed: 1, attackSuccessRate: 0.25 };
  const ok = { test: 't3', title: 'Twin patients', family: 'wrong-patient', variants: 2, failed: 0, attackSuccessRate: 0 };
  const sum = suiteSummary([masked, shown, ok]);
  assert.equal(sum.weakest.test, 't2', 'the held-out test fails worse but is not named');
  assert.equal(sum.byFamily.pressure.attackSuccessRate, 1);
  assert.equal(sum.byFamily['unsafe-requests'].attackSuccessRate, 0.25);
  assert.equal(sum.byFamily['wrong-patient'].attackSuccessRate, 0);
  assert.equal(sum.passed, false);
  assert.equal(suiteSummary([ok]).passed, true);
});
