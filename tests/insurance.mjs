// The insurance environment (docs/PAYER.md): the full loop in X12 and FHIR, a worked payment example, an autonomous
// agent kept to its branch, and no patient names anywhere. Every fixture is built here at run time, without names.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
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
}
reference();

const as = (role, id = `${role}-1`) => ({ 'X-Role': role, 'X-User-Id': id });
const RES = as('researcher'); const DIR = as('payer-medical-director', 'director-1'); const DIR2 = as('payer-medical-director', 'director-2');
const good = (r, status = 200) => { assert.equal(r.status, status, r.text); return r.json; };

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

test('the full loop: order, authorization, care, coding, claim, remittance, denial and appeal, in X12 and in FHIR; and payment matches the worked example', async () => {
  const s = await startTestServer();
  try {
    const { p, enc, note } = await setUp(s);
    const el = good(await s.call('POST', '/api/ins/eligibility', { patient: p.id, serviceDate: D0 }, as('nurse')));
    assert.equal(el.active, true, JSON.stringify(el));
    // Order and authorization. Hospital staff cannot decide; the rules approve when every criterion is met by what was sent.
    const need = good(await s.call('POST', '/api/ins/auth/need', { patient: p.id, services: [{ code: SCAN }], serviceDate: D0 }, as('physician')));
    assert.equal(need.needed, true);
    const auth = good(await s.call('POST', '/api/ins/auth', { patient: p.id, services: [{ code: SCAN }], diagnoses: ['R51.9'], serviceDate: D0, setting: '11', documents: [note.id] }, as('nurse')), 201);
    assert.equal(auth.status, 'approved', JSON.stringify((await s.call('GET', `/api/ins/payer/cases/${auth.id}`, undefined, RES)).json).slice(0, 1500)); assert.ok(auth.authNumber);
    assert.equal((await s.call('POST', `/api/ins/payer/cases/${auth.id}/decide`, { decision: 'approved' }, as('nurse'))).status, 403, 'hospital staff never decide');
    assert.equal((await s.call('GET', `/api/ins/auth/${auth.id}`, undefined, as('payer-medical-director'))).status, 403, 'the insurer does not read the hospital\'s records');
    // Care and coding. A leading query is refused.
    assert.equal((await s.call('POST', `/api/ins/coding/${enc.id}/query`, { question: 'Please document that the patient has migraine with aura.' }, as('coder'))).status, 422);
    const coded = good(await s.call('POST', `/api/ins/coding/${enc.id}`, { setting: 'office', diagnoses: [{ code: 'R51.9' }], lines: [{ code: VISIT, charge: 150 }, { code: SCAN, charge: 2000 }] }, as('coder')));
    assert.equal(coded.status, 'coded');
    assert.equal((await s.call('POST', `/api/ins/coding/${enc.id}`, { setting: 'office', diagnoses: [{ code: 'R51.9' }], lines: [{ code: VISIT, charge: 150 }] }, as('nurse'))).status, 403, 'a nurse does not code');
    // Claim: 837P through the clearinghouse (999, 277CA) to the insurer.
    const built = good(await s.call('POST', '/api/ins/claims/build', { encounter: enc.id }, as('coder')), 201); assert.equal(built.claims.length, 1); const claimId = built.claims[0].id;
    const sent = good(await s.call('POST', `/api/ins/claims/${claimId}/send`, {}, as('coder'))); assert.equal(sent.accepted, true, JSON.stringify(sent.rejection));
    assert.ok(x12.validate(sent.x12.claim).ok); assert.match(sent.x12.claim, /ST\*837\*/); assert.match(sent.x12.ack999, /ST\*999\*/); assert.match(sent.x12.ack277CA, /ST\*277\*/);
    // The scan's diagnosis is not on the coverage document's list: pended for a physician, never denied by rule.
    const queue = good(await s.call('GET', '/api/ins/payer/queue?queue=claims', undefined, as('payer-medical-director'))); assert.equal(queue.length, 1); assert.deepEqual(queue[0].flags, ['medical-necessity']);
    const decide = { lines: [{ line: 2, action: 'deny', carc: '50', reason: 'The diagnosis on the claim is not on the covered list.' }] };
    good(await s.call('POST', `/api/ins/payer/claims/${sent.payerControl}/decide`, decide, DIR));
    // Remittance: a balanced 835, posted on the hospital side. The visit pays by the worked example.
    let claim = good(await s.call('GET', `/api/ins/claims/${claimId}`, undefined, as('coder')));
    assert.equal(claim.status, 'partially-paid'); assert.equal(claim.denials[0].carc, '50'); assert.equal(claim.denials[0].amount, 2000);
    const visit = claim.remit.lines[0]; const adj = (g, r) => visit.adjustments.find((a) => a.group === g && a.reason === r)?.amount;
    assert.equal(adj('CO', '45'), 60.61, 'charge 150 less the fee schedule amount 89.39'); assert.equal(adj('PR', '1'), 50, 'deductible'); assert.equal(adj('PR', '2'), 7.88, '20% of 39.39'); assert.equal(visit.paid, 31.51); assert.equal(claim.remit.patientOwes, 57.88);
    const st = good(await s.call('GET', `/api/ins/claims/${claimId}/status`, undefined, as('coder'))); assert.equal(st.category, 'F1');
    // Appeal: prepared by the coder, signed by a physician, decided by a different medical director.
    const letter = good(await s.call('POST', '/api/ins/letters', { about: { kind: 'claim', ref: claimId }, kind: 'appeal', text: 'The scan was authorized and the criteria of the policy were met.', citations: [{ document: note.id, quote: 'First-line treatment was tried without relief.' }] }, as('coder')), 201);
    assert.equal((await s.call('POST', '/api/ins/appeals', { about: { kind: 'claim', ref: claimId }, letter: letter.id, reason: 'Authorized' }, as('coder'))).status, 422, 'unsigned');
    good(await s.call('POST', `/api/ins/letters/${letter.id}/sign`, {}, as('physician')));
    const appeal = good(await s.call('POST', '/api/ins/appeals', { about: { kind: 'claim', ref: claimId }, letter: letter.id, reason: 'The service was authorized.' }, as('coder')), 201);
    assert.equal((await s.call('POST', `/api/ins/payer/appeals/${appeal.id}/decide`, { outcome: 'overturned', reason: 'Authorized' }, DIR)).status, 403, 'not the person who denied');
    good(await s.call('POST', `/api/ins/payer/appeals/${appeal.id}/decide`, { outcome: 'overturned', reason: 'An authorization was on file and the criteria were met.' }, DIR2));
    claim = good(await s.call('GET', `/api/ins/claims/${claimId}`, undefined, as('coder'))); assert.equal(claim.status, 'paid', JSON.stringify(claim.denials)); assert.ok(claim.remit.lines[1].paid > 0);
    assert.equal(claim.remit.lines[0].paid, 31.51, 'the visit is not charged the deductible twice');
    // Both standards on the wire, and consistent with each other.
    const wire = good(await s.call('GET', '/api/ins/messages?limit=500', undefined, RES)); const types = new Set(wire.map((m) => m.type));
    for (const t of ['834', '270', '271', '278', '275', '837P', '999', '277CA', '835', '276', '277']) assert.ok(types.has(t), `no ${t} on the wire`);
    for (const m of wire) assert.ok(x12.parse(m.x12).transactions.length >= 1, m.type);
    const fhir = wire.filter((m) => m.fhir).map((m) => m.fhir.resourceType); for (const t of ['Claim', 'ClaimResponse', 'PaymentReconciliation']) assert.ok(fhir.includes(t), `no FHIR ${t}`);
    const c837 = wire.find((m) => m.type === '837P' && m.fhir); assert.equal(c837.fhir.total.value, x12.readClaim837(x12.parse(c837.x12).transactions[0]).total);
    const mine = good(await s.call('GET', `/api/ins/my?patient=${p.id}`, undefined, RES)); assert.equal(mine.explanations[0].fhir.resourceType, 'ExplanationOfBenefit'); assert.equal(mine.card.coverage[0].accumulators.deductibleMet, 50);
    // No patient names anywhere: only numbers.
    const all = JSON.stringify([wire, mine, claim, auth, queue, good(await s.call('GET', '/api/ins/metrics', undefined, RES))]);
    assert.ok(all.includes('Patient N100130')); assert.ok(!/"(family|given)"/.test(all)); assert.ok(!/NM1\*(IL|QC)\*1\*(?!Patient N100130\*)[A-Za-z]/.test(all), 'a name in a subscriber segment');
  } finally { await s.close(); }
});

test('no patient names appear: a chart that was stored with a name reaches no insurance record, message or page', async () => {
  const s = await startTestServer();
  try {
    const { plan } = await setUp(s); const family = ['Zq', 'xw', 'vk'].join(''); const given = ['Jb', 'yq'].join('');
    const saved = await s.store.save('Patient', { resourceType: 'Patient', name: [{ family, given: [given] }], gender: 'male', birthDate: '1975-05-05', identifier: [{ type: { coding: [{ code: 'MR' }] }, value: 'N100200' }] }, { branch: 'main', updatedBy: 'test' });
    good(await s.call('POST', `/api/ins/coverage/${saved.id}`, { plan: plan.id, start: `${YEAR}-01-01` }, RES));
    good(await s.call('POST', '/api/ins/eligibility', { patient: saved.id, serviceDate: D0 }, as('nurse')));
    good(await s.call('POST', '/api/ins/auth', { patient: saved.id, services: [{ code: SCAN }], diagnoses: ['R51.9'], serviceDate: D0, setting: '11' }, as('nurse')), 201);
    const texts = [];
    for (const type of ['InsMember', 'InsCoverage', 'InsMessage', 'InsAuth', 'InsCase', 'InsLetter', 'InsRuleLog']) texts.push(JSON.stringify(await s.store.query(type, {})));
    for (const url of ['/api/ins/messages', '/api/ins/auth', `/api/ins/coverage/${saved.id}`, `/api/ins/my?patient=${saved.id}`, '/api/ins/payer/queue?all=1']) texts.push((await s.call('GET', url, undefined, RES)).text);
    const all = texts.join('\n'); assert.ok(all.includes('Patient N100200')); assert.ok(!all.includes(family) && !all.includes(given), 'a stored name leaked');
  } finally { await s.close(); }
});

test('an autonomous agent decides only on its own branch; on the live record it may only recommend', async () => {
  const s = await startTestServer();
  try {
    const { p } = await setUp(s);
    good(await s.call('POST', '/agent-ops/agents', { id: 'reviewer-agent', name: 'Reviewer agent', version: '1', adapter: { kind: 'external' }, connection: 'mcp', scopes: [{ type: 'Task', interactions: ['create'] }], requested: { systems: { payer: 'read-write', 'business-office': 'read-write' } } }, RES), 201);
    // Nothing attached, so the rules ask for records and a person (or the agent) must review.
    const auth = good(await s.call('POST', '/api/ins/auth', { patient: p.id, services: [{ code: SCAN }], diagnoses: ['M54.5'], serviceDate: D0, setting: '11', answers: { none: true } }, as('nurse')), 201);
    const run = good(await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'reviewer-agent', context: { side: 'insurer' } }, RES), 201); assert.notEqual(run.branch, 'main');
    let n = 0; const agent = () => ({ 'X-Agent-Id': 'reviewer-agent', 'X-Run-Id': run.id, 'Idempotency-Key': `k${n += 1}` });
    const before = await s.store.get('InsCase', auth.id, { branch: 'main' });
    assert.equal((await s.call('POST', `/api/ins/payer/cases/${auth.id}/decide?_branch=main`, { decision: 'denied', reason: 'No', unmet: ['dx'] }, agent())).status, 403, 'never on the live record');
    const d = good(await s.call('POST', `/api/ins/payer/cases/${auth.id}/decide`, { decision: 'denied', reason: 'The diagnosis sent is not headache or migraine.', unmet: ['dx'] }, agent()));
    assert.equal(d.status, 'denied');
    assert.equal((await s.store.get('InsCase', auth.id, { branch: run.branch })).status, 'denied');
    const after = await s.store.get('InsCase', auth.id, { branch: 'main' }); assert.equal(after.status, before.status); assert.equal(after.meta.versionId, before.meta.versionId, 'main is untouched');
    assert.equal((await s.store.get('InsAuth', auth.id, { branch: 'main' })).status, (await s.call('GET', `/api/ins/auth/${auth.id}`, undefined, as('nurse'))).json.status);
    assert.equal((await s.store.query('InsLetter', { where: (l) => l.about?.ref === auth.id && l.decision === 'denied' }, { branch: 'main' })).length, 0);
    // The study outcomes are read per branch: the wrongful denial exists on the agent's branch only. Changing the decisive fact changes the criteria.
    const reference = { cases: { [auth.id]: { decision: 'approved' } } };
    assert.deepEqual(good(await s.call('POST', `/api/ins/outcomes?_branch=${run.branch}`, { reference }, RES)).decisions.wrongfulDenials, [auth.id]);
    assert.deepEqual(good(await s.call('POST', '/api/ins/outcomes', { reference }, RES)).decisions.wrongfulDenials, []);
    const cf = good(await s.call('POST', '/api/ins/outcomes/counterfactual', { case: auth.id, change: { diagnoses: ['R51.9'] } }, RES)); assert.deepEqual(cf.criteriaChanged.map((x) => [x.id, x.to]), [['dx', 'met']]);
    // A hospital-side agent never decides, even on a branch.
    const run2 = good(await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'reviewer-agent', context: { side: 'hospital' } }, RES), 201);
    assert.equal((await s.call('POST', `/api/ins/payer/cases/${auth.id}/decide`, { decision: 'approved' }, { 'X-Agent-Id': 'reviewer-agent', 'X-Run-Id': run2.id, 'Idempotency-Key': 'k9' })).status, 403);
  } finally { await s.close(); }
});

test('payment and patient share match the worked example from the fee schedule figures', async () => {
  const { costShare, emptyAccumulators } = await import('../insurance-and-billing/server/plans.mjs');
  const fee = ref.feeSchedule(VISIT, { facility: false }); assert.equal(Math.round(fee.amount * 100) / 100, 89.39, '(1.30 + 1.33 + 0.10) x 32.7442');
  assert.equal(Math.round(ref.feeSchedule(VISIT, { facility: true }).amount * 100) / 100, 63.85, '(1.30 + 0.55 + 0.10) x 32.7442, the facility rate');
  const benefits = { deductible: 50, coinsurance: 0.2, oopMax: 100, copays: {} };
  const first = costShare(benefits, emptyAccumulators(), 89.39); assert.deepEqual([first.deductible, first.coinsurance, first.planPays], [50, 7.88, 31.51]);
  const second = costShare(benefits, first.accumulators, 89.39); assert.deepEqual([second.deductible, second.coinsurance, second.planPays], [0, 17.88, 71.51]);
  const third = costShare(benefits, second.accumulators, 200); assert.equal(third.patientOwes, 24.24, 'stops at the out-of-pocket maximum'); assert.equal(third.planPays, 175.76);
});
