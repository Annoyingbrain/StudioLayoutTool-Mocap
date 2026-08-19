"""Shrink the frame grabs already stored inside saved setups.

A frame grab lives inside its setup's JSON as a base64 data URL, so the
picture's size IS the setup file's size (times 1.33 for the base64). Imports
are scaled down on the way in now (js/utils/dom.js's readImageFileAsDataUrl),
but setups saved before that carry the stills exactly as they came off the
camera -- one of them reached 72MB, which GitHub's contents API refuses
outright ("422 ... the file is too large to be processed") and which every
save, load and device sync then has to carry.

This rewrites those grabs at the same size the browser now imports them at.
It is LOSSY and it edits the real setup files, so:

  * it does nothing without --write (default is a report of what it would do)
  * it copies each file to <name>.json.bak before touching it
  * it writes via a temp file + replace, like server.py does, so a setup is
    never left half-written

    pip install Pillow          # needed only by this script, not by the app
    python shrink_frame_grabs.py                    # report only
    python shrink_frame_grabs.py --write            # do it
"""
import argparse
import base64
import io
import json
import os
import re
import shutil
import sys
from pathlib import Path

# Kept in step with js/utils/dom.js's FRAME_GRAB_MAX_PX / FRAME_GRAB_QUALITY,
# so a migrated grab and a freshly imported one come out the same.
MAX_PX = 1920
QUALITY = 82

DATA_URL_RE = re.compile(r'^data:image/([a-zA-Z0-9.+-]+);base64,(.*)$', re.S)


def shrink_data_url(data_url):
    """Returns a smaller data URL, or None if it can't or needn't be shrunk."""
    from PIL import Image

    m = DATA_URL_RE.match(data_url or '')
    if not m:
        return None
    try:
        raw = base64.b64decode(m.group(2))
        img = Image.open(io.BytesIO(raw))
        img.load()
    except Exception as exc:                      # noqa: BLE001 - report and skip
        print(f"    ! could not decode ({exc}); left alone")
        return None

    # JPEG has no alpha; a grab is a photograph, so flatten rather than fail.
    if img.mode not in ('RGB', 'L'):
        img = img.convert('RGB')

    factor = min(1.0, MAX_PX / max(img.size))
    if factor < 1.0:
        img = img.resize((round(img.width * factor), round(img.height * factor)),
                         Image.LANCZOS)

    out = io.BytesIO()
    img.save(out, format='JPEG', quality=QUALITY, optimize=True)
    shrunk = 'data:image/jpeg;base64,' + base64.b64encode(out.getvalue()).decode('ascii')

    # A grab that is already small (or already a tighter JPEG than this) comes
    # out no smaller, and rewriting it would only throw away quality.
    return shrunk if len(shrunk) < len(data_url) else None


def grabs_in(setup):
    """Yields (label, frameGrab dict) for every grab anywhere in a setup.

    A grab hangs off a CAMERA now, but it has lived in two other places and
    the older files on disk still hold it there: on the scene (moved onto a
    camera by App.Store's migrateFrameGrab when the browser loads it) and,
    older still, on the setup itself (moved onto the scene by persistence.js).
    Those migrations happen in memory on load, so a setup saved years ago is
    STILL scene-shaped on disk -- which is exactly the file this script is
    pointed at. Looking only at cameras made two 7MB setups report "nothing to
    do" while their whole 7MB sat one level up.
    """
    if setup.get('frameGrab') and setup['frameGrab'].get('imageDataUrl'):
        yield 'setup', setup['frameGrab']
    for scene in setup.get('scenes', []):
        name = scene.get('name', '?')
        if scene.get('frameGrab') and scene['frameGrab'].get('imageDataUrl'):
            yield name, scene['frameGrab']
        for camera in scene.get('cameras', []):
            if camera.get('frameGrab') and camera['frameGrab'].get('imageDataUrl'):
                yield f"{name} / {camera.get('name', '?')}", camera['frameGrab']


def mb(n):
    return n / 1048576.0


def process(path, write):
    setup = json.loads(path.read_text(encoding='utf-8'))
    before = path.stat().st_size
    print(f"\n{path.name}  ({mb(before):.2f} MB)")

    changed = 0
    for label, grab in grabs_in(setup):
        url = grab['imageDataUrl']
        shrunk = shrink_data_url(url)
        if shrunk is None:
            print(f"    = {label}: {mb(len(url)):.2f} MB, left alone")
            continue
        print(f"    - {label}: {mb(len(url)):.2f} MB -> {mb(len(shrunk)):.2f} MB")
        # Applied to the in-memory copy even on a dry run: the file is only
        # written under --write, and without this the projected total below is
        # just the original size again -- which is what a first dry run
        # reported ("72.35 MB -> 72.34 MB"), hiding the entire point.
        grab['imageDataUrl'] = shrunk
        changed += 1

    if not changed:
        print("    nothing to do")
        return before, before

    body = json.dumps(setup, indent=2)
    after = len(body.encode('utf-8'))
    print(f"    {mb(before):.2f} MB -> {mb(after):.2f} MB")

    if write:
        shutil.copy2(path, path.with_suffix('.json.bak'))
        tmp = path.with_suffix('.json.tmp')
        tmp.write_text(body, encoding='utf-8')
        os.replace(tmp, path)
        print(f"    written (original kept as {path.with_suffix('.json.bak').name})")

    return before, after


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--setups-dir', default=str(Path(__file__).resolve().parent / 'setups'),
                    help='same folder as server.py --setups-dir')
    ap.add_argument('--write', action='store_true',
                    help='actually rewrite the setups (default: report only)')
    args = ap.parse_args()

    try:
        import PIL  # noqa: F401
    except ImportError:
        sys.exit("Pillow is needed for this script (the app itself does not use it):\n"
                 "    pip install Pillow")

    folder = Path(args.setups_dir).expanduser().resolve()
    files = sorted(folder.glob('*.json'))
    if not files:
        sys.exit(f"No setups found in {folder}")

    print(f"{'Rewriting' if args.write else 'Checking (no changes will be made)'}: {folder}")
    total_before = total_after = 0
    for path in files:
        b, a = process(path, args.write)
        total_before += b
        total_after += a

    print(f"\nTotal: {mb(total_before):.2f} MB -> {mb(total_after):.2f} MB")
    if not args.write:
        print("Nothing was changed. Re-run with --write to apply.")


if __name__ == '__main__':
    main()
