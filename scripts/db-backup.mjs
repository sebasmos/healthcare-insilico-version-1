// Backup and restore for the local SQLite database.
//   npm run db:backup
//   npm run db:backup -- --out data/backups/my.sqlite
//   npm run db:backup -- --restore data/backups/my.sqlite
// Stop the server before restoring. PostgreSQL deployments use pg_dump.
import fs from 'node:fs';
import path from 'node:path';
import { openAdapter, dbConfig, REPO_ROOT } from '../platform/server/db/index.mjs';

const args = process.argv.slice(2);
const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const config = dbConfig();

if (config.backend !== 'sqlite') {
  // PostgreSQL: a pg_dump archive under data/backups. Restore it with pg_restore --clean --dbname <url> <file>.
  const { execFileSync } = await import('node:child_process');
  const tool = [process.env.PG_DUMP, 'pg_dump', ...fs.globSync('/Applications/Postgres.app/Contents/Versions/*/bin/pg_dump').sort().reverse(), '/opt/homebrew/bin/pg_dump', '/usr/local/bin/pg_dump'].filter(Boolean).find((t) => { try { execFileSync(t, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } });
  if (!tool) { console.error('pg_dump was not found. Install the PostgreSQL tools, or set PG_DUMP to its path.'); process.exit(2); }
  if (value('--restore')) { console.error(`To restore a PostgreSQL backup, stop the server and run: pg_restore --clean --if-exists --dbname "<DATABASE_URL>" ${value('--restore')}`); process.exit(2); }
  const out = path.resolve(value('--out') || path.join(REPO_ROOT, 'data', 'backups', `${new URL(config.url).pathname.slice(1)}-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`));
  fs.mkdirSync(path.dirname(out), { recursive: true }); execFileSync(tool, ['--format=custom', `--file=${out}`, config.url], { stdio: 'inherit' });
  console.log(`Backup written to ${path.relative(REPO_ROOT, out)} (${fs.statSync(out).size} bytes)`);
  process.exit(0);
}

const restore = value('--restore');
if (restore) {
  const source = path.resolve(restore);
  if (!fs.existsSync(source)) { console.error(`Backup not found: ${source}`); process.exit(1); }
  if (fs.existsSync(config.file)) {
    const aside = `${config.file}.before-restore-${Date.now()}`;
    fs.renameSync(config.file, aside);
    console.log(`Current database kept at ${path.relative(REPO_ROOT, aside)}`);
  }
  for (const suffix of ['-wal', '-shm']) fs.rmSync(config.file + suffix, { force: true });
  fs.mkdirSync(path.dirname(config.file), { recursive: true });
  fs.copyFileSync(source, config.file);
  console.log(`Restored ${path.relative(REPO_ROOT, config.file)} from ${restore}`);
} else {
  if (!fs.existsSync(config.file)) { console.error(`No database at ${config.file}`); process.exit(1); }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.resolve(value('--out') || path.join(REPO_ROOT, 'data', 'backups', `app-${stamp}.sqlite`));
  const adapter = await openAdapter(config);
  try {
    await adapter.backup(out);
  } finally {
    await adapter.close();
  }
  console.log(`Backup written to ${path.relative(REPO_ROOT, out)} (${fs.statSync(out).size} bytes)`);
  // The backups bucket (task 21): when a cloud store is configured, the file is copied there too, checked by size.
  if ((process.env.OBJECT_STORE || 'local') !== 'local') { const { createObjectStore } = await import('../platform/server/storage.mjs'); const backups = await createObjectStore('backups'); const key = path.basename(out); await backups.put(key, fs.readFileSync(out)); const head = await backups.head(key); console.log(head && head.size === fs.statSync(out).size ? `Copied to the ${backups.provider} backups bucket as ${key}` : `Copy to the backups bucket could not be verified`); }
}
