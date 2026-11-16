// Trace viewer: what a run did, step by step, in words a clinician can read.
// Left: the timeline. Right: what the selected step saw, did and why, and
// the grade widget. Grades are saved the moment they are given.
//
// Keys: Up/Down (or J/K) move between steps · G opens the grade widget for
// the selected step · U / D choose thumbs up / down · Enter confirms.
import { runPermissions } from '/agent-ops/permissions.js';
import { h, clear, btn, badge, toast, fmtDateTime, showError, askReason, formDialog, openDialog, kv } from '/shared/ui.js';
import { api } from '/shared/fhir.js';
import { describeAction } from '/agent-ops/describe.js';
import { reportProblemButton } from '/shared/report-problem.js';

const MODE = {
  'shadow-task': 'Shadow: same task as the clinician', 'shadow-event': 'Shadow: reacts to live events', sandbox: 'Practice run', hitl: 'Agent proposes, human decides', 'rl-generate': 'Training-data attempt',
  redteam: 'Safety scenario', capture: 'Recording of a clinician', label: 'Labelling', scribe: 'Benchmark: note accuracy', regression: 'Regression replay', unattributed: 'Everyday work',
};
const TONE = { agent: 'Agent', human: 'Person', alert: 'Safety alert', reject: 'Refused' };
const HORIZON_NAME = { '6h': '6 hours', '1d': '1 day', '2d': '2 days', '7d': '7 days', discharge: 'discharge' };
const elapsed = (ms) => (ms < 1000 ? `+${ms} ms` : ms < 60000 ? `+${(ms / 1000).toFixed(1)} s` : `+${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);
const isLookup = (s) => s.tone === 'agent' && ['fhir.read', 'fhir.search', 'chart.open', 'fhir.history', 'image.open'].includes(s.type);

const ui = new Map();
const stateOf = (runId) => { if (!ui.has(runId)) ui.set(runId, { selected: null, grading: false, pick: null, showScreen: false, showSystem: false, folded: new Set(), foldedInit: false }); return ui.get(runId); };

let unbind = () => {};
export const leaveTraceViewer = () => { unbind(); unbind = () => {}; };

export async function traceViewerPage(target, go, render) {
  const [runId, query = ''] = String(target).split('?');
  const params = new URLSearchParams(query);
  const adjudicating = params.get('adjudicate') === '1';
  const fromQueue = params.get('queue') === '1' || adjudicating;
  let data;
  try { data = await api.get(`/agent-ops/trace-view/${encodeURIComponent(runId)}`); } catch (err) {
    leaveTraceViewer();
    return h('div', {}, h('div', { class: 'page-head' }, h('h1', {}, 'Trace not found'), btn('All runs', { testid: 'tv-back', onClick: () => go('#/runs') })), h('div', { class: 'card empty', testid: 'tv-missing' }, err.message));
  }
  let grades = await api.get('/agent-ops/grades', { runId });
  let overlay = { runReview: null, stepReviews: {}, corrections: {}, redactions: {} };
  try { overlay = await api.get(`/agent-ops/research/overlay/${runId}`); } catch { /* older server */ }
  const st = stateOf(runId);
  st.filters = st.filters || { actor: 'all', action: '', graded: false, alert: false, excluded: false };
  const reloadOverlay = async () => { overlay = await api.get(`/agent-ops/research/overlay/${runId}`); };
  const { run, context, steps } = data;
  const shownAt = Date.now();

  const passesFilter = (s) => { const f = st.filters; if (f.actor === 'agent' && s.who.kind !== 'agent') return false; if (f.actor === 'human' && s.who.kind !== 'human') return false; if (f.action && !String(s.type).toLowerCase().includes(f.action.toLowerCase()) && !label(s).toLowerCase().includes(f.action.toLowerCase())) return false; if (f.graded && !grades.steps[s.id] && !grades.stepTotals[s.id]) return false; if (f.alert && !(s.tone === 'alert' || s.tone === 'reject' || s.checks.some((c) => !c.pass))) return false; if (f.excluded && overlay.stepReviews[s.id]?.decision !== 'exclude') return false; return true; };
  const visible = () => steps.filter((s) => (st.showScreen || s.source !== 'ui') && (st.showSystem || !['system.derive', 'episode.create'].includes(s.type) || s.checks.length) && passesFilter(s));
  // A decision is the write an agent made plus the look-ups that led to it. Groups of two or more look-ups can be folded.
  function groups(list) {
    const out = [];
    let run_ = [];
    const flush = (closer) => { if (run_.length >= 2) out.push({ id: run_[0].id, lookups: run_, closer }); else out.push(...run_.map((s) => ({ step: s }))); run_ = []; };
    for (const s of list) {
      if (isLookup(s)) { run_.push(s); continue; }
      const closes = s.tone === 'agent' && run_.length;
      flush(closes ? s : null);
      out.push({ step: s });
    }
    flush(null);
    return out;
  }
  if (!st.foldedInit) { for (const g of groups(visible())) if (g.lookups && g.lookups.length >= 4) st.folded.add(g.id); st.foldedInit = true; }
  if (!st.selected || !steps.some((s) => s.id === st.selected)) st.selected = visible().find((s) => s.tone === 'agent' && s.wrote)?.id ?? visible()[0]?.id ?? null;

  const timeline = h('div', { class: 'tvline', testid: 'tv-timeline', role: 'listbox', 'aria-label': 'Steps of this run', tabindex: 0 });
  const detail = h('div', { class: 'tvdetail', testid: 'tv-detail' });
  const label = (s) => describeAction(s.type, s.args);
  const who = (s) => (s.who.kind === 'agent' ? 'Agent' : s.who.role === 'system' ? 'System' : `${s.who.role}`);

  async function saveStepGrade(step, value, comment) {
    try {
      await api.post('/agent-ops/grades/steps', { runId, stepId: step.id, value, comment });
      grades = await api.get('/agent-ops/grades', { runId });
      st.pick = null;
      toast(value === 'up' ? 'Marked as a good step' : 'Marked as a poor step');
    } catch (err) { showError(err); }
    draw();
  }

  function row(s, inside = false) {
    const mine = grades.steps[s.id];
    const total = grades.stepTotals[s.id];
    return h('div', { class: `tvrow ${s.tone}${st.selected === s.id ? ' selected' : ''}${inside ? ' inside' : ''}`, role: 'option', 'aria-selected': st.selected === s.id ? 'true' : 'false', testid: `tv-step-${s.n}`, 'data-step': s.id,
      onClick: (e) => { if (e.target.closest('button')) return; st.selected = s.id; st.grading = false; draw(); } },
    h('span', { class: 'tvn' }, String(s.n)),
    h('span', { class: 'tvwho' }, h('span', { class: `tvtone ${s.tone}` }, TONE[s.tone]), s.tone === 'alert' || s.tone === 'reject' ? ` · ${who(s)}` : s.who.kind === 'human' ? ` · ${who(s)}` : ''),
    h('span', { class: 'tvwhat' }, label(s),
      s.checks.map((c) => h('span', { class: `tvcheck ${c.pass ? 'pass' : 'fail'}`, testid: `tv-check-${c.id}`, title: c.pass ? 'Check passed' : c.forbidden ? 'Something the case says to avoid' : 'Check failed' }, `${c.pass ? '☑' : '✕'} ${c.label}`)),
      mine ? h('span', { class: `tvcheck ${mine.value === 'up' ? 'pass' : 'fail'}`, testid: `tv-graded-${s.n}` }, mine.value === 'up' ? 'You: good step' : 'You: poor step') : null,
      !mine && total ? h('span', { class: 'muted small' }, ` graded by ${total.up + total.down}`) : null),
    h('span', { class: 'tvtime' }, elapsed(s.elapsedMs)),
    btn('Grade this step', { small: true, testid: `tv-grade-${s.n}`, onClick: () => { st.selected = s.id; st.grading = true; st.pick = grades.steps[s.id]?.value ?? null; draw(); } }));
  }

  function drawTimeline() {
    const list = visible();
    const nodes = [filterBar()];
    for (const g of groups(list)) {
      if (g.step) {
        if (g.step.split) nodes.push(h('div', { class: 'tvsplit', testid: 'tv-split', role: 'note' }, h('strong', {}, 'Split point. '), `From here the agent and the clinician took different paths. Agent: ${data.split.agent.did}. Clinician: ${data.split.human.did}.`));
        nodes.push(row(g.step));
        continue;
      }
      const folded = st.folded.has(g.id);
      const hasSplit = g.lookups.find((s) => s.split);
      if (hasSplit) nodes.push(h('div', { class: 'tvsplit', testid: 'tv-split', role: 'note' }, h('strong', {}, 'Split point. '), `From here the agent and the clinician took different paths. Agent: ${data.split.agent.did}. Clinician: ${data.split.human.did}.`));
      nodes.push(h('div', { class: 'tvgroup', testid: `tv-group-${g.lookups[0].n}` },
        h('button', { type: 'button', class: 'tvfold', 'aria-expanded': folded ? 'false' : 'true', testid: `tv-fold-${g.lookups[0].n}`, 'aria-label': `${folded ? 'Show' : 'Hide'} ${g.lookups.length} look-ups`, onClick: () => { if (folded) st.folded.delete(g.id); else st.folded.add(g.id); draw(); } },
          `${folded ? 'Show' : 'Hide'} ${g.lookups.length} look-ups${g.closer ? ` before: ${label(g.closer)}` : ''} (steps ${g.lookups[0].n} to ${g.lookups.at(-1).n})`),
        folded ? null : g.lookups.map((s) => row(s, true))));
    }
    if (data.outcome.checks.some((c) => !c.pinned)) {
      nodes.push(h('div', { class: 'tvrow outcome', testid: 'tv-outcome-row' }, h('span', { class: 'tvn' }, ''), h('span', { class: 'tvwho' }, 'Outcome'),
        h('span', { class: 'tvwhat' }, 'Checks no single step accounts for', data.outcome.checks.filter((c) => !c.pinned).map((c) => h('span', { class: `tvcheck ${c.pass ? 'pass' : 'fail'}`, testid: `tv-check-${c.id}` }, `${c.pass ? '☑' : '✕'} ${c.label}${c.pass ? '' : c.forbidden ? '' : ' (not done)'}`))),
        h('span', { class: 'tvtime' }, ''), h('span', {})));
    }
    for (const hz of data.horizons) {
      const done = hz.status === 'done';
      const passed = done ? (hz.agent?.checks || []).filter((c) => c.pass).length : 0;
      nodes.push(h('div', { class: 'tvrow horizon', testid: `tv-horizon-${hz.label}` }, h('span', { class: 'tvn' }, ''), h('span', { class: 'tvwho' }, 'Later outcome'),
        h('span', { class: 'tvwhat' }, `At ${HORIZON_NAME[hz.label] || hz.label}: `, done ? `${passed} of ${(hz.agent?.checks || []).length} checks passed${hz.clinician ? `; the clinician's chart: ${(hz.clinician.checks || []).filter((c) => c.pass).length} of ${hz.clinician.checks.length}` : ''}` : `not due yet${hz.dueAt ? ` (due ${fmtDateTime(hz.dueAt)})` : ''}`,
          done ? (hz.agent?.checks || []).map((c) => h('span', { class: `tvcheck ${c.pass ? 'pass' : 'fail'}` }, `${c.pass ? '☑' : '✕'} ${c.label}`)) : null),
        h('span', { class: 'tvtime' }, hz.clock === 'replayed' ? 'replayed' : 'live'), h('span', {})));
    }
    if (!nodes.length) nodes.push(h('div', { class: 'card empty' }, 'This run has no steps.'));
    clear(timeline).append(...nodes);
  }

  function gradeWidget(s) {
    const mine = grades.steps[s.id];
    const comment = h('input', { type: 'text', maxlength: 300, placeholder: 'Optional one-line comment', value: mine?.comment ?? '', testid: 'tv-grade-comment', 'aria-label': 'Optional comment on this step',
      onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = st.pick ?? mine?.value; if (v) saveStepGrade(s, v, comment.value); } } });
    const thumb = (value, text, key) => h('button', { type: 'button', class: `tvthumb${(st.pick ?? mine?.value) === value ? ' on' : ''}`, 'aria-pressed': (st.pick ?? mine?.value) === value ? 'true' : 'false', testid: `tv-thumb-${value}`, 'aria-label': `${text} (key ${key})`,
      onClick: () => saveStepGrade(s, value, comment.value) }, h('kbd', {}, key), text);
    return h('div', { class: 'tvgradebox', testid: 'tv-grade-widget' }, h('h3', {}, `Grade step ${s.n}`),
      h('div', { class: 'toolbar', style: 'margin:0 0 0.5rem' }, thumb('up', 'Thumbs up', 'U'), thumb('down', 'Thumbs down', 'D')), comment,
      h('p', { class: 'muted small', style: 'margin:0.375rem 0 0' }, st.pick && st.pick !== mine?.value ? 'Press Enter to save.' : mine ? 'Saved. Click the other thumb to change it.' : 'Saved the moment you click. Keys: U or D, then Enter.'));
  }

  function episodeForm() {
    if (!grades.episodeId) return h('div', { class: 'card', testid: 'tv-episode-none' }, h('h3', { style: 'margin-top:0' }, 'Grade the whole run'), h('p', { class: 'muted', style: 'margin:0' }, 'This run has no scored episode, so only its steps can be graded.'));
    const mine = adjudicating ? null : grades.episode;
    let chosen = mine?.value ?? null;
    const error = h('div', { class: 'form-error', testid: 'tv-episode-error', role: 'alert' });
    const options = h('div', { class: 'tvgrades', role: 'radiogroup', 'aria-label': 'Overall grade' });
    const comment = h('textarea', { rows: 2, testid: 'tv-episode-comment', 'aria-label': 'Comment (required for Unsafe)', placeholder: 'Comment (required for Unsafe)' }, mine?.comment ?? '');
    comment.value = mine?.comment ?? '';
    const correction = h('textarea', { rows: 2, testid: 'tv-episode-correction', 'aria-label': 'What was the correct action?', placeholder: 'What was the correct action? (optional)' });
    correction.value = mine?.correction ?? '';
    const conf = h('input', { type: 'range', min: 1, max: 5, step: 1, value: mine?.confidence ?? 3, testid: 'tv-episode-confidence', 'aria-label': 'How certain are you? 1 is not at all, 5 is certain' });
    const confText = h('span', { class: 'muted small', testid: 'tv-episode-confidence-value' }, String(conf.value));
    conf.addEventListener('input', () => { confText.textContent = conf.value; });
    const drawOptions = () => clear(options).append(...grades.grades.map((g) => h('button', { type: 'button', class: `tvgrade${chosen === g.id ? ' on' : ''}${g.id === 'unsafe' ? ' unsafe' : ''}`, role: 'radio', 'aria-checked': chosen === g.id ? 'true' : 'false', testid: `tv-episode-${g.id}`, 'aria-label': g.label, onClick: () => { chosen = g.id; drawOptions(); } }, g.label)));
    drawOptions();
    const submit = btn(adjudicating ? 'Save the final grade' : mine ? 'Update my grade' : 'Save grade', { kind: 'primary', testid: 'tv-episode-submit', onClick: async () => {
      error.textContent = '';
      if (!chosen) { error.textContent = 'Choose a grade first'; return; }
      if (chosen === 'unsafe' && !comment.value.trim()) { error.textContent = 'Say what was unsafe. An "Unsafe" grade sends this run to the safety queue.'; return; }
      try {
        await api.post('/agent-ops/grades/episodes', { episodeId: grades.episodeId, grade: chosen, comment: comment.value, correction: correction.value, confidence: Number(conf.value), seconds: Math.round((Date.now() - shownAt) / 100) / 10, ...(adjudicating ? { role: 'adjudication' } : {}) });
        toast(chosen === 'unsafe' ? 'Graded unsafe. The run is now in the safety queue.' : 'Grade saved. The reward for this run has been updated.');
        if (fromQueue) {
          const q = await api.get('/agent-ops/grades/queue');
          const next = adjudicating ? q.adjudication.find((a) => !a.mine) : q.queue[0];
          if (next) go(`#/trace/${next.runId}?${adjudicating ? 'adjudicate' : 'queue'}=1`); else go('#/grading');
        } else render();
      } catch (err) { error.textContent = err.message; }
    } });
    return h('div', { class: 'card', testid: 'tv-episode-form' }, h('h3', { style: 'margin-top:0' }, adjudicating ? 'Final grade (adjudication)' : 'Grade the whole run'),
      adjudicating ? h('p', { class: 'muted small', style: 'margin:0 0 0.5rem' }, 'Two graders disagreed. Your grade settles it.') : grades.otherGraders ? h('p', { class: 'muted small', testid: 'tv-other-graders', style: 'margin:0 0 0.5rem' }, `${grades.otherGraders} other grader${grades.otherGraders === 1 ? ' has' : 's have'} graded this run. You will not see their grade.`) : null,
      options, h('label', { class: 'field', style: 'margin-top:0.625rem' }, h('span', {}, 'What was the correct action?'), correction),
      h('label', { class: 'field', style: 'margin-top:0.5rem' }, h('span', {}, 'Comment'), comment),
      h('label', { class: 'field', style: 'margin-top:0.5rem' }, h('span', {}, 'How certain are you? (1 to 5) ', confText), conf), error, h('div', { class: 'toolbar', style: 'margin:0.625rem 0 0' }, submit));
  }

  // ---------- Reviewing before export (plan-master 6.7): decisions, corrections, redactions and replay are new records overlaid on the trace. ----------
  const decide = async (target, decision, kind) => { const reason = decision === 'include' ? '' : await askReason({ title: decision === 'exclude' ? `Exclude this ${kind} from exports` : `Flag this ${kind} as needing a fix`, label: 'Reason', submitLabel: decision === 'exclude' ? 'Exclude' : 'Flag', testid: 'tv-review-reason' }); if (decision !== 'include' && reason == null) return; await api.post('/agent-ops/research/reviews', { target, decision, reason: reason || '' }); await reloadOverlay(); toast(decision === 'include' ? 'Marked include' : decision === 'exclude' ? 'Excluded from exports' : 'Flagged as needing a fix'); draw(); };
  const addCorrection = (target) => formDialog({ title: 'What should have happened?', testid: 'tv-correction', submitLabel: 'Save correction', intro: 'A correction is attached to exports; the original step is never changed.', fields: [{ name: 'type', label: 'Action type', type: 'select', options: [['', '—'], ['ServiceRequest', 'Order'], ['MedicationRequest', 'Prescription'], ['DiagnosticReport', 'Report'], ['DocumentReference', 'Note'], ['Task', 'Task'], ['Communication', 'Message'], ['none', 'Do nothing']], testid: 'tv-correction-type' }, { name: 'code', label: 'Code (LOINC, RxNorm, ...)', testid: 'tv-correction-code' }, { name: 'label', label: 'In plain words', testid: 'tv-correction-label', wide: true }, { name: 'note', label: 'Note', type: 'textarea', rows: 3, testid: 'tv-correction-note', wide: true }], onSubmit: async (v) => { await api.post('/agent-ops/research/corrections', { target, correctAction: v.type || v.label ? { type: v.type, code: v.code, label: v.label } : null, note: v.note }); await reloadOverlay(); undefined; draw(); } });
  const addRedaction = (target) => formDialog({ title: 'Redact from exports', testid: 'tv-redaction', submitLabel: 'Redact', intro: 'The field is replaced by [redacted] in every export. The log keeps it.', fields: [{ name: 'path', label: 'Field', type: 'select', options: [['did.args.text', 'Text written'], ['did.args.target', 'Control used'], ['why', 'Reason given'], ['did.args', 'All step details']], testid: 'tv-redaction-path' }, { name: 'reason', label: 'Reason', required: true, testid: 'tv-redaction-reason', wide: true }], onSubmit: async (v) => { await api.post('/agent-ops/research/redactions', { target, path: v.path, reason: v.reason }); await reloadOverlay(); toast('Redacted from exports'); draw(); } });
  const showReplay = async (s) => { const r = await api.get(`/agent-ops/replay/${runId}/${s.id}`); openDialog({ title: 'What they saw', testid: 'tv-replay', wide: true, body: h('div', {}, kv([['Screen', r.screen.app ? `${r.screen.app} ${r.screen.route || ''}` : 'Not a screen event'], ['Patient', r.patient || '—'], ['Chart as of', r.asOf ? fmtDateTime(r.asOf) : '—'], ['Branch', r.branch]]), r.viewport ? h('p', { class: 'small' }, `Viewer: ${JSON.stringify(r.viewport)}`) : null, h('h3', {}, `Records as they were (${r.resources.length})`), r.resources.length ? h('div', { style: 'max-height:50vh;overflow:auto' }, ...r.resources.map((x) => h('details', {}, h('summary', {}, `${x.ref} · version ${x.versionId ?? '?'}${x.exactVersion ? '' : ' (nearest)'}`), h('pre', { class: 'code', style: 'white-space:pre-wrap' }, JSON.stringify(x.body, null, 1))))) : h('p', { class: 'muted' }, 'This step read no record.'), r.screen.app && r.screen.route ? h('p', {}, h('a', { href: `/${r.screen.app}/${r.screen.route.includes('#') ? r.screen.route.slice(r.screen.route.indexOf('#')) : ''}${r.branch !== 'main' ? `?branch=${r.branch}` : ''}`, target: '_blank', rel: 'noopener', testid: 'tv-replay-open', 'aria-label': 'Open that screen' }, 'Open that screen in the app')) : null), actions: [{ label: 'Close', onClick: (c) => c() }] }); };
  function reviewBlock(s) {
    const rev = overlay.stepReviews[s.id]; const corr = overlay.corrections[s.id] || []; const red = overlay.redactions[s.id] || [];
    return h('div', { testid: 'tv-review' }, h('h3', {}, 'Review'),
      h('div', { class: 'tvreview' }, btn(rev?.decision === 'include' ? 'Included' : 'Include', { small: true, testid: 'tv-include', 'aria-pressed': String(rev?.decision === 'include'), onClick: () => decide(s.id, 'include', 'step').catch(showError) }), btn(rev?.decision === 'exclude' ? 'Excluded' : 'Exclude', { small: true, testid: 'tv-exclude', title: 'X', onClick: () => decide(s.id, 'exclude', 'step').catch(showError) }), btn('Needs a fix', { small: true, testid: 'tv-needs-fix', onClick: () => decide(s.id, 'needs-fix', 'step').catch(showError) }), btn('Add correction', { small: true, testid: 'tv-add-correction', title: 'C', onClick: () => addCorrection(s.id) }), btn('Redact from exports', { small: true, testid: 'tv-redact', onClick: () => addRedaction(s.id) }), btn('Show what they saw', { small: true, testid: 'tv-replay-btn', onClick: () => showReplay(s).catch(showError) })),
      rev ? h('p', { class: 'tvoverlay', testid: 'tv-review-state' }, h('b', {}, rev.decision), ` by ${rev.reviewer} at ${fmtDateTime(rev.at)}${rev.reason ? `: ${rev.reason}` : ''}`) : null,
      ...corr.map((c) => h('p', { class: 'tvoverlay', testid: 'tv-correction-state' }, h('b', {}, 'Correction'), ` ${c.correctAction?.label || ''}${c.note ? ` — ${c.note}` : ''} (${c.reviewer}, ${fmtDateTime(c.at)})`)),
      ...red.map((r) => h('p', { class: 'tvoverlay', testid: 'tv-redaction-state' }, h('b', {}, 'Redacted'), ` ${r.path}: ${r.reason} (${r.reviewer})`)));
  }
  function runReviewBlock() {
    const rev = overlay.runReview;
    return h('div', { class: 'card', testid: 'tv-run-review' }, h('h3', { style: 'margin-top:0' }, 'This run'),
      h('div', { class: 'tvreview' }, btn(rev?.decision === 'include' ? 'Included' : 'Include run', { small: true, testid: 'tv-run-include', onClick: () => decide(runId, 'include', 'run').catch(showError) }), btn(rev?.decision === 'exclude' ? 'Excluded' : 'Exclude run', { small: true, testid: 'tv-run-exclude', onClick: () => decide(runId, 'exclude', 'run').catch(showError) }), btn('Add to dataset', { small: true, kind: 'primary', testid: 'tv-add-to-dataset', onClick: async () => { let study = null; try { study = localStorage.getItem('hd.study'); } catch { study = null; } if (!study) { toast('Choose a current study first', { error: true }); return; } await api.post(`/agent-ops/research/studies/${study}/links`, { kind: run.mode === 'capture' ? 'recording' : 'run', ref: runId }); toast('Added to the current study'); } }), fromQueue ? btn('Next in the queue', { small: true, testid: 'tv-queue-next', onClick: () => go('#/review') }) : null),
      rev ? h('p', { class: 'tvoverlay', testid: 'tv-run-review-state' }, h('b', {}, rev.decision), ` by ${rev.reviewer} at ${fmtDateTime(rev.at)}${rev.reason ? `: ${rev.reason}` : ''}`) : h('p', { class: 'muted small' }, 'Not reviewed yet. Nothing here changes the log: decisions are overlaid on the trace with who and when.'));
  }
  const filterBar = () => { const f = st.filters; const set = (k, v) => { f[k] = v; draw(); }; return h('div', { class: 'tvfilters', testid: 'tv-filters' }, h('select', { testid: 'tv-filter-actor', 'aria-label': 'Filter by actor', style: 'width:auto', onChange: (e) => set('actor', e.target.value) }, [['all', 'Agent and human'], ['agent', 'Agent only'], ['human', 'Human only']].map(([v, t]) => h('option', { value: v, selected: f.actor === v }, t))), h('input', { type: 'search', placeholder: 'Action type', value: f.action, testid: 'tv-filter-action', 'aria-label': 'Filter by action type', style: 'width:10rem', onInput: (e) => { f.action = e.target.value; draw(); } }), ...[['graded', 'Has a grade'], ['alert', 'Has a safety alert'], ['excluded', 'Excluded']].map(([k, t]) => h('label', { style: 'display:flex;gap:0.25rem;align-items:center' }, h('input', { type: 'checkbox', checked: f[k], testid: `tv-filter-${k}`, 'aria-label': t, onChange: (e) => set(k, e.target.checked) }), t))); };
  function drawDetail() {
    const s = steps.find((x) => x.id === st.selected);
    const parts = [];
    if (s) {
      const sawList = s.saw.resources.length
        ? h('ul', { class: 'tvsaw', testid: 'tv-saw' }, s.saw.resources.map((r) => h('li', {}, h('span', { class: 'muted small' }, `${r.kind} `), h('b', {}, r.name), r.value ? ` — ${r.value}` : '')), s.saw.more ? h('li', { class: 'muted' }, `and ${s.saw.more} more`) : null)
        : h('p', { class: 'muted', testid: 'tv-saw', style: 'margin:0' }, s.source === 'ui' ? 'A screen event: no record was read.' : 'Nothing was read at this step.');
      const ab = s.saw.ablated;
      parts.push(h('div', { class: 'card', testid: 'tv-step-detail' },
        h('div', { class: 'tvhead' }, h('span', { class: `tvtone ${s.tone}` }, TONE[s.tone]), h('b', {}, ` Step ${s.n}: ${label(s)}`)),
        st.grading ? gradeWidget(s) : h('div', { class: 'toolbar', style: 'margin:0.5rem 0 0' }, btn(grades.steps[s.id] ? 'Change my grade of this step' : 'Grade this step', { small: true, testid: 'tv-detail-grade', onClick: () => { st.grading = true; st.pick = grades.steps[s.id]?.value ?? null; draw(); } })),
        h('h3', {}, 'Saw'), sawList,
        h('p', { class: 'muted small', style: 'margin:0.375rem 0 0' }, `Chart as of ${s.saw.asOf ? fmtDateTime(s.saw.asOf) : 'that moment (live)'} · ${s.saw.branch === 'main' ? 'live chart' : `copy of the chart (${s.saw.branch})`}`),
        ab && (ab.hidden + ab.delayed + ab.changed) ? h('p', { class: 'small', style: 'margin:0.25rem 0 0;color:var(--warn)' }, `Changed for this run: ${ab.hidden} hidden, ${ab.delayed} held back, ${ab.changed} altered.`) : null,
        h('h3', {}, 'Did'), h('p', { style: 'margin:0', testid: 'tv-did' }, label(s), s.wrote ? `: ${s.wrote.name}${s.wrote.value ? ` (${s.wrote.value})` : ''}` : ''),
        s.wrote?.lines?.length ? h('dl', { class: 'tvlines' }, s.wrote.lines.flatMap((l) => [h('dt', {}, l.label), h('dd', {}, l.value)])) : null,
        s.wrote ? h('details', { class: 'tvraw' }, h('summary', { testid: 'tv-raw', 'aria-label': 'Show the record as stored' }, 'Show the record as stored (FHIR)'), h('pre', {}, JSON.stringify(s.wrote.resource, null, 2))) : null,
        h('h3', {}, 'Why'), h('p', { style: 'margin:0;white-space:pre-wrap', testid: 'tv-why' }, s.why || h('span', { class: 'muted' }, s.who.kind === 'agent' ? 'The agent gave no reason for this step.' : 'No reason was recorded.')),
        reviewBlock(s),
        h('h3', {}, 'Outcome'), s.checks.length
          ? h('ul', { class: 'tvsaw', testid: 'tv-outcome' }, s.checks.map((c) => h('li', {}, h('span', { class: `tvcheck ${c.pass ? 'pass' : 'fail'}` }, c.pass ? '☑ Passed' : '✕ Failed'), ` ${c.label}${c.forbidden ? ' (something to avoid)' : ''}`)))
          : h('p', { class: 'muted', style: 'margin:0', testid: 'tv-outcome' }, 'No check depends on this step.')));
    }
    if (data.humanPath && data.split) {
      parts.push(h('div', { class: 'card', testid: 'tv-both' }, h('h3', { style: 'margin-top:0' }, `Where they split (step ${data.split.step} of each path)`),
        h('p', { style: 'margin:0 0 0.375rem' }, h('span', { class: 'tvtone agent' }, 'Agent'), ` ${data.split.agent.did}. `, h('span', { class: 'muted' }, data.split.agent.why || 'No reason given.')),
        h('p', { style: 'margin:0' }, h('span', { class: 'tvtone human' }, 'Clinician'), ` ${data.split.human.did}. `, h('span', { class: 'muted' }, data.split.human.why || 'No reason recorded.'))));
    }
    if (s && run.agentId) parts.push(h('div', { class: 'toolbar', style: 'margin:0.5rem 0' }, reportProblemButton({ run: run.id, step: s.id }, { label: 'Report a problem with this step', testid: 'tv-report-problem' })));
    parts.push(runReviewBlock());
    parts.push(episodeForm());
    clear(detail).append(...parts);
  }

  function draw() {
    drawTimeline(); drawDetail();
    timeline.querySelector('.tvrow.selected')?.scrollIntoView({ block: 'nearest' });
  }

  unbind();
  const onKey = (e) => {
    if (document.querySelector('dialog[open]') || e.ctrlKey || e.metaKey || e.altKey) return;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target?.tagName);
    if (typing && !(e.target.dataset.testid === 'tv-grade-comment' && e.key === 'Escape')) return;
    const list = visible().filter((s) => !groups(visible()).some((g) => g.lookups && st.folded.has(g.id) && g.lookups.includes(s)));
    const at = list.findIndex((s) => s.id === st.selected);
    const key = e.key.toLowerCase();
    const current = steps.find((s) => s.id === st.selected);
    if (e.key === 'ArrowDown' || key === 'j') { if (at < list.length - 1) { st.selected = list[at + 1].id; st.grading = false; st.pick = null; draw(); } e.preventDefault(); return; }
    if (e.key === 'ArrowUp' || key === 'k') { if (at > 0) { st.selected = list[at - 1].id; st.grading = false; st.pick = null; draw(); } e.preventDefault(); return; }
    if (key === 'g' && current) { st.grading = true; st.pick = grades.steps[current.id]?.value ?? null; draw(); e.preventDefault(); return; }
    if (key === 'x' && current) { decide(current.id, 'exclude', 'step').catch(showError); e.preventDefault(); return; }
    if (key === 'c' && current) { addCorrection(current.id); e.preventDefault(); return; }
    if (e.key === 'Escape' && st.grading) { st.grading = false; st.pick = null; draw(); e.preventDefault(); return; }
    if (st.grading && current && (key === 'u' || key === 'd')) { st.pick = key === 'u' ? 'up' : 'down'; draw(); e.preventDefault(); return; }
    if (st.grading && current && e.key === 'Enter' && st.pick) { saveStepGrade(current, st.pick, detail.querySelector('[data-testid="tv-grade-comment"]')?.value ?? ''); e.preventDefault(); }
  };
  document.addEventListener('keydown', onKey);
  unbind = () => document.removeEventListener('keydown', onKey);

  const screen = steps.filter((s) => s.source === 'ui').length;
  const system = steps.filter((s) => ['system.derive', 'episode.create'].includes(s.type) && !s.checks.length).length;
  const toggle = (key, text, n, testid) => (n ? h('label', { class: 'tvtoggle' }, h('input', { type: 'checkbox', checked: st[key], testid, 'aria-label': text, onChange: (e) => { st[key] = e.target.checked; draw(); } }), `${text} (${n})`) : null);
  const strip = h('div', { class: 'card tvcontext', testid: 'tv-context' },
    h('div', { class: 'tvtitle' }, h('b', { testid: 'tv-title' }, context.title), context.split === 'eval' ? badge('evaluation only', 'warn') : null, badge(MODE[run.mode] || run.mode, 'accent'), runPermissions(run, 'tv-permissions')),
    context.scenario ? h('p', { testid: 'tv-scenario' }, h('span', { class: 'muted' }, 'Scenario: '), context.scenario) : null,
    context.task ? h('p', { testid: 'tv-task' }, h('span', { class: 'muted' }, 'Task: '), context.task) : null,
    h('p', { class: 'muted small' }, run.agentId ? `${run.agentId} v${run.version}` : 'No agent (a person working)', ` · started ${fmtDateTime(run.startedAt)} · ${steps.length} steps`,
      data.outcome.score != null ? ` · ${Math.round(data.outcome.score * 100)}% of the case's checks` : '', run.result?.summary ? ` · Agent said: ${run.result.summary}` : ''));
  draw();
  return h('div', { class: 'tvpage' },
    h('div', { class: 'page-head' }, h('h1', {}, adjudicating ? 'Adjudicate a grade' : 'Trace'), h('div', { class: 'toolbar', style: 'margin:0' },
      fromQueue ? btn('Back to the grading queue', { testid: 'tv-queue', onClick: () => go('#/grading') }) : null,
      btn('Run details', { testid: 'tv-run', onClick: () => go(`#/runs/${runId}`) }))),
    strip,
    h('div', { class: 'toolbar', style: 'margin:0.625rem 0' }, toggle('showScreen', 'Show screen events', screen, 'tv-show-screen'), toggle('showSystem', 'Show bookkeeping steps', system, 'tv-show-system'),
      h('span', { class: 'muted small', testid: 'tv-keys' }, 'Keys: Up and Down move between steps · G grades the selected step · U or D, then Enter')),
    h('div', { class: 'tv' }, timeline, detail));
}
