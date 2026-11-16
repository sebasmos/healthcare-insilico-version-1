// Connectors for outside agents, all under /connect/v1 and all under the
// permissions granted when the agent was approved:
//   - MCP servers, one per system (EHR on FHIR, PACS, Lab, Pharmacy, Payer, Business office, Scheduling):
//     JSON-RPC 2.0 over HTTP with initialize, tools/list, tools/call, resources/list and resources/read
//     (Model Context Protocol, revision 2026-07-28: stateless, no session; initialize is still answered for older clients);
//   - the plain FHIR REST API and CDS Hooks (patient-view, order-select, order-sign);
//   - a per-agent API key, made when the agent is approved with connectors switched on.
// Off by default; switched on per agent. Every call is made as the agent inside one of its runs, so the
// permission checks, the safety envelope and the log apply exactly as they do to built-in agents.
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { HttpError, INTERNAL_AGENT_HEADER, INTERNAL_AGENT_TOKEN } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { createRun, endRun } from './runs.mjs';
import { normalizePermissions, SYSTEMS, SYSTEM_LABEL, permissionsOf } from './permissions.mjs';
import { checkCitations } from './citations.mjs';

// The revision followed is the stateless one: one POST per message, a JSON reply, no session. Clients on an older revision may still open with initialize.
export const MCP_PROTOCOL = '2026-07-28';
export const MCP_SUPPORTED = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const hashOf = (token) => createHash('sha256').update(token).digest('hex');
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const S = { type: 'string' }; const O = { type: 'object' }; const N = { type: 'number' };
const q = (params) => { const u = new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString(); return u ? `?${u}` : ''; };
// Each tool: a name, a description, a JSON schema, and the request it makes inside this server as the agent.
export const TOOLS = {
  ehr: [
    { name: 'read_record', description: 'Read one FHIR record by type and id.', inputSchema: obj({ type: S, id: S }, ['type', 'id']), call: (a) => ['GET', `/fhir/R4/${a.type}/${a.id}`] },
    { name: 'search_records', description: 'Search FHIR records of one type, for example { "type": "Observation", "params": { "patient": "<id>" } }.', inputSchema: obj({ type: S, params: O }, ['type']), call: (a) => ['GET', `/fhir/R4/${a.type}${q(a.params)}`] },
    { name: 'create_record', description: 'Write a FHIR record on the run\'s own branch (a draft unless the agent has read and write).', inputSchema: obj({ resource: O }, ['resource']), call: (a) => ['POST', `/fhir/R4/${a.resource?.resourceType}`, a.resource] },
    { name: 'update_record', description: 'Update a FHIR record on the run\'s own branch.', inputSchema: obj({ resource: O }, ['resource']), call: (a) => ['PUT', `/fhir/R4/${a.resource?.resourceType}/${a.resource?.id}`, a.resource] },
  ],
  pacs: [
    { name: 'list_studies', description: 'Imaging studies of a patient.', inputSchema: obj({ patient: S }, ['patient']), call: (a) => ['GET', `/fhir/R4/ImagingStudy${q({ patient: a.patient })}`] },
    { name: 'read_study', description: 'One imaging study with its series.', inputSchema: obj({ id: S }, ['id']), call: (a) => ['GET', `/fhir/R4/ImagingStudy/${a.id}`] },
    { name: 'list_reports', description: 'Imaging and pathology reports of a patient.', inputSchema: obj({ patient: S }, ['patient']), call: (a) => ['GET', `/fhir/R4/DiagnosticReport${q({ patient: a.patient })}`] },
    { name: 'draft_report', description: 'Write a draft report (a DiagnosticReport with status preliminary) for a clinician to sign.', inputSchema: obj({ resource: O }, ['resource']), call: (a) => ['POST', '/fhir/R4/DiagnosticReport', { ...a.resource, resourceType: 'DiagnosticReport', status: 'preliminary' }] },
  ],
  lab: [
    { name: 'list_results', description: 'Laboratory results of a patient.', inputSchema: obj({ patient: S }, ['patient']), call: (a) => ['GET', `/fhir/R4/Observation${q({ patient: a.patient, category: 'laboratory' })}`] },
    { name: 'list_specimens', description: 'Specimens of a patient.', inputSchema: obj({ patient: S }, ['patient']), call: (a) => ['GET', `/fhir/R4/Specimen${q({ patient: a.patient })}`] },
    { name: 'lab_worklist', description: 'The laboratory worklist.', inputSchema: obj({}), call: () => ['GET', '/api/lab/worklist'] },
  ],
  pharmacy: [
    { name: 'list_medications', description: 'Medication orders of a patient.', inputSchema: obj({ patient: S }, ['patient']), call: (a) => ['GET', `/fhir/R4/MedicationRequest${q({ patient: a.patient })}`] },
  ],
  payer: [
    // The insurance environment (docs/PAYER.md section 7): an insurer-side agent sees only what the hospital sent.
    { name: 'ins_queue', description: 'The insurer\'s work queues, sorted by time left: prior-auth, concurrent, post-acute, claims or appeals.', inputSchema: obj({ queue: S }), call: (a) => ['GET', `/api/ins/payer/queue${q({ queue: a.queue })}`] },
    { name: 'ins_review_case', description: 'One authorization case: the request, the records the hospital sent, the policy criteria with the evidence found, and the automatic rules that fired.', inputSchema: obj({ id: S }, ['id']), call: (a) => ['GET', `/api/ins/payer/cases/${a.id}`] },
    { name: 'ins_recommend_case', description: 'Leave a recommendation on a case with a confidence (0 to 1) and, per criterion, the exact sentence or value relied on. This decides nothing.', inputSchema: obj({ id: S, recommendation: S, confidence: N, reason: S, criteria: { type: 'array', items: O } }, ['id', 'recommendation']), call: ({ id, ...rest }) => ['POST', `/api/ins/payer/cases/${id}/recommend`, rest] },
    { name: 'ins_decide_case', description: 'Decide a case on your own branch (autonomous runs only): approved, partially-approved, denied, info-requested or route. A denial gives a specific reason and names the unmet criteria of the policy version on the case.', inputSchema: obj({ id: S, decision: S, reason: S, unmet: { type: 'array', items: S }, items: { type: 'array', items: S }, units: N, days: N }, ['id', 'decision']), call: ({ id, ...rest }) => ['POST', `/api/ins/payer/cases/${id}/decide`, rest] },
    { name: 'ins_review_claim', description: 'One claim as the insurer received it: lines, the rules that fired with their data source, pricing, and the member\'s claim history.', inputSchema: obj({ id: S }, ['id']), call: (a) => ['GET', `/api/ins/payer/claims/${a.id}`] },
    { name: 'ins_recommend_claim', description: 'Leave a recommendation on a pended claim. This decides nothing.', inputSchema: obj({ id: S, recommendation: S, confidence: N, reason: S, lines: { type: 'array', items: O } }, ['id', 'recommendation']), call: ({ id, ...rest }) => ['POST', `/api/ins/payer/claims/${id}/recommend`, rest] },
    { name: 'ins_decide_claim', description: 'Decide the pended lines of a claim on your own branch: each line { line, action: pay or deny, reason, carc, allowed }.', inputSchema: obj({ id: S, lines: { type: 'array', items: O } }, ['id', 'lines']), call: ({ id, ...rest }) => ['POST', `/api/ins/payer/claims/${id}/decide`, rest] },
    { name: 'ins_decide_appeal', description: 'Decide an appeal on your own branch: upheld, overturned or partially-overturned, with the reason. Never by whoever made the original decision.', inputSchema: obj({ id: S, outcome: S, reason: S }, ['id', 'outcome', 'reason']), call: ({ id, ...rest }) => ['POST', `/api/ins/payer/appeals/${id}/decide`, rest] },
    { name: 'ins_audit_claim', description: 'Open a post-payment audit of a paid claim, record its finding, or ask for records.', inputSchema: obj({ id: S, action: S, reason: S, amount: N, items: { type: 'array', items: S } }, ['id', 'action']), call: ({ id, ...rest }) => ['POST', `/api/ins/payer/claims/${id}/audit`, rest] },
    { name: 'ins_member_history', description: 'A member\'s claims, remittances and authorizations as the insurer holds them.', inputSchema: obj({ member: S }, ['member']), call: (a) => ['GET', `/api/ins/payer/members/${a.member}`] },
    { name: 'ins_search_policies', description: 'Search medical policies by service code, diagnosis, words and version.', inputSchema: obj({ code: S, diagnosis: S, text: S, version: S }), call: (a) => ['GET', `/api/ins/policies${q({ search: 1, ...a })}`] },
    { name: 'ins_lookup_code', description: 'Look up a code in a loaded code set (ICD-10-CM, ICD-10-PCS, HCPCS, CPT, CARC, RARC).', inputSchema: obj({ system: S, q: S }, ['system', 'q']), call: (a) => ['GET', `/api/ins/reference/codes${q(a)}`] },
    { name: 'ins_check_ncci', description: 'Run the NCCI edits on a set of lines: bundled pairs, whether a modifier may separate them, and unit limits.', inputSchema: obj({ lines: { type: 'array', items: O }, setting: S }, ['lines']), call: (a) => ['POST', '/api/ins/coding/check/edits', a] },
    { name: 'ins_lookup_provider', description: 'A provider by NPI (number, kind, state, specialty code; never a name) and whether it is in a plan\'s network.', inputSchema: obj({ npi: S, plan: S }, ['npi']), call: (a) => ['GET', `/api/ins/reference/npi/${a.npi}${q({ plan: a.plan })}`] },
  ],
  'business-office': [
    // The insurance environment (docs/PAYER.md section 7): hospital-side tools. A hospital-side agent never approves or denies.
    { name: 'ins_check_coverage', description: 'A patient\'s coverage and card, by patient number: plan, member number, deductible and out-of-pocket so far.', inputSchema: obj({ patient: S }, ['patient']), call: (a) => ['GET', `/api/ins/coverage/${a.patient}`] },
    { name: 'ins_check_eligibility', description: 'Ask the insurer whether the patient is covered on a date (270 and 271).', inputSchema: obj({ patient: S, serviceDate: S }, ['patient']), call: (a) => ['POST', '/api/ins/eligibility', a] },
    { name: 'ins_auth_needed', description: 'Does this plan need authorization for these services, and against which policy criteria?', inputSchema: obj({ patient: S, services: { type: 'array', items: O }, serviceDate: S, setting: S }, ['patient', 'services']), call: (a) => ['POST', '/api/ins/auth/need', a] },
    { name: 'ins_auth_questionnaire', description: 'The plan\'s questions for a service, pre-filled from the notes and results you name; shows what is still missing.', inputSchema: obj({ patient: S, services: { type: 'array', items: O }, diagnoses: { type: 'array', items: S }, documents: { type: 'array', items: S }, observations: { type: 'array', items: S } }, ['patient', 'services']), call: (a) => ['POST', '/api/ins/auth/questionnaire', a] },
    { name: 'ins_submit_auth', description: 'Send an authorization request with the notes and results you choose. The insurer sees only those.', inputSchema: obj({ patient: S, services: { type: 'array', items: O }, diagnoses: { type: 'array', items: S }, serviceDate: S, setting: S, urgency: S, kind: S, documents: { type: 'array', items: S }, observations: { type: 'array', items: S }, answers: O }, ['patient', 'services', 'diagnoses']), call: (a) => ['POST', '/api/ins/auth', a] },
    { name: 'ins_auth_queue', description: 'The hospital\'s authorization work queue: status, time left, what the insurer asked for.', inputSchema: obj({ patient: S, status: S }), call: (a) => ['GET', `/api/ins/auth${q(a)}`] },
    { name: 'ins_read_auth', description: 'One authorization: status, letters, criteria not met, history.', inputSchema: obj({ id: S }, ['id']), call: (a) => ['GET', `/api/ins/auth/${a.id}`] },
    { name: 'ins_send_records', description: 'Send more notes or results to the insurer for an authorization.', inputSchema: obj({ id: S, documents: { type: 'array', items: S }, observations: { type: 'array', items: S } }, ['id']), call: ({ id, ...rest }) => ['POST', `/api/ins/auth/${id}/attach`, rest] },
    { name: 'ins_draft_letter', description: 'Draft a letter of medical necessity or an appeal letter, citing exact sentences from the chart. A physician signs it.', inputSchema: obj({ about: O, kind: S, text: S, citations: { type: 'array', items: O } }, ['about', 'text']), call: (a) => ['POST', '/api/ins/letters', a] },
    { name: 'ins_file_appeal', description: 'File an appeal of a denied authorization or claim with a signed appeal letter.', inputSchema: obj({ about: O, letter: S, reason: S, expedited: { type: 'boolean' } }, ['about', 'letter']), call: (a) => ['POST', '/api/ins/appeals', a] },
    { name: 'ins_coding_view', description: 'What a coder may read for an encounter: signed notes, results and orders (read-only), the coding so far and open questions.', inputSchema: obj({ encounter: S }, ['encounter']), call: (a) => ['GET', `/api/ins/coding/${a.encounter}`] },
    { name: 'ins_code_encounter', description: 'Code an encounter from its signed documentation: setting, diagnoses (principal first), lines { code, modifiers, units, charge }, and for each code the sentence it rests on.', inputSchema: obj({ encounter: S, setting: S, diagnoses: { type: 'array', items: O }, lines: { type: 'array', items: O }, procedures: { type: 'array', items: O }, basis: { type: 'array', items: O } }, ['encounter', 'setting', 'diagnoses', 'lines']), call: ({ encounter, ...rest }) => ['POST', `/api/ins/coding/${encounter}`, rest] },
    { name: 'ins_ask_physician', description: 'Send the physician a documentation question. It must not lead: do not say what to write.', inputSchema: obj({ encounter: S, question: S, indicators: { type: 'array', items: S }, options: { type: 'array', items: S } }, ['encounter', 'question']), call: ({ encounter, ...rest }) => ['POST', `/api/ins/coding/${encounter}/query`, rest] },
    { name: 'ins_group_drg', description: 'Group an inpatient stay to a DRG. Uses the official grouper when it is loaded; otherwise the answer is labelled approximate.', inputSchema: obj({ diagnoses: { type: 'array', items: O }, procedures: { type: 'array', items: O }, sex: S, age: N, dischargeStatus: S }, ['diagnoses']), call: (a) => ['POST', '/api/ins/reference/drg', a] },
    { name: 'ins_build_claim', description: 'Build the claim or claims for a coded encounter.', inputSchema: obj({ encounter: S }, ['encounter']), call: (a) => ['POST', '/api/ins/claims/build', a] },
    { name: 'ins_send_claim', description: 'Send a built claim through the clearinghouse to the insurer.', inputSchema: obj({ id: S }, ['id']), call: (a) => ['POST', `/api/ins/claims/${a.id}/send`, {}] },
    { name: 'ins_claims', description: 'The hospital\'s claims with status, payment, patient share and denial reasons. denied: 1 for the denied-claims queue.', inputSchema: obj({ patient: S, status: S, denied: S }), call: (a) => ['GET', `/api/ins/claims${q(a)}`] },
    { name: 'ins_read_claim', description: 'One claim with its remittance, denials, appeals and every message sent and received (X12 and FHIR).', inputSchema: obj({ id: S }, ['id']), call: (a) => ['GET', `/api/ins/claims/${a.id}`] },
    { name: 'ins_correct_claim', description: 'Send a corrected claim (or void: true) for a claim the insurer accepted.', inputSchema: obj({ id: S, lines: { type: 'array', items: O }, diagnoses: { type: 'array', items: S }, priorAuth: S, void: { type: 'boolean' } }, ['id']), call: ({ id, ...rest }) => ['POST', `/api/ins/claims/${id}/correct`, rest] },
    { name: 'ins_search_policies', description: 'Search medical policies by service code, diagnosis, words and version.', inputSchema: obj({ code: S, diagnosis: S, text: S, version: S }), call: (a) => ['GET', `/api/ins/policies${q({ search: 1, ...a })}`] },
    { name: 'ins_lookup_code', description: 'Look up a code in a loaded code set (ICD-10-CM, ICD-10-PCS, HCPCS, CPT, CARC, RARC).', inputSchema: obj({ system: S, q: S }, ['system', 'q']), call: (a) => ['GET', `/api/ins/reference/codes${q(a)}`] },
    { name: 'ins_check_ncci', description: 'Run the NCCI edits on a set of lines: bundled pairs, whether a modifier may separate them, and unit limits.', inputSchema: obj({ lines: { type: 'array', items: O }, setting: S }, ['lines']), call: (a) => ['POST', '/api/ins/coding/check/edits', a] },
    { name: 'ins_lookup_provider', description: 'A provider by NPI (number, kind, state, specialty code; never a name) and whether it is in a plan\'s network.', inputSchema: obj({ npi: S, plan: S }, ['npi']), call: (a) => ['GET', `/api/ins/reference/npi/${a.npi}${q({ plan: a.plan })}`] },
  ],
  scheduling: [
    { name: 'list_appointments', description: 'Appointments of a patient.', inputSchema: obj({ patient: S }, ['patient']), call: (a) => ['GET', `/fhir/R4/Appointment${q({ patient: a.patient })}`] },
    { name: 'propose_appointment', description: 'Propose an appointment (status proposed) for a person to confirm.', inputSchema: obj({ resource: O }, ['resource']), call: (a) => ['POST', '/fhir/R4/Appointment', { ...a.resource, resourceType: 'Appointment', status: 'proposed' }] },
  ],
};

export function createConnectors({ store, agents }) {
  const base = () => { if (!agents.baseUrl) throw new HttpError(503, 'The server is not listening yet'); return agents.baseUrl; };
  /** One request inside this server exactly as the agent would send it. */
  async function asAgent(agent, runId, method, path, body) {
    const headers = { 'Content-Type': 'application/json', [INTERNAL_AGENT_HEADER]: INTERNAL_AGENT_TOKEN, 'X-Agent-Id': agent.id, 'X-Run-Id': runId, ...(method !== 'GET' ? { 'Idempotency-Key': randomUUID() } : {}) };
    const r = await fetch(base() + path, { method, headers, body: body == null || method === 'GET' ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const raw = await r.text(); let json = null; try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
    return { status: r.status, json, raw };
  }
  async function ensureKey(agent, actor) {
    const existing = (await store.query('ConnectorKey', { where: (k) => k.agentId === agent.id && !k.revokedAt }))[0];
    if (existing) return { id: existing.id, prefix: existing.prefix, token: null };
    const token = `hd_agent_${randomBytes(24).toString('hex')}`;
    const saved = await store.transaction(async (tx) => { const k = await tx.save('ConnectorKey', { resourceType: 'ConnectorKey', id: randomUUID(), agentId: agent.id, hash: hashOf(token), prefix: token.slice(0, 14), createdAt: tx.now(), createdBy: actor.id, revokedAt: null }, { updatedBy: actor.role }); await recordAction(tx, { actor, kind: 'create', action: 'connector.key.create', args: { agent: agent.id, key: k.id, prefix: k.prefix }, entityRef: `Agent/${agent.id}`, description: `connector key made for ${agent.id}` }); return k; });
    return { id: saved.id, prefix: saved.prefix, token };
  }
  async function agentFor(req) {
    const m = /^Bearer\s+(hd_agent_[0-9a-f]+)$/.exec(String(req.headers.authorization || ''));
    if (!m) throw new HttpError(401, 'Send the agent\'s connector key as "Authorization: Bearer hd_agent_..."');
    const key = (await store.query('ConnectorKey', { where: (k) => k.hash === hashOf(m[1]) && !k.revokedAt }))[0];
    if (!key) throw new HttpError(401, 'This connector key is not valid (it may have been revoked)');
    const agent = await store.get('Agent', key.agentId);
    if (!agent || !agent.enabled) throw new HttpError(403, 'This agent is switched off');
    if (agent.approval?.status !== 'approved') throw new HttpError(403, 'This agent has not been approved by the platform owner');
    if (!agent.connectors?.enabled) throw new HttpError(403, 'Connectors are switched off for this agent');
    return agent;
  }
  async function runFor(agent, req, runId = null) {
    const id = runId || req.headers['x-run-id']; if (!id) throw new HttpError(400, 'Name the run: start one with POST /connect/v1/runs and send its id as X-Run-Id');
    const run = await store.get('Run', String(id)); if (!run || run.agentId !== agent.id) throw new HttpError(404, 'No such run for this agent'); if (run.endedAt) throw new HttpError(409, 'This run has ended');
    return run;
  }
  const mcpTools = (system, agent, run) => { const level = permissionsOf(run, agent).systems?.[system] || 'none'; return level === 'none' ? [] : TOOLS[system].map(({ call, ...t }) => t); };

  async function mcp(system, msg, agent, req) {
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id ?? null, result }); const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
    if (!SYSTEMS.includes(system)) return fail(-32601, `No such system. Systems: ${SYSTEMS.join(', ')}`);
    // When the client names the method in the Mcp-Method header it must be the method in the body.
    if (req.headers['mcp-method'] && req.headers['mcp-method'] !== msg.method) return fail(-32600, 'The Mcp-Method header does not match the method in the body');
    if (msg.method === 'initialize') return reply({ protocolVersion: MCP_SUPPORTED.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : MCP_PROTOCOL, capabilities: { tools: {}, resources: {} }, serverInfo: { name: `hospital-desktop ${SYSTEM_LABEL[system]}`, version: '1.0.0' }, instructions: `Tools for the simulated hospital's ${SYSTEM_LABEL[system]}. Everything is synthetic. Start a run with POST /connect/v1/runs and send its id as X-Run-Id (or as _meta.runId).` });
    if (msg.method === 'notifications/initialized' || msg.method === 'ping') return reply({});
    const runId = msg.params?._meta?.runId || req.headers['x-run-id'] || null;
    const run = runId ? await runFor(agent, req, runId) : null;
    if (msg.method === 'tools/list') return reply({ tools: mcpTools(system, agent, run) });
    if (msg.method === 'resources/list') { const pols = system === 'payer' && run ? ((await asAgent(agent, run.id, 'GET', '/api/ins/policies')).json || []).filter((p) => p.usable) : []; return reply({ resources: system === 'payer' ? pols.map((p) => ({ uri: `payer://policies/${p.policyId || p.id}`, name: `${p.title}, version ${p.version}`, mimeType: 'application/json' })) : run?.patientRef && system === 'ehr' ? [{ uri: `fhir://${run.patientRef}`, name: 'The patient of this run', mimeType: 'application/fhir+json' }] : [] }); }
    if (!run) return fail(-32602, 'Name the run: send X-Run-Id or params._meta.runId');
    if (msg.method === 'resources/read') { const uri = String(msg.params?.uri || ''); const path = uri.startsWith('payer://policies/') ? `/api/ins/policies/${uri.split('/').pop()}` : uri.startsWith('fhir://') ? `/fhir/R4/${uri.slice(7)}` : null; if (!path) return fail(-32602, 'Unknown resource'); const r = await asAgent(agent, run.id, 'GET', path); if (r.status >= 400) return fail(-32002, r.json?.error || r.json?.issue?.[0]?.diagnostics || `HTTP ${r.status}`); return reply({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(r.json) }] }); }
    if (msg.method === 'tools/call') {
      const tool = TOOLS[system].find((t) => t.name === msg.params?.name); if (!tool) return fail(-32602, `Unknown tool "${msg.params?.name}"`);
      const [method, path, body] = tool.call(msg.params?.arguments || {});
      const r = await asAgent(agent, run.id, method, path, body);
      const refused = r.status >= 400;
      return reply({ content: [{ type: 'text', text: refused ? (r.json?.error || r.json?.issue?.[0]?.diagnostics || `Refused (HTTP ${r.status})`) : JSON.stringify(r.json) }], isError: refused, ...(refused ? { _meta: { status: r.status, rule: r.json?.rule || r.json?.code || null } } : {}) });
    }
    return fail(-32601, `Method "${msg.method}" is not supported`);
  }

  return {
    ensureKey, TOOLS,
    /** Everything under /connect/v1. Returns { status, body }. */
    async handle(req, url, body) {
      const parts = url.pathname.split('/').filter(Boolean).slice(2); const m = req.method;
      if (parts[0] === 'info' && m === 'GET') return { status: 200, body: { name: 'hospital-desktop connectors', mcpProtocol: MCP_PROTOCOL, systems: SYSTEMS, routes: ['POST /connect/v1/agents (ask to be added)', 'POST /connect/v1/runs', 'ANY /connect/v1/fhir/...', 'GET /connect/v1/cds-services', 'POST /connect/v1/cds-services/{id}', 'POST /connect/v1/mcp/{system}', 'POST /connect/v1/runs/{id}/finish'], note: 'Off by default. The platform owner approves an agent and switches its connectors on; the key is shown once.' } };
      // An outside party asks to be added: nothing can run until the platform owner approves or narrows the permissions.
      if (parts[0] === 'agents' && m === 'POST') {
        const id = String(body?.id || '').toLowerCase(); if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) throw new HttpError(422, 'id: lowercase letters, digits and dashes');
        if (await store.get('Agent', id)) throw new HttpError(409, `An agent called "${id}" already exists`);
        const requested = normalizePermissions(body.requested || body.permissions || {}, 'read-only');
        const doc = { resourceType: 'Agent', id, name: String(body.name || id).slice(0, 80), version: String(body.version || '1.0.0').slice(0, 40), organisation: String(body.organisation || '').slice(0, 80) || null, modelName: String(body.modelName || '').slice(0, 120) || null, description: String(body.description || '').slice(0, 500), capability: String(body.capability || 'custom').slice(0, 40), connection: ['environment-api', 'mcp', 'cds-hooks'].includes(body.connection) ? body.connection : 'mcp', adapter: { kind: 'external' }, scopes: (requested.recordTypes || ['ServiceRequest', 'MedicationRequest', 'Condition', 'DocumentReference', 'Task', 'Communication', 'DiagnosticReport', 'Appointment']).map((type) => ({ type, interactions: ['create', 'update'] })), requested, granted: null, approval: { status: 'pending', askedAt: store.now() }, permissionRev: 0, connectors: { enabled: false }, enabled: true, stage: 'shadow', promotions: [], shadow: { event: false, task: false }, hitl: { auto: false, askFrequency: 'every-step' }, limits: { maxSteps: 200, timeoutMs: 600000 }, policyHash: hashOf(`${id}:${body.version || '1.0.0'}`).slice(0, 16), registeredAt: store.now(), submittedThrough: 'connector API' };
        const saved = await store.transaction(async (tx) => { const a = await tx.save('Agent', doc, { updatedBy: 'outside-party' }); await recordAction(tx, { actor: { kind: 'human', id: `outside:${doc.organisation || id}`, role: 'outside-party' }, kind: 'create', action: 'agent.submit', args: { agent: id, organisation: doc.organisation, requested: requested.systems, mustCite: requested.mustCite }, entityRef: `Agent/${id}`, description: `agent ${id} submitted for approval` }); return a; });
        return { status: 202, body: { id: saved.id, approval: saved.approval, requested: saved.requested, note: 'Waiting for the platform owner to approve or narrow these permissions (Agent Dashboard, Settings).' } };
      }
      const agent = await agentFor(req);
      if (parts[0] === 'runs' && m === 'POST' && !parts[1]) {
        const run = await createRun(store, { mode: 'sandbox', agentId: agent.id, subject: typeof body?.subject === 'string' ? body.subject : undefined, goal: body?.goal, ...(body?.permissions ? { permissions: body.permissions } : {}), study: body?.study, record: { harness: 'theirs', organisation: agent.organisation, model: body?.model || agent.modelName, provider: body?.provider || null }, trigger: { kind: 'connector', actor: agent.id, role: 'agent', at: store.now() } }, { kind: 'human', id: `connector:${agent.id}`, role: 'connector' });
        return { status: 201, body: { runId: run.id, branch: run.branch, permissions: run.permissions, permissionLevel: run.permissionLevel, patient: run.patientRef, mustCite: Boolean(run.permissions?.mustCite) } };
      }
      if (parts[0] === 'runs' && parts[2] === 'finish' && m === 'POST') {
        const run = await runFor(agent, req, parts[1]);
        const mustCite = Boolean(run.permissions?.mustCite); const claims = Array.isArray(body?.claims) ? body.claims.slice(0, 200) : [];
        // Each cited record is read as this run can see it: on its branch, through the agent's own permissions.
        const read = async (ref) => { if (ref.startsWith('PayerPolicy/')) { const r0 = await asAgent(agent, run.id, 'GET', `/api/ins/policies/${ref.split('/')[1]}`); const p = r0.status === 200 ? r0.json : null; return p ? { resourceType: 'PayerPolicy', id: p.policyId || p.id, criteriaText: p.criteria.map((x) => x.text).join(' '), policyText: `${p.title} ${p.criteria.map((x) => `${x.id} ${x.text}`).join(' ')}`, version: p.version } : null; } const r = await asAgent(agent, run.id, 'GET', `/fhir/R4/${ref}`); if (r.status !== 200) return null; const [type, id] = ref.split('/'); const stored = await store.get(type, id, { branch: run.branch }); return stored || r.json; };
        const citations = mustCite || claims.length ? await checkCitations(claims.length ? claims : [{ text: String(body?.summary || ''), cites: [] }], { read, patientRef: run.patientRef, at: store.now(), shared: ['PayerPolicy'] }) : null;
        const ended = await endRun(store, run.id, agents.agentActor(agent), 'completed', { kind: 'connector', summary: String(body?.summary || '').slice(0, 2000), ...(citations ? { citations } : {}), ...(body?.usage ? { usage: body.usage } : {}) });
        await store.transaction((tx) => recordAction(tx, { runId: run.id, actor: agents.agentActor(agent), kind: 'execute', action: 'citations.check', args: citations ? { claims: citations.claims, valid: citations.valid, uncited: citations.uncited, passed: citations.passed, problems: citations.problems.map((p) => p.problem) } : { skipped: true }, branch: run.branch, entityRef: `Run/${run.id}`, description: citations ? `citation check: ${citations.valid} of ${citations.claims} claims hold` : 'citation check not needed', audit: false }));
        return { status: 200, body: { runId: ended.id, status: 'completed', citations, record: ended.record } };
      }
      if (parts[0] === 'fhir') { const run = await runFor(agent, req); const r = await asAgent(agent, run.id, m, `/fhir/R4/${parts.slice(1).join('/')}${url.search}`, body); return { status: r.status, body: r.json ?? { text: r.raw } }; }
      if (parts[0] === 'cds-services') { const run = await runFor(agent, req); const r = await asAgent(agent, run.id, m, `/cds-services${parts[1] ? `/${parts[1]}` : ''}`, body); return { status: r.status, body: r.json }; }
      if (parts[0] === 'mcp' && m === 'POST') { const out = Array.isArray(body) ? await Promise.all(body.map((msg) => mcp(parts[1], msg, agent, req))) : await mcp(parts[1], body || {}, agent, req); return { status: 200, body: out }; }
      throw new HttpError(404, `${m} ${url.pathname} is not available`);
    },
  };
}
