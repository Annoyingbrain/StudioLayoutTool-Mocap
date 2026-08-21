// Printable scene report: a purpose-built top-down layout render (wall only,
// thicker lines, no grid, labeled prop corners, cameras and their recorded
// moves), the frame grabs beside it, and tables of every prop's and camera's
// captured world position. Uses the browser's native print-to-PDF — no
// external PDF library needed, and it works fully offline.
//
// THIS IS THE THIRD RENDERER of the same scene -- js/canvas.js draws the
// screen, js/floorPngExport.js draws the Disguise PNG, and this draws the
// print. None of them share drawing code, so anything added to one has to be
// added to the others by hand; nothing errors when it isn't, the feature is
// just silently absent from that output. Cameras were missing from here for
// exactly that reason, the same way recorded moves were once missing from the
// PNG. Keep the LAYERING identical across all three: props, then trails, then
// trail endpoints, then cameras.
//
// Unlike the PNG this draws in each entity's own colour on white. It uses the
// same camera.png, tinted per camera rather than flat white, and falls back to
// the plain wedge (App.geometry.cameraShapeWorldPoints) if the image has not
// loaded -- exactly as the other two renderers do.
window.App = window.App || {};

App.reportExport = (function () {
  // Drawing coordinates. Every font size, line width and offset below is in
  // this space -- see RENDER_SCALE, which changes the pixels without changing
  // any of them.
  const REPORT_W_MAX = 1400;
  const REPORT_W_MIN = 700;
  // The page is exactly as big as its content needs, in BOTH directions,
  // rather than a fixed 1400x900. The LED wall
  // arc is far bigger than the area anyone actually dresses, so framing on the
  // whole arc left the top ~40% of the picture as empty white inside the
  // curve. The vertical extent is trimmed to the props and cameras (plus a
  // margin, and never beyond the wall itself) and the canvas cropped to
  // match, which costs the top of the arc and buys back the space it was
  // wasting. The full WIDTH of the wall is always kept in the FRAME -- it is
  // the studio, and cropping it sideways would lose props against it.
  //
  // Cropping both axes matters more than it looks, because the image prints
  // at the full width of the page: letterboxing in EITHER direction is
  // page-width spent on white, so squeezing it out is what actually enlarges
  // the drawing. Trimming only the height moved the empty space to the sides
  // and the plan came out no bigger.
  const REPORT_H_MAX = 900;   // beyond this, scale down instead of growing
  const REPORT_H_MIN = 360;   // a strip shorter than this reads as a smear
  const CONTENT_MARGIN_M = 1.2;

  // The layout now prints at the full width of the page rather than in a 62%
  // column, so it is enlarged well past what 1400x900 was sized for. Scaling
  // the BACKING STORE rather than the design coordinates buys those pixels
  // without touching a single font size: shrink this and the picture is
  // identical, just softer. Capped because the result is embedded in the
  // report as a data URL, and a retina dpr on top of this would multiply again.
  const RENDER_SCALE = 2;
  const MAX_PIXEL_SCALE = 3;

  const CAMERA_ICON_WIDTH_M = 0.5; // same real-world size as the other two renderers

  // Same body icon as js/canvas.js and js/floorPngExport.js, and a separate
  // Image instance for the same reason -- neither module exposes its own. The
  // source PNG is black-on-transparent.
  const cameraIcon = new Image();
  let cameraIconLoaded = false;
  cameraIcon.onload = () => { cameraIconLoaded = true; };
  cameraIcon.src = 'assets/icons/camera.png';

  // The icon tinted to one camera's colour. Cached per colour AND size: a
  // report can hold several camera positions in different colours at the same
  // scale, so floorPngExport's single-slot cache (everything there is white)
  // would thrash.
  const tintCache = new Map();
  function tintedCameraIcon(color, w, h) {
    const cw = Math.max(1, Math.round(w)), ch = Math.max(1, Math.round(h));
    const key = color + '|' + cw + 'x' + ch;
    const hit = tintCache.get(key);
    if (hit) return hit;
    // Tinted on its OWN canvas, never on the report's. 'source-in' composites
    // against everything already on the target, so doing it inline would wipe
    // the white background and every shape drawn before this camera --
    // save()/restore() does not scope it, being a composite of pixels rather
    // than a state change. This is what once erased an entire floor-plan
    // export; confining it to a scratch canvas keeps the effect to the icon.
    const off = document.createElement('canvas');
    off.width = cw; off.height = ch;
    const octx = off.getContext('2d');
    octx.drawImage(cameraIcon, 0, 0, cw, ch);
    octx.globalCompositeOperation = 'source-in';
    octx.fillStyle = color;
    octx.fillRect(0, 0, cw, ch);
    tintCache.set(key, off);
    return off;
  }

  // Returns the view AND the canvas height it implies -- the two can't be
  // decided separately once the height follows the content.
  function computeView(minX, maxX, minY, maxY, pad) {
    const worldW = Math.max(0.5, maxX - minX), worldH = Math.max(0.5, maxY - minY);
    // Width normally binds, since the wall's full width is always kept. The
    // height term only takes over for a scene tall enough to exceed the cap,
    // which is the old behaviour and stops one from running off the page.
    const scale = Math.min((REPORT_W_MAX - pad * 2) / worldW, (REPORT_H_MAX - pad * 2) / worldH);
    // Whichever of the two the scale came from now fits its axis exactly; the
    // other is cropped to what it actually uses, so neither axis letterboxes.
    const width = Math.max(REPORT_W_MIN, Math.round(worldW * scale + pad * 2));
    const height = Math.max(REPORT_H_MIN, Math.round(worldH * scale + pad * 2));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    return {
      view: { scale, originX: width / 2 + cx * scale, originY: height / 2 - cy * scale },
      width,
      height
    };
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

  function drawProp(ctx, view, prop, labels) {
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

    // Name label above the box rather than centered inside it (clearer on
    // print). Goes through the label pass with the highest priority: props
    // anchor the plan, so it is the camera labels that give way around them.
    const topY = isCircle ? center.y - radiusPx : Math.min(...corners.map(c => c.y));
    labels.add(LABEL_PRIORITY.prop, center.x, topY - 6 - LABEL_LINE_H,
      [{ text: prop.name, font: 'bold 13px Segoe UI, Arial' }]);

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

  // Text on a busy plan collides. Two camera positions a metre apart put four
  // labels in the same square inch -- a name, a lens line, a Start and an End
  // -- and drawn where each one naturally falls they overprint into something
  // unreadable. So labels are COLLECTED during the drawing pass and placed at
  // the end: where one can go depends on where the others went, which can't be
  // known until every natural position is.
  //
  // Placing them last also puts every label on top of every icon and path,
  // rather than whatever happened to be drawn after it.
  const LABEL_LINE_H = 15;
  const LABEL_MAX_NUDGES = 8;

  // Lower priority is placed first and therefore never moves: props anchor the
  // plan, a camera's name identifies its mark, and Start/End give way because
  // their icon says most of it already.
  const LABEL_PRIORITY = { prop: 0, camera: 1, endpoint: 2 };

  function boxesOverlap(a, b) {
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
  }

  function makeLabels() {
    const items = [];
    return {
      // lines: [{ text, font }], centred on x, first line's top at y.
      add(priority, x, y, lines) { items.push({ priority, x, y, lines, seq: items.length }); },
      draw(ctx) {
        const placed = [];
        // seq keeps it stable within a priority, so two runs of the same scene
        // produce the same page.
        items.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
        items.forEach(item => {
          let width = 0;
          item.lines.forEach(l => {
            ctx.font = l.font;
            width = Math.max(width, ctx.measureText(l.text).width);
          });
          const height = item.lines.length * LABEL_LINE_H;
          const boxAt = top => ({
            left: item.x - width / 2, right: item.x + width / 2, top, bottom: top + height
          });

          // Nudge straight down a line at a time. Capped: past a few lines the
          // label is so far from its icon that it stops reading as that
          // camera's label at all, and an overlap is the lesser problem.
          let top = item.y;
          for (let i = 0; i < LABEL_MAX_NUDGES && placed.some(p => boxesOverlap(p, boxAt(top))); i++) {
            top += LABEL_LINE_H;
          }
          placed.push(boxAt(top));

          item.lines.forEach((l, i) => {
            ctx.save();
            ctx.font = l.font;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            // A halo, so a label that still lands on a path or an icon reads
            // against it instead of merging into it. Stroked first, filled
            // over the top.
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 3;
            ctx.lineJoin = 'round';
            ctx.strokeText(l.text, item.x, top + i * LABEL_LINE_H);
            ctx.fillStyle = '#111';
            ctx.fillText(l.text, item.x, top + i * LABEL_LINE_H);
            ctx.restore();
          });
        });
      }
    };
  }

  // A camera that was RECORDED is represented by the move alone -- the path
  // plus a Start and an End wedge -- and its static wedge is suppressed. Same
  // rule, and the same reason, as js/floorPngExport.js: after a recording the
  // camera's stored position IS wherever the move finished, so the static mark
  // lands almost on top of the End one and reads as a second camera at a fixed
  // position that no longer means anything. Keyed on the endpoints as well as
  // the path, so a hand-edited setup missing them degrades to the plain wedge
  // rather than to an unlabelled line.
  const hasRecordedMove = c => !!(c.trail && c.trail.length > 1 && c.trailEndpoints);

  // The camera body at an arbitrary { x, y, rotationDeg } -- shared between a
  // real camera and the position snapshots at a trail's start/end, which
  // aren't full camera objects. Mirrors js/canvas.js's and
  // js/floorPngExport.js's drawCameraIconShape, split out for the same reason.
  function drawCameraShape(ctx, view, pose, color, alpha) {
    const center = App.geometry.worldToScreen(view, pose.x, pose.y);
    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    if (cameraIconLoaded) {
      // The lens points along the icon's own +X (right) as drawn -- rotate to
      // match the SCREEN-space direction of the pose's local -Y (forward; see
      // js/utils/geometry.js's ROTATION CONVENTION note), found the same way
      // the other two renderers find it: project a world-space forward point
      // through this renderer's own transform and take the angle to it, so it
      // stays correct without duplicating that transform's math here.
      const forwardWorld = App.geometry.rotatePoint(pose.x, pose.y - 0.3, pose.x, pose.y, pose.rotationDeg);
      const forwardScreen = App.geometry.worldToScreen(view, forwardWorld.x, forwardWorld.y);
      const angle = Math.atan2(forwardScreen.y - center.y, forwardScreen.x - center.x);
      const w = CAMERA_ICON_WIDTH_M * view.scale;
      const h = w * (cameraIcon.naturalHeight / cameraIcon.naturalWidth);
      ctx.translate(center.x, center.y);
      ctx.rotate(angle);
      ctx.drawImage(tintedCameraIcon(color, w, h), -w / 2, -h / 2, w, h);
    } else {
      const pts = App.geometry.cameraShapeWorldPoints(pose).map(p => App.geometry.worldToScreen(view, p.x, p.y));
      ctx.beginPath();
      pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = color + '55';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
    return center;
  }

  // The recorded path itself. Dashed, unlike the PNG's solid line: on white,
  // beside solid prop outlines in the same palette, a solid stroke reads as
  // another piece of set rather than as a movement.
  function drawCameraTrail(ctx, view, camera) {
    const pts = camera.trail.map(p => App.geometry.worldToScreen(view, p.x, p.y));
    if (pts.length < 2) return;
    ctx.save();
    ctx.strokeStyle = camera.color;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([9, 6]);
    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.stroke();
    ctx.restore();
  }

  // Semi-transparent, so it reads as a snapshot along the path rather than as
  // the camera's real position.
  function drawCameraTrailEndpoint(ctx, view, pose, color, label, labels) {
    const center = drawCameraShape(ctx, view, pose, color, 0.55);
    labels.add(LABEL_PRIORITY.endpoint, center.x, center.y + iconHalfPx(view) * 0.6,
      [{ text: label, font: 'bold 11px Segoe UI, Arial' }]);
    return center;
  }

  // Half the icon's height, used to hang labels clear of it. Taken from the
  // icon's rotation-independent extent rather than the rotated wedge's
  // bounding box -- otherwise a label's distance from its camera changes with
  // heading, and at some rotations lands on top of it.
  function iconHalfPx(view) {
    return (CAMERA_ICON_WIDTH_M * view.scale) / 2;
  }

  // Name, then lens/height on a second line. Follows whichever mark actually
  // represents the camera -- its static wedge, or the END of a recorded move,
  // since a camera that moved has no single position to caption. With several
  // camera positions in one scene this is the only thing saying which path
  // belongs to which camera, so it is never dropped.
  function drawCameraLabel(view, center, camera, extraOffsetPx, labels) {
    const lines = [{ text: camera.name, font: 'bold 13px Segoe UI, Arial' }];
    // Lens (typed in) and height (from live tracking) on a second line, for
    // whoever sets the shot up from this page. Each part is omitted when
    // unknown rather than printed as a placeholder, so the line is dropped
    // entirely if neither is set. Both lines move together as one block --
    // splitting them would put a lens reading under someone else's name.
    const details = [];
    if (camera.focalLengthMm != null) details.push('Lens: ' + camera.focalLengthMm + 'mm');
    if (camera.heightM != null) details.push('h: ' + Math.round(camera.heightM * 100) + 'cm');
    if (details.length) lines.push({ text: details.join('   '), font: '11px Segoe UI, Arial' });

    labels.add(LABEL_PRIORITY.camera, center.x,
      center.y + iconHalfPx(view) + 8 + (extraOffsetPx || 0), lines);
  }

  function buildLayoutSnapshot(setup, scene) {

    // Two boxes, because they are used differently: the wall sets the WIDTH
    // (it is the studio, and it prints at the full width of the page), while
    // the content sets the HEIGHT -- see the frame constants at the top.
    const box = () => ({ minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
    const grow = (b, x, y) => {
      if (x < b.minX) b.minX = x;
      if (x > b.maxX) b.maxX = x;
      if (y < b.minY) b.minY = y;
      if (y > b.maxY) b.maxY = y;
    };

    const wallBox = box();
    const sketch = window.App.studioSketch;
    const wall = sketch && sketch.objects.find(o => o.name === 'led_wall_curve');
    if (wall) wall.segments.forEach(([a, b]) => { grow(wallBox, a[0], a[1]); grow(wallBox, b[0], b[1]); });

    // Cameras and their moves count as content too, or a camera parked outside
    // the wall -- or a move that ran past it -- is quietly cropped off the page.
    const contentBox = box();
    scene.props.forEach(p => App.geometry.propExtentPoints(p).forEach(c => grow(contentBox, c.x, c.y)));
    scene.cameras.forEach(c => {
      App.geometry.cameraShapeWorldPoints(c).forEach(p => grow(contentBox, p.x, p.y));
      (c.trail || []).forEach(p => grow(contentBox, p.x, p.y));
      if (c.trailEndpoints) {
        [c.trailEndpoints.start, c.trailEndpoints.end].forEach(e =>
          App.geometry.cameraShapeWorldPoints(e).forEach(p => grow(contentBox, p.x, p.y)));
      }
    });

    // Width: the wall plus anything placed outside it, so nothing is cropped
    // sideways.
    let minX = Math.min(wallBox.minX, contentBox.minX);
    let maxX = Math.max(wallBox.maxX, contentBox.maxX);

    // Height: the content plus a margin, but never past the wall -- the trim
    // removes empty floor, it does not invent space that isn't there. Trimmed
    // from BOTH ends, which is how "trim the empty top" is expressed without
    // having to know which way up the world is: wherever there is no gap, the
    // clamp leaves that end where it was.
    let minY, maxY;
    if (isFinite(contentBox.minY)) {
      minY = Math.max(wallBox.minY, contentBox.minY - CONTENT_MARGIN_M);
      maxY = Math.min(wallBox.maxY, contentBox.maxY + CONTENT_MARGIN_M);
    } else {
      // An empty position still gets a picture of the studio to place into.
      minY = wallBox.minY;
      maxY = wallBox.maxY;
    }

    if (!isFinite(minX)) { minX = -1; maxX = 1; }
    if (!isFinite(minY) || maxY <= minY) { minY = -1; maxY = 1; }

    const frame = computeView(minX, maxX, minY, maxY, 70);
    const view = frame.view;

    // Created here, not at the top: its height is the frame's, which isn't
    // known until the bounds are.
    const canvas = document.createElement('canvas');
    const pixelScale = Math.min((window.devicePixelRatio || 1) * RENDER_SCALE, MAX_PIXEL_SCALE);
    canvas.width = Math.round(frame.width * pixelScale);
    canvas.height = Math.round(frame.height * pixelScale);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(pixelScale, 0, 0, pixelScale, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, frame.width, frame.height);

    const labels = makeLabels();

    drawWall(ctx, view);
    scene.props.forEach(p => drawProp(ctx, view, p, labels));

    // Same layering as the other two renderers: paths behind their endpoint
    // snapshots, static cameras last. EVERY camera is drawn, including ones
    // hidden on the canvas -- like the PNG and the CSV this is a deliverable,
    // and Hide is a decluttering aid for the screen only.
    scene.cameras.forEach(c => { if (hasRecordedMove(c)) drawCameraTrail(ctx, view, c); });
    scene.cameras.forEach(c => {
      if (!hasRecordedMove(c)) return;
      drawCameraTrailEndpoint(ctx, view, c.trailEndpoints.start, c.color, 'Start', labels);
      const end = drawCameraTrailEndpoint(ctx, view, c.trailEndpoints.end, c.color, 'End', labels);
      drawCameraLabel(view, end, c, 12, labels);
    });
    scene.cameras.forEach(c => {
      if (hasRecordedMove(c)) return;
      drawCameraLabel(view, drawCameraShape(ctx, view, c, c.color), c, 0, labels);
    });

    // Every label, last: see makeLabels.
    labels.draw(ctx);

    return canvas.toDataURL('image/png');
  }

  // One row per prop: its solved position, however it got there (manual
  // placement or live tracking). Printed UNDER the camera table -- lens and
  // height are what a shot gets set up from, and the props are the dressing
  // that goes around it.
  function buildPropsRows(scene) {
    return scene.props.map(p =>
      `<tr><td>${p.name}</td>` +
      `<td>X=${p.x.toFixed(3)}, Y=${p.y.toFixed(3)}</td>` +
      `<td>${p.rotationDeg.toFixed(1)}&deg;</td>` +
      `<td>${p.positionSource === 'measured' ? 'tracked' : 'manual'}</td></tr>`
    ).join('');
  }

  // One row per camera position, mirroring the props table. A report whose
  // picture shows the cameras but whose tables ignore them is half a report:
  // lens and height are what someone sets the shot up from, and neither is
  // readable off the drawing.
  function buildCamerasRows(scene) {
    return scene.cameras.map(c => {
      const moved = hasRecordedMove(c);
      const where = moved
        ? 'moved \u2014 ' + c.trail.length + ' points, ends X=' + c.trailEndpoints.end.x.toFixed(3) + ', Y=' + c.trailEndpoints.end.y.toFixed(3)
        : 'X=' + c.x.toFixed(3) + ', Y=' + c.y.toFixed(3);
      const rot = moved ? c.trailEndpoints.end.rotationDeg : c.rotationDeg;
      return '<tr><td>' + c.name + '</td>' +
        '<td>' + where + '</td>' +
        '<td>' + rot.toFixed(1) + '&deg;</td>' +
        '<td>' + (c.focalLengthMm != null ? c.focalLengthMm + 'mm' : '&mdash;') + '</td>' +
        '<td>' + (c.heightM != null ? Math.round(c.heightM * 100) + 'cm' : '&mdash;') + '</td>' +
        '<td>' + (c.positionSource === 'measured' ? 'tracked' : 'manual') + '</td></tr>';
    }).join('');
  }

  return {
    // Reports the given scene (props, cameras, frame grabs) within the setup
    // -- each scene is its own shot/layout and gets its own report.
    open(setup, scene) {
      const dom = App.dom;
      const view = dom.qs('#report-view');
      dom.clear(view);

      const snapshot = buildLayoutSnapshot(setup, scene);
      const now = new Date();

      const propsRows = buildPropsRows(scene);
      const camerasRows = buildCamerasRows(scene);

      const images = [];
      images.push(`<figure class="report-img-layout"><img src="${snapshot}"><figcaption>Top-down layout &mdash; wall, props, camera positions</figcaption></figure>`);
      // One per CAMERA POSITION now, not one per position -- a layout shot
      // wide and then tight is two different reference pictures, and the
      // caption has to say which camera each belongs to or a report with
      // several is unreadable.
      scene.cameras.forEach(c => {
        if (!c.frameGrab) return;
        const caption = c.frameGrab.caption ? `${c.name} &mdash; ${c.frameGrab.caption}` : `${c.name} &mdash; frame grab reference`;
        images.push(`<figure class="report-img-framegrab"><img src="${c.frameGrab.imageDataUrl}"><figcaption>${caption}</figcaption></figure>`);
      });

      view.innerHTML = `
        <div class="report-page">
          <button class="report-close">Close</button>
          <button class="report-print">Print / Save as PDF</button>
          <h1>${setup.name} &mdash; Position: ${scene.name}${scene.dayName ? ' &mdash; ' + scene.dayName : ''}</h1>
          <div class="report-meta">
            Generated ${now.toLocaleString()} &middot; Position last updated ${new Date(scene.updatedAt).toLocaleString()}
            ${setup.notes ? '<br>' + setup.notes : ''}
          </div>

          <h2>Layout</h2>
          <div class="report-images">${images.join('')}</div>

          <h2>Camera Positions</h2>
          <table>
            <thead><tr><th>Camera</th><th>Position</th><th>Rotation</th><th>Lens</th><th>Height</th><th>Source</th></tr></thead>
            <tbody>${camerasRows}</tbody>
          </table>

          <h2>Props</h2>
          <table>
            <thead><tr><th>Prop</th><th>Position</th><th>Rotation</th><th>Source</th></tr></thead>
            <tbody>${propsRows}</tbody>
          </table>
        </div>`;

      view.classList.remove('hidden');
      view.querySelector('.report-close').addEventListener('click', () => view.classList.add('hidden'));
      view.querySelector('.report-print').addEventListener('click', () => window.print());
    },
    // Exposed for test/helpers/appContext.js, the same way
    // js/floorPngExport.js exposes buildCanvas: this renderer is the one most
    // likely to be forgotten when something is added to the other two, so it
    // has to be reachable without a DOM to assert against.
    buildLayoutSnapshot
  };
})();
