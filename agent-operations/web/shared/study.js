// The researcher's current study (plan-master 6.2): chosen once, kept in this
// browser, sent with everything started from a mode page so it joins the
// study. "No study" is allowed; such work still appears under History.
import { h, btn, formDialog, toast } from '/shared/ui.js';
import { api } from '/shared/fhir.js';

const KEY = 'hd.study';
export const currentStudyId = () => { try { return localStorage.getItem(KEY) || null; } catch { return null; } };
export const setCurrentStudy = (id) => { try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch { /* ignore */ } };
/** Adds the current study to a request body so the run joins it. */
export const withStudy = (body) => (currentStudyId() ? { ...body, study: currentStudyId() } : body);

export function newStudyDialog(onMade) {
  formDialog({ title: 'New study', testid: 'study-form', submitLabel: 'Create study', intro: 'A study groups the runs, recordings, labelling projects and datasets of one research question.',
    fields: [{ name: 'title', label: 'Title', required: true, testid: 'study-title', wide: true }, { name: 'question', label: 'Research question', type: 'textarea', rows: 3, testid: 'study-question', wide: true }, { name: 'kind', label: 'Kind of study', type: 'select', options: [['standard', 'Standard: runs, recordings, labelling and datasets'], ['multi-reader', 'Multi-reader: readers see cases under conditions, crossed over, with a washout']], testid: 'study-kind', wide: true }],
    onSubmit: async (v) => { const made = await api.post('/agent-ops/research/studies', { title: v.title, question: v.question, kind: v.kind }); setCurrentStudy(made.id); toast(`Study created: ${made.title}`); onMade?.(made); } });
}

/** The "Current study" picker shown on the home page and every mode page. */
export async function studyPicker(onChange = () => {}) {
  let list = [];
  try { list = (await api.get('/agent-ops/research/studies')).studies.filter((s) => s.status === 'active'); } catch { list = []; }
  const current = currentStudyId();
  if (current && !list.some((s) => s.id === current)) setCurrentStudy(null);
  const select = h('select', { testid: 'study-picker', 'aria-label': 'Current study', style: 'width:auto;max-width:22.5rem', onChange: (e) => { setCurrentStudy(e.target.value || null); onChange(e.target.value || null); } },
    h('option', { value: '', selected: !currentStudyId() }, 'No study (work appears under History)'), ...list.map((s) => h('option', { value: s.id, selected: s.id === currentStudyId() }, s.title)));
  return h('div', { class: 'studybar', testid: 'current-study' }, h('label', { style: 'font-weight:600' }, 'Current study'), select,
    btn('New study', { small: true, testid: 'study-new', onClick: () => newStudyDialog((made) => onChange(made.id)) }),
    currentStudyId() ? h('a', { href: `#/studies/${currentStudyId()}`, testid: 'study-open', 'aria-label': 'Open the current study' }, 'Open') : null);
}
