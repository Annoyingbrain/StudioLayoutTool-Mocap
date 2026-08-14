// Live tracking: which incoming Motive rigid body (by name, e.g. "Camera
// 001") drives which app camera/prop while js/motive/liveConnection.js is
// connected, and applying each incoming frame to the Store.
//
// Assignments are in-memory only, NOT part of the saved setup -- a rigid
// body name is a property of the current Motive session/hardware, not the
// studio layout, and won't mean anything on a different machine or a setup
// reloaded later.
//
// Position: converted through the same App.motiveTransform.toAppWorld used
// by the CSV capture flows (js/ui/motiveCapture.js, js/ui/cameraCapture.js)
// -- this is the already-calibrated mm-to-app-meters pipeline, just called
// per live frame instead of once per averaged CSV capture.
//
// Rotation: Motive solves each rigid body's own orientation quaternion
// on-device, using whichever local axes were set when the rigid body asset
// was created in Motive -- unlike the CSV flows, which derive orientation
// from known physical marker geometry (T-bar's offset marker, the camera
// rig's back/left/right spacing) instead of trusting that solve. This
// module assumes local +Y is "forward" (matching every other local-frame
// convention in this app -- js/state.js's cameraLocalMarkers, prop corner
// offsets) and rotates that axis by the incoming quaternion, but whether
// that assumption holds for a given Motive asset is unverified without
// live hardware -- App.motiveCalibration.liveRotationOffsetDeg exists to
// correct for it once you can check against a known real heading.
window.App = window.App || {};

(function () {
  // rigidBodyName -> { entityType: 'camera'|'prop', entityId }
  let assignments = {};
  // rigidBodyName -> latest raw frame entry from server.py: { id, name, tracking, pos:{x,y,z} mm, quat:{x,y,z,w} }
  let latestByName = {};
  const listeners = [];

  // See handleFrame: incoming frames are throttled to this interval before
  // being written into the Store (~30Hz).
  const APPLY_INTERVAL_MS = 33;
  let lastApplyMs = 0;

  // Whether server.py says Motive is actually sending frames -- see
  // setMotiveStreaming.
  let motiveStreaming = false;

  function emit() { listeners.forEach(fn => fn()); }

  // Rotates local +Y (0,1,0) by a unit quaternion (x,y,z,w) -- see
  // js/motive/liveTracking.js module comment for why +Y. Returns the
  // resulting direction as a Motive-space {x,y,z} vector (unit length),
  // suitable for App.motiveTransform.toAppDirection.
  function rotateForwardAxis(q) {
    return {
      x: 2 * (q.x * q.y - q.w * q.z),
      y: 1 - 2 * (q.x * q.x + q.z * q.z),
      z: 2 * (q.y * q.z + q.w * q.x)
    };
  }

  // Same atan2 convention js/ui/motiveCapture.js's T-bar path uses to turn
  // an app-world direction into a rotationDeg matching js/canvas.js's
  // "local +Y = front" drawing convention.
  function directionToRotationDeg(dirApp) {
    return Math.atan2(-dirApp.x, dirApp.y) * 180 / Math.PI;
  }

  function applyToEntity(assignment, rb) {
    const world = App.motiveTransform.toAppWorld(rb.pos);
    const patch = {
      x: Math.round(world.x * 1000) / 1000,
      y: Math.round(world.y * 1000) / 1000,
      positionSource: 'measured'
    };
    const dirApp = App.motiveTransform.toAppDirection(rotateForwardAxis(rb.quat));
    const rotationDeg = directionToRotationDeg(dirApp) + App.motiveCalibration.liveRotationOffsetDeg;
    patch.rotationDeg = Math.round(rotationDeg * 10) / 10;

    if (assignment.entityType === 'camera') App.Store.updateCamera(assignment.entityId, patch);
    else App.Store.updateProp(assignment.entityId, patch);
  }

  App.liveTracking = {
    subscribe(fn) { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); },

    getAssignments() { return assignments; },
    getAssignmentFor(rigidBodyName) { return assignments[rigidBodyName] || null; },
    assign(rigidBodyName, entityType, entityId) {
      assignments[rigidBodyName] = { entityType, entityId };
      emit();
    },
    unassign(rigidBodyName) {
      delete assignments[rigidBodyName];
      emit();
    },
    // Clears any assignment pointing at this entity, e.g. when it's deleted.
    unassignEntity(entityType, entityId) {
      Object.keys(assignments).forEach(name => {
        const a = assignments[name];
        if (a.entityType === entityType && a.entityId === entityId) delete assignments[name];
      });
      emit();
    },

    // Every rigid body name seen in at least one frame so far this
    // connection -- for populating the assignment UI's picker.
    getKnownNames() { return Object.keys(latestByName); },
    getLatest(rigidBodyName) { return latestByName[rigidBodyName] || null; },

    // Called by js/motive/liveConnection.js on each incoming frame.
    //
    // Frames arrive at Motive's full capture rate (120/s). Writing every one
    // into the Store would re-render the whole app -- canvas, sidebar,
    // inspector -- 120 times a second, which is both wasteful and actively
    // harmful (it fights the user's typing in the inspector's X/Y fields).
    // Applying at ~30Hz is indistinguishable to the eye for watching a prop
    // move. A frame that adds a rigid body not seen before still emits
    // immediately, so a newly-enabled asset shows up in the UI at once
    // rather than waiting on the throttle.
    handleFrame(rigidBodies) {
      let sawNewName = false;
      rigidBodies.forEach(rb => {
        if (!(rb.name in latestByName)) sawNewName = true;
        latestByName[rb.name] = rb;
      });

      const now = (window.performance && performance.now()) ? performance.now() : Date.now();
      if (!sawNewName && now - lastApplyMs < APPLY_INTERVAL_MS) return;
      lastApplyMs = now;

      Object.keys(assignments).forEach(name => {
        const rb = latestByName[name];
        if (!rb || !rb.tracking) return;
        applyToEntity(assignments[name], rb);
      });
      emit();
    },

    // Whether Motive is currently sending data, as reported by server.py.
    // Distinct from the WebSocket being connected: Motive can stop
    // streaming (switched to Edit mode) while the bridge connection is
    // perfectly healthy, and the UI shouldn't claim things are still being
    // tracked in that case.
    isMotiveStreaming() { return motiveStreaming; },
    setMotiveStreaming(streaming) {
      if (motiveStreaming === streaming) return;
      motiveStreaming = streaming;
      // Nothing is being tracked while the stream is down -- drop the stale
      // positions rather than leaving them looking live.
      if (!streaming) Object.keys(latestByName).forEach(n => { latestByName[n].tracking = false; });
      emit();
    },

    // Called on disconnect so stale "tracking" status doesn't linger in the UI.
    reset() {
      latestByName = {};
      motiveStreaming = false;
      emit();
    }
  };
})();
