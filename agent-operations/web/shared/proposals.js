// AI proposal cards (§10): amber left border, "AI-drafted — not signed"
// watermark, "Show what the agent saw", and Accept / Edit / Reject. Used by
// PACS and the EHR Inbox. Nothing here writes clinical data directly: a
// decision is posted to the server, which writes and signs as the clinician.
import { h, btn, badge, toast, openDialog, formDialog, askReason, confirmDialog, fmtDateTime } from './ui.js';
import { api, view, identity } from './fhir.js';
import { reportProblemButton } from './report-problem.js';

const LABEL = { urgent: 'Urgent', routine: 'Routine', low: 'Low' };
const seen = new Set();

export async function loadProposals(params = {}) {
  try { return (await api.get('/agent-ops/proposals', params)).proposals; } catch { return []; }
}

function debrief(out) {
  if (!out.plantedError) return;
  const fell = out.decision === 'accepted';
  openDialog({
    title: 'This proposal was deliberately wrong', testid: 'planted-debrief',
    body: h('div', {}, h('p', {}, 'It was an automation-bias test on a practice copy of the chart. Nothing reached the live chart.'),
      h('p', { testid: 'planted-result' }, fell ? 'You accepted it unchanged.' : out.decision === 'edited' ? 'You changed it before signing.' : 'You rejected it.')),
  });
}

/** onDone(result) runs after any decision so the host page can reload. */
export function proposalCard(p, { onDone = () => {} } = {}) {
  const decide = async (body) => {
    const out = await api.post(`/agent-ops/proposals/${p.id}/decide`, body);
    toast(out.decision === 'rejected' ? 'Proposal rejected' : p.kind === 'report' ? 'Report signed by you' : 'Priority recorded');
    debrief(out);
    await onDone(out);
  };
  const body = [];
  if (p.kind === 'report') {
    for (const [key, label] of [['technique', 'Technique'], ['findings', 'Findings'], ['impression', 'Impression']]) {
      body.push(h('div', { class: 'p-label' }, label), h('p', { class: 'p-text', testid: `proposal-${key}-${p.id}` }, p.content[key] || ''));
    }
  } else if (p.kind === 'triage') {
    body.push(h('div', { class: 'p-label' }, 'Suggested priority'), h('p', { class: 'p-text' }, badge(LABEL[p.content.label] || p.content.label, p.content.label === 'urgent' ? 'warn' : 'info', `proposal-label-${p.id}`)),
      h('div', { class: 'p-label' }, 'Suggested reply'), h('p', { class: 'p-text', testid: `proposal-reply-${p.id}` }, p.content.reply || 'None'));
  } else {
    body.push(h('div', { class: 'p-label' }, `Proposed ${p.content.resource?.resourceType || 'record'}`), h('pre', { class: 'p-text mono', testid: `proposal-resource-${p.id}` }, JSON.stringify(p.content.resource, null, 1).slice(0, 1500)));
  }
  const sawList = h('div', { class: 'p-saw', hidden: true, testid: `proposal-saw-${p.id}` },
    h('div', { class: 'muted small' }, `Read at ${fmtDateTime(p.saw?.asOf)} on a private copy of the chart.`),
    (p.saw?.resources || []).length ? h('ul', {}, p.saw.resources.map((r) => h('li', {}, h('strong', {}, `${r.name}: `), r.summary))) : h('p', { class: 'muted' }, 'The agent did not read any other records.'));
  const sawToggle = h('button', { type: 'button', class: 'link', testid: `proposal-saw-toggle-${p.id}`, 'aria-label': 'Show what the agent saw', 'aria-expanded': 'false', onClick: () => {
    sawList.hidden = !sawList.hidden;
    sawToggle.textContent = sawList.hidden ? 'Show what the agent saw' : 'Hide what the agent saw';
    sawToggle.setAttribute('aria-expanded', String(!sawList.hidden));
  } }, 'Show what the agent saw');

  const actions = [];
  if (p.status === 'pending' && !view.readOnly) {
    actions.push(btn(p.kind === 'report' ? 'Accept and sign' : p.kind === 'triage' ? 'Accept and send reply' : 'Accept', { kind: 'primary', small: true, testid: `proposal-accept-${p.id}`, onClick: async () => {
      if (p.kind === 'report' && !await confirmDialog({ title: 'Sign this report?', message: `You are signing this AI-drafted report as ${identity.display}. Signing locks it and notifies the referring clinician.`, confirmLabel: 'Sign report', testid: 'proposal-sign' })) return;
      await decide({ decision: 'accept' });
    } }));
    actions.push(btn('Edit', { small: true, testid: `proposal-edit-${p.id}`, onClick: () => formDialog({
      title: p.kind === 'report' ? 'Edit, then sign' : 'Edit, then send', submitLabel: p.kind === 'report' ? 'Sign edited report' : 'Save and send', testid: 'proposal-edit-form', wide: true,
      intro: 'Your changes are recorded next to the original proposal.',
      fields: p.kind === 'report'
        ? [['technique', 'Technique', 3], ['findings', 'Findings', 6], ['impression', 'Impression', 3]].map(([name, label, rows]) => ({ name, label, type: 'textarea', rows, value: p.content[name] || '', wide: true, required: true }))
        : p.kind === 'triage'
          ? [{ name: 'label', label: 'Priority', type: 'select', value: p.content.label, options: Object.entries(LABEL) }, { name: 'reply', label: 'Reply to the patient (leave empty to send nothing)', type: 'textarea', rows: 5, value: p.content.reply || '', wide: true }]
          : [],
      onSubmit: (v) => decide({ decision: 'edit', content: v }),
    }) }));
    actions.push(btn('Reject', { small: true, kind: 'danger', testid: `proposal-reject-${p.id}`, onClick: async () => {
      const reason = await askReason({ title: 'Reject this proposal', label: 'Reason (required)', submitLabel: 'Reject', testid: 'proposal-reject-reason' });
      if (reason) await decide({ decision: 'reject', reason });
    } }));
  } else if (p.status !== 'pending') {
    actions.push(badge({ accepted: 'Accepted', edited: 'Edited and accepted', rejected: 'Rejected', withdrawn: 'Withdrawn', 'auto-applied': 'Applied without asking' }[p.status] || p.status, p.status === 'rejected' || p.status === 'withdrawn' ? 'danger' : 'ok', `proposal-status-${p.id}`));
  }

  if (p.status === 'pending' && !seen.has(p.id) && !view.readOnly) {
    seen.add(p.id);
    api.post(`/agent-ops/proposals/${p.id}/seen`, {}).catch(() => {});
  }
  return h('section', { class: 'card proposal', testid: `proposal-${p.id}`, 'aria-label': 'AI-drafted proposal, not signed' },
    h('div', { class: 'p-head' }, h('span', { class: 'p-mark', testid: `proposal-watermark-${p.id}` }, 'AI-drafted — not signed'), h('span', { class: 'muted small', style: 'flex:1' }, p.agent.label), reportProblemButton({ proposal: p.id, run: p.runId, branch: p.branch }, { patient: p.patient ? String(p.patient).split('/').pop() : null, testid: `proposal-report-problem-${p.id}` })),
    ...body,
    p.reasoning ? h('p', { class: 'muted small', testid: `proposal-why-${p.id}` }, `Why: ${p.reasoning}`) : null,
    p.confidence != null ? h('p', { class: 'muted small' }, `Agent confidence: ${Math.round(p.confidence * 100)}% (self-reported)`) : null,
    sawToggle, sawList, h('div', { class: 'toolbar', style: 'margin:0.625rem 0 0' }, ...actions));
}
