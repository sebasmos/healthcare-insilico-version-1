// Server-side DICOM archive: validation, file storage under data/dicom and
// the ImagingStudy index kept in the store. Uses the shared codec in
// viewers/dicom.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';
import { parse, pixels, write, isValidUid, generateUid, SOP_CLASS, TS, DicomError, isCompressedSyntax, COMPRESSED_LABEL, COMPRESSED_TS } from '../../viewers/dicom/dicom.js';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';
import { lifecycleOf } from '../../platform/server/state-machines.mjs';
import { mrnOf } from '../../ehr/server/clinical-rules.mjs';

export * from '../../viewers/dicom/dicom.js';
import { createObjectStore } from '../../platform/server/storage.mjs';

export const dicomRoot = () => path.resolve(REPO_ROOT, process.env.DICOM_DIR || 'data/dicom');
export const studyResourceId = (studyUid) => `st-${createHash('sha1').update(studyUid).digest('hex').slice(0, 32)}`;
export const instancePath = (root, study, series, sop) => path.join(root, study, series, `${sop}.dcm`);
export const PRIORITY_URL = 'urn:hospital-desktop:priority';
export const RECEIVED_URL = 'urn:hospital-desktop:received';
const DCM = 'http://dicom.nema.org/resources/ontology/DCM';
const FAMILY = { CR: 'DX', DX: 'DX', CT: 'CT', MR: 'MR', US: 'US', NM: 'NM' };

/** The header fields the archive indexes. */
export function describe(file) {
  return {
    studyUid: file.str('StudyInstanceUID'), seriesUid: file.str('SeriesInstanceUID'), sopUid: file.str('SOPInstanceUID'),
    sopClass: file.str('SOPClassUID'), patientId: file.str('PatientID'), patientName: file.str('PatientName'),
    accession: file.str('AccessionNumber'), modality: file.str('Modality') || 'OT', studyDate: file.str('StudyDate'),
    studyTime: file.str('StudyTime'), studyDescription: file.str('StudyDescription'), seriesDescription: file.str('SeriesDescription'),
    seriesNumber: file.num('SeriesNumber'), instanceNumber: file.num('InstanceNumber'), bodyPart: file.str('BodyPartExamined'),
    referrer: file.str('ReferringPhysicianName').replace(/\^/g, ' ').trim(), frames: file.num('NumberOfFrames') ?? 1,
    rows: file.num('Rows'), columns: file.num('Columns'), patientBirthDate: file.str('PatientBirthDate'), patientSex: file.str('PatientSex'),
    transferSyntax: file.transferSyntax, compressed: isCompressedSyntax(file.transferSyntax), compression: COMPRESSED_LABEL[file.transferSyntax] || null,
  };
}

/** Structural checks before an instance is accepted. Returns a list of problems. */
export function validateInstance(file) {
  const issues = [];
  const d = describe(file);
  for (const [label, uid] of [['StudyInstanceUID', d.studyUid], ['SeriesInstanceUID', d.seriesUid], ['SOPInstanceUID', d.sopUid], ['SOPClassUID', d.sopClass]]) {
    if (!isValidUid(uid)) issues.push(`${label} is missing or not a valid UID`);
  }
  if (!d.patientId) issues.push('PatientID (0010,0020) is missing');
  const meta = file.meta.get('00020003')?.value;
  if (meta && d.sopUid && meta !== d.sopUid) issues.push('SOPInstanceUID does not match the file meta header');
  for (const key of ['PixelSpacing', 'ImagerPixelSpacing']) {
    const spacing = file.values(key);
    if (spacing.length && (spacing.length !== 2 || spacing.some((v) => !(Number(v) > 0)))) issues.push(`${key} must be two positive numbers`);
  }
  const pd = file.get('PixelData');
  if (pd && pd.encapsulated && file.transferSyntax !== COMPRESSED_TS.RLE) {
    // The JPEG family is stored and indexed from the header; the browser decodes it.
    if (!pd.fragments.length) issues.push('Encapsulated pixel data has no fragments');
    if (!file.num('Rows') || !file.num('Columns')) issues.push('Rows and Columns are required');
  } else if (pd) { try { pixels(file); } catch (err) { issues.push(err.message); } }
  return issues;
}

function startedIso(d) {
  if (!/^\d{8}$/.test(d.studyDate)) return null;
  const t = (d.studyTime || '000000').padEnd(6, '0');
  const iso = `${d.studyDate.slice(0, 4)}-${d.studyDate.slice(4, 6)}-${d.studyDate.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}.000Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

export const studyUidOf = (study) => study.identifier?.find((i) => i.system === 'urn:dicom:uid')?.value?.replace('urn:oid:', '') ?? null;
export const accessionOf = (study) => study.identifier?.find((i) => i.type?.coding?.some((c) => c.code === 'ACSN'))?.value ?? '';
export const extensionOf = (doc, url) => { const e = (doc.extension || []).find((x) => x.url === url); return e ? (e.valueCode ?? e.valueDateTime ?? e.valueString ?? null) : null; };

// An open imaging order is matched to a new study of the same modality family,
// unless the study was acquired more than a day before the order was placed
// (an old study uploaded later is a prior, not the ordered exam).
async function linkOrder(tx, started, patientRef, modality, branch) {
  const orders = (await tx.query('ServiceRequest', { patient: patientRef }, { branch }))
    .filter((o) => lifecycleOf(o) === 'active' && FAMILY[o.orderDetail?.[0]?.coding?.[0]?.code] === FAMILY[modality]
      && (!started || Date.parse(started) >= Date.parse(o.authoredOn || o._recordedAt) - 86400000));
  if (!orders.length) return null;
  const taken = new Set((await tx.query('ImagingStudy', { patient: patientRef }, { branch })).flatMap((s) => (s.basedOn || []).map((b) => b.reference)));
  return orders.find((o) => !taken.has(`ServiceRequest/${o.id}`)) ?? null;
}

export const OVERRIDE_URL = 'urn:hospital-desktop:patient-override';

/**
 * Stores DICOM instances. items: [{ bytes }]. Returns one result per item:
 * { status: 'stored' | 'duplicate' | 'failed', sopUid, sopClass, reason, studyId }.
 * Files are written first; if the database transaction fails they are removed.
 * Without an override the header PatientID must equal the MRN of a registered
 * patient. override is a Patient id, or a function of the parsed header that
 * returns one (or null to fall back to MRN matching): every instance is then
 * attached to that patient whatever the header says, the file keeps its
 * PatientID, and the study records the override so the log and the
 * wrong-patient check know about it.
 */
export async function ingestInstances(store, items, ctx, { root = dicomRoot(), override = null } = {}) {
  const results = items.map(() => null);
  const parsed = [];
  items.forEach((item, i) => {
    try {
      const file = parse(item.bytes);
      const issues = validateInstance(file);
      const d = describe(file);
      if (issues.length) results[i] = { status: 'failed', sopUid: d.sopUid, sopClass: d.sopClass, reason: issues.join('; ') };
      else parsed.push({ i, d, bytes: item.bytes });
    } catch (err) {
      if (!(err instanceof DicomError)) throw err;
      results[i] = { status: 'failed', sopUid: null, sopClass: null, reason: err.message };
    }
  });
  const written = [];
  const branch = ctx.branch ?? 'main';
  try {
    await store.transaction(async (tx) => {
      const patients = await tx.query('Patient', {}, { branch });
      const studies = new Map();
      for (const { i, d, bytes } of parsed) {
        const fail = (reason) => { results[i] = { status: 'failed', sopUid: d.sopUid, sopClass: d.sopClass, reason }; };
        const chosen = typeof override === 'function' ? override(d) : override;
        const patient = chosen ? patients.find((p) => p.id === chosen) : patients.find((p) => mrnOf(p) === d.patientId);
        if (chosen && !patient) { fail(`Patient/${chosen} does not exist, so the instance cannot be attached to it`); continue; }
        if (!patient) { fail(`PatientID "${d.patientId}" does not match the MRN of any patient`); continue; }
        const id = studyResourceId(d.studyUid);
        let entry = studies.get(id);
        if (!entry) {
          const existing = await tx.get('ImagingStudy', id, { branch });
          entry = { doc: existing ? (({ _seq, ...rest }) => rest)(existing) : null, changed: false, stored: 0, override: chosen ? { patient: `Patient/${patient.id}`, headerPatientId: d.patientId } : null };
          studies.set(id, entry);
        }
        if (entry.doc && entry.doc.subject.reference !== `Patient/${patient.id}`) { fail('PatientID does not match the patient this study is already linked to'); continue; }
        if (!entry.doc) {
          const order = await linkOrder(tx, startedIso(d), `Patient/${patient.id}`, d.modality, branch);
          entry.doc = {
            resourceType: 'ImagingStudy', id, status: 'available', subject: { reference: `Patient/${patient.id}` },
            identifier: [{ system: 'urn:dicom:uid', value: `urn:oid:${d.studyUid}` }, { system: 'urn:dicom:patient-id', value: d.patientId }, ...(d.accession ? [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'ACSN' }] }, value: d.accession }] : [])],
            ...(startedIso(d) ? { started: startedIso(d) } : {}), description: d.studyDescription || order?.code?.coding?.[0]?.display || `${d.modality} study`,
            ...(order ? { basedOn: [{ reference: `ServiceRequest/${order.id}` }], reasonCode: order.reasonCode, procedureCode: [order.code] } : {}),
            referrer: { display: order?.requester?.display || d.referrer || '' }, modality: [], series: [],
            extension: [{ url: PRIORITY_URL, valueCode: order?.priority || 'routine' }, { url: RECEIVED_URL, valueDateTime: tx.now() },
              ...(chosen ? [{ url: OVERRIDE_URL, valueString: `attached to Patient/${patient.id} by ${ctx.actor.id}; header PatientID ${d.patientId}` }] : [])],
          };
        }
        const study = entry.doc;
        let series = study.series.find((s) => s.uid === d.seriesUid);
        if (series?.instance?.some((x) => x.uid === d.sopUid)) { results[i] = { status: 'duplicate', sopUid: d.sopUid, sopClass: d.sopClass, studyId: id }; continue; }
        if (!series) {
          series = { uid: d.seriesUid, number: d.seriesNumber ?? study.series.length + 1, modality: { system: DCM, code: d.modality }, description: d.seriesDescription || '', ...(d.compressed ? { extension: [{ url: 'urn:hospital-desktop:transfer-syntax', valueString: d.transferSyntax }, { url: 'urn:hospital-desktop:compression', valueString: d.compression }] } : {}), ...(d.bodyPart ? { bodySite: { display: d.bodyPart } } : {}), numberOfInstances: 0, instance: [] };
          study.series.push(series);
        }
        const target = instancePath(root, d.studyUid, d.seriesUid, d.sopUid);
        // Through the storage interface (task 21): the clinical store's root is data/, so the key is the path under it.
        await (await createObjectStore('clinical', { localRoot: root, prefix: 'dicom/' })).put(path.relative(root, target).split(path.sep).join('/'), Buffer.from(bytes));
        written.push(target);
        series.instance.push({ uid: d.sopUid, sopClass: { system: 'urn:ietf:rfc:3986', code: `urn:oid:${d.sopClass}` }, number: d.instanceNumber ?? series.instance.length + 1, title: String(d.frames) });
        series.instance.sort((a, b) => a.number - b.number);
        series.numberOfInstances = series.instance.length;
        study.series.sort((a, b) => a.number - b.number);
        study.numberOfSeries = study.series.length;
        study.numberOfInstances = study.series.reduce((n, s) => n + s.instance.length, 0);
        study.modality = [...new Set(study.series.map((s) => s.modality.code))].map((code) => ({ system: DCM, code }));
        entry.changed = true;
        entry.stored += 1;
        results[i] = { status: 'stored', sopUid: d.sopUid, sopClass: d.sopClass, studyId: id };
      }
      for (const [id, entry] of studies) {
        if (!entry.changed) continue;
        const saved = await tx.save('ImagingStudy', entry.doc, { branch, updatedBy: ctx.actor.role });
        await recordAction(tx, {
          runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: Number(saved.meta.versionId) > 1 ? 'update' : 'create', action: 'dicom.store', branch,
          args: { study: id, instances: entry.stored, ...(entry.override ? { patientOverride: entry.override.patient, headerPatientId: entry.override.headerPatientId } : {}) }, entityRef: `ImagingStudy/${id}`, versionId: saved.meta.versionId, patientRef: saved._patient,
          description: `stored ${entry.stored} DICOM instance(s) in ImagingStudy/${id}${entry.override ? ` (attached to ${entry.override.patient}, header PatientID ${entry.override.headerPatientId})` : ''}`,
        });
      }
    });
  } catch (err) {
    for (const file of written) fs.rmSync(file, { force: true });
    throw err;
  }
  return results;
}

/** Converts a parsed NIfTI volume into one DICOM file per slice. */
export function niftiToInstances(volume, { patient, modality = 'MR', description = 'NIfTI import', bodyPart = '', now = new Date() }) {
  const [nx, ny, nz] = volume.dims;
  const integer = [2, 4, 512].includes(volume.datatype);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < volume.data.length; i += 1) { const v = volume.data[i]; if (v < min) min = v; if (v > max) max = v; }
  const direct = integer && min >= -32768 && max <= 32767;
  const scale = direct ? 1 : (max - min) / 4095 || 1;
  const studyUid = generateUid();
  const seriesUid = generateUid();
  const stamp = now.toISOString();
  const date = stamp.slice(0, 10).replace(/-/g, '');
  const time = stamp.slice(11, 19).replace(/:/g, '');
  const name = patient.name?.[0] || {};
  const files = [];
  // Orientation and position from the NIfTI header, in DICOM's patient axes (left, posterior, superior). Columns follow the first
  // voxel axis; rows run against the second, as the pixels are written below; each slice sits where the header puts it.
  const A = volume.affine; const lps = (v) => [-v[0], -v[1], v[2]]; const len = (v) => Math.hypot(v[0], v[1], v[2]) || 1; const unit = (v) => v.map((x) => x / len(v)); const fx = (n) => String(Number(n.toFixed(6)));
  const axis = A ? [0, 1, 2].map((c) => lps([A[0][c], A[1][c], A[2][c]])) : null; const at = (i, j, k) => lps([0, 1, 2].map((r) => A[r][0] * i + A[r][1] * j + A[r][2] * k + A[r][3]));
  const iop = A ? [...unit(axis[0]), ...unit(axis[1].map((x) => -x))].map(fx) : ['1', '0', '0', '0', '1', '0'];
  const gap = A ? len(axis[2]) : volume.spacing[2]; const pixel = A ? [fx(len(axis[1])), fx(len(axis[0]))] : [String(volume.spacing[1]), String(volume.spacing[0])];
  for (let z = 0; z < nz; z += 1) {
    const px = new Int16Array(nx * ny);
    for (let y = 0; y < ny; y += 1) {
      const src = z * nx * ny + (ny - 1 - y) * nx;
      for (let x = 0; x < nx; x += 1) px[y * nx + x] = direct ? volume.data[src + x] : Math.round((volume.data[src + x] - min) / scale);
    }
    files.push(write({
      SOPClassUID: modality === 'CT' ? SOP_CLASS.CT : modality === 'MR' ? SOP_CLASS.MR : SOP_CLASS.SC, SOPInstanceUID: generateUid(),
      StudyDate: date, SeriesDate: date, StudyTime: time, AccessionNumber: `NII${date.slice(2)}${time}`, Modality: modality,
      StudyDescription: description, SeriesDescription: description, PatientName: name.family || '', PatientID: mrnOf(patient),
      PatientBirthDate: (patient.birthDate || '').replace(/-/g, ''), PatientSex: { male: 'M', female: 'F' }[patient.gender] || 'O', BodyPartExamined: bodyPart || undefined,
      SliceThickness: fx(gap), StudyInstanceUID: studyUid, SeriesInstanceUID: seriesUid, SeriesNumber: '1', InstanceNumber: String(z + 1),
      ImagePositionPatient: A ? at(0, ny - 1, z).map(fx) : ['0', '0', String(z * volume.spacing[2])], ImageOrientationPatient: iop, SliceLocation: A ? fx(at(0, ny - 1, z)[2]) : String(z * volume.spacing[2]),
      ImageComments: A ? 'Converted from NIfTI; orientation, position and spacing are from the NIfTI header' : 'Converted from NIfTI; the header gave no orientation',
      SamplesPerPixel: 1, PhotometricInterpretation: 'MONOCHROME2', Rows: ny, Columns: nx, PixelSpacing: pixel,
      BitsAllocated: 16, BitsStored: 16, HighBit: 15, PixelRepresentation: 1,
      RescaleIntercept: String(direct ? volume.intercept : min * volume.slope + volume.intercept), RescaleSlope: String(direct ? volume.slope : scale * volume.slope),
      PixelData: px,
    }, { transferSyntax: TS.EXPLICIT_LE }));
  }
  return files;
}
