#!/usr/bin/env python3
# Combined process for live Motive tracking: serves the app's static files
# (same static-site-with-no-backend the app has always been -- js/main.js
# etc are still loaded via plain <script> tags, no build step) AND bridges
# Motive's live NatNet stream to the browser.
#
# Why a bridge process at all: Motive only streams live tracking data via
# NatNet (its own UDP binary protocol) or VRPN, and browsers can't open raw
# UDP sockets -- so the app itself can never talk to Motive directly. This
# process speaks NatNet to Motive (via the `new-natnet-client` library --
# https://github.com/IgnaciodelaTorreArias/natnet-client -- so this doesn't
# reimplement the binary protocol) and re-broadcasts each frame's rigid body
# data (position + quaternion, the same fields the CSV export's
# Position/Rotation columns carry) to any connected browser over a
# WebSocket, as JSON. js/motive/liveConnection.js is the browser-side
# counterpart.
#
# Run: python3 server.py [--server-address <motive-pc-ip>] [--http-port 8000]
# [--ws-port 8001] -- see `python3 server.py --help` for the full list of
# NatNet connection options (multicast vs unicast, ports, etc -- all passed
# through from NatNetParams.argparse_group()). Defaults assume Motive is
# running on this same machine (127.0.0.1) with multicast streaming, which
# is Motive's default "Local Loopback" setup.
#
# A small control window (tkinter, bundled with Python -- no extra
# dependency) opens with Start/Stop Tracking buttons. Stopping fully
# disconnects from Motive, releasing this client's registration, while the
# HTTP and WebSocket servers keep running so the app stays loaded in the
# browser -- for parking the bridge while Motive sits in Edit mode rather
# than leaving it reconnecting into a void. --no-gui runs console-only
# (also the automatic fallback if the window can't open), --no-autostart
# begins parked.
import argparse
import json
import re
import sys
import threading
import time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

from websockets.sync.server import serve as ws_serve

# The package's __init__.py doesn't re-export anything, so these come
# straight from their actual submodules.
from new_natnet_client.Client import NatNetClient, NatNetParams
import new_natnet_client.NatNetTypes as NNT
import new_natnet_client.Unpackers as NNU

ROOT = Path(__file__).resolve().parent


def _patch_natnet_lenient_names():
    """new_natnet_client's model-definition parser decodes every name
    (marker sets, rigid bodies, ...) as STRICT UTF-8. Motive can send a
    marker SET name (confirmed 2026-08-15, not a rigid body name) containing
    bytes that aren't valid UTF-8 -- this crashed inside the client's
    background command task with UnicodeDecodeError, which aborted the
    ENTIRE descriptors parse. Silent from server.py's point of view:
    client.descriptors just stayed None forever after that, so rigid body
    NAMES (what refresh_names() actually needs) never resolved, and every
    rigid body fell back to displaying its bare numeric id in the UI
    instead of its real Motive name.

    The null-byte offset tracking that finds where each name ends is
    unaffected by bad bytes (partition(b"\0") doesn't care what's in the
    bytes) -- only the decode step needs to tolerate this, so patching
    unpack_marker_set_description with errors="replace" (rather than the
    library's strict default) fixes it without touching any offset math.
    Only DataUnpackerV3_0 defines this method (DataUnpackerV4_1 inherits it
    unmodified), so patching the one class covers both NatNet versions.

    Done here at runtime rather than editing the installed package so it
    survives a fresh `pip install -r requirements.txt`.
    """
    from collections import deque

    @classmethod
    def unpack_marker_set_description_lenient(cls, data):
        offset = 0
        name_bytes, _, _ = data[offset:].partition(b"\0")
        offset += len(name_bytes) + 1
        name = name_bytes.decode("utf-8", errors="replace")
        num_markers = int.from_bytes(
            data[offset:(offset := offset + 4)], byteorder="little", signed=True
        )
        markers_names = deque()
        for _ in range(num_markers):
            marker_name, _, _ = data[offset:].partition(b"\0")
            offset += len(marker_name) + 1
            markers_names.append(marker_name.decode("utf-8", errors="replace"))
        return {
            name: NNT.Marker_set_description(name, num_markers, tuple(markers_names))
        }, offset

    NNU.DataUnpackerV3_0.unpack_marker_set_description = unpack_marker_set_description_lenient


_patch_natnet_lenient_names()

# How often refresh_names() WOULD re-request Motive's rigid body
# descriptions (id -> name) if it were called -- see natnet_loop's own
# comment on why that call is currently disabled entirely.
DESCRIPTIONS_REFRESH_SEC = 5.0

# Stand-in for that disabled lookup: rigid body id -> name, so the browser
# sees "Camera Tracker" rather than "1". Worth doing beyond cosmetics --
# js/motive/motiveCalibration.js keys its calibration PROFILES by name, so
# with these set the right profile applies automatically instead of needing
# to be picked by hand per row.
#
# Motive assigns these ids in its Assets pane, and they only change if a
# rigid body is deleted and re-created (renaming doesn't). Override with
# --name-map when they do, e.g. --name-map "3=Camera Tracker,4=T-bar".
DEFAULT_NAME_MAP = {1: "Camera Tracker", 2: "Triangle", 6: "T-bar"}


def parse_name_map(text):
    """"1=Camera Tracker,6=T-bar" -> {1: "Camera Tracker", 6: "T-bar"}."""
    mapping = {}
    for entry in (text or "").split(","):
        entry = entry.strip()
        if not entry:
            continue
        key, sep, value = entry.partition("=")
        if not sep or not value.strip():
            raise argparse.ArgumentTypeError(
                f"expected id=name entries separated by commas, got {entry!r}")
        try:
            mapping[int(key.strip())] = value.strip()
        except ValueError:
            raise argparse.ArgumentTypeError(f"rigid body id must be a number, got {key.strip()!r}")
    return mapping

# A pause in the stream (Motive switched to Edit mode, say) is normal and is
# waited out without touching the connection. Past this much silence, assume
# the connection itself may be stale -- Motive can drop a client's
# registration rather than merely pausing -- and rebuild it.
STREAM_IDLE_RECONNECT_SEC = 10.0

# Backoff between connection attempts, and after a stream is torn down.
RECONNECT_DELAY_SEC = 3.0


def broadcast(ws_server, message):
    """Send to every connected browser.

    Deliberately NOT websockets.broadcast(): that helper only handles the
    asyncio API's connections. Handed the threading API's ServerConnection
    objects (what websockets.sync.server.serve produces) it silently skips
    every one -- logging "skipped broadcast: sending a fragmented message"
    at debug level and returning normally, so frames vanish with no error
    anywhere. Sending per-connection is the supported way for the sync API.
    """
    # Snapshot: the set mutates as browsers connect/disconnect, and a client
    # dropping mid-send is normal, not an error worth interrupting the
    # stream for.
    for connection in list(ws_server.connections):
        try:
            connection.send(message)
        except Exception:
            pass


def natnet_loop(client, ws_server, controller, units_to_mm, name_map=None):
    # Seeded from --name-map rather than from Motive, since the lookup that
    # would populate this is disabled -- see refresh_names below.
    name_by_id = dict(name_map or {})

    # DISABLED as of 2026-08-15 -- see the call sites below. Confirmed by
    # direct A/B test: with this called, NO frames EVER arrived (endless
    # "Connected to Motive" -> silence -> "no frames for 10s" -> reconnect,
    # looping forever); commenting out the calls (not this function --
    # nothing calls it right now) immediately fixed frame delivery, on a
    # clean install with only this process running (ruled out a second
    # stale server.py holding the data port). _patch_natnet_lenient_names()
    # above fixed one confirmed crash inside this same request/response path
    # (a marker SET name -- not a rigid body name -- containing bytes that
    # aren't valid UTF-8, which used to abort the whole descriptors parse),
    # but frames still didn't flow afterward, so something about sending
    # REQUEST_MODEL_DEF at all disrupts this Motive build (3.5.0.1 Beta 1 /
    # NatNet 4.5) -- root cause not fully understood, and not worth risking
    # working tracking to chase further. Rigid bodies fall back to their
    # bare numeric id (e.g. "1") as their "name" without this -- the Live
    # Tracking panel's "Set as Camera Tracker" button
    # (App.motiveCalibration.cameraTrackerName) exists specifically because
    # that name can't be trusted right now. Re-test carefully (on a
    # non-critical session) before ever re-enabling the calls below.
    def refresh_names():
        try:
            client.send_request(NNT.NAT_Messages.REQUEST_MODEL_DEF, "")
            time.sleep(0.2)
            descriptors = client.descriptors
            if descriptors and descriptors.rigid_body_description:
                name_by_id.clear()
                for rb_id, desc in descriptors.rigid_body_description.items():
                    name_by_id[rb_id] = desc.name
                print(f"[natnet] refreshed names: {name_by_id}", file=sys.stderr)
            else:
                print(f"[natnet] refresh_names got no rigid_body_description "
                      f"(descriptors={descriptors!r})", file=sys.stderr)
        except Exception as e:
            print(f"[natnet] couldn't refresh rigid body names: {e}", file=sys.stderr)

    def send_frame(mocap):
        rigid_bodies = [
            {
                "id": rb.identifier,
                "name": name_by_id.get(rb.identifier, str(rb.identifier)),
                "tracking": rb.tracking,
                # Converted to millimeters here (via units_to_mm, the
                # --units-to-mm flag) so the browser side can feed this straight
                # into js/motive/motiveTransform.js unchanged -- that's
                # calibrated against the CSV export pipeline, which is
                # always millimeters (js/motive/motiveCsv.js), but NatNet's
                # own wire units depend on Motive's unit setting and aren't
                # guaranteed to match.
                "pos": {"x": rb.pos.x * units_to_mm, "y": rb.pos.y * units_to_mm, "z": rb.pos.z * units_to_mm},
                "quat": {"x": rb.rot.x, "y": rb.rot.y, "z": rb.rot.z, "w": rb.rot.w},
            }
            for rb in mocap.rigid_body_data.rigid_bodies
        ]
        broadcast(ws_server, json.dumps({
            "type": "frame",
            "frameNumber": mocap.prefix_data.frame_number,
            "rigidBodies": rigid_bodies,
        }))

    # refresh_names()  -- disabled, see that function's comment above
    last_refresh = time.time()
    last_frame = time.time()
    streaming = True

    # client.MoCap() is a generator that ENDS as soon as no frame arrives
    # within its timeout -- which happens routinely, e.g. every time Motive
    # is switched from Live to Edit mode. Letting that end this function
    # would tear the NatNet client down for good (the caller shuts it down
    # on return), which is why a Live->Edit->Live round trip used to kill
    # tracking until server.py was restarted. So a gap must not escape this
    # loop: re-enter the generator and keep waiting. Only a prolonged
    # silence returns, letting the caller rebuild the connection in case
    # Motive dropped this client entirely rather than just pausing.
    while not controller.should_stop():
        for mocap in client.MoCap(timeout=1.0):
            if controller.should_stop():
                return
            last_frame = time.time()
            if not streaming:
                streaming = True
                print("[natnet] frames resumed", file=sys.stderr)
                broadcast(ws_server, json.dumps({"type": "status", "motiveStreaming": True}))
            if time.time() - last_refresh > DESCRIPTIONS_REFRESH_SEC:
                # refresh_names()  -- disabled, see that function's comment above
                last_refresh = time.time()
            send_frame(mocap)

        if controller.should_stop():
            return
        if streaming:
            streaming = False
            print("[natnet] frames stopped -- Motive not streaming (Edit mode?), still connected and waiting", file=sys.stderr)
            broadcast(ws_server, json.dumps({"type": "status", "motiveStreaming": False}))
        if time.time() - last_frame > STREAM_IDLE_RECONNECT_SEC:
            print(f"[natnet] no frames for {STREAM_IDLE_RECONNECT_SEC:.0f}s -- rebuilding the connection", file=sys.stderr)
            return


# NatNetClient.connect(timeout=...) doesn't reliably bound how long it can
# block: internally it first does an untimed wait for its own background
# thread's sockets to come up, and only *then* applies the timeout you pass
# to the actual server handshake. If that first wait stalls -- e.g. binding/
# joining on an interface that never gets a reply -- connect() hangs forever
# regardless of the timeout argument. Running it in its own DAEMON thread
# and giving up on *that* after a hard deadline is the only way to bound it
# from the outside -- deliberately not concurrent.futures.ThreadPoolExecutor
# here: its `with` block's shutdown(wait=True) blocks until the submitted
# task finishes, which defeats the entire point when that task is the one
# that's stuck. A daemon thread we simply stop waiting on (and never join
# again) can't block this function, the rest of the app, or process exit --
# it just leaks harmlessly as a stuck background thread if connect() really
# never returns.
CONNECT_HARD_TIMEOUT_SEC = 15.0


def connect_with_hard_timeout(client, soft_timeout):
    result = {}

    def worker():
        try:
            result['connected'] = client.connect(soft_timeout)
        except Exception as e:
            # Runs in a background thread -- an uncaught exception here
            # would normally still print via threading.excepthook, but
            # catch explicitly so it's unmistakably tagged as coming from
            # here rather than blending into other output.
            result['exception'] = e

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    deadline = time.time() + soft_timeout + CONNECT_HARD_TIMEOUT_SEC
    poll_count = 0
    while t.is_alive() and time.time() < deadline:
        t.join(timeout=5.0)
        if t.is_alive():
            poll_count += 1
            print(f"[natnet] still attempting to connect... ({poll_count * 5}s elapsed)", file=sys.stderr)
    if 'exception' in result:
        print(f"[natnet] connect() raised: {result['exception']!r}", file=sys.stderr)
        return False
    if t.is_alive():
        print(
            f"[natnet] connect() didn't respond within {soft_timeout + CONNECT_HARD_TIMEOUT_SEC:.0f}s -- "
            "it's stuck rather than just refused (a plain refusal fails almost instantly). Try switching "
            "Motive's Streaming pane Transmission Type between Multicast/Unicast, and/or set both sides' "
            "Local Interface to the machine's real LAN IP instead of loopback. The stuck connection attempt "
            "keeps running in the background (harmless, but won't recover on its own); Live mode just won't "
            "have anything until you fix the Motive-side setting and restart this script.",
            file=sys.stderr,
        )
        return False
    return result.get('connected', False)


class TrackingController:
    """Owns the Motive connection, and whether it should exist at all.

    Tracking can be switched off without stopping the process: the NatNet
    client is fully torn down (releasing this client's registration with
    Motive) while the HTTP and WebSocket servers keep running, so the app
    stays loaded in the browser. That's the point of the Start/Stop buttons
    -- parking the bridge while Motive sits in Edit mode for a while,
    instead of leaving it reconnecting into a void.
    """

    def __init__(self, natnet_params, ws_server, units_to_mm, name_map=None):
        self.natnet_params = natnet_params
        self.ws_server = ws_server
        self.units_to_mm = units_to_mm
        self.name_map = name_map or {}
        self._shutdown = threading.Event()   # process is exiting
        self._tracking = threading.Event()   # tracking is meant to be running
        self._status = "stopped"
        self._status_lock = threading.Lock()

    # --- state, readable from the GUI thread ---
    @property
    def status(self):
        with self._status_lock:
            return self._status

    def _set_status(self, status):
        with self._status_lock:
            self._status = status

    def is_tracking(self): return self._tracking.is_set()

    def should_stop(self):
        """True when the streaming loop must unwind -- either the process is
        exiting or tracking has been switched off."""
        return self._shutdown.is_set() or not self._tracking.is_set()

    # --- controls ---
    def start(self):
        if self._tracking.is_set():
            return
        print("[natnet] tracking started", file=sys.stderr)
        self._tracking.set()

    def stop(self):
        if not self._tracking.is_set():
            return
        print("[natnet] tracking stopped -- disconnecting from Motive, servers still running", file=sys.stderr)
        self._tracking.clear()
        self._set_status("stopped")

    def shutdown(self):
        self._shutdown.set()
        self._tracking.set()  # unblock the idle wait below so the thread can exit

    def wait_for_shutdown(self):
        """Blocks until shutdown() is called -- for keeping the main thread
        alive when there's no GUI to occupy it."""
        self._shutdown.wait()

    def run(self):
        """Connect/stream/retry for as long as tracking is enabled.

        Deliberately a retry loop rather than a single attempt: Motive going
        away (Edit mode, a restart, a dropped client registration) must not
        permanently kill live tracking -- that used to require restarting
        this whole script.
        """
        params = self.natnet_params
        while not self._shutdown.is_set():
            # Parked: wait here until Start is pressed. No sockets held, no
            # reconnect attempts, nothing for Motive to see.
            if not self._tracking.is_set():
                self._set_status("stopped")
                self._tracking.wait(timeout=0.25)
                continue

            self._set_status("connecting")
            print(
                f"[natnet] attempting to connect to Motive at {params.server_address}:"
                f"{params.command_port} (multicast={params.use_multicast}, "
                f"local_interface={params.local_ip_address})...",
                file=sys.stderr,
            )
            client = NatNetClient(params)
            connected = connect_with_hard_timeout(client, params.connection_timeout or 5.0)

            if connected:
                self._set_status("streaming")
                print(f"Connected to Motive at {params.server_address} (units_to_mm={self.units_to_mm})")
                broadcast(self.ws_server, json.dumps({"type": "status", "motiveStreaming": True}))
                try:
                    natnet_loop(client, self.ws_server, self, self.units_to_mm, self.name_map)
                finally:
                    # Already-disconnected clients raise here; nothing to
                    # salvage either way, and this must not stop the loop.
                    try:
                        client.shutdown()
                    except Exception:
                        pass
            else:
                self._set_status("no-motive")
                print(
                    f"Could not connect to Motive at {params.server_address}:{params.data_port} "
                    "-- the app still loads, but Live mode has nothing to show. Check Motive is running with "
                    "streaming enabled, and that --server-address/--use-multicast match its Streaming settings. "
                    f"Retrying every {RECONNECT_DELAY_SEC:.0f}s.",
                    file=sys.stderr,
                )

            broadcast(self.ws_server, json.dumps({"type": "status", "motiveStreaming": False}))
            if self._shutdown.wait(RECONNECT_DELAY_SEC):
                return


STATUS_TEXT = {
    "stopped":    ("Tracking stopped", "#888888"),
    "connecting": ("Connecting to Motive...", "#c08a2e"),
    "streaming":  ("Tracking - connected to Motive", "#2e8b3d"),
    "no-motive":  ("Motive not reachable - retrying", "#b03030"),
}


def run_gui(controller, http_port):
    """Small always-available control window (tkinter ships with Python, so
    this adds no dependency). Must own the main thread -- Tk is not
    thread-safe and misbehaves when driven from a worker."""
    import tkinter as tk

    root = tk.Tk()
    root.title("Motive Live Bridge")
    root.resizable(False, False)

    frame = tk.Frame(root, padx=16, pady=14)
    frame.pack()

    tk.Label(frame, text="Studio Layout Tool - Live Motive Bridge",
             font=("Segoe UI", 11, "bold")).pack(anchor="w")
    tk.Label(frame, text=f"App: http://localhost:{http_port}/",
             font=("Segoe UI", 9), fg="#555555").pack(anchor="w", pady=(2, 10))

    status_label = tk.Label(frame, text="", font=("Segoe UI", 10, "bold"))
    status_label.pack(anchor="w", pady=(0, 12))

    buttons = tk.Frame(frame)
    buttons.pack(anchor="w")
    start_btn = tk.Button(buttons, text="Start Tracking", width=14, command=controller.start)
    start_btn.pack(side="left", padx=(0, 8))
    stop_btn = tk.Button(buttons, text="Stop Tracking", width=14, command=controller.stop)
    stop_btn.pack(side="left")

    tk.Label(frame, text="Stopping disconnects from Motive but keeps the app served,\n"
                         "so the browser stays loaded. Closing this window quits.",
             font=("Segoe UI", 8), fg="#777777", justify="left").pack(anchor="w", pady=(12, 0))

    def tick():
        text, colour = STATUS_TEXT.get(controller.status, (controller.status, "#555555"))
        status_label.config(text=text, fg=colour)
        tracking = controller.is_tracking()
        start_btn.config(state="disabled" if tracking else "normal")
        stop_btn.config(state="normal" if tracking else "disabled")
        root.after(250, tick)

    def on_close():
        controller.shutdown()
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)
    tick()
    root.mainloop()


def ws_handler(websocket):
    # No messages expected from the browser -- just keep the connection
    # open (and registered in ws_server.connections for broadcast()) until
    # it disconnects.
    for _ in websocket:
        pass


# --- Setup storage -----------------------------------------------------
#
# Setups live as plain .json files in a folder on this machine (--setups-dir),
# served over a small API rather than kept in the browser's local storage.
# That way every device on the LAN opens the same set of setups, and they're
# ordinary files that can be backed up or synced. Filenames are derived from
# the setup's name so the folder is browsable, but identity is the setup's
# own id inside the file -- renaming a setup moves its file rather than
# leaving a duplicate behind.
SETUPS_DIR = None

# Ids come from the client, so they're never trusted into a path. Only this
# shape is accepted, and filenames are always built server-side.
SAFE_ID = re.compile(r'^[A-Za-z0-9_-]{1,128}$')


def setup_filename(setup):
    cleaned = re.sub(r'[^A-Za-z0-9 _()-]+', '_', setup.get('name') or '').strip()
    return f"{(cleaned or 'setup')[:80]}.json"


def read_setup_file(path):
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return None
    return data if isinstance(data, dict) and data.get('id') else None


def list_setups():
    entries = []
    for path in SETUPS_DIR.glob('*.json'):
        data = read_setup_file(path)
        if not data:
            continue  # not one of ours (or unreadable) -- leave it alone
        entries.append({
            'id': data['id'],
            'name': data.get('name') or path.stem,
            'updatedAt': data.get('updatedAt'),
            'sceneCount': len(data.get('scenes') or []),
            'file': path.name,
        })
    entries.sort(key=lambda e: e.get('updatedAt') or '', reverse=True)
    return entries


def find_setup_path(setup_id):
    for path in SETUPS_DIR.glob('*.json'):
        data = read_setup_file(path)
        if data and data['id'] == setup_id:
            return path
    return None


def write_setup(setup):
    existing = find_setup_path(setup['id'])
    target = SETUPS_DIR / setup_filename(setup)
    # A rename should move the file, not leave the old one behind as a
    # duplicate of the same setup.
    if existing and existing != target:
        try:
            existing.unlink()
        except OSError:
            pass
    # Another setup may already own that filename -- keep both by
    # disambiguating rather than silently overwriting someone else's file.
    if target.exists():
        other = read_setup_file(target)
        if other and other['id'] != setup['id']:
            target = SETUPS_DIR / f"{target.stem} ({setup['id'][-6:]}).json"
    # Write via a temp file so an interrupted save can't truncate a good one.
    tmp = target.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(setup, indent=2), encoding='utf-8')
    tmp.replace(target)
    return target


class QuietStaticHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format, *args):
        pass  # the NatNet bridge already prints its own status lines

    # --- tiny JSON helpers ---
    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, message):
        self._send_json({'error': message}, status)

    def _read_json_body(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0:
            return None
        return json.loads(self.rfile.read(length).decode('utf-8'))

    def _api_id(self):
        """The <id> in /api/setups/<id>, or None for the collection itself."""
        rest = self.path[len('/api/setups'):].split('?', 1)[0]
        return rest.lstrip('/') or None

    def do_GET(self):
        if not self.path.split('?', 1)[0].startswith('/api/setups'):
            return super().do_GET()
        setup_id = self._api_id()
        if setup_id is None:
            return self._send_json(list_setups())
        if not SAFE_ID.match(setup_id):
            return self._error(400, 'Bad setup id')
        path = find_setup_path(setup_id)
        if not path:
            return self._error(404, 'No such setup')
        return self._send_json(read_setup_file(path))

    def do_PUT(self):
        if not self.path.split('?', 1)[0].startswith('/api/setups'):
            return self._error(404, 'Not found')
        setup_id = self._api_id()
        if not setup_id or not SAFE_ID.match(setup_id):
            return self._error(400, 'Bad setup id')
        try:
            setup = self._read_json_body()
        except Exception as e:
            return self._error(400, f'Body is not valid JSON: {e}')
        if not isinstance(setup, dict) or setup.get('id') != setup_id:
            return self._error(400, "Body must be a setup whose id matches the URL")
        try:
            path = write_setup(setup)
        except OSError as e:
            return self._error(500, f'Could not write the setup: {e}')
        return self._send_json({'ok': True, 'file': path.name})

    def do_DELETE(self):
        if not self.path.split('?', 1)[0].startswith('/api/setups'):
            return self._error(404, 'Not found')
        setup_id = self._api_id()
        if not setup_id or not SAFE_ID.match(setup_id):
            return self._error(400, 'Bad setup id')
        path = find_setup_path(setup_id)
        if not path:
            return self._error(404, 'No such setup')
        try:
            path.unlink()
        except OSError as e:
            return self._error(500, f'Could not delete the setup: {e}')
        return self._send_json({'ok': True})


def main():
    parser = argparse.ArgumentParser(
        description="Studio Layout Tool -- static file server + live Motive (NatNet) bridge"
    )
    parser.add_argument("--host", default="0.0.0.0", help="Bind address for both servers (default: %(default)s)")
    parser.add_argument("--http-port", type=int, default=8000, help="Static file server port (default: %(default)s)")
    parser.add_argument("--ws-port", type=int, default=8001, help="Live tracking WebSocket port (default: %(default)s)")
    # Deliberately a flag rather than client.UnitesToMillimeters(): that
    # library method sends a misspelled command ("UnitesToMillimeters"; the
    # real NatNet command is "UnitsToMillimeters"), so Motive answers
    # UNRECOGNIZED_REQUEST, its `while self._server_response is None:` loop
    # never exits, and the caller hangs forever with no timeout and no
    # exception. Confirmed against Motive 3.5.0.1 / NatNet 4.5 -- this was
    # the cause of the silent hang that made Live mode look dead.
    parser.add_argument(
        "--setups-dir", default=str(ROOT / "setups"),
        help="Folder to keep saved setups in, as plain .json files (default: %(default)s). "
             "Every device on the network shares this one folder, so it's also the thing "
             "to back up. Created if it doesn't exist.",
    )
    parser.add_argument(
        "--no-gui", action="store_true",
        help="Don't open the Start/Stop control window; run console-only (also the automatic "
             "fallback if the window can't be opened).",
    )
    parser.add_argument(
        "--no-autostart", action="store_true",
        help="Start with tracking stopped, waiting for Start Tracking to be pressed. "
             "By default tracking begins immediately.",
    )
    parser.add_argument(
        "--name-map", type=parse_name_map, default=None,
        help="Comma-separated rigid-body id=name pairs, e.g. \"1=Camera Tracker,6=T-bar\" "
             "(default: %s). Motive's own id->name lookup is disabled -- see natnet_loop -- so "
             "this is what gives rigid bodies real names instead of bare numbers, which also "
             "lets js/motive/motiveCalibration.js match its calibration profiles automatically. "
             "Only needs changing if a rigid body is deleted and re-created in Motive."
             % ",".join(f"{k}={v}" for k, v in DEFAULT_NAME_MAP.items()),
    )
    parser.add_argument(
        "--units-to-mm", type=float, default=1000.0,
        help="Multiplier converting streamed NatNet position units to millimeters, which is what "
             "js/motive/motiveTransform.js expects (default: %(default)s, i.e. NatNet's standard "
             "meters). Only change this if Motive is streaming in something other than meters.",
    )
    NatNetParams.argparse_group(parser)
    args = parser.parse_args()
    # Status/diagnostic lines matter even when output is redirected to a log
    # file -- stderr especially, since every connection diagnostic goes there
    # and a block-buffered stderr can withhold them indefinitely.
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
    # Not NatNetParams.from_parser(args) -- that classmethod reads
    # args.local_ip_address, but its own argparse_group() above defines the
    # flag as --local-address (dest local_address), so from_parser always
    # raises AttributeError. Build NatNetParams directly instead.
    natnet_params = NatNetParams(
        server_address=args.server_address,
        local_ip_address=args.local_address,
        use_multicast=args.use_multicast,
        multicast_address=args.multicast_address,
        command_port=args.command_port,
        data_port=args.data_port,
        max_buffer_size=args.max_buffer_size,
        connection_timeout=args.connection_timeout,
    )

    global SETUPS_DIR
    # `is None` rather than `or`: an explicit --name-map "" means "no names,
    # show raw ids", which shouldn't silently fall back to the defaults.
    name_map = DEFAULT_NAME_MAP if args.name_map is None else args.name_map
    print(f"Rigid body names      {name_map or '(none -- showing raw ids)'}")

    SETUPS_DIR = Path(args.setups_dir).expanduser().resolve()
    SETUPS_DIR.mkdir(parents=True, exist_ok=True)

    httpd = ThreadingHTTPServer((args.host, args.http_port), QuietStaticHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print(f"Serving app at         http://localhost:{args.http_port}/")
    print(f"Saving setups to       {SETUPS_DIR}")

    # The WS/HTTP servers come up immediately regardless of whether Motive
    # is reachable -- the Motive connection attempt (which can stall, see
    # connect_with_hard_timeout above) runs in its own background thread so
    # it can never block the app from loading or the bridge from accepting
    # browser connections.
    with ws_serve(ws_handler, args.host, args.ws_port) as ws_server:
        print(f"Live bridge WebSocket at ws://localhost:{args.ws_port}/")
        controller = TrackingController(natnet_params, ws_server, args.units_to_mm, name_map)
        threading.Thread(target=controller.run, daemon=True).start()
        if not args.no_autostart:
            controller.start()

        # Tk must own the main thread (it's not thread-safe), so the
        # WebSocket server always runs on a background one and the main
        # thread is left free for the GUI -- or, without it, just waits.
        threading.Thread(target=ws_server.serve_forever, daemon=True).start()
        try:
            if args.no_gui:
                controller.wait_for_shutdown()
            else:
                try:
                    run_gui(controller, args.http_port)
                except Exception as e:
                    # No display, no Tk build, etc. The bridge itself is
                    # fine, so carry on headless rather than dying.
                    print(f"Couldn't open the control window ({e}) -- running without it. "
                          "Pass --no-gui to skip trying.", file=sys.stderr)
                    controller.wait_for_shutdown()
        except KeyboardInterrupt:
            pass
        finally:
            controller.shutdown()


if __name__ == "__main__":
    main()
