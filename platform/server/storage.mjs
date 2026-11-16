// One storage interface for every place that writes files under data/
// (plan-master task 21): put, get, getRange, head, list, delete. Keys are
// relative paths. Adapters are chosen by OBJECT_STORE: local (folders under
// data/), gcs, s3 (AWS S3, MinIO, Cloudflare R2 and Google Cloud Storage by
// its S3-compatible access) and azure. Cloud libraries are optional and
// loaded only when selected. Keys come only from .env or a key file path and
// are never logged or shown. Buckets are separate by kind, each falling back
// to one shared bucket with a prefix.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const KINDS = { clinical: 'OBJECT_STORE_CLINICAL', exports: 'OBJECT_STORE_EXPORTS', recordings: 'OBJECT_STORE_RECORDINGS', backups: 'OBJECT_STORE_BACKUPS', default: 'OBJECT_STORE_BUCKET' };
export const LOCAL_FOLDERS = { clinical: 'data', exports: 'data/exports', recordings: 'data/recordings', backups: 'data/backups', default: 'data' };
export const RULES = {
  clinical: 'DICOM, slides and ECG source files. Read by the imaging apps only; no public access; keep for the life of the data set; private bucket, versioning off, server-side encryption on.',
  exports: 'De-identified exports only (datasets, snapshots, packs). Private bucket; share single objects by signed URL with an expiry; keep 1 year.',
  recordings: 'Capture content and annotation masks. Encrypted before upload (AES-256-GCM, key from CAPTURE_KEY); a 30-day lifecycle rule deletes objects; no public access, access logged.',
  backups: 'Database backups. Private bucket, versioning on, 90-day lifecycle, restricted to the operator role.',
};
const safeKey = (key) => { const k = String(key || '').replace(/\\/g, '/').replace(/^\/+/, ''); if (!k || k.split('/').some((p) => p === '..' || p === '')) throw new Error(`Bad storage key "${key}"`); return k; };
const secret = (env, name) => env[name] || (env[`${name}_FILE`] && fs.existsSync(env[`${name}_FILE`]) ? fs.readFileSync(env[`${name}_FILE`], 'utf8').trim() : null);
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ---------- Encryption for recordings (AES-256-GCM; key from CAPTURE_KEY, a key file, or a generated local key) ----------
function recordingsKey(env) {
  const hex = secret(env, 'CAPTURE_KEY') || secret(env, 'RECORDINGS_KEY');
  if (hex) return Buffer.from(hex.trim(), 'hex');
  const file = path.resolve(REPO_ROOT, env.CAPTURE_KEY_FILE || 'data/capture.key');
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  const key = randomBytes(32); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${key.toString('hex')}\n`, { mode: 0o600 }); return key;
}
const MAGIC = Buffer.from('HDENC1');
export function encrypt(key, bytes) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([c.update(bytes), c.final()]); return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]); }
export function decrypt(key, bytes) { if (!bytes.subarray(0, 6).equals(MAGIC)) return bytes; const iv = bytes.subarray(6, 18); const tag = bytes.subarray(18, 34); const d = createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag); return Buffer.concat([d.update(bytes.subarray(34)), d.final()]); }

// ---------- Local adapter ----------
function localAdapter({ root, prefix = '' }) {
  const file = (key) => path.join(root, prefix, safeKey(key));
  return {
    name: 'local', root, prefix,
    async put(key, bytes) { const f = file(key); fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.tmp-${process.pid}`; fs.writeFileSync(tmp, bytes); fs.renameSync(tmp, f); return { key: safeKey(key), size: bytes.length }; },
    async get(key) { const f = file(key); if (!fs.existsSync(f)) return null; return fs.readFileSync(f); },
    async getRange(key, start, length) { const f = file(key); if (!fs.existsSync(f)) return null; const fd = fs.openSync(f, 'r'); try { const buf = Buffer.alloc(Number(length)); let got = 0; while (got < length) { const n = fs.readSync(fd, buf, got, length - got, Number(start) + got); if (!n) break; got += n; } return buf.subarray(0, got); } finally { fs.closeSync(fd); } },
    async head(key) { const f = file(key); if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return null; const st = fs.statSync(f); return { key: safeKey(key), size: st.size, modified: st.mtime.toISOString() }; },
    async list(dirPrefix = '') { const clean = String(dirPrefix || '').replace(/\/+$/, ''); const base = path.join(root, prefix, clean ? safeKey(clean) : ''); if (!fs.existsSync(base)) return []; const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (!e.name.endsWith('.tmp') && !/\.tmp-\d+$/.test(e.name)) out.push(path.relative(path.join(root, prefix), p).split(path.sep).join('/')); } }; walk(base); return out.sort(); },
    async delete(key) { const f = file(key); if (fs.existsSync(f)) fs.rmSync(f); return true; },
    /** Local path for code that still needs a file (the tile reader, DICOM parsers). */
    pathOf(key) { return file(key); },
  };
}

// ---------- Cloud adapters (optional dependencies, loaded only when selected) ----------
async function s3Adapter({ bucket, prefix, env }) {
  let mod; try { mod = await import('@aws-sdk/client-s3'); } catch { throw new Error('OBJECT_STORE=s3 needs the optional dependency @aws-sdk/client-s3 (npm install @aws-sdk/client-s3)'); }
  const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = mod;
  const client = new S3Client({ region: env.S3_REGION || 'auto', ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}), credentials: { accessKeyId: secret(env, 'S3_ACCESS_KEY_ID') || '', secretAccessKey: secret(env, 'S3_SECRET_ACCESS_KEY') || '' } });
  const k = (key) => `${prefix}${safeKey(key)}`;
  const body = async (r) => Buffer.from(await r.Body.transformToByteArray());
  return {
    name: 's3', bucket, prefix,
    async put(key, bytes) { await client.send(new PutObjectCommand({ Bucket: bucket, Key: k(key), Body: bytes })); return { key: safeKey(key), size: bytes.length }; },
    async get(key) { try { return await body(await client.send(new GetObjectCommand({ Bucket: bucket, Key: k(key) }))); } catch (err) { if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null; throw err; } },
    async getRange(key, start, length) { try { return await body(await client.send(new GetObjectCommand({ Bucket: bucket, Key: k(key), Range: `bytes=${start}-${start + length - 1}` }))); } catch (err) { if (err.$metadata?.httpStatusCode === 404) return null; throw err; } },
    async head(key) { try { const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: k(key) })); return { key: safeKey(key), size: r.ContentLength, modified: r.LastModified?.toISOString() }; } catch (err) { if (err.$metadata?.httpStatusCode === 404) return null; throw err; } },
    async list(dirPrefix = '') { const out = []; let token; do { const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}${dirPrefix}`, ContinuationToken: token })); for (const o of r.Contents || []) out.push(o.Key.slice(prefix.length)); token = r.IsTruncated ? r.NextContinuationToken : null; } while (token); return out.sort(); },
    async delete(key) { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: k(key) })); return true; },
  };
}
async function gcsAdapter({ bucket, prefix, env }) {
  let mod; try { mod = await import('@google-cloud/storage'); } catch { throw new Error('OBJECT_STORE=gcs needs the optional dependency @google-cloud/storage (npm install @google-cloud/storage)'); }
  const storage = new mod.Storage({ ...(env.GOOGLE_APPLICATION_CREDENTIALS ? { keyFilename: env.GOOGLE_APPLICATION_CREDENTIALS } : {}) });
  const b = storage.bucket(bucket); const k = (key) => `${prefix}${safeKey(key)}`;
  return {
    name: 'gcs', bucket, prefix,
    async put(key, bytes) { await b.file(k(key)).save(bytes, { resumable: false }); return { key: safeKey(key), size: bytes.length }; },
    async get(key) { try { const [d] = await b.file(k(key)).download(); return d; } catch (err) { if (err.code === 404) return null; throw err; } },
    async getRange(key, start, length) { try { const [d] = await b.file(k(key)).download({ start, end: start + length - 1 }); return d; } catch (err) { if (err.code === 404) return null; throw err; } },
    async head(key) { try { const [m] = await b.file(k(key)).getMetadata(); return { key: safeKey(key), size: Number(m.size), modified: m.updated }; } catch (err) { if (err.code === 404) return null; throw err; } },
    async list(dirPrefix = '') { const [files] = await b.getFiles({ prefix: `${prefix}${dirPrefix}` }); return files.map((f) => f.name.slice(prefix.length)).sort(); },
    async delete(key) { await b.file(k(key)).delete({ ignoreNotFound: true }); return true; },
  };
}
async function azureAdapter({ bucket, prefix, env }) {
  let mod; try { mod = await import('@azure/storage-blob'); } catch { throw new Error('OBJECT_STORE=azure needs the optional dependency @azure/storage-blob (npm install @azure/storage-blob)'); }
  const service = mod.BlobServiceClient.fromConnectionString(secret(env, 'AZURE_CONNECTION_STRING') || '');
  const container = service.getContainerClient(bucket); const k = (key) => `${prefix}${safeKey(key)}`;
  const toBuffer = async (stream) => { const chunks = []; for await (const c of stream) chunks.push(Buffer.from(c)); return Buffer.concat(chunks); };
  return {
    name: 'azure', bucket, prefix,
    async put(key, bytes) { await container.getBlockBlobClient(k(key)).upload(bytes, bytes.length); return { key: safeKey(key), size: bytes.length }; },
    async get(key) { try { const r = await container.getBlobClient(k(key)).download(); return await toBuffer(r.readableStreamBody); } catch (err) { if (err.statusCode === 404) return null; throw err; } },
    async getRange(key, start, length) { try { const r = await container.getBlobClient(k(key)).download(start, length); return await toBuffer(r.readableStreamBody); } catch (err) { if (err.statusCode === 404) return null; throw err; } },
    async head(key) { try { const p = await container.getBlobClient(k(key)).getProperties(); return { key: safeKey(key), size: p.contentLength, modified: p.lastModified?.toISOString() }; } catch (err) { if (err.statusCode === 404) return null; throw err; } },
    async list(dirPrefix = '') { const out = []; for await (const b of container.listBlobsFlat({ prefix: `${prefix}${dirPrefix}` })) out.push(b.name.slice(prefix.length)); return out.sort(); },
    async delete(key) { await container.getBlobClient(k(key)).deleteIfExists(); return true; },
  };
}

/** Wraps an adapter so recordings are encrypted at rest and expire after 30 days. */
function withEncryption(adapter, key) {
  return { ...adapter, encrypted: true,
    async put(k, bytes) { const b = Buffer.from(bytes); await adapter.put(k, encrypt(key, b)); return { key: k, size: b.length }; },
    async head(k) { const h = await adapter.head(k); return h ? { ...h, size: Math.max(0, h.size - 34), encrypted: true } : null; },
    async get(k) { const b = await adapter.get(k); return b ? decrypt(key, b) : null; },
    async getRange(k, start, length) { const b = await this.get(k); return b ? b.subarray(start, start + length) : null; },
    async purge(days = 30) { let removed = 0; const cutoff = Date.now() - days * 86400000; for (const k of await adapter.list('')) { const h = await adapter.head(k); if (h && Date.parse(h.modified) < cutoff) { await adapter.delete(k); removed += 1; } } return removed; },
  };
}

/** The adapter for one kind of file, from the environment. Never logs or returns secrets. */
/** opts.localRoot: for the local adapter, this exact folder is the root (keys relative to it); opts.prefix: a folder prefix inside a cloud bucket. */
export async function createObjectStore(kind = 'default', { env = process.env, root = REPO_ROOT, localRoot = null, prefix: extraPrefix = '' } = {}) {
  if (!KINDS[kind]) throw new Error(`Storage kind must be one of ${Object.keys(KINDS).join(', ')}`);
  const provider = (env.OBJECT_STORE || 'local').toLowerCase();
  let adapter;
  if (provider === 'local') adapter = localAdapter({ root: localRoot ? path.resolve(localRoot) : path.resolve(root, env[`${KINDS[kind]}_DIR`] || LOCAL_FOLDERS[kind]) });
  else {
    const own = env[KINDS[kind]]; const shared = env.OBJECT_STORE_BUCKET || env.S3_BUCKET || env.GCS_BUCKET || env.AZURE_CONTAINER;
    const bucket = own || shared; if (!bucket) throw new Error(`No bucket: set ${KINDS[kind]} or OBJECT_STORE_BUCKET in .env`);
    const prefix = `${own ? '' : `${kind}/`}${extraPrefix || ''}`;
    adapter = provider === 's3' ? await s3Adapter({ bucket, prefix, env }) : provider === 'gcs' ? await gcsAdapter({ bucket, prefix, env }) : provider === 'azure' ? await azureAdapter({ bucket, prefix, env }) : null;
    if (!adapter) throw new Error(`OBJECT_STORE "${provider}" must be local, gcs, s3 or azure`);
  }
  const out = kind === 'recordings' ? withEncryption(adapter, recordingsKey(env)) : adapter;
  return { ...out, kind, provider, rules: RULES[kind] || RULES.clinical };
}

/** What Administration shows: the active database and storage per kind, never keys. */
export async function describeStorage(env = process.env) {
  const url = env.DATABASE_URL || '';
  const database = url.startsWith('postgres') ? { backend: 'postgres', host: (() => { try { const u = new URL(url); return `${u.hostname}:${u.port || 5432}/${u.pathname.replace('/', '')}`; } catch { return 'postgres'; } })() } : { backend: 'sqlite', file: env.SQLITE_FILE || 'data/hospital.sqlite' };
  const provider = (env.OBJECT_STORE || 'local').toLowerCase();
  const kinds = {};
  for (const kind of Object.keys(KINDS).filter((k) => k !== 'default')) {
    const own = env[KINDS[kind]]; const shared = env.OBJECT_STORE_BUCKET || env.S3_BUCKET || env.GCS_BUCKET || env.AZURE_CONTAINER;
    kinds[kind] = provider === 'local' ? { adapter: 'local', location: env[`${KINDS[kind]}_DIR`] || LOCAL_FOLDERS[kind], rules: RULES[kind] } : { adapter: provider, location: own ? `bucket ${own}` : shared ? `bucket ${shared}, prefix ${kind}/` : 'no bucket set', rules: RULES[kind] };
    if (kind === 'recordings') kinds[kind].encrypted = true;
  }
  return { database, storage: { provider, kinds } };
}

/** Test connection: head and list on each kind. Errors come back as plain words without secrets. */
export async function testStorage(env = process.env) {
  const out = {};
  for (const kind of Object.keys(KINDS).filter((k) => k !== 'default')) {
    try { const s = await createObjectStore(kind, { env }); const probe = `.connection-test/${Date.now()}.txt`; await s.put(probe, Buffer.from('ok')); const h = await s.head(probe); await s.delete(probe); out[kind] = { ok: Boolean(h && h.size >= 2), adapter: s.provider }; } catch (err) { out[kind] = { ok: false, error: String(err.message).replace(/(key|secret|token)[^ ]*/gi, '[hidden]').slice(0, 200) }; }
  }
  return out;
}

/** Copies everything from the local folders into another provider, checking size and SHA-256 (npm run storage:copy). */
export async function copyAll({ to, env = process.env, log = () => {} }) {
  const report = [];
  for (const kind of Object.keys(KINDS).filter((k) => k !== 'default')) {
    const from = await createObjectStore(kind, { env: { ...env, OBJECT_STORE: 'local' } });
    const target = await createObjectStore(kind, { env: { ...env, OBJECT_STORE: to } });
    const keys = await from.list('');
    let copied = 0; let bytes = 0; const failed = [];
    for (const key of keys) {
      const data = await from.get(key); if (!data) continue;
      await target.put(key, data);
      const back = await target.get(key);
      if (!back || back.length !== data.length || sha256(back) !== sha256(data)) failed.push(key); else { copied += 1; bytes += data.length; }
      log(`${kind}: ${key} ${failed.includes(key) ? 'MISMATCH' : 'ok'}`);
    }
    report.push({ kind, files: keys.length, copied, bytes, failed });
  }
  return report;
}
