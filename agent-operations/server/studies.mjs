// Studies and attempts (docs/STUDY-DESIGN.md 4 and 5).
//
// A study is set up by a Researcher: a task set (or, for shadow only, live patients), participants (people
// and agent versions), conditions, task order and assignment. Starting it freezes it and creates every
// attempt up front. An attempt is one participant doing one task once, on its own branch of the chart.
// Agents' attempts run on their own, one after another; people work through theirs with "Next task",
// which closes and locks the attempt and opens the next one.
import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { createRun, endRun, runEvents } from './runs.mjs';
import { mulberry32 } from '../../ehr/server/wearables.mjs';
import { validateOverlays } from './ablation.mjs';
import { splitOf } from './tasks.mjs';
import { simNow } from '../../platform/server/simclock.mjs';
import { segAnswer } from '../../pacs/server/seg.mjs';
import { path as shadowPath, comparePaths } from './shadow.mjs';

export const CONDITIONS = ['shadow', 'hitl', 'autonomous', 'redteam'];
export const CONDITION_LABEL = { shadow: 'Shadow', hitl: 'Human in the loop', autonomous: 'Autonomous', redteam: 'Red team', human: 'Human' };
const ORDERS = ['fixed', 'shuffled', 'counterbalanced'];
const ASSIGNMENTS = ['all', 'k', 'split'];
const RUN_MODE = { shadow: 'shadow-task', autonomous: 'rl-generate', redteam: 'redteam', hitl: 'hitl' };
const OPEN_STATES = ['waiting', 'open'];
const text = (v, n) => String(v ?? '').trim().slice(0, n);
const keyOf = (p) => (p.kind === 'agent' ? `agent:${p.id}@${p.version}` : `person:${p.id}`);
const hashInt = (s) => parseInt(createHash('sha256').update(String(s)).digest('hex').slice(0, 8), 16);

/** The order one participant meets the tasks in. index: the participant's place among participants of its kind. */
export function orderTasks(tasks, order, seed, participantKey, index) {
  if (order === 'shuffled') { const rnd = mulberry32(hashInt(`${seed}:${participantKey}`)); const out = [...tasks]; for (let i = out.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; }
  if (order === 'counterbalanced') { const n = tasks.length; const k = n ? index % n : 0; return [...tasks.slice(k), ...tasks.slice(0, k)]; } // a cyclic Latin square: each task appears once in each position across n participants
  return [...tasks];
}
/** Which readers get task number j. all: everyone. k: k readers, spread evenly. split: exactly one. */
export function readersFor(j, people, assignment) {
  const P = people.length; if (!P) return [];
  const k = assignment.mode === 'all' ? P : assignment.mode === 'split' ? 1 : Math.min(P, assignment.k);
  return Array.from({ length: k }, (_, r) => people[(j + r) % P]);
}

export function createStudies({ store, agents, rl, accounts, redTeamTests = null }) {
  const tasks = rl.tasks;
  const locked = new Set();          // branches of closed attempts: nothing more is written there
  const working = new Map();         // branch of an open attempt -> { runId, people: who may write there }
  const queues = new Map();          // study id -> promise chain of agent attempts
  const researcher = (ctx) => { if (ctx.actor.kind !== 'human' || ctx.actor.role !== 'researcher') throw new HttpError(403, 'Only a Researcher sets up and runs studies'); };
  const getStudy = async (id) => { const s = await store.get('EvalStudy', String(id || '')); if (!s) throw new HttpError(404, 'No such study'); return s; };
  const getAttempt = async (id) => { const a = await store.get('Attempt', String(id || '')); if (!a) throw new HttpError(404, 'No such attempt'); return a; };
  const attemptsOf = async (studyId) => (await store.query('Attempt', { groupKey: studyId })).sort((a, b) => a.participantKey.localeCompare(b.participantKey) || a.position - b.position);
  const saveAttempt = (tx, a, by = 'study') => { const { _seq, meta, ...doc } = a; return tx.save('Attempt', { ...doc, _groupKey: doc.study }, { updatedBy: by }); };
  const noteOpen = (a) => { if (a.branch && a.branch !== 'main' && (a.participant.kind === 'person' || a.human)) working.set(a.branch, { runId: a.runId, // human in the loop: the person's work joins the agent's run, so both are in one trace
 person: a.participant.kind === 'person' ? a.participant.id : a.human }); };
  const ready = (async () => { for (const a of await store.query('Attempt', { where: (x) => x.branch && x.state !== 'waiting' })) { if (a.state === 'open') noteOpen(a); else locked.add(a.branch); } })().catch(() => {});

  // ---------- set-up ----------
  async function normalize(input, existing = null) {
    const title = text(input.title ?? existing?.title, 160); if (!title) throw new HttpError(422, 'A study needs a title');
    const kind = input.kind ?? existing?.kind ?? 'evaluation'; if (!['evaluation', 'annotation'].includes(kind)) throw new HttpError(422, 'kind must be evaluation or annotation');
    const live = input.live !== undefined ? (input.live ? { clock: input.live.clock === 'simulation' ? 'simulation' : 'real' } : null) : existing?.live ?? null;
    const taskSet = live ? null : (input.taskSet !== undefined ? (input.taskSet ? String(input.taskSet) : null) : existing?.taskSet ?? null);
    if (taskSet && !(await store.get('TaskSet', taskSet))) throw new HttpError(422, `No task set "${taskSet}"`);
    const participants = [];
    for (const p of input.participants ?? existing?.participants ?? []) {
      if (p?.kind === 'agent') { const a = await store.get('Agent', String(p.id || '')); if (!a) throw new HttpError(422, `Agent "${p.id}" is not registered`); participants.push({ kind: 'agent', id: a.id, version: String(p.version || a.version) }); }
      else if (p?.kind === 'person') { const person = await accounts.get(String(p.id || '')); if (!person) throw new HttpError(422, 'A participant is not among the people in the Library'); participants.push({ kind: 'person', id: person.id }); }
      else throw new HttpError(422, 'Each participant is an agent or a person');
    }
    if (new Set(participants.map(keyOf)).size !== participants.length) throw new HttpError(422, 'A participant is listed twice');
    const conditions = [...new Set(input.conditions ?? existing?.conditions ?? [])];
    if (conditions.some((c) => !CONDITIONS.includes(c))) throw new HttpError(422, `conditions are chosen from: ${CONDITIONS.join(', ')}`);
    const order = input.order ?? existing?.order ?? 'fixed'; if (!ORDERS.includes(order)) throw new HttpError(422, `order must be one of: ${ORDERS.join(', ')}`);
    const asg = input.assignment ?? existing?.assignment ?? { mode: 'all' };
    if (!ASSIGNMENTS.includes(asg?.mode)) throw new HttpError(422, `assignment mode must be one of: ${ASSIGNMENTS.join(', ')}`);
    if (asg.mode === 'k' && !(Number.isInteger(asg.k) && asg.k >= 1)) throw new HttpError(422, 'k readers per case: k must be a whole number of 1 or more');
    const perturbations = (input.perturbations ?? existing?.perturbations ?? []).map((p, i) => ({ id: text(p.id || `p${i + 1}`, 40), label: text(p.label || `Perturbation ${i + 1}`, 120), overlays: validateOverlays(p.overlays) }));
    if (perturbations.length > 6) throw new HttpError(422, 'At most 6 perturbations');
    const scheme = input.labelScheme ?? existing?.labelScheme ?? null;
    if (scheme && !(['classification', 'spans', 'boxes', 'regions', 'segmentation'].includes(scheme.type))) throw new HttpError(422, 'labelScheme.type must be classification, spans, boxes, regions or segmentation');
    const adjudicator = input.adjudicator !== undefined ? (input.adjudicator ? String(input.adjudicator) : null) : existing?.adjudicator ?? null;
    if (adjudicator && !(await accounts.get(adjudicator))) throw new HttpError(422, 'The adjudicator is not among the people in the Library');
    return {
      resourceType: 'EvalStudy', id: existing?.id ?? randomUUID(), title, kind, description: text(input.description ?? existing?.description, 1000), taskSet, live, participants, conditions, order,
      assignment: { mode: asg.mode, ...(asg.mode === 'k' ? { k: asg.k } : {}) }, humanBaseline: input.humanBaseline ?? existing?.humanBaseline ?? true, perturbations,
      labelScheme: scheme ? { type: scheme.type, labels: (scheme.labels || []).map((l) => text(l, 60)).filter(Boolean).slice(0, 40) } : null, adjudicator,
      disagreementLimit: Number.isFinite(input.disagreementLimit) ? input.disagreementLimit : existing?.disagreementLimit ?? 0.7,
      seed: Number.isInteger(input.seed) ? input.seed : existing?.seed ?? 1, status: existing?.status ?? 'draft', frozen: existing?.frozen ?? null, createdBy: existing?.createdBy ?? null, copiedFrom: existing?.copiedFrom ?? null,
    };
  }

  async function create(body, ctx, copiedFrom = null) {
    const doc = await normalize(body || {});
    return store.transaction(async (tx) => {
      const saved = await tx.save('EvalStudy', { ...doc, createdBy: ctx.actor.id, copiedFrom }, { updatedBy: ctx.actor.role });
      await recordAction(tx, { actor: ctx.actor, kind: 'create', action: 'study.create', args: { study: saved.id, kind: saved.kind }, entityRef: `EvalStudy/${saved.id}`, versionId: saved.meta.versionId, description: `study "${saved.title}" drafted` });
      return saved;
    });
  }
  async function update(id, body, ctx) {
    const cur = await getStudy(id);
    if (cur.status !== 'draft') throw new HttpError(409, 'A started study is frozen. Copy it to change it.');
    const { _seq, meta, ...base } = cur; const doc = await normalize(body || {}, base);
    return store.save('EvalStudy', doc, { updatedBy: ctx.actor.role });
  }

  /** The attempts a study will have: participant x task x condition, in each participant's order. */
  function plan(study, frozenTasks) {
    const agentsIn = study.participants.filter((p) => p.kind === 'agent'); const people = study.participants.filter((p) => p.kind === 'person');
    const out = []; const variants = [{ id: null, overlays: [] }, ...study.perturbations];
    agentsIn.forEach((agent, ai) => {
      const conds = study.conditions; const shift = study.order === 'counterbalanced' && conds.length ? ai % conds.length : 0;
      const condOrder = [...conds.slice(shift), ...conds.slice(0, shift)];
      let position = 0;
      for (const condition of condOrder) for (const variant of variants) {
        orderTasks(frozenTasks, study.order, study.seed, `${keyOf(agent)}:${condition}:${variant.id || ''}`, ai).forEach((t) => {
          const j = frozenTasks.indexOf(t);
          out.push({ participant: agent, condition, perturbation: variant.id, taskId: t.taskId, taskVersion: t.version, position: position++, human: condition === 'hitl' ? people[(j + ai) % people.length].id : null });
        });
      }
    });
    if (study.humanBaseline) people.forEach((person, pi) => {
      const mine = frozenTasks.filter((t, j) => readersFor(j, people, study.assignment).some((r) => r.id === person.id));
      orderTasks(mine, study.order, study.seed, keyOf(person), pi).forEach((t, position) => out.push({ participant: person, condition: 'human', perturbation: null, taskId: t.taskId, taskVersion: t.version, position, human: null }));
    });
    return out;
  }

  async function start(id, ctx) {
    await ready;
    const study = await getStudy(id);
    if (study.status !== 'draft') throw new HttpError(409, 'This study has already been started');
    const agentsIn = study.participants.filter((p) => p.kind === 'agent'); const people = study.participants.filter((p) => p.kind === 'person');
    if (!study.participants.length) throw new HttpError(422, 'Add at least one participant');
    if (agentsIn.length && !study.conditions.length) throw new HttpError(422, 'Choose at least one condition for the agents');
    if (study.conditions.includes('hitl') && !people.length) throw new HttpError(422, 'Human in the loop needs at least one person among the participants');
    let frozenTasks = [];
    if (study.live) {
      if (study.conditions.length !== 1 || study.conditions[0] !== 'shadow' || people.length || !agentsIn.length) throw new HttpError(422, 'Watching live patients is for the shadow condition with agents only');
    } else {
      if (!study.taskSet) throw new HttpError(422, 'Choose a task set');
      const set = await store.get('TaskSet', study.taskSet);
      if (!set.tasks.length) throw new HttpError(422, 'The task set has no tasks');
      for (const t of set.tasks) { const snap = await tasks.taskAt(t.taskId, t.version ?? null); frozenTasks.push({ taskId: t.taskId, version: snap.version, title: snap.title, split: splitOf(snap), rubric: snap.rubric || [] }); }
    }
    const planned = study.live ? [] : plan(study, frozenTasks);
    const started = await store.transaction(async (tx) => {
      const { _seq, meta, ...base } = await tx.get('EvalStudy', id);
      const frozen = { at: tx.now(), by: ctx.actor.id, taskSet: study.taskSet, tasks: frozenTasks, participants: study.participants, conditions: study.conditions, order: study.order, assignment: study.assignment, perturbations: study.perturbations, seed: study.seed, labelScheme: study.labelScheme, live: study.live };
      const saved = await tx.save('EvalStudy', { ...base, status: 'started', startedAt: tx.now(), frozen, hash: createHash('sha256').update(JSON.stringify(frozen)).digest('hex') }, { updatedBy: ctx.actor.role });
      for (const a of planned) await tx.save('Attempt', { resourceType: 'Attempt', id: randomUUID(), study: id, _groupKey: id, ...a, participantKey: keyOf(a.participant), state: 'waiting', runId: null, branch: null, openedAt: null, closedAt: null, scores: null, answer: null, seal: null }, { updatedBy: 'study' });
      await recordAction(tx, { actor: ctx.actor, kind: 'update', action: 'study.start', args: { study: id, attempts: planned.length, live: Boolean(study.live) }, entityRef: `EvalStudy/${id}`, versionId: saved.meta.versionId, description: `study "${saved.title}" started and frozen (${planned.length} attempts)` });
      return saved;
    });
    if (study.live) await watchLive(started, ctx);
    else runAgents(started, ctx.actor);
    return started;
  }

  // ---------- agents run on their own ----------
  function runAgents(study, actor) {
    const chain = (queues.get(study.id) || Promise.resolve()).then(async () => {
      const mine = (await attemptsOf(study.id)).filter((a) => a.participant.kind === 'agent' && a.state === 'waiting' && a.condition !== 'hitl');
      for (const a of mine) {
        if ((await getStudy(study.id)).status !== 'started') break;
        await runAgentAttempt(study, a, actor).catch(async (err) => { await store.transaction(async (tx) => saveAttempt(tx, { ...(await tx.get('Attempt', a.id)), state: 'stopped', closedAt: tx.now(), error: String(err.message || err).slice(0, 300) })); });
      }
      await finishIfDone(study.id);
    }).catch(() => {});
    queues.set(study.id, chain);
    return chain;
  }
  async function runAgentAttempt(study, a, actor) {
    const agent = await store.get('Agent', a.participant.id);
    if (!agent) throw new Error('The agent is no longer registered');
    const snap = await tasks.taskAt(a.taskId, a.taskVersion); const base = await store.get('EvalCase', a.taskId);
    const evalCase = { ...base, ...snap, id: a.taskId, resourceType: 'EvalCase' };
    const overlays = study.frozen.perturbations.find((p) => p.id === a.perturbation)?.overlays || [];
    await store.transaction(async (tx) => saveAttempt(tx, { ...(await tx.get('Attempt', a.id)), state: 'open', openedAt: tx.now() }));
    const link = { study: study.id, attempt: a.id, task: a.taskId, taskVersion: a.taskVersion, condition: a.condition, perturbation: a.perturbation, participant: a.participantKey };
    if (a.condition === 'redteam' && redTeamTests) { const done = await runHazards(a, agent, evalCase, link, actor); if (done) return; }
    const episodeId = await rl.attemptCase(evalCase, { ...agent, version: a.participant.version }, { mode: RUN_MODE[a.condition], seed: study.frozen.seed + a.position, actor, batch: study.id, overlays, link });
    const episode = await store.get('Episode', episodeId);
    await close(a.id, { runId: episode.runId, by: 'study' });
  }

  /**
   * Red team: every hazard in the red-team library that fits this agent (hidden instructions, wrong patient,
   * contradictory allergy, a tenfold dose and the rest) is planted on a copy of the task's patient, each on its own
   * red-team branch, and scored pass or fail. Returns false when there is nothing to plant, so the task runs plainly.
   */
  async function runHazards(a, agent, evalCase, link, actor) {
    await redTeamTests.ensureBuiltins().catch(() => {});
    const pid = String(evalCase.patient || '').split('/')[1];
    // A scenario's patient is on no branch until a run plants it: its hazards are planted from the scenario's own chart, straight onto the hazard's branch.
    const onRecord = Boolean(pid && await store.get('Patient', pid)); const chart = !onRecord && Array.isArray(evalCase.plant) && evalCase.plant.length ? evalCase.plant : null;
    if (!onRecord && !chart) return false;
    const tests = (await store.query('RedTeamTest', { where: (t) => t.enabled !== false && !t.heldOut && Boolean(t.subjects?.[agent.capability]) })).sort((x, y) => x.id.localeCompare(y.id));
    if (!tests.length) return false;
    const hazards = [];
    for (const t of tests) {
      try { const out = await redTeamTests.runTest(t, { agentId: agent.id, version: a.participant.version, limit: 1, seeds: 1, patient: onRecord ? pid : null, chart, link }, actor); const r = out.runs[0]; if (r) hazards.push({ test: t.id, title: t.title, family: t.family, pass: r.passed, failed: r.failed, checks: r.checks, runId: r.runId, branch: r.branch }); }
      catch (err) { hazards.push({ test: t.id, title: t.title, family: t.family, pass: null, error: String(err.message || err).slice(0, 200), failed: [], checks: [], runId: null, branch: null }); }
    }
    const ran = hazards.filter((h) => h.pass != null); const show = ran.find((h) => !h.pass) || ran[0] || null;
    for (const h of ran) if (h.branch) locked.add(h.branch);
    const sealed = await seal(show?.runId ?? null); // read before the transaction: the store is never called from inside one
    await store.transaction(async (tx) => saveAttempt(tx, { ...(await tx.get('Attempt', a.id)), state: 'closed', runId: show?.runId ?? null, branch: show?.branch ?? null, closedAt: tx.now(), seal: sealed, hazardRuns: ran.map((h) => h.runId),
      scores: { success: ran.length ? { pass: ran.every((h) => h.pass), met: ran.filter((h) => h.pass).length, of: ran.length, share: ran.filter((h) => h.pass).length / ran.length } : null, safetyViolations: ran.filter((h) => !h.pass).length, expertGrade: null, seconds: null, steps: null, hazards: hazards.map(({ branch, ...h }) => h) } }));
    return true;
  }

  // ---------- live shadow: each watched patient event becomes an attempt ----------
  async function watchLive(study, ctx) {
    for (const p of study.participants) {
      const agent = await store.get('Agent', p.id); if (!agent || agent.shadow?.event) continue;
      const { _seq, meta, ...doc } = agent;
      await store.save('Agent', { ...doc, shadow: { ...(doc.shadow || {}), event: true }, shadowTurnedOnBy: study.id }, { updatedBy: ctx.actor.role });
    }
  }
  const onCreated = async (run, from) => {
    if (from !== store || run.mode !== 'shadow-event' || !run.agentId || run.attempt) return;
    const live = (await store.query('EvalStudy', { where: (s) => s.status === 'started' && s.live && s.participants.some((p) => p.id === run.agentId) }));
    for (const study of live) {
      // The clock option: a study on the simulation clock takes only events that happen in simulated time (runs with a simulation
      // clock) and keeps simulated times; a study on the real clock takes only real-time events.
      const simulated = Boolean(run.sim);
      if ((study.live.clock === 'simulation') !== simulated) continue;
      const n = (await attemptsOf(study.id)).filter((a) => a.participant.id === run.agentId).length;
      const participant = study.participants.find((p) => p.id === run.agentId);
      await store.transaction((tx) => tx.save('Attempt', { resourceType: 'Attempt', id: randomUUID(), study: study.id, _groupKey: study.id, participant, participantKey: keyOf(participant), condition: 'shadow', perturbation: null, taskId: null, taskVersion: null, event: { kind: run.trigger?.kind ?? null, subject: run.subject ?? null, patient: run.patientRef ?? null }, clock: simulated ? 'simulation' : 'real', simulatedAt: simulated ? simNow(run, store.now()) : null, position: n, human: null, state: 'open', runId: run.id, branch: run.branch, openedAt: tx.now(), closedAt: null, scores: null, answer: null, seal: null, hidden: true }, { updatedBy: 'study' }));
    }
  };
  const onEnded = async (run, from) => {
    if (from !== store || run.mode !== 'shadow-event') return;
    for (const a of await store.query('Attempt', { where: (x) => x.runId === run.id && x.state === 'open' })) await close(a.id, { runId: run.id, by: 'study' }).catch(() => {});
  };
  const listen = { created: (r, s) => { onCreated(r, s).catch(() => {}); }, ended: (r, s) => { onEnded(r, s).catch(() => {}); } };
  runEvents.on('created', listen.created); runEvents.on('ended', listen.ended);

  // ---------- attempts: open, close and lock, next ----------
  const scorers = [];
  async function seal(runId) {
    const steps = runId ? await store.query('TraceStep', { groupKey: runId }) : [];
    return { steps: steps.length, hash: createHash('sha256').update(steps.map((s) => `${s.id}:${s.meta?.versionId ?? ''}`).join('|')).digest('hex') };
  }
  /** Close and lock: no more writes to the attempt's branch, the trace is sealed with a hash, the scores are worked out. */
  async function close(id, { runId = null, by = 'study', answer = undefined, state = 'closed' } = {}) {
    const cur = await getAttempt(id);
    if (!OPEN_STATES.includes(cur.state)) return cur;
    const rid = runId ?? cur.runId; const run = rid ? await store.get('Run', rid) : null;
    if (run && !run.endedAt) await endRun(store, run.id, { kind: 'human', id: 'study', role: 'system' }, 'completed').catch(() => {});
    const sealed = await seal(rid);
    let scores = null; for (const s of scorers) scores = { ...(scores || {}), ...(await s({ attempt: cur, run: rid ? await store.get('Run', rid) : null })) };
    if (run?.branch && run.branch !== 'main') locked.add(run.branch);
    const liveRun = cur.clock === 'simulation' && rid ? await store.get('Run', rid) : null;
    if (cur.branch) { working.delete(cur.branch); if (cur.branch !== 'main') locked.add(cur.branch); }
    return store.transaction(async (tx) => saveAttempt(tx, { ...(await tx.get('Attempt', id)), state, runId: rid, branch: run?.branch ?? cur.branch ?? null, closedAt: tx.now(), seal: sealed, scores: simulatedScores(cur, liveRun, scores), ...(liveRun ? { simulatedClosedAt: simNow(liveRun, store.now()) } : {}), ...(answer !== undefined ? { answer } : {}) }, by));
  }
  /** On the simulation clock the time an attempt took is simulated time, not the seconds the server spent. */
  const simulatedScores = (a, run, scores) => { if (!run || !a.simulatedAt || !scores) return scores; const end = simNow(run, store.now()); return { ...scores, seconds: Math.max(0, Math.round((Date.parse(end) - Date.parse(a.simulatedAt)) / 1000)), clock: 'simulation' }; };
  const mayWork = (a, actor) => actor.kind === 'human' && (a.participant.kind === 'person' ? a.participant.id === actor.id : a.human === actor.id);
  const queueOf = async (personId, studyId = null) => (await store.query('Attempt', { where: (a) => (a.participant.kind === 'person' ? a.participant.id === personId : a.human === personId) && (!studyId || a.study === studyId) }))
    .sort((a, b) => a.study.localeCompare(b.study) || a.position - b.position);

  /** A person opens their attempt: the chart is forked onto the attempt's own branch (for a scenario task, the patient is created there). */
  async function open(id, ctx) {
    const a = await getAttempt(id);
    if (!mayWork(a, ctx.actor)) throw new HttpError(403, 'This attempt is not yours');
    const study = await getStudy(a.study);
    if (study.status !== 'started') throw new HttpError(409, 'This study is not running');
    if (a.state === 'open') return present(a, study);
    if (a.state !== 'waiting') throw new HttpError(409, 'This attempt is closed and locked');
    const earlier = (await queueOf(ctx.actor.id, a.study)).find((x) => x.position < a.position && OPEN_STATES.includes(x.state) && x.participantKey === a.participantKey);
    if (earlier) throw new HttpError(409, 'Finish your earlier task first: tasks are done in order');
    const snap = await tasks.taskAt(a.taskId, a.taskVersion);
    const link = { study: study.id, attempt: a.id, task: a.taskId, taskVersion: a.taskVersion, condition: a.condition, perturbation: a.perturbation, participant: a.participantKey };
    let run;
    if (a.condition === 'hitl') {
      // The person's own practice copy of the chart; the agent proposes there and the person approves, edits or rejects.
      const mine = await createRun(store, { mode: 'sandbox', caseId: a.taskId, subject: snap.subject || snap.patient, goal: snap.task, parentBranch: 'main', forkedAt: snap.asOf, attempt: { ...link, half: 'human' } }, ctx.actor);
      const agent = await store.get('Agent', a.participant.id);
      run = await createRun(store, { mode: 'hitl', agentId: agent.id, version: a.participant.version, subject: snap.subject || snap.patient, goal: snap.task, targetBranch: mine.branch, seed: study.frozen.seed + a.position, attempt: link }, ctx.actor);
      Promise.resolve((agents.runScenarioAgent || agents.work)(run, agent)).catch(() => {}); // the agent works, then its proposal waits for the person
      run = { ...run, branch: mine.branch, humanRunId: mine.id };
    } else {
      run = await createRun(store, { mode: 'sandbox', caseId: a.taskId, subject: snap.subject || snap.patient, goal: snap.task, parentBranch: 'main', forkedAt: snap.asOf, seed: study.frozen.seed + a.position, attempt: link }, ctx.actor);
    }
    const saved = await store.transaction(async (tx) => {
      const s = await saveAttempt(tx, { ...(await tx.get('Attempt', id)), state: 'open', runId: run.id, humanRunId: run.humanRunId ?? null, branch: run.branch, openedAt: tx.now() }, ctx.actor.role);
      await recordAction(tx, { runId: run.id, actor: ctx.actor, kind: 'execute', action: 'attempt.open', args: { study: study.id, attempt: id, task: a.taskId, taskVersion: a.taskVersion, condition: a.condition }, branch: run.branch, entityRef: `Attempt/${id}`, description: 'attempt opened' });
      return s;
    });
    noteOpen(saved);
    return present(saved, study, snap);
  }

  /** "Next task": closes and locks this attempt and opens the person's next one in the frozen order. */
  async function next(id, body, ctx) {
    const a = await getAttempt(id);
    if (!mayWork(a, ctx.actor)) throw new HttpError(403, 'This attempt is not yours');
    if (a.state !== 'open') throw new HttpError(409, a.state === 'waiting' ? 'Open the attempt first' : 'This attempt is already closed and locked');
    await store.transaction((tx) => recordAction(tx, { runId: a.runId, actor: ctx.actor, kind: 'execute', action: 'attempt.next', args: { study: a.study, attempt: id, skipped: Boolean(body?.skip) }, why: body?.why ? String(body.why).slice(0, 500) : null, branch: a.branch, entityRef: `Attempt/${id}`, description: body?.skip ? 'attempt skipped' : 'attempt closed with Next task' }));
    if (a.humanRunId) await endRun(store, a.humanRunId, ctx.actor, 'completed').catch(() => {});
    const drawn = body?.skip ? [] : await drawnOn(a.branch);
    const segs = body?.skip ? [] : await segmentedOn(a.branch);
    const given = body?.answer ?? null;
    const closed = await close(id, { by: ctx.actor.role, answer: drawn.length || segs.length ? { ...(given || {}), ...(drawn.length ? { regions: drawn } : {}), ...(segs.length ? { segmentations: segs } : {}) } : given, state: body?.skip ? 'skipped' : 'closed' });
    for (const hook of afterClose) await hook(closed).catch(() => {});
    const upcoming = (await queueOf(ctx.actor.id, a.study)).find((x) => x.state === 'waiting' && x.participantKey === a.participantKey && x.human === a.human);
    await finishIfDone(a.study);
    return { closed: present(closed), next: upcoming ? await open(upcoming.id, ctx) : null, done: !upcoming };
  }
  const afterClose = [];
  /** The segmentations (brush, threshold, region grow) a reader saved on their attempt's own branch, read back from the DICOM files. */
  async function segmentedOn(branch) {
    if (!branch || branch === 'main') return [];
    const before = new Set((await store.query('DicomObject', { where: (o) => o.kind === 'seg' })).map((o) => o.id));
    return (await store.query('DicomObject', { where: (o) => o.kind === 'seg' && !o.removed }, { branch })).filter((o) => !before.has(o.id)).map(segAnswer).filter(Boolean);
  }
  /** What a reader drew or measured in the imaging and pathology viewers on their attempt's own branch (so: theirs alone). */
  async function drawnOn(branch) {
    if (!branch || branch === 'main') return [];
    const kinds = new Set(['image-measurement', 'slide-annotation']);
    const mine = await store.query('Observation', { where: (o) => kinds.has(o.category?.[0]?.coding?.[0]?.code) }, { branch });
    const before = new Set((await store.query('Observation', { where: (o) => kinds.has(o.category?.[0]?.coding?.[0]?.code) })).map((o) => o.id));
    return mine.filter((o) => !before.has(o.id)).map((o) => {
      let g = {}; try { g = JSON.parse((o.extension || []).find((e) => /annotation/.test(e.url))?.valueString || '{}'); } catch { g = {}; }
      const pts = (g.imagePoints?.length ? g.imagePoints : g.points || []).map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p.x), Number(p.y)]));
      return { id: o.id, source: o.category[0].coding[0].code === 'slide-annotation' ? 'pathology' : 'imaging', kind: o.code?.coding?.[0]?.code ?? null, on: o.derivedFrom?.[0]?.reference ?? null, series: g.series ?? null, frame: g.frame ?? null, label: g.label ?? g.class ?? null, points: pts, value: o.valueQuantity?.value ?? null, unit: o.valueQuantity?.unit ?? null };
    });
  }

  async function finishIfDone(studyId) {
    const study = await getStudy(studyId);
    if (study.status !== 'started' || study.live) return;
    if ((await attemptsOf(studyId)).some((a) => OPEN_STATES.includes(a.state))) return;
    const { _seq, meta, ...doc } = study;
    await store.save('EvalStudy', { ...doc, status: 'finished', finishedAt: store.now() }, { updatedBy: 'study' });
  }
  async function stop(id, ctx) {
    const study = await getStudy(id);
    if (study.status !== 'started') throw new HttpError(409, 'Only a running study can be stopped');
    const { _seq, meta, ...doc } = study;
    const saved = await store.transaction(async (tx) => { const s = await tx.save('EvalStudy', { ...doc, status: 'stopped', finishedAt: tx.now() }, { updatedBy: ctx.actor.role }); await recordAction(tx, { actor: ctx.actor, kind: 'update', action: 'study.stop', args: { study: id }, entityRef: `EvalStudy/${id}`, versionId: s.meta.versionId, description: `study "${s.title}" stopped` }); return s; });
    await queues.get(id);
    for (const a of await attemptsOf(id)) if (OPEN_STATES.includes(a.state)) await close(a.id, { state: 'stopped' });
    if (study.live) for (const p of study.participants) { const agent = await store.get('Agent', p.id); if (agent?.shadowTurnedOnBy === id) { const { _seq: q, meta: m, shadowTurnedOnBy, ...d } = agent; await store.save('Agent', { ...d, shadow: { ...(d.shadow || {}), event: false } }, { updatedBy: ctx.actor.role }); } }
    return saved;
  }

  // ---------- reading ----------
  const TAG = { shadow: 'Shadow', hitl: 'Human in the loop', autonomous: 'Autonomous', redteam: 'Red team' };
  const refLabel = (ref) => { const s = String(ref ?? ''); return s.length > 28 ? `${s.slice(0, 12)}…${s.slice(-8)}` : s || 'Case'; };
  function present(a, study = null, snap = null) {
    const { _seq, meta, resourceType, _groupKey, ...out } = a;
    return { ...out, ...(snap ? { task: { title: snap.title, instruction: snap.task, scenario: snap.scenario, patient: snap.patient, subject: snap.subject ?? null, asOf: snap.asOf, rubric: snap.rubric || [] } } : {}), ...(study ? { studyTitle: study.title, studyKind: study.kind, labelScheme: study.frozen?.labelScheme ?? study.labelScheme ?? null } : {}) };
  }
  function tagsOf(study) {
    const conds = study.frozen?.conditions ?? study.conditions;
    if (study.legacy) return [...(study.readerStudy ? ['Reader study'] : []), ...(study.migratedFrom?.type === 'AnnotationProject' ? ['Labelling'] : []), ...(study.earlierMode === 'rl' ? ['Training'] : []), ...(study.earlierMode === 'annotate' ? ['Annotation'] : []), ...conds.map((c) => TAG[c])];
    return [...(study.live ? ['Live'] : []), ...(study.kind === 'annotation' ? [study.labelScheme?.type ? study.labelScheme.type[0].toUpperCase() + study.labelScheme.type.slice(1) : 'Annotation'] : []), ...conds.map((c) => TAG[c]), ...(study.participants.some((p) => p.kind === 'person') && !conds.includes('hitl') && study.kind !== 'annotation' ? ['Human baseline'] : [])];
  }
  async function summary(study) {
    const all = study.status === 'draft' ? [] : await attemptsOf(study.id);
    const { _seq, meta, resourceType, ...s } = study;
    return { ...s, tags: tagsOf(study), attempts: all.length, closed: all.filter((a) => !OPEN_STATES.includes(a.state)).length, progress: all.length ? all.filter((a) => !OPEN_STATES.includes(a.state)).length / all.length : 0 };
  }
  /** The grid: rows are participants, columns are tasks, each cell is one attempt. */
  async function grid(id) {
    const study = await getStudy(id); const all = study.status === 'draft' ? [] : await attemptsOf(id);
    const people = new Map((await accounts.people()).map((p) => [p.id, p])); const agentsById = new Map((await store.query('Agent')).map((a) => [a.id, a]));
    const rows = (study.frozen?.participants ?? study.participants).map((p) => ({ key: keyOf(p), kind: p.kind, id: p.id, version: p.version ?? null, label: p.kind === 'agent' ? `${agentsById.get(p.id)?.name ?? p.id} v${p.version}` : people.get(p.id)?.name ?? (study.legacy ? `Reader ${String(p.id).slice(0, 12)}` : 'Person') }));
    const byCase = study.legacy && all.some((a) => a.participant.kind === 'person'); // reader studies and labelling: one column per case
    const columns = byCase ? [...new Set(all.map((a) => a.caseRef))].map((ref) => ({ taskId: null, caseRef: ref, title: refLabel(ref) }))
      : study.live || study.legacy ? [...new Set(all.map((a) => a.position))].sort((x, y) => x - y).map((n) => ({ taskId: null, title: `${study.live ? 'Event' : 'Run'} ${n + 1}`, position: n })) : (study.frozen?.tasks ?? []).map((t) => ({ taskId: t.taskId, version: t.version, title: t.title, split: t.split }));
    const cells = all.map((a) => ({ id: a.id, row: a.participantKey, taskId: a.taskId, caseRef: a.caseRef ?? null, position: a.position, condition: a.condition, perturbation: a.perturbation, state: a.state, runId: a.runId, human: a.human, scores: a.scores, error: a.error ?? null }));
    return { layout: byCase ? 'case' : study.live || study.legacy ? 'position' : 'task', study: await summary(study), rows, columns, conditions: [...new Set(all.map((a) => a.condition))], perturbations: study.frozen?.perturbations?.map((p) => ({ id: p.id, label: p.label })) ?? [], cells };
  }

  /**
   * Side by side: what an agent did on each task against what each person did on the same task, as ordered paths,
   * with how alike they are and the first step at which they part.
   */
  async function compare(studyId) {
    const study = await getStudy(studyId); const all = study.status === 'draft' ? [] : await attemptsOf(studyId);
    const titles = new Map((study.frozen?.tasks ?? []).map((t) => [t.taskId, t.title])); const names = new Map((await accounts.people()).map((p) => [p.id, p.name]));
    const pathOf = async (a, kind) => (a.runId ? shadowPath((await store.query('TraceStep', { groupKey: a.runId })).filter((x) => x.who.kind === kind && (kind === 'agent' || x.who.id === a.participant.id))) : []);
    const rows = [];
    for (const agent of all.filter((a) => a.participant.kind === 'agent' && a.state === 'closed' && a.taskId && !a.perturbation)) {
      const people = all.filter((p) => p.participant.kind === 'person' && p.condition === 'human' && p.taskId === agent.taskId && p.state === 'closed');
      const ap = await pathOf(agent, 'agent');
      for (const person of people) { const hp = await pathOf(person, 'human'); const c = comparePaths(ap, hp); rows.push({ taskId: agent.taskId, task: titles.get(agent.taskId) ?? 'Task', condition: agent.condition, agent: agent.participantKey, agentAttempt: agent.id, agentRun: agent.runId, person: names.get(person.participant.id) ?? 'Person', personAttempt: person.id, personRun: person.runId, similarity: c.similarity, split: c.split, agentPath: ap.map((x) => x.label), personPath: hp.map((x) => x.label), agentSuccess: agent.scores?.success?.pass ?? null, personSuccess: person.scores?.success?.pass ?? null }); }
      if (!people.length) rows.push({ taskId: agent.taskId, task: titles.get(agent.taskId) ?? 'Task', condition: agent.condition, agent: agent.participantKey, agentAttempt: agent.id, agentRun: agent.runId, person: null, similarity: null, split: null, agentPath: ap.map((x) => x.label), personPath: [], agentSuccess: agent.scores?.success?.pass ?? null, personSuccess: null });
    }
    return { study: studyId, rows };
  }

  async function handle(req, url, body, ctx) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); const m = req.method; const [area, id, op] = parts;
    if (area === 'studies') {
      if (ctx.actor.kind === 'human' && !['researcher', 'physician', 'nurse'].includes(ctx.actor.role)) throw new HttpError(403, 'Studies are for staff. Your own tasks are in My work.');
      if (!id && m === 'GET') { const kind = url.searchParams.get('kind'); const all = (await store.query('EvalStudy', { where: (s) => !kind || s.kind === kind })).sort((a, b) => String(b.meta?.lastUpdated).localeCompare(String(a.meta?.lastUpdated))); return { status: 200, body: { studies: await Promise.all(all.map(summary)), conditions: CONDITIONS.map((c) => ({ id: c, label: CONDITION_LABEL[c] })), orders: ORDERS, assignments: ASSIGNMENTS } }; }
      if (!id && m === 'POST') { researcher(ctx); return { status: 201, body: await summary(await create(body, ctx)) }; }
      if (id && !op && m === 'GET') return { status: 200, body: await grid(id) };
      if (id && op === 'compare' && m === 'GET') return { status: 200, body: await compare(id) };
      if (id && !op && m === 'PUT') { researcher(ctx); return { status: 200, body: await summary(await update(id, body, ctx)) }; }
      if (id && op === 'start' && m === 'POST') { researcher(ctx); return { status: 200, body: await summary(await start(id, ctx)) }; }
      if (id && op === 'stop' && m === 'POST') { researcher(ctx); return { status: 200, body: await summary(await stop(id, ctx)) }; }
      if (id && op === 'copy' && m === 'POST') { researcher(ctx); const { _seq, meta, id: old, status, frozen, hash, startedAt, finishedAt, ...base } = await getStudy(id); return { status: 201, body: await summary(await create({ ...base, title: text(body?.title || `${base.title} (copy)`, 160) }, ctx, old)) }; }
    }
    if (area === 'attempts' && id) {
      if (!op && m === 'GET') { const a = await getAttempt(id); if (ctx.actor.role !== 'researcher' && !mayWork(a, ctx.actor)) throw new HttpError(403, 'This attempt is not yours'); return { status: 200, body: present(a, await getStudy(a.study), a.taskId ? await tasks.taskAt(a.taskId, a.taskVersion) : null) }; }
      if (op === 'open' && m === 'POST') return { status: 200, body: await open(id, ctx) };
      if (op === 'next' && m === 'POST') return { status: 200, body: await next(id, body, ctx) };
    }
    throw new HttpError(404, 'No such study action');
  }

  return {
    handle, start, close, open, next, grid, summary, getStudy, getAttempt, attemptsOf, queueOf, present, keyOf,
    isLocked: (branch) => locked.has(branch),
    /** The run a person's work on this branch belongs to, worked out by the server: { runId } or null. Throws when the branch is someone else's open attempt. */
    workOn(branch, actor) { const w = working.get(branch); if (!w) return null; if (actor.kind === 'human' && actor.id !== w.person && actor.role !== 'researcher') throw new HttpError(403, 'This branch is another participant\'s open attempt'); return actor.kind === 'human' && actor.id === w.person ? { runId: w.runId } : null; }, addScorer: (fn) => scorers.push(fn), onClosed: (fn) => afterClose.push(fn),
    idle: async (studyId) => { await queues.get(studyId); },
    dispose: () => { runEvents.off('created', listen.created); runEvents.off('ended', listen.ended); },
  };
}
