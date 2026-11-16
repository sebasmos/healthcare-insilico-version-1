// Surveillance statistics on built streams with a known truth: every signal method detects a planted signal and
// never before it; the subgroup explorer finds a planted high-rate subgroup and the false discovery rate
// correction keeps a null stream clean; similar reports rank the right ones first; the simulator is repeatable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rate, poissonUpper, binomialUpper, benjaminiHochberg, disproportionality, ebgm, sequential, subgroupGrid, discoverSubgroups, similarity, embedText, cluster, outOfDistribution, completeness } from '../post-deployment-surveillance/server/stats.mjs';
import { runStudy, simulateStream, normalizeConfig, studyCsv, METHODS } from '../post-deployment-surveillance/server/simulator.mjs';

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

test('rates are per 1,000 uses with an interval; the tails and the false discovery rate correction are right', () => {
  assert.deepEqual(rate(5, 1000), { events: 5, uses: 1000, per1000: 5, low: 2.14, high: 11.65 });
  assert.deepEqual(rate(3, 0), { events: 3, uses: 0, per1000: null, low: null, high: null });
  assert.ok(Math.abs(poissonUpper(10, 3) - 0.0011025) < 1e-5); assert.equal(poissonUpper(0, 3), 1);
  assert.ok(Math.abs(binomialUpper(3, 10, 0.1) - 0.0701908) < 1e-6);
  assert.deepEqual(benjaminiHochberg([0.001, 0.04, 0.03, 0.5]).rejected, [true, false, false, false]);
  assert.deepEqual(benjaminiHochberg([0.01, 0.02, 0.03, 0.04]).rejected, [true, true, true, true]);
  const t = disproportionality({ a: 20, b: 80, c: 10, d: 890 });
  assert.deepEqual([t.prr, t.ror, t.expected], [18, 22.25, 3]); assert.ok(t.prrLow > 8 && t.rorLow > 10 && t.ic025 > 1.5 && t.eb05 > 2);
  assert.ok(ebgm(0, 5).ebgm < 0.3, 'nothing seen where five were expected shrinks below one'); assert.ok(ebgm(1, 0.01).ebgm < 100, 'one report against a tiny expectation is shrunk');
});

test('every signal method detects a planted signal, and never before it', () => {
  // 60 quiet days, then the rate for one agent and harm rises twelve-fold. Counts are fixed, not random.
  const quiet = (at) => ({ at, uses: 400, events: at % 5 === 0 ? 1 : 0, a: at % 5 === 0 ? 1 : 0, b: 2, c: (at % 2) * 5, d: 30 });
  const loud = (at) => ({ at, uses: 400, events: 3, a: 3, b: 2, c: (at % 2) * 5, d: 30 });
  const periods = [...Array.from({ length: 60 }, (_, i) => quiet(i)), ...Array.from({ length: 40 }, (_, i) => loud(60 + i))];
  const baseline = 0.2 / 400; // one event every five days in 400 uses a day
  const { signals } = sequential(periods, { baseline });
  for (const m of METHODS) { assert.ok(signals[m], `${m} detects it`); assert.ok(signals[m].at >= 60, `${m} does not signal before the truth (signalled at day ${signals[m].at})`); assert.ok(signals[m].count >= 1); }
  // With no planted signal nothing fires.
  const nothing = sequential(Array.from({ length: 100 }, (_, i) => quiet(i)), { baseline }).signals;
  for (const m of METHODS) assert.equal(nothing[m], null, `${m} stays quiet on a null stream`);
});

test('the subgroup explorer finds a planted high-rate subgroup; the false discovery rate correction keeps a null stream clean', () => {
  const r = rng(11); const specialties = ['emergency', 'medicine', 'surgery', 'paediatrics']; const dx = ['Circulatory', 'Respiratory', 'Digestive', 'Infections', 'Injury and poisoning'];
  const build = (planted) => { const rows = []; for (let i = 0; i < 20000; i += 1) { const keys = { specialty: specialties[i % 4], dxGroup: dx[Math.floor(i / 4) % 5], site: i % 3 ? 'site-1' : 'site-2' }; const p = planted && keys.specialty === 'emergency' && keys.dxGroup === 'Infections' ? 0.06 : 0.01; rows.push({ keys, uses: 1, events: r() < p ? 1 : 0 }); } return rows; };
  const grid = subgroupGrid(build(true), 'specialty', 'dxGroup', { minUses: 20 });
  const flagged = grid.cells.filter((c) => c.higher);
  assert.deepEqual(flagged.map((c) => `${c.a} x ${c.b}`), ['emergency x Infections']);
  assert.ok(flagged[0].ratio > 3 && flagged[0].low > grid.overall.per1000, 'the cell is well above the overall rate');
  const found = discoverSubgroups(build(true), ['specialty', 'dxGroup', 'site'], { minUses: 20 });
  assert.equal(found.signals[0].group, 'specialty=emergency & dxGroup=Infections'); assert.ok(found.signals[0].uses >= 900 && found.signals[0].ratio > 3);
  // Null streams: twenty of them, twenty cells each. Uncorrected testing at 0.05 would flag about one cell per stream.
  let corrected = 0; let uncorrected = 0;
  for (let s = 0; s < 20; s += 1) { const g = subgroupGrid(build(false), 'specialty', 'dxGroup', { minUses: 20 }); corrected += g.cells.filter((c) => c.higher).length; uncorrected += g.cells.filter((c) => c.p != null && c.p < 0.05).length; }
  assert.ok(uncorrected >= 8, `uncorrected testing raises false alarms (${uncorrected})`); assert.ok(corrected <= 1, `the correction stops them (${corrected})`);
  // Small cells are greyed out, not tested.
  const small = subgroupGrid([{ keys: { site: 'a' }, uses: 500, events: 5 }, { keys: { site: 'b' }, uses: 5, events: 4 }], 'site', null, { minUses: 20 });
  assert.deepEqual(small.cells.map((c) => [c.a, c.small, c.higher]), [['a', false, false], ['b', true, false]]);
});

test('similar reports rank the right ones first, with the reason each matched; clusters are named by their top features', () => {
  const mk = (id, f, text) => ({ id, at: '2026-01-01', f: { inputs: ['Observation', 'MedicationRequest'], ...f }, e: embedText(text) });
  const mine = mk('r0', { agent: 'drafter', version: '2', harm: 'hallucinated', taskType: 'draft-report', role: 'physician', specialty: 'emergency', site: 'site-1', patientGroup: '65-79|female|Circulatory' }, 'The draft described a nodule that is not on the image');
  const twin = mk('r1', { agent: 'drafter', version: '2', harm: 'hallucinated', taskType: 'draft-report', role: 'physician', specialty: 'emergency', site: 'site-1', patientGroup: '65-79|female|Circulatory' }, 'Draft report described a nodule that was not on the image at all');
  const cousin = mk('r2', { agent: 'drafter', version: '1', harm: 'hallucinated', taskType: 'draft-report', role: 'nurse', specialty: 'medicine', site: 'site-2', patientGroup: '18-39|male|Respiratory' }, 'It invented a finding');
  const stranger = mk('r3', { agent: 'triager', version: '5', harm: 'workflow', taskType: 'triage-message', role: 'nurse', specialty: 'medicine', site: 'site-2', patientGroup: '18-39|male|Respiratory' }, 'The reply box was slow to open');
  const ranked = [stranger, cousin, twin].map((x) => ({ id: x.id, ...similarity(mine, x) })).sort((a, b) => b.score - a.score);
  assert.deepEqual(ranked.map((x) => x.id), ['r1', 'r2', 'r3']);
  for (const reason of ['same agent', 'same version', 'same harm category', 'same task type', 'same patient subgroup', 'same user role', 'same specialty', 'same site', 'similar inputs', 'similar wording (local text comparison)']) assert.ok(ranked[0].reasons.includes(reason), reason);
  assert.deepEqual(ranked[1].reasons.filter((x) => x.startsWith('same')), ['same agent', 'same harm category', 'same task type']);
  assert.ok(!ranked[1].reasons.includes('same version'));
  const groups = cluster([mine, twin, stranger, cousin]);
  assert.deepEqual([groups[0].size, groups[0].ids.sort(), groups[0].top.agent, groups[0].top.harm], [2, ['r0', 'r1'], 'drafter', 'hallucinated']); assert.match(groups[0].name, /agent: drafter/);
  const ood = outOfDistribution({ sex: 'female', ageBand: '0-17' }, [{ keys: { sex: 'female', ageBand: '40-64' }, uses: 500 }, { keys: { sex: 'male', ageBand: '40-64' }, uses: 499 }, { keys: { sex: 'female', ageBand: '0-17' }, uses: 1 }]);
  assert.ok(ood.score > 3 && ood.unusual[0].startsWith('ageBand: 0-17'));
  const full = completeness({ narrative: 'The draft described a nodule that is not there.', reachedPatient: 'no', severity: 'near-miss', harm: 'hallucinated', agent: 'a', version: '1', run: 'r', steps: ['s'], whatNext: 'Rewrote it', rightAction: 'Describe only what is seen' });
  assert.equal(full.score, 1); assert.deepEqual(completeness({ narrative: 'Bad', reachedPatient: 'yes', severity: 'mild' }).missing.length, 6);
});

test('the surveillance study is repeatable, measures every method for every source, and exports', () => {
  const cfg = { seeds: 4, days: 90, usesPerDay: 600, signal: { kind: 'version', day: 45, factor: 8, harm: 'hallucinated' }, reporting: { notoriety: { day: 60, factor: 3, days: 10 }, weber: { factor: 2, days: 20 }, masking: { harm: 'workflow', rate: 0.02 }, siteFactor: { 'site-2': 0.5 } } };
  const a = runStudy(cfg, 7); const b = runStudy(cfg, 7);
  assert.deepEqual(a.results, b.results, 'the same seed gives the same study'); assert.notDeepEqual(runStudy(cfg, 8).results, a.results);
  assert.equal(a.results.length, 4 * METHODS.length);
  const of = (sources, method) => a.results.find((r) => r.sources === sources && r.method === method);
  assert.equal(of('combined', 'maxsprt').detected, 4); assert.ok(of('combined', 'maxsprt').medianDaysToDetection >= 0);
  assert.ok(of('combined', 'poisson').detected >= of('human', 'poisson').detected, 'more sources never detect less often on the exposure test');
  for (const r of a.results) { assert.equal(r.detected + r.missed + r.signalledBeforeTheTruth, 4); assert.ok(r.positivePredictiveValue == null || (r.positivePredictiveValue >= 0 && r.positivePredictiveValue <= 1)); }
  const none = runStudy({ seeds: 3, days: 60, signal: { kind: 'none' } }, 5);
  assert.equal(none.planted, null); for (const r of none.results) assert.equal(r.detected, 0);
  // Under-reporting, duplicates and false positives are in the stream.
  const days = simulateStream(normalizeConfig({ days: 60, usesPerDay: 2000, reporting: { duplicates: 0.5 } }), 3); const all = days.flatMap((d) => d.reports);
  assert.ok(all.some((r) => r.duplicate) && all.some((r) => r.falsePositive) && all.some((r) => r.source === 'automatic') && all.some((r) => r.source === 'agent'));
  assert.ok(all.filter((r) => r.source === 'human').length < all.filter((r) => r.source === 'automatic').length, 'people report fewer than the rules detect');
  assert.match(studyCsv(a).split('\n')[0], /^sources,method,runs,detected,missed/); assert.equal(studyCsv(a).split('\n').length, 1 + 4 * METHODS.length);
});
