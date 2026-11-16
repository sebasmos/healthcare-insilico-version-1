// Training runs (docs/STUDY-DESIGN.md 4.2 and 6). A run is made automatically the first time an agent sends
// an attempt under a run name not seen before for that agent, from the API or from the dashboard. It only
// grows as attempts arrive. Eval-split tasks are refused; validation tasks are allowed for monitoring.
import { createHash } from 'node:crypto';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { allowedInRun, splitOf } from './tasks.mjs';

const QUIET_MS = 30 * 60e3;
export const RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;
export const runIdOf = (agentId, name) => `tr-${createHash('sha256').update(`${agentId}\n${name}`).digest('hex').slice(0, 24)}`;

/** The four things every environment call must carry besides the key: which are missing, in plain words. */
export function namedOrRefuse(src, { needAttempt }) {
  const task = src?.task ?? src?.taskId; const run = src?.run; const seedRaw = src?.seed; const attempt = src?.attempt ?? src?.episodeId;
  const seed = typeof seedRaw === 'string' && /^-?\d+$/.test(seedRaw) ? Number(seedRaw) : seedRaw;
  const missing = [];
  if (typeof task !== 'string' || !task) missing.push('task');
  if (typeof run !== 'string' || !run) missing.push('run (the run name)');
  if (!Number.isInteger(seed)) missing.push('seed (a whole number)');
  if (needAttempt && (typeof attempt !== 'string' || !attempt)) missing.push('attempt (the id reset returned)');
  if (missing.length) throw new HttpError(422, `Every call must say which agent (from the key), task, run name and seed it is for. Missing: ${missing.join(', ')}`, 'missing-fields');
  if (!RUN_NAME.test(run)) throw new HttpError(422, 'The run name is 1 to 80 letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit');
  return { task, run, seed, attempt: attempt ?? null };
}

export function createTrainingRuns({ store, rl = null }) {
  const statusOf = (r) => (r.status === 'finished' ? 'finished' : Date.now() - Date.parse(r.lastAt) > QUIET_MS ? 'finished' : 'running');
  const present = ({ _seq, meta, resourceType, ...r }) => ({ ...r, status: statusOf(r), tags: [r.source === 'api' ? 'API' : 'Dashboard'] });

  /** Refuses eval tasks, then finds or makes the run and counts the attempt. Returns the link stored on the attempt's Run. */
  async function admit({ agent, name, task, seed, source = 'api', taskSet = null, actor }) {
    if (!allowedInRun(task)) {
      await store.transaction((tx) => recordAction(tx, { actor, kind: 'execute', action: 'run.refuse-eval', args: { agent: agent.id, run: name, task: task.id }, outcome: '4', entityRef: `EvalCase/${task.id}`, description: 'an eval-split task was refused for a training run' }));
      throw new HttpError(403, 'This task is in the eval split: it can only be attempted inside a study, never in a training run', 'eval-refused');
    }
    const id = runIdOf(agent.id, name);
    await store.transaction(async (tx) => {
      const cur = await tx.get('TrainingRun', id);
      if (cur) { const { _seq, meta, ...doc } = cur; await tx.save('TrainingRun', { ...doc, attempts: doc.attempts + 1, validationAttempts: doc.validationAttempts + (splitOf(task) === 'validation' ? 1 : 0), seeds: [...new Set([...doc.seeds, seed])].slice(-500), tasks: [...new Set([...doc.tasks, task.id])], taskSet: doc.taskSet ?? taskSet, lastAt: tx.now(), status: 'running' }, { updatedBy: 'run' }); return; }
      const saved = await tx.save('TrainingRun', { resourceType: 'TrainingRun', id, name, agentId: agent.id, version: agent.version ?? null, source, taskSet, attempts: 1, validationAttempts: splitOf(task) === 'validation' ? 1 : 0, seeds: [seed], tasks: [task.id], startedAt: tx.now(), lastAt: tx.now(), status: 'running' }, { updatedBy: 'run' });
      await recordAction(tx, { actor, kind: 'create', action: 'run.create', args: { run: id, name, agent: agent.id, source }, entityRef: `TrainingRun/${id}`, versionId: saved.meta.versionId, description: `training run "${name}" started by its first attempt` });
    });
    return { run: id, runName: name, task: task.id, taskVersion: task.taskVersion ?? 1, condition: 'training', seed, split: splitOf(task) };
  }
  async function finish(agentId, name, actor) {
    const cur = await store.get('TrainingRun', runIdOf(agentId, name)); if (!cur) throw new HttpError(404, `No run "${name}" for this agent`);
    const { _seq, meta, ...doc } = cur;
    return present(await store.transaction(async (tx) => { const s = await tx.save('TrainingRun', { ...doc, status: 'finished', finishedAt: tx.now() }, { updatedBy: 'run' }); await recordAction(tx, { actor, kind: 'update', action: 'run.finish', args: { run: s.id }, entityRef: `TrainingRun/${s.id}`, versionId: s.meta.versionId, description: `training run "${name}" finished` }); return s; }));
  }
  const list = async () => (await store.query('TrainingRun')).map(present).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  const attemptsOf = async (id) => (await store.query('Run', { where: (r) => r.attempt?.run === id })).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));

  /** Launch from the dashboard: the agent attempts every train and validation task of a task set under one run name. */
  async function launch(body, ctx) {
    if (ctx.actor.kind !== 'human' || ctx.actor.role !== 'researcher') throw new HttpError(403, 'Only a Researcher launches a training run');
    const name = String(body?.name || '').trim(); if (!RUN_NAME.test(name)) throw new HttpError(422, 'Give the run a name: 1 to 80 letters, digits, spaces, dots, dashes or underscores');
    const agent = await store.get('Agent', String(body?.agentId || '')); if (!agent) throw new HttpError(422, 'Choose a registered agent');
    const set = await store.get('TaskSet', String(body?.taskSet || '')); if (!set) throw new HttpError(422, 'Choose a task set');
    const seed = Number.isInteger(body?.seed) ? body.seed : 1; const rounds = Math.min(20, Math.max(1, Number(body?.rounds) || 1));
    const cases = []; for (const t of set.tasks) { const c = await store.get('EvalCase', t.taskId); if (c) cases.push(c); }
    const usable = cases.filter(allowedInRun);
    if (!usable.length) throw new HttpError(422, 'This task set has no train or validation tasks: eval tasks are never used in a run');
    if (await store.get('TrainingRun', runIdOf(agent.id, name))) throw new HttpError(409, `This agent already has a run called "${name}"`);
    const work = (async () => { for (let r = 0; r < rounds; r += 1) for (const c of usable) { const link = await admit({ agent, name, task: c, seed: seed + r, source: 'dashboard', taskSet: set.id, actor: ctx.actor }); await rl.attemptCase(c, agent, { mode: 'rl-generate', seed: seed + r, actor: ctx.actor, batch: link.run, link }).catch(() => {}); } await finish(agent.id, name, ctx.actor).catch(() => {}); })();
    pending.set(runIdOf(agent.id, name), work.catch(() => {}));
    return { id: runIdOf(agent.id, name), name, agentId: agent.id, taskSet: set.id, planned: usable.length * rounds, skippedEval: cases.length - usable.length };
  }
  const pending = new Map();

  async function handle(req, url, body, ctx) {
    const parts = url.pathname.split('/').filter(Boolean).slice(2); const m = req.method;
    if (ctx.actor.kind !== 'human' || !['researcher', 'physician', 'nurse'].includes(ctx.actor.role)) throw new HttpError(403, 'Training runs are read and launched by staff; agents use the environment API');
    if (!parts.length && m === 'GET') return { status: 200, body: { runs: await list() } };
    if (!parts.length && m === 'POST') return { status: 202, body: await launch(body, ctx) };
    const cur = await store.get('TrainingRun', parts[0]); if (!cur) throw new HttpError(404, 'No such run');
    if (parts.length === 1 && m === 'GET') return { status: 200, body: { ...present(cur), attemptList: (await attemptsOf(cur.id)).map((r) => ({ id: r.id, task: r.attempt.task, taskVersion: r.attempt.taskVersion, seed: r.attempt.seed, split: r.attempt.split, startedAt: r.startedAt, endedAt: r.endedAt, endReason: r.endReason ?? null, scores: r.scores ?? null })) } };
    throw new HttpError(404, 'No such run action');
  }
  return { admit, finish, list, attemptsOf, handle, launch, idle: async (id) => { await pending.get(id); } };
}
