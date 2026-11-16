// HL7 v2 <-> FHIR message mapping (docs/STANDARDS.md). One parsed v2 message becomes a FHIR message Bundle
// (MessageHeader first, then one resource per clinical segment, in segment order) and the Bundle turns back
// into the same v2 text for the fields mapped here. Covers ADT A01-A08, A11, A13, A28, A31, A40, SIU S12-S15,
// MDM T02, DFT P03, ORM/OML, ORU R01 (also PCD-01 device results) and R40 (ACM alarms), OUL R22, RDE O11,
// RDS O13, RAS O17, VXU V04, MFN M02 and QBP Q22/Q23/Q11. Field coverage follows the v2-to-FHIR IG for the
// elements listed; other fields are not carried.
import { createHash } from 'node:crypto';
import { parse, tsToIso, isoToTs } from './hl7v2.mjs';

const CS = { LN: 'http://loinc.org', RXNORM: 'http://www.nlm.nih.gov/research/umls/rxnorm', CVX: 'http://hl7.org/fhir/sid/cvx', I10: 'http://hl7.org/fhir/sid/icd-10-cm', SCT: 'http://snomed.info/sct', NDC: 'http://hl7.org/fhir/sid/ndc', HCPCS: 'urn:oid:2.16.840.1.113883.6.285', CPT: 'http://www.ama-assn.org/go/cpt', MDC: 'urn:iso:std:iso:11073:10101', UCUM: 'http://unitsofmeasure.org' };
const NAME = Object.fromEntries(Object.entries(CS).map(([k, v]) => [v, k]));
const EXT = 'urn:hospital-desktop:v2';
const fld = (seg, i) => (seg.fields[i]?.[0] || []).map((c) => c.join('&')).join('^').replace(/\^+$/, '');
const cmp = (seg, i, c) => seg.fields[i]?.[0]?.[c - 1]?.[0] ?? '';
const cwe = (seg, i) => { const [code, display, sys] = [cmp(seg, i, 1), cmp(seg, i, 2), cmp(seg, i, 3)]; return code ? { coding: [{ ...(sys ? { system: CS[sys] || `urn:v2:${sys}` } : {}), code, ...(display ? { display } : {}) }] } : undefined; };
const unCwe = (cc) => { const c = cc?.coding?.[0]; if (!c) return ''; const sys = c.system ? (NAME[c.system] || c.system.replace(/^urn:v2:/, '')) : ''; return [c.code, c.display || '', sys].join('^').replace(/\^+$/, ''); };
const ts = (v) => (v ? tsToIso(v) : undefined);
const unTs = (iso) => (iso ? isoToTs(iso) : '');
const d8 = (v) => (/^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6)}` : undefined);
const x = (key, value) => (value ? [{ system: `${EXT}:${key}`, code: value }] : []);
const xv = (r, key) => (r.meta?.tag || []).find((e) => e.system === `${EXT}:${key}`)?.code || '';
const prune = (v) => { if (Array.isArray(v)) { const a = v.map(prune).filter((y) => y !== undefined); return a.length ? a : undefined; } if (v && typeof v === 'object') { const o = {}; for (const [k, y] of Object.entries(v)) { const p = prune(y); if (p !== undefined) o[k] = p; } return Object.keys(o).length ? o : undefined; } return v === '' ? undefined : v; };
const tagsToMeta = (r) => { if (!r || typeof r !== 'object') return r; const { extension, ...rest } = r; return extension?.length ? { ...rest, meta: { tag: extension } } : rest; };
const clean = (o) => prune(tagsToMeta(JSON.parse(JSON.stringify(o)))) || {};
export const uuidOf = (seed) => { const h = createHash('sha1').update(String(seed)).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const ENC_STATUS = { A01: 'in-progress', A02: 'in-progress', A03: 'finished', A04: 'arrived', A05: 'planned', A06: 'in-progress', A07: 'in-progress', A08: 'in-progress', A11: 'cancelled', A13: 'in-progress' };
const CLASS = { I: 'IMP', O: 'AMB', E: 'EMER', P: 'PRENC' };
const RX = { RDE: 'MedicationRequest', RDS: 'MedicationDispense', RAS: 'MedicationAdministration' };

function segToResource(seg, msg, ctx) {
  const n = seg.name; const e = (k, i) => x(`${n}-${i}`, fld(seg, i));
  if (n === 'PID') return clean({ resourceType: 'Patient', identifier: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] }, value: cmp(seg, 3, 1) }], birthDate: d8(fld(seg, 7)), gender: { M: 'male', F: 'female', O: 'other', U: 'unknown' }[fld(seg, 8)] });
  if (n === 'MRG') { ctx.patient.link = [{ type: 'replaces', other: { identifier: { value: cmp(seg, 1, 1) } } }]; return null; }
  if (n === 'PV1') return clean({ resourceType: 'Encounter', status: ENC_STATUS[msg.trigger] || 'unknown', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: CLASS[fld(seg, 2)] || fld(seg, 2) }, identifier: fld(seg, 19) ? [{ value: fld(seg, 19) }] : undefined, location: fld(seg, 3) ? [{ location: { display: fld(seg, 3) } }] : undefined, period: { start: ts(fld(seg, 44)), end: ts(fld(seg, 45)) } });
  if (n === 'SCH') return clean({ resourceType: 'Appointment', identifier: [{ type: { text: 'placer' }, value: fld(seg, 1) }, { type: { text: 'filler' }, value: fld(seg, 2) }].filter((i) => i.value), status: { Booked: 'booked', Cancelled: 'cancelled', Noshow: 'noshow', Complete: 'fulfilled', Pending: 'pending' }[fld(seg, 25)] || 'booked', reasonCode: cwe(seg, 7) ? [cwe(seg, 7)] : undefined, start: ts(cmp(seg, 11, 4)), end: ts(cmp(seg, 11, 5)), extension: e('', 25) });
  if (n === 'TXA') return clean({ resourceType: 'DocumentReference', status: 'current', docStatus: { AU: 'final', DI: 'preliminary', LA: 'final', PA: 'preliminary' }[fld(seg, 17)] || 'preliminary', type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0270', code: fld(seg, 2) }] }, masterIdentifier: { value: fld(seg, 12) }, date: ts(fld(seg, 4)), content: [], extension: e('', 17) });
  if (n === 'FT1') return clean({ resourceType: 'ChargeItem', status: 'billable', identifier: [{ value: fld(seg, 2) }], occurrenceDateTime: ts(fld(seg, 4)), code: cwe(seg, 7) || cwe(seg, 25), quantity: fld(seg, 10) ? { value: Number(fld(seg, 10)) } : undefined, extension: [...e('', 6), ...(fld(seg, 25) ? x('FT1-25', fld(seg, 25)) : [])] });
  if (n === 'ORC') { ctx.orc = seg; return null; }
  const withOrc = (r) => { const o = ctx.orc; ctx.orc = null; if (!o) return clean(r); return clean({ ...r, identifier: [...(r.identifier || []), { type: { text: 'placer' }, value: fld(o, 2) }, { type: { text: 'filler' }, value: fld(o, 3) }].filter((i) => i.value), extension: [...(r.extension || []), ...x('ORC-1', fld(o, 1)), ...x('ORC-5', fld(o, 5))] }); };
  if (n === 'OBR') return withOrc({ resourceType: 'ServiceRequest', status: 'active', intent: 'order', code: cwe(seg, 4), occurrenceDateTime: ts(fld(seg, 7)), extension: [...x('OBR-2', fld(seg, 2)), ...x('OBR-3', fld(seg, 3)), ...e('', 25)] });
  if (n === 'RXE' || n === 'RXO') return withOrc({ resourceType: 'MedicationRequest', status: 'active', intent: 'order', medicationCodeableConcept: cwe(seg, 2), dosageInstruction: fld(seg, 3) ? [{ doseAndRate: [{ doseQuantity: { value: Number(fld(seg, 3)), unit: cmp(seg, 5, 1) || undefined } }] }] : undefined, extension: x('seg', n) });
  if (n === 'RXD') return withOrc({ resourceType: 'MedicationDispense', status: 'completed', medicationCodeableConcept: cwe(seg, 2), whenHandedOver: ts(fld(seg, 3)), quantity: fld(seg, 4) ? { value: Number(fld(seg, 4)) } : undefined });
  if (n === 'RXA') {
    const base = { occurrenceDateTime: ts(fld(seg, 3)), lot: fld(seg, 15), dose: fld(seg, 6) ? { value: Number(fld(seg, 6)), unit: cmp(seg, 7, 1) || undefined } : undefined };
    if (msg.type === 'VXU') return withOrc({ resourceType: 'Immunization', status: { CP: 'completed', RE: 'not-done', NA: 'not-done', PA: 'completed' }[fld(seg, 20)] || 'completed', vaccineCode: cwe(seg, 5), occurrenceDateTime: base.occurrenceDateTime, lotNumber: base.lot || undefined, doseQuantity: base.dose, extension: x('RXA-20', fld(seg, 20)) });
    return withOrc({ resourceType: 'MedicationAdministration', status: 'completed', medicationCodeableConcept: cwe(seg, 5), effectiveDateTime: base.occurrenceDateTime, dosage: base.dose ? { dose: base.dose } : undefined, extension: x('RXA-20', fld(seg, 20)) });
  }
  if (n === 'SPM') return clean({ resourceType: 'Specimen', identifier: [{ value: fld(seg, 2) }], type: cwe(seg, 4), collection: fld(seg, 17) ? { collectedDateTime: ts(fld(seg, 17)) } : undefined });
  if (n === 'OBX') {
    const t = fld(seg, 2); const v = fld(seg, 5);
    if (ctx.last?.resourceType === 'DocumentReference' && ['TX', 'FT', 'ED'].includes(t)) { (ctx.last.content ||= []).push({ attachment: { contentType: 'text/plain', data: Buffer.from(v).toString('base64') } }); return null; }
    const range = fld(seg, 7).match(/^([\d.]+)-([\d.]+)$/);
    return clean({ resourceType: 'Observation', status: { F: 'final', P: 'preliminary', C: 'corrected', X: 'cancelled', R: 'registered' }[fld(seg, 11)] || 'final', category: msg.trigger === 'R40' ? [{ text: 'alarm' }] : undefined, code: cwe(seg, 3), ...(t === 'NM' ? { valueQuantity: { value: Number(v), unit: cmp(seg, 6, 1) || undefined, ...(cmp(seg, 6, 1) ? { system: CS.UCUM, code: cmp(seg, 6, 1) } : {}) } } : t === 'CWE' || t === 'CE' ? { valueCodeableConcept: cwe(seg, 5) } : { valueString: v }), referenceRange: range ? [{ low: { value: Number(range[1]) }, high: { value: Number(range[2]) } }] : undefined, interpretation: fld(seg, 8) ? [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: fld(seg, 8) }] }] : undefined, effectiveDateTime: ts(fld(seg, 14)), device: fld(seg, 18) ? { display: fld(seg, 18) } : undefined, extension: [...x('OBX-1', fld(seg, 1)), ...x('OBX-2', t), ...x('OBX-4', fld(seg, 4))] });
  }
  if (n === 'MFI') { ctx.mfi = fld(seg, 1); return null; }
  if (n === 'MFE') { ctx.mfe = seg; return null; }
  if (n === 'STF') return clean({ resourceType: 'Practitioner', identifier: [{ value: cmp(seg, 2, 1) || cmp(seg, 1, 1) }], active: fld(seg, 7) !== 'I', extension: [...x('MFI-1', ctx.mfi), ...x('MFE-1', ctx.mfe ? fld(ctx.mfe, 1) : ''), ...x('MFE-4', ctx.mfe ? fld(ctx.mfe, 4) : '')] });
  if (n === 'QPD') return { resourceType: 'Parameters', parameter: [{ name: 'query', valueString: fld(seg, 1) }, { name: 'tag', valueString: fld(seg, 2) }, ...seg.fields.slice(3).map((f, i) => ({ name: `QPD-${i + 3}`, valueString: (f?.[0] || []).map((c) => c.join('&')).join('^').replace(/\^+$/, '') })).filter((p) => p.valueString)] };
  if (n === 'RCP') { ctx.rcp = fld(seg, 1); return null; }
  return null;
}

/** v2 text (or a parsed message) -> FHIR message Bundle. */
export function v2ToFhir(text) {
  const msg = typeof text === 'string' ? parse(text) : text;
  const m = msg.segments[0]; const ctx = { orc: null, patient: null, last: null };
  const header = clean({ resourceType: 'MessageHeader', id: msg.controlId, eventCoding: { system: 'http://terminology.hl7.org/CodeSystem/v2-0003', code: msg.trigger }, source: { name: fld(m, 3), endpoint: `urn:v2:${fld(m, 4) || 'facility'}` }, destination: fld(m, 5) ? [{ name: fld(m, 5), endpoint: `urn:v2:${fld(m, 6) || 'facility'}` }] : undefined, extension: [...x('MSH-7', fld(m, 7)), ...x('MSH-9', fld(m, 9)), ...x('MSH-11', fld(m, 11)), ...x('MSH-12', fld(m, 12))] });
  const entries = [];
  for (const seg of msg.segments.slice(1)) {
    if (seg.name === 'EVN') { (header.meta ||= { tag: [] }).tag.push(...x('EVN-2', fld(seg, 2))); continue; }
    const r = segToResource(seg, msg, ctx);
    if (!r) continue;
    if (r.resourceType === 'Patient') ctx.patient = r;
    ctx.last = r; entries.push(r);
  }
  if (ctx.rcp) entries.at(-1)?.parameter?.push({ name: 'RCP-1', valueString: ctx.rcp });
  const all = [header, ...entries].map((r, i) => ({ fullUrl: `urn:uuid:${uuidOf(`${msg.controlId}-${i}`)}`, resource: r }));
  const pat = all.find((e) => e.resource.resourceType === 'Patient');
  const SKIP = ['Patient', 'MessageHeader', 'Parameters', 'Practitioner'];
  if (pat) for (const { resource: r } of all) { if (SKIP.includes(r.resourceType)) continue; if (r.resourceType === 'Appointment') r.participant = [{ actor: { reference: pat.fullUrl }, status: 'accepted' }]; else r[r.resourceType === 'Immunization' ? 'patient' : 'subject'] = { reference: pat.fullUrl }; }
  if (entries.length) header.focus = [{ reference: all[1].fullUrl }];
  return prune({ resourceType: 'Bundle', type: 'message', timestamp: ts(fld(m, 7)) || new Date().toISOString(), entry: all });
}

const line = (name, fields) => { const a = [name]; for (const [i, v] of Object.entries(fields)) a[Number(i)] = v ?? ''; for (let i = 1; i < a.length; i += 1) if (a[i] == null) a[i] = ''; while (a.length > 1 && a[a.length - 1] === '') a.pop(); return a.join('|'); };
const idOf = (r, text) => (r.identifier || []).find((i) => i.type?.text === text)?.value || '';
const unCls = (c) => Object.entries(CLASS).find(([, v]) => v === c)?.[0] || c || '';
const orcOf = (r) => (xv(r, 'ORC-1') ? [line('ORC', { 1: xv(r, 'ORC-1'), 2: idOf(r, 'placer'), 3: idOf(r, 'filler'), 5: xv(r, 'ORC-5') })] : []);
const qty = (q) => (q?.value != null ? String(q.value) : '');

function resourceToSegs(r, h) {
  const t = r.resourceType;
  if (t === 'Patient') return [line('PID', { 1: '1', 3: `${r.identifier?.[0]?.value || ''}`, 7: (r.birthDate || '').replace(/-/g, ''), 8: { male: 'M', female: 'F', other: 'O', unknown: 'U' }[r.gender] || '' }), ...(r.link?.length ? [line('MRG', { 1: r.link[0].other.identifier.value })] : [])];
  if (t === 'Encounter') return [line('PV1', { 1: '1', 2: unCls(r.class?.code), 3: r.location?.[0]?.location?.display || '', 19: r.identifier?.[0]?.value || '', 44: unTs(r.period?.start), 45: unTs(r.period?.end) })];
  if (t === 'Appointment') return [line('SCH', { 1: idOf(r, 'placer'), 2: idOf(r, 'filler'), 7: unCwe(r.reasonCode?.[0]), 11: r.start ? `^^^${unTs(r.start)}${r.end ? `^${unTs(r.end)}` : ''}` : '', 25: xv(r, 'SCH-25') })];
  if (t === 'DocumentReference') return [line('TXA', { 1: '1', 2: r.type?.coding?.[0]?.code || '', 4: unTs(r.date), 12: r.masterIdentifier?.value || '', 17: xv(r, 'TXA-17') }), ...(r.content || []).map((c, i) => line('OBX', { 1: String(i + 1), 2: 'TX', 5: Buffer.from(c.attachment.data, 'base64').toString(), 11: 'F' }))];
  if (t === 'ChargeItem') return [line('FT1', { 1: '1', 2: r.identifier?.[0]?.value || '', 4: unTs(r.occurrenceDateTime), 6: xv(r, 'FT1-6'), 7: xv(r, 'FT1-25') ? '' : unCwe(r.code), 10: qty(r.quantity), 25: xv(r, 'FT1-25') })];
  if (t === 'ServiceRequest') return [...orcOf(r), line('OBR', { 1: '1', 2: xv(r, 'OBR-2'), 3: xv(r, 'OBR-3'), 4: unCwe(r.code), 7: unTs(r.occurrenceDateTime), 25: xv(r, 'OBR-25') })];
  if (t === 'MedicationRequest') { const d = r.dosageInstruction?.[0]?.doseAndRate?.[0]?.doseQuantity; return [...orcOf(r), line(xv(r, 'seg') || 'RXE', { 2: unCwe(r.medicationCodeableConcept), 3: qty(d), 5: d?.unit || '' })]; }
  if (t === 'MedicationDispense') return [...orcOf(r), line('RXD', { 1: '1', 2: unCwe(r.medicationCodeableConcept), 3: unTs(r.whenHandedOver), 4: qty(r.quantity) })];
  if (t === 'Immunization') return [...orcOf(r), line('RXA', { 1: '0', 2: '1', 3: unTs(r.occurrenceDateTime), 5: unCwe(r.vaccineCode), 6: qty(r.doseQuantity), 7: r.doseQuantity?.unit || '', 15: r.lotNumber || '', 20: xv(r, 'RXA-20') })];
  if (t === 'MedicationAdministration') return [...orcOf(r), line('RXA', { 1: '0', 2: '1', 3: unTs(r.effectiveDateTime), 5: unCwe(r.medicationCodeableConcept), 6: qty(r.dosage?.dose), 7: r.dosage?.dose?.unit || '', 20: xv(r, 'RXA-20') })];
  if (t === 'Specimen') return [line('SPM', { 1: '1', 2: r.identifier?.[0]?.value || '', 4: unCwe(r.type), 17: unTs(r.collection?.collectedDateTime) })];
  if (t === 'Observation') { const ty = xv(r, 'OBX-2'); const rr = r.referenceRange?.[0]; return [line('OBX', { 1: xv(r, 'OBX-1'), 2: ty, 3: unCwe(r.code), 4: xv(r, 'OBX-4'), 5: r.valueQuantity ? qty(r.valueQuantity) : r.valueCodeableConcept ? unCwe(r.valueCodeableConcept) : r.valueString ?? '', 6: r.valueQuantity?.unit || '', 7: rr ? `${rr.low.value}-${rr.high.value}` : '', 8: r.interpretation?.[0]?.coding?.[0]?.code || '', 11: { final: 'F', preliminary: 'P', corrected: 'C', cancelled: 'X', registered: 'R' }[r.status] || '', 14: unTs(r.effectiveDateTime), 18: r.device?.display || '' })]; }
  if (t === 'Practitioner') { const out = []; if (xv(r, 'MFI-1') && !h.mfi) { h.mfi = true; out.push(line('MFI', { 1: xv(r, 'MFI-1'), 3: 'UPD', 6: 'NE' })); } out.push(line('MFE', { 1: xv(r, 'MFE-1'), 4: xv(r, 'MFE-4') }), line('STF', { 1: r.identifier?.[0]?.value || '', 2: r.identifier?.[0]?.value || '', 7: r.active === false ? 'I' : 'A' })); return out; }
  if (t === 'Parameters') { const p = Object.fromEntries(r.parameter.map((q) => [q.name, q.valueString])); const f = { 1: p.query, 2: p.tag }; for (const [k, v] of Object.entries(p)) if (k.startsWith('QPD-')) f[Number(k.slice(4))] = v; return [line('QPD', f), ...(p['RCP-1'] ? [line('RCP', { 1: p['RCP-1'] })] : [])]; }
  return [];
}

/** FHIR message Bundle (from v2ToFhir) -> v2 text (segments joined by CR). */
export function fhirToV2(bundle) {
  const [hdr, ...rest] = bundle.entry.map((e) => e.resource);
  const msh = `MSH|^~\\&|${hdr.source?.name || ''}|${(hdr.source?.endpoint || '').replace(/^urn:v2:/, '')}|${hdr.destination?.[0]?.name || ''}|${(hdr.destination?.[0]?.endpoint || '').replace(/^urn:v2:/, '')}|${xv(hdr, 'MSH-7')}||${xv(hdr, 'MSH-9')}|${hdr.id}|${xv(hdr, 'MSH-11')}|${xv(hdr, 'MSH-12')}`;
  const segs = [msh.replace(/\|+$/, '')];
  if (xv(hdr, 'EVN-2')) segs.push(line('EVN', { 1: hdr.eventCoding.code, 2: xv(hdr, 'EVN-2') }));
  const h = {};
  for (const r of rest) segs.push(...resourceToSegs(r, h));
  return segs.join('\r');
}
