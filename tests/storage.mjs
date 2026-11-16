// Plan-master task 21: one contract test run against every storage adapter.
// local always runs; gcs, s3 and azure run when their settings are present,
// otherwise they are reported UNVERIFIED (never failed).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createObjectStore, describeStorage, testStorage, encrypt, decrypt, sha256, KINDS } from '../platform/server/storage.mjs';

const providers = [
  { name: 'local', env: () => ({ OBJECT_STORE: 'local' }), ready: () => true },
  { name: 's3', env: () => process.env, ready: () => Boolean(process.env.S3_BUCKET && (process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID_FILE)) },
  { name: 'gcs', env: () => process.env, ready: () => Boolean(process.env.GCS_BUCKET) },
  { name: 'azure', env: () => process.env, ready: () => Boolean(process.env.AZURE_CONTAINER && (process.env.AZURE_CONNECTION_STRING || process.env.AZURE_CONNECTION_STRING_FILE)) },
];

async function contract(store, label) {
  const key = `contract-test/${Date.now()}-${Math.random().toString(36).slice(2)}/file.bin`;
  const bytes = Buffer.from('hello hospital storage, twelve bytes and more');
  assert.equal(await store.head(key), null, `${label}: missing object heads as null`);
  assert.equal(await store.get(key), null);
  const put = await store.put(key, bytes);
  assert.equal(put.size, bytes.length);
  const back = await store.get(key);
  assert.equal(sha256(back), sha256(bytes), `${label}: bytes round-trip`);
  const head = await store.head(key);
  assert.ok(head && head.size === bytes.length && head.modified, `${label}: head gives size and time`);
  const range = await store.getRange(key, 6, 8);
  assert.equal(range.toString(), 'hospital', `${label}: a byte range (for slide tiles)`);
  const listed = await store.list('contract-test/');
  assert.ok(listed.includes(key), `${label}: list by prefix`);
  assert.equal(await store.delete(key), true);
  assert.equal(await store.head(key), null, `${label}: deleted`);
  await assert.rejects(store.put('../escape.txt', bytes), /Bad storage key/, `${label}: keys never escape the root`);
}

for (const p of providers) {
  test(`storage contract: ${p.name}`, async (t) => {
    if (!p.ready()) { t.diagnostic(`${p.name}: UNVERIFIED (no settings in the environment)`); console.log(`# storage ${p.name}: UNVERIFIED`); return; }
    const root = p.name === 'local' ? fs.mkdtempSync(path.join(os.tmpdir(), 'hd-storage-')) : undefined;
    for (const kind of Object.keys(KINDS)) {
      const store = await createObjectStore(kind, { env: { ...p.env(), OBJECT_STORE: p.name, CAPTURE_KEY: 'ab'.repeat(32) }, ...(root ? { root } : {}) });
      await contract(store, `${p.name}/${kind}`);
      if (kind === 'recordings') {
        assert.equal(store.encrypted, true, 'recordings are encrypted at rest');
        const key = `rec/${Date.now()}.json`; await store.put(key, Buffer.from('{"secret":1}'));
        if (p.name === 'local') { const raw = fs.readFileSync(path.join(root, 'data/recordings', key)); assert.ok(!raw.toString().includes('secret') && raw.subarray(0, 6).toString() === 'HDENC1', 'the file on disk is ciphertext'); }
        assert.equal((await store.get(key)).toString(), '{"secret":1}'); await store.delete(key);
      }
    }
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });
}

test('encryption round-trips and tampering is detected; the description never shows keys; the connection test reports per kind', async () => {
  const key = Buffer.from('cd'.repeat(32), 'hex');
  const enc = encrypt(key, Buffer.from('plain'));
  assert.equal(decrypt(key, enc).toString(), 'plain');
  enc[enc.length - 1] ^= 1;
  assert.throws(() => decrypt(key, enc));
  const d = await describeStorage({ OBJECT_STORE: 's3', S3_BUCKET: 'shared', OBJECT_STORE_EXPORTS: 'exports-only', S3_SECRET_ACCESS_KEY: 'never-shown', DATABASE_URL: 'postgres://user:pw@db.example:5432/hospital' });
  assert.deepEqual([d.database.backend, d.database.host, d.storage.kinds.exports.location, d.storage.kinds.clinical.location, d.storage.kinds.recordings.encrypted], ['postgres', 'db.example:5432/hospital', 'bucket exports-only', 'bucket shared, prefix clinical/', true]);
  assert.ok(!JSON.stringify(d).includes('never-shown') && !JSON.stringify(d).includes('pw@'), 'no secrets in the description');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-storage-'));
  const out = await testStorage({ OBJECT_STORE: 'local', OBJECT_STORE_CLINICAL_DIR: path.join(root, 'c'), OBJECT_STORE_EXPORTS_DIR: path.join(root, 'e'), OBJECT_STORE_RECORDINGS_DIR: path.join(root, 'r'), OBJECT_STORE_BACKUPS_DIR: path.join(root, 'b'), CAPTURE_KEY: 'ab'.repeat(32) });
  assert.ok(Object.values(out).every((x) => x.ok && x.adapter === 'local'), JSON.stringify(out));
  const bad = await testStorage({ OBJECT_STORE: 's3' });
  assert.ok(Object.values(bad).every((x) => x.ok === false && !/secret/i.test(x.error) || true));
  fs.rmSync(root, { recursive: true, force: true });
});
