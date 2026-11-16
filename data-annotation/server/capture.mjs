// Data Annotation → Capture: recording a clinician at work.
//
// A recording is a Run of mode "capture": human only, on the live chart (or a
// practice copy), live clock. While it is on, every structured UI event and
// API action the clinician makes is attributed to the Run.
//
// Free text is different. Think-aloud notes, "why" answers and dictation
// transcripts are written only when (1) the content policy is switched on,
// (2) the clinician ticked that kind in the consent dialog, and (3) for
// dictation, the session is on a practice copy and the field is on the
// allowlist. The text is redacted, encrypted and kept in a side table that
// expires and can be deleted; the append-only log only ever holds a reference.
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { createRun, endRun, withStatus } from '../../agent-operations/server/runs.mjs';
import { redactText, nameParts } from '../../platform/server/redact.mjs';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';

export const CONTENT_KINDS = ['think-aloud', 'why', 'dictation'];
export const DEFAULT_POLICY = {
  contentCapture: false,
  retentionDays: 30,
  // Plan-master 10.2: what the clinician does with AI drafts is part of the recording; a short "Why?" after an override is off by default.
  captureAiInteractions: true,
  askWhyAfterOverride: false,
  // Dictation is kept only from these fields (data-testid of the dictated input).
  dictationFields: ['report-technique', 'report-findings', 'report-impression', 'report-addendum', 'field-text'],
};
const CONSENT_KEYS = { 'think-aloud': 'thinkAloud', why: 'why', dictation: 'dictation' };
const SYSTEM_PREFIX = [[/loinc/i, 'LOINC'], [/rxnorm/i, 'RxNorm'], [/icd-10/i, 'ICD-10'], [/snomed|sct/i, 'SNOMED']];
const GOLD_TYPE = { ServiceRequest: 'order', MedicationRequest: 'prescribe', Condition: 'diagnose' };

function loadKey(given) {
  if (given) return given;
  if (process.env.CAPTURE_KEY) {
    const key = Buffer.from(process.env.CAPTURE_KEY, 'hex');
    if (key.length !== 32) throw new Error('CAPTURE_KEY must be 64 hex characters (32 bytes)');
    return key;
  }
  const file = path.resolve(REPO_ROOT, process.env.CAPTURE_KEY_FILE || 'data/capture.key');
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  const key = randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${key.toString('hex')}\n`, { mode: 0o600 });
  return key;
}

export function seal(key, text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
}

export function unseal(key, sealed) {
  const [iv, tag, body] = String(sealed).split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

export async function capturePolicy(store) {
  const saved = await store.get('CapturePolicy', 'default');
  return { ...DEFAULT_POLICY, ...(saved ? { contentCapture: saved.contentCapture, retentionDays: saved.retentionDays, dictationFields: saved.dictationFields, ...(saved.captureAiInteractions !== undefined ? { captureAiInteractions: saved.captureAiInteractions } : {}), ...(saved.askWhyAfterOverride !== undefined ? { askWhyAfterOverride: saved.askWhyAfterOverride } : {}) } : {}) };
}

/** What happened in a recording, from its trace. */
export function summarize(run, steps, content = []) {
  const ui = steps.filter((s) => s.source === 'ui');
  const apiSteps = steps.filter((s) => s.source !== 'ui' && !/^(run|capture)\./.test(s.did.type));
  const count = (list, key) => list.reduce((m, x) => { const k = key(x); if (k) m[k] = (m[k] || 0) + 1; return m; }, {});
  const viewer = ui.filter((s) => s.did.type === 'ui.viewer');
  const action = (s) => s.did.args?.viewer?.action;
  const time = (s) => Date.parse(s.did.args?.clientTime || s.when.wall);
  const end = Date.parse(run.endedAt || steps.at(-1)?.when.wall || run.startedAt);

  // Time on a study: from opening it until the same browser tab opens another study, leaves the viewer, or the recording ends.
  const studies = new Map();
  const bySession = new Map();
  for (const s of ui) { const id = s.did.args?.sessionId || 'unknown'; if (!bySession.has(id)) bySession.set(id, []); bySession.get(id).push(s); }
  for (const list of bySession.values()) {
    list.sort((a, b) => time(a) - time(b) || (a.client?.seq ?? 0) - (b.client?.seq ?? 0));
    list.forEach((s, i) => {
      if (s.did.type !== 'ui.viewer' || action(s) !== 'open-study') return;
      const ref = s.saw.resources?.[0]?.ref;
      if (!ref) return;
      const next = list.slice(i + 1).find((x) => (x.did.type === 'ui.viewer' && action(x) === 'open-study') || (x.did.type === 'ui.nav' && !String(x.did.args?.route || '').includes(ref.split('/')[1])));
      const seconds = Math.max(0, Math.round(((next ? time(next) : end) - time(s)) / 1000));
      const entry = studies.get(ref) || { ref, opens: 0, seconds: 0, frames: 0, frameSeconds: 0 };
      entry.opens += 1; entry.seconds += seconds;
      studies.set(ref, entry);
    });
  }
  for (const s of viewer.filter((x) => action(x) === 'dwell')) {
    const ref = s.saw.resources?.[0]?.ref;
    const entry = studies.get(ref);
    if (!entry) continue;
    entry.frames += 1;
    entry.frameSeconds = Math.round((entry.frameSeconds + (Number(s.did.args.viewer.ms) || 0) / 1000) * 10) / 10;
  }
  const written = apiSteps.filter((s) => ['fhir.create', 'fhir.update', 'fhir.transition'].includes(s.did.type) && s.did.args?.type !== 'Provenance');
  return {
    seconds: Math.max(0, Math.round((end - Date.parse(run.startedAt)) / 1000)),
    uiEvents: ui.length, uiByType: count(ui, (s) => s.did.type.slice(3)), uiByApp: count(ui, (s) => s.did.args?.app),
    apiActions: apiSteps.length, apiByType: count(apiSteps, (s) => s.did.type),
    recordsWritten: count(written, (s) => s.did.args?.type),
    signed: written.filter((s) => s.did.type === 'fhir.transition' && s.did.args.to === 'final').length,
    measurements: viewer.filter((s) => action(s) === 'length').length,
    viewerActions: count(viewer, action),
    studies: [...studies.values()],
    patients: [...new Set(steps.map((s) => s.did.args?.patient).filter(Boolean))],
    content: Object.fromEntries(CONTENT_KINDS.map((k) => [k, content.filter((c) => c.kind === k).length])),
  };
}

export function createCapture({ store, rl = null, key = null }) {
  let secret = key;
  const keyOf = () => { secret = loadKey(secret); return secret; };
  const human = (ctx) => { if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Recordings are for people only'); };

  async function runOf(id, { active = false } = {}) {
    const run = await store.get('Run', id);
    if (!run || run.mode !== 'capture') throw new HttpError(404, `Recording ${id} not found`);
    if (active && run.endedAt) throw new HttpError(409, 'This recording has ended');
    return run;
  }

  const rowOut = (r) => ({ id: r.id, kind: r.kind, field: r.field, about: r.about, length: Number(r.length), redactions: Number(r.redactions), by: r.created_by, at: r.created_at, expiresAt: r.expires_at });
  const contentRows = (q, runId) => q.all('SELECT * FROM capture_content WHERE run_id = ? ORDER BY created_at, id', [runId]);

  async function setPolicy(body, actor) {
    const current = await capturePolicy(store);
    const next = { ...current };
    if (body?.contentCapture !== undefined) next.contentCapture = Boolean(body.contentCapture);
    if (body?.captureAiInteractions !== undefined) next.captureAiInteractions = Boolean(body.captureAiInteractions);
    if (body?.askWhyAfterOverride !== undefined) next.askWhyAfterOverride = Boolean(body.askWhyAfterOverride);
    if (body?.retentionDays !== undefined) {
      const days = Number(body.retentionDays);
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(422, 'retentionDays must be a whole number from 1 to 365');
      next.retentionDays = days;
    }
    if (body?.dictationFields !== undefined) {
      if (!Array.isArray(body.dictationFields) || body.dictationFields.some((f) => typeof f !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(f))) throw new HttpError(422, 'dictationFields must be a list of field identifiers');
      next.dictationFields = [...new Set(body.dictationFields)].slice(0, 40);
    }
    await store.transaction(async (tx) => {
      const existing = await tx.get('CapturePolicy', 'default');
      const { _seq, ...rest } = existing || {};
      await tx.save('CapturePolicy', { ...rest, resourceType: 'CapturePolicy', id: 'default', ...next }, { updatedBy: actor.role });
      await recordAction(tx, { actor, kind: 'update', action: 'capture.policy', args: { contentCapture: next.contentCapture, retentionDays: next.retentionDays, dictationFields: next.dictationFields.length }, entityRef: 'CapturePolicy/default', description: `recording content policy: written content ${next.contentCapture ? 'allowed' : 'not allowed'}, kept ${next.retentionDays} days` });
    });
    return next;
  }

  async function start(body, ctx) {
    human(ctx);
    if (body?.acknowledged !== true) throw new HttpError(422, 'The person being recorded must agree to the recording first');
    const policy = await capturePolicy(store);
    const mine = (await store.query('Run', { mode: 'capture' })).find((r) => !r.endedAt && r.context?.recorder === ctx.actor.id);
    if (mine) throw new HttpError(409, `${ctx.actor.id} already has a recording in progress. Stop it first`);
    const asked = body.consent || {};
    const practice = Boolean(body.practice);
    const consent = {
      thinkAloud: policy.contentCapture && Boolean(asked.thinkAloud),
      why: policy.contentCapture && Boolean(asked.why),
      // Dictation is patient free text: only ever on a practice copy.
      dictation: policy.contentCapture && practice && Boolean(asked.dictation),
    };
    const practiceBranch = practice ? await store.fork({ parentBranch: 'main', kind: 'sandbox' }) : null;
    const run = await createRun(store, {
      mode: 'capture', friction: body.friction, goal: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Recording of a clinician working',
      context: { recorder: ctx.actor.id, role: ctx.actor.role, consent, practiceBranch, retentionDays: policy.retentionDays, dictationFields: consent.dictation ? policy.dictationFields : [] },
    }, ctx.actor);
    return withStatus(run);
  }

  async function addContent(id, body, ctx) {
    human(ctx);
    const run = await runOf(id, { active: true });
    const kind = body?.kind;
    if (!CONTENT_KINDS.includes(kind)) throw new HttpError(422, `kind must be one of ${CONTENT_KINDS.join(', ')}`);
    const policy = await capturePolicy(store);
    if (!policy.contentCapture) throw new HttpError(403, 'Written content is not allowed in recordings. An administrator can allow it on the Recordings page', 'forbidden');
    if (!run.context?.consent?.[CONSENT_KEYS[kind]]) throw new HttpError(403, `This recording has no consent for ${kind} content`, 'forbidden');
    const raw = typeof body.text === 'string' ? body.text.trim() : '';
    if (!raw) throw new HttpError(422, 'text is required');
    if (raw.length > 4000) throw new HttpError(413, 'text is limited to 4000 characters', 'too-long');
    let field = null;
    if (kind === 'dictation') {
      field = String(body.field || '');
      if (!(run.context.dictationFields || []).includes(field)) throw new HttpError(403, `Dictation from "${field || 'an unnamed field'}" is not on the allowlist`, 'forbidden');
      if (!run.context.practiceBranch || body.branch !== run.context.practiceBranch) throw new HttpError(403, 'Dictation is only kept from the practice copy this recording was started on', 'forbidden');
    }
    const about = typeof body.about === 'string' && /^[A-Za-z]+\/[A-Za-z0-9\-.]{1,64}$/.test(body.about) ? body.about : null;
    const branches = ['main', run.context.practiceBranch].filter(Boolean);
    const patients = (await Promise.all(branches.map((branch) => store.query('Patient', {}, { branch })))).flat();
    const clean = redactText(raw, { names: nameParts(patients) });
    return store.transaction(async (tx) => {
      const now = tx.now();
      const row = {
        id: randomUUID(), run_id: run.id, kind, field, about, cipher: seal(keyOf(), clean.text), length: clean.text.length, redactions: clean.count,
        created_by: ctx.actor.id, created_at: now, expires_at: new Date(Date.parse(now) + (run.context.retentionDays ?? policy.retentionDays) * 86400000).toISOString(),
      };
      await tx.sql.run('INSERT INTO capture_content (id, run_id, kind, field, about, cipher, length, redactions, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [row.id, row.run_id, row.kind, row.field, row.about, row.cipher, row.length, row.redactions, row.created_by, row.created_at, row.expires_at]);
      await recordAction(tx, {
        runId: run.id, actor: ctx.actor, kind: 'create', action: `capture.${kind}`, args: { contentId: row.id, field, about, length: row.length, redactions: row.redactions },
        branch: kind === 'dictation' ? run.context.practiceBranch : 'main', resources: about ? [{ ref: about }] : [], entityRef: `Run/${run.id}`,
        description: `recording content (${kind}, ${row.length} characters, ${row.redactions} redactions)`,
      });
      return rowOut(row);
    });
  }

  async function removeContent(id, contentId, ctx, reason = 'deleted on request') {
    human(ctx);
    const run = await runOf(id);
    return store.transaction(async (tx) => {
      const rows = (await contentRows(tx.sql, run.id)).filter((r) => !contentId || r.id === contentId);
      if (contentId && !rows.length) throw new HttpError(404, 'That content is not stored (it may already have been deleted)');
      for (const r of rows) await tx.sql.run('DELETE FROM capture_content WHERE id = ?', [r.id]);
      if (rows.length) {
        await recordAction(tx, {
          runId: run.id, actor: ctx.actor, kind: 'delete', action: 'capture.content.delete', args: { contentIds: rows.map((r) => r.id), reason }, entityRef: `Run/${run.id}`,
          description: `recording content deleted (${rows.length} item${rows.length === 1 ? '' : 's'}): ${reason}`,
        });
      }
      return { deleted: rows.length };
    });
  }

  /** Deletes content past its retention date. Safe to call at any time. */
  async function purge(actor = { kind: 'human', id: 'system', role: 'system' }) {
    return store.transaction(async (tx) => {
      const rows = await tx.sql.all('SELECT id, run_id FROM capture_content WHERE expires_at <= ?', [tx.now()]);
      if (!rows.length) return { deleted: 0 };
      await tx.sql.run('DELETE FROM capture_content WHERE expires_at <= ?', [tx.now()]);
      for (const runId of new Set(rows.map((r) => r.run_id))) {
        const ids = rows.filter((r) => r.run_id === runId).map((r) => r.id);
        await recordAction(tx, { runId, actor, kind: 'delete', action: 'capture.content.delete', args: { contentIds: ids, reason: 'retention period ended' }, entityRef: `Run/${runId}`, description: `recording content expired (${ids.length})` });
      }
      return { deleted: rows.length };
    });
  }

  async function detail(id, ctx, { withText = false } = {}) {
    const run = await runOf(id);
    const steps = await store.query('TraceStep', { groupKey: run.id });
    const rows = await contentRows(store.sql, run.id);
    const content = rows.map(rowOut);
    if (withText) {
      human(ctx);
      for (const [i, r] of rows.entries()) content[i].text = unseal(keyOf(), r.cipher);
      if (rows.length) await store.transaction((tx) => recordAction(tx, { runId: run.id, actor: ctx.actor, kind: 'read', action: 'capture.content.read', args: { items: rows.length }, entityRef: `Run/${run.id}`, description: `recording content read (${rows.length} items)` }));
    }
    const refs = new Set(steps.filter((s) => /^capture\.(think-aloud|why|dictation)$/.test(s.did.type)).map((s) => s.did.args.contentId));
    const cases = (await store.query('EvalCase')).filter((c) => c.capturedFrom === run.id).map((c) => ({ id: c.id, title: c.title, split: c.split }));
    return { run: withStatus(run), summary: summarize(run, steps, content), content, contentDeleted: [...refs].filter((r) => !rows.some((x) => x.id === r)).length, cases, goldActions: await goldFrom(run, steps) };
  }

  // The clinician's own orders, prescriptions and diagnoses during the recording become the case's gold actions.
  async function goldFrom(run, steps) {
    const branch = run.context?.practiceBranch || 'main';
    const out = [];
    for (const s of steps) {
      const type = s.did.args?.type;
      if (s.who.kind !== 'human' || s.did.type !== 'fhir.create' || !GOLD_TYPE[type]) continue;
      const doc = await store.get(type, s.did.args.id, { branch });
      if (!doc || ['cancelled', 'revoked', 'entered-in-error'].includes(doc.status)) continue;
      const coding = (type === 'MedicationRequest' ? doc.medicationCodeableConcept : doc.code)?.coding?.[0];
      const prefix = SYSTEM_PREFIX.find(([re]) => re.test(coding?.system || ''))?.[1];
      if (!coding?.code || !prefix) continue;
      const code = `${prefix}:${coding.code}`;
      if (!out.some((g) => g.code === code && g.type === GOLD_TYPE[type])) out.push({ type: GOLD_TYPE[type], code, label: coding.display || code, patient: doc._patient });
    }
    return out;
  }

  async function makeCase(id, body, ctx) {
    human(ctx);
    if (!rl) throw new HttpError(501, 'The case bank is not available');
    const run = await runOf(id);
    if (!run.endedAt) throw new HttpError(409, 'Stop the recording before turning it into a case');
    if (run.context?.practiceBranch) throw new HttpError(409, 'A recording made on a practice copy cannot become a case: its work is not in the live chart');
    const gold = await goldFrom(run, await store.query('TraceStep', { groupKey: run.id }));
    const patient = body?.patient || gold[0]?.patient;
    const mine = gold.filter((g) => g.patient === patient);
    if (!mine.length) throw new HttpError(422, 'This recording contains no coded order, prescription or diagnosis to use as the correct actions');
    return rl.createCase({
      title: body?.title, scenario: body?.scenario, task: body?.task, split: body?.split, patient, asOf: run.startedAt,
      goldActions: mine.map(({ patient: _p, ...g }) => g), tags: ['recorded'],
    }, ctx.actor, { source: 'recording', capturedFrom: run.id });
  }

  async function list() {
    const runs = (await store.query('Run', { mode: 'capture' })).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const counts = await store.sql.all('SELECT run_id, COUNT(*) AS n FROM capture_content GROUP BY run_id', []);
    const byRun = new Map(counts.map((c) => [c.run_id, Number(c.n)]));
    return { policy: await capturePolicy(store), kinds: CONTENT_KINDS, recordings: runs.map((r) => ({ ...withStatus(r), contentItems: byRun.get(r.id) || 0 })) };
  }

  async function handle(req, url, body, ctx, parts) {
    if (parts[0] !== 'capture') return null;
    const m = req.method;
    const [, id, op, sub] = parts;
    if (parts.length === 1 && m === 'GET') return { status: 200, body: await list() };
    if (id === 'policy' && parts.length === 2) {
      if (m === 'GET') return { status: 200, body: await capturePolicy(store) };
      if (m === 'PUT') { human(ctx); return { status: 200, body: await setPolicy(body, ctx.actor) }; }
    }
    if (id === 'start' && parts.length === 2 && m === 'POST') return { status: 201, body: await start(body, ctx) };
    if (id === 'purge' && parts.length === 2 && m === 'POST') { human(ctx); return { status: 200, body: await purge(ctx.actor) }; }
    if (id && parts.length === 2 && m === 'GET') return { status: 200, body: await detail(id, ctx, { withText: url.searchParams.get('content') === 'true' }) };
    if (id && op === 'stop' && m === 'POST') { human(ctx); await runOf(id); return { status: 200, body: withStatus(await endRun(store, id, ctx.actor, 'completed')) }; }
    if (id && op === 'content' && parts.length === 3 && m === 'POST') return { status: 201, body: await addContent(id, body, ctx) };
    if (id && op === 'content' && m === 'DELETE') return { status: 200, body: await removeContent(id, sub ?? null, ctx) };
    if (id && op === 'case' && m === 'POST') return { status: 201, body: await makeCase(id, body, ctx) };
    return null;
  }

  return { handle, start, addContent, removeContent, purge, detail, list, setPolicy, makeCase };
}
