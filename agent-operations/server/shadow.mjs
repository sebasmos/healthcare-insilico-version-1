// Shadow evaluation (§9c): compare what an agent did on its hidden shadow
// branch with what the clinician did on main, at three levels: outcome,
// path and cost. The outcome classes below are rule-based proxies for
// agreement. They are not a measure of clinical correctness or safety.
import { LIVE_RUN_ID } from '../../platform/server/audit.mjs';

const SIGNED = ['final', 'amended', 'corrected', 'appended'];
const ADDENDUM_URL = 'urn:hospital-desktop:addendum-of';
const ABNORMAL_CUES = ['abnormal', 'nodule', 'mass', 'fracture', 'pneumonia', 'effusion', 'pneumothorax', 'opacity', 'opacities', 'consolidation', 'lesion', 'cardiomegaly', 'edema', 'oedema', 'atelectasis', 'infiltrate', 'haemorrhage', 'hemorrhage', 'dislocation', 'obstruction'];
const NEGATIONS = ['no ', 'not ', 'without ', 'negative for ', 'resolved', 'free of ', 'rule out ', 'ruled out '];

/** 'normal' | 'abnormal' | 'unknown' from impression text. A cue counts unless its sentence negates it before the cue. */
export function classifyImpression(impression) {
  const body = String(impression || '').toLowerCase().trim();
  if (!body) return 'unknown';
  for (const sentence of body.split(/[.;\n]+/)) {
    for (const cue of ABNORMAL_CUES) {
      const at = sentence.indexOf(cue);
      if (at === -1) continue;
      const before = sentence.slice(0, at);
      if (!NEGATIONS.some((n) => before.includes(n))) return 'abnormal';
    }
  }
  return 'normal';
}

export const triageLabelOf = (task) => (task?.output || []).find((o) => o.type?.text === 'triage-label')?.valueString ?? null;
const isTriage = (t) => (t.code?.coding || []).some((c) => c.code === 'message-triage');
const seconds = (from, to) => (from && to ? Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 100) / 10) : null);

// One plain-English token per step, so two paths can be compared.
function token(step) {
  const { type, args = {} } = step.did;
  const kind = args.type || (args.study ? 'ImagingStudy' : '');
  if (type === 'image.open' || type === 'fhir.read' || type === 'chart.open') return `read ${kind}`;
  if (type === 'fhir.search' || type === 'fhir.history') return `search ${kind}`;
  if (type === 'fhir.create') return `write ${kind}`;
  if (type === 'fhir.update') return `write ${kind}`;
  if (type === 'fhir.transition') return SIGNED.includes(args.to) ? `sign ${kind}` : `change status of ${kind}`;
  return null;
}
const LABELS = {
  read: (k) => `Read ${plain(k)}`, search: (k) => `Looked up ${plain(k)}`, write: (k) => `Wrote ${plain(k)}`,
  sign: (k) => `Signed ${plain(k)}`, change: (k) => `Changed status of ${plain(k)}`,
};
const PLAIN = { ImagingStudy: 'the imaging study', DiagnosticReport: 'the report', Patient: 'the patient chart', ServiceRequest: 'the order', Communication: 'the message', Task: 'the triage decision', MedicationRequest: 'the medication list', AllergyIntolerance: 'the allergy list' };
function plain(kind) { return PLAIN[kind] || kind || 'a record'; }
function label(tok) {
  if (!tok) return null;
  const [verb, ...rest] = tok.split(' ');
  const kind = rest[rest.length - 1];
  return (LABELS[verb] || ((k) => `${verb} ${k}`))(kind);
}

export function path(steps) {
  const out = [];
  for (const step of steps) {
    const tok = token(step);
    if (!tok) continue;
    if (out.length && out[out.length - 1].token === tok) continue;
    out.push({ token: tok, label: label(tok), why: step.why ?? null, at: step.when.wall, stepId: step.id });
  }
  return out;
}

function lcs(a, b) {
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const keep = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(row[j], row[j - 1]);
      prev = keep;
    }
  }
  return row[b.length];
}

/** Similarity in [0,1] and the first step at which the two paths differ. */
export function comparePaths(agentPath, humanPath) {
  const a = agentPath.map((p) => p.token);
  const b = humanPath.map((p) => p.token);
  const similarity = a.length + b.length ? Math.round((2 * lcs(a, b) / (a.length + b.length)) * 100) / 100 : 1;
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  const split = index === a.length && index === b.length ? null : {
    step: index + 1, agentStepId: agentPath[index]?.stepId ?? null, humanStepId: humanPath[index]?.stepId ?? null,
    agent: agentPath[index] ? { did: agentPath[index].label, why: agentPath[index].why } : { did: 'Stopped here', why: null },
    human: humanPath[index] ? { did: humanPath[index].label, why: humanPath[index].why } : { did: 'Stopped here', why: null },
  };
  return { similarity, split };
}

const isWrite = (p) => p.token.startsWith('write') || p.token.startsWith('sign');

async function compareRun(store, run, liveSteps) {
  const [type, id] = String(run.subject || '').split('/');
  const steps = (await store.query('TraceStep', { groupKey: run.id })).filter((s) => s.who.kind === 'agent');
  const agentPath = path(steps);
  const rejected = steps.filter((s) => s.did.type === 'envelope.reject').length;
  const base = {
    runId: run.id, mode: run.mode, subject: run.subject, startedAt: run.startedAt, endedAt: run.endedAt, endReason: run.endReason ?? null,
    branch: run.branch, agentLabel: run.result?.label ?? null, agentConfidence: run.result?.confidence ?? null, rejected,
  };
  let agentOutcome = null; let humanOutcome = null; let humanStart = null; let humanEnd = null; let humanSteps = []; let agentRef = null; let humanRef = null;

  if (type === 'ImagingStudy') {
    const ref = `ImagingStudy/${id}`;
    const mine = (r) => (r.imagingStudy || []).some((s) => s.reference === ref) && !(r.extension || []).some((e) => e.url === ADDENDUM_URL);
    const draft = (await store.query('DiagnosticReport', { where: (r) => mine(r) && r._shadow }, { branch: run.branch }))[0];
    const signed = (await store.query('DiagnosticReport', { where: (r) => mine(r) && SIGNED.includes(r.status) }))[0];
    if (draft) { agentOutcome = classifyImpression(draft.conclusion); agentRef = `DiagnosticReport/${draft.id}`; }
    if (signed) {
      humanOutcome = classifyImpression(signed.conclusion);
      humanRef = `DiagnosticReport/${signed.id}`;
      const versions = await store.history('DiagnosticReport', signed.id);
      humanEnd = versions.find((v) => SIGNED.includes(v.status))?._recordedAt ?? signed._recordedAt;
      humanStart = run.trigger?.at ?? run.startedAt;
      // The clinician's path runs from opening the study to the step that signed the report.
      const related = liveSteps.filter((s) => s.when.wall >= humanStart
        && (s.did.args?.study === id || (s.did.args?.type === 'DiagnosticReport' && s.did.args?.id === signed.id)));
      const signedAt = related.findIndex((s) => s.did.type === 'fhir.transition' && SIGNED.includes(s.did.args?.to));
      humanSteps = signedAt === -1 ? related.filter((s) => s.when.wall <= humanEnd) : related.slice(0, signedAt + 1);
    }
  } else if (type === 'Communication') {
    const ref = `Communication/${id}`;
    const mine = (t) => isTriage(t) && t.focus?.reference === ref;
    const proposal = (await store.query('Task', { where: (t) => mine(t) && t._shadow }, { branch: run.branch }))[0];
    const decision = (await store.query('Task', { where: (t) => mine(t) && t.intent !== 'proposal' })).sort((a, b) => String(b._recordedAt).localeCompare(String(a._recordedAt)))[0];
    const message = await store.get('Communication', id);
    if (proposal) { agentOutcome = triageLabelOf(proposal); agentRef = `Task/${proposal.id}`; }
    if (decision) {
      humanOutcome = triageLabelOf(decision);
      humanRef = `Task/${decision.id}`;
      const versions = await store.history('Task', decision.id);
      humanStart = message?._recordedAt ?? run.startedAt;
      humanEnd = versions[0]?._recordedAt ?? decision._recordedAt;
      humanSteps = liveSteps.filter((s) => s.did.args?.type === 'Task' && s.did.args?.id === decision.id && s.did.type === 'fhir.create');
      humanSteps = [{ id: `open-${id}`, did: { type: 'fhir.read', args: { type: 'Communication' } }, why: null, when: { wall: humanStart } }, ...humanSteps];
    }
  }

  const status = !agentOutcome ? (run.result?.declined ? 'agent-declined' : 'agent-failed') : !humanOutcome ? 'awaiting-clinician' : 'compared';
  const humanPath = path(humanSteps);
  const agentSeconds = seconds(run.startedAt, run.endedAt);
  const humanSeconds = seconds(humanStart, humanEnd);
  const out = { ...base, status, agentRef, humanRef, outcome: { agent: agentOutcome, human: humanOutcome, agree: status === 'compared' ? agentOutcome === humanOutcome : null } };
  out.cost = {
    agentSteps: agentPath.length, agentWrites: agentPath.filter(isWrite).length, agentSeconds,
    humanSteps: status === 'compared' ? humanPath.length : null, humanWrites: status === 'compared' ? humanPath.filter(isWrite).length : null, humanSeconds,
    timeDeltaSeconds: agentSeconds != null && humanSeconds != null ? Math.round((agentSeconds - humanSeconds) * 10) / 10 : null,
  };
  out.path = status === 'compared' ? { ...comparePaths(agentPath, humanPath), agent: agentPath.map((p) => p.label), human: humanPath.map((p) => p.label), humanSteps: humanPath.map((p) => ({ label: p.label, why: p.why, at: p.at })) }
    : { similarity: null, split: null, agent: agentPath.map((p) => p.label), human: [] };
  return out;
}

const mean = (values) => { const v = values.filter((x) => x != null); return v.length ? Math.round((v.reduce((n, x) => n + x, 0) / v.length) * 100) / 100 : null; };

export async function shadowReport(store, { agentId = null, version = null, study = null } = {}) {
  // study: only this study's runs.
  const runs = await store.query('Run', { where: (r) => r.mode?.startsWith('shadow') && r.agentId && (!agentId || r.agentId === agentId) && (!version || r.version === version) && (!study || r.study === study) });
  const liveSteps = runs.length ? (await store.query('TraceStep', { groupKey: LIVE_RUN_ID })).filter((s) => s.source !== 'ui' && s.who.kind === 'human') : [];
  const agents = new Map((await store.query('Agent')).map((a) => [a.id, a]));
  const groups = new Map();
  for (const run of runs) {
    const key = `${run.agentId}@${run.version}`;
    if (!groups.has(key)) groups.set(key, { agentId: run.agentId, version: run.version, name: agents.get(run.agentId)?.name ?? run.agentId, policyHash: run.policyHash, current: agents.get(run.agentId)?.version === run.version, cases: [] });
    groups.get(key).cases.push(await compareRun(store, run, liveSteps));
  }
  const out = [...groups.values()].map((g) => {
    const compared = g.cases.filter((c) => c.status === 'compared');
    const agree = compared.filter((c) => c.outcome.agree).length;
    g.cases.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    return {
      ...g,
      summary: {
        runs: g.cases.length, compared: compared.length, awaitingClinician: g.cases.filter((c) => c.status === 'awaiting-clinician').length,
        agentFailed: g.cases.filter((c) => c.status === 'agent-failed').length, agree,
        agreementRate: compared.length ? Math.round((agree / compared.length) * 1000) / 1000 : null,
        meanAgentSeconds: mean(compared.map((c) => c.cost.agentSeconds)), meanHumanSeconds: mean(compared.map((c) => c.cost.humanSeconds)),
        meanTimeDeltaSeconds: mean(compared.map((c) => c.cost.timeDeltaSeconds)), meanPathSimilarity: mean(compared.map((c) => c.path.similarity)),
        meanStepDelta: mean(compared.map((c) => c.cost.agentSteps - c.cost.humanSteps)), pathDiverged: compared.filter((c) => c.path.split).length,
        envelopeRejections: g.cases.reduce((n, c) => n + c.rejected, 0),
      },
    };
  }).sort((a, b) => a.agentId.localeCompare(b.agentId) || String(b.version).localeCompare(String(a.version)));
  return { generatedAt: store.now(), note: 'Agreement is a rule-based proxy (impression class or triage label). It does not establish clinical correctness or safety.', agents: out };
}
