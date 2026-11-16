// Surveillance and Reporting: what the reports add up to. Aggregates and subgroups, signal detection that
// updates after each report, the "is this a one-off or a pattern?" view of one report, replay on a sandbox
// branch, the actions a confirmed report or a validated signal can trigger, and exports.
import { randomUUID, createHash } from 'node:crypto';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';
import { createRun, endRun } from '../../agent-operations/server/runs.mjs';
import { redactText, nameParts } from '../../platform/server/redact.mjs';
import { pseudonym } from '../../platform/server/pseudonym.mjs';
import { rate, sequential, disproportionality, screen, subgroupGrid, discoverSubgroups, similarity, cluster, embedText, outOfDistribution, THRESHOLDS } from './stats.mjs';
import { DIMS, SUBGROUP_DIMS, HARMS, SEVERITIES } from './reports.mjs';

const DAY = 86400000; const day = (iso) => String(iso).slice(0, 10);
const METHOD_LABEL = { prr: 'Proportional reporting ratio', ror: 'Reporting odds ratio', ic: 'Information component (BCPNN)', ebgm: 'Empirical Bayes geometric mean (EB05)', poisson: 'Poisson rate against the baseline', cusum: 'CUSUM', maxsprt: 'MaxSPRT with alpha spending' };

export function createAnalysis({ store, agents, reports, rules }) {
  const settings = () => rules.settings();
  // ---------- aggregates ----------
  /** Reports and rates grouped by one dimension (and optionally by month), human, automatic and agent side by side. */
  async function aggregate({ by = 'agent', filter = {}, harm = null, over = null } = {}) {
    if (![...DIMS, 'harm', 'severity'].includes(by)) throw new HttpError(422, `by must be one of ${[...DIMS, 'harm', 'severity'].join(', ')}`);
    const exposure = (await reports.exposure()).filter((r) => reports.match(r.keys, filter)); const rows = (await reports.reportRows()).filter((r) => reports.match(r.keys, filter) && (!harm || r.harm === harm));
    const period = (at) => (over === 'month' ? String(at).slice(0, 7) : over === 'week' ? day(new Date(Math.floor(Date.parse(at) / (7 * DAY)) * 7 * DAY).toISOString()) : 'all');
    const groups = new Map(); const g = (value, p) => { const k = `${value}\u0000${p}`; if (!groups.has(k)) groups.set(k, { value, period: p, uses: 0, human: 0, automatic: 0, agent: 0, runs: new Set() }); return groups.get(k); };
    const isReportDim = by === 'harm' || by === 'severity';
    for (const r of exposure) { if (isReportDim) continue; g(r.keys[by] ?? 'unknown', period(r.at)).uses += 1; }
    for (const r of rows) { const x = g(isReportDim ? r[by] : r.keys[by] ?? 'unknown', period(r.at)); x[r.source] += 1; x.runs.add(r.run || r.id); }
    const totalUses = exposure.length;
    return { by, filter, harm, over, rows: [...groups.values()].map((x) => { const uses = isReportDim ? totalUses : x.uses; return { value: x.value, period: x.period, uses, human: rate(x.human, uses), automatic: rate(x.automatic, uses), agent: rate(x.agent, uses), combined: rate(x.runs.size, uses) }; }).sort((a, b) => String(a.period).localeCompare(String(b.period)) || (b.combined.events - a.combined.events)), overall: await reports.rates(filter, { harm }) };
  }
  /** Uses and events per combination of keys, for the subgroup tools. One event per reported run. */
  async function cells(filter = {}, harm = null) {
    const exposure = (await reports.exposure()).filter((r) => reports.match(r.keys, filter)); const hit = new Set((await reports.reportRows()).filter((r) => reports.match(r.keys, filter) && (!harm || r.harm === harm) && r.run).map((r) => r.run));
    return exposure.map((r) => ({ keys: r.keys, uses: 1, events: hit.has(r.run) ? 1 : 0, restricted: r.restricted }));
  }
  async function explorer({ dimA, dimB = null, filter = {}, harm = null }) {
    if (!DIMS.includes(dimA) || (dimB && !DIMS.includes(dimB))) throw new HttpError(422, `Choose dimensions from ${DIMS.join(', ')}`);
    const cfg = await settings(); return subgroupGrid(await cells(filter, harm), dimA, dimB, { minUses: cfg.minUses, q: cfg.fdr });
  }
  async function discover({ filter = {}, harm = null } = {}) { const cfg = await settings(); return discoverSubgroups(await cells(filter, harm), SUBGROUP_DIMS, { minUses: cfg.minUses, q: cfg.fdr }); }
  async function clusters({ filter = {} } = {}) {
    const docs = (await reports.all()).filter((d) => d._surv.status !== 'duplicate' && reports.match({ agent: d._surv.context.agent, version: d._surv.context.version }, filter));
    const items = docs.map((d) => { const f = reports.features(d); return { ...f, e: embedText(f.text) }; }).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return cluster(items).map((c) => ({ ...c, byMonth: c.dates.reduce((t, d) => { const m = d.slice(0, 7); t[m] = (t[m] || 0) + 1; return t; }, {}), dates: undefined }));
  }

  // ---------- signals ----------
  /** Day-by-day counts for one agent and harm: the 2 x 2 table for disproportionality and the uses for the exposure methods. */
  async function series(agent, harm, { version = null } = {}) {
    const exposure = await reports.exposure(); const rows = (await reports.reportRows()).filter((r) => r.keys.agent !== 'unknown');
    const mine = (k) => k.agent === agent && (!version || k.version === String(version));
    const days = [...new Set([...exposure.map((r) => day(r.at)), ...rows.map((r) => day(r.at))])].sort();
    const periods = days.map((d) => { const rs = rows.filter((r) => day(r.at) === d); const a = rs.filter((r) => mine(r.keys) && r.harm === harm).length; const b = rs.filter((r) => mine(r.keys) && r.harm !== harm).length; const c = rs.filter((r) => !mine(r.keys) && r.harm === harm).length; return { at: d, events: a, uses: exposure.filter((r) => mine(r.keys) && day(r.at) === d).length, a, b, c, d: rs.length - a - b - c }; });
    // The baseline for the exposure methods: how often this harm is reported for every other agent and version.
    const otherUses = exposure.filter((r) => !mine(r.keys)).length; const otherEvents = rows.filter((r) => !mine(r.keys) && r.harm === harm).length;
    return { periods, baseline: otherUses ? Math.max(otherEvents, 0.5) / otherUses : null };
  }
  async function statistics(agent, harm, opts = {}) {
    const { periods, baseline } = await series(agent, harm, opts); const seq = sequential(periods, { baseline, thresholds: THRESHOLDS });
    const table = disproportionality(seq.cumulative); return { agent, harm, version: opts.version ?? null, table, screen: screen(table), baselinePer1000: baseline == null ? null : Math.round(baseline * 100000) / 100, exposure: rate(seq.cumulative.events, seq.cumulative.uses), sequential: seq.signals, last: seq.last, thresholds: THRESHOLDS };
  }
  /** Run after each new report: any method that now trips for the report's agent and harm raises a signal, once, with its date and count. */
  async function updateSignals(agent, harm) {
    if (!agent || !harm) return [];
    const stats = await statistics(agent, harm); const raised = [];
    for (const [method, hit] of Object.entries(stats.sequential)) {
      if (!hit) continue; const id = createHash('sha256').update(`${agent}|${harm}|${method}`).digest('hex').slice(0, 24);
      if (await store.get('SurvSignal', id)) continue;
      const doc = { resourceType: 'SurvSignal', id, kind: 'method', method, methodLabel: METHOD_LABEL[method], agent, harm, raisedAt: store.now(), signalDate: hit.at, reportCount: hit.count, statistics: { table: stats.table, last: stats.last, baselinePer1000: stats.baselinePer1000 }, thresholds: THRESHOLDS[method], status: 'open', history: [] };
      await store.transaction(async (tx) => { await tx.save('SurvSignal', doc, { updatedBy: 'system' }); await recordAction(tx, { runId: LIVE_RUN_ID, actor: { kind: 'human', id: 'surveillance', role: 'system' }, kind: 'create', action: 'surveillance.signal.raise', args: { signal: id, method, agent, harm, signalDate: hit.at, reportCount: hit.count }, entityRef: `SurvSignal/${id}`, description: `signal raised by ${method} for ${agent} and ${harm}`, audit: false }); });
      raised.push(doc);
    }
    return raised;
  }
  /** The scheduled subgroup search: groups with an unusually high rate become "possible subgroup signals". */
  async function discoverJob() {
    const raised = []; const agentIds = [...new Set((await reports.exposure()).map((r) => r.keys.agent))];
    for (const agent of agentIds) for (const s of (await discover({ filter: { agent } })).signals) {
      const id = createHash('sha256').update(`subgroup|${agent}|${s.group}`).digest('hex').slice(0, 24); if (await store.get('SurvSignal', id)) continue;
      const doc = { resourceType: 'SurvSignal', id, kind: 'subgroup', method: 'subgroup-discovery', methodLabel: 'Possible subgroup signal', agent, harm: null, group: s.group, keys: s.keys, raisedAt: store.now(), signalDate: day(store.now()), reportCount: s.events, size: s.uses, effect: { per1000: s.per1000, low: s.low, high: s.high, ratio: s.ratio, adjustedP: s.adjusted }, status: 'open', history: [] };
      await store.transaction(async (tx) => { await tx.save('SurvSignal', doc, { updatedBy: 'system' }); await recordAction(tx, { runId: LIVE_RUN_ID, actor: { kind: 'human', id: 'surveillance', role: 'system' }, kind: 'create', action: 'surveillance.signal.raise', args: { signal: id, method: 'subgroup-discovery', agent, group: s.group, size: s.uses, ratio: s.ratio }, entityRef: `SurvSignal/${id}`, description: `possible subgroup signal for ${agent}: ${s.group}`, audit: false }); });
      raised.push(doc);
    }
    return raised;
  }
  const signals = async () => (await store.query('SurvSignal')).map(reports.strip).sort((a, b) => String(b.raisedAt).localeCompare(String(a.raisedAt)));
  async function reviewSignal(id, body, ctx) {
    reports.reviewer(ctx); if (!['validated', 'refuted', 'monitoring'].includes(body?.decision)) throw new HttpError(422, 'decision must be validated, refuted or monitoring');
    if (!String(body?.reason || '').trim()) throw new HttpError(422, 'Give a reason');
    return store.transaction(async (tx) => { const cur = await tx.get('SurvSignal', id); if (!cur) throw new HttpError(404, 'No such signal'); const { _seq, ...rest } = cur;
      const saved = await tx.save('SurvSignal', { ...rest, status: body.decision, history: [...rest.history, { at: tx.now(), by: ctx.actor.id, decision: body.decision, reason: String(body.reason).slice(0, 1000) }] }, { updatedBy: ctx.actor.role });
      await recordAction(tx, { runId: LIVE_RUN_ID, actor: ctx.actor, kind: 'update', action: 'surveillance.signal.review', args: { signal: id, decision: body.decision }, entityRef: `SurvSignal/${id}`, versionId: saved.meta.versionId, description: `signal ${body.decision}` }); return reports.strip(saved); });
  }
  // ---------- watchlist ----------
  async function watchlist() {
    const out = []; for (const w of await store.query('SurvWatch')) { const { _seq, ...x } = w; out.push({ ...x, current: x.kind === 'harm' ? await statistics(x.agent, x.harm) : { ...(await reports.rates({ agent: x.agent, ...x.keys })), overall: (await reports.rates({ agent: x.agent })).combined } }); } return out;
  }
  async function watch(body, ctx) {
    reports.reviewer(ctx); const agent = String(body?.agent || ''); if (!(await store.get('Agent', agent))) throw new HttpError(422, 'agent: choose a registered agent');
    const kind = body?.harm ? 'harm' : 'subgroup'; if (kind === 'harm' && !HARMS[body.harm]) throw new HttpError(422, 'harm is not one of the categories');
    const keys = kind === 'subgroup' ? Object.fromEntries(Object.entries(body?.keys || {}).filter(([k]) => SUBGROUP_DIMS.includes(k)).map(([k, v]) => [k, String(v)])) : null; if (kind === 'subgroup' && !Object.keys(keys).length) throw new HttpError(422, 'Name a harm, or subgroup keys');
    const doc = { resourceType: 'SurvWatch', id: randomUUID(), kind, agent, harm: kind === 'harm' ? body.harm : null, keys, addedBy: ctx.actor.id, addedAt: store.now(), note: String(body?.note || '').slice(0, 300) };
    await store.transaction((tx) => tx.save('SurvWatch', doc, { updatedBy: ctx.actor.role })); return doc;
  }

  // ---------- one report in context ----------
  async function context(id, ctx) {
    const doc = await reports.get(id); const s = doc._surv; const c = s.context; const mine = { ...reports.features(doc), e: embedText(s.narrative) };
    const others = (await reports.all()).filter((d) => d.id !== doc.id && d._surv.status !== 'duplicate');
    const similar = others.map((d) => { const f = { ...reports.features(d), e: embedText(d._surv.narrative) }; return { id: d.id, caseId: d._surv.caseId, filedAt: d._surv.filedAt, source: d._surv.source.kind, status: d._surv.status, harm: d._surv.harm, agent: d._surv.context.agent, version: d._surv.context.version, ...similarity(mine, f) }; }).filter((x) => x.reasons.length).sort((a, b) => b.score - a.score).slice(0, 15);
    const exposure = await reports.exposure(); const rows = await reports.reportRows(); const agentFilter = { agent: c.agent, version: c.version };
    // Base rate: how often a problem of this kind is seen for this agent and version, by where it was seen.
    const where = (modes) => { const uses = exposure.filter((r) => reports.match(r.keys, agentFilter) && modes.includes(r.mode)); const runIds = new Set(uses.map((r) => r.run)); return rate(new Set(rows.filter((r) => r.harm === (s.harm || 'other') && runIds.has(r.run)).map((r) => r.run)).size, uses.length); };
    const overall = await reports.rates(agentFilter, { harm: s.harm });
    const baseRate = { shadow: where(['shadow-event', 'shadow-task']), evaluation: where(['sandbox', 'rl-generate', 'regression', 'scribe']), activeSurveillance: overall.automatic, reported: overall.human, agentReported: overall.agent, combined: overall.combined, gap: overall.underReporting };
    // Version lineage: reports per version, in order of each version's first use.
    const versions = [...new Set(exposure.filter((r) => r.keys.agent === c.agent).sort((a, b) => String(a.at).localeCompare(String(b.at))).map((r) => r.keys.version))];
    const lineage = versions.map((v) => { const uses = exposure.filter((r) => r.keys.agent === c.agent && r.keys.version === v); const rs = rows.filter((r) => r.keys.agent === c.agent && r.keys.version === v && r.harm === (s.harm || 'other')); return { version: v, firstUse: uses.map((r) => r.at).sort()[0] || null, ...rate(new Set(rs.map((r) => r.run || r.id)).size, uses.length), reportDates: rs.map((r) => day(r.at)).sort(), thisReport: v === c.version }; });
    const startedWith = lineage.find((l) => l.events > 0)?.version ?? null;
    const ood = outOfDistribution({ ...c.keys, taskType: c.taskType }, exposure.filter((r) => r.keys.agent === c.agent));
    const cfg = await settings(); const allCells = await cells({ agent: c.agent }, s.harm);
    const subgroups = SUBGROUP_DIMS.map((dim) => { const grid = subgroupGrid(allCells, dim, null, { minUses: cfg.minUses, q: cfg.fdr }); return { dim, thisValue: c.keys[dim], overall: grid.overall, cells: grid.cells.map((x) => ({ value: x.a, uses: x.uses, events: x.events, per1000: x.per1000, low: x.low, high: x.high, small: x.small, higher: x.higher, ratio: x.ratio, thisReport: x.a === c.keys[dim] })) }; });
    const since = similar.map((x) => x.filedAt).sort()[0] || s.filedAt;
    const summary = `${similar.length} similar report${similar.length === 1 ? '' : 's'} since ${day(since)}. The team is ${s.status === 'new' ? 'going to review this' : STATUS_WORDS[s.status] || 'reviewing'}. This version has an estimated rate of ${overall.combined.per1000 ?? 'unknown'} per 1,000 uses.`;
    if (ctx?.actor?.role === 'patient') return { caseId: s.caseId, status: s.status, summary }; // a patient sees no one else's details
    return { caseId: s.caseId, summary, similar, baseRate, lineage, startedWith, outOfDistribution: ood, subgroups, reproduced: s.reproduced || null, oneOff: similar.filter((x) => x.score >= 0.5).length === 0 };
  }
  const STATUS_WORDS = { 'needs-info': 'waiting for more information', 'under-review': 'reviewing', 'confirmed-ai': 'treating this as confirmed', 'not-ai': 'treating this as not related to the AI', duplicate: 'handling this with an earlier report', closed: 'finished with this report' };

  // ---------- reproduce ----------
  /** What an agent did in a run, reduced to something comparable: its output and the records it wrote. */
  async function signature(runId) {
    const run = await store.get('Run', runId); const steps = (await store.query('TraceStep', { groupKey: runId })).filter((x) => x.who?.kind === 'agent');
    const wrote = steps.filter((x) => ['fhir.create', 'fhir.update', 'fhir.transition'].includes(x.did?.type) && x.did.args?.type !== 'Provenance').map((x) => x.did.args.type).sort();
    const refused = steps.filter((x) => ['envelope.reject', 'safety.block'].includes(x.did?.type)).map((x) => x.did.args?.rule || 'blocked').sort();
    const flags = (run?.result?.flags || []).map((f) => f.code).sort();
    return createHash('sha256').update(JSON.stringify({ summary: String(run?.result?.summary || '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '').trim(), wrote, refused, flags })).digest('hex').slice(0, 16);
  }
  /**
   * Replays the reported case on sandbox branches forked at the same moment: the same version and seed n times,
   * then the current version, then a set of perturbations. The result is stored on the report.
   */
  async function reproduce(id, body, ctx) {
    reports.reviewer(ctx); const doc = await reports.get(id); const c = doc._surv.context;
    if (!c.run) throw new HttpError(422, 'This report is not linked to an agent run, so there is nothing to replay');
    const original = await store.get('Run', c.run); const agent = await store.get('Agent', c.agent); if (!original || !agent) throw new HttpError(409, 'The run or the agent no longer exists');
    if (!agents.canRun(agent)) throw new HttpError(409, `${agent.name} cannot run on this server`);
    const n = Math.min(10, Math.max(1, Number(body?.times) || 3)); const want = await signature(original.id);
    const once = async (label, { version, overlays = [], seed }) => {
      const run = await createRun(store, { mode: 'sandbox', agentId: agent.id, version, subject: original.subject, goal: original.goal || 'Replay of a reported case', forkedAt: original.startedAt, overlays, context: { ...(original.context || {}), seed, replayOf: original.id, report: doc._surv.caseId }, trigger: { kind: 'surveillance-replay', actor: ctx.actor.id, role: ctx.actor.role, at: store.now(), report: doc.id, label } }, ctx.actor);
      const outcome = await agents.work(run, { ...agent, version });
      await endRun(store, run.id, agents.agentActor(agent), outcome.ok ? 'completed' : outcome.reason, outcome.result ?? { error: outcome.error });
      return { label, run: run.id, version, same: (await signature(run.id)) === want };
    };
    const same = []; for (let i = 0; i < n; i += 1) same.push(await once(`same version, attempt ${i + 1}`, { version: original.version, seed: c.seed ?? 0 }));
    const current = String(agent.version) === String(original.version) ? null : await once('current version', { version: agent.version, seed: c.seed ?? 0 });
    const perturbed = []; for (const [label, overlays] of [['priors hidden', [{ type: 'hide', what: 'priors' }]], ['notes hidden', [{ type: 'hide', what: 'notes' }]], ['labs hidden', [{ type: 'hide', what: 'labs' }]]]) { try { perturbed.push(await once(label, { version: original.version, overlays, seed: c.seed ?? 0 })); } catch (err) { perturbed.push({ label, error: err.message }); } }
    const k = same.filter((x) => x.same).length;
    const result = { verdict: k === n ? 'yes' : k === 0 ? 'no' : 'intermittent', k, n, at: store.now(), by: ctx.actor.id, sameVersion: same, currentVersion: current, perturbations: perturbed, stillInCurrentVersion: current ? current.same : k > 0 };
    const saved = await reports.revise(doc.id, ctx, 'surveillance.report.reproduce', { verdict: result.verdict, k, n, runs: same.map((x) => x.run) }, (s) => ({ ...s, reproduced: result }), `reported case replayed: reproduced ${result.verdict} (${k} of ${n})`);
    return { caseId: saved._surv.caseId, reproduced: result };
  }

  // ---------- actions ----------
  /** Pause, block promotion, roll back or restrict: only on a confirmed severe report or a validated signal, with the owner's reason, logged. */
  async function act(body, ctx) {
    reports.reviewer(ctx); const reason = String(body?.reason || '').trim().slice(0, 1000); if (!reason) throw new HttpError(422, 'Give the reason for this action');
    const kind = body?.action; if (!['pause', 'block-promotion', 'roll-back', 'restrict', 'lift'].includes(kind)) throw new HttpError(422, 'action must be pause, block-promotion, roll-back, restrict or lift');
    let basis; let agentId;
    if (body?.report) { const d = await reports.get(String(body.report)); const s = d._surv; if (kind !== 'lift' && !(s.status === 'confirmed-ai' && ['severe', 'life-threatening', 'death'].includes(s.severity))) throw new HttpError(409, 'An action needs a report that is confirmed AI-related and severe, or a validated signal'); basis = { report: d.id, caseId: s.caseId }; agentId = s.context.agent; }
    else if (body?.signal) { const sig = await store.get('SurvSignal', String(body.signal)); if (!sig) throw new HttpError(404, 'No such signal'); if (kind !== 'lift' && sig.status !== 'validated') throw new HttpError(409, 'The signal has not been validated'); basis = { signal: sig.id }; agentId = sig.agent; }
    else throw new HttpError(422, 'Name the report or the signal this action rests on');
    const agent = await store.get('Agent', agentId); if (!agent) throw new HttpError(409, 'The agent is not registered');
    let done;
    if (kind === 'pause') done = await agents.setKillSwitch({ scope: 'agent', target: agent.id, engaged: true, reason: `Surveillance: ${reason}` }, ctx.actor);
    const patch = kind === 'block-promotion' ? { surveillance: { ...(agent.surveillance || {}), promotionBlocked: { reason, by: ctx.actor.id, at: store.now(), ...basis } } }
      : kind === 'restrict' ? { surveillance: { ...(agent.surveillance || {}), restrictedTo: { condition: body?.condition ? String(body.condition) : null, keys: Object.fromEntries(Object.entries(body?.keys || {}).filter(([k]) => SUBGROUP_DIMS.includes(k)).map(([k, v]) => [k, String(v)])), reason, by: ctx.actor.id, at: store.now(), ...basis } } }
      : kind === 'lift' ? { surveillance: { ...(agent.surveillance || {}), promotionBlocked: null, restrictedTo: null } }
      : kind === 'roll-back' ? (() => { const prev = [...(agent.versionHistory || [])].reverse().find((v) => v.version !== agent.version) || (agent.promotions || []).map((p) => ({ version: p.version, policyHash: null })).reverse().find((v) => v.version && v.version !== agent.version); if (!prev) throw new HttpError(409, 'No earlier version of this agent is on record to roll back to'); return { version: prev.version, ...(prev.policyHash ? { policyHash: prev.policyHash } : {}), stage: 'shadow', promotedVersion: null, surveillance: { ...(agent.surveillance || {}), rolledBack: { from: agent.version, to: prev.version, reason, by: ctx.actor.id, at: store.now(), ...basis } }, versionHistory: [...(agent.versionHistory || []), { version: agent.version, policyHash: agent.policyHash, until: store.now() }] }; })() : null;
    const saved = await store.transaction(async (tx) => {
      let out = null;
      if (patch) { const cur = await tx.get('Agent', agent.id); const { _seq, ...rest } = cur; if (kind === 'restrict' && !patch.surveillance.restrictedTo.condition && !Object.keys(patch.surveillance.restrictedTo.keys).length) throw new HttpError(422, 'Say what the agent is restricted to: a condition, or subgroup keys'); out = await tx.save('Agent', { ...rest, ...patch }, { updatedBy: ctx.actor.role }); }
      await recordAction(tx, { runId: LIVE_RUN_ID, actor: ctx.actor, kind: 'update', action: `surveillance.action.${kind}`, args: { agent: agent.id, version: agent.version, ...basis, to: patch?.version ?? null }, why: reason, entityRef: `Agent/${agent.id}`, versionId: out?.meta?.versionId, description: `surveillance action on ${agent.id}: ${kind}` });
      return out;
    });
    if (basis.report) await reports.revise(basis.report, ctx, 'surveillance.report.action', { action: kind }, (s) => ({ ...s, actions: [...(s.actions || []), { at: store.now(), by: ctx.actor.id, action: kind, reason }] }), `action recorded on the report: ${kind}`);
    return { action: kind, agent: agent.id, basis, killSwitch: done ?? null, surveillance: saved?.surveillance ?? agent.surveillance ?? null, version: saved?.version ?? agent.version };
  }

  // ---------- exports ----------
  /** Summary per agent version. shareable: restricted reports are left out, small cells are suppressed, text is de-identified. */
  async function summary(agentId, version, { shareable = true } = {}) {
    const cfg = await settings(); const filter = { agent: agentId, ...(version ? { version: String(version) } : {}) };
    const exposure = (await reports.exposure()).filter((r) => reports.match(r.keys, filter) && (!shareable || !r.restricted));
    const rows = (await reports.reportRows({ includeRestricted: !shareable })).filter((r) => reports.match(r.keys, filter));
    const suppress = (x, uses) => (shareable && uses < cfg.minUses ? { suppressed: true, reason: `fewer than ${cfg.minUses} uses` } : x);
    const count = (list, key) => { const t = {}; for (const r of list) t[key(r)] = (t[key(r)] || 0) + 1; return t; };
    const bySubgroup = {}; for (const dim of SUBGROUP_DIMS) { bySubgroup[dim] = {}; for (const value of new Set(exposure.map((r) => r.keys[dim]))) { const uses = exposure.filter((r) => r.keys[dim] === value).length; const ev = new Set(rows.filter((r) => r.keys[dim] === value).map((r) => r.run || r.id)).size; bySubgroup[dim][value] = suppress(rate(ev, uses), uses); } }
    const sigs = (await signals()).filter((x) => x.agent === agentId); const agent = await store.get('Agent', agentId);
    const names = nameParts(await store.query('Patient'));
    const examples = (await reports.all()).filter((d) => d._surv.context.agent === agentId && (!version || d._surv.context.version === String(version)) && (!shareable || !d._surv.context.restricted)).slice(0, 50).map((d) => ({ case: d._surv.caseId, source: d._surv.source.kind, reporter: d._surv.source.kind === 'human' ? pseudonym(d._surv.source.by) : d._surv.source.agent || d._surv.source.rule, severity: d._surv.severity, harm: d._surv.harm, status: d._surv.status, whatHappened: shareable ? redactText(d._surv.narrative, { names }).text : d._surv.narrative }));
    return { agent: agentId, version: version ? String(version) : 'all versions', generatedAt: store.now(), shareable, exposure: { uses: exposure.length }, counts: { bySource: count(rows, (r) => r.source), byHarm: count(rows, (r) => r.harm), bySeverity: count(rows, (r) => r.severity), byStatus: count(rows, (r) => r.status) },
      rates: { combined: rate(new Set(rows.map((r) => r.run || r.id)).size, exposure.length), byHarm: Object.fromEntries(Object.keys(HARMS).map((h) => [h, rate(new Set(rows.filter((r) => r.harm === h).map((r) => r.run || r.id)).size, exposure.length)])), bySeverity: Object.fromEntries(SEVERITIES.map((sv) => [sv, rate(rows.filter((r) => r.severity === sv).length, exposure.length)])) },
      bySubgroup, signals: sigs.map((x) => ({ method: x.method, harm: x.harm, group: x.group ?? null, signalDate: x.signalDate, reportCount: x.reportCount, status: x.status })), actions: { killSwitch: null, promotionBlocked: agent?.surveillance?.promotionBlocked ?? null, restrictedTo: agent?.surveillance?.restrictedTo ?? null, rolledBack: agent?.surveillance?.rolledBack ?? null }, reports: examples,
      notes: shareable ? [`Reports about restricted sources are not in this export. Subgroup cells with fewer than ${cfg.minUses} uses are suppressed. Free text has been through the de-identification pass.`] : ['Local view: not for sharing.'] };
  }
  return { aggregate, explorer, discover, discoverJob, clusters, statistics, updateSignals, signals, reviewSignal, watchlist, watch, context, reproduce, act, summary, METHOD_LABEL };
}
