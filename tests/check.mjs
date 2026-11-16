import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { tempDir } from './support/helpers.mjs';
import { REPO_ROOT } from '../platform/server/db/index.mjs';

const CHECK = path.join(REPO_ROOT, 'scripts', 'check.mjs');
const run = (root) => spawnSync(process.execPath, [CHECK, '--root', root], { encoding: 'utf8' });

function repo(files, { git = true, ignore = 'data/\n' } = {}) {
  const dir = tempDir('hd-check-');
  if (git) execFileSync('git', ['init', '-q', dir]);
  if (ignore) fs.writeFileSync(path.join(dir, '.gitignore'), ignore);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('check passes on this repository', () => {
  const result = run(REPO_ROOT);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check passed/);
});

test('check passes when runtime data sits in the gitignored data/ directory', () => {
  const dir = repo({ 'data/app.sqlite': 'x', 'data/dicom/a/b/c.dcm': 'x', 'src/ok.mjs': 'export const a = 1;\n' });
  assert.equal(run(dir).status, 0);
});

for (const ext of ['dcm', 'csv', 'tsv', 'gz', 'zip', 'sqlite', 'db', 'parquet', 'xlsx', 'hl7', 'nii', 'png', 'jpg']) {
  test(`check fails on fixtures/sample.${ext}`, () => {
    const result = run(repo({ [`fixtures/sample.${ext}`]: 'x' }));
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`sample\\.${ext}`));
  });
}

test('check fails when a data file is force-added under data/', () => {
  const dir = repo({ 'data/patients.csv': 'a,b\n' });
  execFileSync('git', ['add', '-f', 'data/patients.csv'], { cwd: dir });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /data\/patients\.csv/);
});

test('check fails on a DICOM file anywhere in the repository', () => {
  const result = run(repo({ 'web/pacs/sample.dcm': 'x' }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /clinical data file/);
});

test('check fails on a trailing shell comment in a README command', () => {
  const result = run(repo({ 'README.md': 'Run:\n\n```\nnpm run dev # starts everything\n```\n' }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /trailing shell comment/);
});

test('check fails on a JavaScript syntax error', () => {
  const result = run(repo({ 'server/broken.mjs': 'export const = ;\n' }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /syntax error/);
});

test('check works without git by scanning the working tree', () => {
  const dir = repo({ 'fixtures/x.csv': 'x' }, { git: false, ignore: null });
  const result = spawnSync(process.execPath, [CHECK, '--root', dir], { encoding: 'utf8', env: { ...process.env, GIT_DIR: path.join(dir, 'no-such-git-dir') } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fixtures\/x\.csv/);
});
