// Test fixture: DICOM phantoms drawn from simple shapes, built inside the test that needs them.
//   chest-current  one DX chest image with a small round opacity
//   chest-prior    the same chest a year earlier, without the opacity
//   ct-chest       a 40-slice CT volume (for stack scroll and the 3D toggle)
// The patient is labelled by MRN only.
import { write, generateUid, SOP_CLASS, TS } from '../../viewers/dicom/dicom.js';

const pad = (n, w = 2) => String(n).padStart(w, '0');
const dicomDate = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const dicomTime = (d) => `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
function noise(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

function chestImage(size, withNodule) {
  const px = new Uint16Array(size * size);
  const rand = noise(7);
  const ell = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      let value = 300;
      if (ell(u, v, 0.5, 0.52, 0.44, 0.47) < 1) value = 2300;
      const lung = Math.min(ell(u, v, 0.31, 0.5, 0.15, 0.3), ell(u, v, 0.69, 0.5, 0.15, 0.3));
      if (lung < 1) value = 900 + 500 * lung;
      if (ell(u, v, 0.5, 0.62, 0.11, 0.2) < 1) value = 2700;
      if (Math.abs(u - 0.5) < 0.025 && v > 0.08 && v < 0.95) value = 3000;
      const rib = Math.abs(((v * 11 + Math.abs(u - 0.5) * 2.2) % 1) - 0.5);
      if (lung < 1.25 && rib < 0.09) value += 380;
      if (withNodule && ell(u, v, 0.705, 0.37, 0.022, 0.022) < 1) value += 650;
      px[y * size + x] = Math.max(0, Math.min(4095, Math.round(value + (rand() - 0.5) * 90)));
    }
  }
  return px;
}

function ctSlice(size, z, slices) {
  const px = new Int16Array(size * size);
  const rand = noise(100 + z);
  const w = (z + 0.5) / slices;
  const taper = 0.75 + 0.25 * Math.sin(Math.PI * w);
  const ell = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      let hu = -1000;
      if (ell(u, v, 0.5, 0.52, 0.42 * taper, 0.3 * taper) < 1) hu = 40;
      if (Math.min(ell(u, v, 0.33, 0.5, 0.13 * taper, 0.19 * taper), ell(u, v, 0.67, 0.5, 0.13 * taper, 0.19 * taper)) < 1) hu = -820;
      if (ell(u, v, 0.5, 0.71, 0.045, 0.045) < 1) hu = 700;
      if (ell(u, v, 0.5, 0.45, 0.07, 0.07) < 1 && w > 0.3 && w < 0.8) hu = 55;
      if (ell(u, v, 0.66, 0.44, 0.03, 0.03) + ((w - 0.55) / 0.07) ** 2 < 1) hu = 60;
      px[y * size + x] = Math.round(hu + (rand() - 0.5) * 24);
    }
  }
  return px;
}

/** Returns [{ folder, name, bytes }] for one synthetic patient. */
export function buildPhantom({ mrn = 'N100001', name = mrn, birthDate = '19600101', sex = 'O', now = new Date(), transferSyntax = TS.EXPLICIT_LE } = {}) {
  const out = [];
  const patient = { PatientName: name, PatientID: mrn, PatientBirthDate: birthDate, PatientSex: sex };
  const frameOfReference = generateUid();
  const chest = (folder, when, withNodule, accession) => {
    const size = 512;
    out.push({ folder, name: 'image-0001.dcm', bytes: write({
      SOPClassUID: SOP_CLASS.DX, SOPInstanceUID: generateUid(), ImageType: ['ORIGINAL', 'PRIMARY'], StudyDate: dicomDate(when), SeriesDate: dicomDate(when), StudyTime: dicomTime(when),
      AccessionNumber: accession, Modality: 'DX', Manufacturer: 'HOSPITAL DESKTOP PHANTOM', StudyDescription: 'XR Chest 2 views', SeriesDescription: 'PA', ...patient,
      BodyPartExamined: 'CHEST', StudyInstanceUID: generateUid(), SeriesInstanceUID: generateUid(), StudyID: '1', SeriesNumber: '1', InstanceNumber: '1',
      ImagerPixelSpacing: ['0.7', '0.7'], PixelSpacing: ['0.7', '0.7'], SamplesPerPixel: 1, PhotometricInterpretation: 'MONOCHROME2', Rows: size, Columns: size,
      BitsAllocated: 16, BitsStored: 12, HighBit: 11, PixelRepresentation: 0, WindowCenter: '1800', WindowWidth: '3600', RescaleIntercept: '0', RescaleSlope: '1',
      ImageComments: 'Synthetic phantom. Not a patient image.', PixelData: chestImage(size, withNodule),
    }, { transferSyntax }) });
  };
  const yearAgo = new Date(now.getTime() - 365 * 86400000);
  chest('chest-prior', yearAgo, false, `PH${dicomDate(yearAgo).slice(2)}01`);
  chest('chest-current', now, true, `PH${dicomDate(now).slice(2)}02`);

  const slices = 40;
  const size = 128;
  const studyUid = generateUid();
  const seriesUid = generateUid();
  for (let z = 0; z < slices; z += 1) {
    out.push({ folder: 'ct-chest', name: `slice-${pad(z + 1, 4)}.dcm`, bytes: write({
      SOPClassUID: SOP_CLASS.CT, SOPInstanceUID: generateUid(), ImageType: ['ORIGINAL', 'PRIMARY', 'AXIAL'], StudyDate: dicomDate(now), SeriesDate: dicomDate(now), StudyTime: dicomTime(now),
      AccessionNumber: `PH${dicomDate(now).slice(2)}03`, Modality: 'CT', Manufacturer: 'HOSPITAL DESKTOP PHANTOM', StudyDescription: 'CT Chest', SeriesDescription: 'Axial 4 mm', ...patient,
      BodyPartExamined: 'CHEST', SliceThickness: '4', PatientPosition: 'HFS', StudyInstanceUID: studyUid, SeriesInstanceUID: seriesUid, StudyID: '2', SeriesNumber: '2', InstanceNumber: String(z + 1),
      ImagePositionPatient: ['-160', '-160', String(z * 4)], ImageOrientationPatient: ['1', '0', '0', '0', '1', '0'], FrameOfReferenceUID: frameOfReference, SliceLocation: String(z * 4),
      SamplesPerPixel: 1, PhotometricInterpretation: 'MONOCHROME2', Rows: size, Columns: size, PixelSpacing: ['2.5', '2.5'], BitsAllocated: 16, BitsStored: 16, HighBit: 15, PixelRepresentation: 1,
      WindowCenter: '40', WindowWidth: '400', RescaleIntercept: '0', RescaleSlope: '1', RescaleType: 'HU', ImageComments: 'Synthetic phantom. Not a patient image.', PixelData: ctSlice(size, z, slices),
    }, { transferSyntax }) });
  }
  return out;
}

