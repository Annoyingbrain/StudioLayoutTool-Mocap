// Central app state store: a plain object plus a tiny pub/sub so UI modules can
// re-render when relevant parts of the setup change, without a framework.
window.App = window.App || {};

App.factories = {
  PROP_COLORS: ['#4da6ff', '#7fd08c', '#e0b95a', '#c98bdb', '#ff8a65', '#5ac8fa'],

  // Cameras get their own, longer list. A camera's colour is what identifies
  // it on the exported floor PNG -- icon, recorded path and caption are all
  // drawn in it -- so two cameras sharing one is the plan telling the crew
  // that two different marks are the same camera. Props don't have that
  // problem: they're white silhouettes on the export.
  //
  // The first six are PROP_COLORS unchanged, so cameras in existing setups
  // keep the colours they already have; the rest extend it. Hues are spread
  // round the wheel rather than being shades of each other, and all of them
  // are mid-tone -- they have to read both on the export's black floor and
  // against a white prop the camera is parked on.
  //
  // Ten of them, not unlimited: past ten cameras in one setup the colours
  // start again (see pickCameraColor). Adding more would mean pairs too close
  // to tell apart at plan scale, which looks unique without being usable.
  CAMERA_COLORS: [
    '#4da6ff', '#7fd08c', '#e0b95a', '#c98bdb', '#ff8a65',
    '#5ac8fa', '#ff7ab8', '#5ee0c0', '#d4e157', '#8c9eff'
  ],

  // The first colour no camera is already using -- tried against the whole
  // setup first, then against the current shoot day alone.
  //
  // Picked by what's TAKEN rather than by counting cameras, for exactly the
  // reason the camera names are (see sidebar.js): after a delete, a count
  // lands back on a colour still in use, and two cameras in one colour is the
  // confusion this is here to prevent.
  //
  // Two scopes because they answer different questions. Setup-wide is the
  // stricter and is tried first, so a small setup never repeats at all.
  // But a week of shooting exhausts ten colours in three days, and after that
  // setup-wide has nothing left to say -- while the thing that actually
  // matters, that no two cameras ON ONE PLAN share a colour, is still
  // satisfiable, because only one day is ever drawn at a time. Hence the
  // day-scoped second pass.
  //
  // Cycles once even that is exhausted: an eleventh camera in one day must
  // still get a colour, and a repeat is better than drawing it as nothing.
  pickCameraColor(takenColors, dayColors, seq) {
    const palette = App.factories.CAMERA_COLORS;
    const takenAnywhere = new Set(takenColors || []);
    const takenToday = new Set(dayColors || []);
    return palette.find(c => !takenAnywhere.has(c))
      || palette.find(c => !takenToday.has(c))
      || palette[(seq || 0) % palette.length];
  },

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
      color: App.factories.CAMERA_COLORS[(colorIndex || 0) % App.factories.CAMERA_COLORS.length],
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

  // A SHOOT DAY. One setup and one position get used across several days:
  // the studio configuration and the position stay put while the set is
  // struck, re-dressed and re-rigged for the day's shots. So the day is a
  // filter over the things that MOVE -- cameras and props -- and each of
  // those belongs to exactly one day. The wall, the positions and the frame
  // grabs are shared by every day.
  //
  // Cameras and props start a new day differently, and deliberately: cameras
  // start fresh (they are re-rigged, so copies would only be deleted again),
  // while props are COPIED forward at their current positions. A set is
  // usually the previous day's set with things nudged, so copying is the
  // shorter road to the day's layout -- and once copied they are separate
  // objects, so nudging one on Day 2 leaves Day 1's plan exactly as it was
  // shot.
  newDay(name) {
    return { id: App.makeId('day'), name: name || 'Day 1' };
  },

  // A scene is one prop layout within a setup -- e.g. different camera
  // angles or shots filmed in the same physical studio configuration.
  // Props, cameras, frame grab, and view are per-scene.
  //
  // Starts with one camera already placed: the studio's camera exists whether
  // or not anyone has drawn it, so a scene is never camera-less (see
  // ensureCamera). Further CAMERA POSITIONS can be added to the same scene --
  // one prop layout shot from several angles -- each a full camera entity
  // with its own placement, lens and recorded move.
  newScene(name, dayId) {
    const now = new Date().toISOString();
    return {
      id: App.makeId('scene'),
      name: name || 'Position 1',
      createdAt: now,
      updatedAt: now,
      props: [],
      cameras: [App.factories.newSceneCamera(dayId)],
      view: { scale: 40, originX: 400, originY: 400 }
    };
  },

  // The camera a scene is never without, for one day. Split out because
  // three places need exactly this -- a new scene, a new day, and the
  // top-up on load -- and they were drifting apart.
  newSceneCamera(dayId) {
    const camera = App.factories.newCamera(
      App.factories.DEFAULT_CAMERA_POS.x, App.factories.DEFAULT_CAMERA_POS.y, 0);
    camera.dayId = dayId || null;
    return camera;
  },

  newSetup(name) {
    const now = new Date().toISOString();
    const day = App.factories.newDay('Day 1');
    const scene = App.factories.newScene('Position 1', day.id);
    return {
      id: App.makeId('setup'),
      name: name || 'Untitled Setup',
      createdAt: now,
      updatedAt: now,
      notes: '',
      days: [day],
      activeDayId: day.id,
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

  // Shoot days, for setups saved before they existed. Everything already in
  // such a setup was shot on one day as far as the file knows, so it gets
  // one -- "Day 1" -- and every camera in it belongs to that day. Doing it
  // any other way (cameras with no day, shown on all days) would leave the
  // day filter meaning two different things depending on a camera's age.
  //
  // Also repairs a dangling activeDayId and any camera whose day was deleted
  // out from under it by hand, since both would otherwise present as "the
  // camera list is empty and nothing I do brings it back".
  function ensureDays(loaded) {
    if (!loaded.days || !loaded.days.length) loaded.days = [App.factories.newDay('Day 1')];
    if (!loaded.days.some(d => d.id === loaded.activeDayId)) loaded.activeDayId = loaded.days[0].id;

    const known = new Set(loaded.days.map(d => d.id));
    const stamp = e => { if (!e.dayId || !known.has(e.dayId)) e.dayId = loaded.days[0].id; };

    (loaded.scenes || []).forEach(scene => {
      (scene.cameras || []).forEach(stamp);

      // Props with NO dayId at all get a COPY ON EVERY DAY, not a stamp onto
      // the first one. Before props belonged to days they were shared by all
      // of them -- one array the whole setup drew from -- so "each day keeps
      // what it had" means every day keeps the lot. Stamping them onto Day 1
      // instead is what a stamp literally does and it is wrong here: a setup
      // already carrying Day 1 and Day 2 came back with its entire set on
      // Day 1 and Day 2 empty, which reads as the dressing having been
      // deleted.
      //
      // Snapshotted before the loop because the copies are pushed onto the
      // same array being read.
      const shared = (scene.props || []).filter(p => !p.dayId);
      (scene.props || []).forEach(p => { if (p.dayId && !known.has(p.dayId)) p.dayId = loaded.days[0].id; });
      if (!shared.length) return;

      shared.forEach(p => { p.dayId = loaded.days[0].id; });
      loaded.days.slice(1).forEach(day => {
        shared.forEach(p => {
          // New ids, for the same reason addDay's copies get them: updateProp
          // finds a prop by id, so shared ids would have a drag on one day
          // patching another day's copy.
          scene.props.push(Object.assign({}, p, { id: App.makeId('prop'), dayId: day.id }));
        });
      });
    });
    return loaded;
  }

  // Every scene has at least one camera FOR EVERY DAY. Setups saved before
  // that was true (and any hand-edited .json) can arrive with none, which
  // would leave the scene with nothing to inspect and no camera to link a
  // tracker to -- so top it up on the way in rather than leaving a dead end.
  // More can be added on top ("+ Add Camera Position"); this only guarantees
  // the floor.
  //
  // Per day, not per scene: switching to a day with no camera in it is the
  // same dead end as a camera-less scene, and the rest of the app doesn't
  // accept it any more there than it did here. Runs after ensureDays, so the
  // day list is real by now.
  function ensureCamera(loaded) {
    (loaded.scenes || []).forEach(scene => {
      if (!scene.cameras) scene.cameras = [];
      loaded.days.forEach(day => {
        if (!scene.cameras.some(c => c.dayId === day.id)) {
          scene.cameras.push(App.factories.newSceneCamera(day.id));
        }
      });
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
    setSetup(newSetup) { setup = migrateFrameGrab(ensureCamera(ensureDays(newSetup))); selectedPropId = null; selectedCameraId = null; emit(); },
    touch() { setup.updatedAt = new Date().toISOString(); emit(); },

    getScene() { return currentScene(); },

    // --- shoot days ---
    //
    // One setup and one position are used across several days; what changes
    // between them is where the cameras go. So a day filters CAMERAS and
    // nothing else -- the props, the positions and the frame grabs are shared
    // -- and every camera belongs to exactly one day.
    getDays() { return setup.days; },
    getActiveDayId() { return setup.activeDayId; },
    getDay() { return setup.days.find(d => d.id === setup.activeDayId) || setup.days[0]; },
    selectDay(id) {
      if (!setup.days.some(d => d.id === id) || id === setup.activeDayId) return;
      setup.activeDayId = id;
      // The selection belongs to the day being left, so it isn't on screen
      // any more -- leaving it would have the inspector editing something
      // nobody can see.
      selectedCameraId = null;
      selectedPropId = null;
      emit();
    },
    renameDay(id, name) {
      const day = setup.days.find(d => d.id === id);
      if (!day) return;
      day.name = name;
      this.touch();
    },

    // A new day starts with one camera per position and a COPY of the day
    // you were on's props.
    //
    // The asymmetry is the point. Cameras are re-rigged for the day's shots
    // -- that is what makes it a different day -- so copies would only mean
    // deleting them again. The set, though, is usually the last day's set
    // with things moved, so starting from it is the shorter road; starting
    // empty would mean re-placing a dressed room every morning.
    //
    // The copies are NEW OBJECTS WITH NEW IDS, which is the whole point:
    // sharing them (which is what a day filter over one array amounts to)
    // means dragging a table on Day 2 also drags it on Day 1, silently
    // rewriting a plan that has already been shot. New ids because
    // updateProp finds a prop by id and would otherwise patch whichever
    // day's copy came first.
    addDay(name) {
      const day = App.factories.newDay(name);
      const from = setup.activeDayId;
      setup.days.push(day);

      setup.scenes.forEach(scene => {
        scene.cameras.push(App.factories.newSceneCamera(day.id));
        scene.props.filter(p => p.dayId === from).forEach(p => {
          const copy = Object.assign({}, p, { id: App.makeId('prop'), dayId: day.id });
          scene.props.push(copy);
          // A tracker parked on the original follows it onto the new day.
          // Without this the T-bar carries on driving yesterday's prop --
          // invisible, on another day's plan -- and the measurement lands
          // somewhere nobody is looking, which is the silent-failure mode
          // this app keeps having to design against.
          if (App.liveTracking) {
            const rb = App.liveTracking.getRigidBodyDriving('prop', p.id);
            if (rb) App.liveTracking.assign(rb, 'prop', copy.id);
          }
        });
      });

      setup.activeDayId = day.id;
      selectedCameraId = null;
      selectedPropId = null;
      this.touch();
      return day;
    },

    // Deleting a day deletes its cameras AND its props, in every position --
    // they only exist for that day. Never the last one: a setup with no days
    // has no cameras anywhere, which is the dead end ensureCamera exists to
    // prevent.
    removeDay(id) {
      if (setup.days.length <= 1) return;
      setup.days = setup.days.filter(d => d.id !== id);
      setup.scenes.forEach(scene => {
        scene.cameras = scene.cameras.filter(c => {
          if (c.dayId !== id) return true;
          if (App.liveTracking) App.liveTracking.unassignEntity('camera', c.id);
          if (App.liveRecording && App.liveRecording.getCameraId() === c.id) App.liveRecording.cancel();
          return false;
        });
        scene.props = scene.props.filter(p => {
          if (p.dayId !== id) return true;
          if (App.liveTracking) App.liveTracking.unassignEntity('prop', p.id);
          return false;
        });
      });
      if (!setup.days.some(d => d.id === setup.activeDayId)) setup.activeDayId = setup.days[0].id;
      selectedCameraId = null;
      this.touch();
    },

    // The scene as the EXPORTS should see it: this day's cameras only, plus
    // the day's name for the heading and the filename. A render-time view,
    // not the stored scene -- which still holds every day's cameras.
    //
    // Done here rather than in the three renderers because they already drift
    // apart badly enough (see CLAUDE.md); filtering at the call site means
    // the floor PNG, the CSV and the report cannot disagree about which day
    // they are drawing.
    getSceneForDay() {
      const day = this.getDay();
      return Object.assign({}, currentScene(), {
        // VISIBLE props but ALL cameras, which looks inconsistent and isn't:
        // see getVisibleProps. A hidden prop is one that isn't in the shot,
        // so the plan must not show it; a hidden camera is only decluttered
        // off the screen, and dropping it from the plan would lose a mark the
        // crew shoots from with nothing on the page to say so.
        props: this.getVisibleProps(),
        cameras: this.getCameras(),
        dayName: day ? day.name : ''
      });
    },

    // Every camera colour in use anywhere in the setup, for
    // factories.pickCameraColor. Across all positions, not just the open one:
    // positions share cameras, so a per-position answer would give the same
    // camera different colours depending where it was added.
    getSetupCameraColors() {
      const colors = [];
      (setup.scenes || []).forEach(s => (s.cameras || []).forEach(c => { if (c.color) colors.push(c.color); }));
      return colors;
    },

    // The same, narrowed to one shoot day -- the set that can actually appear
    // on a single plan together. pickCameraColor falls back to this once the
    // palette is used up setup-wide, which a week of shooting does.
    getDayCameraColors() {
      const colors = [];
      (setup.scenes || []).forEach(s => (s.cameras || []).forEach(c => {
        if (c.color && c.dayId === setup.activeDayId) colors.push(c.color);
      }));
      return colors;
    },
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
    // Day-scoped, like getSelectedCamera: a prop from another day isn't on
    // screen, so it must not come back as the selection being edited.
    getSelectedProp() { return this.getProps().find(p => p.id === selectedPropId) || null; },

    getSelectedCameraId() { return selectedCameraId; },
    selectCamera(id) { selectedCameraId = id; if (id) selectedPropId = null; emit(); },
    // Day-scoped, like every other listing accessor: a camera from another
    // shoot day isn't on screen, so it must not come back as the selection
    // the inspector edits and the canvas highlights.
    getSelectedCamera() { return this.getCameras().find(c => c.id === selectedCameraId) || null; },

    // The camera the inspector edits. With a single camera there's nothing
    // to choose, so it stays editable without having to be selected on the
    // canvas first -- selection then only drives highlighting and dragging.
    // A setup with several cameras still needs an explicit pick, so this
    // can't silently edit the wrong one.
    getInspectedCamera() {
      const cameras = this.getCameras();
      if (cameras.length === 1) return cameras[0];
      return this.getSelectedCamera();
    },

    getTool() { return tool; },
    setTool(t) { tool = t; emit(); },

    // THE CURRENT DAY's props, the same rule as getCameras(): everything that
    // lists, draws, hit-tests or exports props comes through here.
    getProps() { return currentScene().props.filter(p => p.dayId === setup.activeDayId); },

    // Unfiltered lookup by id, for live tracking -- which holds a prop id and
    // must keep resolving it even if the day is switched mid-measurement.
    findProp(id) { return currentScene().props.find(p => p.id === id) || null; },

    // Hiding a prop takes it OUT OF THE PLAN, not just off the screen -- the
    // exact opposite of hiding a camera, and the difference is the whole
    // point of each.
    //
    // A hidden CAMERA is decluttering: several camera positions pile up on
    // one layout, so it comes off the canvas while every export still draws
    // it, because dropping a camera from the plan the crew shoots from would
    // be dangerous and invisible.
    //
    // A hidden PROP means "this piece isn't in this shot". It's the
    // alternative to deleting it, so the plan has to agree -- a prop drawn on
    // the floor PNG that isn't on the floor is exactly the error hiding is
    // there to avoid. Per day and per position for free, since props already
    // are: hiding the sofa on Day 2 leaves Day 1's sofa alone.
    //
    // Absent reads as visible, so nothing needed migrating.
    getVisibleProps() { return this.getProps().filter(p => !p.hidden); },
    getHiddenPropCount() { return this.getProps().filter(p => p.hidden).length; },
    togglePropHidden(id) {
      const p = currentScene().props.find(p => p.id === id);
      if (!p) return;
      p.hidden = !p.hidden;
      this.touch();
    },
    showAllProps() {
      this.getProps().forEach(p => { p.hidden = false; });
      this.touch();
    },

    // Stamped here rather than at the call site: props are created by the
    // canvas's add-prop tool, and a prop with no day is invisible the moment
    // it's placed -- a failure that looks like the click not registering.
    addProp(prop) {
      if (!prop.dayId) prop.dayId = setup.activeDayId;
      currentScene().props.push(prop);
      selectedPropId = prop.id;
      selectedCameraId = null;
      this.touch();
    },
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

    // THE CURRENT DAY's cameras. Everything that lists, draws or exports
    // cameras comes through here, so the day filter is applied once rather
    // than in each of them.
    getCameras() { return currentScene().cameras.filter(c => c.dayId === setup.activeDayId); },

    // Every camera in the position, whatever day it belongs to. For LOOKUPS
    // BY ID only -- live tracking and an in-progress recording hold a camera
    // id and must keep finding it after the day is switched, or a recording
    // silently stops writing halfway through.
    findCamera(id) { return currentScene().cameras.find(c => c.id === id) || null; },

    // What js/canvas.js draws and hit-tests. Everything else -- the camera
    // list, the inspector, the exports -- goes through getCameras() and sees
    // hidden ones too, which is what keeps a hidden camera editable and
    // findable rather than gone.
    getVisibleCameras() { return this.getCameras().filter(c => !c.hidden); },
    getHiddenCameraCount() { return this.getCameras().filter(c => c.hidden).length; },
    toggleCameraHidden(id) {
      const c = currentScene().cameras.find(c => c.id === id);
      if (!c) return;
      c.hidden = !c.hidden;
      this.touch();
    },
    showAllCameras() {
      this.getCameras().forEach(c => { c.hidden = false; });
      this.touch();
    },
    addCamera(camera) {
      // Belt and braces with the sidebar's own stamp: a camera with no day is
      // invisible the moment it's added, which reads as the button doing
      // nothing.
      if (!camera.dayId) camera.dayId = setup.activeDayId;
      currentScene().cameras.push(camera);
      selectedCameraId = camera.id;
      selectedPropId = null;
      this.touch();
    },
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
