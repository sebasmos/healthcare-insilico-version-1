// Bed management: the Location hierarchy (site → unit → room
// → bed), the seed layout, and the bed moves themselves. Every move runs
// inside one store transaction through fhir.writeInTx, so the bed state
// machine, the role map and the log apply exactly as they do for any other
// write. The HL7 ADT bridge calls admitToBed, transferToBed and
// dischargeFromBed with the same semantics as the Beds app.
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';
import { PHYSICAL_TYPE_SYSTEM, LIFECYCLE_URL, REASON_URL, isBed, lifecycleOf, withExtension, statusReasonOf, MACHINES } from '../../platform/server/state-machines.mjs';
import { STATE_SINCE_URL, mrnOf } from './clinical-rules.mjs';

export const URLS = {
  unitIsolation: 'urn:hospital-desktop:unit-isolation',
  sexOfBay: 'urn:hospital-desktop:sex-of-bay',
  isolation: 'urn:hospital-desktop:isolation',
  bedRequest: 'urn:hospital-desktop:bed-request',
  expectedDischarge: 'urn:hospital-desktop:expected-discharge',
  reservedFor: 'urn:hospital-desktop:reserved-for',
  stateSince: STATE_SINCE_URL,
};
export const PHYSICAL = { site: 'si', unit: 'wa', room: 'ro', bed: 'bd' };
const PHYSICAL_DISPLAY = { si: 'Site', wa: 'Ward', ro: 'Room', bd: 'Bed' };
export const INPATIENT_CLASSES = ['IMP', 'EMER'];
const OPEN_ENCOUNTER = ['arrived', 'in-progress'];

export const extOf = (doc, url) => (doc?.extension || []).find((e) => e.url === url);
export const boolExt = (doc, url) => extOf(doc, url)?.valueBoolean === true;
const sliceDate = (iso) => (iso || '').slice(0, 10);
export const minutesBetween = (from, to) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60000));
export const physicalOf = (loc) => (loc?.physicalType?.coding || []).find((c) => c.system === PHYSICAL_TYPE_SYSTEM)?.code ?? loc?.physicalType?.coding?.[0]?.code ?? null;
export const bedState = (bed) => lifecycleOf(bed);
export const activeLocation = (encounter) => (encounter?.location || []).find((l) => l.status === 'active' && l.location?.reference?.startsWith('Location/')) ?? null;
export const activeBedId = (encounter) => activeLocation(encounter)?.location.reference.slice('Location/'.length) ?? null;
export const isInpatient = (encounter) => INPATIENT_CLASSES.includes(encounter?.class?.code);
export const isOpen = (encounter) => OPEN_ENCOUNTER.includes(encounter?.status);
export const isolationOf = (encounter) => extOf(encounter, URLS.isolation)?.valueString ?? null;
export const expectedDischargeOf = (encounter) => extOf(encounter, URLS.expectedDischarge)?.valueDate ?? null;

/** The pending bed request on an encounter: { unit, requested, isolation } or null. */
export function bedRequestOf(encounter) {
  const e = extOf(encounter, URLS.bedRequest);
  if (!e) return null;
  const part = (url) => (e.extension || []).find((x) => x.url === url);
  return { unit: part('unit')?.valueReference?.reference?.slice('Location/'.length) ?? null, requested: part('requested')?.valueDateTime ?? null, isolation: part('isolation')?.valueBoolean === true };
}

// ---------- Seed layout ----------
export const HOSPITAL_FILE = path.join(REPO_ROOT, 'data', 'hospital.json');

/** The default hospital: one site, four units. Rooms with one bed are called bays or rooms; beds in shared rooms are lettered. */

const physical = (code) => ({ coding: [{ system: PHYSICAL_TYPE_SYSTEM, code, display: PHYSICAL_DISPLAY[code] }] });
const location = (id, name, code, partOf, extra = {}) => ({
  resourceType: 'Location', id, status: 'active', name, physicalType: physical(code), mode: 'instance',
  ...(partOf ? { partOf: { reference: `Location/${partOf.id}`, display: partOf.name } } : {}), ...extra,
});
const flag = (url) => ({ url, valueBoolean: true });

/** Turns a layout into the Location resources (site, units, rooms, beds) with stable ids. Beds start available. */
export function generateLocations(layout) {
  if (!layout || !Array.isArray(layout.units)) throw new HttpError(422, 'A layout needs { site, units: [...] }');
  if (!layout || typeof layout !== 'object' || !Array.isArray(layout.units) || !layout.units.length) throw new HttpError(422, 'A layout needs a site and at least one unit');
  const site = { id: layout.site?.id || 'site-main', name: layout.site?.name || 'Main' };
  const out = [location(site.id, site.name, PHYSICAL.site, null, { alias: [site.name] })];
  for (const u of layout.units) {
    if (!u?.id || !u.name) throw new HttpError(422, 'Every unit needs an id and a name');
    const unitId = `unit-${u.id}`;
    const unitExt = [u.isolation ? flag(URLS.unitIsolation) : null, u.sexOfBay ? flag(URLS.sexOfBay) : null].filter(Boolean);
    out.push(location(unitId, u.name, PHYSICAL.unit, site, { alias: [u.alias || u.name], ...(unitExt.length ? { extension: unitExt } : {}) }));
    const unit = { id: unitId, name: u.name };
    const rooms = Math.max(1, Number(u.rooms) || 1);
    const perRoom = Math.max(1, Number(u.bedsPerRoom) || 1);
    const roomLabel = u.roomLabel || 'Room';
    for (let r = 1; r <= rooms; r += 1) {
      const roomId = `room-${u.id}-${r}`;
      const isolation = (u.isolationRooms || []).includes(r);
      out.push(location(roomId, `${roomLabel} ${r}`, PHYSICAL.room, unit, { alias: [`${u.alias || u.name} ${roomLabel} ${r}`], ...(isolation ? { extension: [flag(URLS.isolation)] } : {}) }));
      const room = { id: roomId, name: `${roomLabel} ${r}` };
      for (let b = 1; b <= perRoom; b += 1) {
        const letter = perRoom === 1 ? '' : String.fromCharCode(64 + b);
        const bedId = `bed-${u.id}-${r}${letter.toLowerCase()}`;
        const bedName = `Bed ${r}${letter}`;
        out.push(location(bedId, bedName, PHYSICAL.bed, room, { alias: [`${u.alias || u.name} ${bedName}`], ...(isolation ? { extension: [flag(URLS.isolation)] } : {}) }));
      }
    }
  }
  return out;
}

export const toBundle = (locations) => ({ resourceType: 'Bundle', type: 'collection', entry: locations.map((resource) => ({ resource })) });
export const fromBundle = (bundle) => (Array.isArray(bundle?.entry) ? bundle.entry.map((e) => e.resource).filter((r) => r?.resourceType === 'Location') : Array.isArray(bundle?.locations) ? bundle.locations : []);

/** Reads data/hospital.json if it exists; null otherwise. */
export function readHospitalFile(file = HOSPITAL_FILE) {
  if (!fs.existsSync(file)) return null;
  const locations = fromBundle(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!locations.length) throw new HttpError(422, `${path.relative(REPO_ROOT, file)} holds no Location resources`);
  return locations;
}

/** Writes the generated hospital to data/hospital.json (gitignored). Returns the file path. */
export function writeHospitalFile(locations, file = HOSPITAL_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(toBundle(locations), null, 2)}\n`);
  return file;
}

const STATE_URLS = [LIFECYCLE_URL, REASON_URL, URLS.stateSince, URLS.reservedFor];
// Layout fields only: a bed's state, reason, time in state and reservation are not part of the layout.
const layoutOf = (d) => {
  const o = { ...d, extension: (d.extension || []).filter((e) => !STATE_URLS.includes(e.url)) };
  for (const k of ['meta', 'operationalStatus']) delete o[k];
  for (const k of Object.keys(o)) if (k.startsWith('_')) delete o[k];
  if (!o.extension.length) delete o.extension;
  return o;
};
// Compared without regard to the order of keys: PostgreSQL does not keep the order a record was written in.
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const sameLayout = (a, b) => JSON.stringify(canon(layoutOf(a))) === JSON.stringify(canon(layoutOf(b)));

/**
 * Loads the hierarchy, idempotently: a Location whose layout fields are
 * unchanged is skipped; a bed that already exists keeps its state, reason and
 * time in state. Returns { written, unchanged, total }.
 */
export async function loadHospital(store, locations, { actor = { kind: 'human', id: 'seed', role: 'administrator' }, branch = 'main', runId = LIVE_RUN_ID } = {}) {
  return store.transaction(async (tx) => {
    let written = 0;
    let unchanged = 0;
    for (const loc of locations) {
      const existing = await tx.get('Location', loc.id, { branch });
      if (existing && sameLayout(existing, loc)) { unchanged += 1; continue; }
      let doc = { ...loc };
      if (existing) {
        // Keep the bed's state (and the unit's declared constraints are part of the layout, so those are taken from the file).
        const kept = (existing.extension || []).filter((e) => STATE_URLS.includes(e.url));
        doc = { ...doc, extension: [...(loc.extension || []), ...kept] };
        if (!doc.extension.length) delete doc.extension;
        if (existing.operationalStatus) doc.operationalStatus = existing.operationalStatus;
      } else if (isBed(doc)) {
        doc = MACHINES.Location.set(doc, 'available');
        doc = withExtension(doc, URLS.stateSince, 'valueDateTime', tx.now());
      }
      await tx.save('Location', doc, { branch, updatedBy: actor.role });
      written += 1;
    }
    if (written) {
      await recordAction(tx, { runId, actor, kind: 'execute', action: 'bed.seed', args: { written, unchanged, total: locations.length }, branch, description: `hospital layout loaded: ${written} written, ${unchanged} unchanged` });
    }
    return { written, unchanged, total: locations.length };
  });
}

// ---------- Reading the hierarchy ----------
/** Index of every Location with its ancestors resolved: { byId, beds, units, rooms, site, unitOf(bedOrRoom), roomOf(bed), displayOf(bed) }. */
export function hierarchy(locations) {
  const byId = new Map(locations.map((l) => [l.id, l]));
  const parent = (l) => byId.get(l?.partOf?.reference?.slice('Location/'.length)) ?? null;
  const up = (l, code) => { let cur = l; let guard = 0; while (cur && physicalOf(cur) !== code && guard < 8) { cur = parent(cur); guard += 1; } return cur && physicalOf(cur) === code ? cur : null; };
  const roomOf = (bed) => up(bed, PHYSICAL.room);
  const unitOf = (l) => up(l, PHYSICAL.unit);
  const displayOf = (bed) => [unitOf(bed)?.name, roomOf(bed)?.name, bed.name].filter(Boolean).join(' / ');
  const beds = locations.filter(isBed);
  return {
    byId, beds, units: locations.filter((l) => physicalOf(l) === PHYSICAL.unit), rooms: locations.filter((l) => physicalOf(l) === PHYSICAL.room), site: locations.find((l) => physicalOf(l) === PHYSICAL.site) ?? null,
    roomOf, unitOf, displayOf, bedsOfRoom: (room) => beds.filter((b) => b.partOf?.reference === `Location/${room.id}`), bedsOfUnit: (unit) => beds.filter((b) => unitOf(b)?.id === unit.id),
  };
}

/**
 * Finds a bed by id, "Location/id", or an HL7 PV1-3 style { pointOfCare, room, bed }
 * (names or aliases, case-insensitive). Throws 404 when nothing matches.
 */
export function resolveBed(h, ref) {
  if (typeof ref === 'string') {
    const id = ref.startsWith('Location/') ? ref.slice('Location/'.length) : ref;
    const bed = h.byId.get(id);
    if (!bed || !isBed(bed)) throw new HttpError(404, `Bed "${ref}" does not exist`, 'not-found');
    return bed;
  }
  if (ref && typeof ref === 'object') {
    const same = (l, name) => name != null && [l.name, ...(l.alias || [])].some((n) => String(n).toLowerCase() === String(name).toLowerCase());
    const unit = h.units.find((u) => same(u, ref.pointOfCare) || u.id === ref.pointOfCare || u.id === `unit-${ref.pointOfCare}`);
    const candidates = h.beds.filter((b) => (!unit || h.unitOf(b)?.id === unit.id) && (ref.room == null || same(h.roomOf(b) || {}, ref.room)) && (same(b, ref.bed) || b.id === ref.bed));
    if (candidates.length === 1) return candidates[0];
    throw new HttpError(404, `No ${candidates.length ? 'single' : ''} bed matches ${[ref.pointOfCare, ref.room, ref.bed].filter(Boolean).join('^')}`, 'not-found');
  }
  throw new HttpError(422, 'A bed id is required');
}

// ---------- Moves ----------
const requireText = (value, what) => { const s = typeof value === 'string' ? value.trim() : ''; if (s.length < 3) throw new HttpError(422, `${what} is required (at least 3 characters)`); return s; };

async function loadAll(tx, branch) {
  const [locations, encounters, patients] = await Promise.all([tx.query('Location', {}, { branch }), tx.query('Encounter', {}, { branch }), tx.query('Patient', {}, { branch })]);
  return { h: hierarchy(locations), encounters, patients: new Map(patients.map((p) => [`Patient/${p.id}`, p])) };
}

async function loadEncounter(tx, ref, branch) {
  const id = typeof ref === 'string' ? ref.replace(/^Encounter\//, '') : ref?.id;
  const encounter = id ? await tx.get('Encounter', id, { branch }) : null;
  if (!encounter) throw new HttpError(404, `Encounter "${ref}" does not exist`, 'not-found');
  return encounter;
}

const occupantOf = (encounters, bedId) => encounters.find((e) => isOpen(e) && activeBedId(e) === bedId) ?? null;
const sexOf = (patients, encounter) => patients.get(encounter?.subject?.reference)?.gender ?? null;

/** The isolation and sex-of-bay rules, when the bed's unit declares them. Throws 409 with a plain message. */
export function checkConstraints({ h, encounters, patients }, bed, encounter) {
  const unit = h.unitOf(bed);
  const room = h.roomOf(bed);
  if (unit && boolExt(unit, URLS.unitIsolation)) {
    const bedIsolation = boolExt(bed, URLS.isolation) || boolExt(room, URLS.isolation);
    const patientIsolation = Boolean(isolationOf(encounter));
    if (bedIsolation && !patientIsolation) throw new HttpError(409, `${h.displayOf(bed)} is an isolation bed; ${unit.name} keeps it for patients who need isolation`, 'conflict');
    if (!bedIsolation && patientIsolation) throw new HttpError(409, `This patient needs isolation (${isolationOf(encounter)}); choose an isolation bed in ${unit.name}`, 'conflict');
  }
  if (unit && room && boolExt(unit, URLS.sexOfBay)) {
    const mine = sexOf(patients, encounter);
    if (mine !== 'male' && mine !== 'female') return;
    const others = h.bedsOfRoom(room).filter((b) => b.id !== bed.id).map((b) => occupantOf(encounters, b.id)).filter((e) => e && e.id !== encounter.id).map((e) => sexOf(patients, e)).filter((s) => s === 'male' || s === 'female');
    const other = others.find((s) => mine && s !== mine);
    if (other) throw new HttpError(409, `${room.name} in ${unit.name} is a ${other} bay (sex-of-bay rule); this patient is ${mine}`, 'conflict');
  }
}

function assertAssignable(h, bed, encounter, encounters, patients) {
  const state = bedState(bed);
  if (state === 'occupied') {
    const who = occupantOf(encounters, bed.id);
    const name = who ? patients.get(who.subject?.reference)?.name?.[0] : null;
    throw new HttpError(409, `${h.displayOf(bed)} is occupied${name ? ` by ${[name.family, ...(name.given || [])].filter(Boolean).join(', ')}` : ''}`, 'conflict');
  }
  if (state === 'cleaning') throw new HttpError(409, `${h.displayOf(bed)} is being cleaned; mark it clean first`, 'conflict');
  if (state === 'blocked') throw new HttpError(409, `${h.displayOf(bed)} is blocked (${statusReasonOf(bed) || 'no reason recorded'}); unblock it first`, 'conflict');
  if (state === 'reserved') {
    const held = extOf(bed, URLS.reservedFor)?.valueReference?.reference;
    if (held && held !== `Encounter/${encounter.id}`) throw new HttpError(409, `${h.displayOf(bed)} is reserved for another patient`, 'conflict');
  }
}

const bedWrite = async (fhir, tx, ctx, bed, state, { reason = null, reservedFor = undefined } = {}) => {
  let doc = MACHINES.Location.set(bed, state);
  doc = withExtension(doc, REASON_URL, 'valueString', reason);
  if (reservedFor !== undefined) doc = withExtension(doc, URLS.reservedFor, 'valueReference', reservedFor ? { reference: reservedFor } : null);
  return (await fhir.writeInTx(tx, 'Location', bed.id, strip(doc), ctx)).saved;
};
const strip = (doc) => { const o = { ...doc }; for (const k of Object.keys(o)) if (k.startsWith('_')) delete o[k]; return o; };
const encounterWrite = async (fhir, tx, ctx, doc) => (await fhir.writeInTx(tx, 'Encounter', doc.id, strip(doc), ctx)).saved;

const log = (tx, ctx, fields) => recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, branch: ctx.branch ?? 'main', why: ctx.why ?? null, kind: 'execute', ...fields });
const closeActive = (encounter, now) => (encounter.location || []).map((l) => (l.status === 'active' ? { ...l, status: 'completed', period: { ...(l.period || {}), end: now } } : l));
const withoutRequest = (doc) => { const extension = (doc.extension || []).filter((e) => e.url !== URLS.bedRequest); const out = { ...doc, extension }; if (!extension.length) delete out.extension; return out; };

/**
 * Puts an open inpatient or emergency encounter into an available (or reserved for it) bed.
 * deps: { fhir }. bed: id, "Location/id" or { pointOfCare, room, bed }. Returns { encounter, bed, waitedMinutes }.
 */
export async function admitToBed(tx, { encounter: encRef, bed: bedRef, ctx }, { fhir }) {
  const now = tx.now();
  const all = await loadAll(tx, ctx.branch);
  const encounter = await loadEncounter(tx, encRef, ctx.branch);
  if (!isInpatient(encounter)) throw new HttpError(409, 'Only inpatient (IMP) or emergency (EMER) encounters take a bed', 'conflict');
  if (!isOpen(encounter)) throw new HttpError(409, `Encounter is ${encounter.status}; only an arrived or in-progress encounter can be given a bed`, 'conflict');
  const bed = resolveBed(all.h, bedRef);
  const current = activeBedId(encounter);
  if (current) throw new HttpError(409, `This patient is already in ${all.h.displayOf(all.h.byId.get(current) || { name: current })}; use transfer`, 'conflict');
  assertAssignable(all.h, bed, encounter, all.encounters, all.patients);
  checkConstraints(all, bed, encounter);
  const from = bedState(bed);
  const savedBed = await bedWrite(fhir, tx, ctx, bed, 'occupied', { reservedFor: null });
  // Turnaround counts request → assignment; a patient placed without a request has no wait to measure.
  const waitedMinutes = bedRequestOf(encounter)?.requested ? minutesBetween(bedRequestOf(encounter).requested, now) : null;
  const next = withoutRequest({
    ...encounter, status: encounter.status === 'arrived' ? 'in-progress' : encounter.status,
    location: [...closeActive(encounter, now), { location: { reference: `Location/${bed.id}`, display: all.h.displayOf(bed) }, status: 'active', physicalType: bed.physicalType, period: { start: now } }],
  });
  const savedEncounter = await encounterWrite(fhir, tx, ctx, next);
  await log(tx, ctx, { action: 'bed.assign', args: { bed: bed.id, display: all.h.displayOf(bed), encounter: encounter.id, unit: all.h.unitOf(bed)?.id ?? null, from, waitedMinutes }, entityRef: `Location/${bed.id}`, patientRef: encounter.subject?.reference ?? null, description: `assigned ${all.h.displayOf(bed)} to Encounter/${encounter.id}` });
  return { encounter: savedEncounter, bed: savedBed, waitedMinutes };
}

/** Moves the patient to another bed; the bed they leave goes to cleaning. reason is optional. */
export async function transferToBed(tx, { encounter: encRef, bed: bedRef, reason = null, ctx }, { fhir }) {
  const now = tx.now();
  const all = await loadAll(tx, ctx.branch);
  const encounter = await loadEncounter(tx, encRef, ctx.branch);
  if (!isOpen(encounter)) throw new HttpError(409, `Encounter is ${encounter.status}; nothing to transfer`, 'conflict');
  const fromId = activeBedId(encounter);
  const fromBed = fromId ? all.h.byId.get(fromId) : null;
  if (!fromBed) throw new HttpError(409, 'This patient has no bed yet; assign one instead of transferring', 'conflict');
  const bed = resolveBed(all.h, bedRef);
  if (bed.id === fromBed.id) throw new HttpError(409, `The patient is already in ${all.h.displayOf(bed)}`, 'conflict');
  assertAssignable(all.h, bed, encounter, all.encounters, all.patients);
  checkConstraints(all, bed, encounter);
  const savedBed = await bedWrite(fhir, tx, ctx, bed, 'occupied', { reservedFor: null });
  await bedWrite(fhir, tx, ctx, fromBed, 'cleaning', { reason: 'Transfer out' });
  const waitedMinutes = bedRequestOf(encounter)?.requested ? minutesBetween(bedRequestOf(encounter).requested, now) : null;
  const next = withoutRequest({ ...encounter, location: [...closeActive(encounter, now), { location: { reference: `Location/${bed.id}`, display: all.h.displayOf(bed) }, status: 'active', physicalType: bed.physicalType, period: { start: now } }] });
  const savedEncounter = await encounterWrite(fhir, tx, ctx, next);
  await log(tx, ctx, { action: 'bed.transfer', args: { encounter: encounter.id, from: fromBed.id, to: bed.id, display: all.h.displayOf(bed), fromDisplay: all.h.displayOf(fromBed), unit: all.h.unitOf(bed)?.id ?? null, reason, waitedMinutes }, why: reason ?? ctx.why ?? null, entityRef: `Location/${bed.id}`, patientRef: encounter.subject?.reference ?? null, description: `transferred Encounter/${encounter.id} from ${all.h.displayOf(fromBed)} to ${all.h.displayOf(bed)}` });
  return { encounter: savedEncounter, bed: savedBed, fromBed: fromBed.id, waitedMinutes };
}

/** Finishes the encounter through its state machine and sends its bed to cleaning. */
export async function dischargeFromBed(tx, { encounter: encRef, ctx }, { fhir }) {
  const now = tx.now();
  const all = await loadAll(tx, ctx.branch);
  let encounter = await loadEncounter(tx, encRef, ctx.branch);
  if (!isOpen(encounter)) throw new HttpError(409, `Encounter is already ${encounter.status}`, 'conflict');
  const bedId = activeBedId(encounter);
  const bed = bedId ? all.h.byId.get(bedId) : null;
  if (bed) await bedWrite(fhir, tx, ctx, bed, 'cleaning', { reason: 'Discharge' });
  // The Encounter machine goes arrived → in-progress → finished; a patient discharged straight from "arrived" takes both steps.
  if (encounter.status === 'arrived') encounter = await encounterWrite(fhir, tx, ctx, { ...encounter, status: 'in-progress' });
  const next = withoutRequest({ ...encounter, status: 'finished', location: closeActive(encounter, now), period: { ...(encounter.period || {}), end: now } });
  const savedEncounter = await encounterWrite(fhir, tx, ctx, next);
  await log(tx, ctx, { action: 'bed.discharge', args: { encounter: encounter.id, bed: bed?.id ?? null, display: bed ? all.h.displayOf(bed) : null, unit: bed ? all.h.unitOf(bed)?.id ?? null : null }, entityRef: `Encounter/${encounter.id}`, patientRef: encounter.subject?.reference ?? null, description: `discharged Encounter/${encounter.id}${bed ? ` from ${all.h.displayOf(bed)} (bed to cleaning)` : ''}` });
  return { encounter: savedEncounter, bed: bed?.id ?? null };
}

/** cleaning → available. Records how long the bed was dirty (discharge or transfer to clean). */
export async function cleanBed(tx, { bed: bedRef, ctx }, { fhir }) {
  const now = tx.now();
  const all = await loadAll(tx, ctx.branch);
  const bed = resolveBed(all.h, bedRef);
  if (bedState(bed) !== 'cleaning') throw new HttpError(409, `${all.h.displayOf(bed)} is ${bedState(bed)}, not being cleaned`, 'conflict');
  const since = extOf(bed, URLS.stateSince)?.valueDateTime ?? null;
  const dirtyMinutes = since ? minutesBetween(since, now) : null;
  const saved = await bedWrite(fhir, tx, ctx, bed, 'available');
  await log(tx, ctx, { action: 'bed.clean', args: { bed: bed.id, display: all.h.displayOf(bed), unit: all.h.unitOf(bed)?.id ?? null, dirtyMinutes }, entityRef: `Location/${bed.id}`, description: `${all.h.displayOf(bed)} cleaned (${dirtyMinutes ?? '?'} min)` });
  return { bed: saved, dirtyMinutes };
}

/** available or cleaning → blocked, with a reason. */
export async function blockBed(tx, { bed: bedRef, reason, ctx }, { fhir }) {
  const why = requireText(reason, 'A reason to block the bed');
  const all = await loadAll(tx, ctx.branch);
  const bed = resolveBed(all.h, bedRef);
  if (!['available', 'cleaning'].includes(bedState(bed))) throw new HttpError(409, `${all.h.displayOf(bed)} is ${bedState(bed)}; only an available or cleaning bed can be blocked`, 'conflict');
  const saved = await bedWrite(fhir, tx, ctx, bed, 'blocked', { reason: why });
  await log(tx, ctx, { action: 'bed.block', args: { bed: bed.id, display: all.h.displayOf(bed), unit: all.h.unitOf(bed)?.id ?? null, reason: why }, why, entityRef: `Location/${bed.id}`, description: `${all.h.displayOf(bed)} blocked: ${why}` });
  return { bed: saved };
}

/** blocked → available, with a reason. */
export async function unblockBed(tx, { bed: bedRef, reason, ctx }, { fhir }) {
  const why = requireText(reason, 'A reason to unblock the bed');
  const all = await loadAll(tx, ctx.branch);
  const bed = resolveBed(all.h, bedRef);
  if (bedState(bed) !== 'blocked') throw new HttpError(409, `${all.h.displayOf(bed)} is ${bedState(bed)}, not blocked`, 'conflict');
  const saved = await bedWrite(fhir, tx, ctx, bed, 'available', { reason: why });
  await log(tx, ctx, { action: 'bed.unblock', args: { bed: bed.id, display: all.h.displayOf(bed), unit: all.h.unitOf(bed)?.id ?? null, reason: why }, why, entityRef: `Location/${bed.id}`, description: `${all.h.displayOf(bed)} unblocked: ${why}` });
  return { bed: saved };
}

/** available → reserved, optionally for one encounter. */
export async function reserveBed(tx, { bed: bedRef, encounter: encRef = null, ctx }, { fhir }) {
  const all = await loadAll(tx, ctx.branch);
  const bed = resolveBed(all.h, bedRef);
  if (bedState(bed) !== 'available') throw new HttpError(409, `${all.h.displayOf(bed)} is ${bedState(bed)}; only an available bed can be reserved`, 'conflict');
  const encounter = encRef ? await loadEncounter(tx, encRef, ctx.branch) : null;
  if (encounter) checkConstraints(all, bed, encounter);
  const saved = await bedWrite(fhir, tx, ctx, bed, 'reserved', { reservedFor: encounter ? `Encounter/${encounter.id}` : null });
  await log(tx, ctx, { action: 'bed.reserve', args: { bed: bed.id, display: all.h.displayOf(bed), unit: all.h.unitOf(bed)?.id ?? null, encounter: encounter?.id ?? null }, entityRef: `Location/${bed.id}`, patientRef: encounter?.subject?.reference ?? null, description: `${all.h.displayOf(bed)} reserved${encounter ? ` for Encounter/${encounter.id}` : ''}` });
  return { bed: saved };
}

/** reserved → available (the reservation is dropped). */
export async function releaseBed(tx, { bed: bedRef, ctx }, { fhir }) {
  const all = await loadAll(tx, ctx.branch);
  const bed = resolveBed(all.h, bedRef);
  if (bedState(bed) !== 'reserved') throw new HttpError(409, `${all.h.displayOf(bed)} is ${bedState(bed)}, not reserved`, 'conflict');
  const saved = await bedWrite(fhir, tx, ctx, bed, 'available', { reservedFor: null });
  await log(tx, ctx, { action: 'bed.release', args: { bed: bed.id, display: all.h.displayOf(bed), unit: all.h.unitOf(bed)?.id ?? null }, entityRef: `Location/${bed.id}`, description: `${all.h.displayOf(bed)} reservation released` });
  return { bed: saved };
}

/** Puts an open inpatient or emergency encounter on the waiting list (a bed request on the Encounter). */
export async function requestBed(tx, { encounter: encRef, unit = null, isolation = null, ctx }, { fhir }) {
  const now = tx.now();
  const all = await loadAll(tx, ctx.branch);
  const encounter = await loadEncounter(tx, encRef, ctx.branch);
  if (!isInpatient(encounter)) throw new HttpError(409, 'Only inpatient (IMP) or emergency (EMER) encounters can request a bed', 'conflict');
  if (!isOpen(encounter)) throw new HttpError(409, `Encounter is ${encounter.status}; a bed can be requested only for an arrived or in-progress encounter`, 'conflict');
  const unitDoc = unit ? all.h.units.find((u) => u.id === unit || u.id === `unit-${unit}` || u.id === String(unit).replace(/^Location\//, '')) : null;
  if (unit && !unitDoc) throw new HttpError(404, `Unit "${unit}" does not exist`, 'not-found');
  let next = { ...encounter };
  if (isolation) next = withExtension(next, URLS.isolation, 'valueString', isolation === true ? 'Isolation requested' : String(isolation));
  const parts = [{ url: 'requested', valueDateTime: now }];
  if (unitDoc) parts.push({ url: 'unit', valueReference: { reference: `Location/${unitDoc.id}`, display: unitDoc.name } });
  if (isolationOf(next)) parts.push({ url: 'isolation', valueBoolean: true });
  next = { ...withoutRequest(next), extension: [...(withoutRequest(next).extension || []), { url: URLS.bedRequest, extension: parts }] };
  const saved = await encounterWrite(fhir, tx, ctx, next);
  await log(tx, ctx, { action: 'bed.request', args: { encounter: encounter.id, unit: unitDoc?.id ?? null, isolation: Boolean(isolationOf(next)), transfer: Boolean(activeBedId(encounter)) }, entityRef: `Encounter/${encounter.id}`, patientRef: encounter.subject?.reference ?? null, description: `bed requested for Encounter/${encounter.id}${unitDoc ? ` in ${unitDoc.name}` : ''}` });
  return { encounter: saved };
}

// ---------- The board ----------
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const summary = (xs) => ({ count: xs.length, medianMinutes: median(xs), meanMinutes: mean(xs) });

/** Median and mean minutes from discharge to clean and from bed request to assignment, today and over the last 7 days, from the log. */
export function turnaround(steps, now) {
  const today = sliceDate(now);
  const weekAgo = new Date(Date.parse(now) - 7 * 24 * 3600000).toISOString();
  const within = (s, from) => s.when.wall <= now && s.when.wall >= from;
  const pick = (from) => {
    const inWindow = steps.filter((s) => within(s, from));
    return {
      dischargeToClean: summary(inWindow.filter((s) => s.did.type === 'bed.clean' && typeof s.did.args?.dirtyMinutes === 'number').map((s) => s.did.args.dirtyMinutes)),
      requestToAssign: summary(inWindow.filter((s) => ['bed.assign', 'bed.transfer'].includes(s.did.type) && typeof s.did.args?.waitedMinutes === 'number').map((s) => s.did.args.waitedMinutes)),
    };
  };
  return { today: pick(`${today}T00:00:00.000Z`), last7Days: pick(weekAgo) };
}

const patientSummary = (p) => (p ? { id: p.id, name: [p.name?.[0]?.family, ...(p.name?.[0]?.given || [])].filter(Boolean).join(', ') || 'Unnamed patient', mrn: mrnOf(p), sex: p.gender ?? null, birthDate: p.birthDate ?? null } : null);

/** The whole board at one view: units with beds and their state, waiting list, expected discharges, turnaround. */
export async function dashboard(store, { branch = 'main', asOf = null } = {}) {
  const opts = { branch, asOf };
  const now = asOf ?? store.now();
  const [locations, encounters, patientDocs, steps] = await Promise.all([
    store.query('Location', {}, opts), store.query('Encounter', {}, opts), store.query('Patient', {}, opts),
    store.query('TraceStep', { where: (s) => typeof s.did?.type === 'string' && s.did.type.startsWith('bed.') && s.saw?.branch === branch }),
  ]);
  const h = hierarchy(locations);
  const patients = new Map(patientDocs.map((p) => [`Patient/${p.id}`, p]));
  const open = encounters.filter((e) => isInpatient(e) && isOpen(e));
  const byBed = new Map(open.filter((e) => activeBedId(e)).map((e) => [activeBedId(e), e]));
  const encounterSummary = (e) => (e ? {
    id: e.id, class: e.class?.code ?? null, status: e.status, patient: patientSummary(patients.get(e.subject?.reference)), isolation: isolationOf(e),
    admitted: e.period?.start ?? null, expectedDischarge: expectedDischargeOf(e), since: activeLocation(e)?.period?.start ?? null,
  } : null);
  const bedRow = (b) => {
    const state = bedState(b);
    const since = extOf(b, URLS.stateSince)?.valueDateTime ?? b._recordedAt ?? null;
    const room = h.roomOf(b);
    return {
      id: b.id, name: b.name, room: room ? { id: room.id, name: room.name } : null, display: h.displayOf(b), state, operationalStatus: b.operationalStatus?.code ?? null,
      isolation: boolExt(b, URLS.isolation) || boolExt(room, URLS.isolation), reason: statusReasonOf(b), since, minutesInState: since ? minutesBetween(since, now) : null,
      reservedFor: extOf(b, URLS.reservedFor)?.valueReference?.reference?.slice('Encounter/'.length) ?? null, encounter: encounterSummary(byBed.get(b.id) ?? null),
    };
  };
  const units = h.units.map((u) => {
    const beds = h.bedsOfUnit(u).map(bedRow);
    const count = (state) => beds.filter((b) => b.state === state).length;
    return {
      id: u.id, name: u.name, alias: u.alias?.[0] ?? null, constraints: { isolation: boolExt(u, URLS.unitIsolation), sexOfBay: boolExt(u, URLS.sexOfBay) },
      capacity: beds.length, occupied: count('occupied'), available: count('available'), cleaning: count('cleaning'), blocked: count('blocked'), reserved: count('reserved'),
      rooms: h.rooms.filter((r) => r.partOf?.reference === `Location/${u.id}`).map((r) => ({ id: r.id, name: r.name, isolation: boolExt(r, URLS.isolation), beds: beds.filter((b) => b.room?.id === r.id) })),
    };
  });
  const waiting = open.filter((e) => !activeBedId(e) || bedRequestOf(e)).map((e) => {
    const req = bedRequestOf(e);
    const since = req?.requested ?? e.period?.start ?? e._recordedAt;
    const unit = req?.unit ? h.byId.get(req.unit) : null;
    const current = activeBedId(e) ? h.byId.get(activeBedId(e)) : null;
    return { ...encounterSummary(e), kind: current ? 'transfer' : 'admitted', requestedUnit: unit ? { id: unit.id, name: unit.name } : null, currentBed: current ? { id: current.id, display: h.displayOf(current) } : null, since, minutesWaiting: minutesBetween(since, now) };
  }).sort((a, b) => b.minutesWaiting - a.minutesWaiting);
  const today = sliceDate(now);
  const expectedDischarges = open.filter((e) => expectedDischargeOf(e) === today || (e.period?.end && sliceDate(e.period.end) === today)).map((e) => {
    const bed = activeBedId(e) ? h.byId.get(activeBedId(e)) : null;
    return { ...encounterSummary(e), expected: expectedDischargeOf(e) ?? sliceDate(e.period.end), bed: bed ? { id: bed.id, display: h.displayOf(bed) } : null };
  });
  const totals = units.reduce((t, u) => ({ capacity: t.capacity + u.capacity, occupied: t.occupied + u.occupied }), { capacity: 0, occupied: 0 });
  return { now, site: h.site ? { id: h.site.id, name: h.site.name } : null, units, totals, waiting, expectedDischarges, turnaround: turnaround(steps, now) };
}
