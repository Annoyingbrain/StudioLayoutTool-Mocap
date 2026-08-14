#!/usr/bin/env python3
"""One-off calibration script: derives js/motive/motiveTransform.js's
axisMap/sign/rotationDeg/translate constants from two reference-tracker
Motive captures placed at known physical locations on the studio floor (see
"Reference trackers/" and the plan notes for how these were measured):

  Triangle.csv -- 3-marker equilateral triangle (10cm sides, markers 1cm above
    floor). Its centroid sits exactly at the studio's physical floor center,
    which is also the js/studioSketch.js "Center" suggestedReferencePoint
    (app-space x=5.975, y=-8.818).

  T-bar.csv -- 5-marker "Arrow" rigid body: 4 markers in a line (4cm above
    floor, spaced 12.5/25/12.5cm) plus a 5th marker 3.5cm off-center, on the
    floor. The line runs along Disguise's +X axis with Motive's "Marker 001"
    at the +Disguise-X end; the 5th marker points away from the LED screen.

Disguise's axes relate to the app's internal axes via js/csvExport.js's
DISGUISE_ORIGIN (disguiseX = ORIGIN.x - appX, disguiseY = ORIGIN.y - appY --
offset + sign flip, no axis swap), and the screen wall sits at negative app-Y
(js/studioSketch.js's led_wall_curve/led_floor). axisMap/sign come from
T-bar's known-orientation marker line. rotationDeg + translate come from a
proper 2D rigid (rotation + translation) fit -- the same Procrustes math
js/rigidFit.js uses for prop positioning -- using T-bar's own two crossbar
endpoints (Marker001/Marker003) as correspondences, since a translation-only
origin can't capture a real small rotational offset between Motive's own
calibration and the mesh-derived floor plan (confirmed present here, ~0.49
degrees, by cross-checking against the studio floor edge's known-flat angle
at x=5.975 in studioSketch.js). Triangle's centroid, a fully independent
capture, is checked against the fit afterward as a sanity cross-check, not
used to derive it.

Ports js/motive/motiveCsv.js's column-group parser and js/motive/wandTip.js's
leave-one-out collinearity fit to Python (no JS runtime available here), the
same way fixtures/verify_wandtip.py does for the wand-tip algorithm.
"""
import csv, math
from pathlib import Path

REF_DIR = Path(__file__).resolve().parent.parent / "Reference trackers"
SCALE_TO_M = 0.001  # Motive export is millimeters


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
    # Raw Marker groups only (not idealized Rigid Body Marker, not Unlabeled
    # stray markers from other objects in the scene).
    marker_groups = [g for g in groups if g['type'] == 'Marker' and g['count'] == 3 and not g['name'].startswith('Unlabeled')]

    frames = []
    for row in rows[8:]:
        if not row or not row[0]:
            continue
        try:
            int(row[0])
        except ValueError:
            continue
        markers, ok = {}, True
        for g in marker_groups:
            try:
                x, y, z = float(row[g['start']]), float(row[g['start'] + 1]), float(row[g['start'] + 2])
            except (ValueError, IndexError):
                ok = False
                break
            markers[g['name']] = {'x': x, 'y': y, 'z': z}
        if ok:
            frames.append(markers)
    return frames, [g['name'] for g in marker_groups]


def sub(a, b): return {k: a[k] - b[k] for k in 'xyz'}
def add(a, b): return {k: a[k] + b[k] for k in 'xyz'}
def scale(a, s): return {k: a[k] * s for k in 'xyz'}
def dot(a, b): return sum(a[k] * b[k] for k in 'xyz')
def length(a): return math.sqrt(dot(a, a))
def dist(a, b): return length(sub(a, b))
def mean_point(pts):
    n = len(pts)
    return {k: sum(p[k] for p in pts) / n for k in 'xyz'}


def fit_line_direction(pts):
    c = mean_point(pts)
    centered = [sub(p, c) for p in pts]
    m = [[0.0] * 3 for _ in range(3)]
    for p in centered:
        v = [p['x'], p['y'], p['z']]
        for i in range(3):
            for j in range(3):
                m[i][j] += v[i] * v[j]
    vec = [1.0, 1.0, 1.0]
    for _ in range(50):
        nxt = [sum(m[i][j] * vec[j] for j in range(3)) for i in range(3)]
        l = math.sqrt(sum(x * x for x in nxt)) or 1e-9
        vec = [x / l for x in nxt]
    return c, {'x': vec[0], 'y': vec[1], 'z': vec[2]}


def collinearity_residual(pts):
    c, d = fit_line_direction(pts)
    total = 0.0
    for p in pts:
        v = sub(p, c)
        along = dot(v, d)
        perp = sub(v, scale(d, along))
        total += dot(perp, perp)
    return total


def identify_line_and_offset(labeled_points):
    """labeled_points: {label: {x,y,z}} with exactly 5 entries. Returns
    (line_labels[4], offset_label) via leave-one-out collinearity, mirroring
    wandTip.js's orientation-marker identification."""
    labels = list(labeled_points.keys())
    pts = [labeled_points[l] for l in labels]
    best = None
    for excluded in range(len(labels)):
        subset = [p for i, p in enumerate(pts) if i != excluded]
        r = collinearity_residual(subset)
        if best is None or r < best[0]:
            best = (r, excluded)
    _, excluded = best
    line_labels = [l for i, l in enumerate(labels) if i != excluded]
    return line_labels, labels[excluded]


def order_along_line(labeled_points, line_labels):
    pts = [labeled_points[l] for l in line_labels]
    c, d = fit_line_direction(pts)
    projected = sorted(zip(line_labels, pts), key=lambda lp: dot(sub(lp[1], c), d))
    return projected  # [(label, point), ...] sorted along the line


def avg_vector(vectors):
    return mean_point(vectors)


if __name__ == '__main__':
    # ---- Triangle.csv ----
    tri_frames, tri_labels = parse(REF_DIR / 'Triangle.csv')
    print(f"Triangle.csv: {len(tri_frames)} usable frames, markers: {tri_labels}")
    assert len(tri_labels) == 3, f"expected 3 raw markers, found {len(tri_labels)}"

    tri_centroids = [mean_point(list(f.values())) for f in tri_frames]
    tri_centroid_avg = mean_point(tri_centroids)
    tri_jitter = math.sqrt(sum(dist(c, tri_centroid_avg) ** 2 for c in tri_centroids) / len(tri_centroids))
    print(f"  centroid (avg over frames): ({tri_centroid_avg['x']:.3f}, {tri_centroid_avg['y']:.3f}, {tri_centroid_avg['z']:.3f}) mm, jitter {tri_jitter:.3f} mm")

    pair_dists = []
    for f in tri_frames:
        pts = list(f.values())
        pair_dists.append((dist(pts[0], pts[1]) + dist(pts[1], pts[2]) + dist(pts[0], pts[2])) / 3)
    print(f"  avg pairwise marker distance: {sum(pair_dists)/len(pair_dists):.2f} mm (expected ~100mm)")

    # ---- T-bar.csv ----
    tb_frames, tb_labels = parse(REF_DIR / 'T-bar.csv')
    print(f"\nT-bar.csv: {len(tb_frames)} usable frames, markers: {tb_labels}")
    assert len(tb_labels) == 5, f"expected 5 raw markers, found {len(tb_labels)}"

    offset_label_counts = {}
    line_order_counts = {}
    centers, v_marker001, v_offset, marker001_abs, marker003_abs = [], [], [], [], []
    for f in tb_frames:
        line_labels, offset_label = identify_line_and_offset(f)
        offset_label_counts[offset_label] = offset_label_counts.get(offset_label, 0) + 1
        ordered = order_along_line(f, line_labels)
        order_key = tuple(l for l, _ in ordered)
        line_order_counts[order_key] = line_order_counts.get(order_key, 0) + 1

        center = mean_point([p for _, p in ordered])
        centers.append(center)
        if 'Arrow:Marker 001' in f:
            v_marker001.append(sub(f['Arrow:Marker 001'], center))
            marker001_abs.append(f['Arrow:Marker 001'])
        if 'Arrow:Marker 003' in f:
            marker003_abs.append(f['Arrow:Marker 003'])
        v_offset.append(sub(f[offset_label], center))

    print(f"  offset-marker identification across frames: {offset_label_counts} (should be one label, 100%)")
    print(f"  line order across frames: {line_order_counts} (should be one consistent order, 100%)")

    ordered0 = order_along_line(tb_frames[0], identify_line_and_offset(tb_frames[0])[0])
    gaps = [dist(ordered0[i][1], ordered0[i + 1][1]) for i in range(3)]
    print(f"  frame-0 spacing along line: {[f'{g:.1f}mm' for g in gaps]} (expected ~[125, 250, 125])")

    center_avg = mean_point(centers)
    marker001_avg = mean_point(marker001_abs)
    marker003_avg = mean_point(marker003_abs)
    v1_avg = avg_vector(v_marker001)
    v5_avg = avg_vector(v_offset)
    print(f"  T-bar line-center (avg over frames): ({center_avg['x']:.3f}, {center_avg['y']:.3f}, {center_avg['z']:.3f}) mm")
    print(f"  center->Marker001 (avg): ({v1_avg['x']:.3f}, {v1_avg['y']:.3f}, {v1_avg['z']:.3f}) mm")
    print(f"  center->offset marker (avg): ({v5_avg['x']:.3f}, {v5_avg['y']:.3f}, {v5_avg['z']:.3f}) mm")

    # ---- Derive axisMap / sign ----
    # appX axis: whichever of raw x/z dominates the Marker001 direction
    # (the known Disguise+X / -appX line). appY axis: the other one, checked
    # against the offset marker's (known away-from-screen / +appY) direction.
    axis_x = 'x' if abs(v1_avg['x']) > abs(v1_avg['z']) else 'z'
    axis_y = 'z' if axis_x == 'x' else 'x'

    comp_x = v1_avg[axis_x]      # Marker001 dir == -appX  => appX_component should be negative
    sign_x = -1 if comp_x > 0 else 1
    comp_y = v5_avg[axis_y]      # offset marker dir == +appY => appY_component should be positive
    sign_y = 1 if comp_y > 0 else -1

    print(f"\nDerived axisMap: {{ appX: '{axis_x}', appY: '{axis_y}' }}")
    print(f"Derived sign:    {{ appX: {sign_x}, appY: {sign_y} }}")

    # ---- Up-axis / floor-baseline sanity check ----
    up_axis = 'y'
    tri_up = tri_centroid_avg[up_axis]      # markers 1cm above floor
    tb_up = center_avg[up_axis]             # line markers 4cm above floor
    print(f"\nUp-axis ('{up_axis}') sanity check:")
    print(f"  Triangle (1cm elevation): {tri_up:.2f} mm -> floor baseline (minus 10mm): {tri_up - 10:.2f} mm")
    print(f"  T-bar    (4cm elevation): {tb_up:.2f} mm -> floor baseline (minus 40mm): {tb_up - 40:.2f} mm")
    print("  (these two floor-baseline figures should closely agree if 'y' really is the up-axis)")

    # ---- Solve rotation + translation jointly (2-point rigid fit) ----
    # Ground truth (2026-08-14): the studio floor edge nearest the wall is
    # EXACTLY flat (0.0 degrees) at x=5.975 in studioSketch.js -- confirmed by
    # inspecting the led_floor polygon directly, not assumed. The T-bar was
    # placed perpendicular/parallel to that known-flat edge, so a single
    # axis-aligned origin (translation only, as before) can't capture a small
    # real rotational offset between Motive's own calibration and the
    # mesh-derived floor plan -- two independent physical calibrations with no
    # reason to agree to sub-degree precision. Fixed here by solving rotation
    # + translation together via the exact same 2D Procrustes fit
    # js/rigidFit.js already uses for prop positioning, from T-bar's own two
    # crossbar endpoints (Marker001/Marker003 -- the largest-baseline, single
    # -capture, most precise measurement available, avoiding any cross
    # -capture registration noise a Triangle<->T-bar pairing would add):
    # Marker001 is the known +Disguise-X / -appX end, Marker003 the opposite
    # end, each 25cm from the floor "Center" point (js/studioSketch.js),
    # itself 4.5m out from the wall's "Center" reference. Triangle's centroid
    # (a fully independent capture) is checked against the fit afterward,
    # not used to derive it.
    app_center = {'x': 5.975, 'y': -8.818 + 4.5}
    app_marker001 = {'x': app_center['x'] - 0.25, 'y': app_center['y']}
    app_marker003 = {'x': app_center['x'] + 0.25, 'y': app_center['y']}

    def to_local(motive_point):
        return (sign_x * motive_point[axis_x] * SCALE_TO_M, sign_y * motive_point[axis_y] * SCALE_TO_M)

    def rotate(x, y, deg):
        a = math.radians(deg)
        c, s = math.cos(a), math.sin(a)
        return (x * c - y * s, x * s + y * c)

    def rigid_fit_2d(correspondences):
        n = len(correspondences)
        lc = (sum(c[0][0] for c in correspondences) / n, sum(c[0][1] for c in correspondences) / n)
        wc = (sum(c[1][0] for c in correspondences) / n, sum(c[1][1] for c in correspondences) / n)
        num = den = 0.0
        for local, world in correspondences:
            lx, ly = local[0] - lc[0], local[1] - lc[1]
            wx, wy = world[0] - wc[0], world[1] - wc[1]
            num += lx * wy - ly * wx
            den += lx * wx + ly * wy
        rotation_deg = math.degrees(math.atan2(num, den))
        rlc = rotate(lc[0], lc[1], rotation_deg)
        translate = (wc[0] - rlc[0], wc[1] - rlc[1])
        return translate, rotation_deg

    correspondences = [
        (to_local(marker001_avg), (app_marker001['x'], app_marker001['y'])),
        (to_local(marker003_avg), (app_marker003['x'], app_marker003['y'])),
    ]
    translate, rotation_deg = rigid_fit_2d(correspondences)

    def to_app_world(motive_point):
        lx, ly = to_local(motive_point)
        rx, ry = rotate(lx, ly, rotation_deg)
        return {'x': translate[0] + rx, 'y': translate[1] + ry}

    print(f"\nSolved rotation correction: {rotation_deg:.4f} deg")
    print(f"Solved translate (m): ({translate[0]:.4f}, {translate[1]:.4f})")

    m1_result = to_app_world(marker001_avg)
    m3_result = to_app_world(marker003_avg)
    tb_center_result = to_app_world(center_avg)
    tri_result = to_app_world(tri_centroid_avg)
    print(f"\nRound-trip checks:")
    print(f"  T-bar Marker001   -> ({m1_result['x']:.4f}, {m1_result['y']:.4f})  target ({app_marker001['x']:.4f}, {app_marker001['y']:.4f})")
    print(f"  T-bar Marker003   -> ({m3_result['x']:.4f}, {m3_result['y']:.4f})  target ({app_marker003['x']:.4f}, {app_marker003['y']:.4f})")
    print(f"  T-bar line-center -> ({tb_center_result['x']:.4f}, {tb_center_result['y']:.4f})  target ({app_center['x']:.4f}, {app_center['y']:.4f})")
    print(f"  Triangle centroid -> ({tri_result['x']:.4f}, {tri_result['y']:.4f})  target ({app_center['x']:.4f}, {app_center['y']:.4f})  (independent capture, not used in the fit)")

    print(f"\n=== Final calibrated motiveTransform.js values ===")
    print(f"axisMap: {{ appX: '{axis_x}', appY: '{axis_y}' }}")
    print(f"sign: {{ appX: {sign_x}, appY: {sign_y} }}")
    print(f"rotationDeg: {rotation_deg:.4f}")
    print(f"translate: {{ x: {translate[0]:.4f}, y: {translate[1]:.4f} }}")
