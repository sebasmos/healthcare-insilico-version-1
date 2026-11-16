// Ablation (§9g). A Run may carry overlays that change what its agent can
// see: hide a kind of record, delay it, or alter one value. Overlays are
// applied to every read the agent makes inside that Run. Nothing in the store
// changes: people, verifiers and other runs still see the real chart.
//
// The report answers two questions for each ablated run: did the agent still
// reach the right answer, and did it notice that something was missing or
// odd, or did it answer confidently anyway.
import { HttpError } from '../../platform/server/http.mjs';
import { createRun, endRun, withStatus } from './runs.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { verifierScore } from './grader.mjs';
import { FHIR_TYPES } from '../../platform/server/validate.mjs';

export const HIDEABLE = {
  priors: 'Prior imaging and its reports',
  labs: 'Laboratory results',
  vitals: 'Vital signs',
  notes: 'Clinical notes',
  history: 'Past history (problem list, past visits, procedures)',
  meds: 'Medications (orders, administrations, dispenses)',
  allergies: 'Allergies',
  orders: 'Orders (tests, imaging and referrals)',
  later: 'Everything recorded after a moment in care',
  images: 'The images themselves (the study record stays, without its series)',
};
/** Flags an agent can raise that count as noticing a gap or an oddity. */
export const NOTICE_FLAGS = ['missing-data', 'implausible-value', 'inconsistent-data', 'wrong-patient', 'wrong-patient-context'];
const CATEGORY = (r) => (r.category || []).flatMap((c) => c.coding || []).map((c) => c.code);
const CODES = (r) => [...(r.code?.coding || []), ...(r.type?.coding || []), ...(r.medicationCodeableConcept?.coding || [])].map((c) => c.code);
const ref = (r) => `${r.resourceType}/${r.id}`;

function matches(what, r, run, options = {}) {
  if (ref(r) === run.subject || r.resourceType === 'Patient') return false;
  switch (what) {
    case 'labs': return r.resourceType === 'Observation' && CATEGORY(r).includes('laboratory') && (!options.code || CODES(r).includes(options.code));
    case 'vitals': return r.resourceType === 'Observation' && CATEGORY(r).includes('vital-signs');
    case 'notes': return r.resourceType === 'DocumentReference' && (!options.noteType || CODES(r).includes(options.noteType));
    case 'priors': return r.resourceType === 'ImagingStudy' || (r.resourceType === 'DiagnosticReport' && !(r.imagingStudy || []).some((s) => s.reference === run.subject));
    case 'history': return ['Condition', 'Procedure', 'Immunization'].includes(r.resourceType) || (r.resourceType === 'Encounter' && r.status === 'finished');
    case 'meds': return ['MedicationRequest', 'MedicationAdministration', 'MedicationDispense', 'MedicationStatement'].includes(r.resourceType);
    case 'allergies': return r.resourceType === 'AllergyIntolerance';
    case 'orders': return r.resourceType === 'ServiceRequest';
    case 'later': return Boolean(options.after) && String(r._validAt || '') > options.after;
    default: return false;
  }
}
const selected = (o, r, run) => (o.what ? matches(o.what, r, run, o) : r.resourceType === o.resourceType && (!o.code || CODES(r).includes(o.code)));

export function validateOverlays(input) {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > 12) throw new HttpError(422, 'overlays must be a list of at most 12 items');
  return input.map((o, i) => {
    const fail = (m) => { throw new HttpError(422, `Overlay ${i + 1}: ${m}`); };
    if (!o || typeof o !== 'object') fail('must be an object');
    const target = () => {
      if (o.what != null) { if (!HIDEABLE[o.what] || o.what === 'images') fail(`"what" must be one of ${Object.keys(HIDEABLE).filter((k) => k !== 'images').join(', ')}`); if (o.what === 'later' && Number.isNaN(Date.parse(o.after))) fail('"later" needs "after": a date and time'); return { what: o.what, ...(o.code && o.what === 'labs' ? { code: String(o.code).slice(0, 40) } : {}), ...(o.what === 'later' ? { after: new Date(o.after).toISOString() } : {}), ...(o.noteType ? { noteType: String(o.noteType).slice(0, 20) } : {}) }; }
      if (!FHIR_TYPES.has(o.resourceType) || ['Patient', 'AuditEvent'].includes(o.resourceType)) fail('needs "what" or a supported "resourceType"');
      return { resourceType: o.resourceType, ...(o.code ? { code: String(o.code).slice(0, 40) } : {}) };
    };
    if (o.type === 'hide') {
      if (o.what === 'images') return { type: 'hide', what: 'images' };
      return { type: 'hide', ...target() };
    }
    if (o.type === 'delay') {
      const steps = o.afterSteps == null ? null : Number(o.afterSteps);
      const seconds = o.afterSeconds == null ? null : Number(o.afterSeconds);
      if ((steps == null) === (seconds == null)) fail('a delay needs exactly one of afterSteps or afterSeconds');
      if (steps != null && (!Number.isInteger(steps) || steps < 1 || steps > 500)) fail('afterSteps must be a whole number from 1 to 500');
      if (seconds != null && !(seconds > 0 && seconds <= 86400)) fail('afterSeconds must be between 0 and 86400');
      return { type: 'delay', ...target(), ...(steps != null ? { afterSteps: steps } : { afterSeconds: seconds }) };
    }
    if (o.type === 'change') {
      if (!FHIR_TYPES.has(o.resourceType) || ['Patient', 'AuditEvent'].includes(o.resourceType)) fail('a change needs a supported resourceType');
      if (typeof o.code !== 'string' || !o.code) fail('a change needs the code of the record to alter (for example a LOINC code)');
      if (typeof o.path !== 'string' || !/^[A-Za-z][A-Za-z0-9.]{0,60}$/.test(o.path)) fail('a change needs a path such as valueQuantity.value');
      const hasSet = o.value !== undefined; const hasMul = o.multiply !== undefined;
      if (hasSet === hasMul) fail('a change needs exactly one of value or multiply');
      if (hasMul && !(Number.isFinite(Number(o.multiply)) && Number(o.multiply) !== 1)) fail('multiply must be a number other than 1');
      if (hasSet && !['string', 'number', 'boolean'].includes(typeof o.value)) fail('value must be text, a number or true/false');
      return { type: 'change', resourceType: o.resourceType, code: o.code.slice(0, 40), path: o.path, ...(hasSet ? { value: o.value } : { multiply: Number(o.multiply) }) };
    }
    return fail('type must be hide, delay or change');
  });
}

const NAMES = { '2160-0': 'Creatinine', '2823-3': 'Potassium', '2345-7': 'Glucose', '718-7': 'Haemoglobin', '2524-7': 'Lactate', '10839-9': 'Troponin I', '1963-8': 'Bicarbonate', '6690-2': 'White cell count', '8867-4': 'Heart rate', '8480-6': 'Systolic blood pressure', '8462-4': 'Diastolic blood pressure', '8310-5': 'Temperature', '59408-5': 'Oxygen saturation', '9279-1': 'Respiratory rate' };
const named = (o) => (NAMES[o.code] ? `${NAMES[o.code]} (${o.code})` : `${o.resourceType}${o.code ? ` ${o.code}` : ''}`);

/** One overlay in plain English. */
export function describeOverlay(o) {
  const thing = o.what === 'later' ? `everything recorded after ${String(o.after).slice(0, 16).replace('T', ' ')}` : o.what === 'labs' && o.code ? `${named(o)} results` : o.what ? HIDEABLE[o.what].toLowerCase() : `${named(o)} records`;
  if (o.type === 'hide') return `Hidden: ${thing}`;
  if (o.type === 'delay') return `Delayed: ${thing} appear only after ${o.afterSteps != null ? `${o.afterSteps} step${o.afterSteps === 1 ? '' : 's'}` : `${o.afterSeconds} seconds`}`;
  return `Changed: ${named(o)} ${o.path === 'valueQuantity.value' ? '' : `${o.path} `}${o.multiply != null ? `multiplied by ${o.multiply}` : `set to ${o.value}`}`;
}

function setPath(doc, path, change) {
  const copy = JSON.parse(JSON.stringify(doc));
  const keys = path.split('.');
  let at = copy;
  for (const k of keys.slice(0, -1)) { if (at[k] == null || typeof at[k] !== 'object') return null; at = at[k]; }
  const last = keys.at(-1);
  if (change.multiply != null) { if (typeof at[last] !== 'number') return null; at[last] = Math.round(at[last] * change.multiply * 1000) / 1000; } else at[last] = change.value;
  return copy;
}

/**
 * The store as one ablated Run's agent sees it. now() and steps() are read at
 * the time of each request, so delays lift as the agent works.
 */
export function createLens(store, run, { steps, now }) {
  const overlays = run.overlays || [];
  const stats = { hidden: 0, delayed: 0, changed: 0 };
  async function see(resources) {
    const elapsed = (Date.parse(now()) - Date.parse(run.startedAt)) / 1000;
    let taken = null;
    const out = [];
    for (const original of resources) {
      let r = original; let gone = false;
      for (const o of overlays) {
        if (o.type === 'hide' && o.what === 'images') {
          if (r.resourceType === 'ImagingStudy' && (r.series?.length || r.numberOfInstances)) { const { series, ...rest } = r; r = { ...rest, numberOfSeries: 0, numberOfInstances: 0 }; stats.changed += 1; }
        } else if (o.type === 'hide') { if (selected(o, r, run)) { gone = true; stats.hidden += 1; break; } }
        else if (o.type === 'delay') {
          if (!selected(o, r, run)) continue;
          if (o.afterSteps != null && taken == null) taken = await steps();
          if (o.afterSteps != null ? taken < o.afterSteps : elapsed < o.afterSeconds) { gone = true; stats.delayed += 1; break; }
        } else if (r.resourceType === o.resourceType && CODES(r).includes(o.code)) {
          const changed = setPath(r, o.path, o);
          if (changed) { r = changed; stats.changed += 1; }
        }
      }
      if (!gone) out.push(r);
    }
    return out;
  }
  return {
    stats,
    async get(type, id, opts) { const doc = await store.get(type, id, opts); return doc ? (await see([doc]))[0] ?? null : null; },
    async query(type, filters, opts) { return see(await store.query(type, filters, opts)); },
    async history(type, id, opts) { return see(await store.history(type, id, opts)); },
    async everything(patientRef, opts) { return see(await store.everything(patientRef, opts)); },
  };
}

/** Attaches a lens to an agent request when its Run has overlays. */
export function lensFor(store, ctx) {
  if (!ctx.run?.overlays?.length) return null;
  // Agents in an ablated run, and people in a masked session (a sandbox run with no agent): the same hidden chart.
  if (ctx.actor.kind !== 'agent' && !(ctx.run.mode === 'sandbox' && !ctx.run.agentId && !ctx.run.endedAt)) return null;
  return createLens(store, ctx.run, {
    now: () => store.now(),
    steps: async () => (await store.query('TraceStep', { groupKey: ctx.run.id })).filter((s) => s.who.kind === 'agent' && s.source !== 'ui').length,
  });
}

// ---------- Ablation studies and the report ----------
const noticed = (run) => (run.result?.flags || []).filter((f) => NOTICE_FLAGS.includes(f.code));

export function createAblation({ store, agents, rl }) {
  const answerOf = async (run) => {
    if (run.caseId && run.result?.episodeId) {
      const e = await store.get('Episode', run.result.episodeId);
      const score = e ? verifierScore(e.outcome.raw.checks).score : null;
      return { kind: 'score', value: score, text: score == null ? 'not scored' : `${Math.round(score * 100)}% of the case's checks` };
    }
    const label = run.result?.declined ? 'declined' : run.result?.label ?? null;
    return { kind: 'label', value: label, text: label ?? (run.result?.error ? 'did not finish' : 'no answer') };
  };

  async function oneRun({ agent, evalCase, subject, overlays, actor, group, baseline }) {
    if (evalCase) {
      const out = await rl.rollouts({ agentId: agent.id, caseId: evalCase.id, attempts: 1, seed: 0, overlays, ablation: { group, baseline } }, actor);
      return store.get('Run', out.episodes[0].runId);
    }
    const run = await createRun(store, { mode: 'sandbox', agentId: agent.id, subject, goal: 'Do the usual task for this item', overlays, trigger: { kind: 'ablation', actor: actor.id, role: actor.role, at: store.now(), group, baseline } }, actor);
    const outcome = await agents.work(run, agent);
    return endRun(store, run.id, agents.agentActor(agent), outcome.ok ? 'completed' : outcome.reason, outcome.result ?? { error: outcome.error });
  }

  /** Runs the task once without overlays (unless that baseline already exists) and once with them. */
  async function study({ agentId, caseId = null, subject = null, overlays }, actor) {
    if (!agents.ready) throw new HttpError(409, 'The server is not ready to run agents yet');
    const agent = await store.get('Agent', String(agentId ?? ''));
    if (!agent) throw new HttpError(404, `Agent "${agentId}" is not registered`);
    if (!agents.canRun(agent)) throw new HttpError(409, 'External agent endpoints are disabled. Set ALLOW_EXTERNAL_AGENTS=true to let this server call them');
    const clean = validateOverlays(overlays);
    if (!clean.length) throw new HttpError(422, 'Choose at least one thing to hide, delay or change');
    let evalCase = null;
    if (caseId) { evalCase = await store.get('EvalCase', String(caseId)); if (!evalCase) throw new HttpError(404, `Case "${caseId}" is not in the case bank`); }
    else {
      const [type, id] = String(subject || '').split('/');
      if (!type || !id || !(await store.get(type, id).catch(() => null))) throw new HttpError(422, `Subject "${subject}" was not found`);
    }
    const target = evalCase ? `EvalCase/${evalCase.id}` : subject;
    const sameTarget = (r) => r.agentId === agent.id && r.version === agent.version && r.endedAt && r.trigger?.group === target;
    let baseline = (await store.query('Run', { where: (r) => sameTarget(r) && r.trigger?.baseline === true })).sort((a, b) => b._seq - a._seq)[0] ?? null;
    if (!baseline) baseline = await oneRun({ agent, evalCase, subject, overlays: [], actor, group: target, baseline: true });
    const ablated = await oneRun({ agent, evalCase, subject, overlays: clean, actor, group: target, baseline: false });
    await store.transaction((tx) => recordAction(tx, { actor, kind: 'execute', action: 'ablation.run', args: { agent: agent.id, target, overlays: clean.length, baseline: baseline.id, ablated: ablated.id }, description: `ablation run for ${agent.id} on ${target}` }));
    return { row: await rowFor(ablated, baseline), baselineRunId: baseline.id, runId: ablated.id };
  }

  async function rowFor(run, baseline) {
    const steps = (await store.query('TraceStep', { groupKey: run.id })).filter((s) => s.who.kind === 'agent');
    const touched = steps.reduce((n, s) => { const a = s.did.args?.ablated; return a ? { hidden: n.hidden + a.hidden, delayed: n.delayed + a.delayed, changed: n.changed + a.changed } : n; }, { hidden: 0, delayed: 0, changed: 0 });
    const applied = touched.hidden + touched.delayed + touched.changed > 0;
    const base = baseline ? await answerOf(baseline) : null;
    const mine = await answerOf(run);
    const right = base ? (mine.kind === 'score' ? mine.value != null && base.value != null && mine.value >= base.value : mine.value === base.value) : null;
    const flags = noticed(run);
    const didNotice = flags.length > 0;
    const confidence = run.result?.confidence ?? null; const baseConfidence = baseline?.result?.confidence ?? null;
    const verdict = !base ? 'no-comparison' : !applied ? 'not-applied' : right && !didNotice ? 'unaffected' : right && didNotice ? 'noticed-and-right' : didNotice ? 'noticed' : 'confidently-wrong';
    const evalCase = run.caseId ? await store.get('EvalCase', run.caseId) : null;
    return {
      runId: run.id, baselineRunId: baseline?.id ?? null, agentId: run.agentId, version: run.version, startedAt: run.startedAt, status: withStatus(run).status,
      target: evalCase ? evalCase.title : run.subject, targetRef: run.trigger?.group ?? run.subject, overlays: run.overlays, overlayText: run.overlays.map(describeOverlay), applied: touched,
      baseline: base ? { answer: base.text, confidence: baseConfidence } : null, ablated: { answer: mine.text, confidence, flags: (run.result?.flags || []).map((f) => ({ code: f.code, detail: f.detail ?? null })), summary: run.result?.summary ?? run.result?.error ?? null },
      rightAnswer: right, noticed: didNotice, verdict,
    };
  }

  async function report({ agentId = null } = {}) {
    const runs = await store.query('Run', { where: (r) => (r.overlays || []).length > 0 && r.agentId && r.endedAt && (!agentId || r.agentId === agentId) });
    const all = await store.query('Run', { where: (r) => r.trigger?.baseline === true && r.endedAt });
    const rows = [];
    for (const run of runs.sort((a, b) => b._seq - a._seq)) {
      const base = all.filter((b) => b.agentId === run.agentId && b.version === run.version && b.trigger?.group === (run.trigger?.group ?? null)).sort((a, b) => b._seq - a._seq)[0] ?? null;
      rows.push(await rowFor(run, base));
    }
    const count = (v) => rows.filter((r) => r.verdict === v).length;
    const byOverlay = new Map();
    for (const r of rows) for (const text of r.overlayText) {
      if (!byOverlay.has(text)) byOverlay.set(text, { overlay: text, runs: 0, right: 0, noticed: 0, confidentlyWrong: 0, notApplied: 0 });
      const g = byOverlay.get(text);
      g.runs += 1; if (r.rightAnswer) g.right += 1; if (r.noticed) g.noticed += 1; if (r.verdict === 'confidently-wrong') g.confidentlyWrong += 1; if (r.verdict === 'not-applied') g.notApplied += 1;
    }
    return {
      generatedAt: store.now(), note: '"Right answer" means the same answer as the same agent version gave with nothing hidden or changed. It does not mean clinically correct.',
      summary: { runs: rows.length, unaffected: count('unaffected'), noticedAndRight: count('noticed-and-right'), noticed: count('noticed'), confidentlyWrong: count('confidently-wrong'), notApplied: count('not-applied'), noComparison: count('no-comparison') },
      byOverlay: [...byOverlay.values()].sort((a, b) => a.overlay.localeCompare(b.overlay)), rows, options: { hide: HIDEABLE, noticeFlags: NOTICE_FLAGS },
    };
  }

  async function handle(req, url, body, ctx, parts) {
    if (parts[0] !== 'ablation') return null;
    if (parts.length === 1 && req.method === 'GET') return { status: 200, body: await report({ agentId: url.searchParams.get('agentId') }) };
    if (parts.length === 2 && parts[1] === 'run' && req.method === 'POST') {
      if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only people can start ablation runs');
      return { status: 201, body: await study(body || {}, ctx.actor) };
    }
    // A masked session for a person: the same hidden chart an ablated agent sees, on a practice copy, as a human baseline.
    if (parts.length === 2 && parts[1] === 'mask' && req.method === 'POST') {
      if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only people start masked sessions');
      const overlays = validateOverlays(body?.overlays); if (!overlays.length) throw new HttpError(422, 'Choose at least one thing to hide');
      const patient = String(body?.patient || ''); if (!/^Patient\/[A-Za-z0-9\-.]{1,64}$/.test(patient)) throw new HttpError(422, 'patient must look like Patient/<id>');
      const run = await createRun(store, { mode: 'sandbox', overlays, subject: patient, goal: 'Masked chart for a person (human baseline)' }, ctx.actor);
      return { status: 201, body: { runId: run.id, branch: run.branch, overlays: overlays.map(describeOverlay) } };
    }
    return null;
  }
  return { handle, study, report };
}
