// ECG tab: a list of recorded ECGs and a 12-lead viewer drawn on
// a paper grid (25 mm/s, 10 mm/mV, calibration pulse), with speed, gain,
// zoom, calipers and a side-by-side prior. Recording attaches a synthesised
// ECG to an order; the physician edits the measurements and signs the
// interpretation (a DiagnosticReport). Viewer actions are recorder events.
import { h, btn, badge, toast, table, card, kv, formDialog, confirmDialog, fmtDateTime, fmtTime } from '/shared/ui.js';
import { fhir, api, identity, flagged } from '/shared/fhir.js';
import { canWrite } from '/shared/roles.js';

const ROWS = [['I', 'aVR', 'V1', 'V4'], ['II', 'aVL', 'V2', 'V5'], ['III', 'aVF', 'V3', 'V6']];
const MDC = { 131329: 'I', 131330: 'II', 131331: 'III', 131332: 'aVR', 131333: 'aVL', 131334: 'aVF', 131335: 'V1', 131336: 'V2', 131337: 'V3', 131338: 'V4', 131339: 'V5', 131340: 'V6' };
const STATUS = { unread: ['Unread', 'warn'], preliminary: ['Preliminary', 'warn'], final: ['Final', 'ok'], amended: ['Amended', 'ok'], corrected: ['Corrected', 'ok'], appended: ['Appended', 'ok'] };

function samplesByLead(ecg) {
  const out = {};
  for (const l of ecg.leads) {
    const name = MDC[l.code] || l.name;
    out[name] = { period: l.period, mv: l.data.split(/\s+/).filter(Boolean).map((v) => (l.origin || 0) + Number(v) * (l.factor ?? 1)) };
  }
  return out;
}

/** Draws a 12-lead layout plus a lead II rhythm strip. Returns the canvas and its geometry. */
export function drawEcg(ecg, { speed = 25, gain = 10, pxPerMm = 3, label = null } = {}) {
  const leads = samplesByLead(ecg);
  const rowMm = 30;
  const stripMm = 10 * speed;
  const widthMm = stripMm + 12;
  const heightMm = rowMm * 4 + 6;
  const canvas = h('canvas', { width: Math.round(widthMm * pxPerMm), height: Math.round(heightMm * pxPerMm), testid: label ? `ecg-canvas-${label}` : 'ecg-canvas', 'aria-label': `12-lead ECG trace${label ? ` (${label})` : ''}`, role: 'img' });
  const ctx = canvas.getContext('2d');
  const mm = (v) => v * pxPerMm;
  ctx.fillStyle = '#fff6f6';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let x = 0; x <= widthMm; x += 1) { ctx.strokeStyle = x % 5 === 0 ? '#e8b4b4' : '#f3d9d9'; ctx.lineWidth = x % 5 === 0 ? 1 : 0.5; ctx.beginPath(); ctx.moveTo(mm(x), 0); ctx.lineTo(mm(x), canvas.height); ctx.stroke(); }
  for (let y = 0; y <= heightMm; y += 1) { ctx.strokeStyle = y % 5 === 0 ? '#e8b4b4' : '#f3d9d9'; ctx.lineWidth = y % 5 === 0 ? 1 : 0.5; ctx.beginPath(); ctx.moveTo(0, mm(y)); ctx.lineTo(canvas.width, mm(y)); ctx.stroke(); }
  ctx.strokeStyle = '#16202a';
  ctx.lineWidth = Math.max(1, pxPerMm * 0.4);
  ctx.font = `${Math.max(10, pxPerMm * 3.5)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillStyle = '#16202a';
  const trace = (name, x0, baseY, seconds, offsetSeconds) => {
    const lead = leads[name];
    if (!lead) return;
    const start = Math.round((offsetSeconds * 1000) / lead.period);
    const count = Math.round((seconds * 1000) / lead.period);
    ctx.beginPath();
    for (let i = 0; i < count && start + i < lead.mv.length; i += 1) {
      const x = x0 + mm(((i * lead.period) / 1000) * speed);
      const y = baseY - mm(lead.mv[start + i] * gain);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillText(name, x0 + mm(1), baseY - mm(rowMm / 2 - 4));
  };
  const pulse = (baseY) => { ctx.beginPath(); ctx.moveTo(mm(2), baseY); ctx.lineTo(mm(2), baseY - mm(gain)); ctx.lineTo(mm(2 + 0.2 * speed), baseY - mm(gain)); ctx.lineTo(mm(2 + 0.2 * speed), baseY); ctx.stroke(); };
  const colMm = (2.5 * speed);
  ROWS.forEach((row, r) => {
    const baseY = mm(rowMm * (r + 1) - 8);
    pulse(baseY);
    row.forEach((name, c) => trace(name, mm(10) + mm(colMm * c), baseY, 2.5, 2.5 * c));
  });
  const stripBase = mm(rowMm * 4 - 8);
  pulse(stripBase);
  trace('II', mm(10), stripBase, 10, 0);
  ctx.fillText(`${speed} mm/s  ${gain} mm/mV`, mm(widthMm - 30), mm(heightMm - 2));
  return { canvas, pxPerMm, speed, gain };
}

export function ecgTab(c) {
  const { p, base, go, query, done, shell } = c;
  const record = (action, extra = {}, id = null) => { try { shell?.recorder?.record('viewer', { viewer: { action, ...extra }, resources: id ? [{ ref: `Observation/${id}` }] : undefined, route: location.hash.slice(0, 120) }); } catch { /* telemetry never blocks the viewer */ } };
  const canRecord = canWrite('Observation', 'create');
  const canInterpret = canWrite('DiagnosticReport', 'create');

  async function listView(data) {
    return [h('div', { class: 'toolbar' }, h('h2', { class: 'grow' }, 'ECG'), h('span', { class: 'muted small', testid: 'ecg-import-note' }, 'Recordings arrive by import (npm run import -- --ecg <folder>).')),
      data.openOrders.length ? card('ECG orders waiting to be recorded', table({ testid: 'ecg-orders', rows: data.openOrders, columns: [
        { label: 'Ordered', cls: 'num', render: (o) => fmtDateTime(o.authoredOn) }, { label: 'Priority', render: (o) => badge(o.priority, o.priority === 'stat' ? 'danger' : '') }, { label: 'By', render: (o) => o.requester || '' }, { label: 'Reason', render: (o) => o.reason || '' },
      ] })) : null,
      table({ testid: 'ecg-list', rows: data.ecgs, empty: 'No data to display', columns: [
        { label: 'Date and time', cls: 'num', render: (e) => fmtDateTime(e.at) }, { label: 'Rate', cls: 'num', render: (e) => e.measurements.rate ?? '' }, { label: 'Source', render: (e) => e.source || '' },
        { label: 'Status', render: (e) => { const [t, k] = STATUS[e.status] || [e.status, '']; return h('span', {}, badge(t, k), ' ', e.critical ? badge(e.acknowledged ? 'Critical, acknowledged' : 'Critical', 'solid-danger') : null, ' ', e.released ? badge('In Patient Portal', 'accent') : null); } },
        { label: 'Confirmed by', render: (e) => e.confirmedBy || '' },
        { label: '', cls: 'actions', render: (e) => btn('Open', { small: true, testid: `ecg-open-${e.id}`, onClick: () => go(`${base}/ecg?id=${e.id}`) }) },
      ] }),
      h('p', { class: 'muted small' }, `Measurement codes are an unverified starter set. ${canRecord ? '' : 'Your role can read ECGs; recording and interpretation belong to other roles.'}`)];
  }

  async function traceView(id) {
    const ecg = await api.get(`/api/ecg/${id}`);
    record('ecg-open', { leads: ecg.leads.length }, id);
    const state = { speed: Number(query.get('speed') || 25), gain: Number(query.get('gain') || 10), zoom: Number(query.get('zoom') || 3), compare: query.get('compare') === '1' };
    const set = (k, v) => { state[k] = v; record(`ecg-${k}`, { value: v }, id); draw(); };
    const host = h('div', { class: 'tablewrap', style: 'overflow:auto; max-height:70vh', testid: 'ecg-viewer' });
    const caliperOut = h('span', { class: 'mono', testid: 'ecg-caliper-readout' }, 'Calipers: click and drag on the trace');
    let prior = null;
    const draw = async () => {
      const { canvas } = drawEcg(ecg, { speed: state.speed, gain: state.gain, pxPerMm: state.zoom });
      attachCalipers(canvas);
      host.replaceChildren(canvas);
      if (state.compare && ecg.prior) {
        if (!prior) prior = await api.get(`/api/ecg/${ecg.prior.id}`);
        const { canvas: pc } = drawEcg(prior, { speed: state.speed, gain: state.gain, pxPerMm: state.zoom, label: 'prior' });
        host.replaceChildren(h('div', { style: 'display:flex; gap:0.5rem' }, h('div', {}, h('div', { class: 'muted small' }, `Prior: ${fmtDateTime(prior.at)}`), pc), h('div', {}, h('div', { class: 'muted small' }, `Current: ${fmtDateTime(ecg.at)}`), canvas)));
      }
    };
    const attachCalipers = (canvas) => {
      let start = null;
      const overlay = canvas.getContext('2d');
      // Distances are taken between pointer positions on the screen, so a small shift of the page while dragging does not change the measurement.
      canvas.addEventListener('mousedown', (e) => { start = { x: e.offsetX, y: e.offsetY, cx: e.clientX, cy: e.clientY }; });
      canvas.addEventListener('mousemove', (e) => {
        if (!start) return;
        const ms = Math.round(((e.clientX - start.cx) / (state.speed * state.zoom)) * 1000);
        const mv = Math.round(((start.cy - e.clientY) / (state.gain * state.zoom)) * 100) / 100;
        caliperOut.textContent = `Calipers: ${Math.abs(ms)} ms, ${mv.toFixed(2)} mV`;
      });
      const finish = (e) => {
        if (!start) return;
        const ms = Math.round(((e.clientX - start.cx) / (state.speed * state.zoom)) * 1000);
        const mv = Math.round(((start.cy - e.clientY) / (state.gain * state.zoom)) * 100) / 100;
        overlay.strokeStyle = '#4f63d2'; overlay.lineWidth = 1; overlay.strokeRect(start.x, start.y, e.clientX - start.cx, e.clientY - start.cy);
        caliperOut.textContent = `Calipers: ${Math.abs(ms)} ms, ${mv.toFixed(2)} mV`;
        record('ecg-caliper', { ms: Math.abs(ms), mv, speed: state.speed, gain: state.gain }, id);
        start = null;
      };
      canvas.addEventListener('mouseup', finish);
      canvas.addEventListener('mouseleave', () => { start = null; });
    };
    await draw();
    const seg = (name, values, fmt) => h('div', { class: 'seg', role: 'group', 'aria-label': name }, values.map((v) => h('button', { type: 'button', testid: `ecg-${name}-${v}`, 'aria-label': `${name} ${fmt(v)}`, 'aria-pressed': String(state[name] === v), onClick: (e) => { set(name, v); for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); } }, fmt(v))));
    const m = ecg.measurements;
    const report = ecg.report;
    const signed = report && ['final', 'amended', 'corrected', 'appended'].includes(report.status);
    const interpretForm = () => {
      const fields = [
        ...['rate', 'pr', 'qrs', 'qt', 'qtc', 'axis'].map((k) => ({ name: k, label: { rate: 'Rate (/min)', pr: 'PR (ms)', qrs: 'QRS (ms)', qt: 'QT (ms)', qtc: 'QTc (ms)', axis: 'Axis (deg)' }[k], type: 'number', step: 'any', value: m[k] ?? '' })),
        { name: 'text', label: 'Interpretation', type: 'textarea', rows: 6, required: true, dictate: true, wide: true, value: report?.conclusion || ecg.note?.replace(/^.*Machine text: /, '') || '' },
        { name: 'critical', label: 'Critical finding (for example STEMI pattern); leave blank if none', wide: true, value: report?.critical?.replace(/^Critical ECG finding: /, '') || '' },
      ];
      formDialog({ title: 'ECG interpretation', testid: 'ecg-interpret-form', submitLabel: 'Save interpretation', wide: true, fields, onSubmit: async (v) => {
        const { text, critical, ...measurements } = v;
        await api.post(`/api/ecg/${id}/interpret`, { measurements, text, critical });
        done('Interpretation saved as preliminary');
      } });
    };
    const header = h('div', { class: 'grid3', testid: 'ecg-header' },
      card('Measurements', kv([['Rate', m.rate != null ? `${m.rate} /min` : (ecg.detectedRate != null ? `${ecg.detectedRate} /min (detected)` : '—')], ['PR', m.pr != null ? `${m.pr} ms` : '—'], ['QRS', m.qrs != null ? `${m.qrs} ms` : '—'], ['QT / QTc', m.qt != null ? `${m.qt} / ${m.qtc ?? '—'} ms` : '—'], ['Axis', m.axis != null ? `${m.axis}°` : '—'], ['Source', ecg.source || '']]), h('p', { class: 'muted small' }, 'Measurement codes: unverified starter set')),
      card('Interpretation', h('div', { testid: 'ecg-interpretation' }, report ? report.conclusion : h('span', { class: 'muted' }, 'Unread: no interpretation yet')),
        report?.critical ? h('div', { class: 'banner warn', testid: 'ecg-critical' }, report.critical) : null,
        h('div', { class: 'toolbar', style: 'margin-top:0.5rem' }, report ? badge(STATUS[report.status]?.[0] || report.status, STATUS[report.status]?.[1] || '') : badge('Unread', 'warn'), report?.released ? badge('In Patient Portal', 'accent') : null,
          !signed ? btn(report ? 'Edit interpretation' : 'Interpret', { small: true, kind: 'primary', write: true, perm: ['DiagnosticReport', 'create'], testid: 'ecg-interpret', onClick: interpretForm }) : null,
          report && !signed ? btn('Sign', { small: true, kind: 'primary', write: true, perm: ['DiagnosticReport', 'sign'], testid: 'ecg-sign', onClick: async () => { if (!(await confirmDialog({ title: 'Sign the ECG interpretation?', message: 'Signing locks the interpretation. An addendum can be added afterwards.', confirmLabel: 'Sign', testid: 'ecg-sign-confirm' }))) return; await fhir.transition({ resourceType: 'DiagnosticReport', id: report.id }, 'final'); record('ecg-sign', {}, id); done('Interpretation signed'); } }) : null,
          signed ? btn(report.released ? 'Hide from the Patient Portal' : 'Release to the Patient Portal', { small: true, write: true, perm: ['DiagnosticReport', '$release'], testid: report.released ? 'ecg-hide' : 'ecg-release', onClick: async () => { await fhir.release({ resourceType: 'DiagnosticReport', id: report.id }, !report.released); done(report.released ? 'Hidden from the Patient Portal' : 'Released to the Patient Portal'); } }) : null,
          ecg.critical && !ecg.acknowledged ? btn('Acknowledge critical', { small: true, kind: 'danger', write: true, perm: ['Observation', '$acknowledge'], testid: 'ecg-ack', onClick: async () => { await fhir.acknowledge({ resourceType: 'Observation', id }); done('Critical result acknowledged'); } }) : null),
        signed ? h('div', { class: 'muted small', testid: 'ecg-confirmed' }, `Confirmed by ${ecg.confirmedBy || report.performer || ''} · ${fmtDateTime(report.issued)}`) : null),
      card('Record', kv([['Recorded', fmtDateTime(ecg.at)], ['Leads', ecg.leads.length], ['Order', ecg.order || 'none'], ['Prior ECG', ecg.prior ? fmtDateTime(ecg.prior.at) : 'none']]), h('p', { class: 'muted small' }, ecg.note || '')));
    const tools = h('div', { class: 'toolbar' }, btn('◂ All ECGs', { small: true, testid: 'ecg-back', onClick: () => go(`${base}/ecg`) }), h('h2', { class: 'grow' }, `12-lead ECG · ${fmtDateTime(ecg.at)}`),
      h('span', { class: 'muted small' }, 'Speed'), seg('speed', [25, 50], (v) => `${v} mm/s`), h('span', { class: 'muted small' }, 'Gain'), seg('gain', [5, 10, 20], (v) => `${v} mm/mV`), h('span', { class: 'muted small' }, 'Zoom'), seg('zoom', [2, 3, 4, 6], (v) => `${v}x`),
      ecg.prior ? btn(state.compare ? 'Hide prior' : 'Compare with prior', { small: true, testid: 'ecg-compare', onClick: () => { state.compare = !state.compare; record('ecg-compare', { on: state.compare }, id); draw(); } }) : null);
    const machine = ecg.machine ? h('div', { class: 'card', testid: 'ecg-machine', style: 'margin-top:0.75rem' }, h('h3', {}, ecg.machine.label), h('p', { class: 'muted small' }, `From the recording device${ecg.machine.source ? ` (${ecg.machine.source})` : ''}. It has not been checked by a physician.`), h('ul', { testid: 'ecg-machine-statements' }, ecg.machine.statements.map((x) => h('li', {}, x))), ecg.machine.extra.length ? h('p', { class: 'small', testid: 'ecg-machine-extra' }, ecg.machine.extra.map((m) => `${m.name} ${m.value} ${m.unit}`).join(' · ')) : null) : null;
    return [tools, header, h('div', { class: 'toolbar' }, caliperOut, h('span', { class: 'muted small grow' }, 'Scroll to pan. Paper grid 1 mm, bold every 5 mm. Calibration pulse 1 mV at the start of each row.')), host, machine];
  }

  return async function tab() {
    const id = query.get('id');
    if (id) return traceView(id);
    return listView(await api.get('/api/ecg', { patient: p.id }));
  };
}
