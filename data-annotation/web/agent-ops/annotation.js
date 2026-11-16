// Agent Dashboard → Data Annotation: recordings of clinicians at work, labelling
// projects, the one-item-at-a-time workbench, agreement and adjudication.
import { h, clear, btn, badge, toast, table, card, kv, formDialog, confirmDialog, fmtDateTime, showError, stopRecording } from '/shared/ui.js';
import { api, identity } from '/shared/fhir.js';
import { capture } from '/shared/capture.js';
import { parse, pixels, autoWindow, toRGBA } from '/shared/dicom.js';

const page = (title, actions, ...content) => h('div', {}, h('div', { class: 'page-head' }, h('h1', {}, title), actions), ...content);
const tile = (label, value, testid) => h('div', { class: 'card' }, h('span', { class: 'muted small' }, label), h('b', { testid }, value));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : /(x|s|ch)$/.test(word) ? 'es' : 's'}`;
const duration = (s) => (s == null ? '—' : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`);
const me = () => identity.user || identity.role;
const KIND_LABEL = { 'think-aloud': 'Think-aloud note', why: '"Why?" answer', dictation: 'Dictation' };

// ---------- Recordings ----------
export function startRecordingDialog(policy, onStarted) {
  const content = policy.contentCapture;
  formDialog({
    title: 'Record a clinician working', testid: 'record-start', submitLabel: 'Start recording', wide: true,
    intro: 'Every click, screen change, image-viewer action and chart action by this browser is logged under the recording until you stop it. Field values and keystrokes are never recorded. A "Recording" marker stays on screen in every app.',
    fields: [
      { name: 'title', label: 'What is being recorded (optional)', type: 'text', wide: true, placeholder: 'For example: reading the morning chest films' },
      { name: 'friction', label: 'Advisory pop-ups during the session', type: 'select', options: [['realistic', 'Realistic (default for people)'], ['low', 'Low: none'], ['high', 'High: frequent']], value: 'realistic' },
      { name: 'acknowledged', label: 'The person being recorded has agreed to this recording', type: 'checkbox', wide: true },
      content ? { name: 'thinkAloud', label: 'Also keep think-aloud notes they choose to type', type: 'checkbox', wide: true } : null,
      content ? { name: 'why', label: 'Also ask one optional "why?" when they sign or order', type: 'checkbox', wide: true } : null,
      { name: 'practice', label: 'Work on a practice copy of the chart (nothing reaches the live chart)', type: 'checkbox', wide: true },
      content ? { name: 'dictation', label: 'Also keep dictation transcripts (practice copy only, report and note fields only)', type: 'checkbox', wide: true } : null,
    ],
    onChange: (v, controls, extra) => {
      if (controls.dictation) { controls.dictation.input.disabled = !v.practice; if (!v.practice) controls.dictation.set(false); }
      clear(extra).append(h('p', { class: 'muted small', testid: 'record-start-note' }, content
        ? `Written content is masked for names, record numbers and dates, stored encrypted, and deleted after ${policy.retentionDays} days. It can be deleted sooner from the recording's page.`
        : 'Written content (think-aloud, "why?" answers, dictation) is switched off, so only structured events are recorded. It can be allowed on the Recordings page.'));
    },
    onSubmit: async (v) => {
      if (!v.acknowledged) throw new Error('Tick the box to confirm the person being recorded has agreed');
      const run = await api.post('/agent-ops/capture/start', { title: v.title, acknowledged: true, friction: v.friction, practice: v.practice, consent: { thinkAloud: v.thinkAloud, why: v.why, dictation: v.dictation } });
      capture.set(run);
      toast('Recording started. Open the EHR or PACS and work as usual.');
      onStarted?.(run);
    },
  });
}

export async function recordingsPage(go, render) {
  const { policy, recordings } = await api.get('/agent-ops/capture');
  const live = capture.active;
  const policyCard = card('Written content in recordings',
    h('p', { class: 'muted', style: 'margin:0 0 0.625rem;max-width:51.25rem' }, 'Recordings always log structured events: which control was used, which record was opened, viewer actions and timings. Free text (think-aloud notes, "why?" answers, dictation transcripts) is only kept when this is switched on and the person being recorded ticks it. It is masked, encrypted and deleted after the retention period.'),
    h('div', { class: 'toolbar', style: 'margin:0;align-items:center' },
      h('label', { style: 'display:flex;gap:0.5rem;align-items:center' }, h('input', { type: 'checkbox', style: 'width:auto;height:auto', checked: policy.contentCapture, testid: 'policy-content', 'aria-label': 'Allow written content in recordings', onChange: async (e) => {
        try { await api.put('/agent-ops/capture/policy', { contentCapture: e.target.checked }); toast(e.target.checked ? 'Written content may now be kept, with consent' : 'Written content is no longer kept'); } catch (err) { showError(err); }
        render();
      } }), 'Allow written content, with consent'),
      h('label', { style: 'display:flex;gap:0.5rem;align-items:center' }, 'Delete after', h('input', { type: 'number', min: 1, max: 365, value: policy.retentionDays, style: 'width:5rem', testid: 'policy-retention', 'aria-label': 'Days to keep written content', onChange: async (e) => {
        try { await api.put('/agent-ops/capture/policy', { retentionDays: Number(e.target.value) }); undefined; } catch (err) { showError(err); }
        render();
      } }), 'days'),
      btn('Delete expired content now', { small: true, testid: 'policy-purge', onClick: async () => { const out = await api.post('/agent-ops/capture/purge', {}); toast(`${plural(out.deleted, 'item')} deleted`); render(); } })));
  const actions = live
    ? btn('Stop recording', { kind: 'primary', testid: 'recordings-stop', onClick: async () => { await stopRecording(); render(); } })
    : btn('Start a recording', { kind: 'primary', testid: 'recordings-start', onClick: () => startRecordingDialog(policy, () => render()) });
  const list = recordings.length ? table({ testid: 'recordings-table', rows: recordings, rowId: (r) => r.id, onRow: (r) => go(`#/recordings/${r.id}`), columns: [
    { label: 'Started', render: (r) => fmtDateTime(r.startedAt) }, { label: 'What', render: (r) => r.goal }, { label: 'Who', render: (r) => r.context?.recorder || '' },
    { label: 'Where', render: (r) => (r.context?.practiceBranch ? 'Practice copy' : 'Live chart') },
    { label: 'Status', render: (r) => (r.endedAt ? badge('Finished', 'ok') : badge('Recording', 'danger')) },
    { label: 'Written content', render: (r) => (r.contentItems ? plural(r.contentItems, 'item') : 'None stored') },
  ] }) : h('div', { class: 'card empty', testid: 'recordings-empty' }, 'No recordings yet. Start one, then work in the EHR or PACS as usual.');
  return page('Recordings', actions,
    live ? h('div', { class: 'banner info', testid: 'recordings-live' }, h('strong', {}, 'A recording is running in this browser. '), 'Open the ', h('a', { href: '/ehr/', target: '_blank', testid: 'recordings-open-ehr' }, 'EHR'), ' or ', h('a', { href: '/pacs/', target: '_blank', testid: 'recordings-open-pacs' }, 'PACS'), ' and work as usual. Stop it here or from the marker at the bottom left.') : null,
    policyCard, h('div', { style: 'height:1rem' }), list);
}

export async function recordingPage(id, go, render) {
  let withText = recordingPage.shown === id;
  const d = await api.get(`/agent-ops/capture/${id}`, withText ? { content: 'true' } : {});
  const { run, summary: s } = d;
  const consent = run.context?.consent || {};
  const kept = [consent.thinkAloud ? 'think-aloud notes' : null, consent.why ? '"why?" answers' : null, consent.dictation ? 'dictation' : null].filter(Boolean);
  const head = card('This recording', kv([
    ['What', run.goal], ['Who', run.context?.recorder || ''], ['Started', fmtDateTime(run.startedAt)], ['Finished', run.endedAt ? fmtDateTime(run.endedAt) : 'Still recording'],
    ['Where', run.context?.practiceBranch ? `Practice copy (${run.context.practiceBranch})` : 'Live chart'], ['Agreed to', `Structured events${kept.length ? `, ${kept.join(', ')}` : ' only'}`],
  ]));
  const tiles = h('div', { class: 'tiles6' }, tile('Length', duration(s.seconds), 'rec-length'), tile('Screen events', s.uiEvents, 'rec-ui'), tile('Chart actions', s.apiActions, 'rec-api'),
    tile('Signed', s.signed, 'rec-signed'), tile('Measurements', s.measurements, 'rec-measurements'), tile('Written notes', Object.values(s.content).reduce((a, b) => a + b, 0), 'rec-content'));
  const written = Object.entries(s.recordsWritten);
  const studies = s.studies.length ? table({ testid: 'rec-studies', rows: s.studies, columns: [
    { label: 'Study', render: (x) => h('span', { class: 'mono' }, x.ref) }, { label: 'Opened', render: (x) => `${x.opens}×` }, { label: 'Time on screen', render: (x) => duration(x.seconds) },
    { label: 'Images dwelt on', render: (x) => (x.frames ? `${x.frames} (${x.frameSeconds} s)` : '—') },
  ] }) : h('p', { class: 'muted', testid: 'rec-no-studies' }, 'No imaging study was opened.');
  const contentRows = d.content.length ? table({ testid: 'rec-content-table', rows: d.content, rowId: (c) => c.id, columns: [
    { label: 'When', render: (c) => fmtDateTime(c.at) }, { label: 'Kind', render: (c) => KIND_LABEL[c.kind] }, { label: 'About', render: (c) => c.about || c.field || '' },
    { label: 'Text', render: (c) => (c.text != null ? h('span', { testid: `rec-text-${c.id}`, style: 'white-space:pre-wrap' }, c.text) : h('span', { class: 'muted' }, `${c.length} characters, ${plural(c.redactions, 'part')} masked`)) },
    { label: 'Deleted on', render: (c) => fmtDateTime(c.expiresAt) },
    { label: '', render: (c) => btn('Delete', { small: true, testid: `rec-delete-${c.id}`, onClick: async () => { await api.del(`/agent-ops/capture/${id}/content/${c.id}`); toast('Deleted'); render(); } }) },
  ] }) : h('p', { class: 'muted', testid: 'rec-no-content' }, d.contentDeleted ? `${plural(d.contentDeleted, 'item')} of written content ${d.contentDeleted === 1 ? 'was' : 'were'} deleted. Nothing is stored now.` : 'No written content is stored for this recording.');
  const contentCard = card('Written content', contentRows, d.content.length ? h('div', { class: 'toolbar', style: 'margin:0.75rem 0 0' },
    btn(withText ? 'Hide text' : 'Show text', { small: true, testid: 'rec-show-text', onClick: () => { recordingPage.shown = withText ? null : id; render(); } }),
    btn('Delete all written content', { small: true, testid: 'rec-delete-all', onClick: async () => {
      if (!(await confirmDialog({ title: 'Delete all written content?', message: 'The text is removed for good. The log keeps a record that it existed and that it was deleted.', confirmLabel: 'Delete', testid: 'rec-delete-confirm' }))) return;
      const out = await api.del(`/agent-ops/capture/${id}/content`); toast(`${plural(out.deleted, 'item')} deleted`); render();
    } }),
    h('span', { class: 'muted small' }, 'Showing the text is logged.')) : null);
  const canCase = run.endedAt && !run.context?.practiceBranch && d.goldActions.length;
  const caseCard = card('Turn this recording into a case',
    d.cases.length ? h('p', { testid: 'rec-cases' }, 'Cases made from this recording: ', d.cases.map((c) => h('span', {}, badge(c.split, c.split === 'eval' ? 'warn' : 'accent'), ` ${c.title} `))) : null,
    d.goldActions.length
      ? h('div', {}, h('p', { class: 'muted', style: 'margin:0 0 0.375rem' }, 'The coded orders, prescriptions and diagnoses the clinician made become the correct actions. The case starts from the chart as it was when the recording began.'),
        h('ul', { testid: 'rec-gold', style: 'margin:0 0 0.625rem;padding-left:1.25rem' }, d.goldActions.map((g) => h('li', {}, `${g.type}: ${g.label} `, h('span', { class: 'mono muted' }, g.code)))))
      : h('p', { class: 'muted', testid: 'rec-no-gold' }, 'The clinician made no coded order, prescription or diagnosis in this recording, so there is nothing to use as the correct actions.'),
    btn('Make a case', { testid: 'rec-make-case', disabled: !canCase, title: canCase ? '' : run.endedAt ? 'Needs coded actions on the live chart' : 'Stop the recording first', onClick: () => formDialog({
      title: 'Make a case from this recording', testid: 'rec-case', submitLabel: 'Add to the case bank', wide: true,
      fields: [
        { name: 'title', label: 'Title', type: 'text', required: true, wide: true }, { name: 'scenario', label: 'Scenario, in plain English', type: 'textarea', rows: 3, required: true, wide: true },
        { name: 'task', label: 'Task given to the agent', type: 'textarea', rows: 2, required: true, wide: true, value: 'Review this patient and decide on the next diagnostic and treatment steps.' },
        { name: 'split', label: 'Use for', type: 'select', options: [['train', 'Training'], ['eval', 'Evaluation only (never exported for training)']], value: 'train' },
      ],
      onSubmit: async (v) => { await api.post(`/agent-ops/capture/${id}/case`, v); toast('Case added to the case bank'); render(); },
    }) }));
  return page('Recording', h('div', { class: 'toolbar', style: 'margin:0' },
    !run.endedAt && capture.runId === id ? btn('Stop recording', { kind: 'primary', testid: 'rec-stop', onClick: async () => { await stopRecording(); render(); } }) : null,
    btn('Every step', { testid: 'rec-trace', onClick: () => go(`#/runs/${id}`) }), btn('All recordings', { testid: 'rec-back', onClick: () => go('#/recordings') })),
  head, tiles,
  card('What was written to the chart', written.length ? h('p', { testid: 'rec-written', style: 'margin:0' }, written.map(([type, n]) => `${n} × ${type}`).join(' · ')) : h('p', { class: 'muted', style: 'margin:0', testid: 'rec-written' }, 'Nothing was written.')),
  h('div', { style: 'height:1rem' }), card('Images viewed', studies), h('div', { style: 'height:1rem' }), contentCard, h('div', { style: 'height:1rem' }), caseCard);
}

// ---------- Labelling projects ----------
const TASK_HELP = {
  classification: 'One label per item.', span: 'Mark words or phrases in the text.', bbox: 'Draw boxes on an image.', region: 'Draw regions on a whole-slide image.', agreement: 'Grade whether a signed report agrees with its images.',
};
const DEFAULT_LABELS = {
  classification: [{ id: 'normal', label: 'Normal' }, { id: 'abnormal', label: 'Abnormal' }, { id: 'unsure', label: 'Cannot tell' }],
  span: [{ id: 'finding', label: 'Finding' }, { id: 'negated', label: 'Negated finding' }, { id: 'plan', label: 'Plan' }],
  bbox: [{ id: 'finding', label: 'Finding' }, { id: 'device', label: 'Line or device' }],
  agreement: [{ id: 'agree', label: 'Agrees' }, { id: 'minor', label: 'Minor discrepancy' }, { id: 'major', label: 'Major discrepancy' }],
};
const SOURCE_LABEL = { DocumentReference: 'Clinical notes', DiagnosticReport: 'Imaging reports', Observation: 'Lab results', ImagingStudy: 'Imaging studies', Communication: 'Patient messages' };

function kappaBadge(p) {
  const a = p.agreement;
  if (a.kappa == null) return h('span', { class: 'muted', testid: `kappa-${p.id}` }, a.n ? 'not defined' : '—');
  return h('span', { testid: `kappa-${p.id}` }, badge(`κ ${a.kappa.toFixed(2)}`, a.kappa < p.threshold ? 'danger' : 'ok'), ` ${a.reading}`);
}

function newProjectDialog(taskTypes, go) {
  let last = 'classification';
  formDialog({
    title: 'New labelling project', testid: 'project-new', submitLabel: 'Create project', wide: true,
    fields: [
      { name: 'name', label: 'Project name', type: 'text', required: true, wide: true },
      { name: 'taskType', label: 'Kind of labelling', type: 'select', options: taskTypes.map((t) => [t.id, t.label]), value: 'classification' },
      { name: 'resourceType', label: 'What to label', type: 'select', options: taskTypes[0].sources.map((s) => [s, SOURCE_LABEL[s]]) },
      { name: 'labels', label: 'Labels (a JSON array)', type: 'textarea', rows: 5, required: true, wide: true, value: JSON.stringify(DEFAULT_LABELS.classification, null, 1) },
      { name: 'instructions', label: 'Instructions for annotators', type: 'textarea', rows: 3, wide: true },
      { name: 'limit', label: 'How many items', type: 'number', min: 1, max: 500, value: 20 },
      { name: 'annotatorsPerItem', label: 'Readers per item', type: 'select', options: [[2, '2 (blind double-read)'], [3, '3'], [1, '1 (no agreement measured)']], value: 2 },
      { name: 'seed', label: 'Sampling seed', type: 'number', min: 0, value: 1 },
      { name: 'status', label: 'Only with status (optional)', type: 'text', placeholder: 'for example: final' },
    ],
    onChange: (v, controls, extra) => {
      if (v.taskType !== last) {
        last = v.taskType;
        const sources = taskTypes.find((t) => t.id === v.taskType).sources;
        clear(controls.resourceType.input).append(...sources.map((s) => h('option', { value: s }, SOURCE_LABEL[s])));
        controls.labels.set(JSON.stringify(DEFAULT_LABELS[v.taskType], null, 1));
      }
      clear(extra).append(h('p', { class: 'muted small', testid: 'project-new-help' }, `${TASK_HELP[v.taskType]} The sample is drawn once, in a fixed order set by the seed, and does not change afterwards. Each reader labels without seeing anyone else's answer.`));
    },
    onSubmit: async (v) => {
      let labels;
      try { labels = JSON.parse(v.labels); } catch { throw new Error('Labels must be a JSON array, for example [{"id":"normal","label":"Normal"}]'); }
      const p = await api.post('/agent-ops/annotation/projects', {
        name: v.name, taskType: v.taskType, labels, instructions: v.instructions, annotatorsPerItem: Number(v.annotatorsPerItem),
        sampling: { resourceType: v.resourceType, limit: Number(v.limit), seed: Number(v.seed) || 0, status: v.status || undefined },
      });
      toast(`Project created with ${plural(p.progress.items, 'item')}`);
      go(`#/labelling/${p.id}`);
    },
  });
}

export async function labellingPage(go) {
  const { projects, taskTypes, threshold } = await api.get('/agent-ops/annotation/projects');
  const create = btn('New project', { kind: 'primary', testid: 'project-create', onClick: () => newProjectDialog(taskTypes, go) });
  if (!projects.length) return page('Labelling', create, h('div', { class: 'card empty', testid: 'projects-empty' }, 'No labelling projects yet. A project takes a fixed sample of notes, reports, results or images and sends each one to two readers who cannot see each other\'s answers.'));
  return page('Labelling', create,
    h('p', { class: 'muted', style: 'margin:-0.375rem 0 1.125rem;max-width:56.25rem' }, `Agreement is Cohen's κ for two readers and Fleiss' κ for three or more. Below ${threshold}, every disagreement goes to a third person to adjudicate.`),
    table({ testid: 'projects-table', rows: projects, rowId: (p) => p.id, onRow: (p) => go(`#/labelling/${p.id}`), columns: [
      { label: 'Project', render: (p) => p.name }, { label: 'Kind', render: (p) => p.taskLabel },
      { label: 'Items fully read', render: (p) => `${p.progress.complete} of ${p.progress.items}` }, { label: 'Agreement', render: kappaBadge },
      { label: 'Waiting for adjudication', render: (p) => (p.adjudication.waiting ? badge(String(p.adjudication.waiting), 'warn') : '0') },
      { label: 'Status', render: (p) => badge(p.status === 'active' ? 'Open' : 'Closed', p.status === 'active' ? 'accent' : '') },
    ] }));
}

export async function projectPage(id, go, render) {
  const p = await api.get(`/agent-ops/annotation/projects/${id}`);
  const a = p.agreement;
  const link = (path, label, testid) => h('a', { class: 'btn', href: `/agent-ops/annotation/projects/${id}/${path}`, download: '', testid, 'aria-label': `Download ${label}` }, label);
  const tiles = h('div', { class: 'tiles6' },
    tile('Items', p.progress.items, 'proj-items'), tile('Fully read', p.progress.complete, 'proj-complete'), tile('Reads done', `${p.progress.reads} / ${p.progress.readsNeeded}`, 'proj-reads'),
    tile(a.statistic === 'fleiss' ? 'Fleiss\' κ' : 'Cohen\'s κ', a.kappa == null ? '—' : a.kappa.toFixed(2), 'proj-kappa'), tile('Waiting for adjudication', p.adjudication.waiting, 'proj-waiting'), tile('Items with a final label', p.resolved, 'proj-resolved'));
  const agreementCard = card('Agreement between readers',
    h('p', { testid: 'proj-agreement-note', style: 'margin:0 0 0.5rem' }, a.note, a.kappa != null ? ` κ = ${a.kappa.toFixed(3)} (${a.reading}) over ${plural(a.n, a.unit)}; readers gave the same answer on ${Math.round(a.observed * 100)}% of them, against ${Math.round(a.expected * 100)}% expected by chance.` : a.n ? ' κ is not defined because every answer used the same single label.' : ''),
    a.itemAgreement != null ? h('p', { class: 'muted', style: 'margin:0 0 0.5rem' }, `Readers agreed completely on ${Math.round(a.itemAgreement * 100)}% of fully read items.${a.boxF1 != null ? ` Matching boxes (overlap of at least half): F1 ${a.boxF1.toFixed(2)}.` : ''}`) : null,
    p.adjudication.required ? h('div', { class: 'banner warn', testid: 'proj-adjudication-required' }, h('strong', {}, `Agreement is below ${p.threshold}. `), 'Every disagreement must be settled by someone who did not read the item.')
      : p.adjudication.waiting ? h('div', { class: 'banner info', testid: 'proj-adjudication-some' }, `${plural(p.adjudication.waiting, 'item')} could not be settled by the readers and ${p.adjudication.waiting === 1 ? 'needs' : 'need'} adjudication.`) : null);
  const readers = card('Readers', p.annotators.length ? table({ testid: 'proj-annotators', rows: p.annotators, columns: [{ label: 'Reader', render: (x) => x.id }, { label: 'Items read', render: (x) => x.reads }] }) : h('p', { class: 'muted', style: 'margin:0' }, 'Nobody has labelled anything yet.'),
    h('p', { class: 'muted small', style: 'margin:0.625rem 0 0' }, `You are working as "${me()}". Readers are told apart by the name in "Work as" on the desktop, so each reader should set their own name there.${p.medianSeconds != null ? ` Median time per item: ${p.medianSeconds} s.` : ''}`));
  const setup = card('Project', kv([['Kind', p.taskLabel], ['Labels', p.labels.map((l) => l.label).join(', ')], ['Sample', `${p.sampling.limit} ${SOURCE_LABEL[p.sampling.resourceType] || p.sampling.resourceType}, seed ${p.sampling.seed}${p.sampling.status ? `, status ${p.sampling.status}` : ''}`],
    ['Readers per item', p.annotatorsPerItem], ['Created', `${fmtDateTime(p.createdAt)} by ${p.createdBy}`], ['Instructions', p.instructions || 'None']]));
  const exports = card('Export (de-identified)',
    h('p', { class: 'muted', style: 'margin:0 0 0.625rem;max-width:51.25rem' }, 'Record ids become hashes, readers become "annotator-1", "annotator-2", and names, record numbers and dates inside text are masked. The first line of the file says what was removed. Each download is logged.'),
    h('div', { class: 'toolbar', style: 'margin:0' }, link('export.jsonl', 'labels.jsonl', 'export-labels-jsonl'), p.taskType === 'bbox' || p.taskType === 'region' ? link('export.coco.json', 'labels.coco.json', 'export-labels-coco') : null));
  return page(p.name, h('div', { class: 'toolbar', style: 'margin:0' },
    btn('Label items', { kind: 'primary', testid: 'proj-label', disabled: p.status !== 'active', onClick: () => go(`#/label/${id}`) }),
    btn(`Adjudicate${p.adjudication.waiting ? ` (${p.adjudication.waiting})` : ''}`, { testid: 'proj-adjudicate', disabled: !p.adjudication.waiting, onClick: () => go(`#/adjudicate/${id}`) }),
    p.status === 'active' ? btn('Close project', { testid: 'proj-close', onClick: async () => { if (await confirmDialog({ title: 'Close this project?', message: 'No more labels can be added. Adjudication and export still work.', confirmLabel: 'Close project', testid: 'proj-close-confirm' })) { await api.post(`/agent-ops/annotation/projects/${id}/close`, {}); render(); } } }) : badge('Closed', ''),
    btn('Every step', { testid: 'proj-trace', onClick: () => go(`#/runs/${p.runId}`) })),
  tiles, agreementCard, h('div', { style: 'height:1rem' }), h('div', { class: 'rgrid' }, setup, readers), h('div', { style: 'height:1rem' }), exports);
}

// ---------- Answer tools (shared by the workbench and adjudication) ----------
const hue = (i) => (i * 67 + 215) % 360;
const colour = (i, alpha = 1) => `hsl(${hue(i)} 65% 42% / ${alpha})`;

function contentView(content) {
  if (content.kind === 'lab') return h('div', { testid: 'item-content' }, kv([['Test', content.title], ['Result', content.value ?? ''], ['Reference range', content.range || '—'], ['Flag', content.interpretation || '—']]));
  if (content.kind === 'study') return h('div', { testid: 'item-content' }, h('p', { style: 'margin-top:0' }, `${content.modality || ''} ${content.title}`), viewerFrame(content.studyId));
  if (content.kind === 'missing') return h('p', { class: 'muted', testid: 'item-content' }, content.title);
  return h('div', { testid: 'item-content' }, h('h3', { style: 'margin-top:0' }, content.title), h('div', { class: 'itemtext', testid: 'item-text' }, content.text || 'No text.'));
}
const viewerFrame = (studyId) => h('iframe', { class: 'viewerframe', src: `/pacs/?embed=1#/study/${studyId}`, title: 'Image viewer', testid: 'item-viewer', 'aria-label': 'Image viewer for this item' });

/** One label for the whole item. Keys 1 to 9 choose. */
function choiceTool(project, { initial = null, readOnly = false } = {}) {
  let chosen = initial?.label ?? null;
  const el = h('div', { class: 'choicelist', role: 'radiogroup', 'aria-label': 'Label' });
  const draw = () => clear(el).append(...project.labels.map((l, i) => h('button', { type: 'button', class: 'choice', role: 'radio', 'aria-checked': chosen === l.id ? 'true' : 'false', disabled: readOnly, testid: `label-${l.id}`, 'aria-label': `${l.label} (key ${i + 1})`, onClick: () => { chosen = l.id; draw(); } },
    h('kbd', {}, String(i + 1)), l.label)));
  draw();
  return { el, get: () => (chosen ? { label: chosen } : null), key: (e) => { const i = Number(e.key) - 1; if (project.labels[i] && !readOnly) { chosen = project.labels[i].id; draw(); return true; } return false; }, missing: 'Choose a label first' };
}

/** Spans over words. Choose a label (1 to 9), click the first word, then the last word. Click a marked word to remove its span. */
function spanTool(project, text, { initial = null, readOnly = false } = {}) {
  const tokens = [...String(text).matchAll(/\S+/g)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  let spans = (initial?.spans || []).map((s) => ({ ...s }));
  let active = project.labels[0].id;
  let anchor = null;
  const palette = h('div', { class: 'choicelist', role: 'radiogroup', 'aria-label': 'Label to mark with' });
  const body = h('div', { class: 'itemtext spans', testid: 'span-text' });
  const count = h('span', { class: 'muted small', testid: 'span-count' });
  const index = (id) => project.labels.findIndex((l) => l.id === id);
  function click(i) {
    if (readOnly) return;
    const t = tokens[i];
    const hit = spans.find((s) => t.start >= s.start && t.end <= s.end);
    if (hit && anchor == null) { spans = spans.filter((s) => s !== hit); draw(); return; }
    if (anchor == null) { anchor = i; draw(); return; }
    const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
    const span = { label: active, start: tokens[a].start, end: tokens[b].end };
    spans = [...spans.filter((s) => s.end <= span.start || s.start >= span.end), span].sort((x, y) => x.start - y.start);
    anchor = null;
    draw();
  }
  function draw() {
    clear(palette).append(...project.labels.map((l, i) => h('button', { type: 'button', class: 'choice', role: 'radio', 'aria-checked': active === l.id ? 'true' : 'false', disabled: readOnly, testid: `label-${l.id}`, 'aria-label': `Mark with ${l.label} (key ${i + 1})`, style: `border-left:0.25rem solid ${colour(i)}`, onClick: () => { active = l.id; draw(); } }, h('kbd', {}, String(i + 1)), l.label)));
    const parts = [];
    let at = 0;
    tokens.forEach((t, i) => {
      if (t.start > at) parts.push(text.slice(at, t.start));
      const s = spans.find((x) => t.start >= x.start && t.end <= x.end);
      const li = s ? index(s.label) : -1;
      parts.push(h('span', { class: `tok${s ? ' marked' : ''}${anchor === i ? ' anchor' : ''}`, testid: `tok-${i}`, role: 'button', tabindex: readOnly ? undefined : 0, 'aria-label': `${text.slice(t.start, t.end)}${s ? `, marked ${project.labels[li]?.label}` : ''}`,
        title: s ? project.labels[li]?.label : undefined, style: s ? `background:${colour(li, 0.18)};box-shadow:inset 0 -0.125rem 0 ${colour(li)}` : undefined,
        onClick: () => click(i), onKeydown: (e) => { if (e.key === ' ') { e.preventDefault(); click(i); } } }, text.slice(t.start, t.end), s && t.start === tokens.find((x) => x.start >= s.start).start ? h('sup', {}, String(li + 1)) : null));
      at = t.end;
    });
    if (at < text.length) parts.push(text.slice(at));
    clear(body).append(...parts);
    count.textContent = anchor != null ? 'Now click the last word of the phrase (Esc cancels).' : `${plural(spans.length, 'span')} marked. Click the first word, then the last word. Click a marked word to remove it.`;
  }
  draw();
  return {
    el: h('div', {}, palette, count, body), get: () => ({ spans: spans.map((s) => ({ ...s })) }),
    key: (e) => { if (readOnly) return false; if (e.key === 'Escape' && anchor != null) { anchor = null; draw(); return true; } const i = Number(e.key) - 1; if (project.labels[i]) { active = project.labels[i].id; draw(); return true; } return false; },
  };
}

/** Boxes on an image frame. Choose a label (1 to 9) and drag. Click a box to select it, Delete removes it. */
function boxTool(project, content, { initial = null, readOnly = false, ghosts = [] } = {}) {
  const { frame } = content;
  let boxes = (initial?.boxes || []).map((b) => ({ ...b }));
  let active = project.labels[0].id;
  let selected = -1;
  let drag = null;
  let image = null;
  const canvas = h('canvas', { class: 'boxcanvas', width: frame.columns, height: frame.rows, testid: 'box-canvas', tabindex: 0, role: 'img', 'aria-label': 'Image to draw boxes on' });
  const palette = h('div', { class: 'choicelist', role: 'radiogroup', 'aria-label': 'Label to draw with' });
  const status = h('span', { class: 'muted small', testid: 'box-count' });
  const ctx = canvas.getContext('2d');
  const index = (id) => project.labels.findIndex((l) => l.id === id);
  const point = (e) => { const r = canvas.getBoundingClientRect(); return { x: Math.max(0, Math.min(frame.columns, ((e.clientX - r.left) * frame.columns) / r.width)), y: Math.max(0, Math.min(frame.rows, ((e.clientY - r.top) * frame.rows) / r.height)) }; };
  const rect = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });
  function draw() {
    clear(palette).append(...project.labels.map((l, i) => h('button', { type: 'button', class: 'choice', role: 'radio', 'aria-checked': active === l.id ? 'true' : 'false', disabled: readOnly, testid: `label-${l.id}`, 'aria-label': `Draw ${l.label} (key ${i + 1})`, style: `border-left:0.25rem solid ${colour(i)}`, onClick: () => { active = l.id; draw(); } }, h('kbd', {}, String(i + 1)), l.label)));
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (image) ctx.putImageData(image, 0, 0);
    const line = Math.max(2, Math.round(frame.columns / 256));
    ctx.font = `600 ${Math.max(12, Math.round(frame.columns / 36))}px sans-serif`;
    const paint = (b, i, { dash = [], tag = '' } = {}) => {
      const li = index(b.label);
      ctx.setLineDash(dash); ctx.lineWidth = i === selected && !dash.length ? line * 2 : line; ctx.strokeStyle = `hsl(${hue(li)} 90% 60%)`;
      ctx.strokeRect(b.x, b.y, b.width, b.height);
      ctx.fillStyle = `hsl(${hue(li)} 90% 60%)`;
      ctx.fillText(`${tag}${project.labels[li]?.label ?? b.label}`, b.x + line * 2, Math.max(b.y - line * 2, Number.parseInt(ctx.font.split(' ')[1], 10)));
    };
    ghosts.forEach((g) => g.boxes.forEach((b) => paint(b, -1, { dash: [line * 3, line * 2], tag: `${g.tag}: ` })));
    boxes.forEach((b, i) => paint(b, i));
    if (drag?.moved) paint({ ...rect(drag.from, drag.to), label: active }, -1);
    ctx.setLineDash([]);
    status.textContent = readOnly ? plural(boxes.length, 'box') : `${plural(boxes.length, 'box')}. Drag to draw. Click a box to select it; Delete removes it.`;
    canvas.dataset.boxes = String(boxes.length);
  }
  if (!readOnly) {
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture?.(e.pointerId); const p = point(e); drag = { from: p, to: p, moved: false }; });
    canvas.addEventListener('pointermove', (e) => { if (!drag) return; drag.to = point(e); drag.moved = drag.moved || Math.abs(drag.to.x - drag.from.x) + Math.abs(drag.to.y - drag.from.y) > 3; draw(); });
    canvas.addEventListener('pointerup', (e) => {
      if (!drag) return;
      const r = rect(drag.from, point(e));
      if (drag.moved && r.width >= 2 && r.height >= 2) { boxes.push({ label: active, ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v * 10) / 10])) }); selected = boxes.length - 1; }
      else { const p = drag.from; selected = boxes.findLastIndex((b) => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height); }
      drag = null; draw();
    });
  }
  draw();
  const ready = (async () => {
    try {
      const response = await fetch(`/dicom-web/wado?requestType=WADO&studyUID=${encodeURIComponent(frame.studyUid)}&seriesUID=${encodeURIComponent(frame.seriesUid)}&objectUID=${encodeURIComponent(frame.sopUid)}`);
      if (!response.ok) throw new Error(`The image could not be loaded (${response.status})`);
      const info = pixels(parse(new Uint8Array(await response.arrayBuffer())));
      const px = info.frame(Math.min(frame.frame ?? 0, info.frames - 1));
      const w = info.windowCenter != null && info.windowWidth ? { center: info.windowCenter, width: info.windowWidth } : autoWindow(px, info);
      image = new ImageData(toRGBA(px, info, w), info.columns, info.rows);
      canvas.dataset.loaded = '1';
    } catch (err) { status.textContent = err.message; canvas.dataset.loaded = 'error'; return; }
    draw();
  })();
  return {
    el: h('div', {}, palette, status, h('div', { class: 'boxwrap' }, canvas)), ready, get: () => ({ boxes: boxes.map((b) => ({ ...b })) }),
    set: (next) => { boxes = next.map((b) => ({ ...b })); selected = -1; draw(); },
    key: (e) => {
      if (readOnly) return false;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected >= 0) { boxes.splice(selected, 1); selected = -1; draw(); return true; }
      const i = Number(e.key) - 1; if (project.labels[i]) { active = project.labels[i].id; draw(); return true; } return false;
    },
  };
}

/** Regions on a whole-slide image, drawn in the embedded pathology viewer (level-0 pixel coordinates travel by postMessage). */
function regionTool(project, content, { initial = null, readOnly = false, ghosts = [] } = {}) {
  let boxes = (initial?.boxes || []).map((b) => ({ ...b }));
  let active = project.labels[0].id;
  const frame = h('iframe', { class: 'viewerframe', src: `/pathology/?embed=1#/slide/${content.slideId}?region=${readOnly ? '0' : '1'}`, title: 'Slide viewer', testid: 'item-viewer', 'aria-label': 'Slide viewer for this item', style: 'height:32.5rem' });
  const palette = h('div', { class: 'choicelist', role: 'radiogroup', 'aria-label': 'Label to draw with' });
  const status = h('span', { class: 'muted small', testid: 'box-count' });
  const send = () => frame.contentWindow?.postMessage({ type: 'hd-set-regions', boxes, ghosts: ghosts.flatMap((g) => g.boxes.map((b) => ({ ...b, label: `${g.tag}: ${b.label}` }))), label: active }, '*');
  const draw = () => {
    clear(palette).append(...project.labels.map((l, i) => h('button', { type: 'button', class: 'choice', role: 'radio', 'aria-checked': active === l.id ? 'true' : 'false', disabled: readOnly, testid: `label-${l.id}`, 'aria-label': `Draw ${l.label} (key ${i + 1})`, onClick: () => { active = l.id; draw(); send(); } }, h('kbd', {}, String(i + 1)), ' ', l.label)));
    status.textContent = readOnly ? plural(boxes.length, 'region') : `${plural(boxes.length, 'region')}. Drag in the viewer to draw a region with the chosen label.`;
    status.dataset.boxes = String(boxes.length);
  };
  const onMessage = (e) => { if (e.source !== frame.contentWindow) return; if (e.data?.type === 'hd-region-ready') send(); if (e.data?.type === 'hd-region' && !readOnly) { boxes = (e.data.boxes || []).map((b) => ({ label: b.label || active, x: b.x, y: b.y, width: b.width, height: b.height })); draw(); } };
  window.addEventListener('message', onMessage);
  draw();
  return {
    el: h('div', {}, palette, status, frame), ready: Promise.resolve(), get: () => ({ boxes: boxes.map((b) => ({ ...b })) }),
    set: (next) => { boxes = next.map((b) => ({ ...b })); draw(); send(); },
    key: (e) => { if (readOnly) return false; const i = Number(e.key) - 1; if (project.labels[i]) { active = project.labels[i].id; draw(); send(); return true; } return false; },
    destroy: () => window.removeEventListener('message', onMessage),
  };
}

function toolFor(project, content, options) {
  if (project.taskType === 'span') return spanTool(project, content.text || '', options);
  if (project.taskType === 'bbox') return boxTool(project, content, options);
  if (project.taskType === 'region') return regionTool(project, content, options);
  return choiceTool(project, options);
}

// Keys act on the workbench only while no dialog is open and the user is not typing.
let unbind = () => {};
function bindKeys(handler) {
  unbind();
  const onKey = (e) => {
    if (document.querySelector('dialog[open]') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target?.tagName)) return;
    if (handler(e)) e.preventDefault();
  };
  document.addEventListener('keydown', onKey);
  unbind = () => document.removeEventListener('keydown', onKey);
}
export const leaveWorkbench = () => { unbind(); unbind = () => {}; };

// ---------- Workbench ----------
const skipped = new Map();
export async function workbenchPage(id, go, render) {
  const skip = skipped.get(id) || [];
  const data = await api.get(`/agent-ops/annotation/projects/${id}/next`, skip.length ? { skip: skip.join(',') } : {});
  const { project, item, progress } = data;
  const back = btn('Back to project', { testid: 'wb-back', onClick: () => go(`#/labelling/${id}`) });
  const head = h('p', { class: 'muted', testid: 'wb-progress', style: 'margin:-0.375rem 0 0.875rem' }, `Labelling as "${data.annotator}". You have labelled ${progress.mine} of ${progress.items}; ${plural(progress.available, 'item')} left for you.`);
  if (!item) {
    leaveWorkbench();
    return page(project.name, back, head, h('div', { class: 'card empty', testid: 'wb-done' }, project.status !== 'active' ? 'This project is closed.' : progress.mine ? 'Nothing left for you to label in this project. Thank you.' : 'Every item already has its readers.'));
  }
  const tool = toolFor(project, item.content);
  const shownAt = Date.now();
  const error = h('div', { class: 'form-error', testid: 'wb-error', role: 'alert' });
  const comment = h('input', { type: 'text', placeholder: 'Optional comment', testid: 'wb-comment', 'aria-label': 'Optional comment', maxlength: 500 });
  let busy = false;
  const submit = async () => {
    if (busy) return;
    const answer = tool.get();
    if (!answer) { error.textContent = tool.missing; return; }
    busy = true; error.textContent = '';
    try {
      await api.post(`/agent-ops/annotation/projects/${id}/items/${item.id}/labels`, { ...answer, comment: comment.value, seconds: Math.round((Date.now() - shownAt) / 100) / 10 });
      render();
    } catch (err) { error.textContent = err.message; busy = false; }
  };
  const skipIt = async () => {
    if (busy) return;
    skipped.set(id, [...skip.filter((x) => x !== item.id), item.id]);
    api.post(`/agent-ops/annotation/projects/${id}/items/${item.id}/skip`, {}).catch(() => {});
    render();
  };
  bindKeys((e) => { if (e.key === 'Enter') { submit(); return true; } if (e.key === 's' || e.key === 'S') { skipIt(); return true; } return tool.key(e); });
  const imageTask = project.taskType === 'bbox' || project.taskType === 'region';
  const left = imageTask ? h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, `${item.content.modality || ''} ${item.content.title}`), tool.el,
    project.taskType === 'region' ? h('p', { class: 'muted small', style: 'margin:0.5rem 0 0' }, h('a', { href: `/pathology/#/slide/${item.content.slideId}`, target: '_blank', rel: 'noopener', testid: 'wb-open-slide', 'aria-label': 'Open the slide in the pathology viewer' }, 'Open the slide in Pathology')) : h('details', { style: 'margin-top:0.75rem' }, h('summary', { testid: 'wb-open-viewer', 'aria-label': 'Open the whole study in the viewer' }, 'Open the whole study in the viewer'), viewerFrame(item.content.studyId)))
    : project.taskType === 'span' ? h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, item.content.title), tool.el)
      : h('div', { class: 'card' }, contentView(item.content), project.taskType === 'agreement' && item.content.studyId ? viewerFrame(item.content.studyId) : null);
  const right = h('div', { class: 'card', testid: 'wb-panel' },
    h('h3', { style: 'margin-top:0' }, `Item ${progress.mine + 1}`), project.instructions ? h('p', { testid: 'wb-instructions', style: 'white-space:pre-wrap' }, project.instructions) : null,
    ['classification', 'agreement'].includes(project.taskType) ? tool.el : null,
    h('label', { class: 'field', style: 'margin-top:0.75rem' }, h('span', {}, 'Comment'), comment), error,
    h('div', { class: 'toolbar', style: 'margin:0.75rem 0 0' }, btn('Save and next', { kind: 'primary', testid: 'wb-submit', onClick: submit }), btn('Skip for now', { testid: 'wb-skip', onClick: skipIt })),
    h('p', { class: 'muted small', testid: 'wb-keys', style: 'margin:0.75rem 0 0' }, 'Keys: 1 to 9 choose a label · Enter saves and moves on · S skips', imageTask ? ' · Delete removes the selected box' : project.taskType === 'span' ? ' · Esc cancels a half-marked phrase' : '', '. You will not see anyone else\'s answer for this item.'));
  const el = page(project.name, back, head, h('div', { class: 'wbgrid', testid: `wb-item-${item.id}` }, left, right));
  return el;
}

// ---------- Adjudication ----------
export async function adjudicationPage(id, go, render) {
  const data = await api.get(`/agent-ops/annotation/projects/${id}/adjudication`);
  const { project, item } = data;
  const back = btn('Back to project', { testid: 'adj-back', onClick: () => go(`#/labelling/${id}`) });
  const head = h('p', { class: 'muted', testid: 'adj-progress', style: 'margin:-0.375rem 0 0.875rem' }, `Adjudicating as "${data.adjudicator}". ${plural(data.waiting, 'item')} waiting${data.hiddenBecauseYouReadThem ? `; ${data.hiddenBecauseYouReadThem} of them you read yourself, so someone else must settle ${data.hiddenBecauseYouReadThem === 1 ? 'it' : 'them'}` : ''}.`);
  if (!item) {
    leaveWorkbench();
    return page(`Adjudicate: ${project.name}`, back, head, h('div', { class: 'card empty', testid: 'adj-done' }, data.waiting ? 'The items still waiting are ones you read yourself. Ask someone who did not read them (set a different name in "Work as" on the desktop).' : 'Nothing is waiting for adjudication.'));
  }
  const label = (lid) => project.labels.find((l) => l.id === lid)?.label ?? lid;
  const ghosts = project.taskType === 'bbox' || project.taskType === 'region' ? item.reads.map((r) => ({ tag: r.reader.slice(-1), boxes: r.boxes || [] })) : [];
  const tool = toolFor(project, item.content, { ghosts });
  const readCards = item.reads.map((r, i) => h('div', { class: 'card', testid: `adj-read-${i}` }, h('h3', { style: 'margin-top:0' }, r.reader),
    project.taskType === 'span' ? spanTool(project, item.content.text || '', { initial: { spans: r.spans || [] }, readOnly: true }).el.lastChild
      : project.taskType === 'bbox' || project.taskType === 'region' ? h('div', {}, h('p', { style: 'margin:0 0 0.5rem' }, (r.boxes || []).length ? (r.boxes || []).map((b) => label(b.label)).join(', ') : 'No boxes'), btn(`Start from ${r.reader}`, { small: true, testid: `adj-copy-${i}`, onClick: () => tool.set(r.boxes || []) }))
        : h('p', { style: 'margin:0', testid: `adj-read-label-${i}` }, badge(label(r.label), 'accent')),
    r.comment ? h('p', { class: 'muted small', style: 'margin:0.5rem 0 0' }, `Comment: ${r.comment}`) : null));
  const error = h('div', { class: 'form-error', testid: 'adj-error', role: 'alert' });
  const comment = h('input', { type: 'text', placeholder: 'Optional comment', testid: 'adj-comment', 'aria-label': 'Optional comment', maxlength: 500 });
  let busy = false;
  const submit = async () => {
    if (busy) return;
    const answer = tool.get();
    if (!answer) { error.textContent = tool.missing; return; }
    busy = true; error.textContent = '';
    try { await api.post(`/agent-ops/annotation/projects/${id}/items/${item.id}/adjudicate`, { ...answer, comment: comment.value }); toast('Final label saved'); render(); } catch (err) { error.textContent = err.message; busy = false; }
  };
  bindKeys((e) => { if (e.key === 'Enter') { submit(); return true; } return tool.key(e); });
  const content = project.taskType === 'bbox' || project.taskType === 'region' ? h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Your final boxes (readers\' boxes are dashed)'), tool.el)
    : project.taskType === 'span' ? h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Your final marking'), tool.el)
      : h('div', { class: 'card' }, contentView(item.content), project.taskType === 'agreement' && item.content.studyId ? viewerFrame(item.content.studyId) : null);
  const panel = h('div', { class: 'card', testid: 'adj-panel' }, h('h3', { style: 'margin-top:0' }, 'Final label'), ['classification', 'agreement'].includes(project.taskType) ? tool.el : null,
    h('label', { class: 'field', style: 'margin-top:0.75rem' }, h('span', {}, 'Comment'), comment), error,
    h('div', { class: 'toolbar', style: 'margin:0.75rem 0 0' }, btn('Save final label', { kind: 'primary', testid: 'adj-submit', onClick: submit })));
  return page(`Adjudicate: ${project.name}`, back, head, h('div', { class: 'wbgrid', testid: `adj-item-${item.id}` }, content, h('div', {}, h('div', { class: 'readgrid' }, readCards), h('div', { style: 'height:0.75rem' }), panel)));
}
