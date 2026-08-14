// Coordinate transforms + rotation/hit-testing helpers.
// World space = real studio meters (X right, Y "up" on the plan). Screen space = canvas pixels.
window.App = window.App || {};

const DEG2RAD = Math.PI / 180;

// Fixed display rotation: 180° so the curved back wall renders across the
// top of the canvas (arcing down over the room) instead of the bottom.
// Purely a view/rendering convention: world data (mesh, reference points,
// saved prop positions) is untouched, so this doesn't affect measurement math.
// (A ~0.5° rotational skew in the source mesh export -- the wall/floor not
// being quite axis-aligned -- is corrected in the data itself, in
// js/studioSketch.js, not here: a uniform rotation added to this shared
// screen transform would rotate the procedurally-drawn grid by the same
// amount, which cancels out and fixes nothing -- the grid and the mesh have
// to be corrected relative to EACH OTHER, not both spun together.)
const DISPLAY_ROTATION_DEG = 180;
const DISPLAY_COS = Math.cos(DISPLAY_ROTATION_DEG * DEG2RAD);
const DISPLAY_SIN = Math.sin(DISPLAY_ROTATION_DEG * DEG2RAD);

App.geometry = {
  worldToScreen(view, x, y) {
    const rx = x * DISPLAY_COS - y * DISPLAY_SIN;
    const ry = x * DISPLAY_SIN + y * DISPLAY_COS;
    return {
      x: view.originX + rx * view.scale,
      y: view.originY - ry * view.scale
    };
  },

  screenToWorld(view, sx, sy) {
    const rx = (sx - view.originX) / view.scale;
    const ry = (view.originY - sy) / view.scale;
    // Inverse of the display rotation (rotation matrices are orthogonal, so
    // the inverse is just the transpose -- rotate by -DISPLAY_ROTATION_DEG).
    return {
      x: rx * DISPLAY_COS + ry * DISPLAY_SIN,
      y: -rx * DISPLAY_SIN + ry * DISPLAY_COS
    };
  },

  rotatePoint(px, py, cx, cy, angleDeg) {
    const a = angleDeg * DEG2RAD;
    const cos = Math.cos(a), sin = Math.sin(a);
    const dx = px - cx, dy = py - cy;
    return {
      x: cx + dx * cos - dy * sin,
      y: cy + dx * sin + dy * cos
    };
  },

  // Local (unrotated, center-relative) offsets of a prop's corners, in corner0..cornerN order.
  // Rectangles get 4 (corner0..corner3); triangles get 3 (corner0..corner2), an isosceles
  // triangle inscribed in the widthM x depthM box with its apex on the same side as the
  // rotation handle (so the shape visibly "points" the way it'll spin).
  localCornerOffsets(prop) {
    const hw = prop.widthM / 2, hd = prop.depthM / 2;
    if (prop.shape === 'triangle') {
      return [
        { x: 0, y: hd }, { x: -hw, y: -hd }, { x: hw, y: -hd }
      ];
    }
    return [
      { x: -hw, y: -hd }, { x: hw, y: -hd }, { x: hw, y: hd }, { x: -hw, y: hd }
    ];
  },

  // World-space corners of a prop's rectangle (before screen projection), rotated about its center.
  propCorners(prop) {
    return this.localCornerOffsets(prop).map(p =>
      this.rotatePoint(prop.x + p.x, prop.y + p.y, prop.x, prop.y, prop.rotationDeg));
  },

  // Radius of a circular prop (widthM doubles as its diameter).
  propRadius(prop) {
    return prop.widthM / 2;
  },

  // Is world point (px,py) inside the prop's shape (rotated rectangle, triangle, or circle)?
  pointInProp(px, py, prop) {
    if (prop.shape === 'circle') {
      return this.distance(px, py, prop.x, prop.y) <= this.propRadius(prop);
    }
    const inv = this.rotatePoint(px, py, prop.x, prop.y, -prop.rotationDeg);
    if (prop.shape === 'triangle') {
      const [a, b, c] = this.localCornerOffsets(prop).map(o => ({ x: prop.x + o.x, y: prop.y + o.y }));
      return this.pointInTriangle(inv, a, b, c);
    }
    const dx = inv.x - prop.x, dy = inv.y - prop.y;
    return Math.abs(dx) <= prop.widthM / 2 && Math.abs(dy) <= prop.depthM / 2;
  },

  // Sign-of-cross-product test: true if p is inside (or on the edge of) triangle abc.
  pointInTriangle(p, a, b, c) {
    const sign = (p1, p2, p3) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
    const d1 = sign(p, a, b), d2 = sign(p, b, c), d3 = sign(p, c, a);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  },

  // A handful of world-space points on the prop's outline, sufficient for
  // computing a bounding box -- corners for a rectangle/triangle, the 4 axis
  // extremes for a circle (which has no corners).
  propExtentPoints(prop) {
    if (prop.shape === 'circle') {
      const r = this.propRadius(prop);
      return [
        { x: prop.x - r, y: prop.y }, { x: prop.x + r, y: prop.y },
        { x: prop.x, y: prop.y - r }, { x: prop.x, y: prop.y + r }
      ];
    }
    return this.propCorners(prop);
  },

  distance(x1, y1, x2, y2) {
    return Math.hypot(x2 - x1, y2 - y1);
  },

  // World-space position of the rotation handle (above the prop's top edge).
  rotationHandlePos(prop) {
    const handleOffsetM = prop.depthM / 2 + 0.5;
    return this.rotatePoint(prop.x, prop.y + handleOffsetM, prop.x, prop.y, prop.rotationDeg);
  },

  // World-space position of one of a camera's 3 tracked markers

  // World-space position of a camera's rotation handle -- same "local +Y,
  // fixed distance past the shape" convention as rotationHandlePos.
  cameraRotationHandlePos(camera) {
    const handleOffsetM = 0.6;
    return this.rotatePoint(camera.x, camera.y + handleOffsetM, camera.x, camera.y, camera.rotationDeg);
  },

  // A camera's on-canvas/on-export icon: a small forward-pointing wedge
  // (local coordinates, apex = lens direction), distinct from prop shapes --
  // shared between js/canvas.js and js/floorPngExport.js.
  CAMERA_SHAPE_LOCAL: [{ x: 0, y: 0.35 }, { x: 0.15, y: -0.15 }, { x: -0.15, y: -0.15 }],
  cameraShapeWorldPoints(camera) {
    return this.CAMERA_SHAPE_LOCAL.map(p => this.rotatePoint(camera.x + p.x, camera.y + p.y, camera.x, camera.y, camera.rotationDeg));
  }
};
