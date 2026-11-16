// ECG export (docs/STANDARDS.md): an ECG Observation (one SampledData component per lead) as a DICOM waveform
// (12-Lead ECG Waveform Storage, or General ECG Waveform Storage for other lead counts) and as an HL7 aECG
// (HL7 v3 AnnotatedECG) document. Each reads back to the same leads and samples. No patient name is written.
import { write, parse, generateUid, itemGet, itemStr } from '../../pacs/server/dicom.mjs';
import { readXml } from './ccda.mjs';

const SOP_12 = '1.2.840.10008.5.1.4.1.1.9.1.1'; const SOP_GENERAL = '1.2.840.10008.5.1.4.1.1.9.1.2';
const MDC_NAME = { 131329: 'I', 131330: 'II', 131331: 'III', 131332: 'AVR', 131333: 'AVL', 131334: 'AVF', 131335: 'V1', 131336: 'V2', 131337: 'V3', 131338: 'V4', 131339: 'V5', 131340: 'V6' };
const NAME_MDC = Object.fromEntries(Object.entries(MDC_NAME).map(([k, v]) => [v, k]));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dt = (iso) => String(iso || '').replace(/[-:]/g, '').replace('T', '').replace(/\.\d+/, '').replace(/Z$/, '').slice(0, 14);
const fromDt = (v) => { const m = String(v || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null; };

/** Leads from an ECG Observation: [{ code (MDC), name, periodMs, factor, origin, samples: number[] }]. */
export function leadsOf(o) {
  return (o.component || []).filter((c) => c.valueSampledData).map((c) => { const sd = c.valueSampledData; const code = c.code.coding[0].code; return { code, name: MDC_NAME[code] || c.code.coding[0].display || code, periodMs: Number(sd.period), factor: Number(sd.factor ?? 1), origin: Number(sd.origin?.value ?? 0), samples: String(sd.data || '').trim().split(/\s+/).map(Number) }; });
}

/** DICOM Part 10 bytes. leads share one sampling rate; samples are stored as signed 16-bit counts. */
export function toDicomWaveform(o, { patientId = '', sex = '', birthDate = '', studyUid = generateUid(), now = new Date().toISOString() } = {}) {
  const leads = leadsOf(o); if (!leads.length) throw new Error('This Observation has no waveform');
  const n = Math.min(...leads.map((l) => l.samples.length)); const data = new Int16Array(n * leads.length);
  for (let i = 0; i < n; i += 1) for (let c = 0; c < leads.length; c += 1) data[i * leads.length + c] = leads[c].samples[i];
  const when = o.effectiveDateTime || now;
  return write({
    SOPClassUID: leads.length === 12 ? SOP_12 : SOP_GENERAL, SOPInstanceUID: generateUid(), StudyInstanceUID: studyUid, SeriesInstanceUID: generateUid(),
    Modality: 'ECG', PatientName: '', PatientID: patientId, PatientSex: { male: 'M', female: 'F' }[sex] || 'O', PatientBirthDate: String(birthDate).replace(/-/g, ''),
    StudyDate: dt(when).slice(0, 8), StudyTime: dt(when).slice(8), ContentDate: dt(when).slice(0, 8), ContentTime: dt(when).slice(8), AcquisitionDateTime: dt(when), SeriesNumber: '1', InstanceNumber: '1', Manufacturer: 'hospital-desktop',
    WaveformSequence: [{ WaveformOriginality: 'ORIGINAL', NumberOfWaveformChannels: leads.length, NumberOfWaveformSamples: n, SamplingFrequency: String(Math.round(1000 / leads[0].periodMs * 1000) / 1000), MultiplexGroupLabel: 'RHYTHM', WaveformBitsAllocated: 16, WaveformSampleInterpretation: 'SS', WaveformData: data,
      ChannelDefinitionSequence: leads.map((l, i) => ({ WaveformChannelNumber: String(i + 1), ChannelSourceSequence: [{ CodeValue: String(l.code), CodingSchemeDesignator: 'MDC', CodeMeaning: `Lead ${l.name}` }], ChannelSensitivity: String(l.factor * 1000), ChannelSensitivityUnitsSequence: [{ CodeValue: 'uV', CodingSchemeDesignator: 'UCUM', CodeMeaning: 'microvolt' }], ChannelSensitivityCorrectionFactor: '1', ChannelBaseline: String(l.origin), WaveformBitsStored: 16 })) }],
  });
}

/** Reads a DICOM waveform back to leads (same shape as leadsOf). */
export function readDicomWaveform(bytes) {
  const f = parse(bytes); const w = f.get('WaveformSequence')[0]; const nCh = Number(itemGet(w, 'NumberOfWaveformChannels')[0] ?? itemGet(w, 'NumberOfWaveformChannels'));
  const raw = itemGet(w, 'WaveformData'); const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength); const n = raw.byteLength / 2 / nCh;
  const fs = Number(itemStr(w, 'SamplingFrequency'));
  return itemGet(w, 'ChannelDefinitionSequence').map((ch, c) => { const src = itemGet(ch, 'ChannelSourceSequence')[0]; const code = itemStr(src, 'CodeValue'); const samples = []; for (let i = 0; i < n; i += 1) samples.push(view.getInt16((i * nCh + c) * 2, true)); return { code, name: MDC_NAME[code] || code, periodMs: 1000 / fs, factor: Number(itemStr(ch, 'ChannelSensitivity')) / 1000, origin: Number(itemStr(ch, 'ChannelBaseline')), samples }; });
}

/** HL7 aECG (AnnotatedECG) XML. */
export function toAecg(o, { patientId = '', sex = '', now = new Date().toISOString() } = {}) {
  const leads = leadsOf(o); const when = o.effectiveDateTime || now; const n = Math.min(...leads.map((l) => l.samples.length));
  const seq = (l) => `<component><sequence><code code="MDC_ECG_LEAD_${l.name}" codeSystem="2.16.840.1.113883.6.24" codeSystemName="MDC"/><value xsi:type="SLIST_PQ"><origin value="${l.origin}" unit="mV"/><scale value="${l.factor}" unit="mV"/><digits>${l.samples.slice(0, n).join(' ')}</digits></value></sequence></component>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<AnnotatedECG xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><id root="${generateUid()}"/><code code="93000" codeSystem="2.16.840.1.113883.6.12" codeSystemName="CPT-4"/><effectiveTime><low value="${dt(when)}"/></effectiveTime>
<componentOf><timepointEvent><componentOf><subjectAssignment><subject><trialSubject><id extension="${esc(patientId)}" root="urn:hospital-desktop:mrn"/><subjectDemographicPerson><name nullFlavor="MSK"/><administrativeGenderCode code="${{ male: 'M', female: 'F' }[sex] || 'UN'}" codeSystem="2.16.840.1.113883.5.1"/></subjectDemographicPerson></trialSubject></subject></subjectAssignment></componentOf></timepointEvent></componentOf>
<component><series><code code="RHYTHM" codeSystem="2.16.840.1.113883.5.4"/><effectiveTime><low value="${dt(when)}"/></effectiveTime><component><sequenceSet>
<component><sequence><code code="TIME_ABSOLUTE" codeSystem="2.16.840.1.113883.5.4"/><value xsi:type="GLIST_TS"><head value="${dt(when)}"/><increment value="${leads[0].periodMs / 1000}" unit="s"/></value></sequence></component>
${leads.map(seq).join('\n')}
</sequenceSet></component></series></component></AnnotatedECG>`;
}

/** Reads an aECG back to leads and the recording time. */
export function readAecg(xml) {
  const doc = readXml(xml); const walk = (n, name, out = []) => { for (const c of n?.children || []) { if (c.name === name) out.push(c); walk(c, name, out); } return out; };
  const kid = (n, name) => (n?.children || []).find((c) => c.name === name);
  const seqs = walk(doc, 'sequence'); const time = seqs.find((s) => kid(s, 'code').attrs.code === 'TIME_ABSOLUTE');
  const periodMs = Number(kid(kid(time, 'value'), 'increment').attrs.value) * 1000;
  const leads = seqs.filter((s) => kid(s, 'code').attrs.code.startsWith('MDC_ECG_LEAD_')).map((s) => { const name = kid(s, 'code').attrs.code.replace('MDC_ECG_LEAD_', ''); const v = kid(s, 'value'); return { code: NAME_MDC[name] || name, name, periodMs, factor: Number(kid(v, 'scale').attrs.value), origin: Number(kid(v, 'origin').attrs.value), samples: kid(v, 'digits').text.trim().split(/\s+/).map(Number) }; });
  return { at: fromDt(kid(kid(time, 'value'), 'head').attrs.value), leads };
}
