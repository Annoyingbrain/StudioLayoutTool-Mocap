// Calibration values for live Motive tracking that can't be derived from
// tracking data alone -- they describe physical/authoring choices and have
// to be set once by hand.
window.App = window.App || {};

App.motiveCalibration = {
  // A rigid body's orientation comes live as a raw Motive quaternion.
  // Which of that quaternion's local axes counts as the tracked object's
  // "forward" is whatever axis was chosen when the rigid body asset was
  // created in Motive -- NOT something this app can know or derive from
  // tracking data alone. This offset corrects the app-world
  // rotation computed from that quaternion to match reality. To recalibrate:
  // point the tracked object at a known heading, then adjust this until the
  // live-updated rotation on screen matches (or use
  // motive_axis_calibrate.py -- see the note on liveForwardAxis below).
  //
  // Calibrated 2026-08-15 against the "Arrow" T-bar reference tracker (see
  // Reference trackers/) using motive_axis_calibrate.py: with liveForwardAxis
  // '-z', the tracker's still-heading while flat and pointed at the wall's
  // known floor-center target (app rotationDeg 180, see
  // js/motive/motiveTransform.js's header) read 179.5 degrees.
  liveRotationOffsetDeg: 0.5,

  // Which of the rigid body's own local axes points "forward" (the way the
  // camera looks / the prop faces). Set when the asset was created in
  // Motive, so it varies per asset and can't be derived from the data.
  //
  // This matters more than the offset above: if it's wrong, the heading is
  // not merely rotated by a constant -- it's derived from the horizontal
  // projection of a near-vertical axis, which is unstable nonsense, and the
  // tilt reads ~90 degrees with the object level. Symptom to watch for:
  // rotation jitters wildly or tilt sits near +/-90 when the camera is
  // level.
  //
  // IMPORTANT: a single static "tilt reads ~0 while level" check cannot
  // tell forward from the object's OTHER horizontal (side/roll) axis --
  // both read ~0 at rest, and liveRotationOffsetDeg above can make either
  // one's heading match a known target by coincidence. Only a DYNAMIC test
  // (moving the object through the rotation you care about and watching
  // which axis's tilt actually swings) distinguishes them -- rotating an
  // axis about itself leaves that axis unchanged, so the wrong axis will
  // look falsely stable. motive_axis_calibrate.py (repo root) automates
  // this: it records live frames while you move the tracker and reports the
  // tilt range for all six axis candidates at once, from one capture.
  //
  // Calibrated 2026-08-15 against the "Arrow" T-bar reference tracker: '-z'
  // swung the full ~180 degrees (-89.9 to +89.9) while '+x'/'-x' only moved
  // ~20 degrees and '+y'/'-y' ~122 degrees for the same motion, and live
  // testing on real hardware confirmed tilt reads ~+89/-88 at the physical
  // up/down extremes. This is a property of THIS asset's local frame as
  // Motive assigned it at creation time, not a general rule -- a
  // differently-created rigid body (e.g. an actual production camera asset,
  // if built separately from this reference tracker) may need its own
  // check, ideally re-run with motive_axis_calibrate.py against that asset.
  liveForwardAxis: '-z' // '+x' | '-x' | '+y' | '-y' | '+z' | '-z'
};
