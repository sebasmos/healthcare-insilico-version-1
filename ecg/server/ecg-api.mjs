// /api/ecg/**: the ECG list and trace, recording a synthesised ECG against
// an order, and the physician's interpretation. Signing and
// releasing use the FHIR operations, so the DiagnosticReport lifecycle,
// the critical-result acknowledgement and the portal rules all apply.
import { HttpError } from '../../platform/server/http.mjs';
import { toDicomWaveform, toAecg } from '../../standards/server/ecg-export.mjs';
import { createConsent } from '../../standards/server/consent.mjs';
import { enforcedFor, assertMayWrite } from '../../platform/server/roles.mjs';
import { lifecycleOf } from '../../platform/server/state-machines.mjs';
import { inpatientEncounter } from '../../pharmacy/server/pharmacy.mjs';
import { ECG_ORDER_CODE, isEcgMachineReport, machineExtraOf, MACHINE_LABEL, MACHINE_EXTRA, isEcgObservation, isEcgReport, isEcgOrder, leadComponents, measurementsOf, interpretationReport, withMeasurements, detectRate, MEASUREMENTS, MEASUREMENTS_UNVERIFIED, CRITICAL_TEXT } from './ecg.mjs';
import { SYSTEMS } from '../../ehr/server/catalog.mjs';

const whenOf = (o) => o.effectiveDateTime || o._validAt || o._recordedAt;
const summary = (o, reports) => {
  const report = reports.filter((r) => (r.result || []).some((x) => x.reference === `Observation/${o.id}`)).sort((a, b) => (a._recordedAt < b._recordedAt ? 1 : -1))[0] || null;
  const critical = (o.interpretation || []).some((i) => (i.coding || []).some((c) => c.code === 'HH'));
  return { id: o.id, at: whenOf(o), source: (o.extension || []).find((e) => e.url === 'urn:hospital-desktop:ecg-source')?.valueString || null, rhythm: (o.extension || []).find((e) => e.url === 'urn:hospital-desktop:ecg-rhythm')?.valueString || null, leads: leadComponents(o).length, measurements: measurementsOf(o), order: o.basedOn?.[0]?.reference || null, reportId: report?.id || null, status: report ? report.status : 'unread', released: Boolean(report?._released), critical, acknowledged: Boolean(o._ack), confirmedBy: report?.resultsInterpreter?.[0]?.display || report?.performer?.[0]?.display || null };
};

export function createEcgApi({ store, fhir }) {
  const opts = (ctx) => ({ branch: ctx.branch, asOf: ctx.asOf });
  const assertWrite = (ctx, type, interaction, extra) => { if (ctx.asOf) throw new HttpError(409, 'Writes are disabled while viewing a past time'); if (enforcedFor(ctx)) assertMayWrite(ctx.actor.role, type, interaction, extra); };

  async function list(ctx, url) {
    const patientId = url.searchParams.get('patient') || '';
    const ref = `Patient/${patientId}`;
    const [obs, reports, orders] = await Promise.all([store.query('Observation', { patient: ref, where: isEcgObservation }, opts(ctx)), store.query('DiagnosticReport', { patient: ref, where: isEcgReport }, opts(ctx)), store.query('ServiceRequest', { patient: ref, where: isEcgOrder }, opts(ctx))]);
    const ecgs = obs.filter((o) => o.status !== 'cancelled' && o.status !== 'entered-in-error').sort((a, b) => (whenOf(a) < whenOf(b) ? 1 : -1)).map((o) => summary(o, reports));
    const recorded = new Set(obs.map((o) => o.basedOn?.[0]?.reference));
    const openOrders = orders.filter((o) => ['active', 'results-received'].includes(lifecycleOf(o)) && !recorded.has(`ServiceRequest/${o.id}`)).map((o) => ({ id: o.id, authoredOn: o.authoredOn || o._recordedAt, priority: o.priority || 'routine', requester: o.requester?.display || null, reason: o.reasonCode?.[0]?.text || null }));
    return { status: 200, body: { ecgs, openOrders, measurements: MEASUREMENTS, measurementsUnverified: MEASUREMENTS_UNVERIFIED } };
  }

  async function one(id, ctx) {
    const o = await store.get('Observation', id, opts(ctx));
    if (!o || !isEcgObservation(o)) throw new HttpError(404, `ECG Observation/${id} not found`);
    const reports = await store.query('DiagnosticReport', { patient: o._patient, where: isEcgReport }, opts(ctx));
    const all = (await store.query('Observation', { patient: o._patient, where: isEcgObservation }, opts(ctx))).filter((x) => x.id !== o.id && whenOf(x) < whenOf(o)).sort((a, b) => (whenOf(a) < whenOf(b) ? 1 : -1));
    const s = summary(o, reports);
    const mach = (await store.query('DiagnosticReport', { patient: o._patient, where: (r) => isEcgMachineReport(r) && (r.result || []).some((x) => x.reference === `Observation/${o.id}`) }, opts(ctx)))[0] || null;
    const report = s.reportId ? reports.find((r) => r.id === s.reportId) : null;
    return { status: 200, body: { ...s, leads: leadComponents(o).map((c) => ({ code: c.code.coding[0].code, name: c.code.coding[0].display, period: c.valueSampledData.period, factor: c.valueSampledData.factor, origin: c.valueSampledData.origin?.value ?? 0, data: c.valueSampledData.data })), detectedRate: detectRate(o), note: o.note?.[0]?.text || null, report: report ? { id: report.id, status: report.status, conclusion: report.conclusion || '', critical: (report.extension || []).find((e) => e.url === 'urn:hospital-desktop:ecg-critical')?.valueString || null, released: Boolean(report._released), performer: report.performer?.[0]?.display || null, issued: report.issued || null, versionId: report.meta?.versionId } : null, prior: all[0] ? { id: all[0].id, at: whenOf(all[0]) } : null, measurementsUnverified: MEASUREMENTS_UNVERIFIED, machine: mach ? { label: MACHINE_LABEL, statements: String(mach.conclusion || '').split('\n').filter(Boolean), source: mach.performer?.[0]?.display || null, extra: MACHINE_EXTRA.map((m) => ({ ...m, value: machineExtraOf(o)[m.key] })).filter((m) => m.value != null) } : null } };
  }

  /** No trace is made up here: a recording comes from a device or an import. */
  async function record() { throw new HttpError(410, 'ECG traces are not synthesised. Import a recording: npm run import -- --ecg <folder> --patient <MRN>'); }

  async function interpret(id, body, ctx) {
    assertWrite(ctx, 'DiagnosticReport', 'create');
    const result = await store.transaction(async (tx) => {
      const current = await tx.get('Observation', id, { branch: ctx.branch });
      if (!current || !isEcgObservation(current)) throw new HttpError(404, `ECG Observation/${id} not found`);
      const { _seq, ...obs } = current;
      const values = body.measurements && typeof body.measurements === 'object' ? body.measurements : {};
      for (const [k, v] of Object.entries(values)) { if (!MEASUREMENTS.some((m) => m.key === k)) throw new HttpError(422, `Unknown measurement "${k}"`); if (v !== null && v !== '' && !Number.isFinite(Number(v))) throw new HttpError(422, `${k} must be a number`); }
      const critical = body.critical ? String(body.critical).trim() : '';
      let next = withMeasurements(obs, values);
      const interpretation = (next.interpretation || []).filter((i) => !(i.coding || []).some((c) => c.code === 'HH'));
      if (critical) interpretation.push({ coding: [{ system: SYSTEMS.interpretation, code: 'HH', display: 'Critical high' }], text: `${CRITICAL_TEXT}: ${critical}` });
      next = { ...next, interpretation: interpretation.length ? interpretation : undefined };
      const savedObs = (await fhir.writeInTx(tx, 'Observation', id, next, ctx, { action: 'ecg.measure' })).saved;
      const reports = await tx.query('DiagnosticReport', { patient: savedObs._patient, where: (r) => isEcgReport(r) && (r.result || []).some((x) => x.reference === `Observation/${id}`) }, { branch: ctx.branch });
      const existing = reports.sort((a, b) => (a._recordedAt < b._recordedAt ? 1 : -1))[0] || null;
      if (existing && ['final', 'amended', 'corrected', 'appended'].includes(existing.status)) throw new HttpError(409, 'This interpretation is signed. Add an addendum instead.');
      const { _seq: s2, ...prev } = existing || {};
      const report = interpretationReport({ existing: existing ? prev : null, observation: savedObs, text: body.text, critical, author: ctx.actor.id, now: tx.now() });
      const savedReport = (await fhir.writeInTx(tx, 'DiagnosticReport', existing ? existing.id : null, report, ctx, { action: 'ecg.interpret' })).saved;
      return { observation: savedObs, report: savedReport };
    });
    return { status: 200, body: { observation: { id: result.observation.id, measurements: measurementsOf(result.observation), critical: (result.observation.interpretation || []).some((i) => (i.coding || []).some((c) => c.code === 'HH')) }, report: { id: result.report.id, status: result.report.status, conclusion: result.report.conclusion, versionId: result.report.meta.versionId } } };
  }

  return {
    async handle(req, url, body, ctx) {
      const parts = url.pathname.split('/').filter(Boolean).slice(2);
      const m = req.method;
      if (parts.length === 0 && m === 'GET') return list(ctx, url);
      // Which patients have an ECG, and when the newest one was recorded (no tracing is sent).
      if (parts[0] === 'patients' && parts.length === 1 && m === 'GET') { const by = {}; for (const o of await store.query('Observation', { contains: [{ code: { coding: [{ code: ECG_ORDER_CODE }] } }], where: (x) => isEcgObservation(x) && x.status !== 'cancelled' && x.status !== 'entered-in-error' }, opts(ctx))) { const id = String(o.subject?.reference || '').split('/')[1]; if (!id) continue; const cur = (by[id] ||= { patient: id, count: 0, latest: null }); cur.count += 1; const at = o.effectiveDateTime || o._recordedAt; if (!cur.latest || at > cur.latest) cur.latest = at; } return { status: 200, body: { patients: Object.values(by) } }; }
      if (parts[0] === 'record' && m === 'POST') return record(body || {}, ctx);
      if (parts[0] && parts.length === 1 && m === 'GET') return one(parts[0], ctx);
      if (parts[0] && parts[1] === 'export' && m === 'GET') {
        const o = await store.get('Observation', parts[0], opts(ctx)); if (!o || !isEcgObservation(o)) throw new HttpError(404, `ECG Observation/${parts[0]} not found`);
        if (await createConsent(store).blocked(String(o._patient || '').replace(/^Patient\//, ''), ctx)) throw new HttpError(403, 'The patient\'s consent does not allow this ECG to be shared for this purpose');
        const p = o._patient ? await store.get('Patient', String(o._patient).replace(/^Patient\//, ''), opts(ctx)) : null; const who = { patientId: (p?.identifier || [])[0]?.value || '', sex: p?.gender, birthDate: p?.birthDate };
        const format = url.searchParams.get('format') || 'dicom';
        if (format === 'aecg') return { status: 200, body: Buffer.from(toAecg(o, who)), headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': `attachment; filename="ecg-${o.id}.xml"` } };
        if (format === 'dicom') return { status: 200, body: Buffer.from(toDicomWaveform(o, who)), headers: { 'Content-Type': 'application/dicom', 'Content-Disposition': `attachment; filename="ecg-${o.id}.dcm"` } };
        throw new HttpError(400, 'format must be dicom or aecg');
      }
      if (parts[0] && parts[1] === 'interpret' && m === 'POST') return interpret(parts[0], body || {}, ctx);
      throw new HttpError(404, `${m} ${url.pathname} is not available`);
    },
  };
}
