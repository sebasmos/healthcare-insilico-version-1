// HL7 v2 parser and builder, hand-written. Honours the delimiters
// declared in MSH-1 and MSH-2, escape sequences, repetitions, components and
// subcomponents. Versions 2.3 to 2.5.1 share this grammar.
//
// Parsed shape: { segments: [{ name, fields }] } where fields[i] is the i-th
// field (1-based in HL7 terms: fields[0] is unused for every segment except
// MSH, where fields[1] is the field separator and fields[2] the encoding
// characters). Each field is a list of repetitions; each repetition a list
// of components; each component a list of subcomponents (strings).

export class Hl7Error extends Error {
  constructor(message, code = 'AE') { super(message); this.code = code; }
}

export const SUPPORTED_VERSIONS = ['2.3', '2.3.1', '2.4', '2.5', '2.5.1'];

export function delimitersOf(text) {
  if (!text.startsWith('MSH') || text.length < 8) throw new Hl7Error('A message must start with an MSH segment', 'AR');
  const field = text[3];
  const [component, repetition, escape, subcomponent] = text.slice(4, 8).split('');
  if (new Set([field, component, repetition, escape, subcomponent]).size !== 5) throw new Hl7Error('MSH-1 and MSH-2 must declare five distinct delimiters', 'AR');
  return { field, component, repetition, escape, subcomponent };
}

export function unescape(value, d) {
  if (!value.includes(d.escape)) return value;
  return value.replace(new RegExp(`\\${d.escape}([^\\${d.escape}]*)\\${d.escape}`, 'g'), (m, code) => {
    if (code === 'F') return d.field;
    if (code === 'S') return d.component;
    if (code === 'T') return d.subcomponent;
    if (code === 'R') return d.repetition;
    if (code === 'E') return d.escape;
    if (code === '.br') return '\n';
    if (/^X[0-9A-Fa-f]+$/.test(code)) return Buffer.from(code.slice(1), 'hex').toString('latin1');
    return m;
  });
}

export function escape(value, d) {
  return String(value ?? '').replace(new RegExp(`[\\${d.escape}\\${d.field}\\${d.component}\\${d.subcomponent}\\${d.repetition}]`, 'g'), (c) => ({ [d.escape]: `${d.escape}E${d.escape}`, [d.field]: `${d.escape}F${d.escape}`, [d.component]: `${d.escape}S${d.escape}`, [d.subcomponent]: `${d.escape}T${d.escape}`, [d.repetition]: `${d.escape}R${d.escape}` }[c]));
}

function parseField(raw, d) {
  return raw.split(d.repetition).map((rep) => rep.split(d.component).map((comp) => comp.split(d.subcomponent).map((sub) => unescape(sub, d))));
}

/** Parses one message. Throws Hl7Error (code AR for a frame problem, AE for a segment problem). */
export function parse(text) {
  const body = String(text).replace(/^\s+/, '').replace(/\r\n|\n/g, '\r');
  const d = delimitersOf(body);
  const lines = body.split('\r').filter((l) => l.length);
  const segments = lines.map((line, i) => {
    const name = line.slice(0, 3);
    if (!/^[A-Z][A-Z0-9]{2}$/.test(name)) throw new Hl7Error(`Segment ${i + 1} has a malformed name "${name}"`);
    if (name === 'MSH') {
      const rest = line.slice(9).split(d.field);
      const fields = [null, [[[d.field]]], [[[line.slice(4, 8)]]], ...rest.map((f) => parseField(f, d))];
      return { name, fields };
    }
    const parts = line.slice(3).split(d.field);
    if (parts[0] !== '') throw new Hl7Error(`Segment ${name} must be followed by the field separator`);
    return { name, fields: [null, ...parts.slice(1).map((f) => parseField(f, d))] };
  });
  const msg = { segments, delimiters: d };
  const type = get(msg, 'MSH', 9, 1);
  const trigger = get(msg, 'MSH', 9, 2);
  const version = get(msg, 'MSH', 12, 1);
  if (!type) throw new Hl7Error('MSH-9 message type is required');
  if (!get(msg, 'MSH', 10)) throw new Hl7Error('MSH-10 message control id is required');
  if (version && !SUPPORTED_VERSIONS.includes(version)) throw new Hl7Error(`Version ${version} is not supported (2.3 to 2.5.1)`);
  return { ...msg, type, trigger, version, controlId: get(msg, 'MSH', 10) };
}

/** Field accessor: get(msg|segment, 'PID', 3, component = 1, subcomponent = 1, repetition = 1). */
export function get(src, name, field, component = 1, subcomponent = 1, repetition = 1) {
  const seg = typeof name === 'string' ? (src.segments || []).find((s) => s.name === name) : (name ?? src);
  if (!seg) return '';
  const f = seg.fields[field];
  if (!f) return '';
  return f[repetition - 1]?.[component - 1]?.[subcomponent - 1] ?? '';
}
export const segmentsNamed = (msg, name) => msg.segments.filter((s) => s.name === name);
export const repetitions = (seg, field) => (seg.fields[field] || []).map((rep) => rep.map((c) => c[0] ?? ''));

/** HL7 TS (YYYYMMDD[HHMM[SS]][+-ZZZZ]) to ISO. */
export function tsToIso(ts) {
  const m = String(ts || '').match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(?:(\d{2}))?)?(?:\.\d+)?([+-]\d{4})?$/);
  if (!m) return null;
  const [, y, mo, da, h = '00', mi = '00', s = '00', tz] = m;
  const zone = tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : 'Z';
  const d = new Date(`${y}-${mo}-${da}T${h}:${mi}:${s}${zone}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
export const isoToTs = (iso) => new Date(iso).toISOString().replace(/[-:T]/g, '').slice(0, 14);

/** Builds a message from [['MSH', f3, f4, ...], ['PID', ...]] where each field is a string, or an array of components (each a string or an array of subcomponents), or an array of repetitions when wrapped as { rep: [...] }. */
export function build(segments, d = { field: '|', component: '^', repetition: '~', escape: '\\', subcomponent: '&' }) {
  const enc = (v) => escape(v, d);
  const comp = (c) => (Array.isArray(c) ? c.map(enc).join(d.subcomponent) : enc(c));
  const field = (f) => (f && typeof f === 'object' && !Array.isArray(f) && f.rep ? f.rep.map((r) => (Array.isArray(r) ? r.map(comp).join(d.component) : enc(r))).join(d.repetition) : Array.isArray(f) ? f.map(comp).join(d.component) : enc(f));
  return segments.map(([name, ...fields]) => (name === 'MSH' ? `MSH${d.field}${d.component}${d.repetition}${d.escape}${d.subcomponent}${d.field}${fields.map(field).join(d.field)}` : `${name}${d.field}${fields.map(field).join(d.field)}`)).join('\r') + '\r';
}

/** An ACK for a parsed (or unparseable) message. */
export function ack({ controlId = '', sendingApp = 'HOSPITAL-DESKTOP', receivingApp = '', receivingFacility = '', version = '2.5.1', now = new Date().toISOString(), code = 'AA', text = '' }) {
  return build([
    ['MSH', sendingApp, 'HOSPITAL', receivingApp, receivingFacility, isoToTs(now), '', ['ACK'], `ACK${controlId.slice(0, 20)}${isoToTs(now).slice(8)}`, 'P', version],
    ['MSA', code, controlId, text.slice(0, 80)],
  ]);
}

export const MLLP = { VT: 0x0b, FS: 0x1c, CR: 0x0d };
export const mllpFrame = (text) => Buffer.concat([Buffer.from([MLLP.VT]), Buffer.from(text, 'latin1'), Buffer.from([MLLP.FS, MLLP.CR])]);
