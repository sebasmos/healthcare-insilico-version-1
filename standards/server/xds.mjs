// IHE document sharing (docs/STANDARDS.md): an XDS.b document registry and repository (ITI-41 provide and register,
// ITI-18 stored query, ITI-43 retrieve), XCA gateways (ITI-38 cross gateway query, ITI-39 cross gateway retrieve,
// responding and initiating) and MHD (ITI-65 provide bundle, ITI-67 DocumentReference search, ITI-68 retrieve).
// Discharge summaries (as C-CDA), notes and imaging reports are published from the chart. Every disclosure checks
// Consent; a request from another community is never treated as the hospital's own direct care.
// SOAP messages are ebRIM 3.0 XML with the document inline (base64) rather than MTOM/XOP packaging.
import { createHash, randomUUID } from 'node:crypto';
import { readXml, fhirToCcda } from './ccda.mjs';
import { createConsent, idOfPatient } from './consent.mjs';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';

export const UUID = { findDocuments: 'urn:uuid:14d4debf-8f97-4251-9a74-a90016b0af0d', getDocuments: 'urn:uuid:5c4f972b-d56b-40ac-a5fc-c8ca9b40b9d4', docEntry: 'urn:uuid:7edca82f-054d-47f2-a032-9b2a5b5186c1', classCode: 'urn:uuid:41a5887f-8865-4c09-adf7-e362475b143a', typeCode: 'urn:uuid:f0306f51-975f-434e-a61c-c59651d33983', formatCode: 'urn:uuid:a09d5840-386c-46f2-b5ad-9c3699a4309d', patientId: 'urn:uuid:58a6f841-87b3-4a3e-92fd-a8ffeff98427', uniqueId: 'urn:uuid:2e82c1f6-a085-4c72-9da3-8640a32e42ab' };
export const ACTION = { iti18: 'urn:ihe:iti:2007:RegistryStoredQuery', iti38: 'urn:ihe:iti:2007:CrossGatewayQuery', iti39: 'urn:ihe:iti:2007:CrossGatewayRetrieve', iti41: 'urn:ihe:iti:2007:ProvideAndRegisterDocumentSet-b', iti43: 'urn:ihe:iti:2007:RetrieveDocumentSet' };
const SUCCESS = 'urn:oasis:names:tc:ebxml-regrep:ResponseStatusType:Success'; const FAILURE = 'urn:oasis:names:tc:ebxml-regrep:ResponseStatusType:Failure';
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const local = (n) => String(n?.name || '').replace(/^.*:/, '');
const walk = (n, name, out = []) => { for (const c of n?.children || []) { if (local(c) === name) out.push(c); walk(c, name, out); } return out; };
const kid = (n, name) => (n?.children || []).find((c) => local(c) === name);
const oidOf = (s) => `2.25.${BigInt(`0x${createHash('sha256').update(String(s)).digest('hex').slice(0, 30)}`).toString()}`;
const KINDS = { discharge: ['18842-5', 'Discharge summary', 'urn:hl7-org:sdwg:ccda-structuredBody:2.1', 'text/xml'], note: ['11506-3', 'Progress note', 'urn:ihe:iti:xds:2017:mimeTypeSufficient', 'text/plain'], imaging: ['18748-4', 'Diagnostic imaging study', 'urn:ihe:iti:xds:2017:mimeTypeSufficient', 'text/plain'] };
export const envelope = (action, body) => `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing"><s:Header><a:Action s:mustUnderstand="1">${action}</a:Action><a:MessageID>urn:uuid:${randomUUID()}</a:MessageID></s:Header><s:Body>${body}</s:Body></s:Envelope>`;
const slot = (name, values) => `<rim:Slot name="${name}"><rim:ValueList>${values.map((v) => `<rim:Value>${esc(v)}</rim:Value>`).join('')}</rim:ValueList></rim:Slot>`;
const cls = (scheme, id, code, system, display) => `<rim:Classification classificationScheme="${scheme}" classifiedObject="${id}" nodeRepresentation="${esc(code)}" id="urn:uuid:${randomUUID()}">${slot('codingScheme', [system])}<rim:Name><rim:LocalizedString value="${esc(display)}"/></rim:Name></rim:Classification>`;

/** Document entry metadata -> ebRIM ExtrinsicObject. */
export function entryXml(e, home) {
  const id = `urn:uuid:${e.entryUuid}`;
  return `<rim:ExtrinsicObject id="${id}" mimeType="${esc(e.mimeType)}" objectType="${UUID.docEntry}" status="urn:oasis:names:tc:ebxml-regrep:StatusType:Approved"${home ? ` home="${esc(home)}"` : ''}>${slot('creationTime', [e.creationTime])}${slot('hash', [e.hash])}${slot('size', [String(e.size)])}${slot('repositoryUniqueId', [e.repositoryUniqueId])}${slot('sourcePatientId', [e.patientId])}${slot('languageCode', ['en-US'])}<rim:Name><rim:LocalizedString value="${esc(e.title)}"/></rim:Name>${cls(UUID.classCode, id, e.classCode, '2.16.840.1.113883.6.1', e.title)}${cls(UUID.typeCode, id, e.typeCode, '2.16.840.1.113883.6.1', e.title)}${cls(UUID.formatCode, id, e.formatCode, '1.3.6.1.4.1.19376.1.2.3', e.formatCode)}<rim:ExternalIdentifier identificationScheme="${UUID.patientId}" value="${esc(e.patientId)}" id="urn:uuid:${randomUUID()}" registryObject="${id}"><rim:Name><rim:LocalizedString value="XDSDocumentEntry.patientId"/></rim:Name></rim:ExternalIdentifier><rim:ExternalIdentifier identificationScheme="${UUID.uniqueId}" value="${esc(e.uniqueId)}" id="urn:uuid:${randomUUID()}" registryObject="${id}"><rim:Name><rim:LocalizedString value="XDSDocumentEntry.uniqueId"/></rim:Name></rim:ExternalIdentifier></rim:ExtrinsicObject>`;
}
/** ebRIM ExtrinsicObjects -> metadata. */
export function readEntries(node) {
  return walk(node, 'ExtrinsicObject').map((x) => { const s = Object.fromEntries(walk(x, 'Slot').filter((sl) => !walk(x, 'Classification').some((c) => walk(c, 'Slot').includes(sl))).map((sl) => [sl.attrs.name, walk(sl, 'Value').map((v) => v.text)[0]])); const ext = (scheme) => walk(x, 'ExternalIdentifier').find((e) => e.attrs.identificationScheme === scheme)?.attrs.value; const c = (scheme) => walk(x, 'Classification').find((e) => e.attrs.classificationScheme === scheme)?.attrs.nodeRepresentation;
    return { entryUuid: x.attrs.id.replace('urn:uuid:', ''), home: x.attrs.home || null, mimeType: x.attrs.mimeType, title: walk(x, 'LocalizedString')[0]?.attrs.value, creationTime: s.creationTime, hash: s.hash, size: Number(s.size), repositoryUniqueId: s.repositoryUniqueId, patientId: ext(UUID.patientId), uniqueId: ext(UUID.uniqueId), classCode: c(UUID.classCode), typeCode: c(UUID.typeCode), formatCode: c(UUID.formatCode) }; });
}
export const queryXml = (patientId, { home = null, getIds = null } = {}) => `<query:AdhocQueryRequest xmlns:query="urn:oasis:names:tc:ebxml-regrep:xsd:query:3.0" xmlns:rim="urn:oasis:names:tc:ebxml-regrep:xsd:rim:3.0"><query:ResponseOption returnType="LeafClass" returnComposedObjects="true"/><rim:AdhocQuery id="${getIds ? UUID.getDocuments : UUID.findDocuments}"${home ? ` home="${esc(home)}"` : ''}>${getIds ? slot('$XDSDocumentEntryUniqueId', [`(${getIds.map((i) => `'${i}'`).join(',')})`]) : `${slot('$XDSDocumentEntryPatientId', [`'${patientId}'`])}${slot('$XDSDocumentEntryStatus', ["('urn:oasis:names:tc:ebxml-regrep:StatusType:Approved')"])}`}</rim:AdhocQuery></query:AdhocQueryRequest>`;
export const retrieveXml = (docs) => `<RetrieveDocumentSetRequest xmlns="urn:ihe:iti:xds-b:2007">${docs.map((d) => `<DocumentRequest>${d.home ? `<HomeCommunityId>${esc(d.home)}</HomeCommunityId>` : ''}<RepositoryUniqueId>${esc(d.repositoryUniqueId)}</RepositoryUniqueId><DocumentUniqueId>${esc(d.uniqueId)}</DocumentUniqueId></DocumentRequest>`).join('')}</RetrieveDocumentSetRequest>`;
export function readRetrieve(xml) { const doc = readXml(xml); return { status: walk(doc, 'RegistryResponse')[0]?.attrs.status, documents: walk(doc, 'DocumentResponse').map((d) => ({ home: kid(d, 'HomeCommunityId')?.text || null, repositoryUniqueId: kid(d, 'RepositoryUniqueId')?.text, uniqueId: kid(d, 'DocumentUniqueId')?.text, mimeType: kid(d, 'mimeType')?.text, data: Buffer.from(kid(d, 'Document')?.text || '', 'base64') })) }; }
const fault = (reason) => `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><s:Fault><s:Code><s:Value>s:Sender</s:Value></s:Code><s:Reason><s:Text xml:lang="en">${esc(reason)}</s:Text></s:Reason></s:Fault></s:Body></s:Envelope>`;

/**
 * A community: registry + repository on a document store. store: { list(), get(uniqueId), put(entry, bytes) } plus
 * allowed(entry, requester) for consent. Used by the hospital (on its record store) and by the simulated peer.
 */
export function createCommunityGateway({ homeCommunityId, repositoryUniqueId, docs, allowed = async () => true, onDisclose = async () => {} }) {
  async function query(body, requester, home = null) {
    const q = walk(readXml(body), 'AdhocQuery')[0]; if (!q) return { status: 400, xml: fault('No AdhocQuery') };
    const sv = (name) => walk(q, 'Slot').find((s) => s.attrs.name === name)?.children.flatMap((vl) => walk(vl, 'Value').map((v) => v.text)) || [];
    let rows;
    if (q.attrs.id === UUID.findDocuments) { const pid = (sv('$XDSDocumentEntryPatientId')[0] || '').replace(/^'|'$/g, ''); rows = (await docs.list()).filter((e) => e.patientId === pid); }
    else if (q.attrs.id === UUID.getDocuments) { const ids = (sv('$XDSDocumentEntryUniqueId')[0] || '').replace(/[()' ]/g, '').split(',').filter(Boolean); rows = (await docs.list()).filter((e) => ids.includes(e.uniqueId)); }
    else return { status: 200, xml: envelope('urn:ihe:iti:2007:RegistryStoredQueryResponse', `<query:AdhocQueryResponse xmlns:query="urn:oasis:names:tc:ebxml-regrep:xsd:query:3.0" xmlns:rs="urn:oasis:names:tc:ebxml-regrep:xsd:rs:3.0" status="${FAILURE}"><rs:RegistryErrorList><rs:RegistryError errorCode="XDSUnknownStoredQuery" codeContext="Unknown stored query" severity="urn:oasis:names:tc:ebxml-regrep:ErrorSeverityType:Error"/></rs:RegistryErrorList></query:AdhocQueryResponse>`) };
    const ok = []; for (const e of rows) if (await allowed(e, requester)) ok.push(e);
    await onDisclose('query', ok, requester);
    return { status: 200, xml: envelope(home ? 'urn:ihe:iti:2007:CrossGatewayQueryResponse' : 'urn:ihe:iti:2007:RegistryStoredQueryResponse', `<query:AdhocQueryResponse xmlns:query="urn:oasis:names:tc:ebxml-regrep:xsd:query:3.0" xmlns:rim="urn:oasis:names:tc:ebxml-regrep:xsd:rim:3.0" status="${SUCCESS}"><rim:RegistryObjectList>${ok.map((e) => entryXml(e, homeCommunityId)).join('')}</rim:RegistryObjectList></query:AdhocQueryResponse>`) };
  }
  async function retrieve(body, requester, cross = false) {
    const reqs = walk(readXml(body), 'DocumentRequest').map((d) => ({ repo: kid(d, 'RepositoryUniqueId')?.text, uid: kid(d, 'DocumentUniqueId')?.text }));
    const out = []; let failed = 0;
    for (const r of reqs) { const e = r.repo === repositoryUniqueId ? await docs.get(r.uid) : null; if (!e || !(await allowed(e.entry, requester))) { failed += 1; continue; } out.push(e); }
    await onDisclose('retrieve', out.map((x) => x.entry), requester);
    const status = !failed ? SUCCESS : out.length ? 'urn:ihe:iti:2007:ResponseStatusType:PartialSuccess' : FAILURE;
    return { status: 200, xml: envelope(cross ? 'urn:ihe:iti:2007:CrossGatewayRetrieveResponse' : 'urn:ihe:iti:2007:RetrieveDocumentSetResponse', `<RetrieveDocumentSetResponse xmlns="urn:ihe:iti:xds-b:2007"><rs:RegistryResponse xmlns:rs="urn:oasis:names:tc:ebxml-regrep:xsd:rs:3.0" status="${status}"/>${out.map((x) => `<DocumentResponse><HomeCommunityId>${esc(homeCommunityId)}</HomeCommunityId><RepositoryUniqueId>${esc(repositoryUniqueId)}</RepositoryUniqueId><DocumentUniqueId>${esc(x.entry.uniqueId)}</DocumentUniqueId><mimeType>${esc(x.entry.mimeType)}</mimeType><Document>${x.bytes.toString('base64')}</Document></DocumentResponse>`).join('')}</RetrieveDocumentSetResponse>`) };
  }
  async function provide(body, requester) {
    const doc = readXml(body); const entries = readEntries(doc); const blobs = Object.fromEntries(walk(doc, 'Document').map((d) => [d.attrs.id, Buffer.from(d.text || '', 'base64')]));
    if (!entries.length) return { status: 200, xml: envelope('urn:ihe:iti:2007:ProvideAndRegisterDocumentSet-bResponse', `<rs:RegistryResponse xmlns:rs="urn:oasis:names:tc:ebxml-regrep:xsd:rs:3.0" status="${FAILURE}"/>`) };
    for (const e of entries) { const bytes = blobs[`urn:uuid:${e.entryUuid}`] || Buffer.alloc(0); const hash = createHash('sha1').update(bytes).digest('hex'); if (e.hash && e.hash.toLowerCase() !== hash) return { status: 200, xml: envelope('urn:ihe:iti:2007:ProvideAndRegisterDocumentSet-bResponse', `<rs:RegistryResponse xmlns:rs="urn:oasis:names:tc:ebxml-regrep:xsd:rs:3.0" status="${FAILURE}"><rs:RegistryErrorList><rs:RegistryError errorCode="XDSRepositoryMetadataError" codeContext="Hash does not match the document" severity="urn:oasis:names:tc:ebxml-regrep:ErrorSeverityType:Error"/></rs:RegistryErrorList></rs:RegistryResponse>`) }; await docs.put({ ...e, hash, size: bytes.length, repositoryUniqueId }, bytes, requester); }
    return { status: 200, xml: envelope('urn:ihe:iti:2007:ProvideAndRegisterDocumentSet-bResponse', `<rs:RegistryResponse xmlns:rs="urn:oasis:names:tc:ebxml-regrep:xsd:rs:3.0" status="${SUCCESS}"/>`) };
  }
  /** One SOAP request. */
  async function soap(xml, requester) {
    const action = walk(readXml(xml), 'Action')[0]?.text?.trim();
    if (action === ACTION.iti18) return query(xml, requester);
    if (action === ACTION.iti38) return query(xml, requester, homeCommunityId);
    if (action === ACTION.iti43) return retrieve(xml, requester);
    if (action === ACTION.iti39) return retrieve(xml, requester, true);
    if (action === ACTION.iti41) return provide(xml, requester);
    return { status: 400, xml: fault(`Unsupported action ${action || '(none)'}`) };
  }
  return { soap, homeCommunityId, repositoryUniqueId };
}

/** Builds an ITI-41 request for documents [{ entry, bytes }]. */
export function provideXml(items) {
  return `<xdsb:ProvideAndRegisterDocumentSetRequest xmlns:xdsb="urn:ihe:iti:xds-b:2007"><lcm:SubmitObjectsRequest xmlns:lcm="urn:oasis:names:tc:ebxml-regrep:xsd:lcm:3.0" xmlns:rim="urn:oasis:names:tc:ebxml-regrep:xsd:rim:3.0"><rim:RegistryObjectList>${items.map((i) => entryXml({ ...i.entry, hash: createHash('sha1').update(i.bytes).digest('hex'), size: i.bytes.length })).join('')}</rim:RegistryObjectList></lcm:SubmitObjectsRequest>${items.map((i) => `<xdsb:Document id="urn:uuid:${i.entry.entryUuid}">${i.bytes.toString('base64')}</xdsb:Document>`).join('')}</xdsb:ProvideAndRegisterDocumentSetRequest>`;
}

/** The hospital's side: publishing from the chart, the registry on the record store, XCA initiating, MHD. */
export function createXds({ store, baseUrl = () => '' }) {
  const HOME = `urn:oid:${process.env.XDS_HOME_COMMUNITY_ID || oidOf('home')}`; const REPO = process.env.XDS_REPOSITORY_ID || oidOf('repository'); const AA = process.env.XDS_ASSIGNING_AUTHORITY || oidOf('mrn');
  const consent = createConsent(store);
  const pidOf = (mrn) => `${mrn}^^^&${AA}&ISO`;
  const mrnOfPatient = (p) => ((p?.identifier || []).find((i) => (i.type?.coding || []).some((c) => c.code === 'MR')) || p?.identifier?.[0])?.value || p?.id;
  const docs = {
    list: async () => (await store.query('XdsDocument', {})).map((d) => d.entry),
    get: async (uid) => { const d = (await store.query('XdsDocument', {})).find((x) => x.entry.uniqueId === uid); return d ? { entry: d.entry, bytes: Buffer.from(d.data, 'base64') } : null; },
    put: async (entry, bytes) => { const p = (await store.query('Patient', {})).find((x) => pidOf(mrnOfPatient(x)) === entry.patientId); await store.save('XdsDocument', { resourceType: 'XdsDocument', id: entry.entryUuid, entry, data: bytes.toString('base64'), patient: p ? `Patient/${p.id}` : null, _patient: p ? `Patient/${p.id}` : undefined }, { updatedBy: 'interface' }); },
  };
  const patientOfEntry = async (e) => (await store.query('XdsDocument', {})).find((x) => x.entry.uniqueId === e.uniqueId)?.patient;
  const disclose = async (what, entries, requester) => { if (!entries.length) return; await store.transaction((tx) => recordAction(tx, { runId: LIVE_RUN_ID, actor: requester.actor, kind: 'execute', action: `xds.${what}`, args: { community: requester.community || null, documents: entries.map((e) => e.uniqueId) }, description: `Document sharing ${what}: ${entries.length} document(s) to ${requester.community || requester.actor.id}` })); };
  const gateway = createCommunityGateway({ homeCommunityId: HOME, repositoryUniqueId: REPO, docs, allowed: async (e, requester) => !(await consent.blocked(idOfPatient(await patientOfEntry(e)), requester)), onDisclose: disclose });
  const communities = () => Object.fromEntries((process.env.XCA_COMMUNITIES || '').split(',').filter(Boolean).map((x) => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; }));
  const mayCall = (u) => { const h = new URL(u).hostname; return ['127.0.0.1', 'localhost', '::1'].includes(h) || (process.env.RESTRICTED_DATA !== 'true' && process.env.ALLOW_XCA_REMOTE === 'true'); };

  async function publish(body, ctx) {
    const [type, id] = String(body?.resource || '').split('/'); const kind = body?.kind || (type === 'DiagnosticReport' ? 'imaging' : type === 'Patient' ? 'discharge' : 'note');
    if (!KINDS[kind]) throw new HttpError(422, 'kind must be discharge, note or imaging');
    const r = await store.get(type, id, { branch: 'main' }); if (!r) throw new HttpError(404, `${body?.resource} not found`);
    const pid = type === 'Patient' ? r.id : idOfPatient(r._patient || r.subject?.reference); const p = await store.get('Patient', pid, { branch: 'main' }); if (!p) throw new HttpError(422, 'The record has no patient');
    let bytes;
    if (kind === 'discharge') { const rows = (await store.everything(`Patient/${p.id}`, { branch: 'main' })).filter((x) => ['Condition', 'MedicationStatement', 'MedicationRequest', 'AllergyIntolerance', 'Observation', 'Immunization'].includes(x.resourceType)).map((x) => (x.resourceType === 'MedicationRequest' ? { ...x, resourceType: 'MedicationStatement', effectivePeriod: { start: x.authoredOn } } : x)); bytes = Buffer.from(fhirToCcda({ entry: [{ resource: { resourceType: 'Composition', id: randomUUID(), date: new Date().toISOString() } }, { resource: { ...p } }, ...rows.map((resource) => ({ resource }))] }, 'discharge')); }
    else if (type === 'DocumentReference') bytes = Buffer.concat((r.content || []).map((c) => Buffer.from(c.attachment?.data || '', 'base64')));
    else bytes = Buffer.from(`${r.code?.text || r.code?.coding?.[0]?.display || 'Report'}\n\n${r.conclusion || (r.presentedForm || []).map((f) => Buffer.from(f.data || '', 'base64').toString()).join('\n') || ''}`);
    if (!bytes.length) throw new HttpError(422, 'The record has no content to publish');
    const [classCode, title, formatCode, mimeType] = KINDS[kind];
    const entry = { entryUuid: randomUUID(), uniqueId: oidOf(`${type}/${id}/${Date.now()}`), mimeType, title, classCode, typeCode: classCode, formatCode, creationTime: new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14), patientId: pidOf(mrnOfPatient(p)), repositoryUniqueId: REPO, hash: createHash('sha1').update(bytes).digest('hex'), size: bytes.length, source: `${type}/${id}` };
    await store.transaction(async (tx) => { await tx.save('XdsDocument', { resourceType: 'XdsDocument', id: entry.entryUuid, entry, data: bytes.toString('base64'), patient: `Patient/${p.id}`, _patient: `Patient/${p.id}` }, { updatedBy: ctx.actor.role }); await recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'execute', action: 'xds.publish', args: { kind, uniqueId: entry.uniqueId, source: entry.source }, patientRef: `Patient/${p.id}`, description: `Published ${title} for sharing` }); });
    return entry;
  }
  async function soapCall(urlStr, action, body) { if (!mayCall(urlStr)) throw new HttpError(403, 'Calls to other communities are off while RESTRICTED_DATA is on (or ALLOW_XCA_REMOTE is not set)'); const r = await fetch(urlStr, { method: 'POST', headers: { 'Content-Type': `application/soap+xml; charset=utf-8; action="${action}"`, 'X-Gateway-Key': process.env.XCA_PEER_KEY || '' }, body: envelope(action, body), signal: AbortSignal.timeout(15000) }); return r.text(); }
  async function remoteQuery(patientId, ctx) {
    const p = await store.get('Patient', patientId, { branch: 'main' }); if (!p) throw new HttpError(404, 'No such patient');
    const out = [];
    for (const [home, u] of Object.entries(communities())) { try { const xml = await soapCall(u, ACTION.iti38, queryXml(pidOf(mrnOfPatient(p)), { home })); out.push(...readEntries(readXml(xml)).map((e) => ({ ...e, home: e.home || home }))); } catch (err) { out.push({ home, error: err.message }); } }
    await store.transaction((tx) => recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'execute', action: 'xca.query', args: { communities: Object.keys(communities()) }, patientRef: `Patient/${p.id}`, description: `Asked ${Object.keys(communities()).length} other communities for documents` }));
    return out;
  }
  async function remoteRetrieve(home, repositoryUniqueId, uniqueId, ctx) {
    const u = communities()[home]; if (!u) throw new HttpError(404, 'Unknown community');
    const res = readRetrieve(await soapCall(u, ACTION.iti39, retrieveXml([{ home, repositoryUniqueId, uniqueId }])));
    await store.transaction((tx) => recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'execute', action: 'xca.retrieve', args: { home, uniqueId }, description: `Retrieved a document from ${home}` }));
    if (!res.documents.length) throw new HttpError(404, 'The community did not return the document');
    return res.documents[0];
  }
  /** MHD: an entry as a DocumentReference (ITI-67), with the retrieve URL (ITI-68). */
  const asDocumentReference = (e, patientRef) => ({ resourceType: 'DocumentReference', id: e.entryUuid, meta: { profile: ['https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.Minimal.DocumentReference'] }, masterIdentifier: { system: 'urn:ietf:rfc:3986', value: `urn:oid:${e.uniqueId}` }, status: 'current', type: { coding: [{ system: 'http://loinc.org', code: e.typeCode, display: e.title }] }, category: [{ coding: [{ system: 'http://loinc.org', code: e.classCode }] }], subject: { reference: patientRef }, date: `${e.creationTime.slice(0, 4)}-${e.creationTime.slice(4, 6)}-${e.creationTime.slice(6, 8)}T${e.creationTime.slice(8, 10)}:${e.creationTime.slice(10, 12)}:${e.creationTime.slice(12, 14)}Z`, content: [{ attachment: { contentType: e.mimeType, url: `${baseUrl()}/api/xds/documents/${e.uniqueId}`, size: e.size, hash: Buffer.from(e.hash, 'hex').toString('base64'), title: e.title }, format: { system: 'http://ihe.net/fhir/ihe.formatcode.fhir/CodeSystem/formatcode', code: e.formatCode } }] });
  async function mhdFind(url, ctx) {
    const pid = idOfPatient(url.searchParams.get('patient') || url.searchParams.get('subject') || ''); const rows = (await store.query('XdsDocument', {})).filter((d) => !pid || idOfPatient(d.patient) === pid);
    const ok = []; for (const d of rows) if (!(await consent.blocked(idOfPatient(d.patient), ctx))) ok.push(asDocumentReference(d.entry, d.patient));
    return { resourceType: 'Bundle', type: 'searchset', total: ok.length, entry: ok.map((resource) => ({ fullUrl: `${baseUrl()}/api/xds/mhd/DocumentReference/${resource.id}`, resource })) };
  }
  async function mhdProvide(bundle, ctx) {
    const res = (bundle?.entry || []).map((e) => ({ fullUrl: e.fullUrl, r: e.resource })); const binaries = Object.fromEntries(res.filter((x) => x.r?.resourceType === 'Binary').map((x) => [x.fullUrl, Buffer.from(x.r.data || '', 'base64')]));
    if (!res.some((x) => x.r?.resourceType === 'List')) throw new HttpError(422, 'An MHD bundle needs a SubmissionSet List');
    const made = [];
    for (const { r } of res.filter((x) => x.r?.resourceType === 'DocumentReference')) {
      const pid = idOfPatient(r.subject?.reference); const p = await store.get('Patient', pid, { branch: 'main' }); if (!p) throw new HttpError(422, `Unknown patient ${r.subject?.reference}`);
      const a = r.content?.[0]?.attachment || {}; const bytes = binaries[a.url] || Buffer.from(a.data || '', 'base64'); if (!bytes.length) throw new HttpError(422, 'The DocumentReference points at no Binary in the bundle');
      const entry = { entryUuid: randomUUID(), uniqueId: String(r.masterIdentifier?.value || '').replace(/^urn:oid:/, '') || oidOf(randomUUID()), mimeType: a.contentType || 'application/octet-stream', title: a.title || r.type?.coding?.[0]?.display || 'Document', classCode: r.category?.[0]?.coding?.[0]?.code || '11506-3', typeCode: r.type?.coding?.[0]?.code || '11506-3', formatCode: r.content?.[0]?.format?.code || 'urn:ihe:iti:xds:2017:mimeTypeSufficient', creationTime: new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14), patientId: pidOf(mrnOfPatient(p)), repositoryUniqueId: REPO, hash: createHash('sha1').update(bytes).digest('hex'), size: bytes.length };
      await store.save('XdsDocument', { resourceType: 'XdsDocument', id: entry.entryUuid, entry, data: bytes.toString('base64'), patient: `Patient/${p.id}`, _patient: `Patient/${p.id}` }, { updatedBy: ctx.actor.role }); made.push(entry);
    }
    await store.transaction((tx) => recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'execute', action: 'mhd.provide', args: { documents: made.map((m) => m.uniqueId) }, description: `MHD: ${made.length} document(s) received` }));
    return { resourceType: 'Bundle', type: 'transaction-response', entry: made.map((m) => ({ response: { status: '201 Created', location: `DocumentReference/${m.entryUuid}` } })) };
  }
  async function retrieveLocal(uid, ctx) { const d = await docs.get(uid); if (!d) throw new HttpError(404, 'No such document'); if (await consent.blocked(idOfPatient(await patientOfEntry(d.entry)), ctx)) throw new HttpError(403, 'The patient\'s consent does not allow this document to be shared for this purpose'); await disclose('retrieve', [d.entry], ctx); return d; }
  return { gateway, publish, remoteQuery, remoteRetrieve, mhdFind, mhdProvide, retrieveLocal, HOME, REPO, pidOf };
}
