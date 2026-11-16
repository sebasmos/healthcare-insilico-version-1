// Pathology annotations to and from QuPath GeoJSON (full-resolution pixels, origin top left).
import test from 'node:test';
import assert from 'node:assert/strict';
import { toGeoJSON, fromGeoJSON, measure } from '../pathology/web/pathology/qupath.js';

const drawn = [
  { id: 'a1', kind: 'rect', points: [[100, 200], [300, 260]], label: 'Finding' },
  { id: 'a2', kind: 'freehand', points: [[10, 10], [60, 12], [40, 70]], closed: true, label: 'Normal' },
  { id: 'a3', kind: 'count', points: [[5, 5], [8, 9]] },
  { id: 'a4', kind: 'ruler', points: [[0, 0], [30, 40]] },
  { id: 'a5', kind: 'text', points: [[7, 7]], text: 'Mitosis here' },
  { id: 'a6', kind: 'arrow', points: [[1, 1], [9, 9]], text: 'Look' },
];

test('export: polygons with closed rings, points, lines and QuPath classifications', () => {
  const fc = toGeoJSON(drawn);
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.features.length, 6);
  const [rect, free, count, ruler, text] = fc.features;
  assert.deepEqual(rect.geometry, { type: 'Polygon', coordinates: [[[100, 200], [300, 200], [300, 260], [100, 260], [100, 200]]] });
  assert.equal(rect.properties.objectType, 'annotation');
  assert.deepEqual(rect.properties.classification, { name: 'Finding', color: [247, 49, 59] });
  assert.deepEqual(free.geometry.coordinates[0].at(-1), free.geometry.coordinates[0][0], 'the ring is closed');
  assert.equal(count.geometry.type, 'MultiPoint');
  assert.equal(ruler.geometry.type, 'LineString');
  assert.deepEqual([text.geometry.type, text.properties.name], ['Point', 'Mitosis here']);
  assert.deepEqual(toGeoJSON([{ kind: 'freehand', points: [[1, 1], [2, 2]] }, { kind: 'rect', points: [[NaN, 1], [2, 2]] }]).features, [], 'too few points or bad numbers are left out');
});

test('import: what was exported comes back the same; QuPath shapes this viewer cannot show are counted, not guessed', () => {
  const back = fromGeoJSON(JSON.parse(JSON.stringify(toGeoJSON(drawn))));
  assert.equal(back.skipped, 0);
  assert.deepEqual(back.annotations.map((a) => [a.kind, a.points, a.label ?? null, a.text ?? null]), [
    ['rect', [[100, 200], [300, 260]], 'Finding', null], ['freehand', [[10, 10], [60, 12], [40, 70]], 'Normal', null], ['count', [[5, 5], [8, 9]], null, null],
    ['ruler', [[0, 0], [30, 40]], null, null], ['text', [[7, 7]], null, 'Mitosis here'], ['arrow', [[1, 1], [9, 9]], null, 'Look'],
  ]);
  // As QuPath writes it: a bare array of features, a classification, a polygon with a hole, a MultiPolygon, an ellipse-like polygon and an unknown type.
  const qupath = [
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]], [[10, 10], [20, 10], [20, 20], [10, 10]]] }, properties: { objectType: 'annotation', classification: { name: 'Tumor', color: [200, 0, 0] } } },
    { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [5, 1], [3, 6], [0, 0]]], [[[50, 50], [55, 51], [53, 56], [50, 50]]]] }, properties: {} },
    { type: 'Feature', geometry: { type: 'GeometryCollection', geometries: [] }, properties: {} },
  ];
  const got = fromGeoJSON(qupath);
  assert.deepEqual(got.annotations.map((a) => a.kind), ['rect', 'freehand', 'freehand']);
  assert.equal(got.annotations[0].label, 'Tumor');
  assert.equal(got.skipped, 2, 'one hole and one unknown geometry');
  assert.throws(() => fromGeoJSON({ hello: 1 }), /not GeoJSON/);
});

test('measurements use the slide scale', () => {
  assert.equal(measure({ kind: 'ruler', points: [[0, 0], [30, 40]] }, 0.5).microns, 25);
  assert.equal(measure({ kind: 'rect', points: [[0, 0], [10, 20]] }, 0.5).areaUm2, 50);
  assert.equal(measure({ kind: 'freehand', points: [[0, 0], [10, 0], [10, 10], [0, 10]] }, 1).areaUm2, 100);
  assert.equal(measure({ kind: 'count', points: [[1, 1], [2, 2]] }, null).count, 2);
  assert.equal(measure({ kind: 'ruler', points: [[0, 0], [3, 4]] }, null).microns, null, 'no scale, no length');
});

test('plain GeoJSON, and the newer shapes: ellipse, polygon, line and point round trip in both forms', () => {
  const shapes = [{ kind: 'ellipse', points: [[100, 100], [300, 200]], class: 'Gland', colour: '#00AA55' }, { kind: 'polygon', points: [[0, 0], [50, 0], [25, 40]], class: 'Tumour' }, { kind: 'line', points: [[0, 0], [10, 10], [20, 0]] }, { kind: 'point', points: [[7, 9]], class: 'Mitosis' }];
  const q = toGeoJSON(shapes);
  assert.deepEqual(q.features[0].properties.classification, { name: 'Gland', color: [0, 170, 85] }, 'the class colour is written for QuPath');
  assert.equal(q.features[0].geometry.coordinates[0].length, 49, 'an ellipse is written as a closed polygon');
  const plain = toGeoJSON(shapes, { flavour: 'plain' });
  assert.deepEqual(plain.features.map((x) => [x.geometry.type, x.properties.class ?? null, x.properties.objectType ?? null]), [['Polygon', 'Gland', null], ['Polygon', 'Tumour', null], ['LineString', null, null], ['Point', 'Mitosis', null]]);
  for (const fc of [q, plain]) {
    const back = fromGeoJSON(JSON.parse(JSON.stringify(fc)));
    assert.equal(back.skipped, 0);
    assert.deepEqual(back.annotations.map((a) => [a.kind, a.points, a.label ?? null]), [['ellipse', [[100, 100], [300, 200]], 'Gland'], ['freehand', [[0, 0], [50, 0], [25, 40]], 'Tumour'], ['line', [[0, 0], [10, 10], [20, 0]], null], ['point', [[7, 9]], 'Mitosis']]);
  }
});
