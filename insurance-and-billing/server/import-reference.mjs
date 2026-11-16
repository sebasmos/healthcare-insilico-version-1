// Imports the public and licensed reference files for the insurance environment (docs/PAYER.md section 3).
//   npm run import -- --payer-reference <folder> [--rates-npi 1234567890,...] [--rates-codes 99213,...] [--npi-state MA,NH] [--dry-run]
// Each file is recognised by its name and header, read as a stream (some are many gigabytes), and written to
// data/payer-reference.sqlite with its release, checksum and row count. Importing the same file again does nothing.
// Spreadsheet (.xlsx) and zipped downloads must be unzipped and saved as CSV or text first.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { openReference } from './reference.mjs';

/** One CSV line into fields (quotes, doubled quotes; a quoted field does not span lines). */
export function csvLine(line, sep = ',') {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i += 1) { const c = line[i]; if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i += 1; } else q = false; } else cur += c; } else if (c === '"') q = true; else if (c === sep) { out.push(cur); cur = ''; } else cur += c; }
  out.push(cur); return out.map((x) => x.trim());
}
const stream = (file) => (file.endsWith('.gz') ? fs.createReadStream(file).pipe(zlib.createGunzip()) : fs.createReadStream(file));
const lines = (file) => readline.createInterface({ input: stream(file), crlfDelay: Infinity });
const sha = (file) => new Promise((resolve, reject) => { const h = createHash('sha256'); fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject); });
const num = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null; };
const yearOf = (name) => (name.match(/(?:19|20)\d{2}/) || [])[0] || null;
const short = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 6).toUpperCase();
const CODE = /^(?=.*\d)[0-9A-Z]{5}$/; // five characters with at least one digit (so a header word is never taken for a code)

/** What a file is, from its name (lower-cased). Returns a kind or null. */
export function kindOf(name) {
  const n = name.toLowerCase().replace(/\.gz$/, '');
  if (/\.policy\.json$/.test(n)) return 'policy';
  if (/\.elm\.json$/.test(n)) return 'elm';
  if (/grouper\.json$/.test(n)) return 'grouper';
  if (/benefit.?limits.*\.json$/.test(n)) return 'limits';
  if (/payer.?mix.*\.json$/.test(n)) return 'payer-mix';
  if (/in.?network.*\.json$/.test(n)) return 'negotiated-rates';
  if (/standard.?charges.*\.(csv|json)$/.test(n)) return 'hospital-charges';
  if (/^loinc\.csv$|loinctable.*\.csv$/.test(n)) return 'loinc';
  if (/^rxnconso\.rrf$/.test(n)) return 'rxnorm';
  if (/^rxnsat\.rrf$/.test(n)) return 'rxnorm-ndc';
  if (/^product\.(txt|xls|csv)$|^ndc.*product.*\.(txt|csv)$/.test(n)) return 'ndc';
  if (/^cvx.*\.(txt|csv)$/.test(n)) return 'cvx';
  if (/nucc.?taxonomy.*\.csv$/.test(n)) return 'nucc';
  if (/^sct2_description_.*snapshot.*\.txt$/.test(n)) return 'snomed';
  if (/icd10cm.*\.txt$/.test(n)) return 'icd10cm';
  if (/icd10pcs.*\.txt$/.test(n)) return 'icd10pcs';
  if (/^cpt.*\.(csv|txt)$/.test(n)) return 'cpt';
  if (/hcpc.*\.(txt|csv)$/.test(n)) return 'hcpcs';
  if (/mue.*\.(csv|txt)$/.test(n)) return 'ncci-mue';
  if (/(ptp|ccipra|ccioph|ncci).*\.(csv|txt)$/.test(n)) return 'ncci-ptp';
  if (/pprrvu.*\.csv$/.test(n)) return 'pfs-rvu';
  if (/gpci.*\.csv$/.test(n)) return 'pfs-gpci';
  if (/(table.?5|drg.*weight).*\.csv$/.test(n)) return 'drg';
  if (/(addendum.?aa|asc.*addend).*\.csv$/.test(n)) return 'asc';
  if (/(addendum.?b|opps).*\.csv$/.test(n)) return 'opps';
  if (/(carc|adjustment.?reason).*\.csv$/.test(n)) return 'carc';
  if (/(rarc|remark).*\.csv$/.test(n)) return 'rarc';
  if (/status.?categor.*\.csv$/.test(n)) return 'cscc';
  if (/claim.?status.*\.csv$/.test(n)) return 'csc';
  if (/npidata.*\.csv$/.test(n)) return 'npi';
  if (/hcc.*coef.*\.csv$/.test(n)) return 'hcc-coef';
  if (/hcc.*map.*\.(csv|txt)$/.test(n)) return 'hcc-map';
  if (/(^|[_-])ncd.*\.csv$/.test(n)) return 'ncd';
  if (/article.*\.csv$/.test(n)) return 'article';
  if (/lcd.*\.csv$/.test(n)) return 'lcd';
  return null;
}
const settingOf = (name) => (/hosp|oph|outpatient|facility/i.test(name) ? 'hospital' : /dme/i.test(name) ? 'dme' : 'practitioner');
const header = (cols, ...wants) => wants.map((w) => cols.findIndex((c) => (w instanceof RegExp ? w.test(c) : c.toLowerCase() === w.toLowerCase())));

/** Imports one file. Returns { kind, rows, skipped?: reason, release }. */
export async function importReferenceFile(file, opts = {}) {
  const db = opts.db || openReference(); const name = path.basename(file); const kind = opts.kind || kindOf(name);
  if (!kind) return { file: name, kind: null, rows: 0, skipped: 'not a file this importer knows (see docs/PAYER.md for the names it looks for)' };
  const checksum = await sha(file);
  if (db.prepare('SELECT id FROM releases WHERE kind = ? AND checksum = ?').get(kind, checksum)) return { file: name, kind, rows: 0, skipped: 'already imported' };
  if (opts.dryRun) return { file: name, kind, rows: 0, skipped: 'dry run' };
  const release = opts.release || yearOf(name) || new Date().toISOString().slice(0, 10);
  db.exec('BEGIN');
  try {
    const rel = Number(db.prepare('INSERT INTO releases (kind, release, source, file, checksum, rows, imported_at, note) VALUES (?, ?, ?, ?, ?, 0, ?, ?)').run(kind, release, opts.source || 'imported by the user', name, checksum, new Date().toISOString(), null).lastInsertRowid);
    let rows = 0; let note = null;
    const each = async (fn) => { for await (const line of lines(file)) if (line.trim()) fn(line); };
    if (kind === 'icd10cm' || kind === 'icd10pcs') {
      // Order file: order number, code, header flag (0 = a heading, 1 = billable), short and long descriptions, in fixed columns. Codes file: code, spaces, description.
      const sys = kind === 'icd10cm' ? 'ICD-10-CM' : 'ICD-10-PCS'; const ins = db.prepare('INSERT OR REPLACE INTO codes (system, code, release, short, long, billable) VALUES (?, ?, ?, ?, ?, ?)');
      await each((l) => { const order = /^\d{5} /.test(l); const code = (order ? l.slice(6, 13) : l.slice(0, 7)).trim(); if (!code) return; if (order) ins.run(sys, code, rel, l.slice(16, 76).trim(), l.slice(77).trim(), l[14] === '1' ? 1 : 0); else { const d = l.slice(7).trim(); ins.run(sys, code, rel, d.slice(0, 60), d, 1); } rows += 1; });
    } else if (['loinc', 'rxnorm', 'rxnorm-ndc', 'ndc', 'cvx', 'nucc', 'snomed'].includes(kind)) {
      // Terminology releases. LOINC: Loinc.csv. RxNorm: RXNCONSO.RRF (RXNORM source, preferred names) and RXNSAT.RRF (NDC codes, mapped to their RxNorm concept).
      // NDC: the FDA product.txt (tab separated). CVX: the CDC cvx.txt (pipe separated). NUCC: the taxonomy CSV. SNOMED CT: the RF2 description snapshot, from your licensed release.
      const SYS = { loinc: 'LOINC', rxnorm: 'RXNORM', 'rxnorm-ndc': 'NDC', ndc: 'NDC', cvx: 'CVX', nucc: 'NUCC', snomed: 'SNOMED' }[kind];
      const ins = db.prepare('INSERT OR REPLACE INTO codes (system, code, release, short, long, billable, extra) VALUES (?, ?, ?, ?, ?, ?, ?)'); let head = null;
      await each((l) => {
        if (kind === 'rxnorm') { const c = l.split('|'); if (c[11] !== 'RXNORM' || !['SCD', 'SBD', 'IN', 'BN', 'SCDC', 'GPCK', 'BPCK', 'MIN', 'PIN'].includes(c[12]) || c[16] === 'O') return; ins.run(SYS, c[0], rel, c[12], c[14], 1, null); rows += 1; return; }
        if (kind === 'rxnorm-ndc') { const c = l.split('|'); if (c[8] !== 'NDC' || c[9] !== 'RXNORM' || c[11] === 'Y') return; ins.run(SYS, c[10], rel, null, null, 1, JSON.stringify({ rxcui: c[0] })); rows += 1; return; }
        if (kind === 'cvx') { const c = l.split('|').map((x) => x.trim()); if (!/^\d+$/.test(c[0])) return; ins.run(SYS, c[0], rel, c[1], c[2] || c[1], c[4] === 'Active' ? 1 : 0, JSON.stringify({ status: c[4] || null })); rows += 1; return; }
        if (kind === 'snomed') { const c = l.split('\t'); if (c[0] === 'id' || c[2] !== '1') return; if (c[6] !== '900000000000003001' && c[6] !== '900000000000013009') return; const fsn = c[6] === '900000000000003001'; if (fsn) ins.run(SYS, c[4], rel, null, c[7], 1, null); rows += fsn ? 1 : 0; return; }
        const sep = kind === 'ndc' ? '\t' : ','; const c = csvLine(l, sep); if (!head) { head = c.map((x) => x.toLowerCase()); return; } const at = (name) => c[head.indexOf(name)] ?? '';
        if (kind === 'loinc') { if (!at('loinc_num')) return; ins.run(SYS, at('loinc_num'), rel, at('shortname') || null, at('long_common_name') || at('component'), at('status') === 'ACTIVE' ? 1 : 0, JSON.stringify({ status: at('status') || null, class: at('class') || null })); rows += 1; return; }
        if (kind === 'ndc') { const code = at('productndc'); if (!code) return; ins.run(SYS, code, rel, at('proprietaryname') || null, [at('nonproprietaryname'), at('active_numerator_strength') && `${at('active_numerator_strength')} ${at('active_ingred_unit')}`, at('dosageformname')].filter(Boolean).join(' '), 1, null); rows += 1; return; }
        if (kind === 'nucc') { const code = at('code'); if (!code) return; ins.run(SYS, code, rel, at('classification') || null, at('display name') || [at('grouping'), at('classification'), at('specialization')].filter(Boolean).join(', '), 1, null); rows += 1; }
      });
    } else if (kind === 'hcpcs' || kind === 'cpt') {
      const sys = kind === 'cpt' ? 'CPT' : 'HCPCS'; const ins = db.prepare('INSERT OR REPLACE INTO codes (system, code, release, short, long, billable) VALUES (?, ?, ?, ?, ?, 1)'); const sep = name.toLowerCase().endsWith('.csv') ? ',' : '\t'; const long = new Map();
      await each((l) => {
        if (sep === '\t' && !l.includes('\t')) { const code = l.slice(0, 5); if (!CODE.test(code)) return; const ric = l[10]; const text = l.slice(11, 91).trim(); if (ric === '3' || ric === '7') long.set(code, { long: text, short: l.slice(91, 119).trim() }); else if (long.has(code)) long.get(code).long += ` ${text}`; return; } // the fixed-width layout: continuation lines add to the long description
        const c = csvLine(l, sep); if (!CODE.test(c[0])) return; long.set(c[0], { short: c[1] || '', long: c[2] || c[1] || '' });
      });
      for (const [code, d] of long) { ins.run(sys, code, rel, d.short, d.long); rows += 1; }
    } else if (kind === 'ncci-ptp') {
      const ins = db.prepare('INSERT INTO ncci_ptp (setting, col1, col2, effective, deleted, modifier, rationale, release) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'); const setting = opts.setting || settingOf(name);
      await each((l) => { const c = csvLine(l, l.includes('\t') ? '\t' : ','); if (!CODE.test(c[0]) || !CODE.test(c[1])) return; ins.run(setting, c[0], c[1], c[3] || null, c[4] || null, c[5] ?? null, c[6] || null, rel); rows += 1; });
    } else if (kind === 'ncci-mue') {
      const ins = db.prepare('INSERT OR REPLACE INTO ncci_mue (setting, code, units, mai, rationale, release) VALUES (?, ?, ?, ?, ?, ?)'); const setting = opts.setting || settingOf(name);
      await each((l) => { const c = csvLine(l, l.includes('\t') ? '\t' : ','); if (!CODE.test(c[0]) || num(c[1]) == null) return; ins.run(setting, c[0], num(c[1]), c[2] || null, c[3] || null, rel); rows += 1; });
    } else if (kind === 'pfs-rvu') {
      // The published relative value file, by position: code, modifier, description, status, (unused), work, non-facility practice expense, (flag), facility practice expense, (flag), malpractice, totals, PC/TC, global days, ..., multiple procedure (18), bilateral (19), ..., conversion factor (25).
      const ins = db.prepare('INSERT OR REPLACE INTO pfs_rvu (code, modifier, status, work, pe_nonfac, pe_fac, mp, pctc, global, mult_proc, bilateral, conversion, release) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      await each((l) => { const c = csvLine(l); if (!CODE.test(c[0]) || c.length < 20) return; const conv = num(c[25]) ?? num(c[24]); ins.run(c[0], c[1] || '', c[3] || null, num(c[5]), num(c[6]), num(c[8]), num(c[10]), c[13] || null, c[14] || null, c[18] || null, c[19] || null, conv, rel); rows += 1; });
    } else if (kind === 'pfs-gpci') {
      const ins = db.prepare('INSERT OR REPLACE INTO pfs_gpci (mac, state, locality, name, work, pe, mp, release) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      await each((l) => { const c = csvLine(l); if (!/^\d{5}$/.test(c[0]) || num(c[4]) == null) return; ins.run(c[0], c[1], c[2], c[3], num(c[4]), num(c[5]), num(c[6]), rel); rows += 1; });
    } else if (['drg', 'opps', 'asc'].includes(kind)) {
      let cols = null; let ix = null;
      const start = { drg: /ms-?drg/i, opps: /hcpcs/i, asc: /hcpcs/i }[kind];
      const insDrg = db.prepare('INSERT OR REPLACE INTO drg (drg, mdc, type, title, weight, gmlos, amlos, post_acute, special_pay, release) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const insOpps = db.prepare('INSERT OR REPLACE INTO opps (code, si, apc, weight, rate, copay, release) VALUES (?, ?, ?, ?, ?, ?, ?)'); const insAsc = db.prepare('INSERT OR REPLACE INTO asc (code, indicator, weight, rate, discounted, release) VALUES (?, ?, ?, ?, ?, ?)');
      await each((l) => {
        const c = csvLine(l);
        if (!cols) { if (c.some((x) => start.test(x)) && c.length >= 4) { cols = c; ix = kind === 'drg' ? header(c, /^ms-?drg$/i, /mdc/i, /^type$/i, /title/i, /weight/i, /geometric/i, /arithmetic/i, /post-?acute/i, /special/i) : kind === 'opps' ? header(c, /hcpcs/i, /^si$|status indicator/i, /^apc$/i, /relative weight/i, /payment rate/i, /national unadjusted copay/i) : header(c, /hcpcs/i, /payment indicator/i, /payment weight/i, /payment rate/i, /multiple procedure/i); } return; }
        const v = (i) => (ix[i] < 0 ? null : c[ix[i]]);
        if (kind === 'drg') { if (!/^\d{1,3}$/.test(v(0) || '')) return; insDrg.run(v(0).padStart(3, '0'), v(1), v(2), v(3), num(v(4)), num(v(5)), num(v(6)), v(7), v(8), rel); }
        else if (kind === 'opps') { if (!CODE.test(v(0) || '')) return; insOpps.run(v(0), v(1), v(2), num(v(3)), num(v(4)), num(v(5)), rel); }
        else { if (!CODE.test(v(0) || '')) return; insAsc.run(v(0), v(1), num(v(2)), num(v(3)), v(4), rel); }
        rows += 1;
      });
    } else if (['carc', 'rarc', 'csc', 'cscc'].includes(kind)) {
      const ins = db.prepare('INSERT OR REPLACE INTO codes (system, code, release, short, long, billable, extra) VALUES (?, ?, ?, ?, ?, NULL, ?)'); const sys = kind.toUpperCase();
      await each((l) => { const c = csvLine(l); if (!c[0] || /^code$/i.test(c[0]) || !c[1]) return; ins.run(sys, c[0].toUpperCase(), rel, c[1].slice(0, 80), c[1], c[2] || c[3] ? JSON.stringify({ start: c[2] || null, stop: c[3] || null }) : null); rows += 1; });
    } else if (kind === 'npi') {
      // Only the number, person or organisation, practice state and specialty codes are kept. Names, addresses and identifiers in the file are not read into the database.
      const ins = db.prepare('INSERT OR REPLACE INTO npi (npi, entity, state, taxonomy, taxonomies, release) VALUES (?, ?, ?, ?, ?, ?)'); let ix = null; const states = opts.npiStates ? new Set(opts.npiStates) : null;
      await each((l) => {
        const c = csvLine(l);
        if (!ix) { ix = { npi: c.indexOf('NPI'), entity: c.indexOf('Entity Type Code'), state: c.indexOf('Provider Business Practice Location Address State Name'), tax: c.map((h, i) => (/^Healthcare Provider Taxonomy Code_\d+$/.test(h) ? i : -1)).filter((i) => i >= 0), sw: c.map((h, i) => (/^Healthcare Provider Primary Taxonomy Switch_\d+$/.test(h) ? i : -1)).filter((i) => i >= 0) }; if (ix.npi < 0) throw new Error('This does not look like the NPI file: no "NPI" column'); return; }
        if (!/^\d{10}$/.test(c[ix.npi]) || !c[ix.entity]) return; if (states && !states.has(c[ix.state])) return;
        const tax = ix.tax.map((i) => c[i]).filter(Boolean); const primary = ix.sw.findIndex((i) => c[i] === 'Y');
        ins.run(c[ix.npi], c[ix.entity], c[ix.state] || null, tax[primary >= 0 ? primary : 0] || null, JSON.stringify(tax), rel); rows += 1;
      });
    } else if (kind === 'hcc-map') {
      const ins = db.prepare('INSERT INTO hcc_map (model, icd, hcc, release) VALUES (?, ?, ?, ?)'); const model = opts.model || (name.match(/v\d{2}/i) || ['V28'])[0].toUpperCase();
      await each((l) => { const c = l.includes(',') ? csvLine(l) : l.trim().split(/\s+/); if (!/^[A-Z]\d/.test(c[0] || '') || !/^\d+$/.test(c[1] || '')) return; ins.run(model, c[0].replace('.', ''), c[1], rel); rows += 1; });
    } else if (kind === 'hcc-coef') {
      // model, segment, variable, coefficient; or variable, coefficient with the segment taken from the file name.
      const ins = db.prepare('INSERT OR REPLACE INTO hcc_coef (model, segment, variable, coefficient, release) VALUES (?, ?, ?, ?, ?)'); const model = opts.model || (name.match(/v\d{2}/i) || ['V28'])[0].toUpperCase(); const seg = (name.match(/community|institutional|new.?enrollee/i) || ['community'])[0].toLowerCase();
      await each((l) => { const c = csvLine(l); if (c.length >= 4 && num(c[3]) != null) { ins.run(c[0].toUpperCase(), c[1], c[2], num(c[3]), rel); rows += 1; } else if (c.length >= 2 && num(c[1]) != null) { ins.run(model, seg, c[0], num(c[1]), rel); rows += 1; } });
    } else if (kind === 'hospital-charges') {
      const ins = db.prepare('INSERT INTO hospital_charges (hospital, code, code_type, setting, gross, cash, payer, plan, negotiated, percent, methodology, min, max, flag, release) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const hospital = opts.hospital || name.replace(/[._-]?standard.?charges.*$/i, '') || 'hospital'; const payerKey = new Map(); const pk = (p) => { if (!p) return null; if (!payerKey.has(p)) payerKey.set(p, `Insurer ${short(p)}`); return payerKey.get(p); }; // insurer names in the file are replaced by a stable synthetic label
      const flag = (v) => (v != null && (v <= 0 || v > 5e6) ? 'implausible amount' : null);
      if (name.toLowerCase().replace(/\.gz$/, '').endsWith('.json')) {
        const doc = JSON.parse(await new Promise((resolve, reject) => { const chunks = []; stream(file).on('data', (d) => chunks.push(d)).on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))).on('error', reject); }));
        for (const item of doc.standard_charge_information || []) for (const ci of item.code_information || []) for (const sc of item.standard_charges || []) { const payers = sc.payers_information?.length ? sc.payers_information : [null]; for (const p of payers) { const neg = num(p?.standard_charge_dollar); ins.run(hospital, String(ci.code), ci.type || null, sc.setting || null, num(sc.gross_charge), num(sc.discounted_cash), pk(p?.payer_name), p?.plan_name ? `Plan ${short(p.plan_name)}` : null, neg, num(p?.standard_charge_percentage), p?.methodology || null, num(sc.minimum), num(sc.maximum), flag(neg), rel); rows += 1; } }
      } else {
        let cols = null; let ix = null;
        await each((l) => { const c = csvLine(l); if (!cols) { if (c.some((x) => /standard_charge\s*\|\s*gross/i.test(x))) { cols = c.map((x) => x.replace(/\s+/g, '').toLowerCase()); ix = { code: cols.findIndex((x) => /^code\|1$/.test(x)), type: cols.findIndex((x) => /^code\|1\|type$/.test(x)), setting: cols.indexOf('setting'), gross: cols.indexOf('standard_charge|gross'), cash: cols.indexOf('standard_charge|discounted_cash'), payer: cols.indexOf('payer_name'), plan: cols.indexOf('plan_name'), neg: cols.indexOf('standard_charge|negotiated_dollar'), pct: cols.indexOf('standard_charge|negotiated_percentage'), meth: cols.indexOf('standard_charge|methodology'), min: cols.indexOf('standard_charge|min'), max: cols.indexOf('standard_charge|max') }; } return; }
          const g = (k) => (ix[k] < 0 ? null : c[ix[k]]); if (!g('code')) return; const neg = num(g('neg')); ins.run(hospital, g('code'), g('type'), g('setting'), num(g('gross')), num(g('cash')), pk(g('payer')), g('plan') ? `Plan ${short(g('plan'))}` : null, neg, num(g('pct')), g('meth'), num(g('min')), num(g('max')), flag(neg), rel); rows += 1; });
      }
      note = `hospital key "${hospital}"; ${payerKey.size} insurer names replaced by synthetic labels`;
    } else if (kind === 'negotiated-rates') {
      // The in-network file is one very large JSON object. It is read as a stream: provider groups first, then each item of "in_network" is cut out and parsed on its own. Only the providers and codes asked for are kept.
      const keepNpi = opts.ratesNpi?.length ? new Set(opts.ratesNpi.map(String)) : null; const keepCodes = opts.ratesCodes?.length ? new Set(opts.ratesCodes.map(String)) : null;
      const ins = db.prepare('INSERT INTO negotiated_rates (insurer, plan, npi, tin, code, code_type, modifier, rate, kind, billing_class, expires, flag, release) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const groups = new Map(); let insurer = `Insurer ${short(name)}`; let plan = null; let kept = 0; let seen = 0;
      const groupNpis = (g) => (g.provider_groups || []).flatMap((pg) => (pg.npi || []).map((n) => ({ npi: String(n), tin: pg.tin?.value ? short(pg.tin.value) : null })));
      const item = (it) => { seen += 1; if (keepCodes && !keepCodes.has(String(it.billing_code))) return; for (const nr of it.negotiated_rates || []) { const provs = [...(nr.provider_references || []).flatMap((id) => groups.get(id) || []), ...groupNpis(nr)].filter((p) => !keepNpi || keepNpi.has(p.npi)); if (!provs.length) continue; for (const np of nr.negotiated_prices || []) { const rate = num(np.negotiated_rate); if (rate == null) continue; const fl = np.negotiated_type === 'percentage' ? 'a percentage, not an amount' : rate <= 0 || rate > 5e6 ? 'implausible amount' : null; for (const p of provs) { ins.run(insurer, plan, p.npi, p.tin, String(it.billing_code), it.billing_code_type || null, (np.billing_code_modifier || []).join(',') || null, rate, np.negotiated_type || null, np.billing_class || null, np.expiration_date || null, fl, rel); kept += 1; } } } };
      await streamJson(file, { onScalar: (k, v) => { if (k === 'reporting_entity_name') insurer = `Insurer ${short(v)}`; if (k === 'plan_name') plan = `Plan ${short(v)}`; }, arrays: { provider_references: (g) => groups.set(g.provider_group_id, groupNpis(g)), in_network: item } });
      rows = kept; note = `${seen} services in the file, ${kept} rates kept${keepNpi ? ` for ${keepNpi.size} provider(s)` : ''}${keepCodes ? ` and ${keepCodes.size} code(s)` : ''}; insurer and plan names replaced by synthetic labels`;
    } else if (['ncd', 'lcd', 'article'].includes(kind)) {
      // Coverage database exports: a file with a title column holds the documents; a file with a code column links documents to codes (the role comes from the file name: covered, noncovered, or the procedure codes the document is about).
      let cols = null; const insDoc = db.prepare('INSERT OR REPLACE INTO documents (kind, id, version, title, body, release) VALUES (?, ?, ?, ?, ?, ?)'); const insCode = db.prepare('INSERT INTO document_codes (kind, id, version, system, code, role) VALUES (?, ?, ?, ?, ?, ?)');
      const role = /noncovered|non_covered/i.test(name) ? 'not-covered' : /covered/i.test(name) ? 'covered' : 'about';
      await each((l) => { const c = csvLine(l); if (!cols) { cols = c.map((x) => x.toLowerCase()); return; } const g = (re) => { const i = cols.findIndex((x) => re.test(x)); return i < 0 ? null : c[i]; };
        const id = g(new RegExp(`^${kind === 'article' ? 'article' : kind}_id$`)); if (!id) return; const version = g(/_version$/) || '';
        const hcpc = g(/^hcpc_code_id$/); const icd = g(/^icd10_code_id$/);
        if (hcpc || icd) { insCode.run(kind, id, version, hcpc ? 'HCPCS' : 'ICD-10-CM', String(hcpc || icd).replace('.', '').toUpperCase(), role); rows += 1; return; }
        const title = g(/^title$|_title$/); if (!title) return;
        const body = cols.map((h, i) => [h, c[i]]).filter(([h, v]) => v && /indication|limitation|coverage|summary|documentation|description|utiliz|benefit_category|item_service/.test(h)).map(([h, v]) => `${h.replace(/_/g, ' ')}:\n${v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`).join('\n\n');
        insDoc.run(kind, id, version, title, body, rel); rows += 1; });
    } else if (['policy', 'elm', 'limits', 'payer-mix', 'grouper'].includes(kind)) {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (kind === 'policy') { for (const p of Array.isArray(doc) ? doc : [doc]) { if (!p.id || !p.title || !Array.isArray(p.criteria)) throw new Error('A policy needs id, title and criteria (docs/PAYER.md, policy format)'); const v = String(p.version ?? '1'); db.prepare('INSERT OR REPLACE INTO documents (kind, id, version, title, body, release) VALUES (?, ?, ?, ?, ?, ?)').run('policy', String(p.id), v, p.title, JSON.stringify(p), rel); db.prepare('DELETE FROM document_codes WHERE kind = ? AND id = ? AND version = ?').run('policy', String(p.id), v); for (const a of p.appliesTo || []) db.prepare('INSERT INTO document_codes (kind, id, version, system, code, role) VALUES (?, ?, ?, ?, ?, ?)').run('policy', String(p.id), v, a.system || 'HCPCS', String(a.code).replace('.', '').toUpperCase(), 'about'); rows += 1; } }
      else if (kind === 'elm') { const id = doc.library?.identifier?.id; if (!id) throw new Error('Not a compiled CQL library: no library.identifier.id'); db.prepare('INSERT OR REPLACE INTO documents (kind, id, version, title, body, release) VALUES (?, ?, ?, ?, ?, ?)').run('elm', id, String(doc.library.identifier.version || ''), id, JSON.stringify(doc), rel); rows = 1; }
      else { const key = kind === 'limits' ? `limits:${doc.year || release}` : kind === 'payer-mix' ? `payer-mix:${doc.profile || 'default'}` : 'grouper'; db.prepare('INSERT OR REPLACE INTO settings (key, value, release) VALUES (?, ?, ?)').run(key, JSON.stringify(doc), rel); rows = 1; }
    }
    db.prepare('UPDATE releases SET rows = ?, note = ? WHERE id = ?').run(rows, note, rel);
    db.exec('COMMIT');
    return { file: name, kind, rows, release, ...(note ? { note } : {}) };
  } catch (err) { db.exec('ROLLBACK'); return { file: name, kind, rows: 0, skipped: `could not be read: ${err.message}` }; }
}

/**
 * Reads one very large JSON object as a stream. Top-level strings and numbers go to onScalar(key, value); for each
 * top-level array named in "arrays", every element is cut out of the stream and parsed on its own, so the whole
 * file is never held in memory.
 */
export async function streamJson(file, { onScalar = () => {}, arrays = {} }) {
  let depth = 0; let inStr = false; let esc = false; let key = null; let pendingKey = null; let str = ''; let capture = null; let buf = ''; let scalar = ''; let scalarKey = null; let arr = null;
  for await (const chunk of stream(file)) {
    const text = chunk.toString('utf8');
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (capture) buf += c;
      if (inStr) { if (esc) { esc = false; if (!capture && depth === 1) str += c; } else if (c === '\\') { esc = true; if (!capture && depth === 1) str += c; } else if (c === '"') { inStr = false; if (!capture && depth === 1) { if (scalarKey != null) { onScalar(scalarKey, JSON.parse(`"${str}"`)); scalarKey = null; } else pendingKey = str; } } else if (!capture && depth === 1) str += c; continue; }
      if (c === '"') { inStr = true; str = ''; continue; }
      if (capture) { if (c === '{' || c === '[') depth += 1; else if (c === '}' || c === ']') { depth -= 1; if (depth === 2) { arrays[arr](JSON.parse(buf)); capture = null; buf = ''; } } continue; }
      if (c === '{' || c === '[') { depth += 1; if (depth === 2 && c === '[' && arrays[key]) arr = key; else if (depth === 3 && arr && c === '{') { capture = true; buf = '{'; } continue; }
      if (c === '}' || c === ']') { depth -= 1; if (depth === 1) arr = null; continue; }
      if (depth === 1 && c === ':') { key = pendingKey; scalarKey = key; scalar = ''; continue; }
      if (depth === 1 && c === ',') { if (scalarKey != null && scalar.trim()) { const v = scalar.trim(); onScalar(scalarKey, v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : Number(v)); } scalarKey = null; scalar = ''; continue; }
      if (depth === 1 && scalarKey != null) scalar += c;
    }
  }
}

/** Imports every recognised file under a folder. Returns the per-file results. */
export async function importReferenceFolder(folder, opts = {}) {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = fs.statSync(folder).isDirectory() ? walk(folder).sort() : [folder]; const out = [];
  for (const f of files) { if (/\.(xlsx|xls|zip|pdf)$/i.test(f)) { out.push({ file: path.basename(f), kind: null, rows: 0, skipped: 'unzip it, or save the sheet as CSV, and import that' }); continue; } out.push(await importReferenceFile(f, opts)); }
  return out;
}
