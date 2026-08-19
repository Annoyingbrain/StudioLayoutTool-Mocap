// js/reportExport.js -- the printable top-down layout.
//
// This is the THIRD renderer of the same scene: js/canvas.js draws the screen,
// js/floorPngExport.js draws the Disguise PNG, and this draws the print. They
// share no drawing code, so anything added to one is silently absent from the
// others until someone opens that output and notices. Cameras were missing
// from this one entirely -- the same class of bug as recorded moves once
// missing from every exported PNG.
const { test } = require('node:test');
const assert = require('node:assert');
const { renderReport } = require('./helpers/appContext');

const TRAIL = [{ x: 0, y: 0 }, { x: 1, y: 0.5 }, { x: 2, y: 1.2 }, { x: 3, y: 1.0 }, { x: 4, y: 0.2 }];

// A camera that was recorded moving. Its stored x/y is the end of the move,
// which is what liveRecording.js actually leaves behind.
const recorded = over => Object.assign({
  id: 'a', name: 'Cam A', x: 4, y: 0.2, rotationDeg: 0, color: '#4da6ff',
  focalLengthMm: 35, heightM: 1.4, positionSource: 'measured',
  trail: TRAIL,
  trailEndpoints: { start: { x: 0, y: 0, rotationDeg: 0 }, end: { x: 4, y: 0.2, rotationDeg: 90 } }
}, over || {});

const still = over => Object.assign({
  id: 'b', name: 'Cam B', x: 8, y: 3, rotationDeg: 0, color: '#ff9f4d',
  focalLengthMm: 50, heightM: null, positionSource: 'manual',
  trail: null, trailEndpoints: null
}, over || {});

const scene = cameras => ({ name: 'Position 1', props: [], cameras, updatedAt: new Date().toISOString() });
const SETUP = { name: 'Test Setup' };

test('a camera at rest is drawn and named on the printed layout', () => {
  const r = renderReport(SETUP, scene([still()]));
  assert.equal(r.icons.length, 1, 'the camera icon, not a bare triangle');
  assert.ok(r.texts.includes('Cam B'), 'named');
  assert.ok(r.texts.some(t => t && t.includes('Lens: 50mm')), 'lens printed');
});

test("the icon's source-in tint stays off the report canvas", () => {
  // 'source-in' composites against everything already on the target canvas,
  // so tinting inline would wipe the white background and every shape drawn
  // before the camera -- save()/restore() does not scope it. This is what
  // once erased an entire floor-plan export.
  const r = renderReport(SETUP, scene([still()]));
  const tinting = r.ops.filter(o => o.ctxId !== 0 && o.op === 'fillRect');
  assert.ok(tinting.length > 0, 'the tint happened');
  assert.equal(r.snapshotOps.filter(o => o.op === 'fillRect').length, 1,
    'the report canvas only ever fillRects its own white background');
});

test('each camera is tinted in its own colour, not one shared silhouette', () => {
  // Cached per colour AND size: a single-slot cache would hand the second
  // camera the first one's tint.
  const r = renderReport(SETUP, scene([still(), still({ id: 'c', name: 'Cam C', color: '#7fd08c' })]));
  const tints = new Set(r.ops.filter(o => o.ctxId !== 0 && o.op === 'fillRect').map(o => o.fillStyle));
  assert.deepEqual([...tints].sort(), ['#7fd08c', '#ff9f4d']);
});

test('a recorded move is drawn as a path with Start and End', () => {
  const r = renderReport(SETUP, scene([recorded()]));
  assert.ok(r.texts.includes('Start'), 'start marked');
  assert.ok(r.texts.includes('End'), 'end marked');
  // Specifically the PATH, not just "something was stroked" -- the wall and
  // the camera wedges stroke too, so a plain stroke count passes even with the
  // path removed. The dash is the report's own mark for a movement, and the
  // path is the only thing that ever sets one. Counted loosely because the
  // recording stub's restore() is a no-op, so the dash leaks onto the endpoint
  // wedges stroked after it; what is being asserted is that a dash was set at
  // all, which happens only if the path was drawn.
  assert.ok(r.dashedStrokes.length > 0, 'the path itself is drawn');
  // The caption is never dropped: with several camera positions it is the
  // only thing saying which path belongs to which camera.
  assert.ok(r.texts.includes('Cam A'), 'the move is still captioned');
});

test('a camera that moved is drawn as the move alone, not also at rest', () => {
  const moved = renderReport(SETUP, scene([recorded()]));
  const rest = renderReport(SETUP, scene([still()]));
  // Same rule as the PNG: the stored position IS where the move finished, so
  // a static mark there reads as a second camera at a position that no longer
  // means anything. Two endpoint wedges for the move, one wedge at rest.
  assert.equal(moved.icons.length, 2, 'Start and End only');
  assert.equal(rest.icons.length, 1, 'a still camera is one mark');
});

test('endpoints missing degrades to the plain camera, not an unlabelled line', () => {
  // A hand-edited setup can carry a path without the pair of endpoints
  // liveRecording.js always writes alongside it.
  const r = renderReport(SETUP, scene([recorded({ trailEndpoints: null })]));
  assert.ok(!r.texts.includes('Start'));
  assert.ok(r.texts.includes('Cam A'), 'still named');
  assert.equal(r.icons.length, 1, 'drawn as an ordinary camera');
});

test('a camera at rest draws no path', () => {
  const r = renderReport(SETUP, scene([still()]));
  assert.equal(r.dashedStrokes.length, 0, 'nothing to draw a path for');
});

test('a camera hidden on the canvas is still on the printed layout', () => {
  // Hide declutters the SCREEN. The report is a deliverable, like the PNG and
  // the CSV, so leaving a camera out of it would drop it from what the crew
  // works from with nothing on the page to say so.
  const r = renderReport(SETUP, scene([still({ hidden: true })]));
  assert.ok(r.texts.includes('Cam B'));
});

test('several camera positions are each drawn and named', () => {
  const r = renderReport(SETUP, scene([recorded(), still()]));
  assert.ok(r.texts.includes('Cam A'));
  assert.ok(r.texts.includes('Cam B'));
});

// --- labels on a crowded plan --------------------------------------------

// Two camera positions almost on top of each other: four labels wanting the
// same square inch. This is what a real scene looks like when a layout is
// shot from several nearby positions, and drawn where each label naturally
// falls they overprint into an unreadable stack.
const CROWDED = [
  still({ id: 'p', name: 'Near A', x: 2, y: 2, color: '#4da6ff' }),
  still({ id: 'q', name: 'Near B', x: 2.05, y: 2.05, color: '#7fd08c' })
];

test('labels that would collide are pushed apart', () => {
  const r = renderReport(SETUP, scene(CROWDED));
  const at = name => r.snapshotOps.find(o => o.op === 'fillText' && o.text === name);
  const a = at('Near A'), b = at('Near B');
  assert.ok(a && b, 'both are still drawn');
  // Their icons are a few centimetres apart, so untouched their names would
  // land within a line-height of each other.
  assert.ok(Math.abs(a.y - b.y) >= 15, 'separated by at least a line');
});

test("a camera's name and its lens line stay together", () => {
  // Moved as one block: split, a lens reading ends up under someone else's
  // name, which is worse than an overlap because it looks correct.
  const r = renderReport(SETUP, scene(CROWDED));
  const at = t => r.snapshotOps.find(o => o.op === 'fillText' && o.text === t);
  const name = at('Near A');
  const lens = r.snapshotOps.find(o => o.op === 'fillText' && o.text && o.text.includes('Lens: 50mm'));
  assert.ok(name && lens);
  assert.equal(lens.y - name.y, 15, 'directly under its own name');
  assert.equal(lens.x, name.x, 'and on the same centre');
});

test('every label is haloed so it reads over whatever it lands on', () => {
  const r = renderReport(SETUP, scene([still()]));
  const haloed = r.snapshotOps.filter(o => o.op === 'strokeText').map(o => o.text);
  assert.ok(haloed.includes('Cam B'), 'the name is haloed');
  assert.equal(haloed.length, r.texts.length, 'every drawn label is');
});

test('prop names are placed first, so they are never the ones that move', () => {
  // Priority decides who gives way: props anchor the plan, camera names move
  // around them, Start/End give way to both. Labels are placed in that order
  // and the first placed is never nudged, so the ORDER is the rule -- which is
  // what this asserts.
  //
  // Not asserted by comparing pixel positions with and without the camera:
  // the report frames itself on its content, so adding a camera moves the
  // vertical bounds and every label with them. That comparison would be
  // between two framings, not two placements -- see CLAUDE.md.
  const table = { name: 'Table', shape: 'rect', widthM: 1, depthM: 0.6, heightM: 1,
    x: 2, y: 2, rotationDeg: 0, color: '#c98bdb' };
  const r = renderReport(SETUP, { name: 'P', props: [table], cameras: [recorded()] });

  const order = r.snapshotOps.filter(o => o.op === 'fillText').map(o => o.text);
  const at = t => order.indexOf(t);
  assert.ok(at('Table') >= 0 && at('Cam A') >= 0 && at('Start') >= 0, 'all present');
  assert.ok(at('Table') < at('Cam A'), 'the prop name is placed before the camera name');
  assert.ok(at('Cam A') < at('Start'), 'and the camera name before its endpoints');
});
