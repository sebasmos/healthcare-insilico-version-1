// Patient portal. Shows only what has been released to the patient: final
// results, signed notes and final imaging reports with the released flag.
import { h, clear, btn, badge, toast, table, card, kv, formDialog, openDialog, field, initApp, fmtDate, fmtTime, fmtDateTime, ageSpan, bornSpan, showError } from '/shared/ui.js';
import { fhir, api, view, actAs, mrn, patientName, display, coding, lifecycle, refId } from '/shared/fhir.js';
import { patientContext } from '/shared/context.js';
import { reportProblemButton, myReports } from '/shared/report-problem.js';
import { patientInsurance } from '/shared/insurance.js';

const root = document.getElementById('app');
view.set({ asOf: null, branch: 'main', runId: null });
actAs('patient', 'patient');
const shell = await initApp({ app: 'portal', crumbs: { app: 'Patient Portal', home: 'home', names: { home: 'Home', appointments: 'Appointments', messages: 'Inbox', results: 'Results', medications: 'Medications', health: 'Problems and allergies', notes: 'Visit notes', imaging: 'Imaging reports', readings: 'My readings', summary: 'Health summary', profile: 'Profile', pick: 'Choose a patient' } } });
const SECTIONS = [
  ['home', 'Home'], ['appointments', 'Appointments'], ['results', 'Results'], ['messages', 'Inbox'], ['medications', 'Medications'], ['report', 'Report a problem'],
  ['health', 'Problems and allergies'], ['notes', 'Visit notes'], ['imaging', 'Imaging reports'], ['readings', 'My readings'], ['summary', 'Health summary'], ['insurance', 'Insurance and bills'], ['profile', 'Profile'],
];
const SHORTCUTS = ['appointments', 'messages', 'results', 'medications'];
const SIGNED = 'final,corrected,amended';
const PLAIN = { N: ['In range', 'ok'], H: ['Above range', 'warn'], L: ['Below range', 'warn'], HH: ['Well above range', 'danger'], LL: ['Well below range', 'danger'] };
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
const when = (r) => r.effectiveDateTime || r.date || r.issued || r.authoredOn || r.start || r.sent || r.meta?.lastUpdated;
const newest = (a, b) => String(when(b)).localeCompare(String(when(a)));
const noteText = (n) => { try { return new TextDecoder().decode(Uint8Array.from(atob(n.content?.[0]?.attachment?.data || ''), (c) => c.charCodeAt(0))); } catch { return ''; } };
const fromPatient = (c) => c.sender?.reference?.startsWith('Patient/');
const threadOf = (c) => c.identifier?.find((i) => i.system === 'urn:hospital-desktop:thread')?.value || c.id;
const apptPart = (a, kind) => (a.participant || []).find((p) => p.type?.[0]?.text === kind)?.actor?.display || '';
const taskCode = (t) => t.code?.coding?.[0]?.code;

async function picker() {
  const { patients } = await (await fetch('/auth/patients')).json();
  return h('main', { class: 'content', style: 'max-width:40rem;margin:8vh auto' }, h('h1', {}, 'Choose a patient'),
    h('p', { class: 'muted' }, 'There is no sign-in: this is a simulation. Pick whose Patient Portal to open.'),
    table({ testid: 'portal-picker', rows: patients, empty: 'No patients yet. Register one in the EHR first.', onRow: (p) => { patientContext.set(p.id); go('#/home'); }, columns: [
      { label: 'Name', render: (p) => h('a', { href: '#/home', testid: `pick-${p.id}`, 'aria-label': `Open Patient Portal as ${p.given} ${p.family}`, onClick: (e) => { e.preventDefault(); patientContext.set(p.id); go('#/home'); } }, `${p.family}, ${p.given}`) },
      { label: 'MRN', cls: 'mono', render: (p) => p.mrn || '' }, { label: 'Born', render: (p) => bornSpan(p) },
    ] }));
}

async function load(id) {
  const ref = { patient: id };
  const [patient, labs, vitals, meds, problems, allergies, notes, reports, appts, comms, tasks, encounters] = await Promise.all([
    fhir.read('Patient', id),
    fhir.search('Observation', { ...ref, category: 'laboratory', status: SIGNED, _released: 'true' }),
    fhir.search('Observation', { ...ref, category: 'vital-signs', status: SIGNED, _released: 'true' }),
    fhir.search('MedicationRequest', ref), fhir.search('Condition', ref), fhir.search('AllergyIntolerance', ref),
    fhir.search('DocumentReference', { ...ref, docstatus: 'final,amended', _released: 'true' }),
    fhir.search('DiagnosticReport', { ...ref, status: 'final,amended,corrected,appended', _released: 'true' }),
    fhir.search('Appointment', ref), fhir.search('Communication', ref), fhir.search('Task', ref), fhir.search('Encounter', ref),
  ]);
  return { patient, labs: labs.sort(newest), vitals: vitals.sort(newest), meds, problems, allergies, notes: notes.sort(newest), reports: reports.sort(newest), appts, comms: comms.sort((a, b) => (a.sent || '').localeCompare(b.sent || '')), tasks, encounters };
}

function frame(d, section, content) {
  const unread = d.comms.filter((c) => !fromPatient(c) && !c.received).length;
  const label = (id) => SECTIONS.find((s) => s[0] === id)[1];
  const menu = h('select', { testid: 'portal-menu', 'aria-label': 'Menu: all sections', style: 'width:auto', onChange: (e) => go(`#/${e.target.value}`) }, SECTIONS.map(([id, text]) => h('option', { value: id, selected: id === section }, `≡ ${text}`)));
  const top = h('div', { class: 'topbar' }, h('span', { class: 'appname' }, 'Patient Portal'), h('span', { class: 'dot' }, '·'), menu,
    h('nav', { 'aria-label': 'Shortcuts' }, SHORTCUTS.map((id) => h('a', { href: `#/${id}`, testid: `portal-nav-${id}`, 'aria-label': label(id), 'aria-current': section === id ? 'page' : undefined }, label(id), id === 'messages' && unread ? [' ', badge(unread, 'accent', 'unread-badge')] : null))),
    shell.session ? null : h('span', { class: 'muted', testid: 'portal-patient' }, patientName(d.patient)), shell.session ? shell.roleSelect : btn('Switch patient', { small: true, testid: 'switch-patient', onClick: () => { patientContext.set(null); go('#/pick'); } }), shell.themeToggle);
  clear(root).append(top, h('main', { class: 'content', style: 'max-width:68.75rem;margin:0 auto' }, content));
}

// ---------- Sections ----------
function newMessage(d, to = '') {
  formDialog({ title: 'New message to your care team', testid: 'portal-message-form', submitLabel: 'Send', intro: 'For emergencies call your local emergency number. Messages are not monitored around the clock.',
    fields: [{ name: 'topic', label: 'Subject', required: true, wide: true, value: to ? `For ${to}: ` : '' }, { name: 'text', label: 'Message', type: 'textarea', rows: 6, required: true }],
    onSubmit: async (v) => {
      const created = await fhir.create({ resourceType: 'Communication', status: 'completed', subject: { reference: `Patient/${d.patient.id}` }, sender: { reference: `Patient/${d.patient.id}` }, recipient: [{ display: to || 'Care team' }], sent: new Date().toISOString(), topic: { text: v.topic }, payload: [{ contentString: v.text }] });
      await fhir.update({ ...created, identifier: [{ system: 'urn:hospital-desktop:thread', value: created.id }] });
      toast('Message sent'); go(`#/messages?thread=${created.id}`);
    } });
}

function home(d) {
  const upcoming = d.appts.filter((a) => ['booked', 'pending', 'proposed'].includes(a.status) && new Date(a.start) > new Date()).sort((a, b) => a.start.localeCompare(b.start))[0];
  const lab = d.labs[0];
  const last = d.comms.at(-1);
  const unread = d.comms.filter((c) => !fromPatient(c) && !c.received).length;
  const team = [...new Set([...d.encounters.map((e) => e.participant?.[0]?.individual?.display), ...d.appts.map((a) => apptPart(a, 'provider')), ...d.notes.map((n) => n.author?.[0]?.display)].filter(Boolean))];
  return [h('h1', { testid: 'portal-welcome' }, `Welcome, ${patientName(d.patient)}`),
    h('div', { class: 'lists', style: 'grid-template-columns:minmax(0,1fr) 20rem' }, h('div', { class: 'stack' },
      h('div', { class: 'card', testid: 'home-appointment' }, h('h3', {}, 'Next appointment'), upcoming ? [h('div', { style: 'font-size:1.3125rem;font-weight:600' }, `${fmtDate(upcoming.start)} at ${fmtTime(upcoming.start)}`), h('div', { class: 'muted' }, [upcoming.appointmentType?.text, apptPart(upcoming, 'provider'), apptPart(upcoming, 'location')].filter(Boolean).join(' · ')), h('div', { class: 'toolbar', style: 'margin:0.625rem 0 0' }, btn('View details', { testid: 'home-appointments', onClick: () => go('#/appointments') }))] : h('p', { class: 'muted' }, 'No upcoming appointments.')),
      h('div', { class: 'card', testid: 'home-result' }, h('h3', {}, 'Latest test result'), lab ? [h('div', { style: 'font-size:1.3125rem;font-weight:600' }, `${display(lab.code)}: ${lab.valueQuantity?.value} ${lab.valueQuantity?.unit || ''}`), h('div', { class: 'muted' }, fmtDate(when(lab))), h('div', { class: 'toolbar', style: 'margin:0.625rem 0 0' }, btn('View results', { testid: 'home-results', onClick: () => go('#/results') }))] : h('p', { class: 'muted' }, 'No released results yet.')),
      h('div', { class: 'card', testid: 'home-message' }, h('h3', {}, 'Messages ', unread ? badge(`${unread} unread`, 'accent', 'home-unread') : null), last ? [h('div', {}, h('strong', {}, fromPatient(last) ? 'You' : last.sender?.display || 'Care team'), `: ${(last.payload?.[0]?.contentString || '').slice(0, 140)}`), h('div', { class: 'muted' }, fmtDateTime(last.sent)), h('div', { class: 'toolbar', style: 'margin:0.625rem 0 0' }, btn('View messages', { testid: 'home-messages', onClick: () => go('#/messages') }))] : h('p', { class: 'muted' }, 'No messages.'))),
    h('div', { class: 'card', testid: 'care-team' }, h('h3', {}, 'Your care team'), team.length ? team.map((name) => h('div', { class: 'toolbar', style: 'margin:0 0 0.5rem' }, h('span', { class: 'grow' }, name), btn('Message', { small: true, write: true, perm: ['Communication', 'create'], testid: `team-message-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, title: `Message ${name}`, onClick: () => newMessage(d, name) }))) : h('p', { class: 'muted' }, 'Clinicians you have seen will appear here.')))];
}

function results(d) {
  const days = [...new Set(d.labs.map((o) => fmtDate(when(o))))];
  const row = (o) => { const [text, kind] = PLAIN[o.interpretation?.[0]?.coding?.[0]?.code] || ['', '']; const r = o.referenceRange?.[0]; return h('tr', { 'data-testid': `result-${o.id}` }, h('td', {}, display(o.code)), h('td', { class: 'num' }, `${o.valueQuantity?.value} ${o.valueQuantity?.unit || ''}`), h('td', { class: 'muted' }, r ? `${r.low?.value ?? ''} – ${r.high?.value ?? ''}` : ''), h('td', {}, text ? badge(text, kind) : ''), h('td', {}, o.status === 'corrected' ? badge('Updated', 'warn') : '')); };
  const latestVitals = [...new Map(d.vitals.slice().reverse().map((o) => [coding(o.code).code, o])).values()].sort(newest);
  return [h('h1', {}, 'Results'),
    h('div', { class: 'banner info', testid: 'results-caveat' }, 'Results are shown as reported by the laboratory. A value outside the usual range is not always a problem. Your care team reviews every result; message them if you have questions.'),
    d.labs.length ? days.map((day) => h('div', { class: 'card', style: 'margin-bottom:1rem', testid: `results-day-${day}` }, h('h3', {}, day), h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Test', 'Your value', 'Usual range', 'What it means', ''].map((t) => h('th', {}, t)))), h('tbody', {}, d.labs.filter((o) => fmtDate(when(o)) === day).map(row)))))) : h('div', { class: 'card empty', testid: 'results-empty' }, 'No results have been released to you yet.'),
    h('h2', { style: 'margin-top:1.5rem' }, 'Vital signs'),
    table({ testid: 'portal-vitals', rows: latestVitals, empty: 'No vital signs recorded yet.', columns: [{ label: 'Measurement', render: (o) => display(o.code) }, { label: 'Latest value', cls: 'num', render: (o) => `${o.valueQuantity?.value} ${o.valueQuantity?.unit || ''}` }, { label: 'Measured', render: (o) => fmtDateTime(when(o)) }] })];
}

function medications(d) {
  const current = d.meds.filter((m) => lifecycle(m) === 'active' || lifecycle(m) === 'on-hold');
  const past = d.meds.filter((m) => ['completed', 'discontinued'].includes(lifecycle(m)));
  const openRefill = (m) => d.tasks.find((t) => taskCode(t) === 'refill-request' && t.focus?.reference === `MedicationRequest/${m.id}` && ['requested', 'accepted'].includes(t.status));
  const refill = (m) => btn('Request refill', { small: true, write: true, perm: ['Task', 'create'], testid: `refill-${m.id}`, onClick: async () => {
    await fhir.create({ resourceType: 'Task', status: 'requested', intent: 'order', authoredOn: new Date().toISOString(), for: { reference: `Patient/${d.patient.id}` }, focus: { reference: `MedicationRequest/${m.id}` },
      code: { coding: [{ system: 'urn:hospital-desktop:task', code: 'refill-request' }], text: 'Refill request' }, description: `${display(m.medicationCodeableConcept)} · ${m.dosageInstruction?.[0]?.text || ''}`, requester: { reference: `Patient/${d.patient.id}` } });
    toast('Refill requested. Your care team will respond.'); render();
  } });
  const cols = (actions) => [{ label: 'Medication', render: (m) => h('strong', {}, display(m.medicationCodeableConcept)) }, { label: 'How to take it', render: (m) => m.dosageInstruction?.[0]?.text || '' }, { label: 'Prescribed', render: (m) => fmtDate(m.authoredOn) }, { label: 'By', render: (m) => m.requester?.display || '' },
    ...(actions ? [{ label: '', cls: 'actions', render: (m) => (lifecycle(m) === 'on-hold' ? badge('On hold', 'warn') : openRefill(m) ? badge('Refill requested', 'accent', `refill-pending-${m.id}`) : refill(m)) }] : [{ label: 'Ended', render: (m) => lifecycle(m) }])];
  return [h('h1', {}, 'Medications'), h('h2', {}, 'Current'), table({ testid: 'portal-meds-current', rows: current, empty: 'No current medications.', columns: cols(true) }),
    h('h2', { style: 'margin-top:1.5rem' }, 'Past'), table({ testid: 'portal-meds-past', rows: past, empty: 'No past medications.', columns: cols(false) })];
}

function health(d) {
  const activeOnly = (r) => (r.clinicalStatus?.coding?.[0]?.code ?? 'active') === 'active';
  const allergies = d.allergies.filter((a) => activeOnly(a) && coding(a.code).code !== '716186003');
  const nka = d.allergies.some((a) => activeOnly(a) && coding(a.code).code === '716186003');
  return [h('h1', {}, 'Problems and allergies'), h('p', { class: 'muted' }, 'This list is kept by your care team. Message them if something looks wrong.'),
    h('div', { class: 'grid2' },
      card('Health problems', table({ testid: 'portal-problems', rows: d.problems, empty: 'No health problems on file.', columns: [{ label: 'Problem', render: (c) => display(c.code) }, { label: 'Since', render: (c) => fmtDate(c.onsetDateTime) }, { label: 'Status', render: (c) => (activeOnly(c) ? badge('Current', 'accent') : badge('Resolved', 'ok')) }] })),
      card('Allergies', nka && !allergies.length ? h('p', { testid: 'portal-nka' }, 'No known allergies.') : table({ testid: 'portal-allergies', rows: allergies, empty: 'No allergies on file.', columns: [{ label: 'Allergic to', render: (a) => display(a.code) }, { label: 'Reaction', render: (a) => (a.reaction || []).map((r) => r.manifestation?.map(display).join(', ')).join('; ') }, { label: 'How serious', render: (a) => ({ high: 'Can be serious', low: 'Usually mild' }[a.criticality] || '') }] })))];
}

function notes(d, query) {
  const sel = d.notes.find((n) => n.id === query.get('id')) || d.notes[0];
  return [h('h1', {}, 'Visit notes'), h('p', { class: 'muted' }, 'Notes your clinicians have shared with you.'),
    h('div', { class: 'split' }, table({ testid: 'portal-notes', rows: d.notes, selected: sel?.id, empty: 'No notes have been shared with you yet.', onRow: (n) => go(`#/notes?id=${n.id}`), columns: [{ label: 'Date', render: (n) => fmtDate(when(n)) }, { label: 'Note', render: (n) => n.description || display(n.type) }, { label: 'Written by', render: (n) => n.author?.[0]?.display || '' }] }),
      sel ? h('div', { class: 'card', testid: 'portal-note' }, h('h2', {}, sel.description || display(sel.type)), h('div', { class: 'muted' }, `${sel.author?.[0]?.display || ''} · ${fmtDateTime(when(sel))}`), h('hr', { style: 'border:none;border-top:1px solid var(--line);margin:0.75rem 0' }), h('div', { class: 'note-body', testid: 'portal-note-text' }, noteText(sel))) : h('div', { class: 'card empty' }, 'Nothing to show'))];
}

function imaging(d) {
  return [h('h1', {}, 'Imaging reports'), table({ testid: 'portal-imaging', rows: d.reports, empty: 'No imaging reports have been released to you yet.', onRow: (r) => openDialog({ title: display(r.code), testid: 'portal-report', wide: true, body: [kv([['Date', fmtDateTime(when(r))], ['Read by', r.resultsInterpreter?.[0]?.display]]), h('h3', { style: 'margin-top:0.75rem' }, 'Summary'), h('div', { class: 'note-body', 'data-testid': 'portal-report-text' }, r.conclusion || (r.extension || []).find((e) => e.url === 'urn:hospital-desktop:report-findings')?.valueString || '')], actions: [{ label: 'Close', onClick: (c) => c() }] }),
    columns: [{ label: 'Date', render: (r) => fmtDate(when(r)) }, { label: 'Exam', render: (r) => display(r.code) }, { label: 'Read by', render: (r) => r.resultsInterpreter?.[0]?.display || '' }] })];
}

function appointments(d) {
  const upcoming = d.appts.filter((a) => new Date(a.start) > new Date() && !['cancelled', 'noshow'].includes(a.status)).sort((a, b) => a.start.localeCompare(b.start));
  const past = d.appts.filter((a) => !upcoming.includes(a)).sort((a, b) => b.start.localeCompare(a.start));
  const pending = (a) => d.tasks.find((t) => taskCode(t) === 'appointment-change-request' && t.focus?.reference === `Appointment/${a.id}` && ['requested', 'accepted'].includes(t.status));
  const request = (a, kind) => btn(kind === 'cancel' ? 'Ask to cancel' : 'Ask to reschedule', { small: true, write: true, perm: ['Task', 'create'], testid: `appt-${kind}-${a.id}`, onClick: () => formDialog({ title: kind === 'cancel' ? 'Ask to cancel this appointment' : 'Ask to reschedule this appointment', testid: 'appt-request-form', submitLabel: 'Send request', intro: 'Your care team will confirm. The appointment stays booked until they do.',
    fields: [{ name: 'note', label: kind === 'cancel' ? 'Reason (optional)' : 'When would suit you better?', type: 'textarea', rows: 3, required: kind !== 'cancel' }],
    onSubmit: async (v) => {
      await fhir.create({ resourceType: 'Task', status: 'requested', intent: 'order', authoredOn: new Date().toISOString(), for: { reference: `Patient/${d.patient.id}` }, focus: { reference: `Appointment/${a.id}` },
        code: { coding: [{ system: 'urn:hospital-desktop:task', code: 'appointment-change-request' }], text: kind === 'cancel' ? 'Cancel request' : 'Reschedule request' }, description: `${fmtDateTime(a.start)} ${a.appointmentType?.text || ''}${v.note ? ` · ${v.note}` : ''}`, requester: { reference: `Patient/${d.patient.id}` } });
      toast('Request sent'); render();
    } }) });
  const cols = (actions) => [{ label: 'Date', render: (a) => fmtDate(a.start) }, { label: 'Time', cls: 'num', render: (a) => fmtTime(a.start) }, { label: 'Visit', render: (a) => a.appointmentType?.text || '' }, { label: 'With', render: (a) => apptPart(a, 'provider') }, { label: 'Where', render: (a) => apptPart(a, 'location') },
    actions ? { label: '', cls: 'actions', render: (a) => (pending(a) ? badge(`${pending(a).code.text} sent`, 'accent', `appt-pending-${a.id}`) : [request(a, 'reschedule'), request(a, 'cancel')]) } : { label: 'Status', render: (a) => ({ fulfilled: 'Completed', cancelled: 'Cancelled', noshow: 'Missed', arrived: 'Checked in' }[a.status] || a.status) }];
  return [h('h1', {}, 'Appointments'), h('h2', {}, 'Upcoming'), table({ testid: 'portal-appts-upcoming', rows: upcoming, empty: 'No upcoming appointments.', columns: cols(true) }), h('h2', { style: 'margin-top:1.5rem' }, 'Past'), table({ testid: 'portal-appts-past', rows: past, empty: 'No past visits.', columns: cols(false) })];
}

function messages(d, query) {
  const threads = [...new Set(d.comms.map(threadOf))].map((id) => d.comms.filter((c) => threadOf(c) === id)).sort((a, b) => (b.at(-1).sent || '').localeCompare(a.at(-1).sent || ''));
  const sel = threads.find((t) => threadOf(t[0]) === query.get('thread')) || threads[0];
  if (sel) for (const c of sel.filter((x) => !fromPatient(x) && !x.received)) fhir.update({ ...c, received: new Date().toISOString() }).catch(() => {});
  const reply = field({ name: 'reply', label: 'Your reply', type: 'textarea', rows: 3, testid: 'portal-reply' });
  return [h('div', { class: 'page-head' }, h('h1', {}, 'Inbox'), btn('New message', { kind: 'primary', write: true, perm: ['Communication', 'create'], testid: 'portal-message-new', onClick: () => newMessage(d) })),
    h('div', { class: 'banner danger', testid: 'emergency-banner', role: 'note' }, h('strong', {}, 'This is not for emergencies.'), 'If you need urgent help, call your local emergency number or go to the nearest emergency department.'),
    h('div', { class: 'split' }, table({ testid: 'portal-threads', rows: threads.map((t) => ({ id: threadOf(t[0]), t })), selected: sel ? threadOf(sel[0]) : null, empty: 'No messages yet.', onRow: (r) => go(`#/messages?thread=${r.id}`), columns: [{ label: 'Subject', render: (r) => r.t[0].topic?.text || '(no subject)' }, { label: 'Last message', render: (r) => fmtDateTime(r.t.at(-1).sent) }, { label: '', render: (r) => (r.t.some((c) => !fromPatient(c) && !c.received) ? badge('New', 'accent') : '') }] }),
      sel ? h('div', { class: 'card thread', testid: 'portal-thread' }, h('h3', {}, sel[0].topic?.text || 'Conversation'), sel.map((c) => h('div', { class: `msg${fromPatient(c) ? ' mine' : ''}`, 'data-testid': `portal-msg-${c.id}` }, h('div', { class: 'meta' }, `${fromPatient(c) ? 'You' : c.sender?.display || 'Care team'} · ${fmtDateTime(c.sent)}`), c.payload?.[0]?.contentString || '')), reply.el,
        h('div', { class: 'toolbar', style: 'margin-top:0.5rem' }, btn('Send reply', { kind: 'primary', write: true, perm: ['Communication', 'create'], testid: 'portal-reply-send', onClick: async () => { if (!reply.get()) throw new Error('Type a reply first'); await fhir.create({ resourceType: 'Communication', status: 'completed', subject: { reference: `Patient/${d.patient.id}` }, sender: { reference: `Patient/${d.patient.id}` }, recipient: [{ display: 'Care team' }], sent: new Date().toISOString(), topic: sel[0].topic, payload: [{ contentString: reply.get() }], identifier: [{ system: 'urn:hospital-desktop:thread', value: threadOf(sel[0]) }] }); toast('Reply sent'); render(); } }))) : h('div', { class: 'card empty' }, 'No conversation selected'))];
}

function summary(d) {
  const download = () => {
    const resources = [d.patient, ...d.problems, ...d.allergies, ...d.meds.filter((m) => ['active', 'on-hold', 'completed', 'discontinued'].includes(lifecycle(m))), ...d.labs, ...d.vitals, ...d.notes, ...d.reports, ...d.appts];
    const bundle = { resourceType: 'Bundle', type: 'collection', timestamp: new Date().toISOString(), entry: resources.map((resource) => ({ fullUrl: `${location.origin}/fhir/R4/${resource.resourceType}/${resource.id}`, resource })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/fhir+json' }));
    const a = h('a', { href: url, download: `patient-${d.patient.id}-summary.json` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Health summary downloaded');
  };
  return [h('h1', {}, 'Health summary'), card('Download your record', h('p', {}, 'A copy of everything you can see in this portal, as a standard FHIR Bundle (JSON) that other health apps can read.'),
    kv([['Problems', d.problems.length], ['Allergies', d.allergies.length], ['Medications', d.meds.length], ['Released results', d.labs.length], ['Vital signs', d.vitals.length], ['Shared notes', d.notes.length], ['Imaging reports', d.reports.length], ['Appointments', d.appts.length]]),
    h('div', { class: 'toolbar', style: 'margin-top:0.75rem' }, btn('Download health summary', { kind: 'primary', testid: 'summary-download', onClick: download })))];
}

function profile(d) {
  const p = d.patient;
  return [h('h1', {}, 'Profile'), card('Your details', kv([['Name', patientName(p)], ['Medical record number', h('span', { class: 'mono' }, mrn(p))], ['Date of birth', h('span', {}, bornSpan(p), ' (', ageSpan(p), ')')], ['Sex', p.gender], ['Phone', p.telecom?.[0]?.value], ['Address', p.address?.[0]?.text]]), h('p', { class: 'muted', style: 'margin-top:0.75rem' }, 'To change these details, message your care team.'))];
}

// My readings: home readings for an enrolled patient, entry forms per device, history charts and plain-language guidance.
const GUIDANCE = { sbp: 'Sit quietly for five minutes, feet flat, arm at heart level. Take the reading before medicines in the morning.', dbp: 'The lower number of your blood pressure reading.', hr: 'Your pulse, from the cuff or oximeter.', weight: 'Weigh at the same time each morning, after the toilet and before breakfast, in similar clothing.', glucose: 'Wash your hands first. Note whether the reading is before or after a meal in the message box if asked.', spo2: 'Warm your finger first and keep still until the number settles.', temp: 'Take your temperature if you feel unwell or when your plan asks for it.' };
function readings(d) {
  const box = h('div', { class: 'stack', testid: 'portal-readings' }, h('p', { class: 'muted' }, 'Loading your readings…'));
  const svgEl = (tag, attrs = {}, ...kids) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); for (const k of kids) el.append(typeof k === 'string' ? document.createTextNode(k) : k); return el; };
  const chart = (pts, kind, t) => {
    const vals = pts.map((p) => p.value).concat([t?.low, t?.high].filter((v) => v != null)); const lo = Math.min(...vals) - 2; const hi = Math.max(...vals) + 2; const span = hi - lo || 1;
    const w = 600; const ht = 150; const x = (i) => 36 + (i * (w - 46)) / Math.max(pts.length - 1, 1); const y = (v) => ht - 20 - ((v - lo) / span) * (ht - 36);
    const svg = svgEl('svg', { viewBox: `0 0 ${w} ${ht}`, style: 'width:100%;max-width:37.5rem;height:9.375rem;background:var(--surface);border:1px solid var(--line);border-radius:0.625rem', role: 'img', 'aria-label': `${kind.name} history`, 'data-testid': `portal-chart-${kind.key}` });
    for (const v of [t?.low, t?.high]) if (v != null) { svg.append(svgEl('line', { x1: 36, x2: w - 10, y1: y(v), y2: y(v), stroke: 'var(--warn)', 'stroke-dasharray': '4 3' })); svg.append(svgEl('text', { x: 2, y: y(v) + 4, style: 'font-size:0.9375rem;fill:var(--ink-3)' }, String(v))); }
    svg.append(svgEl('polyline', { points: pts.map((p, i) => `${x(i)},${y(p.value)}`).join(' '), fill: 'none', stroke: 'var(--accent)', 'stroke-width': '1.5' }));
    pts.forEach((p, i) => svg.append(svgEl('circle', { cx: x(i), cy: y(p.value), r: 3, fill: 'var(--accent)' }, svgEl('title', {}, `${fmtDateTime(p.at)}: ${p.value} ${kind.unit}`))));
    return svg;
  };
  api.get(`/api/rpm/patients/${d.patient.id}`).then((r) => {
    clear(box);
    box.append(h('div', { class: 'banner danger', testid: 'readings-emergency', role: 'note' }, h('strong', {}, 'This is not for emergencies.'), ' If you feel very unwell, call your local emergency number. Your care team reviews readings during working hours.'));
    if (!r.enrolled) { box.append(h('div', { class: 'card empty', testid: 'readings-not-enrolled' }, 'You are not enrolled in a home monitoring programme. Your care team can enrol you.')); return; }
    const kinds = Object.keys(r.plan.schedule).map((k) => ({ key: k, ...r.readingKinds[k] }));
    const entry = (kind) => formDialog({ title: `Enter ${kind.name.toLowerCase()}`, testid: 'reading-form', submitLabel: 'Save reading', intro: GUIDANCE[kind.key], fields: [{ name: 'value', label: `${kind.name} (${kind.unit})`, type: 'number', step: 'any', required: true }], onSubmit: async (v) => {
      const out = await api.post('/api/rpm/readings', { patient: d.patient.id, key: kind.key, value: v.value });
      toast(out.reading.flag ? 'Saved. That reading looks unusual; please check your device and try again.' : out.alerts.length ? 'Saved. Your care team has been alerted and will be in touch.' : 'Saved. Thank you.');
      render();
    } });
    box.append(card(`Your programme: ${r.plan.label}`, kv([['Readings asked for', kinds.map((k) => `${k.name} ${r.plan.schedule[k.key]} a day`).join(', ')], ['This week', r.adherence?.percent == null ? '—' : `${r.adherence.percent}% of readings entered`]]),
      h('div', { class: 'toolbar' }, kinds.map((k) => btn(`Enter ${k.name.toLowerCase()}`, { kind: 'primary', small: true, write: true, perm: ['Observation', 'create'], testid: `reading-enter-${k.key}`, onClick: () => entry(k) })))));
    for (const k of kinds) { const t = r.thresholds[k.key]; const pts = r.series[k.key] || []; box.append(card(k.name, pts.length ? chart(pts, k, t) : h('p', { class: 'muted' }, 'No reading yet'), h('p', { class: 'muted small' }, GUIDANCE[k.key]), t && (t.low != null || t.high != null) ? h('p', { class: 'small' }, `Your target: ${t.low ?? 'any'} to ${t.high ?? 'any'} ${k.unit}. A reading outside it tells your care team; it is not an emergency on its own.`) : null)); }
    if (r.latest && Object.keys(r.latest).length) box.append(card('Latest', kv(Object.entries(r.latest).map(([k, v]) => [r.readingKinds[k].name, `${v.value} ${r.readingKinds[k].unit} on ${fmtDateTime(v.at)}`]))));
  }).catch((err) => { clear(box); box.append(h('div', { class: 'banner danger', testid: 'readings-error' }, err.message)); });
  return box;
}

/** Tell the care team about a problem with something the computer assistant wrote or did. */
function report(d) {
  const mine = h('div', { testid: 'portal-my-reports' }, h('p', { class: 'muted' }, 'Loading your reports…'));
  const refresh = () => myReports({ patient: d.patient.id, plain: true }).then((el) => mine.replaceChildren(el), () => mine.replaceChildren(h('p', { class: 'muted' }, 'Your reports could not be loaded.')));
  refresh();
  return [h('div', { class: 'page-head' }, h('h1', {}, 'Report a problem')), h('div', { class: 'card' }, h('p', {}, 'Some messages and summaries here are drafted by a computer assistant and checked by your care team. If something it wrote or did was wrong, confusing or worrying, tell us. A person reads every report, and you can see what happened to yours below.'),
    reportProblemButton({}, { patient: d.patient.id, plain: true, label: 'Tell us about a problem', testid: 'portal-report-problem', onFiled: refresh })), h('h2', { style: 'margin-top:1rem' }, 'Your reports'), mine];
}
function insurance(d) { const box = h('div', { testid: 'my-insurance' }, h('p', { class: 'muted' }, 'Loading')); const draw = () => patientInsurance(patientContext.get(), draw).then((kids) => clear(box).append(h('h1', {}, 'Insurance and bills'), ...kids)).catch((err) => clear(box).append(h('div', { class: 'banner danger', testid: 'my-insurance-error' }, err.message))); draw(); return box; }
const VIEWS = { insurance, home, results, medications, health, notes, imaging, appointments, messages, readings, summary, profile, report };
let token = 0;
async function render() {
  const mine = token += 1;
  const [path, qs] = (location.hash.slice(2) || 'home').split('?');
  const id = patientContext.get();
  try {
    if (!id || path === 'pick') { const view0 = await picker(); if (mine === token) clear(root).append(h('div', { class: 'topbar' }, h('span', { class: 'appname' }, 'Patient Portal'), h('span', { class: 'spacer' }), shell.themeToggle), view0); return; }
    const d = await load(id);
    const section = VIEWS[path] ? path : 'home';
    if (mine === token) frame(d, section, VIEWS[section](d, new URLSearchParams(qs || '')));
  } catch (err) {
    if (mine !== token) return;
    if (err.status === 404) { patientContext.set(null); go('#/pick'); return; }
    showError(err);
    clear(root).append(h('main', { class: 'content' }, h('div', { class: 'banner danger', testid: 'load-error' }, err.message), btn('Retry', { testid: 'retry', onClick: render })));
  }
}
window.addEventListener('hashchange', render);
patientContext.onChange((_, { remote }) => { if (remote) go('#/home'); });
render();
