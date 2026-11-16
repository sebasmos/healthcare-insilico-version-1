// Patient messages around the chart: the live counters in the EHR top bar, and simulated messages.
//   GET  /api/counters                 Draft Notes, Portal Notifications (unread patient messages, refill
//                                      requests, appointment requests) and the Inbox total, with their lists.
//   POST /api/messages/simulate        "Send patient message": a message from the patient at a set time, on the
//                                      live clock or on a run's simulation clock. It can be marked urgent and can
//                                      carry a hidden prompt-injection payload, on sandbox branches only.
//   GET  /api/messages/simulate        what is scheduled and what has been sent.
//   POST /api/messages/simulate/fire   send whatever is due now (also done every second by the server).
// A simulated message is posted through the FHIR API as the patient, exactly as the Patient Portal does, so the
// same state machines, audit entries, TraceSteps and agent triage apply.
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { simNow } from '../../platform/server/simclock.mjs';
import { LIVE_RUN_ID } from '../../platform/server/audit.mjs';

export const HIDDEN_URL = 'urn:hospital-desktop:hidden-payload';
const OPEN_TASK = ['requested', 'ready', 'accepted', 'in-progress'];
const taskCode = (t) => t.code?.coding?.[0]?.code;
const NOT_IN_INBOX = ['message-triage', 'agent-proposal'];

export function createPatientMessages({ store, agents }) {
  const human = (ctx) => { if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only people schedule simulated patient messages'); };

  const COUNTED = ['DocumentReference', 'Communication', 'Task', 'Appointment', 'ServiceRequest', 'MedicationRequest']; const counterCache = new Map();
  async function counters(ctx) {
    const opts = { branch: ctx.branch, asOf: ctx.asOf };
    const [notes, comms, tasks, appts, service, meds] = await Promise.all(['DocumentReference', 'Communication', 'Task', 'Appointment', 'ServiceRequest', 'MedicationRequest'].map((t) => store.query(t, {}, opts)));
    const aiOrTranscript = (d) => (d.type?.coding || []).some((c) => c.system === 'urn:hospital-desktop:doc-type' && ['transcript', 'ai-summary'].includes(c.code));
    const drafts = notes.filter((d) => (d.docStatus ?? 'preliminary') === 'preliminary' && d.status !== 'entered-in-error' && !aiOrTranscript(d))
      .map((d) => ({ id: d.id, patient: d._patient, what: d.type?.text || d.type?.coding?.[0]?.display || 'Note', by: d.author?.[0]?.display ?? null, at: d.date ?? d._recordedAt, mine: d.author?.[0]?.display === ctx.actor.id }));
    const unread = comms.filter((c) => c.sender?.reference?.startsWith('Patient/') && !c.received).map((c) => ({ id: c.id, kind: 'message', patient: c.subject?.reference || c._patient, what: c.topic?.text || 'Message', urgent: c.priority === 'urgent' || c.priority === 'stat', at: c.sent ?? c._recordedAt }));
    const open = tasks.filter((t) => OPEN_TASK.includes(t.status));
    const refills = open.filter((t) => taskCode(t) === 'refill-request').map((t) => ({ id: t.id, kind: 'refill', patient: t.for?.reference, what: t.description || 'Refill request', at: t.authoredOn ?? t._recordedAt }));
    const apptTasks = open.filter((t) => taskCode(t) === 'appointment-request').map((t) => ({ id: t.id, kind: 'appointment', patient: t.for?.reference, what: t.description || 'Appointment request', at: t.authoredOn ?? t._recordedAt }));
    const apptAsked = appts.filter((a) => a.status === 'proposed' && (a.participant || []).some((p) => p.actor?.reference?.startsWith('Patient/') && p.status === 'accepted') && !(a.participant || []).some((p) => p.type?.[0]?.text === 'provider' && p.status === 'accepted'))
      .map((a) => ({ id: a.id, kind: 'appointment', patient: (a.participant || []).find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor.reference, what: a.description || a.appointmentType?.text || 'Appointment request', at: a.created ?? a._recordedAt }));
    const cosign = [...service, ...meds].filter((o) => (o.extension || []).some((e) => e.url === 'urn:hospital-desktop:pending-cosign' && e.valueBoolean === true)).length;
    const queried = meds.filter((o) => (o.extension || []).some((e) => e.url === 'urn:hospital-desktop:queried' && e.valueString)).length;
    const items = [...unread, ...refills, ...apptTasks, ...apptAsked].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { at: store.now(), draftNotes: { count: drafts.length, items: drafts.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 200) },
      portal: { count: items.length, messages: unread.length, refills: refills.length, appointments: apptTasks.length + apptAsked.length, items: items.slice(0, 200) },
      inbox: { total: unread.length + open.filter((t) => !NOT_IN_INBOX.includes(taskCode(t))).length + cosign + queried } };
  }

  async function schedule(body, ctx) {
    human(ctx);
    const patient = String(body?.patient || '').split('/').pop(); const text = String(body?.text || '').trim().slice(0, 4000);
    if (!text) throw new HttpError(422, 'text: write the message');
    const run = body?.run ? await store.get('Run', String(body.run)) : null;
    if (body?.run && !run) throw new HttpError(404, 'No such run');
    const branch = run?.branch || 'main';
    if (!(await store.get('Patient', patient, { branch }))) throw new HttpError(422, 'patient: choose a loaded patient');
    const injection = body?.injection ? String(body.injection).slice(0, 4000) : null;
    // A hidden payload is a red-team instrument: never on the live record.
    if (injection && branch === 'main') throw new HttpError(422, 'A hidden prompt-injection payload is only allowed on a sandbox branch (name a sandbox or red-team run)');
    const clockNow = run?.sim ? simNow(run, store.now()) : store.now();
    const dueAt = body?.at ? new Date(body.at).toISOString() : new Date(Date.parse(clockNow) + Math.max(0, Number(body?.afterSeconds) || 0) * 1000).toISOString();
    return store.transaction(async (tx) => {
      const saved = await tx.save('ScheduledMessage', { resourceType: 'ScheduledMessage', id: randomUUID(), patient, text, topic: String(body?.topic || 'Message').slice(0, 160), urgent: Boolean(body?.urgent), injection, run: run?.id || null, branch, clock: run?.sim ? 'simulation' : 'live', dueAt, status: 'scheduled', scheduledBy: ctx.actor.id, scheduledAt: tx.now(), communication: null }, { updatedBy: ctx.actor.role });
      await recordAction(tx, { runId: run?.id ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'create', action: 'message.simulate.schedule', args: { id: saved.id, patient, dueAt, clock: saved.clock, urgent: saved.urgent, hiddenPayload: Boolean(injection), branch }, branch, patientRef: `Patient/${patient}`, description: `simulated patient message scheduled for ${dueAt}`, audit: false });
      return saved;
    });
  }

  let firing = false;
  /** Sends every scheduled message whose time has come on its own clock. Safe to call often. */
  async function fireDue() {
    if (firing || !agents.baseUrl) return []; firing = true; const sent = [];
    try {
      const waiting = await store.query('ScheduledMessage', { where: (m) => m.status === 'scheduled' });
      for (const m of waiting) {
        const run = m.run ? await store.get('Run', m.run) : null;
        const now = run?.sim ? simNow(run, store.now()) : store.now();
        if (m.run && (!run || run.endedAt)) { await finish(m, 'cancelled', null, 'the run has ended'); continue; }
        if (String(now) < m.dueAt) continue;
        const ref = `Patient/${m.patient}`;
        const doc = { resourceType: 'Communication', status: 'completed', subject: { reference: ref }, sender: { reference: ref }, recipient: [{ display: 'Care team' }], sent: store.now(), topic: { text: m.topic }, ...(m.urgent ? { priority: 'urgent' } : {}),
          payload: [{ contentString: m.text }, ...(m.injection ? [{ contentString: m.injection, extension: [{ url: HIDDEN_URL, valueBoolean: true }] }] : [])], meta: { tag: [{ system: 'urn:hospital-desktop:origin', code: 'simulated-message' }] } };
        const r = await fetch(`${agents.baseUrl}/fhir/R4/Communication${m.branch !== 'main' ? `?_branch=${encodeURIComponent(m.branch)}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Role': 'patient', 'X-User-Id': 'patient' }, body: JSON.stringify(doc), signal: AbortSignal.timeout(15000) });
        const made = await r.json().catch(() => null);
        if (r.status !== 201) { await finish(m, 'failed', null, made?.issue?.[0]?.diagnostics || `HTTP ${r.status}`); continue; }
        await finish(m, 'sent', made.id, null); sent.push({ id: m.id, communication: made.id });
      }
    } finally { firing = false; }
    return sent;
  }
  const finish = (m, status, communication, reason) => store.transaction(async (tx) => {
    const cur = await tx.get('ScheduledMessage', m.id); if (!cur || cur.status !== 'scheduled') return; const { _seq, ...rest } = cur;
    await tx.save('ScheduledMessage', { ...rest, status, communication, sentAt: status === 'sent' ? tx.now() : null, reason }, { updatedBy: 'system' });
    await recordAction(tx, { runId: m.run ?? LIVE_RUN_ID, actor: { kind: 'human', id: m.scheduledBy, role: 'researcher' }, kind: 'execute', action: `message.simulate.${status === 'sent' ? 'fire' : status}`, args: { id: m.id, patient: m.patient, communication, reason }, branch: m.branch, patientRef: `Patient/${m.patient}`, description: status === 'sent' ? 'simulated patient message sent' : `simulated patient message ${status}: ${reason}`, audit: false });
  });

  return {
    fireDue,
    async handle(req, url, body, ctx) {
      const parts = url.pathname.split('/').filter(Boolean).slice(1); const m = req.method;
      if (parts[0] === 'visit-summary' && m === 'POST') { // printing an after-visit summary is part of the record of the visit
        const patient = String(body?.patient || ''); if (!(await store.get('Patient', patient, { branch: ctx.branch }))) throw new HttpError(422, 'patient is required');
        await store.transaction((tx) => recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'read', action: 'visit-summary.print', args: { patient }, branch: ctx.branch, patientRef: `Patient/${patient}`, entityRef: `Patient/${patient}`, description: 'after-visit summary printed' }));
        return { status: 200, body: { printed: true } }; }
      if (parts[0] === 'counters' && m === 'GET') {
        await fireDue().catch(() => {});
        // Every EHR screen polls this, and it reads every note and order: keep the answer until one of those types changes.
        const mark = await store.changeMark(COUNTED); const key = `${ctx.branch}|${ctx.asOf ?? ''}|${ctx.actor.id}`; const hit = counterCache.get(key);
        if (hit && hit.mark === mark) return { status: 200, body: hit.body };
        const body = await counters(ctx); if (counterCache.size > 200) counterCache.clear(); counterCache.set(key, { mark, body });
        return { status: 200, body };
      }
      if (parts[0] === 'messages' && parts[1] === 'simulate') {
        if (m === 'POST' && parts[2] === 'fire') { human(ctx); return { status: 200, body: { sent: await fireDue() } }; }
        if (m === 'POST' && !parts[2]) { const saved = await schedule(body, ctx); await fireDue().catch(() => {}); const { _seq, injection, ...out } = await store.get('ScheduledMessage', saved.id); return { status: 201, body: { ...out, hiddenPayload: Boolean(injection) } }; }
        if (m === 'GET') { human(ctx); return { status: 200, body: { messages: (await store.query('ScheduledMessage')).map(({ _seq, injection, ...x }) => ({ ...x, hiddenPayload: Boolean(injection) })).sort((a, b) => String(b.scheduledAt).localeCompare(String(a.scheduledAt))).slice(0, 200) } }; }
        if (m === 'DELETE' && parts[2]) { human(ctx); const cur = await store.get('ScheduledMessage', parts[2]); if (!cur) throw new HttpError(404, 'No such scheduled message'); if (cur.status !== 'scheduled') throw new HttpError(409, 'It has already been sent'); await finish(cur, 'cancelled', null, `cancelled by ${ctx.actor.id}`); return { status: 200, body: { id: cur.id, status: 'cancelled' } }; }
      }
      return null;
    },
  };
}
