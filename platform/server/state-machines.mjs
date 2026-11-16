// Clinical state machines, enforced on every FHIR write on the server.
// Where a lifecycle has more states than the FHIR status code allows, the
// exact state is kept in an extension and the FHIR status is kept in step.
import { HttpError } from './http.mjs';
import { isControlled, SYSTEMS } from '../../ehr/server/catalog.mjs';
import { criticalIssue, unfilled as unfilledFields } from '../../pacs/server/report-templates.mjs';

export const LIFECYCLE_URL = 'urn:hospital-desktop:lifecycle';
export const REASON_URL = 'urn:hospital-desktop:status-reason';
// Set by the pharmacy decision route only (pharmacy/server/pharmacy.mjs); a plain write cannot add or remove it.
export const VERIFIED_URL = 'urn:hospital-desktop:verified';
export const REPORT_URLS = {
  technique: 'urn:hospital-desktop:report-technique',
  findings: 'urn:hospital-desktop:report-findings',
  addendumOf: 'urn:hospital-desktop:addendum-of',
};

// Beds. The exact state lives in the lifecycle extension; the FHIR
// operationalStatus (HL7 v2 table 0116) is kept in step with it.
export const PHYSICAL_TYPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/location-physical-type';
export const OPERATIONAL_STATUS_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v2-0116';
export const BED_STATES = ['available', 'occupied', 'cleaning', 'blocked', 'reserved'];
export const BED_TO_OPERATIONAL = {
  available: { code: 'U', display: 'Unoccupied' }, occupied: { code: 'O', display: 'Occupied' }, cleaning: { code: 'K', display: 'Contaminated' },
  blocked: { code: 'C', display: 'Closed' }, reserved: { code: 'U', display: 'Unoccupied (reserved)' },
};
const OPERATIONAL_TO_BED = { U: 'available', O: 'occupied', K: 'cleaning', H: 'cleaning', C: 'blocked', I: 'blocked' };
export const isBed = (doc) => doc?.resourceType === 'Location' && (doc.physicalType?.coding || []).some((c) => c.code === 'bd');

const ext = (doc, url) => (doc.extension || []).find((e) => e.url === url)?.valueString
  ?? (doc.extension || []).find((e) => e.url === url)?.valueCode ?? null;

export function withExtension(doc, url, key, value) {
  const extension = (doc.extension || []).filter((e) => e.url !== url);
  if (value != null && value !== '') extension.push({ url, [key]: value });
  const out = { ...doc, extension };
  if (!extension.length) delete out.extension;
  return out;
}

const isLab = (doc) => (doc.category || []).some((c) => (c.coding || []).some((x) => x.code === 'laboratory'));

const byStatus = (field) => ({
  get: (doc) => doc[field],
  set: (doc, state) => ({ ...doc, [field]: state }),
});

const byExtension = (toFhir, fromFhir) => ({
  get: (doc) => ext(doc, LIFECYCLE_URL) ?? fromFhir[doc.status] ?? doc.status,
  set: (doc, state) => ({ ...withExtension(doc, LIFECYCLE_URL, 'valueCode', state), status: toFhir[state] }),
});

export const MACHINES = {
  // Pharmacy verification: an order waits in pending-verification until a pharmacist
  // verifies it (active) or rejects it (rejected, FHIR status cancelled, reason required). Only the pharmacy
  // decision route adds the verified extension, so nothing else can move an order out of pending-verification.
  MedicationRequest: {
    ...byExtension(
      { ordered: 'draft', 'pending-verification': 'draft', active: 'active', 'on-hold': 'on-hold', completed: 'completed', discontinued: 'stopped', cancelled: 'cancelled', rejected: 'cancelled' },
      { draft: 'ordered', stopped: 'discontinued' },
    ),
    initial: () => ['ordered', 'pending-verification'],
    transitions: {
      ordered: ['pending-verification', 'cancelled'],
      'pending-verification': ['active', 'rejected', 'cancelled'],
      active: ['completed', 'discontinued', 'on-hold', 'cancelled'],
      'on-hold': ['active', 'discontinued', 'cancelled'],
    },
    reasonRequired: ['completed', 'discontinued', 'cancelled', 'rejected'],
    guard(prev, next) {
      const from = prev ? MACHINES.MedicationRequest.get(prev) : null;
      const to = MACHINES.MedicationRequest.get(next);
      if (from === 'pending-verification' && to === 'active' && !ext(next, VERIFIED_URL)) {
        throw new HttpError(422, 'A medication order becomes active only through pharmacy verification (POST /api/pharmacy/orders/{id}/decision)');
      }
    },
  },
  ServiceRequest: {
    ...byExtension(
      { draft: 'draft', active: 'active', 'results-received': 'active', 'report-signed': 'active', completed: 'completed', cancelled: 'revoked', revoked: 'revoked' },
      {},
    ),
    initial: () => ['draft', 'active'],
    transitions: {
      draft: ['active', 'cancelled'],
      active: ['results-received', 'report-signed', 'revoked'],
      'results-received': ['completed'],
      'report-signed': ['completed'],
    },
    reasonRequired: ['cancelled', 'revoked'],
  },
  Observation: {
    ...byStatus('status'),
    initial: (doc) => (isLab(doc) ? ['registered', 'preliminary'] : ['registered', 'preliminary', 'final']),
    transitions: {
      registered: ['preliminary', 'cancelled'],
      preliminary: ['final', 'cancelled'],
      final: ['corrected', 'amended'],
      corrected: ['corrected', 'amended'],
      amended: ['corrected', 'amended'],
    },
    guard(prev, next) {
      if (!prev || !['final', 'corrected', 'amended'].includes(prev.status)) return;
      const changed = JSON.stringify(prev.valueQuantity ?? prev.valueString ?? null) !== JSON.stringify(next.valueQuantity ?? next.valueString ?? null);
      if (changed && next.status !== 'corrected') {
        throw new HttpError(422, 'A final result can only change value as a correction (status "corrected"); the prior version is kept');
      }
    },
  },
  DiagnosticReport: {
    ...byStatus('status'),
    initial: () => ['registered', 'partial', 'preliminary'],
    transitions: {
      registered: ['partial', 'preliminary', 'cancelled'],
      partial: ['preliminary', 'final', 'cancelled'],
      preliminary: ['final', 'cancelled'],
      final: ['amended', 'corrected', 'appended'],
      amended: ['amended', 'corrected', 'appended'],
      corrected: ['amended', 'corrected', 'appended'],
      appended: ['amended', 'corrected', 'appended'],
    },
    guard(prev, next) {
      const signed = (s) => ['final', 'amended', 'corrected', 'appended'].includes(s);
      const PATH = ['urn:hospital-desktop:report-clinical', 'urn:hospital-desktop:report-gross', 'urn:hospital-desktop:report-micro', 'urn:hospital-desktop:report-comment', 'urn:hospital-desktop:report-synoptic'];
      const sections = (d) => [ext(d, REPORT_URLS.technique), ext(d, REPORT_URLS.findings), d.conclusion, ...PATH.map((u) => ext(d, u))].map((s) => (s || '').trim());
      const isPathology = (d) => (d.category || []).some((c) => (c.coding || []).some((x) => x.code === 'pathology'));
      const addendum = Boolean(ext(next, REPORT_URLS.addendumOf));
      const isEcg = (d) => (d.category || []).some((c) => (c.coding || []).some((x) => x.code === 'ecg'));
      if (signed(next.status) && !(prev && signed(prev.status)) && isEcg(next) && !(next.conclusion || '').trim()) throw new HttpError(422, 'An ECG interpretation needs text before it can be signed');
      if (signed(next.status) && !(prev && signed(prev.status)) && isPathology(next)) {
        // Plan E.4: a final diagnosis is required; a flagged critical or unexpected diagnosis must document who was told and when.
        if (addendum) { if (!(ext(next, REPORT_URLS.findings) || '').trim()) throw new HttpError(422, 'An addendum needs text before it can be signed'); }
        else {
          if (!(next.conclusion || '').trim()) throw new HttpError(422, 'A final diagnosis is required before a pathology report can be signed');
          const critical = (next.extension || []).find((e) => e.url === 'urn:hospital-desktop:report-critical')?.valueBoolean;
          let told = null; try { told = JSON.parse(ext(next, 'urn:hospital-desktop:critical-communicated') || 'null'); } catch { told = null; }
          if (critical && !(told && told.to && told.at)) throw new HttpError(422, 'A critical or unexpected diagnosis must document who was told and when before signing');
        }
      }
      if (signed(next.status) && !(prev && signed(prev.status)) && next.imagingStudy?.length) {
        const [technique, findings, impression] = sections(next);
        if (addendum ? !findings : !(technique && findings && impression)) {
          throw new HttpError(422, addendum ? 'An addendum needs text before it can be signed' : 'Technique, Findings and Impression are all required before a report can be signed');
        }
        // Reporting workspace (plan-master task 3C): template fields still in brackets block signing; a critical finding needs who was told, how and when.
        if (!addendum) {
          const open = unfilledFields({ technique, findings, impression });
          if (open.length) throw new HttpError(422, `Fill or remove the template fields before signing: ${open.slice(0, 3).map((f) => f.field).join(', ')}${open.length > 3 ? ` and ${open.length - 3} more` : ''}`);
          const issue = criticalIssue(next);
          if (issue) throw new HttpError(422, issue);
        }
      }
      if (prev && signed(prev.status) && JSON.stringify(sections(prev)) !== JSON.stringify(sections(next))) {
        throw new HttpError(422, 'A signed report is locked. Add an addendum instead.');
      }
    },
  },
  DocumentReference: {
    get: (doc) => doc.docStatus ?? 'preliminary',
    set: (doc, state) => ({ ...doc, docStatus: state }),
    initial: () => ['preliminary'],
    transitions: { preliminary: ['final', 'entered-in-error'], final: ['amended'] },
    guard(prev, next) {
      if (!prev || !['final', 'amended'].includes(prev.docStatus)) return;
      for (const field of ['content', 'type', 'subject', 'description', 'author']) {
        if (JSON.stringify(prev[field] ?? null) !== JSON.stringify(next[field] ?? null)) {
          throw new HttpError(422, 'Signed notes cannot be edited. Add an addendum instead.');
        }
      }
    },
  },
  Encounter: {
    ...byStatus('status'),
    initial: () => ['planned', 'arrived', 'in-progress'],
    transitions: {
      planned: ['arrived', 'cancelled'],
      arrived: ['in-progress', 'cancelled'],
      'in-progress': ['finished', 'cancelled'],
    },
  },
  Appointment: {
    ...byStatus('status'),
    initial: () => ['proposed', 'pending', 'booked'],
    transitions: {
      proposed: ['booked', 'cancelled'],
      pending: ['booked', 'cancelled'],
      booked: ['arrived', 'cancelled', 'noshow'],
      arrived: ['fulfilled', 'cancelled'],
    },
  },
  Task: {
    ...byStatus('status'),
    initial: () => ['requested', 'ready'],
    transitions: {
      requested: ['accepted', 'rejected', 'completed', 'cancelled'],
      ready: ['accepted', 'rejected', 'completed', 'cancelled', 'in-progress'],
      accepted: ['in-progress', 'completed', 'rejected', 'cancelled'],
      'in-progress': ['completed', 'failed', 'cancelled'],
    },
  },
  // Only beds (physicalType bd) have a lifecycle; sites, units and rooms do not.
  Location: {
    applies: isBed,
    get: (doc) => (isBed(doc) ? (ext(doc, LIFECYCLE_URL) ?? OPERATIONAL_TO_BED[doc.operationalStatus?.code] ?? 'available') : null),
    set: (doc, state) => ({ ...withExtension(doc, LIFECYCLE_URL, 'valueCode', state), operationalStatus: { system: OPERATIONAL_STATUS_SYSTEM, ...BED_TO_OPERATIONAL[state] } }),
    initial: () => ['available', 'blocked'],
    transitions: {
      available: ['occupied', 'reserved', 'blocked'],
      occupied: ['cleaning'],
      cleaning: ['available', 'blocked'],
      reserved: ['occupied', 'available'],
      blocked: ['available'],
    },
    reasonRequired: ['blocked'],
    guard(prev, next) {
      // Unblocking needs a fresh reason too: the one given when the bed was blocked does not count.
      if (prev && MACHINES.Location.get(prev) === 'blocked' && MACHINES.Location.get(next) === 'available' && (!statusReasonOf(next) || statusReasonOf(next) === statusReasonOf(prev))) {
        throw new HttpError(422, 'A reason is required to unblock a bed');
      }
    },
  },
};

// Dispensing: FHIR R4 MedicationDispense statuses as the lifecycle. A controlled drug needs a second
// checker (urn:hospital-desktop:checked-by), a different person from the performer, before it is completed.
export const CHECKED_BY_URL = 'urn:hospital-desktop:checked-by';
const rxCode = (doc) => (doc.medicationCodeableConcept?.coding || []).find((c) => c.system === SYSTEMS.rxnorm)?.code ?? null;
MACHINES.MedicationDispense = {
  ...byStatus('status'),
  initial: () => ['preparation', 'in-progress'],
  transitions: {
    preparation: ['in-progress', 'completed', 'on-hold', 'cancelled', 'declined', 'entered-in-error'],
    'in-progress': ['completed', 'on-hold', 'cancelled', 'stopped', 'entered-in-error'],
    'on-hold': ['in-progress', 'cancelled', 'stopped', 'entered-in-error'],
    completed: ['entered-in-error'],
  },
  reasonRequired: ['cancelled', 'declined', 'stopped', 'entered-in-error'],
  guard(prev, next) {
    if (next.status !== 'completed' || prev?.status === 'completed') return;
    const code = rxCode(next);
    if (!code || !isControlled(code)) return;
    const checker = ext(next, CHECKED_BY_URL);
    const filler = next.performer?.[0]?.actor?.display ?? null;
    if (!checker) throw new HttpError(422, 'A controlled drug needs a second checker (extension urn:hospital-desktop:checked-by) before the dispense is completed');
    if (filler && checker.trim().toLowerCase() === filler.trim().toLowerCase()) throw new HttpError(422, 'The second checker must be a different person from the one who filled the dispense');
  },
};

// Medication administration: one record per dose event. in-progress is a started infusion.
// entered-in-error is allowed only from a finished state, with a reason; the API checks that the recorder is the one correcting it.
MACHINES.MedicationAdministration = {
  ...byStatus('status'),
  initial: () => ['in-progress', 'completed', 'not-done', 'on-hold'],
  transitions: {
    'in-progress': ['completed', 'not-done', 'on-hold', 'stopped', 'entered-in-error'],
    'on-hold': ['in-progress', 'completed', 'not-done', 'stopped', 'entered-in-error'],
    completed: ['entered-in-error'],
    'not-done': ['entered-in-error'],
    stopped: ['entered-in-error'],
  },
  reasonRequired: ['not-done', 'on-hold', 'stopped', 'entered-in-error'],
  guard(prev, next) {
    if (['not-done', 'on-hold'].includes(next.status) && !prev && !(next.statusReason?.length || statusReasonOf(next))) {
      throw new HttpError(422, `A reason is required when a medication is ${next.status === 'on-hold' ? 'held' : 'not given'}`);
    }
  },
};

// Care plans and goals: FHIR request-status and goal lifecycle values.
MACHINES.CarePlan = {
  ...byStatus('status'),
  initial: () => ['draft', 'active'],
  transitions: { draft: ['active', 'revoked'], active: ['on-hold', 'completed', 'revoked'], 'on-hold': ['active', 'revoked'] },
  reasonRequired: ['revoked'],
};
MACHINES.Goal = {
  ...byStatus('lifecycleStatus'),
  initial: () => ['proposed', 'planned', 'accepted', 'active'],
  transitions: {
    proposed: ['planned', 'accepted', 'active', 'rejected', 'cancelled'],
    planned: ['accepted', 'active', 'cancelled'],
    accepted: ['active', 'on-hold', 'cancelled'],
    active: ['on-hold', 'completed', 'cancelled'],
    'on-hold': ['active', 'cancelled'],
  },
  reasonRequired: ['cancelled', 'rejected'],
};

// Specimen lifecycle: the exact state is the lifecycle extension; FHIR status is available until rejection.
MACHINES.Specimen = {
  ...byExtension(
    { ordered: 'available', collected: 'available', 'in-transit': 'available', received: 'available', 'in-process': 'available', resulted: 'available', verified: 'available', corrected: 'available', rejected: 'unsatisfactory' },
    { unsatisfactory: 'rejected', available: 'collected' },
  ),
  initial: () => ['ordered', 'collected'],
  transitions: {
    ordered: ['collected'],
    collected: ['in-transit', 'received', 'rejected'],
    'in-transit': ['received', 'rejected'],
    received: ['in-process', 'resulted', 'rejected'],
    'in-process': ['resulted'],
    resulted: ['verified', 'in-process'],
    verified: ['corrected'],
    corrected: ['corrected'],
  },
  reasonRequired: ['rejected'],
};

const machineFor = (doc) => { const m = MACHINES[doc?.resourceType]; return m && (!m.applies || m.applies(doc)) ? m : null; };
export const lifecycleOf = (doc) => (machineFor(doc) ? machineFor(doc).get(doc) : doc.status);
export const statusReasonOf = (doc) => ext(doc, REASON_URL);

/** What a resource in this state may move to. */
export function nextStates(doc) {
  const machine = machineFor(doc);
  return machine ? (machine.transitions[machine.get(doc)] || []) : [];
}

/**
 * Validates a create or update against the machine and returns the document
 * with its state fields normalised. Throws 422 on an illegal move.
 */
export function applyLifecycle(type, previous, doc) {
  const machine = MACHINES[type];
  if (!machine || (machine.applies && !machine.applies(doc))) return doc;
  const next = machine.get(doc);
  if (!previous) {
    const allowed = machine.initial(doc);
    if (!allowed.includes(next)) {
      throw new HttpError(422, `${type} cannot be created in state "${next}". Allowed: ${allowed.join(', ')}`);
    }
  } else {
    const prev = machine.get(previous);
    if (next !== prev) {
      const allowed = machine.transitions[prev] || [];
      if (!allowed.includes(next)) {
        throw new HttpError(422, `Illegal ${type} transition: ${prev} → ${next}. Allowed from ${prev}: ${allowed.join(', ') || 'none (terminal state)'}`);
      }
      if (machine.reasonRequired?.includes(next) && !statusReasonOf(doc)) {
        throw new HttpError(422, `A reason is required to move ${type} to "${next}"`);
      }
    }
  }
  machine.guard?.(previous, doc);
  return machine.set(doc, next);
}

/** Builds the document for a requested transition (validated later by applyLifecycle). */
export function transitionDoc(doc, to, reason) {
  const machine = machineFor(doc);
  if (!machine) throw new HttpError(422, `${doc.resourceType === 'Location' ? 'Only a bed' : doc.resourceType} has ${doc.resourceType === 'Location' ? 'a' : 'no'} lifecycle`);
  if (typeof to !== 'string' || !to) throw new HttpError(422, 'Transition target "to" is required');
  let next = machine.set(doc, to);
  if (reason != null) next = withExtension(next, REASON_URL, 'valueString', String(reason).trim());
  return next;
}
