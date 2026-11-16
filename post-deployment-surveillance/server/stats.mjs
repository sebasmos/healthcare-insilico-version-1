// Statistics for Surveillance and Reporting. Pure functions, no storage. Rates are always per 1,000 uses.
// Methods (named so results can be checked against the literature): Wilson score interval; exact binomial and
// Poisson tails; Benjamini-Hochberg false discovery rate; proportional reporting ratio (PRR) and reporting odds
// ratio (ROR) with log-normal intervals; the information component (IC, BCPNN) with the usual shrinkage and
// IC025 approximation; a gamma-Poisson shrinker giving EBGM and EB05 (two-component gamma mixture prior with
// fixed, published-style starting hyperparameters, not refitted here); a Poisson rate test against a baseline
// using exposure; a Poisson likelihood-ratio CUSUM; and a maximised sequential probability ratio test (MaxSPRT, Poisson) whose
// critical values come from a linear alpha-spending rule checked by exact Poisson tails (conservative).

// ---------- special functions ----------
const G = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
export function lgamma(x) { if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x); x -= 1; let a = G[0]; const t = x + 7.5; for (let i = 1; i < 9; i += 1) a += G[i] / (x + i); return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a); }
/** Regularised lower incomplete gamma P(a, x). */
export function gammaP(a, x) {
  if (x <= 0) return 0;
  if (x < a + 1) { let sum = 1 / a; let term = sum; for (let n = 1; n < 500; n += 1) { term *= x / (a + n); sum += term; if (Math.abs(term) < Math.abs(sum) * 1e-14) break; } return Math.min(1, sum * Math.exp(-x + a * Math.log(x) - lgamma(a))); }
  let b = x + 1 - a; let c = 1e300; let d = 1 / b; let h = d;
  for (let i = 1; i < 500; i += 1) { const an = -i * (i - a); b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300; c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-14) break; }
  return Math.max(0, 1 - Math.exp(-x + a * Math.log(x) - lgamma(a)) * h);
}
const Z975 = 1.959963984540054;
const round = (v, d = 4) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

// ---------- rates and intervals ----------
/** Events per 1,000 uses with a Wilson 95% interval. uses = 0 gives nulls. */
export function rate(events, uses) {
  if (!(uses > 0)) return { events, uses: uses || 0, per1000: null, low: null, high: null };
  const p = events / uses; const z2 = Z975 * Z975; const den = 1 + z2 / uses; const mid = (p + z2 / (2 * uses)) / den; const half = (Z975 * Math.sqrt((p * (1 - p)) / uses + z2 / (4 * uses * uses))) / den;
  return { events, uses, per1000: round(p * 1000, 2), low: round(Math.max(0, mid - half) * 1000, 2), high: round(Math.min(1, mid + half) * 1000, 2) };
}
/** P(X >= k) for X ~ Poisson(mu). */
export function poissonUpper(k, mu) { if (k <= 0) return 1; if (!(mu > 0)) return 0; return gammaP(k, mu); }
/** P(X >= k) for X ~ Binomial(n, p), summed in log space. */
export function binomialUpper(k, n, p) {
  if (k <= 0) return 1; if (k > n) return 0; if (p <= 0) return 0; if (p >= 1) return 1;
  let sum = 0; const lp = Math.log(p); const lq = Math.log(1 - p);
  for (let i = k; i <= n; i += 1) sum += Math.exp(lgamma(n + 1) - lgamma(i + 1) - lgamma(n - i + 1) + i * lp + (n - i) * lq);
  return Math.min(1, sum);
}
/** Benjamini-Hochberg: which hypotheses are rejected at false discovery rate q, and their adjusted p-values. */
export function benjaminiHochberg(pvalues, q = 0.05) {
  const m = pvalues.length; const order = pvalues.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]); const adjusted = new Array(m).fill(1); let min = 1;
  for (let r = m - 1; r >= 0; r -= 1) { min = Math.min(min, (order[r][0] * m) / (r + 1)); adjusted[order[r][1]] = min; }
  return { rejected: adjusted.map((a) => a <= q), adjusted: adjusted.map((a) => round(a, 6)) };
}

// ---------- disproportionality from a 2 x 2 table ----------
// a: this agent and this harm; b: this agent, other harms; c: other agents, this harm; d: other agents, other harms.
export function disproportionality({ a, b, c, d }) {
  const n = a + b + c + d; const expected = n ? ((a + b) * (a + c)) / n : 0;
  const ci = (est, se) => (est > 0 && Number.isFinite(se) ? [round(Math.exp(Math.log(est) - Z975 * se)), round(Math.exp(Math.log(est) + Z975 * se))] : [null, null]);
  const prr = a && c && a + b && c + d ? (a / (a + b)) / (c / (c + d)) : null; const prrCi = prr ? ci(prr, Math.sqrt(1 / a - 1 / (a + b) + 1 / c - 1 / (c + d))) : [null, null];
  const ror = a && b && c && d ? (a * d) / (b * c) : null; const rorCi = ror ? ci(ror, Math.sqrt(1 / a + 1 / b + 1 / c + 1 / d)) : [null, null];
  // Yates-corrected chi-square, used with PRR in the classic screening rule.
  const chi2 = n && (a + b) && (c + d) && (a + c) && (b + d) ? (n * (Math.abs(a * d - b * c) - n / 2) ** 2) / ((a + b) * (c + d) * (a + c) * (b + d)) : 0;
  const ic = Math.log2((a + 0.5) / (expected + 0.5)); const ic025 = ic - 3.3 * (a + 0.5) ** -0.5 - 2 * (a + 0.5) ** -1.5;
  const eb = ebgm(a, expected);
  return { a, b, c, d, expected: round(expected, 3), prr: round(prr), prrLow: prrCi[0], prrHigh: prrCi[1], chi2: round(chi2, 3), ror: round(ror), rorLow: rorCi[0], rorHigh: rorCi[1], ic: round(ic), ic025: round(ic025), ebgm: eb.ebgm, eb05: eb.eb05 };
}
/** Gamma-Poisson shrinker: posterior of the relative rate given n observed and e expected, under a two-gamma mixture prior. */
export const EB_PRIOR = { a1: 0.2, b1: 0.1, a2: 2, b2: 4, p: 1 / 3 };
export function ebgm(n, e, prior = EB_PRIOR) {
  if (!(e > 0)) return { ebgm: null, eb05: null };
  const { a1, b1, a2, b2, p } = prior;
  // Marginal negative binomial likelihoods of each component, in log space.
  const lnb = (a, b) => lgamma(a + n) - lgamma(a) - lgamma(n + 1) + a * Math.log(b / (b + e)) + n * Math.log(e / (b + e));
  const l1 = Math.log(p) + lnb(a1, b1); const l2 = Math.log(1 - p) + lnb(a2, b2); const m = Math.max(l1, l2); const q = Math.exp(l1 - m) / (Math.exp(l1 - m) + Math.exp(l2 - m));
  const digamma = (x) => { let r = 0; while (x < 6) { r -= 1 / x; x += 1; } const f = 1 / (x * x); return r + Math.log(x) - 0.5 / x - f * (1 / 12 - f * (1 / 120 - f / 252)); };
  const elog = q * (digamma(a1 + n) - Math.log(b1 + e)) + (1 - q) * (digamma(a2 + n) - Math.log(b2 + e));
  const cdf = (x) => q * gammaP(a1 + n, x * (b1 + e)) + (1 - q) * gammaP(a2 + n, x * (b2 + e));
  let lo = 0; let hi = 1; while (cdf(hi) < 0.05 && hi < 1e6) hi *= 2; for (let i = 0; i < 60; i += 1) { const mid = (lo + hi) / 2; if (cdf(mid) < 0.05) lo = mid; else hi = mid; }
  return { ebgm: round(Math.exp(elog)), eb05: round((lo + hi) / 2) };
}
export const THRESHOLDS = { prr: { prr: 2, chi2: 4, n: 3 }, ror: { low: 1, n: 3 }, ic: { ic025: 0 }, ebgm: { eb05: 2 }, poisson: { alpha: 0.01 }, cusum: { h: 5, shift: 2 }, maxsprt: { alpha: 0.05, looks: 100 } };
/** Which screening rules a table (and optionally an exposure-based comparison) trips. */
export function screen(t, thresholds = THRESHOLDS) {
  return { prr: t.prr != null && t.prr >= thresholds.prr.prr && t.chi2 >= thresholds.prr.chi2 && t.a >= thresholds.prr.n, ror: t.rorLow != null && t.rorLow > thresholds.ror.low && t.a >= thresholds.ror.n, ic: t.ic025 > thresholds.ic.ic025, ebgm: t.eb05 != null && t.eb05 >= thresholds.ebgm.eb05 };
}

// ---------- sequential detection on a stream of periods ----------
// periods: [{ at, events, uses, a, b, c, d }] in time order (counts per period). baseline: expected events per use.
// Returns, per method, the first period at which it signals: { at, index, count } or null. A method never signals before it has data.
export function sequential(periods, { baseline, thresholds = THRESHOLDS } = {}) {
  const out = { prr: null, ror: null, ic: null, ebgm: null, poisson: null, cusum: null, maxsprt: null };
  const cum = { a: 0, b: 0, c: 0, d: 0, events: 0, uses: 0 }; let s = 0; let spent = 0; const looks = Math.max(periods.length, 1);
  const hit = (m, i) => { if (!out[m]) out[m] = { at: periods[i].at, index: i, count: cum.events }; };
  periods.forEach((p, i) => {
    for (const k of ['a', 'b', 'c', 'd']) cum[k] += p[k] || 0; cum.events += p.events || 0; cum.uses += p.uses || 0;
    if (cum.a + cum.b + cum.c + cum.d > 0) { const t = disproportionality(cum); const sc = screen(t, thresholds); for (const m of ['prr', 'ror', 'ic', 'ebgm']) if (sc[m]) hit(m, i); }
    if (baseline > 0 && cum.uses > 0) {
      const mu = baseline * cum.uses;
      if (cum.events > 0 && poissonUpper(cum.events, mu) < thresholds.poisson.alpha / looks) hit('poisson', i); // corrected for looking every period
      // CUSUM on the Poisson log likelihood ratio for a rate `shift` times the baseline: it rises with each event and falls with exposure.
      const e = baseline * (p.uses || 0); const shift = thresholds.cusum.shift || 2; s = Math.max(0, s + (p.events || 0) * Math.log(shift) - (shift - 1) * e); if (s > thresholds.cusum.h) hit('cusum', i);
      // MaxSPRT: the log likelihood ratio is c ln(c/mu) - (c - mu) when c > mu. The critical value at each look is set by spending alpha linearly.
      const llr = cum.events > mu ? cum.events * Math.log(cum.events / mu) - (cum.events - mu) : 0; spent = (thresholds.maxsprt.alpha * (i + 1)) / looks;
      if (llr > 0 && poissonUpper(cum.events, mu) < thresholds.maxsprt.alpha / looks) hit('maxsprt', i);
      out._last = { llr: round(llr, 3), cusum: round(s, 3), alphaSpent: round(spent, 5), expected: round(mu, 3) };
    }
  });
  const { _last, ...signals } = out; return { signals, last: _last || null, cumulative: cum };
}

// ---------- subgroups ----------
/** A grid of rates for two dimensions, each cell tested against the overall rate, corrected by Benjamini-Hochberg. */
export function subgroupGrid(rows, dimA, dimB, { minUses = 20, q = 0.05 } = {}) {
  // rows: [{ keys: { dim: value }, uses, events }]
  const overall = rows.reduce((t, r) => ({ uses: t.uses + r.uses, events: t.events + r.events }), { uses: 0, events: 0 }); const p0 = overall.uses ? overall.events / overall.uses : 0;
  const cells = new Map();
  for (const r of rows) { const a = r.keys[dimA] ?? 'unknown'; const b = dimB ? r.keys[dimB] ?? 'unknown' : 'all'; const k = `${a}\u0000${b}`; const c = cells.get(k) || { a, b, uses: 0, events: 0 }; c.uses += r.uses; c.events += r.events; cells.set(k, c); }
  const list = [...cells.values()].map((c) => ({ ...c, ...rate(c.events, c.uses), small: c.uses < minUses, p: c.uses >= minUses && p0 > 0 && p0 < 1 ? binomialUpper(c.events, c.uses, p0) : null }));
  const tested = list.filter((c) => c.p != null); const bh = benjaminiHochberg(tested.map((c) => c.p), q);
  tested.forEach((c, i) => { c.adjusted = bh.adjusted[i]; c.higher = bh.rejected[i] && c.events / c.uses > p0; });
  for (const c of list) { c.p = c.p == null ? null : round(c.p, 6); c.higher = Boolean(c.higher); c.ratio = p0 > 0 && c.uses ? round(c.events / c.uses / p0, 2) : null; }
  return { dimA, dimB, overall: rate(overall.events, overall.uses), minUses, q, cells: list.sort((x, y) => String(x.a).localeCompare(String(y.a)) || String(x.b).localeCompare(String(y.b))) };
}
/** Searches every one- and two-key combination for groups with an unusually high rate; false discovery rate controlled over all groups tested. */
export function discoverSubgroups(rows, dims, { minUses = 20, q = 0.05, limit = 20 } = {}) {
  const overall = rows.reduce((t, r) => ({ uses: t.uses + r.uses, events: t.events + r.events }), { uses: 0, events: 0 }); const p0 = overall.uses ? overall.events / overall.uses : 0;
  if (!(p0 > 0) || p0 >= 1) return { overall: rate(overall.events, overall.uses), tested: 0, signals: [] };
  const groups = new Map(); const combos = []; dims.forEach((d, i) => { combos.push([d]); dims.slice(i + 1).forEach((e) => combos.push([d, e])); });
  for (const r of rows) for (const combo of combos) { const k = combo.map((d) => `${d}=${r.keys[d] ?? 'unknown'}`).join(' & '); const g = groups.get(k) || { group: k, keys: Object.fromEntries(combo.map((d) => [d, r.keys[d] ?? 'unknown'])), uses: 0, events: 0 }; g.uses += r.uses; g.events += r.events; groups.set(k, g); }
  const tested = [...groups.values()].filter((g) => g.uses >= minUses && g.uses < overall.uses); const bh = benjaminiHochberg(tested.map((g) => binomialUpper(g.events, g.uses, p0)), q);
  const signals = tested.map((g, i) => ({ ...g, ...rate(g.events, g.uses), ratio: round(g.events / g.uses / p0, 2), adjusted: bh.adjusted[i], flagged: bh.rejected[i] && g.events / g.uses > p0 })).filter((g) => g.flagged).sort((x, y) => x.adjusted - y.adjusted || y.ratio - x.ratio).slice(0, limit);
  return { overall: rate(overall.events, overall.uses), tested: tested.length, signals };
}

// ---------- similarity, clusters, unusual inputs ----------
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
/** A local text embedding: hashed word and word-pair counts, L2-normalised. Nothing leaves this machine and no model is called. */
export function embedText(text, dim = 256) {
  const v = new Float64Array(dim); const words = String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  words.forEach((w, i) => { v[hash(w) % dim] += 1; if (i) v[hash(`${words[i - 1]} ${w}`) % dim] += 0.5; });
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; return Array.from(v, (x) => x / norm);
}
export const cosine = (a, b) => { if (!a || !b) return 0; let s = 0; for (let i = 0; i < Math.min(a.length, b.length); i += 1) s += a[i] * b[i]; return s; };
export const MATCH_KEYS = [['agent', 'same agent', 3], ['version', 'same version', 2], ['harm', 'same harm category', 3], ['taskType', 'same task type', 2], ['patientGroup', 'same patient subgroup', 2], ['role', 'same user role', 1], ['specialty', 'same specialty', 1], ['site', 'same site', 1]];
/** How alike two reports are, with the reasons. f: structured features; e: text embedding (optional). */
export function similarity(x, y) {
  const reasons = []; let score = 0; let max = 0;
  for (const [key, label, weight] of MATCH_KEYS) { max += weight; if (x.f[key] != null && x.f[key] === y.f[key] && (key !== 'version' || x.f.agent === y.f.agent)) { score += weight; reasons.push(label); } }
  const inputs = jaccard(x.f.inputs || [], y.f.inputs || []); max += 2; if (inputs >= 0.5) { score += 2 * inputs; reasons.push('similar inputs'); }
  const text = x.e && y.e ? cosine(x.e, y.e) : 0; max += 3; if (text >= 0.35) { score += 3 * text; reasons.push('similar wording (local text comparison)'); }
  return { score: round(score / max, 4), reasons };
}
export function jaccard(a, b) { const A = new Set(a); const B = new Set(b); if (!A.size && !B.size) return 0; let both = 0; for (const x of A) if (B.has(x)) both += 1; return both / (A.size + B.size - both); }
/** Leader clustering: a report joins the first cluster whose first member it resembles enough. Clusters are named by their commonest features. */
export function cluster(items, { threshold = 0.55 } = {}) {
  const clusters = [];
  for (const it of items) { const home = clusters.find((c) => similarity(c.items[0], it).score >= threshold); if (home) home.items.push(it); else clusters.push({ items: [it] }); }
  return clusters.map((c, i) => { const top = {}; for (const [key] of MATCH_KEYS) { const counts = {}; for (const it of c.items) if (it.f[key] != null) counts[it.f[key]] = (counts[it.f[key]] || 0) + 1; const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]; if (best && best[1] >= Math.ceil(c.items.length * 0.6)) top[key] = best[0]; }
    return { id: `cluster-${i + 1}`, size: c.items.length, name: Object.entries(top).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(', ') || 'mixed', top, ids: c.items.map((x) => x.id), dates: c.items.map((x) => x.at).filter(Boolean).sort() }; }).sort((a, b) => b.size - a.size);
}
/** How unusual a case is for an agent: the mean surprise (in bits) of its subgroup keys against the agent's uses. 0 is typical; above about 3 is rare. */
export function outOfDistribution(keys, exposureRows) {
  const total = exposureRows.reduce((s, r) => s + r.uses, 0); if (!total) return { score: null, unusual: [] };
  const parts = Object.entries(keys).filter(([, v]) => v != null).map(([k, v]) => { const seen = exposureRows.filter((r) => r.keys[k] === v).reduce((s, r) => s + r.uses, 0); const values = new Set(exposureRows.map((r) => r.keys[k])).size || 1; return { key: k, value: v, share: round(seen / total, 4), bits: -Math.log2((seen + 0.5) / (total + 0.5 * values)) }; });
  return { score: parts.length ? round(parts.reduce((s, p) => s + p.bits, 0) / parts.length, 3) : null, unusual: parts.filter((p) => p.bits > 3).map((p) => `${p.key}: ${p.value} (${Math.round(p.share * 1000) / 10}% of uses)`) };
}
/** Completeness of a report, 0 to 1, in the spirit of vigiGrade: the key fields, a usable narrative, a known outcome. Each missing piece takes a fixed share off. */
export function completeness(r) {
  const checks = [['what happened is described', (r.narrative || '').trim().length >= 20, 0.25], ['reached the patient is known', ['yes', 'no', 'caught-before'].includes(r.reachedPatient), 0.15], ['severity is given', Boolean(r.severity), 0.15], ['harm category is given', Boolean(r.harm), 0.1], ['the agent and version are known', Boolean(r.agent && r.version), 0.1], ['the run and its steps are linked', Boolean(r.run && (r.steps || []).length), 0.1], ['the outcome is known', Boolean(r.outcome || r.whatNext), 0.1], ['the right action is described', Boolean((r.rightAction || '').trim()), 0.05]];
  return { score: round(checks.reduce((s, [, ok, w]) => s + (ok ? w : 0), 0), 2), missing: checks.filter(([, ok]) => !ok).map(([label]) => label) };
}
