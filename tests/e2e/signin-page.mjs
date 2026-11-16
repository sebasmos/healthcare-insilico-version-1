// The sign-in page as a browser sees it behind a hosting front end: the browser talks to one address (here a small proxy,
// as a front end does), and the server sees another Host. Not signed in, the page and every script and
// stylesheet it loads answer 200, with no console errors; app pages, admin, data and file routes stay shut; nothing
// can be kept by a shared cache.
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/signin-page.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTestServer } from '../support/helpers.mjs';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch { console.log('SKIPPED: Playwright is not installed. Set PLAYWRIGHT_MODULE to its path to run the browser test.'); process.exit(0); }
// The proxy listens first, so the server can be told its public address, as a hosted server is told its public link.
const proxy = http.createServer(); await new Promise((r) => proxy.listen(0, '127.0.0.1', r)); const PUBLIC = `http://127.0.0.1:${proxy.address().port}`;
process.env.PUBLIC_ORIGINS = PUBLIC;
const dns = { resolveMx: async () => [{ exchange: 'mx.mail.test', priority: 1 }], resolve4: async () => ['192.0.2.1'], resolve6: async () => [] };
const s = await startTestServer({ webRoot: REPO_ROOT, auth: { email: { secret: 'sign-in-page-test-secret-0123456789abcdef', dns, restricted: true, secureCookie: false } } });
const target = new URL(s.base);
proxy.on('request', (req, res) => { // forwards everything, but with the server's own Host, as a hosting front end does
  const up = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: { ...req.headers, host: target.host, 'x-forwarded-for': '198.51.100.20', 'x-forwarded-host': new URL(PUBLIC).host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(up);
});
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome' });
const t = (id) => `[data-testid="${id}"]`; const steps = [];
const done = async (code) => { await browser.close(); await s.close(); proxy.close(); process.exit(code); };
const step = async (name, fn) => { try { await fn(); steps.push(name); console.log(`ok - ${name}`); } catch (err) { console.log(`FAILED after ${steps.length} steps: ${name}\n${err.stack || err}`); await done(1); } };

await step('not signed in: the sign-in page loads, every script and stylesheet answers 200, no console errors, nothing cacheable', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 850 } }); const page = await ctx.newPage(); const errors = []; const loaded = [];
  page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', (r) => { const u = new URL(r.url()); if (u.origin === PUBLIC && !u.pathname.startsWith('/unlock/')) loaded.push({ path: u.pathname, status: r.status(), type: r.request().resourceType(), cache: r.headers()['cache-control'] }); });
  await page.goto(`${PUBLIC}/`); await page.waitForSelector(t('email-form')); await page.waitForTimeout(1500);
  assert.deepEqual(errors, [], 'no console errors');
  const bad = loaded.filter((x) => x.status !== 200); assert.deepEqual(bad, [], 'every request answered 200');
  const scripts = loaded.filter((x) => x.type === 'script').map((x) => x.path).sort(); assert.deepEqual(scripts, ['/desktop.js', '/shared/capture.js', '/shared/context.js', '/shared/fhir.js', '/shared/recorder.js', '/shared/roles.js']);
  assert.ok(loaded.some((x) => x.path === '/shared/ui.css'), 'the stylesheet'); assert.ok(loaded.some((x) => x.path === '/auth/mode'));
  for (const x of loaded) assert.match(String(x.cache), /private/, `${x.path} must not be cached by a shared cache`); for (const x of loaded) assert.match(String(x.cache), /no-store/, x.path);
  assert.equal(await page.isVisible(t('email-input')), true); assert.equal(await page.isVisible(t('login-role')), true);
  console.log(`    loaded before sign-in: ${[...new Set(loaded.map((x) => x.path))].sort().join(', ')}`);
  // And signing in through the same public address works.
  await page.fill(t('email-input'), 'someone@mail.test'); await page.selectOption(t('login-role'), 'nurse'); await page.click(t('login-submit')); await page.waitForSelector(t('dock'));
  assert.deepEqual(errors, [], 'no console errors after signing in');
  await ctx.close();
});
await step('not signed in: app pages go to the sign-in page; data, FHIR, DICOM and file routes are 401; other shared files wait too', async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage(); await page.goto(`${PUBLIC}/`); await page.waitForSelector(t('email-form'));
  for (const app of ['/ehr/', '/pacs/', '/portal/', '/agent-ops/', '/pathology/', '/payer/', '/lab/']) { await page.goto(`${PUBLIC}${app}`); assert.equal(new URL(page.url()).pathname, '/', `${app} sends you to the sign-in page`); }
  const status = (u, init) => page.evaluate(async ([u2, i]) => (await fetch(u2, i)).status, [u, init || {}]);

  for (const u of ['/fhir/R4/Patient', '/dicom-web/studies', '/api/pacs/worklist', '/api/ecg/patients', '/api/pathology/worklist', '/pathology/slides/x/info', '/auth/patients', '/agent-ops/runs', '/api/ins/auth', '/shared/ui.js', '/shared/insurance.js', '/ehr/app.js', '/pacs/viewer.js']) assert.equal(await status(u), 401, u);
  assert.equal(await status('/agent-ops/trace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]' }), 401);
  assert.equal(await status('/desktop.js', { method: 'POST' }), 401, 'only reading the sign-in files');
  await ctx.close();
});
console.log(`${steps.length} browser steps passed. Console errors: 0.`);
await done(0);
