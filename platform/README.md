# Platform

The core every app shares: the server entry point (`server/index.mjs`), the versioned store and time machine (`server/store.mjs`), the database adapters, the FHIR API, roles, sign-in, the audit log, file storage, the data importers and the shared browser code (`web/shared/`).

- `server/`: code that runs on the server.
- `web/`: pages and scripts the browser loads. The path under `web/` is the address: `web/ehr/app.js` is served at `/ehr/app.js`.
