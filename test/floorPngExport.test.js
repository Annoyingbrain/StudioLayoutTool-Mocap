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

// The on-screen canvas hides these; this file must not. The whole reason
// hiding is safe to offer is that the exported plan is unaffected -- if that
// stops being true, hiding silently drops a camera from what the crew shoots
// from, and nothing about the PNG says a camera is missing.
test('a camera hidden on the canvas is still drawn on the export', () => {
  const r = renderFloorPng(SETUP, scene([Object.assign({}, still, { hidden: true })]));
  assert.equal(r.icons.length, 1, 'hiding is a canvas-only setting');
  assert.equal(r.redDots.length, 1);
  assert.ok(r.texts.includes('Cam B'), 'still captioned');
});

test('hiding every camera still exports every camera', () => {
  const r = renderFloorPng(SETUP, scene([
    Object.assign({}, still, { hidden: true }),
    recorded({ hidden: true })
  ]));
  assert.ok(r.texts.includes('Cam B'), 'the still camera survived');
  assert.ok(r.texts.includes('Cam A'), 'the recorded one did too');
  assert.ok(r.strokes.length > 0, 'and its path is drawn');
});

// The props-only variant. Worth pinning because "no cameras" has three
// separate pieces to it -- the icons, the recorded paths and the captions --
// each drawn by its own pass, so leaving one behind produces a plan with,
// say, unexplained dashed lines on it and nothing to say what drove them.
const PROP = { id: 'p', name: 'Riser', shape: 'rect', x: 2, y: 2, widthM: 1, depthM: 1, rotationDeg: 0 };
const propsOnly = { cameras: false };

test('props only: no camera icons, paths or captions, but the props remain', () => {
  const full = renderFloorPng(SETUP, { name: 'Position 1', props: [PROP], cameras: [still, recorded()] });
  const r = renderFloorPng(SETUP, { name: 'Position 1', props: [PROP], cameras: [still, recorded()] }, propsOnly);

  // The fixture has to actually contain the things being excluded, or this
  // passes against a scene that never had them.
  assert.ok(full.icons.length > 0 && full.strokes.length > 0 && full.texts.includes('Cam A'),
    'fixture really does draw cameras when they are asked for');

  assert.equal(r.icons.length, 0, 'no camera icons -- static or endpoint');
  assert.equal(r.strokes.length, 0, 'no recorded path');
  assert.ok(!r.texts.includes('Cam A') && !r.texts.includes('Cam B'), 'no camera captions');
  assert.ok(!r.texts.includes('Start') && !r.texts.includes('End'), 'no endpoint markers');

  // A camera's red centre dot goes, a prop's does not: the prop marker is
  // what Disguise lines the physical piece up against, which is the entire
  // point of this variant.
  assert.equal(r.redDots.length, 1, 'the prop keeps its centre marker');
  assert.ok(r.texts.includes('Riser'), 'and its name');
});

test('props only says so on the image', () => {
  const scn = { name: 'Position 1', props: [PROP], cameras: [still] };
  assert.ok(renderFloorPng(SETUP, scn, propsOnly).texts.some(t => t && t.includes('props only')),
    'the heading names the variant, since the filename is not visible in Disguise');
  assert.ok(!renderFloorPng(SETUP, scn).texts.some(t => t && t.includes('props only')),
    'and the full plan does not claim to be one');
});

// --- label collisions ---------------------------------------------------
//
// Cameras get parked right up against the props they are shooting, which is
// how the shot was set up and not something to design away -- so on a real
// plan (Dining room 31) a name, a lens line, a Start and an End all landed in
// the same square inch and overprinted into something unreadable, with some
// labels sitting white-on-white over a prop and vanishing entirely.
//
// Comparing a label's position BETWEEN two renders is legal in this file, and
// worth stating because it is not legal in test/reportExport.test.js: the
// report frames itself on its own content, so adding an entity rescales
// everything. This export's bounds come from the studio floor alone
// (floorBoundsDisguise), so the same entity lands on the same pixel whatever
// else is in the scene.
const LINE_H = 36; // js/floorPngExport.js's LABEL_LINE_H

const near = over => Object.assign({
  id: 'x', name: 'Cam X', x: 6, y: 3, rotationDeg: 0, color: '#4da6ff',
  focalLengthMm: 50, heightM: 1.2, trail: null, trailEndpoints: null
}, over);

const labelY = (r, text) => r.caption(text).y;

test('two cameras close enough to collide have their captions separated', () => {
  const a = near({ id: 'a', name: 'Cam A', x: 6, y: 3 });
  const b = near({ id: 'b', name: 'Cam B', x: 6, y: 2.95 });

  // The fixture has to be a genuine collision, or this passes while testing
  // nothing: drawn where they naturally fall these two are 12px apart, well
  // inside one two-line label's 72px height.
  const soloA = labelY(renderFloorPng(SETUP, scene([a])), 'Cam A');
  const soloB = labelY(renderFloorPng(SETUP, scene([b])), 'Cam B');
  assert.ok(Math.abs(soloA - soloB) < 2 * LINE_H,
    `fixture is not a collision: natural positions ${soloA} and ${soloB}`);

  const both = renderFloorPng(SETUP, scene([a, b]));
  assert.equal(labelY(both, 'Cam A'), soloA, 'the first placed does not move');
  assert.ok(Math.abs(labelY(both, 'Cam B') - labelY(both, 'Cam A')) >= 2 * LINE_H,
    'the second is nudged clear of it -- two lines, since each label is two lines tall');
});

test("a camera's name and lens line move together as one block", () => {
  // Split into two items they are placed independently, and a lens reading
  // ends up under someone else's name -- worse than an overlap, because it
  // looks correct.
  const a = near({ id: 'a', name: 'Cam A', x: 6, y: 3 });
  const b = near({ id: 'b', name: 'Cam B', x: 6, y: 2.95, focalLengthMm: 85 });
  const r = renderFloorPng(SETUP, scene([a, b]));

  const nameY = labelY(r, 'Cam B');
  const lens = r.exportOps.find(o => o.op === 'fillText' && o.text && o.text.includes('85mm'));
  assert.ok(lens, 'the nudged camera kept its lens line');
  assert.equal(lens.y, nameY + LINE_H, 'directly under its own name, having moved with it');
  assert.equal(lens.x, r.caption('Cam B').x, 'and on the same centre');
});

test('a prop label never gives way to a camera label', () => {
  // Props anchor the plan, so the camera label is the one that moves.
  const prop = { id: 'p', name: 'Riser', shape: 'rect', x: 6, y: 3, widthM: 1, depthM: 1, rotationDeg: 0 };
  const a = near({ id: 'a', name: 'Cam A', x: 6, y: 3.25 });

  const soloProp = labelY(renderFloorPng(SETUP, { name: 'Position 1', props: [prop], cameras: [] }), 'Riser');
  const soloCam = labelY(renderFloorPng(SETUP, scene([a])), 'Cam A');
  assert.ok(Math.abs(soloProp - soloCam) < LINE_H,
    `fixture is not a collision: natural positions ${soloProp} and ${soloCam}`);

  const r = renderFloorPng(SETUP, { name: 'Position 1', props: [prop], cameras: [a] });
  assert.equal(labelY(r, 'Riser'), soloProp, 'the prop label stayed exactly where it was');
  assert.ok(labelY(r, 'Cam A') > soloCam, 'the camera label is what moved');
});

test('every label is haloed, so one landing on a white prop still reads', () => {
  // Props are solid white fills and the text is white, so without an outline
  // a label over a prop is invisible rather than merely cluttered. Black here,
  // the opposite of the report's white halo, because this export is white on
  // black -- on the background it costs nothing, on a prop it is the only
  // thing separating the letters from the fill.
  const prop = { id: 'p', name: 'Riser', shape: 'rect', x: 6, y: 3, widthM: 1, depthM: 1, rotationDeg: 0 };
  const r = renderFloorPng(SETUP, { name: 'Position 1', props: [prop], cameras: [recorded()] });

  const haloes = r.exportOps.filter(o => o.op === 'strokeText');
  assert.ok(haloes.length > 0, 'labels are haloed at all');
  assert.ok(haloes.every(h => h.strokeStyle === '#000000'), 'in black, against the white fills');

  ['Riser', 'Cam A', 'Start', 'End'].forEach(text => {
    const fill = r.exportOps.find(o => o.op === 'fillText' && o.text === text);
    const halo = haloes.find(h => h.text === text);
    assert.ok(halo, `${text} is haloed`);
    assert.equal(halo.x, fill.x, `${text}'s halo is under its fill`);
    assert.equal(halo.y, fill.y);
  });
});

test('labels are drawn after every icon and path, not interleaved with them', () => {
  // Placing them last is what puts them on top of whatever they land on --
  // drawn as each entity is drawn, a later prop fill covers an earlier label.
  const prop = { id: 'p', name: 'Riser', shape: 'rect', x: 6, y: 3, widthM: 1, depthM: 1, rotationDeg: 0 };
  const r = renderFloorPng(SETUP, { name: 'Position 1', props: [prop], cameras: [recorded(), still] });

  const lastDrawing = r.exportOps.map((o, i) => ({ o, i }))
    .filter(({ o }) => o.op === 'fill' || o.op === 'stroke' || o.op === 'drawImage')
    .map(({ i }) => i).pop();
  const firstLabel = r.exportOps.findIndex(o => o.op === 'fillText' && o.text === 'Riser');
  assert.ok(firstLabel > lastDrawing,
    'the first label comes after the last icon/path/fill');
});

// --- per-camera colour --------------------------------------------------
//
// Everything in this export used to be white, which made a camera parked on
// top of a prop invisible: white icon, white fill, nothing to separate them.
// Cameras, their paths and their captions now carry the same colour they have
// on screen. Props stay white, because that silhouette is what Disguise lines
// the real piece up against.
//
// The tint happens on a SCRATCH canvas (ctxId !== 0), so the colour is
// asserted on the fillRect that recolours the icon, not on the drawImage that
// stamps it onto the export.
const tints = r => r.ops.filter(o => o.op === 'fillRect' && o.ctxId !== 0).map(o => o.fillStyle);

test("a camera's icon, path and caption are drawn in its own colour", () => {
  const r = renderFloorPng(SETUP, scene([recorded()]));   // Cam A is #4da6ff

  assert.ok(tints(r).includes('#4da6ff'), 'the icon is tinted to the camera colour');
  assert.equal(r.caption('Cam A').fillStyle, '#4da6ff', 'the name is in it too');
  const lens = r.exportOps.find(o => o.op === 'fillText' && o.text && o.text.includes('35mm'));
  assert.equal(lens.fillStyle, '#4da6ff', 'and the lens line');
  assert.ok(r.strokes.some(o => o.strokeStyle === '#4da6ff'), 'and the recorded path');

  // Start/End belong to that camera as much as the caption does.
  assert.equal(r.exportOps.find(o => o.op === 'fillText' && o.text === 'Start').fillStyle, '#4da6ff');
});

test('two cameras keep two different colours', () => {
  // Guards the icon tint cache, which is keyed on colour AND size: keyed on
  // size alone (which it was, back when every icon was white) the second
  // camera gets served the first one's tinted icon.
  const r = renderFloorPng(SETUP, scene([still, recorded()]));  // #ff9f4d, #4da6ff

  assert.ok(tints(r).includes('#ff9f4d'), 'the first camera kept its colour');
  assert.ok(tints(r).includes('#4da6ff'), 'the second got its own, not a cache hit on the first');
  assert.equal(r.caption('Cam B').fillStyle, '#ff9f4d');
  assert.equal(r.caption('Cam A').fillStyle, '#4da6ff');
});

test('props stay white -- that silhouette is what Disguise aligns to', () => {
  const prop = { id: 'p', name: 'Riser', shape: 'rect', x: 6, y: 3, widthM: 1, depthM: 1, rotationDeg: 0 };
  const r = renderFloorPng(SETUP, { name: 'Position 1', props: [prop], cameras: [recorded()] });

  const propFill = r.exportOps.find(o => o.op === 'fill' && o.fillStyle === '#ffffff');
  assert.ok(propFill, 'the footprint is a solid white fill');
  assert.equal(r.caption('Riser').fillStyle, '#ffffff', 'and its name is white, like the footprint');
  assert.equal(r.redDots.length, 1, 'the red centre marker is untouched by any of this');
});

test('a camera saved without a colour falls back to white', () => {
  // An old setup degrades to exactly what this export drew before there was
  // any colour in it, rather than to something invisible.
  const r = renderFloorPng(SETUP, scene([Object.assign({}, still, { color: undefined })]));
  assert.ok(tints(r).includes('#ffffff'), 'icon tinted white');
  assert.equal(r.caption('Cam B').fillStyle, '#ffffff', 'caption white');
});

test('the shoot day is printed on the plan when there is one', () => {
  // Two days of the same position differ only by where the cameras are --
  // exactly what someone holding the wrong day's plan would not notice. The
  // day is in the filename too, but a layer in Disguise shows no filename.
  const withDay = renderFloorPng(SETUP, Object.assign(scene([still]), { dayName: 'Day 2' }));
  assert.ok(withDay.texts.some(t => t && t.includes('Day 2')), 'named in the heading');

  // A scene with no day (a raw scene, an older caller) omits it rather than
  // printing an empty dash.
  const without = renderFloorPng(SETUP, scene([still]));
  const heading = without.texts.find(t => t && t.includes('Position: Position 1'));
  assert.ok(!heading.includes('—  '), `stray separator in "${heading}"`);
});
