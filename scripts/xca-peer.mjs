#!/usr/bin/env node
// Starts a simulated second hospital (XCA responding gateway) for testing cross-community document exchange:
//   XCA_PEER_KEY=... node scripts/xca-peer.mjs --port 9450 --patient 'N300001^^^&<assigning authority OID>&ISO'
// Then run the app with XCA_COMMUNITIES=<homeCommunityId>=http://127.0.0.1:9450/xca and the same XCA_PEER_KEY.
import { startPeer } from '../standards/server/xca-peer.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const patientId = arg('patient'); if (!patientId) { console.error("--patient 'MRN^^^&OID&ISO' is required"); process.exit(2); }
const peer = await startPeer({ port: Number(arg('port', 9450)), patientId, key: process.env.XCA_PEER_KEY });
console.log(`Simulated hospital ${peer.homeCommunityId} at ${peer.url} with ${peer.held.length} documents`);
