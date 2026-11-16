// Browser end-to-end test for the pathology app: generate a
// slide, accession and open the case, zoom to 20x, measure a planted region
// and check the value against its known size, annotate, request a stain the
// lab makes, sign out with a critical diagnosis, see the Inbox notice,
// release, see it in the portal, label a region in the workbench, zero
// console errors.
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/pathology.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTestServer, tempDir, patient } from '../support/helpers.mjs';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch { console.log('SKIPPED: Playwright is not installed. Set PLAYWRIGHT_MODULE to its path to run the browser test.'); process.exit(0); }

process.env.SLIDES_DIR = path.join(tempDir('hd-path-e2e-'), 'slides');
const s = await startTestServer({ webRoot: REPO_ROOT });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome' });
const errors = [];
const newContext = async (user, role = 'physician') => {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  context.setDefaultTimeout(20000);
  await context.addInitScript(([u, r]) => { localStorage.setItem('hd.role', r); localStorage.setItem('hd.user', u); }, [user, role]);
  return context;
};
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (409|422|423)/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
};
const t = (id) => `[data-testid="${id}"]`;
const steps = [];
const step = async (name, fn) => { await fn(); steps.push(name); console.log(`ok - ${name}`); };
const doc = { 'X-Role': 'physician', 'X-User-Id': 'dr-one' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pathol = { 'X-Role': 'physician', 'X-User-Id': 'dr-path' };
const lab = { 'X-Role': 'nurse', 'X-User-Id': 'tech-1' };
const HTEST = { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' };

try {
  const p = (await s.call('POST', '/fhir/R4/Patient', { ...patient('Zzslide', { name: [{ family: 'Zzslide', given: ['Test'] }], birthDate: '1961-05-05' }), meta: { security: [HTEST] } })).json;
  const order = (await s.call('POST', '/fhir/R4/ServiceRequest', { resourceType: 'ServiceRequest', status: 'active', intent: 'order', priority: 'urgent', subject: { reference: `Patient/${p.id}` }, authoredOn: new Date().toISOString(), requester: { display: 'Dr One' }, category: [{ coding: [{ system: 'urn:hospital-desktop:order-category', code: 'pathology' }] }], code: { coding: [{ system: 'http://loinc.org', code: '11529-5', display: 'Surgical pathology' }], text: 'Surgical pathology' }, reasonCode: [{ text: 'Pigmented lesion left forearm, rule out melanoma' }] }, doc)).json;
  const context = await newContext('dr-path');
  const pacs = await context.newPage(); watch(pacs, 'pathology');
  let caseId = null; let block = null; let study = null; let planted = null;

  await step('worklist: the pathology order waits for accessioning; the accession dialog builds parts, blocks and slides', async () => {
    await pacs.goto(`${s.base}/pathology/#/worklist`);
    await pacs.waitForSelector(t('pending-orders-table'));
    assert.equal(await pacs.locator('[data-testid^="accession-"]').count(), 1);
    await pacs.click(`[data-testid="accession-${order.id}"]`);
    await pacs.waitForSelector(t('accession-form'));
    await pacs.selectOption(t('acc-type'), 'Biopsy');
    await pacs.fill(t('acc-stains'), 'HE, PAS');
    await pacs.fill(t('acc-gross'), 'A 4 mm punch of skin with a 3 mm brown macule.');
    await pacs.click(t('accession-form-submit'));
    await pacs.waitForSelector('[data-testid^="worklist-table-row-"]');
    const row = (await s.call('GET', '/api/pathology/worklist', undefined, pathol)).json.rows[0];
    caseId = row.id; block = row.parts[0].blocks[0].id;
    assert.match(row.accession, /^S\d\d-00001$/);
    assert.deepEqual([row.type, row.priority, row.stains.sort(), row.slideCount, row.slidesWithImages], ['Biopsy', 'urgent', ['H&E', 'PAS'], 2, 0]);
    assert.match(await pacs.textContent(t('metrics')), /Unread 1/);
    assert.match(await pacs.textContent(t('case-info')), /A 4 mm punch/);
  });

  // 8 later steps were removed with the content they exercised: the release ships no data.
} finally {
  await browser.close();
  await s.close();
}
if (errors.length) { console.error('Console errors:\n' + errors.join('\n')); process.exit(1); }
console.log(`${steps.length} browser steps passed. Console errors: 0.`);
