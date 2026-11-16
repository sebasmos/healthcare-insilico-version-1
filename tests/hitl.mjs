// Evaluate → Human in the loop (§9c): proposals, accept / edit / reject,
// ask-frequency, planted-error tests and the HCI report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKEND } from './support/helpers.mjs';
import { agentSetup, rad } from './support/agents.mjs';
import { editDiff, levenshtein, needsAsk, plantError } from '../agent-operations/server/hitl.mjs';

const out = (task, name) => (task.output || []).find((o) => o.type?.text === name);
const launch = (s, agentId, body) => s.call('POST', `/agent-ops/agents/${agentId}/run`, { mode: 'hitl', practice: true, ...body });
async function practice(ctx, body = {}) {
  const st = body.subject ? null : await ctx.study(body.reason || 'Cough');
  const { reason, ...rest } = body;
  const r = await launch(ctx.s, 'report-drafter', { subject: `ImagingStudy/${st?.id}`, ...rest });
  assert.equal(r.status, 201, r.text);
  return { run: r.json, st, T: r.json.targetBranch };
}

test('edit distance, ask rules and planted errors are deterministic', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  const d = editDiff({ a: 'No acute abnormality.', b: 'same' }, { a: 'No acute abnormality seen.', b: 'same' });
  assert.deepEqual([d.changed, d.size, Object.keys(d.fields), d.fields.a.distance], [true, 5, ['a'], 5]);
  assert.equal(editDiff({ a: 'x' }, { a: 'x' }).changed, false);
  const run = (askFrequency) => ({ askFrequency, confidenceThreshold: 0.6 });
  assert.deepEqual(['DiagnosticReport', 'Task'].map((t) => needsAsk(run('every-step'), 'report', t, 0.9)), [true, true]);
  assert.deepEqual([needsAsk(run('orders-signing'), 'report', 'DiagnosticReport', 0.9), needsAsk(run('orders-signing'), 'triage', 'Task', 0.1)], [true, false]);
  assert.deepEqual([needsAsk(run('low-confidence'), 'triage', 'Task', 0.7), needsAsk(run('low-confidence'), 'triage', 'Task', 0.5), needsAsk(run('low-confidence'), 'report', 'DiagnosticReport', null)], [false, true, true]);
  assert.match(plantError('report', { technique: 't', findings: 'f', impression: 'No acute abnormality.' }).impression, /pneumothorax/);
  assert.equal(plantError('report', { technique: 't', findings: 'f', impression: 'Left lower lobe pneumonia.' }).impression, 'No acute abnormality.');
  assert.equal(plantError('triage', { label: 'urgent', reply: 'x' }).label, 'low');
});

test(`[${BACKEND}] an unpromoted agent can be tried on a practice copy; its proposal waits for a clinician`, async () => {
  const ctx = await agentSetup();
  const { s, proposals, steps } = ctx;
  const { run, st, T } = await practice(ctx);
  assert.deepEqual([run.status, run.mode, run.askFrequency, run.awaitingDecision], ['awaiting-decision', 'hitl', 'every-step', true]);
  assert.match(T, /^sandbox-/);
  assert.match(run.branch, /^shadow-/);
  const cards = await proposals(T, `&subject=ImagingStudy/${st.id}`);
  assert.equal(cards.length, 1);
  const card = cards[0];
  assert.deepEqual([card.kind, card.status, card.agent.label, card.confidence, card.practice, card.plantedError], ['report', 'pending', 'Report Drafter v1.2.0', 0.3, true, undefined]);
  assert.match(card.content.impression, /No acute abnormality suggested/);
  assert.match(card.reasoning, /did not analyse the images/);
  assert.deepEqual(card.saw.resources.map((r) => r.name), ['Imaging study', 'Patient chart']);
  assert.match(card.saw.resources[0].summary, /DX Chest X-ray .* reason: Cough/);
  assert.equal(card.saw.branch, run.branch);

  assert.equal((await proposals('main')).length, 0, 'nothing on the live chart');
  assert.equal((await s.call('GET', '/fhir/R4/Task')).json.total, 0);
  assert.equal((await s.call('GET', `/fhir/R4/DiagnosticReport?_branch=${T}`)).json.total, 0, 'the draft is not a report until a clinician accepts it');
  const task = (await s.call('GET', `/fhir/R4/Task/${card.id}?_branch=${T}`)).json;
  assert.deepEqual([task.status, task.intent, task.code.coding[0].code, task.description], ['requested', 'proposal', 'agent-proposal', 'AI-drafted — not signed']);
  const trace = await steps(run.id);
  const made = trace.find((t) => t.did.type === 'proposal.create');
  assert.deepEqual([made.who.kind, made.who.approval.status, made.saw.branch], ['agent', 'proposed', T]);
  await s.close();
});

test(`[${BACKEND}] accept: the clinician signs the content; Task, Provenance and the trace record who did what`, async () => {
  const ctx = await agentSetup();
  const { s, clock, proposals, decide, steps } = ctx;
  const { run, st, T } = await practice(ctx);
  const [card] = await proposals(T);
  assert.equal((await s.call('POST', `/agent-ops/proposals/${card.id}/seen?_branch=${T}`, {}, rad)).json.first, true);
  assert.equal((await s.call('POST', `/agent-ops/proposals/${card.id}/seen?_branch=${T}`, {}, rad)).json.first, false);
  clock.advance(42_000);
  assert.equal((await decide('main', card.id, { decision: 'accept' })).status, 404, 'a proposal is decided on the branch it lives on');
  const done = await decide(T, card.id, { decision: 'accept' });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual([done.json.decision, done.json.decisionSeconds, done.json.plantedError, done.json.edit], ['accepted', 42, false, null]);

  const report = (await s.call('GET', `/fhir/R4/${done.json.result}?_branch=${T}`)).json;
  assert.deepEqual([report.status, report.resultsInterpreter[0].display, report.conclusion, report.imagingStudy[0].reference], ['final', 'dr-reader', card.content.impression, `ImagingStudy/${st.id}`]);
  assert.equal((await s.store.get('DiagnosticReport', report.id, { branch: T }))._updatedBy, 'physician', 'written by the clinician, not the agent');
  assert.ok(report.issued);
  const prov = (await s.call('GET', `/fhir/R4/${done.json.provenance}?_branch=${T}`)).json;
  assert.deepEqual(prov.agent.map((a) => [a.type.text, a.who.identifier.value]), [['author', 'report-drafter'], ['verifier', 'dr-reader']]);
  assert.equal(prov.target[0].reference, `${done.json.result}/_history/${report.meta.versionId}`);
  const task = (await s.call('GET', `/fhir/R4/Task/${card.id}?_branch=${T}`)).json;
  assert.deepEqual([task.status, out(task, 'decision').valueString, out(task, 'decided-by').valueString, out(task, 'result').valueString, out(task, 'timed-from').valueString], ['completed', 'accepted', 'dr-reader', done.json.result, 'first-view']);
  const inbox = (await s.call('GET', `/fhir/R4/Task?_branch=${T}`)).json.entry.map((e) => e.resource.code.coding[0].code).sort();
  assert.deepEqual(inbox, ['agent-proposal', 'report-signed'], 'signing notified the Inbox as usual');

  const ended = (await s.call('GET', `/agent-ops/runs/${run.id}`)).json;
  assert.equal(ended.status, 'completed');
  const trace = await steps(run.id);
  assert.deepEqual(trace.map((t) => t.did.type).filter((x) => x.startsWith('proposal.') || x.startsWith('run.')), ['run.start', 'proposal.create', 'proposal.view', 'proposal.accept', 'run.end']);
  const accept = trace.find((t) => t.did.type === 'proposal.accept');
  assert.deepEqual([accept.who.kind, accept.who.id, accept.who.approval.status], ['human', 'dr-reader', 'approved']);
  assert.ok(trace.some((t) => t.did.type === 'fhir.transition' && t.who.kind === 'human' && t.did.args.to === 'final'), 'the signing step belongs to the clinician');
  assert.equal((await decide(T, card.id, { decision: 'accept' })).status, 409, 'a proposal is decided once');
  assert.equal((await s.call('GET', '/fhir/R4/DiagnosticReport')).json.total, 0, 'main is untouched by a practice run');
  await s.close();
});

test(`[${BACKEND}] edit: the tracked diff is stored on the Task; an unchanged edit counts as accept`, async () => {
  const ctx = await agentSetup();
  const { s, proposals, decide, steps } = ctx;
  const { run, T } = await practice(ctx);
  const [card] = await proposals(T);
  const edited = await decide(T, card.id, { decision: 'edit', content: { impression: 'No acute cardiopulmonary abnormality.' } });
  assert.equal(edited.status, 200, edited.text);
  assert.deepEqual([edited.json.decision, Object.keys(edited.json.edit.fields)], ['edited', ['impression']]);
  assert.ok(edited.json.edit.size > 10 && edited.json.edit.ratio > 0);
  const task = (await s.call('GET', `/fhir/R4/Task/${card.id}?_branch=${T}`)).json;
  const diff = JSON.parse(out(task, 'edit-diff').valueString);
  assert.deepEqual([diff.fields.impression.from, diff.fields.impression.to], [card.content.impression, 'No acute cardiopulmonary abnormality.']);
  const report = (await s.call('GET', `/fhir/R4/${edited.json.result}?_branch=${T}`)).json;
  assert.deepEqual([report.status, report.conclusion], ['final', 'No acute cardiopulmonary abnormality.']);
  assert.equal(report.extension.find((e) => e.url === 'urn:hospital-desktop:report-findings').valueString, card.content.findings, 'untouched sections keep the proposed text');
  const step = (await steps(run.id)).find((t) => t.did.type === 'proposal.edit');
  assert.deepEqual([step.who.approval.status, Object.keys(step.who.approval.diff)], ['edited', ['impression']]);
  assert.match((await s.call('GET', `/fhir/R4/${edited.json.provenance}?_branch=${T}`)).json.activity.text, /edited and signed by a clinician/);

  const second = await practice(ctx);
  const [card2] = await proposals(second.T);
  const same = await decide(second.T, card2.id, { decision: 'edit', content: { impression: card2.content.impression } });
  assert.deepEqual([same.json.decision, same.json.edit], ['accepted', null]);
  const blank = await practice(ctx);
  const [card3] = await proposals(blank.T);
  assert.equal((await decide(blank.T, card3.id, { decision: 'edit', content: { impression: '' } })).status, 422, 'the report rules still apply: an empty impression cannot be signed');
  assert.equal((await proposals(blank.T))[0].status, 'pending', 'a failed decision changes nothing');
  await s.close();
});

test(`[${BACKEND}] reject needs a reason and writes nothing clinical`, async () => {
  const ctx = await agentSetup();
  const { s, proposals, decide, steps } = ctx;
  const { run, T } = await practice(ctx);
  const [card] = await proposals(T);
  assert.equal((await decide(T, card.id, { decision: 'reject' })).status, 422);
  assert.equal((await decide(T, card.id, { decision: 'reject', reason: 'no' })).status, 422);
  assert.equal((await decide(T, card.id, { decision: 'maybe' })).status, 422);
  const sandbox = (await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'report-drafter' })).json;
  assert.equal((await decide(T, card.id, { decision: 'accept' }, { 'X-Agent-Id': 'report-drafter', 'X-Run-Id': sandbox.id, 'Idempotency-Key': 'self-accept' })).status, 403, 'an agent cannot accept its own proposal');
  const no = await decide(T, card.id, { decision: 'reject', reason: 'Misses the left effusion' });
  assert.deepEqual([no.status, no.json.decision, no.json.result, no.json.provenance], [200, 'rejected', null, null]);
  const task = (await s.call('GET', `/fhir/R4/Task/${card.id}?_branch=${T}`)).json;
  assert.deepEqual([task.status, out(task, 'reason').valueString], ['rejected', 'Misses the left effusion']);
  assert.equal((await s.call('GET', `/fhir/R4/DiagnosticReport?_branch=${T}`)).json.total, 0);
  assert.equal((await s.call('GET', `/fhir/R4/Provenance?_branch=${T}`)).json.total, 0);
  const step = (await steps(run.id)).find((t) => t.did.type === 'proposal.reject');
  assert.deepEqual([step.why, step.who.approval.status], ['Misses the left effusion', 'rejected']);
  assert.equal((await s.call('GET', `/agent-ops/runs/${run.id}`)).json.status, 'completed');
  await s.close();
});

test(`[${BACKEND}] ask-frequency: fewer asks apply the draft unsigned and clearly marked, never signed or released`, async () => {
  const ctx = await agentSetup();
  const { s, message, proposals } = ctx;
  const urgent = await message('I have chest pain today.');
  const routine = await message('When is the clinic open?');
  const triage = async (subject, body) => (await launch(s, 'inbox-triager', { subject: `Communication/${subject.id}`, ...body })).json;

  const quiet = await triage(urgent, { askFrequency: 'orders-signing' });
  assert.equal(quiet.status, 'completed', 'nothing to wait for');
  const [auto] = await proposals(quiet.targetBranch);
  assert.deepEqual([auto.status, auto.kind, auto.content.label], ['auto-applied', 'triage', 'urgent']);
  const label = (await s.call('GET', `/fhir/R4/${auto.result}?_branch=${quiet.targetBranch}`)).json;
  assert.deepEqual([label.intent, label.status, label.output[0].valueString, label.description], ['proposal', 'requested', 'urgent', 'AI label, not confirmed: urgent']);
  assert.equal(label.extension.find((e) => e.url === 'urn:hospital-desktop:ai-drafted').valueString, quiet.id);
  assert.equal((await s.call('GET', `/fhir/R4/Communication?_branch=${quiet.targetBranch}`)).json.total, 2, 'no reply was sent to the patient without a clinician');

  assert.equal((await triage(urgent, { askFrequency: 'low-confidence' })).status, 'completed', 'confident: applied without asking');
  assert.equal((await triage(routine, { askFrequency: 'low-confidence' })).status, 'awaiting-decision', 'not confident: asks');
  assert.equal((await triage(urgent, { askFrequency: 'every-step' })).status, 'awaiting-decision');
  assert.equal((await launch(s, 'inbox-triager', { subject: `Communication/${urgent.id}`, askFrequency: 'sometimes' })).status, 422);

  const signing = await practice(ctx, { askFrequency: 'orders-signing' });
  assert.equal(signing.run.status, 'awaiting-decision', 'a report is a signing step, so it always asks under this setting');
  const lowBar = await practice(ctx, { askFrequency: 'low-confidence', confidenceThreshold: 0.2 });
  assert.equal(lowBar.run.status, 'completed');
  const [applied] = await proposals(lowBar.T);
  const draft = await s.store.get('DiagnosticReport', applied.result.split('/')[1], { branch: lowBar.T });
  assert.deepEqual([draft.status, Boolean(draft._released), draft._updatedBy, draft.resultsInterpreter], ['preliminary', false, 'agent', undefined], 'applied drafts stay unsigned');
  assert.equal(draft.extension.find((e) => e.url === 'urn:hospital-desktop:ai-drafted').valueString, lowBar.run.id);
  const step = (await ctx.steps(lowBar.run.id)).find((t) => t.did.type === 'proposal.auto-apply');
  assert.deepEqual([step.who.kind, step.who.approval.status, step.did.args.askFrequency], ['agent', 'auto-applied', 'low-confidence']);
  await s.close();
});

test(`[${BACKEND}] accepting a triage proposal records the label and sends the reply as the clinician`, async () => {
  const ctx = await agentSetup();
  const { s, message, proposals, decide } = ctx;
  const msg = await message('I have chest pain today.');
  const run = (await launch(s, 'inbox-triager', { subject: `Communication/${msg.id}` })).json;
  const T = run.targetBranch;
  const [card] = await proposals(T);
  assert.match(card.saw.resources[0].summary, /Question: I have chest pain today\./);
  const done = await decide(T, card.id, { decision: 'edit', content: { reply: 'Please call the clinic now on the number on your card.' } }, { 'X-Role': 'nurse', 'X-User-Id': 'nurse-one' });
  assert.equal(done.status, 200, done.text);
  const label = (await s.call('GET', `/fhir/R4/${done.json.result}?_branch=${T}`)).json;
  assert.deepEqual([label.status, label.intent, label.output[0].valueString, label.requester.display], ['completed', 'order', 'urgent', 'nurse-one']);
  const thread = (await s.call('GET', `/fhir/R4/Communication?_branch=${T}`)).json.entry.map((e) => e.resource);
  const reply = thread.find((c) => c.inResponseTo);
  assert.deepEqual([reply.sender.display, reply.payload[0].contentString, reply.inResponseTo[0].reference], ['nurse-one', 'Please call the clinic now on the number on your card.', `Communication/${msg.id}`]);
  assert.equal((await s.call('GET', '/fhir/R4/Communication')).json.total, 1, 'main still has only the patient message');
  await s.close();
});

test(`[${BACKEND}] planted errors: sandbox only, synthetic patients only, and never revealed before the decision`, async () => {
  const ctx = await agentSetup();
  const { s, p, study, proposals, decide, promoteDrafter } = ctx;
  const st = await study('Cough');
  const subject = `ImagingStudy/${st.id}`;
  assert.equal((await launch(s, 'report-drafter', { subject, probe: true })).status, 422, 'needs the synthetic-patient confirmation');
  await promoteDrafter();
  const onMain = await s.call('POST', '/agent-ops/agents/report-drafter/run', { mode: 'hitl', subject, probe: true, syntheticAttested: true });
  assert.equal(onMain.status, 403, 'never on the live chart, even for a promoted agent');
  assert.equal((await s.call('POST', '/agent-ops/runs', { mode: 'hitl', agentId: 'report-drafter', probe: true })).status, 403, 'the run API refuses it too');

  const r = await launch(s, 'report-drafter', { subject, probe: true, syntheticAttested: true });
  assert.equal(r.status, 201, r.text);
  const T = r.json.targetBranch;
  const marked = (await s.call('GET', `/fhir/R4/Patient/${p.id}?_branch=${T}`)).json;
  assert.equal(marked.meta.security[0].code, 'HTEST');
  assert.equal((await s.call('GET', `/fhir/R4/Patient/${p.id}`)).json.meta.security, undefined, 'only the sandbox copy is marked');
  const [card] = await proposals(T);
  assert.match(card.content.impression, /Large right pneumothorax/);
  assert.equal(JSON.stringify(card).includes('planted'), false, 'the card does not say it is a test');
  assert.equal(JSON.stringify((await s.call('GET', `/fhir/R4/Task/${card.id}?_branch=${T}`)).json).toLowerCase().includes('probe'), false);
  const fell = await decide(T, card.id, { decision: 'accept' });
  assert.equal(fell.json.plantedError, true, 'the clinician is told afterwards');

  const second = await launch(s, 'report-drafter', { subject: `ImagingStudy/${(await study('Cough')).id}`, probe: true, syntheticAttested: true, askFrequency: 'low-confidence', confidenceThreshold: 0 });
  assert.equal(second.json.status, 'awaiting-decision', 'a planted error is never applied without asking');
  const [card2] = await proposals(second.json.targetBranch);
  await decide(second.json.targetBranch, card2.id, { decision: 'reject', reason: 'There is no pneumothorax' });
  const bias = (await s.call('GET', '/agent-ops/hitl?agentId=report-drafter')).json.agents[0].automationBias;
  assert.deepEqual(bias, { planted: 2, decided: 2, acceptedUnchanged: 1, caught: 1, acceptedUnchangedRate: 0.5 });
  const attest = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.filter((t) => t.did.type === 'patient.attest-synthetic');
  assert.equal(attest.length, 2);
  await s.close();
});

test(`[${BACKEND}] a kill switch withdraws pending proposals`, async () => {
  const ctx = await agentSetup();
  const { s, proposals, decide } = ctx;
  const { run, T } = await practice(ctx);
  const stop = await s.call('POST', '/agent-ops/kill-switches', { scope: 'mode', target: 'hitl', engaged: true, reason: 'pause proposals' });
  assert.deepEqual(stop.json.stoppedRuns, [run.id]);
  const [card] = await proposals(T);
  assert.equal(card.status, 'withdrawn');
  assert.equal((await decide(T, card.id, { decision: 'accept' })).status, 409);
  assert.equal((await launch(s, 'report-drafter', { subject: run.subject })).status, 403);
  await s.call('POST', '/agent-ops/kill-switches', { scope: 'mode', target: 'hitl', engaged: false });
  assert.equal((await decide(T, card.id, { decision: 'accept' })).status, 409, 'a withdrawn proposal stays withdrawn');
  assert.equal((await s.call('GET', `/fhir/R4/DiagnosticReport?_branch=${T}`)).json.total, 0);
  await s.close();
});

test(`[${BACKEND}] live chart: a promoted agent proposes when the clinician opens the study, instead of shadowing`, async () => {
  const ctx = await agentSetup();
  const { s, p, study, open, proposals, decide, promoteDrafter, steps } = ctx;
  await promoteDrafter();
  const quiet = await study('Cough');
  await open(quiet);
  let runs = (await s.call('GET', '/agent-ops/runs')).json.runs;
  assert.equal(runs.filter((r) => r.mode === 'hitl').length, 0, 'promotion alone does not switch live proposals on');
  await s.call('PUT', '/agent-ops/agents/report-drafter', { hitl: { auto: true, askFrequency: 'every-step' } });
  const st = await study('Follow-up of nodule');
  await open(st);
  await open(st);
  runs = (await s.call('GET', '/agent-ops/runs')).json.runs;
  const live = runs.filter((r) => r.mode === 'hitl');
  assert.equal(live.length, 1, 'one proposal run per study');
  assert.deepEqual([live[0].targetBranch, live[0].status, live[0].trigger.kind], ['main', 'awaiting-decision', 'study-open']);
  assert.equal(runs.filter((r) => r.mode === 'shadow-task' && r.subject === `ImagingStudy/${st.id}`).length, 0, 'no shadow run for a study the clinician is being prompted on');

  const [card] = await proposals('main', `&subject=ImagingStudy/${st.id}`);
  assert.deepEqual([card.status, card.practice], ['pending', false]);
  assert.equal((await s.call('GET', `/fhir/R4/DiagnosticReport?patient=${p.id}&status=preliminary`)).json.total, 0, 'still no report on main');
  const done = await decide('main', card.id, { decision: 'accept' });
  assert.equal(done.status, 200, done.text);
  const tasks = (await s.call('GET', '/fhir/R4/Task')).json.entry.map((e) => e.resource);
  assert.ok(tasks.some((t) => t.id === card.id && t.status === 'completed'));
  const prov = (await s.call('GET', '/fhir/R4/Provenance')).json.entry.map((e) => e.resource);
  assert.equal(prov.length, 1);
  assert.equal(prov[0].agent[1].who.identifier.value, 'dr-reader');
  const trace = await steps(live[0].id);
  assert.ok(trace.length >= 8);
  assert.ok(trace.every((t) => t.runId === live[0].id));
  assert.equal(trace.at(-1).did.type, 'run.end');
  assert.equal((await s.call('GET', `/api/pacs/worklist?queue=all`)).json.rows.find((r) => r.id === st.id).status, 'read');
  await s.close();
});

test(`[${BACKEND}] HCI report: acceptance, edit size, decision time and asks per case`, async () => {
  const ctx = await agentSetup();
  const { s, clock, proposals, decide } = ctx;
  const one = async (seconds, body) => {
    const { T } = await practice(ctx);
    const [card] = await proposals(T);
    clock.advance(seconds * 1000);
    assert.equal((await decide(T, card.id, body)).status, 200);
  };
  await one(10, { decision: 'accept' });
  await one(30, { decision: 'edit', content: { impression: 'No acute abnormality.' } });
  await one(50, { decision: 'reject', reason: 'Wrong side' });
  await one(20, { decision: 'accept' });
  await practice(ctx);
  await practice(ctx, { askFrequency: 'low-confidence', confidenceThreshold: 0.1 });
  const report = (await s.call('GET', '/agent-ops/hitl')).json;
  assert.match(report.note, /not whether the agent was right/);
  const g = report.agents[0];
  assert.deepEqual([g.agentId, g.version, g.live.cases, g.live.proposals], ['report-drafter', '1.2.0', 0, 0]);
  const m = g.practice;
  assert.deepEqual([m.cases, m.proposals, m.asks, m.autoApplied, m.pending, m.decided, m.accepted, m.edited, m.rejected], [6, 6, 5, 1, 1, 4, 2, 1, 1]);
  assert.deepEqual([m.acceptanceRate, m.acceptedUnchangedRate, m.rejectionRate, m.medianDecisionSeconds, m.asksPerCase], [0.75, 0.5, 0.25, 25, 0.83]);
  assert.ok(m.meanEditSize > 0 && m.meanEditRatio > 0 && m.meanEditRatio < 1);
  assert.equal(g.proposals.length, 6);
  assert.equal(g.automationBias.planted, 0);
  await s.close();
});
