// Scribe benchmark: completeness, accuracy, hallucination and format scoring,
// the five seed cases, the reference scribe agent, human corrections and the
// export.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, tempDir, BACKEND } from './support/helpers.mjs';
import { scoreNote, tally, parseSections, formatCompliance, scribeLibrary } from '../agent-operations/server/scribe.mjs';

const SOAP = ['Subjective', 'Objective', 'Assessment', 'Plan'];
const GOLD = [
  { section: 'Subjective', code: 'SNOMED:29857009', label: 'chest pain', negated: true },
  { section: 'Assessment', code: 'ICD-10:J18.9', label: 'pneumonia', laterality: 'right' },
  { section: 'Plan', code: 'RxNorm:723', label: 'amoxicillin', dose: '500 mg' },
  { section: 'Plan', code: 'LOCAL:follow-up', label: 'follow-up in 4 weeks', terms: ['4 weeks'] },
];
const SOURCE = 'Clinician: Any chest pain? Patient: No chest pain. Clinician: This is a right lower lobe pneumonia. Start amoxicillin 500 mg three times a day. Come back in 4 weeks.';
const note = (s, o, a, p) => `Subjective:\n${s}\n\nObjective:\n${o}\n\nAssessment:\n${a}\n\nPlan:\n${p}\n`;
const score = (text, extra = {}) => tally(scoreNote({ note: text, goldElements: GOLD, sections: SOAP, source: SOURCE, ...extra }));
const status = (t) => Object.fromEntries(t.elements.map((e) => [e.label, e.status]));

test('a note that states every element correctly scores 100% with nothing unsupported', () => {
  const t = score(note('No chest pain.', 'Chest examined.', 'Right lower lobe pneumonia.', 'Amoxicillin 500 mg three times a day. Review in 4 weeks.'));
  assert.deepEqual(t.scores, { completeness: 1, accuracy: 1, hallucinations: 0, hallucinationRate: 0, format: 1 });
  assert.deepEqual(t.counts, { gold: 4, found: 4, correct: 4, partial: 0, wrong: 0, missing: 0, noteElements: 6 });
});

test('completeness counts gold elements that appear; a missing one lowers it, not accuracy', () => {
  const t = score(note('No chest pain.', 'Chest examined.', 'Right lower lobe pneumonia.', 'Review in 4 weeks.'));
  assert.equal(status(t).amoxicillin, 'missing');
  assert.equal(t.scores.completeness, 0.75);
  assert.equal(t.scores.accuracy, 1);
});

test('accuracy: wrong negation, wrong side and wrong dose are errors', () => {
  const t = score(note('Reports chest pain.', 'Chest examined.', 'Left lower lobe pneumonia.', 'Amoxicillin 250 mg three times a day. Review in 4 weeks.'));
  assert.deepEqual(status(t), { 'chest pain': 'wrong', pneumonia: 'wrong', amoxicillin: 'wrong', 'follow-up in 4 weeks': 'correct' });
  assert.match(t.elements[0].reason, /stated as present, but it was denied/);
  assert.match(t.elements[1].reason, /wrong side \(left instead of right\)/);
  assert.match(t.elements[2].reason, /wrong dose \(expected 500 mg\)/);
  assert.equal(t.scores.completeness, 1);
  assert.equal(t.scores.accuracy, 0.25);
});

test('negation is read inside the clause only, in both directions', () => {
  const gold = [{ section: 'Objective', code: 'x:1', label: 'weight down 4 kg', terms: ['4 kg'] }, { section: 'Objective', code: 'x:2', label: 'swelling', negated: true }];
  const text = note('Feels well.', 'Legs show no swelling and weight is down 4 kg.', 'Improving.', 'Home.');
  const t = tally(scoreNote({ note: text, goldElements: gold, sections: SOAP, source: 'no swelling, weight down 4 kg' }));
  assert.deepEqual(t.elements.map((e) => e.status), ['correct', 'correct']);
  const flipped = tally(scoreNote({ note: note('Feels well.', 'Legs show swelling.', 'Improving.', 'Home.'), goldElements: gold, sections: SOAP, source: 'no swelling' }));
  assert.equal(flipped.elements[1].status, 'wrong');
});

test('partial credit: right element in the wrong section, or a dose or side left out', () => {
  const t = score(note('No chest pain. Pneumonia on the film.', 'Chest examined.', 'Infection.', 'Amoxicillin three times a day. Review in 4 weeks.'));
  assert.equal(status(t).pneumonia, 'partial');
  assert.match(t.elements[1].reason, /side not stated; in the wrong section \(expected Assessment\)/);
  assert.equal(status(t).amoxicillin, 'partial');
  assert.match(t.elements[2].reason, /dose not stated/);
  assert.equal(t.scores.accuracy, 0.75, '(2 correct + 2 half) / 4 found');
});

test('hallucination: terms, attached codes and quantities with no support in the transcript or chart', () => {
  const text = note('No chest pain. Has diabetes.', 'Chest examined.', 'Right lower lobe pneumonia.', 'Amoxicillin 500 mg three times a day for 10 days. Review in 4 weeks.');
  const t = score(text, { coded: ['ICD-10:J18.9', 'ICD-10:E11.9'] });
  const unsupported = t.extras.filter((x) => !x.supported).map((x) => x.key).sort();
  assert.deepEqual(unsupported, ['code:ICD-10:E11.9', 'quantity:10day', 'term:diabetes']);
  assert.equal(t.scores.hallucinations, 3);
  assert.equal(t.scores.hallucinationRate, Math.round((3 / t.counts.noteElements) * 1000) / 1000);
  // The same statements are fine once the source supports them.
  const ok = tally(scoreNote({ note: text, coded: ['ICD-10:J18.9'], goldElements: GOLD, sections: SOAP, source: `${SOURCE} She has diabetes. Take it for 10 days.` }));
  assert.equal(ok.scores.hallucinations, 0);
  // A gold code attached to the note counts as found even if the text omits the word.
  const coded = score(note('No chest pain.', 'Chest examined.', 'Chest infection, right side.', 'Amoxicillin 500 mg. Review in 4 weeks.'), { coded: ['ICD-10:J18.9'] });
  assert.equal(status(coded).pneumonia, 'partial');
  assert.match(coded.elements[1].reason, /coded but not written/);
});

test('format compliance: required sections present and in order', () => {
  assert.deepEqual(parseSections('Subjective: fine\nPlan:\nrest', SOAP).map((s) => [s.name, s.text.trim()]), [['Subjective', 'fine'], ['Plan', 'rest']]);
  assert.equal(formatCompliance(note('a', 'b', 'c', 'd'), SOAP).score, 1);
  const missing = formatCompliance('Subjective:\na\n\nAssessment:\nc\n\nPlan:\nd\n', SOAP);
  assert.deepEqual([missing.missing, missing.ordered, missing.score], [['Objective'], true, 0.75]);
  const shuffled = formatCompliance('Plan:\nd\n\nSubjective:\na\n\nObjective:\nb\n\nAssessment:\nc\n', SOAP);
  assert.deepEqual([shuffled.missing, shuffled.ordered, shuffled.score], [[], false, 0.5]);
  assert.equal(formatCompliance('Subjective:\n\nObjective:\nb', SOAP).present.includes('Subjective'), false, 'an empty section does not count');
});

test('human corrections override the automatic match and move the scores', () => {
  const scored = scoreNote({ note: note('Reports chest pain.', 'x', 'Right lower lobe pneumonia.', 'Amoxicillin 500 mg. Review in 4 weeks. Has diabetes.'), goldElements: GOLD, sections: SOAP, source: SOURCE });
  const auto = tally(scored);
  assert.equal(auto.scores.accuracy, 0.75);
  assert.equal(auto.scores.hallucinations, 1);
  const fixed = tally(scored, { elements: { 0: 'correct' }, extras: { 'term:diabetes': 'supported' } });
  assert.equal(fixed.scores.accuracy, 1);
  assert.equal(fixed.scores.hallucinations, 0);
  assert.deepEqual([fixed.elements[0].corrected, fixed.elements[0].auto], [true, 'wrong']);
  assert.equal(tally(scored, { elements: { 1: 'incorrect' } }).scores.accuracy, 0.5);
});

async function setup() {
  process.env.SCRIBE_DIR = path.join(tempDir('hd-scribe-'), 'scribe');
  const s = await startTestServer();
  const loaded = (await s.call('POST', '/agent-ops/scribe/cases/load', {})).json.loaded;
  return { s, loaded };
}
