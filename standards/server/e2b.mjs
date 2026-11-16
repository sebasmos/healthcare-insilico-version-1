// ICH E2B(R3) individual case safety report (ICSR) export from a surveillance report (docs/STANDARDS.md).
// The message follows the ICH E2B(R3) HL7 v3 structure (MCCI_IN200100UV01 batch wrapping PORR_IN049016UV) with the
// data elements C (case), C.2 (primary source), C.3 (sender), D (patient), E (reaction), G (suspect product,
// here the AI agent and version), H (narrative). MedDRA is licensed, so the reaction carries the reported term
// only (E.i.1.1) and no MedDRA code. The patient is never named: initials are nullFlavor MSK.
// readIcsr() reads the same elements back, for the round-trip test.
import { readXml } from './ccda.mjs';

const OID = { report: '2.16.840.1.113883.3.989.2.1.1.1', ich: '2.16.840.1.113883.3.989.2.1.1', reportType: '2.16.840.1.113883.3.989.2.1.1.2', qualification: '2.16.840.1.113883.3.989.2.1.1.6', senderType: '2.16.840.1.113883.3.989.2.1.1.7', seriousness: '2.16.840.1.113883.3.989.2.1.1.19', outcome: '2.16.840.1.113883.3.989.2.1.1.11', characterisation: '2.16.840.1.113883.3.989.2.1.1.13', sex: '1.0.5218', ageUnit: '2.16.840.1.113883.6.8' };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ts = (iso) => String(iso || '').replace(/[-:]/g, '').replace('T', '').replace(/\.\d+/, '').replace(/Z$/, '').slice(0, 14);
const iso = (t) => { const m = String(t || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/); return m ? `${m[1]}-${m[2]}-${m[3]}${m[4] ? `T${m[4]}:${m[5] || '00'}:${m[6] || '00'}Z` : ''}` : null; };
const SERIOUS = { death: '34', 'life-threatening': '21' };
const OUTCOME = { death: '5', 'life-threatening': '2', severe: '2', moderate: '1', mild: '1', none: '1', 'near-miss': '1' };
const kid = (n, name) => (n?.children || []).find((c) => c.name === name);
const all = (n, name, out = []) => { for (const c of n?.children || []) { if (c.name === name) out.push(c); all(c, name, out); } return out; };

/** report: { caseId, filedAt, occurredAt, severity, harm, reachedPatient, narrative, reporterRole, agent, version, sex, ageYears, sender } */
export function toIcsr(r, { now = new Date().toISOString(), batch = `B-${r.caseId}` } = {}) {
  const serious = SERIOUS[r.severity];
  const qualification = { physician: '1', nurse: '3', pharmacist: '2', patient: '5' }[r.reporterRole] || '3';
  const obs = (code, value) => `<component><observationEvent classCode="OBS" moodCode="EVN"><code code="${code}" codeSystem="${OID.seriousness}"/><value xsi:type="BL" value="${value}"/></observationEvent></component>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<MCCI_IN200100UV01 xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ITSVersion="XML_1.0"><id extension="${esc(batch)}" root="2.16.840.1.113883.3.989.2.1.3.22"/><creationTime value="${ts(now)}"/><responseModeCode code="D"/><interactionId root="2.16.840.1.113883.1.6" extension="MCCI_IN200100UV01"/><name code="1" codeSystem="2.16.840.1.113883.3.989.2.1.1.1"/>
<PORR_IN049016UV><id extension="${esc(r.caseId)}" root="2.16.840.1.113883.3.989.2.1.3.1"/><creationTime value="${ts(now)}"/><interactionId root="2.16.840.1.113883.1.6" extension="PORR_IN049016UV"/><processingCode code="P"/><processingModeCode code="T"/><acceptAckCode code="AL"/>
<controlActProcess classCode="CACT" moodCode="EVN"><code code="PORR_TE049016UV" codeSystem="2.16.840.1.113883.1.18"/><effectiveTime value="${ts(now)}"/>
<subject typeCode="SUBJ"><investigationEvent classCode="INVSTG" moodCode="EVN"><id extension="${esc(r.caseId)}" root="2.16.840.1.113883.3.989.2.1.3.1"/><id extension="${esc(r.caseId)}" root="2.16.840.1.113883.3.989.2.1.3.2"/><code code="PAT_ADV_EVNT" codeSystem="2.16.840.1.113883.5.4"/>
<text>${esc(r.narrative || '')}</text><statusCode code="active"/><effectiveTime><low value="${ts(r.filedAt)}"/></effectiveTime><availabilityTime value="${ts(r.filedAt)}"/>
<component typeCode="COMP"><adverseEventAssessment classCode="INVSTG" moodCode="EVN"><subject1 typeCode="SBJ"><primaryRole classCode="INVSBJ"><player1 classCode="PSN" determinerCode="INSTANCE"><name nullFlavor="MSK"/><administrativeGenderCode code="${{ male: '1', female: '2' }[r.sex] || '0'}" codeSystem="${OID.sex}"/></player1>
${r.ageYears != null ? `<subjectOf2 typeCode="SBJ"><observation classCode="OBS" moodCode="EVN"><code code="3" codeSystem="${OID.ich}.19"/><value xsi:type="PQ" value="${Math.floor(r.ageYears)}" unit="a"/></observation></subjectOf2>` : ''}
<subjectOf2 typeCode="SBJ"><observation classCode="OBS" moodCode="EVN"><id root="reaction-1"/><code code="29" codeSystem="${OID.ich}.19"/><effectiveTime xsi:type="IVL_TS"><low value="${ts(r.occurredAt)}"/></effectiveTime><value xsi:type="CE" nullFlavor="OTH"><originalText>${esc(r.harm ? `AI output: ${r.harm}` : 'Problem with an AI output')}</originalText></value>
<outboundRelationship2 typeCode="PERT"><observation classCode="OBS" moodCode="EVN"><code code="27" codeSystem="${OID.ich}.19"/><value xsi:type="CE" code="${OUTCOME[r.severity] || '6'}" codeSystem="${OID.outcome}"/></observation></outboundRelationship2>
${Object.entries(SERIOUS).map(([sev, code]) => `<outboundRelationship2 typeCode="PERT"><observation classCode="OBS" moodCode="EVN"><code code="${code}" codeSystem="${OID.seriousness}"/><value xsi:type="BL" value="${r.severity === sev}"/></observation></outboundRelationship2>`).join('')}
</observation></subjectOf2>
<subjectOf2 typeCode="SBJ"><organizer classCode="CATEGORY" moodCode="EVN"><code code="4" codeSystem="${OID.ich}.20"/><component typeCode="COMP"><substanceAdministration classCode="SBADM" moodCode="EVN"><id root="product-1"/><consumable typeCode="CSM"><instanceOfKind classCode="INST"><kindOfProduct classCode="MMAT" determinerCode="KIND"><name>${esc(`AI agent ${r.agent || 'unknown'} v${r.version || '?'}`)}</name></kindOfProduct></instanceOfKind></consumable></substanceAdministration></component></organizer></subjectOf2>
</primaryRole></subject1>
<component typeCode="COMP"><causalityAssessment classCode="OBS" moodCode="EVN"><code code="20" codeSystem="${OID.ich}.19"/><value xsi:type="CE" code="1" codeSystem="${OID.characterisation}"/><subject2 typeCode="SUBJ"><productUseReference classCode="SBADM" moodCode="EVN"><id root="product-1"/></productUseReference></subject2></causalityAssessment></component>
</adverseEventAssessment></component>
<outboundRelationship typeCode="SPRT"><relatedInvestigation classCode="INVSTG" moodCode="EVN"><code code="2" codeSystem="${OID.ich}.22"/><subjectOf2 typeCode="SUBJ"><controlActEvent classCode="CACT" moodCode="EVN"><author typeCode="AUT"><assignedEntity classCode="ASSIGNED"><code code="${qualification}" codeSystem="${OID.qualification}"/></assignedEntity></author></controlActEvent></subjectOf2></relatedInvestigation></outboundRelationship>
<subjectOf1 typeCode="SUBJ"><controlActEvent classCode="CACT" moodCode="EVN"><author typeCode="AUT"><assignedEntity classCode="ASSIGNED"><code code="3" codeSystem="${OID.senderType}"/><representedOrganization classCode="ORG" determinerCode="INSTANCE"><name>${esc(r.sender || 'Hospital')}</name></representedOrganization></assignedEntity></author></controlActEvent></subjectOf1>
<subjectOf2 typeCode="SUBJ"><investigationCharacteristic classCode="OBS" moodCode="EVN"><code code="1" codeSystem="${OID.ich}.23"/><value xsi:type="CE" code="1" codeSystem="${OID.reportType}"/></investigationCharacteristic></subjectOf2>
<subjectOf2 typeCode="SUBJ"><investigationCharacteristic classCode="OBS" moodCode="EVN"><code code="3" codeSystem="${OID.ich}.23"/><value xsi:type="BL" value="${Boolean(serious)}"/></investigationCharacteristic></subjectOf2>
</investigationEvent></subject></controlActProcess></PORR_IN049016UV></MCCI_IN200100UV01>`;
}

/** Reads the elements written by toIcsr back into the same report fields. */
export function readIcsr(xml) {
  const doc = readXml(xml); const ev = all(doc, 'investigationEvent')[0];
  const reaction = all(ev, 'observation').find((o) => kid(o, 'code')?.attrs.code === '29');
  const seriousCodes = all(reaction, 'observation').filter((o) => kid(o, 'code')?.attrs.codeSystem === OID.seriousness && kid(o, 'value')?.attrs.value === 'true').map((o) => kid(o, 'code').attrs.code);
  const outcome = all(reaction, 'observation').find((o) => kid(o, 'code')?.attrs.code === '27');
  const age = all(ev, 'observation').find((o) => kid(o, 'code')?.attrs.code === '3');
  const qual = all(ev, 'relatedInvestigation')[0]; const product = all(ev, 'kindOfProduct')[0];
  const m = /^AI agent (.*) v(.*)$/.exec(kid(product, 'name')?.text || '');
  return {
    caseId: kid(ev, 'id')?.attrs.extension, filedAt: iso(kid(kid(ev, 'effectiveTime'), 'low')?.attrs.value), occurredAt: iso(kid(kid(reaction, 'effectiveTime'), 'low')?.attrs.value),
    severity: seriousCodes.includes('34') ? 'death' : seriousCodes.includes('21') ? 'life-threatening' : null, outcomeCode: kid(outcome, 'value')?.attrs.code,
    harm: (/^AI output: (.*)$/.exec(kid(kid(reaction, 'value'), 'originalText')?.text || '') || [])[1] || null, narrative: kid(ev, 'text')?.text || '',
    reporterQualification: all(qual, 'code').find((c) => c.attrs.codeSystem === OID.qualification)?.attrs.code, agent: m?.[1], version: m?.[2],
    sex: { 1: 'male', 2: 'female' }[all(ev, 'administrativeGenderCode')[0]?.attrs.code] || 'unknown', ageYears: age ? Number(kid(age, 'value').attrs.value) : null,
    patientName: all(ev, 'player1')[0] && kid(all(ev, 'player1')[0], 'name')?.attrs.nullFlavor,
  };
}
