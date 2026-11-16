// The Agent Dashboard front page and the Time machine tab.
// Dashboard: start a study, give an agent a task, upload a task list; what is running now (studies, agents being
// called, live view of where each agent is working); what needs a person; what finished recently.
// Time machine: rewind a patient's chart to a moment in their care on a practice copy, step forward, or see what
// the system had recorded at a given time.
import { h, btn, badge, toast, formDialog, openDialog, showError, fmtDateTime } from '/shared/ui.js';
import { api, identity, fhir } from '/shared/fhir.js';
import { frame, tagsRow, empty, actionCard, studyCard, runCard, isResearcher, isStaff, getOr as get, homeStyle } from '/agent-ops/home.js';

const CSS = `
.ov-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 0 0 1.75rem; }
.ov-actions button { height: 3rem; padding: 0 1.25rem; border-radius: 999px; font-size: 1.0625rem; }
.ov-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 1rem; margin: 0 0 2rem; }
.ov-tile { height: auto !important; min-height: 6.5rem; justify-content: center; align-items: flex-start; background: var(--dash-card); border-radius: 1.25rem; padding: 1.125rem 1.25rem; display: flex; flex-direction: column; gap: 0.25rem; text-decoration: none; color: var(--dash-ink); border: 0; text-align: left; font: inherit; cursor: pointer; }
.ov-tile:hover, .ov-tile:focus-visible { box-shadow: var(--shadow); }
.ov-tile b { font-size: 2.25rem; font-weight: 600; line-height: 1.1; }
.ov-tile .ov-l { color: var(--dash-ink) !important; font-weight: 600; font-size: 1.0625rem !important; }
.ov-tile small { color: var(--dash-ink-2); font-size: 0.875rem; line-height: 1.35; }
.ov-tiles { grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr)) !important; }
.ov-tile { min-height: 9.5rem !important; justify-content: flex-end !important; white-space: normal !important; overflow: hidden; min-width: 0; max-width: 100%; line-height: 1.3; }
.ov-tile > * { display: block; max-width: 100%; white-space: normal; overflow-wrap: anywhere; text-align: left; }
.ov-tile span { color: var(--dash-ink-2); font-size: 0.9375rem; }
.ov-tile.hot { background: var(--warn-soft); } .ov-tile.live { background: var(--ok-soft); color: var(--on-ok-soft); } .ov-tile.live span { color: inherit; opacity: .85; }
.ov-sec { margin: 0 0 2.25rem; }
.ov-sec > header { display: flex; align-items: baseline; gap: 0.75rem; margin: 0 0 0.75rem; }
.ov-sec > header h2 { font-size: 1.375rem; font-weight: 600; margin: 0; }
.ov-sec > header p { margin: 0; color: var(--dash-ink-2); font-size: 0.9375rem; }
.ov-table { width: 100%; border-collapse: collapse; background: var(--dash-card); border-radius: 1rem; overflow: hidden; font-size: 0.9688rem; }
.ov-table th { text-align: left; font-weight: 600; color: var(--dash-ink-2); font-size: 0.8125rem; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.75rem 1rem; border-bottom: 1px solid var(--dash-line); }
.ov-table td { padding: 0.75rem 1rem; border-bottom: 1px solid var(--dash-line); vertical-align: middle; }
.ov-table tr:last-child td { border-bottom: 0; }
.ov-table td.act { text-align: right; white-space: nowrap; } .ov-table td.act > * + * { margin-left: 0.375rem; }
.ov-dot { display: inline-block; width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--ok, #2e9d5b); margin-right: 0.5rem; box-shadow: 0 0 0 0.1875rem var(--ok-soft); }
.ov-dot.idle { background: var(--dash-ink-2); box-shadow: none; opacity: .5; }
.ov-wrap { overflow-x: auto; border-radius: 1rem; }
.tm-grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 1.25rem; align-items: start; }
@media (max-width: 62rem) { .tm-grid { grid-template-columns: 1fr; } }
.tm-card { background: var(--dash-card); border-radius: 1.25rem; padding: 1.5rem; }
.tm-card h2 { font-size: 1.25rem; margin: 0 0 0.375rem; } .tm-card > p { color: var(--dash-ink-2); margin: 0 0 1rem; }
.tm-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin: 0 0 0.75rem; }
.tm-row input { width: auto; }
.tm-line { position: relative; margin: 1rem 0 0.5rem; padding-left: 1.25rem; border-left: 0.125rem solid var(--dash-line); }
.tm-line li { list-style: none; margin: 0 0 0.625rem; position: relative; }
.tm-line li::before { content: ''; position: absolute; left: -1.6875rem; top: 0.4375rem; width: 0.625rem; height: 0.625rem; border-radius: 50%; background: var(--dash-accent); }
.tm-line li b { display: block; } .tm-line li span { color: var(--dash-ink-2); font-size: 0.9375rem; }
`;
let styled = false;
const style = () => { homeStyle(); if (styled) return; styled = true; document.head.append(h('style', { 'data-overview': '1' }, CSS)); };
const RUNNING = ['running', 'paused', 'awaiting-decision'];
const shortId = (x) => String(x || '').slice(0, 8);
const pidOf = (ref) => (String(ref || '').startsWith('Patient/') ? String(ref).slice(8) : null);
const ago = (iso) => { if (!iso) return '—'; const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : fmtDateTime(iso); };

/** Where an agent is working right now: its patient's chart on its own copy, else its trace. */
const liveUrl = (r) => { const pid = pidOf(r.patientRef); return pid ? `/ehr/?branch=${encodeURIComponent(r.branch || 'main')}#/chart/${pid}/summary` : null; };

// ---------- Start a new study: one chooser for every kind ----------
export function startStudyChooser(go) {
  const kinds = [
    ['evaluate', 'Evaluate an agent', 'Tasks, agents and people, under shadow, human in the loop, autonomous or red-team conditions.', () => go('#/new/evaluation')],
    ['rl', 'Reinforcement learning', 'A training run over a task set: every attempt graded and exported for your trainer.', () => go('#/rl')],
    ['annotate', 'Data annotation', 'Cases, readers and labels; clinicians label in the real apps.', () => go('#/new/annotation')],
    ['surveillance', 'Surveillance and reporting', 'Monitor a deployed agent: individual and aggregate reports, subgroups and signals.', () => go('#/surveillance/studies')],
  ];
  openDialog({ title: 'Start a new study', testid: 'study-chooser', wide: true,
    body: [h('p', {}, 'What kind of study?'), h('div', { class: 'hx-grid', style: 'grid-template-columns:repeat(auto-fit,minmax(14rem,1fr))' }, kinds.map(([id, title, text, open]) => h('button', { type: 'button', class: 'hx-card', style: 'min-height:9rem', testid: `chooser-${id}`, 'aria-label': title, onClick: () => { document.querySelector('[data-testid="study-chooser"]')?.close(); document.querySelector('[data-testid="study-chooser"]')?.remove(); open(); } }, h('span', { class: 'hx-name' }, title), h('span', { class: 'hx-meta' }, text))))],
    actions: [{ label: 'Cancel', testid: 'chooser-cancel', onClick: (c) => c() }] });
}

// ---------- Give an agent a task: an existing task, or a new one written here ----------
export async function giveTaskDialog(go) {
  const [{ agents }, bank] = await Promise.all([api.get('/agent-ops/agents'), api.get('/agent-ops/cases').catch(() => ({ cases: [] }))]);
  const on = agents.filter((a) => a.enabled);
  if (!on.length) { toast('Add or switch on an agent first (Library, Agents)', { error: true }); return; }
  const cases = bank.cases || [];
  formDialog({ title: 'Give an agent a task', testid: 'give-task', submitLabel: 'Start', wide: true,
    intro: 'The agent works on its own copy of the chart; nothing reaches the live record. You can watch it live from the dashboard.',
    fields: [
      { name: 'agentId', label: 'Agent', type: 'select', required: true, options: on.map((a) => [a.id, `${a.name} v${a.version}`]) },
      { name: 'caseId', label: 'Task', type: 'select', options: [['', 'Write a new task below'], ...cases.map((c) => [c.id, `${c.title} (${c.split})`])] },
      { name: 'title', label: 'New task: title', placeholder: 'for example Start sepsis bundle' },
      { name: 'mrn', label: 'New task: patient number (MRN)', placeholder: 'N000000' },
      { name: 'task', label: 'New task: what the agent should do', type: 'textarea', rows: 3, wide: true },
      { name: 'check', label: 'New task: the order, prescription or diagnosis that counts as done', placeholder: 'LOINC:2524-7 or RxNorm:1191 or ICD-10:A41.9' },
      { name: 'attempts', label: 'Attempts', type: 'number', value: '1', min: 1, max: 50 },
    ],
    onSubmit: async (v) => {
      let caseId = v.caseId;
      if (!caseId) caseId = (await createCaseFrom({ title: v.title, mrn: v.mrn, task: v.task, check: v.check, split: 'validation' })).id;
      const out = await api.post('/agent-ops/rollouts', { agentId: v.agentId, caseId, attempts: Number(v.attempts) || 1 });
      toast(`Started: ${(out.attempts || out.ids || []).length || Number(v.attempts) || 1} attempt(s). Watch it under Live now.`); go('#/');
    } });
}
const ACTION_OF = { loinc: 'order', rxnorm: 'prescribe', 'icd-10': 'diagnose', icd10: 'diagnose', snomed: 'diagnose', cpt: 'order' };
async function createCaseFrom({ title, mrn, patient, task, check, split = 'validation', tags = [] }) {
  if (!String(title || '').trim() || !String(task || '').trim()) throw new Error('A new task needs a title and what to do');
  let ref = patient && /^Patient\//.test(patient) ? patient : null;
  if (!ref) { const m = String(mrn || patient || '').trim().toUpperCase(); if (!m) throw new Error('Give the patient number (MRN)'); const found = await fhir.search('Patient', { identifier: m }); if (!found.length) throw new Error(`No patient with number ${m}`); ref = `Patient/${found[0].id}`; }
  const checks = String(check || '').split(/[;|]/).map((x) => x.trim()).filter(Boolean);
  if (!checks.length) throw new Error('Give at least one check, for example LOINC:2524-7');
  const goldActions = checks.map((c) => ({ type: ACTION_OF[c.split(':')[0].toLowerCase()] || 'order', code: c }));
  return api.post('/agent-ops/cases', { title: title.trim(), patient: ref, split, task: task.trim(), goldActions, tags });
}

// ---------- Upload a task list: CSV or JSON, made into tasks and one task set ----------
const parseCsv = (text) => {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i += 1) { const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i += 1; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c; }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((x) => x.trim())); if (!head) return [];
  const keys = head.map((k) => k.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
};
export function uploadTasksDialog(go) {
  const file = h('input', { type: 'file', accept: '.csv,.json,application/json,text/csv', testid: 'upload-file', 'aria-label': 'Task list file' });
  const name = h('input', { type: 'text', testid: 'upload-set-name', 'aria-label': 'Task set name', placeholder: 'Task set name (optional)' });
  const note = h('p', { class: 'muted small', testid: 'upload-result', role: 'status' });
  openDialog({ title: 'Upload a task list', testid: 'upload-tasks', wide: true,
    body: [h('p', {}, 'A CSV with the columns title, mrn, task, check and split (train, validation or eval), or a JSON list of the same fields. "check" is the order, prescription or diagnosis that counts as done, for example LOINC:2524-7; separate several with ";".'),
      h('pre', { class: 'mono small', style: 'background:var(--dash-head);padding:0.75rem;border-radius:0.75rem;white-space:pre-wrap' }, 'title,mrn,task,check,split\nStart sepsis bundle,N000123,Order a lactate and blood cultures,LOINC:2524-7;LOINC:600-7,validation'),
      h('label', { class: 'field' }, h('span', {}, 'File'), file), h('label', { class: 'field' }, h('span', {}, 'Make a task set from them'), name), note],
    actions: [{ label: 'Cancel', testid: 'upload-cancel', onClick: (c) => c() }, { label: 'Upload', kind: 'primary', testid: 'upload-go', onClick: async (close) => {
      const f = file.files?.[0]; if (!f) { note.textContent = 'Choose a file first'; return; }
      let rows; try { const text = await f.text(); rows = /\.json$/i.test(f.name) || text.trim().startsWith('[') ? JSON.parse(text) : parseCsv(text); } catch (err) { note.textContent = `Could not read the file: ${err.message}`; return; }
      if (!Array.isArray(rows) || !rows.length) { note.textContent = 'No tasks found in the file'; return; }
      const made = []; const problems = [];
      for (const [i, r] of rows.entries()) { note.textContent = `Adding task ${i + 1} of ${rows.length}…`; try { made.push((await createCaseFrom({ title: r.title, mrn: r.mrn, patient: r.patient, task: r.task || r.instruction, check: r.check || r.checks, split: ['train', 'validation', 'eval'].includes(r.split) ? r.split : 'validation' })).id); } catch (err) { problems.push(`Row ${i + 1}: ${err.message}`); } }
      let setMsg = '';
      if (made.length && name.value.trim()) { try { const s = await api.post('/agent-ops/task-sets', { name: name.value.trim(), tasks: made.map((taskId) => ({ taskId, part: 'test' })) }); setMsg = ` Task set "${s.name}" made.`; } catch (err) { problems.push(`Task set: ${err.message}`); } }
      note.textContent = `${made.length} of ${rows.length} tasks added.${setMsg}${problems.length ? ` ${problems.slice(0, 5).join(' · ')}${problems.length > 5 ? ' …' : ''}` : ''}`;
      if (made.length && !problems.length) { toast(`${made.length} tasks added.${setMsg}`); close(); go('#/library/tasks'); }
    } }] });
}

// ---------- Dashboard ----------
export async function dashboardTab({ go, render }) {
  style();
  const wk = await get('/agent-ops/my-work', null);
  const waiting = wk ? wk.todo.length : 0;
  if (!isStaff()) {
    return frame('dashboard', 'My work', h('div', { class: 'ov-tiles' }, h('a', { class: `ov-tile${waiting ? ' hot' : ''}`, href: '#/my-work', testid: 'card-my-work', 'aria-label': `My work, ${waiting} waiting` }, h('b', { testid: 'my-work-count' }, String(waiting)), h('span', {}, waiting ? `task${waiting === 1 ? '' : 's'} waiting. Next: ${wk.next.task}` : 'Nothing is waiting for you.'))));
  }
  const [studies, truns, runs, agents, grades, adj, surv] = await Promise.all([get('/agent-ops/studies', { studies: [] }), get('/agent-ops/training-runs', { runs: [] }), get('/agent-ops/runs', { runs: [] }), get('/agent-ops/agents', { agents: [] }), get('/agent-ops/attempt-grades', { queue: [] }), get('/agent-ops/adjudications', { queue: [] }), get('/agent-ops/surveillance/signals', null)]);
  const live = runs.runs.filter((r) => RUNNING.includes(r.status) && r.agentId).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const inProgress = studies.studies.filter((s) => s.status === 'started'); const trainingNow = truns.runs.filter((r) => r.status === 'running');
  const done = studies.studies.filter((s) => ['finished', 'stopped'].includes(s.status)).slice(0, 6);
  const agentById = new Map(agents.agents.map((a) => [a.id, a]));
  const lastRunOf = new Map(); for (const r of runs.runs) if (r.agentId && (!lastRunOf.has(r.agentId) || String(r.startedAt) > String(lastRunOf.get(r.agentId).startedAt))) lastRunOf.set(r.agentId, r);
  const liveBy = new Map(); for (const r of live) liveBy.set(r.agentId, (liveBy.get(r.agentId) || 0) + 1);
  const deployed = agents.agents.filter((a) => a.enabled).sort((a, b) => (liveBy.get(b.id) || 0) - (liveBy.get(a.id) || 0) || String(lastRunOf.get(b.id)?.startedAt || '').localeCompare(String(lastRunOf.get(a.id)?.startedAt || '')));
  const signals = surv ? surv.signals.filter((x) => !x.review && !x.reviewedAt && x.status !== 'reviewed').length : 0;
  const attention = grades.queue.length + adj.queue.length + signals;
  const tile = (n, label, testid, onClick, cls = '') => h('button', { type: 'button', class: `ov-tile ${cls}`, testid, 'aria-label': `${n} ${label}`, onClick }, h('b', {}, String(n)), h('span', {}, label));
  const scrollTo = (id) => () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const sec = (id, title, sub, body) => h('section', { class: 'ov-sec', id, testid: id }, h('header', {}, h('h2', {}, title), sub ? h('p', {}, sub) : null), body);
  const modelOf = (a) => a?.model || a?.provider || a?.record?.provider || (a?.builtIn ? 'Built in' : a?.endpoint ? 'External endpoint' : '—');
  const stop = async (r) => { try { await api.post(`/agent-ops/runs/${r.id}/cancel`, {}); toast('Stopped'); render(); } catch (err) { showError(err); } };
  const pause = async (r) => { try { await api.post(`/agent-ops/runs/${r.id}/${r.status === 'paused' ? 'resume' : 'pause'}`, {}); render(); } catch (err) { showError(err); } };

  const liveTable = live.length ? h('div', { class: 'ov-wrap' }, h('table', { class: 'ov-table', testid: 'live-table' }, h('thead', {}, h('tr', {}, ['Agent', 'Doing', 'On', 'Started', ''].map((c) => h('th', {}, c)))),
    h('tbody', {}, live.map((r) => { const a = agentById.get(r.agentId); const url = liveUrl(r); return h('tr', { testid: `live-${r.id}` },
      h('td', {}, h('span', { class: 'ov-dot' + (r.status === 'paused' ? ' idle' : '') }), h('b', {}, a?.name || r.agentId), ` v${r.version || a?.version || ''}`),
      h('td', {}, r.goal || r.mode, r.status !== 'running' ? [' ', badge(r.status === 'paused' ? 'Paused' : 'Waiting for a person', 'warn')] : null),
      h('td', { class: 'mono small' }, r.branch === 'main' ? 'live chart' : `copy ${shortId(r.branch)}`), h('td', {}, ago(r.startedAt)),
      h('td', { class: 'act' }, url ? h('a', { class: 'btn small primary', href: url, target: '_blank', rel: 'noopener', testid: `live-watch-${r.id}`, 'aria-label': 'Watch live: open the page the agent is working on' }, 'Watch live') : null,
        btn('Trace', { small: true, testid: `live-trace-${r.id}`, onClick: () => go(`#/trace/${r.id}`) }),
        isResearcher() ? [btn(r.status === 'paused' ? 'Resume' : 'Pause', { small: true, testid: `live-pause-${r.id}`, onClick: () => pause(r) }), btn('Stop', { small: true, kind: 'danger', testid: `live-stop-${r.id}`, onClick: () => stop(r) })] : null)); })))) : empty('No agent is working right now. Give an agent a task, or start a study.', 'live-empty');

  const agentTable = deployed.length ? h('div', { class: 'ov-wrap' }, h('table', { class: 'ov-table', testid: 'agents-table' }, h('thead', {}, h('tr', {}, ['Agent', 'Model', 'Stage', 'Working now', 'Last called', ''].map((c) => h('th', {}, c)))),
    h('tbody', {}, deployed.map((a) => h('tr', { testid: `agent-row-${a.id}` }, h('td', {}, h('span', { class: `ov-dot${liveBy.get(a.id) ? '' : ' idle'}` }), h('b', {}, a.name), ` v${a.version}`), h('td', {}, modelOf(a)), h('td', {}, a.stage === 'live' || a.promotedVersion ? badge('Deployed', 'ok') : badge(a.stage === 'shadow' ? 'Shadow' : (a.stage || 'Shadow'), 'info')),
      h('td', {}, liveBy.get(a.id) ? `${liveBy.get(a.id)} task${liveBy.get(a.id) === 1 ? '' : 's'}` : '—'), h('td', {}, ago(lastRunOf.get(a.id)?.startedAt)), h('td', { class: 'act' }, btn('Report card', { small: true, testid: `agent-report-${a.id}`, onClick: () => go(`#/report/${a.id}`) }))))))) : empty('No agents switched on. Add one in the Library.', 'agents-empty');

  const needs = attention ? h('div', { class: 'ov-tiles', testid: 'needs-attention' }, grades.queue.length ? tile(grades.queue.length, 'attempts waiting for your grade', 'card-to-grade', () => go('#/grade'), 'hot') : null, adj.queue.length ? tile(adj.queue.length, 'cases waiting for adjudication', 'card-to-adjudicate', () => go('#/adjudicate-cases'), 'hot') : null, signals ? tile(signals, 'open surveillance signals', 'card-signals', () => go('#/surveillance/signals'), 'hot') : null) : null;

  const humans = new Set(inProgress.flatMap((x) => (x.participants || []).filter((pp) => pp.kind === 'person').map((pp) => pp.id))).size;
  const working = new Set(live.map((r) => r.agentId)).size;
  const tile2 = (n, label, detail, testid, onClick, cls = '') => h('button', { type: 'button', class: `ov-tile ${cls}`, testid, 'aria-label': `${n} ${label}`, onClick }, h('b', {}, String(n)), h('span', { class: 'ov-l' }, label), detail ? h('small', {}, detail) : null);
  const liveDialog = () => openDialog({ title: 'See an agent in action', testid: 'live-dialog', wide: true, body: [h('p', {}, 'Every agent working at this moment. Watch live opens the page it is working on, on its own copy of the chart.'), liveTable], actions: [{ label: 'Close', testid: 'live-close', onClick: (c) => c() }] });
  return frame('dashboard', 'Agent Dashboard',
    isResearcher() ? h('div', { class: 'ov-actions', testid: 'dashboard-actions' },
      btn('+  Start a new study', { kind: 'primary', testid: 'dash-start-study', onClick: () => startStudyChooser(go) }),
      btn('Give an agent a task', { testid: 'dash-give-task', onClick: () => giveTaskDialog(go).catch(showError) }),
      btn('Upload a task list', { testid: 'dash-upload-tasks', onClick: () => uploadTasksDialog(go) })) : null,
    h('div', { class: 'ov-tiles', testid: 'dashboard-cards' },
      tile2(waiting, 'My work', waiting ? `Next: ${wk.next.task}` : 'Nothing is waiting for you', 'dash-my-work', () => go('#/my-work'), waiting ? 'hot' : ''),
      tile2(working, 'See an agent in action', working ? `${live.length} task${live.length === 1 ? '' : 's'} running now` : 'No agent is working right now', 'tile-live', liveDialog, working ? 'live' : ''),
      tile2(inProgress.length + trainingNow.length, 'Studies in progress', null, 'tile-studies', scrollTo('studies-in-progress')),
      tile2(deployed.length, 'Agents deployed', 'switched on and callable', 'tile-agents', scrollTo('agents-deployed')),
      tile2(humans, 'Humans deployed', 'people taking part in running studies', 'tile-humans', () => go('#/people')),
      tile2(attention, 'Waiting for human review', attention ? [grades.queue.length ? `${grades.queue.length} to grade` : null, adj.queue.length ? `${adj.queue.length} to adjudicate` : null, signals ? `${signals} signals` : null].filter(Boolean).join(' · ') : 'Agent attempts to grade, disagreements to settle, surveillance signals', 'tile-attention', () => (attention ? scrollTo('needs-attention-sec')() : null), attention ? 'hot' : '')),
    sec('studies-in-progress', 'Studies in progress', null, inProgress.length || trainingNow.length ? h('div', { class: 'hx-grid', testid: 'dashboard-recent' }, inProgress.map((x) => studyCard(x, go)), trainingNow.map((r) => runCard(r, go))) : empty('No study is running. Start one above.', 'dashboard-empty')),
    sec('agents-deployed', 'Agents deployed', 'Which models are switched on and which are being called now.', agentTable),
    attention ? sec('needs-attention-sec', 'Waiting for human review', null, needs) : null,
    sec('recently-completed', 'Recently completed', null, done.length ? h('div', { class: 'hx-grid', testid: 'dashboard-done' }, done.map((x) => studyCard(x, go))) : empty('Nothing finished yet.', 'done-empty')));
}

// ---------- Time machine ----------
const TM_KEY = 'hd.timemachine';
const tmSaved = () => { try { return JSON.parse(localStorage.getItem(TM_KEY) || '{}'); } catch { return {}; } };
const tmSave = (id, v) => { try { const all = tmSaved(); if (v) all[id] = v; else delete all[id]; localStorage.setItem(TM_KEY, JSON.stringify(all)); } catch { /* no storage */ } };
const local = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${String(d.getUTCFullYear()).padStart(4, '0')}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`; };
const shiftIso = (iso, years) => { const d = new Date(iso); d.setUTCFullYear(d.getUTCFullYear() - years); return d.toISOString(); };
const showDay = (iso, shift) => { const d = new Date(shiftIso(iso, shift)); return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`; };
let tmState = { mrn: '', patient: null, shift: 0, encounters: [] };

export async function timeMachineTab({ go, render }) {
  style();
  const { branches } = await get('/agent-ops/branches', { branches: [] });
  const saved = tmSaved();
  const copies = branches.filter((b) => b.careCap && !b.droppedAt && saved[b.id]).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const openCopy = (id, pid) => window.open(`/ehr/?branch=${encodeURIComponent(id)}#/chart/${pid}/summary`, '_blank', 'noopener');
  const rewind = async (careAtStored, label) => {
    const p = tmState.patient; if (!p) return;
    try { const b = await api.post('/agent-ops/branches', { parentBranch: 'main', kind: 'sandbox', careAt: careAtStored });
      tmSave(b.id, { pid: p.id, mrn: tmState.mrn, shift: tmState.shift, label }); toast(`Chart rewound to ${label}`); openCopy(b.id, p.id); render();
    } catch (err) { showError(err); }
  };
  const find = async (mrn) => {
    const m = String(mrn || '').trim().toUpperCase(); if (!m) return;
    const found = await fhir.search('Patient', { identifier: m }); if (!found.length) { toast(`No patient with number ${m}`, { error: true }); return; }
    const p = found[0]; const ages = await api.get('/api/ages', { ids: p.id }).catch(() => ({ ages: {} })); const info = ages.ages?.[p.id];
    const shift = info && ['latest-encounter', 'anchor-year'].includes(info.basis) ? Math.max(0, Number(String(info.reference).slice(0, 4)) - new Date().getUTCFullYear()) : 0;
    const encounters = (await fhir.search('Encounter', { patient: p.id })).filter((e) => e.period?.start).sort((a, b) => a.period.start.localeCompare(b.period.start));
    tmState = { mrn: m, patient: p, shift, encounters }; render();
  };
  const mrnInput = h('input', { type: 'text', value: tmState.mrn, placeholder: 'Patient number (MRN)', testid: 'tm-mrn', 'aria-label': 'Patient number', onKeydown: (e) => { if (e.key === 'Enter') find(e.target.value).catch(showError); } });
  const p = tmState.patient; const sh = tmState.shift;
  const when = h('input', { type: 'datetime-local', testid: 'tm-when', 'aria-label': 'Moment in care', value: tmState.encounters.length ? local(shiftIso(tmState.encounters.at(-1).period.start, sh)) : '' });
  const encLabel = (e) => e.type?.[0]?.text || e.class?.display || e.class?.code || 'Encounter';
  const patientCard = h('div', { class: 'tm-card', testid: 'tm-rewind' }, h('h2', {}, 'Rewind a patient\'s chart'),
    h('p', {}, 'Open the chart as it stood at any moment in the patient\'s care. It opens on a practice copy: you, or an agent, can work from that moment. Nothing reaches the live chart.'),
    h('div', { class: 'tm-row' }, mrnInput, btn('Find', { testid: 'tm-find', onClick: () => find(mrnInput.value).catch(showError) })),
    p ? [h('p', { class: 'hx-meta', testid: 'tm-patient' }, `Patient ${tmState.mrn} · ${tmState.encounters.length} encounter${tmState.encounters.length === 1 ? '' : 's'}`),
      h('div', { class: 'tm-row' }, h('span', {}, 'Moment:'), when, btn('Rewind to this moment', { kind: 'primary', testid: 'tm-go', onClick: () => { if (!when.value) { toast('Pick a moment', { error: true }); return; } const shown = new Date(`${when.value}:00Z`).toISOString(); rewind(shiftIso(shown, -sh), showDay(shiftIso(shown, -sh), sh)); } })),
      tmState.encounters.length ? h('ul', { class: 'tm-line', testid: 'tm-timeline' }, tmState.encounters.slice(-12).map((e) => h('li', {}, h('b', {}, `${encLabel(e)} · ${showDay(e.period.start, sh)}`), h('span', {}, e.period.end ? `to ${showDay(e.period.end, sh)} · ` : 'ongoing · '),
        btn('Rewind to the start', { small: true, testid: `tm-enc-start-${e.id}`, onClick: () => rewind(e.period.start, `the start of ${encLabel(e).toLowerCase()} on ${showDay(e.period.start, sh)}`) }), ' ',
        e.period.end ? btn('Rewind to the end', { small: true, testid: `tm-enc-end-${e.id}`, onClick: () => rewind(e.period.end, `the end of ${encLabel(e).toLowerCase()} on ${showDay(e.period.end, sh)}`) }) : null))) : h('p', { class: 'hx-meta' }, 'No encounters recorded: pick any moment above.')] : null);
  const step = async (b, hours) => { const s = saved[b.id]; const at = new Date(new Date(b.careCap).getTime() + hours * 3600e3).toISOString(); try { const nb = await api.post('/agent-ops/branches', { parentBranch: 'main', kind: 'sandbox', careAt: at }); tmSave(nb.id, { ...s, label: showDay(at, s.shift || 0) }); toast(`Moved ${hours > 0 ? 'forward' : 'back'} to ${showDay(at, s.shift || 0)}`); openCopy(nb.id, s.pid); render(); } catch (err) { showError(err); } };
  const discard = async (b) => { try { await api.del(`/agent-ops/branches/${b.id}`); tmSave(b.id, null); render(); } catch (err) { showError(err); } };
  const copiesCard = h('div', { class: 'tm-card', testid: 'tm-copies' }, h('h2', {}, 'Your rewound charts'),
    copies.length ? h('div', { class: 'ov-wrap' }, h('table', { class: 'ov-table' }, h('thead', {}, h('tr', {}, ['Patient', 'Moment', ''].map((c) => h('th', {}, c)))), h('tbody', {}, copies.map((b) => { const s = saved[b.id]; return h('tr', { testid: `tm-copy-${b.id}` }, h('td', {}, s.mrn), h('td', {}, s.label || showDay(b.careCap, s.shift || 0)),
      h('td', { class: 'act' }, btn('Open', { small: true, kind: 'primary', testid: `tm-open-${b.id}`, onClick: () => openCopy(b.id, s.pid) }), btn('−1 day', { small: true, testid: `tm-back-${b.id}`, title: 'A new copy one day earlier', onClick: () => step(b, -24) }), btn('+1 day', { small: true, testid: `tm-fwd-${b.id}`, title: 'A new copy one day later', onClick: () => step(b, 24) }), btn('Discard', { small: true, kind: 'danger', testid: `tm-drop-${b.id}`, onClick: () => discard(b) }))); })))) : empty('None yet. Rewind a chart to make one.', 'tm-copies-empty'));
  const knew = h('input', { type: 'datetime-local', testid: 'tm-knew-when', 'aria-label': 'Recorded as of' });
  const knewCard = h('div', { class: 'tm-card', testid: 'tm-knew' }, h('h2', {}, 'What the system had recorded'),
    h('p', {}, 'For an audit: every app shows exactly what had been written by a moment in real time, read-only. Imported data appears from the day it was imported.'),
    h('div', { class: 'tm-row' }, knew, btn('Open the EHR as of then', { testid: 'tm-knew-go', onClick: () => { if (!knew.value) { toast('Pick a moment', { error: true }); return; } window.open(`/ehr/?asOf=${encodeURIComponent(new Date(knew.value).toISOString())}${p ? `#/chart/${p.id}/summary` : ''}`, '_blank', 'noopener'); } })));
  return frame('time-machine', 'Time machine', h('div', { class: 'tm-grid' }, h('div', {}, patientCard), h('div', { style: 'display:grid;gap:1.25rem' }, copiesCard, knewCard)));
}
