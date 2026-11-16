// NEWS2 early-warning score. Scoring bands are taken from the
// Royal College of Physicians, "National Early Warning Score (NEWS) 2:
// Standardising the assessment of acute-illness severity in the NHS",
// December 2017, the NEWS2 chart on page 15 (RCP, London). This is decision
// support inside a simulation; it is labelled as such wherever it is shown.
//
// Inputs: respiration rate (/min), SpO2 (%), spo2Scale (1 or 2),
// supplementalOxygen (boolean), systolic blood pressure (mm Hg), pulse (/min),
// consciousness (A, C, V, P or U), temperature (Celsius).
// A missing parameter makes the result "incomplete": no total is given, so a
// partial set can never look like a low score.

export const PARAMETERS = ['respirationRate', 'spo2', 'supplementalOxygen', 'systolic', 'pulse', 'consciousness', 'temperature'];

const band = (value, rows) => rows.find(([low, high]) => (low == null || value >= low) && (high == null || value <= high))[2];

export function scoreRespiration(rr) { return band(rr, [[null, 8, 3], [9, 11, 1], [12, 20, 0], [21, 24, 2], [25, null, 3]]); }
export function scoreSpo2(spo2, { scale = 1, supplementalOxygen = false } = {}) {
  if (scale === 2) {
    if (spo2 <= 83) return 3;
    if (spo2 <= 85) return 2;
    if (spo2 <= 87) return 1;
    if (spo2 <= 92) return 0;
    if (!supplementalOxygen) return 0;
    if (spo2 <= 94) return 1;
    if (spo2 <= 96) return 2;
    return 3;
  }
  return band(spo2, [[null, 91, 3], [92, 93, 2], [94, 95, 1], [96, null, 0]]);
}
export const scoreOxygen = (supplementalOxygen) => (supplementalOxygen ? 2 : 0);
export function scoreSystolic(sbp) { return band(sbp, [[null, 90, 3], [91, 100, 2], [101, 110, 1], [111, 219, 0], [220, null, 3]]); }
export function scorePulse(hr) { return band(hr, [[null, 40, 3], [41, 50, 1], [51, 90, 0], [91, 110, 1], [111, 130, 2], [131, null, 3]]); }
export function scoreConsciousness(level) { return String(level).toUpperCase() === 'A' ? 0 : 3; }
export function scoreTemperature(t) {
  if (t <= 35.0) return 3;
  if (t <= 36.0) return 1;
  if (t <= 38.0) return 0;
  if (t <= 39.0) return 1;
  return 2;
}

export const RESPONSE = {
  low: 'Low: routine monitoring (minimum 12-hourly)',
  'low-medium': 'Low to medium: urgent ward-based review (a single parameter scored 3)',
  medium: 'Medium: urgent review by a clinician competent in acute illness',
  high: 'High: emergency response',
};

/** Returns { incomplete, missing, total, components, singleThree, band, response }. */
export function scoreNews2(input = {}) {
  const v = { ...input };
  const missing = PARAMETERS.filter((k) => v[k] === undefined || v[k] === null || v[k] === '');
  if (missing.length) return { incomplete: true, missing, total: null, components: {}, singleThree: false, band: null, response: 'Incomplete: not every NEWS2 parameter was recorded' };
  const acvpu = String(v.consciousness).toUpperCase();
  if (!['A', 'C', 'V', 'P', 'U'].includes(acvpu)) throw new Error(`consciousness must be one of A, C, V, P, U (got "${v.consciousness}")`);
  const components = {
    respirationRate: scoreRespiration(Number(v.respirationRate)),
    spo2: scoreSpo2(Number(v.spo2), { scale: Number(v.spo2Scale) === 2 ? 2 : 1, supplementalOxygen: Boolean(v.supplementalOxygen) }),
    supplementalOxygen: scoreOxygen(Boolean(v.supplementalOxygen)),
    systolic: scoreSystolic(Number(v.systolic)),
    pulse: scorePulse(Number(v.pulse)),
    consciousness: scoreConsciousness(acvpu),
    temperature: scoreTemperature(Number(v.temperature)),
  };
  const total = Object.values(components).reduce((a, b) => a + b, 0);
  const singleThree = Object.values(components).some((c) => c === 3);
  let bandName = 'low';
  if (total >= 7) bandName = 'high';
  else if (total >= 5) bandName = 'medium';
  else if (singleThree) bandName = 'low-medium';
  return { incomplete: false, missing: [], total, components, singleThree, band: bandName, response: RESPONSE[bandName], scale: Number(v.spo2Scale) === 2 ? 2 : 1 };
}

/** A score of 5 or more, or any single parameter scoring 3, needs escalation to the physician. */
export const needsEscalation = (score) => !score.incomplete && (score.total >= 5 || score.singleThree);
