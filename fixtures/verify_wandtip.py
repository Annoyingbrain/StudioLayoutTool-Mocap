#!/usr/bin/env python3
"""One-off verification script: ports js/motive/motiveCsv.js's parser and
js/motive/wandTip.js's line-fit/tip-identification algorithm to Python and
runs it against samples/jj.csv, since no JS runtime is available in this
environment to run the real modules directly. Not part of the app -- purely
a sanity check that the JS logic (which mirrors this) behaves as designed."""
import csv, math, statistics, sys

def parse(path):
    with open(path, newline='') as f:
        rows = list(csv.reader(f))
    type_row, name_row = rows[2], rows[3]
    groups = []
    for col in range(2, len(type_row)):
        t, n = type_row[col], name_row[col]
        if groups and groups[-1]['type'] == t and groups[-1]['name'] == n and col == groups[-1]['start'] + groups[-1]['count']:
            groups[-1]['count'] += 1
        else:
            groups.append({'type': t, 'name': n, 'start': col, 'count': 1})
    marker_groups = [g for g in groups if g['type'] == 'Marker' and g['count'] == 3]
    print(f"Found {len(marker_groups)} raw Marker groups: {[g['name'] for g in marker_groups]}")

    frames = []
    for row in rows[8:]:
        if not row or not row[0]:
            continue
        try:
            frame = int(row[0])
        except ValueError:
            continue
        markers = []
        ok = True
        for g in marker_groups:
            try:
                x, y, z = float(row[g['start']]), float(row[g['start']+1]), float(row[g['start']+2])
            except (ValueError, IndexError):
                ok = False
                break
            markers.append((x, y, z))
        if not ok:
            continue
        frames.append(markers)
    return frames

def sub(a, b): return (a[0]-b[0], a[1]-b[1], a[2]-b[2])
def add(a, b): return (a[0]+b[0], a[1]+b[1], a[2]+b[2])
def scale(a, s): return (a[0]*s, a[1]*s, a[2]*s)
def dot(a, b): return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]
def length(a): return math.sqrt(dot(a, a))
def normalize(a):
    l = length(a) or 1e-9
    return scale(a, 1/l)
def centroid(pts):
    n = len(pts)
    return (sum(p[0] for p in pts)/n, sum(p[1] for p in pts)/n, sum(p[2] for p in pts)/n)

def fit_line_direction(pts):
    c = centroid(pts)
    centered = [sub(p, c) for p in pts]
    m = [[0.0]*3 for _ in range(3)]
    for p in centered:
        v = [p[0], p[1], p[2]]
        for i in range(3):
            for j in range(3):
                m[i][j] += v[i]*v[j]
    vec = (1.0, 1.0, 1.0)
    for _ in range(50):
        v = [vec[0], vec[1], vec[2]]
        nxt = [sum(m[i][j]*v[j] for j in range(3)) for i in range(3)]
        vec = normalize((nxt[0], nxt[1], nxt[2]))
    return c, vec

def collinearity_residual(pts):
    c, d = fit_line_direction(pts)
    total = 0.0
    for p in pts:
        v = sub(p, c)
        along = dot(v, d)
        perp = sub(v, scale(d, along))
        total += dot(perp, perp)
    return total

def identify(markers5):
    best = None
    for excluded in range(5):
        subset = [m for i, m in enumerate(markers5) if i != excluded]
        r = collinearity_residual(subset)
        if best is None or r < best[0]:
            best = (r, excluded, subset)
    _, excluded, subset = best
    return subset, markers5[excluded]

def endpoints(line_markers):
    c, d = fit_line_direction(line_markers)
    proj = sorted(line_markers, key=lambda p: dot(sub(p, c), d))
    return proj[0], proj[-1]

def compute_tip(markers5, tip_ext_mm):
    line_markers, orient = identify(markers5)
    near, far = endpoints(line_markers)
    d_near, d_far = length(sub(orient, near)), length(sub(orient, far))
    handle_end, tip_end = (near, far) if d_near <= d_far else (far, near)
    direction = normalize(sub(tip_end, handle_end))
    return add(tip_end, scale(direction, tip_ext_mm)), handle_end, tip_end

if __name__ == '__main__':
    frames = parse('jj.csv')
    print(f"Parsed {len(frames)} usable frames (of 250 total rows)")

    tips = [compute_tip(f, tip_ext_mm=0)[0] for f in frames]
    mean = centroid(tips)
    jitter = math.sqrt(sum(dot(sub(t, mean), sub(t, mean)) for t in tips) / len(tips))
    print(f"\nAveraged tip position across {len(tips)} frames (tipExtensionMm=0): "
          f"({mean[0]:.3f}, {mean[1]:.3f}, {mean[2]:.3f}) mm")
    print(f"Jitter (RMS deviation from mean): {jitter:.4f} mm")

    # Frame-0 spot check against the hand analysis done during planning.
    f0 = frames[0]
    line_markers, orient = identify(f0)
    near, far = endpoints(line_markers)
    _, handle_end, tip_end = compute_tip(f0, 0)
    print(f"\nFrame 0 spot check:")
    print(f"  orientation marker: {tuple(round(v,3) for v in orient)}")
    print(f"  line near-end:      {tuple(round(v,3) for v in near)}")
    print(f"  line far-end:       {tuple(round(v,3) for v in far)}")
    print(f"  -> handle end:      {tuple(round(v,3) for v in handle_end)}")
    print(f"  -> tip end:         {tuple(round(v,3) for v in tip_end)}")
    print(f"  dist(orient, near) = {length(sub(orient, near)):.2f} mm")
    print(f"  dist(orient, far)  = {length(sub(orient, far)):.2f} mm")

    # Consistency across the take: is the same physical marker chosen as the
    # tip end on every frame? (it should be, for a rigid wand tracked continuously)
    tip_end_choices = set()
    for f in frames:
        _, _, tip_end = compute_tip(f, 0)
        tip_end_choices.add(round(tip_end[0], 0))  # bucket by x to detect flips
    print(f"\nDistinct tip-end X buckets across all frames: {len(tip_end_choices)} "
          f"(should be 1 if the same physical marker was picked as tip-end every frame)")
