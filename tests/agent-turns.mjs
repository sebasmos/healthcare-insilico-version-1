// Plan-master tasks 8 to 10: triggers and briefings, timeline release times,
// capabilities refused when off, conditions on runs, the Agent panel
// (requests, time-out, take over), in-place drafts and recordings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BACKEND, startTestServer, patient, testClock } from './support/helpers.mjs';
import { agentSetup } from './support/agents.mjs';
import { BUILTIN_CONDITIONS, toolsFor, approvalFor } from '../agent-operations/server/capabilities.mjs';
import { RUN_COLUMNS } from '../agent-operations/server/research.mjs';
import { interactionStats } from '../agent-operations/server/turns.mjs';

const doc = { 'X-Role': 'physician', 'X-User-Id': 'dr-one' };
const res = { 'X-Role': 'researcher', 'X-User-Id': 'Researcher One' };
const as = (agentId, run, extra = {}) => ({ 'X-Agent-Id': agentId, 'X-Run-Id': run.id, 'Idempotency-Key': randomUUID(), ...extra });
const task = () => ({ resourceType: 'Task', status: 'requested', intent: 'proposal', code: { text: 'Message triage' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { tries = 150, every = 40, last = null } = {}) { for (let i = 0; i < tries; i += 1) { const v = await fn(); if (v) return v; await sleep(every); } throw new Error(`condition not met in time${last ? `: ${JSON.stringify(await last()).slice(0, 600)}` : ''}`); }
const stepsOf = async (s, runId) => (await s.call('GET', `/agent-ops/trace?runId=${runId}`)).json.steps;

test('conditions, tools and approval text are deterministic', () => {
  assert.deepEqual(BUILTIN_CONDITIONS.map((c) => c.id), ['deployed-today', 'helper-that-asks', 'autonomous']);
  const deployed = { capabilities: BUILTIN_CONDITIONS[0].capabilities, askFrequency: 'orders-signing' };
  assert.ok(!toolsFor(deployed).some((t) => t.name === 'ask-clinician'), 'deployed today cannot ask');
  assert.ok(toolsFor({ capabilities: BUILTIN_CONDITIONS[1].capabilities }).some((t) => t.name === 'ask-clinician'));
  assert.ok(!toolsFor(deployed)[0].allowedResourceTypes.includes('MedicationDispense'), 'pharmacy records need cross-app');
  assert.ok(toolsFor({ capabilities: BUILTIN_CONDITIONS[2].capabilities })[0].allowedResourceTypes.includes('MedicationDispense'));
  assert.match(approvalFor(deployed), /Nothing you produce becomes final/);
  assert.match(approvalFor({ capabilities: ['agent-may-ask'], askFrequency: 'every-step' }), /ask before: every step/);
  const stats = interactionStats([{ did: { type: 'draft.shown', args: {} }, who: { kind: 'human' }, when: { wall: '2026-01-01T00:00:00Z' } }, { did: { type: 'draft.edited', args: { editSize: 12 } }, who: { kind: 'human' }, when: { wall: '2026-01-01T00:00:01Z' } }]);
  assert.deepEqual([stats.draftsShown, stats.draftsEdited, stats.editSize, stats.asks], [1, 1, 12, 0]);
});

test(`[${BACKEND}] every trigger starts a turn with a stored briefing; conditions are on the Run; research capabilities are refused when off`, async () => {
  const ctx = await agentSetup();
  const { s, p, study, open } = ctx;
  // Workflow event: a study is opened (task shadow). The briefing is on the step that starts the turn.
  const st = await study('Cough');
  await open(st);
  const shadow = (await s.call('GET', '/agent-ops/runs')).json.runs.find((r) => r.agentId === 'report-drafter' && r.subject === `ImagingStudy/${st.id}`);
  assert.ok(shadow, 'the study-open trigger started a run');
  const start = (await stepsOf(s, shadow.id)).find((x) => x.did.type === 'turn.start');
  assert.deepEqual([start.did.args.trigger, start.did.args.briefing.trigger.event, start.did.args.briefing.branch, start.did.args.briefing.subject], ['event', 'study-open', shadow.branch, `ImagingStudy/${st.id}`]);
  assert.ok(Array.isArray(start.did.args.briefing.tools) && start.did.args.briefing.tools.some((t) => t.name === 'read'));
  // Workflow event: a chart is opened; the Chart Summariser (switched on for events) drafts a summary that cites its records.
  assert.equal((await s.call('PUT', '/agent-ops/agents/chart-summariser', { shadow: { event: true, task: false } })).status, 200);
  assert.equal((await s.call('GET', `/fhir/R4/Patient/${p.id}/$everything`, undefined, doc)).status, 200);
  await s.agents.idle();
  const sum = (await s.call('GET', '/agent-ops/runs')).json.runs.find((r) => r.agentId === 'chart-summariser');
  assert.ok(sum && sum.condition === 'deployed-today' && sum.capabilities.includes('chart-summary'), 'the chart-open trigger started a deployed-today run');
  const sumStart = (await stepsOf(s, sum.id)).find((x) => x.did.type === 'turn.start');
  assert.equal(sumStart.did.args.briefing.trigger.event, 'chart-open');
  const summaries = await s.store.query('DocumentReference', { where: (d) => (d.type?.coding || []).some((c) => c.code === 'ai-summary') }, { branch: sum.branch });
  assert.equal(summaries.length, 1);
  assert.ok(summaries[0].context.related.some((r) => r.reference === `Patient/${p.id}`), 'the summary cites the records it used');
  // Assigned task: without autonomous-task, an assigned task is refused; the Autonomous condition allows it and stores the capabilities.
  const refused = await s.call('POST', '/agent-ops/agents/workup-planner/run', { mode: 'shadow-task', subject: `Patient/${p.id}`, goal: 'Work up this patient', condition: 'deployed-today' });
  assert.equal(refused.status, 403, refused.text);
  const auto = (await s.call('POST', '/agent-ops/agents/workup-planner/run', { mode: 'shadow-task', subject: `Patient/${p.id}`, goal: 'Work up this patient', condition: 'autonomous' })).json;
  assert.deepEqual([auto.condition, auto.clock, auto.capabilities.includes('autonomous-task')], ['autonomous', 'step', true]);
  const autoStart = (await stepsOf(s, auto.id)).find((x) => x.did.type === 'turn.start');
  assert.deepEqual([autoStart.did.args.trigger, autoStart.did.args.briefing.task.goal], ['task', 'Work up this patient']);
  // Direct agent writes under a narrow capability list: a second write in one turn, a pharmacy record and an alert are each refused on the server.
  const run = (await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'inbox-triager', subject: `Patient/${p.id}`, capabilities: ['draft-reply'] })).json;
  assert.deepEqual([run.condition, run.capabilities], ['custom', ['draft-reply']]);
  assert.equal((await s.call('POST', '/fhir/R4/Task', task(), as('inbox-triager', run))).status, 201);
  const second = await s.call('POST', '/fhir/R4/Task', task(), as('inbox-triager', run));
  assert.equal(second.status, 403, JSON.stringify((await s.call('GET', `/agent-ops/runs/${run.id}`)).json.turn)); assert.match(second.text, /multi-step/);
  const dispense = await s.call('GET', '/fhir/R4/MedicationDispense', undefined, as('inbox-triager', run));
  assert.equal(dispense.status, 403); assert.match(dispense.text, /cross-app/);
  const alert = await s.call('POST', '/fhir/R4/Flag', { resourceType: 'Flag', status: 'active', code: { text: 'x' }, subject: { reference: `Patient/${p.id}` } }, as('inbox-triager', run));
  assert.equal(alert.status, 403); assert.match(alert.text, /proactive-alerts|multi-step/);
  // Conditions are listed, custom ones can be made, built-ins cannot change, and runs are filterable by condition.
  const list = (await s.call('GET', '/agent-ops/conditions')).json.conditions;
  assert.deepEqual(list.slice(0, 3).map((c) => c.id), ['deployed-today', 'helper-that-asks', 'autonomous']);
  const custom = await s.call('POST', '/agent-ops/conditions', { name: 'Asks only', capabilities: ['draft-reply', 'agent-may-ask'] }, res);
  assert.equal(custom.status, 201, custom.text);
  assert.equal((await s.call('PUT', '/agent-ops/conditions/deployed-today', { capabilities: [] }, res)).status, 409);
  assert.equal((await s.call('POST', '/agent-ops/conditions', { name: 'Bad', capabilities: ['teleport'] }, res)).status, 422);
  const byCondition = (await s.call('GET', '/agent-ops/runs')).json.runs.filter((r) => r.condition === 'autonomous');
  assert.deepEqual(byCondition.map((r) => r.id), [auto.id]);
  await s.close();
});

test(`[${BACKEND}] timeline events appear at their times and never early in as-of reads; a scheduled check needs long-horizon`, async () => {
  const clock = testClock('2026-05-01T09:00:00.000Z');
  const s = await startTestServer({ clock });
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Timeline'))).json;
  const timeline = [
    { after: 3600, kind: 'observation', title: 'Creatinine rises', resource: { resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '2160-0', display: 'Creatinine' }] }, valueQuantity: { value: 3.1, unit: 'mg/dL' } } },
    { after: 7200, kind: 'check', goal: 'Review the chart two hours in' },
  ];
  const run = (await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', subject: `Patient/${p.id}`, timeline, capabilities: ['chart-chat'] }, doc)).json;
  assert.equal(run.timeline.length, 2);
  assert.equal(run.timeline[0].at, '2026-05-01T10:00:00.000Z');
  const search = (asOf) => s.call('GET', `/fhir/R4/Observation?patient=${p.id}&_branch=${run.branch}${asOf ? `&_asOf=${asOf}` : ''}`, undefined, doc);
  assert.equal((await s.call('POST', `/agent-ops/timeline/${run.id}/release`, {}, doc)).json.released.length, 0, 'nothing is due yet');
  assert.equal((await search()).json.total, 0);
  clock.advance(90 * 60 * 1000);
  const first = (await s.call('POST', `/agent-ops/timeline/${run.id}/release`, {}, doc)).json;
  assert.deepEqual(first.released, ['t1']);
  assert.equal((await search()).json.total, 1, 'released at its time');
  assert.equal((await search('2026-05-01T09:30:00.000Z')).json.total, 0, 'never visible before its time');
  clock.advance(60 * 60 * 1000);
  const second = (await s.call('POST', `/agent-ops/timeline/${run.id}/release`, {}, doc)).json;
  assert.deepEqual(second.released, []);
  const after = (await s.call('GET', `/agent-ops/runs/${run.id}`)).json;
  assert.equal(after.timeline[1].skipped, 'long-horizon is off', 'the scheduled check is not run without long-horizon');
  const steps = await stepsOf(s, run.id);
  assert.equal(steps.filter((x) => x.did.type === 'timeline.release').length, 1);
  await s.close();
});

test(`[${BACKEND}] the Agent panel: questions are answered with citations, requests wait for a person, time-out stops safely, take over ends the turn, nothing becomes final without a human`, async () => {
  const ctx = await agentSetup();
  const { s, p, clock } = ctx;
  await s.call('POST', '/fhir/R4/Observation', { resourceType: 'Observation', status: 'final', subject: { reference: `Patient/${p.id}` }, effectiveDateTime: '2026-04-28T08:00:00Z', code: { coding: [{ system: 'http://loinc.org', code: '2160-0', display: 'Creatinine' }] }, valueQuantity: { value: 1.1, unit: 'mg/dL' } }, doc);
  await s.call('POST', '/fhir/R4/Observation', { resourceType: 'Observation', status: 'final', subject: { reference: `Patient/${p.id}` }, effectiveDateTime: '2026-04-30T08:00:00Z', code: { coding: [{ system: 'http://loinc.org', code: '2160-0', display: 'Creatinine' }] }, valueQuantity: { value: 1.8, unit: 'mg/dL' } }, doc);
  const message = async (text) => (await s.call('POST', '/fhir/R4/Communication', { resourceType: 'Communication', status: 'completed', subject: { reference: `Patient/${p.id}` }, sender: { reference: `Patient/${p.id}` }, sent: clock.now(), topic: { text: 'Question' }, payload: [{ contentString: text }] }, doc)).json;
  const msg = await message('I have felt dizzy since yesterday and I am not sure what to do.');
  // Helper that asks, on a practice copy: the triager meets a symptom its rules do not cover and asks.
  const launch = (extra = {}) => s.call('POST', '/agent-ops/agents/inbox-triager/run', { mode: 'hitl', practice: true, subject: `Communication/${msg.id}`, condition: 'helper-that-asks', wait: false, askTimeoutMs: 20000, ...extra });
  const r1 = (await launch()).json;
  assert.deepEqual([r1.condition, r1.askFrequency, r1.capabilities.includes('agent-may-ask')], ['helper-that-asks', 'orders-signing', true]);
  const panel = await until(async () => { const d = (await s.call('GET', `/agent-ops/panel/${r1.id}`, undefined, doc)).json; return d.waiting.length ? d : null; }, { last: async () => ({ run: (await s.call('GET', `/agent-ops/runs/${r1.id}`)).json, steps: (await stepsOf(s, r1.id)).map((x) => x.did.type) }) });
  assert.deepEqual([panel.waiting[0].kind, panel.waiting[0].status], ['question', 'waiting']);
  assert.match(panel.waiting[0].text, /dizzy/);
  assert.ok((await s.call('GET', '/agent-ops/panel/waiting', undefined, doc)).json.waiting >= 1, 'the menu bar badge sees the waiting request');
  assert.equal((await s.call('POST', `/agent-ops/panel/${r1.id}/decide`, { decision: 'deny' }, doc)).status, 422, 'a reason is required to deny');
  assert.equal((await s.call('POST', `/agent-ops/panel/${r1.id}/decide`, { decision: 'answer', text: 'Treat it as urgent' }, { 'X-Agent-Id': 'inbox-triager', 'X-Run-Id': r1.id })).status >= 400, true, 'an agent cannot decide for a person');
  const decided = (await s.call('POST', `/agent-ops/panel/${r1.id}/decide`, { decision: 'answer', text: 'Treat it as urgent' }, doc)).json;
  assert.equal(decided.decision.decision, 'answered');
  const done = await until(async () => { const r = (await s.call('GET', `/agent-ops/runs/${r1.id}`)).json; return r.status === 'awaiting-decision' ? r : null; }, { last: async () => { const r = (await s.call('GET', `/agent-ops/runs/${r1.id}`)).json; return { status: r.status, endReason: r.endReason, result: r.result, awaitingReply: r.awaitingReply, steps: (await stepsOf(s, r1.id)).map((x) => `${x.did.type}:${x.did.args?.decision || x.did.args?.kind || ''}`) }; } });
  const cards = (await s.call('GET', `/agent-ops/proposals?_branch=${done.targetBranch}&runId=${r1.id}`)).json.proposals;
  assert.equal(cards[0].content.label, 'urgent', 'the answer changed the outcome');
  // A clinician question in the panel is answered with citations (chart-chat).
  const asked = (await s.call('POST', `/agent-ops/panel/${r1.id}/ask`, { text: 'How has the creatinine changed this week?' }, doc)).json;
  const answer = asked.conversation.find((m) => m.type === 'panel.answer');
  assert.match(answer.text, /Creatinine.*1\.1.*1\.8.*risen/);
  assert.equal(answer.cites.length, 2);
  const conv = (await s.call('GET', `/agent-ops/panel/${r1.id}`, undefined, doc)).json;
  assert.deepEqual(conv.conversation.map((m) => m.type), ['panel.request', 'panel.decide', 'panel.message', 'panel.answer']);
  assert.deepEqual([conv.stats.asks, conv.stats.questionsAsked, conv.stats.guidanceChangedOutcome], [1, 1, false]);
  // Nothing an agent produces is final without a human: an agent cannot accept its own proposal.
  const selfAccept = await s.call('POST', `/agent-ops/proposals/${cards[0].id}/decide?_branch=${done.targetBranch}`, { decision: 'accept' }, { 'X-Agent-Id': 'inbox-triager', 'X-Run-Id': r1.id });
  assert.equal(selfAccept.status >= 400, true);
  // Time-out: no reply within the limit; the agent stops safely without acting.
  const r2 = (await launch({ askTimeoutMs: 300 })).json;
  const ended = await until(async () => { const r = (await s.call('GET', `/agent-ops/runs/${r2.id}`)).json; return r.endedAt ? r : null; });
  assert.equal(ended.endReason, 'ask-timeout');
  const c2 = (await s.call('GET', `/agent-ops/panel/${r2.id}`, undefined, doc)).json;
  assert.deepEqual([c2.conversation.at(-1).type, c2.stats.timedOut], ['panel.timeout', 1]);
  assert.equal((await s.call('GET', `/agent-ops/proposals?_branch=${r2.targetBranch}&runId=${r2.id}`)).json.proposals.length, 0, 'it wrote nothing');
  // Take over: the agent's turn ends now.
  const r3 = (await launch()).json;
  await until(async () => ((await s.call('GET', `/agent-ops/panel/${r3.id}`, undefined, doc)).json.waiting.length ? true : null));
  const taken = (await s.call('POST', `/agent-ops/panel/${r3.id}/take-over`, {}, doc)).json;
  assert.equal(taken.status, 'taken-over');
  await s.agents.idle();
  assert.equal((await stepsOf(s, r3.id)).some((x) => x.did.type === 'panel.take-over'), true);
  // Deployed today cannot ask: the same message is labelled by the rules alone and the proposal waits in place.
  const r4 = (await launch({ condition: 'deployed-today', wait: true })).json;
  assert.equal(r4.status, 'awaiting-decision');
  assert.equal((await s.call('GET', `/agent-ops/panel/${r4.id}`, undefined, doc)).json.conversation.length, 0, 'no request was made');
  await s.close();
});

test(`[${BACKEND}] in-place drafts: a note with "Check this" marks and queued orders land in the chart; a recording keeps the AI interactions; the analysis columns are exact`, async () => {
  const ctx = await agentSetup();
  const { s, p } = ctx;
  const transcript = ['Doctor: What brings you in today?', 'Patient: A cough for three days and some fever.', 'Doctor: Temperature is 38.2 and chest is clear on examination.', 'Doctor: We will order a chest x-ray and check a full blood count.', 'Doctor: The dog ate my homework yesterday.'].join('\n');
  const t = (await s.call('POST', '/fhir/R4/DocumentReference', { resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', subject: { reference: `Patient/${p.id}` }, type: { coding: [{ system: 'urn:hospital-desktop:doc-type', code: 'transcript' }], text: 'Encounter transcript' }, content: [{ attachment: { contentType: 'text/plain', data: Buffer.from(transcript).toString('base64') } }] }, doc)).json;
  const context = { transcript: `DocumentReference/${t.id}`, roles: { subjective: 'Subjective', objective: 'Objective', assessment: 'Assessment', plan: 'Plan', medications: 'Plan' }, sections: ['Subjective', 'Objective', 'Assessment', 'Plan'], noteType: { code: '11506-3', display: 'Progress note' } };
  const run = (await s.call('POST', '/agent-ops/agents/note-scribe/run', { mode: 'hitl', practice: true, subject: `Patient/${p.id}`, condition: 'deployed-today', context }, doc)).json;
  assert.equal(run.status, 'awaiting-decision', JSON.stringify(run.result));
  const cards = (await s.call('GET', `/agent-ops/proposals?_branch=${run.targetBranch}&runId=${run.id}`)).json.proposals;
  const note = cards.find((c) => c.kind === 'note'); const orders = cards.filter((c) => c.kind === 'order');
  assert.ok(note, 'the note draft is a proposal in place');
  assert.match(note.content.text, /\[Check this\] The dog ate my homework/);
  assert.deepEqual(orders.map((o) => o.content.resource.code.text).sort(), ['Chest X-ray', 'Full blood count'], 'orders named in the plan are queued');
  // A recording is on while the clinician works with the drafts: the interactions are in both logs.
  const rec = (await s.call('POST', '/agent-ops/capture/start', { acknowledged: true, title: 'With drafts' }, doc)).json;
  const recHeaders = { ...doc, 'X-Run-Id': rec.id };
  assert.equal((await s.call('POST', '/agent-ops/drafts/events', { draft: note.id, event: 'shown', branch: run.targetBranch }, recHeaders)).status, 201);
  assert.equal((await s.call('POST', '/agent-ops/drafts/events', { draft: note.id, event: 'edited', editSize: 14, branch: run.targetBranch }, recHeaders)).status, 201);
  assert.equal((await s.call('POST', '/agent-ops/drafts/events', { draft: orders[0].id, event: 'discarded', why: 'Not needed', branch: run.targetBranch }, recHeaders)).status, 201);
  assert.equal((await s.call('POST', '/agent-ops/drafts/events', { draft: note.id, event: 'applaud', branch: run.targetBranch }, recHeaders)).status, 422);
  // The clinician signs the edited note; the agent cannot.
  assert.equal((await s.call('POST', `/agent-ops/proposals/${note.id}/decide?_branch=${run.targetBranch}`, { decision: 'accept' }, { 'X-Agent-Id': 'note-scribe', 'X-Run-Id': run.id })).status >= 400, true);
  const signed = (await s.call('POST', `/agent-ops/proposals/${note.id}/decide?_branch=${run.targetBranch}`, { decision: 'edit', content: { text: note.content.text.replace('[Check this] The dog ate my homework yesterday.', '') } }, doc)).json;
  assert.equal(signed.decision, 'edited');
  const written = await s.store.get('DocumentReference', signed.result.split('/')[1], { branch: run.targetBranch });
  assert.equal(written.docStatus, 'final');
  assert.ok(!Buffer.from(written.content[0].attachment.data, 'base64').toString('utf8').includes('Check this'), 'the marks never reach the signed note');
  const placed = (await s.call('POST', `/agent-ops/proposals/${orders[1].id}/decide?_branch=${run.targetBranch}`, { decision: 'accept' }, doc)).json;
  assert.match(placed.result, /^ServiceRequest\//);
  assert.equal((await s.store.get('ServiceRequest', placed.result.split('/')[1], { branch: run.targetBranch })).status, 'active');
  const agentSteps = await stepsOf(s, run.id);
  const stats = interactionStats(agentSteps);
  assert.deepEqual([stats.draftsShown >= 1, stats.draftsEdited, stats.editSize, stats.draftsDiscarded], [true, 2, 14 + (agentSteps.find((x) => x.did.type === 'proposal.edit')?.did.args.editSize ?? 0), 1]);
  const recSteps = await stepsOf(s, rec.id);
  assert.deepEqual(recSteps.filter((x) => x.did.type === 'ai.interaction').map((x) => x.did.args.event), ['shown', 'edited', 'discarded'], 'the recording holds the AI interactions');
  assert.equal(recSteps.find((x) => x.did.args?.event === 'discarded').why, 'Not needed');
  const policy = (await s.call('GET', '/agent-ops/capture/policy')).json;
  assert.deepEqual([policy.captureAiInteractions, policy.askWhyAfterOverride], [true, false]);
  assert.equal((await s.call('PUT', '/agent-ops/capture/policy', { askWhyAfterOverride: true }, res)).json.askWhyAfterOverride, true);
  // The analysis table export carries the new columns, and the HITL report sums the interactions.
  for (const col of ['condition', 'capabilities', 'draftsShown', 'draftsUsed', 'editSize', 'overrides', 'asks', 'timeToAnswer']) assert.ok(RUN_COLUMNS.includes(col), col);
  const report = (await s.call('GET', '/agent-ops/hitl?agentId=note-scribe')).json.agents[0];
  assert.ok(report.interactions.draftsEdited >= 1 && report.interactions.runs === 1);
  // A study compares conditions side by side.
  const study = (await s.call('POST', '/agent-ops/research/studies', { title: 'Scribe conditions', question: 'Does asking help?' }, res)).json;
  await s.call('POST', `/agent-ops/research/studies/${study.id}/links`, { kind: 'run', ref: run.id }, res);
  const compare = (await s.call('GET', `/agent-ops/research/studies/${study.id}/compare`, undefined, res)).json;
  assert.deepEqual(compare.conditions.map((c) => [c.condition, c.runs, c.drafts.used >= 1]), [['deployed-today', 1, true]]);
  await s.close();
});
