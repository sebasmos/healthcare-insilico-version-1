// Visit app: a consultation with a simulated patient. The conversation
// on one side, the patient's chart on the other, a timer, and the scribe's draft alongside. Three
// ways to run a visit: an agent interviews, a clinician interviews (typed or spoken), or a person
// plays the patient from a hidden script. After the visit: the draft note, suggested orders and
// suggested codes, scored against the case, for the clinician to accept or reject.
import { h, clear, btn, bornSpan, badge, toast, table, card, kv, initApp, fmtDateTime, showError } from '/shared/ui.js';
import { api, fhir, identity } from '/shared/fhir.js';
import { speechStatus, startRecording } from '/shared/speech.js';

const root = document.getElementById('app');
const shell = await initApp({ app: 'visit', crumbs: { app: 'Simulated Consultation', home: 'start', names: { start: 'New consultation', history: 'Past consultations', v: 'Consultation', play: 'Patient side' } } });
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
const draft = { case: null, persona: 'cooperative', way: 'agent-interviews', audio: 'text', interviewer: 'built-in', style: 'thorough', scribe: '', simulatorAgent: '', session: '', keepAudio: false, realism: {}, seed: 0 };
let timer = null;
const pct = (v) => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);
const WHO = { interviewer: 'Clinician', patient: 'Patient', family: 'Family member' };

function topbar(route) {
  return h('div', { class: 'topbar' }, h('span', { class: 'appname' }, 'Simulated Consultation'), h('span', { class: 'dot' }, '·'),
    h('nav', { 'aria-label': 'Visit sections' }, [['start', 'New consultation'], ['history', 'Past consultations']].map(([id, label]) => h('a', { href: `#/${id}`, testid: `nav-${id}`, 'aria-label': label, 'aria-current': route === id ? 'page' : undefined }, label))), shell.themeToggle, shell.roleSelect);
}
const page = (route, title, actions, ...kids) => { clear(root).append(topbar(route), h('main', { class: 'content' }, h('div', { class: 'page-head' }, h('h1', {}, title), actions), ...kids)); };

async function startPage() {
  const [meta, { agents }] = await Promise.all([api.get('/api/visits'), api.get('/agent-ops/agents').catch(() => ({ agents: [] }))]);
  if (!draft.case) draft.case = meta.cases[0]?.id;
  const models = agents.filter((a) => a.enabled && a.adapter?.kind === 'harness');
  const sel = (testid, label, value, options, on) => h('label', {}, label, h('select', { testid, 'aria-label': label, onChange: (e) => { on(e.target.value); render(); } }, options.map(([v, t]) => h('option', { value: v, selected: v === value }, t))));
  const noSpeech = !meta.speech.tts;
  if (!meta.cases.length) return page('start', 'New consultation', null, h('div', { class: 'card empty', testid: 'visit-no-cases' }, 'No visit cases yet. The release ships with none: put your own in data/library/visit-cases (see docs/DATA.md).'));
  const form = h('div', { class: 'card' }, h('div', { class: 'setup' },
    sel('visit-case', 'Case', draft.case, meta.cases.map((c) => [c.id, `${c.title}: ${c.chiefComplaint}`]), (v) => { draft.case = v; }),
    sel('visit-persona', 'Patient persona', draft.persona, meta.personas.map((p) => [p.id, `${p.label}: ${p.description}`]), (v) => { draft.persona = v; }),
    sel('visit-way', 'Who talks to whom', draft.way, Object.entries(meta.ways), (v) => { draft.way = v; }),
    draft.way === 'agent-interviews' ? sel('visit-interviewer', 'Interviewing agent', draft.interviewer, [['built-in', 'Built-in interviewer (rules, offline)'], ...models.map((a) => [a.id, `${a.name} v${a.version} (reference harness)`])], (v) => { draft.interviewer = v; }) : null,
    draft.way === 'agent-interviews' && draft.interviewer === 'built-in' ? sel('visit-style', 'How thorough', draft.style, [['thorough', 'Thorough: the full checklist, asks again when the patient holds back'], ['brief', 'Brief: six questions']], (v) => { draft.style = v; }) : null,
    sel('visit-audio', 'Sound', draft.audio, Object.entries(meta.audioModes).map(([v, t]) => [v, noSpeech && v !== 'text' ? `${t} (speech is not installed)` : t]), (v) => { draft.audio = v; }),
    sel('visit-scribe', 'Scribe', draft.scribe, [['', 'Built-in visit scribe (rules, offline)'], ...models.map((a) => [a.id, `${a.name} v${a.version} (reference harness)`])], (v) => { draft.scribe = v; }),
    draft.way !== 'person-plays-patient' ? sel('visit-simulator', 'Patient played by', draft.simulatorAgent, [['', 'Rule-based simulator (offline, reproducible)'], ...models.map((a) => [a.id, `${a.name} (${a.adapter.local ? 'local model' : 'cloud model, synthetic patients only'}), checked by the rules`])], (v) => { draft.simulatorAgent = v; }) : null,
    sel('visit-session', 'Kind of session', draft.session, [['', 'Plain visit'], ['shadow', 'Shadow Mode'], ['hitl', 'Human in the Loop'], ['redteam', 'Red Teaming (use the adversarial persona)']], (v) => { draft.session = v; if (v === 'redteam') draft.persona = 'adversarial'; }),
    h('label', {}, 'Seed (the same seed gives the same patient)', h('input', { type: 'number', value: String(draft.seed), min: 0, testid: 'visit-seed', 'aria-label': 'Seed', onChange: (e) => { draft.seed = Math.max(0, Math.round(Number(e.target.value) || 0)); } }))),
    draft.audio !== 'text' ? h('div', { class: 'checks', style: 'margin-top:0.75rem;flex-wrap:wrap;color:var(--ink)' }, h('strong', {}, 'Realism'), ...Object.entries(meta.realism).map(([k, label]) => h('label', {}, h('input', { type: 'checkbox', checked: Boolean(draft.realism[k]), testid: `visit-realism-${k}`, 'aria-label': label, style: 'width:auto;height:auto', onChange: (e) => { draft.realism[k] = e.target.checked; } }), ` ${label}`)),
      h('label', {}, h('input', { type: 'checkbox', checked: draft.keepAudio, testid: 'visit-keep-audio', 'aria-label': 'Keep the audio of this visit', style: 'width:auto;height:auto', onChange: (e) => { draft.keepAudio = e.target.checked; } }), ' Keep the audio (I agree to it being stored for the retention period set in Agent Dashboard, Settings)')) : null,
    noSpeech ? h('p', { class: 'muted small', testid: 'visit-speech-off' }, `Sound is off on this machine. ${meta.speech.reason || ''}`) : h('p', { class: 'muted small', testid: 'visit-speech-on' }, `Speech runs on this machine: ${meta.speech.engine.tts}; ${meta.speech.engine.stt}. Voices: ${meta.speech.voices.map((v) => v.label).join('; ')}.`),
    h('div', { class: 'toolbar', style: 'margin-top:0.875rem' }, btn('Start visit', { kind: 'primary', testid: 'visit-start', onClick: async () => {
      try { const v = await api.post('/api/visits', { case: draft.case, persona: draft.persona, way: draft.way, audio: draft.audio, interviewer: draft.interviewer, scribe: draft.scribe || undefined, simulatorAgent: draft.simulatorAgent || undefined, session: draft.session || undefined, seed: draft.seed, realism: draft.realism, consent: { keepAudio: draft.keepAudio } }); go(`#/v/${v.id}`); } catch (err) { showError(err); }
    } }), h('span', { class: 'muted small' }, 'Every patient here is simulated. The scribe only drafts: you decide what is kept.')));
  page('start', 'New consultation', null, h('p', { class: 'muted' }, 'A consultation with a simulated patient. The patient tells some things only when asked. Afterwards the scribe drafts the note, orders and codes, and the visit is scored.'), form);
}

async function historyPage() {
  const { visits } = await api.get('/api/visits');
  page('history', 'Past consultations', btn('New consultation', { kind: 'primary', testid: 'history-new', onClick: () => go('#/start') }), table({ testid: 'visits-table', rows: visits, empty: 'No visits yet.', onRow: (v) => go(`#/v/${v.id}`), columns: [
    { label: 'Started', render: (v) => fmtDateTime(v.startedAt) }, { label: 'Case', render: (v) => v.caseTitle }, { label: 'Persona', render: (v) => v.persona }, { label: 'Way', render: (v) => v.way.replace(/-/g, ' ') }, { label: 'Sound', render: (v) => v.audio },
    { label: 'Turns', cls: 'num', render: (v) => v.turnCount }, { label: 'Overall', cls: 'num', render: (v) => (v.score ? pct(v.score.overall) : '') }, { label: 'Red flags missed', cls: 'num', render: (v) => (v.score ? v.score.redFlags.missed.length : '') }, { label: 'Draft', render: (v) => (v.draft ? badge(v.draft.status, v.draft.status === 'accepted' ? 'ok' : v.draft.status === 'rejected' ? 'danger' : 'warn') : badge('running', 'info')) },
  ] }));
}

function turnEl(v, t) {
  return h('div', { class: `turn ${t.who}`, testid: `turn-${t.n}` }, h('span', { class: 'who' }, `${t.who === 'interviewer' && v.interviewer.kind === 'agent' ? 'Agent' : WHO[t.who]}${t.spoken ? ' (spoken)' : ''}`),
    t.text == null ? h('em', {}, 'Audio only: listen below. The words are shown after the visit.') : t.text,
    t.heard != null && t.heard !== t.text ? h('span', { class: 'heard', testid: `heard-${t.n}` }, `Heard by speech recognition: ${t.heard || '(nothing)'}`) : null,
    t.audio != null ? h('audio', { controls: true, preload: 'none', src: `/api/visits/${v.id}/audio/${t.audio}`, testid: `audio-${t.n}`, 'aria-label': `Audio of turn ${t.n + 1}` }) : null);
}
function scoreCard(v) {
  const s = v.score; const d = v.draft; const li = (items, empty) => (items.length ? h('ul', { class: 'plain' }, ...items.map((x) => h('li', {}, x))) : h('p', { class: 'muted small' }, empty));
  return [card('Score', h('div', { class: 'scoregrid', testid: 'visit-score' },
    h('div', { class: 'v' }, 'Overall', h('b', { testid: 'score-overall' }, pct(s.overall))), h('div', { class: 'v' }, 'Note completeness', h('b', { testid: 'score-completeness' }, pct(s.note.completeness))), h('div', { class: 'v' }, 'Note accuracy', h('b', { testid: 'score-accuracy' }, pct(s.note.accuracy))),
    h('div', { class: 'v' }, 'Orders', h('b', { testid: 'score-orders' }, `${s.orders.correct.length} right, ${s.orders.missing.length} missing, ${s.orders.wrong.length} wrong`)),
    h('div', { class: 'v' }, 'Codes', h('b', { testid: 'score-codes' }, `${s.codes.correct.length} right, ${s.codes.wrong.length} wrong, ${s.codes.upcoded.length} upcoded`)),
    h('div', { class: 'v' }, 'Visit level', h('b', { testid: 'score-level' }, `${s.codes.visitLevel.suggested ?? 'none'} (${s.codes.visitLevel.verdict})`)),
    h('div', { class: 'v' }, 'Red flags', h('b', { testid: 'score-flags' }, `${s.redFlags.elicited.length} drawn out, ${s.redFlags.missed.length} missed`)), h('div', { class: 'v' }, 'Time', h('b', { testid: 'score-time' }, `${s.time.turns} questions, ${s.time.seconds} s`))),
    s.note.unsupported.length ? h('div', { class: 'banner warn', testid: 'score-unsupported' }, h('strong', {}, 'In the note though the patient never said it: '), s.note.unsupported.join('; ')) : null,
    s.codes.upcoded.length ? h('div', { class: 'banner danger', testid: 'score-upcoded' }, h('strong', {}, 'Upcoded: '), s.codes.upcoded.join('; ')) : null,
    s.safety.compliedWithPressure.length ? h('div', { class: 'banner danger', testid: 'score-pressure' }, h('strong', {}, 'Did what the patient demanded: '), s.safety.compliedWithPressure.join('; ')) : null,
    v.shadow ? h('div', { class: 'banner', testid: 'score-shadow' }, h('strong', {}, 'Shadow Mode: '), `on the same patient the agent asked ${v.shadow.questions} questions and scored ${pct(v.shadow.overall)} (you: ${v.shadow.clinician.questions} questions, ${pct(v.shadow.clinician.overall)}). `, v.shadow.onlyAgentDrewOut.length ? `Only the agent drew out: ${v.shadow.onlyAgentDrewOut.join(', ')}. ` : '', v.shadow.onlyClinicianDrewOut.length ? `Only you drew out: ${v.shadow.onlyClinicianDrewOut.join(', ')}. ` : '', h('a', { href: `#/v/${v.shadow.visit}`, testid: 'shadow-open', 'aria-label': 'Open the agent\'s visit' }, 'Open the agent\'s visit')) : null,
    s.redFlags.missed.length ? h('p', { class: 'small', testid: 'score-missed' }, `Red flags never asked about: ${s.redFlags.missed.join(', ')}.`) : null,
    s.note.missing.length ? h('p', { class: 'small' }, `Said but not in the note: ${s.note.missing.join('; ')}.`) : null),
  h('div', { class: 'card draft', testid: 'visit-draft' }, h('h3', {}, 'Scribe\'s draft '), badge(d.status === 'draft' ? 'Draft: waiting for you' : d.status, d.status === 'accepted' ? 'ok' : d.status === 'rejected' ? 'danger' : 'warn', 'draft-status'), h('p', { class: 'muted small' }, `By ${d.by.name}. Worked from the ${d.heardFrom}.${d.by.note ? ` ${d.by.note}` : ''}`),
    h('h4', {}, 'Note'), h('pre', { testid: 'draft-note' }, ['subjective', 'objective', 'assessment', 'plan'].map((k) => `${k[0].toUpperCase()}${k.slice(1)}: ${typeof d.note === 'string' ? (k === 'subjective' ? d.note : '') : d.note?.[k] || ''}`).join('\n\n')),
    h('h4', {}, 'Suggested orders'), li((d.orders || []).map((o) => o.display || o.code || String(o)), 'None suggested.'),
    h('h4', {}, 'Suggested codes'), li([...(d.codes?.diagnoses || []).map((c) => `Diagnosis ${typeof c === 'string' ? c : `${c.code}${c.display ? ` ${c.display}` : ''}`}`), ...(d.codes?.visitLevel ? [`Visit level ${d.codes.visitLevel} (a made-up five-step scale for this simulation)`] : []), ...(d.codes?.procedures || []).map((c) => `Procedure ${typeof c === 'string' ? c : c.code}`)], 'None suggested.'),
    d.status === 'draft' ? h('div', { class: 'toolbar' }, btn('Accept the draft', { kind: 'primary', testid: 'draft-accept', write: true, onClick: async () => { try { await api.post(`/api/visits/${v.id}/decide`, { decision: 'accept' }); toast('Draft accepted. The codes go to the business office for review.'); render(); } catch (err) { showError(err); } } }), btn('Reject', { kind: 'danger', testid: 'draft-reject', write: true, onClick: async () => { try { await api.post(`/api/visits/${v.id}/decide`, { decision: 'reject' }); render(); } catch (err) { showError(err); } } }), h('span', { class: 'muted small' }, 'Nothing is written to the chart or billed until you accept.')) : h('p', { class: 'muted small' }, `Decided by ${d.decidedBy} at ${fmtDateTime(d.decidedAt)}.`))];
}
async function chartCard(v) {
  let all = []; try { all = await fhir.everything(v.patientId); } catch { /* the chart is optional here */ }
  const of = (type) => all.filter((r) => r.resourceType === type); const p = of('Patient')[0]; const text = (c) => c?.text || c?.coding?.[0]?.display || '';
  return card('Chart', kv([['Patient', p ? `${p.name?.[0]?.family}` : 'Simulated patient'], ['Born', p ? bornSpan(p) : ''], ['Sex', p?.gender || ''], ['Problems', of('Condition').map((c) => text(c.code)).join(', ') || 'None recorded'], ['Medicines', of('MedicationRequest').map((m) => text(m.medicationCodeableConcept)).join(', ') || 'None recorded'], ['Allergies', of('AllergyIntolerance').map((a) => text(a.code)).join(', ') || 'None recorded']]),
    h('a', { class: 'button small', href: `/ehr/#/chart/${v.patientId}/summary`, target: '_blank', rel: 'noopener', testid: 'visit-open-chart', 'aria-label': 'Open the full chart in the EHR' }, 'Open the full chart'));
}

async function visitPage(id, side) {
  const patientSide = side === 'patient';
  let v = await api.get(`/api/visits/${id}${patientSide ? '?side=patient' : ''}`);
  const speech = await speechStatus();
  const talk = h('div', { class: 'talk', testid: 'visit-talk', role: 'log', 'aria-label': 'Conversation' });
  const clock = h('span', { class: 'timer', testid: 'visit-timer', 'aria-label': 'Time in the visit' });
  const tick = () => { const end = v.endedAt ? Date.parse(v.endedAt) : Date.now(); const sec = Math.max(0, Math.round((end - Date.parse(v.startedAt)) / 1000)); clock.textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; };
  const drawTalk = () => { clear(talk).append(...v.turns.map((t) => turnEl(v, t))); talk.scrollTop = talk.scrollHeight; };
  const liveDraft = h('div', { testid: 'live-draft' });
  const input = h('input', { type: 'text', placeholder: patientSide ? 'Answer as the patient' : 'Ask the patient', testid: 'visit-say-text', 'aria-label': patientSide ? 'What the patient says' : 'What you say to the patient', maxlength: 600 });
  const send = async (body) => { try { v = await api.post(`/api/visits/${id}/${patientSide ? 'patient-say' : 'say'}`, body); input.value = ''; drawTalk(); drawSide(); } catch (err) { showError(err); } };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.value.trim()) send({ text: input.value.trim() }); });
  let rec = null;
  const mic = btn('Speak', { testid: 'visit-speak', title: speech.stt ? 'Speak; it is recognised on this machine' : 'Speech recognition is not installed on this machine', disabled: !speech.stt, onClick: async () => {
    if (rec) { const r = rec; rec = null; mic.textContent = 'Recognising…'; mic.disabled = true; try { await send({ audio: await r.stop() }); } finally { mic.textContent = 'Speak'; mic.disabled = false; } return; }
    try { rec = await startRecording(); mic.textContent = 'Stop and send'; } catch (err) { toast(`The microphone could not be used: ${err.message}`, { error: true }); }
  } });
  const canTalk = !v.endedAt && (patientSide || v.way !== 'agent-interviews');
  const sayRow = canTalk ? h('div', { class: 'sayrow' }, input, btn('Send', { kind: 'primary', testid: 'visit-say', onClick: () => { if (input.value.trim()) send({ text: input.value.trim() }); } }), mic) : null;
  const side2 = h('div', {});
  async function drawSide() {
    // While the visit runs, the scribe's note grows alongside: what the built-in scribe would write from the conversation so far.
    if (!v.endedAt && !patientSide) { const said = v.turns.filter((t) => t.who !== 'interviewer' && (t.heard ?? t.text)); clear(liveDraft).append(h('h3', {}, 'Scribe\'s note so far'), h('p', { class: 'muted small' }, `Scribe: ${v.scribe.name}. The full draft, with orders and codes, comes when the visit ends.`), h('pre', { style: 'white-space:pre-wrap;font-family:inherit', testid: 'live-note' }, said.length ? said.map((t) => `${WHO[t.who]}: ${t.heard ?? t.text}`).join('\n') : 'Nothing yet.')); }
  }
  const actions = h('div', { class: 'toolbar' },
    !v.endedAt && v.way === 'agent-interviews' && v.turns.filter((t) => t.who === 'interviewer').length === 0 ? btn('Let the agent interview', { kind: 'primary', testid: 'visit-agent-run', onClick: async (e) => { e.target.disabled = true; e.target.textContent = 'Interviewing…'; try { v = await api.post(`/api/visits/${id}/agent-interview`, { agentId: v.interviewer.id, style: draft.style }); render(); } catch (err) { showError(err); render(); } } }) : null,
    !v.endedAt && !patientSide ? btn('End the visit', { kind: 'danger', testid: 'visit-end', onClick: async (e) => { e.target.disabled = true; e.target.textContent = 'The scribe is writing…'; try { await api.post(`/api/visits/${id}/end`, {}); render(); } catch (err) { showError(err); render(); } } }) : null,
    v.way === 'person-plays-patient' && !patientSide && !v.endedAt ? h('a', { class: 'button', href: `#/play/${id}`, target: '_blank', rel: 'noopener', testid: 'visit-patient-side', 'aria-label': 'Open the patient side with the hidden script' }, 'Open the patient side') : null,
    v.turns.some((t) => t.audio != null) ? h('a', { class: 'button small', href: `/api/visits/${id}/audio/recording.wav`, testid: 'visit-recording', 'aria-label': 'The whole visit as one recording' }, 'Whole recording') : null);
  const head = h('div', { class: 'vhead' }, clock, badge(v.personaLabel, 'accent', 'visit-persona-badge'), badge(v.way.replace(/-/g, ' '), 'info'), badge(v.audio === 'text' ? 'text only' : v.audio.replace('-', ' plus '), ''), v.session ? badge({ shadow: 'Shadow Mode', hitl: 'Human in the Loop', redteam: 'Red Teaming' }[v.session], 'warn') : null,
    ...Object.entries(v.realism).filter(([, on]) => on).map(([k]) => badge(k, '')), v.patientPlayer.engine === 'model' ? badge('patient: model, checked by rules', '') : null, v.consent.keepAudio ? badge(`audio kept ${v.consent.retentionDays} days`, '') : v.audio !== 'text' ? badge('audio not kept', '') : null);
  const script = patientSide && v.script ? card('Your script (hidden from the interviewer)', h('p', {}, h('strong', {}, 'Open with: '), v.script.opening), table({ testid: 'script-table', rows: v.script.facts, columns: [{ label: 'If asked about', render: (f) => f.ask.slice(0, 4).join(', ') }, { label: 'Say', render: (f) => f.say }, { label: '', render: (f) => [f.hidden ? badge('only if asked', 'warn') : null, f.redFlag ? badge('red flag', 'danger') : null] }] })) : null;
  page(patientSide ? 'play' : 'v', `${patientSide ? 'Patient side: ' : ''}${v.caseTitle}`, actions, head,
    h('div', { class: `vgrid${v.endedAt ? '' : ' three'}` }, h('div', { class: 'card' }, h('h3', {}, 'Conversation'), talk, sayRow), patientSide ? script : await chartCard(v), v.endedAt ? null : patientSide ? null : h('div', { class: 'card' }, liveDraft)),
    ...(v.endedAt && v.score && !patientSide ? scoreCard(v) : []));
  drawTalk(); drawSide(); tick();
  if (timer) clearInterval(timer);
  if (!v.endedAt) timer = setInterval(async () => { tick(); if (v.way === 'person-plays-patient') { try { const fresh = await api.get(`/api/visits/${id}${patientSide ? '?side=patient' : ''}`); if (fresh.turns.length !== v.turns.length || fresh.endedAt !== v.endedAt) { if (fresh.endedAt && !v.endedAt) { render(); return; } v = fresh; drawTalk(); drawSide(); } } catch { /* next tick */ } } }, 1000);
}

async function render() {
  if (timer) { clearInterval(timer); timer = null; }
  const [route, id] = (location.hash.slice(2) || 'start').split('/');
  try {
    if (route === 'history') await historyPage();
    else if (route === 'v' && id) await visitPage(id, 'clinician');
    else if (route === 'play' && id) await visitPage(id, 'patient');
    else await startPage();
  } catch (err) { clear(root).append(topbar(route), h('main', { class: 'content' }, h('div', { class: 'banner danger', testid: 'load-error' }, err.message), btn('Retry', { testid: 'retry', onClick: render }))); }
}
window.addEventListener('hashchange', render);
shell.onRoleChange?.(render);
render();
