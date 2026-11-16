// Prints a random 32-byte secret, for SESSION_SECRET. Nothing is saved.
import { randomBytes } from 'node:crypto';

console.log(randomBytes(32).toString('base64url'));
