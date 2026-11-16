// The Agent panel (plan-master task 9.2): a collapsible panel on the right of
// every hospital app while an agent run is open. The clinician asks questions
// here and answers the agent's requests. Agent text is untrusted: it is only
// ever set as text, never as HTML, and nothing in it can trigger an action.
import { h, btn, badge, toast, askReason, formDialog, fmtTime } from '/shared/ui.js';
import { api, view } from '/shared/fhir.js';
import { patientContext } from '/shared/context.js';

const KEY = 'hd.panel.open';
const STYLE = `
.agent-panel { position: fixed; top: 0; right: 0; bottom: 0; width: 21.25rem; max-width: 92vw; background: var(--surface); border-left: 1px solid var(--line); box-shadow: -0.375rem 0 1.125rem rgba(0,0,0,.12); z-index: 60; display: flex; flex-direction: column; font-size: 1.0625rem; }
.agent-panel[hidden] { display: none; }
.agent-panel .ap-head { display: flex; align-items: center; gap: 0.375rem; padding: 0.5rem 0.625rem; border-bottom: 1px solid var(--line); background: var(--surface-2); }
.agent-panel .ap-head strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-panel .ap-body { flex: 1; min-height: 0; overflow: auto; padding: 0.625rem; display: flex; flex-direction: column; gap: 0.5rem; }
.agent-panel .ap-msg { padding: 0.5rem 0.625rem; border-radius: 0.625rem; max-width: 95%; white-space: pre-wrap; word-break: break-word; }
.agent-panel .ap-msg.clinician { align-self: flex-end; background: var(--accent-soft); color: var(--on-accent-soft, var(--ink)); }
.agent-panel .ap-msg.agent { align-self: flex-start; background: var(--surface-2); border: 1px solid var(--line); }
.agent-panel .ap-msg .ap-meta { display: block; font-size: 0.9375rem; color: var(--ink-3); margin-bottom: 0.125rem; }
.agent-panel .ap-cite { display: inline-block; margin: 0.25rem 0.25rem 0 0; font-family: var(--mono); font-size: 0.9375rem; padding: 1px 0.375rem; border-radius: 62.4375rem; border: 1px solid var(--line); color: var(--ink-2); }
.agent-panel .ap-request { border: 1px solid var(--warn, #c98a00); border-radius: 0.625rem; padding: 0.5rem 0.625rem; background: var(--surface); }
.agent-panel .ap-request .ap-actions { display: flex; flex-wrap: wrap; gap: 0.375rem; margin-top: 0.5rem; }
.agent-panel .ap-foot { border-top: 1px solid var(--line); padding: 0.5rem 0.625rem; display: flex; flex-direction: column; gap: 0.375rem; }
.agent-panel .ap-foot .row { display: flex; gap: 0.375rem; }
.agent-panel .ap-foot textarea { flex: 1; min-height: 2.375rem; resize: vertical; }
.agent-panel .ap-controls { display: flex; gap: 0.375rem; padding: 0.375rem 0.625rem; border-bottom: 1px solid var(--line); }
.agent-panel-toggle { position: fixed; right: 0; top: 50%; transform: translateY(-50%); z-index: 59; writing-mode: vertical-rl; padding: 0.625rem 0.375rem; border-radius: 0.5rem 0 0 0.5rem; border: 1px solid var(--line); border-right: none; background: var(--surface-2); color: var(--ink); cursor: pointer; }
.agent-panel-toggle[hidden] { display: none; }
.agent-panel-toggle .n { display: inline-block; background: var(--danger, #c0392b); color: #fff; border-radius: 62.4375rem; padding: 0 0.3125rem; margin-top: 0.375rem; writing-mode: horizontal-tb; font-size: 0.9375rem; }
@media (max-width: 700px) { .agent-panel { width: 100vw; } }
`;

export function mountAgentPanel({ app }) {
  if (app === 'agent-ops' || !document.body) return null;
  if (!document.getElementById('agent-panel-style')) document.head.append(h('style', { id: 'agent-panel-style' }, STYLE));
  const state = { runs: [], run: null, picked: null, detail: null, open: false, seen: new Set(), timer: null };
  try { state.open = localStorage.getItem(KEY) === '1'; } catch { /* ignore */ }

  const toggle = h('button', { type: 'button', class: 'agent-panel-toggle', testid: 'agent-panel-toggle', 'aria-label': 'Open or close the Agent panel', hidden: true, onClick: () => { state.open = !state.open; try { localStorage.setItem(KEY, state.open ? '1' : '0'); } catch { /* ignore */ } draw(); } }, 'Agent panel');
  const body = h('div', { class: 'ap-body', testid: 'panel-messages', 'aria-live': 'polite' });
  const title = h('strong', { testid: 'panel-title' }, 'Agent');
  const status = badge('', '', 'panel-status');
  const runPick = h('select', { testid: 'panel-run', 'aria-label': 'Which run the panel shows', style: 'width:auto;max-width:8.75rem', onChange: (e) => { state.picked = e.target.value; state.run = state.runs.find((r) => r.id === e.target.value) || null; load(); } });
  const question = h('textarea', { testid: 'panel-question', 'aria-label': 'Ask the agent a question about this chart', placeholder: 'Ask about this chart, for example "How has the creatinine changed this week?"', rows: 2 });
  const guidance = h('textarea', { testid: 'panel-guidance', 'aria-label': 'Guidance for the agent', placeholder: 'Guidance for the agent (optional)', rows: 1 });
  const call = async (op, payload = {}) => { if (!state.run) return null; try { const out = await api.post(`/agent-ops/panel/${state.run.id}/${op}`, payload); await load(); return out; } catch (err) { toast(err.message || String(err), { error: true }); return null; } };
  const send = btn('Send', { kind: 'primary', small: true, testid: 'panel-send', onClick: async () => { const text = question.value.trim(); if (!text) return; question.value = ''; await call('ask', { text }); } });
  const guide = btn('Give guidance', { small: true, testid: 'panel-guide', onClick: async () => { const text = guidance.value.trim(); if (!text) return; guidance.value = ''; await call('message', { text, kind: 'guidance' }); toast('Guidance sent to the agent'); } });
  const pause = btn('Pause', { small: true, testid: 'panel-pause', onClick: async () => { const paused = state.run?.status === 'paused'; await call('pause', { paused: !paused }); } });
  const takeOver = btn('Take over', { small: true, testid: 'panel-takeover', onClick: async () => { const out = await call('take-over', {}); if (out) toast('You have taken over. The agent has stopped.'); } });
  const stop = btn('Stop', { small: true, kind: 'danger', testid: 'panel-stop', onClick: async () => { const out = await call('stop', {}); if (out) toast('The agent run was stopped.'); } });
  const close = h('button', { type: 'button', class: 'small', testid: 'panel-close', 'aria-label': 'Close the Agent panel', onClick: () => { state.open = false; try { localStorage.setItem(KEY, '0'); } catch { /* ignore */ } draw(); } }, '✕');
  const panel = h('aside', { class: 'agent-panel', testid: 'agent-panel', 'aria-label': 'Agent panel', hidden: true },
    h('div', { class: 'ap-head' }, title, status, runPick, close),
    h('div', { class: 'ap-controls' }, pause, takeOver, stop),
    body,
    h('div', { class: 'ap-foot' }, h('div', { class: 'row' }, question, send), h('div', { class: 'row' }, guidance, guide),
      h('p', { class: 'muted small', style: 'margin:0' }, 'The agent drafts; you decide. Nothing it writes is final until you sign, send or place it.')));
  document.body.append(toggle, panel);

  const requestCard = (m) => {
    const label = m.kind === 'permission' ? 'Asks permission' : m.kind === 'question' ? 'Asks you a question' : m.kind === 'low-confidence' ? 'Is not confident' : 'Is stuck';
    const action = m.action && typeof m.action === 'object' ? h('div', { class: 'mono small', style: 'margin-top:0.25rem;white-space:pre-wrap', testid: `panel-action-${m.id}` }, `Exact action: ${m.action.type || ''} ${m.action.label || ''}${m.action.details ? ` — ${String(m.action.details).slice(0, 200)}` : ''}`) : null;
    const answerBtn = btn('Answer', { small: true, testid: `panel-answer-${m.id}`, onClick: () => formDialog({ title: 'Answer the agent', testid: 'panel-answer-form', submitLabel: 'Send answer', fields: [{ name: 'text', label: 'Your answer', type: 'textarea', rows: 3, required: true, testid: 'panel-answer-text', wide: true }], onSubmit: async (v) => { await call('decide', { request: m.id, decision: 'answer', text: v.text }); } }) });
    return h('div', { class: 'ap-request', testid: `panel-request-${m.id}`, role: 'group', 'aria-label': `Agent request: ${label}` },
      h('span', { class: 'ap-meta' }, `${label} · ${fmtTime(m.at)}${m.expiresAt ? ` · waits until ${fmtTime(m.expiresAt)}` : ''}`),
      h('div', {}, m.text), action,
      h('div', { class: 'ap-actions' },
        m.kind === 'permission' ? btn('Approve', { kind: 'primary', small: true, testid: `panel-approve-${m.id}`, onClick: () => call('decide', { request: m.id, decision: 'approve' }) }) : null,
        btn('Deny', { small: true, kind: 'danger', testid: `panel-deny-${m.id}`, onClick: async () => { const reason = await askReason({ title: 'Deny this request', label: 'Reason (required)', submitLabel: 'Deny', testid: 'panel-deny-reason' }); if (reason) await call('decide', { request: m.id, decision: 'deny', reason }); } }),
        m.kind !== 'permission' ? answerBtn : null,
        btn('Guidance', { small: true, testid: `panel-guidance-${m.id}`, onClick: () => formDialog({ title: 'Guidance for the agent', testid: 'panel-guidance-form', submitLabel: 'Send guidance', fields: [{ name: 'text', label: 'Guidance', type: 'textarea', rows: 3, required: true, testid: 'panel-guidance-text', wide: true }], onSubmit: async (v) => { await call('decide', { request: m.id, decision: 'guidance', text: v.text }); } }) })));
  };

  function draw() {
    const any = state.runs.length > 0;
    const waiting = state.runs.reduce((a, r) => a + (r.waiting || 0), 0);
    toggle.hidden = !any || state.open;
    toggle.replaceChildren('Agent panel', waiting ? h('span', { class: 'n', testid: 'panel-waiting-count' }, String(waiting)) : '');
    panel.hidden = !(any && state.open);
    if (panel.hidden) return;
    const run = state.run;
    title.textContent = run ? `${run.agentId || 'Agent'} · ${run.goal || run.mode}` : 'Agent';
    status.textContent = run ? run.status : '';
    pause.textContent = run?.status === 'paused' ? 'Resume' : 'Pause';
    runPick.replaceChildren(...state.runs.map((r) => h('option', { value: r.id, selected: r.id === run?.id }, `${r.agentId || 'run'} ${r.startedAt ? fmtTime(r.startedAt) : ''}`)));
    runPick.hidden = state.runs.length < 2;
    const d = state.detail;
    body.replaceChildren(...(!d ? [h('p', { class: 'muted' }, 'Loading…')] : d.conversation.length ? d.conversation.map((m) => (m.type === 'panel.request' && m.status === 'waiting') ? requestCard(m)
      : h('div', { class: `ap-msg ${m.from}`, testid: `panel-msg-${m.id}` }, h('span', { class: 'ap-meta' }, `${m.from === 'agent' ? (run?.agentId || 'Agent') : 'You'} · ${m.kind}${m.status && m.type === 'panel.request' ? ` · ${m.status}` : ''} · ${fmtTime(m.at)}`), m.text || '', ...(m.cites || []).map((c, i) => h('span', { class: 'ap-cite', testid: `panel-cite-${m.id}-${i}` }, c))))
      : [h('p', { class: 'muted', testid: 'panel-empty' }, run?.endedAt ? 'This run has ended.' : 'No messages yet. Ask a question below, or wait for the agent.')]));
    body.scrollTop = body.scrollHeight;
  }

  async function load() {
    if (document.hidden) return;
    const patient = patientContext.get() ? `Patient/${patientContext.get()}` : null;
    let runs = [];
    try { runs = (await api.get('/agent-ops/panel', patient ? { patient } : {})).runs; } catch { runs = []; }
    if (patient && !runs.length) { try { runs = (await api.get('/agent-ops/panel')).runs; } catch { runs = []; } }
    state.runs = runs;
    // The run the panel shows: the one the clinician picked, else one waiting for them, else the app's run, else the newest.
    state.run = (state.picked && runs.find((r) => r.id === state.picked)) || runs.find((r) => r.waiting) || runs.find((r) => r.id === (state.run?.id || view.runId)) || runs[0] || null;
    const waiting = runs.reduce((a, r) => a + (r.waiting || 0), 0);
    if (state.run) { try { state.detail = await api.get(`/agent-ops/panel/${state.run.id}`); state.run = { ...state.run, ...state.detail.run }; } catch { state.detail = null; } } else state.detail = null;
    for (const m of state.detail?.waiting || []) if (!state.seen.has(m.id)) { state.seen.add(m.id); toast(`The agent is waiting: ${m.text.slice(0, 80)}`); state.open = true; }
    try { localStorage.setItem('hd.panel.waiting', String(waiting)); } catch { /* ignore */ }
    draw();
  }
  load();
  state.timer = setInterval(load, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  return { load, open: () => { state.open = true; draw(); } };
}
