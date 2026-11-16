// /api/beds/**: the bed board and the bed moves. Reads honour
// _asOf and _branch; every move runs in one transaction through beds.mjs,
// where the bed state machine, the role map and the log apply. Agents never
// reach a write here: the envelope refuses them before routing.
import { HttpError } from '../../platform/server/http.mjs';
import { enforcedFor, assertMayWrite } from '../../platform/server/roles.mjs';
import { stripInternal } from '../../platform/server/fhir-api.mjs';
import {
  dashboard, admitToBed, transferToBed, dischargeFromBed, cleanBed, blockBed, unblockBed, reserveBed, releaseBed, requestBed,
  loadHospital, generateLocations, readHospitalFile, hierarchy, activeLocation,
} from './beds.mjs';

export function createBedsApi({ store, fhir }) {
  const writable = (ctx) => {
    if (ctx.asOf) throw new HttpError(409, 'Writes are disabled while viewing a past time', 'conflict');
    if (ctx.actor.kind === 'agent') throw new HttpError(403, 'Agents may not move patients or change beds', 'forbidden');
  };
  // Placing a patient (assign, transfer, reserve, release) is the bed manager's work: it needs the full Location permission, not just a state move.
  const PLACING = new Set(['assign', 'transfer', 'reserve', 'release']);
  const move = (fn, pick, name) => async (body, ctx) => {
    writable(ctx);
    if (PLACING.has(name) && enforcedFor(ctx)) assertMayWrite(ctx.actor.role, 'Location', 'update');
    const out = await store.transaction((tx) => fn(tx, { ...pick(body || {}), ctx }, { fhir }));
    return { status: 200, body: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v && typeof v === 'object' && v.resourceType ? stripInternal(v) : v])) };
  };
  const str = (v) => (v == null ? null : String(v));
  const ROUTES = {
    assign: move(admitToBed, (b) => ({ encounter: str(b.encounter), bed: b.bed && typeof b.bed === 'object' ? b.bed : str(b.bed) }), 'assign'),
    transfer: move(transferToBed, (b) => ({ encounter: str(b.encounter), bed: b.bed && typeof b.bed === 'object' ? b.bed : str(b.bed), reason: str(b.reason) }), 'transfer'),
    discharge: move(dischargeFromBed, (b) => ({ encounter: str(b.encounter) }), 'discharge'),
    clean: move(cleanBed, (b) => ({ bed: str(b.bed) }), 'clean'),
    block: move(blockBed, (b) => ({ bed: str(b.bed), reason: b.reason }), 'block'),
    unblock: move(unblockBed, (b) => ({ bed: str(b.bed), reason: b.reason }), 'unblock'),
    reserve: move(reserveBed, (b) => ({ bed: str(b.bed), encounter: str(b.encounter) }), 'reserve'),
    release: move(releaseBed, (b) => ({ bed: str(b.bed) }), 'release'),
    request: move(requestBed, (b) => ({ encounter: str(b.encounter), unit: str(b.unit), isolation: b.isolation ?? null }), 'request'),
  };

  return {
    async handle(req, url, body, ctx) {
      const parts = url.pathname.split('/').filter(Boolean).slice(2);
      const m = req.method;

      if (parts[0] === 'dashboard' && m === 'GET') return { status: 200, body: await dashboard(store, { branch: ctx.branch, asOf: ctx.asOf }) };

      // The movement record of one encounter: its Encounter.location entries, oldest first.
      if (parts[0] === 'movements' && parts[1] && m === 'GET') {
        const encounter = await store.get('Encounter', parts[1], { branch: ctx.branch, asOf: ctx.asOf });
        if (!encounter) throw new HttpError(404, `Encounter/${parts[1]} not found`, 'not-found');
        const patient = encounter.subject?.reference ? await store.get('Patient', encounter.subject.reference.slice('Patient/'.length), { branch: ctx.branch, asOf: ctx.asOf }) : null;
        const h = hierarchy(await store.query('Location', {}, { branch: ctx.branch, asOf: ctx.asOf }));
        const now = ctx.asOf ?? store.now();
        const movements = (encounter.location || []).map((l, i) => {
          const id = l.location?.reference?.slice('Location/'.length) ?? null;
          const bed = id ? h.byId.get(id) : null;
          const end = l.period?.end ?? (l.status === 'active' ? now : null);
          return { index: i, bed: id, display: l.location?.display ?? (bed ? h.displayOf(bed) : id), unit: bed ? h.unitOf(bed)?.name ?? null : null, status: l.status ?? 'completed', start: l.period?.start ?? null, end: l.period?.end ?? null, minutes: l.period?.start && end ? Math.max(0, Math.round((Date.parse(end) - Date.parse(l.period.start)) / 60000)) : null };
        });
        return { status: 200, body: { encounter: stripInternal(encounter), patient: patient ? stripInternal(patient) : null, current: activeLocation(encounter)?.location?.display ?? null, movements } };
      }

      // Loads or reloads the hierarchy (administrator). Body: { layout } to generate from a layout, { locations } or a Bundle to load as given; otherwise data/hospital.json or the default layout.
      if (parts[0] === 'seed' && m === 'POST') {
        writable(ctx);
        if (enforcedFor(ctx)) assertMayWrite(ctx.actor.role, 'Location', 'create');
        const locations = body?.layout ? generateLocations(body.layout) : Array.isArray(body?.locations) ? body.locations : Array.isArray(body?.entry) ? body.entry.map((e) => e.resource) : readHospitalFile();
        if (!locations) throw new HttpError(422, 'No hospital layout yet. Send { layout } or { locations }, or place your own data/hospital.json');
        if (!locations.every((l) => l?.resourceType === 'Location' && l.id)) throw new HttpError(422, 'Every entry must be a Location with an id');
        const report = await loadHospital(store, locations, { actor: ctx.actor, branch: ctx.branch, runId: ctx.runId ?? undefined });
        return { status: 200, body: report };
      }

      if (parts.length === 1 && m === 'POST' && ROUTES[parts[0]]) return ROUTES[parts[0]](body, ctx);
      throw new HttpError(404, `${m} ${url.pathname} is not available`, 'not-found');
    },
  };
}
