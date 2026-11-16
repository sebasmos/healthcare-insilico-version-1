// Monitoring: the remote-patient-monitoring dashboard (one row per enrolled
// patient with latest readings, sparklines, adherence and open alerts), the
// alert queue sorted by severity then time, enrolment, and a patient page
// with charts, thresholds and alert actions.
import { h, clear, btn, badge, toast, table, card, kv, formDialog, initApp, timeStrip, fmtDateTime, fmtDate } from '/shared/ui.js';
import { api, view, fhir, patientName } from '/shared/fhir.js';

const root = document.getElementById('app');
const shell = await initApp({ app: 'monitoring', crumbs: { app: 'Monitoring', home: 'dashboard', names: { dashboard: 'Dashboard', alerts: 'Alerts', enrol: 'Enrol', patient: 'Patient' } } });
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
const NAV = [['dashboard', '▦ Dashboard'], ['alerts', '⚕ Alerts'], ['enrol', '☺ Enrol']];
const SEV = { stat: ['High', 'solid-danger'], urgent: ['Medium', 'warn'], routine: ['Low', 'info'] };
const sev = (p) => badge(SEV[p]?.[0] || p, SEV[p]?.[1] || '');
const svgEl = (tag, attrs = {}, ...kids) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); for (const k of kids) el.append(typeof k === 'string' ? document.createTextNode(k) : k); return el; };

function topbar(active) {
  return h('div', { class: 'topbar' }, h('span', { class: 'appname' }, 'Monitoring'), h('span', { class: 'dot' }, '·'),
    h('nav', { 'aria-label': 'Monitoring sections' }, NAV.map(([id, label]) => h('a', { href: `#/${id}`, testid: `nav-${id}`, 'aria-label': label.slice(2), 'aria-current': active === id ? 'page' : undefined }, label))),
    h('span', { class: 'spacer' }), shell.themeToggle, shell.roleSelect);
}
const page = (title, actions, ...children) => h('main', { class: 'content' }, h('div', { class: 'page-head' }, h('h1', {}, title), actions), ...children);
const mount = (active, content) => clear(root).append(...[topbar(active), timeStrip(), content].filter(Boolean));

/** A sparkline: the last readings of one kind. */
function spark(points, label) {
  const vals = points.map((p) => p.value);
  if (!vals.length) return h('span', { class: 'muted small' }, '—');
  const lo = Math.min(...vals); const hi = Math.max(...vals); const span = hi - lo || 1;
  const x = (i) => 4 + (i * 88) / Math.max(points.length - 1, 1); const y = (v) => 24 - ((v - lo) / span) * 20;
  const svg = svgEl('svg', { viewBox: '0 0 96 28', class: 'spark', role: 'img', 'aria-label': `${label}: ${vals.join(', ')}` }, svgEl('polyline', { points: points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ') }));
  points.forEach((p, i) => { if (p.flag) svg.append(svgEl('circle', { cx: x(i), cy: y(p.value), r: 2.5, class: 'flag' }, svgEl('title', {}, p.flag))); });
  return svg;
}
/** A line chart with threshold lines. */
function chart(points, { label, unit, low, high }) {
  const vals = points.map((p) => p.value).concat([low, high].filter((v) => v != null));
  const lo = Math.min(...vals) - 2; const hi = Math.max(...vals) + 2; const span = hi - lo || 1;
  const w = 720; const ht = 180; const pad = 40;
  const x = (i) => pad + (i * (w - pad - 10)) / Math.max(points.length - 1, 1); const y = (v) => ht - 24 - ((v - lo) / span) * (ht - 40);
  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${ht}`, class: 'chart', role: 'img', 'aria-label': `${label} over time`, 'data-testid': `chart-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` });
  for (const [v, name] of [[low, 'low limit'], [high, 'high limit']]) if (v != null) { svg.append(svgEl('line', { x1: pad, x2: w - 10, y1: y(v), y2: y(v), class: 'limit' })); svg.append(svgEl('text', { x: 2, y: y(v) + 4 }, `${v}`)); }
  svg.append(svgEl('text', { x: 2, y: 12 }, `${label} (${unit})`));
  if (points.length) svg.append(svgEl('polyline', { points: points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ') }));
  points.forEach((p, i) => svg.append(svgEl('circle', { cx: x(i), cy: y(p.value), r: 3, class: `pt${(high != null && p.value > high) || (low != null && p.value < low) ? ' out' : ''}` }, svgEl('title', {}, `${fmtDateTime(p.at)}: ${p.value} ${unit}${p.flag ? ` (${p.flag})` : ''}`))));
  if (points.length) { svg.append(svgEl('text', { x: pad, y: ht - 6 }, fmtDate(points[0].at))); svg.append(svgEl('text', { x: w - 90, y: ht - 6 }, fmtDate(points[points.length - 1].at))); }
  return svg;
}

const readingCell = (r, key) => (r.latest[key] ? h('span', { title: fmtDateTime(r.latest[key].at) }, `${r.latest[key].value}`, r.latest[key].flag ? ' ' : '', r.latest[key].flag ? badge('check device', 'warn') : null) : h('span', { class: 'muted' }, '—'));

async function dashboard() {
  const d = await api.get('/api/rpm/dashboard');
  const keys = ['sbp', 'dbp', 'hr', 'weight', 'glucose', 'spo2', 'temp'];
  mount('dashboard', page('Remote patient monitoring', btn('Enrol a patient', { kind: 'primary', write: true, perm: ['CarePlan', 'create'], testid: 'go-enrol', onClick: () => go('#/enrol') }),
    h('div', { class: 'metrics', testid: 'rpm-metrics' }, h('span', {}, 'Enrolled ', h('b', { testid: 'metric-enrolled' }, d.rows.length)), h('span', {}, 'Open alerts ', h('b', { testid: 'metric-alerts' }, d.alerts.length)), h('span', {}, 'Missed readings (2 days or more) ', h('b', { testid: 'metric-missed' }, d.missed.length)), h('span', {}, 'Time to acknowledge ', h('b', { testid: 'metric-tta' }, d.timeToAcknowledge.meanMinutes == null ? '—' : `${d.timeToAcknowledge.meanMinutes} min mean`), h('span', { class: 'muted' }, ` (${d.timeToAcknowledge.count} acknowledged)`))),
    table({ testid: 'rpm-rows', rows: d.rows, rowId: (r) => r.patient.id, empty: 'No patient is enrolled. Enrol one to start.', onRow: (r) => go(`#/patient/${r.patient.id}`), columns: [
      { label: 'Patient', render: (r) => [h('strong', {}, r.patient.name), h('div', { class: 'muted small mono' }, `${r.patient.mrn || ''} · ${r.programmeLabel}`)] },
      ...keys.map((k) => ({ label: d.readings[k].name.replace('Systolic blood pressure', 'Systolic').replace('Diastolic blood pressure', 'Diastolic').replace('Oxygen saturation', 'SpO2').replace('Body ', ''), cls: 'num', render: (r) => readingCell(r, k) })),
      { label: 'Trend', render: (r) => spark(r.series[r.programme === 'heart-failure' ? 'weight' : r.programme === 'diabetes' ? 'glucose' : r.programme === 'copd' ? 'spo2' : 'sbp'] || [], 'trend') },
      { label: 'Adherence', cls: 'num', render: (r) => (r.adherence?.percent == null ? '—' : h('span', {}, `${r.adherence.percent}%`, r.adherence.missed ? [' ', badge(`${r.adherence.missedDays} d missed`, 'danger')] : null)) },
      { label: 'Alerts', render: (r) => (r.openAlerts ? h('span', {}, sev(r.topSeverity), ` ${r.openAlerts}`, r.snoozed ? h('span', { class: 'muted small' }, ` (${r.snoozed} snoozed)`) : null) : badge('None', 'ok')) },
      { label: '', cls: 'actions', render: (r) => btn('Open', { small: true, testid: `open-${r.patient.id}`, onClick: () => go(`#/patient/${r.patient.id}`) }) },
    ] }),
    h('p', { class: 'muted small' }, 'Home readings are kept apart from in-hospital vitals and never trigger inpatient critical-result rules. Thresholds and rules are decision support in a simulation.')));
}

function alertActions(a, patientId) {
  const act = (action, body = {}) => async () => { await api.post(`/api/rpm/alerts/${a.id}/${action}`, body); toast(action === 'acknowledge' ? 'Acknowledged' : 'Done'); render(); };
  const ask = (action, title, fields) => () => formDialog({ title, testid: `alert-${action}-form`, submitLabel: title, fields, onSubmit: async (v) => { await api.post(`/api/rpm/alerts/${a.id}/${action}`, v); undefined; render(); } });
  const open = ['requested', 'ready', 'accepted', 'in-progress'].includes(a.status);
  if (!open) return h('span', { class: 'muted small' }, a.outcome ? `Closed: ${a.outcome}` : a.status);
  return h('div', { class: 'toolbar', style: 'margin:0' },
    a.status === 'requested' ? btn('Acknowledge', { small: true, kind: 'primary', write: true, perm: ['Task', 'transition'], testid: `alert-ack-${a.id}`, onClick: act('acknowledge') }) : null,
    btn('Message patient', { small: true, write: true, perm: ['Communication', 'create'], testid: `alert-message-${a.id}`, onClick: ask('message', 'Message patient', [{ name: 'text', label: 'Message', type: 'textarea', rows: 3, required: true, wide: true }]) }),
    btn('Call', { small: true, write: true, perm: ['Task', 'transition'], testid: `alert-call-${a.id}`, onClick: ask('call', 'Record a call', [{ name: 'to', label: 'Who was called', value: 'patient', required: true }, { name: 'note', label: 'Outcome of the call', type: 'textarea', rows: 3, wide: true }]) }),
    btn('Snooze', { small: true, write: true, perm: ['Task', 'transition'], testid: `alert-snooze-${a.id}`, onClick: ask('snooze', 'Snooze', [{ name: 'hours', label: 'Hours', type: 'number', value: 24, min: 1 }, { name: 'reason', label: 'Reason', required: true, wide: true }]) }),
    btn('Escalate', { small: true, kind: 'danger', write: true, perm: ['Task', 'transition'], testid: `alert-escalate-${a.id}`, onClick: ask('escalate', 'Escalate to the physician', [{ name: 'reason', label: 'Why', wide: true }]) }),
    btn('Order', { small: true, testid: `alert-order-${a.id}`, title: 'Open the chart to place an order', onClick: () => { window.open(`/ehr/#/chart/${patientId}/orders`, '_blank'); } }),
    btn('Close', { small: true, write: true, perm: ['Task', 'transition'], testid: `alert-close-${a.id}`, onClick: ask('close', 'Close with an outcome', [{ name: 'outcome', label: 'Outcome', required: true, wide: true }]) }));
}

async function alerts() {
  const d = await api.get('/api/rpm/dashboard');
  mount('alerts', page('Alerts', null, table({ testid: 'rpm-alerts', rows: d.alerts, empty: 'No open alert', columns: [
    { label: 'Severity', render: (a) => sev(a.priority) }, { label: 'When', cls: 'num', render: (a) => fmtDateTime(a.at) }, { label: 'Patient', render: (a) => (a.patient ? h('a', { href: `#/patient/${a.patient.id}`, testid: `alert-patient-${a.id}`, 'aria-label': `Open ${a.patient.name}` }, a.patient.name) : '') },
    { label: 'Alert', render: (a) => [a.message, a.snoozedUntil ? [' ', badge(`snoozed until ${fmtDateTime(a.snoozedUntil)}`, 'accent')] : null, a.acknowledged ? [' ', badge(`acknowledged after ${a.acknowledged.minutes} min`, 'ok')] : null] },
    { label: '', cls: 'actions', render: (a) => alertActions(a, a.patient?.id) }] }),
  h('p', { class: 'muted small' }, 'Sorted by severity, then time. Repeated alerts for the same excursion are de-duplicated; a snooze needs a reason.')));
}

async function enrol() {
  const d = await api.get('/api/rpm/dashboard');
  const patients = await fhir.search('Patient');
  const form = h('div', { class: 'form' });
  const dialog = () => formDialog({ title: 'Enrol in a monitoring programme', testid: 'enrol-form', wide: true, submitLabel: 'Enrol', fields: [
    { name: 'patient', label: 'Patient', type: 'select', options: patients.map((p) => [p.id, `${patientName(p)} (${(p.identifier || []).find((i) => i.type?.coding?.some((c) => c.code === 'MR'))?.value || ''})`]) },
    { name: 'programme', label: 'Programme', type: 'select', options: d.programmes.map((p) => [p.id, p.label]) },
    ...['sbp', 'dbp', 'hr', 'weight', 'glucose', 'spo2', 'temp'].flatMap((k) => [{ name: `${k}_low`, label: `${d.readings[k].name}: low limit (blank for the programme default)`, type: 'number', step: 'any' }, { name: `${k}_high`, label: `${d.readings[k].name}: high limit`, type: 'number', step: 'any' }]),
  ], onSubmit: async (v) => {
    const thresholds = {};
    for (const k of Object.keys(d.readings)) { const t = {}; if (v[`${k}_low`] != null) t.low = v[`${k}_low`]; if (v[`${k}_high`] != null) t.high = v[`${k}_high`]; if (Object.keys(t).length) thresholds[k] = t; }
    const r = await api.post('/api/rpm/enrol', { patient: v.patient, programme: v.programme, thresholds });
    toast(`Enrolled with ${r.devices.length} devices`); go(`#/patient/${v.patient}`);
  } });
  mount('enrol', page('Enrol', btn('Enrol a patient', { kind: 'primary', write: true, perm: ['CarePlan', 'create'], testid: 'enrol-open', onClick: dialog }),
    table({ testid: 'programmes', rows: d.programmes, rowId: (p) => p.id, columns: [{ label: 'Programme', render: (p) => p.label }, { label: 'Devices', render: (p) => p.devices.map((x) => d.devices[x]).join(', ') }, { label: 'Readings per day', render: (p) => Object.entries(p.schedule).map(([k, n]) => `${d.readings[k].name} ×${n}`).join(', ') }, { label: 'Default thresholds', render: (p) => Object.entries(p.thresholds).map(([k, t]) => `${k} ${t.low ?? '—'}–${t.high ?? '—'}`).join(', ') }] }), form));
}

async function patientPage(id) {
  const d = await api.get(`/api/rpm/patients/${id}`);
  const adjust = (key, t) => formDialog({ title: `Threshold: ${d.readingKinds[key].name}`, testid: 'threshold-form', submitLabel: 'Save', fields: [{ name: 'low', label: 'Low limit', type: 'number', step: 'any', value: t.low ?? '' }, { name: 'high', label: 'High limit', type: 'number', step: 'any', value: t.high ?? '' }], onSubmit: async (v) => { await api.put(`/api/rpm/thresholds/${t.goalId}`, v); undefined; render(); } });
  const left = h('div', { class: 'stack' },
    d.enrolled ? Object.keys({ ...d.thresholds, ...d.series }).map((k) => card(d.readingKinds[k].name, chart(d.series[k] || [], { label: d.readingKinds[k].name, unit: d.readingKinds[k].unit, low: d.thresholds[k]?.low, high: d.thresholds[k]?.high }))) : h('div', { class: 'card empty', testid: 'not-enrolled' }, 'Not enrolled'),
    card('Alerts', table({ testid: 'patient-alerts', rows: d.alerts, empty: 'No alert', columns: [{ label: 'Severity', render: (a) => sev(a.priority) }, { label: 'When', cls: 'num', render: (a) => fmtDateTime(a.at) }, { label: 'Alert', render: (a) => [a.message, a.notes.length ? h('ul', { class: 'muted small' }, a.notes.map((n) => h('li', {}, n))) : null] }, { label: 'Status', render: (a) => badge(a.status, a.status === 'completed' ? 'ok' : 'warn') }, { label: '', cls: 'actions', render: (a) => alertActions(a, id) }] })));
  const right = h('div', { class: 'stack' },
    card('Programme', d.enrolled ? [kv([['Programme', d.plan.label], ['Since', fmtDateTime(d.plan.since)], ['Readings per day', Object.entries(d.plan.schedule).map(([k, n]) => `${d.readingKinds[k].name} ×${n}`).join(', ')], ['Adherence (7 days)', d.adherence?.percent == null ? '—' : `${d.adherence.percent}%`], ['Last reading', d.adherence?.lastReading ? fmtDateTime(d.adherence.lastReading) : 'none'], ['Devices', d.devices.map((x) => x.name).join(', ')]]), btn('End programme', { small: true, kind: 'danger', write: true, perm: ['CarePlan', 'transition'], testid: 'end-programme', onClick: async () => { await api.post(`/api/rpm/programmes/${d.plan.id}/end`, { reason: 'Ended from the dashboard' }); toast('Programme ended'); go('#/dashboard'); } })] : h('p', { class: 'muted' }, 'Not enrolled. Enrol from the Enrol page.')),
    d.enrolled ? card('Thresholds', table({ testid: 'thresholds', rows: Object.entries(d.thresholds).map(([k, t]) => ({ key: k, ...t })), rowId: (r) => r.key, columns: [{ label: 'Reading', render: (r) => d.readingKinds[r.key].name }, { label: 'Low', cls: 'num', render: (r) => r.low ?? '—' }, { label: 'High', cls: 'num', render: (r) => r.high ?? '—' }, { label: '', cls: 'actions', render: (r) => btn('Adjust', { small: true, write: true, perm: ['Goal', 'update'], testid: `adjust-${r.key}`, onClick: () => adjust(r.key, r) }) }] })) : null,
    card('Latest readings', kv(Object.entries(d.latest).map(([k, v]) => [d.readingKinds[k].name, `${v.value} ${d.readingKinds[k].unit} (${fmtDateTime(v.at)})${v.flag ? ' · check device' : ''}`]))));
  mount('dashboard', page(`${d.patient.name}`, btn('◂ Dashboard', { testid: 'back', onClick: () => go('#/dashboard') }), h('div', { class: 'patient' }, left, right)));
}

let token = 0;
async function render() {
  const mine = token += 1;
  const [path] = (location.hash.slice(2) || 'dashboard').split('?');
  const [route, id] = path.split('/');
  try {
    if (route === 'patient' && id) await patientPage(id);
    else if (route === 'alerts') await alerts();
    else if (route === 'enrol') await enrol();
    else await dashboard();
  } catch (err) {
    if (mine !== token) return;
    mount(route, page('Could not load this screen', btn('Retry', { testid: 'retry', onClick: render }), h('div', { class: 'banner danger', testid: 'load-error' }, err.message)));
  }
}
window.addEventListener('hashchange', render);
window.addEventListener('hd:role', render);
view.onChange(render);
if (!location.hash) history.replaceState(null, '', '#/dashboard');
render();
