// Bed management: the Location hierarchy and its idempotent
// seed, the bed state machine, assign / transfer / discharge / clean / block /
// reserve, the isolation and sex-of-bay rules, the waiting list, expected
// discharges, turnaround maths, time travel, and who may move a patient.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, testClock, patient, BACKEND } from './support/helpers.mjs';
import { generateLocations, resolveBed, hierarchy, URLS } from '../ehr/server/beds.mjs';

// A layout for these tests only: no layout ships with the release.
const DEFAULT_LAYOUT = { site: { id: 'site-main', name: 'Main' }, units: [{ id: 'ed', name: 'Emergency department', alias: 'ED', rooms: 12, bedsPerRoom: 1, roomLabel: 'Bay' }, { id: 'med', name: 'Medical ward', alias: 'MED', rooms: 6, bedsPerRoom: 4, sexOfBay: true }, { id: 'surg', name: 'Surgical ward', alias: 'SURG', rooms: 5, bedsPerRoom: 4 }, { id: 'icu', name: 'Intensive care unit', alias: 'ICU', rooms: 8, bedsPerRoom: 1, isolation: true, isolationRooms: [7, 8] }] };

const as = (role, user = `${role}-one`) => ({ 'X-Role': role, 'X-User-Id': user });
const admin = as('physician');
const bedmgr = as('nurse');
const MIN = 60_000;
const stateOf = (loc) => loc.extension?.find((e) => e.url === 'urn:hospital-desktop:lifecycle')?.valueCode;
const reasonOf = (loc) => loc.extension?.find((e) => e.url === 'urn:hospital-desktop:status-reason')?.valueString;
const activeBed = (enc) => (enc.location || []).find((l) => l.status === 'active')?.location?.reference;

async function setup() {
  const clock = testClock('2026-03-02T08:00:00.000Z');
  const s = await startTestServer({ clock });
  const seed = await s.call('POST', '/api/beds/seed', { layout: DEFAULT_LAYOUT }, admin);
  assert.equal(seed.status, 200, seed.text);
  const bed = async (id) => (await s.call('GET', `/fhir/R4/Location/${id}`)).json;
  const encounter = async (id) => (await s.call('GET', `/fhir/R4/Encounter/${id}`)).json;
  const board = async (query = '') => { const r = await s.call('GET', `/api/beds/dashboard${query}`); assert.equal(r.status, 200, r.text); return r.json; };
  const findBed = (b, id) => b.units.flatMap((u) => u.rooms.flatMap((r) => r.beds)).find((x) => x.id === id);
  let n = 0;
  const admit = async ({ family = `Bedcase${n += 1}`, gender = 'female', cls = 'IMP', status = 'arrived', isolation = null } = {}) => {
    const p = (await s.call('POST', '/fhir/R4/Patient', patient(family, { gender }))).json;
    const e = (await s.call('POST', '/fhir/R4/Encounter', {
      resourceType: 'Encounter', status, subject: { reference: `Patient/${p.id}` }, period: { start: clock.now() },
      class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: cls }, ...(isolation ? { extension: [{ url: URLS.isolation, valueString: isolation }] } : {}),
    })).json;
    assert.ok(e.id, JSON.stringify(e));
    return { p, e };
  };
  const post = (route, body, headers = bedmgr) => s.call('POST', `/api/beds/${route}`, body, headers);
  const steps = async () => (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps;
  return { s, clock, seed: seed.json, bed, encounter, board, findBed, admit, post, steps };
}

test('layout: the default generates site, 4 units, 31 rooms and 64 beds with stable ids and the declared constraints', () => {
  const locations = generateLocations(DEFAULT_LAYOUT);
  const h = hierarchy(locations);
  assert.equal(locations.length, 100);
  assert.deepEqual(h.units.map((u) => u.id), ['unit-ed', 'unit-med', 'unit-surg', 'unit-icu']);
  assert.equal(h.beds.length, 64);
  assert.deepEqual(h.units.map((u) => h.bedsOfUnit(u).length), [12, 24, 20, 8]);
  assert.ok(h.byId.get('room-med-1') && h.byId.get('bed-med-1a') && h.byId.get('bed-ed-12') && h.byId.get('bed-icu-8'));
  assert.equal(h.displayOf(h.byId.get('bed-med-1a')), 'Medical ward / Room 1 / Bed 1A');
  assert.equal(h.displayOf(h.byId.get('bed-ed-3')), 'Emergency department / Bay 3 / Bed 3');
  assert.ok(h.byId.get('unit-med').extension.some((e) => e.url === URLS.sexOfBay && e.valueBoolean), 'the medical ward declares sex-of-bay');
  assert.ok(h.byId.get('unit-icu').extension.some((e) => e.url === URLS.unitIsolation && e.valueBoolean), 'ICU declares isolation');
  assert.ok(h.byId.get('bed-icu-7').extension?.some((e) => e.url === URLS.isolation) && !h.byId.get('bed-icu-1').extension, 'ICU rooms 7 and 8 are isolation rooms');
  assert.equal(resolveBed(h, { pointOfCare: 'ED', room: 'Bay 3', bed: 'Bed 3' }).id, 'bed-ed-3', 'an HL7 PV1-3 style reference resolves');
  assert.equal(resolveBed(h, { pointOfCare: 'Medical ward', bed: 'Bed 2C' }).id, 'bed-med-2c');
  assert.equal(resolveBed(h, 'Location/bed-surg-5d').id, 'bed-surg-5d');
  assert.throws(() => resolveBed(h, 'unit-ed'), /does not exist/);
  assert.throws(() => generateLocations({ units: [] }), /at least one unit/);
});

test(`[${BACKEND}] seed is idempotent, keeps bed state on reload, and the Location search parameters work`, async () => {
  const { s, seed, bed, post } = await setup();
  assert.deepEqual(seed, { written: 100, unchanged: 0, total: 100 });
  const first = await bed('bed-med-1a');
  assert.equal(stateOf(first), 'available');
  assert.equal(first.operationalStatus.code, 'U');
  assert.equal(first.partOf.reference, 'Location/room-med-1');
  assert.equal((await post('block', { bed: 'bed-med-1a', reason: 'Broken rail' })).status, 200);
  const again = (await s.call('POST', '/api/beds/seed', { layout: DEFAULT_LAYOUT }, admin)).json;
  assert.deepEqual(again, { written: 0, unchanged: 100, total: 100 });
  assert.equal(stateOf(await bed('bed-med-1a')), 'blocked', 'a reload never resets a bed');
  // A changed layout rewrites only what changed, and the bed keeps its state.
  const renamed = { ...DEFAULT_LAYOUT, units: DEFAULT_LAYOUT.units.map((u) => (u.id === 'med' ? { ...u, name: 'Medicine' } : u)) };
  const third = (await s.call('POST', '/api/beds/seed', { layout: renamed }, admin)).json;
  assert.equal(third.written, 1 + 6, 'the unit and its rooms (their partOf display changed); the beds point at rooms and are untouched');
  assert.equal(stateOf(await bed('bed-med-1a')), 'blocked');
  assert.equal(reasonOf(await bed('bed-med-1a')), 'Broken rail');
  assert.equal((await s.call('POST', '/api/beds/seed', { layout: DEFAULT_LAYOUT }, as('patient'))).status, 403, 'only roles that may create locations seed');
  assert.equal((await s.call('POST', '/api/beds/seed', { layout: DEFAULT_LAYOUT }, as('researcher'))).status, 200, 'the researcher has full access');
  const search = async (q) => (await s.call('GET', `/fhir/R4/Location?${q}`)).json.entry.map((e) => e.resource.id);
  assert.deepEqual((await search('partof=room-med-1')).sort(), ['bed-med-1a', 'bed-med-1b', 'bed-med-1c', 'bed-med-1d']);
  assert.equal((await search('physical-type=wa')).length, 4);
  assert.equal((await search('physical-type=http://terminology.hl7.org/CodeSystem/location-physical-type|bd')).length, 64);
  assert.deepEqual(await search('operational-status=C'), ['bed-med-1a']);
  assert.equal((await search('partof=Location/unit-ed&physical-type=ro')).length, 12);
  await s.close();
});

test(`[${BACKEND}] bed state machine: every legal move, every illegal one, reasons for block and unblock, occupied cannot be assigned (409)`, async () => {
  const { s, bed, post, admit, encounter } = await setup();
  const move = (id, to, reason) => s.call('POST', `/fhir/R4/Location/${id}/$transition`, { to, reason }, bedmgr);
  // Through the FHIR lifecycle operation, as any resource.
  assert.equal((await move('bed-surg-1a', 'occupied')).status, 200);
  assert.equal((await move('bed-surg-1a', 'available')).status, 422, 'occupied → available is illegal: a bed is cleaned first');
  assert.equal((await move('bed-surg-1a', 'reserved')).status, 422);
  assert.equal((await move('bed-surg-1a', 'cleaning')).status, 200);
  assert.equal(stateOf(await bed('bed-surg-1a')), 'cleaning');
  assert.equal((await bed('bed-surg-1a')).operationalStatus.code, 'K', 'operationalStatus follows the state');
  assert.equal((await move('bed-surg-1a', 'occupied')).status, 422, 'cleaning → occupied is illegal');
  assert.equal((await move('bed-surg-1a', 'blocked')).status, 422, 'blocked needs a reason');
  assert.equal((await move('bed-surg-1a', 'blocked', 'Deep clean')).status, 200);
  assert.equal((await bed('bed-surg-1a')).operationalStatus.code, 'C');
  assert.equal((await move('bed-surg-1a', 'cleaning')).status, 422, 'blocked → cleaning is illegal');
  assert.equal((await move('bed-surg-1a', 'available')).status, 422, 'unblock needs a fresh reason');
  assert.equal((await move('bed-surg-1a', 'available', 'Deep clean')).status, 422, 'the blocking reason does not count as the unblocking reason');
  assert.equal((await move('bed-surg-1a', 'available', 'Clean done')).status, 200);
  assert.equal((await move('bed-surg-1a', 'reserved')).status, 200);
  assert.equal((await move('bed-surg-1a', 'cleaning')).status, 422, 'reserved → cleaning is illegal');
  assert.equal((await move('bed-surg-1a', 'available')).status, 200);
  assert.equal((await move('bed-surg-1a', 'reserved')).status, 200);
  assert.equal((await move('bed-surg-1a', 'occupied')).status, 200);
  assert.equal((await move('unit-surg', 'occupied')).status, 422, 'only beds have a lifecycle');
  assert.equal((await s.call('PUT', '/fhir/R4/Location/unit-surg', { ...(await bed('unit-surg')), name: 'Surgical ward B' }, bedmgr)).status, 200, 'a unit can still be updated');
  // Through the bed routes.
  assert.equal((await post('block', { bed: 'bed-surg-1b' })).status, 422, 'a reason is required');
  assert.equal((await post('block', { bed: 'bed-surg-1b', reason: 'Leaking tap' })).status, 200);
  assert.equal((await post('block', { bed: 'bed-surg-1b', reason: 'Twice' })).status, 409);
  assert.equal((await post('clean', { bed: 'bed-surg-1b' })).status, 409, 'only a cleaning bed can be marked clean');
  assert.equal((await post('unblock', { bed: 'bed-surg-1b' })).status, 422);
  assert.equal((await post('unblock', { bed: 'bed-surg-1b', reason: 'Fixed' })).status, 200);
  assert.equal(stateOf(await bed('bed-surg-1b')), 'available');
  assert.equal((await post('unblock', { bed: 'bed-surg-1b', reason: 'Again' })).status, 409);
  assert.equal((await post('reserve', { bed: 'bed-surg-1b' })).status, 200);
  assert.equal((await post('reserve', { bed: 'bed-surg-1b' })).status, 409);
  assert.equal((await post('release', { bed: 'bed-surg-1b' })).status, 200);
  assert.equal((await post('clean', { bed: 'no-such-bed' })).status, 404);
  // An occupied bed cannot be assigned.
  const a = await admit();
  const b = await admit();
  assert.equal((await post('assign', { encounter: a.e.id, bed: 'bed-surg-2a' })).status, 200);
  const clash = await post('assign', { encounter: b.e.id, bed: 'bed-surg-2a' });
  assert.equal(clash.status, 409);
  assert.match(clash.json.error, /is occupied by Patient N\d{6}/);
  assert.equal((await post('assign', { encounter: a.e.id, bed: 'bed-surg-2b' })).status, 409, 'already in a bed: use transfer');
  assert.equal((await post('assign', { encounter: b.e.id, bed: 'bed-surg-1a' })).status, 409, 'an occupied bed (moved through $transition) is refused too');
  assert.equal(activeBed(await encounter(a.e.id)), 'Location/bed-surg-2a');
  // Reserved for someone else.
  assert.equal((await post('reserve', { bed: 'bed-surg-3a', encounter: a.e.id })).status, 200);
  assert.equal((await post('assign', { encounter: b.e.id, bed: 'bed-surg-3a' })).status, 409);
  const c = await admit({ cls: 'AMB' });
  assert.equal((await post('assign', { encounter: c.e.id, bed: 'bed-surg-3b' })).status, 409, 'outpatients take no bed');
  await s.close();
});

test(`[${BACKEND}] assign → discharge → bed cleaning → clean → available; transfer out sends the old bed to cleaning; the movement record`, async () => {
  const { s, bed, post, admit, encounter, clock, steps, board, findBed } = await setup();
  const { p, e } = await admit({ status: 'arrived' });
  const assigned = await post('assign', { encounter: e.id, bed: 'bed-med-1a' });
  assert.equal(assigned.status, 200, assigned.text);
  assert.equal(assigned.json.encounter.status, 'in-progress', 'a patient in a bed is in progress');
  assert.equal(assigned.json.encounter.location[0].location.display, 'Medical ward / Room 1 / Bed 1A');
  assert.equal(assigned.json.encounter.location[0].status, 'active');
  assert.equal(assigned.json.bed.operationalStatus.code, 'O');
  const b1 = findBed(await board(), 'bed-med-1a');
  assert.equal(b1.state, 'occupied');
  assert.equal(b1.encounter.patient.id, p.id);
  assert.equal(b1.encounter.patient.mrn, (await s.call('GET', `/fhir/R4/Patient/${p.id}`)).json.identifier[0].value);
  clock.advance(90 * MIN);
  const moved = await post('transfer', { encounter: e.id, bed: 'bed-med-2a', reason: 'Closer to the nurses station' });
  assert.equal(moved.status, 200, moved.text);
  assert.equal(stateOf(await bed('bed-med-1a')), 'cleaning', 'transfer out sends the old bed to cleaning');
  assert.equal(reasonOf(await bed('bed-med-1a')), 'Transfer out');
  assert.equal(stateOf(await bed('bed-med-2a')), 'occupied');
  const enc = await encounter(e.id);
  assert.deepEqual(enc.location.map((l) => [l.location.reference, l.status]), [['Location/bed-med-1a', 'completed'], ['Location/bed-med-2a', 'active']]);
  assert.equal(enc.location[0].period.end, clock.now());
  assert.equal((await post('transfer', { encounter: e.id, bed: 'bed-med-2a' })).status, 409, 'already there');
  const movements = (await s.call('GET', `/api/beds/movements/${e.id}`)).json;
  assert.equal(movements.current, 'Medical ward / Room 2 / Bed 2A');
  assert.deepEqual(movements.movements.map((m) => [m.bed, m.status, m.minutes]), [['bed-med-1a', 'completed', 90], ['bed-med-2a', 'active', 0]]);
  clock.advance(30 * MIN);
  const out = await post('discharge', { encounter: e.id }, as('nurse'));
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.encounter.status, 'finished');
  assert.equal(out.json.encounter.period.end, clock.now());
  assert.ok(out.json.encounter.location.every((l) => l.status === 'completed'));
  assert.equal(stateOf(await bed('bed-med-2a')), 'cleaning');
  assert.equal((await post('discharge', { encounter: e.id })).status, 409, 'already finished');
  assert.equal((await post('assign', { encounter: (await admit()).e.id, bed: 'bed-med-2a' })).status, 409, 'a bed being cleaned cannot be assigned');
  clock.advance(25 * MIN);
  const cleaned = await post('clean', { bed: 'bed-med-2a' });
  assert.equal(cleaned.status, 200, cleaned.text);
  assert.equal(cleaned.json.dirtyMinutes, 25);
  assert.equal(stateOf(await bed('bed-med-2a')), 'available');
  assert.equal(reasonOf(await bed('bed-med-2a')), undefined, 'the cleaning reason is cleared');
  const actions = (await steps()).filter((x) => x.did.type.startsWith('bed.')).map((x) => x.did.type);
  assert.deepEqual(actions, ['bed.seed', 'bed.assign', 'bed.transfer', 'bed.discharge', 'bed.clean']);
  const assignStep = (await steps()).find((x) => x.did.type === 'bed.assign');
  assert.equal(assignStep.did.args.bed, 'bed-med-1a');
  assert.equal(assignStep.did.args.encounter, e.id);
  assert.equal(assignStep.who.role, 'nurse');
  const audits = (await s.call('GET', '/fhir/R4/AuditEvent?_count=2000')).json.entry.map((x) => x.resource.outcomeDesc);
  assert.ok(audits.some((d) => d.startsWith('assigned Medical ward / Room 1 / Bed 1A')), 'bed moves write an AuditEvent');
  // Discharge straight from "arrived" takes the Encounter machine through in-progress.
  const f = await admit({ status: 'arrived' });
  assert.equal((await post('discharge', { encounter: f.e.id })).status, 200);
  assert.equal((await encounter(f.e.id)).status, 'finished');
  await s.close();
});

test(`[${BACKEND}] constraints: isolation beds in a unit that declares it, and sex of bay where declared`, async () => {
  const { s, post, admit } = await setup();
  const plain = await admit({ gender: 'male' });
  const iso = await admit({ gender: 'male', isolation: 'Contact precautions' });
  let r = await post('assign', { encounter: plain.e.id, bed: 'bed-icu-7' });
  assert.equal(r.status, 409); assert.match(r.json.error, /isolation bed/);
  r = await post('assign', { encounter: iso.e.id, bed: 'bed-icu-1' });
  assert.equal(r.status, 409); assert.match(r.json.error, /needs isolation/);
  assert.equal((await post('assign', { encounter: iso.e.id, bed: 'bed-icu-7' })).status, 200);
  assert.equal((await post('assign', { encounter: plain.e.id, bed: 'bed-icu-1' })).status, 200);
  const iso2 = await admit({ gender: 'female', isolation: 'Droplet' });
  assert.equal((await post('assign', { encounter: iso2.e.id, bed: 'bed-ed-1' })).status, 200, 'a unit that does not declare isolation takes anyone');
  assert.equal((await post('reserve', { bed: 'bed-icu-8', encounter: plain.e.id })).status, 409, 'a reservation obeys the same rule');
  // Sex of bay on the medical ward.
  const f1 = await admit({ gender: 'female' });
  const f2 = await admit({ gender: 'female' });
  const m1 = await admit({ gender: 'male' });
  const u1 = await admit({ gender: 'unknown' });
  assert.equal((await post('assign', { encounter: f1.e.id, bed: 'bed-med-3a' })).status, 200);
  r = await post('assign', { encounter: m1.e.id, bed: 'bed-med-3b' });
  assert.equal(r.status, 409); assert.match(r.json.error, /Room 3 in Medical ward is a female bay/);
  assert.equal((await post('assign', { encounter: f2.e.id, bed: 'bed-med-3b' })).status, 200);
  assert.equal((await post('assign', { encounter: u1.e.id, bed: 'bed-med-3c' })).status, 200, 'unknown sex is not checked');
  assert.equal((await post('assign', { encounter: m1.e.id, bed: 'bed-med-4a' })).status, 200, 'an empty bay takes either sex');
  r = await post('transfer', { encounter: f1.e.id, bed: 'bed-med-4b' });
  assert.equal(r.status, 409); assert.match(r.json.error, /male bay/);
  // The surgical ward declares nothing: mixed bays are allowed.
  const m2 = await admit({ gender: 'male' });
  const f3 = await admit({ gender: 'female' });
  assert.equal((await post('assign', { encounter: m2.e.id, bed: 'bed-surg-1a' })).status, 200);
  assert.equal((await post('assign', { encounter: f3.e.id, bed: 'bed-surg-1b' })).status, 200);
  await s.close();
});

test(`[${BACKEND}] waiting list with times, bed requests, expected discharges today, turnaround maths`, async () => {
  const { s, post, admit, clock, board, steps, encounter } = await setup();
  const a = await admit({ status: 'arrived', cls: 'EMER' });
  clock.advance(10 * MIN);
  const b = await admit({ status: 'in-progress' });
  let d = await board();
  assert.deepEqual(d.waiting.map((w) => [w.id, w.kind, w.minutesWaiting, w.requestedUnit]), [[a.e.id, 'admitted', 10, null], [b.e.id, 'admitted', 0, null]], 'admitted with no bed, longest wait first, timed from arrival');
  clock.advance(20 * MIN);
  const req = await post('request', { encounter: b.e.id, unit: 'unit-med', isolation: 'Contact precautions' }, as('nurse'));
  assert.equal(req.status, 200, req.text);
  assert.equal((await post('request', { encounter: b.e.id, unit: 'unit-nowhere' })).status, 404);
  d = await board();
  const wb = d.waiting.find((w) => w.id === b.e.id);
  assert.deepEqual([wb.requestedUnit.id, wb.minutesWaiting, wb.isolation], ['unit-med', 0, 'Contact precautions'], 'a request restarts the clock from the request');
  clock.advance(30 * MIN);
  const assigned = await post('assign', { encounter: b.e.id, bed: 'bed-med-1a' });
  assert.equal(assigned.status, 200, assigned.text);
  assert.equal(assigned.json.waitedMinutes, 30);
  assert.ok(!(await encounter(b.e.id)).extension?.some((e) => e.url === URLS.bedRequest), 'the request is cleared on assignment');
  d = await board();
  assert.deepEqual(d.waiting.map((w) => w.id), [a.e.id]);
  // A transfer request puts a bedded patient back on the list.
  assert.equal((await post('request', { encounter: b.e.id, unit: 'unit-surg' })).status, 200);
  d = await board();
  const tb = d.waiting.find((w) => w.id === b.e.id);
  assert.equal(tb.kind, 'transfer');
  assert.equal(tb.currentBed.id, 'bed-med-1a');
  clock.advance(15 * MIN);
  const moved = await post('transfer', { encounter: b.e.id, bed: 'bed-surg-1a' });
  assert.equal(moved.json.waitedMinutes, 15);
  assert.equal((await board()).waiting.length, 1);
  // Expected discharges today: the extension, or a planned period end today.
  const today = clock.now().slice(0, 10);
  const encB = await encounter(b.e.id);
  assert.equal((await s.call('PUT', `/fhir/R4/Encounter/${b.e.id}`, { ...encB, extension: [...(encB.extension || []), { url: URLS.expectedDischarge, valueDate: today }] }, as('physician'))).status, 200);
  const c = await admit({ status: 'in-progress' });
  assert.equal((await post('assign', { encounter: c.e.id, bed: 'bed-surg-2a' })).status, 200);
  const encC = await encounter(c.e.id);
  assert.equal((await s.call('PUT', `/fhir/R4/Encounter/${c.e.id}`, { ...encC, period: { ...encC.period, end: `${today}T18:00:00.000Z` } }, as('physician'))).status, 200);
  const e = await admit();
  await post('assign', { encounter: e.e.id, bed: 'bed-surg-2b' });
  const encE = await encounter(e.e.id);
  await s.call('PUT', `/fhir/R4/Encounter/${e.e.id}`, { ...encE, extension: [{ url: URLS.expectedDischarge, valueDate: '2026-03-09' }] }, as('physician'));
  d = await board();
  assert.deepEqual(d.expectedDischarges.map((x) => [x.id, x.bed.id]).sort(), [[b.e.id, 'bed-surg-1a'], [c.e.id, 'bed-surg-2a']].sort());
  // Turnaround: discharge → clean 20 and 40 minutes (median 30, mean 30); request → assign 30 and 15 (median 23, mean 23); today and 7 days.
  assert.equal((await post('discharge', { encounter: b.e.id })).status, 200);
  clock.advance(20 * MIN);
  assert.equal((await post('clean', { bed: 'bed-surg-1a' })).status, 200);
  assert.equal((await post('discharge', { encounter: c.e.id })).status, 200);
  clock.advance(40 * MIN);
  assert.equal((await post('clean', { bed: 'bed-surg-2a' })).status, 200);
  clock.advance(10 * MIN);
  assert.equal((await post('clean', { bed: 'bed-med-1a' })).status, 200, 'the transfer-out bed (dirty 70 minutes)');
  d = await board();
  assert.deepEqual(d.turnaround.today.dischargeToClean, { count: 3, medianMinutes: 40, meanMinutes: 43 });
  assert.deepEqual(d.turnaround.today.requestToAssign, { count: 2, medianMinutes: 23, meanMinutes: 23 });
  assert.deepEqual(d.turnaround.last7Days.dischargeToClean, d.turnaround.today.dischargeToClean);
  clock.advance(2 * 24 * 60 * MIN);
  d = await board();
  assert.equal(d.turnaround.today.dischargeToClean.count, 0, 'two days later: nothing today');
  assert.equal(d.turnaround.last7Days.dischargeToClean.count, 3, 'still within the week');
  clock.advance(6 * 24 * 60 * MIN);
  assert.equal((await board()).turnaround.last7Days.dischargeToClean.count, 0);
  assert.equal(d.units.find((u) => u.id === 'unit-surg').occupied, 1);
  assert.equal(d.units.find((u) => u.id === 'unit-surg').capacity, 20);
  assert.equal(d.totals.capacity, 64);
  const assignSteps = (await steps()).filter((x) => x.did.type === 'bed.assign').map((x) => x.did.args.waitedMinutes);
  assert.ok(assignSteps.includes(30));
  await s.close();
});

test(`[${BACKEND}] time travel: the board as of before an assignment shows the bed available; writes are refused in an as-of view`, async () => {
  const { s, post, admit, clock, board, findBed } = await setup();
  const before = clock.now();
  clock.advance(5 * MIN);
  const a = await admit();
  assert.equal((await post('assign', { encounter: a.e.id, bed: 'bed-ed-1' })).status, 200);
  assert.equal(findBed(await board(), 'bed-ed-1').state, 'occupied');
  const past = await board(`?_asOf=${encodeURIComponent(before)}`);
  assert.equal(findBed(past, 'bed-ed-1').state, 'available');
  assert.equal(past.now, before);
  assert.equal(past.waiting.length, 0);
  assert.equal((await s.call('POST', `/api/beds/clean?_asOf=${encodeURIComponent(before)}`, { bed: 'bed-ed-2' }, bedmgr)).status, 409);
  // A practice copy sees the hospital as it was at the fork and keeps its own moves.
  const branch = (await s.call('POST', '/agent-ops/branches', { kind: 'sandbox' })).json.id ?? (await s.store.fork({ kind: 'sandbox' }));
  assert.equal((await s.call('POST', `/api/beds/block?_branch=${branch}`, { bed: 'bed-ed-2', reason: 'Practice' }, bedmgr)).status, 200);
  assert.equal(findBed(await board(`?_branch=${branch}`), 'bed-ed-2').state, 'blocked');
  assert.equal(findBed(await board(), 'bed-ed-2').state, 'available', 'main is untouched');
  await s.close();
});

test(`[${BACKEND}] who may move a patient: agents never; staff roles as the map says; the patient and unknown roles refused and logged`, async () => {
  const { s, post, admit, steps } = await setup();
  const a = await admit();
  const run = (await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'workup-planner' })).json;
  const agent = { 'X-Agent-Id': 'workup-planner', 'X-Run-Id': run.id, 'Idempotency-Key': 'bed-1' };
  const refused = await s.call('POST', `/api/beds/assign?_branch=${run.branch}`, { encounter: a.e.id, bed: 'bed-ed-1' }, agent);
  assert.equal(refused.status, 403);
  assert.match(refused.json.error, /Agents may not move patients/);
  assert.equal((await s.call('GET', `/api/beds/dashboard?_branch=${run.branch}`, undefined, { 'X-Agent-Id': 'workup-planner', 'X-Run-Id': run.id })).status, 200, 'an agent may read the board');
  const enc = (await s.call('GET', `/fhir/R4/Encounter/${a.e.id}?_branch=${run.branch}`)).json;
  const viaFhir = await s.call('PUT', `/fhir/R4/Encounter/${a.e.id}?_branch=${run.branch}`, { ...enc, location: [{ location: { reference: 'Location/bed-ed-1' }, status: 'active' }] }, { ...agent, 'Idempotency-Key': 'bed-2' });
  assert.equal(viaFhir.status, 403, 'nor through the FHIR API');
  const bedViaFhir = await s.call('POST', `/fhir/R4/Location/bed-ed-1/$transition?_branch=${run.branch}`, { to: 'occupied' }, { ...agent, 'Idempotency-Key': 'bed-3' });
  assert.equal(bedViaFhir.status, 403);
  const rules = (await s.call('GET', `/agent-ops/trace?runId=${run.id}`)).json.steps.filter((x) => x.did.type === 'envelope.reject').map((x) => x.did.args.rule);
  assert.ok(rules.includes('human-only'), rules.join(','));
  // People, by the map.
  const sched = await post('assign', { encounter: a.e.id, bed: 'bed-ed-1' }, as('patient'));
  assert.equal(sched.status, 403);
  assert.match(sched.json.error, /patient cannot change a bed or location/);
  assert.equal((await post('assign', { encounter: a.e.id, bed: 'bed-ed-1' }, as('janitor'))).status, 403, 'an unknown role is refused');
  assert.equal((await post('block', { bed: 'bed-ed-3', reason: 'Painting' }, as('patient'))).status, 403);
  assert.ok((await steps()).some((x) => x.did.type === 'role.refuse' && x.did.args.role === 'patient' && x.did.args.type === 'Location'), 'the refusal is logged');
  assert.equal(activeBed((await s.call('GET', `/fhir/R4/Encounter/${a.e.id}`)).json), undefined, 'a refused assign changes nothing (the transaction rolled back)');
  assert.equal((await post('assign', { encounter: a.e.id, bed: 'bed-ed-1' }, as('nurse'))).status, 200);
  const ptMove = await post('transfer', { encounter: a.e.id, bed: 'bed-ed-2' }, as('patient'));
  assert.equal(ptMove.status, 403, 'a patient does not transfer');
  assert.match(ptMove.json.error, /patient cannot change a bed or location/);
  assert.equal((await post('clean', { bed: 'bed-ed-1' }, as('nurse'))).status, 409, 'a nurse may change bed state (the bed is occupied, so 409 not 403)');
  assert.equal((await post('discharge', { encounter: a.e.id }, as('physician'))).status, 200);
  assert.equal((await post('clean', { bed: 'bed-ed-1' }, as('nurse'))).status, 200);
  const b = await admit();
  assert.equal((await post('request', { encounter: b.e.id, unit: 'unit-ed' }, as('physician'))).status, 200);
  assert.equal((await post('assign', { encounter: b.e.id, bed: { pointOfCare: 'ED', room: 'Bay 4', bed: 'Bed 4' } }, as('physician'))).status, 200, 'an HL7 style bed reference');
  assert.equal(activeBed((await s.call('GET', `/fhir/R4/Encounter/${b.e.id}`)).json), 'Location/bed-ed-4');
  await s.close();
});
