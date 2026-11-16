#!/usr/bin/env node
// Runs simulated SDC bedside devices against a running app (docs/STANDARDS.md):
//   SDC_GATEWAY_KEY=... node scripts/sdc-sim.mjs --url http://localhost:8080 --mrn N300001 [--kinds monitor,ventilator,pump] [--every 5] [--alarm-every 60]
import { createSimDevice } from '../standards/server/sdc-sim.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const url = arg('url', 'http://localhost:8080'); const mrn = arg('mrn'); const every = Number(arg('every', 5)); const alarmEvery = Number(arg('alarm-every', 60));
if (!mrn) { console.error('--mrn <patient number> is required'); process.exit(2); }
const key = process.env.SDC_GATEWAY_KEY; if (!key) { console.error('Set SDC_GATEWAY_KEY (the same value the app has)'); process.exit(2); }
const post = async (path, body) => { const r = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gateway-Key': key }, body: JSON.stringify(body) }); if (!r.ok) console.error(path, r.status, await r.text()); return r.ok; };
const devices = arg('kinds', 'monitor').split(',').map((kind, i) => createSimDevice({ kind, mrn, seed: i + 1, id: `${kind}-${mrn}` }));
for (const d of devices) await post('/api/sdc/mdib', { xml: d.mdib() });
let tick = 0;
setInterval(async () => { tick += 1; for (const d of devices) { await post('/api/sdc/report', { mds: d.mds, xml: d.metrics() }); if (alarmEvery && (tick * every) % alarmEvery === 0) await post('/api/sdc/report', { mds: d.mds, xml: d.alarm(tick % 2 === 0) }); } }, every * 1000);
console.log(`Simulating ${devices.map((d) => d.kind).join(', ')} for ${mrn}, every ${every}s`);
