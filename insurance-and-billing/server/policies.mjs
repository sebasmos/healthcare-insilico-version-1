// Coverage policy library and the automatic rules that run before a person reviews (docs/PAYER.md 5.3, 5.4).
// A policy is a versioned list of checkable criteria, each saying what evidence satisfies it. Policies come from
// the reference data you import: your own or licensed criteria (already structured), or national and local
// coverage determinations, whose prose is turned into a first draft that a person must confirm before use.
import { HttpError, strip, day } from './common.mjs';
import * as ref from './reference.mjs';

const sentences = (text) => { const out = []; const re = /[^.!?\n]+[.!?]?/g; let m; while ((m = re.exec(String(text || '')))) { const s = m[0].trim(); if (s.length > 2) out.push({ text: s, start: m.index + m[0].indexOf(s), end: m.index + m[0].indexOf(s) + s.length }); } return out; };
const NEG = /\b(no|not|denies|denied|without|negative for|never|none)\b/i;

/** A first draft of checkable criteria from a coverage determination's prose. Always marked unreviewed. */
export function draftFromDetermination(doc) {
  const body = typeof doc.body === 'string' ? doc.body : ''; const part = body.split(/\n\n/).find((p) => /^indication|^coverage/i.test(p)) || body;
  const items = part.split(/\n|;|(?<=\.)\s+(?=[A-Z0-9(])/).map((s) => s.replace(/^[\s\-•*\d.()a-z]{0,4}\s*/, '').trim()).filter((s) => s.length > 25 && s.length < 400).slice(0, 12);
  const dx = doc.codes.filter((c) => c.system === 'ICD-10-CM' && c.role === 'covered').map((c) => c.code);
  return { id: `${doc.kind}-${doc.id}`, version: doc.version || '1', title: doc.title, source: `${doc.kind.toUpperCase()} ${doc.id}${doc.version ? ` version ${doc.version}` : ''}, CMS Medicare Coverage Database`, reviewed: false, draft: true, appliesTo: doc.codes.filter((c) => c.role === 'about').map((c) => ({ system: c.system, code: c.code })), criteria: [...(dx.length ? [{ id: 'dx', text: 'A covered diagnosis is on the request', evidence: { kind: 'diagnosis', codes: dx } }] : []), ...items.map((text, i) => ({ id: `c${i + 1}`, text, evidence: { kind: 'text', any: [] } }))] };
}

/**
 * Checks each criterion against what the hospital sent, and nothing else.
 * packet: { diagnoses: [code], documents: [{ id, title, text }], values: [{ code, value, unit, date }], answers: { criterionId: true|false } }
 * Each result: { id, text, status: 'met' | 'not-met' | 'unknown', evidence } where evidence points at the code, the value, or the exact sentence.
 */
export function evaluate(policy, packet) {
  const dx = (packet.diagnoses || []).map((d) => String(d).replace('.', '').toUpperCase()); const docs = packet.documents || []; const values = packet.values || [];
  const results = policy.criteria.map((cr) => {
    const e = cr.evidence || {}; const base = { id: cr.id, text: cr.text, kind: e.kind || 'judgement', ...(cr.exception ? { exception: true } : {}) };
    if (packet.answers && cr.id in packet.answers && e.kind === 'answer') return { ...base, status: packet.answers[cr.id] ? 'met' : 'not-met', evidence: { questionnaire: cr.id } };
    if (e.kind === 'elm') { const v = packet.elm?.[cr.id]; return { ...base, status: v === true ? 'met' : v === false ? 'not-met' : 'unknown', evidence: v == null ? null : { expression: e.expression, result: v } }; }
    if (e.kind === 'diagnosis') { const hit = dx.find((d) => (e.codes || []).some((c) => d.startsWith(String(c).replace('.', '').toUpperCase()))); return { ...base, status: hit ? 'met' : dx.length ? 'not-met' : 'unknown', evidence: hit ? { diagnosis: hit } : null }; }
    if (e.kind === 'value') { const v = values.filter((x) => x.code === e.code).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]; if (!v) return { ...base, status: 'unknown', evidence: null }; const ok = { '>': v.value > e.threshold, '>=': v.value >= e.threshold, '<': v.value < e.threshold, '<=': v.value <= e.threshold }[e.op || '>=']; return { ...base, status: ok ? 'met' : 'not-met', evidence: { value: v.value, unit: v.unit ?? null, code: v.code, date: v.date ?? null, threshold: `${e.op || '>='} ${e.threshold}` } }; }
    if (e.kind === 'text' && (e.any || []).length) {
      for (const d of docs) for (const s of sentences(d.text)) { const phrase = e.any.find((p) => s.text.toLowerCase().includes(String(p).toLowerCase())); if (!phrase) continue; const before = s.text.toLowerCase().split(String(phrase).toLowerCase())[0]; if (NEG.test(before.slice(-40))) return { ...base, status: 'not-met', evidence: { document: d.id, title: d.title, quote: s.text, start: s.start, end: s.end, note: 'the note says this did not happen' } }; return { ...base, status: 'met', evidence: { document: d.id, title: d.title, quote: s.text, start: s.start, end: s.end } }; }
      return { ...base, status: docs.length ? 'unknown' : 'unknown', evidence: null };
    }
    if (e.kind === 'document') { const d = docs.find((x) => (e.types || []).some((t) => String(x.title || '').toLowerCase().includes(String(t).toLowerCase()))); return { ...base, status: d ? 'met' : 'not-met', evidence: d ? { document: d.id, title: d.title } : null }; }
    return { ...base, status: 'unknown', evidence: null }; // a judgement a person or an agent must make
  });
  return { policy: { id: policy.id, version: policy.version, title: policy.title, source: policy.source ?? null }, criteria: results, met: results.filter((r) => r.status === 'met').length, exceptionMet: results.filter((r, i) => policy.criteria[i].exception && r.status === 'met').map((r) => r.id), notMet: results.filter((r, i) => !policy.criteria[i].exception && r.status === 'not-met').map((r) => r.id), unknown: results.filter((r, i) => !policy.criteria[i].exception && r.status === 'unknown').map((r) => r.id), allMet: results.length > 0 && (results.some((r, i) => policy.criteria[i].exception && r.status === 'met') || results.every((r, i) => policy.criteria[i].exception || r.status === 'met')) };
}

/**
 * The rules that run before a person looks. They approve, pend for what is missing, or send to review. They never
 * deny. Returns { outcome: 'no-auth-needed' | 'auto-approve' | 'auto-pend' | 'route', rule, firings: [...], missing }.
 */
export function triage({ request, plan, policy, evaluation, provider = { decisions: 0, approved: 0 }, strictness = 0 }) {
  const fire = []; const done = (outcome, rule, why, extra = {}) => ({ outcome, rule, why, firings: [...fire, { rule, outcome, why }], ...extra });
  const codes = (request.services || []).map((s) => s.code);
  if (request.setting === '23' || request.urgency === 'emergency') return done('no-auth-needed', 'emergency-care', 'Emergency services need no prior authorization (prudent layperson standard, 45 CFR 147.138)');
  if (request.kind !== 'concurrent' && request.kind !== 'post-acute' && !codes.some((c) => plan.authRequired.includes(c))) return done('no-auth-needed', 'not-on-list', 'None of these services is on this plan\'s list of services that need authorization');
  if (request.kind === 'retro') fire.push({ rule: 'retro-after-urgent-care', outcome: 'continue', why: 'Asked for after urgent or emergency care: reviewed as a retro-authorization, not refused for lateness' });
  const g = plan.goldCard || {};
  if (g.on && provider.decisions >= g.minimumDecisions && provider.approved / provider.decisions >= g.threshold && !strictness) return done('auto-approve', 'gold-card', `This provider's approval rate is ${Math.round((provider.approved / provider.decisions) * 100)}% over ${provider.decisions} decisions, at or above the plan's ${Math.round(g.threshold * 100)}%: exempt from review`);
  if (!policy) return done('route', 'no-policy', 'No reviewed policy covers this service: a person decides');
  const needDocs = (policy.requiredDocuments || []).filter((t) => !(request.documents || []).some((d) => String(d.title || '').toLowerCase().includes(String(t).toLowerCase())));
  if (needDocs.length) return done('auto-pend', 'missing-documents', `Missing: ${needDocs.join(', ')}`, { missing: needDocs });
  if (!(request.documents || []).length && evaluation.unknown.length) return done('auto-pend', 'nothing-attached', 'No clinical records came with the request', { missing: ['clinical records supporting the request'] });
  if (evaluation.allMet && strictness < 2) return done('auto-approve', 'all-criteria-met', `All ${evaluation.criteria.length} criteria of ${policy.title} version ${policy.version} are met by what was sent`);
  return done('route', 'needs-review', evaluation.notMet.length ? `${evaluation.notMet.length} criteria look unmet and ${evaluation.unknown.length} could not be checked automatically` : `${evaluation.unknown.length} criteria could not be checked automatically`);
}

export function createPolicies(c) {
  const { store, put, list, hospital } = c;
  /** Every policy: confirmed ones (usable), and drafts from coverage determinations (not usable until confirmed). */
  async function library(ctx, { code = null } = {}) {
    const confirmed = (await list(ctx, 'InsPolicy')).map(strip); const db = ref.openReference(); const out = confirmed.map((p) => ({ ...p, usable: true }));
    const have = new Set(confirmed.map((p) => `${p.policyId || p.id}--v${p.version}`));
    for (const row of db.prepare("SELECT kind, id, version FROM documents WHERE kind IN ('policy', 'ncd', 'lcd') ORDER BY kind, id, version DESC").all()) {
      const d = ref.document(row.kind, row.id, row.version); const p = row.kind === 'policy' ? { ...d.body, id: String(d.body.id), version: String(d.body.version ?? '1'), reviewed: d.body.reviewed === true } : draftFromDetermination(d);
      if (have.has(`${p.policyId || p.id}--v${p.version}`)) continue; out.push({ ...p, usable: p.reviewed === true, from: 'reference data' });
    }
    return out.filter((p) => !code || (p.appliesTo || []).some((a) => String(a.code) === String(code))).sort((a, b) => a.title.localeCompare(b.title) || String(b.version).localeCompare(String(a.version)));
  }
  /** A person confirms (and may correct) the checkable version of a policy. It becomes a new confirmed version. */
  async function confirm(body, ctx) {
    hospital(ctx, ['researcher', 'payer-medical-director']);
    if (!body?.id || !body.title || !Array.isArray(body.criteria) || !body.criteria.length) throw new HttpError(422, 'A policy needs id, title and at least one criterion');
    const version = String(body.version ?? '1'); if ((await list(ctx, 'InsPolicy', (p) => p.id === `${body.id}--v${version}`)).length) throw new HttpError(409, 'That version is already confirmed. Confirm a new version number instead.');
    return strip(await put(ctx, 'InsPolicy', { id: `${body.id}--v${version}`, policyId: String(body.id), version, title: String(body.title).slice(0, 200), source: body.source || null, appliesTo: (body.appliesTo || []).map((a) => ({ system: a.system || 'HCPCS', code: String(a.code) })), requiredDocuments: body.requiredDocuments || [], criteria: body.criteria.map((cr, i) => ({ id: String(cr.id || `c${i + 1}`), text: String(cr.text).slice(0, 500), ...(cr.exception ? { exception: true } : {}), evidence: cr.evidence || { kind: 'judgement' } })), elm: body.elm && typeof body.elm === 'object' ? body.elm : null, elmLibrary: body.elmLibrary ? String(body.elmLibrary) : null, effective: day(body.effective || c.now(ctx)), reviewed: true, confirmedBy: ctx.actor.id, confirmedAt: c.now(ctx) }, 'ins.policy.confirm', { policy: body.id, version }, `policy ${body.title} version ${version} confirmed`));
  }
  /** The confirmed policy in force for a service on a date (the newest version effective on or before it). */
  async function policyFor(ctx, codes, date) {
    const all = (await library(ctx)).filter((p) => p.usable && (p.appliesTo || []).some((a) => codes.includes(String(a.code))) && (!p.effective || day(p.effective) <= day(date)));
    const p = all.sort((a, b) => String(b.effective || '').localeCompare(String(a.effective || '')) || String(b.version).localeCompare(String(a.version), undefined, { numeric: true }))[0];
    return p ? { ...p, id: p.policyId || p.id } : null;
  }
  const search = async (ctx, q) => { const t = String(q.text || '').toLowerCase(); return (await library(ctx, { code: q.code || null })).filter((p) => (!q.version || String(p.version) === String(q.version)) && (!t || `${p.title} ${p.criteria.map((x) => x.text).join(' ')}`.toLowerCase().includes(t)) && (!q.diagnosis || p.criteria.some((cr) => (cr.evidence?.codes || []).some((x) => String(q.diagnosis).replace('.', '').toUpperCase().startsWith(String(x).replace('.', '').toUpperCase()))))); };
  return { library, confirm, policyFor, search };
}
