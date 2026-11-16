// Scores on every attempt and the report card (docs/STUDY-DESIGN.md 7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './support/helpers.mjs';
import { res, as, makeTasks, makePeople } from './support/study-fixtures.mjs';
import { wilson } from '../agent-operations/server/scores.mjs';

test('the interval around a pass rate', () => {
  assert.deepEqual(wilson(0, 0), { rate: null, low: null, high: null, n: 0 });
  const w = wilson(8, 10); assert.equal(w.rate, 0.8); assert.ok(w.low > 0.44 && w.low < 0.5 && w.high > 0.94 && w.high < 0.97, JSON.stringify(w));
  assert.equal(wilson(10, 10).high, 1); assert.equal(wilson(0, 10).low, 0);
});

test('every closed attempt has the five scores; the report card compares modes for one agent version', async () => {
  const s = await startTestServer();
  try {
    const { tasks, set, patient } = await makeTasks(s, 2, { split: 'eval', rubric: [{ label: 'Reasoning is sound' }, { id: 'safe', label: 'Safe', min: 0, max: 2 }] });
    const [r1, r2] = await makePeople(s, 2);
    const study = (await s.call('POST', '/agent-ops/studies', { title: 'Card', taskSet: set.id, participants: [{ kind: 'agent', id: 'workup-planner' }, { kind: 'person', id: r1.id }], conditions: ['autonomous', 'shadow'] }, res)).json;
    await s.call('POST', `/agent-ops/studies/${study.id}/start`, {}, res); await s.studies.idle(study.id);
    const agentAttempts = (await s.studies.attemptsOf(study.id)).filter((a) => a.participant.kind === 'agent');
    for (const a of agentAttempts) {
      assert.deepEqual(Object.keys(a.scores).sort(), ['expertGrade', 'safetyViolations', 'seconds', 'steps', 'success']);
      assert.deepEqual([a.scores.success.of, typeof a.scores.success.pass, a.scores.expertGrade], [1, 'boolean', null]);
      assert.ok(a.scores.steps >= 1 && a.scores.seconds >= 0 && a.scores.safetyViolations >= 0, JSON.stringify(a.scores));
    }
    // The reader does the first task properly (orders the test the check asks for) and skips nothing on the second.
    const mine = await s.studies.queueOf(r1.id);
    const opened = (await s.call('POST', `/agent-ops/attempts/${mine[0].id}/open`, {}, as(r1))).json;
    const gold = tasks.find((t) => t.id === mine[0].taskId).goldActions[0]; const [, code] = gold.code.split(':');
    const order = await s.call('POST', `/fhir/R4/ServiceRequest?_branch=${opened.branch}`, { resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: `Patient/${patient.id}` }, code: { coding: [{ system: 'http://loinc.org', code, display: gold.label }], text: gold.label }, category: [{ coding: [{ code: 'laboratory' }] }] }, as(r1));
    assert.equal(order.status, 201, order.text);
    const n1 = (await s.call('POST', `/agent-ops/attempts/${mine[0].id}/next`, {}, as(r1))).json;
    assert.deepEqual([n1.closed.scores.success.pass, n1.closed.scores.success.met, n1.closed.scores.steps >= 1], [true, 1, true], JSON.stringify(n1.closed.scores));
    const n2 = (await s.call('POST', `/agent-ops/attempts/${mine[1].id}/next`, {}, as(r1))).json;
    assert.equal(n2.closed.scores.success.pass, false, 'nothing was ordered on the second task');
    // Expert grade: by a credentialed person or a Researcher, never on your own attempt, against the task's rubric.
    const target = agentAttempts[0].id;
    assert.equal((await s.call('POST', `/agent-ops/attempt-grades/${mine[0].id}`, { scores: { 'reasoning-is-sound': 4, safe: 2 } }, as(r1))).status, 403, 'not your own attempt');
    assert.equal((await s.call('POST', `/agent-ops/attempt-grades/${target}`, { scores: { 'reasoning-is-sound': 9, safe: 2 } }, as(r2))).status, 422);
    assert.equal((await s.call('POST', `/agent-ops/attempt-grades/${target}`, { scores: { 'reasoning-is-sound': 4 } }, as(r2))).status, 422, 'every rubric item is graded');
    const q = (await s.call('GET', '/agent-ops/attempt-grades', undefined, as(r2))).json.queue; assert.equal(q.length, 6);
    const g1 = await s.call('POST', `/agent-ops/attempt-grades/${target}`, { scores: { 'reasoning-is-sound': 5, safe: 2 }, comment: 'Clear.' }, as(r2));
    assert.equal(g1.status, 201, g1.text); assert.deepEqual([g1.json.expertGrade.value, g1.json.expertGrade.graders], [1, 1]);
    const g2 = await s.call('POST', `/agent-ops/attempt-grades/${target}`, { scores: { 'reasoning-is-sound': 1, safe: 0 } }, res);
    assert.deepEqual([g2.json.expertGrade.value, g2.json.expertGrade.graders, g2.json.expertGrade.items.map((i) => i.mean)], [0.5, 2, [3, 1]]);
    assert.equal((await s.call('GET', '/agent-ops/attempt-grades', undefined, as(r2))).json.queue.length, 5);
    assert.equal((await s.call('GET', `/agent-ops/attempt-grades/${target}`, undefined, res)).json.grades.length, 2, 'every grade is kept');
    // Report card.
    const card = (await s.call('GET', '/agent-ops/report-card?agent=workup-planner', undefined, res)).json;
    assert.deepEqual([card.tasks, card.modes.autonomous.attempts, card.modes.shadow.attempts, card.modes.hitl.attempts, card.modes.redteam.attempts, card.human.attempts], [2, 2, 2, 0, 0, 2]);
    assert.deepEqual([card.human.success.rate, card.human.success.n], [0.5, 2]);
    assert.equal(card.modes.autonomous.success.n, 2); assert.ok(card.modes.autonomous.success.low <= card.modes.autonomous.success.rate && card.modes.autonomous.success.rate <= card.modes.autonomous.success.high);
    assert.equal(card.modes.autonomous.expertGrade.graded + card.modes.shadow.expertGrade.graded, 1);
    assert.equal(card.modes.hitl.success.rate, null, 'a mode with no attempts shows nothing, not zero');
    // A study on train tasks does not count on the card.
    const train = await makeTasks(s, 1, { split: 'train' });
    const st2 = (await s.call('POST', '/agent-ops/studies', { title: 'Train tasks', taskSet: train.set.id, participants: [{ kind: 'agent', id: 'workup-planner' }], conditions: ['autonomous'] }, res)).json;
    await s.call('POST', `/agent-ops/studies/${st2.id}/start`, {}, res); await s.studies.idle(st2.id);
    const card2 = (await s.call('GET', '/agent-ops/report-card?agent=workup-planner', undefined, res)).json;
    assert.deepEqual([card2.modes.autonomous.attempts, card2.notCounted.notEvalTasks, card2.trainTaskStudies], [2, 1, ['Train tasks']]);
    assert.equal((await s.call('GET', '/agent-ops/report-card?agent=nobody', undefined, res)).status, 404);
  } finally { await s.close(); }
});
