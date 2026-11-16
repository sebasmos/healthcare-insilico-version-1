// Agent Dashboard structure: Home with three cards,
// one page per mode, a study page with tabs, the Library and the top bar.
// The pages inside the tabs are the existing ones, passed in by app.js.
import { h, btn, formDialog, fmtDateTime, toast } from '/shared/ui.js';
import { api } from '/shared/fhir.js';
import { setCurrentStudy, currentStudyId } from '/shared/study.js';

const ICON = {
  evaluate: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  rl: 'M21 12a9 9 0 1 1-3-6.7M21 3v6h-6',
  annotate: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
};
export const MODES = {
  evaluate: { label: 'Evaluate Agent', text: 'All actions are logged. Choose a mode to see how the agent performs.', line: 'Shadow · Human in the loop · Red teaming', tint: '#A9B4E8', ink: '#2E3A80', tabs: ['setup', 'runs', 'review', 'results', 'export'] },
  rl: { label: 'Reinforcement Learning', text: 'Generate real training data to train and improve agents.', line: 'Evaluate · Train · Evaluate again', tint: '#A9D7E8', ink: '#0F4E61', tabs: ['setup', 'runs', 'review', 'results', 'export'] },
  annotate: { label: 'Data Annotation Mode', text: 'Record what a human does in the live hospital apps: tools, reasoning, images and dictation.', line: 'Record · Label · Review', tint: '#E4E7EE', ink: '#1F2430', tabs: ['setup', 'sessions', 'review', 'export'] },
};
export const TAB_LABEL = { setup: 'Setup', runs: 'Runs', sessions: 'Sessions', review: 'Review', results: 'Results', export: 'Export' };
export const LIBRARY = [['scenarios', 'Scenarios'], ['tasks', 'Tasks'], ['agents', 'Agents'], ['safety', 'Safety tests'], ['benchmarks', 'Benchmarks']];

// Study names for the breadcrumb, filled when a study or a study list loads.
const studyCache = new Map();
const remember = (s) => { if (s?.id) studyCache.set(s.id, { title: s.title, mode: MODES[s.mode] ? s.mode : 'evaluate' }); };
export const cachedStudy = (id) => studyCache.get(id) || null;

const svg = (d, stroke, size) => {
  const ns = 'http://www.w3.org/2000/svg';
  const el = document.createElementNS(ns, 'svg'); el.setAttribute('width', size); el.setAttribute('height', size); el.setAttribute('viewBox', '0 0 24 24'); el.setAttribute('fill', 'none'); el.setAttribute('stroke', stroke); el.setAttribute('stroke-width', '1.8'); el.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); el.append(p); return el;
};
const GEAR = 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z';

// The mockups' look: light grey page, white cards, the dashboard blue.
const CSS = `
body.dash { background: var(--dash-bg); }
:root { --dash-bg: #EEF0F4; --dash-ink: #1F2430; --dash-ink-2: #4A5160; --dash-ink-3: #7A8190; --dash-line: #D9DDE5; --dash-card: #FFFFFF; --dash-accent: #4A59B8; --dash-accent-ink: #2E3A80; --dash-head: #E4E7EE; --dash-stop: #F7313B; --dash-callout: #A9D7E8; --dash-callout-ink: #0F4E61; }
:root[data-theme="dark"] { --dash-bg: #14171e; --dash-ink: #e6e8ee; --dash-ink-2: #b4b9c6; --dash-ink-3: #8a90a0; --dash-line: #2c313c; --dash-card: #1c2029; --dash-head: #242935; --dash-callout: #173845; --dash-callout-ink: #b9e3f0; }
.dash-top { height: 3.5rem; background: var(--dash-card); border-bottom: 1px solid var(--dash-line); display: flex; align-items: center; gap: 1rem; padding: 0 1.75rem; position: sticky; top: 0; z-index: 40; }
.dash-top .title { font-weight: 600; font-size: 1.25rem; color: var(--dash-accent); text-decoration: none; }
.dash-top .lib { font-size: 1.0625rem; color: var(--dash-ink-2); text-decoration: none; }
.dash-top .lib[aria-current="page"] { color: var(--dash-accent); font-weight: 600; }
.dash-top .gear { width: 2.25rem; height: 2.25rem; border-radius: 0.5rem; border: 1px solid var(--dash-line); background: var(--dash-card); display: flex; align-items: center; justify-content: center; padding: 0; }
.dash-top .stop { height: 2.25rem; padding: 0 0.875rem; border-radius: 0.5rem; border: 0; background: var(--dash-stop); color: #FFFFFF; font-weight: 600; font-size: 1.125rem; }
.dash-top .stop:disabled { opacity: .55; }
.dash-main { max-width: 80rem; margin: 0 auto; padding: 2rem 1.75rem 3rem; color: var(--dash-ink); }
.dash-main.narrow { max-width: 60rem; }
.dash-main > .crumbs { position: static; background: none; border: 0; height: auto; padding: 0; margin: 0 0 1.5rem; gap: 0.5rem; font-size: 1.0625rem; color: var(--dash-ink-3); }
.dash-main > .crumbs button.back { width: 2rem; height: 2rem; border-radius: 0.5rem; background: var(--dash-card); border: 1px solid var(--dash-line); color: var(--dash-ink); }
.dash-main > .crumbs a { color: var(--dash-ink-2); text-decoration: none; }
.dash-main > .crumbs .here { color: var(--dash-ink); }
.dash-home { padding-top: 4.5rem; }
.dash-home h1 { margin: 0 0 0.5rem; font-size: 2.25rem; font-weight: 600; text-align: center; }
.dash-home > p { margin: 0 0 3rem; text-align: center; color: var(--dash-ink-2); font-size: 1.25rem; }
.dash-surv { display: block; background: var(--dash-card); border: 1px solid var(--dash-line); border-radius: 0.875rem; padding: 1rem 1.375rem; color: var(--dash-ink); text-decoration: none; font-size: 1.125rem; } .dash-surv strong { color: var(--dash-accent); } .dash-two { display: grid; grid-template-columns: repeat(auto-fit, minmax(24rem, 1fr)); gap: 1.125rem; align-items: start; }
.dash-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(17.5rem, 1fr)); gap: 1.5rem; }
.dash-card { aspect-ratio: 1 / 1; background: var(--dash-card); border: 1px solid var(--dash-line); border-radius: 1.25rem; padding: 2rem; display: flex; flex-direction: column; text-decoration: none; color: var(--dash-ink); transition: transform .12s; cursor: pointer; }
.dash-card:hover, .dash-card:focus-visible { transform: translateY(-0.1875rem); }
.dash-card .ico { width: 4.5rem; height: 4.5rem; border-radius: 1.125rem; display: flex; align-items: center; justify-content: center; margin-bottom: auto; }
.dash-card .t { font-size: 1.75rem; font-weight: 600; margin-bottom: 0.5rem; }
.dash-card .d { font-size: 1.1875rem; color: var(--dash-ink-2); line-height: 1.5; }
.dash-card .m { margin-top: 1rem; font-size: 1.0625rem; color: var(--dash-ink-3); }
.dash-h1 { margin: 0 0 0.375rem; font-size: 2rem; font-weight: 600; }
.dash-lead { margin: 0 0 1.75rem; color: var(--dash-ink-2); font-size: 1.1875rem; }
.dash-big { display: grid; grid-template-columns: repeat(auto-fit, minmax(16.25rem, 1fr)); gap: 1rem; margin-bottom: 2.5rem; }
.dash-big button { text-align: left; height: 7.5rem; border-radius: 1rem; border: 1px solid var(--dash-line); background: var(--dash-card); color: var(--dash-ink); padding: 1.375rem; font-family: inherit; display: flex; flex-direction: column; justify-content: space-between; cursor: pointer; }
.dash-big button.primary { border: 0; background: var(--dash-accent); color: #FFFFFF; }
.dash-big .g { font-size: 1.625rem; color: var(--dash-accent); }
.dash-big button.primary .g { font-size: 2rem; color: #FFFFFF; }
.dash-big .n { display: block; font-size: 1.375rem; font-weight: 600; }
.dash-big .s { font-size: 1.0625rem; color: var(--dash-ink-2); }
.dash-big button.primary .s { color: #FFFFFF; }
.dash-step { margin: 0 0 0.75rem; font-size: 1.1875rem; font-weight: 600; color: var(--dash-ink); }
.dash-pick { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: 0.875rem; margin-bottom: 1.75rem; }
.dash-pick button { white-space: normal; text-align: left; border-radius: 0.875rem; border: 1px solid var(--dash-line); background: var(--dash-card); color: var(--dash-ink); padding: 1.125rem; font-family: inherit; cursor: pointer; height: auto; }
.dash-pick button.on { border: 0.125rem solid var(--dash-accent); padding: 1.0625rem; }
.dash-pick .n { display: block; font-size: 1.25rem; font-weight: 600; margin-bottom: 0.375rem; }
.dash-pick .s { display: block; font-size: 1.0625rem; color: var(--dash-ink-2); line-height: 1.5; }
.dash-set { background: var(--dash-card); border: 1px solid var(--dash-line); border-radius: 0.875rem; padding: 1.375rem; display: grid; grid-template-columns: repeat(auto-fit, minmax(21.25rem, 1fr)); gap: 1.125rem; margin-bottom: 1rem; }
.dash-field { font-size: 1.0313rem; font-weight: 600; display: flex; flex-direction: column; gap: 0.375rem; color: var(--dash-ink); }
.dash-field select { height: 2.375rem; border-radius: 0.5rem; border: 1px solid var(--dash-line); padding: 0 0.625rem; font-family: inherit; width: 100%; }
.dash-inline { display: flex; gap: 0.5rem; align-items: center; }
.dash-inline select { flex: 1; }
.dash-inline button { height: 2.375rem; white-space: nowrap; }
.dash-start { background: var(--dash-callout); border-radius: 0.875rem; padding: 1.125rem 1.375rem; display: flex; align-items: center; gap: 1.125rem; flex-wrap: wrap; margin: 1rem 0; }
.dash-start > span { flex: 1; min-width: 16.25rem; font-size: 1.125rem; color: var(--dash-callout-ink); line-height: 1.5; }
.dash-start button { height: 3rem; padding: 0 1.75rem; border-radius: 0.625rem; font-size: 1.25rem; font-weight: 600; }
.dash-h2 { margin: 0 0 0.75rem; font-size: 1.0625rem; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--dash-ink-3); }
.dash-list { background: var(--dash-card); border: 1px solid var(--dash-line); border-radius: 0.875rem; overflow: hidden; }
.dash-list .row { display: grid; grid-template-columns: 2fr 1fr 1fr 5rem; gap: 0.75rem; padding: 1rem 1.125rem; border-top: 1px solid var(--dash-line); align-items: center; font-size: 1.125rem; color: var(--dash-ink-2); }
.dash-list .row.head { padding: 0.75rem 1.125rem; background: var(--dash-head); font-size: 1rem; font-weight: 500; border-top: 0; }
.dash-list .row b { font-weight: 600; color: var(--dash-ink); }
.dash-list .row .q { display: block; font-size: 1.0625rem; color: var(--dash-ink-3); }
.dash-list .empty { padding: 1.125rem; color: var(--dash-ink-3); font-size: 1.125rem; }
.dash-tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--dash-line); margin: 1.125rem 0 1.5rem; }
.dash-tabs button { height: 2.5rem; padding: 0 1rem; border: 0; border-bottom: 0.125rem solid transparent; background: none; color: var(--dash-ink-2); font-size: 1.125rem; font-weight: 500; font-family: inherit; cursor: pointer; margin-bottom: -1px; }
.dash-tabs button[aria-selected="true"] { color: var(--dash-accent); border-bottom-color: var(--dash-accent); }
.dash-sec { background: var(--dash-card); border: 1px solid var(--dash-line); border-radius: 0.875rem; padding: 1.375rem; margin-bottom: 1.125rem; }
.dash-sec h2 { margin: 0 0 0.75rem; font-size: 1.375rem; font-weight: 600; }
.stat { min-width: 6rem; } .stat-n { font-size: 1.625rem; font-weight: 600; line-height: 1.1; }
[data-testid="agents-table"] td:first-child, [data-testid="approvals-table"] td:first-child { min-width: 17rem; }
table.plain { border-collapse: collapse; margin: 0.5rem 0; } table.plain th, table.plain td { text-align: left; padding: 0.3125rem 0.875rem 0.3125rem 0; }
.dash-two { display: grid; grid-template-columns: repeat(auto-fit, minmax(23.75rem, 1fr)); gap: 1.125rem; align-items: start; }
.dash-radios { border: 0; padding: 0; margin: 0 0 0.875rem; display: flex; flex-wrap: wrap; gap: 0.5rem 1.125rem; align-items: center; }
.dash-radios legend { width: 100%; font-size: 1rem; font-weight: 600; color: var(--dash-ink-3); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 0.375rem; padding: 0; }
.dash-radios label { display: flex; gap: 0.375rem; align-items: center; font-size: 1.125rem; }
.dash-radios input { width: auto; height: auto; }
.dash-more { margin-top: 0.5rem; }
.dash-more > summary { cursor: pointer; color: var(--dash-ink-2); font-size: 1.0625rem; margin-bottom: 0.75rem; }
.dash-loop { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(12.5rem, 1fr)); gap: 0.75rem; }
.dash-loop li { border: 1px solid var(--dash-line); border-radius: 0.75rem; padding: 0.875rem; display: flex; flex-direction: column; gap: 0.375rem; align-items: flex-start; }
.dash-loop li.running { border-color: var(--dash-accent); }
.dash-chart .grid { stroke: var(--dash-line); stroke-width: 1; }
.dash-chart .tick { fill: var(--dash-ink-3); font-size: 0.9375rem; }
.dash-chart .label { fill: var(--dash-ink); font-size: 1rem; font-weight: 600; }
.dash-chart .line { fill: none; stroke: var(--dash-accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.dash-chart .dot { fill: var(--dash-accent); stroke: var(--dash-card); stroke-width: 2; }
.dash-chart .bar { fill: var(--dash-ink-3); }
.dash-fails { margin: 0; padding-left: 1.125rem; display: grid; gap: 0.5rem; }
.dash-counts { display: flex; gap: 1.5rem; margin: 0.625rem 0; }
.dash-count { display: flex; flex-direction: column; }
.dash-count b { font-size: 1.5rem; }
.dash-what { display: grid; grid-template-columns: 8.75rem 1fr; gap: 0.625rem 1rem; margin: 0 0 1.125rem; }
.dash-what dt { font-weight: 600; }
.dash-what dd { margin: 0; color: var(--dash-ink-2); }
.dash-consent { display: flex; gap: 0.625rem; align-items: flex-start; padding: 0.875rem; border: 1px solid var(--dash-line); border-radius: 0.75rem; margin-bottom: 0.875rem; }
.dash-consent input { width: auto; height: auto; margin-top: 0.1875rem; }
.dash-removal { margin-top: 0.75rem; font-size: 1.0625rem; }
.dash-removal ul { margin: 0.375rem 0 0; padding-left: 1.125rem; }
.dash-answer h2 { font-size: 1.25rem; }
.dash-output { white-space: pre-wrap; background: var(--dash-bg); border-radius: 0.5rem; padding: 0.625rem; margin: 0 0 0.625rem; font-size: 1.125rem; }
.dash-actions { margin: 0 0 0.5rem; padding-left: 1.25rem; font-size: 1.0625rem; color: var(--dash-ink-2); display: grid; gap: 0.25rem; }
.dash-choices { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.625rem; margin-top: 0.25rem; }
.dash-choice { height: 3.25rem; border-radius: 0.75rem; border: 1px solid var(--dash-line); background: var(--dash-card); color: var(--dash-ink); font-size: 1.1875rem; font-weight: 600; font-family: inherit; cursor: pointer; }
.dash-choice[aria-pressed="true"] { background: var(--dash-accent); border-color: var(--dash-accent); color: #FFFFFF; }
.dash-choice.unsafe { color: var(--dash-stop); }
.dash-choice.unsafe[aria-pressed="true"] { background: var(--dash-stop); border-color: var(--dash-stop); color: #FFFFFF; }
.dash-plus { width: 2rem; height: 2rem; border-radius: 0.5rem; border: 1px solid var(--dash-line); background: var(--dash-card); color: var(--dash-accent); font-size: 1.5rem; line-height: 1; padding: 0; }
`;
let styled = false;
export function useDashStyle() {
  if (styled) return; styled = true;
  document.head.append(h('style', { testid: 'dash-style' }, CSS));
  document.body.classList.add('dash');
}

/** The top bar from the mockups: title, Library, the Settings gear and the red Stop all agents. */
export function topBar({ route, switches, onStop, go, plain = false }) {
  if (plain) return h('header', { class: 'dash-top topbar', testid: 'dash-top' }, h('a', { class: 'title appname', href: '#/', testid: 'dash-home', 'aria-label': 'Agent Dashboard home' }, 'Agent Dashboard'));
  return h('header', { class: 'dash-top topbar', testid: 'dash-top' },
    h('a', { class: 'title appname', href: '#/', testid: 'dash-home', 'aria-label': 'Agent Dashboard home' }, 'Agent Dashboard'),
    h('span', { style: 'flex:1' }),
    h('button', { type: 'button', class: 'gear', testid: 'nav-settings', 'aria-label': 'Settings', title: 'Settings', 'aria-current': route === 'settings' ? 'page' : undefined, onClick: () => go('#/settings') }, svg(GEAR, 'currentColor', 18)),
    h('button', { type: 'button', class: 'stop', testid: 'stop-all-agents', 'aria-label': 'Stop all agents', title: `${switches.running} running`, disabled: switches.global.engaged, onClick: onStop }, 'Stop all agents'));
}

/** 1. Home: only the three cards. */
export function homePage(go) {
  const card = (id) => {
    const m = MODES[id];
    return h('a', { class: 'dash-card', href: `#/mode/${id}`, testid: `card-${id}`, 'aria-label': m.label, onClick: (e) => { e.preventDefault(); go(`#/mode/${id}`); } },
      h('div', { class: 'ico', style: `background:${m.tint}` }, svg(ICON[id], m.ink, 36)),
      h('span', { class: 't' }, m.label), h('span', { class: 'd' }, m.text), h('span', { class: 'm' }, m.line));
  };
  return h('div', { class: 'dash-home', testid: 'home-cards' }, h('h1', {}, 'What do you want to do?'), h('p', {}, 'Pick a mode. Everything you start is organised into a study.'),
    h('div', { class: 'dash-cards' }, card('evaluate'), card('rl'), card('annotate')),
    h('p', { style: 'margin-top:2rem' }, h('a', { href: '#/surveillance', class: 'dash-surv', testid: 'card-surveillance', 'aria-label': 'Surveillance and Reporting', onClick: (e) => { e.preventDefault(); go('#/surveillance'); } }, h('strong', {}, 'Surveillance and Reporting'), h('span', {}, ' Problems reported by people, found by automatic rules and reported by verifier agents, and the patterns they add up to.'))));
}

/** "Start a new study": name and research question, then the study opens. */
export function newStudy(mode, go) {
  formDialog({ title: 'Start a new study', testid: 'new-study', submitLabel: 'Start the study', intro: 'A study holds one research question and every run that answers it.',
    fields: [{ name: 'title', label: 'Name', required: true, testid: 'new-study-title' }, { name: 'question', label: 'Research question', type: 'textarea', rows: 3, wide: true, testid: 'new-study-question' }],
    onSubmit: async (v) => { const s = await api.post('/agent-ops/research/studies', { title: v.title, question: v.question, mode }); remember(s); setCurrentStudy(s.id); toast('Study started'); go(`#/study/${s.id}/setup`); } });
}

/** 2. A mode: start or continue a study, and the mode's studies, newest activity first. */
export async function modePage(mode, go) {
  const m = MODES[mode];
  const { studies } = await api.get('/agent-ops/research/studies', { mode });
  studies.forEach(remember);
  const active = studies.filter((s) => s.status !== 'archived');
  const open = (s) => { setCurrentStudy(s.id); go(`#/study/${s.id}/${MODES[mode].tabs[0]}`); };
  const cont = () => { const s = active.find((x) => x.id === currentStudyId()) || active[0]; if (s) open(s); else toast('No study to continue yet. Start a new one.'); };
  return h('div', { testid: `mode-${mode}` }, h('h1', { class: 'dash-h1' }, m.label), h('p', { class: 'dash-lead' }, 'A study holds one research question and every run that answers it.'),
    h('div', { class: 'dash-big' },
      h('button', { type: 'button', class: 'primary', testid: 'mode-new-study', 'aria-label': 'Start a new study', onClick: () => newStudy(mode, go) }, h('span', { class: 'g' }, '+'), h('span', {}, h('span', { class: 'n' }, 'Start a new study'), h('span', { class: 's' }, 'Name it and write the question'))),
      h('button', { type: 'button', testid: 'mode-continue', 'aria-label': 'Continue a study', onClick: cont }, h('span', { class: 'g' }, '→'), h('span', {}, h('span', { class: 'n' }, 'Continue a study'), h('span', { class: 's' }, 'Pick up where you left off')))),
    h('h2', { class: 'dash-h2' }, 'Your studies'),
    h('div', { class: 'dash-list', testid: 'mode-studies' }, h('div', { class: 'row head' }, h('span', {}, 'Study'), h('span', {}, 'Last activity'), h('span', {}, 'Runs'), h('span', {})),
      ...(studies.length ? studies.map((s) => h('div', { class: 'row', testid: `mode-study-${s.id}` },
        h('span', {}, h('b', {}, s.title), h('span', { class: 'q' }, s.question || 'No research question written.'), s.status === 'archived' ? h('span', { class: 'q' }, 'Archived') : null),
        h('span', {}, fmtDateTime(s.lastActivity)), h('span', { testid: `mode-study-runs-${s.id}` }, String(s.runs)),
        btn('Open', { small: true, testid: `study-open-${s.id}`, onClick: () => open(s) }))) : [h('div', { class: 'empty', testid: 'mode-studies-empty' }, 'No studies yet. Start a new one.')])));
}

/** 3. The study page: its title and tabs; the tab's content comes from the caller. */
export function studyFrame(study, tab, content, go) {
  remember(study);
  const mode = MODES[study.mode] ? study.mode : 'evaluate';
  return h('div', { testid: `study-${study.id}` }, h('h1', { class: 'dash-h1', testid: 'study-title' }, study.title),
    h('div', { class: 'dash-tabs', role: 'tablist', 'aria-label': 'Study sections' }, ...MODES[mode].tabs.map((t) => h('button', { type: 'button', role: 'tab', testid: `study-tab-${t}`, 'aria-label': TAB_LABEL[t], 'aria-selected': String(t === tab), onClick: () => go(`#/study/${study.id}/${t}`) }, TAB_LABEL[t]))),
    h('div', { role: 'tabpanel', testid: `study-panel-${tab}` }, content));
}

/** Library: Scenarios, Tasks, Agents, Safety tests, Benchmarks, each a list with a "+" to create. */
export function libraryFrame(section, content, onNew) {
  return h('div', { testid: `library-${section}` }, h('h1', { class: 'dash-h1' }, 'Library'), h('p', { class: 'dash-lead' }, 'What studies are built from. Patients and data are not part of the Library.'),
    h('div', { class: 'dash-tabs', role: 'tablist', 'aria-label': 'Library sections' }, ...LIBRARY.map(([id, label]) => h('button', { type: 'button', role: 'tab', testid: `library-tab-${id}`, 'aria-label': label, 'aria-selected': String(id === section), onClick: () => { location.hash = `#/library/${id}`; } }, label)),
      h('span', { style: 'flex:1' }), onNew ? h('button', { type: 'button', class: 'dash-plus', testid: `library-new-${section}`, 'aria-label': `New in ${LIBRARY.find(([id]) => id === section)[1]}`, title: 'Create', onClick: onNew }, '+') : null),
    h('div', { role: 'tabpanel' }, content));
}

/** The breadcrumb for the new screens (the shared bar calls this with the hash segments). */
export function crumbsFor(segments) {
  const [route, id, tab] = segments;
  // The front of the dashboard (home.js): the pill tabs are the way around, so the trail only says where you are.
  const FRONT = { s: [['Studies', '#/evaluate'], ['Study', `#/s/${id}`]], new: [[id === 'annotation' ? 'Data annotation' : 'Evaluate an agent', id === 'annotation' ? '#/annotate' : '#/evaluate'], ['New', `#/new/${id}`]], 'my-work': [['My work', '#/my-work']], 'time-machine': [['Time machine', '#/time-machine']], run: [['Reinforcement learning', '#/rl'], ['Run', `#/run/${id}`]], report: [['Library', '#/library'], ['Report card', `#/report/${id}`]], grade: [['Expert grades', '#/grade']], curve: [['Reinforcement learning', '#/rl'], ['Learning curves', `#/curve/${id}`]], people: [['Library', '#/library'], ['People', '#/people']], 'adjudicate-cases': [['Adjudication', '#/adjudicate-cases']], evaluate: id ? null : [['Evaluate an agent', '#/evaluate']], rl: id ? null : [['Reinforcement learning', '#/rl']], annotate: id ? null : [['Data annotation', '#/annotate']] };
  if (FRONT[route]) return FRONT[route];
  if (route === 'mode' && MODES[id]) return [[MODES[id].label, `#/mode/${id}`]];
  if (route === 'study' && id) {
    const s = cachedStudy(id); const mode = s?.mode || 'evaluate';
    const chain = [[MODES[mode].label, `#/mode/${mode}`], [s?.title || 'Study', `#/study/${id}/${MODES[mode].tabs[0]}`]];
    if (tab === 'review' && segments[3] === 'compare') chain.push(['Review', `#/study/${id}/review`], ['Compare two', `#/study/${id}/review/compare`]);
    return chain;
  }
  if (route === 'library') { const sec = LIBRARY.find(([x]) => x === (id || 'scenarios')); return [['Library', '#/library'], ...(id ? [[sec ? sec[1] : id, `#/library/${id}`]] : [])]; }
  if (route === 'settings') return [['Settings', '#/settings']];
  return null;
}
