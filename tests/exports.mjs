// Training exports (§9d): manifest, history window, eval-split exclusion,
// de-identification and logging.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKEND, startTestServer } from './support/helpers.mjs';
import { deidentify } from '../agent-operations/server/episodes.mjs';

const lines = (r) => r.text.trim().split('\n').map((l) => JSON.parse(l));
async function setup() {
  const s = await startTestServer();
  const loaded = (await s.call('POST', '/agent-ops/cases/load', {})).json.loaded;
  const id = (slug) => loaded.find((c) => c.slug === slug).id;
  for (const slug of ['sepsis-bundle', 'upper-gi-bleed', 'hyperkalaemia', 'chest-pain-risk']) {
    const r = await s.call('POST', '/agent-ops/rollouts', { agentId: 'workup-planner', caseId: id(slug), attempts: 5, seed: 0 });
    assert.equal(r.status, 201, r.text);
  }
  const get = (path) => s.call('GET', `/agent-ops/${path}`);
  return { s, loaded, id, get, evalIds: [id('hyperkalaemia'), id('chest-pain-risk')], trainIds: [id('sepsis-bundle'), id('upper-gi-bleed')] };
}

test('de-identification removes direct identifiers and keeps the clinical content', () => {
  const removed = {};
  const p = deidentify({ resourceType: 'Patient', id: 'p1', name: [{ family: 'Real' }], identifier: [{ value: 'N1' }], telecom: [{ value: '555' }], address: [{ city: 'X' }], birthDate: '1960-05-04', gender: 'female', meta: { versionId: '2' } }, removed);
  assert.deepEqual(p, { resourceType: 'Patient', id: 'p1', gender: 'female', birthYear: '1960' });
  assert.deepEqual(removed, { name: 1, identifier: 1, telecom: 1, address: 1, meta: 1, birthDate: 1 });
  const o = deidentify({ resourceType: 'Observation', id: 'o1', code: { text: 'K' }, valueQuantity: { value: 6.8 }, identifier: [{ value: 'keep' }], text: { div: 'x' }, performer: [{ display: 'Dr Name' }] });
  assert.deepEqual(o, { resourceType: 'Observation', id: 'o1', code: { text: 'K' }, valueQuantity: { value: 6.8 }, identifier: [{ value: 'keep' }], performer: [{}] });
});
