// Interoperability, FHIR side: SMART App Launch (EHR launch with PKCE, backend services), terminology operations,
// Bulk Data, Subscriptions (R4 backport), the R5 face with an R4 -> R5 -> R4 round trip, IPS, PIXm and PDQm, AI
// transparency labels and BALP audit events. Fixtures are built here, without names.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { startTestServer, tempDir } from './support/helpers.mjs';
import { toR5, toR4 } from '../standards/server/r5.mjs';

process.env.PAYER_REFERENCE_FILE = path.join(tempDir('hd-term-'), 'ref.sqlite');
const ref = await import('../insurance-and-billing/server/reference.mjs');
{ const db = ref.openReference(); const rel = (k) => Number(db.prepare('INSERT INTO releases (kind, release, source, file, checksum, rows, imported_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run(k, '2026', 'fixture made in the test', `${k}.txt`, k, '2026-01-01T00:00:00Z').lastInsertRowid);
  const icd = rel('icd10cm'); db.prepare('INSERT INTO codes (system, code, release, short, long, billable) VALUES (?, ?, ?, ?, ?, ?)').run('ICD-10-CM', 'E119', icd, 'Type 2 diabetes w/o complications', 'Type 2 diabetes mellitus without complications', 1);
  db.prepare('INSERT INTO hcc_map (model, icd, hcc, release) VALUES (?, ?, ?, ?)').run('V28', 'E119', '38', rel('hcc-map')); }

const R = { 'X-Role': 'researcher', 'X-User-Id': 'researcher' };
const b64u = (b) => Buffer.from(b).toString('base64url');
const MRN = (v) => ({ system: 'urn:hospital-desktop:mrn', type: { coding: [{ code: 'MR' }] }, value: v });
async function server() { const s = await startTestServer({ auth: {} }); const p1 = (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', gender: 'female', birthDate: '1960-03-04', identifier: [MRN('N300001'), { system: 'http://mimic.mit.edu/fhir/mimic/identifier/patient', value: '10000001' }] }, R)).json; const p2 = (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', gender: 'male', birthDate: '1970-05-06', identifier: [MRN('N300002')] }, R)).json; return { s, p1, p2 }; }
const form = (o) => new URLSearchParams(o).toString();
const raw = async (s, method, url, { body, headers = {} } = {}) => { const r = await fetch(s.base + url, { method, redirect: 'manual', headers, body }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } return { status: r.status, json, text, headers: r.headers }; };

test('SMART App Launch: discovery, EHR launch with PKCE and a patient-scoped token, backend services with a signed assertion', async () => {
  const { s, p1, p2 } = await server();
  try {
    const conf = (await raw(s, 'GET', '/.well-known/smart-configuration')).json; assert.ok(conf.capabilities.includes('launch-ehr') && conf.code_challenge_methods_supported.includes('S256'));
    assert.equal((await raw(s, 'GET', '/fhir/R4/metadata')).json.rest[0].security.service[0].coding[0].code, 'SMART-on-FHIR');
    // EHR launch: the app is registered, the EHR makes a launch for a patient, the signed-in person authorises it.
    const app = (await s.call('POST', '/oauth/register', { client_name: 'Test viewer', redirect_uris: ['http://localhost:9999/cb'], scope: 'launch openid fhirUser patient/*.rs' }, R)).json; assert.match(app.client_id, /^app-/);
    const launch = (await s.call('POST', '/oauth/launch', { patient: p1.id }, R)).json.launch; const verifier = randomBytes(32).toString('base64url'); const challenge = b64u(createHash('sha256').update(verifier).digest());
    const q = new URLSearchParams({ response_type: 'code', client_id: app.client_id, redirect_uri: 'http://localhost:9999/cb', scope: 'launch openid fhirUser patient/Observation.rs patient/Patient.rs', state: 'xyz', aud: `${s.base}/fhir/R4`, launch, code_challenge: challenge, code_challenge_method: 'S256' });
    const auth = await raw(s, 'GET', `/oauth/authorize?${q}`, { headers: R }); assert.equal(auth.status, 302, auth.text); const back = new URL(auth.headers.get('location')); assert.equal(back.searchParams.get('state'), 'xyz'); const code = back.searchParams.get('code'); assert.ok(code);
    assert.equal((await raw(s, 'POST', '/oauth/token', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:9999/cb', client_id: app.client_id, code_verifier: 'wrong' }) })).status, 400, 'PKCE is checked (and a code is used once)');
    const auth2 = new URL((await raw(s, 'GET', `/oauth/authorize?${q.toString().replace(/launch=[^&]+/, `launch=${(await s.call('POST', '/oauth/launch', { patient: p1.id }, R)).json.launch}`)}`, { headers: R })).headers.get('location'));
    const tok = await raw(s, 'POST', '/oauth/token', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'authorization_code', code: auth2.searchParams.get('code'), redirect_uri: 'http://localhost:9999/cb', client_id: app.client_id, code_verifier: verifier }) });
    assert.equal(tok.status, 200, tok.text); assert.equal(tok.json.patient, p1.id); assert.match(tok.json.id_token, /^[^.]+\.[^.]+\.[^.]+$/);
    const B = { Authorization: `Bearer ${tok.json.access_token}` };
    assert.equal((await raw(s, 'GET', `/fhir/R4/Patient/${p1.id}`, { headers: B })).status, 200);
    assert.equal((await raw(s, 'GET', `/fhir/R4/Patient/${p2.id}`, { headers: B })).status, 403, 'only the launch patient');
    assert.equal((await raw(s, 'GET', `/fhir/R4/Condition?patient=${p1.id}`, { headers: B })).status, 403, 'not in the scopes');
    assert.equal((await raw(s, 'POST', '/fhir/R4/Observation', { headers: { ...B, 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'read only');
    assert.equal((await raw(s, 'GET', '/api/pacs/worklist', { headers: B })).status, 403, 'an app token reaches FHIR only');
    assert.equal((await raw(s, 'POST', '/oauth/introspect', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ token: tok.json.access_token }) })).json.active, true);
    // Backend services: an ES384 key pair, a signed assertion, a system token.
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-384' }); const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES384' };
    const be = (await s.call('POST', '/oauth/register', { client_name: 'Nightly extract', grant_types: ['client_credentials'], jwks: { keys: [jwk] }, scope: 'system/*.rs' }, R)).json;
    const assertion = (jti) => { const h = b64u(JSON.stringify({ alg: 'ES384', kid: 'k1', typ: 'JWT' })); const p = b64u(JSON.stringify({ iss: be.client_id, sub: be.client_id, aud: `${s.base}/oauth/token`, exp: Math.floor(Date.now() / 1000) + 240, jti })); return `${h}.${p}.${b64u(sign('SHA384', Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }))}`; };
    const cc = (jti, scope = 'system/Patient.rs') => raw(s, 'POST', '/oauth/token', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'client_credentials', scope, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion(jti) }) });
    const st = await cc('one'); assert.equal(st.status, 200, st.text); assert.equal((await cc('one')).status, 401, 'a jti is used once');
    assert.equal((await raw(s, 'GET', '/fhir/R4/Patient', { headers: { Authorization: `Bearer ${st.json.access_token}` } })).status, 200);
    const steps = await s.store.query('TraceStep', { where: (x) => String(x.did?.type).startsWith('smart.') }); for (const a of ['smart.register', 'smart.authorize', 'smart.token', 'smart.request']) assert.ok(steps.some((x) => x.did.type === a), a);
  } finally { await s.close(); }
});

test('terminology, IPS, PIXm and PDQm, AI transparency and BALP', async () => {
  const { s, p1 } = await server();
  try {
    const look = (await s.call('GET', '/fhir/R4/CodeSystem/$lookup?system=http://loinc.org&code=2345-7', undefined, R)).json; assert.equal(look.parameter.find((x) => x.name === 'display').valueString, 'Glucose');
    assert.equal((await s.call('GET', '/fhir/R4/CodeSystem/$lookup?system=http://hl7.org/fhir/sid/icd-10-cm&code=E11.9', undefined, R)).json.parameter.find((x) => x.name === 'display').valueString, 'Type 2 diabetes mellitus without complications');
    const ok = (sys, code) => s.call('GET', `/fhir/R4/CodeSystem/$validate-code?system=${encodeURIComponent(sys)}&code=${encodeURIComponent(code)}`, undefined, R).then((r) => r.json.parameter[0].valueBoolean);
    assert.equal(await ok('http://unitsofmeasure.org', 'mg/dL'), true); assert.equal(await ok('http://unitsofmeasure.org', 'mg/dLx'), false); assert.equal(await ok('http://hl7.org/fhir/sid/icd-10-cm', 'Z99.999'), false);
    const exp = (await s.call('GET', '/fhir/R4/ValueSet/$expand?url=http://loinc.org?fhir_vs&filter=glucose', undefined, R)).json; assert.ok(exp.expansion.contains.some((c) => c.code === '2345-7'));
    const tr = (await s.call('GET', '/fhir/R4/ConceptMap/$translate?system=http://hl7.org/fhir/sid/icd-10-cm&code=E119&targetsystem=hcc', undefined, R)).json; assert.equal(tr.parameter[0].valueBoolean, true); assert.equal(tr.parameter.find((x) => x.name === 'match').part[1].valueCoding.code, '38');
    // IPS
    await s.call('POST', '/fhir/R4/Condition', { resourceType: 'Condition', subject: { reference: `Patient/${p1.id}` }, clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] }, code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'E11.9' }] } }, R);
    const ips = (await s.call('GET', `/fhir/R4/Patient/${p1.id}/$summary`, undefined, R)).json; assert.equal(ips.type, 'document'); const comp = ips.entry[0].resource; assert.equal(comp.type.coding[0].code, '60591-5');
    assert.deepEqual(comp.section.slice(0, 3).map((x) => x.code.coding[0].code), ['48765-2', '10160-0', '11450-4']); assert.equal(comp.section[2].entry.length, 1); assert.equal(ips.entry.find((e) => e.resource.resourceType === 'Patient').resource.name[0].text, 'Patient N300001', 'the patient by number only');
    // PIXm and PDQm
    const pix = (await s.call('GET', '/fhir/R4/Patient/$ihe-pix?sourceIdentifier=urn:hospital-desktop:mrn|N300001', undefined, R)).json; assert.ok(pix.parameter.some((x) => x.valueIdentifier?.value === '10000001')); assert.equal(pix.parameter.find((x) => x.name === 'targetId').valueReference.reference, `Patient/${p1.id}`);
    const pdq = (await s.call('GET', '/fhir/R4/Patient?birthdate=1960-03-04&gender=female', undefined, R)).json; assert.deepEqual(pdq.entry.map((e) => e.resource.id), [p1.id]);
    // AI transparency: an agent's write is labelled and has an AI Provenance. BALP on the audit event.
    const run = (await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'report-drafter' }, R)).json;
    const made = await s.call('POST', `/fhir/R4/DiagnosticReport?_branch=${run.branch}`, { resourceType: 'DiagnosticReport', status: 'preliminary', code: { coding: [{ system: 'http://loinc.org', code: '36643-5' }] }, subject: { reference: `Patient/${p1.id}` } }, { 'X-Agent-Id': 'report-drafter', 'X-Run-Id': run.id, 'Idempotency-Key': 'k1' });
    assert.equal(made.status, 201, made.text); assert.ok(made.json.meta.security.some((x) => x.code === 'AIAST'));
    const prov = (await s.store.query('Provenance', {}, { branch: run.branch })).find((x) => x.target[0].reference.startsWith(`DiagnosticReport/${made.json.id}`)); assert.equal(prov.agent[0].who.type, 'Device'); assert.ok(prov.meta.security.some((x) => x.code === 'AIAST'));
    const audit = (await s.store.query('AuditEvent', {}, { branch: run.branch }))[0]; assert.match(audit.meta.profile[0], /IHE\.BasicAudit\./); assert.equal(audit.source.type[0].code, '4');
  } finally { await s.close(); }
});

test('Bulk Data export, Subscriptions with a notification, and the R5 face', async () => {
  const { s, p1, p2 } = await server();
  const got = []; const hook = http.createServer((q, r) => { let b = ''; q.on('data', (x) => { b += x; }); q.on('end', () => { got.push(JSON.parse(b)); r.end(); }); }); await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  try {
    // Bulk: a patient whose Consent denies sharing is left out.
    await s.call('POST', '/fhir/R4/Consent', { resourceType: 'Consent', status: 'active', scope: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: 'patient-privacy' }] }, category: [{ coding: [{ system: 'http://loinc.org', code: '59284-0' }] }], patient: { reference: `Patient/${p2.id}` }, provision: { type: 'deny' } }, R);
    assert.equal((await s.call('GET', '/fhir/R4/$export', undefined, R)).status, 400, 'respond-async is required');
    const k = await raw(s, 'GET', '/fhir/R4/$export?_type=Patient,Consent', { headers: { ...R, Prefer: 'respond-async' } }); assert.equal(k.status, 202); const where = new URL(k.headers.get('content-location')).pathname;
    let man = null; for (let i = 0; i < 50 && !man; i += 1) { const st = await raw(s, 'GET', where, { headers: R }); if (st.status === 200) man = st.json; else await new Promise((r) => setTimeout(r, 100)); }
    assert.ok(man && man.requiresAccessToken); const pt = man.output.find((o) => o.type === 'Patient'); const lines = (await raw(s, 'GET', new URL(pt.url).pathname, { headers: R })).text.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((x) => x.id), [p1.id]); assert.ok(lines.every((x) => !Object.keys(x).some((key) => key.startsWith('_'))));
    // Subscriptions: backport Subscription, handshake, a notification when a lab result is final, $events, and the TraceStep.
    const topic = `${s.base}/fhir/SubscriptionTopic/lab-result-final`; assert.ok((await raw(s, 'GET', '/fhir/R5/SubscriptionTopic')).json.entry.some((e) => e.resource.url === topic));
    const sub = await s.call('POST', '/fhir/R4/Subscription', { resourceType: 'Subscription', status: 'requested', reason: 'Results feed', criteria: topic, channel: { type: 'rest-hook', endpoint: `http://127.0.0.1:${hook.address().port}/n`, payload: 'application/fhir+json', _payload: { extension: [{ url: 'http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-payload-content', valueCode: 'id-only' }] } } }, R);
    assert.equal(sub.status, 201, sub.text); await new Promise((r) => setTimeout(r, 200)); assert.equal(got[0].entry[0].resource.parameter.find((x) => x.name === 'type').valueCode, 'handshake');
    const prelim = (await s.call('POST', '/fhir/R4/Observation', { resourceType: 'Observation', status: 'preliminary', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }], code: { coding: [{ system: 'http://loinc.org', code: '2345-7' }] }, subject: { reference: `Patient/${p1.id}` }, valueQuantity: { value: 99, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' } }, R)).json;
    const obs = (await s.call('PUT', `/fhir/R4/Observation/${prelim.id}`, { ...prelim, status: 'final' }, R)).json; assert.equal(obs.status, 'final');
    await new Promise((r) => setTimeout(r, 300)); const note = got.find((g) => g.entry[0].resource.parameter.find((x) => x.name === 'type').valueCode === 'event-notification'); assert.ok(note, 'notified');
    assert.equal(note.entry[0].resource.parameter.find((x) => x.name === 'notification-event').part.find((x) => x.name === 'focus').valueReference.reference, `Observation/${obs.id}`);
    const ev = (await s.call('GET', `/fhir/R4/Subscription/${sub.json.id}/$events`, undefined, R)).json; assert.equal(ev.entry[0].resource.parameter.find((x) => x.name === 'events-since-subscription-start').valueString, '1');
    assert.ok((await s.store.query('TraceStep', { where: (x) => x.did?.type === 'subscription.notify' })).length === 1);
    // R5 face: R4 kept, R5 shown; an R5 write is stored as R4.
    const enc = (await s.call('POST', '/fhir/R4/Encounter', { resourceType: 'Encounter', status: 'in-progress', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' }, subject: { reference: `Patient/${p1.id}` }, period: { start: '2026-01-01T09:00:00Z' } }, R)).json;
    const r5 = await raw(s, 'GET', `/fhir/R5/Encounter/${enc.id}`, { headers: R }); assert.match(r5.headers.get('content-type'), /fhirVersion=5\.0/); assert.equal(r5.json.class[0].coding[0].code, 'AMB'); assert.equal(r5.json.actualPeriod.start, '2026-01-01T09:00:00Z');
    assert.equal((await raw(s, 'GET', '/fhir/R5/metadata', { headers: R })).json.fhirVersion, '5.0.0');
    const mr5 = { resourceType: 'MedicationRequest', status: 'draft', intent: 'order', subject: { reference: `Patient/${p1.id}` }, medication: { concept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '197361' }] } }, authoredOn: '2026-01-01' };
    const w = await raw(s, 'POST', '/fhir/R5/MedicationRequest', { headers: { ...R, 'Content-Type': 'application/json' }, body: JSON.stringify(mr5) }); assert.equal(w.status, 201, w.text); assert.equal(w.json.medication.concept.coding[0].code, '197361');
    assert.equal((await s.store.get('MedicationRequest', w.json.id)).medicationCodeableConcept.coding[0].code, '197361', 'kept as R4');
  } finally { hook.close(); await s.close(); }
});

test('R4 -> R5 -> R4 gives back the same resource', () => {
  const samples = [
    { resourceType: 'Encounter', id: 'e', status: 'arrived', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'EMER' }, subject: { reference: 'Patient/p' }, period: { start: '2026-01-01' }, reasonCode: [{ text: 'Chest pain' }], participant: [{ individual: { reference: 'Practitioner/x' } }], diagnosis: [{ condition: { reference: 'Condition/c' }, rank: 1 }], hospitalization: { dischargeDisposition: { text: 'Home' } } },
    { resourceType: 'MedicationAdministration', id: 'm', status: 'completed', medicationCodeableConcept: { text: 'Drug' }, subject: { reference: 'Patient/p' }, context: { reference: 'Encounter/e' }, effectiveDateTime: '2026-01-01T10:00:00Z', performer: [{ actor: { reference: 'Practitioner/x' } }] },
    { resourceType: 'MedicationStatement', id: 's', status: 'active', medicationReference: { reference: 'Medication/1' }, subject: { reference: 'Patient/p' } },
    { resourceType: 'ServiceRequest', id: 'r', status: 'active', intent: 'order', code: { text: 'CT head' }, subject: { reference: 'Patient/p' }, reasonCode: [{ text: 'Headache' }] },
    { resourceType: 'AllergyIntolerance', id: 'a', patient: { reference: 'Patient/p' }, type: 'allergy', recorder: { reference: 'Practitioner/x' }, asserter: { reference: 'Patient/p' } },
    { resourceType: 'Procedure', id: 'pr', status: 'completed', subject: { reference: 'Patient/p' }, performedDateTime: '2026-01-01', asserter: { reference: 'Practitioner/x' } },
    { resourceType: 'DocumentReference', id: 'd', status: 'current', subject: { reference: 'Patient/p' }, content: [{ attachment: { contentType: 'text/plain' }, format: { code: 'urn:x' } }], context: { encounter: [{ reference: 'Encounter/e' }], period: { start: '2026-01-01' }, facilityType: { text: 'Clinic' } } },
    { resourceType: 'Observation', id: 'o', status: 'final', code: { text: 'x' }, valueQuantity: { value: 1 } },
  ];
  for (const x of samples) assert.deepEqual(toR4(toR5(x)), x, x.resourceType);
  assert.equal(toR5(samples[0]).status, 'in-progress'); assert.equal(toR5(samples[1]).medication.concept.text, 'Drug'); assert.equal(toR5(samples[1]).occurenceDateTime, '2026-01-01T10:00:00Z');
});
