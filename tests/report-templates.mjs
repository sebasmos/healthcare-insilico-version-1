// Reporting workspace rules (plan-master task 3C): the critical-finding rule and
// unfilled template fields are enforced at sign time on the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, patient, BACKEND } from './support/helpers.mjs';
import { templateFor, unfilled, fieldAfter, parseCommand, deleteLastSentence, criticalIssue, findMacro, STARTER_MACROS, CRITICAL_URL, CRITICAL_TOLD_URL } from '../pacs/server/report-templates.mjs';

test('templates, fields, macros and commands', () => {
  assert.equal(templateFor({ description: 'CT Abdomen Pelvis with contrast', modality: 'CT' }).id, 'ct-abdo');
  assert.equal(templateFor({ description: 'XR Chest 2 views', modality: 'DX' }).id, 'cxr');
  assert.equal(templateFor({ description: 'Bone scan', modality: 'NM' }), null);
  assert.deepEqual(unfilled({ technique: 'PA view. [Comparison: none / date]', findings: 'Clear.', impression: '[Impression]' }).map((f) => f.field), ['[Comparison: none / date]', '[Impression]']);
  assert.deepEqual(fieldAfter('a [one] b [two]', 0), { start: 2, end: 7 });
  assert.deepEqual(fieldAfter('a [one] b [two]', 7), { start: 10, end: 15 });
  assert.deepEqual(fieldAfter('a [one] b [two]', 15), { start: 2, end: 7 }, 'wraps around');
  assert.deepEqual(fieldAfter('a [one] b [two]', 10, { backwards: true }), { start: 2, end: 7 });
  assert.equal(findMacro(STARTER_MACROS, 'No-PE').name, 'no pe');
  assert.deepEqual(parseCommand('Insert normal chest.'), { kind: 'insert', arg: 'normal chest' });
  assert.deepEqual([parseCommand('next field').kind, parseCommand('previous field').kind, parseCommand('delete last sentence').kind, parseCommand('sign report').kind, parseCommand('save draft').kind, parseCommand('hello')], ['next', 'previous', 'delete-sentence', 'sign', 'save', null]);
  assert.equal(deleteLastSentence('One. Two! Three?'), 'One. Two!');
  assert.equal(deleteLastSentence('Only one sentence.'), '');
  assert.match(criticalIssue({ extension: [{ url: CRITICAL_URL, valueBoolean: true }] }), /who was told, how and when/);
  assert.equal(criticalIssue({ extension: [{ url: CRITICAL_URL, valueBoolean: true }, { url: CRITICAL_TOLD_URL, valueString: JSON.stringify({ to: 'Dr One', how: 'phone', at: '2026-01-01T10:00:00Z' }) }] }), null);
  assert.equal(criticalIssue({}), null);
});

test(`[${BACKEND}] signing: unfilled template fields and an undocumented critical finding are refused; a documented one signs and raises a STAT Inbox alert`, async () => {
  const s = await startTestServer();
  const rad = { 'X-Role': 'physician', 'X-User-Id': 'dr-reader' };
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Crit'))).json;
  const study = (await s.call('POST', '/fhir/R4/ImagingStudy', { resourceType: 'ImagingStudy', status: 'available', subject: { reference: `Patient/${p.id}` }, started: '2026-01-10T08:00:00Z', description: 'CT Head', modality: [{ system: 'http://dicom.nema.org/resources/ontology/DCM', code: 'CT' }], referrer: { display: 'Dr One' }, numberOfSeries: 1, numberOfInstances: 1, identifier: [{ system: 'urn:dicom:uid', value: 'urn:oid:1.2.3.4.5' }], series: [{ uid: '1.2.3.4.5.1', number: 1, modality: { system: 'http://dicom.nema.org/resources/ontology/DCM', code: 'CT' } }] }, rad)).json;
  assert.ok(study.id, JSON.stringify(study).slice(0, 200));
  const report = (extra = {}) => ({ resourceType: 'DiagnosticReport', status: 'preliminary', subject: { reference: `Patient/${p.id}` }, code: { text: 'CT Head' }, imagingStudy: [{ reference: `ImagingStudy/${study.id}` }], conclusion: 'Acute subdural haematoma with midline shift.', extension: [{ url: 'urn:hospital-desktop:report-technique', valueString: 'Non-contrast CT head.' }, { url: 'urn:hospital-desktop:report-findings', valueString: 'Left subdural collection. [Midline: no shift]' }, ...(extra.extension || [])] });
  const made = (await s.call('POST', '/fhir/R4/DiagnosticReport', report(), rad)).json;
  const sign = () => s.call('POST', `/fhir/R4/DiagnosticReport/${made.id}/$transition`, { to: 'final' }, rad);
  let r = await sign(); assert.equal(r.status, 422); assert.match(r.text, /Fill or remove the template fields/);
  let cur = (await s.call('PUT', `/fhir/R4/DiagnosticReport/${made.id}`, { ...made, extension: [{ url: 'urn:hospital-desktop:report-technique', valueString: 'Non-contrast CT head.' }, { url: 'urn:hospital-desktop:report-findings', valueString: 'Left subdural collection with 8 mm midline shift.' }, { url: CRITICAL_URL, valueBoolean: true }] }, rad)).json;
  r = await sign(); assert.equal(r.status, 422); assert.match(r.text, /who was told, how and when/);
  cur = (await s.call('PUT', `/fhir/R4/DiagnosticReport/${made.id}`, { ...cur, extension: [...cur.extension, { url: CRITICAL_TOLD_URL, valueString: JSON.stringify({ to: 'Dr One', how: 'phone, read back', at: '2026-01-10T08:30:00Z', by: 'dr-reader' }) }] }, rad)).json;
  r = await sign(); assert.equal(r.status, 200, r.text);
  const tasks = (await s.call('GET', `/fhir/R4/Task?patient=${p.id}`)).json.entry.map((e) => e.resource);
  const alert = tasks.find((t) => t.code?.coding?.[0]?.code === 'critical-report');
  assert.ok(alert, 'a critical alert task');
  assert.deepEqual([alert.priority, alert.owner.display], ['stat', 'Dr One']);
  assert.match(alert.description, /told Dr One by phone, read back/);
  assert.ok(tasks.some((t) => t.code?.coding?.[0]?.code === 'report-signed'), 'the ordinary notice too');
  const steps = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps;
  assert.ok(steps.some((x) => x.did?.type === 'system.derive' && x.did?.args?.id === alert.id), 'the alert is a logged system write (its AuditEvent carries who was told, how and when)');
  await s.close();
});
