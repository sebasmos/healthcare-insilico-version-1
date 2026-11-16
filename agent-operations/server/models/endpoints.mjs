// Model endpoints for the reference harness: any
// OpenAI-compatible endpoint (including local servers), and the OpenAI,
// Anthropic and Google APIs. One neutral conversation shape goes in and comes
// out; each provider's wire format is converted here. Keys are passed in by
// the caller and never logged, stored on the agent or returned.
//
// Neutral messages:
//   { role: 'user', content }
//   { role: 'assistant', content, toolCalls: [{ id, name, args }] }
//   { role: 'tool', toolCallId, name, content }
import { HttpError } from '../../../platform/server/http.mjs';

export const PROVIDERS = ['openai-compatible', 'openai', 'anthropic', 'google'];
export const DEFAULT_BASE = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1', google: 'https://generativelanguage.googleapis.com/v1beta' };
export const DEFAULT_KEY_ENV = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', google: 'GOOGLE_API_KEY', 'openai-compatible': null };

/** True when the URL points at this machine: nothing sent there leaves it. */
export function isLocalUrl(url) {
  let host;
  try { host = new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch { return false; }
  return host === 'localhost' || host === '::1' || host === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** Validates what a registration says about its model endpoint. No key is kept here. */
export function normalizeEndpoint(input) {
  const provider = String(input?.provider || '');
  if (!PROVIDERS.includes(provider)) throw new HttpError(422, `provider must be one of ${PROVIDERS.join(', ')}`);
  const baseUrl = String(input?.baseUrl || DEFAULT_BASE[provider] || '').replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw new HttpError(422, 'baseUrl must be a URL (for a local server, for example http://localhost:11434/v1)'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(422, 'baseUrl must be http or https');
  const model = String(input?.model || '').trim().slice(0, 120);
  if (!model) throw new HttpError(422, 'model (the model name the endpoint expects) is required');
  const keyEnv = input?.keyEnv ? String(input.keyEnv).trim() : DEFAULT_KEY_ENV[provider];
  if (keyEnv && !/^[A-Z][A-Z0-9_]{2,60}$/.test(keyEnv)) throw new HttpError(422, 'keyEnv must be the NAME of an environment variable, such as MY_MODEL_KEY');
  return { provider, baseUrl, model, keyEnv: keyEnv || null, local: isLocalUrl(baseUrl) };
}

const parseArgs = (raw) => { if (raw && typeof raw === 'object') return raw; try { return JSON.parse(raw || '{}'); } catch { return {}; } };

function openaiBody(endpoint, r) {
  const messages = [...(r.system ? [{ role: 'system', content: r.system }] : [])];
  for (const m of r.messages || []) {
    if (m.role === 'tool') messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: String(m.content ?? '') });
    else if (m.role === 'assistant') messages.push({ role: 'assistant', content: m.content || '', ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })) } : {}) });
    else messages.push({ role: 'user', content: String(m.content ?? '') });
  }
  return { model: endpoint.model, messages, temperature: r.temperature ?? 0, max_tokens: r.maxTokens ?? 1024, ...(r.seed != null ? { seed: r.seed } : {}), ...(r.tools?.length ? { tools: r.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}) };
}
function openaiResult(json) {
  const msg = json.choices?.[0]?.message || {};
  return { text: msg.content || '', toolCalls: (msg.tool_calls || []).map((c, i) => ({ id: c.id || `call-${i}`, name: c.function?.name, args: parseArgs(c.function?.arguments) })), usage: { promptTokens: json.usage?.prompt_tokens ?? null, completionTokens: json.usage?.completion_tokens ?? null }, model: json.model || null };
}

function anthropicBody(endpoint, r) {
  const messages = [];
  const push = (role, blocks) => { const last = messages[messages.length - 1]; if (last && last.role === role) last.content.push(...blocks); else messages.push({ role, content: blocks }); };
  for (const m of r.messages || []) {
    if (m.role === 'tool') push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content: String(m.content ?? '') }]);
    else if (m.role === 'assistant') push('assistant', [...(m.content ? [{ type: 'text', text: m.content }] : []), ...(m.toolCalls || []).map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} }))]);
    else push('user', [{ type: 'text', text: String(m.content ?? '') }]);
  }
  return { model: endpoint.model, max_tokens: r.maxTokens ?? 1024, temperature: r.temperature ?? 0, ...(r.system ? { system: r.system } : {}), messages, ...(r.tools?.length ? { tools: r.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}) };
}
function anthropicResult(json) {
  const blocks = json.content || [];
  return { text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} })), usage: { promptTokens: json.usage?.input_tokens ?? null, completionTokens: json.usage?.output_tokens ?? null }, model: json.model || null };
}

function googleBody(endpoint, r) {
  const contents = [];
  const push = (role, parts) => { const last = contents[contents.length - 1]; if (last && last.role === role) last.parts.push(...parts); else contents.push({ role, parts }); };
  for (const m of r.messages || []) {
    if (m.role === 'tool') { let response; try { response = JSON.parse(m.content); } catch { response = { text: String(m.content ?? '') }; } push('user', [{ functionResponse: { name: m.name, response: response && typeof response === 'object' && !Array.isArray(response) ? response : { result: response } } }]); }
    else if (m.role === 'assistant') push('model', [...(m.content ? [{ text: m.content }] : []), ...(m.toolCalls || []).map((c) => ({ functionCall: { name: c.name, args: c.args || {} } }))]);
    else push('user', [{ text: String(m.content ?? '') }]);
  }
  return { contents, ...(r.system ? { systemInstruction: { parts: [{ text: r.system }] } } : {}), generationConfig: { temperature: r.temperature ?? 0, maxOutputTokens: r.maxTokens ?? 1024 }, ...(r.tools?.length ? { tools: [{ functionDeclarations: r.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }] } : {}) };
}
function googleResult(json) {
  const parts = json.candidates?.[0]?.content?.parts || [];
  return { text: parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('\n'), toolCalls: parts.filter((p) => p.functionCall).map((p, i) => ({ id: `call-${i}`, name: p.functionCall.name, args: p.functionCall.args || {} })), usage: { promptTokens: json.usageMetadata?.promptTokenCount ?? null, completionTokens: json.usageMetadata?.candidatesTokenCount ?? null }, model: json.modelVersion || null };
}

/** The request each provider expects, without sending it (also used by the tests). */
export function buildRequest(endpoint, request, apiKey) {
  const json = { 'Content-Type': 'application/json' };
  if (endpoint.provider === 'anthropic') return { url: `${endpoint.baseUrl}/messages`, headers: { ...json, 'x-api-key': apiKey || '', 'anthropic-version': '2023-06-01' }, body: anthropicBody(endpoint, request) };
  if (endpoint.provider === 'google') return { url: `${endpoint.baseUrl}/models/${encodeURIComponent(endpoint.model)}:generateContent`, headers: { ...json, 'x-goog-api-key': apiKey || '' }, body: googleBody(endpoint, request) };
  return { url: `${endpoint.baseUrl}/chat/completions`, headers: { ...json, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, body: openaiBody(endpoint, request) };
}
export const parseResponse = (endpoint, json) => (endpoint.provider === 'anthropic' ? anthropicResult(json) : endpoint.provider === 'google' ? googleResult(json) : openaiResult(json));

/** One model call. Returns { text, toolCalls, usage, model, latencyMs }. The error never contains the key. */
export async function chat(endpoint, request, { apiKey = null } = {}) {
  const started = Date.now();
  const { url, headers, body } = buildRequest(endpoint, request, apiKey);
  let r;
  try { r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(request.timeoutMs ?? 120000) }); } catch (err) { throw new Error(`The model endpoint could not be reached (${err.name === 'TimeoutError' ? 'timed out' : 'connection failed'})`); }
  if (!r.ok) throw new Error(`The model endpoint answered HTTP ${r.status}`);
  const out = parseResponse(endpoint, await r.json());
  return { ...out, model: out.model || endpoint.model, latencyMs: Date.now() - started };
}
