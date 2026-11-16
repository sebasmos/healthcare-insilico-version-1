// The email sign-in (on when SESSION_SECRET is set). Anyone with a real email address comes in with a role they
// choose. Everything the browser holds is in ONE signed cookie named __session. The email itself is never stored:
// a person is known everywhere by a keyed hash of it.
import { randomBytes, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import dnsPromises from 'node:dns/promises';
import { HttpError, INTERNAL_AGENT_HEADER, INTERNAL_AGENT_TOKEN } from './http.mjs';
import { PERSON_ROLES } from './accounts.mjs';
import { mrnOf } from '../../ehr/server/clinical-rules.mjs';

const COOKIE = '__session'; const SESSION_MS = 12 * 3600e3; const DAY = 24 * 3600e3;
const DNS_MS = 3000;
export const ROLE_LABELS = { researcher: 'Researcher', physician: 'Physician', nurse: 'Nurse', coder: 'Coder', patient: 'Patient', 'payer-medical-director': 'Insurance Payer' };
const FORMAT = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
export const cleanEmail = (v) => String(v ?? '').trim().toLowerCase();
export const validFormat = (email) => email.length <= 254 && FORMAT.test(email) && !email.includes('..');
class DnsTimeout extends Error {}

/** Does the domain exist and take mail? An MX lookup, falling back to an address record. No mail server is contacted. */
export function createDomainCheck({ dns = dnsPromises, timeoutMs = DNS_MS, now = () => Date.now() } = {}) {
  const cache = new Map(); // domain -> { ok, at }
  const within = (p) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new DnsTimeout('timeout')), timeoutMs); t.unref?.(); })]).finally(() => clearTimeout(t)); };
  const none = (err) => ['ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'NXDOMAIN', 'ENONAME', 'EBADNAME', 'EREFUSED'].includes(err?.code);
  return async function domainOk(domain) {
    const hit = cache.get(domain); if (hit && now() - hit.at < DAY) return hit.ok;
    const look = async (fn) => { try { const r = await within(fn()); return Array.isArray(r) && r.length > 0; } catch (err) { if (err instanceof DnsTimeout || ['ETIMEOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(err?.code)) throw new DnsTimeout('timeout'); if (none(err)) return false; throw new DnsTimeout('timeout'); } };
    let ok = false;
    try { const mx = await within(dns.resolveMx(domain)); ok = Array.isArray(mx) && mx.some((m) => m.exchange && m.exchange !== '.'); if (!ok && Array.isArray(mx) && mx.length) { cache.set(domain, { ok: false, at: now() }); return false; } } // an MX of "." says: no mail here
    catch (err) { if (err instanceof DnsTimeout || ['ETIMEOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(err?.code)) throw new DnsTimeout('timeout'); if (!none(err)) throw new DnsTimeout('timeout'); }
    if (!ok) ok = (await look(() => dns.resolve4(domain))) || (await look(() => dns.resolve6(domain)));
    cache.set(domain, { ok, at: now() }); return ok;
  };
}

export function createEmailSignIn({ store, secret, restricted = false, dns = undefined, dnsTimeoutMs = undefined, secureCookie = true }) {
  if (!secret || String(secret).length < 32) throw new Error('SESSION_SECRET must be set to a long random value (npm run session-secret)');
  const domainOk = createDomainCheck({ dns, ...(dnsTimeoutMs ? { timeoutMs: dnsTimeoutMs } : {}) });
  const mac = (v) => createHmac('sha256', secret).update(String(v)).digest('base64url');
  /** The id a person is known by everywhere outside the sign-in records: a keyed hash of the email, never the email. */
  const hashedId = (email) => `u-${createHmac('sha256', secret).update(`person:${email}`).digest('hex').slice(0, 20)}`;

  // ---------- the one cookie: { s: the session } with our signature ----------
  function read(req) {
    if (req._hdState) return req._hdState; let state = {};
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]{20,})`).exec(String(req.headers.cookie || ''));
    if (m) { const want = Buffer.from(mac(m[1])); const got = Buffer.from(m[2]); if (want.length === got.length && timingSafeEqual(want, got)) { try { state = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) || {}; } catch { state = {}; } } }
    const now = Date.now(); delete state.u; if (!(state.s && state.s.exp > now)) delete state.s;
    req._hdState = state; return state;
  }
  function write(state) {
    const now = Date.now(); const until = state.s?.exp || 0; const flags = `; HttpOnly; SameSite=Lax; Path=/${secureCookie ? '; Secure' : ''}`;
    if (!(until > now)) return `${COOKIE}=x${flags}; Max-Age=0`;
    const payload = Buffer.from(JSON.stringify(state)).toString('base64url'); return `${COOKIE}=${payload}.${mac(payload)}${flags}; Max-Age=${Math.floor((until - now) / 1000)}`;
  }
  const sessionOf = (req) => { const s = read(req).s; return s ? { personId: s.id, role: s.role === 'payer-reviewer' ? 'payer-medical-director' : s.role, patientId: s.pid ?? null, patientNumber: s.pn ?? null, expires: s.exp } : null; };

  /** Called before anything else: nothing here is for search engines or shared caches. */
  async function gate(req, res) { res.setHeader('X-Robots-Tag', 'noindex'); res.setHeader('Cache-Control', 'private, no-store'); return true; }


  /** The two checks on an email: its shape, then its domain. Returns the cleaned email. */
  async function checked(raw) {
    const email = cleanEmail(raw); if (!validFormat(email)) throw new HttpError(422, 'Please enter a real email address.', 'bad-email');
    let ok; try { ok = await domainOk(email.split('@')[1]); } catch { throw new HttpError(422, 'Couldn\'t check that email, try again.', 'email-check-failed'); }
    if (!ok) throw new HttpError(422, 'Please enter a real email address.', 'bad-email'); return email;
  }
  /** A patient for this session: one from the live record, preferring those with something released so the portal is not empty. */
  let released = null;
  async function pickPatient() {
    const all = await store.query('Patient', {}, { branch: 'main' }); if (!all.length) throw new HttpError(409, 'There are no patients yet, so nobody can sign in as a patient');
    if (!released || Date.now() - released.at > 10 * 60e3) { let refs = []; try { refs = (await store.raw().all("SELECT DISTINCT patient FROM resource_versions WHERE branch = 'main' AND patient IS NOT NULL AND resource_type IN ('Observation', 'DocumentReference', 'DiagnosticReport') AND (CAST(body AS TEXT) LIKE ? OR CAST(body AS TEXT) LIKE ?)", ['%"_released":true%', '%"_released": true%'])).map((r) => String(r.patient).replace(/^Patient\//, '')); } catch { refs = []; } released = { at: Date.now(), ids: new Set(refs) }; }
    const preferred = all.filter((p) => released.ids.has(p.id)); const pool = preferred.length ? preferred : all; const p = pool[randomBytes(4).readUInt32BE(0) % pool.length];
    return { id: p.id, number: mrnOf(p) || p.id.slice(0, 8) };
  }
  const present = (s) => ({ id: s.personId, role: s.role, label: ROLE_LABELS[s.role], patientId: s.patientId, patientNumber: s.patientNumber, name: s.role === 'patient' ? `Patient ${s.patientNumber}` : null });

  async function signIn(req, body) {
    const role = String(body?.role || ''); const email = await checked(body?.email);
    if (!PERSON_ROLES.includes(role)) throw new HttpError(422, 'Choose a role');
    const patient = role === 'patient' ? await pickPatient() : null;
    const s = { id: hashedId(email), role, pid: patient?.id ?? null, pn: patient?.number ?? null, exp: Date.now() + SESSION_MS };
    return { status: 200, body: { me: present({ personId: s.id, role, patientId: s.pid, patientNumber: s.pn }) }, headers: { 'Set-Cookie': write({ ...read(req), s }) } };
  }
  /** Logging out ends the sign-in. */
  async function signOut(req) { const { s: _gone, ...rest } = read(req); return { status: 200, body: { signedOut: true }, headers: { 'Set-Cookie': write(rest) } }; }
  const mode = async (req) => { const s = sessionOf(req); return { email: true, demo: false, locked: true, restricted, roles: PERSON_ROLES.map((id) => ({ id, label: ROLE_LABELS[id] })), signedIn: Boolean(s), me: s ? present(s) : null }; };

  async function auth(req, url, body) {
    const p = url.pathname; const m = req.method;
    if ((p === '/auth/mode' || p === '/auth/me') && m === 'GET') return { status: 200, body: await mode(req) };
    // Asked when the email field loses focus: is this a real address?
    if (p === '/auth/check-email' && m === 'POST') { const email = await checked(body?.email); return { status: 200, body: { ok: true } }; }
    if ((p === '/auth/signin' || p === '/auth/login') && m === 'POST') return signIn(req, body);
    if (p === '/auth/logout' && m === 'POST') return signOut(req);
    throw new HttpError(404, 'No such sign-in action');
  }
  /** Who the request comes from. A session gives the role and the hashed id; an agent must bring its own key; nothing else gets in. */
  async function apply(req) {
    const s = sessionOf(req);
    if (s) { req.headers['x-role'] = s.role; req.headers['x-user-id'] = s.personId; delete req.headers['x-agent-id']; req.person = { id: s.personId, role: s.role, patientId: s.patientId, name: null, email: null, status: 'active' }; return true; }
    if (req.headers['x-agent-id']) {
      const mine = String(req.headers[INTERNAL_AGENT_HEADER] || ''); if (mine && mine.length === INTERNAL_AGENT_TOKEN.length && timingSafeEqual(Buffer.from(mine), Buffer.from(INTERNAL_AGENT_TOKEN))) return true;
      const m = /^Bearer\s+(hd_agent_[0-9a-f]+)$/.exec(String(req.headers.authorization || '')); const key = m ? (await store.query('ConnectorKey', { where: (k) => k.hash === createHash('sha256').update(m[1]).digest('hex') && !k.revokedAt }))[0] : null;
      if (!key || key.agentId !== String(req.headers['x-agent-id'])) throw new HttpError(401, 'An agent must present its own key: send "Authorization: Bearer hd_agent_..." with X-Agent-Id', 'agent-key-required');
      return true;
    }
    return false;
  }

  return { auth, apply, gate, sessionOf: async (req) => sessionOf(req), mode, hashedId, restricted };
}
