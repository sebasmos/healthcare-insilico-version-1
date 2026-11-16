// EHR shell and the screens outside a patient chart: dashboard, patients,
// schedule, front desk, orders worklist, Inbox, billing and administration.
import {
  h, clear, btn, badge, toast, table, card, kv, formDialog, openDialog, askReason, initApp, timeStrip,
  fmtDate, fmtTime, fmtDateTime, toLocalInput, age, loadAges, slug, showError,
  bornSpan,
} from '/shared/ui.js';
import { fhir, api, view, identity, catalog, mrn, patientName, display, lifecycle, refId, flagged } from '/shared/fhir.js';
import { patientContext } from '/shared/context.js';
import { loadProposals, proposalCard } from '/shared/proposals.js';
import { visibleNav, visibleChartTabs, landing, canWrite, reasonFor, currentPermission } from '/shared/roles.js';
import { renderChart, CHART_TABS } from '/ehr/chart.js';
import { worklistTable } from '/ehr/nursing.js';
import { hospitalDesk, coverageCard, scheduleWarnings, INS_FOLDERS, insInboxData, insInbox } from '/shared/insurance.js';
import { reportProblemButton, myReports } from '/shared/report-problem.js';

const root = document.getElementById('app');
const shell = await initApp({ app: 'ehr', crumbs: { app: 'EHR', home: 'dashboard', names: { dashboard: 'Dashboard', worklist: 'Tasks', patients: 'Patients', schedule: 'Schedule', frontdesk: 'Front desk', orders: 'Orders', inbox: 'Inbox', billing: 'Billing', admin: 'Admin', chart: 'Chart', summary: 'Summary', review: 'Review', problems: 'Problems', allergies: 'Allergies', medications: 'Medications', vitals: 'Vitals', notes: 'Notes', results: 'Results', imaging: 'Imaging', ecg: 'ECG', encounters: 'Encounters', messages: 'Messages', mar: 'MAR', flowsheets: 'Flowsheets', io: 'Intake and output', education: 'Education', careplan: 'Care plan' }, resolve: (segments) => { if (segments[0] !== 'chart') return null; const name = document.querySelector('[data-testid="patient-name"]')?.textContent?.trim() || 'Patient'; const tab = segments[2] || 'summary'; const label = { summary: 'Summary', review: 'Review', problems: 'Problems', allergies: 'Allergies', medications: 'Medications', vitals: 'Vitals', notes: 'Notes', orders: 'Orders', results: 'Results', imaging: 'Imaging', ecg: 'ECG', encounters: 'Encounters', messages: 'Messages', worklist: 'Tasks', mar: 'MAR', flowsheets: 'Flowsheets', io: 'Intake and output', education: 'Education', careplan: 'Care plan' }[tab] || tab; return [['Patients', '#/patients'], [name, `#/chart/${segments[1]}/summary`], ...(tab === 'summary' && !segments[3] ? [] : [[segments[3] ? `${label} · ${segments[3]}` : label, location.hash.split('?')[0]]])]; } } });
// Every section the EHR has. The role's map decides which are shown (a section a role has no use for is not shown).
const NAV = [
  ['dashboard', '▦ Dashboard'], ['worklist', '☑ Tasks'], ['patients', '☺ Patients'], ['schedule', '▤ Schedule'], ['frontdesk', '⚇ Front desk'],
  ['orders', '☑ Orders'], ['inbox', '✉ Inbox'], ['billing', '≡ Billing'], ['admin', '⚙ Admin'],
];
const navIds = () => visibleNav(NAV.map(([id]) => id));

const openCharts = (() => { try { return JSON.parse(sessionStorage.getItem('hd.ehr.tabs') || '[]'); } catch { return []; } })();
const saveTabs = () => { try { sessionStorage.setItem('hd.ehr.tabs', JSON.stringify(openCharts)); } catch { /* ignore */ } };

export function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }
export function openChart(patient, activity = 'summary') {
  if (!openCharts.some((t) => t.id === patient.id)) { openCharts.push({ id: patient.id, name: patientName(patient) }); saveTabs(); }
  patientContext.set(patient.id);
  go(`#/chart/${patient.id}/${activity}`);
}

const patientCache = new Map();
async function patientsById(ids) {
  const missing = [...new Set(ids)].filter((id) => id && !patientCache.has(id));
  if (missing.length) for (const p of await fhir.search('Patient', { _id: missing.join(',') })) patientCache.set(p.id, p);
  return patientCache;
}
const patientLink = (p, activity) => (p ? h('a', { href: `#/chart/${p.id}/${activity || 'summary'}`, testid: `open-chart-${p.id}`, 'aria-label': `Open chart for ${patientName(p)}`, onClick: (e) => { e.preventDefault(); openChart(p, activity); } }, patientName(p)) : 'Unknown patient');

// ---------- Shell ----------
// The top bar and the dashboard share a badge request that is already on its way; a finished one is never reused, so a new critical result or unsigned note shows on the next screen. The top bar never waits for it.
let lastCounters = null; let counterTimer = null;
let badgesInflight = null;
function getBadges() {
  if (!badgesInflight) badgesInflight = api.get('/api/badges').finally(() => { badgesInflight = null; });
  return badgesInflight;
}
async function renderShell(route, content) {
  const badgeSlot = h('span', { class: 'badge-slot' });
  getBadges().then((badges) => badgeSlot.append(...[
    badges.criticalUnacknowledged.length ? h('button', { class: 'badge solid-danger', testid: 'badge-critical', 'aria-label': 'Unacknowledged critical results', onClick: () => showCritical(badges.criticalUnacknowledged) }, `${badges.criticalUnacknowledged.length} critical`) : null,
    badges.unsignedNotes.length ? h('button', { class: 'badge warn', testid: 'badge-unsigned', 'aria-label': 'Unsigned notes', onClick: () => showUnsigned(badges.unsignedNotes) }, `${badges.unsignedNotes.length} unsigned`) : null,
  ].filter(Boolean)), (err) => showError(err));
  // Four live counters (Draft Notes, Open Charts, Portal Notifications, Inbox). Each opens its list.
  const counters = h('div', { class: 'topcounters', testid: 'top-counters', role: 'group', 'aria-label': 'Counters' });
  const counterButton = (id, label, n, onClick) => h('button', { type: 'button', class: n ? 'has' : '', testid: `counter-${id}`, 'aria-label': `${label}: ${n}`, onClick }, label, h('b', { testid: `counter-${id}-n` }, String(n)));
  const listDialog = async (title, testid, items, columns, onRow) => { const people = await patientsById(items.map((i) => refId(i.patient))); openDialog({ title, testid, wide: true, body: table({ testid: `${testid}-table`, rows: items, empty: 'No data to display', onRow: (i) => { document.querySelector(`dialog[data-testid="${testid}"]`)?.remove(); onRow(i); }, columns: [{ label: 'Patient', render: (i) => patientName(people.get(refId(i.patient))) }, ...columns, { label: 'When', render: (i) => fmtDateTime(i.at) }] }), actions: [{ label: 'Close', testid: `${testid}-close-button`, onClick: (c) => c() }] }); };
  const drawCounters = (c) => {
    // A message from the Patient Portal arrives live: the open thread list or Inbox redraws, unless the person is typing.
    const arrived = lastCounters && c.portal.count !== lastCounters.portal.count; const typing = document.querySelector('dialog[open]') || [...document.querySelectorAll('textarea, input[type="text"]')].some((el) => el.value && el.closest('.chart-body, .thread'));
    lastCounters = c;
    if (arrived && !typing && (/\/messages/.test(location.hash) || location.hash.startsWith('#/inbox'))) { render(); return; }
    clear(counters).append(
    counterButton('draft-notes', 'Draft Notes', c.draftNotes.count, () => listDialog('Draft Notes', 'draft-notes-list', c.draftNotes.items, [{ label: 'Note', render: (i) => i.what }, { label: 'By', render: (i) => i.by || '' }], (i) => go(`#/chart/${refId(i.patient)}/notes?id=${i.id}`))),
    counterButton('open-charts', 'Open Charts', openCharts.length, () => openDialog({ title: 'Open Charts', testid: 'open-charts-list', body: table({ testid: 'open-charts-list-table', rows: openCharts, empty: 'No data to display', onRow: (t) => { document.querySelector('dialog[data-testid="open-charts-list"]')?.remove(); go(`#/chart/${t.id}/summary`); }, columns: [{ label: 'Patient', render: (t) => t.name }] }), actions: [{ label: 'Close', testid: 'open-charts-list-close-button', onClick: (x) => x() }] })),
    counterButton('portal', 'Portal Notifications', c.portal.count, () => listDialog('Portal Notifications', 'portal-list', c.portal.items, [{ label: 'Kind', render: (i) => [{ message: 'Message', refill: 'Refill request', appointment: 'Appointment request' }[i.kind], i.urgent ? [' ', badge('Urgent', 'solid-danger')] : null] }, { label: 'About', render: (i) => i.what }], (i) => go(i.kind === 'message' ? `#/chart/${refId(i.patient)}/messages` : `#/inbox?folder=${i.kind === 'refill' ? 'refills' : 'followups'}`))),
    counterButton('inbox', 'Inbox', c.inbox.total, () => go('#/inbox'))); };
  if (lastCounters) drawCounters(lastCounters);
  const refreshCounters = () => api.get('/api/counters').then((c) => { if (counters.isConnected || !lastCounters) drawCounters(c); }, () => {});
  refreshCounters(); clearInterval(counterTimer); counterTimer = setInterval(() => { if (!document.hidden) refreshCounters(); }, 4000);
  const search = h('input', { class: 'search', type: 'search', placeholder: 'Find patient: name or MRN', testid: 'quick-search', 'aria-label': 'Find patient by family name or MRN', onKeydown: (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) go(`#/patients?q=${encodeURIComponent(e.target.value.trim())}`);
  } });
  const top = h('div', { class: 'topbar' },
    h('span', { class: 'appname' }, 'EHR'), h('span', { class: 'dot' }, '·'), search,
    h('nav', { 'aria-label': 'EHR sections' }, NAV.filter(([id]) => navIds().includes(id)).map(([id, label]) => h('a', { href: `#/${id}`, testid: `nav-${id}`, 'aria-label': label.slice(2), 'aria-current': route === id ? 'page' : undefined }, label))),
    badgeSlot, counters,
    shell.themeToggle, shell.roleSelect,
  );
  const tabs = h('div', { class: 'worktabs', testid: 'workspace-tabs' }, openCharts.map((t) => h('div', { class: `tab${route === 'chart' && location.hash.includes(t.id) ? ' active' : ''}` },
    h('a', { href: `#/chart/${t.id}/summary`, testid: `worktab-${t.id}`, 'aria-label': `Chart: ${t.name}` }, t.name),
    h('button', { type: 'button', testid: `worktab-close-${t.id}`, 'aria-label': `Close chart ${t.name}`, onClick: () => {
      openCharts.splice(openCharts.findIndex((x) => x.id === t.id), 1); saveTabs();
      if (location.hash.includes(t.id)) go('#/patients'); else render();
    } }, '✕'))));
  clear(root).append(...[top, timeStrip(), openCharts.length ? tabs : null, content].filter(Boolean));
}

async function showCritical(items) {
  const patients = await patientsById(items.map((i) => refId(i.patient)));
  openDialog({ title: 'Unacknowledged critical results', testid: 'critical-list', wide: true, body: table({
    testid: 'critical-table', rows: items,
    columns: [
      { label: 'Patient', render: (i) => patientName(patients.get(refId(i.patient))) },
      { label: 'Result', render: (i) => i.display },
      { label: 'Value', cls: 'num', render: (i) => `${i.value} ${i.unit}` },
      { label: 'Flag', render: (i) => badge(i.flag, 'solid-danger') },
      { label: '', cls: 'actions', render: (i) => btn('Open results', { small: true, testid: `critical-open-${i.id}`, onClick: () => { document.querySelector('dialog[open]')?.close(); openChart(patients.get(refId(i.patient)), 'review/labs'); } }) },
    ],
  }), actions: [{ label: 'Close', onClick: (c) => c() }] });
}

async function showUnsigned(items) {
  const patients = await patientsById(items.map((i) => refId(i.patient)));
  openDialog({ title: 'Unsigned notes', testid: 'unsigned-list', wide: true, body: table({
    testid: 'unsigned-table', rows: items,
    columns: [
      { label: 'Patient', render: (i) => patientName(patients.get(refId(i.patient))) },
      { label: 'Type', render: (i) => i.type }, { label: 'Author', render: (i) => i.author || '' }, { label: 'Started', render: (i) => fmtDateTime(i.date) },
      { label: '', cls: 'actions', render: (i) => btn('Open notes', { small: true, testid: `unsigned-open-${i.id}`, onClick: () => { document.querySelector('dialog[open]')?.close(); openChart(patients.get(refId(i.patient)), 'notes'); } }) },
    ],
  }), actions: [{ label: 'Close', onClick: (c) => c() }] });
}

const page = (title, actions, ...children) => h('main', { class: 'content' }, h('div', { class: 'page-head' }, h('h1', {}, title), actions), ...children);

// ---------- Dashboard ----------
async function dashboard() {
  const today = fmtDate(new Date());
  const [patients, appts, orders, badges] = await Promise.all([
    fhir.search('Patient', { _sort: '-_lastUpdated' }), fhir.search('Appointment'), fhir.search('ServiceRequest'), getBadges(),
  ]);
  const recent = patients.slice(0, 8); // newest update first
  const todays = appts.filter((a) => fmtDate(a.start) === today && !['cancelled', 'noshow'].includes(a.status)).sort((a, b) => a.start.localeCompare(b.start));
  const byId = new Map(patients.map((p) => [p.id, p]));
  const stat = (label, value, testid) => h('div', { class: 'card', testid }, h('b', {}, value), h('span', { class: 'muted' }, label));
  let email = ''; try { email = localStorage.getItem('hd.email') || ''; } catch { /* no storage */ }
  return page('Dashboard', h('span', { class: 'muted', testid: 'signed-in-email' }, `Signed in as ${email || identity.display}${email ? ` · ${identity.display}` : ''}`),
    h('div', { class: 'stat' },
      stat('Patients', patients.length, 'stat-patients'), stat('Appointments today', todays.length, 'stat-appointments'),
      stat('Open orders', orders.filter((o) => ['draft', 'active', 'results-received', 'report-signed'].includes(lifecycle(o))).length, 'stat-orders'),
      stat('Unsigned notes', badges.unsignedNotes.length, 'stat-unsigned'), stat('Critical results to acknowledge', badges.criticalUnacknowledged.length, 'stat-critical')),
    h('div', { class: 'grid2' },
      card('Today\'s schedule', table({ testid: 'today-schedule', rows: todays, empty: 'No appointments today', columns: [
        { label: 'Time', cls: 'num', render: (a) => fmtTime(a.start) },
        { label: 'Patient', render: (a) => patientLink(byId.get(apptPatientId(a))) },
        { label: 'Type', render: (a) => a.appointmentType?.text || '' }, { label: 'Status', render: (a) => badge(a.status, a.status === 'arrived' ? 'warn' : a.status === 'fulfilled' ? 'ok' : 'accent') },
      ] })),
      card('Recently updated patients', table({ testid: 'recent-patients', rows: recent, empty: 'No patients yet. Register one from Patients.', columns: [
        { label: 'Patient', render: (p) => patientLink(p) }, { label: 'MRN', cls: 'mono', render: mrn }, { label: 'Updated', render: (p) => fmtDateTime(p.meta.lastUpdated) },
      ] })),
    ));
}

// ---------- Patients and lists ----------
const LIST_CODE = 'urn:hospital-desktop:patient-list';
async function patientsScreen(query) {
  const q = query.get('q') || '';
  const listId = query.get('list') || 'all';
  const unitId = query.get('unit') || '';
  const lists = (await fhir.search('List')).filter((l) => l.code?.coding?.[0]?.system === LIST_CODE && l.status === 'current');
  const current = lists.find((l) => l.id === listId);
  // By unit: inpatients whose active Encounter.location is a bed in the unit, through the Encounter location search parameter.
  const units = (await fhir.search('Location', { 'physical-type': 'wa' })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const bedByPatient = new Map();
  let rows;
  if (unitId) {
    const rooms = await fhir.search('Location', { partof: unitId });
    const beds = rooms.length ? await fhir.search('Location', { partof: rooms.map((r) => r.id).join(','), 'physical-type': 'bd' }) : [];
    const encounters = beds.length ? await fhir.search('Encounter', { location: beds.map((b) => b.id).join(','), status: 'arrived,in-progress' }) : [];
    for (const e of encounters) bedByPatient.set(refId(e.subject?.reference), (e.location || []).find((l) => l.status === 'active')?.location?.display || '');
    rows = bedByPatient.size ? await fhir.search('Patient', { _id: [...bedByPatient.keys()].join(',') }) : [];
  } else if (q) rows = await fhir.search('Patient', { identifier: q.trim().toUpperCase() }); // patients are found by number, never by name
  else if (current) rows = await fhir.search('Patient', { _id: (current.entry || []).map((e) => refId(e.item.reference)).join(',') || 'none' });
  else rows = await fhir.search('Patient');
  rows.sort((a, b) => patientName(a).localeCompare(patientName(b)));
  rows.forEach((p) => patientCache.set(p.id, p));
  await loadAges(rows);

  const saveList = async (list, ids) => { await fhir.update({ ...list, entry: ids.map((id) => ({ item: { reference: `Patient/${id}` } })) }); render(); };
  const listButton = (id, label, count) => h('button', { type: 'button', testid: `list-${id}`, 'aria-label': `Patient list: ${label}`, 'aria-pressed': String(!q && listId === id), onClick: () => go(`#/patients?list=${id}`) }, h('span', {}, label), count != null ? badge(count) : null);
  const side = h('div', { class: 'card listnav' }, h('h3', {}, 'My lists'), listButton('all', 'All patients'),
    lists.map((l) => listButton(l.id, l.title, (l.entry || []).length)),
    h('div', { style: 'margin-top:0.625rem' }, btn('New list', { small: true, write: true, perm: ['List', 'create'], testid: 'list-new', onClick: () => formDialog({
      title: 'New patient list', testid: 'list-form', submitLabel: 'Create list', fields: [{ name: 'title', label: 'List name', required: true, wide: true }],
      onSubmit: async ({ title }) => { const l = await fhir.create({ resourceType: 'List', status: 'current', mode: 'working', title, code: { coding: [{ system: LIST_CODE, code: 'patient-list' }] }, entry: [] }); go(`#/patients?list=${l.id}`); },
    }) })));

  const search = h('input', { type: 'search', value: q, placeholder: 'Exact MRN (N000000)', testid: 'patient-search', 'aria-label': 'Search patients by exact MRN', style: 'max-width:21.25rem', onKeydown: (e) => { if (e.key === 'Enter') go(`#/patients?q=${encodeURIComponent(e.target.value.trim())}`); } });
  const inList = (p) => current && (current.entry || []).some((e) => e.item.reference === `Patient/${p.id}`);
  const unitSelect = h('select', { testid: 'patients-unit-filter', 'aria-label': 'By unit', style: 'width:auto', onChange: (e) => go(e.target.value ? `#/patients?unit=${e.target.value}` : '#/patients') },
    [['', 'By unit: all patients'], ...units.map((u) => [u.id, u.name])].map(([v, t]) => h('option', { value: v, selected: v === unitId }, t)));
  const grid = table({ testid: 'patients-table', rows, onRow: (p) => openChart(p), empty: unitId ? 'No inpatient is in a bed in this unit' : q ? `No patient matches "${q}"` : 'No patients yet. Use Register patient to add the first one.',
    columns: [
      { label: 'Patient', render: (p) => patientLink(p) }, { label: 'MRN', cls: 'mono', render: mrn },
      ...(unitId ? [{ label: 'Bed', render: (p) => h('span', { testid: `patient-bed-${p.id}` }, bedByPatient.get(p.id) || '') }] : []),
      { label: 'Age / sex', render: (p) => [age(p), p.gender].filter(Boolean).join(' / ') }, { label: 'Born', render: (p) => bornSpan(p) },
      { label: '', cls: 'actions', render: (p) => [
        btn('Open chart', { small: true, testid: `patient-open-${p.id}`, onClick: () => openChart(p) }),
        lists.length && !inList(p) ? btn('Add to list', { small: true, write: true, perm: ['List', 'update'], testid: `patient-addlist-${p.id}`, onClick: () => formDialog({
          title: `Add ${patientName(p)} to a list`, testid: 'addlist-form', submitLabel: 'Add', fields: [{ name: 'list', label: 'List', type: 'select', options: lists.map((l) => [l.id, l.title]), wide: true }],
          onSubmit: async ({ list }) => { const l = lists.find((x) => x.id === list); const ids = (l.entry || []).map((e) => refId(e.item.reference)); if (!ids.includes(p.id)) await saveList(l, [...ids, p.id]); },
        }) }) : null,
        inList(p) ? btn('Remove from list', { small: true, write: true, perm: ['List', 'update'], testid: `patient-removelist-${p.id}`, onClick: () => saveList(current, (current.entry || []).map((e) => refId(e.item.reference)).filter((id) => id !== p.id)) }) : null,
      ] },
    ] });
  return page('Patients', btn('Register patient', { kind: 'primary', write: true, perm: ['Patient', 'create'], testid: 'register-patient', onClick: registerDialog }),
    h('div', { class: 'lists' }, side, h('div', {}, h('div', { class: 'toolbar' }, search, btn('Search', { testid: 'patient-search-go', onClick: () => go(`#/patients?q=${encodeURIComponent(search.value.trim())}`) }), q ? btn('Clear', { testid: 'patient-search-clear', onClick: () => go('#/patients') }) : null, unitSelect, h('span', { class: 'grow' }), h('span', { class: 'muted', testid: 'patients-count' }, `${rows.length} patient${rows.length === 1 ? '' : 's'}`)), grid)));
}

function registerDialog() {
  formDialog({
    title: 'Register patient', testid: 'register-form', submitLabel: 'Register',
    intro: 'Patients are known by number: no name is asked for or kept. The MRN is generated automatically unless you enter one.',
    fields: [
      { name: 'birthDate', label: 'Date of birth', type: 'date', required: true, max: fmtDate(new Date()) },
      { name: 'gender', label: 'Sex', type: 'select', options: ['female', 'male', 'other', 'unknown'] },
      { name: 'phone', label: 'Phone', type: 'tel' }, { name: 'mrn', label: 'MRN (optional, N + 6 digits)', placeholder: 'Generated automatically' },
      { name: 'address', label: 'Address', wide: true },
    ],
    onSubmit: async (v) => {
      const patient = await fhir.create({
        resourceType: 'Patient', birthDate: v.birthDate, gender: v.gender,
        ...(v.phone ? { telecom: [{ system: 'phone', value: v.phone }] } : {}), ...(v.address ? { address: [{ text: v.address }] } : {}),
        ...(v.mrn ? { identifier: [{ use: 'usual', type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] }, system: 'urn:hospital-desktop:mrn', value: v.mrn.toUpperCase() }] } : {}),
      });
      toast(`Registered ${patientName(patient)} · ${mrn(patient)}`);
      openChart(patient);
    },
  });
}

// ---------- Schedule ----------
export const apptPatientId = (a) => refId((a.participant || []).map((p) => p.actor?.reference).find((r) => r?.startsWith('Patient/')));
const apptPart = (a, kind) => (a.participant || []).find((p) => p.type?.[0]?.text === kind)?.actor?.display || '';
const APPT_TYPES = ['Office visit', 'Follow-up', 'New patient', 'Procedure', 'Telephone visit', 'Imaging'];

export function bookDialog({ patient, start, appointment } = {}) {
  return (async () => {
    const patients = patient ? [patient] : (await fhir.search('Patient')).sort((a, b) => patientName(a).localeCompare(patientName(b)));
    if (!patients.length) { toast('Register a patient first', { error: true }); return; }
    formDialog({
      title: appointment ? 'Reschedule appointment' : 'Book appointment', testid: 'booking-form', submitLabel: appointment ? 'Save' : 'Book',
      fields: [
        { name: 'patient', label: 'Patient', type: 'select', options: patients.map((p) => [p.id, `${patientName(p)} · ${mrn(p)}`]), value: appointment ? apptPatientId(appointment) : patient?.id, wide: true },
        { name: 'type', label: 'Appointment type', type: 'select', options: APPT_TYPES, value: appointment?.appointmentType?.text },
        { name: 'start', label: 'Start', type: 'datetime-local', required: true, value: toLocalInput(new Date(appointment?.start || start || Date.now() + 3600000)) },
        { name: 'duration', label: 'Duration (minutes)', type: 'select', options: [15, 30, 45, 60, 90], value: appointment?.minutesDuration || 30 },
        { name: 'provider', label: 'Provider', value: appointment ? apptPart(appointment, 'provider') : identity.display, required: true },
        { name: 'location', label: 'Location', value: appointment ? apptPart(appointment, 'location') : 'Clinic A' },
        { name: 'reason', label: 'Reason for visit', wide: true, value: appointment?.description },
      ],
      // Scheduling with insurance: say so when authorisation or a referral is missing. It warns; it never blocks the booking.
      onChange: (v, _c, extra) => { const key = `${v.patient}|${String(v.start).slice(0, 10)}|${v.type}`; if (extra.dataset.key === key) return; extra.dataset.key = key; scheduleWarnings(v.patient, String(v.start).slice(0, 10)).then((warnings) => { if (extra.dataset.key !== key) return; extra.replaceChildren(...(warnings.length ? [h('div', { class: 'banner warn', testid: 'booking-insurance', role: 'status' }, h('strong', {}, 'Insurance: '), warnings.join('. '))] : [])); }); },
      onSubmit: async (v) => {
        const begin = new Date(v.start);
        const body = {
          ...(appointment || { resourceType: 'Appointment', status: 'booked' }),
          appointmentType: { text: v.type }, description: v.reason || undefined, start: begin.toISOString(),
          end: new Date(begin.getTime() + Number(v.duration) * 60000).toISOString(), minutesDuration: Number(v.duration),
          participant: [
            { actor: { reference: `Patient/${v.patient}` }, status: 'accepted' },
            { type: [{ text: 'provider' }], actor: { display: v.provider }, status: 'accepted' },
            { type: [{ text: 'location' }], actor: { display: v.location }, status: 'accepted' },
          ],
        };
        if (appointment) await fhir.update(body); else await fhir.create(body);
        toast(appointment ? 'Appointment updated' : 'Appointment booked');
        render();
      },
    });
  })();
}

const APPT_NEXT = { booked: [['arrived', 'Check in'], ['noshow', 'No show'], ['cancelled', 'Cancel']], arrived: [['fulfilled', 'Complete visit'], ['cancelled', 'Cancel']], proposed: [['booked', 'Confirm'], ['cancelled', 'Cancel']], pending: [['booked', 'Confirm'], ['cancelled', 'Cancel']] };
export function apptDialog(a, p) {
  openDialog({ title: 'Appointment', testid: 'appt-dialog', body: [
    kv([['Patient', p ? patientLink(p) : ''], ['When', `${fmtDateTime(a.start)} · ${a.minutesDuration || ''} min`], ['Type', a.appointmentType?.text], ['Provider', apptPart(a, 'provider')], ['Location', apptPart(a, 'location')], ['Reason', a.description], ['Status', badge(a.status)]]),
  ], actions: [
    ...(APPT_NEXT[a.status] || []).map(([to, label]) => ({ label, kind: to === 'cancelled' || to === 'noshow' ? 'danger' : 'primary', testid: `appt-${to}`, write: true, perm: ['Appointment', 'transition'], onClick: async (close) => {
      if (view.readOnly) throw new Error('Read-only while viewing a past time');
      await fhir.transition(a, to); undefined; close(); render();
    } })),
    ...(a.status === 'booked' ? [{ label: 'Reschedule', testid: 'appt-reschedule', write: true, perm: ['Appointment', 'update'], onClick: (close) => { close(); bookDialog({ appointment: a }); } }] : []),
    { label: 'Close', onClick: (c) => c() },
  ] });
}

async function schedule(query) {
  const mode = query.get('view') || 'week';
  const anchor = query.get('date') ? new Date(`${query.get('date')}T00:00:00`) : new Date();
  anchor.setHours(0, 0, 0, 0);
  const monday = new Date(anchor); monday.setDate(anchor.getDate() - ((anchor.getDay() + 6) % 7)); monday.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(monday.getDate() + i); return d; });
  const appts = (await fhir.search('Appointment')).sort((a, b) => a.start.localeCompare(b.start));
  const patients = await patientsById(appts.map(apptPatientId));
  const shift = (n) => { const d = new Date(anchor); d.setDate(d.getDate() + n); go(`#/schedule?view=${mode}&date=${fmtDate(d)}`); };
  const step = mode === 'week' ? 7 : 1;
  const bar = h('div', { class: 'toolbar' },
    btn('◂ Previous', { testid: 'schedule-prev', onClick: () => shift(-step) }), btn('Today', { testid: 'schedule-today', onClick: () => go(`#/schedule?view=${mode}`) }), btn('Next ▸', { testid: 'schedule-next', onClick: () => shift(step) }),
    h('strong', { testid: 'schedule-range' }, mode === 'week' ? `${fmtDate(days[0])} to ${fmtDate(days[6])}` : fmtDate(anchor)), h('span', { class: 'grow' }),
    h('div', { class: 'seg' }, ['week', 'day'].map((m) => h('button', { type: 'button', testid: `schedule-view-${m}`, 'aria-label': `${m} view`, 'aria-pressed': String(mode === m), onClick: () => go(`#/schedule?view=${m}&date=${fmtDate(anchor)}`) }, m === 'week' ? 'Week grid' : 'Day list'))));
  let body;
  if (mode === 'day') {
    const rows = appts.filter((a) => fmtDate(a.start) === fmtDate(anchor));
    body = table({ testid: 'day-list', rows, onRow: (a) => apptDialog(a, patients.get(apptPatientId(a))), empty: 'No appointments on this day', columns: [
      { label: 'Time', cls: 'num', render: (a) => fmtTime(a.start) }, { label: 'Status', render: (a) => badge(a.status, a.status === 'arrived' ? 'warn' : a.status === 'fulfilled' ? 'ok' : a.status === 'booked' ? 'accent' : '') },
      { label: 'Patient', render: (a) => patientLink(patients.get(apptPatientId(a))) }, { label: 'Visit type', render: (a) => a.appointmentType?.text || '' },
      { label: 'Minutes', cls: 'num', render: (a) => a.minutesDuration || '' }, { label: 'Provider', render: (a) => apptPart(a, 'provider') }, { label: 'Location', render: (a) => apptPart(a, 'location') }, { label: 'Reason', render: (a) => a.description || '' },
    ] });
  } else {
    const grid = h('div', { class: 'week', testid: 'week-grid' }, h('div', { class: 'hd' }, ''), days.map((d) => h('div', { class: `hd${fmtDate(d) === fmtDate(new Date()) ? ' today' : ''}` }, `${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][(d.getDay() + 6) % 7]} ${d.getDate()}`)));
    for (let hour = 7; hour < 19; hour += 1) {
      grid.append(h('div', { class: 'time' }, `${String(hour).padStart(2, '0')}:00`));
      for (const d of days) {
        const slotStart = new Date(d); slotStart.setHours(hour, 0, 0, 0);
        const here = appts.filter((a) => { const s = new Date(a.start); return fmtDate(s) === fmtDate(d) && s.getHours() === hour; });
        grid.append(h('div', { class: 'slot', testid: `slot-${fmtDate(d)}-${hour}`, role: 'button', tabindex: 0, 'aria-label': `Book at ${fmtDate(d)} ${hour}:00`, onClick: (e) => { if (e.target === e.currentTarget && !view.readOnly && canWrite('Appointment', 'create')) bookDialog({ start: slotStart }); } },
          here.map((a) => h('button', { type: 'button', class: `appt ${a.status}`, testid: `appt-${a.id}`, 'aria-label': `Appointment ${fmtTime(a.start)} ${patientName(patients.get(apptPatientId(a)))}`, onClick: () => apptDialog(a, patients.get(apptPatientId(a))) },
            h('b', {}, fmtTime(a.start)), ' ', patientName(patients.get(apptPatientId(a))), h('div', { class: 'muted' }, a.appointmentType?.text || '')))));
      }
    }
    body = grid;
  }
  return page('Schedule', btn('Book appointment', { kind: 'primary', write: true, perm: ['Appointment', 'create'], testid: 'book-appointment', onClick: () => bookDialog() }), bar, body);
}

// ---------- Placeholders agreed for this phase ----------
async function frontDesk() {
  return page('Front desk', null,
    h('div', { class: 'banner info', testid: 'frontdesk-notice' }, h('strong', {}, 'Layout only.'), 'This screen is a placeholder agreed for this phase: it shows the appointment-desk layout but has no logic yet. Book, check in and cancel from Schedule. Coverage at check-in, below, is live.'),
    await coverageCard(render),
    h('div', { class: 'toolbar' }, h('input', { type: 'search', disabled: true, placeholder: 'Find patient', 'aria-label': 'Find patient (not active yet)', testid: 'frontdesk-search', style: 'max-width:18.75rem' }),
      ['Make appointment', 'Check in', 'Check out', 'Cancel', 'Reschedule', 'Add to wait list'].map((l) => btn(l, { disabled: true, testid: `frontdesk-${slug(l)}`, title: `${l}: not active yet` }))),
    h('div', { class: 'split' },
      h('div', { class: 'stack' }, card('Patient', h('p', { class: 'muted' }, 'Demographics, coverage and registration status will appear here.')),
        card('Future appointments', table({ testid: 'frontdesk-future', rows: [], empty: 'Not active yet', columns: ['Date', 'Time', 'Visit type', 'Provider', 'Department', 'Status'].map((label) => ({ label, render: () => '' })) }))),
      h('div', { class: 'stack' }, card('Past appointments', table({ testid: 'frontdesk-past', rows: [], empty: 'Not active yet', columns: ['Date', 'Visit type', 'Provider', 'Status', 'Check-out'].map((label) => ({ label, render: () => '' })) })),
        card('Wait list', table({ testid: 'frontdesk-waitlist', rows: [], empty: 'Not active yet', columns: ['Requested', 'Visit type', 'Provider', 'Priority'].map((label) => ({ label, render: () => '' })) })))));
}

async function billing() {
  return page('Business office', null, ...(await hospitalDesk(render)));
}

// ---------- Orders worklist ----------
async function ordersWorklist(query) {
  const category = query.get('category') || 'all';
  const status = query.get('status') || 'open';
  const all = (await fhir.search('ServiceRequest', { _sort: '-_lastUpdated' }));
  const patients = await patientsById(all.map((o) => refId(o.subject?.reference)));
  const cat = (o) => o.category?.[0]?.coding?.[0]?.code || 'other';
  const open = ['draft', 'active', 'results-received', 'report-signed'];
  const rows = all.filter((o) => (category === 'all' || cat(o) === category) && (status === 'all' || (status === 'open' ? open.includes(lifecycle(o)) : lifecycle(o) === status)));
  const select = (name, value, options) => h('select', { testid: `orders-filter-${name}`, 'aria-label': `Filter by ${name}`, style: 'width:auto', onChange: (e) => { const q = new URLSearchParams({ category, status }); q.set(name, e.target.value); go(`#/orders?${q}`); } }, options.map(([v, t]) => h('option', { value: v, selected: v === value }, t)));
  return page('Orders worklist', null,
    h('div', { class: 'toolbar' }, h('span', { class: 'small muted' }, 'Category'), select('category', category, [['all', 'All'], ['laboratory', 'Laboratory'], ['imaging', 'Imaging']]),
      h('span', { class: 'small muted' }, 'Status'), select('status', status, [['open', 'Open'], ['all', 'All'], ['active', 'Active'], ['completed', 'Completed'], ['revoked', 'Cancelled']]), h('span', { class: 'grow' }), h('span', { class: 'muted', testid: 'orders-count' }, `${rows.length} order${rows.length === 1 ? '' : 's'}`)),
    table({ testid: 'orders-table', rows, empty: 'No orders match these filters', onRow: (o) => openChart(patients.get(refId(o.subject.reference)), 'orders'), columns: [
      { label: 'Priority', render: (o) => badge((o.priority || 'routine').toUpperCase(), o.priority === 'stat' ? 'solid-danger' : o.priority === 'urgent' ? 'warn' : 'info') },
      { label: 'Ordered', render: (o) => fmtDateTime(o.authoredOn || o.meta.lastUpdated) }, { label: 'Patient', render: (o) => patientLink(patients.get(refId(o.subject.reference)), 'orders') },
      { label: 'Order', render: (o) => display(o.code) }, { label: 'Category', render: (o) => cat(o) }, { label: 'Ordered by', render: (o) => o.requester?.display || '' },
      { label: 'Status', render: (o) => badge(lifecycle(o), lifecycle(o) === 'completed' ? 'ok' : lifecycle(o) === 'revoked' ? '' : 'accent') },
    ] }));
}

// ---------- Inbox ----------
async function inbox(query) {
  const folder = query.get('folder') || 'messages';
  const [comms, tasks, serviceRequests, medRequests] = await Promise.all([fhir.search('Communication'), fhir.search('Task'), fhir.search('ServiceRequest'), fhir.search('MedicationRequest')]);
  // Nurse-entered (verbal, telephone, protocol) orders wait here for a physician's co-signature.
  const needsCosign = [...serviceRequests, ...medRequests].filter((o) => (o.extension || []).some((e) => e.url === 'urn:hospital-desktop:pending-cosign' && e.valueBoolean === true)).sort((a, b) => (b.authoredOn || '').localeCompare(a.authoredOn || ''));
  const fromPatient = comms.filter((c) => c.sender?.reference?.startsWith('Patient/')).sort((a, b) => (b.sent || '').localeCompare(a.sent || ''));
  // Pharmacy: orders the pharmacist has a question about, and notices of changes or rejections.
  const queriedText = (o) => (o.extension || []).find((e) => e.url === 'urn:hospital-desktop:queried')?.valueString;
  const queried = medRequests.filter((o) => queriedText(o)).sort((a, b) => (b.authoredOn || '').localeCompare(a.authoredOn || ''));
  const taskCode = (t) => t.code?.coding?.[0]?.code;
  const openTasks = tasks.filter((t) => ['requested', 'ready', 'accepted', 'in-progress'].includes(t.status));
  const folders = {
    messages: ['Patient messages', fromPatient.filter((c) => !c.received).length],
    refills: ['Refill requests', openTasks.filter((t) => taskCode(t) === 'refill-request').length],
    reports: ['Signed reports', openTasks.filter((t) => taskCode(t) === 'report-signed').length],
    followups: ['Follow-ups and requests', openTasks.filter((t) => !['refill-request', 'report-signed', 'message-triage', 'agent-proposal', 'prescriber-notice', 'rpm-alert'].includes(taskCode(t))).length],
    cosign: ['Needs co-signature', needsCosign.length],
    pharmacy: ['Pharmacy changes', openTasks.filter((t) => taskCode(t) === 'prescriber-notice').length + queried.length],
    monitoring: ['Monitoring alerts', openTasks.filter((t) => taskCode(t) === 'rpm-alert').length],
  };
  const insData = await insInboxData(); for (const [id, label] of Object.entries(INS_FOLDERS)) folders[id] = [label, (insData[id] || []).length];
  const patients = await patientsById([...fromPatient.map((c) => refId(c.subject?.reference)), ...tasks.map((t) => refId(t.for?.reference)), ...needsCosign.map((o) => refId(o.subject?.reference)), ...queried.map((o) => refId(o.subject?.reference))]);
  const who = (ref) => patients.get(refId(ref));
  const side = h('div', { class: 'card listnav' }, h('h3', {}, 'Folders'), Object.entries(folders).map(([id, [label, count]]) => h('button', { type: 'button', testid: `inbox-folder-${id}`, 'aria-label': `Inbox folder: ${label}`, 'aria-pressed': String(folder === id), onClick: () => go(`#/inbox?folder=${id}`) }, h('span', {}, label), count ? badge(count, 'accent') : null)));
  const complete = (t, to, label) => btn(label, { small: true, write: true, perm: ['Task', 'transition'], kind: to === 'rejected' ? 'danger' : '', testid: `task-${to}-${t.id}`, onClick: async () => {
    let reason;
    if (to === 'rejected') { reason = await askReason({ title: 'Deny request', label: 'Reason shown to the patient', submitLabel: 'Deny' }); if (!reason) return; }
    await fhir.transition(t, to, reason); toast(`Request ${to === 'completed' ? 'completed' : 'denied'}`); render();
  } });
  // The clinician's own triage decision for a message. Shadow agents make the same decision out of sight.
  const triageOf = (c) => tasks.filter((t) => taskCode(t) === 'message-triage' && t.focus?.reference === `Communication/${c.id}`).sort((a, b) => (b.authoredOn || '').localeCompare(a.authoredOn || ''))[0];
  const labelOf = (t) => (t?.output || []).find((o) => o.type?.text === 'triage-label')?.valueString || '';
  const triage = (c) => h('select', { testid: `message-triage-${c.id}`, 'aria-label': 'Set message priority', style: 'width:auto', disabled: view.readOnly || !canWrite('Task', 'create'), title: canWrite('Task', 'create') ? undefined : reasonFor('Task', 'create'), onClick: (e) => e.stopPropagation(), onChange: async (e) => {
    const label = e.target.value;
    if (!label) return;
    try {
      const task = await fhir.create({ resourceType: 'Task', status: 'requested', intent: 'order', priority: label === 'urgent' ? 'urgent' : 'routine', authoredOn: new Date().toISOString(), code: { coding: [{ system: 'urn:hospital-desktop:task', code: 'message-triage' }], text: 'Message triage' }, focus: { reference: `Communication/${c.id}` }, for: c.subject, description: `Priority: ${label}`, requester: { display: identity.display }, output: [{ type: { text: 'triage-label' }, valueString: label }] });
      await fhir.transition(task, 'completed');
      undefined; render();
    } catch (err) { showError(err); }
  } }, [['', 'Set priority'], ['urgent', 'Urgent'], ['routine', 'Routine'], ['low', 'Low']].map(([v, t]) => h('option', { value: v, selected: labelOf(triageOf(c)) === v }, t)));
  let body;
  let above = null;
  if (folder.startsWith('ins-')) body = insInbox(folder, insData, render);
  else if (folder === 'messages') {
    const pending = (await loadProposals({ status: 'pending' })).filter((p) => p.kind === 'triage');
    above = pending.length ? h('div', { testid: 'inbox-proposals', style: 'margin-bottom:1rem' }, pending.map((p) => {
      const msg = fromPatient.find((c) => `Communication/${c.id}` === p.subject);
      return h('div', {}, h('div', { class: 'muted small', style: 'margin:0 0 0.25rem' }, msg ? `${patientName(who(msg.subject.reference))} wrote: "${(msg.payload?.[0]?.contentString || '').slice(0, 140)}"` : 'Patient message'), proposalCard(p, { onDone: () => render() }));
    })) : null;
    body = table({ testid: 'inbox-messages', rows: fromPatient, empty: 'No patient messages', onRow: (c) => openChart(who(c.subject.reference), 'messages'), columns: [
      { label: '', render: (c) => (c.received ? '' : badge('New', 'accent')) }, { label: 'Received', render: (c) => fmtDateTime(c.sent) }, { label: 'Patient', render: (c) => patientLink(who(c.subject.reference), 'messages') },
      { label: 'Subject', render: (c) => c.topic?.text || '' }, { label: 'Message', render: (c) => (c.payload?.[0]?.contentString || '').slice(0, 90) },
      { label: 'Priority', render: (c) => [triage(c), triageOf(c)?.intent === 'proposal' ? badge('AI label, not confirmed', 'warn', `message-ai-label-${c.id}`) : null] },
      { label: '', cls: 'actions', render: (c) => btn('Open thread', { small: true, testid: `message-open-${c.id}`, onClick: () => openChart(who(c.subject.reference), 'messages') }) },
    ] });
  } else if (folder === 'cosign') {
    const modeOf = (o) => (o.extension || []).find((e) => e.url === 'urn:hospital-desktop:order-mode')?.valueCode || '';
    body = table({ testid: 'inbox-cosign', rows: needsCosign, empty: 'No orders are waiting for a co-signature', onRow: (o) => openChart(who(o.subject?.reference), o.resourceType === 'MedicationRequest' ? 'medications' : 'orders'), columns: [
      { label: 'Entered', render: (o) => fmtDateTime(o.authoredOn || o.meta.lastUpdated) }, { label: 'Patient', render: (o) => patientLink(who(o.subject?.reference), o.resourceType === 'MedicationRequest' ? 'medications' : 'orders') },
      { label: 'Order', render: (o) => display(o.medicationCodeableConcept || o.code) }, { label: 'Mode', render: (o) => badge(modeOf(o), 'warn') }, { label: 'Ordering physician', render: (o) => o.requester?.display || '' },
      { label: 'Entered by', render: (o) => (o.extension || []).find((e) => e.url === 'urn:hospital-desktop:entered-by')?.valueString || '' }, { label: 'Status', render: (o) => badge(lifecycle(o), 'accent') },
      { label: '', cls: 'actions', render: (o) => btn('Co-sign', { small: true, kind: 'primary', write: true, perm: [o.resourceType, 'cosign'], testid: `cosign-${o.id}`, onClick: async () => { await fhir.cosign(o); toast('Order co-signed'); render(); } }) },
    ] });
  } else if (folder === 'pharmacy') {
    const notices = tasks.filter((t) => taskCode(t) === 'prescriber-notice').sort((a, b) => (b.authoredOn || '').localeCompare(a.authoredOn || ''));
    const answer = (o) => btn('Answer', { small: true, kind: 'primary', write: true, perm: ['Communication', 'create'], testid: `answer-${o.id}`, onClick: () => formDialog({
      title: `Answer pharmacy about ${display(o.medicationCodeableConcept)}`, testid: 'answer-form', submitLabel: 'Send answer', intro: `Pharmacy asked: "${queriedText(o)}"`,
      fields: [{ name: 'message', label: 'Your answer', type: 'textarea', rows: 3, required: true, wide: true, testid: 'answer-message' }],
      onSubmit: async (v) => { if (v.message.length < 3) throw new Error('Type an answer'); await api.post(`/api/pharmacy/orders/${o.id}/answer`, { message: v.message }); toast('Answer sent to pharmacy'); render(); },
    }) });
    body = h('div', {},
      h('h3', {}, 'Questions from pharmacy'), table({ testid: 'inbox-pharmacy-queries', rows: queried, empty: 'No open questions from pharmacy', onRow: (o) => openChart(who(o.subject?.reference), 'medications'), columns: [
        { label: 'Ordered', render: (o) => fmtDateTime(o.authoredOn || o.meta.lastUpdated) }, { label: 'Patient', render: (o) => patientLink(who(o.subject?.reference), 'medications') }, { label: 'Medication', render: (o) => display(o.medicationCodeableConcept) },
        { label: 'Question', render: (o) => queriedText(o) }, { label: 'Prescriber', render: (o) => o.requester?.display || '' }, { label: '', cls: 'actions', render: answer },
      ] }),
      h('h3', { style: 'margin-top:1.25rem' }, 'Changes and rejections'), table({ testid: 'inbox-pharmacy', rows: notices, empty: 'No pharmacy changes or rejections', onRow: (t) => openChart(who(t.for?.reference), 'medications'), columns: [
        { label: 'Status', render: (t) => badge(t.status, t.status === 'completed' ? 'ok' : 'accent') }, { label: 'Received', render: (t) => fmtDateTime(t.authoredOn) },
        { label: 'Patient', render: (t) => patientLink(who(t.for?.reference), 'medications') }, { label: 'What', render: (t) => t.code?.text || display(t.code) }, { label: 'Details', render: (t) => t.description || '' }, { label: 'From', render: (t) => t.requester?.display || '' },
        { label: '', cls: 'actions', render: (t) => (['requested', 'ready', 'accepted'].includes(t.status) ? complete(t, 'completed', 'Seen') : '') },
      ] }));
  } else {
    const rows = folder === 'refills' ? tasks.filter((t) => taskCode(t) === 'refill-request') : folder === 'reports' ? tasks.filter((t) => taskCode(t) === 'report-signed') : folder === 'monitoring' ? tasks.filter((t) => taskCode(t) === 'rpm-alert') : tasks.filter((t) => !['refill-request', 'report-signed', 'message-triage', 'agent-proposal', 'prescriber-notice', 'rpm-alert'].includes(taskCode(t)));
    rows.sort((a, b) => (b.authoredOn || '').localeCompare(a.authoredOn || ''));
    body = table({ testid: `inbox-${folder}`, rows, empty: folder === 'reports' ? 'No signed reports yet. Reports arrive here when a radiologist signs in PACS.' : 'Nothing here', columns: [
      { label: 'Status', render: (t) => badge(t.status, t.status === 'completed' ? 'ok' : t.status === 'rejected' ? 'danger' : 'accent') }, { label: 'Received', render: (t) => fmtDateTime(t.authoredOn) },
      { label: 'Patient', render: (t) => patientLink(who(t.for?.reference), folder === 'refills' ? 'medications' : 'summary') }, { label: 'Request', render: (t) => t.code?.text || display(t.code) }, { label: 'Details', render: (t) => t.description || '' },
      { label: '', cls: 'actions', render: (t) => (['requested', 'ready', 'accepted'].includes(t.status) ? [complete(t, 'completed', folder === 'refills' ? 'Approve' : 'Done'), folder === 'reports' ? null : complete(t, 'rejected', 'Deny')] : (t.extension || []).find((e) => e.url === 'urn:hospital-desktop:status-reason')?.valueString || '') },
    ] });
  }
  // Problems with AI output can be reported from here, and a reporter sees their own reports and any question from the team.
  const mineBox = h('div', { testid: 'inbox-my-reports' }); const showMine = () => myReports().then((el) => mineBox.replaceChildren(h('h3', { style: 'margin-top:1.25rem' }, 'My problem reports'), el), () => {});
  showMine();
  return page('Inbox', reportProblemButton({}, { testid: 'inbox-report-problem', onFiled: showMine }), h('div', { class: 'lists' }, side, h('div', {}, above, body, mineBox)));
}

// ---------- Administration ----------
async function admin(query) {
  const tab = query.get('tab') || 'audit';
  const tabs = h('div', { class: 'toolbar' }, h('div', { class: 'seg' }, [['audit', 'Audit log'], ['datasets', 'Datasets'], ['api', 'API and integration'], ['envkeys', 'Environment keys'], ['storage', 'Storage and database'], ['settings', 'Session settings']].map(([id, label]) => h('button', { type: 'button', testid: `admin-tab-${id}`, 'aria-label': label, 'aria-pressed': String(tab === id), onClick: () => go(`#/admin?tab=${id}`) }, label))));
  let body;
  if (tab === 'audit') {
    const events = (await fhir.search('AuditEvent', { _sort: '-_lastUpdated', _count: 500 }));
    const ACTION = { C: 'Create', R: 'Read', U: 'Update', D: 'Delete', E: 'Execute' };
    const filter = h('input', { type: 'search', placeholder: 'Filter by text', testid: 'audit-filter', 'aria-label': 'Filter audit log', style: 'max-width:18.75rem' });
    const holder = h('div');
    const draw = () => { const f = filter.value.toLowerCase(); clear(holder).append(table({ testid: 'audit-table', rows: events.filter((e) => !f || JSON.stringify(e).toLowerCase().includes(f)), empty: 'No audit events', columns: [
      { label: 'Recorded', render: (e) => fmtDateTime(e.recorded) }, { label: 'Action', render: (e) => badge(ACTION[e.action] || e.action, e.action === 'R' ? 'info' : 'accent') },
      { label: 'Who', render: (e) => `${e.agent?.[0]?.who?.identifier?.value || ''} (${e.agent?.[0]?.type?.text || ''})` }, { label: 'Role', render: (e) => e.agent?.[0]?.who?.display || '' },
      { label: 'Record', cls: 'mono', render: (e) => e.entity?.[0]?.what?.reference || '' }, { label: 'Description', render: (e) => e.outcomeDesc || '' },
    ] })); };
    filter.addEventListener('input', draw); draw();
    body = [h('div', { class: 'toolbar' }, filter, h('span', { class: 'grow' }), h('span', { class: 'muted' }, `${events.length} most recent events on ${view.branch}`)), holder];
  } else if (tab === 'datasets') {
    const { datasets } = await api.get('/api/datasets');
    const KIND = { fhir: 'FHIR records', dicom: 'DICOM images', ecg: 'ECG (WFDB)' };
    body = card('Datasets', h('p', { class: 'muted' }, 'Read-only register of imported data (data/datasets.json): where each set came from, its licence note, and whether it is synthetic or under a restricted data use agreement. Imports are made with npm run import; see docs/DATA.md.'),
      table({ testid: 'datasets-table', rows: datasets, empty: 'No data sets have been imported. Use npm run import to load synthetic or public de-identified data.', columns: [
        { label: 'Source', render: (d) => d.source }, { label: 'Kind', render: (d) => badge(KIND[d.kind] || d.kind, 'info') }, { label: 'Licence note', render: (d) => d.licence || '' },
        { label: 'Files', cls: 'num', render: (d) => d.files }, { label: 'Patients', cls: 'num', render: (d) => (d.patients || []).length }, { label: 'Imported', render: (d) => fmtDateTime(d.importedAt) },
        { label: 'Flags', render: (d) => [d.restricted ? badge('Restricted', 'danger') : null, ' ', d.synthetic ? badge('Synthetic', 'ok') : null, !d.restricted && !d.synthetic ? h('span', { class: 'muted' }, 'none') : null] },
        { label: 'Checksum', cls: 'mono', render: (d) => (d.checksum || '').slice(0, 12) },
      ] }));
  } else if (tab === 'api') {
    const base = location.origin;
    const ex = (title, cmd) => { const pre = h('pre', { class: 'code' }, cmd); return h('div', {}, h('div', { class: 'toolbar' }, h('strong', {}, title), h('span', { class: 'grow' }), btn('Copy', { small: true, testid: `copy-${slug(title)}`, onClick: async () => { await navigator.clipboard.writeText(cmd); toast('Copied'); } })), pre); };
    body = card('API and integration', h('p', { class: 'muted' }, 'FHIR R4 over HTTP. No authentication by design: this is a local simulation. Headers label who is acting for the log.'),
      ex('Capability statement', `curl ${base}/fhir/R4/metadata`),
      ex('Search patients by family name', `curl "${base}/fhir/R4/Patient?family=smi"`),
      ex('Everything for one patient', `curl "${base}/fhir/R4/Patient/PATIENT_ID/\\$everything"`),
      ex('Read the chart as of a past time', `curl "${base}/fhir/R4/Observation?patient=PATIENT_ID&_asOf=2026-01-01T00:00:00Z"`),
      ex('All versions of a resource', `curl ${base}/fhir/R4/Observation/OBSERVATION_ID/_history`),
      ex('Create a patient', `curl -X POST ${base}/fhir/R4/Patient -H "Content-Type: application/json" -H "X-Role: physician" -d '{"resourceType":"Patient","name":[{"family":"Example","given":["Synthetic"]}],"birthDate":"1980-01-01","gender":"female"}'`),
      ex('Move a resource through its lifecycle', `curl -X POST "${base}/fhir/R4/MedicationRequest/ID/\\$transition" -H "Content-Type: application/json" -H "X-Role: physician" -d '{"to":"active"}'`),
      ex('Co-sign a nurse-entered order', `curl -X POST "${base}/fhir/R4/MedicationRequest/ID/\\$cosign" -H "Content-Type: application/json" -H "X-Role: physician"`),
      ex('The permission map', `curl ${base}/auth/roles`),
      ex('Full trace of a run', `curl "${base}/agent-ops/trace?runId=live"`));
  } else if (tab === 'storage') {
    // Plan-master 21.5: the active database and storage per kind (never keys), with Test connection.
    const d = await api.get('/api/admin/storage');
    const results = h('div', { testid: 'storage-test-results' });
    body = card('Storage and database', h('p', { class: 'muted' }, 'Where this server keeps its database and its files, by kind. Keys and connection strings are never shown here.'),
      kv([['Database', d.database.backend === 'postgres' ? `PostgreSQL at ${d.database.host}` : `SQLite file ${d.database.file}`], ['Storage provider', d.storage.provider]]),
      table({ testid: 'storage-table', rows: Object.entries(d.storage.kinds).map(([kind, v]) => ({ id: kind, kind, ...v })), columns: [{ label: 'Kind', render: (r) => r.kind }, { label: 'Adapter', render: (r) => badge(r.adapter, r.adapter === 'local' ? '' : 'accent') }, { label: 'Location', cls: 'mono', render: (r) => r.location }, { label: 'Encrypted', render: (r) => (r.encrypted ? badge('Yes', 'ok') : '') }, { label: 'Access and retention', render: (r) => r.rules }] }),
      h('div', { class: 'toolbar', style: 'margin-top:0.625rem' }, btn('Test connection', { kind: 'primary', testid: 'storage-test', onClick: async () => { const out = await api.post('/api/admin/storage/test', {}); clear(results).append(table({ testid: 'storage-test-table', rows: Object.entries(out.results).map(([kind, v]) => ({ id: kind, kind, ...v })), columns: [{ label: 'Kind', render: (r) => r.kind }, { label: 'Result', render: (r) => (r.ok ? badge('Connected', 'ok') : badge('Failed', 'danger')) }, { label: 'Detail', render: (r) => r.error || r.adapter }] })); } })), results);
  } else if (tab === 'envkeys') {
    // Plan-master 15.4: keys for trainers, scoped to task sets, stored hashed, tagged with the organisation.
    const { keys, enabled } = await api.get('/api/admin/env-keys');
    const makeKey = () => formDialog({ title: 'New environment key', testid: 'envkey-form', submitLabel: 'Make key', intro: 'The key is shown once and stored hashed. Type the organisation it is for; its episodes are tagged with that label.', fields: [{ name: 'org', label: 'Organisation label', required: true, wide: true, testid: 'envkey-org' }, { name: 'taskSets', label: 'Task sets this key can reach (comma separated ids; blank for all)', wide: true, testid: 'envkey-sets' }, { name: 'rateLimit', label: 'Requests a minute', type: 'number', value: 600, testid: 'envkey-rate' }, { name: 'evaluation', label: 'Evaluation key: may use held-out test tasks (never their checks or rubrics)', type: 'checkbox', testid: 'envkey-eval' }],
      onSubmit: async (v) => { const out = await api.post('/api/admin/env-keys', { org: v.org, taskSets: String(v.taskSets || '').split(',').map((x) => x.trim()).filter(Boolean), rateLimit: Number(v.rateLimit), evaluation: Boolean(v.evaluation) }); openDialog({ title: 'Your key (shown once)', testid: 'envkey-token', body: [h('p', {}, out.note), h('pre', { class: 'code', testid: 'envkey-token-text' }, out.token)], actions: [{ label: 'Done', kind: 'primary', testid: 'envkey-token-done', onClick: (c) => { c(); render(); } }] }); } });
    body = card('Environment keys', h('p', { class: 'muted' }, 'Keys let a lab\'s trainer use this hospital as an environment. ', enabled ? badge('Environment API on', 'ok') : badge('Environment API off: start the server with npm run env:serve', 'warn'), ' Keys never see held-out tasks unless marked evaluation, and never the checks or rubrics. One organisation cannot read another\'s episodes.'),
      h('div', { class: 'toolbar' }, btn('New key', { kind: 'primary', testid: 'envkey-new', onClick: makeKey })),
      table({ testid: 'envkeys-table', rows: keys, empty: 'No keys yet', columns: [{ label: 'Organisation', render: (k) => k.org }, { label: 'Prefix', cls: 'mono', render: (k) => `${k.prefix}…` }, { label: 'Task sets', render: (k) => k.taskSets.join(', ') }, { label: 'Rate limit', cls: 'num', render: (k) => k.rateLimit }, { label: 'Evaluation', render: (k) => (k.evaluation ? badge('Yes', 'warn') : '') }, { label: 'Made', render: (k) => fmtDateTime(k.createdAt) }, { label: 'Last used', render: (k) => (k.lastUsedAt ? fmtDateTime(k.lastUsedAt) : '') }, { label: 'Status', render: (k) => (k.revokedAt ? badge('Revoked', 'danger') : badge('Active', 'ok')) },
        { label: '', cls: 'actions', render: (k) => (k.revokedAt ? '' : btn('Revoke', { small: true, kind: 'danger', testid: `envkey-revoke-${k.id}`, onClick: async () => { if (await confirmDialog({ title: 'Revoke this key?', message: `Trainers using the ${k.org} key will be refused from now on.`, confirmLabel: 'Revoke', testid: 'envkey-revoke-confirm' })) { await api.del(`/api/admin/env-keys/${k.id}`); render(); } } })) }] }));
  } else {
    const { friction } = await api.get('/api/friction');
    body = card('Session settings', h('p', { class: 'muted' }, 'Friction level controls non-safety advisory pop-ups for this session. Safety alerts (duplicate orders, allergy conflicts, critical results) are always on.'),
      h('label', { class: 'field', style: 'max-width:17.5rem' }, h('span', {}, 'Friction level'), h('select', { testid: 'friction-select', 'aria-label': 'Friction level', onChange: async (e) => { await api.put('/api/friction', { level: e.target.value }); toast(`Friction set to ${e.target.value}`); } },
        [['low', 'Low: no advisories'], ['realistic', 'Realistic'], ['high', 'High: frequent advisories']].map(([v, t]) => h('option', { value: v, selected: v === friction }, t)))));
  }
  return page('Administration', null, tabs, body);
}

// ---------- Router ----------
// ---------- Tasks: everything due for the inpatients on a unit ----------
async function worklistScreen(query) {
  const unit = query.get('unit') || '';
  const [units, data] = await Promise.all([fhir.search('Location', { 'physical-type': 'wa' }), api.get('/api/nursing/worklist', unit ? { unit } : {})]);
  const select = h('select', { testid: 'worklist-unit-filter', 'aria-label': 'By unit', style: 'width:auto', onChange: (e) => go(e.target.value ? `#/worklist?unit=${encodeURIComponent(e.target.value)}` : '#/worklist') },
    [['', 'All units'], ...units.sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((u) => [u.name, u.name])].map(([v, t]) => h('option', { value: v, selected: v === unit }, t)));
  const overdue = data.patients.reduce((n, e) => n + e.overdue, 0);
  return page('Tasks', h('div', { class: 'toolbar' }, select, h('span', { class: 'muted small', testid: 'worklist-summary' }, `${data.patients.length} patient${data.patients.length === 1 ? '' : 's'} · ${overdue} overdue`)),
    data.patients.length ? worklistTable(data.patients, { openChart: true, testid: 'worklist-table' }) : h('div', { class: 'card empty', testid: 'worklist-empty' }, 'No inpatients on this unit'),
    h('p', { class: 'muted small' }, 'Medications due, vitals due, assessments, orders to acknowledge and specimens to collect, derived from the orders and schedules. Overdue items are flagged.'));
}

const SCREENS = { dashboard, worklist: worklistScreen, patients: patientsScreen, schedule, frontdesk: frontDesk, orders: ordersWorklist, inbox: inbox, billing, admin };
const notBuilt = (route) => page(NAV.find(([id]) => id === route)?.[1].slice(2) || route, null, h('div', { class: 'banner info', testid: 'not-built' }, h('strong', {}, 'Not built yet.'), ' This section is in the plan for a later part. The rest of the EHR works as usual.'));
let renderToken = 0;

/** The EHR home for this role: its landing page when that is in the EHR, otherwise its first visible section. */
function homeHash() {
  const l = landing();
  const route = l.hash.slice(2).split('?')[0];
  return l.app === 'ehr' && navIds().includes(route) ? l.hash : `#/${navIds()[0] || 'dashboard'}`;
}
/** Moves away from a screen the current role has no use for (on load and when "Work as" changes). Returns true when it navigated. */
function homeIfHidden() {
  const [path] = (location.hash.slice(2) || 'dashboard').split('?');
  const [route, id, activity] = path.split('/');
  let target = null;
  if (route === 'chart') {
    const tabs = visibleChartTabs(CHART_TABS.map(([t]) => t));
    if (!tabs.length) target = homeHash();
    else if (activity && activity !== 'visit-summary' && !tabs.includes(activity)) target = `#/chart/${id}/${tabs[0]}`;
  } else if (!navIds().includes(route)) target = homeHash();
  // Never redirect to the screen already showing: go() re-renders an unchanged hash, and render() would call back here for ever.
  if (!target || target.slice(2).split('?')[0] === path) return false;
  go(target);
  return true;
}
export async function render() {
  // A screen or tab the role has no use for is never rendered: the router moves to the role's home or first visible tab.
  if (homeIfHidden()) return;
  const token = renderToken += 1;
  const [path, queryString] = (location.hash.slice(2) || 'dashboard').split('?');
  const [route, ...rest] = path.split('/');
  const query = new URLSearchParams(queryString || '');
  const shellRoute = SCREENS[route] || route === 'chart' ? route : 'dashboard';
  try {
    const pending = loadScreen(route, rest, query);
    // Show the frame at once when the screen takes longer than a blink, so nothing sits blank.
    const quick = await Promise.race([pending.then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), 120))]);
    if (!quick && token === renderToken) await renderShell(shellRoute, h('main', { class: 'content', 'aria-busy': 'true', testid: 'screen-loading' }, h('p', { class: 'muted' }, 'Loading…')));
    const content = await pending;
    if (token === renderToken) await renderShell(shellRoute, content);
  } catch (err) {
    if (token !== renderToken) return;
    await renderShell(route, page('Could not load this screen', btn('Retry', { testid: 'retry', onClick: render }), h('div', { class: 'banner danger', testid: 'load-error' }, err.message)));
  }
}
async function loadScreen(route, rest, query) {
  {
    let content;
    if (route === 'chart') {
      const tab = openCharts.find((t) => t.id === rest[0]);
      content = await renderChart({ patientId: rest[0], activity: rest[1] || 'summary', sub: rest[2], query, go, render, shell, onLoaded: (p) => {
        if (!tab) { openCharts.push({ id: p.id, name: patientName(p) }); saveTabs(); }
        patientCache.set(p.id, p);
      } });
      if (patientContext.get() !== rest[0]) patientContext.set(rest[0]);
    } else if (!SCREENS[route] && currentPermission()?.nav.includes(route)) {
      content = notBuilt(route);
    } else {
      content = await (SCREENS[route] || dashboard)(query);
    }
    return content;
  }
}

window.addEventListener('hashchange', render);
// Changing "Work as" re-renders at once and moves to the role's landing page when this screen is not theirs.
window.addEventListener('hd:role', () => { if (!homeIfHidden()) render(); });
view.onChange(render);
// Another app changed the patient: follow it.
patientContext.onChange((id, { remote }) => { if (remote && id && !location.hash.includes(id)) go(`#/chart/${id}/summary`); });
if (!homeIfHidden()) render();
