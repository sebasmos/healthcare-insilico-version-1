// IEEE 11073 SDC (service-oriented device connectivity) for bedside devices (docs/STANDARDS.md): the BICEPS
// participant model (MDIB: MDS, VMD, channel, metric, alert system) and its episodic metric and alert reports,
// read as XML and mapped to FHIR the way the HL7 Point-of-Care Device IG does: the MDS, VMD and channel are
// Device records (parent links), each metric is a DeviceMetric, each metric value is an Observation (vital signs
// also carry LOINC, so the nursing screens and NEWS2 pick them up), and each alert condition is a DetectedIssue.
// The DPWS discovery and SOAP transport of a real SDC network are not implemented: a gateway (or the simulator
// in sdc-sim.mjs) posts the BICEPS XML here. MDC codes are from the 11073-10101 nomenclature; check them
// against the NIST RTMMS before connecting real devices.
import { readXml } from './ccda.mjs';

const MDC = 'urn:iso:std:iso:11073:10101';
export const METRICS = {
  147842: { name: 'Heart rate', loinc: '8867-4', ucum: '/min' }, 150456: { name: 'SpO2', loinc: '59408-5', ucum: '%' }, 151562: { name: 'Respiratory rate', loinc: '9279-1', ucum: '/min' },
  150364: { name: 'Body temperature', loinc: '8310-5', ucum: 'Cel' }, 150021: { name: 'Systolic blood pressure', loinc: '8480-6', ucum: 'mm[Hg]' }, 150022: { name: 'Diastolic blood pressure', loinc: '8462-4', ucum: 'mm[Hg]' },
  151976: { name: 'PEEP', loinc: '76248-7', ucum: 'cm[H2O]' }, 152196: { name: 'Inspired oxygen fraction', loinc: '3150-0', ucum: '%' }, 151868: { name: 'Tidal volume', loinc: '20112-8', ucum: 'mL' }, 151586: { name: 'Ventilator respiratory rate', loinc: '19834-1', ucum: '/min' },
  157784: { name: 'Infusion rate', ucum: 'mL/h' }, 157872: { name: 'Volume infused', ucum: 'mL' },
};
const VITAL = new Set(['8867-4', '59408-5', '9279-1', '8310-5', '8480-6', '8462-4']);
const local = (n) => String(n?.name || '').replace(/^.*:/, '');
const kids = (n, name) => (n?.children || []).filter((c) => local(c) === name);
const kid = (n, name) => kids(n, name)[0];
const walk = (n, name, out = []) => { for (const c of n?.children || []) { if (local(c) === name) out.push(c); walk(c, name, out); } return out; };
const typeOf = (n) => (n.attrs['xsi:type'] || '').replace(/^.*:/, '');
const code = (n) => kid(n, 'Type')?.attrs.Code;

/** MDIB XML -> { devices: [{ handle, parent, level, code, display }], metrics: [{ handle, channel, code, unit, category }], alerts: [{ handle, code, kind, priority, source }], patient, states } */
export function readMdib(xml) {
  const doc = readXml(xml); const devices = []; const metrics = []; const alerts = [];
  const desc = walk(doc, 'MdDescription')[0];
  for (const mds of kids(desc, 'Mds')) {
    devices.push({ handle: mds.attrs.Handle, parent: null, level: 'mds', code: code(mds), display: kid(kid(mds, 'Type'), 'ConceptDescription')?.text || null });
    for (const a of walk(mds, 'AlertCondition')) alerts.push({ handle: a.attrs.Handle, code: code(a), kind: a.attrs.Kind, priority: a.attrs.Priority, source: kid(a, 'Source')?.text || null, mds: mds.attrs.Handle });
    for (const vmd of kids(mds, 'Vmd')) {
      devices.push({ handle: vmd.attrs.Handle, parent: mds.attrs.Handle, level: 'vmd', code: code(vmd) });
      for (const ch of kids(vmd, 'Channel')) {
        devices.push({ handle: ch.attrs.Handle, parent: vmd.attrs.Handle, level: 'channel', code: code(ch) });
        for (const m of kids(ch, 'Metric')) metrics.push({ handle: m.attrs.Handle, channel: ch.attrs.Handle, mds: mds.attrs.Handle, code: code(m), unit: kid(m, 'Unit')?.attrs.Code, category: m.attrs.MetricCategory || 'Msrmt', kind: typeOf(m) });
      }
    }
  }
  const states = readStates(walk(doc, 'MdState')[0]);
  const pc = walk(doc, 'State').find((s) => typeOf(s) === 'PatientContextState');
  const id = pc ? kid(pc, 'Identification') : null;
  return { devices, metrics, alerts, patient: id ? id.attrs.Extension : null, states };
}
const readStates = (n) => (n?.children || []).map((s) => ({ type: typeOf(s), handle: s.attrs.DescriptorHandle, value: kid(s, 'MetricValue')?.attrs.Value, at: kid(s, 'MetricValue')?.attrs.DeterminationTime, presence: s.attrs.Presence, activation: s.attrs.ActivationState }));
/** An EpisodicMetricReport or EpisodicAlertReport -> states. */
export function readReport(xml) { const doc = readXml(xml); return walk(doc, 'ReportPart').flatMap((p) => readStates(p)); }

export function createSdc({ store, fhir }) {
  const devId = (mds, handle) => `sdc-${mds}-${handle}`.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 64);
  async function patientByMrn(tx, mrn) { return (await tx.query('Patient', {})).find((p) => (p.identifier || []).some((i) => i.value === mrn)) || null; }
  async function put(tx, type, id, doc, ctx) { const existing = await tx.get(type, id); const { _seq, ...prev } = existing || {}; return (await fhir.writeInTx(tx, type, id, existing ? { ...prev, ...doc, id } : { ...doc, id }, { ...ctx, area: 'interface' }, { action: `sdc.${type.toLowerCase()}` })).saved; }
  /** Registers a device from its MDIB and applies the states in it. Returns what was written. */
  async function connect(xml, ctx) {
    const m = readMdib(xml); if (!m.devices.length) throw Object.assign(new Error('No MDS in the MDIB'), { status: 422 });
    return store.transaction(async (tx) => {
      const p = m.patient ? await patientByMrn(tx, m.patient) : null;
      const mdsHandle = m.devices[0].handle; const written = { devices: [], metrics: [] };
      for (const d of m.devices) {
        const saved = await put(tx, 'Device', devId(mdsHandle, d.handle), { resourceType: 'Device', status: 'active', identifier: [{ system: 'urn:ieee:11073:sdc:handle', value: d.handle }], type: { coding: [{ system: MDC, code: String(d.code || '') }], text: d.display || d.level.toUpperCase() }, ...(d.parent ? { parent: { reference: `Device/${devId(mdsHandle, d.parent)}` } } : {}), ...(p && d.level === 'mds' ? { patient: { reference: `Patient/${p.id}` } } : {}), property: [{ type: { text: 'containment level' }, valueCode: [{ text: d.level }] }] }, ctx);
        written.devices.push(saved.id);
      }
      for (const mt of m.metrics) {
        const info = METRICS[mt.code] || {};
        const saved = await put(tx, 'DeviceMetric', devId(mdsHandle, mt.handle), { resourceType: 'DeviceMetric', identifier: [{ system: 'urn:ieee:11073:sdc:handle', value: mt.handle }], type: { coding: [{ system: MDC, code: String(mt.code), ...(info.name ? { display: info.name } : {}) }] }, unit: { coding: [{ system: MDC, code: String(mt.unit || '') }, ...(info.ucum ? [{ system: 'http://unitsofmeasure.org', code: info.ucum }] : [])] }, source: { reference: `Device/${devId(mdsHandle, mt.channel)}` }, parent: { reference: `Device/${devId(mdsHandle, mdsHandle)}` }, operationalStatus: 'on', category: { Msrmt: 'measurement', Set: 'setting', Clc: 'calculation' }[mt.category] || 'unspecified' }, ctx);
        written.metrics.push(saved.id);
      }
      await tx.save('SdcDevice', { resourceType: 'SdcDevice', id: devId(mdsHandle, 'mdib'), mds: mdsHandle, patient: p ? `Patient/${p.id}` : null, metrics: m.metrics, alerts: m.alerts }, { updatedBy: 'interface' });
      const applied = await applyStates(tx, mdsHandle, m.states, ctx);
      return { mds: mdsHandle, patient: p?.id || null, ...written, ...applied };
    });
  }
  async function applyStates(tx, mdsHandle, states, ctx) {
    const reg = await tx.get('SdcDevice', devId(mdsHandle, 'mdib')); if (!reg) throw Object.assign(new Error('Unknown device: send its MDIB first'), { status: 409 });
    const observations = []; const alarms = [];
    for (const s of states) {
      const mt = reg.metrics.find((x) => x.handle === s.handle);
      if (mt && s.value != null && reg.patient) {
        const info = METRICS[mt.code] || {}; const at = s.at ? new Date(Number(s.at)).toISOString() : new Date().toISOString();
        const doc = { resourceType: 'Observation', status: 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: info.loinc && VITAL.has(info.loinc) ? 'vital-signs' : 'procedure' }] }], code: { coding: [...(info.loinc ? [{ system: 'http://loinc.org', code: info.loinc, display: info.name }] : []), { system: MDC, code: String(mt.code), ...(info.name ? { display: info.name } : {}) }] }, subject: { reference: reg.patient }, effectiveDateTime: at, valueQuantity: { value: Number(s.value), unit: info.ucum || mt.unit, system: 'http://unitsofmeasure.org', code: info.ucum || mt.unit }, device: { reference: `DeviceMetric/${devId(mdsHandle, mt.handle)}` }, extension: [{ url: 'urn:hospital-desktop:sdc-source', valueString: mdsHandle }] };
        observations.push((await fhir.writeInTx(tx, 'Observation', null, doc, { ...ctx, area: 'interface' }, { action: 'sdc.metric' })).saved.id);
      }
      const al = reg.alerts.find((x) => x.handle === s.handle);
      if (al && s.presence != null) {
        const id = devId(mdsHandle, `alarm-${al.handle}`); const on = s.presence === 'true';
        const existing = await tx.get('DetectedIssue', id);
        if (on || existing) {
          const issue = await put(tx, 'DetectedIssue', id, { resourceType: 'DetectedIssue', status: on ? 'preliminary' : 'cancelled', code: { coding: [{ system: MDC, code: String(al.code || '') }], text: `${al.kind === 'Tec' ? 'Technical' : 'Physiological'} alarm` }, severity: { Hi: 'high', Me: 'moderate', Lo: 'low' }[al.priority] || 'low', ...(reg.patient ? { patient: { reference: reg.patient } } : {}), identifiedDateTime: new Date().toISOString(), implicated: [{ reference: `Device/${devId(mdsHandle, mdsHandle)}` }, ...(al.source ? [{ reference: `DeviceMetric/${devId(mdsHandle, al.source)}` }] : [])], detail: `${on ? 'Alarm on' : 'Alarm cleared'}: ${al.handle}` }, ctx);
          alarms.push({ id: issue.id, on, priority: al.priority });
        }
      }
    }
    return { observations, alarms };
  }
  return {
    connect,
    report: (mds, xml, ctx) => store.transaction((tx) => applyStates(tx, mds, readReport(xml), ctx)),
    async handle(req, url, body, ctx) {
      const part = url.pathname.split('/').filter(Boolean)[2];
      if (ctx.actor.id !== 'sdc-gateway' && ctx.actor.role !== 'researcher') return { status: 403, body: { error: 'Only the device gateway posts device data' } };
      const xml = String(body?.xml || ''); if (!xml.trim().startsWith('<')) return { status: 422, body: { error: 'Send { xml: "<BICEPS XML>" }' } };
      try {
        if (part === 'mdib' && req.method === 'POST') return { status: 200, body: await connect(xml, ctx) };
        if (part === 'report' && req.method === 'POST') return { status: 200, body: await this.report(String(body.mds || ''), xml, ctx) };
      } catch (err) { if (err.status) return { status: err.status, body: { error: err.message } }; throw err; }
      return { status: 404, body: { error: 'Not found' } };
    },
  };
}
