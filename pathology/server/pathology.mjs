// Pathology rules: the specimen hierarchy (case → part →
// block → slide), case accession numbers, stains, specimen types, synoptic
// templates, report sections and turnaround targets. Lists marked unverified
// are small starter sets, not reference tables.
import { HttpError } from '../../platform/server/http.mjs';
import { lifecycleOf, LIFECYCLE_URL } from '../../platform/server/state-machines.mjs';

export const PATH_URLS = {
  level: 'urn:hospital-desktop:specimen-level',
  stain: 'urn:hospital-desktop:stain',
  caseRef: 'urn:hospital-desktop:case',
  clinical: 'urn:hospital-desktop:report-clinical',
  gross: 'urn:hospital-desktop:report-gross',
  micro: 'urn:hospital-desktop:report-micro',
  comment: 'urn:hospital-desktop:report-comment',
  synoptic: 'urn:hospital-desktop:report-synoptic',
  critical: 'urn:hospital-desktop:report-critical',
  criticalTold: 'urn:hospital-desktop:critical-communicated',
  findings: 'urn:hospital-desktop:report-findings',
  addendumOf: 'urn:hospital-desktop:addendum-of',
};
export const ACCESSION_SYSTEM = 'urn:hospital-desktop:accession';
export const HISTOLOGY_SYSTEM = 'urn:hospital-desktop:histology';
export const CATEGORY_SYSTEM = 'urn:hospital-desktop:category';
export const ORDER_CATEGORY_SYSTEM = 'urn:hospital-desktop:order-category';
export const LEVELS = ['case', 'part', 'block', 'slide'];
export const SPECIMEN_TYPES = ['Biopsy', 'Excision', 'Resection', 'Polypectomy', 'Curettage', 'Cytology'];
export const STAINS_UNVERIFIED = true;
export const STAINS = [
  { code: 'HE', display: 'H&E', kind: 'routine' },
  { code: 'PAS', display: 'PAS', kind: 'special' }, { code: 'TRI', display: 'Trichrome', kind: 'special' }, { code: 'CONGO', display: 'Congo red', kind: 'special' }, { code: 'GIEMSA', display: 'Giemsa', kind: 'special' }, { code: 'ZN', display: 'Ziehl-Neelsen', kind: 'special' }, { code: 'GMS', display: 'Grocott', kind: 'special' }, { code: 'RETIC', display: 'Reticulin', kind: 'special' },
  { code: 'CK7', display: 'CK7', kind: 'immuno' }, { code: 'CK20', display: 'CK20', kind: 'immuno' }, { code: 'TTF1', display: 'TTF-1', kind: 'immuno' }, { code: 'ER', display: 'ER', kind: 'immuno' }, { code: 'PR', display: 'PR', kind: 'immuno' }, { code: 'HER2', display: 'HER2', kind: 'immuno' }, { code: 'KI67', display: 'Ki-67', kind: 'immuno' }, { code: 'P53', display: 'p53', kind: 'immuno' }, { code: 'CD3', display: 'CD3', kind: 'immuno' }, { code: 'CD20', display: 'CD20', kind: 'immuno' },
];
export const STAIN_BY_CODE = new Map(STAINS.map((s) => [s.code, s]));
export const stainOf = (text) => STAINS.find((s) => s.code === text || s.display.toLowerCase() === String(text || '').toLowerCase()) || null;
export const HISTOLOGY_KINDS = { recut: 'Recut', levels: 'Deeper levels', stain: 'Additional stain' };
export const TAT_TARGET_MINUTES = { stat: 240, urgent: 1440, routine: 2880 }; // unverified starter targets
export const SYNOPTIC_UNVERIFIED = true;
export const SYNOPTIC = {
  'tumour-resection': { label: 'Tumour resection (generic)', fields: [['procedure', 'Procedure'], ['site', 'Tumour site'], ['histologicType', 'Histologic type'], ['grade', 'Grade'], ['sizeMm', 'Greatest dimension (mm)'], ['margins', 'Margins'], ['nodesExamined', 'Lymph nodes examined'], ['nodesPositive', 'Lymph nodes positive'], ['pT', 'pT'], ['pN', 'pN']] },
  biopsy: { label: 'Biopsy (generic)', fields: [['site', 'Site'], ['procedure', 'Procedure'], ['histologicType', 'Histologic type'], ['grade', 'Grade'], ['inflammation', 'Inflammation'], ['dysplasia', 'Dysplasia']] },
};

export const ext = (doc, url) => (doc?.extension || []).find((e) => e.url === url);
export const extString = (doc, url) => ext(doc, url)?.valueString ?? null;
export const levelOf = (s) => ext(s, PATH_URLS.level)?.valueCode ?? null;
export const isCase = (s) => s?.resourceType === 'Specimen' && levelOf(s) === 'case';
export const isPathologyOrder = (o) => o?.resourceType === 'ServiceRequest' && (o.category || []).some((c) => (c.coding || []).some((x) => x.code === 'pathology'));
export const isPathologyReport = (r) => r?.resourceType === 'DiagnosticReport' && (r.category || []).some((c) => (c.coding || []).some((x) => x.code === 'pathology' || (x.code === 'PAT' && /v2-0074/.test(x.system || ''))));
export const isHistologyTask = (t) => t?.resourceType === 'Task' && (t.code?.coding || []).some((c) => c.system === HISTOLOGY_SYSTEM);
export const caseState = (s) => lifecycleOf(s);

/** The next case accession: S + two-digit year + five digits, unique among the existing case specimens. */
export function caseAccession(now, existing) {
  const yy = String(new Date(now).getUTCFullYear()).slice(-2);
  const used = new Set(existing.map((s) => s.accessionIdentifier?.value).filter(Boolean));
  for (let n = 1; n < 100000; n += 1) { const v = `S${yy}-${String(n).padStart(5, '0')}`; if (!used.has(v)) return v; }
  throw new HttpError(500, 'No case accession number left');
}

/** Validates the accessioning request. parts: [{ description, blocks: [{ slides: [stain code or display] }] }]. */
export function normaliseParts(parts) {
  if (!Array.isArray(parts) || !parts.length || parts.length > 26) throw new HttpError(422, 'A case needs 1 to 26 parts');
  return parts.map((p, i) => {
    const blocks = Array.isArray(p?.blocks) && p.blocks.length ? p.blocks : [{ slides: ['HE'] }];
    if (blocks.length > 99) throw new HttpError(422, 'A part may have at most 99 blocks');
    const label = String.fromCharCode(65 + i);
    return { label, description: String(p?.description || '').trim().slice(0, 200) || `Part ${label}`, blocks: blocks.map((b, j) => {
      const slides = Array.isArray(b?.slides) && b.slides.length ? b.slides : ['HE'];
      return { label: `${label}${j + 1}`, slides: slides.map((st) => { const s = stainOf(st); if (!s) throw new HttpError(422, `Unknown stain "${st}"`); return s; }) };
    }) };
  });
}

/** The Specimen documents of a case tree, children carrying a temporary parent key the API resolves after saving each level. */
export function caseDocuments({ accession, patientRef, orderRef, type, collectedAt, receivedAt, gross, collector, priority }) {
  const common = { resourceType: 'Specimen', status: 'available', subject: { reference: patientRef }, ...(orderRef ? { request: [{ reference: orderRef }] } : {}) };
  const caseDoc = {
    ...common, accessionIdentifier: { system: ACCESSION_SYSTEM, value: accession }, type: { text: type }, collection: { collectedDateTime: collectedAt, ...(collector ? { collector: { display: collector } } : {}) }, receivedTime: receivedAt,
    ...(gross ? { note: [{ text: gross }] } : {}),
    extension: [{ url: LIFECYCLE_URL, valueCode: 'collected' }, { url: PATH_URLS.level, valueCode: 'case' }, ...(priority ? [{ url: 'urn:hospital-desktop:priority', valueCode: priority }] : [])],
  };
  return { caseDoc, common };
}
export const partDoc = (common, caseId, part) => ({ ...common, parent: [{ reference: `Specimen/${caseId}` }], identifier: [{ system: ACCESSION_SYSTEM, value: part.label }], type: { text: part.description }, extension: [{ url: PATH_URLS.level, valueCode: 'part' }] });
export const blockDoc = (common, partId, block) => ({ ...common, parent: [{ reference: `Specimen/${partId}` }], identifier: [{ system: ACCESSION_SYSTEM, value: block.label }], type: { text: 'Paraffin block' }, extension: [{ url: PATH_URLS.level, valueCode: 'block' }] });
export const slideDoc = (common, blockId, label, stain) => ({ ...common, parent: [{ reference: `Specimen/${blockId}` }], identifier: [{ system: ACCESSION_SYSTEM, value: label }], type: { text: 'Glass slide' }, extension: [{ url: PATH_URLS.level, valueCode: 'slide' }, { url: PATH_URLS.stain, valueCoding: { system: 'urn:hospital-desktop:stain', code: stain.code, display: stain.display } }] });
export const stainOfSlide = (s) => ext(s, PATH_URLS.stain)?.valueCoding || null;

/** Minutes from receipt to sign-out, and whether the case is over its target. */
export function turnaround(caseSpecimen, signedAt, now, priority = 'routine') {
  const from = caseSpecimen.receivedTime || caseSpecimen._recordedAt;
  const to = signedAt || now;
  const minutes = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60000));
  return { minutes, target: TAT_TARGET_MINUTES[priority] ?? TAT_TARGET_MINUTES.routine, over: minutes > (TAT_TARGET_MINUTES[priority] ?? TAT_TARGET_MINUTES.routine) };
}

/** Sign-out rules for a pathology report, used by the DiagnosticReport state machine guard. */
export function pathologySignIssue(next) {
  const addendum = Boolean(extString(next, PATH_URLS.addendumOf));
  if (addendum) return (extString(next, PATH_URLS.findings) || '').trim() ? null : 'An addendum needs text before it can be signed';
  if (!(next.conclusion || '').trim()) return 'A final diagnosis is required before a pathology report can be signed';
  if (ext(next, PATH_URLS.critical)?.valueBoolean) {
    let told = null; try { told = JSON.parse(extString(next, PATH_URLS.criticalTold) || 'null'); } catch { told = null; }
    if (!told || !told.to || !told.at) return 'A critical or unexpected diagnosis must document who was told and when before signing';
  }
  return null;
}
export const reportSections = (d) => [PATH_URLS.clinical, PATH_URLS.gross, PATH_URLS.micro, PATH_URLS.comment, PATH_URLS.synoptic].map((u) => (extString(d, u) || '').trim());
