// Hanging protocols for the PACS viewer: which layout a study opens in, chosen by modality and body
// part, with the user's own choice remembered per modality and body part. Pure logic; the page
// passes in what the study can show and a storage object.
export const LAYOUTS = [
  { id: '1x1', label: '1 x 1', title: 'One pane', needs: [] },
  { id: '1x2', label: '1 x 2', title: 'Two panes: current and prior side by side', needs: ['prior'] },
  { id: '2x2', label: '2 x 2', title: 'Axial, coronal, sagittal and 3D', needs: ['volume'] },
  { id: 'mpr+prior', label: 'MPR + prior', title: 'Axial, coronal, sagittal plus the prior', needs: ['volume', 'prior'] },
  { id: '1+3', label: '1 + 3', title: 'One large axial pane with coronal, sagittal and 3D beside it', needs: ['volume'] },
  { id: '3d', label: '3D', title: '3D volume rendering', needs: ['volume'] },
];
// First match wins. `layouts` is the order of preference; the first one the study can show is used.
export const PROTOCOLS = [
  { id: 'ct-chest', name: 'CT chest', modality: 'CT', bodyPart: /chest|thorax|lung/i, layouts: ['mpr+prior', '2x2', '1x2', '1x1'], preset: 'Lung' },
  { id: 'ct-head', name: 'CT head', modality: 'CT', bodyPart: /head|brain|skull/i, layouts: ['2x2', '1x2', '1x1'], preset: 'Brain' },
  { id: 'ct-abdomen', name: 'CT abdomen and pelvis', modality: 'CT', bodyPart: /abd|pelvis|liver|kidney/i, layouts: ['mpr+prior', '2x2', '1x2', '1x1'], preset: 'Abdomen' },
  { id: 'ct', name: 'CT', modality: 'CT', bodyPart: null, layouts: ['2x2', '1x2', '1x1'], preset: null },
  { id: 'mr', name: 'MR', modality: 'MR', bodyPart: null, layouts: ['1+3', '1x2', '1x1'], preset: null },
  { id: 'xr', name: 'Radiograph', modality: /^(XR|CR|DX)$/, bodyPart: null, layouts: ['1x2', '1x1'], preset: null },
  { id: 'default', name: 'Default', modality: null, bodyPart: null, layouts: ['1x2', '1x1'], preset: null },
];
const matches = (rule, value) => rule == null || (rule instanceof RegExp ? rule.test(String(value || '')) : String(value || '').toUpperCase() === rule);
export const protocolFor = ({ modality, bodyPart, description }) => PROTOCOLS.find((p) => matches(p.modality, modality) && (p.bodyPart == null || p.bodyPart.test(`${bodyPart || ''} ${description || ''}`)));
export const canShow = (layoutId, can) => (LAYOUTS.find((l) => l.id === layoutId)?.needs || ['never']).every((n) => Boolean(can[n]));
export const prefKey = ({ modality, bodyPart }) => `hd.pacs.hanging.${String(modality || 'any').toUpperCase()}.${String(bodyPart || 'any').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
/**
 * The layout to open with: the saved choice for this modality and body part if the study can show it,
 * else the protocol's first layout it can show. can = { prior: bool, volume: bool }.
 */
export function chooseLayout(study, can, storage = null) {
  const protocol = protocolFor(study);
  let saved = null;
  try { saved = storage?.getItem(prefKey(study)) || null; } catch { saved = null; }
  if (saved && canShow(saved, can)) return { layout: saved, protocol, from: 'saved' };
  const layout = protocol.layouts.find((l) => canShow(l, can)) || '1x1';
  return { layout, protocol, from: 'protocol' };
}
export function saveLayout(study, layoutId, storage) { try { storage?.setItem(prefKey(study), layoutId); } catch { /* storage unavailable: the choice lasts for this study only */ } }

/** For linking current and prior by position: the index in `locations` nearest to `mm`; null when there are none. */
export function nearestByLocation(locations, mm) {
  if (!Array.isArray(locations) || !locations.length || mm == null) return null;
  let best = 0; let d = Infinity;
  locations.forEach((loc, i) => { const x = Math.abs(Number(loc) - mm); if (x < d) { d = x; best = i; } });
  return best;
}

export const SHORTCUTS = [
  ['W', 'Window and level'], ['L', 'Length'], ['A', 'Angle'], ['C', 'Cobb angle'], ['E', 'Ellipse region'], ['F', 'Freehand region'], ['H', 'Probe (value at a point)'], ['B', 'Bidirectional'], ['T', 'Arrow note'],
  ['P', 'Pan'], ['Z', 'Zoom'], ['I', 'Invert'], ['R', 'Reset the view'], ['Space', 'Cine: play or stop'], ['Up / Down', 'Previous or next image'], ['Home / End', 'First or last image'], ['Page Up / Page Down', 'Jump ten images'],
  ['1 to 6', 'Layouts, in the order of the layout picker'], ['K', 'Link or unlink scrolling, zoom and window'], ['M', 'Show or hide the measurements panel'], ['S', 'Show or hide the segmentation panel'], ['?', 'This help'],
];
