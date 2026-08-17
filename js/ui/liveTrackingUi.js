// Live Tracking panel: connect to server.py's WebSocket bridge, and assign
// each incoming Motive rigid body (by name) to a camera or prop so it gets
// driven live -- see js/motive/liveConnection.js (the socket) and
// js/motive/liveTracking.js (assignments + applying frames to the Store).
window.App = window.App || {};

(function () {
  const dom = App.dom;

  function defaultWsUrl() {
    const host = location.hostname || 'localhost';
    return `ws://${host}:8001`;
  }

  function renderStatus() {
    const el = dom.qs('#live-status');
    const status = App.liveConnection.getStatus();
    const labels = { disconnected: 'Disconnected', connecting: 'Connecting…', connected: 'Connected', error: 'Error' };
    el.textContent = labels[status] || status;
    el.className = 'small ' + (status === 'connected' ? 'err-ok' : (status === 'error' ? 'err-bad' : 'muted'));
    if (status === 'error' && App.liveConnection.getLastError()) el.textContent += ` — ${App.liveConnection.getLastError()}`;
    // Connected to the bridge is not the same as Motive actually streaming
    // -- say which, so a Motive-side pause (Edit mode) doesn't look like the
    // app being broken.
    if (status === 'connected') {
      el.textContent += App.liveTracking.isMotiveStreaming()
        ? ' — Motive streaming'
        : ' — waiting for Motive (not streaming; in Edit mode?)';
    }
    dom.qs('#btn-live-connect').disabled = status === 'connected' || status === 'connecting';
    dom.qs('#btn-live-disconnect').disabled = status === 'disconnected';
  }

  function entityOptions(selectedType, selectedId) {
    const options = [dom.el('option', { value: '', text: '— unassigned —' })];
    const cameraGroup = dom.el('optgroup', { label: 'Cameras' });
    App.Store.getCameras().forEach(c => {
      const attrs = { value: `camera:${c.id}`, text: c.name };
      if (selectedType === 'camera' && selectedId === c.id) attrs.selected = 'selected';
      cameraGroup.appendChild(dom.el('option', attrs));
    });
    const propGroup = dom.el('optgroup', { label: 'Props' });
    App.Store.getScene().props.forEach(p => {
      const attrs = { value: `prop:${p.id}`, text: p.name };
      if (selectedType === 'prop' && selectedId === p.id) attrs.selected = 'selected';
      propGroup.appendChild(dom.el('option', attrs));
    });
    options.push(cameraGroup, propGroup);
    return options;
  }

  // The rigid body named App.motiveCalibration.cameraTrackerName is the one
  // that's always meant to drive whichever camera is physically on stage --
  // unlike T-bar/Triangle (used to capture rectangular/circular prop
  // positions), it's never assigned to a prop, and there's only ever one
  // camera actively tracked from it at a time. A generic camera-or-prop
  // dropdown is more control than that needs, so this renders one
  // Tracked/Fixed toggle button per camera instead: clicking a camera
  // assigns it (replacing whichever camera was tracked before, since
  // assign() just overwrites this name's single assignment); clicking the
  // already-tracked one unassigns it back to Fixed (manual x/y/rotation
  // entry). Any OTHER rigid body name still gets the full dropdown below,
  // unchanged, since that general assignment is still how T-bar/Triangle
  // drive props.
  //
  // cameraTrackerName defaults to the real Motive asset name ('Camera
  // Tracker') but is user-settable via the "Set as Camera Tracker" button
  // on any other row, because that name currently can't be trusted --
  // server.py's name lookup is disabled (see its natnet_loop comment;
  // sending that request stopped all frames from arriving on this Motive
  // build), so rigid bodies show their bare numeric id instead.
  function cameraTrackerName() { return App.motiveCalibration.cameraTrackerName; }

  function setCameraTrackerName(name) {
    App.motiveCalibration.cameraTrackerName = name;
    App.persistence.saveMotiveCalibration({ cameraTrackerName: name });
  }

  const AXIS_OPTIONS = ['+x', '-x', '+y', '-y', '+z', '-z'];

  // Per-row calibration controls -- see js/motive/motiveCalibration.js's
  // header on why this moved from one global set of fields to one set per
  // tracker NAME. Rebuilt only alongside the rest of the row (structural
  // changes only, per structureKey()), so typing in these fields doesn't
  // fight a mid-edit rebuild.
  function renderTrackerCalibrationRow(name) {
    let calibration = App.motiveCalibration.forTracker(name);
    const save = () => App.persistence.saveMotiveCalibration({ trackers: App.motiveCalibration.trackers });

    const axis = dom.el('select', { title: 'Forward axis', style: 'width: 4.5em;' },
      AXIS_OPTIONS.map(a => {
        const attrs = { value: a, text: a };
        if (a === calibration.liveForwardAxis) attrs.selected = 'selected';
        return dom.el('option', attrs);
      }));
    axis.addEventListener('change', () => {
      calibration.liveForwardAxis = axis.value;
      save();
    });

    const rotOffset = dom.el('input', {
      type: 'number', step: '0.1', title: 'Rotation offset (deg), on top of the calibrated baseline',
      value: calibration.liveRotationUserOffsetDeg, style: 'width: 3.5em;'
    });
    rotOffset.addEventListener('input', () => {
      const v = parseFloat(rotOffset.value);
      if (isNaN(v)) return;
      calibration.liveRotationUserOffsetDeg = v;
      save();
    });

    const heightOffset = dom.el('input', {
      type: 'number', step: '0.001', title: 'Height offset (m) -- only affects a tracker driving a camera',
      value: calibration.liveHeightOffsetM, style: 'width: 3.5em;'
    });
    heightOffset.addEventListener('input', () => {
      const v = parseFloat(heightOffset.value);
      if (isNaN(v)) return;
      calibration.liveHeightOffsetM = v;
      save();
    });

    // Applies a known tracker's derived calibration in one click. Needed
    // because a live rigid body currently arrives named "1"/"2" rather than
    // as its Motive asset (see motiveCalibration.js's header), so the right
    // profile can't be matched automatically -- but the operator knows
    // which physical tracker a row is. Writes the three inputs directly
    // rather than re-rendering: `trackers` isn't part of structureKey(), so
    // a rebuild wouldn't fire anyway, and touching only these leaves the
    // rest of the panel (and any open dropdown) undisturbed.
    const profile = dom.el('select', { title: "Apply a known tracker's calibration", style: 'width: 9em;' }, [
      dom.el('option', { value: '', text: 'apply profile…' })
    ].concat(Object.keys(App.motiveCalibration.PROFILES).map(p =>
      dom.el('option', { value: p, text: p }))));
    profile.addEventListener('change', () => {
      const chosen = profile.value;
      profile.value = '';   // a one-shot preset applier, not a stored per-row choice
      if (!chosen) return;
      calibration = App.motiveCalibration.applyProfile(name, chosen);
      axis.value = calibration.liveForwardAxis;
      rotOffset.value = calibration.liveRotationUserOffsetDeg;
      heightOffset.value = calibration.liveHeightOffsetM;
      save();
    });

    return dom.el('div', { class: 'tool-row', style: 'margin: 0 0 6px 0;' }, [
      dom.el('span', { class: 'small muted', text: 'axis' }), axis,
      dom.el('span', { class: 'small muted', text: 'rot°' }), rotOffset,
      dom.el('span', { class: 'small muted', text: 'h(m)' }), heightOffset,
      profile
    ]);
  }

  function renderCameraTrackerButtons(assignment) {
    const cameras = App.Store.getCameras();
    if (!cameras.length) return dom.el('span', { class: 'small muted', text: 'No cameras in this setup' });
    const trackedId = assignment && assignment.entityType === 'camera' ? assignment.entityId : null;
    return dom.el('div', { class: 'tool-row', style: 'margin: 0;' }, cameras.map(c => {
      const isTracked = trackedId === c.id;
      return dom.el('button', {
        class: 'tool-btn' + (isTracked ? ' active' : ''),
        text: isTracked ? `${c.name} (Tracked)` : c.name,
        onclick: () => {
          const name = cameraTrackerName();
          if (isTracked) App.liveTracking.unassign(name);
          else App.liveTracking.assign(name, 'camera', c.id);
        }
      });
    }));
  }

  // Live frames arrive at Motive's full rate (120/s), and both liveTracking
  // and the Store emit on each one. Rebuilding this list on every emit
  // destroys and recreates the <select> elements ~120 times a second, which
  // makes them impossible to actually use -- a dropdown snaps shut the
  // instant it's opened. So the rows are only rebuilt when something
  // STRUCTURAL changes (which rigid bodies exist, what they're assigned to,
  // which props/cameras exist to choose from); per-frame updates just
  // rewrite the status text in place, touching no <select> at all.
  function structureKey() {
    const names = App.liveTracking.getKnownNames().sort().join('|');
    const assignments = JSON.stringify(App.liveTracking.getAssignments());
    const entities = App.Store.getCameras().map(c => `c${c.id}:${c.name}`)
      .concat(App.Store.getScene().props.map(p => `p${p.id}:${p.name}`)).join('|');
    return `${names}##${assignments}##${entities}##${App.liveConnection.isConnected()}##${App.liveTracking.isMotiveStreaming()}##${cameraTrackerName()}`;
  }

  const statusElByName = {};

  function renderRigidBodyList() {
    const container = dom.qs('#live-rigidbody-list');
    dom.clear(container);
    Object.keys(statusElByName).forEach(k => delete statusElByName[k]);
    const names = App.liveTracking.getKnownNames();
    if (!names.length) {
      container.appendChild(dom.el('div', { class: 'small muted', text: App.liveConnection.isConnected() ? 'Waiting for rigid bodies from Motive…' : 'Not connected.' }));
      return;
    }
    names.sort().forEach(name => {
      const latest = App.liveTracking.getLatest(name);
      const assignment = App.liveTracking.getAssignmentFor(name);
      const isCameraTracker = name === cameraTrackerName();
      const control = isCameraTracker
        ? renderCameraTrackerButtons(assignment)
        : dom.el('select', {
            onchange: (e) => {
              const v = e.target.value;
              if (!v) { App.liveTracking.unassign(name); return; }
              const [type, id] = v.split(':');
              App.liveTracking.assign(name, type, id);
            }
          }, entityOptions(assignment && assignment.entityType, assignment && assignment.entityId));

      const statusEl = dom.el('span', {
        class: 'psr-status' + (latest && latest.tracking ? ' solved' : ''),
        text: latest && latest.tracking ? 'tracking' : 'no data'
      });
      statusElByName[name] = statusEl;

      const rowChildren = [
        dom.el('span', { class: 'psr-label', text: name }),
        statusEl,
        control
      ];
      // Only offer this on rows that AREN'T already the camera tracker --
      // no point re-designating the one that's already it.
      if (!isCameraTracker) {
        rowChildren.push(dom.el('button', {
          class: 'psr-clear',
          text: 'Set as tracker',
          title: `Use "${name}" as the camera tracker instead of "${cameraTrackerName()}"`,
          onclick: () => setCameraTrackerName(name)
        }));
      }

      const row = dom.el('div', { class: 'point-status-row' }, rowChildren);
      container.appendChild(row);
      container.appendChild(renderTrackerCalibrationRow(name));
    });
  }

  // Per-frame path: text only, no element replacement, so an open <select>
  // is never disturbed.
  function updateRigidBodyStatuses() {
    Object.keys(statusElByName).forEach(name => {
      const latest = App.liveTracking.getLatest(name);
      const tracking = !!(latest && latest.tracking);
      const el = statusElByName[name];
      const text = tracking ? 'tracking' : 'no data';
      if (el.textContent !== text) el.textContent = text;
      el.className = 'psr-status' + (tracking ? ' solved' : '');
    });
  }

  let lastStructureKey = null;

  function render() {
    renderStatus();
    const key = structureKey();
    if (key !== lastStructureKey) {
      lastStructureKey = key;
      renderRigidBodyList();
    } else {
      updateRigidBodyStatuses();
    }
  }

  // Loads cameraTrackerName and the per-tracker calibration map from the
  // browser's saved values, if any -- the actual axis/offset/height INPUTS
  // are per-row now (renderTrackerCalibrationRow), built as part of
  // renderRigidBodyList, not here.
  function initCalibrationInputs() {
    const stored = App.persistence.loadMotiveCalibration() || {};
    if (stored.cameraTrackerName) App.motiveCalibration.cameraTrackerName = stored.cameraTrackerName;
    // Merge onto the code-shipped worked-example entries rather than
    // replacing them outright, so a saved calibration for e.g. "1" doesn't
    // wipe out the 'Camera Tracker'/'T-bar' reference entries.
    if (stored.trackers) Object.assign(App.motiveCalibration.trackers, stored.trackers);
  }

  App.liveTrackingUi = {
    init() {
      dom.qs('#live-ws-url').value = defaultWsUrl();

      dom.qs('#btn-live-connect').addEventListener('click', () => {
        const url = dom.qs('#live-ws-url').value.trim();
        if (url) App.liveConnection.connect(url);
      });
      dom.qs('#btn-live-disconnect').addEventListener('click', () => {
        App.liveConnection.disconnect();
        App.liveTracking.reset();
      });

      initCalibrationInputs();

      App.liveConnection.subscribe(render);
      App.liveTracking.subscribe(render);
      App.Store.subscribe(render);
      render();
    }
  };
})();
