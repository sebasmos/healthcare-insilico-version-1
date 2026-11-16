// One-off clean-up: removes the scenario patients (medical record numbers S + six digits) that an old
// scenario-library load left on the live record, with everything linked to them. Main branch only.
//
//   node scripts/remove-scenario-patients.mjs              dry run: lists what would go, changes nothing
//   node scripts/remove-scenario-patients.mjs --apply      copies the database to data/backups/ first, then deletes
//   optional: --file <path to .sqlite>   (default data/app.sqlite)
//
// Works on the local SQLite file only. It never reads DATABASE_URL and never touches a Postgres database.
// Safe while the server is running (one short transaction), though a quiet moment is best. The log is append-only in normal use: this script lifts that
// rule for the length of one transaction and puts it back before it finishes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const file = path.resolve(ROOT, args.includes('--file') ? args[args.indexOf('--file') + 1] : 'data/app.sqlite');
if (!fs.existsSync(file)) { console.error(`No database at ${file}`); process.exit(1); }

if (apply) {
  const dir = path.join(ROOT, 'data', 'backups'); fs.mkdirSync(dir, { recursive: true });
  const copy = path.join(dir, `before-remove-scenario-patients-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  // A consistent copy even if the server is running.
  const src = new DatabaseSync(file); src.exec('PRAGMA busy_timeout = 30000'); src.prepare('VACUUM INTO ?').run(copy); src.close(); console.log(`Backup written: ${path.relative(ROOT, copy)}`);
}

const db = new DatabaseSync(file, { readOnly: !apply });
if (apply) db.exec('PRAGMA busy_timeout = 30000');
const patients = db.prepare(`SELECT rv.id, rv.body FROM resource_versions rv WHERE rv.branch = 'main' AND rv.resource_type = 'Patient'
  AND rv.seq = (SELECT MAX(seq) FROM resource_versions x WHERE x.branch = 'main' AND x.resource_type = 'Patient' AND x.id = rv.id)`).all()
  .map((r) => ({ id: r.id, doc: JSON.parse(r.body) }))
  .map((p) => ({ id: p.id, mrn: (p.doc.identifier || []).map((i) => String(i.value || '')).find((v) => /^S\d{6}$/.test(v)) }))
  .filter((p) => p.mrn);

console.log(`${apply ? 'DELETING' : 'Dry run (nothing is changed)'}: ${path.relative(ROOT, file)}, main branch only`);
console.log(`Scenario patients found on main: ${patients.length}`);
if (!patients.length) { db.close(); process.exit(0); }

// Linked = the patient's own versions, every record filed under the patient, and every other main-branch record whose body mentions the patient's id.
const where = patients.map(() => "(resource_type = 'Patient' AND id = ?) OR patient = ? OR body LIKE ?").join(' OR ');
const params = patients.flatMap((p) => [p.id, `Patient/${p.id}`, `%${p.id}%`]);
const rows = db.prepare(`SELECT seq, resource_type, patient, body FROM resource_versions WHERE branch = 'main' AND (${where})`).all(...params);
const perPatient = new Map(patients.map((p) => [p.id, 0])); const byType = {};
for (const r of rows) {
  byType[r.resource_type] = (byType[r.resource_type] || 0) + 1;
  for (const p of patients) if (r.patient === `Patient/${p.id}` || r.body.includes(p.id)) perPatient.set(p.id, perPatient.get(p.id) + 1);
}
for (const p of patients) console.log(`  MRN ${p.mrn}  Patient/${p.id}  ${perPatient.get(p.id)} linked record versions`);
console.log(`Record versions to delete on main: ${rows.length}`);
for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(7)}  ${t}`);
const elsewhere = db.prepare(`SELECT branch, COUNT(*) AS n FROM resource_versions WHERE branch <> 'main' AND (${where}) GROUP BY branch`).all(...params);
if (elsewhere.length) console.log(`Left alone on other branches: ${elsewhere.map((e) => `${e.branch} (${e.n})`).join(', ')}`);

if (!apply) { console.log('Nothing was changed. Run again with --apply to delete.'); db.close(); process.exit(0); }

const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'resource_versions' AND sql LIKE '%DELETE%'").all();
db.exec('BEGIN IMMEDIATE');
try {
  for (const t of triggers) db.exec(`DROP TRIGGER "${t.name}"`);
  const del = db.prepare('DELETE FROM resource_versions WHERE seq = ? AND branch = \'main\'');
  let n = 0; for (const r of rows) n += Number(del.run(r.seq).changes);
  for (const t of triggers) db.exec(t.sql);
  db.exec('COMMIT');
  console.log(`Deleted ${n} record versions. The append-only rule is back in place (${triggers.length} trigger restored).`);
} catch (err) { db.exec('ROLLBACK'); console.error(`Nothing was deleted: ${err.message}`); process.exitCode = 1; }
db.close();
