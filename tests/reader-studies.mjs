// Plan-master task 20: assignment, crossover and washout; other readers'
// answers hidden; reference answers; the four result views; the analysis
// table columns; pre-registration lock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKEND, startTestServer, testClock } from './support/helpers.mjs';
import { assign, READER_COLUMNS } from '../data-annotation/server/reader-studies.mjs';
import { pseudonym } from '../platform/server/pseudonym.mjs';

const res = { 'X-Role': 'researcher', 'X-User-Id': 'Researcher One' };
const alice = { 'X-Role': 'physician', 'X-User-Id': 'Reader One' };
const bob = { 'X-Role': 'physician', 'X-User-Id': 'Reader Two' };

test('assignment is seeded, random per reader, crossed over halfway, and covers every case under every condition', () => {
  const readers = [{ id: 'R-01', kind: 'human' }, { id: 'R-02', kind: 'human' }, { id: 'agent:workup-planner', kind: 'agent' }];
  const a = assign({ readers, cases: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'], conditions: ['without-ai', 'with-ai-helper'], seed: 42 });
  assert.equal(a.length, 3 * 6 * 2);
  const r1 = a.filter((x) => x.reader === 'R-01'); const r2 = a.filter((x) => x.reader === 'R-02');
  assert.notDeepEqual(r1.slice(0, 6).map((x) => x.case), r2.slice(0, 6).map((x) => x.case), 'different random orders');
  assert.deepEqual([r1[0].condition, r1[2].condition, r1[3].condition, r1[5].condition], ['without-ai', 'without-ai', 'with-ai-helper', 'with-ai-helper'], 'crossover halfway');
  assert.equal(r2[0].condition, 'with-ai-helper', 'the next reader starts with the other condition');
  for (const c of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']) assert.deepEqual(r1.filter((x) => x.case === c).map((x) => x.condition).sort(), ['with-ai-helper', 'without-ai']);
  assert.deepEqual(assign({ readers, cases: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'], conditions: ['without-ai', 'with-ai-helper'], seed: 42 }), a, 'the stored seed reproduces it');
});
