// Browser client for the FHIR API and the /api helper routes. Reads carry the
// current view (as-of time and branch); writes carry who is acting.
import { capture } from './capture.js';

const listeners = new Set();
const stored = (() => { try { return JSON.parse(sessionStorage.getItem('hd.view') || '{}'); } catch { return {}; } })();
const state = { asOf: stored.asOf || null, branch: stored.branch || 'main', runId: stored.runId || null };
// A link may open an app on a branch (for example a practice copy): ?branch=<id>. It stays for this tab until changed.
try {
  const asked = new URLSearchParams(location.search).get('branch');
  if (asked && /^[A-Za-z0-9-]{1,64}$/.test(asked)) {
    state.branch = asked; state.asOf = null;
    sessionStorage.setItem('hd.view', JSON.stringify(state));
  }
  // ?run=<id>: this tab works inside that run (a masked session sees the chart with parts hidden).
  const run = new URLSearchParams(location.search).get('run');
  if (run && /^[A-Za-z0-9-]{1,64}$/.test(run)) { state.runId = run; sessionStorage.setItem('hd.view', JSON.stringify(state)); }
  // ?asOf=<ISO time>: what the system had recorded at that moment (read-only), from the time machine.
  const at = new URLSearchParams(location.search).get('asOf');
  if (at && !Number.isNaN(new Date(at).getTime())) { state.asOf = new Date(at).toISOString(); sessionStorage.setItem('hd.view', JSON.stringify(state)); }
} catch { /* no location or storage */ }

// A recording made on a practice copy keeps the clinical apps on that copy while it runs.
try {
  const practice = capture.active?.practiceBranch;
  if (practice && state.branch === 'main' && !location.pathname.startsWith('/agent-ops')) { state.branch = practice; state.asOf = null; }
} catch { /* no location */ }

export const view = {
  get asOf() { return state.asOf; },
  get branch() { return state.branch; },
  get runId() { return state.runId || capture.runId; },
  get readOnly() { return Boolean(state.asOf); },
  get live() { return !state.asOf && state.branch === 'main'; },
  set(next) {
    Object.assign(state, next);
    try { sessionStorage.setItem('hd.view', JSON.stringify(state)); } catch { /* storage unavailable */ }
    listeners.forEach((fn) => fn(state));
  },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

export const identity = {
  get role() { try { return localStorage.getItem('hd.role') || 'physician'; } catch { return 'physician'; } },
  set role(v) { try { localStorage.setItem('hd.role', v); } catch { /* ignore */ } },
  get user() { try { return localStorage.getItem('hd.user') || ''; } catch { return ''; } },
  set user(v) { try { localStorage.setItem('hd.user', v); } catch { /* ignore */ } },
  get display() { return this.user || this.role.replace(/^\w/, (m) => m.toUpperCase()); },
};

export class FhirError extends Error {
  constructor(status, body) {
    const issues = body?.issue || [];
    super(issues.map((i) => i.diagnostics).filter(Boolean).join(' ') || body?.error || `Request failed (${status})`);
    this.status = status;
    this.body = body;
    this.alerts = issues
      .map((i) => ({
        code: i.details?.coding?.[0]?.code, message: i.diagnostics,
        existing: i.extension?.find((e) => e.url === 'existing')?.valueReference?.reference,
        existingDate: i.extension?.find((e) => e.url === 'existingDate')?.valueDateTime,
        overrideUrl: i.extension?.find((e) => e.url === 'overrideExtension')?.valueUri,
      }))
      .filter((a) => a.code);
  }
}

// An app can act under a fixed identity without changing the shared role
// (the portal always acts as the patient).
let forced = null;
export function actAs(role, user) { forced = { role, user }; }

export function requestHeaders() { return headers(); }
function headers() {
  const role = forced?.role ?? identity.role;
  const user = forced?.user ?? identity.user;
  const h = { 'Content-Type': 'application/json', 'X-Role': role };
  if (user) h['X-User-Id'] = user.replace(/[^\x20-\x7e]/g, '?');
  // The researcher's current study (plan-master 6.2): everything started joins it.
  try { const study = localStorage.getItem('hd.study'); if (study) h['X-Study-Id'] = study; } catch { /* ignore */ }
  const runId = state.runId || capture.runId;
  if (runId) h['X-Run-Id'] = runId;
  return h;
}

function withView(path, params = {}, { timeless = false } = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
  if (!timeless && state.asOf) q.set('_asOf', state.asOf);
  if (state.branch !== 'main') q.set('_branch', state.branch);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

async function request(method, url, body) {
  const response = await fetch(url, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!response.ok) throw new FhirError(response.status, json);
  return json;
}

const BASE = '/fhir/R4';
// Signing and ordering are the two moments a recording may ask "why?". Only the reference leaves this module.
const ORDERS = ['ServiceRequest', 'MedicationRequest'];
function acted(what, resource) {
  try { window.dispatchEvent(new CustomEvent('hd:acted', { detail: { what, ref: `${resource.resourceType}/${resource.id}` } })); } catch { /* not in a browser */ }
}
export const fhir = {
  async search(type, params) { return ((await request('GET', withView(`${BASE}/${type}`, params))).entry || []).map((e) => e.resource); },
  read: (type, id) => request('GET', withView(`${BASE}/${type}/${id}`)),
  async history(type, id) { return ((await request('GET', withView(`${BASE}/${type}/${id}/_history`, {}, { timeless: true }))).entry || []).map((e) => e.resource); },
  async everything(id) { return ((await request('GET', withView(`${BASE}/Patient/${id}/$everything`))).entry || []).map((e) => e.resource); },
  async create(resource) { const out = await request('POST', withView(`${BASE}/${resource.resourceType}`, {}, { timeless: true }), resource); if (ORDERS.includes(out?.resourceType)) acted('ordered', out); return out; },
  update: (resource) => request('PUT', withView(`${BASE}/${resource.resourceType}/${resource.id}`, {}, { timeless: true }), resource),
  async transition(r, to, reason) { const out = await request('POST', withView(`${BASE}/${r.resourceType}/${r.id}/$transition`, {}, { timeless: true }), { to, reason }); if (to === 'final') acted('signed', out ?? r); return out; },
  release: (r, released = true) => request('POST', withView(`${BASE}/${r.resourceType}/${r.id}/$release`, {}, { timeless: true }), { released }),
  acknowledge: (r, comment) => request('POST', withView(`${BASE}/${r.resourceType}/${r.id}/$acknowledge`, {}, { timeless: true }), { comment }),
  cosign: (r) => request('POST', withView(`${BASE}/${r.resourceType}/${r.id}/$cosign`, {}, { timeless: true }), {}),
  async transaction(resources) {
    const bundle = { resourceType: 'Bundle', type: 'transaction', entry: resources.map((resource) => ({ request: { method: 'POST', url: resource.resourceType }, resource })) };
    const out = ((await request('POST', withView(BASE, {}, { timeless: true }), bundle)).entry || []).map((e) => e.resource);
    const order = out.find((r) => ORDERS.includes(r?.resourceType));
    if (order) acted('ordered', order);
    return out;
  },
};

export const api = {
  get: (path, params) => request('GET', withView(path, params)),
  post: (path, body) => request('POST', withView(path, {}, { timeless: true }), body),
  put: (path, body) => request('PUT', withView(path, {}, { timeless: true }), body),
  del: (path) => request('DELETE', withView(path, {}, { timeless: true })),
};

let catalogCache = null;
export async function catalog() {
  if (!catalogCache) catalogCache = await request('GET', '/api/catalog');
  return catalogCache;
}

// Small readers for common FHIR shapes.
export const flagged = (r, code) => (r.meta?.tag || []).some((t) => t.system === 'urn:hospital-desktop:flags' && t.code === code);
export const ext = (r, url) => { const e = (r.extension || []).find((x) => x.url === url); return e ? (e.valueString ?? e.valueCode ?? null) : null; };
export const lifecycle = (r) => ext(r, 'urn:hospital-desktop:lifecycle') ?? (r.resourceType === 'DocumentReference' ? (r.docStatus || 'preliminary') : r.status);
export const coding = (concept) => (Array.isArray(concept) ? concept[0] : concept)?.coding?.[0] || {};
export const display = (concept) => { const c = Array.isArray(concept) ? concept[0] : concept; return c?.text || c?.coding?.[0]?.display || c?.coding?.[0]?.code || ''; };
export const mrn = (p) => (p.identifier || []).find((i) => i.type?.coding?.some((c) => c.code === 'MR'))?.value || '';
// A patient with no name on file is known by the record number.
export const patientName = (p) => { const n = p?.name?.[0] || {}; const id = (p?.identifier || []).find((i) => i.type?.coding?.some((c) => c.code === 'MR'))?.value; return [n.family, (n.given || []).join(' ')].filter(Boolean).join(', ') || n.text || (id ? `MRN ${id}` : 'Unnamed patient'); };
export const refId = (ref) => (ref || '').split('/')[1] || null;
