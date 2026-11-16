// DICOM objects the PACS viewer writes and reads, in our own code on top of ./dicom.js:
// Segmentation (PS3.3 A.51, binary), Comprehensive SR for measurements (in the pattern of
// TID 1500 "Measurement Report"), Grayscale Softcopy Presentation State (A.33.1), and the
// per-frame functional groups of enhanced multi-frame CT and MR (C.7.6.16).
import { write, parse, generateUid, SOP_CLASS, itemGet, itemStr, itemNums, DicomError } from './dicom.js';

const code = (value, scheme, meaning) => [{ CodeValue: value, CodingSchemeDesignator: scheme, CodeMeaning: meaning }];
const today = () => { const d = new Date(); return { date: `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`, time: `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}` }; };
const common = (ref, modality, description, sopClass) => {
  const t = today();
  return { SOPClassUID: sopClass, SOPInstanceUID: generateUid(), StudyInstanceUID: ref.studyUid, SeriesInstanceUID: generateUid(), Modality: modality, SeriesDescription: description, PatientName: ref.patientName || 'Anonymous', PatientID: ref.patientId || 'UNKNOWN', StudyDate: ref.studyDate || t.date, ContentDate: t.date, ContentTime: t.time, SeriesNumber: ref.seriesNumber ?? 900, InstanceNumber: 1, Manufacturer: 'hospital-desktop' };
};

// ---------- Segmentation ----------
/**
 * labels: Uint8Array of columns*rows*slices (0 = background, n = segment n).
 * segments: [{ number, label, algorithm: 'MANUAL'|'SEMIAUTOMATIC', algorithmName? }]
 * ref: { studyUid, seriesUid, sopClassUid, sopUids[slice], positions[slice] = [x,y,z], orientation[6], spacing [row, col], thickness, frameOfReferenceUid, patientName, patientId }
 * One binary frame per (segment, slice) that has a voxel; bits are packed across frames with no padding (PS3.5 8.1.1).
 */
export function writeSeg({ labels, columns, rows, slices, segments, ref }) {
  if (labels.length !== columns * rows * slices) throw new DicomError(`labels has ${labels.length} voxels; ${columns}x${rows}x${slices} needs ${columns * rows * slices}`);
  const plane = columns * rows;
  const frames = [];
  for (const seg of segments) for (let z = 0; z < slices; z += 1) { const base = z * plane; let any = false; for (let i = 0; i < plane; i += 1) if (labels[base + i] === seg.number) { any = true; break; } if (any) frames.push({ seg: seg.number, z }); }
  if (!frames.length) throw new DicomError('The segmentation is empty: nothing to save');
  const bits = new Uint8Array(Math.ceil((frames.length * plane) / 8));
  frames.forEach((fr, n) => { const base = fr.z * plane; const off = n * plane; for (let i = 0; i < plane; i += 1) if (labels[base + i] === fr.seg) { const b = off + i; bits[b >> 3] |= 1 << (b & 7); } });
  const ds = {
    ...common(ref, 'SEG', 'Segmentation', SOP_CLASS.SEG), ImageType: 'DERIVED\\PRIMARY', FrameOfReferenceUID: ref.frameOfReferenceUid, ContentLabel: 'SEGMENTATION', ContentDescription: 'Segmentation made in the viewer', ContentCreatorName: ref.creator || 'hospital-desktop',
    SegmentationType: 'BINARY', SamplesPerPixel: 1, PhotometricInterpretation: 'MONOCHROME2', Rows: rows, Columns: columns, BitsAllocated: 1, BitsStored: 1, HighBit: 0, PixelRepresentation: 0, NumberOfFrames: frames.length, DimensionOrganizationType: '3D',
    ReferencedSeriesSequence: [{ SeriesInstanceUID: ref.seriesUid, ReferencedInstanceSequence: ref.sopUids.map((uid) => ({ ReferencedSOPClassUID: ref.sopClassUid, ReferencedSOPInstanceUID: uid })) }],
    SegmentSequence: segments.map((sg) => ({ SegmentNumber: sg.number, SegmentLabel: String(sg.label || `Segment ${sg.number}`).slice(0, 64), SegmentAlgorithmType: sg.algorithm === 'MANUAL' ? 'MANUAL' : 'SEMIAUTOMATIC', ...(sg.algorithm === 'MANUAL' ? {} : { SegmentAlgorithmName: String(sg.algorithmName || 'viewer').slice(0, 64) }), SegmentedPropertyCategoryCodeSequence: code('91723000', 'SCT', 'Anatomical Structure'), SegmentedPropertyTypeCodeSequence: code('85756007', 'SCT', 'Tissue') })),
    SharedFunctionalGroupsSequence: [{ PlaneOrientationSequence: [{ ImageOrientationPatient: (ref.orientation || [1, 0, 0, 0, 1, 0]).join('\\') }], PixelMeasuresSequence: [{ PixelSpacing: (ref.spacing || [1, 1]).join('\\'), SliceThickness: String(ref.thickness ?? 1) }] }],
    PerFrameFunctionalGroupsSequence: frames.map((fr) => ({ SegmentIdentificationSequence: [{ ReferencedSegmentNumber: fr.seg }], PlanePositionSequence: [{ ImagePositionPatient: (ref.positions?.[fr.z] || [0, 0, fr.z]).join('\\') }], DerivationImageSequence: [{ SourceImageSequence: [{ ReferencedSOPClassUID: ref.sopClassUid, ReferencedSOPInstanceUID: ref.sopUids[fr.z] }] }] })),
    PixelData: bits,
  };
  return { bytes: write(ds), sopInstanceUid: ds.SOPInstanceUID, seriesInstanceUid: ds.SeriesInstanceUID, frames: frames.length };
}
/** Reads a binary SEG back into a label volume laid over the referenced slices (by SOP instance, else by position). */
export function readSeg(input, { sopUids = null, positions = null } = {}) {
  const file = input?.elements ? input : parse(input);
  if (file.str('SOPClassUID') !== SOP_CLASS.SEG) throw new DicomError('Not a Segmentation object');
  if (file.str('SegmentationType') !== 'BINARY') throw new DicomError('Only binary segmentations are read');
  const rows = file.num('Rows'); const columns = file.num('Columns'); const count = file.num('NumberOfFrames') ?? 1; const plane = rows * columns;
  const bits = file.get('PixelData');
  const segments = (file.get('SegmentSequence') || []).map((it) => ({ number: itemNums(it, 'SegmentNumber')[0], label: itemStr(it, 'SegmentLabel'), algorithm: itemStr(it, 'SegmentAlgorithmType'), algorithmName: itemStr(it, 'SegmentAlgorithmName') || null }));
  const per = file.get('PerFrameFunctionalGroupsSequence') || [];
  const refUids = sopUids || ((file.get('ReferencedSeriesSequence') || [])[0] ? (itemGet(file.get('ReferencedSeriesSequence')[0], 'ReferencedInstanceSequence') || []).map((it) => itemStr(it, 'ReferencedSOPInstanceUID')) : []);
  const frames = per.map((it) => {
    const seg = itemNums((itemGet(it, 'SegmentIdentificationSequence') || [])[0], 'ReferencedSegmentNumber')[0];
    const position = itemNums((itemGet(it, 'PlanePositionSequence') || [])[0], 'ImagePositionPatient');
    const src = (itemGet((itemGet(it, 'DerivationImageSequence') || [])[0], 'SourceImageSequence') || [])[0];
    const sop = src ? itemStr(src, 'ReferencedSOPInstanceUID') : null;
    let z = sop ? refUids.indexOf(sop) : -1;
    if (z < 0 && positions && position.length === 3) { let best = Infinity; positions.forEach((p, i) => { const d = Math.hypot(p[0] - position[0], p[1] - position[1], p[2] - position[2]); if (d < best) { best = d; z = i; } }); }
    return { seg, z, position, sop };
  });
  const slices = Math.max(refUids.length, positions?.length || 0, ...frames.map((f) => f.z + 1));
  const labels = new Uint8Array(plane * slices);
  frames.forEach((fr, n) => { if (fr.z < 0 || n >= count) return; const off = n * plane; const base = fr.z * plane; for (let i = 0; i < plane; i += 1) { const b = off + i; if (bits[b >> 3] & (1 << (b & 7))) labels[base + i] = fr.seg; } });
  return { labels, columns, rows, slices, segments, frames, referencedSeriesUid: (file.get('ReferencedSeriesSequence') || [])[0] ? itemStr(file.get('ReferencedSeriesSequence')[0], 'SeriesInstanceUID') : null };
}

// ---------- Structured report for measurements ----------
const CONCEPT = {
  length: ['410668003', 'SCT', 'Length', 'mm', 'millimeter'], angle: ['1483009', 'SCT', 'Angle', 'deg', 'degree'], cobb: ['285285000', 'SCT', 'Cobb angle', 'deg', 'degree'],
  roi: ['42798000', 'SCT', 'Area', 'mm2', 'square millimeter'], ellipse: ['42798000', 'SCT', 'Area', 'mm2', 'square millimeter'], freehand: ['42798000', 'SCT', 'Area', 'mm2', 'square millimeter'],
  mean: ['373098007', 'SCT', 'Mean', '[hnsf\'U]', 'Hounsfield unit'], sd: ['386136009', 'SCT', 'Standard Deviation', '[hnsf\'U]', 'Hounsfield unit'], probe: ['112031', 'DCM', 'Attenuation Coefficient', '[hnsf\'U]', 'Hounsfield unit'],
  long: ['103339001', 'SCT', 'Long Axis', 'mm', 'millimeter'], short: ['103340004', 'SCT', 'Short Axis', 'mm', 'millimeter'],
};
const GRAPHIC = { length: 'POLYLINE', angle: 'POLYLINE', cobb: 'POLYLINE', roi: 'POLYLINE', freehand: 'POLYLINE', bidirectional: 'POLYLINE', arrow: 'POLYLINE', ellipse: 'ELLIPSE', probe: 'POINT' };
const num = (key, value) => ({ RelationshipType: 'CONTAINS', ValueType: 'NUM', ConceptNameCodeSequence: code(...CONCEPT[key].slice(0, 3)), MeasuredValueSequence: [{ NumericValue: String(Math.round(value * 1000) / 1000), MeasurementUnitsCodeSequence: code(CONCEPT[key][3], 'UCUM', CONCEPT[key][4]) }] });
/**
 * measurements: [{ kind, label?, points: [[x,y],...] in image pixels, sopUid, frame?, value, mean?, sd?, longMm?, shortMm?, text? }]
 * Each becomes a "Measurement Group" container with its numbers, the graphic (SCOORD) and the image it was drawn on.
 */
export function writeSr({ measurements, ref, title = 'Imaging Measurement Report' }) {
  const groups = measurements.map((m, i) => {
    const nums = [];
    if (m.kind === 'bidirectional') { if (m.longMm != null) nums.push(num('long', m.longMm)); if (m.shortMm != null) nums.push(num('short', m.shortMm)); }
    else if (m.kind !== 'arrow' && m.value != null && CONCEPT[m.kind]) nums.push(num(m.kind, m.value));
    if (m.mean != null) nums.push(num('mean', m.mean));
    if (m.sd != null) nums.push(num('sd', m.sd));
    const flat = (m.points || []).flat().map(Number);
    return { RelationshipType: 'CONTAINS', ValueType: 'CONTAINER', ContinuityOfContent: 'SEPARATE', ConceptNameCodeSequence: code('125007', 'DCM', 'Measurement Group'), ContentSequence: [
      { RelationshipType: 'HAS OBS CONTEXT', ValueType: 'TEXT', ConceptNameCodeSequence: code('112039', 'DCM', 'Tracking Identifier'), TextValue: String(m.label || `${m.kind} ${i + 1}`).slice(0, 200) },
      { RelationshipType: 'HAS CONCEPT MOD', ValueType: 'TEXT', ConceptNameCodeSequence: code('121071', 'DCM', 'Finding'), TextValue: String(m.kind) },
      ...(m.text ? [{ RelationshipType: 'CONTAINS', ValueType: 'TEXT', ConceptNameCodeSequence: code('121106', 'DCM', 'Comment'), TextValue: String(m.text).slice(0, 1000) }] : []),
      ...nums,
      ...(flat.length ? [{ RelationshipType: 'CONTAINS', ValueType: 'SCOORD', ConceptNameCodeSequence: code('111030', 'DCM', 'Image Region'), GraphicType: GRAPHIC[m.kind] || 'POLYLINE', GraphicData: flat, ContentSequence: [{ RelationshipType: 'SELECTED FROM', ValueType: 'IMAGE', ReferencedSOPSequence: [{ ReferencedSOPClassUID: ref.sopClassUid, ReferencedSOPInstanceUID: m.sopUid, ...(m.frame != null ? { ReferencedFrameNumber: String(m.frame + 1) } : {}) }] }] }] : []),
    ] };
  });
  const ds = { ...common(ref, 'SR', 'Measurements', SOP_CLASS.SR_COMPREHENSIVE), ValueType: 'CONTAINER', ContinuityOfContent: 'SEPARATE', CompletionFlag: 'PARTIAL', VerificationFlag: 'UNVERIFIED', ConceptNameCodeSequence: code('126000', 'DCM', title), ContentSequence: groups };
  return { bytes: write(ds), sopInstanceUid: ds.SOPInstanceUID, seriesInstanceUid: ds.SeriesInstanceUID };
}
export function readSr(input) {
  const file = input?.elements ? input : parse(input);
  if (file.str('SOPClassUID') !== SOP_CLASS.SR_COMPREHENSIVE) throw new DicomError('Not a Comprehensive SR object');
  const conceptOf = (it) => { const c = (itemGet(it, 'ConceptNameCodeSequence') || [])[0]; return c ? { code: itemStr(c, 'CodeValue'), meaning: itemStr(c, 'CodeMeaning') } : {}; };
  const byMeaning = Object.fromEntries(Object.entries(CONCEPT).map(([k, v]) => [v[2], k]));
  const measurements = (file.get('ContentSequence') || []).filter((g) => conceptOf(g).code === '125007').map((g) => {
    const m = { points: [] };
    for (const it of itemGet(g, 'ContentSequence') || []) {
      const type = itemStr(it, 'ValueType'); const c = conceptOf(it);
      if (type === 'TEXT' && c.code === '112039') m.label = itemGet(it, 'TextValue')?.trim();
      else if (type === 'TEXT' && c.code === '121071') m.kind = itemGet(it, 'TextValue')?.trim();
      else if (type === 'TEXT' && c.code === '121106') m.text = itemGet(it, 'TextValue')?.trim();
      else if (type === 'NUM') { const mv = (itemGet(it, 'MeasuredValueSequence') || [])[0]; const v = itemNums(mv, 'NumericValue')[0]; const unit = itemStr((itemGet(mv, 'MeasurementUnitsCodeSequence') || [])[0], 'CodeValue'); const key = byMeaning[c.meaning]; (m.numbers ||= []).push({ concept: c.meaning, value: v, unit }); if (key === 'mean') m.mean = v; else if (key === 'sd') m.sd = v; else if (key === 'long') m.longMm = v; else if (key === 'short') m.shortMm = v; else m.value = v; }
      else if (type === 'SCOORD') { const flat = Array.from(itemGet(it, 'GraphicData') || []); for (let i = 0; i + 1 < flat.length; i += 2) m.points.push([flat[i], flat[i + 1]]); m.graphicType = itemStr(it, 'GraphicType'); const img = (itemGet(it, 'ContentSequence') || [])[0]; const sop = (itemGet(img, 'ReferencedSOPSequence') || [])[0]; if (sop) { m.sopUid = itemStr(sop, 'ReferencedSOPInstanceUID'); const fr = itemNums(sop, 'ReferencedFrameNumber')[0]; if (fr != null) m.frame = fr - 1; } }
    }
    return m;
  });
  return { title: (file.get('ConceptNameCodeSequence') || [])[0] ? itemStr(file.get('ConceptNameCodeSequence')[0], 'CodeMeaning') : '', measurements, studyUid: file.str('StudyInstanceUID') };
}

// ---------- Grayscale softcopy presentation state ----------
/** state: { center, width, invert, area: { left, top, right, bottom } in image pixels (1-based corners are written), zoom, label } */
export function writePresentationState({ state, ref }) {
  const t = today();
  const refs = [{ SeriesInstanceUID: ref.seriesUid, ReferencedImageSequence: ref.sopUids.map((uid) => ({ ReferencedSOPClassUID: ref.sopClassUid, ReferencedSOPInstanceUID: uid })) }];
  const ds = { ...common(ref, 'PR', 'Presentation state', SOP_CLASS.GSPS), ContentLabel: String(state.label || 'VIEW').toUpperCase().replace(/[^A-Z0-9_ ]/g, '').slice(0, 16) || 'VIEW', ContentDescription: 'View saved in the viewer', ContentCreatorName: ref.creator || 'hospital-desktop', PresentationCreationDate: t.date, PresentationCreationTime: t.time,
    ReferencedSeriesSequence: refs, PresentationLUTShape: state.invert ? 'INVERSE' : 'IDENTITY',
    SoftcopyVOILUTSequence: [{ WindowCenter: String(state.center), WindowWidth: String(Math.max(1, state.width)) }],
    DisplayedAreaSelectionSequence: [{ DisplayedAreaTopLeftHandCorner: [Math.round(state.area.left) + 1, Math.round(state.area.top) + 1], DisplayedAreaBottomRightHandCorner: [Math.round(state.area.right), Math.round(state.area.bottom)], PresentationSizeMode: state.zoom ? 'MAGNIFY' : 'SCALE TO FIT', ...(state.zoom ? { PresentationPixelMagnificationRatio: state.zoom } : {}) }] };
  return { bytes: write(ds), sopInstanceUid: ds.SOPInstanceUID, seriesInstanceUid: ds.SeriesInstanceUID };
}
export function readPresentationState(input) {
  const file = input?.elements ? input : parse(input);
  if (file.str('SOPClassUID') !== SOP_CLASS.GSPS) throw new DicomError('Not a Grayscale Softcopy Presentation State');
  const voi = (file.get('SoftcopyVOILUTSequence') || [])[0]; const area = (file.get('DisplayedAreaSelectionSequence') || [])[0];
  const tl = itemNums(area, 'DisplayedAreaTopLeftHandCorner'); const br = itemNums(area, 'DisplayedAreaBottomRightHandCorner');
  const series = (file.get('ReferencedSeriesSequence') || [])[0];
  return { label: file.str('ContentLabel'), center: itemNums(voi, 'WindowCenter')[0], width: itemNums(voi, 'WindowWidth')[0], invert: file.str('PresentationLUTShape') === 'INVERSE', area: tl.length === 2 && br.length === 2 ? { left: tl[0] - 1, top: tl[1] - 1, right: br[0], bottom: br[1] } : null, zoom: itemStr(area, 'PresentationSizeMode') === 'MAGNIFY' ? itemNums(area, 'PresentationPixelMagnificationRatio')[0] ?? null : null,
    seriesUid: series ? itemStr(series, 'SeriesInstanceUID') : null, sopUids: series ? (itemGet(series, 'ReferencedImageSequence') || []).map((it) => itemStr(it, 'ReferencedSOPInstanceUID')) : [] };
}

// ---------- Enhanced multi-frame CT and MR ----------
/** Per-frame geometry and display values from the shared and per-frame functional groups; null where a group is absent. */
export function frameGroups(input) {
  const file = input?.elements ? input : parse(input);
  const frames = file.num('NumberOfFrames') ?? 1;
  const shared = (file.get('SharedFunctionalGroupsSequence') || [])[0]; const per = file.get('PerFrameFunctionalGroupsSequence') || [];
  const pick = (it, seq) => (itemGet(it, seq) || [])[0];
  const out = [];
  for (let i = 0; i < frames; i += 1) {
    const g = (seq) => pick(per[i], seq) || pick(shared, seq);
    const measures = g('PixelMeasuresSequence'); const voi = g('FrameVOILUTSequence'); const xf = g('PixelValueTransformationSequence');
    const position = itemNums(g('PlanePositionSequence'), 'ImagePositionPatient'); const orientation = itemNums(g('PlaneOrientationSequence'), 'ImageOrientationPatient'); const spacing = itemNums(measures, 'PixelSpacing');
    out.push({ frame: i, position: position.length === 3 ? position : null, orientation: orientation.length === 6 ? orientation : null, spacing: spacing.length === 2 ? spacing : null, thickness: itemNums(measures, 'SliceThickness')[0] ?? null,
      window: voi && itemNums(voi, 'WindowWidth').length ? { center: itemNums(voi, 'WindowCenter')[0], width: itemNums(voi, 'WindowWidth')[0] } : null, slope: itemNums(xf, 'RescaleSlope')[0] ?? null, intercept: itemNums(xf, 'RescaleIntercept')[0] ?? null });
  }
  return { enhanced: [SOP_CLASS.ENHANCED_CT, SOP_CLASS.ENHANCED_MR].includes(file.str('SOPClassUID')), frames: out };
}
