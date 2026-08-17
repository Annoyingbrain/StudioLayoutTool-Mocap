# Studio Layout Tool — Mocap

A browser-based studio floor-plan tool for placing props and cameras, driven
live by OptiTrack Motive. A fork of "StudioLayoutTool" (the plain layout
tool) into a mocap-driven one. Vanilla JS, no build step, no framework —
plain `<script>` tags in `index.html`, plus one small Python server.

## Running it

```
pip install -r requirements.txt
python server.py                      # add --setups-dir "D:\StudioSetups" to choose where setups live
```

Then open **`http://localhost:8000/`** — type the `http://` explicitly, or
Chrome auto-upgrades to HTTPS and fails against this plain-HTTP server.

`server.py` is one process doing three things: serving the static app,
bridging Motive's NatNet stream to a WebSocket, and storing setups as files.
A small Tk window offers Start/Stop Tracking so the bridge can be parked
while Motive sits in Edit mode (`--no-gui` for console-only, `--no-autostart`
to begin parked).

Motive side: Streaming pane → **NatNet enabled**, Transmission Type
**Multicast** (its default, and shared with any other NatNet client such as
Unreal — changing it affects them too). Only rigid bodies *ticked* in
Motive's Assets pane are streamed.

**After changing JS/HTML, hard-refresh the browser (Ctrl+Shift+R).** A plain
reload keeps the cached scripts and has already caused one "this feature is
broken" report that was purely stale cache.

## How it fits together

```
Motive ──NatNet/UDP──> server.py ──WebSocket JSON──> browser
                          │
                          └── setups/*.json  (GET/PUT/DELETE /api/setups)
```

- `js/motive/motiveTransform.js` — Motive mm → app-world metres. **The
  calibration constants encode real physical measurements**; see its header
  and `fixtures/verify_reference_trackers.py` for the derivation before
  touching them.
- `js/motive/liveConnection.js` — WebSocket client, connection status only.
- `js/motive/liveTracking.js` — maps incoming rigid bodies to props/cameras
  and applies each frame.
- `js/motive/liveRecording.js` — records a camera's live path into its trail.
- `js/state.js` — the Store (setups → positions → props/cameras) + pub/sub.
- `js/ui/*.js` — panels; each subscribes to the Store and re-renders.

## Things that will bite you

**Frames arrive at 120 Hz.** `liveTracking` throttles writes into the Store
to ~30 Hz, but that's still 30 full re-renders a second. Never rebuild an
interactive element (a `<select>`, an `<input>`) on a Store emission — the
dropdown becomes physically unclickable because it's replaced mid-click.
Update in place, or gate the rebuild on a structure key (see
`liveTrackingUi.js`, and `sidebar.js`'s `propListStructureKey` /
`cameraListStructureKey` — both lists carry per-row tracker link buttons,
which would otherwise be unclickable precisely while tracking is live).

**Assignments don't live in the Store.** UI that reflects them must
subscribe to `App.liveTracking` as well, or it will render stale state
forever (this is what once left inspector fields disabled after unassigning).

**A live-driven entity owns its x/y/rotation.** Anything typed or dragged is
overwritten by the next frame, so those inputs are disabled while assigned
rather than silently ignoring edits.

**`new-natnet-client` has unguarded request/response helpers.** Several
(`UnitesToMillimeters`, `FrameRate`, …) wait on a reply with
`while self._server_response is None: sleep(0.001)` — no timeout, no
exception. `UnitesToMillimeters` also sends a *misspelled* command that
Motive rejects outright, so it hangs forever; `server.py` takes
`--units-to-mm` (default 1000, NatNet streams metres) instead of calling it.
Treat every one of those helpers as capable of hanging, and bound it in a
daemon thread (`natnet_diagnose.py`'s `query_with_timeout`).

**`client.MoCap()` ends whenever frames pause** (e.g. Motive → Edit mode),
which is not an error. `natnet_loop` re-enters it across gaps and only
rebuilds the connection after a prolonged silence.

**`websockets.broadcast()` silently ignores the sync API's connections.** It
only handles the asyncio API — given `websockets.sync.server` connections it
skips every one and returns normally, so frames vanish with no error. Send
per-connection instead.

**Canvas compositing is global.** `globalCompositeOperation = 'source-in'`
affects the whole canvas and is *not* scoped by `save()`/`restore()` — doing
it inline once erased an entire floor-plan export. Composite on a scratch
canvas.

## Debugging the Motive link

```
python natnet_diagnose.py            # add --use-multicast false if Motive is unicast
```

Standalone: no HTTP, no WebSocket, no wrapper threads. It turns on the
library's `NatNet` DEBUG logger (which `server.py` doesn't), so the last line
before a stall names the step that stalled, and on success it prints the
frame rate and live rigid body ids/positions. Reach for this before
theorising about the connection — every connection bug so far failed
*silently*, and this is what surfaced them.

## Conventions

- Positions (scenes) are shots within a setup. **The camera carries over when
  a new position is added; props don't** — a camera is studio hardware present
  for every shot, props are dressed per shot. Copies keep the same camera id
  so live assignments survive a position switch.
- **Props are measured by parking a tracker on them, one at a time.** Each
  prop row carries a button per tracker in
  `App.motiveCalibration.propTrackerNames` (T-bar for rectangular props,
  Triangle for circular/triangular). An assignment holds a single entity, so
  linking a tracker to the next prop releases the previous one — that *is*
  the measure-and-move-on workflow, not a bug to guard against. Both
  trackers can be parked on different props at once.
- **The studio runs one camera, and every scene always has exactly one.** It's
  created with the scene (at the studio floor centre) rather than placed by
  hand, so there's no "add camera" tool; `ensureCamera()` tops up any setup
  saved before that was true. The camera picker and Delete Camera are hidden
  while there's only one — both still appear for a setup carrying several, so
  older multi-camera setups stay editable rather than being silently
  truncated. `Store.getInspectedCamera()` is what the inspector edits: the
  single camera needs no selecting, several still do. Each camera row in the
  left panel also carries a **Link/Unlink** button driving that camera from
  the camera tracker — the same single assignment as Live Tracking's
  Link/Release camera button, so the two always agree; it's duplicated onto
  the row so linking doesn't mean scrolling past the Live Tracking panel.
- **Export Floor PNG writes to `Z:\App Generated PNG`, not to the browser's
  downloads** (`server.py --png-dir`). A page can't write to a drive path —
  only a download, or a save dialog steered by hand every time — so the PNG
  is POSTed to `/api/floor-png` and written by `server.py`, which can see the
  mapped drive. It therefore lands on the machine running `server.py`, not on
  the tablet that pressed the button; that's the point, since the shared
  drive is what Disguise reads. Re-exporting overwrites (the filename encodes
  setup + position, so it's the same plan redrawn). If the folder is
  unreachable the export falls back to a normal download and the toast says
  so — a missing drive mapping costs the shared folder, never the export.
- Setups are `.json` files in `--setups-dir`, shared by every device on the
  network. Filenames come from the setup name; identity is the `id` inside.
  **GitHub Sync is a manual backup of that folder**, not the primary store.
- Comments explain *why*, especially where something non-obvious was learned
  the hard way. Keep that when editing — most of the comments here exist
  because the alternative cost hours.

## Rotation convention

**`rotationDeg = 0` means facing the LED wall** (local -Y in a prop/camera's
own frame — see `js/utils/geometry.js`'s ROTATION CONVENTION note). Flipped
2026-08-15 from the original "local +Y = front" (which read ±180° when
manually pointed at the wall) to match how this studio's crew think about
heading. Every place that turns a direction into/from `rotationDeg` — prop
and camera drawing, the rotation-handle drag math, `csvExport.js`'s Disguise
`RotZ`, live tracking's heading — had to change together, or the same stored
number would mean different things depending which one touched it last. No
saved setups existed yet when this changed, so nothing needed migrating; if
that's no longer true, every stored `rotationDeg` needs +180 applied once.

## Calibration

Position and height are verified against the real studio (see
`js/motive/motiveTransform.js`'s header).

**Live rotation/tilt is calibrated per tracker, not globally.** Every Motive
asset gets its own arbitrary local frame at creation, so each needs its own
values — `App.motiveCalibration.PROFILES` holds the two derived so far:

| Tracker | Forward axis | Rotation offset | Height offset |
|---|---|---|---|
| Camera Tracker (3 markers: 1 forward, 2/3 right/left) | `+z` | `0°` | `+0.01m` |
| T-bar ("Arrow" reference tracker, rectangular props) | `-z` | `+0.5°` | `0` |
| Triangle (circular/triangular props) | *not yet derived* | | |

Camera Tracker and T-bar were confirmed live 2026-08-17. Triangle is named
but has no profile yet, so it falls to the uncalibrated `'+y'` default and
will look obviously broken (jittering heading, tilt pinned near ±90°) until
its axis is derived — that's the intended signal, not a fault.

This *was* one global set of fields,
which broke the moment a second tracker went live: Camera Tracker's
calibration got applied to T-bar's frames too, and the T-bar-driven prop
pointed the wrong way. If a tracker is ever deleted and recreated in Motive
(renaming is fine), its profile needs re-deriving.

**A tracked entity is positioned at Motive's rigid-body PIVOT, which is the
marker centroid — not the tracker's visual centre.** Measured from
`Reference trackers/T-bar.csv`: the pivot sits within 0.01mm of the centroid
of all five markers (Motive's default when a rigid body is built from a
marker selection), and therefore **11.4mm from the crossbar × stem
intersection** — 8.7mm of that in the floor plane, pulled toward the stem
marker, the rest downward because the stem lies on the floor while the
crossbar is 40mm up. One marker in five drags the centroid 40.5/5 ≈ 8mm
horizontally; the geometry accounts for it exactly. So line a tracker's
*centroid* up with what you want measured, not its visual centre. Under 1cm
and so ignorable for a floor plan — if it ever isn't, move the pivot in
Motive's rigid-body properties rather than adding an app-side fudge.

**Calibrate the rotation offset with the tracker mounted as it will be
used — never by setting it down by hand.** Measured 2026-08-17: once a body
is settled and locked, the solve is *excellent* — 2401 frames, zero
dropouts, heading sd **0.15°**, total span 0.8°. But six "aligned" hand
placements of the same tracker spanned **25°** (mean −3.0°, sd 10.4°). That
scatter is hand-placement precision, not a tracking fault, and it puts a
hard floor of about ±4° on any offset derived that way (standard error =
sd/√n). Mounted on the camera the tracker never moves relative to it, so the
offset becomes a genuine constant and heading tracks at the 0.15° figure.

Camera Tracker's `0°` comes from those six placements: the correct offset
works out at **+3.0° ± 4.2°**, statistically indistinguishable from 0, and
ruling out the earlier −9.6° at roughly 3 standard errors.

**Ignore readings taken while the body is being placed.** Re-acquisition
produces a second or two of genuine garbage — one capture showed 470
untracked frames and headings swinging to −76° before locking on. Wait for
the lock before reading anything.

Two dead ends recorded so they aren't re-walked. Both came from reading
structure into a handful of eyeballed numbers instead of measuring:

- **−9.6° was the midpoint of what looked like two clusters.** A midpoint is
  only right if the error is symmetric about truth; if one solve were
  correct and the other an artifact it would be the *worst* choice, wrong in
  both states. It was neither — there were no two states.
- **"Symmetric markers cause a bimodal heading flip"** — plausible (markers
  2/3 do mirror about the forward axis) and it fitted five samples, but a
  proper capture showed a single stable solve with ordinary placement
  scatter. n=5 by eye was never enough to claim bimodality.

```
python heading_stability.py --seconds 20        # add --name "1" for one body
```

is what settled it, and is the tool to reach for whenever a heading looks
wrong. It splits a live capture into continuously-tracked runs (a run ends
at a tracking dropout — i.e. exactly where a re-placement lands) and reports
per-run heading mean/sd, so within-run jitter, between-placement scatter,
and re-acquisition transients can't be mistaken for one another. Reading
those three off the on-screen number by eye is what produced both dead ends
above.

**Profiles match on name**, so with `--name-map` set (see *Rigid body names*)
the right one applies on its own. If a body arrives under some other name,
the Live Tracking row's *apply profile…* dropdown copies a profile's values
onto it and persists them; editing the row afterwards doesn't touch the
profile. An unrecognised tracker deliberately defaults to `'+y'` (Motive's
up axis) so it reads as *obviously uncalibrated* — jittering rotation, tilt
pinned near ±90° — rather than half-working.

## Rigid body names

**Names come from a hardcoded id→name map, not from Motive.**
`server.py --name-map` (default `1=Camera Tracker,2=Triangle,6=T-bar`) is what makes
rigid bodies arrive named rather than as bare ids like `"1"` — which also
lets the calibration profiles match automatically. Motive assigns those ids
in its Assets pane; they survive renaming but not delete-and-recreate, so
that's when the map needs updating.

It's a stand-in because `refresh_names()` is disabled — see its comment.
Sending `REQUEST_MODEL_DEF` reliably stopped *all* frames from arriving on
Motive 3.5.0.1 Beta 1 / NatNet 4.5 (confirmed by A/B test on a clean
single-process run). `_patch_natnet_lenient_names()` at the top of
`server.py` fixed one real crash in that path (a marker-set name containing
non-UTF-8 bytes aborted the whole descriptors parse), but frames still
didn't flow, so the request is left unsent and the root cause is unresolved.
Re-test on a non-critical session before re-enabling.

**A single static reading can't calibrate `liveForwardAxis` — you need
motion, and a recorded capture's "biggest range" can ALSO mislead you.**
A profile's `liveForwardAxis` says which of a rigid body's local axes points
the way it faces, which Motive assigns arbitrarily per-asset at creation and
can't be derived from a single frame. Two traps, both hit during Camera
Tracker's first (wrong) calibration pass:

1. Checking "does tilt read ≈0° while level" only rules out the
   near-vertical axis — it can't distinguish the true forward axis from the
   object's *other* horizontal (side/roll) axis, since both read ~0° at
   rest, and a rotation offset can make either one's static heading match a
   known target by coincidence.
2. Picking whichever axis shows the widest tilt range across a *recorded*
   capture isn't safe either, if the motion during that capture wasn't a
   clean, bounded pitch. A real hand-held motion that overshoots the
   natural ±90° range can make even the object's genuine UP axis trace a
   wide swing (it has a fixed, non-flat relationship to the true forward
   axis's own angle — see `motiveCalibration.js`'s "tent pattern" note —
   so a wide range doesn't by itself prove an axis is forward).

Both looked convincing enough from an automated capture (`'-y'`, wide
range, small resulting offset) to ship, and were still wrong — caught only
by live hands-on testing: flat and level, tilt was ~0 for `+x`/`-x`/`+z`/`-z`
but **-89.5° for `+y`**; pointed straight up, `+y`'s tilt fell back to ~0
(a "tent" — high at rest, low at the vertical extreme — the up axis's
signature, not forward's) while `+z`/`-z` climbed to ±78°. The reliable
procedure: (1) flat/level, tilt ~0 for candidates only rules out up; (2)
pitch the object as far as you physically can and compare candidates
directly *live* — true forward approaches ±90°, true side/roll stays
small. `motive_axis_calibrate.py` (repo root) can still help narrow
candidates from a capture (plain range/offset table, or `--gate-axis` once
a reliable up/down axis is known to correctly classify flat-vs-pitched
frames instead of each candidate circularly filtering itself) — but treat
its output as a lead, not a final answer, without a live check like the one
above.
