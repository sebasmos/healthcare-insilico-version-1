// Runs started from a scenario (plan-master tasks 11 and 12): the history is
// written onto the run's branch before T0, the timeline is copied onto the
// Run with real dates (shifted so the case looks current; the shift is
// stored), and events are released at their simulated times, never early.
// Actions by the actor are written at the current simulated time; planned
// events made impossible by those actions are skipped and the skip logged.
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { createRun, withStatus } from './runs.mjs';
import { newClock, simNow, simMinutes } from '../../platform/server/simclock.mjs';
import { hasCap } from './capabilities.mjs';
import { writeStreamSlice } from '../../ehr/server/wearables.mjs';
import { HTEST } from './hitl.mjs';

const AGENT_MODES = ['shadow-task', 'sandbox', 'hitl'];
const system = { kind: 'human', id: 'timeline', role: 'system' };

export function createScenarioRuns({ store, scenarios, agents, rpm: rpmGiven = null }) {
  let rpm = rpmGiven;
  const human = (ctx) => { if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only people can start scenario runs'); };

  /** Starts a run from a scenario: a human session (mode sandbox) or an agent run. */
  async function start(body, ctx) {
    human(ctx);
    const scenario = await scenarios.get(String(body?.scenario || ''));
    const agentId = body?.agentId ? String(body.agentId) : null;
    const mode = agentId ? (AGENT_MODES.includes(body?.mode) ? body.mode : 'shadow-task') : 'sandbox';
    const clockMode = body?.clock || scenario.clock || 'real';
    const nowIso = store.now(); const t0Ms = Date.parse(nowIso);
    const { history, events, patientRef } = scenarios.materialize(scenario, t0Ms);
    const earliest = Math.min(-1, ...history.map((h) => h.atMinutes));
    const forkedAt = new Date(t0Ms + (earliest - 1) * 60000).toISOString();
    const input = { mode, agentId, subject: patientRef, goal: body?.goal || scenario.summary?.slice(0, 200) || scenario.title, friction: body?.friction, parentBranch: 'main', forkedAt, study: body?.study, trigger: { kind: 'scenario', actor: ctx.actor.id, role: ctx.actor.role, at: nowIso, scenario: scenario.id }, ...(body?.condition ? { condition: body.condition } : {}), ...(body?.capabilities ? { capabilities: body.capabilities } : {}), ...(body?.askTimeoutMs ? { askTimeoutMs: body.askTimeoutMs } : {}), context: { scenario: scenario.title, scenarioId: scenario.id, patientRef } };
    if (mode === 'hitl') throw new HttpError(422, 'Run a scenario as a human session (no agent) or as an agent task. Helpers join a human session through the usual workflow events');
    // The subject must exist for createRun's checks only when it is on main; scenario patients live on the run branch, so create the run first and write the history onto its branch.
    const run = await createRun(store, { ...input, subject: null }, ctx.actor);
    const sim = newClock({ mode: clockMode, speed: body?.speed ?? scenario.speed, t0: nowIso, chapters: scenario.chapters || [], lengthMinutes: scenario.lengthMinutes });
    const timeline = events.map((e) => ({ id: e.id, at: new Date(t0Ms + e.at * 60000).toISOString(), atMinutes: e.at, kind: e.kind, title: e.label || e.kind, visibleTo: e.visibleTo, note: e.note, goal: e.goal || null, resources: e.resources, ...(e.kind === 'wearable-stream' ? { stream: e.stream, durationMinutes: e.durationMinutes, releasedUpTo: e.at } : {}), releasedAt: null, chapter: null }));
    await store.transaction(async (tx) => {
      for (const h of history) await tx.save(h.doc.resourceType, h.doc.resourceType === 'Patient' ? { ...h.doc, name: [{ family: `Patient ${h.doc.id.slice(0, 8)}` }], meta: { ...(h.doc.meta || {}), security: [HTEST] } } : { ...h.doc, _patient: patientRef }, { branch: run.branch, updatedBy: 'scenario', recordedAt: new Date(t0Ms + h.atMinutes * 60000).toISOString() });
      const current = await tx.get('Run', run.id);
      await tx.save('Run', { ...current, subject: patientRef, patientRef, scenario: { id: scenario.id, family: scenario.family, version: scenario.version, title: scenario.title }, sim, shiftMs: t0Ms - Date.parse(scenario.previewT0 || nowIso), timeline }, { updatedBy: 'system' });
      await recordAction(tx, { runId: run.id, actor: ctx.actor, kind: 'execute', action: 'scenario.start', args: { scenario: scenario.id, version: scenario.version, clock: clockMode, history: history.length, events: timeline.length, t0: nowIso }, branch: run.branch, entityRef: `Run/${run.id}`, patientRef, description: `scenario ${scenario.title} v${scenario.version} started (${clockMode} clock)` });
    });
    let fresh = await store.get('Run', run.id);
    // T0 events are in the chart from the start, and a chapters run opens on chapter one.
    await release(fresh, { actor: ctx.actor, chapter: sim.mode === 'chapters' ? 0 : null });
    fresh = await store.get('Run', run.id);
    if (agentId) {
      const agent = await store.get('Agent', agentId);
      if (!agent) throw new HttpError(404, `Agent "${agentId}" is not registered`);
      const done = agents.runScenarioAgent(fresh, agent);
      agents.track(done);
      if (body?.wait !== false) { await done; fresh = await store.get('Run', run.id); }
    }
    return { ...withStatus(fresh), branch: fresh.branch, patient: patientRef, open: `/ehr/?branch=${fresh.branch}#/chart/${patientRef.split('/')[1]}/summary` };
  }

  const visibleFor = (run, e) => e.visibleTo === 'everyone' || (run.agentId ? e.visibleTo === 'agent' : e.visibleTo === 'human');
  /** An event the actor's actions made impossible: a result for a cancelled order, a medication given after its order was stopped. */
  async function impossible(tx, run, e) {
    for (const r of e.resources) {
      const ref = (r.basedOn || [])[0]?.reference;
      if (ref && (r.resourceType === 'Observation' || r.resourceType === 'DiagnosticReport')) { const order = await tx.get(ref.split('/')[0], ref.split('/')[1], { branch: run.branch }); if (order && ['revoked', 'cancelled', 'entered-in-error'].includes(order.status)) return `${ref} was ${order.status}`; }
      if (r.resourceType === 'MedicationAdministration' && r.request?.reference) { const mr = await tx.get('MedicationRequest', r.request.reference.split('/')[1], { branch: run.branch }); if (mr && ['stopped', 'cancelled', 'entered-in-error'].includes(mr.status)) return `${r.request.reference} was ${mr.status}`; }
    }
    return null;
  }

  /** Releases every event due at the run's simulated time: written at that time (never earlier), skipped when impossible, batched for streams. Scheduled checks start agent turns when the run may continue. */
  async function release(run, { actor = system, chapter = null } = {}) {
    const current = await store.get('Run', run.id);
    if (!current?.sim || current.endedAt) return { released: [], skipped: [], turns: [] };
    const nowSim = simNow(current, store.now());
    const nowMinutes = simMinutes(current, store.now());
    const released = []; const skipped = []; const checks = [];
    const chapterIndex = chapter ?? current.sim.chapter ?? null;
    await store.transaction(async (tx) => {
      const timeline = current.timeline.map((e) => ({ ...e }));
      for (const e of timeline) {
        if (e.releasedAt || Date.parse(e.at) > Date.parse(nowSim)) continue;
        if (!visibleFor(current, e)) { e.releasedAt = nowSim; e.skipped = `not visible to the ${current.agentId ? 'agent' : 'human'}`; continue; }
        if (e.kind === 'wearable-stream') {
          const upTo = Math.min(e.atMinutes + e.durationMinutes, nowMinutes);
          if (upTo > e.releasedUpTo) {
            const sinceIso = new Date(Date.parse(current.sim.t0) + e.releasedUpTo * 60000).toISOString();
            const out = await writeStreamSlice(tx, { event: { ...e, at: e.atMinutes }, patientRef: current.patientRef, t0Ms: Date.parse(current.sim.t0), fromMinutes: e.releasedUpTo, toMinutes: upTo, branch: current.branch, runId: current.id });
            await recordAction(tx, { runId: current.id, actor, kind: 'create', action: 'timeline.release', args: { event: e.id, kind: e.kind, fromMinutes: e.releasedUpTo, toMinutes: upTo, readings: out.readings, episodes: out.episodes }, branch: current.branch, entityRef: `Run/${current.id}`, patientRef: current.patientRef, description: `wearable stream ${e.title}: ${out.readings} readings to T+${upTo}m` });
            e.releasedUpTo = upTo; released.push(e.id);
            if (rpm) await rpm.alertsFromReadings(tx, { patientRef: current.patientRef, branch: current.branch, run: current, since: sinceIso }).catch((err) => console.error('wearable alerts failed', err.message));
          }
          if (upTo >= e.atMinutes + e.durationMinutes) { e.releasedAt = nowSim; e.chapter = chapterIndex; }
          continue;
        }
        const why = await impossible(tx, current, e);
        if (why) { e.releasedAt = nowSim; e.skipped = why; e.chapter = chapterIndex; skipped.push(e.id); await recordAction(tx, { runId: current.id, actor, kind: 'execute', action: 'timeline.skip', args: { event: e.id, kind: e.kind, at: e.at, reason: why }, branch: current.branch, entityRef: `Run/${current.id}`, patientRef: current.patientRef, description: `timeline event ${e.title} skipped: ${why}` }); continue; }
        const refs = [];
        for (const doc of e.resources) {
          const saved = await tx.save(doc.resourceType, { ...doc, id: doc.id || randomUUID(), _patient: current.patientRef }, { branch: current.branch, updatedBy: 'scenario', recordedAt: e.at });
          refs.push({ ref: `${saved.resourceType}/${saved.id}`, versionId: saved.meta?.versionId });
        }
        e.releasedAt = nowSim; e.chapter = chapterIndex; e.refs = refs.map((r) => r.ref); released.push(e.id);
        await recordAction(tx, { runId: current.id, actor, kind: 'create', action: 'timeline.release', args: { event: e.id, kind: e.kind, at: e.at, title: e.title, visibleTo: e.visibleTo, resources: refs.length }, branch: current.branch, resources: refs, entityRef: refs[0]?.ref ?? `Run/${current.id}`, patientRef: current.patientRef, description: `timeline event released: ${e.title} (${e.kind})` });
        if (e.goal || e.kind === 'custom' && !e.resources.length) checks.push(e);
      }
      const latest = await tx.get('Run', current.id);
      await tx.save('Run', { ...latest, timeline }, { updatedBy: 'system' });
    });
    const turns = [];
    if (current.agentId && checks.length) {
      const agent = await store.get('Agent', current.agentId);
      for (const e of checks) {
        if (Array.isArray(current.capabilities) && !hasCap(current, 'long-horizon')) continue;
        const fresh = await store.get('Run', current.id);
        if (fresh.endedAt) break;
        turns.push(agents.turn(fresh, agent, { kind: 'scheduled-check', event: e.id, task: e.goal || e.title, at: nowSim }).catch(() => null));
      }
    }
    return { released, skipped, turns };
  }

  async function handle(req, url, body, ctx, parts) {
    const [area] = parts; const m = req.method;
    if (area === 'scenario-runs' && parts.length === 1 && m === 'POST') return { status: 201, body: await start(body, ctx) };
    return null;
  }
  return { handle, start, release, setRpm(api) { rpm = api; } };
}
