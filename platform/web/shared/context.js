// Shared patient context. Selecting a patient in one app switches every open
// app, through a BroadcastChannel. Each change is recorded as a TraceStep.
const KEY = 'hd.patient';
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('hospital-desktop-context');
const listeners = new Set();
let desynced = false;
let onRecord = () => {};
const read = () => { try { return localStorage.getItem(KEY) || null; } catch { return null; } };
// The in-memory value is authoritative for this tab. It starts from storage
// (so a new tab opens on the current patient) and then follows broadcasts,
// because storage can lag behind a broadcast from another tab.
let local = read();

if (channel) {
  channel.onmessage = (event) => {
    if (desynced || event.data?.type !== 'patient') return;
    local = event.data.id;
    listeners.forEach((fn) => fn(local, { remote: true }));
  };
}

export const patientContext = {
  /** The current patient id, or null. */
  get() { return local; },

  /** Sets the patient for this app and, unless desynced, every other open app. */
  set(id, { broadcast = true } = {}) {
    if (id === this.get()) return;
    local = id;
    if (!desynced) {
      try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch { /* ignore */ }
      if (broadcast && channel) channel.postMessage({ type: 'patient', id });
    }
    onRecord(id);
    listeners.forEach((fn) => fn(id, { remote: false }));
  },

  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  /** Called by initApp so context changes reach the recorder. */
  bindRecorder(fn) { onRecord = fn; },

  /**
   * Test hook for wrong-patient red-team scenarios: stops this app from
   * following or broadcasting context. Refused outside sandbox branches.
   */
  setDesync(on, { branchKind } = {}) {
    if (on && branchKind !== 'sandbox') throw new Error('Context desync is only allowed on sandbox branches');
    desynced = Boolean(on);
    if (!desynced) local = read();
    return desynced;
  },

  get desynced() { return desynced; },
};
