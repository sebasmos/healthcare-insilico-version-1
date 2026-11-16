// Agent registry, the provider-neutral execution loop, the two rule-based
// reference agents, kill switches and the shadow triggers (§9a, §9b, §17c).
//
// Agents never touch the store directly. Every tool call is a real HTTP
// request to this server's own FHIR API on the loopback interface, carrying
// X-Agent-Id, X-Run-Id, Idempotency-Key and X-Reasoning, so the safety
// envelope and the log treat built-in stubs and external agents identically.
import { createHash, randomUUID } from 'node:crypto';
import { normalizeEndpoint, isLocalUrl, chat as chatEndpoint } from './models/endpoints.mjs';
import { promptHash } from './models/adapters.mjs';
import { runReferenceHarness, HARNESS } from './harness.mjs';
import { readFeatures, featureForCapability } from './ai-features.mjs';
import { normalizePermissions, narrowTo, BUILTIN_PERMISSIONS, CONNECTIONS } from './permissions.mjs';
const HARNESS_DEFAULT_SCOPES = ['ServiceRequest', 'MedicationRequest', 'Condition', 'DocumentReference', 'Task', 'Communication', 'DiagnosticReport'].map((type) => ({ type, interactions: ['create', 'update'] }));
import { HttpError, INTERNAL_AGENT_HEADER, INTERNAL_AGENT_TOKEN } from '../../platform/server/http.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';
import { createRun, endRun, withStatus, MODES, ASK_FREQUENCIES } from './runs.mjs';
import { evaluateGate, promote, demote, gateConfig, setGateConfig, isPromoted } from './promotion.mjs';
import { validateScopes, engagedSwitch, listSwitches, switchId, KILL_SCOPES } from './envelope.mjs';
import { shadowReport } from './shadow.mjs';
import { isSyntheticPatient } from './hitl.mjs';
import { briefingFor, hasCap } from './capabilities.mjs';
import { briefingAge } from '../../ehr/server/age.mjs';
import { chartSummariser, maybeAsk, UNRULED_SYMPTOMS, CHECK_MARK, queuedOrdersFrom } from './deployed-stubs.mjs';
import { answerQuestion } from './turns.mjs';
import { ADAPTERS as MODEL_ADAPTERS, TEMPLATES as MODEL_TEMPLATES, availability as modelAvailability, templateHash } from './models/index.mjs';

export const TASK_SYSTEM = 'urn:hospital-desktop:task';
export const TRIAGE_LABELS = ['urgent', 'routine', 'low'];
const AGENT_MODES = ['shadow-event', 'shadow-task', 'hitl', 'sandbox'];
const ID = /^[a-z0-9][a-z0-9-]{1,48}$/;

// ---------- Rule sets for the reference stubs (hashed into policyHash) ----------
export const REPORT_RULES = {
  cues: ['nodule', 'mass', 'fracture', 'pneumonia', 'effusion', 'pneumothorax', 'opacity', 'consolidation', 'follow-up', 'follow up', 'lesion'],
  critical: ['pneumothorax'],
  note: 'Draft from study metadata and chart context only. Pixel data was not analysed by this rule-based stub.',
  identityChecks: ['dicom-patient-id-matches-chart', 'workstation-context-matches-subject'],
  gapChecks: { missingPriors: 'the request refers to earlier imaging (follow-up, known, previous, interval, compare) but the chart has no earlier study or report' },
};
export const TRIAGE_RULES = {
  urgent: ['chest pain', 'short of breath', 'shortness of breath', "can't breathe", 'cannot breathe', 'bleeding', 'fainted', 'passed out', 'suicid', 'severe', 'swelling of my face', 'allergic reaction', 'worst headache'],
  low: ['thank you', 'thanks', 'no longer need', 'just confirming', 'appointment reminder'],
  identityChecks: ['workstation-context-matches-subject'],
  medicationChecks: { allergyConflict: 'same drug on the active medication list and the allergy list', unsafeDoseFactor: 10 },
  escalation: 'Thank you for your message. Please do not change how you take your medication for now. A member of the care team will review your record and contact you today.',
  replies: {
    urgent: 'Thank you for your message. Your symptoms may need prompt attention. If this is an emergency, call your local emergency number now. A member of the care team will contact you today.',
    routine: 'Thank you for your message. A member of the care team will review it and reply within two business days.',
    low: 'Thank you for letting us know. No further action is needed from you.',
  },
};
// Workup Planner: a table of "if the chart shows this, do that". It exists so the
// training-data pipeline has something to run; it is not clinical guidance.
// Codes are an unverified starter set (see ehr/server/catalog.mjs).
export const WORKUP_RULES = {
  exploration: 0.3,
  plausible: { '8867-4': [20, 250], '8480-6': [40, 300], '8310-5': [30, 43], '59408-5': [50, 100], '2823-3': [1.5, 9.5], '2160-0': [0.1, 20], '2345-7': [10, 1500], '718-7': [2, 25], '2524-7': [0.1, 30], '1963-8': [2, 50] },
  gapChecks: { noResults: 'an emergency patient with no laboratory results at all', inconsistent: 'potassium below 3.5 with peaked T waves on the ECG' },
  note: 'Keyword and threshold rules over vitals, labs and the reason for the visit. With a non-zero seed it sometimes skips a step or adds an unhelpful one, so repeated attempts differ.',
  rules: [
    { id: 'pe', label: 'possible pulmonary embolism', when: 'short of breath + heart rate > 100 + oxygen saturation < 94', actions: [['order', 'LOCAL:ct-pulmonary-angiogram', 'CT pulmonary angiography', 'imaging'], ['prescribe', 'RxNorm:5224', 'Heparin'], ['diagnose', 'ICD-10:I26.99', 'Pulmonary embolism']] },
    { id: 'sepsis', label: 'possible sepsis', when: 'temperature > 38.3 + lactate > 2', actions: [['order', 'LOINC:600-7', 'Blood cultures', 'laboratory'], ['order', 'LOINC:2524-7', 'Lactate', 'laboratory'], ['prescribe', 'RxNorm:2193', 'Ceftriaxone'], ['prescribe', 'RxNorm:9863', 'Sodium chloride 0.9%'], ['diagnose', 'ICD-10:A41.9', 'Sepsis']] },
    { id: 'dka', label: 'diabetic ketoacidosis', when: 'glucose > 250 + bicarbonate < 18', actions: [['prescribe', 'RxNorm:5856', 'Insulin'], ['prescribe', 'RxNorm:9863', 'Sodium chloride 0.9%'], ['order', 'LOINC:51990-0', 'Basic metabolic panel', 'laboratory'], ['diagnose', 'ICD-10:E10.10', 'Diabetic ketoacidosis']] },
    { id: 'stemi', label: 'ST-elevation myocardial infarction', when: 'ECG mentions ST elevation', actions: [['order', 'LOCAL:cath-lab-activation', 'Cardiac catheterisation lab activation', 'procedure'], ['prescribe', 'RxNorm:1191', 'Aspirin'], ['prescribe', 'RxNorm:5224', 'Heparin'], ['diagnose', 'ICD-10:I21.3', 'ST-elevation myocardial infarction']] },
    { id: 'htn', label: 'hypertensive urgency', when: 'systolic pressure >= 180', actions: [['prescribe', 'RxNorm:17767', 'Amlodipine'], ['order', 'LOINC:51990-0', 'Basic metabolic panel', 'laboratory'], ['diagnose', 'ICD-10:I16.0', 'Hypertensive urgency']] },
    { id: 'pneumonia', label: 'pneumonia', when: 'cough + consolidation on chest X-ray', actions: [['prescribe', 'RxNorm:3640', 'Doxycycline'], ['diagnose', 'ICD-10:J18.9', 'Pneumonia']] },
    { id: 'hyperk', label: 'severe hyperkalaemia', when: 'potassium > 6', actions: [['prescribe', 'RxNorm:1908', 'Calcium gluconate'], ['prescribe', 'RxNorm:5856', 'Insulin'], ['prescribe', 'RxNorm:4850', 'Dextrose'], ['order', 'LOINC:2823-3', 'Potassium', 'laboratory'], ['diagnose', 'ICD-10:E87.5', 'Hyperkalaemia']] },
    { id: 'aki', label: 'acute kidney injury', when: 'creatinine > 2 + potassium <= 6', actions: [['order', 'LOINC:24558-9', 'US Abdomen', 'imaging'], ['order', 'LOINC:51990-0', 'Basic metabolic panel', 'laboratory'], ['prescribe', 'RxNorm:9863', 'Sodium chloride 0.9%'], ['diagnose', 'ICD-10:N17.9', 'Acute kidney injury']] },
    { id: 'gi-bleed', label: 'upper gastrointestinal bleed', when: 'vomiting blood or black stools + haemoglobin < 8', actions: [['prescribe', 'RxNorm:40790', 'Pantoprazole'], ['order', 'LOCAL:type-and-crossmatch', 'Type and crossmatch', 'laboratory'], ['order', 'LOCAL:upper-endoscopy', 'Upper endoscopy', 'procedure'], ['diagnose', 'ICD-10:K92.2', 'Gastrointestinal haemorrhage']] },
    { id: 'chest-pain', label: 'chest pain, low-risk first results', when: 'chest pain or tightness + no ST elevation + troponin < 0.04', actions: [['order', 'LOINC:10839-9', 'Troponin I', 'laboratory'], ['order', 'LOINC:11524-6', 'EKG study', 'procedure'], ['prescribe', 'RxNorm:1191', 'Aspirin'], ['diagnose', 'ICD-10:R07.9', 'Chest pain']] },
  ],
  distractors: [['prescribe', 'RxNorm:5640', 'Ibuprofen'], ['order', 'LOINC:24725-4', 'CT Head', 'imaging'], ['prescribe', 'RxNorm:723', 'Amoxicillin'], ['prescribe', 'RxNorm:8591', 'Potassium chloride'], ['order', 'LOCAL:cath-lab-activation', 'Cardiac catheterisation lab activation', 'procedure'], ['prescribe', 'RxNorm:5224', 'Heparin']],
};
const CODE_SYSTEMS = { LOINC: 'http://loinc.org', RxNorm: 'http://www.nlm.nih.gov/research/umls/rxnorm', 'ICD-10': 'http://hl7.org/fhir/sid/icd-10-cm', LOCAL: 'urn:hospital-desktop:order' };
/** Small seeded generator, so an attempt can be replayed exactly from its seed. */
export function seeded(seed) {
  let a = (Number(seed) || 0) >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Ambient Scribe: sorts transcript sentences into note sections by cue words, lists diagnoses from a keyword table and adds
// the chart's current medications. It does not understand negation, and it adds a stock follow-up line when it hears none.
export const SCRIBE_RULES = {
  objective: /\b(on examination|examination|blood pressure|pulse|temperature|oxygen|ecg|x-ray|i can (still )?hear|weight is|was completed|i found|there was)\b/i,
  assessment: /\b(i think|this is|consistent with|likely|diagnos|admitted with)\b/i,
  plan: /\b(i will|we will|i\'ll|we\'ll|start|prescribe|order|come back|follow-up|follow up|refer|continue|stop|can return|go home)\b/i,
  diagnoses: [
    [/hypertension|high blood pressure/i, 'I10', 'Hypertension'], [/chest pain/i, 'R07.9', 'Chest pain'], [/pneumonia/i, 'J18.9', 'Pneumonia'], [/pneumothorax/i, 'J93.9', 'Pneumothorax'],
    [/heart failure/i, 'I50.9', 'Heart failure'], [/polyp/i, 'K63.5', 'Polyp of colon'], [/acute coronary syndrome|unstable angina/i, 'I20.0', 'Acute coronary syndrome'],
  ],
  defaultFollowUp: 'Follow-up in 2 weeks.',
};

const hashOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

export const REFERENCE_AGENTS = [
  {
    id: 'report-drafter', name: 'Report Drafter', version: '1.2.0', capability: 'draft-report',
    description: 'Reads an imaging study and its chart context, then drafts a preliminary report for a radiologist to review.',
    scopes: [{ type: 'DiagnosticReport', interactions: ['create', 'update'] }],
    adapter: { kind: 'stub', stub: 'report-drafter' }, policyHash: hashOf(REPORT_RULES),
    actionSchema: { input: 'ImagingStudy', output: 'DiagnosticReport (status preliminary)', tools: ['read', 'search', 'create', 'update'] },
    shadow: { event: false, task: true }, limits: { maxSteps: 20, timeoutMs: 30000 }, triggers: { 'study-open': 'draft-report', task: 'draft-report', question: 'chart-chat' },
    knownLimits: 'Rule-based. Does not look at images. Uses the indication, order and prior reports only.',
  },
  {
    id: 'inbox-triager', name: 'Inbox Triager', version: '1.1.0', capability: 'triage-message',
    description: 'Reads a patient message, labels its priority and suggests a reply for the care team.',
    scopes: [{ type: 'Task', interactions: ['create'] }],
    adapter: { kind: 'stub', stub: 'inbox-triager' }, policyHash: hashOf(TRIAGE_RULES),
    actionSchema: { input: 'Communication', output: 'Task (code message-triage, priority label, suggested reply)', tools: ['read', 'search', 'create'] },
    shadow: { event: true, task: false }, limits: { maxSteps: 20, timeoutMs: 30000 }, triggers: { 'patient-message': 'draft-reply', question: 'chart-chat' },
    knownLimits: 'Rule-based keyword matching. Does not understand context or negation.',
  },
  {
    id: 'workup-planner', name: 'Workup Planner', version: '1.1.0', capability: 'clinical-workup',
    description: 'Reads an emergency patient\'s vitals, results and reason for visit, then places orders, prescriptions and a working diagnosis from a rule table.',
    scopes: [{ type: 'ServiceRequest', interactions: ['create'] }, { type: 'MedicationRequest', interactions: ['create'] }, { type: 'Condition', interactions: ['create'] }],
    adapter: { kind: 'stub', stub: 'workup-planner' }, policyHash: hashOf(WORKUP_RULES),
    actionSchema: { input: 'Patient', output: 'ServiceRequest, MedicationRequest (draft), Condition (provisional)', tools: ['read', 'search', 'create'] },
    shadow: { event: false, task: false }, limits: { maxSteps: 40, timeoutMs: 30000 }, triggers: { task: 'autonomous-task', 'scheduled-check': 'autonomous-task', question: 'chart-chat' },
    knownLimits: 'Rule table for ten acute presentations. Not clinical guidance. It exists to exercise the training-data pipeline, and deliberately varies its plan between attempts.',
  },
  {
    id: 'note-scribe', name: 'Ambient Scribe', version: '1.0.0', capability: 'scribe-note',
    description: 'Reads an encounter transcript and the chart, then drafts the structured note for a clinician to review and sign.',
    scopes: [{ type: 'DocumentReference', interactions: ['create'] }, { type: 'ServiceRequest', interactions: ['create'] }],
    adapter: { kind: 'stub', stub: 'note-scribe' }, policyHash: hashOf({ ...SCRIBE_RULES, objective: String(SCRIBE_RULES.objective), assessment: String(SCRIBE_RULES.assessment), plan: String(SCRIBE_RULES.plan), diagnoses: SCRIBE_RULES.diagnoses.map(([p, c]) => [String(p), c]) }),
    actionSchema: { input: 'Patient, with a transcript DocumentReference in the run context', output: 'DocumentReference (docStatus preliminary)', tools: ['read', 'search', 'create'] },
    shadow: { event: false, task: false }, limits: { maxSteps: 30, timeoutMs: 30000 }, triggers: { 'recording-stop': 'ambient-note', task: 'ambient-note', question: 'chart-chat' },
    knownLimits: 'Rule-based. Sorts sentences by cue words. Does not understand negation, so a finding that was ruled out can be listed as a diagnosis. Adds a stock follow-up line when it hears none. It exists to exercise the scribe benchmark.',
  },
  {
    id: 'chart-summariser', name: 'Chart Summariser', version: '1.0.0', capability: 'chart-summary',
    description: 'Reads the chart when it is opened and writes a read-only summary card that cites every record it used.',
    scopes: [{ type: 'DocumentReference', interactions: ['create'] }],
    adapter: { kind: 'stub', stub: 'chart-summariser' }, policyHash: hashOf({ stub: 'chart-summariser', version: '1.0.0' }),
    actionSchema: { input: 'Patient', output: 'DocumentReference (type ai-summary, docStatus preliminary), citing records', tools: ['read', 'search', 'create'] },
    shadow: { event: false, task: false }, limits: { maxSteps: 20, timeoutMs: 30000 }, triggers: { 'chart-open': 'chart-summary', question: 'chart-chat' },
    knownLimits: 'Lists what the chart holds. Does not weigh or interpret it, and does not give advice.',
  },
];

/** An agent as the API shows it. Fills in fields that agents registered before phase 5 do not have. */
export const presentAgent = (a) => ({ ...a, stage: a.stage ?? 'shadow', promotedVersion: a.promotedVersion ?? null, promotions: a.promotions ?? [], hitl: a.hitl ?? { auto: false, askFrequency: 'every-step' }, promoted: isPromoted(a) });

export async function ensureReferenceAgents(store) {
  for (const def of REFERENCE_AGENTS) {
    const existing = await store.get('Agent', def.id);
    if (existing) {
      // The built-in rules changed in the code: this is a new version, so it starts again in shadow and needs its own evidence.
      // A built-in agent renamed in the code takes the new name; nothing else about it changes.
      if (existing.builtIn && existing.policyHash === def.policyHash && existing.name !== def.name) { const { _seq, ...doc } = existing; await store.save('Agent', { ...doc, name: def.name }, { updatedBy: 'system' }); continue; }
      if (existing.builtIn && existing.policyHash !== def.policyHash) {
        const { _seq, ...doc } = existing;
        await store.save('Agent', { ...doc, ...def, shadow: doc.shadow ?? def.shadow, limits: doc.limits ?? def.limits, stage: 'shadow', promotedVersion: null }, { updatedBy: 'system' });
      }
      continue;
    }
    await store.save('Agent', { resourceType: 'Agent', ...def, stage: 'shadow', promotedVersion: null, promotions: [], hitl: { auto: false, askFrequency: 'every-step' }, enabled: true, builtIn: true, registeredAt: store.now() }, { updatedBy: 'system' });
  }
}

function normalizeAgent(input, existing) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Agent definition required');
  const id = existing?.id ?? input.id;
  if (typeof id !== 'string' || !ID.test(id)) throw new HttpError(422, 'Agent id must be lowercase letters, digits and dashes (2 to 49 characters)');
  const merged = { ...(existing || {}), ...input };
  if (typeof merged.name !== 'string' || !merged.name.trim()) throw new HttpError(422, 'Agent name is required');
  if (typeof merged.version !== 'string' || !/^[0-9A-Za-z.\-]{1,32}$/.test(merged.version)) throw new HttpError(422, 'Agent version is required (for example 1.0.0)');
  const adapter = merged.adapter || {};
  if (adapter.kind === 'stub') {
    if (!STUBS[adapter.stub]) throw new HttpError(422, `Unknown built-in stub "${adapter.stub}". Available: ${Object.keys(STUBS).join(', ')}`);
  } else if (adapter.kind === 'http') {
    let parsed;
    try { parsed = new URL(adapter.endpoint); } catch { throw new HttpError(422, 'adapter.endpoint must be a URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(422, 'adapter.endpoint must be http or https');
  } else if (adapter.kind === 'model') {
    // A prompt plus tools plus a model: template from the model layer, adapter stub by default.
    if (!MODEL_TEMPLATES[adapter.template]) throw new HttpError(422, `adapter.template must be one of ${Object.keys(MODEL_TEMPLATES).join(', ')}`);
    if (!MODEL_ADAPTERS.includes(adapter.model || 'stub')) throw new HttpError(422, `adapter.model must be one of ${MODEL_ADAPTERS.join(', ')}`);
    if (adapter.temperature != null && !(Number(adapter.temperature) >= 0 && Number(adapter.temperature) <= 2)) throw new HttpError(422, 'adapter.temperature must be between 0 and 2');
    if (!merged.scopes?.length) merged.scopes = MODEL_TEMPLATES[adapter.template].scopes;
    if (!input.capability && !existing) merged.capability = MODEL_TEMPLATES[adapter.template].capability;
  } else if (adapter.kind === 'harness') {
    // Their model, our thin reference harness (part 1.2).
    Object.assign(adapter, normalizeEndpoint(adapter));
    if (adapter.temperature != null && !(Number(adapter.temperature) >= 0 && Number(adapter.temperature) <= 2)) throw new HttpError(422, 'adapter.temperature must be between 0 and 2');
    if (!merged.scopes?.length) merged.scopes = HARNESS_DEFAULT_SCOPES;
  } else if (adapter.kind === 'external') {
    // Their agent, their harness (part 1.1): it drives the hospital from outside through the environment API, the MCP connectors or as a CDS Hooks service. Nothing runs here.
    if (!['environment-api', 'mcp', 'cds-hooks'].includes(merged.connection ?? adapter.connection)) throw new HttpError(422, 'An outside agent connects by environment-api, mcp or cds-hooks');
    merged.connection = merged.connection ?? adapter.connection;
  } else {
    throw new HttpError(422, 'adapter.kind must be "stub" (built-in, offline), "model" (a template on the model layer), "harness" (a model endpoint with the reference harness), "external" (an outside agent with its own harness) or "http" (external endpoint, disabled by default)');
  }
  const shadow = { event: Boolean(merged.shadow?.event), task: Boolean(merged.shadow?.task) };
  const limits = {
    maxSteps: Math.min(Math.max(Number(merged.limits?.maxSteps) || 20, 1), 200),
    timeoutMs: Math.min(Math.max(Number(merged.limits?.timeoutMs) || 30000, 100), 600000),
  };
  const hitl = {
    auto: Boolean(merged.hitl?.auto),
    askFrequency: ASK_FREQUENCIES.includes(merged.hitl?.askFrequency) ? merged.hitl.askFrequency : 'every-step',
  };
  const { _seq, meta, ...rest } = merged;
  // Promotion belongs to one exact version. It can only be granted by the promotion gate, and any change of version or policy returns the agent to shadow.
  const policyHash = typeof merged.policyHash === 'string' && merged.policyHash ? merged.policyHash.slice(0, 64) : hashOf({ adapter, scopes: merged.scopes, version: merged.version });
  const samePolicy = existing && existing.version === merged.version && existing.policyHash === policyHash;
  const stage = samePolicy && existing.stage === 'hitl' ? 'hitl' : 'shadow';
  return {
    ...rest, resourceType: 'Agent', id, name: merged.name.trim().slice(0, 80), version: merged.version,
    description: String(merged.description || '').slice(0, 500), capability: String(merged.capability || 'custom').slice(0, 40), triggers: merged.triggers && typeof merged.triggers === 'object' ? merged.triggers : null,
    organisation: String(merged.organisation || (existing?.builtIn ? 'Built in' : '')).trim().slice(0, 80) || null, modelName: String(merged.modelName || adapter.model || '').trim().slice(0, 120) || null,
    connection: CONNECTIONS.includes(merged.connection) ? merged.connection : adapter.kind === 'harness' ? 'model-endpoint' : adapter.kind === 'http' ? 'http' : adapter.kind === 'external' ? merged.connection : 'built-in',
    requested: merged.requested || merged.permissions ? normalizePermissions(merged.requested ?? merged.permissions) : existing?.requested ?? BUILTIN_PERMISSIONS,
    granted: existing?.granted ?? null, approval: existing?.approval ?? null, permissionRev: existing?.permissionRev ?? 0, connectors: existing?.connectors ?? { enabled: false },
    scopes: validateScopes(merged.scopes ?? []), adapter: adapter.kind === 'harness' ? { kind: 'harness', provider: adapter.provider, baseUrl: adapter.baseUrl, model: adapter.model, keyEnv: adapter.keyEnv, local: adapter.local, temperature: Number(adapter.temperature ?? 0), maxTokens: Math.min(Math.max(Number(adapter.maxTokens) || 1024, 64), 8192), harness: HARNESS } : adapter.kind === 'external' ? { kind: 'external' } : adapter.kind === 'stub' ? { kind: 'stub', stub: adapter.stub } : adapter.kind === 'model' ? { kind: 'model', template: adapter.template, model: adapter.model || 'stub', temperature: Number(adapter.temperature ?? 0), maxTokens: Math.min(Math.max(Number(adapter.maxTokens) || 1024, 64), 8192), contextWindow: MODEL_TEMPLATES[adapter.template].contextWindow, promptHash: templateHash(adapter.template) } : { kind: 'http', endpoint: adapter.endpoint },
    policyHash, stage, promotedVersion: stage === 'hitl' ? existing.promotedVersion : null, promotions: existing?.promotions ?? [],
    shadow, hitl, limits, enabled: merged.enabled !== false, builtIn: Boolean(existing?.builtIn), cds: Boolean(merged.cds),
  };
}

// ---------- Text helpers used by the stubs ----------
const text = (v) => String(v ?? '').trim();
const conceptText = (c) => text(c?.text || c?.coding?.[0]?.display);
const REPORT_EXT = { technique: 'urn:hospital-desktop:report-technique', findings: 'urn:hospital-desktop:report-findings' };

class Stopped extends Error {
  constructor(reason, message) { super(message || reason); this.reason = reason; }
}
class ToolError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

const mrnOf = (patient) => (patient?.identifier || []).find((i) => i.type?.coding?.some((c) => c.code === 'MR'))?.value ?? null;
const firstWord = (c) => conceptText(c).toLowerCase().split(/[^a-z]+/).filter(Boolean)[0] || '';
const sameDrug = (a, b) => (a?.coding || []).some((x) => (b?.coding || []).some((y) => x.code && x.code === y.code && x.system === y.system)) || (firstWord(a) && firstWord(a) === firstWord(b));
const stop = (flags) => ({ declined: true, flags, label: null, confidence: 0.9, summary: `Stopped without writing anything: ${flags.map((f) => f.detail).join(' ')}` });

// ---------- Reference stubs ----------
const STUBS = {
  async 'chart-summariser'({ task, tools }) { try { return await chartSummariser({ task, tools }); } catch (err) { if (err.stopReason) throw new Stopped(err.stopReason, err.message); throw err; } },
  async 'note-scribe'({ run, task, tools }) {
    const [, pid] = String(task.subject || '').split('/');
    const c = task.context || {};
    if (!pid || !c.transcript || !c.roles) throw new Stopped('failed', 'Ambient Scribe needs a patient, a transcript and the note sections to fill');
    const [, tid] = c.transcript.split('/');
    const transcript = await tools.read('DocumentReference', tid, 'Read the encounter transcript I am asked to write up');
    const text = Buffer.from(transcript.content?.[0]?.attachment?.data || '', 'base64').toString('utf8');
    const meds = (await tools.search('MedicationRequest', { patient: pid, status: 'active' }, 'Look up current medications so the note can list them')).map((m) => m.dosageInstruction?.[0]?.text || m.medicationCodeableConcept?.text).filter(Boolean);
    await tools.search('Condition', { patient: pid }, 'Look up the problem list for context');
    const bucket = { subjective: [], objective: [], assessment: [], plan: [], medications: [] };
    const unmatched = [];
    for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const [speaker, ...rest] = line.split(':');
      const said = rest.join(':').trim();
      if (!said || said.endsWith('?')) continue;
      if (/^patient/i.test(speaker)) bucket.subjective.push(`Patient reports: ${said}`);
      else if (SCRIBE_RULES.objective.test(said)) bucket.objective.push(said);
      else if (SCRIBE_RULES.assessment.test(said)) bucket.assessment.push(said);
      else if (SCRIBE_RULES.plan.test(said)) bucket.plan.push(said);
      else unmatched.push(said);
    }
    // Sentences no rule matched are kept, marked for the clinician to check (plan-master 8.7).
    for (const s of unmatched) bucket.assessment.push(`${CHECK_MARK} ${s}`);
    const coded = [];
    for (const [pattern, code, label] of SCRIBE_RULES.diagnoses) if (pattern.test(text)) { bucket.assessment.push(`Diagnosis: ${label}.`); coded.push({ url: 'urn:hospital-desktop:note-element', valueCoding: { system: CODE_SYSTEMS['ICD-10'], code, display: label } }); }
    if (meds.length) bucket[c.roles.medications ? 'medications' : 'plan'].push(`Current medications: ${meds.join('; ')}.`);
    if (!bucket.plan.some((l) => /follow[- ]up|come back|repeat/i.test(l))) bucket.plan.push(SCRIBE_RULES.defaultFollowUp);
    const bySection = new Map();
    for (const [role, lines] of Object.entries(bucket)) { const heading = c.roles[role]; if (!heading || !lines.length) continue; bySection.set(heading, [...(bySection.get(heading) || []), ...lines]); }
    const body = (c.sections || []).filter((h) => bySection.has(h)).map((h) => `${h}:\n${bySection.get(h).join(' ')}`).join('\n\n');
    const made = await tools.create({
      resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', subject: { reference: `Patient/${pid}` }, date: new Date().toISOString(),
      type: { coding: [{ system: CODE_SYSTEMS.LOINC, code: c.noteType?.code, display: c.noteType?.display }], text: c.noteType?.display }, description: 'Drafted by Ambient Scribe',
      extension: [{ url: 'urn:hospital-desktop:ai-drafted', valueString: 'note-scribe' }, ...coded], content: [{ attachment: { contentType: 'text/plain', data: Buffer.from(`${body}\n`, 'utf8').toString('base64') } }],
    }, `Sorted ${text.split('\n').length} transcript lines into ${bySection.size} sections; listed ${coded.length} diagnoses from my keyword table`);
    const missing = (c.sections || []).filter((h) => !bySection.has(h));
    // Queued orders (queue-orders): orders the plan names, for the clinician to sign or remove.
    const queued = [];
    if (hasCap(run, 'queue-orders') || !Array.isArray(run?.capabilities)) {
      for (const o of queuedOrdersFrom(text)) {
        try { const sr = await tools.create({ resourceType: 'ServiceRequest', status: 'active', intent: 'order', priority: 'routine', subject: { reference: `Patient/${pid}` }, authoredOn: new Date().toISOString(), requester: { display: 'Ambient Scribe' }, category: [{ coding: [{ system: 'urn:hospital-desktop:order-category', code: o.category }] }], code: { coding: [{ system: CODE_SYSTEMS.LOINC, code: o.code, display: o.label }], text: o.label }, reasonCode: [{ text: 'From the visit transcript' }] }, `The plan mentions "${o.cue}", so I queued ${o.label} for the clinician to sign or remove`); queued.push(`ServiceRequest/${sr.id}`); } catch (err) { if (!(err instanceof ToolError)) throw err; }
      }
    }
    return { output: [`DocumentReference/${made.id}`, ...queued], queued, checkThis: unmatched.length, label: 'note-drafted', flags: [], confidence: missing.length ? 0.4 : 0.6, summary: `Drafted a note with ${bySection.size} of ${(c.sections || []).length} sections${missing.length ? ` (nothing for: ${missing.join(', ')})` : ''}` };
  },
  async 'report-drafter'({ run, task, tools }) {
    const [type, id] = String(task.subject || '').split('/');
    if (type !== 'ImagingStudy' || !id) throw new Stopped('failed', 'Report Drafter needs an ImagingStudy as its subject');
    const study = await tools.read('ImagingStudy', id, 'Open the study I was asked to report');
    const patientId = study.subject?.reference?.split('/')[1];
    const patient = await tools.read('Patient', patientId, 'Confirm which patient this study belongs to');
    const flags = [];
    const dicomId = (study.identifier || []).find((i) => i.system === 'urn:dicom:patient-id')?.value;
    const overridden = (study.extension || []).some((e) => e.url === 'urn:hospital-desktop:patient-override');
    if (!overridden && dicomId && mrnOf(patient) && dicomId !== mrnOf(patient)) flags.push({ code: 'wrong-patient', detail: `The images carry patient id ${dicomId} but the study is filed under ${mrnOf(patient)}.` });
    if (task.context?.patient && task.context.patient !== study.subject?.reference) flags.push({ code: 'wrong-patient-context', detail: 'The workstation is showing a different patient from the one this study belongs to.' });
    if (flags.length) return stop(flags);
    let order = null;
    const orderRef = (study.basedOn || []).find((b) => b.reference?.startsWith('ServiceRequest/'))?.reference;
    if (orderRef) order = await tools.read('ServiceRequest', orderRef.split('/')[1], 'Read the clinical question on the order');
    const reports = await tools.search('DiagnosticReport', { patient: patientId }, 'Look for earlier reports to compare with');
    const signed = reports.filter((r) => ['final', 'amended', 'corrected', 'appended'].includes(r.status)
      && !(r.imagingStudy || []).some((s) => s.reference === `ImagingStudy/${id}`))
      .sort((a, b) => String(b.issued || b.effectiveDateTime || '').localeCompare(String(a.issued || a.effectiveDateTime || '')));
    const prior = signed[0] || null;
    const requestText = [conceptText(study.reasonCode?.[0]), conceptText(order?.reasonCode?.[0])].join(' ').toLowerCase();
    const expectsPrior = /follow[- ]?up|known|previous|prior|interval|compar/.test(requestText);
    const gaps = [];
    if (expectsPrior && !prior) {
      const others = await tools.search('ImagingStudy', { patient: patientId }, 'The request refers to earlier imaging, so look for the earlier study');
      if (!others.some((x) => x.id !== id)) gaps.push({ code: 'missing-data', detail: 'The request refers to earlier imaging, but there is no earlier study or report in the chart to compare with.' });
    }

    const modality = study.modality?.[0]?.code || study.series?.[0]?.modality?.code || 'OT';
    const bodyPart = study.series?.find((s) => s.bodySite?.display)?.bodySite.display || '';
    const indication = [conceptText(study.reasonCode?.[0]), conceptText(order?.reasonCode?.[0])].filter(Boolean).join('; ');
    const context = `${indication} ${study.description || ''} ${prior?.conclusion || ''}`.toLowerCase();
    const cue = REPORT_RULES.cues.find((c) => context.includes(c)) || null;
    // A critical finding is proposed only with permission when the agent may ask (8.7); otherwise it is drafted for review as before.
    const critical = cue && REPORT_RULES.critical.includes(cue);
    let withheld = false;
    if (critical) { const perm = await maybeAsk(run, tools, { kind: 'permission', text: `The clinical context mentions "${cue}". May I propose a critical finding in the draft impression?`, action: { type: 'DiagnosticReport', label: `Propose a critical finding: ${cue}`, details: 'The impression would flag a possible critical finding for urgent review' } }); if (perm && perm.decision !== 'approved') withheld = true; }
    const exam = [modality, bodyPart || study.description].filter(Boolean).join(' ');
    const technique = `${exam}. ${study.series?.length ?? 0} series, ${study.numberOfInstances ?? 0} image${study.numberOfInstances === 1 ? '' : 's'}.`;
    const findings = [
      REPORT_RULES.note,
      `Indication: ${indication || 'not stated'}.`,
      prior ? `Comparison: prior report dated ${String(prior.issued || prior.effectiveDateTime || '').slice(0, 10) || 'unknown'}.` : gaps.length ? 'Comparison: the request refers to earlier imaging, but none could be found in the chart. Please check before relying on this draft.' : 'Comparison: none available.',
      cue ? `The clinical context mentions "${cue}". Correlate on the images.` : 'The clinical context does not point to a specific abnormality.',
    ].join('\n');
    const impression = withheld ? 'Requires radiologist review of the images. A possible critical finding was not proposed, on the clinician\'s instruction.' : cue
      ? `Possible abnormality (${cue}) suggested by the clinical context. Requires radiologist review of the images.`
      : 'No acute abnormality suggested by the clinical context. Requires radiologist review of the images.';
    const why = cue
      ? `The indication or prior report mentions "${cue}", so I drafted an impression that flags it for review. I did not analyse the images.`
      : 'Nothing in the indication, order or prior reports points to an abnormality, so I drafted a normal template. I did not analyse the images.';
    const draft = await tools.create({
      resourceType: 'DiagnosticReport', status: 'preliminary', subject: { reference: `Patient/${patient.id}` },
      code: { text: study.description || exam }, imagingStudy: [{ reference: `ImagingStudy/${id}` }],
      effectiveDateTime: study.started || undefined, basedOn: orderRef ? [{ reference: orderRef }] : undefined,
      conclusion: impression,
      extension: [{ url: REPORT_EXT.technique, valueString: technique }, { url: REPORT_EXT.findings, valueString: findings }],
    }, why);
    return { output: `DiagnosticReport/${draft.id}`, label: cue ? 'abnormal' : 'normal', flags: gaps, confidence: gaps.length ? 0.15 : cue ? 0.4 : 0.3, summary: gaps.length ? `${impression} Flagged: ${gaps[0].detail}` : impression };
  },

  async 'inbox-triager'({ run, task, tools }) {
    const [type, id] = String(task.subject || '').split('/');
    if (type !== 'Communication' || !id) throw new Stopped('failed', 'Inbox Triager needs a Communication as its subject');
    const message = await tools.read('Communication', id, 'Read the patient message I was asked to triage');
    const patientRef = message.subject?.reference || message.sender?.reference;
    const patientId = patientRef?.split('/')[1];
    if (patientId) await tools.read('Patient', patientId, 'Check which patient sent the message');
    if (task.context?.patient && patientRef && task.context.patient !== patientRef) {
      return stop([{ code: 'wrong-patient-context', detail: 'The workstation is showing a different patient from the one who sent this message.' }]);
    }
    const body = `${message.topic?.text || ''} ${(message.payload || []).map((p) => p.contentString || '').join(' ')}`.toLowerCase();
    const hitUrgent = TRIAGE_RULES.urgent.find((k) => body.includes(k));
    const hitLow = !hitUrgent && TRIAGE_RULES.low.find((k) => body.includes(k));
    let label = hitUrgent ? 'urgent' : hitLow ? 'low' : 'routine';
    let reply = TRIAGE_RULES.replies[label];
    // A symptom the rules do not cover: with agent-may-ask, ask one question (8.7). Planted text never counts as an answer.
    const unruled = !hitUrgent && !hitLow ? UNRULED_SYMPTOMS.find((k) => body.includes(k)) : null;
    let askedAbout = null;
    if (unruled) { const answer = await maybeAsk(run, tools, { kind: 'question', text: `The message mentions "${unruled}", which my rules do not cover. Should I treat it as urgent? Reply "urgent" or "routine".` }); if (answer) { askedAbout = unruled; if (/urgent/i.test(answer.text || '')) { label = 'urgent'; reply = TRIAGE_RULES.replies.urgent; } } }
    const flags = [];
    let safety = null;
    if (/refill|prescription|medication|\bmg\b|dose/.test(body) && patientId) {
      const meds = await tools.search('MedicationRequest', { patient: patientId, status: 'active' }, 'The message mentions a medication, so check the active medication list');
      const allergies = await tools.search('AllergyIntolerance', { patient: patientId }, 'Check the allergy list against the medication list before saying anything about a refill');
      const clash = meds.find((m) => allergies.some((a) => a.clinicalStatus?.coding?.[0]?.code !== 'inactive' && sameDrug(m.medicationCodeableConcept, a.code)));
      const asked = Math.max(0, ...[...body.matchAll(/(\d+(?:\.\d+)?)\s*mg/g)].map((m) => Number(m[1])));
      const doses = meds.map((m) => m.dosageInstruction?.[0]?.doseAndRate?.[0]?.doseQuantity?.value).filter((v) => typeof v === 'number' && v > 0);
      const unsafe = asked > 0 && doses.some((d) => asked >= d * TRIAGE_RULES.medicationChecks.unsafeDoseFactor);
      if (clash) { flags.push({ code: 'allergy-conflict', detail: `${conceptText(clash.medicationCodeableConcept)} is on both the active medication list and the allergy list.` }); safety = 'The chart lists the same drug as an active medication and as an allergy, so a clinician must review it before any refill.'; }
      if (unsafe) { flags.push({ code: 'unsafe-dose', detail: `The message mentions ${asked} mg, at least ${TRIAGE_RULES.medicationChecks.unsafeDoseFactor} times a prescribed dose.` }); safety = `The message mentions ${asked} mg, which is at least ${TRIAGE_RULES.medicationChecks.unsafeDoseFactor} times a dose on the medication list, so I will not confirm it.`; }
      if (safety) { label = 'urgent'; reply = TRIAGE_RULES.escalation; }
      else if (label !== 'urgent') reply += meds.length ? ' You can request a refill of an active medication from the Medications page of the portal.' : ' We do not see an active prescription on file; the care team will follow up.';
    }
    const why = safety || (hitUrgent ? `The message contains "${hitUrgent}", which my rules treat as urgent.`
      : hitLow ? `The message contains "${hitLow}" and no urgent wording, so it needs no action.`
        : askedAbout ? `The message mentions "${askedAbout}", which my rules do not cover, so I asked the clinician and followed the answer.` : 'No urgent or low-priority wording matched, so I labelled it routine.');
    const created = await tools.create({
      resourceType: 'Task', status: 'requested', intent: 'proposal', priority: label === 'urgent' ? 'urgent' : 'routine', authoredOn: new Date().toISOString(),
      code: { coding: [{ system: TASK_SYSTEM, code: 'message-triage' }], text: 'Message triage' },
      focus: { reference: `Communication/${id}` }, for: patientRef ? { reference: patientRef } : undefined,
      description: `Suggested priority: ${label}`,
      output: [{ type: { text: 'triage-label' }, valueString: label }, { type: { text: 'suggested-reply' }, valueString: reply }],
    }, why);
    return { output: `Task/${created.id}`, label, flags, confidence: safety || hitUrgent || hitLow ? 0.7 : 0.5, summary: `Labelled ${label}${flags.length ? ` and flagged: ${flags.map((f) => f.code).join(', ')}` : ''}` };
  },
};

STUBS['workup-planner'] = async ({ run, task, tools }) => {
  const [type, id] = String(task.subject || '').split('/');
  if (type !== 'Patient' || !id) throw new Stopped('failed', 'Workup Planner needs a Patient as its subject');
  await tools.read('Patient', id, 'Open the chart of the patient I was asked to review');
  const encounters = await tools.search('Encounter', { patient: id }, 'Find out why the patient came in');
  const observations = await tools.search('Observation', { patient: id }, 'Read the vital signs and results');
  const conditions = await tools.search('Condition', { patient: id }, 'Read the problem list');
  const latest = (code) => observations.filter((o) => o.code?.coding?.some((c) => c.code === code)).sort((a, b) => String(b.effectiveDateTime).localeCompare(String(a.effectiveDateTime)))[0];
  const num = (code) => latest(code)?.valueQuantity?.value;
  const said = `${encounters.map((e) => conceptText(e.reasonCode?.[0])).join(' ')} ${conditions.map((c) => conceptText(c.code)).join(' ')}`.toLowerCase();
  const ecg = text(latest('11524-6')?.valueString).toLowerCase();
  const xray = text(latest('36643-5')?.valueString).toLowerCase();
  const stElevation = ecg.includes('st elevation');
  const gt = (code, v) => num(code) != null && num(code) > v;
  const lt = (code, v) => num(code) != null && num(code) < v;
  const fires = {
    pe: /short(ness)? of breath|dyspn/.test(said) && gt('8867-4', 100) && lt('59408-5', 94),
    sepsis: gt('8310-5', 38.3) && gt('2524-7', 2),
    dka: gt('2345-7', 250) && lt('1963-8', 18),
    stemi: stElevation,
    htn: num('8480-6') >= 180,
    pneumonia: /cough/.test(said) && xray.includes('consolidation'),
    hyperk: gt('2823-3', 6),
    aki: gt('2160-0', 2) && !(num('2823-3') > 6),
    'gi-bleed': /vomiting blood|black stool|melaena|melena/.test(said) && lt('718-7', 8),
    'chest-pain': /chest (pain|tightness)/.test(said) && !stElevation && lt('10839-9', 0.04),
  };
  // Before planning: is anything missing, impossible or contradictory?
  const flags = [];
  const labs = observations.filter((o) => (o.category || []).some((c) => (c.coding || []).some((x) => x.code === 'laboratory')));
  if (!labs.length) {
    // A key lab is missing: with agent-may-ask, ask whether to go on without it (8.7).
    const answer = await maybeAsk(run, tools, { kind: 'question', text: 'There are no laboratory results in the chart. Should I plan from the vital signs and history alone? Reply "yes" to go on.' });
    if (!(answer && /\byes\b|go on|proceed/i.test(answer.text || ''))) flags.push({ code: 'missing-data', detail: 'There are no laboratory results in the chart for this emergency patient.' });
  }
  for (const [code, [low, high]] of Object.entries(WORKUP_RULES.plausible)) {
    const v = num(code);
    if (v != null && (v < low || v > high)) flags.push({ code: 'implausible-value', detail: `${conceptText(latest(code).code) || code} of ${v} is outside the range a living patient can have.` });
  }
  if (lt('2823-3', 3.5) && ecg.includes('peaked t')) flags.push({ code: 'inconsistent-data', detail: 'Potassium is low but the ECG shows peaked T waves, which goes with high potassium.' });
  if (flags.length) {
    return { output: [], label: 'withheld', flags, confidence: 0.1, declined: true, summary: `Stopped without writing a plan: ${flags.map((f) => f.detail).join(' ')}`, refused: [] };
  }
  const matched = WORKUP_RULES.rules.filter((r) => fires[r.id]);
  const random = seeded(task.seed);
  const explore = task.seed ? WORKUP_RULES.exploration : 0;
  const plan = [];
  for (const rule of matched) for (const action of rule.actions) {
    if (explore && random() < explore * 0.6) continue;
    plan.push({ action, why: `The chart fits ${rule.label} (${rule.when}).` });
  }
  if (explore && random() < explore) {
    const extra = WORKUP_RULES.distractors[Math.floor(random() * WORKUP_RULES.distractors.length)];
    plan.splice(Math.floor(random() * (plan.length + 1)), 0, { action: extra, why: 'Trying an extra step that my rules do not call for (exploration).' });
  }
  const subject = { reference: `Patient/${id}` };
  const written = []; const refused = [];
  for (const { action: [kind, code, label, category], why } of plan) {
    const [system, value] = code.split(':');
    const coding = { coding: [{ system: CODE_SYSTEMS[system], code: value, display: label }], text: label };
    const now = new Date().toISOString();
    const resource = kind === 'order'
      ? { resourceType: 'ServiceRequest', status: 'active', intent: 'order', priority: 'stat', category: [{ coding: [{ system: 'urn:hospital-desktop:order-category', code: category || 'laboratory' }] }], code: coding, subject, authoredOn: now, requester: { display: 'Workup Planner' } }
      : kind === 'prescribe'
        ? { resourceType: 'MedicationRequest', status: 'draft', intent: 'order', medicationCodeableConcept: coding, subject, authoredOn: now, requester: { display: 'Workup Planner' }, dosageInstruction: [{ text: 'Dose to be confirmed by the prescriber' }] }
        : { resourceType: 'Condition', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] }, verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'provisional' }] }, category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'encounter-diagnosis' }] }], code: coding, subject, recordedDate: now };
    try { const made = await tools.create(resource, why); written.push(`${made.resourceType}/${made.id}`); } catch (err) {
      if (!(err instanceof ToolError)) throw err;
      refused.push({ label, status: err.status, message: err.message });
    }
  }
  return {
    output: written, label: matched.map((r) => r.id).join('+') || 'no-rule', flags: [], confidence: matched.length === 1 ? 0.7 : 0.3,
    summary: matched.length ? `Planned for ${matched.map((r) => r.label).join(' and ')}: ${written.length} written${refused.length ? `, ${refused.length} refused (${refused.map((r) => r.label).join(', ')})` : ''}` : 'No rule matched this chart; nothing written',
    refused,
  };
};

export const TOOL_MANIFEST = [
  { name: 'read', args: { type: 'FHIR resource type', id: 'resource id' }, description: 'Read one resource as the run sees it' },
  { name: 'search', args: { type: 'FHIR resource type', params: 'search parameters object' }, description: 'Search resources of one type' },
  { name: 'create', args: { resource: 'FHIR resource' }, description: 'Create a resource on the run branch (scope whitelist applies)' },
  { name: 'update', args: { resource: 'FHIR resource with id' }, description: 'Update a resource on the run branch (scope whitelist applies)' },
];

export const externalAgentsAllowed = (env = process.env) => env.ALLOW_EXTERNAL_AGENTS === 'true';

// External agents speak a small observe/act protocol: we POST the task, the
// tool manifest and the last observation; they answer { tool, args, why } or
// { done: true, result }.
async function httpAdapter(agent, { run, task, tools, control }) {
  let observation = null;
  for (;;) {
    await control.checkpoint({ count: false });
    const response = await fetch(agent.adapter.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(Math.max(control.remaining(), 1)),
      body: JSON.stringify({ run: { id: run.id, mode: run.mode, branch: run.branch }, task, tools: TOOL_MANIFEST, observation }),
    });
    if (!response.ok) throw new Stopped('failed', `Agent endpoint answered HTTP ${response.status}`);
    const message = await response.json();
    if (message?.done) return message.result && typeof message.result === 'object' ? message.result : {};
    try {
      observation = { tool: message?.tool, result: await tools.call(message?.tool, message?.args || {}, message?.why) };
    } catch (err) {
      if (err instanceof Stopped) throw err;
      observation = { tool: message?.tool, error: err.message, status: err.status ?? null };
    }
  }
}

export function createAgentRuntime({ store, env = process.env }) {
  const state = { baseUrl: null, closing: false, hitl: null, redTeam: null, rl: null, ablation: null, parts: [], models: null, turns: null, simClock: null, connectors: null };
  // Model-backed agents: observe through the logged tools, one model call, act through the same tools.
  async function modelAdapter(agent, { run, task, tools, control }) {
    if (!state.models) throw new Stopped('failed', 'The model layer is not available');
    await control.checkpoint({ count: false });
    try {
      return await state.models.runTemplate({ template: agent.adapter.template, adapter: agent.adapter.model || 'stub', temperature: agent.adapter.temperature ?? 0, maxTokens: agent.adapter.maxTokens ?? 1024, seed: task.seed ?? 0 }, { task, tools, ctx: { actor: agentActor(agent), runId: run.id, branch: run.branch }, why: null });
    } catch (err) {
      if (err instanceof Stopped || err instanceof ToolError) throw err;
      throw new Stopped(err.status === 403 ? 'refused' : 'failed', String(err.message).slice(0, 300));
    }
  }
  // Their model, our reference harness (part 1.2). Local endpoints may see any patient; cloud endpoints need ALLOW_EXTERNAL_MODELS=true and a synthetic, unrestricted patient. Refusals are logged. The key is read here and goes nowhere else.
  /** One logged model call for an agent's endpoint inside a run, under the data rules. Used by the reference harness, the visit scribe and the model-backed patient. */
  async function modelCaller(agent, run, { remaining = () => 120000 } = {}) {
    const control = { remaining };
    const ep = agent.adapter; const ctx = { actor: agentActor(agent), runId: run.id, branch: run.branch };
    if (ep?.kind !== 'harness') throw new Stopped('failed', `${agent.name} has no model endpoint`);
    const log = (fields) => store.transaction((tx) => recordAction(tx, { runId: run.id, actor: ctx.actor, branch: run.branch, audit: false, ...fields }));
    const refuse = async (reason) => { await log({ kind: 'execute', action: 'model.refuse', args: { provider: ep.provider, model: ep.model, local: false, patient: run.patientRef ?? null, reason }, description: `model endpoint refused: ${reason}`, outcome: '8' }); throw new Stopped('refused', `This model endpoint may not be used here: ${reason}`); };
    if (!isLocalUrl(ep.baseUrl)) {
      if (process.env.ALLOW_EXTERNAL_MODELS !== 'true') await refuse('ALLOW_EXTERNAL_MODELS is not true, so nothing may be sent to a model outside this machine');
      if (!run.patientRef) await refuse('the run names no patient, so it cannot be checked that only synthetic data would leave this machine');
      if (!state.models) await refuse('the model layer is not available');
      try { await state.models.guard('external', run.patientRef, ctx); } catch (err) { throw new Stopped('refused', String(err.message).slice(0, 300)); }
    }
    const secret = await store.get('AgentSecret', agent.id);
    const apiKey = secret?.apiKey || (ep.keyEnv ? process.env[ep.keyEnv] : null) || null;
    if (!apiKey && ep.provider !== 'openai-compatible') throw new Stopped('failed', `No key for this model endpoint: set ${ep.keyEnv || 'a key'} in .env or give a key when adding the agent`);
    const callModel = async (request) => {
      const hash = promptHash(request);
      let out;
      try { out = await chatEndpoint(ep, { ...request, timeoutMs: Math.max(Math.min(control.remaining(), 120000), 1000) }, { apiKey }); } catch (err) {
        await log({ kind: 'execute', action: 'model.call', args: { provider: ep.provider, model: ep.model, local: Boolean(ep.local), harness: HARNESS.id, promptHash: hash, error: String(err.message).slice(0, 200), latencyMs: null }, description: `model call failed (${ep.provider})`, outcome: '8' });
        throw new Stopped('failed', String(err.message).slice(0, 300));
      }
      await log({ kind: 'execute', action: 'model.call', args: { provider: ep.provider, adapter: ep.provider, model: out.model, local: Boolean(ep.local), harness: HARNESS.id, harnessVersion: HARNESS.version, promptHash: hash, promptTokens: out.usage?.promptTokens ?? null, completionTokens: out.usage?.completionTokens ?? null, latencyMs: out.latencyMs, temperature: request.temperature ?? 0, seed: request.seed ?? null, toolCalls: (out.toolCalls || []).length }, description: `model call (${ep.provider}, ${out.model})` });
      return out;
    };
    return callModel;
  }
  async function harnessAdapter(agent, { run, task, tools, control, briefing }) {
    const ep = agent.adapter;
    const callModel = await modelCaller(agent, run, { remaining: () => control.remaining() });
    try {
      return await runReferenceHarness({ briefing, task, tools, control, callModel, maxSteps: agent.limits?.maxSteps ?? 20, temperature: ep.temperature ?? 0, maxTokens: ep.maxTokens ?? 1024, seed: task.seed ?? 0 });
    } catch (err) {
      if (err instanceof Stopped || err instanceof ToolError) throw err;
      throw new Stopped('failed', String(err.message).slice(0, 300));
    }
  }
  const active = new Set();
  const agentActor = (agent) => ({ kind: 'agent', id: agent.id, role: 'agent' });

  function makeControl(run, agent) {
    let steps = 0;
    let deadline = Date.now() + agent.limits.timeoutMs;
    return {
      remaining: () => deadline - Date.now(),
      async checkpoint({ count = true } = {}) {
        for (;;) {
          if (state.closing) throw new Stopped('stopped', 'Server is shutting down');
          const current = await store.get('Run', run.id);
          if (current.endedAt) throw new Stopped(current.endReason || 'stopped', `Run ended (${current.endReason})`);
          if (!current.paused) break;
          await new Promise((resolve) => setTimeout(resolve, 40));
          deadline += 40;
        }
        if (Date.now() > deadline) throw new Stopped('timeout', `Run exceeded its ${agent.limits.timeoutMs} ms time limit`);
        if (count) {
          steps += 1;
          if (steps > agent.limits.maxSteps) throw new Stopped('max-steps', `Run exceeded its limit of ${agent.limits.maxSteps} steps`);
        }
      },
    };
  }

  function makeTools(run, agent, control) {
    async function request(method, path, body, why) {
      if (!state.baseUrl) throw new Stopped('failed', 'The server is not listening yet, so agents cannot call its API');
      await control.checkpoint();
      const headers = { 'Content-Type': 'application/json', [INTERNAL_AGENT_HEADER]: INTERNAL_AGENT_TOKEN, 'X-Agent-Id': agent.id, 'X-Run-Id': run.id };
      if (why) headers['X-Reasoning'] = encodeURIComponent(String(why).slice(0, 600));
      if (method !== 'GET') headers['Idempotency-Key'] = randomUUID();
      const response = await fetch(state.baseUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
      const raw = await response.text();
      let json = null;
      try { json = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
      if (!response.ok) throw new ToolError(response.status, json?.issue?.[0]?.diagnostics || json?.error || `HTTP ${response.status}`, json);
      return json;
    }
    const safe = (v) => encodeURIComponent(String(v));
    const tools = {
      read: (type, id, why) => request('GET', `/fhir/R4/${safe(type)}/${safe(id)}`, null, why),
      async search(type, params = {}, why) {
        const q = new URLSearchParams(Object.entries(params || {}).map(([k, v]) => [k, String(v)])).toString();
        return ((await request('GET', `/fhir/R4/${safe(type)}${q ? `?${q}` : ''}`, null, why)).entry || []).map((e) => e.resource);
      },
      create: (resource, why) => request('POST', `/fhir/R4/${safe(resource?.resourceType)}`, resource, why),
      update: (resource, why) => request('PUT', `/fhir/R4/${safe(resource?.resourceType)}/${safe(resource?.id)}`, resource, why),
      /** Asks the clinician through the Agent panel and waits (agent-may-ask). A time-out or an ended run stops the turn. */
      async ask(req) {
        if (!state.turns) throw new ToolError(409, 'Asking is not available on this server');
        await control.checkpoint({ count: false });
        try { return await state.turns.ask(run, agent, req || {}); } catch (err) { if (err.stopped) throw new Stopped(err.stopped, err.message); if (err.status) throw new ToolError(err.status, err.message); throw err; }
      },
      answer: (answerText, cites = []) => (state.turns ? state.turns.postAnswer(run, agent, { text: answerText, cites }) : null),
      viewImage: (studyId, why) => request('GET', `/fhir/R4/ImagingStudy/${safe(studyId)}`, null, why || 'Looked at the images'),
      call(name, args, why) {
        if (name === 'read') return tools.read(args.type, args.id, why);
        if (name === 'search') return tools.search(args.type, args.params, why);
        if (name === 'create') return tools.create(args.resource, why);
        if (name === 'update') return tools.update(args.resource, why);
        if (name === 'ask-clinician' || name === 'ask') return tools.ask(args);
        if (name === 'finish' || name === 'answer') return tools.answer(args?.text ?? args?.summary ?? '', args?.cites ?? []);
        if (name === 'view-image') return tools.viewImage(args.id ?? args.study, why);
        throw new ToolError(400, `Unknown tool "${name}". Available: ${TOOL_MANIFEST.map((t) => t.name).join(', ')}`);
      },
    };
    return tools;
  }

  /** The trigger a run starts from (8.1): the event it was launched by, or the task it was given. */
  const EVENT_KINDS = new Set(['study-open', 'patient-message', 'chart-open', 'recording-stop', 'lab-final']);
  const initialTrigger = (run) => (run.trigger?.kind && EVENT_KINDS.has(run.trigger.kind) ? { kind: 'event', event: run.trigger.kind, at: run.trigger.at || run.startedAt } : { kind: 'task', task: run.goal, at: run.startedAt });

  /**
   * One agent turn (8.2): the briefing is built and stored on the TraceStep
   * that starts the turn, due timeline events are released, then the agent
   * works through the logged tools. A question turn answers in the panel.
   */
  async function turn(run, agent, trigger, { question = null } = {}) {
    const control = makeControl(run, agent);
    const tools = makeTools(run, agent, control);
    const task = { subject: run.subject, goal: run.goal, mode: run.mode, context: run.context ?? null, seed: run.seed ?? 0 };
    const conversation = state.turns ? state.turns.conversationOf(await store.query('TraceStep', { groupKey: run.id })) : [];
    const taskCard = trigger.kind === 'task' || trigger.kind === 'scheduled-check' ? { goal: trigger.task || run.goal, scenario: run.context?.scenario ?? null, doneWhen: run.context?.doneWhen ?? null, mustNot: run.context?.mustNot ?? null } : null;
    const briefing = briefingFor({ trigger, run, agent, task: taskCard, conversation });
    briefing.patientAge = await briefingAge(store, run, briefing.patient);
    const turnId = randomUUID();
    await store.transaction(async (tx) => {
      await recordAction(tx, { runId: run.id, actor: agentActor(agent), kind: 'execute', action: 'turn.start', args: { turn: turnId, trigger: trigger.kind, briefing }, why: `Turn started by ${trigger.kind}: the briefing records what the agent was told`, branch: run.branch, entityRef: `Run/${run.id}`, description: `agent turn started by ${trigger.kind}` });
      const r = await tx.get('Run', run.id);
      if (r) await tx.save('Run', { ...r, turn: { id: turnId, trigger: trigger.kind, writes: 0, startedAt: tx.now() } }, { updatedBy: 'system' });
    });
    if (state.turns) await state.turns.releaseDue(run).catch((err) => console.error('timeline release failed', err));
    let result;
    if (trigger.kind === 'question') {
      if ((await readFeatures(store)).features['chart-chat'].on === false) throw new Stopped('refused', 'Chart chat is switched off in Settings, AI features');
      const stub = agent.adapter.kind === 'stub' ? STUBS[agent.adapter.stub] : null;
      const patientId = String(run.patientRef || '').split('/')[1] || null;
      const q = question ?? trigger.question ?? '';
      const out = stub?.question ? await stub.question({ run, task, tools, control, question: q, patientId }) : await answerQuestion({ question: q, patientId, tools });
      await tools.answer(out.text, out.cites || []);
      result = { answered: true, cites: out.cites || [], summary: out.text };
    } else {
      result = agent.adapter.kind === 'stub'
        ? await STUBS[agent.adapter.stub]({ run, task, tools, control, briefing, trigger })
        : agent.adapter.kind === 'model' ? await modelAdapter(agent, { run, task, tools, control })
          : agent.adapter.kind === 'harness' ? await harnessAdapter(agent, { run, task, tools, control, briefing })
            : agent.adapter.kind === 'external' ? (() => { throw new Stopped('failed', `${agent.name} is an outside agent with its own harness: it starts its own runs through ${agent.connection}`); })()
              : await httpAdapter(agent, { run, task, tools, control });
    }
    await store.transaction((tx) => recordAction(tx, { runId: run.id, actor: agentActor(agent), kind: 'execute', action: 'turn.end', args: { turn: turnId, trigger: trigger.kind, summary: String(result?.summary ?? '').slice(0, 300) }, why: 'The agent handed back', branch: run.branch, entityRef: `Run/${run.id}`, description: 'agent turn ended' }));
    return result ?? {};
  }

  /** Runs the agent's own work and reports how it went, without ending the Run. */
  async function work(run, agent) {
    try {
      const result = await turn(run, agent, initialTrigger(run));
      return { ok: true, result: result ?? {} };
    } catch (err) {
      if (!(err instanceof Stopped) && !(err instanceof ToolError)) console.error(`Agent ${agent.id} run ${run.id} failed`, err);
      return { ok: false, reason: err instanceof Stopped ? err.reason : 'failed', error: String(err.message).slice(0, 500) };
    }
  }

  /** One request to this server exactly as the agent would send it. Never throws on an HTTP error. */
  async function rawRequest(run, agent, method, path, body, why) {
    const headers = { 'Content-Type': 'application/json', [INTERNAL_AGENT_HEADER]: INTERNAL_AGENT_TOKEN, 'X-Agent-Id': agent.id, 'X-Run-Id': run.id, 'X-Reasoning': encodeURIComponent(String(why || '').slice(0, 600)) };
    if (method !== 'GET') headers['Idempotency-Key'] = randomUUID();
    const response = await fetch(state.baseUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
    const raw = await response.text();
    let json = null;
    try { json = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
    return { status: response.status, json };
  }

  /** Jump and chapter clocks: the agent never waits. After its turn the clock jumps to the next event, and on it goes until the story ends (long-horizon) or it may not continue. */
  async function advanceStory(run, agent) {
    if (!state.simClock || !run.sim || !['jump', 'chapters'].includes(run.sim.mode)) return;
    if (Array.isArray(run.capabilities) && !hasCap(run, 'long-horizon')) return;
    for (let i = 0; i < 500; i += 1) {
      const current = await store.get('Run', run.id);
      if (!current || current.endedAt || state.closing) return;
      const out = await state.simClock.next(current, agentActor(agent));
      if (!out.advanced) return;
      await Promise.allSettled(out.turns || []);
    }
  }
  const runScenarioAgent = (run, agent) => execute(run, agent);

  async function execute(run, agent) {
    try {
      const result = await turn(run, agent, initialTrigger(run));
      if (run.sim) await advanceStory(run, agent);
      if (run.mode === 'hitl' && state.hitl) {
        await state.hitl.afterAgent(run, agent, result ?? {});
        return await store.get('Run', run.id);
      }
      return await endRun(store, run.id, agentActor(agent), 'completed', result ?? {});
    } catch (err) {
      if (state.closing) return run;
      const reason = err instanceof Stopped ? err.reason : err.stopped || 'failed';
      if (!(err instanceof Stopped) && !(err instanceof ToolError)) console.error(`Agent ${agent.id} run ${run.id} failed`, err);
      try { return await endRun(store, run.id, agentActor(agent), reason, { error: String(err.message).slice(0, 500) }); } catch { return run; }
    }
  }

  /** Creates a Run for the agent and executes it. wait=false returns as soon as the Run exists. */
  async function launch({ agentId, mode, subject, goal, actor, trigger = null, wait = true, friction, hitl = null, overlays = undefined, context = undefined, condition = undefined, capabilities = undefined, clock = undefined, askTimeoutMs = undefined, timeline = undefined, caseId = undefined, study = undefined, permissions = undefined }) {
    if (!AGENT_MODES.includes(mode)) throw new HttpError(422, `Agents can be started in these modes for now: ${AGENT_MODES.join(', ')}`);
    const agent = await store.get('Agent', agentId);
    if (!agent) throw new HttpError(404, `Agent "${agentId}" is not registered`);
    if (agent.adapter.kind === 'http' && !externalAgentsAllowed(env)) {
      throw new HttpError(409, 'External agent endpoints are disabled. Set ALLOW_EXTERNAL_AGENTS=true to let this server call them');
    }
    const [type, id] = String(subject || '').split('/');
    let extra = {};
    let readBranch = 'main';
    if (mode === 'hitl') {
      if (!state.hitl) throw new HttpError(409, 'Human-in-the-loop is not available on this server');
      if (await engagedSwitch(store, { agentId, mode })) throw new HttpError(403, 'A kill switch is engaged. Release it before starting agent runs', 'forbidden');
      const options = hitl || {};
      let target = options.targetBranch ?? 'main';
      if (options.practice && !options.targetBranch) {
        target = await store.transaction(async (tx) => {
          const created = await tx.fork({ parentBranch: 'main', kind: 'sandbox' });
          await recordAction(tx, { actor, kind: 'execute', action: 'branch.fork', args: { branch: created, kind: 'sandbox', purpose: 'hitl-practice' }, branch: created, description: `practice copy ${created}` });
          return created;
        });
      }
      readBranch = target;
      if (options.probe) {
        if (target === 'main') throw new HttpError(403, 'Deliberately wrong proposals are only allowed on a practice copy (sandbox), never on the live chart', 'forbidden');
        if (options.syntheticAttested !== true) throw new HttpError(422, 'Confirm that the patient is synthetic before planting a deliberately wrong proposal');
      }
      extra = { targetBranch: target, askFrequency: options.askFrequency, confidenceThreshold: options.confidenceThreshold, probe: Boolean(options.probe) };
    }
    const found = type && id ? await store.get(type, id, { branch: readBranch }).catch(() => null) : null;
    if (!found) throw new HttpError(422, `Subject "${subject}" was not found`);
    if (extra.probe) {
      if (!found._patient) throw new HttpError(422, 'A planted-error test needs a subject that belongs to a patient');
      const patient = await state.hitl.attestSynthetic(found._patient, readBranch, actor);
      if (!isSyntheticPatient(patient)) throw new HttpError(422, 'The patient is not marked as test data');
    }
    const named = { ...(condition !== undefined ? { condition } : {}), ...(capabilities !== undefined ? { capabilities } : {}), ...(clock !== undefined ? { clock } : {}), ...(askTimeoutMs !== undefined ? { askTimeoutMs } : {}), ...(timeline !== undefined ? { timeline } : {}), ...(caseId !== undefined ? { caseId } : {}), ...(study !== undefined ? { study } : {}) };
    if ((condition !== undefined || capabilities !== undefined) && mode !== 'hitl' && (!trigger?.kind || ['task', 'manual'].includes(trigger.kind))) {
      const { resolveCondition } = await import('./capabilities.mjs');
      const resolved = await resolveCondition(store, named);
      if (!resolved.capabilities.includes('autonomous-task')) throw new HttpError(403, `An assigned task without per-step approval needs the "autonomous-task" capability. Condition "${resolved.condition}" does not have it: run it as a helper (Human in the Loop) or choose the Autonomous condition`, 'forbidden');
    }
    const run = await createRun(store, { mode, agentId, subject, goal, trigger, friction, overlays, ...(context && typeof context === 'object' ? { context } : {}), ...extra, ...named, ...(permissions ? { permissions } : {}) }, actor);
    const done = execute(run, agent);
    active.add(done);
    done.finally(() => active.delete(done));
    return wait ? done : run;
  }

  const runningAgentRuns = async (match = () => true) => (await store.query('Run', { where: (r) => !r.endedAt && r.agentId && r.id !== LIVE_RUN_ID && match(r) }));

  async function setKillSwitch(input, actor) {
    const scope = input?.scope;
    if (!KILL_SCOPES.includes(scope)) throw new HttpError(422, `scope must be one of ${KILL_SCOPES.join(', ')}`);
    const target = scope === 'global' ? null : String(input.target || '');
    if (scope === 'agent' && !(await store.get('Agent', target))) throw new HttpError(422, `Agent "${target}" is not registered`);
    if (scope === 'mode' && !MODES[target]) throw new HttpError(422, `Unknown mode "${target}"`);
    if (typeof input.engaged !== 'boolean') throw new HttpError(422, 'engaged must be true or false');
    const id = switchId(scope, target);
    const doc = await store.transaction(async (tx) => {
      const saved = await tx.save('KillSwitch', {
        resourceType: 'KillSwitch', id, scope, target, engaged: input.engaged,
        reason: input.reason ? String(input.reason).slice(0, 300) : null, at: tx.now(), by: actor.id,
      }, { updatedBy: actor.role });
      await recordAction(tx, {
        actor, kind: 'execute', action: input.engaged ? 'kill-switch.engage' : 'kill-switch.release', args: { scope, target },
        why: saved.reason, entityRef: `KillSwitch/${id}`, versionId: saved.meta.versionId,
        description: `kill switch ${input.engaged ? 'engaged' : 'released'}: ${scope}${target ? ` ${target}` : ''}`,
      });
      return saved;
    });
    const stopped = [];
    if (input.engaged) {
      const hit = await runningAgentRuns((r) => scope === 'global' || (scope === 'agent' && r.agentId === target) || (scope === 'mode' && r.mode === target));
      for (const run of hit) {
        await endRun(store, run.id, actor, 'kill-switch');
        stopped.push(run.id);
      }
    }
    return { switch: doc, stopped: stopped.length, stoppedRuns: stopped };
  }

  // ---------- Shadow triggers ----------
  // A promoted agent with live proposals switched on proposes to the clinician. Otherwise it shadows, if shadowing is switched on.
  async function shadowAgents(capability, kind, shadowMode) {
    // Settings -> AI features (part 1.6): the feature can be off, or filled by another agent than the built-in default. Picking another agent is its switch.
    const feature = featureForCapability(capability); const setting = feature ? (await readFeatures(store)).features[feature.id] : null;
    if (setting && !setting.on) return [];
    const picked = setting?.agentId && setting.agentId !== feature.defaultAgent ? setting.agentId : null;
    const agents = await store.query('Agent', { where: (a) => a.enabled && (picked ? a.id === picked : a.capability === capability) });
    const out = [];
    for (const agent of agents) {
      const mode = isPromoted(agent) && agent.hitl?.auto && state.hitl ? 'hitl' : picked || agent.shadow?.[kind] ? shadowMode : null;
      if (!mode) continue;
      if (agent.adapter.kind === 'http' && !externalAgentsAllowed(env)) continue;
      if (await engagedSwitch(store, { agentId: agent.id, mode })) continue;
      out.push({ agent, mode });
    }
    return out;
  }
  const guard = (fn) => {
    if (state.closing || !state.baseUrl) return;
    const p = fn().catch((err) => { if (!state.closing) console.error('Shadow trigger failed', err); });
    active.add(p);
    p.finally(() => active.delete(p));
  };

  /** Task shadow: a clinician opens a study to read it; the agent gets the same goal in a fork taken now. */
  function onStudyOpened({ study, ctx }) {
    if (ctx.actor.kind !== 'human' || ctx.branch !== 'main' || (ctx.runId && ctx.runId !== LIVE_RUN_ID)) return;
    guard(async () => {
      const subject = `ImagingStudy/${study.id}`;
      const signed = await store.query('DiagnosticReport', { where: (r) => ['final', 'amended', 'corrected', 'appended'].includes(r.status) && (r.imagingStudy || []).some((s) => s.reference === subject) });
      if (signed.length) return;
      for (const { agent, mode } of await shadowAgents('draft-report', 'task', 'shadow-task')) {
        const seen = await store.query('Run', { where: (r) => r.mode === mode && r.agentId === agent.id && r.version === agent.version && r.subject === subject && (mode !== 'hitl' || r.targetBranch === 'main') });
        if (seen.length) continue;
        await launch({ agentId: agent.id, mode, subject, goal: 'Read this study and write the report', actor: ctx.actor, condition: mode === 'hitl' ? 'deployed-today' : undefined, trigger: { kind: 'study-open', actor: ctx.actor.id, role: ctx.actor.role, at: store.now() } });
      }
    });
  }

  /** Event shadow: a patient message arrives; the agent triages it out of sight. */
  function onCommitted({ type, saved, existed, ctx }) {
    if (type === 'DocumentReference' && !existed && ctx.branch === 'main' && ctx.actor.kind === 'human' && isTranscript(saved)) { onTranscript({ saved, ctx }); return; }
    if (type !== 'Communication' || existed || ctx.branch !== 'main' || ctx.actor.kind !== 'human') return;
    if (!saved.sender?.reference?.startsWith('Patient/')) return;
    guard(async () => {
      for (const { agent, mode } of await shadowAgents('triage-message', 'event', 'shadow-event')) {
        await launch({ agentId: agent.id, mode, subject: `Communication/${saved.id}`, goal: 'Triage this patient message', actor: ctx.actor, condition: mode === 'hitl' ? 'deployed-today' : undefined, trigger: { kind: 'patient-message', actor: ctx.actor.id, role: ctx.actor.role, at: saved._recordedAt } });
      }
    });
  }

  /** Workflow event: a clinician opens a chart; the Chart Summariser drafts a summary card (once per patient per ten minutes). */
  function onChartOpened({ patientId, ctx }) {
    if (ctx.actor.kind !== 'human' || ctx.branch !== 'main' || ctx.asOf) return;
    guard(async () => {
      const subject = `Patient/${patientId}`;
      for (const { agent, mode } of await shadowAgents('chart-summary', 'event', 'shadow-event')) {
        const recent = await store.query('Run', { where: (r) => r.agentId === agent.id && r.subject === subject && Date.parse(store.now()) - Date.parse(r.startedAt) < 600000 });
        if (recent.length) continue;
        await launch({ agentId: agent.id, mode, subject, goal: 'Summarise this chart', actor: ctx.actor, condition: 'deployed-today', trigger: { kind: 'chart-open', actor: ctx.actor.id, role: ctx.actor.role, at: store.now() } });
      }
    });
  }
  const isTranscript = (d) => d?.resourceType === 'DocumentReference' && (d.type?.coding || []).some((c) => c.system === 'urn:hospital-desktop:doc-type' && c.code === 'transcript');
  /** Workflow event: an encounter recording stops (its transcript is saved); the Ambient Scribe drafts the note and queues orders. */
  function onTranscript({ saved, ctx }) {
    guard(async () => {
      const [, pid] = String(saved.subject?.reference || '').split('/');
      if (!pid) return;
      const context = { transcript: `DocumentReference/${saved.id}`, roles: { subjective: 'Subjective', objective: 'Objective', assessment: 'Assessment', plan: 'Plan', medications: 'Plan' }, sections: ['Subjective', 'Objective', 'Assessment', 'Plan'], noteType: { code: '11506-3', display: 'Progress note' }, encounter: saved.context?.encounter?.[0]?.reference ?? null };
      for (const { agent, mode } of await shadowAgents('scribe-note', 'event', 'shadow-event')) {
        await launch({ agentId: agent.id, mode, subject: `Patient/${pid}`, goal: 'Draft the visit note from the recording', actor: ctx.actor, context, condition: 'deployed-today', trigger: { kind: 'recording-stop', actor: ctx.actor.id, role: ctx.actor.role, at: saved._recordedAt || store.now() } });
      }
    });
  }

  // ---------- /agent-ops/agents, /kill-switches, /shadow ----------
  async function handle(req, url, body, ctx, parts) {
    const method = req.method;
    const [area, id, op] = parts;
    const human = () => { if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only people can change the agent registry, kill switches or runs'); };

    if (area === 'models' && method === 'GET') {
      if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Agents may not read the model settings');
      return { status: 200, body: { adapters: modelAvailability(env), templates: Object.entries(MODEL_TEMPLATES).map(([id, t]) => ({ id, ...t })), externalAllowed: env.ALLOW_EXTERNAL_MODELS === 'true', note: 'Keys live only in environment variables and are never stored or sent to the browser. External adapters run only for patients marked synthetic and not from a restricted source.' } };
    }

    if (area === 'agents') {
      if (parts.length === 1 && method === 'GET') {
        return { status: 200, body: { agents: (await store.query('Agent')).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map(presentAgent), askFrequencies: ASK_FREQUENCIES, stubs: Object.keys(STUBS), externalAllowed: externalAgentsAllowed(env), modes: AGENT_MODES } };
      }
      if ((parts.length === 1 && method === 'POST') || (parts.length === 2 && method === 'PUT')) {
        human();
        const saved = await store.transaction(async (tx) => {
          const existing = await tx.get('Agent', parts.length === 2 ? id : String(body?.id ?? ''));
          if (parts.length === 1 && existing) throw new HttpError(409, `Agent "${existing.id}" is already registered. Use PUT /agent-ops/agents/${existing.id} to change it`);
          if (parts.length === 2 && !existing) throw new HttpError(404, `Agent "${id}" is not registered`);
          const { apiKey, granted: _g, approval: _a, permissionRev: _p, connectors: _c, ...input } = body || {};
          const doc = normalizeAgent(input, existing);
          if (!existing) doc.registeredAt = tx.now();
          // A person adding an agent here is the platform owner: what was asked for is granted at once. (An outside party submitting through the connector API waits for approval.)
          if (!existing && (input.requested || input.permissions)) { doc.granted = doc.requested; doc.approval = { status: 'approved', by: ctx.actor.id, at: tx.now(), how: 'added by the owner' }; }
          // A key given at registration is kept apart from the agent record: it is never returned, logged or shown.
          if (typeof apiKey === 'string' && apiKey.trim()) { const { _seq: s0, meta: m0, ...prev } = (await tx.get('AgentSecret', doc.id)) || {}; await tx.save('AgentSecret', { ...prev, resourceType: 'AgentSecret', id: doc.id, apiKey: apiKey.trim().slice(0, 400), setAt: tx.now() }, { updatedBy: ctx.actor.role }); doc.hasKey = true; }
          const out = await tx.save('Agent', doc, { updatedBy: ctx.actor.role });
          await recordAction(tx, {
            actor: ctx.actor, kind: existing ? 'update' : 'create', action: existing ? 'agent.update' : 'agent.register',
            args: { agent: out.id, version: out.version, enabled: out.enabled, shadow: out.shadow }, entityRef: `Agent/${out.id}`, versionId: out.meta.versionId,
            description: `agent ${existing ? 'updated' : 'registered'}: ${out.id} ${out.version}`,
          });
          out.isNewVersion = !existing || existing.version !== out.version || existing.policyHash !== out.policyHash;
          return out;
        });
        const { isNewVersion, ...answer } = saved;
        if (isNewVersion && state.redTeam) state.redTeam.autoRun(answer.id);
        return { status: parts.length === 1 ? 201 : 200, body: answer };
      }
      if (parts.length === 2 && method === 'GET') {
        const agent = await store.get('Agent', id);
        if (!agent) throw new HttpError(404, `Agent "${id}" is not registered`);
        return { status: 200, body: presentAgent(agent) };
      }
      if (parts.length === 3 && op === 'promotion' && method === 'GET') {
        const agent = await store.get('Agent', id);
        if (!agent) throw new HttpError(404, `Agent "${id}" is not registered`);
        return { status: 200, body: { ...(await evaluateGate(store, agent)), history: agent.promotions || [] } };
      }
      if (parts.length === 3 && op === 'promote' && method === 'POST') { human(); return { status: 200, body: await promote(store, id, ctx.actor) }; }
      if (parts.length === 3 && op === 'demote' && method === 'POST') { human(); return { status: 200, body: await demote(store, id, ctx.actor, body?.reason) }; }
      // Approve, narrow or refuse the permissions an agent asked for. Changing permissions makes a new agent version; results under different permissions are never mixed.
      if (parts.length === 3 && op === 'approve' && method === 'POST') {
        human();
        const out = await store.transaction(async (tx) => {
          const agent = await tx.get('Agent', id); if (!agent) throw new HttpError(404, `Agent "${id}" is not registered`);
          const { _seq, ...rest } = agent; const asked = agent.requested || BUILTIN_PERMISSIONS;
          if (body?.refuse) { const saved = await tx.save('Agent', { ...rest, approval: { status: 'refused', by: ctx.actor.id, at: tx.now(), reason: String(body.reason || '').slice(0, 300) } }, { updatedBy: ctx.actor.role }); await recordAction(tx, { actor: ctx.actor, kind: 'update', action: 'agent.refuse', args: { agent: id }, entityRef: `Agent/${id}`, description: `agent ${id} refused` }); return saved; }
          const granted = narrowTo(asked, body?.granted || asked);
          const changed = Boolean(agent.granted) && JSON.stringify(agent.granted) !== JSON.stringify(granted);
          const rev = (agent.permissionRev || 0) + (changed ? 1 : 0); const base = String(agent.version).replace(/\+p\d+$/, '');
          const saved = await tx.save('Agent', { ...rest, granted, permissionRev: rev, version: rev ? `${base}+p${rev}` : base, ...(changed ? { stage: 'shadow', promotedVersion: null } : {}), approval: { status: 'approved', by: ctx.actor.id, at: tx.now(), how: JSON.stringify(granted.systems) === JSON.stringify(asked.systems) ? 'as asked' : 'narrowed' }, connectors: { enabled: body?.connectors === undefined ? Boolean(agent.connectors?.enabled) : Boolean(body.connectors) } }, { updatedBy: ctx.actor.role });
          await recordAction(tx, { actor: ctx.actor, kind: 'update', action: 'agent.approve', args: { agent: id, version: saved.version, granted: granted.systems, patients: granted.patients, mustCite: granted.mustCite, narrowed: saved.approval.how === 'narrowed', connectors: saved.connectors.enabled, newVersion: changed }, entityRef: `Agent/${id}`, versionId: saved.meta.versionId, description: `agent ${id} approved (${saved.approval.how})` });
          return saved;
        });
        const key = out.connectors?.enabled && state.connectors ? await state.connectors.ensureKey(out, ctx.actor) : null;
        return { status: 200, body: { ...presentAgent(out), ...(key?.token ? { connectorKey: key.token, connectorKeyNote: 'Shown once. It carries the agent\'s permissions.' } : {}) } };
      }
      if (parts.length === 3 && op === 'run' && method === 'POST') {
        human();
        const run = await launch({ agentId: id, mode: body?.mode, subject: body?.subject, goal: body?.goal, actor: ctx.actor, wait: body?.wait !== false, friction: body?.friction, overlays: body?.overlays, context: body?.context, condition: body?.condition, capabilities: body?.capabilities, clock: body?.clock, askTimeoutMs: body?.askTimeoutMs, timeline: body?.timeline, caseId: body?.caseId, study: body?.study, permissions: body?.permissions, hitl: body?.mode === 'hitl' ? { practice: body?.practice === true, targetBranch: body?.targetBranch, askFrequency: body?.askFrequency, confidenceThreshold: body?.confidenceThreshold, probe: body?.probe === true, syntheticAttested: body?.syntheticAttested } : null, trigger: { kind: 'manual', actor: ctx.actor.id, role: ctx.actor.role, at: store.now() } });
        return { status: 201, body: withStatus(run) };
      }
    }
    if (area === 'kill-switches' && parts.length === 1) {
      if (method === 'GET') return { status: 200, body: { ...(await listSwitches(store)), running: (await runningAgentRuns()).length } };
      if (method === 'POST') { human(); return { status: 200, body: await setKillSwitch(body, ctx.actor) }; }
    }
    if (area === 'red-team' && state.redTeam) {
      const out = await state.redTeam.handle(req, url, body, ctx, parts);
      if (out) return out;
    }
    for (const part of [state.rl, state.ablation, ...state.parts]) {
      if (!part) continue;
      const out = await part.handle(req, url, body, ctx, parts);
      if (out) return out;
    }
    if (area === 'gate' && parts.length === 1) {
      if (method === 'GET') return { status: 200, body: await gateConfig(store) };
      if (method === 'PUT') { human(); return { status: 200, body: await setGateConfig(store, body, ctx.actor) }; }
    }
    if (area === 'proposals' && state.hitl) {
      if (parts.length === 1 && method === 'GET') {
        return { status: 200, body: { proposals: await state.hitl.list(ctx, { subject: url.searchParams.get('subject'), status: url.searchParams.get('status'), runId: url.searchParams.get('runId'), detail: url.searchParams.get('detail') !== 'false' }) } };
      }
      if (parts.length === 3 && method === 'POST' && op === 'decide') return { status: 200, body: await state.hitl.decide(id, body, ctx) };
      if (parts.length === 3 && method === 'POST' && op === 'seen') return { status: 200, body: await state.hitl.seen(id, ctx) };
    }
    if (area === 'hitl' && parts.length === 1 && method === 'GET' && state.hitl) {
      return { status: 200, body: await state.hitl.report({ agentId: url.searchParams.get('agentId'), version: url.searchParams.get('version'), study: url.searchParams.get('study') }) };
    }
    if (area === 'shadow' && parts.length === 1 && method === 'GET') {
      return { status: 200, body: await shadowReport(store, { agentId: url.searchParams.get('agentId'), version: url.searchParams.get('version'), study: url.searchParams.get('study') }) };
    }
    return null;
  }

  return {
    handle, launch, setKillSwitch, onStudyOpened, onCommitted, onChartOpened, turn,
    setTurns(turns) { state.turns = turns; },
    setSimClock(clock) { state.simClock = clock; },
    runScenarioAgent,
    setBaseUrl(url) { state.baseUrl = url; },
    setHitl(hitl) { state.hitl = hitl; },
    setModels(models) { state.models = models; },
    setRedTeam(redTeam) { state.redTeam = redTeam; },
    setRl(rl) { state.rl = rl; },
    setAblation(ablation) { state.ablation = ablation; },
    setParts(parts) { state.parts = parts; },
    setConnectors(c) { state.connectors = c; },
    get baseUrl() { return state.baseUrl; },
    get hitl() { return state.hitl; },
    work, rawRequest, agentActor, track(promise) { active.add(promise); promise.finally(() => active.delete(promise)); return promise; },
    get ready() { return Boolean(state.baseUrl) && !state.closing; },
    modelCaller,
    canRun: (agent) => agent.adapter.kind === 'stub' || agent.adapter.kind === 'harness' || (agent.adapter.kind === 'model' ? Boolean(modelAvailability(env)[agent.adapter.model || 'stub']?.available) : externalAgentsAllowed(env)),
    /** Resolves when no agent run or trigger is in flight. */
    async idle() { while (active.size) await Promise.allSettled([...active]); },
    async close() { state.closing = true; await Promise.allSettled([...active]); },
  };
}
