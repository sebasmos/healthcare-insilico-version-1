// Compare two: pairing never shows which agent is which,
// the ranking is right on a seeded set, the preference export leaves out held-out
// tasks, judgements are append-only, and benchmarks are frozen with a leaderboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, BACKEND } from './support/helpers.mjs';
import { bradleyTerry, ranking } from '../agent-operations/server/preferences.mjs';
import { mulberry32 } from '../ehr/server/wearables.mjs';

const res = { 'X-Role': 'researcher', 'X-User-Id': 'res-one' };

test('the ranking is right on a seeded set, with intervals around each strength', () => {
  const rng = mulberry32(42);
  const truth = { strong: 4, middle: 1.5, weak: 0.5 };
  const outcomes = [];
  for (let i = 0; i < 300; i += 1) {
    const [a, b] = [['strong', 'middle'], ['middle', 'weak'], ['strong', 'weak']][i % 3];
    const pA = truth[a] / (truth[a] + truth[b]);
    const r = rng();
    outcomes.push({ a, b, result: r < pA * 0.9 ? 'a' : r < pA * 0.9 + 0.1 ? 'tie' : 'b' });
  }
  const s = bradleyTerry(outcomes);
  assert.ok(s.strong > s.middle && s.middle > s.weak, JSON.stringify(s));
  assert.ok(Math.abs(Math.exp((Math.log(s.strong) + Math.log(s.middle) + Math.log(s.weak)) / 3) - 1) < 1e-6, 'normalised to a geometric mean of 1');
  const r = ranking(outcomes, { seed: 7 });
  assert.deepEqual(r.map((x) => x.entity), ['strong', 'middle', 'weak']);
  for (const x of r) assert.ok(x.low <= x.strength && x.strength <= x.high, JSON.stringify(x));
  assert.deepEqual(ranking(outcomes, { seed: 7 }), r, 'the same judgements give the same intervals');
  assert.equal(r[0].comparisons, 200);
  const one = bradleyTerry([{ a: 'x', b: 'y', result: 'a' }]);
  assert.ok(Number.isFinite(one.y) && one.x > one.y, 'a side that never wins still has a finite strength');
});
