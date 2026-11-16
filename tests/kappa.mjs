// Agreement statistics, the blind double-read queue, adjudication and the
// de-identified export of a labelling project.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startTestServer, tempDir, patient, BACKEND } from './support/helpers.mjs';
import { cohenKappa, fleissKappa, interpretKappa, iou, matchBoxes } from '../data-annotation/server/kappa.mjs';
import { tokenLabels, deidentifyDicom } from '../data-annotation/server/annotation.mjs';
import { redactText } from '../platform/server/redact.mjs';
import { buildPhantom } from './support/phantom.mjs';
import { parse, pixels } from '../viewers/dicom/dicom.js';

const repeat = (pair, n) => Array.from({ length: n }, () => pair);
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const as = (id) => ({ 'X-Role': 'physician', 'X-User-Id': id });
const LABELS = [{ id: 'normal', label: 'Normal' }, { id: 'abnormal', label: 'Abnormal' }];

test('Cohen kappa matches the textbook 2x2 example (0.40)', () => {
  const pairs = [...repeat(['yes', 'yes'], 20), ...repeat(['yes', 'no'], 5), ...repeat(['no', 'yes'], 10), ...repeat(['no', 'no'], 15)];
  const k = cohenKappa(pairs);
  assert.equal(k.kappa, 0.4);
  assert.equal(k.observed, 0.7);
  assert.equal(k.expected, 0.5);
  assert.equal(k.n, 50);
});

test('Cohen kappa edge cases: perfect, chance, worse than chance, one category, empty', () => {
  assert.equal(cohenKappa([['a', 'a'], ['b', 'b'], ['a', 'a']]).kappa, 1);
  assert.equal(cohenKappa([['y', 'y'], ['y', 'n'], ['n', 'y'], ['n', 'n']]).kappa, 0);
  assert.equal(cohenKappa([['y', 'n'], ['n', 'y']]).kappa, -1);
  assert.equal(cohenKappa([['a', 'a'], ['a', 'a']]).kappa, null, 'undefined when chance agreement is already 1');
  assert.equal(cohenKappa([]).kappa, null);
  assert.equal(interpretKappa(0.4), 'fair');
  assert.equal(interpretKappa(0.61), 'substantial');
  assert.equal(interpretKappa(null), 'not defined');
});

test('Fleiss kappa matches the published 10-subject, 14-rater example (0.210)', () => {
  const table = [[0, 0, 0, 0, 14], [0, 2, 6, 4, 2], [0, 0, 3, 5, 6], [0, 3, 9, 2, 0], [2, 2, 8, 1, 1], [7, 7, 0, 0, 0], [3, 2, 6, 3, 0], [2, 5, 3, 2, 2], [6, 5, 2, 1, 0], [0, 2, 2, 3, 7]];
  const rows = table.map((counts) => counts.flatMap((n, category) => Array.from({ length: n }, () => `c${category}`)));
  const k = fleissKappa(rows);
  assert.equal(Math.round(k.kappa * 1000) / 1000, 0.21);
  assert.equal(k.raters, 14);
  assert.equal(k.n, 10);
  assert.equal(fleissKappa([['a', 'a', 'a'], ['b', 'b', 'b']]).kappa, 1);
  assert.equal(fleissKappa([['a', 'a', 'a'], ['a', 'a', 'a']]).kappa, null);
  assert.throws(() => fleissKappa([['a', 'b'], ['a']]), /same number of ratings/);
});

test('Box overlap, box matching and token labels behave as documented', () => {
  const box = (x, y, width, height, label = 'f') => ({ x, y, width, height, label });
  assert.equal(iou(box(0, 0, 10, 10), box(0, 0, 10, 10)), 1);
  assert.equal(iou(box(0, 0, 10, 10), box(20, 20, 5, 5)), 0);
  assert.equal(Math.round(iou(box(0, 0, 10, 10), box(5, 0, 10, 10)) * 1000), 333);
  assert.equal(matchBoxes([box(0, 0, 10, 10)], [box(1, 1, 10, 10)]).f1, 1);
  assert.equal(matchBoxes([box(0, 0, 10, 10)], [box(1, 1, 10, 10, 'other')]).f1, 0, 'a different label is not a match');
  assert.equal(matchBoxes([box(0, 0, 10, 10), box(50, 50, 10, 10)], [box(0, 0, 10, 10)]).f1, 2 / 3);
  assert.equal(matchBoxes([], []).f1, 1);
  assert.deepEqual(tokenLabels('no acute pneumonia seen', [{ label: 'neg', start: 0, end: 18 }]), ['neg', 'neg', 'neg', 'none']);
});

test('Redaction masks names, record numbers, dates, phones and e-mail, and can keep offsets', () => {
  const text = 'Mrs Examplefamily (N123456) seen 2026-03-04, call 555-123-4567 or a.b@example.org';
  const plain = redactText(text, { names: ['Examplefamily'] });
  assert.equal(plain.count, 5);
  assert.doesNotMatch(plain.text, /Examplefamily|N123456|2026-03-04|555-123|example\.org/);
  const same = redactText(text, { names: ['Examplefamily'], sameLength: true });
  assert.equal(same.text.length, text.length);
  assert.equal(same.text.indexOf('seen'), text.indexOf('seen'));
});

async function notesProject(options = {}) {
  const s = await startTestServer();
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Examplefamily'))).json;
  const texts = options.texts ?? ['Chest clear.', 'Right lower lobe consolidation.', 'No acute findings.', 'Large effusion on the left.', 'Normal study.', 'Cardiomegaly, stable.'];
  for (const [i, text] of texts.entries()) {
    const r = await s.call('POST', '/fhir/R4/DocumentReference', {
      resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', subject: { reference: `Patient/${p.id}` }, date: `2026-01-0${i + 1}T10:00:00.000Z`,
      type: { coding: [{ system: 'http://loinc.org', code: '11506-3', display: 'Progress note' }] }, content: [{ attachment: { contentType: 'text/plain', data: b64(text) } }],
    });
    assert.equal(r.status, 201, r.text);
  }
  const made = await s.call('POST', '/agent-ops/annotation/projects', {
    name: options.name ?? 'Note triage', taskType: options.taskType ?? 'classification', labels: options.labels ?? LABELS, annotatorsPerItem: options.readers ?? 2,
    sampling: { resourceType: 'DocumentReference', limit: options.limit ?? 6, seed: 7 },
  }, as('lead'));
  assert.equal(made.status, 201, made.text);
  const base = `/agent-ops/annotation/projects/${made.json.id}`;
  const next = async (who) => (await s.call('GET', `${base}/next`, undefined, as(who))).json;
  // Labels every item still open for this reader; answer(item) returns the request body.
  const readAll = async (who, answer) => {
    const done = [];
    for (;;) {
      const n = await next(who);
      if (!n.item) return done;
      const r = await s.call('POST', `${base}/items/${n.item.id}/labels`, answer(n.item), as(who));
      assert.equal(r.status, 201, r.text);
      done.push(n.item.id);
    }
  };
  return { s, p, project: made.json, base, next, readAll, texts };
}

test(`[${BACKEND}] A project freezes its sample, and the queue is a blind double-read`, async () => {
  const { s, p, project, base, next, readAll } = await notesProject();
  try {
    assert.equal(project.progress.items, 6);
    assert.equal(project.progress.readsNeeded, 12);
    assert.equal(project.agreement.kappa, null);

    const first = await next('ann');
    assert.equal(first.annotator, 'ann');
    assert.equal(first.item.content.kind, 'text');
    assert.ok(first.item.content.text.length > 0);
    const again = await next('ann');
    assert.equal(again.item.id, first.item.id, 'the queue is deterministic until the reader answers');

    assert.equal((await s.call('POST', `${base}/items/${first.item.id}/labels`, { label: 'maybe' }, as('ann'))).status, 422);
    const saved = await s.call('POST', `${base}/items/${first.item.id}/labels`, { label: 'normal', seconds: 4.2 }, as('ann'));
    assert.equal(saved.status, 201);
    assert.notEqual(saved.json.next.item.id, first.item.id);
    assert.equal((await s.call('POST', `${base}/items/${first.item.id}/labels`, { label: 'abnormal' }, as('ann'))).status, 409, 'one read per reader per item');

    // The second reader gets the same item, with no trace of the first reader's answer.
    const blind = await s.call('GET', `${base}/next`, undefined, as('ben'));
    assert.equal(blind.json.item.id, first.item.id);
    assert.doesNotMatch(blind.text, /"ann"|normal"\s*,\s*"seconds|"label":"normal"/);
    assert.equal((await s.call('POST', `${base}/items/${first.item.id}/labels`, { label: 'normal' }, as('ben'))).status, 201);
    assert.equal((await s.call('POST', `${base}/items/${first.item.id}/labels`, { label: 'normal' }, as('cat'))).status, 409, 'a third read is refused');

    // A note written after the project was created is not added to its frozen sample.
    await readAll('ann', () => ({ label: 'normal' }));
    assert.equal((await next('ann')).item, null);
    const late = await s.call('POST', '/fhir/R4/DocumentReference', { resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', subject: { reference: `Patient/${p.id}` }, type: { coding: [{ system: 'http://loinc.org', code: '11506-3' }] }, content: [{ attachment: { contentType: 'text/plain', data: b64('Written later.') } }] });
    assert.equal(late.status, 201);
    assert.equal((await s.call('GET', base)).json.progress.items, 6);
    assert.equal((await next('ann')).item, null);

    // An agent cannot label.
    const agentRun = (await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'report-drafter' })).json;
    const refused = await s.call('GET', `${base}/next`, undefined, { 'X-Agent-Id': 'report-drafter', 'X-Run-Id': agentRun.id });
    assert.equal(refused.status, 403);
  } finally { await s.close(); }
});

test(`[${BACKEND}] Labels are annotation Observations, logged under the project's run`, async () => {
  const { s, p, project, readAll } = await notesProject({ limit: 2, texts: ['One.', 'Two.'] });
  try {
    await readAll('ann', () => ({ label: 'abnormal', comment: 'looks off' }));
    const found = (await s.call('GET', '/fhir/R4/Observation?category=annotation')).json.entry.map((e) => e.resource);
    assert.equal(found.length, 2);
    const o = found[0];
    assert.equal(o.status, 'final');
    assert.equal(o.code.coding[0].code, project.id);
    assert.equal(o.valueCodeableConcept.coding[0].code, 'abnormal');
    assert.equal(o.subject.reference, `Patient/${p.id}`);
    assert.match(o.focus[0].reference, /^DocumentReference\//);
    assert.equal(o.performer[0].identifier.value, 'ann');
    const lab = (await s.call('GET', `/fhir/R4/Observation?patient=${p.id}&category=laboratory`)).json.entry || [];
    assert.equal(lab.length, 0, 'annotations never appear among lab results');
    // An agent never sees human labels: not by search, not by id, not in the patient bundle.
    const agentRun = (await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'report-drafter' })).json;
    const agent = { 'X-Agent-Id': 'report-drafter', 'X-Run-Id': agentRun.id };
    assert.equal(((await s.call('GET', '/fhir/R4/Observation?category=annotation', undefined, agent)).json.entry || []).length, 0);
    assert.equal((await s.call('GET', `/fhir/R4/Observation/${o.id}`, undefined, agent)).status, 404);
    const bundle = (await s.call('GET', `/fhir/R4/Patient/${p.id}/$everything`, undefined, agent)).json.entry.map((e) => e.resource);
    assert.ok(bundle.some((r) => r.resourceType === 'DocumentReference'));
    assert.ok(!bundle.some((r) => r.resourceType === 'Observation'));
    const steps = (await s.call('GET', `/agent-ops/trace?runId=${project.runId}`)).json.steps;
    assert.equal(steps.filter((x) => x.did.type === 'annotation.label').length, 2);
    assert.ok(steps.every((x) => x.who.kind === 'human'));
    assert.equal((await s.call('GET', `/agent-ops/runs/${project.runId}`)).json.mode, 'label');
  } finally { await s.close(); }
});

test(`[${BACKEND}] Cohen kappa is live, and low agreement sends disagreements to adjudication`, async () => {
  const { s, base, readAll } = await notesProject();
  try {
    const order = await readAll('ann', () => ({ label: 'normal' }));
    // ben agrees on the first three items only.
    await readAll('ben', (item) => ({ label: order.indexOf(item.id) < 3 ? 'normal' : 'abnormal' }));
    let o = (await s.call('GET', base)).json;
    assert.equal(o.agreement.statistic, 'cohen');
    assert.equal(o.agreement.n, 6);
    assert.equal(o.agreement.kappa, 0, 'one reader said the same thing every time: no better than chance');
    assert.equal(o.adjudication.required, true);
    assert.equal(o.adjudication.waiting, 3);
    assert.equal(o.resolved, 3);

    // A reader cannot settle an item they read.
    const mine = (await s.call('GET', `${base}/adjudication`, undefined, as('ann'))).json;
    assert.equal(mine.item, null);
    assert.equal(mine.hiddenBecauseYouReadThem, 3);
    assert.equal((await s.call('POST', `${base}/items/${order[3]}/adjudicate`, { label: 'abnormal' }, as('ann'))).status, 403);

    const queue = (await s.call('GET', `${base}/adjudication`, undefined, as('cat'))).json;
    assert.equal(queue.forYou, 3);
    assert.deepEqual(queue.item.reads.map((r) => r.reader), ['Reader A', 'Reader B']);
    assert.deepEqual(queue.item.reads.map((r) => r.label).sort(), ['abnormal', 'normal']);
    assert.doesNotMatch(JSON.stringify(queue.item.reads), /ann|ben/, 'readers are not named to the adjudicator');
    assert.equal((await s.call('POST', `${base}/items/${order[0]}/adjudicate`, { label: 'normal' }, as('cat'))).status, 409, 'an agreed item is not up for adjudication');
    for (const id of order.slice(3)) assert.equal((await s.call('POST', `${base}/items/${id}/adjudicate`, { label: 'abnormal' }, as('cat'))).status, 201);
    assert.equal((await s.call('POST', `${base}/items/${order[3]}/adjudicate`, { label: 'normal' }, as('dee'))).status, 409, 'settled once');
    o = (await s.call('GET', base)).json;
    assert.equal(o.adjudication.waiting, 0);
    assert.equal(o.adjudication.done, 3);
    assert.equal(o.resolved, 6);
    assert.equal(o.agreement.kappa, 0, 'adjudication does not change the measured agreement');
  } finally { await s.close(); }
});

test(`[${BACKEND}] Good agreement: kappa is above the threshold and only the real disagreement waits`, async () => {
  const { s, base, readAll } = await notesProject();
  try {
    // ann alternates normal / abnormal; ben matches her except on the last item.
    const order = await readAll('ann', (item) => ({ label: Number(item.id.slice(3)) % 2 ? 'normal' : 'abnormal' }));
    const last = order.at(-1);
    await readAll('ben', (item) => ({ label: item.id === last ? (Number(item.id.slice(3)) % 2 ? 'abnormal' : 'normal') : (Number(item.id.slice(3)) % 2 ? 'normal' : 'abnormal') }));
    const o = (await s.call('GET', base)).json;
    assert.equal(o.agreement.observed, 0.8333);
    assert.equal(o.agreement.expected, 0.5);
    assert.equal(o.agreement.kappa, 0.6667);
    assert.equal(o.agreement.reading, 'substantial');
    assert.equal(o.adjudication.required, false);
    assert.equal(o.adjudication.waiting, 1, 'two readers cannot outvote each other, so the one disagreement still needs a third person');
    assert.equal(o.resolved, 5);
  } finally { await s.close(); }
});

test(`[${BACKEND}] Three readers: Fleiss kappa; a majority settles items only when agreement is at or above 0.6`, async () => {
  const low = await notesProject({ readers: 3 });
  try {
    const { s, base, readAll } = low;
    const order = await readAll('ann', () => ({ label: 'normal' }));
    const truth = (item) => (order.indexOf(item.id) < 3 ? 'normal' : 'abnormal');
    await readAll('ben', (item) => ({ label: truth(item) }));
    await readAll('cat', (item) => ({ label: order.indexOf(item.id) === 0 ? 'abnormal' : truth(item) }));
    const o = (await s.call('GET', base)).json;
    assert.equal(o.agreement.statistic, 'fleiss');
    assert.equal(o.agreement.raters, 3);
    assert.equal(o.agreement.n, 6);
    // Item 0: N,N,A. Items 1-2: N,N,N. Items 3-5: N,A,A. So P_i = 1/3, 1, 1, 1/3, 1/3, 1/3 and 11 of 18 ratings are "normal".
    const pbar = (4 * (1 / 3) + 2) / 6;
    const pe = (11 / 18) ** 2 + (7 / 18) ** 2;
    assert.equal(o.agreement.kappa, Math.round(((pbar - pe) / (1 - pe)) * 10000) / 10000);
    assert.ok(o.agreement.kappa < 0.6);
    assert.equal(o.adjudication.required, true);
    assert.equal(o.adjudication.waiting, 4, 'below the threshold a majority is not enough');
  } finally { await low.s.close(); }

  const high = await notesProject({ readers: 3 });
  try {
    const { s, base, readAll } = high;
    const truth = (item) => (Number(item.id.slice(3)) % 2 ? 'normal' : 'abnormal');
    const order = await readAll('ann', (item) => ({ label: truth(item) }));
    await readAll('ben', (item) => ({ label: truth(item) }));
    await readAll('cat', (item) => ({ label: item.id === order[0] ? 'abnormal' : truth(item) }));
    const o = (await s.call('GET', base)).json;
    assert.ok(o.agreement.kappa >= 0.6, `kappa ${o.agreement.kappa}`);
    assert.equal(o.adjudication.required, false);
    assert.equal(o.adjudication.waiting, 0, 'two of three readers agree, so the majority label stands');
    assert.equal(o.resolved, 6);
    const lines = (await s.call('GET', `${base}/export.jsonl`, undefined, as('lead'))).text.trim().split('\n').map((l) => JSON.parse(l));
    const split = lines.find((l) => l.item === order[0]);
    assert.equal(split.final.source, 'majority');
    assert.equal(split.final.label, 'normal');
    assert.equal(lines.filter((l) => l.final?.source === 'consensus').length, 5);
  } finally { await high.s.close(); }
});

test(`[${BACKEND}] Span labels are compared word by word, and the export is de-identified`, async () => {
  const text = 'Mrs Examplefamily N123456 has no pneumonia. Plan: repeat film 2026-02-01.';
  const { s, p, base, next, texts } = await notesProject({ taskType: 'span', labels: [{ id: 'negated', label: 'Negated finding' }, { id: 'plan', label: 'Plan' }], limit: 1, texts: [text], name: 'Spans' });
  try {
    assert.equal(texts.length, 1);
    const item = (await next('ann')).item;
    assert.equal(item.content.text, text);
    const neg = { label: 'negated', start: text.indexOf('no'), end: text.indexOf('pneumonia.') + 'pneumonia.'.length };
    const plan = { label: 'plan', start: text.indexOf('repeat'), end: text.indexOf('film') + 4 };
    const post = (who, spans) => s.call('POST', `${base}/items/${item.id}/labels`, { spans }, as(who));
    assert.equal((await post('ann', [{ label: 'negated', start: 0, end: 5000 }])).status, 422, 'offsets must lie inside the text');
    assert.equal((await post('ann', [neg, { ...plan, start: neg.start + 1 }])).status, 422, 'spans must not overlap');
    assert.equal((await post('ann', [neg, plan])).status, 201);
    assert.equal((await post('ben', [neg])).status, 201);
    const o = (await s.call('GET', base)).json;
    assert.equal(o.agreement.unit, 'word');
    assert.equal(o.agreement.n, text.split(/\s+/).length);
    assert.equal(o.agreement.kappa, 0.5833, '8 of 10 words agree; 52% would by chance');
    assert.equal(o.adjudication.required, true);
    assert.equal(o.adjudication.waiting, 1, 'the two markings differ, so the item needs a final answer');
    assert.equal((await s.call('POST', `${base}/items/${item.id}/adjudicate`, { spans: [neg, plan] }, as('cat'))).status, 201);

    const out = await s.call('GET', `${base}/export.jsonl`, undefined, as('lead'));
    assert.equal(out.status, 200);
    assert.match(out.headers.get('content-type'), /ndjson/);
    const lines = out.text.trim().split('\n').map((l) => JSON.parse(l));
    const [manifest, line] = lines;
    assert.equal(manifest.manifest, true);
    assert.equal(manifest.items, 1);
    assert.equal(manifest.resolved, 1);
    assert.ok(manifest.deidentification.removed.textRedactions >= 3);
    assert.equal(manifest.deidentification.removed.annotatorNames, 2);
    assert.deepEqual(manifest.datasets, [], 'the register entries of the patients in the export (none imported here)');
    assert.doesNotMatch(out.text, /Examplefamily|N123456|2026-02-01/, 'no name, record number or date leaves in the export');
    assert.doesNotMatch(out.text, new RegExp(`${p.id}|"ann"|"ben"|"cat"`), 'no record id or annotator name either');
    assert.equal(line.source.text.length, text.length, 'masking keeps every offset in place');
    assert.equal(line.source.text.slice(neg.start, neg.end), 'no pneumonia.');
    assert.deepEqual(line.reads.map((r) => r.annotator), ['annotator-1', 'annotator-2']);
    assert.equal(line.final.source, 'adjudicated');
    assert.deepEqual(line.final.spans, [neg, plan]);
    const steps = (await s.call('GET', `/agent-ops/trace?runId=${o.runId}`)).json.steps;
    assert.equal(steps.filter((x) => x.did.type === 'annotation.export').length, 1, 'the export is logged');
    assert.equal((await s.call('GET', `${base}/export.coco.json`, undefined, as('lead'))).status, 422);
  } finally { await s.close(); }
});

test(`[${BACKEND}] Bounding boxes: COCO export and Basic Profile de-identified images`, async () => {
  process.env.DICOM_DIR = path.join(tempDir('hd-dicom-'), 'dicom');
  const s = await startTestServer();
  try {
    const p = (await s.call('POST', '/fhir/R4/Patient', patient('Imaging'))).json;
    const mrn = p.identifier.find((i) => i.type.coding[0].code === 'MR').value;
    const files = buildPhantom({ mrn, name: 'Imaging^Synthetic' });
    const boundary = 'b-123';
    const body = Buffer.concat([...files.flatMap((f) => [Buffer.from(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`), Buffer.from(f.bytes), Buffer.from('\r\n')]), Buffer.from(`--${boundary}--\r\n`)]);
    const up = await fetch(`${s.base}/dicom-web/studies`, { method: 'POST', headers: { 'Content-Type': `multipart/related; type="application/dicom"; boundary=${boundary}`, 'X-Role': 'physician' }, body });
    assert.equal(up.status, 200);

    const made = await s.call('POST', '/agent-ops/annotation/projects', { name: 'Boxes', taskType: 'bbox', labels: [{ id: 'finding', label: 'Finding' }], sampling: { resourceType: 'ImagingStudy', limit: 2, seed: 1 } }, as('lead'));
    assert.equal(made.status, 201, made.text);
    const base = `/agent-ops/annotation/projects/${made.json.id}`;
    const first = (await s.call('GET', `${base}/next`, undefined, as('ann'))).json.item;
    assert.equal(first.content.kind, 'image');
    const { rows, columns } = first.content.frame;
    assert.ok(rows > 0 && columns > 0);
    const box = { label: 'finding', x: 10, y: 12, width: 40, height: 30 };
    assert.equal((await s.call('POST', `${base}/items/${first.id}/labels`, { boxes: [{ ...box, width: columns * 2 }] }, as('ann'))).status, 422, 'a box must lie inside the image');
    for (const who of ['ann', 'ben']) {
      for (;;) {
        const n = (await s.call('GET', `${base}/next`, undefined, as(who))).json;
        if (!n.item) break;
        // ben's box on the first image is shifted a little (still a match); on the second image only ann draws one.
        const boxes = n.item.id === first.id ? [who === 'ann' ? box : { ...box, x: 12 }] : who === 'ann' ? [box] : [];
        assert.equal((await s.call('POST', `${base}/items/${n.item.id}/labels`, { boxes }, as(who))).status, 201);
      }
    }
    const o = (await s.call('GET', base)).json;
    assert.equal(o.progress.complete, 2);
    assert.equal(o.agreement.boxF1, 0.5);
    assert.equal(o.adjudication.waiting, 1);

    const coco = (await s.call('GET', `${base}/export.coco.json`, undefined, as('lead'))).json;
    assert.equal(coco.images.length, 2);
    assert.deepEqual(coco.categories, [{ id: 1, name: 'finding', supercategory: 'annotation' }]);
    assert.equal(coco.annotations.length, 1, 'only the agreed image has a final box');
    assert.deepEqual(coco.annotations[0].bbox, [10, 12, 40, 30]);
    assert.equal(coco.annotations[0].area, 1200);
    assert.equal(coco.reader_annotations.length, 3);
    assert.ok(coco.info.deidentification.removed.dicomTagsRemoved > 0);
    assert.doesNotMatch(JSON.stringify(coco), new RegExp(`${mrn}|Imaging\\^Synthetic|${first.content.frame.sopUid.replaceAll('.', '\\.')}`));

    const image = await fetch(`${s.base}${base}/images/${coco.images[0].file_name}`);
    assert.equal(image.status, 200);
    const bytes = new Uint8Array(await image.arrayBuffer());
    const file = parse(bytes);
    assert.equal(file.str('PatientID'), 'ANON');
    assert.equal(file.str('PatientName'), 'ANON');
    for (const gone of ['StudyDate', 'AccessionNumber', 'ReferringPhysicianName', 'StudyDescription', 'InstitutionName', 'PatientBirthDate']) assert.equal(file.str(gone), '', `${gone} is removed`);
    assert.match(file.str('SOPInstanceUID'), /^2\.25\.\d+$/);
    assert.notEqual(file.str('StudyInstanceUID'), first.content.frame.studyUid);
    assert.equal(pixels(file).rows, coco.images[0].height, 'the pixels still decode');
    assert.ok(!Buffer.from(bytes).includes(Buffer.from(mrn)), 'the record number is nowhere in the file');
    assert.equal((await fetch(`${s.base}${base}/images/nope.dcm`)).status, 404);

    // The same input always gives the same hashed identifiers.
    const again = deidentifyDicom(files[0].bytes, { salt: 'x' });
    assert.equal(again.sopUid, deidentifyDicom(files[0].bytes, { salt: 'x' }).sopUid);
    assert.notEqual(again.sopUid, deidentifyDicom(files[0].bytes, { salt: 'y' }).sopUid);
  } finally { await s.close(); }
});

test(`[${BACKEND}] Project input is validated`, async () => {
  const s = await startTestServer();
  try {
    const post = (body) => s.call('POST', '/agent-ops/annotation/projects', body, as('lead'));
    const ok = { name: 'x', taskType: 'classification', labels: LABELS, sampling: { resourceType: 'DocumentReference' } };
    assert.equal((await post({ ...ok, name: '' })).status, 422);
    assert.equal((await post({ ...ok, taskType: 'ranking' })).status, 422);
    assert.equal((await post({ ...ok, labels: [{ id: 'only' }] })).status, 422);
    assert.equal((await post({ ...ok, labels: [{ id: 'a' }, { id: 'a' }] })).status, 422);
    assert.equal((await post({ ...ok, labels: 'normal,abnormal' })).status, 422);
    assert.equal((await post({ ...ok, taskType: 'bbox', labels: [{ id: 'f' }] })).status, 422, 'boxes need imaging studies');
    assert.equal((await post({ ...ok, annotatorsPerItem: 9 })).status, 422);
    const empty = await post(ok);
    assert.equal(empty.status, 422);
    assert.match(empty.json.error, /matched nothing/);
    assert.equal((await s.call('GET', '/agent-ops/annotation/projects/none')).status, 404);
  } finally { await s.close(); }
});
