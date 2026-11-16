// Pathology analysis in our own code, on generated images: colour
// deconvolution, tissue detection, nucleus detection on a generated pattern, the object and pixel
// classifiers, the wand, annotation geometry (merge, split, hierarchy) and the measurement tables.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../pathology/server/slide-analysis.mjs';

const near = (a, b, tol, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} is not within ${tol} of ${b}`);
/** The colour a pixel has with these stain amounts (the forward model of colour deconvolution). */
const colourOf = (amounts, stains = 'HE') => { const { m } = A.stainMatrix(stains); return [0, 1, 2].map((k) => Math.max(0, Math.min(255, Math.round(256 * 10 ** (-(amounts[0] * m[0][k] + amounts[1] * m[1][k])) - 1)))); };
/** A generated slide region: white glass, a rectangle of eosin-pink tissue, and round haematoxylin nuclei. */
function generated({ w = 200, h = 160, tissue = [20, 20, 180, 140], nuclei = [] } = {}) {
  const rgb = new Uint8Array(w * h * 3).fill(245);
  const pink = colourOf([0.05, 0.5]);
  for (let y = tissue[1]; y < tissue[3]; y += 1) for (let x = tissue[0]; x < tissue[2]; x += 1) rgb.set(pink, (y * w + x) * 3);
  for (const [cx, cy, r, amount = 1.2] of nuclei) { const c = colourOf([amount, 0.2]); for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y += 1) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x += 1) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= 0 && y >= 0 && x < w && y < h) rgb.set(c, (y * w + x) * 3); }
  return { rgb, w, h };
}

test('colour deconvolution gives back the stain amounts that made the colour, for H&E and for H-DAB', () => {
  for (const [stains, amounts] of [['HE', [1.0, 0.3]], ['HE', [0.2, 0.8]], ['HDAB', [0.6, 0.9]], ['HDAB', [0, 0]]]) {
    const out = A.deconvolve(Uint8Array.from(colourOf(amounts, stains)), stains);
    near(out[0][0], amounts[0], 0.03, `${stains} first stain`); near(out[1][0], amounts[1], 0.03, `${stains} second stain`); near(out[2][0], 0, 0.03, 'residual');
  }
  assert.deepEqual(A.stainMatrix('HDAB').channels, ['Haematoxylin', 'DAB', 'Residual']);
  assert.throws(() => A.stainMatrix('XYZ'), /Unknown stain set/);
  const view = A.stainImage(Float32Array.from([0, 1]), 'HE', 0);
  assert.deepEqual([...view.slice(0, 4)], [255, 255, 255, 255], 'no stain is white');
  assert.ok(view[4] < view[6] && view[5] < view[6], 'haematoxylin alone is blue-purple');
});

test('Otsu, boundaries, rasterising and simplifying behave on small exact cases', () => {
  const hist = new Array(256).fill(0); hist[30] = 500; hist[32] = 300; hist[200] = 400; hist[205] = 100;
  const t = A.otsu(hist); assert.ok(t >= 32 && t < 200, `threshold ${t} separates the two groups`);
  const mask = new Uint8Array(25); mask[12] = 1; // one pixel at (2, 2)
  const one = A.maskPolygons(mask, 5, 5, { tolerance: 0 });
  assert.deepEqual(one[0].points, [[2, 2], [3, 2], [3, 3], [2, 3]], 'a single pixel is traced as its four corners');
  const sq = [[10, 10], [30, 10], [30, 25], [10, 25]];
  const filled = A.rasterize([sq], 40, 40);
  assert.equal(filled.reduce((a, b) => a + b, 0), 20 * 15);
  const again = A.maskPolygons(filled, 40, 40);
  assert.deepEqual([again.length, again[0].area, A.polygonArea(again[0].points)], [1, 300, 300]);
  assert.equal(A.polygonPerimeter(sq), 70);
  near(A.polygonArea(A.ellipsePolygon(50, 50, 20, 10, 96)), Math.PI * 200, 2, 'ellipse area');
  const wavy = Array.from({ length: 40 }, (_, i) => [i, i % 2 ? 0.2 : 0]).concat([[39, 20], [0, 20]]);
  assert.ok(A.simplify(wavy, 1).length <= 6, 'small wiggles are removed');
});

test('tissue detection outlines the tissue against the glass at low resolution', () => {
  const g = generated({ nuclei: [[60, 60, 5], [120, 90, 5]] });
  const out = A.detectTissue(g.rgb, g.w, g.h);
  near(out.tissueFraction, (160 * 120) / (200 * 160), 0.02, 'tissue fraction');
  assert.equal(out.polygons.length, 1);
  const [x0, y0, x1, y1] = out.polygons[0].bbox;
  for (const [got, want] of [[x0, 20], [y0, 20], [x1, 180], [y1, 140]]) near(got, want, 2, 'bounding box edge');
  const blank = A.detectTissue(new Uint8Array(50 * 50 * 3).fill(244), 50, 50);
  assert.deepEqual([blank.polygons.length, blank.tissueFraction], [0, 0], 'blank glass has no tissue');
});

test('cell detection on a generated pattern: every nucleus found once, touching nuclei split, with area, shape and stain measurements', () => {
  const nuclei = []; for (let r = 0; r < 4; r += 1) for (let c = 0; c < 5; c += 1) nuclei.push([40 + c * 30, 40 + r * 28, 6]);
  nuclei.push([44, 150, 6], [55, 150, 6]); // a touching pair
  const g = generated({ w: 220, h: 180, tissue: [10, 10, 210, 170], nuclei });
  const out = A.detectNuclei(g.rgb, g.w, g.h, { mpp: 0.5 });
  assert.equal(out.cells.length, nuclei.length, `${out.cells.length} cells for ${nuclei.length} nuclei`);
  for (const [cx, cy] of nuclei.slice(0, 20)) { const hit = out.cells.filter((c) => Math.hypot(c.x - cx, c.y - cy) < 2); assert.equal(hit.length, 1, `one cell at ${cx},${cy}`); near(hit[0].area, Math.PI * 36, 30, 'area in pixels'); near(hit[0].areaUm2, hit[0].area * 0.25, 0.01, 'area in µm²'); assert.ok(hit[0].circularity > 0.8 && hit[0].eccentricity < 0.5, `round: ${JSON.stringify(hit[0])}`); near(hit[0].nucleusStain, 1.2, 0.2, 'haematoxylin amount'); }
  const pair = out.cells.filter((c) => c.y > 140).sort((a, b) => a.x - b.x);
  assert.equal(pair.length, 2, 'the touching pair is split in two');
  near(pair[0].x, 44, 3); near(pair[1].x, 55, 3);
  assert.deepEqual(A.detectNuclei(generated({ nuclei: [] }).rgb, 200, 160).cells, [], 'tissue without nuclei has no cells');
  assert.throws(() => A.detectNuclei(new Uint8Array(3), 4096, 4096), /at most .* pixels \(2048 x 2048\)/, 'the region size is capped with a clear message');
  assert.equal(A.featuresOf(out.cells[0]).length, A.FEATURES.length);
});

test('object classifier: trained on a few labelled cells, it classes the rest; correcting and retraining gives a new model', () => {
  const nuclei = [];
  for (let i = 0; i < 12; i += 1) nuclei.push([25 + i * 16, 40, 4, 1.4]); // small and dark
  for (let i = 0; i < 9; i += 1) nuclei.push([30 + i * 22, 100, 9, 0.6]); // large and pale
  const g = generated({ w: 240, h: 160, tissue: [5, 5, 235, 155], nuclei });
  const cells = A.detectNuclei(g.rgb, g.w, g.h).cells;
  assert.equal(cells.length, 21);
  const truth = (c) => (c.y < 70 ? 'Lymphocyte' : 'Tumour');
  const examples = [...cells.filter((c) => c.y < 70).slice(0, 3), ...cells.filter((c) => c.y >= 70).slice(0, 3)].map((c) => ({ features: A.featuresOf(c), label: truth(c) }));
  const model = A.trainClassifier(examples);
  assert.deepEqual(model.classes, ['Lymphocyte', 'Tumour']);
  assert.equal(model.trainingAccuracy, 1);
  assert.ok(cells.every((c) => A.predict(model, A.featuresOf(c)).label === truth(c)), 'every cell is classed correctly from six examples');
  assert.deepEqual(A.trainClassifier(examples).weights, model.weights, 'training is deterministic');
  const third = A.trainClassifier([...examples, { features: A.featuresOf(cells[0]).map((v, i) => (i === 0 ? 400 : v)), label: 'Giant' }]);
  assert.deepEqual(third.classes, ['Giant', 'Lymphocyte', 'Tumour']);
  assert.throws(() => A.trainClassifier(examples.slice(0, 3)), /at least two classes/);
  assert.throws(() => A.trainClassifier(examples, { classes: ['Lymphocyte', 'Tumour', 'Stroma'] }), /no example of the class "Stroma"/);
});

test('pixel classifier: painted examples of glass, stroma and nuclei classify the whole region', () => {
  const g = generated({ nuclei: [[60, 60, 8], [120, 90, 8], [150, 50, 8]] });
  const f = A.pixelFeatures(g.rgb, g.w, g.h);
  const at = (x, y) => f(y * g.w + x);
  const samples = [];
  for (let k = 0; k < 6; k += 1) { samples.push({ features: at(3 + k, 5), label: 'Background' }, { features: at(40 + k * 3, 120), label: 'Stroma' }, { features: at(58 + (k % 3), 58 + (k % 2)), label: 'Nuclei' }); }
  const model = A.trainClassifier(samples, { minSd: A.PIXEL_MIN_SD });
  const out = A.classifyPixels(g.rgb, g.w, g.h, model);
  const total = g.w * g.h; const tissue = 160 * 120; const nuc = 3 * Math.PI * 64;
  near(out.counts.Background / total, (total - tissue) / total, 0.05, 'background share (a band two pixels wide along the tissue edge goes either way)');
  near(out.counts.Nuclei / total, nuc / total, 0.02, 'nuclei share');
  near(out.counts.Stroma / total, (tissue - nuc) / total, 0.05, 'stroma share');
  assert.equal(model.classes[out.classMap[60 * g.w + 60]], 'Nuclei');
  assert.equal(model.classes[out.classMap[2 * g.w + 2]], 'Background');
});

test('the wand selects the similar-looking region under the click and outlines it', () => {
  const g = generated({ nuclei: [[100, 80, 10]] });
  const tissue = A.wand(g.rgb, g.w, g.h, 30, 30, { tolerance: 20 });
  near(tissue.pixels, 160 * 120 - Math.PI * 100, 40, 'tissue without the nucleus');
  assert.ok(tissue.polygon.length >= 4);
  const nucleus = A.wand(g.rgb, g.w, g.h, 100, 80, { tolerance: 20 });
  near(nucleus.pixels, Math.PI * 100, 25, 'the nucleus alone');
  near(A.polygonArea(nucleus.polygon), Math.PI * 100, 30);
  assert.equal(A.wand(g.rgb, g.w, g.h, -5, 3).pixels, 0);
  assert.equal(A.wand(g.rgb, g.w, g.h, 30, 30, { maxPixels: 50 }).capped, true);
});

test('annotation editing: merge, split and hierarchy', () => {
  const a = [[0, 0], [100, 0], [100, 100], [0, 100]]; const b = [[50, 50], [150, 50], [150, 150], [50, 150]]; const far = [[400, 400], [450, 400], [450, 450], [400, 450]];
  const merged = A.mergePolygons([a, b]);
  assert.equal(merged.length, 1);
  near(A.polygonArea(merged[0]), 17500, 200, 'the union of two overlapping squares');
  assert.equal(A.mergePolygons([a, far]).length, 2, 'shapes that do not touch stay separate');
  const pieces = A.splitPolygon(a, [[50, -10], [50, 110]]);
  assert.equal(pieces.length, 2);
  for (const p of pieces) near(A.polygonArea(p), 5000, 300, 'each half');
  assert.equal(A.splitPolygon(a, [[200, 0], [200, 100]]).length, 1, 'a line that misses changes nothing');
  const tree = A.hierarchy([{ id: 'tissue', points: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]] }, { id: 'tumour', points: [[100, 100], [500, 100], [500, 500], [100, 500]] }, { id: 'gland', points: [[200, 200], [300, 200], [300, 300], [200, 300]] }, { id: 'outside', points: [[2000, 0], [2100, 0], [2100, 100]] }]);
  assert.deepEqual([tree.get('gland'), tree.get('tumour'), tree.get('tissue'), tree.get('outside')], ['tumour', 'tissue', null, null], 'each shape sits in the smallest shape that contains it');
});

test('measurements per annotation and per class, and the exported table', () => {
  const g = generated({ nuclei: [[60, 60, 10]] });
  const overTissue = A.measureRegion(g.rgb, g.w, g.h, [[30, 100], [90, 100], [90, 130], [30, 130]], { mpp: 0.5 });
  assert.deepEqual([overTissue.areaPx, overTissue.perimeterPx, overTissue.areaUm2, overTissue.perimeterUm], [1800, 180, 450, 90]);
  near(overTissue.mean.Eosin, 0.5, 0.05); near(overTissue.mean.Haematoxylin, 0.05, 0.05);
  const overNucleus = A.measureRegion(g.rgb, g.w, g.h, A.ellipsePolygon(60, 60, 6, 6), { mpp: 0.5 });
  near(overNucleus.mean.Haematoxylin, 1.2, 0.05);
  // The same region read at a quarter of the resolution: scale and origin put the polygon in place.
  const small = new Uint8Array(50 * 40 * 3); for (let y = 0; y < 40; y += 1) for (let x = 0; x < 50; x += 1) small.set(g.rgb.subarray(((y * 4) * g.w + x * 4) * 3, ((y * 4) * g.w + x * 4) * 3 + 3), (y * 50 + x) * 3);
  near(A.measureRegion(small, 50, 40, [[30, 100], [90, 100], [90, 130], [30, 130]], { scale: 4 }).mean.Eosin, 0.5, 0.05, 'measured on a lower level');
  const rows = [{ class: 'Tumour', areaUm2: 450, perimeterUm: 90, count: 0, mean: { Haematoxylin: 0.05, Eosin: 0.5 }, pixelsMeasured: 1800 }, { class: 'Tumour', areaUm2: 50, perimeterUm: 30, count: 3, mean: { Haematoxylin: 1.2, Eosin: 0.2 }, pixelsMeasured: 200 }, { class: null, areaUm2: 10, perimeterUm: 12, count: 1, mean: null, pixelsMeasured: 0 }];
  const sum = A.summariseByClass(rows);
  assert.deepEqual(sum.map((x) => [x.class, x.annotations, x.areaUm2, x.count]), [['Tumour', 2, 500, 3], ['Unclassified', 1, 10, 1]]);
  near(sum[0].mean.Haematoxylin, (0.05 * 1800 + 1.2 * 200) / 2000, 0.001);
  assert.equal(A.toCsv([{ a: 'x, "y"', b: 2 }], [['a', 'Name'], ['b', 'Area (µm²)']]), 'Name,Area (µm²)\n"x, ""y""",2');
});
