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

ROOT = Path(__file__).resolve().parent

# How often to re-request Motive's rigid body descriptions (id -> name), so
# a rigid body created/renamed in Motive after the bridge started still gets
# picked up. Cheap request, no need to do it every frame.
DESCRIPTIONS_REFRESH_SEC = 5.0

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


def natnet_loop(client, ws_server, controller, units_to_mm):
    name_by_id = {}

    def refresh_names():
        try:
            client.send_request(NNT.NAT_Messages.REQUEST_MODEL_DEF, "")
            time.sleep(0.2)
            descriptors = client.descriptors
            if descriptors and descriptors.rigid_body_description:
                name_by_id.clear()
                for rb_id, desc in descriptors.rigid_body_description.items():
                    name_by_id[rb_id] = desc.name
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

    refresh_names()
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
                refresh_names()
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

    def __init__(self, natnet_params, ws_server, units_to_mm):
        self.natnet_params = natnet_params
        self.ws_server = ws_server
        self.units_to_mm = units_to_mm
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
                    natnet_loop(client, self.ws_server, self, self.units_to_mm)
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


class QuietStaticHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format, *args):
        pass  # the NatNet bridge already prints its own status lines


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

    httpd = ThreadingHTTPServer((args.host, args.http_port), QuietStaticHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print(f"Serving app at         http://localhost:{args.http_port}/")

    # The WS/HTTP servers come up immediately regardless of whether Motive
    # is reachable -- the Motive connection attempt (which can stall, see
    # connect_with_hard_timeout above) runs in its own background thread so
    # it can never block the app from loading or the bridge from accepting
    # browser connections.
    with ws_serve(ws_handler, args.host, args.ws_port) as ws_server:
        print(f"Live bridge WebSocket at ws://localhost:{args.ws_port}/")
        controller = TrackingController(natnet_params, ws_server, args.units_to_mm)
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
