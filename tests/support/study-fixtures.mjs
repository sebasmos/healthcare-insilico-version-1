// Small nameless fixtures for study tests, built at run time: one patient, a few tasks, a task set, some people.
import assert from 'node:assert/strict';
import { patient } from './helpers.mjs';

export const res = { 'X-Role': 'researcher', 'X-User-Id': 'res-one' };
export const as = (person, role = 'physician') => ({ 'X-Role': role, 'X-User-Id': person.id });

export async function makeTasks(s, n = 3, { split = 'eval', rubric = [{ label: 'Reasoning is sound' }] } = {}) {
  const p = (await s.call('POST', '/fhir/R4/Patient', patient())).json;
  const codes = ['LOINC:2160-0', 'LOINC:2823-3', 'LOINC:718-7', 'LOINC:2951-2', 'LOINC:1975-2', 'LOINC:6690-2'];
  const tasks = [];
  for (let i = 0; i < n; i += 1) {
    const r = await s.call('POST', '/agent-ops/cases', { patient: `Patient/${p.id}`, title: `Task ${i + 1}`, scenario: `Situation ${i + 1}.`, task: `Decide what to order (${i + 1}).`, split, rubric, goldActions: [{ type: 'order', code: codes[i % codes.length], label: `Test ${i + 1}` }] }, res);
    assert.equal(r.status, 201, r.text); tasks.push(r.json);
  }
  const set = await s.call('POST', '/agent-ops/task-sets', { name: `Set ${Math.random().toString(36).slice(2, 8)}`, tasks: tasks.map((t) => ({ taskId: t.id })) }, res);
  assert.equal(set.status, 201, set.text);
  return { patient: p, tasks, set: set.json };
}
export async function makePeople(s, n = 2, role = 'physician') {
  const out = [];
  for (let i = 0; i < n; i += 1) { const tag = Math.random().toString(36).slice(2, 8); const r = await s.call('POST', '/agent-ops/people', { name: `Reader ${i + 1}`, email: `reader-${tag}@example.test`, role, specialty: 'medicine', seniority: 'senior', credentialed: true }, res); assert.equal(r.status, 201, r.text); out.push(r.json.person); }
  return out;
}

/** n imaging studies to report, each a task about that study, in one task set (for agents that propose reports). */
export async function makeReportTasks(s, n = 3) {
  const p = (await s.call('POST', '/fhir/R4/Patient', patient())).json; const tasks = [];
  for (let i = 0; i < n; i += 1) {
    const img = (await s.call('POST', '/fhir/R4/ImagingStudy', { resourceType: 'ImagingStudy', status: 'available', subject: { reference: `Patient/${p.id}` }, started: `2026-01-01T08:0${i}:00Z`, description: 'Chest X-ray', modality: [{ system: 'http://dicom.nema.org/resources/ontology/DCM', code: 'DX' }], reasonCode: [{ text: 'Cough' }], numberOfSeries: 1, numberOfInstances: 2 }, { 'X-Role': 'nurse', 'X-User-Id': 'tech-one' })).json;
    const r = await s.call('POST', '/agent-ops/cases', { patient: `Patient/${p.id}`, subject: `ImagingStudy/${img.id}`, title: `Film ${i + 1}`, scenario: 'A chest film to report.', task: 'Check the draft report.', split: 'eval', goldActions: [{ type: 'order', code: 'LOINC:2160-0', label: 'none' }] }, res);
    assert.equal(r.status, 201, r.text); tasks.push(r.json);
  }
  const set = (await s.call('POST', '/agent-ops/task-sets', { name: `Films ${Math.random().toString(36).slice(2, 8)}`, tasks: tasks.map((t) => ({ taskId: t.id })) }, res)).json;
  return { patient: p, tasks, set };
}
