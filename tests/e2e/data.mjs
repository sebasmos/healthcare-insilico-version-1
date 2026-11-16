// Browser end-to-end test for bring-your-own data: the
// PACS upload "attach to patient" choice and the read-only Datasets tab in
// EHR Administration.
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/data.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTestServer, tempDir } from '../support/helpers.mjs';
import { buildPhantom } from '../support/phantom.mjs';
import { recordDataset } from '../../platform/server/datasets.mjs';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch {
  console.log('SKIPPED: Playwright is not installed. Set PLAYWRIGHT_MODULE to its path to run the browser test.');
  process.exit(0);
}

const work = tempDir('hd-data-e2e-');
process.env.DICOM_DIR = path.join(work, 'dicom');
process.env.DATASETS_FILE = path.join(work, 'datasets.json');
const s = await startTestServer({ webRoot: REPO_ROOT });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome' });
const errors = [];
const newContext = async (role, user) => {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  context.setDefaultTimeout(15000);
  await context.addInitScript(([r, u]) => { localStorage.setItem('hd.role', r); localStorage.setItem('hd.user', u); }, [role, user]);
  return context;
};
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (409|422|423)/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
};
const shots = process.env.E2E_SHOTS ? tempDir('hd-data-shots-') : null;
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
const t = (id) => `[data-testid="${id}"]`;
const steps = [];
const step = async (name, fn) => { await fn(); steps.push(name); console.log(`ok - ${name}`); };

try {
  await s.call('PUT', '/api/friction', { level: 'low' });
  const patient = (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', name: [{ family: 'Zzattach', given: ['Test'] }], birthDate: '1958-03-03', gender: 'female' })).json;
  const files = buildPhantom({ mrn: 'PUBLIC-0001', name: 'Anon^Public' }).filter((f) => f.folder !== 'ct-chest').map((f) => { const dir = path.join(work, 'public', f.folder); fs.mkdirSync(dir, { recursive: true }); const p = path.join(dir, f.name); fs.writeFileSync(p, f.bytes); return p; });

  const context = await newContext('physician', 'Dr Reader');
  const pacs = await context.newPage(); watch(pacs, 'pacs');

  await step('upload: a foreign PatientID is refused when matching by header, then stored when attached to a chosen patient', async () => {
    await pacs.goto(`${s.base}/pacs/#/upload`);
    await pacs.waitForSelector(t('upload-patient'));
    assert.equal(await pacs.inputValue(t('upload-patient')), '', 'the default is to match by the header');
    await pacs.setInputFiles(t('file-input'), files);
    await pacs.waitForFunction(() => document.querySelectorAll('[data-testid^="upload-table-row-"]').length === 2);
    await pacs.click(t('upload-start'));
    await pacs.waitForFunction(() => /Done: 0 stored, 0 already archived, 2 failed/.test(document.querySelector('[data-testid="upload-progress"]').textContent), null, { timeout: 60000 });
    assert.match(await pacs.textContent(t('upload-table')), /PatientID "PUBLIC-0001" does not match the MRN of any patient/);
    await shot(pacs, '01-upload-refused');
    await pacs.selectOption(t('upload-patient'), patient.id);
    await pacs.click(t('upload-start'));
    await pacs.waitForFunction(() => /Done: 2 stored, 0 already archived, 0 failed/.test(document.querySelector('[data-testid="upload-progress"]').textContent), null, { timeout: 60000 });
    await shot(pacs, '02-upload-attached');
    const studies = (await s.call('GET', `/fhir/R4/ImagingStudy?patient=${patient.id}`)).json.entry.map((e) => e.resource);
    assert.equal(studies.length, 2, 'both studies are filed under the chosen patient');
    assert.ok(studies.every((st) => st.identifier.some((i) => i.system === 'urn:dicom:patient-id' && i.value === 'PUBLIC-0001')), 'the header PatientID is kept');
    const logged = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.filter((x) => x.did.type === 'dicom.store');
    assert.ok(logged.length >= 2 && logged.every((x) => x.did.args.patientOverride === `Patient/${patient.id}`), 'the override is in the log');
  });

  await step('worklist shows the attached studies under the chosen patient', async () => {
    await pacs.click(t('nav-worklist'));
    await pacs.waitForSelector(t('worklist-table'));
    await pacs.waitForFunction(() => /Patient N\d{6}/.test(document.querySelector('[data-testid="worklist-table"]').textContent));
  });

  const ehrContext = await newContext('physician', 'Admin One');
  const ehr = await ehrContext.newPage(); watch(ehr, 'ehr');

  await step('EHR Administration: the Datasets tab is empty until an import is registered', async () => {
    await ehr.goto(`${s.base}/ehr/#/admin?tab=datasets`);
    await ehr.waitForSelector(t('datasets-table'));
    assert.match(await ehr.textContent(t('datasets-table')), /No data sets have been imported/);
  });

  await step('a register entry appears read-only with source, licence, kind, flags and patient count', async () => {
    recordDataset({ kind: 'dicom', source: 'Public chest set', licence: 'CC BY 4.0', files: 2, checksum: 'a'.repeat(64), synthetic: true, restricted: false, patients: [patient.id], importedAt: new Date().toISOString() });
    recordDataset({ kind: 'ecg', source: 'Restricted ECG set', licence: null, files: 4, checksum: 'b'.repeat(64), synthetic: false, restricted: true, patients: ['someone'], importedAt: new Date().toISOString() });
    await ehr.click(t('admin-tab-audit'));
    await ehr.waitForSelector(t('audit-table'));
    await ehr.click(t('admin-tab-datasets'));
    await ehr.waitForFunction(() => document.querySelectorAll('[data-testid^="datasets-table-row-"]').length === 2);
    const text = await ehr.textContent(t('datasets-table'));
    for (const expected of ['Public chest set', 'CC BY 4.0', 'DICOM images', 'Synthetic', 'Restricted ECG set', 'ECG (WFDB)', 'Restricted']) assert.ok(text.includes(expected), expected);
    await shot(ehr, '03-datasets');
    const missing = await ehr.evaluate(() => [...document.querySelectorAll('button, input, select, textarea')].filter((el) => !el.dataset.testid || !el.getAttribute('aria-label')).map((el) => el.outerHTML.slice(0, 120)));
    assert.deepEqual(missing, [], 'controls without testid and aria-label');
  });

  assert.deepEqual(errors, [], 'browser console errors');
  console.log(`\n${steps.length} browser steps passed. Console errors: 0.`);
  if (shots) console.log(`Screenshots: ${shots}`);
} catch (err) {
  console.error(`\nFAILED after ${steps.length} steps: ${err.stack || err.message}`);
  if (errors.length) console.error('Console errors:\n' + errors.join('\n'));
  if (shots) { let i = 0; for (const c of browser.contexts()) for (const p of c.pages()) { await p.screenshot({ path: path.join(shots, `fail-${i}.png`) }).catch(() => {}); i += 1; } console.error(`Screenshots: ${shots}`); }
  process.exitCode = 1;
} finally {
  await browser.close();
  await s.close();
  if (!shots) fs.rmSync(work, { recursive: true, force: true });
}
