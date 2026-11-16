// Active surveillance: named, versioned rules that open a "possible event" for review without anyone having
// to report. Each candidate is filed through the same door as a human report, with source "automatic" and the
// rule's id and version, so reported (passive) and detected (active) rates can be compared.
// Also here: drift monitors per agent version, and the review queue and precision of verifier agents.
import { isCritical } from '../../ehr/server/safety-alerts.mjs';
import { lifecycleOf } from '../../platform/server/state-machines.mjs';
import { rate } from './stats.mjs';

const HOUR = 3600000;
const taskIn = (t, name) => (t.input || []).find((i) => i.type?.text === name)?.valueString ?? null;
const taskOut = (t, name) => (t.output || []).find((i) => i.type?.text === name)?.valueString ?? null;
const COMPLAINT = /\b(complain|complaint|wrong|mistake|incorrect|error|upset|unhappy|not happy|unacceptable|dangerous|misinformed|made no sense)\b/i;
const CANCELLED = new Set(['cancelled', 'revoked', 'discontinued', 'stopped', 'entered-in-error', 'rejected']);

/** The rules. windowHours can be changed per rule in settings; changing a rule's logic means a new version. */
export const RULES = [
  { id: 'override-after-accept', version: '1', label: 'A clinician reversed an accepted AI output', windowHours: 24, harm: 'wrong', about: 'An AI proposal was accepted, then the record it made was changed or reversed by a person within the window.' },
  { id: 'ai-note-amended', version: '1', label: 'A note the AI drafted was amended', windowHours: 168, harm: 'wrong', about: 'A note that began as an AI draft was amended or had an addendum added.' },
  { id: 'ai-order-cancelled', version: '1', label: 'An order from an AI proposal was cancelled', windowHours: 72, harm: 'unsafe', about: 'An order placed from an AI proposal was cancelled or discontinued.' },
  { id: 'critical-after-ai', version: '1', label: 'A critical result followed an AI recommendation', windowHours: 12, harm: 'omitted', about: 'A critical laboratory result or a high early-warning score was recorded for the patient within the window after an agent finished its work.' },
  { id: 'safety-conflict', version: '1', label: 'The agent\'s output conflicted with an allergy or a dose range', windowHours: 0, harm: 'unsafe', about: 'The safety checks stopped something the agent tried to write.' },
  { id: 'patient-complaint', version: '1', label: 'The patient messaged a complaint', windowHours: 720, harm: 'other', about: 'A message from the patient reads as a complaint, and an agent worked on this patient within the window.' },
];

export function createRules({ store, reports }) {
  const settingsId = 'surveillance-rules';
  async function settings() { const s = await store.get('SurvSettings', settingsId); return { windows: Object.fromEntries(RULES.map((r) => [r.id, s?.windows?.[r.id] ?? r.windowHours])), off: s?.off || [], minUses: s?.minUses ?? 20, fdr: s?.fdr ?? 0.05, sweepSeconds: s?.sweepSeconds ?? 60 }; }
  async function saveSettings(body, ctx) {
    const cur = await settings(); const windows = { ...cur.windows }; for (const r of RULES) if (body?.windows?.[r.id] != null) windows[r.id] = Math.min(8760, Math.max(0, Number(body.windows[r.id]) || 0));
    const doc = { resourceType: 'SurvSettings', id: settingsId, windows, off: Array.isArray(body?.off) ? body.off.filter((id) => RULES.some((r) => r.id === id)) : cur.off, minUses: Math.min(1000, Math.max(1, Number(body?.minUses) || cur.minUses)), fdr: Math.min(0.5, Math.max(0.001, Number(body?.fdr) || cur.fdr)), sweepSeconds: cur.sweepSeconds };
    await store.transaction((tx) => tx.save('SurvSettings', doc, { updatedBy: ctx.actor.role })); return settings();
  }

  /** Everything each rule would open now. A candidate has a key so the same event is never opened twice. */
  async function candidates() {
    const cfg = await settings(); const out = []; const on = (id) => !cfg.off.includes(id); const win = (id) => cfg.windows[id] * HOUR;
    const steps = await store.query('TraceStep'); const humanSteps = steps.filter((s) => s.who?.kind === 'human');
    const tasks = await store.query('Task', { where: (t) => taskIn(t, 'run') && taskIn(t, 'proposal') != null });
    for (const t of tasks) {
      const decision = taskOut(t, 'decision'); const result = taskOut(t, 'result'); const decidedAt = taskOut(t, 'decided-at');
      if (!['accepted', 'edited'].includes(decision) || !result || !decidedAt || !/^[A-Za-z]+\/.+/.test(result)) continue;
      const [type, id] = result.split('/'); const doc = await store.get(type, id); const base = { about: { run: taskIn(t, 'run'), proposal: t.id, resource: result }, patient: t.for?.reference || doc?._patient || null };
      const later = humanSteps.filter((s) => s.did?.args?.type === type && s.did?.args?.id === id && s.when?.wall > decidedAt && ['fhir.update', 'fhir.transition'].includes(s.did.type));
      const state = doc ? (() => { try { return lifecycleOf(doc); } catch { return doc.status; } })() : null;
      if (on('ai-order-cancelled') && ['ServiceRequest', 'MedicationRequest'].includes(type) && CANCELLED.has(state)) { const when = later.at(-1)?.when?.wall || doc._recordedAt; if (Date.parse(when) - Date.parse(decidedAt) <= win('ai-order-cancelled')) out.push({ rule: 'ai-order-cancelled', key: `${t.id}:cancelled`, ...base, at: when, reachedPatient: 'caught-before', severity: 'near-miss', narrative: `An order placed from an AI proposal was ${state} ${Math.round((Date.parse(when) - Date.parse(decidedAt)) / HOUR)} hours after it was accepted.` }); }
      else if (on('ai-note-amended') && type === 'DocumentReference') {
        const addenda = await store.query('DocumentReference', { where: (d) => (d.relatesTo || []).some((r) => r.target?.reference === result) });
        const when = doc?.docStatus === 'amended' ? doc._recordedAt : addenda[0]?._recordedAt; if (when && Date.parse(when) - Date.parse(decidedAt) <= win('ai-note-amended')) out.push({ rule: 'ai-note-amended', key: `${t.id}:amended`, ...base, at: when, reachedPatient: 'no', severity: 'none', narrative: `A note that began as an AI draft was ${doc?.docStatus === 'amended' ? 'amended' : 'given an addendum'} after it was signed.` });
      } else if (on('override-after-accept') && later.length) { const first = later[0]; if (Date.parse(first.when.wall) - Date.parse(decidedAt) <= win('override-after-accept')) out.push({ rule: 'override-after-accept', key: `${t.id}:override`, ...base, about: { ...base.about, step: first.id }, at: first.when.wall, reachedPatient: 'caught-before', severity: 'near-miss', narrative: `A record made by accepting an AI proposal was changed by a person ${Math.round((Date.parse(first.when.wall) - Date.parse(decidedAt)) / HOUR)} hours later.` }); }
    }
    const runs = await store.query('Run', { where: (r) => r.agentId && r.endedAt && r.patientRef && r.mode !== 'redteam' });
    if (on('critical-after-ai')) {
      const byPatient = new Map(); for (const r of runs) { if (!byPatient.has(r.patientRef)) byPatient.set(r.patientRef, []); byPatient.get(r.patientRef).push(r); }
      for (const [patientRef, list] of byPatient) {
        const critical = (await store.query('Observation', { patient: patientRef })).filter((o) => isCritical(o) || ((o.code?.coding || []).some((c) => c.code === '88330-6' || /news2?/i.test(c.display || '')) && (o.valueInteger ?? o.valueQuantity?.value) >= 7));
        for (const o of critical) { const at = o.effectiveDateTime || o._recordedAt; const run = list.filter((r) => r.endedAt <= at && Date.parse(at) - Date.parse(r.endedAt) <= win('critical-after-ai') && r.branch === 'main').sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)))[0]; if (run) out.push({ rule: 'critical-after-ai', key: `${run.id}:${o.id}`, about: { run: run.id, resource: `Observation/${o.id}` }, patient: patientRef, at, reachedPatient: 'yes', severity: 'moderate', narrative: `A critical result (${o.code?.coding?.[0]?.display || o.code?.text || 'observation'}) was recorded ${Math.round((Date.parse(at) - Date.parse(run.endedAt)) / HOUR)} hours after the agent finished.` }); }
      }
    }
    if (on('safety-conflict')) for (const s of steps.filter((x) => x.who?.kind === 'agent' && (x.did?.type === 'safety.block' || (x.did?.type === 'envelope.reject' && ['allergy-conflict', 'dose-range', 'unsafe-dose'].includes(x.did.args?.rule))))) { const run = await store.get('Run', s.runId); if (!run?.agentId || run.mode === 'redteam') continue; out.push({ rule: 'safety-conflict', key: `step:${s.id}`, about: { run: run.id, step: s.id }, patient: run.patientRef, at: s.when?.wall, reachedPatient: 'caught-before', severity: 'near-miss', narrative: `The safety checks stopped the agent's write (${(s.did.args?.alerts || [s.did.args?.rule]).map((a) => a?.code || a).filter(Boolean).join(', ') || 'conflict'}).` }); }
    if (on('patient-complaint')) {
      const comms = await store.query('Communication', { where: (c) => c.sender?.reference?.startsWith('Patient/') && COMPLAINT.test(c.payload?.[0]?.contentString || '') });
      for (const c of comms) { const at = c.sent || c._recordedAt; const run = runs.filter((r) => r.patientRef === c.sender.reference && r.endedAt <= at && Date.parse(at) - Date.parse(r.endedAt) <= win('patient-complaint')).sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)))[0]; if (run) out.push({ rule: 'patient-complaint', key: `comm:${c.id}`, about: { run: run.id, resource: `Communication/${c.id}` }, patient: c.sender.reference, at, reachedPatient: 'yes', severity: 'mild', narrative: 'A message from the patient reads as a complaint after an agent worked on their record. The message itself is linked, not copied.' }); }
    }
    return out;
  }
  let sweeping = false;
  /** Opens a possible event for each new candidate. Returns what was opened. */
  async function sweep() {
    if (sweeping) return []; sweeping = true; const opened = [];
    try {
      const have = new Set((await reports.all()).map((d) => d._surv.ruleKey).filter(Boolean));
      for (const c of await candidates()) {
        const rule = RULES.find((r) => r.id === c.rule); const ruleKey = `${rule.id}@${rule.version}:${c.key}`; if (have.has(ruleKey)) continue; have.add(ruleKey);
        const ctx = { actor: { kind: 'human', id: `rule:${rule.id}`, role: 'system' } };
        const doc = await reports.file({ narrative: c.narrative, reachedPatient: c.reachedPatient, severity: c.severity, harm: rule.harm, about: c.about, patient: c.patient, occurredAt: c.at }, ctx, { rule });
        await reports.revise(doc.id, ctx, 'surveillance.rule.open', { rule: rule.id, ruleVersion: rule.version }, (s) => ({ ...s, ruleKey }), `possible event opened by rule ${rule.id}`);
        opened.push({ id: doc.id, caseId: doc._surv.caseId, rule: rule.id });
      }
    } finally { sweeping = false; }
    return opened;
  }
  /** Each rule with its own counts and rate, beside the reported rate for the same agents. */
  async function ruleCounts() {
    const rows = await reports.reportRows(); const uses = (await reports.exposure()).length; const cfg = await settings();
    return RULES.map((r) => { const mine = rows.filter((x) => x.rule === r.id); return { ...r, windowHours: cfg.windows[r.id], on: !cfg.off.includes(r.id), opened: mine.length, confirmed: mine.filter((x) => x.status === 'confirmed-ai').length, notAi: mine.filter((x) => x.status === 'not-ai').length, ...rate(mine.length, uses) }; });
  }

  // ---------- drift monitors, per agent version ----------
  const share = (list) => { const t = {}; for (const x of list) t[x] = (t[x] || 0) + 1; const n = list.length || 1; return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v / n])); };
  /** Population stability index between two categorical distributions (0 none; above 0.2 a real shift). */
  const psi = (a, b) => { const keys = new Set([...Object.keys(a), ...Object.keys(b)]); let s = 0; for (const k of keys) { const p = Math.max(a[k] || 0, 0.001); const q = Math.max(b[k] || 0, 0.001); s += (q - p) * Math.log(q / p); } return Math.round(s * 1000) / 1000; };
  const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const sd = (xs) => { const m = mean(xs); return xs.length > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)) : null; };
  const zShift = (ref, cur) => { const m = mean(ref); const s = sd(ref); const c = mean(cur); if (m == null || c == null || !s) return null; return Math.round(((c - m) / (s / Math.sqrt(cur.length))) * 100) / 100; };
  /** Compares the newest half of an agent version's uses with the older half. */
  async function drift(agentId, version = null) {
    const rows = (await reports.exposure()).filter((r) => r.keys.agent === agentId && (!version || r.keys.version === String(version))).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const versions = [...new Set(rows.map((r) => r.keys.version))]; const out = [];
    for (const v of versions) {
      const mine = rows.filter((r) => r.keys.version === v); const half = Math.floor(mine.length / 2); const ref = mine.slice(0, half); const cur = mine.slice(half);
      const runsById = new Map((await store.query('Run', { where: (r) => r.agentId === agentId && String(r.version) === v })).map((r) => [r.id, r]));
      const stepsOf = async (r) => (await store.query('TraceStep', { groupKey: r.run })).filter((s) => s.who?.kind === 'agent');
      const seen = async (list) => { const xs = []; for (const r of list.slice(-200)) xs.push(new Set((await stepsOf(r)).flatMap((s) => (s.saw?.resources || []).map((x) => x.ref))).size); return xs; };
      const tasks = await store.query('Task', { where: (t) => runsById.has(taskIn(t, 'run')) && taskOut(t, 'decision') });
      const decided = (list) => { const ids = new Set(list.map((r) => r.run)); return tasks.filter((t) => ids.has(taskIn(t, 'run'))); };
      const accept = (list) => { const d = decided(list); return d.length ? d.filter((t) => taskOut(t, 'decision') === 'accepted').length / d.length : null; };
      const edits = (list) => decided(list).map((t) => { try { return JSON.parse(taskOut(t, 'edit-diff') || 'null')?.size ?? 0; } catch { return 0; } });
      const conf = (list) => list.map((r) => runsById.get(r.run)?.result?.confidence).filter((x) => typeof x === 'number');
      const missing = (list) => (list.length ? list.filter((r) => Object.values(r.keys).includes('unknown')).length / list.length : null);
      const evalRuns = [...runsById.values()].filter((r) => r.result?.kind === 'regression' || r.trigger?.kind === 'regression' || (r.caseId && r.result?.score != null)).sort((a, b) => String(a.endedAt).localeCompare(String(b.endedAt)));
      const scores = evalRuns.map((r) => r.result?.score ?? r.result?.passRate).filter((x) => typeof x === 'number'); const eh = Math.floor(scores.length / 2);
      const inputs = { caseMix: psi(share(ref.map((r) => r.keys.dxGroup)), share(cur.map((r) => r.keys.dxGroup))), encounterMix: psi(share(ref.map((r) => r.keys.encounterType)), share(cur.map((r) => r.keys.encounterType))), recordsSeenShift: zShift(await seen(ref), await seen(cur)), missingDataBefore: missing(ref), missingDataNow: missing(cur) };
      const outputs = { acceptanceBefore: accept(ref), acceptanceNow: accept(cur), editSizeShift: zShift(edits(ref), edits(cur)), confidenceShift: zShift(conf(ref), conf(cur)) };
      const performance = { evalRuns: scores.length, before: mean(scores.slice(0, eh)), now: mean(scores.slice(eh)), note: scores.length < 4 ? 'Too few runs on the frozen evaluation split to compare. Re-run it on a schedule (Compare versions).' : null };
      const flags = []; if (mine.length < 20) flags.push('small-numbers'); if (inputs.caseMix > 0.2) flags.push('case-mix'); if (inputs.encounterMix > 0.2) flags.push('encounter-mix'); if (Math.abs(inputs.recordsSeenShift ?? 0) > 3) flags.push('input-size');
      if (outputs.acceptanceBefore != null && outputs.acceptanceNow != null && Math.abs(outputs.acceptanceNow - outputs.acceptanceBefore) > 0.15) flags.push('acceptance-rate'); if (Math.abs(outputs.editSizeShift ?? 0) > 3) flags.push('edit-size'); if (Math.abs(outputs.confidenceShift ?? 0) > 3) flags.push('confidence');
      if (performance.before != null && performance.now != null && performance.before - performance.now > 0.05) flags.push('eval-performance');
      out.push({ agent: agentId, version: v, uses: mine.length, comparing: { earlier: ref.length, recent: cur.length }, inputs, outputs, performance, flags });
    }
    return out;
  }

  // ---------- verifier agents ----------
  /** Outputs a verifier should look at: finished runs of other agents it has not reported on yet, by its scope. */
  async function verifierQueue(verifier, { limit = 50 } = {}) {
    const scope = verifier.verifier?.scope || 'all'; const sample = Math.min(1, Math.max(0.01, Number(verifier.verifier?.sampleRate) || 0.2));
    const reviewed = new Set((await reports.all()).filter((d) => d._surv.source.kind === 'agent' && d._surv.source.agent === verifier.id).map((d) => d._surv.context.run));
    const seen = new Set((await store.query('SurvReview', { where: (r) => r.verifier === verifier.id })).map((r) => r.run));
    const HIGH = new Set(['clinical-workup', 'order-entry', 'prescribe', 'triage-message', 'draft-report']);
    const pickSample = (id) => { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return (h % 1000) / 1000 < sample; };
    const agentsById = new Map((await store.query('Agent')).map((a) => [a.id, a]));
    return (await store.query('Run', { where: (r) => r.agentId && r.endedAt && r.agentId !== verifier.id && r.mode !== 'redteam' }))
      .filter((r) => !reviewed.has(r.id) && !seen.has(r.id) && (scope === 'all' || (scope === 'sample' && pickSample(r.id)) || (scope === 'high-risk' && HIGH.has(agentsById.get(r.agentId)?.capability))))
      .sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt))).slice(0, limit)
      .map((r) => ({ run: r.id, agent: r.agentId, version: String(r.version), taskType: r.result?.kind || agentsById.get(r.agentId)?.capability || r.mode, endedAt: r.endedAt, patient: r.patientRef, output: r.result?.summary ?? null, confidence: r.result?.confidence ?? null }));
  }
  /** How often a verifier's reports were confirmed by a person, of those a person has decided. */
  async function verifierPrecision() {
    const verifiers = (await store.query('Agent')).filter((a) => a.verifier?.enabled); const docs = await reports.all();
    return verifiers.map((v) => { const mine = docs.filter((d) => d._surv.source.kind === 'agent' && d._surv.source.agent === v.id); const confirmed = mine.filter((d) => d._surv.status === 'confirmed-ai').length; const notAi = mine.filter((d) => d._surv.status === 'not-ai').length; const decided = confirmed + notAi;
      return { agent: v.id, name: v.name, version: v.version, scope: v.verifier.scope, filed: mine.length, confirmed, notAi, waiting: mine.length - decided - mine.filter((d) => ['duplicate', 'closed'].includes(d._surv.status)).length, precision: decided ? Math.round((confirmed / decided) * 1000) / 1000 : null, trusted: decided >= 10 ? confirmed / decided >= 0.7 : null }; });
  }
  return { settings, saveSettings, candidates, sweep, ruleCounts, drift, verifierQueue, verifierPrecision };
}
