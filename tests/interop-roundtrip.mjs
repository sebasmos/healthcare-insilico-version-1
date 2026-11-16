// Round trips for the standards work (docs/STANDARDS.md): HL7 v2 -> FHIR -> HL7 v2 and X12 -> record -> X12.
// Every sample is synthetic and nameless.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v2ToFhir, fhirToV2 } from '../standards/server/v2.mjs';
import * as x12 from '../insurance-and-billing/server/x12.mjs';

const H = (t, id) => `MSH|^~\\&|LAB|HOSP|DESK|HOSP|20261101120000||${t}|${id}|P|2.5.1`;
const V2 = {
  A01: [H('ADT^A01', 'c1'), 'EVN|A01|20261101115900', 'PID|1||N300001||||19700101|F', 'PV1|1|I|W1^101^A||||||||||||||||V1|||||||||||||||||||||||||20261101110000'],
  A03: [H('ADT^A03', 'c2'), 'EVN|A03|20261102115900', 'PID|1||N300001||||19700101|F', 'PV1|1|I|W1^101^A||||||||||||||||V1|||||||||||||||||||||||||20261101110000|20261102110000'],
  A05: [H('ADT^A05', 'c3'), 'PID|1||N300002||||19800202|M', 'PV1|1|I|||||||||||||||||V2'],
  A28: [H('ADT^A28', 'c4'), 'PID|1||N300003||||19900303|U'],
  A31: [H('ADT^A31', 'c5'), 'PID|1||N300003||||19900304|U'],
  A40: [H('ADT^A40', 'c6'), 'PID|1||N300004||||19600101|F', 'MRG|N300009'],
  S12: [H('SIU^S12', 'c7'), 'SCH|P1|F1|||||||||^^^20261105090000^20261105093000||||||||||||||Booked', 'PID|1||N300001||||19700101|F'],
  T02: [H('MDM^T02', 'c8'), 'EVN|T02|20261101120000', 'PID|1||N300001||||19700101|F', 'TXA|1|DS||20261101120000||||||||DOC1|||||AU', 'OBX|1|TX|||Discharge summary text||||||F'],
  P03: [H('DFT^P03', 'c9'), 'PID|1||N300001||||19700101|F', 'FT1|1|T1||20261101120000||CG||||2|||||||||||||||99213'],
  O01: [H('ORM^O01', 'c10'), 'PID|1||N300001||||19700101|F', 'ORC|NW|P100|F100||SC', 'OBR|1|P100|F100|2345-7^Glucose^LN|||20261101120000'],
  R01: [H('ORU^R01', 'c11'), 'PID|1||N300001||||19700101|F', 'OBR|1|P100|F100|2345-7^Glucose^LN|||20261101120000||||||||||||||||||F', 'OBX|1|NM|2345-7^Glucose^LN||5.4|mmol/L|3.9-5.6|N|||F|||20261101121500'],
  PCD01: [H('ORU^R01', 'c12'), 'PID|1||N300001||||19700101|F', 'OBR|1|P200||182777000^monitoring^SCT', 'OBX|1|NM|150456^SpO2^MDC|1.1.1|97|%|||||F|||20261101121500||||MON-7'],
  R40: [H('ORU^R40', 'c13'), 'PID|1||N300001||||19700101|F', 'OBR|1|AL1||196616^alarm^MDC', 'OBX|1|ST|196616^Low SpO2^MDC||SpO2 LOW||||||F|||20261101121600||||MON-7'],
  R22: [H('OUL^R22', 'c14'), 'PID|1||N300001||||19700101|F', 'SPM|1|SP1||119297000^Blood^SCT|||||||||||||20261101113000', 'OBR|1|P100|F100|2345-7^Glucose^LN', 'OBX|1|NM|2345-7^Glucose^LN||5.1|mmol/L|||||F'],
  O11: [H('RDE^O11', 'c15'), 'PID|1||N300001||||19700101|F', 'ORC|NW|RX1', 'RXE||197361^amlodipine 5 MG^RXNORM|5||mg'],
  O13: [H('RDS^O13', 'c16'), 'PID|1||N300001||||19700101|F', 'ORC|RE|RX1', 'RXD|1|197361^amlodipine 5 MG^RXNORM|20261101120000|30'],
  O17: [H('RAS^O17', 'c17'), 'PID|1||N300001||||19700101|F', 'ORC|RE|RX1', 'RXA|0|1|20261101130000||197361^amlodipine 5 MG^RXNORM|5|mg|||||||||||||CP'],
  V04: [H('VXU^V04', 'c18'), 'PID|1||N300001||||19700101|F', 'ORC|RE|IM1', 'RXA|0|1|20261101130000||141^Influenza^CVX|0.5|mL||||||||L123|||||CP'],
  M02: [H('MFN^M02', 'c19'), 'MFI|PRA||UPD|||NE', 'MFE|MAD|||S1', 'STF|S1|S1|||||A'],
  Q22: [H('QBP^Q22^QBP_Q21', 'c20'), 'QPD|IHE PDQ Query|Q1|@PID.7^19700101', 'RCP|I'],
  Q23: [H('QBP^Q23^QBP_Q21', 'c21'), 'QPD|IHE PIX Query|Q2|N300001^^^HOSP', 'RCP|I'],
  Q11: [H('QBP^Q11^Z44', 'c22'), 'QPD|Z44^Request Evaluated History^CDCPHINVS|Q3|N300001', 'RCP|I'],
};

test('HL7 v2 -> FHIR -> HL7 v2 gives the same message for every supported event', () => {
  for (const [name, segs] of Object.entries(V2)) {
    const text = segs.join('\r');
    const bundle = v2ToFhir(text);
    assert.equal(bundle.type, 'message', name);
    assert.equal(bundle.entry[0].resource.resourceType, 'MessageHeader', name);
    assert.equal(fhirToV2(bundle), text, `${name} round trip`);
  }
  const lab = v2ToFhir(V2.R01.join('\r')).entry.map((e) => e.resource);
  const obs = lab.find((r) => r.resourceType === 'Observation');
  assert.deepEqual(obs.valueQuantity, { value: 5.4, unit: 'mmol/L', system: 'http://unitsofmeasure.org', code: 'mmol/L' });
  assert.equal(obs.code.coding[0].system, 'http://loinc.org');
  assert.equal(v2ToFhir(V2.A40.join('\r')).entry[1].resource.link[0].type, 'replaces');
  assert.equal(v2ToFhir(V2.V04.join('\r')).entry[2].resource.vaccineCode.coding[0].system, 'http://hl7.org/fhir/sid/cvx');
  assert.equal(v2ToFhir(V2.PCD01.join('\r')).entry.at(-1).resource.device.display, 'MON-7');
});

const ENV = { sender: 'HOSPITAL', receiver: 'INSURER', control: 7, at: '2026-11-01T12:00:00.000Z' };
const sub = { patientNumber: 'N300001', memberId: 'M1', birthDate: '1970-01-01', gender: 'female' };

test('X12 837D, 820 and TA1 render and parse back to the same record', () => {
  const claim = { id: 'CLM1', type: 'dental', createdAt: ENV.at, total: 150, placeOfService: '11', billing: { npi: '1234567893' }, payer: { id: 'P1', name: 'PAYER' }, subscriber: sub, diagnoses: [{ code: 'K021' }], lines: [{ n: 1, code: 'D2391', charge: 150, units: 1, date: '2026-11-01', tooth: '14', surfaces: ['O', 'D'] }] };
  const text = x12.claim837(claim, ENV);
  assert.equal(x12.validate(text).ok ?? true, true);
  const tx = x12.parse(text).transactions[0];
  assert.equal(tx.type, '837D'); assert.equal(tx.version, '005010X224A2');
  const back = x12.readClaim837(tx);
  assert.equal(back.type, 'dental');
  assert.deepEqual({ code: back.lines[0].code, tooth: back.lines[0].tooth, surfaces: back.lines[0].surfaces, charge: back.lines[0].charge, units: back.lines[0].units }, { code: 'D2391', tooth: '14', surfaces: ['O', 'D'], charge: 150, units: 1 });
  assert.equal(x12.claim837(back, ENV), text, '837D X12 -> record -> X12');
  const prem = { id: 'PAY1', at: '2026-11-01', amount: 900, method: 'ACH', payer: { name: 'EMPLOYER', id: 'E1' }, payee: { name: 'PAYER', id: 'P1' }, members: [{ memberId: 'M1', amount: 450, period: '20261101-20261130' }, { memberId: 'M2', amount: 450, period: '20261101-20261130' }] };
  const t820 = x12.premium820(prem, ENV);
  const r820 = x12.readPremium820(x12.parse(t820).transactions[0]);
  assert.deepEqual(r820, prem); assert.equal(x12.premium820(r820, ENV), t820);
  const ack = x12.ta1({ control: 7, at: ENV.at, code: 'R', note: '022' });
  assert.deepEqual(x12.readTa1(ack), { control: 7, code: 'R', note: '022' });
});

import { fhirToCcda, ccdaToFhir } from '../standards/server/ccda.mjs';
test('C-CDA R2.1 -> FHIR -> C-CDA keeps every section, for each document type', () => {
  const sub = { reference: 'Patient/patient' };
  const at = '2026-11-01T12:00:00Z';
  const resources = [
    { resourceType: 'Composition', id: '11111111-1111-4111-8111-111111111111', date: at },
    { resourceType: 'Patient', id: 'patient', identifier: [{ value: 'N300001' }], gender: 'female', birthDate: '1970-01-01' },
    { resourceType: 'Condition', id: 'c1', clinicalStatus: { coding: [{ code: 'active' }] }, code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'E11.9', display: 'Type 2 diabetes' }] }, subject: sub, onsetDateTime: '2020-01-01' },
    { resourceType: 'MedicationStatement', id: 'm1', status: 'active', medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '860975', display: 'metformin' }] }, subject: sub, effectivePeriod: { start: '2020-02-01' }, dosage: [{ doseAndRate: [{ doseQuantity: { value: 500, unit: 'mg' } }] }] },
    { resourceType: 'AllergyIntolerance', id: 'a1', code: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '7980', display: 'penicillin' }] }, patient: sub, reaction: [{ manifestation: [{ coding: [{ system: 'http://snomed.info/sct', code: '247472004', display: 'hives' }] }] }] },
    { resourceType: 'Observation', id: 'o1', status: 'final', category: [{ coding: [{ code: 'laboratory' }] }], code: { coding: [{ system: 'http://loinc.org', code: '4548-4', display: 'HbA1c' }] }, subject: sub, effectiveDateTime: at, valueQuantity: { value: 7.1, unit: '%', code: '%' } },
    { resourceType: 'Observation', id: 'o2', status: 'final', category: [{ coding: [{ code: 'vital-signs' }] }], code: { coding: [{ system: 'http://loinc.org', code: '8867-4', display: 'Heart rate' }] }, subject: sub, effectiveDateTime: at, valueQuantity: { value: 72, unit: '/min', code: '/min' } },
    { resourceType: 'Immunization', id: 'i1', status: 'completed', vaccineCode: { coding: [{ system: 'http://hl7.org/fhir/sid/cvx', code: '141', display: 'Influenza' }] }, patient: sub, occurrenceDateTime: at, lotNumber: 'L123' },
  ];
  for (const kind of ['ccd', 'discharge', 'referral', 'consult', 'progress']) {
    const xml = fhirToCcda({ resourceType: 'Bundle', type: 'document', entry: resources.map((resource) => ({ resource })) }, kind);
    assert.ok(!/<given>|<family>/.test(xml), 'no patient names');
    const fhir = ccdaToFhir(xml);
    assert.equal(fhir.kind, kind);
    assert.equal(fhir.entry[0].resource.section.length, 6);
    assert.equal(fhirToCcda(fhir, kind), xml, `${kind}: C-CDA -> FHIR -> C-CDA`);
  }
  const back = ccdaToFhir(fhirToCcda({ resourceType: 'Bundle', entry: resources.map((resource) => ({ resource })) })).entry.map((e) => e.resource);
  assert.deepEqual(back.find((r) => r.id === 'o1').valueQuantity, { value: 7.1, unit: '%', system: 'http://unitsofmeasure.org', code: '%' });
  assert.equal(back.find((r) => r.id === 'i1').lotNumber, 'L123');
  assert.equal(back.find((r) => r.id === 'a1').reaction[0].manifestation[0].coding[0].code, '247472004');
});
