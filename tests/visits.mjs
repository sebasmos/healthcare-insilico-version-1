// Simulated visits: the patient simulator is reproducible from a seed and
// never tells a hidden fact unprompted; scoring is right on seeded visits, including upcoding; the
// audio round trip (speech generated, then recognised) works on a short synthetic script; the
// visit service runs an agent visit end to end; the environment API has a "talk to patient" tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, BACKEND } from './support/helpers.mjs';
import { createSimulator, PERSONAS, askedFacts, leaksHidden, scriptFromChart } from '../simulated-consultation/server/patient-sim.mjs';
import { visitCases, visitCase, scoreVisit, draftFromTranscript, builtinInterviewer, CHECKLIST } from '../simulated-consultation/server/visits.mjs';
import * as speech from '../platform/server/speech.mjs';
import { HospitalEnv } from '../clients/js/hospital-env.mjs';

process.env.ENV_API_ENABLED = 'true';
const res = { 'X-Role': 'researcher', 'X-User-Id': 'res-one' };
const doc = { 'X-Role': 'physician', 'X-User-Id': 'Dr Visit' };
const chest = visitCase('visit-chest-pain');
/** Runs the built-in interviewer against the simulator and returns the turns. */
function interview(script, { persona = 'cooperative', seed = 0, style = 'thorough', turnLimit = 30 } = {}) {
  const sim = createSimulator(script, { persona, seed, turnLimit }); const asker = builtinInterviewer({ style });
  const turns = [{ who: 'patient', text: sim.opening().text }]; let last = null;
  for (let i = 0; i < 60; i += 1) { const q = asker.next(last); if (!q) break; turns.push({ who: 'interviewer', text: q }); last = sim.reply(q); turns.push({ who: 'patient', text: last.text, revealed: last.revealed, notes: last.notes }); if (last.done) break; }
  return { turns, sim };
}

test('audio round trip on this machine: speech is generated in several voices and recognised again; noise and overlap are reproducible', { skip: speech.speechStatus().tts && speech.speechStatus().stt ? false : 'the local speech models are not downloaded (node scripts/get-models.mjs)' }, async () => {
  const words = (s) => s.toLowerCase().replace(/\d+/g, (d) => speech.numberWords(Number(d))).replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean); // recognition may write a number in figures
  const overlap = (said, heard) => { const h = new Set(words(heard)); const w = words(said); return w.filter((x) => h.has(x)).length / w.length; };
  const script = [['slt', 'I have had chest pain since this morning. It gets worse when I walk up the stairs.'], ['bdl', 'My father had a heart attack at fifty two.'], ['awb', 'No, I do not smoke. I take a blood pressure tablet every day.'], ['ksp', 'I am allergic to penicillin. It gives me a rash.']];
  const made = [];
  for (const [voice, text] of script) {
    const audio = await speech.synthesize(text, { voice });
    assert.ok(audio.seconds > 1.5 && audio.seconds < 12, `${voice}: ${audio.seconds} s of speech`);
    const heard = await speech.transcribe(audio.samples);
    assert.ok(overlap(text, heard.text) >= 0.8, `${voice}: said "${text}", heard "${heard.text}"`);
    made.push(audio.samples);
  }
  assert.ok(made[0].length !== made[1].length, 'different voices and sentences give different audio');
  // WAV out and back, at another sample rate.
  const wav = speech.encodeWav(made[1]); const back = speech.decodeWav(wav);
  assert.deepEqual([back.rate, back.samples.length], [16000, made[1].length]);
  const up = speech.resample(back.samples, 16000, 44100); const down = speech.resample(up, 44100, 16000);
  assert.ok(overlap(script[1][1], (await speech.transcribe(down)).text) >= 0.8, 'still recognised after resampling to 44.1 kHz and back');
  // Realism: noise at a known level, reproducible from its seed; talking over each other.
  const noisy = speech.addNoise(made[0], { snrDb: 14, seed: 3 });
  assert.deepEqual(Array.from(noisy.slice(0, 50)), Array.from(speech.addNoise(made[0], { snrDb: 14, seed: 3 }).slice(0, 50)));
  assert.ok(overlap(script[0][1], (await speech.transcribe(noisy)).text) >= 0.6, 'speech with background noise is still mostly recognised');
  const apart = speech.sequence([{ samples: made[1] }, { samples: made[3] }], { gapMs: 300 }); const over = speech.sequence([{ samples: made[1] }, { samples: made[3], gapMs: -500 }]);
  assert.equal(apart.samples.length, made[1].length + made[3].length + 4800);
  assert.equal(over.samples.length, made[1].length + made[3].length - 8000, 'a negative gap makes the second speaker start early');
  assert.equal(speech.speakable('BP 120/80, 37.5 degrees & 2 tablets'), 'BP one hundred twenty eighty, thirty seven point five degrees and two tablets');
  assert.throws(() => speech.decodeWav(Buffer.from('not audio')), /Not a WAV/);
});
