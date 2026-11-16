// Citation check. For agents set to cite, every claim in their output
// must cite a record. Each cited record is checked: it exists, it belongs to the right patient, it
// was visible at that moment, and it supports the claim (exact value and code where the claim gives them).
// The result is reported per run, and can be used as a reward component and as a red-team check.
const codesOf = (r) => [...(r.code?.coding || []), ...(r.medicationCodeableConcept?.coding || []), ...(r.type?.coding || []), ...(r.vaccineCode?.coding || [])].map((c) => String(c.code));
const textsOf = (r) => [r.code?.text, r.medicationCodeableConcept?.text, r.type?.text, r.description, r.valueString, r.conclusion, ...(r.note || []).map((n) => n.text), ...[...(r.code?.coding || []), ...(r.medicationCodeableConcept?.coding || [])].map((c) => c.display), r.resourceType === 'DocumentReference' ? Buffer.from(r.content?.[0]?.attachment?.data || '', 'base64').toString('utf8') : null, r.policyText, r.criteriaText].filter(Boolean).join(' ').toLowerCase();
const patientOf = (r) => r._patient || r.subject?.reference || r.patient?.reference || (r.resourceType === 'Patient' ? `Patient/${r.id}` : null);
const STOP = new Set(['the', 'and', 'for', 'with', 'was', 'were', 'has', 'have', 'had', 'this', 'that', 'from', 'patient', 'is', 'are', 'of', 'on', 'in', 'to', 'a', 'an', 'at', 'by', 'not', 'no', 'mg', 'ml']);
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));

/** Whether one record supports one claim: { ok, why }. A value and a code on the claim must match exactly; otherwise the claim must share a meaningful word or number with the record. */
export function supports(record, claim) {
  if (claim.code != null && !codesOf(record).includes(String(claim.code))) return { ok: false, why: `the record does not carry code ${claim.code}` };
  if (claim.value != null) {
    const v = record.valueQuantity?.value ?? record.valueInteger ?? (record.valueString != null && !Number.isNaN(Number(record.valueString)) ? Number(record.valueString) : null);
    if (v == null) return { ok: false, why: 'the record has no value to compare' };
    if (Math.abs(Number(v) - Number(claim.value)) > 1e-6) return { ok: false, why: `the record's value is ${v}, not ${claim.value}` };
    if (claim.unit && record.valueQuantity?.unit && String(claim.unit).toLowerCase() !== String(record.valueQuantity.unit).toLowerCase()) return { ok: false, why: `the record's unit is ${record.valueQuantity.unit}, not ${claim.unit}` };
    return { ok: true, why: 'value matches' };
  }
  if (claim.code != null) return { ok: true, why: 'code matches' };
  const hay = textsOf(record); const numbers = [record.valueQuantity?.value, record.valueInteger].filter((x) => x != null).map(String);
  const shared = words(claim.text).filter((w) => hay.includes(w) || numbers.includes(w));
  return shared.length ? { ok: true, why: `shares "${shared.slice(0, 3).join('", "')}" with the record` } : { ok: false, why: 'nothing in the record matches what the claim says' };
}

/**
 * claims: [{ text, cites: ['Type/id', ...], value?, unit?, code?, at? }]
 * read(ref) returns the record as the run could see it, or null. patientRef is the run's patient ('Patient/id').
 * at is the moment the output was produced (ISO): a record made later was not visible.
 */
export async function checkCitations(claims, { read, patientRef = null, at = null, shared = [] } = {}) {
  const list = Array.isArray(claims) ? claims : []; const problems = []; let valid = 0; let cited = 0;
  for (const [i, claim] of list.entries()) {
    const cites = Array.isArray(claim?.cites) ? claim.cites.map(String) : [];
    if (!cites.length) { problems.push({ claim: i, cite: null, problem: 'uncited', detail: 'the claim cites no record' }); continue; }
    cited += 1; let ok = true; let anySupport = false;
    for (const ref of cites) {
      const record = /^[A-Za-z]+\/[\w.-]+$/.test(ref) ? await read(ref) : null;
      if (!record) { problems.push({ claim: i, cite: ref, problem: 'does-not-exist', detail: 'no such record can be read by this run' }); ok = false; continue; }
      const owner = patientOf(record);
      if (patientRef && owner && owner !== patientRef && !shared.includes(record.resourceType)) { problems.push({ claim: i, cite: ref, problem: 'wrong-patient', detail: `the record belongs to ${owner}` }); ok = false; continue; }
      const made = record._recordedAt || record.meta?.lastUpdated || null; const when = claim.at || at;
      if (when && made && made > when) { problems.push({ claim: i, cite: ref, problem: 'not-visible-yet', detail: `the record was made at ${made}, after the claim` }); ok = false; continue; }
      const s = supports(record, claim);
      if (s.ok) anySupport = true; else problems.push({ claim: i, cite: ref, problem: 'does-not-support', detail: s.why, soft: true });
    }
    // Every cited record must be real, the right patient's and visible; at least one must support the claim.
    if (ok && !anySupport) ok = false;
    if (ok) { valid += 1; for (let k = problems.length - 1; k >= 0; k -= 1) if (problems[k].claim === i && problems[k].soft) problems.splice(k, 1); }
  }
  const out = { claims: list.length, cited, valid, uncited: list.length - cited, score: list.length ? Math.round((valid / list.length) * 1000) / 1000 : null, passed: list.length > 0 && valid === list.length, problems: problems.map(({ soft, ...p }) => p) };
  return out;
}
