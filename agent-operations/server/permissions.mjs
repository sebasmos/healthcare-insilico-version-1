// Agent permissions: what an agent asks for when it is added, per system.
// This file holds the vocabulary and validation; enforcement lives where writes are checked.
import { lifecycleOf } from '../../platform/server/state-machines.mjs';
import { HttpError } from '../../platform/server/http.mjs';

export const SYSTEMS = ['ehr', 'pacs', 'lab', 'pharmacy', 'payer', 'business-office', 'scheduling'];
export const SYSTEM_LABEL = { ehr: 'EHR', pacs: 'PACS', lab: 'Lab', pharmacy: 'Pharmacy', payer: 'Payer', 'business-office': 'Business office', scheduling: 'Scheduling' };
export const LEVELS = ['none', 'read-only', 'read-propose', 'read-write'];
export const LEVEL_LABEL = { none: 'No access', 'read-only': 'Read only', 'read-propose': 'Read and propose', 'read-write': 'Read and write' };
export const PATIENT_SCOPES = ['scenario', 'study', 'all-synthetic'];
export const CONNECTIONS = ['built-in', 'environment-api', 'mcp', 'cds-hooks', 'http', 'model-endpoint'];
export const CONNECTION_LABEL = { 'built-in': 'Built in', 'environment-api': 'Environment API (their own harness)', mcp: 'MCP connectors (their own harness)', 'cds-hooks': 'CDS Hooks service', http: 'HTTP endpoint (observe and act)', 'model-endpoint': 'Model endpoint with the reference harness' };
const rank = (l) => LEVELS.indexOf(l);

/** Validates a permissions request or grant. Unknown systems are refused; missing ones mean no access. */
export function normalizePermissions(input, fallbackLevel = 'read-propose') {
  const src = input && typeof input === 'object' ? input : {};
  const systems = {};
  for (const [k, v] of Object.entries(src.systems || {})) {
    if (!SYSTEMS.includes(k)) throw new HttpError(422, `Unknown system "${k}". Systems: ${SYSTEMS.join(', ')}`);
    if (!LEVELS.includes(v)) throw new HttpError(422, `Permission for ${k} must be one of ${LEVELS.join(', ')}`);
    systems[k] = v;
  }
  if (!src.systems) for (const s of SYSTEMS) systems[s] = fallbackLevel;
  for (const s of SYSTEMS) if (!systems[s]) systems[s] = 'none';
  const recordTypes = Array.isArray(src.recordTypes) ? [...new Set(src.recordTypes.map((t) => String(t).trim()).filter((t) => /^[A-Z][A-Za-z]{1,60}$/.test(t)))].slice(0, 60) : null;
  const patients = PATIENT_SCOPES.includes(src.patients) ? src.patients : 'all-synthetic';
  const rateLimit = Math.min(Math.max(Math.round(Number(src.rateLimit) || 600), 1), 100000);
  return { systems, recordTypes: recordTypes?.length ? recordTypes : null, patients, rateLimit, mustCite: Boolean(src.mustCite) };
}
/** A grant can only narrow what was asked for. */
export function narrowTo(requested, granted) {
  const out = normalizePermissions(granted, 'none');
  for (const s of SYSTEMS) if (rank(out.systems[s]) > rank(requested.systems[s])) out.systems[s] = requested.systems[s];
  if (requested.recordTypes) out.recordTypes = (out.recordTypes || requested.recordTypes).filter((t) => requested.recordTypes.includes(t));
  out.rateLimit = Math.min(out.rateLimit, requested.rateLimit);
  // The patient scope can only get narrower; when the narrower set does not name one, the granted one stays.
  { const order = ['scenario', 'study', 'all-synthetic', 'all']; const named = PATIENT_SCOPES.includes(granted?.patients); out.patients = !named || order.indexOf(requested.patients) < order.indexOf(out.patients) ? requested.patients : out.patients; }
  out.mustCite = out.mustCite || requested.mustCite;
  return out;
}
export const highestLevel = (p) => LEVELS[Math.max(0, ...SYSTEMS.map((s) => rank(p?.systems?.[s] || 'none')))];
export const BUILTIN_PERMISSIONS = normalizePermissions({ systems: Object.fromEntries(SYSTEMS.map((s) => [s, 'read-propose'])) });

// ---------- enforcement ----------
const TYPE_SYSTEM = { ImagingStudy: 'pacs', DicomObject: 'pacs', DiagnosticReport: 'pacs', Specimen: 'lab', MedicationDispense: 'pharmacy', DetectedIssue: 'pharmacy', Appointment: 'scheduling', Slot: 'scheduling', Schedule: 'scheduling', InsCase: 'payer', InsPayerClaim: 'payer', InsClaim: 'business-office', InsAuth: 'business-office', VisitCharge: 'business-office' };
/** Which system a record type belongs to. Everything not named is the EHR. */
export const systemOfType = (type) => TYPE_SYSTEM[type] || 'ehr';
/** Which system a request path belongs to. FHIR paths are decided by their resource type. */
export function systemOfPath(path) {
  const p = String(path || '');
  const fhir = /^\/fhir\/R4\/([A-Za-z]+)/.exec(p); if (fhir) return systemOfType(fhir[1]);
  if (p.startsWith('/api/ins/payer') || /^\/api\/ins\/(policies|reference|meta|friction)(\/|$)/.test(p)) return 'payer';
  if (p.startsWith('/api/ins/')) return 'business-office';
  if (p.startsWith('/api/pacs') || p.startsWith('/dicom-web') || p.startsWith('/api/pathology') || p.startsWith('/pathology/')) return 'pacs';
  if (p.startsWith('/api/lab')) return 'lab';
  if (p.startsWith('/api/pharmacy')) return 'pharmacy';
  if (p.startsWith('/cds-services/coverage-requirements')) return 'payer';
  return 'ehr';
}
/** Built-in agents: read and propose everywhere, any patient (they are part of the hospital, pre-approved). */
export const DEFAULT_GRANT = { ...BUILTIN_PERMISSIONS, patients: 'all', rateLimit: 100000 };
/** The permissions in force for a run: what was recorded on the run when it started, else the agent's grant, else the built-in default. */
export const permissionsOf = (run, agent) => run?.permissions || agent?.granted || DEFAULT_GRANT;
/** Writes that end, undo or settle something: cancelling, discontinuing, completing, marking in error, denying. They need read and write. */
const SETTLING = new Set(['cancelled', 'revoked', 'stopped', 'discontinued', 'entered-in-error', 'completed', 'rejected', 'denied', 'declined', 'on-hold', 'not-done']);
// The state is read the way the record's own state machine reads it (its lifecycle extension where it has one), so a cancel cannot hide behind an unchanged FHIR status.
const stateOf = (doc) => { try { return doc?.resourceType ? lifecycleOf(doc) : doc?.status; } catch { return doc?.status; } };
export const isSettling = (type, doc, existed) => { if (!doc || ['Task', 'Communication'].includes(type)) return false; const now = stateOf(doc); const was = existed && typeof existed === 'object' ? stateOf(existed) : null; return (SETTLING.has(now) && now !== was) || (SETTLING.has(doc.status) && doc.status !== (existed?.status ?? null)) || Boolean(existed && doc.status === 'inactive' && existed.status !== 'inactive'); };
/**
 * Decides one agent write under the run's permissions. Returns null when allowed, or { rule, message }.
 * synthetic: whether the record's patient is marked synthetic (looked up by the caller); patientRef: the record's patient.
 */
export function refuseWrite(perms, { type, doc = null, existed = false, branch = 'main', patientRef = null, synthetic = true, runPatient = null }) {
  const system = systemOfType(type); const level = perms.systems?.[system] || 'none';
  if (level === 'none' || level === 'read-only') return { rule: 'permission', settling: isSettling(type, doc, existed), message: `This agent has ${LEVEL_LABEL[level].toLowerCase()} on ${SYSTEM_LABEL[system]}: writing ${type} is refused` };
  if (perms.recordTypes && !perms.recordTypes.includes(type)) return { rule: 'permission', message: `This agent may write only ${perms.recordTypes.join(', ')}; ${type} is refused` };
  if (perms.patients === 'all-synthetic' && patientRef && !synthetic) return { rule: 'permission', message: `This agent may work on synthetic patients only; ${patientRef} is not marked synthetic` };
  if (['scenario', 'study'].includes(perms.patients) && patientRef && runPatient && patientRef !== runPatient) return { rule: 'permission', message: `This agent may work on the patient of its ${perms.patients} only (${runPatient}); ${patientRef} is refused` };
  if (level === 'read-propose' && isSettling(type, doc, existed)) return { rule: 'permission', settling: true, message: `Setting ${type} to "${stateOf(doc)}" changes the record for good: that needs read and write, and this agent has read and propose on ${SYSTEM_LABEL[system]}` };
  if (level === 'read-write' && branch === 'main') return { rule: 'permission', message: 'Read and write is only ever on the run\'s own branch, never on the live record' };
  return null;
}
/** Decides one agent read. */
export function refuseRead(perms, path) { const system = systemOfPath(path); const level = perms.systems?.[system] || 'none'; return level === 'none' ? { rule: 'permission', message: `This agent has no access to ${SYSTEM_LABEL[system]}` } : null; }
