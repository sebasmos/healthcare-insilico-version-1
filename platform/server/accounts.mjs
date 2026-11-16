// People and sign-in.
//
// Three ways the platform can run:
//   open    (default) whoever runs it is the Researcher, with no sign-in. Invited people sign in with email and password.
//   locked  ADMIN_PASSWORD is set: nothing is served to a browser that has not signed in. The person who runs the
//           platform signs in with that password; invited people with their own.
//   demo    DEMO_MODE=true: the lock screen offers "Try as" a role, with no password. Tests run this way.
//
// A password is never stored, logged or returned: only a scrypt hash with its own salt. A session is a random
// token in an http-only cookie, held in memory (signing in again is needed after a restart).
// One role per person: researcher, physician, nurse or patient. Being in a study does not change the role.
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError, INTERNAL_AGENT_HEADER, INTERNAL_AGENT_TOKEN } from './http.mjs';
import { recordAction } from './audit.mjs';

const scrypt = promisify(scryptCb);
export const PERSON_ROLES = ['researcher', 'physician', 'nurse', 'coder', 'patient', 'payer-medical-director'];
const SENIORITY = ['student', 'trainee', 'qualified', 'senior', 'consultant'];
const COOKIE = 'hd_session';
const SESSION_MS = 12 * 3600e3; const INVITE_MS = 14 * 24 * 3600e3;
export const DEMO_ROLES = ['researcher', 'physician', 'nurse', 'coder', 'patient', 'payer-medical-director'];
/** The six "Try as" buttons. Insurance Payer is one role (the old reviewer role is an alias of it). */
export const DEMO_BUTTONS = [{ role: 'researcher', label: 'Researcher' }, { role: 'physician', label: 'Physician' }, { role: 'nurse', label: 'Nurse' }, { role: 'coder', label: 'Coder' }, { role: 'patient', label: 'Patient' }, { role: 'payer-medical-director', label: 'Insurance Payer' }];
const MAX_FAILS = 5; const LOCK_MS = 5 * 60e3;
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(String(password), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(password, stored) {
  const [kind, n, r, p, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(String(password), Buffer.from(salt, 'base64'), want.length, { N: Number(n), r: Number(r), p: Number(p) });
  return timingSafeEqual(want, got);
}
const sha = (v) => createHash('sha256').update(String(v)).digest('hex');
const sameText = (a, b) => { const x = Buffer.from(sha(a)); const y = Buffer.from(sha(b)); return timingSafeEqual(x, y); };
const cleanEmail = (v) => String(v || '').trim().toLowerCase();
const passwordProblem = (pw) => (typeof pw !== 'string' || pw.length < 10 ? 'Choose a password of at least 10 characters' : pw.length > 200 ? 'That password is too long' : null);

/** What other code and the browser may see of a person: never the hash or the invitation. */
export function presentPerson(p) {
  if (!p) return null;
  return { id: p.id, name: p.name || p.email, email: p.email, role: p.role, specialty: p.specialty ?? null, seniority: p.seniority ?? null, credentialed: Boolean(p.credentialed), status: p.status, patientId: p.patientId ?? null, lastActive: p.lastActive ?? null, invitedAt: p.invitedAt ?? null };
}

export function createAccounts({ store, demo = false, adminPassword = null }) {
  const locked = Boolean(adminPassword);
  const sessions = new Map(); // token -> { personId | null (the operator), role, patientId, name, expires }: the role is the one held at sign-in
  const fails = new Map();    // email -> { n, until }
  const OPERATOR = { id: 'researcher', name: 'Researcher', email: null, role: 'researcher', operator: true };

  const people = async () => store.query('PersonAccount');
  const byEmail = async (email) => (await people()).find((p) => p.email === email) || null;
  const tokenOf = (req) => { const m = /(?:^|;\s*)hd_session=([A-Za-z0-9_-]{20,})/.exec(String(req.headers.cookie || '')); return m ? m[1] : null; };
  const cookie = (token, ms) => `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(ms / 1000)}`;

  // Sessions are kept in the database under a hash of the token, so a restart does not sign anyone out and a copy
  // of the database does not hold a usable token. The map is only a short-lived cache.
  const sessionId = (token) => sha(`session:${token}`);
  async function sessionOf(req) {
    const token = tokenOf(req); if (!token) return null;
    let s = sessions.get(token);
    if (!s) { const row = await store.get('Session', sessionId(token)); if (!row || row.endedAt) return null; s = { personId: row.personId, role: row.role, patientId: row.patientId, name: row.name, email: row.email, expires: Date.parse(row.expires) }; sessions.set(token, s); }
    if (s.expires < Date.now()) { sessions.delete(token); return null; }
    if (s.personId === null) return { token, person: OPERATOR };
    // What the person could do when they signed in. A change of role, or switching them off, applies at their next sign-in.
    return { token, person: { id: s.personId, role: s.role, patientId: s.patientId ?? null, name: s.name, email: s.email, status: 'active' } };
  }
  async function open(person) {
    const token = randomBytes(32).toString('base64url');
    const s = { personId: person?.id ?? null, role: person?.role ?? 'researcher', patientId: person?.patientId ?? null, name: person?.name ?? null, email: person?.email ?? null, expires: Date.now() + SESSION_MS };
    await store.transaction((tx) => tx.save('Session', { resourceType: 'Session', id: sessionId(token), ...s, expires: new Date(s.expires).toISOString(), startedAt: tx.now(), endedAt: null }, { updatedBy: 'sign-in' }));
    sessions.set(token, s); return token;
  }
  async function end(token) {
    sessions.delete(token);
    await store.transaction(async (tx) => { const row = await tx.get('Session', sessionId(token)); if (row && !row.endedAt) { const { _seq, meta, ...doc } = row; await tx.save('Session', { ...doc, endedAt: tx.now() }, { updatedBy: 'sign-in' }); } }).catch(() => {});
  }
  const endSessionsOf = async (personId) => { for (const row of await store.query('Session', { where: (x) => x.personId === personId && !x.endedAt })) { const { _seq, meta, ...doc } = row; await store.save('Session', { ...doc, endedAt: store.now() }, { updatedBy: 'sign-in' }); } for (const [t, v] of sessions) if (v.personId === personId) sessions.delete(t); };
  /** The sign-in log: who came in, who was turned away, and when. Never a password. */
  const note = (outcome, { email = null, person = null, role = null } = {}) => store.transaction((tx) => tx.save('SignInLog', { resourceType: 'SignInLog', id: randomUUID(), at: tx.now(), outcome, email: email ? String(email).slice(0, 200) : null, person, role, mode: demo ? 'demo' : locked ? 'locked' : 'open' }, { updatedBy: 'sign-in' })).catch(() => {});

  /**
   * Decides who a request comes from and writes it into the request's role and user headers, which the rest of the
   * server already reads. needsIdentity: the path reads or writes records (not a page, script or picture).
   */
  async function apply(req, { needsIdentity }) {
    const s = await sessionOf(req);
    if (s) { if (s.person.role === 'payer-reviewer') s.person = { ...s.person, role: 'payer-medical-director' }; req.headers['x-role'] = s.person.role; req.headers['x-user-id'] = s.person.id; req.person = s.person; return; }
    // The DICOM network gateway (standards/dimse-gateway/gateway.py) is a separate process: it proves itself with its own key.
    const gk = String(req.headers['x-gateway-key'] || '');
    if (gk) { const same = (want) => Boolean(want) && gk.length === want.length && timingSafeEqual(Buffer.from(gk), Buffer.from(want)); const who = same(String(process.env.DIMSE_GATEWAY_KEY || '')) ? 'dimse-gateway' : same(String(process.env.SDC_GATEWAY_KEY || '')) ? 'sdc-gateway' : same(String(process.env.XCA_PEER_KEY || '')) ? 'xca-peer' : null; if (!who) throw new HttpError(401, 'Unknown gateway key', 'gateway-key'); const path = String(req.url || '').split('?')[0]; const scope = { 'dimse-gateway': ['/dicom-web/', '/api/dimse/'], 'sdc-gateway': ['/api/sdc/'], 'xca-peer': ['/xds/soap'] }[who]; if (!scope.some((x) => path.startsWith(x))) throw new HttpError(403, 'This gateway key is not valid here', 'gateway-scope'); req.headers['x-role'] = 'interface'; req.headers['x-user-id'] = who; delete req.headers['x-agent-id']; return; }
    if (demo) return;                                    // "Try as": the role the browser names
    if (req.headers['x-agent-id']) {
      // Open: agents are held by their run and their safety envelope. Locked: an agent id alone is not believed;
      // the agent's own key must come with it (or the request is one of this server's own in-process agents).
      if (!locked) return;
      const mine = String(req.headers[INTERNAL_AGENT_HEADER] || ''); if (mine && mine.length === INTERNAL_AGENT_TOKEN.length && timingSafeEqual(Buffer.from(mine), Buffer.from(INTERNAL_AGENT_TOKEN))) return;
      const m = /^Bearer\s+(hd_agent_[0-9a-f]+)$/.exec(String(req.headers.authorization || ''));
      const key = m ? (await store.query('ConnectorKey', { where: (k) => k.hash === createHash('sha256').update(m[1]).digest('hex') && !k.revokedAt }))[0] : null;
      if (!key || key.agentId !== String(req.headers['x-agent-id'])) throw new HttpError(401, 'An agent must present its own key: send "Authorization: Bearer hd_agent_..." with X-Agent-Id', 'agent-key-required');
      return;
    }
    if (!locked) { req.headers['x-role'] = 'researcher'; req.headers['x-user-id'] = 'researcher'; req.person = OPERATOR; return; }
    if (needsIdentity) throw new HttpError(401, 'Sign in to continue', 'sign-in-required');
  }

  const mode = async (req) => { const s = await sessionOf(req); return { demo, demoRoles: demo ? DEMO_ROLES : [], demoButtons: demo ? DEMO_BUTTONS : [], locked, me: s ? (s.person.operator ? { ...OPERATOR } : presentPerson(s.person)) : (!demo && !locked ? { ...OPERATOR } : null), signedIn: Boolean(s) }; };

  async function login(req, body) {
    const email = cleanEmail(body?.email); const password = body?.password;
    if (typeof password !== 'string' || !password) throw new HttpError(422, 'Enter your password');
    const key = email || '(operator)'; const f = fails.get(key);
    if (f && f.until > Date.now()) { await note('locked-out', { email }); throw new HttpError(429, `Too many wrong passwords. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} minute(s).`); }
    const wrong = async () => {
      const n = (f && f.until !== 0 ? 0 : f?.n || 0) + 1; fails.set(key, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
      await note('wrong-password', { email: email || '(the person running the platform)' });
      await new Promise((r) => setTimeout(r, Math.min(200 * n, 1500))); // each wrong try answers a little more slowly
      throw new HttpError(401, 'The email or password is not right');
    };
    // The person who runs the platform.
    if (adminPassword && !email) {
      if (!sameText(password, adminPassword)) return wrong();
      fails.delete(key); const token = await open(null); await note('signed-in', { email: email || '(the person running the platform)', role: 'researcher' });
      return { status: 200, body: { me: { ...OPERATOR } }, headers: { 'Set-Cookie': cookie(token, SESSION_MS) } };
    }
    const p = email ? await byEmail(email) : null;
    if (!p || p.status !== 'active' || !p.passwordHash || !(await verifyPassword(password, p.passwordHash))) return wrong();
    fails.delete(key); const token = await open(p); await note('signed-in', { email, person: p.id, role: p.role });
    await store.transaction(async (tx) => { const { _seq, meta, ...cur } = await tx.get('PersonAccount', p.id); await tx.save('PersonAccount', { ...cur, lastActive: tx.now() }, { updatedBy: 'sign-in' }); });
    return { status: 200, body: { me: presentPerson(p) }, headers: { 'Set-Cookie': cookie(token, SESSION_MS) } };
  }

  /** First sign-in: the invitation code and a password of the person's own choosing. */
  async function accept(body) {
    const code = String(body?.code || '').trim(); const problem = passwordProblem(body?.password);
    if (!code) throw new HttpError(422, 'Enter your invitation code');
    if (problem) throw new HttpError(422, problem);
    const p = (await people()).find((x) => x.invite?.hash === sha(code));
    if (!p || p.status === 'off' || Date.parse(p.invite.expires) < Date.now()) throw new HttpError(401, 'That invitation code is not valid or has run out. Ask for a new one.');
    const passwordHash = await hashPassword(body.password);
    const saved = await store.transaction(async (tx) => { const { _seq, meta, invite, ...cur } = await tx.get('PersonAccount', p.id); return tx.save('PersonAccount', { ...cur, passwordHash, status: 'active', lastActive: tx.now() }, { updatedBy: 'sign-in' }); });
    const token = await open(saved); await note('invite-used', { email: saved.email, person: saved.id, role: saved.role });
    return { status: 200, body: { me: presentPerson(saved) }, headers: { 'Set-Cookie': cookie(token, SESSION_MS) } };
  }

  /** Demo mode's "Try as": no password. Try as Patient takes a patient at random from those that have been imported. */
  async function demoStart(body) {
    if (!demo) throw new HttpError(403, 'Trying a role without signing in is only possible in demo mode');
    const role = String(body?.role || ''); if (!DEMO_ROLES.includes(role)) throw new HttpError(422, `Try as one of: ${DEMO_ROLES.join(', ')}`);
    let patientId = null;
    if (role === 'patient') { const all = await store.head('Patient'); if (!all.length) throw new HttpError(409, 'There are no patients yet. Import data first, then try as a patient.'); patientId = all[Math.floor(Math.random() * all.length)].id; }
    await note('demo', { role });
    return { status: 200, body: { me: { id: `demo-${role}`, role, patientId, demo: true } } };
  }
  /** /auth/mode, /auth/me, /auth/login, /auth/logout, /auth/accept, /auth/demo */
  async function auth(req, url, body) {
    const p = url.pathname; const m = req.method;
    if ((p === '/auth/mode' || p === '/auth/me') && m === 'GET') return { status: 200, body: await mode(req) };
    if (p === '/auth/login' && m === 'POST') return login(req, body);
    if (p === '/auth/accept' && m === 'POST') return accept(body);
    if (p === '/auth/demo' && m === 'POST') return demoStart(body);
    if (p === '/auth/logout' && m === 'POST') { const t = tokenOf(req); const was = t ? (await sessionOf(req))?.person : null; if (t) await end(t); if (was) await note('signed-out', { email: was.email ?? null, person: was.operator ? null : was.id, role: was.role }); return { status: 200, body: { signedOut: true }, headers: { 'Set-Cookie': cookie('x', 0) } }; }
    throw new HttpError(404, 'No such sign-in action');
  }

  function clean(body, cur = {}) {
    const out = { ...cur };
    if (body.name !== undefined) { out.name = String(body.name).trim().slice(0, 120); if (!out.name) throw new HttpError(422, 'A name is required'); }
    if (body.email !== undefined) { out.email = cleanEmail(body.email); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new HttpError(422, 'A valid email address is required'); }
    if (body.role !== undefined) { if (!PERSON_ROLES.includes(body.role)) throw new HttpError(422, `role must be one of: ${PERSON_ROLES.join(', ')}`); out.role = body.role; }
    if (body.specialty !== undefined) out.specialty = body.specialty ? String(body.specialty).trim().slice(0, 80) : null;
    if (body.seniority !== undefined) { if (body.seniority && !SENIORITY.includes(body.seniority)) throw new HttpError(422, `seniority must be one of: ${SENIORITY.join(', ')}`); out.seniority = body.seniority || null; }
    if (body.credentialed !== undefined) out.credentialed = Boolean(body.credentialed);
    if (body.patientId !== undefined) out.patientId = body.patientId ? String(body.patientId).split('/').pop().slice(0, 64) : null;
    return out;
  }
  const newInvite = () => { const code = randomBytes(18).toString('base64url'); return { code, invite: { hash: sha(code), expires: new Date(Date.now() + INVITE_MS).toISOString() } }; };

  /** /agent-ops/people: the Researcher adds people and gives each an invitation code (shown once). */
  async function handlePeople(req, url, body, ctx) {
    const parts = url.pathname.split('/').filter(Boolean).slice(2); const m = req.method;
    if (ctx.actor.kind !== 'human' || ctx.actor.role !== 'researcher') throw new HttpError(403, 'Only a Researcher manages people');
    if (!parts.length && m === 'GET') {
      const studies = await store.query('EvalStudy'); const patients = new Map((await store.head('Patient')).map((p) => [p.id, p]));
      const mrnOf = (p) => p?.identifier?.find((i) => i.type?.coding?.some((c) => c.code === 'MR'))?.value ?? p?.identifier?.[0]?.value ?? null;
      const rows = (await people()).map((p) => ({ ...presentPerson(p), inviteExpires: p.invite?.expires ?? null, linkedPatient: p.patientId ? { id: p.patientId, mrn: mrnOf(patients.get(p.patientId)), found: patients.has(p.patientId) } : null, studies: studies.filter((s) => s.participants.some((x) => x.kind === 'person' && x.id === p.id) || s.adjudicator === p.id).map((s) => ({ id: s.id, title: s.title, status: s.status })) }));
      return { status: 200, body: { people: rows.sort((a, b) => a.name.localeCompare(b.name)), roles: PERSON_ROLES, seniority: SENIORITY } };
    }
    if (parts[0] === 'sign-in-log' && m === 'GET') return { status: 200, body: { log: (await store.query('SignInLog')).map(({ _seq, meta, resourceType, ...x }) => x).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 500) } };
    if (!parts.length && m === 'POST') {
      const doc = clean({ ...(body || {}), name: body?.name || body?.email || '' });
      if (!doc.email || !doc.role) throw new HttpError(422, 'email and role are required');
      if (doc.role === 'patient' && body?.patientId === 'random') { const all = await store.head('Patient'); if (!all.length) throw new HttpError(422, 'There are no patient records to link yet'); doc.patientId = all[Math.floor(Math.random() * all.length)].id; }
      if (doc.role === 'patient' && !doc.patientId) throw new HttpError(422, 'A Patient is linked to a patient record: choose one, or random');
      if (await byEmail(doc.email)) throw new HttpError(409, 'Someone with that email is already here');
      if (doc.role === 'patient' && doc.patientId && !(await store.get('Patient', doc.patientId))) throw new HttpError(422, 'That patient record does not exist');
      const { code, invite } = newInvite();
      const saved = await store.transaction(async (tx) => {
        const s = await tx.save('PersonAccount', { resourceType: 'PersonAccount', id: randomUUID(), ...doc, credentialed: Boolean(doc.credentialed), status: 'invited', invite, invitedAt: tx.now() }, { updatedBy: ctx.actor.role });
        await recordAction(tx, { actor: ctx.actor, kind: 'create', action: 'person.invite', args: { person: s.id, role: s.role }, entityRef: `PersonAccount/${s.id}`, versionId: s.meta.versionId, description: `a ${s.role} was invited` });
        return s;
      });
      return { status: 201, body: { person: presentPerson(saved), inviteCode: code, inviteLink: `/#invite=${code}`, inviteExpires: invite.expires, inviteNote: 'Shown once. Send this link to the person yourself: it works once, and they choose their own password with it. It runs out in 14 days.' } };
    }
    const cur = parts[0] ? await store.get('PersonAccount', parts[0]) : null;
    if (!cur) throw new HttpError(404, 'No such person');
    if (parts.length === 1 && m === 'GET') return { status: 200, body: presentPerson(cur) };
    if (parts.length === 1 && m === 'PUT') {
      const { _seq, meta, ...base } = cur; const next = clean(body || {}, base);
      if (next.email !== cur.email && await byEmail(next.email)) throw new HttpError(409, 'Someone with that email is already here');
      if (body?.status !== undefined) { if (!['active', 'off'].includes(body.status) || (body.status === 'active' && !cur.passwordHash)) throw new HttpError(422, 'status can be set to off, or back to active for someone who has signed in before'); next.status = body.status; }
      const saved = await store.transaction(async (tx) => { const s = await tx.save('PersonAccount', next, { updatedBy: ctx.actor.role }); await recordAction(tx, { actor: ctx.actor, kind: 'update', action: 'person.update', args: { person: s.id, status: s.status, role: s.role, roleWas: cur.role, statusWas: cur.status }, entityRef: `PersonAccount/${s.id}`, versionId: s.meta.versionId, description: cur.role !== s.role ? `role changed from ${cur.role} to ${s.role}; it applies at the next sign-in` : cur.status !== s.status ? `sign-in ${s.status === 'off' ? 'switched off' : 'allowed again'}; it applies at the next sign-in` : 'a person was changed' }); return s; });
      return { status: 200, body: presentPerson(saved) };
    }
    if (parts.length === 2 && parts[1] === 'invite' && m === 'POST') {
      const { code, invite } = newInvite(); const { _seq, meta, passwordHash, ...base } = cur;
      const saved = await store.transaction(async (tx) => { const s = await tx.save('PersonAccount', { ...base, invite, status: 'invited' }, { updatedBy: ctx.actor.role }); await recordAction(tx, { actor: ctx.actor, kind: 'update', action: 'person.reinvite', args: { person: s.id }, entityRef: `PersonAccount/${s.id}`, versionId: s.meta.versionId, description: 'a new invitation was made; the old password no longer works' }); return s; });
      await endSessionsOf(saved.id);
      return { status: 200, body: { person: presentPerson(saved), inviteCode: code, inviteLink: `/#invite=${code}`, inviteExpires: invite.expires, inviteNote: 'Shown once. The earlier link and the old password no longer work.' } };
    }
    if (parts.length === 2 && parts[1] === 'revoke' && m === 'POST') {
      if (!cur.invite) throw new HttpError(409, 'This person has no invitation waiting');
      const { _seq, meta, invite, ...base } = cur;
      const saved = await store.transaction(async (tx) => { const s = await tx.save('PersonAccount', { ...base, status: base.passwordHash ? 'active' : 'off' }, { updatedBy: ctx.actor.role }); await recordAction(tx, { actor: ctx.actor, kind: 'update', action: 'person.revoke-invite', args: { person: s.id }, entityRef: `PersonAccount/${s.id}`, versionId: s.meta.versionId, description: 'an invitation was revoked' }); return s; });
      return { status: 200, body: { person: presentPerson(saved) } };
    }
    throw new HttpError(404, 'No such people action');
  }

  return { apply, auth, handlePeople, mode, sessionOf, people: async () => (await people()).map(presentPerson), get: async (id) => presentPerson(await store.get('PersonAccount', id)), demo, locked };
}
