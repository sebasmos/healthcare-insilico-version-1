// Consent enforcement for every read and disclosure path (docs/STANDARDS.md). An active Consent whose provision
// is "deny" stops the patient's data leaving through FHIR R4/R5 reads and searches, SMART apps, agent and
// research access, CDS Hooks prefetch, Bulk export, HL7 v2 and C-CDA outbound and document sharing.
// provision.purpose (v3 PurposeOfUse) narrows it to those purposes; with no purpose it covers every purpose
// except direct treatment (TREAT) by hospital staff (another organisation's TREAT, as over UDAP B2B, is covered). provision.actor (role code or a reference) narrows it to
// those actors. The patient always sees their own record. Staff can break the glass for TREAT with
// X-Break-Glass: <reason>; that read is still logged.
const CARE_ROLES = new Set(['clinician', 'doctor', 'physician', 'nurse', 'pharmacist', 'radiologist', 'pathologist', 'lab', 'interface', 'admin']);
const PURPOSE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-ActReason';
export const idOfPatient = (ref) => String(ref || '').replace(/^Patient\//, '');
export const patientOf = (r, type) => r?._patient ? idOfPatient(r._patient) : (type || r?.resourceType) === 'Patient' ? r.id : idOfPatient(r?.subject?.reference || r?.patient?.reference || r?.beneficiary?.reference);

/** The purpose of use for this request: TREAT for staff in the UI, HRESCH for agents and research, HOPERAT for apps and system jobs. */
export function purposeOf(ctx = {}) {
  if (ctx.purpose) return ctx.purpose;
  if (ctx.smart?.purpose) return ctx.smart.purpose;
  const a = ctx.actor || {};
  if (a.role === 'patient') return 'PATRQT';
  if (ctx.smart) return ctx.smart.system ? 'HOPERAT' : CARE_ROLES.has(a.role) ? 'TREAT' : 'HOPERAT';
  if (a.kind === 'agent' || a.role === 'researcher' || (ctx.branch && ctx.branch !== 'main')) return 'HRESCH';
  return CARE_ROLES.has(a.role) ? 'TREAT' : 'HOPERAT';
}

const covers = (c, ctx, purpose) => {
  const p = c.provision || {};
  if (c.status !== 'active' || p.type !== 'deny') return false;
  const now = Date.now();
  if (p.period?.start && Date.parse(p.period.start) > now) return false;
  if (p.period?.end && Date.parse(p.period.end) < now) return false;
  if (purpose === 'PATRQT') return false;
  const purposes = (p.purpose || []).map((x) => x.code);
  if (purposes.length ? !purposes.includes(purpose) : purpose === 'TREAT' && !ctx.smart?.organization) return false;
  const actors = p.actor || [];
  if (actors.length && !actors.some((x) => (x.role?.coding || []).some((k) => k.code === ctx.actor?.role) || x.reference?.reference === `${ctx.actor?.kind === 'agent' ? 'Device' : 'Practitioner'}/${ctx.actor?.id}`)) return false;
  return true;
};

/** Returns a checker bound to one store: blocked(patientId, ctx, purpose?) -> the denying Consent or null. */
export function createConsent(store) {
  async function denials() { return (await store.query('Consent', {}, { branch: 'main' })).filter((c) => c.status === 'active' && c.provision?.type === 'deny'); }
  async function blocked(patientId, ctx = {}, purpose = purposeOf(ctx)) {
    if (!patientId) return null;
    if (ctx.actor?.role === 'patient' && idOfPatient(ctx.actor.patientId || ctx.patientId) === patientId) return null;
    if (purpose === 'TREAT' && ctx.breakGlass) return null;
    return (await denials()).find((c) => idOfPatient(c.patient?.reference) === patientId && covers(c, ctx, purpose)) || null;
  }
  /** The set of patients a disclosure for this purpose must leave out. */
  async function deniedSet(ctx = {}, purpose = purposeOf(ctx)) { const s = new Set(); for (const c of await denials()) if (covers(c, ctx, purpose)) s.add(idOfPatient(c.patient?.reference)); return s; }
  async function filter(rows, ctx, purpose = purposeOf(ctx)) { const d = await deniedSet(ctx, purpose); if (!d.size) return rows; const self = ctx.actor?.role === 'patient' ? idOfPatient(ctx.actor.patientId) : null; return rows.filter((r) => { const p = patientOf(r); return !p || p === self || !d.has(p) || (purpose === 'TREAT' && ctx.breakGlass); }); }
  return { blocked, deniedSet, filter, purposeOf };
}
export { PURPOSE_SYSTEM };
