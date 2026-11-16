// What an agent may do, shown wherever results are shown so results
// under different permissions are never mixed: badges for a grant, the approval list in Settings, the
// write behaviour report on a run, the same agent at several permission levels side by side, and the
// library of tasks and safety tests for administrative and writing agents.
import { h, btn, badge, toast, table, openDialog, fmtDateTime, showError } from '/shared/ui.js';
import { api } from '/shared/fhir.js';
import { deleteUnit } from '/agent-ops/home.js';

export const SYSTEMS = [['ehr', 'EHR'], ['pacs', 'PACS'], ['lab', 'Lab'], ['pharmacy', 'Pharmacy'], ['payer', 'Payer'], ['business-office', 'Business office'], ['scheduling', 'Scheduling']];
export const LEVELS = [['none', 'No access'], ['read-only', 'Read only'], ['read-propose', 'Read and propose'], ['read-write', 'Read and write']];
export const levelName = (l) => (LEVELS.find(([id]) => id === l) || [null, 'Not set'])[1];
const kindOf = (l) => (l === 'read-write' ? 'warn' : l === 'read-propose' ? 'info' : '');
const PATIENTS = { scenario: 'the patient of its scenario', study: 'a study\'s patients', 'all-synthetic': 'all synthetic patients', all: 'any patient' };

/** One badge per system the agent can reach. */
export function permBadges(perms, testid) {
  if (!perms?.systems) return h('span', { class: 'muted small', testid }, 'Built-in: read and propose everywhere');
  const open = SYSTEMS.filter(([id]) => perms.systems[id] && perms.systems[id] !== 'none');
  return h('span', { testid }, open.length ? open.map(([id, label]) => badge(`${label}: ${levelName(perms.systems[id]).toLowerCase()}`, kindOf(perms.systems[id]))) : badge('No access', ''), perms.mustCite ? badge('Must cite records', 'info') : null);
}
export const approvalBadge = (a) => (!a.approval ? badge('Built-in, pre-approved', 'ok', `agent-approval-${a.id}`) : a.approval.status === 'approved' ? badge(a.approval.how === 'narrowed' ? 'Approved, narrowed' : 'Approved', 'ok', `agent-approval-${a.id}`) : a.approval.status === 'refused' ? badge('Refused', 'danger', `agent-approval-${a.id}`) : badge('Waiting for approval', 'warn', `agent-approval-${a.id}`));
/** The line shown on a run, in the trace viewer and in results. */
export function runPermissions(run, testid = 'run-permissions') {
  if (!run?.agentId) return null;
  return h('span', { testid }, badge(levelName(run.permissionLevel || 'read-propose'), kindOf(run.permissionLevel)), ' ', permBadges(run.permissions), run.permissions?.patients ? h('span', { class: 'muted small' }, ` · ${PATIENTS[run.permissions.patients] || run.permissions.patients}`) : null);
}

function levelPicker(asked, granted, prefix) {
  const order = LEVELS.map(([id]) => id); const picks = {};
  const rows = SYSTEMS.filter(([id]) => (asked.systems?.[id] || 'none') !== 'none').map(([id, label]) => {
    const top = order.indexOf(asked.systems[id]);
    const sel = h('select', { testid: `${prefix}-${id}`, 'aria-label': `${label}: permission to grant`, style: 'width:auto' }, ...LEVELS.filter(([l]) => order.indexOf(l) <= top).map(([l, name]) => h('option', { value: l, selected: l === (granted?.systems?.[id] ?? asked.systems[id]) }, name)));
    picks[id] = sel;
    return h('tr', {}, h('td', {}, label), h('td', {}, levelName(asked.systems[id])), h('td', {}, sel));
  });
  return { el: h('table', { class: 'plain' }, h('thead', {}, h('tr', {}, h('th', {}, 'System'), h('th', {}, 'Asked for'), h('th', {}, 'Grant'))), h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: 3, class: 'muted' }, 'Asked for nothing')))), value: () => ({ systems: Object.fromEntries(Object.entries(picks).map(([id, sel]) => [id, sel.value])) }) };
}

/** Settings: approve, narrow or refuse what an agent asked for; switch its connectors on; the key is shown once. */
export async function approvalsCard(render) {
  const { agents } = await api.get('/agent-ops/agents');
  const outside = agents.filter((a) => a.approval);
  const review = (a) => {
    const asked = a.requested || { systems: {} }; const picker = levelPicker(asked, a.granted, `approve-${a.id}`);
    const conn = h('input', { type: 'checkbox', checked: Boolean(a.connectors?.enabled), testid: `approve-${a.id}-connectors`, 'aria-label': 'Switch on connectors (MCP, FHIR and CDS Hooks) for this agent', style: 'width:auto;height:auto' });
    const send = async (body, close) => {
      try {
        const out = await api.post(`/agent-ops/agents/${a.id}/approve`, body); close();
        if (out.connectorKey) openDialog({ title: 'Connector key', testid: 'connector-key', body: h('div', {}, h('p', {}, 'This key lets the agent connect with the permissions you granted. It is shown once: copy it now.'), h('pre', { class: 'mono', testid: 'connector-key-value', style: 'white-space:pre-wrap;word-break:break-all' }, out.connectorKey), h('p', { class: 'muted small' }, 'Only a hash of it is kept here.')), actions: [{ label: 'Done', kind: 'primary', testid: 'connector-key-done', onClick: (c) => { c(); render(); } }] });
        else { toast(body.refuse ? `${a.name} refused` : `${a.name} approved`); render(); }
      } catch (err) { showError(err); }
    };
    openDialog({ title: `Permissions for ${a.name}`, testid: 'approve-dialog', wide: true, body: h('div', {},
      h('p', { class: 'muted' }, [a.organisation, a.modelName ? `model ${a.modelName}` : null, `version ${a.version}`, a.submittedThrough ? `submitted through the ${a.submittedThrough}` : null].filter(Boolean).join(' · ')),
      picker.el,
      h('p', { class: 'muted small' }, `Patients: ${PATIENTS[asked.patients] || 'all synthetic patients'}. ${asked.recordTypes ? `May write only: ${asked.recordTypes.join(', ')}. ` : ''}Up to ${asked.rateLimit ?? 600} requests a minute. ${asked.mustCite ? 'Must cite a record for every claim.' : 'Does not have to cite records.'}`),
      h('p', { class: 'muted small' }, 'Read and write is only ever on the run\'s own branch; the safety checks still look at every write. Changing a grant makes a new agent version.'),
      h('label', { class: 'toolbar' }, conn, ' Connectors on: the agent may connect from outside with its own key')),
      actions: [{ label: 'Refuse', kind: 'danger', testid: 'approve-refuse', onClick: (c) => send({ refuse: true, reason: 'Refused in Settings' }, c) }, { label: a.approval.status === 'approved' ? 'Save' : 'Approve', kind: 'primary', testid: 'approve-save', onClick: (c) => send({ granted: { ...asked, ...picker.value() }, connectors: conn.checked }, c) }] });
  };
  return h('div', { class: 'card', testid: 'approvals-card' }, h('h3', {}, 'Agent permissions'),
    h('p', { class: 'muted small' }, 'An agent added from outside asks for permissions. It cannot run until you approve or narrow them here. Built-in agents are pre-approved at read and propose.'),
    table({ testid: 'approvals-table', rows: outside, empty: 'No outside agents yet. Add one in Library, Agents, or let an outside party submit one through the connector API.', columns: [
      { label: 'Agent', render: (a) => [h('strong', {}, a.name), h('div', { class: 'muted small' }, [a.organisation, `v${a.version}`].filter(Boolean).join(' · '))] },
      { label: 'Status', render: (a) => approvalBadge(a) },
      { label: 'Granted', render: (a) => (a.granted ? permBadges(a.granted, `granted-${a.id}`) : h('span', { class: 'muted small' }, 'Nothing yet')) },
      { label: 'Connectors', render: (a) => badge(a.connectors?.enabled ? 'On' : 'Off', a.connectors?.enabled ? 'ok' : '', `connectors-${a.id}`) },
      { label: '', render: (a) => btn(a.approval.status === 'pending' ? 'Review' : 'Change', { small: true, kind: a.approval.status === 'pending' ? 'primary' : '', testid: `approve-open-${a.id}`, onClick: () => review(a) }) },
    ] }));
}

const count = (label, n, testid, bad = false) => h('div', { class: 'stat', testid }, h('div', { class: 'stat-n', style: bad && n ? 'color:var(--danger)' : '' }, String(n)), h('div', { class: 'muted small' }, label));
/** Write behaviour on one run: what was tried, allowed and refused, and what changed. */
export async function writeReportCard(runId) {
  let r; try { r = await api.get('/agent-ops/write-report', { run: runId }); } catch { return null; }
  if (!r.agentId) return null;
  return h('div', { class: 'card', style: 'margin-bottom:1rem', testid: 'write-report' }, h('h3', {}, 'Write behaviour'),
    h('div', { class: 'toolbar', style: 'gap:1.375rem;flex-wrap:wrap' }, count('Writes tried', r.attempted, 'wr-attempted'), count('Allowed', r.allowed, 'wr-allowed'), count('Refused by permissions', r.refusedByPermissions, 'wr-permissions'), count('Refused by safety checks', r.refusedByEnvelope, 'wr-envelope'), count('Wrong patient', r.wrongPatient, 'wr-wrong-patient', true), count('Against the chart', r.contradictingChart, 'wr-contradict', true), count('Cancel, stop, deny or delete', r.destructiveAttempts, 'wr-destructive', true), count('Later marked wrong', r.reversedOrMarkedWrong, 'wr-reversed', true)),
    r.diff.length || r.payerDiff.length ? h('details', { testid: 'wr-diff' }, h('summary', { testid: 'wr-diff-open', 'aria-label': 'Before and after: the records this run changed' }, `Before and after: ${r.diff.length + r.payerDiff.length} record${r.diff.length + r.payerDiff.length === 1 ? '' : 's'} changed on the run's own branch`),
      table({ testid: 'wr-diff-table', rows: [...r.diff.map((d) => ({ id: d.ref, what: d.what || d.ref, system: d.system, before: d.statusBefore || 'did not exist', after: d.statusAfter || '' })), ...r.payerDiff.map((d, i) => ({ id: `p${i}`, what: d.action.replace(/^(payer|business)\./, '').replace(/[.-]/g, ' '), system: d.action.split('.')[0], before: '', after: [d.decision, d.how].filter(Boolean).join(', ') }))], columns: [{ label: 'Record', render: (d) => d.what }, { label: 'System', render: (d) => d.system }, { label: 'Before', render: (d) => d.before }, { label: 'After', render: (d) => d.after }] })) : h('p', { class: 'muted small', style: 'margin:0.5rem 0 0' }, 'This run changed no records.'));
}

/** Library: tasks and safety tests for administrative and writing agents, with the grades so far. */
export async function adminTasksCard(render) {
  const [lib, { agents }, runs] = await Promise.all([api.get('/api/ins/scenarios'), api.get('/agent-ops/agents'), api.get('/api/ins/scenarios/runs')]);
  const agentSel = h('select', { testid: 'ins-scenario-agent', 'aria-label': 'Participant', style: 'width:auto' }, h('option', { value: '' }, 'A person (me)'), ...agents.filter((a) => a.enabled !== false).map((a) => h('option', { value: a.id }, `${a.name} v${a.version}`)));
  const startBtn = (sc, n) => btn(`Case ${n + 1}`, { small: true, testid: `ins-scenario-start-${sc.id}-${n}`, title: `Start ${sc.title}, case ${n + 1}`, onClick: async () => { const out = await api.post(`/api/ins/scenarios/${sc.id}/start`, { case: n, ...(agentSel.value ? { agentId: agentSel.value } : {}) }); openDialog({ title: 'Scenario started', testid: 'ins-scenario-started', body: [h('p', {}, out.task), h('p', { class: 'muted' }, `Run ${out.runId}, on its own branch. ${out.side === 'insurer' ? 'The participant works on the insurer side.' : 'The participant works on the hospital side.'} Grade it here when the work is done.`)], actions: [{ label: 'Close', testid: 'ins-scenario-started-close', onClick: (c) => { c(); render(); } }] }); } });
  return h('section', { class: 'dash-sec', testid: 'admin-tasks' }, h('h2', {}, 'Insurance scenarios'),
    h('p', { class: 'muted' }, 'Each case is made on its own branch when you start it: a patient by number, signed notes, a plan and its policy. The reference answers are drafts until a clinician, coder or reviewer confirms them.'),
    h('div', { class: 'toolbar' }, h('label', {}, 'Participant ', agentSel)),
    table({ testid: 'ins-scenarios', rows: lib, columns: [{ label: 'Scenario', render: (sc) => sc.title }, { label: 'Side', render: (sc) => (sc.side === 'insurer' ? 'Insurer' : 'Hospital') }, { label: 'Task', render: (sc) => sc.task }, { label: 'Start', cls: 'actions', render: (sc) => Array.from({ length: sc.cases }, (_, n) => startBtn(sc, n)) }] }),
    h('h3', {}, 'Runs'),
    table({ testid: 'ins-scenario-runs', rows: runs, empty: 'No scenario has been started', columns: [{ label: 'Started', render: (r) => fmtDateTime(r.startedAt) }, { label: 'Scenario', render: (r) => `${r.title}, case ${r.case + 1}` }, { label: 'Participant', render: (r) => (r.participant.kind === 'agent' ? `${r.participant.id} v${r.participant.version}` : 'A person') },
      { label: 'Result', render: (r) => (r.grade ? [badge(r.grade.passed ? 'Passed' : 'Not passed', r.grade.passed ? 'ok' : 'danger', `ins-scenario-result-${r.id}`), ` ${Math.round(r.grade.score * 100)}%`, r.grade.unsafe ? badge('Unsafe', 'danger') : null, r.grade.detail?.note ? h('div', { class: 'muted small' }, r.grade.detail.note) : null] : '') },
      { label: 'Reference answer', render: (r) => (r.referenceConfirmed ? badge('Confirmed', 'ok') : btn('Confirm', { small: true, testid: `ins-scenario-confirm-${r.id}`, title: 'Confirm the reference answer', onClick: () => openDialog({ title: 'Reference answer', testid: 'ins-scenario-reference', body: [h('pre', { style: 'white-space:pre-wrap' }, JSON.stringify(r.reference, null, 2)), h('p', { class: 'muted' }, 'Confirm only if you are the clinician, certified coder or reviewer responsible for it.')], actions: [{ label: 'Cancel', testid: 'ins-scenario-reference-cancel', onClick: (c) => c() }, { label: 'Confirm', kind: 'primary', testid: 'ins-scenario-reference-ok', onClick: async (c) => { try { await api.post(`/api/ins/scenarios/runs/${r.id}/reference`, {}); c(); render(); } catch (err) { showError(err); } } }] }) })) },
      { label: '', cls: 'actions', render: (r) => [btn(r.grade ? 'Grade again' : 'Grade', { small: true, testid: `ins-scenario-grade-${r.id}`, onClick: async () => { const g = await api.post(`/api/ins/scenarios/runs/${r.id}/grade`, {}); toast(g.grade.passed ? 'Passed' : 'Not passed'); render(); } }), btn('Delete run', { small: true, kind: 'danger', testid: `ins-scenario-delete-${r.id}`, onClick: () => deleteUnit('run', r.id, render) })] }] }));
}
export function gradesTable(grades) {
  return table({ testid: 'admin-grades', rows: grades, empty: 'Nothing graded yet', columns: [
    { label: 'When', render: (g) => fmtDateTime(g.at) }, { label: 'Task or test', render: (g) => g.title || g.task }, { label: 'Agent', render: (g) => `${g.agentId} v${g.version}` },
    { label: 'Permission level', render: (g) => badge(levelName(g.permissionLevel), kindOf(g.permissionLevel)) },
    { label: 'Result', render: (g) => badge(g.passed ? 'Passed' : 'Failed', g.passed ? 'ok' : 'danger', `admin-grade-result-${g.id}`) },
    { label: 'Detail', render: (g) => (g.kind === 'task' ? `Chart checks ${Math.round(g.checkScore * 100)}%, rubric ${Math.round(g.rubricScore * 100)}%${g.unsafe ? ', unsafe' : ''}` : g.finding) },
    { label: 'Citations', render: (g) => (g.citations ? `${g.citations.valid} of ${g.citations.claims} hold` : '') },
    { label: '', render: (g) => h('a', { href: `#/runs/${g.run}`, testid: `admin-grade-run-${g.id}`, 'aria-label': 'Open the run' }, 'Run') },
  ] });
}
/** Results by permission level for a study: never one mixed number. */
export async function levelsCard(study) {
  let r; try { r = await api.get('/agent-ops/write-report', { study: study.id }); } catch { return null; }
  if (!r.byLevel.length) return null;
  return h('section', { class: 'dash-sec', testid: 'levels-card' }, h('h2', {}, 'By permission level'), h('p', { class: 'muted small' }, 'The same agent under different permissions is a different thing to measure: each row is kept apart.'),
    table({ testid: 'levels-table', rows: r.byLevel, rowId: (x) => `${x.agentId}-${x.permissionLevel}`, columns: [{ label: 'Agent', render: (x) => x.agentId }, { label: 'Permission level', render: (x) => badge(levelName(x.permissionLevel), kindOf(x.permissionLevel)) }, { label: 'Runs', render: (x) => x.runs }, { label: 'Writes tried', render: (x) => x.attempted }, { label: 'Allowed', render: (x) => x.allowed }, { label: 'Refused by permissions', render: (x) => x.refusedByPermissions }, { label: 'Refused by safety checks', render: (x) => x.refusedByEnvelope }, { label: 'Wrong patient', render: (x) => x.wrongPatient }, { label: 'Cancel, stop, deny or delete', render: (x) => x.destructiveAttempts }] }));
}
