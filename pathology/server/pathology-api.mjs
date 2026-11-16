// /api/pathology/**: the case worklist, accessioning (case → part → block →
// slide), the case page, the reading lock, gross description, add-on work
// for histology, synthetic slide generation, and slide annotations.
// Reports are written through the FHIR API like radiology reports, so the
// DiagnosticReport lifecycle, the Inbox notice and the portal release
// rules apply unchanged.
import { HttpError } from '../../platform/server/http.mjs';
import { hierarchy, ellipsePolygon, mergePolygons, splitPolygon, polygonArea } from './slide-analysis.mjs';
import { enforcedFor, mayWrite, assertMayWrite } from '../../platform/server/roles.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';
import { stripInternal } from '../../platform/server/fhir-api.mjs';
import { lifecycleOf } from '../../platform/server/state-machines.mjs';
import { mrnOf } from '../../ehr/server/clinical-rules.mjs';
import { PATH_URLS, HISTOLOGY_SYSTEM, HISTOLOGY_KINDS, STAINS, STAINS_UNVERIFIED, SPECIMEN_TYPES, SYNOPTIC, SYNOPTIC_UNVERIFIED, TAT_TARGET_MINUTES, isCase, isPathologyOrder, isPathologyReport, isHistologyTask, levelOf, caseAccession, normaliseParts, caseDocuments, partDoc, blockDoc, slideDoc, stainOfSlide, stainOf, turnaround, extString, ext } from './pathology.mjs';
import { storeSlide, slideSummary, isSlideStudy, SLIDE_SPECIMEN_URL } from './slides.mjs';

const SIGNED = ['final', 'amended', 'corrected', 'appended'];
const LOCK_MINUTES = 30;
const prioOrder = { stat: 0, urgent: 1, routine: 2 };
const ANNOTATION_KINDS = { ruler: { display: 'Ruler', unit: 'um', value: 'microns', min: 2, max: 2 }, area: { display: 'Area', unit: 'um2', value: 'areaUm2', min: 3, max: 400 }, count: { display: 'Point count', unit: 'points', value: 'count', min: 1, max: 400 }, arrow: { display: 'Arrow', min: 2, max: 2 }, text: { display: 'Text note', min: 1, max: 1 }, rect: { display: 'Rectangle region', unit: 'um2', value: 'areaUm2', min: 2, max: 2 }, freehand: { display: 'Freehand region', unit: 'um2', value: 'areaUm2', min: 3, max: 2000 },
  ellipse: { display: 'Ellipse region', unit: 'um2', value: 'areaUm2', min: 2, max: 2 }, polygon: { display: 'Polygon region', unit: 'um2', value: 'areaUm2', min: 3, max: 2000 }, line: { display: 'Line', unit: 'um', value: 'microns', min: 2, max: 400 }, point: { display: 'Point', min: 1, max: 1 } };
/** The closed outline of an annotation, for containment (hierarchy) and for merging and splitting; null for lines, points and notes. */
const outlineOf = (a) => (a.kind === 'rect' && a.points?.length === 2 ? [[a.points[0][0], a.points[0][1]], [a.points[1][0], a.points[0][1]], [a.points[1][0], a.points[1][1]], [a.points[0][0], a.points[1][1]]] : a.kind === 'ellipse' && a.points?.length === 2 ? ellipsePolygon((a.points[0][0] + a.points[1][0]) / 2, (a.points[0][1] + a.points[1][1]) / 2, Math.abs(a.points[1][0] - a.points[0][0]) / 2, Math.abs(a.points[1][1] - a.points[0][1]) / 2, 32) : ['area', 'freehand', 'polygon'].includes(a.kind) && a.points?.length >= 3 ? a.points : null);
const ANNOTATION_URL = 'urn:hospital-desktop:annotation';

export function createPathologyApi({ store, fhir, analysis = null }) {
  const opts = (ctx) => ({ branch: ctx.branch, asOf: ctx.asOf });
  const writable = (ctx) => { if (ctx.asOf) throw new HttpError(409, 'Writes are disabled while viewing a past time'); };
  const lockOf = (s, now) => { const l = s._lock; if (!l) return null; return Date.parse(l.at) + LOCK_MINUTES * 60000 > Date.parse(now) ? l : null; };
  const patientRow = (p) => (p ? { id: p.id, name: `${p.name?.[0]?.family || ''}`, mrn: mrnOf(p), birthDate: p.birthDate || '', gender: p.gender || '' } : null);
  const priorityOf = (c, order) => ext(c, 'urn:hospital-desktop:priority')?.valueCode || order?.priority || 'routine';

  async function load(ctx) {
    const o = opts(ctx);
    const [specimens, patients, reports, orders, tasks, studies] = await Promise.all([store.query('Specimen', { where: (s) => Boolean(levelOf(s)) }, o), store.query('Patient', {}, o), store.query('DiagnosticReport', { where: isPathologyReport }, o), store.query('ServiceRequest', { where: isPathologyOrder }, o), store.query('Task', { where: isHistologyTask }, o), store.query('ImagingStudy', { where: isSlideStudy }, o)]);
    const byRef = new Map(patients.map((p) => [`Patient/${p.id}`, p]));
    const now = ctx.asOf ?? store.now();
    const cases = specimens.filter(isCase);
    const children = (parentId) => specimens.filter((s) => (s.parent || []).some((p) => p.reference === `Specimen/${parentId}`)).sort((a, b) => (a.identifier?.[0]?.value || '').localeCompare(b.identifier?.[0]?.value || '', undefined, { numeric: true }));
    const reportOf = (c) => reports.filter((r) => (r.specimen || []).some((s) => s.reference === `Specimen/${c.id}`) && !extString(r, PATH_URLS.addendumOf)).sort((a, b) => String(b._recordedAt).localeCompare(String(a._recordedAt)))[0] || null;
    const addendaOf = (r) => (r ? reports.filter((a) => extString(a, PATH_URLS.addendumOf) === `DiagnosticReport/${r.id}`).sort((a, b) => String(a._recordedAt).localeCompare(String(b._recordedAt))) : []);
    const studyOfSlide = (slideId) => studies.find((st) => ext(st, SLIDE_SPECIMEN_URL)?.valueReference?.reference === `Specimen/${slideId}`) || null;
    const tree = (c) => children(c.id).map((part) => ({ id: part.id, label: part.identifier?.[0]?.value || '', description: part.type?.text || '', blocks: children(part.id).map((block) => ({ id: block.id, label: block.identifier?.[0]?.value || '', slides: children(block.id).map((slide) => { const st = studyOfSlide(slide.id); const sum = st ? slideSummary(st) : null; const stain = stainOfSlide(slide); return { id: slide.id, label: slide.identifier?.[0]?.value || '', stain: stain?.display || null, stainCode: stain?.code || null, stainKind: STAINS.find((x) => x.code === stain?.code)?.kind || null, study: st ? { id: st.id, description: st.description, width: sum?.width, height: sum?.height, mpp: sum?.mpp, magnification: sum?.magnification, levels: sum?.levels?.length ?? 0, metadataPatientId: sum?.patientId ?? null } : null }; }) })) }));
    const row = (c) => {
      const order = orders.find((x) => `ServiceRequest/${x.id}` === c.request?.[0]?.reference) || null;
      const report = reportOf(c);
      const priority = priorityOf(c, order);
      const pending = tasks.filter((t) => ['requested', 'accepted', 'in-progress', 'ready'].includes(t.status) && ext(t, PATH_URLS.caseRef)?.valueReference?.reference === `Specimen/${c.id}`);
      const parts = tree(c);
      const slides = parts.flatMap((p) => p.blocks.flatMap((b) => b.slides));
      const signedAt = report && SIGNED.includes(report.status) ? report.issued || report._recordedAt : null;
      const tat = turnaround(c, signedAt, now, priority);
      return { id: c.id, accession: c.accessionIdentifier?.value || '', patient: patientRow(byRef.get(c.subject?.reference)), type: c.type?.text || '', priority, state: lifecycleOf(c), receivedAt: c.receivedTime || c._recordedAt, collectedAt: c.collection?.collectedDateTime || null, gross: c.note?.[0]?.text || '', lock: lockOf(c, now),
        status: !report ? 'unread' : SIGNED.includes(report.status) ? 'read' : 'draft', reportId: report?.id ?? null, signedAt, turnaroundMinutes: tat.minutes, targetMinutes: tat.target, overTarget: tat.over,
        order: order ? { id: order.id, reason: order.reasonCode?.[0]?.text || '', history: order.note?.[0]?.text || '', requester: order.requester?.display || '', authoredOn: order.authoredOn || order._recordedAt, priority: order.priority || 'routine', code: order.code?.text || order.code?.coding?.[0]?.display || 'Surgical pathology' } : null,
        stains: [...new Set(slides.map((s) => s.stain).filter(Boolean))], slideCount: slides.length, slidesWithImages: slides.filter((s) => s.study).length, pendingWork: pending.map((t) => ({ id: t.id, kind: t.code?.coding?.[0]?.code, text: t.code?.text, block: t.focus?.reference?.split('/')[1] || null, status: t.status })), parts };
    };
    return { now, cases, specimens, reports, orders, tasks, studies, byRef, row, reportOf, addendaOf, tree };
  }

  function metrics(rows, now) {
    const today = now.slice(0, 10);
    const signed = rows.filter((r) => r.status === 'read');
    const signedToday = signed.filter((r) => r.signedAt?.slice(0, 10) === today);
    const mins = signed.map((r) => r.turnaroundMinutes).sort((a, b) => a - b);
    return { signedToday: signedToday.length, unread: rows.filter((r) => r.status === 'unread').length, draft: rows.filter((r) => r.status === 'draft').length, medianTurnaroundMinutes: mins.length ? mins[Math.floor(mins.length / 2)] : null, overTarget: rows.filter((r) => r.status !== 'read' && r.overTarget).length, targets: TAT_TARGET_MINUTES };
  }

  async function detail(id, ctx) {
    const L = await load(ctx);
    const c = L.cases.find((x) => x.id === id);
    if (!c) throw new HttpError(404, `Case ${id} not found`);
    const r = L.row(c);
    const report = L.reportOf(c);
    const priors = L.reports.filter((x) => x.subject?.reference === c.subject?.reference && SIGNED.includes(x.status) && !extString(x, PATH_URLS.addendumOf) && !(x.specimen || []).some((s) => s.reference === `Specimen/${c.id}`)).map((x) => { const cs = L.cases.find((k) => (x.specimen || []).some((s) => s.reference === `Specimen/${k.id}`)); return { id: x.id, accession: cs?.accessionIdentifier?.value || '', signedAt: x.issued || x._recordedAt, conclusion: x.conclusion || '', type: cs?.type?.text || '' }; }).sort((a, b) => String(b.signedAt).localeCompare(String(a.signedAt)));
    return { case: r, report: stripInternal(report), addenda: L.addendaOf(report).map(stripInternal), priors, stains: STAINS, stainsUnverified: STAINS_UNVERIFIED, synoptic: SYNOPTIC, synopticUnverified: SYNOPTIC_UNVERIFIED, histologyKinds: HISTOLOGY_KINDS, now: L.now };
  }

  // ---------- accessioning ----------
  async function accession(body, ctx) {
    writable(ctx);
    if (enforcedFor(ctx)) assertMayWrite(ctx.actor.role, 'Specimen', 'create');
    const type = SPECIMEN_TYPES.includes(body?.type) ? body.type : null;
    if (!type) throw new HttpError(422, `type must be one of ${SPECIMEN_TYPES.join(', ')}`);
    const parts = normaliseParts(body?.parts || [{ description: body?.description || type, blocks: [{ slides: ['HE'] }] }]);
    const result = await store.transaction(async (tx) => {
      const now = tx.now();
      let order = null; let patientRef = null;
      if (body.order) { order = await tx.get('ServiceRequest', body.order, { branch: ctx.branch }); if (!order || !isPathologyOrder(order)) throw new HttpError(404, `Pathology order ${body.order} not found`); patientRef = order.subject.reference; }
      else if (body.patient) { const p = await tx.get('Patient', body.patient, { branch: ctx.branch }); if (!p) throw new HttpError(404, `Patient ${body.patient} not found`); patientRef = `Patient/${p.id}`; }
      else throw new HttpError(422, 'An order id or a patient id is required');
      const existing = (await tx.query('Specimen', { where: isCase }, { branch: ctx.branch }));
      if (order && existing.some((c) => c.request?.[0]?.reference === `ServiceRequest/${order.id}`)) throw new HttpError(409, 'This order already has a case');
      const accessionNo = caseAccession(now, existing);
      const priority = ['stat', 'urgent', 'routine'].includes(body.priority) ? body.priority : (order?.priority || 'routine');
      const gross = String(body.gross || '').trim().slice(0, 4000) || null;
      const { caseDoc, common } = caseDocuments({ accession: accessionNo, patientRef, orderRef: order ? `ServiceRequest/${order.id}` : null, type, collectedAt: body.collectedAt || now, receivedAt: now, gross, collector: body.collector || null, priority });
      const made = (await fhir.writeInTx(tx, 'Specimen', null, caseDoc, ctx, { action: 'pathology.accession' })).saved;
      const { _seq, ...caseNow } = made;
      const received = (await fhir.writeInTx(tx, 'Specimen', made.id, { ...caseNow, extension: caseNow.extension.map((e) => (e.url === 'urn:hospital-desktop:lifecycle' ? { ...e, valueCode: 'received' } : e)) }, ctx, { action: 'pathology.receive' })).saved;
      const tree = [];
      for (const part of parts) {
        const p = (await fhir.writeInTx(tx, 'Specimen', null, partDoc(common, received.id, part), ctx, { action: 'pathology.part' })).saved;
        const blocks = [];
        for (const block of part.blocks) {
          const b = (await fhir.writeInTx(tx, 'Specimen', null, blockDoc(common, p.id, block), ctx, { action: 'pathology.block' })).saved;
          const slides = [];
          for (let i = 0; i < block.slides.length; i += 1) slides.push((await fhir.writeInTx(tx, 'Specimen', null, slideDoc(common, b.id, `${block.label}-${i + 1}`, block.slides[i]), ctx, { action: 'pathology.slide' })).saved.id);
          blocks.push({ id: b.id, label: block.label, slides });
        }
        tree.push({ id: p.id, label: part.label, blocks });
      }
      if (order && lifecycleOf(order) === 'active') { const { _seq: s2, ...o } = order; await fhir.writeInTx(tx, 'ServiceRequest', order.id, { ...o, note: [...(o.note || []), { time: now, text: `Accessioned as ${accessionNo}` }] }, ctx, { action: 'pathology.order-note' }); }
      return { id: received.id, accession: accessionNo, tree };
    });
    return { status: 201, body: result };
  }

  // ---------- add-on work and slide generation ----------
  async function addon(id, body, ctx) {
    writable(ctx);
    if (enforcedFor(ctx)) assertMayWrite(ctx.actor.role, 'Task', 'create');
    const kind = HISTOLOGY_KINDS[body?.kind] ? body.kind : null;
    if (!kind) throw new HttpError(422, `kind must be one of ${Object.keys(HISTOLOGY_KINDS).join(', ')}`);
    const stain = kind === 'stain' ? stainOf(body.stain) : null;
    if (kind === 'stain' && !stain) throw new HttpError(422, 'An additional stain needs a stain from the list');
    const task = await store.transaction(async (tx) => {
      const c = await tx.get('Specimen', id, { branch: ctx.branch });
      if (!c || !isCase(c)) throw new HttpError(404, `Case ${id} not found`);
      const block = await tx.get('Specimen', body.block, { branch: ctx.branch });
      if (!block || levelOf(block) !== 'block') throw new HttpError(404, `Block ${body.block} not found`);
      const label = block.identifier?.[0]?.value || '';
      const text = `${HISTOLOGY_KINDS[kind]}${stain ? ` · ${stain.display}` : ''}`;
      return (await fhir.writeInTx(tx, 'Task', null, {
        resourceType: 'Task', status: 'requested', intent: 'order', priority: ext(c, 'urn:hospital-desktop:priority')?.valueCode || 'routine', authoredOn: tx.now(), for: { reference: c.subject.reference }, focus: { reference: `Specimen/${block.id}` },
        code: { coding: [{ system: HISTOLOGY_SYSTEM, code: kind, display: HISTOLOGY_KINDS[kind] }], text }, description: `Case ${c.accessionIdentifier?.value || ''} block ${label}: ${text}${body.note ? ` (${String(body.note).slice(0, 200)})` : ''}`,
        requester: { display: ctx.actor.id }, owner: { display: 'Histology' }, extension: [{ url: PATH_URLS.caseRef, valueReference: { reference: `Specimen/${c.id}` } }, ...(stain ? [{ url: PATH_URLS.stain, valueCoding: { system: 'urn:hospital-desktop:stain', code: stain.code, display: stain.display } }] : [])],
      }, ctx, { action: 'pathology.addon' })).saved;
    });
    return { status: 201, body: { id: task.id, kind, stain: stain?.display || null, status: task.status } };
  }

  /** No slide image is made up here: slides are scanned and uploaded or imported. */
  async function generate() { throw new HttpError(410, 'Slide images are not generated. Upload the scanned slide, or import a folder: npm run import -- --slides <folder>'); }

  async function gross(id, body, ctx) {
    writable(ctx);
    if (enforcedFor(ctx)) assertMayWrite(ctx.actor.role, 'Specimen', 'update');
    const text = String(body?.text || '').trim().slice(0, 4000);
    await store.transaction(async (tx) => {
      const c = await tx.get('Specimen', id, { branch: ctx.branch });
      if (!c || !isCase(c)) throw new HttpError(404, `Case ${id} not found`);
      const { _seq, ...d } = c;
      await fhir.writeInTx(tx, 'Specimen', id, { ...d, note: text ? [{ text, time: tx.now() }] : [] }, ctx, { action: 'pathology.gross' });
    });
    return { status: 200, body: { id, gross: text } };
  }

  // ---------- slide annotations ----------
  const annotationOf = (o) => { let g = {}; try { g = JSON.parse(extString(o, ANNOTATION_URL) || '{}'); } catch { g = {}; } return { id: o.id, kind: o.code?.coding?.[0]?.code, value: o.valueQuantity?.value ?? (o.valueInteger ?? null), unit: o.valueQuantity?.unit ?? null, text: o.note?.[0]?.text || null, by: o.performer?.[0]?.display || null, at: o.effectiveDateTime || null, ...g }; };
  const isSlideAnnotation = (o) => o.status === 'preliminary' && (o.category || []).some((c) => (c.coding || []).some((k) => k.code === 'slide-annotation'));
  async function annotations(slideId, req, parts, body, ctx) {
    const study = await store.get('ImagingStudy', slideId, opts(ctx));
    if (!study || !isSlideStudy(study)) throw new HttpError(404, `Slide ${slideId} not found`);
    if (req.method === 'GET') {
      const all = await store.query('Observation', { patient: study._patient, where: isSlideAnnotation }, opts(ctx));
      const list = all.filter((o) => (o.derivedFrom || []).some((d) => d.reference === `ImagingStudy/${slideId}`)).map(annotationOf);
      // Hierarchy: each closed shape sits in the smallest closed shape that contains it.
      const closed = list.map((a) => ({ id: a.id, points: outlineOf(a) })).filter((a) => a.points);
      const parents = hierarchy(closed);
      return { status: 200, body: { annotations: list.map((a) => ({ ...a, parent: parents.get(a.id) ?? null })) } };
    }
    writable(ctx);
    if (req.method === 'POST' && !parts[0]) {
      const spec = ANNOTATION_KINDS[body?.kind];
      if (!spec) throw new HttpError(422, `kind must be one of ${Object.keys(ANNOTATION_KINDS).join(', ')}`);
      if (!Array.isArray(body.points) || body.points.length < spec.min || body.points.length > spec.max) throw new HttpError(422, `${spec.display} needs ${spec.min === spec.max ? spec.min : `${spec.min} to ${spec.max}`} points`);
      const points = body.points.map((p) => (Array.isArray(p) ? [Math.round(Number(p[0])), Math.round(Number(p[1]))] : [Math.round(Number(p.x)), Math.round(Number(p.y))]));
      if (points.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) throw new HttpError(422, 'points must be level-0 pixel coordinates');
      // Class (with its colour), the method and parameters that made a result, and where an imported shape came from, travel with the geometry.
      const geometry = { points, label: body.label ? String(body.label).slice(0, 80) : null, space: 'level0-pixels', class: body.class ? String(body.class).slice(0, 60) : (body.label ? String(body.label).slice(0, 60) : null), colour: /^#[0-9a-fA-F]{6}$/.test(body.colour || '') ? body.colour : null,
        ...(body.method ? { method: String(body.method).slice(0, 160), params: body.params && typeof body.params === 'object' ? body.params : null, analysis: body.analysis ? String(body.analysis) : null } : {}),
        ...(body.imported ? { imported: { source: String(body.imported.source || 'GeoJSON').slice(0, 40), file: body.imported.file ? String(body.imported.file).slice(0, 120) : null, by: ctx.actor.id, at: store.now() } } : {}) };
      const value = spec.value ? Number(body[spec.value]) : null;
      const text = ['text', 'arrow'].includes(body.kind) ? String(body.text || '').slice(0, 500) : null;
      if (body.kind === 'text' && !text) throw new HttpError(422, 'A text note needs text');
      const doc = {
        resourceType: 'Observation', status: 'preliminary', category: [{ coding: [{ system: 'urn:hospital-desktop:category', code: 'slide-annotation', display: 'Slide annotation' }] }],
        code: { coding: [{ system: 'urn:hospital-desktop:slide-annotation', code: body.kind, display: spec.display }], text: `${spec.display} on ${study.description || 'slide'}` },
        subject: { reference: study.subject.reference }, derivedFrom: [{ reference: `ImagingStudy/${slideId}` }], effectiveDateTime: store.now(), performer: [{ display: ctx.actor.id }],
        ...(spec.value && Number.isFinite(value) ? { valueQuantity: { value: Math.round(value * 100) / 100, unit: spec.unit } } : {}), ...(text ? { note: [{ text }] } : {}),
        extension: [{ url: ANNOTATION_URL, valueString: JSON.stringify(geometry) }],
      };
      const saved = await store.transaction(async (tx) => (await fhir.writeInTx(tx, 'Observation', null, doc, ctx, { action: 'slide.annotate' })).saved);
      return { status: 201, body: annotationOf(saved) };
    }
    if (req.method === 'PUT' && parts[0]) {
      // Editing: move or reshape (points), rename, or change class. The measured value is sent again by the viewer.
      const saved = await store.transaction(async (tx) => {
        const o = await tx.get('Observation', parts[0], { branch: ctx.branch });
        if (!o || !isSlideAnnotation(o) || !(o.derivedFrom || []).some((d) => d.reference === `ImagingStudy/${slideId}`)) throw new HttpError(404, `annotation ${parts[0]} not found`);
        const spec = ANNOTATION_KINDS[o.code?.coding?.[0]?.code]; let g = {}; try { g = JSON.parse(extString(o, ANNOTATION_URL) || '{}'); } catch { g = {}; }
        if (Array.isArray(body?.points)) { if (body.points.length < spec.min || body.points.length > spec.max) throw new HttpError(422, `${spec.display} needs ${spec.min === spec.max ? spec.min : `${spec.min} to ${spec.max}`} points`); g.points = body.points.map((p) => [Math.round(Number(p[0])), Math.round(Number(p[1]))]); if (g.points.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) throw new HttpError(422, 'points must be level-0 pixel coordinates'); }
        if (body?.class !== undefined) { g.class = body.class ? String(body.class).slice(0, 60) : null; g.label = g.class; }
        if (body?.colour !== undefined) g.colour = /^#[0-9a-fA-F]{6}$/.test(body.colour || '') ? body.colour : null;
        g.editedBy = ctx.actor.id; g.editedAt = store.now();
        const value = spec.value ? Number(body?.[spec.value]) : NaN;
        const { _seq, ...rest } = o;
        return (await fhir.writeInTx(tx, 'Observation', o.id, { ...rest, ...(Number.isFinite(value) ? { valueQuantity: { value: Math.round(value * 100) / 100, unit: spec.unit } } : {}), extension: [...(rest.extension || []).filter((e) => e.url !== ANNOTATION_URL), { url: ANNOTATION_URL, valueString: JSON.stringify(g) }] }, ctx, { action: 'slide.annotation.edit' })).saved;
      });
      return { status: 200, body: annotationOf(saved) };
    }
    // Merge the shapes named into their union, or split one shape along a drawn line. The originals are removed; the results are new annotations.
    if (req.method === 'POST' && ['merge', 'split'].includes(parts[0])) {
      const ids = (Array.isArray(body?.ids) ? body.ids : [body?.id]).filter(Boolean).map(String);
      const out = await store.transaction(async (tx) => {
        const olds = []; for (const id of ids) { const o = await tx.get('Observation', id, { branch: ctx.branch }); if (!o || !isSlideAnnotation(o) || !(o.derivedFrom || []).some((d) => d.reference === `ImagingStudy/${slideId}`)) throw new HttpError(404, `annotation ${id} not found`); const a = annotationOf(o); const outline = outlineOf(a); if (!outline) throw new HttpError(422, 'Only closed shapes can be merged or split'); olds.push({ o, a, outline }); }
        if (parts[0] === 'merge' && olds.length < 2) throw new HttpError(422, 'Pick at least two shapes to merge');
        if (parts[0] === 'split' && (olds.length !== 1 || !Array.isArray(body?.line) || body.line.length < 2)) throw new HttpError(422, 'Pick one shape and draw a line across it');
        const pieces = parts[0] === 'merge' ? mergePolygons(olds.map((x) => x.outline)) : splitPolygon(olds[0].outline, body.line.map((p) => [Number(p[0]), Number(p[1])]));
        if (parts[0] === 'split' && pieces.length < 2) throw new HttpError(422, 'The line does not cut the shape in two');
        const mpp = slideSummary(study)?.mpp ?? null; const first = olds[0].a; const made = [];
        for (const pts of pieces) {
          const areaUm2 = mpp ? polygonArea(pts) * mpp * mpp : null;
          const g = { points: pts.slice(0, 2000), label: first.class || first.label || null, class: first.class || first.label || null, colour: first.colour || null, space: 'level0-pixels', method: parts[0] === 'merge' ? 'Merged in the viewer' : 'Split in the viewer', params: { from: ids } };
          const doc = { resourceType: 'Observation', status: 'preliminary', category: [{ coding: [{ system: 'urn:hospital-desktop:category', code: 'slide-annotation', display: 'Slide annotation' }] }], code: { coding: [{ system: 'urn:hospital-desktop:slide-annotation', code: 'polygon', display: ANNOTATION_KINDS.polygon.display }], text: `Polygon region on ${study.description || 'slide'}` }, subject: { reference: study.subject.reference }, derivedFrom: [{ reference: `ImagingStudy/${slideId}` }], effectiveDateTime: store.now(), performer: [{ display: ctx.actor.id }], ...(areaUm2 != null ? { valueQuantity: { value: Math.round(areaUm2 * 100) / 100, unit: 'um2' } } : {}), extension: [{ url: ANNOTATION_URL, valueString: JSON.stringify(g) }] };
          made.push(annotationOf((await fhir.writeInTx(tx, 'Observation', null, doc, ctx, { action: `slide.annotation.${parts[0]}` })).saved));
        }
        for (const { o } of olds) { const { _seq, ...rest } = o; await fhir.writeInTx(tx, 'Observation', o.id, { ...rest, status: 'cancelled' }, ctx, { action: 'slide.annotation.remove' }); }
        return made;
      });
      return { status: 201, body: { annotations: out, removed: ids } };
    }
    if (req.method === 'DELETE' && parts[0]) {
      await store.transaction(async (tx) => {
        const o = await tx.get('Observation', parts[0], { branch: ctx.branch });
        if (!o || !isSlideAnnotation(o) || !(o.derivedFrom || []).some((d) => d.reference === `ImagingStudy/${slideId}`)) throw new HttpError(404, `annotation ${parts[0]} not found`);
        const { _seq, ...rest } = o;
        await fhir.writeInTx(tx, 'Observation', o.id, { ...rest, status: 'cancelled' }, ctx, { action: 'slide.annotation.remove' });
      });
      return { status: 200, body: { id: parts[0], removed: true } };
    }
    throw new HttpError(404, `${req.method} is not available for annotations`);
  }

  return {
    async handle(req, url, body, ctx) {
      const parts = url.pathname.split('/').filter(Boolean).slice(2);
      const m = req.method;
      const me = ctx.actor.id;
      if (parts[0] === 'worklist' && m === 'GET') {
        const L = await load(ctx);
        const rows = L.cases.map(L.row);
        const queue = url.searchParams.get('queue') || 'my';
        const type = url.searchParams.get('type'); const stain = url.searchParams.get('stain');
        const visible = rows.filter((r) => (queue === 'all' || (r.status !== 'read' && (!r.lock || r.lock.by === me))) && (!type || type === 'All' || r.type === type) && (!stain || stain === 'All' || r.stains.includes(stain)))
          .sort((a, b) => prioOrder[a.priority] - prioOrder[b.priority] || String(a.receivedAt).localeCompare(String(b.receivedAt)));
        const looseSlides = L.studies.filter((st) => !ext(st, SLIDE_SPECIMEN_URL)?.valueReference?.reference).map((st) => { const sum = slideSummary(st); return { id: st.id, patient: patientRow(L.byRef.get(st.subject?.reference)), name: sum?.files?.[0]?.name || st.description || 'Slide', description: st.description || null, width: sum?.width ?? null, height: sum?.height ?? null, levels: sum?.levels?.length ?? null, receivedAt: st.started || st._recordedAt }; }).sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
        const shown = visible;
        return { status: 200, body: { looseSlides, now: L.now, reader: me, rows: shown, more: visible.length - shown.length, metrics: metrics(rows, L.now), counts: { my: rows.filter((r) => r.status !== 'read' && (!r.lock || r.lock.by === me)).length, all: rows.length, pendingStains: rows.reduce((n, r) => n + r.pendingWork.length, 0) }, types: SPECIMEN_TYPES, stains: STAINS, pendingOrders: L.orders.filter((o) => lifecycleOf(o) === 'active' && !L.cases.some((c) => c.request?.[0]?.reference === `ServiceRequest/${o.id}`)).map((o) => ({ id: o.id, patient: patientRow(L.byRef.get(o.subject?.reference)), reason: o.reasonCode?.[0]?.text || '', priority: o.priority || 'routine', authoredOn: o.authoredOn || o._recordedAt, requester: o.requester?.display || '', code: o.code?.text || 'Surgical pathology' })) } };
      }
      if (parts[0] === 'cases' && !parts[1] && m === 'POST') return accession(body || {}, ctx);
      if (parts[0] === 'cases' && parts[1]) {
        const id = parts[1];
        if (m === 'GET' && parts.length === 2) return { status: 200, body: await detail(id, ctx) };
        if (m === 'POST' && ['open', 'close'].includes(parts[2])) {
          writable(ctx);
          const readOnlyReader = enforcedFor(ctx) && !mayWrite(ctx.actor.role, 'DiagnosticReport', 'create');
          const result = await store.transaction(async (tx) => {
            const c = await tx.get('Specimen', id, { branch: ctx.branch });
            if (!c || !isCase(c)) throw new HttpError(404, `Case ${id} not found`);
            const now = tx.now();
            const held = lockOf(c, now);
            const { _seq, ...doc } = c;
            const log = (action, args, description) => recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: action === 'case.open' ? 'read' : 'execute', action, args, branch: ctx.branch, resources: [{ ref: `Specimen/${id}`, versionId: c.meta.versionId }], entityRef: `Specimen/${id}`, patientRef: c._patient, description });
            if (readOnlyReader) { if (parts[2] === 'open') await log('case.open', { case: id, readOnly: true }, `case opened read-only: Specimen/${id}`); return { lock: held, readOnly: true }; }
            if (parts[2] === 'close') { if (held?.by !== me) return { lock: held }; delete doc._lock; await tx.save('Specimen', doc, { branch: ctx.branch, updatedBy: ctx.actor.role }); await log('case.unlock', { case: id }, `case lock released: Specimen/${id}`); return { lock: null }; }
            if (held && held.by !== me && !body?.force) return { lock: held, locked: true };
            const lock = { by: me, role: ctx.actor.role, at: now };
            await tx.save('Specimen', { ...doc, _lock: lock }, { branch: ctx.branch, updatedBy: ctx.actor.role });
            await log('case.open', { case: id, tookOver: held && held.by !== me ? held.by : null }, `case opened for sign-out: Specimen/${id}`);
            return { lock };
          });
          return { status: result.locked ? 423 : 200, body: result };
        }
        if (m === 'PUT' && parts[2] === 'gross') return gross(id, body || {}, ctx);
        if (m === 'POST' && parts[2] === 'addon') return addon(id, body || {}, ctx);
        if (m === 'POST' && parts[2] === 'slides' && parts[3] === 'generate') return generate(id, body || {}, ctx);
      }
      if (parts[0] === 'slides' && parts[1] && parts[2] === 'annotations') return annotations(parts[1], req, parts.slice(3), body, ctx);
      if (analysis) { const out = await analysis.handle(req, url, body, ctx, parts); if (out) return out; }
      if (parts[0] === 'reference' && m === 'GET') return { status: 200, body: { stains: STAINS, stainsUnverified: STAINS_UNVERIFIED, specimenTypes: SPECIMEN_TYPES, synoptic: SYNOPTIC, synopticUnverified: SYNOPTIC_UNVERIFIED, histologyKinds: HISTOLOGY_KINDS, targets: TAT_TARGET_MINUTES } };
      throw new HttpError(404, `${m} ${url.pathname} is not available`);
    },
  };
}
