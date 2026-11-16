// Surveillance and Reporting: the reports themselves.
// A report is a FHIR R4 AdverseEvent (actuality "actual" or "potential", so near misses count) with extensions
// for the AI context. A follow-up or a triage step is a new version of the same record, never an overwrite.
// Three sources file through the same door: people, automatic rules and verifier agents.
// The denominator (exposure) is read from the log: every finished agent run is one use.
// Free text (what happened, the right action, patient words) lives only in the report. It is never written
// to the trace or to telemetry: log entries carry the case number and coded fields only.
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';
import { RESTRICTED_URL } from '../../platform/server/datasets.mjs';
import { completeness, rate } from './stats.mjs';

export const EXT = 'urn:hospital-desktop:surveillance';
export const CASE_SYSTEM = 'urn:hospital-desktop:surveillance:case';
export const HARMS = { wrong: 'Wrong', harmful: 'Harmful', biased: 'Biased', hallucinated: 'Hallucinated', unsafe: 'Unsafe', omitted: 'Omitted something', privacy: 'Privacy', workflow: 'Workflow or usability', other: 'Other' };
export const SEVERITIES = ['near-miss', 'none', 'mild', 'moderate', 'severe', 'life-threatening', 'death'];
export const REACHED = { yes: 'Yes', no: 'No', 'caught-before': 'Caught before it reached the patient' };
export const STATUSES = { new: 'New', 'needs-info': 'Needs information', 'under-review': 'Under review', 'confirmed-ai': 'Confirmed AI-related', 'not-ai': 'Not AI-related', duplicate: 'Duplicate', closed: 'Closed' };
export const CAUSALITY = ['certain', 'probable', 'possible', 'unlikely', 'unassessable'];
export const DUE_DAYS = { death: 1, 'life-threatening': 1, severe: 3, moderate: 7, mild: 30, none: 30, 'near-miss': 14 };
export const SUBGROUP_DIMS = ['role', 'specialty', 'site', 'department', 'ageBand', 'sex', 'language', 'dxGroup', 'encounterType'];
export const DIMS = ['agent', 'version', 'taskType', ...SUBGROUP_DIMS];
export const PATIENT_CHOICES = { 'wrong-information': 'It told me something that was wrong', 'did-not-understand': 'It did not understand me', 'felt-unsafe': 'It suggested something that felt unsafe', 'privacy': 'It shared or asked for something private', 'upset-me': 'It upset or worried me', other: 'Something else' };
export const PATIENT_EFFECTS = { none: 'It did not affect me', worried: 'It worried me', delayed: 'It delayed my care', harmed: 'It harmed my health', other: 'Something else' };

const DX_GROUPS = [['A', 'B', 'Infections'], ['C', 'D4', 'Cancer and tumours'], ['D5', 'D9', 'Blood'], ['E', 'E', 'Endocrine and metabolic'], ['F', 'F', 'Mental health'], ['G', 'G', 'Nervous system'], ['H', 'H', 'Eye and ear'], ['I', 'I', 'Circulatory'], ['J', 'J', 'Respiratory'], ['K', 'K', 'Digestive'], ['L', 'L', 'Skin'], ['M', 'M', 'Musculoskeletal'], ['N', 'N', 'Kidney and urinary'], ['O', 'P', 'Pregnancy and newborn'], ['Q', 'Q', 'Congenital'], ['R', 'R', 'Symptoms and signs'], ['S', 'T', 'Injury and poisoning'], ['V', 'Z', 'Other']];
export function dxGroup(code) { const c = String(code || '').toUpperCase(); if (!/^[A-Z]\d/.test(c)) return 'unknown'; return (DX_GROUPS.find(([lo, hi]) => c.slice(0, lo.length) >= lo && c.slice(0, hi.length) <= hi) || [0, 0, 'Other'])[2]; }
export function ageBand(birthDate, at) { if (!birthDate) return 'unknown'; const y = (Date.parse(at) - Date.parse(birthDate)) / (365.25 * 86400000); return !Number.isFinite(y) ? 'unknown' : y < 18 ? '0-17' : y < 40 ? '18-39' : y < 65 ? '40-64' : y < 80 ? '65-79' : '80+'; }
const text = (v, max) => String(v ?? '').trim().slice(0, max);
const ext = (name, value) => ({ url: `${EXT}:${name}`, ...value });
const strip = ({ _seq, ...d }) => d;

export function createReports({ store, agents }) {
  // ---------- subgroup keys ----------
  /** The patient's subgroup keys, read from the chart as it was on the branch at that time. */
  async function patientKeys(patientRef, { branch = 'main', at = null } = {}) {
    const none = { ageBand: 'unknown', sex: 'unknown', language: 'unknown', dxGroup: 'unknown', encounterType: 'unknown', restricted: false };
    const id = String(patientRef || '').split('/').pop(); if (!id) return none;
    const opts = { branch }; const p = await store.get('Patient', id, opts); if (!p) return none;
    const when = at || store.now();
    const conditions = (await store.query('Condition', { patient: `Patient/${id}` }, opts)).sort((a, b) => String(a.recordedDate || a._recordedAt).localeCompare(String(b.recordedDate || b._recordedAt)));
    const primary = conditions.find((c) => (c.category || []).some((x) => (x.coding || []).some((y) => y.code === 'encounter-diagnosis'))) || conditions[0];
    const icd = (primary?.code?.coding || []).find((c) => /icd/i.test(c.system || ''))?.code || primary?.code?.coding?.[0]?.code;
    const enc = (await store.query('Encounter', { patient: `Patient/${id}` }, opts)).sort((a, b) => String(b.period?.start || '').localeCompare(String(a.period?.start || '')))[0];
    return { ageBand: ageBand(p.birthDate, when), sex: p.gender || 'unknown', language: p.communication?.[0]?.language?.coding?.[0]?.code || p.communication?.[0]?.language?.text || 'unknown', dxGroup: dxGroup(icd), encounterType: enc?.class?.code || 'unknown', restricted: (p.extension || []).some((e) => e.url === RESTRICTED_URL) };
  }
  /** Who was using the agent: read from how the run was started. Unknown stays "unknown"; nothing is guessed. */
  const userKeys = (run) => ({ role: run?.trigger?.role || 'unknown', specialty: run?.trigger?.specialty || run?.context?.specialty || 'unknown', site: run?.trigger?.site || run?.context?.site || 'unknown', department: run?.trigger?.department || run?.context?.department || 'unknown' });
  const taskTypeOf = (run, agent) => run?.result?.kind || agent?.capability || run?.mode || 'unknown';

  // ---------- exposure: the denominator ----------
  let exposureCache = null;
  /** One row per finished agent run: { keys, uses: 1, at, run, mode }. Each agent output is one use. */
  async function exposure() {
    const mark = await store.changeMark(['Run']);
    if (exposureCache?.mark === mark) return exposureCache.rows;
    const runs = await store.query('Run', { where: (r) => r.agentId && r.endedAt && r.id !== LIVE_RUN_ID });
    const agentsById = new Map((await store.query('Agent')).map((a) => [a.id, a])); const pcache = new Map(); const rows = [];
    for (const r of runs) {
      const pk = `${r.patientRef}|${r.branch}`; if (!pcache.has(pk)) pcache.set(pk, await patientKeys(r.patientRef, { branch: r.branch, at: r.startedAt }));
      const { restricted, ...pkeys } = pcache.get(pk);
      rows.push({ keys: { agent: r.agentId, version: String(r.version ?? ''), taskType: taskTypeOf(r, agentsById.get(r.agentId)), ...userKeys(r), ...pkeys }, uses: 1, at: r.endedAt, run: r.id, mode: r.mode, restricted });
    }
    exposureCache = { mark, rows }; return rows;
  }

  // ---------- the AI context of a report ----------
  const taskInput = (task, name) => (task.input || []).find((i) => i.type?.text === name)?.valueString ?? null;
  const taskOutput = (task, name) => (task.output || []).find((i) => i.type?.text === name);
  /** Finds the run a report is about, from whatever the reporter was looking at. */
  async function resolveAbout(about = {}) {
    let run = about.run ? await store.get('Run', String(about.run)) : null; let step = null; let proposal = null; let resource = null;
    if (about.step) { step = (await store.query('TraceStep', { where: (s) => s.id === String(about.step) }))[0] || null; if (step && !run) run = await store.get('Run', step.runId); }
    if (about.proposal) { const all = await store.query('Task', { where: (t) => t.id === String(about.proposal) }, { branch: about.branch || 'main' }); proposal = all[0] || (await store.query('Task', { where: (t) => t.id === String(about.proposal) }))[0] || null; if (proposal && !run && taskInput(proposal, 'run')) run = await store.get('Run', taskInput(proposal, 'run')); }
    if (about.resource && /^[A-Za-z]+\/[A-Za-z0-9\-.]+$/.test(about.resource)) {
      resource = String(about.resource);
      if (!run) { const [type, id] = resource.split('/'); const wrote = (await store.query('TraceStep', { where: (s) => s.who?.kind === 'agent' && s.did?.args?.type === type && s.did?.args?.id === id })).sort((a, b) => b._seq - a._seq)[0]; if (wrote) { step = step || wrote; run = await store.get('Run', wrote.runId); } }
    }
    return { run: run && run.agentId ? run : null, step, proposal, resource };
  }
  async function aiContext(about, patientRefIn) {
    const { run, step, proposal, resource } = await resolveAbout(about);
    const agent = run ? await store.get('Agent', run.agentId) : about.agent ? await store.get('Agent', String(about.agent)) : null;
    const steps = run ? (await store.query('TraceStep', { groupKey: run.id })).filter((s) => s.who?.kind === 'agent').sort((a, b) => a._seq - b._seq) : [];
    const saw = new Map(); for (const s of steps) for (const r of s.saw?.resources || []) if (r?.ref) saw.set(r.ref, r.versionId ?? null);
    const decision = proposal ? taskOutput(proposal, 'decision')?.valueString ?? null : null; const diff = proposal ? taskOutput(proposal, 'edit-diff')?.valueString ?? null : null; let edit = null; try { edit = diff ? JSON.parse(diff) : null; } catch { edit = null; }
    const patientRef = patientRefIn || run?.patientRef || proposal?.for?.reference || null;
    const pk = await patientKeys(patientRef, { branch: run?.branch || 'main', at: run?.startedAt });
    const { restricted, ...patientGroup } = pk;
    return {
      agent: agent?.id ?? run?.agentId ?? null, version: run ? String(run.version ?? '') : agent ? String(agent.version) : null, policyHash: run?.policyHash ?? agent?.policyHash ?? null,
      model: run?.record?.model ?? agent?.adapter?.model ?? agent?.modelName ?? null, provider: run?.record?.provider ?? agent?.adapter?.provider ?? null,
      run: run?.id ?? null, mode: run?.mode ?? null, branch: run?.branch ?? null, asOf: run?.asOf ?? run?.startedAt ?? null, condition: run?.condition ?? null, seed: run?.seed ?? run?.context?.seed ?? null, caseId: run?.caseId ?? null,
      taskType: taskTypeOf(run, agent), subject: run?.subject ?? null,
      steps: steps.slice(0, 400).map((s) => s.id), focusStep: step?.id ?? null, saw: [...saw].slice(0, 400).map(([ref, versionId]) => ({ ref, versionId })),
      reasoning: steps.map((s) => s.why).filter(Boolean).slice(-20), output: text(run?.result?.summary ?? (proposal ? taskInput(proposal, 'proposal') : ''), 4000) || null, confidence: run?.result?.confidence ?? null,
      proposal: proposal?.id ?? null, resource, humanAction: proposal ? { decision: decision || (proposal.status === 'requested' ? 'pending' : proposal.status), edited: Boolean(edit), editSize: edit?.size ?? null, diff: edit } : null,
      keys: { ...userKeys(run), ...patientGroup }, patient: patientRef, restricted,
    };
  }

  // ---------- the record ----------
  async function nextCase(tx) { const n = (await tx.query('AdverseEvent')).length + 1; return `AE-${String(n).padStart(6, '0')}`; }
  /** The stored document: FHIR fields first, then the extensions; `_surv` mirrors the coded fields for fast aggregation. */
  function toResource(d) {
    const s = d.surv;
    return {
      resourceType: 'AdverseEvent', id: d.id, identifier: { system: CASE_SYSTEM, value: s.caseId },
      actuality: s.reachedPatient === 'yes' ? 'actual' : 'potential',
      category: s.harm ? [{ coding: [{ system: `${EXT}:harm`, code: s.harm, display: HARMS[s.harm] }] }] : undefined,
      event: { text: s.harm ? `AI output: ${HARMS[s.harm].toLowerCase()}` : 'Problem with an AI output' },
      ...(s.context.patient ? { subject: { reference: s.context.patient } } : { subject: { display: 'No patient (the report is about the agent)' } }),
      date: s.occurredAt, detected: s.filedAt, recordedDate: s.filedAt,
      seriousness: { coding: [{ system: `${EXT}:severity`, code: s.severity }] },
      outcome: s.outcome ? { text: s.outcome } : undefined,
      recorder: s.source.kind === 'human' ? { display: s.source.by } : { display: s.source.kind === 'agent' ? `Agent ${s.source.agent} v${s.source.version} (agent-reported)` : `Rule ${s.source.rule} v${s.source.version} (detected automatically)` },
      suspectEntity: s.context.agent ? [{ instance: { identifier: { system: 'urn:hospital-desktop:agent', value: `${s.context.agent}@${s.context.version}` }, display: `Agent ${s.context.agent} v${s.context.version}` }, ...(s.causality ? { causality: [{ assessment: { text: s.causality.level }, productRelatedness: s.causality.reason || undefined, author: { display: s.causality.by } }] } : {}) }] : undefined,
      extension: [
        ext('source', { extension: Object.entries(s.source).map(([k, v]) => ({ url: k, valueString: String(v) })) }), ext('reached-patient', { valueCode: s.reachedPatient }), ext('status', { valueCode: s.status }),
        ext('narrative', { valueString: s.narrative }), ...(s.rightAction ? [ext('right-action', { valueString: s.rightAction })] : []), ...(s.reliedOn != null ? [ext('relied-on', { valueBoolean: s.reliedOn })] : []), ...(s.whatNext ? [ext('what-next', { valueString: s.whatNext })] : []),
        ext('completeness', { valueDecimal: s.completeness.score }), ext('ai-context', { valueString: JSON.stringify(s.context) }), ext('trace-steps', { extension: s.context.steps.slice(0, 50).map((id) => ({ url: 'step', valueString: id })) }),
        ...(s.followUps.length ? [ext('follow-ups', { valueString: JSON.stringify(s.followUps) })] : []), ...(s.reproduced ? [ext('reproduced', { valueString: JSON.stringify(s.reproduced) })] : []),
      ],
      _patient: s.context.patient || undefined, _surv: s,
    };
  }
  const present = (doc, { forPatient = false } = {}) => {
    const s = doc._surv; const base = { id: doc.id, caseId: s.caseId, version: Number(doc.meta?.versionId) || 1, status: s.status, statusLabel: STATUSES[s.status], filedAt: s.filedAt, severity: s.severity, reachedPatient: s.reachedPatient, actuality: doc.actuality, harm: s.harm, followUps: s.followUps.map((f) => (forPatient ? { at: f.at, kind: f.kind, text: f.kind === 'question' || f.by === s.source.by ? f.text : null, status: f.status || null } : f)), fixedIn: s.fixedIn || null, dueAt: s.dueAt };
    if (forPatient) return { ...base, narrative: s.narrative, patientChoice: s.patientChoice || null, patientEffect: s.patientEffect || null };
    return { ...base, narrative: s.narrative, rightAction: s.rightAction, reliedOn: s.reliedOn, whatNext: s.whatNext, outcome: s.outcome, attachments: s.attachments, source: s.source, sourceLabel: s.source.kind === 'human' ? `Reported by a person (${s.source.role})` : s.source.kind === 'agent' ? 'Agent-reported' : 'Detected automatically', completeness: s.completeness, context: s.context, causality: s.causality || null, duplicateOf: s.duplicateOf || null, triage: s.triage, reproduced: s.reproduced || null, reasoning: s.reasoning || null, confidence: s.confidence ?? null, restricted: Boolean(s.context.restricted), actions: s.actions || [], patientChoice: s.patientChoice || null, patientEffect: s.patientEffect || null };
  };
  const features = (doc) => { const s = doc._surv; const c = s.context; return { id: doc.id, at: s.filedAt, f: { agent: c.agent, version: c.version, harm: s.harm, taskType: c.taskType, patientGroup: `${c.keys.ageBand}|${c.keys.sex}|${c.keys.dxGroup}`, role: c.keys.role, specialty: c.keys.specialty, site: c.keys.site, inputs: (c.saw || []).map((x) => x.ref.split('/')[0]) }, text: s.narrative }; };
  const all = async () => (await store.query('AdverseEvent')).filter((d) => d._surv);
  async function get(idOrCase) { const d = (await store.get('AdverseEvent', idOrCase)) || (await all()).find((x) => x._surv.caseId === idOrCase); if (!d || !d._surv) throw new HttpError(404, `No report ${idOrCase}`); return d; }

  // ---------- filing ----------
  /**
   * Files one report. source is decided by who is calling, never by the body:
   * a person (their role), an automatic rule (internal callers pass `rule`), or a verifier agent.
   */
  async function file(body, ctx, { rule = null } = {}) {
    const isAgent = ctx.actor.kind === 'agent'; const isPatient = ctx.actor.role === 'patient';
    const narrative = text(body?.narrative ?? body?.whatHappened, 4000); if (!narrative) throw new HttpError(422, 'Say what happened');
    const reachedPatient = body?.reachedPatient ?? (isPatient ? 'yes' : null); if (!REACHED[reachedPatient]) throw new HttpError(422, `reachedPatient must be one of ${Object.keys(REACHED).join(', ')}`);
    const severity = body?.severity ?? (isPatient ? ({ none: 'none', worried: 'mild', delayed: 'moderate', harmed: 'severe' }[body?.patientEffect] || 'mild') : null); if (!SEVERITIES.includes(severity)) throw new HttpError(422, `severity must be one of ${SEVERITIES.join(', ')}`);
    const harm = body?.harm ?? (isPatient ? ({ 'wrong-information': 'wrong', 'did-not-understand': 'workflow', 'felt-unsafe': 'unsafe', privacy: 'privacy', 'upset-me': 'harmful' }[body?.patientChoice] || 'other') : null); if (harm != null && !HARMS[harm]) throw new HttpError(422, `harm must be one of ${Object.keys(HARMS).join(', ')}`);
    let source;
    if (rule) source = { kind: 'automatic', rule: rule.id, version: String(rule.version) };
    else if (isAgent) {
      const verifier = ctx.agent ?? await store.get('Agent', ctx.actor.id);
      if (!verifier?.verifier?.enabled) throw new HttpError(403, 'Only an agent given the Verifier role may file reports');
      source = { kind: 'agent', agent: verifier.id, version: String(verifier.version) };
    } else source = { kind: 'human', role: ctx.actor.role, by: ctx.actor.id };
    const patientRef = isPatient ? (body?.patient ? `Patient/${String(body.patient).split('/').pop()}` : null) : body?.patient ? `Patient/${String(body.patient).split('/').pop()}` : null;
    const context = await aiContext(body?.about || {}, patientRef);
    // A verifier never reviews its own outputs or its own version.
    if (source.kind === 'agent' && context.agent === source.agent) throw new HttpError(403, 'A verifier cannot report on its own outputs or its own version');
    if (source.kind === 'agent' && !context.run) throw new HttpError(422, 'A verifier report must name the run it reviewed (about.run)');
    const filedAt = store.now(); const id = randomUUID();
    const fields = { narrative, reachedPatient, severity, harm, rightAction: text(body?.rightAction, 2000) || null, reliedOn: typeof body?.reliedOn === 'boolean' ? body.reliedOn : null, whatNext: text(body?.whatNext, 2000) || null, outcome: text(body?.outcome, 500) || null,
      attachments: (Array.isArray(body?.attachments) ? body.attachments : []).slice(0, 5).map((a) => ({ title: text(a?.title, 120), contentType: text(a?.contentType, 80), data: typeof a?.data === 'string' ? a.data.slice(0, 400000) : null })).filter((a) => a.data),
      patientChoice: isPatient && PATIENT_CHOICES[body?.patientChoice] ? body.patientChoice : null, patientEffect: isPatient && PATIENT_EFFECTS[body?.patientEffect] ? body.patientEffect : null,
      reasoning: source.kind !== 'human' ? text(body?.reasoning, 2000) || null : null, confidence: source.kind !== 'human' && Number.isFinite(Number(body?.confidence)) ? Math.min(1, Math.max(0, Number(body.confidence))) : null };
    const saved = await store.transaction(async (tx) => {
      const caseId = await nextCase(tx);
      const surv = { caseId, source, ...fields, status: 'new', occurredAt: body?.occurredAt ? new Date(body.occurredAt).toISOString() : context.asOf || filedAt, filedAt, dueAt: new Date(Date.parse(filedAt) + DUE_DAYS[severity] * 86400000).toISOString(), context, followUps: [], triage: [], actions: [],
        completeness: completeness({ narrative, reachedPatient, severity, harm, agent: context.agent, version: context.version, run: context.run, steps: context.steps, outcome: fields.outcome, whatNext: fields.whatNext, rightAction: fields.rightAction }) };
      const doc = await tx.save('AdverseEvent', toResource({ id, surv }), { updatedBy: source.kind === 'human' ? ctx.actor.role : source.kind });
      // The log gets the case number and coded fields only: no free text.
      await recordAction(tx, { runId: context.run ?? LIVE_RUN_ID, actor: rule ? { kind: 'human', id: `rule:${rule.id}`, role: 'system' } : ctx.actor, kind: 'create', action: 'surveillance.report.file', args: { case: caseId, id, source: source.kind, rule: source.rule ?? null, verifier: source.kind === 'agent' ? source.agent : null, severity, reachedPatient, harm, agent: context.agent, version: context.version, taskType: context.taskType, steps: context.steps.length, keys: context.keys, completeness: surv.completeness.score }, branch: 'main', entityRef: `AdverseEvent/${id}`, versionId: doc.meta.versionId, patientRef: context.patient, description: `problem report ${caseId} filed (${source.kind})`, resources: context.focusStep ? [{ ref: `TraceStep/${context.focusStep}` }] : [] });
      return doc;
    });
    return saved;
  }
  /** Changes a report by writing a new version. fn receives the current coded state and returns the next. */
  async function revise(id, ctx, action, args, fn, description) {
    return store.transaction(async (tx) => {
      const cur = await tx.get('AdverseEvent', id); if (!cur?._surv) throw new HttpError(404, `No report ${id}`);
      const surv = await fn(JSON.parse(JSON.stringify(cur._surv)), tx);
      const doc = await tx.save('AdverseEvent', toResource({ id, surv }), { updatedBy: ctx.actor.kind === 'agent' ? 'agent' : ctx.actor.role });
      await recordAction(tx, { runId: surv.context.run ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'update', action, args: { case: surv.caseId, id, ...args }, branch: 'main', entityRef: `AdverseEvent/${id}`, versionId: doc.meta.versionId, patientRef: surv.context.patient, description: description || action });
      return doc;
    });
  }
  const isReporter = (doc, ctx) => { const s = doc._surv.source; return s.kind === 'human' ? s.by === ctx.actor.id && s.role === ctx.actor.role : s.kind === 'agent' ? ctx.actor.kind === 'agent' && s.agent === ctx.actor.id : false; };
  const reviewer = (ctx) => { if (ctx.actor.kind !== 'human' || ctx.actor.role === 'patient') throw new HttpError(403, 'Triage is done by staff; agents and patients cannot triage or confirm reports'); };

  /** Reporter adds information, or a reviewer sends the reporter a question. Either way: a new version. */
  async function followUp(id, body, ctx) {
    const doc = await get(id); const kind = body?.kind === 'question' ? 'question' : 'information'; const words = text(body?.text, 4000); if (!words) throw new HttpError(422, 'text is required');
    if (kind === 'question') reviewer(ctx); else if (!isReporter(doc, ctx) && (ctx.actor.kind !== 'human' || ctx.actor.role === 'patient')) throw new HttpError(403, 'Only the person who filed this report, or staff, can add to it');
    return revise(doc.id, ctx, 'surveillance.report.follow-up', { kind }, (s) => { s.followUps.push({ at: store.now(), by: ctx.actor.id, role: ctx.actor.role, kind, text: words }); if (kind === 'question') s.status = 'needs-info'; else if (s.status === 'needs-info') s.status = 'under-review'; return s; }, `follow-up (${kind}) on a problem report`);
  }
  /** Triage: status, causality (adapted WHO-UMC) with reasons, duplicate merge (a person confirms each), "fixed in version". */
  async function triage(id, body, ctx) {
    reviewer(ctx); const doc = await get(id);
    if (body?.status && !STATUSES[body.status]) throw new HttpError(422, `status must be one of ${Object.keys(STATUSES).join(', ')}`);
    if (body?.causality && !CAUSALITY.includes(body.causality.level)) throw new HttpError(422, `causality.level must be one of ${CAUSALITY.join(', ')}`);
    if (body?.causality && !text(body.causality.reason, 1000)) throw new HttpError(422, 'Give the reasons for the causality assessment');
    let original = null; if (body?.status === 'duplicate') { if (!body.duplicateOf) throw new HttpError(422, 'Name the report this one duplicates (duplicateOf)'); original = await get(String(body.duplicateOf)); if (original.id === doc.id) throw new HttpError(422, 'A report cannot duplicate itself'); }
    return revise(doc.id, ctx, 'surveillance.report.triage', { status: body?.status ?? null, causality: body?.causality?.level ?? null, duplicateOf: original?._surv.caseId ?? null, fixedIn: body?.fixedIn ?? null }, (s) => {
      const before = s.status;
      if (body?.status) s.status = body.status; if (original) s.duplicateOf = { id: original.id, caseId: original._surv.caseId };
      if (body?.causality) s.causality = { level: body.causality.level, reason: text(body.causality.reason, 1000), by: ctx.actor.id, at: store.now() };
      if (body?.fixedIn) s.fixedIn = text(body.fixedIn, 40);
      s.triage.push({ at: store.now(), by: ctx.actor.id, from: before, to: s.status, causality: body?.causality?.level ?? null, note: text(body?.note, 1000) || null });
      s.followUps.push({ at: store.now(), by: ctx.actor.id, role: ctx.actor.role, kind: 'status', status: body?.fixedIn ? `fixed in version ${text(body.fixedIn, 40)}` : STATUSES[s.status].toLowerCase(), text: null });
      return s;
    }, 'problem report triaged');
  }

  // ---------- counting ----------
  /** Reports as rows for counting: one per report that is not a duplicate, with the same keys as exposure. */
  async function reportRows({ includeRestricted = true } = {}) {
    return (await all()).filter((d) => d._surv.status !== 'duplicate' && (includeRestricted || !d._surv.context.restricted)).map((d) => { const s = d._surv; const c = s.context; return { id: d.id, caseId: s.caseId, at: s.filedAt, source: s.source.kind, rule: s.source.rule ?? null, harm: s.harm || 'other', severity: s.severity, status: s.status, restricted: Boolean(c.restricted), run: c.run, keys: { agent: c.agent || 'unknown', version: c.version || 'unknown', taskType: c.taskType || 'unknown', ...c.keys } }; });
  }
  const match = (keys, filter) => Object.entries(filter || {}).every(([k, v]) => v == null || v === '' || keys[k] === v);
  /** Events and uses for one filter, per source, always per 1,000 uses. */
  async function rates(filter = {}, { harm = null, from = null, to = null } = {}) {
    const inTime = (at) => (!from || at >= from) && (!to || at <= to);
    const uses = (await exposure()).filter((r) => match(r.keys, filter) && inTime(r.at)).length;
    const reports = (await reportRows()).filter((r) => match(r.keys, filter) && (!harm || r.harm === harm) && inTime(r.at));
    const by = (src) => rate(reports.filter((r) => r.source === src).length, uses);
    // The same run reported twice (by a person and by a rule, say) is one event in the combined count.
    const distinct = new Set(reports.map((r) => r.run || r.id)).size;
    const human = by('human'); const automatic = by('automatic');
    return { filter, harm, uses, human, automatic, agent: by('agent'), combined: rate(distinct, uses),
      // Passive (reported by people) against active (detected by rules): the gap is the under-reporting estimate.
      underReporting: automatic.events > 0 ? { reportedPer1000: human.per1000, detectedPer1000: automatic.per1000, shareNotReported: Math.max(0, Math.round((1 - human.events / automatic.events) * 1000) / 1000) } : null };
  }

  return { file, followUp, triage, revise, get, all, present, features, exposure, reportRows, rates, patientKeys, aiContext, isReporter, reviewer, toResource, match, strip };
}
