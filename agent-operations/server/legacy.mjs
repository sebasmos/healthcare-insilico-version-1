// Work done on the earlier screens, folded into studies and attempts (docs/STUDY-DESIGN.md 10).
//
// Shadow, human-in-the-loop and red-team runs started from the earlier screens, reader-study answers and
// labelling annotations each become an attempt inside a study, so they show in the study grid, the Library
// search and the report card. Nothing is rewritten or removed: the earlier records stay as they are and the
// new ones point at them. Past work is brought over once (migrate); new work is brought over as it ends.
import { createHash } from 'node:crypto';
import { runEvents } from './runs.mjs';
import { scoreWork } from './scores.mjs';
import { ANN } from '../../data-annotation/server/annotation.mjs';

const CONDITION = { 'shadow-task': 'shadow', 'shadow-event': 'shadow', hitl: 'hitl', redteam: 'redteam' };
const TITLE = { shadow: 'Shadow runs from the earlier screen', hitl: 'Human-in-the-loop runs from the earlier screen', redteam: 'Red-team runs from the earlier screen' };
const short = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 20);

export function createLegacy({ store }) {
  const saveStudy = async (id, make) => store.transaction(async (tx) => { const cur = await tx.get('EvalStudy', id); if (cur) return cur; return tx.save('EvalStudy', { resourceType: 'EvalStudy', id, description: '', taskSet: null, live: null, participants: [], conditions: [], order: 'fixed', assignment: { mode: 'all' }, humanBaseline: false, perturbations: [], labelScheme: null, adjudicator: null, disagreementLimit: 0.7, seed: 0, status: 'started', legacy: true, createdBy: 'migration', copiedFrom: null, startedAt: tx.now(), ...make(), frozen: { at: tx.now(), by: 'migration', taskSet: null, tasks: [], participants: [], conditions: make().conditions || [], order: 'fixed', assignment: { mode: 'all' }, perturbations: [], seed: 0, labelScheme: make().labelScheme ?? null, live: null } }, { updatedBy: 'migration' }); });
  const addParticipant = async (studyId, participant) => store.transaction(async (tx) => { const { _seq, meta, ...s } = await tx.get('EvalStudy', studyId); const key = (p) => `${p.kind}:${p.id}@${p.version ?? ''}`; if (s.participants.some((p) => key(p) === key(participant))) return; const participants = [...s.participants, participant]; await tx.save('EvalStudy', { ...s, participants, frozen: { ...s.frozen, participants } }, { updatedBy: 'migration' }); });
  const saveAttempt = async (id, studyId, doc) => store.transaction(async (tx) => { if (await tx.get('Attempt', id)) return false; const n = (await tx.query('Attempt', { groupKey: studyId })).filter((a) => a.participantKey === doc.participantKey).length; await tx.save('Attempt', { resourceType: 'Attempt', id, study: studyId, _groupKey: studyId, perturbation: null, taskId: null, taskVersion: null, human: null, branch: null, runId: null, openedAt: null, closedAt: null, answer: null, seal: null, legacy: true, position: n, ...doc }, { updatedBy: 'migration' }); return true; });

  const addCondition = async (studyId, condition) => store.transaction(async (tx) => { const { _seq, meta, ...s } = await tx.get('EvalStudy', studyId); if (s.conditions.includes(condition)) return; const conditions = [...s.conditions, condition]; await tx.save('EvalStudy', { ...s, conditions, frozen: { ...s.frozen, conditions } }, { updatedBy: 'migration' }); });
  const mark = async (studyId, extra) => store.transaction(async (tx) => { const { _seq, meta, ...s } = await tx.get('EvalStudy', studyId); if (Object.entries(extra).every(([k, v]) => s[k] === v)) return; await tx.save('EvalStudy', { ...s, ...extra }, { updatedBy: 'migration' }); });
  /** The study page that stands for an earlier study or labelling project. Made the first time it is asked for. */
  async function twinFor(type, id) {
    if (type === 'earlier-screen') { if (!TITLE[id]) return null; await saveStudy(`legacy-${id}`, () => ({ title: TITLE[id], kind: 'evaluation', conditions: [id], migratedFrom: { type: 'earlier-screen', mode: id } })); return `legacy-${id}`; }
    const studyId = `legacy-${short(`${type}:${id}`)}`;
    if (await store.get('EvalStudy', studyId)) return studyId;
    if (type === 'Study') { const old = await store.get('Study', id); if (!old) return null; await saveStudy(studyId, () => ({ title: old.title, description: old.question || '', kind: old.mode === 'annotate' ? 'annotation' : 'evaluation', conditions: [], earlierMode: old.mode || 'evaluate', migratedFrom: { type: 'Study', id } })); }
    else { const project = await store.get('AnnotationProject', id); if (!project) return null; const lt = { classification: 'classification', span: 'spans', bbox: 'boxes', region: 'regions' }[project.taskType] || 'classification'; await saveStudy(studyId, () => ({ title: project.name, kind: 'annotation', conditions: [], labelScheme: { type: lt, labels: (project.labels || []).map((l) => (typeof l === 'string' ? l : l.code || l.display || String(l.id))) }, migratedFrom: { type: 'AnnotationProject', id } })); }
    return studyId;
  }
  /** One run from an earlier screen becomes one attempt. Returns true when it was added. */
  async function adoptRun(run) {
    const condition = CONDITION[run.mode];
    if (!condition || run.attempt || !run.agentId || !run.endedAt || run.result?.heldOut) return false;
    if ((await store.query('Attempt', { where: (a) => a.runId === run.id })).length) return false;
    const old = run.study ? await store.get('Study', run.study) : null;
    const studyId = old ? await twinFor('Study', old.id) : `legacy-${condition}`;
    if (!old) await saveStudy(studyId, () => ({ title: TITLE[condition], kind: 'evaluation', conditions: [condition], migratedFrom: { type: 'earlier-screen', mode: condition } }));
    await addCondition(studyId, condition);
    const participant = { kind: 'agent', id: run.agentId, version: String(run.version ?? '') };
    await addParticipant(studyId, participant);
    const task = run.caseId ? await store.get('EvalCase', run.caseId).catch(() => null) : null;
    const scores = await scoreWork(store, { task, branch: run.branch, runId: run.id, openedAt: run.startedAt, closedAt: run.endedAt }).catch(() => null);
    // A red-team run carries its own hazard checks.
    if (scores && Array.isArray(run.result?.checks)) { const checks = run.result.checks; scores.hazards = [{ test: run.result.test ?? run.caseId ?? null, pass: Boolean(run.result.passed), failed: checks.filter((c) => !c.pass).map((c) => c.id) }]; scores.success = { pass: Boolean(run.result.passed), met: checks.filter((c) => c.pass).length, of: checks.length, share: checks.length ? checks.filter((c) => c.pass).length / checks.length : null }; }
    return saveAttempt(`legacy-${run.id}`, studyId, { participant, participantKey: `agent:${participant.id}@${participant.version}`, condition, taskId: task ? task.id : null, taskVersion: task ? task.taskVersion ?? 1 : null, caseRef: run.subject ?? null, state: 'closed', runId: run.id, branch: run.branch, openedAt: run.startedAt, closedAt: run.endedAt, scores, source: { type: 'Run', id: run.id, mode: run.mode } });
  }

  /** Reader-study answers: one attempt per reader per case. */
  async function migrateReaderStudies() {
    let n = 0;
    for (const ans of await store.query('ReaderAnswer')) {
      const studyId = await twinFor('Study', ans.study); await mark(studyId, { readerStudy: true });
      const participant = { kind: 'person', id: String(ans.reader) }; await addParticipant(studyId, participant);
      const ok = ans.correct == null ? null : { pass: Boolean(ans.correct), met: ans.correct ? 1 : 0, of: 1, share: ans.correct ? 1 : 0 };
      if (await saveAttempt(`legacy-${ans.id}`, studyId, { participant, participantKey: `person:${participant.id}`, condition: 'human', readerCondition: ans.condition ?? null, caseRef: String(ans.case), state: 'closed', closedAt: ans.meta?.lastUpdated ?? null, answer: { label: typeof ans.answer === 'object' ? JSON.stringify(ans.answer) : ans.answer, confidence: ans.confidence ?? null }, scores: { success: ok, safetyViolations: 0, expertGrade: null, seconds: ans.seconds ?? null, steps: null }, source: { type: 'ReaderAnswer', id: ans.id } })) n += 1;
    }
    return n;
  }
  /** Labelling projects: one attempt per annotator per item, with the label, spans or boxes as the answer. */
  async function migrateLabelling() {
    let n = 0;
    for (const project of await store.query('AnnotationProject')) {
      const studyId = await twinFor('AnnotationProject', project.id);
      const done = await store.query('Observation', { where: (o) => o.category?.[0]?.coding?.[0]?.code === 'annotation' && o.code?.coding?.[0]?.code === project.id });
      for (const o of done) {
        const who = o.performer?.[0]?.identifier?.value; if (!who) continue;
        const participant = { kind: 'person', id: String(who) }; await addParticipant(studyId, participant);
        const ext = (url) => (o.extension || []).find((e) => e.url === url);
        const spans = (o.component || []).filter((c) => (c.extension || []).some((e) => e.url === ANN.start)).map((c) => ({ label: c.code?.coding?.[0]?.code ?? c.code?.text ?? null, start: c.extension.find((e) => e.url === ANN.start).valueInteger, end: c.extension.find((e) => e.url === ANN.end).valueInteger }));
        const answer = { ...(o.valueCodeableConcept ? { label: o.valueCodeableConcept.coding?.[0]?.code ?? o.valueCodeableConcept.text } : {}), ...(spans.length ? { spans, mask: [...new Set(spans.flatMap((s) => Array.from({ length: Math.max(0, s.end - s.start) }, (_, i) => s.start + i)))] } : {}) };
        if (await saveAttempt(`legacy-${o.id}`, studyId, { participant, participantKey: `person:${participant.id}`, condition: 'human', caseRef: ext(ANN.item)?.valueString ?? o.focus?.[0]?.reference ?? null, state: 'closed', closedAt: o.effectiveDateTime ?? null, answer, scores: { success: null, safetyViolations: 0, expertGrade: null, seconds: ext(ANN.seconds)?.valueDecimal ?? null, steps: null }, source: { type: 'Observation', id: o.id } })) n += 1;
      }
    }
    return n;
  }
  /** Brings past work over. Safe to run again: what is already there is left alone. */
  async function migrate() {
    let runs = 0;
    for (const old of await store.query('Study')) await twinFor('Study', old.id);
    for (const project of await store.query('AnnotationProject')) await twinFor('AnnotationProject', project.id);
    for (const run of await store.query('Run', { where: (r) => Boolean(CONDITION[r.mode]) && !r.attempt && r.endedAt && r.agentId })) if (await adoptRun(run)) runs += 1;
    return { runs, readerAnswers: await migrateReaderStudies(), annotations: await migrateLabelling() };
  }
  const onEnded = (run, from) => { if (from === store) adoptRun(run).catch(() => {}); };
  runEvents.on('ended', onEnded);
  let first = null;
  return { ensureTwins: async () => { for (const old of await store.query('Study')) await twinFor('Study', old.id); for (const p of await store.query('AnnotationProject')) await twinFor('AnnotationProject', p.id); }, migrate, adoptRun, twinFor, ready: () => (first ||= migrate().catch(() => ({ runs: 0, readerAnswers: 0, annotations: 0 }))), dispose: () => runEvents.off('ended', onEnded) };
}
