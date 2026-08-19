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

  // ONLY MOVEMENT IS RECORDED. A camera standing still is not perfectly
  // still in the data: the solve jitters, so consecutive frames differ in the
  // last decimal place and the old "is this sample different at all?" test
  // was true 30 times a second whether or not anything had moved. The result
  // was a path that spent most of its points in a blob at each end -- a short
  // nudge could exhaust all 400 of them -- with the actual move drawn from
  // whatever was left.
  //
  // These are the distances below which the camera is treated as parked. Both
  // sit far above the measured noise floor and far below any move worth
  // drawing on a floor plan: a settled body holds heading to sd 0.15 degrees
  // (see CLAUDE.md's Calibration section), and the smallest move anyone would
  // record is a push-in of tens of centimetres.
  const MOVED_EPSILON_M = 0.02;      // 2cm
  const MOVED_EPSILON_DEG = 2;

  // Rotation counts as movement even though the trail stores only x/y: a
  // camera panned in place has genuinely moved, and its trailEndpoints carry
  // the heading at each end. Without this a pan would record as nothing.
  function movedEnough(from, to) {
    if (!from) return true;
    if (Math.hypot(to.x - from.x, to.y - from.y) >= MOVED_EPSILON_M) return true;
    return Math.abs(to.rotationDeg - from.rotationDeg) >= MOVED_EPSILON_DEG;
  }

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

  // What a finished recording amounts to. Pure, so the decision can be tested
  // without a live Motive feed:
  //
  //   'move'   the camera actually travelled -- a path with two endpoints.
  //   'static' it was parked the whole time. STILL A RESULT: the camera is
  //            somewhere, that position is tracked, and it is what belongs on
  //            the plan. Treating this as a failure left the camera showing a
  //            move it is no longer making.
  //   'none'   tracking never delivered a usable frame, so there is nothing to
  //            say about where the camera is.
  function outcomeOf(recorded) {
    if (!recorded.length) return { kind: 'none' };
    if (recorded.length < 2) return { kind: 'static', at: recorded[0] };
    const path = thin(recorded, TRAIL_MAX_POINTS);
    const first = recorded[0], last = recorded[recorded.length - 1];
    return {
      kind: 'move',
      trail: path.map(p => ({ x: p.x, y: p.y })),
      trailEndpoints: {
        start: { x: first.x, y: first.y, rotationDeg: first.rotationDeg },
        end: { x: last.x, y: last.y, rotationDeg: last.rotationDeg }
      }
    };
  }

  // Writes an outcome onto a camera, returning what stop() reports. Split out
  // so the write is testable on its own, and so the 'static' case's trail
  // clearing is visible rather than buried in a branch of stop().
  function applyOutcome(cameraId, outcome) {
    if (outcome.kind === 'none') return null;

    if (outcome.kind === 'static') {
      // The camera never cleared the movement threshold, so what was recorded
      // is a static position rather than a move. Its x/y/rotation are already
      // on the camera -- live tracking writes them every frame -- so what has
      // to change is any PREVIOUS trail, which would otherwise go on showing a
      // move this camera is no longer making. Recording a parked camera is how
      // you say "it sits here now", and keeping the old path would make that
      // impossible to say.
      App.Store.updateCamera(cameraId, { trail: null, trailEndpoints: null });
      return { pointCount: 0, staticAt: outcome.at };
    }

    App.Store.updateCamera(cameraId, {
      trail: outcome.trail,
      trailEndpoints: outcome.trailEndpoints
    });
    return { pointCount: outcome.trail.length };
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

    // Compared against the last KEPT sample, not the last frame: comparing
    // frame-to-frame would let a slow drift through a step at a time and
    // accumulate exactly the blob this is here to prevent.
    const last = samples[samples.length - 1];
    if (!movedEnough(last, camera)) return;
    samples.push({ x: camera.x, y: camera.y, rotationDeg: camera.rotationDeg });
  }

  App.liveRecording = {
    subscribe(fn) { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); },

    // Exposed for test/liveRecording.test.js. The thresholds are the whole
    // behaviour -- too low and the jitter comes back, too high and a real
    // push-in is discarded -- so they are worth pinning; and outcomeOf is the
    // decision stop() acts on, testable without a live Motive feed.
    movedEnough,
    outcomeOf,
    applyOutcome,

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

    // Writes the result onto the camera. Returns { pointCount } -- 0 meaning
    // the camera was parked and its static position stands -- or null if
    // tracking never delivered a frame to record.
    stop() {
      if (!recordingCameraId) return null;
      const cameraId = recordingCameraId;
      const outcome = outcomeOf(samples);
      recordingCameraId = null;
      samples = [];

      const result = applyOutcome(cameraId, outcome);
      emit();
      return result;
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
