// Nursing rules: medication due times and the five rights
// for the MAR, the early-warning score written from a vitals set, intake and
// output totals, and the work list derived from orders and schedules.
// Pure functions where possible; the transactional pieces take a tx.
import { HttpError } from '../../platform/server/http.mjs';
import { SYSTEMS, MED_BY_CODE, isHighAlert, ASSESSMENT_BY_CODE, ASSESSMENT_SYSTEM, IO_SYSTEM, IO_ITEMS, VITAL_BY_CODE } from './catalog.mjs';
import { lifecycleOf } from '../../platform/server/state-machines.mjs';
import { isVerified, emergencyOverride, rxOf, doseOf, routeOf, frequencyOf } from '../../pharmacy/server/pharmacy.mjs';
import { scoreNews2, needsEscalation } from './news2.mjs';
import { mrnOf } from './clinical-rules.mjs';

export const NURSING_URLS = {
  due: 'urn:hospital-desktop:due-time',
  late: 'urn:hospital-desktop:late-minutes',
  witness: 'urn:hospital-desktop:witness',
  prnReason: 'urn:hospital-desktop:prn-reason',
  scan: 'urn:hospital-desktop:scanned',
  nurseAck: 'urn:hospital-desktop:nurse-acknowledged',
  spo2Scale: 'urn:hospital-desktop:spo2-scale',
  taught: 'urn:hospital-desktop:education',
  evaluation: 'urn:hospital-desktop:care-plan-evaluation',
};
export const SCORE_SYSTEM = 'urn:hospital-desktop:score';
export const NEWS2_CODE = 'news2';
export const TASK_SYSTEM = 'urn:hospital-desktop:task';
export const WINDOW_MINUTES = 60;
export const LATE_MINUTES = 60;
export const VITALS_INTERVAL_HOURS = 4;

// Standard administration times per frequency (local-clock hours). A starter convention, not a formulary rule.
export const SCHEDULE_HOURS = { daily: [9], BID: [9, 21], TID: [9, 14, 21], QID: [9, 13, 17, 21], nightly: [21], Q4H: [2, 6, 10, 14, 18, 22], Q6H: [0, 6, 12, 18], Q8H: [6, 14, 22] };
export const SHIFTS = [{ id: 'day', label: 'Day (07:00 to 18:59)', start: 7, end: 19 }, { id: 'night', label: 'Night (19:00 to 06:59)', start: 19, end: 7 }];

const MIN = 60000;
const hasCat = (o, code) => (o.category || []).some((c) => (c.coding || []).some((x) => x.code === code));
const codeOf = (o, system) => (o.code?.coding || []).find((c) => !system || c.system === system)?.code ?? null;
export const loincOf = (o) => codeOf(o, SYSTEMS.loinc);
const whenOf = (o) => o.effectiveDateTime || o._validAt || o._recordedAt;
const extString = (doc, url) => (doc?.extension || []).find((e) => e.url === url)?.valueString ?? null;
const withExt = (doc, url, key, value) => ({ ...doc, extension: [...(doc.extension || []).filter((e) => e.url !== url), ...(value == null ? [] : [{ url, [key]: value }])] });

/** Which MAR section an order belongs to: scheduled, prn or continuous. */
export function sectionOf(order) {
  const freq = frequencyOf(order);
  const dosage = order.dosageInstruction?.[0] || {};
  if (dosage.doseAndRate?.[0]?.rateQuantity || dosage.doseAndRate?.[0]?.rateRatio || /infusion|continuous/i.test(dosage.text || '')) return 'continuous';
  if (freq === 'PRN' || dosage.asNeededBoolean) return 'prn';
  return 'scheduled';
}

/** Due times (ISO) for an order inside [from, to). `once` is due at its authored time. */
export function dueTimes(order, from, to) {
  const section = sectionOf(order);
  if (section !== 'scheduled') return [];
  const freq = frequencyOf(order);
  const start = Date.parse(order.authoredOn || order._recordedAt || from);
  if (freq === 'once') return start >= Date.parse(from) && start < Date.parse(to) ? [new Date(start).toISOString()] : [];
  const hours = SCHEDULE_HOURS[freq] || SCHEDULE_HOURS.daily;
  const out = [];
  const day = new Date(from); day.setHours(0, 0, 0, 0);
  for (let d = 0; d < 3; d += 1) {
    for (const hour of hours) {
      const at = new Date(day); at.setDate(day.getDate() + d); at.setHours(hour, 0, 0, 0);
      const t = at.getTime();
      if (t >= Date.parse(from) && t < Date.parse(to) && t >= start - WINDOW_MINUTES * MIN) out.push(at.toISOString());
    }
  }
  return out.sort();
}

/** The shift window containing `at` (local clock). */
export function shiftWindow(at = new Date(), which = null) {
  const d = new Date(at);
  const dayStart = new Date(d); dayStart.setHours(7, 0, 0, 0);
  const inDay = d.getHours() >= 7 && d.getHours() < 19;
  let id = which || (inDay ? 'day' : 'night');
  let start;
  if (id === 'day') { start = new Date(dayStart); if (!inDay && d.getHours() < 7) start.setDate(start.getDate() - 1); }
  else { start = new Date(dayStart); start.setHours(19); if (d.getHours() < 7) start.setDate(start.getDate() - 1); }
  const end = new Date(start); end.setHours(start.getHours() + 12);
  return { id, start: start.toISOString(), end: end.toISOString() };
}

const administrationsFor = (admins, order) => admins.filter((a) => a.request?.reference === `MedicationRequest/${order.id}` && a.status !== 'entered-in-error');

/** Cell state for a due time: due, given, late, held, refused, not-given, missed. */
export function cellState(order, due, admins, now) {
  const mine = administrationsFor(admins, order).filter((a) => extString(a, NURSING_URLS.due) === due);
  const a = mine.sort((x, y) => (x._recordedAt < y._recordedAt ? 1 : -1))[0];
  if (a) {
    if (a.status === 'completed') return { state: Number(extString(a, NURSING_URLS.late)) > 0 ? 'late' : 'given', record: a };
    if (a.status === 'on-hold') return { state: 'held', record: a };
    if (a.status === 'not-done') return { state: /refus/i.test(extString(a, 'urn:hospital-desktop:status-reason') || a.statusReason?.[0]?.text || '') ? 'refused' : 'not-given', record: a };
    return { state: a.status, record: a };
  }
  const overdue = Date.parse(now) - Date.parse(due) > LATE_MINUTES * MIN;
  return { state: overdue ? 'missed' : 'due', record: null };
}

/** The MAR grid for one patient and shift. */
export function marGrid({ orders, admins, now, shift }) {
  const window = shiftWindow(now, shift);
  const open = orders.filter((o) => ['active', 'on-hold', 'pending-verification'].includes(lifecycleOf(o)));
  const rows = open.map((o) => {
    const section = sectionOf(o);
    const dues = dueTimes(o, window.start, window.end);
    const given = administrationsFor(admins, o).filter((a) => a.status === 'completed' && whenOf(a) >= window.start && whenOf(a) < window.end);
    return {
      id: o.id, section, medication: o.medicationCodeableConcept?.text || o.medicationCodeableConcept?.coding?.[0]?.display || 'Medication', rxnorm: rxOf(o)?.code ?? null,
      dose: doseOf(o), route: routeOf(o), frequency: frequencyOf(o), sig: o.dosageInstruction?.[0]?.text || '',
      lifecycle: lifecycleOf(o), verified: isVerified(o), emergencyOverride: Boolean(emergencyOverride(o)), highAlert: Boolean(rxOf(o) && isHighAlert(rxOf(o).code)),
      cells: dues.map((due) => ({ due, ...cellState(o, due, admins, now) })),
      givenThisShift: given.map((a) => ({ id: a.id, at: whenOf(a), dose: a.dosage?.dose?.value ?? null, by: a.performer?.[0]?.actor?.display ?? null })),
    };
  });
  const order = { scheduled: 0, prn: 1, continuous: 2 };
  rows.sort((a, b) => order[a.section] - order[b.section] || a.medication.localeCompare(b.medication));
  return { shift: window, hours: Array.from({ length: 12 }, (_, i) => (new Date(window.start).getHours() + i) % 24), rows };
}

/** The five rights, checked on the server. Returns the list of failures (empty when all pass). */
export function fiveRights({ order, patient, body, now }) {
  const failures = [];
  const mrn = mrnOf(patient);
  if (!body.patientScan || String(body.patientScan).trim() !== mrn) failures.push({ right: 'patient', message: `Wrong patient: the wristband scan "${body.patientScan || ''}" does not match MRN ${mrn}` });
  const rx = rxOf(order);
  if (!body.medicationScan || !rx || String(body.medicationScan).trim() !== rx.code) failures.push({ right: 'medication', message: `Wrong medication: the scanned code "${body.medicationScan || ''}" does not match the order (RxNorm ${rx?.code || 'none'})` });
  const dose = doseOf(order);
  if (dose && (Number(body.dose) !== dose.value || (body.unit && body.unit !== dose.unit))) failures.push({ right: 'dose', message: `Wrong dose: ordered ${dose.value} ${dose.unit}, entered ${body.dose ?? ''} ${body.unit ?? ''}` });
  const route = routeOf(order);
  if (route && body.route && String(body.route).toLowerCase() !== route.toLowerCase()) failures.push({ right: 'route', message: `Wrong route: ordered ${route}, entered ${body.route}` });
  if (sectionOf(order) === 'scheduled' && body.due) {
    const diff = Math.abs(Date.parse(now) - Date.parse(body.due));
    if (diff > WINDOW_MINUTES * MIN) failures.push({ right: 'time', message: `Outside the time window: due ${body.due}, now ${now} (${Math.round(diff / MIN)} minutes apart; the window is ${WINDOW_MINUTES} minutes either side)` });
  }
  return failures;
}

/** Builds the MedicationAdministration for an outcome. */
export function administrationDoc({ order, patient, body, actor, now, late }) {
  const outcome = body.outcome;
  const status = { given: 'completed', held: 'on-hold', refused: 'not-done', 'not-given': 'not-done', started: 'in-progress' }[outcome];
  if (!status) throw new HttpError(422, 'outcome must be given, started, held, refused or not-given');
  const reason = body.reason ? String(body.reason).trim() : null;
  if (outcome !== 'given' && outcome !== 'started' && !reason) throw new HttpError(422, `A reason is required when a dose is ${outcome.replace('-', ' ')}`);
  const dose = doseOf(order);
  let doc = {
    resourceType: 'MedicationAdministration', status, subject: { reference: `Patient/${patient.id}` }, request: { reference: `MedicationRequest/${order.id}` },
    medicationCodeableConcept: order.medicationCodeableConcept, effectiveDateTime: now,
    performer: [{ actor: { display: actor.id } }, ...(body.witness ? [{ function: { text: 'witness' }, actor: { display: String(body.witness).trim() } }] : [])],
    ...(status === 'completed' || status === 'in-progress' ? { dosage: { text: order.dosageInstruction?.[0]?.text, dose: dose ? { value: Number(body.dose ?? dose.value), unit: body.unit || dose.unit } : undefined, route: { text: body.route || routeOf(order) || undefined }, ...(body.site ? { site: { text: String(body.site) } } : {}) } } : {}),
    ...(reason ? { statusReason: [{ text: `${outcome}: ${reason}` }] } : {}),
    note: body.note ? [{ text: String(body.note).slice(0, 1000) }] : undefined,
  };
  if (body.due) doc = withExt(doc, NURSING_URLS.due, 'valueString', body.due);
  if (late > 0) doc = withExt(doc, NURSING_URLS.late, 'valueString', String(late));
  if (body.prnReason) doc = withExt(doc, NURSING_URLS.prnReason, 'valueString', String(body.prnReason).trim());
  if (body.witness) doc = withExt(doc, NURSING_URLS.witness, 'valueString', String(body.witness).trim());
  doc = withExt(doc, NURSING_URLS.scan, 'valueString', `patient:${body.patientScan || ''} medication:${body.medicationScan || ''}`);
  if (reason) doc = withExt(doc, 'urn:hospital-desktop:status-reason', 'valueString', `${outcome}: ${reason}`);
  return doc;
}

// ---------- Early-warning score from a vitals set ----------
const NEWS2_INPUT = { '9279-1': 'respirationRate', '59408-5': 'spo2', '8480-6': 'systolic', '8867-4': 'pulse', '8310-5': 'temperature' };

/** Gathers the latest value of each NEWS2 parameter within `windowMinutes` of `at`. */
export function news2Inputs(observations, at, windowMinutes = WINDOW_MINUTES) {
  const near = observations.filter((o) => ['final', 'corrected', 'amended'].includes(o.status) && Math.abs(Date.parse(whenOf(o)) - Date.parse(at)) <= windowMinutes * MIN)
    .sort((a, b) => (whenOf(a) < whenOf(b) ? 1 : -1));
  const input = {};
  const sources = [];
  const take = (key, o, value) => { if (input[key] === undefined && value !== undefined && value !== null) { input[key] = value; sources.push(o); } };
  for (const o of near) {
    const loinc = loincOf(o);
    if (NEWS2_INPUT[loinc]) take(NEWS2_INPUT[loinc], o, o.valueQuantity?.value);
    if (loinc === '59408-5' && extString(o, NURSING_URLS.spo2Scale)) input.spo2Scale = Number(extString(o, NURSING_URLS.spo2Scale));
    const local = codeOf(o, ASSESSMENT_SYSTEM);
    if (local === 'acvpu') take('consciousness', o, o.valueCodeableConcept?.coding?.[0]?.code ?? o.valueString);
    if (local === 'o2-device') take('supplementalOxygen', o, !/room air/i.test(o.valueString || o.valueCodeableConcept?.text || ''));
    if (loinc === '3151-8' && input.supplementalOxygen === undefined) take('supplementalOxygen', o, Number(o.valueQuantity?.value) > 0);
  }
  return { input, sources };
}

export function news2Observation({ patientRef, encounterRef, at, score, sources }) {
  return {
    resourceType: 'Observation', status: 'final', category: [{ coding: [{ system: SYSTEMS.obsCategory, code: 'survey' }] }],
    code: { coding: [{ system: SCORE_SYSTEM, code: NEWS2_CODE, display: 'NEWS2 early-warning score' }], text: 'NEWS2 (decision support in a simulation)' },
    subject: { reference: patientRef }, ...(encounterRef ? { encounter: { reference: encounterRef } } : {}), effectiveDateTime: at,
    ...(score.incomplete ? { dataAbsentReason: { text: `Incomplete: missing ${score.missing.join(', ')}` } } : { valueInteger: score.total }),
    interpretation: [{ coding: [{ system: SCORE_SYSTEM, code: score.incomplete ? 'incomplete' : score.band, display: score.response }] }],
    component: Object.entries(score.components).map(([k, v]) => ({ code: { text: k }, valueInteger: v })),
    derivedFrom: sources.map((o) => ({ reference: `Observation/${o.id}` })),
    note: [{ text: `Scoring bands from the Royal College of Physicians NEWS2 chart (2017). Decision support inside a simulation, not clinical advice. SpO2 scale ${score.scale ?? 1}.` }],
  };
}

/** Called from clinical-rules.afterSave for every saved vital-sign or assessment Observation. */
export async function deriveNews2(tx, saved, ctx, write) {
  if (codeOf(saved, SCORE_SYSTEM) === NEWS2_CODE) return;
  const relevant = NEWS2_INPUT[loincOf(saved)] || ['acvpu', 'o2-device'].includes(codeOf(saved, ASSESSMENT_SYSTEM)) || loincOf(saved) === '3151-8';
  if (!relevant || !['final', 'corrected', 'amended'].includes(saved.status)) return;
  const at = whenOf(saved);
  const all = await tx.query('Observation', { patient: saved._patient }, { branch: ctx.branch });
  const { input, sources } = news2Inputs(all, at);
  const score = scoreNews2(input);
  const existing = all.filter((o) => codeOf(o, SCORE_SYSTEM) === NEWS2_CODE && Math.abs(Date.parse(whenOf(o)) - Date.parse(at)) <= WINDOW_MINUTES * MIN).sort((a, b) => (a._recordedAt < b._recordedAt ? 1 : -1))[0];
  // An incomplete set is never stored as a score: the flowsheet says "not scored" and the response names what is missing.
  if (score.incomplete && !existing) return;
  const same = existing && (existing.valueInteger ?? null) === (score.total ?? null) && (existing.derivedFrom || []).length === sources.length && (existing.dataAbsentReason ? score.incomplete : !score.incomplete);
  if (same) return;
  const { _seq, ...prev } = existing || {};
  const doc = { ...(existing ? { id: existing.id, meta: prev.meta } : {}), ...news2Observation({ patientRef: saved._patient, encounterRef: saved.encounter?.reference, at: existing?.effectiveDateTime || at, score, sources }) };
  const scoreObs = await write('Observation', doc, { description: score.incomplete ? 'NEWS2 incomplete' : `NEWS2 ${score.total} (${score.band})` });
  if (!needsEscalation(score)) return;
  const tasks = await tx.query('Task', { patient: saved._patient, where: (t) => t.code?.coding?.some((c) => c.code === 'news2-escalation') && ['requested', 'ready', 'accepted', 'in-progress'].includes(t.status) }, { branch: ctx.branch });
  if (tasks.some((t) => t.focus?.reference === `Observation/${scoreObs.id}`)) return;
  await write('Task', {
    resourceType: 'Task', status: 'requested', intent: 'order', priority: score.total >= 7 ? 'stat' : 'urgent', authoredOn: tx.now(), for: { reference: saved._patient },
    focus: { reference: `Observation/${scoreObs.id}` }, code: { coding: [{ system: TASK_SYSTEM, code: 'news2-escalation' }], text: `NEWS2 ${score.total}: ${score.response}` },
    description: `Early-warning score ${score.total}${score.singleThree ? ' with a single parameter scoring 3' : ''}. ${score.response}. Review the patient.`,
    owner: { display: 'Physician' }, requester: { display: 'NEWS2 (system)' },
  }, { description: `escalation task for NEWS2 ${score.total}` });
}

// ---------- Intake and output ----------
export function ioObservation({ patientRef, encounterRef, item, mL, at, note }) {
  const spec = IO_ITEMS.find((i) => i.code === item);
  if (!spec) throw new HttpError(422, `Unknown intake/output item "${item}". Known: ${IO_ITEMS.map((i) => i.code).join(', ')}`);
  const volume = Number(mL);
  if (!Number.isFinite(volume) || volume < 0 || volume > 10000) throw new HttpError(422, 'Volume must be a number of millilitres between 0 and 10000');
  return {
    resourceType: 'Observation', status: 'final', category: [{ coding: [{ system: 'urn:hospital-desktop:category', code: 'intake-output' }] }],
    code: { coding: [{ system: IO_SYSTEM, code: spec.code, display: spec.name }], text: `${spec.direction === 'in' ? 'Intake' : 'Output'}: ${spec.name}` },
    subject: { reference: patientRef }, ...(encounterRef ? { encounter: { reference: encounterRef } } : {}), effectiveDateTime: at,
    valueQuantity: { value: volume, unit: 'mL', system: 'http://unitsofmeasure.org', code: 'mL' }, ...(note ? { note: [{ text: String(note).slice(0, 500) }] } : {}),
  };
}

/** Shift and 24-hour totals with a running balance since admission (or since the first entry). */
export function ioTotals(observations, now, { admissionStart = null } = {}) {
  const items = observations.filter((o) => hasCat(o, 'intake-output') && o.status !== 'cancelled' && o.status !== 'entered-in-error');
  const dir = (o) => IO_ITEMS.find((i) => i.code === codeOf(o, IO_SYSTEM))?.direction || 'in';
  const sum = (list) => { const t = { in: 0, out: 0, byItem: {} }; for (const o of list) { const v = o.valueQuantity?.value || 0; t[dir(o)] += v; const c = codeOf(o, IO_SYSTEM); t.byItem[c] = (t.byItem[c] || 0) + v; } t.balance = t.in - t.out; return t; };
  const within = (start, end) => items.filter((o) => whenOf(o) >= start && whenOf(o) < end);
  const current = shiftWindow(now);
  const previous = shiftWindow(new Date(Date.parse(current.start) - MIN), current.id === 'day' ? 'night' : 'day');
  const dayStart = new Date(now); dayStart.setHours(7, 0, 0, 0); if (Date.parse(dayStart) > Date.parse(now)) dayStart.setDate(dayStart.getDate() - 1);
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
  const since = admissionStart || items.map(whenOf).sort()[0] || now;
  return {
    currentShift: { ...current, ...sum(within(current.start, current.end)) },
    previousShift: { ...previous, ...sum(within(previous.start, previous.end)) },
    last24h: { start: dayStart.toISOString(), end: dayEnd.toISOString(), ...sum(within(dayStart.toISOString(), dayEnd.toISOString())) },
    // An entry recorded during the admission counts even when its clock time was rounded to a minute before the admission started.
    sinceAdmission: { start: since, ...sum(items.filter((o) => whenOf(o) >= since || (o._recordedAt || '') >= since)) },
    hourly: Object.entries(items.reduce((acc, o) => { const hour = whenOf(o).slice(0, 13); acc[hour] = acc[hour] || { in: 0, out: 0 }; acc[hour][dir(o)] += o.valueQuantity?.value || 0; return acc; }, {})).sort().map(([hour, v]) => ({ hour: `${hour}:00`, ...v, balance: v.in - v.out })),
  };
}

// ---------- Work list ----------
const OPEN_TASK = ['requested', 'ready', 'accepted', 'in-progress'];
const isLabOrder = (o) => (o.category || []).some((c) => (c.coding || []).some((x) => x.code === 'laboratory') || /lab/i.test(c.text || ''));

/** Time-ordered items for one patient: what is due and what is overdue, each with the form to open. */
export function worklistFor({ patient, encounter, orders, medOrders, admins, observations, tasks, now }) {
  const items = [];
  const nowMs = Date.parse(now);
  const window = shiftWindow(now);
  for (const o of medOrders.filter((m) => lifecycleOf(m) === 'active')) {
    for (const due of dueTimes(o, window.start, window.end)) {
      const { state } = cellState(o, due, admins, now);
      if (['due', 'missed'].includes(state) && Date.parse(due) <= nowMs + 2 * 3600000) items.push({ kind: 'medication', label: `Give ${o.medicationCodeableConcept?.text || o.medicationCodeableConcept?.coding?.[0]?.display || 'medication'}`, due, overdue: state === 'missed', ref: `MedicationRequest/${o.id}`, open: 'mar' });
    }
  }
  const vitalsTimes = observations.filter((o) => hasCat(o, 'vital-signs') && ['final', 'corrected', 'amended'].includes(o.status)).map(whenOf).sort();
  const lastVitals = vitalsTimes[vitalsTimes.length - 1] || null;
  const latestScore = observations.filter((o) => codeOf(o, SCORE_SYSTEM) === NEWS2_CODE).sort((a, b) => (whenOf(a) < whenOf(b) ? 1 : -1))[0];
  const interval = latestScore && (latestScore.valueInteger ?? 0) >= 5 ? 1 : latestScore && (latestScore.valueInteger ?? 0) >= 1 ? 4 : VITALS_INTERVAL_HOURS;
  const vitalsDue = lastVitals ? new Date(Date.parse(lastVitals) + interval * 3600000).toISOString() : now;
  items.push({ kind: 'vitals', label: lastVitals ? `Vitals due (every ${interval} h)` : 'Vitals: none recorded this admission', due: vitalsDue, overdue: Date.parse(vitalsDue) < nowMs - 30 * MIN, ref: null, open: 'flowsheets' });
  for (const o of orders.filter((x) => ['active', 'results-received'].includes(lifecycleOf(x)))) {
    if (!extString(o, NURSING_URLS.nurseAck)) items.push({ kind: 'acknowledge', label: `Acknowledge order: ${o.code?.text || o.code?.coding?.[0]?.display || 'order'}`, due: o.authoredOn || o._recordedAt, overdue: nowMs - Date.parse(o.authoredOn || o._recordedAt) > 60 * MIN, ref: `ServiceRequest/${o.id}`, open: 'orders' });
    if (isLabOrder(o) && lifecycleOf(o) === 'active' && !observations.some((r) => (r.basedOn || []).some((b) => b.reference === `ServiceRequest/${o.id}`))) {
      items.push({ kind: 'specimen', label: `Collect specimen: ${o.code?.text || o.code?.coding?.[0]?.display || 'lab order'}`, due: o.authoredOn || o._recordedAt, overdue: nowMs - Date.parse(o.authoredOn || o._recordedAt) > 4 * 3600000, ref: `ServiceRequest/${o.id}`, open: 'orders' });
    }
  }
  for (const t of tasks.filter((x) => OPEN_TASK.includes(x.status))) {
    const code = t.code?.coding?.[0]?.code;
    const due = t.restriction?.period?.end || t.authoredOn || t._recordedAt;
    items.push({ kind: code === 'news2-escalation' ? 'escalation' : code === 'prn-follow-up' ? 'assessment' : 'task', label: t.code?.text || t.description || 'Task', due, overdue: Date.parse(due) < nowMs, ref: `Task/${t.id}`, open: code === 'prn-follow-up' ? 'flowsheets' : 'worklist', priority: t.priority || null });
  }
  items.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
  return { patient: { id: patient.id, name: `${patient.name?.[0]?.family || ''}`.trim(), mrn: mrnOf(patient) }, unit: encounter?.location?.find((l) => l.status === 'active')?.location?.display || null, encounter: encounter ? `Encounter/${encounter.id}` : null, latestNews2: latestScore ? { total: latestScore.valueInteger ?? null, band: latestScore.interpretation?.[0]?.coding?.[0]?.code ?? null, at: whenOf(latestScore) } : null, items, overdue: items.filter((i) => i.overdue).length };
}

export { VITAL_BY_CODE, ASSESSMENT_BY_CODE, MED_BY_CODE };
