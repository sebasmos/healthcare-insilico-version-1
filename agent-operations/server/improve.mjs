// The improvement loop of a Reinforcement Learning study:
// 1. Baseline: the current agent version on the study's held-out tasks and the
//    ready-made safety suite. 2. Train: done when a trainer connected through
//    the environment API registers a new agent version for the study. 3. Evaluate
//    again: starts on its own when a version is registered, on the same held-out
//    tasks and suite. 4. Promote: only if more tasks pass and there are no new
//    safety failures; otherwise it says why. Every step is an append-only
//    LoopEvent; nothing is promoted without a person.
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { GRADES, allGrades, settle } from './grades.mjs';
import { SAFETY_SUITE_ID } from './red-team/tests.mjs';
import { modeOf } from './research.mjs';

export const LOOP_STEPS = [['baseline', 'Baseline', 'Score on held-out tasks'], ['train', 'Train', 'Trainer connected, episodes run'], ['evaluate', 'Evaluate again', 'Same held-out tasks and safety tests'], ['promote', 'Promote', 'Only if better and no new safety failures']];
export const SCORING = ['automatic', 'expert', 'both'];
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
const pct = (v) => (v == null ? 'none' : `${Math.round(v * 100)}%`);

/** Failing safety tests as counts per key; a held-out test counts under its family only. */
export function failureCounts(results = []) {
  const out = {};
  for (const o of results) if (o.failed > 0) { const k = o.heldOut ? `held-out:${o.family}` : o.test; out[k] = (out[k] || 0) + 1; }
  return out;
}
/** May the new version be promoted over the baseline? More tasks passed and no safety test failing that did not fail before. */
export function compareVersions(base, next) {
  if (!base || !next) return { allowed: false, improved: false, newSafetyFailures: [], reason: 'Run the baseline and evaluate a new version first.' };
  const improved = next.passRate != null && base.passRate != null && next.passRate > base.passRate;
  const before = base.failureCounts || {}; const after = next.failureCounts || {};
  const newSafetyFailures = Object.keys(after).filter((k) => after[k] > (before[k] || 0)).sort();
  if (!improved) return { allowed: false, improved, newSafetyFailures, reason: `Tasks passed did not improve: ${pct(base.passRate)} before, ${pct(next.passRate)} after.` };
  if (next.suiteError) return { allowed: false, improved, newSafetyFailures, reason: `The safety suite did not run for ${next.version}: ${next.suiteError}` };
  if (newSafetyFailures.length) return { allowed: false, improved, newSafetyFailures, reason: `New safety failures: ${newSafetyFailures.map((k) => (k.startsWith('held-out:') ? `a held-out test (${k.slice(9)})` : k)).join(', ')}.` };
  return { allowed: true, improved, newSafetyFailures, reason: `Tasks passed went from ${pct(base.passRate)} to ${pct(next.passRate)} with no new safety failures.` };
}
const RANK = Object.fromEntries(GRADES.map((g, i) => [g.id, i]));
function meanGrade(finals) {
  const known = finals.filter((g) => RANK[g] != null);
  if (!known.length) return null;
  return GRADES[Math.round(known.reduce((a, g) => a + RANK[g], 0) / known.length)].id;
}

export function createImprovementLoop({ store, rl, redTeamTests }) {
  const pending = new Map(); // study id -> { kind, version, promise }
  // Automatic steps are logged as started by the loop on behalf of the researchers (the log takes only people and agents).
  const system = { kind: 'human', id: 'improvement-loop', role: 'researcher' };
  const events = async (study) => (await store.query('LoopEvent', { where: (e) => e.study === study })).sort((a, b) => String(a.at).localeCompare(String(b.at)) || (a._seq ?? 0) - (b._seq ?? 0));
  async function rlStudy(id) {
    const st = await store.get('Study', String(id || ''));
    if (!st) throw new HttpError(404, `Study ${id} not found`);
    if (modeOf(st) !== 'rl') throw new HttpError(422, 'The improvement loop belongs to Reinforcement Learning studies');
    return st;
  }
  async function heldOutTasks(st) {
    const setId = st.rl?.taskSet;
    if (!setId) throw new HttpError(422, 'Choose a task set in Setup first');
    const set = await store.get('TaskSet', setId);
    if (!set) throw new HttpError(404, `Task set ${setId} not found`);
    const ids = set.tasks.filter((t) => t.part === 'test').map((t) => t.taskId);
    if (!ids.length) throw new HttpError(422, `Task set "${set.name}" has no held-out test part`);
    return ids;
  }
  async function save(doc) {
    return store.transaction(async (tx) => {
      const saved = await tx.save('LoopEvent', { resourceType: 'LoopEvent', id: randomUUID(), at: tx.now(), ...doc }, { updatedBy: doc.by?.role || 'system' });
      await recordAction(tx, { actor: doc.by || system, kind: 'create', action: `loop.${doc.kind}`, args: { study: doc.study, agentId: doc.agentId, version: doc.version }, entityRef: `Study/${doc.study}`, description: `improvement loop: ${doc.kind} ${doc.agentId || ''} ${doc.version || ''}`.trim() });
      return saved;
    });
  }
  /** One measurement: the held-out tasks (one attempt each) and the ready-made safety suite, for one agent version. */
  async function measure(st, agentId, version, actor) {
    const tasks = await heldOutTasks(st);
    const who = { ...actor, study: st.id };
    const perTask = [];
    for (const caseId of tasks) {
      const out = await rl.rollouts({ agentId, caseId, attempts: 1, seed: 1, version, condition: st.rl?.condition || null }, who);
      const ep = out.episodes[0];
      const checks = ep?.outcome?.raw?.checks || [];
      perTask.push({ caseId, title: out.title, runId: ep?.runId ?? null, episodeId: ep?.id ?? null, passed: checks.length > 0 && checks.every((c) => c.pass) && !(ep.outcome.raw.safetyViolations || []).length, steps: (ep?.trajectory || []).length, failedChecks: checks.filter((c) => !c.pass).map((c) => ({ id: c.id, label: c.label || c.id })) });
    }
    let suite = null; let suiteError = null;
    try { suite = await redTeamTests.runSuite({ agentId, suite: SAFETY_SUITE_ID, limit: 1, version }, who); } catch (err) { suiteError = err.message; }
    const grades = await allGrades(store);
    const finals = perTask.map((t) => settle(grades.filter((g) => g.runId === t.runId))?.final).filter(Boolean);
    const passed = perTask.filter((t) => t.passed).length;
    return { tasks: perTask.length, passed, passRate: perTask.length ? Math.round((passed / perTask.length) * 1000) / 1000 : null, safetyFailures: suite ? suite.results.filter((o) => o.failed > 0).length : null, failureCounts: failureCounts(suite?.results), suiteRunId: suite?.runId ?? null, suiteVersion: suite?.suite?.version ?? null, suiteError, expertGrade: meanGrade(finals), stepsPerTask: perTask.length ? Math.round((perTask.reduce((a, t) => a + t.steps, 0) / perTask.length) * 10) / 10 : null, perTask };
  }
  function start(st, kind, agentId, version, actor) {
    if (pending.has(st.id)) throw new HttpError(409, `The ${pending.get(st.id).kind} for this study is still running`);
    const promise = (async () => {
      try { return await save({ study: st.id, kind, agentId, version, by: actor, ...(await measure(st, agentId, version, actor)) }); } catch (err) { return save({ study: st.id, kind, agentId, version, by: actor, error: err.message }); } finally { pending.delete(st.id); }
    })();
    pending.set(st.id, { kind, version, promise });
    return promise;
  }
  /** 1. Baseline: the agent's current version. Waits for the measurement. */
  async function baseline(studyId, ctx) {
    const st = await rlStudy(studyId);
    const agent = await store.get('Agent', st.rl?.agentId || '');
    if (!agent) throw new HttpError(422, 'Choose an agent in Setup first');
    await heldOutTasks(st);
    return start(st, 'baseline', agent.id, agent.version, ctx.actor);
  }
  /** 2. Train: a trainer registers a new version (environment API key). 3. Evaluate again starts on its own. */
  async function registerVersion(body, key) {
    const st = await rlStudy(body?.study);
    const agentId = String(body?.agentId || st.rl?.agentId || '');
    const agent = await store.get('Agent', agentId);
    if (!agent) throw new HttpError(404, `Agent "${agentId}" is not registered`);
    const version = String(body?.version || '');
    if (!VERSION.test(version)) throw new HttpError(422, 'version must be 1 to 40 letters, digits, dots, dashes or plus signs');
    const list = await events(st.id);
    if (!list.some((e) => e.kind === 'baseline' && !e.error)) throw new HttpError(409, 'Run the baseline for this study before registering a trained version');
    if (version === agent.version || list.some((e) => e.kind === 'version' && e.version === version)) throw new HttpError(409, `Version ${version} is already known for ${agent.name}`);
    const rounds = (Array.isArray(body?.rounds) ? body.rounds : []).slice(0, 200).map((r, i) => ({ round: Number.isFinite(Number(r?.round)) ? Number(r.round) : i + 1, passRate: Number.isFinite(Number(r?.passRate)) ? Math.max(0, Math.min(1, Number(r.passRate))) : null, safetyFailures: Number.isFinite(Number(r?.safetyFailures)) ? Number(r.safetyFailures) : null }));
    const by = { kind: 'human', id: `key:${key.id}`, role: 'trainer', name: key.name || key.org || 'a trainer' };
    const made = await save({ study: st.id, kind: 'version', agentId: agent.id, version, by, rounds, notes: String(body?.notes || '').slice(0, 1000), episodes: Number(body?.episodes) || null });
    start(st, 'evaluate', agent.id, version, system).catch(() => {});
    return { ...made, evaluating: true };
  }
  /** 4. Promote: the new version becomes the agent's current version, only when the comparison allows it. */
  async function promote(studyId, ctx) {
    const st = await rlStudy(studyId);
    const s = await state(st.id);
    const step = s.steps.find((x) => x.id === 'promote');
    if (!step.allowed) throw new HttpError(409, step.reason);
    const next = s.versions.at(-1);
    const agent = await store.get('Agent', next.agentId);
    await store.transaction(async (tx) => { const a = await tx.get('Agent', agent.id); const { _seq, ...doc } = a; await tx.save('Agent', { ...doc, version: next.version, previousVersion: a.version, promotedFrom: { study: st.id, at: tx.now() } }, { updatedBy: ctx.actor.role }); });
    return save({ study: st.id, kind: 'promote', agentId: agent.id, version: next.version, from: agent.version, by: ctx.actor, reason: step.reason });
  }
  async function settings(studyId, body, ctx) {
    const st = await rlStudy(studyId);
    const rlSettings = { taskSet: body?.taskSet ? String(body.taskSet) : st.rl?.taskSet ?? null, agentId: body?.agentId ? String(body.agentId) : st.rl?.agentId ?? null, condition: body?.condition ? String(body.condition) : st.rl?.condition ?? null, attempts: Math.max(1, Math.min(50, Number(body?.attempts ?? st.rl?.attempts ?? 3) || 3)), scoring: SCORING.includes(body?.scoring) ? body.scoring : st.rl?.scoring ?? 'automatic', pairs: Math.max(1, Math.min(500, Number(body?.pairs ?? st.rl?.pairs ?? 20) || 20)), judgesPerPair: Math.max(1, Math.min(9, Number(body?.judgesPerPair ?? st.rl?.judgesPerPair ?? 1) || 1)) };
    return store.transaction(async (tx) => { const cur = await tx.get('Study', st.id); const { _seq, ...doc } = cur; const saved = await tx.save('Study', { ...doc, rl: rlSettings }, { updatedBy: ctx.actor.role }); await recordAction(tx, { actor: ctx.actor, kind: 'update', action: 'study.settings', args: { study: st.id, ...rlSettings }, entityRef: `Study/${st.id}`, description: 'reinforcement learning settings saved' }); return saved.rl; });
  }
  /** The four steps with status pills, the before-and-after table, the score per round and where it still fails. */
  async function state(studyId) {
    const st = await rlStudy(studyId);
    const list = await events(st.id);
    const base = list.filter((e) => e.kind === 'baseline' && !e.error).at(-1) || null;
    const lastVersion = list.filter((e) => e.kind === 'version').at(-1) || null;
    const evals = list.filter((e) => e.kind === 'evaluate' && !e.error);
    const evalOfLast = lastVersion ? evals.filter((e) => e.version === lastVersion.version).at(-1) || null : null;
    const promoted = lastVersion ? list.some((e) => e.kind === 'promote' && e.version === lastVersion.version) : false;
    const run = pending.get(st.id) || null;
    const failed = (kind) => list.filter((e) => e.kind === kind && e.error).at(-1) || null;
    const cmp = compareVersions(base, evalOfLast);
    const steps = [
      { id: 'baseline', status: base ? 'done' : run?.kind === 'baseline' ? 'running' : 'next', detail: base ? `${base.agentId} v${base.version}: ${base.passed} of ${base.tasks} held-out tasks passed` : failed('baseline') ? `Last try failed: ${failed('baseline').error}` : 'Run the current version on the held-out tasks and the safety suite.' },
      { id: 'train', status: lastVersion ? 'done' : base ? 'running' : 'next', detail: lastVersion ? `Version ${lastVersion.version} registered by ${lastVersion.by?.name || 'a trainer'}` : base ? 'Waiting for a trainer to register a new version through the environment API.' : 'Starts after the baseline.' },
      { id: 'evaluate', status: evalOfLast ? 'done' : run?.kind === 'evaluate' ? 'running' : lastVersion && failed('evaluate') ? 'blocked' : 'next', detail: evalOfLast ? `${evalOfLast.passed} of ${evalOfLast.tasks} held-out tasks passed` : run?.kind === 'evaluate' ? `Evaluating ${run.version}` : lastVersion && failed('evaluate') ? `Evaluation failed: ${failed('evaluate').error}` : 'Starts on its own when a version is registered.' },
      { id: 'promote', status: promoted ? 'done' : evalOfLast ? (cmp.allowed ? 'next' : 'blocked') : 'next', allowed: !promoted && cmp.allowed, reason: promoted ? `Version ${lastVersion.version} was promoted.` : cmp.reason },
    ];
    const versions = [base, ...evals].filter(Boolean).map((e) => ({ kind: e.kind, label: e.kind === 'baseline' ? 'Baseline' : 'Trained', agentId: e.agentId, version: e.version, tasks: e.tasks, passed: e.passed, passRate: e.passRate, safetyFailures: e.safetyFailures, expertGrade: e.expertGrade, stepsPerTask: e.stepsPerTask, suiteRunId: e.suiteRunId, at: e.at }));
    const rounds = list.filter((e) => e.kind === 'version').flatMap((e) => (e.rounds || []).map((r) => ({ ...r, version: e.version })));
    const latest = evals.at(-1) || base;
    const tally = new Map();
    for (const t of latest?.perTask || []) for (const c of t.failedChecks) { const k = c.label; if (!tally.has(k)) tally.set(k, { check: c.id, label: c.label, runs: [] }); if (t.runId) tally.get(k).runs.push(t.runId); }
    const stillFails = [...tally.values()].sort((a, b) => b.runs.length - a.runs.length).slice(0, 5);
    return { study: { id: st.id, title: st.title }, settings: st.rl || null, steps, versions, rounds, stillFails, comparison: cmp };
  }
  async function handle(req, url, body, ctx, parts) {
    const [area, id, op] = parts; const m = req.method;
    if (area !== 'loop' || !id) return null;
    if (!op && m === 'GET') return { status: 200, body: await state(id) };
    if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only people may run or promote in the improvement loop');
    if (op === 'baseline' && m === 'POST') return { status: 201, body: await baseline(id, ctx) };
    if (op === 'promote' && m === 'POST') return { status: 201, body: await promote(id, ctx) };
    if (op === 'settings' && m === 'PUT') return { status: 200, body: await settings(id, body, ctx) };
    throw new HttpError(404, `${m} ${url.pathname} is not available`);
  }
  /** For tests and shutdown: wait for a running measurement. */
  const idle = async (studyId) => { const p = pending.get(studyId); if (p) await p.promise; };
  return { handle, state, baseline, registerVersion, promote, settings, idle };
}
