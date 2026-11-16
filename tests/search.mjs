// The Library's list and search (docs/STUDY-DESIGN.md 9).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './support/helpers.mjs';
import { res, as, makeTasks, makePeople } from './support/study-fixtures.mjs';

test('the default list is every agent and person; filters switch to attempts across studies and runs', async () => {
  const s = await startTestServer();
  try {
    const { tasks, set } = await makeTasks(s, 2); const [r1] = await makePeople(s, 1); const train = await makeTasks(s, 1, { split: 'train' });
    const list = (await s.call('GET', '/agent-ops/library-list', undefined, res)).json;
    assert.ok(list.rows.filter((r) => r.kind === 'agent').length >= 3); assert.deepEqual(list.rows.filter((r) => r.kind === 'person').map((p) => [p.status, p.detail, p.lastActive]), [['Invited', 'Physician', null]]);
    assert.equal((await s.call('GET', '/agent-ops/library-list', undefined, as(r1))).json.rows.some((r) => r.kind === 'person'), false, 'people are listed for the Researcher only');
    assert.equal((await s.call('GET', '/agent-ops/library-list', undefined, { 'X-Role': 'patient' })).status, 403);
    const study = (await s.call('POST', '/agent-ops/studies', { title: 'Search me', taskSet: set.id, participants: [{ kind: 'agent', id: 'workup-planner' }, { kind: 'person', id: r1.id }], conditions: ['autonomous', 'redteam'] }, res)).json;
    await s.call('POST', `/agent-ops/studies/${study.id}/start`, {}, res); await s.studies.idle(study.id);
    const launched = (await s.call('POST', '/agent-ops/training-runs', { name: 'find-me', agentId: 'workup-planner', taskSet: train.set.id }, res)).json; await s.trainingRuns.idle(launched.id);
    await new Promise((r) => setTimeout(r, 100));
    const find = async (q) => (await s.call('GET', `/agent-ops/search?${q}`, undefined, res)).json;
    assert.equal((await find(`study=${study.id}`)).total, 6); assert.equal((await find('mode=redteam')).total, 2); assert.equal((await find('mode=training')).total, 1); assert.equal((await find(`run=${launched.id}`)).total, 1);
    assert.equal((await find(`person=${r1.id}`)).total, 2); assert.equal((await find('outcome=open')).total, 2); assert.equal((await find(`task=${tasks[0].id}`)).total, 3);
    assert.equal((await find('agent=workup-planner&mode=autonomous')).total, 2); assert.equal((await find('q=find-me')).total, 1); assert.equal((await find('q=search%20me&mode=human')).total, 2);
    assert.equal((await find('outcome=ungraded')).total, 4); assert.equal((await find('from=2999-01-01')).total, 0); assert.equal((await find('to=2999-01-01')).total, 7);
    assert.equal((await find('version=0.0.0')).total, 0);
    const row = (await find('mode=training')).results[0]; assert.deepEqual([row.kind, row.container, row.containerId, row.runId === row.id], ['run', 'find-me', launched.id, true]);
    assert.equal((await s.call('GET', '/agent-ops/search?mode=nonsense', undefined, res)).status, 422);
    assert.equal((await s.call('GET', `/agent-ops/search?study=${study.id}`, undefined, as(r1))).json.results.filter((x) => x.mode === 'human')[0].participant, 'A person', 'other staff do not see readers\' names');
    const o = (await s.call('GET', '/agent-ops/search?options=1', undefined, res)).json; assert.deepEqual([o.studies.length, o.runs.length, o.tasks.length, o.people.length], [1, 1, 3, 1]);
  } finally { await s.close(); }
});
