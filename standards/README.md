# Standards and interoperability

SMART on FHIR, UDAP, CDS Hooks, HL7 v2, C-CDA, bulk export, subscriptions, consent, terminology, XDS/XCA/MHD, device data (SDC), E2B safety reports, ECG export and the DICOM network gateway (`dimse-gateway/`). See `docs/STANDARDS.md`.

- `server/`: code that runs on the server.
- `web/`: pages and scripts the browser loads. The path under `web/` is the address: `web/ehr/app.js` is served at `/ehr/app.js`.
- `dimse-gateway/`: a small Python gateway for DICOM network transfer.
