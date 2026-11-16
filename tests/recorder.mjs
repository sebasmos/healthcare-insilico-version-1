import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder } from '../data-annotation/web/shared/recorder.js';
import { validateTraceBatch } from '../agent-operations/server/runs.mjs';

function harness({ failFirst = 0, ...options } = {}) {
  const sent = [];
  const timers = [];
  let failures = failFirst;
  const recorder = createRecorder({
    app: 'ehr', maxBatch: 3, ...options,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push({ url, headers: init.headers, body });
      if (failures > 0) { failures -= 1; throw new Error('network down'); }
      return { ok: true, status: 200 };
    },
  });
  return { recorder, sent, timers };
}

test('recorded events carry identifiers only and pass the server allowlist', async () => {
  const { recorder, sent } = harness();
  recorder.setContext({ role: 'physician', runId: 'run-1', patient: 'Patient/abc' });
  recorder.record('click', { target: 'order-sign-button', route: '/ehr/#/chart', value: 'secret', text: 'Given Family', key: 'k' });
  recorder.record('change', { field: 'note-body', value: 'free text typed by the clinician' });
  await recorder.flush();
  const events = sent.flatMap((s) => s.body.events);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.type), ['context', 'click', 'change']);
  const wire = JSON.stringify(sent);
  for (const forbidden of ['secret', 'Given Family', 'free text', '"value"', '"text"', '"key"']) assert.ok(!wire.includes(forbidden), forbidden);
  assert.equal(events[1].patient, 'Patient/abc');
  assert.match(events[1].uiStateHash, /^[a-f0-9]{8}$/);
  assert.equal(sent[0].headers['X-Run-Id'], 'run-1');
  for (const s of sent) assert.doesNotThrow(() => validateTraceBatch(s.body));
});

test('a target that is not an identifier is dropped, not sent', async () => {
  const { recorder, sent } = harness();
  recorder.record('click', { target: 'Mrs Example, 12 High Street' });
  await recorder.flush();
  assert.equal(sent[0].body.events[0].target, undefined);
});

test('events are batched with increasing seq numbers', async () => {
  const { recorder, sent } = harness();
  for (let i = 0; i < 7; i += 1) recorder.record('click', { target: `button-${i}` });
  await recorder.flush();
  await recorder.flush();
  assert.deepEqual(sent.map((s) => s.body.events.length), [3, 3, 1]);
  assert.deepEqual(sent.flatMap((s) => s.body.events.map((e) => e.seq)), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(new Set(sent.map((s) => s.body.batchId)).size, 3);
  assert.equal(recorder.pending, 0);
});

test('a failed batch is retried with the same batchId and nothing is lost', async () => {
  const { recorder, sent, timers } = harness({ failFirst: 2 });
  recorder.record('click', { target: 'a' });
  recorder.record('click', { target: 'b' });
  assert.equal(await recorder.flush(), false);
  assert.equal(recorder.pending, 2);
  assert.equal(await recorder.flush(), false);
  assert.equal(await recorder.flush(), true);
  assert.equal(sent.length, 3);
  assert.equal(new Set(sent.map((s) => s.body.batchId)).size, 1, 'same idempotency key on every retry');
  assert.deepEqual(sent[2].body.events.map((e) => e.target), ['a', 'b']);
  assert.ok(timers.some((t) => t.ms >= 1000), 'a retry was scheduled with backoff');
  assert.equal(recorder.pending, 0);
});
