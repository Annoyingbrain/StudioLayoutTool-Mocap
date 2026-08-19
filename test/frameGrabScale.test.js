// js/utils/dom.js -- the sizing behind frame-grab downscaling on import.
//
// A frame grab is stored as a base64 data URL INSIDE the setup's JSON, so its
// file size is the setup's file size (times 1.33 for the base64). Nine
// full-resolution stills took one setup to 72MB, at which point GitHub's
// contents API refuses the backup outright (422, "the file is too large to be
// processed") and every save, load and device sync is carrying it.
//
// The scaling itself needs a canvas and an <img> decode, neither of which
// exists here -- but the arithmetic that decides the output size is pure, and
// it is where the two things worth pinning live: the aspect ratio has to
// survive, and a small grab must never be enlarged.
const { test } = require('node:test');
const assert = require('node:assert');
const { createSidebar } = require('./helpers/appContext');

const dom = createSidebar().App.dom;
const fit = (w, h, max) => dom.fitWithin(w, h, max === undefined ? dom.FRAME_GRAB_MAX_PX : max);

test('a big grab is scaled to the long edge, keeping its aspect ratio', () => {
  // A 4K-ish still landscape, the shape a camera actually delivers.
  const r = fit(3840, 2160);
  assert.equal(r.width, 1920);
  assert.equal(r.height, 1080);
});

test('portrait scales on ITS long edge, which is the height', () => {
  const r = fit(2160, 3840);
  assert.equal(r.height, 1920);
  assert.equal(r.width, 1080);
});

test('a grab smaller than the box is left alone, never enlarged', () => {
  // Enlarging spends bytes on pixels that carry no detail -- the opposite of
  // the point -- so the factor is capped at 1 rather than just applied.
  const r = fit(800, 600);
  assert.deepEqual(r, { width: 800, height: 600 });
});

test('a grab exactly the size of the box is untouched', () => {
  assert.deepEqual(fit(1920, 1080), { width: 1920, height: 1080 });
});

test('the box is big enough to print, small enough to store', () => {
  // Both ends matter. Below ~1200 the report's page-width figure softens;
  // above ~2500 the saving stops being the point of the exercise.
  assert.ok(dom.FRAME_GRAB_MAX_PX >= 1200 && dom.FRAME_GRAB_MAX_PX <= 2500);
  assert.ok(dom.FRAME_GRAB_QUALITY >= 0.7 && dom.FRAME_GRAB_QUALITY <= 0.9);
});
