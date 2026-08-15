// Live tracking: which incoming Motive rigid body (by name, e.g. "Camera
// 001") drives which app camera/prop while js/motive/liveConnection.js is
// connected, and applying each incoming frame to the Store.
//
// Assignments are in-memory only, NOT part of the saved setup -- a rigid
// body name is a property of the current Motive session/hardware, not the
// studio layout, and won't mean anything on a different machine or a setup
// reloaded later.
//
// Position: converted through App.motiveTransform.toAppWorld -- the
// mm-to-app-meters pipeline calibrated against the studio floor plan.
//
// Rotation: Motive solves each rigid body's own orientation quaternion
// on-device, using whichever local axes were set when the rigid body asset
// was created in Motive -- which one counts as "forward" is per-asset and
// configured in App.motiveCalibration.liveForwardAxis (see that file and
// motive_axis_calibrate.py for how it's derived). The resulting direction is
// then mapped to a rotationDeg using this app's OWN "local -Y = front"
// convention (js/utils/geometry.js's ROTATION CONVENTION note) --
// App.motiveCalibration.liveRotationOffsetDeg absorbs whatever fixed offset
// is left once the axis is right.
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

  const AXIS_VECTORS = {
    '+x': { x: 1, y: 0, z: 0 }, '-x': { x: -1, y: 0, z: 0 },
    '+y': { x: 0, y: 1, z: 0 }, '-y': { x: 0, y: -1, z: 0 },
    '+z': { x: 0, y: 0, z: 1 }, '-z': { x: 0, y: 0, z: -1 }
  };

  // Rotates the configured local forward axis
  // (App.motiveCalibration.liveForwardAxis) by a unit quaternion (x,y,z,w),
  // giving that axis's current direction as a Motive-space {x,y,z} unit
  // vector -- suitable for App.motiveTransform.toAppDirection, and for
  // reading tilt off its vertical component.
  //
  // v' = v + 2 * qv x (qv x v + w*v), the standard quaternion-vector
  // rotation, so any axis works rather than just a hardcoded one.
  function rotateForwardAxis(q) {
    const v = AXIS_VECTORS[App.motiveCalibration.liveForwardAxis] || AXIS_VECTORS['+z'];
    const tx = q.y * v.z - q.z * v.y + q.w * v.x;
    const ty = q.z * v.x - q.x * v.z + q.w * v.y;
    const tz = q.x * v.y - q.y * v.x + q.w * v.z;
    return {
      x: v.x + 2 * (q.y * tz - q.z * ty),
      y: v.y + 2 * (q.z * tx - q.x * tz),
      z: v.z + 2 * (q.x * ty - q.y * tx)
    };
  }

  // Turns an app-world direction into a rotationDeg matching
  // js/utils/geometry.js's "local -Y = front" convention (rotationDeg=0
  // means facing the LED wall).
  function directionToRotationDeg(dirApp) {
    return Math.atan2(dirApp.x, -dirApp.y) * 180 / Math.PI;
  }

  // Tilt is the elevation of the same forward axis the heading uses: how far
  // above (+) or below (-) horizontal the object points. Motive's Y is the
  // up-axis (established by motiveTransform's floor-baseline calibration),
  // so the forward vector's Y component is its vertical part -- and since
  // rotateForwardAxis returns a unit vector, asin of that is the angle.
  // Independent of which app-side axis counts as "front" (that only affects
  // heading, via directionToRotationDeg above) -- tilt is calibrated per
  // App.motiveCalibration.liveForwardAxis regardless.
  function forwardTiltDeg(forward) {
    return Math.asin(Math.max(-1, Math.min(1, forward.y))) * 180 / Math.PI;
  }

  function applyToEntity(assignment, rb) {
    const world = App.motiveTransform.toAppWorld(rb.pos);
    const patch = {
      x: Math.round(world.x * 1000) / 1000,
      y: Math.round(world.y * 1000) / 1000,
      positionSource: 'measured'
    };
    const forward = rotateForwardAxis(rb.quat);
    const dirApp = App.motiveTransform.toAppDirection(forward);
    const rotationDeg = directionToRotationDeg(dirApp) + App.motiveCalibration.liveRotationOffsetDeg;
    patch.rotationDeg = Math.round(rotationDeg * 10) / 10;

    if (assignment.entityType === 'camera') {
      // Height/tilt are only tracked for cameras: a prop's heightM is a
      // hand-entered physical dimension, and overwriting it from the
      // tracker's pivot height would be wrong (and would fight the input
      // the same way x/y does).
      // standoff 0: a rigid body's origin is its own pivot, not a marker
      // resting on a surface, so there's nothing to subtract.
      patch.heightM = Math.round(App.motiveTransform.heightFromRawY(rb.pos.y, 0) * 1000) / 1000;
      patch.tiltDeg = Math.round(forwardTiltDeg(forward) * 10) / 10;
      App.Store.updateCamera(assignment.entityId, patch);
    } else {
      App.Store.updateProp(assignment.entityId, patch);
    }
  }

  App.liveTracking = {
    subscribe(fn) { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); },

    getAssignments() { return assignments; },
    getAssignmentFor(rigidBodyName) { return assignments[rigidBodyName] || null; },

    // The reverse lookup: which rigid body (if any) is currently driving
    // this prop/camera. Returns its name, or null. Used by the inspectors to
    // show -- and lock -- fields that live tracking owns, since anything
    // typed into them would just be overwritten by the next frame.
    getRigidBodyDriving(entityType, entityId) {
      const name = Object.keys(assignments).find(n => {
        const a = assignments[n];
        return a.entityType === entityType && a.entityId === entityId;
      });
      return name || null;
    },
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
