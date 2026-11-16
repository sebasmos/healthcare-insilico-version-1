// Regression replay and the benchmark leaderboard (§9k).
//
// Regression replay reruns an agent's current version on every case in the
// case bank and on the items an earlier version shadowed, then lines the two
// versions up: same, improved, regressed. Replays are episodes of kind
// "regression"; like ablation runs they never enter a training export.
//
// The leaderboard puts every agent version side by side on the frozen
// evaluation split: verifier checks, human grades, scribe scores and red-team
// results. Each column is a proxy; none of them establishes clinical safety.
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { createRun, endRun, withStatus } from './runs.mjs';
import { verifierScore, GRADE_VALUE } from './grader.mjs';

const round = (v, d = 3) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const mean = (list) => { const v = list.filter((x) => x != null); return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null; };

/** Check-by-check difference between two attempts at the same case. */
export function diffChecks(before = [], after = []) {
  const ids = [...new Set([...before.map((c) => c.id), ...after.map((c) => c.id)])];
  return ids.map((id) => {
    const b = before.find((c) => c.id === id); const a = after.find((c) => c.id === id);
    const change = !b ? 'new-check' : !a ? 'removed-check' : b.pass === a.pass ? 'same' : a.pass ? 'fixed' : 'broke';
    return { id, label: (a ?? b).label, forbidden: Boolean((a ?? b).forbidden), before: b ? b.pass : null, after: a ? a.pass : null, change };
  });
}

/** How a result moved between versions. Scores compare numerically, labels by equality. */
export function classify(before, after) {
  if (!before) return 'new';
  if (before.kind === 'score') {
    if (before.value == null || after.value == null) return before.value === after.value ? 'same' : 'changed';
    return Math.abs(after.value - before.value) < 1e-9 ? 'same' : after.value > before.value ? 'improved' : 'regressed';
  }
  return before.value === after.value ? 'same' : 'changed';
}

const compareVersions = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

export function createRegression({ store, agents, rl }) {
  const human = (ctx) => { if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only people can start a regression replay'); };
  const scoreOf = (e) => ({ kind: 'score', value: verifierScore(e.outcome.raw?.checks ?? []).score, text: null, checks: e.outcome.raw?.checks ?? [], runId: e.runId, seed: e.state?.seed ?? null });
  const labelOf = (run) => ({ kind: 'label', value: run.result?.declined ? 'declined' : run.result?.label ?? null, text: run.result?.summary ?? run.result?.error ?? null, runId: run.id });
  const say = (x) => (x == null ? null : x.kind === 'score' ? (x.value == null ? 'not scored' : `${Math.round(x.value * 100)}% of checks`) : (x.value ?? 'no answer'));

  async function evidence(agentId) {
    const episodes = (await store.query('Episode', { where: (e) => e.agentId === agentId && e.caseId && ['rollout', 'regression'].includes(e.kind) })).sort((a, b) => a._seq - b._seq);
    const shadows = (await store.query('Run', { where: (r) => r.agentId === agentId && r.endedAt && !r.caseId && r.subject && (r.mode?.startsWith('shadow') || r.trigger?.kind === 'regression') && !(r.overlays || []).length })).sort((a, b) => a._seq - b._seq);
    return { episodes, shadows };
  }

  /** The earlier version to compare with: the one asked for, or the latest other version that left evidence. */
  function previousVersion(current, { episodes, shadows }, asked) {
    const seen = new Map();
    for (const e of episodes) seen.set(e.version, Math.max(seen.get(e.version) ?? 0, e._seq));
    for (const r of shadows) seen.set(r.version, Math.max(seen.get(r.version) ?? 0, r._seq));
    seen.delete(current);
    if (asked) { if (!seen.has(asked)) throw new HttpError(422, `Version ${asked} has no earlier results to compare with`); return asked; }
    return [...seen.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }

  async function replay({ agentId, against = null }, actor) {
    if (!agents.ready) throw new HttpError(409, 'The server is not ready to run agents yet');
    const agent = await store.get('Agent', String(agentId ?? ''));
    if (!agent) throw new HttpError(404, `Agent "${agentId}" is not registered`);
    if (!agents.canRun(agent)) throw new HttpError(409, 'External agent endpoints are disabled. Set ALLOW_EXTERNAL_AGENTS=true to let this server call them');
    const before = await evidence(agent.id);
    const previous = previousVersion(agent.version, before, against);
    const suite = await createRun(store, { mode: 'regression', agentId: agent.id, goal: `Regression replay of ${agent.name} v${agent.version}${previous ? ` against v${previous}` : ''}`, trigger: { kind: 'regression-suite', actor: actor.id, role: actor.role, at: store.now() } }, actor);
    const tag = { suite: suite.id };
    const rows = [];

    // Cases: only those this kind of agent has attempted before, or all of them for an agent with no history that can do case work.
    const cases = (await store.query('EvalCase')).sort((a, b) => a.title.localeCompare(b.title));
    const attempted = new Set(before.episodes.map((e) => e.caseId));
    const mine = cases.filter((c) => attempted.has(c.id) || (!attempted.size && agent.capability === 'clinical-workup'));
    for (const c of mine) {
      const prior = before.episodes.filter((e) => e.caseId === c.id && e.version === previous);
      const base = prior.find((e) => e.state?.seed === 0) ?? prior.at(-1) ?? null;
      const out = await rl.rollouts({ agentId: agent.id, caseId: c.id, attempts: 1, seed: 0, regression: tag }, actor);
      const now = await store.get('Episode', out.episodes[0].id);
      const b = base ? scoreOf(base) : null; const a = scoreOf(now);
      rows.push({ kind: 'case', target: `EvalCase/${c.id}`, title: c.title, split: c.split, before: b ? { text: say(b), value: b.value, runId: b.runId, seed: b.seed } : null, after: { text: say(a), value: a.value, runId: a.runId, seed: 0 }, change: classify(b, a), checks: diffChecks(b?.checks, a.checks) });
    }

    // Shadow cases: every item the earlier version worked on, redone by this version on a practice copy.
    const subjects = new Map();
    for (const r of before.shadows.filter((x) => x.version === previous)) subjects.set(r.subject, r);
    for (const [subject, prior] of subjects) {
      const [type, id] = subject.split('/');
      if (!(await store.get(type, id).catch(() => null))) continue;
      const run = await createRun(store, { mode: 'sandbox', agentId: agent.id, subject, goal: prior.goal || 'Do the usual task for this item', trigger: { kind: 'regression', actor: actor.id, role: actor.role, at: store.now(), ...tag } }, actor);
      const outcome = await agents.work(run, agent);
      const ended = await endRun(store, run.id, agents.agentActor(agent), outcome.ok ? 'completed' : outcome.reason, outcome.result ?? { error: outcome.error });
      const b = labelOf(prior); const a = labelOf(ended);
      rows.push({ kind: 'shadow', target: subject, title: subject, split: null, before: { text: say(b), value: b.value, runId: b.runId }, after: { text: say(a), value: a.value, runId: a.runId }, change: classify(b, a), checks: [] });
    }

    const count = (c) => rows.filter((r) => r.change === c).length;
    const report = {
      kind: 'regression', agentId: agent.id, name: agent.name, version: agent.version, previous, rows,
      summary: { targets: rows.length, cases: rows.filter((r) => r.kind === 'case').length, shadowCases: rows.filter((r) => r.kind === 'shadow').length, same: count('same'), improved: count('improved'), regressed: count('regressed'), changed: count('changed'), new: count('new'),
        checksBroken: rows.reduce((n, r) => n + r.checks.filter((c) => c.change === 'broke').length, 0), checksFixed: rows.reduce((n, r) => n + r.checks.filter((c) => c.change === 'fixed').length, 0) },
      note: previous ? '"Improved" and "regressed" compare verifier scores with the earlier version. "Changed" means a different answer on a shadowed item; whether it is better needs a person to look.' : 'No earlier version has results, so there is nothing to compare with yet. These results become the baseline for the next version.',
    };
    const ended = await endRun(store, suite.id, actor, 'completed', report);
    await store.transaction((tx) => recordAction(tx, { runId: suite.id, actor, kind: 'execute', action: 'regression.run', args: { agent: agent.id, version: agent.version, previous, targets: rows.length, regressed: report.summary.regressed }, entityRef: `Run/${suite.id}`, description: `regression replay: ${agent.id} ${agent.version} vs ${previous ?? 'nothing'} (${rows.length} targets)` }));
    return { runId: ended.id, startedAt: ended.startedAt, endedAt: ended.endedAt, ...report };
  }

  async function reports({ agentId = null } = {}) {
    const runs = (await store.query('Run', { where: (r) => r.mode === 'regression' && r.endedAt && r.result?.kind === 'regression' && (!agentId || r.agentId === agentId) })).sort((a, b) => b._seq - a._seq);
    const registry = (await store.query('Agent')).sort((a, b) => a.name.localeCompare(b.name));
    const options = [];
    for (const a of registry) { const ev = await evidence(a.id); const versions = [...new Set([...ev.episodes.map((e) => e.version), ...ev.shadows.map((r) => r.version)])].filter((v) => v !== a.version).sort(compareVersions).reverse(); options.push({ agentId: a.id, name: a.name, version: a.version, earlier: versions, hasHistory: ev.episodes.length + ev.shadows.length > 0, canDoCases: a.capability === 'clinical-workup' }); }
    return { reports: runs.map((r) => ({ runId: r.id, startedAt: r.startedAt, endedAt: r.endedAt, status: withStatus(r).status, ...r.result })), agents: options };
  }

  async function handle(req, url, body, ctx, parts) {
    if (parts[0] !== 'regression') return null;
    if (parts.length === 1 && req.method === 'GET') return { status: 200, body: await reports({ agentId: url.searchParams.get('agentId') }) };
    if (parts.length === 2 && parts[1] === 'run' && req.method === 'POST') { human(ctx); return { status: 201, body: await replay(body || {}, ctx.actor) }; }
    return null;
  }
  return { handle, replay, reports };
}

export function createLeaderboard({ store, rl, scribe }) {
  async function board() {
    const episodes = await rl.episodes.list();
    const registry = new Map((await store.query('Agent')).map((a) => [a.id, a]));
    const suites = (await store.query('Run', { where: (r) => r.mode === 'redteam' && r.result?.kind === 'suite' && r.result.complete })).sort((a, b) => b._seq - a._seq);
    const testSuites = (await store.query('Run', { where: (x) => x.mode === 'redteam' && x.result?.kind === 'test-suite' })).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    const scribeSummary = (await scribe.results()).summary;
    const keys = new Map();
    const touch = (agentId, version) => { const k = `${agentId}@${version}`; if (!keys.has(k)) keys.set(k, { agentId, version }); return k; };
    for (const e of episodes) touch(e.agentId, e.version);
    for (const s of suites) touch(s.agentId, s.version);
    for (const s of scribeSummary) touch(s.agentId, s.version);
    for (const a of registry.values()) touch(a.id, a.version);
    const rows = [...keys.values()].map(({ agentId, version }) => {
      const mine = episodes.filter((e) => e.agentId === agentId && e.version === version);
      // The frozen evaluation split: the latest attempt at each evaluation case (training attempts and ablations do not count).
      const latest = new Map();
      for (const e of mine.filter((x) => x.split === 'eval' && ['rollout', 'regression'].includes(x.kind)).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))) latest.set(e.caseId, e);
      const evals = [...latest.values()];
      const checks = evals.flatMap((e) => (e.outcome.raw?.checks ?? []).filter((c) => !c.forbidden));
      const forbidden = evals.flatMap((e) => (e.outcome.raw?.checks ?? []).filter((c) => c.forbidden));
      const grades = {};
      const values = [];
      for (const e of mine) { const g = e.outcome.humanGrade; if (!g) continue; for (const code of g.final ? [g.final] : g.grades) grades[code] = (grades[code] || 0) + 1; values.push(g.value); }
      const red = suites.find((s) => s.agentId === agentId && s.version === version) ?? null;
      const ts = testSuites.find((s) => s.agentId === agentId && s.version === version) ?? null;
      const sc = scribeSummary.find((s) => s.agentId === agentId && s.version === version) ?? null;
      const agent = registry.get(agentId);
      return {
        agentId, name: agent?.name ?? agentId, version, current: agent?.version === version, stage: agent?.version === version ? (agent.stage ?? 'shadow') : 'superseded',
        verifier: { evalCases: evals.length, score: mean(evals.map((e) => verifierScore(e.outcome.raw?.checks ?? []).score)), checksPassed: checks.filter((c) => c.pass).length, checks: checks.length, passRate: checks.length ? round(checks.filter((c) => c.pass).length / checks.length) : null, avoidViolations: forbidden.filter((c) => !c.pass).length },
        grades: { graded: values.length, distribution: grades, mean: mean(values), unsafe: grades.unsafe || 0 },
        scribe: sc && sc.evalSplit.cases ? { cases: sc.evalSplit.cases, completeness: sc.evalSplit.completeness, accuracy: sc.evalSplit.accuracy, hallucinationRate: sc.evalSplit.hallucinationRate, format: sc.evalSplit.format } : null,
        redTeam: red ? { passed: red.result.total - red.result.failed, total: red.result.total, score: round((red.result.total - red.result.failed) / Math.max(red.result.total, 1)), at: red.endedAt } : null,
        // Scenario-based red-team tests (task 14): held-out tests count here and nowhere else in detail.
        redTeamTests: ts ? { tests: ts.result.tests, failed: ts.result.failed, attackSuccessRate: ts.result.attackSuccessRate, heldOutTests: ts.result.results.filter((x) => x.heldOut).length, condition: ts.result.condition, at: ts.endedAt } : null,
      };
    });
    // Ranked by the evaluation-split verifier score, then scribe accuracy, then red-team score. A version with an unsafe grade or a failed safety scenario is marked, whatever its rank.
    const key = (r) => [r.verifier.score ?? -Infinity, r.scribe?.accuracy ?? -Infinity, r.redTeam?.score ?? -Infinity];
    rows.sort((a, b) => { const x = key(a); const y = key(b); for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return y[i] - x[i]; return a.name.localeCompare(b.name) || compareVersions(b.version, a.version); });
    rows.forEach((r, i) => { r.rank = i + 1; r.safetyConcern = r.grades.unsafe > 0 || (r.redTeam ? r.redTeam.passed < r.redTeam.total : false) || r.verifier.avoidViolations > 0; r.measured = r.verifier.evalCases > 0 || Boolean(r.scribe) || Boolean(r.redTeam) || r.grades.graded > 0; });
    const evalCases = (await store.query('EvalCase', { where: (c) => c.split === 'eval' })).length;
    const scribeEval = (await store.query('ScribeBenchmarkCase', { where: (c) => c.split === 'eval' })).length;
    return { generatedAt: store.now(), evalCases, scribeEvalCases: scribeEval, rows, note: 'Ranked by verifier score on the frozen evaluation split, then scribe accuracy, then red-team score. Different agents do different jobs, so compare versions of the same agent first. Every column is a proxy; none establishes clinical safety.' };
  }
  async function handle(req, url, body, ctx, parts) {
    if (parts[0] !== 'leaderboard' || parts.length !== 1 || req.method !== 'GET') return null;
    return { status: 200, body: await board() };
  }
  return { handle, board };
}
