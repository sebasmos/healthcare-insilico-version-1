// Compare two: pairwise preferences between two
// attempts at the same task, with the agents hidden. Pairs are built from a
// study's runs (same task, different agent, version or condition), left and
// right are randomised once and stored, and each judgement is an append-only
// record linked to both runs. A Bradley-Terry ranking with bootstrap intervals
// turns the judgements into a ranking. Benchmarks are frozen task lists with a
// scoring mix and a leaderboard.
import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { pseudonym } from '../../platform/server/pseudonym.mjs';
import { mulberry32 } from '../../ehr/server/wearables.mjs';
import { describeAction } from '../web/agent-ops/describe.js';

export const CHOICES = ['A', 'B', 'same', 'both-unsafe'];
export const SCORING_KINDS = ['chart-checks', 'rubric', 'expert-comparison'];
const seedOf = (text) => parseInt(createHash('sha256').update(String(text)).digest('hex').slice(0, 8), 16);
export const entityOf = (run) => `${run.agentId}@${run.version}${run.condition ? `|${run.condition}` : ''}`;
export const taskKeyOf = (run) => run.caseId || run.scenario?.id || run.subject || null;

/**
 * Bradley-Terry strengths from pairwise outcomes, by the minorise-maximise update,
 * with half a win and half a loss against every opponent as a prior so a side
 * that never wins still gets a finite strength. outcomes: [{ a, b, result: 'a' | 'b' | 'tie' }].
 * Returns strengths normalised to a geometric mean of 1.
 */
export function bradleyTerry(outcomes, { iterations = 300 } = {}) {
  const items = [...new Set(outcomes.flatMap((o) => [o.a, o.b]))].sort();
  if (!items.length) return {};
  const wins = Object.fromEntries(items.map((i) => [i, 0]));
  const games = new Map(); const key = (x, y) => (x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`);
  const add = (x, y, n) => games.set(key(x, y), (games.get(key(x, y)) || 0) + n);
  for (const o of outcomes) { if (o.a === o.b) continue; add(o.a, o.b, 1); if (o.result === 'a') wins[o.a] += 1; else if (o.result === 'b') wins[o.b] += 1; else { wins[o.a] += 0.5; wins[o.b] += 0.5; } }
  for (const [k, n] of [...games]) { const [x, y] = k.split('\u0000'); games.set(k, n + 1); wins[x] += 0.5; wins[y] += 0.5; void n; }
  let p = Object.fromEntries(items.map((i) => [i, 1]));
  for (let it = 0; it < iterations; it += 1) {
    const next = {};
    for (const i of items) {
      let denom = 0;
      for (const j of items) { if (i === j) continue; const n = games.get(key(i, j)) || 0; if (n) denom += n / (p[i] + p[j]); }
      next[i] = denom ? wins[i] / denom : p[i];
    }
    const g = Math.exp(items.reduce((a, i) => a + Math.log(next[i]), 0) / items.length);
    for (const i of items) next[i] /= g;
    p = next;
  }
  return p;
}
/** The ranking with a 90% bootstrap interval on each strength (seeded, so the same judgements give the same intervals). */
export function ranking(outcomes, { resamples = 200, seed = 1 } = {}) {
  const base = bradleyTerry(outcomes);
  const items = Object.keys(base);
  const rng = mulberry32(seed);
  const draws = Object.fromEntries(items.map((i) => [i, []]));
  for (let r = 0; r < resamples && outcomes.length; r += 1) {
    const sample = outcomes.map(() => outcomes[Math.floor(rng() * outcomes.length)]);
    const s = bradleyTerry(sample, { iterations: 120 });
    for (const i of items) draws[i].push(s[i] ?? 1);
  }
  const q = (list, f) => { const sorted = [...list].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))] : null; };
  const tally = (i) => outcomes.reduce((t, o) => { if (o.a !== i && o.b !== i) return t; t.comparisons += 1; const mine = o.a === i ? 'a' : 'b'; if (o.result === 'tie') t.ties += 1; else if (o.result === mine) t.wins += 1; else t.losses += 1; return t; }, { wins: 0, losses: 0, ties: 0, comparisons: 0 });
  return items.map((i) => ({ entity: i, strength: Math.round(base[i] * 1000) / 1000, low: q(draws[i], 0.05) == null ? null : Math.round(q(draws[i], 0.05) * 1000) / 1000, high: q(draws[i], 0.95) == null ? null : Math.round(q(draws[i], 0.95) * 1000) / 1000, ...tally(i) }))
    .sort((a, b) => b.strength - a.strength).map((r, k) => ({ ...r, rank: k + 1 }));
}

export function createPreferences({ store, rl = null }) {
  const human = (ctx) => { if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only people judge pairs'); };
  const studyOf = async (id) => { const st = await store.get('Study', String(id || '')); if (!st) throw new HttpError(404, `Study ${id} not found`); return st; };
  async function studyRuns(st) {
    const links = (await store.query('StudyLink', { where: (l) => l.study === st.id && l.kind === 'run' }));
    const runs = new Map((await store.query('Run')).map((r) => [r.id, r]));
    return links.map((l) => runs.get(l.ref)).filter((r) => r && r.agentId && r.endedAt && r.endReason === 'completed' && taskKeyOf(r) && !r.result?.heldOut); // finished attempts only (status is derived from endReason)
  }
  /** Held-out tasks: the study's task set test part, cases in the evaluation split, held-out red-team tests. */
  async function heldOutKeys(st) {
    const out = new Set();
    if (st.rl?.taskSet) { const set = await store.get('TaskSet', st.rl.taskSet); for (const t of set?.tasks || []) if (t.part === 'test') out.add(t.taskId); }
    for (const c of await store.query('EvalCase')) if (c.split === 'eval') out.add(c.id);
    for (const t of await store.query('RedTeamTest')) if (t.heldOut) out.add(t.id);
    return out;
  }
  async function taskText(run) {
    if (run.caseId) { const c = await store.get('EvalCase', run.caseId); if (c) return { title: c.title, text: c.task || run.goal || '' }; }
    if (run.scenario) return { title: run.scenario.title, text: run.goal || '' };
    return { title: run.goal || 'Task', text: run.goal || '' };
  }
  /** What one attempt did, with nothing that names the agent, its version or its condition. */
  async function answerOf(runId, agents) {
    const run = await store.get('Run', runId);
    const steps = (await store.query('TraceStep', { groupKey: runId })).filter((s) => s.who.kind === 'agent' && !String(s.did.type).startsWith('turn.'));
    const names = agents.flatMap((a) => [a.name, a.id, a.version ? `v${a.version}` : null, a.version]).filter((x) => x && String(x).length > 1).sort((x, y) => String(y).length - String(x).length);
    const hide = (text) => names.reduce((t, n) => t.split(String(n)).join('the agent'), String(text ?? ''));
    const actions = steps.slice(0, 60).map((s) => hide(describeAction(s.did.type, s.did.args)));
    const output = hide(run?.result?.summary || run?.result?.output?.map?.((o) => o.text || o.summary || '').filter(Boolean).join('\n') || '');
    return { actions, output: output.slice(0, 4000), steps: steps.length };
  }
  async function pairsOf(studyId) { return (await store.query('PreferencePair', { where: (p) => p.study === studyId })).sort((a, b) => a.index - b.index); }
  const judgementsOf = async (studyId) => (await store.query('Preference', { where: (p) => p.study === studyId })).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  /** Builds pairs up to the set number: attempts at the same task from different agents, versions or conditions. */
  async function ensurePairs(st, ctx) {
    const target = Math.max(1, Math.min(500, Number(st.rl?.pairs) || 20));
    const judgesPerPair = Math.max(1, Math.min(9, Number(st.rl?.judgesPerPair) || 1));
    const have = await pairsOf(st.id);
    if (have.length >= target) return have;
    const seen = new Set(have.map((p) => [p.left, p.right].sort().join('|')));
    const byTask = new Map();
    for (const r of await studyRuns(st)) { const k = taskKeyOf(r); if (!byTask.has(k)) byTask.set(k, []); byTask.get(k).push(r); }
    const rng = mulberry32(seedOf(`${st.id}:${have.length}`));
    const candidates = [];
    for (const [task, runs] of byTask) for (let i = 0; i < runs.length; i += 1) for (let j = i + 1; j < runs.length; j += 1) if (entityOf(runs[i]) !== entityOf(runs[j]) && !seen.has([runs[i].id, runs[j].id].sort().join('|'))) candidates.push({ task, x: runs[i], y: runs[j] });
    for (let i = candidates.length - 1; i > 0; i -= 1) { const j = Math.floor(rng() * (i + 1)); [candidates[i], candidates[j]] = [candidates[j], candidates[i]]; }
    const chosen = candidates.slice(0, target - have.length);
    if (!chosen.length) return have;
    // Task texts and sides are settled before the transaction: never read through the store inside one.
    const texts = []; for (const c of chosen) texts.push(await taskText(c.x));
    const flips = chosen.map(() => rng() < 0.5);
    await store.transaction(async (tx) => {
      let index = have.length;
      for (const [k, c] of chosen.entries()) {
        const flip = flips[k]; const t = texts[k];
        await tx.save('PreferencePair', { resourceType: 'PreferencePair', id: randomUUID(), study: st.id, index: (index += 1), task: c.task, taskTitle: t.title, taskText: t.text, left: flip ? c.y.id : c.x.id, right: flip ? c.x.id : c.y.id, judgesPerPair, createdAt: tx.now() }, { updatedBy: ctx.actor.role });
      }
      await recordAction(tx, { actor: ctx.actor, kind: 'create', action: 'preference.pairs', args: { study: st.id, added: chosen.length }, entityRef: `Study/${st.id}`, description: `${chosen.length} pair(s) built for comparison` });
    });
    return pairsOf(st.id);
  }
  /** The next pair for this judge: never the agent's name, version or condition; A is the stored left, B the stored right. */
  async function next(studyId, ctx) {
    human(ctx);
    const st = await studyOf(studyId);
    const pairs = await ensurePairs(st, ctx);
    const judge = pseudonym(ctx.actor.id);
    const all = await judgementsOf(st.id);
    const mine = new Set(all.filter((j) => j.judge === judge).map((j) => j.pair));
    const open = pairs.filter((p) => !mine.has(p.id) && all.filter((j) => j.pair === p.id).length < p.judgesPerPair);
    const done = pairs.filter((p) => mine.has(p.id)).length;
    if (!open.length) return { pair: null, index: done, total: pairs.length, judge, message: pairs.length ? 'No pair is waiting for you.' : 'No pairs yet: this study needs attempts at the same task from different agents, versions or conditions.' };
    const p = open[0];
    const agents = await store.query('Agent');
    const [a, b] = await Promise.all([answerOf(p.left, agents), answerOf(p.right, agents)]);
    return { pair: { id: p.id, task: { title: p.taskTitle, text: p.taskText }, A: a, B: b }, index: done + 1, total: pairs.length, judge };
  }
  /** One judgement, append-only: a judge answers each pair once; it is never changed or deleted. */
  async function judge(studyId, body, ctx) {
    human(ctx);
    const st = await studyOf(studyId);
    const p = await store.get('PreferencePair', String(body?.pair || ''));
    if (!p || p.study !== st.id) throw new HttpError(404, 'That pair is not in this study');
    if (!CHOICES.includes(body?.choice)) throw new HttpError(422, `choice must be one of ${CHOICES.join(', ')}`);
    const judgeId = pseudonym(ctx.actor.id);
    return store.transaction(async (tx) => {
      const prior = await tx.query('Preference', { where: (j) => j.pair === p.id });
      if (prior.some((j) => j.judge === judgeId)) throw new HttpError(409, 'You have already judged this pair. Judgements are never changed');
      if (prior.length >= p.judgesPerPair) throw new HttpError(409, 'This pair has all its judgements');
      const doc = await tx.save('Preference', { resourceType: 'Preference', id: randomUUID(), study: st.id, pair: p.id, task: p.task, runA: p.left, runB: p.right, left: p.left, right: p.right, judge: judgeId, choice: body.choice, reason: String(body?.reason || '').slice(0, 1000), seconds: Number.isFinite(Number(body?.seconds)) ? Math.max(0, Math.round(Number(body.seconds))) : null, at: tx.now() }, { updatedBy: ctx.actor.role });
      await recordAction(tx, { actor: ctx.actor, kind: 'create', action: 'preference.judge', args: { study: st.id, pair: p.id, choice: body.choice }, resources: [{ ref: `Run/${p.left}` }, { ref: `Run/${p.right}` }], entityRef: `Study/${st.id}`, description: `pair judged: ${body.choice}` });
      return doc;
    });
  }
  /** The study's ranking from its judgements; "both unsafe" counts separately and does not rank. */
  async function results(studyId) {
    const st = await studyOf(studyId);
    const list = await judgementsOf(st.id);
    const runs = new Map((await store.query('Run')).map((r) => [r.id, r]));
    const outcomes = []; let bothUnsafe = 0;
    for (const j of list) {
      const a = runs.get(j.runA); const b = runs.get(j.runB); if (!a || !b) continue;
      if (j.choice === 'both-unsafe') { bothUnsafe += 1; continue; }
      outcomes.push({ a: entityOf(a), b: entityOf(b), result: j.choice === 'A' ? 'a' : j.choice === 'B' ? 'b' : 'tie' });
    }
    return { study: st.id, judgements: list.length, bothUnsafe, judges: new Set(list.map((j) => j.judge)).size, ranking: ranking(outcomes, { seed: seedOf(st.id) }), method: 'Bradley-Terry with a 90% bootstrap interval (200 resamples); a tie counts half to each side.' };
  }
  /** Rows for the "Expert preference pairs" dataset: the task, both runs' content, the choice, reason and judge; held-out tasks never. */
  async function exportRows(studyId) {
    const st = await studyOf(studyId);
    const held = await heldOutKeys(st);
    const agents = await store.query('Agent');
    const rows = []; let heldOut = 0;
    for (const j of await judgementsOf(st.id)) {
      if (held.has(j.task)) { heldOut += 1; continue; }
      const p = await store.get('PreferencePair', j.pair);
      const [a, b] = await Promise.all([answerOf(j.runA, agents), answerOf(j.runB, agents)]);
      rows.push({ pair: j.pair, task: p?.taskTitle || j.task, taskText: p?.taskText || '', runA: j.runA, runB: j.runB, answerA: [...a.actions, a.output].filter(Boolean).join('\n'), answerB: [...b.actions, b.output].filter(Boolean).join('\n'), choice: j.choice, reason: j.reason, judge: j.judge, at: j.at });
    }
    return { rows, heldOut };
  }

  // ---------- Benchmarks (Library → "+ New benchmark") ----------
  async function makeBenchmark(body, ctx) {
    human(ctx);
    const name = String(body?.name || '').trim(); if (name.length < 3) throw new HttpError(422, 'A benchmark needs a name');
    const tasks = (Array.isArray(body?.tasks) ? body.tasks : []).map((t) => ({ taskId: String(t?.taskId || t), heldOut: Boolean(t?.heldOut) })).filter((t) => t.taskId);
    if (!tasks.length) throw new HttpError(422, 'Pick at least one task');
    for (const t of tasks) if (!(await store.get('EvalCase', t.taskId))) throw new HttpError(404, `Task ${t.taskId} is not in the case bank`);
    const scoring = (Array.isArray(body?.scoring) ? body.scoring : []).filter((s) => SCORING_KINDS.includes(s));
    if (!scoring.length) throw new HttpError(422, `Choose scoring: ${SCORING_KINDS.join(', ')} or a mix`);
    const frozen = { name, tasks, scoring };
    return store.transaction(async (tx) => {
      const doc = await tx.save('Benchmark', { resourceType: 'Benchmark', id: randomUUID(), ...frozen, status: 'frozen', version: 1, sha256: createHash('sha256').update(JSON.stringify(frozen)).digest('hex'), createdAt: tx.now(), createdBy: pseudonym(ctx.actor.id) }, { updatedBy: ctx.actor.role });
      await recordAction(tx, { actor: ctx.actor, kind: 'create', action: 'benchmark.freeze', args: { benchmark: doc.id, tasks: tasks.length, heldOut: tasks.filter((t) => t.heldOut).length, scoring }, entityRef: `Benchmark/${doc.id}`, description: `benchmark frozen: ${name}` });
      return doc;
    });
  }
  const presentBenchmark = (b) => ({ id: b.id, name: b.name, scoring: b.scoring, version: b.version, sha256: b.sha256, createdAt: b.createdAt, tasks: b.tasks.length, heldOut: b.tasks.filter((t) => t.heldOut).length, shown: b.tasks.filter((t) => !t.heldOut).map((t) => t.taskId) });
  async function runBenchmark(id, body, ctx) {
    human(ctx);
    if (!rl) throw new HttpError(503, 'Running agents is not available here');
    const b = await store.get('Benchmark', id); if (!b) throw new HttpError(404, `Benchmark ${id} not found`);
    const agentId = String(body?.agentId || '');
    const per = [];
    for (const t of b.tasks) {
      const out = await rl.rollouts({ agentId, caseId: t.taskId, attempts: 1, seed: 1 }, ctx.actor);
      const ep = out.episodes[0]; const checks = ep?.outcome?.raw?.checks || []; const judge = ep?.outcome?.judge;
      per.push({ taskId: t.taskId, heldOut: t.heldOut, runId: ep?.runId ?? null, checks: checks.length ? checks.filter((c) => c.pass).length / checks.length : null, rubric: typeof judge?.score === 'number' ? judge.score : null, passed: checks.length > 0 && checks.every((c) => c.pass) });
    }
    const mean = (xs) => { const v = xs.filter((x) => typeof x === 'number'); return v.length ? Math.round((v.reduce((a, x) => a + x, 0) / v.length) * 1000) / 1000 : null; };
    const parts = { 'chart-checks': mean(per.map((p) => p.checks)), rubric: b.scoring.includes('rubric') ? mean(per.map((p) => p.rubric)) : null, 'expert-comparison': null };
    const used = b.scoring.map((s) => parts[s]).filter((x) => typeof x === 'number');
    const agent = await store.get('Agent', agentId);
    return store.transaction(async (tx) => {
      const doc = await tx.save('BenchmarkRun', { resourceType: 'BenchmarkRun', id: randomUUID(), benchmark: b.id, benchmarkSha: b.sha256, agentId, version: agent?.version ?? null, at: tx.now(), parts, score: used.length ? Math.round((used.reduce((a, x) => a + x, 0) / used.length) * 1000) / 1000 : null, passed: per.filter((p) => p.passed).length, tasks: per.length, perTask: per }, { updatedBy: ctx.actor.role });
      await recordAction(tx, { actor: ctx.actor, kind: 'execute', action: 'benchmark.run', args: { benchmark: b.id, agentId, version: doc.version }, entityRef: `Benchmark/${b.id}`, description: `benchmark run: ${b.name} with ${agentId}` });
      return { ...doc, perTask: doc.perTask.map((p) => (p.heldOut ? { taskId: 'held-out', heldOut: true, passed: p.passed } : p)) };
    });
  }
  async function leaderboard(id) {
    const b = await store.get('Benchmark', id); if (!b) throw new HttpError(404, `Benchmark ${id} not found`);
    const runs = (await store.query('BenchmarkRun', { where: (r) => r.benchmark === id })).sort((x, y) => String(y.at).localeCompare(String(x.at)));
    const best = new Map();
    for (const r of runs) { const k = `${r.agentId}@${r.version}`; if (!best.has(k) || (r.score ?? -1) > (best.get(k).score ?? -1)) best.set(k, r); }
    return { benchmark: presentBenchmark(b), rows: [...best.values()].sort((x, y) => (y.score ?? -1) - (x.score ?? -1)).map((r, i) => ({ rank: i + 1, agentId: r.agentId, version: r.version, score: r.score, parts: r.parts, passed: r.passed, tasks: r.tasks, at: r.at })) };
  }

  async function handle(req, url, body, ctx, parts) {
    const [area, id, op] = parts; const m = req.method;
    if (area === 'preferences' && id) {
      if (op === 'next' && m === 'GET') return { status: 200, body: await next(id, ctx) };
      if (op === 'judgements' && m === 'POST') return { status: 201, body: await judge(id, body, ctx) };
      if (op === 'results' && m === 'GET') return { status: 200, body: await results(id) };
      if (op === 'pairs' && m === 'GET') { human(ctx); const st = await studyOf(id); const list = await ensurePairs(st, ctx); return { status: 200, body: { pairs: list.map((p) => ({ id: p.id, index: p.index, task: p.taskTitle, judgesPerPair: p.judgesPerPair })) } }; }
      throw new HttpError(m === 'GET' || m === 'POST' ? 404 : 405, 'Judgements can be added but never changed or deleted');
    }
    if (area === 'benchmarks') {
      if (!id && m === 'GET') return { status: 200, body: { benchmarks: (await store.query('Benchmark')).sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt))).map(presentBenchmark), scoring: SCORING_KINDS } };
      if (!id && m === 'POST') return { status: 201, body: presentBenchmark(await makeBenchmark(body, ctx)) };
      if (id && op === 'run' && m === 'POST') return { status: 201, body: await runBenchmark(id, body, ctx) };
      if (id && op === 'leaderboard' && m === 'GET') return { status: 200, body: await leaderboard(id) };
      if (id && !op && (m === 'PUT' || m === 'DELETE')) throw new HttpError(409, 'A benchmark is frozen once made');
    }
    return null;
  }
  return { handle, next, judge, results, exportRows, ensurePairs, makeBenchmark, runBenchmark, leaderboard };
}
