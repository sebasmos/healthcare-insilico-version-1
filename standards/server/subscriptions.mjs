// Topic-based Subscriptions: the R4 Subscriptions Backport IG (Subscription with a topic in criteria) and R5
// SubscriptionTopic. Six topics. rest-hook notifications are pushed only to this machine, or anywhere when the owner
// sets ALLOW_SUBSCRIPTION_PUSH=true, and never while RESTRICTED_DATA=true. Every notification is kept (for $events)
// and logged as a TraceStep. $status gives the subscription's state.
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';

const BACKPORT = 'http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition';
const has = (r, sys, code) => (r?.category || []).some((c) => (c.coding || []).some((x) => x.code === code));
export const TOPICS = [
  { id: 'encounter-start', title: 'Encounter started', resource: 'Encounter', when: (r) => r.status === 'in-progress' },
  { id: 'encounter-end', title: 'Encounter finished', resource: 'Encounter', when: (r) => r.status === 'finished' },
  { id: 'lab-result-final', title: 'Laboratory result final', resource: 'Observation', when: (r) => ['final', 'amended', 'corrected'].includes(r.status) && has(r, null, 'laboratory') },
  { id: 'report-final', title: 'Diagnostic report final', resource: 'DiagnosticReport', when: (r) => ['final', 'amended', 'corrected'].includes(r.status) },
  { id: 'order-active', title: 'New active order', resource: 'ServiceRequest', when: (r) => r.status === 'active' },
  { id: 'appointment-booked', title: 'Appointment booked', resource: 'Appointment', when: (r) => r.status === 'booked' },
];
export function createSubscriptions({ store, baseUrl = () => '', fetchFn = (...a) => fetch(...a) }) {
  const canonical = (id) => `${baseUrl()}/fhir/SubscriptionTopic/${id}`;
  const topicOf = (url) => TOPICS.find((t) => canonical(t.id) === url || url?.endsWith(`/SubscriptionTopic/${t.id}`));
  const pushAllowed = (endpoint) => { if (process.env.RESTRICTED_DATA === 'true') return false; try { const u = new URL(endpoint); return ['http:', 'https:'].includes(u.protocol) && (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || process.env.ALLOW_SUBSCRIPTION_PUSH === 'true'); } catch { return false; } };
  /** R5 SubscriptionTopic resources for the six topics. */
  const topicResources = () => TOPICS.map((t) => ({ resourceType: 'SubscriptionTopic', id: t.id, url: canonical(t.id), title: t.title, status: 'active', resourceTrigger: [{ resource: `http://hl7.org/fhir/StructureDefinition/${t.resource}`, supportedInteraction: ['create', 'update'] }], canFilterBy: [{ resource: t.resource, filterParameter: 'patient' }], notificationShape: [{ resource: t.resource }] }));
  /** Checks a backport Subscription before it is stored. */
  function check(sub) {
    if (sub?.resourceType !== 'Subscription') throw new HttpError(422, 'Not a Subscription');
    if (!topicOf(sub.criteria)) throw new HttpError(422, `criteria must be one of the topics: ${TOPICS.map((t) => canonical(t.id)).join(', ')}`);
    if (sub.channel?.type !== 'rest-hook' || !sub.channel?.endpoint) throw new HttpError(422, 'channel.type must be rest-hook, with an endpoint');
    const content = (sub.channel?.payload && (sub.channel._payload?.extension || []).find((e) => e.url === `${BACKPORT}/backport-payload-content`)?.valueCode) || 'id-only';
    if (!['empty', 'id-only', 'full-resource'].includes(content)) throw new HttpError(422, 'payload content must be empty, id-only or full-resource');
    return { ...sub, status: 'active', meta: { ...(sub.meta || {}), profile: [`${BACKPORT}/backport-subscription`] } };
  }
  const statusParams = (sub, type, events, n) => ({ resourceType: 'Parameters', id: randomUUID(), meta: { profile: [`${BACKPORT}/backport-subscription-status-r4`] }, parameter: [{ name: 'subscription', valueReference: { reference: `${baseUrl()}/fhir/R4/Subscription/${sub.id}` } }, { name: 'topic', valueCanonical: sub.criteria }, { name: 'status', valueCode: sub.status }, { name: 'type', valueCode: type }, { name: 'events-since-subscription-start', valueString: String(n) }, ...events.map((e) => ({ name: 'notification-event', part: [{ name: 'event-number', valueString: String(e.n) }, { name: 'timestamp', valueInstant: e.at }, ...(e.focus ? [{ name: 'focus', valueReference: { reference: e.focus } }] : [])] }))] });
  const bundle = (sub, type, events, n, resources = []) => ({ resourceType: 'Bundle', id: randomUUID(), type: 'history', timestamp: new Date().toISOString(), meta: { profile: [`${BACKPORT}/backport-subscription-notification-r4`] }, entry: [{ fullUrl: `urn:uuid:${randomUUID()}`, resource: statusParams(sub, type, events, n), request: { method: 'GET', url: `${baseUrl()}/fhir/R4/Subscription/${sub.id}/$status` }, response: { status: '200' } }, ...resources.map((r) => ({ fullUrl: `${baseUrl()}/fhir/R4/${r.resourceType}/${r.id}`, resource: r, request: { method: 'PUT', url: `${r.resourceType}/${r.id}` }, response: { status: '200' } }))] });
  async function deliver(sub, body) {
    if (!pushAllowed(sub.channel.endpoint)) return { delivered: false, why: process.env.RESTRICTED_DATA === 'true' ? 'outside services are off (RESTRICTED_DATA=true)' : 'the endpoint is not on this machine (ALLOW_SUBSCRIPTION_PUSH=true allows others)' };
    try { const headers = { 'Content-Type': 'application/fhir+json', ...Object.fromEntries((sub.channel.header || []).map((h) => h.split(/:\s*/, 2)).filter((x) => x.length === 2)) }; const r = await fetchFn(sub.channel.endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }); return { delivered: r.ok, status: r.status }; } catch (err) { return { delivered: false, why: String(err.message).slice(0, 200) }; }
  }
  const eventsOf = (subId) => store.query('SubscriptionEvent', { where: (e) => e.subscription === subId }, { branch: 'main' });
  /** Called after every committed write on the live record. */
  async function onCommitted({ type, saved, ctx }) {
    if (!saved || ctx?.branch && ctx.branch !== 'main') return; const hits = TOPICS.filter((t) => t.resource === type && t.when(saved)); if (!hits.length) return;
    for (const sub of await store.query('Subscription', { where: (s) => s.status === 'active' }, { branch: 'main' })) {
      const t = topicOf(sub.criteria); if (!t || !hits.includes(t)) continue;
      const patientFilter = (sub._criteria?.extension || sub.extension || []).map((e) => e.valueString).filter(Boolean).find((x) => /^patient=/.test(x) || new RegExp(`^${t.resource}\\?patient=`).test(x));
      if (patientFilter && !String(saved._patient || saved.subject?.reference || '').endsWith(patientFilter.split('=')[1].replace(/^Patient\//, ''))) continue;
      const n = (await eventsOf(sub.id)).length + 1; const at = new Date().toISOString(); const focus = `${type}/${saved.id}`;
      const content = (sub.channel._payload?.extension || []).find((e) => e.url === `${BACKPORT}/backport-payload-content`)?.valueCode || 'id-only';
      const body = bundle(sub, 'event-notification', [{ n, at, focus: content === 'empty' ? null : focus }], n, content === 'full-resource' ? [Object.fromEntries(Object.entries(saved).filter(([k]) => !k.startsWith('_')))] : []);
      const result = await deliver(sub, body);
      await store.transaction(async (tx) => { await tx.save('SubscriptionEvent', { resourceType: 'SubscriptionEvent', id: randomUUID(), subscription: sub.id, n, at, focus, topic: t.id, delivered: result.delivered, why: result.why || null }, { branch: 'main', updatedBy: 'subscriptions' }); await recordAction(tx, { runId: LIVE_RUN_ID, actor: { kind: 'human', id: 'subscriptions', role: 'interface' }, kind: 'execute', action: 'subscription.notify', args: { subscription: sub.id, topic: t.id, event: n, focus, delivered: result.delivered, endpoint: sub.channel.endpoint }, description: `notification ${n} for ${t.title}${result.delivered ? '' : ` (not sent: ${result.why || result.status})`}`, audit: false }); });
    }
  }
  async function operation(id, op, url) {
    const sub = await store.get('Subscription', id, { branch: 'main' }); if (!sub) throw new HttpError(404, `Subscription/${id} not found`, 'not-found');
    const events = (await eventsOf(id)).sort((a, b) => a.n - b.n);
    if (op === '$status') return bundle(sub, 'query-status', [], events.length);
    if (op === '$events') { const from = Number(url.searchParams.get('eventsSinceNumber') || 1); const to = Number(url.searchParams.get('eventsUntilNumber') || Infinity); return bundle(sub, 'query-event', events.filter((e) => e.n >= from && e.n <= to).map((e) => ({ n: e.n, at: e.at, focus: e.focus })), events.length); }
    throw new HttpError(404, `${op} is not an operation on Subscription`, 'not-supported');
  }
  /** The handshake when a subscription is made. */
  async function handshake(sub) { const r = await deliver(sub, bundle(sub, 'handshake', [], 0)); await store.transaction((tx) => recordAction(tx, { runId: LIVE_RUN_ID, actor: { kind: 'human', id: 'subscriptions', role: 'interface' }, kind: 'execute', action: 'subscription.handshake', args: { subscription: sub.id, delivered: r.delivered, endpoint: sub.channel.endpoint }, description: 'subscription handshake', audit: false })).catch(() => {}); return r; }
  return { TOPICS, topicResources, canonical, check, onCommitted, operation, handshake };
}
