// Several stateless workers in front of one PostgreSQL (plan-master task
// 19.2). Each worker is the normal server; the operating system spreads
// connections (and so episodes) across them. SQLite allows one worker only.
//   WORKERS=4 node platform/server/cluster.mjs
import cluster from 'node:cluster';
import os from 'node:os';

const wanted = Number(process.env.WORKERS) || Math.max(1, Math.min(8, os.availableParallelism() - 1));
const url = process.env.DATABASE_URL || '';
const workers = url.startsWith('postgres') ? wanted : 1;
if (cluster.isPrimary) {
  if (workers === 1 && wanted > 1) console.log('  SQLite in use: running one worker. Several workers need PostgreSQL (DATABASE_URL=postgres://...).');
  console.log(`  Starting ${workers} worker${workers === 1 ? '' : 's'} on port ${process.env.PORT || 3000}`);
  for (let i = 0; i < workers; i += 1) cluster.fork({ WORKER_INDEX: String(i) });
  cluster.on('exit', (w, code) => { if (code !== 0 && !w.exitedAfterDisconnect) { console.log(`  worker ${w.id} exited (${code}); restarting`); cluster.fork(); } });
  const stop = () => { for (const w of Object.values(cluster.workers)) w?.disconnect(); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} else {
  process.env.HL7_MLLP_PORT = '';
  await import('./index.mjs');
}
