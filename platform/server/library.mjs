// Your own library content. The release ships with none: no patients, cases, scenarios, scribe transcripts,
// visit cases or safety scenarios. Files you place under data/library/<kind>/ (data/ is not in the
// repository) are offered for loading; an empty or missing folder is simply an empty library.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './db/index.mjs';

const ENV = { scenarios: 'SCENARIOS_DIR', scribe: 'SCRIBE_CASES_DIR', 'visit-cases': 'VISIT_CASES_DIR', 'red-team': 'RED_TEAM_DIR' };
export const libraryDir = (kind) => path.resolve(REPO_ROOT, process.env[ENV[kind]] || path.join('data', 'library', kind));
/** Every JSON file of one kind, parsed; files that are not valid JSON are skipped. */
export function libraryFiles(kind, suffix = '.json') {
  const dir = libraryDir(kind);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(suffix)).sort()) { try { out.push({ file: path.join(dir, f), name: f.slice(0, -suffix.length), json: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }); } catch { /* not JSON: skipped */ } }
  return out;
}
