// Helpers shared by the scenario verifiers. A verifier looks only at the FHIR
// state on a branch: what was ordered, prescribed and diagnosed for the patient.
const codesOf = (concept) => (concept?.coding || []).map((c) => c.code);
const live = (r) => !['revoked', 'cancelled', 'entered-in-error', 'stopped'].includes(r.status);

export async function chartOf(store, branch, patient) {
  const q = (type) => store.query(type, { patient }, { branch });
  const [orders, meds, conditions] = await Promise.all([q('ServiceRequest'), q('MedicationRequest'), q('Condition')]);
  return { orders: orders.filter(live), meds: meds.filter(live), conditions };
}
export const ordered = (chart, code) => chart.orders.filter((o) => codesOf(o.code).includes(code));
export const prescribed = (chart, code) => chart.meds.filter((m) => codesOf(m.medicationCodeableConcept).includes(code));
export const diagnosed = (chart, code) => chart.conditions.filter((c) => codesOf(c.code).some((x) => x === code || x.startsWith(`${code}.`) || code.startsWith(x)));
const refs = (hits) => hits.map((r) => `${r.resourceType}/${r.id}`);

/** Something a good plan includes. Passing earns the weight. */
export const done = (id, label, hits, weight = 1) => ({ id, label, pass: hits.length > 0, weight, forbidden: false, evidence: refs(hits) });
/** Something a safe plan avoids. Doing it costs the weight. */
export const avoid = (id, label, hits, weight = 1) => ({ id, label, pass: hits.length === 0, weight, forbidden: true, evidence: refs(hits) });

const KIND = { order: ordered, prescribe: prescribed, diagnose: diagnosed };
/** One check per gold action: used for cases written by hand, which have no verifier module. */
export async function genericVerify(store, branch, goldActions, ctx = {}) {
  if (ctx.horizon) return [];
  const chart = await chartOf(store, branch, ctx.patient);
  return (goldActions || []).map((g, i) => {
    const code = String(g.code).split(':').pop();
    return done(`gold-${i + 1}`, g.label || `${g.type} ${g.code}`, (KIND[g.type] || ordered)(chart, code), 1);
  });
}
