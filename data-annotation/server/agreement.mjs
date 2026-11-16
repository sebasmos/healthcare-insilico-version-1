// My work, agreement between readers, and the adjudication queue (docs/STUDY-DESIGN.md 8).
//
// An answer is what a person hands in with "Next task": { label } for a decision or class, and/or a region as
// { mask: [cell numbers] } or { box: { x, y, width, height } }. Agreement on labels is Cohen's kappa for two
// readers and Fleiss' kappa for more; agreement on regions is the Dice score. A case where readers disagree
// beyond the study's limit goes to the adjudicator, whose answer becomes the reference. The readers' own
// answers are kept.
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { cohenKappa, fleissKappa, interpretKappa } from './kappa.mjs';
import { segDice, segHausdorff } from '../../pacs/server/seg.mjs';

const round = (x, n = 3) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** n) / 10 ** n);
const mean = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const OPEN = ['waiting', 'open'];

/** Dice score of two regions: 2 x overlap / (size a + size b). Masks are lists of cell numbers; boxes are rectangles. */
export function dice(a, b) {
  if (Array.isArray(a?.mask) && Array.isArray(b?.mask)) { const A = new Set(a.mask); const B = new Set(b.mask); if (!A.size && !B.size) return 1; let both = 0; for (const c of A) if (B.has(c)) both += 1; return (2 * both) / (A.size + B.size); }
  if (Array.isArray(a?.segmentations) || Array.isArray(b?.segmentations)) return segDice(a?.segmentations || [], b?.segmentations || []);
  if (Array.isArray(a?.regions) && Array.isArray(b?.regions)) return regionDice(a.regions, b.regions);
  if (a?.box && b?.box) { const w = Math.max(0, Math.min(a.box.x + a.box.width, b.box.x + b.box.width) - Math.max(a.box.x, b.box.x)); const h = Math.max(0, Math.min(a.box.y + a.box.height, b.box.y + b.box.height) - Math.max(a.box.y, b.box.y)); const sum = a.box.width * a.box.height + b.box.width * b.box.height; return sum ? (2 * w * h) / sum : 1; }
  return null;
}
const closed = (r) => Array.isArray(r.points) && r.points.length >= 3;
const inside = (pts, x, y) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i]; const [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
/** Dice of two readers' drawn regions: the shapes are filled on a shared grid, image by image, and the overlap counted. Lines and points have no area and are left out. */
export function regionDice(ra, rb, grid = 96) {
  const A = ra.filter(closed); const B = rb.filter(closed);
  if (!A.length && !B.length) return null;
  const where = (r) => `${r.on ?? ''}|${r.series ?? ''}|${r.frame ?? ''}`;
  let both = 0; let sizeA = 0; let sizeB = 0;
  for (const key of new Set([...A, ...B].map(where))) {
    const a = A.filter((r) => where(r) === key); const b = B.filter((r) => where(r) === key); const all = [...a, ...b].flatMap((r) => r.points);
    const minX = Math.min(...all.map((p) => p[0])); const maxX = Math.max(...all.map((p) => p[0])); const minY = Math.min(...all.map((p) => p[1])); const maxY = Math.max(...all.map((p) => p[1]));
    const w = Math.max(maxX - minX, 1e-9); const h = Math.max(maxY - minY, 1e-9);
    for (let i = 0; i < grid; i += 1) for (let j = 0; j < grid; j += 1) { const x = minX + ((i + 0.5) / grid) * w; const y = minY + ((j + 0.5) / grid) * h; const ia = a.some((r) => inside(r.points, x, y)); const ib = b.some((r) => inside(r.points, x, y)); if (ia) sizeA += 1; if (ib) sizeB += 1; if (ia && ib) both += 1; }
  }
  return sizeA + sizeB ? (2 * both) / (sizeA + sizeB) : null;
}
const pairs = (list) => list.flatMap((x, i) => list.slice(i + 1).map((y) => [x, y]));
/** How far the readers of one case agree, from 0 to 1: the share of reader pairs with the same label, and the mean Dice of their regions. */
export function caseAgreement(answers) {
  const labels = answers.map((a) => a?.label).filter((l) => l != null); const lp = pairs(labels);
  const drew = answers.filter((a) => a && (a.mask || a.box || a.regions || a.segmentations)); const regions = pairs(drew).map(([x, y]) => dice(x, y));
  const far = pairs(drew.filter((a) => a.segmentations)).map(([x, y]) => segHausdorff(x.segmentations, y.segmentations)).filter((v) => v != null);
  return { label: lp.length ? round(lp.filter(([x, y]) => x === y).length / lp.length) : null, dice: round(mean(regions)), ...(far.length ? { hausdorff: round(Math.max(...far), 2) } : {}) };
}

export function createAgreement({ store, studies, accounts, scores = null, legacy = null }) {
  const answered = (a) => a.state === 'closed' && a.answer && (a.answer.label != null || a.answer.mask || a.answer.box || a.answer.regions || a.answer.segmentations);
  const humanAttempts = async (studyId) => (await studies.attemptsOf(studyId)).filter((a) => a.participant.kind === 'person' && a.condition === 'human');
  const byTask = (list) => { const m = new Map(); for (const a of list) { if (!m.has(a.taskId)) m.set(a.taskId, []); m.get(a.taskId).push(a); } return m; };

  /** Agreement across a study: kappa on labels, Dice on regions, case by case and overall. */
  async function agreement(studyId) {
    const study = await studies.getStudy(studyId); if (study.status === 'draft') throw new HttpError(409, 'The study has not started');
    const adjByTask = new Map((await store.query('Adjudication', { groupKey: studyId })).map((x) => [x.taskId, x]));
    // A study brought over from a reader study or a labelling project has cases, not tasks: its answers are grouped by the case they were given for.
    const humans = await humanAttempts(studyId); const legacyCases = study.legacy ? [...new Set(humans.map((a) => a.caseRef).filter((c) => c != null))] : null;
    const tasks = legacyCases ? new Map(legacyCases.map((c) => [c, humans.filter((a) => a.caseRef === c)])) : byTask(humans); const cases = []; const rows = []; const pairRatings = new Map(); const dices = [];
    for (const t of legacyCases ? legacyCases.map((c) => ({ taskId: c, title: String(c) })) : study.frozen.tasks) {
      const list = (tasks.get(t.taskId) || []).filter(answered);
      const ag = caseAgreement(list.map((a) => a.answer));
      const adj = adjByTask.get(t.taskId); const ref = adj?.reference ?? null;
      const vsReference = ref ? list.map((a) => ({ reader: a.participantKey, attempt: a.id, label: ref.label != null && a.answer.label != null ? a.answer.label === ref.label : null, dice: round(dice(a.answer, ref)), hausdorff: a.answer.segmentations && ref.segmentations ? segHausdorff(a.answer.segmentations, ref.segmentations) : null })) : null;
      cases.push({ taskId: t.taskId, title: t.title, readers: list.length, assigned: (tasks.get(t.taskId) || []).length, ...ag, ...(vsReference ? { vsReference } : {}) });
      const labelled = list.filter((a) => a.answer.label != null);
      if (labelled.length >= 2) { rows.push(labelled.map((a) => String(a.answer.label))); for (const [x, y] of pairs(labelled)) { const k = [x.participantKey, y.participantKey].sort().join(' | '); if (!pairRatings.has(k)) pairRatings.set(k, []); pairRatings.get(k).push(x.participantKey < y.participantKey ? [String(x.answer.label), String(y.answer.label)] : [String(y.answer.label), String(x.answer.label)]); } }
      if (ag.dice != null) dices.push(ag.dice);
    }
    const sameCount = rows.length && rows.every((r) => r.length === rows[0].length);
    const raters = rows[0]?.length ?? 0;
    let kappa = null;
    if (rows.length && sameCount && raters === 2) kappa = cohenKappa(rows.map((r) => [r[0], r[1]]));
    else if (rows.length && sameCount && raters > 2) kappa = fleissKappa(rows);
    else if (pairRatings.size) { const each = [...pairRatings.values()].map((p) => cohenKappa(p)); kappa = { statistic: 'mean pairwise cohen', kappa: round(mean(each.map((k) => k.kappa)), 4), n: rows.length, pairs: each.length }; } // k readers per case: not every reader saw every case
    const hd = cases.map((c) => c.hausdorff).filter((v) => v != null);
    return { hausdorff: hd.length ? { worst: Math.max(...hd), mean: round(mean(hd), 2), cases: hd.length, unit: 'pixels' } : null, study: studyId, readers: (study.legacy ? study.participants : study.frozen.participants).filter((p) => p.kind === 'person').length, kappa: kappa ? { ...kappa, reading: kappa.kappa == null ? null : interpretKappa(kappa.kappa) } : null, dice: dices.length ? { mean: round(mean(dices)), cases: dices.length } : null, cases, limit: study.disagreementLimit };
  }

  // ---------- adjudication ----------
  const presentAdj = ({ _seq, meta, resourceType, _groupKey, ...a }) => a;
  /** Called when a person closes an attempt: once every assigned reader of that case has finished, agree or queue it. */
  async function onClosed(attempt) {
    if (attempt.participant.kind !== 'person' || attempt.condition !== 'human') return;
    const study = await studies.getStudy(attempt.study);
    const list = (await humanAttempts(attempt.study)).filter((a) => a.taskId === attempt.taskId);
    if (list.length < 2 || list.some((a) => OPEN.includes(a.state))) return;
    const given = list.filter(answered); if (given.length < 2) return;
    if ((await store.query('Adjudication', { groupKey: attempt.study })).some((x) => x.taskId === attempt.taskId)) return;
    const ag = caseAgreement(given.map((a) => a.answer));
    const worst = Math.min(...[ag.label, ag.dice].filter((x) => x != null));
    const agreed = worst >= study.disagreementLimit;
    const first = given[0].answer;
    await store.transaction((tx) => tx.save('Adjudication', {
      resourceType: 'Adjudication', id: randomUUID(), _groupKey: attempt.study, study: attempt.study, studyTitle: study.title, taskId: attempt.taskId, taskVersion: attempt.taskVersion, title: study.frozen.tasks.find((t) => t.taskId === attempt.taskId)?.title ?? '',
      answers: given.map((a) => ({ attempt: a.id, reader: a.participantKey, answer: a.answer, runId: a.runId })), agreement: ag, limit: study.disagreementLimit,
      status: agreed ? 'agreed' : 'open', adjudicator: study.adjudicator, reference: agreed && ag.label === 1 && ag.dice == null ? { label: first.label } : null, // readers who agree on a drawing have no single reference until one is chosen decidedBy: null, decidedAt: null, at: tx.now(),
    }, { updatedBy: 'study' }));
  }
  studies.onClosed(onClosed);

  const mayAdjudicate = (adj, actor) => actor.kind === 'human' && (actor.role === 'researcher' || adj.adjudicator === actor.id);
  async function queue(ctx) { return (await store.query('Adjudication', { where: (a) => a.status === 'open' && mayAdjudicate(a, ctx.actor) })).map(presentAdj).sort((a, b) => String(a.at).localeCompare(String(b.at))); }
  async function decide(id, body, ctx) {
    const adj = await store.get('Adjudication', id); if (!adj) throw new HttpError(404, 'No such case to adjudicate');
    if (!mayAdjudicate(adj, ctx.actor)) throw new HttpError(403, 'This case is for its adjudicator');
    if (adj.answers.some((a) => a.reader === `person:${ctx.actor.id}`)) throw new HttpError(403, 'A reader does not adjudicate their own case');
    if (adj.status !== 'open') throw new HttpError(409, 'This case is already settled');
    let ref = body?.answer;
    if (body?.useAttempt) { const chosen = adj.answers.find((a) => a.attempt === String(body.useAttempt)); if (!chosen) throw new HttpError(422, 'That reader\'s answer is not one of this case\'s answers'); ref = chosen.answer; }
    if (!ref || (ref.label == null && !ref.mask && !ref.box && !ref.regions && !ref.segmentations)) throw new HttpError(422, 'Give the reference answer: a label, a region, or one reader\'s drawing');
    return store.transaction(async (tx) => {
      const { _seq, meta, ...cur } = await tx.get('Adjudication', id);
      const saved = await tx.save('Adjudication', { ...cur, status: 'resolved', reference: ref, note: body?.note ? String(body.note).slice(0, 1000) : null, decidedBy: ctx.actor.id, decidedAt: tx.now() }, { updatedBy: ctx.actor.role });
      await recordAction(tx, { actor: ctx.actor, kind: 'update', action: 'adjudication.decide', args: { adjudication: id, study: adj.study, task: adj.taskId }, entityRef: `Adjudication/${id}`, versionId: saved.meta.versionId, description: 'disagreement settled by the adjudicator' });
      return presentAdj(saved);
    });
  }

  /** Everything waiting for this person: their attempts in order (next one on top), grades to give, cases to adjudicate. */
  async function myWork(ctx) {
    if (ctx.actor.kind !== 'human') throw new HttpError(403, 'My work is for people');
    const mine = await studies.queueOf(ctx.actor.id); const titles = new Map();
    const out = [];
    for (const a of mine) {
      if (!titles.has(a.study)) titles.set(a.study, await studies.getStudy(a.study));
      const st = titles.get(a.study); if (st.status !== 'started' && OPEN.includes(a.state)) continue;
      out.push({ id: a.id, study: a.study, studyTitle: st.title, studyKind: st.kind, task: st.frozen.tasks.find((t) => t.taskId === a.taskId)?.title ?? 'Task', taskId: a.taskId, position: a.position, condition: a.condition, state: a.state, branch: a.branch, runId: a.humanRunId || a.runId, withAgent: a.condition === 'hitl' ? a.participant.id : null, labelScheme: st.frozen.labelScheme, scores: a.scores });
    }
    const todo = out.filter((a) => OPEN.includes(a.state)).sort((x, y) => (x.state === 'open' ? -1 : 0) - (y.state === 'open' ? -1 : 0) || x.study.localeCompare(y.study) || x.position - y.position);
    const nextIds = new Set(); const seen = new Set(); for (const a of todo) if (!seen.has(a.study)) { seen.add(a.study); nextIds.add(a.id); }
    // Reading lists and labelling queues: the person's work in reader studies and labelling projects.
    const other = [];
    if (legacy) {
      for (const st of await store.query('Study', { where: (x) => x.kind === 'multi-reader' && x.status !== 'archived' && (x.assignments || []).some((as) => as.reader === ctx.actor.id) })) {
        const done = new Set((await store.query('ReaderAnswer', { where: (r) => r.study === st.id && r.reader === ctx.actor.id })).map((r) => r.assignment)); const left = st.assignments.filter((as) => as.reader === ctx.actor.id && !done.has(as.id)).length;
        if (left) other.push({ kind: 'reading', title: st.title, left, study: await legacy.twinFor('Study', st.id) });
      }
      for (const p of await store.query('AnnotationProject', { where: (x) => x.status === 'active' })) {
        const labels = await store.query('Observation', { where: (o) => o.category?.[0]?.coding?.[0]?.code === 'annotation' && o.code?.coding?.[0]?.code === p.id });
        const by = (item) => labels.filter((o) => (o.extension || []).some((e) => e.valueString === item.id)); const mine = (o) => o.performer?.[0]?.identifier?.value === ctx.actor.id;
        const left = (p.items || []).filter((it) => { const reads = by(it); return reads.length < (p.annotatorsPerItem || 1) && !reads.some(mine); }).length;
        if (left && ['researcher', 'physician', 'nurse'].includes(ctx.actor.role)) other.push({ kind: 'labelling', title: p.name, left, study: await legacy.twinFor('AnnotationProject', p.id) });
      }
    }
    return {
      other,
      next: todo.find((a) => nextIds.has(a.id)) ?? null,
      todo: todo.map((a) => ({ ...a, canOpen: nextIds.has(a.id) })), done: out.filter((a) => !OPEN.includes(a.state)).length,
      toGrade: scores ? (await scores.queue(ctx).catch(() => [])).length : 0, toAdjudicate: (await queue(ctx)).length,
    };
  }

  async function handle(req, url, body, ctx) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); const m = req.method;
    if (parts[0] === 'my-work' && m === 'GET') return { status: 200, body: await myWork(ctx) };
    if (parts[0] === 'agreement' && parts[1] && m === 'GET') { if (ctx.actor.role !== 'researcher') throw new HttpError(403, 'Agreement is for the Researcher'); return { status: 200, body: { ...(await agreement(parts[1])), adjudications: (await store.query('Adjudication', { groupKey: parts[1] })).map(presentAdj) } }; }
    if (parts[0] === 'adjudications' && !parts[1] && m === 'GET') return { status: 200, body: { queue: await queue(ctx) } };
    if (parts[0] === 'adjudications' && parts[1] && m === 'POST') return { status: 200, body: await decide(parts[1], body, ctx) };
    throw new HttpError(404, 'No such action');
  }
  return { handle, agreement, myWork, queue };
}
