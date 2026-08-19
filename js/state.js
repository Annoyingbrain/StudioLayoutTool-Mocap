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
      // Numbered from the start, because a scene can hold several camera
      // positions -- a bare "Camera" sitting next to "Camera 2" reads as an
      // odd one out rather than the first of a set. Renamed to the shot it
      // covers in practice (the camera list's name field).
      name: 'Camera 1',
      x, y,
      rotationDeg: 0,
      color: App.factories.PROP_COLORS[(colorIndex || 0) % App.factories.PROP_COLORS.length],
      notes: '',
      // Lens focal length in mm -- typed in by hand (nothing in the tracking
      // data knows it) and printed on the Disguise floor PNG. null = unset.
      focalLengthMm: null,
      // Height above the studio floor (m) and tilt (deg, + = pointing up),
      // both derived from live tracking -- see js/motive/liveTracking.js.
      // null until the camera has been tracked at least once.
      heightM: null,
      tiltDeg: null,
      positionSource: 'manual', // 'manual' | 'measured' (measured = driven by live tracking)
      // Sampled path (app-world {x,y} points) of a recorded camera move
      // (js/motive/liveRecording.js) -- purely a visual trail, not an
      // editable entity. null until a move is recorded.
      trail: null,
      // Position + rotation at the trail's start/end (each { x, y,
      // rotationDeg }), for drawing oriented camera icons at both ends.
      // null until a move is recorded.
      trailEndpoints: null,
      // The reference frame grab for THIS camera position ({ imageDataUrl,
      // caption } or null). Per camera, not per position: one prop layout is
      // shot from several positions and the grab is what each of those
      // positions is meant to look like, so a single one per layout could
      // only ever describe one of them.
      frameGrab: null,
      // ON-SCREEN visibility only. Several camera positions in one prop
      // layout overlap into an unreadable pile, so they can be hidden while
      // working on one of them. EXPORTS DELIBERATELY IGNORE THIS -- the
      // floor PNG, the Disguise CSV and the report all carry every camera,
      // because this is a decluttering aid, not a way to leave a camera out
      // of the plan the crew shoots from. Absent (old setups, hand-edited
      // JSON) reads as visible, so nothing needs migrating.
      hidden: false
    };
  },

  // Where a scene's camera starts: the studio's real floor centre, 4.5m out
  // from the LED wall's north point (the same landmark js/canvas.js draws
  // its grid from, and js/motive/motiveTransform.js calibrates against).
  // Somewhere real and recognisable to drag from, rather than the mesh
  // export's arbitrary (0,0).
  DEFAULT_CAMERA_POS: { x: 5.975, y: -4.318 },

  // A scene is one prop layout within a setup -- e.g. different camera
  // angles or shots filmed in the same physical studio configuration.
  // Props, cameras, frame grab, and view are per-scene.
  //
  // Starts with one camera already placed: the studio's camera exists whether
  // or not anyone has drawn it, so a scene is never camera-less (see
  // ensureCamera). Further CAMERA POSITIONS can be added to the same scene --
  // one prop layout shot from several angles -- each a full camera entity
  // with its own placement, lens and recorded move.
  newScene(name) {
    const now = new Date().toISOString();
    return {
      id: App.makeId('scene'),
      name: name || 'Position 1',
      createdAt: now,
      updatedAt: now,
      props: [],
      cameras: [App.factories.newCamera(
        App.factories.DEFAULT_CAMERA_POS.x, App.factories.DEFAULT_CAMERA_POS.y, 0)],
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

  // Every scene has at least one camera. Setups saved before that was true
  // (and any hand-edited .json) can arrive with none, which would leave the
  // scene with nothing to inspect and no camera to link a tracker to -- so
  // top it up on the way in rather than leaving a dead end. More can be
  // added on top ("+ Add Camera Position"); this only guarantees the floor.
  function ensureCamera(loaded) {
    (loaded.scenes || []).forEach(scene => {
      if (!scene.cameras || !scene.cameras.length) {
        scene.cameras = [App.factories.newCamera(
          App.factories.DEFAULT_CAMERA_POS.x, App.factories.DEFAULT_CAMERA_POS.y, 0)];
      }
    });
    return loaded;
  }

  // Frame grabs used to hang off the scene, one per position. They now hang
  // off a camera, because a position can hold several camera positions and
  // one picture can only be of one of them. Anything saved before that
  // arrives with scene.frameGrab set: hand it to the scene's first camera
  // rather than dropping it. Runs after ensureCamera, so there is always one
  // to hand it to.
  function migrateFrameGrab(loaded) {
    (loaded.scenes || []).forEach(scene => {
      if (!scene.frameGrab) return;
      if (scene.cameras[0] && !scene.cameras[0].frameGrab) scene.cameras[0].frameGrab = scene.frameGrab;
      delete scene.frameGrab;
    });
    return loaded;
  }

  return {
    subscribe(fn) { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); },

    getSetup() { return setup; },
    setSetup(newSetup) { setup = migrateFrameGrab(ensureCamera(newSetup)); selectedPropId = null; selectedCameraId = null; emit(); },
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
      const from = currentScene();
      const scene = App.factories.newScene(name);
      // Cameras carry over to a new position; props don't. A camera is
      // studio hardware that exists for every shot -- it gets moved between
      // positions, not removed -- so it has to stay selectable and stay
      // assignable to a live rigid body. Props are dressed per position, so
      // a new one starts empty.
      //
      // Each position keeps its own placement of those cameras (the copy
      // starts where they were, and moves independently from there), but
      // the id is deliberately preserved: live tracking assignments point at
      // a camera id, so reusing it means tracking keeps driving the right
      // camera across a position switch instead of silently going nowhere.
      scene.cameras = from.cameras.map(c => Object.assign({}, c, {
        // A recorded move belongs to the position it was recorded in.
        trail: null,
        trailEndpoints: null,
        // So does a frame grab: it's a picture of a shot, and a new position
        // is a new prop layout, so the old one would be describing something
        // that is no longer in front of the camera.
        frameGrab: null
      }));
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

    // The camera the inspector edits. With a single camera there's nothing
    // to choose, so it stays editable without having to be selected on the
    // canvas first -- selection then only drives highlighting and dragging.
    // A setup with several cameras still needs an explicit pick, so this
    // can't silently edit the wrong one.
    getInspectedCamera() {
      const cameras = currentScene().cameras;
      if (cameras.length === 1) return cameras[0];
      return this.getSelectedCamera();
    },

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

    // What js/canvas.js draws and hit-tests. Everything else -- the camera
    // list, the inspector, the exports -- goes through getCameras() and sees
    // hidden ones too, which is what keeps a hidden camera editable and
    // findable rather than gone.
    getVisibleCameras() { return currentScene().cameras.filter(c => !c.hidden); },
    getHiddenCameraCount() { return currentScene().cameras.filter(c => c.hidden).length; },
    toggleCameraHidden(id) {
      const c = currentScene().cameras.find(c => c.id === id);
      if (!c) return;
      c.hidden = !c.hidden;
      this.touch();
    },
    showAllCameras() {
      currentScene().cameras.forEach(c => { c.hidden = false; });
      this.touch();
    },
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

    // Both go through getInspectedCamera(), the same camera the Inspector
    // edits: with one camera there is nothing to pick, with several there is,
    // and null means "nothing is picked" rather than "no frame grab".
    getFrameGrab() {
      const camera = this.getInspectedCamera();
      return camera ? camera.frameGrab : null;
    },
    setFrameGrab(fg) {
      const camera = this.getInspectedCamera();
      if (!camera) return;
      camera.frameGrab = fg;
      this.touch();
    },
    setView(patch) { Object.assign(currentScene().view, patch); emit(); }
  };
})();
