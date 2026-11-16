// Capabilities and benchmark conditions (plan-master task 8.4 to 8.6).
// A run stores the exact list of capabilities switched on. The baseline is
// how hospitals deploy AI today: set off by a workflow event, a draft placed
// where the clinician works, approved by the clinician's normal action. The
// research capabilities let an agent ask, chain steps, take on whole tasks,
// raise alerts, work across apps and continue across timeline events. The
// server refuses a research capability that is not switched on, and nothing
// an agent produces becomes final without the matching human action.
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../platform/server/http.mjs';
import { EnvelopeError } from './envelope.mjs';
import { recordAction } from '../../platform/server/audit.mjs';

/** Deployed today: trigger, where the output appears, and the human action that approves it. */
export const BASELINE = [
  { id: 'draft-reply', trigger: 'patient-message', where: 'the reply box: "Start with draft" or "Start blank reply"', kind: 'triage', finalType: 'Communication', approvedBy: 'the clinician edits and sends, or discards', humanAction: 'proposal.accept|proposal.edit' },
  { id: 'chart-summary', trigger: 'chart-open', where: 'a read-only Summary card in the chart', kind: 'summary', finalType: null, approvedBy: 'nothing to approve; thumbs up or down', humanAction: null },
  { id: 'ambient-note', trigger: 'recording-stop', where: 'a draft note in the Notes tab, uncertain parts marked "Check this"', kind: 'note', finalType: 'DocumentReference', approvedBy: 'the clinician edits and signs', humanAction: 'proposal.accept|proposal.edit' },
  { id: 'queue-orders', trigger: 'recording-stop', where: 'a "Queued orders" list in Orders', kind: 'order', finalType: 'ServiceRequest', approvedBy: 'the clinician signs or removes each', humanAction: 'proposal.accept|proposal.edit' },
  { id: 'chart-chat', trigger: 'question', where: 'the Agent panel chat', kind: 'answer', finalType: null, approvedBy: 'nothing to approve; answers cite the records they used', humanAction: null },
  { id: 'draft-report', trigger: 'study-open', where: 'inside the reporting template as an AI draft', kind: 'report', finalType: 'DiagnosticReport', approvedBy: 'the radiologist edits and signs', humanAction: 'proposal.accept|proposal.edit' },
];
export const RESEARCH = [
  { id: 'agent-may-ask', adds: 'the agent can send permission requests, questions, low-confidence and stuck messages, and waits for a reply or a time-out' },
  { id: 'multi-step', adds: 'the agent may chain several tool calls in one turn before handing back' },
  { id: 'autonomous-task', adds: 'the agent works through an assigned task from start to finish without per-step approval, on its branch' },
  { id: 'proactive-alerts', adds: 'the agent may raise its own alert when a timeline event looks dangerous' },
  { id: 'cross-app', adds: 'the agent may use PACS, Lab and Pharmacy tools as well as the EHR' },
  { id: 'long-horizon', adds: 'the run continues across timeline events and outcome horizons' },
];
export const CAPABILITY_IDS = [...BASELINE, ...RESEARCH].map((c) => c.id);
export const BASELINE_IDS = BASELINE.map((c) => c.id);
export const CLOCKS = ['real', 'step'];
export const DEFAULT_ASK_TIMEOUT_MS = 5 * 60 * 1000;

/** The three shipped conditions. Researchers can add their own. */
export const BUILTIN_CONDITIONS = [
  { id: 'deployed-today', name: 'Deployed today', capabilities: BASELINE_IDS, clock: 'real', branch: false, builtin: true, description: 'The six baseline capabilities on a real-time clock.' },
  { id: 'helper-that-asks', name: 'Helper that asks', capabilities: [...BASELINE_IDS, 'agent-may-ask', 'multi-step'], clock: 'real', branch: false, builtin: true, description: 'The baseline, plus the agent may ask and chain steps.' },
  { id: 'autonomous', name: 'Autonomous', capabilities: ['autonomous-task', 'multi-step', 'cross-app', 'long-horizon'], clock: 'step', branch: true, builtin: true, description: 'The agent takes the task from start to finish on its own branch, on a step clock.' },
];

// Which resource types each app owns. The EHR set is always available; the others need cross-app or the capability that works there.
const EHR_TYPES = new Set(['Patient', 'Encounter', 'Condition', 'AllergyIntolerance', 'MedicationRequest', 'MedicationStatement', 'Observation', 'DocumentReference', 'Communication', 'Task', 'ServiceRequest', 'Procedure', 'Flag', 'CarePlan', 'Provenance', 'DiagnosticReport', 'Appointment', 'Immunization', 'Device', 'Goal']);
const OTHER_APPS = new Set(['ImagingStudy', 'Specimen', 'MedicationDispense', 'MedicationAdministration', 'Location', 'Media', 'BodyStructure']);
const CAP_TYPES = { 'draft-report': ['ImagingStudy'] };

const SLUG = /^[a-z0-9][a-z0-9-]{1,48}$/;

export const hasCap = (run, id) => Array.isArray(run?.capabilities) && run.capabilities.includes(id);
/** Throws when a run tries to use a research capability it does not have. Runs from before conditions existed (no list) are not limited. */
export function assertCap(run, id, what = id) {
  if (!Array.isArray(run?.capabilities)) return;
  if (!run.capabilities.includes(id)) throw new EnvelopeError(403, 'capability-off', `${what} needs the "${id}" capability, which is not switched on for this run (condition: ${run.condition || 'custom'})`);
}
/** Resource types this run may read or write through the tools. */
export function allowedTypes(run) {
  if (!Array.isArray(run?.capabilities)) return null;
  const out = new Set(EHR_TYPES);
  for (const cap of run.capabilities) for (const t of CAP_TYPES[cap] || []) out.add(t);
  if (run.capabilities.includes('cross-app')) for (const t of OTHER_APPS) out.add(t);
  return out;
}
export function assertType(run, type, verb = 'use') {
  const allowed = allowedTypes(run);
  if (!allowed || allowed.has(type)) return;
  throw new EnvelopeError(403, 'capability-off', `${verb} ${type} needs the "cross-app" capability (PACS, Lab and Pharmacy records), which is not switched on for this run`);
}

/** The named tools in a briefing, limited to what the run may do. */
export function toolsFor(run) {
  const allowed = allowedTypes(run);
  const types = allowed ? [...allowed].sort() : ['any'];
  const caps = Array.isArray(run?.capabilities) ? run.capabilities : CAPABILITY_IDS;
  const list = [
    { name: 'read', description: 'Read one record as the run sees it', allowedResourceTypes: types },
    { name: 'search', description: 'Search records of one type', allowedResourceTypes: types },
    { name: 'create', description: 'Write a draft record on the run branch; it stays unsigned', allowedResourceTypes: types.filter((t) => t !== 'Patient') },
    { name: 'update', description: 'Update a draft record on the run branch', allowedResourceTypes: types.filter((t) => t !== 'Patient') },
    ...(caps.includes('draft-report') ? [{ name: 'view-image', description: 'Note that an image was looked at (no pixels are analysed)', allowedResourceTypes: ['ImagingStudy'] }] : []),
    ...(caps.includes('ambient-note') ? [{ name: 'draft-note', description: 'Draft a clinical note for the clinician to edit and sign', allowedResourceTypes: ['DocumentReference'] }] : []),
    ...(caps.includes('draft-reply') ? [{ name: 'draft-reply', description: 'Draft a reply to a patient message for the clinician to edit and send', allowedResourceTypes: ['Task'] }] : []),
    ...(caps.includes('queue-orders') || caps.includes('autonomous-task') ? [{ name: 'propose-order', description: 'Queue an order for the clinician to sign or remove', allowedResourceTypes: ['ServiceRequest', 'MedicationRequest'] }] : []),
    ...(caps.includes('agent-may-ask') ? [{ name: 'ask-clinician', description: 'Ask for permission (with the exact action), ask a question, or say you are unsure or stuck, then wait', allowedResourceTypes: [] }] : []),
    ...(caps.includes('proactive-alerts') ? [{ name: 'raise-alert', description: 'Raise an alert for the care team when something looks dangerous', allowedResourceTypes: ['Flag'] }] : []),
    { name: 'finish', description: 'Hand back with a short summary', allowedResourceTypes: [] },
  ];
  return list;
}

/** The approval rule text for a briefing: what needs a human, per capability. */
export function approvalFor(run) {
  const caps = Array.isArray(run?.capabilities) ? run.capabilities : CAPABILITY_IDS;
  const rules = BASELINE.filter((c) => caps.includes(c.id)).map((c) => `${c.id}: ${c.approvedBy}`);
  const ask = caps.includes('agent-may-ask') ? `ask before: ${run?.askFrequency === 'every-step' ? 'every step' : run?.askFrequency === 'low-confidence' ? 'anything you are unsure about' : 'orders, signing and anything sent to a patient'}` : 'you cannot ask; hand back a draft instead';
  return `Nothing you produce becomes final, released, sent or placed without a human. ${rules.join('; ')}${rules.length ? '. ' : ''}${ask}.${caps.includes('autonomous-task') ? ' Your writes stay on your own branch, never the live chart.' : ''}`;
}

/** The one JSON briefing every agent turn receives (plan-master 8.2). */
export function briefingFor({ trigger, run, agent, task = null, conversation = [] }) {
  return {
    trigger: { kind: trigger.kind, ...(trigger.event ? { event: trigger.event } : {}), ...(trigger.question ? { question: trigger.question } : {}), ...(trigger.task ? { task: trigger.task } : {}), at: trigger.at },
    task: task ? { scenario: task.scenario ?? null, goal: task.goal ?? run.goal ?? null, doneWhen: task.doneWhen ?? null, mustNot: task.mustNot ?? null, timeLimit: task.timeLimit ?? (agent?.limits?.timeoutMs ? `${agent.limits.timeoutMs} ms` : null) } : null,
    patient: run.patientRef || (String(run.subject || '').startsWith('Patient/') ? run.subject : null),
    subject: run.subject || null,
    asOf: run.asOf || null,
    branch: run.branch,
    capabilities: Array.isArray(run.capabilities) ? run.capabilities : BASELINE_IDS,
    condition: run.condition || null,
    tools: toolsFor(run),
    approval: approvalFor(run),
    conversation: conversation.map((m) => ({ from: m.from, kind: m.kind, text: m.text, at: m.at })),
  };
}

/** Validates a condition body (for custom conditions). */
export function normalizeCondition(input, existing = null) {
  if (!input || typeof input !== 'object') throw new HttpError(422, 'A condition object is required');
  const id = existing?.id ?? (typeof input.id === 'string' && input.id ? input.id : String(input.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48));
  if (!SLUG.test(id)) throw new HttpError(422, 'A condition needs a name of letters, digits and dashes');
  if (BUILTIN_CONDITIONS.some((c) => c.id === id)) throw new HttpError(409, `"${id}" is a built-in condition and cannot be changed`);
  const name = String(input.name || existing?.name || id).trim().slice(0, 80);
  if (!name) throw new HttpError(422, 'A condition needs a name');
  const capabilities = Array.isArray(input.capabilities) ? [...new Set(input.capabilities.map(String))] : existing?.capabilities ?? [];
  const bad = capabilities.filter((c) => !CAPABILITY_IDS.includes(c));
  if (bad.length) throw new HttpError(422, `Unknown capabilities: ${bad.join(', ')}. Choose from ${CAPABILITY_IDS.join(', ')}`);
  const clock = input.clock ?? existing?.clock ?? 'real';
  if (!CLOCKS.includes(clock)) throw new HttpError(422, `clock must be one of ${CLOCKS.join(', ')}`);
  return { resourceType: 'BenchCondition', id, name, capabilities, clock, branch: Boolean(input.branch ?? existing?.branch ?? capabilities.includes('autonomous-task')), description: String(input.description || existing?.description || '').slice(0, 300), builtin: false };
}

export async function listConditions(store) {
  const custom = (await store.query('BenchCondition')).filter((c) => Array.isArray(c.capabilities) && !c.builtin);
  return [...BUILTIN_CONDITIONS, ...custom.sort((a, b) => a.name.localeCompare(b.name))];
}
/** Works with the store or a transaction (never call the store from inside a transaction). */
export async function findCondition(reader, id) {
  return BUILTIN_CONDITIONS.find((c) => c.id === id) || (await reader.query('BenchCondition')).find((c) => c.id === id && Array.isArray(c.capabilities)) || null;
}

/**
 * Resolves what a new run is allowed to do from its input: a condition id,
 * an explicit capability list, or nothing (deployed today). Returns the
 * fields to store on the Run.
 */
export async function resolveCondition(store, input = {}) {
  let condition = null;
  if (input.condition != null) {
    condition = await findCondition(store, String(input.condition));
    if (!condition) throw new HttpError(422, `Unknown condition "${input.condition}"`);
  }
  let capabilities = condition ? [...condition.capabilities] : input.capabilities != null ? [...new Set([].concat(input.capabilities).map(String))] : [...BASELINE_IDS];
  const bad = capabilities.filter((c) => !CAPABILITY_IDS.includes(c));
  if (bad.length) throw new HttpError(422, `Unknown capabilities: ${bad.join(', ')}`);
  if (input.capabilities != null && condition) capabilities = [...new Set([...capabilities, ...[].concat(input.capabilities).map(String)])];
  const clock = input.clock ?? condition?.clock ?? 'real';
  if (!CLOCKS.includes(clock)) throw new HttpError(422, `clock must be one of ${CLOCKS.join(', ')}`);
  const askTimeoutMs = input.askTimeoutMs == null ? DEFAULT_ASK_TIMEOUT_MS : Number(input.askTimeoutMs);
  if (!(askTimeoutMs >= 100 && askTimeoutMs <= 24 * 3600 * 1000)) throw new HttpError(422, 'askTimeoutMs must be between 100 and 86400000');
  return { condition: condition ? condition.id : (input.capabilities != null ? 'custom' : 'deployed-today'), capabilities, clock, askTimeoutMs };
}

/** Routes: GET /agent-ops/conditions, POST (new custom), PUT /:id, DELETE /:id, GET /agent-ops/capabilities. */
export function createConditionsApi({ store }) {
  async function handle(req, url, body, ctx, parts) {
    const [area, id] = parts;
    const method = req.method;
    if (area === 'capabilities' && parts.length === 1 && method === 'GET') return { status: 200, body: { baseline: BASELINE, research: RESEARCH, clocks: CLOCKS } };
    if (area !== 'conditions') return null;
    if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Agents may not read or change conditions');
    if (parts.length === 1 && method === 'GET') return { status: 200, body: { conditions: await listConditions(store) } };
    if (parts.length === 2 && method === 'GET') { const c = await findCondition(store, id); if (!c) throw new HttpError(404, `No condition "${id}"`); return { status: 200, body: c }; }
    if ((parts.length === 1 && method === 'POST') || (parts.length === 2 && method === 'PUT')) {
      const saved = await store.transaction(async (tx) => {
        const existing = parts.length === 2 ? await findCondition(tx, id) : null;
        if (parts.length === 2 && !existing) throw new HttpError(404, `No condition "${id}"`);
        if (existing?.builtin) throw new HttpError(409, 'Built-in conditions cannot be changed. Make a new one instead');
        const doc = normalizeCondition(body, existing);
        if (!existing && await findCondition(tx, doc.id)) throw new HttpError(409, `A condition "${doc.id}" already exists`);
        const out = await tx.save('BenchCondition', doc, { updatedBy: ctx.actor.role });
        await recordAction(tx, { actor: ctx.actor, kind: existing ? 'update' : 'create', action: existing ? 'condition.update' : 'condition.create', args: { condition: out.id, capabilities: out.capabilities, clock: out.clock }, entityRef: `BenchCondition/${out.id}`, versionId: out.meta?.versionId, description: `condition ${existing ? 'updated' : 'created'}: ${out.name}` });
        return out;
      });
      return { status: parts.length === 1 ? 201 : 200, body: saved };
    }
    return null;
  }
  return { handle };
}

const clean = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
/** An optional timeline on a case or run (8.3): events released at their times, never early. */
export function normalizeTimeline(list) {
  if (list == null) return null;
  if (!Array.isArray(list) || list.length > 50) throw new HttpError(422, 'timeline must be a list of at most 50 events');
  return list.map((e, i) => {
    if (!e || typeof e !== 'object') throw new HttpError(422, `timeline[${i}] must be an object`);
    const after = Number(e.after);
    if (!(after >= 0 && after <= 365 * 86400)) throw new HttpError(422, `timeline[${i}].after must be seconds from the start (0 to one year)`);
    const kind = e.kind || (e.resource ? 'resource' : 'check');
    if (!['resource', 'check', 'message', 'observation'].includes(kind)) throw new HttpError(422, `timeline[${i}].kind must be resource, observation, message or check`);
    if (kind !== 'check' && (!e.resource || typeof e.resource !== 'object' || !e.resource.resourceType)) throw new HttpError(422, `timeline[${i}] needs a resource`);
    return { id: e.id || `t${i + 1}`, after, kind, title: clean(e.title, 120) || null, resource: e.resource ?? null, goal: clean(e.goal, 300) || null };
  });
}

/** The run's copy of a timeline, with absolute release times. */
export const timelineForRun = (timeline, startedAt) => (timeline || []).map((e) => ({ ...e, at: new Date(Date.parse(startedAt) + e.after * 1000).toISOString(), releasedAt: null }));
export const newId = () => randomUUID();
