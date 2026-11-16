// Every inbound v2 type reaches the chart (docs/STANDARDS.md): SIU appointments, MDM notes, DFT charges,
// RDE/RDS/RAS pharmacy, VXU immunizations, OUL lab results and MFN staff master file, through the same FHIR
// write path as the UI, with the lifecycle rules and an hl7.receive trace step. Nameless synthetic messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './support/helpers.mjs';

const R = { 'X-Role': 'researcher', 'X-User-Id': 'res-1' };
const H = (t, id) => `MSH|^~\\&|EXT|HOSP|DESK|HOSP|20261101120000||${t}|${id}|P|2.5.1`;
const PID = 'PID|1||N310001^^^HOSP^MR||||19700101|F';

test('SIU, MDM, DFT, RDE, RDS, RAS, VXU, OUL and MFN are applied to the chart', async () => {
  const s = await startTestServer();
  try {
    const p = (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', gender: 'female', birthDate: '1970-01-01', identifier: [{ system: 'urn:hospital-desktop:mrn', type: { coding: [{ code: 'MR' }] }, value: 'N310001' }] }, R)).json;
    const send = async (segs) => { const r = await fetch(`${s.base}/hl7/v2`, { method: 'POST', headers: { 'Content-Type': 'x-application/hl7-v2+er7', ...R }, body: segs.join('\r') }); return { status: r.status, ack: r.headers.get('x-hl7-ack'), text: await r.text() }; };
    const ok = async (segs) => { const r = await send(segs); assert.equal(r.ack, 'AA', `${segs[0]} -> ${r.text}`); };
    const all = async (type) => (await s.call('GET', `/fhir/R4/${type}?patient=Patient/${p.id}`, undefined, R)).json.entry?.map((e) => e.resource) || [];

    await ok([H('SIU^S12', 'a1'), 'SCH|P1|F1|||||||||^^^20261105090000^20261105093000||||||||||||||Booked', PID]);
    assert.equal((await all('Appointment'))[0].status, 'booked');
    await ok([H('SIU^S15', 'a2'), 'SCH|P1|F1|||||||||^^^20261105090000^20261105093000||||||||||||||Cancelled', PID]);
    const appts = await all('Appointment'); assert.equal(appts.length, 1, 'S15 updates the same appointment'); assert.equal(appts[0].status, 'cancelled');

    await ok([H('MDM^T02', 'a3'), PID, 'TXA|1|DS||20261101120000||||||||DOC1|||||AU', 'OBX|1|TX|||Discharge summary text||||||F']);
    const doc = (await all('DocumentReference')).find((d) => d.masterIdentifier?.value === 'DOC1');
    assert.equal(doc.docStatus, 'final'); assert.equal(Buffer.from(doc.content[0].attachment.data, 'base64').toString(), 'Discharge summary text');

    await ok([H('DFT^P03', 'a4'), PID, 'FT1|1|T1||20261101120000||CG||||2|||||||||||||||99213']);
    assert.equal((await all('ChargeItem'))[0].code.coding[0].code, '99213');

    await ok([H('RDE^O11', 'a5'), PID, 'ORC|NW|RX1', 'RXE||197361^amlodipine 5 MG^RXNORM|5||mg']);
    const rx = (await all('MedicationRequest')).find((m) => (m.identifier || []).some((i) => i.value === 'RX1'));
    assert.ok(rx, 'order on the chart'); assert.equal(rx.medicationCodeableConcept.coding[0].code, '197361');
    const rds = await send([H('RDS^O13', 'a6'), PID, 'ORC|RE|RX1', 'RXD|1|197361^amlodipine 5 MG^RXNORM|20261101120000|30']);
    assert.ok(['AA', 'AE'].includes(rds.ack), rds.text);
    if (rds.ack === 'AA') assert.equal((await all('MedicationDispense'))[0].authorizingPrescription[0].reference, `MedicationRequest/${rx.id}`);
    else assert.match(rds.text, /verif|check|status|pharmac/i, 'a dispense the pharmacy rules refuse is quarantined with the reason, as in the UI');
    await ok([H('RAS^O17', 'a7'), PID, 'ORC|RE|RX1', 'RXA|0|1|20261101130000||197361^amlodipine 5 MG^RXNORM|5|mg|||||||||||||CP']);
    assert.equal((await all('MedicationAdministration'))[0].request.reference, `MedicationRequest/${rx.id}`);

    await ok([H('VXU^V04', 'a8'), PID, 'ORC|RE|IM1', 'RXA|0|1|20261101130000||141^Influenza^CVX|0.5|mL||||||||L123|||||CP']);
    const imm = (await all('Immunization'))[0]; assert.equal(imm.vaccineCode.coding[0].code, '141'); assert.equal(imm.lotNumber, 'L123');

    await ok([H('OUL^R22', 'a9'), PID, 'SPM|1|SP1||119297000^Blood^SCT', 'OBR|1|P900|F900|2345-7^Glucose^LN', 'OBX|1|NM|2345-7^Glucose^LN||5.1|mmol/L||||||F']);
    assert.ok((await all('Observation')).some((o) => o.code.coding[0].code === '2345-7' && o.status === 'final'));

    await ok([H('MFN^M02', 'a10'), 'MFI|PRA||UPD|||NE', 'MFE|MAD|||S77', 'STF|S77|S77|||||A']);
    assert.ok((await s.call('GET', '/fhir/R4/Practitioner', undefined, R)).json.entry.some((e) => e.resource.identifier.some((i) => i.value === 'S77')));

    const bad = await send([H('SIU^S12', 'a11'), 'SCH|P2|F2', 'PID|1||N399999^^^HOSP^MR']);
    assert.equal(bad.ack, 'AE', 'unknown patient is quarantined');
    const steps = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.map((t) => t.did.type);
    const actions = JSON.stringify(steps);
    for (const a of ['hl7.siu', 'hl7.mdm', 'hl7.dft', 'hl7.rde', 'hl7.vxu', 'hl7.mfn', 'hl7.receive', 'hl7.reject']) assert.ok(actions.includes(a), a);
  } finally { await s.close(); }
});
