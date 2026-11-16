// Surveillance and Reporting: the API. /agent-ops/surveillance/** for staff and verifier agents, and the same
// handler under /api/surveillance/** for the hospital apps and the Patient Portal.
import { randomUUID } from 'node:crypto';
import { toIcsr } from '../../standards/server/e2b.mjs';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';
import { createReports, HARMS, SEVERITIES, REACHED, STATUSES, CAUSALITY, DIMS, SUBGROUP_DIMS, PATIENT_CHOICES, PATIENT_EFFECTS, DUE_DAYS } from './reports.mjs';
import { createRules, RULES } from './rules.mjs';
import { createAnalysis } from './analysis.mjs';
import { similarity, embedText } from './stats.mjs';
import { runStudy, studyCsv, normalizeConfig } from './simulator.mjs';

export function createSurveillance({ store, agents }) {
  const reports = createReports({ store, agents }); const rules = createRules({ store, reports }); const analysis = createAnalysis({ store, agents, reports, rules });
  const staff = (ctx) => reports.reviewer(ctx);
  const q = (url) => Object.fromEntries([...url.searchParams].filter(([, v]) => v !== ''));
  const filterOf = (params) => Object.fromEntries(DIMS.filter((d) => params[d] != null).map((d) => [d, params[d]]));
  const mayRead = (doc, ctx) => { if (ctx.actor.kind === 'agent') return reports.isReporter(doc, ctx); if (ctx.actor.role !== 'patient') return true; return doc._surv.source.kind === 'human' && doc._surv.source.role === 'patient' && doc._surv.source.by === ctx.actor.id; };

  /** Possible duplicates of a report: very alike, about the same run or the same patient and agent close in time. A person confirms each merge. */
  async function duplicates(doc) {
    const mine = { ...reports.features(doc), e: embedText(doc._surv.narrative) }; const c = doc._surv.context;
    return (await reports.all()).filter((d) => d.id !== doc.id && d._surv.status !== 'duplicate').map((d) => { const o = d._surv.context; const sameRun = Boolean(c.run && o.run === c.run); const near = Boolean(c.patient && o.patient === c.patient && o.agent === c.agent && Math.abs(Date.parse(d._surv.filedAt) - Date.parse(doc._surv.filedAt)) < 7 * 86400000); const sim = similarity(mine, { ...reports.features(d), e: embedText(d._surv.narrative) });
      return { id: d.id, caseId: d._surv.caseId, source: d._surv.source.kind, filedAt: d._surv.filedAt, score: sim.score, why: [sameRun ? 'about the same run' : null, near ? 'same patient and agent within 7 days' : null, ...sim.reasons].filter(Boolean), likely: sameRun || (near && sim.score >= 0.5) }; }).filter((x) => x.likely).sort((a, b) => b.score - a.score).slice(0, 10);
  }
  async function setVerifier(agentId, body, ctx) {
    staff(ctx);
    return store.transaction(async (tx) => {
      const agent = await tx.get('Agent', agentId); if (!agent) throw new HttpError(404, `Agent "${agentId}" is not registered`); const { _seq, ...rest } = agent;
      const enabled = Boolean(body?.enabled); const scope = ['all', 'sample', 'high-risk'].includes(body?.scope) ? body.scope : rest.verifier?.scope || 'all';
      // A verifier reads and reports. It is given read only on every system, so it cannot change the chart.
      const readOnly = { systems: Object.fromEntries(['ehr', 'pacs', 'lab', 'pharmacy', 'payer', 'business-office', 'scheduling'].map((sys) => [sys, 'read-only'])), recordTypes: null, patients: 'all', rateLimit: rest.granted?.rateLimit ?? 600, mustCite: Boolean(rest.granted?.mustCite) };
      const saved = await tx.save('Agent', { ...rest, verifier: { enabled, scope, sampleRate: Math.min(1, Math.max(0.01, Number(body?.sampleRate) || rest.verifier?.sampleRate || 0.2)), since: enabled ? tx.now() : rest.verifier?.since ?? null, by: ctx.actor.id }, ...(enabled ? { grantedBeforeVerifier: rest.grantedBeforeVerifier ?? rest.granted ?? null, granted: readOnly, scopes: [] , scopesBeforeVerifier: rest.scopesBeforeVerifier ?? rest.scopes ?? [] } : rest.verifier?.enabled ? { granted: rest.grantedBeforeVerifier ?? null, scopes: rest.scopesBeforeVerifier ?? rest.scopes ?? [] } : {}) }, { updatedBy: ctx.actor.role });
      await recordAction(tx, { runId: LIVE_RUN_ID, actor: ctx.actor, kind: 'update', action: 'surveillance.verifier.set', args: { agent: agentId, enabled, scope }, entityRef: `Agent/${agentId}`, versionId: saved.meta.versionId, description: `${agentId} ${enabled ? 'given' : 'no longer has'} the Verifier role` });
      return { agent: saved.id, verifier: saved.verifier };
    });
  }
  async function saveStudy(body, ctx) {
    staff(ctx); const seed = Number.isInteger(Number(body?.seed)) ? Number(body.seed) : 1; const out = runStudy(body?.config || {}, seed);
    const doc = { resourceType: 'SurvStudy', id: randomUUID(), title: String(body?.title || 'Surveillance study').slice(0, 160), createdAt: store.now(), createdBy: ctx.actor.id, seed, config: out.config, planted: out.planted, results: out.results, note: 'A simulation with a known truth. No report in this study is about a real or stored patient.' };
    await store.transaction(async (tx) => { await tx.save('SurvStudy', doc, { updatedBy: ctx.actor.role }); await recordAction(tx, { runId: LIVE_RUN_ID, actor: ctx.actor, kind: 'create', action: 'surveillance.study.run', args: { study: doc.id, seed, seeds: out.config.seeds, signal: out.config.signal.kind }, entityRef: `SurvStudy/${doc.id}`, description: 'surveillance study run', audit: false }); });
    return doc;
  }

  async function handle(req, url, body, ctx, partsIn) {
    const parts = partsIn || url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
    if (parts[0] !== 'surveillance') return null;
    const [, section, id, op] = parts; const m = req.method; const params = q(url); const ok = (b, status = 200) => ({ status, body: b });
    if (section === 'meta' && m === 'GET') return ok({ harms: HARMS, severities: SEVERITIES, reached: REACHED, statuses: STATUSES, causality: CAUSALITY, dims: DIMS, subgroupDims: SUBGROUP_DIMS, dueDays: DUE_DAYS, patientChoices: PATIENT_CHOICES, patientEffects: PATIENT_EFFECTS, rules: RULES.map(({ id: rid, version, label, about }) => ({ id: rid, version, label, about })), methods: analysis.METHOD_LABEL });
    if (section === 'reports') {
      if (m === 'POST' && !id) { const doc = await reports.file(body || {}, ctx); const raised = await analysis.updateSignals(doc._surv.context.agent, doc._surv.harm || 'other').catch(() => []); return ok({ ...reports.present(doc, { forPatient: ctx.actor.role === 'patient' }), signalsRaised: raised.map((s) => ({ id: s.id, method: s.method })) }, 201); }
      if (m === 'GET' && !id) {
        let docs = await reports.all();
        if (ctx.actor.kind === 'agent' || ctx.actor.role === 'patient' || params.mine === 'true') docs = docs.filter((d) => reports.isReporter(d, ctx) && (ctx.actor.role !== 'patient' || !params.patient || d._surv.context.patient === `Patient/${params.patient}`));
        docs = docs.filter((d) => (!params.status || d._surv.status === params.status) && (!params.source || d._surv.source.kind === params.source) && (!params.agent || d._surv.context.agent === params.agent) && (!params.harm || d._surv.harm === params.harm) && (!params.about || [d._surv.context.run, d._surv.context.proposal, d._surv.context.resource, d._surv.context.focusStep].includes(params.about)));
        const now = store.now();
        return ok({ reports: docs.sort((a, b) => String(a._surv.dueAt).localeCompare(String(b._surv.dueAt))).slice(0, 500).map((d) => ({ ...reports.present(d, { forPatient: ctx.actor.role === 'patient' }), overdue: !['confirmed-ai', 'not-ai', 'duplicate', 'closed'].includes(d._surv.status) && d._surv.dueAt < now })), counts: Object.fromEntries(Object.keys(STATUSES).map((st) => [st, docs.filter((d) => d._surv.status === st).length])) });
      }
      const doc = await reports.get(id); if (!mayRead(doc, ctx)) throw new HttpError(403, 'This report is not yours to see');
      if (m === 'GET' && !op) return ok(reports.present(doc, { forPatient: ctx.actor.role === 'patient' }));
      if (m === 'GET' && op === 'e2b') { staff(ctx); const sv = doc._surv; const p = sv.context.patient ? await store.get('Patient', String(sv.context.patient).replace(/^Patient\//, '')) : null; const xml = toIcsr({ caseId: sv.caseId, filedAt: sv.filedAt, occurredAt: sv.occurredAt, severity: sv.severity, harm: sv.harm, reachedPatient: sv.reachedPatient, narrative: url.searchParams.get('narrative') === 'false' ? '' : sv.narrative, reporterRole: sv.source.kind === 'human' ? sv.source.role : null, agent: sv.context.agent, version: sv.context.version, sex: p?.gender, ageYears: p?.birthDate ? (Date.parse(sv.occurredAt) - Date.parse(p.birthDate)) / (365.25 * 864e5) : null }); await store.transaction((tx) => recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'execute', action: 'surveillance.e2b', args: { case: sv.caseId }, entityRef: `AdverseEvent/${doc.id}`, description: `E2B(R3) export of ${sv.caseId}` })); return { status: 200, body: Buffer.from(xml), headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': `attachment; filename="${sv.caseId}-e2b.xml"` } }; }
      if (m === 'GET' && op === 'fhir') { staff(ctx); const { _surv, _seq, ...fhir } = doc; return ok(fhir); }
      if (m === 'GET' && op === 'history') { staff(ctx); return ok({ versions: (await store.history('AdverseEvent', doc.id)).map((v) => ({ version: Number(v.meta?.versionId), at: v.meta?.lastUpdated ?? v._recordedAt, status: v._surv?.status, followUps: v._surv?.followUps?.length ?? 0, by: v._updatedBy })) }); }
      if (m === 'GET' && op === 'context') return ok(await analysis.context(doc.id, ctx));
      if (m === 'GET' && op === 'duplicates') { staff(ctx); return ok({ suggestions: await duplicates(doc) }); }
      if (m === 'POST' && op === 'follow-up') return ok(reports.present(await reports.followUp(doc.id, body, ctx), { forPatient: ctx.actor.role === 'patient' }));
      if (m === 'POST' && op === 'triage') { const saved = await reports.triage(doc.id, body, ctx); await analysis.updateSignals(saved._surv.context.agent, saved._surv.harm || 'other').catch(() => []); return ok(reports.present(saved)); }
      if (m === 'POST' && op === 'reproduce') return ok(await analysis.reproduce(doc.id, body || {}, ctx));
      if (m === 'PUT' || m === 'DELETE') throw new HttpError(405, 'A report is never overwritten or deleted. Add a follow-up instead');
    }
    if (section === 'verifier' && id === 'queue' && m === 'GET') { if (ctx.actor.kind !== 'agent') throw new HttpError(403, 'The review queue is for verifier agents'); const v = ctx.agent ?? await store.get('Agent', ctx.actor.id); if (!v?.verifier?.enabled) throw new HttpError(403, 'This agent does not have the Verifier role'); return ok({ scope: v.verifier.scope, queue: await rules.verifierQueue(v) }); }
    if (section === 'verifier' && id === 'reviewed' && m === 'POST') { if (ctx.actor.kind !== 'agent') throw new HttpError(403, 'For verifier agents'); const v = ctx.agent ?? await store.get('Agent', ctx.actor.id); if (!v?.verifier?.enabled) throw new HttpError(403, 'This agent does not have the Verifier role'); const run = await store.get('Run', String(body?.run || '')); if (!run) throw new HttpError(404, 'No such run'); if (run.agentId === v.id) throw new HttpError(403, 'A verifier cannot review its own outputs'); await store.transaction((tx) => tx.save('SurvReview', { resourceType: 'SurvReview', id: randomUUID(), verifier: v.id, version: String(v.version), run: run.id, finding: 'no-problem', at: tx.now() }, { updatedBy: 'agent' })); return ok({ run: run.id, finding: 'no-problem' }, 201); }
    if (ctx.actor.kind === 'agent') throw new HttpError(403, 'Agents can file reports and read their own; nothing else here is open to them');
    // Which of a patient's records an agent wrote, or that came from an accepted AI proposal: the chart puts "Report a problem" on these.
    if (section === 'touched' && m === 'GET' && ctx.actor.role !== 'patient') {
      const ref = `Patient/${String(params.patient || '').split('/').pop()}`; const refs = new Set();
      for (const st of await store.query('TraceStep', { where: (x) => x.who?.kind === 'agent' && ['fhir.create', 'fhir.update', 'fhir.transition'].includes(x.did?.type) && x.did.args?.type && x.did.args?.id && x.did.args.type !== 'Provenance' })) { const d = await store.get(st.did.args.type, st.did.args.id, { branch: ctx.branch }); if (d && (d._patient === ref || d.subject?.reference === ref)) refs.add(`${st.did.args.type}/${st.did.args.id}`); }
      for (const tk of await store.query('Task', { where: (x) => x.for?.reference === ref && (x.input || []).some((i) => i.type?.text === 'proposal') }, { branch: ctx.branch })) { const result = (tk.output || []).find((o) => o.type?.text === 'result')?.valueString; if (result) refs.add(result); }
      return ok({ patient: ref, refs: [...refs] });
    }
    if (ctx.actor.role === 'patient') throw new HttpError(403, 'Not available');
    if (section === 'rates' && m === 'GET') return ok(await reports.rates(filterOf(params), { harm: params.harm || null, from: params.from || null, to: params.to || null }));
    if (section === 'aggregate' && m === 'GET') return ok(await analysis.aggregate({ by: params.by || 'agent', over: params.over || null, harm: params.harm || null, filter: filterOf(params) }));
    if (section === 'explorer' && m === 'GET') return ok(await analysis.explorer({ dimA: params.dimA, dimB: params.dimB || null, harm: params.harm || null, filter: filterOf(params) }));
    if (section === 'discover' && m === 'GET') return ok(await analysis.discover({ harm: params.harm || null, filter: filterOf(params) }));
    if (section === 'discover' && m === 'POST') { staff(ctx); return ok({ raised: await analysis.discoverJob() }); }
    if (section === 'clusters' && m === 'GET') return ok({ clusters: await analysis.clusters({ filter: filterOf(params) }) });
    if (section === 'statistics' && m === 'GET') { if (!params.agent || !HARMS[params.harm]) throw new HttpError(422, 'Name an agent and a harm category'); return ok(await analysis.statistics(params.agent, params.harm, { version: params.version || null })); }
    if (section === 'signals' && m === 'GET') return ok({ signals: await analysis.signals() });
    if (section === 'signals' && id && op === 'review' && m === 'POST') return ok(await analysis.reviewSignal(id, body, ctx));
    if (section === 'watchlist' && m === 'GET') return ok({ watchlist: await analysis.watchlist() });
    if (section === 'watchlist' && m === 'POST') return ok(await analysis.watch(body, ctx), 201);
    if (section === 'rules' && m === 'GET' && !id) return ok({ rules: await rules.ruleCounts(), settings: await rules.settings(), reported: (await reports.rates({})).human, detected: (await reports.rates({})).automatic, underReporting: (await reports.rates({})).underReporting });
    if (section === 'rules' && id === 'settings' && m === 'PUT') { staff(ctx); return ok(await rules.saveSettings(body, ctx)); }
    if (section === 'rules' && id === 'sweep' && m === 'POST') { staff(ctx); const opened = await rules.sweep(); for (const o of opened) { const d = await reports.get(o.id); await analysis.updateSignals(d._surv.context.agent, d._surv.harm || 'other').catch(() => []); } return ok({ opened }); }
    if (section === 'drift' && m === 'GET') { if (!params.agent) throw new HttpError(422, 'Name an agent'); return ok({ drift: await rules.drift(params.agent, params.version || null) }); }
    if (section === 'verifiers' && m === 'GET') return ok({ verifiers: await rules.verifierPrecision() });
    if (section === 'verifiers' && id && m === 'PUT') return ok(await setVerifier(id, body, ctx));
    if (section === 'actions' && m === 'POST') return ok(await analysis.act(body, ctx), 201);
    if (section === 'summary' && m === 'GET') {
      if (!params.agent) throw new HttpError(422, 'Name an agent'); const shareable = params.shareable !== 'false'; const out = await analysis.summary(params.agent, params.version || null, { shareable });
      await store.transaction((tx) => recordAction(tx, { runId: LIVE_RUN_ID, actor: ctx.actor, kind: 'read', action: 'surveillance.export', args: { agent: params.agent, version: params.version || null, shareable, format: params.format || 'json' }, entityRef: `Agent/${params.agent}`, description: 'surveillance summary exported' }));
      if (params.format === 'csv') { const lines = ['section,key,events,uses,per1000,low,high']; const row = (sec, k, r) => lines.push(r?.suppressed ? `${sec},${k},suppressed,,,,` : `${sec},${k},${r.events},${r.uses},${r.per1000 ?? ''},${r.low ?? ''},${r.high ?? ''}`); row('overall', 'combined', out.rates.combined); for (const [k, r] of Object.entries(out.rates.byHarm)) row('harm', k, r); for (const [k, r] of Object.entries(out.rates.bySeverity)) row('severity', k, r); for (const [dim, vals] of Object.entries(out.bySubgroup)) for (const [k, r] of Object.entries(vals)) row(dim, String(k).replace(/,/g, ' '), r); return { status: 200, raw: lines.join('\n'), headers: { 'Content-Type': 'text/csv; charset=utf-8' } }; }
      return ok(out);
    }
    if (section === 'studies') {
      if (m === 'POST' && !id) return ok(await saveStudy(body, ctx), 201);
      if (m === 'POST' && id === 'preview') { staff(ctx); return ok({ config: normalizeConfig(body?.config || {}) }); }
      if (m === 'GET' && !id) return ok({ studies: (await store.query('SurvStudy')).map(({ _seq, results, ...x }) => ({ ...x, methods: results.length })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) });
      const study = await store.get('SurvStudy', id); if (!study) throw new HttpError(404, 'No such study'); const { _seq, ...clean } = study;
      if (m === 'GET' && op === 'csv') return { status: 200, raw: studyCsv(clean), headers: { 'Content-Type': 'text/csv; charset=utf-8' } };
      if (m === 'GET') return ok(clean);
    }
    throw new HttpError(404, `${m} ${url.pathname} is not available`);
  }
  return { handle, reports, rules, analysis, sweep: async () => { const opened = await rules.sweep(); for (const o of opened) { const d = await reports.get(o.id); await analysis.updateSignals(d._surv.context.agent, d._surv.harm || 'other').catch(() => []); } return opened; } };
}
