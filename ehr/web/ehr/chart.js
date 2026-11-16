// The patient chart: left patient sidebar, tabs, History
// sub-tabs. Every tab renders from one $everything read at the current view
// (as-of time and branch), so time travel applies to the whole chart.
import {
  h, btn, badge, toast, table, card, kv, formDialog, openDialog, askReason, confirmDialog, field,
  fmtDate, fmtDateTime, toLocalInput, age, loadAges, relativeGroup, encodeText, decodeText, slug,
  bornSpan, shownBirthDate,
} from '/shared/ui.js';
import { fhir, api, view, identity, catalog, FhirError, mrn, patientName, display, coding, lifecycle, flagged, ext, refId } from '/shared/fhir.js';
import { patientContext } from '/shared/context.js';
import { visibleChartTabs, canWrite, orderModeRequired } from '/shared/roles.js';
import { nursingTabs, SBAR } from '/ehr/nursing.js';
import { ecgTab } from '/ehr/ecg.js';
import { reviewTable, reviewState, statusChip } from '/ehr/review.js';
import { patientView as cdsPatientView, orderSelect as cdsOrderSelect, orderSign as cdsOrderSign } from '/shared/cds.js';
import { loadProposals } from '/shared/proposals.js';
import { draftEvent, draftHead, checkThis, stripCheckMarks, decideDraft, discardDraft, editSize, draftSettings, CHECK_MARK } from '/shared/drafts.js';
import { reportProblemButton } from '/shared/report-problem.js';

// Every chart activity this page has built. The role's map decides which are shown, and in what order.
export const CHART_TABS = [
  ['summary', 'Summary'], ['review', 'History'], ['problems', 'Problems'], ['allergies', 'Allergies'], ['medications', 'Medications'],
  ['vitals', 'Vitals'], ['notes', 'Notes'], ['orders', 'Orders'], ['encounters', 'Encounters'], ['messages', 'Messages'],
  ['worklist', 'Tasks'], ['mar', 'MAR'], ['flowsheets', 'Flowsheets'], ['io', 'Intake/Output'], ['ecg', 'ECG'], ['coverage', 'Coverage'],
];
const REVIEW = [['encounters', 'Visits'], ['ed', 'Emergency'], ['notes', 'Notes'], ['labs', 'Lab results'], ['imaging', 'Imaging'], ['card', 'Cardiology'], ['meds', 'Medications'], ['orders', 'Orders'], ['referrals', 'Referrals'], ['media', 'Documents']];
const DOC_TYPE = 'urn:hospital-desktop:doc-type';
const isMedia = (d) => (d.type?.coding || []).some((c) => c.system === DOC_TYPE && c.code === 'media') || /^(image\/|application\/pdf)/.test(d.content?.[0]?.attachment?.contentType || '');
const isAdvanceCarePlan = (d) => (d.type?.coding || []).some((c) => ['42348-3', '75320-2', '81334-5'].includes(c.code)) || /advance (care|directive)|living will/i.test(`${d.type?.text || ''} ${d.description || ''} ${d.type?.coding?.[0]?.display || ''}`);
const initials = (p) => { const n = p.name?.[0]; const a = `${(n?.given?.[0] || '')[0] || ''}${(n?.family || '')[0] || ''}`.toUpperCase(); return a || 'PT'; };
const NKA_CODE = '716186003';
const OPEN_ORDER = ['draft', 'active', 'results-received', 'report-signed'];
const OPEN_MED = ['ordered', 'pending-verification', 'active', 'on-hold'];
const hasCat = (r, code) => (r.category || []).some((c) => (c.coding || []).some((x) => x.code === code));
const byNewest = (field) => (a, b) => String(field(b) || '').localeCompare(String(field(a) || ''));
const when = (r) => r.effectiveDateTime || r.authoredOn || r.date || r.period?.start || r.recordedDate || r.sent || r.meta?.lastUpdated;
const interp = (o) => o.interpretation?.[0]?.coding?.[0]?.code || '';
const active = (r) => (r.clinicalStatus?.coding?.[0]?.code ?? 'active') === 'active';
const statusBadge = (text, kind) => badge(text, kind ?? ({ active: 'ok', final: 'ok', completed: 'ok', finished: 'ok', amended: 'ok', preliminary: 'warn', draft: 'warn', ordered: 'warn', 'pending-verification': 'warn', 'on-hold': 'warn', corrected: 'warn', revoked: '', cancelled: '', discontinued: '', rejected: 'danger' }[text] ?? 'accent'));
// Pharmacy verification as the chart shows it: one badge per order, from the extensions the pharmacy route sets.
const PH = { verified: 'urn:hospital-desktop:verified', queried: 'urn:hospital-desktop:queried', override: 'urn:hospital-desktop:emergency-override', reason: 'urn:hospital-desktop:status-reason' };
function verificationBadge(m) {
  const state = lifecycle(m);
  const id = `verification-${m.id}`;
  if (state === 'rejected') return badge(`Rejected: ${ext(m, PH.reason) || 'no reason given'}`, 'danger', id);
  if (state === 'pending-verification') {
    if (ext(m, PH.override)) return badge('Emergency override: given before verification', 'solid-danger', id);
    if (ext(m, PH.queried)) return badge(`Queried: ${ext(m, PH.queried)}`, 'accent', id);
    return badge('Awaiting pharmacy', 'warn', id);
  }
  if (state === 'ordered') return badge('Not sent to pharmacy', '', id);
  const v = ext(m, PH.verified);
  if (v) return badge(v.startsWith('migrated') ? 'Verified by migration' : `Verified by ${v.split(' at ')[0]}`, 'ok', id);
  return null;
}
const noteText = (n) => decodeText(n.content?.[0]?.attachment?.data);
// Beds: the active Encounter.location entry is where the patient is; the list is the movement record.
const ISOLATION_URL = 'urn:hospital-desktop:isolation';
const EXPECTED_URL = 'urn:hospital-desktop:expected-discharge';
const BED_REQUEST_URL = 'urn:hospital-desktop:bed-request';
const bedOf = (e) => (e?.location || []).find((l) => l.status === 'active')?.location?.display || '';
const expectedOf = (e) => (e?.extension || []).find((x) => x.url === EXPECTED_URL)?.valueDate || '';
const INPATIENT = ['IMP', 'EMER'];
const seenAdvisories = new Set();

// ---------- Advisories (non-safety, governed by friction level) ----------
async function showAdvisories(patientId, context) {
  if (view.readOnly) return;
  let list = [];
  try { list = (await api.get('/api/advisories', { patient: patientId, context })).advisories; } catch { return; }
  list = list.filter((a) => !seenAdvisories.has(`${patientId}:${a.id}`));
  if (!list.length) return;
  await new Promise((resolve) => {
    const choices = new Map(list.map((a) => [a.id, 'enact']));
    const cards = list.map((a) => {
      const seg = h('div', { class: 'seg' });
      const draw = () => seg.replaceChildren(...['enact', 'ignore'].map((c) => h('button', { type: 'button', testid: `advisory-${a.id}-${c}`, 'aria-label': `${c === 'enact' ? 'Enact' : 'Ignore'}: ${a.title}`, 'aria-pressed': String(choices.get(a.id) === c), onClick: () => { choices.set(a.id, c); draw(); } }, c === 'enact' ? 'Enact' : 'Ignore')));
      draw();
      return h('div', { class: 'advisory', testid: `advisory-${a.id}` }, h('div', { class: 'head' }, a.title), h('div', { class: 'body2' }, seg, h('span', {}, a.detail), h('span', { class: 'muted small' }, `Enact: ${a.action}`)));
    });
    const { dlg } = openDialog({ title: 'Advisories', testid: 'advisories', body: [h('p', { class: 'muted' }, 'These are reminders, not safety alerts. Choose for each, then accept.'), ...cards], actions: [{ label: 'Accept all', kind: 'primary', testid: 'advisories-accept', onClick: async (close) => {
      for (const a of list) { seenAdvisories.add(`${patientId}:${a.id}`); await api.post('/api/advisories/respond', { id: a.id, choice: choices.get(a.id), patient: patientId }); }
      close();
    } }] });
    dlg.addEventListener('close', resolve);
  });
}

// ---------- Safety alerts on new orders (always on) ----------
function duplicatePrompt(alert) {
  return new Promise((resolve) => {
    let done = false;
    const reason = field({ name: 'reason', label: 'Reason for ordering anyway', required: true, wide: true, testid: 'duplicate-reason' });
    const error = h('div', { class: 'form-error', role: 'alert' });
    const { dlg } = openDialog({ title: 'Duplicate order', testid: 'duplicate-dialog', body: [
      h('div', { class: 'banner warn', testid: 'duplicate-banner', role: 'alert' }, h('strong', {}, 'This looks like a duplicate.'), alert.message, alert.existingDate ? ` Existing order date: ${fmtDateTime(alert.existingDate)}.` : ''), reason.el, error,
    ], actions: [
      { label: 'Cancel order', testid: 'duplicate-cancel', onClick: (c) => c() },
      { label: 'Order anyway', kind: 'primary', testid: 'duplicate-order-anyway', onClick: (c) => { if (reason.get().length < 3) { error.textContent = 'Type a reason to continue.'; return; } done = true; resolve(reason.get()); c(); } },
    ] });
    dlg.addEventListener('close', () => { if (!done) resolve(null); });
  });
}

function allergyPrompt(alert) {
  return new Promise((resolve) => {
    const reason = field({ name: 'reason', label: 'Override reason (required to proceed)', required: true, wide: true, testid: 'allergy-reason' });
    const error = h('div', { class: 'form-error', role: 'alert' });
    openDialog({ title: 'Allergy conflict', testid: 'allergy-modal', danger: true, closable: false, body: [
      h('div', { class: 'banner danger', testid: 'allergy-message', role: 'alert' }, h('strong', {}, 'Do not proceed without reviewing.'), alert.message), reason.el, error,
    ], actions: [
      { label: 'Cancel order', kind: 'primary', testid: 'allergy-cancel', onClick: (c) => { resolve(null); c(); } },
      { label: 'Override and order', kind: 'danger', testid: 'allergy-override', onClick: (c) => { if (reason.get().length < 3) { error.textContent = 'An override reason is required.'; return; } resolve(reason.get()); c(); } },
    ] });
  });
}

/** Creates an order; when the server raises safety alerts, asks for each override and retries. Returns null if cancelled. */
async function createWithSafety(resource, depth = 0) {
  // CDS order-sign fires once per order before the write; cards are advisory, a cancel writes nothing.
  if (depth === 0 && ['ServiceRequest', 'MedicationRequest'].includes(resource.resourceType)) { const ok = await cdsOrderSign(resource.subject?.reference?.split('/')[1], [resource]); if (!ok) { toast('Order cancelled'); return null; } }
  try {
    return await fhir.create(resource);
  } catch (err) {
    if (!(err instanceof FhirError) || !err.alerts.length || depth > 3) throw err;
    let doc = resource;
    for (const alert of err.alerts) {
      const reason = alert.code === 'allergy-conflict' ? await allergyPrompt(alert) : await duplicatePrompt(alert);
      if (!reason) { toast('Order cancelled'); return null; }
      doc = { ...doc, extension: [...(doc.extension || []).filter((e) => e.url !== alert.overrideUrl), { url: alert.overrideUrl, valueString: reason }] };
    }
    return createWithSafety(doc, depth + 1);
  }
}

// ---------- Chart ----------
export async function renderChart({ patientId, activity, sub, query, go, render, onLoaded, shell = null }) {
  const [all, cat] = await Promise.all([fhir.everything(patientId), catalog()]);
  const p = all.find((r) => r.resourceType === 'Patient');
  if (p) await loadAges([p]);
  if (!p) throw new Error('Patient not found at this time or on this branch');
  onLoaded?.(p);
  const D = (type) => all.filter((r) => r.resourceType === type);
  const subject = { reference: `Patient/${p.id}` };
  const author = () => [{ display: identity.display }];
  const base = `#/chart/${p.id}`;
  const done = (message) => { if (message) toast(message); render(); };
  const now = () => new Date().toISOString();

  const obs = D('Observation');
  const vitals = obs.filter((o) => hasCat(o, 'vital-signs')).sort(byNewest(when));
  const labs = obs.filter((o) => hasCat(o, 'laboratory') && o.status !== 'cancelled');
  const allergies = D('AllergyIntolerance');
  const activeAllergies = allergies.filter((a) => active(a) && coding(a.code).code !== NKA_CODE);
  const nka = allergies.some((a) => active(a) && coding(a.code).code === NKA_CODE);
  const meds = D('MedicationRequest').sort(byNewest(when));
  const problems = D('Condition').sort(byNewest(when));
  const orders = D('ServiceRequest').sort(byNewest(when));
  const notes = D('DocumentReference').filter((n) => !(n.type?.coding || []).some((c) => c.system === 'urn:hospital-desktop:doc-type' && ['transcript', 'ai-summary', 'media'].includes(c.code)) && !isMedia(n)).sort(byNewest(when));
  const media = D('DocumentReference').filter(isMedia).sort(byNewest(when));
  // In-place AI drafts for this patient (task 9.1): pending proposals, shown where the clinician works. Shown-events are logged once per draft per page view.
  // Records an agent wrote or that came from an accepted AI proposal: each carries "Report a problem".
  const agentTouched = new Set((await api.get('/api/surveillance/touched', { patient: patientId }).catch(() => ({ refs: [] }))).refs);
  const drafts = view.readOnly ? [] : (await loadProposals({ status: 'pending' })).filter((d) => d.patient === `Patient/${patientId}` || d.subject === `Patient/${patientId}`);
  const shownOnce = new Set();
  const markShown = (d) => { if (shownOnce.has(d.id)) return; shownOnce.add(d.id); draftEvent(d.id, 'shown', { branch: view.branch }); };
  const settings = drafts.length ? await draftSettings() : {};
  const discard = async (d, title) => { const out = await discardDraft(d, { title, askWhy: Boolean(settings.askWhyAfterOverride) }); if (out) done('Draft discarded'); };
  const aiSummaries = D('DocumentReference').filter((n) => (n.type?.coding || []).some((c) => c.code === 'ai-summary')).sort(byNewest(when));
  const encounters = D('Encounter').sort(byNewest(when));
  const criticalOpen = labs.filter((o) => flagged(o, 'critical-unacknowledged'));
  const latestVital = (code) => vitals.find((o) => coding(o.code).code === code);
  const vq = (o) => (o ? `${o.valueQuantity?.value} ${o.valueQuantity?.unit || ''}` : '—');

  // ----- Sidebar -----
  const name = p.name?.[0] || {};
  const currentEncounter = encounters.find((e) => ['arrived', 'in-progress'].includes(e.status));
  const coverageList = D('Coverage').filter((c) => c.status !== 'cancelled' && (!c.period?.end || c.period.end >= fmtDate(new Date())));
  // Coverage comes from the chart (FHIR Coverage); when the chart has none, the insurance desk's record is used.
  const memberRow = coverageList.length ? null : (await api.get(`/api/ins/coverage/${p.id}`).catch(() => ({ card: { coverage: [] } }))).card.coverage.map((k) => ({ memberNumber: k.memberId, start: k.start, planName: k.planName }))[0] || null;
  const member = memberRow ? { memberNumber: memberRow.memberNumber, start: memberRow.start, plan: { name: memberRow.planName } } : null;
  const coverageText = coverageList.length ? (coverageList[0].class?.[0]?.name || coverageList[0].type?.text || display(coverageList[0].type) || coverageList[0].payor?.[0]?.display || 'On file') : member?.plan?.name || null;
  const acp = D('DocumentReference').filter((d) => isAdvanceCarePlan(d) && lifecycle(d) !== 'entered-in-error');
  const activeMeds = meds.filter((m) => lifecycle(m) === 'active');
  const srow = (label, value, testid) => h('div', { class: 'row' }, h('span', { class: 'muted' }, label), h('span', { testid }, value));
  const sidebar = h('aside', { class: 'sidebar', testid: 'patient-sidebar', 'aria-label': 'Patient' },
    h('div', { class: 'avatar', 'aria-hidden': 'true', testid: 'patient-avatar' }, 'PT'), // patients are known by number: no initials
    h('div', { class: 'pname', testid: 'patient-name' }, patientName(p)),
    h('div', { class: 'muted', testid: 'patient-demographics' }, [p.gender ? p.gender[0].toUpperCase() + p.gender.slice(1) : null, age(p), shownBirthDate(p)].filter(Boolean).join(', ') || 'No demographics on file'),
    h('div', { class: 'mono' }, 'MRN: ', h('span', { testid: 'patient-mrn' }, mrn(p) || 'Not on file')),
    h('div', { class: `acp${acp.length ? ' on' : ''}`, testid: 'patient-acp', role: 'status' }, 'Advance care plan: ', acp.length ? h('a', { href: `${base}/review/notes?id=${acp[0].id}`, 'aria-label': 'Open the advance care plan' }, `on file (${fmtDate(when(acp[0]))})`) : 'not on file'),
    h('div', { class: 'badges' },
      activeAllergies.length ? badge(`${activeAllergies.length} allerg${activeAllergies.length === 1 ? 'y' : 'ies'}`, 'danger', 'badge-allergies') : nka ? badge('NKA', 'ok', 'badge-nka') : badge('Allergies not recorded', '', 'badge-allergies-unknown'),
      criticalOpen.length ? badge(`${criticalOpen.length} critical`, 'solid-danger', 'badge-patient-critical') : null),
    h('section', {}, srow('Primary coverage', coverageText || 'None on file', 'patient-coverage')),
    h('section', { testid: 'patient-allergies' }, h('h3', {}, 'Allergies'), activeAllergies.length ? activeAllergies.map((a) => h('div', {}, display(a.code), a.criticality === 'high' ? ' (high)' : '')) : h('div', { class: 'muted' }, nka ? 'No known allergies' : 'Not on File')),
    h('section', {}, srow('Current meds', String(activeMeds.length), 'patient-meds-count')),
    h('section', {}, h('h3', {}, 'Encounter'), currentEncounter ? [h('div', {}, `${display(currentEncounter.class) || currentEncounter.class?.code} · ${currentEncounter.status}`), h('div', { class: 'muted' }, currentEncounter.participant?.[0]?.individual?.display || '')] : h('div', { class: 'muted' }, 'No open encounter'),
      h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Bed'), h('span', { testid: 'patient-bed' }, bedOf(currentEncounter) || 'No bed')),
      ext(currentEncounter || {}, ISOLATION_URL) ? h('div', { class: 'badges' }, badge(`Isolation: ${ext(currentEncounter, ISOLATION_URL)}`, 'danger', 'badge-isolation')) : null,
      expectedOf(currentEncounter) ? h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Expected discharge'), h('span', { testid: 'patient-expected-discharge' }, expectedOf(currentEncounter))) : null),
    h('section', { testid: 'patient-measurements' }, srow('Ht', vq(latestVital('8302-2')), 'patient-height'), srow('Last Wt', vq(latestVital('29463-7')), 'patient-weight'), srow('BMI', vq(latestVital('39156-5')), 'patient-bmi')),
    h('section', {}, h('h3', {}, 'Activity'),
      h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Open orders'), h('span', {}, orders.filter((o) => OPEN_ORDER.includes(lifecycle(o))).length)),
      h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Results, last 36 h'), h('span', {}, labs.filter((o) => Date.now() - new Date(when(o)) < 36 * 3600000).length))),
  );

  // ----- Tab bar with time travel -----
  const withSeconds = (d) => `${toLocalInput(d)}:${String(d.getSeconds()).padStart(2, '0')}`;
  const asOfInput = h('input', { type: 'datetime-local', step: 1, testid: 'time-travel-input', 'aria-label': 'View as of', style: 'width:auto;height:1.875rem', value: view.asOf ? withSeconds(new Date(view.asOf)) : '', max: withSeconds(new Date()), onChange: (e) => view.set({ asOf: e.target.value ? new Date(e.target.value).toISOString() : null }) });
  const visible = visibleChartTabs(CHART_TABS.map(([id]) => id));
  const tabs = h('div', { class: 'tabs', role: 'navigation', 'aria-label': 'Chart tabs' },
    visible.map((id) => CHART_TABS.find(([t]) => t === id)).map(([id, label]) => h('a', { href: `${base}/${id}`, testid: `chart-tab-${id}`, 'aria-label': label, 'aria-current': activity === id ? 'page' : undefined }, label)),
    h('div', { class: 'timetravel', testid: 'time-travel' }, h('span', {}, 'View as of:'), asOfInput, view.asOf ? btn('Back to live', { small: true, testid: 'time-travel-live', onClick: () => view.set({ asOf: null }) }) : h('span', { class: 'muted' }, 'live')));

  // ----- Shared pieces -----
  const lifecycleActions = (r, map) => (map[lifecycle(r)] || []).map(([to, label, needsReason]) => btn(label, { small: true, write: true, perm: [r.resourceType, 'transition'], kind: ['cancelled', 'revoked', 'discontinued'].includes(to) ? 'danger' : '', testid: `${slug(label)}-${r.id}`, onClick: async () => {
    let reason;
    if (needsReason) { reason = await askReason({ title: `${label}: ${display(r.medicationCodeableConcept || r.code) || r.resourceType}`, submitLabel: label }); if (!reason) return; }
    await fhir.transition(r, to, reason); done(`${label}: done`);
  } }));
  const releaseButton = (r) => (flagged(r, 'released')
    ? btn('Hide from the Patient Portal', { small: true, write: true, perm: [r.resourceType, '$release'], testid: `hide-${r.id}`, onClick: async () => { await fhir.release(r, false); done('Hidden from the Patient Portal'); } })
    : btn('Release to the Patient Portal', { small: true, write: true, perm: [r.resourceType, '$release'], testid: `release-${r.id}`, onClick: async () => { await fhir.release(r, true); done('Released to the Patient Portal'); } }));
  const vitalsGrid = () => h('div', { class: 'vitals-grid', testid: 'latest-vitals' }, cat.vitals.map((v) => { const o = latestVital(v.code); return h('div', { class: 'v', testid: `vital-${v.key}` }, h('span', { class: 'muted small' }, v.name), h('b', { style: o && ['H', 'L'].includes(interp(o)) ? 'color:var(--danger)' : '' }, o ? o.valueQuantity.value : '—'), h('span', { class: 'muted small' }, o ? `${v.unit} · ${fmtDateTime(when(o))}` : v.unit)); }));

  // ----- Nurse tabs, built in /ehr/nursing.js -----
  const nurseView = visible.includes('worklist');
  const nursing = nursingTabs({ p, cat, done, base, go, query, all, currentEncounter });
  const ecg = ecgTab({ p, base, go, query, done, shell });

  // ----- Summary -----
  function summary() {
    return h('div', { class: 'grid3' },
      h('div', { class: 'stack' },
        card('Demographics', kv([['Name', patientName(p)], ['MRN', h('span', { class: 'mono' }, mrn(p))], ['Born', p.birthDate ? h('span', {}, bornSpan(p), age(p) ? ` (${age(p)})` : '') : 'Not on file'], ['Sex', p.gender], ['Phone', p.telecom?.[0]?.value], ['Address', p.address?.[0]?.text]])),
        card('Recent encounters', encounters.length ? encounters.slice(0, 5).map((e) => h('div', {}, h('a', { href: `${base}/encounters` }, `${fmtDate(when(e))} · ${display(e.class) || e.class?.code}`), ' ', statusBadge(e.status))) : h('p', { class: 'muted' }, 'No encounters'))),
      h('div', { class: 'stack' },
        (() => {
          // The Chart Summariser's card (chart-summary): read-only, cites its records, thumbs only.
          const d = drafts.find((x) => x.kind === 'summary');
          const s = aiSummaries[0] || null;
          if (!d && !s) return null;
          const text = d ? d.content.text : decodeText(s.content?.[0]?.attachment?.data);
          const cites = d ? d.content.cites || [] : (s.context?.related || []).map((r) => r.reference);
          if (d) markShown(d);
          return h('section', { class: 'card draft ai-summary-card', testid: 'ai-summary-card', 'aria-label': 'AI chart summary, not clinical advice' }, d ? draftHead(d, 'AI summary') : h('div', { class: 'p-head' }, h('span', { class: 'p-mark' }, 'AI summary')),
            h('div', { class: 'ai-summary', testid: 'ai-summary-text' }, text), h('div', { class: 'cites', 'aria-label': 'Records the summary used' }, ...cites.slice(0, 12).map((c) => h('span', { testid: 'ai-summary-cite' }, c))));
        })(),
        card('Latest vitals', vitalsGrid()),
        visible.includes('mar') || nurseView ? nursing.nursingSummary() : null,
        card('Active problems', problems.filter(active).length ? problems.filter(active).map((c) => h('div', {}, display(c.code), ' ', h('span', { class: 'mono muted' }, coding(c.code).code))) : h('p', { class: 'muted' }, 'No active problems'))),
      h('div', { class: 'stack' },
        card('Allergies', activeAllergies.length ? activeAllergies.map((a) => h('div', {}, display(a.code), ' ', badge(a.criticality || 'unknown', a.criticality === 'high' ? 'danger' : ''), h('span', { class: 'muted' }, ` ${a.reaction?.[0]?.manifestation?.map(display).join(', ') || ''}`))) : h('p', { class: 'muted' }, nka ? 'No known allergies' : 'Not recorded')),
        card('Current medications', meds.filter((m) => OPEN_MED.includes(lifecycle(m))).length ? meds.filter((m) => OPEN_MED.includes(lifecycle(m))).map((m) => h('div', {}, h('strong', {}, display(m.medicationCodeableConcept)), ' ', statusBadge(lifecycle(m)), h('div', { class: 'muted small' }, m.dosageInstruction?.[0]?.text || ''))) : h('p', { class: 'muted' }, 'No current medications')),
        card('Recent notes', notes.length ? notes.slice(0, 5).map((n) => h('div', {}, h('a', { href: `${base}/review/notes?id=${n.id}` }, `${fmtDate(when(n))} · ${display(n.type)}`), ' ', statusBadge(lifecycle(n)))) : h('p', { class: 'muted' }, 'No notes'))));
  }

  // ----- Problems -----
  function problemsTab() {
    const SEVERITY = { mild: '255604002', moderate: '6736007', severe: '24484000' };
    const add = () => formDialog({ title: 'Add problem', testid: 'problem-form', submitLabel: 'Add problem', fields: [
      { name: 'problem', label: 'Problem (ICD-10-CM)', required: true, wide: true, list: cat.problems.map((x) => `${x.code} ${x.name}`), placeholder: 'Type a code or name' },
      { name: 'onset', label: 'Onset date', type: 'date', max: fmtDate(new Date()) }, { name: 'severity', label: 'Severity', type: 'select', options: ['mild', 'moderate', 'severe'], value: 'moderate' },
      { name: 'verification', label: 'Verification', type: 'select', options: ['confirmed', 'provisional', 'differential'] },
    ], onSubmit: async (v) => {
      const item = cat.problems.find((x) => `${x.code} ${x.name}` === v.problem);
      if (!item) throw new Error('Choose a problem from the list. Free text is not accepted for coded fields.');
      await fhir.create({ resourceType: 'Condition', subject, recordedDate: now(), onsetDateTime: v.onset || undefined,
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' }] }],
        clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
        verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: v.verification }] },
        severity: { coding: [{ system: cat.systems.snomed, code: SEVERITY[v.severity], display: v.severity }] },
        code: { coding: [{ system: cat.systems.icd10, code: item.code, display: item.name }, { system: cat.systems.snomed, code: item.snomed, display: item.name }] } });
      done('Problem added');
    } });
    const setStatus = (c, code) => btn(code === 'resolved' ? 'Resolve' : 'Inactivate', { small: true, write: true, perm: ['Condition', 'update'], testid: `problem-${code}-${c.id}`, onClick: async () => {
      await fhir.update({ ...c, clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code }] }, ...(code === 'resolved' ? { abatementDateTime: now() } : {}) }); done(`Problem ${code}`);
    } });
    return [h('div', { class: 'toolbar' }, h('h2', { class: 'grow' }, 'Problem list'), btn('Add problem', { kind: 'primary', write: true, perm: ['Condition', 'create'], testid: 'problem-add', onClick: add })),
      table({ testid: 'problems-table', rows: problems, empty: 'No data to display', columns: [
        { label: 'Problem', render: (c) => display(c.code) }, { label: 'ICD-10-CM', cls: 'mono', render: (c) => c.code?.coding?.find((x) => x.system === cat.systems.icd10)?.code || '' },
        { label: 'SNOMED CT', cls: 'mono', render: (c) => c.code?.coding?.find((x) => x.system === cat.systems.snomed)?.code || '' },
        { label: 'Onset', render: (c) => fmtDate(c.onsetDateTime) }, { label: 'Severity', render: (c) => display(c.severity) },
        { label: 'Status', render: (c) => statusBadge(coding(c.clinicalStatus).code || 'active') }, { label: 'Verification', render: (c) => coding(c.verificationStatus).code || '' },
        { label: '', cls: 'actions', render: (c) => (active(c) ? [setStatus(c, 'resolved'), setStatus(c, 'inactive')] : '') },
      ] })];
  }

  // ----- Allergies -----
  function allergiesTab() {
    const allergens = [
      ...cat.medications.map((m) => ({ label: `${m.name} (medication)`, coding: { system: cat.systems.rxnorm, code: m.code, display: m.name }, category: 'medication' })),
      ...Object.entries(cat.drugClasses).map(([code, name]) => ({ label: `${name} (drug class)`, coding: { system: cat.systems.drugClass, code, display: name }, category: 'medication' })),
      ...cat.otherAllergens.map((o) => ({ label: `${o.name} (${o.category})`, coding: { system: o.system, code: o.code, display: o.name }, category: o.category })),
    ];
    const status = (code) => ({ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code }] });
    const add = () => formDialog({ title: 'Add allergy', testid: 'allergy-form', submitLabel: 'Add allergy', fields: [
      { name: 'allergen', label: 'Allergen', required: true, wide: true, list: allergens.map((a) => a.label), placeholder: 'Type to search' },
      { name: 'type', label: 'Type', type: 'select', options: ['allergy', 'intolerance'] }, { name: 'criticality', label: 'Criticality', type: 'select', options: ['low', 'high', 'unable-to-assess'], value: 'high' },
      { name: 'reaction', label: 'Reaction (SNOMED CT)', type: 'select', options: cat.reactions.map((r) => [r.code, r.name]) }, { name: 'severity', label: 'Reaction severity', type: 'select', options: ['mild', 'moderate', 'severe'], value: 'moderate' },
    ], onSubmit: async (v) => {
      const a = allergens.find((x) => x.label === v.allergen);
      if (!a) throw new Error('Choose an allergen from the list. Free text is not accepted for coded fields.');
      const reaction = cat.reactions.find((r) => r.code === v.reaction);
      for (const old of allergies.filter((x) => active(x) && coding(x.code).code === NKA_CODE)) await fhir.update({ ...old, clinicalStatus: status('inactive') });
      await fhir.create({ resourceType: 'AllergyIntolerance', patient: subject, recordedDate: now(), clinicalStatus: status('active'),
        verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'confirmed' }] },
        type: v.type, category: [a.category], criticality: v.criticality, code: { coding: [a.coding] },
        reaction: [{ manifestation: [{ coding: [{ system: cat.systems.snomed, code: reaction.code, display: reaction.name }] }], severity: v.severity }] });
      done('Allergy added');
    } });
    return [h('div', { class: 'toolbar' }, h('h2', { class: 'grow' }, 'Allergies and intolerances'),
      !activeAllergies.length && !nka ? btn('Mark no known allergies', { write: true, perm: ['AllergyIntolerance', 'create'], testid: 'allergy-nka', onClick: async () => { await fhir.create({ resourceType: 'AllergyIntolerance', patient: subject, recordedDate: now(), clinicalStatus: status('active'), code: { coding: [cat.noKnownAllergy] } }); done('Recorded: no known allergies'); } }) : null,
      btn('Add allergy', { kind: 'primary', write: true, perm: ['AllergyIntolerance', 'create'], testid: 'allergy-add', onClick: add })),
    table({ testid: 'allergies-table', rows: allergies, empty: 'No data to display', columns: [
      { label: 'Allergen', render: (a) => display(a.code) }, { label: 'Type', render: (a) => a.type || '' }, { label: 'Category', render: (a) => (a.category || []).join(', ') },
      { label: 'Criticality', render: (a) => (a.criticality ? badge(a.criticality, a.criticality === 'high' ? 'danger' : '') : '') },
      { label: 'Reaction', render: (a) => (a.reaction || []).map((r) => `${r.manifestation?.map(display).join(', ')} (${r.severity || ''})`).join('; ') },
      { label: 'Recorded', render: (a) => fmtDate(a.recordedDate) }, { label: 'Status', render: (a) => statusBadge(coding(a.clinicalStatus).code || 'active') },
      { label: '', cls: 'actions', render: (a) => (active(a) ? btn('Inactivate', { small: true, write: true, perm: ['AllergyIntolerance', 'update'], testid: `allergy-inactivate-${a.id}`, onClick: async () => { await fhir.update({ ...a, clinicalStatus: status('inactive') }); done('Allergy inactivated'); } }) : '') },
    ] })];
  }

  // ----- Medications -----
  // Part A.3: an order becomes active only through pharmacy verification, so there is no "Sign" here; the prescriber sends it to pharmacy.
  const MED_ACTIONS = {
    ordered: [['pending-verification', 'Send to pharmacy'], ['cancelled', 'Cancel', true]],
    'pending-verification': [['cancelled', 'Cancel', true]],
    active: [['on-hold', 'Hold'], ['completed', 'Complete', true], ['discontinued', 'Stop', true]],
    'on-hold': [['active', 'Resume'], ['discontinued', 'Stop', true]],
  };
  // The prescriber's side of pharmacy verification: answer a query; a physician or nurse may record an emergency override on a STAT order.
  const answerQuery = (m) => btn('Answer pharmacy', { small: true, kind: 'primary', write: true, perm: ['Communication', 'create'], testid: `answer-${m.id}`, onClick: () => formDialog({
    title: `Answer pharmacy about ${display(m.medicationCodeableConcept)}`, testid: 'answer-form', submitLabel: 'Send answer', intro: `Pharmacy asked: "${ext(m, PH.queried)}"`,
    fields: [{ name: 'message', label: 'Your answer', type: 'textarea', rows: 3, required: true, wide: true, testid: 'answer-message' }],
    onSubmit: async (v) => { if (v.message.length < 3) throw new Error('Type an answer'); await api.post(`/api/pharmacy/orders/${m.id}/answer`, { message: v.message }); done('Answer sent to pharmacy'); },
  }) });
  const canOverride = canWrite('MedicationAdministration', 'create') || canWrite('MedicationRequest', 'create');
  const overrideButton = (m) => btn('Emergency override', { small: true, kind: 'danger', write: true, testid: `override-${m.id}`, disabled: !canOverride, title: canOverride ? 'Give this STAT dose before pharmacy verification (logged, reason required)' : 'Only a nurse or physician may record an emergency override', onClick: async () => {
    const reason = await askReason({ title: `Emergency override: ${display(m.medicationCodeableConcept)}`, intro: 'The dose is given before pharmacy verification. This is logged as a safety override and the pharmacist reviews the order afterwards.', label: 'Reason (required)', submitLabel: 'Record override', testid: 'override-reason' });
    if (!reason) return;
    await api.post(`/api/pharmacy/orders/${m.id}/emergency-override`, { reason }); done('Emergency override recorded; pharmacy will review the order');
  } });
  const medActions = (m) => [...lifecycleActions(m, MED_ACTIONS), lifecycle(m) === 'pending-verification' && ext(m, PH.queried) ? answerQuery(m) : null, lifecycle(m) === 'pending-verification' && m.priority === 'stat' && !ext(m, PH.override) ? overrideButton(m) : null];
  const medStatus = (m) => [statusBadge(lifecycle(m)), ' ', verificationBadge(m), ext(m, 'urn:hospital-desktop:status-reason') && lifecycle(m) !== 'rejected' ? h('div', { class: 'muted small' }, ext(m, 'urn:hospital-desktop:status-reason')) : null, ext(m, 'urn:hospital-desktop:allergy-override-reason') ? h('div', { class: 'small', style: 'color:var(--danger)' }, `Allergy override: ${ext(m, 'urn:hospital-desktop:allergy-override-reason')}`) : null];
  const medTable = (rows, testid) => table({ testid, rows, empty: 'No data to display', columns: [
    { label: 'Medication', render: (m) => [h('strong', {}, display(m.medicationCodeableConcept)), ' ', h('span', { class: 'mono muted' }, coding(m.medicationCodeableConcept).code || ''), m.priority && m.priority !== 'routine' ? [' ', badge(m.priority.toUpperCase(), m.priority === 'stat' ? 'solid-danger' : 'warn')] : null] },
    { label: 'Sig', render: (m) => m.dosageInstruction?.[0]?.text || '' }, { label: 'Ordered', render: (m) => fmtDateTime(m.authoredOn) }, { label: 'By', render: (m) => m.requester?.display || '' },
    { label: 'Status', render: medStatus },
    { label: '', cls: 'actions', render: medActions },
  ] });
  const medCard = (m) => h('div', { class: 'card', testid: `med-order-${m.id}` }, h('div', { class: 'toolbar', style: 'margin:0' },
    h('div', { class: 'grow' }, h('strong', {}, display(m.medicationCodeableConcept)), ' ', badge((m.priority || 'routine').toUpperCase(), m.priority === 'stat' ? 'solid-danger' : m.priority === 'urgent' ? 'warn' : 'info'), ' ', medStatus(m),
      h('div', { class: 'muted small' }, `${m.dosageInstruction?.[0]?.text || ''} · Ordered ${fmtDateTime(m.authoredOn)} by ${m.requester?.display || ''}`)),
    medActions(m)));
  // Fields a nurse fills when entering an order on a physician's behalf (verbal, telephone or protocol). The server marks it as waiting for co-signature.
  const ORDER_MODES = [['verbal', 'Verbal order'], ['telephone', 'Telephone order'], ['protocol', 'Protocol order']];
  const byModeFields = (prefix) => [
    { name: 'mode', label: 'Order mode', type: 'select', options: ORDER_MODES, testid: `${prefix}-mode` },
    { name: 'physician', label: 'Ordering physician', required: true, testid: `${prefix}-physician` },
  ];
  const byModeExtras = (v) => ({ requester: { display: v.physician }, extension: [{ url: 'urn:hospital-desktop:order-mode', valueCode: v.mode }, { url: 'urn:hospital-desktop:entered-by', valueString: identity.display }] });
  const prescribe = async (byMode = false) => {
      await showAdvisories(p.id, 'prescribe');
      const sig = (v, m) => (m && v.dose ? `${v.dose} ${v.unit} ${cat.routes[v.route] || v.route} ${cat.frequencies[v.frequency] || v.frequency}${v.prn ? ' as needed' : ''}` : '');
      const find = (label) => cat.medications.find((m) => `${m.name} (RxNorm ${m.code})` === label);
      let last = null;
      formDialog({ title: byMode ? 'Enter a medication order for co-signature' : 'Prescribe medication', testid: 'prescribe-form', submitLabel: byMode ? 'Enter order' : 'Place order',
        intro: byMode ? 'A verbal, telephone or protocol order goes to the pharmacy verification queue at once and waits in the ordering physician\'s Inbox for a co-signature.' : undefined, fields: [
        ...(byMode ? byModeFields('prescribe') : []),
        { name: 'medication', label: 'Medication (RxNorm)', required: true, wide: true, list: cat.medications.map((m) => `${m.name} (RxNorm ${m.code})`), placeholder: 'Type to search the formulary' },
        { name: 'dose', label: 'Dose', type: 'number', step: 'any', min: 0, required: true }, { name: 'unit', label: 'Unit', type: 'select', options: ['mg', 'g', 'mcg', 'units', 'mEq', 'tablet', 'puffs', 'mL'] },
        { name: 'route', label: 'Route', type: 'select', options: Object.keys(cat.routes) }, { name: 'frequency', label: 'Frequency', type: 'select', options: Object.entries(cat.frequencies).map(([k, t]) => [k, `${k} (${t})`]) },
        { name: 'prn', label: 'As needed (PRN)', type: 'checkbox' }, { name: 'priority', label: 'Priority', type: 'select', value: 'routine', options: [['routine', 'Routine'], ['urgent', 'Urgent'], ['stat', 'STAT']], testid: 'prescribe-priority' },
        { name: 'sig', label: 'Sig (generated)', wide: true, readonly: true },
      ], onChange: (v, c) => {
        const m = find(v.medication);
        if (m && m !== last) { last = m; c.dose.set(m.dose); c.unit.set(m.unit); c.route.set(m.route); c.frequency.set(m.frequency); v = { ...v, dose: m.dose, unit: m.unit, route: m.route, frequency: m.frequency }; }
        c.sig.set(sig(v, m));
      }, onSubmit: async (v) => {
        const m = find(v.medication);
        if (!m) throw new Error('Choose a medication from the formulary list. Free text is not accepted.');
        // Created straight into pending-verification: pharmacy verifies before the order is active.
        const byModeExtra = byMode ? byModeExtras(v) : {};
        const created = await createWithSafety({ resourceType: 'MedicationRequest', status: 'draft', intent: 'order', subject, authoredOn: now(), requester: { display: identity.display }, priority: v.priority || 'routine',
          ...byModeExtra, extension: [...(byModeExtra.extension || []), { url: 'urn:hospital-desktop:lifecycle', valueCode: 'pending-verification' }],
          ...(currentEncounter ? { encounter: { reference: `Encounter/${currentEncounter.id}` } } : {}),
          medicationCodeableConcept: { coding: [{ system: cat.systems.rxnorm, code: m.code, display: m.name }] },
          dosageInstruction: [{ text: sig(v, m), asNeededBoolean: v.prn, timing: { code: { text: v.frequency } }, route: { text: v.route }, doseAndRate: [{ doseQuantity: { value: v.dose, unit: v.unit } }] }] });
        if (created) done(byMode ? `${m.name} entered as a ${v.mode} order. It waits for pharmacy verification and ${v.physician}'s co-signature.` : `${m.name} ordered. It is now in the pharmacy verification queue.`);
      } });
  };
  const prescribeButtons = () => [
    orderModeRequired('MedicationRequest') ? btn('Enter verbal or protocol medication order', { write: true, testid: 'prescribe-by-mode', onClick: () => prescribe(true) }) : null,
    btn('Prescribe', { kind: 'primary', write: true, perm: ['MedicationRequest', 'create'], testid: 'prescribe', onClick: () => prescribe(false) }),
  ];
  function medicationsTab() {
    const current = meds.filter((m) => OPEN_MED.includes(lifecycle(m)));
    return [h('div', { class: 'toolbar' }, h('h2', { class: 'grow' }, 'Medications'), prescribeButtons()),
      h('h3', {}, 'Current'), medTable(current, 'medications-current'), h('h3', { style: 'margin-top:1.25rem' }, 'Past'), medTable(meds.filter((m) => !OPEN_MED.includes(lifecycle(m))), 'medications-past')];
  }

  // ----- Vitals -----
  function vitalsTab() {
    const record = () => {
      const inputs = cat.vitals.filter((v) => v.key !== 'bmi');
      formDialog({ title: 'Record vitals', testid: 'vitals-form', submitLabel: 'Save vitals', fields: [
        ...inputs.map((v) => ({ name: v.key, label: `${v.name} (${v.unit})`, type: 'number', step: 'any', min: 0 })),
        { name: 'bmi', label: 'BMI (calculated)', readonly: true }, { name: 'at', label: 'Measured at', type: 'datetime-local', value: toLocalInput(), max: toLocalInput(), required: true },
      ], onChange: (v, c, extra) => {
        c.bmi.set(v.height && v.weight ? (v.weight / ((v.height / 100) ** 2)).toFixed(1) : '');
        const flags = inputs.filter((x) => v[x.key] != null && ((x.low != null && v[x.key] < x.low) || (x.high != null && v[x.key] > x.high)));
        extra.replaceChildren(flags.length ? h('div', { class: 'banner warn', testid: 'vitals-flags' }, `Outside the usual range: ${flags.map((x) => x.name).join(', ')}`) : '');
      }, onSubmit: async (v) => {
        const at = new Date(v.at).toISOString();
        const resources = inputs.filter((x) => v[x.key] != null).map((x) => ({ resourceType: 'Observation', status: 'final', subject, effectiveDateTime: at, performer: author(),
          ...(currentEncounter ? { encounter: { reference: `Encounter/${currentEncounter.id}` } } : {}),
          category: [{ coding: [{ system: cat.systems.obsCategory, code: 'vital-signs' }] }], code: { coding: [{ system: cat.systems.loinc, code: x.code, display: x.name }] },
          valueQuantity: { value: v[x.key], unit: x.unit, system: 'http://unitsofmeasure.org', code: x.unit } }));
        if (!resources.length) throw new Error('Enter at least one value');
        await fhir.transaction(resources);
        done('Vitals saved');
      } });
    };
    const times = [...new Set(vitals.map((o) => when(o)))].sort().reverse().slice(0, 12).reverse();
    const cell = (v, t) => { const o = vitals.find((x) => coding(x.code).code === v.code && when(x) === t); return h('td', { class: `cell ${o ? interp(o) : ''}`.trim(), style: 'cursor:default' }, o ? o.valueQuantity.value : ''); };
    const flow = times.length ? h('div', { class: 'tablewrap' }, h('table', { class: 'flow', testid: 'vitals-flowsheet' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Vital'), times.map((t, i) => { const set = vitals.filter((o) => when(o) === t); const out = set.every((o) => flagged(o, 'released'));
        return h('th', { class: 'num' }, fmtDateTime(t), h('div', {}, out ? badge('In Patient Portal', 'accent') : null, ' ', btn(out ? 'Hide' : 'Release', { small: true, write: true, perm: ['Observation', '$release'], testid: `vitals-${out ? 'hide' : 'release'}-${times.length - 1 - i}`, title: `${out ? 'Hide this set from' : 'Release this set to'} the portal`, onClick: async () => { for (const o of set) if (flagged(o, 'released') === out) await fhir.release(o, !out); done(out ? 'Vitals hidden from the Patient Portal' : 'Vitals released to the Patient Portal'); } }))); }))),
      h('tbody', {}, cat.vitals.map((v) => h('tr', { testid: `flow-${v.key}` }, h('th', { class: 'rowlabel' }, `${v.name} `, h('span', { class: 'muted small' }, v.unit)), times.map((t) => cell(v, t))))))) : h('div', { class: 'card empty', testid: 'vitals-empty' }, 'No vitals recorded');
    return [h('div', { class: 'toolbar' }, h('h2', { class: 'grow' }, 'Vitals'), h('span', { class: 'muted small' }, times.length ? `Showing the last ${times.length} sets` : ''), btn('Record vitals', { kind: 'primary', write: true, perm: ['Observation', 'create'], testid: 'vitals-record', onClick: record })), card('Latest', vitalsGrid()), h('div', { style: 'height:1rem' }), flow];
  }

  // ----- Notes -----
  const SOAP = 'Subjective:\n\n\nObjective:\n\n\nAssessment:\n\n\nPlan:\n';
  function noteDialog({ note, parent, template } = {}) {
    const noteTypes = nurseView ? cat.noteTypes.filter((t) => t.nursing) : cat.noteTypes;
    formDialog({ title: parent ? 'Addendum' : note ? 'Edit draft note' : 'New note', testid: 'note-form', wide: true, submitLabel: 'Save draft',
      intro: parent ? `Addendum to ${display(parent.type)} of ${fmtDateTime(when(parent))}. The signed note itself cannot be changed.` : null,
      fields: [
        parent ? null : { name: 'type', label: 'Note type (LOINC)', type: 'select', options: noteTypes.map((t) => [t.code, `${t.name} (${t.code})`]), value: note ? coding(note.type).code : template === 'sbar' || nurseView ? '34746-8' : '11506-3' },
        parent ? null : { name: 'title', label: 'Title', value: note?.description || (template === 'sbar' ? 'Shift handover' : '') },
        { name: 'text', label: 'Note', type: 'textarea', rows: 16, required: true, dictate: true, value: note ? noteText(note) : parent ? '' : template === 'sbar' ? SBAR : SOAP },
      ], onSubmit: async (v) => {
        const type = cat.noteTypes.find((t) => t.code === (parent ? coding(parent.type).code : v.type));
        const body = { ...(note || { resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', subject, date: now(), author: author() }),
          type: { coding: [{ system: cat.systems.loinc, code: type.code, display: type.name }] }, description: parent ? `Addendum: ${parent.description || display(parent.type)}` : (v.title || type.name),
          ...(currentEncounter && !note ? { context: { encounter: [{ reference: `Encounter/${currentEncounter.id}` }] } } : {}),
          ...(parent ? { relatesTo: [{ code: 'appends', target: { reference: `DocumentReference/${parent.id}` } }] } : {}),
          content: [{ attachment: { contentType: 'text/plain', data: encodeText(v.text) } }] };
        if (note) await fhir.update(body); else await fhir.create(body);
        done('Draft saved. Sign it to finalise.');
      } });
  }
  const signNote = async (n) => {
    await showAdvisories(p.id, 'sign-note');
    if (!await confirmDialog({ title: 'Sign note', message: 'Signing finalises this note. After signing it cannot be edited, only addended.', confirmLabel: 'Sign note', testid: 'sign-note' })) return;
    await fhir.transition(n, 'final'); done('Note signed');
  };
  const noteActions = (n) => [
    lifecycle(n) === 'preliminary' ? btn('Edit', { small: true, write: true, perm: ['DocumentReference', 'update'], testid: `note-edit-${n.id}`, onClick: () => noteDialog({ note: n }) }) : null,
    lifecycle(n) === 'preliminary' ? btn('Sign', { small: true, write: true, perm: ['DocumentReference', 'sign'], kind: 'primary', testid: `note-sign-${n.id}`, onClick: () => signNote(n) }) : null,
    ['final', 'amended'].includes(lifecycle(n)) ? btn('Addendum', { small: true, write: true, perm: ['DocumentReference', 'create'], testid: `note-addendum-${n.id}`, onClick: () => noteDialog({ parent: n }) }) : null,
    ['final', 'amended'].includes(lifecycle(n)) ? releaseButton(n) : null,
  ];
  const noteReader = (n) => (n ? h('div', { class: 'card', testid: 'note-reader' },
    h('div', { class: 'toolbar' }, h('h2', { class: 'grow' }, n.description || display(n.type)), statusBadge(lifecycle(n) === 'preliminary' ? 'draft' : lifecycle(n) === 'final' ? 'signed' : lifecycle(n), lifecycle(n) === 'preliminary' ? 'warn' : 'ok'), flagged(n, 'released') ? badge('In Patient Portal', 'accent') : null),
    kv([['Type', `${display(n.type)} (${coding(n.type).code})`], ['Author', n.author?.[0]?.display], ['Date', fmtDateTime(when(n))]]),
    h('hr', { style: 'border:none;border-top:1px solid var(--line);margin:0.75rem 0' }), h('div', { class: 'note-body', testid: 'note-text' }, noteText(n)),
    notes.filter((a) => (a.relatesTo || []).some((r) => r.target?.reference === `DocumentReference/${n.id}`)).map((a) => h('div', { class: 'banner info', testid: `addendum-${a.id}` }, h('strong', {}, `Addendum · ${a.author?.[0]?.display || ''} · ${fmtDateTime(when(a))} · ${lifecycle(a) === 'preliminary' ? 'draft' : 'signed'}`), h('div', { class: 'note-body' }, noteText(a)))),
    h('div', { class: 'toolbar', style: 'margin-top:0.75rem' }, noteActions(n), agentTouched.has(`DocumentReference/${n.id}`) ? reportProblemButton({ resource: `DocumentReference/${n.id}` }, { patient: p.id, testid: `note-report-problem-${n.id}` }) : null)) : h('div', { class: 'card empty' }, 'Select a note to read it'));
  const noteList = (rows, selectedId, hrefBase, testid) => table({ testid, rows, selected: selectedId, empty: 'No data to display', group: (n) => relativeGroup(when(n)), onRow: (n) => go(`${hrefBase}?id=${n.id}`), columns: [
    { label: 'Date', render: (n) => fmtDateTime(when(n)) }, { label: 'Type', render: (n) => (lifecycle(n) === 'preliminary' ? h('strong', {}, display(n.type)) : display(n.type)) },
    { label: 'Author', render: (n) => n.author?.[0]?.display || '' }, { label: 'Status', render: (n) => statusBadge(lifecycle(n) === 'preliminary' ? 'draft' : lifecycle(n), lifecycle(n) === 'preliminary' ? 'warn' : 'ok') },
  ] });
  function notesTab() {
    const only = query.get('filter') === 'unsigned';
    const rows = notes.filter((n) => !only || lifecycle(n) === 'preliminary');
    const unsigned = notes.filter((n) => lifecycle(n) === 'preliminary').length;
    const noteDrafts = drafts.filter((d) => d.kind === 'note');
    const draftCards = noteDrafts.map((d) => {
      markShown(d);
      const edit = () => formDialog({ title: 'Edit, then sign', testid: 'draft-note-form', submitLabel: 'Sign note', wide: true, intro: 'Parts marked "Check this" were uncertain. Correct the text, then sign it as your own.',
        fields: [{ name: 'text', label: 'Note', type: 'textarea', rows: 12, value: stripCheckMarks(d.content.text), testid: 'draft-note-text', wide: true }],
        onSubmit: async (v) => { const size = editSize(stripCheckMarks(d.content.text), v.text); await draftEvent(d.id, 'edited', { editSize: size, branch: view.branch }); await decideDraft(d, 'edit', { content: { text: v.text } }); done('Note signed'); } });
      return h('section', { class: 'draft', testid: `draft-note-${d.id}`, 'aria-label': 'AI-drafted note, not signed' }, draftHead(d, 'AI-drafted note'),
        h('div', { class: 'muted small' }, `${d.content.checks || 0} part${d.content.checks === 1 ? '' : 's'} to check`), checkThis(d.content.text, `draft-note-text-${d.id}`),
        h('div', { class: 'draft-actions' }, btn('Edit, then sign', { kind: 'primary', small: true, write: true, perm: ['DocumentReference', 'create'], testid: `draft-edit-${d.id}`, onClick: edit }),
          btn('Sign as is', { small: true, write: true, perm: ['DocumentReference', 'create'], testid: `draft-sign-${d.id}`, disabled: (d.content.checks || 0) > 0, title: (d.content.checks || 0) > 0 ? 'Resolve the "Check this" parts first' : '', onClick: async () => { await draftEvent(d.id, 'used', { branch: view.branch }); await decideDraft(d, 'accept'); done('Note signed'); } }),
          btn('Discard', { small: true, kind: 'danger', testid: `draft-discard-${d.id}`, onClick: () => discard(d, 'Discard this draft note') })));
    });
    // Ambient note (ambient-note): the visit is recorded as a typed or dictated transcript; stopping it saves the transcript and the scribe drafts the note.
    let recording = null;
    const recordVisit = () => {
      const box = field({ name: 'transcript', label: 'What was said (synthetic; one line per speaker, "Doctor:" or "Patient:")', type: 'textarea', rows: 8, testid: 'ambient-transcript', wide: true, dictate: true });
      openDialog({ title: 'Recording the visit', testid: 'ambient-dialog', wide: true, body: [h('p', { class: 'muted small' }, 'Nothing is recorded from a microphone. Type or dictate the conversation. Stopping saves the transcript; the scribe then drafts a note and queues orders for you to sign or remove.'), box.el],
        actions: [{ label: 'Cancel', onClick: (c) => c() }, { label: 'Stop recording', kind: 'primary', testid: 'ambient-stop', onClick: async (c) => {
          const text = box.get().trim(); if (!text) throw new Error('Nothing was said');
          await fhir.create({ resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', subject, date: now(), description: 'Encounter transcript', type: { coding: [{ system: 'urn:hospital-desktop:doc-type', code: 'transcript', display: 'Encounter transcript' }], text: 'Encounter transcript' },
            ...(currentEncounter ? { context: { encounter: [{ reference: `Encounter/${currentEncounter.id}` }] } } : {}), content: [{ attachment: { contentType: 'text/plain', data: encodeText(text) } }] });
          c(); done('Transcript saved. If a scribe is switched on, its draft note appears here in a moment.'); setTimeout(render, 2500);
        } }] });
    };
    return [...draftCards, h('div', { class: 'toolbar' }, h('h2', { class: 'grow' }, 'Notes'),
      btn('Record visit', { write: true, perm: ['DocumentReference', 'create'], testid: 'ambient-start', title: 'Record the visit as a transcript; the scribe drafts the note', onClick: recordVisit }),
      h('div', { class: 'seg' }, [['', `All (${notes.length})`], ['unsigned', `Unsigned (${unsigned})`]].map(([f, label]) => h('button', { type: 'button', testid: `notes-filter-${f || 'all'}`, 'aria-label': label, 'aria-pressed': String((query.get('filter') || '') === f), onClick: () => go(`${base}/notes${f ? `?filter=${f}` : ''}`) }, label))),
      nurseView ? btn('Handover note (SBAR)', { write: true, perm: ['DocumentReference', 'create'], testid: 'note-handover', onClick: () => noteDialog({ template: 'sbar' }) }) : null,
      btn('New note', { kind: 'primary', write: true, perm: ['DocumentReference', 'create'], testid: 'note-new', onClick: () => noteDialog() })),
    h('div', { class: 'split' }, noteList(rows, query.get('id'), `${base}/notes`, 'notes-table'), noteReader(notes.find((n) => n.id === query.get('id')) || null))];
  }

  // ----- Orders -----
  const resultsFor = (o) => labs.filter((r) => (r.basedOn || []).some((b) => b.reference === `ServiceRequest/${o.id}`));
  const componentsOf = (o) => { const code = coding(o.code).code; const panel = cat.panels.find((x) => x.code === code); return (panel ? panel.components : [code]).map((c) => cat.labs.find((l) => l.code === c)).filter(Boolean); };
  async function acknowledgePrompt(list) {
    for (const o of list) {
      const ok = await confirmDialog({ title: 'Critical result', message: `${display(o.code)}: ${o.valueQuantity?.value} ${o.valueQuantity?.unit || ''} (${interp(o)}). Acknowledge that you have seen this critical result. It cannot be released to the Patient Portal until acknowledged.`, confirmLabel: 'Acknowledge', testid: 'critical-ack', kind: 'danger' });
      if (ok) await fhir.acknowledge(o);
    }
  }
  function enterResults(o) {
    const existing = resultsFor(o);
    const comps = componentsOf(o);
    formDialog({ title: `Preliminary results: ${display(o.code)}`, testid: 'results-form', wide: true, submitLabel: 'Save preliminary results',
      intro: 'Enter the values reported by the laboratory. Results stay preliminary until signed.',
      fields: comps.map((c) => ({ name: c.code, label: `${c.name} (${c.unit}) · ref ${c.low ?? ''}–${c.high ?? ''}`, type: 'number', step: 'any', value: existing.find((r) => coding(r.code).code === c.code)?.valueQuantity?.value ?? '' })),
      onSubmit: async (v) => {
        const at = now();
        const fresh = [];
        for (const c of comps) {
          if (v[c.code] == null) continue;
          const prior = existing.find((r) => coding(r.code).code === c.code);
          if (prior) { if (prior.status === 'preliminary' && prior.valueQuantity?.value !== v[c.code]) await fhir.update({ ...prior, valueQuantity: { ...prior.valueQuantity, value: v[c.code] } }); continue; }
          fresh.push({ resourceType: 'Observation', status: 'preliminary', subject, effectiveDateTime: at, basedOn: [{ reference: `ServiceRequest/${o.id}` }], performer: author(),
            category: [{ coding: [{ system: cat.systems.obsCategory, code: 'laboratory' }] }], code: { coding: [{ system: cat.systems.loinc, code: c.code, display: c.name }] },
            valueQuantity: { value: v[c.code], unit: c.unit, system: 'http://unitsofmeasure.org', code: c.unit } });
        }
        if (fresh.length) await fhir.transaction(fresh);
        done('Preliminary results saved');
      } });
  }
  async function signResults(o) {
    const pending = resultsFor(o).filter((r) => r.status === 'preliminary');
    if (!await confirmDialog({ title: 'Sign final results', message: `Sign ${pending.length} preliminary result${pending.length === 1 ? '' : 's'} for ${display(o.code)} as final?`, confirmLabel: 'Sign final results', testid: 'sign-results' })) return;
    const signed = [];
    for (const r of pending) signed.push(await fhir.transition(r, 'final'));
    await acknowledgePrompt(signed.filter((r) => flagged(r, 'critical-unacknowledged')));
    done('Results signed as final');
  }
  const orderDetail = (o) => openDialog({ title: display(o.code), testid: 'order-detail', wide: true, body: [
    h('h3', {}, 'Order details'), kv([['Priority', (o.priority || 'routine').toUpperCase()], ['Status', statusBadge(lifecycle(o))], ['Category', o.category?.[0]?.coding?.[0]?.code], ['Code', h('span', { class: 'mono' }, `LOINC ${coding(o.code).code}`)]]),
    h('h3', { style: 'margin-top:0.875rem' }, `Ordered on ${fmtDateTime(o.authoredOn)}`), kv([['Ordering provider', o.requester?.display], ['Reason for exam', o.reasonCode?.[0]?.text], ['Status reason', ext(o, 'urn:hospital-desktop:status-reason')], ['Duplicate override', ext(o, 'urn:hospital-desktop:duplicate-override-reason')]]),
    h('h3', { style: 'margin-top:0.875rem' }, 'Results'), table({ testid: 'order-results', rows: resultsFor(o), empty: hasCat(o, 'imaging') ? 'Imaging reports arrive from PACS.' : 'No results entered yet', columns: [
      { label: 'Test', render: (r) => display(r.code) }, { label: 'Value', cls: 'num', render: (r) => `${r.valueQuantity?.value} ${r.valueQuantity?.unit || ''}` }, { label: 'Flag', render: (r) => (interp(r) && interp(r) !== 'N' ? badge(interp(r), interp(r).length === 2 ? 'solid-danger' : 'danger') : '') }, { label: 'Status', render: (r) => statusBadge(r.status) },
    ] }),
    agentTouched.has(`ServiceRequest/${o.id}`) ? h('div', { class: 'toolbar', style: 'margin-top:0.75rem' }, h('span', { class: 'muted small grow' }, 'An AI agent wrote or proposed this order.'), reportProblemButton({ resource: `ServiceRequest/${o.id}` }, { patient: p.id, testid: `order-report-problem-${o.id}` })) : null,
  ], actions: [{ label: 'Close', onClick: (c) => c() }] });
  function ordersTab() {
    const items = [
      ...cat.panels.map((x) => ({ label: `${x.name} · LOINC ${x.code}`, code: x.code, display: x.name, category: 'laboratory' })),
      ...cat.labs.map((x) => ({ label: `${x.name} · LOINC ${x.code}`, code: x.code, display: x.name, category: 'laboratory' })),
      ...cat.imaging.map((x) => ({ label: `${x.name} (${x.modality}) · LOINC ${x.code}`, code: x.code, display: x.name, category: 'imaging', modality: x.modality, bodySite: x.bodySite })),
      ...(cat.pathology || []).map((x) => ({ label: `${x.name} (pathology) · LOINC ${x.code}`, code: x.code, display: x.name, category: 'pathology' })),
      ...(cat.procedures || []).map((x) => ({ label: `${x.name} · LOINC ${x.code}`, code: x.code, display: x.name, category: x.category })),
    ];
    const pick = field({ name: 'order', label: 'Place orders: lab test, panel, imaging or ECG', list: items.map((i) => i.label), placeholder: 'Type to search the catalogue', testid: 'order-search', wide: true });
    // CDS order-select when an item is chosen.
    // The browser fires a second native change when the card dialog takes focus; one selection fires order-select once.
    let lastPick = null;
    pick.input.addEventListener('change', () => { const item = items.find((i) => i.label === pick.get()); if (item && item.label === lastPick) return; lastPick = item?.label ?? null; if (item) cdsOrderSelect(p.id, { resourceType: 'ServiceRequest', status: 'draft', intent: 'order', subject, category: [{ coding: [{ system: 'urn:hospital-desktop:order-category', code: item.category }] }], code: { coding: [{ system: cat.systems.loinc, code: item.code, display: item.display }] } }); });
    const priority = field({ name: 'priority', label: 'Priority', type: 'select', options: [['routine', 'Routine'], ['urgent', 'Urgent'], ['stat', 'STAT']], testid: 'order-priority' });
    const reason = field({ name: 'reason', label: 'Reason for exam', testid: 'order-reason', wide: true });
    const byMode = orderModeRequired('ServiceRequest');
    const modeFields = byMode ? byModeFields('order').map(field) : [];
    const place = async (item) => {
      await showAdvisories(p.id, 'order');
      const modeValues = Object.fromEntries(modeFields.map((f) => [f.name, f.get()]));
      if (byMode && !modeValues.physician) throw new Error('Name the ordering physician for a verbal, telephone or protocol order');
      const created = await createWithSafety({ resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject, authoredOn: now(), priority: priority.get(), requester: { display: identity.display },
        ...(byMode ? byModeExtras(modeValues) : {}),
        ...(currentEncounter ? { encounter: { reference: `Encounter/${currentEncounter.id}` } } : {}),
        category: [{ coding: [{ system: 'urn:hospital-desktop:order-category', code: item.category }] }], code: { coding: [{ system: cat.systems.loinc, code: item.code, display: item.display }] },
        ...(item.modality ? { bodySite: [{ text: item.bodySite }], orderDetail: [{ coding: [{ system: 'http://dicom.nema.org/resources/ontology/DCM', code: item.modality }] }] } : {}),
        ...(reason.get() ? { reasonCode: [{ text: reason.get() }] } : {}) });
      if (created) done(byMode ? `Entered for co-signature: ${item.display}` : `Ordered: ${item.display}`);
    };
    const canOrder = canWrite('ServiceRequest', 'create', { orderMode: byMode });
    const entry = h('div', { class: 'card', testid: 'order-entry' }, h('h3', {}, byMode ? 'New order for co-signature' : 'New order'),
      byMode ? h('p', { class: 'muted small', testid: 'order-by-mode-note' }, 'Verbal, telephone and protocol orders are active at once and wait in the ordering physician\'s Inbox for a co-signature.') : null,
      h('div', { class: 'form' }, pick.el, priority.el, h('div', {}), reason.el, ...modeFields.map((f) => f.el)),
      h('div', { class: 'toolbar', style: 'margin-top:0.75rem' }, btn(byMode ? 'Enter order' : 'Sign order', { kind: 'primary', write: true, ...(canOrder ? {} : { perm: ['ServiceRequest', 'create'] }), testid: 'order-sign', onClick: async () => { const item = items.find((i) => i.label === pick.get()); if (!item) throw new Error('Choose an order from the catalogue list'); await place(item); } }),
        h('span', { class: 'muted small' }, 'Panel templates:'), cat.panels.map((x) => btn(x.short, { small: true, write: true, ...(canOrder ? {} : { perm: ['ServiceRequest', 'create'] }), testid: `order-panel-${x.short.toLowerCase()}`, onClick: () => place(items.find((i) => i.code === x.code)) }))),
      // Medication orders are orders too: the same controls as the Medications tab, so a role without that tab (the nurse) still reaches them.
      h('div', { class: 'toolbar', style: 'margin-top:0.75rem' }, h('span', { class: 'muted small' }, 'Medications:'), prescribeButtons()));
    const orderCard = (o) => {
      const res = resultsFor(o);
      const prelim = res.filter((r) => r.status === 'preliminary').length;
      const lab = hasCat(o, 'laboratory');
      return h('div', { class: 'card', testid: `order-${o.id}` }, h('div', { class: 'toolbar', style: 'margin:0' },
        h('div', { class: 'grow' }, h('strong', {}, display(o.code)), ' ', badge((o.priority || 'routine').toUpperCase(), o.priority === 'stat' ? 'solid-danger' : o.priority === 'urgent' ? 'warn' : 'info'), ' ', statusBadge(lifecycle(o)),
          ext(o, 'urn:hospital-desktop:order-mode') ? [' ', badge(`${ext(o, 'urn:hospital-desktop:order-mode')} order${(o.extension || []).some((e) => e.url === 'urn:hospital-desktop:pending-cosign' && e.valueBoolean === true) ? ', needs co-signature' : ''}`, 'warn', `order-mode-${o.id}`)] : null,
          h('div', { class: 'muted small' }, `Ordered ${fmtDateTime(o.authoredOn)} by ${o.requester?.display || ''}${o.reasonCode?.[0]?.text ? ` · ${o.reasonCode[0].text}` : ''}${lab ? ` · ${res.length} result${res.length === 1 ? '' : 's'}${prelim ? `, ${prelim} preliminary` : ''}` : ' · report arrives from PACS'}`)),
        btn('Details', { small: true, testid: `order-details-${o.id}`, onClick: () => orderDetail(o) }),
        nurseView && ['active', 'results-received'].includes(lifecycle(o)) && !ext(o, 'urn:hospital-desktop:nurse-acknowledged') ? btn('Acknowledge', { small: true, write: true, perm: ['ServiceRequest', 'update'], kind: 'primary', testid: `order-ack-${o.id}`, onClick: async () => { await api.post(`/api/nursing/orders/${o.id}/acknowledge`, {}); done('Order acknowledged'); } }) : null,
        ext(o, 'urn:hospital-desktop:nurse-acknowledged') ? badge('Acknowledged', 'ok', `order-acked-${o.id}`) : null,
        lab && lifecycle(o) === 'active' ? btn('Enter prelim results', { small: true, write: true, perm: ['Observation', 'create'], testid: `order-enter-${o.id}`, onClick: () => enterResults(o) }) : null,
        lab && lifecycle(o) === 'active' && prelim ? btn('Sign final results', { small: true, write: true, perm: ['Observation', 'sign'], kind: 'primary', testid: `order-signresults-${o.id}`, onClick: () => signResults(o) }) : null,
        ['draft', 'active'].includes(lifecycle(o)) ? btn('Cancel', { small: true, write: true, perm: ['ServiceRequest', 'transition'], kind: 'danger', testid: `order-cancel-${o.id}`, onClick: async () => { const r = await askReason({ title: `Cancel order: ${display(o.code)}`, submitLabel: 'Cancel order' }); if (!r) return; await fhir.transition(o, lifecycle(o) === 'draft' ? 'cancelled' : 'revoked', r); done('Order cancelled (revoked)'); } }) : null));
    };
    const open = orders.filter((o) => OPEN_ORDER.includes(lifecycle(o)));
    const group = (title, list) => (list.length ? [h('h3', { style: 'margin-top:1rem' }, title), h('div', { class: 'stack' }, list.map(orderCard))] : null);
    const openMeds = meds.filter((m) => OPEN_MED.includes(lifecycle(m)));
    const medGroup = openMeds.length ? [h('h3', { style: 'margin-top:1rem' }, 'Medications'), h('div', { class: 'stack', testid: 'orders-medications' }, openMeds.map(medCard))] : null;
    const queued = drafts.filter((d) => d.kind === 'order');
    const queuedList = queued.length ? h('section', { class: 'draft', testid: 'queued-orders', 'aria-label': 'Queued orders from the AI, not signed' }, h('div', { class: 'p-head' }, h('span', { class: 'p-mark' }, 'Queued orders — not signed'), h('span', { class: 'muted small' }, ' Sign each one, or remove it.')),
      ...queued.map((d) => { markShown(d); const r = d.content.resource || {}; return h('div', { class: 'toolbar', style: 'margin:0.375rem 0', testid: `queued-${d.id}` }, h('span', { class: 'grow' }, h('strong', {}, display(r.code) || r.resourceType), ' ', h('span', { class: 'muted small' }, `${r.priority || 'routine'} · ${r.reasonCode?.[0]?.text || ''}`)),
        btn('Sign', { kind: 'primary', small: true, write: true, perm: ['ServiceRequest', 'create'], testid: `queued-sign-${d.id}`, onClick: async () => { await draftEvent(d.id, 'used', { branch: view.branch }); await decideDraft(d, 'accept'); done('Order signed'); } }),
        btn('Remove', { small: true, kind: 'danger', testid: `queued-remove-${d.id}`, onClick: () => discard(d, 'Remove this queued order') })); })) : null;
    return h('div', { class: 'split' }, h('div', { testid: 'orders-active' }, queuedList, h('h2', {}, 'Active orders'), open.length || openMeds.length ? [group('Laboratory', open.filter((o) => hasCat(o, 'laboratory'))), group('Imaging', open.filter((o) => hasCat(o, 'imaging'))), group('Pathology', open.filter((o) => hasCat(o, 'pathology'))), group('Procedures', open.filter((o) => !hasCat(o, 'laboratory') && !hasCat(o, 'imaging') && !hasCat(o, 'pathology'))), medGroup] : h('div', { class: 'card empty', testid: 'orders-empty' }, 'No active orders')), entry);
  }

  // ----- Encounters -----
  const ENC_ACTIONS = { planned: [['arrived', 'Arrive'], ['cancelled', 'Cancel']], arrived: [['in-progress', 'Start'], ['cancelled', 'Cancel']], 'in-progress': [['finished', 'Finish'], ['cancelled', 'Cancel']] };
  const CLASSES = { AMB: 'outpatient', IMP: 'inpatient', EMER: 'emergency' };
  const encTable = (testid, onRow, selected) => table({ testid, rows: encounters, selected, onRow, empty: 'No data to display', group: (e) => relativeGroup(when(e)), columns: [
    { label: 'When', render: (e) => fmtDateTime(when(e)) }, { label: 'Class', render: (e) => display(e.class) || e.class?.code }, { label: 'Type', render: (e) => e.type?.[0]?.text || '' },
    { label: 'Reason', render: (e) => e.reasonCode?.[0]?.text || '' }, { label: 'Bed', render: (e) => h('span', { testid: `encounter-bed-${e.id}` }, bedOf(e) || (e.location || []).slice(-1)[0]?.location?.display || '') }, { label: 'Attending', render: (e) => e.participant?.[0]?.individual?.display || '' },
    { label: 'Expected discharge', render: (e) => h('span', { testid: `encounter-expected-${e.id}` }, expectedOf(e)) },
    { label: 'Status', render: (e) => [statusBadge(e.status), (e.extension || []).some((x) => x.url === BED_REQUEST_URL) ? [' ', badge('Bed requested', 'warn', `encounter-bed-requested-${e.id}`)] : null, ext(e, ISOLATION_URL) ? [' ', badge('Isolation', 'danger')] : null] },
    ...(onRow ? [] : [{ label: '', cls: 'actions', render: (e) => [lifecycleActions(e, ENC_ACTIONS), bedActions(e)] }]),
  ] });
  const bedActions = (e) => [
    (e.location || []).length ? btn('Movements', { small: true, testid: `encounter-movements-${e.id}`, onClick: () => openDialog({ title: `Movements · ${fmtDate(when(e))}`, testid: 'movements-dialog', wide: true, body: table({ testid: 'movements-table', rows: e.location.map((l, i) => ({ id: i, ...l })), columns: [
      { label: 'Bed', render: (l) => l.location?.display || l.location?.reference || '' }, { label: 'From', render: (l) => fmtDateTime(l.period?.start) }, { label: 'To', render: (l) => (l.period?.end ? fmtDateTime(l.period.end) : h('span', { class: 'muted' }, 'still here')) }, { label: 'Status', render: (l) => badge(l.status || 'completed', l.status === 'active' ? 'accent' : '') },
    ] }), actions: [{ label: 'Close', onClick: (c) => c() }] }) }) : null,
    ['arrived', 'in-progress'].includes(e.status) ? btn('Expected discharge', { small: true, write: true, perm: ['Encounter', 'update'], testid: `encounter-expected-set-${e.id}`, onClick: () => formDialog({ title: 'Expected discharge date', testid: 'expected-form', submitLabel: 'Save', fields: [{ name: 'date', label: 'Expected discharge', type: 'date', value: expectedOf(e), required: true }], onSubmit: async (v) => {
      await fhir.update({ ...e, extension: [...(e.extension || []).filter((x) => x.url !== EXPECTED_URL), { url: EXPECTED_URL, valueDate: v.date }] }); done('Expected discharge saved');
    } }) }) : null,
    INPATIENT.includes(e.class?.code) && ['arrived', 'in-progress'].includes(e.status) && !bedOf(e) ? btn('Request bed', { small: true, kind: 'primary', write: true, perm: ['Encounter', 'update'], testid: `encounter-request-bed-${e.id}`, onClick: async () => {
      const units = (await fhir.search('Location', { 'physical-type': 'wa' })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      formDialog({ title: 'Request a bed', testid: 'bed-request-form', submitLabel: 'Request bed', intro: 'The patient goes on the Beds waiting list; the bed manager assigns from there.', fields: [
        { name: 'unit', label: 'Unit', type: 'select', options: [['', 'Any unit'], ...units.map((u) => [u.id, u.name])], wide: true },
        { name: 'isolation', label: 'Isolation needed (type of precautions, or leave empty)', value: ext(e, ISOLATION_URL) || '', wide: true },
      ], onSubmit: async (v) => { await api.post('/api/beds/request', { encounter: e.id, unit: v.unit || undefined, isolation: v.isolation || undefined }); done('Bed requested'); } });
    } }) : null,
  ];
  function encountersTab() {
    const add = () => formDialog({ title: 'New encounter', testid: 'encounter-form', submitLabel: 'Create encounter', fields: [
      { name: 'cls', label: 'Class', type: 'select', options: Object.entries(CLASSES) }, { name: 'type', label: 'Type', value: 'Office visit' },
      { name: 'reason', label: 'Reason', wide: true }, { name: 'location', label: 'Location', value: 'Clinic A' }, { name: 'attending', label: 'Attending', value: identity.display },
      { name: 'status', label: 'Starting status', type: 'select', options: ['planned', 'arrived', 'in-progress'], value: 'arrived' },
    ], onSubmit: async (v) => {
      await fhir.create({ resourceType: 'Encounter', status: v.status, subject, period: { start: now() }, class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: v.cls, display: CLASSES[v.cls] },
        type: [{ text: v.type }], ...(v.reason ? { reasonCode: [{ text: v.reason }] } : {}), location: [{ location: { display: v.location } }], participant: [{ individual: { display: v.attending } }] });
      done('Encounter created');
    } });
    return [h('div', { class: 'toolbar' }, h('h2', { class: 'grow' }, 'Encounters'), btn('New encounter', { kind: 'primary', write: true, perm: ['Encounter', 'create'], testid: 'encounter-new', onClick: add })), encTable('encounters-table')];
  }

  // ----- Portal and messages -----
  function messagesTab() {
    const comms = D('Communication').sort((a, b) => (a.sent || '').localeCompare(b.sent || ''));
    const threadOf = (c) => c.identifier?.find((i) => i.system === 'urn:hospital-desktop:thread')?.value || c.id;
    const threads = [...new Set(comms.map(threadOf))].map((id) => comms.filter((c) => threadOf(c) === id)).sort((a, b) => (b.at(-1).sent || '').localeCompare(a.at(-1).sent || ''));
    const selected = threads.find((t) => threadOf(t[0]) === query.get('thread')) || threads[0];
    const fromPatient = (c) => c.sender?.reference?.startsWith('Patient/');
    const send = async (text, thread, topic) => {
      const created = await fhir.create({ resourceType: 'Communication', status: 'completed', subject, sent: now(), sender: { display: identity.display }, recipient: [subject],
        topic: { text: topic }, payload: [{ contentString: text }], ...(thread ? { identifier: [{ system: 'urn:hospital-desktop:thread', value: thread }] } : {}) });
      if (!thread) await fhir.update({ ...created, identifier: [{ system: 'urn:hospital-desktop:thread', value: created.id }] });
    };
    const state = reviewState(`${p.id}/messages`);
    // Opening a thread reads it, unless it was just marked unread.
    if (selected && !view.readOnly && query.get('thread') && state.keepUnread !== threadOf(selected[0])) for (const c of selected.filter((x) => fromPatient(x) && !x.received)) fhir.update({ ...c, received: now() }).catch(() => {});
    const reply = field({ name: 'reply', label: 'Reply to the patient', type: 'textarea', rows: 3, testid: 'message-reply' });
    // draft-reply: the agent's suggested reply sits in the reply box as a choice; sending (edited or not) approves it, discarding is logged.
    const replyDraft = selected ? drafts.find((d) => d.kind === 'triage' && selected.some((c) => d.subject === `Communication/${c.id}`)) : null;
    let startedFrom = null;
    const draftChoice = replyDraft ? (() => { markShown(replyDraft); return h('section', { class: 'draft', testid: `draft-reply-${replyDraft.id}`, 'aria-label': 'AI-drafted reply, not sent' }, draftHead(replyDraft, 'AI-drafted reply'),
      h('div', { class: 'muted small' }, `Suggested priority: ${replyDraft.content.label || 'routine'}`), h('div', { class: 'draft-text', testid: `draft-reply-text-${replyDraft.id}` }, replyDraft.content.reply || ''),
      h('div', { class: 'draft-actions' }, btn('Start with draft', { kind: 'primary', small: true, testid: `draft-start-${replyDraft.id}`, onClick: () => { reply.set(replyDraft.content.reply || ''); startedFrom = replyDraft; draftEvent(replyDraft.id, 'used', { branch: view.branch }); reply.input.focus(); } }),
        btn('Start blank reply', { small: true, testid: `draft-blank-${replyDraft.id}`, onClick: () => { reply.set(''); startedFrom = null; discard(replyDraft, 'Discard the drafted reply'); } }))); })() : null;
    const unreadIn = (t) => t.filter((c) => fromPatient(c) && !c.received);
    const hidden = (c) => (c.payload || []).slice(1).some((x) => (x.extension || []).some((e) => e.url === 'urn:hospital-desktop:hidden-payload'));
    const lastFromPatient = selected ? [...selected].reverse().find(fromPatient) : null;
    const setRead = async (read) => { for (const c of selected.filter(fromPatient)) { if (read && !c.received) await fhir.update({ ...c, received: now() }); if (!read && c === lastFromPatient && c.received) { const { received, ...rest } = c; await fhir.update(rest); } } state.keepUnread = read ? null : threadOf(selected[0]); done(read ? 'Marked as read' : 'Marked as unread'); };
    const task = (code, textLabel, description, extra = {}) => fhir.create({ resourceType: 'Task', status: 'requested', intent: 'order', code: { coding: [{ system: 'urn:hospital-desktop:task', code }], text: textLabel }, description, for: subject, requester: { display: identity.display }, authoredOn: now(), ...(lastFromPatient ? { focus: { reference: `Communication/${lastFromPatient.id}` } } : {}), ...extra });
    const route = () => formDialog({ title: 'Route to a teammate', testid: 'route-form', submitLabel: 'Route', intro: 'The message goes to their Inbox as a follow-up.', fields: [{ name: 'to', label: 'Teammate', required: true, wide: true, testid: 'route-to' }, { name: 'note', label: 'Note', wide: true, testid: 'route-note' }],
      onSubmit: async (v) => { await task('message-route', 'Routed message', `${selected[0].topic?.text || 'Message'}${v.note ? `: ${v.note}` : ''}`, { owner: { display: v.to } }); done(`Routed to ${v.to}`); } });
    const toRefill = () => formDialog({ title: 'Refill request from this message', testid: 'refill-form', submitLabel: 'Create refill request', fields: [{ name: 'med', label: 'Medication', type: 'select', required: true, wide: true, testid: 'refill-med', options: activeMeds.length ? activeMeds.map((m) => [m.id, display(m.medicationCodeableConcept)]) : [['', 'No active medications']] }],
      onSubmit: async (v) => { if (!v.med) throw new Error('This patient has no active medication to refill'); const m = activeMeds.find((x) => x.id === v.med); await task('refill-request', 'Refill request', `${display(m.medicationCodeableConcept)} · ${m.dosageInstruction?.[0]?.text || ''}`, { focus: { reference: `MedicationRequest/${m.id}` }, requester: subject }); done('Refill request created'); } });
    const toAppointment = () => formDialog({ title: 'Appointment request from this message', testid: 'appt-request-form', submitLabel: 'Create appointment request', fields: [{ name: 'reason', label: 'Reason', required: true, wide: true, testid: 'appt-request-reason', value: selected[0].topic?.text || '' }],
      onSubmit: async (v) => { await task('appointment-request', 'Appointment request', v.reason, { requester: subject }); done('Appointment request created'); } });
    return [h('div', { class: 'toolbar' }, h('h2', { class: 'grow' }, 'Messages'),
      h('a', { href: '/portal/', target: '_blank', rel: 'noopener', class: 'btn', testid: 'open-portal', 'aria-label': 'Open the Patient Portal as this patient', style: 'display:inline-flex;align-items:center', onClick: () => patientContext.set(p.id) }, 'Open Patient Portal as this patient'),
      btn('New message', { kind: 'primary', write: true, perm: ['Communication', 'create'], testid: 'message-new', onClick: () => formDialog({ title: 'New message to patient', testid: 'message-form', submitLabel: 'Send', fields: [{ name: 'topic', label: 'Subject', required: true, wide: true }, { name: 'text', label: 'Message', type: 'textarea', rows: 6, required: true }], onSubmit: async (v) => { await send(v.text, null, v.topic); done('Message sent'); } }) })),
    h('div', { class: 'split' },
      table({ testid: 'threads-table', rows: threads.map((t) => ({ id: threadOf(t[0]), t })), selected: selected ? threadOf(selected[0]) : null, empty: 'No data to display', onRow: (r) => go(`${base}/messages?thread=${r.id}`), columns: [
        { label: 'Subject', render: (r) => r.t[0].topic?.text || '(no subject)' }, { label: 'Messages', cls: 'num', render: (r) => r.t.length }, { label: 'Last', render: (r) => fmtDateTime(r.t.at(-1).sent) },
        { label: '', render: (r) => [r.t.some((c) => c.priority === 'urgent' || c.priority === 'stat') ? badge('Urgent', 'solid-danger', `thread-urgent-${r.id}`) : null, ' ', unreadIn(r.t).length ? badge('New', 'accent', `thread-new-${r.id}`) : ''] },
      ] }),
      selected ? h('div', { class: 'card thread', testid: 'thread' }, h('div', { class: 'toolbar', style: 'margin:0 0 0.5rem;flex-wrap:wrap' }, h('h3', { class: 'grow', style: 'margin:0' }, selected[0].topic?.text || 'Thread'),
          view.readOnly || !lastFromPatient ? null : [btn(lastFromPatient.received ? 'Mark unread' : 'Mark read', { small: true, write: true, perm: ['Communication', 'update'], testid: 'message-read-toggle', onClick: () => setRead(!lastFromPatient.received) }), btn('Route', { small: true, write: true, perm: ['Task', 'create'], testid: 'message-route', onClick: route }), btn('Refill request', { small: true, write: true, perm: ['Task', 'create'], testid: 'message-to-refill', onClick: toRefill }), btn('Appointment request', { small: true, write: true, perm: ['Task', 'create'], testid: 'message-to-appointment', onClick: toAppointment })]),
        selected.map((c) => h('div', { class: `msg${fromPatient(c) ? '' : ' mine'}`, testid: `msg-${c.id}` }, h('div', { class: 'meta' }, `${fromPatient(c) ? 'Patient' : c.sender?.display || 'Care team'} · ${fmtDateTime(c.sent)}`, c.priority === 'urgent' || c.priority === 'stat' ? [' ', badge('Urgent', 'solid-danger')] : null, hidden(c) ? [' ', badge('Carries hidden text (simulation)', 'warn', `msg-hidden-${c.id}`)] : null), c.payload?.[0]?.contentString || '')),
        draftChoice, reply.el, h('div', { class: 'toolbar', style: 'margin-top:0.5rem' }, btn('Send reply', { kind: 'primary', write: true, perm: ['Communication', 'create'], testid: 'message-send', onClick: async () => { if (!reply.get()) throw new Error('Type a reply first'); if (startedFrom) { const size = editSize(startedFrom.content.reply || '', reply.get()); if (size) await draftEvent(startedFrom.id, 'edited', { editSize: size, branch: view.branch }); await decideDraft(startedFrom, 'edit', { content: { label: startedFrom.content.label, reply: reply.get() } }); done('Reply sent'); return; } await send(reply.get(), threadOf(selected[0]), selected[0].topic?.text); done('Reply sent'); } })))
        : h('div', { class: 'card empty', testid: 'thread-empty' }, 'No data to display'))];
  }

  // ----- History -----
  function labDialog(o) {
    (async () => {
      const versions = await fhir.history('Observation', o.id);
      const range = o.referenceRange?.[0];
      const correct = () => formDialog({ title: `Correct result: ${display(o.code)}`, testid: 'correct-form', submitLabel: 'Save correction', intro: 'The previous value is kept in the version history.',
        fields: [{ name: 'value', label: `Corrected value (${o.valueQuantity?.unit || ''})`, type: 'number', step: 'any', required: true, value: o.valueQuantity?.value }],
        onSubmit: async (v) => { const fixed = await fhir.update({ ...o, status: 'corrected', valueQuantity: { ...o.valueQuantity, value: v.value } }); document.querySelector('dialog[data-testid="lab-dialog"]')?.remove(); if (flagged(fixed, 'critical-unacknowledged')) await acknowledgePrompt([fixed]); done('Result corrected'); } });
      openDialog({ title: display(o.code), testid: 'lab-dialog', wide: true, body: [
        kv([['Value', h('strong', { testid: 'lab-value' }, `${o.valueQuantity?.value} ${o.valueQuantity?.unit || ''}`)], ['Reference range', range ? `${range.low?.value ?? ''} – ${range.high?.value ?? ''} ${range.high?.unit || range.low?.unit || ''}` : ''],
          ['Interpretation', interp(o) ? badge(interp(o), interp(o) === 'N' ? 'ok' : interp(o).length === 2 ? 'solid-danger' : 'danger') : ''], ['Status', [statusBadge(o.status), o.status === 'corrected' ? [' ', badge('Corrected', 'warn', 'lab-corrected-badge')] : null]],
          ['Collected', fmtDateTime(when(o))], ['LOINC', h('span', { class: 'mono' }, coding(o.code).code)], ['Patient Portal', flagged(o, 'released') ? badge('Released', 'accent') : 'Not released'],
          ['Critical result', flagged(o, 'critical-unacknowledged') ? badge('Needs acknowledgment', 'solid-danger') : flagged(o, 'acknowledged') ? 'Acknowledged' : null]]),
        h('h3', { style: 'margin-top:0.875rem' }, 'Version history'), table({ testid: 'lab-history', rowId: (v) => v.meta.versionId, rows: versions, columns: [
          { label: 'Version', cls: 'num', render: (v) => v.meta.versionId }, { label: 'Recorded', render: (v) => fmtDateTime(v.meta.lastUpdated) }, { label: 'Value', cls: 'num', render: (v) => v.valueQuantity?.value }, { label: 'Status', render: (v) => v.status },
        ] }),
      ], actions: [
        ...(flagged(o, 'critical-unacknowledged') && !view.readOnly ? [{ label: 'Acknowledge', kind: 'danger', testid: 'lab-acknowledge', write: true, perm: ['Observation', '$acknowledge'], onClick: async (c) => { await fhir.acknowledge(o); c(); done('Critical result acknowledged'); } }] : []),
        ...(['final', 'corrected', 'amended'].includes(o.status) && !view.readOnly ? [{ label: 'Correct result', testid: 'lab-correct', write: true, perm: ['Observation', 'update'], onClick: () => correct() },
          { label: flagged(o, 'released') ? 'Hide from the Patient Portal' : 'Release to the Patient Portal', testid: 'lab-release', write: true, perm: ['Observation', '$release'], onClick: async (c) => { await fhir.release(o, !flagged(o, 'released')); c(); done(flagged(o, 'released') ? 'Hidden from the Patient Portal' : 'Released to the Patient Portal'); } }] : []),
        { label: 'Close', onClick: (c) => c() },
      ] });
    })().catch((err) => toast(err.message, { error: true }));
  }
  function labsGrid() {
    if (!labs.length) return h('div', { class: 'card empty', testid: 'labs-empty' }, 'No laboratory results. Order a test from Orders, then enter and sign results.');
    const times = [...new Set(labs.map((o) => when(o)))].sort().slice(-14);
    const codes = [...new Set(labs.map((o) => coding(o.code).code))];
    const order = cat.labs.map((l) => l.code);
    codes.sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999));
    const panelOf = (code) => cat.panels.find((x) => x.components.includes(code))?.short || 'Other tests';
    const body = h('tbody', {});
    let last = null;
    for (const code of codes) {
      if (panelOf(code) !== last) { last = panelOf(code); body.append(h('tr', { class: 'group' }, h('td', { colspan: times.length + 2 }, last))); }
      const spec = cat.labs.find((l) => l.code === code);
      const any = labs.find((o) => coding(o.code).code === code);
      body.append(h('tr', { testid: `lab-row-${code}` }, h('th', { class: 'rowlabel' }, spec?.name || display(any.code)), h('td', { class: 'muted small' }, spec ? `${spec.low ?? ''}–${spec.high ?? ''} ${spec.unit}` : ''),
        times.map((t) => { const o = labs.find((x) => coding(x.code).code === code && when(x) === t); if (!o) return h('td', {});
          const mark = { H: ' ▲', L: ' ▼', HH: ' ▲!', LL: ' ▼!' }[interp(o)] || '';
          return h('td', { class: `cell ${interp(o)}`, testid: `lab-cell-${o.id}`, tabindex: 0, role: 'button', 'aria-label': `${display(o.code)} ${o.valueQuantity?.value} ${fmtDateTime(t)}`, onClick: () => labDialog(o), onKeydown: (e) => { if (e.key === 'Enter') labDialog(o); } },
            `${o.valueQuantity?.value}${mark}`, o.status === 'preliminary' ? h('span', { class: 'muted small' }, ' prelim') : null, o.status === 'corrected' ? [' ', badge('Corrected', 'warn', `corrected-${o.id}`)] : null, flagged(o, 'released') ? h('span', { class: 'muted small', title: 'Released to the Patient Portal' }, ' ☺') : null); })));
    }
    return h('div', { class: 'tablewrap' }, h('table', { class: 'flow', testid: 'labs-grid' }, h('thead', {}, h('tr', {}, h('th', {}, 'Test'), h('th', {}, 'Reference'), times.map((t) => h('th', { class: 'num' }, fmtDateTime(t))))), body));
  }
  function reviewTab() {
    const current = REVIEW.some(([id]) => id === sub) ? sub : 'encounters';
    const subtabs = h('div', { class: 'tabs sub', role: 'navigation', 'aria-label': 'History sections' }, REVIEW.map(([id, label]) => h('a', { href: `${base}/review/${id}`, testid: `review-tab-${id}`, 'aria-label': label, 'aria-current': current === id ? 'page' : undefined }, label)));
    if (current === 'notes') return [subtabs, h('div', { class: 'chart-body' }, h('div', { class: 'split' }, noteList(notes, query.get('id'), `${base}/review/notes`, 'review-notes-table'), noteReader(notes.find((n) => n.id === query.get('id')) || notes[0] || null)))];
    const me = (who) => Boolean(who) && who === identity.display;
    const tagsOf = (...flags) => flags.filter(Boolean);
    const state = reviewState(`${p.id}/${current}`);
    // A link that names a row (?id=) opens it in the preview pane.
    if (query.get('id') && state.linked !== query.get('id')) { state.linked = query.get('id'); state.selected = query.get('id'); state.previewing = true; state.shown = Math.max(state.shown, 100000); }
    const open = (label, onClick, testid) => btn(label, { small: true, testid, onClick });
    const pane = (title, pairs, ...more) => () => h('div', {}, h('h2', { style: 'margin-top:0' }, title), kv(pairs), ...more);
    const inEncounter = (e) => (r) => [r.encounter?.reference, r.context?.encounter?.[0]?.reference].includes(`Encounter/${e.id}`);
    const lines = (title, rows, text) => h('div', { style: 'margin-top:0.625rem' }, h('h3', {}, title), rows.length ? rows.map((r) => h('div', {}, text(r))) : h('span', { class: 'muted' }, 'None'));
    const CLS = { AMB: 'visit', EMER: 'visit', IMP: 'admission', ACUTE: 'admission', NONAC: 'admission', OBSENC: 'admission', SS: 'admission', VR: 'tele', HH: 'ancillary', FLD: 'ancillary' };
    const encRow = (e) => { const kind = e.type?.[0]?.text || display(e.class) || 'Encounter'; const who = e.participant?.[0]?.individual?.display || '';
      return { id: e.id, when: when(e), type: kind, with: who || e.location?.[0]?.location?.display || '', description: `${display(e.class) || e.class?.code || 'Encounter'} · ${e.status}`, complaint: e.reasonCode?.[0]?.text || '', discharge: e.period?.end || '',
        tags: tagsOf(me(who) && 'me', /phone|tele|e-?mail|e-visit|video/i.test(kind) ? 'tele' : CLS[e.class?.code], /lab|imaging|therap|pharmacy|ancillary/i.test(kind) && 'ancillary'),
        preview: () => h('div', { testid: 'encounter-preview' }, h('h2', { style: 'margin-top:0' }, `${kind} · ${fmtDate(when(e))}`), kv([['Class', display(e.class)], ['Attending', who], ['Location', e.location?.[0]?.location?.display], ['Reason', e.reasonCode?.[0]?.text], ['Status', statusBadge(e.status)], ['Discharged', e.period?.end ? fmtDateTime(e.period.end) : null]]),
          lines('Notes', notes.filter(inEncounter(e)), (n) => h('a', { href: `${base}/review/notes?id=${n.id}` }, `${display(n.type)} · ${lifecycle(n) === 'preliminary' ? 'draft' : 'signed'}`)), lines('Orders placed', orders.filter(inEncounter(e)), (o) => `${display(o.code)} · ${lifecycle(o)}`), lines('Medication changes', meds.filter(inEncounter(e)), (m) => `${display(m.medicationCodeableConcept)} · ${lifecycle(m)}`)) }; };
    const apptRow = (a) => { const who = (a.participant || []).find((x) => x.type?.[0]?.text === 'provider')?.actor?.display || ''; const kind = a.appointmentType?.text || 'Appointment';
      return { id: a.id, when: a.start, type: 'Appointment', with: who, description: `${kind} · ${a.status}${a.cancelationReason?.text ? ` (${a.cancelationReason.text})` : ''}`, complaint: a.description || '', discharge: '', tags: tagsOf(me(who) && 'me', /phone|tele|video/i.test(kind) ? 'tele' : 'visit'),
        preview: pane(kind, [['When', fmtDateTime(a.start)], ['With', who], ['Location', (a.participant || []).find((x) => x.type?.[0]?.text === 'location')?.actor?.display], ['Status', statusBadge(a.status)], ['Reason', a.description]]) }; };
    const orderRow = (type) => (o) => { const who = o.performer?.[0]?.display || o.requester?.display || '';
      return { id: o.id, when: o.authoredOn || when(o), type, with: who, description: display(o.code), badge: statusChip(lifecycle(o)), complaint: o.reasonCode?.[0]?.text || '', discharge: '', tags: tagsOf(me(o.requester?.display) && 'me', 'ancillary'),
        preview: pane(display(o.code), [['Status', statusBadge(lifecycle(o))], ['Priority', (o.priority || 'routine').toUpperCase()], ['Ordered', fmtDateTime(o.authoredOn)], ['Ordered by', o.requester?.display], ['Sent to', o.performer?.[0]?.display], ['Reason', o.reasonCode?.[0]?.text]], h('div', { class: 'toolbar', style: 'margin-top:0.625rem' }, open('Open the order', () => orderDetail(o), `review-open-${o.id}`))) }; };
    const isReferral = (o) => hasCat(o, 'referral') || /referral|consult/i.test(`${display(o.code)} ${o.code?.text || ''}`);
    const reports = D('DiagnosticReport').filter((r) => !ext(r, 'urn:hospital-desktop:addendum-of'));
    const reportText = (r) => r.conclusion || ext(r, 'urn:hospital-desktop:report-impression') || decodeText(r.presentedForm?.[0]?.data) || '';
    let rows = []; let testid = `review-${current}-table`; let toolbar = []; let below = null; let emptyText = 'No data to display';
    if (current === 'encounters') rows = [...encounters.map(encRow), ...D('Appointment').map(apptRow)];
    else if (current === 'ed') rows = encounters.filter((e) => e.class?.code === 'EMER').map(encRow);
    else if (current === 'card') {
      const isEcg = (o) => (o.code?.coding || []).some((c) => c.code === '11524-6'); const isEcho = (r) => /echo|cardiac ultrasound/i.test(`${display(r.code)} ${r.code?.text || ''}`) || (r.category || []).some((c) => (c.coding || []).some((x) => ['CUS', 'cardiology', 'CG', 'EC'].includes(x.code)));
      rows = [...obs.filter(isEcg).map((o) => ({ id: o.id, when: when(o), type: 'ECG', with: o.performer?.[0]?.display || '', description: o.valueString || o.interpretation?.[0]?.text || '12-lead ECG', badge: statusChip(o.status), complaint: '', discharge: '', tags: tagsOf(me(o.performer?.[0]?.display) && 'me', 'ancillary'),
        preview: pane('ECG', [['Recorded', fmtDateTime(when(o))], ['Status', statusBadge(o.status)], ['Reading', o.valueString || o.interpretation?.[0]?.text]], h('p', {}, h('a', { href: `${base}/ecg?id=${o.id}`, testid: `card-open-ecg-${o.id}`, 'aria-label': 'Open the trace' }, 'Open the trace'))) })),
      ...reports.filter(isEcho).map((r) => ({ id: r.id, when: r.issued || r.effectiveDateTime, type: 'Echo report', with: r.resultsInterpreter?.[0]?.display || '', description: display(r.code) || 'Echocardiogram', badge: statusChip(r.status), complaint: '', discharge: '', tags: tagsOf(me(r.resultsInterpreter?.[0]?.display) && 'me', 'ancillary'),
        preview: pane(display(r.code) || 'Echocardiogram', [['Status', statusBadge(r.status)], ['Read by', r.resultsInterpreter?.[0]?.display], ['Issued', fmtDateTime(r.issued)]], h('div', { class: 'note-body' }, reportText(r) || 'No report text')) }))];
    } else if (current === 'labs') {
      rows = labs.map((o) => ({ id: o.id, when: when(o), type: 'Lab', with: o.performer?.[0]?.display || '', description: `${display(o.code)}: ${o.valueQuantity?.value ?? o.valueString ?? ''} ${o.valueQuantity?.unit || ''}`.trim(), badge: interp(o) && interp(o) !== 'N' ? badge(interp(o), interp(o).length === 2 ? 'solid-danger' : 'danger') : null, complaint: '', discharge: '', tags: tagsOf(me(o.performer?.[0]?.display) && 'me', 'ancillary'),
        preview: pane(display(o.code), [['Value', `${o.valueQuantity?.value ?? o.valueString ?? ''} ${o.valueQuantity?.unit || ''}`], ['Collected', fmtDateTime(when(o))], ['Status', statusBadge(o.status)], ['Flag', interp(o)]], h('div', { class: 'toolbar', style: 'margin-top:0.625rem' }, open('Open the result', () => labDialog(o), `review-open-${o.id}`))) }));
      testid = 'review-labs-table'; below = labs.length ? [h('h3', { style: 'margin:1rem 0 0.5rem' }, 'Result grid'), labsGrid()] : null;
    } else if (current === 'imaging') {
      // Whole-slide images are reached through their pathology case, not listed as studies.
      const studies = D('ImagingStudy').filter((x) => !(x.modality || []).some((m) => m.code === 'SM'));
      const addenda = D('DiagnosticReport').filter((r) => ext(r, 'urn:hospital-desktop:addendum-of') && r.status !== 'preliminary');
      const reportOf = (study) => reports.find((r) => (r.imagingStudy || []).some((x) => x.reference === `ImagingStudy/${study.id}`));
      const reportCard = (title, link, report, pathology) => () => h('div', { testid: 'imaging-report' }, h('h2', { style: 'margin-top:0' }, title), link,
        report ? [kv([['Result status', statusBadge(report.status)], ['Signed by', report.resultsInterpreter?.[0]?.display], ['Issued', fmtDateTime(report.issued)]]), h('h3', { style: 'margin-top:0.75rem' }, pathology ? 'Final diagnosis' : 'Impression'), h('div', { class: 'note-body', testid: 'report-impression' }, report.conclusion || ''), h('h3', { style: 'margin-top:0.75rem' }, pathology ? 'Microscopic description' : 'Findings'), h('div', { class: 'note-body' }, ext(report, pathology ? 'urn:hospital-desktop:report-micro' : 'urn:hospital-desktop:report-findings') || ''), h('h3', { style: 'margin-top:0.75rem' }, pathology ? 'Gross description' : 'Technique'), h('div', { class: 'note-body' }, ext(report, pathology ? 'urn:hospital-desktop:report-gross' : 'urn:hospital-desktop:report-technique') || ''),
          addenda.filter((a) => ext(a, 'urn:hospital-desktop:addendum-of') === `DiagnosticReport/${report.id}`).map((a) => h('div', { class: 'banner info' }, h('strong', {}, `Addendum · ${a.resultsInterpreter?.[0]?.display || ''} · ${fmtDateTime(a.issued)}`), h('div', { class: 'note-body' }, ext(a, 'urn:hospital-desktop:report-findings') || ''))), ['final', 'amended', 'appended', 'corrected'].includes(report.status) ? h('div', { class: 'toolbar', style: 'margin-top:0.75rem' }, releaseButton(report)) : null]
          : h('p', { class: 'muted', testid: 'imaging-no-report' }, 'No report yet'));
      rows = [...studies.map((st) => { const r = reportOf(st); const exam = st.description || display(st.procedureCode) || 'Imaging study'; const modality = st.series?.[0]?.modality?.code || st.modality?.[0]?.code || 'Imaging';
        return { id: st.id, when: st.started, type: modality, with: r?.resultsInterpreter?.[0]?.display || st.referrer?.display || '', description: exam, badge: statusChip(r?.status || 'unread'), complaint: st.reasonCode?.[0]?.text || '', discharge: '', tags: tagsOf(me(r?.resultsInterpreter?.[0]?.display) && 'me', 'ancillary'),
          preview: reportCard(exam, h('p', {}, h('a', { href: `/pacs/#/study/${st.id}`, target: '_blank', rel: 'noopener', testid: 'view-images', 'aria-label': 'View images in PACS' }, 'View images in PACS')), r, false) }; }),
      ...orders.filter((o) => hasCat(o, 'imaging') && OPEN_ORDER.includes(lifecycle(o))).map(orderRow('Imaging order')),
      ...reports.filter((r) => hasCat(r, 'pathology')).map((r) => ({ id: r.id, when: r.issued || r.effectiveDateTime, type: 'Pathology', with: r.resultsInterpreter?.[0]?.display || '', description: display(r.code) || 'Surgical pathology', badge: statusChip(r.status), complaint: '', discharge: '', tags: tagsOf('ancillary'),
        preview: reportCard(display(r.code) || 'Surgical pathology', h('p', {}, h('a', { href: `/pathology/#/case/${r.specimen?.[0]?.reference?.split('/')[1] || ''}`, target: '_blank', rel: 'noopener', testid: 'view-slides', 'aria-label': 'View slides in Pathology' }, 'View slides in Pathology')), r, true) }))];
      testid = 'imaging-table';
      toolbar = [h('a', { href: `/pacs/#/worklist?q=${encodeURIComponent(mrn(p))}`, target: '_blank', rel: 'noopener', class: 'btn small', testid: 'image-archive', 'aria-label': 'Image Archive: open this patient in PACS', style: 'display:inline-flex;align-items:center', onClick: () => patientContext.set(p.id) }, 'Image Archive')];
    } else if (current === 'meds') {
      rows = meds.map((m) => ({ id: m.id, when: m.authoredOn || when(m), type: 'Medication', with: m.requester?.display || '', description: [display(m.medicationCodeableConcept), m.dosageInstruction?.[0]?.text].filter(Boolean).join(' · '), badge: statusChip(lifecycle(m)), complaint: m.reasonCode?.[0]?.text || '', discharge: '', tags: tagsOf(me(m.requester?.display) && 'me'),
        preview: pane(display(m.medicationCodeableConcept), [['Sig', m.dosageInstruction?.[0]?.text], ['Status', medStatus(m)], ['Ordered', fmtDateTime(m.authoredOn)], ['Ordered by', m.requester?.display], ['Reason', m.reasonCode?.[0]?.text]], h('div', { class: 'toolbar', style: 'margin-top:0.625rem' }, medActions(m))) }));
      testid = 'review-meds-table';
    } else if (current === 'referrals') rows = orders.filter(isReferral).map(orderRow('Referral'));
    else if (current === 'media') {
      const upload = h('input', { type: 'file', accept: 'image/*,application/pdf', testid: 'media-file', 'aria-label': 'Choose a document or image to upload', hidden: true, onChange: async (e) => {
        const file = e.target.files?.[0]; if (!file) return;
        try {
          if (file.size > 4 * 1024 * 1024) throw new Error('Choose a file under 4 MB');
          const data = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = () => no(new Error('The file could not be read')); r.readAsDataURL(file); });
          const made = await fhir.create({ resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', subject, date: now(), author: author(), description: file.name.slice(0, 160), type: { coding: [{ system: DOC_TYPE, code: 'media', display: 'Uploaded media' }], text: 'Uploaded media' }, content: [{ attachment: { contentType: file.type || 'application/octet-stream', title: file.name.slice(0, 160), data } }] });
          await fhir.transition(made, 'final'); done(`Uploaded: ${file.name}`);
        } catch (err) { toast(err.message, { error: true }); }
      } });
      toolbar = [upload, btn('Upload', { small: true, write: true, perm: ['DocumentReference', 'create'], testid: 'media-upload', onClick: () => upload.click() })];
      rows = media.map((d) => { const a = d.content?.[0]?.attachment || {}; const kind = /^image\//.test(a.contentType || '') ? 'Image' : a.contentType === 'application/pdf' ? 'PDF document' : 'Document';
        return { id: d.id, when: when(d), type: kind, with: d.author?.[0]?.display || '', description: d.description || a.title || 'Untitled', complaint: '', discharge: '', tags: tagsOf(me(d.author?.[0]?.display) && 'me'),
          preview: () => h('div', {}, h('h2', { style: 'margin-top:0' }, d.description || a.title || 'Untitled'), kv([['Type', a.contentType], ['Added', fmtDateTime(when(d))], ['By', d.author?.[0]?.display]]),
            a.data && /^image\//.test(a.contentType || '') ? h('img', { src: `data:${a.contentType};base64,${a.data}`, alt: d.description || 'Uploaded image', testid: 'media-image', style: 'max-width:100%;margin-top:0.625rem;border:1px solid var(--line);border-radius:0.375rem' })
              : a.data ? h('p', {}, h('a', { href: `data:${a.contentType};base64,${a.data}`, download: a.title || 'document', testid: 'media-download', 'aria-label': 'Download the document' }, 'Download the document')) : a.url ? h('p', {}, h('a', { href: a.url, target: '_blank', rel: 'noopener', testid: 'media-open', 'aria-label': 'Open the document' }, 'Open the document')) : h('p', { class: 'muted' }, 'No data to display')) }; });
    } else rows = orders.filter((o) => !hasCat(o, 'laboratory') && !hasCat(o, 'imaging') && !isReferral(o)).map(orderRow('Order'));
    if (current === 'orders') testid = 'review-orders-table';
    if (current === 'encounters') testid = 'review-encounters-table';
    return [subtabs, h('div', { class: 'chart-body' }, reviewTable({ testid, rows, state, redraw: render, toolbar, empty: emptyText }), below)];
  }

  const TABS = { summary, problems: problemsTab, allergies: allergiesTab, medications: medicationsTab, vitals: vitalsTab, notes: notesTab, orders: ordersTab, encounters: encountersTab, messages: messagesTab, ...nursing, ecg };
  // ----- After-visit summary: a printable page -----
  function visitSummaryPage() {
    const today = fmtDate(new Date());
    const todays = (list, f) => list.filter((r) => f(r) && fmtDate(new Date(f(r))) === today);
    const upcoming = D('Appointment').filter((a) => a.start > now() && !['cancelled', 'noshow'].includes(a.status)).sort((a, b) => a.start.localeCompare(b.start));
    const block = (title, items, testid) => h('section', { class: 'visit-summary-block', testid }, h('h3', {}, title), items.length ? h('ul', {}, items.map((x) => h('li', {}, x))) : h('p', { class: 'muted' }, 'No data to display'));
    return [h('div', { class: 'toolbar noprint' }, h('h2', { class: 'grow' }, 'After-visit summary'), btn('Print', { kind: 'primary', testid: 'visit-summary-print', onClick: async () => { await api.post('/api/visit-summary', { patient: p.id }).catch(() => {}); window.print(); } }), btn('Back to the chart', { testid: 'visit-summary-back', onClick: () => go(`${base}/summary`) })),
      h('article', { class: 'card visit-summary', testid: 'visit-summary' }, h('h1', {}, 'After-visit summary'),
        kv([['Patient', patientName(p)], ['MRN', mrn(p)], ['Date of birth', bornSpan(p)], ['Visit', currentEncounter ? `${currentEncounter.type?.[0]?.text || display(currentEncounter.class) || 'Visit'} · ${fmtDate(when(currentEncounter))}` : today], ['Seen by', currentEncounter?.participant?.[0]?.individual?.display || identity.display]]),
        block('Reason for the visit', currentEncounter?.reasonCode?.[0]?.text ? [currentEncounter.reasonCode[0].text] : [], 'visit-summary-reason'),
        block('Diagnoses', problems.filter((c) => !['inactive', 'resolved'].includes(c.clinicalStatus?.coding?.[0]?.code)).map((c) => display(c.code)), 'visit-summary-diagnoses'),
        block('Your medications', activeMeds.map((m) => [display(m.medicationCodeableConcept), m.dosageInstruction?.[0]?.text].filter(Boolean).join(': ')), 'visit-summary-meds'),
        block('Allergies', activeAllergies.map((a) => display(a.code)), 'visit-summary-allergies'),
        block('Tests and referrals ordered today', todays(orders, (o) => o.authoredOn).map((o) => display(o.code)), 'visit-summary-orders'),
        block('Measurements today', todays(vitals, when).map((o) => `${display(o.code)}: ${vq(o)}`), 'visit-summary-vitals'),
        block('Coming up', upcoming.map((a) => `${fmtDateTime(a.start)} · ${a.appointmentType?.text || 'Appointment'}`), 'visit-summary-upcoming'),
        h('p', { class: 'muted small' }, `Printed ${fmtDateTime(now())}. Simulation only.`))];
  }
  TABS['visit-summary'] = visitSummaryPage;
  TABS.coverage = async () => { const { chartCoverage } = await import('/shared/insurance.js'); try { return await chartCoverage(p.id, render); } catch (err) { return h('div', { class: 'card empty', testid: 'chart-coverage-error' }, err.message); } };

  // ----- Overview: what matters now, on the right -----
  const gaps = [];
  const GAP_ORDER = { 'bp-check': ['8480-6', 'Blood pressure check', 'procedure'], hba1c: ['4548-4', 'Hemoglobin A1c', 'laboratory'], colorectal: ['LOCAL:colorectal-screen', 'Colorectal cancer screening', 'procedure'], mammogram: ['LOCAL:mammogram', 'Breast screening', 'imaging'] };
  const openCodes = new Set(orders.filter((o) => OPEN_ORDER.includes(lifecycle(o))).map((o) => coding(o.code).code));
  const needed = gaps.filter((g) => GAP_ORDER[g.id] && !openCodes.has(GAP_ORDER[g.id][0]));
  const placeGap = async (g) => { const [code, label, category] = GAP_ORDER[g.id];
    const created = await createWithSafety({ resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject, authoredOn: now(), priority: 'routine', requester: { display: identity.display }, ...(currentEncounter ? { encounter: { reference: `Encounter/${currentEncounter.id}` } } : {}),
      category: [{ coding: [{ system: 'urn:hospital-desktop:order-category', code: category }] }], code: { coding: [{ system: code.startsWith('LOCAL:') ? 'urn:hospital-desktop:order' : cat.systems.loinc, code, display: label }] }, reasonCode: [{ text: `Care gap: ${g.name}` }] });
    if (created) done(`Ordered: ${label}`); };
  const countEnc = (f) => encounters.filter(f).length;
  const FLOW = [['8867-4', 'HR'], ['8480-6', 'SBP'], ['8462-4', 'DBP'], ['59408-5', 'SpO2'], ['8310-5', 'Temp'], ['29463-7', 'Wt']];
  const flowTimes = [...new Set(vitals.filter((o) => FLOW.some(([c]) => coding(o.code).code === c)).map(when))].sort().reverse().slice(0, 3);
  const overview = h('aside', { class: 'overview', testid: 'overview', 'aria-label': 'Overview' },
    h('button', { type: 'button', class: 'link asof', testid: 'overview-refresh', 'aria-label': 'Refresh the chart', onClick: () => render() }, `Current as of ${fmtDateTime(now())}. Click to refresh.`),
    h('section', { class: 'card' }, h('h3', {}, 'Index'), h('div', { class: 'index', testid: 'overview-index' }, [['notes', 'Notes'], ['review/labs', 'Labs'], ['review/imaging', 'Rad'], ['review/meds', 'Meds'], ['orders', 'Orders'], ['review/referrals', 'Referrals'], ['messages', 'Messages'], ['problems', 'Problems'], ['review/media', 'Media'], ['vitals', 'Vitals']].map(([to, label]) => h('a', { href: `${base}/${to}`, testid: `overview-link-${to.replace('/', '-')}`, 'aria-label': `Go to ${label}` }, label)))),
    ...needed.map((g) => h('div', { class: 'gap', testid: `care-gap-${g.id}`, role: 'alert' }, h('span', {}, `This patient needs: ${g.name}${g.last ? ` (last ${g.last})` : ' (none on record)'}`), view.readOnly ? null : btn(`Place the ${GAP_ORDER[g.id][1]} order`, { small: true, write: true, perm: ['ServiceRequest', 'create'], testid: `care-gap-place-${g.id}`, onClick: () => placeGap(g) }))),
    h('section', { class: 'card', testid: 'overview-counters' }, h('h3', {}, 'Visit counters'), kv([['Visits', String(countEnc((e) => e.class?.code === 'AMB'))], ['ED visits', String(countEnc((e) => e.class?.code === 'EMER'))], ['Admissions', String(countEnc((e) => ['IMP', 'ACUTE', 'NONAC', 'OBSENC', 'SS'].includes(e.class?.code)))], ['Notes', String(notes.length)], ['Open orders', String(orders.filter((o) => OPEN_ORDER.includes(lifecycle(o))).length)]])),
    h('section', { class: 'card', testid: 'overview-insurance' }, h('h3', {}, `Active insurance as of ${fmtDate(new Date())}`), coverageText ? kv([['Plan', coverageText], ['Member number', coverageList[0]?.subscriberId || member?.memberNumber], ['Covered from', coverageList[0]?.period?.start || member?.start]]) : h('p', { class: 'muted small', style: 'margin:0' }, `No active insurance coverage on file for ${fmtDate(new Date())}.`)),
    h('section', { class: 'card', testid: 'overview-flowsheet' }, h('h3', {}, 'Review flowsheet'), flowTimes.length ? h('table', { class: 'mini', testid: 'overview-flow-table' }, h('thead', {}, h('tr', {}, h('th', {}, ''), flowTimes.map((t) => h('th', {}, fmtDateTime(t).slice(5))))), h('tbody', {}, FLOW.map(([code, label]) => h('tr', {}, h('th', {}, label), flowTimes.map((t) => h('td', {}, vitals.find((o) => coding(o.code).code === code && when(o) === t)?.valueQuantity?.value ?? '')))))) : h('p', { class: 'muted small', testid: 'overview-flow-empty', style: 'margin:0' }, 'No data to display')),
  );
  const activeDx = problems.filter((c) => !['inactive', 'resolved'].includes(c.clinicalStatus?.coding?.[0]?.code)).length;
  const bottom = h('div', { class: 'chartbar noprint', testid: 'chart-bottom', role: 'toolbar', 'aria-label': 'Chart actions' },
    btn('+ Add Order', { write: true, perm: ['ServiceRequest', 'create'], testid: 'bottom-add-order', onClick: () => go(`${base}/orders?add=1`) }),
    btn(`+ Add Dx (${activeDx})`, { write: true, perm: ['Condition', 'create'], testid: 'bottom-add-dx', onClick: () => go(`${base}/problems?add=1`) }),
    h('span', { class: 'grow' }), btn('Print visit summary', { testid: 'bottom-print-visit-summary', onClick: () => go(`${base}/visit-summary`) }));
  const content = activity === 'review' ? reviewTab() : h('div', { class: 'chart-body' }, await (TABS[activity] || summary)());
  // The bottom bar's buttons land on the right screen with the entry form ready.
  if (query.get('add')) setTimeout(() => { const el = document.querySelector(activity === 'problems' ? '[data-testid="problem-add"]' : '[data-testid="order-search"] input, input[data-testid="order-search"]'); if (activity === 'problems') el?.click(); else el?.focus(); history.replaceState(null, '', `${base}/${activity}`); }, 0);
  if (activity === 'summary') setTimeout(async () => { await showAdvisories(p.id, 'chart-open'); await cdsPatientView(p.id, currentEncounter?.id || null); }, 0);
  return h('div', { class: `chart${activity === 'visit-summary' ? ' printing' : ''}`, testid: 'chart' }, sidebar, h('div', { class: 'chart-main' }, tabs, content, bottom), overview);
}
