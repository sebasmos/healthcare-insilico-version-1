// Agent turns, the Agent panel and timeline events (plan-master tasks 8, 9, 10).
//
// A turn is one agent invocation from one trigger. The panel is the
// conversation between the clinician and the agent for one run: every
// message, request, decision and piece of guidance is a TraceStep, so the
// log is the conversation. In-place drafts report what the clinician did
// with them (shown, used, edited, discarded, thumbs) through the same log.
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { endRun, setPaused, withStatus } from './runs.mjs';
import { assertCap, hasCap, normalizeTimeline } from './capabilities.mjs';

export const REQUEST_KINDS = ['permission', 'question', 'low-confidence', 'stuck'];
export const DECISIONS = ['approve', 'deny', 'answer', 'guidance'];
export const DRAFT_EVENTS = ['shown', 'used', 'edited', 'discarded', 'thumbs-up', 'thumbs-down'];
/** recordAction returns ids; the panel needs the step itself. */
const record = async (tx, opts) => { const { traceStepId } = await recordAction(tx, opts); return tx.get('TraceStep', traceStepId); };
const PANEL_TYPES = new Set(['panel.message', 'panel.answer', 'panel.request', 'panel.decide', 'panel.guidance', 'panel.timeout', 'panel.take-over']);

const text = (v, max = 2000) => String(v ?? '').replace(/[\u0000-\u0008\u000B-\u001F]/g, '').trim().slice(0, max);
const step = (s) => ({ id: s.id, at: s.when?.wall, from: s.who.kind === 'agent' ? 'agent' : 'clinician', who: s.who.kind === 'agent' ? s.who.id : (s.who.role || 'clinician'), kind: s.did.args?.kind || s.did.type.slice(6), text: s.did.args?.text ?? '', cites: s.did.args?.cites ?? [], action: s.did.args?.action ?? null, request: s.did.args?.request ?? null, decision: s.did.args?.decision ?? null, reason: s.why ?? null, expiresAt: s.did.args?.expiresAt ?? null, type: s.did.type });

/** The panel conversation of a run, oldest first, with each request's decision attached. */
export function conversationOf(steps) {
  const items = steps.filter((s) => PANEL_TYPES.has(s.did.type)).map(step);
  const decided = new Map(items.filter((m) => m.type === 'panel.decide' || m.type === 'panel.timeout').map((m) => [m.request, m]));
  for (const m of items) if (m.type === 'panel.request') m.status = decided.get(m.id)?.type === 'panel.timeout' ? 'timed-out' : decided.get(m.id)?.decision ?? 'waiting';
  return items;
}
export const waitingRequests = (steps) => conversationOf(steps).filter((m) => m.type === 'panel.request' && m.status === 'waiting');

/** Counts of what the clinician did with drafts and requests in one run (task 9.4 and 10.3). */
export function interactionStats(steps) {
  const types = steps.map((s) => s.did.type);
  const n = (t) => types.filter((x) => x === t).length;
  const conv = conversationOf(steps);
  const requests = conv.filter((m) => m.type === 'panel.request');
  const answered = requests.filter((m) => m.status !== 'waiting' && m.status !== 'timed-out');
  const times = answered.map((m) => { const d = conv.find((x) => x.request === m.id && x.type === 'panel.decide'); return d ? (Date.parse(d.at) - Date.parse(m.at)) / 1000 : null; }).filter((t) => t != null);
  const editSize = steps.filter((s) => ['draft.edited', 'proposal.edit'].includes(s.did.type)).reduce((a, s) => a + (Number(s.did.args?.editSize) || 0), 0);
  return {
    draftsShown: n('draft.shown') + n('proposal.create'), draftsUsed: n('draft.used') + n('proposal.accept') + n('proposal.edit'), draftsEdited: n('draft.edited') + n('proposal.edit'),
    draftsDiscarded: n('draft.discarded') + n('proposal.reject'), thumbsUp: n('draft.thumbs-up'), thumbsDown: n('draft.thumbs-down'), editSize,
    overrides: n('draft.discarded') + n('proposal.reject') + requests.filter((m) => m.status === 'denied').length,
    questionsAsked: conv.filter((m) => m.type === 'panel.message').length, asks: requests.length,
    permissionsRequested: requests.filter((m) => m.kind === 'permission').length, permissionsApproved: requests.filter((m) => m.kind === 'permission' && m.status === 'approved').length,
    timedOut: requests.filter((m) => m.status === 'timed-out').length, guidance: n('panel.guidance'),
    timeToAnswer: times.length ? Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 10) / 10 : null,
    guidanceChangedOutcome: n('panel.guidance') > 0 && steps.some((s) => s.who.kind === 'agent' && ['fhir.create', 'fhir.update'].includes(s.did.type) && Date.parse(s.when?.wall) > Math.max(...steps.filter((x) => x.did.type === 'panel.guidance').map((x) => Date.parse(x.when?.wall)))),
  };
}

/** A rule-based chart answer that cites the records it used (chart-chat). Any agent can use it. */
const LABS = [['creatinine', '2160-0'], ['potassium', '2823-3'], ['sodium', '2951-2'], ['glucose', '2345-7'], ['haemoglobin', '718-7'], ['hemoglobin', '718-7'], ['troponin', '10839-9'], ['lactate', '2524-7'], ['bicarbonate', '1963-8'], ['white cell', '6690-2'], ['platelet', '777-3'], ['heart rate', '8867-4'], ['pulse', '8867-4'], ['blood pressure', '8480-6'], ['temperature', '8310-5'], ['oxygen', '59408-5'], ['saturation', '59408-5']];
export async function answerQuestion({ question, patientId, tools }) {
  const q = String(question || '').toLowerCase();
  const cites = [];
  if (!patientId) return { text: 'I cannot answer without a patient in context.', cites };
  const hit = LABS.find(([name]) => q.includes(name));
  if (hit) {
    const obs = (await tools.search('Observation', { patient: patientId, code: hit[1] }, `Look up ${hit[0]} results to answer the question`)).sort((a, b) => String(a.effectiveDateTime).localeCompare(String(b.effectiveDateTime)));
    if (!obs.length) return { text: `There are no ${hit[0]} results in the chart.`, cites };
    const recent = obs.slice(-5);
    for (const o of recent) cites.push(`Observation/${o.id}`);
    const line = recent.map((o) => `${String(o.effectiveDateTime || '').slice(0, 10)}: ${o.valueQuantity?.value ?? o.valueString ?? '?'} ${o.valueQuantity?.unit || ''}`.trim()).join('; ');
    const first = recent[0].valueQuantity?.value; const last = recent[recent.length - 1].valueQuantity?.value;
    const trend = typeof first === 'number' && typeof last === 'number' && recent.length > 1 ? (last > first ? ' It has risen.' : last < first ? ' It has fallen.' : ' It is unchanged.') : '';
    return { text: `${hit[0][0].toUpperCase()}${hit[0].slice(1)} (${recent.length} most recent): ${line}.${trend} Check the records before acting on this.`, cites };
  }
  if (/allerg/.test(q)) {
    const list = await tools.search('AllergyIntolerance', { patient: patientId }, 'Read the allergy list to answer the question');
    for (const a of list) cites.push(`AllergyIntolerance/${a.id}`);
    return { text: list.length ? `Recorded allergies: ${list.map((a) => a.code?.text || a.code?.coding?.[0]?.display || 'unnamed').join(', ')}.` : 'No allergies are recorded.', cites };
  }
  if (/medic|drug|prescri/.test(q)) {
    const list = await tools.search('MedicationRequest', { patient: patientId, status: 'active' }, 'Read the active medications to answer the question');
    for (const m of list) cites.push(`MedicationRequest/${m.id}`);
    return { text: list.length ? `Active medications: ${list.map((m) => m.medicationCodeableConcept?.text || m.medicationCodeableConcept?.coding?.[0]?.display || 'unnamed').join(', ')}.` : 'No active medications are recorded.', cites };
  }
  if (/problem|diagnos|condition/.test(q)) {
    const list = await tools.search('Condition', { patient: patientId }, 'Read the problem list to answer the question');
    for (const c of list) cites.push(`Condition/${c.id}`);
    return { text: list.length ? `Problem list: ${list.map((c) => c.code?.text || c.code?.coding?.[0]?.display || 'unnamed').join(', ')}.` : 'The problem list is empty.', cites };
  }
  return { text: 'I can answer about results (for example creatinine, potassium, troponin), allergies, medications and the problem list. I do not give clinical advice.', cites };
}

export function createTurns({ store, agents }) {
  const stepsOf = (runId) => store.query('TraceStep', { groupKey: runId });
  const human = (ctx) => { if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only a person can use the Agent panel'); };
  const openRun = async (id) => { const run = await store.get('Run', id); if (!run) throw new HttpError(404, `No run ${id}`); return run; };
  const patchRun = (tx, id, patch) => tx.get('Run', id).then((r) => tx.save('Run', { ...r, ...patch }, { updatedBy: 'system' }));

  /** A clinician's message to the panel. A question starts an agent turn (chart-chat). */
  async function postMessage(run, body, ctx) {
    human(ctx);
    if (run.endedAt) throw new HttpError(409, 'This run has ended, so the agent cannot answer');
    const msg = text(body?.text, 1000);
    if (!msg) throw new HttpError(422, 'Write a question first');
    const kind = body?.kind === 'guidance' ? 'guidance' : 'question';
    const saved = await store.transaction(async (tx) => record(tx, { runId: run.id, actor: ctx.actor, kind: 'execute', action: kind === 'guidance' ? 'panel.guidance' : 'panel.message', args: { kind, text: msg }, branch: run.branch, entityRef: `Run/${run.id}`, description: `${kind} from the clinician` }));
    if (kind === 'question') {
      assertCap(run, 'chart-chat', 'Answering a question');
      const agent = run.agentId ? await store.get('Agent', run.agentId) : null;
      if (!agent) throw new HttpError(409, 'This run has no agent to answer');
      const turn = agents.turn(run, agent, { kind: 'question', question: msg, at: store.now() });
      agents.track(turn);
      if (body?.wait !== false) await turn;
    }
    return { message: step(saved), conversation: conversationOf(await stepsOf(run.id)) };
  }

  /** The agent's answer to a question, with the records it cites. */
  async function postAnswer(run, agent, { text: answer, cites = [] }) {
    return store.transaction(async (tx) => record(tx, { runId: run.id, actor: agents.agentActor(agent), kind: 'execute', action: 'panel.answer', args: { kind: 'answer', text: text(answer, 4000), cites: cites.slice(0, 50) }, branch: run.branch, resources: cites.slice(0, 50).map((ref) => ({ ref })), entityRef: `Run/${run.id}`, description: 'agent answer in the panel' }));
  }

  /**
   * The agent asks (agent-may-ask). Records the request, then waits for a
   * decision or the time-out. On time-out it records that and stops the
   * turn safely: the caller gets an error it must not swallow.
   */
  async function ask(run, agent, { kind, text: body, action = null }) {
    assertCap(run, 'agent-may-ask', 'Asking the clinician');
    if (!REQUEST_KINDS.includes(kind)) throw new HttpError(422, `Request kind must be one of ${REQUEST_KINDS.join(', ')}`);
    const timeout = run.askTimeoutMs ?? 300000;
    const expiresAt = new Date(Date.parse(store.now()) + timeout).toISOString();
    const saved = await store.transaction(async (tx) => {
      const s = await record(tx, { runId: run.id, actor: agents.agentActor(agent), kind: 'execute', action: 'panel.request', args: { kind, text: text(body, 1000), action: action && typeof action === 'object' ? action : null, expiresAt }, branch: run.branch, entityRef: `Run/${run.id}`, approval: { status: 'proposed' }, description: `agent ${kind} request, waiting for the clinician` });
      await patchRun(tx, run.id, { awaitingReply: { request: s.id, kind, expiresAt } });
      return s;
    });
    const startedWall = Date.now();
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const current = await store.get('Run', run.id);
      if (!current || current.endedAt) { const e = new Error(`Run ended while waiting for the clinician (${current?.endReason || 'gone'})`); e.stopped = current?.endReason || 'stopped'; throw e; }
      const steps = await stepsOf(run.id);
      const decision = steps.find((s) => s.did.type === 'panel.decide' && s.did.args?.request === saved.id);
      if (decision) { await store.transaction((tx) => patchRun(tx, run.id, { awaitingReply: null })); return { decision: decision.did.args.decision, text: decision.did.args.text || '', reason: decision.why || null }; }
      // Timed out on the run's clock, or on the wall clock when the run's clock stands still (tests, step clocks).
      if (Date.parse(store.now()) >= Date.parse(expiresAt) || Date.now() - startedWall >= timeout) {
        await store.transaction(async (tx) => { await record(tx, { runId: run.id, actor: agents.agentActor(agent), kind: 'execute', action: 'panel.timeout', args: { kind: 'timeout', request: saved.id, text: `No reply within ${Math.round(timeout / 1000)} s, so I stopped safely without acting.` }, branch: run.branch, entityRef: `Run/${run.id}`, description: 'ask timed out; the agent stopped safely' }); await patchRun(tx, run.id, { awaitingReply: null }); });
        const e = new Error('No reply from the clinician in time; stopped safely'); e.stopped = 'ask-timeout'; throw e;
      }
    }
  }

  /** The clinician's decision on a request: approve, deny (reason required), answer, or guidance. */
  async function decide(run, body, ctx) {
    human(ctx);
    if (run.endedAt) throw new HttpError(409, 'This run has ended');
    const decision = body?.decision;
    if (!DECISIONS.includes(decision)) throw new HttpError(422, `decision must be one of ${DECISIONS.join(', ')}`);
    const reason = text(body?.reason, 500);
    if (decision === 'deny' && reason.length < 3) throw new HttpError(422, 'A reason is required to deny a request');
    const steps = await stepsOf(run.id);
    const waiting = waitingRequests(steps);
    const target = body?.request ? waiting.find((m) => m.id === body.request) : waiting[0];
    if (!target) throw new HttpError(409, body?.request ? 'That request is no longer waiting' : 'Nothing is waiting for a decision');
    if ((decision === 'answer' || decision === 'guidance') && !text(body?.text)) throw new HttpError(422, 'Write an answer first');
    const label = decision === 'approve' ? 'approved' : decision === 'deny' ? 'denied' : decision === 'answer' ? 'answered' : 'guided';
    const saved = await store.transaction((tx) => record(tx, { runId: run.id, actor: ctx.actor, kind: 'execute', action: 'panel.decide', args: { kind: label, request: target.id, decision: label, text: text(body?.text, 1000), requestKind: target.kind }, why: reason || null, branch: run.branch, entityRef: `Run/${run.id}`, approval: { status: decision === 'approve' ? 'approved' : decision === 'deny' ? 'rejected' : 'answered' }, description: `clinician ${label} the agent's ${target.kind} request` }));
    return { decision: step(saved), conversation: conversationOf(await stepsOf(run.id)) };
  }

  /** Take over: the agent's turn ends now; the clinician continues by hand. */
  async function takeOver(run, ctx, reason = 'The clinician took over') {
    human(ctx);
    if (run.endedAt) return withStatus(run);
    await store.transaction((tx) => record(tx, { runId: run.id, actor: ctx.actor, kind: 'execute', action: 'panel.take-over', args: { kind: 'take-over', text: reason }, branch: run.branch, entityRef: `Run/${run.id}`, description: 'the clinician took over from the agent' }));
    return withStatus(await endRun(store, run.id, ctx.actor, 'taken-over'));
  }

  /** What the clinician did with an in-place draft (task 9.1 and 10.2). Logged on the draft's run, and mirrored on the clinician's recording if one is on. */
  async function draftEvent(body, ctx) {
    human(ctx);
    const event = body?.event;
    if (!DRAFT_EVENTS.includes(event)) throw new HttpError(422, `event must be one of ${DRAFT_EVENTS.join(', ')}`);
    const id = text(body?.draft, 80);
    if (!id) throw new HttpError(422, 'draft (the proposal id) is required');
    const branch = typeof body?.branch === 'string' && body.branch ? body.branch : ctx.branch;
    const task = await store.get('Task', id, { branch }).catch(() => null) || await store.get('Task', id, { branch: ctx.branch }).catch(() => null) || await store.get('Task', id).catch(() => null);
    const runId = task ? (task.input || []).find((i) => i.type?.text === 'run')?.valueString : text(body?.run, 80);
    if (!runId) throw new HttpError(404, `No draft ${id}`);
    const args = { draft: id, kind: text(body?.kind, 40) || (task ? (task.input || []).find((i) => i.type?.text === 'kind')?.valueString : null), ...(event === 'edited' ? { editSize: Math.max(0, Number(body?.editSize) || 0) } : {}), ...(ctx.runId && ctx.runId !== runId ? { recording: ctx.runId } : {}) };
    const why = text(body?.why, 500) || null;
    const out = await store.transaction(async (tx) => {
      const s = await record(tx, { runId, actor: ctx.actor, kind: 'execute', action: `draft.${event}`, args, why, branch: ctx.branch, entityRef: `Task/${id}`, patientRef: task?._patient, description: `draft ${event} by the clinician (Task/${id})` });
      if (ctx.runId && ctx.runId !== runId) await record(tx, { runId: ctx.runId, actor: ctx.actor, kind: 'execute', action: 'ai.interaction', args: { event, draft: id, agentRun: runId, kind: args.kind, ...(args.editSize != null ? { editSize: args.editSize } : {}) }, why, branch: ctx.branch, entityRef: `Task/${id}`, patientRef: task?._patient, description: `AI draft ${event} during the recording` });
      return s;
    });
    return { ok: true, step: out.id };
  }

  // ---------- Timeline (8.3): optional events released at their times ----------

  /** Releases every due event: writes its resource on the run branch now (never earlier), and starts a scheduled check when the run may continue. */
  let scenarioRelease = null;
  async function releaseDue(run, { actor = { kind: 'human', id: 'timeline', role: 'system' } } = {}) {
    if (run?.sim && scenarioRelease) return scenarioRelease(run, { actor });
    const current = await store.get('Run', run.id);
    if (!current || !Array.isArray(current.timeline) || current.endedAt) return { released: [] };
    const now = store.now();
    const due = current.timeline.filter((e) => !e.releasedAt && Date.parse(e.at) <= Date.parse(now));
    if (!due.length) return { released: [] };
    const released = [];
    const checks = [];
    await store.transaction(async (tx) => {
      const timeline = current.timeline.map((e) => ({ ...e }));
      for (const e of due) {
        const slot = timeline.find((t) => t.id === e.id);
        if (e.kind === 'check') {
          if (!hasCap(current, 'long-horizon') && Array.isArray(current.capabilities)) { slot.releasedAt = now; slot.skipped = 'long-horizon is off'; continue; }
          checks.push(e);
        } else {
          const patientRef = current.patientRef || (String(current.subject || '').startsWith('Patient/') ? current.subject : null);
          const body = { ...e.resource, ...(patientRef && !e.resource.subject ? { subject: { reference: patientRef } } : {}), ...(e.resource.resourceType === 'Observation' && !e.resource.effectiveDateTime ? { effectiveDateTime: e.at } : {}), ...(e.resource.resourceType === 'Communication' && !e.resource.sent ? { sent: e.at } : {}) };
          const saved = await tx.save(body.resourceType, { ...body, id: body.id || randomUUID(), _patient: patientRef }, { branch: current.branch, updatedBy: 'system' });
          slot.ref = `${saved.resourceType}/${saved.id}`;
          await record(tx, { runId: current.id, actor, kind: 'create', action: 'timeline.release', args: { event: e.id, kind: e.kind, type: saved.resourceType, id: saved.id, at: e.at }, branch: current.branch, entityRef: slot.ref, versionId: saved.meta?.versionId, patientRef, description: `timeline event ${e.id} released: ${e.title || saved.resourceType}` });
        }
        slot.releasedAt = now;
        released.push(e.id);
      }
      await patchRun(tx, current.id, { timeline });
    });
    for (const e of checks) {
      const agent = current.agentId ? await store.get('Agent', current.agentId) : null;
      if (!agent) continue;
      agents.track(agents.turn(await store.get('Run', current.id), agent, { kind: 'scheduled-check', event: e.id, task: e.goal || e.title || 'Review the chart', at: now }));
    }
    return { released };
  }

  async function panelRuns(ctx, { patient = null } = {}) {
    const runs = (await store.query('Run', { where: (r) => !r.endedAt && r.agentId && r.mode !== 'redteam' && (!patient || r.patientRef === patient || r.subject === patient) })).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    const out = [];
    for (const r of runs.slice(0, 20)) { const steps = await stepsOf(r.id); out.push({ ...withStatus(r), waiting: waitingRequests(steps).length }); }
    return out;
  }

  async function handle(req, url, body, ctx, parts) {
    const [area, id, op] = parts;
    const method = req.method;
    if (area === 'panel') {
      human(ctx);
      if (parts.length === 1 && method === 'GET') return { status: 200, body: { runs: await panelRuns(ctx, { patient: url.searchParams.get('patient') }) } };
      if (id === 'waiting' && parts.length === 2 && method === 'GET') { const runs = await panelRuns(ctx); return { status: 200, body: { waiting: runs.reduce((a, r) => a + r.waiting, 0), runs: runs.filter((r) => r.waiting).map((r) => ({ id: r.id, agentId: r.agentId, waiting: r.waiting })) } }; }
      const run = await openRun(id);
      if (parts.length === 2 && method === 'GET') { const steps = await stepsOf(run.id); return { status: 200, body: { run: withStatus(run), conversation: conversationOf(steps), waiting: waitingRequests(steps), stats: interactionStats(steps) } }; }
      if (parts.length === 3 && method === 'POST') {
        if (op === 'ask' || op === 'message') return { status: 201, body: await postMessage(run, body, ctx) };
        if (op === 'decide') return { status: 200, body: await decide(run, body, ctx) };
        if (op === 'take-over') return { status: 200, body: await takeOver(run, ctx, text(body?.reason, 300) || undefined) };
        if (op === 'stop') { if (run.endedAt) return { status: 200, body: withStatus(run) }; return { status: 200, body: withStatus(await endRun(store, run.id, ctx.actor, 'stopped')) }; }
        if (op === 'pause') return { status: 200, body: withStatus(await setPaused(store, run.id, body?.paused !== false, ctx.actor)) };
      }
    }
    if (area === 'drafts' && id === 'events' && parts.length === 2 && method === 'POST') return { status: 201, body: await draftEvent(body, ctx) };
    if (area === 'timeline' && parts.length === 3 && op === 'release' && method === 'POST') { human(ctx); return { status: 200, body: await releaseDue(await openRun(id), { actor: ctx.actor }) }; }
    return null;
  }

  return { handle, postMessage, postAnswer, ask, decide, takeOver, draftEvent, releaseDue, conversationOf, waitingRequests, interactionStats, stepsOf, setScenarioRelease(fn) { scenarioRelease = fn; } };
}
