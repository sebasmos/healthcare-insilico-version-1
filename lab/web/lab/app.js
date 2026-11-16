// Lab: worklists by bench, the specimen page (collection, receipt, result
// entry with delta checks, verification), criticals to phone, quality
// control with a Levey-Jennings plot, and auto-verification rules.
// Every write goes through /api/lab, where the server applies the state
// machines, the role map and the log.
import { h, clear, btn, badge, toast, table, card, kv, formDialog, confirmDialog, initApp, timeStrip, fmtDateTime, fmtTime, slug } from '/shared/ui.js';
import { api, view, identity } from '/shared/fhir.js';

const root = document.getElementById('app');
const shell = await initApp({ app: 'lab', crumbs: { app: 'Lab', home: 'worklist', names: { worklist: 'Worklist', criticals: 'Criticals', qc: 'Quality control', rules: 'Auto-verification', hl7: 'HL7', specimen: 'Specimen' }, resolve: (segments) => (segments[0] === 'specimen' ? [['Worklist', '#/worklist'], ['Specimen', location.hash.split('?')[0]]] : null) } });
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
const NAV = [['worklist', '☑ Worklist'], ['criticals', '⚕ Criticals'], ['qc', '▦ Quality control'], ['rules', '⚙ Auto-verification'], ['hl7', '✉ HL7']];
const PRIORITY = { stat: ['STAT', 'solid-danger'], urgent: ['Urgent', 'warn'], routine: ['Routine', 'info'] };
const STATE = { ordered: ['Ordered', ''], collected: ['Collected', 'accent'], 'in-transit': ['In transit', 'accent'], received: ['Received', 'ok'], 'in-process': ['In process', 'ok'], resulted: ['Resulted (preliminary)', 'warn'], verified: ['Verified', 'ok'], corrected: ['Corrected', 'ok'], rejected: ['Rejected', 'danger'] };
const minutes = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`);
const prio = (p) => badge(PRIORITY[p]?.[0] || p, PRIORITY[p]?.[1] || '');
const stateBadge = (s, testid) => badge(STATE[s]?.[0] || s, STATE[s]?.[1] || '', testid);
const patientCell = (r) => [h('strong', {}, r.patient?.name || ''), h('div', { class: 'muted small mono' }, r.patient?.mrn || '')];

function topbar(active) {
  return h('div', { class: 'topbar' }, h('span', { class: 'appname' }, 'Lab'), h('span', { class: 'dot' }, '·'),
    h('nav', { 'aria-label': 'Lab sections' }, NAV.map(([id, label]) => h('a', { href: `#/${id}`, testid: `nav-${id}`, 'aria-label': label.slice(2), 'aria-current': active === id ? 'page' : undefined }, label))),
    h('span', { class: 'spacer' }), shell.themeToggle, shell.roleSelect);
}
const page = (title, actions, ...children) => h('main', { class: 'content' }, h('div', { class: 'page-head' }, h('h1', {}, title), actions), ...children);
const mount = (active, content) => clear(root).append(...[topbar(active), timeStrip(), content].filter(Boolean));

function turnaroundStrip(t) {
  return h('div', { class: 'metrics', testid: 'turnaround' }, ...['stat', 'urgent', 'routine'].map((p) => h('span', {}, `${PRIORITY[p][0]} collection to verified `, h('b', { testid: `tat-${p}` }, t[p].meanMinutes == null ? '—' : minutes(t[p].meanMinutes)), h('span', { class: 'muted' }, ` (target ${minutes(t[p].targetMinutes)}, ${t[p].withinTargetPercent == null ? '—' : `${t[p].withinTargetPercent}%`} within, ${t[p].count} verified)`))));
}

// ---------- Worklist ----------
async function worklist(bench) {
  const d = await api.get('/api/lab/worklist', bench ? { bench } : {});
  const collectDialog = (o) => formDialog({ title: `Collect: ${o.test}`, testid: 'collect-form', submitLabel: 'Collect', intro: 'Scan the wristband, then the tube label (simulated: type or scan). The server checks both against the order.',
    fields: [{ name: 'patientScan', label: 'Wristband scan (MRN)', required: true }, { name: 'tubeLabel', label: 'Tube label scan (order id)', required: true }, { name: 'type', label: 'Specimen type', type: 'select', options: [['Blood', 'Blood'], ['Urine', 'Urine'], ['Swab', 'Swab'], ['CSF', 'CSF']] }],
    onSubmit: async (v) => { const s = await api.post('/api/lab/specimens/collect', { order: o.id, ...v }); undefined; go(`#/specimen/${s.id}`); } });
  const ageCell = (r) => h('span', { class: `elapsed${r.overTarget ? ' late' : ''}` }, minutes(r.turnaroundMinutes ?? r.ageMinutes), r.overTarget ? ' (over target)' : '');
  const specTable = (rows, testid, extra = []) => table({ testid, rows, empty: 'Nothing here', onRow: (r) => (r.orderOnly ? null : go(`#/specimen/${r.id}`)), columns: [
    { label: 'Priority', render: (r) => prio(r.priority) }, { label: 'Patient', render: patientCell }, { label: 'Test', render: (r) => r.test }, { label: 'Accession', cls: 'mono', render: (r) => r.accession || '—' }, { label: 'Bench', render: (r) => r.bench || '' }, { label: 'State', render: (r) => stateBadge(r.state, `state-${r.id}`) }, { label: 'Clock', cls: 'num', render: ageCell }, ...extra,
    { label: '', cls: 'actions', render: (r) => (r.orderOnly ? h('span', { class: 'muted small' }, 'Entered in the EHR without a specimen') : btn('Open', { small: true, testid: `open-${r.id}`, onClick: () => go(`#/specimen/${r.id}`) })) },
  ] });
  const benchSeg = h('div', { class: 'seg' }, [['', 'All benches'], ...d.benches.map((b) => [b, b])].map(([id, label]) => h('button', { type: 'button', testid: `bench-${id || 'all'}`, 'aria-label': label, 'aria-pressed': String((bench || '') === id), onClick: () => go(`#/worklist${id ? `?bench=${id}` : ''}`) }, label)));
  mount('worklist', page('Laboratory worklist', benchSeg, turnaroundStrip(d.turnaround),
    card(`Pending collection (${d.counts.pendingCollection})`, table({ testid: 'pending-collection', rows: d.pendingCollection, empty: 'No orders waiting for collection', columns: [
      { label: 'Priority', render: (r) => prio(r.priority) }, { label: 'Patient', render: patientCell }, { label: 'Test', render: (r) => r.test }, { label: 'Ordered', cls: 'num', render: (r) => fmtDateTime(r.authoredOn) }, { label: 'Waiting', cls: 'num', render: (r) => minutes(r.ageMinutes) },
      { label: '', cls: 'actions', render: (r) => btn('Collect', { small: true, kind: 'primary', write: true, perm: ['Specimen', 'create'], testid: `collect-${r.id}`, onClick: () => collectDialog(r) }) }] })),
    card(`Pending receipt (${d.counts.pendingReceipt})`, specTable(d.pendingReceipt, 'pending-receipt')),
    card(`In process${bench ? ` · ${bench}` : ''} (${d.counts.inProcess})`, specTable(d.inProcess, 'in-process')),
    card(`Awaiting verification (${d.counts.awaitingVerification})`, specTable(d.awaitingVerification, 'awaiting-verification')),
    card(`Histology requests (${(d.histology || []).length})`, table({ testid: 'histology-requests', rows: d.histology || [], empty: 'No recuts, levels or stains requested by pathology', columns: [
      { label: 'Priority', render: (r) => prio(r.priority) }, { label: 'Patient', render: patientCell }, { label: 'Case', cls: 'mono', render: (r) => `${r.accession} · block ${r.blockLabel}` }, { label: 'Request', render: (r) => r.text }, { label: 'Requested', cls: 'num', render: (r) => fmtDateTime(r.authoredOn) },
      { label: 'Next', render: () => h('span', { class: 'muted small' }, 'Scan the new slide and upload it to the case in Pathology') }] })),
    h('p', { class: 'muted small' }, 'STAT first. The clock runs from collection; targets 60 min STAT, 120 urgent, 240 routine.')));
}

// ---------- Specimen page ----------
async function specimen(id) {
  const s = await api.get(`/api/lab/specimens/${id}`);
  const act = (to, body = {}) => async () => { await api.post(`/api/lab/specimens/${id}/${to}`, body); undefined; render(); };
  const rejectDialog = () => formDialog({ title: 'Reject at receipt', testid: 'reject-form', submitLabel: 'Reject and request recollection', fields: [{ name: 'reason', label: 'Reason', type: 'select', options: ['haemolysed', 'clotted', 'unlabelled', 'insufficient', 'wrong tube', 'leaked'].map((r) => [r, r]) }], onSubmit: async (v) => { await api.post(`/api/lab/specimens/${id}/rejected`, v); toast('Rejected; a recollection task was sent to the nurse'); render(); } });
  const receiveDialog = () => formDialog({ title: 'Receive specimen', testid: 'receive-form', submitLabel: 'Receive', fields: [{ name: 'bench', label: 'Bench', type: 'select', options: ['chemistry', 'haematology', 'coagulation', 'microbiology'].map((b) => [b, b]), value: s.bench || 'chemistry' }], onSubmit: async (v) => { await api.post(`/api/lab/specimens/${id}/received`, v); toast('Received and accessioned'); render(); } });
  const actions = h('div', { class: 'toolbar' },
    s.state === 'collected' ? btn('Send to lab', { small: true, write: true, perm: ['Specimen', 'transition'], testid: 'specimen-transit', onClick: act('in-transit') }) : null,
    ['collected', 'in-transit'].includes(s.state) ? [btn('Receive', { small: true, kind: 'primary', write: true, perm: ['Specimen', 'transition'], testid: 'specimen-receive', onClick: receiveDialog }), btn('Reject', { small: true, kind: 'danger', write: true, perm: ['Specimen', 'transition'], testid: 'specimen-reject', onClick: rejectDialog })] : null,
    s.state === 'received' ? btn('Start processing', { small: true, write: true, perm: ['Specimen', 'transition'], testid: 'specimen-process', onClick: act('in-process') }) : null,
    s.state === 'resulted' ? btn('Verify results', { small: true, kind: 'primary', write: true, perm: ['Observation', 'sign'], testid: 'specimen-verify', onClick: async () => { if (!(await confirmDialog({ title: 'Verify results', message: 'Release every preliminary result on this specimen as final. A second technologist must do this.', confirmLabel: 'Verify', testid: 'verify-confirm' }))) return; const r = await api.post(`/api/lab/specimens/${id}/verify`, {}); toast(`Verified ${r.verified.length} result${r.verified.length === 1 ? '' : 's'}${r.verified.some((x) => x.critical) ? '. Critical value: phone it from the Criticals page' : ''}`); render(); } }) : null);
  const entry = () => {
    const fields = s.analytes.filter((a) => !a.result || a.result.status === 'preliminary').map((a) => ({ name: a.code, label: `${a.name} (${a.unit}) · ref ${a.low ?? ''}–${a.high ?? ''}${a.previous ? ` · previous ${a.previous.value}` : ''}`, type: 'number', step: 'any', value: a.result?.value ?? '' }));
    formDialog({ title: `Enter results · ${s.order?.test || ''}`, testid: 'results-form', wide: true, submitLabel: 'Save preliminary results', intro: 'Values are flagged against the reference range and delta-checked against the previous result. Results stay preliminary until a second technologist verifies them, unless an auto-verification rule applies.', fields, onSubmit: async (v) => { const r = await api.post(`/api/lab/specimens/${id}/results`, { values: v }); toast(`Saved ${r.written.length}${r.autoVerified.length ? `, ${r.autoVerified.length} auto-verified` : ''}`); render(); } });
  };
  const flagBadge = (f) => (f && f !== 'N' ? badge(f, f.length === 2 ? 'solid-danger' : 'danger') : '');
  const results = table({ testid: 'analytes', rows: s.analytes, rowId: (a) => a.code, columns: [
    { label: 'Analyte', render: (a) => [a.name, a.autoVerify ? [' ', badge('auto-verify rule', 'accent')] : null] }, { label: 'Result', cls: 'num', render: (a) => (a.result ? `${a.result.value} ${a.unit}` : '') }, { label: 'Reference', cls: 'num', render: (a) => `${a.low ?? ''}–${a.high ?? ''}` }, { label: 'Flag', render: (a) => flagBadge(a.result?.flag) },
    { label: 'Delta', render: (a) => (a.result?.delta ? badge('Delta', 'warn', `delta-${a.code}`) : '') }, { label: 'Previous', cls: 'num', render: (a) => (a.previous ? `${a.previous.value} (${fmtDateTime(a.previous.at)})` : '') },
    { label: 'Status', render: (a) => (a.result ? [badge(a.result.status, a.result.status === 'preliminary' ? 'warn' : 'ok', `result-status-${a.code}`), a.result.autoVerified ? [' ', badge('auto', 'accent')] : null, a.result.phoned ? [' ', badge(`Phoned to ${a.result.phoned.to}`, 'ok')] : null] : h('span', { class: 'muted' }, 'not entered')) },
  ] });
  const qc = s.qc.filter((q) => q.points).map((q) => h('div', { class: q.outOfRange ? 'banner danger' : 'banner info', testid: `qc-${q.code}` }, `QC ${q.code}: ${q.outOfRange ? `OUT OF RANGE (z ${q.lastZ}); results cannot be verified` : `in range (z ${q.lastZ})`}`));
  mount('worklist', page(`Specimen ${s.accession || ''}`, btn('◂ Worklist', { testid: 'back', onClick: () => go('#/worklist') }),
    h('div', { class: 'specimen' },
      h('div', { class: 'stack' }, card('Results', actions, qc, h('div', { class: 'toolbar' }, ['received', 'in-process', 'resulted'].includes(s.state) ? btn('Enter results', { kind: 'primary', write: true, perm: ['Observation', 'create'], testid: 'enter-results', onClick: entry }) : h('span', { class: 'muted small' }, s.state === 'verified' || s.state === 'corrected' ? 'Verified. Corrections go through the result itself.' : 'Results can be entered once the specimen is received.')), results, h('p', { class: 'muted small' }, 'Delta limits and reference ranges are an unverified starter set.'))),
      h('div', { class: 'stack' }, card('Specimen', kv([['State', stateBadge(s.state, 'specimen-state')], ['Accession', h('span', { class: 'mono' }, s.accession || 'not yet accessioned')], ['Type', s.type], ['Bench', s.bench], ['Collected', `${fmtDateTime(s.collectedAt)} by ${s.collector || ''}`], ['Received', s.receivedAt ? fmtDateTime(s.receivedAt) : '—'], ['Tube label', h('span', { class: 'mono' }, s.tubeLabel || '')], ['Rejection', s.rejection]])),
        card('Order', kv([['Patient', `${s.patient?.name || ''} (${s.patient?.mrn || ''})`], ['Test', s.order?.test], ['Priority', prio(s.order?.priority)], ['Ordered', s.order ? `${fmtDateTime(s.order.authoredOn)} by ${s.order.requester || ''}` : ''], ['Order state', s.order?.lifecycle]]))))));
}

// ---------- Criticals ----------
async function criticals() {
  const d = await api.get('/api/lab/worklist');
  const phone = (r) => formDialog({ title: `Phone critical value: ${r.test} ${r.value} ${r.unit}`, testid: 'phone-form', submitLabel: 'Record the call', fields: [{ name: 'to', label: 'Who was called', required: true }, { name: 'readBack', label: 'Read back confirmed', type: 'checkbox' }], onSubmit: async (v) => { await api.post(`/api/lab/results/${r.id}/phone`, { to: v.to, readBack: v.readBack }); undefined; render(); } });
  mount('criticals', page('Critical values to phone', null, table({ testid: 'criticals', rows: d.criticals, empty: 'No critical value is waiting to be phoned', columns: [
    { label: 'Patient', render: patientCell }, { label: 'Test', render: (r) => r.test }, { label: 'Value', cls: 'num', render: (r) => `${r.value} ${r.unit || ''}` }, { label: 'Flag', render: (r) => badge(r.flag, 'solid-danger') }, { label: 'Resulted', cls: 'num', render: (r) => fmtDateTime(r.at) }, { label: 'Physician ack', render: (r) => badge(r.acknowledged ? 'Acknowledged' : 'Not yet', r.acknowledged ? 'ok' : 'warn') },
    { label: '', cls: 'actions', render: (r) => btn('Phone', { small: true, kind: 'primary', write: true, perm: ['Observation', 'update'], testid: `phone-${r.id}`, onClick: () => phone(r) }) }] }),
  h('p', { class: 'muted small' }, 'A critical value counts as communicated only when who was called, when, and a read-back are recorded. The physician still acknowledges it in the EHR.')));
}

// ---------- Quality control ----------
function ljPlot(series) {
  const w = 760; const hgt = 220; const pad = 36;
  const n = Math.max(series.points.length, 2);
  const x = (i) => pad + (i * (w - 2 * pad)) / (n - 1);
  const y = (z) => hgt / 2 - z * ((hgt / 2 - 20) / 3.5);
  const line = (z, cls) => h('line', { x1: pad, x2: w - pad, y1: y(z), y2: y(z), class: cls });
  const svgEl = (tag, attrs, ...kids) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); for (const k of kids) el.append(k); return el; };
  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${hgt}`, class: 'lj', role: 'img', 'aria-label': `Levey-Jennings plot for ${series.name}, ${series.analyser}, ${series.level}`, 'data-testid': `lj-${series.analyte}` });
  for (const [z, cls] of [[0, 'mean'], [2, 'sd2'], [-2, 'sd2'], [3, 'sd3'], [-3, 'sd3']]) { const l = line(z, cls); svg.append(svgEl('line', { x1: l.getAttribute('x1'), x2: l.getAttribute('x2'), y1: l.getAttribute('y1'), y2: l.getAttribute('y2'), class: cls })); }
  for (const [z, label] of [[0, 'mean'], [2, '+2 SD'], [-2, '-2 SD'], [3, '+3 SD'], [-3, '-3 SD']]) svg.append(svgEl('text', { x: 2, y: y(z) + 4 }, document.createTextNode(label)));
  svg.append(svgEl('polyline', { points: series.points.map((p, i) => `${x(i)},${y(Math.max(-3.5, Math.min(3.5, p.z)))}`).join(' ') }));
  series.points.forEach((p, i) => svg.append(svgEl('circle', { cx: x(i), cy: y(Math.max(-3.5, Math.min(3.5, p.z))), r: 4, class: `pt${Math.abs(p.z) > 2 ? ' out' : ''}` }, svgEl('title', {}, document.createTextNode(`${fmtDateTime(p.at)}: ${p.value} (z ${p.z})`)))));
  return svg;
}
async function qc() {
  const d = await api.get('/api/lab/qc');
  const add = () => formDialog({ title: 'Record a QC result', testid: 'qc-form', submitLabel: 'Record', fields: [
    { name: 'analyte', label: 'Analyte', type: 'select', options: d.analytes.map((a) => [a.code, `${a.name} (${a.unit})`]) }, { name: 'analyser', label: 'Analyser', value: 'Analyser 1' }, { name: 'level', label: 'Control level', type: 'select', options: [['Level 1', 'Level 1'], ['Level 2', 'Level 2']] },
    { name: 'mean', label: 'Lot mean', type: 'number', step: 'any', required: true }, { name: 'sd', label: 'Lot SD', type: 'number', step: 'any', required: true }, { name: 'value', label: 'Measured value', type: 'number', step: 'any', required: true },
  ], onSubmit: async (v) => { const r = await api.post('/api/lab/qc', v); toast(r.outOfRange ? `Out of range (z ${r.lastZ}): verification is blocked for this analyte` : `In range (z ${r.lastZ})`); render(); } });
  mount('qc', page('Quality control', btn('Record QC', { kind: 'primary', write: true, perm: ['Observation', 'create'], testid: 'qc-add', onClick: add }),
    d.series.length ? d.series.map((s) => card(`${s.name} · ${s.analyser} · ${s.level}`, h('div', { class: 'toolbar' }, badge(s.outOfRange ? 'Out of range: release blocked' : 'In range', s.outOfRange ? 'danger' : 'ok', `qc-status-${s.analyte}`), h('span', { class: 'muted small' }, `mean ${s.mean}, SD ${s.sd}${s.rules.length ? ` · rules: ${s.rules.join(', ')}` : ''}`)), ljPlot(s))) : h('div', { class: 'card empty', testid: 'qc-empty' }, 'No QC recorded yet'),
    h('p', { class: 'muted small' }, 'A point beyond 2 SD blocks verification for that analyte until a later point is back in range. Rules shown: 1-2s, 1-3s, 2-2s, 10x.')));
}

// ---------- Auto-verification rules ----------
async function rules() {
  const [cfg, qcd] = await Promise.all([api.get('/api/lab/autoverify'), api.get('/api/lab/qc')]);
  const boxes = qcd.analytes.map((a) => h('label', { class: 'field', style: 'flex-direction:row; gap:0.5rem; align-items:center' }, h('input', { type: 'checkbox', testid: `rule-${a.code}`, 'aria-label': `Auto-verify ${a.name}`, checked: cfg.autoVerify.includes(a.code), value: a.code }), h('span', {}, `${a.name} (${a.unit})`)));
  mount('rules', page('Auto-verification rules', btn('Save rules', { kind: 'primary', write: true, perm: ['Observation', 'sign'], testid: 'rules-save', onClick: async () => { const list = boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value); await api.put('/api/lab/autoverify', { autoVerify: list }); undefined; } }),
    h('p', { class: 'muted small' }, 'A result for a ticked analyte is released as final at entry when it is in range, has no delta flag, is not critical, and the latest QC for the analyte is in range. Auto-verification is logged as a system action.'), h('div', { class: 'form' }, boxes)));
}

// ---------- HL7 v2: quarantine with fix and replay; outbound messages to view and download ----------
async function hl7() {
  const [inbound, outbound] = await Promise.all([api.get('/api/hl7/messages', { direction: 'in' }), api.get('/api/hl7/messages', { direction: 'out' })]);
  const quarantined = inbound.messages.filter((m) => m.status === 'quarantined');
  const fix = async (m) => {
    const raw = await (await fetch(`/api/hl7/messages/${m.id}/raw`, { headers: { 'X-Role': identity.role } })).text();
    formDialog({ title: `Fix and replay ${m.controlId || m.id}`, testid: 'hl7-fix-form', wide: true, submitLabel: 'Replay', intro: `Refused: ${m.error}. Edit the message below and replay it; the original stays in the log.`,
      fields: [{ name: 'text', label: 'Message', type: 'textarea', rows: 12, required: true, wide: true, value: raw }],
      onSubmit: async (v) => { const r = await api.post(`/api/hl7/messages/${m.id}/replay`, { text: v.text }); if (r.ackCode !== 'AA') throw new Error(`Still refused: ${r.error}`); toast('Replayed and accepted'); render(); } });
  };
  const when = (m) => fmtDateTime(m.receivedAt || m.builtAt);
  const statusBadgeOf = (m) => badge(m.status, { accepted: 'ok', quarantined: 'danger', replayed: 'accent', built: 'accent', sent: 'ok', 'send-failed': 'danger' }[m.status] || '');
  const download = (m) => h('a', { href: `/api/hl7/messages/${m.id}/raw`, download: `${m.id}.hl7`, testid: `hl7-download-${m.id}`, 'aria-label': `Download ${m.type || 'message'} ${m.controlId || ''}` }, 'Download');
  mount('hl7', page('HL7 v2 interface', null,
    h('p', { class: 'muted small' }, 'Inbound messages arrive at POST /hl7/v2 (one per request, text body) and are answered with an ACK. A refused message waits here for a person to fix and replay. Outbound ORM/OML and ORU messages are built locally and sent nowhere unless HL7_OUT_URL is set.'),
    card(`Quarantine (${quarantined.length})`, table({ testid: 'hl7-quarantine', rows: quarantined, empty: 'Nothing is quarantined', columns: [
      { label: 'Received', cls: 'num', render: when }, { label: 'Type', render: (m) => m.type || 'unparseable' }, { label: 'Control id', cls: 'mono', render: (m) => m.controlId || '' }, { label: 'MRN', cls: 'mono', render: (m) => m.mrn || '' }, { label: 'Reason', render: (m) => m.error },
      { label: '', cls: 'actions', render: (m) => [btn('Fix and replay', { small: true, kind: 'primary', write: true, perm: ['Specimen', 'create'], testid: `hl7-fix-${m.id}`, onClick: () => fix(m) }), ' ', download(m)] }] })),
    card(`Inbound (${inbound.messages.length})`, table({ testid: 'hl7-inbound', rows: inbound.messages.slice(0, 50), empty: 'No message received yet', columns: [
      { label: 'Received', cls: 'num', render: when }, { label: 'Type', render: (m) => m.type || '' }, { label: 'Control id', cls: 'mono', render: (m) => m.controlId || '' }, { label: 'MRN', cls: 'mono', render: (m) => m.mrn || '' }, { label: 'ACK', render: (m) => badge(m.ackCode || '', m.ackCode === 'AA' ? 'ok' : 'danger') }, { label: 'Status', render: statusBadgeOf }, { label: '', cls: 'actions', render: download }] })),
    card(`Outbound (${outbound.messages.length})`, table({ testid: 'hl7-outbound', rows: outbound.messages.slice(0, 50), empty: 'No message built yet', columns: [
      { label: 'Built', cls: 'num', render: when }, { label: 'Type', render: (m) => m.type }, { label: 'Control id', cls: 'mono', render: (m) => m.controlId }, { label: 'Order', cls: 'mono', render: (m) => m.order || '' }, { label: 'Status', render: statusBadgeOf }, { label: '', cls: 'actions', render: download }] }))));
}

// ---------- Router ----------
let token = 0;
async function render() {
  const mine = token += 1;
  const [path, queryString] = (location.hash.slice(2) || 'worklist').split('?');
  const [route, id] = path.split('/');
  const query = new URLSearchParams(queryString || '');
  try {
    if (route === 'specimen' && id) await specimen(id);
    else if (route === 'criticals') await criticals();
    else if (route === 'qc') await qc();
    else if (route === 'rules') await rules();
    else if (route === 'hl7') await hl7();
    else await worklist(query.get('bench') || '');
  } catch (err) {
    if (mine !== token) return;
    mount(route, page('Could not load this screen', btn('Retry', { testid: 'retry', onClick: render }), h('div', { class: 'banner danger', testid: 'load-error' }, err.message)));
  }
}
window.addEventListener('hashchange', render);
window.addEventListener('hd:role', render);
view.onChange(render);
if (!location.hash) history.replaceState(null, '', '#/worklist');
render();
