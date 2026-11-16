// Deletion rules: only whole units are deleted, completely and in one transaction; a single trace step, attempt
// or log entry can never be changed or removed; the main chart is never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './support/helpers.mjs';
import { res, makeTasks } from './support/study-fixtures.mjs';

const mainChart = async (s) => JSON.stringify(await s.store.raw().all("SELECT seq, resource_type, id, version_id FROM resource_versions WHERE branch = 'main' AND internal = 0 AND resource_type NOT IN ('AuditEvent', 'AdverseEvent') ORDER BY seq", []));
const count = async (s, where, params = []) => Number((await s.store.raw().get(`SELECT COUNT(*) AS n FROM resource_versions WHERE ${where}`, params)).n);
async function study(s, title) {
  const { tasks, set } = await makeTasks(s, 2);
  const id = (await s.call('POST', '/agent-ops/studies', { title, taskSet: set.id, participants: [{ kind: 'agent', id: 'workup-planner' }], conditions: ['autonomous'], seed: 3 }, res)).json.id;
  assert.equal((await s.call('POST', `/agent-ops/studies/${id}/start`, {}, res)).status, 200); await s.studies.idle(id);
  return { id, tasks, attempts: await s.studies.attemptsOf(id) };
}

test('deleting a study removes all its parts in one go and leaves the main chart and other studies alone', async () => {
  const s = await startTestServer();
  try {
    const a = await study(s, 'To delete'); const b = await study(s, 'To keep');
    await s.call('POST', `/agent-ops/attempt-grades/${a.attempts[0].id}`, { score: 1, comment: 'x' }, res); // a grade, if this build accepts one here
    const chart = await mainChart(s); const runIds = a.attempts.map((x) => x.runId); const branches = a.attempts.map((x) => x.branch);
    assert.ok(await count(s, `resource_type = 'TraceStep' AND group_key IN (${runIds.map(() => '?').join()})`, runIds) > 0);
    assert.equal((await s.call('DELETE', `/agent-ops/delete/study/${a.id}`, undefined, { 'X-Role': 'physician' })).status, 403, 'only a Researcher');
    const pre = await s.call('GET', `/agent-ops/delete/study/${a.id}`, undefined, res); assert.equal(pre.status, 200, pre.text);
    assert.equal(pre.json.counts.attempts >= 2, true, JSON.stringify(pre.json.counts)); assert.equal(pre.json.counts.branches, 2); assert.ok(pre.json.counts['trace steps'] > 0); assert.ok(pre.json.counts.runs >= 2);
    assert.ok(await s.store.get('EvalStudy', a.id), 'the preview deleted nothing');
    const del = await s.call('DELETE', `/agent-ops/delete/study/${a.id}`, undefined, res); assert.equal(del.status, 200, del.text); assert.deepEqual(del.json.counts, pre.json.counts, 'what was shown is what was deleted');
    // Nothing is left: not the study, its attempts, runs, trace steps, branches, or any record that names them. No marker either.
    const ids = [a.id, ...a.attempts.map((x) => x.id), ...runIds];
    for (const id of ids) assert.equal(await count(s, 'id = ? OR group_key = ? OR (internal = 1 AND CAST(body AS TEXT) LIKE ?)', [id, id, `%"${id}"%`]), 0, `something still names ${id}`);
    for (const br of branches) { assert.equal(await count(s, 'branch = ?', [br]), 0); assert.equal(await s.store.raw().get('SELECT id FROM branches WHERE id = ?', [br]) ?? null, null); }
    assert.equal((await s.call('GET', `/agent-ops/studies/${a.id}`, undefined, res)).status, 404);
    assert.equal(await mainChart(s), chart, 'the main chart is unchanged');
    // The other study is whole, and the log is still append-only outside a whole-unit deletion.
    assert.equal((await s.studies.attemptsOf(b.id)).length, 2); assert.ok(await count(s, "resource_type = 'TraceStep' AND group_key = ?", [b.attempts[0].runId]) > 0);
    await assert.rejects(() => s.store.raw().run("DELETE FROM resource_versions WHERE resource_type = 'TraceStep'", []), /append-only/);
    await assert.rejects(() => s.store.raw().run("UPDATE resource_versions SET body = '{}' WHERE resource_type = 'TraceStep'", []), /append-only/);
    // Clear all test data: every study, run and branch goes; patients, the main chart, agents and the Library stay.
    const agents = (await s.store.query('Agent', {})).length; const tasks = (await s.store.query('EvalCase', {})).length;
    const all = await s.call('GET', '/agent-ops/delete/all', undefined, res); assert.ok(all.json.counts.studies >= 1 && all.json.counts.branches >= 2, JSON.stringify(all.json.counts));
    assert.equal((await s.call('DELETE', '/agent-ops/delete/all', undefined, res)).status, 200);
    assert.equal(await count(s, "resource_type IN ('EvalStudy', 'Attempt') OR (resource_type = 'Run' AND id <> 'live') OR (resource_type = 'TraceStep' AND group_key <> 'live') OR branch <> 'main'"), 0);
    assert.equal((await s.store.listBranches()).filter((x) => x.id !== 'main').length, 0);
    assert.equal(await mainChart(s), chart); assert.equal((await s.store.query('Agent', {})).length, agents); assert.equal((await s.store.query('EvalCase', {})).length, tasks); assert.ok(await s.store.get('Run', 'live'));
  } finally { await s.close(); }
});

test('a single trace step, attempt or log entry can never be changed or deleted', async () => {
  const s = await startTestServer();
  try {
    const a = await study(s, 'Whole units only'); const step = (await s.store.query('TraceStep', { groupKey: a.attempts[0].runId }))[0]; const before = await count(s, '1 = 1');
    const tries = [['DELETE', `/fhir/R4/TraceStep/${step.id}`], ['PUT', `/fhir/R4/TraceStep/${step.id}`], ['DELETE', `/agent-ops/trace/${step.id}`], ['DELETE', `/agent-ops/attempts/${a.attempts[0].id}`], ['PUT', `/agent-ops/attempts/${a.attempts[0].id}`], ['DELETE', '/fhir/R4/AuditEvent/any'], ['PUT', '/fhir/R4/AuditEvent/any']];
    for (const [method, url] of tries) { const r = await s.call(method, url, method === 'PUT' ? { resourceType: 'TraceStep', id: step.id } : undefined, res); assert.equal(r.status, 405, `${method} ${url}: ${r.status}`); assert.match(r.text, /never changed or deleted/); }
    // A run that is one attempt of a study is not deleted by itself either.
    assert.equal((await s.call('DELETE', `/agent-ops/delete/run/${a.attempts[0].runId}`, undefined, res)).status, 409);
    assert.equal((await s.call('DELETE', '/agent-ops/delete/run/live', undefined, res)).status, 409);
    assert.equal(await count(s, '1 = 1'), before, 'nothing was removed');
    assert.ok(await s.store.get('TraceStep', step.id));
  } finally { await s.close(); }
});

test('surveillance goes with the unit; built-in agents are turned off, not deleted; a deleted agent does not come back', async () => {
  const { ensureReferenceAgents } = await import('../agent-operations/server/agents.mjs');
  const s = await startTestServer();
  try {
    assert.equal((await s.call('POST', '/agent-ops/agents', { id: 'my-agent', name: 'My agent', version: '1', adapter: { kind: 'external' }, connection: 'mcp', scopes: [{ type: 'Task', interactions: ['create'] }] }, res)).status, 201);
    const start = async () => (await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'my-agent' }, res)).json; const one = await start(); const two = await start(); const replay = await start();
    const file = async (run) => { const r = await s.call('POST', '/agent-ops/surveillance/reports', { narrative: 'The agent suggested the wrong test.', reachedPatient: 'no', severity: 'mild', harm: 'wrong', about: { run } }, { 'X-Role': 'physician', 'X-User-Id': 'doc-1' }); assert.ok(r.status < 300, r.text); return (await s.store.query('AdverseEvent', {})).filter((d) => d._surv?.context?.run === run)[0]; };
    const about1 = await file(one.id); const about2 = await file(two.id);
    // The report about run two was replayed once: the replay is its own run.
    { const { _seq, meta, ...doc } = about2; await s.store.save('AdverseEvent', { ...doc, _surv: { ...doc._surv, reproduced: { verdict: 'yes', k: 1, n: 1, sameVersion: [{ label: 'same version, attempt 1', run: replay.id, same: true }], perturbations: [], currentVersion: null } } }, { updatedBy: 'test' }); }
    const chart = await mainChart(s);
    // Deleting only the replay keeps the report, without the link; no version of it names the replay any more.
    const pre = (await s.call('GET', `/agent-ops/delete/run/${replay.id}`, undefined, res)).json; assert.equal(pre.counts['reports kept, with the link to a deleted replay removed'], 1, JSON.stringify(pre.counts));
    assert.equal((await s.call('DELETE', `/agent-ops/delete/run/${replay.id}`, undefined, res)).status, 200);
    const kept = await s.store.get('AdverseEvent', about2.id); assert.ok(kept); assert.equal(kept._surv.reproduced, null); assert.equal(kept._surv.context.run, two.id); assert.equal(await count(s, 'CAST(body AS TEXT) LIKE ?', [`%${replay.id}%`]), 0);
    // Deleting a run deletes the report that is only about it, shown in the counts.
    const pre1 = (await s.call('GET', `/agent-ops/delete/run/${one.id}`, undefined, res)).json; assert.ok(pre1.counts['surveillance reports'] >= 1, JSON.stringify(pre1.counts));
    assert.equal((await s.call('DELETE', `/agent-ops/delete/run/${one.id}`, undefined, res)).status, 200);
    assert.equal(await s.store.get('AdverseEvent', about1.id), null); assert.equal(await count(s, 'CAST(body AS TEXT) LIKE ?', [`%${one.id}%`]), 0); assert.equal(await count(s, 'CAST(body AS TEXT) LIKE ?', [`%${about1._surv.caseId}%`]), 0);
    assert.ok(await s.store.get('AdverseEvent', about2.id), 'the other report stays');
    // Built-in agents cannot be deleted. A deleted agent takes its runs and reports with it and is not made again at start-up.
    const builtIn = (await s.store.query('Agent', { where: (a) => a.builtIn }))[0]; const no = await s.call('DELETE', `/agent-ops/delete/agent/${builtIn.id}`, undefined, res); assert.equal(no.status, 409); assert.match(no.text, /Turn it off/);
    assert.equal((await s.call('DELETE', '/agent-ops/delete/agent/my-agent', undefined, res)).status, 200);
    assert.equal(await s.store.get('Agent', 'my-agent'), null); assert.equal(await s.store.get('AdverseEvent', about2.id), null); assert.equal(await count(s, "resource_type = 'Run' AND id = ?", [two.id]), 0);
    await ensureReferenceAgents(s.store); assert.equal(await s.store.get('Agent', 'my-agent'), null, 'not re-created at start-up'); assert.ok(await s.store.get('Agent', builtIn.id));
    assert.equal(await mainChart(s), chart, 'the main chart is unchanged');
  } finally { await s.close(); }
});
