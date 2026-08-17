#!/usr/bin/env python3
"""Diagnostic: how stable is a rigid body's solved HEADING?

Reach for this whenever live rotation looks wrong, BEFORE theorising about
calibration constants -- reading stability off the app's on-screen number by
eye conflates three different faults, and doing exactly that produced two
confident wrong diagnoses on 2026-08-17 (see CLAUDE.md's Calibration
section).

Connects to server.py's WebSocket bridge and replays the app's exact
heading math (js/motive/liveTracking.js + motiveTransform.js, forward axis
'+z', offset 0) over every frame -- then reports the three things that
distinguish the possible faults from each other:

  1. Jitter WITHIN a continuously-tracked run (tracker sitting still).
     Large here => the rigid body solve itself is noisy (markers too close
     together, poor camera coverage, grazing view of a floor-flat body).
     No calibration constant can fix this.

  2. Mean heading PER RUN, where a run is a stretch of unbroken tracking.
     Runs are split on tracking dropouts -- i.e. exactly the re-acquisition
     events that a lift-and-replace causes. Stable within runs but
     different between them => discrete solve states.

  3. Frame-to-frame jumps, to catch instantaneous flips that don't come
     with a tracking dropout.
"""
import argparse, json, math, statistics, sys, time
from websockets.sync.client import connect as ws_connect

# --- js/motive/motiveTransform.js (2026-08-14 calibration) ---
AXIS_MAP = {'appX': 'x', 'appY': 'z'}
SIGN = {'appX': 1, 'appY': -1}
ROTATION_DEG = -0.4867
SCALE_TO_M = 0.001

AXIS_VECTORS = {
    '+x': (1, 0, 0), '-x': (-1, 0, 0),
    '+y': (0, 1, 0), '-y': (0, -1, 0),
    '+z': (0, 0, 1), '-z': (0, 0, -1),
}


def rotate_axis(q, v):
    vx, vy, vz = v
    tx = q['y'] * vz - q['z'] * vy + q['w'] * vx
    ty = q['z'] * vx - q['x'] * vz + q['w'] * vy
    tz = q['x'] * vy - q['y'] * vx + q['w'] * vz
    return {'x': vx + 2 * (q['y'] * tz - q['z'] * ty),
            'y': vy + 2 * (q['z'] * tx - q['x'] * tz),
            'z': vz + 2 * (q['x'] * ty - q['y'] * tx)}


def heading_deg(q, axis, offset):
    f = rotate_axis(q, AXIS_VECTORS[axis])
    lx = SIGN['appX'] * f[AXIS_MAP['appX']] * SCALE_TO_M
    ly = SIGN['appY'] * f[AXIS_MAP['appY']] * SCALE_TO_M
    a = math.radians(ROTATION_DEG)
    c, s = math.cos(a), math.sin(a)
    dx, dy = lx * c - ly * s, lx * s + ly * c
    return math.degrees(math.atan2(dx, -dy)) + offset


def tilt_deg(q, axis):
    return math.degrees(math.asin(max(-1.0, min(1.0, rotate_axis(q, AXIS_VECTORS[axis])['y']))))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ws', default='ws://localhost:8001')
    ap.add_argument('--seconds', type=float, default=20.0)
    ap.add_argument('--name', default=None, help='rigid body name (default: the only one streaming)')
    ap.add_argument('--axis', default='+z')
    ap.add_argument('--offset', type=float, default=0.0)
    ap.add_argument('--gap-ms', type=float, default=250.0,
                    help='a tracking gap longer than this starts a new run')
    args = ap.parse_args()

    print(f"Connecting to {args.ws} ... recording {args.seconds:.0f}s", file=sys.stderr)
    samples = []          # (t, name, tracking, heading, tilt)
    with ws_connect(args.ws) as ws:
        t0 = None
        deadline = time.monotonic() + args.seconds
        while time.monotonic() < deadline:
            try:
                raw = ws.recv(timeout=min(1.0, max(0.01, deadline - time.monotonic())))
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
            t0 = now if t0 is None else t0
            for rb in msg.get('rigidBodies', []):
                if args.name and rb.get('name') != args.name:
                    continue
                samples.append((now - t0, rb['name'], bool(rb.get('tracking')),
                                heading_deg(rb['quat'], args.axis, args.offset),
                                tilt_deg(rb['quat'], args.axis)))

    if not samples:
        print("No frames captured.", file=sys.stderr)
        return 1

    for name in sorted({s[1] for s in samples}):
        rows = [s for s in samples if s[1] == name]
        tracked = [s for s in rows if s[2]]
        print(f"\n=== {name}: {len(rows)} frames over {rows[-1][0]:.1f}s "
              f"({len(rows) - len(tracked)} untracked) | axis {args.axis}, offset {args.offset:+g} ===")
        if not tracked:
            print("  never tracked")
            continue

        # Split into runs of unbroken tracking -- a dropout is what a
        # lift-and-replace produces, and is where a state change can happen.
        runs, cur, prev_t = [], [], None
        for t, _, _, h, tl in tracked:
            if prev_t is not None and (t - prev_t) * 1000 > args.gap_ms:
                runs.append(cur); cur = []
            cur.append((t, h, tl)); prev_t = t
        if cur:
            runs.append(cur)

        print(f"  {len(runs)} continuously-tracked run(s):")
        for i, run in enumerate(runs, 1):
            hs = [h for _, h, _ in run]
            tls = [tl for _, _, tl in run]
            sd = statistics.pstdev(hs) if len(hs) > 1 else 0.0
            print(f"    run {i}: {len(run):5d} frames  {run[0][0]:5.1f}-{run[-1][0]:5.1f}s  "
                  f"heading mean {statistics.fmean(hs):+7.2f}  sd {sd:5.2f}  "
                  f"min {min(hs):+7.2f}  max {max(hs):+7.2f}  | tilt mean {statistics.fmean(tls):+6.2f}")

        allh = [h for _, _, _, h, _ in tracked]
        print(f"  overall: mean {statistics.fmean(allh):+.2f}  "
              f"sd {statistics.pstdev(allh):.2f}  min {min(allh):+.2f}  max {max(allh):+.2f}  "
              f"span {max(allh) - min(allh):.2f}")

        jumps = [(tracked[i][0], tracked[i - 1][3], tracked[i][3])
                 for i in range(1, len(tracked))
                 if abs(tracked[i][3] - tracked[i - 1][3]) > 5.0]
        print(f"  frame-to-frame jumps >5 deg: {len(jumps)}")
        for t, a, b in jumps[:10]:
            print(f"    t={t:5.1f}s  {a:+7.2f} -> {b:+7.2f}  ({b - a:+.2f})")
        if len(jumps) > 10:
            print(f"    ... and {len(jumps) - 10} more")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
