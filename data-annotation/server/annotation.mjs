// Data Annotation → Label: labelling projects, the blind double-read queue,
// agreement statistics, adjudication and de-identified export.
//
// A project freezes a sample of chart items when it is created. Each item is
// read independently by `annotatorsPerItem` people (2 by default). A label is
// a FHIR Observation with category "annotation", written as the annotator and
// logged under the project's Run (mode "label").
//
// Blindness is a property of the queue and of this API: nobody is shown
// another reader's label for an item before adjudication. There is no login
// (by design), so it is a workflow rule, not an access control.
import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { createRun, endRun } from '../../agent-operations/server/runs.mjs';
import { cohenKappa, fleissKappa, interpretKappa, matchBoxes } from './kappa.mjs';
import { redactText, nameParts } from '../../platform/server/redact.mjs';
import { REPORT_URLS } from '../../platform/server/state-machines.mjs';
import { parse, write, TS, DICT, dicomRoot, instancePath, studyUidOf } from '../../pacs/server/dicom.mjs';
import { datasetsForPatients } from '../../platform/server/datasets.mjs';

export const TASK_TYPES = {
  classification: { label: 'Classification', sources: ['DocumentReference', 'DiagnosticReport', 'Observation', 'ImagingStudy', 'Communication'] },
  span: { label: 'Span labelling on notes', sources: ['DocumentReference', 'DiagnosticReport'] },
  bbox: { label: 'Bounding boxes on image frames', sources: ['ImagingStudy'] },
  region: { label: 'Regions on whole-slide images', sources: ['ImagingStudy'] },
  agreement: { label: 'Report–image agreement grading', sources: ['DiagnosticReport'] },
};
export const KAPPA_THRESHOLD = 0.6;
export const ANN = {
  category: 'urn:hospital-desktop:observation-category',
  project: 'urn:hospital-desktop:annotation-project',
  label: 'urn:hospital-desktop:annotation-label',
  annotator: 'urn:hospital-desktop:annotator',
  item: 'urn:hospital-desktop:annotation-item',
  role: 'urn:hospital-desktop:annotation-role',
  seconds: 'urn:hospital-desktop:annotation-seconds',
  start: 'urn:hospital-desktop:span-start',
  end: 'urn:hospital-desktop:span-end',
  box: 'urn:hospital-desktop:box',
};
const SIGNED = ['final', 'amended', 'corrected', 'appended'];
const ext = (doc, url) => (doc.extension || []).find((e) => e.url === url);
const sha = (text, n = 16) => createHash('sha256').update(text).digest('hex').slice(0, n);
const hashedUid = (salt, uid) => `2.25.${BigInt(`0x${sha(`${salt}|${uid}`, 32)}`).toString()}`;
const TAG_OF = Object.fromEntries(Object.entries(DICT).map(([tag, [, keyword]]) => [keyword, tag]));
const decode = (data) => { try { return Buffer.from(String(data || ''), 'base64').toString('utf8'); } catch { return ''; } };

/** Whitespace tokens with their character offsets. Spans are compared token by token. */
export function tokenize(text) {
  const tokens = [];
  for (const m of String(text).matchAll(/\S+/g)) tokens.push({ start: m.index, end: m.index + m[0].length });
  return tokens;
}

/** The label of every token (or "none") for one reader's spans. */
export function tokenLabels(text, spans) {
  return tokenize(text).map((t) => spans.find((s) => t.start >= s.start && t.end <= s.end)?.label ?? 'none');
}

// The text of a chart item, as the annotator sees it.
function textOf(doc) {
  if (doc.resourceType === 'DocumentReference') return decode(doc.content?.[0]?.attachment?.data);
  if (doc.resourceType === 'DiagnosticReport') {
    const part = (title, body) => (body && body.trim() ? `${title}:\n${body.trim()}` : null);
    return [part('TECHNIQUE', ext(doc, REPORT_URLS.technique)?.valueString), part('FINDINGS', ext(doc, REPORT_URLS.findings)?.valueString), part('IMPRESSION', doc.conclusion)].filter(Boolean).join('\n\n');
  }
  if (doc.resourceType === 'Communication') return (doc.payload || []).map((p) => p.contentString).filter(Boolean).join('\n\n');
  return '';
}

const display = (concept) => concept?.text || concept?.coding?.[0]?.display || concept?.coding?.[0]?.code || '';

/**
 * PS 3.15 Annex E Basic Profile, applied as an allowlist: technical image
 * attributes are kept, the three instance UIDs are replaced with hashed UIDs,
 * patient name and id get dummy values, and every other attribute (including
 * all dates, descriptions, institution, private tags) is removed.
 */
const DICOM_KEEP = ['SOPClassUID', 'Modality', 'BodyPartExamined', 'SliceThickness', 'SpacingBetweenSlices', 'ImagerPixelSpacing', 'PatientPosition', 'SeriesNumber', 'InstanceNumber',
  'ImagePositionPatient', 'ImageOrientationPatient', 'SliceLocation', 'SamplesPerPixel', 'PhotometricInterpretation', 'PlanarConfiguration', 'NumberOfFrames', 'Rows', 'Columns', 'PixelSpacing',
  'BitsAllocated', 'BitsStored', 'HighBit', 'PixelRepresentation', 'WindowCenter', 'WindowWidth', 'RescaleIntercept', 'RescaleSlope', 'RescaleType'];
export function deidentifyDicom(bytes, { salt, pseudonym = 'ANON' }) {
  const file = parse(bytes);
  const dataset = {};
  const kept = [];
  for (const keyword of DICOM_KEEP) {
    const value = file.get(keyword);
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) continue;
    dataset[keyword] = Array.isArray(value) && value.length === 1 ? value[0] : value;
    kept.push(keyword);
  }
  const replaced = [];
  for (const keyword of ['StudyInstanceUID', 'SeriesInstanceUID', 'SOPInstanceUID']) { dataset[keyword] = hashedUid(salt, file.str(keyword)); replaced.push(keyword); }
  dataset.PatientName = pseudonym; dataset.PatientID = pseudonym; replaced.push('PatientName', 'PatientID');
  let raw = file.get('PixelData');
  if (raw instanceof Uint8Array) {
    if (!file.littleEndian && file.num('BitsAllocated') === 16) { raw = new Uint8Array(raw); for (let i = 0; i + 1 < raw.length; i += 2) { const t = raw[i]; raw[i] = raw[i + 1]; raw[i + 1] = t; } }
    dataset.PixelData = raw;
  }
  const keepTags = new Set([...kept, ...replaced, 'PixelData'].map((k) => TAG_OF[k]));
  const removed = [...file.elements.keys()].filter((tag) => !keepTags.has(tag));
  return { bytes: write(dataset, { transferSyntax: TS.EXPLICIT_LE }), sopUid: dataset.SOPInstanceUID, report: { kept, replaced, removedTags: removed } };
}

export function createAnnotation({ store, fhir }) {
  const human = (ctx) => { if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Labelling is for people only'); };

  async function projectOf(id) {
    const project = await store.get('AnnotationProject', id);
    if (!project) throw new HttpError(404, `Labelling project ${id} not found`);
    return project;
  }

  // ---------- Creating a project ----------
  function cleanLabels(input, taskType) {
    if (!Array.isArray(input) || input.length < (taskType === 'bbox' || taskType === 'span' || taskType === 'region' ? 1 : 2) || input.length > 20) {
      throw new HttpError(422, 'The label schema must be a JSON array of 2 to 20 labels (1 or more for spans and boxes), for example [{"id":"normal","label":"Normal"},{"id":"abnormal","label":"Abnormal"}]');
    }
    const seen = new Set();
    return input.map((raw, i) => {
      const item = typeof raw === 'string' ? { id: raw, label: raw } : raw;
      const id = String(item?.id ?? '').trim();
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || id === 'none') throw new HttpError(422, `Label ${i + 1}: id must be 1 to 40 letters, digits, "-" or "_" (and not "none")`);
      if (seen.has(id)) throw new HttpError(422, `Label id "${id}" is used twice`);
      seen.add(id);
      return { id, label: String(item.label ?? id).slice(0, 80) };
    });
  }

  async function sample(taskType, query) {
    const type = query?.resourceType;
    if (!TASK_TYPES[taskType].sources.includes(type)) throw new HttpError(422, `${TASK_TYPES[taskType].label} can sample: ${TASK_TYPES[taskType].sources.join(', ')}`);
    const limit = query.limit == null ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new HttpError(422, 'limit must be a whole number from 1 to 500');
    const seed = Number.isInteger(query.seed) ? query.seed : 0;
    let pool = await store.query(type, {}, { branch: 'main' });
    if (query.patient) pool = pool.filter((r) => r._patient === query.patient);
    if (query.status) pool = pool.filter((r) => (r.docStatus ?? r.status) === query.status || r.status === query.status);
    if (query.code) pool = pool.filter((r) => [...(r.type?.coding || []), ...(r.code?.coding || [])].some((c) => c.code === query.code));
    if (query.category) pool = pool.filter((r) => (r.category || []).some((c) => (c.coding || []).some((x) => x.code === query.category)));
    if (query.modality) pool = pool.filter((r) => (r.modality || []).some((m) => m.code === query.modality) || (r.series || []).some((s) => s.modality?.code === query.modality));
    if (type === 'Observation') pool = pool.filter((r) => !(r.category || []).some((c) => (c.coding || []).some((x) => ['annotation', 'expert-grade'].includes(x.code))));
    if (taskType === 'span') pool = pool.filter((r) => textOf(r).trim());
    if (taskType === 'agreement') pool = pool.filter((r) => SIGNED.includes(r.status) && r.imagingStudy?.length && !ext(r, REPORT_URLS.addendumOf));
    if (taskType === 'bbox') pool = pool.filter((r) => (r.series || []).some((s) => s.instance?.length));
    if (taskType === 'region') pool = pool.filter((r) => (r.modality || []).some((m) => m.code === 'SM') && (r.extension || []).some((e) => e.url === 'urn:hospital-desktop:slide'));
    pool = pool.map((r) => [sha(`${seed}|${r.id}`), r]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, r]) => r);
    const items = [];
    const perStudy = Math.max(1, Math.min(20, Number(query.framesPerStudy) || 1));
    for (const r of pool) {
      if (items.length >= limit) break;
      const base = { ref: `${type}/${r.id}`, versionId: r.meta.versionId, patient: r._patient ?? null };
      if (taskType === 'region') { let sum = null; try { sum = JSON.parse((r.extension || []).find((e) => e.url === 'urn:hospital-desktop:slide')?.valueString || 'null'); } catch { sum = null; } if (!sum) continue; items.push({ ...base, frame: { slideId: r.id, rows: sum.height, columns: sum.width, mpp: sum.mpp ?? null, space: 'level0-pixels' } }); continue; }
      if (taskType !== 'bbox') { items.push(base); continue; }
      const series = r.series.find((s) => s.instance?.length);
      const instances = [...series.instance].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
      const picks = [...new Set(Array.from({ length: Math.min(perStudy, instances.length) }, (_, i) => Math.floor(((i + 0.5) * instances.length) / Math.min(perStudy, instances.length))))];
      for (const index of picks) {
        if (items.length >= limit) break;
        const instance = instances[index];
        const frame = { studyUid: studyUidOf(r), seriesUid: series.uid, sopUid: instance.uid, frame: 0 };
        try {
          const file = parse(fs.readFileSync(instancePath(dicomRoot(), frame.studyUid, frame.seriesUid, frame.sopUid)));
          Object.assign(frame, { rows: file.num('Rows'), columns: file.num('Columns'), frames: file.num('NumberOfFrames') ?? 1 });
          frame.frame = Math.floor(frame.frames / 2);
        } catch { continue; }
        items.push({ ...base, frame });
      }
    }
    return { items: items.map((it, i) => ({ id: `it-${String(i + 1).padStart(4, '0')}`, ...it })), query: { resourceType: type, patient: query.patient ?? null, status: query.status ?? null, code: query.code ?? null, category: query.category ?? null, modality: query.modality ?? null, limit, seed, ...(taskType === 'bbox' ? { framesPerStudy: perStudy } : {}) } };
  }

  async function createProject(body, ctx) {
    human(ctx);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) throw new HttpError(422, 'name is required');
    if (!TASK_TYPES[body.taskType]) throw new HttpError(422, `taskType must be one of ${Object.keys(TASK_TYPES).join(', ')}`);
    const labels = cleanLabels(body.labels, body.taskType);
    const readers = body.annotatorsPerItem == null ? 2 : Number(body.annotatorsPerItem);
    if (!Number.isInteger(readers) || readers < 1 || readers > 5) throw new HttpError(422, 'annotatorsPerItem must be from 1 to 5 (2 gives a blind double-read)');
    const { items, query } = await sample(body.taskType, body.sampling || {});
    if (!items.length) throw new HttpError(422, 'The sampling query matched nothing in the chart. Nothing to label');
    const run = await createRun(store, { mode: 'label', goal: `Labelling: ${name}`.slice(0, 500) }, ctx.actor);
    return store.transaction(async (tx) => {
      const saved = await tx.save('AnnotationProject', {
        resourceType: 'AnnotationProject', id: randomUUID(), name: name.slice(0, 120), taskType: body.taskType, labels,
        instructions: typeof body.instructions === 'string' ? body.instructions.slice(0, 2000) : '', sampling: query, items, annotatorsPerItem: readers,
        status: 'active', runId: run.id, createdBy: ctx.actor.id, createdAt: tx.now(),
      }, { updatedBy: ctx.actor.role });
      await recordAction(tx, { runId: run.id, actor: ctx.actor, kind: 'create', action: 'annotation.project.create', args: { project: saved.id, taskType: saved.taskType, items: items.length, annotatorsPerItem: readers }, entityRef: `AnnotationProject/${saved.id}`, versionId: saved.meta.versionId, description: `labelling project created: ${saved.name} (${items.length} items)` });
      return saved;
    });
  }

  async function closeProject(id, ctx) {
    human(ctx);
    const project = await projectOf(id);
    if (project.status === 'closed') return project;
    const { _seq, ...doc } = project;
    const saved = await store.transaction(async (tx) => {
      const out = await tx.save('AnnotationProject', { ...doc, status: 'closed', closedAt: tx.now() }, { updatedBy: ctx.actor.role });
      await recordAction(tx, { runId: project.runId, actor: ctx.actor, kind: 'update', action: 'annotation.project.close', args: { project: id }, entityRef: `AnnotationProject/${id}`, description: `labelling project closed: ${project.name}` });
      return out;
    });
    await endRun(store, project.runId, ctx.actor, 'completed');
    return saved;
  }

  // ---------- Labels as Observations ----------
  function toObservation(project, item, answer, ctx, role, now) {
    const coding = (id) => ({ coding: [{ system: ANN.label, code: id, display: project.labels.find((l) => l.id === id)?.label ?? id }] });
    const doc = {
      resourceType: 'Observation', status: 'final',
      category: [{ coding: [{ system: ANN.category, code: 'annotation', display: 'Annotation' }] }],
      code: { coding: [{ system: ANN.project, code: project.id, display: project.name }] },
      ...(item.patient ? { subject: { reference: item.patient } } : {}),
      focus: [{ reference: item.ref }],
      performer: [{ identifier: { system: ANN.annotator, value: ctx.actor.id }, display: ctx.actor.role }],
      effectiveDateTime: now,
      extension: [{ url: ANN.item, valueString: item.id }, { url: ANN.role, valueCode: role }, ...(answer.seconds != null ? [{ url: ANN.seconds, valueDecimal: answer.seconds }] : [])],
    };
    if (answer.label) doc.valueCodeableConcept = coding(answer.label);
    if (answer.spans) doc.component = answer.spans.map((s) => ({ code: coding(s.label), extension: [{ url: ANN.start, valueInteger: s.start }, { url: ANN.end, valueInteger: s.end }] }));
    if (answer.boxes) doc.component = answer.boxes.map((b) => ({ code: coding(b.label), extension: [{ url: ANN.box, extension: ['x', 'y', 'width', 'height'].map((k) => ({ url: k, valueDecimal: b[k] })) }] }));
    if ((answer.spans && !answer.spans.length) || (answer.boxes && !answer.boxes.length)) doc.valueString = 'nothing to mark';
    if (answer.comment) doc.note = [{ text: answer.comment }];
    return doc;
  }

  function fromObservation(o) {
    const code = (c) => c?.coding?.find((x) => x.system === ANN.label)?.code ?? null;
    const out = {
      id: o.id, item: ext(o, ANN.item)?.valueString, role: ext(o, ANN.role)?.valueCode ?? 'read', annotator: o.performer?.[0]?.identifier?.value ?? 'unknown',
      at: o.effectiveDateTime, seconds: ext(o, ANN.seconds)?.valueDecimal ?? null, comment: o.note?.[0]?.text ?? null, recordedAt: o._recordedAt,
    };
    if (o.valueCodeableConcept) out.label = code(o.valueCodeableConcept);
    const components = o.component || [];
    const spans = components.filter((c) => ext(c, ANN.start)).map((c) => ({ label: code(c.code), start: ext(c, ANN.start).valueInteger, end: ext(c, ANN.end).valueInteger }));
    const boxes = components.filter((c) => ext(c, ANN.box)).map((c) => ({ label: code(c.code), ...Object.fromEntries(ext(c, ANN.box).extension.map((e) => [e.url, e.valueDecimal])) }));
    if (spans.length) out.spans = spans;
    if (boxes.length) out.boxes = boxes;
    return out;
  }

  async function labelsOf(project, q = store) {
    const all = await q.query('Observation', {}, { branch: 'main' });
    const mine = all.filter((o) => o.code?.coding?.some((c) => c.system === ANN.project && c.code === project.id)).map(fromObservation);
    for (const l of mine) {
      if (project.taskType === 'span' && !l.spans) l.spans = [];
      if ((project.taskType === 'bbox' || project.taskType === 'region') && !l.boxes) l.boxes = [];
    }
    return mine.sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)) || a.id.localeCompare(b.id));
  }

  function validateAnswer(project, item, body, text) {
    const ids = new Set(project.labels.map((l) => l.id));
    const seconds = Number.isFinite(Number(body?.seconds)) && Number(body.seconds) >= 0 ? Math.round(Math.min(Number(body.seconds), 86400) * 10) / 10 : null;
    const comment = typeof body?.comment === 'string' && body.comment.trim() ? body.comment.trim().slice(0, 500) : null;
    const base = { seconds, comment };
    if (['classification', 'agreement'].includes(project.taskType)) {
      if (!ids.has(body?.label)) throw new HttpError(422, `label must be one of: ${[...ids].join(', ')}`);
      return { ...base, label: body.label };
    }
    if (project.taskType === 'span') {
      if (!Array.isArray(body?.spans) || body.spans.length > 500) throw new HttpError(422, 'spans must be an array (empty when there is nothing to mark)');
      const spans = body.spans.map((s) => ({ label: s?.label, start: Number(s?.start), end: Number(s?.end) })).sort((a, b) => a.start - b.start);
      spans.forEach((s, i) => {
        if (!ids.has(s.label)) throw new HttpError(422, `Span label must be one of: ${[...ids].join(', ')}`);
        if (!Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < 0 || s.end <= s.start || s.end > text.length) throw new HttpError(422, 'Each span needs whole-number start and end offsets inside the text');
        if (i && s.start < spans[i - 1].end) throw new HttpError(422, 'Spans must not overlap');
      });
      return { ...base, spans };
    }
    if (!Array.isArray(body?.boxes) || body.boxes.length > 200) throw new HttpError(422, 'boxes must be an array (empty when there is nothing to mark)');
    const { rows, columns } = item.frame;
    const boxes = body.boxes.map((b) => {
      const box = { label: b?.label, ...Object.fromEntries(['x', 'y', 'width', 'height'].map((k) => [k, Math.round(Number(b?.[k]) * 10) / 10])) };
      if (!ids.has(box.label)) throw new HttpError(422, `Box label must be one of: ${[...ids].join(', ')}`);
      if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width < 1 || box.height < 1 || box.x < 0 || box.y < 0 || box.x + box.width > columns + 0.5 || box.y + box.height > rows + 0.5) throw new HttpError(422, `Each box must lie inside the ${columns}×${rows} image`);
      return box;
    });
    return { ...base, boxes };
  }

  // ---------- Item content ----------
  async function resourceOf(item) {
    const [type, id] = item.ref.split('/');
    const versions = await store.history(type, id, { branch: 'main' });
    return versions.find((v) => String(v.meta.versionId) === String(item.versionId)) ?? versions.at(-1) ?? null;
  }

  async function contentOf(project, item, { names = null } = {}) {
    const doc = await resourceOf(item);
    if (!doc) return { kind: 'missing', title: 'This record is no longer available' };
    const clean = (text) => (names ? redactText(text, { names, sameLength: true }) : { text, count: 0 });
    const type = doc.resourceType;
    let redactions = 0;
    const scrub = (text) => { const r = clean(text); redactions += r.count; return r.text; };
    let out;
    if (project.taskType === 'region') {
      out = { kind: 'slide', title: display({ text: doc.description }) || 'Slide', modality: 'SM', frame: item.frame, slideId: doc.id, studyId: doc.id };
    } else if (project.taskType === 'bbox') {
      out = { kind: 'image', title: display({ text: doc.description }) || 'Image', modality: doc.series?.[0]?.modality?.code ?? null, frame: item.frame, studyId: doc.id };
    } else if (type === 'ImagingStudy') {
      out = { kind: 'study', title: doc.description || 'Imaging study', modality: doc.series?.[0]?.modality?.code ?? null, studyId: doc.id };
    } else if (type === 'Observation') {
      const q = doc.valueQuantity;
      out = { kind: 'lab', title: display(doc.code), value: q ? `${q.value} ${q.unit || ''}`.trim() : (doc.valueString ?? display(doc.valueCodeableConcept)), range: doc.referenceRange?.[0]?.text ?? (doc.referenceRange?.[0] ? `${doc.referenceRange[0].low?.value ?? ''}–${doc.referenceRange[0].high?.value ?? ''}` : null), interpretation: doc.interpretation?.[0]?.coding?.[0]?.code ?? null };
    } else {
      out = { kind: type === 'DiagnosticReport' ? 'report' : 'text', title: display(doc.type) || display(doc.code) || doc.topic?.text || type, text: scrub(textOf(doc)) };
      if (type === 'DiagnosticReport') out.studyId = doc.imagingStudy?.[0]?.reference?.split('/')[1] ?? null;
    }
    return { ...out, resourceType: type, redactions };
  }

  // ---------- Queue ----------
  const readsOf = (labels, itemId) => labels.filter((l) => l.item === itemId && l.role === 'read');
  const adjudicationOf = (labels, itemId) => labels.filter((l) => l.item === itemId && l.role === 'adjudication').at(-1) ?? null;

  async function nextItem(id, ctx, skip = []) {
    human(ctx);
    const project = await projectOf(id);
    const labels = await labelsOf(project);
    const me = ctx.actor.id;
    const open = (it) => { const reads = readsOf(labels, it.id); return reads.length < project.annotatorsPerItem && !reads.some((r) => r.annotator === me); };
    const mineDone = project.items.filter((it) => readsOf(labels, it.id).some((r) => r.annotator === me)).length;
    const available = project.status === 'active' ? project.items.filter(open) : [];
    const item = available.find((it) => !skip.includes(it.id)) ?? available[0] ?? null;
    const progress = { items: project.items.length, mine: mineDone, available: available.length, complete: project.items.filter((it) => readsOf(labels, it.id).length >= project.annotatorsPerItem).length };
    const head = { id: project.id, name: project.name, taskType: project.taskType, labels: project.labels, instructions: project.instructions, status: project.status, annotatorsPerItem: project.annotatorsPerItem };
    if (!item) return { project: head, annotator: me, item: null, progress };
    return { project: head, annotator: me, item: { id: item.id, position: project.items.indexOf(item) + 1, content: await contentOf(project, item) }, progress };
  }

  async function writeLabel(project, item, answer, ctx, role) {
    const run = await store.get('Run', project.runId);
    const actx = { actor: ctx.actor, run, runId: project.runId, branch: 'main', asOf: null, why: answer.comment ?? null, idempotencyKey: null };
    return store.transaction(async (tx) => {
      // Re-check inside the transaction so two submissions cannot both take the last read of an item.
      const labels = await labelsOf(project, tx);
      const reads = readsOf(labels, item.id);
      if (role === 'read') {
        if (reads.some((r) => r.annotator === ctx.actor.id)) throw new HttpError(409, 'You have already labelled this item');
        if (reads.length >= project.annotatorsPerItem) throw new HttpError(409, 'This item already has all its reads');
      } else {
        if (reads.some((r) => r.annotator === ctx.actor.id)) throw new HttpError(403, 'You read this item, so someone else must adjudicate it', 'forbidden');
        if (adjudicationOf(labels, item.id)) throw new HttpError(409, 'This item has already been adjudicated');
      }
      const { saved } = await fhir.writeInTx(tx, 'Observation', null, toObservation(project, item, answer, ctx, role, tx.now()), actx, { action: role === 'read' ? 'annotation.label' : 'annotation.adjudicate' });
      return fromObservation(saved);
    });
  }

  async function submit(id, itemId, body, ctx) {
    human(ctx);
    const project = await projectOf(id);
    if (project.status !== 'active') throw new HttpError(409, 'This project is closed');
    const item = project.items.find((it) => it.id === itemId);
    if (!item) throw new HttpError(404, `Item ${itemId} is not in this project`);
    const text = project.taskType === 'span' ? (await contentOf(project, item)).text : '';
    const label = await writeLabel(project, item, validateAnswer(project, item, body, text), ctx, 'read');
    return { saved: label.id, next: await nextItem(id, ctx, Array.isArray(body?.skip) ? body.skip : []) };
  }

  async function skipItem(id, itemId, ctx) {
    human(ctx);
    const project = await projectOf(id);
    if (!project.items.some((it) => it.id === itemId)) throw new HttpError(404, `Item ${itemId} is not in this project`);
    await store.transaction((tx) => recordAction(tx, { runId: project.runId, actor: ctx.actor, kind: 'execute', action: 'annotation.skip', args: { project: id, item: itemId }, entityRef: `AnnotationProject/${id}`, audit: false }));
    return { skipped: itemId };
  }

  // ---------- Agreement ----------
  /** Whether a set of reads of one item agree, and the unit ratings they contribute to kappa. */
  function compare(project, item, reads, text) {
    if (['classification', 'agreement'].includes(project.taskType)) {
      return { agree: reads.every((r) => r.label === reads[0].label), units: [reads.map((r) => r.label)] };
    }
    if (project.taskType === 'span') {
      const maps = reads.map((r) => tokenLabels(text, r.spans));
      const units = maps[0].map((_, i) => maps.map((m) => m[i]));
      return { agree: units.every((u) => u.every((x) => x === u[0])), units };
    }
    const units = project.labels.map((l) => reads.map((r) => (r.boxes.some((b) => b.label === l.id) ? 'present' : 'absent')));
    let agree = true;
    let f1 = 0; let pairs = 0;
    for (let i = 0; i < reads.length; i += 1) for (let j = i + 1; j < reads.length; j += 1) {
      const m = matchBoxes(reads[i].boxes, reads[j].boxes);
      f1 += m.f1; pairs += 1;
      if (m.f1 < 1) agree = false;
    }
    return { agree, units, boxF1: pairs ? f1 / pairs : null };
  }

  async function analyse(project) {
    const labels = await labelsOf(project);
    const need = project.annotatorsPerItem;
    const rows = [];
    for (const item of project.items) {
      const reads = readsOf(labels, item.id).slice(0, need);
      const row = { item, reads, complete: reads.length >= need, adjudication: adjudicationOf(labels, item.id) };
      if (row.complete && need >= 2) {
        const text = project.taskType === 'span' ? (await contentOf(project, item)).text : '';
        Object.assign(row, compare(project, item, reads, text));
      } else if (row.complete) row.agree = true;
      rows.push(row);
    }
    const complete = rows.filter((r) => r.complete);
    const annotators = [...new Set(labels.filter((l) => l.role === 'read').map((l) => l.annotator))].sort();
    let agreement = { statistic: null, kappa: null, n: 0, note: need < 2 ? 'Each item has one reader, so there is no agreement to measure.' : 'No item has all its reads yet.' };
    if (need >= 2 && complete.length) {
      const pairAnnotators = [...new Set(complete.flatMap((r) => r.reads.map((x) => x.annotator)))].sort();
      if (need === 2 && pairAnnotators.length === 2) {
        const pairs = complete.flatMap((r) => { const order = r.reads[0].annotator === pairAnnotators[0] ? [0, 1] : [1, 0]; return r.units.map((u) => [u[order[0]], u[order[1]]]); });
        agreement = { ...cohenKappa(pairs), note: `Cohen's κ between ${pairAnnotators.length} annotators.` };
      } else {
        agreement = { ...fleissKappa(complete.flatMap((r) => r.units)), note: need === 2 ? `Fleiss' κ, because ${pairAnnotators.length} annotators shared the double-reads (Cohen's κ needs the same two readers throughout).` : `Fleiss' κ across ${need} reads per item.` };
      }
      agreement.unit = project.taskType === 'span' ? 'word' : project.taskType === 'bbox' ? 'label present on image' : project.taskType === 'region' ? 'label present on slide' : 'item';
      agreement.reading = interpretKappa(agreement.kappa);
      if (project.taskType === 'bbox' || project.taskType === 'region') { const f = complete.map((r) => r.boxF1).filter((v) => v != null); agreement.boxF1 = f.length ? Math.round((f.reduce((a, b) => a + b, 0) / f.length) * 1000) / 1000 : null; }
      agreement.itemAgreement = Math.round((complete.filter((r) => r.agree).length / complete.length) * 1000) / 1000;
    }
    const low = need >= 2 && complete.length > 0 && (agreement.kappa == null ? complete.some((r) => !r.agree) : agreement.kappa < KAPPA_THRESHOLD);
    // The final label of an item: adjudicated, or unanimous, or (three or more readers, agreement at or above the threshold) a strict majority.
    for (const r of rows) {
      r.final = null;
      if (!r.complete) continue;
      if (r.adjudication) r.final = { source: 'adjudicated', by: r.adjudication };
      else if (r.agree) r.final = { source: need >= 2 ? 'consensus' : 'single-read', by: r.reads[0] };
      else if (!low && need >= 3 && ['classification', 'agreement'].includes(project.taskType)) {
        const tally = new Map();
        for (const x of r.reads) tally.set(x.label, (tally.get(x.label) || 0) + 1);
        const [top, n] = [...tally].sort((a, b) => b[1] - a[1])[0];
        if (n > need / 2) r.final = { source: 'majority', by: r.reads.find((x) => x.label === top) };
      }
    }
    return { labels, rows, complete, annotators, agreement, low, queue: rows.filter((r) => r.complete && !r.final) };
  }

  async function overview(project) {
    const a = await analyse(project);
    const count = (who) => a.labels.filter((l) => l.role === 'read' && l.annotator === who).length;
    const seconds = a.labels.filter((l) => l.role === 'read' && l.seconds != null).map((l) => l.seconds).sort((x, y) => x - y);
    return {
      id: project.id, name: project.name, taskType: project.taskType, taskLabel: TASK_TYPES[project.taskType].label, labels: project.labels, instructions: project.instructions,
      sampling: project.sampling, annotatorsPerItem: project.annotatorsPerItem, status: project.status, runId: project.runId, createdBy: project.createdBy, createdAt: project.createdAt,
      progress: { items: project.items.length, complete: a.complete.length, reads: a.labels.filter((l) => l.role === 'read').length, readsNeeded: project.items.length * project.annotatorsPerItem },
      annotators: a.annotators.map((id) => ({ id, reads: count(id) })),
      medianSeconds: seconds.length ? seconds[Math.floor(seconds.length / 2)] : null,
      agreement: a.agreement, threshold: KAPPA_THRESHOLD,
      adjudication: { required: a.low, waiting: a.queue.length, done: a.rows.filter((r) => r.adjudication).length, disagreements: a.complete.filter((r) => r.agree === false).length },
      resolved: a.rows.filter((r) => r.final).length,
    };
  }

  // ---------- Adjudication ----------
  async function adjudicationQueue(id, ctx) {
    human(ctx);
    const project = await projectOf(id);
    const a = await analyse(project);
    const mine = a.queue.filter((r) => !r.reads.some((x) => x.annotator === ctx.actor.id));
    const row = mine[0] ?? null;
    const letters = 'ABCDE';
    return {
      project: { id: project.id, name: project.name, taskType: project.taskType, labels: project.labels, instructions: project.instructions },
      adjudicator: ctx.actor.id, waiting: a.queue.length, forYou: mine.length, hiddenBecauseYouReadThem: a.queue.length - mine.length,
      agreement: a.agreement, required: a.low,
      item: row ? { id: row.item.id, content: await contentOf(project, row.item), reads: row.reads.map((x, i) => ({ reader: `Reader ${letters[i]}`, label: x.label ?? null, spans: x.spans ?? null, boxes: x.boxes ?? null, comment: x.comment })) } : null,
    };
  }

  async function adjudicate(id, itemId, body, ctx) {
    human(ctx);
    const project = await projectOf(id);
    const a = await analyse(project);
    const row = a.queue.find((r) => r.item.id === itemId);
    if (!row) throw new HttpError(409, 'This item is not waiting for adjudication');
    const text = project.taskType === 'span' ? (await contentOf(project, row.item)).text : '';
    await writeLabel(project, row.item, validateAnswer(project, row.item, body, text), ctx, 'adjudication');
    return adjudicationQueue(id, ctx);
  }

  // ---------- Export ----------
  async function exportData(id, ctx) {
    human(ctx);
    const project = await projectOf(id);
    const a = await analyse(project);
    const names = nameParts(await store.query('Patient', {}, { branch: 'main' }));
    const pseudonym = new Map();
    const who = (annotator) => { if (!pseudonym.has(annotator)) pseudonym.set(annotator, `annotator-${pseudonym.size + 1}`); return pseudonym.get(annotator); };
    const answer = (l) => (l ? { ...(l.label != null ? { label: l.label } : {}), ...(l.spans ? { spans: l.spans } : {}), ...(l.boxes ? { boxes: l.boxes } : {}) } : null);
    const removed = { fhirFields: ['id', 'meta', 'identifier', 'subject', 'patient', 'encounter', 'performer', 'author', 'requester', 'dates', 'free-text comments'], annotatorNames: 0, textRedactions: 0, dicomTagsRemoved: 0, dicomReplaced: [] };
    const lines = [];
    for (const r of a.rows) {
      if (!r.reads.length) continue;
      const content = await contentOf(project, r.item, { names });
      removed.textRedactions += content.redactions || 0;
      const { redactions: _r, studyId: _s, frame, ...source } = content;
      if (frame) source.image = frame.slideId ? { id: sha(`${project.id}|${frame.slideId}`), width: frame.columns, height: frame.rows, mpp: frame.mpp ?? null, coordinates: 'level-0 pixels', labelImage: 'never exported' } : { id: sha(`${project.id}|${frame.sopUid}`), width: frame.columns, height: frame.rows, frame: frame.frame };
      lines.push({
        item: r.item.id, sourceId: sha(`${project.id}|${r.item.ref}`), source,
        reads: r.reads.map((x) => ({ annotator: who(x.annotator), ...answer(x) })),
        agree: r.complete ? r.agree ?? null : null,
        final: r.final ? { source: r.final.source, ...answer(r.final.by) } : null,
      });
    }
    removed.annotatorNames = pseudonym.size;
    const manifest = {
      manifest: true, exportedAt: store.now(), project: { id: project.id, name: project.name, taskType: project.taskType, labels: project.labels, annotatorsPerItem: project.annotatorsPerItem },
      items: lines.length, resolved: lines.filter((l) => l.final).length, unresolved: lines.filter((l) => !l.final).length,
      agreement: a.agreement, adjudicationRequired: a.low,
      datasets: datasetsForPatients(a.rows.map((r) => r.item.patient)),
      deidentification: {
        fhir: 'Only the item text or value, its type and the labels are exported. Record ids are replaced by hashes, annotators by pseudonyms, and names, record numbers, dates, phone numbers and e-mail addresses inside text are masked with X characters of equal length so span offsets still line up.',
        dicom: 'PS 3.15 Annex E Basic Profile applied as an allowlist (see the image download). Pixel data is not inspected for burned-in text.',
        removed, limits: 'Pattern-based redaction of synthetic data. It is not a certified de-identification and must be reviewed before any use with real records.',
      },
    };
    return { project, analysis: a, manifest, lines, who };
  }

  async function logExport(project, ctx, format, count) {
    await store.transaction((tx) => recordAction(tx, { runId: project.runId, actor: ctx.actor, kind: 'read', action: 'annotation.export', args: { project: project.id, format, items: count }, entityRef: `AnnotationProject/${project.id}`, description: `labels exported (${format}, ${count} items, de-identified)` }));
  }

  async function exportJsonl(id, ctx) {
    const { project, manifest, lines } = await exportData(id, ctx);
    await logExport(project, ctx, 'jsonl', lines.length);
    return [manifest, ...lines].map((l) => JSON.stringify(l)).join('\n') + '\n';
  }

  async function exportCoco(id, ctx) {
    const { project, manifest, lines, analysis } = await exportData(id, ctx);
    if (project.taskType !== 'bbox' && project.taskType !== 'region') throw new HttpError(422, 'The COCO format is for bounding-box and slide-region projects. Use the JSONL export for this project');
    const categories = project.labels.map((l, i) => ({ id: i + 1, name: l.id, supercategory: 'annotation' }));
    const cat = new Map(categories.map((c) => [c.name, c.id]));
    const images = []; const annotations = []; const readerAnnotations = [];
    let report = null;
    for (const line of lines) {
      const row = analysis.rows.find((r) => r.item.id === line.item);
      const image = { id: images.length + 1, file_name: `${line.source.image.id}.${project.taskType === 'region' ? 'tif' : 'dcm'}`, width: line.source.image.width, height: line.source.image.height, frame: line.source.image.frame, item: line.item, resolved: Boolean(line.final) };
      images.push(image);
      if (!report && project.taskType === 'bbox') { try { report = deidentifyDicom(fs.readFileSync(instancePath(dicomRoot(), row.item.frame.studyUid, row.item.frame.seriesUid, row.item.frame.sopUid)), { salt: project.id }).report; } catch { /* file missing */ } }
      const box = (b, extra) => ({ image_id: image.id, category_id: cat.get(b.label), bbox: [b.x, b.y, b.width, b.height], area: Math.round(b.width * b.height * 10) / 10, iscrowd: 0, ...extra });
      for (const b of line.final?.boxes || []) annotations.push({ id: annotations.length + 1, ...box(b, { source: line.final.source }) });
      for (const read of line.reads) for (const b of read.boxes || []) readerAnnotations.push({ id: readerAnnotations.length + 1, ...box(b, { annotator: read.annotator }) });
    }
    if (report) { manifest.deidentification.removed.dicomTagsRemoved = report.removedTags.length; manifest.deidentification.removed.dicomReplaced = report.replaced; manifest.deidentification.removed.dicomKept = report.kept; }
    await logExport(project, ctx, 'coco', images.length);
    const { manifest: _m, ...info } = manifest;
    return { info: { description: `${project.name} (de-identified)`, date_created: manifest.exportedAt, ...info, imagesAt: `/agent-ops/annotation/projects/${project.id}/images/<file_name>` }, images, categories, annotations, reader_annotations: readerAnnotations };
  }

  async function exportImage(id, fileName, ctx) {
    human(ctx);
    const project = await projectOf(id);
    const hash = String(fileName).replace(/\.dcm$/, '');
    const item = project.items.find((it) => it.frame && sha(`${project.id}|${it.frame.sopUid}`) === hash);
    if (!item) throw new HttpError(404, 'That image is not part of this project');
    const out = deidentifyDicom(fs.readFileSync(instancePath(dicomRoot(), item.frame.studyUid, item.frame.seriesUid, item.frame.sopUid)), { salt: project.id });
    await logExport(project, ctx, 'dicom', 1);
    return out.bytes;
  }

  async function list() {
    const projects = (await store.query('AnnotationProject')).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { taskTypes: Object.entries(TASK_TYPES).map(([id, t]) => ({ id, ...t })), threshold: KAPPA_THRESHOLD, projects: await Promise.all(projects.map(overview)) };
  }

  async function handle(req, url, body, ctx, parts) {
    if (parts[0] !== 'annotation') return null;
    const m = req.method;
    const [, area, id, op, sub, action] = parts;
    if (area !== 'projects') return null;
    if (parts.length === 2 && m === 'GET') return { status: 200, body: await list() };
    if (parts.length === 2 && m === 'POST') return { status: 201, body: await overview(await createProject(body, ctx)) };
    if (!id) return null;
    if (parts.length === 3 && m === 'GET') return { status: 200, body: await overview(await projectOf(id)) };
    if (op === 'close' && m === 'POST') return { status: 200, body: await overview(await closeProject(id, ctx)) };
    if (op === 'next' && m === 'GET') return { status: 200, body: await nextItem(id, ctx, (url.searchParams.get('skip') || '').split(',').filter(Boolean)) };
    if (op === 'items' && sub && action === 'labels' && m === 'POST') return { status: 201, body: await submit(id, sub, body, ctx) };
    if (op === 'items' && sub && action === 'skip' && m === 'POST') return { status: 200, body: await skipItem(id, sub, ctx) };
    if (op === 'items' && sub && action === 'adjudicate' && m === 'POST') return { status: 201, body: await adjudicate(id, sub, body, ctx) };
    if (op === 'adjudication' && m === 'GET') return { status: 200, body: await adjudicationQueue(id, ctx) };
    if (op === 'export.jsonl' && m === 'GET') return { status: 200, body: await exportJsonl(id, ctx), headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': `attachment; filename="labels-${id}.jsonl"` } };
    if (op === 'export.coco.json' && m === 'GET') return { status: 200, body: await exportCoco(id, ctx), headers: { 'Content-Disposition': `attachment; filename="labels-${id}.coco.json"` } };
    if (op === 'images' && sub && m === 'GET') return { status: 200, body: Buffer.from(await exportImage(id, sub, ctx)), headers: { 'Content-Type': 'application/dicom', 'Content-Disposition': `attachment; filename="${sub}"` } };
    return null;
  }

  return { handle, createProject, overview, analyse, list };
}
