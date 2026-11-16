// Human grading of agent traces: step and episode grades as expert-grade
// Observations, independent graders, adjudication, the safety queue, the
// effect on rewards, and the trace view the grader reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, BACKEND } from './support/helpers.mjs';
import { settle, uncertainty } from '../agent-operations/server/grades.mjs';
import { summarise } from '../agent-operations/server/trace-view.mjs';

const as = (id, role = 'physician') => ({ 'X-User-Id': id, 'X-Role': role });

async function setup({ attempts = 3 } = {}) {
  const s = await startTestServer();
  await s.call('POST', '/agent-ops/cases/load', {});
  const cases = (await s.call('GET', '/agent-ops/cases')).json.cases;
  const aki = cases.find((c) => c.slug === 'acute-kidney-injury');
  const out = (await s.call('POST', '/agent-ops/rollouts', { agentId: 'workup-planner', caseId: aki.id, attempts, seed: 0 })).json;
  const episodes = out.episodes;
  const grade = (who, episodeId, body) => s.call('POST', '/agent-ops/grades/episodes', { episodeId, ...body }, as(who));
  const reward = async (id) => (await s.call('GET', `/agent-ops/episodes?caseId=${aki.id}`)).json.episodes.find((e) => e.id === id).outcome;
  return { s, aki, episodes, grade, reward };
}

test('settling grades: one grade, agreement, a mean when graders differ, adjudication wins, unsafe always flags', () => {
  const g = (value, role = 'read') => ({ kind: 'episode', role, value });
  assert.equal(settle([]), null);
  assert.deepEqual(settle([g('correct')]), { grades: ['correct'], value: 1, final: 'correct', source: 'single', agree: true, unsafe: false });
  assert.equal(settle([g('correct'), g('correct')]).source, 'consensus');
  const split = settle([g('correct'), g('incorrect')]);
  assert.deepEqual([split.value, split.final, split.source, split.agree], [0.5, null, 'mean', false]);
  const settled = settle([g('correct'), g('incorrect'), g('mostly-correct', 'adjudication')]);
  assert.deepEqual([settled.value, settled.final, settled.source], [0.75, 'mostly-correct', 'adjudicated']);
  assert.equal(settle([g('correct'), g('unsafe')]).unsafe, true);
  assert.equal(settle([g('unsafe'), g('unsafe'), g('incorrect', 'adjudication')]).unsafe, true, 'an unsafe grade is not erased by adjudication');
  assert.equal(uncertainty({ outcome: { verifier: { score: 0.5 } } }), 0.5);
  assert.equal(uncertainty({ outcome: { verifier: { score: 1 } } }), 0);
  assert.ok(uncertainty({ outcome: { verifier: { score: 1 }, judgeDisagreement: 0.3 } }) > 0.5, 'code checks and judge disagreeing is the most uncertain');
});

test('record summaries are plain lines, never raw JSON', () => {
  assert.deepEqual(summarise({ resourceType: 'Observation', status: 'final', code: { coding: [{ display: 'Creatinine' }] }, valueQuantity: { value: 3.1, unit: 'mg/dL' }, interpretation: [{ coding: [{ code: 'H' }] }] }), { kind: 'Result', name: 'Creatinine', value: '3.1 mg/dL (H) · final' });
  assert.deepEqual(summarise({ resourceType: 'MedicationRequest', status: 'active', medicationCodeableConcept: { text: 'Ibuprofen' }, dosageInstruction: [{ text: '400 mg three times daily' }] }), { kind: 'Medication', name: 'Ibuprofen', value: '400 mg three times daily · active' });
  assert.equal(summarise({ resourceType: 'Patient', gender: 'female', birthDate: '1950-02-03', name: [{ family: 'Secret' }] }).name, 'female, born 1950', 'no patient name in a summary');
});

test(`[${BACKEND}] trace view of a shadow run marks the first step where agent and clinician split, with both reasons`, async () => {
  const { agentSetup } = await import('./support/agents.mjs');
  const { s, shadowCase } = await agentSetup();
  try {
    await shadowCase(false);
    const run = (await s.call('GET', '/agent-ops/runs')).json.runs.find((r) => r.mode === 'shadow-task');
    const v = (await s.call('GET', `/agent-ops/trace-view/${run.id}`)).json;
    assert.equal(v.context.kind, 'shadow-task');
    assert.ok(v.split, 'the paths differ');
    assert.ok(v.split.step >= 1 && v.split.agent.did && v.split.human.did);
    const marked = v.steps.filter((x) => x.split);
    assert.equal(marked.length, 1);
    assert.equal(marked[0].id, v.split.agentStepId);
    assert.equal(marked[0].tone, 'agent');
    assert.ok(v.humanPath.steps.length >= 1);
    assert.deepEqual([v.humanPath.outcome.agent, v.humanPath.outcome.human, v.humanPath.outcome.agree], ['normal', 'abnormal', false]);
    assert.equal(v.episode.kind, 'shadow', 'a compared shadow run is an episode and can be graded as a whole');
    const g = await s.call('POST', '/agent-ops/grades/episodes', { episodeId: v.episode.id, grade: 'incorrect', comment: 'Missed the consolidation' }, { 'X-User-Id': 'dr-grader' });
    assert.equal(g.status, 201, g.text);
  } finally { await s.close(); }
});
