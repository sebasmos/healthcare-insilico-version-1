// UI event recorder. Loaded by every app.
//
// Records structured interaction events only: which control (data-testid),
// which form field (identifier, never its value), coarse focus and scroll,
// navigation, patient-context changes and image-viewer actions. It never
// reads input values, key presses, text content or dictation.
//
// Events are batched and POSTed to /agent-ops/trace. Each batch has a
// batchId (the idempotency key) and per-event seq numbers. A failed batch is
// retried with the same batchId, so the server never stores it twice.

const ALLOWED = ['target', 'field', 'route', 'patient', 'asOf', 'branch', 'resources', 'viewer', 'uiStateHash'];
const ID_SAFE = /^[A-Za-z0-9_\-.:/#]{1,128}$/;

function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function randomId() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}-${Math.random().toString(16).slice(2, 10)}`;
}

export function createRecorder({
  app,
  endpoint = '/agent-ops/trace',
  fetch: fetchFn = (...a) => globalThis.fetch(...a),
  flushMs = 2000,
  maxBatch = 25,
  maxQueue = 2000,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  now = () => new Date(),
} = {}) {
  const sessionId = randomId();
  const context = { runId: null, role: 'unspecified', userId: null, patient: null, asOf: null, branch: 'main' };
  let seq = 0;
  let queue = [];
  let inflight = null;
  let timer = null;
  let backoff = 1000;

  function stateHash(route) {
    return fnv1a([app, route || '', context.patient || '', context.asOf || 'live', context.branch].join('|'));
  }

  function record(type, detail = {}) {
    const event = { seq: seq += 1, type, app, sessionId, clientTime: now().toISOString() };
    for (const key of ALLOWED) {
      if (detail[key] !== undefined && detail[key] !== null) event[key] = detail[key];
    }
    for (const key of ['target', 'field', 'route']) {
      if (event[key] !== undefined && !ID_SAFE.test(String(event[key]))) delete event[key];
    }
    if (context.patient && event.patient === undefined) event.patient = context.patient;
    if (context.asOf && event.asOf === undefined) event.asOf = context.asOf;
    if (event.branch === undefined) event.branch = context.branch;
    if (event.uiStateHash === undefined) event.uiStateHash = stateHash(event.route);
    queue.push(event);
    if (queue.length > maxQueue) queue = queue.slice(-maxQueue);
    if (queue.length >= maxBatch) flush();
    else schedule(flushMs);
    return event;
  }

  function schedule(ms) {
    if (timer) return;
    timer = setTimer(() => { timer = null; flush(); }, ms);
  }

  function headers() {
    const h = { 'Content-Type': 'application/json', 'X-Role': context.role };
    if (context.userId) h['X-User-Id'] = context.userId;
    if (context.runId) h['X-Run-Id'] = context.runId;
    return h;
  }

  let current = null;

  // Sends everything queued. Returns true when the queue is empty, false when
  // a send failed and a retry is scheduled. Concurrent callers share one send.
  function flush() {
    if (current) return current.then((ok) => (ok && (inflight || queue.length) ? flush() : ok));
    current = drain().finally(() => { current = null; });
    return current;
  }

  async function drain() {
    while (inflight || queue.length) {
      if (!inflight) inflight = { batchId: randomId(), events: queue.splice(0, maxBatch) };
      let ok = false;
      try {
        const response = await fetchFn(endpoint, {
          method: 'POST', headers: headers(), keepalive: true,
          body: JSON.stringify({ batchId: inflight.batchId, events: inflight.events }),
        });
        ok = response.ok;
        if (!ok && response.status >= 400 && response.status < 500) {
          console.warn(`recorder: batch ${inflight.batchId} refused (${response.status}); dropped`);
          ok = true;
        }
      } catch { ok = false; }
      if (!ok) {
        schedule(backoff);
        backoff = Math.min(backoff * 2, 30000);
        return false;
      }
      inflight = null;
      backoff = 1000;
    }
    return true;
  }

  function setContext(next) {
    const patientChanged = 'patient' in next && next.patient !== context.patient;
    Object.assign(context, next);
    if (patientChanged) record('context', { patient: context.patient });
  }

  /** Wires DOM listeners. Only identifiers are read from elements. */
  function attach(doc = globalThis.document, win = globalThis.window) {
    const idOf = (el) => el?.closest?.('[data-testid]')?.getAttribute('data-testid') || null;
    const route = () => `${win.location.pathname}${win.location.hash}`.slice(0, 128);
    doc.addEventListener('click', (e) => { const target = idOf(e.target); if (target) record('click', { target, route: route() }); }, true);
    doc.addEventListener('change', (e) => {
      const field = e.target?.getAttribute?.('data-testid') || e.target?.name || e.target?.id;
      if (field) record('change', { field, route: route() });
    }, true);
    doc.addEventListener('submit', (e) => { const target = idOf(e.target); if (target) record('submit', { target, route: route() }); }, true);
    let lastFocus = null;
    doc.addEventListener('focusin', (e) => {
      const target = idOf(e.target);
      if (target && target !== lastFocus) { lastFocus = target; record('focus', { target, route: route() }); }
    }, true);
    let scrollTimer = null;
    doc.addEventListener('scroll', (e) => {
      if (scrollTimer) return;
      scrollTimer = setTimer(() => { scrollTimer = null; record('scroll', { target: idOf(e.target) || 'page', route: route() }); }, 1000);
    }, true);
    win.addEventListener('hashchange', () => record('nav', { route: route() }));
    win.addEventListener('pagehide', () => { flush(); });
    record('nav', { route: route() });
  }

  return {
    record, flush, setContext, attach, sessionId,
    get pending() { return queue.length + (inflight ? inflight.events.length : 0); },
  };
}
