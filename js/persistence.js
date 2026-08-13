// Local (browser) persistence for quick save/load, plus the authoritative
// file-based export/import so setups can be moved between machines and won't
// be lost to a browser storage-quota limit (images are embedded as data URLs).
window.App = window.App || {};

const LS_INDEX_KEY = 'vps_setups_index';
const LS_SETUP_PREFIX = 'vps_setup_';
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
  return setup;
}

App.persistence = {
  listLocal() {
    try {
      return JSON.parse(localStorage.getItem(LS_INDEX_KEY) || '[]');
    } catch (e) {
      return [];
    }
  },

  saveLocal(setup) {
    const index = this.listLocal().filter(e => e.id !== setup.id);
    index.unshift({ id: setup.id, name: setup.name, updatedAt: setup.updatedAt });
    try {
      localStorage.setItem(LS_SETUP_PREFIX + setup.id, JSON.stringify(setup));
      localStorage.setItem(LS_INDEX_KEY, JSON.stringify(index));
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: 'Browser storage is full (large images?). Use Export .json to save to a file instead.' };
    }
  },

  loadLocal(id) {
    const raw = localStorage.getItem(LS_SETUP_PREFIX + id);
    return raw ? migrateSetup(JSON.parse(raw)) : null;
  },

  deleteLocal(id) {
    localStorage.removeItem(LS_SETUP_PREFIX + id);
    const index = this.listLocal().filter(e => e.id !== id);
    localStorage.setItem(LS_INDEX_KEY, JSON.stringify(index));
  },

  // Wand tip calibration (js/motive/motiveCalibration.js) -- a rig setting
  // (physical wand geometry) rather than per-setup data, so it's kept
  // separately and carries over between setups until changed.
  saveMotiveCalibration(calibration) {
    localStorage.setItem(LS_MOTIVE_CALIBRATION_KEY, JSON.stringify(calibration));
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
