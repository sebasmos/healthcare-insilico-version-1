// Shared set-up for the agent tests: studies, clinician reads, shadow cases
// and a stand-in for a red-team result (the red-team runner arrives in phase 6).
import assert from 'node:assert/strict';
import { startTestServer, testClock, patient } from './helpers.mjs';

export const rad = { 'X-Role': 'physician', 'X-User-Id': 'dr-reader' };
const T = 'urn:hospital-desktop:report-technique';
const F = 'urn:hospital-desktop:report-findings';

export async function agentSetup(options = {}) {
  const clock = testClock('2026-05-01T09:00:00.000Z');
  const s = await startTestServer({ clock, ...options });
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Agentcase'))).json;
  let n = 0;
  const study = async (reason = 'Cough') => {
    n += 1;
    return (await s.call('POST', '/fhir/R4/ImagingStudy', {
      resourceType: 'ImagingStudy', status: 'available', subject: { reference: `Patient/${p.id}` }, started: `2026-05-01T08:${String(n).padStart(2, '0')}:00Z`, description: 'Chest X-ray',
      modality: [{ system: 'http://dicom.nema.org/resources/ontology/DCM', code: 'DX' }], reasonCode: [{ text: reason }], numberOfSeries: 1, numberOfInstances: 2,
    }, { 'X-Role': 'nurse', 'X-User-Id': 'tech-one' })).json;
  };
  const open = async (st) => { assert.equal((await s.call('POST', `/api/pacs/studies/${st.id}/open`, {}, rad)).status, 200); await s.agents.idle(); };
  const read = async (st, impression) => {
    clock.advance(1000);
    const draft = (await s.call('POST', '/fhir/R4/DiagnosticReport', { resourceType: 'DiagnosticReport', status: 'preliminary', code: { text: 'Chest X-ray' }, subject: { reference: `Patient/${p.id}` }, imagingStudy: [{ reference: `ImagingStudy/${st.id}` }], conclusion: impression, extension: [{ url: T, valueString: 'PA and lateral' }, { url: F, valueString: 'As below' }] }, rad)).json;
    clock.advance(60_000);
    const signed = await s.call('POST', `/fhir/R4/DiagnosticReport/${draft.id}/$transition`, { to: 'final' }, rad);
    assert.equal(signed.status, 200, signed.text);
    return signed.json;
  };
  /** One compared shadow case for the Report Drafter. agree=false makes the clinician disagree with it. */
  const shadowCase = async (agree = true) => { const st = await study('Cough'); await open(st); await read(st, agree ? 'No acute abnormality.' : 'Right lower lobe pneumonia.'); };
  const message = async (text) => {
    const r = await s.call('POST', '/fhir/R4/Communication', { resourceType: 'Communication', status: 'completed', subject: { reference: `Patient/${p.id}` }, sender: { reference: `Patient/${p.id}` }, sent: clock.now(), topic: { text: 'Question' }, payload: [{ contentString: text }] }, { 'X-Role': 'patient', 'X-User-Id': `Patient/${p.id}` });
    assert.equal(r.status, 201);
    await s.agents.idle();
    return r.json;
  };
  /** Writes a red-team suite result directly, so gate tests do not depend on the runner. */
  const redTeam = async (agentId, version, passed) => {
    clock.advance(1000);
    return s.store.save('Run', { resourceType: 'Run', id: `redteam-${agentId}-${Date.parse(clock.now())}`, umbrella: 'redteam', mode: 'redteam', agentId, version, branch: 'main', overlays: [], friction: 'realistic', startedAt: clock.now(), endedAt: clock.now(), endReason: 'completed', result: { kind: 'suite', complete: true, passed, total: 1, failed: passed ? 0 : 1, scenarios: [] } }, { updatedBy: 'test' });
  };
  const gate = (minAgreement, minCases) => s.call('PUT', '/agent-ops/gate', { minAgreement, minCases });
  const promoteDrafter = async () => {
    await gate(0.5, 1);
    await shadowCase(true);
    await redTeam('report-drafter', '1.2.0', true);
    const r = await s.call('POST', '/agent-ops/agents/report-drafter/promote', {});
    assert.equal(r.status, 200, r.text);
  };
  const proposals = async (branch, query = '') => (await s.call('GET', `/agent-ops/proposals?_branch=${branch}${query}`)).json.proposals;
  const decide = (branch, id, body, headers = rad) => s.call('POST', `/agent-ops/proposals/${id}/decide?_branch=${branch}`, body, headers);
  const steps = async (runId) => (await s.call('GET', `/agent-ops/trace?runId=${runId}`)).json.steps;
  return { s, p, clock, study, open, read, shadowCase, message, redTeam, gate, promoteDrafter, proposals, decide, steps };
}
