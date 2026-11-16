// Nurse chart tabs: Work List, MAR, Flowsheets,
// Intake/Output, Education and Care Plan. Each tab reads through the
// nursing helper routes or the chart it is given, so time travel and
// practice copies apply. Write controls are gated by the role map.
import { h, btn, badge, toast, table, card, kv, formDialog, openDialog, askReason, fmtDateTime, fmtTime, fmtDate, toLocalInput } from '/shared/ui.js';
import { fhir, api, view, identity, display, coding, lifecycle, ext, refId } from '/shared/fhir.js';
import { tabReadOnly, canWrite } from '/shared/roles.js';

const NEWS2_SYSTEM = 'urn:hospital-desktop:score';
const TASK_SYSTEM = 'urn:hospital-desktop:task';
const STATE_KIND = { due: '', missed: 'danger', given: 'ok', late: 'warn', held: 'warn', refused: 'danger', 'not-given': 'danger', 'in-progress': 'accent', stopped: '' };
const STATE_LABEL = { due: 'Due', missed: 'Missed', given: 'Given', late: 'Given late', held: 'Held', refused: 'Refused', 'not-given': 'Not given', 'in-progress': 'Running', stopped: 'Stopped' };
export const bandKind = (band) => ({ low: 'ok', 'low-medium': 'warn', medium: 'warn', high: 'danger', incomplete: '' }[band] || '');
export const news2Badge = (score, testid) => (score ? badge(score.incomplete ? 'NEWS2 incomplete' : `NEWS2 ${score.total} (${score.band})`, bandKind(score.incomplete ? 'incomplete' : score.band), testid) : badge('NEWS2 not scored', '', testid));

/** Latest NEWS2 score Observation from a chart, as { total, band, incomplete, at }. */
export function latestNews2(observations) {
  const o = observations.filter((x) => (x.code?.coding || []).some((c) => c.system === NEWS2_SYSTEM)).sort((a, b) => (a.effectiveDateTime < b.effectiveDateTime ? 1 : -1))[0];
  return o ? { total: o.valueInteger ?? null, band: o.interpretation?.[0]?.coding?.[0]?.code, incomplete: Boolean(o.dataAbsentReason), at: o.effectiveDateTime, response: o.interpretation?.[0]?.coding?.[0]?.display } : null;
}

const kindLabel = { medication: 'Medication', vitals: 'Vitals', assessment: 'Assessment', acknowledge: 'Order', specimen: 'Specimen', escalation: 'Escalation', task: 'Task' };

/** The work-list table shared by the chart tab and the nurse's home screen. */
export function worklistTable(entries, { base, openChart, testid = 'worklist-table' }) {
  const rows = entries.flatMap((e) => e.items.map((i) => ({ ...i, pid: e.patient.id, pname: e.patient.name, pmrn: e.patient.mrn, unit: e.unit, score: e.latestNews2, key: `${e.patient.id}-${i.kind}-${i.ref || i.due}` })));
  return table({ testid, rows, rowId: (r) => r.key, empty: 'No data to display', columns: [
    { label: 'Due', cls: 'num', render: (r) => h('span', { class: r.overdue ? 'danger' : '' }, fmtDateTime(r.due), r.overdue ? badge('Overdue', 'danger') : '') },
    ...(openChart ? [{ label: 'Patient', render: (r) => h('a', { href: `#/chart/${r.pid}/worklist`, testid: `worklist-patient-${r.pid}`, 'aria-label': `Open chart ${r.pname}` }, r.pname, ' ', h('span', { class: 'mono muted small' }, r.pmrn)) }, { label: 'Unit', render: (r) => r.unit || '—' }] : []),
    { label: 'Kind', render: (r) => badge(kindLabel[r.kind] || r.kind, r.kind === 'escalation' ? 'danger' : r.kind === 'medication' ? 'accent' : '') },
    { label: 'Item', render: (r) => r.label },
    { label: '', cls: 'actions', render: (r) => btn('Open', { small: true, testid: `worklist-open-${r.key}`, title: `Open the ${r.open} tab`, onClick: () => { location.hash = `#/chart/${r.pid}/${r.open}`; } }) },
  ] });
}

export function nursingTabs(c) {
  const { p, cat, done, base, go, query, all, currentEncounter } = c;
  const subject = { reference: `Patient/${p.id}` };
  const readOnly = (tab) => tabReadOnly(tab);
  const obs = all.filter((r) => r.resourceType === 'Observation');

  async function worklistTab() {
    const data = await api.get('/api/nursing/worklist', { patient: p.id });
    const entry = data.patients[0];
    const escalations = all.filter((r) => r.resourceType === 'Task' && r.code?.coding?.some((x) => x.code === 'news2-escalation') && ['requested', 'ready'].includes(r.status));
    return [h('div', { class: 'toolbar' }, h('h2', { class: 'grow' }, 'Tasks'), news2Badge(entry.latestNews2, 'worklist-news2'), h('span', { class: 'muted small' }, `${entry.overdue} overdue`)),
      escalations.length ? h('div', { class: 'banner warn', testid: 'worklist-escalation' }, `Escalation open: ${escalations.map((t) => t.code.text).join('; ')}. `, h('span', { class: 'muted' }, 'Decision support in a simulation, labelled as such.')) : null,
      worklistTable([entry], { base, testid: 'worklist-table' })];
  }

  // ----- MAR -----
  async function marTab() {
    const shift = query.get('shift') || '';
    const grid = await api.get('/api/nursing/mar', { patient: p.id, ...(shift ? { shift } : {}) });
    const ro = readOnly('mar');
    const administer = (row, cell) => {
      const needsWitness = row.highAlert;
      const prn = row.section === 'prn';
      formDialog({ title: `${row.medication}: ${cell ? `due ${fmtTime(cell.due)}` : prn ? 'PRN dose' : 'dose'}`, testid: 'mar-form', submitLabel: 'Record', wide: true,
        intro: `Scan the wristband, then the medication. ${row.dose ? `Ordered: ${row.dose.value} ${row.dose.unit} ${row.route || ''} ${row.frequency || ''}.` : ''}${needsWitness ? ' High-alert medication: a second nurse must witness.' : ''}`,
        fields: [
          { name: 'patientScan', label: 'Wristband scan (MRN)', required: true, placeholder: 'Scan or type the MRN' },
          { name: 'medicationScan', label: 'Medication scan (RxNorm code)', required: true, placeholder: 'Scan or type the code' },
          { name: 'outcome', label: 'Outcome', type: 'select', options: [['given', 'Given'], ['held', 'Held'], ['refused', 'Refused'], ['not-given', 'Not given'], ...(row.section === 'continuous' ? [['started', 'Started infusion']] : [])] },
          { name: 'dose', label: `Dose${row.dose ? ` (${row.dose.unit})` : ''}`, type: 'number', step: 'any', value: row.dose?.value ?? '' },
          { name: 'route', label: 'Route', value: row.route || '' },
          { name: 'site', label: 'Site (optional)' },
          { name: 'reason', label: 'Reason (held, refused, not given)', wide: true },
          ...(prn ? [{ name: 'prnReason', label: 'PRN reason (required when given)', wide: true }] : []),
          ...(needsWitness ? [{ name: 'witness', label: 'Witness (second nurse)', required: true }] : []),
        ], onSubmit: async (v, { error }) => {
          const body = { order: row.id, patientScan: v.patientScan, medicationScan: v.medicationScan, outcome: v.outcome, dose: v.dose, unit: row.dose?.unit, route: v.route, site: v.site, reason: v.reason, prnReason: v.prnReason, witness: v.witness, due: cell?.due };
          try {
            await api.post('/api/nursing/mar/administer', body);
          } catch (err) {
            if (err.status !== 409 || !err.body?.issues?.length) throw err;
            const failed = err.body.issues.map((i) => i.diagnostics);
            const reason = await new Promise((resolve) => {
              let answered = false;
              const { dlg } = openDialog({ title: 'Check failed', testid: 'mar-block', danger: true, body: h('div', {}, h('p', {}, h('strong', {}, 'Do not give.'), ' The server found:'), h('ul', { testid: 'mar-block-list' }, failed.map((f) => h('li', {}, f))), h('p', { class: 'muted small' }, 'Overriding needs a typed reason and is logged as a safety override.')), actions: [
                { label: 'Cancel', onClick: (close) => close() },
                { label: 'Override with a reason', kind: 'danger', testid: 'mar-override', onClick: async (close) => { close(); const r = await askReason({ title: 'Override reason', testid: 'mar-override-reason' }); answered = true; resolve(r); } },
              ] });
              dlg.addEventListener('close', () => { setTimeout(() => { if (!answered) resolve(null); }, 0); });
            });
            if (!reason) return false;
            await api.post('/api/nursing/mar/administer', { ...body, override: reason });
            toast('Recorded with a logged override');
            return undefined;
          }
          done('Recorded');
          return undefined;
        } });
    };
    const cell = (row, x) => h('td', { class: `cell ${STATE_KIND[x.state]}`.trim(), testid: `mar-cell-${row.id}-${new Date(x.due).getHours()}` },
      h('div', { class: 'small' }, fmtTime(x.due)), badge(STATE_LABEL[x.state] || x.state, STATE_KIND[x.state]),
      x.record?.performer?.[0]?.actor?.display ? h('div', { class: 'muted small' }, x.record.performer[0].actor.display) : null,
      ['due', 'missed'].includes(x.state) && !ro && row.verified !== false ? btn('Record', { small: true, write: true, perm: ['MedicationAdministration', 'create'], testid: `mar-record-${row.id}-${new Date(x.due).getHours()}`, onClick: () => administer(row, x) }) : null);
    const section = (name, rows) => (rows.length ? [h('tr', { class: 'group' }, h('td', { colspan: 3 + grid.hours.length }, name)), rows.map((row) => h('tr', { testid: `mar-row-${row.id}` },
      h('th', { class: 'rowlabel' }, h('div', {}, row.medication, row.highAlert ? ' ' : '', row.highAlert ? badge('High alert', 'danger') : null), h('div', { class: 'muted small' }, row.sig)),
      h('td', {}, row.verified ? badge('Verified', 'ok') : row.emergencyOverride ? badge('Emergency override', 'danger') : badge('Awaiting pharmacy', 'warn')),
      row.section === 'scheduled' ? row.cells.map((x) => cell(row, x)) : h('td', { colspan: grid.hours.length }, row.givenThisShift.length ? row.givenThisShift.map((g) => h('span', { class: 'badge ok' }, `${fmtTime(g.at)} ${g.dose ?? ''}`)) : h('span', { class: 'muted' }, row.section === 'prn' ? 'No PRN dose this shift' : 'Not started this shift'), ' ', !ro && (row.verified || row.emergencyOverride) ? btn(row.section === 'prn' ? 'Give PRN' : 'Record', { small: true, write: true, perm: ['MedicationAdministration', 'create'], testid: `mar-record-${row.id}`, onClick: () => administer(row, null) }) : null),
      h('td', { class: 'num' }, row.givenThisShift.length)))] : []);
    const rows = (s) => grid.rows.filter((r) => r.section === s);
    return [h('div', { class: 'toolbar' }, h('h2', { class: 'grow' }, 'Medication administration record'), ro ? badge('Read-only for your role', '') : null,
      h('div', { class: 'seg' }, [['', 'Current shift'], ['day', 'Day'], ['night', 'Night']].map(([id, label]) => h('button', { type: 'button', testid: `mar-shift-${id || 'current'}`, 'aria-label': label, 'aria-pressed': String(shift === id), onClick: () => go(`${base}/mar${id ? `?shift=${id}` : ''}`) }, label))),
      h('span', { class: 'muted small' }, `${fmtDateTime(grid.shift.start)} to ${fmtDateTime(grid.shift.end)}`)),
    h('div', { class: 'tablewrap' }, h('table', { class: 'flow', testid: 'mar-grid' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Medication'), h('th', {}, 'Pharmacy'), h('th', { colspan: grid.hours.length }, 'Doses this shift (scheduled: one cell per due time)'), h('th', { class: 'num' }, 'Given'))),
      h('tbody', {}, grid.rows.length ? [section('Scheduled', rows('scheduled')), section('PRN (as needed)', rows('prn')), section('Continuous', rows('continuous'))] : h('tr', {}, h('td', { colspan: 3 + grid.hours.length, class: 'empty', testid: 'mar-empty' }, 'No active medication orders'))))),
    h('p', { class: 'muted small' }, 'Legend: Due, Missed (more than 60 minutes after due with nothing recorded), Given, Given late, Held, Refused, Not given. Scanning is simulated by a typed or scanned field.')];
  }

  // ----- Flowsheets -----
  async function flowsheetsTab() {
    const data = await api.get('/api/nursing/flowsheet', { patient: p.id });
    const ro = readOnly('flowsheets');
    const addColumn = () => formDialog({ title: 'Add a flowsheet column', testid: 'flowsheet-form', submitLabel: 'Save', wide: true,
      intro: 'A complete set (respiration, SpO2, oxygen device, blood pressure, pulse, consciousness, temperature) scores NEWS2 automatically. Decision support in a simulation.',
      fields: [
        { name: 'at', label: 'Measured at', type: 'datetime-local', value: toLocalInput(), max: toLocalInput(), required: true },
        ...cat.vitals.filter((v) => v.key !== 'bmi').map((v) => ({ name: v.key, label: `${v.name} (${v.unit})`, type: 'number', step: 'any', min: 0 })),
        { name: 'spo2Scale', label: 'SpO2 scale 2 (hypercapnic respiratory failure)', type: 'checkbox' },
        ...cat.assessments.map((a) => (a.kind === 'number' ? { name: a.key, label: a.name, type: 'number', step: 'any', min: a.min, max: a.max } : { name: a.key, label: a.name, type: 'select', options: [['', '—'], ...a.options.map((o) => [o, o])] })),
      ], onSubmit: async (v) => {
        const vitals = Object.fromEntries(cat.vitals.filter((x) => x.key !== 'bmi' && v[x.key] != null && v[x.key] !== '').map((x) => [x.key, v[x.key]]));
        const assessments = Object.fromEntries(cat.assessments.filter((a) => v[a.key] != null && v[a.key] !== '').map((a) => [a.key, v[a.key]]));
        const r = await api.post('/api/nursing/flowsheet', { patient: p.id, at: new Date(v.at).toISOString(), vitals, assessments, spo2Scale: v.spo2Scale ? 2 : 1 });
        done(r.news2 ? (r.news2.incomplete ? 'Saved. NEWS2 incomplete (not every parameter recorded)' : `Saved. NEWS2 ${r.news2.total}: ${r.news2.response}`) : 'Saved');
      } });
    const bands = [...new Set(data.rows.map((r) => r.band))];
    const grid = data.times.length ? h('div', { class: 'tablewrap' }, h('table', { class: 'flow', testid: 'flowsheet-grid' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Item'), data.times.map((t) => h('th', { class: 'num' }, fmtDate(t), h('div', { class: 'small' }, fmtTime(t)))))),
      h('tbody', {},
        h('tr', { class: 'group', testid: 'flowsheet-news2-row' }, h('th', { class: 'rowlabel' }, 'NEWS2 (decision support)'), data.scores.map((sc, i) => h('td', { class: `cell ${sc ? bandKind(sc.incomplete ? 'incomplete' : sc.band) : ''}`.trim(), testid: `flowsheet-news2-${i}` }, sc ? (sc.incomplete ? 'incomplete' : `${sc.total} ${sc.band}`) : ''))),
        bands.flatMap((band) => [h('tr', { class: 'group' }, h('td', { colspan: data.times.length + 1 }, band)), data.rows.filter((r) => r.band === band).map((r) => h('tr', { testid: `flowsheet-row-${r.key}` }, h('th', { class: 'rowlabel' }, r.name, ' ', h('span', { class: 'muted small' }, r.unit || '')), r.cells.map((c) => h('td', { class: `cell ${c?.flag || ''}`.trim() }, c ? c.value : ''))))]))))
      : h('div', { class: 'card empty', testid: 'flowsheet-empty' }, 'No flowsheet entries');
    return [h('div', { class: 'toolbar' }, h('h2', { class: 'grow' }, 'Flowsheets'), h('span', { class: 'muted small' }, `${data.times.length} columns`), ro ? badge('Read-only for your role', '') : btn('Add column', { kind: 'primary', write: true, perm: ['Observation', 'create'], testid: 'flowsheet-add', onClick: addColumn })), grid,
      h('p', { class: 'muted small' }, 'NEWS2 bands follow the Royal College of Physicians chart (2017). A missing parameter shows "incomplete", never a low score. A score of 5 or more, or a single parameter scoring 3, opens an escalation task for the physician.')];
  }

  // ----- Intake / Output -----
  async function ioTab() {
    const data = await api.get('/api/nursing/io', { patient: p.id });
    const ro = readOnly('io');
    const record = () => formDialog({ title: 'Record intake or output', testid: 'io-form', submitLabel: 'Save', fields: [
      { name: 'item', label: 'Item', type: 'select', options: cat.ioItems.map((i) => [i.code, `${i.direction === 'in' ? 'In' : 'Out'}: ${i.name}`]) },
      { name: 'mL', label: 'Volume (mL)', type: 'number', min: 0, max: 10000, required: true },
      { name: 'at', label: 'Time', type: 'datetime-local', value: toLocalInput(), max: toLocalInput(), required: true }, { name: 'note', label: 'Note (optional)', wide: true },
    ], onSubmit: async (v) => { await api.post('/api/nursing/io', { patient: p.id, item: v.item, mL: v.mL, at: new Date(v.at).toISOString(), note: v.note }); done('Recorded'); } });
    const block = (title, t, testid) => card(title, kv([['In', `${t.in} mL`], ['Out', `${t.out} mL`], ['Balance', h('strong', { testid: `${testid}-balance` }, `${t.balance > 0 ? '+' : ''}${t.balance} mL`)]]), h('div', { class: 'muted small' }, Object.entries(t.byItem || {}).map(([k, v]) => `${cat.ioItems.find((i) => i.code === k)?.name || k} ${v}`).join(' · ')));
    return [h('div', { class: 'toolbar' }, h('h2', { class: 'grow' }, 'Intake and output'), ro ? badge('Read-only for your role', '') : btn('Record', { kind: 'primary', write: true, perm: ['Observation', 'create'], testid: 'io-record', onClick: record })),
      h('div', { class: 'grid3' }, block(`This shift (${data.currentShift.id})`, data.currentShift, 'io-shift'), block(`Previous shift (${data.previousShift.id})`, data.previousShift, 'io-previous'), block('24 hours (from 07:00)', data.last24h, 'io-24h')),
      card('Since admission', kv([['From', fmtDateTime(data.sinceAdmission.start)], ['In', `${data.sinceAdmission.in} mL`], ['Out', `${data.sinceAdmission.out} mL`], ['Balance', h('strong', { testid: 'io-admission-balance' }, `${data.sinceAdmission.balance > 0 ? '+' : ''}${data.sinceAdmission.balance} mL`)]])),
      table({ testid: 'io-table', rows: data.entries, empty: 'No data to display', columns: [{ label: 'Time', cls: 'num', render: (r) => fmtDateTime(r.at) }, { label: 'Item', render: (r) => r.name }, { label: 'mL', cls: 'num', render: (r) => r.mL }, { label: 'Note', render: (r) => r.note || '' }] })];
  }

  // ----- Education -----
  function educationTab() {
    const records = all.filter((r) => r.resourceType === 'Procedure' && r.category?.coding?.some((x) => x.code === 'education')).sort((a, b) => (a.performedDateTime < b.performedDateTime ? 1 : -1));
    const detail = (r) => { try { return JSON.parse(ext(r, 'urn:hospital-desktop:education') || '{}'); } catch { return {}; } };
    const record = () => formDialog({ title: 'Record education', testid: 'education-form', submitLabel: 'Save', fields: [
      { name: 'topic', label: 'Topic', type: 'select', options: cat.educationTopics.map((t) => [t, t]) }, { name: 'to', label: 'Taught to', type: 'select', options: [['Patient', 'Patient'], ['Family or carer', 'Family or carer'], ['Patient and family', 'Patient and family']] },
      { name: 'method', label: 'Method', type: 'select', options: cat.educationMethods.map((m) => [m, m]) }, { name: 'understanding', label: 'Understanding checked by', type: 'select', options: cat.understanding.map((u) => [u, u]) },
      { name: 'followUp', label: 'Follow-up needed', type: 'checkbox' }, { name: 'note', label: 'Note', type: 'textarea', rows: 3 },
    ], onSubmit: async (v) => { await api.post('/api/nursing/education', { patient: p.id, ...v }); done('Education recorded'); } });
    return [h('div', { class: 'toolbar' }, h('h2', { class: 'grow' }, 'Education'), btn('Record education', { kind: 'primary', write: true, perm: ['Procedure', 'create'], testid: 'education-record', onClick: record })),
      table({ testid: 'education-table', rows: records, empty: 'No data to display', columns: [
        { label: 'When', cls: 'num', render: (r) => fmtDateTime(r.performedDateTime) }, { label: 'Topic', render: (r) => r.code?.text }, { label: 'To', render: (r) => detail(r).to }, { label: 'Method', render: (r) => detail(r).method },
        { label: 'Understanding', render: (r) => detail(r).understanding }, { label: 'Follow-up', render: (r) => (detail(r).followUp ? badge('Needed', 'warn') : 'No') }, { label: 'By', render: (r) => r.performer?.[0]?.actor?.display || '' },
      ] })];
  }

  // ----- Care plan -----
  function carePlanTab() {
    const plans = all.filter((r) => r.resourceType === 'CarePlan').sort((a, b) => (a.meta.lastUpdated < b.meta.lastUpdated ? 1 : -1));
    const goals = all.filter((r) => r.resourceType === 'Goal');
    const problems = all.filter((r) => r.resourceType === 'Condition');
    const goalsOf = (plan) => (plan.goal || []).map((g) => goals.find((x) => x.id === refId(g.reference))).filter(Boolean);
    const newPlan = () => formDialog({ title: 'New care plan', testid: 'careplan-form', submitLabel: 'Create', wide: true, fields: [
      { name: 'title', label: 'Title', required: true }, { name: 'problem', label: 'Problem addressed', type: 'select', options: [['', '—'], ...problems.map((c) => [c.id, display(c.code)])] },
      { name: 'goal', label: 'First goal', required: true, wide: true }, { name: 'due', label: 'Goal target date', type: 'date', required: true },
      { name: 'interventions', label: 'Interventions (one per line)', type: 'textarea', rows: 4, required: true },
    ], onSubmit: async (v) => {
      const goal = await fhir.create({ resourceType: 'Goal', lifecycleStatus: 'active', description: { text: v.goal }, subject, target: [{ dueDate: v.due }], startDate: fmtDate(new Date()) });
      await fhir.create({ resourceType: 'CarePlan', status: 'active', intent: 'plan', title: v.title, subject, created: new Date().toISOString(), author: { display: identity.display }, ...(v.problem ? { addresses: [{ reference: `Condition/${v.problem}` }] } : {}), goal: [{ reference: `Goal/${goal.id}` }],
        activity: v.interventions.split('\n').map((t) => t.trim()).filter(Boolean).map((description) => ({ detail: { status: 'in-progress', description } })) });
      done('Care plan created');
    } });
    const addGoal = (plan) => formDialog({ title: 'Add a goal', testid: 'goal-form', submitLabel: 'Add', fields: [{ name: 'goal', label: 'Goal', required: true, wide: true }, { name: 'due', label: 'Target date', type: 'date', required: true }], onSubmit: async (v) => {
      const goal = await fhir.create({ resourceType: 'Goal', lifecycleStatus: 'active', description: { text: v.goal }, subject, target: [{ dueDate: v.due }] });
      await fhir.update({ ...plan, goal: [...(plan.goal || []), { reference: `Goal/${goal.id}` }] }); done('Goal added');
    } });
    const evaluate = (plan) => formDialog({ title: 'Shift evaluation', testid: 'evaluation-form', submitLabel: 'Save', fields: [{ name: 'text', label: 'Evaluation this shift', type: 'textarea', rows: 4, required: true }], onSubmit: async (v) => { await api.post(`/api/nursing/careplans/${plan.id}/evaluate`, { text: v.text }); done('Evaluation saved'); } });
    const planCard = (plan) => card(plan.title || 'Care plan',
      h('div', { class: 'toolbar' }, badge(plan.status, plan.status === 'active' ? 'ok' : ''), h('span', { class: 'muted small grow' }, plan.addresses?.length ? `Addresses: ${plan.addresses.map((a) => display(problems.find((c) => c.id === refId(a.reference))?.code) || a.reference).join(', ')}` : ''),
        btn('Add goal', { small: true, write: true, perm: ['Goal', 'create'], testid: `careplan-add-goal-${plan.id}`, onClick: () => addGoal(plan) }), btn('Evaluate this shift', { small: true, write: true, perm: ['CarePlan', 'update'], testid: `careplan-evaluate-${plan.id}`, onClick: () => evaluate(plan) }),
        plan.status === 'active' ? btn('Complete plan', { small: true, write: true, perm: ['CarePlan', 'transition'], testid: `careplan-complete-${plan.id}`, onClick: async () => { await fhir.transition(plan, 'completed'); done('Care plan completed'); } }) : null),
      h('h3', {}, 'Goals'), table({ testid: `goals-${plan.id}`, rows: goalsOf(plan), empty: 'No data to display', columns: [
        { label: 'Goal', render: (g) => g.description?.text }, { label: 'Target', cls: 'num', render: (g) => g.target?.[0]?.dueDate || '' }, { label: 'Status', render: (g) => badge(g.lifecycleStatus, g.lifecycleStatus === 'completed' ? 'ok' : g.lifecycleStatus === 'active' ? 'accent' : '') },
        { label: '', cls: 'actions', render: (g) => (g.lifecycleStatus === 'active' ? btn('Resolve', { small: true, write: true, perm: ['Goal', 'transition'], testid: `goal-resolve-${g.id}`, onClick: async () => { await fhir.transition(g, 'completed'); done('Goal resolved'); } }) : '') },
      ] }),
      h('h3', {}, 'Interventions'), h('ul', { testid: `interventions-${plan.id}` }, (plan.activity || []).map((a) => h('li', {}, a.detail?.description || ''))),
      h('h3', {}, 'Evaluations'), (plan.note || []).length ? h('ul', { testid: `evaluations-${plan.id}` }, plan.note.slice().reverse().map((n) => h('li', {}, h('span', { class: 'muted small' }, `${fmtDateTime(n.time)} · ${n.authorString || ''}: `), n.text))) : h('p', { class: 'muted' }, 'No evaluation yet'));
    return [h('div', { class: 'toolbar' }, h('h2', { class: 'grow' }, 'Care Plan'), btn('New care plan', { kind: 'primary', write: true, perm: ['CarePlan', 'create'], testid: 'careplan-new', onClick: newPlan })), plans.length ? plans.map(planCard) : h('div', { class: 'card empty', testid: 'careplan-empty' }, 'No care plan')];
  }

  /** The nursing card on the Summary tab. */
  function nursingSummary() {
    const score = latestNews2(obs);
    const tasks = all.filter((r) => r.resourceType === 'Task' && ['requested', 'ready', 'accepted', 'in-progress'].includes(r.status));
    const isolation = ext(currentEncounter || {}, 'urn:hospital-desktop:isolation');
    const codeStatus = obs.filter((o) => (o.code?.coding || []).some((x) => x.code === 'code-status')).sort((a, b) => (a.effectiveDateTime < b.effectiveDateTime ? 1 : -1))[0];
    const lines = all.filter((r) => r.resourceType === 'Procedure' && r.category?.coding?.some((x) => x.code === 'line-or-drain') && r.status === 'in-progress');
    return card('Nursing', kv([
      ['Early-warning score', h('span', {}, news2Badge(score, 'summary-news2'), score ? h('span', { class: 'muted small' }, ` at ${fmtDateTime(score.at)}`) : '')],
      ['Code status', codeStatus?.valueString || codeStatus?.valueCodeableConcept?.text || 'Not recorded'], ['Isolation', isolation || 'None'],
      ['Diet and activity', (currentEncounter?.extension || []).filter((e) => ['urn:hospital-desktop:diet', 'urn:hospital-desktop:activity'].includes(e.url)).map((e) => e.valueString).join(' · ') || 'Not recorded'],
      ['Lines and drains', lines.length ? lines.map((l) => l.code?.text).join(', ') : 'None recorded'], ['Tasks open', h('a', { href: `${base}/worklist`, testid: 'summary-tasks-link' }, `${tasks.length}`)],
    ]), h('p', { class: 'muted small' }, 'NEWS2 is decision support inside a simulation.'));
  }

  return { worklist: worklistTab, mar: marTab, flowsheets: flowsheetsTab, io: ioTab, education: educationTab, careplan: carePlanTab, nursingSummary };
}

/** The SBAR handover template for a nursing note. */
export const SBAR = 'Situation:\n\nBackground:\n\nAssessment:\n\nRecommendation:\n';
export const TASK_SYSTEM_URL = TASK_SYSTEM;
