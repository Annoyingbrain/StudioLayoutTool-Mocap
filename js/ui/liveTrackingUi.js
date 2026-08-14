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

  function renderRigidBodyList() {
    const container = dom.qs('#live-rigidbody-list');
    dom.clear(container);
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

      const row = dom.el('div', { class: 'point-status-row' }, [
        dom.el('span', { class: 'psr-label', text: name }),
        dom.el('span', {
          class: 'psr-status' + (latest && latest.tracking ? ' solved' : ''),
          text: latest && latest.tracking ? 'tracking' : 'no data'
        }),
        select
      ]);
      container.appendChild(row);
    });
  }

  function render() {
    renderStatus();
    renderRigidBodyList();
  }

  function initRotationOffsetInput() {
    const input = dom.qs('#live-rotation-offset-input');
    const stored = App.persistence.loadMotiveCalibration();
    if (stored && stored.liveRotationOffsetDeg != null) App.motiveCalibration.liveRotationOffsetDeg = stored.liveRotationOffsetDeg;
    input.value = App.motiveCalibration.liveRotationOffsetDeg;
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      if (isNaN(v)) return;
      App.motiveCalibration.liveRotationOffsetDeg = v;
      App.persistence.saveMotiveCalibration({ liveRotationOffsetDeg: v });
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

      initRotationOffsetInput();

      App.liveConnection.subscribe(render);
      App.liveTracking.subscribe(render);
      App.Store.subscribe(render);
      render();
    }
  };
})();
