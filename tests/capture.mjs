// Data Annotation → Capture: recording a clinician. Structured events are
// always attributed to the recording; free text is kept only with an enabled
// policy and consent, redacted and encrypted, and can expire or be deleted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, testClock, patient, BACKEND } from './support/helpers.mjs';
import { seal, unseal, summarize } from '../data-annotation/server/capture.mjs';

// The recorded clinician registers patients, orders and adds problems, so she works as a physician.
const ann = { 'X-Role': 'physician', 'X-User-Id': 'dr-four' };
const LOINC = 'http://loinc.org';
const order = (pid, code = '24323-8', display = 'Comprehensive metabolic panel') => ({
  resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: `Patient/${pid}` }, code: { coding: [{ system: LOINC, code, display }] },
});
const steps = async (s, runId) => (await s.call('GET', `/agent-ops/trace?runId=${runId}`)).json.steps;
const start = (s, body = {}, headers = ann) => s.call('POST', '/agent-ops/capture/start', { acknowledged: true, ...body }, headers);
const allow = (s, body = { contentCapture: true }) => s.call('PUT', '/agent-ops/capture/policy', body, { 'X-Role': 'physician' });

test('The content key seals and opens text, and a wrong key cannot read it', () => {
  const key = Buffer.alloc(32, 7);
  const sealed = seal(key, 'thinking about the left base');
  assert.doesNotMatch(sealed, /thinking|left base/);
  assert.equal(unseal(key, sealed), 'thinking about the left base');
  assert.notEqual(seal(key, 'x'), seal(key, 'x'), 'a fresh nonce every time');
  assert.throws(() => unseal(Buffer.alloc(32, 8), sealed));
});

test(`[${BACKEND}] A recording attributes UI events and chart actions to its run; by default no free text is kept`, async () => {
  const s = await startTestServer();
  try {
    assert.equal((await s.call('POST', '/agent-ops/capture/start', { consent: { thinkAloud: true } }, ann)).status, 422, 'the person being recorded must agree');
    const run = (await start(s, { title: 'Morning films', consent: { thinkAloud: true, why: true, dictation: true } })).json;
    assert.equal(run.mode, 'capture');
    assert.equal(run.umbrella, 'annotation');
    assert.equal(run.branch, 'main');
    assert.equal(run.agentId, null);
    assert.deepEqual(run.context.consent, { thinkAloud: false, why: false, dictation: false }, 'with the content policy off, asking for content changes nothing');
    assert.equal((await start(s)).status, 409, 'one recording per person at a time');

    const h = { ...ann, 'X-Run-Id': run.id };
    const p = (await s.call('POST', '/fhir/R4/Patient', patient('Recorded'), h)).json;
    const batch = { batchId: 'batch-capture-0001', events: [
      { seq: 1, type: 'click', target: 'order-new', app: 'ehr', route: '/ehr/#/chart', sessionId: 'sess-1', clientTime: '2026-01-01T00:00:01.000Z', patient: `Patient/${p.id}` },
      { seq: 2, type: 'change', field: 'field-text', app: 'ehr', sessionId: 'sess-1', clientTime: '2026-01-01T00:00:02.000Z' },
    ] };
    assert.equal((await s.call('POST', '/agent-ops/trace', batch, h)).status, 200);
    // A field value or a key press is refused outright, recording or not.
    for (const extra of [{ value: 'chest pain' }, { key: 'a' }, { text: 'free text' }]) {
      assert.equal((await s.call('POST', '/agent-ops/trace', { batchId: `batch-bad-${Object.keys(extra)[0]}-1`, events: [{ seq: 1, type: 'change', field: 'field-text', ...extra }] }, h)).status, 422);
    }
    assert.equal((await s.call('POST', '/fhir/R4/ServiceRequest', order(p.id), h)).status, 201);

    const refused = await s.call('POST', `/agent-ops/capture/${run.id}/content`, { kind: 'think-aloud', text: 'I think this is fine' }, ann);
    assert.equal(refused.status, 403);

    const log = await steps(s, run.id);
    assert.ok(log.some((x) => x.did.type === 'ui.click' && x.did.args.target === 'order-new'));
    assert.ok(log.some((x) => x.did.type === 'fhir.create' && x.did.args.type === 'ServiceRequest'));
    assert.ok(log.every((x) => x.who.kind === 'human' && x.runId === run.id));
    assert.doesNotMatch(JSON.stringify(log), /chest pain|I think this is fine/);
    const live = await steps(s, 'live');
    assert.ok(!live.some((x) => x.did.args?.type === 'ServiceRequest'), 'recorded work is not double-counted under everyday work');

    const ended = await s.call('POST', `/agent-ops/capture/${run.id}/stop`, {}, ann);
    assert.equal(ended.json.status, 'completed');
    assert.equal((await s.call('POST', `/agent-ops/capture/${run.id}/stop`, {}, ann)).status, 200, 'stopping twice is harmless');
    // A tab that still carries the ended recording's id keeps working; its actions fall back to everyday work.
    const after = await s.call('POST', '/fhir/R4/ServiceRequest', order(p.id, '58410-2', 'CBC'), h);
    assert.equal(after.status, 201);
    assert.ok(!(await steps(s, run.id)).some((x) => x.did.args?.id === after.json.id));
    assert.ok((await steps(s, 'live')).some((x) => x.did.args?.id === after.json.id));
    assert.equal((await s.call('POST', `/agent-ops/capture/${run.id}/content`, { kind: 'think-aloud', text: 'late' }, ann)).status, 409);
    // UI events are batched: one made during the recording still belongs to it when its batch arrives after the stop; a later one does not.
    const startedAt = run.startedAt;
    const lateBatch = { batchId: 'batch-capture-late-1', events: [
      { seq: 1, type: 'click', target: 'made-during', app: 'ehr', clientTime: startedAt },
      { seq: 2, type: 'click', target: 'made-after', app: 'ehr', clientTime: new Date(Date.parse(ended.json.endedAt) + 5000).toISOString() },
    ] };
    assert.equal((await s.call('POST', '/agent-ops/trace', lateBatch, h)).status, 200);
    const targets = (id) => steps(s, id).then((list) => list.filter((x) => x.did.type === 'ui.click').map((x) => x.did.args.target));
    assert.ok((await targets(run.id)).includes('made-during'));
    assert.ok(!(await targets(run.id)).includes('made-after'));
    assert.ok((await targets('live')).includes('made-after'));

    const agentRun = (await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'report-drafter' })).json;
    assert.equal((await s.call('POST', '/agent-ops/capture/start', { acknowledged: true }, { 'X-Agent-Id': 'report-drafter', 'X-Run-Id': agentRun.id })).status, 403, 'recordings are human only');
  } finally { await s.close(); }
});

test(`[${BACKEND}] With policy and consent, free text is redacted, encrypted, readable on request and deletable`, async () => {
  const s = await startTestServer();
  try {
    const p = (await s.call('POST', '/fhir/R4/Patient', patient('Examplefamily'))).json;
    const policy = await allow(s);
    assert.equal(policy.json.contentCapture, true);
    assert.equal((await s.call('PUT', '/agent-ops/capture/policy', { retentionDays: 0 })).status, 422);
    const run = (await start(s, { consent: { thinkAloud: true } })).json;
    assert.deepEqual(run.context.consent, { thinkAloud: true, why: false, dictation: false });

    const said = 'Mrs Examplefamily N123456 looks worse than on 2026-01-02; I want a CT.';
    const saved = await s.call('POST', `/agent-ops/capture/${run.id}/content`, { kind: 'think-aloud', text: said }, ann);
    assert.equal(saved.status, 201, saved.text);
    assert.equal(saved.json.redactions, 3);
    assert.equal((await s.call('POST', `/agent-ops/capture/${run.id}/content`, { kind: 'why', text: 'because' }, ann)).status, 403, 'no consent for "why" answers');
    assert.equal((await s.call('POST', `/agent-ops/capture/${run.id}/content`, { kind: 'dictation', text: 'lungs clear', field: 'report-findings' }, ann)).status, 403);
    assert.equal((await s.call('POST', `/agent-ops/capture/${run.id}/content`, { kind: 'think-aloud', text: '   ' }, ann)).status, 422);
    assert.equal((await s.call('POST', `/agent-ops/capture/${run.id}/content`, { kind: 'think-aloud', text: 'x'.repeat(4001) }, ann)).status, 413);

    // At rest: encrypted, and never in the append-only log.
    const rows = await s.store.sql.all('SELECT * FROM capture_content', []);
    assert.equal(rows.length, 1);
    assert.doesNotMatch(rows[0].cipher, /Examplefamily|worse|\bCT\b/);
    const everything = await s.store.sql.all('SELECT body FROM resource_versions', []);
    assert.ok(!everything.some((r) => /looks worse|Examplefamily N123456/.test(String(r.body))), 'the text is in no versioned record');
    const step = (await steps(s, run.id)).find((x) => x.did.type === 'capture.think-aloud');
    assert.equal(step.did.args.contentId, saved.json.id);
    assert.equal(step.why, null);

    const quiet = (await s.call('GET', `/agent-ops/capture/${run.id}`, undefined, ann)).json;
    assert.equal(quiet.content.length, 1);
    assert.equal(quiet.content[0].text, undefined, 'the text is only returned when asked for');
    assert.equal(quiet.summary.content['think-aloud'], 1);
    const shown = (await s.call('GET', `/agent-ops/capture/${run.id}?content=true`, undefined, ann)).json;
    assert.equal(shown.content[0].text, 'Mrs [name] [mrn] looks worse than on [date]; I want a CT.');
    assert.ok((await steps(s, run.id)).some((x) => x.did.type === 'capture.content.read'), 'reading the text is logged');
    assert.ok(p.id);

    const gone = await s.call('DELETE', `/agent-ops/capture/${run.id}/content/${saved.json.id}`, undefined, ann);
    assert.deepEqual(gone.json, { deleted: 1 });
    assert.equal((await s.store.sql.all('SELECT id FROM capture_content', [])).length, 0);
    assert.equal((await s.call('DELETE', `/agent-ops/capture/${run.id}/content/${saved.json.id}`, undefined, ann)).status, 404);
    const after = (await s.call('GET', `/agent-ops/capture/${run.id}?content=true`, undefined, ann)).json;
    assert.equal(after.content.length, 0);
    assert.equal(after.contentDeleted, 1);
    const log = await steps(s, run.id);
    assert.ok(log.some((x) => x.did.type === 'capture.content.delete' && x.did.args.contentIds.includes(saved.json.id)), 'the deletion itself stays on record');
    const audits = (await s.call('GET', '/fhir/R4/AuditEvent')).json.entry.map((e) => e.resource.outcomeDesc);
    assert.ok(audits.some((d) => /recording content deleted/.test(d)));
    assert.ok(audits.some((d) => /recording content policy/.test(d)));
  } finally { await s.close(); }
});

test(`[${BACKEND}] Dictation is kept only on the recording's practice copy, from an allowlisted field`, async () => {
  const s = await startTestServer();
  try {
    await allow(s);
    const onLive = (await start(s, { consent: { dictation: true } }, { 'X-User-Id': 'dr-live', 'X-Role': 'physician' })).json;
    assert.equal(onLive.context.consent.dictation, false, 'dictation consent is ignored on the live chart');
    assert.equal(onLive.context.practiceBranch, null);

    const run = (await start(s, { practice: true, consent: { dictation: true, why: true } })).json;
    const branch = run.context.practiceBranch;
    assert.match(branch, /^sandbox-/);
    assert.equal((await s.call('GET', '/agent-ops/branches')).json.branches.find((b) => b.id === branch).kind, 'sandbox');
    assert.equal(run.context.consent.dictation, true);
    const say = (body) => s.call('POST', `/agent-ops/capture/${run.id}/content`, { kind: 'dictation', text: 'No focal consolidation.', ...body }, ann);
    assert.equal((await say({ field: 'report-findings', branch: 'main' })).status, 403, 'not from the live chart');
    assert.equal((await say({ field: 'patient-search', branch })).status, 403, 'not from a field off the allowlist');
    const ok = await say({ field: 'report-findings', branch });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.field, 'report-findings');
    const why = await s.call('POST', `/agent-ops/capture/${run.id}/content`, { kind: 'why', text: 'Matches the prior.', about: 'DiagnosticReport/abc' }, ann);
    assert.equal(why.status, 201);
    assert.equal(why.json.about, 'DiagnosticReport/abc');
    const made = await s.call('POST', `/agent-ops/capture/${run.id}/stop`, {}, ann);
    assert.equal(made.status, 200);
    assert.equal((await s.call('POST', `/agent-ops/capture/${run.id}/case`, { title: 't', scenario: 's', task: 't', split: 'train' }, ann)).status, 409, 'practice-copy work cannot become a case');
    assert.deepEqual((await s.call('DELETE', `/agent-ops/capture/${run.id}/content`, undefined, ann)).json, { deleted: 2 });
  } finally { await s.close(); }
});

test(`[${BACKEND}] Written content is deleted when its retention period ends`, async () => {
  const clock = testClock('2026-03-01T09:00:00.000Z');
  const s = await startTestServer({ clock });
  try {
    await allow(s, { contentCapture: true, retentionDays: 7 });
    const run = (await start(s, { consent: { thinkAloud: true } })).json;
    assert.equal(run.context.retentionDays, 7);
    clock.advance(1000);
    const saved = (await s.call('POST', `/agent-ops/capture/${run.id}/content`, { kind: 'think-aloud', text: 'first thought' }, ann)).json;
    assert.equal(saved.expiresAt, '2026-03-08T09:00:01.000Z');
    clock.advance(6 * 86400000);
    assert.deepEqual((await s.call('POST', '/agent-ops/capture/purge', {})).json, { deleted: 0 });
    clock.advance(86400000);
    assert.deepEqual(await s.capture.purge(), { deleted: 1 });
    assert.equal((await s.store.sql.all('SELECT id FROM capture_content', [])).length, 0);
    const log = await steps(s, run.id);
    assert.ok(log.some((x) => x.did.type === 'capture.content.delete' && x.did.args.reason === 'retention period ended'));
  } finally { await s.close(); }
});

test(`[${BACKEND}] The summary reports what was done and viewed, and a recording can become a case`, async () => {
  const clock = testClock('2026-04-01T08:00:00.000Z');
  const s = await startTestServer({ clock });
  try {
    const p = (await s.call('POST', '/fhir/R4/Patient', patient('Casegiven'))).json;
    clock.advance(60000);
    const run = (await start(s)).json;
    const h = { ...ann, 'X-Run-Id': run.id };
    const ev = (seq, sec, type, extra) => ({ seq, type, app: 'pacs', sessionId: 'tab-1', clientTime: new Date(Date.parse('2026-04-01T08:01:00.000Z') + sec * 1000).toISOString(), ...extra });
    const study = (id) => [{ ref: `ImagingStudy/${id}` }];
    const batch = { batchId: 'batch-summary-0001', events: [
      ev(1, 0, 'viewer', { viewer: { action: 'open-study' }, resources: study('st-a'), route: '/pacs/#/study/st-a' }),
      ev(2, 10, 'viewer', { viewer: { action: 'length', mm: 12.5 }, resources: study('st-a') }),
      ev(3, 20, 'viewer', { viewer: { action: 'dwell', frame: 3, ms: 4000 }, resources: study('st-a') }),
      ev(4, 40, 'viewer', { viewer: { action: 'open-study' }, resources: study('st-b'), route: '/pacs/#/study/st-b' }),
      ev(5, 55, 'nav', { route: '/pacs/#/worklist' }),
      ev(6, 60, 'click', { target: 'nav-upload' }),
    ] };
    assert.equal((await s.call('POST', '/agent-ops/trace', batch, h)).status, 200);
    clock.advance(30000);
    assert.equal((await s.call('POST', '/fhir/R4/ServiceRequest', order(p.id, '36643-5', 'CT pulmonary angiography'), h)).status, 201);
    clock.advance(30000);
    assert.equal((await s.call('POST', '/fhir/R4/Condition', { resourceType: 'Condition', subject: { reference: `Patient/${p.id}` }, code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'I26.99', display: 'Pulmonary embolism' }] }, clinicalStatus: { coding: [{ code: 'active' }] } }, h)).status, 201);

    const running = (await s.call('GET', `/agent-ops/capture/${run.id}`, undefined, ann)).json;
    assert.deepEqual(running.goldActions.map((g) => [g.type, g.code]), [['order', 'LOINC:36643-5'], ['diagnose', 'ICD-10:I26.99']]);
    const body = { title: 'Suspected PE', scenario: 'Breathless after a long flight.', task: 'Decide the next steps.', split: 'eval' };
    assert.equal((await s.call('POST', `/agent-ops/capture/${run.id}/case`, body, ann)).status, 409, 'not while still recording');
    clock.advance(60000);
    await s.call('POST', `/agent-ops/capture/${run.id}/stop`, {}, ann);

    const d = (await s.call('GET', `/agent-ops/capture/${run.id}`, undefined, ann)).json;
    assert.equal(d.summary.seconds, 120);
    assert.equal(d.summary.uiEvents, 6);
    assert.equal(d.summary.measurements, 1);
    assert.deepEqual(d.summary.recordsWritten, { ServiceRequest: 1, Condition: 1 });
    assert.deepEqual(d.summary.studies, [
      { ref: 'ImagingStudy/st-a', opens: 1, seconds: 40, frames: 1, frameSeconds: 4 },
      { ref: 'ImagingStudy/st-b', opens: 1, seconds: 15, frames: 0, frameSeconds: 0 },
    ]);
    assert.deepEqual(d.summary.uiByApp, { pacs: 6 });

    const made = await s.call('POST', `/agent-ops/capture/${run.id}/case`, body, ann);
    assert.equal(made.status, 201, made.text);
    assert.equal(made.json.source, 'recording');
    assert.equal(made.json.capturedFrom, run.id);
    assert.equal(made.json.asOf, run.startedAt, 'the case starts from the chart before the clinician acted');
    assert.equal(made.json.patient, `Patient/${p.id}`);
    assert.equal(made.json.split, 'eval');
    assert.deepEqual(made.json.goldActions.map((g) => g.code), ['LOINC:36643-5', 'ICD-10:I26.99']);
    assert.equal((await s.call('GET', `/agent-ops/capture/${run.id}`, undefined, ann)).json.cases.length, 1);
    // As of the case's start, the chart does not yet contain the clinician's order.
    const then = (await s.call('GET', `/fhir/R4/ServiceRequest?patient=${p.id}&_asOf=${encodeURIComponent(made.json.asOf)}`)).json.entry || [];
    assert.equal(then.length, 0);

    const empty = (await start(s, {}, { 'X-User-Id': 'dr-idle', 'X-Role': 'physician' })).json;
    await s.call('POST', `/agent-ops/capture/${empty.id}/stop`, {}, ann);
    assert.equal((await s.call('POST', `/agent-ops/capture/${empty.id}/case`, body, ann)).status, 422, 'nothing to use as the correct actions');
    assert.equal(summarize(empty, []).uiEvents, 0);
    assert.equal((await s.call('GET', '/agent-ops/capture')).json.recordings.length, 2);
    assert.equal((await s.call('GET', '/agent-ops/capture/nope')).status, 404);
  } finally { await s.close(); }
});
