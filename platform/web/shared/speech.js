// Local speech in the browser: record from the microphone, turn it into 16 kHz mono WAV, and have
// it recognised on this machine (/api/speech/transcribe). No audio goes to an outside service.
import { api } from '/shared/fhir.js';

let statusPromise = null;
/** What this machine can do: { tts, stt, voices, reason }. Asked once per page. */
export const speechStatus = () => { if (!statusPromise) statusPromise = api.get('/api/speech/status').catch(() => ({ tts: false, stt: false, voices: [], reason: 'Speech is not available on this server' })); return statusPromise; };
export const dictationChoice = () => { try { return localStorage.getItem('hd.dictation') === 'browser' ? 'browser' : 'local'; } catch { return 'local'; } };
export const setDictationChoice = (v) => { try { localStorage.setItem('hd.dictation', v === 'browser' ? 'browser' : 'local'); } catch { /* this page only */ } };

export function wavBase64(samples, rate = 16000) {
  const buf = new ArrayBuffer(44 + samples.length * 2); const v = new DataView(buf); const w = (o, s) => { for (let i = 0; i < s.length; i += 1) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  const bytes = new Uint8Array(buf); let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s);
}
/** Starts recording. Returns { stop() -> Promise<base64 WAV at 16 kHz>, cancel() }. */
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const rec = new MediaRecorder(stream); const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.start();
  const finish = () => new Promise((resolve) => { rec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); resolve(); }; if (rec.state !== 'inactive') rec.stop(); else resolve(); });
  return {
    async stop() {
      await finish();
      const raw = await new Blob(chunks, { type: rec.mimeType }).arrayBuffer();
      const ctx = new (window.AudioContext || window.webkitAudioContext)(); const decoded = await ctx.decodeAudioData(raw); ctx.close();
      const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000); const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
      return wavBase64((await off.startRendering()).getChannelData(0));
    },
    cancel: finish,
  };
}
/** Records until stop() and returns the recognised text. */
export async function transcribeRecording(recording) { const audio = await recording.stop(); return (await api.post('/api/speech/transcribe', { audio })).text; }
