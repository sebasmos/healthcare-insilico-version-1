// Model adapters. One interface:
//   complete({ system, messages, tools, images, maxTokens, temperature, seed }) → { text, toolCalls, usage, latencyMs }
// stub is deterministic and offline. The external adapters are off unless
// ALLOW_EXTERNAL_MODELS=true and their own settings are present; keys come
// only from environment variables and are never logged, stored or sent to
// the browser. Nothing here touches the store.
import { createHash } from 'node:crypto';
import { stubReply } from './templates.mjs';

export const ADAPTERS = ['stub', 'openai-compatible', 'anthropic', 'http-json'];
export const externalModelsAllowed = (env = process.env) => env.ALLOW_EXTERNAL_MODELS === 'true';
const approxTokens = (text) => Math.ceil(String(text || '').length / 4);
const textOf = (messages) => messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

/** Which adapters can run now, with the reason when one cannot. Settings values are never included. */
export function availability(env = process.env) {
  const allowed = externalModelsAllowed(env);
  return {
    stub: { available: true, model: 'stub-1', reason: null },
    'openai-compatible': { available: allowed && Boolean(env.OPENAI_API_KEY && env.OPENAI_MODEL), model: env.OPENAI_MODEL || null, reason: !allowed ? 'ALLOW_EXTERNAL_MODELS is not true' : !(env.OPENAI_API_KEY && env.OPENAI_MODEL) ? 'OPENAI_API_KEY and OPENAI_MODEL are not both set' : null },
    anthropic: { available: allowed && Boolean(env.ANTHROPIC_API_KEY && env.ANTHROPIC_MODEL), model: env.ANTHROPIC_MODEL || null, reason: !allowed ? 'ALLOW_EXTERNAL_MODELS is not true' : !(env.ANTHROPIC_API_KEY && env.ANTHROPIC_MODEL) ? 'ANTHROPIC_API_KEY and ANTHROPIC_MODEL are not both set' : null },
    'http-json': { available: allowed && Boolean(env.HTTP_JSON_MODEL_URL), model: env.HTTP_JSON_MODEL_NAME || (env.HTTP_JSON_MODEL_URL ? 'http-json' : null), reason: !allowed ? 'ALLOW_EXTERNAL_MODELS is not true' : !env.HTTP_JSON_MODEL_URL ? 'HTTP_JSON_MODEL_URL is not set' : null },
  };
}

/** Deterministic offline adapter: the answer depends only on the request (template and input) and the seed. */
async function stub(request) {
  const started = Date.now();
  const seed = Number(request.seed ?? 0);
  const text = stubReply(request, seed);
  return { text, toolCalls: [], usage: { promptTokens: approxTokens(request.system) + approxTokens(textOf(request.messages || [])), completionTokens: approxTokens(text) }, latencyMs: Date.now() - started, model: 'stub-1' };
}

async function openaiCompatible(request, env) {
  const started = Date.now();
  const base = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const body = { model: env.OPENAI_MODEL, temperature: request.temperature ?? 0, max_tokens: request.maxTokens ?? 1024, seed: request.seed ?? undefined, messages: [...(request.system ? [{ role: 'system', content: request.system }] : []), ...(request.messages || []).map((m) => ({ role: m.role, content: m.content }))], ...(request.tools?.length ? { tools: request.tools.map((t) => ({ type: 'function', function: t })) } : {}) };
  const r = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(request.timeoutMs ?? 60000) });
  if (!r.ok) throw new Error(`Model endpoint answered HTTP ${r.status}`);
  const json = await r.json();
  const choice = json.choices?.[0]?.message || {};
  return { text: choice.content || '', toolCalls: (choice.tool_calls || []).map((c) => ({ name: c.function?.name, args: (() => { try { return JSON.parse(c.function?.arguments || '{}'); } catch { return {}; } })() })), usage: { promptTokens: json.usage?.prompt_tokens ?? null, completionTokens: json.usage?.completion_tokens ?? null }, latencyMs: Date.now() - started, model: json.model || env.OPENAI_MODEL };
}

async function anthropic(request, env) {
  const started = Date.now();
  const body = { model: env.ANTHROPIC_MODEL, max_tokens: request.maxTokens ?? 1024, temperature: request.temperature ?? 0, ...(request.system ? { system: request.system } : {}), messages: (request.messages || []).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })), ...(request.tools?.length ? { tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters || { type: 'object' } })) } : {}) };
  const r = await fetch(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body), signal: AbortSignal.timeout(request.timeoutMs ?? 60000) });
  if (!r.ok) throw new Error(`Model endpoint answered HTTP ${r.status}`);
  const json = await r.json();
  const blocks = json.content || [];
  return { text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ name: b.name, args: b.input || {} })), usage: { promptTokens: json.usage?.input_tokens ?? null, completionTokens: json.usage?.output_tokens ?? null }, latencyMs: Date.now() - started, model: json.model || env.ANTHROPIC_MODEL };
}

/** A generic POST for self-hosted models (for example an image classifier): { system, messages, images, template } in, { text, toolCalls?, usage? } out. */
async function httpJson(request, env) {
  const started = Date.now();
  const r = await fetch(env.HTTP_JSON_MODEL_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(env.HTTP_JSON_MODEL_KEY ? { Authorization: `Bearer ${env.HTTP_JSON_MODEL_KEY}` } : {}) }, body: JSON.stringify({ system: request.system, messages: request.messages, images: request.images || [], template: request.template || null, seed: request.seed ?? null }), signal: AbortSignal.timeout(request.timeoutMs ?? 60000) });
  if (!r.ok) throw new Error(`Model endpoint answered HTTP ${r.status}`);
  const json = await r.json();
  return { text: typeof json.text === 'string' ? json.text : JSON.stringify(json), toolCalls: Array.isArray(json.toolCalls) ? json.toolCalls : [], usage: { promptTokens: json.usage?.promptTokens ?? null, completionTokens: json.usage?.completionTokens ?? null }, latencyMs: Date.now() - started, model: env.HTTP_JSON_MODEL_NAME || 'http-json' };
}

export const promptHash = (request) => createHash('sha256').update(JSON.stringify({ system: request.system || '', messages: request.messages || [], tools: (request.tools || []).map((t) => t.name), images: (request.images || []).map((i) => i.ref || i) })).digest('hex').slice(0, 16);

/** Runs the named adapter. Throws when it is not available. */
export async function runAdapter(name, request, env = process.env) {
  const avail = availability(env)[name];
  if (!avail) throw new Error(`Unknown model adapter "${name}". Known: ${ADAPTERS.join(', ')}`);
  if (!avail.available) throw new Error(`Model adapter "${name}" is off: ${avail.reason}`);
  if (name === 'stub') return stub(request);
  if (name === 'openai-compatible') return openaiCompatible(request, env);
  if (name === 'anthropic') return anthropic(request, env);
  return httpJson(request, env);
}
