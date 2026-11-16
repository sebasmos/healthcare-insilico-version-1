// Beds app: the bed board (unit columns of bed tiles), the
// waiting list, expected discharges, turnaround figures, and every bed move.
// The server computes the board at the current view (as-of time and branch),
// so time travel shows the hospital as it was; writes are disabled then.
import { h, clear, btn, badge, toast, table, card, kv, formDialog, openDialog, askReason, confirmDialog, initApp, timeStrip, fmtDate, fmtDateTime, toLocalInput, showError } from '/shared/ui.js';
import { api, view } from '/shared/fhir.js';

const root = document.getElementById('app');
const shell = await initApp({ app: 'beds', crumbs: { app: 'Beds', home: 'dashboard', names: { dashboard: 'Dashboard' } } });
const STATES = ['available', 'occupied', 'cleaning', 'blocked', 'reserved'];
const STATE_LABEL = { available: 'Available', occupied: 'Occupied', cleaning: 'Cleaning', blocked: 'Blocked', reserved: 'Reserved' };
const CLASS = { IMP: 'Inpatient', EMER: 'Emergency' };

export function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }
const minutes = (m) => { if (m == null) return ''; if (m < 60) return `${m} min`; const hours = Math.floor(m / 60); if (hours < 48) return `${hours} h ${m % 60} min`; return `${Math.floor(hours / 24)} d ${hours % 24} h`; };
const turn = (t) => (t.count ? `median ${t.medianMinutes} min, mean ${t.meanMinutes} min (${t.count})` : 'none yet');
const who = (e) => (e?.patient ? `${e.patient.name}${e.patient.mrn ? ` · ${e.patient.mrn}` : ''}` : 'Unknown patient');
const allBeds = (data) => data.units.flatMap((u) => u.rooms.flatMap((r) => r.beds.map((b) => ({ ...b, unit: u }))));

// ---------- Shell ----------
function renderShell(route, content) {
  const withSeconds = (d) => `${toLocalInput(d)}:${String(d.getSeconds()).padStart(2, '0')}`;
  const asOfInput = h('input', { type: 'datetime-local', step: 1, testid: 'time-travel-input', 'aria-label': 'View as of', style: 'width:auto;height:1.875rem', value: view.asOf ? withSeconds(new Date(view.asOf)) : '', max: withSeconds(new Date()), onChange: (e) => view.set({ asOf: e.target.value ? new Date(e.target.value).toISOString() : null }) });
  const top = h('div', { class: 'topbar' },
    h('span', { class: 'appname' }, 'Beds'), h('span', { class: 'dot' }, '·'),
    h('nav', { 'aria-label': 'Beds sections' }, h('a', { href: '#/dashboard', testid: 'nav-dashboard', 'aria-label': 'Dashboard', 'aria-current': route === 'dashboard' ? 'page' : undefined }, '▦ Dashboard')),
    h('span', { class: 'spacer' }),
    h('div', { class: 'timetravel', testid: 'time-travel' }, h('span', {}, 'View as of:'), asOfInput, view.asOf ? btn('Back to live', { small: true, testid: 'time-travel-live', onClick: () => view.set({ asOf: null }) }) : h('span', { class: 'muted' }, 'live')),
    shell.themeToggle, shell.roleSelect);
  clear(root).append(...[top, timeStrip(), content].flat().filter(Boolean));
}
const page = (title, actions, ...children) => h('main', { class: 'content' }, h('div', { class: 'page-head' }, h('h1', {}, title), actions), ...children);

// ---------- Moves ----------
const post = async (route, body, message) => { const out = await api.post(`/api/beds/${route}`, body); toast(message); render(); return out; };
const closeDialogs = () => document.querySelectorAll('dialog[open]').forEach((d) => { d.close(); d.remove(); });

/** Pick a unit and an available bed in it. onPick(bedId, values). */
function chooseBedDialog({ title, data, unitId, encounter, withReason = false, submitLabel = 'Assign', testid = 'choose-bed', onPick }) {
  const beds = allBeds(data);
  const free = (uid) => beds.filter((b) => b.unit.id === uid && (b.state === 'available' || (b.state === 'reserved' && encounter && b.reservedFor === encounter)));
  const units = data.units.map((u) => [u.id, `${u.name} (${free(u.id).length} free)`]);
  const first = unitId && data.units.some((u) => u.id === unitId) ? unitId : data.units.find((u) => free(u.id).length)?.id || data.units[0]?.id;
  const fill = (byName, uid) => {
    const select = byName.bed.input;
    const options = free(uid).map((b) => h('option', { value: b.id }, `${b.room?.name || ''} ${b.name}${b.isolation ? ' (isolation)' : ''}${b.state === 'reserved' ? ' (reserved for this patient)' : ''}`));
    select.replaceChildren(...(options.length ? options : [h('option', { value: '' }, 'No free bed in this unit')]));
  };
  let lastUnit = null;
  formDialog({
    title, testid, submitLabel, wide: true,
    fields: [
      { name: 'unit', label: 'Unit', type: 'select', options: units, value: first, wide: true },
      { name: 'bed', label: 'Bed', type: 'select', options: [], required: true, wide: true },
      withReason ? { name: 'reason', label: 'Reason', wide: true } : null,
    ],
    onChange: (values, byName) => { if (values.unit !== lastUnit) { lastUnit = values.unit; fill(byName, values.unit); } },
    onSubmit: async (values) => { if (!values.bed) throw new Error('Choose a bed'); await onPick(values.bed, values); },
  });
}

function assignFromWaiting(data, w) {
  const unitId = w.requestedUnit?.id || (w.currentBed ? null : data.units[0]?.id);
  chooseBedDialog({
    title: `${w.kind === 'transfer' ? 'Transfer' : 'Assign a bed for'} ${who(w)}`, data, unitId, encounter: w.id, withReason: w.kind === 'transfer', submitLabel: w.kind === 'transfer' ? 'Transfer' : 'Assign', testid: 'assign-dialog',
    onPick: (bed, v) => (w.kind === 'transfer' ? post('transfer', { encounter: w.id, bed, reason: v.reason || undefined }, 'Patient transferred') : post('assign', { encounter: w.id, bed }, 'Bed assigned')),
  });
}

function bedDialog(data, b) {
  const e = b.encounter;
  const reserved = b.state === 'reserved' && b.reservedFor ? data.waiting.find((w) => w.id === b.reservedFor) : null;
  const actions = [];
  const act = (label, testid, perm, onClick, kind = '') => actions.push({ label, testid, perm, kind, write: true, onClick });
  if (b.state === 'available' || b.state === 'reserved') {
    const candidates = reserved ? [reserved] : data.waiting.filter((w) => w.kind === 'admitted');
    if (candidates.length) act(reserved ? `Assign ${reserved.patient?.name || 'the reserved patient'}` : 'Assign from waiting list', 'bed-assign', ['Location', 'update'], (close) => {
      if (reserved) return post('assign', { encounter: reserved.id, bed: b.id }, 'Bed assigned').then(close);
      close();
      formDialog({ title: `Assign ${b.display}`, testid: 'assign-dialog', submitLabel: 'Assign', fields: [{ name: 'encounter', label: 'Patient waiting', type: 'select', options: candidates.map((w) => [w.id, `${who(w)} · waiting ${minutes(w.minutesWaiting)}`]), wide: true }], onSubmit: (v) => post('assign', { encounter: v.encounter, bed: b.id }, 'Bed assigned') });
      return undefined;
    }, 'primary');
  }
  if (b.state === 'available') {
    act('Reserve', 'bed-reserve', ['Location', 'update'], (close) => post('reserve', { bed: b.id }, 'Bed reserved').then(close));
    act('Block', 'bed-block', ['Location', 'transition'], async (close) => { const reason = await askReason({ title: `Block ${b.display}`, label: 'Reason (maintenance, isolation, closed)', submitLabel: 'Block', testid: 'block-reason' }); if (reason) { close(); await post('block', { bed: b.id, reason }, 'Bed blocked'); } }, 'danger');
  }
  if (b.state === 'reserved') act('Release reservation', 'bed-release', ['Location', 'update'], (close) => post('release', { bed: b.id }, 'Reservation released').then(close));
  if (b.state === 'occupied' && e) {
    act('Transfer', 'bed-transfer', ['Location', 'update'], (close) => { close(); chooseBedDialog({ title: `Transfer ${who(e)} from ${b.display}`, data, unitId: b.unit.id, encounter: e.id, withReason: true, submitLabel: 'Transfer', testid: 'transfer-dialog', onPick: (bed, v) => post('transfer', { encounter: e.id, bed, reason: v.reason || undefined }, 'Patient transferred') }); }, 'primary');
    act('Discharge', 'bed-discharge', ['Encounter', 'transition'], async (close) => { if (await confirmDialog({ title: 'Discharge', message: `Discharge ${who(e)} from ${b.display}? The visit is finished and the bed goes to cleaning.`, confirmLabel: 'Discharge', testid: 'discharge-confirm' })) { close(); await post('discharge', { encounter: e.id }, 'Patient discharged; bed to cleaning'); } }, 'danger');
  }
  if (b.state === 'cleaning') {
    act('Mark clean', 'bed-clean', ['Location', 'transition'], (close) => post('clean', { bed: b.id }, 'Bed is available').then(close), 'primary');
    act('Block', 'bed-block', ['Location', 'transition'], async (close) => { const reason = await askReason({ title: `Block ${b.display}`, label: 'Reason', submitLabel: 'Block', testid: 'block-reason' }); if (reason) { close(); await post('block', { bed: b.id, reason }, 'Bed blocked'); } }, 'danger');
  }
  if (b.state === 'blocked') act('Unblock', 'bed-unblock', ['Location', 'transition'], async (close) => { const reason = await askReason({ title: `Unblock ${b.display}`, label: 'Reason', submitLabel: 'Unblock', testid: 'unblock-reason' }); if (reason) { close(); await post('unblock', { bed: b.id, reason }, 'Bed unblocked'); } }, 'primary');
  openDialog({
    title: b.display, testid: 'bed-dialog', wide: true,
    body: kv([
      ['State', [badge(STATE_LABEL[b.state], { available: 'ok', occupied: 'accent', cleaning: 'warn', blocked: 'danger', reserved: '' }[b.state], 'bed-dialog-state'), ' ', h('span', { class: 'muted' }, `for ${minutes(b.minutesInState)}`)]],
      ['Reason', b.reason], ['Isolation bed', b.isolation ? 'Yes' : null],
      ['Patient', e ? h('span', { testid: 'bed-dialog-patient' }, who(e)) : null], ['Class', e ? CLASS[e.class] || e.class : null], ['Patient isolation', e?.isolation],
      ['In this bed since', e?.since ? fmtDateTime(e.since) : null], ['Expected discharge', e?.expectedDischarge],
      ['Reserved for', reserved ? who(reserved) : b.reservedFor ? b.reservedFor : null],
      ['Movements', e ? h('a', { href: `#/movements/${e.id}`, testid: 'bed-movements', 'aria-label': 'Movement history', onClick: (ev) => { ev.preventDefault(); closeDialogs(); go(`#/movements/${e.id}`); } }, 'Movement history') : null],
    ]),
    actions: [...actions, { label: 'Close', testid: 'bed-dialog-close-btn', onClick: (c) => c() }],
  });
}

// ---------- Dashboard ----------
async function dashboard() {
  const data = await api.get('/api/beds/dashboard');
  const strip = h('div', { class: 'bstrip', testid: 'turnaround-strip' },
    h('span', {}, 'Occupied ', h('b', { testid: 'hospital-occupancy' }, `${data.totals.occupied} of ${data.totals.capacity}`)),
    h('span', {}, 'Waiting ', h('b', { testid: 'waiting-count' }, data.waiting.length)),
    h('span', {}, 'Discharge to clean, today: ', h('b', { testid: 'turn-clean-today' }, turn(data.turnaround.today.dischargeToClean)), ' · 7 days: ', h('b', { testid: 'turn-clean-week' }, turn(data.turnaround.last7Days.dischargeToClean))),
    h('span', {}, 'Request to assignment, today: ', h('b', { testid: 'turn-assign-today' }, turn(data.turnaround.today.requestToAssign)), ' · 7 days: ', h('b', { testid: 'turn-assign-week' }, turn(data.turnaround.last7Days.requestToAssign))),
    h('span', { class: 'muted' }, `as of ${fmtDateTime(data.now)}`));
  const tile = (u, b) => h('button', {
    type: 'button', class: `bed state-${b.state}`, testid: `bed-${b.id}`,
    'aria-label': `${b.display}: ${STATE_LABEL[b.state]}${b.encounter ? `, ${b.encounter.patient?.name || 'patient'}` : ''}${b.isolation ? ', isolation bed' : ''}`,
    onClick: () => bedDialog(data, { ...b, unit: u }),
  }, h('b', {}, b.name), h('span', { class: 'state', testid: `bed-state-${b.id}` }, STATE_LABEL[b.state]),
  b.encounter ? h('div', { class: 'who', testid: `bed-patient-${b.id}` }, who(b.encounter)) : null,
  b.encounter?.isolation ? h('div', { class: 'iso' }, `Isolation: ${b.encounter.isolation}`) : b.isolation ? h('div', { class: 'iso' }, 'Isolation bed') : null,
  b.state === 'blocked' && b.reason ? h('div', { class: 'who muted' }, b.reason) : null,
  h('div', { class: 'time' }, minutes(b.minutesInState)));
  const units = h('div', { class: 'units', testid: 'units' }, data.units.map((u) => h('section', { class: 'card unit', testid: `unit-${u.id}` },
    h('h3', {}, u.name, h('span', { class: 'occ', testid: `unit-occupancy-${u.id}` }, `${u.occupied} of ${u.capacity}`)),
    h('div', { class: 'constraints' }, u.constraints.sexOfBay ? badge('Sex of bay', 'info') : null, u.constraints.isolation ? badge('Isolation rooms', 'info') : null, u.cleaning ? badge(`${u.cleaning} cleaning`, 'warn') : null, u.blocked ? badge(`${u.blocked} blocked`, 'danger') : null, u.reserved ? badge(`${u.reserved} reserved`) : null),
    u.rooms.map((r) => [h('div', { class: 'room' }, r.name, r.isolation ? ' · isolation' : ''), h('div', { class: 'beds' }, r.beds.map((b) => tile(u, b)))]))));
  const waiting = card('Waiting for a bed', table({ testid: 'waiting-table', rows: data.waiting, empty: 'Nobody is waiting for a bed', columns: [
    { label: 'Patient', render: (w) => [h('div', {}, w.patient?.name || 'Unknown'), h('div', { class: 'muted small mono' }, w.patient?.mrn || '')] },
    { label: 'Class', render: (w) => [badge(CLASS[w.class] || w.class, 'info'), w.kind === 'transfer' ? [' ', badge('Transfer', 'warn')] : null, w.isolation ? [' ', badge('Isolation', 'danger')] : null] },
    { label: 'Unit', render: (w) => w.requestedUnit?.name || h('span', { class: 'muted' }, 'any') },
    { label: 'Waiting', cls: 'num', render: (w) => h('span', { testid: `waiting-time-${w.id}` }, minutes(w.minutesWaiting)) },
    { label: '', cls: 'actions', render: (w) => btn(w.kind === 'transfer' ? 'Transfer' : 'Assign', { small: true, kind: 'primary', write: true, perm: ['Location', 'update'], testid: `waiting-assign-${w.id}`, onClick: () => assignFromWaiting(data, w) }) },
  ] }));
  const expected = card('Expected discharges today', table({ testid: 'expected-table', rows: data.expectedDischarges, empty: 'No discharges expected today', columns: [
    { label: 'Patient', render: (x) => x.patient?.name || 'Unknown' }, { label: 'Bed', render: (x) => x.bed?.display || h('span', { class: 'muted' }, 'No bed') }, { label: 'Expected', render: (x) => x.expected },
    { label: '', cls: 'actions', render: (x) => btn('Discharge', { small: true, write: true, perm: ['Encounter', 'transition'], testid: `expected-discharge-${x.id}`, onClick: async () => { if (await confirmDialog({ title: 'Discharge', message: `Discharge ${who(x)}?`, confirmLabel: 'Discharge', testid: 'discharge-confirm' })) await post('discharge', { encounter: x.id }, 'Patient discharged'); } }) },
  ] }));
  const legend = h('div', { class: 'legend', 'aria-label': 'Legend' }, STATES.map((s) => h('span', { class: s }, STATE_LABEL[s])));
  return [strip, page(data.site ? `${data.site.name} bed board` : 'Bed board', btn('Refresh', { testid: 'refresh', onClick: render }), legend,
    h('div', { class: 'board' }, units, h('div', { class: 'stack' }, waiting, expected)))];
}

// ---------- Movements ----------
async function movements(id) {
  const m = await api.get(`/api/beds/movements/${id}`);
  const name = m.patient ? `${m.patient.name?.[0]?.family || ''}` : 'Unknown patient';
  return page(`Movements: ${name}`, btn('◂ Back to the board', { testid: 'back-to-board', onClick: () => go('#/dashboard') }),
    kv([['Encounter', `${CLASS[m.encounter.class?.code] || m.encounter.class?.code || ''} · ${m.encounter.status}`], ['Admitted', fmtDateTime(m.encounter.period?.start)], ['Discharged', fmtDateTime(m.encounter.period?.end)], ['Current bed', m.current || 'No bed']]),
    table({ testid: 'movements-table', rows: m.movements, rowId: (r) => r.index, empty: 'This patient has not been in a bed', columns: [
      { label: '#', cls: 'num', render: (r) => r.index + 1 }, { label: 'Bed', render: (r) => r.display }, { label: 'Unit', render: (r) => r.unit || '' },
      { label: 'From', render: (r) => fmtDateTime(r.start) }, { label: 'To', render: (r) => (r.end ? fmtDateTime(r.end) : h('span', { class: 'muted' }, 'still here')) },
      { label: 'Stay', cls: 'num', render: (r) => minutes(r.minutes) }, { label: 'Status', render: (r) => badge(r.status, r.status === 'active' ? 'accent' : '') },
    ] }));
}

// ---------- Router ----------
let renderToken = 0;
export async function render() {
  const token = renderToken += 1;
  const [path] = (location.hash.slice(2) || 'dashboard').split('?');
  const [route, id] = path.split('/');
  try {
    const content = route === 'movements' && id ? await movements(id) : await dashboard();
    if (token === renderToken) renderShell(route === 'movements' ? 'movements' : 'dashboard', content);
  } catch (err) {
    if (token !== renderToken) return;
    showError(err);
    renderShell(route, page('Could not load the bed board', btn('Retry', { testid: 'retry', onClick: render }), h('div', { class: 'banner danger', testid: 'load-error' }, err.message)));
  }
}
window.addEventListener('hashchange', render);
window.addEventListener('hd:role', render);
view.onChange(render);
render();
