// Wand calibration: how far past the marker line's tip-end the physical
// touch-tip actually is (js/motive/wandTip.js). This is a single real-world
// measurement (ruler, once) -- there's no way to derive it from tracking
// data alone. Defaults to 0 (tip = the endpoint marker itself) until set via
// the "Wand tip extension" input in the Motive capture panel
// (js/ui/motiveCapture.js) -- captured positions are NOT trustworthy until
// this is measured and set correctly.
window.App = window.App || {};

App.motiveCalibration = {
  tipExtensionMm: 0,

  // Live tracking only (js/motive/liveTracking.js): a rigid body's
  // orientation comes live as a raw Motive quaternion. Which of that
  // quaternion's local axes counts as the tracked object's "forward" is
  // whatever axis was chosen when the rigid body asset was created in
  // Motive -- NOT something this app can know or derive from tracking data
  // alone (unlike the CSV T-bar/camera-marker capture flows, which infer
  // orientation from known physical marker geometry instead of trusting
  // Motive's own rigid-body solve). This offset corrects the app-world
  // rotation computed from that quaternion to match reality. Defaults to 0
  // (uncalibrated) -- to calibrate: point the tracked object at a known
  // heading, then adjust this until the live-updated rotation on screen
  // matches. Uncalibrated live rotation should not be trusted.
  liveRotationOffsetDeg: 0
};
