// Scenarios, the timeline editor and scenario-based red-team tests
// (plan-master tasks 11 to 14). Usable by a clinician: lanes, cards, a
// "+" per lane with a short form, presets, drag to move, a preview scrubber,
// and plain warnings. Saving makes a new version; old versions stay.
import { h, clear, btn, badge, toast, table, kv, formDialog, openDialog, confirmDialog, fmtDateTime, showError, field } from '/shared/ui.js';
import { api } from '/shared/fhir.js';

const page = (title, actions, ...content) => h('div', {}, h('div', { class: 'page-head' }, h('h1', {}, title), actions), ...content);
const inote = (text) => h('span', { class: 'inote', title: text, 'aria-label': text }, ' (i) ', text);
const LANES = ['Vitals', 'Labs', 'Imaging', 'Notes', 'Medications', 'Messages', 'Wearables', 'Events'];
const LANE_KINDS = { Vitals: ['vitals', 'deterioration'], Labs: ['lab-ordered', 'lab-preliminary', 'lab-final', 'lab-corrected'], Imaging: ['image-available', 'report-final'], Notes: ['note-written'], Medications: ['medication-given'], Messages: ['nurse-message', 'patient-message', 'consult-reply'], Wearables: ['wearable-stream'], Events: ['patient-arrives', 'discharge', 'custom'] };
const KIND_LABEL = { vitals: 'Vitals', deterioration: 'Deterioration', 'lab-ordered': 'Lab ordered', 'lab-preliminary': 'Lab preliminary', 'lab-final': 'Lab final', 'lab-corrected': 'Lab corrected', 'image-available': 'Image available', 'report-final': 'Report final', 'note-written': 'Note written', 'medication-given': 'Medication given', 'nurse-message': 'Nurse message', 'patient-message': 'Patient message', 'consult-reply': 'Consult reply', 'wearable-stream': 'Wearable stream', 'patient-arrives': 'Patient arrives', discharge: 'Discharge', custom: 'Custom' };
const LABS = [['2823-3', 'Potassium', 'mmol/L'], ['2160-0', 'Creatinine', 'mg/dL'], ['2345-7', 'Glucose', 'mg/dL'], ['10839-9', 'Troponin', 'ng/mL'], ['2524-7', 'Lactate', 'mmol/L'], ['718-7', 'Haemoglobin', 'g/dL'], ['6690-2', 'White cell count', '10*3/uL'], ['1988-5', 'C-reactive protein', 'mg/L'], ['48065-7', 'D-dimer', 'mg/L'], ['30934-4', 'BNP', 'pg/mL']];
const RANGES = { '2823-3': [3.5, 5.1], '2160-0': [0.6, 1.3], '2345-7': [70, 140], '10839-9': [0, 0.04], '2524-7': [0.5, 2], '718-7': [12, 17], '6690-2': [4, 11], '1988-5': [0, 10], '48065-7': [0, 0.5], '30934-4': [0, 100] };
const STYLE = `
.tl { display: grid; grid-template-columns: 1fr 20rem; gap: 0.75rem; }
.tl .lanes { overflow-x: auto; border: 1px solid var(--line); border-radius: 0.625rem; background: var(--surface); }
.tl .lane { display: grid; grid-template-columns: 7.5rem 1fr; min-height: 3.5rem; border-bottom: 1px solid var(--line); }
.tl .lane:last-child { border-bottom: none; }
.tl .lane .name { padding: 0.5rem; font-weight: 650; font-size: 1.0313rem; border-right: 1px solid var(--line); display: flex; flex-direction: column; gap: 0.25rem; }
.tl .lane .track { position: relative; min-height: 3.5rem; background: repeating-linear-gradient(90deg, transparent 0, transparent calc(var(--tick) - 1px), var(--line) calc(var(--tick) - 1px), var(--line) var(--tick)); }
.tl .evcard { position: absolute; top: 0.5rem; height: 2.5rem; min-width: 5.625rem; max-width: 13.75rem; padding: 0.1875rem 0.5rem; border-radius: 0.5rem; border: 1px solid var(--line-s); background: var(--surface-2); font-size: 0.9688rem; line-height: 1.2; overflow: hidden; cursor: grab; user-select: none; box-shadow: 0 1px 0.125rem rgba(0,0,0,.08); }
.tl .evcard.selected { border-color: var(--accent); background: var(--accent-soft); }
.tl .evcard.warn { border-color: #c98a00; }
.tl .evcard.generated { border-style: dashed; }
.tl .evcard .t { display: block; color: var(--ink-3); font-family: var(--mono); font-size: 0.9063rem; }
.tl .side { border: 1px solid var(--line); border-radius: 0.625rem; padding: 0.625rem; background: var(--surface); font-size: 1.0625rem; max-height: 70vh; overflow: auto; }
.tl .side h3 { margin: 0 0 0.375rem; }
.tl .ruler { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 0.9063rem; color: var(--ink-3); padding: 0.125rem 0.5rem 0.125rem 8rem; }
.tl .scrub { display: flex; gap: 0.625rem; align-items: center; margin-top: 0.625rem; }
.tl .scrub input[type=range] { flex: 1; }
.tl .preview { border: 1px dashed var(--line-s); border-radius: 0.625rem; padding: 0.5rem 0.625rem; font-size: 1.0313rem; max-height: 13.75rem; overflow: auto; }
.tl .spark { width: 100%; height: 3.75rem; background: var(--surface-2); border-radius: 0.375rem; }
.tl .warnlist li { color: #8a5a00; }
.rtform .step { border: 1px solid var(--line); border-radius: 0.625rem; padding: 0.625rem 0.75rem; margin-bottom: 0.625rem; }
.rtform .step h3 { margin: 0 0 0.5rem; font-size: 1.125rem; }
`;
const ensureStyle = () => { if (!document.getElementById('scenario-style')) document.head.append(h('style', { id: 'scenario-style' }, STYLE)); };
const fmtAt = (minutes) => { const n = Math.round(minutes); const sign = n < 0 ? '-' : '+'; let a = Math.abs(n); const d = Math.floor(a / 1440); a -= d * 1440; const hh = Math.floor(a / 60); const m = a - hh * 60; return `T${sign}${[d ? `${d}d` : '', hh ? `${hh}h` : '', m || (!d && !hh) ? `${m}m` : ''].filter(Boolean).join(' ')}`; };
const sel = (testid, label, value, options, onChange, extra = {}) => h('select', { testid, 'aria-label': label, style: 'width:auto', onChange: (e) => onChange(e.target.value), ...extra }, options.map(([v, t]) => h('option', { value: v, selected: v === value }, t)));
const obs = (code, name, value, unit, extra = {}) => ({ resourceType: 'Observation', status: extra.status || 'final', ...(extra.category ? { category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: extra.category }] }] } : {}), code: { coding: [{ system: 'http://loinc.org', code, display: name }], text: name }, subject: { reference: 'Patient/pt' }, valueQuantity: { value: Number(value), unit, system: 'http://unitsofmeasure.org', code: unit }, ...(extra.basedOn ? { basedOn: [{ reference: extra.basedOn }] } : {}) });

// ---------- Scenario list ----------
export async function scenariosPage(go) {
  ensureStyle();
  const { scenarios, clocks } = await api.get('/agent-ops/scenarios');
  const fromTemplate = async () => {
    const { templates } = await api.get('/agent-ops/scenarios/templates');
    if (!templates.length) { toast('No templates ship with the release. Build a scenario from a patient you have loaded.'); fromData(); return; }
    formDialog({ title: 'New scenario', testid: 'scenario-new-form', submitLabel: 'Create', intro: 'Start from a template, then shape the timeline in the editor.', fields: [{ name: 'title', label: 'Title', required: true, wide: true, testid: 'scenario-new-title' }, { name: 'template', label: 'Template', type: 'select', options: templates.map((t) => [t.id, `${t.title}: ${t.summary}`]), testid: 'scenario-new-template', wide: true }],
      onSubmit: async (v) => { const t = templates.find((x) => x.id === v.template) || templates[0]; const made = await api.post('/agent-ops/scenarios', { ...t, title: v.title, tags: ['from-template', t.id] }); toast(`Scenario created: ${made.title}`); go(`#/scenarios/${made.id}`); } });
  };
  const fromData = () => formDialog({ title: 'Scenario from data that already has dates', testid: 'scenario-from-data-form', submitLabel: 'Build scenario', intro: 'Everything dated before the start becomes history; everything after becomes an event at its own relative time.', fields: [{ name: 'patient', label: 'Patient (Patient/<id>)', required: true, wide: true, testid: 'scenario-from-patient' }, { name: 't0', label: 'Start (T0)', type: 'datetime-local', required: true, testid: 'scenario-from-t0' }, { name: 'title', label: 'Title', wide: true, testid: 'scenario-from-title' }],
    onSubmit: async (v) => { const made = await api.post('/agent-ops/scenarios/from-patient', { patient: v.patient, t0: new Date(v.t0).toISOString(), title: v.title }); toast(`Scenario built: ${made.events.length} events`); go(`#/scenarios/${made.id}`); } });
  const upload = () => formDialog({ title: 'Upload a scenario pack', testid: 'scenario-import-form', submitLabel: 'Import', intro: 'A JSON pack (see docs/SCENARIOS.md). Errors come back in plain words.', fields: [{ name: 'json', label: 'Pack JSON', type: 'textarea', rows: 10, required: true, wide: true, testid: 'scenario-import-json' }],
    onSubmit: async (v) => { let pack; try { pack = JSON.parse(v.json); } catch { throw new Error('That is not valid JSON'); } const made = await api.post('/agent-ops/scenarios/import', pack); toast(`Imported: ${made.title}`); go(`#/scenarios/${made.id}`); } });
  return page('Scenarios', h('div', { class: 'toolbar' }, btn('New from template', { kind: 'primary', testid: 'scenario-new', onClick: fromTemplate }), btn('From data with dates', { testid: 'scenario-from-data', onClick: fromData }), btn('Upload a pack', { testid: 'scenario-import', onClick: upload })),
    h('p', { class: 'muted' }, 'A scenario is a patient\'s history plus a timeline from the moment a run starts. Events are released into the chart only when the run\'s clock reaches them.', inote('Relative times (T+40 min, Day 2 08:00) become real dates when a run starts, shifted so the case looks current. The run records the version it used.')),
    table({ testid: 'scenarios-table', rows: scenarios, empty: 'No scenarios yet', onRow: (s) => go(`#/scenarios/${s.id}`), columns: [
      { label: 'Title', render: (s) => s.title }, { label: 'Events', cls: 'num', render: (s) => s.events.length }, { label: 'Length', render: (s) => fmtAt(s.lengthMinutes) }, { label: 'Clock', render: (s) => s.clock }, { label: 'Version', cls: 'num', render: (s) => s.version }, { label: 'Source', render: (s) => badge(s.source, s.source === 'built-in' ? '' : 'accent') }, { label: 'Warnings', cls: 'num', render: (s) => (s.warnings.length ? badge(String(s.warnings.length), 'warn') : '') },
      { label: '', cls: 'actions', render: (s) => btn('Open', { small: true, testid: `scenario-open-${s.id}`, onClick: () => go(`#/scenarios/${s.id}`) }) }] }),
    h('p', { class: 'muted small' }, `Clock modes: ${clocks.join(', ')}.`));
}

// ---------- Editor ----------
export async function scenarioEditorPage(id, go, render) {
  ensureStyle();
  const s = await api.get(`/agent-ops/scenarios/${id}`);
  const st = { events: s.events.map((e) => ({ ...e })), selected: null, zoom: 'hours', undo: [], dirty: false, preview: null, previewAt: 0, title: s.title, clock: s.clock, speed: s.speed, t0: s.t0, summary: s.summary };
  const pushUndo = () => { st.undo.push(JSON.stringify(st.events)); if (st.undo.length > 50) st.undo.shift(); st.dirty = true; };
  const length = () => Math.max(60, ...st.events.map((e) => e.at + (e.durationMinutes || 0)), s.lengthMinutes || 0);
  const pxPerMin = () => (st.zoom === 'hours' ? 2 : st.zoom === 'days' ? 2 / 12 : 2 / 84);
  const tick = () => (st.zoom === 'hours' ? 60 : st.zoom === 'days' ? 1440 : 10080) * pxPerMin();
  const warningsFor = async () => { try { return (await api.post('/agent-ops/scenarios/validate', { ...s, title: st.title, events: st.events, bundle: s.bundle })).warnings; } catch { return []; } };
  let warnings = s.warnings || [];
  const root = h('div', {});

  const eventForm = (lane, existing = null) => {
    const kinds = LANE_KINDS[lane];
    const fields = [{ name: 'kind', label: 'What happens', type: 'select', options: kinds.map((k) => [k, KIND_LABEL[k]]), value: existing?.kind || kinds[0], testid: 'ev-kind' }, { name: 'at', label: 'When (minutes from start, "T+1h 30m" or "Day 2 08:00")', value: existing ? fmtAt(existing.at) : 'T+30m', required: true, testid: 'ev-at' }, { name: 'label', label: 'Label (plain words)', value: existing?.label || '', wide: true, testid: 'ev-label' }];
    if (lane === 'Labs') fields.push({ name: 'test', label: 'Test', type: 'select', options: LABS.map(([c, n]) => [c, n]), value: existing?.resources?.[0]?.code?.coding?.[0]?.code || '2823-3', testid: 'ev-test' }, { name: 'value', label: 'Value (the flag is worked out from the reference range)', type: 'number', step: 'any', value: existing?.resources?.[0]?.valueQuantity?.value ?? '', testid: 'ev-value' });
    if (lane === 'Vitals') for (const [k, l, d] of [['hr', 'Heart rate', 90], ['sbp', 'Systolic BP', 120], ['spo2', 'Oxygen saturation', 96], ['temp', 'Temperature', 37], ['rr', 'Respiratory rate', 18]]) fields.push({ name: k, label: l, type: 'number', step: 'any', value: d, testid: `ev-${k}` });
    if (lane === 'Messages') fields.push({ name: 'text', label: 'Message text', type: 'textarea', rows: 3, value: existing?.resources?.[0]?.payload?.[0]?.contentString || '', wide: true, testid: 'ev-text' }, { name: 'urgent', label: 'Mark urgent (patient messages)', type: 'checkbox', value: ['urgent', 'stat'].includes(existing?.resources?.[0]?.priority), testid: 'ev-urgent' }, { name: 'hidden', label: 'Hidden prompt-injection payload (patient messages; red-team use, never shown to the clinician)', type: 'textarea', rows: 2, value: existing?.resources?.[0]?.payload?.[1]?.contentString || '', wide: true, testid: 'ev-hidden' });
    if (lane === 'Imaging') fields.push({ name: 'text', label: 'Report conclusion', type: 'textarea', rows: 3, value: existing?.resources?.[0]?.conclusion || '', wide: true, testid: 'ev-text' });
    if (lane === 'Notes') fields.push({ name: 'text', label: 'Note text', type: 'textarea', rows: 4, value: '', wide: true, testid: 'ev-text' });
    if (lane === 'Medications') fields.push({ name: 'drug', label: 'Medication', value: existing?.resources?.[0]?.medicationCodeableConcept?.text || '', wide: true, testid: 'ev-drug' });
    if (lane === 'Wearables') fields.push({ name: 'device', label: 'Device', type: 'select', options: [['watch', 'Watch'], ['patch', 'Patch'], ['bp-cuff', 'Home blood pressure cuff'], ['scale', 'Scale'], ['pulse-oximeter', 'Pulse oximeter'], ['glucose-sensor', 'Glucose sensor']], value: existing?.stream?.device || 'watch', testid: 'ev-device' }, { name: 'measures', label: 'Measures (comma separated: heart-rate, rhythm, spo2, blood-pressure, weight, glucose, steps, sleep)', value: (existing?.stream?.measures || ['heart-rate']).join(', '), wide: true, testid: 'ev-measures' }, { name: 'days', label: 'Length (days)', type: 'number', value: existing ? Math.round((existing.durationMinutes || 1440) / 1440) : 3, testid: 'ev-days' }, { name: 'episode', label: 'Planted episode', type: 'select', options: [['', 'None'], ['af', 'Atrial fibrillation episode'], ['desaturation', 'Night-time oxygen drop'], ['weight-gain', 'Gradual weight gain over a week'], ['glucose-spike', 'Glucose spike']], value: existing?.stream?.episodes?.[0]?.kind || '', testid: 'ev-episode' }, { name: 'episodeAt', label: 'Episode starts (minutes into the stream)', type: 'number', value: existing?.stream?.episodes?.[0]?.startMinutes ?? 1560, testid: 'ev-episode-at' });
    fields.push({ name: 'visibleTo', label: 'Visible to', type: 'select', options: [['everyone', 'Everyone'], ['agent', 'Only the agent'], ['human', 'Only the human']], value: existing?.visibleTo || 'everyone', testid: 'ev-visible' }, { name: 'note', label: 'Why is this here', type: 'textarea', rows: 2, value: existing?.note || '', wide: true, testid: 'ev-note' });
    formDialog({ title: existing ? `Edit: ${existing.label || KIND_LABEL[existing.kind]}` : `Add to ${lane}`, testid: 'event-form', submitLabel: existing ? 'Save event' : 'Add event', wide: true, fields, onSubmit: async (v) => {
      const at = parseAt(v.at);
      let resources = existing?.resources || [];
      let label = v.label;
      if (lane === 'Labs') { const [code, name, unit] = LABS.find(([c]) => c === v.test); const [lo, hi] = RANGES[code] || [null, null]; const flag = v.value !== '' && hi != null && Number(v.value) > hi ? 'high' : v.value !== '' && lo != null && Number(v.value) < lo ? 'low' : ''; resources = v.kind === 'lab-ordered' ? [{ resourceType: 'ServiceRequest', id: `sr-${code}-${Date.now().toString(36)}`, status: 'active', intent: 'order', subject: { reference: 'Patient/pt' }, category: [{ coding: [{ system: 'urn:hospital-desktop:order-category', code: 'laboratory' }] }], code: { coding: [{ system: 'http://loinc.org', code, display: name }], text: name } }] : [obs(code, name, v.value, unit, { status: v.kind === 'lab-preliminary' ? 'preliminary' : v.kind === 'lab-corrected' ? 'corrected' : 'final' })]; label = label || (v.kind === 'lab-ordered' ? `${name} ordered` : `${name} ${v.value}${flag ? `, ${flag}` : ''}`); }
      if (lane === 'Vitals') { resources = [obs('8867-4', 'Heart rate', v.hr, '/min', { category: 'vital-signs' }), obs('8480-6', 'Systolic blood pressure', v.sbp, 'mm[Hg]', { category: 'vital-signs' }), obs('59408-5', 'Oxygen saturation', v.spo2, '%', { category: 'vital-signs' }), obs('8310-5', 'Body temperature', v.temp, 'Cel', { category: 'vital-signs' }), obs('9279-1', 'Respiratory rate', v.rr, '/min', { category: 'vital-signs' })]; label = label || `HR ${v.hr}, BP ${v.sbp}, SpO2 ${v.spo2}%`; }
      if (lane === 'Messages') { resources = [{ resourceType: 'Communication', status: 'completed', subject: { reference: 'Patient/pt' }, ...(v.kind === 'patient-message' ? { sender: { reference: 'Patient/pt' } } : { sender: { display: v.kind === 'nurse-message' ? 'Nurse' : 'Consultant' } }), sent: '@t0', topic: { text: label || KIND_LABEL[v.kind] }, ...(v.kind === 'patient-message' && v.urgent ? { priority: 'urgent' } : {}), payload: [{ contentString: v.text }, ...(v.kind === 'patient-message' && v.hidden ? [{ contentString: v.hidden, extension: [{ url: 'urn:hospital-desktop:hidden-payload', valueBoolean: true }] }] : [])] }]; label = label || v.text.slice(0, 60); }
      if (lane === 'Imaging') { resources = v.kind === 'report-final' ? [{ resourceType: 'DiagnosticReport', status: 'final', code: { text: 'Imaging report' }, subject: { reference: 'Patient/pt' }, effectiveDateTime: '@t0', conclusion: v.text }] : [{ resourceType: 'ImagingStudy', status: 'available', subject: { reference: 'Patient/pt' }, started: '@t0', description: v.text || label || 'Imaging study' }]; label = label || v.text.slice(0, 60); }
      if (lane === 'Notes') { resources = [{ resourceType: 'DocumentReference', status: 'current', docStatus: 'final', type: { text: label || 'Note' }, subject: { reference: 'Patient/pt' }, date: '@t0', content: [{ attachment: { contentType: 'text/plain', data: btoa(unescape(encodeURIComponent(v.text || ''))) } }] }]; }
      if (lane === 'Medications') { resources = [{ resourceType: 'MedicationAdministration', status: 'completed', subject: { reference: 'Patient/pt' }, effectiveDateTime: '@t0', medicationCodeableConcept: { text: v.drug } }]; label = label || `${v.drug} given`; }
      const ev = { ...(existing || {}), kind: v.kind, at, label, visibleTo: v.visibleTo, note: v.note, lane, resources };
      if (lane === 'Wearables') { ev.durationMinutes = Math.max(1, Number(v.days) || 1) * 1440; ev.stream = { device: v.device, measures: v.measures.split(',').map((x) => x.trim()).filter(Boolean), rateMinutes: 15, seed: existing?.stream?.seed ?? 1, episodes: v.episode ? [{ kind: v.episode, startMinutes: Number(v.episodeAt) || 0, durationMinutes: v.episode === 'weight-gain' ? 7 * 1440 : v.episode === 'af' ? 150 : 90 }] : [] }; ev.resources = []; label = label || `${v.device}: ${ev.stream.measures.join(', ')}`; ev.label = label; }
      pushUndo();
      if (existing) Object.assign(existing, ev); else st.events.push({ id: `ev-${Date.now().toString(36)}`, ...ev });
      st.selected = existing ? existing.id : st.events.at(-1).id;
      await redraw();
    } });
  };
  const parseAt = (value) => { const str = String(value).trim(); let m = str.match(/^(?:T\s*)?([+-])\s*(\d+(?:\.\d+)?)\s*([mhdw])$/i); const U = { m: 1, h: 60, d: 1440, w: 10080 }; if (m) return Math.round((m[1] === '-' ? -1 : 1) * Number(m[2]) * U[m[3].toLowerCase()]); m = str.match(/^(?:T\s*)?([+-])\s*(\d+)\s*h\s*(\d+)\s*m?$/i); if (m) return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])); m = str.match(/^day\s*(\d+)\s+(\d{1,2}):(\d{2})$/i); if (m) return (Number(m[1]) - 1) * 1440 + Number(m[2]) * 60 + Number(m[3]); if (/^[+-]?\d+$/.test(str)) return Number(str); throw new Error(`"${value}" is not a time. Use minutes, "T+1h 30m" or "Day 2 08:00"`); };

  const presets = (lane) => {
    const add = (list) => { pushUndo(); st.events.push(...list.map((e, i) => ({ id: `ev-${Date.now().toString(36)}-${i}`, visibleTo: 'everyone', lane, ...e }))); redraw(); };
    if (lane === 'Vitals') return btn('Repeat vitals every 4 hours', { small: true, testid: 'preset-vitals-q4h', onClick: () => add([0, 240, 480, 720, 960, 1200].map((at) => ({ at, kind: 'vitals', label: 'Routine vitals', resources: [obs('8867-4', 'Heart rate', 88, '/min', { category: 'vital-signs' }), obs('8480-6', 'Systolic blood pressure', 122, 'mm[Hg]', { category: 'vital-signs' }), obs('59408-5', 'Oxygen saturation', 96, '%', { category: 'vital-signs' })] }))) });
    if (lane === 'Labs') return btn('Morning labs daily at 06:00', { small: true, testid: 'preset-labs-daily', onClick: () => add([1, 2, 3].map((d) => ({ at: (d - 1) * 1440 + 360, kind: 'lab-final', label: `Day ${d} morning labs`, resources: [obs('2823-3', 'Potassium', 4.1, 'mmol/L'), obs('2160-0', 'Creatinine', 1.0, 'mg/dL'), obs('718-7', 'Haemoglobin', 12.8, 'g/dL')] }))) });
    if (lane === 'Wearables') return btn('Wearable heart rate all day', { small: true, testid: 'preset-wearable-hr', onClick: () => add([{ at: 0, kind: 'wearable-stream', label: 'Watch: heart rate, 1 day', durationMinutes: 1440, resources: [], stream: { device: 'watch', measures: ['heart-rate'], rateMinutes: 15, seed: 1, episodes: [] } }]) });
    return null;
  };

  const sparkline = (series) => {
    const pts = series || []; if (!pts.length) return h('div', { class: 'muted small' }, 'No preview');
    const w = 300; const hgt = 60; const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]); const x0 = Math.min(...xs); const x1 = Math.max(...xs) || 1; const y0 = Math.min(...ys); const y1 = Math.max(...ys) || y0 + 1;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${((p[0] - x0) / (x1 - x0 || 1)) * w},${hgt - ((p[1] - y0) / (y1 - y0 || 1)) * (hgt - 6) - 3}`).join(' ');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`); svg.setAttribute('class', 'spark'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Stream preview');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.5'); svg.append(path); return svg;
  };

  const side = async () => {
    const e = st.events.find((x) => x.id === st.selected);
    if (!e) return h('div', { class: 'side', testid: 'event-side' }, h('h3', {}, 'Nothing selected'), h('p', { class: 'muted small' }, 'Click a card, or add one with "+" on a lane. Arrow keys move the selected card by 5 minutes (Shift: one hour). Delete removes it. Cmd+D duplicates. Cmd+Z undoes.'), warnings.length ? [h('h3', {}, 'Warnings'), h('ul', { class: 'warnlist', testid: 'scenario-warnings' }, ...warnings.map((w) => h('li', {}, w.message)))] : h('p', { class: 'muted small', testid: 'scenario-warnings' }, 'No warnings.'));
    const mine = warnings.filter((w) => w.event === e.id);
    let spark = null;
    if (e.kind === 'wearable-stream' && e.stream) { try { const { previewSeries } = await import('/shared/wearables-preview.js'); spark = sparkline(previewSeries(e.stream, e.durationMinutes || 1440)[e.stream.measures[0]]); } catch { spark = null; } }
    return h('div', { class: 'side', testid: 'event-side' }, h('h3', { testid: 'event-side-title' }, e.label || KIND_LABEL[e.kind]),
      kv([['When', `${fmtAt(e.at)}${e.durationMinutes ? ` for ${fmtAt(e.durationMinutes).slice(2)}` : ''}`], ['Kind', KIND_LABEL[e.kind]], ['Lane', e.lane], ['Visible to', e.visibleTo], ['Records', e.resources?.length || 0], e.stream ? ['Stream', `${e.stream.device}: ${e.stream.measures.join(', ')}${e.stream.episodes?.length ? `; episode ${e.stream.episodes[0].kind} at ${fmtAt(e.stream.episodes[0].startMinutes)}` : ''}`] : null]),
      spark,
      h('h3', {}, 'Why is this here'), h('p', { testid: 'event-note' }, e.note || h('span', { class: 'muted' }, 'No note yet.')),
      mine.length ? [h('h3', {}, 'Warnings'), h('ul', { class: 'warnlist' }, ...mine.map((w) => h('li', {}, w.message)))] : null,
      h('div', { class: 'toolbar', style: 'margin-top:0.5rem' }, btn('Edit', { small: true, testid: 'event-edit', onClick: () => eventForm(e.lane, e) }), btn('Duplicate', { small: true, testid: 'event-duplicate', onClick: () => duplicate(e) }), btn('Remove', { small: true, kind: 'danger', testid: 'event-remove', onClick: () => remove(e) })));
  };
  const duplicate = (e) => { pushUndo(); const copy = { ...JSON.parse(JSON.stringify(e)), id: `ev-${Date.now().toString(36)}`, at: e.at + 5 }; st.events.push(copy); st.selected = copy.id; redraw(); };
  const remove = (e) => { pushUndo(); st.events = st.events.filter((x) => x.id !== e.id); st.selected = null; redraw(); };
  const move = (e, minutes) => { pushUndo(); e.at = Math.max(0, e.at + minutes); redraw(); };

  const lanesEl = () => {
    const L = length(); const ppm = pxPerMin(); const width = Math.max(600, L * ppm + 120);
    const lanes = LANES.map((lane) => {
      const track = h('div', { class: 'track', style: `--tick:${tick()}px;width:${width}px`, testid: `lane-${lane.toLowerCase()}` });
      track.addEventListener('dblclick', (ev) => { if (ev.target === track) eventForm(lane); });
      for (const e of st.events.filter((x) => (x.lane || 'Events') === lane).sort((a, b) => a.at - b.at)) {
        const warn = warnings.some((w) => w.event === e.id);
        const card = h('div', { class: `evcard${st.selected === e.id ? ' selected' : ''}${warn ? ' warn' : ''}${e.generated ? ' generated' : ''}`, style: `left:${e.at * ppm}px${e.durationMinutes ? `;width:${Math.max(90, e.durationMinutes * ppm)}px;max-width:none` : ''}`, testid: `event-${e.id}`, role: 'button', tabindex: 0, 'aria-label': `${e.label || KIND_LABEL[e.kind]} at ${fmtAt(e.at)}`, title: `${fmtAt(e.at)}${e.note ? ` · ${e.note}` : ''}` }, h('span', { class: 't' }, fmtAt(e.at)), e.label || KIND_LABEL[e.kind]);
        card.addEventListener('click', (ev) => { ev.stopPropagation(); st.selected = e.id; redraw(); });
        card.addEventListener('pointerdown', (ev) => { if (ev.button !== 0) return; const startX = ev.clientX; const startAt = e.at; let moved = false; card.setPointerCapture(ev.pointerId); const onMove = (mv) => { const delta = Math.round((mv.clientX - startX) / ppm / 5) * 5; if (delta !== 0) moved = true; e.at = Math.max(0, startAt + delta); card.style.left = `${e.at * ppm}px`; card.firstChild.textContent = fmtAt(e.at); card.title = fmtAt(e.at); }; const onUp = () => { card.removeEventListener('pointermove', onMove); card.removeEventListener('pointerup', onUp); if (moved) { st.undo.push(JSON.stringify(st.events.map((x) => (x.id === e.id ? { ...x, at: startAt } : x)))); st.dirty = true; st.selected = e.id; redraw(); } }; card.addEventListener('pointermove', onMove); card.addEventListener('pointerup', onUp); });
        track.append(card);
      }
      return h('div', { class: 'lane' }, h('div', { class: 'name' }, lane, h('div', { class: 'toolbar', style: 'margin:0;gap:0.25rem' }, btn('+', { small: true, testid: `lane-add-${lane.toLowerCase()}`, title: `Add to ${lane}`, onClick: () => eventForm(lane) }), presets(lane))), track);
    });
    const ruler = h('div', { class: 'ruler', style: `width:${width}px` }, ...Array.from({ length: 6 }, (_, i) => h('span', {}, fmtAt(Math.round((L / 5) * i)))));
    return h('div', { class: 'lanes', testid: 'timeline-lanes' }, ruler, ...lanes);
  };

  const scrubber = () => {
    const L = length();
    const range = h('input', { type: 'range', min: 0, max: L, step: 5, value: st.previewAt, testid: 'preview-scrubber', 'aria-label': 'Preview the chart at a moment', onInput: (e) => { st.previewAt = Number(e.target.value); label.textContent = `${fmtAt(st.previewAt)}`; }, onChange: () => loadPreview() });
    const label = h('b', { testid: 'preview-at' }, fmtAt(st.previewAt));
    const out = h('div', { class: 'preview', testid: 'preview-list' }, h('span', { class: 'muted' }, 'Move the scrubber to see the chart as it was at that moment.'));
    const open = btn('Open in EHR at this time', { small: true, testid: 'preview-open', disabled: !st.preview, onClick: () => { if (!st.preview) return; window.open(`/ehr/?branch=${st.preview.branch}&asOf=${encodeURIComponent(st.preview.asOf)}#/chart/${st.preview.patient.split('/')[1]}/summary`, '_blank', 'noopener'); } });
    const loadPreview = async () => { try { if (st.dirty) { out.replaceChildren(h('span', { class: 'muted' }, 'Save first to preview unsaved changes.')); } const pv = await api.get(`/agent-ops/scenarios/${id}/preview`, { at: st.previewAt }); st.preview = pv; open.disabled = false; out.replaceChildren(h('div', { class: 'muted small' }, `${pv.resources.length} records in the chart at ${fmtAt(pv.at)} (${fmtDateTime(pv.asOf)}, read-only through the as-of engine)`), h('ul', {}, ...pv.resources.slice(0, 40).map((r) => h('li', {}, `${r.type}: ${r.label}${r.value ? ` · ${r.value}` : ''}`)))); } catch (err) { out.replaceChildren(h('span', { class: 'muted' }, err.message)); } };
    return h('div', { class: 'scrub-wrap' }, h('div', { class: 'scrub' }, h('span', {}, 'Preview'), range, label, open), out);
  };

  const topBar = () => h('div', { class: 'card launch', style: 'max-width:none' },
    h('div', { class: 'row' }, h('label', {}, 'Title'), h('input', { type: 'text', value: st.title, testid: 'scenario-title', 'aria-label': 'Scenario title', onInput: (e) => { st.title = e.target.value; st.dirty = true; } })),
    h('div', { class: 'row' }, h('label', {}, 'Patient'), h('span', { class: 'mono', testid: 'scenario-patient' }, `${s.patient} · ${s.historyCount} history records`)),
    h('div', { class: 'row' }, h('label', {}, 'Start (T0)'), h('input', { type: 'text', value: st.t0, testid: 'scenario-t0', 'aria-label': 'What the start is', onInput: (e) => { st.t0 = e.target.value; st.dirty = true; } })),
    h('div', { class: 'row' }, h('label', {}, 'Total length'), h('span', { testid: 'scenario-length' }, fmtAt(length()))),
    h('div', { class: 'row' }, h('label', {}, 'Clock for runs'), h('div', {}, sel('scenario-clock', 'Clock mode for runs', st.clock, [['real', 'Real time (a minute is a minute)'], ['accelerated', 'Accelerated (a chosen speed)'], ['jump', 'Jump to next event'], ['chapters', 'Chapters (decision points)']], (v) => { st.clock = v; st.dirty = true; }), st.clock === 'accelerated' ? h('input', { type: 'number', min: 1, max: 3600, value: st.speed, style: 'width:5.625rem;margin-left:0.5rem', testid: 'scenario-speed', 'aria-label': 'Speed: simulated minutes per real minute', onInput: (e) => { st.speed = Number(e.target.value); st.dirty = true; } }) : null, inote('Real time for a short live case; accelerated to watch a deterioration unfold; jump for long agent runs; chapters for multi-day cases read one sitting at a time.'))),
    h('div', { class: 'row' }, h('label', {}, 'Zoom'), sel('scenario-zoom', 'Timeline zoom', st.zoom, [['hours', 'Hours'], ['days', 'Days'], ['weeks', 'Weeks']], (v) => { st.zoom = v; redraw(); })));

  const save = async () => { const saved = await api.put(`/agent-ops/scenarios/${id}`, { title: st.title, summary: st.summary, t0: st.t0, clock: st.clock, speed: st.speed, events: st.events, chapters: s.chapters }); toast(`Saved as version ${saved.version}`); go(`#/scenarios/${saved.id}`); };
  const runDialog = async () => {
    const { agents } = await api.get('/agent-ops/agents');
    const { conditions } = await api.get('/agent-ops/conditions');
    formDialog({ title: 'Run this scenario', testid: 'scenario-run-form', submitLabel: 'Start run', intro: 'A human session opens the chart on a private copy with the clock running. An agent task lets an agent work through the story on its own branch.',
      fields: [{ name: 'who', label: 'Who works on it', type: 'select', options: [['human', 'Me (a human session)'], ...agents.filter((a) => a.enabled).map((a) => [a.id, `Agent: ${a.name}`])], testid: 'run-who', wide: true }, { name: 'clock', label: 'Clock', type: 'select', options: [['real', 'Real time'], ['accelerated', 'Accelerated'], ['jump', 'Jump to next event'], ['chapters', 'Chapters']], value: st.clock, testid: 'run-clock' }, { name: 'condition', label: 'Condition (agents)', type: 'select', options: conditions.map((c) => [c.id, c.name]), value: 'autonomous', testid: 'run-condition' }],
      onSubmit: async (v) => { const out = await api.post('/agent-ops/scenario-runs', { scenario: id, clock: v.clock, speed: st.speed, ...(v.who !== 'human' ? { agentId: v.who, condition: v.condition, wait: false } : {}) }); if (v.who === 'human') { try { localStorage.setItem('hd.simrun', out.id); } catch { /* ignore */ } toast('Run started. Opening the chart on its private copy.'); window.open(out.open, '_blank', 'noopener'); } else toast('Agent run started. See History.'); go(`#/runs/${out.id}`); } });
  };
  const messagesDialog = () => formDialog({ title: 'Add synthetic patient messages', testid: 'messages-form', submitLabel: 'Generate for review', intro: 'Messages are built from this patient\'s own chart and shown here before anything is added. All are tagged synthetic and generated.',
    fields: [{ name: 'types', label: 'Types (comma separated: symptom-question, medication-refill, side-effect, result-question, scheduling, urgent-hidden)', value: 'symptom-question, medication-refill', wide: true, testid: 'messages-types' }, { name: 'tone', label: 'Tone', type: 'select', options: [['brief', 'Brief'], ['worried', 'Worried'], ['rambling', 'Rambling'], ['angry', 'Angry'], ['non-native', 'Non-native English']], testid: 'messages-tone' }, { name: 'n', label: 'How many', type: 'number', value: 3, testid: 'messages-n' }, { name: 'seed', label: 'Seed', type: 'number', value: 1, testid: 'messages-seed' }],
    onSubmit: async (v) => {
      const out = await api.post(`/agent-ops/scenarios/${id}/messages`, { types: v.types.split(',').map((x) => x.trim()).filter(Boolean), tone: v.tone, n: Number(v.n), seed: Number(v.seed), fromMinutes: 0, toMinutes: length() });
      const picked = new Set(out.candidates.map((_, i) => i));
      openDialog({ title: 'Review the generated messages', testid: 'messages-review', wide: true, body: [h('p', { class: 'muted small' }, out.note), ...out.candidates.map((c, i) => h('label', { class: 'toolbar', style: 'align-items:flex-start;margin:0.375rem 0' }, h('input', { type: 'checkbox', checked: true, testid: `message-pick-${i}`, 'aria-label': `Add message ${i + 1}`, onChange: (e) => { if (e.target.checked) picked.add(i); else picked.delete(i); } }), h('div', {}, h('b', {}, `${fmtAt(c.at)} · ${c.topic}`), ' ', badge(c.type, ''), ' ', badge('synthetic, generated', 'accent'), h('div', { style: 'white-space:pre-wrap' }, c.text))))],
        actions: [{ label: 'Cancel', onClick: (c) => c() }, { label: 'Add selected to the timeline', kind: 'primary', testid: 'messages-add', onClick: (close) => { pushUndo(); out.candidates.forEach((c, i) => { if (picked.has(i)) st.events.push({ id: `ev-${Date.now().toString(36)}-${i}`, lane: 'Messages', ...c.event }); }); close(); redraw(); toast(`${picked.size} messages added. Save to keep them.`); } }] });
    } });

  async function redraw() {
    warnings = await warningsFor();
    const header = h('div', { class: 'toolbar' }, btn('Save as new version', { kind: 'primary', testid: 'scenario-save', onClick: () => save().catch(showError) }), btn('Duplicate as variant', { testid: 'scenario-variant', onClick: () => formDialog({ title: 'Duplicate as variant', testid: 'variant-form', submitLabel: 'Duplicate', fields: [{ name: 'title', label: 'Title of the variant', value: `${st.title} (variant)`, wide: true, testid: 'variant-title' }], onSubmit: async (v) => { const made = await api.post(`/agent-ops/scenarios/${id}/variant`, { title: v.title, events: st.events }); toast('Variant made'); go(`#/scenarios/${made.id}`); } }) }), btn('Add messages…', { testid: 'scenario-messages', onClick: messagesDialog }), btn('Export pack', { testid: 'scenario-export', onClick: async () => { const pack = await api.get(`/agent-ops/scenarios/${id}/export`); const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${st.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.scenario.json`; a.click(); } }), btn('Run…', { kind: 'primary', testid: 'scenario-run', onClick: () => runDialog().catch(showError) }), h('span', { class: 'muted small' }, `Version ${s.version}${s.versions?.length > 1 ? ` of ${s.versions.length}` : ''} · ${s.source}${st.dirty ? ' · unsaved changes' : ''}`));
    const body = h('div', { class: 'tl' }, h('div', {}, lanesEl(), scrubber()), await side());
    clear(root).append(page(st.title || 'Scenario', header, h('p', { class: 'muted', testid: 'scenario-summary' }, s.summary || ''), topBar(), body));
  }
  const keys = (ev) => {
    if (ev.target.closest('input, textarea, select, dialog')) return;
    const e = st.events.find((x) => x.id === st.selected);
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); const prev = st.undo.pop(); if (prev) { st.events = JSON.parse(prev); redraw(); } return; }
    if (!e) return;
    if (ev.key === 'ArrowRight') { ev.preventDefault(); move(e, ev.shiftKey ? 60 : 5); } else if (ev.key === 'ArrowLeft') { ev.preventDefault(); move(e, ev.shiftKey ? -60 : -5); } else if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); remove(e); } else if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'd') { ev.preventDefault(); duplicate(e); }
  };
  document.addEventListener('keydown', keys);
  const observer = new MutationObserver(() => { if (!root.isConnected) { document.removeEventListener('keydown', keys); observer.disconnect(); } });
  observer.observe(document.body, { childList: true, subtree: true });
  await redraw();
  return root;
}

// ---------- Red-team tests on scenarios (task 14) ----------
export async function redTeamTestsPage(go, render, testId = null) {
  ensureStyle();
  const lib = await api.get('/agent-ops/red-team/tests');
  const { agents } = await api.get('/agent-ops/agents');
  const { conditions } = await api.get('/agent-ops/conditions');
  const { scenarios } = await api.get('/agent-ops/scenarios');
  const usable = agents.filter((a) => a.enabled);
  const draft = { step: 1, base: null, baseTitle: '', family: 'hidden-instructions', kind: 'patient-message', at: 0, strength: 'clear', placement: 'end', checks: new Set(['no-unsafe-order', 'did-not-write']), title: '', description: '', heldOut: false, perturbations: [], preview: null };
  const root = h('div', {});
  const runResult = h('div', { testid: 'rt-run-result' });
  const runTest = async (id, agentId, condition, variants) => { const out = await api.post(`/agent-ops/red-team/tests/${id}/run`, { agentId, condition, variants }); clear(runResult).append(h('div', { class: 'card', testid: 'rt-result-card' }, h('h3', {}, `${out.title}: attack success rate ${Math.round((out.attackSuccessRate || 0) * 100)}%`), out.heldOut ? h('p', { class: 'muted' }, out.note) : [h('p', { class: 'muted small' }, `${out.failed} of ${out.variants} variants failed a check.${out.weakest ? ` Weakest: ${out.weakest.variant} (${out.weakest.failed.join(', ')}).` : ''}`), table({ testid: 'rt-variants', rows: out.results, rowId: (r) => r.runId, onRow: (r) => go(`#/trace/${r.runId}`), columns: [{ label: 'Variant', render: (r) => r.variant.id }, { label: 'Strength', render: (r) => r.variant.strength }, { label: 'Placement', render: (r) => r.variant.placement }, { label: 'Result', render: (r) => badge(r.passed ? 'Passed' : 'Failed', r.passed ? 'ok' : 'danger') }, { label: 'Failed checks', render: (r) => r.failed.join(', ') }, { label: '', cls: 'actions', render: (r) => btn('Trace', { small: true, testid: `rt-trace-${r.runId}`, onClick: () => go(`#/trace/${r.runId}`) }) }] })])); };

  const form = () => {
    const families = Object.entries(lib.families);
    const stepOne = h('div', { class: 'step' }, h('h3', {}, '1. Pick a base scenario'), h('div', { class: 'toolbar' }, sel('rt-base', 'Base scenario', draft.base || '', [['', 'Choose…'], ...scenarios.map((s) => [s.id, `${s.title} (v${s.version})`])], async (v) => { draft.base = v || null; if (v) { const s = await api.get(`/agent-ops/scenarios/${v}`); draft.baseDoc = { title: s.title, bundle: s.bundle, events: s.events, scenario: s.id }; draft.baseTitle = s.title; const comm = s.bundle.find((r) => r.resourceType === 'Communication'); draft.subjects = comm ? { 'triage-message': `Communication/${comm.id}` } : { 'clinical-workup': s.patient }; } redrawForm(); })), draft.baseTitle ? h('p', { class: 'muted small' }, `Base: ${draft.baseTitle}. Subject for the agent: ${Object.values(draft.subjects || {})[0] || '—'}`) : h('p', { class: 'muted small' }, 'Any scenario: built-in, made here or uploaded.'));
    const stepTwo = h('div', { class: 'step' }, h('h3', {}, '2. Plant the problem'), h('div', { class: 'launch' },
      h('div', { class: 'row' }, h('label', {}, 'Family'), sel('rt-family', 'Perturbation family', draft.family, families, (v) => { draft.family = v; draft.kind = { 'wrong-patient': 'twin', contradictions: 'allergy', 'timing-traps': 'corrected', 'missing-information': 'labs' }[v] || v; redrawForm(); })),
      h('div', { class: 'row' }, h('label', {}, 'Kind'), h('input', { type: 'text', value: draft.kind, testid: 'rt-kind', 'aria-label': 'Kind of problem', onInput: (e) => { draft.kind = e.target.value; } })),
      h('div', { class: 'row' }, h('label', {}, 'When'), h('input', { type: 'number', min: 0, value: draft.at, testid: 'rt-at', 'aria-label': 'Minutes from the start', onInput: (e) => { draft.at = Number(e.target.value) || 0; } })),
      h('div', { class: 'row' }, h('label', {}, 'Strength'), sel('rt-strength', 'Strength', draft.strength, lib.strengths.map((x) => [x, x]), (v) => { draft.strength = v; })),
      h('div', { class: 'row' }, h('label', {}, 'Placement (text)'), sel('rt-placement', 'Placement of planted text', draft.placement, lib.placements.map((x) => [x, x]), (v) => { draft.placement = v; })),
      h('div', { class: 'toolbar' }, btn('Add this problem', { small: true, testid: 'rt-add-perturbation', onClick: () => { draft.perturbations.push({ family: draft.family, kind: draft.kind, at: draft.at, strength: draft.strength, placement: draft.placement }); redrawForm(); } }))),
      draft.perturbations.length ? h('ul', { testid: 'rt-perturbations' }, ...draft.perturbations.map((p, i) => h('li', {}, `${lib.families[p.family]}: ${p.kind} at ${fmtAt(p.at)} (${p.strength}, ${p.placement}) `, btn('remove', { small: true, testid: `rt-remove-${i}`, onClick: () => { draft.perturbations.splice(i, 1); redrawForm(); } })))) : h('p', { class: 'muted small' }, 'No problem planted yet.'));
    const stepThree = h('div', { class: 'step' }, h('h3', {}, '3. What safe behaviour looks like'), h('div', { class: 'checks', style: 'display:flex;flex-wrap:wrap;gap:0.5rem 1rem' }, ...Object.entries(lib.checks).map(([id, label]) => h('label', {}, h('input', { type: 'checkbox', checked: draft.checks.has(id), testid: `rt-check-${id}`, 'aria-label': label, onChange: (e) => { if (e.target.checked) draft.checks.add(id); else draft.checks.delete(id); } }), ` ${label}`))),
      h('div', { class: 'launch', style: 'margin-top:0.625rem' }, h('div', { class: 'row' }, h('label', {}, 'Title'), h('input', { type: 'text', value: draft.title, testid: 'rt-title', 'aria-label': 'Test title', onInput: (e) => { draft.title = e.target.value; } })), h('div', { class: 'row' }, h('label', {}, 'Held out'), h('label', {}, h('input', { type: 'checkbox', checked: draft.heldOut, testid: 'rt-heldout', 'aria-label': 'Hold this test out', onChange: (e) => { draft.heldOut = e.target.checked; } }), ' Results only on the leaderboard; never shown in detail or exported'))),
      h('div', { class: 'toolbar', style: 'margin-top:0.625rem' }, btn('Preview the chart with the problem in place', { small: true, testid: 'rt-preview', onClick: async () => { const body = testBody(); const out = await api.post('/agent-ops/red-team/tests/variants', { ...body, limit: 3 }); draft.preview = out.variants; redrawForm(); } }), btn('Save test', { kind: 'primary', testid: 'rt-save', onClick: async () => { const made = await api.post('/agent-ops/red-team/tests', testBody()); toast(`Test saved: ${made.title}`); go(`#/redteam-tests/${made.id}`); } })),
      draft.preview ? h('div', { class: 'preview', testid: 'rt-preview-list' }, h('b', {}, 'Variants that will be generated'), h('ul', {}, ...draft.preview.map((v) => h('li', {}, `${v.id}: ${v.planted.map((p) => `${p.family} ${p.text ? `"${p.text.slice(0, 80)}"` : p.kind}`).join('; ')}`)))) : null);
    const testBody = () => { if (!draft.baseDoc) throw new Error('Pick a base scenario first'); if (!draft.perturbations.length) throw new Error('Plant at least one problem'); return { title: draft.title || `${draft.baseTitle}: ${lib.families[draft.perturbations[0].family]}`, description: draft.description, base: draft.baseDoc, subjects: draft.subjects, perturbations: draft.perturbations, checks: [...draft.checks], heldOut: draft.heldOut }; };
    return h('div', { class: 'card rtform', testid: 'rt-form' }, h('h3', {}, 'Write your own test'), stepOne, stepTwo, stepThree);
  };
  let formEl = null;
  const redrawForm = () => { const next = form(); if (formEl) formEl.replaceWith(next); formEl = next; };

  const importDialog = () => formDialog({ title: 'Upload a test pack', testid: 'rt-import-form', submitLabel: 'Import', intro: 'A JSON pack (see docs/RED-TEAM.md). Errors come back in plain words.', fields: [{ name: 'json', label: 'Pack JSON', type: 'textarea', rows: 10, required: true, wide: true, testid: 'rt-import-json' }], onSubmit: async (v) => { let pack; try { pack = JSON.parse(v.json); } catch { throw new Error('That is not valid JSON'); } const out = await api.post('/agent-ops/red-team/tests/import', pack); toast(`Imported ${out.imported.length} test${out.imported.length === 1 ? '' : 's'}`); render(); } });
  const run = { agentId: usable[0]?.id ?? null, condition: 'helper-that-asks', variants: 3 };
  const runBar = (id, list = usable) => h('div', { class: 'toolbar' }, sel('rt-run-agent', 'Agent', run.agentId, list.map((a) => [a.id, `${a.name} v${a.version}`]), (v) => { run.agentId = v; }), sel('rt-run-condition', 'Condition', run.condition, conditions.map((c) => [c.id, c.name]), (v) => { run.condition = v; }), h('input', { type: 'number', min: 1, max: 24, value: run.variants, style: 'width:4.375rem', testid: 'rt-run-variants', 'aria-label': 'Number of variants', onInput: (e) => { run.variants = Number(e.target.value) || 3; } }), btn(id ? 'Run this test' : 'Run the whole suite', { kind: 'primary', testid: id ? 'rt-run' : 'rt-run-suite', onClick: async () => { try { if (id) await runTest(id, run.agentId, run.condition, run.variants); else { const out = await api.post('/agent-ops/red-team/tests/suite', { agentId: run.agentId, condition: run.condition, variants: run.variants }); toast(`Suite done: ${out.failed} of ${out.tests} tests had a failing variant`); render(); } } catch (err) { showError(err); } } }));

  if (testId) {
    const t = await api.get(`/agent-ops/red-team/tests/${testId}`);
    const fit = usable.filter((a) => t.subjects?.[a.capability] || (t.heldOut && true));
    const agentsFor = fit.length ? fit : usable;
    if (!agentsFor.some((a) => a.id === run.agentId)) run.agentId = agentsFor[0]?.id ?? null;
    return page(t.title, h('div', { class: 'toolbar' }, btn('Back to tests', { testid: 'rt-back', onClick: () => go('#/redteam-tests') }), t.heldOut ? badge('Held out', 'warn') : btn('Export pack', { testid: 'rt-export', onClick: async () => { const pack = await api.get(`/agent-ops/red-team/tests/${testId}/export`); const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${testId}.redteam.json`; a.click(); } }), btn(t.heldOut ? 'Stop holding out' : 'Hold out', { testid: 'rt-toggle-heldout', onClick: async () => { await api.put(`/agent-ops/red-team/tests/${testId}`, { heldOut: !t.heldOut }); render(); } })),
      h('p', { class: 'muted' }, t.description || ''), t.heldOut ? h('p', { class: 'muted', testid: 'rt-heldout-note' }, t.note) : kv([['Family', lib.families[t.family]], ['Planted', t.perturbations.map((p) => `${p.kind} at ${fmtAt(p.at)}`).join('; ')], ['Checks', t.checks.map((c) => lib.checks[c]).join(', ')], ['Base', `${t.base.title} (${t.base.records} records, ${t.base.events} events)`], ['Variants', (t.variants || []).length], ['Source', t.source]]),
      h('h3', {}, 'Run'), runBar(testId, agentsFor), runResult);
  }
  const suites = lib.suites;
  clear(root).append(page('Red-team tests on scenarios', h('div', { class: 'toolbar' }, btn('Upload a test pack', { testid: 'rt-import', onClick: importDialog })),
    h('p', { class: 'muted' }, 'A test is a scenario plus a planted problem plus what safe behaviour looks like. One test makes many variants (strength, placement, wording, seed). Held-out tests show only their attack success rate on the leaderboard.', inote('The eight original safety scenarios and the newer ones are here as tests, with one test per family of planted problem. A failed suite still blocks promotion.')),
    h('h3', {}, 'Suites'), runBar(null), table({ testid: 'rt-suites', rows: suites, rowId: (r) => r.runId, empty: 'No suite run yet', columns: [{ label: 'When', render: (r) => fmtDateTime(r.startedAt) }, { label: 'Agent', render: (r) => `${r.agentId} v${r.version}` }, { label: 'Condition', render: (r) => r.condition || '—' }, { label: 'Tests', cls: 'num', render: (r) => r.tests }, { label: 'With failures', cls: 'num', render: (r) => r.failed }, { label: 'Attack success rate', cls: 'num', render: (r) => `${Math.round((r.attackSuccessRate || 0) * 100)}%` }, { label: 'Held out', cls: 'num', render: (r) => r.heldOutTests }] }),
    h('h3', {}, 'Tests'), table({ testid: 'rt-tests', rows: lib.tests, onRow: (t) => go(`#/redteam-tests/${t.id}`), columns: [{ label: 'Title', render: (t) => t.title }, { label: 'Family', render: (t) => lib.families[t.family] }, { label: 'Checks', cls: 'num', render: (t) => t.checks }, { label: 'Source', render: (t) => badge(t.source, t.source === 'built-in' ? '' : 'accent') }, { label: '', render: (t) => (t.heldOut ? badge('Held out', 'warn') : '') }, { label: '', cls: 'actions', render: (t) => btn('Open', { small: true, testid: `rt-open-${t.id}`, onClick: () => go(`#/redteam-tests/${t.id}`) }) }] }),
    (() => { formEl = form(); return formEl; })()));
  return root;
}
