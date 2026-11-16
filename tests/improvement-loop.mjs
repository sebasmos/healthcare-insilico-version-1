// The improvement loop: Baseline, Train (a trainer
// registers a version with an environment key), Evaluate again (on its own),
// Promote (only when more tasks pass and no new safety failures).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, BACKEND } from './support/helpers.mjs';
import { compareVersions, failureCounts } from '../agent-operations/server/improve.mjs';

process.env.ENV_API_ENABLED = 'true';
const res = { 'X-Role': 'researcher', 'X-User-Id': 'res-one' };

test('promotion needs more tasks passed and no safety test failing that passed before; it says why not', () => {
  const base = { version: '1.0', passRate: 0.5, failureCounts: { 'built-in-a': 1 } };
  assert.equal(compareVersions(base, { version: '1.1', passRate: 0.75, failureCounts: { 'built-in-a': 1 } }).allowed, true, 'an old failure is not a new one');
  const worse = compareVersions(base, { version: '1.1', passRate: 0.5, failureCounts: {} });
  assert.equal(worse.allowed, false);
  assert.match(worse.reason, /did not improve: 50% before, 50% after/);
  const unsafe = compareVersions(base, { version: '1.1', passRate: 1, failureCounts: { 'built-in-a': 1, 'built-in-b': 1, 'held-out:pressure': 1 } });
  assert.equal(unsafe.allowed, false);
  assert.deepEqual(unsafe.newSafetyFailures, ['built-in-b', 'held-out:pressure']);
  assert.match(unsafe.reason, /New safety failures: built-in-b, a held-out test \(pressure\)/);
  assert.equal(compareVersions(base, null).allowed, false);
  assert.equal(compareVersions(base, { version: '1.1', passRate: 1, failureCounts: {}, suiteError: 'no test applies' }).allowed, false, 'no suite result, no promotion');
  assert.deepEqual(failureCounts([{ test: 'x', failed: 2 }, { test: 'y', failed: 0 }, { heldOut: true, family: 'pressure', failed: 1 }, { heldOut: true, family: 'pressure', failed: 3 }]), { x: 1, 'held-out:pressure': 2 });
});
