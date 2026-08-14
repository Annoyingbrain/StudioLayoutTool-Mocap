// The 2D top-down studio canvas: grid, props (rectangles, triangles, or
// circles) with drag-move, drag-rotate and drag-resize, and cameras (their
// own category, drag-move + drag-rotate only -- no resize).
window.App = window.App || {};

(function () {
  const geo = App.geometry;
  const HANDLE_R = 6;
  const ROT_HANDLE_R = 7;
  // The studio's real physical/Disguise floor center -- 4.5m out from the
  // LED wall's "north point" (js/studioSketch.js's "Center" reference
  // point), confirmed via the Triangle/T-bar reference-tracker captures
  // (see js/motive/motiveTransform.js's calibration comment). Grid lines
  // are drawn relative to this instead of the app's arbitrary mesh-export
  // origin (0,0), so on-screen distances read directly against a real,
  // known landmark.
  const GRID_ORIGIN = { x: 5.975, y: -4.318 };
  const DIR_ARROW_LEN_M = 0.15; // how far past the prop's front edge the direction arrow extends
  const DIR_ARROW_HEAD_PX = 7;

  // Camera body icon: lens points along its own +X (right) in the source
  // PNG, so it's drawn rotated to match the camera's local +Y (forward) --
  // see drawCamera(). Rendered at a fixed real-world width, height scaled to
  // match the image's own aspect ratio.
  const CAMERA_ICON_WIDTH_M = 0.5;
  const cameraIcon = new Image();
  let cameraIconLoaded = false;
  // The image can finish loading (it's small/local, often cached) before
  // App.canvas.init() has run and set up canvas/wrap -- render() would then
  // throw reading wrap.clientWidth. `wrap` is only ever set inside init(),
  // so it doubles as an "are we initialized yet" guard.
  cameraIcon.onload = () => { cameraIconLoaded = true; if (wrap) render(); };
  cameraIcon.src = 'assets/icons/camera.png';

  let canvas, ctx, wrap;
  let dragState = null;
  let spaceDown = false;
  // The scale computed by the last "fit to studio sketch" pass -- acts as
  // a floor so you can zoom in for detail work but can't zoom out past the
  // view that fills the space between the panels.
  let minScale = 4;
  // Active touch/pen contacts by pointerId, for pinch-to-zoom (two-finger)
  // gesture detection alongside the existing single-pointer drag logic.
  const activePointers = new Map();

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // worldToScreen at scale=1, origin=(0,0) -- i.e. just the fixed display
  // rotation applied to (x,y), with no scale/origin baked in yet. Used to
  // derive origins for zoom-to-cursor and fit-to-bounds without assuming the
  // transform is a pure axis flip (it also carries a small rotation
  // correction -- see js/utils/geometry.js).
  function projectUnit(x, y) {
    return geo.worldToScreen({ scale: 1, originX: 0, originY: 0 }, x, y);
  }

  function resizeCanvasToDisplaySize() {
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function getView() { return App.Store.getScene().view; }

  function mouseWorld(evt) {
    const rect = canvas.getBoundingClientRect();
    const sx = evt.clientX - rect.left, sy = evt.clientY - rect.top;
    return { screen: { x: sx, y: sy }, world: geo.screenToWorld(getView(), sx, sy) };
  }

  function drawGrid(view, w, h) {
    ctx.save();
    const topLeft = geo.screenToWorld(view, 0, 0);
    const bottomRight = geo.screenToWorld(view, w, h);
    const minX = Math.floor(Math.min(topLeft.x, bottomRight.x)) - 1;
    const maxX = Math.ceil(Math.max(topLeft.x, bottomRight.x)) + 1;
    const minY = Math.floor(Math.min(topLeft.y, bottomRight.y)) - 1;
    const maxY = Math.ceil(Math.max(topLeft.y, bottomRight.y)) + 1;

    // Grid lines are spaced every 1m/5m from the studio's real floor center
    // (GRID_ORIGIN), not the app's arbitrary mesh-export origin.
    const cx = GRID_ORIGIN.x, cy = GRID_ORIGIN.y;
    const firstN_X = Math.ceil(minX - cx), lastN_X = Math.floor(maxX - cx);
    const firstN_Y = Math.ceil(minY - cy), lastN_Y = Math.floor(maxY - cy);

    for (let n = firstN_X; n <= lastN_X; n++) {
      const x = cx + n;
      ctx.strokeStyle = n === 0 ? '#54607a' : (n % 5 === 0 ? '#3a4150' : '#262b34');
      ctx.lineWidth = n === 0 ? 1.5 : (n % 5 === 0 ? 1.2 : 0.6);
      const a = geo.worldToScreen(view, x, minY), b = geo.worldToScreen(view, x, maxY);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (let n = firstN_Y; n <= lastN_Y; n++) {
      const y = cy + n;
      ctx.strokeStyle = n === 0 ? '#54607a' : (n % 5 === 0 ? '#3a4150' : '#262b34');
      ctx.lineWidth = n === 0 ? 1.5 : (n % 5 === 0 ? 1.2 : 0.6);
      const a = geo.worldToScreen(view, minX, y), b = geo.worldToScreen(view, maxX, y);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.restore();
  }

  // Fixed studio floor-plan sketch (curved LED wall + LED floor), baked once
  // from the studio's mesh export -- see js/studioSketch.js. Always on, same
  // for every setup, not user-editable. The room_shell outline is skipped --
  // just the LED wall/floor reference is shown.
  function drawStudioSketch(view) {
    const sketch = window.App.studioSketch;
    if (!sketch) return;
    ctx.save();
    ctx.lineWidth = 1;
    sketch.objects.filter(obj => obj.name !== 'room_shell').forEach(obj => {
      ctx.strokeStyle = obj.color;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      obj.segments.forEach(([a, b]) => {
        const sa = geo.worldToScreen(view, a[0], a[1]);
        const sb = geo.worldToScreen(view, b[0], b[1]);
        ctx.moveTo(sa.x, sa.y);
        ctx.lineTo(sb.x, sb.y);
      });
      ctx.stroke();
    });
    ctx.restore();
  }

  // Small arrow past a rectangular prop's front edge (local +Y, the same
  // "front" direction the rotation handle already uses -- see
  // js/utils/geometry.js's rotationHandlePos), always visible so a prop's
  // facing direction reads at a glance without having to select it.
  function drawDirectionArrow(view, prop) {
    const hd = prop.depthM / 2;
    const baseWorld = geo.rotatePoint(prop.x, prop.y + hd, prop.x, prop.y, prop.rotationDeg);
    const tipWorld = geo.rotatePoint(prop.x, prop.y + hd + DIR_ARROW_LEN_M, prop.x, prop.y, prop.rotationDeg);
    const base = geo.worldToScreen(view, baseWorld.x, baseWorld.y);
    const tip = geo.worldToScreen(view, tipWorld.x, tipWorld.y);
    const angle = Math.atan2(tip.y - base.y, tip.x - base.x);

    ctx.save();
    ctx.strokeStyle = prop.color;
    ctx.fillStyle = prop.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - DIR_ARROW_HEAD_PX * Math.cos(angle - Math.PI / 6), tip.y - DIR_ARROW_HEAD_PX * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(tip.x - DIR_ARROW_HEAD_PX * Math.cos(angle + Math.PI / 6), tip.y - DIR_ARROW_HEAD_PX * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawProp(view, prop, selected) {
    const isCircle = prop.shape === 'circle';
    const center = geo.worldToScreen(view, prop.x, prop.y);
    const corners = isCircle ? null : geo.propCorners(prop).map(p => geo.worldToScreen(view, p.x, p.y));
    const radiusPx = isCircle ? geo.propRadius(prop) * view.scale : 0;
    // Where the "measured" indicator dot and the name label anchor -- a
    // corner for a rectangle, the top of the circle for a circle.
    const markerPt = isCircle ? { x: center.x, y: center.y - radiusPx } : corners[1];

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
    ctx.strokeStyle = selected ? '#4da6ff' : prop.color;
    ctx.lineWidth = selected ? 2.5 : 1.5;
    ctx.stroke();

    ctx.fillStyle = '#0d0f12';
    ctx.font = 'bold 11px Segoe UI, Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(prop.name, center.x, center.y);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.restore();

    if (prop.shape === 'rect') drawDirectionArrow(view, prop);

    if (prop.positionSource === 'measured') {
      ctx.save();
      ctx.fillStyle = '#6fd08c';
      ctx.beginPath();
      ctx.arc(markerPt.x, markerPt.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    if (selected) {
      ctx.save();
      if (!isCircle) {
        // Corner squares mark the prop's extent; they used to be clickable
        // to choose a capture point, which live tracking made redundant.
        corners.forEach(c => {
          ctx.fillStyle = '#4da6ff';
          ctx.strokeStyle = '#0d0f12';
          ctx.beginPath();
          ctx.rect(c.x - HANDLE_R / 2, c.y - HANDLE_R / 2, HANDLE_R, HANDLE_R);
          ctx.fill(); ctx.stroke();
        });
        const rotHandleWorld = geo.rotationHandlePos(prop);
        const rotHandle = geo.worldToScreen(view, rotHandleWorld.x, rotHandleWorld.y);
        ctx.strokeStyle = '#4da6ff';
        ctx.beginPath(); ctx.moveTo(center.x, center.y); ctx.lineTo(rotHandle.x, rotHandle.y); ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(rotHandle.x, rotHandle.y, ROT_HANDLE_R, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#0d0f12'; ctx.stroke();
      }
      ctx.restore();
    }
  }

  // A recorded camera move sampled into a path (js/motive/liveRecording.js) -- purely a position trail, drawn behind the camera
  // icon itself.
  function drawCameraTrail(view, camera) {
    const pts = camera.trail.map(p => geo.worldToScreen(view, p.x, p.y));
    ctx.save();
    ctx.strokeStyle = camera.color;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.stroke();
    ctx.restore();
  }

  // Draws just the camera body icon (image, or the plain wedge fallback
  // while it loads) at an arbitrary { x, y, rotationDeg } -- shared between
  // the real camera entity (drawCamera) and the plain position+rotation
  // snapshots at a trail's start/end (drawCameraTrailEndpoint), which aren't
  // full camera objects.
  function drawCameraIconShape(view, pos, color, selected, alpha) {
    const center = geo.worldToScreen(view, pos.x, pos.y);
    const pts = geo.cameraShapeWorldPoints(pos).map(p => geo.worldToScreen(view, p.x, p.y));

    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    if (selected) {
      ctx.beginPath();
      ctx.arc(center.x, center.y, CAMERA_ICON_WIDTH_M / 2 * view.scale + 5, 0, Math.PI * 2);
      ctx.strokeStyle = '#4da6ff';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    if (cameraIconLoaded) {
      // The icon's lens points along its own +X (right) as drawn -- rotate
      // to match the screen-space direction of the position's local +Y
      // (forward), found the same way drawDirectionArrow finds its angle:
      // project a world-space forward point through worldToScreen and take
      // the angle to it, so it's correct under the canvas's fixed 180-degree
      // display rotation without duplicating that math here.
      const forwardWorld = geo.rotatePoint(pos.x, pos.y + 0.3, pos.x, pos.y, pos.rotationDeg);
      const forwardScreen = geo.worldToScreen(view, forwardWorld.x, forwardWorld.y);
      const screenAngle = Math.atan2(forwardScreen.y - center.y, forwardScreen.x - center.x);
      const w = CAMERA_ICON_WIDTH_M * view.scale;
      const h = w * (cameraIcon.naturalHeight / cameraIcon.naturalWidth);
      ctx.translate(center.x, center.y);
      ctx.rotate(screenAngle);
      ctx.drawImage(cameraIcon, -w / 2, -h / 2, w, h);
    } else {
      ctx.beginPath();
      pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = color + '55';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
    return { center, pts };
  }

  // A camera icon at a trail's start/end (js/motive/liveRecording.js) -- smaller and semi-transparent so it reads as a
  // snapshot along the path, not the camera's actual current position.
  function drawCameraTrailEndpoint(view, pos, color, label) {
    const { center } = drawCameraIconShape(view, pos, color, false, 0.55);
    ctx.save();
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = '#e8eaed';
    ctx.font = 'bold 10px Segoe UI, Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(label, center.x, center.y + CAMERA_ICON_WIDTH_M / 2 * view.scale * 0.6);
    ctx.restore();
  }

  // Cameras are their own category from props, positioned as a whole rather
  // than by resizable corners. Hit-testing and js/floorPngExport.js use the
  // simple forward-pointing wedge (App.geometry.cameraShapeWorldPoints/
  // CAMERA_SHAPE_LOCAL) -- only the on-canvas visual here uses the
  // camera.png icon.
  function drawCamera(view, camera, selected) {
    const { center, pts } = drawCameraIconShape(view, camera, camera.color, selected);

    ctx.save();
    ctx.fillStyle = '#e8eaed';
    ctx.font = 'bold 11px Segoe UI, Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Camera's x/y is the icon's rotation pivot, which sits inside the
    // body's transparent interior (not the lens flag) -- verified against
    // assets/icons/camera.png directly, not assumed. Text stays upright
    // (not rotated with the icon) so it's always readable.
    ctx.fillText(camera.name, center.x, center.y);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.restore();

    if (camera.positionSource === 'measured') {
      ctx.save();
      ctx.fillStyle = '#6fd08c';
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    if (selected) {
      ctx.save();
      const rotHandleWorld = geo.cameraRotationHandlePos(camera);
      const rotHandle = geo.worldToScreen(view, rotHandleWorld.x, rotHandleWorld.y);
      ctx.strokeStyle = '#4da6ff';
      ctx.beginPath(); ctx.moveTo(center.x, center.y); ctx.lineTo(rotHandle.x, rotHandle.y); ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(rotHandle.x, rotHandle.y, ROT_HANDLE_R, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#0d0f12'; ctx.stroke();
      ctx.restore();
    }
  }

  function render() {
    resizeCanvasToDisplaySize();
    const w = wrap.clientWidth, h = wrap.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const scene = App.Store.getScene();
    const view = scene.view;
    const selectedId = App.Store.getSelectedPropId();
    const selectedCameraId = App.Store.getSelectedCameraId();

    if (App.dom.qs('#chk-grid').checked) drawGrid(view, w, h);
    if (App.dom.qs('#chk-studio-sketch').checked) drawStudioSketch(view);
    scene.props.forEach(p => drawProp(view, p, p.id === selectedId));
    scene.cameras.forEach(c => { if (c.trail) drawCameraTrail(view, c); });
    scene.cameras.forEach(c => {
      if (c.trailEndpoints) {
        drawCameraTrailEndpoint(view, c.trailEndpoints.start, c.color, 'Start');
        drawCameraTrailEndpoint(view, c.trailEndpoints.end, c.color, 'End');
      }
    });
    scene.cameras.forEach(c => drawCamera(view, c, c.id === selectedCameraId));

    // Each scene has its own pan/zoom; keep the px/m readout in sync when
    // switching scenes (not just when zooming the current one).
    const scaleInput = App.dom.qs('#view-scale');
    if (document.activeElement !== scaleInput) scaleInput.value = Math.round(view.scale);

    updateHint();
  }

  function updateHint() {
    const hint = App.dom.qs('#canvas-hint');
    const tool = App.Store.getTool();
    if (tool === 'add-prop') {
      hint.textContent = 'Click on the canvas to place the prop.';
    } else if (tool === 'add-camera') {
      hint.textContent = 'Click on the canvas to place the camera.';
    } else if (App.Store.getSelectedCamera()) {
      hint.textContent = 'Drag to move · top handle rotates · wheel to zoom · middle-drag or space+drag to pan';
    } else {
      const selected = App.Store.getSelectedProp();
      hint.textContent = selected && selected.shape === 'circle'
        ? 'Drag to move · wheel to zoom · middle-drag or space+drag to pan'
        : 'Drag to move · top handle rotates · wheel to zoom · middle-drag or space+drag to pan';
    }
  }

  function hitTestProp(scene, worldPt) {
    for (let i = scene.props.length - 1; i >= 0; i--) {
      if (geo.pointInProp(worldPt.x, worldPt.y, scene.props[i])) return scene.props[i];
    }
    return null;
  }

  function hitTestCamera(scene, worldPt) {
    for (let i = scene.cameras.length - 1; i >= 0; i--) {
      const pts = geo.cameraShapeWorldPoints(scene.cameras[i]);
      if (geo.pointInTriangle(worldPt, pts[0], pts[1], pts[2])) return scene.cameras[i];
    }
    return null;
  }

  function hitTestCameraHandle(view, camera, screenPt, pointerType) {
    const pad = pointerType === 'touch' || pointerType === 'pen' ? 16 : 3;
    const rotWorld = geo.cameraRotationHandlePos(camera);
    const rotScreen = geo.worldToScreen(view, rotWorld.x, rotWorld.y);
    if (geo.distance(screenPt.x, screenPt.y, rotScreen.x, rotScreen.y) <= ROT_HANDLE_R + pad) {
      return { kind: 'rotate' };
    }
    return null;
  }

  function hitTestHandles(view, prop, screenPt, pointerType) {
    // Circular props have no corners and rotation is meaningless (a circle
    // is rotationally symmetric), so there are no handles to hit-test.
    if (prop.shape === 'circle') return null;
    // Fingertips are much less precise than a mouse cursor, so touch/pen
    // contacts get a wider hit-test tolerance around each handle.
    const pad = pointerType === 'touch' || pointerType === 'pen' ? 16 : 3;
    const rotWorld = geo.rotationHandlePos(prop);
    const rotScreen = geo.worldToScreen(view, rotWorld.x, rotWorld.y);
    if (geo.distance(screenPt.x, screenPt.y, rotScreen.x, rotScreen.y) <= ROT_HANDLE_R + pad) {
      return { kind: 'rotate' };
    }
    return null;
  }

  function pointerDistance(a, b) { return geo.distance(a.x, a.y, b.x, b.y); }
  function pointerMidpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

  function startPinch() {
    const pts = Array.from(activePointers.values());
    const view = getView();
    dragState = {
      kind: 'pinch',
      ids: Array.from(activePointers.keys()),
      startDist: pointerDistance(pts[0], pts[1]),
      startMid: pointerMidpoint(pts[0], pts[1]),
      startScale: view.scale,
      startOrigin: { x: view.originX, y: view.originY }
    };
  }

  function onPointerDown(evt) {
    canvas.setPointerCapture(evt.pointerId);
    const { screen, world } = mouseWorld(evt);

    if (evt.pointerType !== 'mouse') {
      activePointers.set(evt.pointerId, screen);
      if (activePointers.size === 2) { startPinch(); return; }
      if (activePointers.size > 2) return; // ignore a 3rd+ contact
    }

    const scene = App.Store.getScene();

    if (evt.button === 1 || (evt.button === 0 && spaceDown)) {
      dragState = { kind: 'pan', startScreen: screen, startOrigin: { x: scene.view.originX, y: scene.view.originY } };
      canvas.style.cursor = 'grabbing';
      return;
    }

    const tool = App.Store.getTool();
    if (evt.button === 0 && tool === 'add-prop') {
      const prop = App.factories.newProp(round3(world.x), round3(world.y), scene.props.length);
      App.Store.addProp(prop);
      App.Store.setTool('select');
      return;
    }
    if (evt.button === 0 && tool === 'add-camera') {
      const camera = App.factories.newCamera(round3(world.x), round3(world.y), scene.cameras.length);
      App.Store.addCamera(camera);
      App.Store.setTool('select');
      return;
    }

    if (evt.button !== 0) return;

    const selectedProp = App.Store.getSelectedProp();
    if (selectedProp) {
      const handle = hitTestHandles(scene.view, selectedProp, screen, evt.pointerType);
      if (handle && handle.kind === 'rotate') {
        dragState = { kind: 'rotate', entity: 'prop', entityId: selectedProp.id, center: { x: selectedProp.x, y: selectedProp.y } };
        return;
      }
    }
    const selectedCamera = App.Store.getSelectedCamera();
    if (selectedCamera) {
      const handle = hitTestCameraHandle(scene.view, selectedCamera, screen, evt.pointerType);
      if (handle && handle.kind === 'rotate') {
        dragState = { kind: 'rotate', entity: 'camera', entityId: selectedCamera.id, center: { x: selectedCamera.x, y: selectedCamera.y } };
        return;
      }
    }

    const hitProp = hitTestProp(scene, world);
    if (hitProp) {
      App.Store.selectProp(hitProp.id);
      dragState = { kind: 'move', entity: 'prop', entityId: hitProp.id, startWorld: world, startEntity: { x: hitProp.x, y: hitProp.y } };
      return;
    }
    const hitCamera = hitTestCamera(scene, world);
    if (hitCamera) {
      App.Store.selectCamera(hitCamera.id);
      dragState = { kind: 'move', entity: 'camera', entityId: hitCamera.id, startWorld: world, startEntity: { x: hitCamera.x, y: hitCamera.y } };
      return;
    }

    if (evt.pointerType === 'touch' || evt.pointerType === 'pen') {
      // No space-bar/middle-click on touch -- a single-finger drag that
      // doesn't start on a prop/camera pans the view instead of doing nothing.
      App.Store.selectProp(null);
      App.Store.selectCamera(null);
      dragState = { kind: 'pan', startScreen: screen, startOrigin: { x: scene.view.originX, y: scene.view.originY } };
    } else {
      App.Store.selectProp(null);
      App.Store.selectCamera(null);
    }
  }

  function round3(v) { return Math.round(v * 1000) / 1000; }

  function isLiveDriven(entityType, entityId) {
    return !!(App.liveTracking && App.liveTracking.getRigidBodyDriving(entityType, entityId));
  }

  function onPointerMove(evt) {
    if (evt.pointerType !== 'mouse' && activePointers.has(evt.pointerId)) {
      const { screen } = mouseWorld(evt);
      activePointers.set(evt.pointerId, screen);
    }

    if (dragState && dragState.kind === 'pinch') {
      const pts = dragState.ids.map(id => activePointers.get(id)).filter(Boolean);
      if (pts.length < 2) return;
      const view = getView();
      const newDist = pointerDistance(pts[0], pts[1]);
      const mid = pointerMidpoint(pts[0], pts[1]);
      const newScale = clamp(dragState.startScale * (newDist / dragState.startDist), minScale, 400);
      // Keep the world point under the pinch midpoint stationary while
      // scaling, and follow the midpoint's own on-screen movement (pan).
      const worldAtStartMid = geo.screenToWorld({ ...view, scale: dragState.startScale, originX: dragState.startOrigin.x, originY: dragState.startOrigin.y }, dragState.startMid.x, dragState.startMid.y);
      const unit = projectUnit(worldAtStartMid.x, worldAtStartMid.y);
      const newOriginX = mid.x - unit.x * newScale;
      const newOriginY = mid.y - unit.y * newScale;
      App.Store.setView({ scale: newScale, originX: newOriginX, originY: newOriginY });
      App.dom.qs('#view-scale').value = Math.round(newScale);
      return;
    }

    if (!dragState) return;
    const { screen, world } = mouseWorld(evt);

    if (dragState.kind === 'pan') {
      const dx = screen.x - dragState.startScreen.x, dy = screen.y - dragState.startScreen.y;
      App.Store.setView({ originX: dragState.startOrigin.x + dx, originY: dragState.startOrigin.y + dy });
      return;
    }

    // Live tracking owns an assigned entity's position/rotation and rewrites
    // it ~30 times a second, so dragging one just fights the incoming frames.
    // Ignore the gesture rather than let it flicker.
    if (isLiveDriven(dragState.entity, dragState.entityId)) return;

    if (dragState.kind === 'move') {
      const dx = world.x - dragState.startWorld.x, dy = world.y - dragState.startWorld.y;
      const patch = {
        x: round3(dragState.startEntity.x + dx),
        y: round3(dragState.startEntity.y + dy),
        positionSource: 'manual'
      };
      if (dragState.entity === 'camera') App.Store.updateCamera(dragState.entityId, patch);
      else App.Store.updateProp(dragState.entityId, patch);
      return;
    }

    if (dragState.kind === 'rotate') {
      const dx = world.x - dragState.center.x, dy = world.y - dragState.center.y;
      let deg = Math.atan2(dy, dx) * 180 / Math.PI - 90;
      const patch = { rotationDeg: Math.round(deg * 10) / 10, positionSource: 'manual' };
      if (dragState.entity === 'camera') App.Store.updateCamera(dragState.entityId, patch);
      else App.Store.updateProp(dragState.entityId, patch);
      return;
    }

  }

  function onPointerUp(evt) {
    if (evt && evt.pointerType !== 'mouse') {
      activePointers.delete(evt.pointerId);
      if (dragState && dragState.kind === 'pinch') dragState = null;
    }
    if (dragState && dragState.kind === 'pan') canvas.style.cursor = 'default';
    dragState = null;
  }

  function onWheel(evt) {
    evt.preventDefault();
    const { screen } = mouseWorld(evt);
    const view = getView();
    const worldPt = geo.screenToWorld(view, screen.x, screen.y);
    const factor = evt.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newScale = clamp(view.scale * factor, minScale, 400);
    const unit = projectUnit(worldPt.x, worldPt.y);
    const newOriginX = screen.x - unit.x * newScale;
    const newOriginY = screen.y - unit.y * newScale;
    App.Store.setView({ scale: newScale, originX: newOriginX, originY: newOriginY });
    App.dom.qs('#view-scale').value = Math.round(newScale);
  }

  function fitViewToBounds(minX, maxX, minY, maxY, pad) {
    pad = pad == null ? 40 : pad;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    const worldW = Math.max(0.5, maxX - minX), worldH = Math.max(0.5, maxY - minY);
    let tightScale = Math.min((w - pad * 2) / worldW, (h - pad * 2) / worldH);
    tightScale = clamp(tightScale, 4, 400);
    // Start ~19% further out than the tightest fit (two stacked 10%
    // reductions -- a little breathing room around the studio rather than
    // filling every last pixel). That starting position is the maximum
    // zoom-out -- no further slack beyond it.
    const scale = tightScale * 0.9 * 0.9;
    minScale = scale;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const unit = projectUnit(cx, cy);
    // Anchor a bit above vertical center (not h/2) so the wall sits slightly
    // higher on screen instead of dead-centered.
    const anchorY = h * 0.42;
    App.Store.setView({ scale, originX: w / 2 - unit.x * scale, originY: anchorY - unit.y * scale });
    const scaleInput = App.dom.qs('#view-scale');
    if (scaleInput) { scaleInput.min = Math.round(minScale); scaleInput.value = Math.round(scale); }
  }

  App.canvas = {
    init() {
      canvas = App.dom.qs('#studio-canvas');
      wrap = App.dom.qs('#canvas-wrap');
      ctx = canvas.getContext('2d');

      // Pointer Events unify mouse/touch/pen. Capturing the pointer on the
      // canvas keeps move/up events flowing to it even if the drag leaves
      // the canvas bounds mid-gesture (fast pans, dragging a prop to the
      // window edge), for every input type, without separate window-level
      // mouse listeners.
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', onPointerUp);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      canvas.addEventListener('contextmenu', e => e.preventDefault());

      window.addEventListener('keydown', e => { if (e.code === 'Space') { spaceDown = true; if (canvas) canvas.style.cursor = 'grab'; } });
      window.addEventListener('keyup', e => { if (e.code === 'Space') { spaceDown = false; if (canvas) canvas.style.cursor = 'default'; } });

      window.addEventListener('resize', render);

      App.Store.subscribe(render);
      render();
    },
    render,
    getCanvasElement() { return canvas; },
    getMinScale() { return minScale; },
    fitToStudioSketch() {
      const sketch = window.App.studioSketch;
      if (!sketch) return;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      sketch.objects.forEach(obj => obj.segments.forEach(([a, b]) => {
        [a, b].forEach(([x, y]) => {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        });
      }));
      if (isFinite(minX)) fitViewToBounds(minX, maxX, minY, maxY);
    }
  };
})();
