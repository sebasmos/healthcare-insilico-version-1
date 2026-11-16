// Where the browser files live. Each top-level folder keeps its pages under <folder>/web/, laid out by address:
// <folder>/web/ehr/app.js is served at /ehr/app.js. Several folders may add files under the same address prefix
// (for example /shared/); two folders must not provide the same file.
import fs from 'node:fs';
import path from 'node:path';

const rootsOf = new Map(); // repo root -> [<folder>/web, ...]
export function webRoots(repo) {
  if (!rootsOf.has(repo)) rootsOf.set(repo, fs.readdirSync(repo, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules' && d.name !== 'data').map((d) => path.join(repo, d.name, 'web')).filter((d) => fs.existsSync(d)).sort());
  return rootsOf.get(repo);
}
/** The file behind an address path such as /ehr/app.js, or null. Never leaves a web folder. */
export function webFile(repo, rel) {
  for (const root of webRoots(repo)) { const file = path.resolve(root, `.${rel}`); if (file !== root && !file.startsWith(root + path.sep)) return null; try { if (fs.statSync(file).isFile()) return file; } catch { /* next folder */ } }
  return null;
}
/** Is the address a folder of pages (so the browser should be sent to it with a trailing slash)? */
export function webDir(repo, rel) { return webRoots(repo).some((root) => { const d = path.resolve(root, `.${rel}`); try { return d.startsWith(root + path.sep) && fs.statSync(d).isDirectory(); } catch { return false; } }); }
/** Every browser file as [address path, file]. */
export function webFiles(repo) {
  const out = []; const walk = (root, dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(root, f); else out.push([`/${path.relative(root, f).split(path.sep).join('/')}`, f]); } };
  for (const root of webRoots(repo)) walk(root, root); return out;
}
