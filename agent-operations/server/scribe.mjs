// Scribe benchmark (§9j): given an encounter transcript and the chart as it
// was at that moment, how well does an agent write the structured note?
//
// The scoring functions at the top are pure. The agent's note is compared
// with a list of gold clinical elements; nothing here calls a model.
//   completeness   share of gold elements that appear in the note
//   accuracy       of those that appear, the share stated correctly
//                  (wrong negation, side or dose is an error)
//   hallucination  clinical terms, codes and quantities in the note that
//                  neither the transcript nor the chart supports
//   format         required sections present and in order
//   time           wall-clock time the agent took
// These are text-matching proxies for a rule-based reference pipeline. They
// do not establish that a note is clinically safe.
import { libraryFiles } from '../../platform/server/library.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../../platform/server/http.mjs';
import { createObjectStore } from '../../platform/server/storage.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { createRun, endRun, withStatus } from './runs.mjs';
import { HTEST } from './hitl.mjs';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';

export const GOLD_NOTE_URL = 'urn:hospital-desktop:gold-note';
export const ELEMENT_URL = 'urn:hospital-desktop:note-element';
export const TRANSCRIPT_TYPE = { system: 'urn:hospital-desktop:doc-type', code: 'transcript', display: 'Encounter transcript' };
const MR = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR', display: 'Medical record number' }] };
const UNIT = { m: 60e3, h: 3600e3, d: 24 * 3600e3 };
const round = (v, d = 3) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const unb64 = (data) => Buffer.from(String(data || ''), 'base64').toString('utf8');
export const scribeDir = () => path.resolve(REPO_ROOT, process.env.SCRIBE_DIR || 'data/scribe');

// Terms the grader recognises as clinical statements when looking for unsupported content.
export const LEXICON = [
  ['hypertension', 'high blood pressure'], ['chest pain'], ['headache'], ['pneumonia'], ['pneumothorax'], ['pulmonary embolism'], ['heart failure'], ['polyp'], ['diabetes'], ['asthma'], ['copd'],
  ['sepsis'], ['stroke'], ['myocardial infarction', 'heart attack'], ['acute coronary syndrome', 'unstable angina'], ['atrial fibrillation'], ['anaemia', 'anemia'], ['bleeding'], ['fever', 'febrile'],
  ['cough'], ['shortness of breath', 'breathless'], ['nausea'], ['vomiting'], ['oedema', 'edema', 'swelling'], ['lisinopril'], ['amlodipine'], ['amoxicillin'], ['ceftriaxone'], ['aspirin'], ['furosemide'],
  ['metoprolol'], ['metformin'], ['atorvastatin'], ['heparin'], ['warfarin'], ['insulin'], ['ibuprofen'], ['paracetamol', 'acetaminophen'], ['morphine'], ['penicillin'], ['colonoscopy'], ['ecg', 'electrocardiogram'],
  ['troponin'], ['chest x-ray', 'chest film'], ['ct scan'], ['basic metabolic panel'], ['echocardiogram'], ['diverticulosis'], ['perforation'],
].map((terms) => ({ label: terms[0], terms }));
const NEGATION = /\b(no|not|denies|denied|without|negative for|ruled out|rules out|no evidence of|free of|never|none)\b/i;
const QUANTITY = /\b\d+(?:\.\d+)?(?:\/\d+)?\s?(?:mg|mcg|g|kg|ml|units?|mmhg|%|days?|weeks?|months?|years?|mm|cm|bpm|hours?)\b/gi;
const normQ = (q) => q.toLowerCase().replace(/\s+/g, '').replace(/s$/, '');

const termRe = (terms) => new RegExp(`(?<![A-Za-z0-9])(?:${[...terms].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![A-Za-z0-9])`, 'i');

/** Splits a note into its headed sections. A heading is a line "Name:" (text may follow on the same line). */
export function parseSections(text, headings) {
  const found = [];
  const re = new RegExp(`^\\s*(${headings.map(escape).join('|')})\\s*:`, 'gim');
  for (const m of String(text).matchAll(re)) found.push({ name: headings.find((h) => h.toLowerCase() === m[1].toLowerCase()), at: m.index, bodyStart: m.index + m[0].length });
  return found.map((f, i) => ({ name: f.name, start: f.bodyStart, end: i + 1 < found.length ? found[i + 1].at : text.length, text: text.slice(f.bodyStart, i + 1 < found.length ? found[i + 1].at : text.length) }));
}

/** The sentence around a position: bounded by full stops, semicolons and line breaks. */
function sentenceAt(text, index) {
  let start = index; let end = index;
  while (start > 0 && !'.;\n'.includes(text[start - 1])) start -= 1;
  while (end < text.length && !'.;\n'.includes(text[end])) end += 1;
  return { start, end, text: text.slice(start, end) };
}

function mention(text, terms, offset = 0) {
  const m = termRe(terms).exec(text);
  if (!m) return null;
  const s = sentenceAt(text, m.index);
  // A negation word counts only inside the same clause as the term ("no longer swollen and weight is down" does not negate the weight).
  const clause = s.text.slice(0, m.index - s.start).split(/,|\band\b|\bbut\b|:/i).at(-1);
  return { start: offset + m.index, end: offset + m.index + m[0].length, sentence: s.text, negated: NEGATION.test(clause) };
}

export function formatCompliance(text, required) {
  const sections = parseSections(text, required);
  const present = required.filter((h) => sections.some((s) => s.name === h && s.text.trim()));
  const order = sections.map((s) => required.indexOf(s.name));
  const ordered = order.every((v, i) => i === 0 || v > order[i - 1]);
  const score = required.length ? (present.length / required.length) * (ordered ? 1 : 0.5) : 1;
  return { required, present, missing: required.filter((h) => !present.includes(h)), ordered, score: round(score) };
}

/**
 * Compares a note with the gold elements.
 * coded: codes the agent attached to the note ("ICD-10:J18.9").
 * source: transcript plus chart text; anything clinical in the note must be mentioned there.
 */
export function scoreNote({ note, coded = [], goldElements, sections, source }) {
  const parts = parseSections(note, sections);
  const src = String(source || '');
  const srcQ = new Set((src.match(QUANTITY) || []).map(normQ));
  const elements = goldElements.map((g, index) => {
    const terms = [g.label, ...(g.terms || [])];
    const home = parts.find((p) => p.name.toLowerCase() === String(g.section).toLowerCase());
    let hit = home ? mention(home.text, terms, home.start) : null;
    let wrongSection = false;
    if (!hit) { hit = mention(note, terms); wrongSection = Boolean(hit); }
    const byCode = coded.includes(g.code);
    const base = { index, section: g.section, code: g.code, label: g.label, negated: Boolean(g.negated) };
    if (!hit && !byCode) return { ...base, status: 'missing', reason: 'not in the note', mark: null };
    const problems = []; const soft = [];
    if (hit) {
      if (hit.negated !== Boolean(g.negated)) problems.push(g.negated ? 'stated as present, but it was denied or ruled out' : 'stated as absent, but it was present');
      const s = hit.sentence.toLowerCase();
      if (g.laterality) { const other = g.laterality === 'left' ? 'right' : 'left'; if (new RegExp(`\\b${other}\\b`).test(s) && !new RegExp(`\\b${g.laterality}\\b`).test(s)) problems.push(`wrong side (${other} instead of ${g.laterality})`); else if (!new RegExp(`\\b${g.laterality}\\b`).test(s)) soft.push('side not stated'); }
      if (g.dose) { const said = (hit.sentence.match(QUANTITY) || []).map(normQ); if (said.includes(normQ(g.dose))) { /* right dose */ } else if (said.some((q) => /mg|mcg|g|units?|ml/.test(q))) problems.push(`wrong dose (expected ${g.dose})`); else soft.push('dose not stated'); }
      if (wrongSection) soft.push(`in the wrong section (expected ${g.section})`);
    } else if (g.negated) problems.push('coded as present, but it was denied or ruled out');
    else soft.push('coded but not written in the text');
    const status = problems.length ? 'wrong' : soft.length ? 'partial' : 'correct';
    return { ...base, status, reason: [...problems, ...soft].join('; ') || 'matches', mark: hit ? { start: hit.start, end: hit.end } : null };
  });

  // What the note asserts beyond the gold list: recognised clinical terms, attached codes, and quantities.
  const goldTerms = goldElements.flatMap((g) => [g.label, ...(g.terms || [])].map((t) => t.toLowerCase()));
  const extras = [];
  for (const entry of LEXICON) {
    if (entry.terms.some((t) => goldTerms.some((gt) => gt.includes(t) || t.includes(gt)))) continue;
    const hit = mention(note, entry.terms);
    if (hit) extras.push({ key: `term:${entry.label}`, kind: 'term', label: entry.label, mark: { start: hit.start, end: hit.end }, supported: termRe(entry.terms).test(src) });
  }
  for (const code of coded) if (!goldElements.some((g) => g.code === code)) extras.push({ key: `code:${code}`, kind: 'code', label: code, mark: null, supported: false });
  const seenQ = new Set();
  for (const m of note.matchAll(QUANTITY)) {
    const q = normQ(m[0]);
    if (seenQ.has(q)) continue;
    seenQ.add(q);
    extras.push({ key: `quantity:${q}`, kind: 'quantity', label: m[0], mark: { start: m.index, end: m.index + m[0].length }, supported: srcQ.has(q) });
  }
  return { elements, extras, format: formatCompliance(note, sections) };
}

/** Scores from element statuses, after any human corrections. corrections: { elements: {index: verdict}, extras: {key: 'supported'|'unsupported'} } */
export function tally(scored, corrections = {}) {
  const verdict = { correct: 'correct', partial: 'partial', incorrect: 'wrong' };
  const elements = scored.elements.map((e) => { const v = corrections.elements?.[e.index]; return v ? { ...e, auto: e.status, status: verdict[v], corrected: true } : e; });
  const extras = scored.extras.map((x) => { const v = corrections.extras?.[x.key]; return v ? { ...x, auto: x.supported, supported: v === 'supported', corrected: true } : x; });
  const found = elements.filter((e) => e.status !== 'missing');
  const correct = found.filter((e) => e.status === 'correct').length;
  const partial = found.filter((e) => e.status === 'partial').length;
  const noteElements = found.length + extras.length;
  const hallucinated = extras.filter((x) => !x.supported);
  return {
    elements, extras,
    scores: {
      completeness: elements.length ? round(found.length / elements.length) : null,
      accuracy: found.length ? round((correct + 0.5 * partial) / found.length) : null,
      hallucinations: hallucinated.length, hallucinationRate: noteElements ? round(hallucinated.length / noteElements) : 0,
      format: scored.format.score,
    },
    counts: { gold: elements.length, found: found.length, correct, partial, wrong: found.length - correct - partial, missing: elements.length - found.length, noteElements },
  };
}

export function scribeLibrary() {
  // The release ships no scribe cases. These are the ones you placed in data/library/scribe (<name>.case.json).
  return libraryFiles('scribe', '.case.json').map((f) => f.json);
}

const chartText = (docs) => docs.map((d) => [d.code?.text, d.code?.coding?.[0]?.display, d.medicationCodeableConcept?.text, d.medicationCodeableConcept?.coding?.[0]?.display, d.dosageInstruction?.[0]?.text,
  d.valueQuantity ? `${d.valueQuantity.value} ${d.valueQuantity.unit || ''}` : null, d.reaction?.[0]?.manifestation?.[0]?.coding?.[0]?.display].filter(Boolean).join(' ')).join('. ');

export function createScribe({ store, agents }) {
  const human = (ctx) => { if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only people can load cases, start benchmark runs or correct scores'); };

  /** Loads one seed case: its synthetic chart and transcript go in first, the case is frozen at that moment, and the gold note is recorded just after it. */
  async function loadCase(slug, actor) {
    const def = scribeLibrary().find((c) => c.slug === slug);
    if (!def) throw new HttpError(404, `No scribe case "${slug}" in the library`);
    if ((await store.query('ScribeBenchmarkCase', { where: (c) => c.slug === slug })).length) throw new HttpError(409, `"${def.title}" is already loaded`);
    const map = new Map(def.chart.map((r) => [`${r.resourceType}/${r.id}`, `${r.resourceType}/${randomUUID()}`]));
    const transcript = def.transcript.join('\n');
    const saved = await store.transaction(async (tx) => {
      const now = Date.parse(tx.now());
      const swap = (key, v) => { if (typeof v !== 'string') return v; if (map.has(v)) return map.get(v); const m = v.match(/^@now-(\d+)([mhd])$/); return m ? new Date(now - Number(m[1]) * UNIT[m[2]]).toISOString() : v; };
      let patient = null; const plant = [];
      for (const raw of def.chart) {
        const doc = { ...JSON.parse(JSON.stringify(raw), swap), id: map.get(`${raw.resourceType}/${raw.id}`).split('/')[1] };
        if (doc.resourceType === 'Patient') { doc.meta = { security: [HTEST] }; doc.identifier = [{ type: MR, system: 'urn:hospital-desktop:mrn', value: `S${String(Math.floor(Math.random() * 900000) + 100000)}` }]; doc.name = [{ family: `Patient ${doc.id.slice(0, 8)}` }]; patient = `Patient/${doc.id}`; }
        plant.push(doc);
      }
      const note = (extra) => ({ resourceType: 'DocumentReference', status: 'current', subject: { reference: patient }, date: tx.now(), ...extra });
      // The transcript goes with the chart onto each run's branch; the reference note stays on the case, where no agent can read it.
      const transcriptId = randomUUID(); const asOf = tx.now();
      plant.push(note({ id: transcriptId, docStatus: 'final', type: { coding: [TRANSCRIPT_TYPE], text: TRANSCRIPT_TYPE.display }, description: `Transcript: ${def.title}`, content: [{ attachment: { contentType: 'text/plain', data: b64(transcript) } }] }));
      const t = { id: transcriptId }; const gold = { id: null };
      const doc = await tx.save('ScribeBenchmarkCase', {
        resourceType: 'ScribeBenchmarkCase', id: randomUUID(), slug, title: def.title, encounterType: def.encounterType, noteType: def.noteType, sections: def.sections, roles: def.roles,
        transcript: path.relative(REPO_ROOT, path.join(scribeDir(), `${slug}.txt`)), transcriptRef: `DocumentReference/${t.id}`, chartContext: { asOf, patient }, goldNote: null, goldText: def.goldNote, transcriptText: transcript, plant: plant.map((d) => (d.resourceType === 'Patient' ? d : { ...d, _patient: patient })),
        goldElements: def.goldElements, split: def.split, synthetic: true, createdBy: actor.id,
      }, { updatedBy: actor.role });
      await recordAction(tx, { actor, kind: 'create', action: 'scribe.case.load', args: { case: doc.id, slug, split: doc.split }, entityRef: `ScribeBenchmarkCase/${doc.id}`, versionId: doc.meta.versionId, patientRef: patient, description: `scribe benchmark case loaded: ${def.title}` });
      return doc;
    });
    // The transcript also exists as a plain text file under data/ (never in the repository).
    await (await createObjectStore('clinical', { localRoot: scribeDir(), prefix: 'scribe/' })).put(`${slug}.txt`, Buffer.from(`${transcript}\n`, 'utf8'));
    return saved;
  }

  async function loadAll(actor) {
    const have = new Set((await store.query('ScribeBenchmarkCase')).map((c) => c.slug));
    const out = [];
    for (const c of scribeLibrary()) if (!have.has(c.slug)) out.push(await loadCase(c.slug, actor));
    return out;
  }

  const textOf = async (ref, branch = 'main') => { const [type, id] = ref.split('/'); const doc = await store.get(type, id, { branch }); return doc ? unb64(doc.content?.[0]?.attachment?.data) : ''; };

  async function attempt(c, agent, actor, batch) {
    const run = await createRun(store, {
      mode: 'scribe', agentId: agent.id, subject: c.chartContext.patient, parentBranch: 'main', plant: c.plant || [],
      goal: `Write the ${c.noteType.display.toLowerCase()} for this ${c.encounterType} encounter from the transcript and the chart.`,
      context: { scribeCaseId: c.id, transcript: c.transcriptRef, noteType: c.noteType, sections: c.sections, roles: c.roles },
      trigger: { kind: 'scribe-benchmark', actor: actor.id, role: actor.role, at: store.now(), batch },
    }, actor);
    const t0 = performance.now();
    const outcome = await agents.work(run, agent);
    const ms = Math.round(performance.now() - t0);
    const steps = await store.query('TraceStep', { groupKey: run.id });
    const made = steps.filter((s) => s.who.kind === 'agent' && s.did.type === 'fhir.create' && s.did.args?.type === 'DocumentReference').at(-1);
    const noteDoc = made ? await store.get('DocumentReference', made.did.args.id, { branch: run.branch }) : null;
    const note = noteDoc ? unb64(noteDoc.content?.[0]?.attachment?.data) : '';
    const coded = (noteDoc?.extension || []).filter((e) => e.url === ELEMENT_URL && e.valueCoding?.code).map((e) => `${e.valueCoding.system?.includes('icd') ? 'ICD-10' : e.valueCoding.system?.includes('rxnorm') ? 'RxNorm' : e.valueCoding.system?.includes('loinc') ? 'LOINC' : 'LOCAL'}:${e.valueCoding.code}`);
    const chart = (await Promise.all(['Condition', 'MedicationRequest', 'AllergyIntolerance', 'Observation'].map((type) => store.query(type, { patient: c.chartContext.patient }, { branch: run.branch })))).flat();
    const source = `${c.transcriptText ?? await textOf(c.transcriptRef, run.branch)}\n${chartText(chart)}`;
    const scored = scoreNote({ note, coded, goldElements: c.goldElements, sections: c.sections, source });
    const t = tally(scored);
    const result = {
      kind: 'scribe', scribeCaseId: c.id, slug: c.slug, encounterType: c.encounterType, split: c.split, noteRef: noteDoc ? `DocumentReference/${noteDoc.id}` : null, ms, finished: outcome.ok,
      scored, corrections: { elements: {}, extras: {} }, summary: noteDoc ? `Note written: ${t.counts.found} of ${t.counts.gold} gold elements found, ${t.scores.hallucinations} unsupported` : `No note was written${outcome.error ? ` (${outcome.error})` : ''}`,
      ...(outcome.ok ? {} : { error: outcome.error }),
    };
    return endRun(store, run.id, agents.agentActor(agent), outcome.ok ? 'completed' : outcome.reason, result);
  }

  async function benchmark({ agentId, caseIds = null, split = null }, actor) {
    if (!agents.ready) throw new HttpError(409, 'The server is not ready to run agents yet');
    const agent = await store.get('Agent', String(agentId ?? ''));
    if (!agent) throw new HttpError(404, `Agent "${agentId}" is not registered`);
    if (!agents.canRun(agent)) throw new HttpError(409, 'External agent endpoints are disabled. Set ALLOW_EXTERNAL_AGENTS=true to let this server call them');
    if (!(agent.scopes || []).some((s) => s.type === 'DocumentReference' && s.interactions.includes('create'))) throw new HttpError(422, `${agent.name} is not allowed to write notes (no DocumentReference create scope), so it cannot be benchmarked as a scribe`);
    let cases = (await store.query('ScribeBenchmarkCase')).sort((a, b) => a.slug.localeCompare(b.slug));
    if (Array.isArray(caseIds) && caseIds.length) cases = cases.filter((c) => caseIds.includes(c.id));
    if (split) cases = cases.filter((c) => c.split === split);
    if (!cases.length) throw new HttpError(422, 'No scribe benchmark cases match. Load the seed cases first');
    const batch = randomUUID();
    const runs = [];
    for (const c of cases) runs.push(await attempt(c, agent, actor, batch));
    await store.transaction((tx) => recordAction(tx, { actor, kind: 'execute', action: 'scribe.benchmark', args: { agent: agent.id, version: agent.version, cases: cases.length, batch }, description: `scribe benchmark: ${agent.id} ${agent.version} on ${cases.length} cases` }));
    return { batch, ...(await results({ batch })) };
  }

  const rowOf = (run, c) => {
    const t = tally(run.result.scored, run.result.corrections);
    return {
      runId: run.id, batch: run.trigger?.batch ?? null, agentId: run.agentId, version: run.version, caseId: run.result.scribeCaseId, slug: run.result.slug, title: c?.title ?? run.result.slug,
      encounterType: run.result.encounterType, split: run.result.split, startedAt: run.startedAt, finished: run.result.finished !== false && Boolean(run.result.noteRef), ms: run.result.ms,
      ...t.scores, counts: t.counts, corrected: Object.keys(run.result.corrections?.elements || {}).length + Object.keys(run.result.corrections?.extras || {}).length,
    };
  };
  const meanOf = (rows, key) => { const v = rows.map((r) => r[key]).filter((x) => x != null); return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
  const aggregate = (rows) => ({ cases: rows.length, completeness: meanOf(rows, 'completeness'), accuracy: meanOf(rows, 'accuracy'), hallucinationRate: meanOf(rows, 'hallucinationRate'), hallucinations: rows.reduce((n, r) => n + r.hallucinations, 0), format: meanOf(rows, 'format'), ms: meanOf(rows, 'ms') == null ? null : Math.round(meanOf(rows, 'ms')) });

  async function scribeRuns() { return (await store.query('Run', { where: (r) => r.mode === 'scribe' && r.endedAt && r.result?.kind === 'scribe' })).sort((a, b) => b._seq - a._seq); }

  /** Per-case rows (latest run of each agent version on each case), with aggregates overall and by encounter type. */
  async function results({ agentId = null, version = null, batch = null, all = false } = {}) {
    const cases = new Map((await store.query('ScribeBenchmarkCase')).map((c) => [c.id, c]));
    let runs = (await scribeRuns()).filter((r) => (!agentId || r.agentId === agentId) && (!version || r.version === version) && (!batch || r.trigger?.batch === batch));
    if (!all && !batch) { const seen = new Set(); runs = runs.filter((r) => { const k = `${r.agentId}@${r.version}@${r.result.scribeCaseId}`; if (seen.has(k)) return false; seen.add(k); return true; }); }
    const rows = runs.map((r) => rowOf(r, cases.get(r.result.scribeCaseId)));
    const groups = new Map();
    for (const r of rows) { const k = `${r.agentId}@${r.version}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    return {
      note: 'Scores come from matching the note against a list of gold elements. They are proxies and do not establish that a note is clinically safe.',
      rows: rows.sort((a, b) => a.agentId.localeCompare(b.agentId) || String(b.version).localeCompare(String(a.version)) || a.slug.localeCompare(b.slug)),
      summary: [...groups.entries()].map(([k, list]) => ({
        agentId: list[0].agentId, version: list[0].version, key: k, all: aggregate(list), evalSplit: aggregate(list.filter((r) => r.split === 'eval')),
        byEncounterType: Object.fromEntries([...new Set(list.map((r) => r.encounterType))].sort().map((t) => [t, aggregate(list.filter((r) => r.encounterType === t))])),
      })),
    };
  }

  async function scribeRun(runId) {
    const run = await store.get('Run', runId);
    if (!run || run.mode !== 'scribe' || run.result?.kind !== 'scribe') throw new HttpError(404, `Scribe benchmark run ${runId} not found`);
    return run;
  }

  /** Gold note and agent note side by side, with every element and where it was found. */
  async function detail(runId) {
    const run = await scribeRun(runId);
    const c = await store.get('ScribeBenchmarkCase', run.result.scribeCaseId);
    const gold = c.goldText ?? (c.goldNote ? await textOf(c.goldNote) : '');
    const note = run.result.noteRef ? await textOf(run.result.noteRef, run.branch) : '';
    const t = tally(run.result.scored, run.result.corrections);
    const goldParts = parseSections(gold, c.sections);
    const goldMarks = t.elements.map((e) => {
      const home = goldParts.find((p) => p.name.toLowerCase() === String(e.section).toLowerCase());
      const hit = (home ? mention(home.text, [e.label, ...(c.goldElements[e.index].terms || [])], home.start) : null) ?? mention(gold, [e.label, ...(c.goldElements[e.index].terms || [])]);
      return hit ? { start: hit.start, end: hit.end, status: e.status, index: e.index } : null;
    }).filter(Boolean);
    const agentMarks = [...t.elements.filter((e) => e.mark).map((e) => ({ ...e.mark, status: e.status, index: e.index })), ...t.extras.filter((x) => x.mark && !x.supported).map((x) => ({ ...x.mark, status: 'hallucinated', key: x.key }))];
    return {
      ...rowOf(run, c), run: withStatus(run), case: { id: c.id, title: c.title, encounterType: c.encounterType, noteType: c.noteType, sections: c.sections, split: c.split, transcript: c.transcript },
      gold: { text: gold, marks: goldMarks }, agent: { text: note, marks: agentMarks }, elements: t.elements, extras: t.extras, format: run.result.scored.format,
    };
  }

  /** A grader overrules the automatic match for one element or one unsupported item. The score changes at once. */
  async function correct(runId, body, ctx) {
    human(ctx);
    const run = await scribeRun(runId);
    const corrections = { elements: { ...(run.result.corrections?.elements || {}) }, extras: { ...(run.result.corrections?.extras || {}) } };
    let args;
    if (body?.element != null) {
      const index = Number(body.element);
      if (!run.result.scored.elements.some((e) => e.index === index)) throw new HttpError(404, 'That element is not part of this case');
      if (body.verdict == null) delete corrections.elements[index];
      else { if (!['correct', 'partial', 'incorrect'].includes(body.verdict)) throw new HttpError(422, 'verdict must be correct, partial or incorrect'); corrections.elements[index] = body.verdict; }
      args = { element: index, verdict: body.verdict ?? null };
    } else if (typeof body?.extra === 'string') {
      if (!run.result.scored.extras.some((x) => x.key === body.extra)) throw new HttpError(404, 'That item is not in this note');
      if (body.verdict == null) delete corrections.extras[body.extra];
      else { if (!['supported', 'unsupported'].includes(body.verdict)) throw new HttpError(422, 'verdict must be supported or unsupported'); corrections.extras[body.extra] = body.verdict; }
      args = { extra: body.extra, verdict: body.verdict ?? null };
    } else throw new HttpError(422, 'Say which element (index) or extra (key) you are correcting');
    await store.transaction(async (tx) => {
      const { _seq, ...doc } = await tx.get('Run', run.id);
      await tx.save('Run', { ...doc, result: { ...doc.result, corrections } }, { updatedBy: ctx.actor.role });
      await recordAction(tx, { actor: ctx.actor, kind: 'update', action: 'scribe.correct', args: { run: run.id, ...args }, entityRef: `Run/${run.id}`, description: `scribe benchmark score corrected by a grader (${run.id})` });
    });
    return detail(runId);
  }

  async function exportLines(url, ctx) {
    human(ctx);
    const out = await results({ agentId: url.searchParams.get('agentId'), version: url.searchParams.get('version'), all: url.searchParams.get('all') === 'true' });
    const lines = [];
    for (const row of out.rows) {
      const d = await detail(row.runId);
      const { counts, ...scores } = row;
      lines.push({ ...scores, counts, elements: d.elements.map(({ mark, ...e }) => e), unsupported: d.extras.filter((x) => !x.supported).map((x) => ({ kind: x.kind, label: x.label, corrected: Boolean(x.corrected) })), format: d.format });
    }
    const manifest = { manifest: true, export: 'scribe-benchmark', exportedAt: store.now(), agentId: url.searchParams.get('agentId') ?? 'all', version: url.searchParams.get('version') ?? 'all', caseCount: lines.length,
      contains: 'Scores and element-level results only. No transcript, gold note or agent note text is included, so evaluation cases cannot be recovered from this file.', note: out.note };
    await store.transaction((tx) => recordAction(tx, { actor: ctx.actor, kind: 'read', action: 'export.download', args: { export: 'scribe-benchmark', lines: lines.length }, description: `scribe benchmark export (${lines.length} cases)` }));
    return { status: 200, body: `${[manifest, ...lines].map((l) => JSON.stringify(l)).join('\n')}\n`, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': 'attachment; filename="scribe-benchmark.jsonl"' } };
  }

  async function caseList() {
    const loaded = (await store.query('ScribeBenchmarkCase')).map(({ plant, goldText, transcriptText, ...c }) => c).sort((a, b) => a.slug.localeCompare(b.slug));
    const have = new Set(loaded.map((c) => c.slug));
    return {
      cases: loaded.map(({ _seq, meta, resourceType, goldElements, ...c }) => ({ ...c, goldElements: goldElements.length })),
      library: scribeLibrary().map((c) => ({ slug: c.slug, title: c.title, encounterType: c.encounterType, split: c.split, loaded: have.has(c.slug) })),
    };
  }

  async function handle(req, url, body, ctx, parts) {
    const m = req.method;
    if (parts[0] === 'export' && parts[1] === 'scribe-benchmark.jsonl' && m === 'GET') return exportLines(url, ctx);
    if (parts[0] !== 'scribe') return null;
    const [, a, b, c] = parts;
    if (a === 'cases' && parts.length === 2 && m === 'GET') return { status: 200, body: await caseList() };
    if (a === 'cases' && b === 'load' && m === 'POST') { human(ctx); return { status: 201, body: { loaded: body?.slug ? [await loadCase(String(body.slug), ctx.actor)] : await loadAll(ctx.actor) } }; }
    if (a === 'run' && m === 'POST') { human(ctx); return { status: 201, body: await benchmark(body || {}, ctx.actor) }; }
    if (a === 'results' && parts.length === 2 && m === 'GET') return { status: 200, body: await results({ agentId: url.searchParams.get('agentId'), version: url.searchParams.get('version'), all: url.searchParams.get('all') === 'true' }) };
    if (a === 'results' && b && parts.length === 3 && m === 'GET') return { status: 200, body: await detail(b) };
    if (a === 'results' && b && c === 'correct' && m === 'POST') return { status: 200, body: await correct(b, body, ctx) };
    return null;
  }

  return { handle, loadCase, loadAll, benchmark, results, detail, correct, caseList };
}
