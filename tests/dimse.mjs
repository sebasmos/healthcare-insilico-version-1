// DICOM network services through the separate gateway (standards/dimse-gateway/gateway.py, docs/STANDARDS.md): C-ECHO,
// C-STORE, C-FIND, C-GET, C-MOVE, modality worklist, MPPS and storage commitment, driven by pynetdicom; and UPS-RS.
// Needs Python with pynetdicom (DIMSE_PYTHON, default python3); the DIMSE test is skipped when it is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer } from './support/helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PY = process.env.DIMSE_PYTHON || 'python3';
const hasPynetdicom = spawnSync(PY, ['-c', 'import pynetdicom']).status === 0;
const R = { 'X-Role': 'researcher', 'X-User-Id': 'res-1' };
const KEY = 'test-gateway-key-0123456789abcdef';

test('DIMSE: echo, store, find, get, move, worklist, MPPS and storage commitment', { skip: !hasPynetdicom && 'pynetdicom is not installed' }, async () => {
  process.env.DIMSE_GATEWAY_KEY = KEY;
  const s = await startTestServer();
  const port = 20000 + Math.floor(Math.random() * 20000); const dest = port + 1;
  const gw = spawn(PY, [path.join(REPO_ROOT, 'standards/dimse-gateway/gateway.py')], { env: { ...process.env, APP_URL: s.base, DIMSE_GATEWAY_KEY: KEY, DIMSE_PORT: String(port), DIMSE_AE_TABLE: `TEST_DEST@127.0.0.1:${dest}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; gw.stdout.on('data', (d) => { log += d; }); gw.stderr.on('data', (d) => { log += d; });
  try {
    for (let i = 0; i < 100 && !log.includes('listening'); i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.ok(log.includes('listening'), log);
    assert.equal((await fetch(`${s.base}/api/dimse/worklist`, { headers: { 'X-Gateway-Key': 'wrong-key-wrong-key-wrong-key-xx' } })).status, 401, 'a wrong gateway key is refused');
    const p = (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', gender: 'female', birthDate: '1970-01-01', identifier: [{ system: 'urn:hospital-desktop:mrn', type: { coding: [{ code: 'MR' }] }, value: 'N330001' }] }, R)).json;
    const sr = await s.call('POST', '/fhir/R4/ServiceRequest', { resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: `Patient/${p.id}` }, code: { coding: [{ system: 'http://loinc.org', code: '24725-4', display: 'CT Head' }] }, occurrenceDateTime: '2026-11-01T09:00:00Z' }, R);
    assert.ok([200, 201].includes(sr.status), sr.text);
    const run = await new Promise((resolve) => { const c = spawn(PY, [path.join(REPO_ROOT, 'tests/support/dimse_scu.py'), String(port), String(dest), 'N330001']); let stdout = ''; let stderr = ''; c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; }); c.on('close', (status) => resolve({ status, stdout, stderr })); });
    assert.equal(run.status, 0, `${run.stderr}\n${log}`);
    const o = JSON.parse(run.stdout.trim().split('\n').pop());
    assert.equal(o.echo, 0); assert.equal(o.store, 0);
    assert.equal(o.find.length, 1, JSON.stringify(o));
    assert.equal(o.get, 0); assert.deepEqual(o.got, [o.image], 'C-GET sends the stored image back');
    assert.equal(o.move, 0); assert.deepEqual(o.moved, [o.image], 'C-MOVE sends it to the named destination');
    assert.equal(o.worklist.length, 1); assert.equal(o.worklist[0].patientId, 'N330001'); assert.equal(o.worklist[0].name, 'MASKED', 'no names on the worklist');
    assert.equal(o.mpps_create, 0); assert.equal(o.mpps_set, 0);
    const proc = (await s.call('GET', `/fhir/R4/Procedure?patient=Patient/${p.id}`, undefined, R)).json.entry.map((e) => e.resource);
    assert.equal(proc[0].status, 'completed'); assert.equal(proc[0].basedOn[0].reference, `ServiceRequest/${sr.json.id}`);
    assert.equal(o.commit_action, 0);
    assert.deepEqual(o.commit_report, [{ type: 2, ok: [o.image], failed: 1 }], 'one stored, one unknown');
  } finally { if (process.env.DIMSE_DEBUG) console.log(log); gw.kill(); await s.close(); delete process.env.DIMSE_GATEWAY_KEY; }
});

test('UPS-RS: create, search, claim, complete; wrong transaction UID and late cancel are refused', async () => {
  const s = await startTestServer();
  try {
    const W = '/dicom-web/workitems'; const uid = '1.2.826.0.1.3680043.10.1.1';
    const call = (m, u, body) => fetch(s.base + u, { method: m, headers: { 'Content-Type': 'application/dicom+json', Accept: 'application/dicom+json', ...R }, body: body ? JSON.stringify(body) : undefined });
    const ds = { '00741204': { vr: 'LO', Value: ['Read CT head'] }, '00100020': { vr: 'LO', Value: ['N330001'] }, '00741200': { vr: 'CS', Value: ['HIGH'] } };
    assert.equal((await call('POST', `${W}?${uid}`, [ds])).status, 201);
    assert.equal((await call('POST', `${W}?${uid}`, [ds])).status, 409);
    const found = await (await call('GET', `${W}?PatientID=N330001`)).json(); assert.equal(found[0]['00741000'].Value[0], 'SCHEDULED');
    const state = (st, txn) => call('PUT', `${W}/${uid}/state`, [{ '00741000': { vr: 'CS', Value: [st] }, '00081195': { vr: 'UI', Value: [txn] } }]);
    assert.equal((await state('IN PROGRESS', '1.2.3.4')).status, 200);
    assert.equal((await state('COMPLETED', '9.9.9')).status, 400, 'only the claimer completes it');
    assert.equal((await call('POST', `${W}/${uid}/cancelrequest`)).status, 409);
    assert.equal((await state('COMPLETED', '1.2.3.4')).status, 200);
    const one = await (await call('GET', `${W}/${uid}`)).json(); assert.equal(one[0]['00741000'].Value[0], 'COMPLETED'); assert.ok(!one[0]['00081195'], 'the transaction UID is never returned');
    const u2 = '1.2.826.0.1.3680043.10.1.2'; await call('POST', `${W}?${u2}`, [ds]); assert.equal((await call('POST', `${W}/${u2}/cancelrequest`)).status, 202);
  } finally { await s.close(); }
});
