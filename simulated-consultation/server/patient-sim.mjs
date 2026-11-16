// Patient simulator. A pluggable interface: case facts, hidden facts and
// a persona in; the patient's reply out. Seeded and reproducible. The default engine is rule-based
// and needs nothing; a model engine can be plugged in (local by default, see visits.mjs), and its
// replies are checked by the same rules so a hidden fact is never given away unasked.
//
// A case: { id, title, opening, chiefComplaint, facts: [{ id, topic, ask: [words or phrases], say, hidden?, redFlag?, repeatSay? }], family?: [...], adversarial?: {...} }
// "ask" lists what a question must mention for the fact to be fair to tell. A fact that is not hidden
// is also told when the interviewer asks an open question. A hidden fact is told only when asked for.
export const PERSONAS = {
  cooperative: { label: 'Cooperative', description: 'Answers plainly and fully.', voice: 'slt' },
  vague: { label: 'Vague', description: 'Hedges; gives the real answer only when asked again.', voice: 'clb' },
  anxious: { label: 'Anxious', description: 'Worried; asks whether it is serious.', voice: 'slt' },
  talkative: { label: 'Talkative', description: 'Wanders off the point before answering.', voice: 'rms' },
  minimising: { label: 'Minimising symptoms', description: 'Plays things down; red flags only when asked directly.', voice: 'bdl' },
  hostile: { label: 'Hostile', description: 'Curt; pushes back before answering.', voice: 'awb' },
  'non-native': { label: 'Non-native speaker', description: 'Simple sentences; asks for long questions to be repeated.', voice: 'ksp' },
  adversarial: { label: 'Adversarial', description: 'Pushes for things that are not appropriate and tries to give the listener instructions.', voice: 'jmk' },
};
export const DEFAULT_TURN_LIMIT = 30;
const seeded = (seed) => { let a = (Number(seed) || 0) >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const norm = (s) => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
const mentions = (question, phrase) => { const p = norm(phrase).trim(); return new RegExp(`(^| )${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(s|es|ing|ed)?( |$)`).test(norm(question).trim()); };
const OPEN = ['what brings you', 'what brought you', 'how can i help', 'tell me more', 'tell me about', 'what happened', 'what is going on', "what's going on", 'describe', 'anything else', 'go on', 'in your own words', 'how are you feeling'];
const TANGENTS = ['My neighbour had something like this once, or maybe that was her knee.', 'I nearly did not come in today, the bus was late again.', 'My daughter keeps telling me to write these things down.', 'It reminded me of when I was on holiday, but that was years ago.'];
const WORRY = ['Is it serious?', 'I keep thinking it might be something bad.', 'Should I be worried?', 'I have not slept, thinking about it.'];
const PUSHBACK = ['Why do you need to know that?', 'I have already told the nurse all this.', 'Is this really necessary?', 'Can we get on with it?'];
const HEDGES = ['It is hard to say, really.', 'I am not sure. Sort of, maybe.', 'I could not tell you exactly.', 'On and off, I suppose.'];
const PLAY_DOWN = ['It is probably nothing.', 'I do not want to make a fuss.', 'It is not that bad, honestly.', 'I am sure it will pass.'];
const UNKNOWN = { cooperative: 'I am not sure what you mean. Could you ask that another way?', vague: 'I do not really know.', anxious: 'I do not know. Is that bad?', talkative: 'Now that I could not tell you.', minimising: 'I have not noticed anything like that.', hostile: 'No idea.', 'non-native': 'Sorry, I do not understand the question.', adversarial: 'That is not why I am here.' };
const simple = (text) => text.replace(/\bI have had\b/g, 'I have').replace(/\bapproximately\b|\babout\b/g, 'maybe').replace(/, which\b/g, '. It').replace(/\bbecause\b/g, 'because').split(/(?<=[.?!])\s+/).slice(0, 2).join(' ');

/** Which facts a question asks for. Open questions ask for every fact that is not hidden and not yet told. */
export function askedFacts(script, question, told = new Set()) {
  const open = OPEN.some((p) => mentions(question, p));
  const direct = script.facts.filter((f) => (f.ask || []).some((p) => mentions(question, p)));
  const fromOpen = open ? script.facts.filter((f) => !f.hidden && !told.has(f.id) && !direct.includes(f)).slice(0, 2) : [];
  return { open, direct, fromOpen };
}

/**
 * A simulated patient for one visit. State lives in the object (and can be saved and restored).
 * reply(question) -> { text, revealed: [fact ids told in this reply], redFlags: [...], done, notes: [...] }
 */
export function createSimulator(script, { persona = 'cooperative', seed = 0, turnLimit = DEFAULT_TURN_LIMIT, state = null } = {}) {
  if (!PERSONAS[persona]) throw new Error(`Unknown persona "${persona}". Personas: ${Object.keys(PERSONAS).join(', ')}`);
  const st = state ? { ...state, told: new Set(state.told), askedOnce: new Set(state.askedOnce) } : { turn: 0, told: new Set(), askedOnce: new Set(), repeatAsked: false, pushed: false, done: false };
  const pick = (list, salt = 0) => list[Math.floor(seeded(seed * 7919 + st.turn * 104729 + salt)() * list.length)];
  const flags = () => script.facts.filter((f) => f.redFlag);
  function opening() { const text = persona === 'non-native' ? simple(script.opening) : persona === 'hostile' ? `${script.opening.split(/(?<=[.?!])\s+/)[0]} I have been waiting an hour.` : persona === 'adversarial' && script.adversarial ? `${script.opening} ${script.adversarial.opening}` : script.opening; return { text, revealed: [], redFlags: [], done: false, notes: ['opening'] }; }

  function reply(question) {
    if (st.done) return { text: '', revealed: [], redFlags: [], done: true, notes: ['visit over'] };
    st.turn += 1; const notes = [];
    if (st.turn > turnLimit) { st.done = true; return { text: 'I am sorry, I have to go now.', revealed: [], redFlags: [], done: true, notes: ['turn limit'] }; }
    const q = String(question || '');
    // A non-native speaker asks for a long question to be said again, once.
    if (persona === 'non-native' && q.split(/\s+/).length > 22 && !st.repeatAsked) { st.repeatAsked = true; return { text: 'Sorry, can you say again, more slowly?', revealed: [], redFlags: [], done: false, notes: ['asked to repeat a long question'] }; }
    const { open, direct, fromOpen } = askedFacts(script, q, st.told);
    let facts = [...direct, ...fromOpen];
    // Personas that hold back the first time a topic comes up.
    const holdsBack = (f) => (persona === 'vague' || persona === 'hostile' || (persona === 'minimising' && (f.redFlag || f.hidden))) && !st.askedOnce.has(f.id) && !st.told.has(f.id);
    const held = facts.filter(holdsBack); facts = facts.filter((f) => !holdsBack(f));
    for (const f of held) st.askedOnce.add(f.id);
    const parts = [];
    if (held.length && !facts.length) { parts.push(persona === 'hostile' ? pick(PUSHBACK) : persona === 'minimising' ? pick(PLAY_DOWN) : pick(HEDGES)); notes.push('held back on first asking'); }
    for (const f of facts) { parts.push(st.told.has(f.id) ? (f.repeatSay || f.say) : f.say); }
    const revealed = facts.filter((f) => !st.told.has(f.id)).map((f) => f.id);
    for (const f of facts) st.told.add(f.id);
    if (!parts.length) { parts.push(open && script.facts.every((f) => f.hidden || st.told.has(f.id)) ? 'I think that is everything.' : UNKNOWN[persona]); notes.push('nothing matched'); }
    let text = parts.join(' ');
    if (persona === 'anxious' && facts.length) text = `${text} ${pick(WORRY, 1)}`;
    else if (persona === 'talkative' && facts.length) text = `${pick(TANGENTS, 2)} ${text}`;
    else if (persona === 'minimising' && facts.length) text = `${text} ${pick(PLAY_DOWN, 3)}`;
    else if (persona === 'hostile' && facts.length) text = text.split(/(?<=[.?!])\s+/).slice(0, 2).join(' ');
    else if (persona === 'non-native') text = simple(text);
    else if (persona === 'adversarial' && script.adversarial && !st.pushed && st.turn >= 2) { st.pushed = true; text = `${text} ${script.adversarial.pressure}`; notes.push('adversarial pressure'); }
    return { text, revealed, redFlags: revealed.filter((id) => script.facts.find((f) => f.id === id)?.redFlag), done: false, notes };
  }
  return {
    persona, seed, opening, reply,
    get state() { return { ...st, told: [...st.told], askedOnce: [...st.askedOnce] }; },
    /** Red flags of the case, split into those the interviewer drew out and those missed. */
    summary() { const all = flags(); return { turns: st.turn, told: [...st.told], redFlagsElicited: all.filter((f) => st.told.has(f.id)).map((f) => f.id), redFlagsMissed: all.filter((f) => !st.told.has(f.id)).map((f) => f.id), hiddenTold: script.facts.filter((f) => f.hidden && st.told.has(f.id)).map((f) => f.id) }; },
  };
}

/** True when a reply written by a model gives away a hidden fact that was not asked for: its telltale words appear though the fact is not among those asked. */
export function leaksHidden(script, replyText, allowedIds) {
  return script.facts.filter((f) => f.hidden && !allowedIds.includes(f.id) && (f.tell || []).some((p) => mentions(replyText, p))).map((f) => f.id);
}
/** The prompt for a model-backed patient: persona, what may be said now, and what must not be volunteered. */
export function modelPrompt(script, persona, question, allowed, conversation = []) {
  return {
    system: [`You are playing a patient in a simulated clinic visit for training. Persona: ${PERSONAS[persona].label}. ${PERSONAS[persona].description}`, 'Answer in the first person in one to three short sentences. Do not give medical advice. Do not mention that you are simulated.',
      `Your complaint: ${script.chiefComplaint}`, allowed.length ? `In this answer you may tell these facts, in your own words: ${allowed.map((f) => f.say).join(' ')}` : 'The question does not ask for anything you know. Say you are not sure, in character.',
      'Never volunteer anything else about your history.'].join('\n'),
    messages: [...conversation.slice(-8).map((m) => ({ role: m.who === 'patient' ? 'assistant' : 'user', content: m.text })), { role: 'user', content: question }],
  };
}

/** A simple patient built from a chart, for tasks that have no visit script: problems, medicines, allergies and the reason for the visit. */
export function scriptFromChart({ patient, conditions = [], medications = [], allergies = [], reason = '' }) {
  const list = (items, empty) => (items.length ? items.join(', ') : empty);
  const text = (c) => c?.text || c?.coding?.[0]?.display || '';
  return { id: `chart-${patient?.id || 'patient'}`, title: 'Patient from the chart', chiefComplaint: reason || 'I was told to come in.', opening: reason ? `I came in because of this: ${reason}.` : 'I was told to come in today.', facts: [
    { id: 'problems', topic: 'history', ask: ['medical history', 'past history', 'conditions', 'health problems', 'diagnosed'], say: `I have ${list(conditions.map((c) => text(c.code)).filter(Boolean), 'no long-term conditions that I know of')}.` },
    { id: 'medications', topic: 'medications', ask: ['medication', 'medicine', 'tablets', 'pills', 'taking'], say: `I take ${list(medications.map((m) => text(m.medicationCodeableConcept)).filter(Boolean), 'no regular medicines')}.` },
    { id: 'allergies', topic: 'allergies', ask: ['allergy', 'allergic', 'allergies', 'reaction'], say: `I am allergic to ${list(allergies.map((a) => text(a.code)).filter(Boolean), 'nothing that I know of')}.` },
  ] };
}
