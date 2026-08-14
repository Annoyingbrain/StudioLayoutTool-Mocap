// Camera Motive capture panel. Unlike a prop's points (touched one at a time
// with the wand, one CSV per point), a camera's 3 rig markers (back/left/
// right, see App.cameraLocalMarkers in js/state.js) are its own tracked
// rigid body -- a single Motive capture already contains all 3 simultaneously
// (js/motive/motiveCsv.js's parser already isolates just this asset's own
// markers, ignoring unrelated stray/"Unlabeled" ones). So loading one CSV
// populates back/left/right together and solves the camera's position +
// rotation immediately, no per-marker selection step needed.
window.App = window.App || {};

(function () {
  const dom = App.dom;

  function currentCamera() { return App.Store.getSelectedCamera(); }

  function renderMarkersStatus() {
    const camera = currentCamera();
    const container = dom.qs('#camera-markers-status');
    dom.clear(container);
    App.CAMERA_POINTS.forEach(({ key, label }) => {
      const mp = camera.measuredMarkers[key];
      const statusText = mp
        ? `captured (±${mp.jitterMm.toFixed(2)}mm jitter, ${mp.frameCount} frames)`
        : 'not captured';
      container.appendChild(dom.el('div', { class: 'point-status-row' }, [
        dom.el('span', { class: 'psr-label', text: label }),
        dom.el('span', { class: 'psr-status' + (mp ? ' solved' : ''), text: statusText })
      ]));
    });
  }

  function render() {
    const camera = currentCamera();
    const empty = dom.qs('#camera-motive-empty'), fields = dom.qs('#camera-motive-fields');
    if (!camera) { empty.classList.remove('hidden'); fields.classList.add('hidden'); return; }
    empty.classList.add('hidden'); fields.classList.remove('hidden');
    renderMarkersStatus();
    dom.qs('#camera-capture-result').textContent = '';
  }

  // A take can have more than one tracked object in it (e.g. the camera and
  // a prop captured together) -- pick out the camera's own rigid body by
  // name rather than just taking whichever appears first in the file.
  // Returns null (with an error already written to resultEl) if none found.
  function pickCameraAssetName(text, rbNames, resultEl) {
    if (rbNames.length <= 1) return rbNames[0];
    const assetName = rbNames.find(n => n === 'Camera 001') || rbNames.find(n => /camera/i.test(n));
    if (!assetName) {
      resultEl.innerHTML = `<span class="err-bad">This file has multiple tracked objects (${rbNames.join(', ')}) and none look like a camera rig -- not sure which to use.</span>`;
    }
    return assetName || null;
  }

  // Given a set of already-parsed frames (any subset -- the whole take, or
  // just a short window) and the marker labels they came from, averages
  // each of back/left/right into its own app-world position. Returns
  // { worldByKey: {back,left,right}, jitterByKey } or null if the labels
  // don't look like a 3-marker camera rig.
  function averageMarkers(frames, markerLabels) {
    // Motive's own marker numbering, confirmed by the user (2026-08-14) to
    // match physical roles directly: Marker 001 = back, 002 = right, 003 = left.
    const keyByLabel = { 'Marker 001': 'back', 'Marker 002': 'right', 'Marker 003': 'left' };
    const indexByKey = {};
    markerLabels.forEach((label, i) => {
      const suffix = Object.keys(keyByLabel).find(s => label.endsWith(s));
      if (suffix) indexByKey[keyByLabel[suffix]] = i;
    });
    if (Object.keys(indexByKey).length !== 3) return null;

    const worldByKey = {}, jitterByKey = {};
    App.CAMERA_POINTS.forEach(({ key }) => {
      const idx = indexByKey[key];
      const pts = frames.map(f => f.markers[idx]);
      const mean = { x: 0, y: 0, z: 0 };
      pts.forEach(p => { mean.x += p.x / pts.length; mean.y += p.y / pts.length; mean.z += p.z / pts.length; });
      jitterByKey[key] = Math.sqrt(pts.reduce((sum, p) => {
        const dx = p.x - mean.x, dy = p.y - mean.y, dz = p.z - mean.z;
        return sum + dx * dx + dy * dy + dz * dz;
      }, 0) / pts.length);
      worldByKey[key] = App.motiveTransform.toAppWorld(mean);
    });
    return { worldByKey, jitterByKey };
  }

  // Solves position + rotation from already-averaged per-marker world
  // positions, via the same Procrustes fit (js/rigidFit.js) against the
  // camera's known rig geometry (App.cameraLocalMarkers) that
  // App.Store.solveCameraTransform uses.
  function solvePoseFromWorldByKey(worldByKey) {
    const correspondences = App.CAMERA_POINTS.map(({ key }) => ({ local: App.cameraLocalMarkers[key], world: worldByKey[key] }));
    return App.rigidFit.solve(correspondences, 0); // { x, y, rotationDeg, fitRms }
  }

  async function handleCsvFile(file) {
    const camera = currentCamera();
    if (!camera) return;
    const resultEl = dom.qs('#camera-capture-result');

    const text = await App.dom.readFileAsText(file);
    const rbNames = App.motiveCsv.listRigidBodyNames(text);
    const assetName = pickCameraAssetName(text, rbNames, resultEl);
    if (assetName === null) return;

    const parsed = App.motiveCsv.parse(text, assetName);
    if (!parsed || !parsed.frames.length) {
      resultEl.innerHTML = `<span class="err-bad">Couldn't find any usable frames in that file.</span>`;
      return;
    }
    if (parsed.markerLabels.length !== 3) {
      resultEl.innerHTML = `<span class="err-bad">Expected 3 tracked markers on the camera rig, found ${parsed.markerLabels.length}.</span>`;
      return;
    }

    const averaged = averageMarkers(parsed.frames, parsed.markerLabels);
    if (!averaged) {
      resultEl.innerHTML = `<span class="err-bad">Couldn't match markers to back/left/right from their labels (${parsed.markerLabels.join(', ')}).</span>`;
      return;
    }

    const lines = [];
    App.CAMERA_POINTS.forEach(({ key, label }) => {
      App.Store.updateMeasuredCameraMarker(camera.id, key, {
        world: averaged.worldByKey[key], jitterMm: averaged.jitterByKey[key],
        frameCount: parsed.frames.length, sourceFile: file.name, capturedAt: new Date().toISOString()
      });
      const j = averaged.jitterByKey[key];
      const errClass = j < 1 ? 'err-ok' : (j < 5 ? 'err-warn' : 'err-bad');
      lines.push(`${label}: <span class="${errClass}">jitter ${j.toFixed(2)}mm</span>`);
    });

    const result = App.Store.solveCameraTransform(camera.id);
    resultEl.innerHTML = lines.join('<br>') + (result
      ? `<br>Solved (fit residual ${result.fitRms.toFixed(3)}m)`
      : '');
  }

  // Trail: unlike handleCsvFile above (a static rigid-body capture averaged
  // to one position + rotation), a dolly-move recording has thousands of
  // frames of real movement -- this instead samples the camera's centroid
  // position (position only, no orientation) across the whole take into a
  // path for js/canvas.js to draw as a trail. Purely a visualization, not
  // solved/editable -- see App.factories.newCamera's `trail` field.
  const TRAIL_MAX_POINTS = 400;

  async function handleTrackCsvFile(file) {
    const camera = currentCamera();
    if (!camera) return;
    const resultEl = dom.qs('#camera-capture-result');

    const text = await App.dom.readFileAsText(file);
    const rbNames = App.motiveCsv.listRigidBodyNames(text);
    const assetName = pickCameraAssetName(text, rbNames, resultEl);
    if (assetName === null) return;

    const parsed = App.motiveCsv.parse(text, assetName);
    if (!parsed || !parsed.frames.length) {
      resultEl.innerHTML = `<span class="err-bad">Couldn't find any usable frames in that file.</span>`;
      return;
    }

    const step = Math.max(1, Math.ceil(parsed.frames.length / TRAIL_MAX_POINTS));
    const trail = [];
    for (let i = 0; i < parsed.frames.length; i += step) {
      const pts = parsed.frames[i].markers;
      const centroid = { x: 0, y: 0, z: 0 };
      pts.forEach(p => { centroid.x += p.x / pts.length; centroid.y += p.y / pts.length; centroid.z += p.z / pts.length; });
      const world = App.motiveTransform.toAppWorld(centroid);
      trail.push({ x: world.x, y: world.y });
    }

    // Position + rotation at the very start/end of the move, averaged over a
    // short window for noise reduction, so js/canvas.js can draw an oriented
    // camera icon at each end of the trail (not just the plain line).
    const ENDPOINT_WINDOW = 10;
    let trailEndpoints = null;
    if (parsed.markerLabels.length === 3) {
      const startFrames = parsed.frames.slice(0, Math.min(ENDPOINT_WINDOW, parsed.frames.length));
      const endFrames = parsed.frames.slice(-Math.min(ENDPOINT_WINDOW, parsed.frames.length));
      const startAvg = averageMarkers(startFrames, parsed.markerLabels);
      const endAvg = averageMarkers(endFrames, parsed.markerLabels);
      const startPose = startAvg && solvePoseFromWorldByKey(startAvg.worldByKey);
      const endPose = endAvg && solvePoseFromWorldByKey(endAvg.worldByKey);
      if (startPose && endPose) {
        trailEndpoints = {
          start: { x: startPose.x, y: startPose.y, rotationDeg: startPose.rotationDeg },
          end: { x: endPose.x, y: endPose.y, rotationDeg: endPose.rotationDeg }
        };
      }
    }

    App.Store.updateCamera(camera.id, { trail, trailEndpoints });

    const durationSec = parsed.frames.length > 1 ? parsed.frames[parsed.frames.length - 1].timeSec - parsed.frames[0].timeSec : 0;
    resultEl.innerHTML = `Trail loaded: ${trail.length} points sampled from ${parsed.frames.length} frames (~${durationSec.toFixed(1)}s).`;
  }

  App.cameraCapture = {
    init() {
      dom.qs('#camera-motive-csv-input').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) handleCsvFile(file);
        e.target.value = '';
      });
      dom.qs('#camera-track-csv-input').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) handleTrackCsvFile(file);
        e.target.value = '';
      });

      App.Store.subscribe(render);
      render();
    },
    // Always 'back'/'left'/'right' capture together -- kept for parity with
    // motiveCapture's getSelectedPointKey() so js/canvas.js's selected-point
    // highlight can show a fixed reference marker (back) without a picker.
    getSelectedMarkerKey() { return 'back'; }
  };
})();
