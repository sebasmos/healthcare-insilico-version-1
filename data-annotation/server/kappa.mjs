// Chance-corrected agreement between annotators. Pure functions.
//
// Cohen's kappa: two fixed raters, each rating every unit once.
// Fleiss' kappa: the same number of ratings per unit (n >= 2), raters
// interchangeable. Both return kappa: null when agreement by chance is
// already 1 (everyone used a single category), where kappa is undefined.
const round = (v, d = 4) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

/** pairs: [[ratingA, ratingB], ...] */
export function cohenKappa(pairs) {
  const n = pairs.length;
  if (!n) return { statistic: 'cohen', kappa: null, n: 0, observed: null, expected: null };
  const a = new Map();
  const b = new Map();
  let agree = 0;
  for (const [x, y] of pairs) {
    if (x === y) agree += 1;
    a.set(x, (a.get(x) || 0) + 1);
    b.set(y, (b.get(y) || 0) + 1);
  }
  const observed = agree / n;
  let expected = 0;
  for (const [category, count] of a) expected += (count / n) * ((b.get(category) || 0) / n);
  const kappa = expected >= 1 ? null : (observed - expected) / (1 - expected);
  return { statistic: 'cohen', kappa: round(kappa), n, observed: round(observed), expected: round(expected) };
}

/** rows: [[rating, rating, ...], ...] with the same number of ratings in every row. */
export function fleissKappa(rows) {
  const N = rows.length;
  if (!N) return { statistic: 'fleiss', kappa: null, n: 0, raters: 0, observed: null, expected: null };
  const raters = rows[0].length;
  if (raters < 2 || rows.some((r) => r.length !== raters)) throw new Error('Fleiss kappa needs the same number of ratings (at least 2) for every unit');
  const totals = new Map();
  let sumP = 0;
  for (const row of rows) {
    const counts = new Map();
    for (const rating of row) { counts.set(rating, (counts.get(rating) || 0) + 1); totals.set(rating, (totals.get(rating) || 0) + 1); }
    let s = 0;
    for (const c of counts.values()) s += c * (c - 1);
    sumP += s / (raters * (raters - 1));
  }
  const observed = sumP / N;
  let expected = 0;
  for (const c of totals.values()) expected += (c / (N * raters)) ** 2;
  const kappa = expected >= 1 ? null : (observed - expected) / (1 - expected);
  return { statistic: 'fleiss', kappa: round(kappa), n: N, raters, observed: round(observed), expected: round(expected) };
}

/** Landis and Koch's conventional reading of a kappa value. */
export function interpretKappa(kappa) {
  if (kappa == null) return 'not defined';
  if (kappa < 0) return 'worse than chance';
  if (kappa === 0) return 'no better than chance';
  if (kappa <= 0.2) return 'slight';
  if (kappa <= 0.4) return 'fair';
  if (kappa <= 0.6) return 'moderate';
  if (kappa <= 0.8) return 'substantial';
  return 'almost perfect';
}

/** Intersection over union of two boxes { x, y, width, height }. */
export function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/** Greedy one-to-one matching of same-label boxes at an IoU threshold. */
export function matchBoxes(a, b, threshold = 0.5) {
  const candidates = [];
  a.forEach((x, i) => b.forEach((y, j) => { if (x.label === y.label) { const v = iou(x, y); if (v >= threshold) candidates.push([v, i, j]); } }));
  candidates.sort((p, q) => q[0] - p[0]);
  const usedA = new Set();
  const usedB = new Set();
  let sum = 0;
  for (const [v, i, j] of candidates) {
    if (usedA.has(i) || usedB.has(j)) continue;
    usedA.add(i); usedB.add(j); sum += v;
  }
  const matched = usedA.size;
  const total = a.length + b.length;
  return { matched, f1: total ? (2 * matched) / total : 1, meanIou: matched ? sum / matched : null };
}
