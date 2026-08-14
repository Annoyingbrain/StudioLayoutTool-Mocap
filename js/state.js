// Central app state store: a plain object plus a tiny pub/sub so UI modules can
// re-render when relevant parts of the setup change, without a framework.
window.App = window.App || {};

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
      positionSource: 'manual' // 'manual' | 'measured' (measured = driven by live tracking)
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
      positionSource: 'manual', // 'manual' | 'measured' (measured = driven by live tracking)
      // Sampled path (app-world {x,y} points) of a recorded camera move
      // (js/motive/liveRecording.js) -- purely a visual trail, not an
      // editable entity. null until a move is recorded.
      trail: null,
      // Position + rotation at the trail's start/end (each { x, y,
      // rotationDeg }), for drawing oriented camera icons at both ends.
      // null until a move is recorded.
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
    // Selecting a prop/camera clears the other -- one Inspector panel,
    // always showing at most one selected item.
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
      // A recording in progress has nowhere to be written now.
      if (App.liveRecording && App.liveRecording.getCameraId() === id) App.liveRecording.cancel();
      this.touch();
    },
    updateCamera(id, patch) {
      const c = currentScene().cameras.find(c => c.id === id);
      if (!c) return;
      Object.assign(c, patch);
      this.touch();
    },

    setFrameGrab(fg) { currentScene().frameGrab = fg; this.touch(); },
    setView(patch) { Object.assign(currentScene().view, patch); emit(); }
  };
})();
