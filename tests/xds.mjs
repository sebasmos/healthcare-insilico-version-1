// IHE document sharing (docs/STANDARDS.md): XDS.b publish, stored query and retrieve; XCA with a simulated second
// hospital (query and retrieve both ways); MHD find, retrieve and provide; Consent on every disclosure.
// All documents are generated at run time and nameless.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { startTestServer } from './support/helpers.mjs';
import { startPeer } from '../standards/server/xca-peer.mjs';
import { envelope, queryXml, retrieveXml, readEntries, readRetrieve, provideXml, ACTION } from '../standards/server/xds.mjs';
import { readXml } from '../standards/server/ccda.mjs';

const D = { 'X-Role': 'physician', 'X-User-Id': 'doc-1' };
const PEER_KEY = 'test-xca-peer-key-0123456789abcd';

test('XDS.b, XCA and MHD: publish, query, retrieve, a second hospital, and consent', async () => {
  process.env.XCA_PEER_KEY = PEER_KEY; process.env.XDS_ASSIGNING_AUTHORITY = '1.2.3.4.5';
  const pid = 'N360001^^^&1.2.3.4.5&ISO';
  const peer = await startPeer({ patientId: pid, key: PEER_KEY });
  process.env.XCA_COMMUNITIES = `${peer.homeCommunityId}=${peer.url}`;
  const s = await startTestServer();
  try {
    const p = (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', gender: 'female', birthDate: '1970-01-01', identifier: [{ system: 'urn:hospital-desktop:mrn', type: { coding: [{ code: 'MR' }] }, value: 'N360001' }] }, D)).json;
    await s.call('POST', '/fhir/R4/Condition', { resourceType: 'Condition', subject: { reference: `Patient/${p.id}` }, clinicalStatus: { coding: [{ code: 'active' }] }, code: { coding: [{ system: 'http://snomed.info/sct', code: '44054006', display: 'Diabetes' }] } }, D);
    const note = await s.store.save('DocumentReference', { resourceType: 'DocumentReference', status: 'current', docStatus: 'final', subject: { reference: `Patient/${p.id}` }, type: { text: 'Progress note' }, content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('Seen today; plan unchanged.').toString('base64') } }] });
    const rep = await s.store.save('DiagnosticReport', { resourceType: 'DiagnosticReport', status: 'final', subject: { reference: `Patient/${p.id}` }, code: { text: 'CT head' }, conclusion: 'No acute intracranial abnormality.' });
    // Publish a discharge summary (C-CDA), a note and an imaging report.
    const pub = [];
    for (const body of [{ resource: `Patient/${p.id}`, kind: 'discharge' }, { resource: `DocumentReference/${note.id}` }, { resource: `DiagnosticReport/${rep.id}` }]) { const r = await s.call('POST', '/api/xds/publish', body, D); assert.equal(r.status, 201, r.text); pub.push(r.json); }
    assert.equal(pub[0].mimeType, 'text/xml'); assert.equal(pub[0].patientId, pid);
    // The second hospital asks us (XCA ITI-38 and ITI-39 to our responding gateway).
    const soap = (action, body, key = PEER_KEY) => fetch(`${s.base}/xds/soap`, { method: 'POST', headers: { 'Content-Type': 'application/soap+xml', 'X-Gateway-Key': key }, body: envelope(action, body) });
    assert.equal((await soap(ACTION.iti38, queryXml(pid), 'wrong-key-wrong-key-wrong-key-xx')).status, 401);
    assert.equal((await fetch(`${s.base}/fhir/R4/Patient`, { headers: { 'X-Gateway-Key': PEER_KEY } })).status, 403, 'the peer key opens nothing but the SOAP endpoint');
    const qtext = await (await soap(ACTION.iti38, queryXml(pid, { home: 'x' }))).text(); const found = readEntries(readXml(qtext));
    assert.equal(found.length, 3); assert.ok(found.every((e) => e.home));
    const ccda = readRetrieve(await (await soap(ACTION.iti39, retrieveXml([found.find((e) => e.mimeType === 'text/xml')]))).text());
    assert.match(ccda.status, /Success/); assert.match(ccda.documents[0].data.toString(), /<ClinicalDocument/); assert.match(ccda.documents[0].data.toString(), /18842-5/);
    assert.equal(createHash('sha1').update(ccda.documents[0].data).digest('hex'), found.find((e) => e.mimeType === 'text/xml').hash, 'the hash in the metadata matches the bytes');
    // ITI-41 from the other hospital: a document arrives; a wrong hash is refused.
    const incoming = { entry: { entryUuid: randomUUID(), uniqueId: '1.2.3.4.5.99.1', mimeType: 'text/plain', title: 'Referral letter', classCode: '57133-1', typeCode: '57133-1', formatCode: 'urn:ihe:iti:xds:2017:mimeTypeSufficient', creationTime: '20261101120000', patientId: pid, repositoryUniqueId: 'x' }, bytes: Buffer.from('Please review.') };
    assert.match(await (await soap(ACTION.iti41, provideXml([incoming]))).text(), /ResponseStatusType:Success/);
    assert.match(await (await soap(ACTION.iti41, provideXml([incoming]).replace(createHash('sha1').update(incoming.bytes).digest('hex'), 'deadbeef'))).text(), /Hash does not match/);
    // We ask the second hospital (XCA initiating gateway).
    const remote = (await s.call('GET', `/api/xds/remote?patient=${p.id}`, undefined, D)).json.documents;
    assert.equal(remote.length, 2); assert.equal(remote[0].home, peer.homeCommunityId);
    const got = await fetch(`${s.base}/api/xds/remote/${encodeURIComponent(remote[0].home)}/${remote[0].repositoryUniqueId}/${remote[0].uniqueId}`, { headers: D });
    assert.equal(got.status, 200); assert.match(await got.text(), /Discharged home|no acute/);
    // MHD: find (ITI-67), retrieve (ITI-68), provide (ITI-65).
    const mhd = (await s.call('GET', `/api/xds/mhd/DocumentReference?patient=Patient/${p.id}`, undefined, D)).json;
    assert.equal(mhd.total, 4); const dr = mhd.entry.find((e) => e.resource.content[0].attachment.contentType === 'text/plain').resource;
    assert.match(dr.meta.profile[0], /IHE.MHD/);
    const bytes = await fetch(`${s.base}${new URL(dr.content[0].attachment.url, s.base).pathname}`, { headers: D }); assert.equal(bytes.status, 200);
    const bin = { resourceType: 'Binary', contentType: 'text/plain', data: Buffer.from('Outside clinic letter.').toString('base64') };
    const prov = await s.call('POST', '/api/xds/mhd', { resourceType: 'Bundle', type: 'transaction', meta: { profile: ['https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.Minimal.ProvideBundle'] }, entry: [{ fullUrl: 'urn:uuid:list-1', resource: { resourceType: 'List', status: 'current', mode: 'working', code: { coding: [{ code: 'submissionset' }] } } }, { fullUrl: 'urn:uuid:dr-1', resource: { resourceType: 'DocumentReference', status: 'current', subject: { reference: `Patient/${p.id}` }, content: [{ attachment: { contentType: 'text/plain', url: 'urn:uuid:bin-1', title: 'Clinic letter' } }] } }, { fullUrl: 'urn:uuid:bin-1', resource: bin }] }, D);
    assert.equal(prov.status, 200, prov.text); assert.equal(prov.json.entry[0].response.status, '201 Created');
    // Consent: a deny stops the other hospital, but not our own staff.
    await s.call('POST', '/fhir/R4/Consent', { resourceType: 'Consent', status: 'active', scope: { coding: [{ code: 'patient-privacy' }] }, category: [{ text: 'privacy' }], patient: { reference: `Patient/${p.id}` }, provision: { type: 'deny' } }, D);
    assert.equal(readEntries(readXml(await (await soap(ACTION.iti38, queryXml(pid, { home: 'x' }))).text())).length, 0, 'the other hospital sees nothing');
    assert.match(readRetrieve(await (await soap(ACTION.iti39, retrieveXml([found[0]]))).text()).status, /Failure/);
    assert.equal((await s.call('GET', `/api/xds/mhd/DocumentReference?patient=Patient/${p.id}`, undefined, D)).json.total, 5, 'direct care still finds them');
    assert.equal((await s.call('GET', `/api/xds/mhd/DocumentReference?patient=Patient/${p.id}`, undefined, { 'X-Role': 'researcher', 'X-User-Id': 'r1' })).json.total, 0, 'research does not');
    const steps = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.map((t) => t.did.type);
    for (const a of ['xds.publish', 'xds.query', 'xds.retrieve', 'xca.query', 'xca.retrieve', 'mhd.provide']) assert.ok(steps.includes(a), a);
  } finally { await s.close(); await peer.close(); for (const k of ['XCA_PEER_KEY', 'XCA_COMMUNITIES', 'XDS_ASSIGNING_AUTHORITY']) delete process.env[k]; }
});
