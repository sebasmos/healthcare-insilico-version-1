// Security rules: a signed-in patient reaches only their own record on every route; in locked mode an agent
// must present its key; sessions are kept in the database as hashes and survive a restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { startTestServer, tempDir } from './support/helpers.mjs';
import { mentions, scopeBody } from '../platform/server/patient-scope.mjs';

const json = { 'Content-Type': 'application/json' };
const raw = async (s, method, url, body, headers = {}) => { const r = await fetch(s.base + url, { method, headers: { ...json, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* */ } return { status: r.status, json: j, text, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }; };
const secret = () => `pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const signUp = async (s, body) => { const made = await raw(s, 'POST', '/agent-ops/people', body); assert.equal(made.status, 201, made.text); const pw = secret(); const acc = await raw(s, 'POST', '/auth/accept', { code: made.json.inviteCode, password: pw }); assert.equal(acc.status, 200, acc.text); return { person: made.json.person, cookie: acc.cookie, pw }; };
const pt = (n) => ({ resourceType: 'Patient', gender: 'female', birthDate: '1970-01-01', identifier: [{ system: 'urn:hospital-desktop:mrn', value: `N70010${n}` }] });
const cond = (pid, text) => ({ resourceType: 'Condition', subject: { reference: `Patient/${pid}` }, code: { text }, clinicalStatus: { coding: [{ code: 'active' }] } });

test('taking other patients out of an answer', () => {
  assert.deepEqual(mentions({ subject: { reference: 'Patient/aaaaaaaa1' } }, 'aaaaaaaa1'), { own: true, other: false });
  assert.deepEqual(mentions({ rows: [{ patient: { id: 'bbbbbbbb2' } }] }, 'aaaaaaaa1'), { own: false, other: true });
  const bundle = { resourceType: 'Bundle', total: 3, entry: [{ resource: { resourceType: 'Condition', id: 'c1', subject: { reference: 'Patient/aaaaaaaa1' } } }, { resource: { resourceType: 'Condition', id: 'c2', subject: { reference: 'Patient/bbbbbbbb2' } } }, { resource: { resourceType: 'Condition', id: 'c3' } }] };
  const out = scopeBody(bundle, 'aaaaaaaa1', { fhir: true }); assert.deepEqual([out.body.total, out.body.entry.map((e) => e.resource.id)], [1, ['c1']], 'a clinical record must positively belong to the patient');
  assert.equal(scopeBody({ resourceType: 'Condition', id: 'c2', subject: { reference: 'Patient/bbbbbbbb2' } }, 'aaaaaaaa1', { fhir: true }).refused, true);
  assert.equal(scopeBody({ resourceType: 'Patient', id: 'bbbbbbbb2' }, 'aaaaaaaa1').refused, true);
  assert.deepEqual(scopeBody({ rows: [{ patient: { id: 'bbbbbbbb2' }, x: 1 }, { patient: { id: 'aaaaaaaa1' }, x: 2 }, { x: 3 }] }, 'aaaaaaaa1').body.rows.map((r) => r.x), [2, 3]);
});

test('a signed-in patient reads and writes only their own record, on every route', async () => {
  const s = await startTestServer({ auth: {} });
  try {
    const a = (await raw(s, 'POST', '/fhir/R4/Patient', pt(1))).json; const b = (await raw(s, 'POST', '/fhir/R4/Patient', pt(2))).json;
    const ca = (await raw(s, 'POST', '/fhir/R4/Condition', cond(a.id, 'Mine'))).json; const cb = (await raw(s, 'POST', '/fhir/R4/Condition', cond(b.id, 'Not mine'))).json;
    const { cookie, person } = await signUp(s, { email: 'pt@example.test', role: 'patient', patientId: a.id });
    const me = (url, method = 'GET', body = undefined, extra = {}) => raw(s, method, url, body, { Cookie: cookie, 'X-Role': 'researcher', 'X-User-Id': 'res-one', ...extra }); // the role a browser claims is not believed
    assert.equal((await me('/auth/me')).json.me.role, 'patient');
    // FHIR
    assert.deepEqual((await me('/fhir/R4/Patient')).json.entry.map((e) => e.resource.id), [a.id]);
    assert.equal((await me(`/fhir/R4/Patient/${a.id}`)).status, 200); assert.equal((await me(`/fhir/R4/Patient/${b.id}`)).status, 403);
    assert.deepEqual((await me('/fhir/R4/Condition')).json.entry.map((e) => e.resource.id), [ca.id], 'a search with no patient named still returns only their own');
    assert.equal((await me(`/fhir/R4/Condition?patient=${a.id}`)).json.entry.length, 1); assert.equal((await me(`/fhir/R4/Condition?patient=${b.id}`)).status, 403); assert.equal((await me(`/fhir/R4/Condition?subject=Patient/${b.id}`)).status, 403);
    assert.equal((await me(`/fhir/R4/Condition/${ca.id}`)).status, 200); assert.equal((await me(`/fhir/R4/Condition/${cb.id}`)).status, 403); assert.ok(!(await me(`/fhir/R4/Condition/${cb.id}/_history`)).text.includes('Not mine'), 'nor its history');
    assert.equal((await me('/fhir/R4/Condition', 'POST', cond(b.id, 'Planted'))).status, 403, 'no writing into another record');
    for (const t of ['AuditEvent', 'TraceStep', 'PersonAccount', 'Session', 'Run']) assert.equal((await me(`/fhir/R4/${t}`)).status, 403, t);
    // Everything else
    for (const url of ['/auth/patients', '/api/pacs/worklist', '/api/beds/board', '/api/pharmacy/queue', '/api/ins/auth', '/agent-ops/studies', '/agent-ops/people', '/agent-ops/search', '/agent-ops/runs', '/agent-ops/library-list', `/api/rpm/patients/${b.id}`, `/api/ages?ids=${b.id}`, `/api/ages?ids=${a.id},${b.id}`, '/env/v1/info', '/connect/v1/fhir/Patient', '/dicom-web/series', '/dicom-web/studies/1.2.3.4']) assert.equal((await me(url)).status, 403, url);
    assert.equal((await me(`/api/ages?ids=${a.id}`)).status, 200); assert.equal((await me('/agent-ops/my-work')).status, 200); assert.deepEqual((await me('/dicom-web/studies')).json, []);
    // The same person outside a session (this server is open, so that is the Researcher) is not held to it.
    assert.equal((await raw(s, 'GET', `/fhir/R4/Patient/${b.id}`)).status, 200);
    // WebSocket: a patient's session cannot open one.
    const port = Number(new URL(s.base).port);
    const answer = await new Promise((resolve) => { const sock = net.connect(port, '127.0.0.1', () => sock.write(`GET /env/v1/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nCookie: ${cookie}\r\n\r\n`)); let got = ''; sock.on('data', (d) => { got += d; }); sock.on('close', () => resolve(got)); sock.on('error', () => resolve(got)); setTimeout(() => { sock.destroy(); resolve(`${got}<still open>`); }, 1500); });
    assert.ok(!answer.includes('101') && !answer.includes('<still open>'), `the socket was closed: ${JSON.stringify(answer.slice(0, 80))}`);
    void person;
  } finally { await s.close(); }
});

test('locked: an agent id alone is refused; the agent\'s own key is needed; the server\'s own agents still work', async () => {
  const admin = secret(); const s = await startTestServer({ auth: { adminPassword: admin } });
  try {
    const op = (await raw(s, 'POST', '/auth/login', { password: admin })).cookie; const asOp = { Cookie: op };
    const p = (await raw(s, 'POST', '/fhir/R4/Patient', pt(3), asOp)).json;
    const run = (await raw(s, 'POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'workup-planner', subject: `Patient/${p.id}` }, asOp)).json; assert.ok(run.id, JSON.stringify(run));
    const agent = { 'X-Agent-Id': 'workup-planner', 'X-Run-Id': run.id };
    const bare = await raw(s, 'GET', `/fhir/R4/Patient/${p.id}`, undefined, agent); assert.equal(bare.status, 401, bare.text); assert.match(bare.text, /key/);
    const token = `hd_agent_${'ab'.repeat(24)}`; const other = `hd_agent_${'cd'.repeat(24)}`;
    await s.store.transaction(async (tx) => { for (const [t, id] of [[token, 'workup-planner'], [other, 'chart-summariser']]) await tx.save('ConnectorKey', { resourceType: 'ConnectorKey', id: randomUUID(), agentId: id, hash: createHash('sha256').update(t).digest('hex'), prefix: t.slice(0, 14), createdAt: tx.now() }, { updatedBy: 'test' }); });
    assert.equal((await raw(s, 'GET', `/fhir/R4/Patient/${p.id}`, undefined, { ...agent, Authorization: `Bearer ${other}` })).status, 401, 'another agent\'s key does not do');
    assert.equal((await raw(s, 'GET', `/fhir/R4/Patient/${p.id}`, undefined, { ...agent, Authorization: 'Bearer hd_agent_00' })).status, 401);
    assert.equal((await raw(s, 'GET', `/fhir/R4/Patient/${p.id}`, undefined, { ...agent, 'X-Internal-Agent': 'guess' })).status, 401);
    assert.equal((await raw(s, 'GET', `/fhir/R4/Patient/${p.id}`, undefined, { ...agent, Authorization: `Bearer ${token}` })).status, 200, 'its own key lets it through to the usual checks');
    // The server's own agents (a study's agent attempts) run without a key leaving the process.
    const { res, makeTasks } = await import('./support/study-fixtures.mjs'); void res;
    const call = s.call; s.call = (m, u, b, h = {}) => call(m, u, b, { ...h, ...asOp });
    const { set } = await makeTasks(s, 1);
    const study = (await raw(s, 'POST', '/agent-ops/studies', { title: 'Locked run', taskSet: set.id, participants: [{ kind: 'agent', id: 'workup-planner' }], conditions: ['autonomous'] }, asOp)).json;
    await raw(s, 'POST', `/agent-ops/studies/${study.id}/start`, {}, asOp); await s.studies.idle(study.id);
    const [a] = await s.studies.attemptsOf(study.id); assert.equal(a.state, 'closed', a.error); assert.ok(a.scores.steps >= 1, 'the agent did act');
  } finally { await s.close(); }
});

test('sessions are kept in the database as hashes and survive a restart', async () => {
  const file = path.join(tempDir('hd-sess-'), 'app.sqlite'); const admin = secret();
  let s = await startTestServer({ file, auth: { adminPassword: admin } });
  let cookie; let token;
  try {
    const login = await raw(s, 'POST', '/auth/login', { password: admin }); cookie = login.cookie; token = cookie.split('=')[1];
    const rows = await s.store.query('Session'); assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows).includes(token), 'the token itself is not stored'); assert.match(rows[0].id, /^[0-9a-f]{64}$/); assert.equal(rows[0].endedAt, null);
  } finally { await s.close(); }
  s = await startTestServer({ file, auth: { adminPassword: admin } });
  try {
    assert.equal((await raw(s, 'GET', '/auth/me', undefined, { Cookie: cookie })).json.signedIn, true, 'still signed in after the restart');
    assert.equal((await raw(s, 'GET', '/agent-ops/people', undefined, { Cookie: cookie })).status, 200);
    await raw(s, 'POST', '/auth/logout', {}, { Cookie: cookie });
    assert.equal((await raw(s, 'GET', '/agent-ops/people', undefined, { Cookie: cookie })).status, 401);
    assert.ok((await s.store.query('Session'))[0].endedAt);
  } finally { await s.close(); }
  s = await startTestServer({ file, auth: { adminPassword: admin } });
  try { assert.equal((await raw(s, 'GET', '/auth/me', undefined, { Cookie: cookie })).json.signedIn, false, 'a signed-out session stays signed out'); } finally { await s.close(); }
});
