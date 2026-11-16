// The email sign-in: one signed __session cookie, a real-email check, roles, a random patient that stays for the
// session, 401 for data without a session, and logging out. Every fixture is made here, without names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './support/helpers.mjs';

const SECRET = 'test-secret-test-secret-test-secret-0123456789';
const err = (code) => Object.assign(new Error(code), { code });
const dns = { // made-up domains: one takes mail, one has only an address, one does not exist, one never answers
  resolveMx: async (d) => (d === 'mail.test' ? [{ exchange: 'mx.mail.test', priority: 10 }] : d === 'slow.test' ? new Promise(() => {}) : d === 'address-only.test' ? Promise.reject(err('ENODATA')) : Promise.reject(err('ENOTFOUND'))),
  resolve4: async (d) => (d === 'address-only.test' ? ['192.0.2.1'] : Promise.reject(err('ENOTFOUND'))), resolve6: async () => Promise.reject(err('ENOTFOUND')),
};
async function server() {
  const s = await startTestServer({ auth: { email: { secret: SECRET, dns, dnsTimeoutMs: 200 } } });
  // A browser: it keeps the one cookie the server gives it.
  let nth = 0; const browser = (ip = `198.51.100.${(nth += 1)}`) => { let cookie = ''; const b = async (method, url, body) => { const r = await fetch(s.base + url, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `${ip}, 10.0.0.1`, 'User-Agent': 'TestBrowser/1.0', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const set = r.headers.get('set-cookie'); if (set) { b.lastSetCookie = set; cookie = /Max-Age=0/.test(set) ? '' : set.split(';')[0]; } const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } return { status: r.status, text, json, headers: r.headers }; }; b.cookie = () => cookie; return b; };
  return { s, browser };
}
const patients = async (s, n = 3) => { const out = []; for (let i = 0; i < n; i += 1) out.push(await s.store.save('Patient', { resourceType: 'Patient', gender: 'female', birthDate: '1970-01-01', identifier: [{ system: 'urn:hospital-desktop:mrn', type: { coding: [{ code: 'MR' }] }, value: `N10000${i}` }] }, { branch: 'main', updatedBy: 'test' })); return out; };

test('emails, roles, the patient who stays, 401 without a session, and logging out', async () => {
  const { s, browser } = await server();
  try {
    const made = await patients(s); const b = browser();
    // Emails.
    const bad = (r) => { assert.equal(r.status, 422, r.text); assert.equal(r.json.error, 'Please enter a real email address.'); };
    bad(await b('POST', '/auth/signin', { email: 'not-an-email', role: 'nurse' })); bad(await b('POST', '/auth/signin', { email: 'someone@nowhere', role: 'nurse' })); bad(await b('POST', '/auth/signin', { email: 'someone@made-up-domain.test', role: 'nurse' }));
    const slow = await b('POST', '/auth/signin', { email: 'someone@slow.test', role: 'nurse' }); assert.equal(slow.status, 422); assert.equal(slow.json.error, 'Couldn\'t check that email, try again.');
    assert.equal((await b('POST', '/auth/signin', { email: 'someone@address-only.test', role: 'nurse' })).status, 200, 'a domain with only an address record counts');
    assert.equal((await b('POST', '/auth/signin', { email: 'someone@mail.test', role: 'wizard' })).status, 422);
    // Every role; the email is trimmed and lowercased; the id is a hash, never the email.
    for (const role of ['researcher', 'physician', 'nurse', 'coder', 'payer-medical-director']) { const one = browser(); const r = await one('POST', '/auth/signin', { email: '  Some.One@Mail.Test ', role }); assert.equal(r.status, 200, r.text); assert.equal(r.json.me.role, role); assert.match(r.json.me.id, /^u-[0-9a-f]{20}$/); assert.ok(!JSON.stringify(r.json).includes('mail.test')); assert.equal((await one('GET', '/auth/me')).json.me.role, role); }
    // Patient: a random patient from the live record, the same on every page load, and only their own record.
    const pt = browser('192.0.2.77'); const in1 = await pt('POST', '/auth/signin', { email: 'p@mail.test', role: 'patient' }); assert.equal(in1.status, 200, in1.text);
    const mine = in1.json.me; assert.ok(made.some((p) => p.id === mine.patientId)); assert.match(mine.patientNumber, /^N10000\d$/); assert.equal(mine.name, `Patient ${mine.patientNumber}`);
    for (let i = 0; i < 3; i += 1) assert.equal((await pt('GET', '/auth/me')).json.me.patientId, mine.patientId);
    assert.equal((await pt('GET', `/fhir/R4/Patient/${mine.patientId}`)).status, 200); assert.equal((await pt('GET', `/fhir/R4/Patient/${made.find((p) => p.id !== mine.patientId).id}`)).status, 403);
    const nurse = browser(); await nurse('POST', '/auth/signin', { email: 'n@mail.test', role: 'nurse' });
    { const inside = JSON.parse(Buffer.from(nurse.cookie().split('=')[1].split('.')[0], 'base64url').toString()); assert.ok(!JSON.stringify(inside).includes('mail.test'), 'no email in the cookie'); }
    for (const url of ['/admin/', '/admin/api/signins', '/unlock/anything']) assert.notEqual((await nurse('GET', url)).status, 200, url);
    // Not signed in: every data route says 401; the sign-in page and what it is made of still load.
    const fresh = browser();
    for (const url of ['/fhir/R4/Patient', `/fhir/R4/Patient/${made[0].id}`, '/dicom-web/studies', '/api/pacs/worklist', '/api/ins/auth', '/api/ecg/patients', '/pathology/slides/x/info', '/agent-ops/runs']) assert.equal((await fresh('GET', url)).status, 401, url);
    assert.equal((await fresh('GET', '/api/wallpapers')).status, 200, 'the wallpaper list is shown on the sign-in screen'); assert.equal((await fresh('POST', '/api/wallpapers', {})).status, 401);
    assert.equal((await fresh('POST', '/fhir/R4/Patient', { resourceType: 'Patient' })).status, 401);
    for (const url of ['/', '/desktop.js', '/shared/ui.css', '/healthz']) assert.equal((await fresh('GET', url)).status, 200, url);
    // What the log keeps of a person is the hashed id, never the email.
    const doc = browser(); const me = (await doc('POST', '/auth/signin', { email: 'dr@mail.test', role: 'physician' })).json.me;
    const made2 = await doc('POST', '/fhir/R4/Patient', { resourceType: 'Patient', gender: 'male', birthDate: '1980-01-01' }); assert.equal(made2.status, 201, made2.text);
    const trail = JSON.stringify([await s.store.query('TraceStep', {}), await s.store.query('AuditEvent', {})]); assert.ok(trail.includes(me.id)); assert.ok(!trail.includes('mail.test'));
    // Logging out ends the sign-in.
    assert.equal((await nurse('GET', '/fhir/R4/Patient')).status, 200); assert.equal((await nurse('POST', '/auth/logout', {})).status, 200);
    assert.equal((await nurse('GET', '/fhir/R4/Patient')).status, 401); assert.equal((await nurse('GET', '/')).status, 200); assert.equal((await nurse('GET', '/auth/mode')).json.signedIn, false);
  } finally { await s.close(); }
});

test('the sign-in page is open and data is not', async () => {
  const { s, browser } = await server();
  try { const b = browser(); assert.equal((await b('GET', '/')).status, 200); assert.equal((await b('GET', '/healthz')).status, 200); assert.equal((await b('GET', '/fhir/R4/Patient')).status, 401); assert.equal((await b('GET', '/')).headers.get('x-robots-tag'), 'noindex'); }
  finally { await s.close(); }
});

test('the files allowed before sign-in are exactly what the sign-in page loads, and every answer is private and not stored', async () => {
  const fs = await import('node:fs'); const path = await import('node:path'); const { SIGN_IN_PAGE } = await import('../platform/server/index.mjs'); const { REPO_ROOT } = await import('../platform/server/db/index.mjs'); const { webFile } = await import('../platform/server/web-files.mjs');
  const seen = new Set(); const walk = (u) => { if (seen.has(u)) return; seen.add(u); const text = fs.readFileSync(webFile(REPO_ROOT, u), 'utf8'); for (const m of text.matchAll(/(?:^|\n)\s*import\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) { const to = m[1] || m[2]; walk(to.startsWith('/') ? to : path.posix.join(path.posix.dirname(u), to)); } };
  walk('/desktop.js'); for (const u of ['/', '/index.html', '/shared/ui.css', '/auth/roles']) seen.add(u);
  assert.deepEqual([...SIGN_IN_PAGE].sort(), [...seen].sort(), 'change SIGN_IN_PAGE in server/index.mjs when the sign-in page loads something new');
  const { s, browser } = await server();
  try {
    const b = browser();
    for (const u of [...SIGN_IN_PAGE, '/auth/mode', '/fhir/R4/Patient', '/ehr/', '/nothing-here']) { const r = await b('GET', u); assert.equal(r.headers.get('cache-control'), 'private, no-store', u); }
    const locked = browser(); const r = await locked('GET', '/'); assert.equal(r.headers.get('cache-control'), 'private, no-store');
  } finally { await s.close(); }
});
