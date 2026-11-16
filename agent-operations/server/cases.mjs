// The case bank, rollouts and outcome horizons (§9d). A case is a frozen
// moment in one synthetic patient's chart, a task in plain English, the
// minimum correct actions and a verifier. A rollout forks the chart at the
// case's moment, lets an agent attempt the task there, and scores the result.
import { libraryFiles, libraryDir } from '../../platform/server/library.mjs';
import { createTasks, normalizeRubric, SPLITS, splitOf } from './tasks.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { createRun, endRun } from './runs.mjs';
import { normalizeTimeline } from './capabilities.mjs';
import { runVerifier, askJudge, judgeEnabled, verifierScore, rewardConfig, setRewardConfig, cleanConfig, gamingRisk, reward, histogram, COMPONENTS } from './grader.mjs';
import { createEpisodes } from './episodes.mjs';
import { shadowReport } from './shadow.mjs';
import { HTEST } from './hitl.mjs';
import { FHIR_TYPES } from '../../platform/server/validate.mjs';

export const HORIZONS = { '6h': 6 * 3600e3, '1d': 24 * 3600e3, '2d': 48 * 3600e3, '7d': 7 * 24 * 3600e3, discharge: null };
const HORIZON_LABEL = { '6h': '6 hours', '1d': '1 day', '2d': '2 days', '7d': '7 days', discharge: 'Discharge' };
const UNIT = { m: 60e3, h: 3600e3, d: 24 * 3600e3 };
const ACTION_TYPES = ['order', 'prescribe', 'diagnose'];
const MR = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR', display: 'Medical record number' }] };
const signatureOf = (checks, judge) => JSON.stringify([checks.map((c) => [c.id, c.pass]), judge?.credits ?? null]);

export function scenarioLibrary() {
  // The release ships no scenarios. These are the ones you placed in data/library/scenarios: <slug>.task.json beside <slug>.json (a FHIR bundle).
  return libraryFiles('scenarios', '.task.json').filter((f) => typeof f.json?.slug === 'string' && fs.existsSync(path.join(libraryDir('scenarios'), `${f.json.slug}.json`))).map((f) => f.json);
}

export function createRl({ store, agents }) {
  const tasks = createTasks({ store });
  const episodes = createEpisodes({ store, getHitl: () => agents.hitl });
  const system = { kind: 'human', id: 'system', role: 'system' };

  // ---------- Case bank ----------
  /**
   * Loads one of your scenarios into the case bank. Nothing is written to the chart: the scenario's records are kept on the
   * case and written onto a run's own sandbox branch each time the scenario is run. The patient has no name: "Patient <short id>".
   */
  async function loadScenario(slug, actor) {
    const task = scenarioLibrary().find((t) => t.slug === slug);
    if (!task) throw new HttpError(404, `No scenario "${slug}" in the library`);
    if ((await store.query('EvalCase', { where: (c) => c.slug === slug })).length) throw new HttpError(409, `"${task.title}" is already in the case bank`);
    const bundle = JSON.parse(fs.readFileSync(path.join(libraryDir('scenarios'), `${slug}.json`), 'utf8')).entry.map((e) => e.resource);
    const map = new Map(bundle.map((r) => [`${r.resourceType}/${r.id}`, `${r.resourceType}/${randomUUID()}`]));
    return store.transaction(async (tx) => {
      const now = Date.parse(tx.now());
      const swap = (key, v) => {
        if (typeof v !== 'string') return v;
        if (map.has(v)) return map.get(v);
        const m = v.match(/^@now-(\d+)([mhd])$/);
        return m ? new Date(now - Number(m[1]) * UNIT[m[2]]).toISOString() : v;
      };
      let patientRef = null; const plant = [];
      for (const raw of bundle) {
        if (!FHIR_TYPES.has(raw.resourceType)) throw new HttpError(500, `Scenario ${slug} contains an unsupported resource type`);
        const doc = { ...JSON.parse(JSON.stringify(raw), swap), id: map.get(`${raw.resourceType}/${raw.id}`).split('/')[1] };
        if (doc.resourceType === 'Patient') {
          doc.meta = { security: [HTEST] };
          doc.identifier = [{ type: MR, system: 'urn:hospital-desktop:mrn', value: `S${String(Math.floor(Math.random() * 900000) + 100000)}` }];
          doc.name = [{ family: `Patient ${doc.id.slice(0, 8)}` }]; // never a person's name, whatever the file holds
          patientRef = `Patient/${doc.id}`;
        }
        plant.push(doc);
      }
      const saved = await tx.save('EvalCase', {
        resourceType: 'EvalCase', id: randomUUID(), slug, title: task.title, scenario: task.scenario, task: task.task, patient: patientRef, asOf: tx.now(),
        goldActions: task.goldActions, avoid: task.avoid ?? [], verifier: null, graderConfig: {}, rubric: normalizeRubric(task.rubric), taskVersion: 1, split: splitOf(task), tags: task.tags,
        outcomeHorizons: task.outcomeHorizons ?? [], source: 'library', codesVerified: false, createdBy: actor.id,
        plant: plant.map((d) => (d.resourceType === 'Patient' ? d : { ...d, _patient: patientRef })),
      }, { updatedBy: actor.role });
      await recordAction(tx, { actor, kind: 'create', action: 'case.load', args: { case: saved.id, slug, split: saved.split, resources: bundle.length }, entityRef: `EvalCase/${saved.id}`, versionId: saved.meta.versionId, patientRef, description: `scenario "${slug}" loaded into the case bank (${saved.split} split)` });
      return saved;
    });
  }

  async function loadAll(actor) {
    const have = new Set((await store.query('EvalCase')).map((c) => c.slug));
    const loaded = [];
    for (const t of scenarioLibrary()) if (!have.has(t.slug)) loaded.push(await loadScenario(t.slug, actor));
    return loaded;
  }

  /** A case written by hand about a patient already in the chart. It has no verifier module: each gold action becomes one check. */
  async function createCase(input, actor, origin = {}) {
    const need = (k) => { if (typeof input?.[k] !== 'string' || !input[k].trim()) throw new HttpError(422, `${k} is required`); return input[k].trim(); };
    const patient = need('patient');
    if (!/^Patient\/[A-Za-z0-9\-.]{1,64}$/.test(patient) || !(await store.get('Patient', patient.split('/')[1]))) throw new HttpError(422, `${patient} is not in the chart`);
    if (!SPLITS.includes(input.split)) throw new HttpError(422, `split must be one of: ${SPLITS.join(', ')}`);
    const rubric = normalizeRubric(input.rubric);
    // What the work is about, when it is one record of the patient's (an imaging study to report, a message to answer, a note to mark).
    let subject = null;
    if (input.subject) { const m = /^(ImagingStudy|Communication|DocumentReference)\/([A-Za-z0-9\-.]{1,64})$/.exec(String(input.subject)); const doc = m ? await store.get(m[1], m[2]) : null; if (!doc || (doc._patient ?? doc.subject?.reference) !== patient) throw new HttpError(422, 'subject must be an imaging study, message or note of this patient'); subject = m[0]; }
    if (!Array.isArray(input.goldActions) || !input.goldActions.length || input.goldActions.length > 30) throw new HttpError(422, 'At least one gold action is required');
    const goldActions = input.goldActions.map((g) => {
      if (!ACTION_TYPES.includes(g?.type)) throw new HttpError(422, `Gold action type must be one of ${ACTION_TYPES.join(', ')}`);
      if (typeof g.code !== 'string' || !/^[A-Za-z0-9-]{2,12}:[A-Za-z0-9.\-]{1,40}$/.test(g.code)) throw new HttpError(422, `Gold action code must look like LOINC:2823-3, RxNorm:1191 or ICD-10:J18.9 ("${g?.code}")`);
      return { type: g.type, code: g.code, label: String(g.label || g.code).slice(0, 160) };
    });
    const horizons = input.outcomeHorizons ?? [];
    if (!Array.isArray(horizons) || horizons.some((h) => !(h in HORIZONS))) throw new HttpError(422, `outcomeHorizons must be chosen from ${Object.keys(HORIZONS).join(', ')}`);
    return store.transaction(async (tx) => {
      const asOf = input.asOf ? new Date(input.asOf).toISOString() : tx.now();
      if (asOf > tx.now()) throw new HttpError(422, 'asOf cannot be in the future');
      const saved = await tx.save('EvalCase', {
        resourceType: 'EvalCase', id: randomUUID(), slug: null, title: need('title').slice(0, 160), scenario: need('scenario').slice(0, 1000), task: need('task').slice(0, 500), patient, asOf,
        goldActions, avoid: [], verifier: null, graderConfig: {}, rubric, subject, taskVersion: 1, split: input.split, tags: Array.isArray(input.tags) ? input.tags.map((t) => String(t).slice(0, 30)).slice(0, 12) : [],
        outcomeHorizons: horizons, timeline: normalizeTimeline(input.timeline), source: origin.source ?? 'by-hand', capturedFrom: origin.capturedFrom ?? null, codesVerified: false, createdBy: actor.id,
      }, { updatedBy: actor.role });
      await recordAction(tx, { actor, kind: 'create', action: 'case.create', args: { case: saved.id, split: saved.split }, entityRef: `EvalCase/${saved.id}`, versionId: saved.meta.versionId, patientRef: patient, description: `case "${saved.title}" added to the case bank (${saved.split} split)` });
      return saved;
    });
  }

  async function caseBank() {
    const cases = (await store.query('EvalCase')).sort((a, b) => a.title.localeCompare(b.title));
    const eps = (await episodes.list()).filter((e) => e.kind === 'rollout');
    const patients = new Map((await store.query('Patient')).map((p) => [`Patient/${p.id}`, p]));
    const loaded = new Set(cases.map((c) => c.slug));
    return {
      cases: cases.map(({ _seq, meta, resourceType, ...c }) => {
        const mine = eps.filter((e) => e.caseId === c.id).map((e) => e.outcome.totalReward);
        const p = patients.get(c.patient);
        return { ...c, plant: undefined, patientName: p ? [p.name?.[0]?.family, (p.name?.[0]?.given || []).join(' ')].filter(Boolean).join(', ') || c.patient : (c.plant || []).find((d) => d.resourceType === 'Patient')?.name?.[0]?.family || c.patient, attempts: mine.length, bestReward: mine.length ? Math.max(...mine) : null, meanReward: mine.length ? Math.round((mine.reduce((n, v) => n + v, 0) / mine.length) * 1000) / 1000 : null };
      }),
      library: scenarioLibrary().map((t) => ({ slug: t.slug, title: t.title, split: t.split, tags: t.tags, loaded: loaded.has(t.slug) })),
      horizons: Object.keys(HORIZONS), judge: judgeEnabled(),
    };
  }

  // ---------- Attempts ----------
  const violationsOf = (steps) => steps.filter((s) => s.who.kind === 'agent' && (s.did.type === 'envelope.reject' || (s.did.type === 'safety.block' && (s.did.args.alerts || []).includes('allergy-conflict')))).length;
  const scoreOf = (checks) => verifierScore(checks).score;

  async function attempt(evalCase, agent, { mode, seed, actor, batch, overlays = [], ablation = null, regression = null, condition = null, link = null }) {
    const live = mode === 'shadow-task';
    const run = await createRun(store, {
      mode, agentId: agent.id, version: agent.version, caseId: evalCase.id, subject: evalCase.subject || evalCase.patient, goal: evalCase.task, seed, parentBranch: 'main', forkedAt: live ? undefined : evalCase.asOf,
      overlays, ...(condition ? { condition } : {}), ...(link ? { attempt: link } : {}), trigger: { kind: regression ? 'regression' : ablation ? 'ablation' : live ? 'case-shadow' : 'rollout', ...(regression || {}), actor: actor.id, role: actor.role, at: store.now(), batch, ...(ablation || {}) },
    }, actor);
    const outcome = await agents.work(run, agent);
    const checks = await runVerifier(store, evalCase, run.branch);
    const steps = await store.query('TraceStep', { groupKey: run.id });
    const judge = await askJudge({ evalCase, checks, trajectory: (await episodes.turnsOf(run)).map((t) => ({ action: t.action, reasoning: t.reasoning })) });
    const startedAt = Date.parse(run.startedAt);
    const horizons = [];
    for (const label of evalCase.outcomeHorizons || []) {
      const interval = HORIZONS[label];
      if (live) {
        horizons.push({ label, name: HORIZON_LABEL[label], clock: 'live', dueAt: interval == null ? null : new Date(startedAt + interval).toISOString(), status: 'pending', evaluatedAt: null, agent: null, clinician: null });
      } else {
        const hc = await runVerifier(store, evalCase, run.branch, { horizon: label });
        horizons.push({ label, name: HORIZON_LABEL[label], clock: 'replayed', dueAt: interval == null ? null : new Date(Date.parse(evalCase.asOf) + interval).toISOString(), status: 'done', evaluatedAt: store.now(), agent: { checks: hc, score: scoreOf(hc) }, clinician: null });
      }
    }
    const now = store.now();
    const episode = await episodes.saveEpisode({
      id: `ep-${run.id}`, ablated: run.overlays.length > 0, overlays: run.overlays, kind: live ? 'shadow-case' : regression ? 'regression' : run.overlays.length || ablation ? 'ablation' : 'rollout', agentId: agent.id, version: run.version, policyHash: run.policyHash, runId: run.id, caseId: evalCase.id, caseSlug: evalCase.slug, split: evalCase.split,
      state: { patient: evalCase.patient, asOf: live ? run.startedAt : evalCase.asOf, branch: run.branch, scenario: evalCase.scenario, task: evalCase.task, seed },
      action: { summary: outcome.result?.summary ?? outcome.error ?? null, output: outcome.result?.output ?? [], finished: outcome.ok }, trajectory: steps.map((s) => s.id),
      outcome: { raw: { checks, safetyViolations: violationsOf(steps) }, judge, horizons }, evaluations: [{ at: now, signature: signatureOf(checks, judge), score: scoreOf(checks) }], timestamp: now,
    }, actor);
    await endRun(store, run.id, agents.agentActor(agent), outcome.ok ? 'completed' : outcome.reason, { ...(outcome.result ?? { error: outcome.error }), episodeId: episode.id, checksPassed: checks.filter((c) => c.pass).length, checks: checks.length });
    return episode.id;
  }

  async function prepare(agentId, caseId) {
    if (!agents.ready) throw new HttpError(409, 'The server is not ready to run agents yet');
    const agent = await store.get('Agent', String(agentId ?? ''));
    if (!agent) throw new HttpError(404, `Agent "${agentId}" is not registered`);
    if (!agents.canRun(agent)) throw new HttpError(409, 'External agent endpoints are disabled. Set ALLOW_EXTERNAL_AGENTS=true to let this server call them');
    const evalCase = await store.get('EvalCase', String(caseId ?? ''));
    if (!evalCase) throw new HttpError(404, `Case "${caseId}" is not in the case bank`);
    return { agent, evalCase };
  }

  /** N attempts at one case, each in its own rollout branch forked at the case's moment. Seeds make each attempt replayable. */
  // version: evaluate a registered later version of the agent (the improvement loop); the runs and episodes carry it.
  async function rollouts({ agentId, caseId, attempts = 5, seed = 1, overlays = [], ablation = null, regression = null, condition = null, version = null }, actor) {
    const n = Number(attempts);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new HttpError(422, 'attempts must be a whole number between 1 and 50');
    if (!Number.isInteger(Number(seed)) || Number(seed) < 0) throw new HttpError(422, 'seed must be a whole number of 0 or more');
    const prepared = await prepare(agentId, caseId);
    const evalCase = prepared.evalCase; const agent = version ? { ...prepared.agent, version: String(version) } : prepared.agent;
    const batch = randomUUID();
    const ids = [];
    for (let i = 0; i < n; i += 1) ids.push(await attempt(evalCase, agent, { mode: 'rl-generate', seed: Number(seed) + i, actor, batch, overlays, ablation, regression, condition: condition ? String(condition) : null }));
    const made = (await episodes.list({ caseId: evalCase.id })).filter((e) => ids.includes(e.id));
    const totals = made.map((e) => e.outcome.totalReward);
    return { batch, caseId: evalCase.id, title: evalCase.title, split: evalCase.split, agentId: agent.id, version: agent.version, attempts: n, episodes: made.sort((a, b) => a.state.seed - b.state.seed), best: Math.max(...totals), worst: Math.min(...totals), mean: Math.round((totals.reduce((x, v) => x + v, 0) / n) * 1000) / 1000 };
  }

  /** The agent attempts the case now, on a fork taken now, while a clinician works the same patient on the live chart. Horizon checks follow in real time. */
  async function shadowCase({ agentId, caseId }, actor) {
    const { agent, evalCase } = await prepare(agentId, caseId);
    const id = await attempt(evalCase, agent, { mode: 'shadow-task', seed: 0, actor, batch: null });
    return (await episodes.list({ caseId: evalCase.id })).find((e) => e.id === id);
  }

  async function updateEpisode(id, change) {
    return store.transaction(async (tx) => {
      const { _seq, ...doc } = await tx.get('Episode', id);
      return tx.save('Episode', change(doc), { updatedBy: 'system' });
    });
  }

  /** Runs every horizon check that has come due. Live checks look at the agent's fork and at what the clinician had done on the live chart by then. */
  async function runDueHorizons() {
    const now = store.now();
    const pending = await store.query('Episode', { where: (e) => (e.outcome?.horizons || []).some((h) => h.status === 'pending') });
    let done = 0;
    for (const e of pending) {
      const evalCase = await store.get('EvalCase', e.caseId);
      const run = await store.get('Run', e.runId);
      if (!evalCase || !run) continue;
      const next = [];
      for (const h of e.outcome.horizons) {
        if (h.status !== 'pending') { next.push(h); continue; }
        let due = h.dueAt && h.dueAt <= now ? h.dueAt : null;
        if (h.label === 'discharge') {
          const finished = (await store.query('Encounter', { patient: evalCase.patient, where: (x) => x.status === 'finished' && x._recordedAt >= run.startedAt })).sort((a, b) => String(a._recordedAt).localeCompare(String(b._recordedAt)))[0];
          due = finished?._recordedAt ?? null;
        }
        if (!due) { next.push(h); continue; }
        const agentChecks = await runVerifier(store, evalCase, run.branch, { horizon: h.label });
        const clinicianChecks = await runVerifier(store, evalCase, 'main', { horizon: h.label, asOf: due });
        next.push({ ...h, dueAt: due, status: 'done', evaluatedAt: now, agent: { checks: agentChecks, score: scoreOf(agentChecks) }, clinician: { checks: clinicianChecks, score: scoreOf(clinicianChecks) } });
        done += 1;
      }
      if (next.some((h, i) => h !== e.outcome.horizons[i])) {
        await updateEpisode(e.id, (doc) => ({ ...doc, outcome: { ...doc.outcome, horizons: next } }));
        await store.transaction((tx) => recordAction(tx, { runId: e.runId, actor: system, kind: 'execute', action: 'horizon.check', args: { episode: e.id, horizons: next.filter((h, i) => h !== e.outcome.horizons[i]).map((h) => h.label) }, entityRef: `Episode/${e.id}`, description: `outcome horizon checked for ${e.id}`, audit: false }));
      }
    }
    return { checked: done, stillPending: (await store.query('Episode', { where: (e) => (e.outcome?.horizons || []).some((h) => h.status === 'pending') })).length };
  }

  /** Runs the verifier (and judge, if on) again for stored episodes. A different answer the second time is a "flip". */
  async function reevaluate(actor) {
    const targets = await store.query('Episode', { where: (e) => ['rollout', 'shadow-case', 'ablation', 'regression'].includes(e.kind) });
    let flips = 0;
    for (const e of targets) {
      const evalCase = await store.get('EvalCase', e.caseId);
      const run = await store.get('Run', e.runId);
      if (!evalCase || !run) continue;
      const checks = await runVerifier(store, evalCase, run.branch);
      const judge = await askJudge({ evalCase, checks, trajectory: (await episodes.turnsOf(run)).map((t) => ({ action: t.action, reasoning: t.reasoning })) });
      const signature = signatureOf(checks, judge);
      if ((e.evaluations || []).at(-1)?.signature !== signature) flips += 1;
      await updateEpisode(e.id, (doc) => ({ ...doc, outcome: { ...doc.outcome, raw: { ...doc.outcome.raw, checks }, judge }, evaluations: [...(doc.evaluations || []), { at: store.now(), signature, score: scoreOf(checks) }].slice(-10) }));
    }
    await store.transaction((tx) => recordAction(tx, { actor, kind: 'execute', action: 'reward.reevaluate', args: { episodes: targets.length, flips }, description: `re-evaluated ${targets.length} episodes (${flips} changed)` }));
    return { reEvaluated: targets.length, flips, summary: await episodes.rewardSummary() };
  }

  // ---------- Version registry ----------
  async function policies() {
    const lastModel = new Map();
    for (const st of (await store.query('TraceStep', { where: (t) => t.did?.type === 'model.call' && t.did.args?.model })).sort((x, y) => x._seq - y._seq)) { const run = await store.get('Run', st.runId); if (run?.agentId) lastModel.set(`${run.agentId}@${run.version}`, st.did.args.model); }
    const agentsNow = await store.query('Agent');
    const eps = await episodes.list();
    const shadow = (await shadowReport(store)).agents;
    const hitl = agents.hitl ? (await agents.hitl.report()).agents : [];
    const suites = (await store.query('Run', { where: (r) => r.mode === 'redteam' && r.result?.kind === 'suite' && r.result.complete })).sort((a, b) => b._seq - a._seq);
    const mean = (v) => (v.length ? Math.round((v.reduce((n, x) => n + x, 0) / v.length) * 1000) / 1000 : null);
    const out = [];
    for (const a of agentsNow.sort((x, y) => x.name.localeCompare(y.name))) {
      const history = await store.history('Agent', a.id);
      const versions = new Map();
      for (const h of history) if (!versions.has(h.version)) versions.set(h.version, h);
      for (const e of eps.filter((x) => x.agentId === a.id)) if (!versions.has(e.version)) versions.set(e.version, { ...a, version: e.version, policyHash: e.policyHash, _recordedAt: e.timestamp });
      for (const [version, first] of [...versions.entries()].reverse()) {
        const mine = eps.filter((e) => e.agentId === a.id && e.version === version);
        const train = mine.filter((e) => e.split !== 'eval'); const evals = mine.filter((e) => e.split === 'eval' && e.kind === 'rollout');
        const red = suites.find((r) => r.agentId === a.id && r.version === version) ?? null;
        const sh = shadow.find((g) => g.agentId === a.id && g.version === version)?.summary ?? null;
        const hi = hitl.find((g) => g.agentId === a.id && g.version === version) ?? null;
        const grades = {};
        for (const e of mine) for (const g of e.outcome.humanGrade?.grades || []) grades[g] = (grades[g] || 0) + 1;
        const dates = [...mine.map((e) => e.timestamp), red?.endedAt].filter(Boolean).sort();
        out.push({
          agentId: a.id, name: a.name, version, policyHash: first.policyHash, current: a.version === version, stage: a.version === version ? (a.stage ?? 'shadow') : 'superseded', firstSeen: first._recordedAt,
          episodes: { total: mine.length, training: train.length, eval: evals.length, rollout: mine.filter((e) => e.kind === 'rollout').length, shadow: mine.filter((e) => e.kind === 'shadow' || e.kind === 'shadow-case').length, hitl: mine.filter((e) => e.kind === 'hitl').length },
          trainMeanReward: mean(train.filter((e) => e.kind === 'rollout').map((e) => e.outcome.totalReward)), evalSplitScore: mean(evals.map((e) => e.outcome.totalReward)),
          shadow: sh ? { compared: sh.compared, agreementRate: sh.agreementRate } : null,
          hitl: hi ? { live: { decided: hi.live.decided, acceptanceRate: hi.live.acceptanceRate }, practice: { decided: hi.practice.decided, acceptanceRate: hi.practice.acceptanceRate } } : null,
          redTeam: red ? { passed: red.result.passed, total: red.result.total, failed: red.result.failed, at: red.endedAt } : null,
          promotions: (a.promotions || []).filter((p) => p.version === version),
          card: {
            capabilities: first.description ?? a.description, mayWrite: (first.scopes ?? a.scopes).map((s) => `${s.type}: ${s.interactions.join(', ')}`), runsOn: (first.adapter ?? a.adapter).kind === 'stub' ? 'Built-in rules, offline' : 'External endpoint',
            knownFailureModes: first.knownLimits ?? a.knownLimits ?? 'None declared', evaluationDate: dates.at(-1) ?? null, redTeam: red ? (red.result.passed ? `Passed all ${red.result.total}` : `Failed ${red.result.failed} of ${red.result.total}`) : 'Not run',
            evalSplitScore: mean(evals.map((e) => e.outcome.totalReward)), evalEpisodes: evals.length, expertGrades: grades,
            // Model-backed versions: adapter, model name, prompt hash, temperature, context window; the model name comes from the last model.call when the adapter resolved it.
            ...((first.adapter ?? a.adapter).kind === 'model' ? { adapter: (first.adapter ?? a.adapter).model, model: lastModel.get(`${a.id}@${version}`) ?? (first.adapter ?? a.adapter).model, template: (first.adapter ?? a.adapter).template, promptHash: (first.adapter ?? a.adapter).promptHash ?? null, temperature: (first.adapter ?? a.adapter).temperature ?? 0, contextWindow: (first.adapter ?? a.adapter).contextWindow ?? null } : {}),
          },
        });
      }
    }
    return { generatedAt: store.now(), note: 'Scores are rewards under the current weights. They are proxies and do not establish clinical safety.', policies: out };
  }

  async function rewardView(config) {
    const cfg = config ?? await rewardConfig(store);
    const cases = (await store.query('EvalCase')).sort((a, b) => a.title.localeCompare(b.title));
    const checks = [];
    for (const c of cases) for (const k of await runVerifier(store, c, 'main').catch(() => [])) checks.push({ key: `${c.slug ?? c.id}:${k.id}`, caseTitle: c.title, label: k.label, forbidden: k.forbidden, defaultWeight: k.weight, weight: cfg.checks[`${c.slug ?? c.id}:${k.id}`] ?? k.weight });
    return { config: cfg, components: Object.entries(COMPONENTS).map(([name, c]) => ({ name, ...c, weight: cfg.components[name], defaultWeight: c.weight })), checks, risk: gamingRisk(cfg), summary: await episodes.rewardSummary(cfg), judge: judgeEnabled() };
  }

  async function handle(req, url, body, ctx, parts) {
    const m = req.method;
    const [area, a, b] = parts;
    const human = () => { if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only people can change cases, rewards or start rollouts'); };
    if (area === 'cases') {
      if (parts.length === 1 && m === 'GET') return { status: 200, body: await caseBank() };
      if (parts.length === 1 && m === 'POST') { human(); return { status: 201, body: await createCase(body, ctx.actor) }; }
      if (parts.length === 2 && a === 'load' && m === 'POST') { human(); return { status: 201, body: { loaded: body?.slug ? [await loadScenario(String(body.slug), ctx.actor)] : await loadAll(ctx.actor) } }; }
      if (parts.length === 3 && b === 'shadow' && m === 'POST') { human(); return { status: 201, body: await shadowCase({ agentId: body?.agentId, caseId: a }, ctx.actor) }; }
      // A task is never changed in place: PUT writes the next version and keeps every earlier one.
      if (parts.length === 2 && m === 'PUT') { human(); const { plant, ...out } = await tasks.revise(a, body || {}, ctx.actor); return { status: 200, body: out }; }
      if (parts.length === 3 && b === 'versions' && m === 'GET') return { status: 200, body: { versions: await tasks.versions(a) } };
      if (parts.length === 4 && b === 'versions' && m === 'GET') { const { plant, ...out } = await tasks.taskAt(a, parts[3]); return { status: 200, body: out }; }
      if (parts.length === 2 && m === 'DELETE') throw new HttpError(405, 'Tasks are never deleted: results point at them');
    }
    if (area === 'rollouts' && parts.length === 1 && m === 'POST') { human(); return { status: 201, body: await rollouts(body || {}, ctx.actor) }; }
    if (area === 'episodes' && parts.length === 1 && m === 'GET') {
      const q = url.searchParams;
      return { status: 200, body: { episodes: await episodes.list({ agentId: q.get('agentId'), version: q.get('version'), caseId: q.get('caseId'), kind: q.get('kind'), split: q.get('split') }) } };
    }
    if (area === 'episodes.jsonl' && parts.length === 1 && m === 'GET') return episodes.exportLines('episodes', url, ctx);
    if (area === 'export' && parts.length === 2 && m === 'GET') {
      const kind = { 'sft.jsonl': 'sft', 'preferences.jsonl': 'preferences', 'trajectories.jsonl': 'trajectories' }[a];
      if (kind) return episodes.exportLines(kind, url, ctx);
    }
    if (area === 'reward') {
      if (parts.length === 1 && m === 'GET') return { status: 200, body: await rewardView() };
      if (parts.length === 1 && m === 'PUT') { human(); await setRewardConfig(store, body, ctx.actor); return { status: 200, body: await rewardView() }; }
      if (parts.length === 2 && a === 'preview' && m === 'POST') { const base = await rewardConfig(store); return { status: 200, body: await rewardView({ ...base, ...cleanConfig(body, base) }) }; }
      if (parts.length === 2 && a === 'reevaluate' && m === 'POST') { human(); return { status: 200, body: await reevaluate(ctx.actor) }; }
    }
    if (area === 'policies' && parts.length === 1 && m === 'GET') return { status: 200, body: await policies() };
    if (area === 'horizons' && parts.length === 2 && a === 'run-due' && m === 'POST') { human(); return { status: 200, body: await runDueHorizons() }; }
    return null;
  }

  return { attemptCase: attempt, tasks, handle, loadScenario, loadAll, createCase, caseBank, rollouts, shadowCase, runDueHorizons, reevaluate, policies, episodes };
}
