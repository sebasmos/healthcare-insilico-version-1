// Da Vinci profile conformance (docs/STANDARDS.md): the guide engines answer with plain FHIR; this layer shapes
// each answer to the guide's profiles (meta.profile, the must-have elements, the bundle shapes the guides ask for)
// and is checked with the HL7 FHIR Validator against each guide's package with zero errors. No patient names:
// the Patient carries only the record number.
const PAS = 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition';
const DTR = 'http://hl7.org/fhir/us/davinci-dtr/StructureDefinition';
const CDEX = 'http://hl7.org/fhir/us/davinci-cdex/StructureDefinition';
const PDEX = 'http://hl7.org/fhir/us/davinci-pdex/StructureDefinition';
const PCT = 'http://hl7.org/fhir/us/davinci-pct/StructureDefinition';
const USDF = 'http://hl7.org/fhir/us/davinci-drug-formulary/StructureDefinition';
const PLANNET = 'http://hl7.org/fhir/us/davinci-pdex-plan-net/StructureDefinition';
const CRD = 'http://hl7.org/fhir/us/davinci-crd/StructureDefinition';
const BASE = 'https://hospital-desktop.invalid/fhir';
import { narrate, finish as finishWith } from '../../standards/server/narrative.mjs';
const finish = (x) => finishWith(x, BASE);
const prof = (r, url) => ({ ...r, meta: { ...(r.meta || {}), profile: [url] } });
const ref = (r) => `${r.resourceType}/${r.id}`;
const entry = (r) => ({ fullUrl: `${BASE}/${ref(r)}`, resource: r });

/** Reshapes one Da Vinci answer. guide: the guide id; seg: the path parts after /api/ins/davinci; body: the answer. */
export function conform(guide, seg, body, opts = {}) {
  const out = shape(guide, seg, body, opts);
  return out && typeof out === 'object' && out.resourceType ? finish(out) : out;
}
function shape(guide, seg, body, { now = new Date().toISOString(), request = null } = {}) {
  if (!body || typeof body !== 'object') return body;
  if (guide === 'pas' && body.resourceType === 'ClaimResponse') return pasBundle(body, now);
  const each = (b, fn) => (b.resourceType === 'Bundle' ? { ...b, entry: (b.entry || []).map((e) => ({ ...e, resource: fn(e.resource) })) } : fn(b));
  if (guide === 'dtr' && body.resourceType === 'Parameters') return prof({ ...body, parameter: body.parameter.map((p) => (p.name === 'PackageBundle' ? { ...p, resource: prof(each(p.resource, (r) => (r.resourceType === 'Questionnaire' ? prof({ ...r, url: `${BASE}/Questionnaire/${r.id}`, subjectType: ['Patient'] }, `${DTR}/dtr-std-questionnaire`) : r.resourceType === 'QuestionnaireResponse' ? dtrResponse(r, body, request, now) : r)), `${DTR}/DTR-QPackageBundle`) } : p)) }, `${DTR}/dtr-qpackage-output-parameters`);
  const org = (id) => ({ reference: `Organization/${id}` });
  const eob = (r) => { const { preAuthRef, ...e } = r; return { ...e, ...(preAuthRef?.length ? { preAuthRef } : {}), type: e.type?.coding?.[0]?.system ? e.type : { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional' }] }, created: e.created || now, insurer: e.insurer?.reference ? e.insurer : { ...org('insurer'), ...(e.insurer?.display ? { display: e.insurer.display } : {}) }, provider: e.provider?.reference ? e.provider : org('requestor'), insurance: e.insurance?.length ? e.insurance : [{ focal: true, coverage: { reference: `Coverage/${String(e.patient?.reference || '').split('/')[1] || 'coverage'}` } }], item: (e.item || []).map((i) => ({ ...i, productOrService: withSystem(i.productOrService), ...(i.adjudication ? { adjudication: i.adjudication.map((a) => adjCat(a)) } : {}) })), ...(e.total ? { total: e.total.map((t) => adjCat(t, 'PCTAdjudication')) } : {}) }; };
  if (guide === 'cdex' && body.resourceType === 'Bundle') return each(body, (r) => (r.resourceType === 'Task' ? prof({ ...r, code: { coding: [{ system: `${CDEX.replace('StructureDefinition', 'CodeSystem')}/cdex-temp`, code: 'data-request-code' }] }, authoredOn: r.authoredOn || now, requester: org('insurer'), owner: org('requestor'), input: [{ type: { coding: [{ system: 'http://hl7.org/fhir/us/davinci-hrex/CodeSystem/hrex-temp', code: 'data-code' }] }, valueCodeableConcept: { coding: [{ system: 'http://loinc.org', code: '11506-3', display: 'Progress note' }], text: (r.input || []).map((i) => i.valueString).filter(Boolean).join('; ') || 'Clinical records' } }] }, `${CDEX}/cdex-task-data-request`) : r));
  if (guide === 'pdex' && body.resourceType === 'Bundle') return each(body, (r) => (r.resourceType === 'ExplanationOfBenefit' && r.use === 'preauthorization' ? { ...eob(r), meta: { profile: [`${PDEX}/pdex-priorauthorization`, `${PDEX}/pdex-priorauthorization|2.0.0`] } } : r));
  if (guide === 'pct' && body.resourceType === 'Bundle') return each(body, (r) => (r.resourceType === 'ExplanationOfBenefit' ? prof(aeob(eob(r), request, now), `${PCT}/davinci-pct-aeob`) : r));
  if (guide === 'formulary' && body.resourceType === 'Bundle') return formulary(body, now);
  if (guide === 'plannet' && body.resourceType === 'Bundle') return each(body, (r) => prof({ ...r, active: r.active ?? true, ...(r.resourceType === 'Practitioner' && !r.name ? { name: [{ text: `NPI ${r.id}`, _family: { extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason', valueCode: 'masked' }] } }] } : {}) }, `${PLANNET}/plannet-${r.resourceType}`));
  if (guide === 'crd' && body.cards) return { ...body, cards: body.cards.map((c) => ({ ...c, suggestions: (c.suggestions || []).map((g) => ({ ...g, actions: (g.actions || []).map((x) => (x.resource ? { ...x, resource: crdOrder(x.resource, now) } : x)) })) })) };
  return body;
}

export function pasBundle(cr, now) {
  const pid = String(cr.patient?.reference || '').split('/')[1] || 'unknown';
  const patient = prof({ resourceType: 'Patient', id: pid, identifier: [{ system: 'urn:hospital-desktop:member', value: cr.patient?.display?.replace(/^Patient /, '') || pid }], name: [{ text: 'masked', extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason', valueCode: 'masked' }] }], gender: 'unknown' }, `${PAS}/profile-beneficiary`);
  const insurer = prof({ resourceType: 'Organization', id: 'insurer', active: true, name: cr.insurer?.display || 'Insurer', identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567893' }] }, `${PAS}/profile-insurer`);
  const requestor = prof({ resourceType: 'Organization', id: 'requestor', active: true, name: 'Hospital', identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567893' }] }, `${PAS}/profile-requestor`);
  const claimResponse = prof({ ...cr, type: cr.type || { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional' }] }, patient: { reference: ref(patient) }, insurer: { reference: ref(insurer) }, requestor: { reference: ref(requestor) }, created: cr.created || now, identifier: cr.identifier || [{ system: 'urn:hospital-desktop:auth', value: cr.id }] }, `${PAS}/profile-claimresponse`);
  return prof({ resourceType: 'Bundle', id: `pas-${cr.id}`, identifier: { system: 'urn:hospital-desktop:pas', value: cr.id }, type: 'collection', timestamp: now, entry: [claimResponse, patient, insurer, requestor].map(entry) }, `${PAS}/profile-pas-response-bundle`);
}

function dtrResponse(r, out, request, now) {
  const q = out.parameter.find((p) => p.name === 'PackageBundle').resource.entry.map((e) => e.resource).find((x) => x.resourceType === 'Questionnaire');
  const order = (request?.parameter || []).find((p) => p.name === 'order')?.resource; const cov = (request?.parameter || []).find((p) => p.name === 'coverage')?.resource;
  const answered = new Map((r.item || []).map((i) => [i.linkId, i]));
  return prof({ ...r, id: r.id || `qr-${q.id}`, questionnaire: `${BASE}/Questionnaire/${q.id}|${q.version}`, authored: r.authored || now, author: { display: 'Documentation Templates and Rules: prefilled from the chart' },
    extension: [{ url: `${DTR}/intendedUse`, valueCodeableConcept: { coding: [{ system: 'http://hl7.org/fhir/us/davinci-crd/CodeSystem/coverage-information-codes', code: 'withpa' }] } },
      { url: `${DTR}/qr-context`, valueReference: { reference: `ServiceRequest/${order?.id || 'order'}`, type: 'ServiceRequest' } },
      { url: `${DTR}/qr-context`, valueReference: { reference: `Coverage/${cov?.id || 'coverage'}`, type: 'Coverage' } }],
    item: (q.item || []).map((i) => answered.get(i.linkId) || { linkId: i.linkId, text: i.text }) }, `${DTR}/dtr-questionnaireresponse`);
}

const absolute = (c) => (c && !/^[a-z]+:/i.test(c) ? `${BASE}/${c}` : c);
function crdOrder(o, now) {
  const pid = String(o.subject?.reference || '').split('/')[1] || 'patient';
  const extension = (o.extension || []).map((e) => (e.url.endsWith('ext-coverage-information') ? { ...e, extension: [...e.extension.map((x) => (x.valueCanonical ? { ...x, valueCanonical: absolute(x.valueCanonical) } : x)), ...(e.extension.some((x) => x.url === 'coverage') ? [] : [{ url: 'coverage', valueReference: { reference: `Coverage/${pid}` } }]), ...(e.extension.some((x) => x.url === 'coverage-assertion-id') ? [] : [{ url: 'coverage-assertion-id', valueString: `${o.id || 'order'}-${now.slice(0, 10)}` }])] } : e));
  return prof({ ...o, extension, authoredOn: o.authoredOn || now, requester: o.requester || { reference: 'Practitioner/ordering' } }, `${CRD}/profile-${o.resourceType.toLowerCase()}`);
}

const PCT_CS = 'http://hl7.org/fhir/us/davinci-pct/CodeSystem';
const withSystem = (cc) => ({ ...cc, coding: (cc?.coding || []).map((c) => (c.system ? c : { ...c, system: /^\d{4}[0-9A-Z]$/.test(c.code) ? 'http://www.ama-assn.org/go/cpt' : 'https://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets' })) });
const ADJ = new Set(['submitted', 'copay', 'eligible', 'deductible', 'unallocdeduct', 'eligpercent', 'tax', 'benefit']);
const adjCat = (a, cs = 'PCTAdjudicationCategoryCS') => ({ ...a, category: { ...a.category, coding: (a.category?.coding || []).map((c) => (c.system ? c : { ...c, system: ADJ.has(c.code) ? 'http://terminology.hl7.org/CodeSystem/adjudication' : `${PCT_CS}/${cs}` })) } });
function aeob(e, request, now) {
  const claim = (request?.entry || []).map((x) => x.resource).find((r) => r?.resourceType === 'Claim') || {};
  const year = (claim.created || now).slice(0, 4); const day = (claim.item?.[0]?.servicedDate || now).slice(0, 10);
  return { ...e,
    extension: [...(e.extension || []), { url: 'http://hl7.org/fhir/us/davinci-pct/StructureDefinition/gfeReference', valueReference: { reference: `Claim/${claim.id || `gfe-${e.id}`}` } }],
    identifier: [{ type: { coding: [{ system: `${PCT_CS}/PCTIdentifierType`, code: 'uc', display: 'Unique Claim ID' }] }, system: 'urn:hospital-desktop:aeob', value: e.id }],
    claim: { identifier: { system: 'urn:hospital-desktop:gfe', value: claim.id || `gfe-${e.id}` } },
    processNote: e.processNote || [{ type: 'display', text: 'An estimate, not a guarantee of payment or of the final cost.' }],
    benefitPeriod: { start: `${year}-01-01`, end: `${year}-12-31` },
    benefitBalance: [{ category: { coding: [{ system: 'https://x12.org/codes/service-type-codes', code: '30' }] }, unit: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/benefit-unit', code: 'individual' }] }, term: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/benefit-term', code: 'annual' }] }, financial: [{ type: { coding: [{ system: `${PCT_CS}/PCTFinancialType`, code: 'deductible' }] }, allowedMoney: { value: 0, currency: 'USD' }, usedMoney: { value: 0, currency: 'USD' } }] }],
    item: e.item.map((i) => ({ ...i, servicedDate: i.servicedDate || day, extension: [...(i.extension || []), { url: 'http://hl7.org/fhir/us/davinci-pct/StructureDefinition/serviceDescription', valueString: `Service ${i.productOrService?.coding?.[0]?.code || ''}`.trim() }] })) };
}

const USDF_CS = 'http://hl7.org/fhir/us/davinci-drug-formulary/CodeSystem';
const TIERS = new Set(['generic', 'preferred-generic', 'non-preferred-generic', 'brand', 'preferred-brand', 'non-preferred-brand', 'specialty', 'medical-service-generic', 'medical-service-brand', 'ACA-preventive', 'zero-cost-share-preventive', 'family-planning', 'medical-device-supply', 'non-formulary', 'not-covered', 'tier-1', 'tier-2', 'tier-3', 'tier-4', 'tier-5', 'tier-6', 'tier-7', 'tier-8', 'tier-9', 'tier-10']);
/** The formulary as US Drug Formulary 2.0.1 resources: one FormularyDrug and one FormularyItem (tier and limits) per drug. */
function formulary(b, now) {
  const out = [];
  for (const { resource: mk } of b.entry || []) {
    const ext = Object.fromEntries((mk.extension || []).map((e) => [e.url, e.valueString ?? e.valueBoolean]));
    const { extension, ...drug } = mk;
    const tier = TIERS.has(String(ext.tier)) ? String(ext.tier) : /^\d+$/.test(String(ext.tier)) ? `tier-${ext.tier}` : 'tier-1';
    out.push(prof(drug, `${USDF}/usdf-FormularyDrug`));
    out.push(prof({ resourceType: 'Basic', id: `item-${mk.id}`, code: { coding: [{ system: `${USDF_CS}/usdf-InsuranceItemTypeCS`, code: 'formulary-item' }] }, subject: { reference: 'InsurancePlan/formulary' },
      extension: [{ url: `${USDF}/usdf-FormularyReference-extension`, valueReference: { reference: 'InsurancePlan/formulary' } }, { url: `${USDF}/usdf-AvailabilityStatus-extension`, valueCode: 'active' },
        { url: `${USDF}/usdf-PharmacyBenefitType-extension`, valueCodeableConcept: { coding: [{ system: `${USDF_CS}/usdf-PharmacyBenefitTypeCS-TEMPORARY-TRIAL-USE`, code: '1-month-in-retail' }] } },
        { url: `${USDF}/usdf-DrugTierID-extension`, valueCodeableConcept: { coding: [{ system: `${USDF_CS}/usdf-DrugTierCS-TEMPORARY-TRIAL-USE`, code: tier }] } },
        { url: `${USDF}/usdf-PriorAuthorization-extension`, valueBoolean: Boolean(ext['prior-authorization']) }, { url: `${USDF}/usdf-StepTherapyLimit-extension`, valueBoolean: Boolean(ext['step-therapy']) }, { url: `${USDF}/usdf-QuantityLimit-extension`, valueBoolean: Boolean(ext['quantity-limit']) }],
      meta: { lastUpdated: now } }, `${USDF}/usdf-FormularyItem`));
  }
  return { ...b, entry: out.map((resource) => ({ resource })) };
}
