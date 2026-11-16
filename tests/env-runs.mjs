// The four environment calls (docs/STUDY-DESIGN.md 6): reset, step, state, close. Each must name the task, the
// run and the seed (the agent comes from the key). A run is made by its first attempt. Eval tasks are refused
// for runs; validation tasks are allowed but never exported as training data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './support/helpers.mjs';
import { res, makeTasks } from './support/study-fixtures.mjs';

test('reset, step, state and close need task, run name and seed; runs appear on their own; eval is refused', async () => {
  const before = process.env.ENV_API_ENABLED; process.env.ENV_API_ENABLED = 'true';
  const s = await startTestServer();
  try {
    const train = await makeTasks(s, 2, { split: 'train' }); const val = await makeTasks(s, 1, { split: 'validation' }); const evalT = await makeTasks(s, 1, { split: 'eval' });
    const key = (await s.call('POST', '/api/admin/env-keys', { org: 'Trainer one', evaluation: true }, res)).json; assert.ok(key.token, JSON.stringify(key));
    const env = async (method, path, body) => { const r = await fetch(s.base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.token}` }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ } return { status: r.status, json, text }; };
    const t0 = train.tasks[0].id;
    for (const [body, word] of [[{ task: t0, seed: 1 }, 'run'], [{ task: t0, run: 'night-1' }, 'seed'], [{ run: 'night-1', seed: 1 }, 'task'], [{ task: t0, run: 'night-1', seed: '1.5' }, 'seed']]) { const r = await env('POST', '/env/v1/reset', body); assert.equal(r.status, 422, r.text); assert.match(r.text, new RegExp(`Missing: .*${word}`)); }
    assert.equal((await env('POST', '/env/v1/reset', { task: t0, run: '../bad name!', seed: 1 })).status, 422);
    assert.deepEqual((await s.call('GET', '/agent-ops/training-runs', undefined, res)).json.runs, [], 'no run before the first attempt');
    const a = await env('POST', '/env/v1/reset', { task: t0, run: 'night-1', seed: 1 });
    assert.equal(a.status, 200, a.text); assert.deepEqual([a.json.run, a.json.task, a.json.seed, a.json.attempt], ['night-1', t0, 1, a.json.episodeId]);
    const attempt = a.json.attempt; const four = { task: t0, run: 'night-1', seed: 1, attempt };
    assert.equal((await env('POST', '/env/v1/step', { attempt, action: { tool: 'finish' } })).status, 422, 'step must repeat task, run and seed');
    assert.equal((await env('POST', '/env/v1/step', { ...four, seed: 2, action: { tool: 'finish' } })).status, 409, 'and they must match the attempt');
    assert.equal((await env('POST', '/env/v1/step', { ...four, run: 'other', action: { tool: 'finish' } })).status, 409);
    const st = await env('GET', `/env/v1/state/${attempt}?task=${t0}&run=night-1&seed=1`); assert.equal(st.status, 200, st.text); assert.equal(st.json.status, 'running');
    assert.equal((await env('GET', `/env/v1/state/${attempt}`)).status, 422);
    const step = await env('POST', '/env/v1/step', { ...four, action: { tool: 'search-results', args: { params: {} }, reasoning: 'Look first.' } }); assert.equal(step.status, 200, step.text);
    const closed = await env('POST', '/env/v1/close', four); assert.equal(closed.status, 200, closed.text);
    assert.equal((await env('POST', '/env/v1/close', { attempt })).status, 422);
    // The same agent, task, run name and seed start from the same state.
    const again = await env('POST', '/env/v1/reset', { task: t0, run: 'night-1', seed: 1 });
    assert.deepEqual(again.json.observation.briefing?.task ?? null, a.json.observation.briefing?.task ?? null);
    await env('POST', '/env/v1/close', { ...four, attempt: again.json.attempt });
    // Validation: allowed, counted apart. Eval: refused and logged.
    const v = await env('POST', '/env/v1/reset', { task: val.tasks[0].id, run: 'night-1', seed: 3 }); assert.equal(v.status, 200, v.text);
    await env('POST', '/env/v1/close', { task: val.tasks[0].id, run: 'night-1', seed: 3, attempt: v.json.attempt });
    const e = await env('POST', '/env/v1/reset', { task: evalT.tasks[0].id, run: 'night-1', seed: 1 }); assert.equal(e.status, 403, e.text); assert.match(e.text, /eval|held-out/);
    const runs = (await s.call('GET', '/agent-ops/training-runs', undefined, res)).json.runs;
    assert.equal(runs.length, 1); assert.deepEqual([runs[0].name, runs[0].attempts, runs[0].validationAttempts, runs[0].source, runs[0].tags, runs[0].status], ['night-1', 3, 1, 'api', ['API'], 'running']);
    const detail = (await s.call('GET', `/agent-ops/training-runs/${runs[0].id}`, undefined, res)).json;
    assert.deepEqual(detail.attemptList.map((x) => [x.task, x.seed, x.split]), [[t0, 1, 'train'], [t0, 1, 'train'], [val.tasks[0].id, 3, 'validation']]);
    // Every step of an attempt says which run, task and seed it belongs to.
    const steps = await s.store.query('TraceStep', { groupKey: attempt });
    assert.ok(steps.length >= 3 && steps.every((x) => x.which && x.which.run === runs[0].id && x.which.task === t0 && x.which.attempt === attempt && x.which.seed === 1 && x.which.study === null), JSON.stringify(steps.map((x) => x.which)).slice(0, 300));
    // Validation work never leaves as training data.
    const exp = await s.call('GET', '/agent-ops/episodes.jsonl', undefined, res);
    assert.ok(exp.status === 200 && !exp.text.includes(val.tasks[0].id) && exp.text.includes(t0), exp.text.slice(0, 200));
    const fin = await env('POST', '/env/v1/runs/finish', { run: 'night-1' }); assert.equal(fin.json.status, 'finished');
    // From the dashboard: every train and validation task of a set, eval left out.
    assert.equal((await s.call('POST', '/agent-ops/training-runs', { name: 'desk-1', agentId: 'workup-planner', taskSet: evalT.set.id }, res)).status, 422);
    const launched = await s.call('POST', '/agent-ops/training-runs', { name: 'desk-1', agentId: 'workup-planner', taskSet: train.set.id, seed: 4 }, res);
    assert.equal(launched.status, 202, launched.text); assert.equal(launched.json.planned, 2);
    await s.trainingRuns.idle(launched.json.id);
    const desk = (await s.call('GET', `/agent-ops/training-runs/${launched.json.id}`, undefined, res)).json;
    assert.deepEqual([desk.attempts, desk.tags, desk.status, desk.attemptList.length], [2, ['Dashboard'], 'finished', 2]);
  } finally { await s.close(); if (before === undefined) delete process.env.ENV_API_ENABLED; else process.env.ENV_API_ENABLED = before; }
});

test('the WebSocket and MCP routes follow the same rule: task, run name, seed, and the attempt after reset', async () => {
  const before = process.env.ENV_API_ENABLED; process.env.ENV_API_ENABLED = 'true';
  const s = await startTestServer();
  try {
    const train = await makeTasks(s, 1, { split: 'train' }); const evalT = await makeTasks(s, 1, { split: 'eval' }); const t0 = train.tasks[0].id;
    const key = (await s.call('POST', '/api/admin/env-keys', { org: 'Trainer two' }, res)).json;
    const ws = new WebSocket(`${s.base.replace('http', 'ws')}/env/v1/ws`); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const waiting = new Map(); let n = 0; ws.onmessage = (e) => { const m = JSON.parse(e.data); waiting.get(m.id)?.(m); };
    const send = (msg) => new Promise((resolve) => { const id = ++n; waiting.set(id, resolve); ws.send(JSON.stringify({ id, token: key.token, ...msg })); });
    let r = await send({ op: 'reset', task: t0, seed: 1 }); assert.deepEqual([r.ok, r.error.status], [false, 422]); assert.match(r.error.message, /Missing: .*run/);
    r = await send({ op: 'reset', task: evalT.tasks[0].id, run: 'ws-1', seed: 1 }); assert.deepEqual([r.ok, r.error.status], [false, 403]);
    r = await send({ op: 'reset', task: t0, run: 'ws-1', seed: 1 }); assert.equal(r.ok, true, JSON.stringify(r.error)); const attempt = r.result.attempt; assert.deepEqual([r.result.run, r.result.task, r.result.seed], ['ws-1', t0, 1]);
    const four = { task: t0, run: 'ws-1', seed: 1, attempt };
    r = await send({ op: 'step', attempt, action: { tool: 'finish' } }); assert.deepEqual([r.ok, r.error.status], [false, 422], 'the earlier message shape is refused');
    r = await send({ op: 'state', ...four, seed: 9 }); assert.deepEqual([r.ok, r.error.status], [false, 409]);
    r = await send({ op: 'state', ...four }); assert.deepEqual([r.ok, r.result.status], [true, 'running']);
    // MCP: the attempt is in the address, and task, run name and seed come with it.
    const mcp = async (query, body) => { const x = await fetch(`${s.base}/env/v1/mcp/${attempt}${query}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.token}` }, body: JSON.stringify(body) }); return { status: x.status, json: await x.json() }; };
    assert.equal((await mcp('', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 422);
    assert.equal((await mcp(`?task=${t0}&run=other&seed=1`, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 409);
    const tools = await mcp(`?task=${t0}&run=ws-1&seed=1`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }); assert.equal(tools.status, 200); assert.ok(tools.json.result.tools.length > 3);
    r = await send({ op: 'step', ...four, action: { tool: 'finish' } }); assert.equal(r.ok, true, JSON.stringify(r.error));
    r = await send({ op: 'close', ...four }); assert.equal(r.ok, true, JSON.stringify(r.error));
    ws.close();
    const runs = (await s.call('GET', '/agent-ops/training-runs', undefined, res)).json.runs; assert.deepEqual(runs.map((x) => [x.name, x.attempts]), [['ws-1', 1]]);
  } finally { await s.close(); if (before === undefined) delete process.env.ENV_API_ENABLED; else process.env.ENV_API_ENABLED = before; }
});
