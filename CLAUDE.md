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

## Using it from another device

Both servers bind `--host` (`0.0.0.0` by default), so **any tablet or laptop
on the same network can just open `http://<this-machine's-IP>:8000/`** — no
extra flag, no proxy. The startup banner and the control window both print
that exact URL (`lan_addresses()`), because "localhost" is the one address
that cannot work from another device and having to go and look the IP up was
the entire obstacle. Link-local `169.254.x.x` addresses are filtered out —
this machine has three NICs that self-assign one, and none of them is
reachable from the house network.

Live Tracking works from those devices too: the browser derives the bridge
URL from whatever host it loaded the page from, so a tablet on the LAN URL
gets `ws://<same-IP>:8001` without anyone typing it. The `:8001` in that
default is hardcoded browser-side, so a non-default `--ws-port` has to be
typed into the Bridge URL field by hand.

What each device does *not* share:

- **Setups are shared** — they're files on the server, so every device sees
  the same list. But there's no locking or merge: saves are atomic (temp file
  + replace, so a file is never half-written), yet two devices editing the
  same setup means **the last one to save silently wins**. Work on different
  setups, or one device at a time.
- **Motive calibration and the GitHub token are per-browser** (localStorage),
  so they don't follow a device onto the network. The calibration *profiles*
  ship in the code and match on name, so a fresh tablet still tracks Camera
  Tracker and T-bar correctly — it's only day-to-day per-row tweaks that stay
  behind on the machine where they were typed.
- **Export Floor PNG always lands on the machine running `server.py`**, not
  on the tablet that pressed it — see the note under *Conventions*, that's
  the intended behaviour.

Windows Firewall is what blocks this when it doesn't work; it's currently
disabled on all three profiles on this machine, so nothing needed opening.

Motive side: Streaming pane → **NatNet enabled**, Transmission Type
**Multicast** (its default, and shared with any other NatNet client such as
Unreal — changing it affects them too). Only rigid bodies *ticked* in
Motive's Assets pane are streamed.

**After changing JS/HTML, hard-refresh the browser (Ctrl+Shift+R).** A plain
reload keeps the cached scripts and has already caused one "this feature is
broken" report that was purely stale cache.

## Tests

```
node --test "test/*.test.js"
```

**Node is needed only to run the tests — the app itself still has no build
step and no dependencies.** The quotes matter: unquoted, the shell expands the
glob; and `node --test test/` picks up `test/helpers/` as a test file too.

The app is browser code with no module system, which is exactly what makes
this work — every file hangs things off `window.App`, so giving a Node `vm`
context a `window` and running the files in `index.html`'s order builds the
whole app in-process. `test/helpers/appContext.js` does that, and hands back
either a recording canvas (for the floor PNG and the printed report) or a
small duck-typed DOM shim (for the sidebar), so a handler can be fired and the
result asserted.

These exist because browser automation isn't available on the studio machine,
so "does this actually work" was otherwise unanswerable without asking someone
to go and click. **They verify logic, not appearance** — layout, colour and
spacing still need a person looking at the page, after a hard refresh.

Three things in the harness are load-bearing, and all three were bugs first:

- **Every recorded drawing op carries a `ctxId`.** `floorPngExport.js`
  recolours the camera icon on a *scratch* canvas, so without the id its
  `drawImage` is indistinguishable from a real one and icon counts come out
  one high.
- **`Image` is stubbed to fire `onload` synchronously**, or the icon branch
  never runs and only the wedge fallback gets tested.
- **`appContext.js`'s file list mirrors `index.html`'s script order.** Adding
  a script there means adding it here, or a module loads before something it
  reads at definition time.
- **Comparing a drawn position across two renders is invalid unless the
  bounds held.** The report frames itself on its own content, so adding a
  camera to a scene rescales the whole view and every existing label moves —
  for reasons that have nothing to do with what was being tested. A test that
  compares positions between two scenes has to assert the bounds were
  unchanged, or it is comparing two different framings. The label-priority
  test does exactly that, and also asserts its fixture is still a genuine
  collision, so a geometry change fails it loudly instead of leaving it
  passing while testing nothing.
- **A stroke count is not a test that a line was drawn.** The report's wall
  and camera wedges stroke too, so `strokes.length > 0` passed even with the
  camera path deleted. The path is the only thing that sets a dash, so the
  recording context records `setLineDash` and the test asserts on that
  instead. Counted loosely, because the stub's `restore()` is a no-op and the
  dash leaks onto strokes drawn after it.
- **Restore a mutated file from a copy, not `git checkout`.** Mutation-testing
  a file with uncommitted work in it and reverting with `git checkout` throws
  that work away — it restores the committed version, not the pre-mutation
  one.

Worth knowing that the suite is checked against deliberate mutations: putting
the camera name back into `cameraListStructureKey`, or drawing the static icon
for a recorded camera, each fail the tests written for them.

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

- **A frame grab belongs to a CAMERA POSITION, not to a position.** One prop
  layout shot wide and then tight is two different reference pictures, so a
  single grab per position could only ever describe one of them. It lives at
  `camera.frameGrab`; the panel writes to `Store.getInspectedCamera()` and
  names that camera, because with several cameras and none picked there is
  nothing to write to and importing would otherwise land on whichever camera
  happened to be selected. It does **not** carry over to a new position, for
  the same reason `trail` doesn't — the picture is of a layout that is no
  longer in front of the camera. Setups saved when it hung off the scene are
  migrated on load (`Store`'s `migrateFrameGrab`, which runs after
  `ensureCamera` so there is always a camera to hand it to); the ancient
  pre-scenes migration in `persistence.js` still parks it on the scene and
  lets that one move it.
- **A panel hint long enough to bury its own controls folds into a
  `<details>`** (`.hint-details`), as Live Tracking's does — left open it
  pushed the rigid-body list, the part used during a shoot, off the bottom.
  Native `<details>`, not JS: the arrow, the toggle and the keyboard
  behaviour come free and it degrades to plain visible text.
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
- **A scene has at least one camera, and may have several camera positions.**
  The first is created with the scene (at the studio floor centre) rather than
  placed by hand, and `ensureCamera()` tops up any setup saved without one, so
  a scene is never camera-less. **One prop layout is often shot from several
  positions** — wide, then tight — so *+ Add Camera Position* adds more to the
  scene you're already in, each a full camera entity with its own placement,
  lens, notes and recorded move. Each carries a name (editable in the camera
  row, not just the Inspector) which is what labels it on the exported floor
  PNG and in the Disguise CSV, so the names are worth typing. New positions
  are offset a metre from the last rather than dropped on the studio centre —
  stacked exactly on an existing camera one is invisible and impossible to
  grab. The camera picker and Delete Camera are hidden while there's only one:
  deleting the last camera is a state the rest of the app doesn't accept.
  **The camera-row name field is why `cameraListStructureKey` deliberately
  omits the name** — keying on it would rebuild the list on every keystroke
  and destroy the field being typed into. `Store.getInspectedCamera()` is what the inspector edits: the
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
- **There are THREE renderers of the same scene, and they drift apart
  silently.** `js/canvas.js` draws the screen; `js/floorPngExport.js` redraws
  it for Disguise; `js/reportExport.js` redraws it again for print. Cameras
  were absent from the report entirely until someone printed one and looked —
  the same class of bug as recorded moves once missing from every exported
  PNG, and it went unnoticed longer because the report is reached for less
  often. They share no drawing code — different coordinate
  transforms (screen vs Disguise space), different palettes (colour vs white
  on black) — so anything added to one has to be added to the other by hand.
  A recorded camera move was drawn on screen but **silently missing from
  every exported PNG** for exactly this reason: the export had no reference
  to `trail` at all. Nothing errors when this happens; the feature simply
  isn't in the file. When adding anything the plan should show, do **all
  three**, and keep the layering identical (props → trail → trail endpoints →
  cameras). Each has headless coverage (`test/floorPngExport.test.js`,
  `test/reportExport.test.js`), and both suites are mutation-checked — drop
  the path, the caption or the Start marker from either renderer and its
  tests fail.
  They are **not** required to show the same thing, though — see the next
  point. Where they legitimately differ: the PNG is white-on-black because
  that is what Disguise reads; the report is each entity's own colour on
  white. All three draw `camera.png` (each with its own `Image`, since none
  exposes its own) with the same wedge fallback while it loads — the PNG
  tints it flat white, the report tints it per camera, and that tint is
  cached per colour AND size because a report holds several camera positions
  in different colours at one scale. The report also draws a recorded path
  **dashed** — on white, beside solid prop outlines in the same palette, a
  solid stroke reads as another piece of set rather than a move.
  The report's drawing coordinates stay in a CSS-pixel space of at most
  1400×900 while `RENDER_SCALE` multiplies only the backing store, so the
  layout can print at the full page width without a single font size
  changing; it is capped (`MAX_PIXEL_SCALE`) because the result is embedded
  as a data URL and a retina `devicePixelRatio` would multiply on top of it.
- **Recording a camera move keeps only the MOVEMENT.** A camera standing
  still is not still in the data — the solve jitters, so consecutive frames
  differ in the last decimal place. The old test ("is this sample different at
  all?") was therefore true 30 times a second whether or not anything had
  moved, and a short nudge could spend all 400 of `TRAIL_MAX_POINTS` on a blob
  at each end with the real move drawn from the leftovers. `liveRecording.js`
  now samples only past `MOVED_EPSILON_M` (2cm) or `MOVED_EPSILON_DEG` (2°),
  both far above the noise floor (a settled body holds heading to sd 0.15°)
  and far below any move worth drawing. Three things about it:
  - **Measured from the last KEPT sample, not the last frame** — frame-to-frame
    lets a slow drift through a step at a time and rebuilds the blob.
  - **Rotation counts**, even though the trail stores only x/y: a camera
    panned in place has genuinely moved and `trailEndpoints` carries the
    heading at each end.
  - **A recording where nothing moved is a RESULT, not a failure.** The
    camera is somewhere, that position is tracked, and it is what belongs on
    the plan — so the recording is saved as a static camera position and any
    previous trail is **cleared**. Recording a parked camera is how you say
    "it sits here now"; keeping the old path would make that impossible to
    say, and would leave the plan showing a move the camera is no longer
    making. Distinct from a recording where tracking never delivered a frame
    at all, which writes nothing and says so — `outcomeOf` returns
    `'move' | 'static' | 'none'` for exactly this three-way split, and
    `applyOutcome` writes it.
  The thresholds are the whole behaviour, so `test/liveRecording.test.js`
  pins both ends of the range — too low and the jitter is back, too high and a
  real push-in is discarded — and is mutation-checked against both.
- **On the exported PNG, a camera with a recorded move is drawn as the move
  alone**: the path plus a Start and an End icon, with its static icon and
  red centre dot suppressed. Drawing both was misleading rather than merely
  redundant — after a recording the camera's stored position *is* wherever
  the move finished, so the static icon landed almost on top of the End one
  and read as a second camera at a fixed position that no longer means
  anything. The red dot goes with it: a camera that moved has no single point
  for Disguise to line up against. The name/lens caption is kept and
  re-anchored to the End icon, because with several camera positions per
  scene it's the only thing saying which path belongs to which camera.
  The on-screen canvas deliberately still draws the live camera on top of its
  trail — there the current position is live and moving, so it's the useful
  part. Suppression keys on the path *and* its endpoints, so a hand-edited
  setup missing endpoints degrades to the plain static icon rather than to an
  unlabelled line.
  Sizes in the export are given in *metres* scaled by `(scaleX+scaleY)/2`,
  not pixels — that canvas is ~245 px/m, so an on-screen 2px line comes out
  a hairline there.
- **The report's page is cropped to its content in BOTH directions**, rather
  than being a fixed 1400×900. The LED wall arc is far bigger than the area
  anyone actually dresses, so framing on the whole arc left the top ~40% of
  the picture as empty white inside the curve. The vertical extent is trimmed
  to the props and cameras plus a margin and **clamped to the wall** — the
  trim removes empty floor, it never invents space that isn't there — and the
  canvas is cropped to whatever the frame actually uses. Two things that are
  easy to get wrong here:
  - **The full WIDTH of the wall is always kept in the frame.** It is the
    studio; cropping it sideways loses props against it. That also caps how
    much bigger this can make the plan (~1.16×) — if a plan is wanted
    substantially bigger, cropping the wall is the only thing that does it,
    and that is a deliberate trade, not an oversight.
  - **Cropping only the height achieves nothing.** The image prints at the
    full width of the page, so letterboxing in *either* axis is page width
    spent on white. Trimming the height alone just moved the empty space to
    the sides and the plan came out no bigger; both axes have to follow the
    content.
- **The report places its labels in a pass of their own, after everything is
  drawn.** Two camera positions a metre apart put four labels — a name, a lens
  line, a Start and an End — in the same square inch, and drawn where each
  naturally falls they overprint into a stack nobody can read. So labels are
  *collected* while drawing and placed at the end, each nudged straight down a
  line at a time until it clears the ones already placed; where one can go
  depends on where the others went, which isn't known until every natural
  position is. Consequences worth keeping:
  - **Priority decides who moves**: props first (they anchor the plan), then
    camera names, then Start/End — an endpoint gives way because its icon
    already says most of what it says.
  - **A camera's name and lens line move as one block.** Split, a lens
    reading ends up under someone else's name, which is worse than an overlap
    because it looks correct.
  - The nudge is **capped**. Past a few lines the label is so far from its
    icon that it stops reading as that camera's label, and an overlap is the
    lesser problem.
  - Every label is **haloed** (white `strokeText` under the fill), so one that
    still lands on a path or an icon reads against it rather than merging in.
  - Labels drawing last also puts them on top of every icon and path.
- **The printed report leads with the cameras, then the props.** Lens and
  height are what a shot gets set up from and neither is readable off the
  drawing, so the Camera Positions table comes first and the props — the
  dressing that goes around it — sit under it. A camera that moved has no
  single position, so its row reports the end of the move and the point count
  instead.
- **A camera position can be hidden, and that is a CANVAS-ONLY setting.**
  Several camera positions in one prop layout overlap into an unreadable
  pile, so each row in the Cameras list carries Hide/Show (`camera.hidden`,
  persisted with the setup; absent reads as visible, so nothing needed
  migrating). `js/canvas.js` draws and hit-tests `Store.getVisibleCameras()`;
  **every export — floor PNG, Disguise CSV, report — goes through
  `getCameras()` and draws all of them.** That asymmetry is the whole reason
  hiding is safe to offer: it declutters the screen without ever dropping a
  camera from the plan the crew shoots from, and an exported PNG gives no
  hint that a camera was omitted. `test/floorPngExport.test.js` pins it, and
  the test is mutation-checked — making the export respect `hidden` fails it.
  A hidden camera keeps its row, stays editable in the Inspector and stays
  assignable to a tracker; it just isn't drawn and can't be grabbed on the
  canvas (hit-testing walks the same visible list, or it would be an
  invisible thing catching clicks). *Show All Cameras* appears under the list
  only while something is hidden. **Hiding is stored in the shared setup
  file**, so it follows the setup onto every device — decluttering on the
  tablet also declutters the desktop.
- **The header carries only what a shoot day reaches for**, and everything
  else is behind its *More* menu. In the header: *+ Add Prop*, *+ Add Camera
  Position*, then New, Save, Load setup, Export Floor PNG (Disguise), then
  the px/m zoom field. In the menu: Show grid, Show studio sketch, Export
  CSV, Report / Print, Export/Import .json. Zoom is in the header rather than
  the menu because it gets nudged repeatedly while framing a layout, which a
  menu that must be reopened each time works against. On a tablet the header is the only thing between the
  crew and the canvas, so length there is the constraint being managed —
  adding a button means deciding it belongs in that set. Nothing is ever
  *removed* to make room and no ids change, so `toolbar.js` and `sidebar.js`
  bind every handler exactly as before: **moving a control between the
  header, the menu and a panel is a markup change alone.** Two things that
  aren't free-floating, though:
  - The two `.panel-toggle` buttons stay out of the menu: they only exist
    below 900px, where they're how you reach the side panels at all.
  - **The menu closes on a `<button>` and nothing else.** The view toggles
    are checkboxes flicked on and off to compare, and Import .json is a
    `<label>` over a file input — closing there would pull the menu out from
    under the file dialog.
- **A header button acting on a left-panel row has to open the drawer.**
  *+ Add Camera Position* is in the header but its row, and the name field it
  focuses, are in the left panel — which below 900px is a shut drawer. So it
  calls `App.toolbar.revealLeftPanel()`; without it the press looks like it
  did nothing and the shot name gets typed into a field nobody can see.
  Above 900px there is no drawer and the `open` class means nothing, so that
  call is a no-op rather than something to branch on.
- Setups are `.json` files in `--setups-dir`, shared by every device on the
  network. Filenames come from the setup name; identity is the `id` inside.
  **GitHub Sync is a manual backup of that folder**, not the primary store.
  It backs up the *whole folder*, not the open setup: a shoot day touches
  several setups and only one of them is open when the button is pressed, so
  pushing just that one quietly left the rest un-backed-up. What's already up
  there is read from `setups/index.json`'s per-setup `updatedAt` versus the
  local one (`Store.touch()` bumps it on every edit), so unchanged setups are
  skipped and the button is cheap to press repeatedly. A missing timestamp on
  either side counts as "needs pushing" — a wasted upload costs seconds, a
  wrong skip costs a day's work. One setup failing to upload doesn't abort
  the ones queued behind it; the status line names the casualties.
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
