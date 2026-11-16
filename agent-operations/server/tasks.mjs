// Library tasks (docs/STUDY-DESIGN.md 3.1). A task is an EvalCase: patient, as-of time, instruction, checks,
// rubric, split and a version number. A task is never changed in place: a change writes version n+1 and keeps
// a frozen copy of every version (TaskVersion), so a study or an old result always shows the task as it was.
//
// Splits:  train       usable in runs and in training exports
//          validation  may be attempted in runs (monitoring, choosing a checkpoint); never exported as training data
//          eval        studies only; refused in runs
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';

export const SPLITS = ['train', 'validation', 'eval'];
/** The split of a task record, with names from earlier builds folded in. */
export const splitOf = (task) => ({ 'held-out': 'eval', heldout: 'eval', test: 'eval', practice: 'train' }[task?.split] || (SPLITS.includes(task?.split) ? task.split : 'train'));
export const exportableForTraining = (task) => splitOf(task) === 'train';
export const allowedInRun = (task) => splitOf(task) !== 'eval';

/** A rubric: up to 12 things an expert grades, each on its own whole-number scale. */
export function normalizeRubric(input) {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > 12) throw new HttpError(422, 'rubric must be a list of at most 12 items');
  const seen = new Set();
  return input.map((r, i) => {
    const label = String(r?.label || '').trim().slice(0, 200); if (!label) throw new HttpError(422, `Rubric item ${i + 1}: a label is required`);
    const id = String(r.id || label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).slice(0, 40) || `item-${i + 1}`;
    if (seen.has(id)) throw new HttpError(422, `Rubric item "${id}" appears twice`); seen.add(id);
    const min = Number.isInteger(r.min) ? r.min : 1; const max = Number.isInteger(r.max) ? r.max : 5;
    if (min >= max || max - min > 10) throw new HttpError(422, `Rubric item "${label}": the scale must run from a lower to a higher whole number, at most 10 apart`);
    return { id, label, min, max, ...(r.guide ? { guide: String(r.guide).slice(0, 500) } : {}) };
  });
}

const FROZEN_FIELDS = ['title', 'scenario', 'task', 'patient', 'subject', 'asOf', 'goldActions', 'avoid', 'verifier', 'graderConfig', 'rubric', 'split', 'tags', 'outcomeHorizons', 'timeline', 'slug'];
const snapshotOf = (task) => ({ resourceType: 'TaskVersion', id: `${task.id}.v${task.taskVersion ?? 1}`, taskId: task.id, version: task.taskVersion ?? 1, ...Object.fromEntries(FROZEN_FIELDS.filter((k) => task[k] !== undefined).map((k) => [k, task[k]])) });
const presentVersion = ({ _seq, meta, resourceType, ...v }) => ({ ...v, savedAt: meta?.lastUpdated ?? null });

export function createTasks({ store }) {
  const get = async (id) => { const t = await store.get('EvalCase', id); if (!t) throw new HttpError(404, `No task "${id}"`); return t; };

  /** The task as it was at one version (the current one when version is left out). */
  async function taskAt(id, version = null) {
    const cur = await get(id); const curV = cur.taskVersion ?? 1;
    if (version == null || Number(version) === curV) return { ...snapshotOf(cur), plant: cur.plant, current: true };
    const snap = await store.get('TaskVersion', `${id}.v${Number(version)}`);
    if (!snap) throw new HttpError(404, `Task "${id}" has no version ${version}`);
    return { ...snap, plant: cur.plant, current: false };
  }

  async function versions(id) {
    const cur = await get(id);
    const old = (await store.query('TaskVersion', { where: (v) => v.taskId === id })).filter((v) => v.version !== (cur.taskVersion ?? 1));
    return [...old.map(presentVersion), { ...presentVersion({ ...snapshotOf(cur), meta: cur.meta }), current: true }].sort((a, b) => a.version - b.version);
  }

  /** Change a task: writes the next version and keeps the old one. Only these fields may change. */
  async function revise(id, changes, actor) {
    const cur = await get(id);
    const allowed = ['title', 'scenario', 'task', 'rubric', 'split', 'tags', 'avoid', 'goldActions'];
    const unknown = Object.keys(changes || {}).filter((k) => !allowed.includes(k));
    if (unknown.length) throw new HttpError(422, `These cannot be changed on a task: ${unknown.join(', ')}. To use another patient or time, make a new task.`);
    const next = {};
    if (changes.title !== undefined) { next.title = String(changes.title).trim().slice(0, 160); if (!next.title) throw new HttpError(422, 'title cannot be empty'); }
    if (changes.scenario !== undefined) next.scenario = String(changes.scenario).slice(0, 1000);
    if (changes.task !== undefined) { next.task = String(changes.task).trim().slice(0, 500); if (!next.task) throw new HttpError(422, 'The instruction cannot be empty'); }
    if (changes.rubric !== undefined) next.rubric = normalizeRubric(changes.rubric);
    if (changes.split !== undefined) { if (!SPLITS.includes(changes.split)) throw new HttpError(422, `split must be one of: ${SPLITS.join(', ')}`); next.split = changes.split; }
    if (changes.tags !== undefined) next.tags = (Array.isArray(changes.tags) ? changes.tags : []).map((t) => String(t).slice(0, 30)).slice(0, 12);
    if (changes.avoid !== undefined) { if (!Array.isArray(changes.avoid)) throw new HttpError(422, 'avoid must be a list'); next.avoid = changes.avoid.slice(0, 30); }
    if (changes.goldActions !== undefined) { if (!Array.isArray(changes.goldActions) || !changes.goldActions.length) throw new HttpError(422, 'At least one check is required'); next.goldActions = changes.goldActions.slice(0, 30); }
    if (!Object.keys(next).length) throw new HttpError(422, 'Nothing to change');
    return store.transaction(async (tx) => {
      const { _seq, meta, ...base } = await tx.get('EvalCase', id);
      const from = base.taskVersion ?? 1;
      if (!(await tx.get('TaskVersion', `${id}.v${from}`))) await tx.save('TaskVersion', snapshotOf({ ...base, taskVersion: from }), { updatedBy: actor.role });
      const saved = await tx.save('EvalCase', { ...base, ...next, taskVersion: from + 1 }, { updatedBy: actor.role });
      await tx.save('TaskVersion', snapshotOf(saved), { updatedBy: actor.role });
      await recordAction(tx, { actor, kind: 'update', action: 'task.revise', args: { task: id, from, to: from + 1, changed: Object.keys(next) }, entityRef: `EvalCase/${id}`, versionId: saved.meta.versionId, description: `task "${saved.title}" is now version ${from + 1}` });
      return saved;
    });
  }

  return { taskAt, versions, revise, get };
}
