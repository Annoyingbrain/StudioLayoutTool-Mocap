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
  liveRotationOffsetDeg: 0
};
