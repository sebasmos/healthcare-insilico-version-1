// The dataset register: data/datasets.json (gitignored), one entry per
// imported data set, written by every import (--fhir, --dicom, --ecg).
// It records where data came from, the licence note the user typed, whether
// the source is synthetic or restricted, and which patients it touched. It
// is also the memory of which source names have been confirmed as not real
// patient data. Nothing here is ever committed.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { REPO_ROOT } from './db/index.mjs';

export const HTEST = { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST', display: 'test health data' };
export const RESTRICTED_URL = 'urn:hospital-desktop:restricted-source';
export const KINDS = ['fhir', 'dicom', 'ecg', 'payer-reference'];

export const registerPath = () => path.resolve(REPO_ROOT, process.env.DATASETS_FILE || 'data/datasets.json');

/** Every entry, oldest first. An absent or unreadable file is an empty register. */
export function readRegister(file = registerPath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/** sha256 over the sorted relative file list, one path per line. */
export function fileListChecksum(relativeFiles) {
  return createHash('sha256').update([...relativeFiles].map((f) => f.split(path.sep).join('/')).sort().join('\n')).digest('hex');
}

/** Paths of the files under each target, relative to the target (or its parent for a single file). Stable across machines. */
export function relativeFiles(targets, files) {
  return files.map((f) => {
    const abs = path.resolve(f);
    const target = targets.map((t) => path.resolve(t)).find((t) => abs === t || abs.startsWith(t + path.sep)) ?? path.dirname(abs);
    const base = fs.existsSync(target) && fs.statSync(target).isFile() ? path.dirname(target) : target;
    return path.relative(base, abs);
  });
}

/** True once any entry carries this source name: the user has confirmed it before. */
export const sourceConfirmed = (source, file = registerPath()) => readRegister(file).some((e) => e.source === source);

/**
 * Adds or updates an entry. The id is derived from the kind and the file-list
 * checksum, so re-importing the same folder updates one entry instead of
 * adding another; patients accumulate, importedAt moves to the latest run.
 */
export function recordDataset({ kind, source, licence = null, files, checksum, synthetic = false, restricted = false, patients = [], importedAt = new Date().toISOString() }, file = registerPath()) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown dataset kind "${kind}"`);
  const entries = readRegister(file);
  const id = `${kind}-${checksum.slice(0, 12)}`;
  const existing = entries.find((e) => e.id === id);
  const entry = {
    id, source, licence: licence ?? existing?.licence ?? null, kind, files, checksum, importedAt, synthetic: Boolean(synthetic), restricted: Boolean(restricted),
    patients: [...new Set([...(existing?.patients || []), ...patients])].sort(),
  };
  const next = existing ? entries.map((e) => (e.id === id ? entry : e)) : [...entries, entry];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return entry;
}

/** The register entries that touched any of these patients, cut to what an export manifest needs (no file lists). */
export function datasetsForPatients(patientIds, file = registerPath()) {
  const wanted = new Set((patientIds || []).filter(Boolean).map((p) => String(p).replace(/^Patient\//, '')));
  if (!wanted.size) return [];
  return readRegister(file)
    .filter((e) => (e.patients || []).some((p) => wanted.has(p)))
    .map((e) => ({ source: e.source, licence: e.licence ?? null, kind: e.kind, importedAt: e.importedAt }));
}

/** Tags a Patient document with the source flags: HTEST security label for synthetic, a restricted-source extension for restricted. */
export function tagPatient(doc, { synthetic = false, restricted = false, source = null } = {}) {
  let out = doc;
  if (synthetic) {
    const security = (doc.meta?.security || []).filter((s) => !(s.system === HTEST.system && s.code === HTEST.code));
    out = { ...out, meta: { ...(doc.meta || {}), security: [...security, HTEST] } };
  }
  if (restricted) {
    const extension = (doc.extension || []).filter((e) => e.url !== RESTRICTED_URL);
    out = { ...out, extension: [...extension, { url: RESTRICTED_URL, valueString: source ?? 'restricted' }] };
  }
  return out;
}
