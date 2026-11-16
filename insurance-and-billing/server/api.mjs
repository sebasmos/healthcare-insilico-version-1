// The insurance environment's own API (/api/ins): hospital side, insurer side and patient side over one engine.
// The insurer's records are built only from what crossed the wire; hospital staff never approve or deny.
import { HttpError, createContext, strip, money } from './common.mjs';
import { createPlans, PROFILES, PLAN_TYPES } from './plans.mjs';
import { createPolicies } from './policies.mjs';
import { createAuths } from './auths.mjs';
import { createClaims } from './claims.mjs';
import { createDaVinci } from './davinci.mjs';
import { createOperations } from './operations.mjs';
import { createOutcomes } from './outcomes.mjs';
import { createClock } from './clock.mjs';
import { createScenarios } from './scenarios.mjs';
import * as ref from './reference.mjs';

export const INS_TYPES = ['InsProfile', 'InsPlan', 'InsCoverage', 'InsMember', 'InsMessage', 'InsPolicy', 'InsAuth', 'InsCase', 'InsRuleLog', 'InsLetter', 'InsPeer', 'InsAppeal', 'InsCoding', 'InsQuery', 'InsClaim', 'InsPayerClaim', 'InsEob', 'InsEstimate', 'InsComplaint', 'InsSubscription', 'InsAudit', 'InsStay', 'InsHarm', 'InsDispute', 'InsScenarioRun'];

export function createInsApi({ store }) {
  const c = createContext({ store }); const plans = createPlans(c); const policies = createPolicies(c); const auths = createAuths(c, { plans, policies }); const claims = createClaims(c, { plans, auths }); const davinci = createDaVinci(c, { plans, policies, auths, claims }); const ops = createOperations(c, { plans, auths, claims }); const study = createOutcomes(c, { plans, policies, ops }); const clock = createClock(c, { auths, ops }); const scenarios = createScenarios(c, { plans, policies, auths, claims });
  const ok = (body, status = 200) => ({ status, body });
  // Pushed, not polled: every answer that reaches the hospital on the live record goes at once to the EHR screens that are open (a stream) and to each subscriber's address.
  const streams = new Set(); const addStream = (res) => { streams.add(res); res.on('close', () => streams.delete(res)); }; const closeStreams = () => { for (const res of streams) { try { res.end(); } catch { /* gone */ } } streams.clear(); };
  const mayPushTo = (endpoint) => { try { const u = new URL(endpoint); return ['http:', 'https:'].includes(u.protocol) && (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || process.env.ALLOW_SUBSCRIPTION_PUSH === 'true'); } catch { return false; } };
  c.onWire(async (m, ctx) => {
    if (m.to !== 'hospital' || ctx.branch !== 'main' || !['278', '835', '277CA'].includes(m.type)) return;
    const note = { topic: m.type === '278' ? 'authorization' : 'claim', type: m.type, about: m.about, summary: m.summary, at: m.at };
    for (const res of streams) { try { res.write(`event: insurance\ndata: ${JSON.stringify(note)}\n\n`); } catch { streams.delete(res); } }
    if (m.type !== '278' || !m.about?.ref) return; const sys = { ...ctx, actor: { kind: 'human', id: 'subscriptions', role: 'system' } };
    for (const sub of await c.list(sys, 'InsSubscription', (s2) => s2.status === 'active' && s2.topic === 'pas')) {
      const n = sub.events.length + 1; let delivered = null;
      if (sub.endpoint && mayPushTo(sub.endpoint)) { try { const response = await davinci.response(sys, m.about.ref); const r = await fetch(sub.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/fhir+json' }, signal: AbortSignal.timeout(3000), body: JSON.stringify({ resourceType: 'Bundle', type: 'history', entry: [{ resource: { resourceType: 'SubscriptionStatus', status: 'active', type: 'event-notification', eventsSinceSubscriptionStart: String(n), subscription: { reference: `Subscription/${sub.id}` }, topic: 'http://hl7.org/fhir/us/davinci-pas/SubscriptionTopic/PASSubscriptionTopic', notificationEvent: [{ eventNumber: String(n), timestamp: m.at, focus: { reference: `ClaimResponse/${m.about.ref}` } }] } }, { resource: response }] }) }); delivered = { status: r.status, at: c.now(sys) }; } catch (err) { delivered = { error: String(err.message || err).slice(0, 200), at: c.now(sys) }; } }
      else if (sub.endpoint) delivered = { error: 'This address is not allowed: only this machine, unless ALLOW_SUBSCRIPTION_PUSH=true' };
      await c.put(sys, 'InsSubscription', { ...strip(sub), events: [...sub.events, { n, at: m.at, focus: m.about.ref, delivered }] }, 'ins.subscription.notify', { subscription: sub.id, focus: m.about.ref, delivered: delivered?.status ?? delivered?.error ?? 'kept for the subscriber to read' }, 'subscriber notified');
    }
  });
  const insurerOnly = (ctx) => { if (ctx.actor.kind === 'human' && !['insurer', 'any'].includes(c.sideOf(ctx))) throw new HttpError(403, 'This belongs to the insurer'); };
  const notInsurer = (ctx) => { if (ctx.actor.kind === 'human' && c.sideOf(ctx) === 'insurer') throw new HttpError(403, 'The insurer sees only what the hospital sent'); };

  /** Prior authorization figures in the layout of the CMS-0057-F public report, and the hospital's own revenue figures. */
  async function metrics(ctx) {
    const cases = (await c.list(ctx, 'InsCase')).map(strip); const decided = cases.filter((k) => k.decision); const hours = (k) => (Date.parse(k.decision.at || k.decidedAt || k.receivedAt) - Date.parse(k.receivedAt)) / 36e5;
    const part = (urg) => { const all = decided.filter((k) => (k.urgency === 'expedited') === (urg === 'expedited')); const t = all.map(hours).sort((a, b) => a - b); const pct = (n) => (all.length ? Math.round((1000 * n) / all.length) / 10 : null); return { requests: all.length, approvedPercent: pct(all.filter((k) => k.status === 'approved').length), deniedPercent: pct(all.filter((k) => k.status === 'denied').length), approvedAfterAppealPercent: pct(all.filter((k) => k.overturned).length), averageHours: t.length ? Math.round((10 * t.reduce((n, x) => n + x, 0)) / t.length) / 10 : null, medianHours: t.length ? Math.round(10 * t[Math.floor(t.length / 2)]) / 10 : null }; };
    const cl = (await c.list(ctx, 'InsClaim')).map(strip); const sent = cl.filter((k) => k.sentAt); const fin = cl.filter((k) => k.remit); const days = fin.map((k) => k.daysToPayment).filter((d) => d != null);
    return { priorAuthorization: { layout: 'CMS-0057-F, 42 CFR 422.122(c) and parallel sections', standard: part('standard'), expedited: part('expedited'), open: cases.length - decided.length },
      hospital: { claimsSent: sent.length, firstPassAcceptedPercent: sent.length ? Math.round((1000 * sent.filter((k) => !k.rejection).length) / sent.length) / 10 : null, deniedPercent: fin.length ? Math.round((1000 * fin.filter((k) => (k.denials || []).length).length) / fin.length) / 10 : null, averageDaysToPayment: days.length ? Math.round((10 * days.reduce((n, d) => n + d, 0)) / days.length) / 10 : null, billed: money(sent.reduce((n, k) => n + k.claim.total, 0)), paid: money(fin.reduce((n, k) => n + (k.remit.paid || 0), 0)), patientOwes: money(fin.reduce((n, k) => n + (k.remit.patientOwes || 0), 0)), heldUpInDenials: money(fin.reduce((n, k) => n + (k.balance?.heldUp || 0), 0)), denialsByReason: Object.entries(fin.flatMap((k) => k.denials || []).reduce((m, d) => ({ ...m, [d.carc]: (m[d.carc] || 0) + 1 }), {})).map(([carc, count]) => ({ carc, text: claims.carcText(carc), count })).sort((a, b) => b.count - a.count) } };
  }
  /** Inbox folders for the hospital: what the insurer is waiting for, letters to sign, denials, and coding questions. */
  async function inbox(ctx) {
    const au = await auths.workQueue(ctx, {}); const cl = await claims.hospitalClaims(ctx, { denied: 1 }); const row = (a) => ({ id: a.id, patientNumber: a.patientNumber, what: `Authorization: ${(a.services || []).map((x) => x.code).join(', ')}`, plan: a.plan, timeLeftMs: a.timeLeftMs ?? null });
    return { 'ins-info': au.filter((a) => a.status === 'info-requested').map((a) => ({ ...row(a), detail: (a.infoNeeded || []).join('; ') })), 'ins-letters': (await c.list(ctx, 'InsLetter', (l) => l.from === 'hospital' && !l.signedBy)).map(strip),
      'ins-denials': [...au.filter((a) => a.status === 'denied').map((a) => ({ ...row(a), detail: (a.unmet || []).map((x) => x.text).join('; ') || a.decisionNote || '' })), ...cl.map((k) => ({ id: k.id, patientNumber: k.patientNumber, what: `Claim ${k.id}`, plan: k.plan, detail: (k.denials || []).map((d) => `${d.carc}: ${d.text}`).join('; ') || k.rejection?.text || '', timeLeftMs: null }))],
      'ins-queries': (await c.list(ctx, 'InsQuery', (x) => !x.answer)).map(strip) };
  }
  /** Everything a patient may see about their own insurance, in plain words. */
  async function mine(ctx, pid) {
    const auth = (await auths.workQueue(ctx, { patient: pid })); const letters = (await c.list(ctx, 'InsLetter', (l) => l.patient === pid && l.to !== 'insurer')).map(strip);
    return { card: await plans.card(ctx, pid), authorizations: auth, letters, explanations: await claims.eobs(ctx, pid), appeals: await auths.appeals(ctx, { patient: pid }), estimates: (await c.list(ctx, 'InsEstimate', (e) => e.patient === pid)).map(strip), complaints: (await c.list(ctx, 'InsComplaint', (e) => e.patient === pid)).map(strip) };
  }

  async function handle(req, url, body, ctx) {
    const seg = url.pathname.split('/').filter(Boolean).slice(2).map(decodeURIComponent); const [a, b, d] = seg; const m = req.method; const q = Object.fromEntries(url.searchParams); const G = m === 'GET'; const P = m === 'POST';
    // Time passing has effects by itself: missed deadlines and crossed clinical thresholds are applied before anything is read. On the live record only a person's request moves the clock's effects; an agent's request does so only on its own branch.
    if (!ctx.asOf && (ctx.actor.kind === 'human' || ctx.branch !== 'main') && a !== 'meta' && a !== 'reference') { try { await clock.sweep(ctx); } catch (err) { console.error('insurance clock:', err.message); } }
    if (P && a === 'clock') return ok(await clock.sweep(ctx));
    const patientPid = ctx.actor.role === 'patient' ? (req.person?.patientId || null) : null;
    if (ctx.actor.role === 'patient' && ctx.actor.kind === 'human') {
      const pid = patientPid || q.patient; if (!pid) throw new HttpError(403, 'Your sign-in is not linked to a patient record yet');
      if (a !== 'my') throw new HttpError(403, 'This is not available to a patient');
      if (G && !b) return ok(await mine(ctx, pid));
      if (P && b === 'appeal') { const own = body?.about?.kind === 'auth' ? (await auths.hospitalView(ctx, body.about.ref)).patient : (await claims.hospitalClaim(ctx, body?.about?.ref)).patient; if (own !== pid) throw new HttpError(403, 'You can appeal only your own decisions'); return ok(await auths.appeal(body, ctx), 201); }
      if (P && b === 'complaint') { const text = String(body?.text || '').trim(); if (text.length < 10) throw new HttpError(422, 'Write the complaint'); return ok(strip(await c.put(ctx, 'InsComplaint', { id: crypto.randomUUID(), patient: pid, text: text.slice(0, 4000), about: body.about || null, at: c.now(ctx), status: 'received' }, 'ins.complaint', {}, 'complaint filed', { patientRef: `Patient/${pid}` })), 201);
      }
      throw new HttpError(404, 'Not found');
    }
    if (a === 'davinci') { if (c.sideOf(ctx) === 'insurer' && b && seg[2] !== 'metadata' && !['cdex', 'remittance', 'pdex', 'formulary', 'plannet'].includes(b)) throw new HttpError(403, 'This interface reads the hospital\'s chart: the insurer sees only what the hospital sent'); return davinci.handle(req, url, body, ctx, seg.slice(1)); }
    // ----- shared -----
    if (G && a === 'meta') return ok({ profiles: PROFILES, planTypes: PLAN_TYPES, missedDeadlineRules: clock.MISSED, reference: ref.referenceStatus(), side: c.sideOf(ctx) });
    if (G && a === 'reference' && b === 'codes') return ok(ref.searchCodes(q.system || null, q.q || '', Math.min(50, Number(q.limit) || 20)));
    if (G && a === 'reference' && b === 'npi' && d) { const n = ref.npi(d); const plan = q.plan ? strip(await c.get(ctx, 'InsPlan', q.plan)) : null; return ok({ found: Boolean(n), ...(n || { npi: d }), ...(plan ? { plan: plan.id, inNetwork: plan.network.all || plan.network.npis.includes(d) || Boolean(n && plan.network.states.includes(n.state)) } : {}) }); }
    if (P && a === 'reference' && b === 'drg') return ok(claims.groupDrg({ diagnoses: (body.diagnoses || []).map((x) => (typeof x === 'string' ? { code: x.replace('.', '').toUpperCase() } : x)), procedures: body.procedures || [], age: body.age ?? null, sex: body.sex ?? null, dischargeStatus: body.dischargeStatus || '01', entered: body.drg || null }));
    if (P && a === 'coding' && d === 'edits') return ok(claims.ncciEdits((body.lines || []).map((l) => ({ ...l, code: String(l.code).toUpperCase(), modifiers: l.modifiers || [], units: Number(l.units) || 1 })), body));
    if (G && a === 'metrics') return ok(await metrics(ctx));
    if (G && a === 'friction') return ok(ops.FRICTION);
    if (a === 'scenarios') {
      if (b === 'runs' && d) { const act = seg[3]; if (G && !act) return ok(await scenarios.view(d, ctx)); if (P && act === 'answer') return ok(await scenarios.answer(d, body, ctx)); if (P && act === 'grade') return ok(await scenarios.grade(d, ctx)); if (P && act === 'reference') return ok(await scenarios.confirmReference(d, body, ctx)); }
      if (G && b === 'runs') return ok(await scenarios.runs(ctx));
      if (G && !b) { if (ctx.actor.kind !== 'human' || ctx.actor.role !== 'researcher') throw new HttpError(403, 'Scenarios are for the Researcher'); return ok(scenarios.library()); }
      if (P && b && d === 'start') return ok(await scenarios.start(b, body, ctx), 201);
    }
    if (a === 'outcomes') { if (ctx.actor.kind !== 'human' || !['researcher'].includes(ctx.actor.role)) throw new HttpError(403, 'Outcomes and reference answers are for the Researcher'); if (P && b === 'counterfactual') return ok(await study.counterfactual(ctx, body)); if (G || P) return ok(await study.outcomes(ctx, body?.reference || {})); }
    if (a === 'idr') { if (G) return ok(await ops.disputes(ctx)); if (P) return ok(await ops.idr(b || null, b ? body : { ...body, action: 'open' }, ctx), b ? 200 : 201); }
    if (a === 'consequences') { if (G) return ok(await ops.consequences(ctx)); if (P) return ok(await ops.declare(body, ctx), 201); }
    if (G && a === 'audits') return ok(await ops.audits(ctx));
    if (a === 'plans') { if (G) return ok((await plans.plans(ctx))); if (P) return ok(await plans.createPlan(body, ctx), 201); }
    if (a === 'policies') { if (G && b) { const p = (await policies.library(ctx)).filter((x) => x.usable && (x.policyId || x.id) === b && (!q.version || String(x.version) === q.version))[0]; if (!p) throw new HttpError(404, 'No such policy'); return ok(p); } if (G) return ok(q.search ? await policies.search(ctx, q) : await policies.library(ctx, { code: q.code || null })); if (P && b === 'confirm') return ok(await policies.confirm(body, ctx)); }
    if (G && a === 'messages') { const rows = (await c.list(ctx, 'InsMessage', (x) => (!q.ref || x.about?.ref === q.ref) && (!q.type || x.type === q.type) && (c.sideOf(ctx) !== 'insurer' || x.to === 'insurer' || x.from === 'insurer'))).map(strip).sort((x, y) => String(x.at).localeCompare(String(y.at))); return ok(rows.slice(-(Number(q.limit) || 200))); }
    // ----- insurer side -----
    if (a === 'payer') {
      if (G && b === 'queue') { insurerOnly(ctx); return ok(q.queue === 'claims' ? await claims.claimsQueue(ctx, q) : q.queue === 'appeals' ? await auths.appeals(ctx, { open: !q.all }) : await auths.queue(ctx, q)); }
      if (G && b === 'cases' && d) return ok(await auths.caseView(ctx, d));
      if (P && b === 'cases' && d) { const act = seg[3]; if (act === 'decide') return ok(await auths.decide(d, body, ctx)); if (act === 'recommend') return ok(await auths.recommend(d, body, ctx)); if (act === 'peer') return ok(await auths.peerToPeer(d, body, ctx)); }
      if (G && b === 'claims' && d) return ok(await claims.payerClaim(ctx, d));
      if (G && b === 'members' && d) { insurerOnly(ctx); const m = strip(await c.get(ctx, 'InsMember', d)); return ok({ member: m, claims: (await c.list(ctx, 'InsPayerClaim', (k) => k.memberId === d)).map((k) => ({ id: k.id, type: k.type, date: k.claim.lines[0].date, charge: k.claim.total, status: k.status, paid: k.result.paid, patientOwes: k.result.patientOwes, remit: k.remit ?? null, lines: k.claim.lines.map((l) => l.code) })), authorizations: (await c.list(ctx, 'InsCase', (k) => k.memberId === d)).map((k) => ({ id: k.id, kind: k.kind, services: k.services, status: k.status, authNumber: k.decision?.authNumber ?? null, from: k.decision?.from ?? null, to: k.decision?.to ?? null })) }); }
      if (P && b === 'claims' && d) { if (seg[3] === 'decide') return ok(await claims.decideClaim(d, body, ctx)); if (seg[3] === 'recommend') return ok(await claims.recommendClaim(d, body, ctx)); }
      if (P && b === 'claims' && d && seg[3] === 'downgrade') return ok(await ops.downgrade(d, body, ctx));
      if (P && b === 'claims' && d && seg[3] === 'audit') return ok(await ops.audit(d, body, ctx));
      if (G && b === 'patterns') return ok(await ops.patterns(ctx));
      if (P && b === 'appeals' && d && seg[3] === 'decide') return ok(await auths.decideAppeal(d, body, ctx));
      if (P && b === 'override' && d) { insurerOnly(ctx); return ok(await plans.override(d, body, ctx)); }
      throw new HttpError(404, 'Not found');
    }
    // ----- hospital side -----
    notInsurer(ctx);
    if (a === 'profile') { if (G) return ok(await plans.profile(ctx)); if (m === 'PUT' || P) return ok(await plans.setProfile(body, ctx)); }
    if (a === 'coverage') { if (G && b && !d) return ok({ coverage: await plans.coverageOf(ctx, b, q.date || null), card: await plans.card(ctx, b) }); if (P && b === 'assign') return ok(await plans.assign(body, ctx)); if (P && b) return ok(await plans.override(b, body, ctx)); }
    if (P && a === 'eligibility') return ok(await plans.eligibility(body, ctx));
    if (a === 'auth') {
      if (P && b === 'need') return ok(await auths.need(body, ctx)); if (P && b === 'questionnaire') return ok(await auths.questionnaire(body, ctx)); if (P && !b) return ok(await auths.submit(body, ctx), 201);
      if (G && !b) return ok(await auths.workQueue(ctx, q)); if (G && b) return ok(await auths.hospitalView(ctx, b));
      if (P && d === 'attach') return ok(await auths.attach(b, body, ctx)); if (P && d === 'peer') return ok(await auths.peerToPeer(b, body, ctx));
    }
    if (G && a === 'stays' && !b) return ok(await ops.stays(ctx));
    if (G && a === 'inbox') return ok(await inbox(ctx));
    if (a === 'stays' && b) { if (G) return ok(await ops.stay(ctx, b)); if (P) return ok(await ops.setStay(b, body, ctx)); }
    if (P && a === 'audits' && b) return ok(await ops.audit(b, body, ctx));
    if (G && a === 'coverage' && b && d === 'order') return ok(await ops.cobOrder(ctx, b));
    if (P && a === 'claims' && b && d === 'secondary') return ok(await ops.secondary(b, ctx), 201);
    if (a === 'letters') { if (P && !b) return ok(await auths.saveLetter(body, ctx), 201); if (P && d === 'sign') return ok(await auths.signLetter(b, ctx)); }
    if (a === 'appeals') { if (G) return ok(await auths.appeals(ctx, q)); if (P) return ok(await auths.appeal(body, ctx), 201); }
    if (a === 'coding') { if (G && !b) return ok(await claims.codingQueue(ctx)); if (G && b) return ok(await claims.codingView(ctx, b)); if (P && d === 'query') return ok(await claims.query(b, body, ctx), 201); if (P && d === 'edits') return ok(claims.ncciEdits(body.lines || [], body)); if (P && b) return ok(await claims.saveCoding(b, body, ctx)); }
    if (a === 'claims') {
      if (G && !b) return ok(await claims.hospitalClaims(ctx, q)); if (G && b && d === 'status') return ok(await claims.status(b, ctx)); if (G && b) return ok(await claims.hospitalClaim(ctx, b));
      if (P && b === 'build') return ok(await claims.build(body.encounter, body, ctx), 201); if (P && d === 'send') return ok(await claims.sendClaim(b, ctx)); if (P && d === 'correct') return ok(await claims.correct(b, body, ctx), 201);
    }
    if (G && a === 'my' && q.patient) return ok(await mine(ctx, q.patient));
    throw new HttpError(404, 'Not found');
  }
  return { handle, c, plans, policies, auths, claims, ops, study, clock, metrics, mine, setHarmReporter: ops.setHarmReporter, addStream, closeStreams };
}
