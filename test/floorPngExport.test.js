// js/floorPngExport.js -- the black/white floor plan Disguise reads.
//
// Worth testing because this file is the SECOND renderer of the same scene
// (js/canvas.js draws the screen) and the two share no drawing code. Anything
// added to one is silently absent from the other until someone opens an
// exported PNG and notices -- which is exactly how recorded camera moves went
// missing from every export.
const { test } = require('node:test');
const assert = require('node:assert');
const { renderFloorPng } = require('./helpers/appContext');

const TRAIL = [{ x: 0, y: 0 }, { x: 1, y: 0.5 }, { x: 2, y: 1.2 }, { x: 3, y: 1.0 }, { x: 4, y: 0.2 }];

// A camera that was recorded moving. Its stored x/y is the end of the move,
// which is what liveRecording.js actually leaves behind.
const recorded = over => Object.assign({
  id: 'a', name: 'Cam A', x: 4, y: 0.2, rotationDeg: 0, color: '#4da6ff',
  focalLengthMm: 35, heightM: 1.4,
  trail: TRAIL,
  trailEndpoints: { start: { x: 0, y: 0, rotationDeg: 0 }, end: { x: 4, y: 0.2, rotationDeg: 90 } }
}, over || {});

const still = {
  id: 'b', name: 'Cam B', x: 8, y: 3, rotationDeg: 0, color: '#ff9f4d',
  focalLengthMm: 50, heightM: null, trail: null, trailEndpoints: null
};

const scene = cameras => ({ name: 'Position 1', props: [], cameras });
const SETUP = { name: 'Test Setup' };

test('a camera at rest draws its icon, red centre dot and caption', () => {
  const r = renderFloorPng(SETUP, scene([still]));
  assert.equal(r.icons.length, 1, 'one camera icon');
  assert.equal(r.icons[0].globalAlpha, 1, 'drawn fully opaque');
  assert.equal(r.redDots.length, 1, 'one red centre marker for Disguise to align to');
  assert.ok(r.texts.includes('Cam B'), 'named');
  assert.ok(r.texts.some(t => t && t.includes('Lens: 50mm')), 'lens printed');
  assert.equal(r.strokes.length, 0, 'nothing to draw a path for');
});

test('a recorded camera is drawn as the move alone, with no static icon or dot', () => {
  const r = renderFloorPng(SETUP, scene([recorded()]));

  assert.ok(r.strokes.length >= 1, 'the path is stroked');
  assert.ok(r.texts.includes('Start') && r.texts.includes('End'), 'both ends marked');

  // Two icons, not three: Start and End only. The static icon is suppressed
  // because the camera's stored position IS the end of the move, so drawing
  // it put a second icon almost on top of the End one.
  assert.equal(r.icons.length, 2, 'Start and End only -- no icon at the stored position');
  assert.deepEqual(r.icons.map(i => i.globalAlpha), [0.55, 0.55], 'both are snapshots, not the camera');

  // A camera that moved has no single point for Disguise to line up against.
  assert.equal(r.redDots.length, 0, 'no red centre marker for a camera that moved');

  // Still identifiable: with several camera positions per scene, the caption
  // is the only thing saying which path belongs to which camera.
  assert.ok(r.texts.includes('Cam A'), 'the path is still named');
  assert.ok(r.texts.some(t => t && t.includes('Lens: 35mm')), 'lens/height caption survives');
});

test('the path is stroked in metres, not pixels, so it scales with the floor', () => {
  const r = renderFloorPng(SETUP, scene([recorded()]));
  // That canvas is ~245 px/m; the on-screen 2px line would be a hairline here.
  assert.ok(r.strokes[0].lineWidth > 5,
    `expected a floor-scaled width, got ${r.strokes[0].lineWidth}`);
});

test('every trail point is plotted', () => {
  const r = renderFloorPng(SETUP, scene([recorded()]));
  const strokeIdx = r.exportOps.findIndex(o => o.op === 'stroke');
  const lineTos = [];
  for (const o of r.exportOps.slice(0, strokeIdx).reverse()) {
    if (o.op === 'lineTo') lineTos.push(o);
    else if (o.op === 'moveTo') break;
  }
  assert.equal(lineTos.length, TRAIL.length - 1);
});

test('the path is drawn behind its own endpoint markers', () => {
  const r = renderFloorPng(SETUP, scene([recorded()]));
  const strokeIdx = r.exportOps.findIndex(o => o.op === 'stroke');
  const endIdx = r.exportOps.findIndex(o => o.op === 'fillText' && o.text === 'End');
  assert.ok(strokeIdx < endIdx, 'path first, markers on top');
});

test("a moved camera's caption clears the End text rather than overlapping it", () => {
  const r = renderFloorPng(SETUP, scene([recorded()]));
  assert.ok(r.caption('Cam A').y > r.exportOps.find(o => o.op === 'fillText' && o.text === 'End').y);
});

test('the caption follows the trail end, not the stored position', () => {
  // Move ONLY the stored x/y. The trail is untouched, so a caption anchored to
  // the static position would move and one anchored to the End would not.
  const atEnd = renderFloorPng(SETUP, scene([recorded()])).caption('Cam A');
  const moved = renderFloorPng(SETUP, scene([recorded({ x: 9, y: 6 })])).caption('Cam A');
  assert.equal(moved.x, atEnd.x);
  assert.equal(moved.y, atEnd.y);
});

test('recorded and still cameras coexist in one scene', () => {
  const r = renderFloorPng(SETUP, scene([recorded(), still]));
  assert.equal(r.icons.length, 3, '2 endpoints + 1 still camera');
  assert.equal(r.redDots.length, 1, 'only the still camera gets a centre marker');
  assert.ok(r.texts.includes('Cam A') && r.texts.includes('Cam B'), 'both named');
});

// --- degenerate data ----------------------------------------------------
// Suppression keys on the path AND its endpoints. liveRecording.js always
// writes the pair together, so requiring both means hand-edited data missing
// them degrades to the plain static icon rather than to an unlabelled line.

test('a path with no endpoints falls back to the static camera', () => {
  const r = renderFloorPng(SETUP, scene([recorded({ trailEndpoints: null })]));
  assert.equal(r.icons.length, 1, 'the static icon is drawn');
  assert.equal(r.redDots.length, 1);
  assert.equal(r.strokes.length, 0, 'and no unlabelled line');
});

test('a single-point path falls back to the static camera too', () => {
  const r = renderFloorPng(SETUP, scene([recorded({ trail: [{ x: 1, y: 1 }] })]));
  assert.equal(r.icons.length, 1);
  assert.equal(r.strokes.length, 0);
});

test('a scene with no cameras does not throw', () => {
  assert.doesNotThrow(() => renderFloorPng(SETUP, {
    name: 'P',
    props: [{ id: 'p', name: 'Box', shape: 'rect', x: 1, y: 1, widthM: 1, depthM: 1, rotationDeg: 0 }],
    cameras: []
  }));
});

// --- regression ---------------------------------------------------------

test("the icon's source-in recolour stays off the export canvas", () => {
  // 'source-in' composites against the WHOLE target canvas and isn't scoped by
  // save()/restore(), so doing it inline once erased the background and every
  // shape drawn before it. It has to happen on a scratch canvas.
  const r = renderFloorPng(SETUP, scene([still]));
  assert.equal(r.ops[0].op, 'fillRect');
  assert.equal(r.ops[0].fillStyle, '#000000', 'black background painted first');
  assert.equal(r.ops[0].ctxId, 0, 'on the export canvas');
  assert.ok(r.ops.some(o => o.op === 'drawImage' && o.ctxId !== 0), 'recolour happened elsewhere');
});
