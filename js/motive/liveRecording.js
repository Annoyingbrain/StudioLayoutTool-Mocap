// Records a camera's live movement into the trail that js/canvas.js already
// draws: the sampled path plus an oriented camera icon at the start and end
// of the move.
//
// Samples come from js/motive/liveTracking.js's emissions rather than the
// raw WebSocket frames, so what gets recorded is exactly what was on screen
// -- same transform, same rotation offset, same ~30Hz throttle. The camera
// has to be assigned to a rigid body for there to be anything to record.
window.App = window.App || {};

(function () {
  // A long dolly move at 30Hz would be thousands of points, far more than a
  // floor-plan line needs. The path is thinned to this many on stop, always
  // keeping the true first and last sample so the endpoints stay exact.
  const TRAIL_MAX_POINTS = 400;

  let recordingCameraId = null;
  let samples = [];
  const listeners = [];

  function emit() { listeners.forEach(fn => fn()); }

  function thin(list, max) {
    if (list.length <= max) return list.slice();
    const step = (list.length - 1) / (max - 1);
    const out = [];
    for (let i = 0; i < max; i++) out.push(list[Math.round(i * step)]);
    return out;
  }

  // Called on every liveTracking emission while recording.
  function sample() {
    if (!recordingCameraId) return;
    const camera = App.Store.getCameras().find(c => c.id === recordingCameraId);
    if (!camera) { App.liveRecording.cancel(); return; }

    // Only record while the camera is actually being driven and Motive is
    // sending data -- otherwise a pause would record a long pile of
    // identical points, or worse, points the tracker never produced.
    const drivenBy = App.liveTracking.getRigidBodyDriving('camera', camera.id);
    if (!drivenBy) return;
    const latest = App.liveTracking.getLatest(drivenBy);
    if (!latest || !latest.tracking) return;

    const last = samples[samples.length - 1];
    if (last && last.x === camera.x && last.y === camera.y && last.rotationDeg === camera.rotationDeg) return;
    samples.push({ x: camera.x, y: camera.y, rotationDeg: camera.rotationDeg });
  }

  App.liveRecording = {
    subscribe(fn) { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); },

    isRecording() { return recordingCameraId !== null; },
    getCameraId() { return recordingCameraId; },
    getSampleCount() { return samples.length; },

    // Returns null on success, or a message explaining why it couldn't start.
    start(cameraId) {
      if (recordingCameraId) return 'Already recording.';
      if (!App.liveTracking.getRigidBodyDriving('camera', cameraId)) {
        return 'Assign this camera to a rigid body in Live Tracking first — there\'s nothing to record otherwise.';
      }
      recordingCameraId = cameraId;
      samples = [];
      emit();
      return null;
    },

    // Writes the recorded path onto the camera as its trail. Returns
    // { pointCount } on success, or null if there wasn't enough movement to
    // be worth keeping (the existing trail is then left untouched).
    stop() {
      if (!recordingCameraId) return null;
      const cameraId = recordingCameraId;
      const recorded = samples;
      recordingCameraId = null;
      samples = [];

      if (recorded.length < 2) { emit(); return null; }

      const path = thin(recorded, TRAIL_MAX_POINTS);
      const first = recorded[0], last = recorded[recorded.length - 1];
      App.Store.updateCamera(cameraId, {
        trail: path.map(p => ({ x: p.x, y: p.y })),
        trailEndpoints: {
          start: { x: first.x, y: first.y, rotationDeg: first.rotationDeg },
          end: { x: last.x, y: last.y, rotationDeg: last.rotationDeg }
        }
      });
      emit();
      return { pointCount: path.length };
    },

    // Abandon without writing anything (e.g. the camera was deleted).
    cancel() {
      if (!recordingCameraId) return;
      recordingCameraId = null;
      samples = [];
      emit();
    },

    clearTrail(cameraId) {
      App.Store.updateCamera(cameraId, { trail: null, trailEndpoints: null });
    },

    init() {
      App.liveTracking.subscribe(sample);
    }
  };
})();
