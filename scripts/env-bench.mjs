// Measures environment throughput (plan-master task 19.2): N episodes of a
// short task with a stub policy against a server started in this process
// (SQLite in a temporary folder, or DATABASE_URL when set). Prints episodes
// per minute. Never touches an existing database unless DATABASE_URL names it.
//   node scripts/env-bench.mjs --episodes 200 --parallel 25
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { openAdapter, migrate } from '../platform/server/db/index.mjs';
import { createStore } from '../platform/server/store.mjs';
import { createApp } from '../platform/server/index.mjs';
import { ensureReferenceAgents } from '../agent-operations/server/agents.mjs';
import { ensureLiveRun } from '../platform/server/audit.mjs';
import { HospitalEnv, stubPolicy } from '../clients/js/hospital-env.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean));
const episodes = Number(args.episodes) || 100; const parallel = Number(args.parallel) || 20;
process.env.ENV_API_ENABLED = 'true';
const url = process.env.DATABASE_URL || '';
const file = url ? null : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-bench-')), 'bench.sqlite');
const adapter = await openAdapter(url ? { backend: 'postgres', url } : { backend: 'sqlite', file });
await migrate(adapter);
const store = createStore({ adapter });
await ensureLiveRun(store); await ensureReferenceAgents(store);
const server = createApp({ store, captureKey: randomBytes(32) });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, p, body, headers = {}) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Role': 'researcher', 'X-User-Id': 'bench', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); return r.json(); };
await call('POST', '/agent-ops/cases/load', {});
const bank = (await call('GET', '/agent-ops/cases')).cases.filter((c) => c.split !== 'eval');
const key = await call('POST', '/api/admin/env-keys', { org: 'bench', rateLimit: 100000 }, { 'X-Role': 'administrator', 'X-User-Id': 'bench-admin' });
const env = new HospitalEnv({ baseUrl: base, token: key.token });
console.log(`${episodes} episodes, ${parallel} in parallel, ${url ? 'PostgreSQL' : 'SQLite'}, ${os.cpus()[0]?.model || 'cpu'} x${os.availableParallelism()}, Node ${process.versions.node}`);
const started = Date.now(); let done = 0; let next = 0; let steps = 0;
const worker = async () => { while (next < episodes) { const i = next; next += 1; const r = await env.runEpisode({ taskId: bank[i % bank.length].id, seed: i }, stubPolicy, { maxSteps: 20 }); steps += r.steps; done += 1; } };
await Promise.all(Array.from({ length: parallel }, worker));
const seconds = (Date.now() - started) / 1000;
console.log(`${done} episodes (${steps} steps) in ${seconds.toFixed(1)} s: ${(done / (seconds / 60)).toFixed(0)} episodes per minute, ${(steps / seconds).toFixed(1)} steps per second`);
await server.agents.close(); await new Promise((resolve) => server.close(resolve)); await store.close();
if (file) fs.rmSync(path.dirname(file), { recursive: true, force: true });
