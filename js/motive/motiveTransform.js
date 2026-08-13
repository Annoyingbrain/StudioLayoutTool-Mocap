// Converts a wand tip position from Motive's global coordinate space (mm)
// into this app's internal world space (meters, floor-plane X/Y).
//
// The user confirmed (2026-08-13) Motive's global origin/axes are already
// calibrated to the studio's real-world reference frame -- but the EXACT
// axis correspondence below is a starting guess (standard OptiTrack
// convention: Y is up, X/Z is the floor plane) and has NOT been verified
// against a real capture yet. Before trusting exported positions: place the
// wand tip at a known real-world reference point, capture it, and confirm
// toAppWorld() reproduces that point -- the same kind of real-world check
// that caught the Disguise floor-origin issues in the original
// StudioLayoutTool.
window.App = window.App || {};

App.motiveTransform = {
  scaleToMeters: 0.001, // Motive export is in millimeters (js/motive/motiveCsv.js asserts this)
  origin: { x: 0, y: 0, z: 0 }, // Motive-space offset (mm), if origins don't already coincide
  axisMap: { appX: 'x', appY: 'z' }, // which Motive axis feeds which app floor-plane axis (Motive Y = up, unused here)
  sign: { appX: 1, appY: 1 },

  // point: {x,y,z} in Motive world space, mm. Returns {x,y} in app-world meters.
  toAppWorld(point) {
    const p = {
      x: point.x - this.origin.x,
      y: point.y - this.origin.y,
      z: point.z - this.origin.z
    };
    return {
      x: this.sign.appX * p[this.axisMap.appX] * this.scaleToMeters,
      y: this.sign.appY * p[this.axisMap.appY] * this.scaleToMeters
    };
  }
};
