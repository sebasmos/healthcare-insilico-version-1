// Synthetic 12-lead ECG generator. Seeded and parameterised; it
// produces a WFDB-shaped record (format 16, 500 Hz, 10 seconds, 12 leads)
// that wfdb.toObservation turns into the same FHIR sampled-data Observation
// as an imported record, so the viewer cannot tell them apart.
//
// The beat is a sum of Gaussian waves (P, Q, R, S, T) projected onto each
// lead from a mean electrical axis. It is a teaching-grade waveform for a
// simulation, not a physiological model, and must not be used as clinical
// reference. Rhythms: normal, sinus-tachycardia, atrial-fibrillation, stemi,
// lbbb, hyperkalaemia.

export const RHYTHMS = {
  normal: { label: 'Normal sinus rhythm', rate: 72, pr: 160, qrs: 90, qt: 400, axis: 60, interpretation: 'Normal sinus rhythm. Normal axis. No acute ST or T wave change.' },
  'sinus-tachycardia': { label: 'Sinus tachycardia', rate: 118, pr: 140, qrs: 88, qt: 320, axis: 70, interpretation: 'Sinus tachycardia. Normal axis. No acute ST change.' },
  'atrial-fibrillation': { label: 'Atrial fibrillation', rate: 110, pr: null, qrs: 90, qt: 360, axis: 50, irregular: true, noP: true, interpretation: 'Atrial fibrillation with a rapid ventricular response. Irregularly irregular, no P waves.' },
  stemi: { label: 'ST elevation (anterior)', rate: 90, pr: 160, qrs: 96, qt: 400, axis: 40, stElevation: ['V1', 'V2', 'V3', 'V4'], stDepression: ['III', 'aVF'], critical: true, interpretation: 'Sinus rhythm. ST elevation in V1 to V4 with reciprocal depression in III and aVF: acute anterior STEMI pattern. Critical result.' },
  lbbb: { label: 'Left bundle branch block', rate: 76, pr: 170, qrs: 150, qt: 460, axis: -20, wide: true, interpretation: 'Sinus rhythm with left bundle branch block (QRS 150 ms). Left axis.' },
  hyperkalaemia: { label: 'Hyperkalaemia (peaked T waves)', rate: 64, pr: 210, qrs: 118, qt: 420, axis: 30, peakedT: true, interpretation: 'Sinus bradycardia, prolonged PR, widened QRS and tall peaked T waves: pattern consistent with hyperkalaemia.' },
};

export const LEAD_NAMES = ['I', 'II', 'III', 'aVR', 'aVL', 'aVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'];
// Projection of a frontal-plane vector at angle `axis` (degrees, Ecgcasetwo) onto each limb lead,
// and fixed chest-lead multipliers for the R and S parts (a textbook R progression).
const limb = (axis, lead) => Math.cos(((axis - { I: 0, II: 60, III: 120, aVR: -150, aVL: -30, aVF: 90 }[lead]) * Math.PI) / 180);
const CHEST = { V1: { r: 0.2, s: -1.2 }, V2: { r: 0.4, s: -1.4 }, V3: { r: 0.8, s: -0.9 }, V4: { r: 1.4, s: -0.5 }, V5: { r: 1.5, s: -0.2 }, V6: { r: 1.2, s: -0.1 } };

/** Deterministic pseudo-random numbers (mulberry32). */
export function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const gauss = (t, centre, width, amp) => amp * Math.exp(-((t - centre) ** 2) / (2 * width * width));

/** One lead's millivolt value at time t (seconds) for a beat starting at `start`. */
function beatValue(t, start, lead, r, rand) {
  const s = t - start;
  const qrsW = (r.qrs / 1000) / 4.5;
  const amp = LEAD_NAMES.indexOf(lead) < 6 ? limb(r.axis, lead) : null;
  const rAmp = amp !== null ? 1.2 * amp : CHEST[lead].r;
  const sAmp = amp !== null ? -0.25 * Math.abs(amp) - 0.05 : CHEST[lead].s;
  const pAmp = r.noP ? 0 : (amp !== null ? 0.12 * Math.max(0.2, amp) : 0.08);
  let v = 0;
  if (!r.noP) v += gauss(s, 0.0, 0.025, pAmp);
  const qrsStart = (r.pr ?? 140) / 1000;
  v += gauss(s, qrsStart - 0.012, qrsW * 0.8, -0.1 * Math.abs(rAmp));
  v += gauss(s, qrsStart + qrsW * 1.2, qrsW, rAmp);
  v += gauss(s, qrsStart + qrsW * 3, qrsW * 1.1, sAmp);
  if (r.wide) v += gauss(s, qrsStart + qrsW * 3.8, qrsW * 1.6, rAmp * 0.55);
  const tCentre = qrsStart + (r.qt / 1000) - 0.08;
  let tAmp = amp !== null ? 0.3 * Math.max(0.15, amp) : 0.25 + 0.1 * CHEST[lead].r;
  if (r.peakedT) tAmp *= 2.6;
  if (r.wide) tAmp *= -0.7;
  v += gauss(s, tCentre, r.peakedT ? 0.035 : 0.06, tAmp);
  if (r.stElevation?.includes(lead)) v += 0.3 * (s > qrsStart + qrsW * 3.5 && s < tCentre ? 1 : 0) + gauss(s, tCentre - 0.05, 0.06, 0.2);
  if (r.stDepression?.includes(lead)) v -= 0.12 * (s > qrsStart + qrsW * 3.5 && s < tCentre ? 1 : 0);
  if (r.noP && rand) v += 0.04 * (rand() - 0.5);
  return v;
}

/**
 * Generates a record: { name, fs, nsamp, signals: [{ description, gain, baseline, units, format, samples: Int16Array }], params }.
 * gain 1000 ADC units per mV, baseline 0, 500 Hz, 10 seconds.
 */
export function generateEcg({ rhythm = 'normal', seed = 1, seconds = 10, fs = 500, rateOverride = null } = {}) {
  const spec = RHYTHMS[rhythm];
  if (!spec) throw new Error(`Unknown rhythm "${rhythm}". Known: ${Object.keys(RHYTHMS).join(', ')}`);
  const rand = rng(seed);
  const r = { ...spec, rate: rateOverride ?? spec.rate };
  const n = Math.round(seconds * fs);
  const beats = [];
  let t = 0.1 + rand() * 0.2;
  while (t < seconds + 1) {
    beats.push(t);
    const rr = 60 / r.rate;
    t += r.irregular ? rr * (0.65 + 0.7 * rand()) : rr * (1 + 0.01 * (rand() - 0.5));
  }
  const measuredRate = Math.round((60 * (beats.length - 1)) / (beats[beats.length - 1] - beats[0]));
  const signals = LEAD_NAMES.map((lead) => {
    const samples = new Int16Array(n);
    const noise = rng(seed * 31 + LEAD_NAMES.indexOf(lead));
    for (let i = 0; i < n; i += 1) {
      const time = i / fs;
      let v = 0.01 * Math.sin(2 * Math.PI * 0.25 * time);
      for (const b of beats) if (time >= b - 0.1 && time <= b + 0.7) v += beatValue(time, b, lead, r, r.noP ? noise : null);
      v += 0.005 * (noise() - 0.5);
      samples[i] = Math.max(-32768, Math.min(32767, Math.round(v * 1000)));
    }
    return { description: lead, gain: 1000, baseline: 0, units: 'mV', format: '16', file: `${rhythm}-${seed}.dat`, byteOffset: 0, samples };
  });
  const qtc = Math.round(r.qt / Math.sqrt(60 / measuredRate));
  return { name: `${rhythm}-${seed}`, fs, nsamp: n, signals, baseTime: null, baseDate: null, params: { rhythm, label: spec.label, seed, rate: measuredRate, pr: r.pr, qrs: r.qrs, qt: r.qt, qtc, axis: r.axis, critical: Boolean(spec.critical), interpretation: spec.interpretation } };
}

/** Writes a record as WFDB files (format 16, one .dat for all leads) into dir. Returns the two paths. */
export function writeWfdb(record, dir, fsMod, pathMod) {
  fsMod.mkdirSync(dir, { recursive: true });
  const n = record.nsamp;
  const buf = Buffer.alloc(n * record.signals.length * 2);
  record.signals.forEach((s, k) => { for (let t = 0; t < n; t += 1) buf.writeInt16LE(s.samples[t], (t * record.signals.length + k) * 2); });
  const dat = `${record.name}.dat`;
  fsMod.writeFileSync(pathMod.join(dir, dat), buf);
  const hea = [`${record.name} ${record.signals.length} ${record.fs} ${n}`, ...record.signals.map((s) => `${dat} 16 ${s.gain}(0)/mV 16 0 0 0 0 ${s.description}`), `# synthetic ${record.params.rhythm} seed ${record.params.seed} (hospital-desktop gen-ecg)`].join('\n') + '\n';
  fsMod.writeFileSync(pathMod.join(dir, `${record.name}.hea`), hea);
  return { hea: pathMod.join(dir, `${record.name}.hea`), dat: pathMod.join(dir, dat) };
}
