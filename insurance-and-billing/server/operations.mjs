// Full operations (docs/PAYER.md section 8): inpatient or observation and the two-midnight rule, downgrades,
// coordination of benefits, post-payment audit and recoupment, billing-pattern flags, consequences of delay and
// denial, friction injectors, and independent dispute resolution. All clocks are the simulation clock.
import { HttpError, randomUUID, strip, money, day, x12, patientNumber } from './common.mjs';
import * as ref from './reference.mjs';

export const FRICTION = {
  'lost-attachments': 'Records sent with a request do not arrive: the insurer asks for them again (repeated record requests).',
  'strict-rules': 'The automatic rules approve nothing by themselves: every request goes to a person.',
  'peer-to-peer-delay': 'A peer-to-peer call is offered later than asked.',
  'expired-authorization': 'An approval is good for the day of service only, so care on a later day is billed against an expired authorization.',
  'late-filing': 'The claim reaches the insurer after the plan\'s filing limit.',
  'out-of-network-clinician': 'The rendering clinician is treated as out of network at an in-network facility.',
  'missing-laterality': 'The left, right or both-sides modifier is dropped before the claim leaves, and the insurer denies a per-side procedure billed without it (reason 4).',
  upcoding: 'Each visit code is sent one level higher than it was coded. The coding on file is unchanged; the claim, the log and the insurer\'s billing-pattern flags show it.',
};
const SEVERITY = { 'near-miss': 0, mild: 1, moderate: 3, severe: 7, 'life-threatening': 15, death: 30 };
const midnights = (from, to) => Math.max(0, Math.floor(Date.parse(`${day(to)}T00:00:00Z`) / 864e5) - Math.floor(Date.parse(`${day(from)}T00:00:00Z`) / 864e5));

export function createOperations(c, { plans, auths, claims }) {
  let reportHarm = null; const setHarmReporter = (fn) => { reportHarm = fn; };
  const { store, now, put, get, list, hospital, insurer, send, log, opts } = c;
  const insurerSide = (ctx) => { if (ctx.actor.kind === 'human' && !['insurer', 'any'].includes(c.sideOf(ctx))) throw new HttpError(403, 'This belongs to the insurer'); };

  // ---------- 9. inpatient or observation ----------
  /** The stay as it stands: status, midnights so far and expected, and what the two-midnight rule (42 CFR 412.3) says. */
  async function stay(ctx, encounterId) {
    const enc = await store.get('Encounter', String(encounterId), opts(ctx)); if (!enc) throw new HttpError(404, 'No such encounter'); const rec = strip((await store.get('InsStay', enc.id, opts(ctx))) || { id: enc.id, status: enc.class?.code === 'IMP' ? 'inpatient' : enc.class?.code === 'OBSENC' ? 'observation' : 'outpatient', expectedMidnights: null, history: [] });
    const start = enc.period?.start || now(ctx); const end = enc.period?.end || now(ctx); const so = midnights(start, end); const hours = Math.round((Date.parse(end) - Date.parse(start)) / 36e5); const expected = rec.expectedMidnights;
    const advice = rec.status === 'inpatient' ? (expected != null && expected < 2 && so < 2 ? 'An inpatient admission is generally not payable when the physician expects fewer than two midnights, unless the procedure is inpatient-only or the record supports an exception.' : 'Inpatient is supported when the physician expects, and documents, care crossing two midnights.') : rec.status === 'observation' ? (so >= 2 ? 'This stay has crossed two midnights in observation: review whether an inpatient order is now appropriate.' : 'Observation: outpatient status while the physician decides.') : '';
    return { ...rec, encounter: enc.id, patient: enc.subject?.reference?.split('/')[1] ?? null, admittedAt: start, dischargedAt: enc.period?.end ?? null, midnightsSoFar: so, hoursSoFar: hours, advice, observationNotice: rec.status === 'observation' && hours > 24 ? { due: !rec.noticeGivenAt, rule: 'Medicare Outpatient Observation Notice: given within 36 hours when observation passes 24 hours (42 CFR 489.20(y))', givenAt: rec.noticeGivenAt ?? null } : null };
  }
  /** The physician sets or changes the status. Inpatient to outpatient before discharge is condition code 44: it needs the utilisation review committee and the physician to agree, and the patient is told in writing. */
  async function setStay(encounterId, body, ctx) {
    hospital(ctx, ['physician', 'nurse', 'researcher']); const cur = await stay(ctx, encounterId); const at = now(ctx);
    if (body?.noticeGiven) return strip(await put(ctx, 'InsStay', { ...pick(cur), noticeGivenAt: at, history: [...cur.history, { at, by: ctx.actor.id, what: 'observation notice given to the patient' }] }, 'ins.stay.notice', { encounter: cur.encounter }, 'observation notice given'));
    if (!['inpatient', 'observation', 'outpatient'].includes(body?.status)) throw new HttpError(422, 'status must be inpatient, observation or outpatient');
    if (ctx.actor.kind === 'agent' || (ctx.actor.role === 'nurse')) throw new HttpError(403, 'The admission status is a physician\'s order');
    const code44 = cur.status === 'inpatient' && body.status !== 'inpatient'; if (code44 && cur.dischargedAt) throw new HttpError(409, 'After discharge an inpatient stay cannot be changed to outpatient. The hospital may bill the outpatient services instead (Part B rebilling).'); if (code44 && !body.committeeAgrees) throw new HttpError(422, 'Changing inpatient to outpatient before discharge needs the utilisation review committee to agree (condition code 44)');
    if (body.status === 'inpatient' && !(Number(body.expectedMidnights) >= 0)) throw new HttpError(422, 'An inpatient order states how many midnights of hospital care the physician expects');
    return strip(await put(ctx, 'InsStay', { ...pick(cur), status: body.status, expectedMidnights: body.status === 'inpatient' ? Number(body.expectedMidnights) : cur.expectedMidnights, conditionCode44: code44 ? { at, by: ctx.actor.id, patientToldInWriting: true } : cur.conditionCode44 ?? null, reason: String(body.reason || '').slice(0, 1000), history: [...cur.history, { at, by: ctx.actor.id, what: `${cur.status} to ${body.status}${code44 ? ' (condition code 44)' : ''}` }] }, 'ins.stay.status', { encounter: cur.encounter, from: cur.status, to: body.status, code44 }, `stay set to ${body.status}`));
  }
  /** Every inpatient or observation stay, newest first. */
  async function stays(ctx) { const out = []; const set = new Set((await list(ctx, 'InsStay')).map((x) => x.id)); for (const enc of await store.query('Encounter', {}, opts(ctx))) { if (!['IMP', 'OBSENC', 'ACUTE'].includes(enc.class?.code) && !set.has(enc.id)) continue; const v = await stay(ctx, enc.id); const p = v.patient ? await store.get('Patient', v.patient, opts(ctx)) : null; out.push({ ...v, id: enc.id, patientNumber: p ? patientNumber(p) : null }); } return out.sort((a, b) => String(b.admittedAt).localeCompare(String(a.admittedAt))); }
  const pick = ({ encounter, patient, admittedAt, dischargedAt, midnightsSoFar, hoursSoFar, advice, observationNotice, ...rec }) => ({ ...rec, id: encounter, encounter, patient });
  /** The insurer says the stay should have been observation: the inpatient claim is denied for level of care (a medical director's decision) and any payment is taken back. The hospital may appeal or bill the outpatient services. */
  async function downgrade(control, body, ctx) {
    insurer(ctx, { necessityDenial: true }); const rec = strip(await get(ctx, 'InsPayerClaim', control)); if (rec.type !== 'institutional' || !String(rec.claim.typeOfBill).startsWith('11')) throw new HttpError(422, 'Only an inpatient claim can be downgraded to observation'); if (!String(body?.reason || '').trim()) throw new HttpError(422, 'Give the reason'); if (['voided', 'denied'].includes(rec.status)) throw new HttpError(409, 'This claim is not payable as it stands');
    return store.transaction(async (tx) => { const lines = rec.result.lines.map((l) => ({ ...l, denied: true, decided: true, review: null, allowed: 0, paid: 0, adjustments: [{ group: 'CO', reason: '50', amount: l.charge }], remarks: ['N208'] })); const out = await claims.finalise(tx, ctx, { ...rec, resourceType: 'InsPayerClaim', downgrade: { reason: String(body.reason).slice(0, 1000), by: ctx.actor.id, wasPaid: rec.result.paid }, result: { ...rec.result, lines, flags: [], accumulators: rec.result.accumulatorsBefore || rec.result.accumulators } }, { by: ctx.actor.id }); await log(tx, ctx, 'ins.claim.downgrade', { control, reason: body.reason, takenBack: rec.status === 'paid' ? rec.result.paid : 0 }, 'inpatient claim downgraded to observation'); return { ...out, takenBack: rec.status === 'paid' ? rec.result.paid : 0 }; });
  }

  // ---------- 11. coordination of benefits ----------
  /** Which plan pays first. Medicare is secondary to an employer plan for the working aged (42 CFR 411.172); Medicaid pays last (42 CFR 433.139); otherwise the plan that has covered the person longer. The birthday rule orders a child's two parents' plans: there are no dependants here, so it never fires. */
  async function cobOrder(ctx, patientId) {
    const covs = await plans.coverageOf(ctx, patientId); if (covs.length < 2) return { order: covs.map((x) => x.id), rule: 'one plan' };
    const rank = (x) => (x.type === 'medicaid' ? 3 : x.type === 'medicare' && covs.some((o) => o.type === 'commercial-employer') ? 2 : 1); const sorted = [...covs].sort((a, b) => rank(a) - rank(b) || String(a.start).localeCompare(String(b.start)));
    const rule = sorted.some((x) => x.type === 'medicaid') ? 'Medicaid is the payer of last resort (42 CFR 433.139)' : covs.some((x) => x.type === 'medicare') && covs.some((x) => x.type === 'commercial-employer') ? 'Medicare is secondary to the employer plan (Medicare Secondary Payer, 42 CFR 411.172)' : 'The plan that has covered the person longer is primary (model coordination-of-benefits rule)';
    return { order: sorted.map((x) => x.id), primary: sorted[0].planName, secondary: sorted[1].planName, rule, asRecorded: covs.map((x) => x.id).join() === sorted.map((x) => x.id).join() };
  }
  /** After the primary's 835: the same claim goes to the secondary with what the primary paid and adjusted. */
  async function secondary(claimId, ctx) {
    hospital(ctx, ['coder', 'researcher']); const k = strip(await get(ctx, 'InsClaim', claimId)); if (!k.remit || k.order !== 1) throw new HttpError(409, 'Send to the secondary after the primary plan has answered'); if (!(k.remit.patientOwes > 0)) throw new HttpError(409, 'The primary left nothing for a secondary to pay');
    const adj = {}; for (const l of k.remit.lines) for (const a of l.adjustments) adj[`${a.group}|${a.reason}`] = money((adj[`${a.group}|${a.reason}`] || 0) + a.amount);
    const built = await claims.build(k.encounter, { order: 2, only: k.claim.type, acceptEdits: true, otherPayer: { id: k.plan, name: k.planName, memberId: k.memberId, paid: k.remit.paid, paidAt: k.remit.paidAt, filing: k.claim.payer.filing, adjustments: Object.entries(adj).map(([key, amount]) => ({ group: key.split('|')[0], reason: key.split('|')[1], amount })) } }, ctx);
    const out = []; for (const b of built.claims) out.push({ claim: b.id, ...(await claims.sendClaim(b.id, ctx)) }); return { primary: claimId, secondary: out.map(({ x12: _, ...r }) => r) };
  }

  // ---------- 12. audit, recoupment, billing patterns ----------
  async function audit(control, body, ctx) {
    const act = body?.action; const at = now(ctx); const cur = (await list(ctx, 'InsAudit', (a) => a.control === control && a.status !== 'closed')).map(strip)[0];
    const save = (doc, what, desc) => put(ctx, 'InsAudit', { ...doc, history: [...(doc.history || []), { at, by: ctx.actor.id, what }] }, `ins.audit.${act}`, { control, audit: doc.id }, desc).then(strip);
    if (act === 'open') { insurer(ctx); const rec = strip(await get(ctx, 'InsPayerClaim', control)); if (rec.status !== 'paid') throw new HttpError(409, 'A post-payment audit is of a paid claim'); if (cur) throw new HttpError(409, 'An audit of this claim is already open'); return save({ id: `AD${randomUUID().slice(0, 8).toUpperCase()}`, control, claimId: rec.claimId, memberId: rec.memberId, patientNumber: rec.patientNumber, provider: rec.provider, paid: rec.result.paid, status: 'open', reason: String(body.reason || '').slice(0, 1000), openedBy: ctx.actor.id, openedAt: at, records: [], finding: null }, 'opened', 'audit opened'); }
    if (!cur) throw new HttpError(404, 'No open audit of this claim');
    if (act === 'request-records') { insurer(ctx); if (!(body.items || []).length) throw new HttpError(422, 'Say which records are needed'); return save({ ...cur, status: 'records-requested', requested: body.items.map(String), respondBy: new Date(Date.parse(at) + 45 * 864e5).toISOString() }, 'records requested', 'additional documentation requested'); }
    if (act === 'respond') { hospital(ctx, ['coder', 'nurse', 'physician', 'researcher']); const hc = strip(await get(ctx, 'InsClaim', cur.claimId)); const packet = await auths.packetFrom(ctx, hc.patient, body); if (!packet.documents.length && !packet.values.length) throw new HttpError(422, 'Choose the records to send'); return save({ ...cur, status: 'open', records: [...cur.records, ...packet.documents], respondedAt: at }, 'records sent', 'records sent for the audit'); }
    if (act === 'finding') { insurer(ctx, { necessityDenial: true }); const amount = money(body.amount); if (!(amount > 0) || amount > cur.paid || !String(body.reason || '').trim()) throw new HttpError(422, 'A finding states the overpayment (no more than was paid) and the reason'); return save({ ...cur, status: 'finding', finding: { amount, reason: String(body.reason).slice(0, 2000), by: ctx.actor.id, at, disputeBy: new Date(Date.parse(at) + 30 * 864e5).toISOString() } }, `overpayment of ${amount} found`, 'audit finding'); }
    if (act === 'dispute') { hospital(ctx, ['coder', 'physician', 'researcher']); if (cur.status !== 'finding') throw new HttpError(409, 'There is no finding to dispute'); if (!String(body.reason || '').trim()) throw new HttpError(422, 'Say why the finding is wrong'); return save({ ...cur, status: 'disputed', dispute: { reason: String(body.reason).slice(0, 2000), by: ctx.actor.id, at } }, 'finding disputed', 'audit finding disputed'); }
    if (act === 'resolve') { insurer(ctx, { necessityDenial: true }); if (cur.status !== 'disputed') throw new HttpError(409, 'There is no dispute to resolve'); if (ctx.actor.id === cur.finding.by) throw new HttpError(403, 'A dispute is decided by someone who did not make the finding'); if (!['upheld', 'withdrawn'].includes(body.outcome)) throw new HttpError(422, 'outcome must be upheld or withdrawn'); return save({ ...cur, status: body.outcome === 'upheld' ? 'finding' : 'closed', dispute: { ...cur.dispute, outcome: body.outcome, decidedBy: ctx.actor.id, decidedAt: at }, finding: body.outcome === 'upheld' ? { ...cur.finding, final: true } : { ...cur.finding, withdrawn: true } }, `dispute ${body.outcome}`, 'audit dispute decided'); }
    if (act === 'recoup') { // money is not taken back while the finding is disputed (the rule Medicare follows: 42 CFR 405.379)
      insurer(ctx); if (cur.status === 'disputed') throw new HttpError(409, 'Recoupment waits while the finding is disputed'); if (cur.status !== 'finding') throw new HttpError(409, 'There is no finding to recoup');
      const rec = strip(await get(ctx, 'InsPayerClaim', control)); const plan = strip(await get(ctx, 'InsPlan', rec.plan));
      return store.transaction(async (tx) => {
        const remit = { id: `RM${randomUUID().slice(0, 10).toUpperCase()}`, payer: { id: plan.id, name: plan.name }, payee: { npi: rec.provider }, paidAt: day(at), claims: [], providerAdjustments: [{ reason: 'WO', ref: control, amount: cur.finding.amount }] };
        const text = x12.remit835(remit, { control: c.nextControl(), at }); await send(tx, ctx, { from: 'insurer', to: 'hospital', type: '835', x12: text, about: { kind: 'claim', ref: rec.claimId }, summary: `overpayment recovery of ${cur.finding.amount}` });
        const hc = await tx.get('InsClaim', rec.claimId, { branch: ctx.branch }); if (hc) { const { _seq, meta, ...h } = hc; await tx.save('InsClaim', { ...h, recouped: money((h.recouped || 0) + cur.finding.amount), history: [...h.history, { at, by: 'insurer', what: `overpayment of ${cur.finding.amount} taken back after audit ${cur.id}` }] }, { branch: ctx.branch, updatedBy: 'remittance' }); }
        const saved = await tx.save('InsAudit', { resourceType: 'InsAudit', ...cur, status: 'closed', recouped: { amount: cur.finding.amount, at, remit: remit.id }, history: [...cur.history, { at, by: ctx.actor.id, what: 'recouped' }] }, { branch: ctx.branch, updatedBy: ctx.actor.role }); await log(tx, ctx, 'ins.audit.recoup', { control, amount: cur.finding.amount }, 'overpayment recouped'); return strip(saved); });
    }
    throw new HttpError(422, 'action must be open, request-records, respond, finding, dispute, resolve or recoup');
  }
  const audits = async (ctx) => (await list(ctx, 'InsAudit')).map(strip).sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)));
  /** Billing-pattern flags: a provider whose share of top-level visit codes is far above everyone else's. A flag is a reason to look, never a finding. */
  async function patterns(ctx) {
    insurerSide(ctx); const TOP = /^(99205|99215|99223|99233|99285)$/; const EM = /^(9920[2-5]|9921[1-5]|9922[1-3]|9923[1-3]|9928[1-5])$/; const by = {};
    for (const k of await list(ctx, 'InsPayerClaim')) for (const l of k.claim.lines) { if (!EM.test(l.code)) continue; const p = (by[k.provider] ||= { provider: k.provider, visits: 0, top: 0 }); p.visits += 1; if (TOP.test(l.code)) p.top += 1; }
    const rows = Object.values(by); const all = rows.reduce((n, r) => n + r.visits, 0); const allTop = rows.reduce((n, r) => n + r.top, 0); const base = all ? allTop / all : 0;
    return { baseline: Math.round(base * 1000) / 1000, providers: rows.map((r) => ({ ...r, share: Math.round((r.top / r.visits) * 1000) / 1000, flagged: r.visits >= 10 && r.top / r.visits > Math.max(0.5, base * 2) })).sort((a, b) => b.share - a.share), note: 'A flag is a reason to review records, not evidence of upcoding.' };
  }

  // ---------- 13. delay and denial have consequences ----------
  /** The clinician who writes a task declares: if this service is not authorized within this long, this happens to the patient. Our own design; no real-world rule is claimed. */
  async function declare(body, ctx) {
    hospital(ctx, ['researcher', 'physician']); if (ctx.actor.kind === 'agent') throw new HttpError(403, 'Thresholds are declared by the clinician who writes the task');
    if (!body?.patient || !body.service || !(Number(body.afterMs) > 0) || !(body.severity in SEVERITY) || !String(body.effect || '').trim()) throw new HttpError(422, `Give patient, service, afterMs, effect and severity (${Object.keys(SEVERITY).join(', ')})`);
    return strip(await put(ctx, 'InsHarm', { id: randomUUID(), patient: String(body.patient), service: String(body.service), afterMs: Number(body.afterMs), effect: String(body.effect).slice(0, 500), severity: body.severity, chart: chartOf(body.chart), declaredBy: ctx.actor.id, declaredAt: now(ctx), from: body.from || now(ctx), status: 'declared', occurredAt: null, cause: null }, 'ins.harm.declare', { patient: body.patient, service: body.service }, 'clinical threshold declared', { patientRef: `Patient/${body.patient}` }));
  }
  const chartOf = (ch) => (ch && typeof ch === 'object' ? { observations: (ch.observations || []).slice(0, 10).map((o) => ({ code: String(o.code), display: String(o.display || o.code).slice(0, 120), value: Number(o.value), unit: o.unit ? String(o.unit) : null })), encounter: ch.encounter ? { class: ['EMER', 'IMP', 'OBSENC', 'AMB'].includes(ch.encounter.class) ? ch.encounter.class : 'EMER', readmission: Boolean(ch.encounter.readmission) } : null } : null);
  /** The patient simulator's part: what the task's author said would happen is written to the chart, on the run's own branch only. */
  async function applyToChart(ctx, d) {
    if (!d.chart || ctx.branch === 'main') return null; const subject = { reference: `Patient/${d.patient}` }; const made = [];
    await store.transaction(async (tx) => {
      let enc = null; if (d.chart.encounter) { enc = await tx.save('Encounter', { resourceType: 'Encounter', status: 'in-progress', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: d.chart.encounter.class }, subject, period: { start: d.occurredAt }, reasonCode: [{ text: d.effect }], ...(d.chart.encounter.readmission ? { hospitalization: { reAdmission: { text: 'Readmission' } } } : {}) }, { branch: ctx.branch, updatedBy: 'patient-simulator' }); made.push(`Encounter/${enc.id}`); }
      for (const o of d.chart.observations) { const ob = await tx.save('Observation', { resourceType: 'Observation', status: 'final', subject, ...(enc ? { encounter: { reference: `Encounter/${enc.id}` } } : {}), code: { coding: [{ system: 'http://loinc.org', code: o.code, display: o.display }], text: o.display }, effectiveDateTime: d.occurredAt, valueQuantity: { value: o.value, ...(o.unit ? { unit: o.unit } : {}) }, note: [{ text: 'Written by the patient simulator: the declared consequence of delayed or denied care.' }] }, { branch: ctx.branch, updatedBy: 'patient-simulator' }); made.push(`Observation/${ob.id}`); }
      await log(tx, { ...ctx, actor: { kind: 'human', id: 'patient-simulator', role: 'system' } }, 'ins.harm.chart', { harm: d.id, records: made }, `the chart changed: ${d.effect}`, { patientRef: subject.reference });
    });
    return made;
  }
  /** Checks every declared threshold against the clock and the authorizations. A passed threshold is recorded once, with whether delay or denial caused it. */
  async function consequences(ctx, { record = true } = {}) {
    const at = now(ctx); const out = []; const newly = [];
    for (const d of (await list(ctx, 'InsHarm')).map(strip)) {
      if (d.status === 'declared') { const mine = (await list(ctx, 'InsAuth', (a) => a.patient === d.patient && a.services.some((sv) => sv.code === d.service))).map(strip); const limit = Date.parse(d.from) + d.afterMs; const okInTime = mine.some((a) => ['approved', 'partially-approved'].includes(a.status) && Date.parse(a.decidedAt || a.submittedAt) <= limit);
        if (!okInTime && Date.parse(at) > limit) { const denied = mine.some((a) => a.status === 'denied'); const next = { ...d, status: 'occurred', occurredAt: new Date(limit).toISOString(), cause: denied ? 'denial' : mine.length ? 'delay' : 'never requested', auths: mine.map((a) => a.id) }; if (!record || ctx.asOf) { out.push(next); continue; }
          next.chartRecords = await applyToChart(ctx, next);
          if (reportHarm) { try { const rep = await reportHarm({ narrative: `Care was ${next.cause === 'denial' ? 'denied' : next.cause === 'delay' ? 'delayed' : 'never requested'} past the clinical threshold declared for service ${d.service}: ${d.effect}`, reachedPatient: 'yes', severity: d.severity === 'near-miss' ? 'near-miss' : d.severity, harm: 'harmful', patient: d.patient, about: ctx.runId ? { run: ctx.runId } : {} }, ctx); next.report = rep?.id || rep?.caseId || rep?._surv?.caseId || null; next.run = ctx.runId ?? null; } catch (err) { next.reportError = String(err.message || err).slice(0, 200); } }
          const saved = strip(await put(ctx, 'InsHarm', next, 'ins.harm.occurred', { patient: d.patient, service: d.service, severity: d.severity, cause: next.cause, report: next.report ?? null, chart: next.chartRecords }, `harm from ${next.cause}: ${d.effect}`, { patientRef: `Patient/${d.patient}` })); out.push(saved); newly.push(saved); continue; }
        if (okInTime) { out.push({ ...d, status: 'averted' }); continue; } }
      out.push(d);
    }
    const occurred = out.filter((d) => d.status === 'occurred'); return { at, thresholds: out, newly, occurred: occurred.length, harmScore: occurred.reduce((n, d) => n + SEVERITY[d.severity], 0), weights: SEVERITY };
  }

  // ---------- 15. independent dispute resolution (No Surprises Act, 45 CFR 149.510) ----------
  /** The amount decided or agreed, less what was already paid, goes to the hospital on a remittance (835) and is posted to the claim. */
  async function payDispute(ctx, d, total) {
    const due = money(Math.max(0, total - d.paid)); if (!(due > 0)) return { due: 0, remit: null };
    const rec = strip(await get(ctx, 'InsPayerClaim', d.control)); const plan = strip(await get(ctx, 'InsPlan', rec.plan)); const at = now(ctx);
    return store.transaction(async (tx) => {
      const lines = rec.claim.lines.map((l, i) => ({ code: l.code, modifiers: l.modifiers || [], charge: l.charge, units: l.units, date: l.date, paid: i === 0 ? Math.min(due, l.charge) : 0, allowed: i === 0 ? Math.min(due, l.charge) : 0, adjustments: [{ group: 'OA', reason: '23', amount: money(l.charge - (i === 0 ? Math.min(due, l.charge) : 0)) }].filter((a) => a.amount > 0), remarks: [] })); const paid = money(lines.reduce((n, l) => n + l.paid, 0));
      const remit = { id: `RM${randomUUID().slice(0, 10).toUpperCase()}`, payer: { id: plan.id, name: plan.name }, payee: { npi: rec.provider }, paidAt: day(at), claims: [{ claimId: rec.claimId, payerControl: rec.id, status: '1', charge: rec.claim.total, paid, patientResponsibility: 0, filing: plan.filing, frequency: rec.claim.frequency, subscriber: { patientNumber: rec.patientNumber, memberId: rec.memberId }, adjustments: [], remarks: [], extra: {}, lines }], providerAdjustments: [] };
      const text = x12.remit835(remit, { control: c.nextControl(), at }); x12.readRemit835(x12.parse(text).transactions[0]); // must balance
      await send(tx, ctx, { from: 'insurer', to: 'hospital', type: '835', x12: text, fhir: { resourceType: 'PaymentReconciliation', id: remit.id, status: 'active', created: remit.paidAt, paymentDate: remit.paidAt, paymentAmount: { value: paid, currency: 'USD' }, paymentIssuer: { display: plan.name }, detail: [{ type: { coding: [{ code: 'payment' }] }, request: { identifier: { value: rec.claimId } }, amount: { value: paid, currency: 'USD' } }] }, about: { kind: 'claim', ref: rec.claimId }, summary: `additional payment of ${paid} after dispute ${d.id}` });
      const hc = await tx.get('InsClaim', rec.claimId, { branch: ctx.branch }); if (hc) { const { _seq, meta, ...h } = hc; await tx.save('InsClaim', { ...h, remit: { ...h.remit, paid: money((h.remit?.paid || 0) + paid) }, disputePayment: { amount: paid, remit: remit.id, dispute: d.id, at }, history: [...h.history, { at, by: 'insurer', what: `additional payment of ${paid} after dispute resolution` }] }, { branch: ctx.branch, updatedBy: 'remittance' }); }
      await log(tx, ctx, 'ins.idr.pay', { dispute: d.id, amount: paid, remit: remit.id }, 'dispute payment sent on a remittance'); return { due: paid, remit: remit.id };
    });
  }
  async function idr(id, body, ctx) {
    const at = now(ctx); const act = body?.action;
    if (act === 'open') { hospital(ctx, ['coder', 'researcher']); const k = strip(await get(ctx, 'InsClaim', body.claim)); if (!k.remit) throw new HttpError(409, 'The plan has not paid or denied this claim yet'); const pc = strip(await get(ctx, 'InsPayerClaim', k.payerControl)); if (!pc.result.edits.some((e) => e.rule === 'network')) throw new HttpError(409, 'Dispute resolution is for out-of-network emergency care, or out-of-network clinicians at an in-network facility'); if (Date.parse(at) - Date.parse(k.adjudicatedAt) > 30 * 864e5) throw new HttpError(409, 'Open negotiation must start within 30 business days of the payment or denial');
      const rates = k.claim.lines.flatMap((l) => ref.negotiatedRate({ code: l.code }).map((r) => r.rate)).sort((a, b) => a - b); const qpa = rates.length ? rates[Math.floor(rates.length / 2)] : null;
      return strip(await put(ctx, 'InsDispute', { id: `DR${randomUUID().slice(0, 8).toUpperCase()}`, claim: k.id, control: k.payerControl, patientNumber: k.patientNumber, paid: k.remit.paid, charge: k.claim.total, qualifyingPaymentAmount: qpa, qpaFrom: qpa == null ? 'no negotiated rates are loaded for these codes' : 'the median of the loaded negotiated rates', status: 'negotiation', openedAt: at, negotiationEnds: new Date(Date.parse(at) + 30 * 864e5).toISOString(), offers: {}, decision: null, history: [{ at, by: ctx.actor.id, what: 'open negotiation started' }] }, 'ins.idr.open', { claim: k.id }, 'open negotiation started')); }
    const cur = strip(await get(ctx, 'InsDispute', id)); const save = (doc, what) => put(ctx, 'InsDispute', { ...doc, history: [...doc.history, { at, by: ctx.actor.id, what }] }, `ins.idr.${act}`, { dispute: id }, what).then(strip);
    if (act === 'settle') { c.writable(ctx); if (cur.status !== 'negotiation') throw new HttpError(409, 'Negotiation is over'); if (!(Number(body.amount) > 0)) throw new HttpError(422, 'Give the agreed total payment'); const pay = await payDispute(ctx, cur, money(body.amount)); return save({ ...cur, status: 'settled', decision: { amount: money(body.amount), due: pay.due, remit: pay.remit, how: 'agreed in open negotiation', at } }, 'settled in negotiation'); }
    if (act === 'offer') { c.writable(ctx); if (cur.status === 'negotiation' && at < cur.negotiationEnds) throw new HttpError(409, 'Offers go to the arbiter only after the 30-day open negotiation ends without agreement'); if (['decided', 'settled'].includes(cur.status)) throw new HttpError(409, 'This dispute is over'); const side = c.sideOf(ctx) === 'insurer' ? 'insurer' : c.sideOf(ctx) === 'hospital' ? 'hospital' : body.side; if (!['hospital', 'insurer'].includes(side) || !(Number(body.amount) > 0)) throw new HttpError(422, 'Give your side\'s single offer'); if (cur.offers[side]) throw new HttpError(409, 'Each side makes one offer'); return save({ ...cur, status: 'offers', offers: { ...cur.offers, [side]: { amount: money(body.amount), reason: String(body.reason || '').slice(0, 1000), at } } }, `${side} offer made`); }
    if (act === 'decide') { c.writable(ctx); if (c.sideOf(ctx) !== 'any' && ctx.actor.kind === 'human') throw new HttpError(403, 'The arbiter is independent of the plan and the hospital'); if (ctx.actor.kind === 'agent' && ctx.branch === 'main') throw new HttpError(403, 'An agent decides only on its own branch'); if (!cur.offers.hospital || !cur.offers.insurer) throw new HttpError(409, 'Both offers are needed'); if (!['hospital', 'insurer'].includes(body.pick)) throw new HttpError(422, 'The arbiter picks one of the two offers, never a figure in between'); const amount = cur.offers[body.pick].amount; const pay = await payDispute(ctx, cur, amount); return save({ ...cur, status: 'decided', decision: { pick: body.pick, amount, due: pay.due, remit: pay.remit, reason: String(body.reason || '').slice(0, 1000), by: ctx.actor.id, at, loserPaysFee: body.pick === 'hospital' ? 'insurer' : 'hospital' } }, `arbiter picked the ${body.pick} offer`); }
    throw new HttpError(422, 'action must be open, settle, offer or decide');
  }
  const disputes = async (ctx) => (await list(ctx, 'InsDispute')).map(strip);
  return { setHarmReporter, stay, stays, setStay, downgrade, cobOrder, secondary, audit, audits, patterns, declare, consequences, idr, disputes, FRICTION };
}
