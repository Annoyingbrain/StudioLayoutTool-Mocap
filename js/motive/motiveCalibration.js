// Wand calibration: how far past the marker line's tip-end the physical
// touch-tip actually is (js/motive/wandTip.js). This is a single real-world
// measurement (ruler, once) -- there's no way to derive it from tracking
// data alone. Defaults to 0 (tip = the endpoint marker itself) until set via
// the "Wand tip extension" input in the Motive capture panel
// (js/ui/motiveCapture.js) -- captured positions are NOT trustworthy until
// this is measured and set correctly.
window.App = window.App || {};

App.motiveCalibration = {
  tipExtensionMm: 0
};
