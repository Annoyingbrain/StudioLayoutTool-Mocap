// js/motive/liveRecording.js -- what gets kept when a camera move is recorded.
//
// The thresholds ARE the behaviour here. A camera standing still is not still
// in the data: the solve jitters, so consecutive frames differ in the last
// decimal place. Testing on "did anything change?" was true 30 times a second
// whether or not the camera had moved, and a short nudge could exhaust all 400
// points of the path on a blob at each end. Too high a threshold instead
// throws away a real push-in, so both ends of the range are pinned below.
const { test } = require('node:test');
const assert = require('node:assert');
const { createSidebar } = require('./helpers/appContext');

const moved = createSidebar().App.liveRecording.movedEnough;
const at = (x, y, rotationDeg) => ({ x, y, rotationDeg: rotationDeg || 0 });

test('the first sample is always kept', () => {
  assert.equal(moved(null, at(1, 1)), true);
});

test('a parked camera records nothing', () => {
  const parked = at(2, 3, 90);
  // Solve noise, in the last decimal place of a metre.
  assert.equal(moved(parked, at(2.0004, 2.9997, 90.1)), false);
  assert.equal(moved(parked, at(2.0009, 3.0009, 89.85)), false);
  // A settled body holds heading to sd 0.15 degrees, so even a full degree of
  // wander is still the camera standing still.
  assert.equal(moved(parked, at(2, 3, 91)), false);
});

test('a real move is kept', () => {
  const from = at(2, 3, 90);
  assert.equal(moved(from, at(2.5, 3, 90)), true, 'half a metre');
  assert.equal(moved(from, at(2, 3.05, 90)), true, '5cm');
  assert.equal(moved(from, at(2.03, 3, 90)), true, '3cm');
});

test('a camera panned on the spot counts as movement', () => {
  // The trail stores only x/y, but trailEndpoints carry the heading at each
  // end -- so a pan with no translation is a real thing to record, and
  // testing position alone would discard it.
  assert.equal(moved(at(2, 3, 0), at(2, 3, 45)), true);
});

test('drift is measured from the last KEPT sample, not the last frame', () => {
  // Each step is under the threshold; frame-to-frame comparison would let
  // every one of them through and rebuild the blob this exists to prevent.
  const kept = at(0, 0, 0);
  let p = kept;
  for (let i = 0; i < 5; i++) {
    p = at(p.x + 0.005, p.y, 0);
    // Against the previous FRAME each step looks like nothing...
    assert.equal(moved(at(p.x - 0.005, p.y, 0), p), false);
  }
  // ...but against the last kept sample the accumulated drift is real, and
  // that is what sample() compares.
  assert.equal(moved(kept, p), true, '5 x 5mm is 2.5cm and should be kept');
});

test('the threshold sits well clear of the noise floor either way', () => {
  const origin = at(0, 0, 0);
  assert.equal(moved(origin, at(0.001, 0.001, 0)), false, '1mm is noise');
  assert.equal(moved(origin, at(0.1, 0, 0)), true, '10cm is a move');
});

// --- what a finished recording amounts to --------------------------------
//
// outcomeOf is the decision stop() acts on, kept pure so it can be tested
// without a live Motive feed.

const outcomeOf = createSidebar().App.liveRecording.outcomeOf;

test('a camera that never moved still records where it is', () => {
  // The point of recording a parked camera: it IS somewhere, that position is
  // tracked, and it is what belongs on the plan.
  const o = outcomeOf([at(3, 4, 90)]);
  assert.equal(o.kind, 'static');
  assert.deepEqual(o.at, at(3, 4, 90));
});

test('recording a parked camera clears the path it used to have', () => {
  const ui = createSidebar();
  const camera = ui.cameras()[0];
  ui.App.Store.updateCamera(camera.id, {
    trail: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    trailEndpoints: { start: at(0, 0), end: at(1, 1) }
  });

  // The old path would otherwise go on showing a move this camera is no
  // longer making, and there would be no way to say "it sits here now".
  ui.App.liveRecording.applyOutcome(camera.id, { kind: 'static', at: at(3, 4, 0) });

  assert.equal(ui.cameras()[0].trail, null);
  assert.equal(ui.cameras()[0].trailEndpoints, null);
});

test('a real move becomes a path with both endpoints', () => {
  const o = outcomeOf([at(0, 0, 0), at(1, 0, 10), at(2, 0, 20)]);
  assert.equal(o.kind, 'move');
  assert.equal(o.trail.length, 3);
  assert.deepEqual(o.trailEndpoints.start, at(0, 0, 0));
  assert.deepEqual(o.trailEndpoints.end, at(2, 0, 20));
});

test('a long move is thinned but keeps its true ends', () => {
  const many = [];
  for (let i = 0; i < 1200; i++) many.push(at(i / 100, 0, 0));
  const o = outcomeOf(many);
  assert.equal(o.trail.length, 400, 'thinned to the cap');
  assert.deepEqual(o.trailEndpoints.start, at(0, 0, 0));
  assert.deepEqual(o.trailEndpoints.end, at(11.99, 0, 0));
});

test('never being tracked is not the same as never moving', () => {
  // Nothing was captured at all, so there is nothing to say about where the
  // camera is -- distinct from "it is parked here", and reported differently.
  assert.equal(outcomeOf([]).kind, 'none');
});
