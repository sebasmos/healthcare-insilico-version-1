// A simulated second hospital for cross-community exchange (docs/STANDARDS.md): its own XCA responding gateway
// (ITI-38, ITI-39) and XDS.b repository, holding a few generated, nameless documents for one patient number.
// Nothing is stored on disk. Start it with scripts/xca-peer.mjs, or from a test with startPeer().
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createCommunityGateway } from './xds.mjs';

const oid = (s) => `2.25.${BigInt(`0x${createHash('sha256').update(String(s)).digest('hex').slice(0, 30)}`).toString()}`;

/** patientId: the XDS patient id (MRN^^^&AA&ISO) both communities use. key: the X-Gateway-Key callers must send. */
export async function startPeer({ port = 0, homeCommunityId = `urn:oid:${oid('peer')}`, patientId, key, documents = null }) {
  const repositoryUniqueId = oid(`${homeCommunityId}/repo`);
  const now = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const make = (title, code, text) => { const bytes = Buffer.from(text); return { entry: { entryUuid: randomUUID(), uniqueId: oid(`${homeCommunityId}/${title}`), mimeType: 'text/plain', title, classCode: code, typeCode: code, formatCode: 'urn:ihe:iti:xds:2017:mimeTypeSufficient', creationTime: now, patientId, repositoryUniqueId, hash: createHash('sha1').update(bytes).digest('hex'), size: bytes.length }, bytes }; };
  const held = documents || [make('Discharge summary (other hospital)', '18842-5', 'Admitted with chest pain. Troponin negative. Discharged home on day 2.'), make('Imaging report (other hospital)', '18748-4', 'XR chest: no acute abnormality.')];
  const gateway = createCommunityGateway({ homeCommunityId, repositoryUniqueId, docs: { list: async () => held.map((d) => d.entry), get: async (uid) => held.find((d) => d.entry.uniqueId === uid) || null, put: async (entry, bytes) => { held.push({ entry, bytes }); } } });
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/xca') { res.writeHead(404); return res.end(); }
    if (key && req.headers['x-gateway-key'] !== key) { res.writeHead(401); return res.end('Unknown gateway key'); }
    const chunks = []; for await (const c of req) chunks.push(c);
    const out = await gateway.soap(Buffer.concat(chunks).toString('utf8'), { actor: { kind: 'human', id: 'xca-initiator', role: 'peer' } });
    res.writeHead(out.status, { 'Content-Type': 'application/soap+xml; charset=utf-8' }); res.end(out.xml);
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/xca`, homeCommunityId, repositoryUniqueId, held, close: () => new Promise((r) => server.close(r)) };
}
