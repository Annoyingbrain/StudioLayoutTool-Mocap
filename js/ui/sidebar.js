// Prop list + prop inspector panel, and camera list + camera inspector panel.
window.App = window.App || {};

(function () {
  const dom = App.dom;

  // Width/Depth/Height are always stored in meters (widthM/depthM/heightM);
  // this only controls how the inspector displays/parses those three fields.
  let sizeUnit = 'm';
  const fromMeters = v => sizeUnit === 'cm' ? v * 100 : v;
  const toMeters = v => sizeUnit === 'cm' ? v / 100 : v;
  const roundDisplay = v => Math.round(v * 1000) / 1000;

  // e.g. 1 -> "1m", 3.39 -> "3m 39cm", 0.05 -> "5cm"
  function formatMeters(m) {
    if (m == null || isNaN(m)) return '';
    const totalCm = Math.round(m * 100);
    const sign = totalCm < 0 ? '-' : '';
    const absCm = Math.abs(totalCm);
    const meters = Math.floor(absCm / 100), cm = absCm % 100;
    if (meters === 0) return `${sign}${cm}cm`;
    if (cm === 0) return `${sign}${meters}m`;
    return `${sign}${meters}m ${cm}cm`;
  }

  // One button per prop-measuring tracker, for parking a tracker on a prop
  // long enough to read its position and moving straight on to the next --
  // the alternative being the Live Tracking panel's dropdown, which means
  // leaving the prop list and hunting for the right entity each time.
  //
  // Assignments are keyed by tracker name and hold exactly one entity, so
  // linking T-bar to a second prop releases the first automatically; that's
  // the measure-and-move-on workflow rather than something to guard against.
  function renderTrackerLinkButtons(prop) {
    return App.motiveCalibration.propTrackerNames.map(trackerName => {
      const assignment = App.liveTracking.getAssignmentFor(trackerName);
      const linkedHere = !!assignment && assignment.entityType === 'prop' && assignment.entityId === prop.id;
      const elsewhere = !!assignment && !linkedHere;
      return dom.el('button', {
        class: 'prop-row-link' + (linkedHere ? ' active' : ''),
        text: trackerName,
        title: linkedHere
          ? `${trackerName} is driving "${prop.name}" — click to release it`
          : `Measure "${prop.name}" with ${trackerName}` +
            (elsewhere ? ' (releases whatever it is on now)' : ''),
        onclick: (e) => {
          // Without this the row's own handler also fires and changes the
          // selection, yanking the inspector to a different prop mid-measure.
          e.stopPropagation();
          if (linkedHere) App.liveTracking.unassign(trackerName);
          else App.liveTracking.assign(trackerName, 'prop', prop.id);
        }
      });
    });
  }

  // Rebuilding this list replaces its buttons, and both the Store and
  // liveTracking emit on every applied frame (~30Hz) -- so a rebuild per
  // emit would leave the link buttons unclickable exactly while tracking is
  // live, which is when they're used. Same fix as js/ui/liveTrackingUi.js:
  // only rebuild when something STRUCTURAL changes, and let the per-frame
  // path rewrite the measured/manual badge in place.
  function propListStructureKey() {
    const scene = App.Store.getScene();
    return [
      scene.props.map(p => `${p.id}:${p.name}:${p.color}`).join('|'),
      App.Store.getSelectedPropId(),
      JSON.stringify(App.liveTracking.getAssignments())
    ].join('##');
  }

  const propSrcElById = {};
  let lastPropListKey = null;

  function renderPropList() {
    const scene = App.Store.getScene();
    dom.qs('#prop-count').textContent = `(${scene.props.length})`;

    const key = propListStructureKey();
    if (key === lastPropListKey) {
      scene.props.forEach(p => {
        const el = propSrcElById[p.id];
        if (!el) return;
        const measured = p.positionSource === 'measured';
        const text = measured ? 'measured' : 'manual';
        if (el.textContent !== text) el.textContent = text;
        el.className = 'prop-row-src' + (measured ? ' measured' : '');
      });
      return;
    }
    lastPropListKey = key;

    const selectedId = App.Store.getSelectedPropId();
    const list = dom.qs('#prop-list');
    dom.clear(list);
    Object.keys(propSrcElById).forEach(k => delete propSrcElById[k]);

    scene.props.forEach(p => {
      const srcEl = dom.el('span', {
        class: 'prop-row-src' + (p.positionSource === 'measured' ? ' measured' : ''),
        text: p.positionSource === 'measured' ? 'measured' : 'manual'
      });
      propSrcElById[p.id] = srcEl;

      // Two lines: colour + name on top, controls underneath -- see the
      // .prop-row rules. On one line a prop's name was competing for width
      // with a badge and one button per tracker, so it ellipsised away to
      // nothing on the tablet's narrow drawer exactly when the list needed
      // to be readable one-handed.
      const row = dom.el('div', {
        class: 'prop-row' + (p.id === selectedId ? ' selected' : ''),
        onclick: () => App.Store.selectProp(p.id)
      }, [
        dom.el('div', { class: 'prop-row-main' }, [
          dom.el('span', { class: 'swatch', style: `background:${p.color}` }),
          dom.el('span', { class: 'prop-row-name', text: p.name })
        ]),
        dom.el('div', { class: 'prop-row-actions' }, [srcEl].concat(renderTrackerLinkButtons(p)))
      ]);
      list.appendChild(row);
    });
  }

  function renderPropPicker() {
    const scene = App.Store.getScene();
    const selectedId = App.Store.getSelectedPropId();
    const picker = dom.qs('#insp-prop-picker');
    if (document.activeElement === picker) return;
    dom.clear(picker);
    picker.appendChild(dom.el('option', { value: '', text: 'Select a prop…' }));
    scene.props.forEach(p => {
      picker.appendChild(dom.el('option', { value: p.id, text: p.name }));
    });
    picker.value = selectedId && scene.props.some(p => p.id === selectedId) ? selectedId : '';
  }

  function setVal(id, val) {
    const el = dom.qs(id);
    if (document.activeElement === el) return;
    el.value = val;
  }

  function renderInspector() {
    const prop = App.Store.getSelectedProp();
    const empty = dom.qs('#inspector-empty'), fields = dom.qs('#inspector-fields');
    if (!prop) { empty.classList.remove('hidden'); fields.classList.add('hidden'); return; }
    empty.classList.add('hidden'); fields.classList.remove('hidden');

    const isCircle = prop.shape === 'circle';

    setVal('#insp-name', prop.name);
    setVal('#insp-shape', prop.shape || 'rect');
    dom.qs('#insp-size-unit').value = sizeUnit;
    setVal('#insp-width', roundDisplay(fromMeters(prop.widthM)));
    setVal('#insp-depth', roundDisplay(fromMeters(prop.depthM)));
    setVal('#insp-height', roundDisplay(fromMeters(prop.heightM)));
    dom.qs('#insp-width-readout').textContent = formatMeters(prop.widthM);
    dom.qs('#insp-depth-readout').textContent = formatMeters(prop.depthM);
    dom.qs('#insp-height-readout').textContent = formatMeters(prop.heightM);
    setVal('#insp-x', prop.x);
    setVal('#insp-y', prop.y);
    setVal('#insp-rot', prop.rotationDeg);
    setVal('#insp-color', prop.color);
    setVal('#insp-notes', prop.notes);

    dom.qs('#insp-width-label-text').textContent = isCircle ? 'Diameter' : 'Length';
    dom.qs('#insp-depth-field').classList.toggle('hidden', isCircle);
    dom.qs('#insp-rot-field').classList.toggle('hidden', isCircle);

    const src = dom.qs('#insp-position-source');
    const drivenBy = setLiveDrivenState(['#insp-x', '#insp-y', '#insp-rot'], 'prop', prop.id);
    if (drivenBy) {
      src.textContent = `Position + rotation driven live by "${drivenBy}" — unassign it in Live Tracking to edit by hand.`;
    } else if (prop.positionSource === 'measured') {
      src.textContent = 'Position last set by live tracking';
    } else {
      src.textContent = 'Position set manually on canvas';
    }
  }

  function bindInspector() {
    const bind = (sel, field, parse) => {
      dom.qs(sel).addEventListener('input', e => {
        const prop = App.Store.getSelectedProp();
        if (!prop) return;
        const v = parse ? parse(e.target.value) : e.target.value;
        const patch = { [field]: v };
        if (['widthM', 'depthM', 'x', 'y', 'rotationDeg'].includes(field)) patch.positionSource = 'manual';
        App.Store.updateProp(prop.id, patch);
      });
    };
    const parseSize = v => toMeters(parseFloat(v));
    bind('#insp-name', 'name');
    // A circle's "width" is its diameter -- depthM is kept equal to it so the
    // rest of the codebase (bounding box, CSV export) can keep treating every
    // prop as having a widthM/depthM footprint without a shape check.
    dom.qs('#insp-width').addEventListener('input', e => {
      const prop = App.Store.getSelectedProp();
      if (!prop) return;
      const v = parseSize(e.target.value);
      const patch = { widthM: v, positionSource: 'manual' };
      if (prop.shape === 'circle') patch.depthM = v;
      App.Store.updateProp(prop.id, patch);
    });
    bind('#insp-depth', 'depthM', parseSize);
    bind('#insp-height', 'heightM', parseSize);
    bind('#insp-x', 'x', parseFloat);
    bind('#insp-y', 'y', parseFloat);
    bind('#insp-rot', 'rotationDeg', parseFloat);
    bind('#insp-color', 'color');
    bind('#insp-notes', 'notes');

    dom.qs('#insp-shape').addEventListener('change', e => {
      const prop = App.Store.getSelectedProp();
      if (!prop) return;
      const shape = e.target.value;
      const patch = { shape, positionSource: 'manual' };
      if (shape === 'circle') patch.depthM = prop.widthM;
      App.Store.updateProp(prop.id, patch);
    });

    dom.qs('#insp-size-unit').addEventListener('change', e => {
      sizeUnit = e.target.value;
      const step = sizeUnit === 'cm' ? '1' : '0.01';
      const min = sizeUnit === 'cm' ? '1' : '0.01';
      dom.qs('#insp-width').step = step;
      dom.qs('#insp-width').min = min;
      dom.qs('#insp-depth').step = step;
      dom.qs('#insp-depth').min = min;
      dom.qs('#insp-height').step = step;
      renderInspector();
    });

    dom.qs('#btn-delete-prop').addEventListener('click', () => {
      const prop = App.Store.getSelectedProp();
      if (!prop) return;
      if (confirm(`Delete "${prop.name}"?`)) App.Store.removeProp(prop.id);
    });

    dom.qs('#insp-prop-picker').addEventListener('change', e => {
      App.Store.selectProp(e.target.value || null);
    });
  }

  // The camera equivalent of renderTrackerLinkButtons: one button per camera
  // row driving it from the camera tracker, so linking/releasing the camera
  // doesn't mean scrolling past the whole Live Tracking panel to find its
  // row. Same toggle as that panel's Link/Release camera button -- both go
  // through the one assignment keyed by cameraTrackerName, so whichever is
  // used, the other reflects it.
  //
  // Only ONE tracker button here, unlike a prop's two: the camera tracker is
  // whichever rigid body is designated as such (settable via Live Tracking's
  // "Set as tracker", because rigid bodies currently arrive named by numeric
  // id -- see js/ui/liveTrackingUi.js), and it's never assigned to a prop.
  function renderCameraLinkButton(camera) {
    const trackerName = App.motiveCalibration.cameraTrackerName;
    const assignment = App.liveTracking.getAssignmentFor(trackerName);
    const linkedHere = !!assignment && assignment.entityType === 'camera' && assignment.entityId === camera.id;
    const elsewhere = !!assignment && !linkedHere;
    return dom.el('button', {
      class: 'prop-row-link' + (linkedHere ? ' active' : ''),
      text: linkedHere ? 'Unlink' : 'Link',
      title: linkedHere
        // Says WHY you'd release it: a live-driven camera owns its
        // x/y/rotation and overwrites anything typed into them.
        ? `"${trackerName}" is driving "${camera.name}" — click to release it so the camera can be placed by hand`
        : `Drive "${camera.name}" live from "${trackerName}"` +
          (elsewhere ? ' (releases whatever it is on now)' : ''),
      onclick: (e) => {
        // As on the prop rows: without this the row's own handler also fires
        // and changes the camera selection under the inspector.
        e.stopPropagation();
        if (linkedHere) App.liveTracking.unassign(trackerName);
        else App.liveTracking.assign(trackerName, 'camera', camera.id);
      }
    });
  }

  // Show/Hide for one camera position on the CANVAS ONLY. Several positions
  // in one prop layout overlap into a pile, and the one you're placing is the
  // one you need to see. Nothing leaves the setup: the row stays here, the
  // inspector still edits it, and every export draws it -- so this can't
  // quietly drop a camera from the plan the crew shoots from.
  function renderCameraEyeButton(camera) {
    return dom.el('button', {
      class: 'prop-row-eye',
      text: camera.hidden ? 'Show' : 'Hide',
      title: camera.hidden
        ? `"${camera.name}" is hidden on the canvas — click to show it again (exports have it either way)`
        : `Hide "${camera.name}" on the canvas to get it out of the way — exports still include it`,
      onclick: e => {
        // As on the link buttons: without this the row's own handler fires
        // too and changes what the inspector is pointed at.
        e.stopPropagation();
        App.Store.toggleCameraHidden(camera.id);
      }
    });
  }

  // Same reason as propListStructureKey: this list now carries a button, and
  // rebuilding it on every ~30Hz emit would leave that button unclickable
  // exactly while tracking is live. The measured/manual badge is the only
  // per-frame part, and it's rewritten in place below.
  //
  // The camera NAME is deliberately absent from this key, unlike the prop
  // list's. Each row carries the name in an <input>, so keying on it would
  // mean every keystroke changed the key, rebuilt the list, and destroyed
  // the field being typed into -- the same class of bug the key exists to
  // prevent. The name is instead written back in place below, and only when
  // the field isn't focused.
  function cameraListStructureKey() {
    const scene = App.Store.getScene();
    return [
      scene.cameras.map(c => `${c.id}:${c.color}:${c.hidden ? 'h' : 'v'}`).join('|'),
      App.Store.getSelectedCameraId(),
      App.motiveCalibration.cameraTrackerName,
      JSON.stringify(App.liveTracking.getAssignments())
    ].join('##');
  }

  const cameraSrcElById = {};
  const cameraNameElById = {};
  let lastCameraListKey = null;

  function renderCameraList() {
    const scene = App.Store.getScene();
    dom.qs('#camera-count').textContent = `(${scene.cameras.length})`;

    const key = cameraListStructureKey();
    if (key === lastCameraListKey) {
      scene.cameras.forEach(c => {
        const el = cameraSrcElById[c.id];
        if (!el) return;
        const measured = c.positionSource === 'measured';
        const text = measured ? 'measured' : 'manual';
        if (el.textContent !== text) el.textContent = text;
        el.className = 'prop-row-src' + (measured ? ' measured' : '');
        // Renames from elsewhere (the inspector's Name field) still have to
        // reach this row -- but never overwrite what someone is typing here.
        const nameEl = cameraNameElById[c.id];
        if (nameEl && document.activeElement !== nameEl && nameEl.value !== c.name) {
          nameEl.value = c.name;
        }
      });
      return;
    }
    lastCameraListKey = key;

    const selectedId = App.Store.getSelectedCameraId();
    const list = dom.qs('#camera-list');
    dom.clear(list);
    Object.keys(cameraSrcElById).forEach(k => delete cameraSrcElById[k]);
    Object.keys(cameraNameElById).forEach(k => delete cameraNameElById[k]);

    scene.cameras.forEach(c => {
      const srcEl = dom.el('span', {
        class: 'prop-row-src' + (c.positionSource === 'measured' ? ' measured' : ''),
        text: c.positionSource === 'measured' ? 'measured' : 'manual'
      });
      cameraSrcElById[c.id] = srcEl;

      // Editable in the row itself, not just in the Inspector: with several
      // camera positions per prop layout, naming them for the shot they
      // cover is how you tell them apart, and that shouldn't mean selecting
      // each one and crossing to the other panel -- on a tablet the
      // Inspector is a collapsed panel away.
      const nameEl = dom.el('input', {
        class: 'prop-row-name-input',
        type: 'text',
        value: c.name,
        placeholder: 'Shot name',
        title: 'What this camera position covers — shown on the floor plan and in the CSV',
        oninput: e => App.Store.updateCamera(c.id, { name: e.target.value }),
        // The row selects on click; without this, putting the caret in the
        // field (or clicking mid-word) would re-fire that and fight the edit.
        onclick: e => e.stopPropagation(),
        onfocus: () => App.Store.selectCamera(c.id)
      });
      cameraNameElById[c.id] = nameEl;

      // Two lines, same as a prop row: colour + name on top, controls
      // underneath. The name field is deliberately borderless so the list
      // reads as labels rather than a wall of form fields -- which stops
      // working the moment it is squeezed between a badge and two buttons,
      // and a camera position's name is the thing you actually read.
      const row = dom.el('div', {
        class: 'prop-row' + (c.id === selectedId ? ' selected' : '') + (c.hidden ? ' row-hidden' : ''),
        onclick: () => App.Store.selectCamera(c.id)
      }, [
        dom.el('div', { class: 'prop-row-main' }, [
          dom.el('span', { class: 'swatch', style: `background:${c.color}` }),
          nameEl
        ]),
        dom.el('div', { class: 'prop-row-actions' }, [
          srcEl,
          renderCameraEyeButton(c),
          renderCameraLinkButton(c)
        ])
      ]);
      list.appendChild(row);
    });

    // Only offered when it would do something. It exists because hiding is
    // per camera: hide four of five, switch position, come back, and "why is
    // there one camera" needs an answer that isn't clicking five rows.
    const hiddenCount = App.Store.getHiddenCameraCount();
    const showAll = dom.qs('#btn-show-all-cameras');
    showAll.classList.toggle('hidden', hiddenCount === 0);
    showAll.textContent = `Show All Cameras (${hiddenCount} hidden)`;
  }

  // Hidden for the single-camera case: a picker offering one choice is just
  // noise, and getInspectedCamera() falls through to that camera anyway.
  // Shown as soon as a scene carries several camera positions, which would
  // otherwise be uneditable.
  function renderCameraPicker() {
    const scene = App.Store.getScene();
    const selectedId = App.Store.getSelectedCameraId();
    const picker = dom.qs('#cam-insp-picker');
    const single = scene.cameras.length <= 1;
    picker.classList.toggle('hidden', single);
    // Same for deleting, even though "+ Add Camera Position" could put one
    // back: every scene is guaranteed at least one camera (see
    // ensureCamera), so deleting the last one is a state the rest of the app
    // doesn't accept -- hide it rather than repair it afterwards.
    dom.qs('#btn-delete-camera').classList.toggle('hidden', single);
    if (single || document.activeElement === picker) return;
    dom.clear(picker);
    picker.appendChild(dom.el('option', { value: '', text: 'Select a camera…' }));
    scene.cameras.forEach(c => {
      picker.appendChild(dom.el('option', { value: c.id, text: c.name }));
    });
    picker.value = selectedId && scene.cameras.some(c => c.id === selectedId) ? selectedId : '';
  }

  function renderCameraInspector() {
    const camera = App.Store.getInspectedCamera();
    const empty = dom.qs('#camera-inspector-empty'), fields = dom.qs('#camera-inspector-fields');
    if (!camera) { empty.classList.remove('hidden'); fields.classList.add('hidden'); return; }
    empty.classList.add('hidden'); fields.classList.remove('hidden');

    setVal('#cam-insp-name', camera.name);
    setVal('#cam-insp-x', camera.x);
    setVal('#cam-insp-y', camera.y);
    setVal('#cam-insp-rot', camera.rotationDeg);
    setVal('#cam-insp-color', camera.color);
    setVal('#cam-insp-notes', camera.notes);
    setVal('#cam-insp-focal', camera.focalLengthMm == null ? '' : camera.focalLengthMm);

    // Tracking-derived, so read-only readouts rather than inputs.
    dom.qs('#cam-insp-height-readout').textContent =
      camera.heightM == null ? '—' : `${Math.round(camera.heightM * 100)}cm`;
    dom.qs('#cam-insp-tilt-readout').textContent =
      camera.tiltDeg == null ? '—' : `${camera.tiltDeg.toFixed(1)}°`;

    const src = dom.qs('#cam-insp-position-source');
    const drivenBy = setLiveDrivenState(['#cam-insp-x', '#cam-insp-y', '#cam-insp-rot'], 'camera', camera.id);
    if (drivenBy) {
      src.textContent = `Position + rotation driven live by "${drivenBy}" — unassign it in Live Tracking to edit by hand.`;
    } else if (camera.positionSource === 'measured') {
      src.textContent = 'Position last set by live tracking';
    } else {
      src.textContent = 'Position set manually on canvas';
    }

    renderRecordingControls(camera);
  }

  // While a prop/camera is assigned to a live rigid body, tracking owns its
  // x/y/rotation -- anything typed into those fields is overwritten by the
  // next frame ~30 times a second, so the edit silently doesn't take and the
  // input is left showing a value the Store never had. Disabling them says
  // so honestly instead. Name/colour/notes stay editable: tracking doesn't
  // touch those. Returns the driving rigid body's name, or null.
  function setLiveDrivenState(selectors, entityType, entityId) {
    const drivenBy = App.liveTracking ? App.liveTracking.getRigidBodyDriving(entityType, entityId) : null;
    selectors.forEach(sel => {
      const el = dom.qs(sel);
      el.disabled = !!drivenBy;
      el.title = drivenBy ? `Driven live by "${drivenBy}"` : '';
    });
    return drivenBy;
  }

  function bindCameraInspector() {
    const bind = (sel, field, parse) => {
      dom.qs(sel).addEventListener('input', e => {
        const camera = App.Store.getInspectedCamera();
        if (!camera) return;
        const v = parse ? parse(e.target.value) : e.target.value;
        const patch = { [field]: v };
        if (['x', 'y', 'rotationDeg'].includes(field)) patch.positionSource = 'manual';
        App.Store.updateCamera(camera.id, patch);
      });
    };
    bind('#cam-insp-name', 'name');
    bind('#cam-insp-x', 'x', parseFloat);
    bind('#cam-insp-y', 'y', parseFloat);
    bind('#cam-insp-rot', 'rotationDeg', parseFloat);
    bind('#cam-insp-color', 'color');
    bind('#cam-insp-notes', 'notes');
    // Blank clears it rather than storing NaN, so the floor PNG can tell
    // "no lens set" from a real value.
    dom.qs('#cam-insp-focal').addEventListener('input', e => {
      const camera = App.Store.getInspectedCamera();
      if (!camera) return;
      const raw = e.target.value.trim();
      const v = raw === '' ? null : parseFloat(raw);
      App.Store.updateCamera(camera.id, { focalLengthMm: (v == null || isNaN(v)) ? null : v });
    });

    dom.qs('#cam-insp-picker').addEventListener('change', e => {
      App.Store.selectCamera(e.target.value || null);
    });

    // Several camera positions can share one prop layout -- the same
    // dressing shot wide, then tight, then over-shoulder. Each is a full
    // camera entity, so it carries its own placement, lens, notes and
    // recorded move, and each appears on the exported floor plan and CSV
    // under whatever it's named.
    dom.qs('#btn-add-camera').addEventListener('click', () => {
      const cameras = App.Store.getCameras();
      // Offset a metre to the side of the last one rather than dropped on
      // the studio centre: stacked exactly on an existing camera it would be
      // invisible and impossible to grab, while the centre is nowhere near
      // wherever the crew is actually working.
      const base = cameras.length ? cameras[cameras.length - 1] : App.factories.DEFAULT_CAMERA_POS;
      const camera = App.factories.newCamera(base.x + 1, base.y, cameras.length);
      // Skip names already in use rather than counting -- after a delete,
      // length + 1 collides, and two rows both called "Camera 2" is exactly
      // the confusion these names exist to prevent.
      const taken = new Set(cameras.map(c => c.name));
      let n = cameras.length + 1;
      while (taken.has(`Camera ${n}`)) n++;
      camera.name = `Camera ${n}`;

      App.Store.addCamera(camera); // also selects it

      // This button is in the header, but the row it creates is in here --
      // which on a tablet is a shut drawer. Open it, or the press reads as
      // having done nothing. Guarded because the sidebar is built without
      // the toolbar in the headless tests.
      if (App.toolbar && App.toolbar.revealLeftPanel) App.toolbar.revealLeftPanel();

      // addCamera -> touch -> emit has already rebuilt the list, so the new
      // row's field exists: put the caret in it so the shot name can be
      // typed straight away rather than hunted for.
      const nameEl = cameraNameElById[camera.id];
      if (nameEl) { nameEl.focus(); nameEl.select(); }
    });

    dom.qs('#btn-show-all-cameras').addEventListener('click', () => App.Store.showAllCameras());

    dom.qs('#btn-delete-camera').addEventListener('click', () => {
      const camera = App.Store.getInspectedCamera();
      if (!camera) return;
      if (confirm(`Delete "${camera.name}"?`)) App.Store.removeCamera(camera.id);
    });

    dom.qs('#btn-record-movement').addEventListener('click', () => {
      const camera = App.Store.getInspectedCamera();
      if (!camera) return;
      if (App.liveRecording.isRecording()) {
        const result = App.liveRecording.stop();
        App.toast(result
          ? `Movement recorded (${result.pointCount} points).`
          : 'Nothing recorded — the camera never moved.', !result);
      } else {
        const problem = App.liveRecording.start(camera.id);
        if (problem) App.toast(problem, true);
      }
    });

    dom.qs('#btn-clear-trail').addEventListener('click', () => {
      const camera = App.Store.getInspectedCamera();
      if (!camera) return;
      App.liveRecording.clearTrail(camera.id);
    });
  }

  // Recording is per-camera, so the controls describe whichever camera is
  // selected -- including making clear when a recording is running against a
  // *different* one, which would otherwise look like the button doing nothing.
  function renderRecordingControls(camera) {
    const btn = dom.qs('#btn-record-movement');
    const clearBtn = dom.qs('#btn-clear-trail');
    const status = dom.qs('#record-status');
    const recording = App.liveRecording.isRecording();
    const recordingThis = recording && App.liveRecording.getCameraId() === camera.id;

    btn.textContent = recordingThis ? '■ Stop Recording' : '● Record Movement';
    btn.disabled = recording && !recordingThis;
    clearBtn.disabled = recordingThis || !camera.trail;

    if (recordingThis) {
      status.textContent = `Recording… ${App.liveRecording.getSampleCount()} points captured.`;
      status.className = 'small err-warn';
    } else if (recording) {
      const other = App.Store.getCameras().find(c => c.id === App.liveRecording.getCameraId());
      status.textContent = `Recording "${other ? other.name : 'another camera'}" — stop that first.`;
      status.className = 'small muted';
    } else if (camera.trail) {
      status.textContent = `Path recorded: ${camera.trail.length} points.`;
      status.className = 'small err-ok';
    } else {
      status.textContent = 'No path recorded.';
      status.className = 'small muted';
    }
  }

  App.sidebar = {
    init() {
      bindInspector();
      bindCameraInspector();
      const renderAll = () => {
        renderPropList(); renderPropPicker(); renderInspector();
        renderCameraList(); renderCameraPicker(); renderCameraInspector();
      };
      App.Store.subscribe(renderAll);
      // Assignment changes don't touch the Store, so without this the
      // inspectors keep whatever live-driven lock state they last rendered
      // -- unassigning would leave x/y/rotation disabled indefinitely.
      App.liveTracking.subscribe(renderAll);
      App.liveRecording.subscribe(renderAll);
      renderAll();
    }
  };
})();
