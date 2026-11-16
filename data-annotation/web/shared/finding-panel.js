// The side panel while recording in PACS and Pathology,
// Session.html): "What is this?", confidence 1 to 5, Unsure, Reasoning (typed
// or dictated), Flag a near miss and Next case. The confidence, Unsure and the
// near-miss flag are structured events; the two texts are kept only when the
// person agreed to keep free text, masked and encrypted like other notes.
import { h, clear, btn, toast, sendCaptureContent } from './ui.js';
import { capture } from './capture.js';

/** log(action, extra): the app's own viewer event recorder. onNext(): open the next case. */
export function findingPanel({ log, onNext }) {
  const el = h('aside', { class: 'finding-panel', testid: 'finding-panel', 'aria-label': 'What you marked', hidden: true });
  const state = { confidence: null, unsure: false };
  const draw = () => {
    const rec = capture.active;
    el.hidden = !rec; clear(el);
    if (!rec) return;
    const text = Boolean(rec.consent?.thinkAloud);
    const what = h('input', { type: 'text', testid: 'annot-what', 'aria-label': 'What is this?', placeholder: 'Type what this is', disabled: !text, maxlength: 300 });
    const reasoning = h('textarea', { rows: 4, testid: 'annot-reasoning', 'aria-label': 'Reasoning', placeholder: 'Why you marked this finding', disabled: !text, maxlength: 4000 });
    const confButtons = [1, 2, 3, 4, 5].map((n) => h('button', { type: 'button', class: 'small', testid: `annot-conf-${n}`, 'aria-label': `Confidence ${n} of 5`, 'aria-pressed': String(state.confidence === n), onClick: () => { state.confidence = n; confButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(i + 1 === n))); } }, String(n)));
    const unsure = h('input', { type: 'checkbox', testid: 'annot-unsure', 'aria-label': 'Unsure', checked: state.unsure, onChange: (e) => { state.unsure = e.target.checked; } });
    const dictate = () => {
      const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Speech) { toast('Dictation needs a browser with speech recognition. Type the reasoning instead.', { error: true }); return; }
      const sr = new Speech(); sr.lang = 'en-GB'; sr.interimResults = false;
      sr.onresult = (e) => { reasoning.value = `${reasoning.value} ${[...e.results].map((r) => r[0].transcript).join(' ')}`.trim(); };
      sr.onerror = () => toast('Dictation stopped', { error: true });
      sr.start(); toast('Listening. Speak your reasoning.');
    };
    const save = async (nearMiss = false) => {
      log(nearMiss ? 'near-miss' : 'finding', { ...(state.confidence ? { confidence: state.confidence } : {}), unsure: state.unsure, hasText: Boolean(what.value.trim() || reasoning.value.trim()) }); // viewer events take numbers, booleans and short strings only
      if (text && (what.value.trim() || reasoning.value.trim())) {
        const saved = await sendCaptureContent('think-aloud', `${nearMiss ? 'Near miss. ' : ''}What: ${what.value.trim() || '(not typed)'}. Confidence: ${state.confidence ?? 'not given'}${state.unsure ? ', unsure' : ''}. Reasoning: ${reasoning.value.trim() || '(not typed)'}`);
        if (!saved) { toast('The text could not be saved', { error: true }); return; }
      }
      toast(nearMiss ? 'Near miss flagged' : 'Finding saved to the recording');
      state.confidence = null; state.unsure = false; draw();
    };
    el.append(h('h3', {}, 'What is this?'), what,
      h('div', { class: 'fp-row' }, h('span', { class: 'muted small' }, 'Confidence'), h('div', { class: 'fp-conf', role: 'group', 'aria-label': 'Confidence' }, ...confButtons)),
      h('label', { class: 'fp-check' }, unsure, ' Unsure'),
      h('label', { class: 'fp-label' }, 'Reasoning'), reasoning,
      text ? null : h('p', { class: 'muted small', testid: 'annot-text-off' }, 'Free text is off for this recording: only the marks, confidence and flags are kept.'),
      h('div', { class: 'fp-actions' },
        btn('Dictate reasoning', { small: true, testid: 'annot-dictate', disabled: !text, onClick: dictate }),
        btn('Save finding', { small: true, kind: 'primary', testid: 'annot-save-finding', onClick: () => save(false) }),
        btn('Flag a near miss', { small: true, kind: 'danger', testid: 'annot-near-miss', onClick: () => save(true) }),
        btn('Next case', { small: true, testid: 'annot-next', onClick: () => { log('next-case', {}); onNext?.(); } })));
  };
  capture.onChange(draw); draw();
  return el;
}
