// Age, worked out as of a patient's reference date (never a negative number).
// Some sources move every date far into the future to protect privacy, so
// "years since birth up to today" is wrong for them. The reference date is:
//   1. the chart's as-of time, when someone is viewing a past time;
//   2. otherwise, for a restricted or date-shifted source, the patient's latest
//      encounter, or failing that the source's anchor year;
//   3. otherwise today.
// Used by the server (ehr/server/age.mjs) and by pages as a fallback.

export const ANCHOR_YEAR_URL = 'urn:hospital-desktop:anchor-year';
const RESTRICTED_URL = 'urn:hospital-desktop:restricted-source';
const day = (v) => (v instanceof Date ? v.toISOString() : String(v || '')).slice(0, 10);

/** Whole years from birthDate to ref (dates or ISO text). null when either is missing or ref is before birth. */
export function ageYears(birthDate, ref) {
  const b = day(birthDate), r = day(ref);
  if (!/^\d{4}/.test(b) || !/^\d{4}/.test(r)) return null;
  const [by, bm = 1, bd = 1] = b.split('-').map(Number); const [ry, rm = 1, rd = 1] = r.split('-').map(Number);
  let years = ry - by; if (rm < bm || (rm === bm && rd < bd)) years -= 1;
  return years >= 0 ? years : null;
}

/** The anchor year written on the patient by the source, if any. */
export function anchorYear(patient) {
  const e = (patient?.extension || []).find((x) => x.url === ANCHOR_YEAR_URL);
  const y = Number(e?.valueInteger ?? e?.valueString ?? e?.valueDate?.slice(0, 4));
  return Number.isInteger(y) && y > 0 ? y : null;
}

/**
 * The reference date and the age on it.
 * asOf: the chart's as-of time, or null. latestEncounter: ISO date of the patient's latest encounter, or null.
 * restricted: the patient comes from a restricted source. now: today.
 * Returns { years, reference (YYYY-MM-DD), basis: 'as-of' | 'latest-encounter' | 'anchor-year' | 'today', asOfYear, label }.
 */
export function ageInfo(patient, { asOf = null, latestEncounter = null, restricted = false, now = new Date() } = {}) {
  const today = day(now); const birth = patient?.birthDate || null; const anchor = anchorYear(patient);
  const shifted = restricted || anchor != null || (patient?.extension || []).some((x) => x.url === RESTRICTED_URL)
    || (birth && day(birth) > today) || (latestEncounter && day(latestEncounter) > today);
  let reference = today, basis = 'today';
  // A date-shifted patient can be "born" after the as-of time (the as-of time is a real clock time): then the shifted rule applies.
  if (asOf && !(shifted && birth && ageYears(birth, asOf) == null)) { reference = day(asOf); basis = 'as-of'; }
  else if (shifted && latestEncounter) { reference = day(latestEncounter); basis = 'latest-encounter'; }
  else if (shifted && anchor != null) { reference = `${String(anchor).padStart(4, '0')}-12-31`; basis = 'anchor-year'; }
  const years = birth ? ageYears(birth, reference) : null;
  const asOfYear = reference === today ? null : Number(reference.slice(0, 4));
  // A date-shifted source's reference year is far in the future and means nothing to a reader: show the age alone.
  const label = years == null ? '' : asOfYear == null || basis !== 'as-of' ? `${years} y` : `${years} y (as of ${asOfYear})`;
  return { years, reference, basis, asOfYear, label };
}
