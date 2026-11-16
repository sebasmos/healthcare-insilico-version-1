// Multi-reader studies (plan-master task 20): readers (pseudonymous people
// and agent versions), cases and conditions; seeded random case order per
// reader, conditions crossed over halfway, a washout before the same reader
// sees a case again, other readers' answers hidden; a reference answer per
// case; four result views; an analysis table; pre-registration locked once
// the first reading starts.
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { pseudonym } from '../../platform/server/pseudonym.mjs';
import { mulberry32 } from '../../ehr/server/wearables.mjs';
import { interactionStats } from '../../agent-operations/server/turns.mjs';

export const READER_COLUMNS = ['snapshot', 'study', 'participant', 'kind', 'case', 'condition', 'order', 'answer', 'correct', 'confidence', 'seconds', 'changedAfterAi', 'readAt', 'capabilities', 'draftsShown', 'draftsUsed', 'editSize', 'overrides', 'asks', 'timeToAnswer'];
const text = (v, max = 400) => String(v ?? '').trim().slice(0, max);
const round = (v, d = 3) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const DAY = 86400000;

/** Shuffles with a seed, so the assignment is reproducible. */
export function shuffle(list, seed) { const rnd = mulberry32(seed); const a = [...list]; for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/**
 * Assignments (20.1): every reader gets every case under every condition.
 * Cases are in random order per reader; conditions cross over halfway (the
 * first half under A, the second under B, alternate readers start with B);
 * the second pass through the cases (the other condition) is available only
 * after the washout from the first reading of that case.
 */
export function assign({ readers, cases, conditions, seed = 1 }) {
  if (!readers.length || !cases.length || conditions.length < 1) throw new HttpError(422, 'A multi-reader study needs readers, cases and at least one condition');
  const k = conditions.length;
  const out = [];
  readers.forEach((reader, r) => {
    const order = shuffle(cases, seed * 1000 + r + 1);
    const half = Math.ceil(order.length / 2);
    const start = r % k;
    let n = 0;
    // Pass p: the first half of the cases under one condition and the second half under the next (the crossover);
    // later passes rotate, so every case is read under every condition, each later reading only after the washout.
    for (let p = 0; p < k; p += 1) {
      for (let i = 0; i < order.length; i += 1) {
        const c = conditions[(start + p + (i < half ? 0 : 1)) % k];
        if (out.some((x) => x.reader === reader.id && x.case === order[i] && x.condition === c)) continue;
        out.push({ id: `${reader.id}:${order[i]}:${c}`, reader: reader.id, readerKind: reader.kind, case: order[i], condition: c, order: n += 1, pass: p, status: 'pending' });
      }
    }
  });
  return out;
}

export function createReaderStudies({ store, research = null }) {
  const human = (ctx) => { if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only people take part in or change reader studies'); };
  const getStudy = async (id) => { const s = await store.get('Study', id); if (!s) throw new HttpError(404, `No study ${id}`); return s; };
  const log = (tx, ctx, runId, action, args, entityRef, description) => recordAction(tx, { ...(runId ? { runId } : {}), actor: ctx.actor, kind: 'execute', action, args, entityRef, description });
  const answersOf = async (studyId) => store.query('ReaderAnswer', { where: (a) => a.study === studyId });

  /** Design (20.1): readers, cases, conditions, washout, seed; generates the assignments. Locked once any reading exists. */
  async function design(id, body, ctx) {
    human(ctx);
    const study = await getStudy(id);
    if ((await answersOf(id)).length) throw new HttpError(409, 'Readings have started: the design is locked. Make a new study for a different design');
    const readers = [].concat(body?.readers || []).map((r) => (typeof r === 'string' ? { kind: r.startsWith('agent:') ? 'agent' : 'human', name: r } : r)).map((r) => ({ id: r.kind === 'agent' ? `agent:${String(r.agentId || r.name).replace(/^agent:/, '')}` : pseudonym(String(r.name || r.id || '')), kind: r.kind === 'agent' ? 'agent' : 'human', ...(r.kind === 'agent' ? { agentId: String(r.agentId || r.name).replace(/^agent:/, ''), version: r.version || null } : {}) }));
    if (!readers.length) throw new HttpError(422, 'Pick at least one reader (a typed name becomes a pseudonymous id; an agent is agent:<id>)');
    const cases = [...new Set([].concat(body?.cases || []).map(String))];
    for (const c of cases) if (!(await store.get('EvalCase', c))) throw new HttpError(422, `Case "${c}" is not in the case bank`);
    const conditions = [...new Set([].concat(body?.conditions || ['without-ai', 'with-ai-helper']).map(String))];
    const washoutDays = Math.max(0, Math.min(365, Number(body?.washoutDays ?? 14)));
    const seed = Number.isInteger(body?.seed) ? body.seed : Math.floor(Math.random() * 1e9);
    const assignments = assign({ readers, cases, conditions, seed });
    return store.transaction(async (tx) => {
      const cur = await tx.get('Study', id);
      const saved = await tx.save('Study', { ...cur, kind: 'multi-reader', design: { readers, cases, conditions, washoutDays, seed, createdAt: tx.now() }, assignments }, { updatedBy: ctx.actor.role });
      await log(tx, ctx, null, 'study.design', { study: id, readers: readers.length, cases: cases.length, conditions, washoutDays, seed }, `Study/${id}`, `multi-reader design: ${readers.length} readers, ${cases.length} cases, ${conditions.length} conditions`);
      return present(saved, ctx);
    });
  }

  /** Reference answer per case (20.2): from gold actions, an adjudicated panel, or both. */
  async function setReference(id, caseId, body, ctx) {
    human(ctx);
    const study = await getStudy(id);
    const source = ['gold', 'panel', 'both'].includes(body?.source) ? body.source : 'gold';
    const evalCase = await store.get('EvalCase', caseId);
    if (!evalCase) throw new HttpError(404, `Case "${caseId}" is not in the case bank`);
    const gold = (evalCase.goldActions || []).map((g) => g.label || g.code).join('; ');
    const panel = text(body?.answer, 400);
    if (source !== 'gold' && !panel) throw new HttpError(422, 'Write the panel\'s adjudicated answer');
    const answer = source === 'gold' ? gold : source === 'panel' ? panel : `${gold}; ${panel}`;
    return store.transaction(async (tx) => {
      const cur = await tx.get('Study', id);
      const references = { ...(cur.references || {}), [caseId]: { source, answer, gold, panel: panel || null, setAt: tx.now(), setBy: pseudonym(ctx.actor.id) } };
      await tx.save('Study', { ...cur, references }, { updatedBy: ctx.actor.role });
      await log(tx, ctx, null, 'study.reference', { study: id, case: caseId, source }, `Study/${id}`, `reference answer set for ${caseId} (${source})`);
      return references[caseId];
    });
  }

  /** Pre-registration (20.5): hypothesis and main measure, timestamped, locked once the first reading or run starts. */
  async function preregister(id, body, ctx) {
    human(ctx);
    const study = await getStudy(id);
    const hasRuns = (await store.query('StudyLink', { where: (l) => l.study === id && l.kind === 'run' })).length > 0;
    if (study.preregistration?.lockedAt || (await answersOf(id)).length || hasRuns) throw new HttpError(409, 'Pre-registration is locked: the first reading or run has started');
    const hypothesis = text(body?.hypothesis, 2000); const mainMeasure = text(body?.mainMeasure, 400);
    if (!hypothesis || !mainMeasure) throw new HttpError(422, 'Write the hypothesis and the main measure');
    return store.transaction(async (tx) => {
      const cur = await tx.get('Study', id);
      const pre = { hypothesis, mainMeasure, registeredAt: tx.now(), by: pseudonym(ctx.actor.id), lockedAt: null };
      await tx.save('Study', { ...cur, preregistration: pre }, { updatedBy: ctx.actor.role });
      await log(tx, ctx, null, 'study.preregister', { study: id, mainMeasure }, `Study/${id}`, 'study pre-registered');
      return pre;
    });
  }
  const lock = async (tx, id, why) => { const cur = await tx.get('Study', id); if (cur?.preregistration && !cur.preregistration.lockedAt) await tx.save('Study', { ...cur, preregistration: { ...cur.preregistration, lockedAt: tx.now(), lockedBy: why } }, { updatedBy: 'system' }); };

  /** "My reading list" (20.1): this reader's assignments with progress; other readers' answers are never included. */
  async function myList(id, ctx) {
    human(ctx);
    const study = await getStudy(id);
    if (study.kind !== 'multi-reader') throw new HttpError(409, 'This is not a multi-reader study');
    const me = pseudonym(ctx.actor.id);
    const mine = (study.assignments || []).filter((a) => a.reader === me);
    if (!mine.length) throw new HttpError(403, 'You are not a reader in this study');
    const answers = (await answersOf(id)).filter((a) => a.reader === me);
    const now = Date.parse(store.now());
    const items = mine.map((a) => {
      const done = answers.find((x) => x.assignment === a.id);
      const earlier = answers.filter((x) => x.case === a.case && x.assignment !== a.id).sort((x, y) => String(x.readAt).localeCompare(String(y.readAt)));
      const availableAfter = earlier.length ? new Date(Date.parse(earlier[earlier.length - 1].readAt) + (study.design.washoutDays || 0) * DAY).toISOString() : null;
      const waiting = availableAfter && Date.parse(availableAfter) > now && !done;
      return { id: a.id, order: a.order, case: a.case, condition: a.condition, status: done ? 'done' : waiting ? 'washout' : 'pending', availableAfter, answeredAt: done?.readAt ?? null };
    }).sort((x, y) => x.order - y.order);
    return { study: { id, title: study.title }, reader: me, progress: { done: items.filter((i) => i.status === 'done').length, total: items.length }, next: items.find((i) => i.status === 'pending') || null, items };
  }

  /** A reading (20.1): one answer per assignment, refused during the washout; the first reading locks the pre-registration. */
  async function answer(id, body, ctx) {
    human(ctx);
    const study = await getStudy(id);
    if (study.kind !== 'multi-reader') throw new HttpError(409, 'This is not a multi-reader study');
    const researcher = ctx.actor.role === 'researcher';
    const reader = researcher && body?.reader ? String(body.reader) : pseudonym(ctx.actor.id);
    const a = (study.assignments || []).find((x) => x.id === body?.assignment) || (study.assignments || []).find((x) => x.reader === reader && x.case === body?.case && x.condition === body?.condition);
    if (!a) throw new HttpError(404, 'No such assignment for this reader');
    if (a.reader !== reader) throw new HttpError(403, 'That assignment belongs to another reader');
    const answers = await answersOf(id);
    if (answers.some((x) => x.assignment === a.id)) throw new HttpError(409, 'This case has already been answered under this condition');
    const earlier = answers.filter((x) => x.reader === reader && x.case === a.case);
    const washoutMs = (study.design.washoutDays || 0) * DAY;
    for (const e of earlier) if (Date.parse(store.now()) - Date.parse(e.readAt) < washoutMs) throw new HttpError(409, `Washout: this reader saw this case ${Math.round((Date.parse(store.now()) - Date.parse(e.readAt)) / DAY)} days ago; it opens again after ${study.design.washoutDays} days`);
    const ans = text(body?.answer, 400);
    if (!ans) throw new HttpError(422, 'Write an answer');
    const reference = study.references?.[a.case] || null;
    const correct = reference ? matches(ans, reference) : null;
    const doc = { resourceType: 'ReaderAnswer', id: randomUUID(), study: id, assignment: a.id, reader, readerKind: a.readerKind, case: a.case, condition: a.condition, order: a.order, answer: ans, correct, confidence: body?.confidence == null ? null : Math.max(0, Math.min(100, Number(body.confidence))), seconds: body?.seconds == null ? null : Math.max(0, Number(body.seconds)), changedAfterAi: Boolean(body?.changedAfterAi), aiSuggestion: body?.aiSuggestion ? text(body.aiSuggestion, 400) : null, runId: body?.runId ? String(body.runId) : null, readAt: store.now() };
    return store.transaction(async (tx) => {
      const saved = await tx.save('ReaderAnswer', doc, { updatedBy: ctx.actor.role });
      await lock(tx, id, 'first reading');
      await log(tx, ctx, doc.runId, 'study.reading', { study: id, assignment: a.id, condition: a.condition, correct }, `Study/${id}`, `reading by ${reader} (${a.condition})`);
      const { _seq, ...rest } = saved; return rest;
    });
  }
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  /** An answer matches the reference when it names every reference item (by word overlap), in plain terms. */
  function matches(ans, reference) {
    const items = String(reference.answer || '').split(';').map(norm).filter(Boolean);
    if (!items.length) return null;
    const a = norm(ans);
    return items.every((item) => item.split(' ').filter((w) => w.length > 3).some((w) => a.includes(w)));
  }

  /** Results (20.3): four views only, in plain words. Wrong AI suggestions only count for over-trust on sandbox branches with synthetic patients, which the study's runs are. */
  async function results(id) {
    const study = await getStudy(id);
    const answers = await answersOf(id);
    const readers = study.design?.readers || []; const conditions = study.design?.conditions || [];
    const by = (f) => { const m = new Map(); for (const a of answers) { const k = f(a); if (!m.has(k)) m.set(k, []); m.get(k).push(a); } return m; };
    const rate = (list, f) => { const v = list.filter((a) => f(a) != null); return v.length ? round(v.filter(f).length / v.length) : null; };
    const accuracy = readers.map((r) => ({ reader: r.id, kind: r.kind, byCondition: Object.fromEntries(conditions.map((c) => [c, { readings: answers.filter((a) => a.reader === r.id && a.condition === c).length, accuracy: rate(answers.filter((a) => a.reader === r.id && a.condition === c), (a) => a.correct) }])) }));
    const pairs = [];
    const byCase = by((a) => `${a.case}|${a.condition}`);
    for (let i = 0; i < readers.length; i += 1) for (let j = i + 1; j < readers.length; j += 1) { let n = 0; let agree = 0; for (const list of byCase.values()) { const x = list.find((a) => a.reader === readers[i].id); const y = list.find((a) => a.reader === readers[j].id); if (x && y) { n += 1; if (norm(x.answer) === norm(y.answer) || (x.correct != null && x.correct === y.correct)) agree += 1; } } if (n) pairs.push({ a: readers[i].id, b: readers[j].id, cases: n, agreement: round(agree / n), words: `${readers[i].id} and ${readers[j].id} gave the same answer on ${agree} of ${n} readings` }); }
    const time = conditions.map((c) => { const v = answers.filter((a) => a.condition === c && a.seconds != null).map((a) => a.seconds); return { condition: c, readings: v.length, meanSeconds: v.length ? round(v.reduce((x, y) => x + y, 0) / v.length, 1) : null, medianSeconds: v.length ? round([...v].sort((x, y) => x - y)[Math.floor(v.length / 2)], 1) : null }; });
    const withAi = answers.filter((a) => a.aiSuggestion);
    const wrongSuggestions = withAi.filter((a) => study.references?.[a.case] && !matches(a.aiSuggestion, study.references[a.case]));
    const overTrust = { wrongSuggestions: wrongSuggestions.length, acceptedWrong: wrongSuggestions.filter((a) => norm(a.answer) === norm(a.aiSuggestion) || a.correct === false).length, rate: wrongSuggestions.length ? round(wrongSuggestions.filter((a) => norm(a.answer) === norm(a.aiSuggestion) || a.correct === false).length / wrongSuggestions.length) : null, words: wrongSuggestions.length ? `${wrongSuggestions.filter((a) => norm(a.answer) === norm(a.aiSuggestion) || a.correct === false).length} of ${wrongSuggestions.length} wrong suggestions were accepted` : 'No wrong suggestions were shown yet' };
    return { study: { id, title: study.title, kind: study.kind }, preregistration: study.preregistration || null, readings: answers.length, accuracy, agreement: pairs, time, overTrust, references: Object.keys(study.references || {}).length };
  }

  /** Rows for the analysis table (20.4): one per reader, case and condition, with the task 10 columns from the linked run when there is one. */
  async function tableRows(id) {
    const study = await getStudy(id);
    const answers = (await answersOf(id)).sort((a, b) => a.reader.localeCompare(b.reader) || a.order - b.order);
    const rows = [];
    for (const a of answers) {
      let run = null; let st = null;
      if (a.runId) { run = await store.get('Run', a.runId); if (run) st = interactionStats(await store.query('TraceStep', { groupKey: run.id })); }
      rows.push({ snapshot: null, study: id, participant: a.reader, kind: a.readerKind, case: a.case, condition: a.condition, order: a.order, answer: a.answer, correct: a.correct, confidence: a.confidence, seconds: a.seconds, changedAfterAi: a.changedAfterAi, readAt: a.readAt, capabilities: (run?.capabilities || []).join(' '), draftsShown: st?.draftsShown ?? null, draftsUsed: st?.draftsUsed ?? null, editSize: st?.editSize ?? null, overrides: st?.overrides ?? null, asks: st?.asks ?? null, timeToAnswer: st?.timeToAnswer ?? null });
    }
    return rows;
  }

  function present(study, ctx) { const { _seq, ...s } = study; const me = pseudonym(ctx.actor.id); return { ...s, assignments: (s.assignments || []).map((a) => ({ ...a, mine: a.reader === me })), myReaderId: me }; }

  async function handle(req, url, body, ctx, parts) {
    const [area, id, op, op2] = parts; const m = req.method;
    if (area !== 'reader-studies' || !id) return null;
    if (op === 'design' && m === 'PUT') return { status: 200, body: await design(id, body, ctx) };
    if (op === 'reference' && op2 && m === 'PUT') return { status: 200, body: await setReference(id, op2, body, ctx) };
    if (op === 'preregistration' && m === 'PUT') return { status: 200, body: await preregister(id, body, ctx) };
    if (op === 'my-list' && m === 'GET') return { status: 200, body: await myList(id, ctx) };
    if (op === 'answers' && m === 'POST') return { status: 201, body: await answer(id, body, ctx) };
    if (op === 'results' && m === 'GET') return { status: 200, body: await results(id) };
    if (op === 'table' && m === 'GET') { human(ctx); return { status: 200, body: { columns: READER_COLUMNS, rows: await tableRows(id) } }; }
    if (!op && m === 'GET') return { status: 200, body: present(await getStudy(id), ctx) };
    return null;
  }
  return { handle, design, setReference, preregister, myList, answer, results, tableRows };
}
