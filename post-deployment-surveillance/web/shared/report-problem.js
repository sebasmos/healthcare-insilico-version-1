// "Report a problem": the same short form wherever an AI output is shown. Three things are required (what
// happened, whether it reached the patient, how severe); the rest is optional detail. The context (agent,
// version, run, steps, what the agent saw and wrote, what the person did with it, the subgroup keys) is
// attached by the server from `about`, so nobody has to type it. Patients get a plain-language form.
import { h, btn, toast, openDialog, showError } from './ui.js';
import { api } from './fhir.js';

let metaCache = null;
const meta = async () => { if (!metaCache) metaCache = await api.get('/api/surveillance/meta'); return metaCache; };
const SEVERITY_LABEL = { 'near-miss': 'Near miss (no harm, could have been)', none: 'None', mild: 'Mild', moderate: 'Moderate', severe: 'Severe', 'life-threatening': 'Life-threatening', death: 'Death' };
const select = (testid, label, options, value = '') => h('select', { testid, 'aria-label': label }, ...options.map(([v, t]) => h('option', { value: v, selected: v === value }, t)));
const row = (label, control) => h('label', { style: 'display:flex;flex-direction:column;gap:0.25rem;font-weight:600;margin:0.5rem 0' }, label, control);

/** about: { run, step, proposal, resource, agent, branch }. patient: id, when known. plain: the patient form. */
export async function reportProblemDialog(about = {}, { patient = null, plain = false, onFiled = null } = {}) {
  const m = await meta();
  const what = h('textarea', { rows: 4, testid: 'rp-what', 'aria-label': plain ? 'What happened?' : 'What happened', placeholder: plain ? 'Tell us in your own words' : 'What the AI did, and what was wrong with it' });
  let body; let collect;
  if (plain) {
    const choice = select('rp-choice', 'What happened?', [['', 'Choose one'], ...Object.entries(m.patientChoices)]); const effect = select('rp-effect', 'How did it affect you?', [['', 'Choose one'], ...Object.entries(m.patientEffects)]);
    body = h('div', {}, h('p', { class: 'muted' }, 'Tell the care team about a problem with something the computer assistant wrote or did. A person reads every report.'), row('What happened?', choice), row('Tell us more', what), row('How did it affect you?', effect));
    collect = () => ({ narrative: what.value.trim() || (choice.value ? m.patientChoices[choice.value] : ''), patientChoice: choice.value || undefined, patientEffect: effect.value || undefined });
  } else {
    const reached = select('rp-reached', 'Did it reach the patient?', [['', 'Choose one'], ...Object.entries(m.reached)]); const severity = select('rp-severity', 'Severity', [['', 'Choose one'], ...m.severities.map((s) => [s, SEVERITY_LABEL[s] || s])]);
    const harm = select('rp-harm', 'Kind of problem', [['', 'Not sure'], ...Object.entries(m.harms)]); const right = h('textarea', { rows: 2, testid: 'rp-right', 'aria-label': 'What the right action was' });
    const relied = select('rp-relied', 'Did you rely on it?', [['', 'Not said'], ['yes', 'Yes'], ['no', 'No']]); const next = h('textarea', { rows: 2, testid: 'rp-next', 'aria-label': 'What you did next' });
    const file = h('input', { type: 'file', testid: 'rp-file', 'aria-label': 'Attachment', accept: 'image/*,application/pdf,text/plain' });
    body = h('div', {}, row('What happened', what), h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:0 1rem' }, row('Did it reach the patient?', reached), row('Severity', severity)),
      h('details', { testid: 'rp-more' }, h('summary', { testid: 'rp-more-open', 'aria-label': 'Add detail (optional)' }, 'Add detail (optional)'), row('Kind of problem', harm), row('What was the right action?', right), row('Did you rely on it?', relied), row('What did you do next?', next), row('Attachment', file)),
      h('p', { class: 'muted small', testid: 'rp-context-note' }, 'The agent, its version, the run, its steps, what it saw and wrote, and what was done with it are attached for you.'));
    collect = async () => { const f = file.files?.[0]; const data = f ? await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = () => no(new Error('The file could not be read')); r.readAsDataURL(f); }) : null;
      return { narrative: what.value.trim(), reachedPatient: reached.value || undefined, severity: severity.value || undefined, harm: harm.value || undefined, rightAction: right.value.trim() || undefined, reliedOn: relied.value ? relied.value === 'yes' : undefined, whatNext: next.value.trim() || undefined, ...(data ? { attachments: [{ title: f.name, contentType: f.type, data }] } : {}) }; };
  }
  const error = h('div', { class: 'form-error', testid: 'rp-error', role: 'alert' });
  openDialog({ title: plain ? 'Tell us about a problem' : 'Report a problem', testid: 'report-problem', body: [body, error], actions: [{ label: 'Cancel', testid: 'rp-cancel', onClick: (c) => c() }, { label: 'Send report', kind: 'primary', testid: 'rp-send', onClick: async (close) => {
    try { const fields = await collect(); const made = await api.post('/api/surveillance/reports', { ...fields, about, ...(patient ? { patient } : {}) }); close(); toast(`Report ${made.caseId} sent. You can add to it later.`); onFiled?.(made); }
    catch (err) { error.textContent = err.message || 'The report could not be sent'; }
  } }] });
}
/** The button. Keeps to one line of small text so it fits on cards, rows and steps. */
export function reportProblemButton(about, { patient = null, plain = false, label = 'Report a problem', testid = 'report-problem-open', onFiled = null } = {}) {
  return btn(label, { small: true, testid, onClick: () => reportProblemDialog(about, { patient, plain, onFiled }).catch(showError) });
}
/** A reporter's own reports with their status, and a box to add information or answer a question. */
export async function myReports({ patient = null, plain = false } = {}) {
  const { reports } = await api.get('/api/surveillance/reports', { mine: 'true', ...(patient ? { patient } : {}) });
  if (!reports.length) return h('p', { class: 'muted', testid: 'my-reports-empty' }, plain ? 'You have not reported anything.' : 'No data to display');
  return h('div', { testid: 'my-reports' }, reports.map((r) => { const more = h('input', { type: 'text', testid: `my-report-more-${r.caseId}`, 'aria-label': `Add information to ${r.caseId}`, placeholder: 'Add information' });
    const question = [...r.followUps].reverse().find((f) => f.kind === 'question');
    return h('div', { class: 'card', style: 'margin:0.5rem 0', testid: `my-report-${r.caseId}` }, h('strong', {}, r.caseId), ' ', h('span', { class: 'badge', testid: `my-report-status-${r.caseId}` }, r.fixedIn ? `Fixed in version ${r.fixedIn}` : r.statusLabel), h('div', { class: 'muted small' }, r.narrative),
      question && r.status === 'needs-info' ? h('p', { testid: `my-report-question-${r.caseId}` }, h('strong', {}, 'The team asks: '), question.text) : null,
      h('div', { class: 'toolbar', style: 'margin:0.375rem 0 0' }, more, btn('Send', { small: true, testid: `my-report-send-${r.caseId}`, onClick: async () => { if (!more.value.trim()) return; try { await api.post(`/api/surveillance/reports/${r.id}/follow-up`, { text: more.value.trim() }); toast('Added to your report'); more.value = ''; } catch (err) { showError(err); } } }))); }));
}
