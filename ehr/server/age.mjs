// Ages as of each patient's reference date (platform/web/shared/age.js has the rule).
// GET /api/ages?ids=a,b  ->  { ages: { <patient id>: { years, reference, basis, asOfYear, label } } }
// Reads follow the caller's branch and as-of time, like every other read.
import { HttpError } from '../../platform/server/http.mjs';
import { ageInfo, anchorYear } from '../../platform/web/shared/age.js';
import { RESTRICTED_URL, datasetsForPatients } from '../../platform/server/datasets.mjs';

const encounterDay = (e) => String(e.period?.end || e.period?.start || '').slice(0, 10);

/** The age record for one patient document. */
export async function ageFor(store, patient, { branch = 'main', asOf = null, alwaysCheckEncounters = false } = {}) {
  if (!patient) return null;
  const now = new Date(store.now());
  const restricted = (patient.extension || []).some((e) => e.url === RESTRICTED_URL) || datasetsForPatients([patient.id]).some((d) => d.restricted);
  const mayBeShifted = restricted || anchorYear(patient) != null || (patient.birthDate && String(patient.birthDate).slice(0, 10) > now.toISOString().slice(0, 10));
  let latestEncounter = null;
  if (mayBeShifted || (!asOf && alwaysCheckEncounters)) {
    const days = (await store.query('Encounter', { patient: `Patient/${patient.id}` }, { branch, asOf: asOf || undefined })).map(encounterDay).filter(Boolean).sort();
    latestEncounter = days.at(-1) ?? null;
  }
  return ageInfo(patient, { asOf, latestEncounter, restricted, now });
}

export function createAges({ store }) {
  return {
    async handle(req, url, body, ctx) {
      if (req.method !== 'GET') throw new HttpError(405, 'Ages are read-only');
      const opts = { branch: ctx.branch, asOf: ctx.asOf };
      const ids = String(url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 2000);
      if (!ids.length) throw new HttpError(422, 'ids is required: a comma-separated list of patient ids');
      const ages = {};
      for (let i = 0; i < ids.length; i += 8) {
        await Promise.all(ids.slice(i, i + 8).map(async (id) => {
          const p = await store.get('Patient', id, opts);
          if (p) ages[id] = await ageFor(store, p, { ...opts, alwaysCheckEncounters: ids.length <= 5 });
        }));
      }
      return { status: 200, body: { ages } };
    },
  };
}

/** What a briefing tells an agent about age: { years, asOf (the reference date), basis }, or null when there is no patient or no birth date. */
export async function briefingAge(store, run, patientRef) {
  const id = String(patientRef || '').startsWith('Patient/') ? String(patientRef).slice(8) : null;
  if (!id) return null;
  const p = await store.get('Patient', id, { branch: run.branch || 'main', asOf: run.asOf || undefined });
  const a = await ageFor(store, p, { branch: run.branch || 'main', asOf: run.asOf || null, alwaysCheckEncounters: true });
  return a && a.years != null ? { years: a.years, asOf: a.reference, basis: a.basis } : null;
}
