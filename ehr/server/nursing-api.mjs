// /api/nursing/**: the work list, the MAR, flowsheet and intake/output
// entry, order acknowledgement and education records.
// Every write goes through fhir.writeInTx inside one transaction, so the
// state machines, role checks, safety alerts and the log all apply.
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';
import { enforcedFor, assertMayWrite } from '../../platform/server/roles.mjs';
import { allergyConflict } from './safety-alerts.mjs';
import { scoreNews2 } from './news2.mjs';
import { lifecycleOf } from '../../platform/server/state-machines.mjs';
import { isVerified, emergencyOverride, rxOf, inpatientEncounter } from '../../pharmacy/server/pharmacy.mjs';
import { SYSTEMS, VITALS, ASSESSMENTS, ASSESSMENT_SYSTEM, isHighAlert } from './catalog.mjs';
import {
  marGrid, fiveRights, administrationDoc, sectionOf, ioObservation, ioTotals, worklistFor, NURSING_URLS, TASK_SYSTEM, LATE_MINUTES, SCORE_SYSTEM, NEWS2_CODE, loincOf, news2Inputs,
} from './nursing.mjs';

const MIN = 60000;
const whenOf = (o) => o.effectiveDateTime || o._validAt || o._recordedAt;
const ext = (doc, url) => (doc?.extension || []).find((e) => e.url === url)?.valueString ?? null;

export function createNursingApi({ store, fhir }) {
  const opts = (ctx) => ({ branch: ctx.branch, asOf: ctx.asOf });
  const log = (tx, ctx, fields) => recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, branch: ctx.branch, ...fields });
  const assertWrite = (ctx, type, interaction, extra) => { if (ctx.asOf) throw new HttpError(409, 'Writes are disabled while viewing a past time'); if (enforcedFor(ctx)) assertMayWrite(ctx.actor.role, type, interaction, extra); };
  const patientOf = async (reader, id, o) => { const p = await reader.get('Patient', id, o); if (!p) throw new HttpError(404, `Patient/${id} not found`); return p; };

  async function chart(reader, patientId, ctx) {
    const o = opts(ctx);
    const patient = await patientOf(reader, patientId, o);
    const ref = `Patient/${patient.id}`;
    const [encounters, orders, medOrders, admins, observations, tasks] = await Promise.all([
      reader.query('Encounter', { patient: ref }, o), reader.query('ServiceRequest', { patient: ref }, o), reader.query('MedicationRequest', { patient: ref }, o),
      reader.query('MedicationAdministration', { patient: ref }, o), reader.query('Observation', { patient: ref }, o), reader.query('Task', { patient: ref }, o),
    ]);
    return { patient, encounter: inpatientEncounter(encounters), orders, medOrders, admins, observations, tasks };
  }

  async function worklist(ctx, url) {
    const now = ctx.asOf ?? store.now();
    const patientId = url.searchParams.get('patient');
    if (patientId) return { status: 200, body: { now, patients: [worklistFor({ ...(await chart(store, patientId, ctx)), now })] } };
    const unit = url.searchParams.get('unit');
    const encounters = (await store.query('Encounter', { where: (e) => ['arrived', 'in-progress'].includes(e.status) && ['IMP', 'EMER'].includes(e.class?.code) }, opts(ctx)));
    const chosen = encounters.filter((e) => !unit || (e.location || []).some((l) => l.status === 'active' && (l.location?.display || '').toLowerCase().startsWith(unit.toLowerCase())));
    const patients = [];
    for (const e of chosen) {
      const id = e.subject?.reference?.split('/')[1];
      if (!id || patients.some((p) => p.patient.id === id)) continue;
      try { patients.push(worklistFor({ ...(await chart(store, id, ctx)), now })); } catch (err) { if (!(err instanceof HttpError)) throw err; }
    }
    patients.sort((a, b) => b.overdue - a.overdue || (a.items[0]?.due || '').localeCompare(b.items[0]?.due || ''));
    return { status: 200, body: { now, unit: unit || null, patients } };
  }

  async function mar(ctx, url) {
    const now = ctx.asOf ?? store.now();
    const c = await chart(store, url.searchParams.get('patient') || '', ctx);
    return { status: 200, body: { now, patient: { id: c.patient.id }, ...marGrid({ orders: c.medOrders, admins: c.admins, now, shift: url.searchParams.get('shift') || null }) } };
  }

  async function administer(body, ctx) {
    assertWrite(ctx, 'MedicationAdministration', 'create');
    const orderId = String(body.order || '').split('/').pop();
    const result = await store.transaction(async (tx) => {
      const order = await tx.get('MedicationRequest', orderId, { branch: ctx.branch });
      if (!order) throw new HttpError(404, `MedicationRequest/${orderId} not found`);
      const patient = await tx.get('Patient', order.subject.reference.split('/')[1], { branch: ctx.branch });
      const now = tx.now();
      const state = lifecycleOf(order);
      if (state !== 'active') {
        if (state === 'pending-verification' && !emergencyOverride(order)) throw new HttpError(409, 'This medication has not been verified by pharmacy. It cannot be given; for a STAT dose ask for an emergency override from the order.', 'business-rule');
        if (state !== 'pending-verification') throw new HttpError(409, `This order is ${state}; only active orders can be given`, 'business-rule');
      }
      if (state === 'active' && !isVerified(order)) throw new HttpError(409, 'This medication has not been verified by pharmacy and cannot be given', 'business-rule');
      const overrideReason = body.override ? String(body.override).trim() : '';
      const failures = body.outcome === 'given' || body.outcome === 'started' ? fiveRights({ order, patient, body, now }) : [];
      const conflict = body.outcome === 'given' || body.outcome === 'started' ? await allergyConflict(tx, { ...order, subject: order.subject }, ctx.branch) : null;
      if (conflict) failures.push({ right: 'allergy', message: `Allergy conflict at administration. ${conflict.message}` });
      if (failures.length && overrideReason.length < 3) {
        throw new HttpError(409, failures.map((f) => f.message).join(' '), 'business-rule', { issues: failures.map((f) => ({ severity: 'error', code: 'business-rule', details: { coding: [{ system: 'urn:hospital-desktop:five-rights', code: f.right }], text: f.message }, diagnostics: f.message })) });
      }
      const rx = rxOf(order);
      if ((body.outcome === 'given' || body.outcome === 'started') && rx && isHighAlert(rx.code)) {
        const witness = String(body.witness || '').trim();
        if (!witness) throw new HttpError(422, `${order.medicationCodeableConcept?.text || 'This medication'} is a high-alert medication: a second nurse must witness it (witness name required)`);
        if (witness.toLowerCase() === String(ctx.actor.id).toLowerCase()) throw new HttpError(422, 'The witness must be a different person from the nurse giving the dose');
      }
      const section = sectionOf(order);
      if (section === 'prn' && body.outcome === 'given' && !String(body.prnReason || '').trim()) throw new HttpError(422, 'A PRN dose needs the reason it was given');
      const late = body.due && body.outcome === 'given' ? Math.max(0, Math.round((Date.parse(now) - Date.parse(body.due)) / MIN) - LATE_MINUTES) : 0;
      const doc = administrationDoc({ order, patient, body, actor: ctx.actor, now, late: late > 0 ? late + LATE_MINUTES : 0 });
      const { saved } = await fhir.writeInTx(tx, 'MedicationAdministration', null, doc, ctx, { action: `mar.${body.outcome}` });
      for (const f of failures) {
        await log(tx, ctx, { kind: 'execute', action: 'safety.override', args: { alert: f.right === 'allergy' ? 'allergy-at-administration' : `five-rights:${f.right}`, order: `MedicationRequest/${order.id}`, administration: `MedicationAdministration/${saved.id}` }, why: overrideReason, entityRef: `MedicationAdministration/${saved.id}`, patientRef: saved._patient, description: `override at administration (${f.right}): ${overrideReason}` });
      }
      let followUp = null;
      if (section === 'prn' && body.outcome === 'given') {
        const due = new Date(Date.parse(now) + 60 * MIN).toISOString();
        followUp = (await fhir.writeInTx(tx, 'Task', null, {
          resourceType: 'Task', status: 'requested', intent: 'order', authoredOn: now, for: { reference: saved._patient }, focus: { reference: `MedicationAdministration/${saved.id}` },
          code: { coding: [{ system: TASK_SYSTEM, code: 'prn-follow-up' }], text: `Reassess after PRN ${order.medicationCodeableConcept?.text || 'dose'}` }, description: `Given for: ${String(body.prnReason).trim()}. Record the effect within an hour.`,
          restriction: { period: { end: due } }, owner: { display: ctx.actor.id }, requester: { display: ctx.actor.id },
        }, ctx, { action: 'mar.prn-follow-up' })).saved;
      }
      return { administration: saved, overrides: failures.map((f) => f.right), late: late > 0, followUp: followUp ? `Task/${followUp.id}` : null };
    });
    return { status: 201, body: result };
  }

  async function markError(id, body, ctx) {
    assertWrite(ctx, 'MedicationAdministration', 'transition');
    const reason = String(body?.reason || '').trim();
    if (reason.length < 3) throw new HttpError(422, 'A reason is required to mark an administration as entered in error');
    const saved = await store.transaction(async (tx) => {
      const current = await tx.get('MedicationAdministration', id, { branch: ctx.branch });
      if (!current) throw new HttpError(404, `MedicationAdministration/${id} not found`);
      const recorder = current.performer?.[0]?.actor?.display;
      if (recorder && recorder !== ctx.actor.id && ctx.actor.role !== 'administrator') throw new HttpError(403, `Only the person who recorded this administration (${recorder}) can mark it entered in error`);
      const { _seq, ...doc } = current;
      const next = { ...doc, status: 'entered-in-error', statusReason: [{ text: `entered-in-error: ${reason}` }], extension: [...(doc.extension || []).filter((e) => e.url !== 'urn:hospital-desktop:status-reason'), { url: 'urn:hospital-desktop:status-reason', valueString: reason }] };
      return (await fhir.writeInTx(tx, 'MedicationAdministration', id, next, ctx, { action: 'mar.entered-in-error' })).saved;
    });
    return { status: 200, body: saved };
  }

  async function flowsheetGet(ctx, url) {
    const c = await chart(store, url.searchParams.get('patient') || '', ctx);
    const rowsSpec = [...VITALS.map((v) => ({ key: v.key, code: v.code, system: SYSTEMS.loinc, name: v.name, unit: v.unit, band: 'Vitals' })), ...ASSESSMENTS.map((a) => ({ key: a.key, code: a.code, system: a.system, name: a.name, unit: a.unit || '', band: a.key === 'pain' ? 'Pain' : ['o2device', 'o2flow'].includes(a.key) ? 'Oxygenation' : 'Assessment' }))];
    const relevant = c.observations.filter((o) => ['final', 'corrected', 'amended'].includes(o.status) && (rowsSpec.some((r) => (o.code?.coding || []).some((x) => x.code === r.code && x.system === r.system)) || (o.code?.coding || []).some((x) => x.system === SCORE_SYSTEM && x.code === NEWS2_CODE)));
    const times = [...new Set(relevant.map(whenOf))].sort();
    const value = (o) => o.valueQuantity?.value ?? o.valueInteger ?? o.valueCodeableConcept?.coding?.[0]?.code ?? o.valueString ?? null;
    const rows = rowsSpec.map((r) => ({ ...r, cells: times.map((t) => { const o = relevant.find((x) => whenOf(x) === t && (x.code?.coding || []).some((y) => y.code === r.code && y.system === r.system)); return o ? { id: o.id, value: value(o), flag: o.interpretation?.[0]?.coding?.[0]?.code || null } : null; }) }));
    const scores = times.map((t) => { const o = relevant.find((x) => whenOf(x) === t && (x.code?.coding || []).some((y) => y.system === SCORE_SYSTEM)); return o ? { id: o.id, total: o.valueInteger ?? null, band: o.interpretation?.[0]?.coding?.[0]?.code || null, incomplete: Boolean(o.dataAbsentReason), response: o.interpretation?.[0]?.coding?.[0]?.display || '' } : null; });
    return { status: 200, body: { patient: { id: c.patient.id }, times, rows, scores } };
  }

  async function flowsheetPost(body, ctx) {
    assertWrite(ctx, 'Observation', 'create');
    const patientId = String(body.patient || '').split('/').pop();
    const at = body.at ? new Date(body.at).toISOString() : store.now();
    if (Number.isNaN(Date.parse(at))) throw new HttpError(422, 'at must be a date-time');
    const vitals = body.vitals || {};
    const assessments = body.assessments || {};
    const result = await store.transaction(async (tx) => {
      const patient = await tx.get('Patient', patientId, { branch: ctx.branch });
      if (!patient) throw new HttpError(404, `Patient/${patientId} not found`);
      const encounter = inpatientEncounter(await tx.query('Encounter', { patient: `Patient/${patient.id}` }, { branch: ctx.branch }));
      const base = { resourceType: 'Observation', status: 'final', subject: { reference: `Patient/${patient.id}` }, effectiveDateTime: at, performer: [{ display: ctx.actor.id }], ...(encounter ? { encounter: { reference: `Encounter/${encounter.id}` } } : {}) };
      const written = [];
      for (const v of VITALS.filter((x) => x.key !== 'bmi')) {
        const raw = vitals[v.key];
        if (raw === undefined || raw === null || raw === '') continue;
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new HttpError(422, `${v.name} must be a number`);
        let doc = { ...base, category: [{ coding: [{ system: SYSTEMS.obsCategory, code: 'vital-signs' }] }], code: { coding: [{ system: SYSTEMS.loinc, code: v.code, display: v.name }] }, valueQuantity: { value: n, unit: v.unit, system: 'http://unitsofmeasure.org', code: v.unit } };
        if (v.key === 'spo2' && Number(body.spo2Scale) === 2) doc = { ...doc, extension: [{ url: NURSING_URLS.spo2Scale, valueString: '2' }] };
        written.push((await fhir.writeInTx(tx, 'Observation', null, doc, ctx)).saved);
      }
      for (const a of ASSESSMENTS) {
        const raw = assessments[a.key];
        if (raw === undefined || raw === null || raw === '') continue;
        const code = { coding: [{ system: a.system, code: a.code, display: a.name }] };
        let doc = { ...base, category: [{ coding: [{ system: SYSTEMS.obsCategory, code: 'exam' }] }], code };
        if (a.kind === 'number') { const n = Number(raw); if (!Number.isFinite(n) || n < a.min || n > a.max) throw new HttpError(422, `${a.name} must be between ${a.min} and ${a.max}`); doc.valueQuantity = { value: n, unit: a.unit, system: 'http://unitsofmeasure.org', code: a.unit }; }
        else { const choice = String(raw); if (!a.options.includes(choice)) throw new HttpError(422, `${a.name} must be one of ${a.options.join(', ')}`); doc.valueCodeableConcept = { coding: [{ system: ASSESSMENT_SYSTEM, code: choice }], text: choice }; doc.valueString = undefined; }
        written.push((await fhir.writeInTx(tx, 'Observation', null, doc, ctx)).saved);
      }
      if (!written.length) throw new HttpError(422, 'Enter at least one value');
      const score = (await tx.query('Observation', { patient: `Patient/${patient.id}`, where: (o) => (o.code?.coding || []).some((c) => c.system === SCORE_SYSTEM && c.code === NEWS2_CODE) && Math.abs(Date.parse(whenOf(o)) - Date.parse(at)) <= 60 * MIN }, { branch: ctx.branch })).sort((x, y) => (x._recordedAt < y._recordedAt ? 1 : -1))[0] || null;
      if (score) return { written: written.map((o) => `Observation/${o.id}`), news2: { id: score.id, total: score.valueInteger ?? null, band: score.interpretation?.[0]?.coding?.[0]?.code || null, incomplete: Boolean(score.dataAbsentReason), response: score.interpretation?.[0]?.coding?.[0]?.display || '' } };
      const partial = scoreNews2(news2Inputs(await tx.query('Observation', { patient: `Patient/${patient.id}` }, { branch: ctx.branch }), at).input);
      return { written: written.map((o) => `Observation/${o.id}`), news2: { id: null, total: null, band: null, incomplete: true, missing: partial.missing, response: partial.response } };
    });
    return { status: 201, body: result };
  }

  async function ioGet(ctx, url) {
    const c = await chart(store, url.searchParams.get('patient') || '', ctx);
    const now = ctx.asOf ?? store.now();
    return { status: 200, body: { patient: { id: c.patient.id }, now, ...ioTotals(c.observations, now, { admissionStart: c.encounter?.period?.start || null }), entries: c.observations.filter((o) => (o.category || []).some((x) => (x.coding || []).some((y) => y.code === 'intake-output'))).sort((a, b) => (whenOf(a) < whenOf(b) ? 1 : -1)).slice(0, 200).map((o) => ({ id: o.id, at: whenOf(o), item: o.code?.coding?.[0]?.code, name: o.code?.coding?.[0]?.display, mL: o.valueQuantity?.value, note: o.note?.[0]?.text || null })) } };
  }

  async function ioPost(body, ctx) {
    assertWrite(ctx, 'Observation', 'create', { categories: ['intake-output'] });
    const patientId = String(body.patient || '').split('/').pop();
    const at = body.at ? new Date(body.at).toISOString() : store.now();
    const saved = await store.transaction(async (tx) => {
      const patient = await tx.get('Patient', patientId, { branch: ctx.branch });
      if (!patient) throw new HttpError(404, `Patient/${patientId} not found`);
      const encounter = inpatientEncounter(await tx.query('Encounter', { patient: `Patient/${patient.id}` }, { branch: ctx.branch }));
      const doc = ioObservation({ patientRef: `Patient/${patient.id}`, encounterRef: encounter ? `Encounter/${encounter.id}` : null, item: body.item, mL: body.mL, at, note: body.note });
      return (await fhir.writeInTx(tx, 'Observation', null, { ...doc, performer: [{ display: ctx.actor.id }] }, ctx, { action: 'io.record' })).saved;
    });
    return { status: 201, body: saved };
  }

  async function acknowledge(id, ctx) {
    assertWrite(ctx, 'ServiceRequest', 'update');
    const saved = await store.transaction(async (tx) => {
      const order = await tx.get('ServiceRequest', id, { branch: ctx.branch });
      if (!order) throw new HttpError(404, `ServiceRequest/${id} not found`);
      if (ext(order, NURSING_URLS.nurseAck)) return order;
      const { _seq, ...doc } = order;
      return (await fhir.writeInTx(tx, 'ServiceRequest', id, { ...doc, extension: [...(doc.extension || []), { url: NURSING_URLS.nurseAck, valueString: `${ctx.actor.id} at ${tx.now()}` }] }, ctx, { action: 'order.acknowledge' })).saved;
    });
    return { status: 200, body: saved };
  }

  async function education(body, ctx) {
    assertWrite(ctx, 'Procedure', 'create');
    const patientId = String(body.patient || '').split('/').pop();
    for (const f of ['topic', 'to', 'method', 'understanding']) if (!String(body[f] || '').trim()) throw new HttpError(422, `${f} is required`);
    const saved = await store.transaction(async (tx) => {
      const patient = await tx.get('Patient', patientId, { branch: ctx.branch });
      if (!patient) throw new HttpError(404, `Patient/${patientId} not found`);
      const encounter = inpatientEncounter(await tx.query('Encounter', { patient: `Patient/${patient.id}` }, { branch: ctx.branch }));
      const doc = {
        resourceType: 'Procedure', status: 'completed', category: { coding: [{ system: 'urn:hospital-desktop:category', code: 'education' }], text: 'Patient education' },
        code: { text: String(body.topic).trim() }, subject: { reference: `Patient/${patient.id}` }, ...(encounter ? { encounter: { reference: `Encounter/${encounter.id}` } } : {}),
        performedDateTime: tx.now(), performer: [{ actor: { display: ctx.actor.id } }], note: body.note ? [{ text: String(body.note).slice(0, 1000) }] : undefined,
        extension: [{ url: NURSING_URLS.taught, valueString: JSON.stringify({ to: String(body.to).trim(), method: String(body.method).trim(), understanding: String(body.understanding).trim(), followUp: Boolean(body.followUp) }) }],
      };
      return (await fhir.writeInTx(tx, 'Procedure', null, doc, ctx, { action: 'education.record' })).saved;
    });
    return { status: 201, body: saved };
  }

  async function evaluate(id, body, ctx) {
    assertWrite(ctx, 'CarePlan', 'update');
    const text = String(body?.text || '').trim();
    if (text.length < 3) throw new HttpError(422, 'An evaluation needs some text');
    const saved = await store.transaction(async (tx) => {
      const plan = await tx.get('CarePlan', id, { branch: ctx.branch });
      if (!plan) throw new HttpError(404, `CarePlan/${id} not found`);
      const { _seq, ...doc } = plan;
      return (await fhir.writeInTx(tx, 'CarePlan', id, { ...doc, note: [...(doc.note || []), { time: tx.now(), authorString: ctx.actor.id, text }] }, ctx, { action: 'careplan.evaluate' })).saved;
    });
    return { status: 200, body: saved };
  }

  return {
    async handle(req, url, body, ctx) {
      const parts = url.pathname.split('/').filter(Boolean).slice(2);
      const m = req.method;
      if (parts[0] === 'worklist' && m === 'GET') return worklist(ctx, url);
      if (parts[0] === 'mar') {
        if (parts.length === 1 && m === 'GET') return mar(ctx, url);
        if (parts[1] === 'administer' && m === 'POST') return administer(body || {}, ctx);
        if (parts[2] === 'error' && m === 'POST') return markError(parts[1], body || {}, ctx);
      }
      if (parts[0] === 'flowsheet') { if (m === 'GET') return flowsheetGet(ctx, url); if (m === 'POST') return flowsheetPost(body || {}, ctx); }
      if (parts[0] === 'io') { if (m === 'GET') return ioGet(ctx, url); if (m === 'POST') return ioPost(body || {}, ctx); }
      if (parts[0] === 'orders' && parts[2] === 'acknowledge' && m === 'POST') return acknowledge(parts[1], ctx);
      if (parts[0] === 'education' && m === 'POST') return education(body || {}, ctx);
      if (parts[0] === 'careplans' && parts[2] === 'evaluate' && m === 'POST') return evaluate(parts[1], body || {}, ctx);
      throw new HttpError(404, `${m} ${url.pathname} is not available`);
    },
  };
}

export { loincOf };
