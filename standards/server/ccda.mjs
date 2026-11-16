// C-CDA R2.1 documents to and from FHIR document Bundles (docs/STANDARDS.md). Document types: CCD, discharge
// summary, referral note, consultation note and progress note. Sections: problems, medications, allergies,
// results, vital signs and immunizations, with the R2.1 template ids. Patient names are never written: the
// header carries name nullFlavor="MSK" and the record number only.
const TYPES = { ccd: ['34133-9', 'Summary of episode note', '2.16.840.1.113883.10.20.22.1.2'], discharge: ['18842-5', 'Discharge summary', '2.16.840.1.113883.10.20.22.1.8'], referral: ['57133-1', 'Referral note', '2.16.840.1.113883.10.20.22.1.14'], consult: ['11488-4', 'Consult note', '2.16.840.1.113883.10.20.22.1.4'], progress: ['11506-3', 'Progress note', '2.16.840.1.113883.10.20.22.1.9'] };
const SECTIONS = { problems: ['11450-4', 'Problem list', '2.16.840.1.113883.10.20.22.2.5.1', 'Condition'], medications: ['10160-0', 'Medications', '2.16.840.1.113883.10.20.22.2.1.1', 'MedicationStatement'], allergies: ['48765-2', 'Allergies', '2.16.840.1.113883.10.20.22.2.6.1', 'AllergyIntolerance'], results: ['30954-2', 'Results', '2.16.840.1.113883.10.20.22.2.3.1', 'Observation'], vitals: ['8716-3', 'Vital signs', '2.16.840.1.113883.10.20.22.2.4.1', 'Observation'], immunizations: ['11369-6', 'Immunizations', '2.16.840.1.113883.10.20.22.2.2.1', 'Immunization'] };
const OID = { '2.16.840.1.113883.6.1': 'http://loinc.org', '2.16.840.1.113883.6.96': 'http://snomed.info/sct', '2.16.840.1.113883.6.88': 'http://www.nlm.nih.gov/research/umls/rxnorm', '2.16.840.1.113883.6.90': 'http://hl7.org/fhir/sid/icd-10-cm', '2.16.840.1.113883.12.292': 'http://hl7.org/fhir/sid/cvx', '2.16.840.1.113883.6.8': 'http://unitsofmeasure.org' };
const SYS = Object.fromEntries(Object.entries(OID).map(([k, v]) => [v, k]));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const hl7ts = (iso) => (iso ? String(iso).replace(/[-:]/g, '').replace('T', '').replace(/\.\d+/, '').replace(/Z$/, '+0000') : '');
const isoOf = (v) => { const m = String(v || '').match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?([+-]\d{4})?$/); if (!m) return undefined; if (!m[4]) return `${m[1]}-${m[2]}-${m[3]}`; const z = !m[7] || m[7] === '+0000' ? 'Z' : `${m[7].slice(0, 3)}:${m[7].slice(3)}`; return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}${z}`; };
const code = (tag, c, extra = '') => (c ? `<${tag} code="${esc(c.code)}" codeSystem="${SYS[c.system] || esc(c.system)}"${c.display ? ` displayName="${esc(c.display)}"` : ''}${extra}/>` : `<${tag} nullFlavor="UNK"/>`);
const first = (cc) => cc?.coding?.[0];
const tid = (root, ext = '2015-08-01') => `<templateId root="${root}" extension="${ext}"/>`;

/** Minimal XML reader for well-formed documents without DTDs: returns { name, attrs, children, text }. */
export function readXml(xml) {
  const root = { children: [] }; const stack = [root]; const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g; let m;
  while ((m = re.exec(xml))) {
    if (m[5] !== undefined) { if (m[5].trim()) stack.at(-1).text = (stack.at(-1).text || '') + unesc(m[5]); continue; }
    if (!m[2]) continue;
    if (m[1]) { stack.pop(); continue; }
    const attrs = {}; for (const a of m[3].matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = unesc(a[2]);
    const node = { name: m[2], attrs, children: [] }; stack.at(-1).children.push(node);
    if (!m[4]) stack.push(node);
  }
  return root.children[0];
}
const kids = (n, name) => (n?.children || []).filter((c) => c.name === name);
const kid = (n, name) => kids(n, name)[0];
const path = (n, ...names) => names.reduce((a, k) => kid(a, k), n);
const cc = (n) => (n && n.attrs.code ? { coding: [{ system: OID[n.attrs.codeSystem] || n.attrs.codeSystem, code: n.attrs.code, ...(n.attrs.displayName ? { display: n.attrs.displayName } : {}) }] } : undefined);

function entryXml(key, r) {
  if (key === 'problems') return `<entry><act classCode="ACT" moodCode="EVN">${tid('2.16.840.1.113883.10.20.22.4.3')}<id root="${esc(r.id)}"/><code code="CONC" codeSystem="2.16.840.1.113883.5.6"/><statusCode code="${r.clinicalStatus?.coding?.[0]?.code === 'resolved' ? 'completed' : 'active'}"/><entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">${tid('2.16.840.1.113883.10.20.22.4.4')}<code code="55607006" codeSystem="2.16.840.1.113883.6.96"/><effectiveTime><low value="${hl7ts(r.onsetDateTime)}"/></effectiveTime>${code('value', first(r.code), ' xsi:type="CD"')}</observation></entryRelationship></act></entry>`;
  if (key === 'medications') return `<entry><substanceAdministration classCode="SBADM" moodCode="EVN">${tid('2.16.840.1.113883.10.20.22.4.16', '2014-06-09')}<id root="${esc(r.id)}"/><statusCode code="${r.status === 'completed' ? 'completed' : 'active'}"/><effectiveTime xsi:type="IVL_TS"><low value="${hl7ts(r.effectivePeriod?.start)}"/></effectiveTime>${r.dosage?.[0]?.doseAndRate?.[0]?.doseQuantity ? `<doseQuantity value="${r.dosage[0].doseAndRate[0].doseQuantity.value}" unit="${esc(r.dosage[0].doseAndRate[0].doseQuantity.unit || '1')}"/>` : ''}<consumable><manufacturedProduct>${tid('2.16.840.1.113883.10.20.22.4.23', '2014-06-09')}<manufacturedMaterial>${code('code', first(r.medicationCodeableConcept))}</manufacturedMaterial></manufacturedProduct></consumable></substanceAdministration></entry>`;
  if (key === 'allergies') return `<entry><act classCode="ACT" moodCode="EVN">${tid('2.16.840.1.113883.10.20.22.4.30')}<id root="${esc(r.id)}"/><code code="CONC" codeSystem="2.16.840.1.113883.5.6"/><statusCode code="active"/><entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">${tid('2.16.840.1.113883.10.20.22.4.7', '2014-06-09')}<code code="ASSERTION" codeSystem="2.16.840.1.113883.5.4"/><value xsi:type="CD" code="419199007" codeSystem="2.16.840.1.113883.6.96"/><participant typeCode="CSM"><participantRole classCode="MANU"><playingEntity classCode="MMAT">${code('code', first(r.code))}</playingEntity></participantRole></participant>${r.reaction?.[0]?.manifestation?.[0] ? `<entryRelationship typeCode="MFST" inversionInd="true"><observation classCode="OBS" moodCode="EVN">${tid('2.16.840.1.113883.10.20.22.4.9', '2014-06-09')}<code code="ASSERTION" codeSystem="2.16.840.1.113883.5.4"/>${code('value', first(r.reaction[0].manifestation[0]), ' xsi:type="CD"')}</observation></entryRelationship>` : ''}</observation></entryRelationship></act></entry>`;
  if (key === 'results' || key === 'vitals') { const vq = r.valueQuantity; return `<entry><observation classCode="OBS" moodCode="EVN">${tid(key === 'vitals' ? '2.16.840.1.113883.10.20.22.4.27' : '2.16.840.1.113883.10.20.22.4.2', key === 'vitals' ? '2014-06-09' : '2015-08-01')}<id root="${esc(r.id)}"/>${code('code', first(r.code))}<statusCode code="${r.status === 'final' ? 'completed' : 'active'}"/><effectiveTime value="${hl7ts(r.effectiveDateTime)}"/>${vq ? `<value xsi:type="PQ" value="${vq.value}" unit="${esc(vq.code || vq.unit || '1')}"/>` : `<value xsi:type="ST">${esc(r.valueString)}</value>`}</observation></entry>`; }
  if (key === 'immunizations') return `<entry><substanceAdministration classCode="SBADM" moodCode="EVN" negationInd="${r.status === 'not-done'}">${tid('2.16.840.1.113883.10.20.22.4.52')}<id root="${esc(r.id)}"/><statusCode code="completed"/><effectiveTime value="${hl7ts(r.occurrenceDateTime)}"/><consumable><manufacturedProduct>${tid('2.16.840.1.113883.10.20.22.4.54', '2014-06-09')}<manufacturedMaterial>${code('code', first(r.vaccineCode))}${r.lotNumber ? `<lotNumberText>${esc(r.lotNumber)}</lotNumberText>` : ''}</manufacturedMaterial></manufacturedProduct></consumable></substanceAdministration></entry>`;
  return '';
}
const sectionOf = (r) => (r.resourceType === 'Observation' ? ((r.category || []).some((c) => (c.coding || []).some((k) => k.code === 'vital-signs')) ? 'vitals' : 'results') : Object.entries(SECTIONS).find(([, s]) => s[3] === r.resourceType)?.[0]);
const rowText = (r) => esc(first(r.code || r.medicationCodeableConcept || r.vaccineCode)?.display || first(r.code || r.medicationCodeableConcept || r.vaccineCode)?.code || '');

/** FHIR document Bundle (Composition + Patient + entries) -> C-CDA R2.1 XML. kind: ccd, discharge, referral, consult or progress. */
export function fhirToCcda(bundle, kind = 'ccd') {
  const res = bundle.entry.map((e) => e.resource); const comp = res.find((r) => r.resourceType === 'Composition') || {}; const pat = res.find((r) => r.resourceType === 'Patient') || {};
  const [lc, title, root] = TYPES[kind];
  const groups = {}; for (const r of res) { const k = sectionOf(r); if (k) (groups[k] ||= []).push(r); }
  const body = Object.keys(SECTIONS).filter((k) => groups[k]).map((k) => { const [sc, st, sr] = SECTIONS[k]; return `<component><section>${tid(sr, k === 'results' || k === 'problems' || k === 'immunizations' ? '2015-08-01' : '2014-06-09')}<code code="${sc}" codeSystem="2.16.840.1.113883.6.1"/><title>${st}</title><text><list>${groups[k].map((r) => `<item>${rowText(r)}</item>`).join('')}</list></text>${groups[k].map((r) => entryXml(k, r)).join('')}</section></component>`; }).join('');
  const mrn = pat.identifier?.[0]?.value || '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:sdtc="urn:hl7-org:sdtc"><realmCode code="US"/><typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>${tid('2.16.840.1.113883.10.20.22.1.1')}${tid(root)}<id root="${esc(comp.id || bundle.id || '0')}"/><code code="${lc}" codeSystem="2.16.840.1.113883.6.1" displayName="${title}"/><title>${title}</title><effectiveTime value="${hl7ts(comp.date || bundle.timestamp)}"/><confidentialityCode code="N" codeSystem="2.16.840.1.113883.5.25"/><languageCode code="en-US"/><recordTarget><patientRole><id extension="${esc(mrn)}" root="urn:hospital-desktop:mrn"/><patient><name nullFlavor="MSK"/><administrativeGenderCode code="${{ male: 'M', female: 'F' }[pat.gender] || 'UN'}" codeSystem="2.16.840.1.113883.5.1"/><birthTime value="${hl7ts(pat.birthDate)}"/></patient></patientRole></recordTarget><author><time value="${hl7ts(comp.date || bundle.timestamp)}"/><assignedAuthor><id root="urn:hospital-desktop:system"/><assignedAuthoringDevice><softwareName>hospital-desktop</softwareName></assignedAuthoringDevice></assignedAuthor></author><custodian><assignedCustodian><representedCustodianOrganization><id root="urn:hospital-desktop"/><name>Hospital</name></representedCustodianOrganization></assignedCustodian></custodian><component><structuredBody>${body}</structuredBody></component></ClinicalDocument>`;
}

/** C-CDA XML -> FHIR document Bundle with the same content. */
export function ccdaToFhir(xml) {
  const doc = readXml(xml); const id = kid(doc, 'id')?.attrs.root; const pr = path(doc, 'recordTarget', 'patientRole'); const p = kid(pr, 'patient');
  const patient = { resourceType: 'Patient', id: 'patient', identifier: [{ system: 'urn:hospital-desktop:mrn', value: kid(pr, 'id')?.attrs.extension }], gender: { M: 'male', F: 'female' }[kid(p, 'administrativeGenderCode')?.attrs.code] || 'unknown', birthDate: isoOf(kid(p, 'birthTime')?.attrs.value) };
  const kind = Object.entries(TYPES).find(([, t]) => t[0] === kid(doc, 'code')?.attrs.code)?.[0] || 'ccd';
  const subject = { reference: 'Patient/patient' }; const out = []; const sections = [];
  for (const s of kids(path(doc, 'component', 'structuredBody'), 'component').map((c) => kid(c, 'section'))) {
    const key = Object.entries(SECTIONS).find(([, v]) => v[0] === kid(s, 'code')?.attrs.code)?.[0]; if (!key) continue;
    const refs = [];
    for (const e of kids(s, 'entry')) {
      const n = e.children[0]; let r;
      if (key === 'problems') { const o = path(n, 'entryRelationship', 'observation'); r = { resourceType: 'Condition', id: kid(n, 'id').attrs.root, clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: kid(n, 'statusCode').attrs.code === 'completed' ? 'resolved' : 'active' }] }, code: cc(kid(o, 'value')), subject, onsetDateTime: isoOf(path(o, 'effectiveTime', 'low')?.attrs.value) }; }
      if (key === 'medications') { const dq = kid(n, 'doseQuantity'); r = { resourceType: 'MedicationStatement', id: kid(n, 'id').attrs.root, status: kid(n, 'statusCode').attrs.code === 'completed' ? 'completed' : 'active', medicationCodeableConcept: cc(path(n, 'consumable', 'manufacturedProduct', 'manufacturedMaterial', 'code')), subject, effectivePeriod: { start: isoOf(path(n, 'effectiveTime', 'low')?.attrs.value) }, ...(dq ? { dosage: [{ doseAndRate: [{ doseQuantity: { value: Number(dq.attrs.value), unit: dq.attrs.unit } }] }] } : {}) }; }
      if (key === 'allergies') { const o = path(n, 'entryRelationship', 'observation'); const mf = path(o, 'entryRelationship', 'observation', 'value'); r = { resourceType: 'AllergyIntolerance', id: kid(n, 'id').attrs.root, code: cc(path(o, 'participant', 'participantRole', 'playingEntity', 'code')), patient: subject, ...(mf ? { reaction: [{ manifestation: [cc(mf)] }] } : {}) }; }
      if (key === 'results' || key === 'vitals') { const v = kid(n, 'value'); r = { resourceType: 'Observation', id: kid(n, 'id').attrs.root, status: kid(n, 'statusCode').attrs.code === 'completed' ? 'final' : 'preliminary', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: key === 'vitals' ? 'vital-signs' : 'laboratory' }] }], code: cc(kid(n, 'code')), subject, effectiveDateTime: isoOf(kid(n, 'effectiveTime').attrs.value), ...(v.attrs['xsi:type'] === 'PQ' ? { valueQuantity: { value: Number(v.attrs.value), unit: v.attrs.unit, system: 'http://unitsofmeasure.org', code: v.attrs.unit } } : { valueString: v.text || '' }) }; }
      if (key === 'immunizations') { const mm = path(n, 'consumable', 'manufacturedProduct', 'manufacturedMaterial'); r = { resourceType: 'Immunization', id: kid(n, 'id').attrs.root, status: n.attrs.negationInd === 'true' ? 'not-done' : 'completed', vaccineCode: cc(kid(mm, 'code')), patient: subject, occurrenceDateTime: isoOf(kid(n, 'effectiveTime').attrs.value), ...(kid(mm, 'lotNumberText') ? { lotNumber: kid(mm, 'lotNumberText').text } : {}) }; }
      if (r) { out.push(JSON.parse(JSON.stringify(r))); refs.push({ reference: `${r.resourceType}/${r.id}` }); }
    }
    sections.push({ title: SECTIONS[key][1], code: { coding: [{ system: 'http://loinc.org', code: SECTIONS[key][0] }] }, entry: refs });
  }
  const date = isoOf(kid(doc, 'effectiveTime')?.attrs.value);
  const composition = { resourceType: 'Composition', id, status: 'final', type: { coding: [{ system: 'http://loinc.org', code: TYPES[kind][0], display: TYPES[kind][1] }] }, subject, date, author: [{ display: 'hospital-desktop' }], title: TYPES[kind][1], section: sections };
  return { resourceType: 'Bundle', type: 'document', timestamp: date, identifier: { system: 'urn:ietf:rfc:3986', value: `urn:uuid:${id}` }, entry: [composition, patient, ...out].map((r) => ({ fullUrl: `https://hospital-desktop.invalid/fhir/${r.resourceType}/${r.id}`, resource: r })), kind };
}
