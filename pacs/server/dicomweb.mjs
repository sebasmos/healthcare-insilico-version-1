// DICOMweb under /dicom-web/: QIDO-RS (search), WADO-RS and WADO-URI
// (retrieve), STOW-RS (store), plus a NIfTI import endpoint.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { HttpError, send } from '../../platform/server/http.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';
import {
  dicomRoot, instancePath, ingestInstances, niftiToInstances, studyUidOf, accessionOf, parseNifti, gunzip, isValidUid, DicomError,
} from './dicom.mjs';
import { mrnOf } from '../../ehr/server/clinical-rules.mjs';

const MAX_BODY = 512 * 1024 * 1024;

async function readBinary(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Upload too large (limit 512 MB per request)');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Splits a multipart/related body into its parts. */
export function parseMultipart(body, contentType) {
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType || '')?.[1];
  if (!boundary) throw new HttpError(400, 'multipart/related request needs a boundary');
  const marker = Buffer.from(`--${boundary}`);
  const parts = [];
  let at = body.indexOf(marker);
  while (at !== -1) {
    const start = at + marker.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    const headerEnd = body.indexOf('\r\n\r\n', start);
    const next = body.indexOf(marker, start);
    if (headerEnd === -1 || next === -1) break;
    const headers = body.subarray(start, headerEnd).toString('latin1');
    parts.push({ headers, type: /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.trim() || '', bytes: new Uint8Array(body.subarray(headerEnd + 4, next - 2)) });
    at = next;
  }
  return parts;
}

const el = (vr, ...values) => (values.filter((v) => v !== undefined && v !== null && v !== '').length ? { vr, Value: values } : { vr });
const dicomDate = (iso) => (iso ? iso.slice(0, 10).replace(/-/g, '') : '');
const dicomTime = (iso) => (iso ? iso.slice(11, 19).replace(/:/g, '') : '');

function studyJson(study, patient) {
  const name = patient?.name?.[0] || {};
  return {
    '00080020': el('DA', dicomDate(study.started)), '00080030': el('TM', dicomTime(study.started)), '00080050': el('SH', accessionOf(study)),
    '00080061': el('CS', ...(study.modality || []).map((m) => m.code)), '00081030': el('LO', study.description),
    '00100010': el('PN', { Alphabetic: name.family || '' }), '00100020': el('LO', patient ? mrnOf(patient) : ''),
    '00100030': el('DA', (patient?.birthDate || '').replace(/-/g, '')), '0020000D': el('UI', studyUidOf(study)),
    '00201206': el('IS', study.numberOfSeries ?? 0), '00201208': el('IS', study.numberOfInstances ?? 0),
  };
}
const seriesJson = (study, s) => ({
  '00080060': el('CS', s.modality?.code), '0008103E': el('LO', s.description), '00180015': el('CS', s.bodySite?.display),
  '0020000D': el('UI', studyUidOf(study)), '0020000E': el('UI', s.uid), '00200011': el('IS', s.number), '00201209': el('IS', s.instance?.length ?? 0),
});
const instanceJson = (study, s, i) => ({
  '00080016': el('UI', i.sopClass?.code?.replace('urn:oid:', '')), '00080018': el('UI', i.uid), '0020000D': el('UI', studyUidOf(study)),
  '0020000E': el('UI', s.uid), '00200013': el('IS', i.number), '00280008': el('IS', Number(i.title) || 1),
});

const sliceCache = new Map(); let sliceBytes = 0; // file -> { raw | zipped }, oldest first
const SLICE_CAP = 500e6;
async function loadSlice(file) {
  let hit = sliceCache.get(file);
  if (hit) { sliceCache.delete(file); sliceCache.set(file, hit); return hit; }
  const raw = await fs.promises.readFile(file);
  const zipped = await new Promise((ok) => zlib.gzip(raw, { level: 1 }, (err, buf) => ok(err || buf.length > raw.length * 0.9 ? null : buf)));
  hit = { raw: zipped ? null : raw, zipped, size: raw.length, bytes: (zipped || raw).length };
  sliceBytes += hit.bytes; sliceCache.set(file, hit);
  for (const [k, v] of sliceCache) { if (sliceBytes <= SLICE_CAP) break; sliceCache.delete(k); sliceBytes -= v.bytes; }
  return hit;
}

export function createDicomWeb({ store }) {
  const root = () => dicomRoot();

  // A CT asks for hundreds of slices at once, and each asked for the study again by reading every study in the
  // hospital. The answer is now kept until any study changes (one tiny question to the database per slice).
  const studyCache = new Map(); // `${branch}|${asOf}|${uid}` -> { mark, study }
  async function findStudy(uid, ctx) {
    if (!isValidUid(uid)) throw new HttpError(400, `"${uid}" is not a valid UID`);
    const key = `${ctx.branch}|${ctx.asOf ?? ''}|${uid}`; const mark = await store.changeMark(['ImagingStudy']);
    const hit = studyCache.get(key); if (hit && hit.mark === mark) return hit.study;
    const study = (await store.query('ImagingStudy', { where: (s) => studyUidOf(s) === uid }, { branch: ctx.branch, asOf: ctx.asOf }))[0];
    if (!study) throw new HttpError(404, `Study ${uid} not found`);
    if (studyCache.size > 300) studyCache.clear(); studyCache.set(key, { mark, study });
    return study;
  }

  async function qido(url, ctx) {
    const q = url.searchParams;
    const patients = new Map((await store.query('Patient', {}, { branch: ctx.branch, asOf: ctx.asOf })).map((p) => [`Patient/${p.id}`, p]));
    let studies = await store.query('ImagingStudy', {}, { branch: ctx.branch, asOf: ctx.asOf });
    const date = q.get('StudyDate');
    const [from, to] = date ? (date.includes('-') ? date.split('-') : [date, date]) : [null, null];
    studies = studies.filter((s) => {
      const p = patients.get(s.subject?.reference);
      if (q.get('PatientID') && (!p || mrnOf(p) !== q.get('PatientID'))) return false;
      if (q.get('AccessionNumber') && accessionOf(s) !== q.get('AccessionNumber')) return false;
      if (q.get('StudyInstanceUID') && studyUidOf(s) !== q.get('StudyInstanceUID')) return false;
      if (q.get('ModalitiesInStudy') && !(s.modality || []).some((m) => q.get('ModalitiesInStudy').split(',').includes(m.code))) return false;
      const d = dicomDate(s.started);
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    }).sort((a, b) => String(b.started || '').localeCompare(String(a.started || '')));
    const limit = Math.min(Math.max(Number(q.get('limit')) || 100, 1), 1000);
    return studies.slice(0, limit).map((s) => studyJson(s, patients.get(s.subject?.reference)));
  }

  function multipart(res, files, cors) {
    const boundary = `hd-${randomUUID()}`;
    res.writeHead(200, { ...cors, 'Content-Type': `multipart/related; type="application/dicom"; boundary=${boundary}`, 'Cache-Control': 'no-store' });
    for (const file of files) {
      res.write(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`);
      res.write(fs.readFileSync(file));
      res.write('\r\n');
    }
    res.end(`--${boundary}--\r\n`);
  }

  const fileOf = (study, seriesUid, sopUid) => {
    const file = instancePath(root(), studyUidOf(study), seriesUid, sopUid);
    if (!fs.existsSync(file)) throw new HttpError(404, 'Instance file is missing from the archive');
    return file;
  };

  async function logOpen(study, ctx, how) {
    await store.transaction((tx) => recordAction(tx, {
      runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'read', action: 'image.open', branch: ctx.branch, asOf: ctx.asOf, args: { study: study.id, via: how },
      resources: [{ ref: `ImagingStudy/${study.id}`, versionId: study.meta.versionId }], entityRef: `ImagingStudy/${study.id}`, patientRef: study._patient,
      description: `images retrieved for ImagingStudy/${study.id}`,
    }));
  }

  // ?patient=<Patient id> attaches every instance in the request to that patient, whatever the header PatientID says (logged as an override).
  async function stow(req, url, ctx) {
    if (ctx.asOf) throw new HttpError(409, 'Writes are disabled while viewing a past time');
    const override = url.searchParams.get('patient') || null;
    if (override && !(await store.get('Patient', override, { branch: ctx.branch }))) throw new HttpError(422, `Patient/${override} does not exist`);
    const type = req.headers['content-type'] || '';
    const body = await readBinary(req);
    const items = /multipart\/related/i.test(type) ? parseMultipart(body, type).map((p) => ({ bytes: p.bytes }))
      : /application\/dicom/i.test(type) ? [{ bytes: new Uint8Array(body) }] : null;
    if (!items) throw new HttpError(415, 'STOW-RS expects multipart/related; type="application/dicom"');
    if (!items.length) throw new HttpError(400, 'No DICOM parts found in the request');
    const results = await ingestInstances(store, items, ctx, { override });
    const ref = (r) => ({ '00081150': el('UI', r.sopClass), '00081155': el('UI', r.sopUid) });
    const failed = results.filter((r) => r.status === 'failed');
    const ok = results.filter((r) => r.status !== 'failed');
    return {
      status: failed.length === 0 ? 200 : ok.length ? 202 : 409,
      body: {
        ...(ok.length ? { '00081199': { vr: 'SQ', Value: ok.map(ref) } } : {}),
        ...(failed.length ? { '00081198': { vr: 'SQ', Value: failed.map((r) => ({ ...ref(r), '00081197': el('US', 272) })) } } : {}),
        summary: { stored: results.filter((r) => r.status === 'stored').length, duplicates: results.filter((r) => r.status === 'duplicate').length, failed: failed.map((r) => ({ sopUid: r.sopUid, reason: r.reason })), studies: [...new Set(ok.map((r) => r.studyId))] },
      },
    };
  }

  async function nifti(req, url, ctx) {
    const mrn = url.searchParams.get('mrn');
    const patient = (await store.query('Patient', {}, { branch: ctx.branch })).find((p) => mrnOf(p) === mrn);
    if (!patient) throw new HttpError(422, `No patient has MRN "${mrn}"`);
    let bytes = new Uint8Array(await readBinary(req));
    try {
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
      const volume = parseNifti(bytes);
      const files = niftiToInstances(volume, { patient, modality: url.searchParams.get('modality') || 'MR', description: url.searchParams.get('description') || 'NIfTI import', bodyPart: url.searchParams.get('bodyPart') || '' });
      const results = await ingestInstances(store, files.map((f) => ({ bytes: f })), ctx);
      return { status: 200, body: { slices: files.length, stored: results.filter((r) => r.status === 'stored').length, study: results[0]?.studyId, dims: volume.dims, spacing: volume.spacing } };
    } catch (err) {
      if (err instanceof DicomError) throw new HttpError(422, err.message);
      throw err;
    }
  }

  // UPS-RS (PS3.18 section 11): workitems are created SCHEDULED, claimed with a transaction UID (IN PROGRESS), then
  // COMPLETED or CANCELED by the holder of that UID; a cancel request on a scheduled item cancels it.
  const TAG = { state: '00741000', txn: '00081195', label: '00741204', patientId: '00100020', priority: '00741200', start: '00404005' };
  const val = (ds, tag) => ds?.[tag]?.Value?.[0];
  async function readBody(req) { const chunks = []; let n = 0; for await (const c of req) { n += c.length; if (n > 1024 * 1024) throw new HttpError(413, 'Workitem too large'); chunks.push(c); } const t = Buffer.concat(chunks).toString('utf8'); if (!t) return null; try { return JSON.parse(t); } catch { throw new HttpError(400, 'The body must be DICOM JSON'); } }
  async function ups(req, res, url, parts, ctx, json) {
    const m = req.method; const uid = parts[1];
    const load = async (u) => { const w = await store.get('UpsWorkitem', u.replace(/[^0-9.]/g, '_')); if (!w) throw new HttpError(404, 'No such workitem'); return w; };
    const save = (w, action) => store.transaction(async (tx) => { const out = await tx.save('UpsWorkitem', w, { updatedBy: ctx.actor.role }); await recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'execute', action, args: { uid: w.uid, state: val(w.dataset, TAG.state) }, entityRef: `UpsWorkitem/${w.id}`, description: `UPS ${w.uid}: ${val(w.dataset, TAG.state)}` }); return out; });
    const strip = (w) => { const { [TAG.txn]: _t, ...ds } = w.dataset; return ds; };
    if (m === 'POST' && parts.length === 1) {
      const body = await readBody(req); const ds = Array.isArray(body) ? body[0] : body; const u = url.search.slice(1) || val(ds, '00080018');
      if (!u || !/^[0-9.]{3,64}$/.test(u)) throw new HttpError(400, 'Name the workitem UID in the query (POST /workitems?<uid>) or in SOP Instance UID');
      if (await store.get('UpsWorkitem', u.replace(/[^0-9.]/g, '_'))) throw new HttpError(409, 'A workitem with this UID exists');
      if (val(ds, TAG.state) && val(ds, TAG.state) !== 'SCHEDULED') throw new HttpError(400, 'A new workitem must be SCHEDULED');
      await save({ resourceType: 'UpsWorkitem', id: u.replace(/[^0-9.]/g, '_'), uid: u, dataset: { ...ds, '00080018': { vr: 'UI', Value: [u] }, [TAG.state]: { vr: 'CS', Value: ['SCHEDULED'] } } }, 'ups.create');
      res.setHeader('Location', `${url.origin || ''}/dicom-web/workitems/${u}`); return json(201, {});
    }
    if (m === 'GET' && parts.length === 1) {
      const q = url.searchParams; const all = (await store.query('UpsWorkitem', {})).map(strip);
      const keep = all.filter((ds) => [...q].every(([k, v]) => { const tag = /^[0-9A-F]{8}$/i.test(k) ? k.toUpperCase() : TAG[k] || ({ ProcedureStepState: TAG.state, PatientID: TAG.patientId }[k]); return !tag || String(val(ds, tag) ?? '') === v; }));
      return keep.length ? json(200, keep) : json(204, '');
    }
    if (m === 'GET' && parts.length === 2) return json(200, [strip(await load(uid))]);
    if (m === 'PUT' && parts[2] === 'state') {
      const w = await load(uid); const body = await readBody(req); const ds = Array.isArray(body) ? body[0] : body;
      const want = val(ds, TAG.state); const txn = val(ds, TAG.txn); const now = val(w.dataset, TAG.state); const held = val(w.dataset, TAG.txn);
      if (!txn) throw new HttpError(400, 'Transaction UID (0008,1195) is required');
      if (want === 'IN PROGRESS') { if (now !== 'SCHEDULED') throw new HttpError(409, `The workitem is ${now}`); }
      else if (want === 'COMPLETED' || want === 'CANCELED') { if (now !== 'IN PROGRESS') throw new HttpError(409, `The workitem is ${now}`); if (txn !== held) throw new HttpError(400, 'The transaction UID does not match the one that claimed the workitem'); }
      else throw new HttpError(400, 'Procedure Step State must be IN PROGRESS, COMPLETED or CANCELED');
      await save({ ...(({ _seq, ...d }) => d)(w), dataset: { ...w.dataset, [TAG.state]: { vr: 'CS', Value: [want] }, [TAG.txn]: { vr: 'UI', Value: [txn] } } }, 'ups.state');
      return json(200, {});
    }
    if (m === 'POST' && parts[2] === 'cancelrequest') {
      const w = await load(uid); const now = val(w.dataset, TAG.state);
      if (now === 'SCHEDULED') { await save({ ...(({ _seq, ...d }) => d)(w), dataset: { ...w.dataset, [TAG.state]: { vr: 'CS', Value: ['CANCELED'] } } }, 'ups.cancel'); return json(202, {}); }
      throw new HttpError(409, `A ${now} workitem cannot be cancelled by request`);
    }
    throw new HttpError(405, `${m} ${url.pathname} is not supported`);
  }

  return {
    /** Warm-up: reads the images of the first studies into memory (ten per modality, up to the budget), so the first person to open one does not wait. */
    async warm(budget = 350e6) {
      const studies = await store.query('ImagingStudy', {}, { branch: 'main' }); const per = {}; let n = 0;
      for (const study of studies) {
        const mod = study.modality?.[0]?.code || study.series?.[0]?.modality?.code || 'OT'; per[mod] = (per[mod] || 0) + 1; if (per[mod] > 10) continue;
        await store.changeMark(['ImagingStudy']).then((mark) => { const uid = studyUidOf(study); if (uid) studyCache.set(`main||${uid}`, { mark, study }); });
        for (const s of study.series || []) for (const i of s.instance || []) {
          if (sliceBytes >= budget) return n;
          try { await loadSlice(fileOf(study, s.uid, i.uid)); n += 1; } catch { /* a missing file: skip */ }
        }
      }
      return n;
    },
    /** Handles the request and writes the response. */
    async handle(req, res, url, ctx, cors = {}) {
      const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
      const json = (status, body) => send(res, status, body, { ...cors, 'Content-Type': 'application/dicom+json; charset=utf-8' });
      const m = req.method;
      if (m === 'POST' && parts.join('/') === 'studies') { const out = await stow(req, url, ctx); return json(out.status, out.body); }
      if (m === 'POST' && parts.join('/') === 'nifti') { const out = await nifti(req, url, ctx); return send(res, out.status, out.body, cors); }
      if (parts[0] === 'workitems') return ups(req, res, url, parts, ctx, json);
      if (m !== 'GET') throw new HttpError(405, `${m} ${url.pathname} is not supported`);
      if (parts.join('/') === 'studies') return json(200, await qido(url, ctx));
      if (parts[0] === 'wado') {
        const q = url.searchParams;
        const study = await findStudy(q.get('studyUID') || '', ctx);
        const file = fileOf(study, q.get('seriesUID'), q.get('objectUID'));
        // A stored image never changes: it is read and compressed once, kept in memory (up to 300 MB), and kept by the
        // browser for a day. private: never kept by a shared cache.
        const head = { ...cors, 'Content-Type': 'application/dicom', 'Cache-Control': 'private, max-age=86400, immutable', Vary: 'Accept-Encoding' };
        const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
        const hit = await loadSlice(file);
        if (hit.zipped && gz) { res.writeHead(200, { ...head, 'Content-Encoding': 'gzip', 'Content-Length': hit.zipped.length }); return res.end(hit.zipped); }
        const raw = hit.raw || await new Promise((ok, no) => zlib.gunzip(hit.zipped, (err, buf) => (err ? no(err) : ok(buf))));
        res.writeHead(200, { ...head, 'Content-Length': raw.length }); return res.end(raw);
      }
      if (parts[0] === 'studies' && parts[1]) {
        const study = await findStudy(parts[1], ctx);
        if (parts.length === 2) { await logOpen(study, ctx, 'wado-rs'); return multipart(res, study.series.flatMap((s) => s.instance.map((i) => fileOf(study, s.uid, i.uid))), cors); }
        if (parts[2] === 'series' && parts.length === 3) return json(200, study.series.map((s) => seriesJson(study, s)));
        if (parts[2] === 'instances' && parts.length === 3) return json(200, study.series.flatMap((s) => s.instance.map((i) => instanceJson(study, s, i))));
        const series = parts[2] === 'series' ? study.series.find((s) => s.uid === parts[3]) : null;
        if (!series) throw new HttpError(404, 'Series not found');
        if (parts[4] === 'instances' && parts.length === 5) return json(200, series.instance.map((i) => instanceJson(study, series, i)));
        if (parts[4] === 'instances' && parts.length === 6) return multipart(res, [fileOf(study, series.uid, parts[5])], cors);
      }
      throw new HttpError(404, `${m} ${url.pathname} is not available`);
    },
  };
}
