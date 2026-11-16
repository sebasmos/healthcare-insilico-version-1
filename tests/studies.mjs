// Studies and attempts (docs/STUDY-DESIGN.md 4 and 5): frozen at start, every attempt made up front, each on its
// own branch; agents run on their own; people work in order with "Next task", which closes and locks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './support/helpers.mjs';
import { res, as, makeTasks, makePeople } from './support/study-fixtures.mjs';
import { orderTasks, readersFor } from '../agent-operations/server/studies.mjs';

test('task order and assignment', () => {
  const t = ['a', 'b', 'c', 'd'];
  assert.deepEqual(orderTasks(t, 'fixed', 1, 'x', 2), t);
  const square = [0, 1, 2, 3].map((i) => orderTasks(t, 'counterbalanced', 1, `p${i}`, i));
  for (let pos = 0; pos < 4; pos += 1) assert.equal(new Set(square.map((row) => row[pos])).size, 4, 'each task appears once in each position');
  const one = orderTasks(t, 'shuffled', 7, 'p1', 0);
  assert.deepEqual(one, orderTasks(t, 'shuffled', 7, 'p1', 0), 'the same seed gives the same order'); assert.deepEqual([...one].sort(), t);
  assert.ok([1, 2, 3, 4, 5, 6].some((n) => orderTasks(t, 'shuffled', 7, `p${n}`, 0).join() !== one.join()), 'participants get different orders');
  const people = ['r1', 'r2', 'r3'].map((id) => ({ id }));
  const count = (asg, n = 6) => { const c = { r1: 0, r2: 0, r3: 0 }; for (let j = 0; j < n; j += 1) for (const r of readersFor(j, people, asg)) c[r.id] += 1; return c; };
  assert.deepEqual(count({ mode: 'all' }), { r1: 6, r2: 6, r3: 6 }); assert.deepEqual(count({ mode: 'k', k: 2 }), { r1: 4, r2: 4, r3: 4 }); assert.deepEqual(count({ mode: 'split' }), { r1: 2, r2: 2, r3: 2 });
});

test('agents in a study: frozen at start, every attempt up front, each on its own branch, run automatically', async () => {
  const s = await startTestServer();
  try {
    const { tasks, set } = await makeTasks(s, 3);
    const draft = await s.call('POST', '/agent-ops/studies', { title: 'Planner check', taskSet: set.id, participants: [{ kind: 'agent', id: 'workup-planner' }], conditions: ['autonomous', 'shadow'], order: 'counterbalanced', seed: 5 }, res);
    assert.equal(draft.status, 201, draft.text); assert.equal(draft.json.status, 'draft'); assert.deepEqual(draft.json.tags, ['Autonomous', 'Shadow']);
    const id = draft.json.id;
    assert.equal((await s.call('POST', `/agent-ops/studies/${id}/start`, {}, { 'X-Role': 'physician' })).status, 403, 'only a Researcher starts a study');
    assert.equal((await s.call('PUT', `/agent-ops/studies/${id}`, { title: 'Planner check, renamed' }, res)).status, 200, 'a draft can change');
    const started = await s.call('POST', `/agent-ops/studies/${id}/start`, {}, res);
    assert.equal(started.status, 200, started.text); assert.deepEqual([started.json.status, started.json.attempts], ['started', 6]);
    assert.deepEqual(started.json.frozen.tasks.map((t) => [t.taskId, t.version]), tasks.map((t) => [t.id, 1]));
    assert.equal((await s.call('PUT', `/agent-ops/studies/${id}`, { title: 'Too late' }, res)).status, 409, 'a started study is frozen');
    assert.equal((await s.call('POST', `/agent-ops/studies/${id}/start`, {}, res)).status, 409);
    await s.call('PUT', `/agent-ops/cases/${tasks[0].id}`, { task: 'A reworded instruction.' }, res); // the task moves on; the study does not
    await s.studies.idle(id);
    const grid = (await s.call('GET', `/agent-ops/studies/${id}`, undefined, res)).json;
    assert.deepEqual([grid.rows.length, grid.columns.length, grid.cells.length], [1, 3, 6]);
    assert.equal(grid.study.status, 'finished'); assert.equal(grid.study.progress, 1);
    assert.ok(grid.cells.every((c) => c.state === 'closed' && c.runId), JSON.stringify(grid.cells.map((c) => [c.state, c.error])));
    const attempts = await s.studies.attemptsOf(id);
    assert.equal(new Set(attempts.map((a) => a.branch)).size, 6, 'six attempts, six branches'); assert.ok(attempts.every((a) => a.branch !== 'main' && a.seal.hash.length === 64 && a.seal.steps > 0));
    assert.deepEqual(attempts.map((a) => a.position), [0, 1, 2, 3, 4, 5]);
    for (const a of attempts) {
      const run = await s.store.get('Run', a.runId);
      assert.deepEqual([run.attempt.study, run.attempt.attempt, run.attempt.task, run.attempt.taskVersion, run.attempt.condition], [id, a.id, a.taskId, 1, a.condition]);
      assert.equal(run.mode, a.condition === 'shadow' ? 'shadow-task' : 'rl-generate'); assert.ok(run.endedAt);
      assert.equal(run.goal, a.taskId === tasks[0].id ? 'Decide what to order (1).' : run.goal, 'the instruction is the one frozen at start');
    }
    // Locked: nothing more is written to a closed attempt's branch.
    const late = await s.call('POST', `/fhir/R4/Condition?_branch=${attempts[0].branch}`, { resourceType: 'Condition', subject: { reference: tasks[0].patient }, code: { text: 'Late note' }, clinicalStatus: { coding: [{ code: 'active' }] } });
    assert.equal(late.status, 409, late.text);
    const copy = await s.call('POST', `/agent-ops/studies/${id}/copy`, {}, res);
    assert.deepEqual([copy.status, copy.json.status, copy.json.copiedFrom], [201, 'draft', id]);
    const list = (await s.call('GET', '/agent-ops/studies', undefined, res)).json.studies;
    assert.equal(list.length, 2);
  } finally { await s.close(); }
});

test('people in a study: tasks in order, own branch each, "Next task" closes, locks and opens the next', async () => {
  const s = await startTestServer();
  try {
    const { tasks, set, patient } = await makeTasks(s, 3); const [r1, r2] = await makePeople(s, 2);
    const bad = await s.call('POST', '/agent-ops/studies', { title: 'Loop without people', taskSet: set.id, participants: [{ kind: 'agent', id: 'workup-planner' }], conditions: ['hitl'] }, res);
    assert.equal((await s.call('POST', `/agent-ops/studies/${bad.json.id}/start`, {}, res)).status, 422, 'human in the loop needs a person');
    const study = (await s.call('POST', '/agent-ops/studies', { title: 'Human baseline', taskSet: set.id, participants: [{ kind: 'person', id: r1.id }, { kind: 'person', id: r2.id }], order: 'fixed' }, res)).json;
    const started = await s.call('POST', `/agent-ops/studies/${study.id}/start`, {}, res);
    assert.equal(started.json.attempts, 6); assert.deepEqual(started.json.tags, ['Human baseline']);
    const mine = (await s.studies.queueOf(r1.id)).map((a) => a.id);
    assert.equal(mine.length, 3);
    assert.equal((await s.call('POST', `/agent-ops/attempts/${mine[0]}/open`, {}, as(r2))).status, 403, 'not this reader\'s attempt');
    assert.equal((await s.call('POST', `/agent-ops/attempts/${mine[1]}/open`, {}, as(r1))).status, 409, 'tasks are done in order');
    assert.equal((await s.call('POST', `/agent-ops/attempts/${mine[0]}/next`, {}, as(r1))).status, 409, 'open it first');
    const opened = await s.call('POST', `/agent-ops/attempts/${mine[0]}/open`, {}, as(r1));
    assert.equal(opened.status, 200, opened.text); assert.equal(opened.json.state, 'open'); assert.equal(opened.json.task.instruction, 'Decide what to order (1).');
    const branch = opened.json.branch; assert.notEqual(branch, 'main');
    const note = { resourceType: 'Condition', subject: { reference: `Patient/${patient.id}` }, code: { text: 'Working impression' }, clinicalStatus: { coding: [{ code: 'active' }] } };
    assert.equal((await s.call('POST', `/fhir/R4/Condition?_branch=${branch}`, note, { ...as(r1), 'X-Run-Id': opened.json.runId })).status, 201);
    assert.equal((await s.store.query('Condition', {})).length, 0, 'nothing the reader does reaches the live record');
    const nxt = await s.call('POST', `/agent-ops/attempts/${mine[0]}/next`, { answer: { label: 'order' }, why: 'Creatinine first.' }, as(r1));
    assert.equal(nxt.status, 200, nxt.text);
    assert.deepEqual([nxt.json.closed.state, nxt.json.closed.answer.label, nxt.json.next.id, nxt.json.next.state, nxt.json.done], ['closed', 'order', mine[1], 'open', false]);
    assert.notEqual(nxt.json.next.branch, branch, 'the next attempt has its own branch');
    assert.equal((await s.call('POST', `/fhir/R4/Condition?_branch=${branch}`, note, as(r1))).status, 409, 'the closed attempt is locked');
    assert.equal((await s.call('POST', `/agent-ops/attempts/${mine[0]}/next`, {}, as(r1))).status, 409, 'no going back');
    assert.equal((await s.call('POST', `/agent-ops/attempts/${mine[1]}/next`, { skip: true }, as(r1))).json.closed.state, 'skipped');
    const last = await s.call('POST', `/agent-ops/attempts/${mine[2]}/next`, {}, as(r1));
    assert.deepEqual([last.json.done, last.json.next], [true, null]);
    assert.equal((await s.call('GET', `/agent-ops/studies/${study.id}`, undefined, res)).json.study.status, 'started', 'the other reader is not finished');
    assert.equal((await s.call('GET', `/agent-ops/attempts/${mine[0]}`, undefined, as(r2))).status, 403);
    const stopped = await s.call('POST', `/agent-ops/studies/${study.id}/stop`, {}, res);
    assert.equal(stopped.json.status, 'stopped'); assert.ok((await s.studies.queueOf(r2.id)).every((a) => a.state === 'stopped'));
    assert.equal((await s.call('POST', `/agent-ops/attempts/${(await s.studies.queueOf(r2.id))[0].id}/open`, {}, as(r2))).status, 409);
  } finally { await s.close(); }
});

test('red team and human in the loop conditions, a perturbation, and a live shadow study', async () => {
  const s = await startTestServer();
  try {
    const { tasks, set, patient } = await makeTasks(s, 2); const [r1] = await makePeople(s, 1);
    const overlay = (await s.call('POST', '/agent-ops/studies', { title: 'Bad overlay', taskSet: set.id, perturbations: [{ label: 'x', overlays: [{ nonsense: true }] }] }, res));
    assert.equal(overlay.status, 422);
    const study = (await s.call('POST', '/agent-ops/studies', { title: 'Mixed', taskSet: set.id, participants: [{ kind: 'agent', id: 'workup-planner' }, { kind: 'person', id: r1.id }], conditions: ['redteam', 'hitl'], humanBaseline: false }, res)).json;
    const started = (await s.call('POST', `/agent-ops/studies/${study.id}/start`, {}, res)).json;
    assert.equal(started.attempts, 4); assert.deepEqual(started.tags, ['Red team', 'Human in the loop']);
    await s.studies.idle(study.id);
    const all = await s.studies.attemptsOf(study.id);
    const red = all.filter((a) => a.condition === 'redteam'); const loop = all.filter((a) => a.condition === 'hitl');
    assert.ok(red.every((a) => a.state === 'closed' && a.branch.startsWith('redteam-')), JSON.stringify(red.map((a) => [a.state, a.error, a.branch])));
    assert.ok(loop.every((a) => a.state === 'waiting' && a.human === r1.id), 'the loop attempts wait for their person');
    assert.deepEqual((await s.studies.queueOf(r1.id)).map((a) => a.condition), ['hitl', 'hitl']);
    const opened = await s.call('POST', `/agent-ops/attempts/${loop[0].id}/open`, {}, as(r1));
    assert.equal(opened.status, 200, opened.text); assert.ok(opened.json.branch.startsWith('sandbox-'));
    const run = await s.store.get('Run', opened.json.runId); assert.deepEqual([run.mode, run.targetBranch, run.attempt.attempt], ['hitl', opened.json.branch, loop[0].id]);
    await new Promise((r) => setTimeout(r, 300));
    const done = await s.call('POST', `/agent-ops/attempts/${loop[0].id}/next`, {}, as(r1));
    assert.equal(done.status, 200, done.text); assert.equal(done.json.next.id, loop[1].id);
    // Live: the study watches patients on the live record; each watched event becomes an attempt, tagged Live.
    assert.equal((await s.call('POST', '/agent-ops/studies', { title: 'Live with people', live: {}, participants: [{ kind: 'person', id: r1.id }], conditions: ['shadow'] }, res).then((r) => s.call('POST', `/agent-ops/studies/${r.json.id}/start`, {}, res))).status, 422);
    const live = (await s.call('POST', '/agent-ops/studies', { title: 'Live watch', live: { clock: 'real' }, participants: [{ kind: 'agent', id: 'chart-summariser' }], conditions: ['shadow'] }, res)).json;
    const go = await s.call('POST', `/agent-ops/studies/${live.id}/start`, {}, res);
    assert.equal(go.status, 200, go.text); assert.deepEqual([go.json.tags, go.json.attempts], [['Live', 'Shadow'], 0]);
    assert.equal((await s.store.get('Agent', 'chart-summariser')).shadow.event, true);
    const { createRun, endRun } = await import('../agent-operations/server/runs.mjs');
    const actor = { kind: 'human', id: 'system', role: 'system' };
    const watched = await createRun(s.store, { mode: 'shadow-event', agentId: 'chart-summariser', subject: `Patient/${patient.id}`, trigger: { kind: 'chart-open' } }, actor);
    await new Promise((r) => setTimeout(r, 100));
    let la = await s.studies.attemptsOf(live.id); assert.deepEqual(la.map((a) => [a.state, a.runId, a.hidden, a.event.kind]), [['open', watched.id, true, 'chart-open']]);
    await endRun(s.store, watched.id, actor); await new Promise((r) => setTimeout(r, 100));
    la = await s.studies.attemptsOf(live.id); assert.equal(la[0].state, 'closed');
    const grid = (await s.call('GET', `/agent-ops/studies/${live.id}`, undefined, res)).json; assert.deepEqual(grid.columns.map((c) => c.title), ['Event 1']);
    await s.call('POST', `/agent-ops/studies/${live.id}/stop`, {}, res);
    assert.equal((await s.store.get('Agent', 'chart-summariser')).shadow.event, false, 'stopping turns the watching off again');
    void tasks;
  } finally { await s.close(); }
});

test('a live shadow study acts on its clock: simulation takes simulated-time events and keeps simulated times; real takes the rest', async () => {
  const s = await startTestServer();
  try {
    const { patient } = await makeTasks(s, 1); const actor = { kind: 'human', id: 'system', role: 'system' };
    const { createRun, endRun } = await import('../agent-operations/server/runs.mjs'); const { newClock } = await import('../platform/server/simclock.mjs');
    const mk = async (clock) => { const st = (await s.call('POST', '/agent-ops/studies', { title: `Live ${clock}`, live: { clock }, participants: [{ kind: 'agent', id: 'chart-summariser' }], conditions: ['shadow'] }, res)).json; await s.call('POST', `/agent-ops/studies/${st.id}/start`, {}, res); return st.id; };
    const sim = await mk('simulation'); const real = await mk('real');
    assert.equal((await s.call('GET', `/agent-ops/studies/${sim}`, undefined, res)).json.study.live.clock, 'simulation');
    // An event in real time.
    const a = await createRun(s.store, { mode: 'shadow-event', agentId: 'chart-summariser', subject: `Patient/${patient.id}`, trigger: { kind: 'chart-open' } }, actor);
    // An event inside a simulation: its run carries a simulation clock, sixty times real time, started a simulated day ago.
    const t0 = new Date(Date.now() - 1000).toISOString();
    const b = await createRun(s.store, { mode: 'shadow-event', agentId: 'chart-summariser', subject: `Patient/${patient.id}`, trigger: { kind: 'message' } }, actor);
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual((await s.studies.attemptsOf(real)).map((x) => x.runId).sort(), [a.id, b.id].sort(), 'without a simulation clock both are real-time events');
    assert.equal((await s.studies.attemptsOf(sim)).length, 0, 'and the simulation study takes neither');
    // Now one that really is simulated: the clock is on the run before it is announced.
    const { runEvents } = await import('../agent-operations/server/runs.mjs');
    const c = await createRun(s.store, { mode: 'sandbox', subject: `Patient/${patient.id}` }, actor);
    const simRun = await s.store.transaction(async (tx) => { const { _seq, ...doc } = await tx.get('Run', c.id); return tx.save('Run', { ...doc, mode: 'shadow-event', agentId: 'chart-summariser', trigger: { kind: 'result' }, sim: newClock({ mode: 'accelerated', speed: 3600, t0 }) }, { updatedBy: 'test' }); });
    runEvents.emit('created', simRun, s.store); await new Promise((r) => setTimeout(r, 300));
    const got = await s.studies.attemptsOf(sim); assert.deepEqual(got.map((x) => [x.runId, x.clock, x.event.kind]), [[c.id, 'simulation', 'result']]); assert.ok(got[0].simulatedAt > t0);
    assert.equal((await s.studies.attemptsOf(real)).length, 2, 'the real-time study does not take the simulated event');
    await endRun(s.store, c.id, actor); await new Promise((r) => setTimeout(r, 300));
    const closed = (await s.studies.attemptsOf(sim))[0];
    assert.deepEqual([closed.state, closed.scores.clock], ['closed', 'simulation']); assert.ok(closed.scores.seconds >= 600, `time is counted on the simulation clock: ${closed.scores.seconds} simulated seconds for a fraction of a real second`);
    assert.ok(closed.simulatedClosedAt > closed.simulatedAt);
  } finally { await s.close(); }
});
