// Converts a wand tip position from Motive's global coordinate space (mm)
// into this app's internal world space (meters, floor-plane X/Y).
//
// Calibrated 2026-08-14 from two reference-tracker captures placed at known
// studio locations (Reference trackers/Triangle.csv, Reference trackers/
// T-bar.csv) -- see fixtures/verify_reference_trackers.py for the derivation
// and how to redo this (e.g. after a mocap volume re-calibration). Triangle
// and T-bar were both placed at the studio's true floor center: 4.5m
// straight out from the LED wall's "north point" -- confirmed to be exactly
// js/studioSketch.js's "Center" suggestedReferencePoint, (5.975, -8.818) --
// at the same horizontal (x) position (a visual round-trip test first caught
// that the wall point itself isn't the floor center: placing a prop straight
// at (5.975, -8.818) landed it on the wall, not out on the floor). Target =
// (x=5.975, y=-8.818+4.5=-4.318).
//
// axisMap/sign (which Motive axis feeds which app floor-plane axis, and its
// direction) come from T-bar's known-orientation marker line. rotationDeg +
// translate come from a proper 2D rigid fit (rotation + translation together,
// the same Procrustes math js/rigidFit.js uses for prop positioning) using
// T-bar's own two crossbar endpoints (Marker001/Marker003, 50cm apart, known
// to sit exactly on the studio floor's confirmed-flat edge at x=5.975) as the
// two correspondence points -- NOT a simple translation-only origin. A
// translation-only fit can't capture a real small rotational offset between
// Motive's own ground-plane calibration and the mesh-derived floor plan --
// two independent physical calibrations with no reason to agree to
// sub-degree precision, and one showed up here (~0.49 degrees). Cross-checked
// against Triangle's centroid (a fully independent capture, not used in the
// fit): reproduces the same target to within ~2mm. Motive Y confirmed as the
// up-axis (unused here) via a floor-baseline consistency check between the
// two captures' elevations.
window.App = window.App || {};

App.motiveTransform = {
  scaleToMeters: 0.001, // Motive export is in millimeters (js/motive/motiveCsv.js asserts this)
  axisMap: { appX: 'x', appY: 'z' }, // which Motive axis feeds which app floor-plane axis (Motive Y = up, unused here)
  sign: { appX: 1, appY: -1 },
  rotationDeg: -0.4867, // small correction between Motive's calibration and the mesh-derived floor plan
  translate: { x: 5.7180, y: -3.5519 }, // app-world meters, applied after rotation

  // point: {x,y,z} in Motive world space, mm. Returns {x,y} in app-world meters.
  toAppWorld(point) {
    const local = {
      x: this.sign.appX * point[this.axisMap.appX] * this.scaleToMeters,
      y: this.sign.appY * point[this.axisMap.appY] * this.scaleToMeters
    };
    const a = this.rotationDeg * Math.PI / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    return {
      x: this.translate.x + local.x * cos - local.y * sin,
      y: this.translate.y + local.x * sin + local.y * cos
    };
  }
};
