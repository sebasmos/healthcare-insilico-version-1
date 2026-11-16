// A signed-in patient reads only their own record, on every route.
//
// Three layers, all on the server:
//   1. Routes: a patient's session reaches only the routes the Portal and My work need. The environment API,
//      the connector routes (MCP, FHIR and CDS for outside agents) and WebSockets are for agents with keys, and
//      are refused to a patient's session.
//   2. Requests: a patient cannot name another patient in the address or the body.
//   3. Responses: anything that mentions another patient is taken out before it is sent; a single record that
//      belongs to someone else is refused. On FHIR routes a clinical record must positively belong to the patient.
import { HttpError } from './http.mjs';

const KEYS = new Set(['patient', 'patientId', '_patient', 'patientRef', 'subject', 'beneficiary']);
const REF = /^Patient\/([A-Za-z0-9\-.]{1,64})$/;
// FHIR types a patient's session may ask for. The last four hold no patient and are needed to book and read appointments.
const FHIR_TYPES = new Set(['Patient', 'AllergyIntolerance', 'Appointment', 'Communication', 'Condition', 'DiagnosticReport', 'DocumentReference', 'Encounter', 'MedicationRequest', 'MedicationStatement', 'Observation', 'Task', 'ImagingStudy', 'Coverage', 'CarePlan', 'Immunization', 'Procedure', 'ServiceRequest', 'QuestionnaireResponse', 'Slot', 'Schedule', 'Practitioner', 'Location']);
const NEUTRAL = new Set(['Slot', 'Schedule', 'Practitioner', 'Location']);
const API_ALLOWED = [/^\/api\/ins\/my(\/(appeal|complaint))?$/, /^\/api\/rpm\/(patients\/[^/]+|readings)$/, /^\/api\/ages$/, /^\/api\/visit-summary$/, /^\/api\/counters$/, /^\/agent-ops\/my-work$/, /^\/agent-ops\/attempts\/[^/]+(\/(open|next))?$/, /^\/agent-ops\/panel(\/.*)?$/, /^\/agent-ops\/trace$/, /^\/agent-ops\/runs\/events$/, /^\/agent-ops\/mode$/, /^\/agent-ops\/surveillance\/(meta|touched|reports)(\/[^/]+)?$/];

/** Who a string or small object points at: 'own', 'other' or null. */
function pointsAt(key, v, pid) {
  if (typeof v === 'string') { const m = REF.exec(v); if (m) return m[1] === pid ? 'own' : 'other'; if (KEYS.has(key) && key !== 'subject' && key !== 'beneficiary' && /^[A-Za-z0-9\-.]{8,64}$/.test(v)) return v === pid ? 'own' : 'other'; }
  return null;
}
/** Does this value mention the patient, or another patient, anywhere inside it? */
export function mentions(node, pid, key = '') {
  const out = { own: false, other: false };
  const walk = (v, k) => {
    if (v == null) return;
    if (typeof v !== 'object') { const p = pointsAt(k, v, pid); if (p) out[p] = true; return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, k); return; }
    if (v.resourceType === 'Patient' && typeof v.id === 'string') out[v.id === pid ? 'own' : 'other'] = true;
    else if (KEYS.has(k) && typeof v.id === 'string' && !v.resourceType) out[v.id === pid ? 'own' : 'other'] = true;
    for (const [kk, vv] of Object.entries(v)) walk(vv, kk);
  };
  walk(node, key);
  return out;
}
/** Takes other patients out of a response. Returns { body } or { refused: true }. */
export function scopeBody(body, pid, { fhir = false } = {}) {
  let refused = false;
  const ownRecord = (r) => !r || typeof r !== 'object' || !r.resourceType || NEUTRAL.has(r.resourceType) || ['Bundle', 'OperationOutcome', 'CapabilityStatement'].includes(r.resourceType) || mentions(r, pid).own;
  const clean = (v, k, top) => {
    if (v == null || typeof v !== 'object') { if (pointsAt(k, v, pid) === 'other') refused = true; return v; }
    if (Array.isArray(v)) return v.filter((x) => { if (x == null || typeof x !== 'object') return pointsAt(k, x, pid) !== 'other'; const m = mentions(x, pid, k); if (m.other) return false; if (fhir) { const r = x.resource && x.resource.resourceType ? x.resource : x; if (!ownRecord(r)) return false; } return true; }).map((x) => (x && typeof x === 'object' ? clean(x, k, false) : x));
    if (v.resourceType === 'Patient' && typeof v.id === 'string' && v.id !== pid) { refused = true; return v; }
    if (KEYS.has(k) && typeof v.id === 'string' && !v.resourceType && v.id !== pid) { refused = true; return v; }
    if (fhir && top && !ownRecord(v)) { refused = true; return v; }
    const o = {}; for (const [kk, vv] of Object.entries(v)) o[kk] = clean(vv, kk, false); return o;
  };
  const out = clean(body, '', true);
  if (out && out.resourceType === 'Bundle' && Array.isArray(out.entry) && typeof out.total === 'number') out.total = out.entry.length;
  return refused ? { refused: true } : { body: out };
}

/** Checks one request from a patient's session before it is handled. Throws when it is not allowed. */
export async function gate({ req, url, pid, body, store, studyUidOf, isApi }) {
  const p = url.pathname; const no = (why) => { throw new HttpError(403, why, 'not-your-record'); };
  if (!pid || pid === '(none)') no('Your sign-in is not linked to a patient record yet. Ask the person who invited you.');
  if (p.startsWith('/env/') || p.startsWith('/connect/') || p.startsWith('/hl7') || p.startsWith('/cds-services') || p.startsWith('/pathology/')) no('This is not available to a patient');
  if (p.startsWith('/fhir/R4')) {
    const [type, id] = p.split('/').slice(3);
    if (type && type !== 'metadata' && !FHIR_TYPES.has(type)) no('This kind of record is not available to a patient');
    if (type === 'Patient' && id && id !== pid) no('You can read only your own record');
  } else if (p.startsWith('/dicom-web/')) {
    const parts = p.split('/').filter(Boolean); // dicom-web, studies, <uid>, ...
    if (parts[1] !== 'studies') no('This is not available to a patient');
    if (parts[2]) { const mine = new Set((await store.query('ImagingStudy', { patient: `Patient/${pid}` })).map((s) => studyUidOf(s))); if (!mine.has(decodeURIComponent(parts[2]))) no('You can read only your own images'); }
  } else if (p.startsWith('/api/') || (p.startsWith('/agent-ops/') && isApi)) { // pages and scripts under /agent-ops/ are not records
    if (!API_ALLOWED.some((re) => re.test(p)) || (p === '/agent-ops/trace' && req.method !== 'POST')) no('This is not available to a patient');
    const m = /^\/api\/rpm\/patients\/([^/]+)$/.exec(p); if (m && decodeURIComponent(m[1]) !== pid) no('You can read only your own record');
  } else if (p === '/auth/patients') no('This is not available to a patient');
  for (const k of ['patient', 'subject', 'ids', '_id']) {
    const v = url.searchParams.get(k); if (!v) continue;
    if ((k === 'ids' || k === '_id') && !(p === '/api/ages' || p === '/fhir/R4/Patient')) continue;
    for (const one of v.split(',')) if (one.replace(/^Patient\//, '') !== pid) no('You can read only your own record');
  }
  if (body && typeof body === 'object' && mentions(body, pid).other) no('You can write only to your own record');
}
/** For a DICOMweb study search: only the patient's own studies. */
export async function ownStudies(store, pid, studyUidOf) { return new Set((await store.query('ImagingStudy', { patient: `Patient/${pid}` })).map((s) => studyUidOf(s))); }
