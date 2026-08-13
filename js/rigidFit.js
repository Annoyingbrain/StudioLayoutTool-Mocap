// Given 1+ known correspondences between a prop's LOCAL points (center/corners,
// fixed by its width/depth) and their solved WORLD positions (from multilateration),
// compute the prop's center X/Y and rotation.
//
// With 1 correspondence only translation is determined (rotation is kept as-is).
// With 2+ correspondences, both rotation and translation are solved via the
// standard 2D absolute-orientation (Procrustes/Horn) least-squares fit.
window.App = window.App || {};

App.rigidFit = {
  // correspondences: [{ local: {x,y}, world: {x,y} }, ...]
  solve(correspondences, fallbackRotationDeg) {
    if (!correspondences.length) return null;

    if (correspondences.length === 1) {
      const { local, world } = correspondences[0];
      const rotated = App.geometry.rotatePoint(local.x, local.y, 0, 0, fallbackRotationDeg);
      return {
        x: world.x - rotated.x,
        y: world.y - rotated.y,
        rotationDeg: fallbackRotationDeg,
        pointCount: 1
      };
    }

    const n = correspondences.length;
    const lc = { x: 0, y: 0 }, wc = { x: 0, y: 0 };
    correspondences.forEach(({ local, world }) => {
      lc.x += local.x / n; lc.y += local.y / n;
      wc.x += world.x / n; wc.y += world.y / n;
    });

    let num = 0, den = 0;
    correspondences.forEach(({ local, world }) => {
      const lx = local.x - lc.x, ly = local.y - lc.y;
      const wx = world.x - wc.x, wy = world.y - wc.y;
      num += lx * wy - ly * wx;
      den += lx * wx + ly * wy;
    });
    const rotationDeg = Math.atan2(num, den) * 180 / Math.PI;

    const rotatedCentroid = App.geometry.rotatePoint(lc.x, lc.y, 0, 0, rotationDeg);
    const center = { x: wc.x - rotatedCentroid.x, y: wc.y - rotatedCentroid.y };

    // RMS of how well the fit reproduces each measured world point (sanity/error metric).
    let sumSq = 0;
    correspondences.forEach(({ local, world }) => {
      const r = App.geometry.rotatePoint(local.x, local.y, 0, 0, rotationDeg);
      const px = center.x + r.x, py = center.y + r.y;
      sumSq += (px - world.x) ** 2 + (py - world.y) ** 2;
    });

    return { x: center.x, y: center.y, rotationDeg, pointCount: n, fitRms: Math.sqrt(sumSq / n) };
  }
};
