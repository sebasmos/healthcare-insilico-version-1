// Loads images and recordings you already have on this machine. Nothing is downloaded and nothing is committed:
// files are read where they are and written under data/. Patients are known by number only.
//   node scripts/load-local-media.mjs --mimic <folder> [--reports <folder>] [--max 20] [--dry-run]
//       chest X-rays (DICOM under p<subject_id>/s<study_id>/) and ECGs (WFDB .hea and .dat) for patients already loaded
//   node scripts/load-local-media.mjs --cxr-reports <folder> [--dry-run]   official MIMIC-CXR reports (p<subject_id>/s<study_id>.txt) for chest X-rays already loaded
//   node scripts/load-local-media.mjs --ecg-measurements <machine_measurements.csv> [--dry-run]   the device's statements and measurements for ECGs already loaded
//   node scripts/load-local-media.mjs --ctpa <folder> [--dry-run]      one new patient and one CT study per .nii.gz
//   node scripts/load-local-media.mjs --slide <file.svs> [--dry-run]   one new patient with the whole-slide image
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { openStore } from '../platform/server/index.mjs';
import { importDicomFiles, importEcgFolder, filesUnder, SOURCE_ID_URL } from '../platform/server/import-media.mjs';
import { importSlideFolder } from '../pathology/server/slides.mjs';
import { ingestInstances, niftiToInstances, parseNifti } from '../pacs/server/dicom.mjs';
import { recordDataset, fileListChecksum, tagPatient } from '../platform/server/datasets.mjs';
import { assignHouseMrn, mrnOf } from '../ehr/server/clinical-rules.mjs';
import { recordAction } from '../platform/server/audit.mjs';
import { isEcgObservation, isEcgMachineReport, machineMeasurements, withMachine, machineReport } from '../ecg/server/ecg.mjs';
import { accessionOf } from '../pacs/server/dicom.mjs';

const args = process.argv.slice(2); const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const dryRun = args.includes('--dry-run'); const max = Number(value('--max')) || 20; const actor = { kind: 'human', id: 'import-script', role: 'administrator' };
const home = (p) => (p ? path.resolve(p.replace(/^~(?=\/)/, process.env.HOME || '')) : null);
const store = await openStore();
const patients = await store.query('Patient', {}, { branch: 'main' });
const number = (p) => `Patient ${mrnOf(p)}`;
const register = (kind, source, licence, files, ids) => recordDataset({ kind, source, licence, files: files.length, checksum: fileListChecksum(files.map((f) => path.basename(f))), synthetic: false, restricted: true, patients: ids });
/** The encounter of this patient that starts nearest to a date. */
async function nearestEncounter(patientId, when) {
  const t = Date.parse(when); if (Number.isNaN(t)) return null; let best = null;
  for (const e of await store.query('Encounter', { patient: `Patient/${patientId}` }, { branch: 'main' })) { const s = Date.parse(e.period?.start || ''); if (Number.isNaN(s)) continue; const d = Math.abs(s - t); if (!best || d < best.d) best = { id: e.id, d, start: e.period.start }; }
  return best;
}
// MIMIC dates are shifted into the future, and a recording is filed at its own time: a later change to it keeps that time, because a version cannot be filed before the one it follows.
const when = (cur) => (cur?._recordedAt && cur._recordedAt > new Date().toISOString() ? { recordedAt: cur._recordedAt } : {});
const link = async (type, id, enc) => { const cur = await store.get(type, id, { branch: 'main' }); if (!cur || !enc || cur.encounter?.reference === `Encounter/${enc.id}`) return; const { _seq, meta, ...doc } = cur; await store.save(type, { ...doc, encounter: { reference: `Encounter/${enc.id}` } }, { branch: 'main', updatedBy: 'import', ...when(cur) }); };
async function newPatient(source, fileId) {
  const have = patients.find((p) => (p.identifier || []).some((i) => i.system === SOURCE_ID_URL && i.value === fileId)); if (have) return { patient: have, made: false };
  if (dryRun) return { patient: null, made: true };
  const saved = await store.transaction(async (tx) => { const doc = await assignHouseMrn(tx, tagPatient({ resourceType: 'Patient', identifier: [{ system: SOURCE_ID_URL, value: fileId }] }, { restricted: true, source }), 'main'); const p = await tx.save('Patient', { ...doc, _import: { source, sourceId: fileId } }, { branch: 'main', updatedBy: 'import' }); await recordAction(tx, { actor, kind: 'create', action: 'import.patient', args: { patient: p.id, mrn: mrnOf(p), sourceId: fileId, source }, entityRef: `Patient/${p.id}`, versionId: p.meta.versionId, patientRef: `Patient/${p.id}`, description: `registered ${mrnOf(p)} for ${source} file ${fileId}` }); return p; });
  patients.push(saved); return { patient: saved, made: true };
}

// ---------- MIMIC chest X-rays and ECGs for patients already loaded ----------
if (value('--mimic')) {
  const root = home(value('--mimic')); const reports = home(value('--reports')) && fs.existsSync(home(value('--reports'))) ? home(value('--reports')) : null; const bySubject = new Map();
  for (const p of patients) for (const i of p.identifier || []) if (/mimic/i.test(i.system || '') && /^\d{8}$/.test(i.value || '')) bySubject.set(i.value, p);
  const all = filesUnder(root); const subjectOf = (f) => /\/p(\d{8})\//.exec(f)?.[1] ?? null; const studyOf = (f) => /\/s(\d+)\//.exec(f)?.[1] ?? null;
  const dcm = all.filter((f) => /\.dcm$/i.test(f)); const hea = all.filter((f) => /\.hea$/i.test(f));
  const group = (files) => { const m = new Map(); for (const f of files) { const s = subjectOf(f); if (!s || !bySubject.has(s)) continue; const k = `${s}/${studyOf(f) ?? path.basename(f, path.extname(f))}`; if (!m.has(k)) m.set(k, { subject: s, study: studyOf(f), dir: path.dirname(f), files: [] }); m.get(k).files.push(f); } return [...m.values()]; };
  // One per patient first, then more for the same patients, up to the limit.
  const choose = (groups) => { const first = []; const rest = []; const seen = new Set(); for (const g of groups) { if (seen.has(g.subject)) rest.push(g); else { seen.add(g.subject); first.push(g); } } return [...first, ...rest].slice(0, max); };
  const xr = group(dcm); const ecg = group(hea); const xrPick = choose(xr); const ecgPick = choose(ecg);
  console.log(`MIMIC folder: ${root}`);
  console.log(`  ${patients.length} patients are loaded; ${bySubject.size} carry a MIMIC subject id.`);
  console.log(`  Chest X-rays: ${dcm.length} DICOM files on disk; ${xr.reduce((n, g) => n + g.files.length, 0)} files in ${xr.length} studies belong to ${new Set(xr.map((g) => g.subject)).size} loaded patients; ${dcm.filter((f) => !bySubject.has(subjectOf(f))).length} files belong to nobody loaded.`);
  console.log(`  ECGs: ${hea.length} WFDB records on disk; ${ecg.length} belong to ${new Set(ecg.map((g) => g.subject)).size} loaded patients.`);
  console.log(`  Reports folder: ${reports && fs.existsSync(reports) ? reports : 'none found'}`);
  console.log(`  To load (limit ${max} each): ${xrPick.length} X-ray studies (${xrPick.reduce((n, g) => n + g.files.length, 0)} files), ${ecgPick.length} ECGs.`);
  if (!dryRun) {
    const xrPatients = new Set(); const ecgPatients = new Set();
    for (const g of xrPick) { const p = bySubject.get(g.subject); const t = await importDicomFiles(store, g.dir, { patient: mrnOf(p), tags: { restricted: true, source: 'MIMIC-CXR' }, actor });
      for (const line of t.problems) console.log(`    problem: ${line}`); if (!t.stored && !t.duplicate) continue; xrPatients.add(p.id);
      for (const sid of t.studies) { const st = await store.get('ImagingStudy', sid, { branch: 'main' }); const enc = await nearestEncounter(p.id, st?.started); await link('ImagingStudy', sid, enc);
        const txt = reports && g.study ? filesUnder(reports).find((f) => path.basename(f) === `s${g.study}.txt`) : null;
        if (txt && !(await store.query('DiagnosticReport', { patient: `Patient/${p.id}` }, { branch: 'main' })).some((r) => (r.imagingStudy || []).some((x) => x.reference === `ImagingStudy/${sid}`))) await store.save('DiagnosticReport', { resourceType: 'DiagnosticReport', status: 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'RAD' }] }], code: { text: 'Chest radiograph report' }, subject: { reference: `Patient/${p.id}` }, ...(enc ? { encounter: { reference: `Encounter/${enc.id}` } } : {}), effectiveDateTime: st?.started, issued: st?.started, imagingStudy: [{ reference: `ImagingStudy/${sid}` }], conclusion: fs.readFileSync(txt, 'utf8').trim().slice(0, 20000) }, { branch: 'main', updatedBy: 'import' });
        console.log(`  X-ray: ${number(p)} (subject ${g.subject}), study s${g.study}, ${t.stored} stored${t.duplicate ? `, ${t.duplicate} already there` : ''}, taken ${st?.started?.slice(0, 10) ?? 'unknown'}, encounter ${enc ? `starting ${enc.start.slice(0, 10)}` : 'none'}${txt ? ', report attached' : ''}`); } }
    for (const g of ecgPick) { const p = bySubject.get(g.subject); const t = await importEcgFolder(store, g.dir, { patient: mrnOf(p), tags: { restricted: true, source: 'MIMIC-IV-ECG' }, actor }); for (const line of t.problems) console.log(`    problem: ${line}`); if (!t.written && !t.unchanged) continue; ecgPatients.add(p.id);
      for (const ob of await store.query('Observation', { patient: `Patient/${p.id}`, where: (o) => isEcgObservation(o) && !o.encounter }, { branch: 'main' })) await link('Observation', ob.id, await nearestEncounter(p.id, ob.effectiveDateTime));
      console.log(`  ECG: ${number(p)} (subject ${g.subject}), ${t.written} written`); }
    if (xrPatients.size) register('dicom', 'MIMIC-CXR', 'PhysioNet credentialed access', xrPick.flatMap((g) => g.files), [...xrPatients]);
    if (ecgPatients.size) register('ecg', 'MIMIC-IV-ECG', 'PhysioNet open access (ODbL)', ecgPick.flatMap((g) => g.files), [...ecgPatients]);
    const row = (ids) => patients.filter((p) => ids.has(p.id)).map(number).join(', ') || 'none';
    console.log(`  Now with an X-ray: ${row(xrPatients)}`); console.log(`  Now with an ECG: ${row(ecgPatients)}`); console.log(`  With both: ${row(new Set([...xrPatients].filter((x) => ecgPatients.has(x))))}`);
  }
}

// ---------- official reports for the MIMIC chest X-rays already loaded ----------
/** Splits a MIMIC-CXR report into its headed sections. Text before the first heading, and "FINAL REPORT", are left out of the sections. */
export function splitReport(text) {
  const out = {}; let key = null; for (const line of String(text).replace(/\r/g, '').split('\n')) { const m = /^\s*([A-Z][A-Z ,/()-]{2,40}):\s*(.*)$/.exec(line); if (m) { key = m[1].trim(); out[key] = (out[key] ? `${out[key]}\n` : '') + m[2]; } else if (key) out[key] += `\n${line}`; }
  const tidy = (s) => String(s || '').split('\n').map((x) => x.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim(); const pick = (...names) => tidy(names.map((n) => out[n]).filter(Boolean).join('\n\n'));
  return { findings: pick('FINDINGS'), impression: pick('IMPRESSION', 'CONCLUSION'), technique: pick('EXAMINATION', 'EXAM', 'TECHNIQUE'), indication: pick('INDICATION', 'HISTORY', 'CLINICAL HISTORY'), comparison: pick('COMPARISON'), full: tidy(text) };
}
const mimicSubject = (p) => (p.identifier || []).find((i) => /mimic/i.test(i.system || '') && /^\d{8}$/.test(i.value || ''))?.value ?? null;
if (value('--cxr-reports')) {
  const root = home(value('--cxr-reports')); if (!fs.existsSync(root)) { console.log(`Reports folder not found: ${root}`); } else {
    const index = new Map(); for (const f of filesUnder(root)) { const m = /\/p(\d{8})\/s(\d+)\.txt$/.exec(f); if (m) index.set(`${m[1]}/${m[2]}`, f); }
    const studies = (await store.query('ImagingStudy', {}, { branch: 'main' })).filter((s) => (s.modality || []).some((m) => ['DX', 'CR', 'XR'].includes(m.code))); let attached = 0; let had = 0; const missing = [];
    console.log(`Reports folder: ${root}: ${index.size} report files. Chest X-ray studies loaded: ${studies.length}.`);
    for (const st of studies) { const pid = st.subject.reference.split('/')[1]; const p = patients.find((x) => x.id === pid); const subject = p && mimicSubject(p); const study = accessionOf(st); const file = subject ? index.get(`${subject}/${study}`) : null;
      if (!file) { missing.push(`${p ? number(p) : pid} study s${study}`); continue; }
      const existing = (await store.query('DiagnosticReport', { patient: `Patient/${pid}` }, { branch: 'main' })).find((r) => (r.imagingStudy || []).some((x) => x.reference === `ImagingStudy/${st.id}`)); if (existing) { had += 1; continue; }
      const s = splitReport(fs.readFileSync(file, 'utf8')); const split = Boolean(s.findings || s.impression);
      if (!dryRun) await store.transaction(async (tx) => { const saved = await tx.save('DiagnosticReport', { resourceType: 'DiagnosticReport', status: 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'RAD', display: 'Radiology' }] }], code: { coding: [{ system: 'http://loinc.org', code: '18748-4', display: 'Diagnostic imaging study' }], text: st.description || 'Chest radiograph' }, subject: st.subject, ...(st.encounter ? { encounter: st.encounter } : {}), effectiveDateTime: st.started, issued: st.started, imagingStudy: [{ reference: `ImagingStudy/${st.id}` }], resultsInterpreter: [{ display: 'MIMIC-CXR report (de-identified)' }], conclusion: s.impression, extension: [{ url: 'urn:hospital-desktop:report-findings', valueString: split ? s.findings : s.full }, { url: 'urn:hospital-desktop:report-technique', valueString: [s.technique, s.indication && `Indication: ${s.indication}`, s.comparison && `Comparison: ${s.comparison}`].filter(Boolean).join('\n') }], presentedForm: [{ contentType: 'text/plain', data: Buffer.from(s.full).toString('base64'), title: 'Report as issued' }] }, { branch: 'main', updatedBy: 'import' }); await recordAction(tx, { actor, kind: 'create', action: 'import.report', args: { report: saved.id, study: st.id, source: 'MIMIC-CXR' }, entityRef: `DiagnosticReport/${saved.id}`, versionId: saved.meta.versionId, patientRef: st.subject.reference, description: `attached the MIMIC-CXR report for study s${study}` }); });
      attached += 1; console.log(`  ${number(p)} study s${study}: report ${dryRun ? 'would be attached' : 'attached'} (${[s.findings && 'Findings', s.impression && 'Impression'].filter(Boolean).join(' and ') || 'no headed sections: whole text kept under Findings'})`); }
    console.log(`  ${dryRun ? 'Would attach' : 'Attached'}: ${attached}. Already had a report: ${had}. No report file found for: ${missing.length ? missing.join('; ') : 'none'}.`);
  }
}

// ---------- the device's statements and measurements for the MIMIC ECGs already loaded ----------
if (value('--ecg-measurements')) {
  const file = home(value('--ecg-measurements')); const ecgs = (await store.query('Observation', { where: isEcgObservation }, { branch: 'main' })).filter((o) => /^wfdb:\d+$/.test((o.extension || []).find((x) => x.url === 'urn:hospital-desktop:ecg-source')?.valueString || ''));
  console.log(`ECGs loaded from WFDB records: ${ecgs.length}. Measurements file: ${fs.existsSync(file) ? file : 'not found'}`);
  if (ecgs.length && fs.existsSync(file)) {
    const want = new Map(ecgs.map((o) => [(o.extension.find((x) => x.url === 'urn:hospital-desktop:ecg-source').valueString).slice(5), o])); const readline = await import('node:readline'); let cols = null; let done = 0;
    const cells = (line) => { const out = []; let cur = ''; let q = false; for (let i = 0; i < line.length; i += 1) { const ch = line[i]; if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
    for await (const line of readline.createInterface({ input: fs.createReadStream(file) })) { if (!cols) { cols = cells(line); continue; } const c = cells(line); const row = Object.fromEntries(cols.map((k, i) => [k, c[i] ?? ''])); const o = want.get(row.study_id); if (!o) continue;
      const statements = cols.filter((k) => /^report_\d+$/.test(k)).sort((x, y) => Number(x.slice(7)) - Number(y.slice(7))).map((k) => row[k].trim()).filter(Boolean); const values = machineMeasurements(row);
      if (!dryRun) await store.transaction(async (tx) => { const { _seq, meta, ...cur } = await tx.get('Observation', o.id, { branch: 'main' }); const saved = await tx.save('Observation', withMachine(cur, values, statements), { branch: 'main', updatedBy: 'import', ...when(cur) }); const existing = (await tx.query('DiagnosticReport', { patient: saved._patient, where: (r) => isEcgMachineReport(r) && (r.result || []).some((x) => x.reference === `Observation/${o.id}`) }, { branch: 'main' }))[0]; const prev = existing ? (({ _seq: s2, meta: m2, ...d }) => d)(existing) : null; await tx.save('DiagnosticReport', machineReport({ existing: prev, observation: saved, statements, source: 'MIMIC-IV-ECG machine measurements', now: tx.now() }), { branch: 'main', updatedBy: 'import' }); });
      done += 1; console.log(`  record ${row.study_id}: ${statements.length} statements, ${Object.keys(values).length} measurements ${dryRun ? 'would be attached' : 'attached'}`); }
    console.log(`  ${dryRun ? 'Would attach' : 'Attached'} to ${done} of ${ecgs.length} ECGs.`);
  }
}

// ---------- CT pulmonary angiograms from NIfTI: one new patient and one CT study each ----------
if (value('--ctpa')) {
  const dir = home(value('--ctpa')); const files = fs.readdirSync(dir).filter((f) => /\.nii(\.gz)?$/i.test(f)).sort(); const ids = [];
  console.log(`CT folder: ${dir}: ${files.length} NIfTI files`);
  for (const f of files) {
    const fileId = f.replace(/\.nii(\.gz)?$/i, ''); const { patient, made } = await newPatient('INSPECT CTPA', fileId);
    if (dryRun) { console.log(`  ${f}: ${made ? 'a new patient would be made' : `already loaded as ${number(patient)}`}`); continue; }
    ids.push(patient.id);
    const had = (await store.query('ImagingStudy', { patient: `Patient/${patient.id}` }, { branch: 'main' })).find((s) => (s.modality || []).some((m) => m.code === 'CT'));
    if (had) { console.log(`  ${f}: ${number(patient)} already has this CT (${had.numberOfInstances ?? '?'} images)`); continue; }
    const raw = fs.readFileSync(path.join(dir, f)); const volume = parseNifti(new Uint8Array(/\.gz$/i.test(f) ? zlib.gunzipSync(raw) : raw));
    const instances = niftiToInstances(volume, { patient, modality: 'CT', description: 'CT pulmonary angiogram', bodyPart: 'CHEST' }); let stored = 0; let study = null; const problems = new Set();
    for (let i = 0; i < instances.length; i += 64) { const res = await ingestInstances(store, instances.slice(i, i + 64).map((bytes) => ({ bytes })), { actor, branch: 'main', runId: null }, { override: () => patient.id }); for (const r of res) { if (r.status === 'failed') problems.add(r.reason); else { stored += 1; study = r.studyId; } } }
    console.log(`  ${f}: ${number(patient)}, ${volume.dims.join(' x ')} voxels, ${volume.spacing.map((x) => Number(x.toFixed(3))).join(' x ')} mm, ${stored} images stored${study ? ` (study ${study})` : ''}${problems.size ? `; problems: ${[...problems].join('; ')}` : ''}`);
  }
  if (!dryRun && ids.length) register('dicom', 'INSPECT CTPA', 'As licensed to you by the INSPECT dataset; local use only', files, ids);
}

// ---------- one whole-slide image for a new patient ----------
if (value('--slide')) {
  const file = home(value('--slide')); const fileId = path.basename(file).replace(/\.[^.]+$/, ''); const { patient, made } = await newPatient('Pathology slide (local)', fileId);
  if (dryRun) console.log(`Slide ${path.basename(file)}: ${made ? 'a new patient would be made' : `already loaded as ${number(patient)}`}`);
  else { const t = await importSlideFolder(store, file, { patient: mrnOf(patient), tags: { restricted: true, source: 'Pathology slide (local)' }, actor }); for (const line of t.problems) console.log(`    problem: ${line}`);
    console.log(`Slide ${path.basename(file)}: ${number(patient)}, ${t.stored} stored, ${t.duplicate} already there, ${t.failed} failed${t.studies.size ? ` (study ${[...t.studies][0]})` : ''}`);
    if (t.stored || t.duplicate) register('dicom', 'Pathology slide (local)', 'Local use only', [file], [patient.id]); }
}
await store.close();
