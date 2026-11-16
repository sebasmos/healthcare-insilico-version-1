// CDS Hooks: discovery shape, each hook's context and prefetch,
// card data, feedback, friction, a timing-out service that never blocks,
// external services off by default and synthetic-only, a model-backed agent
// as a service, and the report.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, testClock, patient, BACKEND } from './support/helpers.mjs';

const doc = { 'X-Role': 'physician', 'X-User-Id': 'dr-one' };
const nurse = { 'X-Role': 'nurse', 'X-User-Id': 'rn-one' };
const admin = { 'X-Role': 'physician', 'X-User-Id': 'admin' };
const RX = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const LOINC = 'http://loinc.org';
const HTEST = { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST', display: 'test health data' };
const med = (pid, code, display, dose = 500, unit = 'mg', frequency = 'TID') => ({ resourceType: 'MedicationRequest', status: 'draft', intent: 'order', subject: { reference: `Patient/${pid}` }, medicationCodeableConcept: { coding: [{ system: RX, code, display }], text: display }, dosageInstruction: [{ text: `${dose} ${unit} oral ${frequency}`, timing: { code: { text: frequency } }, route: { text: 'oral' }, doseAndRate: [{ doseQuantity: { value: dose, unit } }] }] });

test(`[${BACKEND}] discovery, patient-view with a NEWS2 card, order-select interaction and imaging cards, order-sign renal card with a suggestion, feedback, friction`, async () => {
  const clock = testClock('2026-05-01T09:00:00.000Z');
  const s = await startTestServer({ clock });
  try {
    const disc = await s.call('GET', '/cds-services');
    assert.equal(disc.status, 200);
    const ids = disc.json.services.map((x) => x.id);
    for (const id of ['news2-card', 'renal-dose', 'interaction-check', 'imaging-appropriateness']) assert.ok(ids.includes(id), id);
    assert.ok(disc.json.services.every((x) => x.hook && x.title && x.description));
    assert.equal((await s.call('GET', '/api/friction')).json.friction, 'low', 'outside a session friction is low');
    await s.call('PUT', '/api/friction', { level: 'realistic' });
    const p = (await s.call('POST', '/fhir/R4/Patient', patient('Cdscase', { gender: 'female', birthDate: '1950-05-01' }))).json;
    // patient-view: no score yet, no cards; after a high vitals set, a critical card
    let r = await s.call('POST', '/api/cds/invoke', { hook: 'patient-view', context: { patientId: p.id } }, doc);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.cards.length, 0);
    assert.ok(r.json.calls.some((c) => c.service === 'news2-card' && c.status === 'ok'));
    await s.call('POST', '/api/nursing/flowsheet', { patient: p.id, at: clock.now(), vitals: { rr: 26, spo2: 90, sbp: 95, hr: 120, temp: 38.5 }, assessments: { consciousness: 'A', o2device: 'Nasal cannula' } }, nurse);
    r = await s.call('POST', '/api/cds/invoke', { hook: 'patient-view', context: { patientId: p.id } }, doc);
    assert.equal(r.json.cards.length, 1);
    assert.deepEqual([r.json.cards[0].indicator, r.json.cards[0].serviceId], ['critical', 'news2-card']);
    assert.match(r.json.cards[0].summary, /NEWS2 \d+/);
    // direct service call, CDS Hooks request shape with prefetch
    const direct = await s.call('POST', '/cds-services/news2-card', { hookInstance: 'abc', hook: 'patient-view', context: { userId: 'Practitioner/x', patientId: p.id }, prefetch: {} }, doc);
    assert.equal(direct.status, 200, direct.text);
    assert.equal(direct.json.cards.length, 1);
    assert.equal((await s.call('POST', '/cds-services/news2-card', { hook: 'order-sign', context: { patientId: p.id } }, doc)).status, 422, 'wrong hook');
    // order-select: warfarin while on aspirin (interaction) and a CT without an indication
    const aspirin = await s.call('POST', '/fhir/R4/MedicationRequest', { ...med(p.id, '1191', 'Aspirin', 81, 'mg', 'daily'), extension: [{ url: 'urn:hospital-desktop:lifecycle', valueCode: 'pending-verification' }] }, doc);
    assert.equal(aspirin.status, 201, aspirin.text);
    r = await s.call('POST', '/api/cds/invoke', { hook: 'order-select', context: { patientId: p.id, selections: [{ resource: med(p.id, '11289', 'Warfarin', 5, 'mg', 'daily') }, { resource: { resourceType: 'ServiceRequest', status: 'draft', intent: 'order', subject: { reference: `Patient/${p.id}` }, category: [{ coding: [{ system: 'urn:hospital-desktop:order-category', code: 'imaging' }] }], code: { coding: [{ system: LOINC, code: '24725-4', display: 'CT Head' }] } } }] } }, doc);
    assert.equal(r.status, 200, r.text);
    const services = r.json.cards.map((c) => c.serviceId);
    assert.ok(services.includes('interaction-check'), `interaction card: ${services.join(',')}`);
    assert.ok(r.json.cards.some((c) => c.serviceId === 'interaction-check' && /Aspirin|aspirin/.test(c.detail)));
    assert.ok(services.includes('imaging-appropriateness'));
    assert.equal(r.json.friction, 'realistic');
    // order-sign: a renal-limited drug with no creatinine gives a suggestion to order one
    r = await s.call('POST', '/api/cds/invoke', { hook: 'order-sign', context: { patientId: p.id, draftOrders: { resourceType: 'Bundle', entry: [{ resource: med(p.id, '8591', 'Potassium chloride', 20, 'mEq', 'daily') }] } } }, doc);
    assert.equal(r.status, 200, r.text);
    const renal = r.json.cards.find((c) => c.serviceId === 'renal-dose');
    assert.ok(renal, 'renal card');
    assert.equal(renal.suggestions[0].actions[0].resource.resourceType, 'ServiceRequest');
    // feedback: accepted and overridden, logged
    let f = await s.call('POST', '/api/cds/feedback', { serviceId: 'renal-dose', card: renal.uuid, outcome: 'accepted', acceptedSuggestions: [{ id: renal.suggestions[0].uuid }] }, doc);
    assert.equal(f.status, 200, f.text);
    f = await s.call('POST', `/cds-services/interaction-check/feedback`, { feedback: [{ card: 'x', outcome: 'overridden', overrideReason: { reason: { code: 'benefit' }, userComment: 'Cardiology advised' } }] }, doc);
    assert.equal(f.status, 200, f.text);
    const types = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.map((t) => t.did.type);
    for (const t of ['cds.call', 'cds.card', 'cds.accept', 'cds.dismiss']) assert.ok(types.includes(t), t);
    // friction: low hides information cards; critical ones (and warnings) always show
    await s.call('PUT', '/api/friction', { level: 'low' });
    r = await s.call('POST', '/api/cds/invoke', { hook: 'order-select', context: { patientId: p.id, selections: [{ resource: { resourceType: 'ServiceRequest', status: 'draft', intent: 'order', subject: { reference: `Patient/${p.id}` }, category: [{ coding: [{ code: 'imaging' }] }], code: { coding: [{ system: LOINC, code: '24725-4' }] } } }] } }, doc);
    assert.equal(r.json.cards.length, 0);
    assert.ok(r.json.suppressed >= 1);
    r = await s.call('POST', '/api/cds/invoke', { hook: 'patient-view', context: { patientId: p.id } }, doc);
    assert.equal(r.json.cards.length, 1, 'the critical NEWS2 card still shows at low friction');
    await s.call('PUT', '/api/friction', { level: 'high' });
    // agents never call the client route
    assert.equal((await s.call('POST', '/api/cds/invoke', { hook: 'patient-view', context: { patientId: p.id } }, { 'X-Agent-Id': 'report-drafter', 'X-Run-Id': 'live' })).status, 403);
    // report
    const rep = (await s.call('GET', '/api/cds/report', undefined, admin)).json;
    assert.ok(rep.rows.find((x) => x.service === 'renal-dose').accepted >= 1);
    assert.ok(rep.rows.find((x) => x.service === 'interaction-check').dismissed >= 1);
    assert.ok(rep.charts >= 2);
  } finally { await s.close(); }
});

test(`[${BACKEND}] external services: off by default, registered by URL, called only for synthetic patients, a slow service times out quietly; a model-backed agent can be exposed as a service`, async () => {
  const hits = [];
  const ext = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/cds-services') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ services: [{ id: 'slow', hook: 'patient-view', title: 'Slow service', description: 'Takes too long' }, { id: 'fast', hook: 'patient-view', title: 'Fast service', description: 'Answers' }] })); }
    if (req.url.endsWith('/slow')) { setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"cards":[]}'); }, 3500); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ cards: [{ summary: 'External says hello', indicator: 'info', detail: 'from outside', source: { label: 'Ext' } }] }));
  });
  await new Promise((r) => ext.listen(0, '127.0.0.1', r));
  const prev = process.env.ALLOW_EXTERNAL_CDS;
  const s = await startTestServer({ clock: testClock('2026-05-01T09:00:00.000Z') });
  try {
    const url = `http://127.0.0.1:${ext.address().port}`;
    delete process.env.ALLOW_EXTERNAL_CDS;
    let reg = await s.call('POST', '/api/cds/services', { url }, admin);
    assert.equal(reg.status, 201, reg.text);
    assert.match(reg.json.note, /ALLOW_EXTERNAL_CDS/);
    assert.equal(hits.length, 0, 'nothing fetched while external CDS is off');
    process.env.ALLOW_EXTERNAL_CDS = 'true';
    reg = await s.call('POST', '/api/cds/services', { url }, admin);
    assert.equal(reg.json.services.length, 2);
    const synthetic = (await s.call('POST', '/fhir/R4/Patient', patient('Synth', { meta: { security: [HTEST] } }))).json;
    const plain = (await s.call('POST', '/fhir/R4/Patient', patient('Plain'))).json;
    let r = await s.call('POST', '/api/cds/invoke', { hook: 'patient-view', context: { patientId: plain.id } }, doc);
    assert.ok(r.json.calls.filter((c) => c.service.startsWith('ext-')).every((c) => c.status === 'not-synthetic'));
    const started = Date.now();
    await s.call('PUT', '/api/friction', { level: 'realistic' });
    r = await s.call('POST', '/api/cds/invoke', { hook: 'patient-view', context: { patientId: synthetic.id } }, doc);
    assert.equal(r.status, 200, r.text);
    assert.ok(Date.now() - started < 3400, 'the slow service did not block beyond its timeout');
    const slow = r.json.calls.find((c) => c.service.endsWith('-slow')); const fast = r.json.calls.find((c) => c.service.endsWith('-fast'));
    assert.equal(slow.status, 'timeout');
    assert.equal(fast.status, 'ok');
    assert.ok(r.json.cards.some((c) => c.summary === 'External says hello'));
    delete process.env.ALLOW_EXTERNAL_CDS;
    r = await s.call('POST', '/api/cds/invoke', { hook: 'patient-view', context: { patientId: synthetic.id } }, doc);
    assert.ok(r.json.calls.filter((c) => c.service.startsWith('ext-')).every((c) => c.status === 'external-off'));
    // a model-backed agent exposed as a service
    const agent = await s.call('POST', '/agent-ops/agents', { id: 'm-dx', name: 'Dx', version: '1.0.0', cds: true, adapter: { kind: 'model', template: 'diagnostic-reasoning', model: 'stub' } }, admin);
    assert.equal(agent.status, 201, agent.text);
    const disc = (await s.call('GET', '/cds-services')).json.services;
    assert.ok(disc.some((x) => x.id === 'agent-m-dx'));
    r = await s.call('POST', '/api/cds/invoke', { hook: 'patient-view', context: { patientId: synthetic.id } }, doc);
    const card = r.json.cards.find((c) => c.serviceId === 'agent-m-dx');
    assert.ok(card, JSON.stringify(r.json.calls));
    assert.match(card.detail, /practice copy/);
    assert.equal((await s.call('GET', `/fhir/R4/ServiceRequest?patient=${synthetic.id}`)).json.entry?.length ?? 0, 0, 'nothing reached the live chart');
  } finally {
    await s.close(); ext.close();
    if (prev === undefined) delete process.env.ALLOW_EXTERNAL_CDS; else process.env.ALLOW_EXTERNAL_CDS = prev;
  }
});
