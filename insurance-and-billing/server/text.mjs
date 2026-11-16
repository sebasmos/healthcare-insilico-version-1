/** The text of a note stored as base64 in a DocumentReference attachment. */
export const decodeText = (b64) => { try { return b64 ? Buffer.from(String(b64), 'base64').toString('utf8') : ''; } catch { return ''; } };
