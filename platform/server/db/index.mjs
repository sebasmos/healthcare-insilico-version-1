// Opens the configured database adapter and applies versioned migrations.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Reads .env at the root of the project into the environment, once. A value already set in the environment wins,
 * so a one-off override on the command line still works. Every entry point comes through this file, so the server,
 * the import and loader scripts and the tests all see the same settings without any export lines.
 */
let envLoaded = false;
export function loadEnv(file = path.join(REPO_ROOT, '.env')) {
  if (envLoaded) return; envLoaded = true; let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) { const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line); if (!m || line.trim().startsWith('#')) continue; const v = m[2].replace(/^(["'])(.*)\1$/, '$2'); if (process.env[m[1]] === undefined) process.env[m[1]] = v; }
}
loadEnv();

/**
 * DATA_DIR points every file location at one folder (for example a Cloud Storage bucket mounted at /app/data).
 * A mounted bucket has no file locks, so the one SQLite file kept under data (the insurance reference data) is
 * copied to the temporary folder and opened there. Anything already set in the environment is left alone.
 */
export function applyDataDir(env = process.env) {
  if (!env.DATA_DIR) return; const d = path.resolve(env.DATA_DIR); const set = (k, v) => { if (env[k] === undefined) env[k] = v; };
  for (const [k, sub] of Object.entries({ OBJECT_STORE_BUCKET_DIR: '.', OBJECT_STORE_CLINICAL_DIR: '.', OBJECT_STORE_EXPORTS_DIR: 'exports', OBJECT_STORE_RECORDINGS_DIR: 'recordings', OBJECT_STORE_BACKUPS_DIR: 'backups', DICOM_DIR: 'dicom', SLIDES_DIR: 'slides', HL7_DIR: 'hl7', VISITS_DIR: 'visits', MODELS_DIR: 'models', SCRIBE_DIR: 'scribe', DATASETS_FILE: 'datasets.json', CAPTURE_KEY_FILE: 'capture.key', SCENARIOS_DIR: 'library/scenarios', SCRIBE_CASES_DIR: 'library/scribe', VISIT_CASES_DIR: 'library/visit-cases', RED_TEAM_DIR: 'library/red-team' })) set(k, path.join(d, sub));
  if (env.PAYER_REFERENCE_FILE === undefined) { const from = path.join(d, 'payer-reference.sqlite'); const to = path.join(process.env.TMPDIR || '/tmp', 'payer-reference.sqlite'); try { if (fs.existsSync(from)) fs.copyFileSync(from, to); } catch { /* start without reference data */ } env.PAYER_REFERENCE_FILE = to; }
}
applyDataDir();
// A secret pasted or piped into a secret store often ends with a line break: it is not part of the value.
for (const k of ['DATABASE_URL', 'SESSION_SECRET']) if (typeof process.env[k] === 'string') process.env[k] = process.env[k].trim();

/** PostgreSQL is the database. SQLite is used only when DB_BACKEND=sqlite is set on purpose. */
export function dbConfig(env = process.env) {
  if (!env.DB_BACKEND && !env.DATABASE_URL) throw new Error('No database is configured. Put DATABASE_URL=postgres://... in .env (PostgreSQL is the database). To run on a local SQLite file instead, set DB_BACKEND=sqlite on purpose.');
  const backend = (env.DB_BACKEND || 'postgres').toLowerCase();
  if (backend === 'postgres') {
    if (!env.DATABASE_URL) throw new Error('DB_BACKEND=postgres requires DATABASE_URL');
    return { backend, url: env.DATABASE_URL };
  }
  if (backend !== 'sqlite') throw new Error(`Unknown DB_BACKEND "${backend}" (use sqlite or postgres)`);
  return { backend, file: path.resolve(REPO_ROOT, env.SQLITE_FILE || 'data/app.sqlite') };
}

export async function openAdapter(config = dbConfig()) {
  if (config.backend === 'postgres') {
    const { PostgresAdapter } = await import('./postgres.mjs');
    return PostgresAdapter.connect(config.url);
  }
  const { SqliteAdapter } = await import('./sqlite.mjs');
  return new SqliteAdapter(config.file);
}

export async function migrate(adapter, { dir = path.join(REPO_ROOT, 'migrations') } = {}) {
  await adapter.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const folder = path.join(dir, adapter.dialect);
  const files = fs.readdirSync(folder).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const applied = [];
  for (const file of files) {
    const version = Number(file.split('_')[0]);
    const done = await adapter.get('SELECT version FROM schema_migrations WHERE version = ?', [version]);
    if (done) continue;
    const sql = fs.readFileSync(path.join(folder, file), 'utf8');
    await adapter.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        version, file, new Date().toISOString(),
      ]);
    });
    applied.push(file);
  }
  return applied;
}
