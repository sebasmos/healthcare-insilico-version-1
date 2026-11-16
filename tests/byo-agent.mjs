// Bring your own agent or model: the reference harness on a fake local
// endpoint, the data rules for cloud endpoints, keys never shown, the record on every run, a fake
// outside agent client on the environment API, and the AI feature switches.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, patient, BACKEND } from './support/helpers.mjs';
import { normalizeEndpoint, isLocalUrl, buildRequest, parseResponse } from '../agent-operations/server/models/endpoints.mjs';
import { runReferenceHarness, harnessTools, HARNESS } from '../agent-operations/server/harness.mjs';
import { normalizePermissions, narrowTo } from '../agent-operations/server/permissions.mjs';
import { runExampleAgent } from '../clients/js/example-agent.mjs';

process.env.ENV_API_ENABLED = 'true';
const res = { 'X-Role': 'researcher', 'X-User-Id': 'res-one' };

/** A fake local model server speaking chat-completions. `script(body, n)` returns the assistant message for call n. */
async function fakeModel(script) {
  const seen = [];
  const server = http.createServer((req, r) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => { const body = JSON.parse(raw || '{}'); seen.push({ url: req.url, auth: req.headers.authorization || null, body }); const message = script(body, seen.length); r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ model: 'fake-local-1.2', choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 20 } })); }); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => new Promise((ok) => server.close(ok)) };
}
const call = (name, args, id = `c-${name}`) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

test('endpoints: local means this machine; each provider gets its own wire format and the same neutral answer comes back', () => {
  for (const u of ['http://localhost:11434/v1', 'http://127.0.0.1:8080', 'http://[::1]:1234/v1']) assert.equal(isLocalUrl(u), true, u);
  for (const u of ['https://api.openai.com/v1', 'http://192.168.1.4:8080', 'http://localhost.example.com', 'nonsense']) assert.equal(isLocalUrl(u), false, u);
  assert.throws(() => normalizeEndpoint({ provider: 'other', model: 'x' }), /provider must be one of/);
  assert.throws(() => normalizeEndpoint({ provider: 'openai', model: '' }), /model/);
  assert.throws(() => normalizeEndpoint({ provider: 'openai', model: 'm', keyEnv: 'sk-a-real-looking-key' }), /NAME of an environment variable/);
  assert.deepEqual(normalizeEndpoint({ provider: 'google', model: 'g-1' }), { provider: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'g-1', keyEnv: 'GOOGLE_API_KEY', local: false });
  const request = { system: 'S', tools: [{ name: 'read', description: 'd', parameters: { type: 'object', properties: {} } }], messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'read', args: { type: 'Patient', id: '1' } }] }, { role: 'tool', toolCallId: 't1', name: 'read', content: '{"id":"1"}' }] };
  const oa = buildRequest(normalizeEndpoint({ provider: 'openai', model: 'm' }), request, 'KEY');
  assert.equal(oa.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(oa.headers.Authorization, 'Bearer KEY');
  assert.deepEqual(oa.body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(oa.body.messages[3].tool_call_id, 't1');
  const an = buildRequest(normalizeEndpoint({ provider: 'anthropic', model: 'm' }), request, 'KEY');
  assert.equal(an.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(an.headers['x-api-key'], 'KEY');
  assert.equal(an.body.system, 'S');
  assert.deepEqual(an.body.messages.map((m) => [m.role, m.content[0].type]), [['user', 'text'], ['assistant', 'tool_use'], ['user', 'tool_result']]);
  assert.equal(an.body.tools[0].input_schema.type, 'object');
  const go = buildRequest(normalizeEndpoint({ provider: 'google', model: 'g-1' }), request, 'KEY');
  assert.match(go.url, /\/models\/g-1:generateContent$/);
  assert.deepEqual(go.body.contents.map((c) => [c.role, Object.keys(c.parts[0])[0]]), [['user', 'text'], ['model', 'functionCall'], ['user', 'functionResponse']]);
  assert.deepEqual(go.body.contents[2].parts[0].functionResponse.response, { id: '1' });
  const want = [{ name: 'read', args: { type: 'Patient', id: '1' } }];
  const strip = (r) => r.toolCalls.map(({ name, args }) => ({ name, args }));
  assert.deepEqual(strip(parseResponse({ provider: 'openai' }, { choices: [{ message: { tool_calls: [{ id: 'a', function: { name: 'read', arguments: '{"type":"Patient","id":"1"}' } }] } }], usage: { prompt_tokens: 3, completion_tokens: 4 } })), want);
  assert.deepEqual(strip(parseResponse({ provider: 'anthropic' }, { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'a', name: 'read', input: { type: 'Patient', id: '1' } }], usage: { input_tokens: 3, output_tokens: 4 } })), want);
  const g = parseResponse({ provider: 'google' }, { candidates: [{ content: { parts: [{ functionCall: { name: 'read', args: { type: 'Patient', id: '1' } } }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 }, modelVersion: 'g-1-001' });
  assert.deepEqual([strip(g), g.usage, g.model], [want, { promptTokens: 3, completionTokens: 4 }, 'g-1-001']);
});

test('the reference harness: briefing in, tool calls through the run tools, finish out; errors go back to the model; the step limit holds', async () => {
  const log = [];
  const tools = { call: async (name, args) => { log.push([name, args.type ?? args.resource?.resourceType]); if (name === 'read' && args.id === 'missing') { const e = new Error('Not found'); e.status = 404; throw e; } return name === 'create' ? { resourceType: 'ServiceRequest', id: 'sr-1' } : { resourceType: args.type, id: args.id }; } };
  const script = [{ toolCalls: [{ id: '1', name: 'read', args: { type: 'Patient', id: 'missing' } }] }, { toolCalls: [{ id: '2', name: 'create', args: { resource: { resourceType: 'ServiceRequest' } } }, { id: '3', name: 'delete-everything', args: {} }] }, { toolCalls: [{ id: '4', name: 'finish', args: { summary: 'Ordered a test', flags: [{ code: 'missing-data', detail: 'No labs' }, { nonsense: true }], confidence: 0.6 } }] }];
  const requests = [];
  const out = await runReferenceHarness({ briefing: { tools: [{ name: 'read' }, { name: 'create' }, { name: 'finish' }], patient: 'Patient/p1' }, task: { goal: 'Work up' }, tools, callModel: async (r) => { requests.push(JSON.parse(JSON.stringify(r))); return { ...script[requests.length - 1], usage: { promptTokens: 10, completionTokens: 5 } }; } });
  assert.deepEqual(log, [['read', 'Patient'], ['create', 'ServiceRequest']], 'an unknown tool never reaches the run tools');
  assert.deepEqual([out.output, out.summary, out.flags, out.confidence, out.endedBy, out.modelCalls], [['ServiceRequest/sr-1'], 'Ordered a test', [{ code: 'missing-data', detail: 'No labs' }], 0.6, 'finish', 3]);
  assert.deepEqual(out.usage, { promptTokens: 30, completionTokens: 15, reported: true });
  assert.equal(out.harness.id, 'reference');
  assert.match(requests[1].messages.at(-1).content, /Not found/, 'a tool error is told to the model');
  assert.match(requests[2].messages.at(-1).content, /Unknown tool ..delete-everything/);
  assert.match(requests[0].messages[0].content, /"patient": "Patient\/p1"/);
  assert.deepEqual(harnessTools({ tools: [{ name: 'read' }] }).map((t) => t.name), ['read', 'finish']);
  const loop = await runReferenceHarness({ briefing: {}, task: {}, tools, maxSteps: 3, callModel: async () => ({ toolCalls: [{ id: 'x', name: 'read', args: { type: 'Patient', id: '1' } }] }) });
  assert.deepEqual([loop.endedBy, loop.modelCalls, loop.usage.reported], ['step-limit', 3, false]);
  const plain = await runReferenceHarness({ briefing: {}, task: {}, tools, callModel: async () => ({ text: 'I would order a troponin.', toolCalls: [] }) });
  assert.deepEqual([plain.endedBy, plain.summary], ['no-tool-call', 'I would order a troponin.']);
});

test('permissions asked for at registration: per system, validated, and a grant can only narrow', () => {
  const asked = normalizePermissions({ systems: { ehr: 'read-write', pacs: 'read-only' }, recordTypes: ['ServiceRequest', 'bad type'], mustCite: true, rateLimit: 50 });
  assert.deepEqual([asked.systems.ehr, asked.systems.pacs, asked.systems.lab, asked.recordTypes, asked.mustCite], ['read-write', 'read-only', 'none', ['ServiceRequest'], true]);
  assert.throws(() => normalizePermissions({ systems: { toaster: 'read-only' } }), /Unknown system/);
  const granted = narrowTo(asked, { systems: { ehr: 'read-propose', pacs: 'read-write', lab: 'read-write' }, rateLimit: 500 });
  assert.deepEqual([granted.systems.ehr, granted.systems.pacs, granted.systems.lab, granted.rateLimit, granted.mustCite], ['read-propose', 'read-only', 'none', 50, true]);
});

test(`[${BACKEND}] a cloud endpoint: refused unless ALLOW_EXTERNAL_MODELS is true, and then only for a synthetic patient; refusals are logged and nothing is sent`, async () => {
  const s = await startTestServer();
  const model = await fakeModel(() => call('finish', { summary: 'done' }));
  // A cloud address that would fail if anything were sent: the refusals below happen before any call.
  await s.call('POST', '/agent-ops/agents', { id: 'cloud-model', name: 'Cloud model', version: '1', organisation: 'Example Lab', capability: 'clinical-workup', apiKey: 'k', adapter: { kind: 'harness', provider: 'anthropic', baseUrl: 'https://cloud.invalid/v1', model: 'some-model' } }, res);
  const real = (await s.call('POST', '/fhir/R4/Patient', patient('Zzreal'))).json;
  const start = (subject) => s.call('POST', '/agent-ops/agents/cloud-model/run', { mode: 'sandbox', subject, goal: 'Work up' }, res);
  delete process.env.ALLOW_EXTERNAL_MODELS;
  let run = (await start(`Patient/${real.id}`)).json;
  assert.equal(run.status, 'refused', JSON.stringify(run));
  assert.match(run.result.error, /ALLOW_EXTERNAL_MODELS is not true/);
  process.env.ALLOW_EXTERNAL_MODELS = 'true';
  run = (await start(`Patient/${real.id}`)).json;
  assert.equal(run.status, 'refused');
  assert.match(run.result.error, /not marked synthetic/);
  delete process.env.ALLOW_EXTERNAL_MODELS;
  const refusals = (await s.call('GET', `/agent-ops/trace?runId=${run.id}`, undefined, res)).json.steps.filter((x) => x.did.type === 'model.refuse');
  assert.equal(refusals.length, 1, 'the refusal is logged');
  assert.equal(model.seen.length, 0);
  // The same patient on a local endpoint is fine: nothing leaves the machine.
  await s.call('POST', '/agent-ops/agents', { id: 'local-model', name: 'Local model', version: '1', capability: 'clinical-workup', adapter: { kind: 'harness', provider: 'openai-compatible', baseUrl: model.url, model: 'm' } }, res);
  const local = (await s.call('POST', '/agent-ops/agents/local-model/run', { mode: 'sandbox', subject: `Patient/${real.id}`, goal: 'Work up' }, res)).json;
  assert.equal(local.status, 'completed', JSON.stringify(local.result));
  assert.equal(model.seen.length, 1);
  assert.equal(model.seen[0].auth, null, 'a local endpoint needs no key');
  await model.close(); await s.close();
});

test(`[${BACKEND}] AI features: defaults work offline; a feature can be switched off or filled by another agent; a research capability switched off leaves every run`, async () => {
  const s = await startTestServer();
  const first = (await s.call('GET', '/agent-ops/ai-features', undefined, res)).json;
  assert.deepEqual(first.catalogue.map((f) => f.id), ['draft-reply', 'chart-summary', 'ambient-note', 'chart-chat', 'draft-report']);
  assert.deepEqual(first.features['draft-reply'], { on: true, agentId: 'inbox-triager', permission: 'read-propose' });
  assert.deepEqual(first.researchCatalogue.map((c) => c.id), ['agent-may-ask', 'multi-step', 'autonomous-task', 'proactive-alerts', 'cross-app', 'long-horizon']);
  assert.equal((await s.call('PUT', '/agent-ops/ai-features', { features: { 'draft-reply': { on: false } } }, { 'X-Agent-Id': 'inbox-triager', 'X-Run-Id': 'live', 'Idempotency-Key': 'k1' })).status, 403);
  assert.equal((await s.call('PUT', '/agent-ops/ai-features', { features: { toaster: { on: true } } }, res)).status, 422);
  assert.equal((await s.call('PUT', '/agent-ops/ai-features', { features: { 'draft-reply': { agentId: 'nobody' } } }, res)).status, 422);
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Zzmsg', { meta: { security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }] } }))).json;
  const message = () => s.call('POST', '/fhir/R4/Communication', { resourceType: 'Communication', status: 'completed', subject: { reference: `Patient/${p.id}` }, sender: { reference: `Patient/${p.id}` }, sent: new Date().toISOString(), payload: [{ contentString: 'Could I have a refill please?' }] }, { 'X-Role': 'patient', 'X-User-Id': p.id });
  const triageRuns = async () => (await s.call('GET', '/agent-ops/runs', undefined, res)).json.runs.filter((r) => r.trigger?.kind === 'patient-message');
  const settle = async (n) => { for (let i = 0; i < 40; i += 1) { if ((await triageRuns()).filter((r) => r.status !== 'running').length >= n) return; await new Promise((r) => setTimeout(r, 100)); } };
  await s.call('PUT', '/agent-ops/agents/inbox-triager', { shadow: { event: true, task: false } }, res);
  assert.equal((await message()).status, 201);
  await settle(1);
  assert.deepEqual((await triageRuns()).map((r) => r.agentId), ['inbox-triager'], 'the built-in default fills the feature');
  // Off: nothing starts.
  const off = await s.call('PUT', '/agent-ops/ai-features', { features: { 'draft-reply': { on: false } } }, res);
  assert.equal(off.json.features['draft-reply'].on, false);
  await message(); await new Promise((r) => setTimeout(r, 400));
  assert.equal((await triageRuns()).length, 1, 'switched off: no new run');
  // Filled by a connected model instead of the built-in agent.
  const model = await fakeModel(() => call('finish', { summary: 'Routine refill request; a draft reply is not needed.' }));
  await s.call('POST', '/agent-ops/agents', { id: 'reply-model', name: 'Reply model', version: '1', organisation: 'Example Lab', capability: 'triage-message', adapter: { kind: 'harness', provider: 'openai-compatible', baseUrl: model.url, model: 'm' } }, res);
  await s.call('PUT', '/agent-ops/ai-features', { features: { 'draft-reply': { on: true, agentId: 'reply-model', permission: 'read-only' } } }, res);
  await message(); await settle(2);
  const after = await triageRuns();
  assert.deepEqual(after.map((r) => r.agentId).sort(), ['inbox-triager', 'reply-model']);
  const mine = after.find((r) => r.agentId === 'reply-model');
  assert.equal(mine.aiFeatures.features['draft-reply'], 'reply-model:read-only', 'the settings in force are on the run');
  assert.equal(mine.record.harness, 'reference');
  // A research capability switched off is taken out of every run's set.
  await s.call('PUT', '/agent-ops/ai-features', { research: { 'agent-may-ask': false } }, res);
  const run = (await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'workup-planner', condition: 'helper-that-asks' }, res)).json;
  assert.equal(run.capabilities.includes('agent-may-ask'), false);
  assert.deepEqual(run.aiFeatures.researchOff, ['agent-may-ask']);
  await model.close(); await s.close();
});
