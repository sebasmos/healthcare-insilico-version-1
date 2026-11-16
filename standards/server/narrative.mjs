// Generated narrative for FHIR answers (docs/STANDARDS.md): every resource gets a short text.div naming its type,
// id and status, never a person's name, so validators see narrative on each resource (dom-6).
export const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A short generated narrative: the type, the id and the status, never a name. */
export function narrate(r) {
  if (!r || typeof r !== 'object' || !r.resourceType || r.text || ['Bundle', 'Parameters', 'Binary'].includes(r.resourceType)) return r;
  const bits = [r.resourceType, r.id && `id ${r.id}`, r.status && `status ${r.status}`, r.use && `use ${r.use}`, r.outcome && `outcome ${r.outcome}`].filter(Boolean).join(', ');
  return { ...r, text: { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${esc(bits)}</p></div>` } };
}
/** Narrative on every resource, fullUrl on every bundle entry, and total only on search and history bundles. */
export function finish(x, BASE = 'https://hospital-desktop.invalid/fhir') {
  if (!x || typeof x !== 'object') return x;
  if (x.resourceType === 'Bundle') { const { total, ...b } = x; return { ...b, ...(['searchset', 'history'].includes(x.type) ? { total: total ?? (x.entry || []).length } : {}), entry: (x.entry || []).map((e, i) => { const r = finish(e.resource, BASE); return { fullUrl: e.fullUrl || (r?.id ? `${BASE}/${r.resourceType}/${r.id}` : `urn:uuid:00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`), ...e, resource: r }; }) }; }
  if (x.resourceType === 'Parameters') return { ...x, parameter: (x.parameter || []).map((p) => (p.resource ? { ...p, resource: finish(p.resource, BASE) } : p)) };
  return narrate(x.meta && !x.meta.lastUpdated ? { ...x, meta: { ...x.meta, lastUpdated: new Date().toISOString() } } : x);
}

