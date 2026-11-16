// Remote patient monitoring rules: programmes, devices, home
// readings kept apart from in-hospital vitals, per-patient thresholds as
// coded goals, trend and adherence rules, device plausibility, and alert
// de-duplication. Pure helpers; rpm-api.mjs does the transactions.
import { HttpError } from '../../platform/server/http.mjs';
import { SYSTEMS } from './catalog.mjs';

export const RPM_CATEGORY = { system: 'urn:hospital-desktop:category', code: 'home-reading', display: 'Home reading' };
export const RPM_PLAN_CATEGORY = { system: 'urn:hospital-desktop:category', code: 'rpm', display: 'Remote patient monitoring' };
export const RPM_URLS = { programme: 'urn:hospital-desktop:rpm-programme', schedule: 'urn:hospital-desktop:rpm-schedule', snoozed: 'urn:hospital-desktop:rpm-snoozed', rule: 'urn:hospital-desktop:rpm-rule', acknowledged: 'urn:hospital-desktop:rpm-acknowledged', plausibility: 'urn:hospital-desktop:plausibility', outcome: 'urn:hospital-desktop:rpm-outcome' };
export const TASK_SYSTEM = 'urn:hospital-desktop:task';

// Reading kinds: LOINC codes, units, and hard plausibility limits (a value outside them is refused; inside but odd is flagged).
export const READINGS = {
  sbp: { code: '8480-6', name: 'Systolic blood pressure', unit: 'mm[Hg]', min: 50, max: 300, device: 'bp-cuff' },
  dbp: { code: '8462-4', name: 'Diastolic blood pressure', unit: 'mm[Hg]', min: 20, max: 200, device: 'bp-cuff' },
  hr: { code: '8867-4', name: 'Heart rate', unit: '/min', min: 20, max: 250, device: 'bp-cuff' },
  weight: { code: '29463-7', name: 'Body weight', unit: 'kg', min: 20, max: 400, device: 'scale' },
  glucose: { code: '2339-0', name: 'Glucose (capillary)', unit: 'mg/dL', min: 20, max: 800, device: 'glucometer' },
  spo2: { code: '59408-5', name: 'Oxygen saturation', unit: '%', min: 50, max: 100, device: 'pulse-oximeter' },
  temp: { code: '8310-5', name: 'Body temperature', unit: 'Cel', min: 30, max: 45, device: 'thermometer' },
};
export const READING_BY_CODE = new Map(Object.entries(READINGS).map(([key, r]) => [r.code, { key, ...r }]));
export const DEVICES = { 'bp-cuff': 'Blood pressure cuff', scale: 'Scale', glucometer: 'Glucometer', 'pulse-oximeter': 'Pulse oximeter', thermometer: 'Thermometer' };

// Programmes: default devices, schedule (readings per day) and default thresholds { key: { low, high } }.
export const PROGRAMMES = {
  hypertension: { label: 'Hypertension', devices: ['bp-cuff'], schedule: { sbp: 1, dbp: 1, hr: 1 }, thresholds: { sbp: { low: 90, high: 140 }, dbp: { low: 50, high: 90 }, hr: { low: 50, high: 110 } } },
  'heart-failure': { label: 'Heart failure', devices: ['scale', 'bp-cuff', 'pulse-oximeter'], schedule: { weight: 1, sbp: 1, dbp: 1, hr: 1, spo2: 1 }, thresholds: { weight: { low: null, high: null }, sbp: { low: 90, high: 150 }, dbp: { low: 50, high: 95 }, hr: { low: 50, high: 110 }, spo2: { low: 90, high: null } } },
  diabetes: { label: 'Diabetes', devices: ['glucometer'], schedule: { glucose: 2 }, thresholds: { glucose: { low: 70, high: 250 } } },
  copd: { label: 'COPD', devices: ['pulse-oximeter', 'thermometer'], schedule: { spo2: 2, hr: 2, temp: 1 }, thresholds: { spo2: { low: 88, high: null }, hr: { low: 50, high: 120 }, temp: { low: 35, high: 38 } } },
  'post-discharge': { label: 'Post-discharge', devices: ['bp-cuff', 'thermometer', 'pulse-oximeter'], schedule: { sbp: 1, dbp: 1, hr: 1, temp: 1, spo2: 1 }, thresholds: { sbp: { low: 90, high: 160 }, dbp: { low: 50, high: 100 }, hr: { low: 50, high: 120 }, temp: { low: 35, high: 38 }, spo2: { low: 92, high: null } } },
};
export const SEVERITY = { high: 'stat', medium: 'urgent', low: 'routine' };

export const isHomeReading = (o) => o?.resourceType === 'Observation' && (o.category || []).some((c) => (c.coding || []).some((x) => x.code === RPM_CATEGORY.code));
export const isRpmPlan = (p) => p?.resourceType === 'CarePlan' && (p.category || []).some((c) => (c.coding || []).some((x) => x.code === RPM_PLAN_CATEGORY.code));
export const isRpmAlert = (t) => t?.resourceType === 'Task' && (t.code?.coding || []).some((c) => c.code === 'rpm-alert');
const ext = (doc, url) => (doc?.extension || []).find((e) => e.url === url)?.valueString ?? null;
export const programmeOf = (plan) => ext(plan, RPM_URLS.programme);
export const scheduleOf = (plan) => { try { return JSON.parse(ext(plan, RPM_URLS.schedule) || '{}'); } catch { return {}; } };
export const keyOf = (o) => READING_BY_CODE.get((o.code?.coding || []).find((c) => c.system === SYSTEMS.loinc)?.code)?.key ?? null;
export const whenOf = (o) => o.effectiveDateTime || o._validAt || o._recordedAt;

/** Threshold goals for a programme: one Goal per reading kind with a detail range. */
export function thresholdGoals(programme, patientRef, overrides = {}) {
  const spec = PROGRAMMES[programme];
  if (!spec) throw new HttpError(422, `Unknown programme "${programme}". Known: ${Object.keys(PROGRAMMES).join(', ')}`);
  return Object.entries(spec.thresholds).map(([key, t]) => {
    const r = READINGS[key];
    const o = overrides[key] || {};
    const low = o.low === undefined ? t.low : o.low; const high = o.high === undefined ? t.high : o.high;
    return { resourceType: 'Goal', lifecycleStatus: 'active', description: { text: `${r.name}: ${low ?? 'any'} to ${high ?? 'any'} ${r.unit}` }, subject: { reference: patientRef }, category: [{ coding: [RPM_PLAN_CATEGORY] }], target: [{ measure: { coding: [{ system: SYSTEMS.loinc, code: r.code, display: r.name }] }, detailRange: { ...(low != null ? { low: { value: low, unit: r.unit } } : {}), ...(high != null ? { high: { value: high, unit: r.unit } } : {}) } }] };
  });
}
export function thresholdsOf(goals) {
  const out = {};
  for (const g of goals) { const key = READING_BY_CODE.get(g.target?.[0]?.measure?.coding?.[0]?.code)?.key; if (!key || g.lifecycleStatus === 'cancelled') continue; out[key] = { low: g.target[0].detailRange?.low?.value ?? null, high: g.target[0].detailRange?.high?.value ?? null, goalId: g.id }; }
  return out;
}

/** Device plausibility: refuses impossible values; flags odd ones. Returns { ok, refuse, flag }. */
export function plausibility(key, value, previous = null, now = new Date().toISOString()) {
  const r = READINGS[key];
  if (!r) return { ok: false, refuse: `Unknown reading kind "${key}"` };
  if (!Number.isFinite(value)) return { ok: false, refuse: `${r.name} must be a number` };
  if (value < r.min || value > r.max) return { ok: false, refuse: `${r.name} ${value} ${r.unit} is outside what a device can measure (${r.min} to ${r.max}); the reading was refused` };
  if (key === 'weight' && previous && Math.abs(value - previous.value) > 10 && Math.abs(Date.parse(previous.at) - Date.parse(now)) < 3 * 86400000) return { ok: true, flag: `Weight changed by ${Math.round(Math.abs(value - previous.value) * 10) / 10} kg since ${previous.at.slice(0, 10)}: implausible for a real change, check the device` };
  if (key === 'sbp' && previous && Math.abs(value - previous.value) > 80) return { ok: true, flag: 'Systolic changed by more than 80 mm Hg since the last reading: check the cuff' };
  return { ok: true, flag: null };
}

export function readingObservation({ patientRef, key, value, at, deviceRef, source, flag, planRef }) {
  const r = READINGS[key];
  return {
    // Only the home-reading category: these never join the inpatient vitals, NEWS2 or the critical-result rules.
    resourceType: 'Observation', status: 'final', category: [{ coding: [RPM_CATEGORY] }],
    code: { coding: [{ system: SYSTEMS.loinc, code: r.code, display: r.name }] }, subject: { reference: patientRef }, effectiveDateTime: at,
    valueQuantity: { value, unit: r.unit, system: 'http://unitsofmeasure.org', code: r.unit }, method: { text: 'home' }, ...(deviceRef ? { device: { reference: deviceRef } } : {}),
    ...(planRef ? { basedOn: [{ reference: planRef }] } : {}),
    extension: [{ url: 'urn:hospital-desktop:reading-source', valueString: source }, ...(flag ? [{ url: RPM_URLS.plausibility, valueString: flag }] : [])],
  };
}

/** Rules over the readings of one patient. Returns alerts [{ rule, key, severity, message, reading }]. */
export function evaluate({ programme, thresholds, readings, now }) {
  const alerts = [];
  const byKey = (k) => readings.filter((o) => keyOf(o) === k && !ext(o, RPM_URLS.plausibility)).sort((a, b) => (whenOf(a) < whenOf(b) ? -1 : 1));
  for (const [key, t] of Object.entries(thresholds)) {
    const list = byKey(key);
    const latest = list[list.length - 1];
    if (!latest) continue;
    const v = latest.valueQuantity?.value;
    const r = READINGS[key];
    if (t.high != null && v > t.high) alerts.push({ rule: 'threshold-high', key, severity: v > t.high * 1.15 ? 'high' : 'medium', message: `${r.name} ${v} ${r.unit} is above the target of ${t.high}`, reading: latest.id });
    if (t.low != null && v < t.low) alerts.push({ rule: 'threshold-low', key, severity: v < t.low * 0.85 ? 'high' : 'medium', message: `${r.name} ${v} ${r.unit} is below the target of ${t.low}`, reading: latest.id });
  }
  if (programme === 'heart-failure') {
    const w = byKey('weight');
    const latest = w[w.length - 1];
    if (latest) { const base = w.filter((o) => Date.parse(whenOf(latest)) - Date.parse(whenOf(o)) <= 3 * 86400000 && o.id !== latest.id)[0]; if (base && latest.valueQuantity.value - base.valueQuantity.value >= 2) alerts.push({ rule: 'weight-gain', key: 'weight', severity: 'high', message: `Weight up ${Math.round((latest.valueQuantity.value - base.valueQuantity.value) * 10) / 10} kg in 3 days (${base.valueQuantity.value} to ${latest.valueQuantity.value} kg): possible fluid retention`, reading: latest.id }); }
  }
  const sbp = byKey('sbp').slice(-3);
  if (thresholds.sbp?.high != null && sbp.length === 3 && sbp.every((o) => o.valueQuantity.value > thresholds.sbp.high)) alerts.push({ rule: 'sbp-trend', key: 'sbp', severity: 'medium', message: `Three consecutive systolic readings above ${thresholds.sbp.high} (${sbp.map((o) => o.valueQuantity.value).join(', ')})`, reading: sbp[2].id });
  return alerts;
}

/** Adherence over the last `days`: expected readings from the schedule versus days with a reading per kind. Missed alerts after 2 days without any reading. */
export function adherence({ schedule, readings, now, days = 7 }) {
  const dayOf = (iso) => iso.slice(0, 10);
  const start = Date.parse(now) - days * 86400000;
  let expected = 0; let done = 0;
  const perKey = {};
  for (const [key, perDay] of Object.entries(schedule)) {
    const got = new Set(readings.filter((o) => keyOf(o) === key && Date.parse(whenOf(o)) >= start).map((o) => dayOf(whenOf(o))));
    perKey[key] = { expectedDays: days, daysWithReading: got.size, perDay };
    expected += days * perDay; done += Math.min(days * perDay, readings.filter((o) => keyOf(o) === key && Date.parse(whenOf(o)) >= start).length);
  }
  const lastAny = readings.map(whenOf).sort().pop() || null;
  const missedDays = lastAny ? Math.floor((Date.parse(now) - Date.parse(lastAny)) / 86400000) : days;
  return { percent: expected ? Math.round((done / expected) * 100) : null, perKey, lastReading: lastAny, missedDays, missed: Object.keys(schedule).length > 0 && missedDays >= 2 };
}

/** True when an open alert for the same rule and kind already exists (de-duplication) or is snoozed. */
export function duplicateOf(alert, openAlerts, now) {
  return openAlerts.find((t) => ext(t, RPM_URLS.rule) === `${alert.rule}:${alert.key}` && (!ext(t, RPM_URLS.snoozed) || ext(t, RPM_URLS.snoozed) > now)) || null;
}

export function alertTask({ patientRef, planRef, alert, now }) {
  return {
    resourceType: 'Task', status: 'requested', intent: 'order', priority: SEVERITY[alert.severity], authoredOn: now, for: { reference: patientRef }, basedOn: [{ reference: planRef }],
    ...(alert.reading ? { focus: { reference: `Observation/${alert.reading}` } } : {}),
    code: { coding: [{ system: TASK_SYSTEM, code: 'rpm-alert' }], text: alert.message }, description: `${alert.rule} (${alert.severity}). Home reading; not an inpatient critical result.`,
    owner: { display: 'Care team' }, requester: { display: 'Monitoring rules' }, extension: [{ url: RPM_URLS.rule, valueString: `${alert.rule}:${alert.key}` }],
  };
}
