// /api/** helper routes for the apps: terminology catalogue, top-bar badges,
// friction level and non-safety advisories.
import { createHash } from 'node:crypto';
import { catalog, SYSTEMS } from './catalog.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';
import { isCritical } from './safety-alerts.mjs';
import { HttpError } from '../../platform/server/http.mjs';
import { readRegister } from '../../platform/server/datasets.mjs';
import { enforcedFor, assertMayWrite } from '../../platform/server/roles.mjs';

const DAY = 24 * 3600 * 1000;
const loinc = (o) => (o.code?.coding || []).find((c) => c.system === SYSTEMS.loinc)?.code;

// Non-safety advisories. "applies" decides from the chart whether the
// advisory is relevant; generic ones (no applies) only appear at high friction.
export const ADVISORIES = [
  { id: 'flu-vaccine', context: 'chart-open', title: 'Influenza vaccine may be due', detail: 'No influenza immunisation is recorded in the last 12 months.', action: 'Create a follow-up task',
    applies: (c) => !c.immunizations.some((i) => c.now - Date.parse(i.occurrenceDateTime || i._recordedAt) < 365 * DAY) },
  { id: 'problem-list-review', context: 'chart-open', title: 'Problem list not reviewed in 12 months', detail: 'Review and update the problem list.', action: 'Create a follow-up task',
    applies: (c) => c.problems.length > 0 && c.problems.every((p) => c.now - Date.parse(p._recordedAt) > 365 * DAY) },
  { id: 'allergies-not-documented', context: 'prescribe', title: 'Allergies not documented', detail: 'No allergies and no "no known allergies" entry are on file for this patient.', action: 'Create a follow-up task',
    applies: (c) => c.allergies.length === 0 },
  { id: 'renal-function', context: 'prescribe', title: 'No recent renal function', detail: 'No creatinine result in the last 90 days. Consider checking before dosing.', action: 'Create a follow-up task',
    applies: (c) => !c.observations.some((o) => loinc(o) === '2160-0' && c.now - Date.parse(o._validAt) < 90 * DAY) },
  { id: 'tobacco-status', context: 'sign-note', title: 'Tobacco use status not documented', detail: 'Document tobacco use status for this patient.', action: 'Create a follow-up task',
    applies: (c) => !c.observations.some((o) => loinc(o) === '72166-2') },
  { id: 'order-indication', context: 'order', title: 'Confirm the indication', detail: 'Check that the order has a documented reason.', action: 'Acknowledge' },
  { id: 'formulary-notice', context: 'prescribe', title: 'Formulary reminder', detail: 'Prefer formulary alternatives where clinically appropriate.', action: 'Acknowledge' },
  { id: 'note-attestation', context: 'sign-note', title: 'Review before signing', detail: 'Confirm the note reflects your own assessment.', action: 'Acknowledge' },
  { id: 'care-gaps', context: 'chart-open', title: 'Health maintenance review', detail: 'Review overdue health maintenance topics.', action: 'Acknowledge' },
];
const CONTEXTS = new Set(ADVISORIES.map((a) => a.context));
const FRICTION = ['low', 'realistic', 'high'];

const sample = (parts) => parseInt(createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 8), 16) / 0xffffffff;

/** Deterministic for a given chart state, run seed, friction level and day. */
export async function advisoriesFor(store, { patientId, context, run, branch, asOf }) {
  const friction = run.friction ?? 'low';
  if (friction === 'low') return [];
  const opts = { branch, asOf };
  const patient = `Patient/${patientId}`;
  const now = Date.parse(asOf ?? store.now());
  const chart = {
    now,
    immunizations: await store.query('Immunization', { patient }, opts),
    problems: await store.query('Condition', { patient }, opts),
    allergies: (await store.query('AllergyIntolerance', { patient }, opts)).filter((a) => (a.clinicalStatus?.coding?.[0]?.code ?? 'active') === 'active'),
    observations: await store.query('Observation', { patient }, opts),
  };
  const day = new Date(now).toISOString().slice(0, 10);
  const relevant = ADVISORIES.filter((a) => a.context === context && (a.applies ? a.applies(chart) : friction === 'high'));
  const picked = friction === 'high' ? relevant
    : relevant.filter((a) => sample([run.seed ?? 0, run.id, patientId, a.id, day]) < 0.6).slice(0, 1);
  return picked.map(({ applies, ...a }) => a);
}

export function createEhrApi({ store }) {
  const badgeCache = new Map();
  return {
    async handle(req, url, body, ctx) {
      const parts = url.pathname.split('/').filter(Boolean).slice(1);
      const method = req.method;
      const run = ctx.run ?? await store.get('Run', LIVE_RUN_ID);

      if (parts[0] === 'catalog' && method === 'GET') return { status: 200, body: catalog() };

      // The dataset register (data/datasets.json), read-only: what was imported, from where, under which licence note.
      if (parts[0] === 'datasets' && parts.length === 1 && method === 'GET') return { status: 200, body: { datasets: readRegister() } };

      if (parts[0] === 'badges' && method === 'GET') {
        const opts = { branch: ctx.branch, asOf: ctx.asOf };
        // Every app's top bar asks for this; it only changes when something is written, so it is kept until the next write.
        const key = `${ctx.branch}|${ctx.asOf ?? ''}|${run.friction}`; const mark = await store.changeMark(['Observation', 'DocumentReference', 'Run']);
        const hit = badgeCache.get(key);
        if (hit && hit.mark === mark) return { status: 200, body: hit.body };
        const critical = (await store.query('Observation', { contains: [{ interpretation: [{ coding: [{ code: 'LL' }] }] }, { interpretation: [{ coding: [{ code: 'HH' }] }] }], where: (o) => isCritical(o) && !o._ack && o.status !== 'cancelled' }, opts))
          .map((o) => ({ id: o.id, patient: o._patient, display: o.code?.coding?.[0]?.display ?? 'Result', value: o.valueQuantity?.value ?? null, unit: o.valueQuantity?.unit ?? '', flag: o.interpretation?.[0]?.coding?.[0]?.code, effective: o.effectiveDateTime ?? o._validAt }));
        const unsigned = (await store.query('DocumentReference', { where: (d) => (d.docStatus ?? 'preliminary') === 'preliminary' }, opts))
          .map((d) => ({ id: d.id, patient: d._patient, type: d.type?.coding?.[0]?.display ?? 'Note', author: d.author?.[0]?.display ?? null, date: d.date ?? d._recordedAt }));
        const body = { criticalUnacknowledged: critical, unsignedNotes: unsigned, friction: run.friction };
        if (badgeCache.size > 50) badgeCache.clear();
        badgeCache.set(key, { mark, body });
        return { status: 200, body };
      }

      if (parts[0] === 'friction') {
        if (method === 'GET') return { status: 200, body: { runId: run.id, friction: run.friction } };
        if (method === 'PUT') {
          if (!FRICTION.includes(body?.level)) throw new HttpError(422, 'level must be low, realistic or high');
          const updated = await store.transaction(async (tx) => {
            const { _seq, ...current } = await tx.get('Run', run.id);
            const next = await tx.save('Run', { ...current, friction: body.level }, { updatedBy: ctx.actor.role });
            await recordAction(tx, { runId: run.id, actor: ctx.actor, kind: 'execute', action: 'friction.set', args: { level: body.level }, branch: run.branch, entityRef: `Run/${run.id}`, description: `friction set to ${body.level}` });
            return next;
          });
          return { status: 200, body: { runId: updated.id, friction: updated.friction } };
        }
      }

      if (parts[0] === 'advisories' && parts.length === 1 && method === 'GET') {
        const patientId = url.searchParams.get('patient');
        const context = url.searchParams.get('context');
        if (!patientId || !CONTEXTS.has(context)) throw new HttpError(400, `patient and context (${[...CONTEXTS].join(', ')}) are required`);
        return { status: 200, body: { friction: run.friction, advisories: await advisoriesFor(store, { patientId, context, run, branch: ctx.branch, asOf: ctx.asOf }) } };
      }

      if (parts[0] === 'advisories' && parts[1] === 'respond' && method === 'POST') {
        const advisory = ADVISORIES.find((a) => a.id === body?.id);
        if (!advisory) throw new HttpError(422, 'Unknown advisory id');
        if (!['enact', 'ignore'].includes(body.choice)) throw new HttpError(422, 'choice must be enact or ignore');
        if (ctx.asOf) throw new HttpError(409, 'Writes are disabled while viewing a past time');
        const patient = await store.get('Patient', String(body.patient || ''), { branch: ctx.branch });
        if (!patient) throw new HttpError(422, 'Unknown patient');
        // Enacting a follow-up writes a Task on the chart, so the role must be one that may create tasks.
        if (body.choice === 'enact' && advisory.action !== 'Acknowledge' && enforcedFor(ctx)) assertMayWrite(ctx.actor.role, 'Task', 'create');
        const result = await store.transaction(async (tx) => {
          let task = null;
          if (body.choice === 'enact' && advisory.action !== 'Acknowledge') {
            task = await tx.save('Task', {
              resourceType: 'Task', status: 'requested', intent: 'order',
              code: { coding: [{ system: 'urn:hospital-desktop:task', code: 'advisory-follow-up' }], text: advisory.title },
              description: advisory.detail, for: { reference: `Patient/${patient.id}` }, authoredOn: tx.now(),
              requester: { display: ctx.actor.id },
            }, { branch: ctx.branch, updatedBy: ctx.actor.role });
          }
          await recordAction(tx, {
            runId: run.id, actor: ctx.actor, kind: 'execute', action: 'advisory.respond', branch: ctx.branch,
            args: { advisory: advisory.id, context: advisory.context, choice: body.choice, task: task ? `Task/${task.id}` : null },
            entityRef: task ? `Task/${task.id}` : `Patient/${patient.id}`, patientRef: `Patient/${patient.id}`,
            description: `advisory ${advisory.id}: ${body.choice}`,
          });
          return { ok: true, task: task ? `Task/${task.id}` : null };
        });
        return { status: 200, body: result };
      }
      throw new HttpError(404, `${method} ${url.pathname} is not available`);
    },
  };
}
