// The one browser smoke test (plan-master): from the lock screen, log in as
// each of the six roles; Physician, Nurse and Researcher open every dock app
// in a desktop window, Patient opens only the Portal and the Agent Dashboard and the rest stay shut, zero console errors, back arrow and browser Back work on one deep
// screen per app, log out. Then the router survives a permission map it
// cannot filter by (no redirect loop). Tests use the built-in wallpaper.
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/apps-open.mjs
//   BASE_URL=http://localhost:3000 ... runs against a server that is already up.
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTestServer, patient } from '../support/helpers.mjs';
import { demoLogin } from '../support/demo-login.mjs';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch { console.log('SKIPPED: Playwright is not installed. Set PLAYWRIGHT_MODULE to its path to run the browser test.'); process.exit(0); }

const external = process.env.BASE_URL || null;
const s = external ? { base: external.replace(/\/$/, ''), close: async () => {}, call: async (method, p, body, headers = {}) => { const r = await fetch(`${external.replace(/\/$/, '')}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { json = null; } return { status: r.status, json, text }; } } : await startTestServer({ webRoot: REPO_ROOT });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome' });
const t = (id) => `[data-testid="${id}"]`;
const steps = [];
const step = async (name, fn) => { await fn(); steps.push(name); console.log(`ok - ${name}`); };
const APPS = ['ehr', 'pacs', 'pathology', 'lab', 'pharmacy', 'beds', 'monitoring', 'portal', 'visit', 'payer', 'agent-ops'];
// One screen deeper than the app's home, reachable without more fixtures than a registered patient.
const DEEP = { payer: () => '#/claims', visit: () => '#/history', ehr: (p) => `#/chart/${p.id}/summary`, pacs: () => '#/upload', pathology: () => '#/upload', lab: () => '#/criticals', pharmacy: () => '#/dispense', monitoring: () => '#/alerts', portal: () => '#/notes', 'agent-ops': () => '#/cds' };
const RENDERED = '.topbar, [data-testid="patient-name"], [data-testid="load-error"], h1';
const errorsOf = (page, name, errors) => {
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (409|422|423|403)/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
};
// The dock slides away while a window is in use: the pointer at the bottom edge brings it back.
const revealDock = async (page) => { const { height } = page.viewportSize(); await page.mouse.move(400, height - 30); await page.mouse.move(402, height - 28); await page.waitForSelector('[data-testid="dock"][data-shown="true"]'); };
const dockClick = async (page, app) => { await revealDock(page); await page.click(t(`dock-${app}`)); };
const frameOf = (page, app) => page.frames().find((f) => f.url().includes(`/${app}/`));

try {
  const { roles, built } = await (await fetch(`${s.base}/auth/roles`)).json();
  assert.deepEqual(roles.map((r) => r.id).sort(), ['coder', 'nurse', 'patient', 'payer-medical-director', 'physician', 'researcher'], 'six roles');
  const STAFF = new Set(['physician', 'nurse', 'researcher']);
  const fixture = (await s.call('POST', '/fhir/R4/Patient', patient('Zzsmoke', { name: [{ family: 'Zzsmoke', given: ['Test'] }] }))).json;
  assert.ok(fixture?.id, 'a synthetic patient for the deep screens');

  // Roles run three at a time: each opens every app it may use, which is the slow part.
  const perRole = async (role) => {
    const allowed = APPS.filter((a) => role.apps.includes(a) && built[a]);
    if (STAFF.has(role.id)) assert.deepEqual(allowed, APPS.filter((a) => built[a]), `${role.id} opens every app`);
    else if (role.id === 'payer-medical-director') assert.deepEqual(allowed, APPS.filter((a) => ['payer', 'agent-ops'].includes(a) && built[a]), 'the insurer roles open only the Payer Portal and the Agent Dashboard');
    else if (role.id === 'coder') assert.deepEqual(allowed, APPS.filter((a) => ['ehr', 'agent-ops'].includes(a) && built[a]), 'the coder works in the EHR and has My work');
    else assert.deepEqual(allowed, APPS.filter((a) => ['portal', 'agent-ops'].includes(a) && built[a]), 'the patient opens only the Portal and the Agent Dashboard (My work)');
    if (STAFF.has(role.id)) { assert.equal(role.writes, '*', `${role.id} has full access`); assert.deepEqual(role.readOnlyApps, [], `${role.id} has no read-only apps`); }
    await step(`${role.label}: logs in at the lock screen, opens ${allowed.join(', ')} in windows, greyed-out apps stay shut, one deep screen navigates back, logs out`, async () => {
      const context = await browser.newContext({ viewport: { width: 1600, height: 960 } });
      context.setDefaultTimeout(20000);
      await context.addInitScript(() => { localStorage.setItem('hd.wallpaper', 'builtin'); localStorage.setItem('hd.lockWallpaper', 'builtin'); });
      const errors = [];
      const page = await context.newPage(); errorsOf(page, role.id, errors);
      await page.goto(`${s.base}/`);
      await page.waitForSelector(t('lock-screen'));
      assert.equal(await page.getAttribute(t('wallpaper'), 'data-wallpaper'), 'builtin');
      for (const gone of ['desktop-sleep', 'desktop-restart', 'desktop-shutdown', 'off-screen', 'sleep-screen']) assert.equal(await page.locator(t(gone)).count(), 0, `the lock screen has no ${gone}`);
      // Six buttons: six roles.
      assert.equal(await page.locator(`${t('demo-form')} button`).count(), 6);
      await page.click(t(`try-as-${role.id}`));
      await page.waitForSelector(t('desktop'));
      await page.waitForSelector(t('dock'));
      assert.equal(await page.locator('.win').count(), 0, 'the desktop starts empty: no window opens on its own');
      assert.equal(await page.getAttribute(t('dock'), 'data-shown'), 'true', 'with no window open the dock stays up');
      assert.match(await page.textContent(t('menubar-role')), new RegExp(role.label));
      for (const app of APPS) {
        const dockButton = page.locator(t(`dock-${app}`));
        if (!allowed.includes(app)) {
          assert.equal(await dockButton.getAttribute('aria-disabled'), 'true', `${role.id}: ${app} is greyed out`);
          await revealDock(page);
          await dockButton.click({ force: true });
          await page.waitForTimeout(150);
          assert.equal(await page.locator(t(`window-${app}`)).count(), 0, `${role.id}: ${app} did not open`);
          assert.match(await dockButton.locator('.tip').textContent(), /Not available for this role/);
          continue;
        }
        await revealDock(page);
        await dockButton.click();
        await page.waitForSelector(t(`window-${app}`));
        assert.ok(await page.locator(t(`window-${app}`)).evaluate((el) => el.classList.contains('max')), `${role.id}: ${app} opens filling the desktop`);
        const frame = page.frameLocator(t(`win-frame-${app}`));
        await frame.locator(RENDERED).first().waitFor({ timeout: 30000 });
        const f = frameOf(page, app);
        assert.ok(f && f.url().includes('window=1'), `${role.id}: ${app} opened in a window`);
        assert.ok(await page.locator(t(`dock-${app}`)).evaluate((b) => b.classList.contains('open')), `${role.id}: the dock shows ${app} as open`);
        assert.equal(await frame.locator('.topbar .appname').first().isVisible().catch(() => false), false, `${role.id}: ${app} hides its own top-bar name inside a window`);
        assert.match(await page.textContent(t('front-app')), /\S/, 'the menu bar names the front app');
      }
      // One deep screen for the landing app (or the first allowed app with one): breadcrumb, back arrow, browser Back.
      const deepApp = [role.landing?.app, ...allowed].find((a) => a && allowed.includes(a) && DEEP[a]);
      if (deepApp) {
        await dockClick(page, deepApp); // bring its window to the front
        const f = frameOf(page, deepApp);
        const home = await f.evaluate(() => location.hash);
        await f.evaluate((hash) => { location.hash = hash; }, DEEP[deepApp](fixture));
        const frame = page.frameLocator(t(`win-frame-${deepApp}`));
        await frame.locator(`${t('crumbs')}:not([hidden])`).waitFor({ timeout: 20000 });
        assert.ok((await frame.locator(t('crumb-0')).textContent()).length > 1, 'the breadcrumb starts with the app');
        // A chart may open with the advisories dialog (its set depends on the day); accept it so the screen is clear.
        if (deepApp === 'ehr') { await frame.locator(t('patient-name')).waitFor({ timeout: 20000 }); }
        const advisories = frame.locator(t('advisories-accept'));
        // Ignore each advisory first: enacting one creates a task, which some roles may not do.
        try { await advisories.waitFor({ timeout: 4000 }); for (const b of await frame.locator('[data-testid^="advisory-"][data-testid$="-ignore"]').all()) await b.click(); await advisories.click(); await advisories.waitFor({ state: 'detached' }); } catch { /* none today */ }
        const deep = DEEP[deepApp](fixture);
        const hashOf = () => f.evaluate(() => location.hash);
        await frame.locator(t('crumb-back')).click();
        await page.waitForFunction(({ app, d }) => { const fr = [...document.querySelectorAll('iframe')].find((i) => i.src.includes(`/${app}/`)); return fr && fr.contentWindow.location.hash !== d; }, { app: deepApp, d: deep });
        const upOne = await hashOf();
        assert.notEqual(upOne, deep, 'the back arrow went up one level');
        await f.evaluate((hash) => { location.hash = hash; }, deep);
        await frame.locator(`${t('crumbs')}:not([hidden])`).waitFor();
        await page.evaluate(() => history.back()); // the browser Back button: joint history includes the window's hash change
        await page.waitForFunction(({ app, h }) => { const fr = [...document.querySelectorAll('iframe')].find((i) => i.src.includes(`/${app}/`)); return fr && fr.contentWindow.location.hash === h; }, { app: deepApp, h: upOne }, { timeout: 15000 });

      }
      // Windows close, minimise and come back from the dock.
      const last = allowed[allowed.length - 1];
      await dockClick(page, last);
      await page.click(t(`win-min-${last}`));
      assert.ok(await page.locator(t(`window-${last}`)).evaluate((el) => el.hidden), 'minimised');
      await dockClick(page, last);
      assert.ok(await page.locator(t(`window-${last}`)).evaluate((el) => !el.hidden), 'back from the dock');
      for (const app of allowed) { await dockClick(page, app); await page.click(t(`win-close-${app}`)); }
      assert.equal(await page.locator('.win').count(), 0);
      await page.click(t('system-menu'));
      await page.click(t('menu-logout'));
      await page.waitForSelector(t('lock-screen'));
      assert.deepEqual(errors, []);
      await context.close();
    });
  };
  const wanted = process.env.ROLES ? roles.filter((r) => process.env.ROLES.split(',').includes(r.id)) : roles; // ROLES=scheduler,billing narrows a run
  for (let i = 0; i < wanted.length; i += 3) await Promise.all(wanted.slice(i, i + 3).map(perRole));

  await step('Desktop: a big lock clock, a bigger dock that hides while a window is used and comes back at the bottom edge, names on hover, maximised windows that remember being made smaller, "Patient Portal"', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => { localStorage.setItem('hd.wallpaper', 'builtin'); localStorage.setItem('hd.lockWallpaper', 'builtin'); });
    const errors = []; const page = await context.newPage(); errorsOf(page, 'desktop', errors);
    await page.goto(`${s.base}/`);
    await page.waitForSelector(t('lock-screen'));
    const px = (sel, prop = 'fontSize') => page.$eval(sel, (el, p) => parseFloat(getComputedStyle(el)[p]), prop);
    // Every size follows the one number at the top of platform/web/shared/ui.css.
    const scale = Number(/--ui-scale:\s*([0-9.]+)/.exec(await (await fetch(`${s.base}/shared/ui.css`)).text())[1]);
    assert.ok(scale > 0 && await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim()) === String(scale), 'the desktop reads --ui-scale from ui.css');
    const near = (a, b, m) => assert.ok(Math.abs(a - b) < 0.05, `${m}: ${a} vs ${b}`);
    { const c = await px('#lock-time'); assert.ok(c >= 64 * scale - 0.05 && c <= 112 * scale + 0.05, `the lock clock follows the screen width, between 4rem and 7rem (${c})`); }
    { const d = await px('#lock-date'); assert.ok(d >= 18 * scale - 0.05 && d <= 28 * scale + 0.05, `the date follows the screen width, between 1.125rem and 1.75rem (${d})`); }
    await page.click(t('try-as-physician'));
    await page.waitForSelector(t('dock'));
    assert.equal(await page.locator('.win').count(), 0, 'empty desktop');
    { const w = await page.$eval(`${t('dock-ehr')} img`, (el) => el.getBoundingClientRect().width); const vw = page.viewportSize().width; const want = Math.min(102 * scale, (vw - 56 * scale) / 11 - 18 * scale); assert.ok(Math.abs(w - want) <= 1, `dock tiles are 102px (the curated taskbar), shrinking to fit the screen: ${w} vs ${want}`); }
    assert.equal(await page.getAttribute(t('dock-portal'), 'aria-label'), 'Open Patient Portal');
    await page.hover(t('dock-pacs'));
    const tip = page.locator(`${t('dock-pacs')} .tip`);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="dock-pacs"] .tip')).opacity === '1');
    assert.equal(await tip.textContent(), 'PACS');
    assert.ok(await tip.evaluate((el) => parseFloat(getComputedStyle(el).fontSize) >= 20 && el.getBoundingClientRect().bottom < el.parentElement.getBoundingClientRect().top), 'a large name floats above the icon');
    await page.click(t('dock-ehr'));
    const win = page.locator(t('window-ehr'));
    await win.waitFor();
    const box = await win.boundingBox();
    const bar = (await page.locator('#menubar').boundingBox()).height;
    near(bar, 34 * scale, 'the menu bar is 34px times the scale');
    assert.deepEqual([box.x, box.width], [0, 1440], 'maximised across the screen'); near(box.y, bar, 'maximised below the menu bar'); near(box.height, 900 - bar, 'and down to the bottom');
    await page.mouse.move(700, 400);
    await page.waitForSelector('[data-testid="dock"][data-shown="false"]');
    assert.ok((await page.locator(t('dock')).boundingBox()).y >= 900, 'the dock slid off the bottom');
    await page.mouse.move(700, 840); await page.waitForTimeout(400);
    assert.equal(await page.getAttribute(t('dock'), 'data-shown'), 'false', 'more than 50 px above the bottom does not reveal the dock');
    await page.mouse.move(700, 870);
    await page.waitForSelector('[data-testid="dock"][data-shown="true"]');
    await page.mouse.move(700, 400);
    await page.waitForSelector('[data-testid="dock"][data-shown="false"]');
    await page.click(t('win-max-ehr'));
    const small = await win.boundingBox();
    assert.ok(small.width < 1440 && small.height < 866, 'the window button makes it smaller');
    await page.click(t('win-close-ehr'));
    assert.equal(await page.getAttribute(t('dock'), 'data-shown'), 'true', 'no window, dock up');
    await page.click(t('dock-ehr'));
    await win.waitFor();
    assert.equal(await win.evaluate((el) => el.classList.contains('max')), false, 'the smaller size is remembered for this app');
    await page.click(t('win-close-ehr'));
    await page.click(t('dock-portal'));
    await page.waitForSelector(t('window-portal'));
    assert.equal(await page.textContent(`${t('window-portal')} .name`), 'Patient Portal');
    assert.equal(await page.locator(t('window-portal')).evaluate((el) => el.classList.contains('max')), true, 'another app still opens maximised');
    assert.deepEqual(errors, []);
    await context.close();
  });

  await step('picture defaults: a lock.* file shows on the lock screen and a desktop.* file on the desktop, when present; the two are chosen separately; an old role shows as Physician', async () => {
    const { wallpapers = [] } = await (await fetch(`${s.base}/api/wallpapers`)).json();
    const named = (stem) => wallpapers.find((p) => p.replace(/\.[^.]+$/, '').toLowerCase() === stem);
    const lock = named('lock'); const desk = named('desktop') || wallpapers[0] || 'builtin';
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('hd.role', 'pharmacist'); sessionStorage.setItem('seeded', '1'); } });
    const errors = []; const page = await context.newPage(); errorsOf(page, 'pictures', errors);
    await page.goto(`${s.base}/`);
    await page.waitForSelector(t('lock-screen'));
    await page.waitForFunction((want) => document.querySelector('[data-testid="wallpaper"]').dataset.wallpaper === want, lock || desk);
    await page.click(t('try-as-physician'));
    await page.waitForSelector(t('dock'));
    assert.equal(await page.getAttribute(t('wallpaper'), 'data-wallpaper'), desk);
    if (lock) { const r = await fetch(`${s.base}/wallpapers/${encodeURIComponent(lock)}`); assert.equal(r.status, 200, 'the lock picture is served'); }
    await page.click(t('system-menu')); await page.click(t('menu-lock'));
    await page.waitForSelector(t('lock-screen'));
    assert.equal(await page.getAttribute(t('wallpaper'), 'data-wallpaper'), lock || desk);
    // Choose the built-in picture for the lock screen only: the desktop keeps its own.
    await page.click(t('try-as-physician')); await page.waitForSelector(t('dock'));
    await page.click(t('system-menu')); await page.click(t('menu-wallpaper'));
    await page.click(t('wallpaper-lock-builtin'));
    await page.click(t('wallpaper-dialog-done'));
    assert.equal(await page.getAttribute(t('wallpaper'), 'data-wallpaper'), desk, 'the desktop picture is unchanged');
    await page.click(t('system-menu')); await page.click(t('menu-lock'));
    await page.waitForSelector(t('lock-screen'));
    assert.equal(await page.getAttribute(t('wallpaper'), 'data-wallpaper'), 'builtin', 'the lock screen has its own choice');
    assert.deepEqual(errors, []);
    await context.close();
  });

  await step('a permission map without navigation or app lists (an older server) and an unknown role: apps still render, no redirect loop, no console errors', async () => {
    for (const [name, mutate] of [['stale map', (d) => ({ ...d, roles: d.roles.map(({ nav, chartTabs, readOnlyTabs, readOnlyApps, apps, landing, ...rest }) => rest) })], ['unknown role', (d) => d]]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      context.setDefaultTimeout(20000);
      if (name === 'unknown role') await context.addInitScript(() => localStorage.setItem('hd.role', 'from-an-older-build'));
      await context.route('**/auth/roles', async (route) => { const r = await route.fetch(); const d = mutate(await r.json()); await route.fulfill({ response: r, body: JSON.stringify(d), headers: { ...r.headers(), 'content-type': 'application/json' } }); });
      const errors = [];
      for (const app of ['ehr', 'pacs', 'lab']) {
        const page = await context.newPage(); errorsOf(page, `${name} ${app}`, errors);
        let navigations = 0; page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations += 1; });
        await page.goto(`${s.base}/${app}/`);
        await page.waitForSelector(RENDERED, { timeout: 20000 });
        await page.waitForTimeout(1200);
        assert.ok(navigations <= 3, `${name} ${app}: navigated ${navigations} times (loop)`);
        await page.close();
      }
      assert.deepEqual(errors, [], name);
      await context.close();
    }
  });
} finally {
  await browser.close();
  await s.close();
}
console.log(`${steps.length} browser steps passed. Console errors: 0.`);
