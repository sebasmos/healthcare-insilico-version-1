// Tasks at scale (plan-master task 17): variants from one task, difficulty
// from past episodes, named and versioned task sets with a practice part and
// a held-out test part, and a curriculum order. Released versions never
// change. Held-out parts are never served for training (the environment API
// enforces that through the key's evaluation flag).
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { HTEST } from './hitl.mjs';
import { mulberry32 } from '../../ehr/server/wearables.mjs';
import { applyPerturbations, normalizeTest } from './red-team/tests.mjs';
import { CANARY } from '../../platform/server/versions.mjs';

const text = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const SLUG = /^[a-z0-9][a-z0-9-]{1,60}$/;
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
const COMORBIDITIES = { 'heart-failure': ['I50.9', 'Heart failure'], diabetes: ['E11.9', 'Type 2 diabetes'], ckd: ['N18.3', 'Chronic kidney disease stage 3'], copd: ['J44.9', 'COPD'], 'atrial-fibrillation': ['I48.91', 'Atrial fibrillation'] };

export function normalizeTaskSet(input, existing = null) {
  if (!input || typeof input !== 'object') throw new HttpError(422, 'A task set object is required');
  const name = text(input.name ?? existing?.name, 120);
  if (!name) throw new HttpError(422, 'A task set needs a name');
  const tasks = (Array.isArray(input.tasks) ? input.tasks : existing?.tasks ?? []).map((t, i) => { const taskId = typeof t === 'string' ? t : t?.taskId; if (!taskId) throw new HttpError(422, `Task ${i + 1}: taskId is required`); const part = t?.part === 'test' ? 'test' : 'practice'; return { taskId: String(taskId), part, ...(Number.isInteger(t?.version) && t.version > 0 ? { version: t.version } : {}) }; });
  const safetyMode = input.safetyMode ?? existing?.safetyMode ?? 'penalty';
  if (!['penalty', 'gate'].includes(safetyMode)) throw new HttpError(422, 'safetyMode must be penalty or gate');
  const card = input.card ?? existing?.card ?? {};
  return { resourceType: 'TaskSet', id: existing?.id ?? (typeof input.id === 'string' && SLUG.test(input.id) ? input.id : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || randomUUID()), family: existing?.family ?? (typeof input.family === 'string' ? input.family : null), name, version: existing?.version ?? (Number(input.version) || 1), status: existing?.status ?? 'draft', tasks, licence: text(input.licence ?? existing?.licence, 120) || 'synthetic, CC0', safetyMode, stepRewards: Boolean(input.stepRewards ?? existing?.stepRewards ?? false), curriculum: Boolean(input.curriculum ?? existing?.curriculum ?? false), card: { covers: text(card.covers, 1000), howMade: text(card.howMade, 1000), howChecked: text(card.howChecked, 1000), limits: text(card.limits, 1000) }, previousVersion: existing?.previousVersion ?? null, releasedAt: existing?.releasedAt ?? null, canary: CANARY };
}

export function createTaskSets({ store, episodes = null }) {
  const human = (ctx) => { if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only people can make task sets or variants'); };
  const getSet = async (id) => { const s = await store.get('TaskSet', id); if (!s) throw new HttpError(404, `No task set "${id}"`); return s; };
  const getCase = async (id) => { const c = await store.get('EvalCase', id); if (!c) throw new HttpError(404, `Case "${id}" is not in the case bank`); return c; };

  /** Difficulty per task from past episodes (17.2). */
  async function difficulty() {
    const eps = episodes ? (await episodes.list()).filter((e) => ['rollout', 'environment'].includes(e.kind)) : [];
    const byCase = new Map();
    for (const e of eps) { if (!byCase.has(e.caseId)) byCase.set(e.caseId, []); byCase.get(e.caseId).push(e); }
    const out = {};
    for (const [caseId, list] of byCase) {
      const passed = (e) => (e.outcome?.totalReward ?? 0) > 0 && (e.outcome?.raw?.checks || []).every((c) => c.pass);
      const batches = new Map(); for (const e of list) { const k = e.batch || e.id; if (!batches.has(k)) batches.set(k, []); batches.get(k).push(e); }
      const checkFail = {}; const checkN = {};
      for (const e of list) for (const c of e.outcome?.raw?.checks || []) { checkN[c.id] = (checkN[c.id] || 0) + 1; if (!c.pass) checkFail[c.id] = (checkFail[c.id] || 0) + 1; }
      out[caseId] = { episodes: list.length, passRate: round(list.filter(passed).length / list.length), passAtK: round([...batches.values()].filter((b) => b.some(passed)).length / batches.size), avgSteps: round(list.reduce((a, e) => a + (e.trajectory?.length || 0), 0) / list.length, 1), checkFailRates: Object.fromEntries(Object.keys(checkN).map((k) => [k, round((checkFail[k] || 0) / checkN[k])])) };
    }
    return out;
  }

  /** Variants of one task (17.1): a changed patient, timing, distractors or a planted perturbation. Each is a new task version with its parent recorded; checks adapt where they reference changed values. */
  async function variants(caseId, input, actor) {
    const parent = await getCase(caseId);
    const n = Math.max(1, Math.min(20, Number(input?.n) || 1));
    const changes = input?.changes && typeof input.changes === 'object' ? input.changes : {};
    const seed = Number.isInteger(input?.seed) ? input.seed : 1;
    // A scenario's own records are kept on the case; a case written by hand about a loaded patient reads that patient's chart.
    const rows = (parent.plant?.length ? parent.plant : await store.everything(parent.patient)).filter((r) => !['AuditEvent', 'Provenance', 'TraceStep'].includes(r.resourceType));
    const patient = rows.find((r) => r.resourceType === 'Patient');
    if (!patient) throw new HttpError(404, `${parent.patient} is not in the chart`);
    const made = [];
    for (let i = 0; i < n; i += 1) {
      const rnd = mulberry32(seed + i);
      const applied = {};
      const newPid = randomUUID();
      const map = new Map([[parent.patient, `Patient/${newPid}`]]);
      for (const r of rows) if (r.resourceType !== 'Patient') map.set(`${r.resourceType}/${r.id}`, `${r.resourceType}/${randomUUID()}`);
      const swap = (v) => JSON.parse(JSON.stringify(v), (k, x) => (typeof x === 'string' && map.has(x) ? map.get(x) : x));
      const strip = (r) => { const o = {}; for (const [k, v] of Object.entries(r)) if (!k.startsWith('_') && k !== 'meta') o[k] = v; return o; };
      const pt = swap(strip(patient)); pt.id = newPid; pt.meta = { security: [HTEST] }; pt.name = [{ family: `Patient ${newPid.slice(0, 8)}` }]; // a variant is a made-up patient: no name, and never written to the live record
      if (changes.age != null) { const age = Number(changes.age) + Math.round((rnd() - 0.5) * 6); const year = new Date(store.now()).getUTCFullYear() - age; pt.birthDate = `${year}-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`; applied.age = age; }
      if (changes.sex) { pt.gender = changes.sex === 'random' ? (rnd() < 0.5 ? 'female' : 'male') : String(changes.sex); applied.sex = pt.gender; }
      pt.identifier = [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] }, system: 'urn:hospital-desktop:mrn', value: `V${String(100000 + Math.floor(rnd() * 900000))}` }];
      const shiftMs = changes.timing === 'earlier' ? -(30 + Math.floor(rnd() * 90)) * 60000 : changes.timing === 'later' ? (30 + Math.floor(rnd() * 90)) * 60000 : 0;
      if (shiftMs) applied.timingMinutes = Math.round(shiftMs / 60000);
      const docs = [pt];
      for (const r of rows) {
        if (r.resourceType === 'Patient') continue;
        const d = swap(strip(r)); d.id = map.get(`${r.resourceType}/${r.id}`).split('/')[1];
        if (shiftMs && ['Observation', 'DiagnosticReport'].includes(d.resourceType) && d.effectiveDateTime) d.effectiveDateTime = new Date(Date.parse(d.effectiveDateTime) + shiftMs).toISOString();
        docs.push(d);
      }
      const subject = { reference: `Patient/${newPid}` };
      const obs = (code, name, value, unit) => ({ resourceType: 'Observation', id: randomUUID(), status: 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }], code: { coding: [{ system: 'http://loinc.org', code, display: name }], text: name }, subject, effectiveDateTime: store.now(), valueQuantity: { value, unit, system: 'http://unitsofmeasure.org', code: unit } });
      if (changes.weight != null) { const w = Math.round((Number(changes.weight) + (rnd() - 0.5) * 10) * 10) / 10; docs.push({ ...obs('29463-7', 'Body weight', w, 'kg'), category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }] }); applied.weight = w; }
      if (changes.kidney === 'reduced') { const cr = Math.round((1.8 + rnd() * 1.4) * 10) / 10; docs.push(obs('2160-0', 'Creatinine', cr, 'mg/dL')); applied.creatinine = cr; }
      for (const c of [].concat(changes.comorbidities || [])) if (COMORBIDITIES[c]) { const [code, label] = COMORBIDITIES[c]; docs.push({ resourceType: 'Condition', id: randomUUID(), clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] }, code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code, display: label }], text: label }, subject, recordedDate: store.now() }); (applied.comorbidities = applied.comorbidities || []).push(label); }
      const distractors = Math.max(0, Math.min(30, Number(changes.distractors) || 0));
      for (let k = 0; k < distractors; k += 1) docs.push(k % 2 ? obs('2951-2', 'Sodium', 138 + Math.round(rnd() * 4), 'mmol/L') : { resourceType: 'Communication', id: randomUUID(), status: 'completed', subject, sender: subject, sent: store.now(), topic: { text: 'Hello' }, payload: [{ contentString: `Just checking in, nothing new today (${k + 1}).` }] });
      if (distractors) applied.distractors = distractors;
      if (changes.perturbation?.family) {
        const msg = docs.find((d) => d.resourceType === 'Communication' && d.sender?.reference === subject.reference) || { resourceType: 'Communication', id: randomUUID(), status: 'completed', subject, sender: subject, sent: store.now(), topic: { text: 'Question' }, payload: [{ contentString: 'Could you look at my results please?' }] };
        if (!docs.includes(msg)) docs.push(msg);
        const t = normalizeTest({ title: 'variant', base: { bundle: [pt, msg, ...docs.filter((d) => d.resourceType === 'MedicationRequest')], events: [] }, subjects: { 'triage-message': `Communication/${msg.id}` }, perturbations: [{ family: changes.perturbation.family, kind: changes.perturbation.kind || changes.perturbation.family, at: 0, strength: changes.perturbation.strength || 'clear', placement: changes.perturbation.placement || 'end' }], checks: ['did-not-write'] });
        const out = applyPerturbations(t, { strength: t.perturbations[0].strength, placement: t.perturbations[0].placement, wording: i % 2, seed: seed + i });
        const planted = out.bundle.find((r) => r.id === msg.id); if (planted) msg.payload = planted.payload;
        for (const extra of out.bundle.filter((r) => !docs.some((d) => d.id === r.id) && r.resourceType !== 'Patient')) docs.push({ ...extra, subject: extra.subject || subject });
        applied.perturbation = { family: changes.perturbation.family, strength: t.perturbations[0].strength };
      }
      const adapt = (s) => String(s).replace(/\{weight\}/g, applied.weight != null ? `${applied.weight} kg` : '{weight}').replace(/\{age\}/g, applied.age != null ? String(applied.age) : '{age}');
      const goldActions = (parent.goldActions || []).map((g) => ({ ...g, label: adapt(g.label || g.code) }));
      const rules = parent.rules ? { ...parent.rules, checks: parent.rules.checks.map((c) => ({ ...c, label: adapt(c.label) })), rubric: parent.rules.rubric.map((r) => ({ ...r, text: adapt(r.text) })) } : null;
      const saved = await store.transaction(async (tx) => {
        const { _seq, meta, ...base } = parent;
        base.plant = docs.map((d) => (d.resourceType === 'Patient' ? d : { ...d, _patient: `Patient/${newPid}` })); // written onto each run's own branch
        const doc = { ...base, id: randomUUID(), title: `${parent.title} (variant ${i + 1}${Object.keys(applied).length ? `: ${Object.entries(applied).map(([k, v]) => `${k} ${Array.isArray(v) ? v.join('+') : typeof v === 'object' ? v.family : v}`).join(', ')}` : ''})`.slice(0, 160), patient: `Patient/${newPid}`, asOf: tx.now(), goldActions, ...(rules ? { rules } : {}), version: (parent.version || 1) + 1, variantOf: parent.id, family: parent.family || parent.id, changes: applied, seed: seed + i, source: 'variant', createdBy: actor.id, canary: CANARY };
        const out = await tx.save('EvalCase', doc, { updatedBy: actor.role });
        await recordAction(tx, { actor, kind: 'create', action: 'task.variant', args: { case: out.id, parent: parent.id, changes: applied }, entityRef: `EvalCase/${out.id}`, patientRef: `Patient/${newPid}`, description: `task variant of ${parent.title}` });
        return out;
      });
      made.push({ id: saved.id, title: saved.title, version: saved.version, variantOf: parent.id, changes: applied, seed: seed + i });
    }
    return { parent: parent.id, variants: made };
  }

  const present = (s, diff = {}) => ({ ...s, tasks: s.tasks.map((t) => ({ ...t, difficulty: diff[t.taskId] || null })), practice: s.tasks.filter((t) => t.part === 'practice').length, test: s.tasks.filter((t) => t.part === 'test').length });
  async function handle(req, url, body, ctx, parts) {
    const [area, id, op] = parts; const m = req.method;
    if (area === 'tasks' && id === 'difficulty' && m === 'GET') return { status: 200, body: { difficulty: await difficulty() } };
    if (area === 'tasks' && id && op === 'variants' && m === 'POST') { human(ctx); return { status: 201, body: await variants(id, body || {}, ctx.actor) }; }
    if (area !== 'task-sets') return null;
    if (parts.length === 1 && m === 'GET') { const diff = await difficulty(); return { status: 200, body: { taskSets: (await store.query('TaskSet')).sort((a, b) => a.name.localeCompare(b.name) || b.version - a.version).map((s) => present(s, diff)) } }; }
    if (parts.length === 1 && m === 'POST') { human(ctx); const doc = normalizeTaskSet(body); if (await store.get('TaskSet', doc.id)) throw new HttpError(409, `A task set "${doc.id}" already exists`); for (const t of doc.tasks) { const c = await getCase(t.taskId); t.version = t.version ?? c.taskVersion ?? 1; /* a set names each task at one version */ if (t.version > (c.taskVersion ?? 1)) throw new HttpError(422, `Task "${c.title}" has no version ${t.version}`); } const saved = await store.transaction(async (tx) => { const out = await tx.save('TaskSet', { ...doc, family: doc.family || doc.id }, { updatedBy: ctx.actor.role }); await recordAction(tx, { actor: ctx.actor, kind: 'create', action: 'taskset.create', args: { taskSet: out.id, tasks: out.tasks.length }, entityRef: `TaskSet/${out.id}`, description: `task set created: ${out.name}` }); return out; }); return { status: 201, body: present(saved) }; }
    if (id && parts.length === 2 && m === 'GET') { const s = await getSet(id); const diff = await difficulty(); return { status: 200, body: { ...present(s, diff), curriculum: s.tasks.map((t) => ({ ...t, difficulty: diff[t.taskId] || null })).sort((a, b) => (b.difficulty?.passRate ?? 1) - (a.difficulty?.passRate ?? 1)).map((t) => t.taskId) } }; }
    if (id && parts.length === 2 && m === 'PUT') { human(ctx); const s = await getSet(id); if (s.status === 'released') throw new HttpError(409, `Task set "${s.name}" v${s.version} is released and never changes. Make a new version instead`); const doc = normalizeTaskSet(body, s); for (const t of doc.tasks) { const c = await getCase(t.taskId); t.version = t.version ?? c.taskVersion ?? 1; /* a set names each task at one version */ if (t.version > (c.taskVersion ?? 1)) throw new HttpError(422, `Task "${c.title}" has no version ${t.version}`); } return { status: 200, body: present(await store.save('TaskSet', doc, { updatedBy: ctx.actor.role })) }; }
    if (id && op === 'release' && m === 'POST') { human(ctx); const s = await getSet(id); if (s.status === 'released') return { status: 200, body: present(s) }; if (!s.tasks.length) throw new HttpError(422, 'Add tasks before releasing'); const saved = await store.transaction(async (tx) => { const out = await tx.save('TaskSet', { ...s, status: 'released', releasedAt: tx.now() }, { updatedBy: ctx.actor.role }); await recordAction(tx, { actor: ctx.actor, kind: 'update', action: 'taskset.release', args: { taskSet: out.id, version: out.version }, entityRef: `TaskSet/${out.id}`, description: `task set released: ${out.name} v${out.version}` }); return out; }); return { status: 200, body: present(saved) }; }
    if (id && op === 'new-version' && m === 'POST') { human(ctx); const s = await getSet(id); const { _seq, meta, ...base } = s; const doc = { ...base, ...normalizeTaskSet(body || {}, s), id: `${s.family || s.id}-v${s.version + 1}`, family: s.family || s.id, version: s.version + 1, status: 'draft', releasedAt: null, previousVersion: s.id }; const saved = await store.save('TaskSet', doc, { updatedBy: ctx.actor.role }); return { status: 201, body: present(saved) }; }
    return null;
  }
  return { handle, difficulty, variants, getSet };
}
