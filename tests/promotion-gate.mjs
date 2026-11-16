// The promotion gate (§9c): shadow agreement AND a passing red-team run,
// both enforced by the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKEND } from './support/helpers.mjs';
import { agentSetup } from './support/agents.mjs';

const promote = (s, headers) => s.call('POST', '/agent-ops/agents/report-drafter/promote', {}, headers);
const evidence = async (s) => (await s.call('GET', '/agent-ops/agents/report-drafter/promotion')).json;
const hitlRun = (s) => s.call('POST', '/agent-ops/runs', { mode: 'hitl', agentId: 'report-drafter' });

test(`[${BACKEND}] the gate defaults to 85% agreement over 50 cases; the red-team requirement cannot be switched off`, async () => {
  const { s } = await agentSetup();
  const gate = (await s.call('GET', '/agent-ops/gate')).json;
  assert.deepEqual([gate.minAgreement, gate.minCases, gate.requireRedTeam], [0.85, 50, true]);
  assert.equal((await s.call('PUT', '/agent-ops/gate', { minAgreement: 0.9, minCases: 10, requireRedTeam: false })).status, 422);
  assert.equal((await s.call('PUT', '/agent-ops/gate', { minAgreement: 1.5, minCases: 10 })).status, 422);
  assert.equal((await s.call('PUT', '/agent-ops/gate', { minAgreement: 0.9, minCases: 0 })).status, 422);
  const set = await s.call('PUT', '/agent-ops/gate', { minAgreement: 0.9, minCases: 10 });
  assert.deepEqual([set.status, set.json.minAgreement, set.json.minCases, set.json.requireRedTeam], [200, 0.9, 10, true]);
  const logged = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.filter((t) => t.did.type === 'gate.configure');
  assert.deepEqual(logged.map((t) => t.did.args.to), [{ minAgreement: 0.9, minCases: 10 }]);
  assert.equal((await s.call('GET', '/fhir/R4/AuditEvent')).json.entry.filter((e) => /^promotion gate set/.test(e.resource.outcomeDesc)).length, 1);
  await s.close();
});

test(`[${BACKEND}] with no evidence a version cannot be promoted, and cannot propose on the live chart`, async () => {
  const { s } = await agentSetup();
  const before = await evidence(s);
  assert.deepEqual([before.eligible, before.promoted, before.shadow.ok, before.redTeam.ok, before.blockers.length], [false, false, false, false, 3]);
  const refused = await promote(s);
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /at least 50 are required/);
  assert.match(refused.json.error, /no red-team run exists/);
  const agent = (await s.call('GET', '/agent-ops/agents/report-drafter')).json;
  assert.deepEqual([agent.stage, agent.promotedVersion], ['shadow', null]);
  const run = await hitlRun(s);
  assert.equal(run.status, 403, 'the run itself is refused, whatever the UI does');
  assert.match(run.json.error, /has not been promoted/);
  const steps = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.filter((t) => t.did.type === 'promotion.refused');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].did.args.blockers.length, 3);
  assert.equal((await s.call('GET', '/fhir/R4/AuditEvent')).json.entry.filter((e) => e.resource.outcome === '4' && /^promotion refused/.test(e.resource.outcomeDesc)).length, 1);
  await s.close();
});

test(`[${BACKEND}] shadow agreement alone is not enough: a passing red-team run is required`, async () => {
  const { s, gate, shadowCase, redTeam } = await agentSetup();
  await gate(0.75, 4);
  for (let i = 0; i < 4; i += 1) await shadowCase(true);
  let e = await evidence(s);
  assert.deepEqual([e.shadow.compared, e.shadow.agreementRate, e.shadow.ok, e.redTeam.ok, e.eligible], [4, 1, true, false, false]);
  assert.deepEqual(e.blockers, ['Red team: no red-team run exists for this version']);
  assert.equal((await promote(s)).status, 409);

  await redTeam('report-drafter', '1.2.0', false);
  e = await evidence(s);
  assert.deepEqual(e.blockers, ['Red team: the most recent full red-team run for this version did not pass']);
  assert.equal((await promote(s)).status, 409);

  await redTeam('report-drafter', '0.9.0', true);
  await redTeam('inbox-triager', '1.1.0', true);
  assert.equal((await promote(s)).status, 409, 'a pass for another version or another agent does not count');

  const pass = await redTeam('report-drafter', '1.2.0', true);
  e = await evidence(s);
  assert.deepEqual([e.eligible, e.redTeam.runId, e.redTeam.passed], [true, pass.id, true]);
  const ok = await promote(s);
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.json.stage, ok.json.promotedVersion], ['hitl', '1.2.0']);
  const record = ok.json.promotions.at(-1);
  assert.deepEqual([record.action, record.by, record.evidence.shadow.compared, record.evidence.redTeam.runId, record.evidence.gate.minCases], ['promoted', 'physician', 4, pass.id, 4]);
  assert.equal((await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.filter((t) => t.did.type === 'agent.promote').length, 1);

  await redTeam('report-drafter', '1.2.0', false);
  assert.equal((await evidence(s)).eligible, false, 'a later failed red-team run makes the version ineligible again');
  await s.close();
});

test(`[${BACKEND}] a red-team pass alone is not enough: agreement and case count must both meet the gate`, async () => {
  const { s, gate, shadowCase, redTeam } = await agentSetup();
  await redTeam('report-drafter', '1.2.0', true);
  await gate(0.75, 4);
  await shadowCase(true); await shadowCase(true); await shadowCase(false);
  let r = await promote(s);
  assert.equal(r.status, 409);
  assert.match(r.json.error, /3 cases compared with a clinician; at least 4 are required/);
  assert.match(r.json.error, /agreement is 66\.7%; at least 75% is required/);
  // The third case left an abnormal prior report, so the stub now flags the next study; a normal read by the clinician is a disagreement.
  await shadowCase(true);
  r = await promote(s);
  assert.equal(r.status, 409, '4 cases but only 50% agreement');
  assert.doesNotMatch(r.json.error, /cases compared/);
  await gate(0.5, 4);
  assert.equal((await promote(s)).status, 200, 'the same evidence passes a lower configured threshold');
  await s.close();
});

test(`[${BACKEND}] promotion unlocks the live chart for that exact version only`, async () => {
  const { s, promoteDrafter, redTeam } = await agentSetup();
  await promoteDrafter();
  const run = await hitlRun(s);
  assert.equal(run.status, 201);
  assert.deepEqual([run.json.mode, run.json.targetBranch, run.json.askFrequency], ['hitl', 'main', 'every-step']);
  assert.match(run.json.branch, /^shadow-/, 'the agent still drafts on a hidden staging branch');
  assert.equal((await s.call('POST', '/agent-ops/runs', { mode: 'hitl', agentId: 'inbox-triager' })).status, 403, 'promotion is per agent');

  const bumped = await s.call('PUT', '/agent-ops/agents/report-drafter', { version: '1.3.0' });
  assert.deepEqual([bumped.json.stage, bumped.json.promotedVersion], ['shadow', null]);
  assert.equal((await hitlRun(s)).status, 403, 'a new version starts again in shadow');
  const e = await evidence(s);
  assert.deepEqual([e.version, e.shadow.compared, e.redTeam.ok], ['1.3.0', 0, false], 'evidence does not carry over');
  await redTeam('report-drafter', '1.3.0', true);
  assert.equal((await promote(s)).status, 409, 'still needs its own shadow cases');
  assert.equal(bumped.json.promotions.length, 1, 'history is kept');
  await s.close();
});

test(`[${BACKEND}] promotion cannot be granted by editing the agent, by the agent itself, or by changing its policy`, async () => {
  const { s, promoteDrafter } = await agentSetup();
  const sneaky = await s.call('PUT', '/agent-ops/agents/report-drafter', { stage: 'hitl', promotedVersion: '1.2.0' });
  assert.deepEqual([sneaky.status, sneaky.json.stage, sneaky.json.promotedVersion], [200, 'shadow', null]);
  const fresh = await s.call('POST', '/agent-ops/agents', { id: 'pre-promoted', name: 'Pre', version: '1', stage: 'hitl', promotedVersion: '1', adapter: { kind: 'stub', stub: 'report-drafter' }, scopes: [{ type: 'DiagnosticReport', interactions: ['create'] }] });
  assert.equal(fresh.json.stage, 'shadow');
  assert.equal((await s.call('POST', '/agent-ops/runs', { mode: 'hitl', agentId: 'pre-promoted' })).status, 403);

  const sandbox = (await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'report-drafter' })).json;
  const asAgent = { 'X-Agent-Id': 'report-drafter', 'X-Run-Id': sandbox.id, 'Idempotency-Key': 'promote-1' };
  assert.equal((await promote(s, asAgent)).status, 403);
  assert.equal((await s.call('PUT', '/agent-ops/gate', { minAgreement: 0, minCases: 1 }, asAgent)).status, 403);

  await promoteDrafter();
  const repoliced = await s.call('PUT', '/agent-ops/agents/report-drafter', { policyHash: 'ffffffffffffffff' });
  assert.equal(repoliced.json.stage, 'shadow', 'a changed policy hash is a different agent as far as the gate is concerned');
  await s.close();
});

test(`[${BACKEND}] demotion returns an agent to shadow and is audited`, async () => {
  const { s, promoteDrafter } = await agentSetup();
  await promoteDrafter();
  const kept = await s.call('PUT', '/agent-ops/agents/report-drafter', { hitl: { auto: true, askFrequency: 'orders-signing' } });
  assert.deepEqual([kept.json.stage, kept.json.hitl.auto, kept.json.hitl.askFrequency], ['hitl', true, 'orders-signing'], 'settings changes keep the promotion');
  const down = await s.call('POST', '/agent-ops/agents/report-drafter/demote', { reason: 'Too many edits' });
  assert.deepEqual([down.json.stage, down.json.promotions.at(-1).action, down.json.promotions.at(-1).reason], ['shadow', 'demoted', 'Too many edits']);
  assert.equal((await hitlRun(s)).status, 403);
  assert.equal((await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.filter((t) => t.did.type === 'agent.demote').length, 1);
  await s.close();
});
