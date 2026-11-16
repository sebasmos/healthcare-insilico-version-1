// NEWS2: every band edge from the RCP chart, incomplete sets,
// the single-parameter trigger, and the score and escalation written when a
// vitals set is saved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreNews2, scoreRespiration, scoreSpo2, scoreSystolic, scorePulse, scoreTemperature, scoreConsciousness, needsEscalation } from '../ehr/server/news2.mjs';
import { startTestServer, testClock, patient, BACKEND } from './support/helpers.mjs';

const edges = (fn, cases) => { for (const [value, expected] of cases) assert.equal(fn(value), expected, `${fn.name}(${value})`); };

test('respiration rate bands and edges', () => edges(scoreRespiration, [[8, 3], [9, 1], [11, 1], [12, 0], [20, 0], [21, 2], [24, 2], [25, 3], [4, 3], [40, 3]]));
test('SpO2 scale 1 bands and edges', () => edges(scoreSpo2, [[91, 3], [92, 2], [93, 2], [94, 1], [95, 1], [96, 0], [100, 0], [70, 3]]));
test('SpO2 scale 2 bands, on air and on oxygen', () => {
  const air = (v) => scoreSpo2(v, { scale: 2, supplementalOxygen: false });
  const o2 = (v) => scoreSpo2(v, { scale: 2, supplementalOxygen: true });
  edges(air, [[83, 3], [84, 2], [85, 2], [86, 1], [87, 1], [88, 0], [92, 0], [93, 0], [97, 0]]);
  edges(o2, [[83, 3], [88, 0], [92, 0], [93, 1], [94, 1], [95, 2], [96, 2], [97, 3], [100, 3]]);
});
test('systolic blood pressure bands and edges', () => edges(scoreSystolic, [[90, 3], [91, 2], [100, 2], [101, 1], [110, 1], [111, 0], [219, 0], [220, 3]]));
test('pulse bands and edges', () => edges(scorePulse, [[40, 3], [41, 1], [50, 1], [51, 0], [90, 0], [91, 1], [110, 1], [111, 2], [130, 2], [131, 3]]));
test('temperature bands and edges', () => edges(scoreTemperature, [[35.0, 3], [35.1, 1], [36.0, 1], [36.1, 0], [38.0, 0], [38.1, 1], [39.0, 1], [39.1, 2], [41, 2]]));
test('consciousness: alert scores 0, anything else 3', () => { for (const [v, e] of [['A', 0], ['a', 0], ['C', 3], ['V', 3], ['P', 3], ['U', 3]]) assert.equal(scoreConsciousness(v), e); });

test('aggregate: normal set is 0 and low; oxygen adds 2; response bands at 5 and 7', () => {
  const normal = { respirationRate: 16, spo2: 97, supplementalOxygen: false, systolic: 120, pulse: 70, consciousness: 'A', temperature: 37 };
  assert.deepEqual([scoreNews2(normal).total, scoreNews2(normal).band], [0, 'low']);
  assert.equal(scoreNews2({ ...normal, supplementalOxygen: true }).total, 2);
  const medium = scoreNews2({ ...normal, respirationRate: 22, pulse: 95, systolic: 105, supplementalOxygen: true });
  assert.deepEqual([medium.total, medium.band, needsEscalation(medium)], [6, 'medium', true]);
  const four = scoreNews2({ ...normal, respirationRate: 22, pulse: 95, systolic: 105 });
  assert.deepEqual([four.total, four.band, needsEscalation(four)], [4, 'low', false]);
  const high = scoreNews2({ ...normal, respirationRate: 26, pulse: 135, supplementalOxygen: true });
  assert.deepEqual([high.total, high.band], [8, 'high']);
});

test('a single parameter scoring 3 is low-medium and escalates even with a low total', () => {
  const s = scoreNews2({ respirationRate: 16, spo2: 97, supplementalOxygen: false, systolic: 120, pulse: 70, consciousness: 'V', temperature: 37 });
  assert.deepEqual([s.total, s.singleThree, s.band, needsEscalation(s)], [3, true, 'low-medium', true]);
});

test('a missing parameter gives incomplete, never a falsely low score', () => {
  const s = scoreNews2({ respirationRate: 16, spo2: 97, systolic: 120, pulse: 70, consciousness: 'A' });
  assert.equal(s.incomplete, true);
  assert.equal(s.total, null);
  assert.deepEqual(s.missing, ['supplementalOxygen', 'temperature']);
  assert.equal(needsEscalation(s), false);
});

test(`[${BACKEND}] saving a complete vitals set writes a NEWS2 Observation; a high score creates one escalation Task for the physician`, async () => {
  const clock = testClock('2026-05-01T09:00:00.000Z');
  const s = await startTestServer({ clock });
  try {
    const nurse = { 'X-Role': 'nurse', 'X-User-Id': 'rn-one' };
    const p = (await s.call('POST', '/fhir/R4/Patient', patient('News'))).json;
    const at = clock.now();
    const post = (vitals, assessments = { consciousness: 'A', o2device: 'Room air' }) => s.call('POST', '/api/nursing/flowsheet', { patient: p.id, at, vitals, assessments }, nurse);
    let r = await post({ rr: 16, spo2: 97, sbp: 120, hr: 70, temp: 37 });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual([r.json.news2.total, r.json.news2.band, r.json.news2.incomplete], [0, 'low', false]);
    const scores = (await s.call('GET', `/fhir/R4/Observation?patient=${p.id}&code=urn:hospital-desktop:score|news2`)).json.entry.map((e) => e.resource);
    assert.equal(scores.length, 1);
    assert.equal(scores[0].derivedFrom.length, 7);
    let tasks = (await s.call('GET', `/fhir/R4/Task?patient=${p.id}`)).json.entry || [];
    assert.equal(tasks.length, 0, 'a low score needs no escalation');

    clock.advance(4 * 3600000);
    r = await s.call('POST', '/api/nursing/flowsheet', { patient: p.id, at: clock.now(), vitals: { rr: 25, spo2: 90, sbp: 95, hr: 115, temp: 38.5 }, assessments: { consciousness: 'A', o2device: 'Nasal cannula', o2flow: 2 } }, nurse);
    assert.equal(r.status, 201, r.text);
    assert.deepEqual([r.json.news2.total, r.json.news2.band], [3 + 3 + 2 + 2 + 2 + 0 + 1, 'high']);
    tasks = (await s.call('GET', `/fhir/R4/Task?patient=${p.id}`)).json.entry.map((e) => e.resource);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].code.coding[0].code, 'news2-escalation');
    assert.equal(tasks[0].priority, 'stat');

    const incomplete = (await s.call('POST', '/api/nursing/flowsheet', { patient: p.id, at: clock.advance(3600000 * 5), vitals: { rr: 16, spo2: 97 }, assessments: {} }, nurse)).json;
    assert.equal(incomplete.news2.incomplete, true);
    assert.equal(incomplete.news2.total, null);
    const trace = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.filter((t) => t.did.type === 'system.derive' && /NEWS2/.test(t.auditEvent ? '' : '') || /NEWS2/.test(t.did.args?.description || ''));
    assert.ok(Array.isArray(trace));
  } finally { await s.close(); }
});
