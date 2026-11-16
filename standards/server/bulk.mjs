// FHIR Bulk Data Access 2.0: $export at system, Patient and Group level, asynchronous (Prefer: respond-async). The
// work runs in the background and is polled, so it fits behind a proxy that ends requests after 60 seconds. Files are
// NDJSON in the exports store; the manifest says requiresAccessToken. Patients appear by number only. A patient with
// an active Consent that denies sharing is left out.
import { randomUUID } from 'node:crypto';
import { createConsent } from './consent.mjs';
import { HttpError } from '../../platform/server/http.mjs';
import { FHIR_TYPES } from '../../platform/server/validate.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';
import { createObjectStore } from '../../platform/server/storage.mjs';

const COMPARTMENT = ['Patient', 'Encounter', 'Condition', 'AllergyIntolerance', 'MedicationRequest', 'MedicationAdministration', 'MedicationDispense', 'Observation', 'DiagnosticReport', 'DocumentReference', 'Procedure', 'Immunization', 'ServiceRequest', 'Appointment', 'CarePlan', 'Goal', 'Coverage', 'Claim', 'Specimen', 'ImagingStudy', 'Communication', 'Consent'];
const clean = (doc) => Object.fromEntries(Object.entries(doc).filter(([k]) => !k.startsWith('_')));

export function createBulk({ store, baseUrl = () => '' }) {
  const jobs = new Map(); let files = null; const out = async () => (files ||= await createObjectStore('exports'));
  const may = (person) => person && (person.role === 'researcher' || person.smart?.system);
  const consent = createConsent(store);
  async function run(job) {
    const since = job.since ? Date.parse(job.since) : null; const skip = await consent.deniedSet({ actor: job.actor || {}, smart: job.system ? { system: true } : null }, 'HOPERAT'); const store2 = await out();
    for (const type of job.types) {
      if (job.cancelled) return; let rows = await store.query(type, {}, { branch: 'main' });
      rows = rows.filter((r) => { const pid = type === 'Patient' ? r.id : String(r._patient || '').replace(/^Patient\//, ''); if (skip.has(pid)) return false; if (job.patients && !job.patients.has(pid)) return false; if (since && !(Date.parse(r.meta?.lastUpdated || r._recordedAt || 0) >= since)) return false; return true; });
      if (!rows.length) continue; const key = `bulk/${job.id}/${type}.ndjson`; await store2.put(key, Buffer.from(`${rows.map((r) => JSON.stringify(clean(r))).join('\n')}\n`));
      job.output.push({ type, url: `${baseUrl()}/fhir/R4/$export-file/${job.id}/${type}.ndjson`, count: rows.length }); job.done += 1;
    }
    job.finishedAt = new Date().toISOString(); job.status = 'complete';
    await store.transaction((tx) => recordAction(tx, { runId: LIVE_RUN_ID, actor: job.actor, kind: 'execute', action: 'bulk.export.complete', args: { job: job.id, files: job.output.length, resources: job.output.reduce((n, o) => n + o.count, 0) }, description: 'bulk export finished', audit: true })).catch(() => {});
  }
  /** Kick-off. level: system | patient | group. */
  async function kickOff(level, groupId, url, req) {
    if (!may(req.person)) throw new HttpError(403, 'A bulk export is for a Researcher, the Admin or a backend services app', 'forbidden');
    if (!/respond-async/.test(String(req.headers.prefer || ''))) throw new HttpError(400, 'Send "Prefer: respond-async"', 'invalid');
    const fmt = url.searchParams.get('_outputFormat'); if (fmt && !['application/fhir+ndjson', 'application/ndjson', 'ndjson'].includes(fmt)) throw new HttpError(400, 'Only NDJSON is offered', 'invalid');
    let types = (url.searchParams.get('_type') || '').split(',').map((s) => s.trim()).filter(Boolean); const pool = level === 'system' ? [...FHIR_TYPES].filter((t) => !['AuditEvent', 'Provenance'].includes(t)) : COMPARTMENT;
    for (const t of types) if (!pool.includes(t)) throw new HttpError(400, `${t} cannot be exported at this level`, 'invalid'); if (!types.length) types = pool;
    let patients = null; if (level === 'group') { if (groupId !== 'all') throw new HttpError(404, `Group/${groupId} not found. Group/all is every patient`, 'not-found'); }
    const id = randomUUID(); const job = { id, level, types, since: url.searchParams.get('_since'), patients, status: 'running', output: [], done: 0, requestedAt: new Date().toISOString(), request: `${baseUrl()}${url.pathname}${url.search}`, actor: { kind: 'human', id: req.person.id, role: req.person.role } };
    jobs.set(id, job); await store.transaction((tx) => recordAction(tx, { runId: LIVE_RUN_ID, actor: job.actor, kind: 'execute', action: 'bulk.export.start', args: { job: id, level, types }, description: `bulk export started (${level})`, audit: true }));
    setImmediate(() => run(job).catch((err) => { job.status = 'failed'; job.error = err.message; }));
    return { status: 202, body: null, headers: { 'Content-Location': `${baseUrl()}/fhir/R4/$export-status/${id}` } };
  }
  function status(id, req) {
    const job = jobs.get(id); if (!job || !may(req.person) || job.actor.id !== req.person.id) throw new HttpError(404, 'No such export', 'not-found');
    if (req.method === 'DELETE') { job.cancelled = true; jobs.delete(id); return { status: 202, body: null }; }
    if (job.status === 'failed') return { status: 500, body: { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'exception', diagnostics: job.error }] } };
    if (job.status !== 'complete') return { status: 202, body: null, headers: { 'X-Progress': `${job.done} of ${job.types.length} types`, 'Retry-After': '2' } };
    return { status: 200, body: { transactionTime: job.requestedAt, request: job.request, requiresAccessToken: true, output: job.output.map(({ type, url }) => ({ type, url })), deleted: [], error: [] } };
  }
  async function file(id, name, req) {
    const job = jobs.get(id); if (!job || !may(req.person) || job.actor.id !== req.person.id) throw new HttpError(404, 'No such file', 'not-found');
    const bytes = await (await out()).get(`bulk/${id}/${name}`); if (!bytes) throw new HttpError(404, 'No such file', 'not-found');
    return { status: 200, raw: bytes, headers: { 'Content-Type': 'application/fhir+ndjson' } };
  }
  return { kickOff, status, file };
}
