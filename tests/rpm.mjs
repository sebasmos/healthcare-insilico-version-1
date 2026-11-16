// Remote patient monitoring: enrolment with devices and
// thresholds, readings from the portal and the gateway kept apart from
// inpatient vitals, the rules (thresholds, trends, missed readings,
// plausibility), alerts with de-duplication and snooze, alert actions and
// time-to-acknowledge, the dashboard, and role rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, testClock, patient, BACKEND } from './support/helpers.mjs';
import { evaluate, adherence, plausibility, thresholdsOf, thresholdGoals } from '../ehr/server/rpm.mjs';

const doc = { 'X-Role': 'physician', 'X-User-Id': 'dr-one' };
const nurse = { 'X-Role': 'nurse', 'X-User-Id': 'rn-one' };
const obs = (key, code, value, at, id = `${key}-${at}`) => ({ id, resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code }] }, valueQuantity: { value }, effectiveDateTime: at, category: [{ coding: [{ code: 'home-reading' }] }] });

test('rules: thresholds, heart-failure weight gain, three high systolics, adherence and missed readings, device plausibility', () => {
  const goals = thresholdGoals('heart-failure', 'Patient/p', { sbp: { high: 145 } });
  const thresholds = thresholdsOf(goals.map((g, i) => ({ ...g, id: `g${i}` })));
  assert.deepEqual([thresholds.sbp.high, thresholds.spo2.low, thresholds.weight.high], [145, 90, null]);
  const readings = [obs('weight', '29463-7', 80, '2026-05-01T08:00:00Z'), obs('weight', '29463-7', 82.5, '2026-05-03T08:00:00Z'), obs('sbp', '8480-6', 150, '2026-05-01T08:00:00Z'), obs('sbp', '8480-6', 151, '2026-05-02T08:00:00Z'), obs('sbp', '8480-6', 152, '2026-05-03T08:00:00Z'), obs('spo2', '59408-5', 85, '2026-05-03T08:00:00Z')];
  const alerts = evaluate({ programme: 'heart-failure', thresholds, readings, now: '2026-05-03T09:00:00Z' });
  const rules = alerts.map((a) => a.rule).sort();
  assert.deepEqual(rules, ['sbp-trend', 'threshold-high', 'threshold-low', 'weight-gain']);
  assert.equal(alerts.find((a) => a.rule === 'threshold-low').severity, 'medium');
  assert.equal(alerts.find((a) => a.rule === 'weight-gain').severity, 'high');
  const adh = adherence({ schedule: { weight: 1, sbp: 1 }, readings, now: '2026-05-05T09:00:00Z', days: 7 });
  assert.equal(adh.percent, Math.round((5 / 14) * 100));
  assert.equal(adh.missed, true, 'two days without a reading');
  assert.equal(adherence({ schedule: { weight: 1 }, readings, now: '2026-05-03T20:00:00Z' }).missed, false);
  assert.equal(plausibility('sbp', 400).ok, false);
  assert.match(plausibility('weight', 10).refuse, /refused/);
  assert.ok(plausibility('weight', 95, { value: 80, at: new Date().toISOString() }).flag, 'a 15 kg jump is flagged, not alerted');
  assert.equal(plausibility('glucose', 120).flag, null);
});

test(`[${BACKEND}] enrol → portal and gateway readings → alerts (de-duplicated, snoozed) → acknowledge, call, message, escalate, adjust, close; home readings stay out of the vitals and critical rules; dashboard`, async () => {
  const clock = testClock('2026-05-01T09:00:00.000Z');
  const s = await startTestServer({ clock });
  try {
    const p = (await s.call('POST', '/fhir/R4/Patient', patient('Rpmcase'))).json;
    const asPatient = { 'X-Role': 'patient', 'X-User-Id': `Patient/${p.id}` };
    let r = await s.call('POST', '/api/rpm/enrol', { patient: p.id, programme: 'heart-failure', thresholds: { sbp: { high: 140 } } }, asPatient);
    assert.equal(r.status, 403, 'a patient does not enrol (staff roles all may)');
    r = await s.call('POST', '/api/rpm/enrol', { patient: p.id, programme: 'heart-failure', thresholds: { sbp: { high: 140 } } }, doc);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.devices.length, 3);
    assert.equal(r.json.thresholds.sbp.high, 140);
    const planId = r.json.plan;
    assert.equal((await s.call('POST', '/api/rpm/enrol', { patient: p.id, programme: 'diabetes' }, doc)).status, 409, 'one active programme');
    // Portal reading, then a gateway reading; impossible value refused; odd value flagged but not alerted
    r = await s.call('POST', '/api/rpm/readings', { patient: p.id, key: 'weight', value: 80 }, asPatient);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.alerts.length, 0);
    assert.equal((await s.call('POST', '/api/rpm/readings', { patient: p.id, key: 'sbp', value: 400 }, asPatient)).status, 422);
    clock.advance(86400000);
    r = await s.call('POST', '/api/rpm/readings', { patient: p.id, key: 'sbp', value: 158, device: r.json.reading.id && undefined }, { 'X-Role': 'physician', 'X-User-Id': 'gateway' });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.alerts.length, 1);
    assert.equal(r.json.alerts[0].rule, 'threshold-high');
    const again = (await s.call('POST', '/api/rpm/readings', { patient: p.id, key: 'sbp', value: 159 }, asPatient)).json;
    assert.equal(again.alerts.length, 0, 'the same excursion does not alert twice');
    clock.advance(86400000);
    r = (await s.call('POST', '/api/rpm/readings', { patient: p.id, key: 'weight', value: 82.5 }, asPatient)).json;
    assert.ok(r.alerts.some((a) => a.rule === 'weight-gain'), 'weight up 2.5 kg in 2 days');
    const flagged = (await s.call('POST', '/api/rpm/readings', { patient: p.id, key: 'weight', value: 99 }, asPatient)).json;
    assert.match(flagged.reading.flag, /implausible/);
    assert.equal(flagged.alerts.length, 0);
    // Separation from inpatient rules
    const vitals = (await s.call('GET', `/fhir/R4/Observation?patient=${p.id}&category=vital-signs`)).json.entry || [];
    assert.equal(vitals.length, 0, 'home readings are not vital-signs');
    const home = (await s.call('GET', `/fhir/R4/Observation?patient=${p.id}&category=home-reading`)).json.entry;
    assert.ok(home.length >= 5);
    assert.ok(home.every((e) => e.resource.method?.text === 'home' && !e.resource.interpretation));
    assert.equal((await s.call('GET', '/api/badges')).json.criticalUnacknowledged.length, 0, 'never an inpatient critical result');
    const list = (await s.call('GET', `/api/nursing/worklist?patient=${p.id}`, undefined, nurse)).json.patients[0];
    assert.ok(!list.items.some((i) => i.kind === 'vitals' && /due \(/.test(i.label) && i.ref), 'home readings do not satisfy inpatient vitals');
    // Alerts: dashboard order, acknowledge with time, snooze, call, message, escalate, adjust, close
    let dash = (await s.call('GET', '/api/rpm/dashboard', undefined, nurse)).json;
    assert.equal(dash.rows.length, 1);
    assert.equal(dash.rows[0].openAlerts, 2);
    assert.equal(dash.alerts[0].severity, 'high', 'sorted by severity');
    const high = dash.alerts[0]; const med = dash.alerts[1];
    clock.advance(15 * 60000);
    r = await s.call('POST', `/api/rpm/alerts/${high.id}/acknowledge`, {}, nurse);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.minutes, 15, 'the weight-gain alert opened with the last reading, 15 minutes ago');
    r = await s.call('POST', `/api/rpm/alerts/${med.id}/snooze`, { reason: 'Patient seen in clinic this morning', hours: 24 }, nurse);
    assert.equal(r.status, 200, r.text);
    const snoozedAgain = (await s.call('POST', '/api/rpm/readings', { patient: p.id, key: 'sbp', value: 165 }, asPatient)).json;
    assert.ok(!snoozedAgain.alerts.some((a) => a.rule === 'threshold-high'), 'a snoozed excursion stays quiet (the separate three-in-a-row trend rule may still fire)');
    r = await s.call('POST', `/api/rpm/alerts/${high.id}/call`, { to: 'patient', note: 'Advised to take the extra diuretic dose' }, nurse);
    assert.equal(r.status, 200, r.text);
    r = await s.call('POST', `/api/rpm/alerts/${high.id}/message`, { text: 'Please weigh yourself again this evening.' }, nurse);
    assert.equal(r.status, 201, r.text);
    const comms = (await s.call('GET', `/fhir/R4/Communication?patient=${p.id}`)).json.entry;
    assert.equal(comms.length, 1);
    r = await s.call('POST', `/api/rpm/alerts/${high.id}/escalate`, { reason: 'Breathless on the phone' }, nurse);
    assert.equal(r.json.priority, 'stat');
    const view = (await s.call('GET', `/api/rpm/patients/${p.id}`, undefined, doc)).json;
    assert.equal(view.enrolled, true);
    assert.equal(view.thresholds.sbp.high, 140);
    r = await s.call('PUT', `/api/rpm/thresholds/${view.thresholds.sbp.goalId}`, { low: 90, high: 170 }, doc);
    assert.equal(r.status, 200, r.text);
    r = await s.call('POST', `/api/rpm/alerts/${high.id}/close`, {}, doc);
    assert.equal(r.status, 422, 'closing needs an outcome');
    r = await s.call('POST', `/api/rpm/alerts/${high.id}/close`, { outcome: 'Diuretic increased, review in 2 days' }, doc);
    assert.equal(r.json.status, 'completed');
    dash = (await s.call('GET', '/api/rpm/dashboard', undefined, nurse)).json;
    assert.equal(dash.timeToAcknowledge.count >= 1, true);
    assert.equal(dash.rows[0].adherence.percent > 0, true);
    const inbox = (await s.call('GET', `/fhir/R4/Task?patient=${p.id}`)).json.entry.map((e) => e.resource);
    assert.ok(inbox.some((t) => t.code.coding[0].code === 'rpm-alert'));
    // Missed readings: 3 days without a reading
    clock.advance(3 * 86400000);
    dash = (await s.call('GET', '/api/rpm/dashboard', undefined, nurse)).json;
    assert.equal(dash.missed.length, 1);
    // Agents and other patients refused
    assert.equal((await s.call('POST', '/api/rpm/enrol', { patient: p.id, programme: 'copd' }, { 'X-Agent-Id': 'report-drafter', 'X-Run-Id': 'live' })).status, 403);
    assert.equal((await s.call('POST', '/api/rpm/readings', { patient: p.id, key: 'sbp', value: 120 }, { 'X-Role': 'patient', 'X-User-Id': 'Patient/someone-else' })).status, 403);
    r = await s.call('POST', `/api/rpm/programmes/${planId}/end`, { reason: 'Discharged from programme' }, doc);
    assert.equal(r.json.status, 'completed');
    const steps = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.map((t) => t.did.type);
    for (const t of ['rpm.enrol', 'rpm.reading', 'rpm.alert', 'rpm.acknowledge', 'rpm.snooze', 'rpm.call', 'rpm.message', 'rpm.escalate', 'rpm.close', 'rpm.end']) assert.ok(steps.includes(t), t);
  } finally { await s.close(); }
});
