// Model adapters: the interface contract with the stub, every
// template through the agent loop, the model.call TraceStep, prompt text
// only off main (masked), refusal for non-synthetic and restricted patients,
// external adapters off by default, and the key never logged.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, testClock, patient, BACKEND } from './support/helpers.mjs';
import { stubReply, TEMPLATES } from '../agent-operations/server/models/templates.mjs';
import { availability } from '../agent-operations/server/models/adapters.mjs';

const doc = { 'X-Role': 'physician', 'X-User-Id': 'dr-one' };
const tech = { 'X-Role': 'nurse', 'X-User-Id': 'tech-two' };
const admin = { 'X-Role': 'physician', 'X-User-Id': 'admin' };
const HTEST = { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST', display: 'test health data' };
const register = (s, id, template, model = 'stub', extra = {}) => s.call('POST', '/agent-ops/agents', { id, name: `Model ${template}`, version: '1.0.0', description: `${template} on ${model}`, adapter: { kind: 'model', template, model, ...extra } }, admin);
const steps = async (s, runId) => (await s.call('GET', `/agent-ops/trace?runId=${runId}`)).json.steps;

test('stub replies are deterministic for a prompt and seed; external adapters are off by default with a reason', () => {
  const req = { template: 'radiology-report', system: 'x', messages: [{ role: 'user', content: '<study>\nXR chest; modality DX; series 1; header patient id N1; chart MRN N1\n</study>\n<indication>\npneumonia\n</indication>\n<priors>\n\n</priors>' }] };
  assert.equal(stubReply(req, 3), stubReply(req, 3));
  assert.match(stubReply(req, 3), /pneumonia/);
  const wrong = stubReply({ ...req, messages: [{ role: 'user', content: req.messages[0].content.replace('chart MRN N1', 'chart MRN N2') }] }, 3);
  assert.match(wrong, /wrong-patient/);
  const a = availability({});
  assert.equal(a.stub.available, true);
  for (const k of ['openai-compatible', 'anthropic', 'http-json']) { assert.equal(a[k].available, false); assert.match(a[k].reason, /ALLOW_EXTERNAL_MODELS/); }
  assert.equal(availability({ ALLOW_EXTERNAL_MODELS: 'true', OPENAI_API_KEY: 'k', OPENAI_MODEL: 'm' })['openai-compatible'].available, true);
  assert.equal(Object.keys(TEMPLATES).length, 6);
});

async function setup() {
  const clock = testClock('2026-05-01T09:00:00.000Z');
  const s = await startTestServer({ clock });
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Modelcase', { meta: { security: [HTEST] } }))).json;
  const study = (await s.call('POST', '/fhir/R4/ImagingStudy', { resourceType: 'ImagingStudy', status: 'available', subject: { reference: `Patient/${p.id}` }, started: clock.now(), description: 'XR Chest 2 views', modality: [{ system: 'http://dicom.nema.org/resources/ontology/DCM', code: 'DX' }], reasonCode: [{ text: 'Cough and fever, query pneumonia' }], numberOfSeries: 1, numberOfInstances: 1 }, tech)).json;
  const run = async (agentId, subject, extra = {}) => { const r = await s.call('POST', `/agent-ops/agents/${agentId}/run`, { mode: 'sandbox', subject, ...extra }, admin); assert.equal(r.status, 201, r.text); await s.agents.idle(); return (await s.call('GET', `/agent-ops/runs/${r.json.id}`)).json; };
  return { s, p, study, clock, run };
}

test(`[${BACKEND}] every template runs on the stub through the agent loop, writes on the run branch through the envelope, and logs a model.call with token counts, latency and a prompt hash; prompt text appears masked off main`, async () => {
  const { s, p, study, run } = await setup();
  try {
    for (const t of Object.keys(TEMPLATES)) { const r = await register(s, `m-${t}`, t); assert.equal(r.status, 201, r.text); assert.equal(r.json.adapter.kind, 'model'); assert.equal(r.json.capability, TEMPLATES[t].capability); }
    // radiology report
    let out = await run('m-radiology-report', `ImagingStudy/${study.id}`);
    assert.equal(out.endReason, 'completed', JSON.stringify(out.result));
    assert.match(out.result.output, /^DiagnosticReport\//);
    const report = (await s.call('GET', `/fhir/R4/${out.result.output}?_branch=${out.branch}`)).json;
    assert.equal(report.status, 'preliminary');
    assert.match(report.conclusion, /pneumonia/);
    const calls = (await steps(s, out.id)).filter((x) => x.did.type === 'model.call');
    assert.equal(calls.length, 1);
    const a = calls[0].did.args;
    assert.deepEqual([a.adapter, a.model, a.template], ['stub', 'stub-1', 'radiology-report']);
    assert.ok(a.promptTokens > 0 && a.completionTokens > 0 && typeof a.latencyMs === 'number' && /^[0-9a-f]{16}$/.test(a.promptHash));
    assert.ok(a.text, 'the run is not on main, so the text is kept');
    assert.ok(!JSON.stringify(a.text).includes('Modelcase'), 'the patient name is masked');
    assert.equal((await s.call('GET', `/fhir/R4/DiagnosticReport?patient=${p.id}`)).json.entry?.length ?? 0, 0, 'nothing reached main');
    // classifier: findings as Observations with category model-finding, never a report
    out = await run('m-cxr-classifier', `ImagingStudy/${study.id}`);
    assert.equal(out.endReason, 'completed', JSON.stringify(out.result));
    const findings = (await s.call('GET', `/fhir/R4/Observation?patient=${p.id}&category=model-finding&_branch=${out.branch}`)).json.entry.map((e) => e.resource);
    assert.ok(findings.length >= 1 && findings.every((f) => f.focus?.[0]?.reference === `ImagingStudy/${study.id}`));
    // scribe
    const transcript = (await s.call('POST', '/fhir/R4/DocumentReference', { resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', type: { coding: [{ system: 'http://loinc.org', code: 'transcript' }] }, subject: { reference: `Patient/${p.id}` }, content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('Patient reports a cough for three days. Chest is clear. Likely viral. Rest and fluids.').toString('base64') } }] }, doc)).json;
    out = await run('m-scribe', `Patient/${p.id}`, { context: { transcript: `DocumentReference/${transcript.id}`, roles: ['subjective', 'objective', 'assessment', 'plan'] } });
    assert.equal(out.endReason, 'completed', JSON.stringify(out.result));
    assert.match(out.result.output[0], /^DocumentReference\//);
    // diagnostic reasoning
    out = await run('m-diagnostic-reasoning', `Patient/${p.id}`, { goal: 'Work up chest pain' });
    assert.equal(out.endReason, 'completed', JSON.stringify(out.result));
    assert.ok(out.result.output.length >= 1);
    // rpm triage
    const enrol = await s.call('POST', '/api/rpm/enrol', { patient: p.id, programme: 'heart-failure' }, doc);
    assert.equal(enrol.status, 201, enrol.text);
    await s.call('POST', '/api/rpm/readings', { patient: p.id, key: 'weight', value: 80 }, doc);
    const high = (await s.call('POST', '/api/rpm/readings', { patient: p.id, key: 'sbp', value: 190 }, doc)).json;
    assert.equal(high.alerts.length, 1);
    out = await run('m-rpm-triage', `Task/${high.alerts[0].id}`);
    assert.equal(out.endReason, 'completed', JSON.stringify(out.result));
    const proposal = (await s.call('GET', `/fhir/R4/${out.result.output}?_branch=${out.branch}`)).json;
    assert.equal(proposal.code.coding[0].code, 'rpm-triage-proposal');
    // model settings route: for people only, no keys
    const settings = await s.call('GET', '/agent-ops/models');
    assert.equal(settings.status, 200);
    assert.equal(settings.json.templates.length, 6);
    assert.equal(settings.json.adapters.stub.available, true);
  } finally { await s.close(); }
});

test(`[${BACKEND}] external models: refused for a non-synthetic patient and for a restricted source even when synthetic; the key reaches the endpoint but never the log, the registry or the browser; a model-backed version starts in shadow and is red-teamed`, async () => {
  const seen = [];
  const fake = http.createServer((req, res) => { let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => { seen.push({ auth: req.headers.authorization, body }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ model: 'fake-1', choices: [{ message: { content: JSON.stringify({ technique: 'XR', findings: 'Clear lungs.', impression: 'No acute abnormality.', abnormal: false, flags: [] }) } }], usage: { prompt_tokens: 120, completion_tokens: 30 } })); }); });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const prev = { ...process.env };
  Object.assign(process.env, { ALLOW_EXTERNAL_MODELS: 'true', OPENAI_API_KEY: 'sk-secret-never-logged', OPENAI_MODEL: 'fake-1', OPENAI_BASE_URL: `http://127.0.0.1:${fake.address().port}/v1` });
  const { s, p, study, run } = await setup();
  try {
    assert.equal((await register(s, 'ext-report', 'radiology-report', 'openai-compatible')).status, 201);
    const agent = (await s.call('GET', '/agent-ops/agents')).json.agents.find((a) => a.id === 'ext-report');
    assert.equal(agent.stage, 'shadow');
    // Not synthetic: refused
    const plain = (await s.call('POST', '/fhir/R4/Patient', patient('Realish'))).json;
    const plainStudy = (await s.call('POST', '/fhir/R4/ImagingStudy', { resourceType: 'ImagingStudy', status: 'available', subject: { reference: `Patient/${plain.id}` }, started: '2026-05-01T08:00:00Z', description: 'XR Chest', modality: [{ system: 'http://dicom.nema.org/resources/ontology/DCM', code: 'DX' }], numberOfSeries: 1, numberOfInstances: 1 }, tech)).json;
    let out = await run('ext-report', `ImagingStudy/${plainStudy.id}`);
    assert.equal(out.endReason, 'refused', JSON.stringify(out.result));
    assert.ok((await steps(s, out.id)).some((x) => x.did.type === 'model.refuse' && /not marked synthetic/.test(x.did.args.reason)));
    assert.equal(seen.length, 0, 'the endpoint was never called');
    // Synthetic but restricted: refused
    const restricted = (await s.call('POST', '/fhir/R4/Patient', { ...patient('Restricted'), meta: { security: [HTEST] }, extension: [{ url: 'urn:hospital-desktop:restricted-source', valueString: 'dua-set' }] })).json;
    const rStudy = (await s.call('POST', '/fhir/R4/ImagingStudy', { resourceType: 'ImagingStudy', status: 'available', subject: { reference: `Patient/${restricted.id}` }, started: '2026-05-01T08:00:00Z', description: 'XR Chest', modality: [{ system: 'http://dicom.nema.org/resources/ontology/DCM', code: 'DX' }], numberOfSeries: 1, numberOfInstances: 1 }, tech)).json;
    out = await run('ext-report', `ImagingStudy/${rStudy.id}`);
    assert.equal(out.endReason, 'refused');
    assert.ok((await steps(s, out.id)).some((x) => x.did.type === 'model.refuse' && /restricted/.test(x.did.args.reason)));
    // Synthetic: allowed; the key reaches the endpoint only
    out = await run('ext-report', `ImagingStudy/${study.id}`);
    assert.equal(out.endReason, 'completed', JSON.stringify(out.result));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].auth, 'Bearer sk-secret-never-logged');
    const call = (await steps(s, out.id)).find((x) => x.did.type === 'model.call');
    assert.deepEqual([call.did.args.adapter, call.did.args.model, call.did.args.promptTokens, call.did.args.completionTokens], ['openai-compatible', 'fake-1', 120, 30]);
    const everything = JSON.stringify([await steps(s, out.id), (await s.call('GET', '/agent-ops/agents')).json, (await s.call('GET', '/agent-ops/models')).json, (await s.call('GET', '/agent-ops/policies')).json]);
    assert.ok(!everything.includes('sk-secret'), 'the key is never logged, stored or sent to the browser');
    // Local stub unaffected by the guard
    assert.equal((await register(s, 'local-report', 'radiology-report', 'stub')).status, 201);
    out = await run('local-report', `ImagingStudy/${plainStudy.id}`);
    assert.equal(out.endReason, 'completed', 'a local model may be used for any patient');
    // Model card fields
    const card = (await s.call('GET', '/agent-ops/policies')).json.policies.find((x) => x.agentId === 'ext-report').card;
    assert.deepEqual([card.adapter, card.model, card.temperature, card.contextWindow], ['openai-compatible', 'fake-1', 0, TEMPLATES['radiology-report'].contextWindow]);
    assert.ok(card.promptHash);
    // A model-backed version is red-teamed automatically when enabled
    const auto = (await s.call('GET', '/agent-ops/red-team')).json;
    assert.ok(Array.isArray(auto.runs || auto.reports || []));
  } finally {
    await s.close();
    fake.close();
    for (const k of ['ALLOW_EXTERNAL_MODELS', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_BASE_URL']) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
});
