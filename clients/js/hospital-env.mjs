// JavaScript client for the hospital environment API (plan-master task 15.5).
// reset, step, state, close, tasks, and a vectorised wrapper for N parallel
// episodes. Used by the tests; no dependencies beyond fetch.
export class HospitalEnv {
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch }) {
    if (!baseUrl || !token) throw new Error('HospitalEnv needs { baseUrl, token }');
    this.baseUrl = baseUrl.replace(/\/$/, ''); this.token = token; this.fetch = fetchImpl;
  }
  async call(method, path, body) {
    const r = await this.fetch(`${this.baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!r.ok) { const err = new Error(json?.error || `HTTP ${r.status}`); err.status = r.status; err.code = json?.code; throw err; }
    return json;
  }
  info() { return this.call('GET', '/env/v1/info'); }
  tasks(filters = {}) { const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v != null)).toString(); return this.call('GET', `/env/v1/tasks${q ? `?${q}` : ''}`); }
  // Every call says which task, run name and seed it is for (the agent is the key). reset takes them in its
  // options ({ task, run, seed, ... }); this client remembers them per attempt and repeats them on step, state and close.
  async reset(options) {
    const { taskId, ...rest } = options || {}; const body = { ...rest, task: rest.task ?? taskId, run: rest.run ?? this.run ?? 'default-run', seed: Number.isInteger(rest.seed) ? rest.seed : 0 };
    const out = await this.call('POST', '/env/v1/reset', body);
    (this.named ||= new Map()).set(out.episodeId, { task: body.task, run: body.run, seed: body.seed, attempt: out.episodeId });
    return out;
  }
  four(episodeId) { const n = this.named?.get(episodeId); if (!n) throw new Error('Unknown attempt: call reset first'); return n; }
  step(episodeId, action) { return this.call('POST', '/env/v1/step', { ...this.four(episodeId), action }); }
  state(episodeId) { const n = this.four(episodeId); return this.call('GET', `/env/v1/state/${encodeURIComponent(episodeId)}?task=${encodeURIComponent(n.task)}&run=${encodeURIComponent(n.run)}&seed=${n.seed}`); }
  close(episodeId) { return this.call('POST', '/env/v1/close', this.four(episodeId)); }
  finishRun(run = this.run) { return this.call('POST', '/env/v1/runs/finish', { run }); }
  /** MCP over HTTP for one episode: list tools, or call one. */
  mcp(episodeId, method, params = {}, id = 1) { const n = this.four(episodeId); return this.call('POST', `/env/v1/mcp/${encodeURIComponent(episodeId)}?task=${encodeURIComponent(n.task)}&run=${encodeURIComponent(n.run)}&seed=${n.seed}`, { jsonrpc: '2.0', id, method, params }); }
  /** Runs one whole episode with a policy function: policy(observation, tools, info) -> action. */
  async runEpisode(resetOptions, policy, { maxSteps = 50 } = {}) {
    const first = await this.reset(resetOptions);
    let obs = first.observation; let info = first.info; const rewards = []; let done = false; let steps = 0; let last = null;
    while (!done && steps < maxSteps) {
      const action = await policy(obs, first.tools, info);
      last = await this.step(first.episodeId, action);
      obs = last.observation; info = last.info; rewards.push(last.reward); done = last.done || last.truncated; steps += 1;
    }
    const closed = await this.close(first.episodeId);
    return { episodeId: first.episodeId, steps, rewards, totalReward: closed.reward, rewardBreakdown: closed.rewardBreakdown, truncated: Boolean(last?.truncated), links: closed.links };
  }
}

/** N episodes, up to `concurrency` in flight at once (bounded so a burst never exceeds the server's connection backlog). */
export class VectorEnv {
  constructor(env, n, { concurrency = 32 } = {}) { this.env = env; this.n = n; this.concurrency = Math.max(1, concurrency); }
  async run(resetOptionsFor, policy, options = {}) {
    const results = new Array(this.n); let next = 0;
    const worker = async () => { while (next < this.n) { const i = next; next += 1; results[i] = await this.env.runEpisode(resetOptionsFor(i), policy, options); } };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, this.n) }, worker));
    return results;
  }
}

/** A stub policy: reads the chart, then finishes. Replace with your own. */
export async function stubPolicy(obs) {
  if (!obs?.result) return { tool: 'read-chart', args: { type: 'Patient', id: String(obs?.briefing?.patient || '').split('/')[1] }, reasoning: 'Look at the patient first' };
  return { tool: 'finish', args: { answer: 'No action taken by the stub policy', summary: 'Stub policy finished' } };
}
