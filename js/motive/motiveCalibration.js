// Calibration values for live Motive tracking that can't be derived from
// tracking data alone -- they describe physical/authoring choices and have
// to be set once by hand.
//
// PER-TRACKER, not global: each Motive rigid-body ASSET has its own local
// frame (which axis is "forward" was set arbitrarily when that specific
// asset was created), so Camera Tracker and the T-bar need different values
// ('+z' vs '-z' -- both confirmed live 2026-08-17). An earlier version of
// this file had ONE global set of these fields applied to every rigid body
// -- fine while only one was ever in live use, but wrong as soon as a
// second one (e.g. T-bar driving a rectangular prop, per this studio's
// actual workflow -- see CLAUDE.md's Conventions) came online too: it
// silently applied Camera Tracker's calibration to T-bar's frames,
// producing a rotation nowhere near correct.
//
// Two layers, because a live rigid body's NAME can't currently be trusted:
//
//   PROFILES -- the known, physically-derived calibration for each real
//     tracker, by asset name. Stable, code-shipped, never edited at runtime.
//
//   trackers -- what's actually applied to each live rigid body, keyed by
//     the name it arrives under (server.py's per-frame "name" field). With
//     Motive name resolution disabled (see server.py's natnet_loop) that's
//     presently a bare numeric id like "1", NOT the asset's real name, so
//     the matching profile can't be picked automatically. The Live Tracking
//     panel's per-row profile picker applies one in a click, and the choice
//     persists -- until Motive reassigns ids, after which re-pick it.
//     Seeded from PROFILES by real name too, so everything resolves
//     automatically if the naming issue is ever fixed.
window.App = window.App || {};

(function () {
  // Both confirmed live 2026-08-17 by direct comparison in the panel:
  // flat and level, every horizontal candidate reads ~0 tilt (that only
  // rules out the near-vertical up axis); pitched as far towards vertical
  // as physically possible, the TRUE forward axis approaches +/-90 while
  // the side/roll axis stays small. See CLAUDE.md's Calibration section for
  // why a static reading -- or an automated capture's widest tilt range --
  // isn't sufficient evidence on its own.
  const PROFILES = {
    // The general-purpose production camera rigid body: 3 markers, marker 1
    // forward, markers 2/3 right/left.
    'Camera Tracker': {
      liveForwardAxis: '+z',
      // 0 as of 2026-08-17, replacing an earlier -9.6 that came from a
      // SINGLE aligned hand placement. Six such placements later spanned 25
      // degrees (mean -3.0, sd 10.4), which puts the correct offset at
      // +3.0 +/- 4.2 -- indistinguishable from 0, and ruling out -9.6 at
      // ~3 standard errors.
      //
      // That scatter is hand-placement precision, NOT tracking error: a
      // settled, locked body holds heading to sd 0.15 over 2400 frames. So
      // don't re-derive this by putting the tracker down by eye -- no
      // number of placements beats ~+/-4 that way. Calibrate it with the
      // tracker MOUNTED as it's actually used, pointed at a known
      // reference; mounted, the offset is a real constant and heading
      // tracks at 0.15. See CLAUDE.md's Calibration section.
      liveRotationCalibratedOffsetDeg: 0,
      liveRotationUserOffsetDeg: 0,
      // Markers flush on the floor (no physical standoff) read heightM
      // -0.01 with this at 0 -- +0.01 corrects it to 0.
      // App.motiveTransform.FLOOR_BASELINE_MM (the raw Motive Y that means
      // real floor level) was derived from reference-tracker MARKER
      // positions, not a rigid body's own solved pivot -- for an asset
      // whose pivot sits somewhere other than exactly at its markers'
      // plane, height reads off by a constant even at true floor level.
      // Only meaningful for a tracker driving a CAMERA: a prop's heightM is
      // hand-entered and never overwritten live (liveTracking.js).
      liveHeightOffsetM: 0.01
    },
    // The "Arrow" T-bar reference tracker -- used to position rectangular
    // props. Its own Motive asset, hence its own local frame.
    'T-bar': {
      liveForwardAxis: '-z',
      // Derived 2026-08-15 (T-bar flat, pointed at the wall). Carried over
      // unchanged through that day's rotation-convention flip: the flip
      // shifts the computed heading AND the target by the same 180 degrees,
      // so they cancel. The AXIS is live-confirmed; this small offset is
      // not independently re-verified since -- if a T-bar-driven prop reads
      // a consistent degree or two off with the row's "rot°" at 0, correct
      // it here rather than in the per-row field.
      liveRotationCalibratedOffsetDeg: 0.5,
      liveRotationUserOffsetDeg: 0,
      liveHeightOffsetM: 0
    }
  };

  // An unknown tracker gets a deliberately WRONG-looking axis rather than a
  // guess: '+y' is Motive's up axis, so tilt pins near +/-90 with the object
  // level and rotation jitters -- the documented "this needs calibrating"
  // signature (CLAUDE.md). Guessing '+z' instead would half-work and read as
  // a subtle calibration error instead of an obvious unset one.
  const UNCALIBRATED = {
    liveForwardAxis: '+y',
    liveRotationCalibratedOffsetDeg: 0,
    liveRotationUserOffsetDeg: 0,
    liveHeightOffsetM: 0
  };

  App.motiveCalibration = {
    PROFILES,

    // Which incoming rigid body NAME gets the Live Tracking panel's
    // simplified Tracked/Fixed camera toggle instead of the general
    // camera-or-prop dropdown -- see js/ui/liveTrackingUi.js's "Set as
    // tracker" button, which is what actually sets this day to day.
    cameraTrackerName: 'Camera Tracker',

    // The trackers used to measure PROPS, in the order their link buttons
    // appear on each row of the prop list (js/ui/sidebar.js). T-bar handles
    // rectangular props, Triangle circular/triangular ones. Names must match
    // what server.py --name-map calls them, since assignments are keyed by
    // the name a rigid body arrives under.
    propTrackerNames: ['T-bar', 'Triangle'],

    // liveName -> calibration. Seeded with the real asset names so profiles
    // apply automatically if/when name resolution works; live numeric-id
    // rows get theirs via applyProfile() or the per-row fields.
    trackers: Object.keys(PROFILES).reduce((acc, key) => {
      acc[key] = Object.assign({}, PROFILES[key]);
      return acc;
    }, {}),

    // Reads the calibration for a live rigid body name, creating an
    // uncalibrated entry the first time a name is seen so callers never hit
    // undefined fields. Always go through this rather than indexing
    // `trackers` directly.
    forTracker(name) {
      if (!this.trackers[name]) this.trackers[name] = Object.assign({}, UNCALIBRATED);
      return this.trackers[name];
    },

    // Copies a PROFILE's values onto whatever name a tracker is currently
    // arriving under. A one-shot copy, not a live link -- editing the row's
    // fields afterwards adjusts only that row, leaving the profile intact
    // as the reference values.
    applyProfile(name, profileName) {
      const profile = PROFILES[profileName];
      if (!profile) return null;
      this.trackers[name] = Object.assign({}, profile);
      return this.trackers[name];
    }
  };
})();
