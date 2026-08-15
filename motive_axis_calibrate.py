#!/usr/bin/env python3
"""Live forward-axis calibration helper for App.motiveCalibration.

Connects directly to server.py's WebSocket bridge (the same stream
js/motive/liveConnection.js consumes) and records raw {pos, quat} frames
for every tracked rigid body. For each of the six local-axis candidates,
replays js/motive/liveTracking.js's exact rotateForwardAxis/forwardTiltDeg/
directionToRotationDeg math (and js/motive/motiveTransform.js's
toAppDirection) over the whole capture, so all six can be compared from a
SINGLE recording instead of re-testing one axis at a time through the Live
Tracking panel's dropdown.

The tilt RANGE across the capture (not a single static reading) is what
identifies the true forward axis: rotating an object about an axis leaves
that axis's own direction unchanged, so the wrong (side/roll) axis will
show a small tilt range even while being genuinely dipped, and the true
forward axis will swing widely. A single static "tilt reads 0 when flat"
check can't tell forward and side apart, since both read near 0 at rest.

CAVEAT (found 2026-08-15 calibrating Camera Tracker -- see
js/motive/motiveCalibration.js's comments): the plain range table above
can ALSO mislead if the recorded motion overshot a clean, bounded pitch --
a real hand-held dip that rotates further than a simple +/-90 forward sweep
can make even the object's genuine UP axis trace a wide range too (it has
a fixed "tent" relationship to the true forward axis's own angle, not a
flat line, so range alone doesn't prove an axis is forward). This tool's
plain output is a lead for which axes to check, not a final answer --
confirm live: flat/level, tilt should read ~0 for every horizontal
candidate (rules out the near-vertical one only); then pitch the object as
far as you physically can and see which candidate's tilt actually
approaches +/-90 in the Live Tracking panel itself. The --gate-axis option
below can also help re-analyze an existing capture once you know a
reliable up/down axis, without a fresh recording.

The reference heading (for liveRotationOffsetDeg) is computed from frames
auto-detected as "still" (small frame-to-frame position movement) rather
than a fixed time window, so it isn't sensitive to exactly when you start
moving the tracker after recording begins.

Usage:
  python motive_axis_calibrate.py --seconds 25 [--ws ws://localhost:8001]
    [--name "Arrow"] [--target-heading 0]

Procedure: start this, then hold the tracker flat/level at the known
reference heading for a couple of seconds, and dip/move it through
whatever motion you want to verify for the rest of the window (repeating
a few times gives a cleaner range reading than one single dip).
"""
import argparse
import json
import math
import sys
import time
from collections import defaultdict

from websockets.sync.client import connect as ws_connect

# --- mirrors js/motive/motiveTransform.js (2026-08-14 calibration) ---
AXIS_MAP = {'appX': 'x', 'appY': 'z'}
SIGN = {'appX': 1, 'appY': -1}
ROTATION_DEG = -0.4867
SCALE_TO_M = 0.001


def to_app_direction(vec):
    local_x = SIGN['appX'] * vec[AXIS_MAP['appX']] * SCALE_TO_M
    local_y = SIGN['appY'] * vec[AXIS_MAP['appY']] * SCALE_TO_M
    a = math.radians(ROTATION_DEG)
    c, s = math.cos(a), math.sin(a)
    return {'x': local_x * c - local_y * s, 'y': local_x * s + local_y * c}


def direction_to_rotation_deg(dir_app):
    # Mirrors js/motive/liveTracking.js's directionToRotationDeg, which
    # follows js/utils/geometry.js's "local -Y = front" convention
    # (rotationDeg=0 means facing the LED wall) -- flipped from the app's
    # original "local +Y = front" on 2026-08-15.
    return math.degrees(math.atan2(dir_app['x'], -dir_app['y']))


# --- mirrors js/motive/liveTracking.js ---
AXIS_VECTORS = {
    '+x': (1, 0, 0), '-x': (-1, 0, 0),
    '+y': (0, 1, 0), '-y': (0, -1, 0),
    '+z': (0, 0, 1), '-z': (0, 0, -1),
}


def rotate_forward_axis(q, v):
    vx, vy, vz = v
    tx = q['y'] * vz - q['z'] * vy + q['w'] * vx
    ty = q['z'] * vx - q['x'] * vz + q['w'] * vy
    tz = q['x'] * vy - q['y'] * vx + q['w'] * vz
    return {
        'x': vx + 2 * (q['y'] * tz - q['z'] * ty),
        'y': vy + 2 * (q['z'] * tx - q['x'] * tz),
        'z': vz + 2 * (q['x'] * ty - q['y'] * tx),
    }


def forward_tilt_deg(forward):
    return math.degrees(math.asin(max(-1.0, min(1.0, forward['y']))))


def dist(a, b):
    return math.sqrt(sum((a[k] - b[k]) ** 2 for k in 'xyz'))


STILL_MM_PER_FRAME = 3.0  # frame-to-frame position movement below this counts as "still"
BASELINE_TILT_DEG = 15.0  # only frames within this |tilt| count toward the heading baseline


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--ws', default='ws://localhost:8001')
    ap.add_argument('--seconds', type=float, default=25.0)
    ap.add_argument('--name', default=None, help='Only capture this rigid body name (default: all)')
    ap.add_argument('--target-heading', type=float, default=0.0,
                     help='app-world rotationDeg the still reference pose should read (default: 0, '
                          'i.e. pointing at the wall -- js/utils/geometry.js\'s ROTATION CONVENTION note)')
    ap.add_argument('--save', default=None, help='Write raw captured frames as JSONL to this path')
    ap.add_argument('--replay', default=None,
                     help='Skip live capture -- re-analyze a JSONL file previously written with --save')
    ap.add_argument('--gate-axis', default=None,
                     help="Use THIS axis's tilt (assumed close to the object's true up/down axis) to "
                          "classify frames as flat-at-rest vs pitched-to-vertical, instead of each "
                          "candidate axis filtering itself. Needed once you know a near-vertical axis: "
                          "self-filtering is circular for it, since ITS OWN low-tilt moments are the "
                          "pitched-to-vertical extremes, not the flat rest pose -- which silently produces "
                          "a confident-looking but wrong answer rather than an obvious failure.")
    ap.add_argument('--gate-threshold', type=float, default=70.0,
                     help='|tilt| above this on --gate-axis counts as "flat"; below (90-this) counts as '
                          '"pitched vertical" (default: 70)')
    args = ap.parse_args()

    frames_by_name = defaultdict(list)

    if args.replay:
        with open(args.replay, encoding='utf-8') as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                if args.name and rec['name'] != args.name:
                    continue
                frames_by_name[rec['name']].append({'t': rec['t'], 'pos': rec['pos'], 'quat': rec['quat']})
    else:
        print(f"Connecting to {args.ws} ...", file=sys.stderr)
        t0 = None
        with ws_connect(args.ws) as ws:
            print(f"Connected. Recording for {args.seconds:.0f}s.", file=sys.stderr)
            deadline = time.monotonic() + args.seconds
            while time.monotonic() < deadline:
                remaining = deadline - time.monotonic()
                try:
                    raw = ws.recv(timeout=min(1.0, max(0.01, remaining)))
                except TimeoutError:
                    continue
                except Exception:
                    break
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                if msg.get('type') != 'frame':
                    continue
                now = time.monotonic()
                if t0 is None:
                    t0 = now
                for rb in msg.get('rigidBodies', []):
                    if args.name and rb.get('name') != args.name:
                        continue
                    if not rb.get('tracking'):
                        continue
                    frames_by_name[rb['name']].append({'t': now - t0, 'pos': rb['pos'], 'quat': rb['quat']})

    if not frames_by_name:
        print("No tracked frames captured -- check the rigid body is ticked in Motive's Assets pane "
              "and --name (if given) matches exactly.", file=sys.stderr)
        return 1

    if args.save:
        with open(args.save, 'w', encoding='utf-8') as out:
            for name, frames in frames_by_name.items():
                for f in frames:
                    out.write(json.dumps({'name': name, **f}) + '\n')
        print(f"Saved {sum(len(f) for f in frames_by_name.values())} raw frames to {args.save}", file=sys.stderr)

    for name, frames in frames_by_name.items():
        print(f"\n=== {name}: {len(frames)} frames over {frames[-1]['t']:.1f}s ===")

        still = [False] * len(frames)
        for i in range(1, len(frames)):
            still[i] = dist(frames[i]['pos'], frames[i - 1]['pos']) < STILL_MM_PER_FRAME
        n_still = sum(still)
        print(f"  {n_still}/{len(frames)} frames auto-detected as still (<{STILL_MM_PER_FRAME}mm/frame movement)")

        if args.gate_axis:
            gate_v = AXIS_VECTORS[args.gate_axis]
            gate_tilts = [forward_tilt_deg(rotate_forward_axis(f['quat'], gate_v)) for f in frames]
            flat_idx = [i for i, t in enumerate(gate_tilts) if abs(t) > args.gate_threshold]
            vert_idx = [i for i, t in enumerate(gate_tilts) if abs(t) < (90 - args.gate_threshold)]
            print(f"  gated by {args.gate_axis}: {len(flat_idx)} flat-classified frames, "
                  f"{len(vert_idx)} pitched-vertical-classified frames")
            for axis in ('+x', '-x', '+y', '-y', '+z', '-z'):
                v = AXIS_VECTORS[axis]
                cand_tilts = [forward_tilt_deg(rotate_forward_axis(f['quat'], v)) for f in frames]
                flat_tilts = [cand_tilts[i] for i in flat_idx]
                vert_tilts = [cand_tilts[i] for i in vert_idx]
                flat_avg = sum(flat_tilts) / len(flat_tilts) if flat_tilts else float('nan')
                vmin = min(vert_tilts) if vert_tilts else float('nan')
                vmax = max(vert_tilts) if vert_tilts else float('nan')

                flat_headings = []
                for i in flat_idx:
                    dir_app = to_app_direction(rotate_forward_axis(frames[i]['quat'], v))
                    flat_headings.append(direction_to_rotation_deg(dir_app))
                if flat_headings:
                    s = sum(math.sin(math.radians(h)) for h in flat_headings)
                    c = sum(math.cos(math.radians(h)) for h in flat_headings)
                    flat_heading = math.degrees(math.atan2(s, c))
                    offset = (args.target_heading - flat_heading + 180) % 360 - 180
                    heading_str, offset_str = f"{flat_heading:+7.1f}", f"{offset:+6.1f}"
                else:
                    heading_str, offset_str = "    n/a", "   n/a"

                print(f"  {axis}: flat-tilt avg {flat_avg:+6.1f} (n={len(flat_tilts)})  "
                      f"pitched-tilt range [{vmin:+6.1f}, {vmax:+6.1f}] (n={len(vert_tilts)})  "
                      f"flat-heading {heading_str}  -> liveRotationOffsetDeg {offset_str}")
            print("  (true forward: ~0 flat-tilt AND pitched-tilt reaching close to +/-90 -- true "
                  "side/roll: ~0 flat-tilt but STAYS ~0 even when pitched, since it's the rotation axis)")
            return 0

        for axis in ('+x', '-x', '+y', '-y', '+z', '-z'):
            v = AXIS_VECTORS[axis]
            tilts = []
            still_headings = []
            for i, f in enumerate(frames):
                forward = rotate_forward_axis(f['quat'], v)
                tilt = forward_tilt_deg(forward)
                tilts.append(tilt)
                if still[i] and abs(tilt) < BASELINE_TILT_DEG:
                    dir_app = to_app_direction(forward)
                    still_headings.append(direction_to_rotation_deg(dir_app))

            tilt_range = max(tilts) - min(tilts)

            if still_headings:
                sin_sum = sum(math.sin(math.radians(h)) for h in still_headings)
                cos_sum = sum(math.cos(math.radians(h)) for h in still_headings)
                baseline_heading = math.degrees(math.atan2(sin_sum, cos_sum))
                offset = args.target_heading - baseline_heading
                offset = (offset + 180) % 360 - 180
                offset_str = f"{offset:+6.1f}"
                heading_str = f"{baseline_heading:+7.1f}"
            else:
                offset_str = "   n/a"
                heading_str = "    n/a"

            print(f"  {axis}: tilt min {min(tilts):+6.1f}  max {max(tilts):+6.1f}  range {tilt_range:5.1f}  "
                  f"| still+level-heading {heading_str} (n={len(still_headings)})  -> liveRotationOffsetDeg {offset_str}")

        print("  (pick the axis with the LARGEST tilt range that also has a stable still-heading -- "
              "that's the one whose direction actually changes with the motion you performed)")

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
