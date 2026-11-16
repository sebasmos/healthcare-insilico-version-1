// The model layer: one complete() call for every adapter, the
// synthetic-only and restricted-source guard, and the model.call TraceStep
// with adapter, model name, token counts, latency and a hash of the prompt.
// Prompt and response text are kept in the step only when the run's branch
// is not main, masked with the existing redaction; the masking is pattern
// based (names, record numbers, dates, phone numbers, e-mail addresses) and
// cannot catch free text that merely resembles none of those.
import { recordAction, LIVE_RUN_ID } from '../../../platform/server/audit.mjs';
import { HttpError } from '../../../platform/server/http.mjs';
import { isSyntheticPatient } from '../hitl.mjs';
import { RESTRICTED_URL, datasetsForPatients } from '../../../platform/server/datasets.mjs';
import { redactText, nameParts } from '../../../platform/server/redact.mjs';
import { runAdapter, availability, promptHash, ADAPTERS, externalModelsAllowed } from './adapters.mjs';
import { TEMPLATES, observe, prompt, act, parseJson, templateHash } from './templates.mjs';

export { TEMPLATES, ADAPTERS, availability, externalModelsAllowed, promptHash, templateHash };
export const MASKING_NOTE = 'Masking is pattern based: names on the chart, record numbers, dates, phone numbers and e-mail addresses. Other identifying free text is not caught.';

export function createModelLayer({ store, env = process.env }) {
  const log = (fields, ctx) => store.transaction((tx) => recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, branch: ctx.branch ?? 'main', audit: false, ...fields }));

  /** Refuses an external model for a patient who is not synthetic, or who comes from a restricted source. Local adapters are unaffected. */
  async function guard(adapter, patientRef, ctx) {
    if (adapter === 'stub' || !patientRef) return;
    const patient = await store.get('Patient', patientRef.split('/')[1], { branch: ctx.branch ?? 'main' });
    let reason = null;
    if (!patient) reason = 'the patient could not be read';
    else if ((patient.extension || []).some((e) => e.url === RESTRICTED_URL) || datasetsForPatients([patient.id]).some((d) => d.restricted)) reason = 'the patient comes from a source marked restricted in the dataset register';
    else if (!isSyntheticPatient(patient)) reason = 'the patient is not marked synthetic (HTEST)';
    if (!reason) return;
    await log({ kind: 'execute', action: 'model.refuse', args: { adapter, patient: patientRef, reason }, description: `external model refused: ${reason}`, outcome: '8' }, ctx);
    throw new HttpError(403, `An external model may not be used for ${patientRef}: ${reason}`, 'forbidden');
  }

  async function names(patientRef, ctx) {
    if (!patientRef) return [];
    const p = await store.get('Patient', patientRef.split('/')[1], { branch: ctx.branch ?? 'main' });
    return p ? nameParts([p]) : [];
  }

  /**
   * complete(request, { ctx, patientRef }). ctx has actor, runId, branch (an agent run's context).
   * Returns { text, toolCalls, usage, latencyMs, model, adapter, promptHash }.
   */
  async function complete(request, { ctx, patientRef = null } = {}) {
    const adapter = request.adapter || 'stub';
    if (!ADAPTERS.includes(adapter)) throw new HttpError(422, `Unknown model adapter "${adapter}"`);
    const avail = availability(env)[adapter];
    if (!avail.available) throw new HttpError(409, `Model adapter "${adapter}" is off: ${avail.reason}`);
    await guard(adapter, patientRef, ctx);
    const hash = promptHash(request);
    let result;
    try { result = await runAdapter(adapter, request, env); } catch (err) {
      await log({ kind: 'execute', action: 'model.call', args: { adapter, model: avail.model, promptHash: hash, template: request.template || null, error: String(err.message).slice(0, 200), latencyMs: null }, description: `model call failed (${adapter})`, outcome: '8' }, ctx);
      throw err;
    }
    const offMain = ctx.branch && ctx.branch !== 'main';
    const masked = offMain ? { names: await names(patientRef, ctx) } : null;
    const mask = (t) => redactText(String(t || '').slice(0, 6000), masked).text;
    await log({
      kind: 'execute', action: 'model.call', description: `model call (${adapter}, ${result.model})`,
      args: { adapter, model: result.model, template: request.template || null, promptHash: hash, promptTokens: result.usage?.promptTokens ?? null, completionTokens: result.usage?.completionTokens ?? null, latencyMs: result.latencyMs, temperature: request.temperature ?? 0, seed: request.seed ?? null, toolCalls: (result.toolCalls || []).length,
        ...(offMain ? { text: { system: mask(request.system), messages: (request.messages || []).map((m) => ({ role: m.role, content: mask(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) })), response: mask(result.text), masking: MASKING_NOTE } } : {}) },
    }, ctx);
    return { ...result, adapter, promptHash: hash };
  }

  /** Runs one agent template end to end with the agent's logged tools. */
  async function runTemplate({ template, adapter = 'stub', temperature = 0, maxTokens = 1024, seed = 0 }, { task, tools, ctx, why = null }) {
    if (!TEMPLATES[template]) throw new HttpError(422, `Unknown template "${template}". Known: ${Object.keys(TEMPLATES).join(', ')}`);
    const ctxObs = await observe(template, task, tools);
    const request = { ...prompt(template, ctxObs), template, adapter, temperature, maxTokens, seed, tools: [] };
    const out = await complete(request, { ctx, patientRef: ctxObs.patientRef });
    if ((out.text || '').length > 20000) return { output: [], label: 'over-long', flags: [{ code: 'over-long-output', detail: `The model answered with ${out.text.length} characters; the limit is 20000` }], confidence: 0, declined: true, summary: 'Over-long answer discarded; nothing written.' };
    const parsed = parseJson(out.text);
    const result = await act(template, parsed, ctxObs, tools, why || `Model (${adapter}, ${out.model}) answer, prompt ${out.promptHash}`);
    return { ...result, model: { adapter, model: out.model, promptHash: out.promptHash, usage: out.usage, latencyMs: out.latencyMs } };
  }

  return { complete, runTemplate, availability: () => availability(env), templates: TEMPLATES, guard };
}
