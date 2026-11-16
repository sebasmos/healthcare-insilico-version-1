// Shared UI helpers. Every interactive element gets a stable data-testid and
// an aria-label. Rendering depends only on the data passed in.
import { createRecorder } from './recorder.js';
import { mountAgentPanel } from './panel.js';
import { patientContext } from './context.js';
import { view, identity, FhirError, api } from './fhir.js';
import { capture } from './capture.js';
import { ageInfo } from './age.js';
import { loadRoles, gate, readOnlyHere, leaveIfNotAllowed } from './roles.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'testid') el.setAttribute('data-testid', value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') el.value = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// Empties an element. Its append skips null, undefined and false the way h() does, so a missing optional part never shows as the word "null".
export const clear = (el) => { el.replaceChildren(); return { append: (...kids) => { el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return el; } }; };
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/**
 * A button. write: true disables it while viewing a past time and for a read-only role.
 * perm: [type, interaction] disables it, with the reason in the tooltip, when the current role may not do that write.
 * Controls are disabled with a reason, never hidden, so every role sees the same screen.
 */
export function btn(label, { testid, kind = '', onClick, write = false, small = false, title, disabled = false, perm } = {}) {
  const role = perm ? gate(...perm) : write && readOnlyHere() ? { disabled: true, title: 'Researcher is read-only outside Agent Dashboard' } : {};
  const off = disabled || Boolean(role.disabled) || (write && view.readOnly);
  return h('button', {
    type: 'button', testid: testid || `btn-${slug(label)}`, 'aria-label': title || label, title: off && write && view.readOnly ? 'Read-only while viewing a past time' : role.title || title,
    class: [kind, small ? 'small' : ''].filter(Boolean).join(' ') || undefined, disabled: off,
    onClick: async (event) => {
      if (!onClick) return;
      const button = event.currentTarget;
      button.disabled = true;
      try { await onClick(event); } catch (err) { showError(err); } finally { if (button.isConnected) button.disabled = off; }
    },
  }, label);
}

export function badge(text, kind = '', testid) { return h('span', { class: `badge ${kind}`.trim(), testid }, text); }

export function toast(message, { error = false } = {}) {
  let host = document.getElementById('toasts');
  if (!host) { host = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(host); }
  const el = h('div', { class: `toast${error ? ' error' : ''}`, testid: error ? 'toast-error' : 'toast' }, message);
  host.append(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 140); }, error ? 6000 : 3200);
}

export function showError(err) {
  console.warn(err);
  toast(err instanceof FhirError || err?.message ? err.message : 'Something went wrong', { error: true });
}

/** Opens a native dialog. actions: [{ label, kind, testid, onClick(close) }]. */
export function openDialog({ title, body, actions = [], testid = 'dialog', wide = false, danger = false, closable = true, onCancel = null }) {
  const dlg = h('dialog', { testid, class: [wide ? 'wide' : '', danger ? 'alert-danger' : ''].join(' ').trim() || undefined, 'aria-label': title });
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.append(
    h('header', {}, h('h2', {}, title), closable ? h('button', { type: 'button', 'aria-label': 'Close', testid: `${testid}-close`, onClick: close }, '✕') : null),
    h('div', { class: 'body' }, body),
    h('footer', {}, actions.map((a) => btn(a.label, { kind: a.kind, testid: a.testid || `${testid}-${slug(a.label)}`, write: a.write, perm: a.perm, onClick: () => a.onClick(close) }))),
  );
  // Esc closes this dialog only; a dialog with unsaved changes may refuse (onCancel returns false) and ask first.
  dlg.addEventListener('cancel', (e) => { e.stopPropagation(); if (!closable || (onCancel && onCancel() === false)) { e.preventDefault(); return; } dlg.remove(); });
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, close };
}

/** One labelled form control. Returns { el, get(), set(v), input }. */
export function field({ name, label, type = 'text', options = [], value = '', required = false, placeholder, wide = false, list, step, min, max, rows = 6, dictate = false, testid, readonly = false }) {
  const id = testid || `field-${slug(name)}`;
  let input;
  if (type === 'select') {
    input = h('select', { testid: id, 'aria-label': label, name }, options.map((o) => {
      const [v, t] = Array.isArray(o) ? o : [o, o];
      return h('option', { value: v, selected: String(v) === String(value) }, t);
    }));
  } else if (type === 'textarea') {
    input = h('textarea', { testid: id, 'aria-label': label, name, rows, placeholder });
    input.value = value ?? '';
  } else if (type === 'checkbox') {
    input = h('input', { type: 'checkbox', testid: id, 'aria-label': label, name, checked: Boolean(value) });
  } else {
    input = h('input', { type: type === 'typeahead' ? 'text' : type, testid: id, 'aria-label': label, name, placeholder, step, min, max, readonly, autocomplete: 'off' });
    input.value = value ?? '';
  }
  let datalist = null;
  if (list) {
    datalist = h('datalist', { id: `${id}-list` }, list.map((o) => h('option', { value: o })));
    input.setAttribute('list', `${id}-list`);
  }
  if (required) input.required = true;
  const get = () => (type === 'checkbox' ? input.checked : type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value.trim());
  const el = h('label', { class: `field${wide || type === 'textarea' ? ' wide' : ''}` },
    h('span', {}, label, required ? ' *' : ''), input, datalist, dictate ? dictationButton(input, id) : null);
  return { el, get, set: (v) => { if (type === 'checkbox') input.checked = Boolean(v); else input.value = v ?? ''; }, input, name };
}

/** A dialog built from field specs. onSubmit(values, helpers) may throw to show an error. */
export function formDialog({ title, fields, submitLabel = 'Save', onSubmit, testid = 'form', intro, wide = false, onChange }) {
  const controls = fields.filter(Boolean).map(field);
  const byName = Object.fromEntries(controls.map((c) => [c.name, c]));
  const error = h('div', { class: 'form-error', testid: `${testid}-error`, role: 'alert' });
  const extra = h('div', { testid: `${testid}-extra` });
  const values = () => Object.fromEntries(controls.map((c) => [c.name, c.get()]));
  let dirty = false;
  const form = h('form', { class: 'form', onInput: () => { dirty = true; onChange?.(values(), byName, extra); } }, controls.map((c) => c.el));
  // Leaving a form with changes asks first (task 1.5).
  const discard = (c) => { if (!dirty) { c(); return true; } confirmDialog({ title: 'Discard changes?', message: 'This form has unsaved changes.', confirmLabel: 'Discard', testid: `${testid}-discard` }).then((ok) => { if (ok) c(); }); return false; };
  const { dlg, close } = openDialog({
    title, testid, wide, onCancel: () => discard(() => { dlg.close(); dlg.remove(); }),
    body: [intro ? h('p', { class: 'muted' }, intro) : null, form, extra, error],
    actions: [
      { label: 'Cancel', testid: `${testid}-cancel`, onClick: (c) => discard(c) },
      { label: submitLabel, kind: 'primary', testid: `${testid}-submit`, onClick: async (c) => {
        error.textContent = '';
        if (!form.reportValidity()) return;
        try {
          const keepOpen = await onSubmit(values(), { controls: byName, extra, error, close: c });
          if (keepOpen !== false) c();
        } catch (err) {
          error.textContent = err.message || 'Could not save';
        }
      } },
    ],
  });
  onChange?.(values(), byName, extra);
  return { dlg, close, controls: byName, extra, error };
}

/** Asks for a typed reason. Resolves to the text, or null if cancelled. */
export function askReason({ title, label = 'Reason', submitLabel = 'Confirm', intro, testid = 'reason' }) {
  return new Promise((resolve) => {
    let done = false;
    const { dlg } = formDialog({
      title, intro, submitLabel, testid,
      fields: [{ name: 'reason', label, type: 'text', required: true, wide: true }],
      onSubmit: ({ reason }) => { if (reason.length < 3) throw new Error('Please type a reason (at least 3 characters)'); done = true; resolve(reason); },
    });
    dlg.addEventListener('close', () => { if (!done) resolve(null); });
  });
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', testid = 'confirm', kind = 'primary' }) {
  return new Promise((resolve) => {
    let answered = false;
    const { dlg } = openDialog({
      title, testid, body: h('p', {}, message),
      actions: [
        { label: 'Cancel', onClick: (c) => { c(); } },
        { label: confirmLabel, kind, testid: `${testid}-ok`, onClick: (c) => { answered = true; resolve(true); c(); } },
      ],
    });
    dlg.addEventListener('close', () => { if (!answered) resolve(false); });
  });
}

/** columns: [{ label, render(row), cls }]. groups: optional (row) => group label. */
export function table({ columns, rows, onRow, testid = 'table', empty = 'Nothing to show', rowId = (r) => r.id, group, selected }) {
  if (!rows.length) return h('div', { class: 'tablewrap' }, h('table', { testid }, h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.cls }, c.label)))), h('tbody', {}, h('tr', {}, h('td', { colspan: columns.length, class: 'empty', testid: `${testid}-empty` }, empty)))));
  const body = h('tbody', {});
  let last = null;
  for (const row of rows) {
    const g = group?.(row);
    if (group && g !== last) { last = g; body.append(h('tr', { class: 'group' }, h('td', { colspan: columns.length }, g))); }
    const tr = h('tr', {
      class: [onRow ? 'clickable' : '', selected && selected === rowId(row) ? 'selected' : ''].join(' ').trim() || undefined,
      testid: `${testid}-row-${rowId(row)}`, tabindex: onRow ? 0 : undefined,
      onClick: onRow ? (e) => { if (!e.target.closest('button, a, input, select')) onRow(row); } : undefined,
      onKeydown: onRow ? (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onRow(row); } : undefined,
    }, columns.map((c) => h('td', { class: c.cls }, c.render(row))));
    body.append(tr);
  }
  return h('div', { class: 'tablewrap' }, h('table', { testid }, h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.cls }, c.label)))), body));
}

export const card = (title, ...children) => h('section', { class: 'card', testid: `card-${slug(title)}` }, h('h3', {}, title), ...children);
export const kv = (pairs) => h('dl', { class: 'kv' }, pairs.filter((p) => p && p[1] !== undefined && p[1] !== null && p[1] !== '').flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));

// Dates. All display uses the browser's local time zone, 24-hour clock.
const pad = (n) => String(n).padStart(2, '0');
export function fmtDate(iso) { if (!iso) return ''; const d = new Date(iso); return Number.isNaN(d.getTime()) ? String(iso) : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export function fmtTime(iso) { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
export function fmtDateTime(iso) { return iso ? `${fmtDate(iso)} ${fmtTime(iso)}` : ''; }
export const toLocalInput = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
// Ages come from the server (GET /api/ages), which works them out as of each patient's reference date:
// the as-of time when viewing a past time, the latest encounter or anchor year for a date-shifted source, otherwise today.
const ageCache = new Map();
const ageKey = (id) => `${id}|${view.asOf || ''}|${view.branch}`;
/** Fetch the ages for these patients (documents or ids) before drawing them. Safe to call often. */
export async function loadAges(patients) {
  const ids = [...new Set((patients || []).map((p) => (typeof p === 'string' ? p : p?.id)).filter(Boolean))].filter((id) => !ageCache.has(ageKey(id)));
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    try { const out = await api.get('/api/ages', { ids: chunk.join(',') }); for (const id of chunk) ageCache.set(ageKey(id), out.ages?.[id] ?? null); } catch { /* the page falls back to the local rule below */ }
  }
}
/** "62 y", or "62 y (as of 2180)" when the reference date is not today. Takes a patient (preferred) or a birth date. Never negative. */
export function age(patientOrBirthDate, at = null) {
  const p = typeof patientOrBirthDate === 'object' && patientOrBirthDate ? patientOrBirthDate : { birthDate: patientOrBirthDate };
  const known = p.id ? ageCache.get(ageKey(p.id)) : null;
  if (known) return known.label;
  return ageInfo(p, { asOf: at || view.asOf || null }).label;
}
/**
 * The birth date as people should read it. Some sources (MIMIC) move every date about a century ahead, so a stored
 * birth date can read 2075. For such a patient the year is moved back by however far the reference date is ahead of
 * this year, so the date reads like a real one and agrees with the age shown. Other patients show their date as stored.
 */
export function shownBirthDate(p) {
  const b = String(p?.birthDate || '').slice(0, 10); if (!/^\d{4}/.test(b)) return b;
  const info = (p.id ? ageCache.get(ageKey(p.id)) : null) || ageInfo(p, {});
  if (!info || !['latest-encounter', 'anchor-year'].includes(info.basis)) return b;
  const shift = Number(String(info.reference).slice(0, 4)) - new Date().getUTCFullYear();
  return shift > 0 ? String(Number(b.slice(0, 4)) - shift).padStart(4, '0') + b.slice(4) : b;
}
/** A span with the shown birth date, corrected once the server has worked out the patient's reference date. */
export function bornSpan(p) {
  const el = h('span', { testid: 'patient-born' }, shownBirthDate(p));
  if (p?.id && p.birthDate) loadAges([p]).then(() => { el.textContent = shownBirthDate(p); });
  return el;
}
/** A span that shows the patient's age as soon as the server has worked it out. */
export function ageSpan(p, { suffix = '' } = {}) {
  const el = h('span', { testid: 'patient-age' }, age(p) + (age(p) ? suffix : ''));
  if (p?.id) loadAges([p]).then(() => { el.textContent = age(p) + (age(p) ? suffix : ''); });
  return el;
}
export function relativeGroup(iso, now = new Date()) {
  const days = (now - new Date(iso)) / 86400000;
  if (days < 0) return 'Upcoming';
  if (days < 7) return 'Recent';
  if (days < 180) return 'Last 6 months';
  if (days < 365) return '6 months ago';
  const years = Math.floor(days / 365);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}

export const encodeText = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
export const decodeText = (b64) => { try { return new TextDecoder().decode(Uint8Array.from(atob(b64 || ''), (c) => c.charCodeAt(0))); } catch { return ''; } };

/**
 * Dictation into a text field using the browser's speech recognition, when
 * the browser has it. Some browsers send audio to a cloud speech service, so
 * the first use in a session asks for confirmation.
 */
/** A Dictate button. `input` is a field, or a function that returns the field to write into at that moment
 * (one button for several fields: what is said goes wherever the reader last clicked). */
export function dictationButton(input, id) {
  const target = () => (typeof input === 'function' ? input() : input);
  const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  let active = null; let localRec = null;
  const button = btn('Dictate', {
    testid: `${id}-dictate`, small: true, disabled: !Recognition && !navigator.mediaDevices,
    title: 'Dictate into this field',
    onClick: async () => {
      // Local speech recognition on this machine is used when it is installed, unless the reader chose the browser's own (Settings, Dictation).
      const sp = await import('/shared/speech.js');
      if (localRec) { const rec = localRec; localRec = null; button.textContent = 'Recognising…'; button.disabled = true; try { const said = (await sp.transcribeRecording(rec)).trim(); if (said) { target().value += `${target().value && !/\s$/.test(target().value) ? ' ' : ''}${said}`; keepDictation(id, said); target().dispatchEvent(new Event('input', { bubbles: true })); } else toast('Nothing could be made out', { error: true }); } catch (err) { toast(`Dictation failed: ${err.message}`, { error: true }); } button.textContent = 'Dictate'; button.disabled = false; return; }
      if (sp.dictationChoice() === 'local' && (await sp.speechStatus()).stt && navigator.mediaDevices) { try { localRec = await sp.startRecording(); button.textContent = 'Stop and write'; } catch (err) { toast(`The microphone could not be used: ${err.message}`, { error: true }); } return; }
      if (!Recognition) { toast('Dictation is not available: local speech recognition is not installed and this browser has none.', { error: true }); return; }
      if (active) { active.stop(); return; }
      if (!sessionStorage.getItem('hd.dictation-ok')) {
        const ok = await confirmDialog({ title: 'Use browser dictation?', message: 'Dictation uses your browser\'s speech recognition. In some browsers the audio is processed by an online service. Only use it with synthetic content.', confirmLabel: 'Start dictation', testid: 'dictation-consent' });
        if (!ok) return;
        sessionStorage.setItem('hd.dictation-ok', '1');
      }
      active = new Recognition();
      active.continuous = true;
      active.interimResults = false;
      active.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i += 1) {
          const said = e.results[i][0].transcript.trim();
          target().value += `${target().value && !/\s$/.test(target().value) ? ' ' : ''}${said}`;
          keepDictation(id, said);
        }
        target().dispatchEvent(new Event('input', { bubbles: true }));
      };
      active.onend = () => { active = null; button.textContent = 'Dictate'; };
      active.onerror = () => { toast('Dictation stopped', { error: true }); };
      button.textContent = 'Stop dictation';
      active.start();
    },
  });
  button.style.marginTop = '0.375rem';
  const note = h('span', { class: 'muted small', testid: `${id}-dictate-warning`, style: 'margin-left:0.5rem' }, 'Warning: Chrome sends dictation audio to an external speech service. Use synthetic content only.');
  // With local speech recognition installed (and chosen), the audio never leaves this machine and the warning does not apply.
  import('/shared/speech.js').then(async (sp) => { if (sp.dictationChoice() === 'local' && (await sp.speechStatus()).stt) { note.textContent = 'Dictation is recognised on this machine. No audio is sent anywhere.'; note.dataset.engine = 'local'; } }).catch(() => {});
  return h('div', {}, button, note);
}

// ---------- Recording (Data Annotation → Capture) ----------
/** Sends consented free text for the running recording. Never throws: a refusal must not disturb clinical work. */
export async function sendCaptureContent(kind, text, extra = {}) {
  const rec = capture.active;
  if (!rec || !String(text || '').trim()) return null;
  try { return await api.post(`/agent-ops/capture/${rec.runId}/content`, { kind, text, ...extra }); } catch (err) { console.warn(`recording: ${kind} not kept (${err.message})`); return null; }
}

// A dictated phrase is kept only with dictation consent, on the recording's practice copy, from an allowlisted field.
function keepDictation(field, said) {
  const rec = capture.active;
  if (!rec?.consent?.dictation || !rec.practiceBranch || view.branch !== rec.practiceBranch || !(rec.dictationFields || []).includes(field)) return;
  sendCaptureContent('dictation', said, { field, branch: view.branch });
}

export async function stopRecording() {
  const rec = capture.active;
  if (!rec) return;
  try { await activeRecorder?.flush(); } catch { /* the events stay queued and are sent later */ }
  try { await api.post(`/agent-ops/capture/${rec.runId}/stop`, {}); } catch (err) { if (err.status !== 404) { showError(err); return; } }
  capture.set(null);
  toast('Recording stopped');
  if (rec.practiceBranch && view.branch === rec.practiceBranch) { view.set({ branch: 'main', asOf: null }); location.reload(); }
}

function thinkAloudDialog() {
  formDialog({
    title: 'Think aloud', testid: 'think-aloud', submitLabel: 'Save note',
    intro: 'Say what you are thinking, in your own words. Leave out names and record numbers; anything that looks like one is masked before it is stored.',
    fields: [{ name: 'text', label: 'What are you thinking?', type: 'textarea', rows: 5, required: true, wide: true }],
    onSubmit: async (v) => { const saved = await sendCaptureContent('think-aloud', v.text); toast(saved ? 'Note saved to the recording' : 'The note could not be saved', { error: !saved }); },
  });
}

let whyOpen = false;
function whyPrompt({ what, ref }) {
  if (whyOpen || !capture.active?.consent?.why) return;
  whyOpen = true;
  const text = h('textarea', { rows: 4, testid: 'why-text', 'aria-label': 'Why did you do that?', placeholder: 'One or two sentences. Optional.' });
  const done = () => { whyOpen = false; };
  const dialog = openDialog({
    title: what === 'signed' ? 'Why did you sign this?' : 'Why did you order this?', testid: 'why-prompt',
    body: h('div', {}, h('p', { class: 'muted', style: 'margin-top:0' }, 'This recording asks once at signing and ordering. Skip if you would rather not say.'), text),
    actions: [
      { label: 'Skip', testid: 'why-skip', onClick: (close) => close() },
      { label: 'Save', kind: 'primary', testid: 'why-save', onClick: async (close) => { await sendCaptureContent('why', text.value, { about: ref }); close(); } },
    ],
  });
  for (const type of ['close', 'cancel']) dialog.dlg.addEventListener(type, done);
}

/** The always-visible indicator while a recording is on. Mounted once per app, outside the app's own rendering. */
let activeRecorder = null;
function mountRecordingBar(recorder) {
  activeRecorder = recorder;
  const bar = h('div', { class: 'recbar', testid: 'recording-indicator', role: 'status', 'aria-live': 'polite', hidden: true });
  document.body.append(bar);
  const draw = () => {
    const rec = capture.active;
    // When a recording ends elsewhere, send what this tab still holds under the recording's id before letting go of it.
    if (rec) recorder.setContext({ runId: view.runId }); else Promise.resolve(recorder.flush()).catch(() => {}).finally(() => { if (!capture.active) recorder.setContext({ runId: view.runId }); });
    bar.hidden = !rec;
    clear(bar);
    if (!rec) return;
    const kept = [rec.consent?.thinkAloud ? 'think-aloud notes' : null, rec.consent?.why ? '"why" answers' : null, rec.consent?.dictation ? 'dictation' : null].filter(Boolean);
    bar.append(...[
      h('span', { class: 'recdot', 'aria-hidden': 'true' }),
      h('strong', {}, 'Recording'),
      h('span', { class: 'rectext', testid: 'recording-detail' }, `since ${fmtTime(rec.startedAt)} · clicks and actions${kept.length ? `, ${kept.join(', ')}` : ''}${rec.practiceBranch ? ' · practice copy' : ''}`),
      rec.consent?.thinkAloud ? btn('Think aloud', { small: true, testid: 'recording-think-aloud', onClick: thinkAloudDialog }) : null,
      btn('Stop recording', { small: true, testid: 'recording-stop', onClick: stopRecording }),
    ].filter(Boolean));
  };
  capture.onChange(draw);
  draw();
  window.addEventListener('hd:acted', (e) => whyPrompt(e.detail));
  // A recording stopped elsewhere (or a reset database) must not leave this browser saying "Recording".
  const rec = capture.active;
  if (rec) fetch(`/agent-ops/runs/${encodeURIComponent(rec.runId)}`).then(async (r) => { if (r.status === 404 || (r.ok && (await r.json()).endedAt)) capture.set(null); }).catch(() => {});
}

/** Theme, role selector, recorder and patient context for one app. */
export async function initApp({ app, crumbs = null }) {
  const root = document.documentElement;
  root.dataset.app = app;
  // Opened in a desktop window (?window=1): the window's title bar names the app.
  if (new URLSearchParams(location.search).has('window')) root.dataset.window = '1';
  const unsavedChecks = new Set();
  window.addEventListener('beforeunload', (e) => { if ([...unsavedChecks].some((f) => { try { return f(); } catch { return false; } })) { e.preventDefault(); e.returnValue = ''; } });
  if (crumbs) mountCrumbs(crumbs);
  const themeKey = `hd.theme.${app}`;
  const applyTheme = (t) => { root.dataset.theme = t; };
  let theme = 'light';
  try { theme = localStorage.getItem(themeKey) || (app === 'pacs' ? 'dark' : 'light'); } catch { /* ignore */ }
  applyTheme(theme);

  const recorder = createRecorder({ app });
  recorder.setContext({ role: identity.role, userId: identity.user || null, runId: view.runId, branch: view.branch, asOf: view.asOf, patient: patientContext.get() ? `Patient/${patientContext.get()}` : null });
  recorder.attach();
  patientContext.bindRecorder((id) => recorder.setContext({ patient: id ? `Patient/${id}` : null }));
  patientContext.onChange((id, { remote }) => { if (remote) recorder.setContext({ patient: id ? `Patient/${id}` : null }); });
  view.onChange((s) => recorder.setContext({ asOf: s.asOf, branch: s.branch, runId: view.runId }));
  mountRecordingBar(recorder);

  const roles = (await loadRoles()).roles;
  // An app the role has no use for is not shown on the desktop; opened directly, it hands over to the role's landing page.
  if (leaveIfNotAllowed(app)) await new Promise(() => {});
  const themeToggle = h('button', { type: 'button', testid: 'theme-toggle', 'aria-label': 'Toggle light or dark theme', title: 'Toggle theme', onClick: () => {
    theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(theme);
    try { localStorage.setItem(themeKey, theme); } catch { /* ignore */ }
  } }, '◐');
  // With the hosted sign-in the role comes from the session and cannot be switched here: the top bar shows who is signed in and a Log out button.
  let session = null; try { const m = await (await fetch('/auth/mode')).json(); if (m.email) { if (!m.signedIn) { (window.top || window).location.href = '/'; return new Promise(() => {}); } session = m.me; identity.role = m.me.role; identity.user = m.me.id; if (m.me.patientId) { try { localStorage.setItem('hd.patient', m.me.patientId); } catch { /* ignore */ } } }
  } catch { /* an older server */ }
  const sessionBox = session ? h('span', { class: 'toolbar', testid: 'session-box', style: 'margin:0;gap:0.5rem;flex-wrap:nowrap' }, h('span', { class: 'muted small', testid: 'signed-in-as' }, session.role === 'patient' ? `Signed in as patient ${session.patientNumber}` : session.label),
    h('button', { type: 'button', class: 'small', testid: 'logout', 'aria-label': 'Log out', onClick: async () => { try { await fetch('/auth/logout', { method: 'POST' }); } catch { /* ignore */ } try { localStorage.removeItem('hd.session'); localStorage.removeItem('hd.patient'); } catch { /* ignore */ } (window.top || window).location.href = '/'; } }, 'Log out')) : null;
  const roleSelect = sessionBox || h('select', { testid: 'role-select', 'aria-label': 'Work as', style: 'width:auto', onChange: (e) => {
    identity.role = e.target.value;
    recorder.setContext({ role: identity.role });
    if (leaveIfNotAllowed(app)) return;
    window.dispatchEvent(new Event('hd:role'));
  } }, roles.map((r) => h('option', { value: r.id, selected: r.id === identity.role }, r.label)));
  // The Agent panel (task 9.2): collapsible, on the right, in every hospital app while an agent run is open.
  let panel = null;
  try { panel = mountAgentPanel({ app }); } catch { panel = null; }
  mountEmptyHospitalNote();
  return { session, recorder, roles, themeToggle, roleSelect, panel, unsaved: (fn) => { unsavedChecks.add(fn); return () => unsavedChecks.delete(fn); } };
}

/**
 * Back arrow and breadcrumb for every screen deeper than the app's home (task 1.5), from the hash.
 * crumbs: { app: 'EHR', home: 'dashboard', names: { worklist: 'Tasks' }, resolve(segments, query) → [[label, hash], ...] | null }.
 * Ids in the hash are named after the page's own heading or patient banner once it has rendered.
 */
export function mountCrumbs({ app, home, names = {}, resolve = null }) {
  let up = `#/${home}`;
  const trail = h('span', { class: 'trail', style: 'display:flex;align-items:center;gap:0.375rem;overflow:hidden' });
  // The back button is never rebuilt, so a click lands even while the trail is being renamed.
  const bar = h('div', { class: 'crumbs', testid: 'crumbs', role: 'navigation', 'aria-label': 'Where you are', hidden: true }, h('button', { type: 'button', class: 'back', testid: 'crumb-back', 'aria-label': 'Back one level', title: 'Back', onClick: () => { location.hash = up; } }, '‹'), trail);
  document.body.prepend(bar);
  const pretty = (seg) => names[seg] || seg.replace(/[-_]+/g, ' ').replace(/^\w/, (m) => m.toUpperCase());
  const idLike = (seg) => /^[0-9a-f-]{8,}$|^st-|^\d{3,}$/i.test(seg);
  const heading = () => document.querySelector('[data-testid="patient-name"], #app h1, #app h2')?.textContent?.trim().slice(0, 60) || null;
  let lastKey = null;
  const draw = () => {
    const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
    const segments = path.split('/').filter(Boolean);
    const atHome = !segments.length || (segments.length === 1 && segments[0] === home);
    let parts = atHome ? null : (resolve ? resolve(segments, new URLSearchParams(qs || '')) : null);
    if (!atHome && !parts) parts = segments.map((seg, i) => [idLike(seg) ? (heading() || 'Details') : pretty(seg), `#/${segments.slice(0, i + 1).join('/')}`]);
    bar.hidden = !parts || !parts.length;
    if (bar.hidden) { clear(trail); lastKey = null; return; }
    const chain = [[app, `#/${home}`], ...parts];
    const key = JSON.stringify(chain);
    if (key === lastKey) return;
    lastKey = key;
    up = chain[chain.length - 2][1];
    clear(trail).append(...chain.flatMap(([label, hash], i) => [i ? h('span', { class: 'sep' }, '›') : null, i === chain.length - 1 ? h('span', { class: 'here', testid: `crumb-${i}` }, label) : h('a', { href: hash, testid: `crumb-${i}`, 'aria-label': `Go to ${label}` }, label)]).filter(Boolean));
  };
  window.addEventListener('hashchange', draw);
  let timer = null;
  new MutationObserver(() => { if (bar.hidden) return; clearTimeout(timer); timer = setTimeout(draw, 150); }).observe(document.getElementById('app') || document.body, { childList: true, subtree: true });
  draw();
  bar.redraw = draw; // a page that renders its own names (a study title) redraws at once
  return bar;
}

/** Research mode state for the strips (6.3): polled from the server, plus this browser's recording state. */
const modeState = { data: null, at: 0, listeners: new Set() };
async function refreshMode() { try { modeState.data = await api.get('/agent-ops/mode'); } catch { modeState.data = null; } modeState.at = Date.now(); for (const fn of modeState.listeners) fn(); }
setInterval(refreshMode, 15000);
function modeStrip() {
  const el = h('div', { class: 'modestrip', testid: 'mode-strip', role: 'status', hidden: true });
  const fmtClock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  let timer = null;
  const draw = () => {
    const rec = capture.active; const m = modeState.data;
    const app = document.documentElement.dataset.app;
    clearInterval(timer); timer = null;
    clear(el); el.className = 'modestrip'; el.hidden = true;
    let chip = null;
    if (rec) {
      el.className = 'modestrip recording'; el.hidden = false;
      const kept = [rec.consent?.thinkAloud ? 'reasoning' : null, rec.consent?.why ? '"why?" answers' : null, rec.consent?.dictation ? 'dictation' : null].filter(Boolean);
      const clock = h('b', { testid: 'mode-strip-timer' }, fmtClock(Date.now() - Date.parse(rec.startedAt)));
      timer = setInterval(() => { clock.textContent = fmtClock(Date.now() - Date.parse(rec.startedAt)); }, 1000);
      el.append(h('strong', {}, 'Recording'), ' ', clock, h('span', { class: 'muted' }, ` · capturing clicks, screens and actions${kept.length ? `, ${kept.join(', ')}` : ''}${rec.practiceBranch ? ' · practice copy' : ''}`),
        btn('Reasoning', { small: true, testid: 'mode-reasoning', title: 'Record typed or dictated reasoning for this step', onClick: () => (rec.consent?.thinkAloud ? thinkAloudDialog() : toast('Reasoning capture was not agreed for this recording', { error: true })) }),
        btn(rec.paused ? 'Resume' : 'Pause', { small: true, testid: 'mode-pause', title: 'Pause stops all capture at once', onClick: async () => { try { const out = await api.post(`/agent-ops/runs/${rec.runId}/${rec.paused ? 'resume' : 'pause'}`, {}); capture.set({ ...out, context: { recorder: rec.recorder, consent: rec.consent } }); } catch (err) { showError(err); } } }),
        btn('Stop', { small: true, testid: 'mode-stop', onClick: stopRecording }));
      chip = { label: 'Recording', kind: 'recording' };
    } else if (studySession.get()) {
      // A study session: the mode, the study, and End session, in every app.
      const ss = studySession.get();
      el.className = `modestrip ${ss.goal === 'hitl' ? 'hitl' : 'shadow'} session`; el.hidden = false;
      el.append(h('strong', { testid: 'session-mode' }, `${SESSION_MODE[ss.goal] || 'Study'} session.`), ' ', h('span', {}, `Study: ${ss.title || ''}.`), ' ', h('span', { class: 'muted' }, ss.goal === 'hitl' ? 'The agent drafts and asks; you decide. Everything is logged under the study.' : 'An agent works the same task on a private copy. Everything is logged under the study.'),
        btn('End session', { small: true, testid: 'session-end', onClick: async () => { await studySession.end(); toast('Session ended. The workstation is back to normal.'); location.reload(); } }));
      chip = { label: SESSION_MODE[ss.goal] || 'Study session', kind: ss.goal === 'hitl' ? 'hitl' : 'shadow' };
    } else if (m && app !== 'agent-ops') {
      if (view.branch !== 'main' && /redteam/.test(view.branch) && m.redteam) { el.className = 'modestrip redteam'; el.hidden = false; el.append(h('strong', {}, 'Safety test.'), ' Private copy, synthetic patients only.'); chip = { label: 'Safety test', kind: 'redteam' }; }
      else if (m.hitl) { el.className = 'modestrip hitl'; el.hidden = false; el.append(h('strong', {}, 'Helper mode.'), ' The agent drafts; you decide.'); chip = { label: 'Helper mode', kind: 'hitl' }; }
      else if (m.shadow) { el.className = 'modestrip shadow'; el.hidden = false; el.append(h('strong', {}, 'Shadow mode.'), ' An agent is working on a private copy. You will not see its work.'); chip = { label: 'Shadow mode', kind: 'shadow' }; }
    }
    try { if (chip) localStorage.setItem('hd.mode', JSON.stringify(chip)); else if (app !== 'agent-ops') localStorage.removeItem('hd.mode'); } catch { /* ignore */ }
  };
  modeState.listeners.add(draw); capture.onChange(draw);
  if (!modeState.data && Date.now() - modeState.at > 5000) refreshMode(); else draw();
  return el;
}

/** The strips under the top bar: time travel or branch (when not on live main) and the research mode (6.3). */
export function timeStrip() {
  const wrap = h('div', { class: 'strips' }, taskStrip(), maskStrip(), timeOnly(), modeStrip(), clockStrip());
  return wrap;
}
/**
 * A study session started from the Agent Dashboard: which study, which mode,
 * the human session and the agent's run. Kept in this browser so every app shows it; End session clears it.
 */
const SESSION_KEY = 'hd.session.study';
export const studySession = {
  get() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } },
  set(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); if (s.simrun) localStorage.setItem('hd.simrun', s.simrun); if (s.goal === 'hitl') localStorage.setItem('hd.panel.open', '1'); } catch { /* ignore */ } },
  /** Ends the human session, cancels an agent run still going, and returns the workstation to normal. */
  async end() {
    const s = studySession.get();
    if (s?.simrun) { try { await api.post(`/agent-ops/runs/${s.simrun}/end`, { reason: 'completed' }); } catch { /* already ended */ } }
    for (const id of [s?.agentRun].filter(Boolean)) { try { const r = await api.get(`/agent-ops/runs/${id}`); if (['running', 'paused', 'awaiting-decision'].includes(r.status)) await api.post(`/agent-ops/runs/${id}/cancel`, {}); } catch { /* ignore */ } }
    try { localStorage.removeItem(SESSION_KEY); localStorage.removeItem('hd.simrun'); localStorage.removeItem('hd.mode'); if (s?.goal === 'hitl') localStorage.setItem('hd.panel.open', '0'); } catch { /* ignore */ }
    return s;
  },
};
export const SESSION_MODE = { shadow: 'Shadow Mode', hitl: 'Human in the Loop', redteam: 'Red Teaming' };

/**
 * The task a person is doing for a study, shown in every clinical app opened on that task's copy of the chart:
 * what to do, and a button to finish. A task that needs an answer (a label) is finished in My work.
 */
/** A masked session (the human baseline of an ablation): says plainly which parts of the chart are hidden. */
function maskStrip() {
  const el = h('div', { class: 'modestrip taskstrip', testid: 'mask-strip', role: 'status', hidden: true });
  if (!view.runId || document.documentElement.dataset.app === 'agent-ops') return el;
  api.get(`/agent-ops/runs/${view.runId}`).then((r) => { if (r.mode !== 'sandbox' || r.agentId || !(r.overlayText || []).length || r.endedAt) return; el.append(h('strong', {}, 'Masked chart: '), h('span', { testid: 'mask-strip-text' }, r.overlayText.join(' · ')), h('span', { class: 'muted small' }, ' — hidden on purpose for this study.')); el.hidden = false; }).catch(() => {});
  return el;
}
function taskStrip() {
  const el = h('div', { class: 'modestrip taskstrip', testid: 'task-strip', role: 'status', hidden: true });
  if (view.branch === 'main' || document.documentElement.dataset.app === 'agent-ops') return el;
  (async () => {
    const wk = await api.get('/agent-ops/my-work').catch(() => null);
    const open = (wk?.todo || []).filter((t) => t.state === 'open');
    for (const t of open) {
      const a = await api.get(`/agent-ops/attempts/${t.id}`).catch(() => null);
      if (!a || a.branch !== view.branch) continue;
      const needsAnswer = Boolean(a.labelScheme?.type && a.labelScheme.type !== 'none');
      const done = async () => {
        if (needsAnswer) { location.href = '/agent-ops/#/my-work'; return; }
        try { const out = await api.post(`/agent-ops/attempts/${t.id}/next`, {}); toast(out.done ? 'All your tasks are done' : 'Done. Opening your next task'); location.href = '/agent-ops/#/my-work'; } catch (err) { showError(err); }
      };
      el.append(h('strong', {}, 'Your task: '), h('span', { testid: 'task-strip-title' }, a.task?.title || t.task), a.task?.task ? h('span', { class: 'muted', testid: 'task-strip-instruction' }, ` — ${a.task.task}`) : null,
        h('span', { style: 'flex:1' }), h('span', { class: 'muted small' }, a.studyTitle || ''),
        btn(needsAnswer ? 'Give my answer and finish' : 'Done', { small: true, kind: 'primary', testid: 'task-strip-done', onClick: done }));
      el.hidden = false; return;
    }
  })();
  return el;
}

/** The simulation clock of the scenario run this browser is working in (plan-master task 12): simulated and real time, the mode, Next, Pause, chapters. */
function clockStrip() {
  let runId = null;
  try { runId = localStorage.getItem('hd.simrun'); } catch { runId = null; }
  const el = h('div', { class: 'modestrip clock', testid: 'clock-strip', role: 'status', hidden: true });
  if (!runId || document.documentElement.dataset.app === 'agent-ops') return el;
  const fmtClock = (iso) => (iso ? fmtDateTime(iso) : '');
  const leave = () => { try { localStorage.removeItem('hd.simrun'); } catch { /* ignore */ } el.hidden = true; clearInterval(timer); };
  let timer = null;
  const draw = async () => {
    let st = null;
    try { st = await api.get(`/agent-ops/clock/${runId}`); } catch { leave(); return; }
    clear(el); el.hidden = false;
    const mode = { real: 'real time', accelerated: `accelerated, ${st.speed} minutes a minute`, jump: 'jump to next event', chapters: 'chapters' }[st.mode] || st.mode;
    const parts = [st.task ? h('span', { testid: 'clock-task', class: 'clock-task' }, h('strong', {}, 'Task: '), st.task, ' · ') : null, h('strong', {}, 'Simulated time '), h('b', { testid: 'clock-simulated' }, fmtClock(st.simulated)), h('span', { class: 'muted' }, ` (${st.elapsedLabel} into the story, ${mode}) · real time ${fmtClock(st.real)}`),
      st.chapter ? h('span', { testid: 'clock-chapter' }, ` · Chapter ${st.chapter.index + 1} of ${st.chapter.of}: ${st.chapter.title}`) : null,
      st.next ? h('span', { class: 'muted', testid: 'clock-next-info' }, ` · next: ${st.next.title} in ${st.next.inMinutes} min`) : h('span', { class: 'muted' }, st.finished ? ' · the story has ended' : ''),
      st.mode === 'jump' ? btn('Next event', { small: true, testid: 'clock-next', disabled: !st.next, onClick: async () => { await api.post(`/agent-ops/clock/${runId}/next`, {}); toast('The clock jumped to the next event'); location.reload(); } }) : null,
      st.mode === 'chapters' ? btn('Next chapter', { small: true, testid: 'clock-chapter-next', disabled: st.chapter && st.chapter.index + 1 >= st.chapter.of, onClick: async () => { const out = await api.post(`/agent-ops/clock/${runId}/chapter`, {}); toast(`Chapter ${out.chapter + 1}: ${out.title}. Since last time: ${out.since.map((e) => e.title).join('; ') || 'nothing new'}`); location.reload(); } }) : null,
      ['real', 'accelerated'].includes(st.mode) ? btn(st.paused ? 'Resume' : 'Pause', { small: true, testid: 'clock-pause', onClick: async () => { await api.post(`/agent-ops/clock/${runId}/${st.paused ? 'resume' : 'pause'}`, {}); draw(); } }) : null,
      st.chapter?.since?.length ? h('span', { class: 'muted small', testid: 'clock-since' }, ` · What happened since: ${st.chapter.since.map((e) => e.title).join('; ')}`) : null,
      btn('Leave the story', { small: true, testid: 'clock-leave', onClick: leave })];
    el.append(...parts.filter((x) => x != null && x !== false));
  };
  draw(); timer = setInterval(draw, 5000);
  return el;
}
function timeOnly() {
  if (view.live) return null;
  const parts = [];
  if (view.asOf) parts.push(`Viewing the chart as of ${fmtDateTime(view.asOf)}. Read-only.`);
  if (view.branch !== 'main') parts.push(view.branch.startsWith('sandbox-') ? `Practice copy (${view.branch}). Nothing here reaches the live chart.` : `Branch: ${view.branch}`);
  const back = view.branch !== 'main' ? h('button', { type: 'button', class: 'small', testid: 'return-to-live', 'aria-label': 'Return to the live chart', onClick: () => {
    view.set({ branch: 'main', asOf: null });
    const url = new URL(location.href); url.searchParams.delete('branch'); location.href = url.toString(); if (url.search === location.search) location.reload();
  } }, 'Return to the live chart') : null;
  const text = h('span', {}, parts.join('  ·  '));
  // A time-machine copy names the moment in care it was rewound to.
  if (view.branch !== 'main') api.get('/agent-ops/branches').then(({ branches }) => { const b = (branches || []).find((x) => x.id === view.branch); if (!b?.careCap) return; let shift = 0; try { shift = JSON.parse(localStorage.getItem('hd.timemachine') || '{}')[b.id]?.shift || 0; } catch { /* none */ } const d = new Date(b.careCap); d.setUTCFullYear(d.getUTCFullYear() - shift); text.textContent = `Time machine: the chart as it stood on ${d.toISOString().slice(0, 16).replace('T', ' ')}. A practice copy: nothing here reaches the live chart.`; }).catch(() => {});
  return h('div', { class: 'strip', testid: 'time-strip', role: 'status' }, text, back);
}

/**
 * The release ships with no data. Until a patient is loaded every app says so in one plain line, and lists
 * simply show as empty. The check is repeated as the person moves about, and stops once a patient exists.
 */
function mountEmptyHospitalNote() {
  const note = h('div', { class: 'nopatients', testid: 'no-patients', role: 'status', hidden: true }, 'No patients yet. Import data to begin.');
  document.body.append(note);
  let done = false;
  const check = async () => {
    if (done) return;
    try { if (/^payer-/.test(localStorage.getItem('hd.role') || '')) return; } catch { /* no storage */ }
    try { const b = await api.get('/fhir/R4/Patient', { _count: 1 }); const any = (b.entry || []).length > 0; note.hidden = any; done = any; } catch { /* a role that may not list patients: no note */ }
  };
  check(); window.addEventListener('hashchange', check); window.addEventListener('focus', check);
}
