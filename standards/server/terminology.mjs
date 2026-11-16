// FHIR terminology operations: CodeSystem/$lookup, CodeSystem/$validate-code, ValueSet/$validate-code, ValueSet/$expand
// and ConceptMap/$translate. Codes come from the reference database you import (LOINC, RxNorm, NDC, ICD-10-CM and
// PCS, HCPCS, CPT and SNOMED CT from your own licensed files, CVX, NUCC, X12 code lists) and, for the codes the
// platform itself uses, from its catalogue. UCUM units are checked by the UCUM library. Nothing is invented: a code
// that is not loaded is "not found", and the answer says which release was asked.
import { createRequire } from 'node:module';
import { HttpError } from '../../platform/server/http.mjs';
import * as ref from '../../insurance-and-billing/server/reference.mjs';
import { LABS, MEDICATIONS, VITALS, PROBLEMS, IMAGING } from '../../ehr/server/catalog.mjs';

const require = createRequire(import.meta.url);
/** FHIR system URL -> the name the reference database files codes under. */
export const SYSTEMS = {
  'http://loinc.org': 'LOINC', 'http://www.nlm.nih.gov/research/umls/rxnorm': 'RXNORM', 'http://hl7.org/fhir/sid/ndc': 'NDC',
  'http://hl7.org/fhir/sid/icd-10-cm': 'ICD-10-CM', 'http://www.cms.gov/Medicare/Coding/ICD10': 'ICD-10-PCS', 'http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets': 'HCPCS',
  'http://www.ama-assn.org/go/cpt': 'CPT', 'http://hl7.org/fhir/sid/cvx': 'CVX', 'http://nucc.org/provider-taxonomy': 'NUCC', 'http://snomed.info/sct': 'SNOMED',
  'https://x12.org/codes/claim-adjustment-reason-codes': 'CARC', 'https://x12.org/codes/remittance-advice-remark-codes': 'RARC', 'https://x12.org/codes/claim-status-codes': 'CSC', 'https://x12.org/codes/claim-status-category-codes': 'CSCC',
  'http://unitsofmeasure.org': 'UCUM',
};
const URL_OF = Object.fromEntries(Object.entries(SYSTEMS).map(([u, n]) => [n, u]));
// What the platform's own screens use, so the operations answer for those codes even before any file is imported.
const CATALOGUE = {
  LOINC: new Map([...LABS, ...VITALS, ...IMAGING].filter((x) => /^\d+-\d$/.test(String(x.code))).map((x) => [String(x.code), x.name || x.display])),
  RXNORM: new Map(MEDICATIONS.map((m) => [String(m.code), m.name])),
  'ICD-10-CM': new Map(PROBLEMS.filter((p) => p.icd10 || p.code).map((p) => [String(p.icd10 || p.code).replace('.', ''), p.name || p.display])),
};
let ucum = null; const ucumUtils = () => (ucum ||= require('@lhncbc/ucum-lhc').UcumLhcUtils.getInstance());

/** One code: { found, display, system, version, billable?, inactive?, from }. */
export function lookup(systemUrl, code) {
  const name = SYSTEMS[systemUrl]; if (!name) return { found: false, reason: `The system ${systemUrl} is not one this server knows` };
  const c = String(code ?? '').trim(); if (!c) return { found: false, reason: 'No code given' };
  if (name === 'UCUM') { const r = ucumUtils().validateUnitString(c); return r.status === 'valid' ? { found: true, display: r.unit?.name || c, system: systemUrl, from: { source: 'UCUM library (@lhncbc/ucum-lhc)' } } : { found: false, reason: (r.msg || ['Not a valid UCUM unit']).join('; ') }; }
  const k = name.startsWith('ICD') ? c.replace('.', '').toUpperCase() : c;
  let row = null; try { row = ref.code(name, k); } catch { row = null; }
  if (row) return { found: true, display: row.long || row.short || null, short: row.short || null, billable: row.billable ?? null, system: systemUrl, version: row.from?.release || null, from: row.from, extra: Object.fromEntries(Object.entries(row).filter(([key]) => !['system', 'code', 'short', 'long', 'billable', 'from'].includes(key))) };
  const cat = CATALOGUE[name]?.get(k); if (cat) return { found: true, display: cat, system: systemUrl, from: { source: 'the platform catalogue (only the codes its screens use)' } };
  return { found: false, reason: ref.latest(KIND_OF[name] || '') ? `${c} is not in the loaded ${name} release` : `${name} is not loaded yet (npm run import -- --payer-reference <folder>)` };
}
const KIND_OF = { LOINC: 'loinc', RXNORM: 'rxnorm', NDC: 'ndc', 'ICD-10-CM': 'icd10cm', 'ICD-10-PCS': 'icd10pcs', HCPCS: 'hcpcs', CPT: 'cpt', CVX: 'cvx', NUCC: 'nucc', SNOMED: 'snomed', CARC: 'carc', RARC: 'rarc', CSC: 'csc', CSCC: 'cscc' };

/** Implicit value sets: "<system>?fhir_vs" is every code in the system (FHIR R4 section 4.9.4). */
const systemOfValueSet = (url) => { const m = /^(.*)\?fhir_vs$/.exec(String(url || '')); return m && SYSTEMS[m[1]] ? m[1] : SYSTEMS[url] ? url : null; };
export function expand(url, { filter = '', count = 100, offset = 0 } = {}) {
  const sys = systemOfValueSet(url); if (!sys) throw new HttpError(404, `No value set ${url}. Use an implicit value set such as http://loinc.org?fhir_vs`, 'not-found');
  const name = SYSTEMS[sys]; if (name === 'UCUM') throw new HttpError(422, 'UCUM is a grammar, not a list: it cannot be expanded. Use $validate-code', 'too-costly');
  const n = Math.min(1000, Math.max(1, Number(count) || 100)); let rows = [];
  try { rows = ref.searchCodes(name, String(filter || ''), n + Number(offset || 0)).slice(Number(offset || 0)).map((r) => ({ code: r.code, display: r.long || r.short })); } catch { rows = []; }
  if (!rows.length && CATALOGUE[name]) rows = [...CATALOGUE[name]].filter(([c, d]) => !filter || `${c} ${d}`.toLowerCase().includes(String(filter).toLowerCase())).slice(Number(offset || 0), Number(offset || 0) + n).map(([code, display]) => ({ code, display }));
  return { resourceType: 'ValueSet', url: `${sys}?fhir_vs`, status: 'active', expansion: { identifier: `urn:uuid:${crypto.randomUUID()}`, timestamp: new Date().toISOString(), offset: Number(offset || 0), parameter: filter ? [{ name: 'filter', valueString: String(filter) }] : undefined, contains: rows.map((r) => ({ system: sys, code: r.code, display: r.display })) } };
}
/** Maps between systems: NDC to RxNorm (from RxNorm's own NDC attributes), ICD-10-CM to CMS-HCC (from the model's mapping file), and local analyzer codes to LOINC (LIVD files). */
export function translate({ system, code, targetsystem }, { livd = null } = {}) {
  const name = SYSTEMS[system] || system; const target = SYSTEMS[targetsystem] || targetsystem; const out = [];
  if (name === 'NDC' && (!target || target === 'RXNORM')) { const r = lookup('http://hl7.org/fhir/sid/ndc', code); if (r.found && r.extra?.rxcui) out.push({ equivalence: 'equivalent', concept: { system: URL_OF.RXNORM, code: r.extra.rxcui, display: lookup(URL_OF.RXNORM, r.extra.rxcui).display ?? undefined } }); }
  if (name === 'ICD-10-CM' && (!target || /hcc/i.test(String(target)))) { let rows = []; try { rows = ref.hccFor(code); } catch { rows = []; } for (const h of rows) out.push({ equivalence: 'wider', concept: { system: `http://terminology.hl7.org/CodeSystem/cmshcc${h.model ? `-${h.model}` : ''}`, code: h.hcc } }); }
  if (livd && (!target || target === 'LOINC')) for (const m of livd(system, code)) out.push({ equivalence: 'equivalent', concept: { system: URL_OF.LOINC, code: m.loinc, display: m.display || undefined } });
  return { resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: out.length > 0 }, ...(out.length ? [] : [{ name: 'message', valueString: 'No mapping loaded for this code' }]), ...out.map((m) => ({ name: 'match', part: [{ name: 'equivalence', valueCode: m.equivalence }, { name: 'concept', valueCoding: m.concept }] }))] };
}
const params = (url, body) => { const p = Object.fromEntries(url.searchParams); for (const x of body?.parameter || []) { const v = x.valueUri ?? x.valueCode ?? x.valueString ?? x.valueCanonical ?? x.valueInteger ?? x.valueCoding; if (x.name === 'coding' && x.valueCoding) { p.system = x.valueCoding.system; p.code = x.valueCoding.code; } else if (v !== undefined) p[x.name] = v; } return p; };

/** Routes /fhir/R4/CodeSystem/$lookup and the others. Returns null when the path is not a terminology operation. */
export function handleTerminology(type, op, url, body, { livd = null } = {}) {
  const p = params(url, body);
  if (type === 'CodeSystem' && op === '$lookup') { const r = lookup(p.system, p.code); if (!r.found) throw new HttpError(404, r.reason, 'not-found'); return { resourceType: 'Parameters', parameter: [{ name: 'name', valueString: SYSTEMS[p.system] }, ...(r.version ? [{ name: 'version', valueString: String(r.version) }] : []), { name: 'display', valueString: r.display || p.code }, ...(r.billable != null ? [{ name: 'property', part: [{ name: 'code', valueCode: 'billable' }, { name: 'value', valueBoolean: r.billable }] }] : []), ...(r.short && r.short !== r.display ? [{ name: 'designation', part: [{ name: 'use', valueCoding: { system: 'http://snomed.info/sct', code: '900000000000013009', display: 'Synonym' } }, { name: 'value', valueString: r.short }] }] : [])] }; }
  if ((type === 'CodeSystem' || type === 'ValueSet') && op === '$validate-code') { const sys = p.system || systemOfValueSet(p.url); const r = sys ? lookup(sys, p.code) : { found: false, reason: 'Give system and code (or url and code)' }; const displayOk = !p.display || !r.display || String(r.display).toLowerCase() === String(p.display).toLowerCase(); return { resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: Boolean(r.found && displayOk) }, ...(r.display ? [{ name: 'display', valueString: r.display }] : []), ...(!r.found ? [{ name: 'message', valueString: r.reason }] : !displayOk ? [{ name: 'message', valueString: `The display for ${p.code} is "${r.display}", not "${p.display}"` }] : [])] }; }
  if (type === 'ValueSet' && op === '$expand') return expand(p.url, { filter: p.filter, count: p.count, offset: p.offset });
  if (type === 'ConceptMap' && op === '$translate') return translate({ system: p.system, code: p.code, targetsystem: p.targetsystem || p.targetSystem }, { livd });
  return null;
}
