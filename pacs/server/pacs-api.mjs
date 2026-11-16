// /api/pacs/**: worklist, reading lock, priority and turnaround metrics.
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../platform/server/http.mjs';
import { parse as parseDicom, SOP_CLASS } from '../../viewers/dicom/dicom.js';
import { enforcedFor, mayWrite, assertMayWrite } from '../../platform/server/roles.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';
import { stripInternal } from '../../platform/server/fhir-api.mjs';
import { REPORT_URLS } from '../../platform/server/state-machines.mjs';
import { mrnOf } from '../../ehr/server/clinical-rules.mjs';
import { studyUidOf, accessionOf, extensionOf, PRIORITY_URL, RECEIVED_URL } from './dicom.mjs';

export const PRIORITIES = ['stat', 'urgent', 'routine'];
export const TARGET_MINUTES = { stat: 60, urgent: 240, routine: 1440 };
const LOCK_MINUTES = 30;
const SIGNED = ['final', 'amended', 'corrected', 'appended'];
const isAddendum = (r) => (r.extension || []).some((e) => e.url === REPORT_URLS.addendumOf);
const reportsOf = (reports, study) => reports.filter((r) => (r.imagingStudy || []).some((x) => x.reference === `ImagingStudy/${study.id}`));
const priorityOf = (study) => extensionOf(study, PRIORITY_URL) || 'routine';
const receivedOf = (study) => extensionOf(study, RECEIVED_URL) || study.started || study._recordedAt;
const bodyPartOf = (study) => study.series?.find((s) => s.bodySite?.display)?.bodySite.display || '';
const modalityOf = (study) => study.modality?.[0]?.code || study.series?.[0]?.modality?.code || 'OT';
const lockOf = (study, now) => (study._lock && Date.parse(now) - Date.parse(study._lock.at) < LOCK_MINUTES * 60000 ? study._lock : null);

/** The most recent earlier study of the same modality and body part. */
export function findPrior(study, all) {
  return all
    .filter((s) => s.id !== study.id && s.subject?.reference === study.subject?.reference && modalityOf(s) === modalityOf(study)
      && (!bodyPartOf(s) || !bodyPartOf(study) || bodyPartOf(s) === bodyPartOf(study)) && String(s.started || '') < String(study.started || ''))
    .sort((a, b) => String(b.started).localeCompare(String(a.started)))[0] ?? null;
}

export function createPacsApi({ store, fhir = null, onOpen = null }) {
  function row(study, patient, reports, all, now) {
    const mine = reportsOf(reports, study).filter((r) => !isAddendum(r));
    const report = mine.find((r) => SIGNED.includes(r.status)) || mine.find((r) => r.status === 'preliminary') || null;
    const name = patient?.name?.[0] || {};
    return {
      id: study.id, studyUid: studyUidOf(study), accession: accessionOf(study), started: study.started || null, receivedAt: receivedOf(study),
      modality: modalityOf(study), bodyPart: bodyPartOf(study), description: study.description || '', priority: priorityOf(study),
      status: !report ? 'unread' : SIGNED.includes(report.status) ? 'read' : 'draft', reportId: report?.id ?? null, signedAt: report?.issued ?? null,
      lock: lockOf(study, now), referrer: study.referrer?.display || '', reason: study.reasonCode?.[0]?.text || '',
      seriesCount: study.series?.length ?? 0, instanceCount: study.numberOfInstances ?? 0, priorId: findPrior(study, all)?.id ?? null,
      patient: patient ? { id: patient.id, name: `${name.family || ''}`, mrn: mrnOf(patient), birthDate: patient.birthDate || '', gender: patient.gender || '' } : null,
      series: (study.series || []).map((s) => ({ uid: s.uid, number: s.number, modality: s.modality?.code, description: s.description, instances: s.instance?.length ?? 0, frames: (s.instance || []).reduce((n, i) => n + (Number(i.title) || 1), 0), middle: s.instance?.[Math.floor((s.instance.length - 1) / 2)]?.uid, transferSyntax: extensionOf(s, 'urn:hospital-desktop:transfer-syntax'), compression: extensionOf(s, 'urn:hospital-desktop:compression') })),
    };
  }

  function metrics(rows, now) {
    const today = now.slice(0, 10);
    const read = rows.filter((r) => r.status === 'read' && r.signedAt?.slice(0, 10) === today);
    const minutes = (r) => (Date.parse(r.signedAt) - Date.parse(r.receivedAt)) / 60000;
    const by = Object.fromEntries(PRIORITIES.map((p) => {
      const list = read.filter((r) => r.priority === p);
      return [p, { count: list.length, meanMinutes: list.length ? Math.round(list.reduce((n, r) => n + minutes(r), 0) / list.length) : null, target: TARGET_MINUTES[p] }];
    }));
    const within = read.filter((r) => minutes(r) <= TARGET_MINUTES[r.priority]).length;
    return { readToday: read.length, byPriority: by, withinTargetPercent: read.length ? Math.round((within / read.length) * 100) : null, unread: rows.filter((r) => r.status === 'unread').length };
  }

  async function load(ctx) {
    const opts = { branch: ctx.branch, asOf: ctx.asOf };
    const [studies, patients, reports] = await Promise.all([store.query('ImagingStudy', {}, opts), store.query('Patient', {}, opts), store.query('DiagnosticReport', {}, opts)]);
    const byRef = new Map(patients.map((p) => [`Patient/${p.id}`, p]));
    const now = ctx.asOf ?? store.now();
    return { studies, reports, now, rows: studies.map((s) => row(s, byRef.get(s.subject?.reference), reports, studies, now)) };
  }

  const writable = (ctx) => { if (ctx.asOf) throw new HttpError(409, 'Writes are disabled while viewing a past time'); };

  // Measurements drawn on the images (length, angle, rectangle ROI) persist as preliminary Observations derived from the study, so they survive a reload and show in the chart. Removing one cancels it.
  const ANNOTATION_URL = 'urn:hospital-desktop:annotation';
  const MEASURES = { length: { display: 'Length', unit: 'mm', value: 'mm' }, angle: { display: 'Angle', unit: 'deg', value: 'degrees' }, roi: { display: 'Rectangle ROI area', unit: 'mm2', value: 'areaMm2' },
    cobb: { display: 'Cobb angle', unit: 'deg', value: 'degrees' }, ellipse: { display: 'Ellipse region area', unit: 'mm2', value: 'areaMm2' }, freehand: { display: 'Freehand region area', unit: 'mm2', value: 'areaMm2' },
    probe: { display: 'Value at a point', unit: 'HU', value: 'hu', minPoints: 1 }, bidirectional: { display: 'Bidirectional (long axis)', unit: 'mm', value: 'mm' }, arrow: { display: 'Arrow note', unit: null, value: null } };
  const numOrNull = (v) => (v != null && Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);
  const isAnnotation = (o) => o.category?.some((c) => c.coding?.some((k) => k.code === 'image-measurement')) && o.status === 'preliminary';
  const annotationOf = (o) => { let geometry = {}; try { geometry = JSON.parse(extensionOf(o, ANNOTATION_URL) || '{}'); } catch { geometry = {}; } return { id: o.id, kind: o.code?.coding?.[0]?.code, value: o.valueQuantity?.value ?? null, unit: o.valueQuantity?.unit ?? null, by: o.performer?.[0]?.display || null, at: o.effectiveDateTime || null, ...geometry }; };
  async function listAnnotations(study, ctx) {
    const opts = { branch: ctx.branch, asOf: ctx.asOf };
    const all = await store.query('Observation', { patient: study._patient, where: isAnnotation }, opts);
    return all.filter((o) => o.derivedFrom?.some((d) => d.reference === `ImagingStudy/${study.id}`)).map(annotationOf);
  }
  const order = { stat: 0, urgent: 1, routine: 2 };

  return {
    async handle(req, url, body, ctx) {
      const parts = url.pathname.split('/').filter(Boolean).slice(2);
      const m = req.method;
      const me = ctx.actor.id;

      if (parts[0] === 'worklist' && m === 'GET') {
        const { rows, now } = await load(ctx);
        const queue = url.searchParams.get('queue') || 'my';
        const modality = url.searchParams.get('modality');
        const family = (r) => (['CT', 'MR', 'US', 'NM'].includes(r.modality) ? r.modality : ['CR', 'DX', 'XR'].includes(r.modality) ? 'XR' : 'Other');
        const visible = rows.filter((r) => (queue === 'all' || (r.status !== 'read' && (!r.lock || r.lock.by === me))) && (!modality || modality === 'All' || family(r) === modality))
          .sort((a, b) => order[a.priority] - order[b.priority] || String(a.receivedAt).localeCompare(String(b.receivedAt)));
        const unreadBy = {};
        for (const r of rows.filter((x) => x.status !== 'read')) unreadBy[family(r)] = (unreadBy[family(r)] || 0) + 1;
        const shown = visible;
        return { status: 200, body: { now, reader: me, rows: shown, more: visible.length - shown.length, metrics: metrics(rows, now), counts: { my: rows.filter((r) => r.status !== 'read' && (!r.lock || r.lock.by === me)).length, all: rows.length, unreadByModality: unreadBy } } };
      }

      if (parts[0] === 'studies' && parts[1]) {
        const id = parts[1];
        if (m === 'GET' && parts.length === 2) {
          const { rows, studies, reports } = await load(ctx);
          const mine = rows.find((r) => r.id === id);
          if (!mine) throw new HttpError(404, `ImagingStudy/${id} not found`);
          const study = studies.find((s) => s.id === id);
          const all = reportsOf(reports, study).sort((a, b) => String(a._recordedAt).localeCompare(String(b._recordedAt)));
          return { status: 200, body: {
            study: mine, prior: rows.find((r) => r.id === mine.priorId) || null,
            history: rows.filter((r) => r.patient?.id === mine.patient?.id && r.id !== id).sort((a, b) => String(b.started).localeCompare(String(a.started))),
            report: stripInternal(all.find((r) => !isAddendum(r)) || null), addenda: all.filter(isAddendum).map(stripInternal),
          } };
        }
        // DICOM objects made in the viewer: segmentations (SEG), measurement reports (SR) and presentation states (PR), kept with the study as Part 10 files.
        if (parts[2] === 'objects') {
          const study = await store.get('ImagingStudy', id, { branch: ctx.branch, asOf: ctx.asOf });
          if (!study) throw new HttpError(404, `ImagingStudy/${id} not found`);
          const mine = async () => (await store.query('DicomObject', { groupKey: id }, { branch: ctx.branch, asOf: ctx.asOf })).filter((o) => !o.removed);
          if (m === 'GET' && parts.length === 3) return { status: 200, body: { objects: (await mine()).map(({ data, _seq, ...rest }) => rest).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) } };
          if (m === 'GET' && parts[3]) { const o = (await mine()).find((x) => x.id === parts[3]); if (!o) throw new HttpError(404, 'No such object'); return { status: 200, body: { ...o, _seq: undefined } }; }
          writable(ctx);
          if (enforcedFor(ctx) && !mayWrite(ctx.actor.role, 'Observation', 'create')) throw new HttpError(403, 'This role may not save viewer objects');
          if (m === 'POST' && parts.length === 3) {
            const KINDS = { seg: SOP_CLASS.SEG, sr: SOP_CLASS.SR_COMPREHENSIVE, pr: SOP_CLASS.GSPS };
            if (!KINDS[body?.kind]) throw new HttpError(422, 'kind must be seg, sr or pr');
            if (typeof body.data !== 'string' || body.data.length > 24 * 1024 * 1024) throw new HttpError(422, 'data must be the Part 10 file as base64, at most 16 MB');
            let file; try { file = parseDicom(new Uint8Array(Buffer.from(body.data, 'base64'))); } catch (err) { throw new HttpError(422, `Not a readable DICOM file: ${err.message}`); }
            if (file.str('SOPClassUID') !== KINDS[body.kind]) throw new HttpError(422, `The file is not a ${body.kind.toUpperCase()} object`);
            if (file.str('StudyInstanceUID') !== studyUidOf(study)) throw new HttpError(422, 'The object belongs to another study');
            const doc = { resourceType: 'DicomObject', id: randomUUID(), _groupKey: id, study: id, kind: body.kind, sopClass: KINDS[body.kind], sopUid: file.str('SOPInstanceUID'), seriesUid: file.str('SeriesInstanceUID'), label: String(body.label || file.str('ContentLabel') || file.str('SeriesDescription') || body.kind).slice(0, 80), summary: body.summary && typeof body.summary === 'object' ? body.summary : null, bytes: Math.floor((body.data.length * 3) / 4), data: body.data, createdBy: ctx.actor.id, createdAt: store.now() };
            const saved = await store.transaction(async (tx) => { const out = await tx.save('DicomObject', doc, { branch: ctx.branch, updatedBy: ctx.actor.role }); await recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'create', action: `image.${body.kind}.save`, args: { study: id, kind: body.kind, sopUid: doc.sopUid, bytes: doc.bytes, ...(doc.summary || {}) }, branch: ctx.branch, entityRef: `ImagingStudy/${id}`, patientRef: study.subject?.reference, description: `${body.kind.toUpperCase()} object saved on study ${id}` }); return out; });
            const { data, _seq, ...rest } = saved;
            return { status: 201, body: rest };
          }
          if (m === 'DELETE' && parts[3]) { const o = (await mine()).find((x) => x.id === parts[3]); if (!o) throw new HttpError(404, 'No such object'); const { _seq, ...rest } = o; await store.save('DicomObject', { ...rest, removed: true, data: '' }, { branch: ctx.branch, updatedBy: ctx.actor.role }); return { status: 200, body: { id: o.id, removed: true } }; }
        }
        if (parts[2] === 'annotations') {
          const study = await store.get('ImagingStudy', id, { branch: ctx.branch, asOf: ctx.asOf });
          if (!study) throw new HttpError(404, `ImagingStudy/${id} not found`);
          if (m === 'GET' && parts.length === 3) return { status: 200, body: { annotations: await listAnnotations(study, ctx) } };
          if (!fhir) throw new HttpError(404, 'annotations are not available');
          writable(ctx);
          if (m === 'POST' && parts.length === 3) {
            const spec = MEASURES[body?.kind];
            if (!spec) throw new HttpError(422, `kind must be one of ${Object.keys(MEASURES).join(', ')}`);
            if (!Array.isArray(body.points) || body.points.length < (spec.minPoints ?? 2) || body.points.length > (body.kind === 'freehand' ? 400 : 8)) throw new HttpError(422, body.kind === 'freehand' ? 'a freehand region lists 3 to 400 points' : 'points must list 2 to 8 points');
            const geometry = { series: String(body.series || ''), plane: String(body.plane || 'axial'), frame: Number(body.frame) || 0, points: body.points.map((p) => (Array.isArray(p) ? p.slice(0, 3).map(Number) : [Number(p.x), Number(p.y)])), space: body.space === 'world' ? 'world' : 'image', engine: body.engine === 'cs3d' ? 'cs3d' : 'canvas', uid: body.uid ? String(body.uid).slice(0, 64) : undefined };
            // Region statistics, the short axis, the label and the note travel with the geometry.
            Object.assign(geometry, { mean: numOrNull(body.mean), sd: numOrNull(body.sd), shortMm: numOrNull(body.shortMm), label: body.label ? String(body.label).slice(0, 80) : null, text: body.text ? String(body.text).slice(0, 300) : null, ...(Array.isArray(body.imagePoints) ? { imagePoints: body.imagePoints.slice(0, 400).map((p) => [Number(p[0]), Number(p[1])]) } : {}) });
            const value = spec.value ? body[spec.value] : null;
            const now = store.now();
            const doc = {
              resourceType: 'Observation', status: 'preliminary', category: [{ coding: [{ system: 'urn:hospital-desktop:category', code: 'image-measurement', display: 'Image measurement' }] }],
              code: { coding: [{ system: 'urn:hospital-desktop:measurement', code: body.kind, display: spec.display }], text: `${spec.display} on series ${geometry.series || '?'} image ${geometry.frame + 1}` },
              subject: { reference: study.subject?.reference }, derivedFrom: [{ reference: `ImagingStudy/${id}` }], effectiveDateTime: now, performer: [{ display: me }],
              ...(Number.isFinite(Number(value)) && value != null ? { valueQuantity: { value: Math.round(Number(value) * 100) / 100, unit: spec.unit } } : {}),
              extension: [{ url: ANNOTATION_URL, valueString: JSON.stringify(geometry) }],
            };
            const saved = await store.transaction(async (tx) => (await fhir.writeInTx(tx, 'Observation', null, doc, ctx, { action: 'image.annotate' })).saved);
            return { status: 201, body: annotationOf(saved) };
          }
          if (m === 'PUT' && parts[3]) {
            // The label of a measurement can be edited in the measurements panel; the numbers cannot.
            const saved = await store.transaction(async (tx) => {
              const o = await tx.get('Observation', parts[3], { branch: ctx.branch });
              if (!o || !isAnnotation(o) || !o.derivedFrom?.some((d) => d.reference === `ImagingStudy/${id}`)) throw new HttpError(404, `annotation ${parts[3]} not found`);
              let geometry = {}; try { geometry = JSON.parse(extensionOf(o, ANNOTATION_URL) || '{}'); } catch { geometry = {}; }
              geometry.label = body?.label ? String(body.label).slice(0, 80) : null;
              const { _seq, ...rest } = o;
              return (await fhir.writeInTx(tx, 'Observation', o.id, { ...rest, extension: [...(rest.extension || []).filter((e) => e.url !== ANNOTATION_URL), { url: ANNOTATION_URL, valueString: JSON.stringify(geometry) }] }, ctx, { action: 'image.annotation.label' })).saved;
            });
            return { status: 200, body: annotationOf(saved) };
          }
          if (m === 'DELETE' && parts[3]) {
            await store.transaction(async (tx) => {
              const o = await tx.get('Observation', parts[3], { branch: ctx.branch });
              if (!o || !isAnnotation(o) || !o.derivedFrom?.some((d) => d.reference === `ImagingStudy/${id}`)) throw new HttpError(404, `annotation ${parts[3]} not found`);
              const { _seq, ...rest } = o;
              await fhir.writeInTx(tx, 'Observation', o.id, { ...rest, status: 'cancelled' }, ctx, { action: 'image.annotation.remove' });
            });
            return { status: 200, body: { id: parts[3], removed: true } };
          }
        }
        if (m === 'POST' && ['open', 'close'].includes(parts[2])) {
          writable(ctx);
          // A role that may not change studies (for example a researcher) opens the study without taking a reading lock: the read is logged, nothing is written to the study.
          const readOnlyReader = enforcedFor(ctx) && !mayWrite(ctx.actor.role, 'ImagingStudy', 'update');
          const result = await store.transaction(async (tx) => {
            const study = await tx.get('ImagingStudy', id, { branch: ctx.branch });
            if (!study) throw new HttpError(404, `ImagingStudy/${id} not found`);
            const now = tx.now();
            const held = lockOf(study, now);
            const { _seq, ...doc } = study;
            if (readOnlyReader) {
              if (parts[2] === 'close') return { lock: held };
              await recordAction(tx, {
                runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'read', action: 'image.open', args: { study: id, readOnly: true }, branch: ctx.branch,
                resources: [{ ref: `ImagingStudy/${id}`, versionId: study.meta.versionId }], entityRef: `ImagingStudy/${id}`, patientRef: study._patient, description: `study opened read-only: ImagingStudy/${id}`,
              });
              return { lock: held, readOnly: true, opened: study };
            }
            if (parts[2] === 'close') {
              if (held?.by !== me) return { lock: held };
              delete doc._lock;
              await tx.save('ImagingStudy', doc, { branch: ctx.branch, updatedBy: ctx.actor.role });
              await recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'execute', action: 'study.unlock', args: { study: id }, branch: ctx.branch, entityRef: `ImagingStudy/${id}`, patientRef: study._patient, description: `reading lock released on ImagingStudy/${id}` });
              return { lock: null };
            }
            if (held && held.by !== me && !body?.force) return { lock: held, locked: true };
            const lock = { by: me, role: ctx.actor.role, at: now };
            await tx.save('ImagingStudy', { ...doc, _lock: lock }, { branch: ctx.branch, updatedBy: ctx.actor.role });
            await recordAction(tx, {
              runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'read', action: 'image.open', args: { study: id, tookOver: held && held.by !== me ? held.by : null }, branch: ctx.branch,
              resources: [{ ref: `ImagingStudy/${id}`, versionId: study.meta.versionId }], entityRef: `ImagingStudy/${id}`, patientRef: study._patient, description: `study opened for reading: ImagingStudy/${id}`,
            });
            return { lock, opened: study };
          });
          const { opened, ...answer } = result;
          if (opened && onOpen) { try { onOpen({ study: opened, ctx }); } catch (err) { console.error(err); } }
          return { status: answer.locked ? 423 : 200, body: answer };
        }
        if (m === 'PUT' && parts[2] === 'priority') {
          writable(ctx);
          if (enforcedFor(ctx)) assertMayWrite(ctx.actor.role, 'ImagingStudy', 'update');
          if (!PRIORITIES.includes(body?.priority)) throw new HttpError(422, `priority must be one of ${PRIORITIES.join(', ')}`);
          await store.transaction(async (tx) => {
            const study = await tx.get('ImagingStudy', id, { branch: ctx.branch });
            if (!study) throw new HttpError(404, `ImagingStudy/${id} not found`);
            const { _seq, ...doc } = study;
            doc.extension = [...(doc.extension || []).filter((e) => e.url !== PRIORITY_URL), { url: PRIORITY_URL, valueCode: body.priority }];
            const saved = await tx.save('ImagingStudy', doc, { branch: ctx.branch, updatedBy: ctx.actor.role });
            await recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'update', action: 'study.priority', args: { study: id, priority: body.priority }, branch: ctx.branch, entityRef: `ImagingStudy/${id}`, versionId: saved.meta.versionId, patientRef: saved._patient, description: `priority ${body.priority} on ImagingStudy/${id}` });
          });
          return { status: 200, body: { id, priority: body.priority } };
        }
      }
      throw new HttpError(404, `${m} ${url.pathname} is not available`);
    },
  };
}
