// CDS Hooks 2.0, both sides, local by default.
// Service host: GET /cds-services (discovery), POST /cds-services/{id},
// POST /cds-services/{id}/feedback. Built-in services: a NEWS2 card on
// patient-view, a renal dose check and an interaction check on order-select
// and order-sign (the pharmacy starter tables), an imaging appropriateness
// reminder on order-select, and any model-backed agent exposed as a service.
// Client: the EHR calls POST /api/cds/invoke; this server fans out to every
// service for the hook (built-in in-process, external over HTTP only when
// ALLOW_EXTERNAL_CDS=true and the patient is synthetic), with a 2 second
// timeout that never blocks the clinician. Every call, card, acceptance and
// dismissal is a TraceStep. Cards are advisory: the hard-wired safety alerts
// never depend on a service being reachable.
import { randomUUID } from 'node:crypto';
import { createConsent } from './consent.mjs';
let coverageCheck = null;
/** The insurance engine's need check, set by the server once it exists. */
export const setCoverageCheck = (fn) => { coverageCheck = fn; };
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';
import { SYSTEMS, LAB_BY_CODE, IMAGING } from '../../ehr/server/catalog.mjs';
import { interactions, doseRange, reviewContext, rxOf, medName } from '../../pharmacy/server/pharmacy.mjs';
import { SCORE_SYSTEM, NEWS2_CODE } from '../../ehr/server/nursing.mjs';
import { isSyntheticPatient } from '../../agent-operations/server/hitl.mjs';
import { RESTRICTED_URL } from '../../platform/server/datasets.mjs';

export const HOOKS = ['patient-view', 'order-select', 'order-sign'];
export const TIMEOUT_MS = 2000;
export const externalCdsAllowed = (env = process.env) => env.ALLOW_EXTERNAL_CDS === 'true';
const PREFETCH = { patient: 'Patient/{{context.patientId}}', medications: 'MedicationRequest?patient={{context.patientId}}&status=active', allergies: 'AllergyIntolerance?patient={{context.patientId}}', observations: 'Observation?patient={{context.patientId}}' };
const whenOf = (o) => o.effectiveDateTime || o._validAt || o._recordedAt;
const card = (o) => ({ uuid: randomUUID(), indicator: 'info', source: { label: 'Healthcare InSilico (built-in)' }, ...o });

export const BUILT_IN = [
  // Coverage requirements discovery (in the pattern of Da Vinci CRD): when an order needs authorisation under the member's plan, say so and say what documentation is needed. Silent for patients with no coverage on file.
  { id: 'coverage-requirements', hook: ['order-select', 'order-sign'], title: 'Coverage requirements', description: 'Says when an order needs prior authorization under the plan of the patient and which criteria the policy asks for.', prefetch: {},
    async run({ orders, context, ctx }) {
      if (!coverageCheck) return []; const out = [];
      for (const o of orders) {
        const code = (o.code || o.medicationCodeableConcept)?.coding?.[0]?.code; if (!code) continue;
        let need; try { need = await coverageCheck({ patient: context.patientId, services: [{ code }], serviceDate: o.occurrenceDateTime || null }, ctx); } catch { continue; }
        if (!need.needed) continue;
        out.push(card({ summary: `Authorization needed: ${need.policy?.title || code}`, indicator: 'warning', source: { label: need.planName, topic: { code: 'prior-auth' } }, detail: `${need.why}. ${need.policy ? `Criteria: ${need.policy.criteria.map((x) => x.text).join('; ')}. Policy ${need.policy.id} version ${need.policy.version}.` : 'No reviewed policy covers this service: a person at the plan decides.'} Ask for it from Billing, Insurance desk.`, coverage: { code, plan: need.plan, policy: need.policy ? { id: need.policy.id, version: need.policy.version } : null } }));
      }
      return out;
    } },
  { id: 'news2-card', hook: 'patient-view', title: 'Early-warning score', description: 'Shows the latest NEWS2 score and its response band.', prefetch: { observations: PREFETCH.observations },
    async run({ prefetch }) {
      const scores = (prefetch.observations || []).filter((o) => (o.code?.coding || []).some((c) => c.system === SCORE_SYSTEM && c.code === NEWS2_CODE)).sort((a, b) => (whenOf(a) < whenOf(b) ? 1 : -1));
      const s = scores[0];
      if (!s || s.valueInteger == null) return [];
      const band = s.interpretation?.[0]?.coding?.[0]?.code || 'low';
      return [card({ summary: `NEWS2 ${s.valueInteger} (${band}) at ${whenOf(s).slice(11, 16)}`, indicator: band === 'high' ? 'critical' : band === 'low' ? 'info' : 'warning', detail: `${s.interpretation?.[0]?.coding?.[0]?.display || ''}. Decision support in a simulation, scored from the vitals recorded at ${whenOf(s)}.`, links: [{ label: 'Open flowsheets', url: `/ehr/#/chart/${s.subject?.reference?.split('/')[1]}/flowsheets`, type: 'absolute' }] })];
    } },
  { id: 'renal-dose', hook: ['order-select', 'order-sign'], title: 'Renal dose check', description: 'Flags a medication whose starter-table dose range has a renal limit when the estimated eGFR is below it, or when no recent creatinine exists.', prefetch: { patient: PREFETCH.patient, observations: PREFETCH.observations },
    async run({ orders, context, store, ctx }) {
      const out = [];
      for (const o of orders.filter((x) => x.resourceType === 'MedicationRequest')) {
        const rc = await reviewContext(store, { ...o, subject: { reference: `Patient/${context.patientId}` } }, { branch: ctx.branch, asOf: ctx.asOf, now: store.now() });
        const findings = doseRange(o, rc).filter((f) => /Renal/.test(f.detail));
        for (const f of findings) out.push(card({ summary: `${medName(o)}: renal dose check`, indicator: 'warning', detail: `${f.detail} Starter table, unverified.`, suggestions: rc.creatinine ? [] : [{ label: 'Order a creatinine', uuid: randomUUID(), actions: [{ type: 'create', description: 'Creatinine', resource: { resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: `Patient/${context.patientId}` }, code: { coding: [{ system: SYSTEMS.loinc, code: '2160-0', display: 'Creatinine' }], text: 'Creatinine' }, category: [{ coding: [{ system: 'urn:hospital-desktop:order-category', code: 'laboratory' }] }] } }] }], overrideReasons: [{ code: 'monitored', display: 'Renal function monitored' }, { code: 'specialist', display: 'Specialist advice' }] }));
        if (!rc.creatinine && rxOf(o)) out.push(card({ summary: `${medName(o)}: no recent creatinine`, indicator: 'info', detail: 'No creatinine result is on the chart; the renal check could not run.', suggestions: [{ label: 'Order a creatinine', uuid: randomUUID(), actions: [{ type: 'create', description: 'Creatinine', resource: { resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: `Patient/${context.patientId}` }, code: { coding: [{ system: SYSTEMS.loinc, code: '2160-0', display: 'Creatinine' }], text: 'Creatinine' }, category: [{ coding: [{ system: 'urn:hospital-desktop:order-category', code: 'laboratory' }] }] } }] }] }));
      }
      return out;
    } },
  { id: 'interaction-check', hook: ['order-select', 'order-sign'], title: 'Drug interaction check', description: 'Pairs from the pharmacy starter interaction table against the active medication list.', prefetch: { medications: PREFETCH.medications },
    async run({ orders, prefetch }) {
      const current = (prefetch.medications || []).filter((m) => ['active', 'on-hold'].includes(m.status) || (m.extension || []).some((e) => e.url === 'urn:hospital-desktop:lifecycle' && ['active', 'pending-verification'].includes(e.valueCode)));
      const out = [];
      for (const o of orders.filter((x) => x.resourceType === 'MedicationRequest')) for (const f of interactions(o, current)) out.push(card({ summary: `${medName(o)}: interaction`, indicator: f.severity === 'high' ? 'critical' : 'warning', detail: `${f.detail} Starter table, unverified.`, overrideReasons: [{ code: 'benefit', display: 'Benefit outweighs the risk' }, { code: 'monitored', display: 'Will monitor' }] }));
      return out;
    } },
  { id: 'imaging-appropriateness', hook: 'order-select', title: 'Imaging appropriateness reminder', description: 'Asks for an indication on imaging orders and reminds about radiation for CT.', prefetch: {},
    async run({ orders }) {
      const out = [];
      for (const o of orders.filter((x) => x.resourceType === 'ServiceRequest' && (x.category || []).some((c) => (c.coding || []).some((y) => y.code === 'imaging')))) {
        const code = o.code?.coding?.[0]?.code; const spec = IMAGING.find((i) => i.code === code);
        if (!o.reasonCode?.length) out.push(card({ summary: `${spec?.name || 'Imaging'}: no indication given`, indicator: 'info', detail: 'Add the clinical question so the radiologist can protocol the study. A reminder, not a safety alert.' }));
        if (spec?.modality === 'CT') out.push(card({ summary: `${spec.name}: ionising radiation`, indicator: 'info', detail: 'Consider whether an earlier study answers the question. Appropriateness criteria are not built in; this is a reminder only.' }));
      }
      return out;
    } },
];

export function createCds({ store, agents, env = process.env }) {
  const consent = createConsent(store);
  const log = (ctx, fields) => store.transaction((tx) => recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, branch: ctx.branch ?? 'main', audit: false, ...fields }));
  const hooksOf = (s) => (Array.isArray(s.hook) ? s.hook : [s.hook]);

  async function agentServices() {
    const list = await store.query('Agent', { where: (a) => a.adapter?.kind === 'model' && a.enabled !== false && a.cds === true });
    return list.map((a) => ({ id: `agent-${a.id}`, hook: 'patient-view', title: `${a.name} (model-backed agent)`, description: `Runs ${a.adapter.template} on ${a.adapter.model} in a practice copy and shows the summary as a card.`, prefetch: {}, agentId: a.id }));
  }
  async function externalServices() { return (await store.query('CdsService')).filter((s) => !s.retired); }
  async function services() { return [...BUILT_IN.map(({ run, ...s }) => s), ...(await agentServices()), ...(await externalServices()).flatMap((e) => (e.services || []).map((s) => ({ ...s, external: true, url: `${e.url.replace(/\/$/, '')}/cds-services/${s.id}`, id: `ext-${e.id}-${s.id}` })))]; }

  async function prefetchFor(service, context, ctx) {
    const out = {};
    if (await consent.blocked(String(context.patientId || ''), service.id?.startsWith('agent-') ? { ...ctx, purpose: 'HRESCH' } : ctx)) return out;
    const o = { branch: ctx.branch, asOf: ctx.asOf };
    const ref = `Patient/${context.patientId}`;
    for (const [key, template] of Object.entries(service.prefetch || {})) {
      if (template.startsWith('Patient/')) out[key] = await store.get('Patient', context.patientId, o);
      else if (template.startsWith('MedicationRequest')) out[key] = await store.query('MedicationRequest', { patient: ref }, o);
      else if (template.startsWith('AllergyIntolerance')) out[key] = await store.query('AllergyIntolerance', { patient: ref }, o);
      else if (template.startsWith('Observation')) out[key] = await store.query('Observation', { patient: ref }, o);
    }
    return out;
  }
  const ordersOf = (context) => [...(context.draftOrders?.entry || []).map((e) => e.resource), ...(context.selections || []).map((s) => s.resource || s).filter((r) => r && r.resourceType)];

  /** Runs one built-in or agent service for a CDS Hooks request. */
  async function serve(id, request, ctx) {
    if (!HOOKS.includes(request.hook)) throw new HttpError(422, `hook must be one of ${HOOKS.join(', ')}`);
    if (!request.context?.patientId) throw new HttpError(422, 'context.patientId is required');
    const built = BUILT_IN.find((s) => s.id === id);
    if (built) {
      if (!hooksOf(built).includes(request.hook)) throw new HttpError(422, `${id} serves ${hooksOf(built).join(', ')}, not ${request.hook}`);
      const prefetch = { ...(await prefetchFor(built, request.context, ctx)), ...(request.prefetch || {}) };
      return { cards: await built.run({ prefetch, orders: ordersOf(request.context), context: request.context, store, ctx }) };
    }
    const agentSvc = (await agentServices()).find((s) => s.id === id);
    if (agentSvc) {
      if (!agents) throw new HttpError(409, 'The agent runtime is not available');
      const run = await agents.launch({ agentId: agentSvc.agentId, mode: 'sandbox', subject: `Patient/${request.context.patientId}`, goal: `CDS ${request.hook}`, actor: ctx.actor, wait: true });
      const done = await store.get('Run', run.id);
      const summary = done?.result?.summary || done?.result?.error || 'No answer';
      return { cards: [card({ summary: `${agentSvc.title}: ${String(summary).slice(0, 120)}`, indicator: 'info', detail: `${summary} Written on a practice copy only (run ${run.id}); nothing reached the live chart.`, source: { label: agentSvc.title }, links: [{ label: 'Open the trace', url: `/agent-ops/#/trace/${run.id}`, type: 'absolute' }] })] };
    }
    throw new HttpError(404, `No CDS service "${id}"`);
  }

  async function feedback(id, body, ctx) {
    const items = Array.isArray(body?.feedback) ? body.feedback : [];
    for (const f of items) await log(ctx, { kind: 'execute', action: f.outcome === 'accepted' ? 'cds.accept' : 'cds.dismiss', args: { service: id, card: f.card, outcome: f.outcome, overrideReason: f.overrideReason?.reason?.code || f.overrideReason?.code || f.overrideReason || null, userComment: f.overrideReason?.userComment || null, acceptedSuggestions: (f.acceptedSuggestions || []).map((s) => s.id) }, description: `CDS card ${f.outcome} (${id})` });
    return { status: 200, body: {} };
  }

  /** The EHR's client side: fan out to every service for the hook, with timeouts, friction and logging. */
  async function invoke(body, ctx) {
    const hook = body?.hook;
    const context = body?.context || {};
    if (!HOOKS.includes(hook)) throw new HttpError(422, `hook must be one of ${HOOKS.join(', ')}`);
    if (!context.patientId) throw new HttpError(422, 'context.patientId is required');
    const patient = await store.get('Patient', context.patientId, { branch: ctx.branch, asOf: ctx.asOf });
    if (!patient) throw new HttpError(404, 'Patient not found');
    const hookInstance = randomUUID();
    const run = ctx.run ?? await store.get('Run', LIVE_RUN_ID);
    const friction = run?.friction || 'low';
    const request = { hookInstance, hook, context: { userId: `${ctx.actor.role}/${ctx.actor.id}`, patientId: context.patientId, ...(context.encounterId ? { encounterId: context.encounterId } : {}), ...(context.draftOrders ? { draftOrders: context.draftOrders } : {}), ...(context.selections ? { selections: context.selections } : {}) } };
    const synthetic = isSyntheticPatient(patient) && !(patient.extension || []).some((e) => e.url === RESTRICTED_URL);
    const all = (await services()).filter((s) => hooksOf(s).includes(hook));
    const cards = [];
    const calls = [];
    for (const s of all) {
      const started = Date.now();
      let result = { cards: [] }; let status = 'ok';
      try {
        if (s.external) {
          if (!externalCdsAllowed(env)) { status = 'external-off'; }
          else if (!synthetic) { status = 'not-synthetic'; }
          else {
            const r = await fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, prefetch: {} }), signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            result = await r.json();
          }
        } else {
          result = await Promise.race([serve(s.id, request, ctx), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), s.agentId ? 15000 : TIMEOUT_MS))]);
        }
      } catch (err) { status = /timeout|abort/i.test(err.message) ? 'timeout' : `failed: ${String(err.message).slice(0, 80)}`; result = { cards: [] }; }
      const latencyMs = Date.now() - started;
      const mine = (result.cards || []).filter((c) => c && c.summary).map((c) => ({ ...c, uuid: c.uuid || randomUUID(), indicator: ['info', 'warning', 'critical'].includes(c.indicator) ? c.indicator : 'info', serviceId: s.id, serviceTitle: s.title }));
      calls.push({ service: s.id, status, latencyMs, cards: mine.length });
      await log(ctx, { kind: 'execute', action: 'cds.call', args: { service: s.id, hook, hookInstance, status, latencyMs, cards: mine.length, external: Boolean(s.external) }, patientRef: `Patient/${patient.id}`, description: `CDS ${hook} → ${s.id}: ${status} (${mine.length} cards, ${latencyMs} ms)` });
      cards.push(...mine);
    }
    // Friction governs how many advisory cards show. Critical cards always show; at low friction warnings still show and only information cards are left out.
    const limit = friction === 'low' ? 0 : friction === 'realistic' ? 2 : Infinity;
    const critical = cards.filter((c) => c.indicator === 'critical' || (friction === 'low' && c.indicator === 'warning'));
    const rest = cards.filter((c) => !critical.includes(c)).sort((a, b) => (a.indicator === 'warning' ? -1 : 1) - (b.indicator === 'warning' ? -1 : 1)).slice(0, limit);
    const shown = [...critical, ...rest];
    for (const c of shown) await log(ctx, { kind: 'execute', action: 'cds.card', args: { service: c.serviceId, card: c.uuid, hook, hookInstance, indicator: c.indicator, summary: String(c.summary).slice(0, 160), suggestions: (c.suggestions || []).length }, patientRef: `Patient/${patient.id}`, description: `CDS card shown: ${c.summary}` });
    return { status: 200, body: { hookInstance, hook, friction, cards: shown, suppressed: cards.length - shown.length, calls } };
  }

  async function registerExternal(body, ctx) {
    if (ctx.actor.kind !== 'human') throw new HttpError(403, 'People register CDS services');
    let url;
    try { url = new URL(String(body?.url || '')); } catch { throw new HttpError(422, 'url must be an http or https URL'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(422, 'url must be http or https');
    let discovered = []; let note = 'Discovery not fetched: ALLOW_EXTERNAL_CDS is not true';
    if (externalCdsAllowed(env)) {
      try { const r = await fetch(`${url.toString().replace(/\/$/, '')}/cds-services`, { signal: AbortSignal.timeout(TIMEOUT_MS) }); discovered = (await r.json()).services || []; note = `Discovered ${discovered.length} service(s)`; } catch (err) { note = `Discovery failed: ${String(err.message).slice(0, 80)}`; }
    }
    const id = randomUUID().slice(0, 8);
    const saved = await store.transaction(async (tx) => {
      const rec = await tx.save('CdsService', { resourceType: 'CdsService', id, url: url.toString(), services: discovered.map((s) => ({ id: String(s.id), hook: String(s.hook), title: String(s.title || s.id), description: String(s.description || ''), prefetch: s.prefetch || {} })), note, registeredAt: tx.now(), retired: false }, { updatedBy: ctx.actor.role });
      await recordAction(tx, { runId: LIVE_RUN_ID, actor: ctx.actor, kind: 'create', action: 'cds.register', args: { id, url: url.toString(), services: discovered.length }, entityRef: `CdsService/${id}`, description: `CDS service registered: ${url}` });
      return rec;
    });
    return { status: 201, body: { id: saved.id, url: saved.url, services: saved.services, note } };
  }

  async function report() {
    const steps = await store.query('TraceStep', { where: (t) => ['cds.call', 'cds.card', 'cds.accept', 'cds.dismiss'].includes(t.did?.type) });
    const byService = {};
    const get = (id) => (byService[id] = byService[id] || { service: id, calls: 0, timeouts: 0, failed: 0, latencies: [], cards: 0, accepted: 0, dismissed: 0, overrideReasons: {}, charts: new Set() });
    for (const t of steps) {
      const a = t.did.args || {};
      const r = get(a.service || 'unknown');
      if (t.did.type === 'cds.call') { r.calls += 1; if (a.status === 'timeout') r.timeouts += 1; else if (String(a.status).startsWith('failed')) r.failed += 1; if (typeof a.latencyMs === 'number') r.latencies.push(a.latencyMs); if (a.hook === 'patient-view') r.charts.add(a.hookInstance); }
      if (t.did.type === 'cds.card') r.cards += 1;
      if (t.did.type === 'cds.accept') r.accepted += 1;
      if (t.did.type === 'cds.dismiss') { r.dismissed += 1; const k = a.overrideReason || 'no reason'; r.overrideReasons[k] = (r.overrideReasons[k] || 0) + 1; }
    }
    const charts = new Set(steps.filter((t) => t.did.type === 'cds.call' && t.did.args?.hook === 'patient-view').map((t) => t.did.args.hookInstance)).size;
    const rows = Object.values(byService).map((r) => ({ service: r.service, calls: r.calls, timeouts: r.timeouts, failed: r.failed, meanLatencyMs: r.latencies.length ? Math.round(r.latencies.reduce((x, y) => x + y, 0) / r.latencies.length) : null, cards: r.cards, cardsPerChart: charts ? Math.round((r.cards / charts) * 100) / 100 : null, accepted: r.accepted, dismissed: r.dismissed, acceptanceRate: r.accepted + r.dismissed ? Math.round((r.accepted / (r.accepted + r.dismissed)) * 100) : null, overrideReasons: r.overrideReasons }));
    return { generatedAt: store.now(), charts, rows, note: 'Alert burden and acceptance per service, from the log. Cards are advisory; the built-in safety alerts are not counted here.' };
  }

  return { services, serve, feedback, invoke, registerExternal, report, BUILT_IN };
}
