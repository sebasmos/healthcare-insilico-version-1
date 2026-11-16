// In-place AI drafts (plan-master task 9.1): the deployed pattern. A draft
// appears where the clinician already works; their normal action approves
// it. Every draft shown, used, edited, discarded, and every thumbs up or
// down is logged. Draft text is untrusted and only ever rendered as text.
import { h, btn, badge, askReason } from '/shared/ui.js';
import { api } from '/shared/fhir.js';
import { reportProblemButton } from './report-problem.js';

export const CHECK_MARK = '[Check this]';

/** Logs what the clinician did with a draft. Never throws; the UI must not depend on the log. */
export function draftEvent(draft, event, extra = {}) {
  return api.post('/agent-ops/drafts/events', { draft, event, ...extra }).catch(() => null);
}

/** Thumbs up or down on a draft, logged, one vote per card. */
export function thumbs(draftId, { onVote = () => {} } = {}) {
  const wrap = h('span', { class: 'thumbs', role: 'group', 'aria-label': 'Was this draft useful?' });
  const vote = (which) => async () => { await draftEvent(draftId, which === 'up' ? 'thumbs-up' : 'thumbs-down'); wrap.replaceChildren(badge(which === 'up' ? 'Thanks: useful' : 'Thanks: not useful', '', `draft-voted-${draftId}`)); onVote(which); };
  wrap.append(btn('👍', { small: true, testid: `draft-up-${draftId}`, title: 'Useful', onClick: vote('up') }), btn('👎', { small: true, testid: `draft-down-${draftId}`, title: 'Not useful', onClick: vote('down') }));
  wrap.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-label', i ? 'Thumbs down: this draft was not useful' : 'Thumbs up: this draft was useful'));
  return wrap;
}

/** Renders draft text with "Check this" parts highlighted. The text is split, never parsed as HTML. */
export function checkThis(text, testid = null) {
  const parts = String(text || '').split(CHECK_MARK);
  const out = h('div', { class: 'draft-text', ...(testid ? { testid } : {}), style: 'white-space:pre-wrap' });
  parts.forEach((part, i) => {
    if (i > 0) out.append(h('mark', { class: 'check-this', title: 'The agent was unsure here. Check it.', 'aria-label': 'Check this' }, 'Check this'));
    out.append(part);
  });
  return out;
}
export const stripCheckMarks = (text) => String(text || '').split(CHECK_MARK).join('').replace(/[ \t]+\n/g, '\n').trim();
export const countCheckMarks = (text) => String(text || '').split(CHECK_MARK).length - 1;

/** The head of every in-place draft card: the watermark, the agent, and the thumbs. */
export function draftHead(p, label = 'AI draft') {
  return h('div', { class: 'p-head', style: 'display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap' },
    h('span', { class: 'p-mark', testid: `draft-watermark-${p.id}` }, `${label} — not signed`),
    h('span', { class: 'muted small', style: 'flex:1' }, p.agent ? (p.agent.label || p.agent.id || 'Agent') : ''),
    thumbs(p.id), reportProblemButton({ proposal: p.id, run: p.runId, branch: p.branch }, { patient: p.patient ? String(p.patient).split('/').pop() : null, testid: `draft-report-problem-${p.id}` }));
}

/** Decide on a draft (the proposal API): accept, edit (with content) or discard (reason required). */
export async function decideDraft(p, decision, { content = null, reason = null } = {}) {
  const body = { decision };
  if (decision === 'edit') body.content = content;
  if (decision === 'reject') body.reason = reason;
  return api.post(`/agent-ops/proposals/${p.id}/decide`, body);
}
export async function discardDraft(p, { title = 'Discard this draft', askWhy = false } = {}) {
  const reason = askWhy ? await askReason({ title, label: 'Why? (a short reason)', submitLabel: 'Discard', testid: 'draft-discard-reason' }) : 'Discarded by the clinician';
  if (!reason) return null;
  await draftEvent(p.id, 'discarded', { why: askWhy ? reason : undefined });
  return decideDraft(p, 'reject', { reason });
}
/** Edit distance in characters, so the log can say how much the clinician changed. */
export function editSize(a, b) {
  const x = String(a || ''); const y = String(b || '');
  if (x === y) return 0;
  const prev = new Array(y.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= x.length; i += 1) { let last = prev[0]; prev[0] = i; for (let j = 1; j <= y.length; j += 1) { const tmp = prev[j]; prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (x[i - 1] === y[j - 1] ? 0 : 1)); last = tmp; } }
  return prev[y.length];
}
/** The recording settings that affect drafts: ask why after an override. Read once per page. */
let settings = null;
export async function draftSettings() {
  if (settings) return settings;
  try { settings = (await api.get('/agent-ops/capture/policy')) || {}; } catch { settings = {}; }
  return settings;
}
