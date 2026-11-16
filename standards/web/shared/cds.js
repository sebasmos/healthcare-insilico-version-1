// CDS Hooks client side for the EHR: fires patient-view,
// order-select and order-sign through the server's client route, renders the
// cards in the advisory area, applies accepted suggestions as drafts the
// clinician still signs, and sends feedback for every outcome. Cards are
// advisory: a slow or failing service shows nothing and never blocks.
import { h, btn, badge, openDialog, askReason, toast } from '/shared/ui.js';
import { api, fhir, view } from '/shared/fhir.js';

const INDICATOR = { info: ['Info', 'info'], warning: ['Warning', 'warn'], critical: ['Critical', 'solid-danger'] };
const shownOnce = new Set();

export async function invoke(hook, context) {
  try { return await api.post('/api/cds/invoke', { hook, context }); } catch { return { cards: [], calls: [] }; }
}

const feedback = (card, outcome, extra = {}) => api.post('/api/cds/feedback', { serviceId: card.serviceId, card: card.uuid, outcome, ...extra }).catch(() => {});

/** Shows cards in a dialog. Resolves to false only when a critical card on order-sign was not overridden. */
export async function showCards(result, { blocking = false, key = null } = {}) {
  let cards = result?.cards || [];
  if (key) cards = cards.filter((c) => !shownOnce.has(`${key}:${c.serviceId}:${c.summary}`));
  if (!cards.length) return true;
  return new Promise((resolve) => {
    let proceed = true;
    const decided = new Map();
    const rows = cards.map((c) => {
      const [label, kind] = INDICATOR[c.indicator] || INDICATOR.info;
      const status = h('span', { class: 'muted small', testid: `cds-status-${c.uuid}` }, '');
      const suggestions = (c.suggestions || []).map((s) => btn(s.label, { small: true, kind: 'primary', write: true, testid: `cds-suggest-${s.uuid}`, onClick: async () => {
        for (const a of s.actions || []) if (a.type === 'create' && a.resource) await fhir.create(a.resource);
        decided.set(c.uuid, 'accepted');
        status.textContent = 'Applied as a draft; you still sign it.';
        await feedback(c, 'accepted', { acceptedSuggestions: [{ id: s.uuid }] });
      } }));
      const dismiss = btn(c.indicator === 'info' ? 'Dismiss' : 'Override', { small: true, kind: c.indicator === 'critical' ? 'danger' : '', testid: `cds-dismiss-${c.uuid}`, onClick: async () => {
        let overrideReason = null;
        if (c.indicator !== 'info') {
          const reason = await askReason({ title: `Override: ${c.summary}`, intro: (c.overrideReasons || []).length ? `Suggested reasons: ${c.overrideReasons.map((r) => r.display).join('; ')}` : null, testid: 'cds-override' });
          if (!reason) return;
          overrideReason = { code: (c.overrideReasons || []).find((r) => r.display.toLowerCase() === reason.toLowerCase())?.code || 'other', userComment: reason };
        }
        decided.set(c.uuid, 'overridden');
        status.textContent = overrideReason ? `Overridden: ${overrideReason.userComment}` : 'Dismissed';
        await feedback(c, 'overridden', { overrideReason });
      } });
      return h('div', { class: `advisory cds-${c.indicator}`, testid: `cds-card-${c.uuid}`, 'data-service': c.serviceId },
        h('div', { class: 'head' }, badge(label, kind), ' ', c.summary),
        h('div', { class: 'body2' }, h('span', {}, c.detail || ''), h('span', { class: 'muted small' }, `Source: ${c.source?.label || c.serviceTitle || c.serviceId}`), ...suggestions, dismiss, status,
          ...(c.links || []).map((l) => h('a', { href: l.url, target: '_blank', rel: 'noopener', testid: `cds-link-${c.uuid}`, 'aria-label': l.label }, l.label))));
    });
    const { dlg } = openDialog({ title: blocking ? 'Before signing' : 'Decision support', testid: 'cds-cards', wide: true,
      body: [h('p', { class: 'muted' }, `${cards.length} card${cards.length === 1 ? '' : 's'} from clinical decision support services. Advisory only: the built-in safety alerts are separate and always on.${result.suppressed ? ` ${result.suppressed} lower-priority card${result.suppressed === 1 ? '' : 's'} hidden at this friction level.` : ''}`), ...rows],
      actions: [{ label: blocking ? 'Continue to sign' : 'Close', kind: 'primary', testid: 'cds-continue', onClick: (close) => {
        const open = cards.filter((c) => c.indicator === 'critical' && !decided.has(c.uuid));
        if (blocking && open.length) { toast('Override or accept each critical card first', { error: true }); return; }
        close();
      } }, ...(blocking ? [{ label: 'Cancel the order', testid: 'cds-cancel', onClick: (close) => { proceed = false; close(); } }] : [])] });
    dlg.addEventListener('close', () => { if (key) for (const c of cards) shownOnce.add(`${key}:${c.serviceId}:${c.summary}`); resolve(proceed); });
  });
}

export async function patientView(patientId, encounterId = null) {
  if (view.readOnly) return;
  const result = await invoke('patient-view', { patientId, ...(encounterId ? { encounterId } : {}) });
  await showCards(result, { key: `pv:${patientId}` });
}
export async function orderSelect(patientId, draft) {
  if (view.readOnly || !draft) return;
  const result = await invoke('order-select', { patientId, selections: [{ resource: draft }] });
  await showCards(result, { key: `os:${patientId}:${JSON.stringify(draft.code?.coding?.[0]?.code || draft.medicationCodeableConcept?.coding?.[0]?.code || '')}` });
}
/** Returns false when the clinician cancelled after a critical card. */
export async function orderSign(patientId, resources) {
  if (view.readOnly) return true;
  const result = await invoke('order-sign', { patientId, draftOrders: { resourceType: 'Bundle', type: 'collection', entry: resources.map((r) => ({ resource: r })) } });
  return showCards(result, { blocking: true });
}
