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
  // rotation computed from that quaternion to match reality. Defaults to 0
  // (uncalibrated) -- to calibrate: point the tracked object at a known
  // heading, then adjust this until the live-updated rotation on screen
  // matches. Uncalibrated live rotation should not be trusted.
  liveRotationOffsetDeg: 0,

  // Which of the rigid body's own local axes points "forward" (the way the
  // camera looks / the prop faces). Set when the asset was created in
  // Motive, so it varies per asset and can't be derived from the data.
  //
  // This matters more than the offset above: if it's wrong, the heading is
  // not merely rotated by a constant -- it's derived from the horizontal
  // projection of a near-vertical axis, which is unstable nonsense, and the
  // tilt reads ~90 degrees with the object level. Symptom to watch for:
  // rotation jitters wildly or tilt sits near +/-90 when the camera is
  // level. Default '+y' matches this app's own local-frame convention;
  // Motive's default rigid body orientation often makes '+z' correct
  // instead (with Motive's Y being up, a level forward axis is horizontal).
  liveForwardAxis: '+y' // '+x' | '-x' | '+y' | '-y' | '+z' | '-z'
};
