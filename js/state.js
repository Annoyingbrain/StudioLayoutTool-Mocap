// Central app state store: a plain object plus a tiny pub/sub so UI modules can
// re-render when relevant parts of the setup change, without a framework.
window.App = window.App || {};

// The 5 points on a rectangular prop that can be individually captured via
// the Motive wand: its center, and each of its 4 corners (indices match
// App.geometry.propCorners() / the on-canvas resize handles).
App.PROP_POINTS = [
  { key: 'center', label: 'Center' },
  { key: 'corner0', label: 'Corner 1' },
  { key: 'corner1', label: 'Corner 2' },
  { key: 'corner2', label: 'Corner 3' },
  { key: 'corner3', label: 'Corner 4' }
];

// Which of App.PROP_POINTS are measurable on a given prop. A circular prop
// has no corners (it's rotationally symmetric), so it can only ever be
// measured/positioned from its center point. A triangular prop has only 3
// corners (corner0..corner2 -- see geometry.localCornerOffsets), so corner3
// doesn't apply.
App.propPointsFor = function (prop) {
  if (prop.shape === 'circle') return App.PROP_POINTS.filter(p => p.key === 'center');
  if (prop.shape === 'triangle') return App.PROP_POINTS.filter(p => p.key !== 'corner3');
  return App.PROP_POINTS;
};

// Cameras are a separate category from props: tracked via 3 markers on the
// camera body (back + left + right) rather than a resizable rect's 5 points.
App.CAMERA_POINTS = [
  { key: 'back', label: 'Back' },
  { key: 'left', label: 'Left' },
  { key: 'right', label: 'Right' }
];

// Camera marker rig geometry (measured 2026-08-14, Reference trackers/
// Camera.csv): Motive's Marker001=back, Marker002=right, Marker003=left.
// Local frame: origin at the left/right midpoint (= the camera's x/y),
// +Y = forward (lens direction, away from the back marker), +X = camera's
// right -- matching the "local +Y = front" convention js/canvas.js's
// direction arrow already uses for rect props.
(function () {
  const distBackRight = 0.23, distRightLeft = 0.12, distBackLeft = 0.26;
  const w = distRightLeft;
  const bx = (distBackLeft ** 2 - distBackRight ** 2) / (2 * w);
  const by = -Math.sqrt(Math.max(0, distBackRight ** 2 - (bx - w / 2) ** 2));
  App.cameraLocalMarkers = {
    right: { x: w / 2, y: 0 },
    left: { x: -w / 2, y: 0 },
    back: { x: bx, y: by }
  };
})();

App.factories = {
  PROP_COLORS: ['#4da6ff', '#7fd08c', '#e0b95a', '#c98bdb', '#ff8a65', '#5ac8fa'],

  newProp(x, y, colorIndex) {
    return {
      id: App.makeId('prop'),
      name: 'Prop',
      shape: 'rect', // 'rect' | 'circle' | 'triangle' -- for 'circle', depthM is kept equal to widthM (the diameter)
      widthM: 1,
      depthM: 0.6,
      heightM: 1,
      x, y,
      rotationDeg: 0,
      color: App.factories.PROP_COLORS[(colorIndex || 0) % App.factories.PROP_COLORS.length],
      notes: '',
      positionSource: 'manual', // 'manual' | 'measured'
      measuredPoints: { center: null, corner0: null, corner1: null, corner2: null, corner3: null },
      lastSolve: null // { rotationDeg, pointCount, fitRms } from the last successful solve
    };
  },

  newCamera(x, y, colorIndex) {
    return {
      id: App.makeId('camera'),
      name: 'Camera',
      x, y,
      rotationDeg: 0,
      color: App.factories.PROP_COLORS[(colorIndex || 0) % App.factories.PROP_COLORS.length],
      notes: '',
      positionSource: 'manual', // 'manual' | 'measured'
      measuredMarkers: { back: null, left: null, right: null },
      lastSolve: null,
      // Sampled path (app-world {x,y} points) from a dolly-move Motive
      // recording (js/ui/cameraCapture.js) -- purely a visual trail, not an
      // editable/solved entity. null until a track CSV is loaded.
      trail: null,
      // Position + rotation at the trail's start/end (each { x, y,
      // rotationDeg }), for drawing oriented camera icons at both ends.
      // null until a track CSV is loaded.
      trailEndpoints: null
    };
  },

  // A scene is one prop layout within a setup -- e.g. different camera
  // angles or shots filmed in the same physical studio configuration.
  // Props, cameras, frame grab, and view are per-scene.
  newScene(name) {
    const now = new Date().toISOString();
    return {
      id: App.makeId('scene'),
      name: name || 'Position 1',
      createdAt: now,
      updatedAt: now,
      props: [],
      cameras: [],
      frameGrab: null,    // { imageDataUrl, caption }
      view: { scale: 40, originX: 400, originY: 400 }
    };
  },

  newSetup(name) {
    const now = new Date().toISOString();
    const scene = App.factories.newScene('Position 1');
    return {
      id: App.makeId('setup'),
      name: name || 'Untitled Setup',
      createdAt: now,
      updatedAt: now,
      notes: '',
      scenes: [scene],
      activeSceneId: scene.id
    };
  }
};

App.Store = (function () {
  let setup = App.factories.newSetup('Untitled Setup');
  let selectedPropId = null;
  let selectedCameraId = null;
  let tool = 'select';
  const listeners = [];

  function emit() { listeners.forEach(fn => fn(setup)); }
  function currentScene() { return setup.scenes.find(s => s.id === setup.activeSceneId) || setup.scenes[0]; }

  return {
    subscribe(fn) { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); },

    getSetup() { return setup; },
    setSetup(newSetup) { setup = newSetup; selectedPropId = null; selectedCameraId = null; emit(); },
    touch() { setup.updatedAt = new Date().toISOString(); emit(); },

    getScene() { return currentScene(); },
    getScenes() { return setup.scenes; },
    getActiveSceneId() { return setup.activeSceneId; },
    selectScene(id) {
      if (!setup.scenes.some(s => s.id === id) || id === setup.activeSceneId) return;
      setup.activeSceneId = id;
      selectedPropId = null;
      selectedCameraId = null;
      emit();
    },
    addScene(name) {
      const scene = App.factories.newScene(name);
      setup.scenes.push(scene);
      setup.activeSceneId = scene.id;
      selectedPropId = null;
      selectedCameraId = null;
      this.touch();
      return scene;
    },
    renameScene(id, name) {
      const s = setup.scenes.find(s => s.id === id);
      if (!s) return;
      s.name = name;
      this.touch();
    },
    removeScene(id) {
      if (setup.scenes.length <= 1) return; // a setup always keeps at least 1 scene
      const idx = setup.scenes.findIndex(s => s.id === id);
      if (idx === -1) return;
      setup.scenes.splice(idx, 1);
      if (setup.activeSceneId === id) setup.activeSceneId = setup.scenes[Math.max(0, idx - 1)].id;
      selectedPropId = null;
      selectedCameraId = null;
      this.touch();
    },

    getSelectedPropId() { return selectedPropId; },
    // Selecting a prop/camera clears the other -- one Inspector panel, one
    // Motive Capture panel, always showing at most one selected item.
    selectProp(id) { selectedPropId = id; if (id) selectedCameraId = null; emit(); },
    getSelectedProp() { return currentScene().props.find(p => p.id === selectedPropId) || null; },

    getSelectedCameraId() { return selectedCameraId; },
    selectCamera(id) { selectedCameraId = id; if (id) selectedPropId = null; emit(); },
    getSelectedCamera() { return currentScene().cameras.find(c => c.id === selectedCameraId) || null; },

    getTool() { return tool; },
    setTool(t) { tool = t; emit(); },

    addProp(prop) { currentScene().props.push(prop); selectedPropId = prop.id; selectedCameraId = null; this.touch(); },
    removeProp(id) {
      const scene = currentScene();
      scene.props = scene.props.filter(p => p.id !== id);
      if (selectedPropId === id) selectedPropId = null;
      if (App.liveTracking) App.liveTracking.unassignEntity('prop', id);
      this.touch();
    },
    updateProp(id, patch) {
      const p = currentScene().props.find(p => p.id === id);
      if (!p) return;
      Object.assign(p, patch);
      this.touch();
    },

    getCameras() { return currentScene().cameras; },
    addCamera(camera) { currentScene().cameras.push(camera); selectedCameraId = camera.id; selectedPropId = null; this.touch(); },
    removeCamera(id) {
      const scene = currentScene();
      scene.cameras = scene.cameras.filter(c => c.id !== id);
      if (selectedCameraId === id) selectedCameraId = null;
      if (App.liveTracking) App.liveTracking.unassignEntity('camera', id);
      this.touch();
    },
    updateCamera(id, patch) {
      const c = currentScene().cameras.find(c => c.id === id);
      if (!c) return;
      Object.assign(c, patch);
      this.touch();
    },

    setFrameGrab(fg) { currentScene().frameGrab = fg; this.touch(); },
    setView(patch) { Object.assign(currentScene().view, patch); emit(); },

    // patch: { world: {x,y}, jitterMm, frameCount, sourceFile, capturedAt }
    // (js/ui/motiveCapture.js) -- a Motive capture already IS the solved
    // world point, no separate distances/solve step like the old DISTO flow.
    updateMeasuredPoint(propId, pointKey, patch) {
      const p = currentScene().props.find(p => p.id === propId);
      if (!p) return;
      p.measuredPoints[pointKey] = Object.assign({}, p.measuredPoints[pointKey], patch);
      this.touch();
    },
    clearMeasuredPoint(propId, pointKey) {
      const p = currentScene().props.find(p => p.id === propId);
      if (!p) return;
      p.measuredPoints[pointKey] = null;
      this.touch();
    },

    updateMeasuredCameraMarker(cameraId, markerKey, patch) {
      const c = currentScene().cameras.find(c => c.id === cameraId);
      if (!c) return;
      c.measuredMarkers[markerKey] = Object.assign({}, c.measuredMarkers[markerKey], patch);
      this.touch();
    },
    clearMeasuredCameraMarker(cameraId, markerKey) {
      const c = currentScene().cameras.find(c => c.id === cameraId);
      if (!c) return;
      c.measuredMarkers[markerKey] = null;
      this.touch();
    },

    // Recomputes the prop's x/y/rotationDeg from whichever of its 5 points have a
    // captured (Motive-derived) world position. 1 captured point -> translate only
    // (keeps current rotation). 2+ -> least-squares rotation + translation fit.
    solvePropTransform(propId) {
      const p = currentScene().props.find(p => p.id === propId);
      if (!p) return null;
      const correspondences = [];
      App.propPointsFor(p).forEach(({ key }) => {
        const mp = p.measuredPoints[key];
        if (mp && mp.world) {
          correspondences.push({ local: App.geometry.pointLocalOffset(p, key), world: { x: mp.world.x, y: mp.world.y } });
        }
      });
      const result = App.rigidFit.solve(correspondences, p.rotationDeg);
      if (!result) return null;
      p.x = Math.round(result.x * 1000) / 1000;
      p.y = Math.round(result.y * 1000) / 1000;
      p.rotationDeg = Math.round(result.rotationDeg * 10) / 10;
      p.positionSource = 'measured';
      p.lastSolve = result;
      this.touch();
      return result;
    },

    // Same idea as solvePropTransform: each of the camera's 3 markers has a
    // known fixed local offset (App.cameraLocalMarkers, from the physical
    // rig's measured marker spacing). 1 captured marker only translates
    // (rotation kept as-is); 2-3 solve rotation + translation via the same
    // least-squares Procrustes fit (js/rigidFit.js).
    solveCameraTransform(cameraId) {
      const c = currentScene().cameras.find(c => c.id === cameraId);
      if (!c) return null;
      const correspondences = [];
      App.CAMERA_POINTS.forEach(({ key }) => {
        const mp = c.measuredMarkers[key];
        if (mp && mp.world) {
          correspondences.push({ local: App.cameraLocalMarkers[key], world: { x: mp.world.x, y: mp.world.y } });
        }
      });
      const result = App.rigidFit.solve(correspondences, c.rotationDeg);
      if (!result) return null;
      c.x = Math.round(result.x * 1000) / 1000;
      c.y = Math.round(result.y * 1000) / 1000;
      c.rotationDeg = Math.round(result.rotationDeg * 10) / 10;
      c.positionSource = 'measured';
      c.lastSolve = result;
      this.touch();
      return result;
    }
  };
})();
