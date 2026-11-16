// FHIR R5 alongside R4. The record is kept in R4; /fhir/R5 converts each resource on the way in and out. Where R5
// dropped or reshaped an R4 element, the R4 value travels in the standard cross-version extension
// (http://hl7.org/fhir/4.0/StructureDefinition/extension-<Type>.<element>) so that R4 -> R5 -> R4 gives back the same resource.
const X = (type, el) => `http://hl7.org/fhir/4.0/StructureDefinition/extension-${type}.${el}`;
const clone = (o) => JSON.parse(JSON.stringify(o));
const keep = (doc, type, el, value) => { if (value === undefined) return; doc.extension = [...(doc.extension || []), { url: X(type, el), valueString: JSON.stringify(value) }]; };
const take = (doc, type, el) => { const e = (doc.extension || []).find((x) => x.url === X(type, el)); if (!e) return undefined; doc.extension = doc.extension.filter((x) => x !== e); if (!doc.extension.length) delete doc.extension; return JSON.parse(e.valueString); };
const cr = (concept, reference) => (concept ? { concept } : reference ? { reference } : undefined);
const reasons = (codes = [], refs = []) => [...codes.map((c) => ({ concept: c })), ...refs.map((r) => ({ reference: r }))];
const ENC_STATUS = { planned: 'planned', arrived: 'in-progress', triaged: 'in-progress', 'in-progress': 'in-progress', onleave: 'on-hold', finished: 'completed', cancelled: 'cancelled', 'entered-in-error': 'entered-in-error', unknown: 'unknown' };
const SEC_R4 = 'http://terminology.hl7.org/CodeSystem/restful-security-service';
const SEC_R5 = 'http://hl7.org/fhir/restful-security-service';
const ENC_BACK = { planned: 'planned', 'in-progress': 'in-progress', 'on-hold': 'onleave', completed: 'finished', discharged: 'finished', cancelled: 'cancelled', discontinued: 'cancelled', 'entered-in-error': 'entered-in-error', unknown: 'unknown' };
const MS_STATUS = { active: 'recorded', completed: 'recorded', 'entered-in-error': 'entered-in-error', intended: 'draft', stopped: 'recorded', 'on-hold': 'recorded', unknown: 'recorded', 'not-taken': 'recorded' };
const medTo5 = (d, type) => { if (d.medicationCodeableConcept || d.medicationReference) { d.medication = cr(d.medicationCodeableConcept, d.medicationReference); delete d.medicationCodeableConcept; delete d.medicationReference; } };
const medTo4 = (d) => { if (d.medication) { if (d.medication.concept) d.medicationCodeableConcept = d.medication.concept; if (d.medication.reference) d.medicationReference = d.medication.reference; delete d.medication; } };
const reasonTo5 = (d) => { if (d.reasonCode || d.reasonReference) { d.reason = reasons(d.reasonCode, d.reasonReference); delete d.reasonCode; delete d.reasonReference; } };
const reasonTo4 = (d) => { if (d.reason) { const c = d.reason.filter((r) => r.concept).map((r) => r.concept); const r = d.reason.filter((x) => x.reference).map((x) => x.reference); if (c.length) d.reasonCode = c; if (r.length) d.reasonReference = r; delete d.reason; } };
const partTo5 = (d, type) => { const p = []; if (d.recorder) p.push({ function: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type', code: 'author' }] }, actor: d.recorder }); if (d.asserter) p.push({ function: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type', code: 'informant' }] }, actor: d.asserter }); if (p.length) { d.participant = p; delete d.recorder; delete d.asserter; } };
const partTo4 = (d) => { if (d.participant) { for (const p of d.participant) { const f = p.function?.coding?.[0]?.code; if (f === 'author') d.recorder = p.actor; else if (f === 'informant') d.asserter = p.actor; } delete d.participant; } };

/** One resource, R4 to R5. */
export function toR5(input) {
  if (!input || typeof input !== 'object') return input; const d = clone(input); const t = d.resourceType;
  if (t === 'Bundle') { d.entry = (d.entry || []).map((e) => ({ ...e, ...(e.resource ? { resource: toR5(e.resource) } : {}) })); return d; }
  if (t === 'CapabilityStatement') { d.fhirVersion = '5.0.0'; for (const r of d.rest || []) for (const sv of r.security?.service || []) for (const c of sv.coding || []) if (c.system === SEC_R4) c.system = SEC_R5; return d; }
  if (t === 'Encounter') {
    if (d.status) { if (ENC_BACK[ENC_STATUS[d.status]] !== d.status) keep(d, t, 'status', d.status); d.status = ENC_STATUS[d.status] || 'unknown'; }
    if (d.class) { d.class = [{ coding: [d.class] }]; }
    if (d.period) { d.actualPeriod = d.period; delete d.period; }
    if (d.hospitalization) { d.admission = d.hospitalization; delete d.hospitalization; }
    reasonTo5(d); if (d.reason) d.reason = [{ value: d.reason }];
    if (d.participant) d.participant = d.participant.map(({ individual, ...p }) => ({ ...p, ...(individual ? { actor: individual } : {}) }));
    if (d.diagnosis) d.diagnosis = d.diagnosis.map(({ condition, use, rank }) => { const out = { condition: condition ? [{ reference: condition }] : undefined, use: use ? [use] : undefined }; if (rank != null) keep(out, 'Encounter', 'diagnosis.rank', rank); return out; });
    if (d.classHistory) { keep(d, t, 'classHistory', d.classHistory); delete d.classHistory; } if (d.statusHistory) { keep(d, t, 'statusHistory', d.statusHistory); delete d.statusHistory; }
  }
  if (['MedicationRequest', 'MedicationDispense', 'MedicationAdministration', 'MedicationStatement'].includes(t)) {
    medTo5(d, t); reasonTo5(d);
    if (t === 'MedicationAdministration') { if (d.effectiveDateTime) { d.occurenceDateTime = d.effectiveDateTime; delete d.effectiveDateTime; } if (d.effectivePeriod) { d.occurencePeriod = d.effectivePeriod; delete d.effectivePeriod; } if (d.context) { d.encounter = d.context; delete d.context; } if (d.performer) d.performer = d.performer.map(({ actor, ...p }) => ({ ...p, actor: { reference: actor } })); if (d.instantiates) { keep(d, t, 'instantiates', d.instantiates); delete d.instantiates; } }
    if (t === 'MedicationDispense' && d.context) { d.encounter = d.context; delete d.context; }
    if (t === 'MedicationStatement') { keep(d, t, 'status', d.status); d.status = MS_STATUS[d.status] || 'recorded'; if (d.context) { d.encounter = d.context; delete d.context; } }
  }
  if (t === 'ServiceRequest') { if (d.code) { d.code = { concept: d.code }; } reasonTo5(d); }
  if (t === 'Immunization' || t === 'Procedure' || t === 'Appointment' || t === 'DiagnosticReport' || t === 'CarePlan') { if (t !== 'DiagnosticReport' && t !== 'CarePlan') reasonTo5(d); }
  if (t === 'Procedure') { for (const k of ['performedDateTime', 'performedPeriod', 'performedString', 'performedAge', 'performedRange']) if (d[k]) { d[k.replace('performed', 'occurrence')] = d[k]; delete d[k]; } if (d.asserter) { d.reportedReference = d.asserter; delete d.asserter; } }
  if (t === 'Appointment' && d.serviceType) d.serviceType = d.serviceType.map((c) => ({ concept: c }));
  if (t === 'AllergyIntolerance' || t === 'Condition') { partTo5(d, t); if (t === 'AllergyIntolerance' && typeof d.type === 'string') d.type = { coding: [{ system: 'http://hl7.org/fhir/allergy-intolerance-type', code: d.type }] }; }
  if (t === 'DocumentReference') { if (d.context) { const { encounter, period, related, ...rest } = d.context; if (encounter) d.context = encounter; else delete d.context; if (period) d.period = period; for (const [k, v] of Object.entries({ related, ...rest })) if (v !== undefined) keep(d, t, `context.${k}`, v); } if (d.content) d.content = d.content.map(({ format, ...c }) => { if (format) keep(c, t, 'content.format', format); return c; }); }
  return d;
}
/** One resource, R5 to R4. */
export function toR4(input) {
  if (!input || typeof input !== 'object') return input; const d = clone(input); const t = d.resourceType;
  if (t === 'Bundle') { d.entry = (d.entry || []).map((e) => ({ ...e, ...(e.resource ? { resource: toR4(e.resource) } : {}) })); return d; }
  if (t === 'CapabilityStatement') { d.fhirVersion = '4.0.1'; for (const r of d.rest || []) for (const sv of r.security?.service || []) for (const c of sv.coding || []) if (c.system === SEC_R5) c.system = SEC_R4; return d; }
  if (t === 'Encounter') {
    const st = take(d, t, 'status'); if (d.status) d.status = st || ENC_BACK[d.status] || 'unknown';
    if (Array.isArray(d.class)) d.class = d.class[0]?.coding?.[0];
    if (d.actualPeriod) { d.period = d.actualPeriod; delete d.actualPeriod; }
    if (d.admission) { d.hospitalization = d.admission; delete d.admission; }
    if (d.reason) { d.reason = d.reason.flatMap((r) => r.value || []); reasonTo4(d); }
    if (d.participant) d.participant = d.participant.map(({ actor, ...p }) => ({ ...p, ...(actor ? { individual: actor } : {}) }));
    if (d.diagnosis) d.diagnosis = d.diagnosis.map((x) => { const rank = take(x, 'Encounter', 'diagnosis.rank'); return { condition: x.condition?.[0]?.reference, ...(x.use ? { use: x.use[0] } : {}), ...(rank != null ? { rank } : {}) }; });
    const ch = take(d, t, 'classHistory'); if (ch) d.classHistory = ch; const sh = take(d, t, 'statusHistory'); if (sh) d.statusHistory = sh;
  }
  if (['MedicationRequest', 'MedicationDispense', 'MedicationAdministration', 'MedicationStatement'].includes(t)) {
    medTo4(d); reasonTo4(d);
    if (t === 'MedicationAdministration') { if (d.occurenceDateTime) { d.effectiveDateTime = d.occurenceDateTime; delete d.occurenceDateTime; } if (d.occurencePeriod) { d.effectivePeriod = d.occurencePeriod; delete d.occurencePeriod; } if (d.encounter) { d.context = d.encounter; delete d.encounter; } if (d.performer) d.performer = d.performer.map(({ actor, ...p }) => ({ ...p, actor: actor?.reference })); const ins = take(d, t, 'instantiates'); if (ins) d.instantiates = ins; }
    if (t === 'MedicationDispense' && d.encounter) { d.context = d.encounter; delete d.encounter; }
    if (t === 'MedicationStatement') { const st = take(d, t, 'status'); d.status = st || 'active'; if (d.encounter) { d.context = d.encounter; delete d.encounter; } }
  }
  if (t === 'ServiceRequest') { if (d.code) d.code = d.code.concept; reasonTo4(d); }
  if (t === 'Immunization' || t === 'Procedure' || t === 'Appointment') reasonTo4(d);
  if (t === 'Procedure') { for (const k of ['occurrenceDateTime', 'occurrencePeriod', 'occurrenceString', 'occurrenceAge', 'occurrenceRange']) if (d[k]) { d[k.replace('occurrence', 'performed')] = d[k]; delete d[k]; } if (d.reportedReference) { d.asserter = d.reportedReference; delete d.reportedReference; } }
  if (t === 'Appointment' && d.serviceType) d.serviceType = d.serviceType.map((c) => c.concept);
  if (t === 'AllergyIntolerance' || t === 'Condition') { partTo4(d); if (t === 'AllergyIntolerance' && d.type?.coding) d.type = d.type.coding[0].code; }
  if (t === 'DocumentReference') { const ctx = {}; if (d.context) ctx.encounter = d.context; if (d.period) { ctx.period = d.period; delete d.period; } for (const k of ['related', 'event', 'facilityType', 'practiceSetting', 'sourcePatientInfo']) { const v = take(d, t, `context.${k}`); if (v !== undefined) ctx[k] = v; } if (Object.keys(ctx).length) d.context = ctx; else delete d.context; if (d.content) d.content = d.content.map((c) => { const f = take(c, t, 'content.format'); return f ? { ...c, format: f } : c; }); }
  return d;
}
