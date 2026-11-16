// Whole-slide images: accepted formats, the slide register on an
// ImagingStudy with modality SM, import with patient mapping, and tile
// serving straight from the stored file. Tiles are never decoded here.
// Storage: data/slides/<study id>/<file> plus index.json (tile offsets).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';
import { HttpError } from '../../platform/server/http.mjs';
import { enforcedFor, assertMayWrite } from '../../platform/server/roles.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';
import { describeSlide, readTile, readAuxImage, SLIDE_EXTENSIONS, COMPRESSION, TiffError } from '../../viewers/server/tiff.mjs';
import { parse as parseDicom, DicomError } from '../../viewers/dicom/dicom.js';
import { mrnOf } from '../../ehr/server/clinical-rules.mjs';
import { HTEST } from '../../platform/server/datasets.mjs';
import { patientMapper, filesUnder, SOURCE_ID_URL } from '../../platform/server/import-media.mjs';

export const SLIDE_URL = 'urn:hospital-desktop:slide';
export const SLIDE_SPECIMEN_URL = 'urn:hospital-desktop:slide-specimen';
export const WSI_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.77.1.6';
export const DCM = 'http://dicom.nema.org/resources/ontology/DCM';
export const slidesRoot = () => path.resolve(REPO_ROOT, process.env.SLIDES_DIR || 'data/slides');
export const slideStudyId = (key) => `st-${createHash('sha1').update(`slide:${key}`).digest('hex').slice(0, 32)}`;
const DEFAULT_ACTOR = { kind: 'human', id: 'import-script', role: 'administrator' };
const VENDOR_ONLY = { '.ndpi': 'Hamamatsu NDPI', '.mrxs': '3DHistech MIRAX', '.scn': 'Leica SCN', '.bif': 'Ventana BIF', '.vms': 'Hamamatsu VMS' };

/** A cheap, stable key for a file: size plus hashes of its first and last 64 KB. */
export function fileKey(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(65536, size)); fs.readSync(fd, head, 0, head.length, 0);
    const tail = Buffer.alloc(Math.min(65536, size)); fs.readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
    return createHash('sha1').update(String(size)).update(head).update(tail).digest('hex');
  } finally { fs.closeSync(fd); }
}

/** Looks inside a slide file without storing it: { ok, format, refused: [reasons], info } for TIFF-family files; vendor formats are refused by extension. */
export function inspectSlideFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (VENDOR_ONLY[ext]) return { ok: false, format: 'vendor', refused: [`${VENDOR_ONLY[ext]} (${ext}) is a vendor format this server does not read; export the slide as a JPEG-tiled pyramidal TIFF or DICOM whole-slide images`] };
  if (!['.svs', '.tif', '.tiff'].includes(ext)) return { ok: false, format: 'unknown', refused: [`${ext || 'no extension'} is not a slide file this server reads (.svs, .tif, .tiff, or DICOM whole-slide images)`] };
  try {
    const info = describeSlide(file);
    const refused = [...info.refused];
    if (!info.levels.length) refused.push('no tiled JPEG pyramid level could be served');
    return { ok: refused.length === 0 || info.levels.length > 0, format: 'tiff', refused, info };
  } catch (err) { if (err instanceof TiffError) return { ok: false, format: 'tiff', refused: [err.message] }; throw err; }
}

function pixelSpacingOf(file) {
  // Shared functional groups → pixel measures → PixelSpacing; the parser exposes sequence items as parsed datasets.
  try {
    const shared = file.get('SharedFunctionalGroupsSequence');
    const item = Array.isArray(shared) ? shared[0] : null;
    const measures = item?.get?.('00289110')?.value;
    const m = Array.isArray(measures) ? measures[0] : null;
    const spacing = m?.get?.('00280030')?.value;
    const v = Array.isArray(spacing) ? Number(spacing[0]) : Number(String(spacing || '').split('\\')[0]);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}

/** Groups DICOM whole-slide instances (one per pyramid level) into slide descriptions. Unverified against vendor exports: built from the standard's TILED_FULL layout. */
export function inspectDicomSlides(files) {
  const groups = new Map(); const refused = [];
  for (const file of files) {
    let f;
    try { f = parseDicom(new Uint8Array(fs.readFileSync(file))); } catch (err) { if (err instanceof DicomError) { refused.push(`${path.basename(file)}: ${err.message}`); continue; } throw err; }
    if (f.str('SOPClassUID') !== WSI_SOP_CLASS) { refused.push(`${path.basename(file)}: not a VL Whole Slide Microscopy Image (SOP class ${f.str('SOPClassUID')})`); continue; }
    const px = f.get('PixelData');
    const frames = f.num('NumberOfFrames') ?? 1;
    const imageType = f.values('ImageType');
    const kind = imageType.includes('LABEL') ? 'label' : imageType.includes('OVERVIEW') ? 'macro' : imageType.includes('THUMBNAIL') ? 'thumbnail' : 'level';
    if (!px || !px.encapsulated) { refused.push(`${path.basename(file)}: pixel data is not encapsulated (uncompressed whole-slide frames are not served)`); continue; }
    if (!/1\.2\.840\.10008\.1\.2\.4\.(50|51|57|70|80|81)$/.test(f.transferSyntax)) { refused.push(`${path.basename(file)}: transfer syntax ${f.transferSyntax} is not JPEG; only JPEG tiles are served`); continue; }
    if (kind === 'level' && px.fragments.length !== frames) { refused.push(`${path.basename(file)}: ${px.fragments.length} fragments for ${frames} frames; one fragment per frame is required`); continue; }
    const org = f.str('DimensionOrganizationType') || 'TILED_FULL';
    if (kind === 'level' && org !== 'TILED_FULL') { refused.push(`${path.basename(file)}: dimension organisation ${org} is not supported (TILED_FULL only)`); continue; }
    const buf = px.fragments[0]?.buffer;
    const base = buf ? 0 : 0;
    const study = f.str('StudyInstanceUID');
    const g = groups.get(study) || { study, files: [], levels: [], label: null, macro: null, patientId: f.str('PatientID') || null, patientName: f.str('PatientName') || '', description: f.str('SeriesDescription') || f.str('StudyDescription') || 'Whole slide image', mpp: null, magnification: f.num('ObjectiveLensPower') ?? null };
    const width = f.num('TotalPixelMatrixColumns') ?? f.num('Columns'); const height = f.num('TotalPixelMatrixRows') ?? f.num('Rows');
    const tileWidth = f.num('Columns'); const tileLength = f.num('Rows');
    const entry = { file, width, height, tileWidth, tileLength, tilesAcross: Math.ceil(width / tileWidth), tilesDown: Math.ceil(height / tileLength), offsets: px.fragments.map((fr) => fr.byteOffset - base), byteCounts: px.fragments.map((fr) => fr.byteLength), jpegTables: null, photometric: f.str('PhotometricInterpretation') === 'RGB' ? 2 : 6, samples: f.num('SamplesPerPixel') ?? 3, transferSyntax: f.transferSyntax };
    if (kind === 'level') { g.levels.push(entry); const sp = pixelSpacingOf(f); if (sp && !g.mpp) g.mpp = Math.round(sp * 1000 * 10000) / 10000; }
    else if (kind === 'label') g.label = { ...entry, servable: true };
    else if (kind === 'macro') g.macro = { ...entry, servable: true };
    g.files.push(file);
    groups.set(study, g);
  }
  const slides = [...groups.values()].map((g) => { g.levels.sort((a, b) => b.width - a.width); return g; }).filter((g) => g.levels.length);
  return { slides, refused };
}

const indexFile = (dir) => path.join(dir, 'index.json');
const indexCache = new Map();
/** The stored tile index of a slide study (cached). */
export function slideIndex(studyId) {
  const dir = path.join(slidesRoot(), studyId);
  const file = indexFile(dir);
  if (!fs.existsSync(file)) return null;
  const mtime = fs.statSync(file).mtimeMs;
  const hit = indexCache.get(studyId);
  if (hit && hit.mtime === mtime) return hit.index;
  const index = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const lv of index.levels) if (lv.jpegTables) lv.jpegTables = Uint8Array.from(Buffer.from(lv.jpegTables, 'base64'));
  if (indexCache.size > 32) indexCache.delete(indexCache.keys().next().value);
  indexCache.set(studyId, { mtime, index });
  return index;
}

function writeIndex(dir, index) {
  const out = { ...index, levels: index.levels.map((lv) => ({ ...lv, jpegTables: lv.jpegTables ? Buffer.from(lv.jpegTables).toString('base64') : null })) };
  fs.writeFileSync(indexFile(dir), JSON.stringify(out));
}

/** Builds the ImagingStudy for a slide and stores the file(s) and index. Returns { status: 'stored' | 'duplicate' | 'refused', study, reasons }. Runs inside the caller's transaction. */
export async function storeSlide(tx, { source, patientRef, specimenRef = null, orderRef = null, description = null, stain = null, ctx, actor = DEFAULT_ACTOR, branch = 'main', tags = {}, sourceName = null }) {
  // source: { kind: 'tiff', file } | { kind: 'tiff-bytes', bytes, name } | { kind: 'dicom', slide }
  let key; let info; let files = []; let format;
  if (source.kind === 'tiff-bytes') {
    const tmp = path.join(slidesRoot(), '.tmp'); fs.mkdirSync(tmp, { recursive: true });
    const tmpFile = path.join(tmp, `${Date.now()}-${Math.random().toString(36).slice(2)}.tif`);
    fs.writeFileSync(tmpFile, source.bytes);
    source = { kind: 'tiff', file: tmpFile, name: source.name || 'slide.tif', temp: true };
  }
  if (source.kind === 'tiff') {
    const look = inspectSlideFile(source.file);
    if (!look.ok) { if (source.temp) fs.rmSync(source.file, { force: true }); return { status: 'refused', reasons: look.refused }; }
    key = fileKey(source.file); info = look.info; files = [source.file]; format = 'tiff';
  } else {
    info = source.slide; key = source.slide.study; files = source.slide.files; format = 'dicom';
  }
  const id = slideStudyId(key);
  const existing = await tx.get('ImagingStudy', id, { branch });
  if (existing) { if (source.temp) fs.rmSync(source.file, { force: true }); return { status: 'duplicate', study: existing, reasons: [] }; }
  const dir = path.join(slidesRoot(), id);
  fs.mkdirSync(dir, { recursive: true });
  const stored = files.map((f) => { const name = path.basename(source.kind === 'tiff' ? (source.name || f) : f); const target = path.join(dir, name); if (source.temp) fs.renameSync(f, target); else fs.copyFileSync(f, target); return name; });
  const levels = info.levels.map((lv, i) => ({ ...lv, file: format === 'tiff' ? stored[0] : path.basename(lv.file), index: lv.index ?? i, offsets: lv.offsets, byteCounts: lv.byteCounts }));
  const aux = (a, kind) => (a ? { ...a, kind, file: format === 'tiff' ? stored[0] : path.basename(a.file) } : null);
  writeIndex(dir, { format, files: stored, width: levels[0].width, height: levels[0].height, tileWidth: levels[0].tileWidth, tileLength: levels[0].tileLength, mpp: info.mpp ?? null, magnification: info.magnification ?? null, levels, label: aux(info.label, 'label'), macro: aux(info.macro, 'macro'), refused: info.refused || [] });
  const now = tx.now();
  const summary = { format, files: stored, width: levels[0].width, height: levels[0].height, tileWidth: levels[0].tileWidth, tileLength: levels[0].tileLength, levels: levels.map((l) => ({ width: l.width, height: l.height, tilesAcross: l.tilesAcross, tilesDown: l.tilesDown })), mpp: info.mpp ?? null, magnification: info.magnification ?? null, label: Boolean(info.label), macro: Boolean(info.macro), patientId: info.patientId ?? null, vendor: info.vendor ?? null, source: sourceName, refused: info.refused || [] };
  const uid = format === 'dicom' ? info.study : `2.25.${BigInt(`0x${key.slice(0, 30)}`).toString()}`;
  const doc = {
    resourceType: 'ImagingStudy', id, status: 'available', subject: { reference: patientRef }, started: now, description: description || (stain ? `${stain} slide` : path.basename(stored[0])),
    modality: [{ system: DCM, code: 'SM' }], numberOfSeries: 1, numberOfInstances: levels.length,
    identifier: [{ system: 'urn:dicom:uid', value: `urn:oid:${uid}` }, ...(info.patientId ? [{ system: 'urn:dicom:patient-id', value: String(info.patientId) }] : [])],
    ...(orderRef ? { basedOn: [{ reference: orderRef }] } : {}),
    series: [{ uid: `${uid}.1`, number: 1, modality: { system: DCM, code: 'SM' }, description: 'Pyramid', instance: levels.map((l, i) => ({ uid: `${uid}.1.${i + 1}`, sopClass: { system: 'urn:ietf:rfc:3986', code: `urn:oid:${WSI_SOP_CLASS}` }, number: i + 1, title: `${l.width}x${l.height}` })) }],
    extension: [{ url: SLIDE_URL, valueString: JSON.stringify(summary) }, ...(specimenRef ? [{ url: SLIDE_SPECIMEN_URL, valueReference: { reference: specimenRef } }] : []), ...(stain ? [{ url: 'urn:hospital-desktop:stain', valueString: stain }] : [])],
  };
  const saved = await tx.save('ImagingStudy', { ...doc, _patient: patientRef, ...(tags.source ? { _import: { source: tags.source } } : {}) }, { branch, updatedBy: ctx?.actor?.role || actor.role });
  await recordAction(tx, { runId: ctx?.runId ?? LIVE_RUN_ID, actor: ctx?.actor || actor, kind: 'create', action: 'slide.store', args: { study: id, format, files: stored.length, width: summary.width, height: summary.height, levels: levels.length, mpp: summary.mpp, metadataPatientId: summary.patientId }, branch, entityRef: `ImagingStudy/${id}`, versionId: saved.meta.versionId, patientRef, description: `stored whole-slide image ImagingStudy/${id} (${format}, ${levels.length} levels)` });
  return { status: 'stored', study: saved, reasons: [] };
}

export const slideSummary = (study) => { try { return JSON.parse((study.extension || []).find((e) => e.url === SLIDE_URL)?.valueString || 'null'); } catch { return null; } };
export const isSlideStudy = (study) => study?.resourceType === 'ImagingStudy' && (study.modality || []).some((m) => m.code === 'SM') && Boolean(slideSummary(study));

/**
 * Imports slide files from a folder: TIFF-family files one by one, DICOM whole-slide sets grouped by study.
 * Returns { files, stored, duplicate, refused: [{ file, reasons }], failed, problems, studies: Set, patients: [], created, reused, wrongPatient: [] }.
 */
export async function importSlideFolder(store, target, { dryRun = false, patient = null, createPatients = false, tags = {}, actor = DEFAULT_ACTOR } = {}) {
  const all = filesUnder(path.resolve(target));
  const totals = { files: all.length, stored: 0, duplicate: 0, failed: 0, refused: [], problems: [], studies: new Set(), patients: new Set(), created: 0, reused: 0, wrongPatient: [] };
  const mapper = patientMapper({ patient, createPatients, family: 'Pathology', tags, actor, dryRun });
  const tiffs = all.filter((f) => SLIDE_EXTENSIONS.includes(path.extname(f).toLowerCase()));
  const dicoms = all.filter((f) => !SLIDE_EXTENSIONS.includes(path.extname(f).toLowerCase()) && !/\.(json|txt|md|csv)$/i.test(f));
  const candidates = tiffs.map((file) => ({ kind: 'tiff', file, name: path.basename(file) }));
  if (dicoms.length) { const d = inspectDicomSlides(dicoms); for (const r of d.refused) totals.problems.push(r); for (const slide of d.slides) candidates.push({ kind: 'dicom', slide, name: path.basename(slide.files[0]), patientId: slide.patientId }); }
  for (const c of candidates) {
    let look = null;
    if (c.kind === 'tiff') { look = inspectSlideFile(c.file); if (!look.ok) { totals.refused.push({ file: c.name, reasons: look.refused }); totals.problems.push(`${c.name}: ${look.refused.join('; ')}`); continue; } }
    const metaPatientId = c.kind === 'tiff' ? look.info.patientId : c.patientId;
    const sourceId = metaPatientId || c.name.replace(/\.[^.]+$/, '');
    if (dryRun) { totals.stored += 1; totals.studies.add(c.name); if (look?.info.refused?.length) totals.problems.push(`${c.name}: ${look.info.refused.join('; ')}`); continue; }
    try {
      const result = await store.transaction(async (tx) => {
        const patientId = await mapper.resolve(tx, sourceId);
        if (!patientId) throw new HttpError(422, `${c.name}: no patient to attach to; use --patient <MRN> or --create-patients`);
        const p = await tx.get('Patient', patientId, { branch: 'main' });
        const wrong = metaPatientId && p && mrnOf(p) !== metaPatientId && !(p.identifier || []).some((i) => i.system === SOURCE_ID_URL && i.value.endsWith(`:${metaPatientId}`));
        const stored = await storeSlide(tx, { source: c.kind === 'tiff' ? { kind: 'tiff', file: c.file, name: c.name } : { kind: 'dicom', slide: c.slide }, patientRef: `Patient/${patientId}`, actor, tags, sourceName: tags.source || null, description: c.kind === 'dicom' ? c.slide.description : null });
        return { ...stored, patientId, wrong };
      });
      if (result.status === 'refused') { totals.refused.push({ file: c.name, reasons: result.reasons }); totals.problems.push(`${c.name}: ${result.reasons.join('; ')}`); continue; }
      totals[result.status] += 1;
      totals.studies.add(result.study.id);
      totals.patients.add(result.patientId);
      if (result.wrong) { totals.wrongPatient.push({ file: c.name, study: result.study.id, metadataPatientId: metaPatientId }); totals.problems.push(`${c.name}: the slide metadata names patient id ${metaPatientId}, which is not the MRN of the patient it was attached to (kept on the study as urn:dicom:patient-id)`); }
      if (look?.info.refused?.length) totals.problems.push(`${c.name}: ${look.info.refused.join('; ')}`);
    } catch (err) { if (!(err instanceof HttpError) && !(err instanceof TiffError)) throw err; totals.failed += 1; totals.problems.push(err.message); }
  }
  for (const v of mapper.created.values()) { if (v.reused) totals.reused += 1; else totals.created += 1; }
  totals.patients = [...totals.patients].filter((p) => !String(p).startsWith('dry-run-'));
  return totals;
}

// ---------- serving ----------
const etagOf = (...parts) => `"${createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 20)}"`;

/** Routes under /pathology/slides/{id}/... : info (logged as a slide open), tiles, label and macro. Read-only; any role. */
export function createSlideRoutes({ store }) {
  async function studyOf(id, ctx) {
    const study = await store.get('ImagingStudy', id, { branch: ctx.branch, asOf: ctx.asOf });
    if (!study || !isSlideStudy(study)) throw new HttpError(404, `Slide ${id} not found`);
    const index = slideIndex(id);
    if (!index) throw new HttpError(404, `Slide ${id} has no stored image`);
    return { study, index };
  }
  return {
    async handle(req, url, ctx) {
      const parts = url.pathname.split('/').filter(Boolean); // pathology, slides, id, ...
      const id = parts[2];
      // Upload: the file streams to disk and is registered as it is; a refused format answers with the reasons. ?patient=<id> [&slide=<Specimen id>] [&name=<file name>]
      if (req.method === 'POST' && id === 'upload') {
        if (ctx.asOf) throw new HttpError(409, 'Writes are disabled while viewing a past time');
        if (enforcedFor(ctx)) assertMayWrite(ctx.actor.role, 'ImagingStudy', 'create');
        const patientId = url.searchParams.get('patient');
        const patient = patientId ? await store.get('Patient', patientId, { branch: ctx.branch }) : null;
        if (!patient) throw new HttpError(422, 'patient (a Patient id) is required');
        const name = (url.searchParams.get('name') || 'slide.tif').replace(/[^\w.-]+/g, '_').slice(0, 120);
        const tmpDir = path.join(slidesRoot(), '.tmp'); fs.mkdirSync(tmpDir, { recursive: true });
        const tmp = path.join(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
        await new Promise((resolve, reject) => { const out = fs.createWriteStream(tmp); req.pipe(out); out.on('finish', resolve); out.on('error', reject); req.on('error', reject); });
        const slideId = url.searchParams.get('slide');
        const slideSpecimen = slideId ? await store.get('Specimen', slideId, { branch: ctx.branch }) : null;
        const stain = slideSpecimen ? (slideSpecimen.extension || []).find((e) => e.url === 'urn:hospital-desktop:stain')?.valueCoding?.display || null : null;
        const result = await store.transaction((tx) => storeSlide(tx, { source: { kind: 'tiff', file: tmp, name, temp: true }, patientRef: `Patient/${patient.id}`, specimenRef: slideSpecimen ? `Specimen/${slideSpecimen.id}` : null, orderRef: slideSpecimen?.request?.[0]?.reference || null, stain, ctx, branch: ctx.branch, sourceName: 'upload' }));
        if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
        return { status: result.status === 'refused' ? 422 : result.status === 'duplicate' ? 200 : 201, body: { status: result.status, study: result.study?.id || null, reasons: result.reasons, ...(result.status === 'refused' ? { error: result.reasons.join('; ') } : {}) } };
      }
      if (!id || req.method !== 'GET') throw new HttpError(404, `${req.method} ${url.pathname} is not available`);
      const { study, index } = await studyOf(id, ctx);
      const summary = slideSummary(study);
      if (parts[3] === 'info') {
        await store.transaction(async (tx) => { await recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'read', action: 'slide.open', args: { slide: id, levels: index.levels.length, mpp: index.mpp }, branch: ctx.branch, resources: [{ ref: `ImagingStudy/${id}`, versionId: study.meta.versionId }], entityRef: `ImagingStudy/${id}`, patientRef: study._patient, description: `slide opened: ImagingStudy/${id}` }); });
        const labelsOn = process.env.SHOW_SLIDE_LABELS === 'true';
        const patient = await store.get('Patient', study.subject.reference.split('/')[1], { branch: ctx.branch, asOf: ctx.asOf });
        const synthetic = Boolean(patient?.meta?.security?.some((s) => s.system === HTEST.system && s.code === HTEST.code));
        return { status: 200, body: { id, format: index.format, width: index.width, height: index.height, tileWidth: index.tileWidth, tileLength: index.tileLength, mpp: index.mpp, magnification: index.magnification, levels: index.levels.map((l, i) => ({ level: i, width: l.width, height: l.height, tilesAcross: l.tilesAcross, tilesDown: l.tilesDown, scale: l.width / index.width })), label: index.label ? { available: labelsOn && synthetic, reason: labelsOn ? (synthetic ? null : 'label images are shown for synthetic sources only') : 'set SHOW_SLIDE_LABELS=true to show label images (synthetic sources only)' } : null, macro: index.macro ? { available: labelsOn && synthetic } : null, description: study.description, stain: (study.extension || []).find((e) => e.url === 'urn:hospital-desktop:stain')?.valueString || null, specimen: (study.extension || []).find((e) => e.url === SLIDE_SPECIMEN_URL)?.valueReference?.reference || null, patient: study.subject.reference, metadataPatientId: summary?.patientId ?? null, refused: index.refused || [] }, headers: { 'Cache-Control': 'no-store' } };
      }
      if (parts[3] === 'tiles') {
        const level = Number(parts[4]); const m = /^(\d+)_(\d+)\.jpg$/.exec(parts[5] || '');
        if (!Number.isInteger(level) || !m || !index.levels[level]) throw new HttpError(404, `No level ${parts[4]} tile ${parts[5]}`);
        const lv = index.levels[level];
        const x = Number(m[1]); const y = Number(m[2]);
        if (x >= lv.tilesAcross || y >= lv.tilesDown) throw new HttpError(404, `Tile ${x},${y} is outside level ${level} (${lv.tilesAcross} x ${lv.tilesDown})`);
        const file = path.join(slidesRoot(), id, lv.file);
        let bytes;
        try { bytes = readTile(file, lv, x, y); } catch (err) { if (err instanceof TiffError) throw new HttpError(404, err.message); throw err; }
        return { status: 200, raw: bytes, headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400, immutable', ETag: etagOf(id, level, x, y, bytes.length) } };
      }
      if (parts[3] === 'label.jpg' || parts[3] === 'macro.jpg') {
        const aux = parts[3] === 'label.jpg' ? index.label : index.macro;
        if (!aux) throw new HttpError(404, `This slide has no ${parts[3].replace('.jpg', '')} image`);
        if (process.env.SHOW_SLIDE_LABELS !== 'true') throw new HttpError(403, 'Label and overview images are not served: they can show patient details. Set SHOW_SLIDE_LABELS=true for synthetic sources.');
        const patient = await store.get('Patient', study.subject.reference.split('/')[1], { branch: ctx.branch, asOf: ctx.asOf });
        if (!patient?.meta?.security?.some((s) => s.system === HTEST.system && s.code === HTEST.code)) throw new HttpError(403, 'Label images are shown for patients marked synthetic only');
        const file = path.join(slidesRoot(), id, aux.file);
        const bytes = index.format === 'tiff' ? readAuxImage(file, aux) : readTile(file, { ...aux, tilesAcross: 1, tilesDown: 1 }, 0, 0);
        if (!bytes) throw new HttpError(404, 'The label image is not stored as a single JPEG strip and cannot be served as is');
        return { status: 200, raw: bytes, headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store' } };
      }
      throw new HttpError(404, `${req.method} ${url.pathname} is not available`);
    },
  };
}

export { COMPRESSION, SLIDE_EXTENSIONS };
