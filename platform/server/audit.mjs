// The log. Every action writes one TraceStep carrying all six of: what it
// saw, what it did, why, who, when, and the Run it belongs to. Clinical
// actions also write a FHIR AuditEvent that references the TraceStep.
import { randomUUID } from 'node:crypto';

export const LIVE_RUN_ID = 'live';

/** The ambient Run for work on main that no explicit Run claims. */
export async function ensureLiveRun(store) {
  // Outside a research session there is no friction: advisories are off. A session chooses its own friction on its own run.
  const existing = await store.get('Run', LIVE_RUN_ID);
  if (existing && existing.friction === 'low') return existing;
  if (existing) { const { _seq, ...rest } = existing; return store.save('Run', { ...rest, friction: 'low' }, { updatedBy: 'system' }); }
  return store.save('Run', {
    resourceType: 'Run', id: LIVE_RUN_ID, umbrella: 'live', mode: 'unattributed', agentId: null,
    version: null, policyHash: null, branch: 'main', caseId: null, overlays: [], friction: 'low',
    startedAt: store.now(), endedAt: null,
  }, { updatedBy: 'system' });
}

export function buildTraceStep({
  runId = LIVE_RUN_ID, actor, action, args = {}, why = null, branch = 'main', asOf = null,
  resources = [], uiStateHash = null, approval = null, wall, source = 'api', auditEventId = null, client = null, which = null,
}) {
  return {
    resourceType: 'TraceStep',
    id: randomUUID(),
    runId,
    source,
    saw: { asOf, branch, resources, uiStateHash },
    did: { type: action, args },
    why,
    who: { kind: actor.kind, id: actor.id, role: actor.role, approval },
    when: { wall, chartAsOf: asOf ?? wall },
    auditEvent: auditEventId ? `AuditEvent/${auditEventId}` : null,
    // Which study or training run, task and attempt this step belongs to (docs/STUDY-DESIGN.md 5); null for work outside both.
    which,
    client,
  };
}

const AUDIT_ACTION = { create: 'C', read: 'R', update: 'U', delete: 'D', execute: 'E' };

export function buildAuditEvent({ id, kind, actor, entityRef, versionId, patientRef, description, wall, traceStepId, outcome = '0' }) {
  const entity = [];
  if (entityRef) entity.push({ what: { reference: entityRef }, detail: versionId ? [{ type: 'versionId', valueString: String(versionId) }] : undefined });
  if (traceStepId) entity.push({ what: { identifier: { system: 'urn:hospital-desktop:trace-step', value: traceStepId } } });
  return {
    resourceType: 'AuditEvent',
    id,
    meta: { profile: [patientRef ? 'https://profiles.ihe.net/ITI/BALP/StructureDefinition/IHE.BasicAudit.PatientCreate' : 'https://profiles.ihe.net/ITI/BALP/StructureDefinition/IHE.BasicAudit.Create'].map((u) => (kind === 'create' ? u : u.replace('Create', kind === 'update' ? 'Update' : kind === 'delete' ? 'Delete' : 'Create'))) },
    type: { system: 'http://terminology.hl7.org/CodeSystem/audit-event-type', code: 'rest', display: 'RESTful Operation' },
    subtype: [{ system: 'http://hl7.org/fhir/restful-interaction', code: { create: 'create', update: 'update', delete: 'delete', read: 'read', execute: 'operation' }[kind] || 'operation' }],
    source: { observer: { display: 'hospital-desktop' }, type: [{ system: 'http://terminology.hl7.org/CodeSystem/security-source-type', code: '4', display: 'Application Server' }] },
    action: AUDIT_ACTION[kind] || 'E',
    recorded: wall,
    outcome,
    outcomeDesc: description,
    agent: [{
      type: { text: actor.kind },
      who: { identifier: { value: actor.id }, display: actor.role },
      requestor: true,
    }],
    entity,
    _patient: patientRef ?? null,
  };
}

/**
 * Writes the AuditEvent (on the action's branch) and the TraceStep (always
 * on main, so one query returns the full history of any run). Call inside
 * the same transaction as the clinical write.
 */
// One trace format for everything: who, saw, did, why, when, and which study or run, task and attempt.
// "which" is read from the step's Run (set by the server when the attempt was opened), never taken from the client.
const whichCache = new Map();
export async function whichOf(tx, runId) {
  if (!runId || runId === LIVE_RUN_ID) return null;
  if (whichCache.has(runId)) return whichCache.get(runId);
  const run = await tx.get('Run', runId);
  if (!run) return null;
  const a = run.attempt;
  const which = a ? { study: a.study ?? null, run: a.run ?? null, task: a.task ?? null, taskVersion: a.taskVersion ?? null, attempt: a.attempt ?? (a.run ? runId : null), condition: a.condition ?? null, ...(a.seed != null ? { seed: a.seed } : {}) } : null;
  if (whichCache.size > 5000) whichCache.clear();
  whichCache.set(runId, which);
  return which;
}

export async function recordAction(tx, {
  runId, actor, kind, action, args, why, branch = 'main', asOf = null, resources = [], entityRef,
  versionId, patientRef, description, approval, audit = true, source = 'api', uiStateHash = null, outcome = '0',
}) {
  const wall = tx.now();
  const auditEventId = audit ? randomUUID() : null;
  const step = buildTraceStep({
    runId, actor, action, args, why, branch, asOf, resources, uiStateHash, approval, wall, source, auditEventId, which: await whichOf(tx, runId),
  });
  if (audit) {
    await tx.save('AuditEvent', buildAuditEvent({
      id: auditEventId, kind, actor, entityRef, versionId, patientRef, description: description ?? action,
      wall, traceStepId: step.id, outcome,
    }), { branch, updatedBy: actor.role });
  }
  await tx.save('TraceStep', step, { branch: 'main', updatedBy: actor.role });
  return { traceStepId: step.id, auditEventId };
}
