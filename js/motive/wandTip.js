// Computes the measurement wand's physical touch-tip position from its 5
// tracked markers (see js/motive/motiveCsv.js for how those come in). The
// wand's marker plate is 4 markers spaced along a line plus a 5th marker
// offset to one side near one end -- this breaks the line's 180-degree
// symmetry so the tip end can be identified without any hardcoded marker
// index/order assumptions (verified against the sample capture: markers fit
// a line to within a few percent, and the 5th sits close to one end, not
// the middle -- see the plan notes for the numeric analysis).
//
// Algorithm, per frame:
//  1. Try each of the 5 "leave-one-out" subsets of 4 markers; fit a 3D line
//     to each and keep the subset with the lowest collinearity residual.
//     That's "the line"; the excluded marker is the orientation/handle
//     marker.
//  2. Project the 4 line markers onto the fitted direction; the two
//     extremes are the line's endpoints.
//  3. The endpoint FARTHER from the orientation marker is the tip end (the
//     orientation marker sits near the handle end, not the tip).
//  4. Extend past that endpoint by the calibrated tip length
//     (js/motive/motiveCalibration.js) along the line direction.
//
// No dependency on Motive's own marker index/order or its rigid-body local
// axis convention -- robust to markers being re-labeled between sessions.
//
// Steps 1 (identifyLineAndOffset, exposed below) is the same "4 collinear +
// 1 offset" geometry as the T-bar reference tracker, which reuses it (see
// js/ui/motiveCapture.js's T-bar capture) to find its own line-center and
// offset marker -- it just doesn't extend past an endpoint the way the wand
// tip does.
window.App = window.App || {};

App.wandTip = (function () {
  function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
  function add(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
  function scale(a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
  function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function length(a) { return Math.sqrt(dot(a, a)); }
  function normalize(a) { const l = length(a) || 1e-9; return scale(a, 1 / l); }

  function centroid(points) {
    const n = points.length;
    return points.reduce((acc, p) => add(acc, scale(p, 1 / n)), { x: 0, y: 0, z: 0 });
  }

  // Best-fit 3D line direction through `points`, via the dominant
  // eigenvector of the covariance matrix (power iteration -- overkill
  // eigendecomposition libraries aren't needed for a well-conditioned 3x3
  // case with only 4 points and a clearly dominant axis).
  function fitLineDirection(points) {
    const c = centroid(points);
    const centered = points.map(p => sub(p, c));
    const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    centered.forEach(p => {
      const v = [p.x, p.y, p.z];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += v[i] * v[j];
    });
    let vec = { x: 1, y: 1, z: 1 };
    for (let iter = 0; iter < 50; iter++) {
      const v = [vec.x, vec.y, vec.z];
      const next = [0, 0, 0];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) next[i] += m[i][j] * v[j];
      vec = normalize({ x: next[0], y: next[1], z: next[2] });
    }
    return { centroid: c, direction: vec };
  }

  // Sum of squared perpendicular distances of `points` from their own
  // best-fit line -- lower means "more collinear."
  function collinearityResidual(points) {
    const { centroid: c, direction: dir } = fitLineDirection(points);
    return points.reduce((sum, p) => {
      const v = sub(p, c);
      const along = dot(v, dir);
      const perp = sub(v, scale(dir, along));
      return sum + dot(perp, perp);
    }, 0);
  }

  function identifyLineAndOrientationMarker(markers5) {
    if (markers5.length !== 5) throw new Error(`wandTip expects exactly 5 markers, got ${markers5.length}`);
    let best = null;
    for (let excluded = 0; excluded < 5; excluded++) {
      const subset = markers5.filter((_, i) => i !== excluded);
      const residual = collinearityResidual(subset);
      if (!best || residual < best.residual) best = { excludedIndex: excluded, subset, residual };
    }
    return { lineMarkers: best.subset, orientationMarker: markers5[best.excludedIndex], residual: best.residual };
  }

  function lineEndpoints(lineMarkers) {
    const { centroid: c, direction: dir } = fitLineDirection(lineMarkers);
    const projected = lineMarkers.map(p => ({ point: p, t: dot(sub(p, c), dir) }));
    projected.sort((a, b) => a.t - b.t);
    return { near: projected[0].point, far: projected[projected.length - 1].point };
  }

  return {
    // markers5: [{x,y,z}, ...] x5, any order. Returns { lineMarkers (4 pts),
    // orientationMarker (the 5th/offset pt), residual }.
    identifyLineAndOffset: identifyLineAndOrientationMarker,

    // markers5: [{x,y,z}, ...] x5, any consistent unit (mm as exported),
    // any order. calibration: { tipExtensionMm }. Returns the tip position
    // in the same space/units as the input.
    compute(markers5, calibration) {
      const { lineMarkers, orientationMarker } = identifyLineAndOrientationMarker(markers5);
      const { near, far } = lineEndpoints(lineMarkers);
      const distNear = length(sub(orientationMarker, near));
      const distFar = length(sub(orientationMarker, far));
      // Orientation marker sits near the handle end -- tip is the opposite end.
      const handleEnd = distNear <= distFar ? near : far;
      const tipEnd = distNear <= distFar ? far : near;
      const dir = normalize(sub(tipEnd, handleEnd));
      return add(tipEnd, scale(dir, calibration.tipExtensionMm || 0));
    },

    // frames: array of { markers: [{x,y,z}x5], ... } (e.g. straight from
    // motiveCsv.parse().frames, a short static capture of one touched
    // point). Averages the computed tip position across all frames and
    // reports jitter (mm, RMS distance from the mean) as a capture-quality
    // readout -- a shaky touch shows high jitter, a well-planted one near-zero.
    averageCapture(frames, calibration) {
      if (!frames.length) return null;
      const tips = frames.map(f => this.compute(f.markers, calibration));
      const mean = centroid(tips);
      const jitterMm = Math.sqrt(tips.reduce((sum, t) => sum + dot(sub(t, mean), sub(t, mean)), 0) / tips.length);
      return { position: mean, jitterMm, frameCount: tips.length };
    }
  };
})();
