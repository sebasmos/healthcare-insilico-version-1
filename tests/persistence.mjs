import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openTestStore, tempDir, patient, lab, BACKEND } from './support/helpers.mjs';
import { createStore } from '../platform/server/store.mjs';
import { openAdapter, migrate, REPO_ROOT } from '../platform/server/db/index.mjs';

const sqliteOnly = { skip: BACKEND !== 'sqlite' && 'SQLite file behaviour' };

test('records, branches and versions survive closing and reopening the database', sqliteOnly, async () => {
  const file = path.join(tempDir(), 'app.sqlite');
  let { store } = await openTestStore({ file });
  const p = await store.save('Patient', patient('Persisted'));
  const o = await store.save('Observation', lab(p.id, 1.1));
  await store.save('Observation', { ...o, valueQuantity: { value: 2.2, unit: 'mg/dL' } });
  const branch = await store.fork({ kind: 'sandbox' });
  await store.save('Observation', lab(p.id, 3.3), { branch });
  await store.close();

  ({ store } = await openTestStore({ file }));
  assert.equal((await store.get('Patient', p.id)).birthDate, '1970-01-01');
  assert.equal((await store.history('Observation', o.id)).length, 2);
  assert.equal((await store.query('Observation', {}, { branch })).length, 2);
  assert.equal((await store.getBranch(branch)).kind, 'sandbox');
  await store.close();
});

test('migrations are versioned and re-running them is a no-op', sqliteOnly, async () => {
  const file = path.join(tempDir(), 'app.sqlite');
  const adapter = await openAdapter({ backend: 'sqlite', file });
  assert.deepEqual(await migrate(adapter), ['001_init.sql', '002_capture_content.sql', '003_research.sql', '004_whole_unit_delete.sql', '005_care_cap.sql']);
  assert.deepEqual(await migrate(adapter), []);
  const rows = await adapter.all('SELECT version FROM schema_migrations', []);
  assert.equal(rows.length, 5);
  await adapter.close();
});

test('an existing database is upgraded in place by a new migration, keeping its records', sqliteOnly, async () => {
  const dir = tempDir();
  const file = path.join(dir, 'app.sqlite');
  // A database created before the capture_content migration existed.
  const old = path.join(dir, 'migrations', 'sqlite');
  fs.mkdirSync(old, { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'migrations', 'sqlite', '001_init.sql'), path.join(old, '001_init.sql'));
  let adapter = await openAdapter({ backend: 'sqlite', file });
  assert.deepEqual(await migrate(adapter, { dir: path.join(dir, 'migrations') }), ['001_init.sql']);
  const p = await createStore({ adapter }).save('Patient', patient('Upgraded'));
  await adapter.close();

  adapter = await openAdapter({ backend: 'sqlite', file });
  assert.deepEqual(await migrate(adapter), ['002_capture_content.sql', '003_research.sql', '004_whole_unit_delete.sql', '005_care_cap.sql']);
  const store = createStore({ adapter });
  assert.equal((await store.get('Patient', p.id)).birthDate, '1970-01-01');
  assert.deepEqual(await adapter.all('SELECT id FROM capture_content', []), []);
  await store.close();
});

test('backup produces a database that opens with the same contents', sqliteOnly, async () => {
  const dir = tempDir();
  const { store } = await openTestStore({ file: path.join(dir, 'app.sqlite') });
  const p = await store.save('Patient', patient('Backedup'));
  const out = path.join(dir, 'backups', 'copy.sqlite');
  await store.backup(out);
  await store.close();
  assert.ok(fs.statSync(out).size > 0);
  const restored = createStore({ adapter: await openAdapter({ backend: 'sqlite', file: out }) });
  assert.equal((await restored.get('Patient', p.id)).birthDate, '1970-01-01');
  await restored.close();
});

test('db:migrate, db:backup and restore scripts work end to end', sqliteOnly, () => {
  const dir = tempDir();
  const env = { ...process.env, DB_BACKEND: 'sqlite', SQLITE_FILE: path.join(dir, 'app.sqlite') };
  const run = (script, ...args) => execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', script), ...args], { env, encoding: 'utf8' });
  assert.match(run('db-migrate.mjs'), /Applied: 001_init\.sql/);
  assert.match(run('db-migrate.mjs'), /No pending migrations/);
  const backup = path.join(dir, 'b.sqlite');
  assert.match(run('db-backup.mjs', '--out', backup), /Backup written/);
  assert.match(run('db-backup.mjs', '--restore', backup), /Restored/);
  assert.ok(fs.existsSync(env.SQLITE_FILE));
});
