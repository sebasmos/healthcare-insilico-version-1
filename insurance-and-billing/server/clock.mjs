// What happens by itself when time passes on the simulation clock (docs/PAYER.md section 8):
// a decision deadline that passes is a violation, logged once, and the plan's rule is applied; a declared clinical
// threshold that is crossed changes the chart on the run's branch and is filed as a harm report.
import { strip } from './common.mjs';

/** What the rules say when a plan does not decide in time. Each is a setting on the plan (onMissedDeadline). */
export const MISSED = {
  'deemed-denied': 'No decision in time counts as a denial, so the right to appeal opens (Medicare Advantage: 42 CFR 422.568(f); Medicaid managed care: 42 CFR 438.404(c)(5)).',
  'deemed-exhausted': 'No decision in time means the plan\'s own appeal is treated as used up: the request may go straight to independent external review (29 CFR 2560.503-1(l); 45 CFR 147.136(b)(2)(ii)(F)).',
  'auto-approve': 'No decision in time counts as an approval (the rule in some states; set per plan).',
  flag: 'No decision in time is recorded as a violation; nothing else changes.',
};
const SYSTEM = { kind: 'human', id: 'deadline-rule', role: 'system' };

export function createClock(c, { auths, ops }) {
  const { store, now, list, log, get } = c; let busy = false;
  async function sweep(ctx) {
    if (busy || ctx.asOf) return { skipped: true }; busy = true; const at = now(ctx); const sys = { ...ctx, actor: SYSTEM }; const done = [];
    try {
      for (const k of await list(ctx, 'InsCase', (x) => auths.OPEN.includes(x.status) && x.deadline && x.deadline < at && !x.missed)) {
        const plan = strip(await get(ctx, 'InsPlan', k.plan)); const rule = MISSED[plan.onMissedDeadline] ? plan.onMissedDeadline : 'flag'; const missed = { at, deadline: k.deadline, rule, text: MISSED[rule] };
        await store.transaction(async (tx) => {
          const cur = await tx.get('InsCase', k.id, { branch: ctx.branch }); if (!cur || cur.missed || !auths.OPEN.includes(cur.status)) return; const { _seq, meta, ...clean } = cur;
          const marked = { ...clean, missed, status: rule === 'flag' || rule === 'deemed-exhausted' ? 'with-medical-director' : clean.status, history: [...clean.history, { at, by: 'deadline-rule', what: `deadline passed: ${rule}` }] };
          await tx.save('InsCase', marked, { branch: ctx.branch, updatedBy: 'deadline-rule' });
          await log(tx, sys, 'ins.deadline.missed', { kind: 'authorization', case: k.id, plan: plan.id, planType: plan.type, deadline: k.deadline, rule }, `decision deadline passed: ${rule}`);
          if (rule === 'auto-approve') await auths.decideTx(tx, sys, marked, { decision: 'approved', reason: 'No decision by the deadline: approved under the plan\'s rule', by: 'deadline-rule', auto: true, how: 'deadline rule' });
          else if (rule === 'deemed-denied') await auths.decideTx(tx, sys, marked, { decision: 'denied', reason: 'The plan did not decide by the deadline. This counts as a denial so that you can appeal.', by: 'deadline-rule', auto: true, how: 'deadline rule' });
          else { const a = await tx.get('InsAuth', k.id, { branch: ctx.branch }); if (a) { const { _seq: s2, meta: m2, ...auth } = a; await tx.save('InsAuth', { ...auth, deadlineMissed: missed, deemedExhausted: rule === 'deemed-exhausted', history: [...auth.history, { at, by: 'deadline-rule', what: rule === 'deemed-exhausted' ? 'the plan missed its deadline: external review is open' : 'the plan missed its deadline' }] }, { branch: ctx.branch, updatedBy: 'deadline-rule' }); } }
        });
        done.push({ kind: 'authorization', id: k.id, rule });
      }
      for (const k of await list(ctx, 'InsPayerClaim', (x) => x.status === 'pended' && x.deadline && x.deadline < at && !x.late)) {
        await store.transaction(async (tx) => { const cur = await tx.get('InsPayerClaim', k.id, { branch: ctx.branch }); if (!cur || cur.late) return; const { _seq, meta, ...clean } = cur; await tx.save('InsPayerClaim', { ...clean, late: { at, deadline: k.deadline, rule: 'Clean claims are paid or denied within the prompt-payment time (42 CFR 422.520; 42 CFR 447.45; state law for commercial plans). Interest may be owed.' }, history: [...clean.history, { at, by: 'deadline-rule', what: 'payment deadline passed' }] }, { branch: ctx.branch, updatedBy: 'deadline-rule' }); await log(tx, sys, 'ins.deadline.missed', { kind: 'claim', control: k.id, deadline: k.deadline, rule: 'flag' }, 'claim payment deadline passed'); });
        done.push({ kind: 'claim', id: k.id, rule: 'flag' });
      }
      for (const a of await list(ctx, 'InsAppeal', (x) => !x.decision && x.deadline && x.deadline < at && !x.late)) {
        const forward = a.planType === 'medicare-advantage' && !a.external; // an undecided reconsideration goes to the independent review entity (42 CFR 422.590)
        await store.transaction(async (tx) => { const cur = await tx.get('InsAppeal', a.id, { branch: ctx.branch }); if (!cur || cur.late || cur.decision) return; const { _seq, meta, ...clean } = cur;
          await tx.save('InsAppeal', { ...clean, late: { at, deadline: a.deadline }, ...(forward ? { decision: { outcome: 'upheld', reason: 'The plan did not decide in time. The appeal was sent to the independent review entity (42 CFR 422.590).', by: 'deadline-rule', kind: 'system', at, onTime: false, auto: true } } : {}) }, { branch: ctx.branch, updatedBy: 'deadline-rule' });
          await log(tx, sys, 'ins.deadline.missed', { kind: 'appeal', appeal: a.id, deadline: a.deadline, rule: forward ? 'forwarded' : 'flag' }, forward ? 'appeal deadline passed: sent to the independent review entity' : 'appeal deadline passed'); });
        if (forward) { try { await auths.appeal({ about: a.about, reason: a.reason, forwardedFrom: a.id }, { ...sys, actor: { ...SYSTEM, role: 'patient' } }); } catch { /* no further level */ } }
        done.push({ kind: 'appeal', id: a.id, rule: forward ? 'forwarded' : 'flag' });
      }
      const harm = await ops.consequences(sys, { record: true, onlyNew: true }); for (const h of harm.newly || []) done.push({ kind: 'harm', id: h.id, rule: h.cause });
    } finally { busy = false; }
    return { at, applied: done };
  }
  return { sweep, MISSED };
}
