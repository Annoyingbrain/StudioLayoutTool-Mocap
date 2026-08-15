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

The reference heading (for liveRotationOffsetDeg) is computed from frames
auto-detected as "still" (small frame-to-frame position movement) rather
than a fixed time window, so it isn't sensitive to exactly when you start
moving the tracker after recording begins.

Usage:
  python motive_axis_calibrate.py --seconds 25 [--ws ws://localhost:8001]
    [--name "Arrow"] [--target-heading 180]

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
    return math.degrees(math.atan2(-dir_app['x'], dir_app['y']))


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


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--ws', default='ws://localhost:8001')
    ap.add_argument('--seconds', type=float, default=25.0)
    ap.add_argument('--name', default=None, help='Only capture this rigid body name (default: all)')
    ap.add_argument('--target-heading', type=float, default=180.0,
                     help='app-world rotationDeg the still reference pose should read (default: 180, '
                          'i.e. pointing at the wall per the floor-center calibration)')
    args = ap.parse_args()

    print(f"Connecting to {args.ws} ...", file=sys.stderr)
    frames_by_name = defaultdict(list)
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

    for name, frames in frames_by_name.items():
        print(f"\n=== {name}: {len(frames)} frames over {frames[-1]['t']:.1f}s ===")

        still = [False] * len(frames)
        for i in range(1, len(frames)):
            still[i] = dist(frames[i]['pos'], frames[i - 1]['pos']) < STILL_MM_PER_FRAME
        n_still = sum(still)
        print(f"  {n_still}/{len(frames)} frames auto-detected as still (<{STILL_MM_PER_FRAME}mm/frame movement)")

        for axis in ('+x', '-x', '+y', '-y', '+z', '-z'):
            v = AXIS_VECTORS[axis]
            tilts = []
            still_headings = []
            for i, f in enumerate(frames):
                forward = rotate_forward_axis(f['quat'], v)
                tilt = forward_tilt_deg(forward)
                tilts.append(tilt)
                if still[i]:
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
                  f"| still-heading {heading_str}  -> liveRotationOffsetDeg {offset_str}")

        print("  (pick the axis with the LARGEST tilt range that also has a stable still-heading -- "
              "that's the one whose direction actually changes with the motion you performed)")

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
