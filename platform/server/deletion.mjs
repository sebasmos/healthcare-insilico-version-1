// Deletion rules. Only whole units are deleted: a study, a run, an agent with all its runs, or all test data.
// Everything a unit owns goes in one transaction, with no marker left behind: attempts, branches (and the chart
// copies on them), trace steps, scores, grades, labels and exports. A single trace step, attempt or log entry can
// never be changed or removed by itself. The main chart is never touched: no clinical record on the live record
// is ever in the set, and that is checked again just before deleting.
import { HttpError } from './http.mjs';
import { LIVE_RUN_ID } from './audit.mjs';

// Records that exist only because of a study or a run. Matched by id, group or a reference to the unit.
const RESULT_TYPES = ['ExpertGrade', 'RubricGrade', 'Adjudication', 'StudyLink', 'Review', 'Correction', 'Redaction', 'DatasetSnapshot', 'Preference', 'PreferencePair', 'BenchmarkRun', 'ReaderAnswer', 'LoopEvent', 'Episode', 'InsScenarioRun'];
const UNIT_TYPES = ['EvalStudy', 'Attempt', 'TrainingRun'];
const LABEL = { AdverseEvent: 'surveillance reports', SurvSignal: 'surveillance signals', SurvWatch: 'surveillance watches', Attempt: 'attempts', Run: 'runs', TraceStep: 'trace steps', ExpertGrade: 'grades', RubricGrade: 'grades', Adjudication: 'grades', Review: 'labels', Correction: 'labels', ReaderAnswer: 'labels', Preference: 'labels', PreferencePair: 'labels', DatasetSnapshot: 'exports', EvalStudy: 'studies', TrainingRun: 'training runs', Agent: 'agents' };
const marks = (n) => Array.from({ length: n }, () => '?').join(', ');

export function createDeletion({ store }) {
  const researcher = (ctx) => { if (ctx.actor.kind !== 'human' || ctx.actor.role !== 'researcher') throw new HttpError(403, 'Only a Researcher deletes studies, runs or agents'); if (ctx.asOf) throw new HttpError(409, 'Nothing is deleted while viewing a past time'); };

  /**
   * Surveillance that exists only because of the unit goes with it: reports about its runs, the replay runs made
   * from those reports, and signals left with no report behind them. A report about another run that only has a
   * replay among the deleted runs is kept, with that replay taken out of it.
   */
  async function withSurveillance(unit, { agentId = null } = {}) {
    const spec = unit.spec; const gone = new Set(spec.runIds); const reports = (await store.query('AdverseEvent', {})).filter((d) => d._surv); const allRuns = await store.query('Run', {});
    const dead = reports.filter((d) => gone.has(d._surv.context?.run) || (agentId && d._surv.context?.agent === agentId)); const deadIds = new Set(dead.map((d) => d.id)); const deadCases = new Set(dead.map((d) => d._surv.caseId));
    // Replay runs of the deleted reports, and replays of the deleted runs themselves.
    const replays = allRuns.filter((r) => !gone.has(r.id) && r.id !== LIVE_RUN_ID && (gone.has(r.context?.replayOf) || deadIds.has(r.trigger?.report) || deadCases.has(r.context?.report)));
    for (const r of replays) { gone.add(r.id); spec.runIds.push(r.id); spec.branches.push(r.branch); }
    const replayOf = (x) => x && gone.has(x.run);
    const rewrites = []; for (const d of reports) { if (deadIds.has(d.id)) continue; const s = d._surv; const rp = s.reproduced; const dup = s.duplicateOf && (deadIds.has(s.duplicateOf) || deadCases.has(s.duplicateOf));
      const touched = rp && ([...(rp.sameVersion || []), ...(rp.perturbations || [])].some(replayOf) || replayOf(rp.currentVersion)); if (!touched && !dup) continue;
      let next = rp; if (touched) { const same = (rp.sameVersion || []).filter((x) => !replayOf(x)); const pert = (rp.perturbations || []).filter((x) => !replayOf(x)); const cur = replayOf(rp.currentVersion) ? null : rp.currentVersion; const k = same.filter((x) => x.same).length; next = same.length || pert.length || cur ? { ...rp, sameVersion: same, perturbations: pert, currentVersion: cur, k, n: same.length, verdict: !same.length ? null : k === same.length ? 'yes' : k === 0 ? 'no' : 'intermittent' } : null; }
      const { _seq, meta, ...doc } = d; rewrites.push({ ...doc, _surv: { ...s, reproduced: next, ...(dup ? { duplicateOf: null, status: s.status === 'duplicate' ? 'under-review' : s.status } : {}) } }); }
    const left = reports.filter((d) => !deadIds.has(d.id)); const signals = [];
    for (const type of ['SurvSignal', 'SurvWatch']) for (const g of await store.query(type, {})) { const mine = (d) => d._surv.context?.agent === g.agent && (!g.harm || d._surv.harm === g.harm); if ((agentId && g.agent === agentId) || (dead.some(mine) && !left.some(mine))) signals.push([type, g.id]); }
    spec.rows = [...spec.rows, ...dead.map((d) => ['AdverseEvent', d.id]), ...signals]; spec.ids = [...spec.ids, ...dead.map((d) => d.id), ...dead.map((d) => d._surv.caseId)]; spec.rewrites = rewrites; spec.replays = replays.length;
    return unit;
  }
  /** Every row the unit owns, found inside the transaction that will delete them. */
  async function collect(q, { runIds = [], branches = [], ids = [], rows = [], wipeTypes = [], allSteps = false, rewrites = [], replays = 0 }) {
    const seqs = new Map(); const add = (list) => { for (const r of list) seqs.set(r.seq, r); };
    const cols = 'seq, resource_type, branch, internal';
    // Branches, with every branch forked from them.
    const all = new Set(branches.filter((b) => b && b !== 'main')); let grew = true;
    while (grew) { grew = false; for (const b of [...all]) for (const c of await q.all('SELECT id FROM branches WHERE parent_branch = ?', [b])) if (!all.has(c.id)) { all.add(c.id); grew = true; } }
    for (const b of all) add(await q.all(`SELECT ${cols} FROM resource_versions WHERE branch = ?`, [b]));
    for (const r of runIds) { add(await q.all(`SELECT ${cols} FROM resource_versions WHERE resource_type = 'TraceStep' AND group_key = ?`, [r])); add(await q.all(`SELECT ${cols} FROM resource_versions WHERE resource_type = 'Run' AND id = ?`, [r])); }
    for (const id of new Set([...ids, ...runIds])) add(await q.all(`SELECT ${cols} FROM resource_versions WHERE resource_type IN (${marks(RESULT_TYPES.length)}) AND (id = ? OR group_key = ? OR CAST(body AS TEXT) LIKE ?)`, [...RESULT_TYPES, id, id, `%"${id}"%`]));
    // The Researcher's own steps about the unit on the live log (made, started, stopped, graded) go with it, with their log entries.
    // A step that touched a clinical record stays: it belongs to the main chart's history.
    for (const id of new Set([...ids, ...runIds])) for (const r of await q.all(`SELECT ${cols}, body FROM resource_versions WHERE resource_type = 'TraceStep' AND group_key = ? AND CAST(body AS TEXT) LIKE ?`, [LIVE_RUN_ID, `%"${id}"%`])) {
      let step; try { step = typeof r.body === 'string' ? JSON.parse(r.body) : r.body; } catch { continue; } if (String(step.did?.type || '').startsWith('fhir.') || (step.saw?.resources || []).length) continue;
      add([{ seq: r.seq, resource_type: r.resource_type, branch: r.branch, internal: r.internal }]); const ae = String(step.auditEvent || '').split('/')[1];
      if (ae) add((await q.all(`SELECT ${cols} FROM resource_versions WHERE resource_type = 'AuditEvent' AND id = ? AND (patient IS NULL OR ? = 1)`, [ae, String(step.did?.type || '').startsWith('surveillance.') ? 1 : 0])).map((x) => ({ ...x, internal: 1 })));
    }
    // A surveillance report is a record about an AI output, not part of the patient's chart.
    for (const [type, id] of rows) add((await q.all(`SELECT ${cols} FROM resource_versions WHERE resource_type = ? AND id = ?`, [type, id])).map((x) => (type === 'AdverseEvent' ? { ...x, internal: 1 } : x)));
    // Log entries on the live record whose subject is a record being deleted (the run, the report, the study) go with it.
    for (const [type, id] of [...rows, ...runIds.map((r) => ['Run', r])]) add((await q.all(`SELECT ${cols} FROM resource_versions WHERE resource_type = 'AuditEvent' AND branch = 'main' AND CAST(body AS TEXT) LIKE ?`, [`%"${type}/${id}"%`])).map((x) => ({ ...x, internal: 1 })));
    for (const type of wipeTypes) add(await q.all(`SELECT ${cols} FROM resource_versions WHERE resource_type = ?`, [type]));
    if (allSteps) add(await q.all(`SELECT ${cols} FROM resource_versions WHERE resource_type = 'TraceStep' AND (group_key IS NULL OR group_key <> ?)`, [LIVE_RUN_ID]));
    // The main chart is never touched: nothing clinical on the live record may be in the set.
    const list = [...seqs.values()]; const chart = list.filter((r) => r.branch === 'main' && !Number(r.internal)); if (chart.length) throw new HttpError(500, 'Stopped: the set to delete included records of the main chart. Nothing was deleted.');
    const capture = runIds.length ? Number((await q.get(`SELECT COUNT(*) AS n FROM capture_content WHERE run_id IN (${marks(runIds.length)})`, runIds))?.n || 0) : 0;
    return { list, branches: [...all], capture, rewrites, replays };
  }
  const summarise = ({ list, branches, capture, rewrites = [], replays = 0 }) => { const counts = {}; let other = 0; for (const r of list) { const k = r.branch !== 'main' && !LABEL[r.resource_type] ? 'records on branches' : LABEL[r.resource_type]; if (k) counts[k] = (counts[k] || 0) + 1; else other += 1; } return { ...counts, ...(other ? { 'other records': other } : {}), branches: branches.length, ...(capture ? { 'recorded free text': capture } : {}), ...(replays ? { 'replay runs (counted in runs)': replays } : {}), ...(rewrites.length ? { 'reports kept, with the link to a deleted replay removed': rewrites.length } : {}), recordVersions: list.length }; };
  async function remove(q, found, runIds, tx) {
    // A kept report loses its link to a deleted replay. Its earlier versions named the replay, so they go and the report is written again as it now stands.
    for (const doc of found.rewrites) { await q.run("DELETE FROM resource_versions WHERE resource_type = 'AdverseEvent' AND id = ?", [doc.id]); }
    for (let i = 0; i < found.list.length; i += 400) { const part = found.list.slice(i, i + 400).map((r) => r.seq); await q.run(`DELETE FROM resource_versions WHERE seq IN (${marks(part.length)})`, part); }
    if (runIds.length) await q.run(`DELETE FROM capture_content WHERE run_id IN (${marks(runIds.length)})`, runIds);
    for (const doc of found.rewrites) await tx.save('AdverseEvent', doc, { updatedBy: 'system' });
    let left = [...found.branches]; // children before parents
    while (left.length) { const leaves = []; for (const b of left) { const child = await q.get('SELECT id FROM branches WHERE parent_branch = ?', [b]); if (!child) leaves.push(b); } if (!leaves.length) throw new HttpError(500, 'Stopped: the branches could not be ordered. Nothing was deleted.'); for (const b of leaves) await q.run('DELETE FROM branches WHERE id = ?', [b]); left = left.filter((b) => !leaves.includes(b)); }
  }

  // ---------- what each unit owns ----------
  const runsWhere = (fn) => store.query('Run', { where: fn });
  async function studyUnit(id) {
    const study = await store.get('EvalStudy', id); if (!study) throw new HttpError(404, 'No such study');
    const attempts = await store.query('Attempt', { groupKey: id }); const runs = await runsWhere((r) => r.attempt?.study === id || r.study === id); const runIds = [...new Set([...attempts.map((a) => a.runId), ...runs.map((r) => r.id)].filter((x) => x && x !== LIVE_RUN_ID))];
    const branches = [...new Set([...attempts.map((a) => a.branch), ...runs.map((r) => r.branch)])];
    return { title: study.title || 'Study', what: 'study', spec: { runIds, branches, ids: [id, ...attempts.map((a) => a.id)], rows: [['EvalStudy', id], ...attempts.map((a) => ['Attempt', a.id])] } };
  }
  async function runUnit(id) {
    if (id === LIVE_RUN_ID) throw new HttpError(409, 'The live record is not a run that can be deleted');
    const training = await store.get('TrainingRun', id);
    if (training) { const runs = await runsWhere((r) => r.attempt?.run === id); return { title: training.name || 'Training run', what: 'training run', spec: { runIds: runs.map((r) => r.id), branches: runs.map((r) => r.branch), ids: [id], rows: [['TrainingRun', id]] } }; }
    const run = await store.get('Run', id); if (!run) throw new HttpError(404, 'No such run');
    if (run.attempt?.study || run.attempt?.attempt) throw new HttpError(409, 'This run is one attempt of a study. An attempt is never deleted by itself: delete the whole study.');
    if (run.attempt?.run) throw new HttpError(409, 'This run is one attempt of a training run. Delete the whole training run.');
    const kids = await runsWhere((r) => r.parentRunId === id);
    return { title: run.name || run.goal || `Run ${id.slice(0, 8)}`, what: 'run', spec: { runIds: [id, ...kids.map((r) => r.id)], branches: [run.branch, ...kids.map((r) => r.branch)], ids: [id], rows: [] } };
  }
  async function agentUnit(id) {
    const agent = await store.get('Agent', id); if (!agent) throw new HttpError(404, 'No such agent'); if (agent.builtIn) throw new HttpError(409, 'A built-in agent cannot be deleted. Turn it off instead.', 'built-in');
    const runs = await runsWhere((r) => r.agentId === id); const attempts = await store.query('Attempt', { where: (a) => a.participant?.kind === 'agent' && a.participant.id === id }); const training = await store.query('TrainingRun', { where: (t) => t.agentId === id });
    const keys = []; for (const type of ['AgentSecret', 'ApiKey', 'ConnectorKey']) for (const k of await store.query(type, { where: (x) => x.agentId === id || x.agent === id || x.id === id })) keys.push([type, k.id]);
    return { title: `${agent.name || id} (every version)`, what: 'agent', spec: { runIds: [...new Set([...runs.map((r) => r.id), ...attempts.map((a) => a.runId).filter(Boolean)])].filter((x) => x !== LIVE_RUN_ID), branches: [...runs.map((r) => r.branch), ...attempts.map((a) => a.branch)], ids: [...attempts.map((a) => a.id), ...training.map((t) => t.id)], rows: [['Agent', id], ...keys, ...attempts.map((a) => ['Attempt', a.id]), ...training.map((t) => ['TrainingRun', t.id])] } };
  }
  async function allUnit() {
    const runs = (await store.query('Run', {})).filter((r) => r.id !== LIVE_RUN_ID); const branches = (await store.listBranches()).map((b) => b.id).filter((b) => b !== 'main');
    const named = []; for (const type of UNIT_TYPES) for (const d of await store.query(type, {})) named.push(d.id);
    return { title: 'All test data', what: 'all test data', spec: { runIds: runs.map((r) => r.id), branches, ids: named, wipeTypes: [...UNIT_TYPES, ...RESULT_TYPES, 'SurvSignal', 'SurvWatch'], allSteps: true, rows: (await store.query('AdverseEvent', {})).filter((d) => d._surv).map((d) => ['AdverseEvent', d.id]) }, keeps: 'Patients, the main chart, agents and the Library are kept.' };
  }
  const unitOf = async (kind, id) => (kind === 'study' ? withSurveillance(await studyUnit(id)) : kind === 'run' ? withSurveillance(await runUnit(id)) : kind === 'agent' ? withSurveillance(await agentUnit(id), { agentId: id }) : kind === 'all' ? allUnit() : (() => { throw new HttpError(404, 'Only a study, a run, an agent or all test data can be deleted'); })());

  /** The counts shown before confirming. Nothing is changed. */
  async function preview(kind, id, ctx) { researcher(ctx); const unit = await unitOf(kind, id); const found = await collect(store.raw(), unit.spec); return { kind, id: id ?? null, title: unit.title, what: unit.what, counts: summarise(found), keeps: unit.keeps || 'The main chart is not touched.' }; }
  /** Deletes the whole unit in one transaction. Nothing is left behind, so there is no log entry either: the server prints one line. */
  async function destroy(kind, id, ctx) {
    researcher(ctx); const unit = await unitOf(kind, id);
    const before = await mainChart(); const counts = await store.purge(async (q, tx) => { const found = await collect(q, unit.spec); await remove(q, found, unit.spec.runIds, tx); const after = await mainChartIn(q); if (after !== before) throw new HttpError(500, 'Stopped: the main chart would have changed. Nothing was deleted.'); return summarise(found); });
    console.log(`deleted ${unit.what}${id ? ` ${id}` : ''} by ${ctx.actor.id}: ${counts.recordVersions} record versions, ${counts.branches} branches`);
    return { deleted: true, kind, id: id ?? null, title: unit.title, counts };
  }
  const mainChartIn = async (q) => { const r = await q.get("SELECT COUNT(*) AS n, COALESCE(SUM(seq), 0) AS top FROM resource_versions WHERE branch = 'main' AND internal = 0 AND resource_type NOT IN ('AuditEvent', 'AdverseEvent')", []); return `${r.n}:${r.top}`; };
  const mainChart = () => mainChartIn(store.raw());

  async function handle(req, url, body, ctx) {
    const [, , kind, id] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (req.method === 'GET') return { status: 200, body: await preview(kind, kind === 'all' ? null : id, ctx) };
    if (req.method === 'DELETE') return { status: 200, body: await destroy(kind, kind === 'all' ? null : id, ctx) };
    throw new HttpError(405, 'GET shows what would be deleted; DELETE deletes it');
  }
  return { handle, preview, destroy };
}
/** Individual actions are never edited or deleted on their own, on any route. */
export function refuseSingleAction(method, p) {
  if (!['DELETE', 'PUT', 'PATCH'].includes(method)) return;
  if (/^\/fhir\/R4\/(AuditEvent|TraceStep|Attempt)(\/|$)/.test(p) || /^\/agent-ops\/(trace|trace-steps|steps|audit)(\/|$)/.test(p) || (method === 'DELETE' && /^\/agent-ops\/attempts\/[^/]+$/.test(p)) || (method !== 'DELETE' && /^\/agent-ops\/attempts\/[^/]+$/.test(p)))
    throw new HttpError(405, 'A single trace step, attempt or log entry is never changed or deleted. Delete the whole study or run instead.', 'whole-units-only');
}
