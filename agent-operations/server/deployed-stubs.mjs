// Reference agents for the deployed baseline (plan-master 8.7): the Chart
// Summariser, and the "ask" behaviours the other stubs use when the
// agent-may-ask capability is on. Rule-based and offline, like every stub.
import { hasCap } from './capabilities.mjs';

export const SUMMARY_TYPE = { system: 'urn:hospital-desktop:doc-type', code: 'ai-summary', display: 'AI chart summary' };
export const CHECK_MARK = '[Check this]';
const text = (c) => c?.text || c?.coding?.[0]?.display || c?.coding?.[0]?.code || '';
const when = (r) => String(r.effectiveDateTime || r.issued || r.period?.start || r.recordedDate || r.authoredOn || '').slice(0, 10);

/** Orders the Ambient Scribe queues when the plan names them (queue-orders). LOINC codes from the catalogue. */
export const ORDER_CUES = [
  ['creatinine', '2160-0', 'Creatinine', 'laboratory'], ['potassium', '2823-3', 'Potassium', 'laboratory'], ['glucose', '2345-7', 'Glucose', 'laboratory'], ['troponin', '10839-9', 'Troponin', 'laboratory'],
  ['full blood count', '58410-2', 'Full blood count', 'laboratory'], ['blood count', '58410-2', 'Full blood count', 'laboratory'], ['chest x-ray', '36643-5', 'Chest X-ray', 'imaging'], ['chest xray', '36643-5', 'Chest X-ray', 'imaging'], ['ecg', '11524-6', 'ECG', 'procedure'],
];
export function queuedOrdersFrom(planText) {
  const plan = String(planText || '').toLowerCase();
  if (!/order|check|send for|repeat|arrange|request|get a|get an/.test(plan)) return [];
  const out = []; const seen = new Set();
  for (const [cue, code, label, category] of ORDER_CUES) if (plan.includes(cue) && !seen.has(code)) { seen.add(code); out.push({ cue, code, label, category }); }
  return out;
}

/** Symptoms the triage rules have no entry for: with agent-may-ask the triager asks one question about them. */
export const UNRULED_SYMPTOMS = ['dizzy', 'dizziness', 'rash', 'numbness', 'palpitation', 'swelling', 'headache', 'fainted', 'blurred vision'];

/**
 * Asks when the run allows it; otherwise returns null so the caller falls
 * back to the deployed behaviour (draft and hand back). A time-out or an
 * ended run throws, and the caller must let that stop the turn.
 */
export async function maybeAsk(run, tools, request) {
  if (!hasCap(run, 'agent-may-ask') || typeof tools.ask !== 'function') return null;
  return tools.ask(request);
}

/** Chart Summariser: a read-only summary card that cites every record it used. Nothing to approve. */
export async function chartSummariser({ task, tools }) {
  const [type, id] = String(task.subject || '').split('/');
  if (type !== 'Patient' || !id) throw Object.assign(new Error('Chart Summariser needs a Patient as its subject'), { stopReason: 'failed' });
  const patient = await tools.read('Patient', id, 'Open the chart I was asked to summarise');
  const cites = [`Patient/${id}`];
  const [conditions, meds, allergies, observations, encounters, reports] = await Promise.all([
    tools.search('Condition', { patient: id }, 'Read the problem list for the summary'),
    tools.search('MedicationRequest', { patient: id, status: 'active' }, 'Read the active medications for the summary'),
    tools.search('AllergyIntolerance', { patient: id }, 'Read the allergies for the summary'),
    tools.search('Observation', { patient: id }, 'Read recent results and vitals for the summary'),
    tools.search('Encounter', { patient: id }, 'Read recent encounters for the summary'),
    tools.search('DiagnosticReport', { patient: id }, 'Read recent reports for the summary'),
  ]);
  const active = conditions.filter((c) => (c.clinicalStatus?.coding || []).every((x) => x.code !== 'inactive' && x.code !== 'resolved'));
  const recentObs = observations.sort((a, b) => when(b).localeCompare(when(a))).slice(0, 8);
  const recentEnc = encounters.sort((a, b) => when(b).localeCompare(when(a))).slice(0, 3);
  const recentRep = reports.filter((r) => ['final', 'amended', 'corrected', 'appended'].includes(r.status)).sort((a, b) => when(b).localeCompare(when(a))).slice(0, 3);
  for (const list of [active, meds, allergies, recentObs, recentEnc, recentRep]) for (const r of list) cites.push(`${r.resourceType}/${r.id}`);
  const name = [patient.name?.[0]?.given?.join(' '), patient.name?.[0]?.family].filter(Boolean).join(' ') || 'This patient';
  const lines = [
    `${name}${patient.birthDate ? `, born ${patient.birthDate}` : ''}${patient.gender ? `, ${patient.gender}` : ''}.`,
    `Problems: ${active.length ? active.map((c) => text(c.code)).join('; ') : 'none recorded'}.`,
    `Active medications: ${meds.length ? meds.map((m) => text(m.medicationCodeableConcept)).join('; ') : 'none recorded'}.`,
    `Allergies: ${allergies.length ? allergies.map((a) => text(a.code)).join('; ') : 'none recorded'}.`,
    `Recent results and vitals: ${recentObs.length ? recentObs.map((o) => `${text(o.code)} ${o.valueQuantity?.value ?? o.valueString ?? ''}${o.valueQuantity?.unit ? ` ${o.valueQuantity.unit}` : ''} (${when(o)})`).join('; ') : 'none'}.`,
    `Recent encounters: ${recentEnc.length ? recentEnc.map((e) => `${text(e.reasonCode?.[0]) || text(e.class) || 'visit'} (${when(e)})`).join('; ') : 'none'}.`,
    recentRep.length ? `Recent reports: ${recentRep.map((r) => `${text(r.code)}: ${String(r.conclusion || '').slice(0, 120)} (${when(r)})`).join('; ')}.` : null,
    'This summary lists what the chart holds. It is not clinical advice and may miss things.',
  ].filter(Boolean);
  const body = lines.join('\n');
  const draft = await tools.create({
    resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', type: { coding: [SUMMARY_TYPE], text: SUMMARY_TYPE.display },
    subject: { reference: `Patient/${id}` }, date: new Date().toISOString(), description: 'AI chart summary',
    content: [{ attachment: { contentType: 'text/plain', data: Buffer.from(body, 'utf8').toString('base64') } }],
    context: { related: cites.map((ref) => ({ reference: ref })) },
  }, `I summarised ${cites.length} records from the chart: problems, medications, allergies, recent results, encounters and reports.`);
  return { output: `DocumentReference/${draft.id}`, label: 'summary', cites, flags: [], confidence: 0.6, summary: `Summarised ${cites.length} records` };
}
