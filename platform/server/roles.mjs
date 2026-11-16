// The one permission map (plan section 1). Served by GET /auth/roles, read by
// every page, and enforced on writes by the FHIR API and the helper routes.
// This is workflow fidelity, not security: anyone can change "Work as".
//
// History is listed for every role whose Imaging or Results tab is not
// built yet, because it is where those records are read today.
// Per role: apps (desktop tiles it may open), landing (where it starts),
// nav (EHR side-navigation ids), chartTabs (ordered chart activity ids),
// readOnlyTabs (tabs it sees but may not change) and writes.
//
// writes maps a FHIR resource type to the interactions the role may perform:
//   create, update, transition (a lifecycle move), sign (may take a record to
//   final/amended/corrected/appended), sign:<category> (sign only records
//   with that category code, for example vital-signs), create:order-mode
//   (create an order only with a verbal, telephone or protocol order mode,
//   which then waits for a physician co-signature), cosign (co-sign such an
//   order), verify (decide a medication order in the pharmacy verification
//   queue: verify, verify with a change, reject or query the prescriber).
//   The keys $release and $acknowledge are operations. '*' means
//   everything a human may do. readOnly: true marks a role that never writes
//   outside Agent Dashboard.
import { HttpError } from './http.mjs';
import { recordAction, LIVE_RUN_ID } from './audit.mjs';

export const APPS = ['ehr', 'pacs', 'portal', 'agent-ops', 'pharmacy', 'lab', 'beds', 'monitoring', 'pathology', 'visit', 'payer'];
export const EHR_NAV = ['dashboard', 'worklist', 'patients', 'schedule', 'frontdesk', 'orders', 'inbox', 'billing', 'admin'];
export const CHART_TABS = ['summary', 'review', 'problems', 'allergies', 'medications', 'vitals', 'notes', 'orders', 'results', 'imaging', 'ecg', 'encounters', 'messages', 'worklist', 'mar', 'flowsheets', 'io', 'education', 'careplan', 'coverage'];

export const ORDER_MODE_URL = 'urn:hospital-desktop:order-mode';
export const PENDING_COSIGN_URL = 'urn:hospital-desktop:pending-cosign';
export const COSIGNED_BY_URL = 'urn:hospital-desktop:cosigned-by';
export const ORDER_MODES = ['verbal', 'telephone', 'protocol'];
export const ORDER_TYPES = ['ServiceRequest', 'MedicationRequest'];
export const SIGNED_STATES = new Set(['final', 'amended', 'corrected', 'appended']);

const full = ['create', 'update', 'transition', 'sign'];
const edit = ['create', 'update'];
const flow = ['create', 'update', 'transition'];

// Four roles (redesign of 2026-11-12). The three staff roles see every app
// with full access; the patient sees only the Portal. The framework is kept:
// writes lists, sign:<category>, create:order-mode, readOnlyApps,
// readOnlyTabs and readOnly all still work per role. To narrow a role again,
// give its entry narrower fields (PARKED_ROLES keeps the earlier detailed
// profiles to copy from). Agent safety rules are not role checks; they live in
// the agent envelope and do not change with this map.
const STAFF = { apps: [...APPS], nav: '*', chartTabs: '*', readOnlyTabs: [], readOnlyApps: [], writes: '*' };
const FOUR_ROLES = [
  { id: 'physician', label: 'Physician', ...STAFF, landing: { app: 'ehr', hash: '#/dashboard' } },
  { id: 'nurse', label: 'Nurse', ...STAFF, landing: { app: 'ehr', hash: '#/worklist' } },
  { id: 'researcher', label: 'Researcher', ...STAFF, apps: ['agent-ops', ...APPS.filter((a) => a !== 'agent-ops')], landing: { app: 'agent-ops', hash: '#/' } },
  {
    id: 'patient', label: 'Patient', apps: ['portal', 'agent-ops'], landing: { app: 'portal', hash: '#/home' }, // the Agent Dashboard shows a patient only My work
    nav: [],
    chartTabs: [],
    readOnlyTabs: [],
    writes: { Communication: edit, Task: ['create'], Observation: ['create', 'sign:vital-signs', 'sign:home-reading'] },
  },
  // Payer and administration: each sees its own app with full access and the EHR read-only.
  {
    // Insurer side (Insurance Payer): reviews requests and claims, plus medical-necessity denials, peer-to-peer and appeal decisions.
    id: 'payer-medical-director', label: 'Insurance Payer', side: 'insurer', apps: ['payer', 'agent-ops'], readOnlyApps: [], landing: { app: 'payer', hash: '#/bench' },
    nav: [], chartTabs: [], readOnlyTabs: [],
    writes: {},
  },
  {
    // Hospital side: reads signed notes, results and orders; codes, builds and sends claims; never orders or changes clinical documentation.
    id: 'coder', label: 'Coder', side: 'hospital', apps: ['ehr', 'agent-ops'], readOnlyApps: [], landing: { app: 'ehr', hash: '#/billing' },
    nav: ['patients', 'billing', 'inbox'], chartTabs: '*', readOnlyTabs: '*',
    writes: {},
  },
];

// The earlier detailed profiles. Not served and not accepted as roles unless
// ROLE_MAP=detailed is set (the detailed role tests use it). Kept so
// permissions can be added back by copying fields into ROLES.
export const PARKED_ROLES = [
  {
    id: 'physician', label: 'Physician', apps: ['ehr', 'pacs', 'portal', 'agent-ops', 'monitoring', 'pathology'], readOnlyApps: ['pathology'], landing: { app: 'ehr', hash: '#/dashboard' },
    nav: ['dashboard', 'patients', 'schedule', 'orders', 'inbox', 'admin'],
    chartTabs: ['summary', 'review', 'problems', 'allergies', 'medications', 'vitals', 'notes', 'orders', 'results', 'imaging', 'ecg', 'encounters', 'messages', 'mar', 'flowsheets', 'io'],
    readOnlyTabs: ['mar', 'flowsheets', 'io'],
    writes: {
      Patient: edit, Encounter: flow, Condition: edit, AllergyIntolerance: edit, Immunization: edit, Procedure: full, CareTeam: edit, List: edit,
      ServiceRequest: [...flow, 'cosign'], MedicationRequest: [...flow, 'cosign'], Observation: full, DocumentReference: full, DiagnosticReport: full,
      ImagingStudy: ['update'], Task: flow, Communication: edit, Appointment: flow, CarePlan: flow, Goal: edit, DetectedIssue: full, Device: edit,
      $release: true, $acknowledge: true, Location: ['transition'],
    },
  },
  {
    id: 'nurse', label: 'Nurse', apps: ['ehr', 'monitoring'], landing: { app: 'ehr', hash: '#/worklist' },
    nav: ['worklist', 'patients', 'orders', 'inbox'],
    chartTabs: ['summary', 'review', 'results', 'worklist', 'mar', 'flowsheets', 'io', 'notes', 'education', 'careplan', 'orders', 'ecg'],
    readOnlyTabs: [],
    writes: {
      Observation: ['create', 'update', 'sign:vital-signs', 'sign:intake-output', 'sign:exam', 'sign:survey', 'sign:procedure'],
      MedicationAdministration: full, DocumentReference: full, Procedure: full, CarePlan: full, Goal: full, Task: flow, Communication: edit, Device: edit,
      ServiceRequest: ['create:order-mode', 'update'], MedicationRequest: ['create:order-mode', 'update'], Specimen: flow,
      $acknowledge: true, Encounter: ['update', 'transition'], Location: ['transition'],
    },
  },
  {
    id: 'pharmacist', label: 'Pharmacist', apps: ['pharmacy', 'ehr'], landing: { app: 'pharmacy', hash: '#/queue' },
    nav: ['patients', 'orders'],
    chartTabs: ['summary', 'review', 'medications', 'allergies', 'results', 'orders', 'mar'],
    readOnlyTabs: ['mar'],
    writes: { MedicationRequest: ['update', 'transition', 'verify'], MedicationDispense: full, DetectedIssue: full, Task: flow, Communication: edit },
  },
  {
    id: 'radiologist', label: 'Radiologist', apps: ['pacs', 'ehr', 'pathology'], readOnlyApps: ['pathology'], landing: { app: 'pacs', hash: '#/worklist' },
    nav: ['patients', 'orders', 'inbox'],
    chartTabs: ['summary', 'review', 'imaging', 'results', 'notes'],
    readOnlyTabs: [],
    writes: { DiagnosticReport: full, ImagingStudy: edit, Observation: ['create', 'update', 'transition'], Task: flow, Communication: edit, $release: true },
  },
  {
    // Signs out pathology cases: the pathology app in full, the chart read-only plus results, PACS read-only.
    id: 'pathologist', label: 'Pathologist', apps: ['pathology', 'ehr', 'pacs'], readOnlyApps: ['pacs'], landing: { app: 'pathology', hash: '#/worklist' },
    nav: ['patients', 'orders', 'inbox'],
    chartTabs: ['summary', 'review', 'results', 'imaging', 'notes', 'orders'],
    readOnlyTabs: ['notes', 'orders'],
    writes: { DiagnosticReport: full, Specimen: flow, ImagingStudy: edit, Observation: ['create', 'update', 'transition'], Task: flow, Communication: edit, ServiceRequest: ['update'], $release: true },
  },
  {
    id: 'technologist', label: 'Imaging technologist', apps: ['pacs', 'ehr'], landing: { app: 'pacs', hash: '#/upload' },
    nav: ['patients', 'orders'],
    chartTabs: ['summary', 'review', 'imaging', 'orders', 'ecg'],
    readOnlyTabs: [],
    writes: { ImagingStudy: edit, Observation: ['create', 'update', 'sign:procedure'], ServiceRequest: ['update'], Task: flow },
  },
  {
    id: 'labtech', label: 'Lab technologist', apps: ['lab', 'ehr'], landing: { app: 'lab', hash: '#/worklist' },
    nav: ['patients', 'orders'],
    chartTabs: ['summary', 'review', 'orders', 'results'],
    readOnlyTabs: [],
    writes: { Specimen: flow, Observation: ['create', 'update', 'transition', 'sign:laboratory', 'sign:quality-control'], DiagnosticReport: full, ServiceRequest: ['update', 'transition'], Task: flow, Communication: edit },
  },
  {
    id: 'bedmanager', label: 'Bed manager', apps: ['beds', 'ehr'], landing: { app: 'beds', hash: '#/dashboard' },
    nav: ['patients'],
    chartTabs: ['summary', 'encounters'],
    readOnlyTabs: [],
    writes: { Location: flow, Encounter: ['update', 'transition'], Task: flow },
  },
  {
    id: 'scheduler', label: 'Scheduler', apps: ['ehr'], landing: { app: 'ehr', hash: '#/schedule' },
    nav: ['schedule', 'patients', 'frontdesk'],
    chartTabs: ['summary', 'encounters'],
    readOnlyTabs: [],
    writes: { Appointment: flow, Patient: edit, Encounter: flow, Schedule: edit, Slot: edit, Task: ['update', 'transition'] },
  },
  {
    id: 'billing', label: 'Billing specialist', apps: ['ehr'], landing: { app: 'ehr', hash: '#/billing' },
    nav: ['billing', 'patients'],
    chartTabs: ['summary', 'encounters'],
    readOnlyTabs: ['summary', 'encounters'],
    writes: { Coverage: edit, Claim: edit, Account: edit, ChargeItem: edit },
  },
  {
    id: 'researcher', label: 'Researcher', apps: ['agent-ops', ...APPS.filter((a) => a !== 'agent-ops')], landing: { app: 'agent-ops', hash: '#/' },
    nav: '*', chartTabs: '*', readOnlyTabs: '*', readOnly: true, writes: {},
  },
  {
    id: 'administrator', label: 'Administrator', apps: [...APPS], landing: { app: 'ehr', hash: '#/dashboard' },
    nav: '*', chartTabs: '*', readOnlyTabs: [], writes: '*',
  },
];

const PATIENT = FOUR_ROLES.find((r) => r.id === 'patient');
/** The map in force: the four roles, or with ROLE_MAP=detailed the earlier detailed profiles (patient unchanged). */
export const ROLES = process.env.ROLE_MAP === 'detailed'
  ? [...PARKED_ROLES.filter((r) => !['researcher', 'administrator'].includes(r.id)), PATIENT, ...PARKED_ROLES.filter((r) => ['researcher', 'administrator'].includes(r.id))]
  : FOUR_ROLES;

const expand = (value, all) => (value === '*' ? [...all] : value);

/** The role's permission with '*' expanded into lists, or null for an unknown role. */
/** Role names from earlier builds. */
export const ROLE_ALIAS = { billing: 'coder', 'payer-reviewer': 'payer-medical-director' };
/** Who may decide for the insurer. Hospital staff never approve or deny. */
export const INSURER_ROLES = ['payer-medical-director'];
export const mayDecideForInsurer = (role) => INSURER_ROLES.includes(role) || role === 'researcher';
/** A denial for medical necessity, and an appeal decision, need the medical director (42 CFR 422.566(d)). */
export const mayDenyForNecessity = (role) => role === 'payer-medical-director' || role === 'researcher';
export function permissionFor(role) {
  const r = ROLES.find((x) => x.id === role) || ROLES.find((x) => x.id === ROLE_ALIAS[role]); // a role name from an earlier build still works
  if (!r) return null;
  return { ...r, nav: expand(r.nav, EHR_NAV), chartTabs: expand(r.chartTabs, CHART_TABS), readOnlyTabs: expand(r.readOnlyTabs, CHART_TABS), readOnlyApps: r.readOnlyApps || [], readOnly: Boolean(r.readOnly) };
}

export const knownRoleIds = () => ROLES.map((r) => r.id);

/**
 * May this role perform the interaction on the type?
 * interaction: create | update | transition | sign | cosign | verify | $release | $acknowledge.
 * signing: the write takes the record to a signed state (checked on top of the interaction).
 * categories: the record's category codes, for sign:<category> entries.
 * orderMode: the create carries an order mode (verbal, telephone, protocol).
 */
export function mayWrite(role, type, interaction, { signing = false, categories = [], orderMode = false } = {}) {
  const perm = permissionFor(role);
  if (!perm) return false;
  if (perm.writes === '*') return true;
  if (interaction.startsWith('$')) return perm.writes[interaction] === true;
  const list = perm.writes[type];
  if (!list) return false;
  const canSign = (cats) => list.includes('sign') || list.some((x) => x.startsWith('sign:') && (cats.length ? cats.includes(x.slice(5)) : true));
  if (interaction === 'sign') return canSign(categories);
  const allowed = list.includes(interaction) || (interaction === 'create' && orderMode && list.includes('create:order-mode'));
  if (!allowed) return false;
  if (signing && !(list.includes('sign') || categories.some((c) => list.includes(`sign:${c}`)))) return false;
  return true;
}

/** True when the role may create this order type only with an order mode (nurse-entered orders). */
export function orderModeRequired(role, type) {
  const perm = permissionFor(role);
  if (!perm || perm.writes === '*') return false;
  const list = perm.writes[type] || [];
  return list.includes('create:order-mode') && !list.includes('create');
}

export const rolesThatMay = (type, interaction, opts) => ROLES.filter((r) => mayWrite(r.id, type, interaction, opts)).map((r) => r.id);

const THING = { ImagingStudy: 'an imaging study', DiagnosticReport: 'a report', Patient: 'a patient record', ServiceRequest: 'an order', Communication: 'a message', Task: 'a task', MedicationRequest: 'a prescription', Observation: 'a result', DocumentReference: 'a note', Condition: 'a problem', AllergyIntolerance: 'an allergy', Encounter: 'a visit', Appointment: 'an appointment', Location: 'a bed or location', Procedure: 'a procedure record', CarePlan: 'a care plan', Goal: 'a goal', List: 'a patient list', Immunization: 'an immunisation', Specimen: 'a specimen', MedicationAdministration: 'a medication administration', MedicationDispense: 'a dispense record' };
const VERB = { create: 'create', update: 'change', transition: 'move', sign: 'sign', cosign: 'co-sign', verify: 'verify' };

/** "sign a note", "prescribe", "release a result to the portal". */
export function describeWrite(type, interaction, { signing = false } = {}) {
  if (interaction === '$release') return `release ${THING[type] || 'a record'} to the portal`;
  if (interaction === '$acknowledge') return 'acknowledge a critical result';
  if (type === 'MedicationRequest' && interaction === 'create') return 'prescribe';
  if (type === 'ServiceRequest' && interaction === 'create') return 'place an order';
  const verb = signing || interaction === 'sign' ? 'sign' : VERB[interaction] || interaction;
  return `${verb} ${THING[type] || `a ${type}`}`;
}

export class RoleError extends HttpError {
  constructor(message, refusal) {
    super(403, message, 'forbidden');
    this.refusal = refusal;
  }
}

/** The 403 for a role that may not do this, with a plain message naming who may. */
export function refusal(role, type, interaction, opts = {}) {
  const perm = permissionFor(role);
  if (!perm) return new RoleError(`Unknown role "${role}". Known roles: ${knownRoleIds().join(', ')}.`, { role, type, interaction, unknown: true });
  const who = rolesThatMay(type, interaction, opts).map((id) => ROLES.find((r) => r.id === id).label.toLowerCase());
  const what = describeWrite(type, interaction, opts);
  const hint = perm.readOnly ? 'Researcher is read-only outside Agent Dashboard.' : who.length ? `Roles that may: ${who.join(', ')}.` : 'No role may do this.';
  return new RoleError(`A ${perm.label.toLowerCase()} cannot ${what}. ${hint}`, { role, type, interaction });
}

/** Throws the refusal when the role may not do this. */
export function assertMayWrite(role, type, interaction, opts = {}) {
  if (!mayWrite(role, type, interaction, opts)) throw refusal(role, type, interaction, opts);
}

/** Areas where human writes are checked against the map. Agent Dashboard routes and server-internal writes are not. */
export const ENFORCED_AREAS = new Set(['fhir', 'api']);
export const enforcedFor = (ctx) => ctx?.actor?.kind === 'human' && ENFORCED_AREAS.has(ctx.area);

/** A refused write is still part of the log: TraceStep role.refuse plus an AuditEvent with outcome 4, in its own transaction. */
export async function logRoleRefusal(store, ctx, err, { method, path }) {
  if (!err?.refusal || !ctx?.actor) return;
  try {
    await store.transaction((tx) => recordAction(tx, {
      runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'execute', action: 'role.refuse',
      args: { ...err.refusal, method, path, status: 403 }, why: ctx.why ?? null, branch: ctx.branch ?? 'main',
      description: `refused by role: ${err.message}`, outcome: '4',
    }));
  } catch (logErr) {
    console.error('Could not log role refusal', logErr);
  }
}

// ---------- Nurse-entered orders ----------
export const extensionValue = (doc, url) => (doc?.extension || []).find((e) => e.url === url);
export const orderModeOf = (doc) => extensionValue(doc, ORDER_MODE_URL)?.valueCode ?? null;
export const pendingCosign = (doc) => extensionValue(doc, PENDING_COSIGN_URL)?.valueBoolean === true;
export const withExtension = (doc, url, value) => ({ ...doc, extension: [...(doc.extension || []).filter((e) => e.url !== url), { url, ...value }] });

export const stateOf = (type, doc) => (type === 'DocumentReference' ? doc?.docStatus : doc?.status);
export const categoriesOf = (doc) => (Array.isArray(doc?.category) ? doc.category : doc?.category ? [doc.category] : []).flatMap((c) => (c.coding || []).map((x) => x.code)).filter(Boolean);
