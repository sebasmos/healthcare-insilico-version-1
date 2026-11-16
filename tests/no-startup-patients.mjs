// Nothing creates a patient unless a person asks for one.
//   1. A server on an empty database, with every page and script fetched and the list screens' data read,
//      has zero Patient records on the live record, and no served file holds a person's name.
//   2. A scenario from your library puts its patient only on the branch of the run that uses it,
//      never on the live record, under the name "Patient <short id>" whatever the file says.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, tempDir } from './support/helpers.mjs';
import { personNames, dictionaryAvailable } from './support/names.mjs';
import { REPO_ROOT } from '../platform/server/db/index.mjs';
import { webFiles } from '../platform/server/web-files.mjs';

const pages = () => webFiles(REPO_ROOT).filter(([url]) => !url.startsWith('/vendor/') && /\.(html|js|css|json)$/.test(url));
const everyBranchPatients = async (s) => {
  const out = {};
  for (const b of await s.store.listBranches()) { const n = (await s.store.query('Patient', {}, { branch: b.id })).length; if (n) out[b.id] = n; }
  return out;
};

test('an empty database stays empty: no patient after every page is served, and no person names in any page', async () => {
  const s = await startTestServer();
  try {
    const files = pages(); assert.ok(files.length > 30, 'the pages were found');
    const named = [];
    for (const [url, f] of files) {
      const r = await fetch(s.base + url); assert.equal(r.status, 200, url);
      const found = personNames(await r.text()); if (found.length) named.push(`${url}: ${found.join(', ')}`);
    }
    assert.deepEqual(named, [], 'no served page or script holds a person name');
    if (!dictionaryAvailable) console.log('note: no system word lists here, so only titles followed by a name were checked');
    // What the first screens ask for when they open.
    for (const [url, role] of [['/auth/patients', 'physician'], ['/auth/roles', 'physician'], ['/fhir/R4/Patient', 'physician'], ['/api/counters', 'physician'], ['/api/pacs/worklist', 'physician'], ['/api/beds/board', 'nurse'],
      ['/api/pharmacy/queue', 'pharmacist'], ['/api/ins/auth', 'physician'], ['/api/ins/claims', 'physician'], ['/agent-ops/cases', 'researcher'], ['/agent-ops/scenarios', 'researcher'], ['/agent-ops/red-team', 'researcher'], ['/agent-ops/scribe/cases', 'researcher'], ['/agent-ops/runs', 'researcher'], ['/agent-ops/agents', 'researcher']]) {
      const r = await s.call('GET', url, undefined, { 'X-Role': role, 'X-User-Id': 'user-1' });
      assert.ok(r.status < 500, `${url} -> ${r.status}`);
      assert.deepEqual(personNames(r.text), [], `${url} holds no person name`);
    }
    assert.deepEqual((await s.call('GET', '/auth/patients')).json.patients, []);
    assert.equal((await s.store.head('Patient')).length, 0, 'zero patients on the live record');
    assert.deepEqual(await everyBranchPatients(s), {}, 'and none on any branch');
  } finally { await s.close(); }
});

test('a library scenario plants its patient only on the run branch, with no name', async () => {
  const dir = tempDir('hd-scen-'); const before = process.env.SCENARIOS_DIR; process.env.SCENARIOS_DIR = dir;
  // Built here at run time: the file carries a name on purpose, to prove it is never used.
  const label = ['Zz', 'file', 'name'].join('');
  fs.writeFileSync(path.join(dir, 'case-one.json'), JSON.stringify({ resourceType: 'Bundle', entry: [
    { resource: { resourceType: 'Patient', id: 'p1', name: [{ family: label, given: [label] }], gender: 'female', birthDate: '1960-02-03' } },
    { resource: { resourceType: 'Condition', id: 'c1', subject: { reference: 'Patient/p1' }, code: { text: 'Raised creatinine' }, clinicalStatus: { coding: [{ code: 'active' }] }, recordedDate: '@now-2d' } },
  ] }));
  fs.writeFileSync(path.join(dir, 'case-one.task.json'), JSON.stringify({ slug: 'case-one', title: 'Case one', scenario: 'A check of where scenario patients are written.', task: 'Review the chart.', goldActions: [], avoid: [], split: 'train', tags: [] }));
  const s = await startTestServer(); const res = { 'X-Role': 'researcher', 'X-User-Id': 'res-one' };
  try {
    const load = await s.call('POST', '/agent-ops/cases/load', { slug: 'case-one' }, res);
    assert.equal(load.status, 201, load.text);
    assert.equal((await s.store.head('Patient')).length, 0, 'loading a scenario writes no patient');
    assert.ok(!load.text.includes(label), 'the name in the file is dropped at load');
    const bank = await s.call('GET', '/agent-ops/cases', undefined, res);
    assert.ok(!bank.text.includes(label)); assert.ok(!bank.text.includes('"plant"'), 'the case list does not carry the chart');
    const kase = load.json.loaded[0];
    const roll = await s.call('POST', '/agent-ops/rollouts', { agentId: 'workup-planner', caseId: kase.id, attempts: 1, seed: 0 }, res);
    assert.equal(roll.status, 201, roll.text);
    assert.equal((await s.store.head('Patient')).length, 0, 'the run leaves the live record without patients');
    const where = await everyBranchPatients(s);
    const branches = Object.keys(where); assert.equal(branches.length, 1, JSON.stringify(where)); assert.notEqual(branches[0], 'main');
    const [p] = await s.store.query('Patient', {}, { branch: branches[0] });
    assert.match(p.name[0].family, /^Patient S\d{6}$/, 'known by its number'); assert.equal(p.name[0].given, undefined);
    assert.equal((await s.store.query('Condition', { patient: `Patient/${p.id}` }, { branch: branches[0] })).length, 1, 'the chart came with the patient');
    assert.equal((await s.store.query('Condition', {})).length, 0, 'none of the chart is on the live record');
    // A run on the live record cannot carry a scenario patient.
    const { createRun } = await import('../agent-operations/server/runs.mjs');
    await assert.rejects(() => createRun(s.store, { mode: 'live', agentId: 'workup-planner', branch: 'main', plant: [{ resourceType: 'Patient', id: 'x1' }] }, { kind: 'human', id: 'res-one', role: 'researcher' }), /never written to the live record|.+/);
    assert.equal((await s.store.head('Patient')).length, 0);
  } finally { await s.close(); if (before === undefined) delete process.env.SCENARIOS_DIR; else process.env.SCENARIOS_DIR = before; }
});
