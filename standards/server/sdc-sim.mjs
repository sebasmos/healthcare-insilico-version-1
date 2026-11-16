// A simulated SDC bedside device (docs/STANDARDS.md), so the device path can be tested without hardware: a
// patient monitor, a ventilator or an infusion pump, each with its BICEPS MDIB and episodic metric and alert
// reports. Values come from a seeded generator at run time; nothing is stored in the repository.
import { mulberry32 } from '../../ehr/server/wearables.mjs';

const KINDS = {
  monitor: { code: '69798', name: 'Patient monitor', metrics: [['hr', 147842, 264864, 75, 8], ['spo2', 150456, 262688, 97, 1.5], ['rr', 151562, 264928, 16, 2], ['temp', 150364, 268192, 36.9, 0.2], ['sys', 150021, 266016, 122, 8], ['dia', 150022, 266016, 78, 5]], alarm: ['spo2-low', 196616, 'Phy', 'Hi', 'spo2'] },
  ventilator: { code: '70000', name: 'Ventilator', metrics: [['peep', 151976, 266048, 5, 0.3], ['fio2', 152196, 262688, 40, 1], ['vt', 151868, 263762, 450, 25], ['vrr', 151586, 264928, 14, 1]], alarm: ['disconnect', 196608, 'Tec', 'Hi', 'vt'] },
  pump: { code: '70673', name: 'Infusion pump', metrics: [['rate', 157784, 265266, 50, 0], ['vtbi', 157872, 263762, 0, 0]], alarm: ['occlusion', 196609, 'Tec', 'Me', 'rate'] },
};
const NS = 'xmlns:msg="http://standards.ieee.org/downloads/11073/11073-10207-2017/message" xmlns:pm="http://standards.ieee.org/downloads/11073/11073-10207-2017/participant" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';

export function createSimDevice({ kind = 'monitor', mrn, seed = 1, id = kind }) {
  const k = KINDS[kind]; if (!k) throw new Error(`kind must be one of ${Object.keys(KINDS).join(', ')}`);
  const rng = mulberry32(seed); const mds = `${id}-mds`; let infused = 0;
  const h = (m) => `${id}-${m}`;
  const value = (m, t) => { const [key, , , base, sd] = m; if (key === 'vtbi') { infused += 50 / 60; return Math.round(infused * 10) / 10; } const v = base + (rng() * 2 - 1) * sd; return key === 'temp' ? Math.round(v * 10) / 10 : Math.round(v); };
  const metricState = (m, t, v = value(m, t)) => `<pm:MetricState xsi:type="pm:NumericMetricState" DescriptorHandle="${h(m[0])}"><pm:MetricValue Value="${v}" DeterminationTime="${t}"/></pm:MetricState>`;
  return {
    mds, kind,
    mdib(t = Date.now()) {
      const [ah, ac, akind, prio, src] = k.alarm;
      return `<msg:GetMdibResponse ${NS}><msg:Mdib><pm:MdDescription><pm:Mds Handle="${mds}"><pm:Type Code="${k.code}"><pm:ConceptDescription>${k.name}</pm:ConceptDescription></pm:Type>`
        + `<pm:AlertSystem Handle="${h('alerts')}"><pm:AlertCondition Handle="${h(ah)}" Kind="${akind}" Priority="${prio}"><pm:Type Code="${ac}"/><pm:Source>${h(src)}</pm:Source></pm:AlertCondition></pm:AlertSystem>`
        + `<pm:Vmd Handle="${h('vmd')}"><pm:Type Code="${k.code}"/><pm:Channel Handle="${h('chan')}"><pm:Type Code="${k.code}"/>${k.metrics.map((m) => `<pm:Metric xsi:type="pm:NumericMetricDescriptor" Handle="${h(m[0])}" MetricCategory="${['peep', 'fio2', 'vrr', 'rate'].includes(m[0]) ? 'Set' : 'Msrmt'}"><pm:Type Code="${m[1]}"/><pm:Unit Code="${m[2]}"/></pm:Metric>`).join('')}</pm:Channel></pm:Vmd></pm:Mds></pm:MdDescription>`
        + `<pm:MdState>${k.metrics.map((m) => metricState(m, t).replace('pm:MetricState', 'pm:State').replace('</pm:MetricState>', '</pm:State>')).join('')}<pm:State xsi:type="pm:PatientContextState" DescriptorHandle="${h('patient')}"><pm:Identification Root="urn:hospital-desktop:mrn" Extension="${mrn}"/></pm:State></pm:MdState></msg:Mdib></msg:GetMdibResponse>`;
    },
    metrics(t = Date.now(), override = {}) { return `<msg:EpisodicMetricReport ${NS}><msg:ReportPart>${k.metrics.map((m) => metricState(m, t, override[m[0]])).join('')}</msg:ReportPart></msg:EpisodicMetricReport>`; },
    alarm(on, t = Date.now()) { return `<msg:EpisodicAlertReport ${NS}><msg:ReportPart><pm:AlertState xsi:type="pm:AlertConditionState" DescriptorHandle="${h(k.alarm[0])}" ActivationState="On" Presence="${on}" DeterminationTime="${t}"/></msg:ReportPart></msg:EpisodicAlertReport>`; },
  };
}
export const SIM_KINDS = Object.keys(KINDS);
