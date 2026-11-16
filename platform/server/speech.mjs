// Local speech on this machine: text to speech and speech to text with
// models that run in the ONNX runtime (MIT), with no network at run time. The model files are
// fetched once by a person with scripts/get-models.mjs into data/models/ (see docs/LICENSES.md):
//   speech synthesis: SpeechT5 with the HiFi-GAN vocoder (MIT) and CMU ARCTIC speaker vectors
//   speech recognition: Whisper tiny, English (MIT / Apache-2.0)
// The audio maths around the models (log-mel spectrogram, tokenisers, decoding loops, WAV) is our own code.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './db/index.mjs';

export const SAMPLE_RATE = 16000;
export const modelsDir = () => path.resolve(REPO_ROOT, process.env.MODELS_DIR || 'data/models');
export const VOICES = [
  { id: 'slt', label: 'Woman, American' }, { id: 'clb', label: 'Woman, American, lower' }, { id: 'bdl', label: 'Man, American' }, { id: 'rms', label: 'Man, American, older' },
  { id: 'jmk', label: 'Man, Canadian' }, { id: 'awb', label: 'Man, Scottish' }, { id: 'ksp', label: 'Man, Indian' },
];
const STT_FILES = ['whisper-tiny.en/encoder_model.onnx', 'whisper-tiny.en/decoder_model.onnx', 'whisper-tiny.en/vocab.json'];
const TTS_FILES = ['speecht5/encoder_model.onnx', 'speecht5/decoder_model_merged.onnx', 'speecht5/decoder_postnet_and_vocoder.onnx', 'speecht5/tokenizer.json'];
const have = (files) => files.every((f) => fs.existsSync(path.join(modelsDir(), f)));
/** What can run now. Speech is off (with the reason) until the models are downloaded. */
export function speechStatus() {
  const hint = 'Run "node scripts/get-models.mjs" once to download the local speech models.';
  const tts = have(TTS_FILES); const stt = have(STT_FILES);
  return { tts, stt, voices: tts ? VOICES.filter((v) => fs.existsSync(path.join(modelsDir(), 'speecht5', 'voices', `${v.id}.bin`))) : [], reason: tts && stt ? null : hint, engine: { tts: 'SpeechT5 with HiFi-GAN (local)', stt: 'Whisper tiny, English (local)' } };
}
let ortPromise = null;
const ort = () => { if (!ortPromise) ortPromise = import('onnxruntime-node'); return ortPromise; };
const sessions = new Map();
async function session(file) {
  if (!sessions.has(file)) { const o = await ort(); sessions.set(file, o.InferenceSession.create(path.join(modelsDir(), file), { logSeverityLevel: 3 })); }
  return sessions.get(file);
}

// ---------- WAV (16-bit PCM, mono) ----------
export function encodeWav(samples, rate = SAMPLE_RATE) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + samples.length * 2, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i += 1) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return out;
}
/** Reads PCM WAV (8, 16, 24 or 32 bit integer, or 32 bit float; any channel count, mixed down to mono). */
export function decodeWav(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file');
  let pos = 12; let fmt = null; let data = null;
  while (pos + 8 <= b.length) { const id = b.toString('ascii', pos, pos + 4); const size = b.readUInt32LE(pos + 4); if (id === 'fmt ') fmt = { format: b.readUInt16LE(pos + 8), channels: b.readUInt16LE(pos + 10), rate: b.readUInt32LE(pos + 12), bits: b.readUInt16LE(pos + 22) }; else if (id === 'data') { data = b.subarray(pos + 8, Math.min(b.length, pos + 8 + size)); break; } pos += 8 + size + (size % 2); }
  if (!fmt || !data) throw new Error('The WAV file has no audio data');
  if (![1, 3, 0xfffe].includes(fmt.format)) throw new Error('Only uncompressed (PCM) WAV audio can be read');
  const step = (fmt.bits / 8) * fmt.channels; const n = Math.floor(data.length / step); const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) { let s = 0; for (let c = 0; c < fmt.channels; c += 1) { const o = i * step + c * (fmt.bits / 8); s += fmt.format === 3 ? data.readFloatLE(o) : fmt.bits === 8 ? (data[o] - 128) / 128 : fmt.bits === 16 ? data.readInt16LE(o) / 32768 : fmt.bits === 24 ? data.readIntLE(o, 3) / 8388608 : data.readInt32LE(o) / 2147483648; } out[i] = s / fmt.channels; }
  return { samples: out, rate: fmt.rate };
}
/** Linear resampling (with a simple average when going down, to limit aliasing). */
export function resample(samples, from, to = SAMPLE_RATE) {
  if (from === to) return samples;
  const n = Math.max(1, Math.round((samples.length * to) / from)); const out = new Float32Array(n); const ratio = from / to;
  for (let i = 0; i < n; i += 1) { const at = i * ratio; if (ratio > 1) { const a = Math.floor(at); const b = Math.min(samples.length, Math.ceil(at + ratio)); let s = 0; for (let k = a; k < b; k += 1) s += samples[k]; out[i] = s / Math.max(1, b - a); } else { const a = Math.floor(at); const f = at - a; out[i] = samples[a] * (1 - f) + (samples[Math.min(samples.length - 1, a + 1)] ?? 0) * f; } }
  return out;
}

// ---------- log-mel spectrogram for Whisper (25 ms Hann window, 10 ms hop, 80 mel bands, as in the Whisper paper) ----------
const N_FFT = 400; const HOP = 160; const N_MELS = 80; const N_BINS = N_FFT / 2 + 1;
const hz2mel = (f) => (f < 1000 ? f / (200 / 3) : 15 + Math.log(f / 1000) / (Math.log(6.4) / 27));
const mel2hz = (m) => (m < 15 ? m * (200 / 3) : 1000 * Math.exp((Math.log(6.4) / 27) * (m - 15)));
let melBank = null; let hann = null; let cosT = null; let sinT = null;
function tables() {
  if (melBank) return;
  hann = new Float32Array(N_FFT); for (let i = 0; i < N_FFT; i += 1) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
  cosT = new Float32Array(N_FFT); sinT = new Float32Array(N_FFT); for (let i = 0; i < N_FFT; i += 1) { cosT[i] = Math.cos((2 * Math.PI * i) / N_FFT); sinT[i] = Math.sin((2 * Math.PI * i) / N_FFT); }
  // Triangular filters evenly spaced on the mel scale from 0 to 8000 Hz, each scaled to unit area (the "Slaney" form).
  const pts = Array.from({ length: N_MELS + 2 }, (_, i) => mel2hz((hz2mel(8000) * i) / (N_MELS + 1)));
  melBank = Array.from({ length: N_MELS }, (_, m) => { const row = new Float32Array(N_BINS); const lo = pts[m]; const mid = pts[m + 1]; const hi = pts[m + 2]; const norm = 2 / (hi - lo); for (let k = 0; k < N_BINS; k += 1) { const f = (k * SAMPLE_RATE) / N_FFT; const w = Math.max(0, Math.min((f - lo) / (mid - lo), (hi - f) / (hi - mid))); row[k] = w * norm; } return row; });
}
/** 30 seconds of audio (padded with silence or cut) as the 80 x 3000 log-mel features Whisper expects. */
export function logMel(samples) {
  tables();
  const frames = 3000; const total = frames * HOP; const pad = N_FFT / 2;
  const at = (i) => { let j = i - pad; if (j < 0) j = -j; if (j >= total) j = 2 * total - 2 - j; return j < samples.length ? samples[j] : 0; }; // reflect padding at both ends, silence after the audio
  const out = new Float32Array(N_MELS * frames); const frame = new Float32Array(N_FFT); const power = new Float32Array(N_BINS);
  const lastAudioFrame = Math.min(frames, Math.ceil((samples.length + pad) / HOP) + 1); let max = -Infinity; const silent = Math.log10(1e-10);
  for (let t = 0; t < frames; t += 1) {
    if (t >= lastAudioFrame && t < frames - 3) { for (let m = 0; m < N_MELS; m += 1) out[m * frames + t] = silent; continue; }
    let energy = 0; for (let i = 0; i < N_FFT; i += 1) { frame[i] = at(t * HOP + i) * hann[i]; energy += frame[i] * frame[i]; }
    if (!energy) { for (let m = 0; m < N_MELS; m += 1) out[m * frames + t] = silent; continue; }
    for (let k = 0; k < N_BINS; k += 1) { let re = 0; let im = 0; let idx = 0; for (let i = 0; i < N_FFT; i += 1) { re += frame[i] * cosT[idx]; im -= frame[i] * sinT[idx]; idx += k; if (idx >= N_FFT) idx -= N_FFT; } power[k] = re * re + im * im; }
    for (let m = 0; m < N_MELS; m += 1) { const row = melBank[m]; let s = 0; for (let k = 0; k < N_BINS; k += 1) s += row[k] * power[k]; const v = Math.log10(Math.max(s, 1e-10)); out[m * frames + t] = v; if (v > max) max = v; }
  }
  if (max === -Infinity) max = silent;
  for (let i = 0; i < out.length; i += 1) out[i] = (Math.max(out[i], max - 8) + 4) / 4;
  return out;
}

// ---------- speech to text ----------
const SOT = 50257; const NO_TIMESTAMPS = 50362; const EOT = 50256;
let vocab = null;
function tokenText(ids) {
  if (!vocab) { const v = JSON.parse(fs.readFileSync(path.join(modelsDir(), 'whisper-tiny.en/vocab.json'), 'utf8')); vocab = []; for (const [tok, id] of Object.entries(v)) vocab[id] = tok; }
  // Byte-level BPE (as GPT-2): each character of a token stands for one byte; printable bytes stand for themselves, the rest are moved up by 256 or more.
  const map = byteDecoder(); const bytes = [];
  for (const id of ids) { const tok = vocab[id]; if (tok == null || id >= EOT) continue; for (const ch of tok) { const b = map.get(ch); if (b != null) bytes.push(b); } }
  return Buffer.from(bytes).toString('utf8');
}
let byteMap = null;
function byteDecoder() {
  if (byteMap) return byteMap;
  const bs = []; for (let i = 33; i <= 126; i += 1) bs.push(i); for (let i = 161; i <= 172; i += 1) bs.push(i); for (let i = 174; i <= 255; i += 1) bs.push(i);
  const cs = bs.slice(); let n = 0; for (let b = 0; b < 256; b += 1) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n += 1; }
  byteMap = new Map(bs.map((b, i) => [String.fromCodePoint(cs[i]), b])); return byteMap;
}
/** Transcribes mono audio at 16 kHz. Longer audio is read in 30 second windows. Returns { text, seconds, ms }. */
export async function transcribe(samples, { maxTokens = 200 } = {}) {
  if (!have(STT_FILES)) throw new Error(speechStatus().reason);
  const o = await ort(); const enc = await session('whisper-tiny.en/encoder_model.onnx'); const dec = await session('whisper-tiny.en/decoder_model.onnx');
  const started = Date.now(); const window = 30 * SAMPLE_RATE; const parts = [];
  for (let off = 0; off < Math.max(1, samples.length); off += window) {
    const chunk = samples.subarray(off, off + window);
    let peak = 0; for (let i = 0; i < chunk.length; i += 1) { const a = Math.abs(chunk[i]); if (a > peak) peak = a; }
    if (peak < 0.003) continue; // silence
    const hidden = (await enc.run({ input_features: new o.Tensor('float32', logMel(chunk), [1, N_MELS, 3000]) })).last_hidden_state;
    const ids = [SOT, NO_TIMESTAMPS];
    for (let step = 0; step < maxTokens; step += 1) {
      const out = await dec.run({ input_ids: new o.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]), encoder_hidden_states: hidden });
      const logits = out.logits; const V = logits.dims[2]; const base = (ids.length - 1) * V; let best = 0; let bv = -Infinity;
      for (let v = 0; v < V; v += 1) { if (v > EOT) continue; const x = logits.data[base + v]; if (x > bv) { bv = x; best = v; } } // never a special or timestamp token; the end token is allowed
      if (best === EOT) break;
      ids.push(best);
      if (ids.length > 12 && ids.slice(-4).join() === ids.slice(-8, -4).join()) break; // a loop of repeats: stop
    }
    parts.push(tokenText(ids.slice(2)).trim());
  }
  return { text: parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(), seconds: Math.round((samples.length / SAMPLE_RATE) * 10) / 10, ms: Date.now() - started };
}

// ---------- text to speech ----------
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
export function numberWords(n) {
  n = Math.floor(Math.abs(n));
  if (n < 20) return ONES[n];
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ''}`;
  if (n < 1e6) return `${numberWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${numberWords(n % 1000)}` : ''}`;
  return String(n).split('').map((d) => ONES[Number(d)]).join(' ');
}
/** Text as the synthesiser can say it: numbers in words, a few symbols spoken, anything outside its alphabet dropped. */
export function speakable(text) {
  return String(text || '').replace(/(\d+)\.(\d+)/g, (m, a, b) => `${numberWords(Number(a))} point ${b.split('').map((d) => ONES[Number(d)]).join(' ')}`).replace(/\d+/g, (m) => numberWords(Number(m)))
    .replace(/%/g, ' percent').replace(/&/g, ' and ').replace(/\+/g, ' plus ').replace(/[\/]/g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, ', ').replace(/[^A-Za-z0-9 ,.;?!'"-]/g, ' ').replace(/\s+/g, ' ').trim();
}
const sentences = (text) => { const out = []; for (const s of text.split(/(?<=[.?!;])\s+/)) { let rest = s.trim(); while (rest.length > 180) { let cut = rest.lastIndexOf(',', 180); if (cut < 60) cut = rest.lastIndexOf(' ', 180); if (cut < 1) cut = 180; out.push(rest.slice(0, cut + 1).trim()); rest = rest.slice(cut + 1).trim(); } if (rest) out.push(rest); } return out; };
let ttsVocab = null; const voiceCache = new Map();
function ttsIds(text) {
  if (!ttsVocab) ttsVocab = JSON.parse(fs.readFileSync(path.join(modelsDir(), 'speecht5/tokenizer.json'), 'utf8')).model.vocab;
  const ids = []; for (const word of text.split(/\s+/).filter(Boolean)) { ids.push(ttsVocab['▁']); for (const ch of word) ids.push(ttsVocab[ch] ?? ttsVocab['<unk>']); }
  ids.push(ttsVocab['</s>']); return ids;
}
function voiceVector(voice) {
  const id = VOICES.some((v) => v.id === voice) ? voice : 'slt';
  if (!voiceCache.has(id)) { const b = fs.readFileSync(path.join(modelsDir(), 'speecht5', 'voices', `${id}.bin`)); voiceCache.set(id, new Float32Array(b.buffer, b.byteOffset, b.length / 4).slice()); }
  return voiceCache.get(id);
}
/** Speaks text in one of the voices. Returns { samples (Float32, 16 kHz), seconds, ms }. */
export async function synthesize(text, { voice = 'slt', pauseMs = 180 } = {}) {
  if (!have(TTS_FILES)) throw new Error(speechStatus().reason);
  const o = await ort(); const enc = await session('speecht5/encoder_model.onnx'); const dec = await session('speecht5/decoder_model_merged.onnx'); const voc = await session('speecht5/decoder_postnet_and_vocoder.onnx');
  const started = Date.now(); const speaker = new o.Tensor('float32', voiceVector(voice), [1, 512]); const chunks = [];
  const pastNames = dec.inputNames.filter((n) => n.startsWith('past_key_values.'));
  for (const sentence of sentences(speakable(text))) {
    const ids = ttsIds(sentence); if (ids.length < 2) continue;
    const e = await enc.run({ input_ids: new o.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]) });
    const maxlen = Math.floor((ids.length * 20) / 2); const spectra = [];
    let seq = new o.Tensor('float32', new Float32Array(80), [1, 1, 80]);
    let past = Object.fromEntries(pastNames.map((n) => [n, new o.Tensor('float32', new Float32Array(0), [1, 12, 0, 64])]));
    for (let i = 0; i < maxlen; i += 1) {
      const out = await dec.run({ use_cache_branch: new o.Tensor('bool', [i > 0], [1]), output_sequence: seq, encoder_attention_mask: e.encoder_attention_mask, speaker_embeddings: speaker, encoder_hidden_states: e.encoder_outputs, ...past });
      spectra.push(Float32Array.from(out.spectrum.data)); seq = out.output_sequence_out;
      // The decoder's own attention cache is replaced every step; the cache over the encoder is made once, on the first step.
      const next = {}; for (const n of pastNames) { const present = n.replace('past_key_values.', 'present.'); next[n] = n.includes('.encoder.') && i > 0 ? past[n] : out[present]; } past = next;
      if (i >= 2 && Array.from(out.prob.data).some((p) => p >= 0.5)) break;
    }
    const frames = spectra.reduce((n, s) => n + s.length / 80, 0); const spec = new Float32Array(frames * 80); let at = 0; for (const s of spectra) { spec.set(s, at); at += s.length; }
    const wave = (await voc.run({ spectrogram: new o.Tensor('float32', spec, [frames, 80]) })).waveform;
    chunks.push(Float32Array.from(wave.data), new Float32Array(Math.round((pauseMs / 1000) * SAMPLE_RATE)));
  }
  const total = chunks.reduce((n, c) => n + c.length, 0); const samples = new Float32Array(total); let p = 0; for (const c of chunks) { samples.set(c, p); p += c.length; }
  return { samples, seconds: Math.round((total / SAMPLE_RATE) * 10) / 10, ms: Date.now() - started };
}

// ---------- realism: noise, overlap and a second speaker ----------
const seeded = (seed) => { let a = (Number(seed) || 1) >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
/** Adds steady room noise (low-passed white noise) at the given signal-to-noise ratio in dB. Reproducible from the seed. */
export function addNoise(samples, { snrDb = 15, seed = 1 } = {}) {
  let power = 0; for (let i = 0; i < samples.length; i += 1) power += samples[i] * samples[i]; power = power / Math.max(1, samples.length) || 1e-4;
  const rnd = seeded(seed); const noise = new Float32Array(samples.length); let last = 0; let np = 0;
  for (let i = 0; i < noise.length; i += 1) { last = last * 0.85 + (rnd() * 2 - 1) * 0.15; noise[i] = last; np += last * last; }
  const gain = Math.sqrt(power / (10 ** (snrDb / 10)) / (np / Math.max(1, noise.length) || 1));
  const out = new Float32Array(samples.length); for (let i = 0; i < out.length; i += 1) out[i] = Math.max(-1, Math.min(1, samples[i] + noise[i] * gain));
  return out;
}
/** Lays utterances end to end with a gap; a negative gap makes the next speaker start before the last one has finished (talking over each other). */
export function sequence(utterances, { gapMs = 350 } = {}) {
  const gaps = utterances.map((u, i) => (i === 0 ? 0 : Math.round((((u.gapMs ?? gapMs)) / 1000) * SAMPLE_RATE)));
  const starts = []; let at = 0; utterances.forEach((u, i) => { at = Math.max(0, at + gaps[i]); starts.push(at); at += u.samples.length; });
  const out = new Float32Array(Math.max(...utterances.map((u, i) => starts[i] + u.samples.length), 0));
  utterances.forEach((u, i) => { for (let k = 0; k < u.samples.length; k += 1) out[starts[i] + k] = Math.max(-1, Math.min(1, out[starts[i] + k] + u.samples[k])); });
  return { samples: out, starts: starts.map((s) => Math.round((s / SAMPLE_RATE) * 100) / 100) };
}
