// Finds strings that look like a person's name in text the app serves.
// No list of names is kept in the repository. Two checks:
//   1. a title followed by a capitalised word ("Dr X", "Mrs X");
//   2. when the computer has the usual word lists (/usr/share/dict), any capitalised word that is on the
//      proper-names list and is not also an ordinary word. Method names from statistics and imaging are allowed.
import fs from 'node:fs';

const PROPER = '/usr/share/dict/propernames'; const WORDS = '/usr/share/dict/words';
// People whose names are the names of methods the app uses and cites; none is a patient or a user.
const METHODS = new Set(['Wilson', 'Bradley', 'Terry', 'Douglas', 'Peucker', 'Poisson', 'Cohen', 'Fleiss', 'Kaplan', 'Meier', 'Bland', 'Altman', 'Pearson', 'Spearman', 'Clopper', 'Hounsfield', 'Gauss', 'Bayes', 'Fisher', 'Otsu', 'Sobel', 'Huffman', 'Lanczos', 'Hamming', 'Macenko', 'Reinhard', 'Dice', 'Jaccard', 'Brier', 'Mann', 'Whitney', 'Wald', 'Shewhart', 'Bonferroni', 'Holm', 'Krippendorff', 'Likert', 'Markov', 'Newton', 'Laplace', 'Welch', 'Student', 'Agresti', 'Coull', 'Levenshtein', 'Bresenham', 'Mulberry']);

export const dictionaryAvailable = fs.existsSync(PROPER) && fs.existsSync(WORDS);
let names = null;
function load() {
  if (names || !dictionaryAvailable) return;
  const ordinary = new Set(fs.readFileSync(WORDS, 'utf8').split('\n').filter((w) => w && w === w.toLowerCase()));
  names = new Set(fs.readFileSync(PROPER, 'utf8').split('\n').filter((w) => w.length > 2 && !ordinary.has(w.toLowerCase()) && !(w.endsWith("s") && ordinary.has(w.toLowerCase().slice(0, -1))) && !METHODS.has(w)));
}

/** The person-like strings in this text: [] when there are none. */
export function personNames(text) {
  load();
  const found = new Set();
  for (const m of String(text).matchAll(/\b(?:Dr|Mr|Mrs|Ms|Prof)\.? [A-Z][a-z]{2,}\b/g)) found.add(m[0]);
  if (names) for (const m of String(text).matchAll(/\b[A-Z][a-z]{2,}\b/g)) if (names.has(m[0])) found.add(m[0]);
  return [...found];
}
