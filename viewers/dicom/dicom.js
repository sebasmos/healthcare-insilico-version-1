// DICOM Part 10 reader and writer, pixel decoding and NIfTI-1 reading.
// Runs unchanged in Node and in the browser (viewers/web/shared/dicom.js is a synced
// copy). Scope: the three uncompressed transfer syntaxes, 8 and 16 bit
// pixels, single and multi-frame, MONOCHROME1/2 and RGB, decoded here; RLE
// Lossless decoded here too; the JPEG family (baseline, lossless, JPEG-LS,
// JPEG 2000) is read and written as encapsulated fragments without decoding
// and is decoded in the browser by the vendored Cornerstone3D codecs.
export const TS = {
  IMPLICIT_LE: '1.2.840.10008.1.2',
  EXPLICIT_LE: '1.2.840.10008.1.2.1',
  EXPLICIT_BE: '1.2.840.10008.1.2.2',
};
export const COMPRESSED_TS = {
  JPEG_BASELINE: '1.2.840.10008.1.2.4.50', JPEG_EXTENDED: '1.2.840.10008.1.2.4.51', JPEG_LOSSLESS: '1.2.840.10008.1.2.4.57', JPEG_LOSSLESS_SV1: '1.2.840.10008.1.2.4.70',
  JPEG_LS_LOSSLESS: '1.2.840.10008.1.2.4.80', JPEG_LS: '1.2.840.10008.1.2.4.81', J2K_LOSSLESS: '1.2.840.10008.1.2.4.90', J2K: '1.2.840.10008.1.2.4.91', RLE: '1.2.840.10008.1.2.5',
};
export const COMPRESSED_LABEL = { [COMPRESSED_TS.JPEG_BASELINE]: 'JPEG baseline', [COMPRESSED_TS.JPEG_EXTENDED]: 'JPEG extended', [COMPRESSED_TS.JPEG_LOSSLESS]: 'JPEG lossless', [COMPRESSED_TS.JPEG_LOSSLESS_SV1]: 'JPEG lossless', [COMPRESSED_TS.JPEG_LS_LOSSLESS]: 'JPEG-LS lossless', [COMPRESSED_TS.JPEG_LS]: 'JPEG-LS', [COMPRESSED_TS.J2K_LOSSLESS]: 'JPEG 2000 lossless', [COMPRESSED_TS.J2K]: 'JPEG 2000', [COMPRESSED_TS.RLE]: 'RLE lossless' };
export const SUPPORTED_TRANSFER_SYNTAXES = Object.values(TS);
export const COMPRESSED_TRANSFER_SYNTAXES = Object.values(COMPRESSED_TS);
export const isCompressedSyntax = (uid) => COMPRESSED_TRANSFER_SYNTAXES.includes(uid);
export const SOP_CLASS = {
  SEG: '1.2.840.10008.5.1.4.1.1.66.4', SR_COMPREHENSIVE: '1.2.840.10008.5.1.4.1.1.88.33', GSPS: '1.2.840.10008.5.1.4.1.1.11.1', ENHANCED_CT: '1.2.840.10008.5.1.4.1.1.2.1', ENHANCED_MR: '1.2.840.10008.5.1.4.1.1.4.1',
  CT: '1.2.840.10008.5.1.4.1.1.2', MR: '1.2.840.10008.5.1.4.1.1.4', DX: '1.2.840.10008.5.1.4.1.1.1.1',
  CR: '1.2.840.10008.5.1.4.1.1.1', US: '1.2.840.10008.5.1.4.1.1.6.1', SC: '1.2.840.10008.5.1.4.1.1.7',
};
const IMPLEMENTATION_UID = '2.25.264419842763011540326894712230897461';

const D = (vr, keyword) => [vr, keyword];
export const DICT = {
  '0008002A': D('DT', 'AcquisitionDateTime'), '003A0004': D('CS', 'WaveformOriginality'), '003A0005': D('US', 'NumberOfWaveformChannels'), '003A0010': D('UL', 'NumberOfWaveformSamples'),
  '003A001A': D('DS', 'SamplingFrequency'), '003A0020': D('SH', 'MultiplexGroupLabel'), '003A0200': D('SQ', 'ChannelDefinitionSequence'), '003A0202': D('IS', 'WaveformChannelNumber'),
  '003A0208': D('SQ', 'ChannelSourceSequence'), '003A0210': D('DS', 'ChannelSensitivity'), '003A0211': D('SQ', 'ChannelSensitivityUnitsSequence'), '003A0212': D('DS', 'ChannelSensitivityCorrectionFactor'),
  '003A0213': D('DS', 'ChannelBaseline'), '003A021A': D('US', 'WaveformBitsStored'), '54000100': D('SQ', 'WaveformSequence'), '54001004': D('US', 'WaveformBitsAllocated'),
  '54001006': D('CS', 'WaveformSampleInterpretation'), '54001010': D('OW', 'WaveformData'),
  '00020001': D('OB', 'FileMetaInformationVersion'), '00020002': D('UI', 'MediaStorageSOPClassUID'),
  '00020003': D('UI', 'MediaStorageSOPInstanceUID'), '00020010': D('UI', 'TransferSyntaxUID'),
  '00020012': D('UI', 'ImplementationClassUID'), '00020013': D('SH', 'ImplementationVersionName'),
  '00080005': D('CS', 'SpecificCharacterSet'), '00080008': D('CS', 'ImageType'), '00080016': D('UI', 'SOPClassUID'),
  '00080018': D('UI', 'SOPInstanceUID'), '00080020': D('DA', 'StudyDate'), '00080021': D('DA', 'SeriesDate'),
  '00080022': D('DA', 'AcquisitionDate'), '00080023': D('DA', 'ContentDate'), '00080030': D('TM', 'StudyTime'),
  '00080031': D('TM', 'SeriesTime'), '00080033': D('TM', 'ContentTime'), '00080050': D('SH', 'AccessionNumber'),
  '00080060': D('CS', 'Modality'), '00080070': D('LO', 'Manufacturer'), '00080080': D('LO', 'InstitutionName'),
  '00080090': D('PN', 'ReferringPhysicianName'), '00081030': D('LO', 'StudyDescription'), '0008103E': D('LO', 'SeriesDescription'),
  '00100010': D('PN', 'PatientName'), '00100020': D('LO', 'PatientID'), '00100030': D('DA', 'PatientBirthDate'),
  '00100040': D('CS', 'PatientSex'), '00180015': D('CS', 'BodyPartExamined'), '00180050': D('DS', 'SliceThickness'),
  '00180088': D('DS', 'SpacingBetweenSlices'), '00181164': D('DS', 'ImagerPixelSpacing'), '00185100': D('CS', 'PatientPosition'),
  '0020000D': D('UI', 'StudyInstanceUID'), '0020000E': D('UI', 'SeriesInstanceUID'), '00200010': D('SH', 'StudyID'),
  '00200011': D('IS', 'SeriesNumber'), '00200013': D('IS', 'InstanceNumber'), '00200032': D('DS', 'ImagePositionPatient'),
  '00200037': D('DS', 'ImageOrientationPatient'), '00200052': D('UI', 'FrameOfReferenceUID'), '00201041': D('DS', 'SliceLocation'),
  '00204000': D('LT', 'ImageComments'), '00280002': D('US', 'SamplesPerPixel'), '00280004': D('CS', 'PhotometricInterpretation'),
  '00280006': D('US', 'PlanarConfiguration'), '00280008': D('IS', 'NumberOfFrames'), '00280010': D('US', 'Rows'),
  '00280011': D('US', 'Columns'), '00280030': D('DS', 'PixelSpacing'), '00280100': D('US', 'BitsAllocated'),
  '00209311': D('CS', 'DimensionOrganizationType'), '00289110': D('SQ', 'PixelMeasuresSequence'), '00480006': D('UL', 'TotalPixelMatrixColumns'), '00480007': D('UL', 'TotalPixelMatrixRows'), '00480112': D('DS', 'ObjectiveLensPower'), '52009229': D('SQ', 'SharedFunctionalGroupsSequence'),
  '00280101': D('US', 'BitsStored'), '00280102': D('US', 'HighBit'), '00280103': D('US', 'PixelRepresentation'),
  '00281050': D('DS', 'WindowCenter'), '00281051': D('DS', 'WindowWidth'), '00281052': D('DS', 'RescaleIntercept'),
  // Segmentation (PS3.3 C.8.20), structured reports (C.17) and presentation states (C.11) used by the PACS viewer.
  '00081115': D('SQ', 'ReferencedSeriesSequence'), '0008114A': D('SQ', 'ReferencedInstanceSequence'), '00081150': D('UI', 'ReferencedSOPClassUID'), '00081155': D('UI', 'ReferencedSOPInstanceUID'), '00081199': D('SQ', 'ReferencedSOPSequence'),
  '00082112': D('SQ', 'SourceImageSequence'), '00089124': D('SQ', 'DerivationImageSequence'), '00080100': D('SH', 'CodeValue'), '00080102': D('SH', 'CodingSchemeDesignator'), '00080104': D('LO', 'CodeMeaning'),
  '00081140': D('SQ', 'ReferencedImageSequence'), '00081160': D('IS', 'ReferencedFrameNumber'),
  '00620001': D('CS', 'SegmentationType'), '00620002': D('SQ', 'SegmentSequence'), '00620003': D('SQ', 'SegmentedPropertyCategoryCodeSequence'), '00620004': D('US', 'SegmentNumber'), '00620005': D('LO', 'SegmentLabel'),
  '00620008': D('CS', 'SegmentAlgorithmType'), '00620009': D('LO', 'SegmentAlgorithmName'), '0062000A': D('SQ', 'SegmentIdentificationSequence'), '0062000B': D('US', 'ReferencedSegmentNumber'), '0062000F': D('SQ', 'SegmentedPropertyTypeCodeSequence'),
  '52009230': D('SQ', 'PerFrameFunctionalGroupsSequence'), '00209113': D('SQ', 'PlanePositionSequence'), '00209116': D('SQ', 'PlaneOrientationSequence'), '00289132': D('SQ', 'FrameVOILUTSequence'), '00289145': D('SQ', 'PixelValueTransformationSequence'),
  '00700080': D('CS', 'ContentLabel'), '00700081': D('LO', 'ContentDescription'), '00700084': D('PN', 'ContentCreatorName'),
  '0040A040': D('CS', 'ValueType'), '0040A043': D('SQ', 'ConceptNameCodeSequence'), '0040A050': D('CS', 'ContinuityOfContent'), '0040A010': D('CS', 'RelationshipType'), '0040A730': D('SQ', 'ContentSequence'),
  '0040A300': D('SQ', 'MeasuredValueSequence'), '0040A30A': D('DS', 'NumericValue'), '004008EA': D('SQ', 'MeasurementUnitsCodeSequence'), '0040A160': D('UT', 'TextValue'), '0040A491': D('CS', 'CompletionFlag'), '0040A493': D('CS', 'VerificationFlag'),
  '00700022': D('FL', 'GraphicData'), '00700023': D('CS', 'GraphicType'),
  '00283110': D('SQ', 'SoftcopyVOILUTSequence'), '0070005A': D('SQ', 'DisplayedAreaSelectionSequence'), '00700052': D('SL', 'DisplayedAreaTopLeftHandCorner'), '00700053': D('SL', 'DisplayedAreaBottomRightHandCorner'), '00700100': D('CS', 'PresentationSizeMode'),
  '00700103': D('FL', 'PresentationPixelMagnificationRatio'), '20500020': D('CS', 'PresentationLUTShape'), '00700082': D('DA', 'PresentationCreationDate'), '00700083': D('TM', 'PresentationCreationTime'),
  '00281053': D('DS', 'RescaleSlope'), '00281054': D('LO', 'RescaleType'), '7FE00010': D('OW', 'PixelData'),
};
const TAG_OF = Object.fromEntries(Object.entries(DICT).map(([tag, [, keyword]]) => [keyword, tag]));
const LONG_VR = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'SQ', 'UT', 'UN', 'UC', 'UR']);
const NUMERIC = { US: [2, 'getUint16', 'setUint16'], SS: [2, 'getInt16', 'setInt16'], UL: [4, 'getUint32', 'setUint32'], SL: [4, 'getInt32', 'setInt32'], FL: [4, 'getFloat32', 'setFloat32'], FD: [8, 'getFloat64', 'setFloat64'] };
const BINARY = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'UN']);
const UNDEFINED_LENGTH = 0xffffffff;

export class DicomError extends Error {}

const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');
const latin1 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]); return s; };

/** A parsed file: meta (group 0002) and dataset elements, each Map<tag, { vr, value }>. */
export class DicomFile {
  constructor(meta, elements, transferSyntax) { this.meta = meta; this.elements = elements; this.transferSyntax = transferSyntax; }
  get(keyword) { const tag = TAG_OF[keyword] ?? keyword; return (this.elements.get(tag) ?? this.meta.get(tag))?.value; }
  /** All values of a string element (split on backslash), or of a numeric element. */
  values(keyword) { const v = this.get(keyword); if (v == null) return []; return typeof v === 'string' ? (v === '' ? [] : v.split('\\').map((s) => s.trim())) : Array.from(v); }
  str(keyword) { const v = this.values(keyword)[0]; return v == null ? '' : String(v); }
  num(keyword) { const v = this.values(keyword)[0]; if (v == null || v === '') return null; const n = Number(v); return Number.isNaN(n) ? null : n; }
  nums(keyword) { return this.values(keyword).map(Number).filter((n) => !Number.isNaN(n)); }
  get littleEndian() { return this.transferSyntax !== TS.EXPLICIT_BE; }
}

/** Reads a parsed sequence item (a Map of tag to { vr, value }) by keyword. */
export const itemGet = (item, keyword) => item?.get(TAG_OF[keyword] ?? keyword)?.value;
export const itemStr = (item, keyword) => { const v = itemGet(item, keyword); return v == null ? '' : String(typeof v === 'string' ? v.split('\\')[0] : v[0] ?? '').trim(); };
export const itemNums = (item, keyword) => { const v = itemGet(item, keyword); if (v == null) return []; return (typeof v === 'string' ? v.split('\\') : Array.from(v)).map(Number).filter((n) => !Number.isNaN(n)); };

function reader(bytes, little, explicit) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const c = { bytes, view, little, explicit };

  function decode(vr, pos, length) {
    if (NUMERIC[vr]) {
      const [size, getter] = NUMERIC[vr];
      const out = [];
      for (let i = 0; i + size <= length; i += size) out.push(view[getter](pos + i, little));
      return out;
    }
    if (vr === 'AT') { const out = []; for (let i = 0; i + 4 <= length; i += 4) out.push(hex4(view.getUint16(pos + i, little)) + hex4(view.getUint16(pos + i + 2, little))); return out; }
    if (BINARY.has(vr)) return bytes.subarray(pos, pos + length);
    return latin1(bytes.subarray(pos, pos + length)).replace(/[\0 ]+$/, '');
  }

  function sequence(pos, length) {
    const end = length === UNDEFINED_LENGTH ? bytes.length : pos + length;
    const items = [];
    while (pos + 8 <= end) {
      const element = view.getUint16(pos + 2, little);
      const itemLength = view.getUint32(pos + 4, little);
      if (view.getUint16(pos, little) !== 0xfffe) throw new DicomError(`Malformed sequence at byte ${pos}`);
      pos += 8;
      if (element === 0xe0dd) break;
      const item = new Map();
      if (itemLength === UNDEFINED_LENGTH) {
        pos = dataset(pos, bytes.length, item);
        if (pos + 8 > bytes.length) throw new DicomError('Sequence item is not terminated');
        pos += 8;
      } else {
        dataset(pos, pos + itemLength, item);
        pos += itemLength;
      }
      items.push(item);
    }
    return { items, next: pos };
  }

  function element(pos) {
    const group = view.getUint16(pos, little);
    const tag = hex4(group) + hex4(view.getUint16(pos + 2, little));
    pos += 4;
    let vr;
    let length;
    if (explicit) {
      vr = String.fromCharCode(bytes[pos], bytes[pos + 1]);
      if (LONG_VR.has(vr)) { length = view.getUint32(pos + 4, little); pos += 8; } else { length = view.getUint16(pos + 2, little); pos += 4; }
    } else {
      length = view.getUint32(pos, little);
      pos += 4;
      vr = DICT[tag]?.[0] ?? (length === UNDEFINED_LENGTH ? 'SQ' : 'UN');
    }
    if (vr === 'SQ' || (vr === 'UN' && length === UNDEFINED_LENGTH)) {
      const { items, next } = sequence(pos, length);
      return { tag, vr: 'SQ', value: items, next };
    }
    if (length === UNDEFINED_LENGTH) {
      if (tag !== '7FE00010') throw new DicomError(`Undefined length on non-sequence element ${tag}`);
      // Encapsulated pixel data: a basic offset table item, then one item per fragment, then a sequence delimiter. Kept as fragments; not decoded here.
      const fragments = [];
      let offsets = [];
      let first = true;
      for (;;) {
        if (pos + 8 > bytes.length) throw new DicomError('Encapsulated pixel data is not terminated');
        if (view.getUint16(pos, little) !== 0xfffe) throw new DicomError(`Malformed encapsulated pixel data at byte ${pos}`);
        const item = view.getUint16(pos + 2, little);
        const itemLength = view.getUint32(pos + 4, little);
        pos += 8;
        if (item === 0xe0dd) break;
        if (item !== 0xe000) throw new DicomError(`Unexpected item ${item.toString(16)} in encapsulated pixel data`);
        if (pos + itemLength > bytes.length) throw new DicomError('Encapsulated fragment runs past the end of the file');
        const chunk = bytes.subarray(pos, pos + itemLength);
        if (first) { offsets = Array.from({ length: Math.floor(itemLength / 4) }, (_, k) => view.getUint32(pos + k * 4, little)); first = false; } else fragments.push(chunk);
        pos += itemLength;
      }
      return { tag, vr: 'OB', value: { encapsulated: true, offsets, fragments }, next: pos };
    }
    if (pos + length > bytes.length) throw new DicomError(`File is truncated: element ${tag} needs ${length} bytes at ${pos}, file has ${bytes.length}`);
    return { tag, vr, value: decode(vr, pos, length), next: pos + length };
  }

  function dataset(pos, end, into) {
    while (pos + 8 <= end) {
      if (view.getUint16(pos, little) === 0xfffe) break;
      const el = element(pos);
      into.set(el.tag, { vr: el.vr, value: el.value });
      pos = el.next;
    }
    return pos;
  }
  return { ...c, element, dataset };
}

/** Parses a Part 10 file. headerOnly stops before pixel data is validated against its size. */
export function parse(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 132 || latin1(bytes.subarray(128, 132)) !== 'DICM') throw new DicomError('Not a DICOM Part 10 file (no DICM prefix at byte 128)');
  const metaReader = reader(bytes, true, true);
  const meta = new Map();
  let pos = 132;
  while (pos + 8 <= bytes.length && metaReader.view.getUint16(pos, true) === 0x0002) {
    const el = metaReader.element(pos);
    meta.set(el.tag, { vr: el.vr, value: el.value });
    pos = el.next;
  }
  const transferSyntax = meta.get('00020010')?.value;
  if (!transferSyntax) throw new DicomError('Missing Transfer Syntax UID (0002,0010)');
  if (!SUPPORTED_TRANSFER_SYNTAXES.includes(transferSyntax) && !isCompressedSyntax(transferSyntax)) throw new DicomError(`Unsupported transfer syntax ${transferSyntax}. Supported: implicit VR little endian, explicit VR little endian, explicit VR big endian, RLE lossless, and the JPEG family (baseline, lossless, JPEG-LS, JPEG 2000) as encapsulated fragments`);
  const elements = new Map();
  reader(bytes, transferSyntax !== TS.EXPLICIT_BE, transferSyntax !== TS.IMPLICIT_LE).dataset(pos, bytes.length, elements);
  return new DicomFile(meta, elements, transferSyntax);
}

// ---------- Writing ----------
function encodeValue(vr, value, little) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    const out = new Uint8Array(value.byteLength);
    const view = new DataView(out.buffer);
    const size = value.BYTES_PER_ELEMENT;
    const setter = value instanceof Int16Array ? 'setInt16' : value instanceof Uint16Array ? 'setUint16' : null;
    if (!setter) throw new DicomError('Only 8 and 16 bit pixel arrays can be written');
    for (let i = 0; i < value.length; i += 1) view[setter](i * size, value[i], little);
    return out;
  }
  if (NUMERIC[vr]) {
    const [size, , setter] = NUMERIC[vr];
    const list = Array.isArray(value) ? value : [value];
    const out = new Uint8Array(list.length * size);
    const view = new DataView(out.buffer);
    list.forEach((n, i) => view[setter](i * size, n, little));
    return out;
  }
  const text = Array.isArray(value) ? value.join('\\') : String(value);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) { const code = text.charCodeAt(i); if (code > 255) throw new DicomError(`Character outside ISO-8859-1 in value "${text}"`); out[i] = code; }
  return out;
}

function encodeEncapsulated(tag, fragments, little) {
  const item = (payload) => { const head = new Uint8Array(8); const v = new DataView(head.buffer); v.setUint16(0, 0xfffe, little); v.setUint16(2, 0xe000, little); v.setUint32(4, payload.length, little); return [head, payload]; };
  const head = new Uint8Array(12); const v = new DataView(head.buffer);
  v.setUint16(0, parseInt(tag.slice(0, 4), 16), little); v.setUint16(2, parseInt(tag.slice(4), 16), little); head[4] = 0x4f; head[5] = 0x42; v.setUint32(8, UNDEFINED_LENGTH, little);
  const padded = fragments.map((f) => (f.length % 2 ? concat([f, new Uint8Array([0])]) : f));
  const delimiter = new Uint8Array(8); const d = new DataView(delimiter.buffer); d.setUint16(0, 0xfffe, little); d.setUint16(2, 0xe0dd, little); d.setUint32(4, 0, little);
  return [head, ...item(new Uint8Array(0)), ...padded.flatMap(item), delimiter];
}

/** A sequence: an array of items, each { Keyword: value }, written with explicit lengths. */
function encodeSequence(items, little, explicit) {
  const chunks = [];
  for (const item of Array.isArray(items) ? items : [items]) {
    const parts = Object.entries(item).filter(([, v]) => v !== undefined && v !== null).map(([keyword, value]) => { const tag = TAG_OF[keyword]; if (!tag) throw new DicomError(`Unknown keyword "${keyword}"`); return { tag, vr: DICT[tag][0], value }; }).sort((a, b) => (a.tag < b.tag ? -1 : 1)).flatMap((e) => encodeElement(e.tag, e.vr, e.value, little, explicit));
    const head = new Uint8Array(8); const view = new DataView(head.buffer);
    view.setUint16(0, 0xfffe, little); view.setUint16(2, 0xe000, little); view.setUint32(4, parts.reduce((n, c) => n + c.length, 0), little);
    chunks.push(head, ...parts);
  }
  return concat(chunks);
}
function encodeElement(tag, vr, value, little, explicit) {
  if (value && value.encapsulated) return encodeEncapsulated(tag, value.fragments, little);
  let body = vr === 'SQ' ? encodeSequence(value, little, explicit) : encodeValue(vr, value, little);
  if (body.length % 2) { const padded = new Uint8Array(body.length + 1); padded.set(body); padded[body.length] = vr === 'UI' || BINARY.has(vr) ? 0 : 0x20; body = padded; }
  const long = LONG_VR.has(vr);
  const head = new Uint8Array(explicit ? (long ? 12 : 8) : 8);
  const view = new DataView(head.buffer);
  view.setUint16(0, parseInt(tag.slice(0, 4), 16), little);
  view.setUint16(2, parseInt(tag.slice(4), 16), little);
  if (explicit) {
    head[4] = vr.charCodeAt(0); head[5] = vr.charCodeAt(1);
    if (long) view.setUint32(8, body.length, little);
    else { if (body.length > 0xffff) throw new DicomError(`Value too long for ${vr} element ${tag}`); view.setUint16(6, body.length, little); }
  } else {
    view.setUint32(4, body.length, little);
  }
  return [head, body];
}

const concat = (chunks) => { const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; } return out; };

/**
 * Writes a Part 10 file from { Keyword: value }. Keywords must be in DICT.
 * PixelData takes a Uint8Array, Uint16Array or Int16Array.
 */
export function write(dataset, { transferSyntax = TS.EXPLICIT_LE } = {}) {
  const compressed = isCompressedSyntax(transferSyntax);
  if (!SUPPORTED_TRANSFER_SYNTAXES.includes(transferSyntax) && !compressed) throw new DicomError(`Cannot write transfer syntax ${transferSyntax}`);
  if (compressed && !(dataset.PixelData && dataset.PixelData.encapsulated && Array.isArray(dataset.PixelData.fragments))) throw new DicomError('A compressed transfer syntax needs PixelData as { encapsulated: true, fragments: [Uint8Array] }');
  if (!compressed && dataset.PixelData && dataset.PixelData.encapsulated) throw new DicomError('Encapsulated fragments need a compressed transfer syntax');
  for (const key of ['SOPClassUID', 'SOPInstanceUID']) if (!dataset[key]) throw new DicomError(`${key} is required`);
  const little = transferSyntax !== TS.EXPLICIT_BE;
  const explicit = transferSyntax !== TS.IMPLICIT_LE;
  const entries = Object.entries(dataset).filter(([, v]) => v !== undefined && v !== null).map(([keyword, value]) => {
    const tag = TAG_OF[keyword];
    if (!tag) throw new DicomError(`Unknown keyword "${keyword}"`);
    if (tag.startsWith('0002')) throw new DicomError(`${keyword} belongs to the file meta group and is written automatically`);
    let vr = DICT[tag][0];
    if (keyword === 'PixelData' && explicit && ((value instanceof Uint8Array && (dataset.BitsAllocated ?? 8) === 8) || value?.encapsulated)) vr = 'OB';
    return { tag, vr, value };
  }).sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const body = entries.flatMap((e) => encodeElement(e.tag, e.vr, e.value, little, explicit));
  const metaBody = [
    ['00020001', 'OB', new Uint8Array([0, 1])], ['00020002', 'UI', dataset.SOPClassUID], ['00020003', 'UI', dataset.SOPInstanceUID],
    ['00020010', 'UI', transferSyntax], ['00020012', 'UI', IMPLEMENTATION_UID], ['00020013', 'SH', 'HOSPITAL_DESKTOP'],
  ].flatMap(([tag, vr, value]) => encodeElement(tag, vr, value, true, true));
  const metaLength = metaBody.reduce((n, c) => n + c.length, 0);
  const preamble = new Uint8Array(132);
  preamble.set([0x44, 0x49, 0x43, 0x4d], 128);
  return concat([preamble, ...encodeElement('00020000', 'UL', metaLength, true, true), ...metaBody, ...body]);
}

// ---------- RLE Lossless (PS3.5 Annex G): PackBits over byte segments, decoded and encoded here ----------
function packBits(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    let run = 1;
    while (i + run < src.length && src[i + run] === src[i] && run < 128) run += 1;
    if (run >= 2) { out.push(257 - run, src[i]); i += run; continue; }
    let lit = 0;
    while (i + lit < src.length && lit < 128 && !(i + lit + 1 < src.length && src[i + lit] === src[i + lit + 1])) lit += 1;
    if (lit === 0) lit = 1;
    out.push(lit - 1);
    for (let k = 0; k < lit; k += 1) out.push(src[i + k]);
    i += lit;
  }
  return Uint8Array.from(out);
}
function unpackBits(src, expected) {
  const out = new Uint8Array(expected);
  let i = 0; let o = 0;
  while (i < src.length && o < expected) {
    const n = src[i]; i += 1;
    if (n <= 127) { const len = Math.min(n + 1, expected - o); out.set(src.subarray(i, i + len), o); i += n + 1; o += len; }
    else if (n >= 129) { const len = Math.min(257 - n, expected - o); out.fill(src[i], o, o + len); i += 1; o += len; }
  }
  return out;
}
/** Encodes one frame (Uint8Array, Uint16Array or Int16Array) as an RLE fragment: a 64 byte header of segment offsets, then one PackBits segment per byte plane (most significant byte first for 16 bit). */
export function rleEncodeFrame(frame, { samples = 1 } = {}) {
  const bytesPerSample = frame.BYTES_PER_ELEMENT || 1;
  const count = frame.length / samples;
  const segments = [];
  for (let s = 0; s < samples; s += 1) {
    for (let b = bytesPerSample - 1; b >= 0; b -= 1) {
      const plane = new Uint8Array(count);
      for (let i = 0; i < count; i += 1) { const v = frame[i * samples + s]; plane[i] = (v >> (8 * b)) & 0xff; }
      segments.push(packBits(plane));
    }
  }
  if (segments.length > 15) throw new DicomError('RLE supports at most 15 segments');
  const header = new Uint8Array(64); const v = new DataView(header.buffer);
  v.setUint32(0, segments.length, true);
  let offset = 64;
  segments.forEach((seg, k) => { v.setUint32(4 + k * 4, offset, true); offset += seg.length; });
  return concat([header, ...segments]);
}
export function rleDecodeFrames(fragments, { rows, columns, samples, bitsAllocated, frames }) {
  const bytesPerSample = bitsAllocated / 8;
  const count = rows * columns * samples;
  const out = new Uint8Array(count * bytesPerSample * frames);
  if (fragments.length < frames) throw new DicomError(`RLE needs one fragment per frame (${fragments.length} for ${frames} frames)`);
  for (let f = 0; f < frames; f += 1) {
    const frag = fragments[f];
    const v = new DataView(frag.buffer, frag.byteOffset, frag.byteLength);
    const n = v.getUint32(0, true);
    if (n !== samples * bytesPerSample) throw new DicomError(`RLE fragment has ${n} segments; expected ${samples * bytesPerSample}`);
    const offsets = Array.from({ length: n }, (_, k) => v.getUint32(4 + k * 4, true));
    let k = 0;
    for (let s = 0; s < samples; s += 1) {
      for (let b = bytesPerSample - 1; b >= 0; b -= 1) {
        const plane = unpackBits(frag.subarray(offsets[k], k + 1 < n ? offsets[k + 1] : frag.length), rows * columns);
        for (let i = 0; i < rows * columns; i += 1) out[f * count * bytesPerSample + (i * samples + s) * bytesPerSample + b] = plane[i];
        k += 1;
      }
    }
  }
  return out;
}

// ---------- Identifiers ----------
export function isValidUid(uid) {
  return typeof uid === 'string' && uid.length > 0 && uid.length <= 64 && /^(0|[1-9]\d*)(\.(0|[1-9]\d*))+$/.test(uid);
}

/** A new UID under the 2.25 (UUID-derived) root. */
export function generateUid() {
  const random = new Uint8Array(16);
  globalThis.crypto.getRandomValues(random);
  let n = 0n;
  for (const b of random) n = (n << 8n) | BigInt(b);
  return `2.25.${n.toString()}`;
}

// ---------- Pixels ----------
/** Image geometry and a frame(i) accessor returning interleaved samples. */
export function pixels(file) {
  const rows = file.num('Rows');
  const columns = file.num('Columns');
  const samples = file.num('SamplesPerPixel') ?? 1;
  const bitsAllocated = file.num('BitsAllocated');
  const signed = file.num('PixelRepresentation') === 1;
  const frames = file.num('NumberOfFrames') ?? 1;
  const planar = file.num('PlanarConfiguration') ?? 0;
  let raw = file.get('PixelData');
  if (!rows || !columns) throw new DicomError('Rows and Columns are required to read pixels');
  if (raw && raw.encapsulated) {
    if (file.transferSyntax === COMPRESSED_TS.RLE) raw = rleDecodeFrames(raw.fragments, { rows, columns, samples, bitsAllocated, frames: file.num('NumberOfFrames') ?? 1, little: true });
    else throw new DicomError(`${COMPRESSED_LABEL[file.transferSyntax] || 'Compressed'} pixel data is decoded in the browser viewer, not here`);
  }
  if (!(raw instanceof Uint8Array)) throw new DicomError('No pixel data in this file');
  if (bitsAllocated !== 8 && bitsAllocated !== 16) throw new DicomError(`Unsupported BitsAllocated ${bitsAllocated} (8 and 16 are supported)`);
  if (samples !== 1 && samples !== 3) throw new DicomError(`Unsupported SamplesPerPixel ${samples}`);
  const frameBytes = rows * columns * samples * (bitsAllocated / 8);
  if (raw.length < frameBytes * frames) throw new DicomError(`Pixel data is ${raw.length} bytes; ${frames} frame(s) of ${columns}x${rows} need ${frameBytes * frames}`);
  const little = file.littleEndian;
  const count = rows * columns * samples;
  function frame(index) {
    if (index < 0 || index >= frames) throw new DicomError(`Frame ${index} out of range (0 to ${frames - 1})`);
    const start = index * frameBytes;
    if (bitsAllocated === 8) {
      const src = raw.subarray(start, start + frameBytes);
      if (samples === 3 && planar === 1) {
        const out = new Uint8Array(count);
        const plane = rows * columns;
        for (let i = 0; i < plane; i += 1) { out[i * 3] = src[i]; out[i * 3 + 1] = src[plane + i]; out[i * 3 + 2] = src[2 * plane + i]; }
        return out;
      }
      return new Uint8Array(src);
    }
    const out = signed ? new Int16Array(count) : new Uint16Array(count);
    const view = new DataView(raw.buffer, raw.byteOffset + start, frameBytes);
    const getter = signed ? 'getInt16' : 'getUint16';
    for (let i = 0; i < count; i += 1) out[i] = view[getter](i * 2, little);
    return out;
  }
  const spacing = file.nums('PixelSpacing').length === 2 ? file.nums('PixelSpacing') : file.nums('ImagerPixelSpacing').length === 2 ? file.nums('ImagerPixelSpacing') : null;
  return {
    rows, columns, samples, bitsAllocated, bitsStored: file.num('BitsStored') ?? bitsAllocated, signed, frames, frame,
    photometric: file.str('PhotometricInterpretation') || (samples === 3 ? 'RGB' : 'MONOCHROME2'),
    slope: file.num('RescaleSlope') ?? 1, intercept: file.num('RescaleIntercept') ?? 0,
    rowSpacing: spacing ? spacing[0] : null, columnSpacing: spacing ? spacing[1] : null,
    windowCenter: file.num('WindowCenter'), windowWidth: file.num('WindowWidth'),
  };
}

export const WINDOW_PRESETS = {
  'Soft Tissue': { center: 40, width: 400 }, Lung: { center: -600, width: 1500 }, Bone: { center: 300, width: 1500 },
  Brain: { center: 40, width: 80 }, Liver: { center: 60, width: 160 }, Mediastinum: { center: 40, width: 350 },
};

/** Window from the header if present, otherwise from the frame's value range. */
export function autoWindow(frame, info) {
  if (info.windowCenter != null && info.windowWidth) return { center: info.windowCenter, width: info.windowWidth };
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < frame.length; i += 1) { const v = frame[i]; if (v < min) min = v; if (v > max) max = v; }
  min = min * info.slope + info.intercept;
  max = max * info.slope + info.intercept;
  return { center: (min + max) / 2, width: Math.max(max - min, 1) };
}

/** Applies rescale and window to one frame. Returns RGBA bytes (rows x columns x 4). */
export function toRGBA(frame, info, { center, width, invert = false } = {}) {
  const n = info.rows * info.columns;
  const out = new Uint8ClampedArray(n * 4);
  if (info.samples === 3) {
    for (let i = 0; i < n; i += 1) { out[i * 4] = frame[i * 3]; out[i * 4 + 1] = frame[i * 3 + 1]; out[i * 4 + 2] = frame[i * 3 + 2]; out[i * 4 + 3] = 255; }
    return out;
  }
  const w = Math.max(width, 1e-6);
  const low = center - w / 2;
  const flip = (info.photometric === 'MONOCHROME1') !== invert;
  const { slope, intercept } = info;
  for (let i = 0; i < n; i += 1) {
    let g = ((frame[i] * slope + intercept - low) / w) * 255;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    if (flip) g = 255 - g;
    out[i * 4] = g; out[i * 4 + 1] = g; out[i * 4 + 2] = g; out[i * 4 + 3] = 255;
  }
  return out;
}

/** Length in mm between two pixel positions, or null when spacing is unknown. */
export function distanceMm(a, b, rowSpacing, columnSpacing) {
  if (!rowSpacing || !columnSpacing) return null;
  return Math.hypot((b.x - a.x) * columnSpacing, (b.y - a.y) * rowSpacing);
}

// ---------- NIfTI-1 ----------
export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const NIFTI_TYPES = { 2: [Uint8Array, 'getUint8', 1], 4: [Int16Array, 'getInt16', 2], 8: [Int32Array, 'getInt32', 4], 16: [Float32Array, 'getFloat32', 4], 64: [Float64Array, 'getFloat64', 8], 512: [Uint16Array, 'getUint16', 2] };

/** Parses an uncompressed single-file NIfTI-1 volume (.nii). Gunzip .nii.gz first. */
export function parseNifti(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 352) throw new DicomError('Not a NIfTI-1 file (too short)');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = view.getInt32(0, true) === 348;
  if (!little && view.getInt32(0, false) !== 348) throw new DicomError('Not a NIfTI-1 file (header size is not 348)');
  const magic = latin1(bytes.subarray(344, 347));
  if (magic !== 'n+1') throw new DicomError('Only single-file NIfTI-1 (.nii, magic "n+1") is supported');
  const ndim = view.getInt16(40, little);
  const dims = [1, 2, 3].map((i) => (i <= ndim ? view.getInt16(40 + i * 2, little) : 1));
  if (ndim < 2 || ndim > 4 || dims.some((d) => d < 1)) throw new DicomError(`Unsupported NIfTI dimensions (ndim ${ndim})`);
  const datatype = view.getInt16(70, little);
  const type = NIFTI_TYPES[datatype];
  if (!type) throw new DicomError(`Unsupported NIfTI datatype ${datatype}`);
  const spacing = [1, 2, 3].map((i) => Math.abs(view.getFloat32(76 + i * 4, little)) || 1);
  const offset = Math.round(view.getFloat32(108, little));
  const slope = view.getFloat32(112, little);
  const count = dims[0] * dims[1] * dims[2];
  const [Ctor, getter, size] = type;
  if (offset + count * size > bytes.length) throw new DicomError('NIfTI file is truncated');
  const data = new Ctor(count);
  for (let i = 0; i < count; i += 1) data[i] = view[getter](offset + i * size, little);
  // Where each voxel is in the patient (NIfTI axes are right, anterior, superior): the sform rows when given, otherwise the qform quaternion.
  const f = (o) => view.getFloat32(o, little); let affine = null;
  if (view.getInt16(254, little) > 0) affine = [[f(280), f(284), f(288), f(292)], [f(296), f(300), f(304), f(308)], [f(312), f(316), f(320), f(324)]];
  else if (view.getInt16(252, little) > 0) { const b = f(256); const c = f(260); const dq = f(264); const a = Math.sqrt(Math.max(0, 1 - b * b - c * c - dq * dq)); const q = f(76) < 0 ? -1 : 1; const [sx, sy, sz] = [1, 2, 3].map((i) => f(76 + i * 4));
    affine = [[(a * a + b * b - c * c - dq * dq) * sx, 2 * (b * c - a * dq) * sy, 2 * (b * dq + a * c) * sz * q, f(268)], [2 * (b * c + a * dq) * sx, (a * a + c * c - b * b - dq * dq) * sy, 2 * (c * dq - a * b) * sz * q, f(272)], [2 * (b * dq - a * c) * sx, 2 * (c * dq + a * b) * sy, (a * a + dq * dq - b * b - c * c) * sz * q, f(276)]]; }
  return { dims, spacing, data, slope: slope || 1, intercept: slope ? view.getFloat32(116, little) : 0, datatype, affine };
}
