// Slide analysis on this server: tissue detection, cell detection, object
// and pixel classifiers with stored versions, the wand, measurements with an exported table, named
// reusable workflows and batch jobs over every slide of a case. The image maths is in
// ./slide-analysis.mjs (our own code). Every run is a TraceStep; every result is kept with its
// method and parameters and is readable by agents that may read the slide.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';
import { enforcedFor, mayWrite } from '../../platform/server/roles.mjs';
import { slideIndex, slidesRoot, isSlideStudy, SLIDE_SPECIMEN_URL } from './slides.mjs';
import { readTile } from '../../viewers/server/tiff.mjs';
import { decodeJpeg } from '../../viewers/server/jpeg.mjs';
import * as A from './slide-analysis.mjs';

export const ANALYSIS_KINDS = { tissue: 'Tissue detection', cells: 'Cell detection', pixels: 'Pixel classification', measure: 'Measurements', wand: 'Wand selection' };
export const METHOD = {
  tissue: 'Otsu threshold on optical density at low resolution, closed, small pieces removed',
  cells: 'Colour deconvolution, Gaussian smoothing, Otsu threshold, distance transform and seeded watershed',
  pixels: 'Multinomial logistic regression on colour, stain amounts and local brightness',
  objects: 'Multinomial logistic regression on the measured cell features',
  wand: 'Region growing on colour distance from the clicked pixel',
};

/** Reads a rectangle of a slide as RGB from the level whose pixel count fits `maxPixels` (or the given level). region is in full-resolution pixels. */
export function readRegion(studyId, region, { level = null, maxPixels = A.MAX_REGION_PIXELS } = {}) {
  const index = slideIndex(studyId);
  if (!index) throw new HttpError(404, `Slide ${studyId} has no stored image`);
  const r = { x: Math.max(0, Math.floor(region?.x ?? 0)), y: Math.max(0, Math.floor(region?.y ?? 0)) };
  r.w = Math.min(index.width - r.x, Math.ceil(region?.w ?? index.width)); r.h = Math.min(index.height - r.y, Math.ceil(region?.h ?? index.height));
  if (!(r.w > 0 && r.h > 0)) throw new HttpError(422, 'The region is outside the slide');
  let li = level;
  if (li == null) { li = index.levels.length - 1; for (let i = 0; i < index.levels.length; i += 1) { const s = index.width / index.levels[i].width; if ((r.w / s) * (r.h / s) <= maxPixels) { li = i; break; } } }
  const lv = index.levels[li]; if (!lv) throw new HttpError(422, `The slide has no level ${level}`);
  const scale = index.width / lv.width;
  const x0 = Math.floor(r.x / scale); const y0 = Math.floor(r.y / scale); const w = Math.max(1, Math.min(lv.width - x0, Math.ceil(r.w / scale))); const h = Math.max(1, Math.min(lv.height - y0, Math.ceil(r.h / scale)));
  if (w * h > maxPixels) throw new HttpError(422, `The region is ${w} x ${h} pixels at this resolution; at most ${maxPixels} pixels (${Math.round(Math.sqrt(maxPixels))} x ${Math.round(Math.sqrt(maxPixels))}) can be analysed at once. Select a smaller region or a lower resolution.`);
  const rgb = new Uint8Array(w * h * 3).fill(255); const file = path.join(slidesRoot(), studyId, lv.file);
  for (let ty = Math.floor(y0 / lv.tileLength); ty <= Math.floor((y0 + h - 1) / lv.tileLength); ty += 1) for (let tx = Math.floor(x0 / lv.tileWidth); tx <= Math.floor((x0 + w - 1) / lv.tileWidth); tx += 1) {
    if (tx >= lv.tilesAcross || ty >= lv.tilesDown) continue;
    let tile; try { tile = decodeJpeg(readTile(file, lv, tx, ty)); } catch { continue; }
    const ox = tx * lv.tileWidth; const oy = ty * lv.tileLength;
    for (let y = Math.max(y0, oy); y < Math.min(y0 + h, oy + tile.height); y += 1) for (let x = Math.max(x0, ox); x < Math.min(x0 + w, ox + tile.width); x += 1) {
      const s = ((y - oy) * tile.width + (x - ox)) * tile.channels; const d = ((y - y0) * w + (x - x0)) * 3;
      if (tile.channels === 3) { rgb[d] = tile.data[s]; rgb[d + 1] = tile.data[s + 1]; rgb[d + 2] = tile.data[s + 2]; } else { rgb[d] = tile.data[s]; rgb[d + 1] = tile.data[s]; rgb[d + 2] = tile.data[s]; }
    }
  }
  return { rgb, w, h, level: li, scale, origin: [x0 * scale, y0 * scale], mpp: index.mpp ? index.mpp * scale : null, slide: { width: index.width, height: index.height, mpp: index.mpp, levels: index.levels.length } };
}

export function createPathologyAnalysis({ store }) {
  const opts = (ctx) => ({ branch: ctx.branch, asOf: ctx.asOf });
  const jobs = new Map();
  const slideOf = async (id, ctx) => { const study = await store.get('ImagingStudy', id, opts(ctx)); if (!study || !isSlideStudy(study)) throw new HttpError(404, `Slide ${id} not found`); return study; };
  const mayRun = (ctx) => { if (ctx.asOf) throw new HttpError(409, 'Writes are disabled while viewing a past time'); if (enforcedFor(ctx) && !mayWrite(ctx.actor.role, 'Observation', 'create')) throw new HttpError(403, 'This role may not run slide analysis'); };
  const light = ({ cells, classMap, polygons, _seq, ...rest }) => ({ ...rest, cells: cells ? cells.length : undefined, polygons: polygons ? polygons.length : undefined });
  const toFull = (pts, reg) => pts.map((p) => [Math.round(p[0] * reg.scale + reg.origin[0]), Math.round(p[1] * reg.scale + reg.origin[1])]);
  async function latestClassifier(reader, idOrName, ctx) {
    const all = await reader.query('SlideClassifier', {}, opts(ctx));
    const byId = all.find((c) => c.id === idOrName); if (byId) return byId;
    return all.filter((c) => c.name === idOrName).sort((a, b) => b.version - a.version)[0] || null;
  }

  /** Runs one analysis on one slide and stores the result. */
  async function run(slideId, body, ctx) {
    const kind = body?.kind;
    if (!ANALYSIS_KINDS[kind]) throw new HttpError(422, `kind must be one of ${Object.keys(ANALYSIS_KINDS).join(', ')}`);
    const study = await slideOf(slideId, ctx);
    const p = body.params && typeof body.params === 'object' ? body.params : {};
    const stains = A.STAINS[p.stains] ? p.stains : 'HE';
    const started = Date.now();
    let result; let reg;
    if (kind === 'tissue') {
      reg = readRegion(slideId, null, { maxPixels: 1024 * 1024 });
      const out = A.detectTissue(reg.rgb, reg.w, reg.h, { minAreaFraction: Number(p.minAreaFraction) || 0.002 });
      const polygons = out.polygons.map((pg) => ({ points: toFull(pg.points, reg), areaUm2: reg.mpp ? Math.round(pg.area * reg.mpp * reg.mpp) : null }));
      result = { polygons, summary: { pieces: polygons.length, tissueFraction: Math.round(out.tissueFraction * 1000) / 1000, threshold: out.threshold } };
    } else if (kind === 'cells') {
      if (!body.region) throw new HttpError(422, 'Select a region first: cell detection runs inside a region');
      reg = readRegion(slideId, body.region, { level: Number.isInteger(body.level) ? body.level : 0 });
      const out = A.detectNuclei(reg.rgb, reg.w, reg.h, { stains, sigma: Number(p.sigma) || 1, minArea: Number(p.minArea) || 12, maxArea: Number(p.maxArea) || 4000, threshold: p.threshold != null ? Number(p.threshold) : null, mpp: reg.mpp });
      if (out.cells.length > 50000) throw new HttpError(422, `${out.cells.length} cells were found; at most 50000 are kept per run. Select a smaller region.`);
      const cells = out.cells.map((c) => ({ ...c, x: Math.round(c.x * reg.scale + reg.origin[0]), y: Math.round(c.y * reg.scale + reg.origin[1]), radius: Math.round(c.radius * reg.scale * 10) / 10, class: null }));
      const mean = (k) => (cells.length ? Math.round((cells.reduce((s, c) => s + (c[k] || 0), 0) / cells.length) * 100) / 100 : null);
      result = { cells, summary: { cells: cells.length, meanAreaUm2: mean('areaUm2'), meanCircularity: mean('circularity'), meanNucleusStain: mean('nucleusStain'), threshold: out.threshold, densityPerMm2: reg.mpp && cells.length ? Math.round(cells.length / ((reg.w * reg.h * reg.mpp * reg.mpp) / 1e6)) : null } };
    } else if (kind === 'pixels') {
      const model = await latestClassifier(store, String(body.classifier || ''), ctx);
      if (!model || model.kind !== 'pixel') throw new HttpError(422, 'classifier must name a pixel classifier');
      reg = readRegion(slideId, body.region || null, { level: Number.isInteger(body.level) ? body.level : null, maxPixels: 1024 * 1024 });
      const out = A.classifyPixels(reg.rgb, reg.w, reg.h, model.model, model.stains || stains);
      const pxUm2 = reg.mpp ? reg.mpp * reg.mpp : null; const total = reg.w * reg.h;
      const polygons = [];
      model.model.classes.forEach((cls, k) => { if (model.background === cls) return; const mask = new Uint8Array(total); for (let i = 0; i < total; i += 1) mask[i] = out.classMap[i] === k ? 1 : 0; for (const pg of A.maskPolygons(mask, reg.w, reg.h, { minArea: Math.max(16, total * 0.0005), tolerance: 1, max: 200 })) polygons.push({ class: cls, points: toFull(pg.points, reg), areaUm2: pxUm2 ? Math.round(pg.area * pxUm2) : null }); });
      result = { polygons, summary: { classifier: `${model.name} v${model.version}`, classes: Object.fromEntries(Object.entries(out.counts).map(([c, n]) => [c, { fraction: Math.round((n / total) * 1000) / 1000, areaUm2: pxUm2 ? Math.round(n * pxUm2) : null }])) } };
    } else if (kind === 'wand') {
      const half = Math.max(64, Math.min(4096, Number(p.window) || 1024));
      reg = readRegion(slideId, { x: Number(body.x) - half, y: Number(body.y) - half, w: half * 2, h: half * 2 }, { maxPixels: 512 * 512 });
      const out = A.wand(reg.rgb, reg.w, reg.h, (Number(body.x) - reg.origin[0]) / reg.scale, (Number(body.y) - reg.origin[1]) / reg.scale, { tolerance: Number(p.tolerance) || 24 });
      if (out.polygon.length < 3) throw new HttpError(422, 'Nothing similar was found under the click');
      result = { polygons: [{ points: toFull(out.polygon, reg), areaUm2: reg.mpp ? Math.round(out.pixels * reg.mpp * reg.mpp) : null }], summary: { pixels: out.pixels, capped: out.capped, touchesWindow: out.capped } };
    } else {
      // measure: area, perimeter, counts and mean stain amounts for each annotation given (full-resolution polygons)
      const list = Array.isArray(body.annotations) ? body.annotations.slice(0, 500) : [];
      if (!list.length) throw new HttpError(422, 'annotations must list the shapes to measure');
      const index = slideIndex(slideId); const rows = [];
      for (const a of list) {
        const pts = (a.points || []).map((q) => [Number(q[0]), Number(q[1])]); const row = { id: a.id ?? null, kind: a.kind || 'region', class: a.class || a.label || null, count: a.kind === 'count' ? pts.length : 0, areaUm2: null, perimeterUm: null, mean: null, pixelsMeasured: 0 };
        if (pts.length >= 3 && a.kind !== 'count') {
          const xs = pts.map((q) => q[0]); const ys = pts.map((q) => q[1]);
          const r = readRegion(slideId, { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1 }, { maxPixels: 512 * 512 });
          const m = A.measureRegion(r.rgb, r.w, r.h, pts, { scale: r.scale, origin: r.origin, stains, mpp: index.mpp });
          Object.assign(row, { areaUm2: m.areaUm2 != null ? Math.round(m.areaUm2 * 100) / 100 : null, perimeterUm: m.perimeterUm != null ? Math.round(m.perimeterUm * 100) / 100 : null, areaPx: Math.round(m.areaPx), mean: m.mean, pixelsMeasured: m.pixelsMeasured });
        } else if (pts.length === 2 && a.kind !== 'count') row.lengthUm = index.mpp ? Math.round(Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) * index.mpp * 100) / 100 : null;
        rows.push(row);
      }
      reg = { level: null, scale: 1, origin: [0, 0], w: 0, h: 0, mpp: index.mpp };
      result = { rows, byClass: A.summariseByClass(rows), summary: { annotations: rows.length, stains } };
    }
    const doc = { resourceType: 'SlideAnalysis', id: randomUUID(), _groupKey: slideId, slide: slideId, kind, method: METHOD[kind] || 'Area, perimeter and mean stain amount by colour deconvolution', params: { ...p, stains }, region: body.region || null, level: reg.level, pixels: [reg.w, reg.h], ...result, version: 1, basedOn: null, workflow: body.workflow || null, ms: Date.now() - started, createdBy: ctx.actor.id, createdByKind: ctx.actor.kind, createdAt: store.now() };
    if (body.store === false) return doc;
    return store.transaction(async (tx) => {
      const saved = await tx.save('SlideAnalysis', doc, { branch: ctx.branch, updatedBy: ctx.actor.role });
      await recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'execute', action: `slide.analysis.${kind}`, args: { slide: slideId, analysis: saved.id, method: doc.method, params: doc.params, region: doc.region, level: doc.level, ...doc.summary, ms: doc.ms }, branch: ctx.branch, entityRef: `ImagingStudy/${slideId}`, patientRef: study.subject?.reference, description: `${ANALYSIS_KINDS[kind]} on slide ${slideId}` });
      return saved;
    });
  }

  /** Trains a classifier from examples and stores it as the next version of its name. */
  async function train(body, ctx) {
    const kind = body?.kind === 'pixel' ? 'pixel' : 'object'; const name = String(body?.name || '').trim().slice(0, 60);
    if (!name) throw new HttpError(422, 'Give the classifier a name');
    const stains = A.STAINS[body?.stains] ? body.stains : 'HE';
    const samples = [];
    if (kind === 'object') {
      // examples: [{ analysis, cell (index), label }] from one or more cell detections, or [{ features, label }]
      const cache = new Map();
      for (const ex of (body.examples || []).slice(0, 5000)) {
        if (Array.isArray(ex.features)) { samples.push({ features: ex.features.map(Number), label: String(ex.label) }); continue; }
        if (!cache.has(ex.analysis)) cache.set(ex.analysis, await store.get('SlideAnalysis', String(ex.analysis), opts(ctx)));
        const cell = cache.get(ex.analysis)?.cells?.[ex.cell];
        if (!cell) throw new HttpError(422, `Example cell ${ex.cell} of analysis ${ex.analysis} does not exist`);
        samples.push({ features: A.featuresOf(cell), label: String(ex.label) });
      }
    } else {
      // examples: [{ slide, label, points }] painted areas (full-resolution polygons); pixels inside are sampled at the working resolution
      for (const ex of (body.examples || []).slice(0, 200)) {
        const pts = (ex.points || []).map((q) => [Number(q[0]), Number(q[1])]); if (pts.length < 3) continue;
        await slideOf(String(ex.slide), ctx);
        const xs = pts.map((q) => q[0]); const ys = pts.map((q) => q[1]);
        const r = readRegion(String(ex.slide), { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1 }, { level: Number.isInteger(body.level) ? body.level : null, maxPixels: 256 * 256 });
        const mask = A.rasterize([pts], r.w, r.h, { scale: r.scale, origin: r.origin }); const f = A.pixelFeatures(r.rgb, r.w, r.h, stains);
        const inside = []; for (let i = 0; i < mask.length; i += 1) if (mask[i]) inside.push(i);
        const step = Math.max(1, Math.floor(inside.length / 300)); // at most 300 pixels per painted area
        for (let k = 0; k < inside.length; k += step) samples.push({ features: f(inside[k]), label: String(ex.label) });
      }
    }
    if (samples.length < 2) throw new HttpError(422, 'Give examples first: label some cells, or paint areas for each class');
    let model; try { model = A.trainClassifier(samples, kind === 'pixel' ? { minSd: A.PIXEL_MIN_SD } : {}); } catch (err) { throw new HttpError(422, err.message); }
    return store.transaction(async (tx) => {
      const earlier = (await tx.query('SlideClassifier', {}, { branch: ctx.branch })).filter((c) => c.name === name);
      const version = Math.max(0, ...earlier.map((c) => c.version)) + 1;
      const doc = { resourceType: 'SlideClassifier', id: randomUUID(), name, kind, version, stains, features: kind === 'pixel' ? A.PIXEL_FEATURES : A.FEATURES, method: kind === 'pixel' ? METHOD.pixels : METHOD.objects, model, examples: samples.length, perClass: Object.fromEntries(model.classes.map((c) => [c, samples.filter((s) => s.label === c).length])), background: body.background ? String(body.background) : null, trainedBy: ctx.actor.id, trainedAt: tx.now() };
      const saved = await tx.save('SlideClassifier', doc, { branch: ctx.branch, updatedBy: ctx.actor.role });
      await recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'execute', action: 'slide.classifier.train', args: { classifier: saved.id, name, kind, version, classes: model.classes, examples: samples.length, trainingAccuracy: Math.round(model.trainingAccuracy * 1000) / 1000 }, branch: ctx.branch, entityRef: `SlideClassifier/${saved.id}`, description: `classifier ${name} v${version} trained` });
      return saved;
    });
  }
  /** Classes every cell of a detection with an object classifier; stored as a new version of that analysis. */
  async function classify(analysisId, body, ctx) {
    const base = await store.get('SlideAnalysis', analysisId, opts(ctx));
    if (!base || base.kind !== 'cells') throw new HttpError(404, 'No such cell detection');
    const c = await latestClassifier(store, String(body?.classifier || ''), ctx);
    if (!c || c.kind !== 'object') throw new HttpError(422, 'classifier must name an object classifier');
    const cells = base.cells.map((cell) => { const p = A.predict(c.model, A.featuresOf(cell)); return { ...cell, class: p.label, probability: Math.round(p.probability * 100) / 100 }; });
    const counts = Object.fromEntries(c.model.classes.map((k) => [k, cells.filter((x) => x.class === k).length]));
    const { _seq, meta, ...rest } = base;
    const doc = { ...rest, id: randomUUID(), cells, version: (base.version || 1) + 1, basedOn: base.id, classifier: { id: c.id, name: c.name, version: c.version }, summary: { ...base.summary, classes: counts, classifier: `${c.name} v${c.version}` }, createdBy: ctx.actor.id, createdByKind: ctx.actor.kind, createdAt: store.now() };
    return store.transaction(async (tx) => {
      const saved = await tx.save('SlideAnalysis', doc, { branch: ctx.branch, updatedBy: ctx.actor.role });
      await recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'execute', action: 'slide.analysis.classify', args: { slide: base.slide, analysis: saved.id, basedOn: base.id, classifier: `${c.name} v${c.version}`, classes: counts }, branch: ctx.branch, entityRef: `ImagingStudy/${base.slide}`, description: `cells classed with ${c.name} v${c.version}` });
      return saved;
    });
  }

  // ---------- named workflows and batch jobs ----------
  function normalizeWorkflow(body) {
    const name = String(body?.name || '').trim().slice(0, 60); if (!name) throw new HttpError(422, 'Give the workflow a name');
    const steps = (Array.isArray(body.steps) ? body.steps : []).slice(0, 10).map((s) => { if (!['tissue', 'cells', 'pixels', 'classify'].includes(s?.kind)) throw new HttpError(422, 'A workflow step is tissue, cells, pixels or classify'); return { kind: s.kind, params: s.params && typeof s.params === 'object' ? s.params : {}, region: s.region ?? (s.kind === 'cells' ? 'tissue' : null), classifier: s.classifier ? String(s.classifier) : null, level: Number.isInteger(s.level) ? s.level : null }; });
    if (!steps.length) throw new HttpError(422, 'A workflow needs at least one step');
    return { name, steps, description: String(body.description || '').slice(0, 300) };
  }
  /** Runs a workflow's steps on one slide. "cells" with region "tissue" runs inside the largest tissue piece, cut down to the size limit around its centre. */
  async function runWorkflow(wf, slideId, ctx) {
    const out = []; let tissue = null; let lastCells = null;
    for (const step of wf.steps) {
      if (step.kind === 'tissue') { tissue = await run(slideId, { kind: 'tissue', params: step.params, workflow: wf.name }, ctx); out.push(tissue); }
      else if (step.kind === 'cells') {
        let region = step.region && typeof step.region === 'object' ? step.region : null;
        if (!region) { if (!tissue) tissue = await run(slideId, { kind: 'tissue', store: false }, ctx); const big = tissue.polygons[0]; const index = slideIndex(slideId); const side = Math.floor(Math.sqrt(A.MAX_REGION_PIXELS)); if (big) { const xs = big.points.map((q) => q[0]); const ys = big.points.map((q) => q[1]); const cx = (Math.min(...xs) + Math.max(...xs)) / 2; const cy = (Math.min(...ys) + Math.max(...ys)) / 2; const w = Math.min(side, Math.max(...xs) - Math.min(...xs)); const h = Math.min(side, Math.max(...ys) - Math.min(...ys)); region = { x: Math.max(0, cx - w / 2), y: Math.max(0, cy - h / 2), w, h }; } else region = { x: 0, y: 0, w: Math.min(side, index.width), h: Math.min(side, index.height) }; }
        lastCells = await run(slideId, { kind: 'cells', region, level: step.level ?? 0, params: step.params, workflow: wf.name }, ctx); out.push(lastCells);
      } else if (step.kind === 'pixels') out.push(await run(slideId, { kind: 'pixels', classifier: step.classifier, region: step.region && typeof step.region === 'object' ? step.region : null, level: step.level, params: step.params, workflow: wf.name }, ctx));
      else if (step.kind === 'classify') { if (!lastCells) throw new HttpError(422, 'A classify step needs a cells step before it'); lastCells = await classify(lastCells.id, { classifier: step.classifier }, ctx); out.push(lastCells); }
    }
    return out;
  }
  async function slidesOfCase(caseId, ctx) {
    const all = await store.query('ImagingStudy', { where: isSlideStudy }, opts(ctx));
    const specimens = await store.query('Specimen', {}, opts(ctx));
    const parentOf = new Map(specimens.map((s) => [s.id, s.parent?.[0]?.reference?.split('/')[1] || null]));
    const inCase = (sid) => { let at = sid; for (let i = 0; i < 6 && at; i += 1) { if (at === caseId) return true; at = parentOf.get(at); } return false; };
    return all.filter((st) => { const ref = (st.extension || []).find((e) => e.url === SLIDE_SPECIMEN_URL)?.valueReference?.reference; return ref && inCase(ref.split('/')[1]) && slideIndex(st.id); }).map((st) => st.id);
  }
  /** A background job: the workflow on every slide of a case (or the slides listed), one after another, with progress. */
  async function startBatch(body, ctx) {
    const wf = body?.workflow && typeof body.workflow === 'object' ? normalizeWorkflow(body.workflow) : (await store.query('SlideWorkflow', {}, opts(ctx))).filter((w) => w.id === body?.workflow || w.name === body?.workflow).sort((a, b) => b.version - a.version)[0];
    if (!wf) throw new HttpError(422, 'workflow must be a saved workflow (id or name) or a workflow object');
    const slides = Array.isArray(body.slides) && body.slides.length ? body.slides.map(String) : body.case ? await slidesOfCase(String(body.case), ctx) : [];
    if (!slides.length) throw new HttpError(422, 'There are no slides with images to run on');
    const job = { id: randomUUID(), workflow: wf.name, case: body.case || null, total: slides.length, done: 0, failed: 0, status: 'running', startedAt: store.now(), finishedAt: null, results: [], by: ctx.actor.id };
    jobs.set(job.id, job); if (jobs.size > 50) jobs.delete(jobs.keys().next().value);
    await store.transaction((tx) => recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'execute', action: 'slide.batch.start', args: { job: job.id, workflow: wf.name, slides: slides.length, case: job.case }, branch: ctx.branch, description: `batch ${wf.name} on ${slides.length} slides` }));
    job.promise = (async () => {
      for (const slideId of slides) {
        try { const made = await runWorkflow(wf, slideId, ctx); job.results.push({ slide: slideId, ok: true, analyses: made.map((m) => ({ id: m.id, kind: m.kind, summary: m.summary })) }); }
        catch (err) { job.failed += 1; job.results.push({ slide: slideId, ok: false, error: String(err.message).slice(0, 300) }); }
        job.done += 1;
        await new Promise((r) => setImmediate(r)); // let other requests in between slides
      }
      job.status = job.failed === job.total ? 'failed' : 'finished'; job.finishedAt = store.now();
      await store.transaction((tx) => recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'execute', action: 'slide.batch.end', args: { job: job.id, workflow: wf.name, done: job.done, failed: job.failed }, branch: ctx.branch, description: `batch ${wf.name} finished` })).catch(() => {});
    })();
    return job;
  }
  const jobView = ({ promise, ...j }) => j;

  return {
    run, train, classify, runWorkflow, readRegion,
    waitForJobs: () => Promise.all([...jobs.values()].map((j) => j.promise)),
    /** Routes under /api/pathology: slides/:id/analyses, analyses/:id/classify, classifiers, workflows, batch. Returns null when the path is not ours. */
    async handle(req, url, body, ctx, parts) {
      const m = req.method;
      if (parts[0] === 'slides' && parts[1] && parts[2] === 'analyses') {
        const slideId = parts[1]; await slideOf(slideId, ctx);
        const mine = async () => (await store.query('SlideAnalysis', { groupKey: slideId }, opts(ctx))).filter((a) => !a.removed);
        if (m === 'GET' && !parts[3]) return { status: 200, body: { analyses: (await mine()).map(light).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))), kinds: ANALYSIS_KINDS, stains: Object.fromEntries(Object.entries(A.STAINS).map(([k, v]) => [k, v.name])), maxRegionPixels: A.MAX_REGION_PIXELS } };
        if (m === 'GET' && parts[3]) { const a = (await mine()).find((x) => x.id === parts[3]); if (!a) throw new HttpError(404, 'No such analysis'); const { _seq, ...rest } = a; return { status: 200, body: rest }; }
        mayRun(ctx);
        if (m === 'POST' && !parts[3]) { const saved = await run(slideId, body || {}, ctx); const { _seq, ...rest } = saved; return { status: 201, body: rest }; }
        if (m === 'POST' && parts[4] === 'classify') { const saved = await classify(parts[3], body || {}, ctx); const { _seq, ...rest } = saved; return { status: 201, body: rest }; }
        if (m === 'DELETE' && parts[3]) { const a = (await mine()).find((x) => x.id === parts[3]); if (!a) throw new HttpError(404, 'No such analysis'); const { _seq, ...rest } = a; await store.save('SlideAnalysis', { ...rest, removed: true, cells: undefined, polygons: undefined }, { branch: ctx.branch, updatedBy: ctx.actor.role }); return { status: 200, body: { id: a.id, removed: true } }; }
      }
      if (parts[0] === 'classifiers') {
        if (m === 'GET') return { status: 200, body: { classifiers: (await store.query('SlideClassifier', {}, opts(ctx))).map(({ model, _seq, ...c }) => ({ ...c, classes: model.classes, trainingAccuracy: model.trainingAccuracy })).sort((a, b) => a.name.localeCompare(b.name) || b.version - a.version), features: { object: A.FEATURES, pixel: A.PIXEL_FEATURES } } };
        if (m === 'POST') { mayRun(ctx); const saved = await train(body || {}, ctx); const { model, _seq, ...c } = saved; return { status: 201, body: { ...c, classes: model.classes, trainingAccuracy: model.trainingAccuracy } }; }
      }
      if (parts[0] === 'workflows') {
        if (m === 'GET') return { status: 200, body: { workflows: (await store.query('SlideWorkflow', {}, opts(ctx))).filter((w) => !w.removed).map(({ _seq, ...w }) => w).sort((a, b) => a.name.localeCompare(b.name) || b.version - a.version) } };
        if (m === 'POST') { mayRun(ctx); const wf = normalizeWorkflow(body); const saved = await store.transaction(async (tx) => { const earlier = (await tx.query('SlideWorkflow', {}, { branch: ctx.branch })).filter((w) => w.name === wf.name); const doc = await tx.save('SlideWorkflow', { resourceType: 'SlideWorkflow', id: randomUUID(), ...wf, version: Math.max(0, ...earlier.map((w) => w.version)) + 1, savedBy: ctx.actor.id, savedAt: tx.now() }, { branch: ctx.branch, updatedBy: ctx.actor.role }); await recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'create', action: 'slide.workflow.save', args: { workflow: doc.id, name: doc.name, version: doc.version, steps: doc.steps.map((s) => s.kind) }, branch: ctx.branch, entityRef: `SlideWorkflow/${doc.id}`, description: `workflow ${doc.name} v${doc.version} saved` }); return doc; }); const { _seq, ...rest } = saved; return { status: 201, body: rest }; }
      }
      if (parts[0] === 'batch') {
        if (m === 'POST' && !parts[1]) { mayRun(ctx); return { status: 202, body: jobView(await startBatch(body || {}, ctx)) }; }
        if (m === 'GET' && parts[1]) { const j = jobs.get(parts[1]); if (!j) throw new HttpError(404, 'No such job'); return { status: 200, body: jobView(j) }; }
        if (m === 'GET') return { status: 200, body: { jobs: [...jobs.values()].map(jobView).reverse() } };
      }
      return null;
    },
  };
}
