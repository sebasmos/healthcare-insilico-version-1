// Da Vinci guides (docs/STANDARDS.md): each answers in FHIR, and its output carries the guide's profile.
// Every fixture is built here at run time, without names.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { tempDir, startTestServer } from './support/helpers.mjs';

process.env.PAYER_REFERENCE_FILE = path.join(tempDir('hd-ref-'), 'ref.sqlite');
const ref = await import('../insurance-and-billing/server/reference.mjs');
const x12 = await import('../insurance-and-billing/server/x12.mjs');

// Physician fee schedule, 2024 national figures for an established-patient office visit (CMS relative value file,
// January 2024 release): work 1.30, practice expense 1.33 (non-facility), malpractice 0.10, conversion factor 32.7442.
// Worked by hand: (1.30 + 1.33 + 0.10) x 32.7442 = 89.39.
const D0 = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10); const YEAR = Number(D0.slice(0, 4));
const VISIT = '99213'; const SCAN = '70553';
function reference() {
  const db = ref.openReference(); const rel = (kind) => Number(db.prepare('INSERT INTO releases (kind, release, source, file, checksum, rows, imported_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run(kind, '2024A', 'test fixture built at run time', `${kind}.csv`, kind, '2024-01-01T00:00:00Z').lastInsertRowid);
  const pfs = rel('pfs-rvu'); const ins = db.prepare('INSERT INTO pfs_rvu (code, modifier, status, work, pe_nonfac, pe_fac, mp, conversion, release) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  ins.run(VISIT, '', 'A', 1.30, 1.33, 0.55, 0.10, 32.7442, pfs); ins.run(SCAN, '', 'A', 2.29, 7.0, 7.0, 0.14, 32.7442, pfs);
  const lcd = rel('lcd'); db.prepare('INSERT INTO documents (kind, id, version, title, body, release) VALUES (?, ?, ?, ?, ?, ?)').run('lcd', 'L1', '1', 'Imaging of the head', '{}', lcd);
  const dc = db.prepare('INSERT INTO document_codes (kind, id, version, system, code, role) VALUES (?, ?, ?, ?, ?, ?)'); dc.run('lcd', 'L1', '1', 'HCPCS', SCAN, 'about'); dc.run('lcd', 'L1', '1', 'ICD-10-CM', 'G43', 'covered');
  db.prepare('INSERT INTO settings (key, value, release) VALUES (?, ?, ?)').run('formulary', JSON.stringify({ drugs: [{ rxnorm: '860975', tier: 'generic', priorAuth: false, stepTherapy: false, quantityLimit: true }] }), rel('formulary'));
  const np = rel('npi'); const npi = db.prepare('INSERT INTO npi (npi, entity, state, taxonomy, taxonomies, release) VALUES (?, ?, ?, ?, ?, ?)'); npi.run('1234567893', '1', 'CA', '207R00000X', '["207R00000X"]', np); npi.run('1245319599', '2', 'CA', '282N00000X', '["282N00000X"]', np);
}
reference();

const as = (role, id = `${role}-1`) => ({ 'X-Role': role, 'X-User-Id': id });
const RES = as('researcher'); const DIR = as('payer-medical-director', 'director-1'); const DIR2 = as('payer-medical-director', 'director-2');
let label = 'out';
const good = (r, status = 200) => { assert.equal(r.status, status, r.text); if (process.env.DV_DUMP) { fs.mkdirSync(process.env.DV_DUMP, { recursive: true }); fs.writeFileSync(`${process.env.DV_DUMP}/${label}.json`, JSON.stringify(r.json)); } return r.json; };

async function setUp(s) {
  good(await s.call('POST', '/api/ins/profile', { kind: 'academic-medical-center', npi: '1234567893', payerMix: { 'commercial-employer': 1 } }, RES));
  const plan = good(await s.call('POST', '/api/ins/plans', { type: 'commercial-employer', year: YEAR, benefits: { deductible: 50, coinsurance: 0.2, oopMax: 5000 }, network: { all: true }, authRequired: [SCAN], rateSource: 'fee-schedule' }, RES), 201);
  good(await s.call('POST', '/api/ins/policies/confirm', { id: 'head-imaging', version: '1', effective: '2025-01-01', title: 'Imaging of the head', appliesTo: [{ code: SCAN }], criteria: [{ id: 'dx', text: 'A diagnosis of headache or migraine', evidence: { kind: 'diagnosis', codes: ['R51', 'G43'] } }, { id: 'tried', text: 'First-line treatment was tried', evidence: { kind: 'text', any: ['first-line treatment was tried'] } }] }, RES));
  const p = good(await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', gender: 'female', birthDate: '1980-02-03', identifier: [{ type: { coding: [{ code: 'MR' }] }, value: 'N100130' }] }), 201);
  good(await s.call('POST', `/api/ins/coverage/${p.id}`, { plan: plan.id, start: `${YEAR}-01-01` }, RES));
  const enc = good(await s.call('POST', '/fhir/R4/Encounter', { resourceType: 'Encounter', status: 'in-progress', class: { code: 'AMB' }, subject: { reference: `Patient/${p.id}` }, period: { start: `${D0}T09:00:00Z`, end: `${D0}T09:30:00Z` } }), 201);
  const note = await s.store.save('DocumentReference', { resourceType: 'DocumentReference', status: 'current', docStatus: 'final', subject: { reference: `Patient/${p.id}` }, context: { encounter: [{ reference: `Encounter/${enc.id}` }] }, type: { text: 'Clinic note' }, content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('Headache for three months. First-line treatment was tried without relief.').toString('base64') } }] }, { branch: 'main', updatedBy: 'test' });
  return { plan, p, enc, note };
}


test('every Da Vinci guide answers in FHIR: CRD, DTR, PAS, CDex, PDex, Formulary, Plan-Net and PCT', async () => {
  const s = await startTestServer();
  try {
    const { p, note } = await setUp(s);
    const DV = '/api/ins/davinci';
    const order = { resourceType: 'ServiceRequest', id: 'sr1', status: 'draft', intent: 'order', subject: { reference: `Patient/${p.id}` }, code: { coding: [{ system: 'http://www.ama-assn.org/go/cpt', code: SCAN }] } };
    label = 'crd'; const crd = good(await s.call('POST', `${DV}/crd`, { hook: 'order-sign', hookInstance: 'h1', context: { patientId: p.id, draftOrders: { resourceType: 'Bundle', type: 'collection', entry: [{ resource: order }] } } }, as('physician')));
    assert.ok(crd.cards.length);
    label = 'dtr'; const pkg = good(await s.call('POST', `${DV}/dtr/Questionnaire/$questionnaire-package`, { resourceType: 'Parameters', parameter: [{ name: 'coverage', resource: { resourceType: 'Coverage', status: 'active', beneficiary: { reference: `Patient/${p.id}` }, payor: [{ display: 'Plan' }] } }, { name: 'order', resource: order }] }, as('physician')));
    assert.equal(pkg.resourceType, 'Parameters');
    const claim = { resourceType: 'Claim', status: 'active', use: 'preauthorization', type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional' }] }, patient: { reference: `Patient/${p.id}` }, created: `${D0}T09:00:00Z`, priority: { coding: [{ code: 'normal' }] }, provider: { display: 'Hospital' }, insurer: { display: 'Plan' }, insurance: [{ sequence: 1, focal: true, coverage: { display: 'Coverage' } }], diagnosis: [{ sequence: 1, diagnosisCodeableConcept: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'R51.9' }] } }], item: [{ sequence: 1, productOrService: { coding: [{ system: 'http://www.ama-assn.org/go/cpt', code: SCAN }] }, servicedDate: D0, locationCodeableConcept: { coding: [{ code: '11' }] } }] };
    label = 'pas'; const pas = good(await s.call('POST', `${DV}/pas/Claim/$submit`, { resourceType: 'Bundle', type: 'collection', entry: [{ resource: claim }] }, as('nurse')), 201);
    assert.equal(pas.resourceType, 'Bundle'); assert.equal(pas.entry[0].resource.resourceType, 'ClaimResponse');
    label = 'cdex'; good(await s.call('GET', `${DV}/cdex/Task`, undefined, as('nurse')));
    label = 'pct'; const gfe = good(await s.call('POST', `${DV}/pct/Claim/$gfe-submit`, { resourceType: 'Bundle', type: 'collection', entry: [{ resource: { ...claim, use: 'predetermination', item: [{ ...claim.item[0], net: { value: 2000, currency: 'USD' } }] } }] }, as('nurse')), 201);
    assert.equal(gfe.resourceType, 'Bundle');
    label = 'pdex'; good(await s.call('GET', `${DV}/pdex/Patient/${p.id}/$member-history`, undefined, RES));
    label = 'formulary'; good(await s.call('GET', `${DV}/formulary/MedicationKnowledge`, undefined, RES));
    label = 'plannet'; good(await s.call('GET', `${DV}/plannet/Practitioner`, undefined, RES)); label = 'plannet-org'; good(await s.call('GET', `${DV}/plannet/Organization`, undefined, RES));
    for (const g of ['crd', 'dtr', 'pas', 'cdex', 'pdex', 'formulary', 'plannet', 'pct']) { label = `cap-${g}`; assert.equal(good(await s.call('GET', `${DV}/${g}/metadata`, undefined, RES)).resourceType, 'CapabilityStatement'); }
    assert.match(pas.meta.profile[0], /davinci-pas.*pas-response-bundle/);
    assert.match(pkg.meta.profile[0], /davinci-dtr/); assert.match(gfe.entry[0].resource.meta.profile[0], /davinci-pct-aeob/);
    assert.match(crd.cards[0].suggestions[0].actions[0].resource.meta.profile[0], /davinci-crd/);
    for (const m of JSON.stringify([pas, gfe]).matchAll(/"family":"([^"]*)"/g)) assert.match(m[1], /^Patient N\d{6}$/, 'only the record number stands in for a name');
    void note;
  } finally { await s.close(); }
});
