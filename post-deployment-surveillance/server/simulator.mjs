// The reporting-database problem as a simulation ("Surveillance study"): report streams with a known truth, so the
// detection methods can be measured. Nothing here is stored as a patient or a report in the hospital: a study is a
// config, a seed and its measured results. The same seed always gives the same stream.
import { sequential, THRESHOLDS } from './stats.mjs';

export const HARMS = ['wrong', 'harmful', 'biased', 'hallucinated', 'unsafe', 'omitted', 'privacy', 'workflow', 'other'];
export const SEVERITIES = ['near-miss', 'none', 'mild', 'moderate', 'severe', 'life-threatening', 'death'];
export const SOURCE_SETS = { human: ['human'], automatic: ['automatic'], agent: ['agent'], combined: ['human', 'automatic', 'agent'] };
export const METHODS = ['prr', 'ror', 'ic', 'ebgm', 'poisson', 'cusum', 'maxsprt'];

function rng(seed) { let a = (Number(seed) || 1) >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function poisson(r, mean) { if (mean <= 0) return 0; if (mean > 50) { const u = Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()); return Math.max(0, Math.round(mean + Math.sqrt(mean) * u)); } const l = Math.exp(-mean); let k = 0; let p = 1; do { k += 1; p *= r(); } while (p > l); return k - 1; }
const pick = (r, weights) => { const total = Object.values(weights).reduce((s, w) => s + w, 0); let x = r() * total; for (const [k, w] of Object.entries(weights)) { x -= w; if (x <= 0) return k; } return Object.keys(weights)[0]; };
const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);

export function normalizeConfig(input = {}) {
  const s = input.signal || {}; const rp = input.reporting || {};
  return {
    agents: clamp(input.agents, 1, 12, 3), versions: clamp(input.versions, 1, 6, 2), days: clamp(input.days, 14, 730, 120), usesPerDay: clamp(input.usesPerDay, 1, 20000, 200),
    baseRate: clamp(input.baseRate, 0.00001, 0.5, 0.004), harmMix: input.harmMix && typeof input.harmMix === 'object' ? input.harmMix : { wrong: 4, hallucinated: 3, omitted: 2, unsafe: 1, harmful: 1, biased: 1 },
    severityMix: input.severityMix && typeof input.severityMix === 'object' ? input.severityMix : { 'near-miss': 4, none: 3, mild: 3, moderate: 2, severe: 1, 'life-threatening': 0.2, death: 0.05 },
    subgroups: Array.isArray(input.subgroups) && input.subgroups.length ? input.subgroups.map(String).slice(0, 8) : ['group-a', 'group-b', 'group-c', 'group-d'], sites: Array.isArray(input.sites) && input.sites.length ? input.sites.map(String).slice(0, 6) : ['site-1', 'site-2'],
    // The planted truth: nothing ('none'), a new version with a higher rate, a drift from a date, or a higher rate in one subgroup only.
    signal: { kind: ['none', 'version', 'drift', 'subgroup'].includes(s.kind) ? s.kind : 'version', day: clamp(s.day, 1, 700, 60), agent: clamp(s.agent, 0, 11, 0), harm: HARMS.includes(s.harm) ? s.harm : 'hallucinated', factor: clamp(s.factor, 1, 50, 4), subgroup: s.subgroup ? String(s.subgroup) : 'group-a' },
    reporting: {
      underReport: { 'near-miss': 0.9, none: 0.9, mild: 0.8, moderate: 0.6, severe: 0.3, 'life-threatening': 0.15, death: 0.1, ...(rp.underReport || {}) }, // chance a real event is NOT reported by a person
      delayDays: clamp(rp.delayDays, 0, 60, 3), missingFields: clamp(rp.missingFields, 0, 1, 0.2), duplicates: clamp(rp.duplicates, 0, 1, 0.05),
      notoriety: rp.notoriety ? { day: clamp(rp.notoriety.day, 0, 700, 80), factor: clamp(rp.notoriety.factor, 1, 20, 3), days: clamp(rp.notoriety.days, 1, 120, 14) } : null, // a stimulated spike after publicity
      weber: rp.weber ? { factor: clamp(rp.weber.factor, 1, 20, 2), days: clamp(rp.weber.days, 1, 365, 30) } : null, // more reports early in a version's life
      masking: rp.masking ? { harm: HARMS.includes(rp.masking.harm) ? rp.masking.harm : 'workflow', rate: clamp(rp.masking.rate, 0, 0.5, 0.02) } : null, // one very common error everywhere
      siteFactor: rp.siteFactor && typeof rp.siteFactor === 'object' ? rp.siteFactor : {}, // reporting culture by site
      automatic: { sensitivity: clamp(rp.automatic?.sensitivity, 0, 1, 0.55), falsePer1000: clamp(rp.automatic?.falsePer1000, 0, 100, 0.5) },
      agent: { sensitivity: clamp(rp.agent?.sensitivity, 0, 1, 0.4), falsePer1000: clamp(rp.agent?.falsePer1000, 0, 100, 1) },
    },
    seeds: clamp(input.seeds, 1, 500, 20), thresholds: input.thresholds && typeof input.thresholds === 'object' ? { ...THRESHOLDS, ...input.thresholds } : THRESHOLDS,
  };
}

/** One stream: per day, uses per agent and reports per source, agent and harm. */
export function simulateStream(cfg, seed) {
  const r = rng(seed); const days = []; const harms = Object.keys(cfg.harmMix); const share = (h) => cfg.harmMix[h] / Object.values(cfg.harmMix).reduce((s, w) => s + w, 0);
  const pending = []; // reports that arrive later: { day, source, agent, harm }
  const versionOf = (agent, day) => (cfg.signal.kind === 'version' && agent === cfg.signal.agent && day >= cfg.signal.day ? cfg.versions : Math.min(cfg.versions - 1 || 1, 1 + Math.floor((day / cfg.days) * Math.max(1, cfg.versions - 1))));
  const releaseDay = (agent, day) => (cfg.signal.kind === 'version' && agent === cfg.signal.agent && day >= cfg.signal.day ? cfg.signal.day : 0);
  for (let day = 0; day < cfg.days; day += 1) {
    const row = { day, uses: new Array(cfg.agents).fill(0), reports: [], truth: 0 };
    for (let agent = 0; agent < cfg.agents; agent += 1) {
      const uses = poisson(r, cfg.usesPerDay); row.uses[agent] = uses;
      for (const harm of harms) {
        const target = agent === cfg.signal.agent && harm === cfg.signal.harm && cfg.signal.kind !== 'none' && day >= cfg.signal.day;
        const drift = cfg.signal.kind === 'drift' && target ? 1 + (cfg.signal.factor - 1) * Math.min(1, (day - cfg.signal.day) / 30) : 1;
        // A subgroup-only signal raises the rate for one group, which holds an equal share of the uses.
        const lift = !target ? 1 : cfg.signal.kind === 'version' ? cfg.signal.factor : cfg.signal.kind === 'drift' ? drift : 1 + (cfg.signal.factor - 1) / cfg.subgroups.length;
        const events = poisson(r, uses * cfg.baseRate * share(harm) * lift); if (target) row.truth += events;
        for (let e = 0; e < events; e += 1) {
          const severity = pick(r, cfg.severityMix); const site = cfg.sites[Math.floor(r() * cfg.sites.length)];
          const subgroup = target && cfg.signal.kind === 'subgroup' && r() < (cfg.signal.factor - 1) / (cfg.signal.factor - 1 + cfg.subgroups.length) ? cfg.signal.subgroup : cfg.subgroups[Math.floor(r() * cfg.subgroups.length)];
          let pReport = 1 - (cfg.reporting.underReport[severity] ?? 0.8); pReport *= cfg.reporting.siteFactor[site] ?? 1;
          const n = cfg.reporting.notoriety; if (n && day >= n.day && day < n.day + n.days) pReport *= n.factor;
          const w = cfg.reporting.weber; if (w && day - releaseDay(agent, day) < w.days && releaseDay(agent, day) > 0) pReport *= w.factor;
          const base = { agent, harm, severity, site, subgroup, version: versionOf(agent, day), incomplete: r() < cfg.reporting.missingFields };
          if (r() < Math.min(1, pReport)) { const at = day + poisson(r, cfg.reporting.delayDays); pending.push({ ...base, day: at, source: 'human' }); if (r() < cfg.reporting.duplicates) pending.push({ ...base, day: at + 1, source: 'human', duplicate: true }); }
          if (r() < cfg.reporting.automatic.sensitivity) pending.push({ ...base, day, source: 'automatic' });
          if (r() < cfg.reporting.agent.sensitivity) pending.push({ ...base, day: day + (r() < 0.5 ? 0 : 1), source: 'agent' });
        }
      }
      if (cfg.reporting.masking) for (let i = poisson(r, uses * cfg.reporting.masking.rate * 0.2); i > 0; i -= 1) pending.push({ agent, harm: cfg.reporting.masking.harm, severity: 'none', day, source: 'human', masking: true });
      for (const source of ['automatic', 'agent']) for (let i = poisson(r, (uses * cfg.reporting[source].falsePer1000) / 1000); i > 0; i -= 1) pending.push({ agent, harm: harms[Math.floor(r() * harms.length)], severity: 'none', day, source, falsePositive: true });
    }
    days.push(row);
  }
  for (const p of pending) if (p.day < cfg.days) days[p.day].reports.push(p);
  return days;
}

/** Runs every method on one agent and harm pair for one set of sources. Returns each method's first signal. */
export function detect(cfg, days, { agent, harm, sources }) {
  const expectedReporting = { human: 1 - weightedUnder(cfg), automatic: cfg.reporting.automatic.sensitivity, agent: cfg.reporting.agent.sensitivity };
  const share = cfg.harmMix[harm] ? cfg.harmMix[harm] / Object.values(cfg.harmMix).reduce((s, w) => s + w, 0) : 0;
  // The baseline is what would be reported with no signal: the true base rate times the chance each source picks an event up, plus its false alarms.
  const baseline = sources.reduce((s, src) => s + cfg.baseRate * share * expectedReporting[src] + (src === 'human' ? 0 : cfg.reporting[src].falsePer1000 / 1000 / Object.keys(cfg.harmMix).length), 0);
  const periods = days.map((d) => { const rs = d.reports.filter((x) => sources.includes(x.source)); const a = rs.filter((x) => x.agent === agent && x.harm === harm).length; const b = rs.filter((x) => x.agent === agent && x.harm !== harm).length; const c = rs.filter((x) => x.agent !== agent && x.harm === harm).length; return { at: d.day, events: a, uses: d.uses[agent], a, b, c, d: rs.length - a - b - c }; });
  return sequential(periods, { baseline, thresholds: cfg.thresholds }).signals;
}
function weightedUnder(cfg) { const total = Object.values(cfg.severityMix).reduce((s, w) => s + w, 0); return Object.entries(cfg.severityMix).reduce((s, [sev, w]) => s + (w / total) * (cfg.reporting.underReport[sev] ?? 0.8), 0); }

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
/** The whole study: many seeds, every method, every set of sources. */
export function runStudy(input, seed = 1) {
  const cfg = normalizeConfig(input); const planted = cfg.signal.kind !== 'none';
  const harms = Object.keys(cfg.harmMix); const target = { agent: cfg.signal.agent, harm: cfg.signal.harm };
  // Pairs with no planted signal, on which every alarm is a false one.
  const nulls = []; for (let a = 0; a < cfg.agents && nulls.length < 4; a += 1) for (const h of harms) { if ((a !== target.agent || h !== target.harm) && nulls.length < 4 && h !== cfg.reporting.masking?.harm) nulls.push({ agent: a, harm: h }); }
  const tally = {}; for (const set of Object.keys(SOURCE_SETS)) { tally[set] = {}; for (const m of METHODS) tally[set][m] = { detected: 0, early: 0, missed: 0, falseAlarms: 0, nullsTested: 0, delays: [] }; }
  for (let i = 0; i < cfg.seeds; i += 1) {
    const days = simulateStream(cfg, seed * 1000 + i);
    for (const [set, sources] of Object.entries(SOURCE_SETS)) {
      const hit = planted ? detect(cfg, days, { ...target, sources }) : null;
      for (const m of METHODS) { const t = tally[set][m];
        if (planted) { const s = hit[m]; if (!s) t.missed += 1; else if (s.at < cfg.signal.day) { t.early += 1; t.falseAlarms += 1; } else { t.detected += 1; t.delays.push(s.at - cfg.signal.day); } }
        for (const pair of nulls) { t.nullsTested += 1; if (detect(cfg, days, { ...pair, sources })[m]) t.falseAlarms += 1; } }
    }
  }
  const results = []; for (const [set, methods] of Object.entries(tally)) for (const [m, t] of Object.entries(methods)) results.push({ sources: set, method: m, runs: cfg.seeds, detected: t.detected, missed: t.missed, signalledBeforeTheTruth: t.early, falseAlarms: t.falseAlarms, nullPairsTested: t.nullsTested, medianDaysToDetection: median(t.delays), positivePredictiveValue: t.detected + t.falseAlarms ? Math.round((t.detected / (t.detected + t.falseAlarms)) * 1000) / 1000 : null });
  return { config: cfg, seed, planted: planted ? { ...cfg.signal } : null, results };
}
export function studyCsv(study) { const cols = ['sources', 'method', 'runs', 'detected', 'missed', 'signalledBeforeTheTruth', 'falseAlarms', 'nullPairsTested', 'medianDaysToDetection', 'positivePredictiveValue']; return [cols.join(','), ...study.results.map((r) => cols.map((c) => r[c] ?? '').join(','))].join('\n'); }
