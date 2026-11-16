// SMART App Launch 2.x: discovery (/.well-known/smart-configuration), EHR launch and standalone launch with PKCE,
// Backend Services (client_credentials with a signed JWT), refresh, introspection and SMART v1 and v2 scopes.
// Tokens are opaque and kept as hashes. An app acts for the person who launched it (with that person's role) or, for
// backend services, as a read-only system client unless its registration allows writes. Every token and every
// request an app makes is logged as a TraceStep. With RESTRICTED_DATA=true outside apps are off unless the owner
// sets ALLOW_EXTERNAL_APPS=true.
import { randomBytes, createHash, createPublicKey, generateKeyPairSync, sign as signRaw, verify as verifyRaw, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';

const CODE_MS = 60e3; const TOKEN_S = 3600; const REFRESH_MS = 24 * 3600e3; const LAUNCH_MS = 10 * 60e3;
const sha = (v) => createHash('sha256').update(String(v)).digest('hex');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const SCOPE = /^(patient|user|system)\/(\*|[A-Z][A-Za-z]+)\.(read|write|\*|[cruds]+)(\?.*)?$/;
/** "patient/Observation.rs" -> { context, type, perms: Set('r','s') }. v1 read = rs, write = cud, * = cruds. */
export function parseScopes(text) {
  const out = []; for (const s of String(text || '').split(/\s+/).filter(Boolean)) { const m = SCOPE.exec(s); if (!m) continue; const perms = m[3] === 'read' ? 'rs' : m[3] === 'write' ? 'cud' : m[3] === '*' ? 'cruds' : m[3]; out.push({ context: m[1], type: m[2], perms: new Set(perms), query: m[4] ? new URLSearchParams(m[4].slice(1)) : null }); }
  return out;
}
/** Is every permission of the asked scope inside one of the granted scopes (same context, same or wildcard type)? */
export const covers = (granted, asked) => { const a = parseScopes(asked)[0]; if (!a) return false; return parseScopes(granted).some((g) => g.context === a.context && (g.type === '*' || g.type === a.type) && [...a.perms].every((x) => g.perms.has(x))); };
/** May this token do this interaction on this type? interaction: r, s, c, u or d. */
export function allowed(scopes, type, interaction) { return scopes.some((s) => (s.type === '*' || s.type === type) && s.perms.has(interaction)); }

export function createSmart({ store, baseUrl = () => '', restricted = () => process.env.RESTRICTED_DATA === 'true' && process.env.ALLOW_EXTERNAL_APPS !== 'true' }) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }); const kid = sha(keys.publicKey.export({ type: 'spki', format: 'der' })).slice(0, 16);
  const codes = new Map(); const launches = new Map(); const tokens = new Map(); const seenJti = new Map();
  const off = () => { if (restricted()) throw new HttpError(403, 'Outside apps are off while RESTRICTED_DATA=true (set ALLOW_EXTERNAL_APPS=true to allow them)', 'apps-off'); };
  const log = (action, args, description, actor = { kind: 'human', id: 'smart', role: 'system' }) => store.transaction((tx) => recordAction(tx, { runId: LIVE_RUN_ID, actor, kind: 'execute', action, args, description, audit: false })).catch(() => {});
  const jwt = (claims) => { const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })); const body = b64u(JSON.stringify(claims)); return `${head}.${body}.${b64u(signRaw('RSA-SHA256', Buffer.from(`${head}.${body}`), keys.privateKey))}`; };

  const configuration = () => { const b = baseUrl(); return { issuer: `${b}/fhir/R4`, jwks_uri: `${b}/.well-known/jwks.json`, authorization_endpoint: `${b}/oauth/authorize`, token_endpoint: `${b}/oauth/token`, introspection_endpoint: `${b}/oauth/introspect`, registration_endpoint: `${b}/oauth/register`,
    grant_types_supported: ['authorization_code', 'client_credentials', 'refresh_token'], token_endpoint_auth_methods_supported: ['private_key_jwt', 'client_secret_basic', 'none'], token_endpoint_auth_signing_alg_values_supported: ['RS384', 'ES384', 'RS256'],
    scopes_supported: ['openid', 'fhirUser', 'launch', 'launch/patient', 'launch/encounter', 'offline_access', 'online_access', 'patient/*.rs', 'user/*.rs', 'user/*.cruds', 'system/*.rs'], response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
    capabilities: ['launch-ehr', 'launch-standalone', 'client-public', 'client-confidential-symmetric', 'client-confidential-asymmetric', 'context-ehr-patient', 'context-ehr-encounter', 'context-standalone-patient', 'permission-offline', 'permission-online', 'permission-patient', 'permission-user', 'permission-v1', 'permission-v2', 'sso-openid-connect', 'authorize-post'] }; };
  const jwks = () => ({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }] });

  /** Registration (RFC 7591 shape). A person with a session registers; Researcher or Admin only. */
  async function register(body, person) {
    off(); if (!person || person.role !== 'researcher') throw new HttpError(403, 'Only a Researcher registers apps', 'forbidden');
    const redirect = (body?.redirect_uris || []).map(String); const backend = (body?.grant_types || []).includes('client_credentials');
    if (!backend && !redirect.length) throw new HttpError(422, 'Give redirect_uris, or grant_types ["client_credentials"] with a jwks for backend services');
    if (backend && !(body?.jwks?.keys || []).length && !body?.jwks_uri) throw new HttpError(422, 'A backend services client gives its public keys (jwks)');
    const secret = body?.token_endpoint_auth_method === 'client_secret_basic' ? randomBytes(24).toString('base64url') : null; const id = `app-${randomBytes(8).toString('hex')}`;
    const doc = { resourceType: 'SmartClient', id, name: String(body?.client_name || id).slice(0, 120), redirectUris: redirect, grantTypes: backend ? ['client_credentials'] : ['authorization_code', 'refresh_token'], jwks: body?.jwks || null, secretHash: secret ? sha(secret) : null, scope: String(body?.scope || (backend ? 'system/*.rs' : 'launch openid fhirUser patient/*.rs user/*.rs')), allowWrite: Boolean(body?.allow_write && person.admin), createdBy: person.id, createdAt: new Date().toISOString() };
    await store.transaction((tx) => tx.save('SmartClient', doc, { updatedBy: 'smart' })); await log('smart.register', { client: id, backend }, `app registered: ${doc.name}`);
    return { client_id: id, client_name: doc.name, redirect_uris: redirect, grant_types: doc.grantTypes, scope: doc.scope, ...(secret ? { client_secret: secret } : {}), token_endpoint_auth_method: backend ? 'private_key_jwt' : secret ? 'client_secret_basic' : 'none' };
  }
  const client = async (id) => { const c = await store.get('SmartClient', String(id || '')); if (!c) throw new HttpError(401, 'Unknown client_id', 'invalid_client'); return c; };
  /** The EHR makes a launch context for an app it opens: POST /oauth/launch { patient, encounter }. */
  function launch(body, person) { off(); if (!person) throw new HttpError(401, 'Sign in first'); const id = randomBytes(12).toString('base64url'); launches.set(id, { patient: body?.patient || null, encounter: body?.encounter || null, person, until: Date.now() + LAUNCH_MS }); return { launch: id }; }

  /** GET /oauth/authorize: the signed-in person approves for themselves; the code carries their role and the launch context. */
  async function authorize(q, person) {
    off(); const c = await client(q.get('client_id')); const redirect = q.get('redirect_uri');
    if (!c.redirectUris.includes(redirect)) throw new HttpError(400, 'redirect_uri is not registered for this app', 'invalid_request');
    const back = (params) => { const u = new URL(redirect); for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v); u.searchParams.set('state', q.get('state') || ''); return { redirect: u.toString() }; };
    if (q.get('response_type') !== 'code') return back({ error: 'unsupported_response_type' });
    if (!person) return back({ error: 'login_required', error_description: 'Sign in to the platform in this browser first' });
    if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return back({ error: 'invalid_request', error_description: 'PKCE with S256 is required' });
    const aud = q.get('aud'); if (aud && aud.replace(/\/$/, '') !== `${baseUrl()}/fhir/R4` && aud.replace(/\/$/, '') !== `${baseUrl()}/fhir/R5`) return back({ error: 'invalid_request', error_description: 'aud is not this FHIR server' });
    const granted = String(q.get('scope') || '').split(/\s+/).filter((s) => (SCOPE.test(s) && covers(c.scope, s)) || ['openid', 'fhirUser', 'launch', 'launch/patient', 'launch/encounter', 'offline_access', 'online_access'].includes(s));
    let ctx = { patient: null, encounter: null };
    if (q.get('launch')) { const l = launches.get(q.get('launch')); if (!l || l.until < Date.now() || l.person.id !== person.id) return back({ error: 'invalid_request', error_description: 'Unknown or expired launch' }); ctx = { patient: l.patient, encounter: l.encounter }; launches.delete(q.get('launch')); }
    else if (granted.includes('launch/patient')) { if (person.role === 'patient' && person.patientId) ctx.patient = person.patientId; else return back({ error: 'invalid_request', error_description: 'Standalone launch with a patient: open the app from the patient\'s chart (EHR launch), or sign in as that patient' }); }
    if (person.role === 'patient' && person.patientId) ctx.patient = person.patientId;
    const code = randomBytes(24).toString('base64url'); codes.set(sha(code), { client: c.id, redirect, challenge: q.get('code_challenge'), scope: granted.join(' '), person: { id: person.id, role: person.role, patientId: person.patientId || null }, ...ctx, until: Date.now() + CODE_MS });
    await log('smart.authorize', { client: c.id, scope: granted.join(' '), patient: ctx.patient }, `app authorised: ${c.name}`, { kind: 'human', id: person.id, role: person.role });
    return back({ code });
  }
  async function issue({ c, scope, person, patient, encounter, system = false, refresh = false, purpose = null, organization = null }) {
    const token = `hd_smart_${randomBytes(32).toString('base64url')}`; const exp = Date.now() + TOKEN_S * 1000;
    const t = { client: c.id, clientName: c.name, scope, person, patient, encounter, system, allowWrite: Boolean(c.allowWrite), exp, ...(purpose ? { purpose, organization } : {}) };
    tokens.set(sha(token), t); await store.transaction((tx) => tx.save('SmartToken', { resourceType: 'SmartToken', id: sha(token), ...t, expires: new Date(exp).toISOString() }, { updatedBy: 'smart' }));
    const body = { access_token: token, token_type: 'Bearer', expires_in: TOKEN_S, scope, ...(patient ? { patient: String(patient).replace(/^Patient\//, '') } : {}), ...(encounter ? { encounter: String(encounter).replace(/^Encounter\//, '') } : {}) };
    if (refresh) { const r = `hd_smart_${randomBytes(32).toString('base64url')}`; tokens.set(sha(`refresh:${r}`), { ...t, refresh: true, exp: Date.now() + REFRESH_MS }); body.refresh_token = r; }
    if (!system && /\bopenid\b/.test(scope) && /\bfhirUser\b/.test(scope)) body.id_token = jwt({ iss: `${baseUrl()}/fhir/R4`, sub: person.id, aud: c.id, exp: Math.floor(exp / 1000), iat: Math.floor(Date.now() / 1000), fhirUser: person.patientId && person.role === 'patient' ? `${baseUrl()}/fhir/R4/Patient/${person.patientId}` : `${baseUrl()}/fhir/R4/Practitioner/${person.id}` });
    await log('smart.token', { client: c.id, scope, system, patient: patient || null }, `access token issued to ${c.name}`);
    return body;
  }
  /** Verifies a client's signed assertion (Backend Services, SMART 2.x section 7). */
  function verifyAssertion(c, assertion) {
    const [h, p, s] = String(assertion || '').split('.'); if (!s) throw new HttpError(401, 'client_assertion is not a JWT', 'invalid_client');
    const head = JSON.parse(Buffer.from(h, 'base64url')); const claims = JSON.parse(Buffer.from(p, 'base64url')); const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== c.id || claims.sub !== c.id) throw new HttpError(401, 'iss and sub must be the client_id', 'invalid_client');
    if (String(claims.aud).replace(/\/$/, '') !== `${baseUrl()}/oauth/token`) throw new HttpError(401, 'aud must be the token endpoint', 'invalid_client');
    if (!(claims.exp > now) || claims.exp > now + 300) throw new HttpError(401, 'exp must be within five minutes', 'invalid_client');
    if (!claims.jti || seenJti.has(`${c.id}:${claims.jti}`)) throw new HttpError(401, 'jti is missing or was used before', 'invalid_client'); seenJti.set(`${c.id}:${claims.jti}`, claims.exp);
    const alg = { RS384: ['RSA-SHA384', {}], RS256: ['RSA-SHA256', {}], ES384: ['SHA384', { dsaEncoding: 'ieee-p1363' }] }[head.alg]; if (!alg) throw new HttpError(401, `alg ${head.alg} is not supported`, 'invalid_client');
    const ok = (c.jwks?.keys || []).filter((k) => !head.kid || k.kid === head.kid).some((k) => { try { return verifyRaw(alg[0], Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: k, format: 'jwk' }), ...alg[1] }, Buffer.from(s, 'base64url')); } catch { return false; } });
    if (!ok) throw new HttpError(401, 'The client_assertion signature does not match the registered keys', 'invalid_client');
  }
  async function token(body, headers) {
    off(); const g = body?.grant_type;
    if (g === 'authorization_code') {
      const k = codes.get(sha(body.code)); codes.delete(sha(body.code)); if (!k || k.until < Date.now()) throw new HttpError(400, 'The code is unknown, used or expired', 'invalid_grant');
      const c = await client(k.client); if (body.client_id && body.client_id !== c.id) throw new HttpError(400, 'client_id does not match', 'invalid_grant');
      if (c.secretHash) { const m = /^Basic\s+(.+)$/.exec(String(headers.authorization || '')); const [id, sec] = m ? Buffer.from(m[1], 'base64').toString().split(':') : []; if (id !== c.id || !sec || !timingSafeEqual(Buffer.from(sha(sec)), Buffer.from(c.secretHash))) throw new HttpError(401, 'Client authentication failed', 'invalid_client'); }
      if (body.redirect_uri !== k.redirect) throw new HttpError(400, 'redirect_uri does not match', 'invalid_grant');
      if (b64u(createHash('sha256').update(String(body.code_verifier || '')).digest()) !== k.challenge) throw new HttpError(400, 'code_verifier does not match the code_challenge', 'invalid_grant');
      return issue({ c, scope: k.scope, person: k.person, patient: k.patient, encounter: k.encounter, refresh: /offline_access|online_access/.test(k.scope) });
    }
    if (g === 'refresh_token') { const t = tokens.get(sha(`refresh:${body.refresh_token}`)); if (!t || t.exp < Date.now()) throw new HttpError(400, 'The refresh token is unknown or expired', 'invalid_grant'); const c = await client(t.client); return issue({ c, scope: t.scope, person: t.person, patient: t.patient, encounter: t.encounter, refresh: false }); }
    if (g === 'client_credentials') {
      if (body.client_assertion_type !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') throw new HttpError(400, 'Backend services use client_assertion_type jwt-bearer', 'invalid_request');
      const claims = JSON.parse(Buffer.from(String(body.client_assertion || '').split('.')[1] || 'e30', 'base64url')); const c = await client(claims.iss); if (!c.grantTypes.includes('client_credentials')) throw new HttpError(401, 'This client is not a backend services client', 'unauthorized_client'); verifyAssertion(c, body.client_assertion);
      const asked = String(body.scope || '').split(/\s+/).filter((s) => s.startsWith('system/')); const ok = asked.filter((s) => covers(c.scope, s));
      if (!ok.length) throw new HttpError(400, 'None of the asked scopes is granted to this client', 'invalid_scope');
      return issue({ c, scope: ok.join(' '), person: { id: `system:${c.id}`, role: 'researcher' }, system: true });
    }
    throw new HttpError(400, 'grant_type must be authorization_code, refresh_token or client_credentials', 'unsupported_grant_type');
  }
  async function find(raw) { const id = sha(raw); let t = tokens.get(id); if (!t) { const row = await store.get('SmartToken', id); if (row) { t = { ...row, exp: Date.parse(row.expires) }; tokens.set(id, t); } } return t && t.exp > Date.now() && !t.refresh ? t : null; }
  async function introspect(body) { const t = await find(body?.token); return t ? { active: true, scope: t.scope, client_id: t.client, exp: Math.floor(t.exp / 1000), ...(t.patient ? { patient: t.patient } : {}), sub: t.person.id } : { active: false }; }

  /**
   * A request with "Authorization: Bearer <SMART token>": the person the app acts for is set on the request, and the
   * interaction is checked against the token's scopes. Returns true when the request came with an app token.
   */
  async function apply(req, url) {
    const m = /^Bearer\s+(hd_smart_[A-Za-z0-9_-]{30,})$/.exec(String(req.headers.authorization || '')); if (!m || req.headers['x-agent-id']) return false; // an agent's own key is checked by the sign-in, not here
    const t = await find(m[1]); if (!t) throw new HttpError(401, 'The access token is unknown or expired', 'invalid_token'); off();
    const p = url.pathname; const fhir = /^\/fhir\/R[45](\/|$)/.test(p); if (!fhir) throw new HttpError(403, 'An app token reaches the FHIR API only', 'insufficient_scope');
    const parts = p.split('/').filter(Boolean).slice(2); const type = parts[0]; const op = parts.find((x) => x.startsWith('$'));
    const scopes = parseScopes(t.scope); const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !(op && ['$export', '$validate-code', '$lookup', '$expand', '$translate', '$summary', '$ihe-pix'].includes(op)) && !(parts[1] === '_search');
    const inter = req.method === 'DELETE' ? 'd' : req.method === 'PUT' || req.method === 'PATCH' ? 'u' : write ? 'c' : parts.length >= 2 && !parts[1].startsWith('$') && !parts[1].startsWith('_') ? 'r' : 's';
    if (type && type !== 'metadata' && !type.startsWith('$') && !allowed(scopes, type, inter)) throw new HttpError(403, `The token's scopes do not allow ${inter} on ${type}`, 'insufficient_scope');
    if (write && (t.system || scopes.every((s) => s.context === 'patient')) && !t.allowWrite) throw new HttpError(403, 'This app may read only', 'insufficient_scope');
    const patientOnly = scopes.length && scopes.every((s) => s.context === 'patient');
    const role = patientOnly ? 'patient' : t.person.role;
    req.headers['x-role'] = role; req.headers['x-user-id'] = t.person.id; delete req.headers['x-agent-id'];
    req.person = { id: t.person.id, role, patientId: patientOnly ? String(t.patient || '').replace(/^Patient\//, '') || '(none)' : t.person.patientId || null, name: null, email: null, status: 'active', smart: { client: t.client, scope: t.scope, system: t.system, ...(t.purpose ? { purpose: t.purpose, organization: t.organization } : {}) } };
    await log('smart.request', { client: t.client, method: req.method, path: p }, `${t.clientName}: ${req.method} ${p}`, { kind: 'human', id: t.person.id, role });
    return true;
  }
  /** A system token for a client already authenticated elsewhere (UDAP B2B); scope is narrowed to what the client holds. */
  async function issueSystem({ clientId, scope, purpose, organization }) { off(); const c = await client(clientId); const ok = String(scope).split(/\s+/).filter((s) => s.startsWith('system/') && covers(c.scope, s)); if (!ok.length) throw new HttpError(400, 'None of the asked scopes is granted to this client', 'invalid_scope'); return issue({ c, scope: ok.join(' '), person: { id: `system:${c.id}`, role: 'researcher' }, system: true, purpose, organization }); }
  return { configuration, jwks, register, launch, authorize, token, introspect, apply, parseScopes, issueSystem };
}
