// Motive capture panel: for the selected prop, pick which point (center, or
// for a rectangular prop one of its 4 corners) you're capturing, then load a
// Motive CSV export recorded while touching the wand tip to that point on
// the real prop. The tip's world position is computed directly from the
// wand's 5 tracked markers (js/motive/wandTip.js) and averaged across the
// capture's frames, then converted into app-world meters
// (js/motive/motiveTransform.js) -- no distance entry or solve step, unlike
// the original StudioLayoutTool's DISTO-based measurement panel: mocap
// gives absolute position directly, so loading a capture IS the solved
// point.
// Once 2+ of the prop's points are captured, the prop's overall X/Y and
// rotation are fit from those points (js/rigidFit.js, unchanged from the
// original app) -- 1 point alone can only translate the prop (its rotation
// is kept as-is). A circular prop only ever has a center point -- it's
// rotationally symmetric, so its position always comes from that single point.
window.App = window.App || {};

(function () {
  const dom = App.dom;
  let selectedPointKey = 'center';

  function currentProp() { return App.Store.getSelectedProp(); }

  function selectPoint(key) {
    selectedPointKey = key;
    render();
    if (App.canvas) App.canvas.render();
  }

  function renderPointSelector() {
    const container = dom.qs('#point-selector');
    dom.clear(container);
    const prop = currentProp();
    App.propPointsFor(prop).forEach(({ key, label }) => {
      const hasData = prop && prop.measuredPoints[key];
      const btn = dom.el('button', {
        class: 'point-btn tool-btn' + (key === selectedPointKey ? ' active' : '') + (hasData ? ' has-data' : ''),
        text: label,
        onclick: () => selectPoint(key)
      });
      container.appendChild(btn);
    });
  }

  function renderPointsStatus() {
    const prop = currentProp();
    const container = dom.qs('#points-status');
    dom.clear(container);
    App.propPointsFor(prop).forEach(({ key, label }) => {
      const mp = prop.measuredPoints[key];
      const statusText = mp
        ? `captured (±${mp.jitterMm.toFixed(2)}mm jitter, ${mp.frameCount} frames)`
        : 'not captured';
      const row = dom.el('div', {
        class: 'point-status-row',
        onclick: () => selectPoint(key)
      }, [
        dom.el('span', { class: 'psr-label', text: label }),
        dom.el('span', { class: 'psr-status' + (mp ? ' solved' : ''), text: statusText }),
        mp ? dom.el('button', {
          class: 'psr-clear', text: '✕',
          onclick: (e) => { e.stopPropagation(); App.Store.clearMeasuredPoint(prop.id, key); }
        }) : null
      ]);
      container.appendChild(row);
    });

    const capturedCount = App.propPointsFor(prop).filter(({ key }) => prop.measuredPoints[key]).length;
    dom.qs('#btn-solve-object').disabled = capturedCount === 0;
  }

  function render() {
    const prop = currentProp();
    const empty = dom.qs('#motive-empty'), fields = dom.qs('#motive-fields');
    if (!prop) { empty.classList.remove('hidden'); fields.classList.add('hidden'); return; }
    empty.classList.add('hidden'); fields.classList.remove('hidden');

    // A circular prop only ever exposes 'center' -- if the previously
    // selected prop's point (e.g. a corner) doesn't apply here, fall back.
    if (!App.propPointsFor(prop).some(p => p.key === selectedPointKey)) selectedPointKey = 'center';

    renderPointSelector();
    renderPointsStatus();
    dom.qs('#motive-capture-result').textContent = '';
  }

  async function handleCsvFile(file) {
    const prop = currentProp();
    if (!prop) return;
    const resultEl = dom.qs('#motive-capture-result');

    const text = await App.dom.readFileAsText(file);
    const parsed = App.motiveCsv.parse(text);
    if (!parsed || !parsed.frames.length) {
      resultEl.innerHTML = `<span class="err-bad">Couldn't find any usable frames in that file.</span>`;
      return;
    }
    if (parsed.markerLabels.length !== 5) {
      resultEl.innerHTML = `<span class="err-bad">Expected 5 tracked markers on the wand, found ${parsed.markerLabels.length}.</span>`;
      return;
    }

    const calibration = { tipExtensionMm: App.motiveCalibration.tipExtensionMm };
    const capture = App.wandTip.averageCapture(parsed.frames, calibration);
    const appPoint = App.motiveTransform.toAppWorld(capture.position);

    App.Store.updateMeasuredPoint(prop.id, selectedPointKey, {
      world: appPoint,
      jitterMm: capture.jitterMm,
      frameCount: capture.frameCount,
      sourceFile: file.name,
      capturedAt: new Date().toISOString()
    });

    const errClass = capture.jitterMm < 1 ? 'err-ok' : (capture.jitterMm < 5 ? 'err-warn' : 'err-bad');
    resultEl.innerHTML =
      `X = ${appPoint.x.toFixed(3)} m, Y = ${appPoint.y.toFixed(3)} m<br>` +
      `<span class="${errClass}">Jitter: ${capture.jitterMm.toFixed(2)} mm (from ${capture.frameCount} frames)</span>`;
  }

  function solveObject() {
    const prop = currentProp();
    if (!prop) return;
    const result = App.Store.solvePropTransform(prop.id);
    if (!result) { App.toast('Capture at least one point first.', true); return; }
    App.toast(result.pointCount === 1
      ? 'Prop repositioned (rotation kept — capture a 2nd point to solve rotation too).'
      : `Prop position + rotation solved from ${result.pointCount} points (fit residual ${result.fitRms.toFixed(3)}m).`);
  }

  function initTipExtensionInput() {
    const input = dom.qs('#tip-extension-input');
    const stored = App.persistence.loadMotiveCalibration();
    if (stored && stored.tipExtensionMm != null) App.motiveCalibration.tipExtensionMm = stored.tipExtensionMm;
    input.value = App.motiveCalibration.tipExtensionMm;
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      if (isNaN(v)) return;
      App.motiveCalibration.tipExtensionMm = v;
      App.persistence.saveMotiveCalibration({ tipExtensionMm: v });
    });
  }

  App.motiveCapture = {
    init() {
      dom.qs('#btn-solve-object').addEventListener('click', solveObject);
      dom.qs('#motive-csv-input').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) handleCsvFile(file);
        e.target.value = '';
      });
      initTipExtensionInput();

      App.Store.subscribe(render);
      render();
    },
    getSelectedPointKey() { return selectedPointKey; },
    selectPoint
  };
})();
