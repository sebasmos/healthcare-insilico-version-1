// X12 5010 transactions, generated and parsed by our own code (docs/PAYER.md section 6).
//   270/271 eligibility, 276/277 claim status, 278 authorization, 837P and 837I claims, 835 remittance,
//   834 enrollment, 275 attachments, 999 and 277CA acknowledgements.
// Each transaction is rendered from one plain record and parses back to the same record, so the FHIR form of
// the record and the X12 form always say the same thing. Segments, loops and code values follow the standard;
// the implementation guides' text is not reproduced, and not every situational rule is enforced.
// No patient names: the name element of a person's NM1 carries the patient number.
export const VERSION = { 270: '005010X279A1', 271: '005010X279A1', 276: '005010X212', 277: '005010X212', '277CA': '005010X214', 278: '005010X217', '837P': '005010X222A1', '837I': '005010X223A2', '837D': '005010X224A2', 820: '005010X218', 835: '005010X221A1', 834: '005010X220A1', 275: '005010X210', 999: '005010X231A1' };
const GROUP = { 270: 'HS', 271: 'HB', 276: 'HR', 277: 'HN', '277CA': 'HN', 278: 'HI', '837P': 'HC', '837I': 'HC', '837D': 'HC', 820: 'RA', 835: 'HP', 834: 'BE', 275: 'PI', 999: 'FA' };
const ST = (t) => String(t).replace(/[PID]$|CA$/, '');
const d8 = (iso) => String(iso || '').slice(0, 10).replace(/-/g, '');
const iso = (d) => (/^\d{8}$/.test(d || '') ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null);
const money = (n) => (n == null ? '' : String(Math.round(Number(n) * 100) / 100));
const num = (s) => (s === '' || s == null ? null : Number(s));
const clean = (v) => String(v ?? '').replace(/[*~:^\n\r]/g, ' ').trim();
const seg = (...els) => { const a = els.map((e) => (Array.isArray(e) ? e.map(clean).join(':').replace(/:+$/, '') : clean(e))); while (a.length > 1 && a[a.length - 1] === '') a.pop(); return a.join('*'); };

/** Wraps transaction segments in ST/SE, GS/GE and ISA/IEA. control: a number unique to the sender. */
export function envelope(type, segments, { sender = 'HOSPITAL', receiver = 'INSURER', control = 1, at = new Date().toISOString() } = {}) {
  const c9 = String(control).padStart(9, '0'); const date = d8(at); const time = at.slice(11, 16).replace(':', '');
  const st = [seg('ST', ST(type), '0001', VERSION[type]), ...segments]; st.push(seg('SE', st.length + 1, '0001'));
  // The interchange header has fixed-width fields, so it is written by hand.
  const isa = ['ISA', '00', ' '.repeat(10), '00', ' '.repeat(10), 'ZZ', clean(sender).padEnd(15).slice(0, 15), 'ZZ', clean(receiver).padEnd(15).slice(0, 15), date.slice(2), time, '^', '00501', c9, '0', 'T', ':'].join('*');
  return [isa, seg('GS', GROUP[type], sender, receiver, date, time, String(control), 'X', VERSION[type]), ...st, seg('GE', '1', String(control)), seg('IEA', '1', c9)].map((s) => `${s}~`).join('\n');
}
/** Text -> { sender, receiver, control, transactions: [{ type, version, control, segments: [[id, ...elements]] }] }. */
export function parse(text) {
  const raw = String(text).split('~').map((s) => s.replace(/^[\r\n]+/, '')).filter((s) => s.trim());
  if (!raw.length || !raw[0].startsWith('ISA')) throw new Error('Not an X12 interchange: it does not start with ISA');
  const isa = raw[0].split('*'); const out = { sender: isa[6]?.trim(), receiver: isa[8]?.trim(), control: Number(isa[13]), transactions: [] }; let cur = null; let version = null;
  for (const s of raw) { const e = s.split('*'); if (e[0] === 'GS') version = e[8]; else if (e[0] === 'ST') cur = { st: e[1], version: e[3] || version, control: e[2], segments: [] }; else if (e[0] === 'SE') { if (Number(e[1]) !== cur.segments.length + 2) throw new Error(`Segment count is wrong in ${cur.st}: SE says ${e[1]}, found ${cur.segments.length + 2}`); cur.type = cur.st === '837' ? (cur.version === VERSION['837I'] ? '837I' : cur.version === VERSION['837D'] ? '837D' : '837P') : cur.st === '277' && cur.version === VERSION['277CA'] ? '277CA' : cur.st; out.transactions.push(cur); cur = null; } else if (cur) cur.segments.push(e); }
  return out;
}
const find = (segs, id, q = null, from = 0) => { for (let i = from; i < segs.length; i += 1) if (segs[i][0] === id && (q == null || segs[i][1] === q)) return segs[i]; return null; };
const allOf = (segs, id, q = null) => segs.filter((s) => s[0] === id && (q == null || s[1] === q));
const comp = (v) => String(v || '').split(':');
const person = (q, p) => seg('NM1', q, '1', p.patientNumber, '', '', '', '', 'MI', p.memberId); // the "name" is the patient number
const dmg = (p) => (p.birthDate ? seg('DMG', 'D8', d8(p.birthDate), { male: 'M', female: 'F' }[p.gender] || 'U') : null);
const readPerson = (segs, q = 'IL') => { const n = find(segs, 'NM1', q); const i = segs.indexOf(n); const g = segs.slice(i, i + 6).find((s) => s[0] === 'DMG'); return n ? { patientNumber: n[3], memberId: n[9], ...(g ? { birthDate: iso(g[2]), gender: { M: 'male', F: 'female' }[g[3]] || 'unknown' } : {}) } : null; };

// ---------- 837 professional and institutional ----------
/** claim -> 837P or 837I (by claim.type). */
export function claim837(c, env = {}) {
  const inst = c.type === 'institutional'; const dental = c.type === 'dental'; const s = [];
  s.push(seg('BHT', '0019', '00', c.id, d8(c.createdAt), '1200', 'CH'), seg('NM1', '41', '2', 'HOSPITAL', '', '', '', '', '46', c.billing.npi), seg('PER', 'IC', 'BILLING OFFICE', 'TE', '0000000000'), seg('NM1', '40', '2', c.payer.name, '', '', '', '', '46', c.payer.id));
  s.push(seg('HL', '1', '', '20', '1'), c.billing.taxonomy ? seg('PRV', 'BI', 'PXC', c.billing.taxonomy) : null, seg('NM1', '85', '2', `NPI ${c.billing.npi}`, '', '', '', '', 'XX', c.billing.npi), seg('N3', 'ADDRESS NOT SENT'), seg('N4', 'CITY', c.billing.state || 'XX', '000000000'), seg('REF', 'EI', c.billing.taxId || '000000000'));
  s.push(seg('HL', '2', '1', '22', '0'), seg('SBR', c.otherPayer ? 'S' : 'P', '18', '', '', '', '', '', '', c.payer.filing || 'CI'), person('IL', c.subscriber), dmg(c.subscriber), seg('NM1', 'PR', '2', c.payer.name, '', '', '', '', 'PI', c.payer.id));
  s.push(seg('CLM', c.id, money(c.total), '', '', inst ? [String(c.typeOfBill).slice(0, 2), 'A', c.frequency || '1'] : [c.placeOfService, 'B', c.frequency || '1'], 'Y', 'A', 'Y', 'Y'));
  if (inst) { s.push(seg('DTP', '434', 'RD8', `${d8(c.statementFrom)}-${d8(c.statementTo)}`)); if (c.admittedAt) s.push(seg('DTP', '435', 'DT', `${d8(c.admittedAt)}${String(c.admittedAt).slice(11, 16).replace(':', '') || '0000'}`)); s.push(seg('CL1', c.admissionType || '1', c.admissionSource || '1', c.dischargeStatus || '01')); }
  if (c.priorAuth) s.push(seg('REF', 'G1', c.priorAuth)); if (c.originalRef) s.push(seg('REF', 'F8', c.originalRef));
  const dx = c.diagnoses || [];
  if (inst) { if (dx[0]) s.push(seg('HI', ['ABK', dx[0].code, '', '', '', '', '', '', dx[0].poa || ''])); if (c.admittingDiagnosis) s.push(seg('HI', ['ABJ', c.admittingDiagnosis])); if (c.drg) s.push(seg('HI', ['DR', c.drg])); if (dx.length > 1) s.push(seg('HI', ...dx.slice(1, 13).map((d) => ['ABF', d.code, '', '', '', '', '', '', d.poa || '']))); if (c.procedures?.length) s.push(seg('HI', ...c.procedures.slice(0, 12).map((p, i) => [i ? 'BBQ' : 'BBR', p.code, 'D8', d8(p.date)]))); }
  else if (dx.length) s.push(seg('HI', ...dx.slice(0, 12).map((d, i) => [i ? 'ABF' : 'ABK', d.code])));
  if (c.rendering?.npi) s.push(seg('NM1', inst ? '71' : '82', '1', `NPI ${c.rendering.npi}`, '', '', '', '', 'XX', c.rendering.npi));
  if (c.otherPayer) { s.push(seg('SBR', 'P', '18', '', '', '', '', '', '', c.otherPayer.filing || 'CI'), seg('AMT', 'D', money(c.otherPayer.paid))); for (const a of c.otherPayer.adjustments || []) s.push(seg('CAS', a.group, a.reason, money(a.amount))); s.push(seg('OI', '', '', 'Y', '', '', 'Y'), seg('NM1', 'IL', '1', c.subscriber.patientNumber, '', '', '', '', 'MI', c.otherPayer.memberId), seg('NM1', 'PR', '2', c.otherPayer.name, '', '', '', '', 'PI', c.otherPayer.id), seg('DTP', '573', 'D8', d8(c.otherPayer.paidAt))); }
  for (const l of c.lines) { s.push(seg('LX', l.n)); s.push(dental ? seg('SV3', ['AD', l.code, ...(l.modifiers || [])], money(l.charge), '', '', '', '', '', '', '', '', l.units) : inst ? seg('SV2', l.revenue || '0510', ['HC', l.code, ...(l.modifiers || [])], money(l.charge), 'UN', l.units) : seg('SV1', ['HC', l.code, ...(l.modifiers || [])], money(l.charge), 'UN', l.units, '', '', (l.dxPointers || [1]).map(String))); if (dental && l.tooth) s.push(seg('TOO', 'JP', l.tooth, l.surfaces || [])); s.push(seg('DTP', '472', 'D8', d8(l.date))); }
  return envelope(inst ? '837I' : dental ? '837D' : '837P', s.filter(Boolean), env);
}
/** A parsed 837 transaction -> claim. */
export function readClaim837(tx) {
  const g = tx.segments; const inst = tx.type === '837I'; const dental = tx.type === '837D'; const clm = find(g, 'CLM'); const c5 = comp(clm[5]); const hlSub = g.findIndex((s) => s[0] === 'HL' && s[3] === '22');
  const pr = g.slice(hlSub).find((s) => s[0] === 'NM1' && s[1] === 'PR'); const bill = find(g, 'NM1', '85'); const prv = find(g, 'PRV', 'BI'); const sbr = g[hlSub + 1];
  const lines = []; let cur = null; let seenLx = false; let other = null; let inOther = false;
  for (const s of g.slice(g.indexOf(clm) + 1)) {
    if (s[0] === 'LX') { seenLx = true; inOther = false; cur = { n: Number(s[1]) }; lines.push(cur); }
    else if (!seenLx && s[0] === 'SBR') { inOther = true; other = { filing: s[9] || null, adjustments: [] }; }
    else if (inOther && s[0] === 'AMT' && s[1] === 'D') other.paid = num(s[2]); else if (inOther && s[0] === 'CAS') other.adjustments.push({ group: s[1], reason: s[2], amount: num(s[3]) });
    else if (inOther && s[0] === 'NM1' && s[1] === 'IL') other.memberId = s[9]; else if (inOther && s[0] === 'NM1' && s[1] === 'PR') { other.name = s[3]; other.id = s[9]; } else if (inOther && s[0] === 'DTP' && s[1] === '573') other.paidAt = iso(s[3]);
    else if (cur && (s[0] === 'SV1' || s[0] === 'SV2')) { const p = comp(inst ? s[2] : s[1]); Object.assign(cur, inst ? { revenue: s[1], code: p[1], modifiers: p.slice(2).filter(Boolean), charge: num(s[3]), units: num(s[5]) } : { code: p[1], modifiers: p.slice(2).filter(Boolean), charge: num(s[2]), units: num(s[4]), dxPointers: comp(s[7]).filter(Boolean).map(Number) }); }
    else if (cur && s[0] === 'SV3') { const p = comp(s[1]); Object.assign(cur, { code: p[1], modifiers: p.slice(2).filter(Boolean), charge: num(s[2]), units: num(s[11]) }); }
    else if (cur && s[0] === 'TOO') Object.assign(cur, { tooth: s[2], surfaces: s[3] ? comp(s[3]) : [] });
    else if (cur && s[0] === 'DTP' && s[1] === '472') cur.date = iso(s[3]);
  }
  const his = allOf(g, 'HI').flatMap((s) => s.slice(1).map(comp)); const dx = his.filter((h) => ['ABK', 'ABF'].includes(h[0])).map((h) => ({ code: h[1], ...(h[8] ? { poa: h[8] } : {}) }));
  const stmt = find(g, 'DTP', '434'); const adm = find(g, 'DTP', '435'); const cl1 = find(g, 'CL1'); const rend = find(g, 'NM1', inst ? '71' : '82');
  return { id: clm[1], type: inst ? 'institutional' : dental ? 'dental' : 'professional', frequency: c5[2] || '1', total: num(clm[2]), ...(inst ? { typeOfBill: `${c5[0]}${c5[2] || '1'}`, statementFrom: stmt ? iso(stmt[3].slice(0, 8)) : null, statementTo: stmt ? iso(stmt[3].slice(9)) : null, admittedAt: adm ? iso(adm[3].slice(0, 8)) : null, admissionType: cl1?.[1] ?? null, dischargeStatus: cl1?.[3] ?? null, drg: his.find((h) => h[0] === 'DR')?.[1] ?? null, admittingDiagnosis: his.find((h) => h[0] === 'ABJ')?.[1] ?? null, procedures: his.filter((h) => ['BBR', 'BBQ'].includes(h[0])).map((h) => ({ code: h[1], date: iso(h[3]) })) } : { placeOfService: c5[0] }),
    billing: { npi: bill?.[9] ?? null, taxonomy: prv?.[3] ?? null, taxId: find(g, 'REF', 'EI')?.[2] ?? null }, subscriber: readPerson(g.slice(hlSub)), payer: { id: pr?.[9] ?? null, name: pr?.[3] ?? null, filing: sbr?.[9] ?? null }, priorAuth: find(g, 'REF', 'G1')?.[2] ?? null, originalRef: find(g, 'REF', 'F8')?.[2] ?? null, diagnoses: dx, rendering: rend ? { npi: rend[9] } : null, otherPayer: other, lines, createdAt: iso(find(g, 'BHT')?.[4]) };
}

// ---------- 835 remittance ----------
/** remit: { id, payer, payee: { npi }, paidAt, method, claims: [{ claimId, payerControl, status, charge, paid, patientResponsibility, filing, frequency, subscriber, drg?, lines: [{ code, modifiers, charge, paid, units, date, allowed, adjustments: [{ group, reason, amount }], remarks: [] }], adjustments: [], remarks: [] }], providerAdjustments: [{ reason, ref, amount }] } */
export function remit835(r, env = {}) {
  const total = r.claims.reduce((n, c) => n + c.paid, 0) - (r.providerAdjustments || []).reduce((n, a) => n + a.amount, 0);
  const s = [seg('BPR', total > 0 ? 'I' : 'H', money(total), 'C', total > 0 ? 'ACH' : 'NON', total > 0 ? 'CCP' : '', '', '', '', '', '', '', '', '', '', '', d8(r.paidAt)), seg('TRN', '1', r.id, r.payer.id), seg('DTM', '405', d8(r.paidAt)), seg('N1', 'PR', r.payer.name), seg('N3', 'ADDRESS NOT SENT'), seg('N4', 'CITY', 'XX', '000000000'), seg('REF', '2U', r.payer.id), seg('N1', 'PE', `NPI ${r.payee.npi}`, 'XX', r.payee.npi), seg('LX', '1')];
  for (const c of r.claims) {
    s.push(seg('CLP', c.claimId, c.status, money(c.charge), money(c.paid), money(c.patientResponsibility), c.filing || '12', c.payerControl, c.facilityCode || '', c.frequency || '1', '', c.drg || ''));
    for (const a of c.adjustments || []) s.push(seg('CAS', a.group, a.reason, money(a.amount)));
    s.push(person('QC', c.subscriber)); for (const m of c.remarks || []) s.push(seg('MOA', '', '', m));
    for (const [code, amt] of Object.entries(c.extra || {})) s.push(seg('AMT', code, money(amt)));
    for (const l of c.lines || []) { s.push(seg('SVC', ['HC', l.code, ...(l.modifiers || [])], money(l.charge), money(l.paid), '', l.units), seg('DTM', '472', d8(l.date))); const by = new Map(); for (const a of l.adjustments || []) { if (!by.has(a.group)) by.set(a.group, []); by.get(a.group).push(a); } for (const [grp, list] of by) s.push(seg('CAS', grp, ...list.flatMap((a) => [a.reason, money(a.amount), ''])).replace(/\*+$/, '')); if (l.allowed != null) s.push(seg('AMT', 'B6', money(l.allowed))); for (const m of l.remarks || []) s.push(seg('LQ', 'HE', m)); }
  }
  for (const a of r.providerAdjustments || []) s.push(seg('PLB', r.payee.npi, `${d8(r.paidAt).slice(0, 4)}1231`, [a.reason, a.ref], money(a.amount)));
  return envelope(835, s, { sender: 'INSURER', receiver: 'HOSPITAL', ...env });
}
export function readRemit835(tx) {
  const g = tx.segments; const bpr = find(g, 'BPR'); const trn = find(g, 'TRN'); const claims = []; let c = null; let l = null;
  for (const s of g) {
    if (s[0] === 'CLP') { c = { claimId: s[1], status: s[2], charge: num(s[3]), paid: num(s[4]), patientResponsibility: num(s[5]) ?? 0, filing: s[6], payerControl: s[7], frequency: s[9] || '1', ...(s[11] ? { drg: s[11] } : {}), adjustments: [], remarks: [], lines: [], extra: {} }; l = null; claims.push(c); }
    else if (c && s[0] === 'SVC') { const p = comp(s[1]); l = { code: p[1], modifiers: p.slice(2).filter(Boolean), charge: num(s[2]), paid: num(s[3]), units: num(s[5]), adjustments: [], remarks: [] }; c.lines.push(l); }
    else if (c && s[0] === 'CAS') { for (let i = 2; i < s.length; i += 3) if (s[i]) (l || c).adjustments.push({ group: s[1], reason: s[i], amount: num(s[i + 1]) }); }
    else if (c && !l && s[0] === 'NM1' && s[1] === 'QC') c.subscriber = { patientNumber: s[3], memberId: s[9] };
    else if (c && !l && s[0] === 'MOA') c.remarks.push(...s.slice(3).filter(Boolean)); else if (c && !l && s[0] === 'AMT') c.extra[s[1]] = num(s[2]);
    else if (l && s[0] === 'DTM' && s[1] === '472') l.date = iso(s[2]); else if (l && s[0] === 'AMT' && s[1] === 'B6') l.allowed = num(s[2]); else if (l && s[0] === 'LQ') l.remarks.push(s[2]);
  }
  const pe = find(g, 'N1', 'PE'); const pr = find(g, 'N1', 'PR');
  const out = { id: trn[2], payer: { id: trn[3], name: pr?.[2] ?? null }, payee: { npi: pe?.[4] ?? null }, paidAt: iso(find(g, 'DTM', '405')?.[2]), total: num(bpr[2]), claims, providerAdjustments: allOf(g, 'PLB').map((s) => ({ reason: comp(s[3])[0], ref: comp(s[3])[1], amount: num(s[4]) })) };
  // An 835 must balance: for every claim, charge less adjustments is what was paid; the payment is the sum of the claims less provider-level adjustments.
  const cents = (n) => Math.round(n * 100);
  for (const k of claims) { const adj = [...k.adjustments, ...k.lines.flatMap((x) => x.adjustments)].reduce((n, a) => n + a.amount, 0); if (cents(k.charge - adj) !== cents(k.paid)) throw new Error(`The 835 does not balance for claim ${k.claimId}: charge ${k.charge} less adjustments ${adj} is not the ${k.paid} paid`); }
  if (cents(claims.reduce((n, k) => n + k.paid, 0) - out.providerAdjustments.reduce((n, a) => n + a.amount, 0)) !== cents(out.total)) throw new Error('The 835 does not balance: the payment is not the sum of its claims less provider adjustments');
  return out;
}

// ---------- 270 / 271 eligibility ----------
export function eligibility270(q, env = {}) { return envelope(270, [seg('BHT', '0022', '13', q.id, d8(q.at), '1200'), seg('HL', '1', '', '20', '1'), seg('NM1', 'PR', '2', q.payer.name, '', '', '', '', 'PI', q.payer.id), seg('HL', '2', '1', '21', '1'), seg('NM1', '1P', '2', `NPI ${q.provider.npi}`, '', '', '', '', 'XX', q.provider.npi), seg('HL', '3', '2', '22', '0'), seg('TRN', '1', q.id, q.provider.npi), person('IL', q.subscriber), dmg(q.subscriber), seg('DTP', '291', 'D8', d8(q.serviceDate)), seg('EQ', q.serviceType || '30')].filter(Boolean), env); }
export function readEligibility270(tx) { const g = tx.segments; return { id: find(g, 'BHT')[3], payer: { id: find(g, 'NM1', 'PR')[9], name: find(g, 'NM1', 'PR')[3] }, provider: { npi: find(g, 'NM1', '1P')[9] }, subscriber: readPerson(g), serviceDate: iso(find(g, 'DTP', '291')[3]), serviceType: find(g, 'EQ')?.[1] || '30' }; }
/** a: { id, payer, provider, subscriber, active, plan, start, end, benefits: [{ code, amount?, percent?, period?, serviceType?, inNetwork?, authRequired?, note? }], reject? } */
export function eligibility271(a, env = {}) {
  const s = [seg('BHT', '0022', '11', a.id, d8(a.at), '1200'), seg('HL', '1', '', '20', '1'), seg('NM1', 'PR', '2', a.payer.name, '', '', '', '', 'PI', a.payer.id), seg('HL', '2', '1', '21', '1'), seg('NM1', '1P', '2', `NPI ${a.provider.npi}`, '', '', '', '', 'XX', a.provider.npi), seg('HL', '3', '2', '22', '0'), seg('TRN', '2', a.id, a.provider.npi), person('IL', a.subscriber)];
  if (a.reject) s.push(seg('AAA', 'N', '', a.reject, 'C')); else { s.push(dmg(a.subscriber), seg('DTP', '346', 'D8', d8(a.start))); if (a.end) s.push(seg('DTP', '347', 'D8', d8(a.end))); s.push(seg('EB', a.active ? '1' : '6', 'IND', '30', '', a.plan)); for (const b of a.benefits || []) s.push(seg('EB', b.code, 'IND', b.serviceType || '30', '', '', b.period || '', b.amount != null ? money(b.amount) : '', b.percent != null ? String(b.percent) : '', '', '', b.authRequired == null ? '' : b.authRequired ? 'Y' : 'N', b.inNetwork == null ? '' : b.inNetwork ? 'Y' : 'N'), b.note ? seg('MSG', b.note) : null); }
  return envelope(271, s.filter(Boolean), { sender: 'INSURER', receiver: 'HOSPITAL', ...env });
}
export function readEligibility271(tx) {
  const g = tx.segments; const aaa = find(g, 'AAA'); const ebs = allOf(g, 'EB'); const first = ebs[0];
  return { id: find(g, 'BHT')[3], payer: { id: find(g, 'NM1', 'PR')[9], name: find(g, 'NM1', 'PR')[3] }, provider: { npi: find(g, 'NM1', '1P')[9] }, subscriber: readPerson(g), ...(aaa ? { reject: aaa[3], active: false, benefits: [] } : { active: first?.[1] === '1', plan: first?.[5] ?? null, start: iso(find(g, 'DTP', '346')?.[3]), end: iso(find(g, 'DTP', '347')?.[3]), benefits: ebs.slice(1).map((e) => ({ code: e[1], serviceType: e[3] || '30', ...(e[6] ? { period: e[6] } : {}), ...(e[7] ? { amount: num(e[7]) } : {}), ...(e[8] ? { percent: num(e[8]) } : {}), ...(e[11] ? { authRequired: e[11] === 'Y' } : {}), ...(e[12] ? { inNetwork: e[12] === 'Y' } : {}) })) }) };
}

// ---------- 278 authorization request and response ----------
/** a: { id, payer, requester: { npi }, subscriber, urgency: 'standard'|'expedited', kind: 'initial'|'extension'|'retro', setting, serviceDate, diagnoses: [code], services: [{ code, modifiers, units, institutional? }], admission?: { from, days } } */
export function auth278(a, env = {}) {
  const s = [seg('BHT', '0007', '13', a.id, d8(a.at), '1200'), seg('HL', '1', '', '20', '1'), seg('NM1', 'X3', '2', a.payer.name, '', '', '', '', 'PI', a.payer.id), seg('HL', '2', '1', '21', '1'), seg('NM1', '1P', '2', `NPI ${a.requester.npi}`, '', '', '', '', 'XX', a.requester.npi), seg('HL', '3', '2', '22', '1'), person('IL', a.subscriber), dmg(a.subscriber), seg('HL', '4', '3', 'EV', '1'), seg('TRN', '1', a.id, a.requester.npi),
    seg('UM', a.admission ? 'AR' : 'HS', { initial: 'I', extension: 'E', retro: 'I' }[a.kind || 'initial'], a.serviceType || '', [a.setting || '22', 'B'], '', a.urgency === 'expedited' ? 'U' : 'E'), a.kind === 'retro' ? seg('REF', 'NT', 'RETROSPECTIVE') : null, seg('DTP', a.admission ? '435' : '472', 'D8', d8(a.admission?.from || a.serviceDate)), a.diagnoses?.length ? seg('HI', ...a.diagnoses.slice(0, 12).map((d, i) => [i ? 'ABF' : 'ABK', d])) : null, a.admission ? seg('HSD', 'DY', a.admission.days) : null];
  (a.services || []).forEach((v, i) => { s.push(seg('HL', 5 + i, '4', 'SS', '0'), v.institutional ? seg('SV2', v.revenue || '', ['HC', v.code, ...(v.modifiers || [])], '', 'UN', v.units || 1) : seg('SV1', ['HC', v.code, ...(v.modifiers || [])], '', 'UN', v.units || 1)); });
  return envelope(278, s.filter(Boolean), env);
}
export function readAuth278(tx) {
  const g = tx.segments; const um = find(g, 'UM'); const adm = um[1] === 'AR'; const hsd = find(g, 'HSD');
  return { id: find(g, 'BHT')[3], payer: { id: find(g, 'NM1', 'X3')[9], name: find(g, 'NM1', 'X3')[3] }, requester: { npi: find(g, 'NM1', '1P')[9] }, subscriber: readPerson(g), urgency: um[6] === 'U' ? 'expedited' : 'standard', kind: find(g, 'REF', 'NT') ? 'retro' : um[2] === 'E' ? 'extension' : 'initial', setting: comp(um[4])[0], serviceDate: iso(find(g, 'DTP', adm ? '435' : '472')?.[3]), diagnoses: allOf(g, 'HI').flatMap((h) => h.slice(1).map((x) => comp(x)[1])), services: g.filter((x) => x[0] === 'SV1' || x[0] === 'SV2').map((x) => { const p = comp(x[0] === 'SV2' ? x[2] : x[1]); return { code: p[1], modifiers: p.slice(2).filter(Boolean), units: num(x[x[0] === 'SV2' ? 5 : 4]) || 1, ...(x[0] === 'SV2' ? { institutional: true } : {}) }; }), ...(adm ? { admission: { from: iso(find(g, 'DTP', '435')[3]), days: num(hsd?.[2]) } } : {}) };
}
/** r: { id (the request's), payer, requester, subscriber, action: 'A1' certified | 'A3' not certified | 'A4' pended | 'A6' modified | 'CT' contact payer, authNumber?, reasonCode?, note?, from?, to?, units?, services: [...] } */
export function authResponse278(r, env = {}) {
  const s = [seg('BHT', '0007', '11', r.id, d8(r.at), '1200'), seg('HL', '1', '', '20', '1'), seg('NM1', 'X3', '2', r.payer.name, '', '', '', '', 'PI', r.payer.id), seg('HL', '2', '1', '21', '1'), seg('NM1', '1P', '2', `NPI ${r.requester.npi}`, '', '', '', '', 'XX', r.requester.npi), seg('HL', '3', '2', '22', '1'), person('IL', r.subscriber), seg('HL', '4', '3', 'EV', '0'), seg('TRN', '2', r.id, r.requester.npi), seg('HCR', r.action, r.authNumber || '', r.reasonCode || ''), r.from ? seg('DTP', '472', 'RD8', `${d8(r.from)}-${d8(r.to || r.from)}`) : null, r.units != null ? seg('HSD', 'VS', r.units) : null, r.note ? seg('MSG', r.note.slice(0, 260)) : null];
  return envelope(278, s.filter(Boolean), { sender: 'INSURER', receiver: 'HOSPITAL', ...env });
}
export function readAuthResponse278(tx) { const g = tx.segments; const h = find(g, 'HCR'); const d = find(g, 'DTP', '472'); return { id: find(g, 'BHT')[3], payer: { id: find(g, 'NM1', 'X3')[9], name: find(g, 'NM1', 'X3')[3] }, requester: { npi: find(g, 'NM1', '1P')[9] }, subscriber: readPerson(g), action: h[1], authNumber: h[2] || null, reasonCode: h[3] || null, from: d ? iso(d[3].slice(0, 8)) : null, to: d ? iso(d[3].slice(9)) : null, units: num(find(g, 'HSD')?.[2]), note: find(g, 'MSG')?.[1] ?? null }; }

// ---------- 276 / 277 claim status, 277CA and 999 acknowledgements ----------
export function status276(q, env = {}) { return envelope(276, [seg('BHT', '0010', '13', q.id, d8(q.at), '1200'), seg('HL', '1', '', '20', '1'), seg('NM1', 'PR', '2', q.payer.name, '', '', '', '', 'PI', q.payer.id), seg('HL', '2', '1', '21', '1'), seg('NM1', '41', '2', 'HOSPITAL', '', '', '', '', '46', q.provider.npi), seg('HL', '3', '2', '19', '1'), seg('NM1', '1P', '2', `NPI ${q.provider.npi}`, '', '', '', '', 'XX', q.provider.npi), seg('HL', '4', '3', '22', '0'), person('IL', q.subscriber), seg('TRN', '1', q.claimId), seg('AMT', 'T3', money(q.charge)), seg('DTP', '472', 'D8', d8(q.serviceDate))], env); }
export function readStatus276(tx) { const g = tx.segments; return { id: find(g, 'BHT')[3], payer: { id: find(g, 'NM1', 'PR')[9], name: find(g, 'NM1', 'PR')[3] }, provider: { npi: find(g, 'NM1', '1P')[9] }, subscriber: readPerson(g), claimId: find(g, 'TRN')[2], charge: num(find(g, 'AMT', 'T3')?.[2]), serviceDate: iso(find(g, 'DTP', '472')?.[3]) }; }
/** a: { ..., category (A1 acknowledged, A2 accepted, A3 rejected, P1 pending, F1 paid, F2 denied), status, at, charge, paid, payerControl } */
export function status277(a, env = {}) { return envelope(277, [seg('BHT', '0010', '08', a.id, d8(a.at), '1200'), seg('HL', '1', '', '20', '1'), seg('NM1', 'PR', '2', a.payer.name, '', '', '', '', 'PI', a.payer.id), seg('HL', '2', '1', '21', '1'), seg('NM1', '41', '2', 'HOSPITAL', '', '', '', '', '46', a.provider.npi), seg('HL', '3', '2', '19', '1'), seg('NM1', '1P', '2', `NPI ${a.provider.npi}`, '', '', '', '', 'XX', a.provider.npi), seg('HL', '4', '3', '22', '0'), person('IL', a.subscriber), seg('TRN', '2', a.claimId), seg('STC', [a.category, a.status], d8(a.at), '', money(a.charge), money(a.paid)), a.payerControl ? seg('REF', '1K', a.payerControl) : null].filter(Boolean), { sender: 'INSURER', receiver: 'HOSPITAL', ...env }); }
export function readStatus277(tx) { const g = tx.segments; const stc = find(g, 'STC'); return { id: find(g, 'BHT')[3], payer: { id: find(g, 'NM1', 'PR')[9], name: find(g, 'NM1', 'PR')[3] }, provider: { npi: find(g, 'NM1', '1P')[9] }, subscriber: readPerson(g), claimId: find(g, 'TRN')[2], category: comp(stc[1])[0], status: comp(stc[1])[1], at: iso(stc[2]), charge: num(stc[4]), paid: num(stc[5]), payerControl: find(g, 'REF', '1K')?.[2] ?? null }; }
/** The clearinghouse's claim acknowledgement: accepted (A1:19, then A2:20 into adjudication) or rejected (A3 with a status code). */
export function ack277CA(a, env = {}) { return envelope('277CA', [seg('BHT', '0085', '08', a.id, d8(a.at), '1200', 'TH'), seg('HL', '1', '', '20', '1'), seg('NM1', 'PR', '2', a.payer.name, '', '', '', '', 'PI', a.payer.id), seg('HL', '2', '1', '21', '1'), seg('NM1', '41', '2', 'HOSPITAL', '', '', '', '', '46', a.provider.npi), seg('HL', '3', '2', '19', '1'), seg('NM1', '85', '2', `NPI ${a.provider.npi}`, '', '', '', '', 'XX', a.provider.npi), seg('HL', '4', '3', 'PT', '0'), person('QC', a.subscriber), seg('TRN', '2', a.claimId), seg('STC', [a.category, a.status, a.entity || ''], d8(a.at), a.category === 'A3' ? 'U' : 'WQ', money(a.charge)), a.payerControl ? seg('REF', '1K', a.payerControl) : null, a.note ? seg('MSG', a.note.slice(0, 260)) : null].filter(Boolean), { sender: 'CLEARINGHOUSE', receiver: 'HOSPITAL', ...env }); }
export function readAck277CA(tx) { const g = tx.segments; const stc = find(g, 'STC'); return { id: find(g, 'BHT')[3], claimId: find(g, 'TRN')[2], category: comp(stc[1])[0], status: comp(stc[1])[1], accepted: comp(stc[1])[0] !== 'A3', charge: num(stc[4]), payerControl: find(g, 'REF', '1K')?.[2] ?? null, note: find(g, 'MSG')?.[1] ?? null }; }
/** The 999 says whether an interchange could be read at all. errors: [{ segment, position, code }] */
export function ack999({ of, accepted, errors = [], at }, env = {}) { return envelope(999, [seg('AK1', GROUP[of.type] || 'HC', String(of.control), of.version), seg('AK2', ST(of.type), '0001', of.version), ...errors.map((e) => seg('IK3', e.segment, e.position || 1, '', e.code || '8')), seg('IK5', accepted ? 'A' : 'R'), seg('AK9', accepted ? 'A' : 'R', '1', '1', accepted ? '1' : '0')], { sender: 'CLEARINGHOUSE', receiver: 'HOSPITAL', at, ...env }); }
export function readAck999(tx) { const g = tx.segments; return { accepted: find(g, 'IK5')[1] === 'A', of: { type: find(g, 'AK2')[1], version: find(g, 'AK2')[3], control: Number(find(g, 'AK1')[2]) }, errors: allOf(g, 'IK3').map((e) => ({ segment: e[1], position: num(e[2]), code: e[4] })) }; }

// ---------- 834 enrollment, 275 attachment ----------
/** e: { id, at, sponsor, payer, action: 'add'|'terminate'|'change', subscriber, plan, start, end? } */
export function enrollment834(e, env = {}) { return envelope(834, [seg('BGN', '00', e.id, d8(e.at), '1200', '', '', '', '2'), seg('N1', 'P5', e.sponsor || 'SPONSOR', 'FI', '000000000'), seg('N1', 'IN', e.payer.name, 'FI', e.payer.id), seg('INS', 'Y', '18', { add: '021', terminate: '024', change: '001' }[e.action], '', 'A', '', '', 'FT'), seg('REF', '0F', e.subscriber.memberId), seg('DTP', '356', 'D8', d8(e.start)), e.end ? seg('DTP', '357', 'D8', d8(e.end)) : null, person('IL', e.subscriber), dmg(e.subscriber), seg('HD', { add: '021', terminate: '024', change: '001' }[e.action], '', 'HLT', e.plan), seg('DTP', '348', 'D8', d8(e.start))].filter(Boolean), { sender: 'SPONSOR', receiver: 'INSURER', ...env }); }
export function readEnrollment834(tx) { const g = tx.segments; const ins = find(g, 'INS'); return { id: find(g, 'BGN')[2], payer: { id: find(g, 'N1', 'IN')[4], name: find(g, 'N1', 'IN')[2] }, action: { '021': 'add', '024': 'terminate', '001': 'change' }[ins[3]], subscriber: readPerson(g), plan: find(g, 'HD')[4], start: iso(find(g, 'DTP', '356')[3]), end: iso(find(g, 'DTP', '357')?.[3]) }; }
/** t: { id, at, payer, provider, subscriber, about: { kind: 'claim'|'auth', ref }, documents: [{ id, title, contentType, text }] } */
export function attachment275(t, env = {}) { const s = [seg('BGN', '11', t.id, d8(t.at)), seg('NM1', 'PR', '2', t.payer.name, '', '', '', '', 'PI', t.payer.id), seg('NM1', '41', '2', 'HOSPITAL', '', '', '', '', '46', t.provider.npi), person('QC', t.subscriber), seg('REF', t.about.kind === 'claim' ? 'EJ' : 'BB', t.about.ref)]; t.documents.forEach((d, i) => { const b = Buffer.from(JSON.stringify({ id: d.id, title: d.title, contentType: d.contentType || 'text/plain', text: d.text }), 'utf8').toString('base64'); s.push(seg('LX', i + 1), seg('TRN', '2', d.id), seg('DTP', '368', 'D8', d8(t.at)), seg('CAT', 'AE', 'TX'), seg('BIN', b.length, b)); }); return envelope(275, s, env); }
export function readAttachment275(tx) { const g = tx.segments; const ref = g.find((s) => s[0] === 'REF' && ['EJ', 'BB'].includes(s[1])); return { id: find(g, 'BGN')[2], payer: { id: find(g, 'NM1', 'PR')[9], name: find(g, 'NM1', 'PR')[3] }, provider: { npi: find(g, 'NM1', '41')[9] }, subscriber: readPerson(g, 'QC'), about: { kind: ref[1] === 'EJ' ? 'claim' : 'auth', ref: ref[2] }, documents: allOf(g, 'BIN').map((b) => JSON.parse(Buffer.from(b[2], 'base64').toString('utf8'))) }; }

/** Structural check of anything received: envelopes, counts, a known transaction and version. Returns { ok, errors } for the 999. */
export function validate(text) { try { const p = parse(text); const errors = []; for (const t of p.transactions) { if (!Object.values(VERSION).includes(t.version)) errors.push({ segment: 'ST', position: 1, code: '6' }); if (['837P', '837I'].includes(t.type)) { if (!find(t.segments, 'CLM')) errors.push({ segment: 'CLM', position: 1, code: '3' }); if (!t.segments.some((s) => s[0] === 'LX')) errors.push({ segment: 'LX', position: 1, code: '3' }); } } return { ok: !errors.length, errors, parsed: p }; } catch (err) { return { ok: false, errors: [{ segment: 'ISA', position: 1, code: '8', text: err.message }], parsed: null }; } }

// ---------- 820 premium payment and TA1 interchange acknowledgement ----------
/** p: { id, at, amount, method, payer: { name, id }, payee: { name, id }, members: [{ memberId, amount, period }] } */
export function premium820(p, env = {}) { const s = [seg('BPR', 'I', money(p.amount), 'C', p.method || 'ACH', 'CCP', '', '', '', '', '', '', '', '', '', '', d8(p.at)), seg('TRN', '3', p.id), seg('N1', 'PE', p.payee.name, 'FI', p.payee.id), seg('N1', 'PR', p.payer.name, 'FI', p.payer.id)]; p.members.forEach((m, i) => s.push(seg('ENT', String(i + 1), '2J', '34', m.memberId), seg('RMR', 'IK', m.memberId, '', money(m.amount)), seg('DTM', '582', '', '', '', 'RD8', m.period))); return envelope(820, s, env); }
export function readPremium820(tx) { const g = tx.segments; const b = find(g, 'BPR'); const members = []; let cur = null; for (const s of g) { if (s[0] === 'ENT') { cur = { memberId: s[4] }; members.push(cur); } else if (cur && s[0] === 'RMR') cur.amount = num(s[4]); else if (cur && s[0] === 'DTM') cur.period = s[6]; } return { id: find(g, 'TRN')[2], at: iso(b[16]), amount: num(b[2]), method: b[4], payer: { name: find(g, 'N1', 'PR')[2], id: find(g, 'N1', 'PR')[4] }, payee: { name: find(g, 'N1', 'PE')[2], id: find(g, 'N1', 'PE')[4] }, members }; }
/** TA1 for an interchange: accepted (A), accepted with errors (E) or rejected (R), with the note code. */
export function ta1({ control, at, code = 'A', note = '000' }, { sender = 'INSURER', receiver = 'HOSPITAL' } = {}) { const c9 = String(control).padStart(9, '0'); const date = d8(at); const time = at.slice(11, 16).replace(':', ''); const isa = ['ISA', '00', ' '.repeat(10), '00', ' '.repeat(10), 'ZZ', clean(sender).padEnd(15).slice(0, 15), 'ZZ', clean(receiver).padEnd(15).slice(0, 15), date.slice(2), time, '^', '00501', c9, '0', 'T', ':'].join('*'); return [isa, seg('TA1', c9, date.slice(2), time, code, note), seg('IEA', '0', c9)].map((x) => `${x}~`).join('\n'); }
export function readTa1(text) { const t = String(text).split('~').map((x) => x.trim()).find((x) => x.startsWith('TA1')); if (!t) return null; const e = t.split('*'); return { control: Number(e[1]), code: e[4], note: e[5] }; }
