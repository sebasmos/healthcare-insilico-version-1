// The simulation clock (plan-master task 12). Every run started from a
// scenario has a clock: real time, accelerated, jump to next event, or
// chapters. Simulated time is derived from the wall clock and the run's
// settings; jumps and chapter starts move it explicitly. Agents never wait
// in real time. Events are released into the chart at their simulated
// times, never early, through the normal store (recordedAt = simulated time).
import { HttpError } from './http.mjs';
import { recordAction } from './audit.mjs';
export const CLOCK_MODES = ['real', 'accelerated', 'jump', 'chapters'];
/** "T+2h 15m" for people. */
export function fmtAt(minutes) {
  const n = Math.round(minutes || 0); const sign = n < 0 ? '-' : '+'; let a = Math.abs(n);
  const d = Math.floor(a / 1440); a -= d * 1440; const h = Math.floor(a / 60); const m = a - h * 60;
  return `T${sign}${[d ? `${d}d` : '', h ? `${h}h` : '', m || (!d && !h) ? `${m}m` : ''].filter(Boolean).join(' ')}`;
}

/** Clock settings stored on a Run when it starts from a scenario. */
export function newClock({ mode = 'real', speed = 60, t0, chapters = [], lengthMinutes = 0 }) {
  if (!CLOCK_MODES.includes(mode)) throw new HttpError(422, `clock must be one of ${CLOCK_MODES.join(', ')}`);
  const spd = Math.max(1, Math.min(3600, Number(speed) || 60));
  return { mode, speed: mode === 'accelerated' ? spd : 1, t0, t0Real: t0, simAt: t0, pausedAt: null, pausedMs: 0, lengthMinutes, chapters: chapters.map((c, i) => ({ index: i, title: c.title, at: c.at })), chapter: mode === 'chapters' ? 0 : null, finished: false };
}

/** Simulated "now" for a run, as an ISO string. */
export function simNow(run, wall = Date.now()) {
  const c = run?.sim;
  if (!c) return null;
  const wallMs = typeof wall === 'number' ? wall : Date.parse(wall);
  if (c.mode === 'jump' || c.mode === 'chapters') return c.simAt;
  const pausedMs = c.pausedMs + (c.pausedAt ? Math.max(0, wallMs - Date.parse(c.pausedAt)) : 0);
  const elapsed = Math.max(0, wallMs - Date.parse(c.t0Real) - pausedMs);
  return new Date(Date.parse(c.t0) + elapsed * (c.mode === 'accelerated' ? c.speed : 1)).toISOString();
}
export const simMinutes = (run, wall) => (run?.sim ? Math.round((Date.parse(simNow(run, wall)) - Date.parse(run.sim.t0)) / 60000) : null);

export function createSimClock({ store, release }) {
  const stepsOf = (runId) => store.query('TraceStep', { groupKey: runId });
  const human = (ctx) => { if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only a person can move or pause a run\'s clock'); };
  const patch = (tx, id, fn) => tx.get('Run', id).then((r) => tx.save('Run', { ...r, sim: fn(r.sim) }, { updatedBy: 'system' }));
  const openRun = async (id) => { const run = await store.get('Run', id); if (!run) throw new HttpError(404, `No run ${id}`); if (!run.sim) throw new HttpError(409, 'This run has no simulation clock (it did not start from a scenario)'); return run; };

  /** What the clock shows: simulated and real time, the mode, the chapter, what is next. */
  async function status(run) {
    const wall = store.now();
    const sim = simNow(run, wall);
    const pending = (run.timeline || []).filter((e) => !e.releasedAt).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const next = pending[0] || null;
    const since = run.sim.mode === 'chapters' ? (run.timeline || []).filter((e) => e.releasedAt && e.chapter === run.sim.chapter).map((e) => ({ id: e.id, title: e.title || e.kind, at: e.at })) : [];
    return { mode: run.sim.mode, speed: run.sim.speed, simulated: sim, real: wall, elapsedMinutes: simMinutes(run, wall), elapsedLabel: fmtAt(simMinutes(run, wall)), paused: Boolean(run.sim.pausedAt), finished: run.sim.finished || (!next && run.sim.mode !== 'real'), next: next ? { id: next.id, title: next.title || next.kind, at: next.at, inMinutes: Math.round((Date.parse(next.at) - Date.parse(sim)) / 60000) } : null, chapter: run.sim.mode === 'chapters' ? { index: run.sim.chapter, of: run.sim.chapters.length, title: run.sim.chapters[run.sim.chapter]?.title ?? null, since } : null, chapters: run.sim.chapters, lengthMinutes: run.sim.lengthMinutes, t0: run.sim.t0, task: run.goal || run.scenario?.title || null, study: run.study || null };
  }

  /** Jump mode: the clock moves to the next event (or the end), and everything up to it is released. */
  async function next(run, actor) {
    if (run.endedAt) throw new HttpError(409, 'This run has ended');
    if (!['jump', 'chapters'].includes(run.sim.mode)) throw new HttpError(409, 'Only a jump-to-next-event or chapters clock can be moved by hand');
    const pending = (run.timeline || []).filter((e) => !e.releasedAt).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (!pending.length) { await store.transaction((tx) => patch(tx, run.id, (c) => ({ ...c, finished: true }))); return { advanced: false, status: await status(await store.get('Run', run.id)) }; }
    const target = pending[0].at;
    const from = run.sim.simAt;
    await store.transaction(async (tx) => {
      await patch(tx, run.id, (c) => ({ ...c, simAt: target }));
      await recordAction(tx, { runId: run.id, actor, kind: 'execute', action: 'clock.jump', args: { from, to: target, minutes: Math.round((Date.parse(target) - Date.parse(from)) / 60000) }, branch: run.branch, entityRef: `Run/${run.id}`, description: `clock jumped to ${target}` });
    });
    const out = await release(await store.get('Run', run.id), { actor });
    return { advanced: true, from, to: target, released: out.released, skipped: out.skipped, turns: out.turns, status: await status(await store.get('Run', run.id)) };
  }

  /** Pause and resume (human sessions): the simulated clock stops with the person. */
  async function pause(run, actor, paused) {
    if (run.endedAt) throw new HttpError(409, 'This run has ended');
    await store.transaction(async (tx) => {
      await patch(tx, run.id, (c) => (paused ? { ...c, pausedAt: c.pausedAt || store.now() } : { ...c, pausedAt: null, pausedMs: c.pausedMs + (c.pausedAt ? Math.max(0, Date.parse(store.now()) - Date.parse(c.pausedAt)) : 0) }));
      await recordAction(tx, { runId: run.id, actor, kind: 'execute', action: paused ? 'clock.pause' : 'clock.resume', args: { simulated: simNow(run, store.now()) }, branch: run.branch, entityRef: `Run/${run.id}`, description: `clock ${paused ? 'paused' : 'resumed'}` });
    });
    return status(await store.get('Run', run.id));
  }

  /** Chapters: start chapter i. Everything before its time is already in the chart; the reader gets "what happened since". */
  async function startChapter(run, index, actor) {
    if (run.sim.mode !== 'chapters') throw new HttpError(409, 'This run does not use chapters');
    const ch = run.sim.chapters[index];
    if (!ch) throw new HttpError(404, `No chapter ${index + 1}`);
    const at = new Date(Date.parse(run.sim.t0) + ch.at * 60000).toISOString();
    await store.transaction(async (tx) => {
      await patch(tx, run.id, (c) => ({ ...c, chapter: index, simAt: at }));
      await recordAction(tx, { runId: run.id, actor, kind: 'execute', action: 'chapter.start', args: { chapter: index + 1, of: run.sim.chapters.length, title: ch.title, at }, branch: run.branch, entityRef: `Run/${run.id}`, description: `chapter ${index + 1} of ${run.sim.chapters.length}: ${ch.title}` });
    });
    const out = await release(await store.get('Run', run.id), { actor, chapter: index });
    const fresh = await store.get('Run', run.id);
    return { chapter: index, title: ch.title, released: out.released, since: (fresh.timeline || []).filter((e) => e.releasedAt && e.chapter === index).map((e) => ({ id: e.id, title: e.title || e.kind, at: e.at, kind: e.kind })), status: await status(fresh) };
  }

  async function handle(req, url, body, ctx, parts) {
    const [area, id, op] = parts; const m = req.method;
    if (area !== 'clock' || !id) return null;
    const run = await openRun(id);
    if (parts.length === 2 && m === 'GET') return { status: 200, body: await status(run) };
    human(ctx);
    if (op === 'next' && m === 'POST') return { status: 200, body: await next(run, ctx.actor) };
    if (op === 'pause' && m === 'POST') return { status: 200, body: await pause(run, ctx.actor, true) };
    if (op === 'resume' && m === 'POST') return { status: 200, body: await pause(run, ctx.actor, false) };
    if (op === 'release' && m === 'POST') return { status: 200, body: await release(run, { actor: ctx.actor }) };
    if (op === 'chapter' && m === 'POST') return { status: 200, body: await startChapter(run, Number(body?.index ?? (run.sim.chapter ?? 0) + 1), ctx.actor) };
    return null;
  }
  return { handle, status, next, pause, startChapter };
}
