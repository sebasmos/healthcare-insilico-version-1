// Human grading queue: episodes waiting for a grade (least certain first),
// grades that need adjudication, and the safety queue of runs graded unsafe.
import { h, btn, badge, toast, table, card, fmtDateTime, showError } from '/shared/ui.js';
import { api } from '/shared/fhir.js';

const KIND = { rollout: 'Training-data attempt', shadow: 'Shadow comparison', hitl: 'Clinician decision', 'shadow-case': 'Live shadow of a case', ablation: 'What-if test', regression: 'Regression replay' };
const minutes = (s) => (s == null ? '—' : s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);

export async function gradeQueuePage(go, render) {
  const q = await api.get('/agent-ops/grades/queue');
  const label = (id) => q.grades.find((g) => g.id === id)?.label ?? id;
  const tile = (text, value, testid) => h('div', { class: 'card' }, h('span', { class: 'muted small' }, text), h('b', { testid }, value));
  const start = btn('Start grading', { kind: 'primary', testid: 'grading-start', disabled: !q.queue.length, onClick: () => go(`#/trace/${q.queue[0].runId}?queue=1`) });
  const readers = h('select', { testid: 'grading-readers', 'aria-label': 'Graders per run', style: 'width:auto', onChange: async (e) => { try { await api.put('/agent-ops/grades/config', { gradersPerEpisode: Number(e.target.value) }); undefined; } catch (err) { showError(err); } render(); } },
    [[1, '1 grader per run'], [2, '2 graders per run (independent)'], [3, '3 graders per run (independent)']].map(([v, t]) => h('option', { value: v, selected: q.config.gradersPerEpisode === v }, t)));
  const a = q.agreement;
  const queue = q.queue.length ? table({ testid: 'grading-queue', rows: q.queue, rowId: (r) => r.episodeId, onRow: (r) => go(`#/trace/${r.runId}?queue=1`), columns: [
    { label: 'Run', render: (r) => r.title }, { label: 'Kind', render: (r) => KIND[r.kind] || r.kind }, { label: 'Agent', render: (r) => `${r.agentId} v${r.version}` },
    { label: 'Checks passed', render: (r) => pct(r.verifierScore) }, { label: 'How uncertain the score is', render: (r) => (r.judgeDisagreement != null ? `${pct(r.uncertainty)} (code checks and judge disagree)` : pct(r.uncertainty)) },
    { label: 'When', render: (r) => fmtDateTime(r.timestamp) },
  ] }) : h('div', { class: 'card empty', testid: 'grading-empty' }, q.progress.total ? 'Nothing is waiting for you. Every run has its graders, or you have graded the rest.' : 'There is nothing to grade yet. Runs appear here once an agent has attempted a case, been shadowed, or had a proposal decided.');
  const adjudication = q.adjudication.length ? card(`Disagreements to settle (${q.adjudication.length})`,
    h('p', { class: 'muted', style: 'margin:0 0 0.625rem' }, `Agreement between graders is ${a.kappa == null ? 'not measurable yet' : `κ ${a.kappa.toFixed(2)} (${a.reading})`}, below ${q.threshold}. Each disagreement needs a final grade from someone who did not grade that run.`),
    table({ testid: 'grading-adjudication', rows: q.adjudication, rowId: (r) => r.episodeId, columns: [
      { label: 'Run', render: (r) => r.title }, { label: 'Agent', render: (r) => `${r.agentId} v${r.version}` },
      { label: 'Grades given', render: (r) => r.grades.map((g) => `${g.grader}: ${label(g.value)}`).join(' · ') },
      { label: '', cls: 'actions', render: (r) => (r.mine ? h('span', { class: 'muted small' }, 'You graded this one') : btn('Adjudicate', { small: true, testid: `grading-adjudicate-${r.episodeId}`, onClick: () => go(`#/trace/${r.runId}?adjudicate=1`) })) },
    ] })) : null;
  const safety = card(`Safety queue (${q.safety.length})`, q.safety.length ? table({ testid: 'grading-safety', rows: q.safety, rowId: (r) => r.episodeId, onRow: (r) => go(`#/trace/${r.runId}`), columns: [
    { label: 'Run', render: (r) => r.title }, { label: 'Agent', render: (r) => `${r.agentId} v${r.version}` }, { label: 'What the grader said', render: (r) => r.comments.filter(Boolean).join(' · ') }, { label: 'When', render: (r) => fmtDateTime(r.timestamp) },
  ] }) : h('p', { class: 'muted', style: 'margin:0', testid: 'grading-safety-empty' }, 'No run has been graded unsafe.'));
  return h('div', {}, h('div', { class: 'page-head' }, h('h1', {}, 'Grading'), h('div', { class: 'toolbar', style: 'margin:0' }, readers, start)),
    h('p', { class: 'muted', testid: 'grading-progress', style: 'margin:-0.375rem 0 0.875rem;max-width:56.25rem' }, `${q.progress.graded} of ${q.progress.total} runs graded. You are grading as "${q.grader}" and have graded ${q.progress.mine}. `,
      q.queue.length ? `${q.queue.length} waiting for you${q.estimatedSecondsRemaining != null ? `, about ${minutes(q.estimatedSecondsRemaining)} at the median of ${minutes(q.medianSeconds)} a run` : ''}. ` : '',
      'Runs whose automatic score is least certain come first. A grade changes the run\'s reward at once, by the "Expert grade" weight on the Reward design page.'),
    h('div', { class: 'tiles6' }, tile('Graded', `${q.progress.graded} / ${q.progress.total}`, 'grading-graded'), tile('Waiting for you', q.queue.length, 'grading-waiting'), tile('Median time per run', minutes(q.medianSeconds), 'grading-median'),
      tile('Agreement between graders', a.kappa == null ? '—' : `κ ${a.kappa.toFixed(2)}`, 'grading-kappa'), tile('To adjudicate', q.adjudication.length, 'grading-adjudicate-count'), tile('Graded unsafe', q.safety.length, 'grading-unsafe')),
    queue, h('div', { style: 'height:1rem' }), adjudication, adjudication ? h('div', { style: 'height:1rem' }) : null, safety);
}
