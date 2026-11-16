// Redaction of free text before it is stored or exported. Pattern based: it
// removes identifiers that have a recognisable shape (record numbers, dates,
// phone numbers, e-mail addresses, long digit runs) and any names it is
// given. It is a safeguard for synthetic data, not a certified
// de-identification tool.
const PATTERNS = [
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['mrn', /\bN\d{6}\b/g],
  ['date', /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g],
  ['date', /\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g],
  ['phone', /(?<![\w.])\+?\d[\d ()-]{7,}\d(?![\w.])/g],
  ['number', /\b\d{7,}\b/g],
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Name parts of the given patients (three letters or more), for redaction. */
import { earlierNames } from './store.mjs';
export function nameParts(patients) {
  const parts = new Set();
  for (const p of patients || []) {
    for (const n of [...(p?.name || []), ...earlierNames(p)].filter((x) => !/^Patient /.test(x?.family || ''))) { // the number label is not a name to mask
      for (const part of [n.family, ...(n.given || []), ...(String(n.text || '').split(/\s+/))]) {
        if (typeof part === 'string' && part.trim().length >= 3) parts.add(part.trim());
      }
    }
  }
  return [...parts];
}

/**
 * Returns { text, count, kinds }. With sameLength the redacted stretch is
 * replaced by X characters of equal length, so character offsets (for span
 * labels) still line up.
 */
export function redactText(input, { names = [], sameLength = false } = {}) {
  let text = String(input ?? '');
  let count = 0;
  const kinds = {};
  const swap = (kind) => (match) => {
    count += 1;
    kinds[kind] = (kinds[kind] || 0) + 1;
    return sameLength ? 'X'.repeat(match.length) : `[${kind}]`;
  };
  for (const [kind, pattern] of PATTERNS) text = text.replace(pattern, swap(kind));
  const sorted = [...names].sort((a, b) => b.length - a.length);
  if (sorted.length) text = text.replace(new RegExp(`(?<![A-Za-z])(?:${sorted.map(escape).join('|')})(?![A-Za-z])`, 'gi'), swap('name'));
  return { text, count, kinds };
}
