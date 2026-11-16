// Copies everything from the SQLite file into PostgreSQL: every version of every record on every branch, the
// branches, recorded free text and idempotency keys. A row already in Postgres (same type, id, branch and version)
// is left as it is, so running this again adds nothing. Files under data/ are not touched.
//   node scripts/copy-sqlite-to-postgres.mjs [--dry-run] [--sqlite data/app.sqlite]
import path from 'node:path';
import { REPO_ROOT, loadEnv } from '../platform/server/db/index.mjs';

loadEnv();
const args = process.argv.slice(2); const dryRun = args.includes('--dry-run'); const value = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const file = path.resolve(REPO_ROOT, value('--sqlite') || 'data/app.sqlite');
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set (.env)'); process.exit(2); }
const { DatabaseSync } = await import('node:sqlite'); const pg = (await import('pg')).default;
const lite = new DatabaseSync(file, { readOnly: true }); const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const where = new URL(process.env.DATABASE_URL); console.log(`From ${path.relative(REPO_ROOT, file)} to PostgreSQL database ${where.pathname.slice(1)} on ${where.hostname}${dryRun ? ' (dry run: nothing is written)' : ''}`);
const counts = async () => new Map((await db.query('SELECT resource_type, branch, COUNT(*) AS n FROM resource_versions GROUP BY 1, 2')).rows.map((r) => [`${r.resource_type}|${r.branch}`, Number(r.n)]));
const before = await counts(); const liteCounts = new Map(lite.prepare('SELECT resource_type, branch, COUNT(*) AS n FROM resource_versions GROUP BY 1, 2').all().map((r) => [`${r.resource_type}|${r.branch}`, Number(r.n)]));
const total = (m) => [...m.values()].reduce((a, b) => a + b, 0);
console.log(`  SQLite: ${total(liteCounts)} record versions on ${new Set([...liteCounts.keys()].map((k) => k.split('|')[1])).size} branches. Postgres before: ${total(before)}.`);

await db.query('BEGIN');
try {
  // Branches, parents first.
  const have = new Set((await db.query('SELECT id FROM branches')).rows.map((r) => r.id)); let pending = lite.prepare('SELECT * FROM branches ORDER BY created_at, id').all().filter((b) => !have.has(b.id)); let branchesAdded = 0;
  while (pending.length) { const ready = pending.filter((b) => !b.parent_branch || have.has(b.parent_branch)); if (!ready.length) throw new Error(`Branches with a missing parent: ${pending.map((b) => b.id).join(', ')}`);
    for (const b of ready) { await db.query('INSERT INTO branches (id, parent_branch, forked_at, kind, created_at, dropped_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING', [b.id, b.parent_branch, b.forked_at, b.kind, b.created_at, b.dropped_at]); have.add(b.id); branchesAdded += 1; } pending = pending.filter((b) => !have.has(b.id)); }
  // Record versions, in the order they were written.
  const rows = lite.prepare('SELECT resource_type, id, version_id, branch, recorded_at, valid_at, patient, group_key, internal, body FROM resource_versions ORDER BY seq').iterate(); let batch = []; let added = 0; let seen = 0;
  const flush = async () => { if (!batch.length) return; const col = (k) => batch.map((r) => r[k]);
    const r = await db.query(`INSERT INTO resource_versions (resource_type, id, version_id, branch, recorded_at, valid_at, patient, group_key, internal, body)
      SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::int[], $10::jsonb[]) WITH ORDINALITY AS t(a, b, c, d, e, f, g, h, i, j, o) ORDER BY o
      ON CONFLICT (resource_type, id, branch, version_id) DO NOTHING`.replace('SELECT * FROM', 'SELECT a, b, c, d, e, f, g, h, i, j FROM'), [col('resource_type'), col('id'), col('version_id'), col('branch'), col('recorded_at'), col('valid_at'), col('patient'), col('group_key'), col('internal'), col('body')]);
    added += r.rowCount; seen += batch.length; batch = []; if (seen % 50000 < 500) process.stdout.write(`\r  ${seen} read, ${added} new`); };
  for (const r of rows) { batch.push(r); if (batch.length >= 500) await flush(); } await flush(); process.stdout.write('\n');
  // Rows that were already there under the same id and version but say something different: left alone, and counted.
  let differ = 0; { const sample = []; const check = lite.prepare('SELECT resource_type, id, version_id, branch, body FROM resource_versions WHERE resource_type IN (\'Patient\', \'Agent\', \'EvalStudy\', \'Run\')').all(); for (let i = 0; i < check.length; i += 500) { const part = check.slice(i, i + 500); const r = await db.query('SELECT t.a, t.b FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::jsonb[]) AS t(a, b, c, d, e) JOIN resource_versions v ON v.resource_type = t.a AND v.id = t.b AND v.version_id = t.c AND v.branch = t.d WHERE v.body <> t.e', [part.map((x) => x.resource_type), part.map((x) => x.id), part.map((x) => x.version_id), part.map((x) => x.branch), part.map((x) => x.body)]); differ += r.rowCount; for (const x of r.rows.slice(0, 3)) if (sample.length < 5) sample.push(`${x.a}/${x.b}`); } if (differ) console.log(`  Note: ${differ} versions of patients, agents, studies or runs exist in both with the same version number but different content (for example ${sample.join(', ')}). Postgres was kept.`); }
  let free = 0; for (const c of lite.prepare('SELECT * FROM capture_content').all()) free += (await db.query('INSERT INTO capture_content (id, run_id, kind, field, about, cipher, length, redactions, created_by, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING', [c.id, c.run_id, c.kind, c.field, c.about, c.cipher, c.length, c.redactions, c.created_by, c.created_at, c.expires_at])).rowCount;
  let keys = 0; for (const k of lite.prepare('SELECT * FROM idempotency_keys').all()) keys += (await db.query('INSERT INTO idempotency_keys (scope, key, status, response, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (scope, key) DO NOTHING', [k.scope, k.key, k.status, k.response, k.created_at])).rowCount;
  const after = await counts();
  console.log(`  New in Postgres: ${added} record versions, ${branchesAdded} branches, ${free} pieces of recorded free text, ${keys} idempotency keys. Already there (skipped): ${seen - added}.`);
  console.log('\n  Type                         Branch                     SQLite  Postgres before  Postgres after');
  let short = 0; for (const key of [...new Set([...liteCounts.keys(), ...after.keys()])].sort()) { const [type, branch] = key.split('|'); const a = liteCounts.get(key) || 0; const c = after.get(key) || 0; if (c < a) short += 1; if (a || (before.get(key) || 0) !== c) console.log(`  ${type.padEnd(28)} ${branch.slice(0, 26).padEnd(26)} ${String(a).padStart(6)}  ${String(before.get(key) || 0).padStart(15)}  ${String(c).padStart(14)}${c < a ? '  SHORT' : c > a ? '  (Postgres has more)' : ''}`); }
  const extra = [...after.keys()].filter((k) => !liteCounts.has(k)).length;
  console.log(`\n  ${short ? `${short} type and branch pairs are SHORT in Postgres` : 'Every type on every branch has at least as many versions in Postgres as in SQLite'}. Totals: SQLite ${total(liteCounts)}, Postgres ${total(after)}${extra ? ` (${extra} type and branch pairs exist only in Postgres)` : ''}.`);
  if (short) throw new Error('Counts do not match: nothing was kept.');
  await db.query(dryRun ? 'ROLLBACK' : 'COMMIT'); console.log(dryRun ? '  Dry run: rolled back.' : '  Committed.');
} catch (err) { await db.query('ROLLBACK').catch(() => {}); console.error(`\nStopped, nothing was written: ${err.message}`); process.exitCode = 1; } finally { await db.end(); lite.close(); }

// Patient numbers. A patient present in both under the same version keeps the Postgres copy; if that copy has no
// patient number and the SQLite one has, the number is added as a new version (nothing is rewritten).
if (!process.exitCode && !dryRun) {
  const { openStore } = await import('../platform/server/index.mjs'); const { DatabaseSync: Lite } = await import('node:sqlite'); const src = new Lite(file, { readOnly: true }); const store = await openStore(); const MRN = 'urn:hospital-desktop:mrn'; let given = 0;
  const latest = src.prepare("SELECT id, body FROM resource_versions rv WHERE resource_type = 'Patient' AND branch = 'main' AND version_id = (SELECT MAX(version_id) FROM resource_versions x WHERE x.resource_type = 'Patient' AND x.id = rv.id AND x.branch = 'main')").all();
  const taken = new Set((await store.query('Patient', {}, { branch: 'main' })).flatMap((p) => (p.identifier || []).filter((i) => i.system === MRN).map((i) => i.value)));
  for (const row of latest) { const want = (JSON.parse(row.body).identifier || []).find((i) => i.system === MRN); if (!want || taken.has(want.value)) continue; const cur = await store.get('Patient', row.id, { branch: 'main' }); if (!cur || (cur.identifier || []).some((i) => i.system === MRN)) continue;
    const { _seq, meta, ...doc } = cur; await store.save('Patient', { ...doc, identifier: [want, ...(doc.identifier || [])] }, { branch: 'main', updatedBy: 'import' }); taken.add(want.value); given += 1; }
  console.log(`  Patient numbers carried over from SQLite to patients that had none in Postgres: ${given}.`);
  await store.close(); src.close();
}
