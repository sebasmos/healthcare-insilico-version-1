// npm run storage:copy -- --to <gcs|s3|azure>: copies every file under the
// local storage folders into the chosen provider, checks size and SHA-256,
// and reports (plan-master task 21.4). Keys come from .env only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyAll } from '../platform/server/storage.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(REPO_ROOT, '.env');
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean));
const to = String(args.to || '').toLowerCase();
if (!['gcs', 's3', 'azure'].includes(to)) { console.error('Usage: npm run storage:copy -- --to <gcs|s3|azure>'); process.exit(1); }
const report = await copyAll({ to, log: (line) => { if (args.verbose) console.log(line); } });
for (const r of report) console.log(`${r.kind.padEnd(10)} ${r.copied}/${r.files} files, ${(r.bytes / 1048576).toFixed(1)} MB${r.failed.length ? `, ${r.failed.length} MISMATCH: ${r.failed.slice(0, 5).join(', ')}` : ''}`);
process.exit(report.some((r) => r.failed.length) ? 1 : 0);
