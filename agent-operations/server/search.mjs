// The Library's list and search (docs/STUDY-DESIGN.md 9).
//   GET /agent-ops/library-list   every agent and person: status, version or role, last active
//   GET /agent-ops/search         attempts across studies and training runs, filtered by
//                                 q, task, study, run, agent, version, person, mode, from, to, outcome
import { HttpError } from '../../platform/server/http.mjs';

const MODES = ['shadow', 'hitl', 'autonomous', 'redteam', 'human', 'training'];
const OUTCOMES = ['pass', 'fail', 'unsafe', 'ungraded', 'open'];
const outcomeOf = (state, scores) => (['waiting', 'open'].includes(state) ? 'open' : scores?.safetyViolations > 0 ? 'unsafe' : scores?.success ? (scores.success.pass ? 'pass' : 'fail') : 'none');

export function createSearch({ store, studies, accounts }) {
  const staff = (ctx) => { if (ctx.actor.kind !== 'human' || !['researcher', 'physician', 'nurse'].includes(ctx.actor.role)) throw new HttpError(403, 'The Library is for staff'); };

  async function list(ctx) {
    const runs = await store.query('Run', { where: (r) => Boolean(r.agentId) });
    const last = new Map(); for (const r of runs) { const at = r.endedAt || r.startedAt; if (!last.has(r.agentId) || at > last.get(r.agentId)) last.set(r.agentId, at); }
    const agents = (await store.query('Agent')).map((a) => ({ kind: 'agent', id: a.id, name: a.name, status: !a.enabled ? 'Off' : a.approval?.status === 'pending' ? 'Waiting for approval' : a.approval?.status === 'refused' ? 'Refused' : 'On', detail: `v${a.version}`, version: a.version, lastActive: last.get(a.id) ?? null }));
    const people = ctx.actor.role === 'researcher' ? (await accounts.people()).map((p) => ({ kind: 'person', id: p.id, name: p.name, status: { invited: 'Invited', active: 'Active', off: 'Off' }[p.status] || p.status, detail: `${p.role[0].toUpperCase()}${p.role.slice(1)}`, role: p.role, specialty: p.specialty, seniority: p.seniority, credentialed: p.credentialed, email: p.email, lastActive: p.lastActive })) : [];
    return { rows: [...agents, ...people].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)), modes: MODES, outcomes: OUTCOMES };
  }

  async function search(params, ctx) {
    const f = Object.fromEntries(['q', 'task', 'study', 'run', 'agent', 'version', 'person', 'mode', 'from', 'to', 'outcome'].map((k) => [k, (params.get(k) || '').trim()]));
    if (f.mode && !MODES.includes(f.mode)) throw new HttpError(422, `mode is one of: ${MODES.join(', ')}`);
    if (f.outcome && !OUTCOMES.includes(f.outcome)) throw new HttpError(422, `outcome is one of: ${OUTCOMES.join(', ')}`);
    for (const k of ['from', 'to']) if (f[k] && Number.isNaN(Date.parse(f[k]))) throw new HttpError(422, `${k} is not a date`);
    const showPeople = ctx.actor.role === 'researcher';
    const people = new Map((await accounts.people()).map((p) => [p.id, p])); const agents = new Map((await store.query('Agent')).map((a) => [a.id, a])); const taskTitle = new Map((await store.query('EvalCase')).map((c) => [c.id, c.title]));
    const rows = [];
    for (const study of await store.query('EvalStudy', { where: (s) => s.status !== 'draft' && (!f.study || s.id === f.study) })) {
      if (f.run) break;
      const titles = new Map(study.frozen.tasks.map((t) => [t.taskId, t.title]));
      for (const a of await studies.attemptsOf(study.id)) {
        const isAgent = a.participant.kind === 'agent';
        rows.push({ kind: 'study', id: a.id, runId: a.runId, container: study.title, containerId: study.id, taskId: a.taskId, task: titles.get(a.taskId) ?? (a.event ? `Live event: ${a.event.kind || 'chart'}` : 'Task'), taskVersion: a.taskVersion,
          participant: isAgent ? `${agents.get(a.participant.id)?.name ?? a.participant.id} v${a.participant.version}` : showPeople ? people.get(a.participant.id)?.name ?? 'Person' : 'A person', agent: isAgent ? a.participant.id : null, version: isAgent ? a.participant.version : null, person: isAgent ? a.human : a.participant.id,
          mode: a.condition, state: a.state, outcome: outcomeOf(a.state, a.scores), graded: Boolean(a.scores?.expertGrade), at: a.closedAt || a.openedAt || study.startedAt, scores: a.scores });
      }
    }
    if (!f.study && !f.person) {
      const runNames = new Map((await store.query('TrainingRun')).map((r) => [r.id, r.name]));
      for (const r of await store.query('Run', { where: (x) => Boolean(x.attempt?.run) && (!f.run || x.attempt.run === f.run) })) {
        rows.push({ kind: 'run', id: r.id, runId: r.id, container: runNames.get(r.attempt.run) ?? 'Run', containerId: r.attempt.run, taskId: r.attempt.task, task: taskTitle.get(r.attempt.task) ?? 'Task', taskVersion: r.attempt.taskVersion, participant: `${agents.get(r.agentId)?.name ?? r.agentId} v${r.version}`, agent: r.agentId, version: r.version, person: null,
          mode: 'training', state: r.endedAt ? 'closed' : 'open', outcome: outcomeOf(r.endedAt ? 'closed' : 'open', r.scores), graded: false, at: r.endedAt || r.startedAt, scores: r.scores ?? null });
      }
    }
    const q = f.q.toLowerCase();
    const hit = rows.filter((r) => (!f.task || r.taskId === f.task) && (!f.agent || r.agent === f.agent) && (!f.version || r.version === f.version) && (!f.person || r.person === f.person) && (!f.mode || r.mode === f.mode)
      && (!f.from || String(r.at) >= new Date(f.from).toISOString()) && (!f.to || String(r.at) <= new Date(new Date(f.to).getTime() + 86399999).toISOString())
      && (!f.outcome || (f.outcome === 'ungraded' ? r.state === 'closed' && !r.graded && r.kind === 'study' : r.outcome === f.outcome))
      && (!q || [r.task, r.container, r.participant, r.mode].some((v) => String(v).toLowerCase().includes(q))));
    hit.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { total: hit.length, results: hit.slice(0, 300), filters: f };
  }

  /** What the filter menus offer. */
  async function options(ctx) {
    const st = (await store.query('EvalStudy', { where: (s) => s.status !== 'draft' })).map((s) => ({ id: s.id, title: s.title }));
    const runs = (await store.query('TrainingRun')).map((r) => ({ id: r.id, title: r.name }));
    const tasks = (await store.query('EvalCase')).map((c) => ({ id: c.id, title: c.title })).sort((a, b) => a.title.localeCompare(b.title));
    const agents = (await store.query('Agent')).map((a) => ({ id: a.id, title: a.name, version: a.version }));
    const people = ctx.actor.role === 'researcher' ? (await accounts.people()).map((p) => ({ id: p.id, title: p.name })) : [];
    return { studies: st, runs, tasks, agents, people, modes: MODES, outcomes: OUTCOMES };
  }

  async function handle(req, url, body, ctx) {
    staff(ctx);
    const area = url.pathname.split('/').filter(Boolean)[1];
    if (req.method !== 'GET') throw new HttpError(405, 'Read-only');
    if (area === 'library-list') return { status: 200, body: await list(ctx) };
    if (area === 'search' && url.searchParams.get('options') === '1') return { status: 200, body: await options(ctx) };
    if (area === 'search') return { status: 200, body: await search(url.searchParams, ctx) };
    throw new HttpError(404, 'No such Library action');
  }
  return { handle, list, search };
}
