// /api/pharmacy/**: verification queue, review lock, automatic checks as
// DetectedIssues, the pharmacist's decision, prescriber answers, the
// emergency override, dispensing, label data and the ward view.
// Every clinical write goes through fhir.writeInTx inside one transaction, so
// the state machine, the role map, the safety checks and the log all apply.
import { HttpError } from '../../platform/server/http.mjs';
import { enforcedFor, mayWrite, assertMayWrite, refusal } from '../../platform/server/roles.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';
import { stripInternal } from '../../platform/server/fhir-api.mjs';
import { MACHINES, lifecycleOf, withExtension, REASON_URL, CHECKED_BY_URL } from '../../platform/server/state-machines.mjs';
import { mrnOf } from '../../ehr/server/clinical-rules.mjs';
import { FREQUENCIES, ROUTES, isControlled } from '../../ehr/server/catalog.mjs';
import {
  PHARMACY_URLS, TARGET_MINUTES, PRIORITIES, priorityOf, isVerified, emergencyOverride, verifiedBy, queriedOf, verificationState,
  reviewContext, runChecks, detectedIssue, rxOf, medName, doseOf, routeOf, frequencyOf, inpatientEncounter, unitOf,
} from './pharmacy.mjs';

export const LOT_URL = 'urn:hospital-desktop:lot';
export const EXPIRY_URL = 'urn:hospital-desktop:expiry';
export const TASK_SYSTEM = 'urn:hospital-desktop:task';
export const COMM_SYSTEM = 'urn:hospital-desktop:communication';
const DECISIONS = ['verify', 'verify-with-change', 'reject', 'query'];
const LOCK_MINUTES = 30;
const OPEN_DISPENSE = ['preparation', 'in-progress', 'on-hold'];
const lockOf = (order, now) => (order._lock && Date.parse(now) - Date.parse(order._lock.at) < LOCK_MINUTES * 60000 ? order._lock : null);
const minutesBetween = (from, to) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60000));
const patientRow = (p) => (p ? { id: p.id, name: `${p.name?.[0]?.family || ''}`.replace(/^, /, ''), mrn: mrnOf(p), birthDate: p.birthDate || '', gender: p.gender || '' } : null);
const sigOf = (order) => order.dosageInstruction?.[0]?.text || '';
const priorityRank = { stat: 0, urgent: 1, routine: 2 };
const text = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function createPharmacyApi({ store, fhir }) {
  const log = (tx, ctx, fields) => recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, branch: ctx.branch, ...fields, why: fields.why ?? ctx.why ?? null });
  const writable = (ctx) => { if (ctx.asOf) throw new HttpError(409, 'Writes are disabled while viewing a past time'); };
  const opts = (ctx) => ({ branch: ctx.branch, asOf: ctx.asOf });

  async function loadPatients(ctx, orders) {
    const refs = new Set(orders.map((o) => o.subject?.reference));
    const [patients, encounters] = await Promise.all([store.query('Patient', { where: (p) => refs.has(`Patient/${p.id}`) }, opts(ctx)), store.query('Encounter', { where: (e) => refs.has(e.subject?.reference) }, opts(ctx))]);
    const byRef = new Map(patients.map((p) => [`Patient/${p.id}`, p]));
    const unitByRef = new Map();
    for (const ref of refs) unitByRef.set(ref, inpatientEncounter(encounters.filter((e) => e.subject?.reference === ref)));
    return { patient: (ref) => byRef.get(ref) || null, encounter: (ref) => unitByRef.get(ref) || null };
  }

  function queueRow(order, who, now) {
    const priority = priorityOf(order);
    const since = order.authoredOn || order._recordedAt;
    const minutes = minutesBetween(since, now);
    const enc = who.encounter(order.subject?.reference);
    return {
      id: order.id, patient: { ...patientRow(who.patient(order.subject?.reference)), unit: enc ? unitOf(enc) : 'No unit assigned', setting: enc ? 'inpatient' : 'outpatient' },
      medication: medName(order), code: rxOf(order)?.code ?? null, dose: doseOf(order), route: routeOf(order), frequency: frequencyOf(order), sig: sigOf(order),
      prescriber: order.requester?.display || '', priority, authoredOn: since, ageMinutes: minutes, targetMinutes: TARGET_MINUTES[priority], overTarget: minutes > TARGET_MINUTES[priority],
      state: verificationState(order), queried: queriedOf(order), override: emergencyOverride(order), lock: lockOf(order, now),
      orderMode: (order.extension || []).find((e) => e.url === 'urn:hospital-desktop:order-mode')?.valueCode ?? null,
      pendingCosign: (order.extension || []).some((e) => e.url === 'urn:hospital-desktop:pending-cosign' && e.valueBoolean === true),
    };
  }

  /** Metrics for the day from the pharmacy.* steps in the log: verified today, turnaround by priority, share within target, interventions. */
  async function metrics(ctx, now) {
    const today = now.slice(0, 10);
    const steps = await store.query('TraceStep', { where: (t) => String(t.did?.type || '').startsWith('pharmacy.') && String(t.when?.wall || '').startsWith(today) && (t.saw?.branch || 'main') === ctx.branch });
    const verified = steps.filter((t) => ['pharmacy.verify', 'pharmacy.verify-change'].includes(t.did.type));
    const by = Object.fromEntries(PRIORITIES.map((p) => {
      const list = verified.filter((t) => t.did.args?.priority === p && typeof t.did.args?.minutes === 'number');
      return [p, { count: list.length, meanMinutes: list.length ? Math.round(list.reduce((n, t) => n + t.did.args.minutes, 0) / list.length) : null, target: TARGET_MINUTES[p] }];
    }));
    const timed = verified.filter((t) => typeof t.did.args?.minutes === 'number');
    const within = timed.filter((t) => t.did.args.minutes <= TARGET_MINUTES[t.did.args.priority || 'routine']).length;
    const count = (type) => steps.filter((t) => t.did.type === type).length;
    return {
      verifiedToday: verified.length, byPriority: by, withinTargetPercent: timed.length ? Math.round((within / timed.length) * 100) : null,
      interventions: { changed: count('pharmacy.verify-change'), rejected: count('pharmacy.reject'), queried: count('pharmacy.query'), total: count('pharmacy.verify-change') + count('pharmacy.reject') + count('pharmacy.query') },
    };
  }

  async function queue(ctx, url) {
    const now = ctx.asOf ?? store.now();
    const me = ctx.actor.id;
    const orders = await store.query('MedicationRequest', { where: (o) => lifecycleOf(o) === 'pending-verification' }, opts(ctx));
    const who = await loadPatients(ctx, orders);
    const rows = orders.map((o) => queueRow(o, who, now)).sort((a, b) => Number(Boolean(b.override)) - Number(Boolean(a.override)) || priorityRank[a.priority] - priorityRank[b.priority] || String(a.authoredOn).localeCompare(String(b.authoredOn)));
    const mine = rows.filter((r) => !r.lock || r.lock.by === me);
    const which = url.searchParams.get('queue') === 'all' ? rows : mine;
    return { status: 200, body: { now, me, rows: which, counts: { my: mine.length, all: rows.length }, metrics: await metrics(ctx, now) } };
  }

  async function getOrder(tx, id, ctx) {
    const order = await tx.get('MedicationRequest', id, { branch: ctx.branch, asOf: ctx.asOf });
    if (!order) throw new HttpError(404, `MedicationRequest/${id} not found`, 'not-found');
    return order;
  }

  // Opening an order locks it to this pharmacist, like the PACS reading lock. A role that may not verify opens it without a lock.
  async function lock(id, ctx, body, close) {
    writable(ctx);
    const me = ctx.actor.id;
    const readOnly = enforcedFor(ctx) && !mayWrite(ctx.actor.role, 'MedicationRequest', 'verify');
    const result = await store.transaction(async (tx) => {
      const order = await getOrder(tx, id, ctx);
      const now = tx.now();
      const held = lockOf(order, now);
      const { _seq, ...doc } = order;
      if (readOnly) return { lock: held, readOnly: true };
      if (close) {
        if (held?.by !== me) return { lock: held };
        delete doc._lock;
        await tx.save('MedicationRequest', doc, { branch: ctx.branch, updatedBy: ctx.actor.role });
        await log(tx, ctx, { kind: 'execute', action: 'pharmacy.unlock', args: { order: id }, entityRef: `MedicationRequest/${id}`, patientRef: order._patient, description: `review lock released on MedicationRequest/${id}` });
        return { lock: null };
      }
      if (held && held.by !== me && !body?.force) return { lock: held, locked: true };
      const next = { by: me, role: ctx.actor.role, at: now };
      await tx.save('MedicationRequest', { ...doc, _lock: next }, { branch: ctx.branch, updatedBy: ctx.actor.role });
      await log(tx, ctx, { kind: 'read', action: 'pharmacy.open', args: { order: id, tookOver: held && held.by !== me ? held.by : null }, resources: [{ ref: `MedicationRequest/${id}`, versionId: order.meta.versionId }], entityRef: `MedicationRequest/${id}`, patientRef: order._patient, description: `order opened for verification: MedicationRequest/${id}` });
      return { lock: next };
    });
    return { status: result.locked ? 423 : 200, body: result };
  }

  const issuesFor = (issues, id) => issues.filter((i) => (i.implicated || []).some((x) => x.reference === `MedicationRequest/${id}`)).sort((a, b) => String(a.identifiedDateTime).localeCompare(String(b.identifiedDateTime)));
  const issueRow = (i) => ({ id: i.id, code: i.code?.coding?.[0]?.code, severity: i.severity, detail: i.detail, status: i.status, implicated: (i.implicated || []).map((x) => x.reference), identifiedAt: i.identifiedDateTime, mitigation: i.mitigation?.[0]?.action?.text || null });

  // The review: the order beside the chart facts, with the automatic checks run now and stored as DetectedIssues (once per finding).
  async function review(id, ctx) {
    const now = ctx.asOf ?? store.now();
    const canStore = !ctx.asOf && ctx.actor.kind === 'human' && (!enforcedFor(ctx) || mayWrite(ctx.actor.role, 'DetectedIssue', 'create'));
    const out = await store.transaction(async (tx) => {
      const order = await getOrder(tx, id, ctx);
      const context = await reviewContext(tx, order, { ...opts(ctx), now });
      const findings = lifecycleOf(order) === 'pending-verification' ? await runChecks(tx, order, context, ctx.branch) : [];
      let issues = issuesFor(await tx.query('DetectedIssue', { patient: order.subject?.reference }, opts(ctx)), id);
      const known = new Set(issues.map((i) => `${i.code?.coding?.[0]?.code}|${i.detail}`));
      const fresh = findings.filter((f) => !known.has(`${f.code}|${f.detail}`));
      if (canStore && fresh.length) {
        for (const f of fresh) issues.push((await fhir.writeInTx(tx, 'DetectedIssue', null, detectedIssue(order, f, now), ctx, { action: 'pharmacy.check' })).saved);
        issues = issuesFor(issues, id);
      }
      const unstored = canStore ? [] : fresh.map((f, i) => ({ id: `unsaved-${i}`, code: f.code, severity: f.severity, detail: f.detail, status: 'preliminary', implicated: f.implicated, identifiedAt: now, mitigation: null, unsaved: true }));
      const [comms, proposals] = await Promise.all([
        tx.query('Communication', { patient: order.subject?.reference, where: (c) => c.topic?.text === `MedicationRequest/${id}` }, opts(ctx)),
        tx.query('Task', { patient: order.subject?.reference, where: (t) => t.code?.coding?.[0]?.code === 'prescriber-notice' && t.focus?.reference === `MedicationRequest/${id}` }, opts(ctx)),
      ]);
      const who = { patient: () => context.patient, encounter: () => (context.encounter ? { location: [{ location: { display: context.encounter.unit } }] } : null) };
      return {
        now, order: stripInternal(order), row: queueRow(order, who, now), lock: lockOf(order, now), state: verificationState(order), verified: verifiedBy(order), override: emergencyOverride(order),
        note: (order.extension || []).find((e) => e.url === PHARMACY_URLS.note)?.valueString ?? null, rejection: lifecycleOf(order) === 'rejected' ? (order.extension || []).find((e) => e.url === REASON_URL)?.valueString ?? null : null,
        patient: patientRow(context.patient), age: context.age, allergies: context.allergies.map(stripInternal), currentMeds: context.currentMeds.map(stripInternal),
        weight: context.weight, creatinine: context.creatinine, egfr: context.egfr, labs: context.labs, labNames: context.labNames, encounter: context.encounter, setting: context.setting,
        issues: [...issues.map(issueRow), ...unstored], issuesStored: canStore,
        thread: comms.map(stripInternal).sort((a, b) => String(a.sent).localeCompare(String(b.sent))), notices: proposals.map(stripInternal),
        tables: { unverified: true, note: 'Unverified starter tables: the interaction, dose range and route tables are a small hand-entered set for this simulation, not clinical reference.' },
      };
    });
    return { status: 200, body: out };
  }

  const describeChange = (change) => Object.entries(change).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k} ${v}`).join(', ');

  function applyChange(order, change) {
    const d = { ...(order.dosageInstruction?.[0] || {}) };
    const dose = { ...(d.doseAndRate?.[0]?.doseQuantity || {}) };
    if (change.dose != null) { if (typeof change.dose !== 'number' || change.dose <= 0) throw new HttpError(422, 'change.dose must be a positive number'); dose.value = change.dose; }
    if (change.unit) dose.unit = text(change.unit, 20);
    if (change.route) d.route = { text: text(change.route, 40) };
    if (change.frequency) d.timing = { ...(d.timing || {}), code: { text: text(change.frequency, 20) } };
    d.doseAndRate = [{ ...(d.doseAndRate?.[0] || {}), doseQuantity: dose }];
    const route = d.route?.text || '';
    const freq = d.timing?.code?.text || '';
    d.text = [dose.value != null ? `${dose.value} ${dose.unit || ''}`.trim() : null, ROUTES[route] || route, FREQUENCIES[freq] || freq, d.asNeededBoolean ? 'as needed' : null].filter(Boolean).join(' ');
    return { ...order, dosageInstruction: [d, ...(order.dosageInstruction || []).slice(1)] };
  }

  // The pharmacist's decision: one transaction for the order, its DetectedIssues, the prescriber's Task or Communication and the log.
  async function decide(id, body, ctx) {
    writable(ctx);
    const decision = body?.decision;
    if (!DECISIONS.includes(decision)) throw new HttpError(422, `decision must be one of ${DECISIONS.join(', ')}`);
    const reasoning = text(body?.reasoning);
    if (reasoning.length < 3) throw new HttpError(422, 'reasoning is required (at least 3 characters): the pharmacist\'s reasoning is part of the log');
    if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only a person may verify, reject or query a medication order. An agent may propose a decision through a proposal.', 'forbidden');
    if (enforcedFor(ctx)) assertMayWrite(ctx.actor.role, 'MedicationRequest', 'verify');
    const change = decision === 'verify-with-change' ? (body?.change && typeof body.change === 'object' ? body.change : null) : null;
    if (decision === 'verify-with-change' && (!change || !describeChange(change))) throw new HttpError(422, 'verify-with-change needs change: { dose, unit, route, frequency } with at least one field');
    const reason = decision === 'reject' ? text(body?.reason, 500) : null;
    if (decision === 'reject' && reason.length < 3) throw new HttpError(422, 'reason is required to reject an order');
    const message = decision === 'query' ? text(body?.message) : null;
    if (decision === 'query' && message.length < 3) throw new HttpError(422, 'message is required to query the prescriber');
    const action = { verify: 'pharmacy.verify', 'verify-with-change': 'pharmacy.verify-change', reject: 'pharmacy.reject', query: 'pharmacy.query' }[decision];

    const result = await store.transaction(async (tx) => {
      const order = await getOrder(tx, id, ctx);
      if (lifecycleOf(order) !== 'pending-verification') throw new HttpError(409, `This order is ${lifecycleOf(order)}, not waiting for verification`, 'business-rule');
      if (decision === 'query' && queriedOf(order)) throw new HttpError(409, 'This order already has an open question to the prescriber', 'business-rule');
      const now = tx.now();
      const versions = await tx.history('MedicationRequest', id, { branch: ctx.branch });
      const since = order.authoredOn || versions[0]?._recordedAt || order._recordedAt;
      const minutes = minutesBetween(since, now);
      const priority = priorityOf(order);
      const stamp = `${ctx.actor.id} at ${now}`;
      let next = stripInternal({ ...order });
      next = withExtension(next, PHARMACY_URLS.note, 'valueString', reasoning);
      if (decision === 'query') {
        next = withExtension(next, PHARMACY_URLS.queried, 'valueString', message);
      } else {
        next = withExtension(next, PHARMACY_URLS.queried, 'valueString', null);
        if (decision === 'reject') next = withExtension(MACHINES.MedicationRequest.set(next, 'rejected'), REASON_URL, 'valueString', reason);
        else {
          if (change) next = applyChange(next, change);
          next = withExtension(MACHINES.MedicationRequest.set(next, 'active'), PHARMACY_URLS.verified, 'valueString', stamp);
        }
      }
      const { saved } = await fhir.writeInTx(tx, 'MedicationRequest', id, next, ctx, { pharmacy: true, unlock: decision !== 'query' });
      // The automatic checks are closed with the decision as their outcome.
      const issues = issuesFor(await tx.query('DetectedIssue', { patient: order.subject?.reference, where: (i) => i.status === 'preliminary' }, { branch: ctx.branch }), id);
      if (decision !== 'query') {
        for (const issue of issues) {
          const closed = { ...stripInternal(issue), status: 'final', mitigation: [{ action: { text: `${decision}: ${reasoning}`.slice(0, 500) }, date: now, author: { display: ctx.actor.id } }] };
          await fhir.writeInTx(tx, 'DetectedIssue', issue.id, closed, ctx, { action: 'pharmacy.check.close' });
        }
      }
      const drug = medName(order);
      const patientRef = order.subject;
      const prescriber = order.requester?.display || 'Prescriber';
      let notice = null;
      if (decision === 'verify-with-change' || decision === 'reject') {
        notice = (await fhir.writeInTx(tx, 'Task', null, {
          resourceType: 'Task', status: 'requested', intent: 'order', authoredOn: now, for: patientRef, focus: { reference: `MedicationRequest/${id}` },
          code: { coding: [{ system: TASK_SYSTEM, code: 'prescriber-notice' }], text: decision === 'reject' ? 'Pharmacy rejected an order' : 'Pharmacy verified with a change' },
          description: decision === 'reject' ? `${drug}: rejected. ${reason}. ${reasoning}` : `${drug}: verified with change (${describeChange(change)}). ${reasoning}`,
          owner: { display: prescriber }, requester: { display: ctx.actor.id },
        }, ctx, { action: 'pharmacy.notice' })).saved;
      }
      let communication = null;
      if (decision === 'query') {
        communication = (await fhir.writeInTx(tx, 'Communication', null, {
          resourceType: 'Communication', status: 'completed', category: [{ coding: [{ system: COMM_SYSTEM, code: 'pharmacy-query' }] }], subject: patientRef, sent: now,
          topic: { text: `MedicationRequest/${id}` }, about: [{ reference: `MedicationRequest/${id}` }], sender: { display: ctx.actor.id }, recipient: [{ display: prescriber }],
          payload: [{ contentString: message }],
        }, ctx, { action: 'pharmacy.query.send' })).saved;
      }
      await log(tx, ctx, {
        kind: 'execute', action, why: reasoning,
        args: { order: `MedicationRequest/${id}`, decision, priority, minutes, target: TARGET_MINUTES[priority], withinTarget: minutes <= TARGET_MINUTES[priority], change: change || null, reason, issues: issues.map((i) => i.code?.coding?.[0]?.code), notice: notice ? `Task/${notice.id}` : null, communication: communication ? `Communication/${communication.id}` : null },
        resources: [{ ref: `MedicationRequest/${id}`, versionId: order.meta.versionId }], entityRef: `MedicationRequest/${id}`, versionId: saved.meta.versionId, patientRef: order._patient,
        description: `${decision} ${drug} (MedicationRequest/${id}) after ${minutes} min: ${reasoning.slice(0, 120)}`,
      });
      return { order: stripInternal(saved), state: verificationState(saved), minutes, issues: issues.length, notice: notice ? stripInternal(notice) : null, communication: communication ? stripInternal(communication) : null };
    });
    return { status: 200, body: result };
  }

  // The prescriber answers a pharmacy query: a reply Communication in the thread; the order is no longer flagged as queried.
  async function answer(id, body, ctx) {
    writable(ctx);
    const message = text(body?.message);
    if (message.length < 3) throw new HttpError(422, 'message is required');
    if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only a person may answer a pharmacy query', 'forbidden');
    // The prescriber's side answers: a role that places medication orders (outright or as a verbal order), never the pharmacist asking.
    if (enforcedFor(ctx)) {
      if (!(mayWrite(ctx.actor.role, 'MedicationRequest', 'create') || mayWrite(ctx.actor.role, 'MedicationRequest', 'create', { orderMode: true }))) throw refusal(ctx.actor.role, 'MedicationRequest', 'create');
      assertMayWrite(ctx.actor.role, 'Communication', 'create');
    }
    const result = await store.transaction(async (tx) => {
      const order = await getOrder(tx, id, ctx);
      const question = queriedOf(order);
      if (!question) throw new HttpError(409, 'This order has no open question from pharmacy', 'business-rule');
      const now = tx.now();
      const thread = (await tx.query('Communication', { patient: order.subject?.reference, where: (c) => c.topic?.text === `MedicationRequest/${id}` }, { branch: ctx.branch })).sort((a, b) => String(a.sent).localeCompare(String(b.sent)));
      const last = [...thread].reverse().find((c) => c.category?.[0]?.coding?.[0]?.code === 'pharmacy-query') || null;
      const reply = (await fhir.writeInTx(tx, 'Communication', null, {
        resourceType: 'Communication', status: 'completed', category: [{ coding: [{ system: COMM_SYSTEM, code: 'pharmacy-answer' }] }], subject: order.subject, sent: now,
        topic: { text: `MedicationRequest/${id}` }, about: [{ reference: `MedicationRequest/${id}` }], sender: { display: ctx.actor.id }, recipient: [{ display: last?.sender?.display || 'Pharmacy' }],
        ...(last ? { inResponseTo: [{ reference: `Communication/${last.id}` }] } : {}), payload: [{ contentString: message }],
      }, ctx, { action: 'pharmacy.answer.send' })).saved;
      const next = withExtension(stripInternal({ ...order }), PHARMACY_URLS.queried, 'valueString', null);
      const { saved } = await fhir.writeInTx(tx, 'MedicationRequest', id, next, ctx, { pharmacy: true });
      await log(tx, ctx, {
        kind: 'execute', action: 'pharmacy.answer', why: message, args: { order: `MedicationRequest/${id}`, question, communication: `Communication/${reply.id}` },
        entityRef: `MedicationRequest/${id}`, versionId: saved.meta.versionId, patientRef: order._patient, description: `prescriber answered pharmacy about ${medName(order)}: ${message.slice(0, 120)}`,
      });
      return { order: stripInternal(saved), reply: stripInternal(reply) };
    });
    return { status: 200, body: result };
  }

  // A nurse (or physician) gives a STAT dose before verification: logged as a safety override; the order stays in the queue, at the top.
  async function override(id, body, ctx) {
    writable(ctx);
    const reason = text(body?.reason, 500);
    if (reason.length < 3) throw new HttpError(422, 'reason is required for an emergency override');
    if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only a person may record an emergency override', 'forbidden');
    // Who may: roles that give medications (MedicationAdministration create) or prescribe (MedicationRequest create); the map decides, not a role name.
    if (enforcedFor(ctx) && !(mayWrite(ctx.actor.role, 'MedicationAdministration', 'create') || mayWrite(ctx.actor.role, 'MedicationRequest', 'create'))) throw refusal(ctx.actor.role, 'MedicationAdministration', 'create');
    const result = await store.transaction(async (tx) => {
      const order = await getOrder(tx, id, ctx);
      if (lifecycleOf(order) !== 'pending-verification') throw new HttpError(409, `This order is ${lifecycleOf(order)}, not waiting for verification`, 'business-rule');
      if (priorityOf(order) !== 'stat') throw new HttpError(422, 'An emergency override applies to STAT orders only; routine and urgent orders wait for pharmacy', 'business-rule');
      if (emergencyOverride(order)) throw new HttpError(409, 'An emergency override is already recorded on this order', 'business-rule');
      const now = tx.now();
      const next = withExtension(stripInternal({ ...order }), PHARMACY_URLS.override, 'valueString', `${ctx.actor.id} (${ctx.actor.role}) at ${now}: ${reason}`);
      const { saved } = await fhir.writeInTx(tx, 'MedicationRequest', id, next, ctx, { pharmacy: true });
      await log(tx, ctx, {
        kind: 'execute', action: 'safety.override', why: reason, args: { alert: 'unverified-stat', order: `MedicationRequest/${id}`, priority: 'stat' },
        entityRef: `MedicationRequest/${id}`, versionId: saved.meta.versionId, patientRef: order._patient, description: `safety override (unverified-stat) on MedicationRequest/${id}: ${reason}`,
      });
      return { order: stripInternal(saved), override: emergencyOverride(saved) };
    });
    return { status: 200, body: result };
  }

  // ---------- Dispensing ----------
  const dispenseRow = (d, order, who, now) => ({
    id: d.id, status: d.status, orderId: order?.id ?? null, patient: order ? { ...patientRow(who.patient(order.subject?.reference)), unit: who.encounter(order.subject?.reference) ? unitOf(who.encounter(order.subject?.reference)) : 'No unit assigned' } : patientRow(who.patient(d.subject?.reference)),
    medication: medName(d), code: rxOf(d)?.code ?? null, sig: order ? sigOf(order) : d.dosageInstruction?.[0]?.text || '', controlled: isControlled(rxOf(d)?.code),
    quantity: d.quantity ?? null, daysSupply: d.daysSupply ?? null, lot: (d.extension || []).find((e) => e.url === LOT_URL)?.valueString ?? null, expiry: (d.extension || []).find((e) => e.url === EXPIRY_URL)?.valueString ?? null,
    filledBy: d.performer?.[0]?.actor?.display ?? null, checkedBy: (d.extension || []).find((e) => e.url === CHECKED_BY_URL)?.valueString ?? null,
    preparedAt: d.whenPrepared ?? null, handedOverAt: d.whenHandedOver ?? null, reason: (d.extension || []).find((e) => e.url === REASON_URL)?.valueString ?? null, ageMinutes: minutesBetween(d.whenPrepared || d._recordedAt, now),
  });

  async function dispenseQueue(ctx, url) {
    const now = ctx.asOf ?? store.now();
    const setting = url.searchParams.get('setting') || 'inpatient';
    const [orders, dispenses] = await Promise.all([store.query('MedicationRequest', { where: (o) => lifecycleOf(o) === 'active' && isVerified(o) }, opts(ctx)), store.query('MedicationDispense', {}, opts(ctx))]);
    const who = await loadPatients(ctx, [...orders, ...dispenses]);
    const byOrder = new Map();
    for (const d of dispenses) for (const ref of (d.authorizingPrescription || []).map((x) => x.reference)) byOrder.set(ref, [...(byOrder.get(ref) || []), d]);
    const orderById = new Map(orders.map((o) => [o.id, o]));
    const toFill = orders.filter((o) => setting === 'all' || who.encounter(o.subject?.reference)).filter((o) => !(byOrder.get(`MedicationRequest/${o.id}`) || []).some((d) => OPEN_DISPENSE.includes(d.status) || d.status === 'completed'))
      .map((o) => ({ ...queueRow(o, who, now), verified: verifiedBy(o), controlled: isControlled(rxOf(o)?.code) }))
      .sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || String(a.verified?.at || a.authoredOn).localeCompare(String(b.verified?.at || b.authoredOn)));
    const inProgress = dispenses.filter((d) => OPEN_DISPENSE.includes(d.status)).map((d) => dispenseRow(d, orderById.get((d.authorizingPrescription?.[0]?.reference || '').split('/')[1]) || null, who, now));
    const recent = dispenses.filter((d) => d.status === 'completed').map((d) => dispenseRow(d, orderById.get((d.authorizingPrescription?.[0]?.reference || '').split('/')[1]) || null, who, now)).sort((a, b) => String(b.handedOverAt).localeCompare(String(a.handedOverAt))).slice(0, 50);
    return { status: 200, body: { now, setting, toFill, inProgress, recent } };
  }

  async function startDispense(body, ctx) {
    writable(ctx);
    const orderId = text(body?.orderId, 64);
    if (!orderId) throw new HttpError(422, 'orderId is required');
    if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only a person may dispense', 'forbidden');
    if (enforcedFor(ctx)) assertMayWrite(ctx.actor.role, 'MedicationDispense', 'create');
    const result = await store.transaction(async (tx) => {
      const order = await getOrder(tx, orderId, ctx);
      if (lifecycleOf(order) !== 'active' || !isVerified(order)) throw new HttpError(409, 'Only a verified, active order can be dispensed', 'business-rule');
      const open = (await tx.query('MedicationDispense', { patient: order.subject?.reference }, { branch: ctx.branch })).filter((d) => (d.authorizingPrescription || []).some((x) => x.reference === `MedicationRequest/${orderId}`) && (OPEN_DISPENSE.includes(d.status) || d.status === 'completed'));
      if (open.length) throw new HttpError(409, `This order already has a dispense (${open[0].status}): MedicationDispense/${open[0].id}`, 'business-rule');
      const now = tx.now();
      const doc = {
        resourceType: 'MedicationDispense', status: 'preparation', subject: order.subject, medicationCodeableConcept: order.medicationCodeableConcept,
        authorizingPrescription: [{ reference: `MedicationRequest/${orderId}` }], ...(order.encounter ? { context: order.encounter } : {}), whenPrepared: now,
        performer: [{ actor: { display: ctx.actor.id } }], dosageInstruction: order.dosageInstruction,
        ...(typeof body.quantity === 'number' && body.quantity > 0 ? { quantity: { value: body.quantity, unit: text(body.quantityUnit, 20) || doseOf(order)?.unit || 'dose' } } : {}),
        ...(typeof body.daysSupply === 'number' && body.daysSupply > 0 ? { daysSupply: { value: body.daysSupply, unit: 'd' } } : {}),
        extension: [text(body.lot, 64) ? { url: LOT_URL, valueString: text(body.lot, 64) } : null, text(body.expiry, 20) ? { url: EXPIRY_URL, valueString: text(body.expiry, 20) } : null].filter(Boolean),
      };
      if (!doc.extension.length) delete doc.extension;
      const { saved } = await fhir.writeInTx(tx, 'MedicationDispense', null, doc, ctx, { action: 'pharmacy.dispense' });
      return stripInternal(saved);
    });
    return { status: 201, body: result };
  }

  // Fill and complete: lot, expiry, quantity and (for a controlled drug) the second checker, then preparation → in-progress → completed.
  async function completeDispense(id, body, ctx) {
    writable(ctx);
    if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only a person may dispense', 'forbidden');
    if (enforcedFor(ctx)) assertMayWrite(ctx.actor.role, 'MedicationDispense', 'transition');
    const result = await store.transaction(async (tx) => {
      const current = await tx.get('MedicationDispense', id, { branch: ctx.branch });
      if (!current) throw new HttpError(404, `MedicationDispense/${id} not found`, 'not-found');
      if (!['preparation', 'in-progress'].includes(current.status)) throw new HttpError(409, `This dispense is ${current.status}`, 'business-rule');
      const now = tx.now();
      let doc = stripInternal({ ...current });
      const lot = text(body?.lot, 64) || (doc.extension || []).find((e) => e.url === LOT_URL)?.valueString;
      const expiry = text(body?.expiry, 20) || (doc.extension || []).find((e) => e.url === EXPIRY_URL)?.valueString;
      if (!lot || !expiry) throw new HttpError(422, 'lot and expiry are required to complete a dispense');
      if (!/^\d{4}-\d{2}(-\d{2})?$/.test(expiry)) throw new HttpError(422, 'expiry must be a date (YYYY-MM or YYYY-MM-DD)');
      if (expiry < now.slice(0, expiry.length)) throw new HttpError(422, `The lot expired (${expiry}); it cannot be dispensed`);
      doc = withExtension(withExtension(doc, LOT_URL, 'valueString', lot), EXPIRY_URL, 'valueString', expiry);
      if (typeof body?.quantity === 'number' && body.quantity > 0) doc.quantity = { value: body.quantity, unit: text(body.quantityUnit, 20) || doc.quantity?.unit || 'dose' };
      if (typeof body?.daysSupply === 'number' && body.daysSupply > 0) doc.daysSupply = { value: body.daysSupply, unit: 'd' };
      const checkedBy = text(body?.checkedBy, 128);
      if (checkedBy) doc = withExtension(doc, CHECKED_BY_URL, 'valueString', checkedBy);
      if (!doc.performer?.length) doc.performer = [{ actor: { display: ctx.actor.id } }];
      let saved = current;
      if (current.status === 'preparation') ({ saved } = await fhir.writeInTx(tx, 'MedicationDispense', id, { ...doc, status: 'in-progress' }, ctx, { action: 'pharmacy.dispense.fill' }));
      ({ saved } = await fhir.writeInTx(tx, 'MedicationDispense', id, { ...stripInternal(saved), ...doc, status: 'completed', whenHandedOver: now }, ctx, { action: 'pharmacy.dispense.complete' }));
      return stripInternal(saved);
    });
    return { status: 200, body: result };
  }

  async function label(id, ctx) {
    const d = await store.get('MedicationDispense', id, opts(ctx));
    if (!d) throw new HttpError(404, `MedicationDispense/${id} not found`, 'not-found');
    const orderId = (d.authorizingPrescription?.[0]?.reference || '').split('/')[1];
    const order = orderId ? await store.get('MedicationRequest', orderId, opts(ctx)) : null;
    const who = await loadPatients(ctx, [d]);
    const row = dispenseRow(d, order, who, ctx.asOf ?? store.now());
    const src = order || d;
    return { status: 200, body: { ...row, dose: doseOf(src), route: routeOf(src), frequency: frequencyOf(src), routeText: ROUTES[routeOf(src)] || routeOf(src), frequencyText: FREQUENCIES[frequencyOf(src)] || frequencyOf(src), prescriber: order?.requester?.display || '', verified: order ? verifiedBy(order) : null, printed: false } };
  }

  // Ward view: completed dispenses grouped by the unit of the patient's current inpatient encounter.
  async function wards(ctx) {
    const now = ctx.asOf ?? store.now();
    const dispenses = await store.query('MedicationDispense', { where: (d) => d.status === 'completed' }, opts(ctx));
    const who = await loadPatients(ctx, dispenses);
    const orderIds = new Set(dispenses.map((d) => (d.authorizingPrescription?.[0]?.reference || '').split('/')[1]).filter(Boolean));
    const orders = new Map((await store.query('MedicationRequest', { where: (o) => orderIds.has(o.id) }, opts(ctx))).map((o) => [o.id, o]));
    // Not yet given: the MAR subtracts the dispenses that a completed MedicationAdministration references. Until then every completed dispense is listed.
    const rows = dispenses.map((d) => dispenseRow(d, orders.get((d.authorizingPrescription?.[0]?.reference || '').split('/')[1]) || null, who, now)).map((r) => ({ ...r, unit: r.patient?.unit || 'No unit assigned', given: false }));
    const units = new Map();
    for (const r of rows) units.set(r.unit, [...(units.get(r.unit) || []), r]);
    const list = [...units.entries()].map(([unit, items]) => ({ unit, count: items.length, rows: items.sort((a, b) => String(b.handedOverAt).localeCompare(String(a.handedOverAt))) })).sort((a, b) => (a.unit === 'No unit assigned') - (b.unit === 'No unit assigned') || a.unit.localeCompare(b.unit));
    return { status: 200, body: { now, units: list, total: rows.length } };
  }

  return {
    async handle(req, url, body, ctx) {
      const parts = url.pathname.split('/').filter(Boolean).slice(2);
      const m = req.method;
      if (parts[0] === 'queue' && m === 'GET') return queue(ctx, url);
      if (parts[0] === 'metrics' && m === 'GET') { const now = ctx.asOf ?? store.now(); return { status: 200, body: { now, metrics: await metrics(ctx, now) } }; }
      if (parts[0] === 'orders' && parts[1]) {
        const id = parts[1];
        if (m === 'POST' && (parts[2] === 'open' || parts[2] === 'close')) return lock(id, ctx, body, parts[2] === 'close');
        if (m === 'GET' && parts[2] === 'review') return review(id, ctx);
        if (m === 'POST' && parts[2] === 'decision') return decide(id, body, ctx);
        if (m === 'POST' && parts[2] === 'answer') return answer(id, body, ctx);
        if (m === 'POST' && parts[2] === 'emergency-override') return override(id, body, ctx);
      }
      if (parts[0] === 'dispense' && parts.length === 1) {
        if (m === 'GET') return dispenseQueue(ctx, url);
        if (m === 'POST') return startDispense(body || {}, ctx);
      }
      if (parts[0] === 'dispenses' && parts[1]) {
        if (m === 'POST' && parts[2] === 'complete') return completeDispense(parts[1], body || {}, ctx);
        if (m === 'GET' && parts[2] === 'label') return label(parts[1], ctx);
      }
      if (parts[0] === 'wards' && m === 'GET') return wards(ctx);
      throw new HttpError(404, `${m} ${url.pathname} is not available`);
    },
  };
}
