// UDAP (HL7 UDAP Security IG 1.0, docs/STANDARDS.md): signed discovery metadata, dynamic client registration from
// a signed software statement with an x5c certificate chain, certificate-based trust against configured anchors,
// and the B2B client credentials grant with the hl7-b2b authorization extension. It issues the same access tokens
// as SMART Backend Services, carrying the purpose of use into the Consent checks.
// Configuration: UDAP_TRUST_ANCHORS (PEM file of trusted CA certificates), UDAP_SERVER_CERT and UDAP_SERVER_KEY
// (PEM, the server's own signing certificate and key). Without them UDAP is off. Use a local test CA only.
import fs from 'node:fs';
import { X509Certificate, createHash, createPrivateKey, sign as signRaw, verify as verifyRaw } from 'node:crypto';
import { HttpError } from '../../platform/server/http.mjs';

const b64u = (v) => Buffer.from(v).toString('base64url');
const POU = /^urn:oid:2\.16\.840\.1\.113883\.5\.8#([A-Z]+)$/;
const ALG = { RS256: ['RSA-SHA256', {}], RS384: ['RSA-SHA384', {}], ES256: ['SHA256', { dsaEncoding: 'ieee-p1363' }], ES384: ['SHA384', { dsaEncoding: 'ieee-p1363' }] };
const pemCerts = (text) => (String(text).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []).map((p) => new X509Certificate(p));

export function createUdap({ store, smart, baseUrl = () => '', env = process.env }) {
  const seen = new Map();
  const config = () => {
    if (!env.UDAP_TRUST_ANCHORS || !env.UDAP_SERVER_CERT || !env.UDAP_SERVER_KEY) return null;
    return { anchors: pemCerts(fs.readFileSync(env.UDAP_TRUST_ANCHORS, 'utf8')), cert: pemCerts(fs.readFileSync(env.UDAP_SERVER_CERT, 'utf8')), key: createPrivateKey(fs.readFileSync(env.UDAP_SERVER_KEY, 'utf8')) };
  };
  const need = () => { const c = config(); if (!c) throw new HttpError(404, 'UDAP is not configured on this server', 'not-found'); return c; };
  const sign = (claims, c) => { const alg = c.key.asymmetricKeyType === 'ec' ? 'ES256' : 'RS256'; const head = b64u(JSON.stringify({ alg, typ: 'JWT', x5c: c.cert.map((x) => x.raw.toString('base64')) })); const body = b64u(JSON.stringify(claims)); return `${head}.${body}.${b64u(signRaw(ALG[alg][0], Buffer.from(`${head}.${body}`), { key: c.key, ...ALG[alg][1] }))}`; };

  /** Verifies a JWT signed with the leaf of its x5c chain, and the chain up to a trust anchor. Returns { claims, leaf, san }. */
  function verifyChained(jwt, c, { aud, maxAge = 300 }) {
    const [h, p, s] = String(jwt || '').split('.'); if (!s) throw new HttpError(400, 'Not a signed JWT', 'invalid_software_statement');
    let head; let claims; try { head = JSON.parse(Buffer.from(h, 'base64url')); claims = JSON.parse(Buffer.from(p, 'base64url')); } catch { throw new HttpError(400, 'The JWT cannot be read', 'invalid_software_statement'); }
    const alg = ALG[head.alg]; if (!alg) throw new HttpError(400, `alg ${head.alg} is not supported`, 'invalid_software_statement');
    const chain = (head.x5c || []).map((d) => new X509Certificate(Buffer.from(d, 'base64'))); if (!chain.length) throw new HttpError(400, 'The JWT header has no x5c certificate chain', 'invalid_software_statement');
    const now = Date.now();
    for (const x of chain) if (Date.parse(x.validFrom) > now || Date.parse(x.validTo) < now) throw new HttpError(401, 'A certificate in the chain is outside its validity period', 'invalid_software_statement');
    for (let i = 0; i < chain.length - 1; i += 1) if (!chain[i].checkIssued(chain[i + 1]) || !chain[i].verify(chain[i + 1].publicKey)) throw new HttpError(401, 'The certificate chain is broken', 'invalid_software_statement');
    const top = chain.at(-1); const anchored = c.anchors.some((a) => (a.fingerprint256 === top.fingerprint256) || (top.checkIssued(a) && top.verify(a.publicKey)));
    if (!anchored) throw new HttpError(401, 'The certificate chain does not lead to a trusted anchor', 'invalid_software_statement');
    const leaf = chain[0];
    if (!verifyRaw(alg[0], Buffer.from(`${h}.${p}`), { key: leaf.publicKey, ...alg[1] }, Buffer.from(s, 'base64url'))) throw new HttpError(401, 'The signature does not match the leaf certificate', 'invalid_software_statement');
    const t = Math.floor(now / 1000);
    if (aud && String(claims.aud).replace(/\/$/, '') !== aud) throw new HttpError(401, `aud must be ${aud}`, 'invalid_software_statement');
    if (!(claims.exp > t) || claims.exp > t + maxAge || !(claims.iat <= t + 5)) throw new HttpError(401, 'exp and iat must make a short-lived JWT', 'invalid_software_statement');
    if (!claims.jti || seen.has(`${claims.iss}:${claims.jti}`)) throw new HttpError(401, 'jti is missing or was used before', 'invalid_software_statement'); seen.set(`${claims.iss}:${claims.jti}`, claims.exp);
    const san = (leaf.subjectAltName || '').split(/,\s*/).filter((x) => x.startsWith('URI:')).map((x) => x.slice(4));
    return { claims, leaf, san };
  }

  function metadata() {
    const c = need(); const b = baseUrl(); const now = Math.floor(Date.now() / 1000);
    const m = { udap_versions_supported: ['1'], udap_profiles_supported: ['udap_dcr', 'udap_authn', 'udap_authz'], udap_authorization_extensions_supported: ['hl7-b2b'], udap_authorization_extensions_required: ['hl7-b2b'], udap_certifications_supported: [], udap_certifications_required: [], grant_types_supported: ['client_credentials'], scopes_supported: ['system/*.rs', 'system/Patient.rs', 'system/DocumentReference.rs', 'system/Observation.rs'], token_endpoint: `${b}/oauth/token`, token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['RS256', 'RS384', 'ES256', 'ES384'], registration_endpoint: `${b}/oauth/udap/register`, registration_endpoint_jwt_signing_alg_values_supported: ['RS256', 'RS384', 'ES256', 'ES384'] };
    return { ...m, signed_metadata: sign({ iss: `${b}/fhir/R4`, sub: `${b}/fhir/R4`, iat: now, exp: now + 3600, jti: createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 24), token_endpoint: m.token_endpoint, registration_endpoint: m.registration_endpoint }, c) };
  }

  async function register(body) {
    const c = need(); if (String(body?.udap) !== '1') throw new HttpError(400, 'udap must be "1"', 'invalid_client_metadata');
    const { claims, leaf, san } = verifyChained(body.software_statement, c, { aud: `${baseUrl()}/oauth/udap/register` });
    if (!claims.iss || claims.iss !== claims.sub || !san.includes(claims.iss)) throw new HttpError(401, 'iss and sub must equal a URI subject alternative name of the certificate', 'invalid_software_statement');
    const grants = claims.grant_types || []; const id = `udap-${createHash('sha256').update(`${claims.iss}|${leaf.fingerprint256}`).digest('hex').slice(0, 20)}`;
    if (!grants.length) { await store.transaction(async (tx) => { const old = await tx.get('SmartClient', id); if (old) await tx.save('SmartClient', { ...(({ _seq, ...d }) => d)(old), revoked: true, grantTypes: [] }, { updatedBy: 'udap' }); }); return { status: 200, body: { client_id: id, cancelled: true } }; }
    if (grants.some((g) => g !== 'client_credentials')) throw new HttpError(400, 'Only client_credentials (B2B) is offered here', 'invalid_client_metadata');
    if (claims.token_endpoint_auth_method && claims.token_endpoint_auth_method !== 'private_key_jwt') throw new HttpError(400, 'token_endpoint_auth_method must be private_key_jwt', 'invalid_client_metadata');
    const scope = String(claims.scope || 'system/*.rs').split(/\s+/).filter((s) => s.startsWith('system/') && /\.(rs|r|s|read)$/.test(s)).join(' ') || 'system/*.rs';
    const existed = Boolean(await store.get('SmartClient', id));
    const doc = { resourceType: 'SmartClient', id, name: String(claims.client_name || claims.iss).slice(0, 120), redirectUris: [], grantTypes: ['client_credentials'], jwks: { keys: [{ ...leaf.publicKey.export({ format: 'jwk' }), kid: leaf.fingerprint256 }] }, secretHash: null, scope, allowWrite: false, udap: { iss: claims.iss, fingerprint: leaf.fingerprint256, subject: leaf.subject, issuer: leaf.issuer, notAfter: leaf.validTo }, createdAt: new Date().toISOString() };
    await store.transaction((tx) => tx.save('SmartClient', doc, { updatedBy: 'udap' }));
    return { status: existed ? 200 : 201, body: { client_id: id, software_statement: body.software_statement, client_name: doc.name, grant_types: doc.grantTypes, token_endpoint_auth_method: 'private_key_jwt', scope } };
  }

  /** The B2B token request: client_credentials with an x5c-signed assertion and the hl7-b2b extension. */
  async function token(body) {
    const c = need();
    const { claims, leaf } = verifyChained(body.client_assertion, c, { aud: `${baseUrl()}/oauth/token` });
    const client = await store.get('SmartClient', String(claims.iss)); if (!client?.udap || client.revoked) throw new HttpError(401, 'Unknown or cancelled UDAP client', 'invalid_client');
    if (claims.sub !== client.id) throw new HttpError(401, 'iss and sub must be the client_id', 'invalid_client');
    if (client.udap.fingerprint !== leaf.fingerprint256) throw new HttpError(401, 'The assertion is signed with a different certificate than the one registered', 'invalid_client');
    const b2b = claims.extensions?.['hl7-b2b']; if (!b2b) throw new HttpError(400, 'The hl7-b2b extension is required', 'invalid_grant');
    if (String(b2b.version) !== '1' || !b2b.organization_id || !(b2b.purpose_of_use || []).length) throw new HttpError(400, 'hl7-b2b needs version "1", organization_id and purpose_of_use', 'invalid_grant');
    const purpose = (POU.exec(b2b.purpose_of_use[0]) || [])[1]; if (!purpose) throw new HttpError(400, 'purpose_of_use must be a v3 PurposeOfUse code (urn:oid:2.16.840.1.113883.5.8#TREAT)', 'invalid_grant');
    return smart.issueSystem({ clientId: client.id, scope: String(body.scope || client.scope), purpose, organization: String(b2b.organization_id).slice(0, 200) });
  }
  return { metadata, register, token, enabled: () => Boolean(config()) };
}
