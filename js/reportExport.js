// Printable scene report: a purpose-built top-down layout render (wall only,
// thicker lines, no grid, labeled prop corners), the frame grab side by side
// with it, and a table of every prop point's captured world position. Uses
// the browser's native print-to-PDF — no external PDF library needed, and it
// works fully offline.
window.App = window.App || {};

App.reportExport = (function () {
  const REPORT_W = 1400, REPORT_H = 900;

  function computeView(minX, maxX, minY, maxY, pad) {
    const worldW = Math.max(0.5, maxX - minX), worldH = Math.max(0.5, maxY - minY);
    const scale = Math.min((REPORT_W - pad * 2) / worldW, (REPORT_H - pad * 2) / worldH);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    return { scale, originX: REPORT_W / 2 + cx * scale, originY: REPORT_H / 2 - cy * scale };
  }

  function drawWall(ctx, view) {
    const sketch = window.App.studioSketch;
    const wall = sketch && sketch.objects.find(o => o.name === 'led_wall_curve');
    if (!wall) return;
    ctx.save();
    ctx.strokeStyle = '#1d4fd1';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    wall.segments.forEach(([a, b]) => {
      const sa = App.geometry.worldToScreen(view, a[0], a[1]);
      const sb = App.geometry.worldToScreen(view, b[0], b[1]);
      ctx.moveTo(sa.x, sa.y);
      ctx.lineTo(sb.x, sb.y);
    });
    ctx.stroke();
    ctx.restore();
  }

  function drawProp(ctx, view, prop) {
    const isCircle = prop.shape === 'circle';
    const center = App.geometry.worldToScreen(view, prop.x, prop.y);
    const corners = isCircle ? null : App.geometry.propCorners(prop).map(p => App.geometry.worldToScreen(view, p.x, p.y));
    const radiusPx = isCircle ? App.geometry.propRadius(prop) * view.scale : 0;

    ctx.save();
    ctx.beginPath();
    if (isCircle) {
      ctx.arc(center.x, center.y, radiusPx, 0, Math.PI * 2);
    } else {
      corners.forEach((c, i) => i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y));
      ctx.closePath();
    }
    ctx.fillStyle = prop.color + '55';
    ctx.fill();
    ctx.strokeStyle = prop.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // Name label above the box rather than centered inside it (clearer on print).
    const topY = isCircle ? center.y - radiusPx : Math.min(...corners.map(c => c.y));
    ctx.save();
    ctx.fillStyle = '#111';
    ctx.font = 'bold 13px Segoe UI, Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(prop.name, center.x, topY - 6);
    ctx.restore();

    if (isCircle) return;

    // Corner labels (1-4), matching the "Corner 1"..."Corner 4" point names
    // used in the Props distance table below.
    ctx.save();
    ctx.fillStyle = '#111';
    ctx.font = 'bold 10px Segoe UI, Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    corners.forEach((c, i) => {
      const dx = c.x - center.x, dy = c.y - center.y;
      const len = Math.hypot(dx, dy) || 1;
      ctx.fillText(String(i + 1), c.x + (dx / len) * 12, c.y + (dy / len) * 12);
    });
    ctx.restore();
  }

  function buildLayoutSnapshot(setup, scene) {
    const canvas = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(REPORT_W * dpr);
    canvas.height = Math.round(REPORT_H * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, REPORT_W, REPORT_H);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const expand = (x, y) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; };
    const sketch = window.App.studioSketch;
    const wall = sketch && sketch.objects.find(o => o.name === 'led_wall_curve');
    if (wall) wall.segments.forEach(([a, b]) => { expand(a[0], a[1]); expand(b[0], b[1]); });
    scene.props.forEach(p => App.geometry.propExtentPoints(p).forEach(c => expand(c.x, c.y)));
    if (!isFinite(minX)) { minX = -1; maxX = 1; minY = -1; maxY = 1; }

    const view = computeView(minX, maxX, minY, maxY, 70);

    drawWall(ctx, view);
    scene.props.forEach(p => drawProp(ctx, view, p));

    return canvas.toDataURL('image/png');
  }

  // One row per prop: its solved position, however it got there (manual
  // placement or live tracking).
  function buildPropsRows(scene) {
    return scene.props.map(p =>
      `<tr><td>${p.name}</td>` +
      `<td>X=${p.x.toFixed(3)}, Y=${p.y.toFixed(3)}</td>` +
      `<td>${p.rotationDeg.toFixed(1)}&deg;</td>` +
      `<td>${p.positionSource === 'measured' ? 'tracked' : 'manual'}</td></tr>`
    ).join('');
  }

  return {
    // Reports the given scene (props, frame grab) within the setup -- each
    // scene is its own shot/layout and gets its own report.
    open(setup, scene) {
      const dom = App.dom;
      const view = dom.qs('#report-view');
      dom.clear(view);

      const snapshot = buildLayoutSnapshot(setup, scene);
      const now = new Date();

      const propsRows = buildPropsRows(scene);

      const images = [];
      images.push(`<figure class="report-img-layout"><img src="${snapshot}"><figcaption>Top-down layout &mdash; wall, props</figcaption></figure>`);
      if (scene.frameGrab) {
        images.push(`<figure class="report-img-framegrab"><img src="${scene.frameGrab.imageDataUrl}"><figcaption>${scene.frameGrab.caption || 'Frame grab reference'}</figcaption></figure>`);
      }

      view.innerHTML = `
        <div class="report-page">
          <button class="report-close">Close</button>
          <button class="report-print">Print / Save as PDF</button>
          <h1>${setup.name} &mdash; Position: ${scene.name}</h1>
          <div class="report-meta">
            Generated ${now.toLocaleString()} &middot; Position last updated ${new Date(scene.updatedAt).toLocaleString()}
            ${setup.notes ? '<br>' + setup.notes : ''}
          </div>

          <h2>Layout</h2>
          <div class="report-images">${images.join('')}</div>

          <h2>Props</h2>
          <table>
            <thead><tr><th>Prop</th><th>Position</th><th>Rotation</th><th>Source</th></tr></thead>
            <tbody>${propsRows}</tbody>
          </table>
        </div>`;

      view.classList.remove('hidden');
      view.querySelector('.report-close').addEventListener('click', () => view.classList.add('hidden'));
      view.querySelector('.report-print').addEventListener('click', () => window.print());
    }
  };
})();
