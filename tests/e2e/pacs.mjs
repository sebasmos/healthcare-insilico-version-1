// Browser end-to-end test for PACS: upload, worklist, viewer, reporting, and
// the hand-off to the EHR Inbox and the portal.
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/pacs.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTestServer, tempDir } from '../support/helpers.mjs';
import { buildPhantom } from '../support/phantom.mjs';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch {
  console.log('SKIPPED: Playwright is not installed. Set PLAYWRIGHT_MODULE to its path to run the browser test.');
  process.exit(0);
}

const work = tempDir('hd-pacs-e2e-');
process.env.DICOM_DIR = path.join(work, 'dicom');
const s = await startTestServer({ webRoot: REPO_ROOT });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome' });
const errors = [];
const newContext = async (user, role = 'physician') => {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  context.setDefaultTimeout(15000);
  await context.addInitScript(([u, r]) => { localStorage.setItem('hd.role', r); localStorage.setItem('hd.user', u); }, [user, role]);
  return context;
};
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (409|422|423)/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
};
const shots = process.env.E2E_SHOTS ? tempDir('hd-pacs-shots-') : null;
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
const t = (id) => `[data-testid="${id}"]`;
const steps = [];
const step = async (name, fn) => { await fn(); steps.push(name); console.log(`ok - ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lit = (page, id) => page.locator(t(`viewport-canvas-${id}`)).evaluate((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 16) if (d[i] > 24) n += 1; return n / (d.length / 16); });
const centre = (page, id) => page.locator(t(`viewport-canvas-${id}`)).evaluate((c) => c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data[0]);

try {
  await s.call('PUT', '/api/friction', { level: 'low' });
  const patient = (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', name: [{ family: 'Zzimaging', given: ['Test'] }], birthDate: '1958-03-03', gender: 'female' })).json;
  const mrn = patient.identifier.find((i) => i.type.coding[0].code === 'MR').value;
  const order = (await s.call('POST', '/fhir/R4/ServiceRequest', { resourceType: 'ServiceRequest', status: 'active', intent: 'order', priority: 'stat', subject: { reference: `Patient/${patient.id}` }, requester: { display: 'Dr Referrer' }, authoredOn: new Date().toISOString(),
    category: [{ coding: [{ system: 'urn:hospital-desktop:order-category', code: 'imaging' }] }], code: { coding: [{ system: 'http://loinc.org', code: '36643-5', display: 'XR Chest 2 views' }] }, orderDetail: [{ coding: [{ code: 'DX' }] }], reasonCode: [{ text: 'Cough for three weeks' }] })).json;
  const files = buildPhantom({ mrn, name: 'Zzimaging^Test' }).map((f) => { const dir = path.join(work, 'phantom', f.folder); fs.mkdirSync(dir, { recursive: true }); const p = path.join(dir, f.name); fs.writeFileSync(p, f.bytes); return p; });
  fs.writeFileSync(path.join(work, 'notes.txt'), 'not dicom');

  const context = await newContext('Dr Reader');
  const pacs = await context.newPage(); watch(pacs, 'pacs');

  await step('upload: files are parsed in the browser, uploaded 4 at a time, bad files skipped, re-upload skips archived SOPs', async () => {
    await pacs.goto(`${s.base}/pacs/#/upload`);
    await pacs.waitForSelector(t('drop-zone'));
    assert.equal(await pacs.evaluate(() => document.documentElement.dataset.theme), 'dark', 'PACS defaults to the dark theme');
    await pacs.setInputFiles(t('file-input'), [...files, path.join(work, 'notes.txt')]);
    await pacs.waitForFunction(() => document.querySelectorAll('[data-testid^="upload-table-row-"]').length === 3);
    assert.match(await pacs.textContent(t('upload-invalid')), /1 file\(s\) are not readable DICOM/);
    await pacs.click(t('upload-start'));
    await pacs.waitForFunction(() => /Done: 42 stored, 0 already archived, 0 failed/.test(document.querySelector('[data-testid="upload-progress"]').textContent), null, { timeout: 60000 });
    await shot(pacs, '01-upload');
    await pacs.click(t('upload-clear'));
    await pacs.setInputFiles(t('file-input'), files.slice(0, 10));
    await pacs.waitForSelector('[data-testid^="upload-table-row-"]');
    await pacs.click(t('upload-start'));
    await pacs.waitForFunction(() => /Done: 0 stored, 10 already archived/.test(document.querySelector('[data-testid="upload-progress"]').textContent));
  });

  let rows;
  await step('worklist: STAT first with elapsed time, modality tree, patient history with relevant prior, thumbnails, metrics', async () => {
    await pacs.click(t('nav-worklist'));
    await pacs.waitForSelector(t('worklist-table'));
    rows = (await s.call('GET', '/api/pacs/worklist?queue=all', undefined, { 'X-User-Id': 'Dr Reader' })).json.rows;
    assert.equal(rows.length, 3);
    assert.equal(rows[0].priority, 'stat');
    const first = pacs.locator('[data-testid^="worklist-table-row-"]').first();
    assert.match(await first.textContent(), /Patient N100001.*XR Chest 2 views.*Unread/s);
    assert.match(await pacs.textContent(t(`elapsed-${rows[0].id}`)), /^\d+ min$/);
    assert.match(await pacs.textContent(t('tree-xr')), /2/);
    await pacs.click(t('tree-ct'));
    await pacs.waitForFunction(() => document.querySelectorAll('[data-testid^="worklist-table-row-"]').length === 1);
    await pacs.click(t('tree-all'));
    await pacs.waitForFunction(() => document.querySelectorAll('[data-testid^="worklist-table-row-"]').length === 3);
    await first.click();
    await pacs.waitForSelector(t(`prior-${rows[0].priorId}`));
    assert.match(await pacs.textContent(t('patient-strip')), new RegExp(`Patient N100001.*${mrn}`, 's'));
    assert.match(await pacs.textContent(t('study-info')), /Cough for three weeks.*Dr Referrer/s);
    await pacs.waitForSelector(`${t('thumbs')} canvas`);
    assert.match(await pacs.textContent(t('metrics')), /Read today 0/);
    await shot(pacs, '02-worklist');
  });

  const chest = () => rows[0];
  await step('viewer: prior on the left labelled PRIOR, current on the right, four-corner overlays, images drawn', async () => {
    await pacs.click(t(`open-${chest().id}`));
    await pacs.waitForSelector(t('viewport-current'));
    await pacs.waitForFunction(() => /Im 1\/1/.test(document.querySelector('[data-testid="overlay-tr-current"]')?.textContent || ''));
    const order2 = await pacs.locator('.panes .viewport').evaluateAll((els) => els.map((e) => e.dataset.testid));
    assert.deepEqual(order2, ['viewport-prior', 'viewport-current']);
    assert.match(await pacs.textContent(t('pane-tag-prior')), /^PRIOR/);
    assert.ok(!/PRIOR/.test(await pacs.textContent(t('pane-tag-current'))));
    assert.match(await pacs.textContent(t('overlay-tl-current')), new RegExp(`${mrn}\\nXR Chest 2 views`));
    assert.match(await pacs.textContent(t('overlay-tr-current')), /Se 1 {2}Im 1\/1\nW 3600 {2}L 1800/);
    assert.match(await pacs.textContent(t('overlay-bl-current')), /Spacing 0\.70 x 0\.70 mm/);
    assert.match(await pacs.textContent(t('overlay-br-current')), /Zoom 100%\n12 bit/);
    assert.ok(await lit(pacs, 'current') > 0.3 && await lit(pacs, 'prior') > 0.3, 'both panes show an image');
    const box = await pacs.locator(t('viewer')).evaluate((el) => { const r = (q) => document.querySelector(q).getBoundingClientRect(); return { tool: r('.vtool').height, rail: r('.rail').height, report: r('.report').width }; });
    // Sizes for the larger type: the toolbar wraps (at most three rows now that it holds the eight extra measuring tools) instead of scrolling sideways.
    const scale = await pacs.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')));
    assert.equal(Math.round(box.report), Math.round(384 * scale), 'report pane 24rem wide'); assert.ok(box.rail > 0 && box.rail <= Math.ceil(92 * scale), `compact thumbnail strip (${box.rail})`);
    assert.ok(box.tool >= 30 && box.tool <= 60 * scale, `one slim toolbar row that scrolls sideways (${box.tool}px)`);
    assert.equal(await pacs.locator(t('layout-mpr')).count(), 0, 'a single-frame study has no 3D toggle');
    await shot(pacs, '03-viewer-compare');
  });

  await step('viewer tools: window/level drag, presets, invert, zoom, pan, reset, length in millimetres', async () => {
    const canvas = pacs.locator(t('viewport-canvas-current'));
    const b = await canvas.boundingBox();
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    await pacs.mouse.move(cx, cy); await pacs.mouse.down(); await pacs.mouse.move(cx + 80, cy + 40, { steps: 4 }); await pacs.mouse.up();
    assert.ok(!/W 3600 {2}L 1800/.test(await pacs.textContent(t('overlay-tr-current'))), 'left-drag changes window and level');
    await pacs.selectOption(t('preset-select'), 'Lung');
    assert.match(await pacs.textContent(t('overlay-tr-current')), /W 1500 {2}L -600/);
    await pacs.selectOption(t('preset-select'), 'Auto');
    const before = await centre(pacs, 'current');
    await pacs.keyboard.press('i');
    const inverted = await centre(pacs, 'current');
    assert.ok(Math.abs(before + inverted - 255) <= 2, `invert flips grey levels (${before} -> ${inverted})`);
    await canvas.hover();
    await pacs.keyboard.down('Control'); await pacs.mouse.wheel(0, -400); await pacs.keyboard.up('Control');
    assert.ok(Number((await pacs.textContent(t('overlay-br-current'))).match(/Zoom (\d+)%/)[1]) > 150, 'Ctrl+wheel zooms');
    await pacs.mouse.move(cx, cy); await pacs.mouse.down({ button: 'right' }); await pacs.mouse.move(cx, cy + 100, { steps: 3 }); await pacs.mouse.up({ button: 'right' });
    await pacs.mouse.move(cx, cy); await pacs.mouse.down({ button: 'middle' }); await pacs.mouse.move(cx + 30, cy + 30, { steps: 3 }); await pacs.mouse.up({ button: 'middle' });
    await pacs.keyboard.press('r');
    assert.match(await pacs.textContent(t('overlay-br-current')), /Zoom 100%/);
    assert.equal(await centre(pacs, 'current'), before, 'reset restores the view');

    await pacs.click(t('tool-length'));
    await pacs.mouse.move(cx - 60, cy); await pacs.mouse.down(); await pacs.mouse.move(cx + 60, cy, { steps: 5 }); await pacs.mouse.up();
    const expected = 120 / (Math.min(b.width, b.height) / (512 * 0.7));
    const said = Number((await pacs.locator(t('toast')).last().textContent()).match(/Length ([\d.]+) mm/)[1]);
    assert.ok(Math.abs(said - expected) < 0.6, `length ${said} mm, expected about ${expected.toFixed(1)} mm from pixel spacing`);
    await pacs.click(t('tool-wl'));
    await shot(pacs, '04-measure');
  });

  await step('reporting: all three sections required, auto-saved draft, sign locks the report, release', async () => {
    await pacs.fill(t('report-technique'), 'PA chest radiograph.');
    await pacs.fill(t('report-findings'), 'Round opacity in the left upper zone, not present on the prior study.');
    assert.ok(await pacs.isVisible(t('report-dictate'))); assert.equal(await pacs.locator('[data-testid$="-dictate"]').count(), 1, 'one Dictate button for the whole report');
    await pacs.click(t('report-sign'));
    assert.match(await pacs.locator(t('toast-error')).last().textContent(), /Required before signing: impression/);
    await pacs.click(t('report-save'));
    await pacs.waitForFunction(() => /Draft saved/.test(document.querySelector('[data-testid="draft-status"]').textContent));
    assert.equal((await s.call('GET', `/api/pacs/studies/${chest().id}`)).json.study.status, 'draft');
    await pacs.fill(t('report-impression'), 'New 15 mm nodule, left upper zone. CT chest advised.');
    await pacs.click(t('report-sign'));
    await pacs.click(t('sign-report-ok'));
    await pacs.waitForSelector(t('report-status'));
    assert.equal(await pacs.locator(t('report-impression')).count(), 0, 'no editable fields after signing');
    assert.match(await pacs.textContent(t('ro-impression')), /New 15 mm nodule/);
    await pacs.click(t('report-release'));
    await pacs.waitForSelector(t('report-released'));
    await pacs.fill(t('report-addendum'), 'Discussed with the referring clinician by telephone.');
    await pacs.click(t('addendum-sign'));
    await pacs.click(t('sign-addendum-ok'));
    await pacs.waitForSelector('[data-testid^="addendum-"].banner');
    assert.match(await pacs.textContent(t('report-status')), /appended/);
    await shot(pacs, '05-report-signed');
  });

  await step('hand-off: Inbox notification, EHR imaging tab with report and View images link, order completed, portal report', async () => {
    // The hand-off is the referring physician's view: their own Inbox, chart and the patient's portal.
    const clinician = await newContext('Dr Chart', 'physician');
    const ehr = await clinician.newPage(); watch(ehr, 'ehr');
    await ehr.goto(`${s.base}/ehr/#/inbox?folder=reports`);
    await ehr.waitForSelector(t('inbox-reports'));
    assert.match(await ehr.textContent(t('inbox-reports')), /Imaging report signed.*New 15 mm nodule/s);
    assert.match(await ehr.textContent(t('inbox-reports')), /Report addendum signed/);
    await ehr.goto(`${s.base}/ehr/#/chart/${patient.id}/review/imaging?id=${chest().id}`);
    await ehr.waitForSelector(t('report-impression'));
    assert.match(await ehr.textContent(t('imaging-report')), /New 15 mm nodule.*Round opacity.*Addendum.*Discussed with the referring/s);
    assert.equal(await ehr.getAttribute(t('view-images'), 'href'), `/pacs/#/study/${chest().id}`);
    assert.equal((await s.call('GET', `/fhir/R4/ServiceRequest/${order.id}`)).json.status, 'completed');
    const portal = await clinician.newPage(); watch(portal, 'portal');
    await portal.goto(`${s.base}/portal/#/imaging`);
    await portal.waitForSelector(t('portal-imaging'));
    assert.match(await portal.textContent(t('portal-imaging')), /XR Chest 2 views/);
    await portal.close();
    await ehr.close();
    await clinician.close();
  });

  const ct = () => rows.find((r) => r.modality === 'CT');
  await step('CT stack: wheel and keyboard scroll, Home and End, cine, slice location overlay', async () => {
    await pacs.goto(`${s.base}/pacs/#/study/${ct().id}`);
    // Hanging protocol: a CT volume with no prior opens in the 2 x 2 layout (axial, coronal, sagittal, 3D). Choosing 1 x 1 is remembered for this modality and body part.
    await pacs.waitForSelector(t('viewport-3d'), { timeout: 60000 });
    assert.match(await pacs.textContent(t('hang-protocol')), /^CT/);
    assert.equal(await pacs.getAttribute(t('hang-2x2'), 'aria-pressed'), 'true');
    assert.ok(await pacs.isDisabled(t('hang-1x2')) && await pacs.isDisabled(t('hang-mpr-prior')), 'layouts that need a prior are greyed out');
    await pacs.click(t('hang-1x1'));
    await pacs.waitForFunction(() => /Im 20\/40/.test(document.querySelector('[data-testid="overlay-tr-current"]')?.textContent || ''), null, { timeout: 30000 });
    assert.match(await pacs.textContent(t('hang-protocol')), /your choice/);
    assert.equal(await pacs.locator('.panes .viewport').count(), 1, 'no prior of the same modality: single pane');
    assert.match(await pacs.textContent(t('viewer-status')), /40 images · CT · volume/);
    assert.match(await pacs.textContent(t('overlay-bl-current')), /Loc 76\.0 mm\nSpacing 2\.50 x 2\.50 mm/);
    const canvas = pacs.locator(t('viewport-canvas-current'));
    await canvas.hover();
    await pacs.mouse.wheel(0, 100);
    assert.match(await pacs.textContent(t('overlay-tr-current')), /Im 21\/40/);
    await canvas.click();
    await pacs.keyboard.press('ArrowUp'); await pacs.keyboard.press('ArrowUp');
    assert.match(await pacs.textContent(t('overlay-tr-current')), /Im 19\/40/);
    await pacs.keyboard.press('End');
    assert.match(await pacs.textContent(t('overlay-tr-current')), /Im 40\/40/);
    await pacs.keyboard.press('Home');
    assert.match(await pacs.textContent(t('overlay-tr-current')), /Im 1\/40/);
    await pacs.keyboard.press(' ');
    await sleep(450);
    await pacs.keyboard.press(' ');
    const at = Number((await pacs.textContent(t('overlay-tr-current'))).match(/Im (\d+)\/40/)[1]);
    assert.ok(at >= 3 && at <= 8, `cine advanced to image ${at}`);
    await sleep(300);
    assert.equal(Number((await pacs.textContent(t('overlay-tr-current'))).match(/Im (\d+)\/40/)[1]), at, 'cine stopped');
    assert.match(await pacs.textContent(t('overlay-tr-current')), /W 400 {2}L 40/);
  });

  await step('3D toggle on a CT volume: axial, coronal and sagittal panes, each scrollable with correct geometry', async () => {
    await pacs.click(t('layout-mpr'));
    await pacs.waitForSelector(t('viewport-sagittal'));
    assert.deepEqual(await pacs.locator('.panes .viewport').evaluateAll((els) => els.map((e) => e.dataset.testid)), ['viewport-axial', 'viewport-coronal', 'viewport-sagittal']);
    assert.match(await pacs.textContent(t('overlay-tr-axial')), /Im 20\/40/);
    assert.match(await pacs.textContent(t('overlay-tr-coronal')), /Im 64\/128/);
    assert.match(await pacs.textContent(t('overlay-tr-sagittal')), /Im 64\/128/);
    assert.match(await pacs.textContent(t('overlay-bl-coronal')), /Spacing 4\.00 x 2\.50 mm/, 'coronal rows are slices 4 mm apart');
    assert.match(await pacs.textContent(t('pane-tag-coronal')), /^Coronal/);
    for (const pane of ['axial', 'coronal', 'sagittal']) assert.ok(await lit(pacs, pane) > 0.03, `${pane} pane shows an image`);
    await pacs.locator(t('viewport-canvas-coronal')).hover();
    await pacs.mouse.wheel(0, 100);
    assert.match(await pacs.textContent(t('overlay-tr-coronal')), /Im 65\/128/);
    assert.match(await pacs.textContent(t('overlay-tr-axial')), /Im 20\/40/, 'panes scroll independently');
    await pacs.locator(t('viewport-canvas-sagittal')).click();
    await pacs.selectOption(t('preset-select'), 'Lung');
    assert.match(await pacs.textContent(t('overlay-tr-sagittal')), /W 1500 {2}L -600/);
    await shot(pacs, '06-mpr');
    await pacs.click(t('layout-single'));
    await pacs.waitForFunction(() => document.querySelectorAll('.panes .viewport').length === 1);
  });

  // The Cornerstone engine draws through WebGL and copies into a 2D canvas inside each pane element.
  const lit3d = (page, id) => page.locator(t(`viewport-canvas-${id}`)).evaluate((e) => { const c = e.querySelector('canvas'); if (!c) return 0; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 16) if (d[i] > 24) n += 1; return n / (d.length / 16); });

  await step('volume layout (Cornerstone3D): true MPR with linked crosshairs and a 3D volume-rendering pane with presets', async () => {
    await pacs.click(t('layout-volume'));
    await pacs.waitForSelector(t('viewport-3d'), { timeout: 60000 });
    assert.deepEqual(await pacs.locator('.panes .viewport').evaluateAll((els) => els.map((e) => e.dataset.testid)), ['viewport-axial', 'viewport-coronal', 'viewport-sagittal', 'viewport-3d']);
    await pacs.waitForFunction(() => /Slice 20\/40/.test(document.querySelector('[data-testid="overlay-tr-axial"]')?.textContent || ''), null, { timeout: 60000 });
    assert.match(await pacs.textContent(t('overlay-tr-axial')), /Slice 20\/40\nW 400 {2}L 40/);
    await pacs.waitForFunction(() => { const c = document.querySelector('[data-testid="viewport-canvas-3d"] canvas'); return c && c.width > 300; });
    await sleep(1200);
    for (const pane of ['axial', 'coronal', 'sagittal', '3d']) assert.ok(await lit3d(pacs, pane) > 0.03, `${pane} pane renders`);
    assert.match(await pacs.textContent(t('viewer-status')), /volume$/);
    // Dragging the crosshair centre in the coronal pane moves the axial slice.
    const box = await pacs.locator(t('viewport-canvas-coronal')).boundingBox();
    await pacs.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await pacs.mouse.down(); await pacs.mouse.move(box.x + box.width / 2, box.y + box.height * 0.3, { steps: 6 }); await pacs.mouse.up();
    await pacs.waitForFunction(() => !/Slice 20\/40/.test(document.querySelector('[data-testid="overlay-tr-axial"]')?.textContent || ''));
    assert.ok(Number((await pacs.textContent(t('overlay-tr-axial'))).match(/Slice (\d+)\/40/)[1]) < 20, 'the axial slice follows the crosshair');
    assert.equal(await pacs.inputValue(t('volume-preset')), 'CT-Bone');
    await pacs.selectOption(t('volume-preset'), 'CT-Soft-Tissue');
    await pacs.selectOption(t('preset-select'), 'Lung');
    assert.match(await pacs.textContent(t('overlay-tr-sagittal')), /W 1500 {2}L -600/);
    await shot(pacs, '06b-volume');
    await pacs.click(t('layout-single'));
    await pacs.waitForFunction(() => document.querySelectorAll('.panes .viewport').length === 1);
  });

  await step('measurements persist: a length drawn on the image is an Observation on the study, back on screen after a reload, and Clear removes it', async () => {
    await pacs.waitForFunction(() => /Im 20\/40/.test(document.querySelector('[data-testid="overlay-tr-current"]')?.textContent || ''));
    await pacs.click(t('tool-length'));
    const canvas = pacs.locator(t('viewport-canvas-current'));
    const box = await canvas.boundingBox();
    await pacs.mouse.move(box.x + box.width / 2 - 30, box.y + box.height / 2 + 20); await pacs.mouse.down(); await pacs.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20, { steps: 4 }); await pacs.mouse.up();
    await pacs.waitForFunction(() => /1 saved measurement/.test(document.querySelector('[data-testid="measure-count"]')?.textContent || ''));
    const saved = (await s.call('GET', `/api/pacs/studies/${ct().id}/annotations`)).json.annotations;
    assert.equal(saved.length, 1);
    assert.deepEqual([saved[0].kind, saved[0].unit, saved[0].plane, saved[0].frame, saved[0].engine], ['length', 'mm', 'axial', 19, 'canvas']);
    assert.equal((await s.call('GET', `/fhir/R4/Observation/${saved[0].id}`)).json.status, 'preliminary');
    await pacs.reload();
    await pacs.waitForFunction(() => /1 saved measurement/.test(document.querySelector('[data-testid="measure-count"]')?.textContent || ''), null, { timeout: 20000 });
    await pacs.click(t('tool-clear'));
    await pacs.waitForFunction(() => !/saved/.test(document.querySelector('[data-testid="measure-count"]')?.textContent || ''));
    assert.equal((await s.call('GET', `/api/pacs/studies/${ct().id}/annotations`)).json.annotations.length, 0);
    assert.equal((await s.call('GET', `/fhir/R4/Observation/${saved[0].id}`)).json.status, 'cancelled');
  });

  await step('a JPEG baseline study is decoded by the Cornerstone engine, labelled in the rail, and displayed with the same overlays', async () => {
    const up = await pacs.evaluate(async (mrn) => {
      const { write, generateUid, COMPRESSED_TS, SOP_CLASS } = await import('/shared/dicom.js');
      const c = document.createElement('canvas'); c.width = 256; c.height = 256; const g = c.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, 256, 256); g.fillStyle = '#ccc'; g.beginPath(); g.arc(128, 128, 90, 0, Math.PI * 2); g.fill();
      const jpeg = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9))).arrayBuffer());
      const ds = { SOPClassUID: SOP_CLASS.DX, SOPInstanceUID: generateUid(), StudyInstanceUID: generateUid(), SeriesInstanceUID: generateUid(), Modality: 'DX', PatientName: 'Zzimaging^Test', PatientID: mrn, StudyDate: '20260110', StudyTime: '101010', AccessionNumber: 'ACCJPG', StudyDescription: 'JPEG chest', SeriesNumber: '1', InstanceNumber: '1', SamplesPerPixel: 3, PhotometricInterpretation: 'YBR_FULL_422', PlanarConfiguration: 0, Rows: 256, Columns: 256, BitsAllocated: 8, BitsStored: 8, HighBit: 7, PixelRepresentation: 0, PixelData: { encapsulated: true, fragments: [jpeg] } };
      const bytes = write(ds, { transferSyntax: COMPRESSED_TS.JPEG_BASELINE });
      const boundary = 'jpgb';
      const r = await fetch('/dicom-web/studies', { method: 'POST', headers: { 'Content-Type': `multipart/related; type="application/dicom"; boundary=${boundary}`, 'X-Role': 'physician', 'X-User-Id': 'dr-reader' }, body: new Blob([`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`, bytes, `\r\n--${boundary}--\r\n`]) });
      return r.status;
    }, mrn);
    assert.equal(up, 200);
    const jpg = (await s.call('GET', '/api/pacs/worklist?queue=all')).json.rows.find((r) => r.accession === 'ACCJPG');
    await pacs.goto(`${s.base}/pacs/#/study/${jpg.id}`);
    await pacs.waitForFunction(() => /Im 1\/1/.test(document.querySelector('[data-testid="overlay-tr-current"]')?.textContent || ''), null, { timeout: 60000 });
    assert.match(await pacs.textContent(t('overlay-br-current')), /8 bit\nJPEG baseline/);
    assert.match(await pacs.textContent(t('viewer-status')), /JPEG baseline$/);
    assert.equal(await pacs.textContent(t('thumb-current-1')), 'JPEG baseline');
    await pacs.waitForFunction(() => { const c = document.querySelector('[data-testid="viewport-canvas-current"] canvas'); return c && c.width > 300; });
    await sleep(600);
    assert.ok(await lit3d(pacs, 'current') > 0.1, 'the decoded JPEG is drawn');
    assert.equal(await pacs.locator(t('layout-mpr')).count(), 0);
    assert.ok(await pacs.isEnabled(t('tool-angle')) && await pacs.isEnabled(t('tool-roi')), 'angle and ROI tools are available on the Cornerstone engine');
    await pacs.goto(`${s.base}/pacs/#/study/${ct().id}`);
    await pacs.waitForFunction(() => /Im 20\/40/.test(document.querySelector('[data-testid="overlay-tr-current"]')?.textContent || ''));
    assert.ok(await pacs.isEnabled(t('tool-angle')), 'the measuring tools beyond length are offered on every stack; picking one moves the stack to the Cornerstone engine');
    assert.equal(await pacs.locator('.viewport.cs3d').count(), 0, 'until then the in-house engine shows the stack');
  });

  await step('MPR and 3D on a fresh reader: time to first image and to full volume, slab MIP, named 3D presets, clipping box, 1 + 3 and 3D layouts', async () => {
    const freshCtx = await newContext('Dr Fresh');
    const fresh = await freshCtx.newPage(); watch(fresh, 'fresh');
    await fresh.goto(`${s.base}/pacs/#/study/${ct().id}`);
    await fresh.waitForSelector(t('viewport-3d'), { timeout: 60000 });
    await fresh.waitForFunction(() => window.__pacsVolume?.fullMs != null && window.__pacsTimings?.fullMs != null, null, { timeout: 120000 });
    const times = await fresh.evaluate(() => ({ stack: window.__pacsTimings, volume: window.__pacsVolume }));
    console.log(`PACS timings on the phantom CT (${times.volume.slices} slices): first image ${Math.round(times.stack.firstMs)} ms, all images ${Math.round(times.stack.fullMs)} ms, volume first slice ${times.volume.firstMs} ms, full volume ${times.volume.fullMs} ms`);
    assert.ok(times.stack.firstMs > 0 && times.stack.firstMs <= times.stack.fullMs, 'the first image is on screen before the series has finished loading');
    assert.ok(times.volume.firstMs <= times.volume.fullMs);
    assert.match(await fresh.textContent(t('load-times')), /First image \d+\.\d\d s · all images \d+\.\d\d s/);
    assert.match(await fresh.textContent(t('volume-times')), /full volume \d+\.\d\d s/);
    await fresh.waitForFunction(() => /Slice 20\/40/.test(document.querySelector('[data-testid="overlay-tr-axial"]')?.textContent || ''), null, { timeout: 60000 });
    await sleep(800);
    const shotOf = (pane) => fresh.locator(`${t(`viewport-canvas-${pane}`)} canvas`).first().evaluate((c) => { const g = document.createElement('canvas'); g.width = 64; g.height = 64; const x = g.getContext('2d'); x.drawImage(c, 0, 0, 64, 64); const d = x.getImageData(0, 0, 64, 64).data; let sum = 0; for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2]; return sum; });
    const thin = await shotOf('coronal');
    await fresh.selectOption(t('slab-mode'), 'mip');
    await fresh.fill(t('slab-thickness'), '60'); await fresh.dispatchEvent(t('slab-thickness'), 'change');
    await fresh.waitForFunction(() => /MIP \(brightest\) 60 mm/.test(document.querySelector('[data-testid="overlay-tr-coronal"]')?.textContent || ''));
    await sleep(600);
    const mip = await shotOf('coronal');
    assert.ok(mip > thin, `a 60 mm maximum-intensity slab is brighter than the thin slice (${thin} to ${mip})`);
    await fresh.selectOption(t('slab-mode'), 'minip'); await sleep(600);
    assert.ok(await shotOf('coronal') < mip, 'the minimum-intensity slab is darker than the maximum');
    await fresh.selectOption(t('slab-mode'), 'average'); await sleep(300);
    assert.match(await fresh.textContent(t('overlay-tr-axial')), /Average 60 mm/);
    await fresh.selectOption(t('slab-mode'), 'off');
    assert.deepEqual((await fresh.locator(`${t('volume-preset')} option`).allTextContents()).slice(0, 4), ['Bone', 'Soft tissue', 'Lung', 'Angiography']);
    const whole = await shotOf('3d');
    await fresh.check(t('clip-on'));
    await fresh.locator(t('clip-x-max')).evaluate((el) => { el.value = '35'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(700);
    const clipped = await shotOf('3d');
    assert.ok(clipped < whole * 0.9, `the clipping box cuts the 3D rendering (${whole} to ${clipped})`);
    await fresh.uncheck(t('clip-on')); await sleep(500);
    assert.ok(await shotOf('3d') > clipped, 'switching the box off brings the volume back');
    await fresh.click(t('hang-1-3'));
    await fresh.waitForFunction(() => document.querySelector('[data-testid="panes"]')?.classList.contains('big1') && document.querySelector('[data-testid="viewport-3d"]'));
    const big = await fresh.locator(t('viewport-axial')).boundingBox(); const small = await fresh.locator(t('viewport-coronal')).boundingBox();
    assert.ok(big.height > small.height * 2.5 && big.width > small.width * 1.5, 'one large axial pane with three beside it');
    await fresh.click(t('hang-3d'));
    await fresh.waitForFunction(() => document.querySelectorAll('.panes .viewport').length === 1 && document.querySelector('[data-testid="viewport-3d"]'));
    await fresh.goto(`${s.base}/pacs/#/study/${ct().id}`);
    await fresh.waitForFunction(() => document.querySelectorAll('.panes .viewport').length === 1 && document.querySelector('[data-testid="viewport-3d"]'), null, { timeout: 60000 });
    assert.match(await fresh.textContent(t('hang-protocol')), /your choice/, 'the 3D layout is remembered for this kind of study');
    await freshCtx.close();
  });

  await step('measuring tools: ellipse with mean and standard deviation, probe, Cobb angle; listed in the panel, renamed, linked into the report, saved as DICOM SR', async () => {
    await pacs.click(t('tool-ellipse'));
    await pacs.waitForSelector('.viewport.cs3d', { timeout: 60000 });
    await pacs.waitForFunction(() => /Im 20\/40/.test(document.querySelector('[data-testid="overlay-tr-current"]')?.textContent || ''), null, { timeout: 60000 });
    await sleep(800);
    const box = await pacs.locator(t('viewport-canvas-current')).boundingBox();
    const cx = box.x + box.width / 2; const cy = box.y + box.height / 2;
    const dragTo = async (x1, y1, x2, y2) => { await pacs.mouse.move(x1, y1); await pacs.mouse.down(); await pacs.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 4 }); await pacs.mouse.move(x2, y2, { steps: 4 }); await pacs.mouse.up(); };
    const count = (n) => pacs.waitForFunction((k) => new RegExp(`^${k} saved measurement`).test(document.querySelector('[data-testid="measure-count"]')?.textContent || ''), n, { timeout: 20000 });
    await dragTo(cx - 20, cy - 20, cx + 30, cy + 25);
    await count(1);
    await pacs.click(t('tool-probe'));
    await pacs.mouse.click(cx + 5, cy + 5);
    await count(2);
    await pacs.click(t('tool-cobb'));
    await dragTo(cx - 80, cy - 60, cx - 20, cy - 60);
    await dragTo(cx - 80, cy + 40, cx - 20, cy + 70);
    await count(3);
    const saved = (await s.call('GET', `/api/pacs/studies/${ct().id}/annotations`)).json.annotations;
    const by = Object.fromEntries(saved.map((x) => [x.kind, x]));
    assert.deepEqual(Object.keys(by).sort(), ['cobb', 'ellipse', 'probe']);
    assert.deepEqual([by.ellipse.unit, by.ellipse.engine, typeof by.ellipse.mean, typeof by.ellipse.sd], ['mm2', 'cs3d', 'number', 'number']);
    assert.ok(by.ellipse.value > 100, `ellipse area ${by.ellipse.value} mm2`);
    assert.deepEqual([by.probe.unit, typeof by.probe.value], ['HU', 'number']);
    assert.ok(by.cobb.value > 15 && by.cobb.value < 40, `Cobb angle ${by.cobb.value}: the lines were drawn about 27 degrees apart`);
    await pacs.click(t('tool-measurements'));
    await pacs.waitForSelector(t('measure-row-2'));
    const rowOf = await pacs.locator('[data-testid^="measure-text-"]').allTextContents();
    const ell = rowOf.findIndex((x) => /^Ellipse area [\d.]+ mm2, mean -?[\d.]+ \(SD [\d.]+\) \(series \d+, image 20\)$/.test(x));
    assert.ok(ell >= 0, rowOf.join(' | '));
    await pacs.fill(t(`measure-name-${ell}`), 'Liver lesion'); await pacs.dispatchEvent(t(`measure-name-${ell}`), 'change');
    for (let i = 0; i < 40 && !(await s.call('GET', `/api/pacs/studies/${ct().id}/annotations`)).json.annotations.some((x) => x.label === 'Liver lesion'); i += 1) await sleep(100);
    await pacs.waitForSelector(t(`measure-insert-${ell}`));
    await pacs.click(t(`measure-insert-${ell}`));
    assert.match(await pacs.inputValue(t('report-findings')), /Liver lesion: Ellipse area [\d.]+ mm2, mean/, 'the measurement is linked into the report findings');
    await pacs.click(t('measure-save-sr'));
    let objects = [];
    for (let i = 0; i < 50 && !objects.some((o) => o.kind === 'sr'); i += 1) { objects = (await s.call('GET', `/api/pacs/studies/${ct().id}/objects`)).json.objects; await sleep(100); }
    const sr = objects.find((o) => o.kind === 'sr');
    assert.ok(sr, 'a DICOM SR is stored with the study');
    const { readSr } = await import('../../viewers/dicom/objects.js');
    const back = readSr(new Uint8Array(Buffer.from((await s.call('GET', `/api/pacs/studies/${ct().id}/objects/${sr.id}`)).json.data, 'base64')));
    assert.deepEqual(back.measurements.map((m) => m.kind).sort(), ['cobb', 'ellipse', 'probe']);
    assert.equal(back.measurements.find((m) => m.kind === 'ellipse').label, 'Liver lesion');
    assert.ok(back.measurements.every((m) => m.sopUid && m.points.length >= 1), 'each measurement names its image and carries its graphic');
    await pacs.keyboard.press('?');
    await pacs.waitForSelector(t('shortcut-help'));
    assert.match(await pacs.textContent(t('shortcut-help')), /Cobb angle.*Bidirectional/s);
    await pacs.click(t('shortcut-help-close'));
    await pacs.click(t('tool-clear'));
    await pacs.waitForFunction(() => !(document.querySelector('[data-testid="measure-count"]')?.textContent || ''));
    await pacs.click(t('tool-measurements'));
  });

  await step('segmentation: region growing and threshold on labelled segments, shown on the image and in 3D, saved as DICOM SEG and loaded back', async () => {
    await pacs.reload();
    await pacs.waitForFunction(() => /Im 20\/40/.test(document.querySelector('[data-testid="overlay-tr-current"]')?.textContent || '') && !document.querySelector('.viewport.cs3d'), null, { timeout: 60000 });
    await pacs.click(t('tool-segmentation'));
    await pacs.waitForSelector(t('seg-tool-grow'));
    const tinted = () => pacs.locator(t('viewport-canvas-current')).evaluate((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > d[i + 1] + 40 && d[i] > d[i + 2] + 40) n += 1; return n; });
    assert.equal(await tinted(), 0);
    await pacs.fill(t('seg-tolerance'), '40'); await pacs.dispatchEvent(t('seg-tolerance'), 'change');
    await pacs.click(t('seg-tool-grow'));
    await pacs.locator(t('viewport-canvas-current')).scrollIntoViewIfNeeded(); // with taller toolbars the image may start below the fold
    const box = await pacs.locator(t('viewport-canvas-current')).boundingBox();
    await pacs.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await pacs.waitForFunction(() => /^\d+ voxels/.test(document.querySelector('[data-testid="seg-stats-1"]')?.textContent || ''));
    const grown = Number((await pacs.textContent(t('seg-stats-1'))).match(/^(\d+) voxels/)[1]);
    assert.ok(grown > 20, `${grown} voxels grown from the click`);
    assert.match(await pacs.textContent(t('seg-stats-1')), /ml$/, 'the volume is given in millilitres');
    assert.ok(await tinted() > 20, 'the segment is drawn over the image');
    assert.ok(Number(await pacs.getAttribute(t('seg-3d'), 'data-drawn')) > 20, 'the segment is drawn in the 3D view');
    await pacs.click(t('seg-add'));
    await pacs.fill(t('seg-name-2'), 'Everything else on this image'); await pacs.dispatchEvent(t('seg-name-2'), 'change');
    await pacs.fill(t('seg-low'), '-5000'); await pacs.dispatchEvent(t('seg-low'), 'change');
    await pacs.fill(t('seg-high'), '9000'); await pacs.dispatchEvent(t('seg-high'), 'change');
    await pacs.click(t('seg-threshold-slice'));
    await pacs.waitForFunction(() => /^\d+ voxels/.test(document.querySelector('[data-testid="seg-stats-2"]')?.textContent || ''));
    const filled = Number((await pacs.textContent(t('seg-stats-2'))).match(/^(\d+) voxels/)[1]);
    assert.ok(filled > 1000, 'the threshold fills the rest of the image without overwriting segment 1');
    assert.equal(Number((await pacs.textContent(t('seg-stats-1'))).match(/^(\d+) voxels/)[1]), grown);
    await pacs.click(t('seg-save'));
    let objects = [];
    for (let i = 0; i < 80 && !objects.some((o) => o.kind === 'seg'); i += 1) { objects = (await s.call('GET', `/api/pacs/studies/${ct().id}/objects`)).json.objects; await sleep(100); }
    const seg = objects.find((o) => o.kind === 'seg');
    assert.ok(seg, 'a DICOM SEG is stored with the study');
    assert.equal(seg.summary.segments, 2);
    const { readSeg } = await import('../../viewers/dicom/objects.js');
    const back = readSeg(new Uint8Array(Buffer.from((await s.call('GET', `/api/pacs/studies/${ct().id}/objects/${seg.id}`)).json.data, 'base64')));
    assert.deepEqual(back.segments.map((x) => [x.number, x.label, x.algorithm]), [[1, 'Segment 1', 'SEMIAUTOMATIC'], [2, 'Everything else on this image', 'SEMIAUTOMATIC']]);
    let n1 = 0; let n2 = 0; for (const v of back.labels) { if (v === 1) n1 += 1; else if (v === 2) n2 += 1; }
    assert.deepEqual([n1, n2], [grown, filled], 'the file holds exactly the voxels that were on screen');
    assert.equal(back.slices, 40);
    await pacs.goto(`${s.base}/pacs/#/worklist`);
    await pacs.goto(`${s.base}/pacs/#/study/${ct().id}`);
    await pacs.waitForFunction(() => /Im 20\/40/.test(document.querySelector('[data-testid="overlay-tr-current"]')?.textContent || ''), null, { timeout: 60000 });
    await pacs.click(t('tool-segmentation'));
    await pacs.waitForSelector(t('seg-load'));
    assert.equal(await tinted(), 0);
    await pacs.selectOption(t('seg-load'), seg.id);
    await pacs.waitForFunction((n) => new RegExp(`^${n} voxels`).test(document.querySelector('[data-testid="seg-stats-1"]')?.textContent || ''), grown);
    assert.ok(await tinted() > 20, 'the loaded segmentation is back on the image');
    const trace = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.map((x) => x.did.type);
    for (const a of ['image.seg.save', 'image.sr.save']) assert.ok(trace.includes(a), `${a} is logged`);
    await pacs.click(t('tool-segmentation'));
  });

  await step('reading lock: a second reader sees the lock, cannot report, and can take over', async () => {
    const other = await newContext('Dr Second');
    const second = await other.newPage(); watch(second, 'second');
    await second.goto(`${s.base}/pacs/#/study/${ct().id}`);
    await second.waitForSelector(t('locked-banner'));
    assert.match(await second.textContent(t('locked-banner')), /Being read by Dr Reader/);
    assert.ok(await second.isDisabled(t('report-findings')));
    assert.ok(await second.isDisabled(t('report-sign')));
    await second.goto(`${s.base}/pacs/#/worklist`);
    await second.waitForSelector(t('worklist-table'));
    await second.click(t('tree-all'));
    await second.waitForSelector(t(`lock-${ct().id}`));
    assert.equal(await second.textContent(t(`lock-${ct().id}`)), 'DR');
    await second.goto(`${s.base}/pacs/#/study/${ct().id}`);
    await second.click(t('take-over'));
    await second.click(t('take-over-confirm-ok'));
    await second.waitForFunction(() => !document.querySelector('[data-testid="locked-banner"]'));
    assert.ok(await second.isEnabled(t('report-findings')));
    assert.equal((await s.call('GET', `/api/pacs/studies/${ct().id}`)).json.study.lock.by, 'Dr Second');
    await other.close();
  });

  await step('shared context and logging: EHR patient selection filters the worklist; viewer actions are TraceSteps', async () => {
    const otherPatient = (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', name: [{ family: 'Zznoimages', given: ['Test'] }], birthDate: '1980-01-01' })).json;
    await pacs.goto(`${s.base}/pacs/#/worklist`);
    await pacs.waitForSelector(t('worklist-table'));
    const ehr = await context.newPage(); watch(ehr, 'ehr2');
    await ehr.goto(`${s.base}/ehr/#/chart/${otherPatient.id}/summary`);
    await ehr.waitForSelector(t('patient-name'));
    await pacs.waitForSelector(t('patient-filter'));
    assert.equal(await pacs.locator('[data-testid^="worklist-table-row-"]').count(), 0);
    await pacs.click(t('patient-filter-clear'));
    await ehr.close();
    await sleep(2600);
    const trace = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps;
    const viewer = trace.filter((x) => x.did.type === 'ui.viewer').map((x) => x.did.args.viewer);
    const length = viewer.find((v) => v.action === 'length');
    assert.ok(length && length.mm > 50 && length.plane === 'axial', 'the measurement is stored as a TraceStep with its length in mm');
    for (const action of ['open-study', 'preset', 'layout', 'sign-report']) assert.ok(viewer.some((v) => v.action === action), `viewer action ${action} recorded`);
    assert.ok(trace.filter((x) => x.did.type === 'image.open').length >= 3, 'every study open is audited');
    assert.ok(!JSON.stringify(trace.filter((x) => x.source === 'ui')).includes('nodule'), 'report text is not in telemetry');
  });

  await step('accessibility hooks on worklist, viewer and upload', async () => {
    for (const hash of ['#/worklist', `#/study/${chest().id}`, '#/upload']) {
      await pacs.goto(`${s.base}/pacs/${hash}`);
      await pacs.waitForSelector('.topbar');
      await sleep(500);
      const missing = await pacs.evaluate(() => [...document.querySelectorAll('button, input, select, textarea')].filter((el) => !el.dataset.testid || !el.getAttribute('aria-label')).map((el) => el.outerHTML.slice(0, 120)));
      assert.deepEqual(missing, [], `controls without testid and aria-label on ${hash}`);
    }
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
