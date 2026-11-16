# Simulated Consultation

OSCE-style consultations with a simulated patient: an agent or a clinician interviews, the patient reveals some facts only when asked, and a scribe drafts the note, orders and codes, scored against the case. Page: `/visit/`.

- `server/`: code that runs on the server.
- `web/`: pages and scripts the browser loads. The path under `web/` is the address: `web/ehr/app.js` is served at `/ehr/app.js`.
