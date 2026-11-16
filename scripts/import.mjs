// Loads local synthetic or public de-identified data into the database and data/ folder. Nothing is written to the repository.
//   npm run import -- --fhir <folder-or-file> [--fhir <more>] [--assign-mrn] [--dry-run]
//   npm run import -- --dicom <folder-or-file> [--patient <MRN> | --create-patients] [--dry-run]
//   npm run import -- --ecg <folder> (--patient <MRN> | --create-patients) [--dry-run]
//   common: --source "<name>" --licence "<text>" [--synthetic] [--restricted] --i-confirm-not-real-patient-data
//   npm run import -- --scenarios <folder>   your own scenarios: <slug>.task.json beside <slug>.json
//   npm run import -- --scribe <folder>      your own scribe cases: <name>.case.json
//   npm run import -- --hospital [--layout <file>]
// --fhir runs first, so patients exist before their images are matched by PatientID to an MRN.
// Every import writes an entry to data/datasets.json (the dataset register); the first import
// from a new --source name needs --i-confirm-not-real-patient-data. --dry-run never writes.
// The release ships no scenarios and no scribe cases: --scenarios and --scribe load the ones in the folder you name (see docs/DATA.md).
// --hospital loads (or reloads, idempotently) the bed layout from data/hospital.json, writing it from the default layout first when missing.
import fs from 'node:fs';
import path from 'node:path';
import { openStore } from '../platform/server/index.mjs';
import { importFhirPaths, listImportFiles } from '../platform/server/importer.mjs';
import { importDicomFiles, importEcgFolder, filesUnder } from '../platform/server/import-media.mjs';
import { importSlideFolder } from '../pathology/server/slides.mjs';
import { recordDataset, sourceConfirmed, fileListChecksum, relativeFiles, registerPath } from '../platform/server/datasets.mjs';
import { REPO_ROOT } from '../platform/server/db/index.mjs';

const args = process.argv.slice(2);
const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const values = (flag) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));
const dryRun = args.includes('--dry-run');
const fhir = values('--fhir');
const dicom = value('--dicom');
const ecg = value('--ecg');
const slides = value('--slides');
const actor = { kind: 'human', id: 'import-script', role: 'administrator' };
if (args.includes('--scenarios')) {
  if (!value('--scenarios') || value('--scenarios').startsWith('--')) { console.error('Name the folder that holds your scenarios: npm run import -- --scenarios <folder>'); process.exit(2); }
  process.env.SCENARIOS_DIR = path.resolve(value('--scenarios'));
  const { createRl } = await import('../agent-operations/server/cases.mjs');
  const scenarioStore = await openStore();
  try {
    const loaded = await createRl({ store: scenarioStore, agents: { hitl: null } }).loadAll(actor);
    console.log(`Scenario library: ${loaded.length} case${loaded.length === 1 ? '' : 's'} added to the case bank${loaded.length ? '' : ' (none found, or all already there)'}`);
    for (const c of loaded) console.log(`  ${c.split.padEnd(5)} ${c.title}`);
  } finally { await scenarioStore.close(); }
  process.exit(0);
}
if (args.includes('--scribe')) {
  if (!value('--scribe') || value('--scribe').startsWith('--')) { console.error('Name the folder that holds your scribe cases: npm run import -- --scribe <folder>'); process.exit(2); }
  process.env.SCRIBE_CASES_DIR = path.resolve(value('--scribe'));
  const { createScribe } = await import('../agent-operations/server/scribe.mjs');
  const scribeStore = await openStore();
  try {
    const loaded = await createScribe({ store: scribeStore, agents: null }).loadAll(actor);
    console.log(`Scribe benchmark: ${loaded.length} case${loaded.length === 1 ? '' : 's'} added${loaded.length ? '' : ' (none found, or all already there)'}`);
    for (const c of loaded) console.log(`  ${c.split.padEnd(5)} ${c.title}`);
  } finally { await scribeStore.close(); }
  process.exit(0);
}
if (args.includes('--hospital')) {
  const { readHospitalFile, writeHospitalFile, generateLocations, loadHospital, HOSPITAL_FILE } = await import('../ehr/server/beds.mjs');
  const layoutFile = value('--layout');
  let locations = layoutFile ? generateLocations(JSON.parse(fs.readFileSync(path.resolve(layoutFile), 'utf8'))) : readHospitalFile();
  if (!locations) { console.error('No hospital layout yet. Give one: npm run import -- --hospital --layout <file> (see docs/DATA.md).'); process.exit(2); }
  if (layoutFile || !fs.existsSync(HOSPITAL_FILE)) writeHospitalFile(locations);
  const hospitalStore = await openStore();
  try {
    const report = await loadHospital(hospitalStore, locations, { actor });
    console.log(`Hospital layout (${path.relative(REPO_ROOT, HOSPITAL_FILE)}): ${report.written} written, ${report.unchanged} unchanged of ${report.total} locations`);
  } finally { await hospitalStore.close(); }
  process.exit(0);
}
// ---------- Reference data for the insurance environment (docs/PAYER.md section 3) ----------
if (value('--payer-reference')) {
  const { importReferenceFolder } = await import('../insurance-and-billing/server/import-reference.mjs'); const { referenceStatus, referenceFile, closeReference } = await import('../insurance-and-billing/server/reference.mjs');
  const folder = path.resolve(value('--payer-reference')); if (!fs.existsSync(folder)) { console.error(`No such folder or file: ${folder}`); process.exit(2); }
  const list = (flag) => (value(flag) ? value(flag).split(',').map((x) => x.trim()).filter(Boolean) : null);
  console.log(`Reference data for the insurance environment, from ${folder}`);
  const results = await importReferenceFolder(folder, { dryRun, source: value('--source') || undefined, ratesNpi: list('--rates-npi'), ratesCodes: list('--rates-codes'), npiStates: list('--npi-state'), hospital: value('--hospital') || undefined });
  for (const r of results) console.log(`  ${r.skipped ? 'skipped ' : 'imported'}  ${r.file}${r.kind ? `  [${r.kind}]` : ''}${r.skipped ? `: ${r.skipped}` : `: ${r.rows} rows, release ${r.release}${r.note ? ` (${r.note})` : ''}`}`);
  const done = results.filter((r) => !r.skipped);
  if (!dryRun && done.length) { const { recordDataset, fileListChecksum } = await import('../platform/server/datasets.mjs'); const entry = recordDataset({ kind: 'payer-reference', source: value('--source') ?? path.basename(folder), licence: value('--licence') ?? null, files: done.length, checksum: fileListChecksum(done.map((r) => `${r.file}:${r.rows}`)) }); console.log(`  register: ${entry.id}`); }
  const st = referenceStatus(); console.log(`In ${path.relative(process.cwd(), referenceFile())}: ${st.releases.length} file(s) imported.${st.missing.length ? ` Still needed: ${st.missing.map((m) => m.label).join('; ')}.` : ' Every needed set is present.'}`);
  closeReference(); process.exit(0);
}
if (!fhir.length && !dicom && !ecg && !slides) {
  console.error('Usage: npm run import -- --fhir <folder-or-file> [--dicom <folder-or-file>] [--ecg <folder>] [--dry-run] [--source "<name>" --licence "<text>"] [--synthetic] [--restricted] --i-confirm-not-real-patient-data');
  process.exit(2);
}
if (value('--patient') && args.includes('--create-patients')) { console.error('--patient and --create-patients cannot be combined'); process.exit(2); }

// ---------- Guard ----------
console.log('Reminder: only synthetic or public de-identified data may be loaded. Never import real patient data.');
const firstTarget = fhir[0] ?? dicom ?? ecg ?? slides;
const source = value('--source') ?? path.basename(path.resolve(firstTarget));
const licence = value('--licence') ?? null;
const synthetic = args.includes('--synthetic');
const restricted = args.includes('--restricted');
if (!dryRun && !sourceConfirmed(source) && !args.includes('--i-confirm-not-real-patient-data')) {
  console.error(`Source "${source}" has not been imported before. Add --i-confirm-not-real-patient-data to confirm that it contains no real patient data (the confirmation is remembered in ${path.relative(REPO_ROOT, registerPath())}).`);
  process.exit(2);
}
const tags = { synthetic, restricted, source };
const register = (kind, targets, files, patients) => {
  if (dryRun) return;
  const entry = recordDataset({ kind, source, licence, files: files.length, checksum: fileListChecksum(relativeFiles(targets, files)), synthetic, restricted, patients });
  console.log(`  register: ${entry.id} (${entry.source}${entry.licence ? `, ${entry.licence}` : ''}${entry.synthetic ? ', synthetic' : ''}${entry.restricted ? ', restricted' : ''}) in ${path.relative(REPO_ROOT, registerPath())}`);
};
const list = (problems) => {
  for (const line of problems.slice(0, 20)) console.log(`    ${line}`);
  if (problems.length > 20) console.log(`    ... ${problems.length - 20} more`);
};

// ---------- DICOM ----------
// Every file is parsed and validated; a file that is not DICOM, fails validation, or (without --patient or
// --create-patients) names a PatientID that matches no MRN is reported and skipped. Safe to run again.
async function importDicom(store) {
  const t = await importDicomFiles(store, dicom, { dryRun, patient: value('--patient'), createPatients: args.includes('--create-patients'), tags, actor });
  console.log(`${dryRun ? 'Dry run (DICOM)' : 'DICOM import'}: ${t.files} files`);
  console.log(`  ${dryRun ? 'valid' : 'stored'}: ${t.stored} in ${t.studies.size} ${t.studies.size === 1 ? 'study' : 'studies'}`);
  if (!dryRun) console.log(`  already archived (skipped): ${t.duplicate}`);
  if (t.created || t.reused) console.log(`  patients ${dryRun ? 'to create' : 'created'}: ${t.created}${t.reused ? `, reused from an earlier run: ${t.reused}` : ''}`);
  console.log(`  failed: ${t.failed}`);
  list(t.problems);
  register('dicom', [dicom], filesUnder(path.resolve(dicom)), t.patients);
  return t.failed;
}

// ---------- ECG ----------
async function importEcg(store) {
  const t = await importEcgFolder(store, ecg, { dryRun, patient: value('--patient'), createPatients: args.includes('--create-patients'), tags, actor });
  console.log(`${dryRun ? 'Dry run (ECG)' : 'ECG import'}: ${t.records} WFDB records`);
  console.log(`  ${dryRun ? 'would write' : 'written'}: ${t.written}`);
  console.log(`  unchanged (skipped): ${t.unchanged}`);
  if (t.created || t.reused) console.log(`  patients ${dryRun ? 'to create' : 'created'}: ${t.created}${t.reused ? `, reused from an earlier run: ${t.reused}` : ''}`);
  if (t.truncated) console.log(`  truncated to 12 leads / 30 seconds: ${t.truncated}`);
  console.log(`  failed (format or file problems): ${t.failed}`);
  list(t.problems);
  register('ecg', [ecg], filesUnder(path.resolve(ecg)), t.patients);
  return t.failed;
}

// ---------- Slides ----------
// Whole-slide images: JPEG-tiled pyramidal TIFF (.svs, .tif, .tiff) or DICOM whole-slide sets. Files are copied to data/slides; tiles are never decoded.
async function importSlides(store) {
  const t = await importSlideFolder(store, slides, { dryRun, patient: value('--patient'), createPatients: args.includes('--create-patients'), tags, actor });
  console.log(`${dryRun ? 'Dry run (slides)' : 'Slide import'}: ${t.files} files`);
  console.log(`  ${dryRun ? 'readable' : 'stored'}: ${t.stored} slide${t.stored === 1 ? '' : 's'}`);
  if (!dryRun) console.log(`  already stored (skipped): ${t.duplicate}`);
  console.log(`  refused (format): ${t.refused.length}`);
  for (const r of t.refused.slice(0, 20)) console.log(`    ${r.file}: ${r.reasons.join('; ')}`);
  if (t.wrongPatient.length) console.log(`  slide metadata naming a different patient: ${t.wrongPatient.length}`);
  if (t.created || t.reused) console.log(`  patients ${dryRun ? 'to create' : 'created'}: ${t.created}${t.reused ? `, reused from an earlier run: ${t.reused}` : ''}`);
  console.log(`  failed: ${t.failed}`);
  list(t.problems);
  register('slides', [slides], filesUnder(path.resolve(slides)), t.patients);
  return t.failed + t.refused.length;
}

// ---------- FHIR ----------
async function importFhir(store) {
  const targets = fhir.map((f) => path.resolve(f));
  const report = await importFhirPaths(store, targets, {
    dryRun, quarantineDir: path.join(REPO_ROOT, 'data', 'quarantine'), actor, assignMrn: args.includes('--assign-mrn'), synthetic, restricted, source,
    onProgress: ({ done, total }) => { if (done % 10 === 0 || done === total) console.log(`  ${done}/${total} files`); },
  });
  console.log(`${dryRun ? 'Dry run' : 'Import'}: ${report.files} files, ${report.seen} resources seen`);
  console.log(`  ${dryRun ? 'would write' : 'written'}: ${report.written}`);
  console.log(`  unchanged (skipped): ${report.unchanged}`);
  console.log(`  unsupported type (skipped): ${report.unsupported}`);
  console.log(`  quarantined: ${report.quarantined}`);
  console.log(`  patients: ${report.patients.length}${args.includes('--assign-mrn') ? `, MRNs assigned: ${report.mrnsAssigned}` : ''}`);
  console.log(`  conditional references: ${report.referencesResolved} resolved, ${report.referencesDropped} dropped (display kept)`);
  console.log('  per type (seen / written / unchanged / unsupported / quarantined):');
  for (const [type, c] of Object.entries(report.byType).sort()) console.log(`    ${type.padEnd(24)} ${c.seen} / ${c.written} / ${c.unchanged} / ${c.unsupported} / ${c.quarantined}`);
  list(report.errors.map((e) => `${e.ref ?? path.basename(e.file)}: ${e.reason}`));
  if (report.quarantineFile) console.log(`  quarantine file: ${path.relative(REPO_ROOT, report.quarantineFile)}`);
  register('fhir', targets, listImportFiles(targets), report.patients);
  return report.quarantined;
}

const store = await openStore();
try {
  let failed = 0;
  if (fhir.length) failed += await importFhir(store);
  if (dicom) failed += await importDicom(store);
  if (ecg) failed += await importEcg(store);
  if (slides) failed += await importSlides(store);
  process.exitCode = failed ? 3 : 0;
} catch (err) {
  console.error(`Import stopped: ${err.message}`);
  process.exitCode = 2;
} finally {
  await store.close();
}
