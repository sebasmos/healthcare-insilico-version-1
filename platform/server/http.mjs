// Small HTTP helpers shared by the route modules.
import { randomBytes } from 'node:crypto';
import zlib from 'node:zlib';
import { StoreError, numberName } from './store.mjs';

export class HttpError extends Error {
  constructor(status, message, code = 'invalid', extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = extra.issues || null;
  }
}

export async function readJson(req, opts = {}) {
  // The body is read once and kept, so a check made early (a patient's own-record rule) and the handler both see it.
  if (!('_json' in req)) req._json = readJsonOnce(req, opts);
  return req._json;
}
async function readJsonOnce(req, { limit = 5 * 1024 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large', 'too-long');
    chunks.push(chunk);
  }
  if (!size) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON', 'structure');
  }
}

/** Sent by this server's own in-process agents with their agent id, so that in locked mode they need no key. Made anew at each start and never leaves the process. */
export const INTERNAL_AGENT_HEADER = 'x-internal-agent';
export const INTERNAL_AGENT_TOKEN = randomBytes(32).toString('hex');

/** No patient names are served: any Patient record in an answer shows its number in place of a name. */
function scrubNames(v, depth = 0) { if (!v || typeof v !== 'object' || depth > 12) return; if (Array.isArray(v)) { for (const x of v) scrubNames(x, depth + 1); return; } if (v.resourceType === 'Patient' && v.name) numberName(v); for (const k of Object.keys(v)) { const x = v[k]; if (x && typeof x === 'object') scrubNames(x, depth + 1); } }

import { toR5 } from '../../standards/server/r5.mjs';
export function send(res, status, body, headers = {}) {
  if (res.fhirR5 && body && typeof body === 'object' && !Buffer.isBuffer(body)) { body = toR5(body); headers = { ...headers, 'Content-Type': 'application/fhir+json; fhirVersion=5.0; charset=utf-8' }; }
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) scrubNames(body);
  // A patient's session: other patients are taken out of every answer (lib/patient-scope.mjs).
  if (res.patientScope && status < 400 && body && typeof body === 'object' && !Buffer.isBuffer(body)) { const out = res.patientScope(body); if (out.refused) { status = 403; body = { error: 'You can read only your own record', code: 'not-your-record' }; } else body = out.body; }
  const payload = body == null ? '' : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const head = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', ...headers };
  // Large answers (a patient's whole record, a list of results) are sent compressed: several times smaller on the wire.
  const size = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length;
  if (size > 1400 && !head['Content-Encoding'] && /\bgzip\b/.test(String(res.req?.headers?.['accept-encoding'] || '')) && /json|text|javascript|xml/.test(String(head['Content-Type']))) {
    zlib.gzip(payload, { level: 1 }, (err, zipped) => {
      if (err) { res.writeHead(status, head); res.end(payload); return; }
      res.writeHead(status, { ...head, 'Content-Encoding': 'gzip', Vary: [head.Vary, 'Accept-Encoding'].filter(Boolean).join(', ') }); res.end(zipped);
    });
    return;
  }
  res.writeHead(status, head);
  res.end(payload);
}

export function errorStatus(err) {
  if (err instanceof HttpError || err instanceof StoreError) return err.status;
  return 500;
}

const ISSUE_CODE = { 400: 'invalid', 403: 'forbidden', 404: 'not-found', 405: 'not-supported', 409: 'conflict', 410: 'deleted', 412: 'conflict', 413: 'too-long', 422: 'processing', 423: 'lock-error', 429: 'throttled' };

export function operationOutcome(status, message, issues = null) {
  return {
    resourceType: 'OperationOutcome',
    issue: issues || [{ severity: status >= 500 ? 'fatal' : 'error', code: ISSUE_CODE[status] || 'exception', diagnostics: message }],
  };
}

/** Who is acting, in which Run, on which branch, viewing which time. */
export async function requestContext(store, req, url) {
  const agentId = req.headers['x-agent-id'];
  const said = String(req.headers['x-role'] || 'unspecified').slice(0, 64); const role = said === 'payer-reviewer' ? 'payer-medical-director' : said; // the old reviewer role is now Insurance Payer
  const userId = String(req.headers['x-user-id'] || role).slice(0, 128);
  const actor = agentId
    ? { kind: 'agent', id: String(agentId).slice(0, 128), role: 'agent' }
    : { kind: 'human', id: userId, role };
  // The researcher's current study (plan-master 6.2): anything started in this request joins it.
  if (req.headers['x-study-id']) actor.study = String(req.headers['x-study-id']).slice(0, 64);
  const runId = req.headers['x-run-id'] ? String(req.headers['x-run-id']) : null;
  let run = null;
  if (runId) {
    run = await store.get('Run', runId);
    if (!run) throw new HttpError(400, `Unknown X-Run-Id "${runId}"`);
  }
  // A recording that has ended must not block the clinician's next click: their work simply stops being attributed to it.
  let endedCapture = null;
  if (actor.kind === 'human' && run?.mode === 'capture' && run.endedAt) { endedCapture = run; run = null; }
  if (actor.kind === 'agent' && !run) throw new HttpError(400, 'Agents must send X-Run-Id: every agent action happens inside a Run');
  const branch = url.searchParams.get('_branch') || run?.branch || 'main';
  const asOfRaw = url.searchParams.get('_asOf');
  let asOf = null;
  if (asOfRaw) {
    const parsed = new Date(asOfRaw);
    if (Number.isNaN(parsed.getTime())) throw new HttpError(400, `Invalid _asOf "${asOfRaw}"`);
    asOf = parsed.toISOString();
  }
  let why = null;
  if (req.headers['x-reasoning']) {
    try { why = decodeURIComponent(String(req.headers['x-reasoning'])).slice(0, 2000); } catch { why = String(req.headers['x-reasoning']).slice(0, 2000); }
  }
  return { actor, run, runId: run?.id ?? null, endedCapture, branch, asOf, why, idempotencyKey: req.headers['idempotency-key'] || null };
}
