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
`liveTrackingUi.js`).

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

- Positions (scenes) are shots within a setup. **Cameras carry over when a
  new position is added; props don't** — a camera is studio hardware present
  for every shot, props are dressed per shot. Copies keep the same camera id
  so live assignments survive a position switch.
- Setups are `.json` files in `--setups-dir`, shared by every device on the
  network. Filenames come from the setup name; identity is the `id` inside.
  **GitHub Sync is a manual backup of that folder**, not the primary store.
- Comments explain *why*, especially where something non-obvious was learned
  the hard way. Keep that when editing — most of the comments here exist
  because the alternative cost hours.

## Calibration

Position and height are verified against the real studio (see
`js/motive/motiveTransform.js`'s header).

**Live rotation/tilt: calibrated 2026-08-15** against the "Arrow" T-bar
reference tracker — `App.motiveCalibration.liveForwardAxis = '-z'`,
`liveRotationOffsetDeg = 0.5` (see that file's comments for the derivation).
This is a property of *that asset's* local frame as Motive assigned it at
creation time, not a general rule — a separately-created rigid body (e.g. a
production camera asset, if built independently of this reference tracker)
may need its own check.

**A single static reading can't calibrate `liveForwardAxis` — you need
motion.** `App.motiveCalibration.liveForwardAxis` says which of a rigid
body's local axes points the way it faces, which Motive assigns arbitrarily
per-asset at creation and can't be derived from a single frame. The trap:
checking "does tilt read ≈0° while level" only rules out the near-vertical
axis — it can't distinguish the true forward axis from the object's *other*
horizontal (side/roll) axis, since both read ~0° at rest, and
`liveRotationOffsetDeg` can make either one's static heading match a known
target by coincidence. Only rotating the object through the motion you care
about and watching which axis's tilt actually swings tells them apart
(rotating an axis about itself leaves that axis unchanged, so the wrong one
looks falsely stable even while genuinely moved). `motive_axis_calibrate.py`
(repo root) automates this: it connects straight to the WebSocket bridge,
records live frames while you move the tracker, and reports the tilt range
for all six axis candidates from one capture instead of re-testing each
through the Live Tracking panel's dropdown one at a time.
