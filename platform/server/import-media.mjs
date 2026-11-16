// DICOM and WFDB ECG imports with patient mapping, shared by the CLI and the
// tests. Studies and records are attached either to one patient (--patient
// <MRN>) or to synthetic patients created per source patient
// (--create-patients, "Imaging, Patient 001" / "ECG, Patient 001"). Created
// patients carry the source id as a secondary identifier, so a rerun reuses
// them instead of creating more. Nothing is written outside data/.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ingestInstances, parse, validateInstance, describe, DicomError } from '../../pacs/server/dicom.mjs';
import { recordAction } from './audit.mjs';
import { assignHouseMrn, mrnOf } from '../../ehr/server/clinical-rules.mjs';
import { tagPatient } from './datasets.mjs';
import { readRecord, listRecords, toObservation, subjectHints, WfdbError } from '../../ecg/server/wfdb.mjs';

export const SOURCE_ID_URL = 'urn:hospital-desktop:source-patient-id';
const DEFAULT_ACTOR = { kind: 'human', id: 'import-script', role: 'administrator' };
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v));
const checksum = (doc) => createHash('sha256').update(canonical(doc)).digest('hex');

/** Every file under a path, in a stable order. */
export function filesUnder(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs.readdirSync(target).sort().flatMap((name) => filesUnder(path.join(target, name)));
}

const dicomDate = (s) => (/^\d{8}$/.test(s || '') ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null);
const dicomSex = (s) => ({ M: 'male', F: 'female', O: 'other' }[(s || '').trim().toUpperCase()] ?? null);

/**
 * Resolves the patient every item goes to. mode: { patient: <MRN> } or { createPatients: true }
 * or neither (match header PatientID to an MRN). Returns a resolver used inside
 * one transaction: resolver(tx, sourceId, hints) -> Patient id or null.
 */
export function patientMapper({ patient = null, createPatients = false, family, tags, actor, dryRun }) {
  const created = new Map();
  let counter = 0;
  return {
    created,
    async resolve(tx, sourceId, hints = {}) {
      if (patient) {
        const found = (await tx.query('Patient', {}, { branch: 'main' })).find((p) => mrnOf(p) === patient);
        if (!found) throw new Error(`No patient has MRN "${patient}"`);
        return found.id;
      }
      if (!createPatients) return null;
      if (created.has(sourceId)) return created.get(sourceId).id;
      const existing = (await tx.query('Patient', {}, { branch: 'main' })).find((p) => (p.identifier || []).some((i) => i.system === SOURCE_ID_URL && i.value === `${family}:${sourceId}`));
      if (existing) { created.set(sourceId, { id: existing.id, reused: true }); return existing.id; }
      counter += 1;
      const n = String(counter).padStart(3, '0');
      let doc = tagPatient({
        resourceType: 'Patient', name: [{ family, given: [`Patient ${n}`], text: `${family}, Patient ${n}` }],
        ...(hints.birthDate ? { birthDate: hints.birthDate } : {}), ...(hints.gender ? { gender: hints.gender } : {}),
        identifier: [{ system: SOURCE_ID_URL, value: `${family}:${sourceId}` }],
      }, tags);
      doc = await assignHouseMrn(tx, doc, 'main');
      const id = dryRun ? `dry-run-${n}` : null;
      if (dryRun) { created.set(sourceId, { id, reused: false, mrn: mrnOf(doc) }); return id; }
      const saved = await tx.save('Patient', { ...doc, _import: { source: family.toLowerCase(), sourceId } }, { branch: 'main', updatedBy: 'import' });
      await recordAction(tx, { actor, kind: 'create', action: 'import.patient', args: { patient: saved.id, mrn: mrnOf(saved), sourceId, kind: family.toLowerCase() }, entityRef: `Patient/${saved.id}`, versionId: saved.meta.versionId, patientRef: `Patient/${saved.id}`, description: `registered ${family}, Patient ${n} (${mrnOf(saved)}) for source id ${sourceId}` });
      created.set(sourceId, { id: saved.id, reused: false, mrn: mrnOf(saved) });
      return saved.id;
    },
  };
}

/**
 * Imports DICOM files. Returns { files, stored, duplicate, failed, studies: Set, problems: [], patients: [ids], created: n, reused: n }.
 * Options: dryRun, patient (MRN), createPatients, tags { synthetic, restricted, source }, actor.
 */
export async function importDicomFiles(store, target, { dryRun = false, patient = null, createPatients = false, tags = {}, actor = DEFAULT_ACTOR } = {}) {
  const files = filesUnder(path.resolve(target));
  const totals = { files: files.length, stored: 0, duplicate: 0, failed: 0, problems: [], studies: new Set(), patients: new Set(), created: 0, reused: 0 };
  const mapper = patientMapper({ patient, createPatients, family: 'Imaging', tags, actor, dryRun });
  for (let i = 0; i < files.length; i += 50) {
    const batch = files.slice(i, i + 50);
    const items = batch.map((file) => ({ bytes: new Uint8Array(fs.readFileSync(file)) }));
    const headers = items.map((item) => { try { const f = parse(item.bytes); const issues = validateInstance(f); return issues.length ? { issues } : { d: describe(f) }; } catch (err) { if (!(err instanceof DicomError)) throw err; return { issues: [err.message] }; } });
    // Patients are resolved (and created) in their own transaction, before the instances are stored.
    const byHeader = new Map();
    await store.transaction(async (tx) => {
      for (const h of headers) if (h.d && !byHeader.has(h.d.patientId)) byHeader.set(h.d.patientId, await mapper.resolve(tx, h.d.patientId, { birthDate: dicomDate(h.d.patientBirthDate), gender: dicomSex(h.d.patientSex) }));
      if (dryRun) throw new Rollback();
    }).catch((err) => { if (!(err instanceof Rollback)) throw err; });
    let results;
    // A dry run validates the files; patient matching is reported by the real run (patients may be imported first).
    if (dryRun) {
      results = headers.map((h) => (h.issues ? { status: 'failed', reason: h.issues.join('; ') } : { status: 'stored', studyId: h.d.studyUid, patient: byHeader.get(h.d.patientId) }));
    } else {
      results = await ingestInstances(store, items, { actor, branch: 'main', runId: null }, { override: (patient || createPatients) ? (d) => byHeader.get(d.patientId) ?? null : null });
      results.forEach((r, n) => { if (r.status !== 'failed') r.patient = byHeader.get(headers[n].d.patientId) ?? null; });
    }
    results.forEach((r, n) => {
      totals[r.status] += 1;
      if (r.studyId) totals.studies.add(r.studyId);
      if (r.status !== 'failed' && r.patient) totals.patients.add(r.patient);
      if (r.status === 'failed') totals.problems.push(`${path.relative(process.cwd(), batch[n])}: ${r.reason}`);
    });
  }
  // Without an override, the instances were matched by MRN: collect those patients from the studies written.
  if (!patient && !createPatients && !dryRun) {
    const studies = await store.query('ImagingStudy', {}, { branch: 'main' });
    for (const st of studies) if (totals.studies.has(st.id)) totals.patients.add(st.subject.reference.replace('Patient/', ''));
  }
  for (const v of mapper.created.values()) { if (v.reused) totals.reused += 1; else totals.created += 1; }
  totals.patients = [...totals.patients].filter((p) => !String(p).startsWith('dry-run-'));
  return totals;
}

class Rollback extends Error {}

/**
 * Imports WFDB records from a folder: one Observation per record. Returns
 * { records, written, unchanged, failed, truncated, problems: [], patients: [ids], created, reused }.
 */
export async function importEcgFolder(store, folder, { dryRun = false, patient = null, createPatients = false, tags = {}, actor = DEFAULT_ACTOR } = {}) {
  const dir = path.resolve(folder);
  const names = listRecords(dir);
  const totals = { records: names.length, written: 0, unchanged: 0, failed: 0, truncated: 0, problems: [], patients: new Set(), created: 0, reused: 0, observations: [] };
  const mapper = patientMapper({ patient, createPatients, family: 'ECG', tags, actor, dryRun });
  if (!patient && !createPatients) throw new Error('--ecg needs --patient <MRN> or --create-patients: WFDB records carry no patient identity');
  for (const name of names) {
    let record;
    try { record = readRecord(dir, name); } catch (err) {
      if (!(err instanceof WfdbError) && err.code !== 'ENOENT') throw err;
      totals.failed += 1;
      totals.problems.push(`${name}: ${err instanceof WfdbError ? err.message : `missing signal file (${path.basename(err.path || '')})`}`);
      continue;
    }
    try {
      await store.transaction(async (tx) => {
        const patientId = await mapper.resolve(tx, name, subjectHints(record));
        const wall = tx.now();
        const { observation, truncated } = toObservation(record, { patientId, importedAt: wall });
        if (truncated.leads || truncated.seconds) { totals.truncated += 1; totals.problems.push(`${name}: kept ${Math.min(record.signals.length, 12)} of ${record.signals.length} leads and at most 30 seconds per lead`); }
        const { issued: _i, ...stable } = observation;
        const sum = checksum(stable);
        const existing = await tx.get('Observation', observation.id);
        if (existing?._import?.checksum === sum) { totals.unchanged += 1; totals.patients.add(patientId); if (dryRun) throw new Rollback(); return; }
        totals.written += 1;
        totals.patients.add(patientId);
        totals.observations.push(observation.id);
        if (dryRun) throw new Rollback();
        const saved = await tx.save('Observation', { ...observation, _import: { checksum: sum, source: `wfdb:${name}`, importedAt: wall } }, { branch: 'main', recordedAt: existing ? wall : observation.effectiveDateTime, validAt: observation.effectiveDateTime, updatedBy: 'import' });
        await recordAction(tx, {
          actor, kind: existing ? 'update' : 'create', action: 'import.ecg', args: { record: name, observation: saved.id, leads: observation.component.length, patient: `Patient/${patientId}` },
          entityRef: `Observation/${saved.id}`, versionId: saved.meta.versionId, patientRef: `Patient/${patientId}`, description: `imported ECG record ${name} (${observation.component.length} leads) for Patient/${patientId}`,
        });
      });
    } catch (err) {
      if (err instanceof Rollback) continue;
      if (err.message.startsWith('No patient has MRN')) throw err;
      totals.failed += 1;
      totals.problems.push(`${name}: ${err.message}`);
    }
  }
  for (const v of mapper.created.values()) { if (v.reused) totals.reused += 1; else totals.created += 1; }
  totals.patients = [...totals.patients].filter((p) => !String(p).startsWith('dry-run-'));
  return totals;
}
