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
    return `${names}##${assignments}##${entities}##${App.liveConnection.isConnected()}##${App.liveTracking.isMotiveStreaming()}`;
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
      const select = dom.el('select', {
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

      const row = dom.el('div', { class: 'point-status-row' }, [
        dom.el('span', { class: 'psr-label', text: name }),
        statusEl,
        select
      ]);
      container.appendChild(row);
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

  function initCalibrationInputs() {
    const stored = App.persistence.loadMotiveCalibration() || {};

    // liveRotationUserOffsetDeg, NOT liveRotationCalibratedOffsetDeg -- this
    // field is a day-to-day adjustment on top of the fixed calibration, so
    // it starts at (and defaults back to) 0 rather than showing the
    // calibrated value as if it were meant to be nudged per-placement. See
    // js/motive/motiveCalibration.js's comments.
    const offset = dom.qs('#live-rotation-offset-input');
    if (stored.liveRotationUserOffsetDeg != null) App.motiveCalibration.liveRotationUserOffsetDeg = stored.liveRotationUserOffsetDeg;
    offset.value = App.motiveCalibration.liveRotationUserOffsetDeg;
    offset.addEventListener('input', () => {
      const v = parseFloat(offset.value);
      if (isNaN(v)) return;
      App.motiveCalibration.liveRotationUserOffsetDeg = v;
      App.persistence.saveMotiveCalibration({ liveRotationUserOffsetDeg: v });
    });

    const axis = dom.qs('#live-forward-axis-input');
    if (stored.liveForwardAxis) App.motiveCalibration.liveForwardAxis = stored.liveForwardAxis;
    axis.value = App.motiveCalibration.liveForwardAxis;
    axis.addEventListener('change', () => {
      App.motiveCalibration.liveForwardAxis = axis.value;
      App.persistence.saveMotiveCalibration({ liveForwardAxis: axis.value });
    });

    const heightOffset = dom.qs('#live-height-offset-input');
    if (stored.liveHeightOffsetM != null) App.motiveCalibration.liveHeightOffsetM = stored.liveHeightOffsetM;
    heightOffset.value = App.motiveCalibration.liveHeightOffsetM;
    heightOffset.addEventListener('input', () => {
      const v = parseFloat(heightOffset.value);
      if (isNaN(v)) return;
      App.motiveCalibration.liveHeightOffsetM = v;
      App.persistence.saveMotiveCalibration({ liveHeightOffsetM: v });
    });
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
