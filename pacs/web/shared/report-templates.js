// Reporting workspace rules (plan-master task 3C): report templates per exam
// with bracketed fields, macros, typed "voice" commands and the critical
// finding rule. Generic and unbranded; the starter macros are marked
// unverified. Pure functions, used by the PACS page and the sign guard.

export const TEMPLATES = [
  { id: 'cxr', label: 'Chest X-ray', match: /chest|cxr|thorax/i, modalities: ['DX', 'CR', 'XR'],
    technique: 'PA and lateral views of the chest. [Comparison: none / date]',
    findings: 'Lungs: [clear / findings]. Heart size: [normal / enlarged]. Mediastinum and hila: [normal]. Pleura: [no effusion or pneumothorax]. Bones and soft tissues: [unremarkable]. Lines and tubes: [none].',
    impression: '[Impression]' },
  { id: 'ct-head', label: 'CT head', match: /head|brain/i, modalities: ['CT'],
    technique: 'Non-contrast CT of the head, axial [5] mm with coronal and sagittal reformats. [Comparison: none / date]',
    findings: 'Brain parenchyma: [no acute haemorrhage, infarct or mass]. Ventricles and sulci: [normal for age]. Midline: [no shift]. Extra-axial spaces: [normal]. Skull and scalp: [intact]. Orbits and sinuses: [clear].',
    impression: '[Impression]' },
  { id: 'ct-abdo', label: 'CT abdomen and pelvis', match: /abdom|pelvis/i, modalities: ['CT'],
    technique: 'CT of the abdomen and pelvis [with / without] intravenous contrast in the [portal venous] phase, [5] mm axial with reformats. [Comparison: none / date]',
    findings: 'Liver: [normal]. Gallbladder and biliary tree: [normal]. Pancreas: [normal]. Spleen: [normal]. Adrenals: [normal]. Kidneys and ureters: [normal]. Bladder: [normal]. Bowel: [normal calibre, no obstruction]. Peritoneum: [no free fluid or air]. Vessels: [normal]. Lymph nodes: [none enlarged]. Bones: [no aggressive lesion]. Lung bases: [clear].',
    impression: '[Impression]' },
  { id: 'ctpa', label: 'CT pulmonary angiogram', match: /pulmonary|ctpa|angiogram|embol/i, modalities: ['CT'],
    technique: 'CT pulmonary angiogram, [1] mm axial with reformats, contrast opacification [adequate]. [Comparison: none / date]',
    findings: 'Pulmonary arteries: [no filling defect to the segmental level]. Heart: [normal size, no right heart strain]. Lungs: [clear]. Pleura: [no effusion]. Mediastinum: [normal]. Bones: [unremarkable].',
    impression: '[Impression]' },
  { id: 'mri-brain', label: 'MRI brain', match: /brain|mri/i, modalities: ['MR'],
    technique: 'MRI of the brain: [T1, T2, FLAIR, DWI/ADC, SWI] sequences [with / without] gadolinium. [Comparison: none / date]',
    findings: 'Parenchyma: [no restricted diffusion, haemorrhage or mass]. White matter: [normal signal]. Ventricles and CSF spaces: [normal]. Enhancement: [none abnormal]. Vascular flow voids: [present]. Orbits, sinuses and skull base: [unremarkable].',
    impression: '[Impression]' },
  { id: 'us-abdo', label: 'Ultrasound abdomen', match: /ultrasound|sonogra/i, modalities: ['US'],
    technique: 'Ultrasound of the abdomen. [Comparison: none / date]',
    findings: 'Liver: [normal size and echotexture]. Gallbladder: [no stones, wall normal]. Common bile duct: [normal calibre]. Pancreas: [visualised, normal]. Spleen: [normal size]. Kidneys: [normal size, no hydronephrosis]. Aorta: [normal calibre]. Free fluid: [none].',
    impression: '[Impression]' },
];
export const TEMPLATES_UNVERIFIED = true;
export const FIELD = /\[[^\]\n]{1,120}\]/g;

/** The template for an exam, by modality then description. Null when nothing fits. */
export function templateFor({ description = '', modality = '' } = {}) {
  const byModality = TEMPLATES.filter((t) => !modality || t.modalities.includes(modality));
  return byModality.find((t) => t.match.test(description)) || TEMPLATES.find((t) => t.match.test(description) && t.modalities.includes(modality)) || null;
}
/** Bracketed fields still unfilled in a section. */
export const unfilledFields = (text) => (String(text || '').match(FIELD) || []);
/** Which fields block signing, by section. */
export function unfilled(sections) {
  const out = [];
  for (const [name, text] of Object.entries(sections)) for (const f of unfilledFields(text)) out.push({ section: name, field: f });
  return out;
}
/** The next (or previous) field after a caret position: { start, end } in the text, or null. */
export function fieldAfter(text, caret, { backwards = false } = {}) {
  const all = [...String(text || '').matchAll(FIELD)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  if (!all.length) return null;
  if (backwards) return [...all].reverse().find((f) => f.end < caret) || all[all.length - 1];
  return all.find((f) => f.start >= caret) || all[0];
}

export const STARTER_MACROS = [
  { name: 'normal chest', text: 'The lungs are clear. The heart size is normal. The mediastinal contours are normal. No pleural effusion or pneumothorax. The bones are unremarkable.' },
  { name: 'no acute', text: 'No acute intracranial abnormality.' },
  { name: 'no pe', text: 'No pulmonary embolus to the segmental level.' },
  { name: 'comparison none', text: 'No prior study is available for comparison.' },
  { name: 'limited', text: 'The study is limited by [reason]; findings should be interpreted with that in mind.' },
];
export const MACROS_UNVERIFIED = true;
/** Finds a macro by its short name (case-insensitive, spaces and hyphens alike). */
export function findMacro(macros, name) {
  const key = String(name || '').trim().toLowerCase().replace(/[-_]+/g, ' ');
  return macros.find((m) => m.name.toLowerCase().replace(/[-_]+/g, ' ') === key) || null;
}

export const COMMANDS = [
  ['next field', 'Move to the next bracketed field'], ['previous field', 'Move to the previous bracketed field'], ['insert <macro>', 'Insert a macro by its short name'],
  ['delete last sentence', 'Remove the last sentence in the current section'], ['sign report', 'Sign the report (asks to confirm)'], ['save draft', 'Save the draft now'],
];
/** Parses a typed or spoken command. { kind, arg } or null. */
export function parseCommand(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!]+$/, '');
  if (!t) return null;
  if (/^next( field)?$/.test(t)) return { kind: 'next' };
  if (/^(previous|prev|back)( field)?$/.test(t)) return { kind: 'previous' };
  const ins = t.match(/^insert (.+)$/); if (ins) return { kind: 'insert', arg: ins[1].trim() };
  if (/^delete last sentence$/.test(t)) return { kind: 'delete-sentence' };
  if (/^sign( report)?$/.test(t)) return { kind: 'sign' };
  if (/^save( draft)?$/.test(t)) return { kind: 'save' };
  return null;
}
/** Removes the last sentence of a text. */
export function deleteLastSentence(text) {
  const t = String(text || '').replace(/\s+$/, '');
  const parts = t.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) || [];
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('').replace(/\s+$/, '');
}

export const CRITICAL_URL = 'urn:hospital-desktop:report-critical';
export const CRITICAL_TOLD_URL = 'urn:hospital-desktop:critical-communicated';
/** The sign-time rule for a critical finding: who was told, how and when, all present. Returns the issue text or null. */
export function criticalIssue(report) {
  const flagged = (report.extension || []).find((e) => e.url === CRITICAL_URL)?.valueBoolean;
  if (!flagged) return null;
  let told = null; try { told = JSON.parse((report.extension || []).find((e) => e.url === CRITICAL_TOLD_URL)?.valueString || 'null'); } catch { told = null; }
  if (!told || !String(told.to || '').trim() || !String(told.how || told.readBack != null ? told.how || 'read back' : '').trim() || !told.at) return 'A critical finding must document who was told, how and when before the report can be signed';
  return null;
}
