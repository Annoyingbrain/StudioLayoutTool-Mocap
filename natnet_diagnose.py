#!/usr/bin/env python3
# Standalone NatNet connection diagnostic -- no HTTP server, no WebSocket,
# no threads of our own. Just tries to connect to Motive and reports exactly
# where it gets to, so a hang can be located precisely.
#
# The point: server.py's connect attempt can hang with no output, and it's
# impossible to tell from the outside whether it's stuck creating a socket,
# waiting for its own background thread, or waiting for Motive to reply.
# new_natnet_client logs each of those steps via the "NatNet" logger at
# DEBUG level -- this turns that logging on (server.py doesn't) so the last
# line printed before a hang names the step that hung.
#
# Run on the machine where Motive is (or that can reach it):
#   python natnet_diagnose.py                      (loopback, multicast -- Motive's default)
#   python natnet_diagnose.py --use-multicast false
#   python natnet_diagnose.py --server-address 172.16.16.211 --local-address 172.16.16.211
import argparse
import logging
import socket
import sys
import threading
import time

from new_natnet_client.Client import NatNetClient, NatNetParams

CONNECT_TIMEOUT_SEC = 10.0


def query_with_timeout(fn, timeout=3.0):
    """Several of this library's request/response helpers wait on the reply
    with an unbounded `while self._server_response is None:` spin -- if
    Motive doesn't answer (or rejects the command), they never return. Run
    them in a daemon thread so an unanswered query costs `timeout` seconds
    instead of wedging the script."""
    out = {}

    def worker():
        try:
            out["value"] = fn()
        except Exception as e:
            out["error"] = e

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    t.join(timeout=timeout)
    if t.is_alive():
        return f"<no reply within {timeout:.0f}s -- Motive didn't answer this query>"
    if "error" in out:
        return f"<raised {out['error']!r}>"
    return out["value"]


def check_port(host, port, kind):
    """UDP has no 'is it listening' handshake, so this only reports whether
    the port can be bound -- i.e. whether something else already holds it.
    Useful for spotting leftover stuck server.py instances."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.bind((host, port))
        return f"  {kind} port {port}: free (nothing bound here)"
    except OSError as e:
        return f"  {kind} port {port}: IN USE ({e.strerror}) -- something already holds it"
    finally:
        s.close()


def main():
    parser = argparse.ArgumentParser(description="Diagnose a NatNet connection to Motive")
    NatNetParams.argparse_group(parser)
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s %(levelname)-7s [%(name)s] %(message)s",
        stream=sys.stdout,
    )
    # This is the whole point of the script -- server.py leaves this logger
    # at its default level, so these step-by-step lines never appear there.
    logging.getLogger("NatNet").setLevel(logging.DEBUG)

    params = NatNetParams(
        server_address=args.server_address,
        local_ip_address=args.local_address,
        use_multicast=args.use_multicast,
        multicast_address=args.multicast_address,
        command_port=args.command_port,
        data_port=args.data_port,
        max_buffer_size=args.max_buffer_size,
        connection_timeout=args.connection_timeout,
    )

    print("=" * 70)
    print(f"python           : {sys.version.split()[0]} ({sys.platform})")
    print(f"server_address   : {params.server_address}   (where Motive is)")
    print(f"local_ip_address : {params.local_ip_address}   (must match Motive's Local Interface)")
    print(f"use_multicast    : {params.use_multicast}   (must match Motive's Transmission Type)")
    print(f"multicast_address: {params.multicast_address}")
    print(f"command/data port: {params.command_port}/{params.data_port}")
    # Only meaningful in multicast mode: there the client binds the data
    # port itself (so a second client, e.g. Unreal's, can clash). In unicast
    # the client binds an ephemeral port instead and Motive sends to that,
    # so "in use" here says nothing about whether unicast will work.
    if params.use_multicast:
        print("port availability:")
        print(check_port(params.local_ip_address, params.data_port, "data"))
    else:
        print("port availability: (skipped -- unicast binds an ephemeral port, not "
              f"{params.data_port}, so that port's state is irrelevant here)")
    print("=" * 70)
    print(f"Calling connect(timeout={CONNECT_TIMEOUT_SEC})... the LAST debug line below is where it got to.")
    print("-" * 70)

    result = {}

    def worker():
        try:
            result["connected"] = client.connect(CONNECT_TIMEOUT_SEC)
        except Exception as e:
            result["exception"] = e

    client = NatNetClient(params)
    t = threading.Thread(target=worker, daemon=True)
    started = time.time()
    t.start()
    t.join(timeout=CONNECT_TIMEOUT_SEC + 10.0)
    elapsed = time.time() - started

    print("-" * 70)
    if "exception" in result:
        print(f"RESULT: connect() raised after {elapsed:.1f}s: {result['exception']!r}")
    elif t.is_alive():
        print(f"RESULT: connect() STILL HANGING after {elapsed:.1f}s.")
        print("        The last debug line above names the step it hung on:")
        print("          (no 'command socket created')  -> stuck creating the command socket")
        print("          (no 'data socket created')     -> stuck creating/joining the data socket")
        print("                                            (multicast join on this interface)")
        print("          ('Client connected' but no more) -> sockets fine, Motive never replied:")
        print("                                            check Motive's NatNet 'Enable' toggle,")
        print("                                            and that Local Interface matches the")
        print("                                            --local-address above.")
    elif result.get("connected"):
        print(f"RESULT: CONNECTED in {elapsed:.1f}s.")
        print(f"        server info      : {client.server_info}")
        # NOT calling client.UnitesToMillimeters() -- that library method
        # sends a misspelled command ("UnitesToMillimeters"; the real NatNet
        # command is "UnitsToMillimeters"), Motive answers
        # UNRECOGNIZED_REQUEST, and its `while self._server_response is
        # None:` loop then spins forever with no timeout and no exception.
        # That single call was the cause of the silent hang this script was
        # written to find. FrameRate() has the same unguarded wait, so it's
        # bounded here rather than trusted.
        print(f"        FrameRate        : {query_with_timeout(client.FrameRate)}")
        print("\n        Reading 3 seconds of frames...")
        seen = 0
        deadline = time.time() + 3.0
        for mocap in client.MoCap(timeout=1.0):
            seen += 1
            if seen == 1:
                rbs = mocap.rigid_body_data.rigid_bodies
                print(f"        first frame: #{mocap.prefix_data.frame_number}, {len(rbs)} rigid bodies")
                for rb in rbs:
                    print(f"          id={rb.identifier} tracking={rb.tracking} pos=({rb.pos.x:.4f}, {rb.pos.y:.4f}, {rb.pos.z:.4f})")
            if time.time() > deadline:
                break
        print(f"        {seen} frames in ~3s")
        client.shutdown()
    else:
        print(f"RESULT: connect() returned False after {elapsed:.1f}s (refused/timed out, not hung).")
        print("        Motive is reachable-ish but didn't complete the handshake --")
        print("        check Motive's NatNet 'Enable' toggle and Transmission Type.")


if __name__ == "__main__":
    main()
