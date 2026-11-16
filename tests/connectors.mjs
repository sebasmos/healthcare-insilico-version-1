// Connectors for outside agents: MCP per system, plain FHIR and CDS Hooks,
// all under the agent's permissions; keys are per agent, shown once, off by default; citations are checked
// when a run finishes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, patient, BACKEND } from './support/helpers.mjs';
import { TOOLS, MCP_PROTOCOL } from '../agent-operations/server/connectors.mjs';
import { SYSTEMS } from '../agent-operations/server/permissions.mjs';

const res = { 'X-Role': 'researcher', 'X-User-Id': 'owner-one' };
const biller = { 'X-Role': 'billing', 'X-User-Id': 'Billing One' };
const SYN = { meta: { security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST', display: 'test health data' }] } };

test('every system has an MCP server whose tools carry a JSON schema', () => {
  assert.deepEqual(Object.keys(TOOLS).sort(), [...SYSTEMS].sort());
  for (const [system, tools] of Object.entries(TOOLS)) for (const t of tools) {
    assert.match(t.name, /^[a-z_]+$/); assert.ok(t.description.length > 10, `${system}.${t.name}`);
    assert.equal(t.inputSchema.type, 'object'); assert.equal(typeof t.call, 'function');
  }
});

test(`[${BACKEND}] an outside agent: key shown once, off by default, every connector honours the granted level, keys are scoped to their agent`, async (t) => {
  const s = await startTestServer(); t.after(() => s.close());
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Connect', SYN))).json;
  await s.call('POST', '/api/ins/profile', { kind: 'academic-medical-center', npi: '1234567893', payerMix: { 'commercial-employer': 1 } }, res);
  const plan = (await s.call('POST', '/api/ins/plans', { type: 'commercial-employer', benefits: { deductible: 50, coinsurance: 0.2, oopMax: 5000 }, network: { all: true }, authRequired: ['70450'] }, res)).json;
  await s.call('POST', '/api/ins/policies/confirm', { id: 'head-imaging', version: '1', effective: '2025-01-01', title: 'Imaging of the head', appliesTo: [{ code: '70450' }], criteria: [{ id: 'dx', text: 'A diagnosis of headache', evidence: { kind: 'diagnosis', codes: ['R51'] } }] }, res);
  await s.call('POST', `/api/ins/coverage/${p.id}`, { plan: plan.id }, res);
  const k = (await s.call('POST', '/fhir/R4/Observation', { resourceType: 'Observation', status: 'preliminary', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }], code: { coding: [{ system: 'http://loinc.org', code: '2823-3', display: 'Potassium' }] }, subject: { reference: `Patient/${p.id}` }, effectiveDateTime: new Date().toISOString(), valueQuantity: { value: 6.9, unit: 'mmol/L' } })).json;
  assert.ok(k.id, JSON.stringify(k));

  const submit = (id, requested) => s.call('POST', '/connect/v1/agents', { id, name: id, organisation: 'Outside Team', modelName: 'their-model', requested });
  assert.equal((await submit('reader', { systems: { ehr: 'read-only', payer: 'read-only' }, mustCite: true })).status, 202);
  assert.equal((await submit('proposer', { systems: { ehr: 'read-propose', payer: 'read-propose', 'business-office': 'read-propose' } })).status, 202);
  assert.equal((await submit('reader', {})).status, 409);
  // Approved without connectors: no key, and nothing answers.
  const plain = await s.call('POST', '/agent-ops/agents/reader/approve', {}, res);
  assert.equal(plain.json.connectorKey, undefined);
  assert.equal((await s.call('POST', '/connect/v1/runs', {}, { Authorization: 'Bearer hd_agent_00' })).status, 401);
  assert.equal((await s.call('POST', '/connect/v1/runs', {})).status, 401);
  // Switched on: the key is shown once and never again.
  const on = await s.call('POST', '/agent-ops/agents/reader/approve', { connectors: true }, res);
  const readerKey = on.json.connectorKey; assert.match(readerKey, /^hd_agent_[0-9a-f]{48}$/);
  const again = await s.call('POST', '/agent-ops/agents/reader/approve', { connectors: true }, res);
  assert.equal(again.json.connectorKey, undefined, 'shown once');
  assert.equal(JSON.stringify((await s.call('GET', '/agent-ops/agents', undefined, res)).json).includes(readerKey), false, 'the key is never listed');
  assert.equal(JSON.stringify(await s.store.query('ConnectorKey')).includes(readerKey), false, 'only its hash is stored');
  const proposerKey = (await s.call('POST', '/agent-ops/agents/proposer/approve', { connectors: true }, res)).json.connectorKey;

  const R = { Authorization: `Bearer ${readerKey}` }; const P = { Authorization: `Bearer ${proposerKey}` };
  const rRun = (await s.call('POST', '/connect/v1/runs', { subject: `Patient/${p.id}` }, R)).json; const pRun = (await s.call('POST', '/connect/v1/runs', { subject: `Patient/${p.id}` }, P)).json;
  assert.deepEqual([rRun.permissionLevel, rRun.mustCite, pRun.permissionLevel], ['read-only', true, 'read-propose']);
  let id = 0; const mcp = async (system, key, run, method, params) => (await s.call('POST', `/connect/v1/mcp/${system}`, { jsonrpc: '2.0', id: id += 1, method, params }, { ...key, 'X-Run-Id': run.runId })).json;
  const tool = (system, key, run, name, args) => mcp(system, key, run, 'tools/call', { name, arguments: args });

  // MCP: handshake, tools and resources.
  const init = await mcp('payer', R, rRun, 'initialize', {});
  assert.equal(init.result.protocolVersion, MCP_PROTOCOL); assert.ok(init.result.capabilities.tools);
  assert.ok((await mcp('payer', R, rRun, 'tools/list')).result.tools.some((x) => x.name === 'ins_review_case' && x.inputSchema.required.includes('id')));
  assert.deepEqual((await mcp('lab', R, rRun, 'tools/list')).result.tools, [], 'a system the agent has no access to offers no tools');
  assert.ok((await mcp('payer', R, rRun, 'resources/list')).result.resources.some((x) => x.uri === 'payer://policies/head-imaging'));
  assert.match((await mcp('payer', R, rRun, 'resources/read', { uri: 'payer://policies/head-imaging' })).result.contents[0].text, /criteria/);
  assert.equal((await mcp('nowhere', R, rRun, 'tools/list')).error.code, -32601);

  // Read only: reads work on each connector, every write is refused on each connector.
  const elig = await tool('payer', R, rRun, 'ins_search_policies', { code: '70450' });
  assert.equal(elig.result.isError, false, JSON.stringify(elig)); assert.equal(JSON.parse(elig.result.content[0].text)[0].title, 'Imaging of the head');
  const got = await tool('ehr', R, rRun, 'read_record', { type: 'Patient', id: p.id });
  assert.equal(JSON.parse(got.result.content[0].text).id, p.id);
  const order = { resourceType: 'ServiceRequest', status: 'draft', intent: 'order', subject: { reference: `Patient/${p.id}` }, code: { text: 'Chest radiograph' } };
  const refused = await tool('ehr', R, rRun, 'create_record', { resource: order });
  assert.equal(refused.result.isError, true); assert.match(refused.result.content[0].text, /read only/i);
  const noLab = await tool('lab', R, rRun, 'lab_worklist', {});
  assert.equal(noLab.result.isError, true); assert.match(noLab.result.content[0].text, /no access/i);
  const fhirHeaders = (key, run, n) => ({ ...key, 'X-Run-Id': run.runId, 'Idempotency-Key': `f-${n}` });
  assert.equal((await s.call('GET', `/connect/v1/fhir/Patient/${p.id}`, undefined, fhirHeaders(R, rRun, 1))).json.id, p.id);
  assert.equal((await s.call('POST', '/connect/v1/fhir/ServiceRequest', order, fhirHeaders(R, rRun, 2))).status, 403);
  assert.ok((await s.call('GET', '/connect/v1/cds-services', undefined, fhirHeaders(R, rRun, 3))).json.services.some((x) => x.hook === 'order-select'));
  const noPacket = await tool('business-office', R, rRun, 'ins_auth_questionnaire', { patient: p.id, services: [{ code: '70450' }], diagnoses: ['R51.9'] });
  assert.equal(noPacket.result.isError, true);

  // Read and propose: drafts through MCP and through FHIR; settling is still refused.
  const made = await tool('ehr', P, pRun, 'create_record', { resource: order });
  assert.equal(made.result.isError, false, JSON.stringify(made));
  const viaFhir = await s.call('POST', '/connect/v1/fhir/ServiceRequest', order, fhirHeaders(P, pRun, 4));
  assert.equal(viaFhir.status, 201, viaFhir.text);
  assert.equal((await s.store.get('ServiceRequest', viaFhir.json.id)), null, 'nothing reaches the live record');
  assert.ok(await s.store.get('ServiceRequest', viaFhir.json.id, { branch: pRun.branch }));
  const packet = await tool('business-office', P, pRun, 'ins_auth_questionnaire', { patient: p.id, services: [{ code: '70450' }], diagnoses: ['R51.9'] });
  assert.equal(packet.result.isError, false, JSON.stringify(packet));
  const hook = await s.call('POST', '/connect/v1/cds-services/coverage-requirements', { hook: 'order-select', hookInstance: 'h1', context: { patientId: p.id, selections: [], draftOrders: { resourceType: 'Bundle', entry: [] } } }, fhirHeaders(P, pRun, 5));
  assert.equal(hook.status, 200, hook.text); assert.ok(Array.isArray(hook.json.cards));

  // Keys are scoped: one agent's key cannot use another agent's run.
  assert.equal((await s.call('GET', `/connect/v1/fhir/Patient/${p.id}`, undefined, { ...R, 'X-Run-Id': pRun.runId })).status, 404);
  // The log shows the agent, not a person.
  const steps = await s.store.query('TraceStep', { groupKey: pRun.runId });
  assert.ok(steps.some((x) => x.who?.kind === 'agent' && x.who.id === 'proposer' && x.did?.type === 'fhir.create'));

  // Citations are checked when the run finishes: a true cited claim, an invented record, and an uncited claim.
  const fin = await s.call('POST', `/connect/v1/runs/${rRun.runId}/finish`, { summary: 'Reviewed.', claims: [{ text: 'Potassium is 6.9 mmol/L', cites: [`Observation/${k.id}`], value: 6.9, code: '2823-3' }, { text: 'Head CT policy has criteria', cites: ['PayerPolicy/head-imaging'] }, { text: 'Sodium is 120', cites: ['Observation/not-there'], value: 120 }, { text: 'She is allergic to latex', cites: [] }] }, R);
  assert.equal(fin.status, 200, fin.text);
  assert.deepEqual([fin.json.citations.claims, fin.json.citations.valid, fin.json.citations.uncited, fin.json.citations.passed], [4, 2, 1, false], JSON.stringify(fin.json.citations));
  assert.equal((await s.store.get('Run', rRun.runId)).result.citations.valid, 2, 'kept on the run');
  assert.equal((await s.call('GET', `/connect/v1/fhir/Patient/${p.id}`, undefined, { ...R, 'X-Run-Id': rRun.runId })).status, 409, 'a finished run takes nothing more');

  // Switched off again: the key stops working at once.
  await s.call('POST', '/agent-ops/agents/proposer/approve', { connectors: false }, res);
  assert.equal((await s.call('POST', '/connect/v1/runs', {}, P)).status, 403);
});
