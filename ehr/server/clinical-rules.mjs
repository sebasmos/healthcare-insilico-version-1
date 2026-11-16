// Derived clinical behaviour that runs inside the write transaction:
// MRN assignment, reference ranges and interpretation flags, auto-BMI,
// order completion when results are signed, and note amendment on addendum.
import { HttpError } from '../../platform/server/http.mjs';
import { LAB_BY_CODE, VITAL_BY_CODE, SYSTEMS, interpret } from './catalog.mjs';
import { MACHINES, lifecycleOf, REPORT_URLS, withExtension, isBed } from '../../platform/server/state-machines.mjs';
import { deriveNews2 } from './nursing.mjs';

export const MRN_SYSTEM = 'urn:hospital-desktop:mrn';
export const STATE_SINCE_URL = 'urn:hospital-desktop:state-since';
export const MR_TYPE = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR', display: 'Medical record number' }] };
export const mrnOf = (patient) => (patient.identifier || []).find((i) => i.type?.coding?.some((c) => c.code === 'MR'))?.value ?? null;
/** The MRN in the house format, if the patient has one (imported patients may carry a foreign MR identifier too). */
export const houseMrnOf = (patient) => (patient.identifier || []).find((i) => i.system === MRN_SYSTEM && /^N\d{6}$/.test(i.value || ''))?.value ?? null;

/** The next unused MRN in the house format (N + six digits), counted over every patient on the branch. */
export async function nextMrn(tx, branch) {
  const all = await tx.query('Patient', {}, { branch });
  const max = all.reduce((m, p) => Math.max(m, Number((houseMrnOf(p) || mrnOf(p) || 'N100000').slice(1)) || 0), 100000);
  return `N${String(max + 1).padStart(6, '0')}`;
}

/** Adds a house MRN as the first identifier when the patient has none. Used by the importers; the FHIR API path is assignMrn. */
export async function assignHouseMrn(tx, doc, branch) {
  if (houseMrnOf(doc)) return doc;
  const mrn = await nextMrn(tx, branch);
  return { ...doc, identifier: [{ use: 'usual', type: MR_TYPE, system: MRN_SYSTEM, value: mrn }, ...(doc.identifier || [])] };
}

const hasCategory = (doc, code) => (doc.category || []).some((c) => (c.coding || []).some((x) => x.code === code));
const loinc = (doc) => (doc.code?.coding || []).find((c) => c.system === SYSTEMS.loinc)?.code ?? null;
const SIGNED = ['final', 'corrected', 'amended'];

async function assignMrn(tx, previous, doc, branch) {
  const all = await tx.query('Patient', {}, { branch });
  let mrn = mrnOf(doc);
  if (mrn) {
    if (!/^N\d{6}$/.test(mrn)) throw new HttpError(422, `MRN "${mrn}" must have the format N followed by six digits`);
    const clash = all.find((p) => p.id !== doc.id && mrnOf(p) === mrn);
    if (clash) {
      throw new HttpError(409, `MRN ${mrn} is already assigned to another patient`, 'duplicate', {
        issues: [{ severity: 'error', code: 'duplicate', details: { coding: [{ system: 'urn:hospital-desktop:rule', code: 'duplicate-mrn' }] }, diagnostics: `MRN ${mrn} is already assigned to another patient` }],
      });
    }
    return doc;
  }
  if (previous && mrnOf(previous)) throw new HttpError(422, 'A patient MRN cannot be removed');
  mrn = await nextMrn(tx, branch);
  return { ...doc, identifier: [...(doc.identifier || []), { use: 'usual', type: MR_TYPE, system: MRN_SYSTEM, value: mrn }] };
}

function flagObservation(doc) {
  const code = loinc(doc);
  const value = doc.valueQuantity?.value;
  const spec = hasCategory(doc, 'laboratory') ? LAB_BY_CODE.get(code) : hasCategory(doc, 'vital-signs') ? VITAL_BY_CODE.get(code) : null;
  if (!spec || typeof value !== 'number') return doc;
  const out = { ...doc };
  if (!out.referenceRange?.length && (spec.low != null || spec.high != null)) {
    out.referenceRange = [{
      ...(spec.low != null ? { low: { value: spec.low, unit: spec.unit } } : {}),
      ...(spec.high != null ? { high: { value: spec.high, unit: spec.unit } } : {}),
    }];
  }
  const flag = interpret(value, spec);
  if (flag) out.interpretation = [{ coding: [{ system: SYSTEMS.interpretation, code: flag }] }];
  return out;
}

/** Returns { doc, released } to save. released undefined keeps the current value. */
export async function beforeSave(tx, type, previous, input, ctx) {
  let doc = input;
  let released;
  if (type === 'Patient') doc = await assignMrn(tx, previous, doc, ctx.branch);
  if (type === 'Observation') {
    doc = flagObservation(doc);
    if (previous?._ack && JSON.stringify(previous.valueQuantity ?? null) !== JSON.stringify(doc.valueQuantity ?? null)) delete doc._ack;
  }
  if (type === 'DocumentReference' && !doc.status) doc = { ...doc, status: 'current' };
  if (type === 'DiagnosticReport' && doc.status === 'final' && previous?.status !== 'final') {
    doc = { ...doc, issued: tx.now(), resultsInterpreter: [{ display: ctx.actor.id }] };
  }
  // A bed records when it entered its current state, so the board can show time in state and turnaround.
  if (type === 'Location' && isBed(doc) && (!previous || lifecycleOf(previous) !== lifecycleOf(doc))) doc = withExtension(doc, STATE_SINCE_URL, 'valueDateTime', tx.now());
  return { doc, released };
}

const quantity = (obs) => obs?.valueQuantity?.value;

async function deriveBmi(tx, saved, ctx, write) {
  const code = loinc(saved);
  if (!['29463-7', '8302-2'].includes(code) || !SIGNED.includes(saved.status)) return;
  const vitals = (await tx.query('Observation', { patient: saved._patient }, { branch: ctx.branch }))
    .filter((o) => hasCategory(o, 'vital-signs') && SIGNED.includes(o.status));
  const latest = (c) => vitals.filter((o) => loinc(o) === c).sort((a, b) => (a._validAt < b._validAt ? 1 : -1))[0];
  const weight = latest('29463-7');
  const height = latest('8302-2');
  if (!quantity(weight) || !quantity(height)) return;
  const refs = [`Observation/${weight.id}`, `Observation/${height.id}`];
  const versions = `${weight.meta.versionId}/${height.meta.versionId}`;
  const existing = vitals.find((o) => loinc(o) === '39156-5' && o.derivedFrom?.map((d) => d.reference).join() === refs.join() && o.derivedFrom?.[0]?.display === versions);
  if (existing) return;
  const meters = quantity(height) / 100;
  const bmi = Math.round((quantity(weight) / (meters * meters)) * 10) / 10;
  const spec = VITAL_BY_CODE.get('39156-5');
  await write('Observation', flagObservation({
    resourceType: 'Observation', status: 'final',
    category: [{ coding: [{ system: SYSTEMS.obsCategory, code: 'vital-signs' }] }],
    code: { coding: [{ system: SYSTEMS.loinc, code: spec.code, display: spec.name }] },
    subject: { reference: saved._patient },
    ...(saved.encounter ? { encounter: saved.encounter } : {}),
    effectiveDateTime: saved.effectiveDateTime,
    valueQuantity: { value: bmi, unit: 'kg/m2', system: 'http://unitsofmeasure.org', code: 'kg/m2' },
    derivedFrom: refs.map((reference, i) => ({ reference, ...(i === 0 ? { display: versions } : {}) })),
  }), { description: 'auto-calculated BMI' });
}

async function completeOrder(tx, saved, ctx, write) {
  if (!SIGNED.includes(saved.status)) return;
  for (const basedOn of saved.basedOn || []) {
    if (!basedOn.reference?.startsWith('ServiceRequest/')) continue;
    const order = await tx.get('ServiceRequest', basedOn.reference.slice('ServiceRequest/'.length), { branch: ctx.branch });
    if (!order || lifecycleOf(order) !== 'active') continue;
    const results = (await tx.query('Observation', { patient: saved._patient }, { branch: ctx.branch }))
      .filter((o) => (o.basedOn || []).some((b) => b.reference === basedOn.reference));
    if (!results.length || results.some((o) => !SIGNED.includes(o.status))) continue;
    const machine = MACHINES.ServiceRequest;
    const { _seq, ...clean } = order;
    const received = await write('ServiceRequest', machine.set(clean, 'results-received'), { description: 'all results signed' });
    const { _seq: s2, ...again } = received;
    await write('ServiceRequest', machine.set(again, 'completed'), { description: 'order completed' });
  }
}

async function amendParentNote(tx, saved, previous, ctx, write) {
  if (saved.docStatus !== 'final' || previous?.docStatus === 'final') return;
  for (const rel of saved.relatesTo || []) {
    if (rel.code !== 'appends' || !rel.target?.reference?.startsWith('DocumentReference/')) continue;
    const parent = await tx.get('DocumentReference', rel.target.reference.slice('DocumentReference/'.length), { branch: ctx.branch });
    if (parent?.docStatus === 'final') {
      const { _seq, ...clean } = parent;
      await write('DocumentReference', { ...clean, docStatus: 'amended' }, { description: 'addendum signed' });
    }
  }
}

const extString = (doc, url) => (doc.extension || []).find((e) => e.url === url)?.valueString ?? null;

// Signing an imaging report: notify the referring clinician's Inbox,
// complete the order, release the reading lock. A signed addendum marks its
// parent report as appended.
async function reportSigned(tx, saved, previous, ctx, write) {
  const pathology = (saved.category || []).some((c) => (c.coding || []).some((x) => x.code === 'pathology'));
  if (saved.status !== 'final' || previous?.status === 'final' || !(saved.imagingStudy?.length || pathology)) return;
  const parentRef = extString(saved, REPORT_URLS.addendumOf);
  if (parentRef) {
    const parent = await tx.get('DiagnosticReport', parentRef.split('/')[1], { branch: ctx.branch });
    if (parent && ['final', 'amended', 'corrected', 'appended'].includes(parent.status) && parent.status !== 'appended') {
      const { _seq, ...clean } = parent;
      await write('DiagnosticReport', { ...clean, status: 'appended' }, { description: 'addendum signed' });
    }
  }
  const studyId = saved.imagingStudy?.[0]?.reference?.split('/')[1] || null;
  const study = studyId ? await tx.get('ImagingStudy', studyId, { branch: ctx.branch }) : null;
  const orderId = saved.basedOn?.find((b) => b.reference?.startsWith('ServiceRequest/'))?.reference?.split('/')[1] || null;
  const order = pathology && orderId ? await tx.get('ServiceRequest', orderId, { branch: ctx.branch }) : null;
  const exam = saved.code?.text || saved.code?.coding?.[0]?.display || study?.description || (pathology ? 'Pathology case' : 'Imaging study');
  if (pathology && !parentRef) {
    const caseId = saved.specimen?.[0]?.reference?.split('/')[1];
    const c = caseId ? await tx.get('Specimen', caseId, { branch: ctx.branch }) : null;
    if (c && ['received', 'in-process'].includes(lifecycleOf(c))) { const { _seq, ...clean } = c; await write('Specimen', { ...clean, extension: (clean.extension || []).map((e) => (e.url === 'urn:hospital-desktop:lifecycle' ? { ...e, valueCode: 'resulted' } : e)) }, { description: 'case signed out' }); }
  }
  await write('Task', {
    resourceType: 'Task', status: 'requested', intent: 'order', authoredOn: tx.now(), for: { reference: saved._patient },
    focus: { reference: `DiagnosticReport/${saved.id}` },
    code: { coding: [{ system: 'urn:hospital-desktop:task', code: 'report-signed' }], text: parentRef ? 'Report addendum signed' : pathology ? 'Pathology report signed' : 'Imaging report signed' },
    description: `${exam}: ${(parentRef ? extString(saved, REPORT_URLS.findings) : saved.conclusion || '').slice(0, 160)}`,
    owner: { display: study?.referrer?.display || order?.requester?.display || 'Referring clinician' }, requester: { display: ctx.actor.id },
  }, { description: 'Inbox notification for signed report' });
  // A critical finding (plan-master task 3C) raises a STAT Inbox alert as well, logged like a critical lab result.
  if (!parentRef && (saved.extension || []).find((e) => e.url === 'urn:hospital-desktop:report-critical')?.valueBoolean) {
    let told = null; try { told = JSON.parse(extString(saved, 'urn:hospital-desktop:critical-communicated') || 'null'); } catch { told = null; }
    await write('Task', {
      resourceType: 'Task', status: 'requested', intent: 'order', priority: 'stat', authoredOn: tx.now(), for: { reference: saved._patient },
      focus: { reference: `DiagnosticReport/${saved.id}` },
      code: { coding: [{ system: 'urn:hospital-desktop:task', code: 'critical-report' }], text: pathology ? 'Critical pathology diagnosis' : 'Critical imaging finding' },
      description: `${exam}: ${(saved.conclusion || '').slice(0, 120)}${told ? ` · told ${told.to}${told.how ? ` by ${told.how}` : ''} at ${told.at}` : ''}`,
      owner: { display: study?.referrer?.display || order?.requester?.display || 'Referring clinician' }, requester: { display: ctx.actor.id },
    }, { description: `critical finding communicated to ${told?.to || 'unknown'} (${told?.how || 'unspecified'}) at ${told?.at || 'unknown'}` });
  }
  for (const basedOn of parentRef ? [] : (saved.basedOn || study?.basedOn || [])) {
    if (!basedOn.reference?.startsWith('ServiceRequest/')) continue;
    const order = await tx.get('ServiceRequest', basedOn.reference.split('/')[1], { branch: ctx.branch });
    if (!order || lifecycleOf(order) !== 'active') continue;
    const { _seq, ...clean } = order;
    const signed = await write('ServiceRequest', MACHINES.ServiceRequest.set(clean, 'report-signed'), { description: 'report signed' });
    const { _seq: s2, ...again } = signed;
    await write('ServiceRequest', MACHINES.ServiceRequest.set(again, 'completed'), { description: 'order completed' });
  }
  if (study?._lock) {
    const { _seq, _lock, ...clean } = study;
    await write('ImagingStudy', clean, { description: 'reading lock released on sign' });
  }
}

// Signing an ECG interpretation: the ordering clinician's Inbox is told and the ECG order is completed.
async function ecgReportSigned(tx, saved, previous, ctx, write) {
  const isEcg = (saved.category || []).some((c) => (c.coding || []).some((x) => x.code === 'ecg'));
  if (!isEcg || saved.status !== 'final' || previous?.status === 'final') return;
  await write('Task', {
    resourceType: 'Task', status: 'requested', intent: 'order', authoredOn: tx.now(), for: { reference: saved._patient }, focus: { reference: `DiagnosticReport/${saved.id}` },
    code: { coding: [{ system: 'urn:hospital-desktop:task', code: 'report-signed' }], text: 'ECG interpretation signed' }, description: (saved.conclusion || '').slice(0, 160),
    owner: { display: 'Ordering clinician' }, requester: { display: ctx.actor.id },
  }, { description: 'Inbox notification for signed ECG' });
  for (const basedOn of saved.basedOn || []) {
    if (!basedOn.reference?.startsWith('ServiceRequest/')) continue;
    const order = await tx.get('ServiceRequest', basedOn.reference.split('/')[1], { branch: ctx.branch });
    if (!order || lifecycleOf(order) !== 'active') continue;
    const { _seq, ...clean } = order;
    const signed = await write('ServiceRequest', MACHINES.ServiceRequest.set(clean, 'report-signed'), { description: 'ECG interpretation signed' });
    const { _seq: s2, ...again } = signed;
    await write('ServiceRequest', MACHINES.ServiceRequest.set(again, 'completed'), { description: 'order completed' });
  }
}

/** write(type, doc, { released, description }) saves and logs a system-derived change. */
export async function afterSave(tx, saved, previous, ctx, write) {
  if (saved.resourceType === 'Observation') {
    if (hasCategory(saved, 'vital-signs')) await deriveBmi(tx, saved, ctx, write);
    if (hasCategory(saved, 'vital-signs') || hasCategory(saved, 'exam')) await deriveNews2(tx, saved, ctx, write);
    await completeOrder(tx, saved, ctx, write);
  }
  if (saved.resourceType === 'DocumentReference') await amendParentNote(tx, saved, previous, ctx, write);
  if (saved.resourceType === 'DiagnosticReport') { await reportSigned(tx, saved, previous, ctx, write); await ecgReportSigned(tx, saved, previous, ctx, write); }
}
