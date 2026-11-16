// Hospital profile, plans, enrollment and eligibility (docs/PAYER.md 5.1 and 5.2).
// Insurer and plan names are synthetic ("Plan 3 (Medicare Advantage)"); their rules follow the real ones for
// the plan type, as settings with the real defaults (docs/PAYER.md section 14). Dollar amounts are never typed
// here: they come from what you enter for the plan or from the yearly limits you import.
import { HttpError, randomUUID, x12, money, day, hashInt, strip, patientNumber, memberNumber } from './common.mjs';
import { mulberry32 } from '../../ehr/server/wearables.mjs';
import * as ref from './reference.mjs';

export const PROFILES = { 'academic-medical-center': 'Academic medical center', 'large-private-system': 'Large private health system', 'safety-net': 'Safety-net hospital' };
const H = 3600e3; const D = 24 * H;
/** Decision timings by plan type, with the rule each comes from. All can be changed on the plan. */
export const PLAN_TYPES = {
  'medicare-advantage': { label: 'Medicare Advantage', onMissed: 'deemed-denied', filing: '16', deadlines: { standardMs: 7 * D, expeditedMs: 72 * H, extensionMs: 14 * D, claimMs: 30 * D, appealFileMs: 65 * D, appealPreMs: 30 * D, appealPostMs: 60 * D, appealExpeditedMs: 72 * H }, timelyFilingDays: 365, source: '42 CFR 422.568, 422.572, 422.582, 422.590; CMS-0057-F', appeals: ['reconsideration', 'independent-review-entity'] },
  medicaid: { label: 'Medicaid managed care', onMissed: 'deemed-denied', filing: 'MC', deadlines: { standardMs: 7 * D, expeditedMs: 72 * H, extensionMs: 14 * D, claimMs: 30 * D, appealFileMs: 60 * D, appealPreMs: 30 * D, appealPostMs: 30 * D, appealExpeditedMs: 72 * H, fairHearingFileMs: 120 * D }, timelyFilingDays: 365, source: '42 CFR 438.210(d), 438.402, 438.408, 447.45; CMS-0057-F', appeals: ['plan-appeal', 'state-fair-hearing'] },
  medicare: { label: 'Traditional Medicare', onMissed: 'flag', filing: 'MB', deadlines: { standardMs: 7 * D, expeditedMs: 2 * D, claimMs: 30 * D, paymentFloorMs: 14 * D, appealFileMs: 120 * D, appealPreMs: 60 * D, appealPostMs: 60 * D, appealExpeditedMs: 72 * H }, timelyFilingDays: 365, source: '42 CFR 419.82; 42 CFR 405 subpart I; 42 CFR 424.44', appeals: ['redetermination', 'reconsideration', 'hearing'] },
  'commercial-employer': { label: 'Commercial (employer)', onMissed: 'deemed-exhausted', filing: 'CI', deadlines: { standardMs: 15 * D, expeditedMs: 72 * H, extensionMs: 15 * D, concurrentUrgentMs: 24 * H, claimMs: 30 * D, appealFileMs: 180 * D, appealPreMs: 30 * D, appealPostMs: 60 * D, appealExpeditedMs: 72 * H, externalFileMs: 122 * D, externalMs: 45 * D, externalExpeditedMs: 72 * H }, timelyFilingDays: 180, timelyFilingNote: 'a contract term, set per plan', source: '29 CFR 2560.503-1; 45 CFR 147.136', appeals: ['internal-appeal', 'external-review'] },
  'commercial-marketplace': { label: 'Commercial (marketplace)', onMissed: 'deemed-exhausted', filing: 'CI', deadlines: { standardMs: 15 * D, expeditedMs: 72 * H, extensionMs: 15 * D, concurrentUrgentMs: 24 * H, claimMs: 30 * D, appealFileMs: 180 * D, appealPreMs: 30 * D, appealPostMs: 60 * D, appealExpeditedMs: 72 * H, externalFileMs: 122 * D, externalMs: 45 * D, externalExpeditedMs: 72 * H }, timelyFilingDays: 180, timelyFilingNote: 'a contract term, set per plan', source: '45 CFR 147.136 (applies 29 CFR 2560.503-1)', appeals: ['internal-appeal', 'external-review'] },
  'self-pay': { label: 'Self-pay', filing: '09', deadlines: {}, timelyFilingDays: null, source: '45 CFR 149.610 (good faith estimate)', appeals: [] },
};
export const emptyAccumulators = () => ({ deductibleMet: 0, outOfPocket: 0 });
/**
 * What the member owes on one allowed amount, in the order plans apply it: copay if the service has one, otherwise
 * deductible then coinsurance, never past the out-of-pocket maximum. Returns the parts and the new accumulators.
 */
export function costShare(benefits, acc, allowed, { service = 'other', inNetwork = true } = {}) {
  const b = inNetwork || !benefits.outOfNetwork ? benefits : { ...benefits, ...benefits.outOfNetwork };
  const room = Math.max(0, (b.oopMax ?? Infinity) - acc.outOfPocket); let copay = 0; let deductible = 0; let coinsurance = 0;
  const cp = b.copays?.[service];
  if (cp != null) copay = Math.min(cp, allowed, room);
  else { deductible = Math.min(Math.max(0, (b.deductible || 0) - acc.deductibleMet), allowed, room); coinsurance = Math.min(money((allowed - deductible) * (b.coinsurance || 0)), room - deductible); }
  const owes = money(copay + deductible + coinsurance);
  return { copay: money(copay), deductible: money(deductible), coinsurance: money(coinsurance), patientOwes: owes, planPays: money(allowed - owes), accumulators: { deductibleMet: money(acc.deductibleMet + deductible), outOfPocket: money(acc.outOfPocket + owes) } };
}

export function createPlans(c) {
  const { store, now, put, get, list, hospital, send, log } = c;
  const profile = async (ctx) => (await store.get('InsProfile', 'profile', c.opts(ctx))) || null;
  async function setProfile(body, ctx) {
    hospital(ctx, ['researcher']);
    if (!PROFILES[body?.kind]) throw new HttpError(422, `Choose a hospital profile: ${Object.keys(PROFILES).join(', ')}`);
    const mix = body.payerMix || ref.setting(`payer-mix:${body.kind}`)?.mix || ref.setting('payer-mix:default')?.mix || null;
    if (!mix || Math.abs(Object.values(mix).reduce((n, v) => n + Number(v), 0) - 1) > 0.01 || Object.keys(mix).some((k) => !PLAN_TYPES[k])) throw new HttpError(422, `Give the payer mix as shares that add to 1 over: ${Object.keys(PLAN_TYPES).join(', ')}, or import a payer-mix file for this profile`);
    if (!/^\d{10}$/.test(String(body.npi || ''))) throw new HttpError(422, 'Give the hospital\'s 10-digit NPI');
    const cur = await profile(ctx);
    return strip(await put(ctx, 'InsProfile', { ...(cur ? strip(cur) : {}), id: 'profile', kind: body.kind, label: PROFILES[body.kind], npi: String(body.npi), taxId: String(body.taxId || '000000000'), taxonomy: body.taxonomy || '282N00000X', state: body.state || null, locality: body.locality || null, mac: body.mac || null, chargeKey: body.chargeKey || null, chargeMultiple: Number(body.chargeMultiple) || null, payerMix: mix, seed: Number.isInteger(body.seed) ? body.seed : cur?.seed ?? 1,
      // Extra payments on inpatient remittances (42 CFR 412.105, 412.106): shares you enter from the hospital's own impact file figures.
      teachingAdjustment: body.kind === 'safety-net' ? Number(body.teachingAdjustment) || 0 : Number(body.teachingAdjustment) || 0, dshAdjustment: Number(body.dshAdjustment) || 0, baseRate: Number(body.baseRate) || null, ownedClinics: body.ownedClinics !== false }, 'ins.profile.set', { kind: body.kind }, `hospital profile set to ${PROFILES[body.kind]}`));
  }
  async function createPlan(body, ctx) {
    hospital(ctx, ['researcher']);
    const t = PLAN_TYPES[body?.type]; if (!t) throw new HttpError(422, `type must be one of: ${Object.keys(PLAN_TYPES).join(', ')}`);
    const n = (await list(ctx, 'InsPlan')).length + 1; const year = Number(body.year) || Number(day(now(ctx)).slice(0, 4)); const limits = ref.setting(`limits:${year}`)?.[body.type] || null;
    const b = { ...(limits || {}), ...(body.benefits || {}) };
    if (body.type !== 'self-pay' && (b.deductible == null || b.oopMax == null || (b.coinsurance == null && !b.copays))) throw new HttpError(422, `Give this plan's deductible, coinsurance or copays, and out-of-pocket maximum, or import benefit-limits-${year}.json with a "${body.type}" entry`);
    return strip(await put(ctx, 'InsPlan', { id: `PLAN${n}`, n, type: body.type, name: `Plan ${n} (${t.label})`, insurer: `Insurer ${Math.ceil(n / 2)}`, year, filing: t.filing, benefits: { deductible: Number(b.deductible) || 0, coinsurance: Number(b.coinsurance) || 0, oopMax: b.oopMax == null ? null : Number(b.oopMax), copays: b.copays || {}, outOfNetwork: b.outOfNetwork || null }, benefitsFrom: limits ? `benefit-limits-${year}` : 'entered for this plan',
      network: { npis: (body.network?.npis || []).map(String), states: body.network?.states || [], all: body.network?.all === true }, authRequired: (body.authRequired || []).map(String), referralRequired: Boolean(body.referralRequired), prepayReview: (body.prepayReview || []).map(String), onMissedDeadline: ['deemed-denied', 'deemed-exhausted', 'auto-approve', 'flag'].includes(body.onMissedDeadline) ? body.onMissedDeadline : t.onMissed || 'flag',
      deadlines: { ...t.deadlines, ...(body.deadlines || {}) }, deadlinesSource: t.source, timelyFilingDays: body.timelyFilingDays ?? t.timelyFilingDays, appeals: t.appeals, rateSource: body.rateSource || (body.type.startsWith('medicare') || body.type === 'medicaid' ? 'fee-schedule' : 'negotiated'), rateMultiple: Number(body.rateMultiple) || 1, goldCard: { threshold: Number(body.goldCard?.threshold) || 0.9, minimumDecisions: Number(body.goldCard?.minimumDecisions) || 20, on: body.goldCard?.on !== false }, status: 'active' }, 'ins.plan.create', { type: body.type }, `plan ${n} created`));
  }
  const plans = async (ctx) => (await list(ctx, 'InsPlan')).map(strip).sort((a, b) => a.n - b.n);
  const coverageOf = async (ctx, patientId, date = null) => { const on = day(date || now(ctx)); return (await list(ctx, 'InsCoverage', (x) => x.patient === patientId && x.status === 'active')).filter((x) => day(x.start) <= on && (!x.end || on <= day(x.end))).sort((a, b) => a.order - b.order).map(strip); };

  /** Enrol one patient: the sponsor sends an 834, the insurer makes the member from it, and the hospital gets a coverage card. */
  async function enrol(ctx, patient, plan, { start, order = 1, by = 'assigned' } = {}) {
    const sub = { patientNumber: patientNumber(patient), memberId: memberNumber(patient.id, plan.id), birthDate: patient.birthDate || null, gender: patient.gender || 'unknown' };
    if (plan.type === 'self-pay') return strip(await put(ctx, 'InsCoverage', { id: randomUUID(), patient: patient.id, plan: plan.id, planName: plan.name, type: plan.type, memberId: null, order, start: start || day(now(ctx)), end: null, status: 'active', by }, 'ins.coverage.self-pay', { patient: patient.id }, 'self-pay recorded', { patientRef: `Patient/${patient.id}` }));
    const e = { id: `EN${randomUUID().slice(0, 8)}`, at: now(ctx), payer: { id: plan.id, name: plan.name }, action: 'add', subscriber: sub, plan: plan.id, start: start || `${plan.year}-01-01`, end: null };
    return store.transaction(async (tx) => {
      const text = x12.enrollment834(e, { control: c.nextControl(), at: e.at }); const got = x12.readEnrollment834(x12.parse(text).transactions[0]); // the insurer reads the 834, not the hospital's records
      await send(tx, ctx, { from: 'sponsor', to: 'insurer', type: '834', x12: text, about: { kind: 'member', ref: got.subscriber.memberId }, summary: `enrolment of member ${got.subscriber.memberId}` });
      await tx.save('InsMember', { resourceType: 'InsMember', id: got.subscriber.memberId, plan: got.plan, patientNumber: got.subscriber.patientNumber, birthDate: got.subscriber.birthDate, gender: got.subscriber.gender, start: got.start, end: got.end, status: 'active', accumulators: { [String(plan.year)]: emptyAccumulators() } }, { branch: ctx.branch, updatedBy: 'enrolment' });
      const cov = await tx.save('InsCoverage', { resourceType: 'InsCoverage', id: randomUUID(), patient: patient.id, plan: plan.id, planName: plan.name, insurer: plan.insurer, type: plan.type, memberId: sub.memberId, order, start: e.start, end: null, status: 'active', by }, { branch: ctx.branch, updatedBy: ctx.actor.role });
      await log(tx, ctx, 'ins.coverage.enrol', { patient: patient.id, plan: plan.id, order, by }, `enrolled in ${plan.name}`, { patientRef: `Patient/${patient.id}` });
      return strip(cov);
    });
  }
  /** Give imported patients coverage from the profile's payer mix. Seeded: the same seed gives the same plan for the same patient. */
  async function assign(body, ctx) {
    hospital(ctx, ['researcher']);
    const prof = await profile(ctx); if (!prof) throw new HttpError(409, 'Set the hospital profile first'); const all = await plans(ctx); if (!all.length) throw new HttpError(409, 'Create at least one plan first');
    const seed = Number.isInteger(body?.seed) ? body.seed : prof.seed; const pts = body?.patients?.length ? body.patients : (await store.query('Patient', {}, c.opts(ctx))).map((p) => p.id); const out = [];
    for (const pid of pts) {
      const p = await store.get('Patient', pid, c.opts(ctx)); if (!p) continue; if ((await coverageOf(ctx, pid)).length) { out.push({ patient: pid, kept: true }); continue; }
      const rnd = mulberry32(hashInt(`${seed}:${pid}`)); let r = rnd(); let type = Object.keys(prof.payerMix)[0];
      for (const [t, share] of Object.entries(prof.payerMix)) { if (r < share) { type = t; break; } r -= share; }
      const ofType = all.filter((x) => x.type === type); if (!ofType.length) { out.push({ patient: pid, skipped: `no plan of type ${type}` }); continue; }
      const plan = ofType[Math.floor(rnd() * ofType.length)]; out.push({ patient: pid, plan: plan.id, type, coverage: (await enrol(ctx, p, plan, { by: `payer mix, seed ${seed}` })).id });
    }
    return { seed, assigned: out.filter((o) => o.coverage).length, kept: out.filter((o) => o.kept).length, results: out };
  }
  /** The per-patient override: this patient's coverage is set by hand. order 2 adds a secondary plan. */
  async function override(patientId, body, ctx) {
    hospital(ctx, ['researcher', 'nurse', 'coder', 'payer-medical-director']);
    const p = await store.get('Patient', patientId, c.opts(ctx)); if (!p) throw new HttpError(404, 'No such patient'); const plan = await get(ctx, 'InsPlan', body?.plan); const order = body.order === 2 ? 2 : 1;
    for (const cur of await list(ctx, 'InsCoverage', (x) => x.patient === patientId && x.status === 'active' && x.order === order)) await put(ctx, 'InsCoverage', { ...strip(cur), status: 'ended', end: day(now(ctx)) }, 'ins.coverage.end', { patient: patientId }, 'coverage ended by override');
    return enrol(ctx, p, strip(plan), { start: body.start, order, by: `set by ${ctx.actor.role}` });
  }

  /** Eligibility at registration: a 270 goes out, the insurer answers from its own member record with a 271. */
  async function eligibility(body, ctx) {
    hospital(ctx);
    const prof = await profile(ctx); if (!prof) throw new HttpError(409, 'Set the hospital profile first');
    const p = await store.get('Patient', String(body?.patient || ''), c.opts(ctx)); if (!p) throw new HttpError(404, 'No such patient');
    const cov = (await coverageOf(ctx, p.id, body.serviceDate)).find((x) => x.order === (body.order === 2 ? 2 : 1));
    if (!cov || cov.type === 'self-pay') return { patient: p.id, patientNumber: patientNumber(p), selfPay: true, note: 'No coverage on file for this date: self-pay. A good faith estimate is owed before scheduled care.' };
    const plan = strip(await get(ctx, 'InsPlan', cov.plan)); const q = { id: `EL${randomUUID().slice(0, 8)}`, at: now(ctx), payer: { id: plan.id, name: plan.name }, provider: { npi: prof.npi }, subscriber: { patientNumber: patientNumber(p), memberId: cov.memberId, birthDate: p.birthDate, gender: p.gender }, serviceDate: day(body.serviceDate || now(ctx)), serviceType: body.serviceType || '30' };
    return store.transaction(async (tx) => {
      const out270 = x12.eligibility270(q, { control: c.nextControl(), at: q.at }); await send(tx, ctx, { from: 'hospital', to: 'insurer', type: '270', x12: out270, fhir: fhirEligibilityRequest(q, p.id), about: { kind: 'eligibility', ref: q.id }, summary: `eligibility asked for member ${cov.memberId}` });
      const got = x12.readEligibility270(x12.parse(out270).transactions[0]); const answer = await answer271(tx, ctx, got, plan);
      const in271 = x12.eligibility271(answer, { control: c.nextControl(), at: q.at }); await send(tx, ctx, { from: 'insurer', to: 'hospital', type: '271', x12: in271, about: { kind: 'eligibility', ref: q.id }, summary: answer.reject ? 'member not found' : 'eligibility answered' });
      const back = x12.readEligibility271(x12.parse(in271).transactions[0]);
      await log(tx, ctx, 'ins.eligibility.check', { patient: p.id, plan: plan.id, active: back.active }, 'eligibility checked', { patientRef: `Patient/${p.id}`, kind: 'read' });
      const amt = (code) => back.benefits.find((b) => b.code === code && b.amount != null)?.amount ?? null;
      return { patient: p.id, patientNumber: q.subscriber.patientNumber, memberId: cov.memberId, plan: plan.id, planName: plan.name, type: plan.type, active: back.active, reject: back.reject || null, start: back.start, deductibleRemaining: amt('C'), outOfPocketRemaining: amt('G'), coinsurance: back.benefits.find((b) => b.code === 'A')?.percent ?? null, copays: Object.fromEntries(back.benefits.filter((b) => b.code === 'B').map((b) => [b.serviceType, b.amount])), authRequired: back.benefits.some((b) => b.authRequired), inNetwork: back.benefits.find((b) => b.inNetwork != null)?.inNetwork ?? null, x12: { request: out270, response: in271 }, fhir: { request: fhirEligibilityRequest(q, p.id), response: fhirEligibilityResponse(back, q, p.id) } };
    });
  }
  /** The insurer's answer, from the insurer's own member and plan records only. Remaining amounts carry the CAQH CORE content. */
  async function answer271(tx, ctx, q, plan) {
    const m = await tx.get('InsMember', q.subscriber.memberId, { branch: ctx.branch }); const base = { id: q.id, at: now(ctx), payer: q.payer, provider: q.provider, subscriber: q.subscriber };
    if (!m || m.plan !== plan.id) return { ...base, reject: '75' }; // subscriber not found
    const active = m.status === 'active' && day(m.start) <= q.serviceDate && (!m.end || q.serviceDate <= day(m.end)); const acc = m.accumulators?.[q.serviceDate.slice(0, 4)] || emptyAccumulators(); const b = plan.benefits;
    const inNet = plan.network.all || plan.network.npis.includes(q.provider.npi) || (ref.npi(q.provider.npi) && plan.network.states.includes(ref.npi(q.provider.npi).state));
    return { ...base, active, plan: plan.id, start: m.start, end: m.end, benefits: active ? [{ code: 'C', serviceType: '30', period: '29', amount: money(Math.max(0, b.deductible - acc.deductibleMet)) }, ...(b.oopMax != null ? [{ code: 'G', serviceType: '30', period: '29', amount: money(Math.max(0, b.oopMax - acc.outOfPocket)) }] : []), ...(b.coinsurance ? [{ code: 'A', serviceType: '30', percent: b.coinsurance }] : []), ...Object.entries(b.copays || {}).map(([svc, amount]) => ({ code: 'B', serviceType: { office: '98', specialist: '3', emergency: '86', inpatient: '48', imaging: '4', pharmacy: '88' }[svc] || '30', amount })), { code: 'CB', serviceType: q.serviceType, authRequired: plan.authRequired.length > 0, inNetwork: Boolean(inNet) }] : [] };
  }
  const fhirEligibilityRequest = (q, patientId) => ({ resourceType: 'CoverageEligibilityRequest', id: q.id, status: 'active', purpose: ['benefits', 'validation'], patient: { reference: `Patient/${patientId}`, display: q.subscriber.patientNumber }, servicedDate: q.serviceDate, created: q.at, insurer: { identifier: { value: q.payer.id }, display: q.payer.name }, provider: { identifier: { system: 'http://hl7.org/fhir/sid/us-npi', value: q.provider.npi } }, insurance: [{ coverage: { identifier: { value: q.subscriber.memberId } } }] });
  const fhirEligibilityResponse = (a, q, patientId) => ({ resourceType: 'CoverageEligibilityResponse', id: `${q.id}-r`, status: 'active', purpose: ['benefits', 'validation'], patient: { reference: `Patient/${patientId}`, display: q.subscriber.patientNumber }, created: q.at, request: { reference: `CoverageEligibilityRequest/${q.id}` }, outcome: a.reject ? 'error' : 'complete', insurer: { identifier: { value: q.payer.id }, display: q.payer.name }, insurance: [{ coverage: { identifier: { value: q.subscriber.memberId } }, inforce: Boolean(a.active), item: (a.benefits || []).map((b) => ({ category: { coding: [{ system: 'https://x12.org/codes/service-type-codes', code: b.serviceType }] }, authorizationRequired: b.authRequired ?? undefined, network: b.inNetwork == null ? undefined : { coding: [{ code: b.inNetwork ? 'in' : 'out' }] }, benefit: [{ type: { coding: [{ code: { C: 'deductible', G: 'out-of-pocket-maximum', A: 'coinsurance', B: 'copay', CB: 'coverage-basis' }[b.code] || b.code }] }, ...(b.amount != null ? { allowedMoney: { value: b.amount, currency: 'USD' } } : {}), ...(b.percent != null ? { allowedUnsignedInt: Math.round(b.percent * 100) } : {}) }] })) }] });
  const fhirCoverage = (cov, plan) => ({ resourceType: 'Coverage', id: cov.id, status: cov.status === 'active' ? 'active' : 'cancelled', type: { text: plan?.name ?? 'Self-pay' }, subscriberId: cov.memberId, beneficiary: { reference: `Patient/${cov.patient}` }, period: { start: cov.start, ...(cov.end ? { end: cov.end } : {}) }, payor: [{ display: cov.insurer || 'Self-pay' }], order: cov.order, class: plan ? [{ type: { coding: [{ code: 'plan' }] }, value: plan.id, name: plan.name }] : [] });
  /** The digital insurance card and the accumulators, for the chart and the Patient Portal. Accumulators are read from the insurer's 271, as a real card screen does. */
  async function card(ctx, patientId) {
    const p = await store.get('Patient', patientId, c.opts(ctx)); if (!p) throw new HttpError(404, 'No such patient'); const out = [];
    for (const cov of await coverageOf(ctx, patientId)) { const plan = cov.plan ? strip(await get(ctx, 'InsPlan', cov.plan)) : null; const m = cov.memberId ? await store.get('InsMember', cov.memberId, c.opts(ctx)) : null; const acc = m?.accumulators?.[day(now(ctx)).slice(0, 4)] || emptyAccumulators();
      out.push({ ...cov, patientNumber: patientNumber(p), order: cov.order === 1 ? 'primary' : 'secondary', benefits: plan?.benefits ?? null, accumulators: plan ? { deductibleMet: acc.deductibleMet, deductible: plan.benefits.deductible, outOfPocket: acc.outOfPocket, oopMax: plan.benefits.oopMax } : null, deadlinesSource: plan?.deadlinesSource ?? null, fhir: fhirCoverage(cov, plan) }); }
    return { patient: patientId, patientNumber: patientNumber(p), coverage: out, selfPay: !out.length || out.every((x) => x.type === 'self-pay') };
  }
  return { profile, setProfile, createPlan, plans, coverageOf, enrol, assign, override, eligibility, card, fhirCoverage };
}
