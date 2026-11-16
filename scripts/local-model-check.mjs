// With LOCAL_MODEL_URL set (an OpenAI-compatible server on this machine, for example
// http://localhost:11434/v1) and LOCAL_MODEL_NAME, runs one case and the ready-made safety suite
// through the reference harness on a throwaway database, and prints what happened.
//   LOCAL_MODEL_URL=http://localhost:11434/v1 LOCAL_MODEL_NAME=my-model node scripts/local-model-check.mjs
import { startTestServer } from '../tests/support/helpers.mjs';
import { isLocalUrl } from '../agent-operations/server/models/endpoints.mjs';

const url = process.env.LOCAL_MODEL_URL; const model = process.env.LOCAL_MODEL_NAME;
if (!url || !model) { console.log('SKIPPED: set LOCAL_MODEL_URL and LOCAL_MODEL_NAME to run a local model through the reference harness.'); process.exit(0); }
if (!isLocalUrl(url)) { console.error('LOCAL_MODEL_URL must point at this machine (localhost).'); process.exit(2); }
const s = await startTestServer();
const res = { 'X-Role': 'researcher', 'X-User-Id': 'local-check' };
try {
  const made = await s.call('POST', '/agent-ops/agents', { id: 'local-model', name: `Local model ${model}`, version: '1', organisation: 'This machine', capability: 'clinical-workup', limits: { maxSteps: 12, timeoutMs: 600000 }, adapter: { kind: 'harness', provider: 'openai-compatible', baseUrl: url, model, maxTokens: 1024 } }, res);
  if (made.status !== 201) throw new Error(made.text);
  await s.call('POST', '/agent-ops/cases/load', {}, res);
  const bank = (await s.call('GET', '/agent-ops/cases')).json.cases;
  const out = await s.call('POST', '/agent-ops/rollouts', { agentId: 'local-model', caseId: bank[0].id, attempts: 1, seed: 0 }, res);
  const run = (await s.call('GET', '/agent-ops/runs', undefined, res)).json.runs.find((r) => r.agentId === 'local-model' && r.caseId === bank[0].id);
  console.log(JSON.stringify({ case: bank[0].title, status: run?.status, score: out.json?.best ?? null, summary: run?.result?.summary?.slice(0, 200), record: run?.record }, null, 1));
  const suite = await s.call('POST', '/agent-ops/red-team/tests/suite', { agentId: 'local-model', suite: 'safety-suite', variants: 1 }, res);
  console.log(JSON.stringify(suite.status === 201 ? { safetySuite: { passed: suite.json.passed, tests: suite.json.tests, failed: suite.json.failed, byFamily: suite.json.byFamily } } : { safetySuite: suite.text }, null, 1));
} finally { await s.close(); }
