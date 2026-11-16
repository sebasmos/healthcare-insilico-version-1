// Shared by the insurance environment's modules (docs/PAYER.md).
import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';
import { simNow } from '../../platform/server/simclock.mjs';
import { mayDecideForInsurer, mayDenyForNecessity, INSURER_ROLES, enforcedFor } from '../../platform/server/roles.mjs';
import { mrnOf } from '../../ehr/server/clinical-rules.mjs';
import * as x12 from './x12.mjs';

export { HttpError, randomUUID, x12, INSURER_ROLES };
export const money = (n) => Math.round(Number(n) * 100) / 100;
export const day = (v) => String(v || '').slice(0, 10);
export const hashInt = (s) => parseInt(createHash('sha256').update(String(s)).digest('hex').slice(0, 8), 16);
export const strip = ({ _seq, meta, resourceType, _groupKey, ...d }) => d;
/** A patient is a number: "Patient <medical record number>". */
export const patientNumber = (p) => `Patient ${mrnOf(p) ?? String(p.id).slice(0, 8)}`;
/** A nine-digit member number, the same for the same patient and plan. */
export const memberNumber = (patientId, planId) => String(100000000 + (hashInt(`${patientId}:${planId}`) % 899999999));
const HOSPITAL = ['researcher', 'physician', 'nurse', 'coder'];

export function createContext({ store }) {
  /** Every timer runs on the simulation clock of the run the work belongs to. */
  const now = (ctx) => (ctx?.run?.sim ? simNow(ctx.run, store.now()) : store.now());
  const opts = (ctx) => ({ branch: ctx.branch, asOf: ctx.asOf });
  const log = (tx, ctx, action, args, description, extra = {}) => recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: extra.kind || 'execute', action, args, branch: ctx.branch, description, why: ctx.why ?? extra.why ?? null, ...(extra.patientRef ? { patientRef: extra.patientRef } : {}), ...(extra.entityRef ? { entityRef: extra.entityRef } : {}) });
  /** Save one record on the request's branch and log the action in the same transaction. */
  const put = (ctx, type, doc, action, args, description, extra = {}) => store.transaction(async (tx) => { const { _seq, meta, ...cleanDoc } = doc; const saved = await tx.save(type, { resourceType: type, ...cleanDoc }, { branch: ctx.branch, updatedBy: ctx.actor.role }); await log(tx, ctx, action, args, description, { ...extra, entityRef: `${type}/${saved.id}` }); return saved; });
  const get = async (ctx, type, id) => { const d = await store.get(type, String(id), opts(ctx)); if (!d) throw new HttpError(404, `No such ${type.replace(/^Ins/, '').toLowerCase()}`); return d; };
  const list = (ctx, type, where = null) => store.query(type, where ? { where } : {}, opts(ctx));
  const writable = (ctx) => { if (ctx.asOf) throw new HttpError(409, 'Writes are disabled while viewing a past time'); };
  // Who may do what. An agent acts with the side its run was started for; a person by role.
  const sideOf = (ctx) => (ctx.actor.kind === 'agent' ? ctx.run?.context?.side || ctx.run?.attempt?.side || 'hospital' : INSURER_ROLES.includes(ctx.actor.role) ? 'insurer' : ctx.actor.role === 'patient' ? 'patient' : ctx.actor.role === 'researcher' ? 'any' : 'hospital');
  const hospital = (ctx, roles = HOSPITAL) => { writable(ctx); if (ctx.actor.kind === 'agent') { if (ctx.branch === 'main') throw new HttpError(403, 'An agent works only on its own branch: the live record is never changed by an agent'); if (!['hospital', 'any'].includes(sideOf(ctx))) throw new HttpError(403, 'This agent works for the insurer, not the hospital'); return; } if (enforcedFor(ctx) && !roles.includes(ctx.actor.role)) throw new HttpError(403, `This is done by: ${roles.join(', ')}`, 'forbidden'); };
  /** Only the insurer decides. Hospital staff never approve or deny. An agent decides only on a branch (autonomous), never on the live record. */
  const insurer = (ctx, { necessityDenial = false } = {}) => {
    writable(ctx);
    if (ctx.actor.kind === 'agent') { if (!['insurer', 'any'].includes(sideOf(ctx))) throw new HttpError(403, 'Hospital-side agents never approve or deny'); if (ctx.branch === 'main') throw new HttpError(403, 'An agent decides only on its own branch; on the live record it may only recommend'); return; }
    if (!enforcedFor(ctx)) return;
    if (!mayDecideForInsurer(ctx.actor.role)) throw new HttpError(403, 'Hospital staff never approve or deny: only the insurer decides', 'forbidden');
    if (necessityDenial && !mayDenyForNecessity(ctx.actor.role)) throw new HttpError(403, 'A denial for medical necessity is made by the payer medical director. Route it to them.', 'forbidden');
  };
  let control = 0; const nextControl = () => { control = (control + 1) % 999999999; return control || 1; };
  /**
   * The wire. Everything the two sides tell each other is a message, kept in both forms: the X12 text and the FHIR
   * resource. The insurer's records are built only from what arrived here.
   */
  const wireListeners = []; const onWire = (fn) => { wireListeners.push(fn); };
  const send = (tx, ctx, { from, to, type, x12: text, fhir = null, about, summary }) => { const m = { from, to, type, about: about || null, summary: summary || type, at: now(ctx), fhirId: fhir?.id ?? null }; setTimeout(() => { for (const fn of wireListeners) Promise.resolve().then(() => fn(m, ctx)).catch((err) => console.error('insurance push:', err.message)); }, 60).unref?.(); return tx.save('InsMessage', { resourceType: 'InsMessage', id: randomUUID(), from, to, type, x12: text, fhir, about: about || null, summary: summary || type, at: now(ctx), _groupKey: about?.ref || null }, { branch: ctx.branch, updatedBy: ctx.actor.role }); };
  return { store, now, opts, log, put, get, list, writable, hospital, insurer, sideOf, send, onWire, nextControl };
}
