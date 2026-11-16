// Age is worked out as of the patient's reference date and is never negative:
// the as-of time when viewing a past time; the latest encounter or anchor year
// for a date-shifted source; otherwise today.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestServer, testClock } from './support/helpers.mjs';
import { ageYears, ageInfo, ANCHOR_YEAR_URL } from '../platform/web/shared/age.js';
import { briefingAge } from '../ehr/server/age.mjs';

const now = new Date('2026-06-15T12:00:00Z');

test('the rule: never negative, and the reference year is shown when it is not today', () => {
  assert.equal(ageYears('1960-06-16', '2026-06-15'), 65);
  assert.equal(ageYears('1960-06-15', '2026-06-15'), 66);
  assert.equal(ageYears('2150-01-01', '2026-06-15'), null, 'before birth there is no age, not a negative one');
  assert.deepEqual(ageInfo({ birthDate: '1960-06-15' }, { now }), { years: 66, reference: '2026-06-15', basis: 'today', asOfYear: null, label: '66 y' });
  const shifted = ageInfo({ birthDate: '2150-03-01' }, { now, latestEncounter: '2210-08-09T10:00:00Z' });
  assert.equal(shifted.label, '60 y'); assert.equal(shifted.basis, 'latest-encounter');
  const anchored = ageInfo({ birthDate: '2118-01-01', extension: [{ url: ANCHOR_YEAR_URL, valueInteger: 2180 }] }, { now });
  assert.equal(anchored.label, '62 y'); assert.equal(anchored.basis, 'anchor-year');
  assert.equal(ageInfo({ birthDate: '2150-03-01' }, { now }).label, '', 'a shifted patient with nothing to anchor on shows no age');
  assert.equal(ageInfo({ birthDate: '1960-06-15' }, { now, asOf: '2000-01-01T00:00:00Z' }).label, '39 y (as of 2000)');
  assert.equal(ageInfo({ birthDate: '1960-06-15' }, { now, restricted: true }).label, '66 y', 'a restricted patient with no encounter or anchor falls back to today');
  for (const birthDate of ['2150-01-01', '1900-01-01', '2026-06-16', null]) for (const latestEncounter of [null, '2210-01-01', '1990-01-01']) for (const asOf of [null, '2001-01-01T00:00:00Z']) {
    const a = ageInfo({ birthDate }, { now, latestEncounter, asOf }); assert.ok(a.years == null || a.years >= 0, JSON.stringify(a)); assert.ok(!a.label.includes('-'));
  }
});

test('a patient born in 2150 with an encounter in 2210 is 60, on every screen feed and in agent briefings', async () => {
  const clock = testClock('2026-03-01T09:00:00.000Z');
  const s = await startTestServer({ clock });
  try {
    const pid = randomUUID(); const plain = randomUUID();
    await s.store.transaction(async (tx) => {
      await tx.save('Patient', { resourceType: 'Patient', id: pid, identifier: [{ system: 'urn:hospital-desktop:mrn', value: 'N700001' }], gender: 'male', birthDate: '2150-02-10' }, { updatedBy: 'import' });
      await tx.save('Encounter', { resourceType: 'Encounter', id: randomUUID(), status: 'finished', class: { code: 'IMP' }, subject: { reference: `Patient/${pid}` }, period: { start: '2190-01-05T08:00:00Z', end: '2190-01-09T08:00:00Z' }, _patient: `Patient/${pid}` }, { updatedBy: 'import' });
      await tx.save('Encounter', { resourceType: 'Encounter', id: randomUUID(), status: 'finished', class: { code: 'IMP' }, subject: { reference: `Patient/${pid}` }, period: { start: '2210-05-01T08:00:00Z', end: '2210-05-04T08:00:00Z' }, _patient: `Patient/${pid}` }, { updatedBy: 'import' });
      await tx.save('Patient', { resourceType: 'Patient', id: plain, identifier: [{ system: 'urn:hospital-desktop:mrn', value: 'N700002' }], gender: 'female', birthDate: '1970-01-01' }, { updatedBy: 'import' });
    });
    const r = await s.call('GET', `/api/ages?ids=${pid},${plain},missing`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.ages[pid], { years: 60, reference: '2210-05-04', basis: 'latest-encounter', asOfYear: 2210, label: '60 y' });
    assert.equal(r.json.ages[plain].label, '56 y'); assert.equal(r.json.ages.missing, undefined);
    // The same answer when the list asks for many at once (no encounter shortcut for ordinary patients).
    const many = await s.call('GET', `/api/ages?ids=${[pid, plain, 'a', 'b', 'c', 'd', 'e'].join(',')}`);
    assert.equal(many.json.ages[pid].label, '60 y'); assert.equal(many.json.ages[plain].label, '56 y');
    assert.deepEqual(await briefingAge(s.store, { branch: 'main' }, `Patient/${pid}`), { years: 60, asOf: '2210-05-04', basis: 'latest-encounter' });
    assert.equal((await s.call('GET', '/api/ages')).status, 422);
  } finally { await s.close(); }
});

test('time travel: age is as of the time being viewed', async () => {
  const clock = testClock('2026-03-01T09:00:00.000Z');
  const s = await startTestServer({ clock });
  try {
    const plain = randomUUID(); const shifted = randomUUID();
    await s.store.transaction(async (tx) => {
      await tx.save('Patient', { resourceType: 'Patient', id: plain, gender: 'female', birthDate: '1970-06-01' }, { updatedBy: 'import' });
      await tx.save('Patient', { resourceType: 'Patient', id: shifted, gender: 'male', birthDate: '2150-02-10' }, { updatedBy: 'import' });
      await tx.save('Encounter', { resourceType: 'Encounter', id: randomUUID(), status: 'finished', class: { code: 'IMP' }, subject: { reference: `Patient/${shifted}` }, period: { start: '2200-05-01T08:00:00Z', end: '2200-05-04T08:00:00Z' }, _patient: `Patient/${shifted}` }, { updatedBy: 'import' });
    });
    const then = clock.advance(24 * 3600e3);
    clock.advance(6 * 365.25 * 24 * 3600e3); // six years later
    await s.store.transaction((tx) => tx.save('Encounter', { resourceType: 'Encounter', id: randomUUID(), status: 'finished', class: { code: 'IMP' }, subject: { reference: `Patient/${shifted}` }, period: { start: '2210-05-01T08:00:00Z', end: '2210-05-04T08:00:00Z' }, _patient: `Patient/${shifted}` }, { updatedBy: 'import' }));
    const live = (await s.call('GET', `/api/ages?ids=${plain},${shifted}`)).json.ages;
    assert.equal(live[plain].label, '61 y'); assert.equal(live[shifted].label, '60 y');
    const past = (await s.call('GET', `/api/ages?ids=${plain},${shifted}&_asOf=${encodeURIComponent(then)}`)).json.ages;
    assert.deepEqual(past[plain], { years: 55, reference: '2026-03-02', basis: 'as-of', asOfYear: 2026, label: '55 y (as of 2026)' });
    // The shifted patient is "born" after the time being viewed: the age uses the latest encounter that was on the chart then, never a negative number.
    assert.equal(past[shifted].label, '50 y');
    assert.deepEqual(await briefingAge(s.store, { branch: 'main', asOf: then }, `Patient/${plain}`), { years: 55, asOf: '2026-03-02', basis: 'as-of' });
  } finally { await s.close(); }
});
