// Real reference data for the insurance environment (docs/PAYER.md section 3).
//
// Nothing here is typed in or committed: every table is filled by `npm run import -- --payer-reference <folder>`
// from files you download (CMS, X12, NPPES, hospitals, insurers) or hold a licence for. The data lives in its
// own database file, data/payer-reference.sqlite, beside the hospital record. Each import is registered with its
// source file, release and checksum, and every lookup can say which release answered.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';

const { DatabaseSync } = await import('node:sqlite');
export const referenceFile = (env = process.env) => path.resolve(REPO_ROOT, env.PAYER_REFERENCE_FILE || 'data/payer-reference.sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS releases (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, release TEXT, source TEXT NOT NULL, file TEXT NOT NULL, checksum TEXT NOT NULL, rows INTEGER NOT NULL, imported_at TEXT NOT NULL, note TEXT, UNIQUE(kind, checksum));
CREATE TABLE IF NOT EXISTS codes (system TEXT NOT NULL, code TEXT NOT NULL, release INTEGER NOT NULL, short TEXT, long TEXT, billable INTEGER, extra TEXT, PRIMARY KEY (system, code, release));
CREATE TABLE IF NOT EXISTS ncci_ptp (setting TEXT NOT NULL, col1 TEXT NOT NULL, col2 TEXT NOT NULL, effective TEXT, deleted TEXT, modifier TEXT, rationale TEXT, release INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ncci_ptp_pair ON ncci_ptp (col1, col2, setting);
CREATE TABLE IF NOT EXISTS ncci_mue (setting TEXT NOT NULL, code TEXT NOT NULL, units INTEGER NOT NULL, mai TEXT, rationale TEXT, release INTEGER NOT NULL, PRIMARY KEY (setting, code, release));
CREATE TABLE IF NOT EXISTS pfs_rvu (code TEXT NOT NULL, modifier TEXT NOT NULL DEFAULT '', status TEXT, work REAL, pe_nonfac REAL, pe_fac REAL, mp REAL, pctc TEXT, global TEXT, mult_proc TEXT, bilateral TEXT, conversion REAL, release INTEGER NOT NULL, PRIMARY KEY (code, modifier, release));
CREATE TABLE IF NOT EXISTS pfs_gpci (mac TEXT, state TEXT, locality TEXT NOT NULL, name TEXT, work REAL, pe REAL, mp REAL, release INTEGER NOT NULL, PRIMARY KEY (mac, locality, release));
CREATE TABLE IF NOT EXISTS drg (drg TEXT NOT NULL, mdc TEXT, type TEXT, title TEXT, weight REAL, gmlos REAL, amlos REAL, post_acute TEXT, special_pay TEXT, release INTEGER NOT NULL, PRIMARY KEY (drg, release));
CREATE TABLE IF NOT EXISTS opps (code TEXT NOT NULL, si TEXT, apc TEXT, weight REAL, rate REAL, copay REAL, release INTEGER NOT NULL, PRIMARY KEY (code, release));
CREATE TABLE IF NOT EXISTS asc (code TEXT NOT NULL, indicator TEXT, weight REAL, rate REAL, discounted TEXT, release INTEGER NOT NULL, PRIMARY KEY (code, release));
CREATE TABLE IF NOT EXISTS npi (npi TEXT PRIMARY KEY, entity TEXT, state TEXT, taxonomy TEXT, taxonomies TEXT, release INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS hcc_map (model TEXT NOT NULL, icd TEXT NOT NULL, hcc TEXT NOT NULL, release INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS hcc_map_icd ON hcc_map (icd, model);
CREATE TABLE IF NOT EXISTS hcc_coef (model TEXT NOT NULL, segment TEXT NOT NULL, variable TEXT NOT NULL, coefficient REAL NOT NULL, release INTEGER NOT NULL, PRIMARY KEY (model, segment, variable, release));
CREATE TABLE IF NOT EXISTS hospital_charges (hospital TEXT NOT NULL, code TEXT NOT NULL, code_type TEXT, setting TEXT, gross REAL, cash REAL, payer TEXT, plan TEXT, negotiated REAL, percent REAL, methodology TEXT, min REAL, max REAL, flag TEXT, release INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS hospital_charges_code ON hospital_charges (hospital, code);
CREATE TABLE IF NOT EXISTS negotiated_rates (insurer TEXT NOT NULL, plan TEXT, npi TEXT, tin TEXT, code TEXT NOT NULL, code_type TEXT, modifier TEXT, rate REAL NOT NULL, kind TEXT, billing_class TEXT, expires TEXT, flag TEXT, release INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS negotiated_rates_code ON negotiated_rates (code, npi);
CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL DEFAULT '', title TEXT, body TEXT, release INTEGER NOT NULL, PRIMARY KEY (kind, id, version));
CREATE TABLE IF NOT EXISTS document_codes (kind TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL DEFAULT '', system TEXT NOT NULL, code TEXT NOT NULL, role TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS document_codes_code ON document_codes (code, system);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, release INTEGER);
`;

let cached = null;
/** Opens (and creates) the reference database. */
export function openReference(file = referenceFile()) {
  if (cached && cached.file === file) return cached.db;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file); db.exec('PRAGMA journal_mode = WAL'); db.exec(SCHEMA);
  cached = { file, db }; return db;
}
export function closeReference() { if (cached) { cached.db.close(); cached = null; } }

const KIND_LABEL = { 'icd10cm': 'ICD-10-CM', 'icd10pcs': 'ICD-10-PCS', hcpcs: 'HCPCS Level II', cpt: 'CPT (your licensed copy)', 'ncci-ptp': 'NCCI procedure-to-procedure edits', 'ncci-mue': 'NCCI medically unlikely edits', 'pfs-rvu': 'Physician fee schedule relative values', 'pfs-gpci': 'Physician fee schedule geographic indices', drg: 'MS-DRG weights', opps: 'OPPS addendum B', asc: 'Ambulatory surgery center rates', carc: 'Claim adjustment reason codes', rarc: 'Remittance advice remark codes', csc: 'Claim status codes', cscc: 'Claim status category codes', npi: 'NPI registry (numbers and specialties only)', 'hcc-map': 'CMS-HCC diagnosis mapping', 'hcc-coef': 'CMS-HCC coefficients', 'hospital-charges': 'Hospital standard charges', 'negotiated-rates': 'Insurer negotiated rates', ncd: 'National coverage determinations', lcd: 'Local coverage determinations', article: 'Coverage articles', policy: 'Plan policies (licensed criteria or your own)', limits: 'Yearly benefit limits', elm: 'Compiled CQL (ELM) for questionnaires', grouper: 'MS-DRG grouper (outside program)', 'payer-mix': 'Hospital payer mix' };
export const kindLabel = (k) => KIND_LABEL[k] || k;

/** What has been imported: one row per file, newest first, with what is still missing. */
export function referenceStatus(db = openReference()) {
  const releases = db.prepare('SELECT id, kind, release, source, file, rows, imported_at AS importedAt, note FROM releases ORDER BY imported_at DESC, id DESC').all();
  const have = new Set(releases.map((r) => r.kind));
  const needed = ['icd10cm', 'hcpcs', 'ncci-ptp', 'ncci-mue', 'pfs-rvu', 'pfs-gpci', 'drg', 'opps', 'carc', 'rarc', 'csc', 'npi', 'limits'];
  return { releases: releases.map((r) => ({ ...r, label: kindLabel(r.kind) })), missing: needed.filter((k) => !have.has(k)).map((k) => ({ kind: k, label: kindLabel(k) })), optional: ['icd10pcs', 'cpt', 'asc', 'hcc-map', 'hcc-coef', 'hospital-charges', 'negotiated-rates', 'ncd', 'lcd', 'article', 'policy', 'elm', 'grouper', 'payer-mix'].filter((k) => !have.has(k)).map((k) => ({ kind: k, label: kindLabel(k) })) };
}
/** The newest release of one kind (by release label, then import time), or null. */
export function latest(kind, db = openReference()) { return db.prepare('SELECT id, kind, release, source, file FROM releases WHERE kind = ? ORDER BY release DESC, id DESC LIMIT 1').get(kind) ?? null; }
const cite = (r) => (r ? { release: r.release, source: r.source, file: r.file } : null);

// ---------- lookups (each answer names the release it came from) ----------
const SYSTEM_KIND = { 'ICD-10-CM': 'icd10cm', 'ICD-10-PCS': 'icd10pcs', HCPCS: 'hcpcs', CPT: 'cpt', CARC: 'carc', RARC: 'rarc', CSC: 'csc', CSCC: 'cscc', LOINC: 'loinc', RXNORM: 'rxnorm', NDC: ['ndc', 'rxnorm-ndc'], CVX: 'cvx', NUCC: 'nucc', SNOMED: 'snomed' };
/** One code. system: ICD-10-CM, ICD-10-PCS, HCPCS, CPT, CARC, RARC, CSC, CSCC. Dots in ICD codes are optional. */
// A system may be filled by more than one kind of file (NDC: the FDA product file and RxNorm's NDC attributes): the newest release of each counts.
const releasesOf = (system, db) => [].concat(SYSTEM_KIND[system] || []).map((k) => latest(k, db)).filter(Boolean);
export function code(system, value, db = openReference()) {
  const rels = releasesOf(system, db); if (!rels.length) return null; const rel = rels[0];
  const v = system.startsWith('ICD') ? String(value).replace('.', '').toUpperCase() : String(value).toUpperCase();
  const row = db.prepare(`SELECT code, short, long, billable, extra, release FROM codes WHERE system = ? AND code = ? AND release IN (${rels.map(() => '?').join(',')}) ORDER BY long IS NULL`).get(system, v, ...rels.map((r) => r.id));
  return row ? { system, code: row.code, short: row.short, long: row.long, billable: row.billable == null ? null : Boolean(row.billable), ...(row.extra ? JSON.parse(row.extra) : {}), from: cite(rel) } : null;
}
export function searchCodes(system, text, limit = 25, db = openReference()) {
  const rels = releasesOf(system, db); if (!rels.length) return [];
  const q = `%${String(text).trim().replace(/[%_]/g, '')}%`;
  return db.prepare(`SELECT code, short, long, billable FROM codes WHERE system = ? AND release IN (${rels.map(() => '?').join(',')}) AND (code LIKE ? OR long LIKE ? OR short LIKE ?) ORDER BY code LIMIT ?`).all(system, ...rels.map((r) => r.id), q.toUpperCase(), q, q, Math.min(1000, limit));
}
const ymd = (d) => String(d || '').slice(0, 10).replace(/-/g, '');
/** The procedure-to-procedure edit between two codes on a date, either way round. setting: practitioner or hospital. */
export function ncciPair(a, b, { setting = 'practitioner', date = null } = {}, db = openReference()) {
  const rel = latest('ncci-ptp', db); if (!rel) return null;
  const on = ymd(date || new Date().toISOString());
  for (const [c1, c2] of [[a, b], [b, a]]) {
    const row = db.prepare("SELECT col1, col2, effective, deleted, modifier, rationale FROM ncci_ptp WHERE col1 = ? AND col2 = ? AND setting = ? AND release = ? AND (effective IS NULL OR effective <= ?) AND (deleted IS NULL OR deleted = '' OR deleted = '*' OR deleted >= ?)").get(String(c1), String(c2), setting, rel.id, on, on);
    if (row) return { column1: row.col1, column2: row.col2, modifierAllowed: row.modifier === '1', modifierIndicator: row.modifier, rationale: row.rationale, effective: row.effective, from: cite(rel) };
  }
  return null;
}
export function mue(value, { setting = 'practitioner' } = {}, db = openReference()) {
  const rel = latest('ncci-mue', db); if (!rel) return null;
  const row = db.prepare('SELECT units, mai, rationale FROM ncci_mue WHERE code = ? AND setting = ? AND release = ?').get(String(value), setting, rel.id);
  return row ? { code: String(value), units: row.units, adjudication: row.mai, rationale: row.rationale, from: cite(rel) } : null;
}
/** The Medicare physician fee schedule amount: (work x work index + practice expense x its index + malpractice x its index) x conversion factor. */
export function feeSchedule(value, { modifier = '', locality = null, mac = null, facility = false } = {}, db = openReference()) {
  const rel = latest('pfs-rvu', db); if (!rel) return null;
  const row = db.prepare('SELECT * FROM pfs_rvu WHERE code = ? AND modifier = ? AND release = ?').get(String(value), String(modifier || ''), rel.id) || (modifier ? null : undefined);
  if (!row) return null;
  const grel = latest('pfs-gpci', db);
  const g = grel && locality ? db.prepare('SELECT work, pe, mp, name FROM pfs_gpci WHERE locality = ? AND (? IS NULL OR mac = ?) AND release = ?').get(String(locality), mac, mac, grel.id) : null;
  const gp = g || { work: 1, pe: 1, mp: 1, name: 'National (no geographic adjustment)' };
  const pe = facility ? row.pe_fac : row.pe_nonfac;
  if (row.conversion == null || pe == null) return { code: row.code, status: row.status, amount: null, reason: 'This code has no relative values on the fee schedule', from: cite(rel) };
  const rvu = row.work * gp.work + pe * gp.pe + row.mp * gp.mp;
  return { code: row.code, modifier: row.modifier, status: row.status, facility, rvu: { work: row.work, practiceExpense: pe, malpractice: row.mp }, gpci: gp, conversionFactor: row.conversion, amount: Math.round(rvu * row.conversion * 100) / 100, pctc: row.pctc, globalDays: row.global, multipleProcedure: row.mult_proc, bilateral: row.bilateral, from: cite(rel) };
}
export function drg(value, db = openReference()) { const rel = latest('drg', db); if (!rel) return null; const row = db.prepare('SELECT * FROM drg WHERE drg = ? AND release = ?').get(String(value).padStart(3, '0'), rel.id); return row ? { drg: row.drg, mdc: row.mdc, type: row.type, title: row.title, weight: row.weight, geometricMeanStay: row.gmlos, arithmeticMeanStay: row.amlos, postAcuteTransfer: row.post_acute === 'Yes', from: cite(rel) } : null; }
export function opps(value, db = openReference()) { const rel = latest('opps', db); if (!rel) return null; const row = db.prepare('SELECT * FROM opps WHERE code = ? AND release = ?').get(String(value), rel.id); return row ? { code: row.code, statusIndicator: row.si, apc: row.apc, weight: row.weight, rate: row.rate, copay: row.copay, from: cite(rel) } : null; }
export function ascRate(value, db = openReference()) { const rel = latest('asc', db); if (!rel) return null; const row = db.prepare('SELECT * FROM asc WHERE code = ? AND release = ?').get(String(value), rel.id); return row ? { code: row.code, indicator: row.indicator, rate: row.rate, weight: row.weight, from: cite(rel) } : null; }
/** A provider by NPI: the number, whether a person or an organisation, state and specialty codes. Never a name. */
export function npi(value, db = openReference()) { const row = db.prepare('SELECT npi, entity, state, taxonomy, taxonomies FROM npi WHERE npi = ?').get(String(value)); return row ? { npi: row.npi, entity: row.entity === '2' ? 'organisation' : 'individual', state: row.state, taxonomy: row.taxonomy, taxonomies: JSON.parse(row.taxonomies || '[]') } : null; }
export function negotiatedRate({ code: c, npi: n = null, insurer = null, plan = null, billingClass = null }, db = openReference()) {
  const rows = db.prepare('SELECT r.*, l.release AS rel, l.source AS src, l.file AS f FROM negotiated_rates r JOIN releases l ON l.id = r.release WHERE r.code = ? AND (? IS NULL OR r.npi = ?) AND (? IS NULL OR r.insurer = ?) AND (? IS NULL OR r.plan = ?) AND (? IS NULL OR r.billing_class = ?) AND r.flag IS NULL ORDER BY l.id DESC LIMIT 20').all(String(c), n, n, insurer, insurer, plan, plan, billingClass, billingClass);
  return rows.map((r) => ({ code: r.code, npi: r.npi, insurer: r.insurer, plan: r.plan, rate: r.rate, kind: r.kind, billingClass: r.billing_class, modifier: r.modifier, expires: r.expires, from: { release: r.rel, source: r.src, file: r.f } }));
}
export function hospitalCharge({ hospital, code: c, payer = null, plan = null }, db = openReference()) {
  return db.prepare('SELECT * FROM hospital_charges WHERE hospital = ? AND code = ? AND (? IS NULL OR payer = ?) AND (? IS NULL OR plan = ?) ORDER BY release DESC LIMIT 50').all(String(hospital), String(c), payer, payer, plan, plan).map(({ release, ...r }) => r);
}
export function hccFor(icd, model = null, db = openReference()) { const rel = latest('hcc-map', db); if (!rel) return []; return db.prepare('SELECT model, hcc FROM hcc_map WHERE icd = ? AND release = ? AND (? IS NULL OR model = ?)').all(String(icd).replace('.', '').toUpperCase(), rel.id, model, model); }
export function hccCoefficient(model, segment, variable, db = openReference()) { const rel = latest('hcc-coef', db); if (!rel) return null; return db.prepare('SELECT coefficient FROM hcc_coef WHERE model = ? AND segment = ? AND variable = ? AND release = ?').get(model, segment, variable, rel.id)?.coefficient ?? null; }
/** Coverage documents (national and local determinations, articles, plan policies) that name a code. */
export function documentsFor(c, { system = null, kind = null } = {}, db = openReference()) {
  return db.prepare('SELECT d.kind, d.id, d.version, d.title, c.role, c.system FROM document_codes c JOIN documents d ON d.kind = c.kind AND d.id = c.id AND d.version = c.version WHERE c.code = ? AND (? IS NULL OR c.system = ?) AND (? IS NULL OR d.kind = ?) ORDER BY d.kind, d.id, d.version DESC').all(String(c).replace('.', '').toUpperCase(), system, system, kind, kind);
}
export function document(kind, id, version = null, db = openReference()) {
  const row = version == null ? db.prepare('SELECT * FROM documents WHERE kind = ? AND id = ? ORDER BY version DESC LIMIT 1').get(kind, String(id)) : db.prepare('SELECT * FROM documents WHERE kind = ? AND id = ? AND version = ?').get(kind, String(id), String(version));
  if (!row) return null;
  const codes = db.prepare('SELECT system, code, role FROM document_codes WHERE kind = ? AND id = ? AND version = ?').all(kind, row.id, row.version);
  let body = row.body; try { body = JSON.parse(row.body); } catch { /* prose */ }
  return { kind, id: row.id, version: row.version, title: row.title, body, codes };
}
export function setting(key, db = openReference()) { const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return row ? JSON.parse(row.value) : null; }
