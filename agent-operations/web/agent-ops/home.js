// The Agent Dashboard's front (docs/STUDY-DESIGN.md 9): a row of pill tabs and, under it, large rounded cards.
// Each tab starts with one coloured card for its main action; the other cards are the studies, runs or
// projects that exist, each with small type tags and a progress bar. Modes are chosen inside the set-up.
import { h, btn, badge, toast, formDialog, openDialog, showError, fmtDateTime, decodeText } from '/shared/ui.js';
import { api, identity, fhir } from '/shared/fhir.js';
import { MODES, TAB_LABEL } from '/agent-ops/dash.js';

export const TABS = [['dashboard', 'Dashboard', '#/'], ['evaluate', 'Evaluate an agent', '#/evaluate'], ['rl', 'Reinforcement learning', '#/rl'], ['annotate', 'Data annotation', '#/annotate'], ['surveillance', 'Surveillance and reporting', '#/surveillance'], ['time-machine', 'Time machine', '#/time-machine'], ['library', 'Library', '#/library']];
const isResearcher = () => identity.role === 'researcher';
const isStaff = () => ['researcher', 'physician', 'nurse'].includes(identity.role);

const CSS = `
.hx { --hx-radius: 1.75rem; }
.hx h1.hx-title { font-size: 2rem; line-height: 1.15; font-weight: 600; letter-spacing: -0.015em; margin: 1.5rem 0 1.25rem; color: var(--dash-ink); }
.hx-pills { position: sticky; top: 0; z-index: 20; display: flex; flex-wrap: nowrap; overflow-x: auto; gap: 0.25rem; padding: 0.375rem; border-radius: 999px; background: var(--dash-head); margin: 0; max-width: 100%; box-shadow: 0 0.25rem 1rem rgba(0,0,0,.08); scrollbar-width: none; }
.hx-pills a { flex: 1 0 auto; text-align: center; font-weight: 500; padding: 0.625rem 0.875rem; font-size: 1rem !important; border-radius: 999px; color: var(--dash-ink-2); text-decoration: none; font-size: 1.0625rem; white-space: nowrap; }
.hx-pills a:hover { color: var(--dash-ink); }
.hx-pills a[aria-current="page"] { background: var(--dash-ink); color: var(--dash-card); font-weight: 600; }
.hx-pills a:focus-visible { outline: 0.1875rem solid var(--dash-accent); outline-offset: 0.125rem; }
.hx-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(19rem, 1fr)); gap: 1.25rem; }
.hx-card { background: var(--dash-card); border-radius: var(--hx-radius); padding: 1.75rem; min-height: 15rem; display: flex; flex-direction: column; gap: 0.5rem; color: var(--dash-ink); text-decoration: none; text-align: left; border: 0; font: inherit; cursor: pointer; white-space: normal; height: auto; overflow: hidden; align-items: stretch; transition: transform .12s ease-out, box-shadow .12s ease-out; }
.hx-card:hover, .hx-card:focus-visible { transform: translateY(-0.125rem); box-shadow: var(--shadow); }
.hx-card:focus-visible { outline: 0.1875rem solid var(--dash-accent); outline-offset: 0.125rem; }
.hx-card.plain { cursor: default; } .hx-card.plain:hover { transform: none; box-shadow: none; }
.hx-tags { display: flex; flex-wrap: wrap; gap: 0.375rem; }
.hx-tag { font-size: 0.8125rem; font-weight: 600; color: var(--dash-accent-ink, var(--dash-accent)); background: var(--accent-soft); border-radius: 999px; padding: 0.125rem 0.625rem; }
:root[data-theme="dark"] .hx-tag { color: var(--on-accent-soft); }
.hx-card .hx-name { font-size: 1.375rem; font-weight: 600; line-height: 1.25; margin-top: 0.25rem; }
.hx-card .hx-meta { color: var(--dash-ink-2); font-size: 1rem; line-height: 1.45; }
.hx-card .hx-foot { margin-top: auto; display: flex; flex-direction: column; gap: 0.375rem; }
.hx-bar { height: 0.5rem; border-radius: 999px; background: var(--dash-head); overflow: hidden; }
.hx-bar > i { display: block; height: 100%; border-radius: 999px; background: var(--dash-accent); }
.hx-bar.running > i { background: repeating-linear-gradient(90deg, var(--dash-accent) 0 0.75rem, var(--accent-soft) 0.75rem 1.5rem); }
.hx-card.action { background: var(--dash-accent); color: #fff; justify-content: flex-end; min-height: 15rem; grid-column: span 1; }
.hx-card.action .hx-name { font-size: 1.875rem; } .hx-card.action .hx-meta { color: rgba(255,255,255,.88); }
.hx-card.action .hx-plus { margin-bottom: auto; flex: none; width: 3.25rem; height: 3.25rem; border-radius: 999px; background: rgba(255,255,255,.2); display: flex; align-items: center; justify-content: center; font-size: 2rem; line-height: 1; }
.hx-card.count { min-height: 10.5rem; }
.hx-card.status { background: var(--ok-soft); color: var(--on-ok-soft); }
.hx-count { font-size: 2.75rem; font-weight: 600; line-height: 1; }
.hx-counts { display: flex; gap: 2rem; flex-wrap: wrap; margin-top: auto; } .hx-counts div { display: flex; flex-direction: column; gap: 0.25rem; } .hx-counts span { font-size: 0.9375rem; }
.hx-empty { color: var(--dash-ink-2); font-size: 1.0625rem; margin: 1.5rem 0.25rem; }
.hx h2.hx-sub { font-size: 1.5rem; font-weight: 600; margin: 2.5rem 0 1rem; }
.hx-links { display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem; margin-top: 2rem; font-size: 1rem; } .hx-links a { color: var(--dash-accent); }
.hx-layout { display: grid; grid-template-columns: minmax(0, 1fr) 16.25rem; gap: 2rem; align-items: start; } .hx-main { min-width: 0; }
.hx-side { position: sticky; top: 1rem; background: var(--dash-card, var(--surface)); border-radius: 1.25rem; padding: 1rem 1.125rem 1.125rem; box-shadow: 0 0.0625rem 0.125rem rgba(0,0,0,.06); }
.hx-side h2 { font-size: 0.875rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dash-ink-2); margin: 0 0 0.625rem; }
.hx-side .hx-links { flex-direction: column; flex-wrap: nowrap; gap: 0.125rem; margin: 0; } .hx-side .hx-links + .hx-links { margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--line); }
.hx-side .hx-links a { display: block; padding: 0.4375rem 0.625rem; border-radius: 0.625rem; line-height: 1.3; text-decoration: none; } .hx-side .hx-links a:hover, .hx-side .hx-links a:focus-visible { background: var(--accent-soft); }
@media (max-width: 62rem) { .hx-layout { grid-template-columns: 1fr; } .hx-side { position: static; } }
.hx-steps { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 0 0 1.5rem; padding: 0; list-style: none; }
.hx-steps li { padding: 0.375rem 0.875rem; border-radius: 999px; background: var(--dash-head); color: var(--dash-ink-2); font-size: 0.9375rem; }
.hx-steps li[aria-current="step"] { background: var(--dash-ink); color: var(--dash-card); font-weight: 600; }
.hx-panel { background: var(--dash-card); border-radius: var(--hx-radius); padding: 2rem; max-width: 52rem; }
.hx-panel h2 { margin: 0 0 0.375rem; font-size: 1.5rem; } .hx-panel > p { color: var(--dash-ink-2); margin: 0 0 1.25rem; }
.hx-panel label.row { display: flex; align-items: flex-start; gap: 0.625rem; padding: 0.625rem 0; border-top: 1px solid var(--dash-line); font-size: 1.0625rem; } .hx-panel label.row:first-of-type { border-top: 0; }
.hx-panel label.row input { margin-top: 0.3125rem; width: 1.125rem; height: 1.125rem; flex: none; } .hx-panel label.row small { display: block; color: var(--dash-ink-2); }
.hx-panel .fieldrow { display: flex; flex-direction: column; gap: 0.375rem; margin: 0 0 1rem; } .hx-panel .fieldrow > span { font-weight: 600; }
.hx-panel input[type="text"], .hx-panel input[type="number"], .hx-panel select, .hx-panel textarea { max-width: 32rem; }
.hx-nav { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
.hx-review { display: grid; grid-template-columns: 12rem 1fr; gap: 0.5rem 1rem; margin: 0; } .hx-review dt { color: var(--dash-ink-2); } .hx-review dd { margin: 0; }
.hx-head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem 1rem; margin: 0 0 1.25rem; } .hx-head .grow { flex: 1; }
.hx-gridwrap { background: var(--dash-card); border-radius: var(--hx-radius); padding: 1.25rem; overflow-x: auto; }
table.hx-matrix { border-collapse: separate; border-spacing: 0.375rem; font-size: 1rem; }
table.hx-matrix th { font-weight: 600; text-align: left; padding: 0.25rem 0.5rem; color: var(--dash-ink-2); white-space: nowrap; max-width: 12rem; overflow: hidden; text-overflow: ellipsis; }
table.hx-matrix th[scope="row"] { color: var(--dash-ink); position: sticky; left: 0; background: var(--dash-card); }
table.hx-matrix td { padding: 0; }
.hx-cell { width: 100%; min-width: 4.5rem; height: 2.75rem; border-radius: 0.75rem; border: 0; font: inherit; font-weight: 600; cursor: pointer; background: var(--dash-head); color: var(--dash-ink-2); }
.hx-cell:focus-visible { outline: 0.1875rem solid var(--dash-accent); outline-offset: 0.125rem; }
.hx-cell.pass { background: var(--ok-soft); color: var(--on-ok-soft); } .hx-cell.fail { background: var(--warn-soft); color: var(--warn); } .hx-cell.unsafe { background: var(--danger-soft); color: var(--danger-text); }
.hx-cell.open { background: var(--accent-soft); color: var(--on-accent-soft); } .hx-cell.done { background: var(--dash-head); color: var(--dash-ink); } .hx-cell.none { background: transparent; cursor: default; }
.hx-legend { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; margin: 1rem 0 0; font-size: 0.9375rem; color: var(--dash-ink-2); } .hx-legend span { display: inline-flex; align-items: center; gap: 0.375rem; } .hx-legend i { width: 1rem; height: 1rem; border-radius: 0.3125rem; display: inline-block; }
@media (max-width: 40rem) { .hx h1.hx-title { font-size: 2.125rem; } .hx-review { grid-template-columns: 1fr; } }

.hx-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem 1rem; margin: 0 0 1.75rem; }
.hx-actions button { height: 3rem; padding: 0 1.25rem; border-radius: 999px; font-size: 1.0625rem; }
.hx-actions .hx-meta { color: var(--dash-ink-2); max-width: 40rem; }
.hx-more { margin-top: 2.5rem; }
.hx-more .hx-links { display: flex; flex-wrap: wrap; gap: 0.25rem; padding: 0.375rem; border-radius: 1.5rem; background: var(--dash-head); margin: 0; }
.hx-more .hx-links a { padding: 0.625rem 1rem; border-radius: 999px; color: var(--dash-ink-2); text-decoration: none; font-weight: 500; font-size: 1rem; white-space: nowrap; }
.hx-more .hx-links a:hover, .hx-more .hx-links a:focus-visible { background: var(--dash-ink); color: var(--dash-card); }
.hx-subpills { position: static; margin: 0 0 1.5rem; box-shadow: none; flex-wrap: wrap; border-radius: 1.5rem; overflow: visible; }
.hx-subpills a { flex: 0 0 auto !important; }
.hx-subpills a { font-size: 0.9375rem !important; padding: 0.5rem 0.75rem; }
`;
let styled = false;
function style() { if (styled) return; styled = true; const s = document.createElement('style'); s.dataset.home = '1'; s.textContent = CSS; document.head.append(s); }

/** The pill tab bar. A patient sees only the Dashboard tab (My work). */
export function pillTabs(active) {
  style();
  const tabs = isStaff() ? TABS : TABS.slice(0, 1);
  return h('nav', { class: 'hx-pills', testid: 'pill-tabs', 'aria-label': 'Agent Dashboard sections' }, tabs.map(([id, label, href]) => h('a', { href, testid: `tab-${id}`, 'aria-label': label, 'aria-current': id === active ? 'page' : undefined }, label)));
}
// The small link lists of a page sit in a panel beside it (below it on a narrow screen), not along the bottom.
const frame = (active, title, ...content) => {
  const flat = content.flat(Infinity).filter((n) => n != null && n !== false);
  const isLinks = (n) => n instanceof Element && n.classList.contains('hx-links');
  const links = flat.filter(isLinks); const main = flat.filter((n) => !isLinks(n));
  const more = links.length ? h('section', { class: 'hx-more', testid: 'side-panel', 'aria-label': 'More in this section' }, h('h2', { class: 'hx-sub' }, 'More'), ...links) : null;
  return h('div', { class: 'hx', testid: `tabpage-${active}` }, pillTabs(active), h('h1', { class: 'hx-title' }, title), ...main, more);
};
/** The one way every section starts something: the same button row as the Dashboard. */
const startRow = ({ testid, onClick, text, extra = [] }) => h('div', { class: 'hx-actions', testid: `${testid}-row` }, btn('+  Start a new study', { kind: 'primary', testid, onClick }), ...extra, text ? h('span', { class: 'hx-meta' }, text) : null);
const tagsRow = (tags) => h('div', { class: 'hx-tags' }, (tags || []).map((t) => h('span', { class: 'hx-tag' }, t)));
const bar = (fraction, { running = false, label } = {}) => h('div', { class: `hx-bar${running ? ' running' : ''}`, role: 'progressbar', 'aria-label': label || 'Progress', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round((fraction || 0) * 100) }, h('i', { style: `width:${Math.round((fraction || 0) * 100)}%` }));
const actionCard = ({ title, text, testid, onClick }) => h('button', { type: 'button', class: 'hx-card action', testid, 'aria-label': title, onClick }, h('span', { class: 'hx-plus', 'aria-hidden': 'true' }, '+'), h('span', { class: 'hx-name' }, title), h('span', { class: 'hx-meta' }, text));
const STATUS = { draft: 'Draft', started: 'Running', finished: 'Finished', stopped: 'Stopped', running: 'Running' };
/** Whole units only: shows what would go, with counts, and deletes on confirm. */
export async function deleteUnit(kind, id, after) {
  try { const p = await api.get(`/agent-ops/delete/${kind}${id ? `/${encodeURIComponent(id)}` : ''}`);
    openDialog({ title: kind === 'all' ? 'Clear all test data' : `Delete this ${p.what}: ${p.title}`, testid: 'delete-dialog', danger: true, body: [h('p', {}, 'This removes, completely and for good:'), h('ul', { testid: 'delete-counts' }, Object.entries(p.counts).filter(([k, n]) => k !== 'recordVersions' && n).map(([k, n]) => h('li', {}, `${n} ${k}`))), h('p', { class: 'muted' }, `${p.keeps} Nothing is kept of what is deleted, and it cannot be undone.`)],
      actions: [{ label: 'Cancel', testid: 'delete-cancel', onClick: (c) => c() }, { label: kind === 'all' ? 'Clear all test data' : 'Delete', kind: 'danger', testid: 'delete-confirm', onClick: async (c) => { try { await api.del(`/agent-ops/delete/${kind}${id ? `/${encodeURIComponent(id)}` : ''}`); c(); toast('Deleted'); after(); } catch (err) { showError(err); } } }] });
  } catch (err) { showError(err); }
}
function studyCard(s, go) {
  const what = s.status === 'draft' ? 'Not started yet' : `${s.closed} of ${s.attempts} attempts closed`;
  return h('a', { class: 'hx-card', href: `#/s/${s.id}`, testid: `study-card-${s.id}`, 'aria-label': `${s.title}, ${STATUS[s.status]}, ${what}`, onClick: (e) => { e.preventDefault(); go(`#/s/${s.id}`); } },
    tagsRow(s.tags), h('span', { class: 'hx-name' }, s.title), h('span', { class: 'hx-meta' }, `${s.participants.length} participant${s.participants.length === 1 ? '' : 's'} · ${STATUS[s.status]}`),
    h('span', { class: 'hx-foot' }, h('span', { class: 'hx-meta', testid: `study-progress-${s.id}` }, what), bar(s.progress, { label: `${s.title} progress` })));
}
function runCard(r, go) {
  const running = r.status === 'running';
  return h('a', { class: 'hx-card', href: `#/run/${r.id}`, testid: `run-card-${r.id}`, 'aria-label': `${r.name}, ${STATUS[r.status]}, ${r.attempts} attempts`, onClick: (e) => { e.preventDefault(); go(`#/run/${r.id}`); } },
    tagsRow(r.tags), h('span', { class: 'hx-name' }, r.name), h('span', { class: 'hx-meta' }, `${r.agentId}${r.version ? ` v${r.version}` : ''} · ${STATUS[r.status]}`),
    h('span', { class: 'hx-foot' }, h('span', { class: 'hx-meta' }, `${r.attempts} attempt${r.attempts === 1 ? '' : 's'} so far${r.validationAttempts ? ` (${r.validationAttempts} on validation tasks)` : ''} · last ${fmtDateTime(r.lastAt)}`), bar(running ? 1 : 1, { running, label: `${r.name} activity` })));
}
const empty = (text, testid) => h('p', { class: 'hx-empty', testid }, text);
const get = (path, fallback) => api.get(path).catch(() => fallback);

// The Dashboard tab and the Time machine tab are in overview.js.

// ---------- Evaluate, Reinforcement learning, Data annotation ----------
export async function evaluateTab({ go, quick }) {
  const { studies: allEval } = await get('/agent-ops/studies?kind=evaluation', { studies: [] }); const studies = allEval.filter((x) => x.earlierMode !== 'rl');
  return frame('evaluate', 'Evaluate an agent',
    isResearcher() ? startRow({ testid: 'card-new-evaluation', text: 'Evaluate an agent: choose tasks, participants and conditions. Shadow, human in the loop, autonomous and red team are chosen inside.', onClick: () => { resetDraft('evaluation'); go('#/new/evaluation'); } }) : null,
    h('div', { class: 'hx-grid', testid: 'evaluate-cards' },
      studies.map((s) => studyCard(s, go))),
    studies.length ? null : empty('No evaluations yet.', 'evaluate-empty'),
    h('div', { class: 'hx-links', testid: 'evaluate-more' }, isResearcher() ? h('a', { href: '#/evaluate', testid: 'link-quick-evaluate', onClick: (e) => { e.preventDefault(); quick('evaluate'); } }, 'Quick study: a name and a research question') : null, [['ablation', 'Ablation'], ['regression', 'Regression'], ['versions', 'Versions'], ['leaderboard', 'Leaderboard'], ['review', 'Review queue'], ['grading', 'Grading queue'], ['history', 'Every run'], ['cds', 'Decision support']].map(([p, l]) => h('a', { href: `#/evaluate/${p}`, testid: `link-evaluate-${p}` }, l))));
}
export async function rlTab({ go, render, quick }) {
  const { runs } = await get('/agent-ops/training-runs', { runs: [] }); const training = (await get('/agent-ops/studies?kind=evaluation', { studies: [] })).studies.filter((x) => x.earlierMode === 'rl');
  const launch = async () => {
    const [{ agents }, { taskSets }] = await Promise.all([api.get('/agent-ops/agents'), api.get('/agent-ops/task-sets')]);
    if (!taskSets.length) { toast('Make a task set in the Library first', { error: true }); return; }
    formDialog({ title: 'Launch a training run', testid: 'run-form', submitLabel: 'Launch', intro: 'The agent attempts every train and validation task in the set. Eval tasks are never used in a run.',
      fields: [{ name: 'name', label: 'Run name', required: true, placeholder: 'for example night-1' }, { name: 'agentId', label: 'Agent', type: 'select', options: agents.filter((a) => a.enabled).map((a) => [a.id, `${a.name} v${a.version}`]) }, { name: 'taskSet', label: 'Task set', type: 'select', options: taskSets.map((t) => [t.id, `${t.name} v${t.version} (${t.tasks.length} tasks)`]) }, { name: 'rounds', label: 'Times through the set', type: 'number', value: 1, min: 1, max: 20 }, { name: 'seed', label: 'Seed', type: 'number', value: 1, min: 0 }],
      onSubmit: async (v) => { const out = await api.post('/agent-ops/training-runs', { ...v, rounds: Number(v.rounds) || 1, seed: Number(v.seed) || 1 }); toast(`Run "${out.name}" launched: ${out.planned} attempts planned${out.skippedEval ? `, ${out.skippedEval} eval task(s) left out` : ''}`); setTimeout(render, 600); } });
  };
  return frame('rl', 'Reinforcement learning',
    isResearcher() ? startRow({ testid: 'card-new-run', text: 'Launch a training run from here, or from your own trainer through the API. A run appears as soon as an agent sends its first attempt.', onClick: () => launch().catch(showError) }) : null,
    h('div', { class: 'hx-grid', testid: 'rl-cards' },
      runs.map((r) => runCard(r, go)), training.map((x) => studyCard(x, go))),
    runs.length || training.length ? null : empty('No training runs yet.', 'rl-empty'),
    h('div', { class: 'hx-links', testid: 'rl-more' }, h('a', { href: '#/rl/tools', testid: 'link-rl-tools' }, 'Connect a trainer, keys and task sets'), h('a', { href: '#/rl/rollouts', testid: 'link-rl-rollouts' }, 'Rollouts'), h('a', { href: '#/rl/reward', testid: 'link-rl-reward' }, 'Reward')));
}
export async function annotateTab({ go, quick }) {
  const { studies } = await get('/agent-ops/studies?kind=annotation', { studies: [] });
  return frame('annotate', 'Data annotation',
    isResearcher() ? startRow({ testid: 'card-new-annotation', text: 'An annotation project: choose cases, readers and how cases are shared out: everyone reads every case, k readers per case, or split.', onClick: () => { resetDraft('annotation'); go('#/new/annotation'); } }) : null,
    h('div', { class: 'hx-grid', testid: 'annotate-cards' },
      studies.map((s) => studyCard(s, go))),
    studies.length ? null : empty('No annotation projects yet.', 'annotate-empty'),
    h('div', { class: 'hx-links', testid: 'annotate-more' }, h('a', { href: '#/annotate/recordings', testid: 'link-recordings' }, 'Recordings'), h('a', { href: '#/annotate/new/label', testid: 'link-new-labelling' }, 'New labelling project'), h('a', { href: '#/annotate/projects', testid: 'link-labelling' }, 'Labelling projects')));
}

// ---------- set-up: task set -> participants -> conditions -> order and assignment -> review -> start ----------
const CONDITION_TEXT = { shadow: ['Shadow', 'The agent works out of sight on its own copy; nothing it writes is shown to clinicians.'], hitl: ['Human in the loop', 'The agent proposes; a person approves, edits or rejects.'], autonomous: ['Autonomous', 'The agent does the task on its own copy of the chart.'], redteam: ['Red team', 'The agent is run on a red-team copy to look for unsafe behaviour.'] };
const ORDER_TEXT = { fixed: 'Fixed: everyone meets the tasks in the same order', shuffled: 'Shuffled: a different order for each participant', counterbalanced: 'Counterbalanced: each task appears equally often in each position' };
let draft = null; let step = 0;
function resetDraft(kind) { draft = { kind, title: '', taskSet: '', live: false, agents: new Set(), people: new Set(), conditions: new Set(kind === 'evaluation' ? ['autonomous'] : []), order: 'fixed', mode: 'all', k: 2, humanBaseline: true, seed: 1, labelType: 'classification', labels: '', adjudicator: '' }; step = 0; }
const stepsFor = (kind) => (kind === 'evaluation' ? ['Tasks', 'Participants', 'Conditions', 'Order and assignment', 'Review'] : ['Cases and labels', 'Readers', 'Order and assignment', 'Review']);
const bodyOf = (d, agents) => ({
  title: d.title.trim(), kind: d.kind, ...(d.live ? { live: { clock: 'real' } } : { taskSet: d.taskSet || null }),
  participants: [...[...d.agents].map((id) => ({ kind: 'agent', id, version: agents.find((a) => a.id === id)?.version })), ...[...d.people].map((id) => ({ kind: 'person', id }))],
  conditions: d.agents.size ? [...d.conditions] : [], order: d.order, assignment: d.mode === 'k' ? { mode: 'k', k: Number(d.k) || 2 } : { mode: d.mode }, humanBaseline: d.humanBaseline, seed: Number(d.seed) || 1,
  ...(d.kind === 'annotation' ? { labelScheme: { type: d.labelType, labels: d.labels.split(',').map((x) => x.trim()).filter(Boolean) }, adjudicator: d.adjudicator || null } : {}),
});
export async function setupPage(kind, { go, render }) {
  style();
  if (!isResearcher()) return frame(kind === 'evaluation' ? 'evaluate' : 'annotate', 'Set-up', empty('Only a Researcher sets up a study.', 'setup-denied'));
  if (!draft || draft.kind !== kind) resetDraft(kind);
  const d = draft; const names = stepsFor(kind); const name = names[step];
  const [{ agents }, { people }, { taskSets }] = await Promise.all([api.get('/agent-ops/agents'), get('/agent-ops/people', { people: [] }), api.get('/agent-ops/task-sets')]);
  const text = (label, key, testid, attrs = {}) => h('label', { class: 'fieldrow' }, h('span', {}, label), h('input', { type: 'text', value: d[key], testid, 'aria-label': label, maxlength: 160, ...attrs, onInput: (e) => { d[key] = e.target.value; } }));
  const select = (label, key, options, testid) => h('label', { class: 'fieldrow' }, h('span', {}, label), h('select', { testid, 'aria-label': label, onChange: (e) => { d[key] = e.target.value; render(); } }, options.map(([v, t]) => h('option', { value: v, selected: String(d[key]) === String(v) }, t))));
  const check = (set, id, label, small, testid) => h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: set.has(id), testid, 'aria-label': label, onChange: (e) => { if (e.target.checked) set.add(id); else set.delete(id); } }), h('span', {}, label, small ? h('small', {}, small) : null));
  let panel; let problem = () => null;
  if (name === 'Tasks' || name === 'Cases and labels') {
    problem = () => (!d.title.trim() ? 'Give it a title' : !d.live && !d.taskSet ? 'Choose a task set' : null);
    panel = [h('h2', {}, kind === 'evaluation' ? 'What is being evaluated, and on which tasks?' : 'Which cases, and what is marked?'), h('p', {}, 'Tasks and task sets are made once in the Library and reused here.'),
      text('Title', 'title', 'setup-title'),
      kind === 'evaluation' ? h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: d.live, testid: 'setup-live', 'aria-label': 'Watch live patients instead of a task set', onChange: (e) => { d.live = e.target.checked; if (d.live) { d.conditions = new Set(['shadow']); d.people.clear(); } render(); } }), h('span', {}, 'Watch live patients instead of a task set', h('small', {}, 'Shadow only. Each watched patient event becomes an attempt; the agent\'s output stays hidden.'))) : null,
      d.live ? null : select('Task set', 'taskSet', [['', taskSets.length ? 'Choose a task set' : 'No task sets yet: make one in the Library'], ...taskSets.map((t) => [t.id, `${t.name} v${t.version} (${t.tasks.length} tasks)`])], 'setup-taskset'),
      kind === 'annotation' ? [select('What readers mark', 'labelType', [['classification', 'A label per case (classification)'], ['spans', 'Words or phrases (spans)'], ['boxes', 'Boxes on an image'], ['regions', 'Regions on an image'], ['segmentation', 'Segmentation']], 'setup-labeltype'), text('Labels, separated by commas', 'labels', 'setup-labels', { placeholder: 'for example normal, abnormal' })] : null];
  } else if (name === 'Participants' || name === 'Readers') {
    problem = () => (!(d.agents.size + d.people.size) ? 'Choose at least one participant' : kind === 'annotation' && !d.people.size ? 'Choose at least one reader' : null);
    panel = [h('h2', {}, kind === 'evaluation' ? 'Who takes part?' : 'Who reads the cases?'), h('p', {}, 'Agents run on their own. People find their tasks in My work.'),
      kind === 'evaluation' ? [h('h3', {}, 'Agents'), agents.filter((a) => a.enabled).map((a) => check(d.agents, a.id, `${a.name} v${a.version}`, a.capability || '', `setup-agent-${a.id}`))] : null,
      d.live ? null : [h('h3', {}, 'People'), people.length ? people.map((p) => check(d.people, p.id, p.name, `${p.role}${p.specialty ? `, ${p.specialty}` : ''}${p.credentialed ? ', credentialed' : ''}`, `setup-person-${p.id}`)) : h('p', { class: 'hx-meta', testid: 'setup-no-people' }, 'No people yet. Add them in the Library.')]];
  } else if (name === 'Conditions') {
    problem = () => (d.agents.size && !d.conditions.size ? 'Choose at least one condition for the agents' : d.conditions.has('hitl') && !d.people.size ? 'Human in the loop needs at least one person among the participants' : null);
    panel = [h('h2', {}, 'How do the agents take part?'), h('p', {}, d.agents.size ? 'Each agent does every task once under each condition you tick.' : 'No agents take part, so there is nothing to choose here.'),
      d.agents.size ? Object.entries(CONDITION_TEXT).filter(([id]) => !d.live || id === 'shadow').map(([id, [label, small]]) => check(d.conditions, id, label, small, `setup-condition-${id}`)) : null,
      d.people.size ? h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: d.humanBaseline, testid: 'setup-baseline', 'aria-label': 'People also do the tasks on their own', onChange: (e) => { d.humanBaseline = e.target.checked; } }), h('span', {}, 'People also do the tasks on their own', h('small', {}, 'A human baseline on the same tasks.'))) : null];
  } else if (name === 'Order and assignment') {
    problem = () => (d.mode === 'k' && !(Number(d.k) >= 1) ? 'k must be 1 or more' : null);
    panel = [h('h2', {}, 'In what order, and who gets which case?'), h('p', {}, 'These are fixed when the study starts.'),
      select('Task order', 'order', Object.entries(ORDER_TEXT), 'setup-order'),
      d.people.size ? select('How cases are shared among people', 'mode', [['all', 'Everyone reads every case'], ['k', 'k readers per case'], ['split', 'Split: each case to one reader']], 'setup-assignment') : null,
      d.people.size && d.mode === 'k' ? h('label', { class: 'fieldrow' }, h('span', {}, 'Readers per case (k)'), h('input', { type: 'number', min: 1, max: d.people.size, value: d.k, testid: 'setup-k', 'aria-label': 'Readers per case', onInput: (e) => { d.k = e.target.value; } })) : null,
      kind === 'annotation' && people.length ? select('Adjudicator for disagreements', 'adjudicator', [['', 'A Researcher'], ...people.filter((p) => !d.people.has(p.id)).map((p) => [p.id, p.name])], 'setup-adjudicator') : null,
      h('label', { class: 'fieldrow' }, h('span', {}, 'Seed'), h('input', { type: 'number', min: 0, value: d.seed, testid: 'setup-seed', 'aria-label': 'Seed', onInput: (e) => { d.seed = e.target.value; } }))];
  } else {
    const b = bodyOf(d, agents); const set = taskSets.find((t) => t.id === d.taskSet);
    const nameOf = (p) => (p.kind === 'agent' ? `${agents.find((a) => a.id === p.id)?.name ?? p.id} v${p.version}` : people.find((x) => x.id === p.id)?.name ?? 'Person');
    const row = (k, v) => [h('dt', {}, k), h('dd', {}, v)];
    panel = [h('h2', {}, 'Review'), h('p', {}, 'Starting freezes all of this and creates every attempt. To change a started study you copy it.'),
      h('dl', { class: 'hx-review', testid: 'setup-review' }, row('Title', b.title), row('Tasks', d.live ? 'Live patients (shadow)' : set ? `${set.name} v${set.version}, ${set.tasks.length} tasks` : '—'), row('Participants', b.participants.map(nameOf).join(', ') || '—'),
        row('Conditions', b.conditions.map((c) => CONDITION_TEXT[c][0]).join(', ') || (kind === 'annotation' ? 'Readers mark the cases' : 'People only')), row('Order', ORDER_TEXT[b.order]), row('Assignment', b.assignment.mode === 'k' ? `${b.assignment.k} readers per case` : b.assignment.mode === 'split' ? 'Split' : 'Everyone reads every case'), row('Seed', String(b.seed)))];
  }
  const error = h('p', { class: 'form-error', testid: 'setup-error', role: 'alert' });
  const submit = async (start) => {
    try { const made = await api.post('/agent-ops/studies', bodyOf(d, agents)); if (start) await api.post(`/agent-ops/studies/${made.id}/start`, {}); toast(start ? 'Started. Agents are running; people will find their tasks in My work.' : 'Saved as a draft'); draft = null; go(`#/s/${made.id}`); }
    catch (err) { error.textContent = err.message; }
  };
  const last = step === names.length - 1;
  return frame(kind === 'evaluation' ? 'evaluate' : 'annotate', kind === 'evaluation' ? 'Start a new evaluation' : 'Start a new annotation project',
    h('ol', { class: 'hx-steps', testid: 'setup-steps', 'aria-label': 'Steps' }, names.map((n, i) => h('li', { 'aria-current': i === step ? 'step' : undefined }, `${i + 1}. ${n}`))),
    h('div', { class: 'hx-panel', testid: `setup-step-${step + 1}` }, panel, error,
      h('div', { class: 'hx-nav' },
        btn(step === 0 ? 'Cancel' : 'Back', { testid: 'setup-back', onClick: () => { if (step === 0) { draft = null; go(kind === 'evaluation' ? '#/evaluate' : '#/annotate'); } else { step -= 1; render(); } } }),
        last ? [btn('Save as a draft', { testid: 'setup-save', onClick: () => submit(false) }), btn('Start', { kind: 'primary', testid: 'setup-start', onClick: () => submit(true) })]
          : btn('Next', { kind: 'primary', testid: 'setup-next', onClick: () => { const p = problem(); if (p) { error.textContent = p; return; } step += 1; render(); } }))));
}

// ---------- My work ----------
export async function myWorkPage({ go, render }) {
  const wk = await api.get('/agent-ops/my-work');
  const cur = wk.todo.find((t) => t.state === 'open') || null;
  const openIt = async (t) => { try { await api.post(`/agent-ops/attempts/${t.id}/open`, {}); render(); } catch (err) { showError(err); } };
  let working = null;
  if (cur) {
    const a = await api.get(`/agent-ops/attempts/${cur.id}`);
    const pid = String(a.task?.patient || '').split('/')[1];
    const scheme = a.labelScheme; let label = null; const why = h('textarea', { rows: 2, testid: 'work-why', 'aria-label': 'Why (optional)', placeholder: 'Why (optional)' });
    if (scheme?.type === 'classification' && scheme.labels?.length) label = h('select', { testid: 'work-label', 'aria-label': 'Your answer' }, [h('option', { value: '' }, 'Choose your answer'), ...scheme.labels.map((l) => h('option', { value: l }, l))]);
    const finish = async (skip) => {
      if (!skip && label && !label.value) { toast('Choose your answer first', { error: true }); return; }
      const answer = skip ? null : { ...(label ? { label: label.value } : {}), ...(scheme?.type === 'spans' ? { spans: [...spans], mask: [...new Set(spans.flatMap((sp) => Array.from({ length: sp.end - sp.start }, (_, i) => sp.start + i)))] } : {}) };
      try { const out = await api.post(`/agent-ops/attempts/${cur.id}/next`, { ...(answer && Object.keys(answer).length ? { answer } : {}), ...(skip ? { skip: true } : {}), why: why.value || undefined }); toast(out.done ? 'That was the last task. Thank you.' : 'Closed and locked. The next task is open.'); render(); } catch (err) { showError(err); }
    };
    // Human in the loop: the agent's proposals for this task, each to accept, edit or reject.
    let loop = null;
    if (cur.condition === 'hitl') {
      const { proposals } = await api.get('/agent-ops/proposals', { runId: a.runId, _branch: a.branch }).catch(() => ({ proposals: [] }));
      const decide = async (p, body) => { try { await api.post(`/agent-ops/proposals/${p.id}/decide?_branch=${encodeURIComponent(a.branch)}`, body); toast(body.decision === 'reject' ? 'Rejected' : body.decision === 'edit' ? 'Your edited version was saved' : 'Accepted'); render(); } catch (err) { showError(err); } };
      const card = (p) => {
        const fields = Object.entries(p.content || {}).filter(([, v]) => typeof v === 'string');
        const boxes = new Map(); let editing = false; const body = h('div', {}); const reason = h('input', { type: 'text', testid: `proposal-reason-${p.id}`, 'aria-label': 'Reason for rejecting', placeholder: 'Reason for rejecting (required to reject)', maxlength: 500 });
        const draw = () => { body.replaceChildren(...fields.map(([k, v]) => { if (editing) { const ta = h('textarea', { rows: Math.min(8, Math.max(2, Math.ceil(v.length / 70))), testid: `proposal-edit-${p.id}-${k}`, 'aria-label': `Edit ${k}` }); ta.value = v; boxes.set(k, ta); return h('label', { class: 'fieldrow' }, h('span', {}, k), ta); } return h('div', { class: 'fieldrow' }, h('span', {}, k), h('div', { style: 'white-space:pre-wrap', testid: `proposal-field-${p.id}-${k}` }, v)); })); };
        draw();
        const changed = p.edit?.fields ? Object.keys(p.edit.fields) : [];
        return h('div', { class: 'hx-panel', testid: `proposal-${p.id}`, 'data-status': p.status, style: 'margin-top:1rem' }, tagsRow([`Proposed by ${p.agent.label || p.agent.id}`, p.confidence != null ? `Confidence ${Math.round(p.confidence * 100)}%` : null].filter(Boolean)),
          p.reasoning ? h('p', { class: 'hx-meta' }, `Why: ${p.reasoning}`) : null, body,
          p.status === 'pending' ? [reason, h('div', { class: 'hx-nav' }, btn('Accept', { kind: 'primary', testid: `proposal-accept-${p.id}`, onClick: () => decide(p, { decision: 'accept' }) }),
            btn('Edit', { testid: `proposal-editbtn-${p.id}`, onClick: (e) => { if (!editing) { editing = true; draw(); e.currentTarget.textContent = 'Save my edited version'; return; } decide(p, { decision: 'edit', content: Object.fromEntries([...boxes].map(([k, ta]) => [k, ta.value])) }); } }),
            btn('Reject', { kind: 'danger', testid: `proposal-reject-${p.id}`, onClick: () => { if (reason.value.trim().length < 3) { toast('Say why you are rejecting it', { error: true }); reason.focus(); return; } decide(p, { decision: 'reject', reason: reason.value.trim() }); } }))]
            : h('p', { testid: `proposal-status-${p.id}` }, badge({ accepted: 'Accepted', edited: 'Edited by you, then accepted', rejected: 'Rejected', withdrawn: 'Withdrawn', 'auto-applied': 'Applied without asking' }[p.status] || p.status, p.status === 'rejected' ? 'danger' : 'ok'), p.reason ? ` Reason: ${p.reason}` : '', changed.length ? h('span', { testid: `proposal-diff-${p.id}` }, ` Changed: ${changed.map((k) => `${k} (${p.edit.fields[k].distance} characters)`).join(', ')}.`) : ''));
      };
      loop = h('div', { testid: 'work-proposals' }, h('h2', { class: 'hx-sub' }, 'What the agent proposes'), proposals.length ? proposals.map(card) : [h('p', { class: 'hx-meta', testid: 'work-proposals-empty' }, 'The agent has not proposed anything yet.'), btn('Check again', { testid: 'work-proposals-refresh', onClick: () => render() })]);
      if (!proposals.length) setTimeout(() => { if (location.hash === '#/my-work' && !document.querySelector('dialog[open]') && document.querySelector('[data-testid="work-proposals-empty"]')) render(); }, 1500);
    }
    // Marking words or phrases in a note: select the text, pick a label, add.
    let spansUi = null; const spans = [];
    if (scheme?.type === 'spans') {
      const docs = pid ? await fhir.search('DocumentReference', { patient: pid, _branch: a.branch }).catch(() => []) : [];
      const want = String(a.task?.subject || '').startsWith('DocumentReference/') ? docs.find((d) => `DocumentReference/${d.id}` === a.task.subject) : docs[0];
      const text = want ? decodeText(want.content?.[0]?.attachment?.data) || '' : '';
      const pre = h('pre', { testid: 'span-text', tabindex: 0, 'aria-label': 'The note to mark', style: 'white-space:pre-wrap;font:inherit;background:var(--dash-head);border-radius:0.75rem;padding:1rem;max-height:20rem;overflow:auto' }, text);
      const pickLabel = h('select', { testid: 'span-label', 'aria-label': 'Label for the selected words', style: 'width:auto' }, (scheme.labels?.length ? scheme.labels : ['mark']).map((l) => h('option', { value: l }, l)));
      const listEl = h('ul', { testid: 'span-list' });
      const drawSpans = () => listEl.replaceChildren(...spans.map((sp, i) => h('li', {}, `${sp.label}: "${text.slice(sp.start, sp.end)}" `, btn('Remove', { small: true, testid: `span-remove-${i}`, onClick: () => { spans.splice(i, 1); drawSpans(); } }))));
      const add = () => { const sel = window.getSelection(); if (!sel || sel.rangeCount === 0 || !pre.contains(sel.anchorNode) || !pre.contains(sel.focusNode)) { toast('Select some words in the note first', { error: true }); return; } const start = Math.min(sel.anchorOffset, sel.focusOffset); const end = Math.max(sel.anchorOffset, sel.focusOffset); if (end <= start) { toast('Select some words in the note first', { error: true }); return; } spans.push({ start, end, label: pickLabel.value }); spans.sort((x, y) => x.start - y.start); drawSpans(); };
      spansUi = h('div', { testid: 'work-spans', style: 'margin-top:1.25rem' }, h('span', { style: 'font-weight:600' }, 'Mark the note'), text ? [pre, h('div', { class: 'hx-nav' }, pickLabel, btn('Add the selected words', { testid: 'span-add', onClick: add })), listEl] : h('p', { class: 'hx-meta', testid: 'span-none' }, 'This patient has no note to mark.'));
    }
    working = h('div', { class: 'hx-panel', testid: 'work-open' }, tagsRow([a.studyTitle, cur.condition === 'hitl' ? 'With an agent' : null].filter(Boolean)), h('h2', {}, a.task?.title || cur.task), h('p', { testid: 'work-instruction' }, a.task?.instruction || ''),
      a.task?.scenario ? h('p', { class: 'hx-meta' }, a.task.scenario) : null,
      h('p', { class: 'hx-meta' }, 'You are working on your own copy of the chart for this task. Nothing you do reaches the live record. Everything you do is logged.'),
      h('div', { class: 'hx-nav' }, pid ? h('a', { class: 'btn', href: `/ehr/?branch=${encodeURIComponent(a.branch)}#/chart/${pid}/summary`, target: '_blank', rel: 'noopener', testid: 'work-open-chart', 'aria-label': 'Open the chart for this task' }, 'Open the chart') : null,
        h('a', { class: 'btn', href: `/pacs/?branch=${encodeURIComponent(a.branch)}#/worklist`, target: '_blank', rel: 'noopener', testid: 'work-open-imaging', 'aria-label': 'Open imaging for this task' }, 'Open imaging'),
        h('a', { class: 'btn', href: `/pathology/?branch=${encodeURIComponent(a.branch)}#/worklist`, target: '_blank', rel: 'noopener', testid: 'work-open-pathology', 'aria-label': 'Open pathology for this task' }, 'Open pathology')),
      ['boxes', 'regions', 'segmentation'].includes(scheme?.type) ? h('p', { class: 'hx-meta', testid: 'work-draw-note' }, 'Draw, outline or measure in the imaging or pathology viewer opened from here. What you draw is saved on your own copy and handed in with "Next task".') : null,
      spansUi, loop,
      label ? h('label', { class: 'fieldrow', style: 'margin-top:1.25rem' }, h('span', {}, 'Your answer'), label) : null, h('label', { class: 'fieldrow', style: 'margin-top:1rem' }, h('span', {}, 'Why'), why),
      h('div', { class: 'hx-nav' }, btn('Next task', { kind: 'primary', testid: 'work-next', onClick: () => finish(false) }), btn('Skip this task', { testid: 'work-skip', onClick: () => finish(true) })),
      h('p', { class: 'hx-meta' }, '"Next task" closes this task and locks it. You cannot come back to it.'));
  }
  const waiting = wk.todo.filter((t) => t.state !== 'open');
  return frame('dashboard', 'My work',
    working,
    !cur && wk.next ? h('div', { class: 'hx-grid' }, actionCard({ title: 'Start the next task', text: `${wk.next.task} (${wk.next.studyTitle})`, testid: 'work-start', onClick: () => openIt(wk.next) })) : null,
    !wk.todo.length && !(wk.other || []).length ? empty(`Nothing is waiting for you.${wk.done ? ` ${wk.done} done.` : ''}`, 'work-empty') : null,
    waiting.length ? [h('h2', { class: 'hx-sub' }, 'Waiting'), h('div', { class: 'hx-grid', testid: 'work-waiting' }, waiting.map((t) => h('div', { class: 'hx-card plain', testid: `work-item-${t.id}` }, tagsRow([t.studyTitle]), h('span', { class: 'hx-name' }, t.task), h('span', { class: 'hx-meta' }, t.canOpen && !cur ? 'Next' : 'Opens after the task before it'))))] : null,
    (wk.other || []).length ? [h('h2', { class: 'hx-sub' }, 'Reading lists and labelling'), h('div', { class: 'hx-grid', testid: 'work-other' }, wk.other.map((o) => h('a', { class: 'hx-card', href: `#/s/${o.study}/${o.kind === 'reading' ? 'read' : 'label'}`, testid: `work-other-${o.study}`, 'aria-label': `${o.title}: ${o.left} left` }, tagsRow([o.kind === 'reading' ? 'Reading list' : 'Labelling']), h('span', { class: 'hx-name' }, o.title), h('span', { class: 'hx-meta' }, `${o.left} ${o.kind === 'reading' ? 'case' : 'item'}${o.left === 1 ? '' : 's'} left for you`))))] : null,
    wk.toGrade || wk.toAdjudicate ? h('div', { class: 'hx-links' }, wk.toGrade ? h('a', { href: '#/grade', testid: 'work-to-grade' }, `${wk.toGrade} attempts to grade`) : null, wk.toAdjudicate ? h('a', { href: '#/adjudicate-cases', testid: 'work-to-adjudicate' }, `${wk.toAdjudicate} cases to adjudicate`) : null) : null);
}
export { frame, tagsRow, bar, empty, actionCard, studyCard, runCard, style as homeStyle, isResearcher, isStaff, get as getOr, STATUS, CONDITION_TEXT, badge, openDialog };

// ---------- a study: rows are participants, columns are tasks, each cell opens that attempt's trace ----------
const CELL = { waiting: ['', '·', 'waiting'], open: ['open', '…', 'in progress'], skipped: ['done', 'skip', 'skipped'], stopped: ['done', 'stop', 'stopped'] };
function cellLook(c) {
  if (CELL[c.state]) return CELL[c.state];
  if (c.scores?.safetyViolations > 0) return ['unsafe', '!', `closed, ${c.scores.safetyViolations} safety violation${c.scores.safetyViolations === 1 ? '' : 's'}`];
  if (c.scores?.success) return c.scores.success.pass ? ['pass', '✓', 'closed, task done'] : ['fail', '✗', `closed, ${c.scores.success.met} of ${c.scores.success.of} checks met`];
  return ['done', '●', 'closed'];
}
const picked = { condition: null, perturbation: '' };
/** The pages a study has besides its grid: where the earlier screens' tools now live. [address part, label]. */
export function studySections(s) {
  const from = s.migratedFrom; const out = [];
  if (from?.type === 'Study') { for (const t of MODES[MODES[s.earlierMode] ? s.earlierMode : 'evaluate'].tabs) out.push([t, TAB_LABEL[t]]); if (s.readerStudy) out.push(['read', 'Reading list']); }
  if (from?.type === 'AnnotationProject') out.push(['project', 'Project and agreement'], ['label', 'Labelling workbench'], ['adjudicate', 'Adjudication']);
  if (from?.type === 'earlier-screen') out.push(from.mode === 'shadow' ? ['compare', 'Agent against the clinician'] : from.mode === 'hitl' ? ['loop', 'How people answered'] : ['hazards', 'Hazard by hazard']);
  return out;
}
export const sectionTabs = (s, active) => { const secs = studySections(s); return secs.length ? h('nav', { class: 'hx-pills', testid: 'study-sections', 'aria-label': 'Pages of this study', style: 'margin-bottom:1.25rem' }, [['', 'Grid'], ...secs].map(([part, label]) => h('a', { href: `#/s/${s.id}${part ? `/${part}` : ''}`, testid: `study-section-${part || 'grid'}`, 'aria-label': label, 'aria-current': part === active ? 'page' : undefined }, label))) : null; };
/** A study's other pages share its title, tags and page row. */
export async function studySubFrame(id, part, content) { const g = await api.get(`/agent-ops/studies/${id}`); const s = g.study; return { study: s, el: frame(s.kind === 'annotation' ? 'annotate' : s.earlierMode === 'rl' ? 'rl' : 'evaluate', s.title, h('div', { class: 'hx-head' }, tagsRow(s.tags)), sectionTabs(s, part), h('div', { testid: `study-part-${part}` }, content)) }; }
export async function studyPage(id, { go, render }) {
  const g = await api.get(`/agent-ops/studies/${id}`); const s = g.study;
  if (!g.conditions.includes(picked.condition)) picked.condition = g.conditions.find((c) => c !== 'human') || g.conditions[0] || null;
  const act = (label, path, testid, kind) => btn(label, { kind, testid, onClick: async () => { try { const out = await api.post(`/agent-ops/studies/${id}/${path}`, {}); toast(path === 'copy' ? 'Copied as a new draft' : path === 'start' ? 'Started and frozen' : 'Stopped'); if (path === 'copy') go(`#/s/${out.id}`); else setTimeout(render, 400); } catch (err) { showError(err); } } });
  const sameColumn = (c, col) => (g.layout === 'case' ? c.caseRef === col.caseRef : g.layout === 'position' ? c.position === col.position : c.taskId === col.taskId);
  const cellsFor = (row, col) => g.cells.filter((c) => c.row === row.key && sameColumn(c, col) && (row.kind === 'person' || g.layout !== 'task' || (c.condition === picked.condition && (c.perturbation || '') === picked.perturbation)));
  const hazards = (c, row, col) => openDialog({ title: `Hazards: ${row.label}, ${col.title}`, testid: 'hazard-dialog', wide: true, body: [h('p', { class: 'muted' }, 'Each hazard from the red-team library was planted on its own copy of the chart and scored on its own.'), h('table', { testid: 'hazard-list', 'aria-label': 'Hazards' }, h('thead', {}, h('tr', {}, ['Hazard', 'Result', 'What went wrong', ''].map((x) => h('th', {}, x)))), h('tbody', {}, c.scores.hazards.map((z) => h('tr', { testid: `hazard-${z.test}` }, h('td', {}, z.title || z.test), h('td', {}, z.pass == null ? badge('Did not run', '') : z.pass ? badge('Pass', 'ok') : badge('Fail', 'danger')), h('td', {}, z.error || (z.checks || []).filter((k) => !k.pass).map((k) => k.label).join('; ')), h('td', {}, z.runId ? btn('Open the trace', { small: true, testid: `hazard-trace-${z.test}`, onClick: () => { document.querySelector('dialog[open]')?.close(); go(`#/trace/${z.runId}`); } }) : '')))))], actions: [{ label: 'Close', kind: 'primary', testid: 'hazard-close', onClick: (x) => x() }] });
  const cell = (row, col) => {
    const c = cellsFor(row, col)[0];
    if (!c) return h('td', {}, h('span', { class: 'hx-cell none', 'aria-label': 'not assigned' }));
    const [cls, mark, words] = cellLook(c);
    return h('td', {}, h('button', { type: 'button', class: `hx-cell ${cls}`, testid: `cell-${c.id}`, 'data-state': c.state, 'aria-label': `${row.label}, ${col.title}: ${words}. Open the trace.`, title: words, onClick: () => { if (c.scores?.hazards?.length) hazards(c, row, col); else if (c.runId) go(`#/trace/${c.runId}`); else toast(c.state === 'closed' ? 'This came from an earlier screen that kept no trace for it' : 'This attempt has not started, so it has no trace yet'); } }, c.scores?.hazards?.length && c.state === 'closed' ? `${c.scores.hazards.filter((z) => z.pass).length}/${c.scores.hazards.length}` : mark));
  };
  const pick = (label, key, options, testid) => h('label', { class: 'hx-meta' }, `${label} `, h('select', { testid, 'aria-label': label, style: 'width:auto', onChange: (e) => { picked[key] = e.target.value; render(); } }, options.map(([v, t]) => h('option', { value: v, selected: picked[key] === v }, t))));
  const agentConds = g.conditions.filter((c) => c !== 'human');
  // Side by side: each agent against each person on the same task, with the first step at which they part.
  let versus = null;
  if (g.layout === 'task' && s.status !== 'draft' && g.rows.some((r) => r.kind === 'agent') && g.rows.some((r) => r.kind === 'person')) {
    const cmp = await get(`/agent-ops/studies/${id}/compare`, { rows: [] }); const rowsC = cmp.rows.filter((r) => r.person);
    const steps = (list, at) => h('ol', { style: 'margin:0;padding-left:1.25rem' }, list.map((x, i) => h('li', { style: at === i + 1 ? 'font-weight:600;color:var(--danger-text)' : '' }, x)));
    const detail = (r) => openDialog({ title: `${r.task}: agent against ${r.person}`, testid: 'compare-dialog', wide: true, body: [h('p', { class: 'muted', testid: 'compare-split' }, r.split ? `They part at step ${r.split.step}: the agent did "${r.split.agent.did}", the person did "${r.split.human.did}".` : 'They took the same path.'), h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:1.5rem', testid: 'compare-side-by-side' }, h('div', {}, h('h3', {}, 'Agent'), steps(r.agentPath, r.split?.step)), h('div', {}, h('h3', {}, r.person), steps(r.personPath, r.split?.step)))], actions: [{ label: 'Agent trace', testid: 'compare-agent-trace', onClick: (c) => { c(); go(`#/trace/${r.agentRun}`); } }, { label: 'Person trace', testid: 'compare-person-trace', onClick: (c) => { c(); go(`#/trace/${r.personRun}`); } }, { label: 'Close', kind: 'primary', testid: 'compare-close', onClick: (c) => c() }] });
    versus = h('div', { class: 'hx-panel', testid: 'study-compare', style: 'margin-top:1.25rem;max-width:none' }, h('h2', {}, 'Agent against people, side by side'), h('p', {}, 'The same task done by the agent and by a person: how alike their paths are, and the first step at which they part.'),
      rowsC.length ? h('table', { testid: 'compare-table', 'aria-label': 'Agent against people' }, h('thead', {}, h('tr', {}, ['Task', 'Mode', 'Person', 'Alike', 'First divergence', ''].map((x) => h('th', {}, x)))), h('tbody', {}, rowsC.map((r) => h('tr', { testid: `compare-${r.agentAttempt}-${r.personAttempt}` }, h('td', {}, r.task), h('td', {}, CONDITION_TEXT[r.condition]?.[0] || r.condition), h('td', {}, r.person), h('td', {}, r.similarity == null ? '—' : `${Math.round(r.similarity * 100)}%`), h('td', {}, r.split ? `Step ${r.split.step}: agent "${r.split.agent.did}", person "${r.split.human.did}"` : 'Same path'), h('td', {}, btn('Side by side', { small: true, testid: `compare-open-${r.agentAttempt}-${r.personAttempt}`, onClick: () => detail(r) })))))) : h('p', { class: 'hx-meta', testid: 'compare-empty' }, 'Nothing to compare yet: it needs a closed agent attempt and a closed person attempt on the same task.'));
  }
  let agree = null;
  if (isResearcher() && s.status !== 'draft' && g.rows.filter((r) => r.kind === 'person').length >= 2) {
    const a = await get(`/agent-ops/agreement/${id}`, null);
    if (a) agree = h('div', { class: 'hx-panel', testid: 'study-agreement', style: 'margin-top:1.25rem;max-width:none' }, h('h2', {}, 'Agreement between readers'),
      h('p', {}, [a.kappa?.kappa != null ? `Kappa ${a.kappa.kappa} (${a.kappa.statistic}${a.kappa.reading ? `, ${a.kappa.reading}` : ''}).` : 'Kappa: not enough answers yet.', a.dice ? ` Dice ${a.dice.mean} over ${a.dice.cases} cases.` : '', a.hausdorff ? ` Hausdorff distance at worst ${a.hausdorff.worst} ${a.hausdorff.unit} (mean ${a.hausdorff.mean}).` : '', ` ${a.adjudications.filter((x) => x.status === 'open').length} case(s) waiting for adjudication.`].join('')),
      h('table', { testid: 'agreement-cases', 'aria-label': 'Agreement case by case' }, h('thead', {}, h('tr', {}, ['Case', 'Readers', 'Same label', 'Dice', 'Hausdorff'].map((x) => h('th', {}, x)))), h('tbody', {}, a.cases.filter((c) => c.readers >= 2).slice(0, 200).map((c) => h('tr', {}, h('td', {}, c.title), h('td', {}, String(c.readers)), h('td', {}, c.label == null ? '—' : `${Math.round(c.label * 100)}%`), h('td', {}, c.dice == null ? '—' : String(c.dice)), h('td', {}, c.hausdorff == null ? '—' : `${c.hausdorff} px`))))),
      s.legacy ? null : h('a', { href: '#/adjudicate-cases', testid: 'study-adjudicate-link' }, 'Open the adjudication queue'));
  }
  return frame(s.kind === 'annotation' ? 'annotate' : 'evaluate', s.title,
    h('div', { class: 'hx-head', testid: 'study-head' }, tagsRow(s.tags), badge(STATUS[s.status], s.status === 'started' ? 'accent' : s.status === 'finished' ? 'ok' : '', 'study-status'),
      h('span', { class: 'hx-meta grow', testid: 'study-progress' }, s.status === 'draft' ? 'Draft: nothing is frozen yet' : s.legacy ? `${s.attempts} attempts brought over from an earlier screen. The earlier records are kept as they were.` : `${s.closed} of ${s.attempts} attempts closed. Frozen ${fmtDateTime(s.frozen.at)}.`),
      isResearcher() && s.status === 'draft' ? act('Start', 'start', 'study-start', 'primary') : null, isResearcher() && s.status === 'started' && !s.legacy ? act('Stop', 'stop', 'study-stop', 'danger') : null, isResearcher() && !s.legacy ? act('Copy as a new draft', 'copy', 'study-copy') : null, isResearcher() ? btn('Delete study', { kind: 'danger', testid: 'study-delete', onClick: () => deleteUnit('study', id, () => go('#/')) }) : null),
    sectionTabs(s, ''),
    s.status === 'draft' ? empty('Start the study to create its attempts. Starting freezes the tasks, participants, conditions and order.', 'study-draft') : [
      h('div', { class: 'hx-head' }, agentConds.length > 1 && g.layout === 'task' ? pick('Condition', 'condition', agentConds.map((c) => [c, CONDITION_TEXT[c][0]]), 'study-condition') : null, g.perturbations.length ? pick('Perturbation', 'perturbation', [['', 'None'], ...g.perturbations.map((p) => [p.id, p.label])], 'study-perturbation') : null),
      g.columns.length ? h('div', { class: 'hx-gridwrap' }, h('table', { class: 'hx-matrix', testid: 'study-grid', 'aria-label': 'Participants by tasks' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Participant'), g.columns.map((c) => h('th', { scope: 'col', title: c.title }, c.title)))),
        h('tbody', {}, g.rows.map((r) => h('tr', { testid: `study-row-${r.kind}-${r.id}` }, h('th', { scope: 'row' }, r.label), g.columns.map((c) => cell(r, c)))))),
        h('div', { class: 'hx-legend', 'aria-hidden': 'true' }, [['var(--ok-soft)', '✓ task done'], ['var(--warn-soft)', '✗ checks not met'], ['var(--danger-soft)', '! safety violation'], ['var(--accent-soft)', '… in progress'], ['var(--dash-head)', '· waiting, skipped or stopped']].map(([bg, t]) => h('span', {}, h('i', { style: `background:${bg}` }), t)))) : empty(s.live ? 'Watching live patients. Each watched event will appear here as an attempt.' : 'No attempts.', 'study-no-attempts'),
      versus, agree]);
}

// ---------- Surveillance and reporting: an always-on status card with counts, then signals and reports ----------
export async function surveillanceTab(inner) {
  const [rep, sig, watch] = await Promise.all([get('/agent-ops/surveillance/reports', { reports: [] }), get('/agent-ops/surveillance/signals', { signals: [] }), get('/agent-ops/surveillance/watchlist', { watches: [] })]);
  const open = rep.reports.filter((r) => ['new', 'needs-info', 'under-review'].includes(r.status)).length; const overdue = rep.reports.filter((r) => r.overdue).length;
  const openSignals = sig.signals.filter((x) => !x.review && !x.reviewedAt && x.status !== 'reviewed').length; const watches = (watch.watches || watch.watchlist || []).length;
  const n = (v, label, testid) => h('div', {}, h('b', { class: 'hx-count', testid }, String(v)), h('span', {}, label));
  return frame('surveillance', 'Surveillance and reporting',
    isResearcher() ? startRow({ testid: 'card-new-surveillance', text: 'Monitor a deployed agent: individual and aggregate reports, subgroup analyses and signals.', onClick: () => { location.hash = '#/surveillance/studies'; } }) : null,
    h('div', { class: 'hx-grid', style: 'grid-template-columns:1fr;margin-bottom:1.5rem' }, h('div', { class: 'hx-card status plain', testid: 'surv-status', role: 'status', 'aria-label': 'Surveillance status' },
      tagsRow(['Always on']), h('span', { class: 'hx-name' }, 'Surveillance is watching every agent'), h('span', { class: 'hx-meta', style: 'color:inherit' }, 'Reports from people and automatic checks are collected all the time, whatever else is running.'),
      h('div', { class: 'hx-counts' }, n(rep.reports.length, 'reports', 'surv-count-reports'), n(open, 'open reports', 'surv-count-open'), n(overdue, 'overdue', 'surv-count-overdue'), n(openSignals, 'open signals', 'surv-count-signals'), n(watches, 'on the watch list', 'surv-count-watches')))),
    inner);
}

// ---------- Library: every agent and person by default; a search bar and filters switch it to search results ----------
const filters = { q: '', task: '', study: '', run: '', agent: '', version: '', person: '', mode: '', from: '', to: '', outcome: '' };
const MODE_WORD = { shadow: 'Shadow', hitl: 'Human in the loop', autonomous: 'Autonomous', redteam: 'Red team', human: 'Human', training: 'Training run' };
const OUTCOME_WORD = { pass: 'Task done', fail: 'Checks not met', unsafe: 'Safety violation', ungraded: 'Not graded yet', open: 'Not finished', none: 'Closed' };
const searching = () => Object.values(filters).some((v) => v);
function personDialog(render, person = null) {
  formDialog({ title: person ? 'Change a person' : 'Invite a person', testid: 'person-form', submitLabel: person ? 'Save' : 'Add and make an invitation',
    intro: person ? 'A change of role, or switching sign-in off, applies the next time they sign in.' : 'You get a link to send to them yourself. It works once and runs out in 14 days; they choose their own password with it. One role per person.',
    fields: [{ name: 'email', label: 'Email', required: true, value: person?.email || '' }, { name: 'name', label: 'Name (optional)', value: person && person.name !== person.email ? person.name : '' },
      { name: 'role', label: 'Role', type: 'select', value: person?.role || 'physician', options: [['researcher', 'Researcher'], ['physician', 'Physician'], ['nurse', 'Nurse'], ['coder', 'Coder'], ['patient', 'Patient'], ['payer-medical-director', 'Insurance Payer']] },
      { name: 'patientId', label: 'For a Patient: the patient record id, or the word random', value: person?.patientId || '', placeholder: 'random' },
      { name: 'specialty', label: 'Specialty', value: person?.specialty || '' }, { name: 'seniority', label: 'Seniority', type: 'select', value: person?.seniority || '', options: [['', 'Not given'], ['student', 'Student'], ['trainee', 'Trainee'], ['qualified', 'Qualified'], ['senior', 'Senior'], ['consultant', 'Consultant']] },
      { name: 'credentialed', label: 'Credentialed', type: 'select', value: person?.credentialed ? 'yes' : 'no', options: [['no', 'No'], ['yes', 'Yes']] },
      person && person.status !== 'Invited' ? { name: 'status', label: 'Sign-in', type: 'select', value: person.status === 'Off' ? 'off' : 'active', options: [['active', 'Allowed'], ['off', 'Switched off']] } : null],
    onSubmit: async (v) => {
      const body = { ...v, name: v.name || undefined, credentialed: v.credentialed === 'yes', seniority: v.seniority || null, patientId: v.role === 'patient' ? (v.patientId || 'random') : null };
      if (person) { await api.put(`/agent-ops/people/${person.id}`, body); toast('Saved'); render(); return; }
      const out = await api.post('/agent-ops/people', body); render(); showInvite(out);
    } });
}
function showInvite(out) {
  openDialog({ title: 'Invitation code', testid: 'invite-dialog', body: [h('p', {}, `Send this link to ${out.person.email} yourself. It is shown once, works once, and runs out on ${fmtDateTime(out.inviteExpires)}.`), h('p', { class: 'mono', testid: 'invite-link', style: 'user-select:all;overflow-wrap:anywhere' }, `${location.origin}${out.inviteLink}`), h('p', { class: 'muted' }, 'Or give them the code to type on the lock screen under "I have an invitation code":'), h('p', { class: 'mono', testid: 'invite-code', style: 'font-size:1.25rem;user-select:all;overflow-wrap:anywhere' }, out.inviteCode)], actions: [{ label: 'Done', kind: 'primary', testid: 'invite-done', onClick: (c) => c() }] });
}
export async function libraryTab({ go, render }) {
  const opts = await api.get('/agent-ops/search', { options: 1 }).catch(() => ({ studies: [], runs: [], tasks: [], agents: [], people: [], modes: [], outcomes: [] }));
  const set = (k) => (e) => { filters[k] = e.target.value; render(); };
  const sel = (k, label, options) => h('select', { testid: `filter-${k}`, 'aria-label': label, style: 'width:auto;max-width:14rem', onChange: set(k) }, [h('option', { value: '' }, label), ...options.map(([v, t]) => h('option', { value: v, selected: filters[k] === v }, t))]);
  const search = h('input', { type: 'search', value: filters.q, testid: 'library-search', 'aria-label': 'Search attempts by task, study, run, agent or mode', placeholder: 'Search tasks, studies, runs, agents', style: 'max-width:28rem;flex:1 1 16rem', onKeydown: (e) => { if (e.key === 'Enter') { filters.q = e.target.value; render(); } } });
  const bar2 = h('div', { class: 'hx-head', testid: 'library-filters', role: 'search' }, search, btn('Search', { testid: 'library-search-go', onClick: () => { filters.q = search.value; render(); } }),
    sel('task', 'Task', opts.tasks.map((t) => [t.id, t.title])), sel('study', 'Study', opts.studies.map((s) => [s.id, s.title])), sel('run', 'Run', opts.runs.map((r) => [r.id, r.title])), sel('agent', 'Agent', opts.agents.map((a) => [a.id, a.title])),
    sel('version', 'Version', [...new Set(opts.agents.map((a) => a.version))].map((v) => [v, `v${v}`])), opts.people.length ? sel('person', 'Person', opts.people.map((p) => [p.id, p.title])) : null, sel('mode', 'Mode', opts.modes.map((m) => [m, MODE_WORD[m]])), sel('outcome', 'Outcome', opts.outcomes.map((o) => [o, OUTCOME_WORD[o]])),
    h('input', { type: 'date', value: filters.from, testid: 'filter-from', 'aria-label': 'From date', style: 'width:auto', onChange: set('from') }), h('input', { type: 'date', value: filters.to, testid: 'filter-to', 'aria-label': 'To date', style: 'width:auto', onChange: set('to') }),
    searching() ? btn('Clear', { testid: 'library-clear', onClick: () => { for (const k of Object.keys(filters)) filters[k] = ''; render(); } }) : null);
  let body;
  if (searching()) {
    const out = await api.get('/agent-ops/search', Object.fromEntries(Object.entries(filters).filter(([, v]) => v)));
    body = [h('p', { class: 'hx-meta', testid: 'search-count' }, `${out.total} attempt${out.total === 1 ? '' : 's'} found${out.total > out.results.length ? `, showing the newest ${out.results.length}` : ''}.`),
      h('div', { class: 'hx-gridwrap' }, h('table', { testid: 'search-results', 'aria-label': 'Search results' }, h('thead', {}, h('tr', {}, ['Task', 'Study or run', 'Participant', 'Mode', 'Outcome', 'When', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, out.results.length ? out.results.map((r) => h('tr', { testid: `result-${r.id}` }, h('td', {}, r.task), h('td', {}, h('a', { href: r.kind === 'study' ? `#/s/${r.containerId}` : `#/run/${r.containerId}` }, r.container)), h('td', {}, r.participant), h('td', {}, MODE_WORD[r.mode] || r.mode), h('td', {}, OUTCOME_WORD[r.outcome] || r.outcome), h('td', {}, r.at ? fmtDateTime(r.at) : ''),
          h('td', {}, r.runId ? btn('Open the trace', { small: true, testid: `result-trace-${r.id}`, onClick: () => go(`#/trace/${r.runId}`) }) : ''))) : h('tr', {}, h('td', { colspan: 7, class: 'muted', testid: 'search-empty' }, 'No data to display')))))];
  } else {
    const list = await api.get('/agent-ops/library-list');
    body = [h('div', { class: 'hx-head' }, h('h2', { class: 'hx-sub grow', style: 'margin:0' }, 'Agents and people'), isResearcher() ? btn('Add a person', { kind: 'primary', testid: 'person-add', onClick: () => personDialog(render) }) : null),
      h('div', { class: 'hx-gridwrap' }, h('table', { testid: 'library-list', 'aria-label': 'All agents and people' }, h('thead', {}, h('tr', {}, ['Name', 'Kind', 'Status', 'Version or role', 'Last active', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, list.rows.map((r) => h('tr', { testid: `library-row-${r.kind}-${r.id}` }, h('td', {}, r.name), h('td', {}, r.kind === 'agent' ? 'Agent' : 'Person'), h('td', {}, badge(r.status, ['On', 'Active'].includes(r.status) ? 'ok' : r.status === 'Invited' ? 'warn' : '')), h('td', {}, r.detail + (r.kind === 'person' && r.specialty ? `, ${r.specialty}` : '')), h('td', {}, r.lastActive ? fmtDateTime(r.lastActive) : 'Never'),
          h('td', { class: 'actions' }, r.kind === 'agent' ? btn('Report card', { small: true, testid: `agent-card-${r.id}`, onClick: () => go(`#/report/${r.id}`) }) : [btn('Change', { small: true, testid: `person-edit-${r.id}`, onClick: () => personDialog(render, r) }), btn('New invitation', { small: true, testid: `person-invite-${r.id}`, onClick: async () => { try { showInvite(await api.post(`/agent-ops/people/${r.id}/invite`, {})); render(); } catch (err) { showError(err); } } })]))))))];
  }
  return frame('library', 'Library', bar2, body,
    h('div', { class: 'hx-links' }, [['#/people', 'People and the sign-in log', 'lib-people'], ['#/library/tasks', 'Tasks', 'lib-tasks'], ['#/rl/tools', 'Task sets', 'lib-tasksets'], ['#/library/agents', 'Agents: versions, model, permissions, keys', 'lib-agents'], ['#/library/scenarios', 'Scenarios', 'lib-scenarios'], ['#/library/safety', 'Safety tests', 'lib-safety'], ['#/library/benchmarks', 'Benchmarks', 'lib-benchmarks'], ].map(([href, label, testid]) => h('a', { href, testid }, label))));
}

// ---------- a training run, the report card, expert grades, adjudication ----------
export async function runPage(id, { go }) {
  const r = await api.get(`/agent-ops/training-runs/${id}`);
  return frame('rl', r.name, h('div', { class: 'hx-head' }, tagsRow(r.tags), badge(STATUS[r.status], r.status === 'running' ? 'accent' : 'ok', 'run-status'), isResearcher() ? btn('Delete run', { kind: 'danger', small: true, testid: 'run-delete', onClick: () => deleteUnit('run', id, () => go('#/')) }) : null, h('span', { class: 'hx-meta grow' }, `${r.agentId}${r.version ? ` v${r.version}` : ''} · ${r.attempts} attempts${r.validationAttempts ? `, ${r.validationAttempts} on validation tasks (never exported as training data)` : ''} · started ${fmtDateTime(r.startedAt)}`)),
    h('div', { class: 'hx-gridwrap' }, h('table', { testid: 'run-attempts', 'aria-label': 'Attempts in this run' }, h('thead', {}, h('tr', {}, ['Started', 'Task', 'Split', 'Seed', 'Outcome', 'Steps', ''].map((c) => h('th', {}, c)))),
      h('tbody', {}, r.attemptList.length ? r.attemptList.map((a) => h('tr', { testid: `run-attempt-${a.id}` }, h('td', {}, fmtDateTime(a.startedAt)), h('td', { class: 'mono' }, `${String(a.task).slice(0, 8)} v${a.taskVersion}`), h('td', {}, a.split), h('td', {}, String(a.seed)), h('td', {}, !a.endedAt ? 'Not finished' : a.scores?.success ? (a.scores.success.pass ? 'Task done' : `${a.scores.success.met} of ${a.scores.success.of} checks met`) : 'Closed'), h('td', {}, a.scores?.steps ?? ''), h('td', {}, btn('Open the trace', { small: true, testid: `run-trace-${a.id}`, onClick: () => go(`#/trace/${a.id}`) }))))
        : h('tr', {}, h('td', { colspan: 7, class: 'muted' }, 'No data to display'))))));
}
export async function reportCardPage(agentId) {
  const c = await api.get('/agent-ops/report-card', { agent: agentId });
  const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
  const cols = [['shadow', 'Shadow'], ['hitl', 'Human in the loop'], ['autonomous', 'Autonomous'], ['redteam', 'Red team']];
  const cellsOf = (m) => [m.attempts ? String(m.attempts) : '—', m.success.n ? `${pct(m.success.rate)} (${pct(m.success.low)} to ${pct(m.success.high)}, n=${m.success.n})` : '—', m.attempts ? `${m.safetyViolations.total} in ${m.safetyViolations.attemptsWithAny} attempt${m.safetyViolations.attemptsWithAny === 1 ? '' : 's'}` : '—', m.expertGrade.graded ? `${pct(m.expertGrade.mean)} (${m.expertGrade.graded} graded)` : '—', m.seconds.median == null ? '—' : `${m.seconds.median} s`, m.steps.median == null ? '—' : String(m.steps.median)];
  const rows = ['Attempts', 'Task success', 'Safety violations', 'Expert grade', 'Time (median)', 'Steps (median)'];
  const data = Object.fromEntries([...cols.map(([k]) => [k, cellsOf(c.modes[k])]), ['human', cellsOf(c.human)]]);
  return frame('library', `${c.agent.name} v${c.agent.version}`,
    isResearcher() ? h('div', { class: 'hx-head' }, h('span', { class: 'grow' }), c.agent.builtIn ? btn('Turn off', { small: true, testid: 'agent-off', title: 'Turn off this built-in agent (a built-in agent cannot be deleted)', disabled: !c.agent.enabled, onClick: async () => { await api.put(`/agent-ops/agents/${c.agent.id}`, { enabled: false }); toast('Turned off'); location.reload(); } }) : btn('Delete agent and all its runs', { kind: 'danger', small: true, testid: 'agent-delete', onClick: () => deleteUnit('agent', c.agent.id, () => { location.hash = '#/library'; }) })) : null,
    c.trainTaskStudies.length ? h('div', { class: 'hx-card plain', testid: 'card-train-note', role: 'note', style: 'min-height:0;background:var(--warn-soft);color:var(--dash-ink);margin-bottom:1.25rem' }, h('span', { class: 'hx-name', style: 'font-size:1.125rem' }, 'Some studies used train tasks'), h('span', { class: 'hx-meta', style: 'color:inherit' }, `${c.notCounted.notEvalTasks} attempt${c.notCounted.notEvalTasks === 1 ? '' : 's'} in ${c.trainTaskStudies.map((x) => `"${x}"`).join(', ')} ${c.notCounted.notEvalTasks === 1 ? 'was' : 'were'} on train or validation tasks. They are left out of this card, because an agent may have been trained on those tasks. Use eval tasks in a study to have it count.`)) : null,
    h('p', { class: 'hx-meta', testid: 'card-note' }, `Report card over ${c.tasks} eval task${c.tasks === 1 ? '' : 's'}. ${c.notCounted.note}${c.earlierScreens ? ` ${c.earlierScreens} attempt${c.earlierScreens === 1 ? '' : 's'} came from the earlier screens.` : ''}`),
    h('div', { class: 'hx-gridwrap' }, h('table', { testid: 'report-card', 'aria-label': 'Report card: scores by mode' }, h('thead', {}, h('tr', {}, h('th', {}, 'Score'), cols.map(([, l]) => h('th', { scope: 'col' }, l)), h('th', { scope: 'col' }, 'People on the same tasks'))),
      h('tbody', {}, rows.map((label, i) => h('tr', {}, h('th', { scope: 'row' }, label), cols.map(([k]) => h('td', { testid: `card-${k}-${i}` }, data[k][i])), h('td', { testid: `card-human-${i}` }, data.human[i])))))),
    c.insurance ? h('div', { testid: 'card-insurance', style: 'margin-top:2.5rem' }, h('h2', { class: 'hx-sub', style: 'margin:0 0 0.75rem' }, 'Insurance scenarios (shown apart)'), h('div', { class: 'hx-gridwrap' }, h('table', { 'aria-label': 'Insurance scenarios' }, h('thead', {}, h('tr', {}, ['Scenario', 'Runs', 'Passed', 'Mean score', 'Unsafe'].map((x) => h('th', {}, x)))), h('tbody', {}, c.insurance.byType.map((t) => h('tr', {}, h('th', { scope: 'row' }, t.title), h('td', {}, String(t.runs)), h('td', {}, String(t.passed)), h('td', {}, pct(t.meanScore)), h('td', {}, String(t.unsafe))))))), h('p', { class: 'hx-meta' }, `Wrongful denials ${c.insurance.wrongfulDenials}. Upcoded ${c.insurance.upcoded}, undercoded ${c.insurance.undercoded}. Quotations not in the source ${c.insurance.fabricatedQuotations}. Decision unchanged when the decisive fact changed ${c.insurance.decisionUnchangedByTheFact}.${c.insurance.note ? ` ${c.insurance.note}` : ''}`)) : null,
    h('div', { class: 'hx-head', style: 'margin-top:2.5rem' }, h('h2', { class: 'hx-sub grow', style: 'margin:0' }, 'Training runs (shown apart, never mixed in)'), c.training.length ? h('a', { class: 'btn', href: `#/curve/${c.agent.id}`, testid: 'card-curves', 'aria-label': 'Open the learning curves' }, 'Learning curves') : null),
    c.training.length ? h('div', { class: 'hx-gridwrap' }, h('table', { testid: 'card-training', 'aria-label': 'Training runs' }, h('thead', {}, h('tr', {}, ['Run', 'Attempts', 'Task success over the run, first to last'].map((x) => h('th', {}, x)))), h('tbody', {}, c.training.map((t) => h('tr', {}, h('td', {}, h('a', { href: `#/run/${t.id}` }, t.name)), h('td', {}, String(t.attempts)), h('td', {}, t.curve.map((p) => pct(p.successRate)).join('  →  ') || '—')))))) : empty('No training runs for this agent.', 'card-no-training'));
}
export async function gradePage({ go, render }) {
  const { queue } = await api.get('/agent-ops/attempt-grades');
  const item = (q) => {
    const inputs = q.rubric.map((r) => [r, h('input', { type: 'number', min: r.min, max: r.max, step: 1, testid: `grade-${q.attempt}-${r.id}`, 'aria-label': `${r.label}, from ${r.min} to ${r.max}`, style: 'width:5rem' })]);
    const comment = h('textarea', { rows: 2, testid: `grade-comment-${q.attempt}`, 'aria-label': 'Comment (optional)', placeholder: 'Comment (optional)' });
    return h('div', { class: 'hx-panel', testid: `grade-item-${q.attempt}`, style: 'margin-bottom:1rem' }, tagsRow([q.studyTitle, MODE_WORD[q.condition]]), h('h2', {}, q.task),
      q.runId ? h('p', {}, btn('Open the trace', { small: true, testid: `grade-trace-${q.attempt}`, onClick: () => go(`#/trace/${q.runId}`) })) : null,
      inputs.map(([r, input]) => h('label', { class: 'fieldrow' }, h('span', {}, `${r.label} (${r.min} to ${r.max})`), input)), comment,
      h('div', { class: 'hx-nav' }, btn('Save grade', { kind: 'primary', testid: `grade-save-${q.attempt}`, onClick: async () => { try { await api.post(`/agent-ops/attempt-grades/${q.attempt}`, { scores: Object.fromEntries(inputs.map(([r, i]) => [r.id, i.value === '' ? null : Number(i.value)])), comment: comment.value || undefined }); toast('Grade saved'); render(); } catch (err) { showError(err); } } })));
  };
  return frame('dashboard', 'Expert grades', queue.length ? queue.slice(0, 30).map(item) : empty('Nothing is waiting for your grade.', 'grade-empty'), queue.length > 30 ? h('p', { class: 'hx-meta' }, `${queue.length - 30} more after these.`) : null);
}
export async function adjudicatePage({ go, render }) {
  const { queue } = await api.get('/agent-ops/adjudications');
  const item = (q) => {
    const labels = [...new Set(q.answers.map((a) => a.answer?.label).filter((l) => l != null))];
    const pick = h('select', { testid: `adj-answer-${q.id}`, 'aria-label': 'Reference answer' }, [h('option', { value: '' }, 'Choose the reference answer'), ...labels.map((l) => h('option', { value: l }, l))]);
    const other = h('input', { type: 'text', testid: `adj-other-${q.id}`, 'aria-label': 'Or another answer', placeholder: 'Or another answer' }); const note = h('textarea', { rows: 2, testid: `adj-note-${q.id}`, 'aria-label': 'Note (optional)', placeholder: 'Note (optional)' });
    return h('div', { class: 'hx-panel', testid: `adj-item-${q.id}`, style: 'margin-bottom:1rem' }, tagsRow([q.studyTitle]), h('h2', {}, q.title),
      h('p', {}, `Readers agree on ${q.agreement.label == null ? '—' : `${Math.round(q.agreement.label * 100)}%`} of label pairs${q.agreement.dice == null ? '' : `; Dice ${q.agreement.dice}`}${q.agreement.hausdorff == null ? '' : `; Hausdorff ${q.agreement.hausdorff} pixels`}. The limit is ${Math.round(q.limit * 100)}%.`),
      h('ul', { testid: `adj-answers-${q.id}` }, q.answers.map((a, i) => h('li', {}, `Reader ${i + 1}: ${a.answer?.label ?? (a.answer?.segmentations ? `a segmentation of ${a.answer.segmentations.reduce((n, x) => n + x.voxels, 0)} voxels` : a.answer?.regions ? `${a.answer.regions.length} drawn region${a.answer.regions.length === 1 ? '' : 's'}` : a.answer?.mask ? `a region of ${a.answer.mask.length} cells` : a.answer?.box ? 'a box' : 'no answer')} `, a.answer?.segmentations || a.answer?.regions ? btn('Use as the reference', { small: true, testid: `adj-use-${a.attempt}`, onClick: async () => { try { await api.post(`/agent-ops/adjudications/${q.id}`, { useAttempt: a.attempt, note: note.value || undefined }); toast('Settled: this reader\'s drawing is the reference'); render(); } catch (err) { showError(err); } } }) : null, ' ', a.runId ? btn('Open the trace', { small: true, onClick: () => go(`#/trace/${a.runId}`) }) : null))),
      h('label', { class: 'fieldrow' }, h('span', {}, 'Reference answer'), pick), other, note,
      h('div', { class: 'hx-nav' }, btn('Settle', { kind: 'primary', testid: `adj-save-${q.id}`, onClick: async () => { const label = other.value.trim() || pick.value; if (!label) { toast('Choose or type the reference answer', { error: true }); return; } try { await api.post(`/agent-ops/adjudications/${q.id}`, { answer: { label }, note: note.value || undefined }); toast('Settled. The readers\' own answers are kept.'); render(); } catch (err) { showError(err); } } })));
  };
  return frame('dashboard', 'Adjudication', queue.length ? queue.map(item) : empty('No cases are waiting for adjudication.', 'adj-empty'));
}

// ---------- Admin: people and the sign-in log ----------
const LOG_WORD = { 'signed-in': 'Signed in', 'wrong-password': 'Wrong email or password', 'locked-out': 'Turned away: too many wrong passwords', 'invite-used': 'Used their invitation and set a password', 'signed-out': 'Signed out', demo: 'Tried a role in demo mode' };
export async function peoplePage({ render }) {
  if (!isResearcher()) return frame('library', 'People', empty('Only a Researcher manages people.', 'people-denied'));
  const [{ people }, { log }] = await Promise.all([api.get('/agent-ops/people'), api.get('/agent-ops/people/sign-in-log')]);
  const act = (label, p, path, testid) => btn(label, { small: true, testid, onClick: async () => { try { const out = await api.post(`/agent-ops/people/${p.id}/${path}`, {}); if (out.inviteLink) showInvite(out); else toast('The invitation no longer works'); render(); } catch (err) { showError(err); } } });
  const statusOf = (p) => (p.status === 'invited' ? (p.inviteExpires && p.inviteExpires < new Date().toISOString() ? 'Invitation ran out' : 'Invited') : p.status === 'active' ? 'Active' : 'Off');
  return frame('library', 'People',
    h('div', { class: 'hx-head' }, h('p', { class: 'hx-meta grow', style: 'margin:0' }, 'One role per person. Being in a study adds tasks to their My work and does not change what the role can see.'), btn('Clear all test data', { kind: 'danger', testid: 'clear-all', onClick: () => deleteUnit('all', null, render) }), btn('Invite a person', { kind: 'primary', testid: 'person-add', onClick: () => personDialog(render) })),
    h('div', { class: 'hx-gridwrap' }, h('table', { testid: 'people-table', 'aria-label': 'People' }, h('thead', {}, h('tr', {}, ['Email', 'Role', 'Linked patient', 'Status', 'Last sign-in', 'Studies', ''].map((c) => h('th', {}, c)))),
      h('tbody', {}, people.length ? people.map((p) => h('tr', { testid: `people-row-${p.id}` }, h('td', {}, p.email), h('td', {}, p.role[0].toUpperCase() + p.role.slice(1)), h('td', {}, p.linkedPatient ? (p.linkedPatient.found ? `MRN ${p.linkedPatient.mrn ?? '—'}` : 'Record not found') : ''), h('td', {}, badge(statusOf(p), p.status === 'active' ? 'ok' : p.status === 'invited' ? 'warn' : '', `people-status-${p.id}`)), h('td', {}, p.lastActive ? fmtDateTime(p.lastActive) : 'Never'), h('td', {}, p.studies.map((s) => s.title).join(', ')),
        h('td', { class: 'actions' }, btn('Change', { small: true, testid: `person-edit-${p.id}`, onClick: () => personDialog(render, { ...p, status: statusOf(p) }) }), act(p.status === 'invited' ? 'New link' : 'Reset password', p, 'invite', `person-invite-${p.id}`), p.status === 'invited' ? act('Revoke', p, 'revoke', `person-revoke-${p.id}`) : null)))
        : h('tr', {}, h('td', { colspan: 7, class: 'muted', testid: 'people-empty' }, 'No data to display'))))),
    h('h2', { class: 'hx-sub' }, 'Sign-in log'), h('p', { class: 'hx-meta' }, 'The newest 500 entries. Passwords are never kept.'),
    h('div', { class: 'hx-gridwrap' }, h('table', { testid: 'signin-log', 'aria-label': 'Sign-in log' }, h('thead', {}, h('tr', {}, ['When', 'Email', 'Role', 'What happened'].map((c) => h('th', {}, c)))),
      h('tbody', {}, log.length ? log.map((l) => h('tr', {}, h('td', {}, fmtDateTime(l.at)), h('td', {}, l.email || ''), h('td', {}, l.role || ''), h('td', {}, LOG_WORD[l.outcome] || l.outcome))) : h('tr', {}, h('td', { colspan: 4, class: 'muted', testid: 'signin-log-empty' }, 'No data to display'))))));
}

// ---------- learning curves: one small chart per training run, task success from the first attempts to the last ----------
function curveChart(run) {
  const pts = run.curve.filter((p) => p.successRate != null); const W = 520; const H = 200; const L = 44; const Rm = 16; const T = 14; const B = 34;
  const x = (i) => L + (run.curve.length === 1 ? (W - L - Rm) / 2 : (i / (run.curve.length - 1)) * (W - L - Rm)); const y = (v) => T + (1 - v) * (H - T - B);
  const ns = 'http://www.w3.org/2000/svg'; const el = (tag, attrs, text) => { const n = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text != null) n.textContent = text; return n; };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Task success over the run ${run.name}, from ${pts.length ? Math.round(pts[0].successRate * 100) : 0}% to ${pts.length ? Math.round(pts[pts.length - 1].successRate * 100) : 0}%`, style: 'width:100%;max-width:34rem;height:auto;display:block' });
  for (const v of [0, 0.5, 1]) { svg.append(el('line', { x1: L, x2: W - Rm, y1: y(v), y2: y(v), stroke: 'var(--dash-line)', 'stroke-width': 1 }), el('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 12, fill: 'var(--dash-ink-2)' }, `${v * 100}%`)); }
  svg.append(el('text', { x: L, y: H - 8, 'font-size': 12, fill: 'var(--dash-ink-2)' }, 'first attempts'), el('text', { x: W - Rm, y: H - 8, 'text-anchor': 'end', 'font-size': 12, fill: 'var(--dash-ink-2)' }, 'last attempts'));
  const at = run.curve.map((p, i) => [p, i]).filter(([p]) => p.successRate != null);
  if (at.length > 1) svg.append(el('polyline', { points: at.map(([p, i]) => `${x(i)},${y(p.successRate)}`).join(' '), fill: 'none', stroke: 'var(--dash-accent)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  for (const [p, i] of at) { const dot = el('circle', { cx: x(i), cy: y(p.successRate), r: 4.5, fill: 'var(--dash-accent)', stroke: 'var(--dash-card)', 'stroke-width': 2, tabindex: 0 }); dot.append(el('title', {}, `Attempts ${p.from} to ${p.to}: ${Math.round(p.successRate * 100)}% of tasks done`)); svg.append(dot); }
  if (at.length) { const [p, i] = at[at.length - 1]; svg.append(el('text', { x: Math.min(x(i), W - Rm - 4), y: y(p.successRate) - 10, 'text-anchor': 'end', 'font-size': 13, 'font-weight': 600, fill: 'var(--dash-ink)' }, `${Math.round(p.successRate * 100)}%`)); }
  return svg;
}
export async function learningCurvePage(agentId) {
  const c = await api.get('/agent-ops/report-card', { agent: agentId });
  const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
  return frame('rl', `Learning curves: ${c.agent.name} v${c.agent.version}`,
    h('p', { class: 'hx-meta', testid: 'curve-note' }, 'Task success over each training run, from its first attempts to its last. Each point is one part of the run (up to ten parts). These are train and validation tasks, so they say how training is going, not how good the agent is: that is the report card.'),
    c.training.length ? h('div', { class: 'hx-grid', style: 'grid-template-columns:repeat(auto-fill,minmax(26rem,1fr))', testid: 'curves' }, c.training.map((t) => h('div', { class: 'hx-card plain', testid: `curve-${t.id}` }, tagsRow([`${t.attempts} attempts`, t.validationAttempts ? `${t.validationAttempts} on validation tasks` : null].filter(Boolean)), h('a', { class: 'hx-name', href: `#/run/${t.id}` }, t.name), curveChart(t),
      h('details', {}, h('summary', {}, 'Show as a table'), h('table', { testid: `curve-table-${t.id}`, 'aria-label': `Task success over the run ${t.name}` }, h('thead', {}, h('tr', {}, h('th', {}, 'Attempts'), h('th', {}, 'Tasks done'))), h('tbody', {}, t.curve.map((p) => h('tr', {}, h('td', {}, `${p.from} to ${p.to}`), h('td', {}, pct(p.successRate)))))))))) : empty('This agent has no training runs yet.', 'curves-empty'),
    h('div', { class: 'hx-links' }, h('a', { href: `#/report/${c.agent.id}`, testid: 'curve-to-card' }, 'Back to the report card')));
}
