// Prop list + prop inspector panel.
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

  function renderPropList() {
    const scene = App.Store.getScene();
    const selectedId = App.Store.getSelectedPropId();
    const list = dom.qs('#prop-list');
    dom.qs('#prop-count').textContent = `(${scene.props.length})`;
    dom.clear(list);

    scene.props.forEach(p => {
      const row = dom.el('div', {
        class: 'prop-row' + (p.id === selectedId ? ' selected' : ''),
        onclick: () => App.Store.selectProp(p.id)
      }, [
        dom.el('span', { class: 'swatch', style: `background:${p.color}` }),
        dom.el('span', { class: 'prop-row-name', text: p.name }),
        dom.el('span', {
          class: 'prop-row-src' + (p.positionSource === 'measured' ? ' measured' : ''),
          text: p.positionSource === 'measured' ? 'measured' : 'manual'
        })
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
    if (prop.positionSource === 'measured' && prop.lastSolve) {
      const s = prop.lastSolve;
      src.textContent = s.pointCount === 1
        ? `Position from measurement (1 point, rotation kept as-is)`
        : `Position + rotation from measurement (${s.pointCount} points, fit residual ${s.fitRms.toFixed(3)} m)`;
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

  App.sidebar = {
    init() {
      bindInspector();
      App.Store.subscribe(() => { renderPropList(); renderPropPicker(); renderInspector(); });
      renderPropList(); renderPropPicker(); renderInspector();
    }
  };
})();
