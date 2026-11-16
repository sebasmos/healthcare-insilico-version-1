// Recording state shared by every app and tab. While a recording is on, the
// browser remembers its Run id (localStorage, so all tabs see it), requests
// carry it as X-Run-Id, and a "Recording" indicator is always on screen.
// Free text is only ever sent when the recording's consent allows that kind.
const KEY = 'hd.capture';
const listeners = new Set();

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    return v && typeof v.runId === 'string' ? v : null;
  } catch { return null; }
}

let current = read();
const notify = () => listeners.forEach((fn) => { try { fn(current); } catch (err) { console.error(err); } });

export const capture = {
  get active() { return current; },
  get runId() { return current?.runId ?? null; },
  /** run: the Run returned by POST /agent-ops/capture/start, or null when the recording stops. */
  set(run) {
    current = run ? {
      runId: run.id, startedAt: run.startedAt, recorder: run.context?.recorder ?? null, consent: run.context?.consent ?? {},
      practiceBranch: run.context?.practiceBranch ?? null, dictationFields: run.context?.dictationFields ?? [],
    } : null;
    try { if (current) localStorage.setItem(KEY, JSON.stringify(current)); else localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
    notify();
  },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => { if (e.key === KEY) { current = read(); notify(); } });
}
