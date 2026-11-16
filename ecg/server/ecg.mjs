// 12-lead ECG records: the Observation (sampled data per lead,
// measurement components), the interpretation DiagnosticReport, and the
// rules around them. The sampled-data shape is wfdb.toObservation's, so a
// synthesised and an imported trace look the same to the viewer.
import { toObservation, ECG_CODE, MDC_SYSTEM, MDC_LEADS } from './wfdb.mjs';
import { SYSTEMS } from '../../ehr/server/catalog.mjs';

export const ECG_CATEGORY = { coding: [{ system: 'urn:hospital-desktop:category', code: 'ecg' }], text: 'ECG' };
export const ECG_ORDER_CODE = ECG_CODE.code;
// Measurement codes. Heart rate is LOINC 8867-4; the interval and axis codes below are the commonly cited LOINC
// codes for ECG measurements and are an unverified starter set like the rest of the catalogue.
export const MEASUREMENTS = [
  { key: 'rate', code: '8867-4', name: 'Heart rate', unit: '/min' },
  { key: 'pr', code: '8625-6', name: 'PR interval', unit: 'ms' },
  { key: 'qrs', code: '8633-0', name: 'QRS duration', unit: 'ms' },
  { key: 'qt', code: '8634-8', name: 'QT interval', unit: 'ms' },
  { key: 'qtc', code: '8636-3', name: 'QTc interval', unit: 'ms' },
  { key: 'axis', code: '8638-9', name: 'QRS axis', unit: 'deg' },
];
export const MEASUREMENTS_UNVERIFIED = true;
export const CRITICAL_TEXT = 'Critical ECG finding';

const codeOf = (o, system) => (o?.code?.coding || []).find((c) => c.system === system)?.code ?? null;
export const isEcgObservation = (o) => o?.resourceType === 'Observation' && codeOf(o, SYSTEMS.loinc) === ECG_CODE.code && (o.component || []).some((c) => c.valueSampledData);
export const MACHINE_URL = 'urn:hospital-desktop:ecg-machine';
export const MACHINE_LABEL = 'Machine interpretation, not a physician read';
export const isEcgMachineReport = (r) => r?.resourceType === 'DiagnosticReport' && (r.extension || []).some((x) => x.url === MACHINE_URL && x.valueBoolean === true);
// The physician's interpretation. The device's own statements are kept apart and never count as a read.
export const isEcgReport = (r) => r?.resourceType === 'DiagnosticReport' && (r.category || []).some((c) => (c.coding || []).some((x) => x.code === 'ecg')) && !isEcgMachineReport(r);
// What the device measured beyond the six above. Codes are our own: no checked standard code is claimed for them.
export const MACHINE_EXTRA = [
  { key: 'rr', code: 'ecg-rr-interval', name: 'RR interval', unit: 'ms' }, { key: 'p', code: 'ecg-p-duration', name: 'P duration', unit: 'ms' },
  { key: 'pAxis', code: 'ecg-p-axis', name: 'P axis', unit: 'deg' }, { key: 'tAxis', code: 'ecg-t-axis', name: 'T axis', unit: 'deg' },
];
const MACHINE_SYSTEM = 'urn:hospital-desktop:ecg-measurement';
export const machineExtraOf = (o) => Object.fromEntries(MACHINE_EXTRA.map((m) => [m.key, (o.component || []).find((c) => (c.code?.coding || []).some((x) => x.system === MACHINE_SYSTEM && x.code === m.code))?.valueQuantity?.value ?? null]));
/**
 * Measurements from a device's fiducial points (all in ms from the start of the beat; axes in degrees), as MIMIC-IV-ECG
 * gives them. Rate, PR, QRS, QT and P duration are differences of those points; QTc is Bazett's (QT over the square
 * root of RR in seconds). A missing point (blank, or the file's 29999 marker) leaves what depends on it out.
 */
export function machineMeasurements(row) {
  const n = (v) => { const x = Number(v); return v === '' || v == null || !Number.isFinite(x) || Math.abs(x) >= 29999 ? null : x; };
  const rr = n(row.rr_interval); const pOn = n(row.p_onset); const pEnd = n(row.p_end); const qOn = n(row.qrs_onset); const qEnd = n(row.qrs_end); const tEnd = n(row.t_end); const d = (a, b) => (a != null && b != null && a > b ? a - b : null);
  const qt = d(tEnd, qOn); const out = { rate: rr ? Math.round(60000 / rr) : null, rr, p: d(pEnd, pOn), pr: d(qOn, pOn), qrs: d(qEnd, qOn), qt, qtc: qt != null && rr ? Math.round(qt / Math.sqrt(rr / 1000)) : null, pAxis: n(row.p_axis), axis: n(row.qrs_axis), tAxis: n(row.t_axis) };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v != null));
}
/** The ECG Observation with the device's measurements as components (the leads are kept) and its statements as the reading. */
export function withMachine(o, values, statements) {
  const base = withMeasurements({ ...o, component: (o.component || []).filter((c) => !(c.code?.coding || []).some((x) => x.system === MACHINE_SYSTEM)) }, values);
  const extra = MACHINE_EXTRA.filter((m) => values[m.key] != null).map((m) => ({ code: { coding: [{ system: MACHINE_SYSTEM, code: m.code, display: m.name }] }, valueQuantity: { value: Number(values[m.key]), unit: m.unit } }));
  return { ...base, component: [...base.component, ...extra], ...(statements.length ? { valueString: `${MACHINE_LABEL}: ${statements.join('. ')}`.slice(0, 1000) } : {}) };
}
/** The device's statements as their own report, labelled so that nobody takes it for a physician's read. */
export function machineReport({ existing, observation, statements, source, now }) {
  return { ...(existing || { resourceType: 'DiagnosticReport' }), status: 'final', category: [ECG_CATEGORY], code: { coding: [ECG_CODE], text: MACHINE_LABEL }, subject: observation.subject, ...(observation.encounter ? { encounter: observation.encounter } : {}), effectiveDateTime: observation.effectiveDateTime, issued: existing?.issued ?? now, result: [{ reference: `Observation/${observation.id}` }], performer: [{ display: source || 'ECG device' }], conclusion: statements.join('\n'), extension: [{ url: MACHINE_URL, valueBoolean: true }] };
}
export const isEcgOrder = (o) => o?.resourceType === 'ServiceRequest' && codeOf(o, SYSTEMS.loinc) === ECG_CODE.code;

export const leadComponents = (o) => (o.component || []).filter((c) => c.valueSampledData);
export const measurementOf = (o, key) => { const m = MEASUREMENTS.find((x) => x.key === key); return (o.component || []).find((c) => codeOf(c, SYSTEMS.loinc) === m.code)?.valueQuantity?.value ?? null; };
export const measurementsOf = (o) => Object.fromEntries(MEASUREMENTS.map((m) => [m.key, measurementOf(o, m.key)]));

export function measurementComponents(values) {
  return MEASUREMENTS.filter((m) => values[m.key] !== undefined && values[m.key] !== null && values[m.key] !== '').map((m) => ({
    code: { coding: [{ system: SYSTEMS.loinc, code: m.code, display: m.name }] }, valueQuantity: { value: Number(values[m.key]), unit: m.unit, system: 'http://unitsofmeasure.org', code: m.unit === 'deg' ? 'deg' : m.unit },
  }));
}

/** Replaces the measurement components of an ECG Observation, keeping the leads. */
export function withMeasurements(o, values) {
  const leads = leadComponents(o);
  const current = measurementsOf(o);
  return { ...o, component: [...leads, ...measurementComponents({ ...current, ...values })] };
}

/** Samples of one lead in millivolts. */
export function leadMillivolts(component) {
  const sd = component.valueSampledData;
  const factor = sd.factor ?? 1;
  const origin = sd.origin?.value ?? 0;
  return sd.data.split(/\s+/).filter(Boolean).map((v) => origin + Number(v) * factor);
}

/** A simple R-peak count on lead II (or the first lead): heart rate per minute, or null when the trace is too short. */
export function detectRate(o) {
  const leads = leadComponents(o);
  const lead = leads.find((c) => codeOf(c, MDC_SYSTEM) === MDC_LEADS.II) || leads[0];
  if (!lead) return null;
  const mv = leadMillivolts(lead);
  const periodMs = lead.valueSampledData.period;
  const seconds = (mv.length * periodMs) / 1000;
  if (seconds < 2) return null;
  const max = Math.max(...mv);
  const threshold = max * 0.55;
  const refractory = Math.round(200 / periodMs);
  const peaks = [];
  for (let i = 1; i < mv.length - 1; i += 1) {
    if (mv[i] >= threshold && mv[i] >= mv[i - 1] && mv[i] >= mv[i + 1] && (!peaks.length || i - peaks[peaks.length - 1] > refractory)) peaks.push(i);
  }
  if (peaks.length < 2) return null;
  return Math.round((60000 * (peaks.length - 1)) / ((peaks[peaks.length - 1] - peaks[0]) * periodMs));
}

/** The interpretation report for an ECG Observation. */
export function interpretationReport({ existing, observation, text, critical, author, now }) {
  const base = existing || { resourceType: 'DiagnosticReport', status: 'preliminary', category: [ECG_CATEGORY], code: { coding: [ECG_CODE], text: '12-lead ECG interpretation' }, subject: observation.subject, effectiveDateTime: observation.effectiveDateTime, result: [{ reference: `Observation/${observation.id}` }], ...(observation.basedOn ? { basedOn: observation.basedOn } : {}), ...(observation.encounter ? { encounter: observation.encounter } : {}) };
  const extension = (base.extension || []).filter((e) => e.url !== 'urn:hospital-desktop:ecg-critical');
  if (critical) extension.push({ url: 'urn:hospital-desktop:ecg-critical', valueString: `${CRITICAL_TEXT}: ${String(critical).slice(0, 200)}` });
  return { ...base, conclusion: String(text ?? '').trim(), performer: [{ display: author }], ...(extension.length ? { extension } : {}), issued: base.issued ?? now };
}
