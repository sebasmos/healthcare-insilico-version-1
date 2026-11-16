// Test helpers. Store contract tests run on SQLite by default and on
// PostgreSQL when TEST_BACKEND=postgres and DATABASE_URL are set.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../../platform/server/store.mjs';
import { openAdapter, migrate } from '../../platform/server/db/index.mjs';
import { ensureLiveRun } from '../../platform/server/audit.mjs';
import { randomBytes, createHash } from 'node:crypto';
const fileSchemas = new Map();
import { createApp } from '../../platform/server/index.mjs';
import { ensureReferenceAgents } from '../../agent-operations/server/agents.mjs';

// Tests never read a library from this machine's data/ folder: unless a test makes its own (tests/support/fixtures.mjs), every library is empty.
if (!process.env.OBJECT_STORE_BUCKET_DIR) process.env.OBJECT_STORE_BUCKET_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-no-files-'));
for (const env of ['SCENARIOS_DIR', 'SCRIBE_CASES_DIR', 'VISIT_CASES_DIR', 'RED_TEAM_DIR']) if (!process.env[env]) process.env[env] = path.join(os.tmpdir(), 'hd-no-library');
// Tests never open this machine's reference database: each test process gets an empty one unless it makes its own.
if (!process.env.PAYER_REFERENCE_FILE) process.env.PAYER_REFERENCE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-ref-')), 'ref.sqlite');
// Tests run on PostgreSQL, in the database named by TEST_DATABASE_URL (.env is read automatically), each store in a
// schema of its own so that test files can run side by side. They never touch the real database: DATABASE_URL is
// pointed at the test database for this process and anything it starts. TEST_BACKEND=sqlite runs them on SQLite files.
const REAL_URL = process.env.DATABASE_URL || null; const TEST_URL = process.env.TEST_DATABASE_URL || null;
export const BACKEND = process.env.TEST_BACKEND === 'sqlite' || !TEST_URL ? 'sqlite' : 'postgres';
if (BACKEND === 'postgres') { if (TEST_URL === REAL_URL) throw new Error('TEST_DATABASE_URL is the same as DATABASE_URL. Tests need a database of their own.'); process.env.DATABASE_URL = TEST_URL; process.env.DB_BACKEND = 'postgres'; } else { delete process.env.DATABASE_URL; process.env.DB_BACKEND = 'sqlite'; }
const schemaUrl = (schema) => { const u = new URL(TEST_URL); u.searchParams.set('options', `-c search_path=${schema}`); return u.toString(); };
async function testSchema(name = null) {
  const pg = (await import('pg')).default; const c = new pg.Client({ connectionString: TEST_URL }); await c.connect();
  try {
    // Schemas left by a test that crashed more than two hours ago are cleared away.
    const old = (await c.query("SELECT nspname FROM pg_namespace WHERE nspname ~ '^t_[0-9]+_'")).rows.map((r) => r.nspname).filter((n) => Date.now() / 1000 - Number(n.split('_')[1]) > 7200);
    for (const n of old.slice(0, 20)) await c.query(`DROP SCHEMA IF EXISTS "${n}" CASCADE`).catch(() => {});
    const schema = name || `t_${Math.floor(Date.now() / 1000)}_${randomBytes(5).toString('hex')}`; await c.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`); return schema;
  } finally { await c.end(); }
}
async function dropSchema(schema) { const pg = (await import('pg')).default; const c = new pg.Client({ connectionString: TEST_URL }); await c.connect(); try { await c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await c.end(); } }

export function tempDir(prefix = 'hd-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A manually advanced clock, so tests control recorded time exactly. */
export function testClock(start = '2026-01-01T00:00:00.000Z') {
  let t = Date.parse(start);
  const clock = () => new Date(t);
  clock.set = (isoString) => { t = Date.parse(isoString); };
  clock.advance = (ms) => { t += ms; return new Date(t).toISOString(); };
  clock.now = () => new Date(t).toISOString();
  return clock;
}

export async function openTestStore({ file, clock, backend = BACKEND } = {}) { // backend: 'sqlite' reads a file a command-line run wrote
  const BACKEND_HERE = backend;
  let config;
  let schema = null;
  if (BACKEND_HERE === 'postgres') {
    // A test that names a file wants the same database again when it reopens: the file name picks the schema, and it is kept until the leftovers are cleared.
    schema = await testSchema(file ? `t_${Math.floor(Date.now() / 1000)}_f${createHash('sha1').update(file).digest('hex').slice(0, 10)}` : null);
    if (file) { const known = fileSchemas.get(file); if (known) schema = known; else fileSchemas.set(file, schema); }
    config = { backend: 'postgres', url: schemaUrl(schema) };
  } else {
    config = { backend: 'sqlite', file: file ?? path.join(tempDir(), 'app.sqlite') };
  }
  const adapter = await openAdapter(config);
  await migrate(adapter);
  const store = createStore({ adapter, clock });
  if (schema && !file) { const close = store.close.bind(store); store.close = async () => { await close(); await dropSchema(schema).catch(() => {}); }; }
  return { store, adapter, file: config.file ?? file ?? path.join(os.tmpdir(), 'hd-no-sqlite-file'), schema };
}

export async function startTestServer(options = {}) {
  const { store, adapter, file } = await openTestStore(options);
  await ensureLiveRun(store);
  if (options.agents !== false) await ensureReferenceAgents(store);
  const server = createApp({ store, corsOrigins: ['http://allowed.test'], hooks: options.hooks, webRoot: options.webRoot, autoRedTeam: options.autoRedTeam === true, captureKey: randomBytes(32), auth: options.auth ?? { demo: true } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const response = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Role': 'physician', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: response.status, json, text, headers: response.headers };
  };
  const close = async () => {
    await server.agents.close();
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  };
  return { store, adapter, file, base, call, close, patientMessages: server.patientMessages, studies: server.studies, legacy: server.legacy, trainingRuns: server.trainingRuns, agents: server.agents, redTeam: server.redTeam, rl: server.rl, capture: server.capture };
}

export const patient = (family = 'Testfamily', extra = {}) => ({
  resourceType: 'Patient', name: [{ family, given: ['Synthetic'] }], gender: 'female', birthDate: '1970-01-01', ...extra,
});

export const lab = (patientId, value, extra = {}) => ({
  resourceType: 'Observation', status: 'preliminary',
  category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
  code: { coding: [{ system: 'http://loinc.org', code: '2160-0', display: 'Creatinine' }] },
  subject: { reference: `Patient/${patientId}` },
  valueQuantity: { value, unit: 'mg/dL' },
  ...extra,
});
