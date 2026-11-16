// Everything the trace viewer needs about one run, in one answer: the task
// in plain English, every step with a readable summary of what was seen and
// written, verifier results pinned to the steps that caused them, the point
// where agent and clinician parted (shadow runs), and outcome horizons.
import { HttpError } from '../../platform/server/http.mjs';
import { stripInternal } from '../../platform/server/fhir-api.mjs';
import { withStatus } from './runs.mjs';
import { shadowReport } from './shadow.mjs';
import { verifierScore } from './grader.mjs';
import { REPORT_URLS } from '../../platform/server/state-machines.mjs';

const display = (c) => c?.text || c?.coding?.[0]?.display || c?.coding?.[0]?.code || '';
const clip = (t, n = 140) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const decode = (data) => { try { return Buffer.from(String(data || ''), 'base64').toString('utf8'); } catch { return ''; } };
const NAMES = {
  Patient: 'Patient', Observation: 'Result', Condition: 'Problem', AllergyIntolerance: 'Allergy', MedicationRequest: 'Medication', ServiceRequest: 'Order', DiagnosticReport: 'Report',
  ImagingStudy: 'Imaging study', DocumentReference: 'Note', Communication: 'Message', Task: 'Task', Encounter: 'Visit', Appointment: 'Appointment', Provenance: 'Provenance record',
};

/** One readable line for a record: what it is and its value, never raw JSON. */
export function summarise(doc) {
  const kind = NAMES[doc.resourceType] || doc.resourceType;
  switch (doc.resourceType) {
    case 'Patient': return { kind, name: `${doc.gender || 'patient'}${doc.birthDate ? `, born ${String(doc.birthDate).slice(0, 4)}` : ''}`, value: '' };
    case 'Observation': {
      const q = doc.valueQuantity;
      const flag = doc.interpretation?.[0]?.coding?.[0]?.code;
      return { kind: (doc.category || []).some((c) => (c.coding || []).some((x) => x.code === 'vital-signs')) ? 'Vital sign' : kind, name: display(doc.code), value: `${q ? `${q.value} ${q.unit || ''}`.trim() : (doc.valueString ?? display(doc.valueCodeableConcept))}${flag && flag !== 'N' ? ` (${flag})` : ''} · ${doc.status}` };
    }
    case 'Condition': return { kind, name: display(doc.code), value: display(doc.clinicalStatus) || '' };
    case 'AllergyIntolerance': return { kind, name: display(doc.code), value: [doc.criticality ? `${doc.criticality} criticality` : null, display(doc.reaction?.[0]?.manifestation?.[0])].filter(Boolean).join(', ') };
    case 'MedicationRequest': return { kind, name: display(doc.medicationCodeableConcept), value: [doc.dosageInstruction?.[0]?.text, doc.status].filter(Boolean).join(' · ') };
    case 'ServiceRequest': return { kind, name: display(doc.code), value: [doc.priority, doc.status].filter(Boolean).join(' · ') };
    case 'DiagnosticReport': return { kind, name: display(doc.code) || 'Report', value: `${doc.status}${doc.conclusion ? `: ${clip(doc.conclusion)}` : ''}` };
    case 'ImagingStudy': return { kind, name: doc.description || 'Imaging study', value: [doc.series?.[0]?.modality?.code ?? doc.modality?.[0]?.code, doc.reasonCode?.[0]?.text].filter(Boolean).join(' · ') };
    case 'DocumentReference': return { kind, name: display(doc.type) || 'Note', value: clip(decode(doc.content?.[0]?.attachment?.data)) };
    case 'Communication': return { kind, name: doc.topic?.text || 'Message', value: clip(doc.payload?.[0]?.contentString) };
    case 'Task': return { kind, name: display(doc.code) || 'Task', value: [doc.priority, doc.status].filter(Boolean).join(' · ') };
    case 'Encounter': return { kind, name: display(doc.type?.[0]) || doc.class?.code || 'Visit', value: doc.status };
    default: return { kind, name: display(doc.code) || doc.resourceType, value: doc.status || '' };
  }
}

/** The body of a written record, as a few labelled lines. */
function written(doc) {
  const lines = [];
  const add = (label, value) => { if (value != null && String(value).trim()) lines.push({ label, value: String(value) }); };
  if (doc.resourceType === 'DiagnosticReport') {
    add('Technique', (doc.extension || []).find((e) => e.url === REPORT_URLS.technique)?.valueString);
    add('Findings', (doc.extension || []).find((e) => e.url === REPORT_URLS.findings)?.valueString);
    add('Impression', doc.conclusion);
  } else if (doc.resourceType === 'DocumentReference') add('Text', decode(doc.content?.[0]?.attachment?.data));
  else if (doc.resourceType === 'Task') { add('Priority', doc.priority); add('Suggested reply', (doc.output || []).map((o) => o.valueString).filter(Boolean).join('\n') || doc.description); }
  else if (doc.resourceType === 'MedicationRequest') add('Instructions', doc.dosageInstruction?.[0]?.text);
  else if (doc.resourceType === 'ServiceRequest') add('Reason', doc.reasonCode?.[0]?.text);
  return lines;
}

const tone = (s) => {
  const t = s.did.type;
  if (t === 'safety.block' || t === 'safety.override' || t === 'grade.unsafe') return 'alert';
  if (t === 'envelope.reject' || t === 'proposal.reject' || s.who.approval === 'rejected') return 'reject';
  return s.who.kind === 'agent' ? 'agent' : 'human';
};

export function createTraceView({ store, capture = null, rl = null }) {
  async function view(runId, ctx) {
    const run = await store.get('Run', runId);
    if (!run) throw new HttpError(404, `Run ${runId} not found`);
    const steps = await store.query('TraceStep', { groupKey: run.id });
    const find = async () => (await store.query('Episode', { where: (e) => e.runId === run.id })).sort((a, b) => a._seq - b._seq)[0] ?? null;
    let episode = await find();
    // Shadow comparisons and clinician decisions become episodes the first time anyone looks for them.
    if (!episode && rl && (run.mode?.startsWith('shadow') || run.mode === 'hitl')) { await rl.episodes.sync(); episode = await find(); }
    const evalCase = run.caseId ? await store.get('EvalCase', run.caseId) : null;
    const scribeCase = run.context?.scribeCaseId ? await store.get('ScribeBenchmarkCase', run.context.scribeCaseId) : null;

    const cache = new Map();
    async function versionOf(ref, versionId, branch) {
      const key = `${ref}@${versionId ?? ''}@${branch}`;
      if (!cache.has(key)) {
        const [type, id] = ref.split('/');
        let doc = null;
        try {
          const versions = await store.history(type, id, { branch });
          doc = versions.find((v) => String(v.meta.versionId) === String(versionId)) ?? versions.at(-1) ?? null;
        } catch { doc = null; }
        cache.set(key, doc);
      }
      return cache.get(key);
    }

    // Verifier results belong to the step that wrote the record they point at.
    const checks = episode?.outcome?.raw?.checks ?? null;
    const byRef = new Map();
    const loose = [];
    for (const c of checks || []) {
      const row = { id: c.id, label: c.label, pass: c.pass, forbidden: Boolean(c.forbidden) };
      if (c.evidence?.length) for (const ref of c.evidence) { if (!byRef.has(ref)) byRef.set(ref, []); byRef.get(ref).push(row); } else loose.push(row);
    }

    let split = null; let humanPath = null;
    if (run.mode?.startsWith('shadow') && !run.caseId) {
      const mine = (await shadowReport(store, { agentId: run.agentId, version: run.version })).agents.flatMap((g) => g.cases).find((c) => c.runId === run.id);
      if (mine?.path?.split) split = mine.path.split;
      if (mine?.path?.humanSteps) humanPath = { steps: mine.path.humanSteps, outcome: mine.outcome };
    }

    const out = [];
    let previous = Date.parse(run.startedAt);
    const pinned = new Set();
    for (const [i, s] of steps.entries()) {
      const branch = s.saw.branch || run.branch;
      const refs = s.saw.resources || [];
      const saw = [];
      for (const r of refs.slice(0, 25)) {
        if (!/^[A-Za-z]+\/[A-Za-z0-9\-.]+$/.test(r.ref)) continue;
        const doc = await versionOf(r.ref, r.versionId, branch);
        saw.push(doc ? { ref: r.ref, ...summarise(doc) } : { ref: r.ref, kind: NAMES[r.ref.split('/')[0]] || r.ref.split('/')[0], name: r.ref, value: '' });
      }
      const args = s.did.args || {};
      let wrote = null;
      if (['fhir.create', 'fhir.update', 'fhir.transition'].includes(s.did.type) && args.type && args.id) {
        const ref = `${args.type}/${args.id}`;
        const versions = await store.history(args.type, args.id, { branch }).catch(() => []);
        // The version this step produced is the one recorded at (or just before) the step.
        const doc = versions.filter((v) => v._recordedAt <= s.when.wall).at(-1) ?? versions[0] ?? null;
        if (doc) wrote = { ref, ...summarise(doc), lines: written(doc), resource: stripInternal(doc) };
      }
      const mine = wrote && byRef.has(wrote.ref) && !pinned.has(wrote.ref) && s.did.type === 'fhir.create' ? byRef.get(wrote.ref) : [];
      if (mine.length) pinned.add(wrote.ref);
      const wall = Date.parse(s.when.wall);
      out.push({
        id: s.id, n: i + 1, source: s.source, who: s.who, type: s.did.type, args, tone: tone(s), wall: s.when.wall, elapsedMs: Math.max(0, wall - previous), sinceStartMs: Math.max(0, wall - Date.parse(run.startedAt)),
        saw: { asOf: s.saw.asOf, branch, resources: saw, more: Math.max(0, refs.length - saw.length), ablated: args.ablated ?? null },
        wrote, why: s.why ?? null, contentId: args.contentId ?? null, checks: mine, split: Boolean(split && split.agentStepId === s.id),
      });
      previous = wall;
    }
    // A recording's think-aloud and "why?" text lives outside the log; fetch what is still stored (this read is itself logged).
    if (capture && run.mode === 'capture' && ctx.actor.kind === 'human' && out.some((s) => s.contentId)) {
      try {
        const detail = await capture.detail(run.id, ctx, { withText: true });
        const text = new Map(detail.content.map((c) => [c.id, c.text]));
        for (const s of out) if (s.contentId) s.why = text.get(s.contentId) ?? '(this note has been deleted)';
      } catch { /* content policy may refuse; the reference stays */ }
    }
    const score = checks ? verifierScore(checks) : null;
    const context = evalCase ? { kind: 'case', title: evalCase.title, scenario: evalCase.scenario, task: evalCase.task, split: evalCase.split }
      : scribeCase ? { kind: 'scribe', title: scribeCase.title, scenario: `${scribeCase.encounterType} encounter. The agent reads the transcript and the chart, then writes the note.`, task: run.goal, split: scribeCase.split }
        : { kind: run.mode, title: run.goal || 'Run', scenario: run.subject ? `Working on ${run.subject}.` : '', task: run.goal || '', split: null };
    return {
      run: withStatus(run), context, steps: out, episode: episode ? { id: episode.id, kind: episode.kind, split: episode.split } : null,
      outcome: { checks: (checks || []).map((c) => ({ id: c.id, label: c.label, pass: c.pass, forbidden: Boolean(c.forbidden), pinned: (c.evidence || []).some((r) => pinned.has(r)) })), unpinned: loose, score: score?.score ?? null },
      horizons: episode?.outcome?.horizons ?? [], split, humanPath,
    };
  }

  async function handle(req, url, body, ctx, parts) {
    if (parts[0] !== 'trace-view' || parts.length !== 2 || req.method !== 'GET') return null;
    return { status: 200, body: await view(parts[1], ctx) };
  }
  return { handle, view };
}
