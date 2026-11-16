// Generated from ehr/server/wearables.mjs by the job 5 build step: the pure stream generator, for the editor's preview chart. Keep in step with the server copy.
export const DEVICES = { watch: 'Watch', patch: 'Patch', 'bp-cuff': 'Home blood pressure cuff', scale: 'Scale', 'pulse-oximeter': 'Pulse oximeter', 'glucose-sensor': 'Glucose sensor' };
export const MEASURES = {
  'heart-rate': { key: 'hr', name: 'Heart rate', unit: '/min', mean: 72, sd: 5, rhythm: 10, min: 35, max: 220 },
  spo2: { key: 'spo2', name: 'Oxygen saturation', unit: '%', mean: 96.5, sd: 0.8, rhythm: 0.6, min: 70, max: 100 },
  weight: { key: 'weight', name: 'Body weight', unit: 'kg', mean: 78, sd: 0.25, rhythm: 0, min: 30, max: 300, daily: true },
  glucose: { key: 'glucose', name: 'Glucose', unit: 'mg/dL', mean: 112, sd: 14, rhythm: 22, min: 40, max: 600 },
  'blood-pressure': { key: 'sbp', name: 'Systolic blood pressure', unit: 'mm[Hg]', mean: 128, sd: 7, rhythm: 6, min: 70, max: 240 },
  rhythm: { code: '8884-9', name: 'Heart rhythm', text: true },
  steps: { code: '55423-8', name: 'Steps', unit: '{steps}', mean: 320, sd: 160, rhythm: 320, min: 0, max: 5000, hourly: true },
  sleep: { code: '93832-4', name: 'Sleep duration', unit: 'h', mean: 7, sd: 0.6, rhythm: 0, min: 0, max: 14, daily: true },
};
export const EPISODES = { af: 'Atrial fibrillation episode', desaturation: 'Night-time oxygen drop', 'weight-gain': 'Gradual weight gain', 'glucose-spike': 'Glucose spike' };
const EPISODE_MEASURE = { af: ['heart-rate', 'rhythm'], desaturation: ['spo2'], 'weight-gain': ['weight'], 'glucose-spike': ['glucose'] };
const RAW_WINDOW = 60;

export function normalizeStream(input = {}) {
  const device = DEVICES[input.device] ? input.device : 'watch';
  const measures = [...new Set(([].concat(input.measures || [])).filter((m) => MEASURES[m]))];
  if (!measures.length) measures.push('heart-rate');
  const rateMinutes = Math.max(1, Math.min(1440, Number(input.rateMinutes) || 15));
  const seed = Number.isInteger(input.seed) ? input.seed : 1;
  const baseline = {};
  for (const m of measures) { const b = input.baseline?.[m] || {}; const d = MEASURES[m]; baseline[m] = { mean: Number.isFinite(Number(b.mean)) ? Number(b.mean) : d.mean, sd: Number.isFinite(Number(b.sd)) ? Math.max(0, Number(b.sd)) : d.sd }; }
  const episodes = ([].concat(input.episodes || [])).map((e, i) => {
    if (!EPISODES[e?.kind]) throw new Error(`Stream episode ${i + 1}: kind must be one of ${Object.keys(EPISODES).join(', ')}`);
    const startMinutes = Math.max(0, Number(e.startMinutes) || 0); const durationMinutes = Math.max(5, Number(e.durationMinutes) || 60);
    return { kind: e.kind, startMinutes, durationMinutes, magnitude: Number.isFinite(Number(e.magnitude)) ? Number(e.magnitude) : { af: 45, desaturation: 8, 'weight-gain': 2.5, 'glucose-spike': 110 }[e.kind] };
  });
  return { device, measures, rateMinutes, seed, baseline, episodes, durationMinutes: Math.max(5, Number(input.durationMinutes) || 1440) };
}

/** A small deterministic generator. */
export function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = (rnd) => { const u = 1 - rnd(); const v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const inEpisode = (stream, m, at) => stream.episodes.find((e) => EPISODE_MEASURE[e.kind].includes(m) && at >= e.startMinutes && at < e.startMinutes + e.durationMinutes) || null;
const episodeEffect = (e, m, at) => {
  const f = (at - e.startMinutes) / e.durationMinutes;
  if (e.kind === 'af' && m === 'heart-rate') return e.magnitude * (0.7 + 0.3 * Math.sin(f * Math.PI));
  if (e.kind === 'desaturation' && m === 'spo2') return -e.magnitude * Math.sin(f * Math.PI);
  if (e.kind === 'weight-gain' && m === 'weight') return e.magnitude * f;
  if (e.kind === 'glucose-spike' && m === 'glucose') return e.magnitude * Math.sin(f * Math.PI);
  return 0;
};

/** Readings between two moments (minutes from T0), in sample order. Raw rate inside episodes and a window around them; hourly (daily for weight and sleep) elsewhere. */
export function generateStream(stream, fromMinutes, toMinutes, { seed = stream.seed } = {}) {
  const out = [];
  for (const m of stream.measures) {
    const d = MEASURES[m]; const b = stream.baseline[m] || { mean: d.mean, sd: d.sd };
    const rnd = mulberry32(seed * 7919 + m.length * 131);
    const rate = d.daily ? 1440 : d.hourly ? 60 : stream.rateMinutes;
    const first = Math.ceil(fromMinutes / rate) * rate;
    let drift = 0;
    for (let at = first; at < toMinutes; at += rate) {
      const noise = gauss(rnd);
      const hour = ((at % 1440) + 1440) % 1440 / 60;
      const ep = inEpisode(stream, m, at);
      const nearEpisode = stream.episodes.some((e) => EPISODE_MEASURE[e.kind].includes(m) && at >= e.startMinutes - RAW_WINDOW && at < e.startMinutes + e.durationMinutes + RAW_WINDOW);
      if (!nearEpisode && !d.daily && !d.hourly && at % 60 !== 0) continue;
      if (m === 'rhythm') { out.push({ at, measure: m, value: ep?.kind === 'af' ? 'atrial fibrillation' : 'sinus rhythm', episode: ep?.kind ?? null }); continue; }
      const rhythm = (d.rhythm || 0) * (m === 'steps' ? Math.max(0, Math.sin(((hour - 6) / 16) * Math.PI)) : Math.sin(((hour - 3) / 24) * 2 * Math.PI));
      drift = drift * 0.9 + noise * (b.sd || 0) * 0.3;
      let value = (b.mean ?? d.mean) + rhythm + noise * (b.sd ?? d.sd) + drift + (ep ? episodeEffect(ep, m, at) : 0);
      if (m === 'steps' && (hour < 6 || hour > 23)) value = Math.abs(noise) * 10;
      value = Math.max(d.min, Math.min(d.max, value));
      out.push({ at, measure: m, value: Math.round(value * 10) / 10, episode: ep?.kind ?? null, raw: nearEpisode });
    }
  }
  return out.sort((a, b) => a.at - b.at || a.measure.localeCompare(b.measure));
}

/** Per-hour and per-day summaries (min, max, mean, n) per measure. */
export function summarize(readings) {
  const bucket = (size) => { const map = new Map(); for (const r of readings) { if (typeof r.value !== 'number') continue; const k = `${r.measure}|${Math.floor(r.at / size) * size}`; const s = map.get(k) || { measure: r.measure, at: Math.floor(r.at / size) * size, min: Infinity, max: -Infinity, sum: 0, n: 0, episodes: 0 }; s.min = Math.min(s.min, r.value); s.max = Math.max(s.max, r.value); s.sum += r.value; s.n += 1; if (r.episode) s.episodes += 1; map.set(k, s); } return [...map.values()].map((s) => ({ measure: s.measure, at: s.at, min: s.min, max: s.max, mean: Math.round((s.sum / s.n) * 100) / 100, n: s.n, episodes: s.episodes })).sort((a, b) => a.at - b.at || a.measure.localeCompare(b.measure)); };
  return { hour: bucket(60), day: bucket(1440) };
}


/** A small preview series for the editor: hourly means per measure over the whole stream (at most 400 points per measure). */
export function previewSeries(stream, durationMinutes) {
  const readings = generateStream(normalizeStream({ ...stream, durationMinutes }), 0, durationMinutes);
  const { hour } = summarize(readings);
  const out = {};
  for (const m of stream.measures || []) { const pts = hour.filter((h) => h.measure === m); const step = Math.max(1, Math.ceil(pts.length / 400)); out[m] = pts.filter((_, i) => i % step === 0).map((h) => [h.at, h.mean]); }
  return out;
}

