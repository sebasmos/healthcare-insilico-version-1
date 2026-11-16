import test from 'node:test';
const sqliteOnlyImport = { skip: process.env.TEST_BACKEND === 'postgres' };
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openTestStore, tempDir, BACKEND } from './support/helpers.mjs';
import { importFhirPaths } from '../platform/server/importer.mjs';
import { ensureLiveRun } from '../platform/server/audit.mjs';

// Synthetic input is generated here at test time; nothing is stored in the repo.
function writeInput() {
  const dir = tempDir('hd-import-');
  const bundle = {
    resourceType: 'Bundle', type: 'transaction',
    entry: [
      { fullUrl: 'urn:uuid:11111111-1111-4111-8111-111111111111', resource: { resourceType: 'Patient', name: [{ family: 'Synthetic', given: ['One'] }], birthDate: '1960-05-05' } },
      { fullUrl: 'urn:uuid:22222222-2222-4222-8222-222222222222', resource: {
        resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
        subject: { reference: 'urn:uuid:11111111-1111-4111-8111-111111111111' }, effectiveDateTime: '2024-03-01T10:00:00Z', valueQuantity: { value: 72, unit: '/min' },
      } },
      { fullUrl: 'urn:uuid:33333333-3333-4333-8333-333333333333', resource: { resourceType: 'ExplanationOfBenefit', status: 'active' } },
    ],
  };
  fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify(bundle));
  fs.writeFileSync(path.join(dir, 'more.ndjson'), [
    JSON.stringify({ resourceType: 'Condition', id: 'cond-1', subject: { reference: 'Patient/11111111-1111-4111-8111-111111111111' }, code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'I10' }] }, onsetDateTime: '2020-01-01' }),
    JSON.stringify({ resourceType: 'Observation', id: 'bad-1', subject: { reference: 'Patient/11111111-1111-4111-8111-111111111111' } }),
    JSON.stringify({ resourceType: 'Condition', id: 'orphan-1', subject: { reference: 'Patient/nobody' } }),
    '{ not json',
  ].join('\n'));
  return dir;
}

test(`[${BACKEND}] import: writes valid resources, rewrites references, quarantines bad ones`, async () => {
  const { store } = await openTestStore();
  await ensureLiveRun(store);
  const dir = writeInput();
  const quarantineDir = path.join(dir, 'q');
  const report = await importFhirPaths(store, [dir], { quarantineDir });
  assert.equal(report.files, 2);
  assert.equal(report.written, 3);
  assert.equal(report.unsupported, 1);
  assert.equal(report.quarantined, 3);
  assert.deepEqual(report.errors.map((e) => e.reason.split(' ')[0]).sort(), ['Observation.status', 'line', 'unresolved']);
  assert.equal(fs.readFileSync(report.quarantineFile, 'utf8').trim().split('\n').length, 3);

  const obs = await store.get('Observation', '22222222-2222-4222-8222-222222222222');
  assert.equal(obs.subject.reference, 'Patient/11111111-1111-4111-8111-111111111111');
  assert.equal(obs._recordedAt, '2024-03-01T10:00:00.000Z', 'recorded at its clinical time so time travel works on imported data');
  assert.equal(await store.get('Observation', obs.id, { asOf: '2024-02-29T00:00:00Z' }), null);
  assert.equal((await store.everything('Patient/11111111-1111-4111-8111-111111111111')).filter((r) => r.resourceType !== 'AuditEvent').length, 3);
  assert.equal((await store.query('TraceStep')).filter((t) => t.did.type === 'import.fhir').length, 2);
  await store.close();
});

test(`[${BACKEND}] import: re-running is a no-op; a changed resource gets a new version`, async () => {
  const { store } = await openTestStore();
  await ensureLiveRun(store);
  const dir = writeInput();
  await importFhirPaths(store, [dir], {});
  const before = await store.stats();
  const second = await importFhirPaths(store, [dir], {});
  assert.equal(second.written, 0);
  assert.equal(second.unchanged, 3);
  assert.deepEqual(await store.stats(), before);

  const file = path.join(dir, 'more.ndjson');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"I10"', '"I11.9"'));
  const third = await importFhirPaths(store, [dir], {});
  assert.equal(third.written, 1);
  assert.equal((await store.history('Condition', 'cond-1')).length, 2);
  await store.close();
});

test(`[${BACKEND}] import: dry run validates and reports but writes nothing`, async () => {
  const { store } = await openTestStore();
  await ensureLiveRun(store);
  const before = await store.stats();
  const dir = writeInput();
  const report = await importFhirPaths(store, [dir], { dryRun: true, quarantineDir: path.join(dir, 'q') });
  assert.equal(report.written, 3);
  assert.equal(report.quarantined, 3);
  assert.equal(report.dryRun, true);
  assert.deepEqual(await store.stats(), before);
  assert.equal(fs.existsSync(path.join(dir, 'q')), false);
  await store.close();
});

test('npm run import -- --fhir ... --dicom ...: patients first, then their images; safe to run twice; bad files are reported', sqliteOnlyImport, async () => {
  const { execFileSync } = await import('node:child_process');
  const { buildPhantom } = await import('./support/phantom.mjs');
  const { REPO_ROOT } = await import('../platform/server/db/index.mjs');
  const dir = tempDir('hd-import-dicom-');
  const env = { ...process.env, DB_BACKEND: 'sqlite', SQLITE_FILE: path.join(dir, 'app.sqlite'), DICOM_DIR: path.join(dir, 'dicom'), DATASETS_FILE: path.join(dir, 'datasets.json') };
  // The first import from a new source needs the confirmation flag (tested on its own in tests/import-datasets.mjs).
  const run = (...args) => { try { return { code: 0, out: execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'import.mjs'), ...args, '--i-confirm-not-real-patient-data'], { env, encoding: 'utf8' }) }; } catch (err) { return { code: err.status, out: `${err.stdout}${err.stderr}` }; } };
  const fhirFile = path.join(dir, 'patient.json');
  fs.writeFileSync(fhirFile, JSON.stringify({ resourceType: 'Patient', id: '22222222-2222-4222-8222-222222222222', name: [{ family: 'Zzimport', given: ['Synthetic'] }], gender: 'female', birthDate: '1970-01-01',
    identifier: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] }, system: 'urn:hospital-desktop:mrn', value: 'N424242' }] }));
  const images = path.join(dir, 'images');
  const files = buildPhantom({ mrn: 'N424242', name: 'Zzimport^Synthetic' });
  for (const f of files) { fs.mkdirSync(path.join(images, f.folder), { recursive: true }); fs.writeFileSync(path.join(images, f.folder, f.name), f.bytes); }
  fs.writeFileSync(path.join(images, 'readme.txt'), 'not an image');
  const stranger = buildPhantom({ mrn: 'N000000', name: 'Example^Unknown' })[0];
  fs.writeFileSync(path.join(images, 'stranger.dcm'), stranger.bytes);

  const dry = run('--dicom', images, '--dry-run');
  assert.match(dry.out, new RegExp(`Dry run \\(DICOM\\): ${files.length + 2} files`));
  assert.match(dry.out, /failed: 1/, 'a dry run validates files without touching the database');
  assert.equal(fs.existsSync(env.DICOM_DIR), false);

  const first = run('--fhir', fhirFile, '--dicom', images);
  assert.equal(first.code, 3, 'a skipped file makes the exit code non-zero');
  assert.match(first.out, /written: 1/);
  assert.match(first.out, new RegExp(`stored: ${files.length} in \\d+ stud`));
  assert.match(first.out, /failed: 2/);
  assert.match(first.out, /readme\.txt: /);
  assert.match(first.out, /stranger\.dcm: PatientID "N000000" does not match the MRN of any patient/);

  const again = run('--dicom', images);
  assert.match(again.out, /stored: 0 in/);
  assert.match(again.out, new RegExp(`already archived \\(skipped\\): ${files.length}`));

  const { store } = await openTestStore({ file: env.SQLITE_FILE, backend: 'sqlite' });
  const studies = await store.query('ImagingStudy');
  assert.ok(studies.length >= 1);
  assert.ok(studies.every((st) => st.subject.reference === 'Patient/22222222-2222-4222-8222-222222222222'));
  assert.equal(studies.reduce((n, st) => n + st.numberOfInstances, 0), files.length);
  assert.ok((await store.query('TraceStep', { groupKey: 'live' })).some((x) => x.did.type === 'dicom.store' && x.who.id === 'import-script'), 'the import is in the log');
  await store.close();
  assert.ok(fs.readdirSync(env.DICOM_DIR).length >= 1, 'files land under the data directory, not the repository');
});
