// Research data model (plan-master task 5): studies, study links, reviews,
// corrections, redactions, frozen dataset snapshots with exports, and replay.
// The log is the record: nothing here edits a TraceStep, an AuditEvent or a
// record version; every decision is a new record pointing at its target, and
// every one is itself a logged action.
import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { GRADES, allGrades, settle } from './grades.mjs';
import { redactText } from '../../platform/server/redact.mjs';
import { datasetsForPatients } from '../../platform/server/datasets.mjs';
import { rewardConfig } from './grader.mjs';
import { describeAction } from '../web/agent-ops/describe.js';
import { pseudonym } from '../../platform/server/pseudonym.mjs';
import { interactionStats } from './turns.mjs';
import { READER_COLUMNS } from '../../data-annotation/server/reader-studies.mjs';
export { pseudonym };

export const LINK_KINDS = ['run', 'case', 'recording', 'project', 'snapshot'];
// The three Agent Dashboard modes. A study belongs to one; studies made before modes count as Evaluate Agent.
export const STUDY_MODES = ['evaluate', 'rl', 'annotate'];
export const modeOf = (study) => (STUDY_MODES.includes(study?.mode) ? study.mode : 'evaluate');
export const DECISIONS = ['include', 'exclude', 'needs-fix'];
export const EXPORT_TYPES = ['steps', 'best-attempts', 'pairs', 'readers', 'preferences'];
// Expert preference pairs: one row per judgement, held-out tasks never.
export const PREFERENCE_COLUMNS = ['snapshot', 'pair', 'task', 'taskText', 'runA', 'runB', 'answerA', 'answerB', 'choice', 'reason', 'judge', 'at'];
export const FORMATS = ['jsonl', 'json', 'csv'];
export const STEP_COLUMNS = ['snapshot', 'run', 'attempt', 'step', 'actor', 'role', 'action', 'label', 'resources', 'reward', 'grade', 'correction', 'included'];
export const RUN_COLUMNS = ['snapshot', 'run', 'mode', 'agent', 'version', 'case', 'attempt', 'startedAt', 'endedAt', 'status', 'totalReward', 'grade', 'review', 'stepCount', 'condition', 'capabilities', 'draftsShown', 'draftsUsed', 'editSize', 'overrides', 'asks', 'timeToAnswer'];
const GRADE_RANK = Object.fromEntries(GRADES.map((g, i) => [g.id, i]));

/** Canonical JSON: sorted keys, no whitespace, so the same content always hashes the same. */
export const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v ?? null));
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const csvCell = (v) => { const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCsv = (columns, rows) => `${[columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\n')}\n`;

export function createResearch({ store, rl = null }) {
  let readerStudies = null;
  let preferences = null;
  const now = () => store.now();
  const log = (tx, ctx, action, args, entityRef, description) => recordAction(tx, { runId: ctx.runId ?? undefined, actor: ctx.actor, kind: action.endsWith('.download') || action.endsWith('.replay') ? 'read' : 'create', action, args, entityRef, description, audit: false });
  const human = (ctx) => { if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only people review, correct, redact or build datasets'); };

  // ---------- studies ----------
  async function createStudy(body, ctx) {
    human(ctx);
    const title = String(body?.title || '').trim(); const question = String(body?.question || '').trim();
    if (title.length < 3) throw new HttpError(422, 'A study needs a title');
    const tags = Array.isArray(body?.tags) ? body.tags.map((t) => String(t).slice(0, 40)).slice(0, 20) : [];
    return store.transaction(async (tx) => {
      const study = await tx.save('Study', { resourceType: 'Study', id: randomUUID(), title: title.slice(0, 200), question: question.slice(0, 2000), owner: pseudonym(ctx.actor.id), ownerRole: ctx.actor.role, createdAt: tx.now(), status: 'active', tags, kind: body?.kind === 'multi-reader' ? 'multi-reader' : 'standard', mode: STUDY_MODES.includes(body?.mode) ? body.mode : 'evaluate' }, { updatedBy: ctx.actor.role });
      await log(tx, ctx, 'study.create', { study: study.id }, `Study/${study.id}`, `study created: ${study.title}`);
      return study;
    });
  }
  async function archiveStudy(id, ctx) {
    human(ctx);
    return store.transaction(async (tx) => {
      const s = await tx.get('Study', id); if (!s) throw new HttpError(404, `Study ${id} not found`);
      const { _seq, ...doc } = s;
      const saved = await tx.save('Study', { ...doc, status: 'archived', archivedAt: tx.now() }, { updatedBy: ctx.actor.role });
      await log(tx, ctx, 'study.archive', { study: id }, `Study/${id}`, `study archived: ${s.title}`);
      return saved;
    });
  }
  const studies = async () => (await store.query('Study')).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  /** The study list for a mode page: run count and last activity (the latest link or the creation), newest activity first. */
  async function studyList(mode = null) {
    const links = await store.query('StudyLink');
    const rows = (await studies()).filter((st) => !mode || modeOf(st) === mode).map(({ _seq, ...st }) => {
      const mine = links.filter((l) => l.study === st.id);
      const lastActivity = mine.reduce((m, l) => (String(l.addedAt) > m ? String(l.addedAt) : m), String(st.createdAt));
      return { ...st, mode: modeOf(st), runs: mine.filter((l) => l.kind === 'run' || l.kind === 'recording').length, lastActivity };
    });
    return rows.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }
  async function link(tx, { study, kind, ref }, ctx) {
    if (!LINK_KINDS.includes(kind)) throw new HttpError(422, `kind must be one of ${LINK_KINDS.join(', ')}`);
    const s = await tx.get('Study', study); if (!s) throw new HttpError(404, `Study ${study} not found`);
    if (s.status === 'archived') throw new HttpError(409, 'This study is archived');
    const existing = (await tx.query('StudyLink', { where: (l) => l.study === study && l.ref === ref })).at(-1);
    if (existing) return existing;
    const made = await tx.save('StudyLink', { resourceType: 'StudyLink', id: randomUUID(), study, kind, ref: String(ref), addedBy: pseudonym(ctx.actor.id), addedAt: tx.now(), createdAt: tx.now() }, { updatedBy: ctx.actor.role });
    await log(tx, ctx, 'study.link', { study, kind, ref }, `Study/${study}`, `${kind} ${ref} added to study`);
    return made;
  }
  /** The same cases under several conditions, side by side (plan-master 8.6): task success, safety, time, human edits and overrides, asks per case, over-trust. */
  async function compare(id) {
    const study = await store.get('Study', id);
    if (!study) throw new HttpError(404, `No study ${id}`);
    const links = await store.query('StudyLink', { where: (l) => l.study === id && l.kind === 'run' });
    const groups = new Map();
    for (const l of links) {
      const run = await store.get('Run', l.ref);
      if (!run || !run.agentId) continue;
      const key = run.condition || 'none';
      if (!groups.has(key)) groups.set(key, { condition: key, capabilities: run.capabilities || null, runs: 0, cases: new Set(), succeeded: 0, failed: 0, refusals: 0, seconds: [], edits: 0, overrides: 0, asks: 0, approved: 0, draftsShown: 0, draftsUsed: 0, draftsDiscarded: 0, planted: 0, plantedAccepted: 0, timeToAnswer: [] });
      const g = groups.get(key);
      const steps = await store.query('TraceStep', { groupKey: run.id });
      const st = interactionStats(steps);
      g.runs += 1; g.cases.add(run.caseId || run.subject || run.id);
      if (run.endedAt && ['completed'].includes(run.endReason || 'completed')) g.succeeded += 1; else if (run.endedAt) g.failed += 1;
      g.refusals += steps.filter((s) => s.did.type === 'envelope.reject').length;
      if (run.endedAt) g.seconds.push(Math.max(0, (Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000));
      g.edits += st.draftsEdited; g.overrides += st.overrides; g.asks += st.asks; g.approved += st.permissionsApproved; g.draftsShown += st.draftsShown; g.draftsUsed += st.draftsUsed; g.draftsDiscarded += st.draftsDiscarded;
      if (st.timeToAnswer != null) g.timeToAnswer.push(st.timeToAnswer);
      if (run.probe) { g.planted += 1; if (steps.some((s) => s.did.type === 'proposal.accept')) g.plantedAccepted += 1; }
    }
    const mean = (v) => (v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null);
    const conditions = [...groups.values()].map((g) => ({
      condition: g.condition, capabilities: g.capabilities, runs: g.runs, cases: g.cases.size,
      taskSuccess: g.runs ? Math.round((g.succeeded / g.runs) * 1000) / 1000 : null, safety: { refusals: g.refusals, failed: g.failed }, meanSeconds: mean(g.seconds),
      humanEdits: g.edits, overrides: g.overrides, asksPerCase: g.cases.size ? Math.round((g.asks / g.cases.size) * 100) / 100 : null, permissionsApproved: g.approved,
      drafts: { shown: g.draftsShown, used: g.draftsUsed, discarded: g.draftsDiscarded }, timeToAnswer: mean(g.timeToAnswer),
      overTrust: g.planted ? Math.round((g.plantedAccepted / g.planted) * 1000) / 1000 : null,
    })).sort((a, b) => a.condition.localeCompare(b.condition));
    return { study: { id: study.id, title: study.title }, conditions, note: 'Each column is one condition: the same cases, different capabilities. Over-trust is the share of planted wrong proposals accepted unchanged.' };
  }

  async function contents(id, query = {}) {
    const study = await store.get('Study', id); if (!study) throw new HttpError(404, `Study ${id} not found`);
    const links = (await store.query('StudyLink', { where: (l) => l.study === id })).sort((a, b) => String(a.addedAt).localeCompare(String(b.addedAt)));
    const runsAll = new Map((await store.query('Run')).map((r) => [r.id, r]));
    const reviews = await reviewIndex();
    const runs = links.filter((l) => l.kind === 'run' || l.kind === 'recording').map((l) => runsAll.get(l.ref)).filter(Boolean)
      .filter((r) => (!query.mode || r.mode === query.mode) && (!query.agentId || r.agentId === query.agentId) && (!query.version || String(r.version) === String(query.version)) && (!query.caseId || r.caseId === query.caseId) && (!query.from || r.startedAt >= query.from) && (!query.to || r.startedAt <= query.to))
      .map((r) => ({ id: r.id, mode: r.mode, umbrella: r.umbrella, agentId: r.agentId, version: r.version, caseId: r.caseId, subject: r.subject, startedAt: r.startedAt, endedAt: r.endedAt, review: reviews.runs.get(r.id)?.decision ?? null }))
      .filter((r) => !query.review || query.review === 'any' || (query.review === 'unreviewed' ? !r.review : r.review === query.review));
    const projects = links.filter((l) => l.kind === 'project').map((l) => l.ref);
    const cases = links.filter((l) => l.kind === 'case').map((l) => l.ref);
    const snapshots = (await store.query('DatasetSnapshot', { where: (s) => s.study === id })).map(({ _seq, rows, ...s }) => s).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { study: { ...study, mode: modeOf(study), _seq: undefined }, runs, recordings: runs.filter((r) => r.mode === 'capture'), projects, cases, snapshots, links: links.map(({ _seq, ...l }) => l) };
  }

  // ---------- reviews, corrections, redactions ----------
  async function targetOf(tx, target) {
    const t = String(target || '');
    const run = await tx.get('Run', t);
    if (run) return { kind: 'run', run, step: null };
    const steps = await tx.query('TraceStep', { where: (s) => s.id === t });
    if (steps.length) { const step = steps[0]; return { kind: 'step', run: await tx.get('Run', step.runId), step }; }
    throw new HttpError(404, `No run or step with id ${t}`);
  }
  async function review(body, ctx) {
    human(ctx);
    if (!DECISIONS.includes(body?.decision)) throw new HttpError(422, `decision must be one of ${DECISIONS.join(', ')}`);
    const reason = String(body?.reason || '').trim().slice(0, 500);
    if (body.decision !== 'include' && reason.length < 3) throw new HttpError(422, 'A reason is required to exclude or flag for a fix');
    return store.transaction(async (tx) => {
      const { kind, run, step } = await targetOf(tx, body.target);
      const made = await tx.save('Review', { resourceType: 'Review', id: randomUUID(), target: String(body.target), targetKind: kind, runId: run?.id ?? null, decision: body.decision, reason, reviewer: pseudonym(ctx.actor.id), reviewerRole: ctx.actor.role, at: tx.now(), createdAt: tx.now() }, { updatedBy: ctx.actor.role });
      await log(tx, ctx, 'review.decide', { target: body.target, decision: body.decision, kind }, `Review/${made.id}`, `${body.decision} ${kind} ${body.target}${reason ? `: ${reason}` : ''}`);
      void step;
      return made;
    });
  }
  async function correction(body, ctx) {
    human(ctx);
    const ca = body?.correctAction && typeof body.correctAction === 'object' ? { type: String(body.correctAction.type || '').slice(0, 60), code: body.correctAction.code != null ? String(body.correctAction.code).slice(0, 60) : null, label: String(body.correctAction.label || '').slice(0, 200) } : null;
    const note = String(body?.note || '').trim().slice(0, 1000);
    if (!ca?.label && !note) throw new HttpError(422, 'Say what should have happened: an action or a note');
    return store.transaction(async (tx) => {
      const { kind, run } = await targetOf(tx, body.target);
      const made = await tx.save('Correction', { resourceType: 'Correction', id: randomUUID(), target: String(body.target), targetKind: kind, runId: run?.id ?? null, correctAction: ca, note, reviewer: pseudonym(ctx.actor.id), at: tx.now(), createdAt: tx.now() }, { updatedBy: ctx.actor.role });
      await log(tx, ctx, 'review.correct', { target: body.target, kind }, `Correction/${made.id}`, `correction on ${kind} ${body.target}: ${ca?.label || note}`);
      return made;
    });
  }
  async function redaction(body, ctx) {
    human(ctx);
    const path = String(body?.path || '').trim();
    if (!/^[\w.[\]-]{1,120}$/.test(path)) throw new HttpError(422, 'path names the field to remove from exports, for example did.args.text');
    const reason = String(body?.reason || '').trim().slice(0, 500);
    if (reason.length < 3) throw new HttpError(422, 'A reason is required');
    return store.transaction(async (tx) => {
      const { kind, run } = await targetOf(tx, body.target);
      const made = await tx.save('Redaction', { resourceType: 'Redaction', id: randomUUID(), target: String(body.target), targetKind: kind, runId: run?.id ?? null, path, reason, reviewer: pseudonym(ctx.actor.id), at: tx.now(), createdAt: tx.now() }, { updatedBy: ctx.actor.role });
      await log(tx, ctx, 'review.redact', { target: body.target, path }, `Redaction/${made.id}`, `redacted ${path} on ${kind} ${body.target}: ${reason}`);
      return made;
    });
  }
  /** Latest decision per target, plus every correction and redaction, keyed by target. */
  async function reviewIndex(runId = null) {
    const pick = (list) => list.filter((x) => !runId || x.runId === runId);
    const reviews = pick(await store.query('Review')).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const runs = new Map(); const steps = new Map();
    for (const r of reviews) (r.targetKind === 'run' ? runs : steps).set(r.target, r);
    const corrections = new Map(); const redactions = new Map();
    for (const c of pick(await store.query('Correction'))) { if (!corrections.has(c.target)) corrections.set(c.target, []); corrections.get(c.target).push(c); }
    for (const r of pick(await store.query('Redaction'))) { if (!redactions.has(r.target)) redactions.set(r.target, []); redactions.get(r.target).push(r); }
    return { runs, steps, corrections, redactions, all: reviews };
  }
  async function overlay(runId) {
    const idx = await reviewIndex(runId);
    const strip = ({ _seq, ...x }) => x;
    return { runReview: idx.runs.get(runId) ? strip(idx.runs.get(runId)) : null, stepReviews: Object.fromEntries([...idx.steps].map(([k, v]) => [k, strip(v)])), corrections: Object.fromEntries([...idx.corrections].map(([k, v]) => [k, v.map(strip)])), redactions: Object.fromEntries([...idx.redactions].map(([k, v]) => [k, v.map(strip)])) };
  }
  async function queue(studyId) {
    const c = await contents(studyId);
    return { study: c.study, waiting: c.runs.filter((r) => !r.review), reviewed: c.runs.filter((r) => r.review).length, total: c.runs.length };
  }

  // ---------- snapshots and exports (5.6) ----------
  const getPath = (obj, path) => path.replace(/\[(\d+)\]/g, '.$1').split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const setPath = (obj, path, value) => { const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.'); let o = obj; for (const k of keys.slice(0, -1)) { if (o == null || typeof o !== 'object') return; o = o[k]; } if (o && typeof o === 'object') o[keys.at(-1)] = value; };
  const deepClone = (v) => JSON.parse(JSON.stringify(v ?? null));
  const scrub = (value, names) => (typeof value === 'string' ? redactText(value, { names }).text : Array.isArray(value) ? value.map((v) => scrub(v, names)) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, names)])) : value);

  async function build(body, ctx, { store: persist = true } = {}) {
    human(ctx);
    const study = await store.get('Study', body?.study); if (!study) throw new HttpError(404, `Study ${body?.study} not found`);
    const exportType = EXPORT_TYPES.includes(body?.exportType) ? body.exportType : 'steps';
    const filters = { mode: body?.filters?.mode || null, agentId: body?.filters?.agentId || null, version: body?.filters?.version || null, caseId: body?.filters?.caseId || null, from: body?.filters?.from || null, to: body?.filters?.to || null, review: body?.filters?.review || 'any' };
    const reviewRules = { requireReview: Boolean(body?.reviewRules?.requireReview), dropNeedsFix: body?.reviewRules?.dropNeedsFix !== false };
    const gradeCutoff = body?.gradeCutoff && GRADE_RANK[body.gradeCutoff] != null ? body.gradeCutoff : null;
    const c = await contents(study.id, filters);
    const idx = await reviewIndex();
    const runsAll = new Map((await store.query('Run')).map((r) => [r.id, r]));
    const cases = new Map((await store.query('EvalCase')).map((x) => [x.id, x]));
    const episodesApi = rl?.episodes || null;
    const episodes = episodesApi ? await episodesApi.list() : await store.query('Episode');
    const byRun = new Map(episodes.map((e) => [e.runId, e]));
    const gradesAll = await allGrades(store);
    const runGrade = (runId) => { const ep = byRun.get(runId); const list = gradesAll.filter((g) => g.kind === 'episode' && (g.episodeId === ep?.id || g.runId === runId)); return settle(list); };
    const stepGrades = new Map(gradesAll.filter((g) => g.kind === 'step' && g.stepId).map((g) => [g.stepId, g.value]));
    const cfg = await rewardConfig(store);
    const exclusions = [];
    let evalHeldOut = 0;
    let chosen = [];
    for (const r of c.runs) {
      const run = runsAll.get(r.id);
      // Held-out red-team tests (task 14.3) never leave the system in detail: counted, never named.
      if (run?.result?.heldOut) { evalHeldOut += 1; continue; }
      const ep = byRun.get(r.id);
      const decision = idx.runs.get(r.id)?.decision ?? null;
      if (decision === 'exclude') { exclusions.push({ run: r.id, reason: idx.runs.get(r.id).reason, by: idx.runs.get(r.id).reviewer }); continue; }
      if (decision === 'needs-fix' && reviewRules.dropNeedsFix) { exclusions.push({ run: r.id, reason: `needs a fix: ${idx.runs.get(r.id).reason}`, by: idx.runs.get(r.id).reviewer }); continue; }
      if (reviewRules.requireReview && decision !== 'include') { exclusions.push({ run: r.id, reason: 'not yet reviewed', by: null }); continue; }
      // The frozen evaluation split never leaves the system: checked on the case and on the episode.
      if (['eval', 'validation'].includes(cases.get(run.caseId)?.split) || ['eval', 'validation'].includes(ep?.split)) { evalHeldOut += 1; continue; } // validation is for monitoring, never training data
      const grade = runGrade(r.id);
      if (gradeCutoff && grade?.final && GRADE_RANK[grade.final] > GRADE_RANK[gradeCutoff]) { exclusions.push({ run: r.id, reason: `graded ${grade.final}, below the cutoff ${gradeCutoff}`, by: null }); continue; }
      chosen.push({ run, episode: ep, grade });
    }
    if (exportType === 'best-attempts') {
      const best = new Map();
      for (const x of chosen) { const key = x.run.caseId || x.run.subject || x.run.id; const score = x.episode?.outcome?.totalReward ?? -Infinity; if (!best.has(key) || score > best.get(key).score) best.set(key, { x, score }); }
      const keep = new Set([...best.values()].map((b) => b.x.run.id));
      for (const x of chosen) if (!keep.has(x.run.id)) exclusions.push({ run: x.run.id, reason: 'not the best attempt for its case', by: null });
      chosen = chosen.filter((x) => keep.has(x.run.id));
    }
    chosen.sort((a, b) => String(a.run.startedAt).localeCompare(String(b.run.startedAt)) || a.run.id.localeCompare(b.run.id));
    const patients = new Set(); const names = [];
    for (const x of chosen) { const pid = x.run.context?.patientRef || x.run.subject; if (pid?.startsWith('Patient/')) patients.add(pid.split('/')[1]); }
    for (const pid of patients) { const p = await store.get('Patient', pid).catch(() => null); for (const n of p?.name || []) names.push(...[n.family, ...(n.given || [])].filter(Boolean)); }
    const runRows = []; const stepRows = []; const droppedSteps = []; let redactedFields = 0;
    for (const x of chosen) {
      const steps = (await store.query('TraceStep', { groupKey: x.run.id })).sort((a, b) => a._seq - b._seq);
      const attempt = x.episode?.attempt ?? x.run.seed ?? 0;
      let rewardByStep = new Map();
      if (x.episode && episodesApi && cfg && x.episode.outcome) { try { const turns = await episodesApi.turnsOf(x.run, {}); const vals = episodesApi.stepRewards(turns, x.episode, cfg); rewardByStep = new Map(turns.map((t, i) => [t.stepId, Array.isArray(vals) ? vals[i] : vals?.[i] ?? null])); } catch { rewardByStep = new Map(); } }
      let n = 0;
      for (const s of steps) {
        n += 1;
        const d = idx.steps.get(s.id)?.decision ?? null;
        // Dropped steps are counted per run with their reasons; their ids never leave the system.
        if (d === 'exclude' || (d === 'needs-fix' && reviewRules.dropNeedsFix)) { droppedSteps.push({ run: x.run.id, reason: idx.steps.get(s.id).reason }); continue; }
        const copy = deepClone({ did: s.did, saw: s.saw, who: { kind: s.who.kind, role: s.who.role }, why: s.why, when: s.when, source: s.source });
        for (const red of idx.redactions.get(s.id) || []) { if (getPath(copy, red.path) !== undefined) { setPath(copy, red.path, '[redacted]'); redactedFields += 1; } }
        for (const red of idx.redactions.get(x.run.id) || []) { if (getPath(copy, red.path) !== undefined) { setPath(copy, red.path, '[redacted]'); redactedFields += 1; } }
        const corr = (idx.corrections.get(s.id) || []).at(-1) || null;
        const row = { snapshot: null, run: x.run.id, attempt, step: n, stepId: s.id, actor: copy.who.kind, role: copy.who.role, action: copy.did.type, label: describeAction(copy.did.type, copy.did.args), args: scrub(copy.did.args, names), resources: (copy.saw.resources || []).map((r) => `${r.ref}@${r.versionId ?? ''}`), asOf: copy.saw.asOf, branch: copy.saw.branch, reward: rewardByStep.get(s.id) ?? null, grade: stepGrades.get(s.id) ?? null, correction: corr ? { action: corr.correctAction, note: scrub(corr.note, names) } : null, included: true, why: scrub(copy.why, names) };
        if (exportType === 'steps' || exportType === 'best-attempts') stepRows.push(row);
        else stepRows.push(row);
      }
      runRows.push({ snapshot: null, run: x.run.id, mode: x.run.mode, agent: x.run.agentId, version: x.run.version, case: x.run.caseId, attempt, startedAt: x.run.startedAt, endedAt: x.run.endedAt, status: x.run.endReason || (x.run.endedAt ? 'completed' : 'running'), totalReward: x.episode?.outcome?.totalReward ?? null, grade: x.grade?.final ?? (x.grade ? x.grade.value : null), review: idx.runs.get(x.run.id)?.decision ?? null, stepCount: steps.length, condition: x.run.condition ?? null, capabilities: (x.run.capabilities || []).join(' '), ...(({ draftsShown, draftsUsed, editSize, overrides, asks, timeToAnswer }) => ({ draftsShown, draftsUsed, editSize, overrides, asks, timeToAnswer }))(interactionStats(steps)) });
    }
    let pairs = null;
    if (exportType === 'pairs') {
      pairs = [];
      const groups = new Map();
      for (const r of runRows) { const k = r.case || r.run; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
      for (const g of groups.values()) for (let i = 0; i < g.length; i += 1) for (let j = 0; j < g.length; j += 1) { if (i !== j && (g[i].totalReward ?? -1) > (g[j].totalReward ?? -1)) pairs.push({ case: g[i].case, preferred: g[i].run, rejected: g[j].run, preferredReward: g[i].totalReward, rejectedReward: g[j].totalReward }); }
    }
    const agentsUsed = [...new Set(runRows.map((r) => `${r.agent || 'human'}@${r.version || ''}`))];
    const licences = datasetsForPatients([...patients]);
    const dataCard = {
      study: { id: study.id, title: study.title, question: study.question }, exportType, agents: agentsUsed, counts: { runs: runRows.length, steps: stepRows.length, pairs: pairs?.length ?? 0, excludedRuns: exclusions.length, excludedSteps: droppedSteps.length, redactedFields },
      reviewing: reviewRules.requireReview ? 'only runs a reviewer marked include' : 'reviewed exclusions applied; unreviewed runs kept', exclusions, excludedSteps: droppedSteps,
      rewardConfigVersion: cfg?.version ?? null, gradeCutoff, deidentification: `names of ${patients.size} patient(s) replaced in free text; reviewer names replaced by pseudonymous ids; ${redactedFields} field(s) redacted`,
      evaluationSplitExcluded: { always: true, runsHeldOut: evalHeldOut },
      preregistration: study.preregistration ? { hypothesis: study.preregistration.hypothesis, mainMeasure: study.preregistration.mainMeasure, registeredAt: study.preregistration.registeredAt, lockedAt: study.preregistration.lockedAt } : null, dataSources: licences, limitations: ['Synthetic or public de-identified data only; scores are proxies, not clinical validation.', 'Steps are as the log recorded them; corrections are attached, not applied.'],
    };
    // Multi-reader studies (task 20.4): one row per reader, case and condition, frozen with the snapshot.
    const readerRows = exportType === 'readers' && readerStudies ? (await readerStudies.tableRows(study.id)).map((r) => ({ ...r, snapshot: null })) : [];
    if (exportType === 'readers') dataCard.counts.readers = readerRows.length;
    const prefs = exportType === 'preferences' && preferences ? await preferences.exportRows(study.id) : { rows: [], heldOut: 0 };
    const preferenceRows = prefs.rows.map((r) => ({ ...r, snapshot: null }));
    if (exportType === 'preferences') { dataCard.counts.preferences = preferenceRows.length; dataCard.counts.heldOutPreferences = prefs.heldOut; }
    const content = { exportType, filters, reviewRules, gradeCutoff, rewardConfigVersion: cfg?.version ?? null, runs: runRows, steps: stepRows, pairs, readers: readerRows, preferences: preferenceRows, dataCard: { ...dataCard, counts: dataCard.counts } };
    const hash = sha256(canonical(content));
    const snapshot = { resourceType: 'DatasetSnapshot', id: randomUUID(), study: study.id, title: String(body?.title || `${study.title} dataset`).slice(0, 200), filters, exportType, runIds: runRows.map((r) => r.run), stepCount: stepRows.length, reviewRules, rewardConfigVersion: cfg?.version ?? null, gradeCutoff, createdBy: pseudonym(ctx.actor.id), createdAt: now(), sha256: hash, dataCard, rows: { runs: runRows, steps: stepRows, pairs, readers: readerRows, preferences: preferenceRows } };
    if (!persist) return { ...snapshot, rows: undefined, sample: stepRows.slice(0, 5), runSample: runRows.slice(0, 5) };
    return store.transaction(async (tx) => {
      const saved = await tx.save('DatasetSnapshot', snapshot, { updatedBy: ctx.actor.role });
      await link(tx, { study: study.id, kind: 'snapshot', ref: saved.id }, ctx);
      await log(tx, ctx, 'snapshot.freeze', { snapshot: saved.id, study: study.id, runs: runRows.length, steps: stepRows.length, sha256: hash }, `DatasetSnapshot/${saved.id}`, `dataset frozen: ${saved.title} (${runRows.length} runs, ${stepRows.length} steps, sha256 ${hash.slice(0, 12)})`);
      const { rows, _seq, ...meta } = saved;
      return meta;
    });
  }
  async function exportSnapshot(id, format, which, ctx) {
    const snap = await store.get('DatasetSnapshot', id); if (!snap) throw new HttpError(404, `Snapshot ${id} not found`);
    if (!FORMATS.includes(format)) throw new HttpError(422, `format must be one of ${FORMATS.join(', ')}`);
    const stamp = (r) => ({ ...r, snapshot: snap.id });
    const manifest = { manifest: true, snapshot: snap.id, title: snap.title, study: snap.study, sha256: snap.sha256, exportType: snap.exportType, format, createdAt: snap.createdAt, createdBy: snap.createdBy, rewardConfigVersion: snap.rewardConfigVersion, gradeCutoff: snap.gradeCutoff, reviewRules: snap.reviewRules, filters: snap.filters, counts: snap.dataCard.counts, evaluationSplitExcluded: true, dataCard: snap.dataCard };
    await store.transaction((tx) => log(tx, ctx, 'snapshot.download', { snapshot: snap.id, format, which: which || 'all' }, `DatasetSnapshot/${snap.id}`, `dataset downloaded: ${snap.title} as ${format}${which ? ` (${which})` : ''}`));
    const runs = snap.rows.runs.map(stamp); const steps = snap.rows.steps.map(stamp); const readers = (snap.rows.readers || []).map(stamp); const prefRows = (snap.rows.preferences || []).map(stamp);
    if (format === 'csv') {
      const runCsv = which === 'runs';
      if (snap.exportType === 'preferences' && !which) return { status: 200, body: toCsv(PREFERENCE_COLUMNS, prefRows), headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${snap.id}-preferences.csv"`, 'X-Snapshot-Sha256': snap.sha256 } };
      if (which === 'readers' || (snap.exportType === 'readers' && !which)) return { status: 200, body: toCsv(READER_COLUMNS, readers), headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${snap.id}-readers.csv"`, 'X-Snapshot-Sha256': snap.sha256 } };
      const body = runCsv ? toCsv(RUN_COLUMNS, runs) : toCsv(STEP_COLUMNS, steps.map((s) => ({ ...s, resources: s.resources.join(' '), correction: s.correction ? JSON.stringify(s.correction) : '' })));
      return { status: 200, body, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${snap.id}-${runCsv ? 'runs' : 'steps'}.csv"`, 'X-Snapshot-Sha256': snap.sha256 } };
    }
    if (format === 'json') return { status: 200, body: JSON.stringify({ manifest, runs, steps, pairs: snap.rows.pairs, readers, preferences: prefRows }, null, 1), headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${snap.id}.json"`, 'X-Snapshot-Sha256': snap.sha256 } };
    const lines = [manifest, ...(snap.exportType === 'pairs' ? (snap.rows.pairs || []).map(stamp) : snap.exportType === 'readers' ? readers : snap.exportType === 'preferences' ? prefRows : steps)];
    return { status: 200, body: `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': `attachment; filename="${snap.id}.jsonl"`, 'X-Snapshot-Sha256': snap.sha256 } };
  }

  // ---------- replay (5.5) ----------
  async function replay(runId, stepId, ctx) {
    const run = await store.get('Run', runId); if (!run) throw new HttpError(404, `Run ${runId} not found`);
    const step = (await store.query('TraceStep', { groupKey: runId })).find((s) => s.id === stepId);
    if (!step) throw new HttpError(404, `Step ${stepId} is not in run ${runId}`);
    const branch = step.saw?.branch || run.branch || 'main';
    const resources = [];
    for (const r of (step.saw?.resources || []).slice(0, 40)) {
      const [type, id] = String(r.ref).split('/');
      if (!type || !id) continue;
      const history = await store.history(type, id, { branch }).catch(() => []);
      const exact = r.versionId != null ? history.find((v) => String(v.meta?.versionId) === String(r.versionId)) : null;
      const doc = exact || history.filter((v) => (v._recordedAt || '') <= (step.when?.wall || '')).at(-1) || history.at(-1) || null;
      resources.push({ ref: r.ref, versionId: doc?.meta?.versionId ?? r.versionId ?? null, exactVersion: Boolean(exact), body: doc ? Object.fromEntries(Object.entries(doc).filter(([k]) => !k.startsWith('_'))) : null });
    }
    const args = step.did?.args || {};
    const patient = args.patient || run.context?.patientRef || resources.find((r) => r.body?.resourceType === 'Patient')?.ref || null;
    await store.transaction((tx) => log(tx, ctx, 'trace.replay', { run: runId, step: stepId }, `TraceStep/${stepId}`, `replayed what the actor saw at step ${stepId}`));
    return { run: { id: run.id, mode: run.mode, branch: run.branch, agentId: run.agentId }, step: { id: step.id, type: step.did?.type, at: step.when?.wall, actor: step.who }, screen: { app: args.app || run.context?.app || null, route: args.route || null }, patient, branch, asOf: step.when?.chartAsOf || step.when?.wall || null, viewport: args.viewer || null, resources };
  }

  // ---------- mode summary for the apps' strips ----------
  async function mode(ctx) {
    const runs = (await store.query('Run')).filter((r) => !r.endedAt);
    const by = (m) => runs.filter((r) => (Array.isArray(m) ? m.includes(r.mode) : r.mode === m));
    return { shadow: by(['shadow-task', 'shadow-event']).length, hitl: by('hitl').length, hitlAwaiting: by('hitl').filter((r) => r.awaitingDecision).length, redteam: by('redteam').length, rl: by('rl-generate').length, capture: by('capture').map((r) => ({ id: r.id, startedAt: r.startedAt, by: r.context?.recorder || null })), role: ctx.actor.role };
  }

  return { setReaderStudies(api) { readerStudies = api; }, setPreferences(api) { preferences = api; },
    createStudy, archiveStudy, studies, contents, link, review, correction, redaction, overlay, queue, build, exportSnapshot, replay, mode, reviewIndex,
    async handle(req, url, body, ctx, parts) {
      const [area, id, op, op2] = parts;
      const m = req.method;
      if (area === 'replay' && id && op && m === 'GET') return { status: 200, body: await replay(id, op, ctx) };
      if (area === 'mode' && m === 'GET') return { status: 200, body: await mode(ctx) };
      if (area !== 'research') return null;
      const section = id;
      if (section === 'studies') {
        if (!op && m === 'GET') return { status: 200, body: { studies: await studyList(STUDY_MODES.includes(url.searchParams.get('mode')) ? url.searchParams.get('mode') : null) } };
        if (!op && m === 'POST') return { status: 201, body: await createStudy(body, ctx) };
        if (op && !op2 && m === 'GET') return { status: 200, body: await contents(op, Object.fromEntries(url.searchParams)) };
        if (op && op2 === 'archive' && m === 'POST') return { status: 200, body: await archiveStudy(op, ctx) };
        if (op && op2 === 'links' && m === 'POST') { human(ctx); return { status: 201, body: await store.transaction((tx) => link(tx, { study: op, kind: body?.kind, ref: body?.ref }, ctx)) }; }
        if (op && op2 === 'queue' && m === 'GET') return { status: 200, body: await queue(op) };
        if (op && op2 === 'compare' && m === 'GET') return { status: 200, body: await compare(op) };
      }
      if (section === 'reviews' && m === 'POST') return { status: 201, body: await review(body, ctx) };
      if (section === 'corrections' && m === 'POST') return { status: 201, body: await correction(body, ctx) };
      if (section === 'redactions' && m === 'POST') return { status: 201, body: await redaction(body, ctx) };
      if (section === 'overlay' && op && m === 'GET') return { status: 200, body: await overlay(op) };
      if (section === 'snapshots') {
        if (!op && m === 'POST') return { status: 201, body: await build(body, ctx) };
        if (op === 'preview' && m === 'POST') return { status: 200, body: await build(body, ctx, { store: false }) };
        if (op && !op2 && m === 'GET') { const s = await store.get('DatasetSnapshot', op); if (!s) throw new HttpError(404, `Snapshot ${op} not found`); const { rows, _seq, ...meta } = s; return { status: 200, body: { ...meta, sample: rows.steps.slice(0, 5) } }; }
        if (op && op2 === 'export' && m === 'GET') return exportSnapshot(op, url.searchParams.get('format') || 'jsonl', url.searchParams.get('which') || null, ctx);
      }
      throw new HttpError(404, `${m} ${url.pathname} is not available`);
    },
  };
}
