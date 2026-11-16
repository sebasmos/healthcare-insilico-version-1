// Agent Dashboard → benchmarks: the scribe benchmark, regression replay and the
// leaderboard across agent versions.
import { h, btn, badge, toast, table, card, kv, fmtDateTime, showError } from '/shared/ui.js';
import { api } from '/shared/fhir.js';

const page = (title, actions, ...content) => h('div', {}, h('div', { class: 'page-head' }, h('h1', {}, title), actions), ...content);
const tile = (label, value, testid) => h('div', { class: 'card' }, h('span', { class: 'muted small' }, label), h('b', { testid }, value));
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const select = (testid, label, value, options, onChange) => h('select', { testid, 'aria-label': label, style: 'width:auto', onChange: (e) => onChange(e.target.value) }, options.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) }, t)));
const TYPE = { outpatient: 'Outpatient', inpatient: 'Inpatient', emergency: 'Emergency' };

// ---------- Note accuracy: the built-in benchmark for agents that write notes ----------
const sb = { agentId: null, split: '' };
export async function scribeRunCard(go, render) {
  const [{ agents }, bank] = await Promise.all([api.get('/agent-ops/agents'), api.get('/agent-ops/scribe/cases')]);
  const scribes = agents.filter((a) => a.enabled && (a.scopes || []).some((s) => s.type === 'DocumentReference' && s.interactions.includes('create')));
  if (!scribes.some((a) => a.id === sb.agentId)) sb.agentId = scribes[0]?.id ?? null;
  const missing = bank.library.filter((c) => !c.loaded).length;
  const load = missing ? btn(`Load my ${missing} scribe case${missing === 1 ? '' : 's'}`, { testid: 'scribe-load', onClick: async () => { try { const out = await api.post('/agent-ops/scribe/cases/load', {}); toast(`${plural(out.loaded.length, 'case')} loaded`); } catch (err) { showError(err); } render(); } }) : null;
  if (!bank.cases.length) return h('div', { class: 'card launch', testid: 'scribe-card' }, h('p', { style: 'margin:0 0 0.625rem' }, 'No scribe cases yet. The release ships with none: put your own in data/library/scribe (see docs/DATA.md).'), load);
  return h('div', { class: 'card launch', testid: 'scribe-card' },
    h('p', { style: 'margin-top:0' }, 'The agent reads an encounter transcript and the chart as it was at that moment, then writes the note. Its note is compared with a list of clinical elements a correct note contains.'),
    h('div', { class: 'row' }, h('label', {}, 'Agent'), scribes.length ? select('scribe-agent', 'Agent to benchmark', sb.agentId, scribes.map((a) => [a.id, `${a.name} v${a.version}`]), (v) => { sb.agentId = v; }) : h('span', { class: 'muted', testid: 'scribe-no-agent' }, 'No enabled agent is allowed to write notes.')),
    h('div', { class: 'row' }, h('label', {}, 'Cases'), select('scribe-split', 'Which cases', sb.split, [['', `All ${bank.cases.length} loaded cases`], ['eval', `Evaluation cases only (${bank.cases.filter((c) => c.split === 'eval').length})`], ['train', `Training cases only (${bank.cases.filter((c) => c.split === 'train').length})`]], (v) => { sb.split = v; })),
    h('div', { class: 'toolbar', style: 'margin:0.875rem 0 0' }, btn('Start  →', { kind: 'primary', testid: 'launch-start', disabled: !sb.agentId, onClick: async () => {
      try { const out = await api.post('/agent-ops/scribe/run', { agentId: sb.agentId, split: sb.split || undefined }); toast(`Benchmark finished: ${plural(out.rows.length, 'case')}`); go('#/scribe'); render(); } catch (err) { showError(err); }
    } }), load, btn('Results', { testid: 'scribe-results-link', onClick: () => go('#/scribe') })));
}

export async function scribePage(go, render) {
  const out = await api.get('/agent-ops/scribe/results');
  const runCard = await scribeRunCard(go, render);
  if (!out.rows.length) return page('Benchmark: note accuracy', null, runCard, h('div', { style: 'height:1rem' }), h('div', { class: 'card empty', testid: 'scribe-empty' }, 'No benchmark has been run yet.'));
  const sections = out.summary.map((g) => {
    const key = g.key.replace(/[^A-Za-z0-9-]/g, '-');
    const rows = out.rows.filter((r) => `${r.agentId}@${r.version}` === g.key);
    return h('section', { testid: `scribe-agent-${key}`, style: 'margin-bottom:1.75rem' }, h('h2', { style: 'margin:0' }, `${g.agentId} v${g.version}`),
      h('div', { class: 'tiles6' }, tile('Cases', g.all.cases, `scribe-cases-${key}`), tile('Completeness', pct(g.all.completeness), `scribe-completeness-${key}`), tile('Accuracy', pct(g.all.accuracy), `scribe-accuracy-${key}`),
        tile('Unsupported content', pct(g.all.hallucinationRate), `scribe-hallucination-${key}`), tile('Format', pct(g.all.format), `scribe-format-${key}`), tile('Mean time', g.all.ms == null ? '—' : `${g.all.ms} ms`, `scribe-time-${key}`)),
      h('h3', {}, 'By kind of encounter'),
      table({ testid: `scribe-by-type-${key}`, rows: Object.entries(g.byEncounterType).map(([type, a]) => ({ type, ...a })), columns: [
        { label: 'Encounter', render: (r) => TYPE[r.type] || r.type }, { label: 'Cases', render: (r) => r.cases }, { label: 'Completeness', render: (r) => pct(r.completeness) }, { label: 'Accuracy', render: (r) => pct(r.accuracy) },
        { label: 'Unsupported content', render: (r) => `${pct(r.hallucinationRate)} (${r.hallucinations})` }, { label: 'Format', render: (r) => pct(r.format) }, { label: 'Mean time', render: (r) => (r.ms == null ? '—' : `${r.ms} ms`) },
      ] }),
      h('h3', { style: 'margin-top:1rem' }, 'By case'),
      table({ testid: `scribe-rows-${key}`, rows, rowId: (r) => r.runId, onRow: (r) => go(`#/scribe/${r.runId}`), columns: [
        { label: 'Case', render: (r) => [r.title, ' ', r.split === 'eval' ? badge('evaluation', 'warn') : null] }, { label: 'Encounter', render: (r) => TYPE[r.encounterType] || r.encounterType },
        { label: 'Completeness', render: (r) => `${pct(r.completeness)} (${r.counts.found} of ${r.counts.gold})` }, { label: 'Accuracy', render: (r) => pct(r.accuracy) },
        { label: 'Unsupported', render: (r) => r.hallucinations }, { label: 'Format', render: (r) => pct(r.format) }, { label: 'Time', render: (r) => `${r.ms} ms` },
        { label: 'Corrected by a person', render: (r) => (r.corrected ? plural(r.corrected, 'item') : '') },
      ] }));
  });
  return page('Benchmark: note accuracy', h('a', { class: 'btn', href: '/agent-ops/export/scribe-benchmark.jsonl', download: '', testid: 'export-scribe', 'aria-label': 'Download scribe-benchmark.jsonl' }, 'scribe-benchmark.jsonl'),
    h('p', { class: 'muted', testid: 'scribe-note', style: 'margin:-0.375rem 0 1.125rem;max-width:56.25rem' }, out.note, ' Completeness: gold elements that appear in the note. Accuracy: of those, the share stated correctly. Unsupported content: clinical terms, codes and quantities in the note that neither the transcript nor the chart mentions.'),
    runCard, h('div', { style: 'height:1.25rem' }), ...sections);
}

const STATUS = { correct: ['Correct', 'ok'], partial: ['Partly right', 'warn'], wrong: ['Wrong', 'danger'], missing: ['Missing', 'danger'], hallucinated: ['Unsupported', 'danger'] };
/** Text with coloured stretches. Each stretch also carries its status in a title, so colour is never the only signal. */
function marked(text, marks, testid) {
  const sorted = [...marks].sort((a, b) => a.start - b.start);
  const parts = [];
  let at = 0;
  for (const m of sorted) {
    if (m.start < at) continue;
    if (m.start > at) parts.push(text.slice(at, m.start));
    parts.push(h('mark', { class: `sm ${m.status}`, title: STATUS[m.status][0] }, text.slice(m.start, m.end)));
    at = m.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return h('div', { class: 'itemtext', testid }, text ? parts : h('span', { class: 'muted' }, 'No note was written.'));
}

export async function scribeResultPage(runId, go, render) {
  const d = await api.get(`/agent-ops/scribe/results/${runId}`);
  const fix = async (body) => { try { await api.post(`/agent-ops/scribe/results/${runId}/correct`, body); toast('Score updated'); } catch (err) { showError(err); } render(); };
  const verdicts = (e) => h('span', { class: 'toolbar', style: 'margin:0;gap:0.25rem' }, [['correct', 'Correct'], ['partial', 'Partly'], ['incorrect', 'Wrong']].map(([v, t]) =>
    h('button', { type: 'button', class: `small${e.corrected && { correct: 'correct', partial: 'partial', incorrect: 'wrong' }[v] === e.status ? ' on' : ''}`, 'aria-pressed': e.corrected && { correct: 'correct', partial: 'partial', incorrect: 'wrong' }[v] === e.status ? 'true' : 'false', testid: `scribe-el-${e.index}-${v}`, 'aria-label': `Mark "${e.label}" as ${t.toLowerCase()}`, onClick: () => fix({ element: e.index, verdict: v }) }, t)),
    e.corrected ? btn('Undo', { small: true, testid: `scribe-el-${e.index}-undo`, onClick: () => fix({ element: e.index, verdict: null }) }) : null);
  const elements = table({ testid: 'scribe-elements', rows: d.elements, rowId: (e) => `el-${e.index}`, columns: [
    { label: 'Section', render: (e) => e.section }, { label: 'Element', render: (e) => [e.negated ? 'No ' : '', e.label] }, { label: 'Code', cls: 'mono', render: (e) => e.code },
    { label: 'Result', render: (e) => [badge(STATUS[e.status][0], STATUS[e.status][1], `scribe-status-${e.index}`), e.corrected ? h('span', { class: 'muted small' }, ` set by a person (was: ${STATUS[e.auto][0].toLowerCase()})`) : null] },
    { label: 'Why', render: (e) => (e.corrected ? '' : e.reason) }, { label: 'Your call', cls: 'actions', render: verdicts },
  ] });
  const unsupported = d.extras.filter((x) => !x.supported || x.corrected);
  const extras = unsupported.length ? table({ testid: 'scribe-extras', rows: unsupported, rowId: (x) => x.key, columns: [
    { label: 'In the note', render: (x) => x.label }, { label: 'Kind', render: (x) => ({ term: 'Clinical term', code: 'Attached code', quantity: 'Quantity' }[x.kind]) },
    { label: 'Result', render: (x) => [badge(x.supported ? 'Supported' : 'Unsupported', x.supported ? 'ok' : 'danger'), x.corrected ? h('span', { class: 'muted small' }, ' set by a person') : null] },
    { label: 'Your call', cls: 'actions', render: (x) => btn(x.supported ? 'It is unsupported' : 'It is supported', { small: true, testid: `scribe-extra-${x.key.replace(/[^A-Za-z0-9]/g, '-')}`, onClick: () => fix({ extra: x.key, verdict: x.corrected ? null : x.supported ? 'unsupported' : 'supported' }) }) },
  ] }) : h('p', { class: 'muted', style: 'margin:0', testid: 'scribe-extras-none' }, 'Nothing in the note lacks support in the transcript or chart.');
  return page(d.title, h('div', { class: 'toolbar', style: 'margin:0' }, btn('Every step', { testid: 'scribe-trace', onClick: () => go(`#/trace/${runId}`) }), btn('All results', { testid: 'scribe-back', onClick: () => go('#/scribe') })),
    h('p', { class: 'muted', style: 'margin:-0.375rem 0 0.875rem' }, `${d.agentId} v${d.version} · ${TYPE[d.encounterType] || d.encounterType} · ${d.case.noteType.display}`, d.split === 'eval' ? ' · evaluation case' : ''),
    h('div', { class: 'tiles6' }, tile('Completeness', pct(d.completeness), 'scribe-d-completeness'), tile('Accuracy', pct(d.accuracy), 'scribe-d-accuracy'), tile('Unsupported items', d.hallucinations, 'scribe-d-hallucinations'),
      tile('Unsupported share', pct(d.hallucinationRate), 'scribe-d-rate'), tile('Format', pct(d.format.score), 'scribe-d-format'), tile('Time', `${d.ms} ms`, 'scribe-d-time')),
    h('p', { class: 'small', testid: 'scribe-legend', style: 'margin:0 0 0.5rem' }, h('mark', { class: 'sm correct' }, 'correct'), ' ', h('mark', { class: 'sm partial' }, 'partly right'), ' ', h('mark', { class: 'sm wrong' }, 'wrong, missing or unsupported'), h('span', { class: 'muted' }, '  Hover a highlight to see which.')),
    h('div', { class: 'split', style: 'margin-top:0' },
      h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Reference note'), marked(d.gold.text, d.gold.marks, 'scribe-gold')),
      h('div', { class: 'card agent' }, h('h3', { style: 'margin-top:0' }, 'Agent\'s note'), marked(d.agent.text, d.agent.marks, 'scribe-agent-note'))),
    h('div', { style: 'height:1rem' }),
    card('Sections', h('p', { style: 'margin:0', testid: 'scribe-sections' }, d.format.missing.length ? `Missing: ${d.format.missing.join(', ')}. ` : 'Every required section is present. ', d.format.ordered ? 'In the expected order.' : 'Out of the expected order.', h('span', { class: 'muted' }, ` Expected: ${d.format.required.join(', ')}.`))),
    h('div', { style: 'height:1rem' }), card('Element by element', h('p', { class: 'muted', style: 'margin:0 0 0.625rem' }, 'The automatic match is text matching. If it got one wrong, say so: the score changes at once and the change is logged.'), elements),
    h('div', { style: 'height:1rem' }), card('Content with no support', extras));
}

// ---------- Regression replay ----------
const rg = { agentId: null, against: '', open: new Set() };
const CHANGE = { same: ['Same', 'info'], improved: ['Improved', 'ok'], regressed: ['Regressed', 'danger'], changed: ['Different answer', 'warn'], new: ['First result', ''] };
export async function regressionPage(go, render) {
  const out = await api.get('/agent-ops/regression');
  if (!out.agents.some((a) => a.agentId === rg.agentId)) rg.agentId = (out.agents.find((a) => a.hasHistory) ?? out.agents[0])?.agentId ?? null;
  const agent = out.agents.find((a) => a.agentId === rg.agentId);
  if (!agent?.earlier.includes(rg.against)) rg.against = '';
  const runCard = h('div', { class: 'card launch', testid: 'regression-card' },
    h('p', { style: 'margin-top:0' }, 'Reruns the agent\'s current version on every case it has attempted and on every item an earlier version shadowed, then compares the two versions. Replays never enter a training export.'),
    h('div', { class: 'row' }, h('label', {}, 'Agent'), select('regression-agent', 'Agent', rg.agentId, out.agents.map((a) => [a.agentId, `${a.name} v${a.version}`]), (v) => { rg.agentId = v; render(); })),
    h('div', { class: 'row' }, h('label', {}, 'Compare with'), agent?.earlier.length ? select('regression-against', 'Earlier version', rg.against, [['', `The most recent earlier version (v${agent.earlier[0]})`], ...agent.earlier.map((v) => [v, `v${v}`])], (v) => { rg.against = v; })
      : h('span', { class: 'muted', testid: 'regression-no-earlier' }, agent?.hasHistory || agent?.canDoCases ? 'No earlier version has results. This replay becomes the baseline for the next version.' : 'This agent has no earlier results and nothing to replay yet.')),
    h('div', { class: 'toolbar', style: 'margin:0.875rem 0 0' }, btn('Replay  →', { kind: 'primary', testid: 'regression-run', disabled: !agent || (!agent.hasHistory && !agent.canDoCases), onClick: async () => {
      try { const r = await api.post('/agent-ops/regression/run', { agentId: rg.agentId, against: rg.against || undefined }); rg.open.add(r.runId); toast(`Replayed ${plural(r.summary.targets, 'target')}: ${r.summary.regressed} regressed`); } catch (err) { showError(err); }
      render();
    } })));
  const reports = out.reports.map((r) => {
    const open = rg.open.has(r.runId);
    const s = r.summary;
    return h('div', { class: 'card', testid: `regression-report-${r.runId}`, style: 'margin-bottom:0.75rem' },
      h('div', { class: 'toolbar', style: 'margin:0' }, h('b', {}, `${r.name} v${r.version}`), h('span', { class: 'muted' }, r.previous ? `against v${r.previous}` : 'no earlier version'), h('span', { class: 'muted small' }, fmtDateTime(r.startedAt)), h('span', { class: 'spacer' }),
        s.regressed ? badge(`${s.regressed} regressed`, 'danger', `regression-regressed-${r.runId}`) : badge('Nothing regressed', 'ok', `regression-regressed-${r.runId}`),
        btn(open ? 'Hide' : 'Show', { small: true, testid: `regression-toggle-${r.runId}`, onClick: () => { if (open) rg.open.delete(r.runId); else rg.open.add(r.runId); render(); } })),
      h('p', { class: 'muted small', style: 'margin:0.375rem 0 0', testid: `regression-summary-${r.runId}` }, `${plural(s.cases, 'case')} and ${plural(s.shadowCases, 'shadowed item')}: ${s.same} same, ${s.improved} improved, ${s.regressed} regressed, ${s.changed} different answer, ${s.new} first result. Checks broken: ${s.checksBroken}; fixed: ${s.checksFixed}.`),
      open ? h('div', { style: 'margin-top:0.625rem' }, h('p', { class: 'muted small', style: 'margin:0 0 0.5rem' }, r.note), table({ testid: `regression-rows-${r.runId}`, rows: r.rows, rowId: (x) => x.target, columns: [
        { label: 'Case or item', render: (x) => [x.kind === 'case' ? x.title : h('span', { class: 'mono' }, x.title), ' ', x.split === 'eval' ? badge('evaluation', 'warn') : null] },
        { label: r.previous ? `v${r.previous}` : 'Before', render: (x) => (x.before ? x.before.text : '—') }, { label: `v${r.version}`, render: (x) => x.after.text },
        { label: 'Change', render: (x) => badge(CHANGE[x.change][0], CHANGE[x.change][1]) },
        { label: 'Checks that moved', render: (x) => x.checks.filter((c) => c.change === 'broke' || c.change === 'fixed').map((c) => h('div', { class: 'small' }, `${c.change === 'broke' ? '✕ now fails' : '☑ now passes'}: ${c.label}`)) },
        { label: '', cls: 'actions', render: (x) => [x.before ? btn('Before', { small: true, testid: `regression-before-${x.after.runId}`, onClick: () => go(`#/trace/${x.before.runId}`) }) : null, btn('After', { small: true, testid: `regression-after-${x.after.runId}`, onClick: () => go(`#/trace/${x.after.runId}`) })] },
      ] })) : null);
  });
  return page('Regression replay', null, runCard, h('h2', { style: 'margin:1.5rem 0 0.625rem' }, 'Replays'), reports.length ? reports : h('div', { class: 'card empty', testid: 'regression-empty' }, 'No replay has been run yet.'));
}

// ---------- Leaderboard ----------
export async function leaderboardPage(go) {
  const out = await api.get('/agent-ops/leaderboard');
  const rows = out.rows.filter((r) => r.measured);
  const dist = (g) => (g.graded ? h('span', {}, `${g.mean.toFixed(2)} mean · `, Object.entries(g.distribution).map(([k, n]) => `${n} ${k.replace(/-/g, ' ')}`).join(', ')) : '—');
  return page('Leaderboard', null,
    h('p', { class: 'muted', testid: 'board-note', style: 'margin:-0.375rem 0 1.125rem;max-width:56.25rem' }, out.note, ` The evaluation split holds ${plural(out.evalCases, 'clinical case')} and ${plural(out.scribeEvalCases, 'scribe case')}; it never appears in a training export.`),
    rows.length ? table({ testid: 'board-table', rows, rowId: (r) => `${r.agentId}-${r.version}`.replace(/[^A-Za-z0-9-]/g, '-'), columns: [
      { label: '#', render: (r) => r.rank },
      { label: 'Agent version', render: (r) => [h('b', {}, `${r.name} v${r.version}`), ' ', r.current ? badge(r.stage === 'hitl' ? 'promoted' : 'current', 'accent') : badge('older', ''), r.safetyConcern ? [' ', badge('safety concern', 'danger', `board-concern-${r.agentId}`)] : null] },
      { label: 'Verifier checks (evaluation cases)', render: (r) => (r.verifier.evalCases ? `${pct(r.verifier.score)} · ${r.verifier.checksPassed} of ${r.verifier.checks} checks over ${plural(r.verifier.evalCases, 'case')}${r.verifier.avoidViolations ? ` · ${r.verifier.avoidViolations} to-avoid action${r.verifier.avoidViolations === 1 ? '' : 's'} taken` : ''}` : '—') },
      { label: 'Human grades', render: (r) => dist(r.grades) },
      { label: 'Scribe (evaluation cases)', render: (r) => (r.scribe ? `accuracy ${pct(r.scribe.accuracy)} · completeness ${pct(r.scribe.completeness)} · unsupported ${pct(r.scribe.hallucinationRate)}` : '—') },
      { label: 'Red team', render: (r) => (r.redTeam ? `${r.redTeam.passed} of ${r.redTeam.total} scenarios passed` : '—') },
    ] }) : h('div', { class: 'card empty', testid: 'board-empty' }, 'Nothing has been measured yet. Run an agent on the evaluation cases (Training data or Regression replay), the note accuracy benchmark, or the safety scenarios.'),
    out.rows.length > rows.length ? h('p', { class: 'muted small', testid: 'board-unmeasured', style: 'margin-top:0.625rem' }, `Not measured yet: ${out.rows.filter((r) => !r.measured).map((r) => `${r.name} v${r.version}`).join(', ')}.`) : null,
    h('div', { class: 'toolbar', style: 'margin-top:1rem' }, btn('Regression replay', { testid: 'board-regression', onClick: () => go('#/regression') }), btn('Note accuracy', { testid: 'board-scribe', onClick: () => go('#/scribe') }), btn('Grading', { testid: 'board-grading', onClick: () => go('#/grading') })));
}
