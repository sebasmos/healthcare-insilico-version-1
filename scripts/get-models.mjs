// One-time download of the local speech models into data/models/ (gitignored). Nothing here runs
// unless a person runs this script; the server never downloads anything. Each file is pinned to an
// exact revision; its size and SHA-256 are written to data/models/manifest.json and checked on
// later runs. Licences and sources are recorded in docs/LICENSES.md.
//   node scripts/get-models.mjs            download what is missing
//   node scripts/get-models.mjs --check    only verify what is there
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MODELS_DIR = path.resolve(ROOT, process.env.MODELS_DIR || 'data/models');
const HF = 'https://huggingface.co';
const W = 'Xenova/whisper-tiny.en'; const WR = '79fb389fc764e7c395bd330e9531d9d32ada7049';
const T = 'Xenova/speecht5_tts'; const TR = '1723781b8ce2d02f0400c8337be04ae8ee3d6d56';
const X = 'datasets/Xenova/cmu-arctic-xvectors-extracted'; const XR = 'b7b0b7fd0c1c77728ded8e1a908e863b490cfef4';
// The voices: one x-vector (speaker embedding) per CMU ARCTIC speaker.
export const VOICES = [
  { id: 'slt', label: 'Woman, American', file: 'cmu_us_slt_arctic-wav-arctic_a0001.bin' }, { id: 'clb', label: 'Woman, American, lower', file: 'cmu_us_clb_arctic-wav-arctic_a0001.bin' },
  { id: 'bdl', label: 'Man, American', file: 'cmu_us_bdl_arctic-wav-arctic_a0001.bin' }, { id: 'rms', label: 'Man, American, older', file: 'cmu_us_rms_arctic-wav-arctic_a0001.bin' },
  { id: 'jmk', label: 'Man, Canadian', file: 'cmu_us_jmk_arctic-wav-arctic_a0001.bin' }, { id: 'awb', label: 'Man, Scottish', file: 'cmu_us_awb_arctic-wav-arctic_a0001.bin' }, { id: 'ksp', label: 'Man, Indian', file: 'cmu_us_ksp_arctic-wav-arctic_a0001.bin' },
];
export const FILES = [
  { to: 'whisper-tiny.en/encoder_model.onnx', url: `${HF}/${W}/resolve/${WR}/onnx/encoder_model.onnx`, what: 'speech recognition encoder' },
  { to: 'whisper-tiny.en/decoder_model.onnx', url: `${HF}/${W}/resolve/${WR}/onnx/decoder_model.onnx`, what: 'speech recognition decoder' },
  { to: 'whisper-tiny.en/vocab.json', url: `${HF}/${W}/resolve/${WR}/vocab.json`, what: 'speech recognition vocabulary' },
  { to: 'whisper-tiny.en/added_tokens.json', url: `${HF}/${W}/resolve/${WR}/added_tokens.json`, what: 'speech recognition special tokens' },
  { to: 'speecht5/encoder_model.onnx', url: `${HF}/${T}/resolve/${TR}/onnx/encoder_model_quantized.onnx`, what: 'speech synthesis encoder (8-bit)' },
  { to: 'speecht5/decoder_model_merged.onnx', url: `${HF}/${T}/resolve/${TR}/onnx/decoder_model_merged.onnx`, what: 'speech synthesis decoder (full precision: the 8-bit one was not intelligible enough)' },
  { to: 'speecht5/decoder_postnet_and_vocoder.onnx', url: `${HF}/${T}/resolve/${TR}/onnx/decoder_postnet_and_vocoder.onnx`, what: 'speech synthesis post-net and vocoder' },
  { to: 'speecht5/tokenizer.json', url: `${HF}/${T}/resolve/${TR}/tokenizer.json`, what: 'speech synthesis character vocabulary' },
  ...VOICES.map((v) => ({ to: `speecht5/voices/${v.id}.bin`, url: `${HF}/${X}/resolve/${XR}/${v.file}`, what: `voice: ${v.label}` })),
];
const sha256 = (file) => new Promise((resolve, reject) => { const h = createHash('sha256'); fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject); });
export const manifestFile = () => path.join(MODELS_DIR, 'manifest.json');
export function readManifest() { try { return JSON.parse(fs.readFileSync(manifestFile(), 'utf8')); } catch { return { files: {} }; } }

async function main() {
  const checkOnly = process.argv.includes('--check');
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const manifest = readManifest(); let bad = 0;
  for (const f of FILES) {
    const dest = path.join(MODELS_DIR, f.to); const known = manifest.files[f.to];
    if (fs.existsSync(dest)) {
      const sum = await sha256(dest);
      if (known && known.sha256 !== sum) { console.log(`CHANGED ${f.to}: the checksum is not the one recorded. Delete the file and run again.`); bad += 1; continue; }
      manifest.files[f.to] = { url: f.url, bytes: fs.statSync(dest).size, sha256: sum, what: f.what, fetchedAt: known?.fetchedAt || new Date().toISOString() };
      console.log(`ok      ${f.to} (${(fs.statSync(dest).size / 1e6).toFixed(1)} MB)`);
      continue;
    }
    if (checkOnly) { console.log(`MISSING ${f.to}`); bad += 1; continue; }
    process.stdout.write(`get     ${f.to} … `);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const r = await fetch(f.url, { redirect: 'follow' });
    if (!r.ok) { console.log(`failed (HTTP ${r.status})`); bad += 1; continue; }
    const tmp = `${dest}.part`; const out = fs.createWriteStream(tmp);
    for await (const chunk of r.body) { if (!out.write(chunk)) await new Promise((ok) => out.once('drain', ok)); }
    await new Promise((ok) => out.end(ok));
    fs.renameSync(tmp, dest);
    manifest.files[f.to] = { url: f.url, bytes: fs.statSync(dest).size, sha256: await sha256(dest), what: f.what, fetchedAt: new Date().toISOString() };
    console.log(`${(fs.statSync(dest).size / 1e6).toFixed(1)} MB`);
    fs.writeFileSync(manifestFile(), JSON.stringify(manifest, null, 1));
  }
  fs.writeFileSync(manifestFile(), JSON.stringify(manifest, null, 1));
  console.log(bad ? `${bad} file(s) missing or changed.` : 'All speech model files are in place.');
  process.exit(bad ? 1 : 0);
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
