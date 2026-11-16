// The environment API (plan-master task 15): a Gymnasium-style protocol
// (reset, step, state, close, tasks) over HTTP and WebSocket, the same tools
// as an MCP server per episode, API keys scoped to task sets, budgets,
// simulated people, and determinism. Every episode is a normal Run with
// TraceSteps on its own rollout branch, so the trace viewer, grading,
// review and datasets all work on training episodes too. Off by default.
import fs from 'node:fs';
import { createSimulator, scriptFromChart, PERSONAS } from '../../simulated-consultation/server/patient-sim.mjs';
import { visitCase } from '../../simulated-consultation/server/visits.mjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { namedOrRefuse } from './training-runs.mjs';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { createRun, endRun, withStatus } from './runs.mjs';
import { briefingFor, toolsFor, hasCap } from './capabilities.mjs';
import { briefingAge } from '../../ehr/server/age.mjs';
import { answerQuestion } from './turns.mjs';
import { parse as parseDicom, pixels, toRGBA, autoWindow } from '../../pacs/server/dicom.mjs';
import { dicomRoot, instancePath, studyUidOf } from '../../pacs/server/dicom.mjs';
import { encodePng, resampleGrey } from '../../viewers/server/png.mjs';
import { ENVIRONMENT_VERSION, GRADING_VERSION, CANARY, ENV_PROTOCOL } from '../../platform/server/versions.mjs';

export const DEFAULT_BUDGETS = { maxSteps: 40, maxSimMinutes: 24 * 60, maxWallMs: 10 * 60 * 1000 };
export const STEP_MINUTES = 5;
const KEY_PREFIX = 'hd_env_';
const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'org';
const nowMs = () => Date.now();

/** The named tools with JSON schemas (15.2). The allowed resource types follow the run's capabilities. */
export function toolSchemas(run) {
  const base = toolsFor(run);
  const types = (name) => base.find((t) => t.name === name)?.allowedResourceTypes || ['any'];
  const list = [
    { name: 'read-chart', description: 'Read one record of the patient\'s chart as the episode sees it', inputSchema: { type: 'object', properties: { type: { type: 'string', enum: types('read') }, id: { type: 'string' } }, required: ['type', 'id'] } },
    { name: 'search-results', description: 'Search records of one type (FHIR search parameters)', inputSchema: { type: 'object', properties: { type: { type: 'string', enum: types('search') }, params: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['type'] } },
    { name: 'view-image', description: 'A rendered frame or region of an imaging study (PNG) with window, level and zoom, plus DICOM metadata; slides return a tile', inputSchema: { type: 'object', properties: { study: { type: 'string' }, series: { type: 'integer', minimum: 0 }, instance: { type: 'integer', minimum: 0 }, frame: { type: 'integer', minimum: 0 }, window: { type: 'number' }, level: { type: 'number' }, zoom: { type: 'number', minimum: 0.1, maximum: 4 }, region: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' } } }, tileLevel: { type: 'integer' }, tileX: { type: 'integer' }, tileY: { type: 'integer' } }, required: ['study'] } },
    { name: 'draft-note', description: 'Draft a clinical note (stays unsigned)', inputSchema: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' } }, required: ['text'] } },
    { name: 'draft-reply', description: 'Draft a reply to a patient message with a priority label (stays unsent)', inputSchema: { type: 'object', properties: { message: { type: 'string', description: 'Communication id' }, text: { type: 'string' }, label: { type: 'string', enum: ['urgent', 'routine', 'low'] } }, required: ['message', 'text'] } },
    { name: 'propose-order', description: 'Propose an order or prescription (stays unsigned)', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['ServiceRequest', 'MedicationRequest'] }, code: { type: 'string', description: 'LOINC:2823-3, RxNorm:5224, LOCAL:ct-head, ICD-10:J18.9' }, display: { type: 'string' }, priority: { type: 'string', enum: ['routine', 'urgent', 'stat'] }, dose: { type: 'number' }, unit: { type: 'string' }, instructions: { type: 'string' }, reason: { type: 'string' } }, required: ['kind', 'code'] } },
    { name: 'diagnose', description: 'Record a working diagnosis (provisional)', inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'ICD-10:I26.99' }, display: { type: 'string' } }, required: ['code'] } },
    { name: 'ask-clinician', description: 'Ask the clinician for permission (with the exact action), ask a question, or say you are unsure or stuck; a simulated person or the lab\'s own simulated user replies', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['permission', 'question', 'low-confidence', 'stuck'] }, text: { type: 'string' }, action: { type: 'object' } }, required: ['kind', 'text'] } },
    { name: 'raise-alert', description: 'Raise an alert for the care team when something looks dangerous', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'talk-to-patient', description: 'Say something to the simulated patient and get the reply. The patient tells a hidden fact only when asked for it. There is a turn limit.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'reply', description: 'Answer a waiting request yourself (when the episode was reset with simulatedUser: client)', inputSchema: { type: 'object', properties: { decision: { type: 'string', enum: ['approve', 'deny', 'answer'] }, text: { type: 'string' } }, required: ['decision'] } },
    { name: 'finish', description: 'Hand back with an answer and a short summary; the episode ends and is graded', inputSchema: { type: 'object', properties: { answer: { type: 'string' }, summary: { type: 'string' } } } },
  ];
  const caps = Array.isArray(run?.capabilities) ? run.capabilities : null;
  return list.filter((t) => !caps || (t.name !== 'ask-clinician' || caps.includes('agent-may-ask')) && (t.name !== 'raise-alert' || caps.includes('proactive-alerts')));
}

export function createEnvApi({ store, agents, grading, taskSets, episodes, turns = null, trainingRuns = null, env = process.env }) {
  let loopRef = null; // the improvement loop, for trainers registering versions
  let upgradeGuard = null; // async (req) => true to refuse a WebSocket
  const enabled = () => env.ENV_API_ENABLED === 'true';
  const buckets = new Map();
  const live = new Map();

  // ---------- Keys (15.4) ----------
  async function createKey(body, ctx) {
    if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only a person can make environment keys');
    const org = String(body?.org || body?.label || '').trim().slice(0, 80);
    if (!org) throw new HttpError(422, 'Type the organisation label this key is for');
    const sets = Array.isArray(body?.taskSets) && body.taskSets.length ? body.taskSets.map(String) : ['*'];
    const rateLimit = Math.max(10, Math.min(100000, Number(body?.rateLimit) || 600));
    const token = `${KEY_PREFIX}${randomBytes(24).toString('hex')}`;
    const doc = { resourceType: 'ApiKey', id: randomUUID(), org, hash: hashToken(token), prefix: token.slice(0, 12), taskSets: sets, rateLimit, evaluation: Boolean(body?.evaluation), createdAt: store.now(), createdBy: ctx.actor.id, revokedAt: null, lastUsedAt: null };
    await store.transaction(async (tx) => { await tx.save('ApiKey', doc, { updatedBy: ctx.actor.role }); await recordAction(tx, { actor: ctx.actor, kind: 'create', action: 'env.key.create', args: { key: doc.id, org, taskSets: sets, evaluation: doc.evaluation }, entityRef: `ApiKey/${doc.id}`, description: `environment key created for ${org}` }); });
    const { hash, ...safe } = doc;
    return { ...safe, token, note: 'Copy the token now. It is stored hashed and never shown again.' };
  }
  const presentKey = ({ hash, _seq, ...k }) => k;
  async function listKeys() { return (await store.query('ApiKey')).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(presentKey); }
  async function revokeKey(id, ctx) {
    if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only a person can revoke environment keys');
    const k = await store.get('ApiKey', id); if (!k) throw new HttpError(404, 'No such key');
    const saved = await store.transaction(async (tx) => { const out = await tx.save('ApiKey', { ...k, revokedAt: store.now() }, { updatedBy: ctx.actor.role }); await recordAction(tx, { actor: ctx.actor, kind: 'update', action: 'env.key.revoke', args: { key: id }, entityRef: `ApiKey/${id}`, description: `environment key revoked (${k.org})` }); return out; });
    return presentKey(saved);
  }
  async function authorize(headers) {
    if (!enabled()) throw new HttpError(503, 'The environment API is off on this server. Set ENV_API_ENABLED=true to switch it on', 'disabled');
    const auth = String(headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token.startsWith(KEY_PREFIX)) throw new HttpError(401, 'Send an environment API key as a bearer token (Authorization: Bearer hd_env_...)', 'unauthorized');
    const hash = hashToken(token);
    const key = (await store.query('ApiKey')).find((k) => k.hash === hash);
    if (!key || key.revokedAt) throw new HttpError(401, 'That environment key is not valid', 'unauthorized');
    const b = buckets.get(key.id) || { windowStart: nowMs(), count: 0 };
    if (nowMs() - b.windowStart > 60000) { b.windowStart = nowMs(); b.count = 0; }
    b.count += 1; buckets.set(key.id, b);
    if (b.count > key.rateLimit) throw new HttpError(429, `Rate limit of ${key.rateLimit} requests a minute reached for this key`, 'throttled');
    return key;
  }

  // ---------- Tasks (15.1, 17) ----------
  const stripAnswers = ({ goldActions, avoid, verifier, rules, graderConfig, script, _seq, meta, ...c }) => ({ ...c, hasRubric: Boolean(rules?.rubric?.length), checks: (rules?.checks?.length ?? goldActions?.length ?? 0), canary: CANARY });
  async function reachable(key) {
    const all = await store.query('TaskSet');
    const sets = key.taskSets.includes('*') ? all : all.filter((s) => key.taskSets.includes(s.id) || key.taskSets.includes(s.family));
    const allowed = new Map();
    for (const s of sets) for (const t of s.tasks) if (t.part === 'practice' || key.evaluation) allowed.set(t.taskId, { taskSet: s, part: t.part });
    const cases = await store.query('EvalCase');
    if (key.taskSets.includes('*')) for (const c of cases) if (!allowed.has(c.id) && (c.split !== 'eval' || key.evaluation)) allowed.set(c.id, { taskSet: null, part: c.split === 'eval' ? 'test' : 'practice' });
    return { allowed, sets, cases };
  }
  async function tasks(key, filters = {}) {
    const { allowed, sets, cases } = await reachable(key);
    const diff = await taskSets.difficulty();
    const list = cases.filter((c) => allowed.has(c.id) && (!filters.taskSet || allowed.get(c.id)?.taskSet?.id === filters.taskSet) && (!filters.part || allowed.get(c.id)?.part === filters.part)).map((c) => ({ ...stripAnswers(c), part: allowed.get(c.id).part, taskSet: allowed.get(c.id).taskSet?.id ?? null, taskVersion: c.version || 1, difficulty: diff[c.id] || null }));
    return { tasks: list, taskSets: sets.map((s) => ({ id: s.id, name: s.name, version: s.version, status: s.status, practice: s.tasks.filter((t) => t.part === 'practice').length, test: key.evaluation ? s.tasks.filter((t) => t.part === 'test').length : 0 })), versions: { environment: ENVIRONMENT_VERSION, grading: GRADING_VERSION }, protocol: ENV_PROTOCOL, canary: CANARY };
  }

  // ---------- Episodes ----------
  async function ensureAgent(org) {
    const id = `env-${slug(org)}`;
    const existing = await store.get('Agent', id);
    if (existing) return existing;
    return store.save('Agent', { resourceType: 'Agent', id, name: `Environment client (${org})`, version: '1.0.0', capability: 'clinical-workup', description: 'A trainer\'s policy acting through the environment API. Every action goes through the safety envelope and the log.', enabled: true, stage: 'shadow', scopes: ['ServiceRequest', 'MedicationRequest', 'Condition', 'DocumentReference', 'Task', 'Communication', 'DiagnosticReport', 'Flag'].map((type) => ({ type, interactions: ['create', 'update'] })), adapter: { kind: 'stub', stub: 'environment-client' }, policyHash: hashToken(`env:${org}`).slice(0, 16), actionSchema: { input: 'task', output: 'drafts on the episode branch', tools: toolSchemas({}).map((t) => t.name) }, shadow: { event: false, task: false }, limits: { maxSteps: 1000, timeoutMs: 3600000 }, hitl: { auto: false, askFrequency: 'orders-signing' }, registeredAt: store.now(), knownLimits: 'Whatever the trainer\'s policy does; the environment only limits and logs it.' }, { updatedBy: 'system' });
  }
  const info = (run, extra = {}) => ({ episodeId: run.id, versions: { environment: ENVIRONMENT_VERSION, task: run.env?.taskVersion ?? 1, grading: GRADING_VERSION }, taskId: run.caseId, condition: run.condition, seed: run.seed, steps: run.env?.steps ?? 0, simMinutes: run.env?.simMinutes ?? 0, budgets: run.env?.budgets, canary: CANARY, ...extra });
  /** Optimistic writes retry on a concurrent-write conflict (PostgreSQL lets transactions overlap). */
  const retrying = async (fn) => { for (let i = 0; ; i += 1) { try { return await fn(); } catch (err) { if (err.code !== 'conflict' || i >= 6) throw err; await new Promise((r) => setTimeout(r, 15 * (i + 1) + Math.random() * 20)); } } };
  const patch = (id, fn) => retrying(() => store.transaction(async (tx) => { const r = await tx.get('Run', id); const out = await tx.save('Run', fn(r), { updatedBy: 'system' }); return out; }));
  /** Observations are deterministic: no timestamps or version numbers, and ids made in this episode are numbered. */
  function present(run, value) {
    const ids = run.env?.ids || {};
    const clean = (v) => {
      if (Array.isArray(v)) return v.map(clean);
      if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) { if (k === 'meta' || k.startsWith('_') || k === 'lastUpdated') continue; o[k] = clean(v[k]); } return o; }
      if (typeof v === 'string') { for (const [real, label] of Object.entries(ids)) if (v.includes(real)) v = v.split(real).join(label); return v; }
      return v;
    };
    return clean(value);
  }
  const remember = (run, type, id) => { const ids = { ...(run.env.ids || {}) }; const n = Object.keys(ids).length + 1; ids[id] = `new-${n}`; run.env.ids = ids; return `${type}/${id}`; };

  async function reset(key, body, named = null) {
    const taskId = body?.task ? String(body.task) : body?.taskId ? String(body.taskId) : null;
    let evalCase = null; let taskSet = null; let part = 'practice';
    const { allowed } = await reachable(key);
    if (taskId) { evalCase = await store.get('EvalCase', taskId); if (!evalCase) throw new HttpError(404, `No task "${taskId}"`); }
    else if (body?.taskSet) { const s = await store.get('TaskSet', String(body.taskSet)); if (!s) throw new HttpError(404, `No task set "${body.taskSet}"`); const idx = Number(body.index) || 0; const t = s.tasks[idx]; if (!t) throw new HttpError(404, `Task set "${s.name}" has no task at index ${idx}`); evalCase = await store.get('EvalCase', t.taskId); taskSet = s; part = t.part; }
    else throw new HttpError(422, 'reset needs taskId, or taskSet and index');
    if (!evalCase) throw new HttpError(404, 'The task is missing from the case bank');
    const reach = allowed.get(evalCase.id);
    if (!reach) throw new HttpError(403, `This key cannot reach task "${evalCase.id}"${evalCase.split === 'eval' ? ' (a held-out test task: only evaluation keys may use it)' : ''}`, 'forbidden');
    taskSet = taskSet || reach.taskSet; part = reach.part;
    if (part === 'test' && !key.evaluation) throw new HttpError(403, 'Held-out test tasks are never served for training', 'forbidden');
    const seed = Number.isInteger(body?.seed) ? body.seed : 0;
    const condition = body?.condition ? String(body.condition) : 'autonomous';
    const agent = await ensureAgent(key.org);
    // The attempt joins its training run (made now if this run name is new for the agent). Eval tasks are refused here.
    const link = named && trainingRuns ? await trainingRuns.admit({ agent, name: named.run, task: evalCase, seed, source: 'api', taskSet: taskSet?.id ?? null, actor: agents.agentActor(agent) }) : null;
    const budgets = { ...DEFAULT_BUDGETS, ...(evalCase.budgets || {}), ...(body?.budgets && typeof body.budgets === 'object' ? Object.fromEntries(Object.entries(body.budgets).filter(([k, v]) => (k in DEFAULT_BUDGETS || k === 'maxPatientTurns') && Number(v) > 0).map(([k, v]) => [k, Number(v)])) : {}) };
    const run = await createRun(store, { mode: 'rl-generate', ...(link ? { attempt: link } : {}), agentId: agent.id, caseId: evalCase.id, subject: evalCase.patient, goal: evalCase.task, seed, condition, parentBranch: 'main', forkedAt: evalCase.asOf, friction: 'realistic', record: { organisation: key.org, harness: 'theirs', provider: body?.provider ?? null, model: body?.model ?? null }, trigger: { kind: 'environment', actor: `org:${key.org}`, role: 'trainer', at: store.now(), key: key.id }, context: { org: key.org, scenario: evalCase.scenario, doneWhen: evalCase.doneWhen ?? null, mustNot: evalCase.mustNot ?? null, patientRef: evalCase.patient } }, { kind: 'human', id: `org:${key.org}`, role: 'trainer' });
    const envState = { org: key.org, keyId: key.id, taskSet: taskSet?.id ?? null, part, taskVersion: evalCase.version || 1, budgets, steps: 0, simMinutes: 0, startedWall: nowMs(), status: 'running', ids: {}, persona: typeof body?.persona === 'string' ? body.persona : (evalCase.persona || 'cooperative'), simulatedUser: body?.simulatedUser === 'client' ? 'client' : 'rule-based', waiting: null, stepRewards: Boolean(taskSet?.stepRewards), calls: [] };
    const fresh = await patch(run.id, (r) => ({ ...r, env: envState, patientRef: evalCase.patient }));
    const briefing = briefingFor({ trigger: { kind: 'task', task: evalCase.task, at: fresh.startedAt }, run: fresh, agent, task: { scenario: evalCase.scenario, goal: evalCase.task, doneWhen: evalCase.doneWhen ?? null, mustNot: evalCase.mustNot ?? null, timeLimit: `${budgets.maxSteps} steps, ${budgets.maxSimMinutes} simulated minutes` }, conversation: [] });
    briefing.patientAge = await briefingAge(store, fresh, briefing.patient);
    await store.transaction((tx) => recordAction(tx, { runId: run.id, actor: agents.agentActor(agent), kind: 'execute', action: 'turn.start', args: { trigger: 'task', briefing, episode: true }, why: 'Episode reset: the briefing records what the policy was told', branch: run.branch, entityRef: `Run/${run.id}`, description: 'environment episode started' }));
    live.set(run.id, { agent, evalCase, taskSet });
    const tools = toolSchemas(fresh);
    return { episodeId: run.id, observation: present(fresh, { briefing, events: [], messages: [], note: 'Act with one tool call per step; finish when done.' }), tools, info: info(fresh, { taskSet: taskSet?.id ?? null, part, protocol: ENV_PROTOCOL }) };
  }

  const episodeOf = async (key, id) => { const run = await store.get('Run', String(id || '')); if (!run?.env) throw new HttpError(404, 'No such episode'); if (run.env.org !== key.org) throw new HttpError(403, 'That episode belongs to another organisation', 'forbidden'); return run; };
  const ctxOf = async (run) => { let c = live.get(run.id); if (!c) { const agent = await store.get('Agent', run.agentId); const evalCase = await store.get('EvalCase', run.caseId); const taskSet = run.env.taskSet ? await store.get('TaskSet', run.env.taskSet) : null; c = { agent, evalCase, taskSet }; live.set(run.id, c); } return c; };
  const codeOf = (code) => { const [sys, val] = String(code).includes(':') ? String(code).split(':') : ['LOCAL', String(code)]; const systems = { LOINC: 'http://loinc.org', RXNORM: 'http://www.nlm.nih.gov/research/umls/rxnorm', 'ICD-10': 'http://hl7.org/fhir/sid/icd-10-cm', LOCAL: 'urn:hospital-desktop:order' }; return { system: systems[sys.toUpperCase()] || sys, code: val }; };

  /** Rule-based simulated person (15.3): answers permission requests and questions from the case's script or the chart. */
  async function simulatedReply(run, evalCase, request, tools) {
    const script = evalCase.script || {};
    for (const r of script.replies || []) { try { if (new RegExp(r.match, 'i').test(request.text)) return { decision: r.decision || 'answer', text: r.reply }; } catch { /* bad pattern */ } }
    if (request.kind === 'permission') {
      const label = `${request.action?.label || ''} ${request.text}`.toLowerCase();
      const allergies = await tools.search('AllergyIntolerance', { patient: evalCase.patient.split('/')[1] }, 'Simulated clinician checks allergies before approving').catch(() => []);
      const clash = allergies.some((a) => { const n = (a.code?.text || a.code?.coding?.[0]?.display || '').toLowerCase(); return n && label.includes(n); });
      if (clash) return { decision: 'deny', text: 'No: the patient is allergic to that.' };
      if (/\b(\d{3,})\s*mg\b/.test(label)) return { decision: 'deny', text: 'No: that dose is far above the usual range.' };
      return { decision: 'approve', text: script.default?.permission || 'Yes, go ahead.' };
    }
    if (request.kind === 'question') { const a = await answerQuestion({ question: request.text, patientId: evalCase.patient.split('/')[1], tools }); return { decision: 'answer', text: a.text }; }
    return { decision: 'answer', text: script.default?.stuck || 'Do what the task says and finish when you are done.' };
  }

  async function step(key, body) {
    const run = await episodeOf(key, body?.episodeId);
    if (run.endedAt || run.env.status !== 'running') throw new HttpError(409, 'This episode has ended');
    const { agent, evalCase, taskSet } = await ctxOf(run);
    const action = body?.action && typeof body.action === 'object' ? body.action : null;
    if (!action?.tool) throw new HttpError(422, 'action must be { tool, args }');
    const args = action.args && typeof action.args === 'object' ? action.args : {};
    const b = run.env.budgets;
    const over = run.env.steps + 1 > b.maxSteps ? 'maxSteps' : run.env.simMinutes + STEP_MINUTES > b.maxSimMinutes ? 'maxSimMinutes' : nowMs() - run.env.startedWall > b.maxWallMs ? 'maxWallMs' : null;
    if (over) { const out = await finishEpisode(run, { truncated: true, reason: `budget ${over} exceeded` }); return { observation: present(out.run, { result: null, events: [], messages: [`Episode truncated: ${over} exceeded`] }), reward: out.reward, done: true, truncated: true, info: info(out.run, { rewardBreakdown: out.breakdown, reason: `budget ${over} exceeded` }) }; }
    const patientId = String(evalCase.patient).split('/')[1];
    const why = String(action.reasoning || action.why || '').slice(0, 600);
    const req = (method, path, payload) => agents.rawRequest(run, agent, method, path, payload, why || `environment step ${run.env.steps + 1}: ${action.tool}`);
    const tools = { search: async (type, params = {}) => { const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString(); const r = await req('GET', `/fhir/R4/${type}${q ? `?${q}` : ''}`); return (r.json?.entry || []).map((e) => e.resource); } };
    const subject = { reference: evalCase.patient };
    // Deterministic: the episode's clock starts at the task's frozen moment, not the wall clock.
    const simTime = new Date(Date.parse(evalCase.asOf) + (run.env.simMinutes + STEP_MINUTES) * 60000).toISOString();
    let result; let refused = false; let done = false; let messages = []; let waiting = null;
    const write = async (type, resource) => { const r = await req('POST', `/fhir/R4/${type}`, resource); if (r.status >= 400) { refused = true; return { refused: true, status: r.status, error: r.json?.issue?.[0]?.diagnostics || r.json?.error || `HTTP ${r.status}` }; } const id = r.json?.id; const ref = remember(run, type, id); return { written: ref, resource: r.json }; };
    const caps = Array.isArray(run.capabilities) ? run.capabilities : null;
    let patientState = null;
    switch (action.tool) {
      case 'read-chart': { const r = await req('GET', `/fhir/R4/${encodeURIComponent(args.type)}/${encodeURIComponent(args.id)}`); result = r.status >= 400 ? { refused: true, status: r.status, error: r.json?.issue?.[0]?.diagnostics || r.json?.error } : { resource: r.json }; refused = r.status >= 400; break; }
      case 'search-results': { const q = new URLSearchParams(Object.entries(args.params || {}).map(([k, v]) => [k, String(v)])); if (!q.has('patient') && !q.has('subject') && args.type !== 'Patient') q.set('patient', patientId); const r = await req('GET', `/fhir/R4/${encodeURIComponent(args.type)}?${q.toString()}`); result = r.status >= 400 ? { refused: true, status: r.status, error: r.json?.issue?.[0]?.diagnostics || r.json?.error } : { total: r.json?.total ?? 0, resources: (r.json?.entry || []).map((e) => e.resource) }; refused = r.status >= 400; break; }
      case 'view-image': result = await viewImage(run, agent, args, req); refused = Boolean(result.refused); break;
      case 'draft-note': result = await write('DocumentReference', { resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', type: { text: String(args.title || 'Note').slice(0, 120) }, subject, date: simTime, content: [{ attachment: { contentType: 'text/plain', data: Buffer.from(String(args.text || ''), 'utf8').toString('base64') } }] }); break;
      case 'draft-reply': { const label = ['urgent', 'routine', 'low'].includes(args.label) ? args.label : 'routine'; result = await write('Task', { resourceType: 'Task', status: 'requested', intent: 'proposal', priority: label === 'urgent' ? 'urgent' : 'routine', authoredOn: simTime, code: { coding: [{ system: 'urn:hospital-desktop:task', code: 'message-triage' }], text: 'Message triage' }, focus: { reference: `Communication/${args.message}` }, for: subject, description: `Suggested priority: ${label}`, output: [{ type: { text: 'triage-label' }, valueString: label }, { type: { text: 'suggested-reply' }, valueString: String(args.text || '').slice(0, 2000) }] }); break; }
      case 'propose-order': { const kind = args.kind === 'MedicationRequest' ? 'MedicationRequest' : 'ServiceRequest'; const coding = { coding: [{ ...codeOf(args.code), display: args.display }], text: args.display || String(args.code) }; result = kind === 'ServiceRequest' ? await write('ServiceRequest', { resourceType: 'ServiceRequest', status: 'active', intent: 'order', priority: ['routine', 'urgent', 'stat'].includes(args.priority) ? args.priority : 'routine', subject, authoredOn: simTime, category: [{ coding: [{ system: 'urn:hospital-desktop:order-category', code: args.category || 'laboratory' }] }], code: coding, ...(args.reason ? { reasonCode: [{ text: String(args.reason).slice(0, 300) }] } : {}) }) : await write('MedicationRequest', { resourceType: 'MedicationRequest', status: 'draft', intent: 'order', subject, authoredOn: simTime, medicationCodeableConcept: coding, dosageInstruction: [{ text: String(args.instructions || `${args.dose ?? ''} ${args.unit ?? ''}`).trim() || 'As directed', ...(args.dose ? { doseAndRate: [{ doseQuantity: { value: Number(args.dose), unit: args.unit || 'mg' } }] } : {}) }] }); break; }
      case 'diagnose': result = await write('Condition', { resourceType: 'Condition', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] }, verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'provisional' }] }, code: { coding: [{ ...codeOf(args.code), display: args.display }], text: args.display || String(args.code) }, subject, recordedDate: simTime }); break;
      case 'raise-alert': { if (caps && !caps.includes('proactive-alerts')) { refused = true; result = { refused: true, status: 403, error: 'Raising an alert needs the "proactive-alerts" capability' }; await store.transaction((tx) => recordAction(tx, { runId: run.id, actor: agents.agentActor(agent), kind: 'execute', action: 'envelope.reject', args: { rule: 'capability-off', tool: 'raise-alert' }, branch: run.branch, entityRef: `Run/${run.id}`, description: 'alert refused: capability off' })); break; } result = await write('Flag', { resourceType: 'Flag', status: 'active', code: { text: String(args.text || 'Alert').slice(0, 300) }, subject }); break; }
      case 'ask-clinician': {
        if (caps && !caps.includes('agent-may-ask')) { refused = true; result = { refused: true, status: 403, error: 'Asking needs the "agent-may-ask" capability, which is not switched on for this episode' }; await store.transaction((tx) => recordAction(tx, { runId: run.id, actor: agents.agentActor(agent), kind: 'execute', action: 'envelope.reject', args: { rule: 'capability-off', tool: 'ask-clinician' }, branch: run.branch, entityRef: `Run/${run.id}`, description: 'ask refused: capability off' })); break; }
        const kind = ['permission', 'question', 'low-confidence', 'stuck'].includes(args.kind) ? args.kind : 'question';
        const request = { kind, text: String(args.text || '').slice(0, 1000), action: args.action && typeof args.action === 'object' ? args.action : null };
        const { traceStepId } = await store.transaction((tx) => recordAction(tx, { runId: run.id, actor: agents.agentActor(agent), kind: 'execute', action: 'panel.request', args: { ...request }, branch: run.branch, entityRef: `Run/${run.id}`, approval: { status: 'proposed' }, description: `agent ${kind} request` }));
        if (run.env.simulatedUser === 'client') { waiting = { request: traceStepId, ...request }; result = { waiting: true, request: traceStepId, note: 'Answer with the reply tool' }; break; }
        const reply = await simulatedReply(run, evalCase, request, tools);
        await store.transaction((tx) => recordAction(tx, { runId: run.id, actor: { kind: 'human', id: 'simulated-clinician', role: 'simulated' }, kind: 'execute', action: 'panel.decide', args: { kind: reply.decision === 'approve' ? 'approved' : reply.decision === 'deny' ? 'denied' : 'answered', request: traceStepId, decision: reply.decision === 'approve' ? 'approved' : reply.decision === 'deny' ? 'denied' : 'answered', text: reply.text, simulated: true }, branch: run.branch, entityRef: `Run/${run.id}`, approval: { status: reply.decision === 'approve' ? 'approved' : reply.decision === 'deny' ? 'rejected' : 'answered' }, description: `simulated clinician ${reply.decision}` }));
        messages.push({ from: 'clinician (simulated)', decision: reply.decision, text: reply.text }); result = { reply };
        break;
      }
      case 'talk-to-patient': {
        // The simulated patient (part 4.1): the visit script the task names, or a simple patient made from the chart. Turns are messages in the log; the turn limit is a budget.
        const limit = Number(run.env.budgets?.maxPatientTurns) || 20;
        let script = evalCase.visitCase ? visitCase(evalCase.visitCase) : null;
        if (!script) { const get = async (type) => ((await req('GET', `/fhir/R4/${type}?patient=${patientId}`)).json?.entry || []).map((e) => e.resource); const [conditions, medications, allergies, encounters] = [await get('Condition'), await get('MedicationRequest'), await get('AllergyIntolerance'), await get('Encounter')]; script = scriptFromChart({ patient: { id: patientId }, conditions, medications, allergies, reason: encounters[0]?.reasonCode?.[0]?.text || '' }); }
        const sim = createSimulator(script, { persona: PERSONAS[run.env.persona] ? run.env.persona : 'cooperative', seed: run.seed ?? 0, turnLimit: limit, state: run.env.patient || null });
        const said = String(args.text || '').slice(0, 1000);
        const out = sim.reply(said); patientState = sim.state;
        await store.transaction((tx) => recordAction(tx, { runId: run.id, actor: agents.agentActor(agent), kind: 'execute', action: 'visit.turn', args: { who: 'interviewer', chars: said.length, text: said.slice(0, 300) }, branch: run.branch, entityRef: `Run/${run.id}`, description: 'agent spoke to the simulated patient', audit: false }));
        await store.transaction((tx) => recordAction(tx, { runId: run.id, actor: { kind: 'human', id: 'simulated-patient', role: 'simulated' }, kind: 'execute', action: 'visit.turn', args: { who: 'patient', revealed: out.revealed, redFlags: out.redFlags, persona: sim.persona, text: out.text.slice(0, 300), turn: patientState.turn, limit }, branch: run.branch, entityRef: `Run/${run.id}`, description: 'simulated patient answered', audit: false }));
        messages.push({ from: 'patient (simulated)', text: out.text });
        result = { reply: out.text, done: out.done, turn: patientState.turn, turnsLeft: Math.max(0, limit - patientState.turn) };
        break;
      }
      case 'reply': { if (!run.env.waiting) { result = { error: 'Nothing is waiting for a reply' }; break; } const decision = ['approve', 'deny', 'answer'].includes(args.decision) ? args.decision : 'answer'; await store.transaction((tx) => recordAction(tx, { runId: run.id, actor: { kind: 'human', id: `org:${key.org}:simulated-user`, role: 'simulated' }, kind: 'execute', action: 'panel.decide', args: { kind: decision === 'approve' ? 'approved' : decision === 'deny' ? 'denied' : 'answered', request: run.env.waiting.request, decision: decision === 'approve' ? 'approved' : decision === 'deny' ? 'denied' : 'answered', text: String(args.text || '').slice(0, 1000), simulated: true }, branch: run.branch, entityRef: `Run/${run.id}`, description: `the lab's simulated user ${decision}` })); result = { replied: decision }; waiting = null; run.env.waiting = null; break; }
      case 'finish': done = true; result = { finished: true }; break;
      default: throw new HttpError(422, `Unknown tool "${action.tool}". Tools: ${toolSchemas(run).map((t) => t.name).join(', ')}`);
    }
    // Simulated time moves on; due timeline events are released and reported.
    const events = [];
    const next = await patch(run.id, (r) => ({ ...r, env: { ...r.env, ids: run.env.ids, steps: r.env.steps + 1, simMinutes: r.env.simMinutes + STEP_MINUTES, waiting: waiting ?? (action.tool === 'reply' ? null : r.env.waiting), ...(patientState ? { patient: patientState } : {}), calls: [...(r.env.calls || []).slice(-200), { tool: action.tool, args: JSON.stringify(args).slice(0, 400) }] } }));
    if (Array.isArray(next.timeline) && next.timeline.some((e) => !e.releasedAt)) {
      const simAt = Date.parse(next.startedAt) + next.env.simMinutes * 60000;
      const due = next.timeline.filter((e) => !e.releasedAt && Date.parse(e.at) <= simAt);
      if (due.length && turns) { const out = await turns.releaseDue({ ...next, timeline: next.timeline.map((e) => (due.includes(e) ? { ...e, at: new Date(Date.parse(next.startedAt)).toISOString() } : e)) }, { actor: { kind: 'human', id: 'timeline', role: 'system' } }).catch(() => ({ released: [] })); for (const id of out.released || []) { const e = next.timeline.find((x) => x.id === id); events.push({ id, kind: e?.kind, title: e?.title || e?.kind, at: e?.at }); } }
    }
    let reward = 0; let breakdown = null;
    if (done) { const out = await finishEpisode(next, { truncated: false, reason: 'finished', answer: args }); reward = out.reward; breakdown = out.breakdown; }
    else if (next.env.stepRewards) { const repeat = (next.env.calls || []).slice(0, -1).some((c) => c.tool === action.tool && c.args === JSON.stringify(args).slice(0, 400)); reward = (refused ? -1 : 0) + (repeat ? -0.25 : 0); }
    const fresh = done ? await store.get('Run', run.id) : next;
    return { observation: present(fresh, { result, events, messages }), reward, done, truncated: false, info: info(fresh, { refused, ...(breakdown ? { rewardBreakdown: breakdown } : {}) }) };
  }

  async function finishEpisode(run, { truncated, reason, answer = null }) {
    const { evalCase, taskSet, agent } = await ctxOf(run);
    const current = await store.get('Run', run.id);
    const graded = await grading.grade({ run: current, evalCase, taskSet });
    const steps = await store.query('TraceStep', { groupKey: run.id });
    const episode = await episodes.saveEpisode({ id: `ep-${run.id}`, runId: run.id, kind: 'environment', agentId: run.agentId, version: agent?.version ?? null, caseId: evalCase.id, split: evalCase.split, batch: `env-${run.env.org}`, seed: run.seed, condition: run.condition, org: run.env.org, taskSet: taskSet?.id ?? null, state: { patient: evalCase.patient, asOf: evalCase.asOf, branch: run.branch, scenario: evalCase.scenario, task: evalCase.task, seed: run.seed }, action: { summary: answer?.summary ?? null, answer: answer?.answer ?? null, finished: !truncated }, trajectory: steps.map((s) => s.id), outcome: { raw: { checks: graded.chartChecks.rows, safetyViolations: graded.safety.violations }, rewardBreakdown: graded, totalReward: graded.total, stepRewards: graded.stepRewards, truncated, reason }, evaluations: [{ at: store.now(), score: graded.total }], timestamp: store.now() }, { kind: 'human', id: `org:${run.env.org}`, role: 'trainer' });
    await patch(run.id, (r) => ({ ...r, env: { ...r.env, status: truncated ? 'truncated' : 'done', reason, endedWall: nowMs() } }));
    const ended = await endRun(store, run.id, agents.agentActor(agent), truncated ? 'truncated' : 'completed', { episodeId: episode.id, reward: graded.total, truncated, reason, answer: answer?.answer ?? null, summary: answer?.summary ?? null, ...(answer?.usage && typeof answer.usage === 'object' ? { usage: { promptTokens: Number(answer.usage.promptTokens) || 0, completionTokens: Number(answer.usage.completionTokens) || 0 } } : {}) });
    live.delete(run.id);
    return { run: ended, reward: graded.total, breakdown: graded, episode };
  }

  async function state(key, id) {
    const run = await episodeOf(key, id);
    const b = run.env.budgets;
    const { evalCase } = await ctxOf(run);
    return { episodeId: run.id, status: run.env.status, steps: run.env.steps, simulatedTime: new Date(Date.parse(evalCase?.asOf || run.startedAt) + run.env.simMinutes * 60000).toISOString(), simMinutes: run.env.simMinutes, budgetLeft: { steps: Math.max(0, b.maxSteps - run.env.steps), simMinutes: Math.max(0, b.maxSimMinutes - run.env.simMinutes), wallMs: Math.max(0, b.maxWallMs - (nowMs() - run.env.startedWall)) }, waiting: run.env.waiting, info: info(run) };
  }
  async function close(key, id) {
    const run = await episodeOf(key, id);
    let out;
    if (!run.endedAt) out = await finishEpisode(run, { truncated: true, reason: 'closed by the client' });
    else { const ep = await store.get('Episode', `ep-${run.id}`); out = { run, reward: ep?.outcome?.totalReward ?? null, breakdown: ep?.outcome?.rewardBreakdown ?? null, episode: ep }; }
    return { episodeId: run.id, rewardBreakdown: out.breakdown, reward: out.reward, status: (await store.get('Run', run.id)).env.status, links: { trace: `/agent-ops/#/trace/${run.id}`, run: `/agent-ops/runs/${run.id}`, episode: out.episode ? `/agent-ops/episodes?id=${out.episode.id}` : null }, info: info(await store.get('Run', run.id)) };
  }

  /** view-image: a rendered frame (PNG, window and level applied, zoomed or cropped) plus metadata; slides return a tile. */
  async function viewImage(run, agent, args, req) {
    const r = await req('GET', `/fhir/R4/ImagingStudy/${encodeURIComponent(args.study)}`);
    if (r.status >= 400) return { refused: true, status: r.status, error: r.json?.issue?.[0]?.diagnostics || r.json?.error };
    const study = r.json;
    const modality = study.modality?.[0]?.code || study.series?.[0]?.modality?.code;
    const meta = { id: study.id, description: study.description, modality, started: study.started, numberOfSeries: study.numberOfSeries, numberOfInstances: study.numberOfInstances, series: (study.series || []).map((s) => ({ uid: s.uid, modality: s.modality?.code, number: s.number, instances: (s.instance || []).length, bodySite: s.bodySite?.display })) };
    if (modality === 'SM') { const level = Number(args.tileLevel) || 0; const x = Number(args.tileX) || 0; const y = Number(args.tileY) || 0; const tile = await agents.rawRequest(run, agent, 'GET', `/pathology/slides/${encodeURIComponent(study.id)}/tiles/${level}/${x}_${y}.jpg`, null, 'view a slide tile'); return { metadata: meta, tile: { level, x, y, status: tile.status }, note: tile.status === 200 ? 'Tile bytes are served at the tile route; the environment returns the metadata and the tile address' : 'No tile at that address', tileUrl: `/pathology/slides/${study.id}/tiles/${level}/${x}_${y}.jpg` }; }
    const series = (study.series || [])[Number(args.series) || 0];
    const inst = (series?.instance || [])[Number(args.instance) || 0];
    const studyUid = studyUidOf(study);
    if (!series?.uid || !inst?.uid || !studyUid) return { metadata: meta, image: null, reason: 'No DICOM instance is filed for this study' };
    const file = instancePath(dicomRoot(), studyUid, series.uid, inst.uid);
    if (!fs.existsSync(file)) return { metadata: meta, image: null, reason: 'The instance file is missing from the archive' };
    try {
      const parsed = parseDicom(fs.readFileSync(file));
      const px = pixels(parsed);
      const frameIndex = Math.min(px.frames - 1, Math.max(0, Number(args.frame) || 0));
      const frame = px.frame(frameIndex);
      const auto = px.windowCenter != null && px.windowWidth != null ? { center: px.windowCenter, width: px.windowWidth } : autoWindow(frame, px);
      const center = Number.isFinite(Number(args.level)) ? Number(args.level) : auto.center; const width = Number.isFinite(Number(args.window)) ? Number(args.window) : auto.width;
      const rgba = toRGBA(frame, px, { center, width });
      const grey = new Uint8Array(px.rows * px.columns); for (let i = 0; i < grey.length; i += 1) grey[i] = px.samples === 3 ? Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) : rgba[i * 4];
      const out = resampleGrey(grey, px.columns, px.rows, { zoom: args.zoom, region: args.region });
      const png = encodePng({ width: out.width, height: out.height, pixels: out.pixels, channels: 1 });
      await store.transaction((tx) => recordAction(tx, { runId: run.id, actor: agents.agentActor(agent), kind: 'read', action: 'image.view', args: { study: study.id, series: series.uid, instance: inst.uid, frame: frameIndex, window: width, level: center, zoom: out.zoom, region: out.region }, branch: run.branch, entityRef: `ImagingStudy/${study.id}`, patientRef: study.subject?.reference, description: `image viewed: ${study.description || study.id}` }));
      return { metadata: { ...meta, rows: px.rows, columns: px.columns, frames: px.frames, bitsStored: px.bitsStored, photometric: px.photometric, rowSpacing: px.rowSpacing, columnSpacing: px.columnSpacing, windowCenter: center, windowWidth: width }, image: { format: 'png', width: out.width, height: out.height, zoom: out.zoom, region: out.region, base64: png.toString('base64') } };
    } catch (err) { return { metadata: meta, image: null, reason: String(err.message).slice(0, 200) }; }
  }

  // ---------- MCP (15.2): JSON-RPC over HTTP, per episode ----------
  async function mcp(key, episodeId, msg) {
    const reply = (id, result) => ({ jsonrpc: '2.0', id: id ?? null, result });
    const fail = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(msg?.id, -32600, 'Invalid request');
    try {
      if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'hospital-desktop-environment', version: ENVIRONMENT_VERSION }, instructions: 'One tool call per step. Finish when done. Every action goes through the safety envelope.' });
      if (msg.method === 'notifications/initialized' || msg.method === 'ping') return reply(msg.id, {});
      const run = await episodeOf(key, episodeId);
      if (msg.method === 'tools/list') return reply(msg.id, { tools: toolSchemas(run) });
      if (msg.method === 'tools/call') { const out = await step(key, { episodeId, action: { tool: msg.params?.name, args: msg.params?.arguments || {} } }); return reply(msg.id, { content: [{ type: 'text', text: JSON.stringify({ observation: out.observation, reward: out.reward, done: out.done, truncated: out.truncated, info: out.info }) }], isError: Boolean(out.info?.refused), structuredContent: { reward: out.reward, done: out.done, truncated: out.truncated } }); }
      return fail(msg.id, -32601, `Method not found: ${msg.method}`);
    } catch (err) { return fail(msg.id, err.status === 404 ? -32602 : -32000, err.message); }
  }

  /** Checks that a call says which task, run name and seed it is for, and (after reset) that they match the attempt it names. */
  async function checkNamed(key, src, needAttempt) {
    const n = namedOrRefuse(src, { needAttempt });
    if (!needAttempt) return { n, run: null };
    const run = await episodeOf(key, n.attempt); const a = run.attempt || {};
    const wrong = [a.task !== n.task && 'task', a.runName !== n.run && 'run name', a.seed !== n.seed && 'seed'].filter(Boolean);
    if (wrong.length) throw new HttpError(409, `This attempt was opened with a different ${wrong.join(', ')}. Send the same task, run name and seed as on reset.`, 'mismatch');
    return { n, run };
  }
  /** reset, step, state or close, however it arrived (HTTP, WebSocket). */
  async function named(key, op, src) {
    const { n } = await checkNamed(key, src, op !== 'reset');
    if (op === 'reset') { const out = await reset(key, src, n); return { ...out, attempt: out.episodeId, run: n.run, task: n.task, seed: n.seed }; }
    if (op === 'step') return step(key, { ...src, episodeId: n.attempt });
    if (op === 'state') return state(key, n.attempt);
    return close(key, n.attempt);
  }

  // ---------- HTTP ----------
  async function handle(req, url, body) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'env' || parts[1] !== 'v1') return null;
    const m = req.method; const op = parts[2];
    if (op === 'info' && m === 'GET') return { status: 200, body: { enabled: enabled(), protocol: ENV_PROTOCOL, versions: { environment: ENVIRONMENT_VERSION, grading: GRADING_VERSION }, routes: ['POST /env/v1/reset', 'POST /env/v1/agent-versions', 'POST /env/v1/step', 'GET /env/v1/state?episodeId=', 'POST /env/v1/close', 'GET /env/v1/tasks', 'POST /env/v1/mcp/:episodeId', 'WS /env/v1/ws'], docs: '/docs/ENVIRONMENT-API.md', canary: CANARY } };
    const key = await authorize(req.headers);
    // A trainer registers a new agent version for a Reinforcement Learning study; the loop evaluates it.
    if (op === 'agent-versions' && m === 'POST' && parts.length === 3) { if (!loopRef) throw new HttpError(503, 'The improvement loop is not available on this server'); return { status: 201, body: await loopRef.registerVersion(body, key) }; }
    await store.transaction(async (tx) => { const k = await tx.get('ApiKey', key.id); if (k && (!k.lastUsedAt || nowMs() - Date.parse(k.lastUsedAt) > 60000)) await tx.save('ApiKey', { ...k, lastUsedAt: store.now() }, { updatedBy: 'system' }); }).catch(() => null);
    // The four calls. Each must say which agent (the key), task, run name and seed it is for; step, state and close also name the attempt.
    if (['reset', 'step', 'state', 'close'].includes(op)) {
      const src = m === 'GET' ? { ...Object.fromEntries(url.searchParams), attempt: parts[3] || url.searchParams.get('attempt') || url.searchParams.get('episodeId') } : (body || {});
      if ((op === 'state') !== (m === 'GET')) throw new HttpError(405, `${op} is a ${op === 'state' ? 'GET' : 'POST'}`);
      return { status: 200, body: await named(key, op, src) };
    }
    if (op === 'runs' && parts[3] === 'finish' && m === 'POST') { if (!trainingRuns) throw new HttpError(503, 'Runs are not available'); const agent = await ensureAgent(key.org); return { status: 200, body: await trainingRuns.finish(agent.id, String(body?.run || ''), agents.agentActor(agent)) }; }
    if (op === 'tasks' && m === 'GET') return { status: 200, body: await tasks(key, { taskSet: url.searchParams.get('taskSet'), part: url.searchParams.get('part') }) };
    if (op === 'mcp' && parts[3]) { if (m === 'GET') { await checkNamed(key, { ...Object.fromEntries(url.searchParams), attempt: parts[3] }, true); } if (m === 'GET') return { status: 200, body: { name: 'hospital-desktop-environment', transport: 'json-rpc over HTTP POST', episodeId: parts[3], tools: toolSchemas(await episodeOf(key, parts[3])).map((t) => t.name) } }; if (m === 'POST') { await checkNamed(key, { ...Object.fromEntries(url.searchParams), attempt: parts[3] }, true); return { status: 200, body: Array.isArray(body) ? await Promise.all(body.map((msg) => mcp(key, parts[3], msg))) : await mcp(key, parts[3], body) }; } }
    if (op === 'episodes' && m === 'GET') { const runs = (await store.query('Run', { where: (r) => r.env?.org === key.org })).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))); return { status: 200, body: { episodes: runs.slice(0, 200).map((r) => ({ episodeId: r.id, taskId: r.caseId, status: r.env.status, steps: r.env.steps, startedAt: r.startedAt, endedAt: r.endedAt, reward: r.result?.reward ?? null })), counts: { running: runs.filter((r) => r.env.status === 'running').length, finished: runs.filter((r) => r.env.status === 'done').length, truncated: runs.filter((r) => r.env.status === 'truncated').length } } }; }
    throw new HttpError(404, `${m} ${url.pathname} is not an environment route`);
  }
  /** Live counts for the dashboard (not behind a key: humans only, no episode contents). */
  async function stats(ctx) {
    if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only people can read environment statistics');
    const runs = await store.query('Run', { where: (r) => Boolean(r.env) });
    const hour = runs.filter((r) => r.endedAt && nowMs() - Date.parse(r.endedAt) < 3600000);
    return { enabled: enabled(), running: runs.filter((r) => r.env.status === 'running').length, finished: runs.filter((r) => r.env.status === 'done').length, truncated: runs.filter((r) => r.env.status === 'truncated').length, lastHour: hour.length, episodesPerMinute: Math.round((hour.length / 60) * 100) / 100, byOrg: Object.entries(runs.reduce((a, r) => { a[r.env.org] = (a[r.env.org] || 0) + 1; return a; }, {})).map(([org, n]) => ({ org, episodes: n })), versions: { environment: ENVIRONMENT_VERSION, grading: GRADING_VERSION } };
  }
  async function handleAdmin(req, url, body, ctx) {
    const parts = url.pathname.split('/').filter(Boolean);
    const m = req.method;
    if (parts[1] === 'admin' && parts[2] === 'env-keys') {
      if (parts.length === 3 && m === 'GET') return { status: 200, body: { keys: await listKeys(), enabled: enabled() } };
      if (parts.length === 3 && m === 'POST') return { status: 201, body: await createKey(body, ctx) };
      if (parts.length === 4 && m === 'DELETE') return { status: 200, body: await revokeKey(parts[3], ctx) };
    }
    if (parts[1] === 'admin' && parts[2] === 'env-stats' && m === 'GET') return { status: 200, body: await stats(ctx) };
    return null;
  }

  // ---------- WebSocket (15.1): the same messages, for high-throughput trainers ----------
  function attach(server) {
    server.on('upgrade', async (req, socket) => {
      // WebSockets are for agents with keys: a signed-in patient's browser cannot open one.
      if (upgradeGuard && await upgradeGuard(req).catch(() => true)) { socket.destroy(); return; }
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/env/v1/ws') { socket.destroy(); return; }
      const wsKey = req.headers['sec-websocket-key'];
      if (!wsKey) { socket.destroy(); return; }
      const accept = createHash('sha1').update(`${wsKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      let buffer = Buffer.alloc(0); let keyDoc = null; const headerAuth = req.headers.authorization;
      const sendText = (obj) => { const payload = Buffer.from(JSON.stringify(obj)); const len = payload.length; let head; if (len < 126) head = Buffer.from([0x81, len]); else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2); } else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); } socket.write(Buffer.concat([head, payload])); };
      const handleMessage = async (msg) => {
        const id = msg?.id ?? null;
        try {
          if (!keyDoc) keyDoc = await authorize({ authorization: msg?.token ? `Bearer ${msg.token}` : headerAuth });
          const op = msg?.op;
          let result;
          if (['reset', 'step', 'state', 'close'].includes(op)) result = await named(keyDoc, op, msg); // the same rule as over HTTP: task, run name, seed and (after reset) the attempt
          else if (op === 'tasks') result = await tasks(keyDoc, msg);
          else if (op === 'auth' || op === 'ping') result = { ok: true, org: keyDoc.org };
          else throw new HttpError(422, `Unknown op "${op}" (reset, step, state, close, tasks)`);
          sendText({ id, ok: true, result });
        } catch (err) { sendText({ id, ok: false, error: { status: err.status || 500, message: err.message, code: err.code } }); }
      };
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          if (buffer.length < 2) return;
          const fin = (buffer[0] & 0x80) !== 0; const opcode = buffer[0] & 0x0F; const masked = (buffer[1] & 0x80) !== 0; let len = buffer[1] & 0x7F; let off = 2;
          if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); off = 4; } else if (len === 127) { if (buffer.length < 10) return; len = Number(buffer.readBigUInt64BE(2)); off = 10; }
          const maskKey = masked ? buffer.subarray(off, off + 4) : null; if (masked) off += 4;
          if (buffer.length < off + len) return;
          let payload = buffer.subarray(off, off + len); buffer = buffer.subarray(off + len);
          if (masked) { const out = Buffer.alloc(len); for (let i = 0; i < len; i += 1) out[i] = payload[i] ^ maskKey[i % 4]; payload = out; }
          if (opcode === 0x8) { socket.end(Buffer.from([0x88, 0x00])); return; }
          if (opcode === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8A, payload.length]), payload])); continue; }
          if (opcode === 0x1 && fin) { let msg = null; try { msg = JSON.parse(payload.toString('utf8')); } catch { sendText({ id: null, ok: false, error: { status: 400, message: 'Messages must be JSON' } }); continue; } handleMessage(msg); }
        }
      });
      socket.on('error', () => socket.destroy());
      // When the client hangs up, the server side ends too, so server.close() can finish.
      socket.on('end', () => socket.end());
      socket.setTimeout(30 * 60 * 1000, () => socket.destroy());
      server.once('close', () => socket.destroy());
    });
  }

  return { setUpgradeGuard(fn) { upgradeGuard = fn; }, handle, handleAdmin, attach, reset, step, state, close, tasks, createKey, listKeys, revokeKey, stats, toolSchemas, enabled, setLoop(l) { loopRef = l; } };
}
