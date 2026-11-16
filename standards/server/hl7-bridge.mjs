// HL7 v2 bridge: inbound ORU^R01 results and ADT admit, transfer,
// discharge, register, update and cancel messages become FHIR writes through
// the same transactional path as every app; every accepted message is a
// TraceStep hl7.receive; a refused message is quarantined for a person to
// fix and replay. Outbound ORM/OML for new lab orders and ORU^R01 for
// verified results are built locally and sent nowhere unless HL7_OUT_URL is set.
// Raw messages are stored only under data/hl7/ (gitignored).
import fs from 'node:fs';
import { v2ToFhir } from './v2.mjs';
import { createConsent, idOfPatient } from './consent.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';
import { parse, get, segmentsNamed, repetitions, tsToIso, isoToTs, build, ack, Hl7Error } from './hl7v2.mjs';
import { lifecycleOf } from '../../platform/server/state-machines.mjs';
import { admitToBed, transferToBed, dischargeFromBed, cleanBed } from '../../ehr/server/beds.mjs';
import { SYSTEMS, LAB_BY_CODE } from '../../ehr/server/catalog.mjs';
import { mrnOf } from '../../ehr/server/clinical-rules.mjs';
import { isLabOrder } from '../../lab/server/lab.mjs';

export const BRIDGE_ACTOR = { kind: 'human', id: 'hl7-bridge', role: 'interface' };
const hl7Dir = () => path.resolve(REPO_ROOT, process.env.HL7_DIR || 'data/hl7');
const CLASS = { I: 'IMP', E: 'EMER', O: 'AMB', P: 'PRENC', R: 'AMB', B: 'AMB' };
const idOf = (controlId) => `hl7-${createHash('sha1').update(String(controlId)).digest('hex').slice(0, 20)}`;
const SIGNED = ['final', 'corrected', 'amended'];

function storeRaw(id, text, direction) {
  const dir = path.join(hl7Dir(), direction);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.hl7`);
  fs.writeFileSync(file, text, 'latin1');
  return path.relative(REPO_ROOT, file);
}
export const readRaw = (rel) => (fs.existsSync(path.resolve(REPO_ROOT, rel)) ? fs.readFileSync(path.resolve(REPO_ROOT, rel), 'latin1') : null);

const APPLIED = { SIU: true, MDM: true, DFT: true, RDE: true, RDS: true, RAS: true, VXU: true, MFN: true };
export function createHl7Bridge({ store, fhir }) {
  const ctxFor = (branch = 'main') => ({ actor: BRIDGE_ACTOR, run: null, runId: null, branch, asOf: null, why: null, area: 'hl7', idempotencyKey: null });
  const log = (tx, ctx, fields) => recordAction(tx, { runId: LIVE_RUN_ID, actor: ctx.actor, branch: ctx.branch, ...fields });

  async function findPatient(tx, msg, branch) {
    const pid = segmentsNamed(msg, 'PID')[0];
    if (!pid) throw new Hl7Error('PID segment is required');
    const ids = (pid.fields[3] || []).map((rep) => ({ value: rep[0]?.[0] || '', type: rep[4]?.[0] || '' })).filter((x) => x.value);
    const mrn = (ids.find((x) => x.type === 'MR') || ids[0])?.value;
    if (!mrn) throw new Hl7Error('PID-3 has no patient identifier');
    const patients = await tx.query('Patient', {}, { branch });
    const patient = patients.find((p) => mrnOf(p) === mrn || (p.identifier || []).some((i) => i.value === mrn));
    return { patient, mrn, pid };
  }

  function demographics(pid) {
    const name = pid.fields[5]?.[0] || [];
    const sex = get(pid, null, 8).toUpperCase();
    const addr = pid.fields[11]?.[0] || [];
    return {
      name: [{ family: name[0]?.[0] || '', given: [name[1]?.[0], name[2]?.[0]].filter(Boolean) }],
      birthDate: get(pid, null, 7) ? `${get(pid, null, 7).slice(0, 4)}-${get(pid, null, 7).slice(4, 6)}-${get(pid, null, 7).slice(6, 8)}` : undefined,
      gender: { M: 'male', F: 'female', O: 'other', U: 'unknown' }[sex] || undefined,
      address: addr.length ? [{ line: [addr[0]?.[0]].filter(Boolean), city: addr[2]?.[0], state: addr[3]?.[0], postalCode: addr[4]?.[0] }] : undefined,
    };
  }

  // A cancel reclaims the bed the patient came from; if it went to cleaning on the way out, it is marked clean first.
  async function reclaiming(tx, bed, ctx, move) {
    try { return await move(); } catch (err) {
      if (!(err instanceof HttpError) || !/being cleaned/.test(err.message)) throw err;
      await cleanBed(tx, { bed, ctx }, { fhir });
      return move();
    }
  }
  const bedRefOf = (pv1, field) => { const loc = pv1?.fields[field]?.[0]; return loc && loc[0]?.[0] ? { pointOfCare: loc[0]?.[0], room: loc[1]?.[0], bed: loc[2]?.[0] } : null; };
  const visitNumber = (pv1) => get(pv1, null, 19) || null;

  async function findEncounter(tx, patient, pv1, branch) {
    const encounters = await tx.query('Encounter', { patient: `Patient/${patient.id}` }, { branch });
    const open = (x) => ['arrived', 'in-progress'].includes(x.status);
    const newest = (list) => list.sort((a, b) => ((a.period?.start || a._recordedAt || '') < (b.period?.start || b._recordedAt || '') ? 1 : -1))[0] || null;
    const visit = visitNumber(pv1);
    if (visit) { const same = encounters.filter((x) => (x.identifier || []).some((i) => i.value === visit)); const e = newest(same.filter(open)) || newest(same); if (e) return e; }
    return newest(encounters.filter(open));
  }

  // ---------- handlers ----------
  async function oru(tx, msg, ctx) {
    const { patient, mrn } = await findPatient(tx, msg, ctx.branch);
    if (!patient) throw new Hl7Error(`Unknown patient: no chart has MRN ${mrn}`);
    const results = [];
    let current = null;
    for (const seg of msg.segments) {
      if (seg.name === 'OBR') {
        const placer = get(seg, null, 2); const filler = get(seg, null, 3);
        const orders = await tx.query('ServiceRequest', { patient: `Patient/${patient.id}` }, { branch: ctx.branch });
        let order = orders.find((o) => o.id === placer || (o.identifier || []).some((i) => i.value === placer || i.value === filler));
        if (!order) {
          const code = get(seg, null, 4, 1); const text = get(seg, null, 4, 2) || code;
          if (!code) throw new Hl7Error('OBR-4 universal service identifier is required when no order matches');
          order = (await fhir.writeInTx(tx, 'ServiceRequest', null, { resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: `Patient/${patient.id}` }, authoredOn: tsToIso(get(seg, null, 7)) || tx.now(), identifier: [placer ? { system: 'urn:hospital-desktop:placer', value: placer } : null, filler ? { system: 'urn:hospital-desktop:filler', value: filler } : null].filter(Boolean), code: { coding: [{ system: SYSTEMS.loinc, code, display: text }], text }, category: [{ coding: [{ system: 'urn:hospital-desktop:order-category', code: 'laboratory' }] }], requester: { display: get(seg, null, 16, 2) || 'Unsolicited (HL7)' }, extension: [{ url: 'urn:hospital-desktop:unsolicited', valueString: msg.controlId }] }, ctx, { action: 'hl7.unsolicited-order' })).saved;
        }
        current = order;
      }
      if (seg.name === 'OBX') {
        if (!current) throw new Hl7Error('OBX before any OBR');
        const code = get(seg, null, 3, 1); const display = get(seg, null, 3, 2) || LAB_BY_CODE.get(code)?.name || code;
        if (!code) throw new Hl7Error(`OBX-3 observation identifier is required (set ${get(seg, null, 1)})`);
        const type = get(seg, null, 2); const raw = get(seg, null, 5); const unit = get(seg, null, 6, 1) || LAB_BY_CODE.get(code)?.unit || '';
        const status = { P: 'preliminary', F: 'final', C: 'corrected', I: 'registered', X: 'cancelled' }[get(seg, null, 11)] || 'final';
        const range = get(seg, null, 7).match(/^\s*([\d.]+)\s*-\s*([\d.]+)/);
        const flag = get(seg, null, 8).toUpperCase();
        const when = tsToIso(get(seg, null, 14)) || tsToIso(get(msg, 'OBR', 7)) || tx.now();
        const existing = (await tx.query('Observation', { patient: `Patient/${patient.id}` }, { branch: ctx.branch })).filter((o) => (o.basedOn || []).some((b) => b.reference === `ServiceRequest/${current.id}`) && (o.code?.coding || []).some((c) => c.code === code)).sort((a, b) => (a._recordedAt < b._recordedAt ? 1 : -1))[0] || null;
        const base = {
          resourceType: 'Observation', status: 'preliminary', subject: { reference: `Patient/${patient.id}` }, effectiveDateTime: when, issued: tx.now(), basedOn: [{ reference: `ServiceRequest/${current.id}` }], performer: [{ display: get(msg, 'MSH', 3) || 'HL7 interface' }],
          category: [{ coding: [{ system: SYSTEMS.obsCategory, code: 'laboratory' }] }], code: { coding: [{ system: SYSTEMS.loinc, code, display }] },
          ...(type === 'NM' || /^-?[\d.]+$/.test(raw) ? { valueQuantity: { value: Number(raw), unit, system: 'http://unitsofmeasure.org', code: unit } } : { valueString: raw }),
          ...(range ? { referenceRange: [{ low: { value: Number(range[1]), unit }, high: { value: Number(range[2]), unit } }] } : {}),
          ...(flag && !LAB_BY_CODE.has(code) && ['L', 'H', 'LL', 'HH', 'A', 'N'].includes(flag) ? { interpretation: [{ coding: [{ system: SYSTEMS.interpretation, code: flag }] }] } : {}),
          extension: [{ url: 'urn:hospital-desktop:hl7-control-id', valueString: msg.controlId }],
        };
        let saved;
        if (status === 'corrected') {
          if (!existing || !SIGNED.includes(existing.status)) throw new Hl7Error(`OBX-11 C (corrected) for ${code} but no final result exists to correct`);
          const { _seq, ...d } = existing;
          saved = (await fhir.writeInTx(tx, 'Observation', existing.id, { ...d, status: 'corrected', valueQuantity: base.valueQuantity, valueString: base.valueString, extension: [...(d.extension || []).filter((e) => e.url !== 'urn:hospital-desktop:status-reason'), { url: 'urn:hospital-desktop:status-reason', valueString: `corrected by HL7 ${msg.controlId}` }] }, ctx, { action: 'hl7.result' })).saved;
        } else if (existing && existing.status === 'preliminary') {
          const { _seq, ...d } = existing;
          saved = (await fhir.writeInTx(tx, 'Observation', existing.id, { ...d, valueQuantity: base.valueQuantity, valueString: base.valueString, status: 'preliminary' }, ctx, { action: 'hl7.result' })).saved;
          if (status === 'final') { const { _seq: s2, ...d2 } = saved; saved = (await fhir.writeInTx(tx, 'Observation', saved.id, { ...d2, status: 'final' }, ctx, { action: 'hl7.result' })).saved; }
        } else if (existing && SIGNED.includes(existing.status)) {
          throw new Hl7Error(`Result ${code} for this order is already final; send OBX-11 C to correct it`);
        } else {
          saved = (await fhir.writeInTx(tx, 'Observation', null, base, ctx, { action: 'hl7.result' })).saved;
          if (status === 'final') { const { _seq, ...d } = saved; saved = (await fhir.writeInTx(tx, 'Observation', saved.id, { ...d, status: 'final' }, ctx, { action: 'hl7.result' })).saved; }
        }
        results.push({ id: saved.id, code, status: saved.status, critical: (saved.interpretation || []).some((i) => (i.coding || []).some((c) => ['LL', 'HH'].includes(c.code))) });
      }
    }
    if (!results.length) throw new Hl7Error('No OBX segment in the ORU message');
    return { patient: patient.id, results };
  }

  async function adt(tx, msg, ctx) {
    const trigger = msg.trigger;
    const pv1 = segmentsNamed(msg, 'PV1')[0] || null;
    let { patient, mrn, pid } = await findPatient(tx, msg, ctx.branch);
    const demo = demographics(pid);
    if (trigger === 'A04') {
      const doc = patient ? { ...(({ _seq, ...d }) => d)(patient), ...demo } : { resourceType: 'Patient', ...demo, identifier: [{ use: 'usual', type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR', display: 'Medical record number' }] }, system: 'urn:hospital-desktop:mrn', value: mrn }] };
      if (!patient && !/^N\d{6}$/.test(mrn)) { delete doc.identifier; doc.identifier = [{ system: 'urn:hospital-desktop:source-patient-id', value: mrn }]; }
      patient = (await fhir.writeInTx(tx, 'Patient', patient ? patient.id : null, doc, ctx, { action: 'hl7.register' })).saved;
      const cls = CLASS[get(pv1, null, 2).toUpperCase()] || 'AMB';
      const enc = (await fhir.writeInTx(tx, 'Encounter', null, { resourceType: 'Encounter', status: 'arrived', class: { code: cls, display: cls === 'EMER' ? 'emergency' : 'outpatient' }, subject: { reference: `Patient/${patient.id}` }, period: { start: tsToIso(get(pv1, null, 44)) || tx.now() }, ...(visitNumber(pv1) ? { identifier: [{ system: 'urn:hospital-desktop:visit', value: visitNumber(pv1) }] } : {}) }, ctx, { action: 'hl7.register' })).saved;
      return { patient: patient.id, encounter: enc.id };
    }
    if (!patient) throw new Hl7Error(`Unknown patient: no chart has MRN ${mrn}`);
    if (trigger === 'A08') {
      const { _seq, ...d } = patient;
      const saved = (await fhir.writeInTx(tx, 'Patient', patient.id, { ...d, ...demo }, ctx, { action: 'hl7.update' })).saved;
      return { patient: saved.id, updated: true };
    }
    if (trigger === 'A01') {
      const cls = CLASS[get(pv1, null, 2).toUpperCase()] || 'IMP';
      let enc = await findEncounter(tx, patient, pv1, ctx.branch);
      if (!enc || enc.status === 'finished' || enc.status === 'cancelled') {
        enc = (await fhir.writeInTx(tx, 'Encounter', null, { resourceType: 'Encounter', status: 'in-progress', class: { code: cls, display: cls === 'EMER' ? 'emergency' : 'inpatient' }, subject: { reference: `Patient/${patient.id}` }, period: { start: tsToIso(get(pv1, null, 44)) || tx.now() }, ...(visitNumber(pv1) ? { identifier: [{ system: 'urn:hospital-desktop:visit', value: visitNumber(pv1) }] } : {}), ...(get(pv1, null, 7, 2) ? { participant: [{ individual: { display: `${get(pv1, null, 7, 2)} ${get(pv1, null, 7, 3)}`.trim() } }] } : {}) }, ctx, { action: 'hl7.admit' })).saved;
      } else if (enc.status === 'arrived' || enc.status === 'planned') {
        const { _seq, ...d } = enc;
        enc = (await fhir.writeInTx(tx, 'Encounter', enc.id, { ...d, status: 'in-progress', class: { code: cls } }, ctx, { action: 'hl7.admit' })).saved;
      }
      const bed = bedRefOf(pv1, 3);
      if (bed) await admitToBed(tx, { encounter: `Encounter/${enc.id}`, bed, ctx }, { fhir });
      return { patient: patient.id, encounter: enc.id, bed: bed ? `${bed.pointOfCare}/${bed.room}/${bed.bed}` : null };
    }
    const enc = await findEncounter(tx, patient, pv1, ctx.branch);
    if (!enc) throw new Hl7Error(`No open encounter for MRN ${mrn}`);
    if (trigger === 'A02') {
      const bed = bedRefOf(pv1, 3);
      if (!bed) throw new Hl7Error('PV1-3 assigned location is required for a transfer');
      await transferToBed(tx, { encounter: `Encounter/${enc.id}`, bed, reason: 'HL7 ADT^A02', ctx }, { fhir });
      return { patient: patient.id, encounter: enc.id, bed: `${bed.pointOfCare}/${bed.room}/${bed.bed}` };
    }
    if (trigger === 'A03') { await dischargeFromBed(tx, { encounter: `Encounter/${enc.id}`, ctx }, { fhir }); return { patient: patient.id, encounter: enc.id, discharged: true }; }
    if (trigger === 'A11') {
      const bedId = (enc.location || []).find((l) => l.status === 'active')?.location?.reference?.split('/')[1];
      if (bedId) await dischargeFromBed(tx, { encounter: `Encounter/${enc.id}`, ctx }, { fhir });
      const latest = await tx.get('Encounter', enc.id, { branch: ctx.branch });
      const { _seq, ...d } = latest;
      if (latest.status !== 'finished') await fhir.writeInTx(tx, 'Encounter', enc.id, { ...d, status: 'cancelled', extension: [...(d.extension || []), { url: 'urn:hospital-desktop:status-reason', valueString: `cancelled by HL7 ADT^A11 ${msg.controlId}` }] }, ctx, { action: 'hl7.cancel-admit' });
      else await log(tx, ctx, { kind: 'update', action: 'hl7.cancel-admit', args: { encounter: enc.id, note: 'bed released; encounter already finished' }, entityRef: `Encounter/${enc.id}`, patientRef: `Patient/${patient.id}`, description: 'cancel admit' });
      return { patient: patient.id, encounter: enc.id, cancelled: 'admit' };
    }
    if (trigger === 'A12') {
      // In a cancel-transfer message PV1-3 is where the patient is after the cancellation (the original bed); PV1-6 is the bed they were wrongly moved to.
      const back = bedRefOf(pv1, 3);
      if (!back) throw new Hl7Error('PV1-3 assigned location is required to cancel a transfer');
      await reclaiming(tx, back, ctx, () => transferToBed(tx, { encounter: `Encounter/${enc.id}`, bed: back, reason: 'HL7 ADT^A12 (cancel transfer)', ctx }, { fhir }));
      return { patient: patient.id, encounter: enc.id, cancelled: 'transfer', bed: `${back.pointOfCare}/${back.room}/${back.bed}` };
    }
    if (trigger === 'A13') {
      const finished = (await tx.query('Encounter', { patient: `Patient/${patient.id}` }, { branch: ctx.branch })).filter((x) => x.status === 'finished').sort((a, b) => ((a.period?.end || '') < (b.period?.end || '') ? 1 : -1))[0];
      if (!finished) throw new Hl7Error('No finished encounter to reinstate');
      const { _seq, id, meta, ...d } = finished;
      const reopened = (await fhir.writeInTx(tx, 'Encounter', null, { ...d, status: 'in-progress', period: { start: d.period?.start }, location: [], extension: [...(d.extension || []), { url: 'urn:hospital-desktop:reinstated-from', valueString: `Encounter/${id} (HL7 ADT^A13 ${msg.controlId})` }] }, ctx, { action: 'hl7.cancel-discharge' })).saved;
      const bed = bedRefOf(pv1, 3);
      if (bed) await reclaiming(tx, bed, ctx, () => admitToBed(tx, { encounter: `Encounter/${reopened.id}`, bed, ctx }, { fhir }));
      return { patient: patient.id, encounter: reopened.id, cancelled: 'discharge', reinstatedFrom: id };
    }
    throw new Hl7Error(`ADT^${trigger} is not supported (A01, A02, A03, A04, A08, A11, A12, A13)`);
  }

  // ---------- receive ----------
  /** Processes one raw message. Returns { ack, record }. Never throws for a message problem: the ACK carries AE/AR and the message is quarantined. */
  // SIU, MDM, DFT, RDE, RDS, RAS, VXU and MFN: the message is mapped to FHIR (lib/interop/v2.mjs) and each
  // resource is written through the same FHIR write path as the UI, so the lifecycles, safety checks and audit
  // apply. A resource is created in its first allowed state and moved on step by step, as a person would.
  const STEPS = { Appointment: { booked: ['booked'], cancelled: ['booked', 'cancelled'], fulfilled: ['booked', 'arrived', 'fulfilled'], noshow: ['booked', 'noshow'], pending: ['pending'] }, MedicationDispense: { completed: ['preparation', 'in-progress', 'completed'] }, MedicationRequest: { active: ['draft'] } };
  const placerOf = (r) => (r.identifier || []).find((i) => i.type?.text === 'placer')?.value;
  async function upsert(tx, type, r, ctx, action, match) {
    const found = match ? (await tx.query(type, match.patient ? { patient: match.patient } : {}, { branch: ctx.branch })).find(match.test) : null;
    const target = STEPS[type]?.[r.status] || [r.status];
    let saved = found; const from = found ? Math.max(target.indexOf(found.status), 0) + (target.includes(found.status) ? 1 : 0) : 0;
    if (found && !target.includes(found.status)) { const { _seq, ...d } = found; saved = (await fhir.writeInTx(tx, type, found.id, { ...d, ...r, id: found.id, status: target.at(-1) }, ctx, { action })).saved; return saved; }
    for (const st of target.slice(from)) { const base = saved ? (({ _seq, ...d }) => d)(saved) : {}; saved = (await fhir.writeInTx(tx, type, saved?.id || null, { ...base, ...r, ...(saved ? { id: saved.id } : {}), ...(r.status !== undefined ? { status: st } : {}) }, ctx, { action })).saved; }
    if (type === 'DocumentReference' && r.docStatus === 'final' && saved.docStatus !== 'final') { const { _seq, ...d } = saved; saved = (await fhir.writeInTx(tx, type, saved.id, { ...d, docStatus: 'final' }, ctx, { action })).saved; }
    return saved;
  }
  async function applyMapped(tx, msg, ctx) {
    const action = `hl7.${msg.type.toLowerCase()}`;
    const bundle = v2ToFhir(msg);
    const rs = bundle.entry.slice(1).map((e) => e.resource);
    if (msg.type === 'MFN') {
      const out = [];
      for (const r of rs.filter((x) => x.resourceType === 'Practitioner')) { const key = r.identifier[0].value; const { meta, ...doc } = r; const saved = await upsert(tx, 'Practitioner', { ...doc, identifier: [{ system: 'urn:hospital-desktop:staff-id', value: key }] }, ctx, action, { test: (p) => (p.identifier || []).some((i) => i.value === key) }); out.push(saved.id); }
      return { practitioners: out };
    }
    const { patient, mrn } = await findPatient(tx, msg, ctx.branch);
    if (!patient) throw new Hl7Error(`Unknown patient: no chart has MRN ${mrn}`);
    const ref = `Patient/${patient.id}`; const written = [];
    for (const r0 of rs) {
      if (r0.resourceType === 'Patient' || r0.resourceType === 'Specimen') continue;
      const { meta, ...r } = JSON.parse(JSON.stringify(r0).replaceAll(bundle.entry.find((e) => e.resource.resourceType === 'Patient')?.fullUrl || '\u0000', ref));
      r.extension = [...(r.extension || []), { url: 'urn:hospital-desktop:hl7-control-id', valueString: msg.controlId }];
      const t = r.resourceType; const placer = placerOf(r);
      if (t === 'Appointment') { const triggerStatus = { S12: r.status, S13: r.status, S14: r.status, S15: 'cancelled', S26: 'noshow' }[msg.trigger] || r.status; written.push(await upsert(tx, t, { ...r, status: triggerStatus }, ctx, action, placer && { test: (a) => (a.identifier || []).some((i) => i.value === placer) })); continue; }
      if (t === 'DocumentReference') { written.push(await upsert(tx, t, { ...r, docStatus: 'preliminary' }, ctx, action, r.masterIdentifier?.value && { patient: ref, test: (d) => d.masterIdentifier?.value === r.masterIdentifier.value })); if (r0.docStatus === 'final') { const last = written.at(-1); const { _seq, ...d } = last; written[written.length - 1] = (await fhir.writeInTx(tx, t, last.id, { ...d, docStatus: 'final' }, ctx, { action })).saved; } continue; }
      if (t === 'MedicationDispense' || t === 'MedicationAdministration') { const rx = placer && (await tx.query('MedicationRequest', { patient: ref }, { branch: ctx.branch })).find((m) => (m.identifier || []).some((i) => i.value === placer)); if (rx) r[t === 'MedicationDispense' ? 'authorizingPrescription' : 'request'] = t === 'MedicationDispense' ? [{ reference: `MedicationRequest/${rx.id}` }] : { reference: `MedicationRequest/${rx.id}` }; }
      if (t === 'MedicationRequest') { r.status = 'active'; written.push(await upsert(tx, t, r, ctx, action, placer && { patient: ref, test: (m) => (m.identifier || []).some((i) => i.value === placer) })); continue; }
      written.push(await upsert(tx, t, r, ctx, action, null));
    }
    if (!written.length) throw new Hl7Error(`${msg.type}^${msg.trigger} carried nothing to apply`);
    return { patient: patient.id, written: written.map((w) => `${w.resourceType}/${w.id}`) };
  }

  async function receive(text, { replayOf = null, branch = 'main' } = {}) {
    const ctx = ctxFor(branch);
    let msg = null;
    try { msg = parse(text); } catch (err) {
      if (!(err instanceof Hl7Error)) throw err;
      const id = `hl7-bad-${createHash('sha1').update(String(text)).digest('hex').slice(0, 20)}`;
      const raw = storeRaw(id, String(text), 'in');
      const response = ack({ controlId: '', code: 'AR', text: err.message, now: store.now() });
      const record = await store.transaction(async (tx) => {
        const rec = await tx.save('Hl7Message', { resourceType: 'Hl7Message', id, direction: 'in', type: null, controlId: null, status: 'quarantined', ackCode: 'AR', error: err.message, raw, receivedAt: tx.now(), replayOf, attempts: 1 }, { updatedBy: 'interface' });
        await log(tx, ctx, { kind: 'execute', action: 'hl7.reject', args: { id, code: 'AR', reason: err.message }, entityRef: `Hl7Message/${id}`, description: `HL7 rejected: ${err.message}`, outcome: '8' });
        return rec;
      });
      return { ack: response, record };
    }
    const id = replayOf ? `${idOf(msg.controlId)}-r${Date.now().toString(36)}` : idOf(msg.controlId);
    const previous = await store.get('Hl7Message', idOf(msg.controlId));
    if (previous && !replayOf) {
      if (previous.status === 'accepted') return { ack: previous.ack, record: previous, duplicate: true };
      if (previous.status === 'quarantined') return { ack: previous.ack, record: previous, duplicate: true };
    }
    const raw = storeRaw(id, String(text), 'in');
    const summary = { type: `${msg.type}^${msg.trigger}`, controlId: msg.controlId, version: msg.version || null, sendingApp: get(msg, 'MSH', 3), mrn: (segmentsNamed(msg, 'PID')[0]?.fields[3]?.[0]?.[0]?.[0]) || null };
    try {
      const result = await store.transaction(async (tx) => {
        let out;
        if (msg.type === 'ORU' && msg.trigger === 'R01') out = await oru(tx, msg, ctx);
        else if (msg.type === 'ADT') out = await adt(tx, msg, ctx);
        else if (msg.type === 'OUL' && msg.trigger === 'R22') out = await oru(tx, msg, ctx);
        else if (APPLIED[msg.type]) out = await applyMapped(tx, msg, ctx);
        else throw new Hl7Error(`${msg.type}^${msg.trigger} is not supported`);
        const response = ack({ controlId: msg.controlId, receivingApp: get(msg, 'MSH', 3), receivingFacility: get(msg, 'MSH', 4), version: msg.version || '2.5.1', now: tx.now(), code: 'AA' });
        const rec = await tx.save('Hl7Message', { resourceType: 'Hl7Message', id, direction: 'in', ...summary, status: 'accepted', ackCode: 'AA', ack: response, result: out, raw, receivedAt: tx.now(), replayOf, attempts: 1 }, { updatedBy: 'interface' });
        await log(tx, ctx, { kind: 'execute', action: 'hl7.receive', args: { id, controlId: msg.controlId, type: summary.type, ...out }, entityRef: `Hl7Message/${id}`, patientRef: out.patient ? `Patient/${out.patient}` : undefined, description: `HL7 ${summary.type} accepted (${msg.controlId})` });
        if (replayOf) { const old = await tx.get('Hl7Message', replayOf); if (old) { const { _seq, ...od } = old; await tx.save('Hl7Message', { ...od, status: 'replayed', replayedBy: id }, { updatedBy: 'interface' }); } }
        return { response, rec };
      });
      return { ack: result.response, record: result.rec };
    } catch (err) {
      const reason = err instanceof Hl7Error || err instanceof HttpError ? err.message : `Internal error: ${err.message}`;
      if (!(err instanceof Hl7Error || err instanceof HttpError)) console.error(err);
      const response = ack({ controlId: msg.controlId, receivingApp: get(msg, 'MSH', 3), receivingFacility: get(msg, 'MSH', 4), version: msg.version || '2.5.1', now: store.now(), code: 'AE', text: reason });
      const record = await store.transaction(async (tx) => {
        const rec = await tx.save('Hl7Message', { resourceType: 'Hl7Message', id, direction: 'in', ...summary, status: 'quarantined', ackCode: 'AE', ack: response, error: reason, raw, receivedAt: tx.now(), replayOf, attempts: 1 }, { updatedBy: 'interface' });
        await log(tx, ctx, { kind: 'execute', action: 'hl7.reject', args: { id, controlId: msg.controlId, type: summary.type, code: 'AE', reason }, entityRef: `Hl7Message/${id}`, description: `HL7 ${summary.type} quarantined: ${reason}`, outcome: '8' });
        return rec;
      });
      return { ack: response, record };
    }
  }

  // ---------- outbound ----------
  function patientSegment(p) { const n = p.name?.[0] || {}; return ['PID', '1', '', [mrnOf(p) || p.id, '', '', 'HOSPITAL', 'MR'], '', [n.family || '', ...(n.given || [])], '', (p.birthDate || '').replace(/-/g, ''), { male: 'M', female: 'F' }[p.gender] || 'U']; }
  async function sendOut(record) {
    const url = process.env.HL7_OUT_URL;
    if (!url) return { sent: false, note: 'HL7_OUT_URL is not set; the message was stored only' };
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: readRaw(record.raw) });
      return { sent: true, status: r.status, ackText: (await r.text()).slice(0, 200) };
    } catch (err) { return { sent: false, note: err.message }; }
  }
  async function emit(kind, text, meta, patientRef) {
    if (await createConsent(store).blocked(idOfPatient(patientRef), { actor: BRIDGE_ACTOR }, process.env.HL7_OUT_URL ? 'HOPERAT' : 'TREAT')) { const ctx0 = ctxFor(); await store.transaction(async (tx) => log(tx, ctx0, { kind: 'execute', action: 'consent.deny', args: { type: meta.type, controlId: meta.controlId }, patientRef, description: 'HL7 message withheld: the patient\'s consent denies sharing' })); return { id: `hl7-out-${meta.controlId}`, status: 'withheld-consent' }; }
    const id = `hl7-out-${meta.controlId}`;
    const raw = storeRaw(id, text, 'out');
    const ctx = ctxFor();
    const rec = await store.transaction(async (tx) => {
      const r = await tx.save('Hl7Message', { resourceType: 'Hl7Message', id, direction: 'out', ...meta, status: 'built', raw, builtAt: tx.now() }, { updatedBy: 'interface' });
      await log(tx, ctx, { kind: 'execute', action: 'hl7.send', args: { id, type: meta.type, controlId: meta.controlId, order: meta.order || null }, entityRef: `Hl7Message/${id}`, patientRef, description: `HL7 ${meta.type} built${process.env.HL7_OUT_URL ? ' and sent' : ' (not sent: HL7_OUT_URL unset)'}` });
      return r;
    });
    const sent = await sendOut(rec);
    if (sent.sent !== undefined && process.env.HL7_OUT_URL) { const { _seq, ...d } = rec; await store.save('Hl7Message', { ...d, status: sent.sent ? 'sent' : 'send-failed', send: sent }, { updatedBy: 'interface' }); }
    return rec;
  }
  async function orderMessage(order) {
    const patient = await store.get('Patient', order.subject.reference.split('/')[1]);
    if (!patient) return null;
    const oml = process.env.HL7_ORDER_MESSAGE === 'OML';
    const now = store.now();
    const controlId = `ORD${isoToTs(now)}${order.id.slice(0, 6)}`;
    const code = order.code?.coding?.[0]?.code || ''; const text = order.code?.text || order.code?.coding?.[0]?.display || '';
    const segs = [
      ['MSH', 'HOSPITAL-DESKTOP', 'HOSPITAL', 'LAB', 'LAB', isoToTs(now), '', oml ? ['OML', 'O21', 'OML_O21'] : ['ORM', 'O01'], controlId, 'P', '2.5.1'],
      patientSegment(patient), ['ORC', 'NW', order.id, '', '', '', '', '', '', isoToTs(order.authoredOn || now), '', '', ['', order.requester?.display || '']],
      ['OBR', '1', order.id, '', [code, text, 'LN'], order.priority === 'stat' ? 'S' : 'R', isoToTs(order.authoredOn || now)],
    ];
    return emit('order', build(segs), { type: oml ? 'OML^O21' : 'ORM^O01', controlId, order: order.id, mrn: mrnOf(patient) }, `Patient/${patient.id}`);
  }
  async function resultMessage(order, observations) {
    const patient = await store.get('Patient', order.subject.reference.split('/')[1]);
    if (!patient) return null;
    const now = store.now();
    const controlId = `RES${isoToTs(now)}${order.id.slice(0, 6)}`;
    const code = order.code?.coding?.[0]?.code || ''; const text = order.code?.text || order.code?.coding?.[0]?.display || '';
    const segs = [
      ['MSH', 'HOSPITAL-DESKTOP', 'HOSPITAL', 'EHR', 'HOSPITAL', isoToTs(now), '', ['ORU', 'R01', 'ORU_R01'], controlId, 'P', '2.5.1'],
      patientSegment(patient), ['OBR', '1', order.id, order.id, [code, text, 'LN'], '', isoToTs(order.authoredOn || now), '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'F'],
      ...observations.map((o, i) => ['OBX', String(i + 1), o.valueQuantity ? 'NM' : 'ST', [o.code?.coding?.[0]?.code || '', o.code?.coding?.[0]?.display || '', 'LN'], '', o.valueQuantity ? String(o.valueQuantity.value) : (o.valueString || ''), o.valueQuantity?.unit || '', o.referenceRange?.[0] ? `${o.referenceRange[0].low?.value ?? ''}-${o.referenceRange[0].high?.value ?? ''}` : '', o.interpretation?.[0]?.coding?.[0]?.code || '', '', '', { final: 'F', corrected: 'C', preliminary: 'P' }[o.status] || 'F', '', '', isoToTs(o.effectiveDateTime || now)]),
    ];
    return emit('result', build(segs), { type: 'ORU^R01', controlId, order: order.id, mrn: mrnOf(patient) }, `Patient/${patient.id}`);
  }

  /** Called from the FHIR commit hook: new lab orders and newly final lab results produce outbound messages. */
  async function onCommitted({ type, saved, existed, ctx }) {
    if (ctx?.actor?.id === BRIDGE_ACTOR.id) return;
    if (type === 'ServiceRequest' && !existed && isLabOrder(saved) && saved._branch === 'main') await orderMessage(saved);
    if (type === 'Observation' && SIGNED.includes(saved.status) && (!existed || !SIGNED.includes(existed.status)) && (saved.category || []).some((c) => (c.coding || []).some((x) => x.code === 'laboratory')) && saved._branch === 'main') {
      const orderRef = (saved.basedOn || []).find((b) => b.reference?.startsWith('ServiceRequest/'))?.reference;
      if (!orderRef) return;
      const order = await store.get('ServiceRequest', orderRef.split('/')[1]);
      if (!order) return;
      const all = (await store.query('Observation', { patient: saved._patient })).filter((o) => (o.basedOn || []).some((b) => b.reference === orderRef) && SIGNED.includes(o.status));
      await resultMessage(order, all);
    }
  }

  async function list(url) {
    const direction = url.searchParams.get('direction');
    const status = url.searchParams.get('status');
    const rows = (await store.query('Hl7Message', { where: (m) => (!direction || m.direction === direction) && (!status || m.status === status) })).sort((a, b) => ((a.receivedAt || a.builtAt) < (b.receivedAt || b.builtAt) ? 1 : -1)).slice(0, 200);
    return rows.map(({ _seq, ack: a, raw, ...m }) => ({ ...m, hasAck: Boolean(a) }));
  }

  return { receive, onCommitted, list, readRaw, orderMessage, resultMessage, ctxFor };
}

export { ack, build, parse };
