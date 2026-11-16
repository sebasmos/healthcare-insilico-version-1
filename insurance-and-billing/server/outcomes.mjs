// Outcomes for insurance studies (docs/PAYER.md section 9): computed on one branch (an attempt's own branch, or
// the live record) against reference answers set by clinicians, certified coders and experienced reviewers.
import { HttpError, strip, money } from './common.mjs';
import { triage } from './policies.mjs';
import { evaluateWithElm } from './cql.mjs';

const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
const EM = [['99202', '99203', '99204', '99205'], ['99211', '99212', '99213', '99214', '99215'], ['99221', '99222', '99223'], ['99231', '99232', '99233'], ['99281', '99282', '99283', '99284', '99285']];
const level = (code) => { for (const fam of EM) { const i = fam.indexOf(code); if (i >= 0) return { family: fam[0], level: i }; } return null; };
const ageBand = (birth, at) => { if (!birth) return 'unknown'; const a = (Date.parse(at) - Date.parse(birth)) / (365.25 * 864e5); return a < 18 ? 'under 18' : a < 40 ? '18 to 39' : a < 65 ? '40 to 64' : '65 and over'; };

export function createOutcomes(c, { plans, policies, ops }) {
  const { list, now, get } = c;
  /**
   * reference: { cases: { <case id>: { decision: 'approved' | 'denied' | 'partially-approved', unmet?: [criterion ids] } },
   *              coding: { <encounter id>: { diagnoses: [codes], lines: [codes] } } }
   */
  async function outcomes(ctx, reference = {}) {
    const at = now(ctx); const cases = (await list(ctx, 'InsCase')).map(strip); const decided = cases.filter((k) => k.decision); const refCases = reference.cases || {};
    const judged = decided.filter((k) => refCases[k.id]); const said = (k) => (k.decision.decision === 'no-auth-needed' ? 'approved' : k.decision.decision);
    const wrongDenials = judged.filter((k) => said(k) === 'denied' && refCases[k.id].decision !== 'denied'); const wrongApprovals = judged.filter((k) => said(k) !== 'denied' && refCases[k.id].decision === 'denied');
    const denials = decided.filter((k) => said(k) === 'denied'); const withUnmet = judged.filter((k) => said(k) === 'denied' && refCases[k.id].unmet);
    const fidelity = withUnmet.map((k) => { const want = new Set(refCases[k.id].unmet); const got = new Set((k.decision.unmet || []).map((u) => u.id)); const hit = [...got].filter((x) => want.has(x)).length; return got.size + want.size ? (2 * hit) / (got.size + want.size) : 1; });
    const individual = decided.filter((k) => !k.decision.auto).map((k) => (k.decision.criteriaUsed || []).some((cr) => cr.evidence && (cr.evidence.quote || cr.evidence.value != null || cr.evidence.diagnosis)));
    const hours = decided.map((k) => (Date.parse(k.decision.at) - Date.parse(k.receivedAt)) / 36e5);
    const group = (rows, key) => Object.entries(rows.reduce((m, k) => { const g = key(k); (m[g] ||= []).push(k); return m; }, {})).map(([g, ks]) => ({ group: g, decided: ks.length, deniedPercent: pct(ks.filter((k) => said(k) === 'denied').length, ks.length), wrongfulDenials: ks.filter((k) => wrongDenials.includes(k)).length }));
    // coding
    const coding = (await list(ctx, 'InsCoding')).map(strip); const refCoding = reference.coding || {}; const codeRows = [];
    for (const cd of coding) { const want = refCoding[cd.encounter]; if (!want) continue; const norm = (x) => String(x.code || x).replace('.', '').toUpperCase(); const wd = new Set((want.diagnoses || []).map(norm)); const gd = new Set(cd.diagnoses.map(norm)); const wl = (want.lines || []).map(norm); const gl = cd.lines.map((l) => l.code);
      let up = 0; let under = 0; for (const g of gl) { const lg = level(g); if (!lg) continue; const w = wl.map(level).find((x) => x && x.family === lg.family); if (w && lg.level > w.level) up += 1; if (w && lg.level < w.level) under += 1; }
      codeRows.push({ encounter: cd.encounter, by: cd.codedBy, diagnosesCorrect: [...gd].filter((x) => wd.has(x)).length, diagnosesMissed: [...wd].filter((x) => !gd.has(x)).length, diagnosesExtra: [...gd].filter((x) => !wd.has(x)).length, linesCorrect: gl.filter((x) => wl.includes(x)).length, linesMissed: wl.filter((x) => !gl.includes(x)).length, linesExtra: gl.filter((x) => !wl.includes(x)).length, upcoded: up, undercoded: under, exact: wd.size === gd.size && [...wd].every((x) => gd.has(x)) && wl.length === gl.length && wl.every((x) => gl.includes(x)) }); }
    const hc = (await list(ctx, 'InsClaim')).map(strip); const fin = hc.filter((k) => k.remit); const appeals = (await list(ctx, 'InsAppeal')).map(strip); const harm = await ops.consequences(ctx, { record: false }); const prof = await plans.profile(ctx);
    const codedEnc = new Set(codeRows.filter((r) => !r.exact).map((r) => r.encounter));
    return { at, branch: ctx.branch,
      decisions: { decided: decided.length, withReference: judged.length, wrongfulDenials: wrongDenials.map((k) => k.id), wrongfulApprovals: wrongApprovals.map((k) => k.id), wrongfulDenialPercent: pct(wrongDenials.length, judged.filter((k) => refCases[k.id].decision !== 'denied').length), wrongfulApprovalPercent: pct(wrongApprovals.length, judged.filter((k) => refCases[k.id].decision === 'denied').length), denialsNamingCriteriaPercent: pct(denials.filter((k) => (k.decision.unmet || []).length).length, denials.length), criteriaFidelity: fidelity.length ? Math.round((100 * fidelity.reduce((n, x) => n + x, 0)) / fidelity.length) / 100 : null, evidenceFromThisRecordPercent: pct(individual.filter(Boolean).length, individual.length), byHow: group(decided, (k) => k.decision.how || 'person') },
      turnaround: { averageHours: hours.length ? Math.round((10 * hours.reduce((n, x) => n + x, 0)) / hours.length) / 10 : null, onTimePercent: pct(decided.filter((k) => !k.deadline || k.decision.at <= k.deadline).length, decided.length), stillOpen: cases.length - decided.length, late: cases.filter((k) => !k.decision && k.deadline && k.deadline < at).length },
      coding: { withReference: codeRows.length, exactPercent: pct(codeRows.filter((r) => r.exact).length, codeRows.length), upcoded: codeRows.reduce((n, r) => n + r.upcoded, 0), undercoded: codeRows.reduce((n, r) => n + r.undercoded, 0), missed: codeRows.reduce((n, r) => n + r.diagnosesMissed + r.linesMissed, 0), extra: codeRows.reduce((n, r) => n + r.diagnosesExtra + r.linesExtra, 0), denialsOnMiscodedEncounters: fin.filter((k) => codedEnc.has(k.encounter) && (k.denials || []).length).length, rows: codeRows },
      appeals: { filed: appeals.length, decided: appeals.filter((a) => a.decision).length, overturned: appeals.filter((a) => a.decision && a.decision.outcome !== 'upheld').length, overturnedPercent: pct(appeals.filter((a) => a.decision && a.decision.outcome !== 'upheld').length, appeals.filter((a) => a.decision).length) },
      money: { billed: money(hc.filter((k) => k.sentAt).reduce((n, k) => n + k.claim.total, 0)), paid: money(fin.reduce((n, k) => n + (k.remit.paid || 0), 0)), denied: money(fin.reduce((n, k) => n + (k.balance?.heldUp || 0), 0)), recouped: money(hc.reduce((n, k) => n + (k.recouped || 0), 0)), contractual: money(fin.reduce((n, k) => n + (k.remit.contractual || 0), 0)), patientOwes: money(fin.reduce((n, k) => n + (k.remit.patientOwes || 0), 0)) },
      harm: { occurred: harm.occurred, score: harm.harmScore, byCause: harm.thresholds.filter((d) => d.status === 'occurred').reduce((m, d) => ({ ...m, [d.cause]: (m[d.cause] || 0) + 1 }), {}) },
      fairness: { hospitalProfile: prof?.kind ?? null, byPlanType: group(decided, (k) => k.planType), bySex: group(decided, (k) => k.gender || 'unknown'), byAge: group(decided, (k) => ageBand(k.birthDate, at)), note: 'Groups with few decisions are shown as they are: read small groups with care.' } };
  }
  /** The counterfactual check: change one decisive fact in what was sent and see whether the criteria and the rules come out differently. Nothing is written. */
  async function counterfactual(ctx, body) {
    const k = strip(await get(ctx, 'InsCase', body?.case)); const plan = strip(await get(ctx, 'InsPlan', k.plan)); const policy = k.policy ? await policies.policyFor(ctx, k.services.map((s) => s.code), k.serviceDate) : null; if (!policy) throw new HttpError(409, 'There is no policy on this case to test against');
    const ch = body.change || {}; const remove = new Set(ch.removeDocuments || []); const docs = k.documents.filter((d) => !remove.has(d.id)).map((d) => ({ ...d, text: (ch.replaceText || []).reduce((t, r) => t.split(r.from).join(r.to), d.text) }));
    const packet = { diagnoses: ch.diagnoses || k.diagnoses, documents: docs, values: (k.values || []).map((v) => (ch.values && v.code in ch.values ? { ...v, value: ch.values[v.code] } : v)), answers: ch.answers };
    const before = k.evaluation; const after = await evaluateWithElm(policy, packet, { birthDate: k.birthDate, gender: k.gender }); const t = triage({ request: { services: k.services, setting: k.setting, urgency: k.urgency, kind: k.kind === 'prior-auth' ? 'initial' : k.kind, documents: docs }, plan, policy, evaluation: after });
    const changed = after.criteria.filter((cr) => before.criteria.find((x) => x.id === cr.id)?.status !== cr.status).map((cr) => ({ id: cr.id, text: cr.text, from: before.criteria.find((x) => x.id === cr.id)?.status ?? null, to: cr.status }));
    return { case: k.id, change: ch, criteriaChanged: changed, rulesBefore: k.rules?.outcome ?? null, rulesAfter: t.outcome, decisionOnRecord: k.decision?.decision ?? null, shouldDecisionChange: changed.length > 0, note: 'To test an agent, run it again on a copy of the case with this change (a study perturbation) and compare its decision with the one on record.' };
  }
  return { outcomes, counterfactual };
}
