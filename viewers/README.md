# Viewers

The shared image viewers: the DICOM codec (`dicom/`), the 2D and volume radiology viewers, the whole-slide viewer, image encoders, and the bundled open-source viewing libraries (`web/vendor/`, see its README for licences).

- `server/`: code that runs on the server.
- `web/`: pages and scripts the browser loads. The path under `web/` is the address: `web/ehr/app.js` is served at `/ehr/app.js`.
- `dicom/`: the DICOM reader and writer shared by the server and the browser.
