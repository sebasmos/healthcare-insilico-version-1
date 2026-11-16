// Assignment, My work, agreement and adjudication (docs/STUDY-DESIGN.md 8).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './support/helpers.mjs';
import { res, as, makeTasks, makePeople } from './support/study-fixtures.mjs';
import { dice, caseAgreement } from '../data-annotation/server/agreement.mjs';

test('Dice and case agreement', () => {
  assert.equal(dice({ mask: [1, 2, 3, 4] }, { mask: [3, 4, 5, 6] }), 0.5); assert.equal(dice({ mask: [] }, { mask: [] }), 1); assert.equal(dice({ mask: [1] }, { mask: [2] }), 0);
  assert.equal(dice({ box: { x: 0, y: 0, width: 10, height: 10 } }, { box: { x: 5, y: 0, width: 10, height: 10 } }), 0.5); assert.equal(dice({ label: 'a' }, { label: 'a' }), null);
  assert.deepEqual(caseAgreement([{ label: 'a' }, { label: 'a' }, { label: 'b' }]), { label: 0.333, dice: null });
  assert.deepEqual(caseAgreement([{ label: 'a', mask: [1, 2] }, { label: 'a', mask: [1, 2] }]), { label: 1, dice: 1 });
});

const work = async (s, person, answers) => { // the reader hands in one answer per task, in their own order
  let wk = (await s.call('GET', '/agent-ops/my-work', undefined, as(person))).json; let cur = wk.next;
  if (!cur) return;
  let opened = (await s.call('POST', `/agent-ops/attempts/${cur.id}/open`, {}, as(person))).json;
  while (opened) { const r = (await s.call('POST', `/agent-ops/attempts/${opened.id}/next`, { answer: answers[opened.taskId] }, as(person))).json; opened = r.next; }
};

test('k readers per case, My work, kappa, and the adjudication queue', async () => {
  const s = await startTestServer();
  try {
    const { tasks, set } = await makeTasks(s, 4); const [r1, r2, r3, adj] = await makePeople(s, 4);
    const ids = tasks.map((t) => t.id);
    const study = (await s.call('POST', '/agent-ops/studies', { title: 'Readers', kind: 'annotation', labelScheme: { type: 'classification', labels: ['normal', 'abnormal'] }, taskSet: set.id, participants: [r1, r2, r3].map((p) => ({ kind: 'person', id: p.id })), assignment: { mode: 'k', k: 2 }, adjudicator: adj.id, order: 'shuffled', seed: 3 }, res)).json;
    assert.deepEqual(study.tags, ['Classification']);
    const started = (await s.call('POST', `/agent-ops/studies/${study.id}/start`, {}, res)).json; assert.equal(started.attempts, 8, '4 cases x 2 readers');
    const counts = await Promise.all([r1, r2, r3].map(async (p) => (await s.studies.queueOf(p.id)).length)); assert.deepEqual([...counts].sort(), [2, 3, 3], 'the cases are spread evenly');
    const all = await s.studies.attemptsOf(study.id); for (const id of ids) assert.equal(all.filter((a) => a.taskId === id).length, 2, 'each case has exactly two readers');
    // My work: the next task on top, only that one can be opened, nothing for someone not in the study.
    const wk = (await s.call('GET', '/agent-ops/my-work', undefined, as(r1))).json;
    assert.equal(wk.todo.length, counts[0]); assert.deepEqual(wk.todo.map((t) => t.canOpen), [true, ...Array(counts[0] - 1).fill(false)]); assert.equal(wk.next.id, wk.todo[0].id); assert.equal(wk.next.studyTitle, 'Readers');
    assert.deepEqual((await s.call('GET', '/agent-ops/my-work', undefined, as(adj))).json.todo, []);
    assert.equal((await s.call('GET', '/agent-ops/my-work', undefined, { 'X-Role': 'researcher', 'X-Agent-Id': 'workup-planner' })).status >= 400, true);
    // Readers agree on the first two cases, disagree on the last two.
    const truth = { [ids[0]]: 'normal', [ids[1]]: 'abnormal', [ids[2]]: 'normal', [ids[3]]: 'abnormal' };
    const readersOf = (id) => all.filter((a) => a.taskId === id).map((a) => a.participant.id);
    const say = (p) => Object.fromEntries(ids.map((id) => [id, { label: [ids[2], ids[3]].includes(id) && readersOf(id)[0] === p.id ? (truth[id] === 'normal' ? 'abnormal' : 'normal') : truth[id] }]));
    for (const p of [r1, r2, r3]) await work(s, p, say(p));
    assert.equal((await s.call('GET', `/agent-ops/studies/${study.id}`, undefined, res)).json.study.status, 'finished');
    assert.equal((await s.call('GET', '/agent-ops/my-work', undefined, as(r1))).json.next, null);
    const ag = (await s.call('GET', `/agent-ops/agreement/${study.id}`, undefined, res)).json;
    assert.deepEqual(ag.cases.map((c) => [c.readers, c.label]), [[2, 1], [2, 1], [2, 0], [2, 0]]);
    assert.ok(ag.kappa && ag.kappa.kappa != null && ag.kappa.kappa < 0.5, JSON.stringify(ag.kappa));
    assert.deepEqual(ag.adjudications.map((a) => a.status).sort(), ['agreed', 'agreed', 'open', 'open']);
    assert.deepEqual(ag.adjudications.find((a) => a.taskId === ids[0]).reference, { label: 'normal' }, 'agreed cases take the agreed answer as the reference');
    assert.equal((await s.call('GET', `/agent-ops/agreement/${study.id}`, undefined, as(r1))).status, 403);
    // The adjudicator's queue; a reader cannot settle it; the adjudicator's answer becomes the reference and the readers' answers stay.
    assert.deepEqual((await s.call('GET', '/agent-ops/adjudications', undefined, as(r1))).json.queue, []);
    const q = (await s.call('GET', '/agent-ops/adjudications', undefined, as(adj))).json.queue; assert.equal(q.length, 2);
    assert.equal((await s.call('GET', '/agent-ops/my-work', undefined, as(adj))).json.toAdjudicate, 2);
    assert.equal((await s.call('POST', `/agent-ops/adjudications/${q[0].id}`, { answer: { label: 'normal' } }, as(r2))).status, 403);
    assert.equal((await s.call('POST', `/agent-ops/adjudications/${q[0].id}`, {}, as(adj))).status, 422);
    const settled = await s.call('POST', `/agent-ops/adjudications/${q[0].id}`, { answer: { label: 'normal' }, note: 'Second reader misread it.' }, as(adj));
    assert.equal(settled.status, 200, settled.text); assert.deepEqual([settled.json.status, settled.json.reference, settled.json.decidedBy, settled.json.answers.length], ['resolved', { label: 'normal' }, adj.id, 2]);
    assert.equal((await s.call('POST', `/agent-ops/adjudications/${q[0].id}`, { answer: { label: 'abnormal' } }, as(adj))).status, 409);
    assert.equal((await s.call('GET', '/agent-ops/adjudications', undefined, as(adj))).json.queue.length, 1);
  } finally { await s.close(); }
});

test('everyone reads every case (Fleiss kappa) and split (one reader each); regions use Dice', async () => {
  const s = await startTestServer();
  try {
    const { tasks, set } = await makeTasks(s, 3); const people = await makePeople(s, 3); const ids = tasks.map((t) => t.id);
    const mk = async (assignment, scheme) => { const st = (await s.call('POST', '/agent-ops/studies', { title: `Study ${assignment.mode}`, kind: 'annotation', labelScheme: scheme, taskSet: set.id, participants: people.map((p) => ({ kind: 'person', id: p.id })), assignment }, res)).json; return (await s.call('POST', `/agent-ops/studies/${st.id}/start`, {}, res)).json; };
    const allS = await mk({ mode: 'all' }, { type: 'classification', labels: ['a', 'b'] }); assert.equal(allS.attempts, 9);
    for (const p of people) await work(s, p, Object.fromEntries(ids.map((id, i) => [id, { label: i === 0 ? 'a' : 'b' }])));
    const ag = (await s.call('GET', `/agent-ops/agreement/${allS.id}`, undefined, res)).json;
    assert.deepEqual([ag.kappa.statistic, ag.kappa.kappa, ag.readers], ['fleiss', 1, 3]);
    const split = await mk({ mode: 'split' }, { type: 'segmentation' }); assert.equal(split.attempts, 3, 'one reader per case');
    assert.deepEqual((await s.call('GET', `/agent-ops/agreement/${split.id}`, undefined, res)).json.cases.map((c) => c.assigned), [1, 1, 1]);
    for (const p of people) await work(s, p, {});
    const seg = await mk({ mode: 'all' }, { type: 'segmentation' });
    for (const [i, p] of people.entries()) await work(s, p, Object.fromEntries(ids.map((id) => [id, { mask: i === 2 ? [1, 2, 3, 4] : [1, 2, 3, 4, 5, 6, 7, 8] }])));
    const sa = (await s.call('GET', `/agent-ops/agreement/${seg.id}`, undefined, res)).json;
    assert.deepEqual([sa.kappa, sa.dice.cases, sa.dice.mean], [null, 3, 0.778]);
    assert.ok(sa.adjudications.every((a) => a.status === 'agreed' && a.reference === null), 'regions that agree are not copied as a reference label');
    assert.equal(seg.tags[0], 'Segmentation');
  } finally { await s.close(); }
});
