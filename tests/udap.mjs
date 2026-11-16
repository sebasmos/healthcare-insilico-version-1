// UDAP (docs/STANDARDS.md): signed metadata, dynamic registration with a software statement and x5c chain,
// certificate trust against a local test CA made here with openssl (never a real CA), the B2B token with hl7-b2b,
// and the refusals: untrusted CA, wrong audience, replayed jti, no hl7-b2b, another certificate. Consent applies.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { X509Certificate, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { startTestServer, tempDir } from './support/helpers.mjs';

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
const D = { 'X-Role': 'physician', 'X-User-Id': 'doc-1' };
const b64u = (v) => Buffer.from(v).toString('base64url');

function makeCa(dir, name) {
  const run = (...a) => execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' });
  run('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${name}-ca.key`);
  run('req', '-x509', '-new', '-key', `${name}-ca.key`, '-subj', `/CN=${name} test CA (not real)`, '-days', '2', '-out', `${name}-ca.pem`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  const leaf = (leafName, san) => {
    run('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${leafName}.key`);
    run('req', '-new', '-key', `${leafName}.key`, '-subj', `/CN=${leafName}`, '-out', `${leafName}.csr`);
    fs.writeFileSync(path.join(dir, `${leafName}.ext`), `subjectAltName=URI:${san}\nkeyUsage=critical,digitalSignature\n`);
    run('x509', '-req', '-in', `${leafName}.csr`, '-CA', `${name}-ca.pem`, '-CAkey', `${name}-ca.key`, '-CAcreateserial', '-days', '1', '-out', `${leafName}.pem`, '-extfile', `${leafName}.ext`);
    return { key: createPrivateKey(fs.readFileSync(path.join(dir, `${leafName}.key`))), chain: [fs.readFileSync(path.join(dir, `${leafName}.pem`), 'utf8'), fs.readFileSync(path.join(dir, `${name}-ca.pem`), 'utf8')].map((p) => new X509Certificate(p).raw.toString('base64')), keyFile: path.join(dir, `${leafName}.key`), certFile: path.join(dir, `${leafName}.pem`) };
  };
  return { pem: path.join(dir, `${name}-ca.pem`), leaf };
}
const jwt = (claims, { key, chain }) => { const h = b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT', x5c: chain })); const p = b64u(JSON.stringify(claims)); return `${h}.${p}.${b64u(sign('SHA256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }))}`; };

test('UDAP: signed metadata, registration, B2B token, refusals and consent', { skip: !hasOpenssl && 'openssl is not installed' }, async () => {
  const dir = tempDir('hd-udap-'); const ca = makeCa(dir, 'trusted'); const rogue = makeCa(dir, 'rogue');
  const server = ca.leaf('server', 'https://hospital.test/fhir'); const app = ca.leaf('client', 'https://partner.test/app'); const other = ca.leaf('client2', 'https://partner.test/app'); const evil = rogue.leaf('evil', 'https://partner.test/app');
  Object.assign(process.env, { UDAP_TRUST_ANCHORS: ca.pem, UDAP_SERVER_CERT: server.certFile, UDAP_SERVER_KEY: server.keyFile });
  const s = await startTestServer();
  try {
    const meta = await (await fetch(`${s.base}/.well-known/udap`)).json();
    assert.deepEqual(meta.udap_authorization_extensions_required, ['hl7-b2b']);
    const [h, p, sig] = meta.signed_metadata.split('.'); const head = JSON.parse(Buffer.from(h, 'base64url'));
    const leaf = new X509Certificate(Buffer.from(head.x5c[0], 'base64')); assert.ok(leaf.verify(new X509Certificate(fs.readFileSync(ca.pem)).publicKey), 'the server certificate chains to the CA');
    assert.ok((await import('node:crypto')).verify('SHA256', Buffer.from(`${h}.${p}`), { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
    assert.equal(JSON.parse(Buffer.from(p, 'base64url')).registration_endpoint, meta.registration_endpoint);
    const now = () => Math.floor(Date.now() / 1000); const reg = `${s.base}/oauth/udap/register`; const tok = `${s.base}/oauth/token`;
    const statement = (who, extra = {}) => jwt({ iss: 'https://partner.test/app', sub: 'https://partner.test/app', aud: reg, iat: now(), exp: now() + 120, jti: randomUUID(), client_name: 'Partner clinic', grant_types: ['client_credentials'], token_endpoint_auth_method: 'private_key_jwt', scope: 'system/Patient.rs system/Observation.rs', ...extra }, who);
    const register = (ss) => fetch(reg, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ software_statement: ss, udap: '1' }) });
    assert.equal((await register(statement(evil))).status, 401, 'a certificate from an untrusted CA is refused');
    assert.equal((await register(statement(app, { aud: 'https://elsewhere.test' }))).status, 401, 'wrong audience');
    assert.equal((await register(statement(app, { iss: 'https://not-in-cert.test', sub: 'https://not-in-cert.test' }))).status, 401, 'iss must be in the certificate');
    const ss = statement(app); const r = await register(ss); assert.equal(r.status, 201); const client = await r.json();
    assert.equal((await register(ss)).status, 401, 'a replayed software statement is refused');
    const assertion = (who, extra = {}, b2b = { version: '1', organization_id: 'https://partner.test', purpose_of_use: ['urn:oid:2.16.840.1.113883.5.8#TREAT'] }) => jwt({ iss: client.client_id, sub: client.client_id, aud: tok, iat: now(), exp: now() + 120, jti: randomUUID(), ...(b2b ? { extensions: { 'hl7-b2b': b2b } } : {}), ...extra }, who);
    const token = (a, scope = 'system/Patient.rs') => fetch(tok, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: a, scope, udap: '1' }) });
    assert.equal((await token(assertion(app, {}, null))).status, 400, 'hl7-b2b is required');
    assert.equal((await token(assertion(other))).status, 401, 'signed with another certificate than the registered one');
    const t = await token(assertion(app)); assert.equal(t.status, 200, await t.clone().text()); const at = (await t.json()).access_token; assert.match(at, /^hd_smart_/);
    const p1 = (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', gender: 'female', birthDate: '1970-01-01' }, D)).json;
    const B = { Authorization: `Bearer ${at}` };
    assert.equal((await fetch(`${s.base}/fhir/R4/Patient/${p1.id}`, { headers: B })).status, 200, 'B2B token reads with its scope');
    assert.equal((await fetch(`${s.base}/fhir/R4/Condition?patient=${p1.id}`, { headers: B })).status, 403, 'outside its scope');
    await s.call('POST', '/fhir/R4/Consent', { resourceType: 'Consent', status: 'active', scope: { coding: [{ code: 'patient-privacy' }] }, category: [{ text: 'privacy' }], patient: { reference: `Patient/${p1.id}` }, provision: { type: 'deny' } }, D);
    assert.equal((await fetch(`${s.base}/fhir/R4/Patient/${p1.id}`, { headers: B })).status, 403, 'another organisation is stopped by a deny consent, even for treatment');
    assert.equal((await s.call('GET', `/fhir/R4/Patient/${p1.id}`, undefined, D)).status, 200, 'the hospital\'s own care is not');
    assert.equal((await (await fetch(`${s.base}/.well-known/smart-configuration`)).json()).token_endpoint, tok, 'SMART Backend Services still works alongside');
    const cancel = await register(statement(app, { grant_types: [] })); assert.equal((await cancel.json()).cancelled, true);
    assert.equal((await token(assertion(app))).status, 401, 'a cancelled client gets no token');
  } finally { await s.close(); for (const k of ['UDAP_TRUST_ANCHORS', 'UDAP_SERVER_CERT', 'UDAP_SERVER_KEY']) delete process.env[k]; }
});
