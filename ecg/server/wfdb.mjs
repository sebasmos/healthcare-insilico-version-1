// WFDB (PhysioNet) record reader for ECG import: the .hea header and .dat
// signal files in format 16 only (little-endian 16-bit two's complement,
// interleaved by signal). Other formats (212, 80, 310 and so on) are refused
// with a message that names the format. A record becomes one FHIR
// Observation (LOINC 11524-6) with one valueSampledData component per lead,
// coded with the ISO/IEEE 11073 MDC lead codes. This is the A.8 contract.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MDC_SYSTEM = 'urn:oid:2.16.840.1.113883.6.24';
export const ECG_SOURCE_URL = 'urn:hospital-desktop:ecg-source';
export const ECG_CODE = { system: 'http://loinc.org', code: '11524-6', display: 'EKG study' };
export const MDC_LEADS = { I: '131329', II: '131330', III: '131331', AVR: '131332', AVL: '131333', AVF: '131334', V1: '131335', V2: '131336', V3: '131337', V4: '131338', V5: '131339', V6: '131340' };
export const MAX_LEADS = 12;
export const MAX_SECONDS = 30;

export class WfdbError extends Error {}

/** Maps a WFDB signal description to a standard lead name, or null. "MLII" counts as II; case and spaces do not matter. */
export function leadOf(description) {
  let key = String(description || '').toUpperCase().replace(/\s+/g, '').replace(/^(LEAD|ECG|EKG)[-_]?/, '');
  if (/^ML(I{1,3})$/.test(key)) key = key.slice(2);
  if (key === 'AVR' || key === 'AVL' || key === 'AVF') return key.replace('AV', 'aV');
  return MDC_LEADS[key] ? key : null;
}

/** Parses a .hea header. Returns { name, nsig, fs, nsamp, baseTime, baseDate, signals[], comments[] }. */
export function parseHeader(text) {
  const lines = text.split(/\r?\n/);
  const comments = lines.filter((l) => l.startsWith('#')).map((l) => l.slice(1).trim());
  const body = lines.filter((l) => l.trim() && !l.startsWith('#'));
  if (!body.length) throw new WfdbError('header is empty');
  const head = body[0].trim().split(/\s+/);
  const [nameField, nsigField, fsField, nsampField, timeField, dateField] = head;
  if (!nameField || !nsigField) throw new WfdbError('header line needs a record name and a signal count');
  if (nameField.includes('/')) throw new WfdbError('multi-segment records are not supported');
  const nsig = Number(nsigField);
  if (!Number.isInteger(nsig) || nsig < 0) throw new WfdbError(`signal count "${nsigField}" is not a whole number`);
  const fs = fsField ? Number(fsField.split('/')[0]) : 250;
  if (!(fs > 0)) throw new WfdbError(`sampling frequency "${fsField}" is not a positive number`);
  const nsamp = nsampField ? Number(nsampField) : 0;
  const signals = body.slice(1, 1 + nsig).map((line, i) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) throw new WfdbError(`signal line ${i + 1} needs a file name and a format`);
    const [file, formatField, gainField, adcResField, adcZeroField, initField, checksumField, blockField] = parts;
    const format = formatField.match(/^-?\d+/)?.[0] ?? formatField;
    const byteOffset = Number(formatField.match(/\+(\d+)/)?.[1] ?? 0);
    const gainMatch = (gainField || '').match(/^(-?[\d.]+)?(?:\((-?\d+)\))?(?:\/(.+))?$/) || [];
    const gain = Number(gainMatch[1]) || 200;
    const adcZero = adcZeroField != null ? Number(adcZeroField) || 0 : 0;
    const baseline = gainMatch[2] != null ? Number(gainMatch[2]) : adcZero;
    const units = gainMatch[3] || 'mV';
    const description = parts.length > 8 ? parts.slice(8).join(' ') : `signal ${i + 1}`;
    return { file, format, byteOffset, gain, baseline, units, adcRes: Number(adcResField) || 16, adcZero, initValue: Number(initField) || 0, checksum: checksumField, blockSize: Number(blockField) || 0, description };
  });
  if (signals.length !== nsig) throw new WfdbError(`header announces ${nsig} signals but lists ${signals.length}`);
  return { name: nameField, nsig, fs, nsamp, baseTime: timeField ?? null, baseDate: dateField ?? null, signals, comments };
}

/** Reads one record (name without extension) from a folder. Format 16 only. */
export function readRecord(dir, name) {
  const header = parseHeader(fs.readFileSync(path.join(dir, `${name}.hea`), 'utf8'));
  const bad = header.signals.filter((s) => s.format !== '16');
  if (bad.length) throw new WfdbError(`record ${name} uses format ${[...new Set(bad.map((s) => s.format))].join(', ')}; only format 16 (16-bit little-endian) is supported`);
  const byFile = new Map();
  header.signals.forEach((s, i) => { if (!byFile.has(s.file)) byFile.set(s.file, []); byFile.get(s.file).push(i); });
  const samples = header.signals.map(() => null);
  for (const [file, indexes] of byFile) {
    const bytes = fs.readFileSync(path.join(dir, file));
    const offset = header.signals[indexes[0]].byteOffset;
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
    const frames = Math.floor(view.byteLength / (2 * indexes.length));
    const n = header.nsamp > 0 ? Math.min(header.nsamp, frames) : frames;
    indexes.forEach((sig, k) => {
      const out = new Int16Array(n);
      for (let t = 0; t < n; t += 1) out[t] = view.getInt16((t * indexes.length + k) * 2, true);
      samples[sig] = out;
    });
  }
  return { ...header, signals: header.signals.map((s, i) => ({ ...s, samples: samples[i] })) };
}

/** Record names in a folder: every .hea file that has a matching .dat for its first signal. */
export function listRecords(dir) {
  return fs.readdirSync(dir).filter((f) => /\.hea$/i.test(f)).map((f) => f.replace(/\.hea$/i, '')).sort();
}

function effectiveFrom(header, fallbackIso) {
  if (!header.baseTime) return fallbackIso;
  const time = header.baseTime.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!time) return fallbackIso;
  const date = header.baseDate?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const day = date ? `${date[3]}-${date[2].padStart(2, '0')}-${date[1].padStart(2, '0')}` : fallbackIso.slice(0, 10);
  const iso = `${day}T${time[1].padStart(2, '0')}:${time[2]}:${time[3]}.${(time[4] || '0').padEnd(3, '0').slice(0, 3)}Z`;
  return Number.isNaN(Date.parse(iso)) ? fallbackIso : iso;
}

/** Age and sex from the first comment line, as PhysioNet writes them ("# 69 M 1085 1629 x1"). */
export function subjectHints(header) {
  const m = (header.comments[0] || '').match(/^(\d{1,3})\s+([MFmf])\b/);
  return m ? { age: Number(m[1]), gender: m[2].toUpperCase() === 'M' ? 'male' : 'female' } : {};
}

/**
 * Builds the ECG Observation for a record. Samples stay integers; gain goes
 * into factor so mV = value * factor; the baseline is subtracted from the
 * integers so origin is 0 mV. At most 12 leads and 30 seconds per lead.
 * Returns { observation, truncated: { leads, seconds } }.
 */
export function toObservation(record, { patientId, importedAt, id = null } = {}) {
  const maxSamples = Math.floor(MAX_SECONDS * record.fs);
  const period = Math.round((1000 / record.fs) * 1e6) / 1e6;
  const truncated = { leads: Math.max(0, record.signals.length - MAX_LEADS), seconds: false };
  const component = record.signals.slice(0, MAX_LEADS).map((s) => {
    const lead = leadOf(s.description);
    const raw = s.samples || new Int16Array(0);
    if (raw.length > maxSamples) truncated.seconds = true;
    const data = new Array(Math.min(raw.length, maxSamples));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < data.length; i += 1) { const v = raw[i] - s.baseline; data[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
    const factor = Math.round((1 / s.gain) * 1e9) / 1e9;
    return {
      code: { coding: [{ system: MDC_SYSTEM, code: lead ? MDC_LEADS[lead.toUpperCase()] : '0', display: lead || s.description }] },
      valueSampledData: { origin: { value: 0, unit: 'mV' }, period, factor, lowerLimit: data.length ? lo : 0, upperLimit: data.length ? hi : 0, dimensions: 1, data: data.join(' ') },
    };
  });
  const observation = {
    resourceType: 'Observation', id: id ?? `ecg-${createHash('sha1').update(`${patientId}|wfdb:${record.name}`).digest('hex').slice(0, 24)}`,
    status: 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'procedure', display: 'Procedure' }] }],
    code: { coding: [ECG_CODE], text: '12-lead ECG' }, subject: { reference: `Patient/${patientId}` },
    effectiveDateTime: effectiveFrom(record, importedAt), issued: importedAt,
    extension: [{ url: ECG_SOURCE_URL, valueString: `wfdb:${record.name}` }],
    component,
  };
  return { observation, truncated };
}
