// ECG: sampled-data round trip through the WFDB writer and
// reader, generator determinism, the record and interpret routes, sign-off
// rules, critical findings, order completion, and role refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateEcg, writeWfdb, RHYTHMS } from './support/ecg-gen.mjs';
import { readRecord, toObservation } from '../ecg/server/wfdb.mjs';
import { detectRate, leadMillivolts, leadComponents, measurementsOf } from '../ecg/server/ecg.mjs';
import { startTestServer, testClock, patient, tempDir, BACKEND } from './support/helpers.mjs';

const doc = { 'X-Role': 'physician', 'X-User-Id': 'dr-one' };
const nurse = { 'X-Role': 'nurse', 'X-User-Id': 'rn-one' };
const tech = { 'X-Role': 'nurse', 'X-User-Id': 'tech-two' };

test('generator is deterministic for a seed and differs across seeds and rhythms; every rhythm gives 12 leads of 10 seconds at 500 Hz', () => {
  const a = generateEcg({ rhythm: 'normal', seed: 5 });
  const b = generateEcg({ rhythm: 'normal', seed: 5 });
  const c = generateEcg({ rhythm: 'normal', seed: 6 });
  assert.deepEqual(Array.from(a.signals[1].samples.slice(0, 500)), Array.from(b.signals[1].samples.slice(0, 500)));
  assert.notDeepEqual(Array.from(a.signals[1].samples.slice(0, 500)), Array.from(c.signals[1].samples.slice(0, 500)));
  for (const rhythm of Object.keys(RHYTHMS)) {
    const r = generateEcg({ rhythm, seed: 1 });
    assert.equal(r.signals.length, 12);
    assert.equal(r.nsamp, 5000);
    assert.equal(r.fs, 500);
    assert.ok(Math.abs(r.params.rate - RHYTHMS[rhythm].rate) <= (RHYTHMS[rhythm].irregular ? 25 : 3), `${rhythm} rate ${r.params.rate}`);
  }
});

test('sampled-data round trip: generator → WFDB files → reader → Observation with MDC lead codes and millivolts within 1 ADC unit', () => {
  const dir = tempDir('hd-ecg-');
  const record = generateEcg({ rhythm: 'stemi', seed: 2 });
  writeWfdb(record, dir, fs, path);
  const back = readRecord(dir, record.name);
  assert.equal(back.signals.length, 12);
  assert.deepEqual(Array.from(back.signals[6].samples.slice(0, 1000)), Array.from(record.signals[6].samples.slice(0, 1000)));
  const { observation } = toObservation(back, { patientId: 'p1', importedAt: '2026-05-01T09:00:00.000Z' });
  const leads = leadComponents(observation);
  assert.equal(leads.length, 12);
  assert.equal(leads[1].code.coding[0].code, '131330', 'lead II is MDC 131330');
  assert.equal(leads[1].code.coding[0].system, 'urn:oid:2.16.840.1.113883.6.24');
  const mv = leadMillivolts(leads[1]);
  assert.equal(mv.length, 5000);
  assert.ok(Math.abs(mv[100] - record.signals[1].samples[100] / 1000) < 0.0011);
  const rate = detectRate(observation);
  assert.ok(Math.abs(rate - record.params.rate) <= 6, `detected ${rate} vs ${record.params.rate}`);
});
