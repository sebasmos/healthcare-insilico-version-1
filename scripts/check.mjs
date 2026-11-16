// Repository gate. Fails (exit 1) when:
//  1. a data-like file is tracked or stageable under data/ or fixtures/
//  2. a clinical data file (.dcm .hl7 .nii .sqlite .db .parquet) appears anywhere
//  3. a shell line in a script or README code block has a trailing "#" comment
//  4. a JavaScript source file has a syntax error
// Usage: node scripts/check.mjs [--root <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const rootArg = args.indexOf('--root');
const root = path.resolve(rootArg >= 0 ? args[rootArg + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

const DATA_EXT = new Set(['.dcm', '.csv', '.tsv', '.gz', '.zip', '.sqlite', '.db', '.parquet', '.xlsx', '.hl7', '.nii', '.png', '.jpg', '.jpeg', '.svs', '.tif', '.tiff', '.ndpi', '.mrxs']);
const CLINICAL_EXT = new Set(['.dcm', '.hl7', '.nii', '.sqlite', '.db', '.parquet', '.svs', '.ndpi', '.mrxs']);
const SKIP_DIRS = new Set(['node_modules', '.git']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out;
}

function candidateFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    const tracked = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    return { files: [...new Set([...out.toString().split('\0'), ...tracked.toString().split('\0')])].filter(Boolean), git: true };
  } catch {
    return { files: walk(root), git: false };
  }
}

const problems = [];
const { files, git } = candidateFiles();

for (const file of files) {
  const ext = path.extname(file).toLowerCase();
  const top = file.split('/')[0];
  const inDataDir = top === 'data' || top === 'fixtures' || file.includes('/fixtures/') || file.includes('/data/');
  if (!git && top === 'data') continue;
  if (inDataDir && DATA_EXT.has(ext)) problems.push(`data-like file under data/ or fixtures/: ${file}`);
  else if (CLINICAL_EXT.has(ext)) problems.push(`clinical data file in repository: ${file}`);
}

const SHELL_COMMENT = /\S\s+#\s/;
for (const file of files) {
  if (!fs.existsSync(path.join(root, file))) continue;
  if (/\.sh$/.test(file)) {
    fs.readFileSync(path.join(root, file), 'utf8').split('\n').forEach((line, i) => {
      if (!line.trim().startsWith('#') && SHELL_COMMENT.test(line)) problems.push(`trailing shell comment: ${file}:${i + 1}`);
    });
  }
  if (/\.md$/i.test(file)) {
    let inShell = false;
    fs.readFileSync(path.join(root, file), 'utf8').split('\n').forEach((line, i) => {
      const fence = line.trim().match(/^```(\w*)/);
      if (fence) { inShell = !inShell && ['', 'sh', 'bash', 'shell', 'console'].includes(fence[1]); return; }
      if (inShell && !line.trim().startsWith('#') && SHELL_COMMENT.test(line)) problems.push(`trailing shell comment in command: ${file}:${i + 1}`);
    });
  }
}

for (const file of files.filter((f) => /\.(mjs|js)$/.test(f))) {
  if (!fs.existsSync(path.join(root, file))) continue;
  try {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    problems.push(`syntax error: ${file}\n${String(err.stderr).split('\n').slice(0, 4).join('\n')}`);
  }
}

if (problems.length) {
  console.error(`check failed (${problems.length} problem${problems.length === 1 ? '' : 's'}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check passed: ${files.length} files, no data files, no trailing shell comments, syntax OK${git ? '' : ' (not a git repository: scanned the working tree, skipped runtime data/)'}`);
