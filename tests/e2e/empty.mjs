// An empty hospital stays empty. Starts on an empty database, opens every screen of every app
// (and the desktop and lock screen) in a real browser, then checks that no Patient record exists
// on the live record or on any branch, and that no screen shows a person's name.
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/empty.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTestServer } from '../support/helpers.mjs';
import { personNames } from '../support/names.mjs';
import { REPO_ROOT } from '../../platform/server/db/index.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch { console.log('SKIPPED: Playwright is not installed. Set PLAYWRIGHT_MODULE to its path to run the browser test.'); process.exit(0); }

const PAGES = {
  '': [''],
  ehr: ['#/dashboard', '#/worklist', '#/patients', '#/schedule', '#/frontdesk', '#/orders', '#/inbox', '#/billing', '#/admin'], pacs: ['#/worklist', '#/upload'], pathology: ['#/worklist', '#/upload'], lab: ['#/worklist', '#/criticals'],
  pharmacy: ['#/queue', '#/dispense'], beds: ['#/dashboard'], monitoring: ['#/dashboard', '#/alerts'], payer: ['#/bench'],
  portal: ['#/home', '#/notes'], visit: ['#/start', '#/history'],
  'agent-ops': ['#/', '#/library/scenarios', '#/library/tasks', '#/library/agents', '#/library/safety', '#/library/benchmarks', '#/settings', '#/runs', '#/evaluate', '#/evaluate/shadow', '#/evaluate/hitl', '#/evaluate/redteam', '#/rl', '#/annotate', '#/studies', '#/scribe', '#/ablation', '#/versions', '#/scenarios', '#/grading', '#/results', '#/reward', '#/shadow', '#/redteam', '#/hitl', '#/cds', '#/regression', '#/leaderboard', '#/surveillance'],
};

const s = await startTestServer({ webRoot: REPO_ROOT });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome' });
let opened = 0;
try {
  for (const [app, hashes] of Object.entries(PAGES)) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript((a) => { localStorage.setItem('hd.wallpaper', 'builtin'); localStorage.setItem('hd.lockWallpaper', 'builtin'); if (a) { localStorage.setItem('hd.role', a === 'portal' ? 'patient' : a === 'agent-ops' ? 'researcher' : 'physician'); localStorage.setItem('hd.user', 'user-1'); localStorage.setItem('hd.session', 'in'); } }, app);
    const page = await context.newPage(); const crashes = [];
    page.on('pageerror', (e) => crashes.push(e.message));
    for (const hash of hashes) {
      await page.goto(`${s.base}/${app ? `${app}/` : ''}${hash}`); await page.waitForTimeout(900);
      const text = await page.evaluate(() => `${document.title}\n${document.body.innerText}\n${[...document.querySelectorAll('[aria-label],[title],[placeholder]')].map((e) => `${e.getAttribute('aria-label') || ''} ${e.getAttribute('title') || ''} ${e.getAttribute('placeholder') || ''}`).join('\n')}`);
      assert.ok(text.trim().length > 20, `${app} ${hash} drew something`);
      assert.deepEqual(personNames(text), [], `${app || 'desktop'} ${hash} shows no person name`);
      assert.deepEqual(crashes, [], `${app || 'desktop'} ${hash} opened without a script error`);
      opened += 1;
    }
    await context.close();
    assert.equal((await s.store.head('Patient')).length, 0, `no patient on the live record after opening ${app || 'the desktop'}`);
  }
  for (const b of await s.store.listBranches()) assert.equal((await s.store.query('Patient', {}, { branch: b.id })).length, 0, `no patient on branch ${b.id}`);
  assert.deepEqual((await s.call('GET', '/auth/patients')).json.patients, []);
} finally {
  await browser.close();
  await s.close();
}
console.log(`ok - ${opened} screens opened on an empty database: zero patients, no person names.`);
