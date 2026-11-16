// Stand-ins for Node built-ins that the vendored libraries import behind
// environment checks the browser never takes. Generated-adjacent; kept small.
export class EventEmitter {
  constructor() { this.l = new Map(); }
  on(n, f) { (this.l.get(n) || this.l.set(n, []).get(n)).push(f); return this; }
  once(n, f) { const g = (...a) => { this.off(n, g); f(...a); }; return this.on(n, g); }
  off(n, f) { this.l.set(n, (this.l.get(n) || []).filter((x) => x !== f)); return this; }
  emit(n, ...a) { for (const f of [...(this.l.get(n) || [])]) f(...a); return true; }
  removeListener(n, f) { return this.off(n, f); }
  removeAllListeners(n) { if (n) this.l.delete(n); else this.l.clear(); return this; }
}
export default { EventEmitter };
export const readFileSync = () => { throw new Error('fs is not available in the browser'); };
export const existsSync = () => false;
export const join = (...p) => p.join('/');
export const dirname = (p) => p.split('/').slice(0, -1).join('/');
export const fileURLToPath = (u) => String(u);
export const pathToFileURL = (p) => new URL(p, 'file:///');
