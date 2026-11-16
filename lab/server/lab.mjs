// Laboratory rules: the specimen lifecycle, accession numbers,
// benches, delta checks, auto-verification rules, critical "phoned to"
// records and a small quality-control log with Levey-Jennings statistics.
// Pure helpers; lab-api.mjs does the transactions.
import { HttpError } from '../../platform/server/http.mjs';
import { SYSTEMS, LAB_BY_CODE, PANELS } from '../../ehr/server/catalog.mjs';
import { lifecycleOf } from '../../platform/server/state-machines.mjs';

export const LAB_URLS = {
  bench: 'urn:hospital-desktop:bench',
  delta: 'urn:hospital-desktop:delta-check',
  phoned: 'urn:hospital-desktop:phoned-to',
  enteredBy: 'urn:hospital-desktop:entered-by',
  autoVerified: 'urn:hospital-desktop:auto-verified',
  specimen: 'urn:hospital-desktop:specimen',
  tubeLabel: 'urn:hospital-desktop:tube-label',
};
export const SPECIMEN_STATES = ['ordered', 'collected', 'in-transit', 'received', 'in-process', 'resulted', 'verified', 'corrected', 'rejected'];
export const BENCHES = ['chemistry', 'haematology', 'coagulation', 'microbiology'];
export const REJECTION_REASONS = ['haemolysed', 'clotted', 'unlabelled', 'insufficient', 'wrong tube', 'leaked'];
export const TARGET_MINUTES = { stat: 60, urgent: 120, routine: 240 };
// Which bench runs each analyte (by LOINC); anything unknown goes to chemistry. Starter mapping, unverified.
const HAEM = new Set(['6690-2', '789-8', '718-7', '4544-3', '787-2', '777-3']);
const COAG = new Set(['5902-2', '6301-6', '3173-2']);
export const benchFor = (codes) => (codes.some((c) => HAEM.has(c)) ? 'haematology' : codes.some((c) => COAG.has(c)) ? 'coagulation' : 'chemistry');
// Delta-check limits per analyte as a fraction of the previous value (unverified starter set); default 0.5.
export const DELTA_LIMITS = { '2160-0': 0.3, '2823-3': 0.25, '2951-2': 0.06, '718-7': 0.2, '777-3': 0.35, '2345-7': 0.6, unverified: true };
export const deltaLimit = (code) => (typeof DELTA_LIMITS[code] === 'number' ? DELTA_LIMITS[code] : 0.5);

const loinc = (o) => (o?.code?.coding || []).find((c) => c.system === SYSTEMS.loinc)?.code ?? null;
export const extString = (doc, url) => (doc?.extension || []).find((e) => e.url === url)?.valueString ?? null;
export const withExt = (doc, url, key, value) => ({ ...doc, extension: [...(doc.extension || []).filter((e) => e.url !== url), ...(value == null ? [] : [{ url, [key]: value }])] });
export const isLabOrder = (o) => o?.resourceType === 'ServiceRequest' && (o.category || []).some((c) => (c.coding || []).some((x) => x.code === 'laboratory'));
export const analytesOf = (order) => { const code = loinc(order); const panel = PANELS.find((p) => p.code === code); return (panel ? panel.components : [code]).map((c) => LAB_BY_CODE.get(c)).filter(Boolean); };

/** Accession number: A + two-digit year + five digits, unique per day sequence. */
export function accessionNumber(now, existing) {
  const yy = String(new Date(now).getUTCFullYear()).slice(2);
  const used = new Set(existing.map((s) => s.accessionIdentifier?.value).filter(Boolean));
  for (let n = 1; n < 100000; n += 1) { const v = `A${yy}-${String(n).padStart(5, '0')}`; if (!used.has(v)) return v; }
  throw new HttpError(500, 'No accession number left');
}

/** A new Specimen for an order, in the collected state. */
export function collectedSpecimen({ order, patientRef, collector, now, type, tubeLabel }) {
  const codes = analytesOf(order).map((a) => a.code);
  return {
    resourceType: 'Specimen', status: 'available', subject: { reference: patientRef }, request: [{ reference: `ServiceRequest/${order.id}` }],
    type: { text: type || 'Blood' }, collection: { collectedDateTime: now, collector: { display: collector } },
    extension: [{ url: 'urn:hospital-desktop:lifecycle', valueCode: 'collected' }, { url: LAB_URLS.bench, valueString: benchFor(codes) }, { url: LAB_URLS.tubeLabel, valueString: tubeLabel }],
  };
}

/** Delta check of a new value against the previous final result for the same analyte. */
export function deltaCheck(code, value, previous) {
  const prev = previous?.valueQuantity?.value;
  if (typeof prev !== 'number' || prev === 0 || typeof value !== 'number') return null;
  const change = Math.abs(value - prev) / Math.abs(prev);
  const limit = deltaLimit(code);
  if (change <= limit) return null;
  return { previous: prev, previousAt: previous.effectiveDateTime || previous._validAt, change: Math.round(change * 100) / 100, limit, message: `Delta check: ${Math.round(change * 100)}% change from ${prev} (limit ${Math.round(limit * 100)}%)` };
}

/** May this result be auto-verified: analyte on the list, in range, no delta flag, not critical. */
export function autoVerifiable(obs, config) {
  const code = loinc(obs);
  if (!config?.autoVerify?.includes(code)) return false;
  const flag = obs.interpretation?.[0]?.coding?.[0]?.code;
  if (flag && flag !== 'N') return false;
  if (extString(obs, LAB_URLS.delta)) return false;
  return true;
}

/** Levey-Jennings statistics for a series of QC points against the lot's mean and SD. */
export function leveyJennings(points, { mean, sd }) {
  const z = (v) => (sd ? (v - mean) / sd : 0);
  const rows = points.map((p) => ({ ...p, z: Math.round(z(p.value) * 100) / 100 }));
  const last = rows[rows.length - 1] || null;
  const rules = [];
  if (last && Math.abs(last.z) > 3) rules.push('1-3s');
  if (last && Math.abs(last.z) > 2) rules.push('1-2s');
  const lastTwo = rows.slice(-2);
  if (lastTwo.length === 2 && lastTwo.every((p) => p.z > 2) || lastTwo.length === 2 && lastTwo.every((p) => p.z < -2)) rules.push('2-2s');
  const lastTen = rows.slice(-10);
  if (lastTen.length === 10 && (lastTen.every((p) => p.z > 0) || lastTen.every((p) => p.z < 0))) rules.push('10x');
  return { mean, sd, points: rows, last, rules, outOfRange: Boolean(last && Math.abs(last.z) > 2) };
}

/** Specimen state names a person can use, with the FHIR status kept in step. */
export const specimenState = (s) => lifecycleOf(s);

/** Turnaround minutes from collection to verification for a verified specimen. */
export function turnaroundMinutes(specimen, verifiedAt) {
  const c = specimen.collection?.collectedDateTime;
  if (!c || !verifiedAt) return null;
  return Math.max(0, Math.round((Date.parse(verifiedAt) - Date.parse(c)) / 60000));
}

export const criticalFlag = (o) => (o.interpretation || []).some((i) => (i.coding || []).some((c) => c.code === 'LL' || c.code === 'HH'));
export const phonedOf = (o) => { try { return JSON.parse(extString(o, LAB_URLS.phoned) || 'null'); } catch { return null; } };
