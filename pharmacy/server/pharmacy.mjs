// Pharmacy verification: what the chart and the MAR need to know about a
// medication order. Verification is recorded on the order as
// extensions, set only by the pharmacy decision route (pharmacy-api.mjs):
//   urn:hospital-desktop:verified            "<pharmacist id> at <iso>"
//   urn:hospital-desktop:verification-note   the pharmacist's reasoning
//   urn:hospital-desktop:queried             an open question to the prescriber (the order waits)
//   urn:hospital-desktop:emergency-override  "<who> at <iso>: <reason>" (a STAT dose given before verification)
// Orders that were active before the verification step existed are tagged
// once at server start by migrateVerified (reason text "migrated: ...").
//
// The automatic checks at the bottom use the starter tables in catalog.mjs
// (INTERACTIONS, DOSE_RANGES, FORM_ROUTES): small, hand-entered, unverified.
// They support a simulation; they are not clinical reference.
import { lifecycleOf, VERIFIED_URL, REASON_URL } from '../../platform/server/state-machines.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';
import { MED_BY_CODE, SYSTEMS, INTERACTIONS, DOSE_RANGES, FORM_ROUTES, DOSES_PER_DAY, LAB_BY_CODE } from '../../ehr/server/catalog.mjs';
import { allergyConflict } from '../../ehr/server/safety-alerts.mjs';

export const PHARMACY_URLS = {
  verified: VERIFIED_URL,
  note: 'urn:hospital-desktop:verification-note',
  queried: 'urn:hospital-desktop:queried',
  override: 'urn:hospital-desktop:emergency-override',
};
export const MIGRATED_NOTE = 'migrated: active before pharmacy verification existed';
export const PRIORITIES = ['stat', 'urgent', 'routine'];
/** Turnaround targets in minutes (15 STAT, 60 routine; urgent sits between). */
export const TARGET_MINUTES = { stat: 15, urgent: 30, routine: 60 };

export const extString = (doc, url) => (doc?.extension || []).find((e) => e.url === url)?.valueString ?? null;

/** stat | urgent | routine from MedicationRequest.priority (FHIR "asap" counts as urgent). */
export function priorityOf(order) {
  const p = order?.priority;
  if (p === 'stat') return 'stat';
  if (p === 'urgent' || p === 'asap') return 'urgent';
  return 'routine';
}

/** True when pharmacy has verified this order (or it was migrated as verified). The MAR relies on this. */
export const isVerified = (order) => Boolean(extString(order, VERIFIED_URL)) && lifecycleOf(order) !== 'rejected';

/** The emergency override on an order, or null: { by, at, reason } parsed from the extension. */
export function emergencyOverride(order) {
  const value = extString(order, PHARMACY_URLS.override);
  if (!value) return null;
  const m = value.match(/^(.*?) at (\S+): ([\s\S]*)$/);
  return m ? { by: m[1], at: m[2], reason: m[3] } : { by: null, at: null, reason: value };
}

/** Who verified and when, or null. */
export function verifiedBy(order) {
  const value = extString(order, VERIFIED_URL);
  if (!value) return null;
  const m = value.match(/^(.*?) at (\S+)$/);
  return m ? { by: m[1], at: m[2] } : { by: value, at: null };
}

export const queriedOf = (order) => extString(order, PHARMACY_URLS.queried);

/** One plain word for the chart badge: awaiting | queried | override | verified | rejected | ordered | none. */
export function verificationState(order) {
  const state = lifecycleOf(order);
  if (state === 'rejected') return 'rejected';
  if (state === 'pending-verification') {
    if (emergencyOverride(order)) return 'override';
    return queriedOf(order) ? 'queried' : 'awaiting';
  }
  if (state === 'ordered') return 'ordered';
  return isVerified(order) ? 'verified' : 'none';
}

/** The rejection reason on a rejected order. */
export const rejectionReason = (order) => (lifecycleOf(order) === 'rejected' ? extString(order, REASON_URL) : null);

/**
 * One-off at server start: every active MedicationRequest on main without a
 * verification record is tagged as migrated, and one pharmacy.migrate step
 * records the count. Nothing to do means nothing is logged. Returns the count.
 */
export async function migrateVerified(store) {
  const actor = { kind: 'human', id: 'system', role: 'system' };
  return store.transaction(async (tx) => {
    const orders = (await tx.query('MedicationRequest', {}, { branch: 'main' })).filter((o) => lifecycleOf(o) === 'active' && !extString(o, VERIFIED_URL));
    for (const order of orders) {
      const { _seq, ...doc } = order;
      doc.extension = [...(doc.extension || []), { url: VERIFIED_URL, valueString: MIGRATED_NOTE }];
      await tx.save('MedicationRequest', doc, { branch: 'main', updatedBy: 'system' });
    }
    if (orders.length) {
      await recordAction(tx, {
        runId: LIVE_RUN_ID, actor, kind: 'update', action: 'pharmacy.migrate', args: { count: orders.length, orders: orders.map((o) => `MedicationRequest/${o.id}`).slice(0, 200) },
        why: MIGRATED_NOTE, branch: 'main', description: `${orders.length} active medication order(s) tagged as verified before pharmacy verification existed`,
      });
    }
    return orders.length;
  });
}

// ---------- Review context and automatic checks ----------
export const ISSUE_SYSTEM = 'urn:hospital-desktop:detected-issue';
export const ISSUE_CODES = ['allergy', 'duplicate-therapy', 'drug-interaction', 'dose-range', 'wrong-route'];
export const OPEN_MED_STATES = ['ordered', 'pending-verification', 'active', 'on-hold'];
const LABS = { weight: '29463-7', creatinine: '2160-0', potassium: '2823-3', inr: '6301-6', glucose: '2345-7' };

export const rxOf = (order) => (order?.medicationCodeableConcept?.coding || []).find((c) => c.system === SYSTEMS.rxnorm) || null;
export const medName = (order) => order?.medicationCodeableConcept?.text || order?.medicationCodeableConcept?.coding?.[0]?.display || rxOf(order)?.code || 'medication';
const classesOf = (code) => MED_BY_CODE.get(code)?.classes || [];
const dosage = (order) => order?.dosageInstruction?.[0] || {};
export const doseOf = (order) => { const q = dosage(order).doseAndRate?.[0]?.doseQuantity; return q && typeof q.value === 'number' ? { value: q.value, unit: q.unit || '' } : null; };
export const routeOf = (order) => dosage(order).route?.text || dosage(order).route?.coding?.[0]?.display || null;
export const frequencyOf = (order) => dosage(order).timing?.code?.text || null;

/**
 * CKD-EPI 2021 creatinine equation (race-free). creatinine in mg/dL, age in years, sex "male" | "female".
 * Returns mL/min/1.73m2 rounded to a whole number, or null when an input is missing.
 * Estimated, unverified formula transcription: for the simulation only.
 */
export function egfrCkdEpi2021({ creatinine, age, sex }) {
  if (typeof creatinine !== 'number' || creatinine <= 0 || typeof age !== 'number' || age <= 0) return null;
  const female = sex === 'female';
  const kappa = female ? 0.7 : 0.9;
  const alpha = female ? -0.241 : -0.302;
  const ratio = creatinine / kappa;
  const value = 142 * Math.min(ratio, 1) ** alpha * Math.max(ratio, 1) ** -1.2 * 0.9938 ** age * (female ? 1.012 : 1);
  return Math.round(value);
}

const ageAt = (birthDate, at) => {
  if (!birthDate) return null;
  const b = new Date(birthDate);
  const d = new Date(at);
  let years = d.getUTCFullYear() - b.getUTCFullYear();
  if (d.getUTCMonth() < b.getUTCMonth() || (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() < b.getUTCDate())) years -= 1;
  return years;
};
const loinc = (o) => (o.code?.coding || []).find((c) => c.system === SYSTEMS.loinc)?.code ?? o.code?.coding?.[0]?.code;
const latestObs = (observations, code) => observations
  .filter((o) => loinc(o) === code && !['cancelled', 'entered-in-error'].includes(o.status) && typeof o.valueQuantity?.value === 'number')
  .sort((a, b) => String(b.effectiveDateTime || b._validAt || '').localeCompare(String(a.effectiveDateTime || a._validAt || '')))[0] ?? null;
const obsSummary = (o) => (o ? { id: o.id, value: o.valueQuantity.value, unit: o.valueQuantity.unit || '', at: o.effectiveDateTime || o._validAt || null, status: o.status, flag: o.interpretation?.[0]?.coding?.[0]?.code || null } : null);

/** The patient's current inpatient encounter (in progress or arrived, class IMP first), or null. */
export function inpatientEncounter(encounters) {
  const open = encounters.filter((e) => ['in-progress', 'arrived'].includes(e.status));
  return open.find((e) => e.class?.code === 'IMP') || open.find((e) => e.class?.code === 'EMER') || null;
}
/** The unit named on the encounter's last location, else "No unit assigned". */
export const unitOf = (encounter) => { const locs = encounter?.location || []; return locs.length ? (locs[locs.length - 1].location?.display || 'No unit assigned') : 'No unit assigned'; };

/** Everything the review screen shows beside the order, read at one view (branch, asOf). */
export async function reviewContext(reader, order, { branch, asOf, now }) {
  const patientRef = order.subject?.reference;
  const opts = { branch, asOf };
  const [patientList, allergies, meds, observations, encounters] = await Promise.all([
    reader.query('Patient', { where: (p) => `Patient/${p.id}` === patientRef }, opts),
    reader.query('AllergyIntolerance', { patient: patientRef }, opts),
    reader.query('MedicationRequest', { patient: patientRef }, opts),
    reader.query('Observation', { patient: patientRef }, opts),
    reader.query('Encounter', { patient: patientRef }, opts),
  ]);
  const patient = patientList[0] || null;
  const current = meds.filter((m) => m.id !== order.id && OPEN_MED_STATES.includes(lifecycleOf(m)));
  const weight = latestObs(observations, LABS.weight);
  const creatinine = latestObs(observations, LABS.creatinine);
  const age = ageAt(patient?.birthDate, now);
  const egfr = creatinine ? egfrCkdEpi2021({ creatinine: creatinine.valueQuantity.value, age, sex: patient?.gender }) : null;
  const encounter = inpatientEncounter(encounters);
  return {
    patient, age, allergies: allergies.filter((a) => (a.clinicalStatus?.coding?.[0]?.code ?? 'active') === 'active'), currentMeds: current,
    weight: obsSummary(weight), creatinine: obsSummary(creatinine),
    egfr: egfr == null ? null : { value: egfr, unit: 'mL/min/1.73m2', formula: 'CKD-EPI 2021 (estimated, unverified formula)', from: { creatinine: creatinine.valueQuantity.value, age, sex: patient?.gender || 'unknown' } },
    labs: { potassium: obsSummary(latestObs(observations, LABS.potassium)), inr: obsSummary(latestObs(observations, LABS.inr)), glucose: obsSummary(latestObs(observations, LABS.glucose)) },
    labNames: Object.fromEntries(Object.entries(LABS).map(([k, code]) => [k, LAB_BY_CODE.get(code)?.name || k])),
    encounter: encounter ? { id: encounter.id, class: encounter.class?.code, unit: unitOf(encounter) } : null,
    setting: encounter ? 'inpatient' : 'outpatient',
  };
}

const sideMatches = (side, code, classes) => (side.code ? side.code === code : classes.includes(side.class));

// Each check returns [] or a list of { code, severity, detail, implicated: [refs] }.
export function duplicateTherapy(order, currentMeds) {
  const mine = rxOf(order);
  if (!mine) return [];
  const myClasses = classesOf(mine.code);
  const out = [];
  for (const other of currentMeds) {
    const theirs = rxOf(other);
    if (!theirs) continue;
    if (theirs.code === mine.code) out.push({ code: 'duplicate-therapy', severity: 'high', detail: `Duplicate therapy: ${medName(other)} is already ${lifecycleOf(other)} for this patient (same drug).`, implicated: [`MedicationRequest/${other.id}`] });
    else { const shared = classesOf(theirs.code).find((c) => myClasses.includes(c)); if (shared) out.push({ code: 'duplicate-therapy', severity: 'moderate', detail: `Duplicate therapy: ${medName(other)} is already ${lifecycleOf(other)} for this patient (same class: ${shared}).`, implicated: [`MedicationRequest/${other.id}`] }); }
  }
  return out;
}

export function interactions(order, currentMeds) {
  const mine = rxOf(order);
  if (!mine) return [];
  const myClasses = classesOf(mine.code);
  const out = [];
  for (const other of currentMeds) {
    const theirs = rxOf(other);
    if (!theirs) continue;
    const theirClasses = classesOf(theirs.code);
    // One finding per other medication: the first matching pair wins (pairs by code are listed before pairs by class).
    const pair = INTERACTIONS.pairs.find((x) => (sideMatches(x.a, mine.code, myClasses) && sideMatches(x.b, theirs.code, theirClasses)) || (sideMatches(x.b, mine.code, myClasses) && sideMatches(x.a, theirs.code, theirClasses)));
    if (pair) out.push({ code: 'drug-interaction', severity: pair.severity, detail: `Interaction: ${pair.a.name} + ${pair.b.name}: ${pair.detail} (with ${medName(other)}). Starter table, unverified.`, implicated: [`MedicationRequest/${other.id}`] });
  }
  return out;
}

const toUnit = (dose, unit) => {
  if (!dose) return null;
  const from = (dose.unit || '').toLowerCase();
  const to = unit.toLowerCase();
  if (from === to) return dose.value;
  if (to === 'mg' && from === 'g') return dose.value * 1000;
  if (to === 'mg' && from === 'mcg') return dose.value / 1000;
  return null;
};

export function doseRange(order, context) {
  const mine = rxOf(order);
  const range = mine ? DOSE_RANGES.byCode[mine.code] : null;
  if (!range) return [];
  const out = [];
  const single = toUnit(doseOf(order), range.unit);
  const perDay = DOSES_PER_DAY[frequencyOf(order)] ?? null;
  const kg = context.weight?.value ?? null;
  if (single != null && single > range.maxSingle) out.push({ code: 'dose-range', severity: 'high', detail: `Dose ${single} ${range.unit} is above the starter-table maximum single dose of ${range.maxSingle} ${range.unit} for ${range.name}.`, implicated: [] });
  if (single != null && perDay && single * perDay > range.maxDaily) out.push({ code: 'dose-range', severity: 'high', detail: `Daily dose ${single * perDay} ${range.unit} (${perDay} doses) is above the starter-table maximum of ${range.maxDaily} ${range.unit} per day for ${range.name}.`, implicated: [] });
  if (single != null && range.perKgSingle && kg && single / kg > range.perKgSingle) out.push({ code: 'dose-range', severity: 'moderate', detail: `Dose ${single} ${range.unit} is ${Math.round((single / kg) * 100) / 100} ${range.unit}/kg at ${kg} kg, above the starter-table ${range.perKgSingle} ${range.unit}/kg for ${range.name}.`, implicated: [context.weight?.id ? `Observation/${context.weight.id}` : null].filter(Boolean) });
  if (range.renal && context.egfr && context.egfr.value < range.renal.egfrBelow) out.push({ code: 'dose-range', severity: 'moderate', detail: `Renal function: estimated eGFR ${context.egfr.value} is below ${range.renal.egfrBelow} mL/min/1.73m2; ${range.name}: ${range.renal.note} (starter table, unverified).`, implicated: [context.creatinine?.id ? `Observation/${context.creatinine.id}` : null].filter(Boolean) });
  return out;
}

function wrongRoute(order) {
  const mine = rxOf(order);
  const med = mine ? MED_BY_CODE.get(mine.code) : null;
  const route = routeOf(order);
  if (!med || !route) return [];
  const allowed = FORM_ROUTES.byForm[med.form] || [];
  if (allowed.includes(route)) return [];
  return [{ code: 'wrong-route', severity: 'high', detail: `Route "${route}" is not valid for the ${med.form} form of ${med.name} (valid: ${allowed.join(', ')}).`, implicated: [] }];
}

/** Runs every automatic check for an order against its review context. */
export async function runChecks(tx, order, context, branch) {
  const found = [];
  const allergy = await allergyConflict(tx, order, branch);
  if (allergy) found.push({ code: 'allergy', severity: allergy.criticality === 'high' ? 'high' : 'moderate', detail: allergy.message, implicated: [allergy.existing] });
  found.push(...duplicateTherapy(order, context.currentMeds), ...interactions(order, context.currentMeds), ...doseRange(order, context), ...wrongRoute(order));
  return found;
}

/** The FHIR DetectedIssue for one finding. */
export function detectedIssue(order, finding, now) {
  return {
    resourceType: 'DetectedIssue', status: 'preliminary',
    code: { coding: [{ system: ISSUE_SYSTEM, code: finding.code }], text: finding.detail.slice(0, 80) },
    severity: finding.severity, patient: order.subject, identifiedDateTime: now, detail: finding.detail,
    implicated: [{ reference: `MedicationRequest/${order.id}` }, ...finding.implicated.map((reference) => ({ reference }))],
  };
}
