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
  // rotation computed from that quaternion to match reality. This is the
  // FIXED, derived calibration constant -- not the Live Tracking panel's
  // offset field (liveRotationUserOffsetDeg below), which is a separate,
  // day-to-day adjustment ON TOP of this one, deliberately kept at 0 by
  // default so it always starts from "the calibrated baseline" rather than
  // silently carrying a leftover value from the last placement. To
  // recalibrate the baseline itself: point the tracked object at a known
  // heading and change THIS constant (in code) until, with the panel's
  // offset field at 0, the live-updated rotation matches (or use
  // motive_axis_calibrate.py -- see the note on liveForwardAxis below).
  //
  // Calibrated 2026-08-15 against "Camera Tracker" (the general-purpose
  // production camera rigid body -- 3 markers, marker 1 forward, markers
  // 2/3 right/left): with liveForwardAxis '+z', flat on the floor and
  // pointed at the wall's known floor-center target, the raw heading read
  // 9.6 degrees against the app's "facing the wall = rotationDeg 0"
  // convention (js/utils/geometry.js's ROTATION CONVENTION note) -- so -9.6
  // corrects it to 0. Confirmed live: flat/aligned reads rotation 0, tilt 0,
  // and tilt tracks smoothly through a real dip.
  //
  // An automated first pass with motive_axis_calibrate.py got this WRONG
  // ('-y' / +17.4) -- see that script's header and the IMPORTANT note below
  // for why, and don't trust that tool's plain (non---gate-axis) output
  // without a live hands-on check afterward.
  liveRotationCalibratedOffsetDeg: -9.6,

  // Live Tracking panel's "Live rotation offset" field -- a day-to-day
  // adjustment ADDED ON TOP OF liveRotationCalibratedOffsetDeg above, not a
  // replacement for it. Kept at 0 by default (and reset to 0 whenever the
  // browser has no saved value under THIS name -- named differently from
  // the pre-2026-08-15 single "liveRotationOffsetDeg" field on purpose, so
  // an old browser's saved -9.6 for that name doesn't get loaded here too
  // and silently double up with the new liveRotationCalibratedOffsetDeg
  // above) so "0" always means "trust the calibrated baseline as-is" --
  // re-placing the tracker by hand naturally lands a few degrees off each
  // time (three placements in one 2026-08-15 session read 0, -11.8, and
  // +10 with this at 0), and that placement noise shouldn't get chased
  // into a stored offset. Only change this for a REAL, repeated
  // discrepancy you want to correct going forward, not a one-off reading.
  liveRotationUserOffsetDeg: 0,

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
  // both read ~0 at rest, and a rotation offset can make either one's
  // heading match a known target by coincidence. And a "biggest tilt
  // range across a recorded capture" check ALSO isn't reliable if the
  // motion during capture wasn't a clean, bounded pitch -- a real hand-held
  // motion that overshoots past the natural +/-90 range can make even the
  // object's genuine UP axis show a wide swing (it traces a fixed relation
  // to the true forward axis's own angle, not a flat line, so it isn't
  // exempt just because it isn't forward). Both traps bit Camera Tracker's
  // calibration on 2026-08-15: '-y' looked correct by the automated
  // capture's range and offset numbers, but was actually the UP axis --
  // caught only by live hands-on testing (flat: -89 tilt; pointed straight
  // up: tilt back near 0 -- a "tent" pattern that's the up axis's
  // signature, not forward's).
  //
  // Reliable checks, in order: (1) flat and level, tilt should read ~0 for
  // BOTH candidate horizontal axes (rules out the up axis only). (2) pitch
  // the object AS FAR AS YOU PHYSICALLY CAN towards vertical and compare
  // candidates directly -- true forward approaches +/-90, true side/roll
  // stays small, and doing this live rather than mining a recording avoids
  // both traps above. motive_axis_calibrate.py's --gate-axis option
  // (once you know a reliable up/down axis) can help narrow candidates
  // from an existing capture, but treat its output as a lead to verify
  // live, not a final answer.
  //
  // Calibrated 2026-08-15 against Camera Tracker via live hands-on testing:
  // flat and level, '+x'/'-x'/'+z'/'-z' all read ~0 tilt ('+y' read -89.5,
  // confirming it as the up axis). Pointed as close to straight up as
  // physically achievable, '+z'/'-z' reached +78.5/-78.7 while '+x'/'-x'
  // only reached ~11 -- '+z' is forward. This is a property of Camera
  // Tracker's own local frame as Motive assigned it at creation time, not a
  // general rule -- a differently-created rigid body needs its own check.
  liveForwardAxis: '+z', // '+x' | '-x' | '+y' | '-y' | '+z' | '-z'

  // Added to a live camera's computed heightM (see js/motive/liveTracking.js's
  // applyToEntity). App.motiveTransform.FLOOR_BASELINE_MM (the raw Motive Y
  // that means real floor level) was derived from reference-tracker MARKER
  // positions, not a rigid body's own solved pivot -- for an asset whose
  // pivot sits somewhere other than exactly at its markers' plane, height
  // reads off by a constant even at true floor level. This corrects that,
  // the same way liveRotationCalibratedOffsetDeg corrects a constant
  // heading error.
  //
  // Calibrated 2026-08-15 against Camera Tracker: markers flush on the
  // floor (no physical standoff) read heightM -0.01 with this at 0 --
  // +0.01 corrects it to 0.
  liveHeightOffsetM: 0.01
};
