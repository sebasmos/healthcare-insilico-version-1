// Evaluate → Human in the loop (§9c). The agent drafts on a hidden staging
// branch. The server turns each thing it wrote into a proposal (a FHIR Task
// on the target branch). A clinician accepts, edits or rejects it. Accepted
// content is written and signed by that clinician, never by the agent.
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { endRun } from './runs.mjs';
import { stripInternal } from '../../platform/server/fhir-api.mjs';
import { transitionDoc, REPORT_URLS } from '../../platform/server/state-machines.mjs';
import { classifyImpression, triageLabelOf } from './shadow.mjs';
import { engagedSwitch } from './envelope.mjs';
import { interactionStats } from './turns.mjs';

const SUMMARY_CODE = 'ai-summary';
const isSummary = (d) => (d.type?.coding || []).some((c) => c.system === 'urn:hospital-desktop:doc-type' && c.code === SUMMARY_CODE);
const docText = (d) => Buffer.from(d.content?.[0]?.attachment?.data || '', 'base64').toString('utf8');

export const TASK_SYSTEM = 'urn:hospital-desktop:task';
export const AI_DRAFT_URL = 'urn:hospital-desktop:ai-drafted';
export const HTEST = { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST', display: 'test health data' };
const SIGNED = ['final', 'amended', 'corrected', 'appended'];
const ORDER_OR_SIGN = new Set(['ServiceRequest', 'MedicationRequest', 'DiagnosticReport', 'DocumentReference']);
const TRIAGE_LABELS = ['urgent', 'routine', 'low'];

const isProposal = (t) => (t.code?.coding || []).some((c) => c.system === TASK_SYSTEM && c.code === 'agent-proposal');
const isTriage = (t) => (t.code?.coding || []).some((c) => c.code === 'message-triage');
const input = (task, name) => (task.input || []).find((i) => i.type?.text === name);
const output = (task, name) => (task.output || []).find((i) => i.type?.text === name);
const str = (task, name) => input(task, name)?.valueString ?? null;
const parse = (raw, fallback) => { try { return JSON.parse(raw); } catch { return fallback; } };
const ext = (doc, url) => (doc.extension || []).find((e) => e.url === url)?.valueString ?? '';
const isAddendum = (r) => (r.extension || []).some((e) => e.url === REPORT_URLS.addendumOf);
export const isSyntheticPatient = (p) => (p?.meta?.security || []).some((s) => s.system === HTEST.system && s.code === HTEST.code);

// ---------- What a proposal contains, by kind ----------
function extract(resource) {
  if (resource.resourceType === 'DiagnosticReport') {
    return { kind: 'report', content: { technique: ext(resource, REPORT_URLS.technique), findings: ext(resource, REPORT_URLS.findings), impression: resource.conclusion || '' } };
  }
  if (resource.resourceType === 'Task' && isTriage(resource)) {
    return { kind: 'triage', content: { label: triageLabelOf(resource) || 'routine', reply: (resource.output || []).find((o) => o.type?.text === 'suggested-reply')?.valueString || '' } };
  }
  // In-place drafts (plan-master 9.1): a summary card, a note with "Check this" marks, or a queued order.
  if (resource.resourceType === 'DocumentReference') {
    const body = docText(resource);
    if (isSummary(resource)) return { kind: 'summary', content: { text: body, cites: (resource.context?.related || []).map((r) => r.reference).filter(Boolean) } };
    return { kind: 'note', content: { title: resource.type?.text || resource.description || 'Note', noteType: resource.type ?? null, text: body, checks: body.split('[Check this]').length - 1, encounter: resource.context?.encounter?.[0]?.reference ?? null } };
  }
  if (resource.resourceType === 'ServiceRequest' || resource.resourceType === 'MedicationRequest') return { kind: 'order', content: { resource: stripInternal(resource) } };
  return { kind: 'resource', content: { resource: stripInternal(resource) } };
}

/** A deliberately wrong version of a proposal, for automation-bias tests on sandbox branches. */
export function plantError(kind, content) {
  if (kind === 'report') {
    return classifyImpression(content.impression) === 'abnormal'
      ? { ...content, findings: 'Lungs are clear. Heart size is normal.', impression: 'No acute abnormality.' }
      : { ...content, findings: 'Absent lung markings on the right with a visible pleural line.', impression: 'Large right pneumothorax. Urgent clinical review advised.' };
  }
  if (kind === 'triage') {
    return content.label === 'urgent'
      ? { label: 'low', reply: 'Thank you for letting us know. No further action is needed from you.' }
      : { label: 'urgent', reply: 'Your symptoms may need prompt attention. If this is an emergency, call your local emergency number now.' };
  }
  return null;
}

/** Does this proposal interrupt the clinician, under the run's ask-frequency setting? */
export function needsAsk(run, kind, resourceType, confidence) {
  if (kind === 'summary') return false;
  if (kind === 'resource') return true;
  // Plan-master 8.4: under a condition, "orders, signing and anything sent to a patient" also covers reply drafts, notes and queued orders.
  if (run.askFrequency === 'orders-signing') return ORDER_OR_SIGN.has(resourceType) || (Array.isArray(run.capabilities) && ['triage', 'note', 'order'].includes(kind));
  if (run.askFrequency === 'low-confidence') return confidence == null || confidence < run.confidenceThreshold;
  return true;
}

// ---------- Edit tracking ----------
export function levenshtein(a, b) {
  const s = String(a); const t = String(b);
  if (s === t) return 0;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= t.length; j += 1) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[t.length];
}

/** Field-by-field diff between what the agent proposed and what the clinician signed. */
export function editDiff(proposed, final) {
  const fields = {};
  let size = 0; let total = 0;
  const flat = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));
  for (const key of new Set([...Object.keys(proposed || {}), ...Object.keys(final || {})])) {
    const from = flat(proposed?.[key]).slice(0, 4000); const to = flat(final?.[key]).slice(0, 4000);
    total += from.length;
    if (from === to) continue;
    const distance = levenshtein(from, to);
    size += distance;
    fields[key] = { from: proposed?.[key] ?? null, to: final?.[key] ?? null, distance };
  }
  return { fields, size, ratio: Math.round((size / Math.max(total, 1)) * 1000) / 1000, changed: Object.keys(fields).length > 0 };
}

// A short, readable line for each record the agent read ("Show what the agent saw").
function summarize(r) {
  const coded = (c) => c?.text || c?.coding?.[0]?.display || c?.coding?.[0]?.code || '';
  switch (r.resourceType) {
    case 'Patient': return `${r.name?.[0]?.family || ''} · born ${r.birthDate || 'unknown'} · ${r.gender || ''}`;
    case 'ImagingStudy': return `${r.modality?.[0]?.code || ''} ${r.description || ''} · ${String(r.started || '').slice(0, 10)} · reason: ${coded(r.reasonCode?.[0]) || 'not stated'}`;
    case 'DiagnosticReport': return `${coded(r.code)} · ${r.status} · impression: ${(r.conclusion || 'none').slice(0, 140)}`;
    case 'ServiceRequest': return `${coded(r.code)} · ${r.priority || 'routine'} · reason: ${coded(r.reasonCode?.[0]) || 'not stated'}`;
    case 'Communication': return `${r.topic?.text || 'Message'}: ${(r.payload?.[0]?.contentString || '').slice(0, 160)}`;
    case 'MedicationRequest': return `${coded(r.medicationCodeableConcept)} · ${r.status}`;
    case 'Observation': return `${coded(r.code)}: ${r.valueQuantity ? `${r.valueQuantity.value} ${r.valueQuantity.unit || ''}` : r.valueString || ''} · ${r.status}`;
    default: return coded(r.code) || r.status || '';
  }
}
const NAMES = { Patient: 'Patient chart', ImagingStudy: 'Imaging study', DiagnosticReport: 'Report', ServiceRequest: 'Order', Communication: 'Message', MedicationRequest: 'Medication', Observation: 'Result', Task: 'Task' };

export function createHitl({ store, fhir }) {
  const agentActor = (run) => ({ kind: 'agent', id: run.agentId, role: 'agent' });

  async function patchRun(tx, id, patch) {
    const { _seq, ...doc } = await tx.get('Run', id);
    return tx.save('Run', { ...doc, ...patch }, { updatedBy: 'system' });
  }

  /**
   * Called when the agent has finished working on its staging branch. Each
   * resource it wrote becomes one proposal on the target branch. Returns the
   * number of proposals that are waiting for a clinician.
   */
  async function afterAgent(run, agent, result) {
    const steps = await store.query('TraceStep', { groupKey: run.id });
    const mine = steps.filter((s) => s.who.kind === 'agent');
    const written = new Map();
    for (const s of mine) {
      if (!['fhir.create', 'fhir.update'].includes(s.did.type) || s.did.args?.type === 'Provenance') continue;
      written.set(`${s.did.args.type}/${s.did.args.id}`, s);
    }
    const saw = [];
    for (const s of mine) for (const r of (s.did.type.startsWith('fhir.') || s.did.type === 'chart.open' ? s.saw.resources : [])) {
      if (!written.has(r.ref) && !saw.some((x) => x.ref === r.ref)) saw.push({ ref: r.ref, versionId: r.versionId });
    }
    const target = run.targetBranch;
    let waiting = 0;
    const made = [];
    await store.transaction(async (tx) => {
      for (const [ref, step] of written) {
        const [type, id] = ref.split('/');
        const staged = await tx.get(type, id, { branch: run.branch });
        if (!staged) continue;
        let { kind, content } = extract(staged);
        let planted = false;
        if (run.probe) {
          const wrong = plantError(kind, content);
          if (wrong) { content = wrong; planted = true; }
        }
        const confidence = typeof result?.confidence === 'number' ? result.confidence : null;
        const subject = run.subject;
        let ask = needsAsk(run, kind, type, confidence) || planted;
        let applied = null;
        if (!ask) {
          applied = await autoApply(tx, run, kind, content, staged);
          if (!applied) ask = true;
        }
        const task = await tx.save('Task', {
          resourceType: 'Task', status: ask ? 'requested' : 'completed', intent: 'proposal', authoredOn: tx.now(),
          code: { coding: [{ system: TASK_SYSTEM, code: 'agent-proposal' }], text: kind === 'report' ? 'AI-drafted report' : kind === 'triage' ? 'AI-suggested message priority' : kind === 'summary' ? 'AI chart summary' : kind === 'note' ? 'AI-drafted note' : kind === 'order' ? 'AI-queued order' : `AI-drafted ${type}` },
          focus: subject ? { reference: subject } : undefined, for: staged._patient ? { reference: staged._patient } : undefined,
          requester: { identifier: { system: 'urn:hospital-desktop:agent', value: agent.id }, display: `${agent.name} v${run.version}` },
          description: 'AI-drafted — not signed',
          input: [
            { type: { text: 'run' }, valueString: run.id }, { type: { text: 'kind' }, valueString: kind },
            { type: { text: 'proposal' }, valueString: JSON.stringify(content) }, { type: { text: 'staged' }, valueString: `${ref}@${run.branch}` },
            ...(confidence != null ? [{ type: { text: 'confidence' }, valueDecimal: confidence }] : []),
            ...(step.why ? [{ type: { text: 'reasoning' }, valueString: step.why }] : []),
            { type: { text: 'saw' }, valueString: JSON.stringify(saw.slice(0, 50)) },
          ],
          output: ask ? undefined : [{ type: { text: 'decision' }, valueString: 'auto-applied' }, { type: { text: 'result' }, valueString: applied }, { type: { text: 'decided-at' }, valueString: tx.now() }],
          _patient: staged._patient,
        }, { branch: target, updatedBy: 'system' });
        await recordAction(tx, {
          runId: run.id, actor: agentActor(run), kind: 'create', action: ask ? 'proposal.create' : 'proposal.auto-apply', branch: target,
          args: { type: 'Task', id: task.id, kind, proposal: task.id, from: ref, ...(applied ? { applied } : {}), askFrequency: run.askFrequency },
          why: step.why ?? null, resources: [{ ref, versionId: staged.meta.versionId }], entityRef: `Task/${task.id}`, versionId: task.meta.versionId, patientRef: staged._patient,
          approval: { status: ask ? 'proposed' : 'auto-applied' },
          description: ask ? `agent proposal waiting for a clinician (Task/${task.id})` : `agent output applied unsigned under ask-frequency "${run.askFrequency}" (Task/${task.id})`,
        });
        if (ask) waiting += 1;
        made.push(task.id);
      }
      if (waiting) await patchRun(tx, run.id, { awaitingDecision: true, result: result ?? {}, proposals: made });
    });
    if (!waiting) await endRun(store, run.id, agentActor(run), 'completed', { ...(result ?? {}), proposals: made });
    return waiting;
  }

  // Low-interruption settings apply the draft without asking. It stays unsigned and marked as AI-drafted.
  async function autoApply(tx, run, kind, content, staged) {
    const target = run.targetBranch;
    const [type, id] = String(run.subject || '').split('/');
    if (kind === 'summary' || kind === 'note') {
      // A summary needs no approval; a note under a low-interruption setting lands unsigned and marked as AI-drafted.
      const { id: _id, meta, _seq, ...base } = staged;
      const saved = await tx.save('DocumentReference', { ...base, docStatus: 'preliminary', extension: [...(base.extension || []).filter((e) => e.url !== AI_DRAFT_URL), { url: AI_DRAFT_URL, valueString: run.id }], _patient: staged._patient }, { branch: target, updatedBy: 'agent' });
      return `DocumentReference/${saved.id}`;
    }
    if (kind === 'report' && type === 'ImagingStudy') {
      const ref = `ImagingStudy/${id}`;
      const existing = await tx.query('DiagnosticReport', { where: (r) => (r.imagingStudy || []).some((s) => s.reference === ref) && !isAddendum(r) }, { branch: target });
      if (existing.length) return null;
      const { id: _id, meta, ...base } = stripInternal(staged);
      const saved = await tx.save('DiagnosticReport', {
        ...base, status: 'preliminary', conclusion: content.impression,
        extension: [{ url: REPORT_URLS.technique, valueString: content.technique }, { url: REPORT_URLS.findings, valueString: content.findings }, { url: AI_DRAFT_URL, valueString: run.id }],
      }, { branch: target, updatedBy: 'agent' });
      return `DiagnosticReport/${saved.id}`;
    }
    if (kind === 'triage' && type === 'Communication') {
      const saved = await tx.save('Task', {
        resourceType: 'Task', status: 'requested', intent: 'proposal', priority: content.label === 'urgent' ? 'urgent' : 'routine', authoredOn: tx.now(),
        code: { coding: [{ system: TASK_SYSTEM, code: 'message-triage' }], text: 'Message triage' }, focus: { reference: run.subject },
        for: staged._patient ? { reference: staged._patient } : undefined, description: `AI label, not confirmed: ${content.label}`,
        requester: { identifier: { system: 'urn:hospital-desktop:agent', value: run.agentId } },
        output: [{ type: { text: 'triage-label' }, valueString: content.label }], extension: [{ url: AI_DRAFT_URL, valueString: run.id }], _patient: staged._patient,
      }, { branch: target, updatedBy: 'agent' });
      return `Task/${saved.id}`;
    }
    return null;
  }

  // ---------- Applying an accepted proposal, as the clinician ----------
  const APPLY = {
    async report(tx, ctx, task, content) {
      const ref = task.focus?.reference;
      if (!ref?.startsWith('ImagingStudy/')) throw new HttpError(422, 'This proposal is not linked to an imaging study');
      for (const key of ['technique', 'findings', 'impression']) if (typeof content[key] !== 'string') throw new HttpError(422, `Report ${key} must be text`);
      const existing = (await tx.query('DiagnosticReport', { where: (r) => (r.imagingStudy || []).some((s) => s.reference === ref) && !isAddendum(r) }, { branch: ctx.branch }))[0];
      if (existing && SIGNED.includes(existing.status)) throw new HttpError(409, 'This study already has a signed report. Reject the proposal instead');
      const study = await tx.get('ImagingStudy', ref.split('/')[1], { branch: ctx.branch });
      const base = existing ? stripInternal((({ _seq, ...d }) => d)(existing)) : {
        resourceType: 'DiagnosticReport', subject: task.for, code: { text: study?.description || 'Imaging report' }, imagingStudy: [{ reference: ref }],
        effectiveDateTime: study?.started || undefined, basedOn: study?.basedOn,
      };
      const draft = {
        ...base, status: 'preliminary', conclusion: content.impression,
        extension: [...(base.extension || []).filter((e) => ![REPORT_URLS.technique, REPORT_URLS.findings, AI_DRAFT_URL].includes(e.url)),
          { url: REPORT_URLS.technique, valueString: content.technique }, { url: REPORT_URLS.findings, valueString: content.findings }, { url: AI_DRAFT_URL, valueString: str(task, 'run') }],
      };
      const { saved } = await fhir.writeInTx(tx, 'DiagnosticReport', existing?.id ?? null, draft, ctx);
      const signed = await fhir.writeInTx(tx, 'DiagnosticReport', saved.id, { ...stripInternal((({ _seq, ...d }) => d)(saved)), status: 'final' }, ctx);
      return `DiagnosticReport/${signed.saved.id}`;
    },
    async triage(tx, ctx, task, content) {
      if (!TRIAGE_LABELS.includes(content.label)) throw new HttpError(422, `label must be one of ${TRIAGE_LABELS.join(', ')}`);
      const ref = task.focus?.reference;
      const { saved } = await fhir.writeInTx(tx, 'Task', null, {
        resourceType: 'Task', status: 'requested', intent: 'order', priority: content.label === 'urgent' ? 'urgent' : 'routine', authoredOn: tx.now(),
        code: { coding: [{ system: TASK_SYSTEM, code: 'message-triage' }], text: 'Message triage' }, focus: { reference: ref }, for: task.for,
        description: `Priority: ${content.label}`, requester: { display: ctx.actor.id }, output: [{ type: { text: 'triage-label' }, valueString: content.label }],
      }, ctx);
      await fhir.writeInTx(tx, 'Task', saved.id, transitionDoc(stripInternal((({ _seq, ...d }) => d)(saved)), 'completed'), ctx);
      const reply = String(content.reply || '').trim();
      if (reply && ref?.startsWith('Communication/')) {
        const message = await tx.get('Communication', ref.split('/')[1], { branch: ctx.branch });
        const thread = (message?.identifier || []).find((i) => i.system === 'urn:hospital-desktop:thread')?.value || message?.id;
        await fhir.writeInTx(tx, 'Communication', null, {
          resourceType: 'Communication', status: 'completed', subject: task.for, sent: tx.now(), sender: { display: ctx.actor.id }, recipient: task.for ? [task.for] : undefined,
          topic: message?.topic, payload: [{ contentString: reply }], inResponseTo: [{ reference: ref }], identifier: thread ? [{ system: 'urn:hospital-desktop:thread', value: thread }] : undefined,
        }, ctx);
      }
      return `Task/${saved.id}`;
    },
    /** Nothing to sign: the clinician's thumbs are the only feedback. */
    async summary() { return null; },
    /** The clinician edits and signs the note: written as preliminary, then signed. */
    async note(tx, ctx, task, content) {
      const body = String(content.text ?? '').split('[Check this]').join('').replace(/[ \t]+\n/g, '\n').trim();
      if (!body) throw new HttpError(422, 'The note is empty');
      const draft = {
        resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', subject: task.for, date: tx.now(), description: String(content.title || 'Note').slice(0, 120),
        type: content.noteType ?? { text: String(content.title || 'Note').slice(0, 120) }, author: [{ display: ctx.actor.id }],
        ...(content.encounter ? { context: { encounter: [{ reference: content.encounter }] } } : {}),
        content: [{ attachment: { contentType: 'text/plain', data: Buffer.from(`${body}\n`, 'utf8').toString('base64') } }],
        extension: [{ url: AI_DRAFT_URL, valueString: str(task, 'run') }],
      };
      const { saved } = await fhir.writeInTx(tx, 'DocumentReference', null, draft, ctx);
      const signed = await fhir.writeInTx(tx, 'DocumentReference', saved.id, { ...stripInternal((({ _seq, ...d }) => d)(saved)), docStatus: 'final' }, ctx);
      return `DocumentReference/${signed.saved.id}`;
    },
    /** The clinician signs a queued order: it is placed in their name. */
    async order(tx, ctx, task, content) {
      const resource = content.resource;
      if (!resource?.resourceType || !['ServiceRequest', 'MedicationRequest'].includes(resource.resourceType)) throw new HttpError(422, 'Nothing to order');
      const { id: _id, meta, extension, ...body } = resource;
      const { saved } = await fhir.writeInTx(tx, resource.resourceType, null, { ...body, status: resource.resourceType === 'ServiceRequest' ? 'active' : body.status || 'draft', authoredOn: tx.now(), requester: { display: ctx.actor.id }, extension: [...(extension || []).filter((e) => e.url !== AI_DRAFT_URL), { url: AI_DRAFT_URL, valueString: str(task, 'run') }] }, ctx);
      return `${saved.resourceType}/${saved.id}`;
    },
    async resource(tx, ctx, task, content) {
      const resource = content.resource;
      if (!resource?.resourceType) throw new HttpError(422, 'Nothing to write');
      const { id: _id, meta, ...body } = resource;
      const { saved } = await fhir.writeInTx(tx, resource.resourceType, null, body, ctx);
      return `${saved.resourceType}/${saved.id}`;
    },
  };

  const human = (ctx) => { if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only a person can decide on a proposal'); };

  async function decide(id, body, ctx) {
    human(ctx);
    if (ctx.asOf) throw new HttpError(409, 'Decisions are disabled while viewing a past time');
    const decision = body?.decision;
    if (!['accept', 'edit', 'reject'].includes(decision)) throw new HttpError(422, 'decision must be accept, edit or reject');
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
    if (decision === 'reject' && reason.length < 3) throw new HttpError(422, 'A reason is required to reject a proposal');
    let runToEnd = null;
    const out = await store.transaction(async (tx) => {
      const task = await tx.get('Task', id, { branch: ctx.branch });
      if (!task || !isProposal(task)) throw new HttpError(404, `No proposal ${id} on branch "${ctx.branch}"`);
      if (task.status !== 'requested') throw new HttpError(409, 'This proposal has already been decided');
      const run = await tx.get('Run', str(task, 'run'));
      if (!run || run.endedAt) throw new HttpError(409, 'This proposal was withdrawn because its run was stopped');
      if (run.targetBranch !== ctx.branch) throw new HttpError(409, 'This proposal belongs to a different branch');
      if (await engagedSwitch(tx, { agentId: run.agentId, mode: 'hitl' })) throw new HttpError(409, 'Agents are stopped by a kill switch, so this proposal cannot be accepted or rejected right now');
      const kind = str(task, 'kind');
      const proposed = parse(str(task, 'proposal'), {});
      const wctx = { actor: ctx.actor, run, runId: run.id, branch: ctx.branch, asOf: null, why: reason || null, idempotencyKey: null };
      let final = proposed; let diff = null; let verdict = decision === 'reject' ? 'rejected' : 'accepted'; let result = null;
      if (decision === 'edit') {
        if (!body.content || typeof body.content !== 'object') throw new HttpError(422, 'Edited content is required');
        final = { ...proposed, ...body.content };
        diff = editDiff(proposed, final);
        verdict = diff.changed ? 'edited' : 'accepted';
        if (!diff.changed) diff = null;
      }
      if (verdict !== 'rejected') result = await APPLY[kind](tx, wctx, task, final);
      const steps = await tx.query('TraceStep', { groupKey: run.id });
      const firstSeen = steps.find((s) => s.did.type === 'proposal.view' && s.did.args?.proposal === id)?.when.wall ?? null;
      const now = tx.now();
      const from = firstSeen ?? task.authoredOn;
      const decisionSeconds = Math.max(0, Math.round((Date.parse(now) - Date.parse(from)) / 100) / 10);
      const { _seq, ...doc } = task;
      const next = transitionDoc(stripInternal(doc), verdict === 'rejected' ? 'rejected' : 'completed', reason || undefined);
      next.output = [
        { type: { text: 'decision' }, valueString: verdict }, { type: { text: 'decided-by' }, valueString: ctx.actor.id }, { type: { text: 'decided-at' }, valueString: now },
        { type: { text: 'decision-seconds' }, valueDecimal: decisionSeconds }, { type: { text: 'timed-from' }, valueString: firstSeen ? 'first-view' : 'created' },
        ...(reason ? [{ type: { text: 'reason' }, valueString: reason }] : []), ...(result ? [{ type: { text: 'result' }, valueString: result }] : []),
        ...(diff ? [{ type: { text: 'edit-diff' }, valueString: JSON.stringify(diff) }] : []),
      ];
      const savedTask = (await fhir.writeInTx(tx, 'Task', id, next, { ...wctx, why: null })).saved;
      let provenance = null;
      if (result) {
        const [rt, rid] = result.split('/');
        const written = await tx.get(rt, rid, { branch: ctx.branch });
        provenance = await tx.save('Provenance', {
          resourceType: 'Provenance', target: [{ reference: `${result}/_history/${written.meta.versionId}` }], recorded: now,
          activity: { text: verdict === 'edited' ? 'AI-drafted, edited and signed by a clinician' : 'AI-drafted, accepted and signed by a clinician' },
          agent: [
            { type: { text: 'author' }, who: { identifier: { system: 'urn:hospital-desktop:agent', value: run.agentId }, display: task.requester?.display } },
            { type: { text: 'verifier' }, who: { identifier: { value: ctx.actor.id }, display: ctx.actor.role } },
          ],
          entity: [{ role: 'derivation', what: { reference: `Task/${id}` } }, { role: 'source', what: { identifier: { system: 'urn:hospital-desktop:run', value: run.id } } }],
          _patient: task._patient,
        }, { branch: ctx.branch, updatedBy: 'system' });
      }
      await recordAction(tx, {
        runId: run.id, actor: ctx.actor, kind: 'execute', action: `proposal.${decision === 'reject' ? 'reject' : verdict === 'edited' ? 'edit' : 'accept'}`, branch: ctx.branch,
        args: { proposal: id, kind, result, provenance: provenance ? `Provenance/${provenance.id}` : null, editSize: diff?.size ?? 0, decisionSeconds }, why: reason || null,
        resources: [{ ref: `Task/${id}`, versionId: task.meta.versionId }], entityRef: `Task/${id}`, versionId: savedTask.meta.versionId, patientRef: task._patient,
        approval: { status: verdict === 'accepted' ? 'approved' : verdict, diff: diff?.fields ?? null },
        description: `proposal ${verdict} by ${ctx.actor.id} (Task/${id})`,
      });
      const pending = (await tx.query('Task', { where: (t) => isProposal(t) && t.status === 'requested' && str(t, 'run') === run.id }, { branch: ctx.branch })).length;
      if (!pending) runToEnd = run.id;
      return { proposal: stripInternal(savedTask), decision: verdict, result, provenance: provenance ? `Provenance/${provenance.id}` : null, edit: diff, decisionSeconds, plantedError: Boolean(run.probe) };
    });
    if (runToEnd) await endRun(store, runToEnd, ctx.actor, 'completed');
    return out;
  }

  /** Records the first time a clinician had the card on screen, so decision time starts there. */
  async function seen(id, ctx) {
    human(ctx);
    return store.transaction(async (tx) => {
      const task = await tx.get('Task', id, { branch: ctx.branch });
      if (!task || !isProposal(task)) throw new HttpError(404, `No proposal ${id} on branch "${ctx.branch}"`);
      const runId = str(task, 'run');
      const steps = await tx.query('TraceStep', { groupKey: runId });
      const already = steps.find((s) => s.did.type === 'proposal.view' && s.did.args?.proposal === id && s.who.id === ctx.actor.id);
      if (already || task.status !== 'requested') return { seenAt: already?.when.wall ?? null, first: false };
      await recordAction(tx, {
        runId, actor: ctx.actor, kind: 'read', action: 'proposal.view', args: { proposal: id }, branch: ctx.branch, audit: false,
        resources: [{ ref: `Task/${id}`, versionId: task.meta.versionId }], description: `proposal shown (Task/${id})`,
      });
      return { seenAt: tx.now(), first: true };
    });
  }

  async function model(task, runs, { detail = false } = {}) {
    const run = runs.get(str(task, 'run')) ?? null;
    const decision = output(task, 'decision')?.valueString ?? null;
    const card = {
      id: task.id, kind: str(task, 'kind'), runId: run?.id ?? null, branch: task._branch, subject: task.focus?.reference ?? null, patient: task.for?.reference ?? null,
      agent: { id: run?.agentId ?? null, label: task.requester?.display ?? '' }, createdAt: task.authoredOn, confidence: input(task, 'confidence')?.valueDecimal ?? null,
      reasoning: str(task, 'reasoning'), content: parse(str(task, 'proposal'), {}),
      status: task.status === 'requested' ? (run && !run.endedAt ? 'pending' : 'withdrawn') : decision,
      decidedBy: output(task, 'decided-by')?.valueString ?? null, decidedAt: output(task, 'decided-at')?.valueString ?? null, reason: output(task, 'reason')?.valueString ?? null,
      result: output(task, 'result')?.valueString ?? null, decisionSeconds: output(task, 'decision-seconds')?.valueDecimal ?? null,
      edit: parse(output(task, 'edit-diff')?.valueString, null), askFrequency: run?.askFrequency ?? null, practice: task._branch !== 'main',
    };
    if (decision && decision !== 'auto-applied') card.plantedError = Boolean(run?.probe);
    if (detail && run) {
      const refs = parse(str(task, 'saw'), []);
      card.saw = { branch: run.branch, asOf: run.startedAt, resources: [] };
      for (const r of refs.slice(0, 30)) {
        const [type, rid] = r.ref.split('/');
        const versions = await store.history(type, rid, { branch: run.branch }).catch(() => []);
        const doc = versions.find((v) => String(v.meta.versionId) === String(r.versionId)) ?? versions[versions.length - 1];
        card.saw.resources.push({ ref: r.ref, versionId: r.versionId, name: NAMES[type] || type, summary: doc ? summarize(doc) : 'no longer available' });
      }
    }
    return card;
  }

  async function list(ctx, { subject = null, status = null, runId = null, detail = true } = {}) {
    const tasks = await store.query('Task', { where: (t) => isProposal(t) && (!subject || t.focus?.reference === subject) && (!runId || str(t, 'run') === runId) }, { branch: ctx.branch, asOf: ctx.asOf });
    const runs = new Map();
    for (const t of tasks) { const rid = str(t, 'run'); if (!runs.has(rid)) runs.set(rid, await store.get('Run', rid)); }
    const cards = [];
    for (const t of tasks) {
      const card = await model(t, runs, { detail });
      if (!status || card.status === status) cards.push(card);
    }
    return cards.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  /** HCI report: how clinicians responded to proposals, per agent version. */
  async function report({ agentId = null, version = null, study = null } = {}) {
    const runs = await store.query('Run', { where: (r) => r.mode === 'hitl' && r.agentId && (!agentId || r.agentId === agentId) && (!version || r.version === version) && (!study || r.study === study) });
    const agents = new Map((await store.query('Agent')).map((a) => [a.id, a]));
    const byBranch = new Map();
    for (const run of runs) {
      if (byBranch.has(run.targetBranch)) continue;
      const tasks = await store.query('Task', { where: isProposal }, { branch: run.targetBranch }).catch(() => []);
      byBranch.set(run.targetBranch, tasks);
    }
    const runMap = new Map(runs.map((r) => [r.id, r]));
    const groups = new Map();
    for (const run of runs) {
      const key = `${run.agentId}@${run.version}`;
      if (!groups.has(key)) groups.set(key, { agentId: run.agentId, version: run.version, name: agents.get(run.agentId)?.name ?? run.agentId, current: agents.get(run.agentId)?.version === run.version, live: [], practice: [], probes: [], cases: { live: 0, practice: 0, probes: 0 } });
      const g = groups.get(key);
      const bucket = run.probe ? 'probes' : run.targetBranch === 'main' ? 'live' : 'practice';
      g.cases[bucket] += 1;
      // Plan-master 9.4: drafts used, edited or discarded, edit size, questions, permissions, time to answer, guidance.
      const st = interactionStats(await store.query('TraceStep', { groupKey: run.id }));
      g.interactions = g.interactions || { runs: 0 };
      g.interactions.runs += 1;
      for (const [k, v] of Object.entries(st)) { if (typeof v === 'number') g.interactions[k] = (g.interactions[k] || 0) + v; else if (typeof v === 'boolean') g.interactions[k] = (g.interactions[k] || 0) + (v ? 1 : 0); }
      if (st.timeToAnswer != null) { g.interactions.timeToAnswerSum = (g.interactions.timeToAnswerSum || 0) + st.timeToAnswer; g.interactions.timeToAnswerN = (g.interactions.timeToAnswerN || 0) + 1; g.interactions.timeToAnswer = Math.round((g.interactions.timeToAnswerSum / g.interactions.timeToAnswerN) * 10) / 10; }
      for (const t of byBranch.get(run.targetBranch).filter((x) => str(x, 'run') === run.id)) g[bucket].push(await model(t, runMap, { detail: false }));
    }
    const median = (values) => { const v = values.filter((x) => x != null).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : Math.round(((v[v.length / 2 - 1] + v[v.length / 2]) / 2) * 10) / 10) : null; };
    const mean = (values) => { const v = values.filter((x) => x != null); return v.length ? Math.round((v.reduce((n, x) => n + x, 0) / v.length) * 100) / 100 : null; };
    const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : null);
    const stats = (cards, cases) => {
      const count = (s) => cards.filter((c) => c.status === s).length;
      const accepted = count('accepted'); const edited = count('edited'); const rejected = count('rejected');
      const decided = accepted + edited + rejected;
      const asks = cards.filter((c) => c.status !== 'auto-applied').length;
      const edits = cards.filter((c) => c.status === 'edited');
      return {
        cases, proposals: cards.length, asks, autoApplied: count('auto-applied'), pending: count('pending'), withdrawn: count('withdrawn'), decided, accepted, edited, rejected,
        acceptanceRate: rate(accepted + edited, decided), acceptedUnchangedRate: rate(accepted, decided), rejectionRate: rate(rejected, decided),
        meanEditSize: mean(edits.map((c) => c.edit?.size)), meanEditRatio: mean(edits.map((c) => c.edit?.ratio)),
        medianDecisionSeconds: median(cards.filter((c) => ['accepted', 'edited', 'rejected'].includes(c.status)).map((c) => c.decisionSeconds)), asksPerCase: cases ? Math.round((asks / cases) * 100) / 100 : null,
      };
    };
    const out = [...groups.values()].map((g) => {
      const probe = stats(g.probes, g.cases.probes);
      return {
        interactions: g.interactions,
        agentId: g.agentId, version: g.version, name: g.name, current: g.current, live: stats(g.live, g.cases.live), practice: stats(g.practice, g.cases.practice),
        automationBias: { planted: g.probes.length, decided: probe.decided, acceptedUnchanged: probe.accepted, caught: probe.edited + probe.rejected, acceptedUnchangedRate: probe.acceptedUnchangedRate },
        proposals: [...g.live, ...g.practice, ...g.probes].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
      };
    }).sort((a, b) => a.name.localeCompare(b.name) || String(b.version).localeCompare(String(a.version)));
    return { generatedAt: store.now(), note: 'Acceptance measures how clinicians responded, not whether the agent was right. A high acceptance rate with accepted planted errors points to automation bias.', agents: out };
  }

  /** Marks a patient as test data on a sandbox branch, after the launcher's explicit confirmation. */
  async function attestSynthetic(patientRef, branch, actor) {
    return store.transaction(async (tx) => {
      const info = await tx.getBranch(branch);
      if (info?.kind !== 'sandbox') throw new HttpError(422, 'Patients can only be marked as test data on a sandbox branch');
      const patient = await tx.get('Patient', String(patientRef).split('/')[1], { branch });
      if (!patient) throw new HttpError(422, `${patientRef} was not found on branch "${branch}"`);
      if (isSyntheticPatient(patient)) return patient;
      const { _seq, ...doc } = patient;
      const saved = await tx.save('Patient', { ...doc, meta: { ...doc.meta, security: [...(doc.meta?.security || []), HTEST] } }, { branch, updatedBy: actor.role });
      await recordAction(tx, {
        actor, kind: 'update', action: 'patient.attest-synthetic', args: { type: 'Patient', id: saved.id }, branch, entityRef: `Patient/${saved.id}`, versionId: saved.meta.versionId,
        patientRef: `Patient/${saved.id}`, description: `${actor.id} confirmed Patient/${saved.id} is synthetic on ${branch}`,
      });
      return saved;
    });
  }

  return { afterAgent, decide, seen, list, report, attestSynthetic };
}
