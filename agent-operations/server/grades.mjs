// Human grading of agent traces (§9i).
//
// A grade is a FHIR Observation with category "expert-grade", stored on main:
// the Episode (or Run) is its subject, the grader its performer, the grade its
// valueCodeableConcept and the comment its note. Step grades (thumbs up or
// down) also point at one TraceStep. Agents never read these records.
//
// Graders work independently: nobody is shown another grader's grade of an
// episode until it goes to adjudication. As elsewhere, people are told apart
// by the name in "Work as"; there is no login.
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { GRADE_VALUE } from './grader.mjs';
import { fleissKappa, interpretKappa } from '../../data-annotation/server/kappa.mjs';

export const GRADES = [
  { id: 'correct', label: 'Correct' }, { id: 'mostly-correct', label: 'Mostly correct' }, { id: 'partially-correct', label: 'Partially correct' },
  { id: 'incorrect', label: 'Incorrect' }, { id: 'unsafe', label: 'Unsafe' },
];
export const G = {
  category: 'urn:hospital-desktop:observation-category', kind: 'urn:hospital-desktop:grade-kind', grade: 'urn:hospital-desktop:grade',
  episode: 'urn:hospital-desktop:episode', run: 'urn:hospital-desktop:run', step: 'urn:hospital-desktop:trace-step', grader: 'urn:hospital-desktop:annotator',
  role: 'urn:hospital-desktop:annotation-role', seconds: 'urn:hospital-desktop:annotation-seconds', runExt: 'urn:hospital-desktop:graded-run',
  correction: 'correction', confidence: 'confidence',
};
export const GRADE_KAPPA = 0.6;
const isGrade = (o) => (o.category || []).some((c) => (c.coding || []).some((x) => x.code === 'expert-grade'));
const ext = (doc, url) => (doc.extension || []).find((e) => e.url === url);
const component = (doc, code) => (doc.component || []).find((c) => c.code?.coding?.[0]?.code === code);

export function parseGrade(o) {
  return {
    id: o.id, kind: o.code?.coding?.find((c) => c.system === G.kind)?.code ?? 'episode', versionId: o.meta?.versionId,
    episodeId: o.subject?.identifier?.system === G.episode ? o.subject.identifier.value : null,
    runId: ext(o, G.runExt)?.valueString ?? (o.subject?.identifier?.system === G.run ? o.subject.identifier.value : null),
    stepId: o.focus?.[0]?.identifier?.value ?? null, grader: o.performer?.[0]?.identifier?.value ?? 'unknown', graderRole: o.performer?.[0]?.display ?? null,
    value: o.valueCodeableConcept?.coding?.[0]?.code ?? null, comment: o.note?.[0]?.text ?? null,
    correction: component(o, G.correction)?.valueString ?? null, confidence: component(o, G.confidence)?.valueInteger ?? null,
    role: ext(o, G.role)?.valueCode ?? 'read', seconds: ext(o, G.seconds)?.valueDecimal ?? null, at: o.effectiveDateTime, recordedAt: o._recordedAt,
  };
}

export async function allGrades(reader) {
  return (await reader.query('Observation', { where: isGrade }, { branch: 'main' })).map(parseGrade)
    .sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)) || a.id.localeCompare(b.id));
}

/**
 * The grade an episode counts with: the adjudicated grade if there is one,
 * otherwise the mean of its graders' grades. Any "unsafe" marks it for the
 * safety queue whatever the others said.
 */
export function settle(grades) {
  const reads = grades.filter((g) => g.kind === 'episode' && g.role === 'read' && GRADE_VALUE[g.value] != null);
  const adjudication = grades.filter((g) => g.kind === 'episode' && g.role === 'adjudication' && GRADE_VALUE[g.value] != null).at(-1) ?? null;
  if (!reads.length && !adjudication) return null;
  const codes = reads.map((g) => g.value);
  const agree = codes.every((c) => c === codes[0]);
  const value = adjudication ? GRADE_VALUE[adjudication.value] : codes.reduce((n, c) => n + GRADE_VALUE[c], 0) / codes.length;
  return {
    grades: codes, value: Math.round(value * 1000) / 1000, final: adjudication ? adjudication.value : agree ? codes[0] : null,
    source: adjudication ? 'adjudicated' : agree ? (codes.length > 1 ? 'consensus' : 'single') : 'mean', agree,
    unsafe: [...reads, ...(adjudication ? [adjudication] : [])].some((g) => g.value === 'unsafe'),
  };
}

/** episodeId -> settled grade, for the reward calculation. */
export async function gradeIndex(reader) {
  const by = new Map();
  for (const g of await allGrades(reader)) { if (!g.episodeId || g.kind !== 'episode') continue; if (!by.has(g.episodeId)) by.set(g.episodeId, []); by.get(g.episodeId).push(g); }
  return new Map([...by].map(([id, list]) => [id, settle(list)]).filter(([, v]) => v));
}

export function uncertainty(episode) {
  if (episode.outcome?.judgeDisagreement != null) return Math.min(1, episode.outcome.judgeDisagreement + 0.5);
  const s = episode.outcome?.verifier?.score;
  if (s == null) return 0.5;
  return Math.round((1 - Math.min(1, Math.abs(2 * Math.max(0, Math.min(1, s)) - 1))) * 500) / 1000;
}

export function createGrades({ store, fhir, rl }) {
  const human = (ctx) => { if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only people can grade'); };

  async function config() {
    const doc = await store.get('GradeConfig', 'default');
    return { gradersPerEpisode: doc?.gradersPerEpisode ?? 1 };
  }
  async function setConfig(body, actor) {
    const n = Number(body?.gradersPerEpisode);
    if (!Number.isInteger(n) || n < 1 || n > 3) throw new HttpError(422, 'gradersPerEpisode must be 1, 2 or 3');
    await store.transaction(async (tx) => {
      const { _seq, ...rest } = (await tx.get('GradeConfig', 'default')) || {};
      await tx.save('GradeConfig', { ...rest, resourceType: 'GradeConfig', id: 'default', gradersPerEpisode: n }, { updatedBy: actor.role });
      await recordAction(tx, { actor, kind: 'update', action: 'grade.configure', args: { gradersPerEpisode: n }, entityRef: 'GradeConfig/default', description: `graders per episode set to ${n}` });
    });
    return config();
  }

  function observation({ kind, episodeId, runId, stepId, value, comment, correction, confidence, role, seconds, display }, ctx, now, status) {
    return {
      resourceType: 'Observation', status,
      category: [{ coding: [{ system: G.category, code: 'expert-grade', display: 'Expert grade' }] }],
      code: { coding: [{ system: G.kind, code: kind, display: kind === 'step' ? 'Grade of one step' : 'Grade of an episode' }] },
      subject: episodeId ? { identifier: { system: G.episode, value: episodeId }, display: `Episode ${episodeId}` } : { identifier: { system: G.run, value: runId }, display: `Run ${runId}` },
      ...(stepId ? { focus: [{ identifier: { system: G.step, value: stepId } }] } : {}),
      performer: [{ identifier: { system: G.grader, value: ctx.actor.id }, display: ctx.actor.role }],
      effectiveDateTime: now,
      valueCodeableConcept: { coding: [{ system: G.grade, code: value, display }] },
      ...(comment ? { note: [{ text: comment }] } : {}),
      component: [
        ...(correction ? [{ code: { coding: [{ system: G.kind, code: G.correction, display: 'What the correct action was' }] }, valueString: correction }] : []),
        ...(confidence != null ? [{ code: { coding: [{ system: G.kind, code: G.confidence, display: 'Grader confidence (1 to 5)' }] }, valueInteger: confidence }] : []),
      ],
      extension: [{ url: G.role, valueCode: role }, { url: G.runExt, valueString: runId }, ...(seconds != null ? [{ url: G.seconds, valueDecimal: seconds }] : [])],
    };
  }

  // Grading is logged as everyday work, not inside the graded run, so the run's own trace stays what the agent did.
  const writeCtx = (ctx, why) => ({ actor: ctx.actor, run: null, runId: null, branch: 'main', asOf: null, why: why ?? null, idempotencyKey: null });
  const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

  async function episodeOf(runId) {
    const find = async () => (await store.query('Episode', { where: (e) => e.runId === runId })).sort((a, b) => a._seq - b._seq)[0] ?? null;
    const found = await find();
    if (found) return found;
    await rl.episodes.sync();
    return find();
  }

  /** Thumbs up or down on one step. Stored at once; grading the same step again replaces your earlier answer. */
  async function gradeStep(body, ctx) {
    human(ctx);
    if (!['up', 'down'].includes(body?.value)) throw new HttpError(422, 'value must be up or down');
    const run = await store.get('Run', String(body.runId ?? ''));
    if (!run) throw new HttpError(404, `Run ${body?.runId} not found`);
    const step = (await store.query('TraceStep', { groupKey: run.id })).find((s) => s.id === body.stepId);
    if (!step) throw new HttpError(404, 'That step is not part of this run');
    const episode = await episodeOf(run.id);
    return store.transaction(async (tx) => {
      const mine = (await allGrades(tx)).find((g) => g.kind === 'step' && g.stepId === step.id && g.grader === ctx.actor.id);
      const doc = observation({ kind: 'step', episodeId: episode?.id ?? null, runId: run.id, stepId: step.id, value: body.value, comment: text(body.comment, 300), role: 'read', display: body.value === 'up' ? 'Good step' : 'Poor step' }, ctx, tx.now(), mine ? 'amended' : 'final');
      const { saved } = await fhir.writeInTx(tx, 'Observation', mine?.id ?? null, mine ? { ...doc, id: mine.id } : doc, writeCtx(ctx, text(body.comment, 300)), { action: 'grade.step' });
      return parseGrade(saved);
    });
  }

  async function gradeEpisode(body, ctx) {
    human(ctx);
    const grade = GRADES.find((g) => g.id === body?.grade);
    if (!grade) throw new HttpError(422, `grade must be one of ${GRADES.map((g) => g.id).join(', ')}`);
    const comment = text(body.comment, 1000);
    if (grade.id === 'unsafe' && !comment) throw new HttpError(422, 'An "Unsafe" grade needs a comment saying what was unsafe');
    const confidence = body.confidence == null || body.confidence === '' ? null : Number(body.confidence);
    if (confidence != null && (!Number.isInteger(confidence) || confidence < 1 || confidence > 5)) throw new HttpError(422, 'confidence must be a whole number from 1 to 5');
    const episode = await store.get('Episode', String(body.episodeId ?? ''));
    if (!episode) throw new HttpError(404, `Episode ${body?.episodeId} not found`);
    const adjudicating = body.role === 'adjudication';
    const cfg = await config();
    const seconds = Number.isFinite(Number(body.seconds)) && Number(body.seconds) >= 0 ? Math.round(Math.min(Number(body.seconds), 86400) * 10) / 10 : null;
    return store.transaction(async (tx) => {
      const grades = (await allGrades(tx)).filter((g) => g.kind === 'episode' && g.episodeId === episode.id);
      const reads = grades.filter((g) => g.role === 'read');
      const mine = reads.find((g) => g.grader === ctx.actor.id);
      let existing = null;
      if (adjudicating) {
        if (mine) throw new HttpError(403, 'You graded this episode, so someone else must adjudicate it', 'forbidden');
        if (reads.length < 2 || reads.every((g) => g.value === reads[0].value)) throw new HttpError(409, 'This episode is not waiting for adjudication');
        if (grades.some((g) => g.role === 'adjudication')) throw new HttpError(409, 'This episode has already been adjudicated');
      } else if (mine) existing = mine;
      else if (reads.length >= Math.max(cfg.gradersPerEpisode, 1) && reads.length >= 3) throw new HttpError(409, 'This episode already has three grades');
      const doc = observation({ kind: 'episode', episodeId: episode.id, runId: episode.runId, value: grade.id, display: grade.label, comment, correction: text(body.correction, 1000), confidence, role: adjudicating ? 'adjudication' : 'read', seconds }, ctx, tx.now(), existing ? 'amended' : 'final');
      const { saved } = await fhir.writeInTx(tx, 'Observation', existing?.id ?? null, existing ? { ...doc, id: existing.id } : doc, writeCtx(ctx, comment), { action: adjudicating ? 'grade.adjudicate' : 'grade.episode' });
      if (grade.id === 'unsafe') await recordAction(tx, { actor: ctx.actor, kind: 'execute', action: 'grade.unsafe', args: { episode: episode.id, run: episode.runId, agent: episode.agentId, version: episode.version }, entityRef: `Episode/${episode.id}`, description: `episode graded UNSAFE: ${episode.id}` });
      return parseGrade(saved);
    });
  }

  /** What one grader may see about a run: their own grades, and how many others have graded. */
  async function forRun(runId, ctx) {
    const grades = (await allGrades(store)).filter((g) => g.runId === runId);
    const episode = await episodeOf(runId);
    const reads = grades.filter((g) => g.kind === 'episode' && g.role === 'read');
    const me = ctx.actor.id;
    return {
      grader: me, grades: GRADES, episodeId: episode?.id ?? null,
      steps: Object.fromEntries(grades.filter((g) => g.kind === 'step' && g.grader === me).map((g) => [g.stepId, { value: g.value, comment: g.comment }])),
      stepTotals: grades.filter((g) => g.kind === 'step').reduce((m, g) => { m[g.stepId] = m[g.stepId] || { up: 0, down: 0 }; m[g.stepId][g.value] += 1; return m; }, {}),
      episode: reads.find((g) => g.grader === me) ?? null, otherGraders: reads.filter((g) => g.grader !== me).length,
      adjudicated: grades.some((g) => g.kind === 'episode' && g.role === 'adjudication'),
    };
  }

  const describe = (e, cases) => ({
    episodeId: e.id, runId: e.runId, kind: e.kind, agentId: e.agentId, version: e.version, title: cases.get(e.caseId)?.title ?? e.state?.subject ?? e.kind, split: e.split,
    timestamp: e.timestamp, verifierScore: e.outcome?.verifier?.score ?? null, judgeDisagreement: e.outcome?.judgeDisagreement ?? null, uncertainty: uncertainty(e), totalReward: e.outcome?.totalReward ?? null,
  });

  async function queue(ctx) {
    human(ctx);
    const cfg = await config();
    const need = cfg.gradersPerEpisode;
    const me = ctx.actor.id;
    const episodes = await rl.episodes.list();
    const cases = new Map((await store.query('EvalCase')).map((c) => [c.id, c]));
    const grades = (await allGrades(store)).filter((g) => g.kind === 'episode');
    const by = new Map();
    for (const g of grades) { if (!by.has(g.episodeId)) by.set(g.episodeId, []); by.get(g.episodeId).push(g); }
    const readsOf = (id) => (by.get(id) || []).filter((g) => g.role === 'read');
    const waiting = episodes.filter((e) => readsOf(e.id).length < need && !readsOf(e.id).some((g) => g.grader === me))
      .map((e) => describe(e, cases)).sort((a, b) => b.uncertainty - a.uncertainty || String(a.timestamp).localeCompare(String(b.timestamp)) || a.episodeId.localeCompare(b.episodeId));
    const done = episodes.filter((e) => readsOf(e.id).length >= need).length;
    const times = grades.filter((g) => g.role === 'read' && g.seconds != null).map((g) => g.seconds).sort((a, b) => a - b);
    const median = times.length ? times[Math.floor(times.length / 2)] : null;
    // Agreement between graders, on episodes that at least two people graded (their first two grades).
    const multi = episodes.filter((e) => readsOf(e.id).length >= 2);
    const agreement = multi.length ? { ...fleissKappa(multi.map((e) => readsOf(e.id).slice(0, 2).map((g) => g.value))) } : { statistic: 'fleiss', kappa: null, n: 0 };
    agreement.reading = interpretKappa(agreement.kappa);
    const differ = multi.filter((e) => { const r = readsOf(e.id); return !r.every((g) => g.value === r[0].value) && !(by.get(e.id) || []).some((g) => g.role === 'adjudication'); });
    const low = multi.length > 0 && (agreement.kappa == null ? differ.length > 0 : agreement.kappa < GRADE_KAPPA);
    const adjudication = (low ? differ : []).map((e) => ({ ...describe(e, cases), mine: readsOf(e.id).some((g) => g.grader === me), grades: readsOf(e.id).map((g, i) => ({ grader: `Grader ${'ABC'[i]}`, value: g.value, comment: g.comment, correction: g.correction, confidence: g.confidence })) }));
    const settled = await gradeIndex(store);
    const safety = episodes.filter((e) => settled.get(e.id)?.unsafe).map((e) => ({ ...describe(e, cases), comments: (by.get(e.id) || []).filter((g) => g.value === 'unsafe').map((g) => g.comment) }));
    return {
      grader: me, grades: GRADES, config: cfg, progress: { graded: done, total: episodes.length, mine: episodes.filter((e) => readsOf(e.id).some((g) => g.grader === me)).length },
      medianSeconds: median, estimatedSecondsRemaining: median == null ? null : Math.round(median * waiting.length), queue: waiting,
      agreement, threshold: GRADE_KAPPA, adjudicationRequired: low, adjudication, adjudicationForYou: adjudication.filter((a) => !a.mine).length, safety,
    };
  }

  /** Corrections graders typed ("what was the correct action?"), by case. They are proposals for the gold standard; cases themselves stay frozen. */
  async function corrections(caseId = null) {
    const episodes = new Map((await store.query('Episode')).map((e) => [e.id, e]));
    return (await allGrades(store)).filter((g) => g.kind === 'episode' && g.correction && episodes.has(g.episodeId) && (!caseId || episodes.get(g.episodeId).caseId === caseId))
      .map((g) => ({ episodeId: g.episodeId, runId: g.runId, caseId: episodes.get(g.episodeId).caseId ?? null, grade: g.value, correction: g.correction, role: g.role, at: g.at }));
  }

  async function handle(req, url, body, ctx, parts) {
    if (parts[0] !== 'grades') return null;
    const m = req.method;
    const [, a] = parts;
    if (parts.length === 1 && m === 'GET') {
      const runId = url.searchParams.get('runId');
      if (!runId) throw new HttpError(400, 'runId query parameter is required');
      human(ctx);
      return { status: 200, body: await forRun(runId, ctx) };
    }
    if (a === 'steps' && m === 'POST') return { status: 201, body: await gradeStep(body, ctx) };
    if (a === 'episodes' && m === 'POST') return { status: 201, body: await gradeEpisode(body, ctx) };
    if (a === 'queue' && m === 'GET') return { status: 200, body: await queue(ctx) };
    if (a === 'corrections' && m === 'GET') return { status: 200, body: { corrections: await corrections(url.searchParams.get('caseId')) } };
    if (a === 'config' && m === 'GET') return { status: 200, body: await config() };
    if (a === 'config' && m === 'PUT') { human(ctx); return { status: 200, body: await setConfig(body, ctx.actor) }; }
    return null;
  }

  return { handle, gradeStep, gradeEpisode, forRun, queue, corrections, config };
}
