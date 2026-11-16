// Reward maths, rollouts, re-evaluation, horizons and the version registry (§9d).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BACKEND, startTestServer, testClock } from './support/helpers.mjs';
import { verifierScore, reward, gamingRisk, histogram, COMPONENTS } from '../agent-operations/server/grader.mjs';
import { seeded } from '../agent-operations/server/agents.mjs';
import { agentSetup } from './support/agents.mjs';

const cfg = (components = {}, checks = {}) => ({ version: 1, useJudge: true, checks, components: { ...Object.fromEntries(Object.entries(COMPONENTS).map(([k, c]) => [k, c.weight])), ...components } });
const check = (id, pass, extra = {}) => ({ id, label: id, pass, weight: 1, forbidden: false, evidence: [], ...extra });
async function bank(options = {}) {
  const clock = testClock('2026-06-01T09:00:00.000Z');
  const s = await startTestServer({ clock, ...options });
  const loaded = (await s.call('POST', '/agent-ops/cases/load', {})).json.loaded;
  const bySlug = (slug) => loaded.find((c) => c.slug === slug);
  clock.advance(60_000);
  const roll = async (slug, attempts, seed = 0, agentId = 'workup-planner') => { const r = await s.call('POST', '/agent-ops/rollouts', { agentId, caseId: bySlug(slug).id, attempts, seed }); assert.equal(r.status, 201, r.text); return r.json; };
  return { s, clock, bySlug, roll };
}

test('verifier score: weights, things to avoid, per-check overrides and judge credit', () => {
  assert.equal(verifierScore([check('a', true), check('b', false)]).score, 0.5);
  assert.equal(verifierScore([check('a', true, { weight: 3 }), check('b', false)]).score, 0.75);
  const withAvoid = [check('a', true), check('b', true), check('x', false, { forbidden: true })];
  assert.deepEqual([verifierScore(withAvoid).score, verifierScore(withAvoid).penalty, verifierScore(withAvoid).possible], [0.5, 1, 2]);
  assert.equal(verifierScore([check('a', false), check('x', false, { forbidden: true, weight: 2 })]).score, -2, 'the score can go below zero');
  assert.equal(verifierScore([check('a', true), check('x', true, { forbidden: true })]).score, 1, 'avoiding something earns nothing extra');
  assert.equal(verifierScore([check('a', true), check('b', false)], { overrides: { 'case:b': 3 }, caseKey: 'case' }).score, 0.25);
  assert.equal(verifierScore([check('a', true), check('b', false)], { overrides: { 'other:b': 3 }, caseKey: 'case' }).score, 0.5, 'overrides apply to their own case only');
  assert.equal(verifierScore([check('a', true), check('b', false)], { credits: { b: 0.5, a: 0 } }).score, 0.75, 'a judge can add partial credit to a failed check, never remove credit');
  assert.equal(verifierScore([check('x', false, { forbidden: true })], { credits: { x: 1 } }).score, -1, 'a judge cannot excuse something to avoid');
  assert.equal(verifierScore([]).score, null);
});

test('reward: named components, each weighted on its own; missing components are left out', () => {
  const r = reward({ caseKey: 'c', checks: [check('a', true), check('b', false)], safetyViolations: 1 }, cfg());
  const by = Object.fromEntries(r.breakdown.map((b) => [b.name, b]));
  assert.deepEqual([by.verifier.value, by.verifier.contribution, by.safety.value, by.safety.contribution], [0.5, 0.5, -1, -2]);
  assert.equal(r.total, -1.5, 'one safety violation outweighs half the checks');
  assert.deepEqual(r.breakdown.filter((b) => b.value == null).map((b) => b.name), ['clinicianAgreement', 'acceptance', 'editDistance', 'timeSaved', 'redTeam', 'annotationAgreement', 'expertGrade']);
  assert.equal(r.breakdown.length, Object.keys(COMPONENTS).length);

  const hitl = reward({ acceptance: 1, editRatio: 0.4, safetyViolations: 0 }, cfg());
  assert.equal(hitl.total, 0.8, 'accepted (1 x 1) minus 0.4 rewritten (x 0.5)');
  const shadow = reward({ agree: true, timeSaved: 0.8, redTeamFailedShare: 0.25, safetyViolations: 0 }, cfg());
  assert.equal(shadow.total, 0.95, '1 + 0.8 x 0.25 - 0.25');
  assert.equal(reward({ agree: false, expertGrade: -1 }, cfg()).total, -1, 'an "unsafe" expert grade counts against the episode');
  assert.equal(reward({ checks: [check('a', true)] }, cfg({ verifier: 0 })).total, 0);
  const judged = reward({ checks: [check('a', true), check('b', false)], judge: { credits: { b: 0.5 } } }, cfg());
  assert.deepEqual([judged.verifier.score, judged.judged.score, judged.judgeDisagreement, judged.total], [0.5, 0.75, 0.25, 0.75], 'code result and judged result are both kept');
  assert.equal(reward({ checks: [check('a', true), check('b', false)], judge: { credits: { b: 0.5 } } }, { ...cfg(), useJudge: false }).total, 0.5);
});

test('gaming risk and the reward histogram', () => {
  assert.deepEqual([gamingRisk(cfg()).level, gamingRisk(cfg()).reasons], ['low', []]);
  const trap = gamingRisk(cfg({ acceptance: 1, verifier: 0, safety: 0, redTeam: 0, clinicianAgreement: 0, editDistance: 0, timeSaved: 0, expertGrade: 0 }));
  assert.equal(trap.level, 'high');
  assert.ok(trap.reasons.some((r) => /No weight on safety/.test(r)) && trap.reasons.some((r) => /agreeable rather than right/.test(r)));
  assert.equal(gamingRisk(cfg({ safety: 0, redTeam: 0 })).level, 'medium');
  assert.equal(gamingRisk(cfg({ timeSaved: 5, safety: 0, redTeam: 0 })).level, 'high');
  assert.equal(gamingRisk({ components: Object.fromEntries(Object.keys(COMPONENTS).map((k) => [k, 0])) }).level, 'high');
  const h = histogram([0, 0.1, 0.5, 1, 1, 1]);
  assert.deepEqual([h.min, h.max, h.bins.length, h.bins[0].count, h.bins.at(-1).count, h.bins.reduce((n, b) => n + b.count, 0)], [0, 1, 10, 1, 3, 6]);
  assert.deepEqual(histogram([2, 2]).bins.map((b) => b.count), [2]);
  assert.deepEqual(histogram([]).bins, []);
  const a = seeded(7); const b = seeded(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()], 'the same seed gives the same sequence');
});
