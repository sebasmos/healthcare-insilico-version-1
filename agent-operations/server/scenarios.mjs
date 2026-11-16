// Scenarios and timelines (plan-master task 11). A scenario is a patient's
// history plus a timeline: the moment a run starts (T0) and every event after
// it, in relative time. History is in the chart when a run starts; events are
// released into the chart only when the run's clock reaches them, through
// the normal store, so as-of reads keep working. Scenarios are versioned:
// saving makes a new version, old ones stay, and runs record which they used.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { FHIR_TYPES } from '../../platform/server/validate.mjs';
import { HTEST } from './hitl.mjs';
import { scenarioLibrary } from './cases.mjs';
import { normalizeStream, previewStream } from '../../ehr/server/wearables.mjs';
import { CLOCK_MODES, fmtAt } from '../../platform/server/simclock.mjs';

export { CLOCK_MODES, fmtAt };

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scenarios');
const MR = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR', display: 'Medical record number' }] };
const UNIT = { m: 1, h: 60, d: 1440, w: 10080 };

export const KINDS = ['patient-arrives', 'vitals', 'lab-ordered', 'lab-preliminary', 'lab-final', 'lab-corrected', 'image-available', 'report-final', 'note-written', 'medication-given', 'nurse-message', 'patient-message', 'consult-reply', 'wearable-stream', 'deterioration', 'discharge', 'custom'];
export const LANES = ['Vitals', 'Labs', 'Imaging', 'Notes', 'Medications', 'Messages', 'Wearables', 'Events'];
const LANE_OF = { vitals: 'Vitals', deterioration: 'Vitals', 'lab-ordered': 'Labs', 'lab-preliminary': 'Labs', 'lab-final': 'Labs', 'lab-corrected': 'Labs', 'image-available': 'Imaging', 'report-final': 'Imaging', 'note-written': 'Notes', 'medication-given': 'Medications', 'nurse-message': 'Messages', 'patient-message': 'Messages', 'consult-reply': 'Messages', 'wearable-stream': 'Wearables' };
export const laneOf = (kind) => LANE_OF[kind] || 'Events';
export const VISIBLE_TO = ['everyone', 'agent', 'human'];
export const SPLITS = ['practice', 'test'];
const SLUG = /^[a-z0-9][a-z0-9-]{1,60}$/;

/** Relative time: minutes from T0. Accepts a number of minutes, "T+40m", "T-2h", "Day 2 08:00" (Day 1 is T0's day) or "+90". */
export function parseAt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  const s = String(value ?? '').trim();
  let m = s.match(/^(?:T\s*)?([+-])\s*(\d+(?:\.\d+)?)\s*([mhdw])$/i);
  if (m) return Math.round((m[1] === '-' ? -1 : 1) * Number(m[2]) * UNIT[m[3].toLowerCase()]);
  m = s.match(/^(?:T\s*)?([+-])\s*(\d+)\s*h\s*(\d+)\s*m?$/i);
  if (m) return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  m = s.match(/^day\s*(\d+)\s+(\d{1,2}):(\d{2})$/i);
  if (m) return (Number(m[1]) - 1) * 1440 + Number(m[2]) * 60 + Number(m[3]);
  m = s.match(/^([+-]?\d+)$/);
  if (m) return Number(m[1]);
  throw new HttpError(422, `"${value}" is not a time. Use minutes from the start (90), "T+1h 30m", "T-2d" or "Day 2 08:00"`);
}
/** Resolves the relative strings inside a resource ("@t+40m", "@now-50m", "@day2 08:00") against an absolute T0. */
export function absolutize(value, t0Ms, map = null) {
  return JSON.parse(JSON.stringify(value), (key, v) => {
    if (typeof v !== 'string') return v;
    if (map && map.has(v)) return map.get(v);
    let m = v.match(/^@(?:t|now)([+-])(\d+(?:\.\d+)?)([mhdw])$/i);
    if (m) return new Date(t0Ms + (m[1] === '-' ? -1 : 1) * Number(m[2]) * UNIT[m[3].toLowerCase()] * 60000).toISOString();
    m = v.match(/^@day\s*(\d+)\s+(\d{1,2}):(\d{2})$/i);
    if (m) return new Date(t0Ms + ((Number(m[1]) - 1) * 1440 + Number(m[2]) * 60 + Number(m[3])) * 60000).toISOString();
    if (v === '@t0' || v === '@now') return new Date(t0Ms).toISOString();
    return v;
  });
}
const relMinutes = (v) => { const m = String(v).match(/^@(?:t|now)([+-])(\d+(?:\.\d+)?)([mhdw])$/i); return m ? (m[1] === '-' ? -1 : 1) * Number(m[2]) * UNIT[m[3].toLowerCase()] : null; };

const text = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const codeOf = (r) => (r?.code?.coding || [])[0]?.code || r?.code?.text || null;

/** Validates one event; returns the stored form. */
export function normalizeEvent(e, i) {
  if (!e || typeof e !== 'object') throw new HttpError(422, `Event ${i + 1} must be an object`);
  const kind = KINDS.includes(e.kind) ? e.kind : null;
  if (!kind) throw new HttpError(422, `Event ${i + 1}: kind must be one of ${KINDS.join(', ')}`);
  const at = parseAt(e.at ?? 0);
  const visibleTo = e.visibleTo ?? 'everyone';
  if (!VISIBLE_TO.includes(visibleTo)) throw new HttpError(422, `Event ${i + 1}: visibleTo must be everyone, agent or human`);
  const resources = Array.isArray(e.resources) ? e.resources : e.resource ? [e.resource] : [];
  if (resources.length > 40) throw new HttpError(422, `Event ${i + 1}: at most 40 records per event`);
  for (const r of resources) { if (!r || !FHIR_TYPES.has(r.resourceType)) throw new HttpError(422, `Event ${i + 1}: unsupported record type "${r?.resourceType}"`); if (Object.keys(r).some((k) => k.startsWith('_'))) throw new HttpError(422, `Event ${i + 1}: records cannot set internal fields`); }
  const out = { id: typeof e.id === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(e.id) ? e.id : `ev-${i + 1}`, at, kind, lane: LANES.includes(e.lane) ? e.lane : laneOf(kind), label: text(e.label, 120) || null, note: text(e.note, 600) || null, visibleTo, resources };
  if (kind === 'wearable-stream') { out.stream = normalizeStream(e.stream || {}); out.durationMinutes = Math.max(5, Math.min(60 * 24 * 60, Number(e.durationMinutes) || out.stream.durationMinutes || 1440)); }
  if (e.goal) out.goal = text(e.goal, 300);
  if (e.generated) out.generated = true;
  return out;
}

/** Validates a scenario body. existing: the version being replaced. */
export function normalizeScenario(input, existing = null, { source = 'made-here' } = {}) {
  if (!input || typeof input !== 'object') throw new HttpError(422, 'A scenario object is required');
  const title = text(input.title ?? existing?.title, 160);
  if (!title) throw new HttpError(422, 'A scenario needs a title');
  const events = (Array.isArray(input.events) ? input.events : existing?.events ?? []).map(normalizeEvent).sort((a, b) => a.at - b.at);
  const seen = new Set(); for (const e of events) { let id = e.id; let n = 1; while (seen.has(id)) { n += 1; id = `${e.id}-${n}`; } e.id = id; seen.add(id); }
  const bundle = Array.isArray(input.bundle) ? input.bundle : existing?.bundle ?? [];
  if (bundle.length > 200) throw new HttpError(422, 'At most 200 history records');
  for (const r of bundle) { if (!r || !FHIR_TYPES.has(r.resourceType) || r.resourceType === 'AuditEvent') throw new HttpError(422, `Unsupported record type "${r?.resourceType}" in the history`); if (typeof r.id !== 'string' || !/^[A-Za-z0-9.-]{1,64}$/.test(r.id)) throw new HttpError(422, `Every history record needs a short id (${r.resourceType})`); }
  const patient = typeof input.patient === 'string' && input.patient ? input.patient : existing?.patient ?? (bundle.find((r) => r.resourceType === 'Patient') ? `Patient/${bundle.find((r) => r.resourceType === 'Patient').id}` : null);
  if (!patient) throw new HttpError(422, 'A scenario needs a patient: a Patient record in its history, or a reference to one in the chart');
  const split = input.split ?? existing?.split ?? 'practice';
  if (!SPLITS.includes(split)) throw new HttpError(422, 'split must be practice or test');
  const clock = input.clock ?? existing?.clock ?? 'real';
  if (!CLOCK_MODES.includes(clock)) throw new HttpError(422, `clock must be one of ${CLOCK_MODES.join(', ')}`);
  const chapters = Array.isArray(input.chapters ?? existing?.chapters) ? (input.chapters ?? existing.chapters).map((c, i) => ({ title: text(c.title, 80) || `Chapter ${i + 1}`, at: parseAt(c.at ?? 0) })).sort((a, b) => a.at - b.at) : [];
  const lengthMinutes = Math.max(0, ...events.map((e) => e.at + (e.durationMinutes || 0)), ...chapters.map((c) => c.at), Number(input.lengthMinutes) || 0);
  return {
    resourceType: 'Scenario', id: randomUUID(), family: existing?.family ?? (typeof input.family === 'string' && SLUG.test(input.family) ? input.family : randomUUID()),
    version: (existing?.version ?? 0) + 1, previous: existing?.id ?? null, title, summary: text(input.summary ?? existing?.summary, 1000), patient, bundle, t0: text(input.t0 ?? existing?.t0, 80) || 'Start', events, chapters,
    lengthMinutes, tags: (Array.isArray(input.tags) ? input.tags : existing?.tags ?? []).map((t) => text(t, 30)).filter(Boolean).slice(0, 12), split, clock, speed: Math.max(1, Math.min(3600, Number(input.speed ?? existing?.speed) || 60)),
    source: existing?.source ?? source, licence: text(input.licence ?? existing?.licence, 120) || 'synthetic, CC0', status: 'active', previewBranch: null,
  };
}

/** Plain warnings about a timeline (11.1). They never block a save. */
export function warningsFor(scenario) {
  const out = []; const warn = (e, message) => out.push({ event: e?.id ?? null, at: e?.at ?? null, message });
  const events = scenario.events;
  const codesIn = (e) => e.resources.map(codeOf).filter(Boolean);
  const orderedBefore = (e, code) => events.some((x) => x.kind === 'lab-ordered' && x.at <= e.at && x !== e && codesIn(x).includes(code)) || (scenario.bundle || []).some((r) => r.resourceType === 'ServiceRequest' && codeOf(r) === code);
  const discharge = events.find((e) => e.kind === 'discharge');
  for (const e of events) {
    if (['lab-preliminary', 'lab-final'].includes(e.kind)) for (const code of codesIn(e)) if (!orderedBefore(e, code)) warn(e, `A result for ${code} arrives at ${fmtAt(e.at)} but nothing ordered it earlier`);
    if (e.kind === 'lab-final') for (const code of codesIn(e)) { const prelim = events.find((x) => x.kind === 'lab-preliminary' && codesIn(x).includes(code)); if (prelim && prelim.at > e.at) warn(e, `The final result for ${code} (${fmtAt(e.at)}) comes before its preliminary (${fmtAt(prelim.at)})`); }
    if (e.kind === 'lab-corrected') for (const code of codesIn(e)) if (!events.some((x) => ['lab-preliminary', 'lab-final'].includes(x.kind) && x.at < e.at && codesIn(x).includes(code))) warn(e, `A correction for ${code} at ${fmtAt(e.at)} has no earlier result to correct`);
    if (discharge && e !== discharge && e.at > discharge.at) warn(e, `${e.label || e.kind} at ${fmtAt(e.at)} is after the discharge at ${fmtAt(discharge.at)}`);
    if (e.kind === 'medication-given') for (const r of e.resources) { const code = r.medicationCodeableConcept?.coding?.[0]?.code || r.medicationCodeableConcept?.text; if (code && !events.some((x) => x.at <= e.at && x.resources.some((y) => y.resourceType === 'MedicationRequest' && (y.medicationCodeableConcept?.coding?.[0]?.code === code || y.medicationCodeableConcept?.text === code))) && !(scenario.bundle || []).some((y) => y.resourceType === 'MedicationRequest' && (y.medicationCodeableConcept?.coding?.[0]?.code === code || y.medicationCodeableConcept?.text === code))) warn(e, `${code} is given at ${fmtAt(e.at)} but was never ordered`); }
  }
  return out;
}

// ---------- Built-in content (11.4) ----------
const obs = (code, name, value, unit, extra = {}) => ({ resourceType: 'Observation', status: 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: extra.category || 'laboratory' }] }], code: { coding: [{ system: 'http://loinc.org', code, display: name }], text: name }, subject: { reference: 'Patient/pt' }, effectiveDateTime: '@t0', valueQuantity: { value, unit, system: 'http://unitsofmeasure.org', code: unit }, ...(extra.basedOn ? { basedOn: [{ reference: extra.basedOn }] } : {}) });
const vitals = (hr, sbp, spo2, temp, rr) => [obs('8867-4', 'Heart rate', hr, '/min', { category: 'vital-signs' }), obs('8480-6', 'Systolic blood pressure', sbp, 'mm[Hg]', { category: 'vital-signs' }), obs('59408-5', 'Oxygen saturation', spo2, '%', { category: 'vital-signs' }), obs('8310-5', 'Body temperature', temp, 'Cel', { category: 'vital-signs' }), obs('9279-1', 'Respiratory rate', rr, '/min', { category: 'vital-signs' })];
const order = (id, code, name, cat = 'laboratory') => ({ resourceType: 'ServiceRequest', id, status: 'active', intent: 'order', priority: 'urgent', subject: { reference: 'Patient/pt' }, authoredOn: '@t0', category: [{ coding: [{ system: 'urn:hospital-desktop:order-category', code: cat }] }], code: { coding: [{ system: 'http://loinc.org', code, display: name }], text: name } });
const nurseMsg = (textValue) => ({ resourceType: 'Communication', status: 'completed', subject: { reference: 'Patient/pt' }, sender: { display: 'Nurse' }, sent: '@t0', topic: { text: 'Nursing update' }, payload: [{ contentString: textValue }] });
const patientMsg = (topic, textValue) => ({ resourceType: 'Communication', status: 'completed', subject: { reference: 'Patient/pt' }, sender: { reference: 'Patient/pt' }, sent: '@t0', topic: { text: topic }, payload: [{ contentString: textValue }] });
const report = (textValue) => ({ resourceType: 'DiagnosticReport', status: 'final', code: { text: 'Imaging report' }, subject: { reference: 'Patient/pt' }, effectiveDateTime: '@t0', conclusion: textValue });
const note = (title, body) => ({ resourceType: 'DocumentReference', status: 'current', docStatus: 'final', type: { text: title }, subject: { reference: 'Patient/pt' }, date: '@t0', content: [{ attachment: { contentType: 'text/plain', data: Buffer.from(body, 'utf8').toString('base64') } }] });
const ev = (at, kind, label, resources, note2 = null, extra = {}) => ({ at, kind, label, resources, note: note2, ...extra });

/** Editor templates: none ship with the release. A new scenario starts empty or from a patient already loaded. */
export function templates() { return []; }

export function createScenarios({ store, fhir = null }) {
  const human = (ctx) => { if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only people can make or change scenarios'); };
  const log = (tx, ctx, action, args, entityRef, description) => recordAction(tx, { actor: ctx.actor, kind: action.endsWith('create') || action.endsWith('import') ? 'create' : 'update', action, args, entityRef, description });
  const all = async () => (await store.query('Scenario')).filter((s) => s.resourceType === 'Scenario');
  const present = (s) => { const { _seq, bundle, ...rest } = s; return { ...rest, historyCount: (bundle || []).length, warnings: warningsFor(s) }; };

  /** Nothing is built in. Kept so callers need not change: it adds no scenarios. */
  async function ensureBuiltins() { return []; }
  const latestByFamily = async () => { const byFam = new Map(); for (const s of await all()) if (!byFam.has(s.family) || byFam.get(s.family).version < s.version) byFam.set(s.family, s); return [...byFam.values()].sort((a, b) => a.title.localeCompare(b.title)); };
  async function get(id) { const s = await store.get('Scenario', id); if (!s) throw new HttpError(404, `No scenario ${id}`); return s; }

  async function save(body, ctx, existingId = null) {
    human(ctx);
    const existing = existingId ? await get(existingId) : null;
    const doc = normalizeScenario(body, existing);
    return store.transaction(async (tx) => {
      const saved = await tx.save('Scenario', doc, { updatedBy: ctx.actor.role });
      await log(tx, ctx, existing ? 'scenario.version' : 'scenario.create', { scenario: saved.id, family: saved.family, version: saved.version, events: saved.events.length }, `Scenario/${saved.id}`, `scenario ${existing ? 'new version' : 'created'}: ${saved.title} v${saved.version}`);
      return present(saved);
    });
  }
  /** Duplicate as variant: a copy in a new family, version 1. */
  async function variant(id, body, ctx) {
    human(ctx);
    const base = await get(id);
    const doc = normalizeScenario({ ...base, ...(body || {}), title: text(body?.title, 160) || `${base.title} (variant)`, family: undefined }, null, { source: 'made-here' });
    doc.variantOf = base.id;
    return store.transaction(async (tx) => { const saved = await tx.save('Scenario', doc, { updatedBy: ctx.actor.role }); await log(tx, ctx, 'scenario.create', { scenario: saved.id, variantOf: base.id }, `Scenario/${saved.id}`, `scenario variant: ${saved.title}`); return present(saved); });
  }

  /** Way one: from a patient already in the chart. Everything dated before T0 is history; everything after becomes events at its own relative time. */
  async function fromPatient(body, ctx) {
    human(ctx);
    const [type, pid] = String(body?.patient || '').split('/');
    if (type !== 'Patient' || !pid) throw new HttpError(422, 'patient must look like Patient/<id>');
    const t0 = body?.t0 ? Date.parse(body.t0) : NaN;
    if (Number.isNaN(t0)) throw new HttpError(422, 't0 must be a date-time: the moment the run starts');
    const rows = (await store.everything(`Patient/${pid}`, { branch: ctx.branch })).filter((r) => r.resourceType !== 'AuditEvent' && r.resourceType !== 'Provenance');
    if (!rows.some((r) => r.resourceType === 'Patient')) throw new HttpError(404, `${body.patient} is not in the chart`);
    const whenOf = (r) => Date.parse(r.effectiveDateTime || r.issued || r.sent || r.authoredOn || r.date || r.recordedDate || r.period?.start || r._validAt || r._recordedAt || '');
    const strip = (r) => { const out = {}; for (const [k, v] of Object.entries(r)) if (!k.startsWith('_')) out[k] = v; return out; };
    const kindOf = (r) => (r.resourceType === 'Observation' ? ((r.category || []).some((c) => (c.coding || []).some((x) => x.code === 'vital-signs')) ? 'vitals' : (r.category || []).some((c) => (c.coding || []).some((x) => x.code === 'home-reading')) ? 'wearable-stream' : r.status === 'preliminary' ? 'lab-preliminary' : r.status === 'corrected' ? 'lab-corrected' : 'lab-final') : r.resourceType === 'ServiceRequest' ? 'lab-ordered' : r.resourceType === 'DiagnosticReport' ? 'report-final' : r.resourceType === 'ImagingStudy' ? 'image-available' : r.resourceType === 'DocumentReference' ? 'note-written' : r.resourceType === 'MedicationAdministration' ? 'medication-given' : r.resourceType === 'Communication' ? (r.sender?.reference?.startsWith('Patient/') ? 'patient-message' : 'nurse-message') : 'custom');
    const bundle = []; const events = [];
    for (const r of rows) {
      const at = whenOf(r);
      if (r.resourceType === 'Patient' || Number.isNaN(at) || at < t0) { bundle.push(strip(r)); continue; }
      const minutes = Math.round((at - t0) / 60000);
      const kind = kindOf(r);
      if (kind === 'wearable-stream') continue;
      events.push({ at: minutes, kind, label: `${r.resourceType}${r.code?.text || r.code?.coding?.[0]?.display ? `: ${r.code?.text || r.code?.coding?.[0]?.display}` : ''}`.slice(0, 120), resources: [strip(r)], note: 'From the record\'s own timestamp' });
    }
    const doc = normalizeScenario({ title: text(body.title, 160) || `From ${body.patient}`, summary: text(body.summary, 1000) || `Built from the chart of ${body.patient} with T0 at ${new Date(t0).toISOString()}`, patient: `Patient/${pid}`, bundle, events, clock: body.clock || 'real', tags: ['from-data'] }, null, { source: 'made-here' });
    doc.fromPatient = { patient: `Patient/${pid}`, t0: new Date(t0).toISOString() };
    return store.transaction(async (tx) => { const saved = await tx.save('Scenario', doc, { updatedBy: ctx.actor.role }); await log(tx, ctx, 'scenario.create', { scenario: saved.id, from: `Patient/${pid}`, events: saved.events.length }, `Scenario/${saved.id}`, `scenario from data: ${saved.title}`); return present(saved); });
  }

  /** Way three: packs. Plain-English errors. */
  function validatePack(pack) {
    const fail = (m) => { throw new HttpError(422, `Scenario pack: ${m}`); };
    if (!pack || typeof pack !== 'object') fail('the file must contain a JSON object');
    if (pack.format !== 'hospital-desktop-scenario-pack') fail('the "format" field must be "hospital-desktop-scenario-pack" (see docs/SCENARIOS.md)');
    if (!pack.scenario || typeof pack.scenario !== 'object') fail('a "scenario" object is required');
    if (!Array.isArray(pack.scenario.bundle) || !pack.scenario.bundle.some((r) => r?.resourceType === 'Patient')) fail('the scenario history needs at least one Patient record');
    if (!Array.isArray(pack.scenario.events)) fail('"scenario.events" must be a list (it may be empty)');
    if (pack.scenario.bundle.some((r) => r?.resourceType === 'Patient' && !(r.meta?.security || []).some((s) => s.code === 'HTEST') && pack.synthetic !== true)) fail('packs must say "synthetic": true, or mark every Patient as test data (HTEST)');
    return normalizeScenario(pack.scenario, null, { source: 'uploaded' });
  }
  async function importPack(pack, ctx) {
    human(ctx);
    const doc = validatePack(pack);
    doc.licence = text(pack.licence, 120) || doc.licence; doc.author = text(pack.author, 120) || null;
    if (pack.redTeam && typeof pack.redTeam === 'object') doc.redTeam = pack.redTeam;
    return store.transaction(async (tx) => { const saved = await tx.save('Scenario', doc, { updatedBy: ctx.actor.role }); await log(tx, ctx, 'scenario.import', { scenario: saved.id, events: saved.events.length }, `Scenario/${saved.id}`, `scenario pack imported: ${saved.title}`); return present(saved); });
  }
  async function exportPack(id) {
    const s = await get(id);
    const { _seq, _recordedAt, _validAt, _branch, _updatedBy, _patient, meta, previewBranch, status, ...scenario } = s;
    return { format: 'hospital-desktop-scenario-pack', version: 1, exportedAt: store.now(), synthetic: true, licence: s.licence, author: s.author ?? null, scenario, ...(s.redTeam ? { redTeam: s.redTeam } : {}) };
  }

  /** Absolute records for a run: history (negative times) and the events, relative to T0. ids are made unique per run. */
  function materialize(scenario, t0Ms) {
    const map = new Map();
    for (const r of scenario.bundle) map.set(`${r.resourceType}/${r.id}`, `${r.resourceType}/${randomUUID()}`);
    for (const e of scenario.events) for (const r of e.resources) if (r.id) map.set(`${r.resourceType}/${r.id}`, `${r.resourceType}/${randomUUID()}`);
    const history = scenario.bundle.map((r) => { const doc = absolutize(r, t0Ms, map); doc.id = map.get(`${r.resourceType}/${r.id}`).split('/')[1]; const rel = relMinutes(r.effectiveDateTime || r.issued || r.authoredOn || r.date || r.sent || r.period?.start || '') ?? -1; return { doc, atMinutes: Math.min(rel, -1) }; });
    const patientRef = map.get(scenario.patient) || scenario.patient;
    const events = scenario.events.map((e) => ({ ...e, resources: e.resources.map((r) => { const doc = absolutize({ ...r, effectiveDateTime: r.effectiveDateTime ?? (r.resourceType === 'Observation' ? '@t0' : undefined), sent: r.sent ?? (r.resourceType === 'Communication' ? '@t0' : undefined) }, t0Ms + e.at * 60000, map); if (r.id) doc.id = map.get(`${r.resourceType}/${r.id}`).split('/')[1]; if (!doc.subject && doc.resourceType !== 'Patient') doc.subject = { reference: patientRef }; return doc; }) }));
    return { history, events, patientRef, map };
  }

  /** The preview branch for a version (11.3): everything written at its real time in the past, so the as-of engine can scrub it. Made once per version. */
  async function previewBranch(id, ctx) {
    const s = await get(id);
    if (s.previewBranch) { const b = await store.getBranch(s.previewBranch).catch(() => null); if (b && !b.droppedAt) return { branch: s.previewBranch, t0: s.previewT0, lengthMinutes: s.lengthMinutes }; }
    const nowMs = Date.parse(store.now());
    const t0Ms = nowMs - (s.lengthMinutes + 1) * 60000;
    const { history, events, patientRef } = materialize(s, t0Ms);
    const earliest = Math.min(-1, ...history.map((h) => h.atMinutes));
    const branch = await store.fork({ parentBranch: 'main', forkedAt: new Date(t0Ms + (earliest - 1) * 60000).toISOString(), kind: 'sandbox' });
    await store.transaction(async (tx) => {
      for (const h of history) await tx.save(h.doc.resourceType, h.doc.resourceType === 'Patient' ? { ...h.doc, name: [{ family: `Patient ${h.doc.id.slice(0, 8)}` }], meta: { ...(h.doc.meta || {}), security: [HTEST] } } : { ...h.doc, _patient: patientRef }, { branch, updatedBy: 'scenario', recordedAt: new Date(t0Ms + h.atMinutes * 60000).toISOString() });
      for (const e of events) {
        const at = new Date(t0Ms + e.at * 60000).toISOString();
        for (const doc of e.resources) await tx.save(doc.resourceType, { ...doc, id: doc.id || randomUUID(), _patient: patientRef }, { branch, updatedBy: 'scenario', recordedAt: at });
        if (e.kind === 'wearable-stream') for (const doc of previewStream(e, patientRef, t0Ms)) await tx.save('Observation', { ...doc, id: randomUUID(), _patient: patientRef }, { branch, updatedBy: 'scenario', recordedAt: doc.effectiveDateTime });
      }
      const current = await tx.get('Scenario', s.id);
      await tx.save('Scenario', { ...current, previewBranch: branch, previewT0: new Date(t0Ms).toISOString() }, { updatedBy: 'system' });
      await log(tx, ctx, 'scenario.preview', { scenario: s.id, branch }, `Scenario/${s.id}`, `scenario preview branch ${branch}`);
    });
    return { branch, t0: new Date(t0Ms).toISOString(), lengthMinutes: s.lengthMinutes, patient: patientRef };
  }
  /** What the chart holds at a moment of the preview: an as-of read on the preview branch. */
  async function previewAt(id, atMinutes, ctx) {
    const pv = await previewBranch(id, ctx);
    const asOf = new Date(Date.parse(pv.t0) + parseAt(atMinutes) * 60000).toISOString();
    const rows = (await store.everything(pv.patient, { branch: pv.branch, asOf })).filter((r) => r.resourceType !== 'AuditEvent');
    return { ...pv, asOf, at: parseAt(atMinutes), resources: rows.map((r) => ({ ref: `${r.resourceType}/${r.id}`, type: r.resourceType, label: r.code?.text || r.code?.coding?.[0]?.display || r.topic?.text || r.type?.text || r.description || r.resourceType, at: r.effectiveDateTime || r.sent || r.authoredOn || r.date || r._validAt, value: r.valueQuantity ? `${r.valueQuantity.value} ${r.valueQuantity.unit || ''}`.trim() : r.conclusion || r.payload?.[0]?.contentString?.slice(0, 80) || null })) };
  }

  async function handle(req, url, body, ctx, parts) {
    const [area, id, op] = parts; const m = req.method;
    if (area !== 'scenarios') return null;
    if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Agents may not read or change scenarios');
    await ensureBuiltins();
    if (parts.length === 1 && m === 'GET') { const list = url.searchParams.get('all') === 'true' ? await all() : await latestByFamily(); return { status: 200, body: { scenarios: list.map(present), kinds: KINDS, lanes: LANES, clocks: CLOCK_MODES } }; }
    if (parts.length === 1 && m === 'POST') return { status: 201, body: await save(body, ctx) };
    if (id === 'templates' && m === 'GET') return { status: 200, body: { templates: templates() } };
    if (id === 'from-patient' && m === 'POST') return { status: 201, body: await fromPatient(body, ctx) };
    if (id === 'import' && m === 'POST') return { status: 201, body: await importPack(body, ctx) };
    if (id === 'validate' && m === 'POST') { const doc = normalizeScenario(body, null); return { status: 200, body: { ok: true, warnings: warningsFor(doc), lengthMinutes: doc.lengthMinutes } }; }
    if (id && parts.length === 2 && m === 'GET') { const s = await get(id); return { status: 200, body: { ...present(s), bundle: s.bundle, versions: (await all()).filter((x) => x.family === s.family).map((x) => ({ id: x.id, version: x.version, createdAt: x._recordedAt })).sort((a, b) => a.version - b.version) } }; }
    if (id && parts.length === 2 && m === 'PUT') return { status: 200, body: await save(body, ctx, id) };
    if (id && op === 'variant' && m === 'POST') return { status: 201, body: await variant(id, body, ctx) };
    if (id && op === 'export' && m === 'GET') return { status: 200, body: await exportPack(id) };
    if (id && op === 'preview' && m === 'POST') return { status: 200, body: await previewBranch(id, ctx) };
    if (id && op === 'preview' && m === 'GET') return { status: 200, body: await previewAt(id, url.searchParams.get('at') ?? 0, ctx) };
    if (id && op === 'warnings' && m === 'GET') return { status: 200, body: { warnings: warningsFor(await get(id)) } };
    return null;
  }

  return { handle, get, save, variant, fromPatient, importPack, exportPack, materialize, previewBranch, previewAt, ensureBuiltins, latestByFamily, warningsFor, templates };
}

export const packHash = (pack) => createHash('sha256').update(JSON.stringify(pack)).digest('hex').slice(0, 16);
