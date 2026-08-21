// Floor-layout PNG for use as a Disguise (d3) media/reference layer: black
// background stands in for the floor, each prop is a solid white silhouette
// with a small red center marker and a white name label, and the
// setup/position name is printed near the top.
//
// PROPS are white because that silhouette is what Disguise lines the real
// piece up against. CAMERAS are drawn in their own colour from the app -- the
// same colour as on screen -- and so are their paths and captions. They were
// white too until a plan came back with cameras parked on top of props, where
// a white icon on a white fill was simply invisible; the colour is what
// separates them, and nothing on the floor is aligned against a camera, so it
// costs Disguise nothing.
//
// Sized and oriented to match Disguise's floor coordinate system (see
// js/csvExport.js's DISGUISE_ORIGIN and its 180-degree axis rotation) at
// Disguise's actual floor input resolution, so the image lines up with the
// real floor if used as a layer/reference in the show.
window.App = window.App || {};

App.floorPngExport = (function () {
  const CANVAS_W = 2944, CANVAS_H = 2304; // Disguise's floor input resolution
  const CENTER_DOT_DIAMETER_M = 0.05;
  const CAMERA_ICON_WIDTH_M = 0.5; // same real-world size as js/canvas.js's on-screen icon
  const TRAIL_WIDTH_M = 0.04;      // recorded camera path, in metres so it scales with the floor
  // Drops a moved camera's caption clear of the "End" text above it.
  const END_CAPTION_CLEARANCE_PX = 24;

  // Same body icon as js/canvas.js (separate Image instance -- this module
  // has no access to canvas.js's private one), recolored solid white via
  // source-in compositing to match this export's white-silhouette-on-black
  // convention (the source PNG is black-on-transparent).
  const cameraIcon = new Image();
  let cameraIconLoaded = false;
  cameraIcon.onload = () => { cameraIconLoaded = true; };
  cameraIcon.src = 'assets/icons/camera.png';

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

  // Text on a busy plan collides. Cameras get parked right up against the
  // props they are shooting -- which is how the shot was actually set up, not
  // something to design away -- so a name, a lens line, a Start and an End all
  // land in the same square inch and overprint into a stack nobody can read.
  // Same problem js/reportExport.js has, and the same fix: labels are
  // COLLECTED during the drawing pass and placed at the end, because where one
  // can go depends on where the others went, which is not known until every
  // natural position is.
  //
  // Placing them last also puts every label on top of every icon, path and
  // prop, rather than whatever happened to be drawn after it.
  const LABEL_LINE_H = 36;   // the name/lens gap this export already used
  const LABEL_MAX_NUDGES = 8;

  // Lower priority is placed first and therefore never moves: props anchor the
  // plan, a camera's name identifies its mark, and Start/End give way because
  // their icon already says most of what they say.
  const LABEL_PRIORITY = { prop: 0, camera: 1, endpoint: 2 };

  function boxesOverlap(a, b) {
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
  }

  function makeLabels() {
    const items = [];
    return {
      // lines: [{ text, font, color }], centred on x, first line's top at y.
      // color defaults to white -- prop names, which stay white like the
      // footprints they belong to.
      add(priority, x, y, lines, alpha) { items.push({ priority, x, y, lines, alpha, seq: items.length }); },
      draw(ctx) {
        const placed = [];
        // seq keeps it stable within a priority, so two exports of the same
        // scene produce the same image.
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
            ctx.globalAlpha = item.alpha == null ? 1 : item.alpha;
            ctx.font = l.font;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            // A BLACK halo -- the opposite way round from the report, and for
            // a different reason. Props here are solid white fills, so a white
            // label landing on one vanished entirely; the outline is what
            // makes it readable against the prop. It does the same job for a
            // camera's coloured caption, which is legible on a white prop but
            // low-contrast against it. Against the black background the halo
            // is invisible, so it costs nothing everywhere else.
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 6;
            ctx.lineJoin = 'round';
            ctx.strokeText(l.text, item.x, top + i * LABEL_LINE_H);
            ctx.fillStyle = l.color || '#ffffff';
            ctx.fillText(l.text, item.x, top + i * LABEL_LINE_H);
            ctx.restore();
          });
        });
      }
    };
  }

  function drawProp(ctx, toPx, scaleX, scaleY, prop, labels) {
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

    // Name label, just below the prop's footprint. Highest priority in the
    // label pass -- props anchor the plan, so it is the camera labels that
    // give way around them.
    const extentPx = App.geometry.propExtentPoints(prop).map(p => toPx(toDisguise(p.x, p.y)));
    const bottomPx = Math.max(...extentPx.map(p => p.y));
    labels.add(LABEL_PRIORITY.prop, centerPx.x, bottomPx + 10,
      [{ text: prop.name, font: 'bold 30px Segoe UI, Arial' }]);
  }

  // The camera icon tinted to one camera's colour. Cached per colour AND
  // size, the same as js/reportExport.js's: an export holds several camera
  // positions in different colours at one scale, so the single-slot cache
  // this used to have (back when every icon was white) would thrash.
  const tintCache = new Map();
  function tintedCameraIcon(color, w, h) {
    const cw = Math.max(1, Math.round(w)), ch = Math.max(1, Math.round(h));
    const key = color + '|' + cw + 'x' + ch;
    const hit = tintCache.get(key);
    if (hit) return hit;
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

  // Falls back to white for a camera with no colour stored -- a setup saved
  // before cameras carried one, or hand-edited. White is what this export
  // drew for every camera before, so an old setup degrades to exactly its
  // previous appearance rather than to something invisible.
  const cameraColor = c => (c && c.color) || '#ffffff';

  // Draws just the camera body icon (white silhouette, or the plain wedge
  // fallback while the PNG loads) at an arbitrary { x, y, rotationDeg } --
  // shared between the real camera entity (drawCamera) and the position
  // snapshots at a recorded trail's start/end (drawCameraTrailEndpoint),
  // which aren't full camera objects. Mirrors js/canvas.js's
  // drawCameraIconShape, which was split out for exactly the same reason.
  function drawCameraIconShape(ctx, toPx, scaleX, scaleY, pose, alpha, color) {
    const centerPx = toPx(toDisguise(pose.x, pose.y));

    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    if (cameraIconLoaded) {
      // Lens points along the icon's own +X (right) as drawn -- rotate to
      // match the screen-space direction of the camera's local -Y (forward
      // -- see js/utils/geometry.js's ROTATION CONVENTION note), found the
      // same way js/canvas.js's drawCameraIconShape does: project a
      // world-space forward point through this export's own toDisguise/toPx
      // pipeline and take the angle to it.
      const forwardWorld = App.geometry.rotatePoint(pose.x, pose.y - 0.3, pose.x, pose.y, pose.rotationDeg);
      const forwardPx = toPx(toDisguise(forwardWorld.x, forwardWorld.y));
      const angle = Math.atan2(forwardPx.y - centerPx.y, forwardPx.x - centerPx.x);
      const w = CAMERA_ICON_WIDTH_M * ((scaleX + scaleY) / 2);
      const h = w * (cameraIcon.naturalHeight / cameraIcon.naturalWidth);

      // The icon is recoloured on its OWN canvas, never on the export's.
      // 'source-in' composites against everything
      // already on the target canvas, so doing it inline here used to wipe
      // the black background and every shape drawn before this camera --
      // ctx.save()/restore() doesn't scope that, since it's a composite of
      // pixels rather than a state change. Confining it to a scratch canvas
      // keeps the effect to the icon.
      ctx.translate(centerPx.x, centerPx.y);
      ctx.rotate(angle);
      ctx.drawImage(tintedCameraIcon(color, w, h), -w / 2, -h / 2, w, h);
    } else {
      const shapePx = App.geometry.cameraShapeWorldPoints(pose).map(p => toPx(toDisguise(p.x, p.y)));
      ctx.beginPath();
      shapePx.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.restore();
    return centerPx;
  }

  // A recorded camera move (js/motive/liveRecording.js) drawn as a path on
  // the floor. The on-screen canvas has always drawn this and the export
  // silently didn't, so a plan handed to the crew showed only where the
  // camera ended up, not the move itself.
  //
  // Width is given in metres, not pixels, because this canvas is roughly
  // 245 px/m -- the on-screen 2px line would come out hairline here. In the
  // camera's own colour, like its icons and caption, so a plan with several
  // recorded moves on it says which path belongs to which camera without
  // reading a single label. Stroked rather than filled, so it still can't be
  // mistaken for a prop footprint.
  function drawCameraTrail(ctx, toPx, scaleX, scaleY, camera) {
    const pts = camera.trail.map(p => toPx(toDisguise(p.x, p.y)));
    if (pts.length < 2) return;
    ctx.save();
    ctx.strokeStyle = cameraColor(camera);
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = TRAIL_WIDTH_M * ((scaleX + scaleY) / 2);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.stroke();
    ctx.restore();
  }

  // A camera icon at the trail's start/end -- semi-transparent so it reads
  // as a snapshot along the path rather than the camera's real position.
  // Deliberately gets no red centre dot: those mark actual entity centres
  // for lining the plan up in Disguise, and a snapshot isn't one.
  function drawCameraTrailEndpoint(ctx, toPx, scaleX, scaleY, pose, label, color, labels) {
    const centerPx = drawCameraIconShape(ctx, toPx, scaleX, scaleY, pose, 0.55, color);
    const iconHalfPx = (CAMERA_ICON_WIDTH_M * ((scaleX + scaleY) / 2)) / 2;
    labels.add(LABEL_PRIORITY.endpoint, centerPx.x, centerPx.y + iconHalfPx * 0.6,
      [{ text: label, font: 'bold 26px Segoe UI, Arial', color: color }], 0.85);
    // Returned so buildCanvas can hang the camera's caption off the End one.
    return centerPx;
  }

  // The camera's name + lens/height caption. Split out of drawCamera because
  // it has to follow whichever mark actually represents the camera on the
  // plan: its static icon normally, or the END of a recorded move, since a
  // camera that moved has no single position to caption. With several camera
  // positions in one scene this caption is the only thing saying which path
  // belongs to which camera, so it is never dropped.
  //
  // Anchored to the icon's own (rotation-independent) extent rather than the
  // rotated wedge's bounding box -- otherwise the caption's distance from the
  // camera changes with heading, and at some rotations lands on top of it.
  function drawCameraLabel(centerPx, scaleX, scaleY, camera, extraOffsetPx, labels) {
    const iconHalfPx = (CAMERA_ICON_WIDTH_M * ((scaleX + scaleY) / 2)) / 2;
    const bottomPx = centerPx.y + iconHalfPx + (extraOffsetPx || 0);

    // Lens (typed in) and height (from live tracking) on a second line, for
    // whoever is setting the shot up from this plan. Each part is omitted
    // when unknown rather than printed as a placeholder, so the line is
    // dropped entirely if neither is set.
    const details = [];
    if (camera.focalLengthMm != null) details.push(`Lens: ${camera.focalLengthMm}mm`);
    if (camera.heightM != null) details.push(`h: ${Math.round(camera.heightM * 100)}cm`);

    // Name and lens go in as ONE item, so the pass moves them together. Split
    // apart, a lens reading ends up under someone else's name -- worse than an
    // overlap, because it looks correct.
    const color = cameraColor(camera);
    const lines = [{ text: camera.name, font: 'bold 30px Segoe UI, Arial', color: color }];
    if (details.length) lines.push({ text: details.join('   '), font: '24px Segoe UI, Arial', color: color });
    labels.add(LABEL_PRIORITY.camera, centerPx.x, bottomPx + 10, lines);
  }

  // A camera at rest: the icon, the red centre marker Disguise lines up
  // against, and the caption. NOT used for a camera carrying a recorded
  // move -- see hasRecordedMove in buildCanvas.
  function drawCamera(ctx, toPx, scaleX, scaleY, camera, labels) {
    const centerPx = drawCameraIconShape(ctx, toPx, scaleX, scaleY, camera, 1, cameraColor(camera));

    ctx.save();
    ctx.fillStyle = '#ff0000';
    ctx.beginPath();
    const dotR = (CENTER_DOT_DIAMETER_M / 2) * (scaleX + scaleY) / 2;
    ctx.arc(centerPx.x, centerPx.y, dotR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    drawCameraLabel(centerPx, scaleX, scaleY, camera, 0, labels);
  }

  // options.cameras === false draws the props alone. Two different pictures
  // get asked for on a shoot day: the props-only one, which is the floor
  // layer (camera positions are clutter down there -- nothing on the floor
  // lines up against them), and the full plan with them drawn on it.
  //
  // Note the DEFAULT is the full plan even though the props-only variant is
  // the one on the header button: the default is "draw everything in the
  // scene", which is what a caller passing no options means, and moving a
  // button between the header and the menu shouldn't reach in here.
  function buildCanvas(setup, scene, options) {
    const withCameras = !options || options.cameras !== false;
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

    const labels = makeLabels();

    scene.props.forEach(p => drawProp(ctx, toPx, scaleX, scaleY, p, labels));

    // A camera that was RECORDED is represented by the move alone -- the path
    // plus a Start and an End icon -- and its static icon is suppressed.
    // Drawing both was actively misleading: after a recording the camera's
    // stored position is wherever the move finished, so the static icon
    // landed almost on top of the End one, reading as a second camera and
    // implying a fixed position that no longer means anything. The red centre
    // dot goes with it, for the same reason -- a camera that moved has no
    // single point for Disguise to line up against.
    //
    // Keyed on the endpoints as well as the path, not the path alone:
    // liveRecording.js always writes the pair together, so requiring both
    // means a hand-edited setup missing them degrades to the plain static
    // icon rather than to an unlabelled line.
    const hasRecordedMove = c => !!(c.trail && c.trail.length > 1 && c.trailEndpoints);

    // Recorded moves included: a props-only plan means no camera on it at
    // all, not "no icons but still the paths they drove".
    if (withCameras) {
      // Same layering as js/canvas.js: paths behind the endpoint snapshots.
      scene.cameras.forEach(c => { if (hasRecordedMove(c)) drawCameraTrail(ctx, toPx, scaleX, scaleY, c); });
      scene.cameras.forEach(c => {
        if (!hasRecordedMove(c)) return;
        drawCameraTrailEndpoint(ctx, toPx, scaleX, scaleY, c.trailEndpoints.start, 'Start', cameraColor(c), labels);
        const endPx = drawCameraTrailEndpoint(ctx, toPx, scaleX, scaleY, c.trailEndpoints.end, 'End', cameraColor(c), labels);
        drawCameraLabel(endPx, scaleX, scaleY, c, END_CAPTION_CLEARANCE_PX, labels);
      });
      scene.cameras.forEach(c => { if (!hasRecordedMove(c)) drawCamera(ctx, toPx, scaleX, scaleY, c, labels); });
    }

    // Every label, last: see makeLabels.
    labels.draw(ctx);

    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 46px Segoe UI, Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    // The shoot day and the variant are printed on the image, not just
    // encoded in the filename: once it's a layer in Disguise the filename
    // isn't in front of anyone, and two days of the same position differ only
    // by where the cameras are -- which is exactly what someone holding the
    // wrong day's plan would not notice.
    //
    // scene.dayName comes from Store.getSceneForDay(); absent (a raw scene, a
    // test, an older caller) the heading simply omits it rather than printing
    // an empty dash.
    const dayPart = scene.dayName ? ` — ${scene.dayName}` : '';
    ctx.fillText(`${setup.name} — Position: ${scene.name}${dayPart}${withCameras ? '' : ' — props only'}`, CANVAS_W / 2, 40);
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

  // Hands the PNG to server.py, which writes it into --png-dir (the studio's
  // Z:\App Generated PNG by default) so the file lands where Disguise picks
  // it up, with nobody moving it out of a downloads folder.
  //
  // A page can't write to a drive path itself -- the browser sandbox allows a
  // download, or a save dialog to be steered by hand every single time, and
  // nothing else -- so the only way to a fixed folder is the server process,
  // which is an ordinary Windows program. Note the file therefore lands on
  // the machine running server.py, not on the tablet or laptop that pressed
  // the button; that's the point, since the shared drive is what Disguise
  // reads.
  //
  // Falls back to a plain download whenever that doesn't work (server down,
  // drive not mapped, page opened straight off the filesystem). Losing the
  // shared folder shouldn't mean losing the export -- but the toast says
  // which of the two happened, or the file quietly isn't where it's expected.
  function savePng(filename, blob) {
    fetch(`/api/floor-png?name=${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: blob
    })
      .then(res => res.json().then(body => ({ ok: res.ok, body })))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || 'Server refused the PNG');
        App.toast(`Saved to ${body.path}`);
      })
      .catch(err => {
        App.dom.downloadBlob(filename, blob);
        App.toast(`Couldn't save to the shared folder (${err.message}) — downloaded instead.`, true);
      });
  }

  return {
    buildCanvas,
    buildTestPointsCanvas,

    exportSetup(setup, scene, options) {
      const withCameras = !options || options.cameras !== false;
      if (withCameras) {
        if (!scene.props.length && !scene.cameras.length) { App.toast('No props or cameras to export yet.', true); return; }
      } else if (!scene.props.length) {
        // Cameras don't count toward a props-only export: a scene always has
        // at least one camera (see ensureCamera), so checking both would let
        // an empty plan through as a black rectangle.
        App.toast('No props to export yet.', true); return;
      }
      const canvas = buildCanvas(setup, scene, options);
      canvas.toBlob(blob => {
        if (!blob) { App.toast('Could not generate PNG.', true); return; }
        // No literal "Position" in here: scene names already default to
        // "Position 1", so inserting one produced
        // Untitled_Setup_Position_Position_1_floor.png. A scene renamed to
        // something else reads fine without it too.
        // The suffix keeps the two variants as two files rather than one
        // overwriting the other -- both get laid up in Disguise, and which
        // one is wanted changes shot to shot. The day is in there for the
        // same reason: re-exporting overwrites, and without it Day 2's plan
        // would silently replace Day 1's on the shared drive.
        const variant = withCameras ? '' : '_props_only';
        const day = scene.dayName ? `_${scene.dayName}` : '';
        const safeName = `${setup.name || 'setup'}_${scene.name || 'Position 1'}${day}_floor${variant}`.replace(/[^a-z0-9_\-]+/gi, '_');
        savePng(`${safeName}.png`, blob);
      }, 'image/png');
    },

    // points: [{x, y, label}, ...] in Disguise-space meters.
    exportTestPoints(points) {
      const canvas = buildTestPointsCanvas(points);
      canvas.toBlob(blob => {
        if (!blob) { App.toast('Could not generate PNG.', true); return; }
        const safeName = 'disguise_test_points_' + points.map(p => `${p.x}_${p.y}`).join('-');
        savePng(`${safeName.replace(/[^a-z0-9_\-.]+/gi, '_')}.png`, blob);
      }, 'image/png');
    }
  };
})();
