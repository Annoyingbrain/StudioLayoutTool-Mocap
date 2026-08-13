// Top toolbar: setup name, new/save/load, JSON export/import, CSV export, report,
// tool selection (select/add-prop), grid + zoom, and the frame-grab panel.
window.App = window.App || {};

(function () {
  const dom = App.dom;

  function refreshSetupPicker() {
    const picker = dom.qs('#setup-picker');
    const current = picker.value;
    dom.clear(picker);
    picker.appendChild(dom.el('option', { value: '', text: 'Load setup…' }));
    App.persistence.listLocal()
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
      .forEach(entry => {
        picker.appendChild(dom.el('option', { value: entry.id, text: entry.name }));
      });
    picker.value = current && dom.qsa('option', picker).some(o => o.value === current) ? current : '';
  }

  function syncSetupName() {
    dom.qs('#setup-name').value = App.Store.getSetup().name;
  }

  function syncScenePanel() {
    const picker = dom.qs('#scene-picker');
    const activeId = App.Store.getActiveSceneId();
    const scenes = App.Store.getScenes();

    if (document.activeElement !== picker) {
      dom.clear(picker);
      scenes.forEach(s => picker.appendChild(dom.el('option', { value: s.id, text: s.name })));
      picker.value = activeId;
    }

    const nameInput = dom.qs('#scene-name');
    if (document.activeElement !== nameInput) nameInput.value = App.Store.getScene().name;

    dom.qs('#btn-delete-scene').disabled = scenes.length <= 1;
  }

  function syncTools() {
    const tool = App.Store.getTool();
    dom.qsa('.tool-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tool === tool));
  }

  function syncFrameGrab() {
    const fg = App.Store.getScene().frameGrab;
    const thumb = dom.qs('#framegrab-thumb');
    const caption = dom.qs('#framegrab-caption');
    if (fg) {
      thumb.src = fg.imageDataUrl;
      thumb.classList.remove('hidden');
      if (document.activeElement !== caption) caption.value = fg.caption || '';
    } else {
      thumb.classList.add('hidden');
      thumb.src = '';
      if (document.activeElement !== caption) caption.value = '';
    }
  }

  function newSetup() {
    if (!confirm('Start a new setup? Unsaved changes to the current one will be lost unless you saved/exported it.')) return;
    const defaults = App.persistence.loadDefaultReferencePoints();
    App.Store.setSetup(App.factories.newSetup('Untitled Setup', defaults || undefined));
    App.canvas.fitToReferencePoints();
  }

  function saveLocal() {
    const setup = App.Store.getSetup();
    const res = App.persistence.saveLocal(setup);
    if (res.ok) { refreshSetupPicker(); App.toast(`Saved "${setup.name}" to this browser.`); }
    else App.toast(res.reason, true);
  }

  function loadLocal(id) {
    if (!id) return;
    const setup = App.persistence.loadLocal(id);
    if (setup) App.Store.setSetup(setup);
  }

  function initPanelDrawers() {
    const left = dom.qs('#left-panel');
    const right = dom.qs('#right-panel');
    const backdrop = dom.qs('#panel-backdrop');

    function closeAll() {
      left.classList.remove('open');
      right.classList.remove('open');
      backdrop.classList.remove('open');
    }
    function toggle(panel) {
      const willOpen = !panel.classList.contains('open');
      closeAll();
      if (willOpen) { panel.classList.add('open'); backdrop.classList.add('open'); }
    }

    dom.qs('#btn-toggle-left').addEventListener('click', () => toggle(left));
    dom.qs('#btn-toggle-right').addEventListener('click', () => toggle(right));
    dom.qs('#btn-close-left').addEventListener('click', closeAll);
    dom.qs('#btn-close-right').addEventListener('click', closeAll);
    backdrop.addEventListener('click', closeAll);
  }

  App.toolbar = {
    init() {
      initPanelDrawers();

      dom.qs('#setup-name').addEventListener('input', e => {
        App.Store.getSetup().name = e.target.value;
        App.Store.touch();
      });

      dom.qs('#scene-picker').addEventListener('change', e => App.Store.selectScene(e.target.value));
      dom.qs('#scene-name').addEventListener('input', e => {
        App.Store.renameScene(App.Store.getActiveSceneId(), e.target.value);
      });
      dom.qs('#btn-new-scene').addEventListener('click', () => {
        const scene = App.Store.addScene(`Position ${App.Store.getScenes().length + 1}`);
        App.canvas.fitToReferencePoints();
        App.toast(`Added "${scene.name}".`);
      });
      dom.qs('#btn-delete-scene').addEventListener('click', () => {
        const scene = App.Store.getScene();
        if (App.Store.getScenes().length <= 1) return;
        if (confirm(`Delete "${scene.name}" and all its props? This can't be undone.`)) {
          App.Store.removeScene(scene.id);
        }
      });

      dom.qs('#btn-new').addEventListener('click', newSetup);
      dom.qs('#btn-save-local').addEventListener('click', saveLocal);
      dom.qs('#setup-picker').addEventListener('change', e => loadLocal(e.target.value));

      dom.qs('#btn-export-json').addEventListener('click', () => App.persistence.exportToFile(App.Store.getSetup()));
      dom.qs('#import-json').addEventListener('change', async e => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
          const setup = await App.persistence.importFromFile(file);
          App.Store.setSetup(setup);
          App.toast(`Loaded "${setup.name}" from file.`);
        } catch (err) {
          App.toast('Could not load that file: ' + err.message, true);
        }
      });

      dom.qs('#btn-export-csv').addEventListener('click', () => App.csvExport.exportSetup(App.Store.getSetup(), App.Store.getScene()));
      dom.qs('#btn-export-floor-png').addEventListener('click', () => App.floorPngExport.exportSetup(App.Store.getSetup(), App.Store.getScene()));
      dom.qs('#btn-report').addEventListener('click', () => App.reportExport.open(App.Store.getSetup(), App.Store.getScene()));

      dom.qsa('.tool-btn').forEach(btn => {
        btn.addEventListener('click', () => App.Store.setTool(btn.dataset.tool));
      });

      dom.qs('#chk-grid').addEventListener('change', () => App.canvas.render());
      dom.qs('#chk-studio-sketch').addEventListener('change', () => App.canvas.render());
      dom.qs('#view-scale').addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        if (v > 0) App.Store.setView({ scale: Math.max(v, App.canvas.getMinScale()) });
      });

      dom.qs('#import-framegrab').addEventListener('change', async e => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        const dataUrl = await dom.readFileAsDataUrl(file);
        App.Store.setFrameGrab({ imageDataUrl: dataUrl, caption: (App.Store.getScene().frameGrab || {}).caption || '' });
      });
      dom.qs('#framegrab-caption').addEventListener('input', e => {
        const scene = App.Store.getScene();
        if (!scene.frameGrab) return;
        scene.frameGrab.caption = e.target.value;
        App.Store.touch();
      });

      App.Store.subscribe(() => { syncSetupName(); syncScenePanel(); syncTools(); syncFrameGrab(); });
      syncSetupName(); syncScenePanel(); syncTools(); syncFrameGrab();
      refreshSetupPicker();
    },
    refreshSetupPicker
  };
})();
