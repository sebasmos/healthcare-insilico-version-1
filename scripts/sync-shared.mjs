// Copies shared package sources into the web/shared folders so the browser can load them
// directly (there is no bundler). Today that is the DICOM codec from
// viewers/dicom.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = [['viewers/dicom/dicom.js', 'viewers/web/shared/dicom.js'], ['viewers/dicom/objects.js', 'viewers/web/shared/dicom-objects.js'], ['pathology/server/slide-analysis.mjs', 'pathology/web/shared/slide-analysis.js'], ['pacs/server/report-templates.mjs', 'pacs/web/shared/report-templates.js']];
let copied = 0;
for (const [from, to] of targets) {
  const source = path.join(root, from);
  if (!fs.existsSync(source)) { console.log(`skip ${from} (not present yet)`); continue; }
  fs.copyFileSync(source, path.join(root, to));
  console.log(`synced ${from} -> ${to}`);
  copied += 1;
}
console.log(`${copied} file${copied === 1 ? '' : 's'} synced`);
