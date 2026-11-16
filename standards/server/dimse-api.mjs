// The app side of the DICOM network gateway (standards/dimse-gateway/gateway.py, docs/STANDARDS.md): the modality worklist
// from scheduled imaging orders, MPPS (performed procedure steps) as Procedure records, and storage commitment
// answered from the stored ImagingStudy instances. UPS-RS workitems live in lib/dicomweb.mjs.
import { createHash } from 'node:crypto';
import { HttpError } from '../../platform/server/http.mjs';
import { IMAGING } from '../../ehr/server/catalog.mjs';

const uid25 = (s) => `2.25.${BigInt(`0x${createHash('sha256').update(String(s)).digest('hex').slice(0, 30)}`).toString()}`;
const da = (iso) => String(iso || '').slice(0, 10).replace(/-/g, '');
const tm = (iso) => String(iso || '').slice(11, 19).replace(/:/g, '');
const mrnOf = (p) => ((p?.identifier || []).find((i) => (i.type?.coding || []).some((c) => c.code === 'MR')) || p?.identifier?.[0])?.value || p?.id;

export function createDimseApi({ store, fhir }) {
  const BY_CODE = new Map(IMAGING.map((x) => [x.code, x]));
  const imagingOf = (sr) => (sr.code?.coding || []).map((c) => BY_CODE.get(c.code)).find(Boolean) || ((sr.category || []).some((c) => (c.coding || []).some((k) => k.code === '363679005')) ? { modality: 'OT', name: sr.code?.text || 'Imaging' } : null);
  async function worklist(url, ctx) {
    const q = url.searchParams; const o = { branch: ctx.branch };
    const orders = (await store.query('ServiceRequest', {}, o)).filter((sr) => ['active', 'draft'].includes(sr.status) || (sr.extension || []).some((e) => e.url === 'urn:hospital-desktop:lifecycle' && ['ordered', 'scheduled', 'active'].includes(e.valueCode)));
    const out = [];
    for (const sr of orders) {
      const img = imagingOf(sr); if (!img) continue;
      if (q.get('modality') && q.get('modality') !== img.modality) continue;
      const when = sr.occurrenceDateTime || sr.authoredOn || '';
      if (q.get('date') && da(when) !== q.get('date')) continue;
      const pid = String(sr.subject?.reference || '').split('/')[1]; const p = pid ? await store.get('Patient', pid, o) : null;
      if (!p) continue;
      out.push({ accession: sr.id.replace(/-/g, '').slice(0, 16).toUpperCase(), serviceRequest: sr.id, patientId: mrnOf(p), birthDate: da(p.birthDate), sex: { male: 'M', female: 'F' }[p.gender] || 'O', procedureCode: sr.code?.coding?.[0]?.code || '', procedure: img.name, modality: img.modality, date: da(when), time: tm(when), studyInstanceUid: uid25(`study:${sr.id}`), stepId: sr.id.slice(0, 16) });
    }
    return out;
  }
  async function mpps(body, ctx) {
    const uid = String(body?.sopInstanceUid || ''); if (!/^[0-9.]{3,64}$/.test(uid)) throw new HttpError(422, 'sopInstanceUid is required');
    const state = { 'IN PROGRESS': 'in-progress', COMPLETED: 'completed', DISCONTINUED: 'stopped' }[String(body.status || '').toUpperCase()]; if (!state) throw new HttpError(422, 'status must be IN PROGRESS, COMPLETED or DISCONTINUED');
    const sr = body.accession ? (await store.query('ServiceRequest', {}, { branch: ctx.branch })).find((s) => s.id.replace(/-/g, '').slice(0, 16).toUpperCase() === body.accession) : null;
    const existing = (await store.query('Procedure', {}, { branch: ctx.branch })).find((p) => (p.identifier || []).some((i) => i.system === 'urn:dicom:uid' && i.value === `urn:oid:${uid}`));
    if (!existing && state !== 'in-progress') throw new HttpError(409, 'MPPS N-SET for a step that was never created');
    if (existing && existing.status !== 'in-progress') throw new HttpError(409, `The step is already ${existing.status}`);
    const doc = existing ? { ...(({ _seq, ...d }) => d)(existing), status: state, ...(state !== 'in-progress' ? { performedPeriod: { ...existing.performedPeriod, end: new Date().toISOString() } } : {}) } : { resourceType: 'Procedure', status: 'in-progress', identifier: [{ system: 'urn:dicom:uid', value: `urn:oid:${uid}` }], subject: sr?.subject || { reference: 'Patient/unknown' }, basedOn: sr ? [{ reference: `ServiceRequest/${sr.id}` }] : undefined, code: sr?.code || { text: 'Imaging procedure' }, performedPeriod: { start: new Date().toISOString() }, note: body.series?.length ? [{ text: `Series performed: ${body.series.length}` }] : undefined };
    if (!sr && !existing) throw new HttpError(422, 'The accession number matches no order');
    const out = await store.transaction((tx) => fhir.writeInTx(tx, 'Procedure', existing?.id || null, JSON.parse(JSON.stringify(doc)), { ...ctx, area: 'interface' }, { action: 'dimse.mpps' }));
    return { id: out.saved.id, status: out.saved.status };
  }
  async function commitment(body, ctx) {
    const want = (body?.instances || []).map((i) => ({ sopClass: String(i.sopClass || ''), sopInstance: String(i.sopInstance || '') }));
    const have = new Set(); for (const st of await store.query('ImagingStudy', {}, { branch: ctx.branch })) for (const s of st.series || []) for (const i of s.instance || []) have.add(i.uid);
    return { success: want.filter((w) => have.has(w.sopInstance)), failed: want.filter((w) => !have.has(w.sopInstance)) };
  }
  return {
    async handle(req, url, body, ctx) {
      const part = url.pathname.split('/').filter(Boolean)[2];
      if (ctx.actor.id !== 'dimse-gateway' && !['researcher'].includes(ctx.actor.role)) throw new HttpError(403, 'Only the DICOM gateway uses this interface');
      if (part === 'worklist' && req.method === 'GET') return { status: 200, body: await worklist(url, ctx) };
      if (part === 'mpps' && req.method === 'POST') return { status: 200, body: await mpps(body, ctx) };
      if (part === 'commitment' && req.method === 'POST') return { status: 200, body: await commitment(body, ctx) };
      throw new HttpError(404, 'Not found');
    },
  };
}
export { uid25 };
