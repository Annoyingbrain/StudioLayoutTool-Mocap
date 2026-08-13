// Black/white floor-layout PNG for use as a Disguise (d3) media/reference
// layer: black background stands in for the floor, each prop is a solid
// white silhouette with a small red center marker and a white name label,
// and the setup/position name is printed near the top.
//
// Sized and oriented to match Disguise's floor coordinate system (see
// js/csvExport.js's DISGUISE_ORIGIN and its 180-degree axis rotation) at
// Disguise's actual floor input resolution, so the image lines up with the
// real floor if used as a layer/reference in the show.
window.App = window.App || {};

App.floorPngExport = (function () {
  const CANVAS_W = 2944, CANVAS_H = 2304; // Disguise's floor input resolution
  const CENTER_DOT_DIAMETER_M = 0.05;

  // World (x,y) -> Disguise-space (x,y) -- same transform as
  // App.csvExport.toDisguiseSpace's position math, without the rotation
  // field. Purely diagonal (disguise x depends only on world x, disguise y
  // only on world y), so it composes cleanly with prop.rotationDeg, which is
  // already baked into propCorners()'s world-space output before this runs.
  function toDisguise(x, y) {
    const origin = App.csvExport.DISGUISE_ORIGIN;
    return { x: origin.x - x, y: origin.y - y };
  }

  // The floor's own bounding box, in Disguise space -- this is what fills the
  // full canvas edge-to-edge, so the image matches Disguise's real floor
  // pixel pitch (verified against SA_SCREEN_floor_01.obj: ~4.08-4.10mm/px).
  function floorBoundsDisguise() {
    const sketch = window.App.studioSketch;
    const floor = sketch && sketch.objects.find(o => o.name === 'led_floor');
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const expand = (x, y) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; };
    if (floor) {
      floor.segments.forEach(([a, b]) => {
        [a, b].forEach(([x, y]) => { const d = toDisguise(x, y); expand(d.x, d.y); });
      });
    }
    if (!isFinite(minX)) { minX = 0; maxX = 12; minY = 0; maxY = 9; }
    return { minX, maxX, minY, maxY };
  }

  function drawProp(ctx, toPx, scaleX, scaleY, prop) {
    const isCircle = prop.shape === 'circle';
    const centerPx = toPx(toDisguise(prop.x, prop.y));

    ctx.save();
    ctx.beginPath();
    if (isCircle) {
      const r = App.geometry.propRadius(prop);
      ctx.ellipse(centerPx.x, centerPx.y, r * scaleX, r * scaleY, 0, 0, Math.PI * 2);
    } else {
      const corners = App.geometry.propCorners(prop).map(c => toPx(toDisguise(c.x, c.y)));
      corners.forEach((c, i) => i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y));
      ctx.closePath();
    }
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();

    // Center marker: ~5cm diameter red dot.
    ctx.save();
    ctx.fillStyle = '#ff0000';
    ctx.beginPath();
    const dotR = (CENTER_DOT_DIAMETER_M / 2) * (scaleX + scaleY) / 2;
    ctx.arc(centerPx.x, centerPx.y, dotR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Name label, just below the prop's footprint.
    const extentPx = App.geometry.propExtentPoints(prop).map(p => toPx(toDisguise(p.x, p.y)));
    const bottomPx = Math.max(...extentPx.map(p => p.y));
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 30px Segoe UI, Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(prop.name, centerPx.x, bottomPx + 10);
    ctx.restore();
  }

  function buildCanvas(setup, scene) {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    const bounds = floorBoundsDisguise();
    const scaleX = CANVAS_W / (bounds.maxX - bounds.minX);
    const scaleY = CANVAS_H / (bounds.maxY - bounds.minY);
    // Disguise Y increases toward the curved wall; flip to pixel rows (0 at
    // top) so the wall lands at the top of the image, matching real space.
    const toPx = d => ({
      x: (d.x - bounds.minX) * scaleX,
      y: CANVAS_H - (d.y - bounds.minY) * scaleY
    });

    scene.props.forEach(p => drawProp(ctx, toPx, scaleX, scaleY, p));

    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 46px Segoe UI, Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(`${setup.name} — Position: ${scene.name}`, CANVAS_W / 2, 40);
    ctx.restore();

    return canvas;
  }

  // Calibration aid: marks one or more points given directly in
  // Disguise-space coordinates (not app-internal world coordinates -- no
  // toDisguise() call, unlike drawProp) with a crosshair + coordinates
  // printed next to each, on the same black canvas/scale/orientation as the
  // real floor export. Lets the user play this in Disguise and physically
  // measure between the marked points to check the app's coordinate math
  // against real space -- see [[project-disguise-coordinate-origin]] /
  // [[project-measurement-height-correction]].
  function buildTestPointsCanvas(points) {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    const bounds = floorBoundsDisguise();
    const scaleX = CANVAS_W / (bounds.maxX - bounds.minX);
    const scaleY = CANVAS_H / (bounds.maxY - bounds.minY);
    const toPx = d => ({
      x: (d.x - bounds.minX) * scaleX,
      y: CANVAS_H - (d.y - bounds.minY) * scaleY
    });

    const pxPoints = points.map(p => ({ ...p, px: toPx(p) }));

    // Connect the dots so it's visually obvious which pair to measure
    // between, in the order given.
    if (pxPoints.length > 1) {
      ctx.save();
      ctx.strokeStyle = '#ffcc00';
      ctx.lineWidth = 3;
      ctx.setLineDash([14, 10]);
      ctx.beginPath();
      pxPoints.forEach((p, i) => i === 0 ? ctx.moveTo(p.px.x, p.px.y) : ctx.lineTo(p.px.x, p.px.y));
      ctx.stroke();
      ctx.restore();
    }

    pxPoints.forEach(p => {
      const { x: cx, y: cy } = p.px;
      ctx.save();
      ctx.strokeStyle = '#ff0000';
      ctx.fillStyle = '#ff0000';
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(cx, cy, 24, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx - 45, cy); ctx.lineTo(cx + 45, cy);
      ctx.moveTo(cx, cy - 45); ctx.lineTo(cx, cy + 45);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 34px Segoe UI, Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(p.label || `x=${p.x}m, y=${p.y}m`, cx, cy + 55);
      ctx.restore();
    });

    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 46px Segoe UI, Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('Disguise coordinate test points', CANVAS_W / 2, 40);
    ctx.restore();

    return canvas;
  }

  return {
    buildCanvas,
    buildTestPointsCanvas,

    exportSetup(setup, scene) {
      if (!scene.props.length) { App.toast('No props to export yet.', true); return; }
      const canvas = buildCanvas(setup, scene);
      canvas.toBlob(blob => {
        if (!blob) { App.toast('Could not generate PNG.', true); return; }
        const safeName = `${setup.name || 'setup'}_Position_${scene.name || '1'}_floor`.replace(/[^a-z0-9_\-]+/gi, '_');
        App.dom.downloadBlob(`${safeName}.png`, blob);
      }, 'image/png');
    },

    // points: [{x, y, label}, ...] in Disguise-space meters.
    exportTestPoints(points) {
      const canvas = buildTestPointsCanvas(points);
      canvas.toBlob(blob => {
        if (!blob) { App.toast('Could not generate PNG.', true); return; }
        const safeName = 'disguise_test_points_' + points.map(p => `${p.x}_${p.y}`).join('-');
        App.dom.downloadBlob(`${safeName.replace(/[^a-z0-9_\-.]+/gi, '_')}.png`, blob);
      }, 'image/png');
    }
  };
})();
