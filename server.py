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
import argparse
import json
import sys
import threading
import time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

import websockets
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


def natnet_loop(client, ws_server, stop_event, units_to_mm):
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

    refresh_names()
    last_refresh = time.time()

    for mocap in client.MoCap(timeout=1.0):
        if stop_event.is_set():
            break
        now = time.time()
        if now - last_refresh > DESCRIPTIONS_REFRESH_SEC:
            refresh_names()
            last_refresh = now

        rigid_bodies = [
            {
                "id": rb.identifier,
                "name": name_by_id.get(rb.identifier, str(rb.identifier)),
                "tracking": rb.tracking,
                # Converted to millimeters here (via units_to_mm, queried
                # once at startup) so the browser side can feed this straight
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
        message = json.dumps({
            "type": "frame",
            "frameNumber": mocap.prefix_data.frame_number,
            "rigidBodies": rigid_bodies,
        })
        websockets.broadcast(ws_server.connections, message)


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
    NatNetParams.argparse_group(parser)
    args = parser.parse_args()
    sys.stdout.reconfigure(line_buffering=True)  # status lines below matter even when output is redirected to a log file
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

    stop_event = threading.Event()
    client = NatNetClient(natnet_params)
    connected = client.connect(timeout=natnet_params.connection_timeout or 5.0)
    units_to_mm = 1000.0  # NatNet's documented wire default is meters
    if connected:
        try:
            units_to_mm = client.UnitesToMillimeters()
        except Exception as e:
            print(f"[natnet] couldn't query UnitesToMillimeters, assuming meters (1000): {e}", file=sys.stderr)
    else:
        print(
            f"Could not connect to Motive at {natnet_params.server_address}:{natnet_params.data_port} "
            "-- the app will still load, but Live mode will have nothing to show. "
            "Check Motive is running with streaming enabled, and --server-address/--use-multicast "
            "match its Streaming settings.",
            file=sys.stderr,
        )

    with ws_serve(ws_handler, args.host, args.ws_port) as ws_server:
        print(f"Live bridge WebSocket at ws://localhost:{args.ws_port}/")
        if connected:
            print(f"Connected to Motive at {natnet_params.server_address} (units_to_mm={units_to_mm})")
            natnet_thread = threading.Thread(
                target=natnet_loop, args=(client, ws_server, stop_event, units_to_mm), daemon=True
            )
            natnet_thread.start()
        try:
            ws_server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            stop_event.set()
            if connected:
                client.shutdown()


if __name__ == "__main__":
    main()
