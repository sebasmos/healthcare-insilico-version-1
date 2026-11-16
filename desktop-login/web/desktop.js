// The workstation: lock screen, menu bar, dock and desktop windows (plan-master
// task 1). Logging in saves the role, as before; it is not security. Every app
// opens in a window (an iframe of its own page) and shares the patient context.
import { createRecorder } from '/shared/recorder.js';
import { patientContext } from '/shared/context.js';
import { identity } from '/shared/fhir.js';
import { loadRoles } from '/shared/roles.js';
import { capture } from '/shared/capture.js';

const $ = (id) => { const el = document.getElementById(id); if (!el) throw new Error(`The workstation page has no #${id} element`); return el; };
const APPS = [['ehr', 'EHR'], ['pacs', 'PACS'], ['pathology', 'Pathology'], ['lab', 'Lab'], ['pharmacy', 'Pharmacy'], ['beds', 'Beds'], ['monitoring', 'Monitoring'], ['portal', 'Patient Portal'], ['visit', 'Simulated Consultation'], ['payer', 'Payer'], ['agent-ops', 'Agent Dashboard']];
const DARK = new Set(['pacs', 'pathology']);
const store = { get(k, d = null) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* ignore */ } } };
// Before sign-in on a hosted platform nothing is recorded: the trace endpoint needs a session.
const recorder = createRecorder({ app: 'desktop', fetch: (...a) => (authMode.email && !authMode.signedIn ? Promise.resolve(new Response(null, { status: 204 })) : globalThis.fetch(...a)) });
recorder.setContext({ role: identity.role, userId: identity.user || null });
recorder.attach();
patientContext.bindRecorder((id) => recorder.setContext({ patient: id ? `Patient/${id}` : null }));

// ---------- wallpaper ----------
// The built-in wallpaper: a desert dune at dusk, drawn here so nothing is committed as an image.
const BUILTIN = `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2f6b"/><stop offset=".45" stop-color="#6b67a6"/><stop offset=".78" stop-color="#d9a37a"/><stop offset="1" stop-color="#e9c495"/></linearGradient>
<linearGradient id="lit" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f1c58a"/><stop offset="1" stop-color="#c98a52"/></linearGradient>
<linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5a3322"/><stop offset="1" stop-color="#2a1711"/></linearGradient>
<linearGradient id="far" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5d4d7a"/><stop offset="1" stop-color="#3c2f55"/></linearGradient></defs>
<rect width="1600" height="900" fill="url(#sky)"/>
<ellipse cx="300" cy="190" rx="260" ry="26" fill="#f3d2b5" opacity=".35"/><ellipse cx="1180" cy="150" rx="320" ry="22" fill="#f3d2b5" opacity=".3"/>
<path d="M0 560 L140 500 L260 540 L380 470 L520 530 L600 560 L0 560Z" fill="url(#far)"/><path d="M1000 560 L1120 490 L1240 520 L1380 450 L1500 510 L1600 480 L1600 560Z" fill="url(#far)"/>
<path d="M0 900 L0 640 C260 590 520 470 760 330 C840 290 900 300 960 330 C1120 430 1340 560 1600 600 L1600 900Z" fill="url(#shade)"/>
<path d="M0 900 L0 680 C300 640 560 540 760 330 C700 420 640 520 600 640 C560 760 520 850 500 900Z" fill="url(#lit)"/>
<path d="M760 330 C840 300 900 310 960 330 C1000 400 1040 500 1100 600 C1150 690 1200 790 1260 900 L560 900 C600 760 660 580 760 330Z" fill="#3a2016" opacity=".9"/>
<path d="M0 900 L0 820 C400 760 900 760 1600 820 L1600 900Z" fill="#241410" opacity=".8"/></svg>`)}`;
const wallpaperEl = $('wallpaper');
let papers = [];
async function loadWallpapers() {
  try { papers = (await (await fetch('/api/wallpapers')).json()).wallpapers || []; } catch { papers = []; }
  applyWallpaper();
}
// Defaults on this computer: a file named lock.* in data/wallpapers for the lock
// screen and desktop.* for the desktop. A choice under Change wallpaper wins on the desktop.
const fileNamed = (stem) => papers.find((p) => p.replace(/\.[^.]+$/, '').toLowerCase() === stem);
const onLock = () => !$('lock').hidden;
function currentPaper(where = onLock() ? 'lock' : 'desktop') {
  const saved = store.get(where === 'lock' ? 'hd.lockWallpaper' : 'hd.wallpaper');
  if (saved === 'builtin' && !papers.length) return 'builtin';
  if (saved && papers.includes(saved)) return saved;
  if (where === 'lock') return fileNamed('lock') || currentPaper('desktop');
  return fileNamed('desktop') || papers[0] || 'builtin';
}
function applyWallpaper() {
  const name = currentPaper();
  wallpaperEl.style.backgroundImage = name === 'builtin' ? `url("${BUILTIN}")` : `url("/wallpapers/${encodeURIComponent(name)}")`;
  wallpaperEl.dataset.wallpaper = name;
}

// ---------- clock ----------
const fmtTime = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDate = (d) => d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
function tick() { const d = new Date(); $('lock-time').textContent = fmtTime(d); $('lock-date').textContent = fmtDate(d); $('menu-clock').textContent = `${fmtDate(d).split(',')[0].slice(0, 3)} ${fmtTime(d)}`; }
tick(); setInterval(tick, 15000);

// ---------- roles and login ----------
const roleSelect = $('role'); const patientSelect = $('patient'); const userInput = $('user');
const { roles, built } = await loadRoles();
let patients = [];
// A role from an earlier build (pharmacist, radiologist and so on) shows as Physician in the login list; stored records keep their role.
const loginRole = (id) => (roles.some((r) => r.id === id) ? id : (roles.find((r) => r.id === 'physician') || roles[0]).id);
for (const role of roles) { const o = document.createElement('option'); o.value = role.id; o.textContent = role.label; o.selected = role.id === loginRole(identity.role); roleSelect.append(o); }
userInput.value = identity.user;
const roleOf = (id) => roles.find((r) => r.id === id) || roles[0];
const initials = (text) => text.split(/[\s-]+/).filter(Boolean).map((p) => p[0]).join('').slice(0, 2).toUpperCase() || '?';
function updateAvatar() { $('avatar').textContent = initials(userInput.value.trim() || roleOf(roleSelect.value).label); }
async function loadPatients() {
  if (patients.length || authMode.email) return patients;
  try { patients = (await (await fetch('/auth/patients')).json()).patients || []; } catch { patients = []; }
  patientSelect.replaceChildren();
  if (!patients.length) { const o = document.createElement('option'); o.value = ''; o.textContent = 'No patients registered yet'; patientSelect.append(o); }
  for (const pt of patients) { const o = document.createElement('option'); o.value = pt.id; o.textContent = `${pt.family}, ${pt.given}${pt.mrn ? ` · ${pt.mrn}` : ''}`; o.selected = pt.id === patientContext.get(); patientSelect.append(o); }
  return patients;
}
async function onRoleChange() { updateAvatar(); const patientRole = roleSelect.value === 'patient'; patientSelect.hidden = !patientRole; if (patientRole) await loadPatients(); }
roleSelect.addEventListener('change', onRoleChange);
userInput.addEventListener('input', updateAvatar);

function login() {
  identity.role = roleSelect.value; identity.user = userInput.value.trim();
  if (roleSelect.value === 'patient' && patientSelect.value) patientContext.set(patientSelect.value);
  recorder.setContext({ role: identity.role, userId: identity.user || null });
  store.set('hd.session', 'in');
  recorder.record('nav', { route: '/#login' });
  showDesktop();
}
$('login').addEventListener('submit', (e) => { e.preventDefault(); login(); });

// ---------- sign-in ----------
// How this platform lets people in comes from the server (GET /auth/mode):
//   demo   - "Try as" a role, no password (the form above);
//   open   - whoever runs the platform continues as the Researcher; invited people sign in with email and password;
//   locked - everyone signs in. The person who runs the platform uses the admin password.
let authMode = { demo: true, locked: false, me: null, signedIn: false };
async function loadAuthMode() { try { authMode = await (await fetch('/auth/mode')).json(); } catch { /* an older server: the demonstration form */ } return authMode; }
function enterAs(me) {
  identity.role = me.role; identity.user = me.operator || me.demo ? '' : me.id;
  store.set('hd.demo', me.demo ? '1' : null);
  try { localStorage.setItem('hd.name', me.operator ? '' : me.name || ''); } catch { /* ignore */ }
  if (me.role === 'patient' && me.patientId) patientContext.set(me.patientId);
  recorder.setContext({ role: identity.role, userId: identity.user || null });
  store.set('hd.session', 'in'); recorder.record('nav', { route: '/#login' });
  showDesktop();
}
const post = async (path, body) => { const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || j.message || 'That did not work'); return j; };
function drawLockForms(which = 'signin') {
  // The hosted sign-in: an email, a role, and nothing else on the page.
  if (authMode.email) { for (const id of ['login', 'demo', 'signin', 'accept']) $(id).hidden = true; $('emailform').hidden = false; drawEmailRoles(false); $('email-note').textContent = ''; return; }
  $('login').hidden = true; $('demo').hidden = !authMode.demo; if (authMode.demo) drawDemoButtons(); $('signin').hidden = authMode.demo || which !== 'signin'; $('accept').hidden = authMode.demo || which !== 'accept';
  $('continue-researcher').hidden = authMode.locked;
  $('signin-email').placeholder = authMode.locked ? 'Email (leave empty if you run this platform)' : 'Email';
  $('signin-note').textContent = ''; $('accept-note').textContent = '';
}
// Demo mode: "Try as" one of the four roles. Try as Patient is given a patient at random by the server.
const tryAs = async (role) => { try { const out = await post('/auth/demo', { role }); enterAs(out.me); } catch (err) { $('demo-note').textContent = err.message; } };
// Six buttons. The Payer button asks which of the two insurer roles.
function drawDemoButtons() {
  const box = $('demo-buttons'); const mk = (label, testid, onClick) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'login'; b.dataset.testid = testid; b.setAttribute('aria-label', label); b.textContent = label; b.addEventListener('click', onClick); return b; };
  const top = () => box.replaceChildren(...(authMode.demoButtons || []).map((d) => (d.role ? mk(`Try as ${d.label}`, `try-as-${d.role}`, () => tryAs(d.role)) : mk(`Try as ${d.label}`, 'try-as-payer', () => { const q = document.createElement('span'); q.className = 'note'; q.dataset.testid = 'try-as-payer-question'; q.style.color = '#dfe3ff'; q.textContent = d.ask; box.replaceChildren(q, ...d.choices.map((c) => mk(c.label, `try-as-${c.role}`, () => tryAs(c.role))), mk('Back', 'try-as-back', top)); box.querySelector('button')?.focus(); }))));
  top();
}
// An invitation link (/#invite=<code>) opens the form for choosing a password, with the code filled in.
const inviteCode = () => /^#invite=([A-Za-z0-9_-]{10,})$/.exec(location.hash)?.[1] || null;
function useInvite() { const code = inviteCode(); if (!code || authMode.demo || $('lock').hidden) return false; drawLockForms('accept'); $('accept-code').value = code; history.replaceState(null, '', location.pathname); $('accept-password').focus(); return true; }
window.addEventListener('hashchange', useInvite);
$('signin').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { const out = await post('/auth/login', { email: $('signin-email').value, password: $('signin-password').value }); $('signin-password').value = ''; await loadAuthMode(); enterAs(out.me); }
  catch (err) { $('signin-password').value = ''; $('signin-note').textContent = err.message; }
});
$('continue-researcher').addEventListener('click', async () => { await post('/auth/logout', {}).catch(() => {}); await loadAuthMode(); enterAs({ id: 'researcher', role: 'researcher', operator: true }); });
// ---- the hosted sign-in ----
function drawEmailRoles() {
  const sel = $('email-role'); const keep = sel.value;
  sel.replaceChildren(...(authMode.roles || []).map((r) => { const o = document.createElement('option'); o.value = r.id; o.textContent = r.label; return o; }));
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}
// When the email field is left, the server checks that it is a real address.
$('email-input').addEventListener('blur', async () => {
  const email = $('email-input').value.trim().toLowerCase(); $('email-input').value = email; if (!email) return;
  try { await post('/auth/check-email', { email }); $('email-note').textContent = ''; } catch (err) { $('email-note').textContent = err.message; }
});
$('emailform').addEventListener('submit', async (e) => {
  e.preventDefault(); const email = $('email-input').value.trim().toLowerCase(); $('email-input').value = email; const role = $('email-role').value;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s.]{2,}$/.test(email)) { $('email-note').textContent = 'Please enter a real email address.'; return; }
  $('email-note').textContent = 'Checking…';
  try { const out = await post('/auth/signin', { email, role }); try { localStorage.setItem('hd.email', email); } catch { /* ignore */ } $('email-note').textContent = ''; await loadAuthMode(); enterAs({ id: out.me.id, role: out.me.role, patientId: out.me.patientId, name: out.me.name || '' }); }
  catch (err) { $('email-note').textContent = err.message; }
});
$('signin-invited').addEventListener('click', () => { drawLockForms('accept'); $('accept-code').focus(); });
$('accept-back').addEventListener('click', () => { drawLockForms('signin'); $('signin-email').focus(); });
$('accept').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { const out = await post('/auth/accept', { code: $('accept-code').value, password: $('accept-password').value }); $('accept-password').value = ''; $('accept-code').value = ''; await loadAuthMode(); enterAs(out.me); }
  catch (err) { $('accept-password').value = ''; $('accept-note').textContent = err.message; }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

function showLock() {
  $('desktop').hidden = true; $('lock').hidden = false; closeMenu(); applyWallpaper();
  roleSelect.value = loginRole(identity.role); userInput.value = authMode.demo ? identity.user : ''; onRoleChange();
  wallpaperEl.style.filter = '';
  drawLockForms('signin');
  if (useInvite()) { /* the invitation form is showing */ }
  else if (authMode.demo) document.querySelector('[data-testid="try-as-researcher"]').focus(); else $('signin-email').focus();
}

// ---------- desktop: menu bar, dock, windows ----------
const dock = $('dock'); const windowsEl = $('windows'); const menu = $('menu'); const sysmenu = $('sysmenu');
const windows = new Map(); // app -> { el, frame, minimised }
let zTop = 10; let frontApp = null;
const positionsKey = () => `hd.windows.${identity.role}`;
const positions = () => { try { return JSON.parse(store.get(positionsKey(), '{}')) || {}; } catch { return {}; } };
const savePosition = (app, pos) => { const all = positions(); all[app] = pos; store.set(positionsKey(), JSON.stringify(all)); };
const landingOf = (role, app) => (role.landing?.app === app && built[app] ? role.landing.hash : '');

function openMenu() { menu.hidden = false; sysmenu.setAttribute('aria-expanded', 'true'); }
function closeMenu() { menu.hidden = true; sysmenu.setAttribute('aria-expanded', 'false'); }
sysmenu.addEventListener('click', (e) => { e.stopPropagation(); if (menu.hidden) openMenu(); else closeMenu(); });
document.addEventListener('click', (e) => { if (!menu.contains(e.target)) closeMenu(); });
function sysDialog({ title, body, actions = [], testid }) {
  const dlg = document.createElement('dialog'); dlg.className = 'sys'; dlg.dataset.testid = testid; dlg.setAttribute('aria-label', title);
  const header = document.createElement('header'); header.textContent = title;
  const main = document.createElement('div'); main.className = 'body'; main.append(...[].concat(body));
  const footer = document.createElement('footer');
  for (const a of actions) { const b = document.createElement('button'); b.type = 'button'; b.textContent = a.label; b.dataset.testid = `${testid}-${a.label.toLowerCase().replace(/\W+/g, '-')}`; b.setAttribute('aria-label', a.label); if (a.primary) b.className = 'primary'; b.addEventListener('click', () => { a.onClick?.(); dlg.close(); dlg.remove(); }); footer.append(b); }
  dlg.append(header, main, footer); document.body.append(dlg); dlg.addEventListener('close', () => dlg.remove()); dlg.showModal();
  return dlg;
}
const p = (text, cls) => { const el = document.createElement('p'); el.textContent = text; if (cls) el.className = cls; return el; };
document.querySelector('[data-testid="menu-about"]').addEventListener('click', () => { closeMenu(); const el = document.createElement('p'); const a = (href, text) => { const x = document.createElement('a'); x.href = href; x.textContent = text; x.target = '_blank'; x.rel = 'noopener'; return x; };
  el.append('Healthcare InSilico is an open-source, deployable, multimodal clinical environment designed to simulate diverse aspects of the healthcare system. You can read more on our website here: ', a('https://sonalisharma-3.github.io/healthcareinsilico', 'https://sonalisharma-3.github.io/healthcareinsilico'), ' and contact ', a('mailto:sonali3@stanford.edu', 'sonali3@stanford.edu'), ' for any questions.');
  sysDialog({ title: 'About this platform', testid: 'about', body: [el], actions: [{ label: 'OK', primary: true }] }); });
document.querySelector('[data-testid="menu-wallpaper"]').addEventListener('click', async () => {
  closeMenu();
  // The lock screen and the desktop are chosen separately.
  const choices = papers.length ? papers.map((f) => [f, f.replace(/\.[^.]+$/, '')]) : [['builtin', 'Built-in picture']];
  const section = (where, title) => { const grid = document.createElement('div'); grid.className = 'papers'; grid.dataset.testid = `wallpaper-${where}`; const key = where === 'lock' ? 'hd.lockWallpaper' : 'hd.wallpaper'; let chosen = currentPaper(where);
  const draw = () => { grid.replaceChildren(...choices.map(([id, label]) => { const b = document.createElement('button'); b.type = 'button'; b.dataset.testid = `wallpaper-${where}-${id === 'builtin' ? 'builtin' : id.replace(/\W+/g, '-')}`; b.setAttribute('aria-label', `${title}: ${label}`); b.setAttribute('aria-pressed', String(id === chosen)); const t = document.createElement('div'); t.className = 'thumb'; t.style.backgroundImage = id === 'builtin' ? `url("${BUILTIN}")` : `url("/wallpapers/${encodeURIComponent(id)}")`; const s = document.createElement('span'); s.textContent = label; b.append(t, s); b.addEventListener('click', () => { chosen = id; store.set(key, id); applyWallpaper(); draw(); }); return b; })); };
  draw(); const h = document.createElement('h4'); h.textContent = title; return [h, grid]; };
  sysDialog({ title: 'Change wallpaper', testid: 'wallpaper-dialog', body: [...section('desktop', 'Desktop'), ...section('lock', 'Lock screen'), p('Drop .jpg, .png or .webp files in data/wallpapers to add choices. They stay on this computer.', 'note')], actions: [{ label: 'Done', primary: true }] });
});
document.querySelector('[data-testid="menu-lock"]').addEventListener('click', () => { closeMenu(); showLock(); });
document.querySelector('[data-testid="menu-logout"]').addEventListener('click', () => { closeMenu(); store.set('hd.session', null); if (!authMode.demo) fetch('/auth/logout', { method: 'POST' }).catch(() => {}); for (const app of [...windows.keys()]) closeWindow(app); showLock(); });

function say(button, text) { const tip = button.querySelector('.tip'); tip.textContent = text; button.classList.add('said'); setTimeout(() => { button.classList.remove('said'); tip.textContent = button.dataset.name; }, 1400); }
function drawDock() {
  const role = roleOf(identity.role);
  dock.style.setProperty("--dock-n", String(APPS.length)); // icons shrink together when the dock would be wider than the screen
  dock.replaceChildren(...APPS.map(([app, name]) => {
    const allowed = role.apps.includes(app) && built[app];
    const b = document.createElement('button'); b.type = 'button'; b.dataset.testid = `dock-${app}`; b.dataset.app = app; b.dataset.name = name; b.className = allowed ? '' : 'off';
    b.setAttribute('aria-label', allowed ? `Open ${name}` : `${name}: not available for this role`); b.setAttribute('aria-disabled', String(!allowed));
    const img = document.createElement('img'); img.src = `/shared/icons/${app}.svg`; img.alt = '';
    const dot = document.createElement('span'); dot.className = 'dot';
    const tip = document.createElement('span'); tip.className = 'tip'; tip.textContent = allowed ? name : 'Not available for this role';
    b.append(img, dot, tip);
    if (windows.has(app)) b.classList.add('open');
    b.addEventListener('click', () => { if (!allowed) { say(b, 'Not available for this role'); return; } openApp(app); });
    return b;
  }));
}
function openApp(app) {
  const existing = windows.get(app);
  if (existing) { if (existing.minimised) { existing.minimised = false; existing.el.hidden = false; } bringToFront(app); dockAuto(); return existing; }
  const role = roleOf(identity.role);
  const name = APPS.find(([a]) => a === app)[1];
  // Apps open filling the desktop below the menu bar; making a window smaller is remembered per app.
  const saved = positions()[app] || { max: true };
  const n = windows.size;
  const el = document.createElement('div'); el.className = `win${DARK.has(app) ? ' dark' : ''}${saved?.max ? ' max' : ''}`; el.dataset.testid = `window-${app}`; el.dataset.app = app; el.setAttribute('role', 'region'); el.setAttribute('aria-label', `${name} window`);
  const w = saved?.w || Math.min(1180, window.innerWidth - 80); const hgt = saved?.h || Math.min(760, window.innerHeight - 140);
  el.style.left = `${saved?.x ?? 40 + n * 28}px`; el.style.top = `${saved?.y ?? 20 + n * 28}px`; el.style.width = `${w}px`; el.style.height = `${hgt}px`;
  const bar = document.createElement('div'); bar.className = 'titlebar';
  const lights = document.createElement('div'); lights.className = 'lights';
  const mk = (cls, label, testid, onClick) => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.dataset.testid = testid; b.setAttribute('aria-label', label); b.title = label; b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); }); return b; };
  lights.append(mk('close', `Close ${name}`, `win-close-${app}`, () => closeWindow(app)), mk('min', `Minimise ${name}`, `win-min-${app}`, () => minimise(app)), mk('max', `Full size ${name}`, `win-max-${app}`, () => toggleMax(app)));
  const icon = document.createElement('img'); icon.src = `/shared/icons/${app}.svg`; icon.alt = '';
  const title = document.createElement('span'); title.className = 'name'; title.textContent = name;
  bar.append(lights, icon, title);
  const frame = document.createElement('iframe'); watchFrame(frame); frame.dataset.testid = `win-frame-${app}`; frame.title = name; frame.setAttribute('aria-label', `${name} app`); frame.src = `/${app}/?window=1${landingOf(role, app)}`;
  const grip = document.createElement('div'); grip.className = 'resize'; grip.dataset.testid = `win-resize-${app}`; grip.setAttribute('aria-label', `Resize ${name}`);
  el.append(bar, frame, grip);
  windowsEl.append(el);
  const win = { el, frame, minimised: false, name };
  windows.set(app, win);
  // Drag by the title bar; resize by the corner. The iframe stops taking pointer events while dragging so the pointer is not lost.
  bar.addEventListener('pointerdown', (e) => { if (e.button !== 0 || el.classList.contains('max')) return; bringToFront(app); const sx = e.clientX - el.offsetLeft; const sy = e.clientY - el.offsetTop; document.body.classList.add('dragging'); const move = (ev) => { el.style.left = `${Math.max(0, ev.clientX - sx)}px`; el.style.top = `${Math.max(0, ev.clientY - sy)}px`; }; const up = () => { document.body.classList.remove('dragging'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); remember(app); }; window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); });
  bar.addEventListener('dblclick', () => toggleMax(app));
  grip.addEventListener('pointerdown', (e) => { e.preventDefault(); bringToFront(app); document.body.classList.add('dragging'); const move = (ev) => { el.style.width = `${Math.max(360, ev.clientX - el.offsetLeft)}px`; el.style.height = `${Math.max(240, ev.clientY - el.offsetTop - 34)}px`; }; const up = () => { document.body.classList.remove('dragging'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); remember(app); }; window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); });
  el.addEventListener('pointerdown', () => bringToFront(app), true);
  bringToFront(app);
  drawDock();
  dockAuto();
  recorder.record('nav', { route: `/#open/${app}` });
  return win;
}
function remember(app) { const w = windows.get(app); if (!w) return; savePosition(app, { x: w.el.offsetLeft, y: w.el.offsetTop, w: w.el.offsetWidth, h: w.el.offsetHeight, max: w.el.classList.contains('max') }); }
function bringToFront(app) { const w = windows.get(app); if (!w) return; zTop += 1; w.el.style.zIndex = String(zTop); frontApp = app; $('front-app').textContent = w.name; }
function closeWindow(app) { const w = windows.get(app); if (!w) return; remember(app); w.el.remove(); windows.delete(app); if (frontApp === app) { frontApp = null; $('front-app').textContent = 'Workstation'; } drawDock(); dockAuto(); }
function minimise(app) { const w = windows.get(app); if (!w) return; w.minimised = true; w.el.hidden = true; if (frontApp === app) { frontApp = null; $('front-app').textContent = 'Workstation'; } dockAuto(); }
function toggleMax(app) { const w = windows.get(app); if (!w) return; w.el.classList.toggle('max'); remember(app); bringToFront(app); dockAuto(); }
// A click inside an iframe never reaches this page; focus moving into a frame tells which window is in front.
window.addEventListener('blur', () => { setTimeout(() => { const f = document.activeElement; if (f?.tagName === 'IFRAME') { const app = f.dataset.testid?.replace('win-frame-', ''); if (app && windows.has(app)) bringToFront(app); } }, 0); });

async function patientLabel(id) {
  if (!id) return '';
  try { const r = await fetch(`/fhir/R4/Patient/${id}`); if (!r.ok) return 'Patient'; const pt = await r.json(); const n = pt.name?.[0]; const mrn = (pt.identifier || []).find((i) => i.type?.coding?.some((c) => c.code === 'MR'))?.value; return `${n?.family || ''}${n?.given ? `, ${n.given.join(' ')}` : ''}${mrn ? ` · ${mrn}` : ''}`; } catch { return 'Patient'; }
}
async function drawContext() { const id = patientContext.get(); $('patient-ctx').textContent = id ? `Patient: ${await patientLabel(id)}` : ''; }
patientContext.onChange(() => drawContext());
// Agent panel badge (task 9.2): how many agent requests wait for a person, with a toast when the count rises.
let lastWaiting = 0;
async function drawAgentBadge() {
  const el = $('agent-badge'); if (!el) return;
  let n = 0;
  try { if (store.get('hd.session') && (!authMode.email || authMode.signedIn)) { const r = await fetch('/agent-ops/panel/waiting', { headers: { 'X-Role': identity.role || 'physician', 'X-User-Id': identity.user || '' } }); if (r.ok) n = (await r.json()).waiting || 0; } } catch { n = 0; }
  el.hidden = !n; el.textContent = n ? `Agent asks: ${n}` : '';
  if (n > lastWaiting) { try { let host = document.getElementById('toasts'); if (!host) { host = document.createElement('div'); host.id = 'toasts'; host.setAttribute('role', 'status'); document.body.append(host); } const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('data-testid', 'agent-toast'); t.textContent = 'The agent is waiting for you. Open the Agent panel in the app.'; host.append(t); setTimeout(() => t.remove(), 6000); } catch { /* ignore */ } }
  lastWaiting = n;
}
setInterval(() => drawAgentBadge().catch(() => {}), 10000);
function drawWho() { const role = roleOf(identity.role); const shown = (!authMode.demo && store.get("hd.name")) || (authMode.demo ? identity.user : ""); const label = shown ? `${role.label} · ${shown}` : role.label; $("who").textContent = authMode.demo ? `Demo · ${label}` : label; $("who").dataset.demo = String(Boolean(authMode.demo)); }
function drawMode() { let mode = null; try { mode = JSON.parse(store.get('hd.mode', 'null')); } catch { mode = null; } const chip = $('mode-chip'); chip.hidden = !mode?.label; if (mode?.label) chip.textContent = mode.label; }
window.addEventListener('storage', (e) => { if (e.key === 'hd.mode') drawMode(); });
setInterval(() => { $('rec-dot').hidden = !capture.active; }, 2000);

function showDesktop() {
  $('lock').hidden = true; $('desktop').hidden = false; applyWallpaper();
  drawWho(); drawDock(); drawContext(); drawMode();
  // The desktop starts empty after logging in: no window opens on its own.
  dockAuto();
}

// ---------- dock auto-hide ----------
// Shown while no window is open, while the pointer is on it or near the bottom of the browser window, and while it has keyboard focus; otherwise it slides away.
// Reveal: the pointer stays within DOCK_EDGE_PX of the bottom of the browser window for DOCK_REVEAL_MS.
// Hide: DOCK_HIDE_MS after the pointer has left both that band and the dock. Nothing reveals while a mouse button is held (a drag).
// The pointer is followed on this page and inside every app window: a page never sees pointer moves over an iframe,
// so each app frame gets its own listener and its position is converted to this page's coordinates.
const DOCK_EDGE_PX = 50, DOCK_REVEAL_MS = 120, DOCK_HIDE_MS = 600;
let dockTimer = null; let revealTimer = null; let overDock = false; let nearEdge = false;
const anyWindowShown = () => [...windows.values()].some((w) => !w.minimised);
function setDock(shown) { dock.classList.toggle('away', !shown); dock.dataset.shown = String(shown); }
const cancelReveal = () => { clearTimeout(revealTimer); revealTimer = null; };
function dockAuto() {
  clearTimeout(dockTimer); dockTimer = null;
  if (!anyWindowShown() || overDock || dock.contains(document.activeElement)) { setDock(true); return; }
  if (nearEdge && dock.dataset.shown === 'true') return; // still at the bottom: stay up
  dockTimer = setTimeout(() => { dockTimer = null; if (!overDock && !nearEdge && anyWindowShown() && !dock.contains(document.activeElement)) setDock(false); }, DOCK_HIDE_MS);
}
/** The pointer is at height y (this page's coordinates); buttons is the pointer event's buttons value. */
function pointerAt(y, buttons) {
  const held = buttons !== 0 || document.body.classList.contains('dragging');
  const near = y >= window.innerHeight - DOCK_EDGE_PX;
  const shown = dock.dataset.shown === 'true';
  if (near && (shown || !held)) {
    nearEdge = true;
    if (shown) { clearTimeout(dockTimer); dockTimer = null; return; }
    if (!revealTimer) revealTimer = setTimeout(() => { revealTimer = null; if (nearEdge && !document.body.classList.contains('dragging')) { clearTimeout(dockTimer); dockTimer = null; setDock(true); } }, DOCK_REVEAL_MS); // moving within the band does not restart the wait
    return;
  }
  nearEdge = false; cancelReveal();
  if (shown && !overDock && !dockTimer) dockAuto(); // one hide countdown, not restarted by every move
}
document.addEventListener('pointermove', (e) => pointerAt(e.clientY, e.buttons), { passive: true });
/** Follow the pointer inside an app window. Called each time the frame loads a page (the listener is lost on navigation). */
function watchFrame(frame) {
  const hook = () => {
    let win; try { win = frame.contentWindow; void win.document; } catch { return; } // a page from elsewhere cannot be followed
    if (!win || win.__dockWatch) return; win.__dockWatch = true;
    const move = (e) => pointerAt(frame.getBoundingClientRect().top + e.clientY, e.buttons);
    win.addEventListener('pointermove', move, { passive: true, capture: true });
    win.addEventListener('mousemove', move, { passive: true, capture: true });
  };
  frame.addEventListener('load', hook); hook();
}
dock.addEventListener('pointerenter', () => { overDock = true; cancelReveal(); clearTimeout(dockTimer); dockTimer = null; setDock(true); });
dock.addEventListener('pointerleave', () => { overDock = false; dockAuto(); });
dock.addEventListener('focusin', () => { clearTimeout(dockTimer); setDock(true); });
dock.addEventListener('focusout', () => setTimeout(dockAuto, 0));

await loadAuthMode();
await loadWallpapers();
updateAvatar();
// A browser that thinks it is signed in is believed only while the server agrees (or in a demonstration).
const stillIn = authMode.email ? authMode.signedIn : store.get('hd.session') === 'in' && (authMode.demo || authMode.signedIn || (!authMode.locked && identity.role === 'researcher'));
if (authMode.email && authMode.signedIn) { identity.role = authMode.me.role; identity.user = authMode.me.id; if (authMode.me.patientId) patientContext.set(authMode.me.patientId); store.set('hd.session', 'in'); }
if (stillIn) { await onRoleChange(); showDesktop(); } else { store.set('hd.session', null); showLock(); }
