// The recording device's own statements and measurements are kept apart from a physician's read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { machineMeasurements, withMachine, machineReport, isEcgReport, isEcgMachineReport, measurementsOf, machineExtraOf, leadComponents, MACHINE_LABEL, ECG_CATEGORY } from '../ecg/server/ecg.mjs';

test('machine measurements come from the device\'s points; the machine report never counts as a physician read', () => {
  const v = machineMeasurements({ rr_interval: '800', p_onset: '40', p_end: '150', qrs_onset: '200', qrs_end: '290', t_end: '590', p_axis: '60', qrs_axis: '-10', t_axis: '29999' });
  assert.deepEqual(v, { rate: 75, rr: 800, p: 110, pr: 160, qrs: 90, qt: 390, qtc: 436, pAxis: 60, axis: -10 }, 'QTc is 390 over the square root of 0.8; the missing T axis is left out');
  assert.deepEqual(machineMeasurements({ rr_interval: '', p_onset: '29999', qrs_onset: '200', qrs_end: '290' }), { qrs: 90 });
  const lead = { code: { coding: [{ system: 'urn:oid:2.16.840.1.113883.6.24', code: '131330', display: 'II' }] }, valueSampledData: { origin: { value: 0, unit: 'mV' }, period: 2, factor: 0.005, dimensions: 1, data: '0 1 2 1 0' } };
  const o = withMachine({ resourceType: 'Observation', id: 'e1', subject: { reference: 'Patient/p1' }, effectiveDateTime: '2100-01-01T00:00:00Z', component: [lead] }, v, ['Sinus rhythm', 'Normal ECG']);
  assert.equal(leadComponents(o).length, 1, 'the tracing is kept'); assert.equal(measurementsOf(o).qtc, 436); assert.equal(machineExtraOf(o).rr, 800); assert.ok(o.valueString.startsWith(MACHINE_LABEL));
  assert.equal(withMachine(o, v, ['Sinus rhythm']).component.length, o.component.length, 'attaching again does not double the components');
  const r = machineReport({ observation: o, statements: ['Sinus rhythm', 'Normal ECG'], source: 'device', now: '2100-01-01T00:00:00Z' });
  assert.equal(r.code.text, MACHINE_LABEL); assert.equal(r.conclusion, 'Sinus rhythm\nNormal ECG'); assert.equal(isEcgMachineReport(r), true); assert.equal(isEcgReport(r), false);
  assert.equal(isEcgReport({ resourceType: 'DiagnosticReport', category: [ECG_CATEGORY] }), true);
});
