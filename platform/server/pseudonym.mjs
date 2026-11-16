// A pseudonymous id for a person (R-01 ... R-97) derived from the typed name
// or user id, so traces and exports never carry the name itself. Letters and
// digits only, so "Reader Four" and "reader-four" are the same person.
import { createHash } from 'node:crypto';

export function pseudonym(name) {
  const text = String(name || 'anonymous').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'anonymous';
  const n = parseInt(createHash('sha256').update(text).digest('hex').slice(0, 6), 16) % 97;
  return `R-${String(n + 1).padStart(2, '0')}`;
}
