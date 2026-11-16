// Not a test: a timing harness. Loads a hospital the size of a real import (100 patients, ~400k results) into the
// test database and times the requests the apps make. Run: node tests/support/perf-harness.mjs [observations]
import { startTestServer } from './helpers.mjs';

const N_OBS = Number(process.argv[2] || 400000); const N_PAT = 100;
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const s = await startTestServer({ webRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..') });
const pool = s.adapter.pool;
const stats = { n: 0, ms: 0, top: [] };
const origQuery = pool.query.bind(pool);
pool.query = async (...a) => { const t = performance.now(); try { return await origQuery(...a); } finally { const d = performance.now() - t; stats.n += 1; stats.ms += d; stats.top.push([d, String(a[0]?.text || a[0]).replace(/\s+/g, ' ').slice(0, 150)]); } };
const sql = (q, p) => origQuery(q, p);
const now = new Date().toISOString();
console.log('loading…');
await sql(`INSERT INTO resource_versions (resource_type,id,version_id,branch,recorded_at,valid_at,patient,group_key,internal,body)
  SELECT 'Patient', 'p'||g, 1, 'main', $1, $1, 'Patient/p'||g, NULL, 0,
    jsonb_build_object('resourceType','Patient','id','p'||g,'gender','male','birthDate','2090-01-01','identifier',jsonb_build_array(jsonb_build_object('system','urn:hospital-desktop:mrn','value','N'||(100000+g))),'meta',jsonb_build_object('versionId','1','lastUpdated',$1::text),'_patient','Patient/p'||g,'_recordedAt',$1::text,'_validAt',$1::text,'_branch','main')
  FROM generate_series(1,$2) g`, [now, N_PAT]);
await sql(`INSERT INTO resource_versions (resource_type,id,version_id,branch,recorded_at,valid_at,patient,group_key,internal,body)
  SELECT 'Observation', 'o'||g, 1, 'main', $1, '2150-01-01T00:00:00.000Z', 'Patient/p'||(1+g%$3), NULL, 0,
    jsonb_build_object('resourceType','Observation','id','o'||g,'status','final','category',jsonb_build_array(jsonb_build_object('coding',jsonb_build_array(jsonb_build_object('system','http://terminology.hl7.org/CodeSystem/observation-category','code',CASE WHEN g%5=0 THEN 'vital-signs' ELSE 'laboratory' END)))),
      'code',jsonb_build_object('coding',jsonb_build_array(jsonb_build_object('system','http://loinc.org','code','2823-3','display','Potassium'))),'subject',jsonb_build_object('reference','Patient/p'||(1+g%$3)),'effectiveDateTime','2150-01-01T00:00:00Z','valueQuantity',jsonb_build_object('value',4.1,'unit','mmol/L'),
      'interpretation', CASE WHEN g%2000=0 THEN jsonb_build_array(jsonb_build_object('coding',jsonb_build_array(jsonb_build_object('code','HH')))) ELSE '[]'::jsonb END,
      'meta',jsonb_build_object('versionId','1','lastUpdated',$1::text),'_patient','Patient/p'||(1+g%$3),'_recordedAt',$1::text,'_validAt','2150-01-01T00:00:00.000Z','_branch','main')
  FROM generate_series(1,$2) g`, [now, N_OBS, N_PAT]);
for (const [type, per] of [['Encounter', 8], ['MedicationRequest', 60], ['DocumentReference', 20], ['Condition', 15], ['ServiceRequest', 40]]) {
  await sql(`INSERT INTO resource_versions (resource_type,id,version_id,branch,recorded_at,valid_at,patient,group_key,internal,body)
    SELECT $4, lower($4)||g, 1, 'main', $1, $1, 'Patient/p'||(1+g%$3), NULL, 0,
      jsonb_build_object('resourceType',$4::text,'id',lower($4)||g,'status',CASE WHEN $4='Encounter' THEN 'finished' WHEN $4='DocumentReference' THEN 'current' ELSE 'active' END,'docStatus','final','subject',jsonb_build_object('reference','Patient/p'||(1+g%$3)),'period',jsonb_build_object('start','2150-01-01T00:00:00Z','end','2150-01-05T00:00:00Z'),
        'meta',jsonb_build_object('versionId','1','lastUpdated',$1::text),'_patient','Patient/p'||(1+g%$3),'_recordedAt',$1::text,'_validAt',$1::text,'_branch','main')
    FROM generate_series(1,$2) g`, [now, per * N_PAT, N_PAT, type]);
}
await sql('ANALYZE resource_versions');
console.log(`loaded ${N_PAT} patients, ${N_OBS} observations`);
const H = { 'X-Role': 'physician', 'X-User-Id': 'physician-1' };
const time = async (label, url, headers = H) => {
  stats.n = 0; stats.ms = 0; stats.top = [];
  const t = performance.now(); const r = await s.call('GET', url, undefined, headers); const ms = performance.now() - t;
  const slow = stats.top.sort((a, b) => b[0] - a[0])[0];
  console.log(`${String(Math.round(ms)).padStart(6)} ms  ${String(stats.n).padStart(3)} queries (${Math.round(stats.ms)} ms in db)  ${r.status}  ${Math.round(r.text.length / 1024)}KB  ${label}${process.env.PERF_SQL && slow ? `\n          slowest ${Math.round(slow[0])} ms: ${slow[1]}` : ''}`);
};
const ids = Array.from({ length: 50 }, (_, i) => `p${i + 1}`).join(',');
for (let round = 0; round < 2; round += 1) {
  console.log(round ? '--- second pass (caches warm)' : '--- first pass');
  await time('desktop: who am I', '/auth/mode');
  await time('EHR: patient list', '/fhir/R4/Patient');
  await time('EHR: patient list, recent', '/fhir/R4/Patient?_sort=-_lastUpdated');
  await time('EHR: ages for 50', `/api/ages?ids=${ids}`);
  await time('EHR: badges', '/api/badges');
  await time('EHR: counters', '/api/counters');
  await time('EHR: ECG patients', '/api/ecg/patients');
  await time('EHR: appointments', '/fhir/R4/Appointment');
  await time('EHR: all orders (dashboard)', '/fhir/R4/ServiceRequest');
  await time('chart: patient', '/fhir/R4/Patient/p7');
  await time('chart: observations', '/fhir/R4/Observation?patient=p7');
  await time('chart: encounters', '/fhir/R4/Encounter?patient=p7');
  await time('chart: meds', '/fhir/R4/MedicationRequest?patient=p7');
  await time('chart: notes', '/fhir/R4/DocumentReference?patient=p7');
  await time('chart: everything', '/fhir/R4/Patient/p7/$everything');
  await time('chart: advisories', '/api/advisories?patient=p7&context=chart-open');
  await time('chart: surveillance touched', '/api/surveillance/touched?patient=p7');
  await time('chart: coverage', '/api/ins/coverage/p7');
  await time('panel', '/agent-ops/panel?patient=Patient%2Fp7');
  await time('panel waiting', '/agent-ops/panel/waiting');
  await time('agent-ops mode', '/agent-ops/mode');
  await time('pacs worklist', '/api/pacs/worklist?queue=all');
  await time('portal: own record', '/fhir/R4/Observation?patient=p7', { 'X-Role': 'patient', 'X-User-Id': 'p7' });
}
if (process.env.PERF_SERVE) { console.log(`SERVING ${s.base}`); await new Promise((r) => setTimeout(r, Number(process.env.PERF_SERVE) * 1000)); }
await s.close();
