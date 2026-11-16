// Sign-in: scrypt hashes only, sessions, invitations, the three ways the platform runs, and one role per person.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './support/helpers.mjs';
import { hashPassword, verifyPassword } from '../platform/server/accounts.mjs';

const json = { 'Content-Type': 'application/json' };
const raw = async (s, method, url, body, headers = {}) => { const r = await fetch(s.base + url, { method, headers: { ...json, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* not JSON */ } return { status: r.status, json: j, text, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }; };
const secret = () => `pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const person = (n, role = 'physician', extra = {}) => ({ name: `Reader ${n}`, email: `reader${n}@example.test`, role, specialty: 'radiology', seniority: 'senior', credentialed: true, ...extra });

test('a password is kept only as a scrypt hash', async () => {
  const pw = secret(); const h = await hashPassword(pw);
  assert.match(h, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/); assert.ok(!h.includes(pw));
  assert.notEqual(h, await hashPassword(pw), 'each hash has its own salt');
  assert.equal(await verifyPassword(pw, h), true); assert.equal(await verifyPassword(`${pw}x`, h), false); assert.equal(await verifyPassword(pw, ''), false);
});

test('open (the default): the person running the platform is the Researcher; invited people sign in with email and password', async () => {
  const s = await startTestServer({ auth: {} });
  try {
    const mode = await raw(s, 'GET', '/auth/mode');
    assert.deepEqual([mode.json.demo, mode.json.locked, mode.json.me.role, mode.json.signedIn], [false, false, 'researcher', false]);
    // The role a browser names is not believed: without a session it is the Researcher.
    const people0 = await raw(s, 'GET', '/agent-ops/people', undefined, { 'X-Role': 'nurse', 'X-User-Id': 'someone' });
    assert.equal(people0.status, 200, people0.text); assert.deepEqual(people0.json.people, []); assert.deepEqual(people0.json.roles, ['researcher', 'physician', 'nurse', 'coder', 'patient', 'payer-medical-director']);
    assert.equal((await raw(s, 'POST', '/agent-ops/people', { name: 'Reader 0', email: 'r0@example.test', role: 'owner' })).status, 422, 'only the four roles exist');
    assert.equal((await raw(s, 'POST', '/agent-ops/people', { name: 'Reader 0', email: 'not-an-email', role: 'nurse' })).status, 422);
    const made = await raw(s, 'POST', '/agent-ops/people', person(1, 'nurse'));
    assert.equal(made.status, 201, made.text); assert.equal(made.json.person.status, 'invited'); assert.ok(made.json.inviteCode.length >= 20); assert.equal(made.json.inviteLink, `/#invite=${made.json.inviteCode}`);
    assert.ok(Math.abs(Date.parse(made.json.inviteExpires) - Date.now() - 14 * 24 * 3600e3) < 60000, 'the link runs out in 14 days');
    assert.equal((await raw(s, 'POST', '/agent-ops/people', person(1))).status, 409, 'one account per email');
    const id = made.json.person.id; const pw = secret();
    assert.equal((await raw(s, 'POST', '/auth/login', { email: 'reader1@example.test', password: pw })).status, 401, 'no sign-in before the invitation is used');
    assert.equal((await raw(s, 'POST', '/auth/accept', { code: made.json.inviteCode, password: 'short' })).status, 422);
    assert.equal((await raw(s, 'POST', '/auth/accept', { code: 'wrong-code-000', password: pw })).status, 401);
    const accepted = await raw(s, 'POST', '/auth/accept', { code: made.json.inviteCode, password: pw });
    assert.equal(accepted.status, 200, accepted.text); assert.match(accepted.cookie, /^hd_session=/);
    assert.equal((await raw(s, 'POST', '/auth/accept', { code: made.json.inviteCode, password: pw })).status, 401, 'a code works once');
    const login = await raw(s, 'POST', '/auth/login', { email: 'READER1@example.test', password: pw });
    assert.equal(login.status, 200, login.text); assert.equal(login.json.me.role, 'nurse'); assert.equal(login.json.me.passwordHash, undefined);
    const me = await raw(s, 'GET', '/auth/me', undefined, { Cookie: login.cookie });
    assert.deepEqual([me.json.signedIn, me.json.me.id, me.json.me.role], [true, id, 'nurse']);
    // Signed in, the person's own role applies whatever the browser claims: a nurse does not manage people.
    assert.equal((await raw(s, 'GET', '/agent-ops/people', undefined, { Cookie: login.cookie, 'X-Role': 'researcher' })).status, 403);
    // Nothing stored or served carries the password; the hash never leaves the server.
    const stored = await s.store.get('PersonAccount', id);
    assert.match(stored.passwordHash, /^scrypt\$/); assert.ok(!JSON.stringify(stored).includes(pw)); assert.equal(stored.invite, undefined);
    for (const url of ['/agent-ops/people', `/agent-ops/people/${id}`, '/fhir/R4/PersonAccount', `/fhir/R4/PersonAccount/${id}`]) { const r = await raw(s, 'GET', url); assert.ok(!r.text.includes('scrypt$') && !r.text.includes(pw), `${url} does not show the hash`); }
    const everything = JSON.stringify(await s.store.query('TraceStep')) + JSON.stringify(await s.store.query('AuditEvent'));
    assert.ok(!everything.includes(pw) && !everything.includes('scrypt$'), 'the log holds neither the password nor the hash');
    // Wrong passwords slow down, then lock.
    for (let i = 0; i < 5; i += 1) assert.equal((await raw(s, 'POST', '/auth/login', { email: 'reader1@example.test', password: 'wrong-password-1' })).status, 401);
    assert.equal((await raw(s, 'POST', '/auth/login', { email: 'reader1@example.test', password: pw })).status, 429);
    // Switched off: the session ends and sign-in stops.
    // Switched off, or given another role: it applies at the next sign-in, and both changes are logged.
    assert.equal((await raw(s, 'PUT', `/agent-ops/people/${id}`, { role: 'physician' })).status, 200);
    assert.equal((await raw(s, 'GET', '/auth/me', undefined, { Cookie: login.cookie })).json.me.role, 'nurse', 'the session keeps the role held at sign-in');
    assert.equal((await raw(s, 'PUT', `/agent-ops/people/${id}`, { status: 'off' })).status, 200);
    assert.equal((await raw(s, 'GET', '/auth/me', undefined, { Cookie: login.cookie })).json.signedIn, true);
    await raw(s, 'POST', '/auth/logout', {}, { Cookie: login.cookie });
    const changes = (await s.store.query('TraceStep', { where: (x) => x.did.type === 'person.update' })).map((x) => [x.did.args.roleWas, x.did.args.role, x.did.args.status]);
    assert.deepEqual(changes, [['nurse', 'physician', 'active'], ['physician', 'physician', 'off']]);
    // A new invitation replaces the password.
    const again = await raw(s, 'POST', `/agent-ops/people/${id}/invite`, {});
    assert.equal(again.status, 200); assert.equal((await s.store.get('PersonAccount', id)).passwordHash, undefined);
    const out = await raw(s, 'POST', '/auth/logout', {}, { Cookie: accepted.cookie }); assert.equal(out.status, 200);
  } finally { await s.close(); }
});

test('locked (ADMIN_PASSWORD): nothing is read without signing in', async () => {
  const admin = secret();
  const s = await startTestServer({ auth: { adminPassword: admin } });
  try {
    const mode = await raw(s, 'GET', '/auth/mode'); assert.deepEqual([mode.json.locked, mode.json.me, mode.json.signedIn], [true, null, false]);
    for (const url of ['/fhir/R4/Patient', '/agent-ops/people', '/api/counters', '/auth/patients', '/agent-ops/runs']) assert.equal((await raw(s, 'GET', url, undefined, { 'X-Role': 'researcher' })).status, 401, url);
    assert.equal((await fetch(`${s.base}/healthz`)).status, 200);
    assert.equal((await raw(s, 'POST', '/auth/login', { password: 'not-the-password' })).status, 401);
    const login = await raw(s, 'POST', '/auth/login', { password: admin });
    assert.equal(login.status, 200, login.text); assert.equal(login.json.me.role, 'researcher');
    assert.equal((await raw(s, 'GET', '/agent-ops/people', undefined, { Cookie: login.cookie })).status, 200);
    assert.equal((await raw(s, 'POST', '/auth/logout', {}, { Cookie: login.cookie })).status, 200);
    assert.equal((await raw(s, 'GET', '/agent-ops/people', undefined, { Cookie: login.cookie })).status, 401, 'signed out');
  } finally { await s.close(); }
});

test('demo (DEMO_MODE): "Try as" a role with no password', async () => {
  const s = await startTestServer({ auth: { demo: true } });
  try {
    const mode = await raw(s, 'GET', '/auth/mode'); assert.deepEqual([mode.json.demo, mode.json.locked], [true, false]);
    assert.equal((await raw(s, 'GET', '/agent-ops/people', undefined, { 'X-Role': 'nurse' })).status, 403);
    assert.equal((await raw(s, 'GET', '/agent-ops/people', undefined, { 'X-Role': 'researcher' })).status, 200);
  } finally { await s.close(); }
});

test('invitations: email and role are enough; a Patient is linked to a record; links are single-use, can be revoked and reissued; the sign-in log holds no passwords', async () => {
  const s = await startTestServer({ auth: {} });
  try {
    assert.equal((await raw(s, 'POST', '/agent-ops/people', { email: 'pt@example.test', role: 'patient' })).status, 422, 'a Patient needs a patient record');
    assert.equal((await raw(s, 'POST', '/agent-ops/people', { email: 'pt@example.test', role: 'patient', patientId: 'random' })).status, 422, 'no records to pick from yet');
    const rec = await raw(s, 'POST', '/fhir/R4/Patient', { resourceType: 'Patient', gender: 'female', birthDate: '1970-01-01', identifier: [{ system: 'urn:hospital-desktop:mrn', value: 'N700010' }] });
    const pt = await raw(s, 'POST', '/agent-ops/people', { email: 'pt@example.test', role: 'patient', patientId: 'random' });
    assert.equal(pt.status, 201, pt.text); assert.deepEqual([pt.json.person.patientId, pt.json.person.name], [rec.json.id, 'pt@example.test']);
    const a = await raw(s, 'POST', '/agent-ops/people', { email: 'rn@example.test', role: 'nurse' }); const id = a.json.person.id;
    assert.equal((await raw(s, 'POST', `/agent-ops/people/${id}/revoke`, {})).status, 200);
    const pw = secret();
    assert.equal((await raw(s, 'POST', '/auth/accept', { code: a.json.inviteCode, password: pw })).status, 401, 'a revoked link does not work');
    assert.equal((await raw(s, 'POST', `/agent-ops/people/${id}/revoke`, {})).status, 409);
    const b = await raw(s, 'POST', `/agent-ops/people/${id}/invite`, {}); assert.notEqual(b.json.inviteCode, a.json.inviteCode);
    assert.equal((await raw(s, 'POST', '/auth/accept', { code: b.json.inviteCode, password: pw })).status, 200);
    assert.equal((await raw(s, 'POST', '/auth/accept', { code: b.json.inviteCode, password: pw })).status, 401, 'single use');
    await raw(s, 'POST', '/auth/login', { email: 'rn@example.test', password: 'wrong-password-9' });
    const list = (await raw(s, 'GET', '/agent-ops/people')).json.people;
    assert.deepEqual(list.map((p) => [p.email, p.role, p.status, Boolean(p.linkedPatient), p.studies.length]), [['pt@example.test', 'patient', 'invited', true, 0], ['rn@example.test', 'nurse', 'active', false, 0]]);
    assert.match(list[0].linkedPatient.mrn, new RegExp('^N[0-9]{6}$'));
    assert.ok(list[1].lastActive);
    const log = await raw(s, 'GET', '/agent-ops/people/sign-in-log');
    assert.deepEqual(log.json.log.map((l) => l.outcome).reverse(), ['invite-used', 'wrong-password']); assert.ok(!log.text.includes(pw) && !log.text.includes('wrong-password-9') && !log.text.includes('scrypt'));
    assert.equal((await raw(s, 'POST', '/auth/demo', { role: 'nurse' })).status, 403, 'no Try as outside demo mode');
  } finally { await s.close(); }
  const demo = await startTestServer({ auth: { demo: true } });
  try {
    const dm = (await raw(demo, 'GET', '/auth/mode')).json; assert.equal(dm.demoRoles.length, 6); assert.deepEqual(dm.demoButtons.map((b) => b.label), ['Researcher', 'Physician', 'Nurse', 'Coder', 'Patient', 'Insurance Payer'], 'six buttons'); assert.deepEqual([dm.demoButtons[5].role], ['payer-medical-director']);
    assert.equal((await raw(demo, 'POST', '/auth/demo', { role: 'owner' })).status, 422); assert.equal((await raw(demo, 'POST', '/auth/demo', { role: 'patient' })).status, 409);
    const ok = await raw(demo, 'POST', '/auth/demo', { role: 'physician' }); assert.deepEqual([ok.status, ok.json.me.role, ok.json.me.demo], [200, 'physician', true]);
  } finally { await demo.close(); }
});
