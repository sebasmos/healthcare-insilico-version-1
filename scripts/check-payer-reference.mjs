// Prints what the loaded reference files say for a few codes, so you can compare them with the published files.
//   npm run check:prices -- 99213 99214 70553 [--locality 01 --mac 14212] [--drg 291,470] [--pair 99213:36415]
// Nothing is written. With no codes it prints what is loaded and what is missing.
import * as ref from '../insurance-and-billing/server/reference.mjs';

const args = process.argv.slice(2); const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const codes = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'));
const money = (v) => (v == null ? 'not on file' : `$${Number(v).toFixed(2)}`);
const st = ref.referenceStatus();
console.log(`Reference database: ${ref.referenceFile()}\n`);
console.log('Loaded:'); for (const r of st.releases) console.log(`  ${r.label}: release ${r.release || '(none given)'}, ${r.rows} rows, from ${r.file}`);
if (!st.releases.length) console.log('  nothing. Run: npm run import -- --payer-reference <folder>');
if (st.missing.length) console.log(`\nNot loaded yet: ${st.missing.map((m) => m.label).join('; ')}`);
const locality = flag('--locality'); const mac = flag('--mac');
for (const code of codes) {
  const known = ref.code('HCPCS', code) || ref.code('CPT', code);
  console.log(`\n${code}${known?.short ? `  ${known.short}` : ''}`);
  for (const facility of [false, true]) {
    const nat = ref.feeSchedule(code, { facility });
    if (!nat) { if (!facility) console.log('  Physician fee schedule: not on file'); continue; }
    if (nat.amount == null) { if (!facility) console.log(`  Physician fee schedule: ${nat.reason} (status ${nat.status})`); continue; }
    console.log(`  Physician fee schedule, ${facility ? 'facility' : 'non-facility'}, national: ${money(nat.amount)}  = (work ${nat.rvu.work} + practice expense ${nat.rvu.practiceExpense} + malpractice ${nat.rvu.malpractice}) x conversion factor ${nat.conversionFactor}   [${nat.from.file}, ${nat.from.release || 'no release label'}]`);
    if (locality) { const loc = ref.feeSchedule(code, { facility, locality, mac }); console.log(`    locality ${locality}${mac ? ` (contractor ${mac})` : ''}: ${money(loc?.amount)}  with indices work ${loc?.gpci.work}, practice expense ${loc?.gpci.pe}, malpractice ${loc?.gpci.mp}${loc?.gpci.name ? ` (${loc.gpci.name})` : ''}`); }
  }
  const o = ref.opps(code); console.log(`  Hospital outpatient (OPPS): ${o ? `status ${o.statusIndicator}, APC ${o.apc || 'none'}, payment rate ${money(o.rate)}` : 'not on file'}`);
  const a = ref.ascRate(code); console.log(`  Surgery center: ${a ? `indicator ${a.indicator}, rate ${money(a.rate)}` : 'not on file'}`);
  for (const setting of ['practitioner', 'hospital']) { const m = ref.mue(code, { setting }); if (m) console.log(`  Unit limit (${setting}): ${m.units} (adjudication indicator ${m.adjudication})`); }
  const neg = ref.negotiatedRate({ code }).slice(0, 3); if (neg.length) console.log(`  Negotiated rates on file (first ${neg.length}): ${neg.map((r) => `${money(r.rate)} ${r.billingClass || ''} NPI ${r.npi || 'any'}`).join('; ')}`);
}
for (const d of String(flag('--drg') || '').split(',').filter(Boolean)) { const r = ref.drg(d); console.log(`\nMS-DRG ${d}: ${r ? `weight ${r.weight}${r.title ? `, ${r.title}` : ''}   [${r.from.file}]` : 'not on file'}`); }
for (const pair of String(flag('--pair') || '').split(',').filter(Boolean)) { const [x, y] = pair.split(':'); for (const setting of ['practitioner', 'hospital']) { const e = ref.ncciPair(x, y, { setting }); console.log(`\nNCCI ${x} with ${y} (${setting}): ${e ? `${e.column2} is bundled into ${e.column1}; a modifier ${e.modifierAllowed ? 'may' : 'may not'} separate them` : 'no edit on file'}`); } }
console.log('\nCompare with: the CMS Physician Fee Schedule look-up tool (same year, "national payment amount"), Addendum B (OPPS), Addendum AA (surgery centers), Table 5 (MS-DRG weights) and the NCCI edit files.');
