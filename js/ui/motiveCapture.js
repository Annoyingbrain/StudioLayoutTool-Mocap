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

  // Alternative to the per-point wand-touch capture above: load a CSV of a
  // 3-marker reference tracker (e.g. the Triangle probe) placed flat on top
  // of the prop, and use its centroid for BOTH X/Y position and height --
  // Motive's raw Y (up-axis) reading converts straight to real height above
  // the studio floor (App.motiveTransform.heightFromRawY), accounting for
  // the Triangle's own markers sitting 1cm above whatever it rests on.
  // Position-only (like a 1-point wand capture): doesn't touch rotation.
  const TRIANGLE_STANDOFF_MM = 10;

  async function handleReferenceTrackerCsvFile(file) {
    const prop = currentProp();
    if (!prop) return;
    const resultEl = dom.qs('#ref-tracker-result');

    const text = await App.dom.readFileAsText(file);
    // A take can have more than one tracked object (e.g. Reference trackers/
    // cam and table.csv has both a camera and the Triangle probe) -- prefer
    // whichever isn't camera-named, since a camera isn't a sensible
    // position/height reference for a prop.
    const rbNames = App.motiveCsv.listRigidBodyNames(text);
    const assetName = rbNames.length > 1 ? (rbNames.find(n => !/camera/i.test(n)) || rbNames[0]) : undefined;
    const parsed = App.motiveCsv.parse(text, assetName);
    if (!parsed || !parsed.frames.length) {
      resultEl.innerHTML = `<span class="err-bad">Couldn't find any usable frames in that file.</span>`;
      return;
    }

    const centroidOf = pts => {
      const n = pts.length;
      return pts.reduce((acc, p) => ({ x: acc.x + p.x / n, y: acc.y + p.y / n, z: acc.z + p.z / n }), { x: 0, y: 0, z: 0 });
    };
    const frameCentroids = parsed.frames.map(f => centroidOf(f.markers));
    const avg = centroidOf(frameCentroids);
    const jitterMm = Math.sqrt(frameCentroids.reduce((sum, c) => {
      const dx = c.x - avg.x, dy = c.y - avg.y, dz = c.z - avg.z;
      return sum + dx * dx + dy * dy + dz * dz;
    }, 0) / frameCentroids.length);

    const appPoint = App.motiveTransform.toAppWorld(avg);
    const heightM = App.motiveTransform.heightFromRawY(avg.y, TRIANGLE_STANDOFF_MM);

    App.Store.updateProp(prop.id, {
      x: Math.round(appPoint.x * 1000) / 1000,
      y: Math.round(appPoint.y * 1000) / 1000,
      heightM: Math.round(heightM * 1000) / 1000,
      positionSource: 'measured'
    });

    const errClass = jitterMm < 1 ? 'err-ok' : (jitterMm < 5 ? 'err-warn' : 'err-bad');
    resultEl.innerHTML =
      `X = ${appPoint.x.toFixed(3)} m, Y = ${appPoint.y.toFixed(3)} m, Height = ${heightM.toFixed(3)} m<br>` +
      `<span class="${errClass}">Jitter: ${jitterMm.toFixed(2)} mm (from ${frameCentroids.length} frames)</span>`;
  }

  // Another alternative to per-point wand-touch capture: load a CSV of the
  // T-bar reference tracker (5 markers: 4 in a line + 1 offset -- same rig
  // geometry as the wand, see App.wandTip.identifyLineAndOffset) placed on
  // a rectangular prop. The line's own center sets X/Y; the offset (5th)
  // marker's direction from that center sets rotation -- mapped to the
  // prop's local +Y ("front"), the same convention js/canvas.js's direction
  // arrow and the studio calibration itself (T-bar's 5th marker = "away
  // from the screen") already use.
  async function handleTbarCsvFile(file) {
    const prop = currentProp();
    if (!prop) return;
    const resultEl = dom.qs('#tbar-result');

    const text = await App.dom.readFileAsText(file);
    const rbNames = App.motiveCsv.listRigidBodyNames(text);
    const assetName = rbNames.length > 1 ? (rbNames.find(n => !/camera/i.test(n)) || rbNames[0]) : undefined;
    const parsed = App.motiveCsv.parse(text, assetName);
    if (!parsed || !parsed.frames.length) {
      resultEl.innerHTML = `<span class="err-bad">Couldn't find any usable frames in that file.</span>`;
      return;
    }
    if (parsed.markerLabels.length !== 5) {
      resultEl.innerHTML = `<span class="err-bad">Expected 5 tracked markers on the T-bar, found ${parsed.markerLabels.length}.</span>`;
      return;
    }

    const meanOf = pts => {
      const n = pts.length;
      return pts.reduce((acc, p) => ({ x: acc.x + p.x / n, y: acc.y + p.y / n, z: acc.z + p.z / n }), { x: 0, y: 0, z: 0 });
    };

    const centers = [], offsets = [];
    parsed.frames.forEach(f => {
      const { lineMarkers, orientationMarker } = App.wandTip.identifyLineAndOffset(f.markers);
      const center = meanOf(lineMarkers);
      centers.push(center);
      offsets.push({ x: orientationMarker.x - center.x, y: orientationMarker.y - center.y, z: orientationMarker.z - center.z });
    });

    const avgCenter = meanOf(centers);
    const jitterMm = Math.sqrt(centers.reduce((sum, c) => {
      const dx = c.x - avgCenter.x, dy = c.y - avgCenter.y, dz = c.z - avgCenter.z;
      return sum + dx * dx + dy * dy + dz * dz;
    }, 0) / centers.length);
    const avgOffset = meanOf(offsets);

    const appPoint = App.motiveTransform.toAppWorld(avgCenter);
    const dirApp = App.motiveTransform.toAppDirection(avgOffset);
    const rotationDeg = Math.atan2(-dirApp.x, dirApp.y) * 180 / Math.PI;

    App.Store.updateProp(prop.id, {
      x: Math.round(appPoint.x * 1000) / 1000,
      y: Math.round(appPoint.y * 1000) / 1000,
      rotationDeg: Math.round(rotationDeg * 10) / 10,
      positionSource: 'measured'
    });

    const errClass = jitterMm < 1 ? 'err-ok' : (jitterMm < 5 ? 'err-warn' : 'err-bad');
    resultEl.innerHTML =
      `X = ${appPoint.x.toFixed(3)} m, Y = ${appPoint.y.toFixed(3)} m, Rotation = ${rotationDeg.toFixed(1)}°<br>` +
      `<span class="${errClass}">Jitter: ${jitterMm.toFixed(2)} mm (from ${centers.length} frames)</span>`;
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
      dom.qs('#ref-tracker-csv-input').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) handleReferenceTrackerCsvFile(file);
        e.target.value = '';
      });
      dom.qs('#tbar-csv-input').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) handleTbarCsvFile(file);
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
