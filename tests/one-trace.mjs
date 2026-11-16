// One trace format (docs/STUDY-DESIGN.md 5): the server writes every action, by a person or an agent, as a step
// with who, saw, did, why, when and which study, task and attempt. The browser does not get to say which.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './support/helpers.mjs';
import { res, as, makeTasks, makePeople } from './support/study-fixtures.mjs';

const shape = (step) => ['who', 'saw', 'did', 'why', 'when', 'which'].every((k) => k in step) && step.who.id && step.did.type && step.when.wall && 'branch' in step.saw;

test('a person and an agent on the same tasks leave traces of the same shape, tied to their attempts by the server', async () => {
  const s = await startTestServer();
  try {
    const { tasks, set, patient } = await makeTasks(s, 2); const [r1, r2] = await makePeople(s, 2);
    const study = (await s.call('POST', '/agent-ops/studies', { title: 'Same tasks', taskSet: set.id, participants: [{ kind: 'agent', id: 'workup-planner' }, { kind: 'person', id: r1.id }, { kind: 'person', id: r2.id }], conditions: ['autonomous'] }, res)).json;
    await s.call('POST', `/agent-ops/studies/${study.id}/start`, {}, res); await s.studies.idle(study.id);
    const [first] = await s.studies.queueOf(r1.id);
    const opened = (await s.call('POST', `/agent-ops/attempts/${first.id}/open`, {}, as(r1))).json;
    // The reader's browser sends only the branch: no run id, or even a wrong one.
    const other = (await s.studies.attemptsOf(study.id)).find((a) => a.participant.kind === 'agent');
    assert.equal((await s.call('GET', `/fhir/R4/Condition?patient=${patient.id}&_branch=${opened.branch}`, undefined, as(r1))).status, 200);
    const note = { resourceType: 'Condition', subject: { reference: `Patient/${patient.id}` }, code: { text: 'Working impression' }, clinicalStatus: { coding: [{ code: 'active' }] } };
    assert.equal((await s.call('POST', `/fhir/R4/Condition?_branch=${opened.branch}`, note, { ...as(r1), 'X-Run-Id': other.runId, 'X-Reasoning': encodeURIComponent('Looks like early injury.') })).status, 201);
    assert.equal((await s.call('POST', `/fhir/R4/Condition?_branch=${opened.branch}`, note, as(r2))).status, 403, 'another participant cannot write into this attempt');
    await s.call('POST', `/agent-ops/attempts/${first.id}/next`, { why: 'Done with this one.' }, as(r1));
    const mine = await s.store.query('TraceStep', { groupKey: opened.runId });
    const kinds = mine.map((x) => x.did.type);
    for (const k of ['run.start', 'attempt.open', 'fhir.search', 'attempt.next', 'run.end']) assert.ok(kinds.includes(k), `${k} is in the reader's trace: ${kinds.join(', ')}`);
    assert.ok(kinds.some((k) => /create/.test(k)), kinds.join(', '));
    for (const step of mine) {
      assert.ok(shape(step), JSON.stringify(step).slice(0, 300));
      assert.deepEqual([step.which.study, step.which.task, step.which.taskVersion, step.which.attempt, step.which.condition], [study.id, tasks.find((t) => t.id === first.taskId).id, 1, first.id, 'human']);
      assert.equal(step.who.id, step.did.type === 'run.end' ? step.who.id : r1.id);
    }
    assert.equal(mine.find((x) => /create/.test(x.did.type)).why, 'Looks like early injury.'); assert.equal(mine.find((x) => x.did.type === 'attempt.next').why, 'Done with this one.');
    const agentSteps = await s.store.query('TraceStep', { groupKey: other.runId });
    assert.ok(agentSteps.length > 2 && agentSteps.every((x) => shape(x) && x.which.study === study.id && x.which.attempt === other.id && x.which.condition === 'autonomous'));
    assert.ok(!agentSteps.some((x) => x.who.id === r1.id), 'the wrong run id sent by the browser was not believed');
    // Work outside any study or run says so.
    const outside = (await s.store.query('TraceStep', { where: (x) => x.did.type === 'study.start' })).pop();
    assert.equal(outside.which, null);
  } finally { await s.close(); }
});
