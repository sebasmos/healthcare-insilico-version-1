// Pharmacy: verification queue, review screen, dispense queue, label preview
// and ward view. Every write goes through /api/pharmacy, where the
// server applies the state machine, the role map and the log.
import { h, clear, btn, bornSpan, badge, toast, table, card, kv, formDialog, confirmDialog, askReason, initApp, timeStrip, fmtDateTime, fmtTime, slug } from '/shared/ui.js';
import { fhir, api, view, identity, display, lifecycle, ext } from '/shared/fhir.js';
import { patientContext } from '/shared/context.js';
import { loadProposals, proposalCard } from '/shared/proposals.js';

const root = document.getElementById('app');
const shell = await initApp({ app: 'pharmacy', crumbs: { app: 'Pharmacy', home: 'queue', names: { queue: 'Verification', dispense: 'Dispense', wards: 'Wards' } } });
const ui = { queue: 'my', setting: 'inpatient' };
let cleanup = () => {};
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
const me = () => identity.user || identity.role;
const NAV = [['queue', '☑ Verification'], ['dispense', '▤ Dispense'], ['wards', '▦ Wards']];
const PRIORITY = { stat: ['STAT', 'solid-danger'], urgent: ['Urgent', 'warn'], routine: ['Routine', 'info'] };
const ISSUE_LABEL = { allergy: 'Allergy', 'duplicate-therapy': 'Duplicate therapy', 'drug-interaction': 'Drug interaction', 'dose-range': 'Dose range', 'wrong-route': 'Wrong route' };
const STATE = { awaiting: ['Awaiting verification', 'warn'], queried: ['Awaiting prescriber', 'accent'], override: ['Given before verification: retrospective review', 'solid-danger'], verified: ['Verified', 'ok'], rejected: ['Rejected', 'danger'], ordered: ['Not yet sent to pharmacy', ''], none: ['No verification record', ''] };
const minutes = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`);
const prio = (p) => badge(PRIORITY[p]?.[0] || p, PRIORITY[p]?.[1] || '');
const stateBadge = (s, testid) => badge(STATE[s]?.[0] || s, STATE[s]?.[1] || '', testid);
const ageCell = (r) => h('span', { class: `elapsed${r.overTarget ? ' late' : ''}`, testid: `age-${r.id}` }, minutes(r.ageMinutes), r.overTarget ? ' (over target)' : '');
const doseText = (r) => [r.dose ? `${r.dose.value} ${r.dose.unit}` : null, r.route, r.frequency].filter(Boolean).join(' · ') || r.sig;

function topbar(active) {
  return h('div', { class: 'topbar' }, h('span', { class: 'appname' }, 'Pharmacy'), h('span', { class: 'dot' }, '·'),
    h('nav', { 'aria-label': 'Pharmacy sections' }, NAV.map(([id, label]) => h('a', { href: `#/${id}`, testid: `nav-${id}`, 'aria-label': label.slice(2), 'aria-current': active === id ? 'page' : undefined }, label))),
    h('span', { class: 'spacer' }), shell.themeToggle, shell.roleSelect);
}
const page = (title, actions, ...children) => h('main', { class: 'content' }, h('div', { class: 'page-head' }, h('h1', {}, title), actions), ...children);
const mount = (active, content) => clear(root).append(...[topbar(active), timeStrip(), content].filter(Boolean));

function metricsStrip(m) {
  const mean = (p) => (m.byPriority[p].meanMinutes == null ? '—' : `${m.byPriority[p].meanMinutes} min`);
  return h('div', { class: 'metrics', testid: 'metrics' },
    h('span', {}, 'Verified today ', h('b', { testid: 'metric-verified' }, m.verifiedToday)),
    ...['stat', 'urgent', 'routine'].map((p) => h('span', {}, `Mean turnaround ${PRIORITY[p][0]} `, h('b', { testid: `metric-mean-${p}` }, mean(p)), h('span', { class: 'muted' }, ` (target ${m.byPriority[p].target} min)`))),
    h('span', {}, 'Within target ', h('b', { testid: 'metric-target' }, m.withinTargetPercent == null ? '—' : `${m.withinTargetPercent}%`)),
    h('span', {}, 'Interventions ', h('b', { testid: 'metric-interventions' }, m.interventions.total), h('span', { class: 'muted' }, ` (${m.interventions.changed} changed, ${m.interventions.rejected} rejected, ${m.interventions.queried} queried)`)));
}

// ---------- Verification queue ----------
async function openOrder(r) {
  try {
    await api.post(`/api/pharmacy/orders/${r.id}/open`, {});
  } catch (err) {
    if (err.status !== 423) throw err;
    const lock = err.body?.lock || r.lock || {};
    const ok = await confirmDialog({ title: 'Being reviewed by someone else', message: `${lock.by} opened this order at ${lock.at ? fmtTime(lock.at) : '?'}. Take it over?`, confirmLabel: 'Take over', testid: 'take-over' });
    if (!ok) return;
    await api.post(`/api/pharmacy/orders/${r.id}/open`, { force: true });
  }
  go(`#/review/${r.id}`);
}

async function queue() {
  let data = await api.get('/api/pharmacy/queue', { queue: ui.queue });
  const box = h('div');
  const draw = () => {
    const seg = h('div', { class: 'seg' }, [['my', 'My queue', data.counts.my], ['all', 'All', data.counts.all]].map(([id, label, count]) => h('button', { type: 'button', testid: `queue-${id}`, 'aria-label': `Show ${label}`, 'aria-pressed': String(ui.queue === id), onClick: async () => { ui.queue = id; data = await api.get('/api/pharmacy/queue', { queue: id }); draw(); } }, `${label} (${count})`)));
    clear(box).append(metricsStrip(data.metrics), h('div', { class: 'toolbar' }, seg, h('span', { class: 'muted small' }, 'STAT first, then urgent, then routine; oldest first. Targets: 15 min STAT, 30 urgent, 60 routine.')),
      table({ testid: 'queue-table', rows: data.rows, empty: 'No medication orders are waiting for verification.', onRow: openOrder, columns: [
        { label: 'Priority', render: (r) => [prio(r.priority), r.override ? [' ', badge('Given before verification: retrospective review', 'solid-danger', `override-${r.id}`)] : null] },
        { label: 'Patient', render: (r) => [h('strong', {}, r.patient?.name || ''), h('div', { class: 'muted small' }, `${r.patient?.mrn || ''} · ${r.patient?.unit || ''}`)] },
        { label: 'Medication', render: (r) => h('strong', {}, r.medication) }, { label: 'Dose / route / frequency', render: doseText },
        { label: 'Prescriber', render: (r) => r.prescriber }, { label: 'Age', cls: 'num', render: ageCell }, { label: 'Target', cls: 'num', render: (r) => `${r.targetMinutes} min` },
        { label: 'Status', render: (r) => [stateBadge(r.state, `state-${r.id}`), r.lock ? h('div', { class: 'muted small', testid: `lock-${r.id}` }, `Opened by ${r.lock.by}`) : null, r.pendingCosign ? h('div', { class: 'muted small' }, `${r.orderMode} order, needs co-signature`) : null] },
        { label: '', cls: 'actions', render: (r) => btn('Open', { small: true, kind: 'primary', testid: `open-${r.id}`, title: `Open ${r.medication} for ${r.patient?.name || 'patient'}`, onClick: () => openOrder(r) }) },
      ] }));
  };
  draw();
  const timer = setInterval(async () => { try { data = await api.get('/api/pharmacy/queue', { queue: ui.queue }); draw(); } catch { /* next tick */ } }, 30000);
  cleanup = () => clearInterval(timer);
  mount('queue', page('Verification queue', null, box));
}

// ---------- Review ----------
const reasoningField = { name: 'reasoning', label: 'Your reasoning (recorded in the log)', type: 'textarea', rows: 3, required: true, wide: true, testid: 'decision-reasoning' };
const needReasoning = (v) => { if ((v.reasoning || '').trim().length < 3) throw new Error('Type your reasoning (at least 3 characters)'); };

async function review(id) {
  const d = await api.get(`/api/pharmacy/orders/${id}/review`);
  if (d.patient) patientContext.set(d.patient.id);
  const proposals = (await loadProposals({ status: 'pending' })).filter((p) => p.patient === `Patient/${d.patient?.id}`);
  const r = d.row;
  const order = d.order;
  const decide = async (body, message) => { await api.post(`/api/pharmacy/orders/${id}/decision`, body); toast(message); go('#/queue'); };
  const open = d.state === 'awaiting' || d.state === 'override' || d.state === 'queried';
  const lockedByOther = d.lock && d.lock.by !== me();
  const perm = ['MedicationRequest', 'verify'];
  const actions = open ? h('div', { class: 'toolbar', testid: 'decision-bar' },
    btn('Verify', { kind: 'primary', write: true, perm, testid: 'review-verify', onClick: () => formDialog({ title: `Verify ${r.medication}`, testid: 'verify-form', submitLabel: 'Verify', intro: 'The order becomes active and can be dispensed and given.', fields: [reasoningField], onSubmit: async (v) => { needReasoning(v); await decide({ decision: 'verify', reasoning: v.reasoning }, 'Order verified'); } }) }),
    btn('Verify with change', { write: true, perm, testid: 'review-verify-change', onClick: () => formDialog({ title: `Verify ${r.medication} with a change`, testid: 'change-form', submitLabel: 'Verify with change', intro: 'The prescriber is told in their Inbox. Leave a field empty to keep it.', fields: [
      { name: 'dose', label: 'Dose', type: 'number', step: 'any', min: 0, value: r.dose?.value ?? '' }, { name: 'unit', label: 'Unit', type: 'select', value: r.dose?.unit || 'mg', options: ['mg', 'g', 'mcg', 'units', 'mEq', 'tablet', 'puffs', 'mL'] },
      { name: 'route', label: 'Route', type: 'select', value: r.route || 'oral', options: ['oral', 'intravenous', 'subcutaneous', 'intramuscular', 'inhaled', 'topical'] }, { name: 'frequency', label: 'Frequency', type: 'select', value: r.frequency || 'daily', options: ['daily', 'BID', 'TID', 'QID', 'nightly', 'Q4H', 'Q6H', 'Q8H', 'PRN', 'once'] },
      reasoningField,
    ], onSubmit: async (v) => { needReasoning(v); const change = {}; if (v.dose != null && v.dose !== r.dose?.value) change.dose = v.dose; if (v.unit !== r.dose?.unit) change.unit = v.unit; if (v.route !== r.route) change.route = v.route; if (v.frequency !== r.frequency) change.frequency = v.frequency; if (!Object.keys(change).length) throw new Error('Change at least one field, or use Verify'); await decide({ decision: 'verify-with-change', reasoning: v.reasoning, change }, 'Order verified with a change; the prescriber is notified'); } }) }),
    btn('Reject', { kind: 'danger', write: true, perm, testid: 'review-reject', onClick: () => formDialog({ title: `Reject ${r.medication}`, testid: 'reject-form', submitLabel: 'Reject', fields: [{ name: 'reason', label: 'Reason shown to the prescriber', required: true, wide: true, testid: 'reject-reason' }, reasoningField], onSubmit: async (v) => { needReasoning(v); if (v.reason.length < 3) throw new Error('Type a reason'); await decide({ decision: 'reject', reasoning: v.reasoning, reason: v.reason }, 'Order rejected; the prescriber is notified'); } }) }),
    d.state === 'queried' ? badge('Waiting for the prescriber\'s answer', 'accent', 'review-waiting') : btn('Query prescriber', { write: true, perm, testid: 'review-query', onClick: () => formDialog({ title: `Ask ${r.prescriber || 'the prescriber'} about ${r.medication}`, testid: 'query-form', submitLabel: 'Send question', intro: 'The order waits in the queue until the prescriber answers from the EHR.', fields: [{ name: 'message', label: 'Question', type: 'textarea', rows: 3, required: true, wide: true, testid: 'query-message' }, reasoningField], onSubmit: async (v) => { needReasoning(v); if (v.message.length < 3) throw new Error('Type a question'); await decide({ decision: 'query', reasoning: v.reasoning, message: v.message }, 'Question sent; the order waits'); } }) }),
    btn('Back to queue', { testid: 'review-back', onClick: async () => { try { await api.post(`/api/pharmacy/orders/${id}/close`, {}); } catch { /* nothing to release */ } go('#/queue'); } }),
  ) : h('div', { class: 'toolbar' }, stateBadge(d.state, 'review-state'), d.verified ? h('span', { class: 'muted small' }, `by ${d.verified.by} at ${fmtDateTime(d.verified.at)}`) : null, d.note ? h('span', { class: 'muted small' }, `Reasoning: ${d.note}`) : null, d.rejection ? h('span', { class: 'small', style: 'color:var(--danger)' }, `Reason: ${d.rejection}`) : null, btn('Back to queue', { testid: 'review-back', onClick: () => go('#/queue') }));

  const issues = d.issues.length ? d.issues.map((i) => h('div', { class: `issue issue-${i.severity}`, testid: `issue-${i.code}${i.unsaved ? '' : `-${i.id}`}` }, badge(ISSUE_LABEL[i.code] || i.code, i.severity === 'high' ? 'danger' : i.severity === 'moderate' ? 'warn' : ''), ' ', badge(i.severity, ''), ' ', i.status === 'final' ? badge(`closed: ${i.mitigation || ''}`, 'ok') : badge('open', 'warn'), h('div', { class: 'small', style: 'margin-top:0.25rem' }, i.detail))) : h('p', { class: 'muted', testid: 'issues-none' }, 'No automatic check fired.');
  const thread = h('div', { class: 'thread', testid: 'thread' }, d.thread.length ? d.thread.map((c) => h('div', { class: `msg${c.category?.[0]?.coding?.[0]?.code === 'pharmacy-answer' ? ' answer' : ''}` }, h('div', { class: 'muted small' }, `${c.sender?.display || ''} · ${fmtDateTime(c.sent)}`), c.payload?.[0]?.contentString || '')) : h('p', { class: 'muted' }, 'No questions yet.'));
  const lab = (o, name) => (o ? [name, h('span', {}, `${o.value} ${o.unit}`, o.flag && o.flag !== 'N' ? [' ', badge(o.flag, o.flag.length === 2 ? 'solid-danger' : 'danger')] : null, h('span', { class: 'muted small' }, ` · ${fmtDateTime(o.at)}${o.status === 'preliminary' ? ' · preliminary' : ''}`))] : [name, h('span', { class: 'muted' }, 'Not on file')]);
  const left = h('div', { class: 'stack' },
    card('Order', kv([['Medication', h('strong', {}, r.medication)], ['Code', h('span', { class: 'mono' }, `RxNorm ${r.code || ''}`)], ['Dose / route / frequency', doseText(r)], ['Sig', r.sig], ['Priority', prio(r.priority)], ['Prescriber', r.prescriber], ['Ordered', fmtDateTime(r.authoredOn)], ['Waiting', ageCell(r)], ['Status', stateBadge(d.state, 'review-state-badge')], ['Setting', `${d.setting}${d.encounter ? ` · ${d.encounter.unit}` : ''}`],
      r.pendingCosign ? ['Order mode', `${r.orderMode} order, needs a physician co-signature`] : null]),
      d.override ? h('div', { class: 'banner danger', testid: 'review-override' }, h('strong', {}, 'Given before verification: retrospective review'), `${d.override.by} at ${fmtDateTime(d.override.at)}: ${d.override.reason}`) : null,
      lockedByOther ? h('div', { class: 'banner warn', testid: 'review-locked' }, `Being reviewed by ${d.lock.by} since ${fmtTime(d.lock.at)}. `, btn('Take over', { small: true, testid: 'take-over-review', onClick: async () => { await api.post(`/api/pharmacy/orders/${id}/open`, { force: true }); render(); } })) : null,
      ext(order, 'urn:hospital-desktop:allergy-override-reason') ? h('div', { class: 'banner warn', testid: 'review-allergy-override' }, `Prescriber's allergy override: ${ext(order, 'urn:hospital-desktop:allergy-override-reason')}`) : null,
      actions),
    card('Automatic checks', issues, h('p', { class: 'muted small', testid: 'tables-note' }, d.tables.note)),
    card('Questions to the prescriber', thread),
    proposals.length ? h('div', { testid: 'review-proposals' }, h('h3', {}, 'Agent proposals for this patient'), proposals.map((p) => proposalCard(p, { onDone: render }))) : null,
    d.notices.length ? card('Notices sent', table({ testid: 'notices', rows: d.notices, columns: [{ label: 'When', render: (t) => fmtDateTime(t.authoredOn) }, { label: 'To', render: (t) => t.owner?.display || '' }, { label: 'What', render: (t) => t.description || '' }, { label: 'Status', render: (t) => badge(t.status, t.status === 'completed' ? 'ok' : 'accent') }] })) : null);
  const right = h('div', { class: 'stack' },
    card('Patient', kv([['Name', h('strong', { testid: 'review-patient' }, d.patient?.name || '')], ['MRN', h('span', { class: 'mono' }, d.patient?.mrn || '')], ['Age, sex', `${d.age ?? '?'} y, ${d.patient?.gender || '?'}`], ['Unit', d.encounter?.unit || 'No unit assigned']])),
    card('Allergies', d.allergies.length ? h('ul', { testid: 'review-allergies' }, d.allergies.map((a) => h('li', {}, display(a.code), a.criticality === 'high' ? ' (high)' : '', a.reaction?.[0]?.manifestation?.[0]?.coding?.[0]?.display ? ` · ${a.reaction[0].manifestation[0].coding[0].display}` : ''))) : h('p', { class: 'muted' }, 'None recorded')),
    card('Current medications', table({ testid: 'review-meds', rows: d.currentMeds, empty: 'No other medication orders', columns: [{ label: 'Medication', render: (m) => display(m.medicationCodeableConcept) }, { label: 'Sig', render: (m) => m.dosageInstruction?.[0]?.text || '' }, { label: 'State', render: (m) => badge(lifecycle(m), lifecycle(m) === 'active' ? 'ok' : 'warn') }] })),
    card('Weight and renal function', kv([lab(d.weight, 'Weight'), lab(d.creatinine, 'Creatinine'), ['eGFR', d.egfr ? h('span', { testid: 'review-egfr' }, `${d.egfr.value} ${d.egfr.unit}`, h('span', { class: 'muted small' }, ` · ${d.egfr.formula}`)) : h('span', { class: 'muted' }, 'No creatinine on file')]])),
    card('Relevant labs', kv([lab(d.labs.potassium, 'Potassium'), lab(d.labs.inr, 'INR'), lab(d.labs.glucose, 'Glucose')])));
  mount('queue', page(`Review: ${r.medication}`, null, h('div', { class: 'review' }, left, right)));
}

// ---------- Dispense ----------
async function dispense() {
  let data = await api.get('/api/pharmacy/dispense', { setting: ui.setting });
  const box = h('div');
  const reload = async () => { data = await api.get('/api/pharmacy/dispense', { setting: ui.setting }); draw(); };
  const start = (r) => formDialog({ title: `Start dispense: ${r.medication}`, testid: 'dispense-form', submitLabel: 'Start', intro: r.controlled ? 'Controlled drug: a second checker is needed before it is completed.' : undefined, fields: [
    { name: 'quantity', label: 'Quantity', type: 'number', step: 'any', min: 0 }, { name: 'daysSupply', label: 'Days supply (optional)', type: 'number', min: 0 }, { name: 'lot', label: 'Lot number', wide: true },
  ], onSubmit: async (v) => { await api.post('/api/pharmacy/dispense', { orderId: r.id, quantity: v.quantity ?? undefined, daysSupply: v.daysSupply ?? undefined, lot: v.lot }); undefined; await reload(); } });
  const complete = (r) => formDialog({ title: `Fill and complete: ${r.medication}`, testid: 'complete-form', submitLabel: 'Complete', intro: r.controlled ? 'Controlled drug: name the second checker (a different person from the one filling).' : undefined, fields: [
    { name: 'lot', label: 'Lot number', value: r.lot || '', required: true }, { name: 'expiry', label: 'Expiry (YYYY-MM)', value: r.expiry || '', required: true, placeholder: '2027-03' },
    { name: 'quantity', label: 'Quantity', type: 'number', step: 'any', min: 0, value: r.quantity?.value ?? '' }, { name: 'checkedBy', label: r.controlled ? 'Second checker (required)' : 'Checked by (optional)', required: r.controlled },
  ], onSubmit: async (v) => { await api.post(`/api/pharmacy/dispenses/${r.id}/complete`, { lot: v.lot, expiry: v.expiry, quantity: v.quantity ?? undefined, checkedBy: v.checkedBy }); toast('Dispense completed'); await reload(); } });
  const stop = (r) => async () => { const reason = await askReason({ title: `Cancel dispense: ${r.medication}`, submitLabel: 'Cancel dispense', testid: 'dispense-cancel-reason' }); if (!reason) return; await fhir.transition({ resourceType: 'MedicationDispense', id: r.id }, 'cancelled', reason); toast('Dispense cancelled'); await reload(); };
  const patientCell = (r) => [h('strong', {}, r.patient?.name || ''), h('div', { class: 'muted small' }, `${r.patient?.mrn || ''} · ${r.patient?.unit || ''}`)];
  function draw() {
    const seg = h('div', { class: 'seg' }, [['inpatient', 'Inpatients'], ['all', 'All verified orders']].map(([id, label]) => h('button', { type: 'button', testid: `dispense-${id}`, 'aria-label': `Show ${label}`, 'aria-pressed': String(ui.setting === id), onClick: async () => { ui.setting = id; await reload(); } }, label)));
    clear(box).append(h('div', { class: 'toolbar' }, seg),
      h('h3', {}, 'To fill'), table({ testid: 'dispense-table', rows: data.toFill, empty: 'Nothing to fill: every verified order has a dispense.', columns: [
        { label: 'Priority', render: (r) => prio(r.priority) }, { label: 'Patient', render: patientCell }, { label: 'Medication', render: (r) => [h('strong', {}, r.medication), r.controlled ? [' ', badge('Controlled', 'danger', `controlled-${r.id}`)] : null] },
        { label: 'Sig', render: (r) => r.sig }, { label: 'Verified', render: (r) => `${r.verified?.by || ''} · ${fmtDateTime(r.verified?.at)}` },
        { label: '', cls: 'actions', render: (r) => btn('Start dispense', { small: true, kind: 'primary', write: true, perm: ['MedicationDispense', 'create'], testid: `dispense-start-${r.id}`, onClick: () => start(r) }) },
      ] }),
      h('h3', { style: 'margin-top:1.25rem' }, 'In progress'), table({ testid: 'inprogress-table', rows: data.inProgress, empty: 'No dispense in progress', columns: [
        { label: 'Status', render: (r) => badge(r.status, 'warn') }, { label: 'Patient', render: patientCell }, { label: 'Medication', render: (r) => [h('strong', {}, r.medication), r.controlled ? [' ', badge('Controlled', 'danger')] : null] },
        { label: 'Lot / expiry', render: (r) => `${r.lot || '—'} / ${r.expiry || '—'}` }, { label: 'Filled by', render: (r) => r.filledBy || '' }, { label: 'Waiting', cls: 'num', render: (r) => minutes(r.ageMinutes) },
        { label: '', cls: 'actions', render: (r) => [btn('Fill and complete', { small: true, kind: 'primary', write: true, perm: ['MedicationDispense', 'transition'], testid: `dispense-complete-${r.id}`, onClick: () => complete(r) }), btn('Cancel', { small: true, kind: 'danger', write: true, perm: ['MedicationDispense', 'transition'], testid: `dispense-cancel-${r.id}`, onClick: stop(r) })] },
      ] }),
      h('h3', { style: 'margin-top:1.25rem' }, 'Completed recently'), table({ testid: 'recent-table', rows: data.recent, empty: 'Nothing completed yet', columns: [
        { label: 'Completed', render: (r) => fmtDateTime(r.handedOverAt) }, { label: 'Patient', render: patientCell }, { label: 'Medication', render: (r) => r.medication }, { label: 'Lot / expiry', render: (r) => `${r.lot || '—'} / ${r.expiry || '—'}` },
        { label: 'Filled / checked', render: (r) => `${r.filledBy || ''} / ${r.checkedBy || '—'}` },
        { label: '', cls: 'actions', render: (r) => btn('Label preview', { small: true, testid: `label-${r.id}`, onClick: () => go(`#/label/${r.id}`) }) },
      ] }));
  }
  draw();
  mount('dispense', page('Dispense queue', null, box));
}

async function label(id) {
  const d = await api.get(`/api/pharmacy/dispenses/${id}/label`);
  const sheet = h('div', { class: 'label-sheet', testid: 'label-page' },
    h('div', { class: 'big' }, d.patient?.name || ''), h('div', {}, `MRN ${d.patient?.mrn || ''} · Born `, d.patient ? bornSpan(d.patient) : ''), h('div', { class: 'muted' }, d.patient?.unit || ''),
    h('hr'), h('div', { class: 'big' }, d.medication), h('div', {}, `${d.dose ? `${d.dose.value} ${d.dose.unit}` : ''} ${d.routeText || ''} ${d.frequencyText || ''}`.trim()), h('div', {}, d.sig),
    h('div', {}, `Quantity: ${d.quantity ? `${d.quantity.value} ${d.quantity.unit}` : '—'}${d.daysSupply ? ` · ${d.daysSupply.value} days` : ''}`),
    h('div', {}, `Lot ${d.lot || '—'} · Expires ${d.expiry || '—'}`), h('div', {}, `Filled by ${d.filledBy || '—'} / checked by ${d.checkedBy || '—'}`), h('div', {}, `Prescriber ${d.prescriber || '—'} · Dispensed ${fmtDateTime(d.handedOverAt)}`));
  mount('dispense', page('Label preview', btn('Back to dispense queue', { testid: 'label-back', onClick: () => go('#/dispense') }), h('p', { class: 'muted small', testid: 'label-note' }, 'Preview only. Nothing is printed in this simulation.'), sheet));
}

async function wards() {
  const d = await api.get('/api/pharmacy/wards');
  const units = d.units.length ? d.units.map((u) => card(`${u.unit} (${u.count})`, table({ testid: `ward-${slug(u.unit)}`, rows: u.rows, columns: [
    { label: 'Dispensed', render: (r) => fmtDateTime(r.handedOverAt) }, { label: 'Patient', render: (r) => [h('strong', {}, r.patient?.name || ''), h('div', { class: 'muted small' }, r.patient?.mrn || '')] }, { label: 'Medication', render: (r) => r.medication }, { label: 'Sig', render: (r) => r.sig },
    { label: 'Lot / expiry', render: (r) => `${r.lot || '—'} / ${r.expiry || '—'}` }, { label: 'Given', render: (r) => badge(r.given ? 'Given' : 'Not yet given', r.given ? 'ok' : 'warn') },
  ] }))) : h('div', { class: 'card empty', testid: 'wards-empty' }, 'Nothing has been dispensed to a ward yet.');
  mount('wards', page('Ward view', null, h('p', { class: 'muted small' }, 'Dispensed and not yet given, by unit. The medication administration record will mark doses as given.'), h('div', { class: 'stack', testid: 'wards' }, units)));
}

// ---------- Router ----------
let token = 0;
async function render() {
  const mine = token += 1;
  cleanup(); cleanup = () => {};
  const [path] = (location.hash.slice(2) || 'queue').split('?');
  const [route, id] = path.split('/');
  try {
    if (route === 'review' && id) await review(id);
    else if (route === 'dispense') await dispense();
    else if (route === 'label' && id) await label(id);
    else if (route === 'wards') await wards();
    else await queue();
  } catch (err) {
    if (mine !== token) return;
    mount(route, page('Could not load this screen', btn('Retry', { testid: 'retry', onClick: render }), h('div', { class: 'banner danger', testid: 'load-error' }, err.message)));
  }
}
window.addEventListener('hashchange', render);
window.addEventListener('hd:role', render);
window.addEventListener('pagehide', () => cleanup());
view.onChange(render);
if (!location.hash) history.replaceState(null, '', '#/queue');
render();
