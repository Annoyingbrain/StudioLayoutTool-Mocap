// Saving/loading setups, plus the file-based export/import for moving a
// setup between machines by hand.
window.App = window.App || {};

const LS_MOTIVE_CALIBRATION_KEY = 'vps_motive_calibration';

// Older saved/exported setups (before multi-scene support) kept props,
// frameGrab and view directly on the setup instead of inside a scenes array.
// Wrap them into a single scene so old files/local saves still load.
function migrateSetup(setup) {
  if (!(Array.isArray(setup.scenes) && setup.scenes.length)) {
    const scene = App.factories.newScene('Position 1');
    scene.props = setup.props || [];
    scene.frameGrab = setup.frameGrab || null;
    scene.view = setup.view || scene.view;
    scene.createdAt = setup.createdAt || scene.createdAt;
    scene.updatedAt = setup.updatedAt || scene.updatedAt;
    delete setup.props;
    delete setup.frameGrab;
    delete setup.view;
    setup.scenes = [scene];
    setup.activeSceneId = scene.id;
  }
  // Props saved before the circular-shape option existed have no `shape`
  // field -- default them to 'rect' so every prop has one explicitly.
  setup.scenes.forEach(scene => (scene.props || []).forEach(p => { if (!p.shape) p.shape = 'rect'; }));
  // Scenes saved before cameras existed have no `cameras` array.
  setup.scenes.forEach(scene => { if (!Array.isArray(scene.cameras)) scene.cameras = []; });
  return setup;
}

// Setups are stored as .json files in a folder on the machine running
// server.py (its --setups-dir), reached over a small API. Deliberately not
// browser local storage: every device on the network then shares one set of
// setups instead of each browser profile keeping its own invisible copy,
// and they end up as ordinary files that can be backed up. GitHub Sync is a
// separate, manual backup of the same setups.
App.persistence = {
  async listLocal() {
    const res = await fetch('/api/setups', { cache: 'no-store' });
    if (!res.ok) throw new Error(`Could not list setups (${res.status})`);
    return res.json();
  },

  async saveLocal(setup) {
    try {
      const res = await fetch(`/api/setups/${encodeURIComponent(setup.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(setup)
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, reason: body.error || `Server refused the save (${res.status})` };
      }
      return { ok: true, file: (await res.json()).file };
    } catch (e) {
      // Typically server.py not running, or the page loaded from somewhere
      // that isn't it.
      return { ok: false, reason: `Couldn't reach the server (${e.message}). Is server.py running?` };
    }
  },

  async loadLocal(id) {
    const res = await fetch(`/api/setups/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Could not load that setup (${res.status})`);
    return migrateSetup(await res.json());
  },

  async deleteLocal(id) {
    const res = await fetch(`/api/setups/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`Could not delete that setup (${res.status})`);
  },

  // Live tracking calibration (js/motive/motiveCalibration.js) -- a rig
  // setting (Motive's rigid-body axis convention) rather than per-setup
  // data, so it's kept separately and carries over between setups until
  // changed. Callers pass a partial patch, merged onto whatever's already
  // stored so saving one value doesn't clobber another.
  saveMotiveCalibration(calibration) {
    const merged = Object.assign({}, this.loadMotiveCalibration(), calibration);
    localStorage.setItem(LS_MOTIVE_CALIBRATION_KEY, JSON.stringify(merged));
  },

  loadMotiveCalibration() {
    const raw = localStorage.getItem(LS_MOTIVE_CALIBRATION_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  },

  exportToFile(setup) {
    const blob = new Blob([JSON.stringify(setup, null, 2)], { type: 'application/json' });
    const safeName = (setup.name || 'setup').replace(/[^a-z0-9_\-]+/gi, '_');
    App.dom.downloadBlob(`${safeName}.json`, blob);
  },

  async importFromFile(file) {
    const text = await App.dom.readFileAsText(file);
    const setup = JSON.parse(text);
    const looksValid = setup.id && (Array.isArray(setup.scenes) || setup.props || setup.view);
    if (!looksValid) {
      throw new Error('This file does not look like a Studio Layout Tool setup.');
    }
    return migrateSetup(setup);
  }
};
