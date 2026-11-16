// Clinical Quality Language for the plan's questions (Da Vinci DTR pre-fill). A policy may carry an ELM library
// (CQL translated to ELM outside the platform); a criterion with evidence { kind: 'elm', expression: '<name>' }
// is answered by running that expression over exactly what would be sent, as FHIR. If there is no library, the
// engine cannot be loaded or the expression fails, the criterion's `fallback` evidence is checked by our own
// evaluator instead, and the answer says which one was used. Engine: cql-execution and cql-exec-fhir (Apache-2.0).
import { evaluate } from './policies.mjs';
import * as ref from './reference.mjs';

let engine;
async function load() { if (engine === undefined) { try { const cql = (await import('cql-execution')).default; const fhir = (await import('cql-exec-fhir')).default; engine = { cql, fhir }; } catch { engine = null; } } return engine; }

/** What would be sent, as a FHIR R4 Bundle for the engine: the patient by number, the diagnoses, results and notes. */
export function packetBundle(packet, patient = {}) {
  const pid = patient.id || 'p'; const subject = { reference: `Patient/${pid}` };
  return { resourceType: 'Bundle', type: 'collection', entry: [
    { resource: { resourceType: 'Patient', id: pid, gender: patient.gender || undefined, birthDate: patient.birthDate || undefined } },
    ...(packet.diagnoses || []).map((d, i) => ({ resource: { resourceType: 'Condition', id: `dx${i}`, subject, clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] }, code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: String(d).replace('.', '').toUpperCase() }] } } })),
    ...(packet.values || []).map((v, i) => ({ resource: { resourceType: 'Observation', id: v.id || `ob${i}`, status: 'final', subject, code: { coding: [{ system: 'http://loinc.org', code: String(v.code) }] }, effectiveDateTime: v.date || undefined, valueQuantity: { value: Number(v.value), unit: v.unit || undefined } } })),
    ...(packet.documents || []).map((d, i) => ({ resource: { resourceType: 'DocumentReference', id: d.id || `doc${i}`, status: 'current', subject, type: { text: d.title }, description: d.text } })),
  ] };
}
/** Runs the policy's ELM over the packet. Returns { <criterion id>: true | false | null }, or null when there is nothing to run. */
export async function runElm(policy, packet, patient) {
  const wants = (policy.criteria || []).filter((cr) => cr.evidence?.kind === 'elm' && cr.evidence.expression); if (!wants.length) return null;
  const elm = policy.elm || (policy.elmLibrary ? ref.document('elm', policy.elmLibrary)?.body : null); const e = elm ? await load() : null; if (!e) return null;
  try {
    const source = e.fhir.PatientSource.FHIRv401(); source.loadBundles([packetBundle(packet, patient)]);
    const out = await new e.cql.Executor(new e.cql.Library(elm), new e.cql.CodeService({})).exec(source); const r = Object.values(out.patientResults || {})[0] || {};
    return Object.fromEntries(wants.map((cr) => { const v = r[cr.evidence.expression]; return [cr.id, v === true ? true : v === false ? false : Array.isArray(v) ? v.length > 0 : null]; }));
  } catch (err) { return { __error: String(err.message || err).slice(0, 300) }; }
}
/** evaluate(), with ELM answers first and our own evaluator as the fallback. */
export async function evaluateWithElm(policy, packet, patient) {
  const elm = await runElm(policy, packet, patient); const failed = elm?.__error ?? null;
  const swapped = { ...policy, criteria: policy.criteria.map((cr) => (cr.evidence?.kind !== 'elm' ? cr : elm && !failed && elm[cr.id] != null ? cr : { ...cr, evidence: cr.evidence.fallback || { kind: 'judgement' }, _fellBack: true })) };
  const ev = evaluate(swapped, { ...packet, elm: failed ? null : elm });
  return { ...ev, criteria: ev.criteria.map((r, i) => (policy.criteria[i].evidence?.kind === 'elm' ? { ...r, by: swapped.criteria[i]._fellBack ? 'our own evaluator (fallback)' : 'CQL (ELM)' } : r)), engine: elm ? (failed ? `CQL failed, fallback used: ${failed}` : 'cql-execution') : (policy.criteria.some((c2) => c2.evidence?.kind === 'elm') ? 'no ELM library: fallback used' : 'our own evaluator') };
}
