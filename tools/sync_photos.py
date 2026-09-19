#!/usr/bin/env python3
r"""
sync_photos.py -- pulls Camerapture screenshots from a live Minecraft server
world into this website's img/photos/ folder, with the photographer's name
and capture time attached, then commits and pushes so the live site updates.

WHAT THIS ASSUMES
------------------
Everything here was worked out by reading the Camerapture mod's own source
(https://github.com/chrrs/camerapture) rather than by testing against a real
running server -- I don't have access to your server's files from here. The
three things most likely to need a small fix if they don't match your server:

  1. The world save folder layout (world/camerapture/*.webp, world/entities/,
     world/playerdata/) -- standard for a modern vanilla-layout server, but
     if you changed level-name in server.properties it won't be called
     "world".
  2. The exact on-disk NBT shape of an item's "camerapture:picture_data"
     component (see find_picture_data below) -- I know the three fields are
     (id: uuid, creator: string, timestamp: long) and the component's
     registry name, but not 100% how Mojang's own UUID codec serializes on
     disk in your exact game version, so this handles both formats it could
     plausibly be (a plain string, or a 4-int array).
  3. Photos still sitting in a chest/shulker box/ender chest instead of a
     player's own inventory or a placed picture frame won't be found -- only
     those two locations are searched.

If a photo's metadata can't be found at all, it still gets synced -- just
shown as "Unknown" with no date, instead of being skipped.

NO THIRD-PARTY DEPENDENCIES -- this reads Minecraft's NBT and region (.mca)
binary formats itself (they're simple, documented formats), the same way
the rest of this project's tooling reads/writes PNG by hand. Just needs
Python 3.8+ and git on PATH.

SETUP (on the machine actually running the Minecraft server)
--------------------------------------------------------------
1. Clone this website's git repo onto the server machine (this script expects
   to live at <repo>/tools/sync_photos.py, i.e. right where it already is --
   move the whole repo, not just this file). Give that clone push access (a
   GitHub personal access token or SSH deploy key with write access to this
   repo, set up as its own git remote credential on this machine; don't
   reuse your personal account's main credentials for an unattended script).
2. Edit the two paths right below (WORLD_DIR, REPO_DIR) for this machine.
3. Run once by hand to check it works: `python sync_photos.py`
4. Schedule it to run periodically (Windows: Task Scheduler, an action
   running `python C:\path\to\sync_photos.py` every N minutes; Linux: a cron
   entry). Every run only processes photos it hasn't seen before, so running
   it often (e.g. every 5-10 minutes) is cheap.
"""

import gzip
import json
import re
import struct
import subprocess
import sys
import zlib
from pathlib import Path

# ---------------------------------------------------------------------------
# CONFIG -- edit these for the machine this actually runs on.
# ---------------------------------------------------------------------------

# The Minecraft server's world save folder (contains "camerapture", "entities",
# "playerdata", "region", etc.) -- NOT the server root, the world folder itself.
WORLD_DIR = Path(r"C:\path\to\your\server\world")

# A local clone of this website's git repo, with a push-capable remote already
# configured (e.g. `git remote set-url origin https://<token>@github.com/you/repo.git`).
REPO_DIR = Path(r"C:\path\to\Streamer-Event-Wiki")

# Where synced photos land inside the repo, and the manifest the site reads.
PHOTOS_DIR = REPO_DIR / "img" / "photos"
MANIFEST_JS = PHOTOS_DIR / "manifest.js"

# Local cache of {uuid: {"creator":..., "timestamp":...}} so metadata found
# once doesn't need to be re-derived (and survives a picture frame later
# being broken, which would otherwise erase the only copy of that data).
PHOTO_DB = Path(__file__).parent / "photo_db.json"

PUSH = True  # set False to just commit locally without pushing, for testing


# ---------------------------------------------------------------------------
# Minimal NBT reader (big-endian, Java edition binary NBT).
# Returns plain Python values: dict (compound), list, int, float, str, bytes.
# ---------------------------------------------------------------------------

TAG_END, TAG_BYTE, TAG_SHORT, TAG_INT, TAG_LONG, TAG_FLOAT, TAG_DOUBLE, \
    TAG_BYTE_ARRAY, TAG_STRING, TAG_LIST, TAG_COMPOUND, TAG_INT_ARRAY, TAG_LONG_ARRAY = range(13)


class NbtReader:
    def __init__(self, data):
        self.data = data
        self.pos = 0

    def u8(self):
        v = self.data[self.pos]
        self.pos += 1
        return v

    def read(self, n):
        v = self.data[self.pos:self.pos + n]
        self.pos += n
        return v

    def i16(self):
        return struct.unpack(">h", self.read(2))[0]

    def u16(self):
        return struct.unpack(">H", self.read(2))[0]

    def i32(self):
        return struct.unpack(">i", self.read(4))[0]

    def i64(self):
        return struct.unpack(">q", self.read(8))[0]

    def f32(self):
        return struct.unpack(">f", self.read(4))[0]

    def f64(self):
        return struct.unpack(">d", self.read(8))[0]

    def string(self):
        n = self.u16()
        return self.read(n).decode("utf-8", errors="replace")

    def payload(self, tag_type):
        if tag_type == TAG_BYTE:
            return struct.unpack(">b", self.read(1))[0]
        if tag_type == TAG_SHORT:
            return self.i16()
        if tag_type == TAG_INT:
            return self.i32()
        if tag_type == TAG_LONG:
            return self.i64()
        if tag_type == TAG_FLOAT:
            return self.f32()
        if tag_type == TAG_DOUBLE:
            return self.f64()
        if tag_type == TAG_BYTE_ARRAY:
            n = self.i32()
            return list(self.read(n))
        if tag_type == TAG_STRING:
            return self.string()
        if tag_type == TAG_LIST:
            elem_type = self.u8()
            n = self.i32()
            return [self.payload(elem_type) for _ in range(n)]
        if tag_type == TAG_COMPOUND:
            out = {}
            while True:
                t = self.u8()
                if t == TAG_END:
                    break
                name = self.string()
                out[name] = self.payload(t)
            return out
        if tag_type == TAG_INT_ARRAY:
            n = self.i32()
            return [self.i32() for _ in range(n)]
        if tag_type == TAG_LONG_ARRAY:
            n = self.i32()
            return [self.i64() for _ in range(n)]
        raise ValueError(f"unknown NBT tag type {tag_type} at byte {self.pos}")

    def read_named_root(self):
        t = self.u8()
        if t == TAG_END:
            return None
        self.string()  # root tag's name, always discarded (usually "")
        return self.payload(t)


def parse_nbt(data: bytes):
    """Parses one root compound tag from raw (already-decompressed) NBT bytes."""
    return NbtReader(data).read_named_root()


def parse_nbt_file(path: Path):
    """Reads a standalone NBT file (player .dat), gzip or plain."""
    raw = path.read_bytes()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return parse_nbt(raw)


# ---------------------------------------------------------------------------
# Minimal Anvil/MCA region-file reader -- yields each present chunk's parsed
# root NBT compound.
# ---------------------------------------------------------------------------

def iter_region_chunks(mca_path: Path):
    data = mca_path.read_bytes()
    if len(data) < 8192:
        return
    for i in range(1024):
        entry = data[i * 4:i * 4 + 4]
        sector_offset = (entry[0] << 16) | (entry[1] << 8) | entry[2]
        sector_count = entry[3]
        if sector_offset == 0 or sector_count == 0:
            continue
        start = sector_offset * 4096
        if start + 5 > len(data):
            continue
        length = struct.unpack(">I", data[start:start + 4])[0]
        compression = data[start + 4]
        chunk_data = data[start + 5:start + 4 + length]
        try:
            if compression == 1:
                raw = gzip.decompress(chunk_data)
            elif compression == 2:
                raw = zlib.decompress(chunk_data)
            elif compression == 3:
                raw = chunk_data
            else:
                continue  # unsupported (e.g. external/LZ4 chunk) -- skip rather than crash
            yield parse_nbt(raw)
        except Exception:
            continue  # a single corrupt/odd chunk shouldn't kill the whole sync


# ---------------------------------------------------------------------------
# UUID helpers -- Camerapture's PictureData.id uses Mojang's "authlib" UUID
# codec, which could plausibly be on-disk as either a plain string or the
# usual Minecraft 4-int-array UUID encoding. Handle both.
# ---------------------------------------------------------------------------

def ints_to_uuid(ints):
    if len(ints) != 4:
        return None
    b = b"".join(struct.pack(">i", x) for x in ints)
    hexs = b.hex()
    return f"{hexs[0:8]}-{hexs[8:12]}-{hexs[12:16]}-{hexs[16:20]}-{hexs[20:32]}"


def normalize_uuid(value):
    if isinstance(value, str):
        v = value.strip().lower()
        return v if re.fullmatch(r"[0-9a-f-]{32,36}", v) else None
    if isinstance(value, list):
        return ints_to_uuid(value)
    return None


# ---------------------------------------------------------------------------
# Digging PictureData (creator, timestamp) out of an ItemStack's NBT.
# ---------------------------------------------------------------------------

def picture_data_from_item(item):
    if not isinstance(item, dict):
        return None
    components = item.get("components")
    if not isinstance(components, dict):
        return None
    pd = components.get("camerapture:picture_data")
    if not isinstance(pd, dict):
        return None
    uuid = normalize_uuid(pd.get("id"))
    creator = pd.get("creator")
    timestamp = pd.get("timestamp")
    if uuid is None:
        return None
    return uuid, {"creator": creator, "timestamp": timestamp}


def scan_entities_dir(entities_dir: Path, found: dict):
    if not entities_dir.is_dir():
        return
    for mca in entities_dir.glob("r.*.*.mca"):
        for chunk in iter_region_chunks(mca):
            if not chunk:
                continue
            for entity in chunk.get("Entities", []):
                if entity.get("id") != "camerapture:picture_frame":
                    continue
                result = picture_data_from_item(entity.get("item"))
                if result:
                    uuid, meta = result
                    found.setdefault(uuid, meta)


def scan_playerdata_dir(playerdata_dir: Path, found: dict):
    if not playerdata_dir.is_dir():
        return
    for dat in playerdata_dir.glob("*.dat"):
        try:
            root = parse_nbt_file(dat)
        except Exception:
            continue
        if not root:
            continue
        for key in ("Inventory", "EnderItems"):
            for item in root.get(key, []) or []:
                result = picture_data_from_item(item)
                if result:
                    uuid, meta = result
                    found.setdefault(uuid, meta)


def build_metadata_index():
    """One pass over entities + player data, returns {uuid: {creator, timestamp}}."""
    found = {}
    scan_entities_dir(WORLD_DIR / "entities", found)
    scan_playerdata_dir(WORLD_DIR / "playerdata", found)
    return found


# ---------------------------------------------------------------------------
# Main sync
# ---------------------------------------------------------------------------

def load_db():
    if PHOTO_DB.exists():
        return json.loads(PHOTO_DB.read_text())
    return {}


def save_db(db):
    PHOTO_DB.write_text(json.dumps(db, indent=2, sort_keys=True))


def run_git(*args):
    return subprocess.run(["git", *args], cwd=REPO_DIR, check=True,
                           capture_output=True, text=True)


def main():
    camerapture_dir = WORLD_DIR / "camerapture"
    if not camerapture_dir.is_dir():
        sys.exit(f"No camerapture folder found at {camerapture_dir} -- "
                  f"check WORLD_DIR at the top of this script.")

    PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
    db = load_db()

    webp_files = sorted(camerapture_dir.glob("*.webp"))
    new_uuids = [p.stem for p in webp_files if p.stem not in db]

    if new_uuids:
        print(f"{len(new_uuids)} new photo(s) -- scanning world save for creator/timestamp...")
        metadata_index = build_metadata_index()
    else:
        metadata_index = {}

    changed = False
    for webp in webp_files:
        uuid = webp.stem
        dest = PHOTOS_DIR / webp.name
        if uuid not in db:
            meta = metadata_index.get(uuid, {})
            db[uuid] = {
                "file": webp.name,
                "creator": meta.get("creator"),
                "timestamp": meta.get("timestamp"),
            }
            changed = True
        if not dest.exists():
            dest.write_bytes(webp.read_bytes())
            changed = True

    if not changed:
        print("Nothing new to sync.")
        return

    save_db(db)

    # Only list photos whose file is actually still present in img/photos/.
    entries = [v for v in db.values() if (PHOTOS_DIR / v["file"]).exists()]
    entries.sort(key=lambda v: v.get("timestamp") or 0, reverse=True)
    manifest_js = "window.PHOTO_MANIFEST = " + json.dumps(entries, indent=2) + ";\n"
    MANIFEST_JS.write_text(manifest_js)

    print(f"Synced {len(new_uuids)} new photo(s), {len(entries)} total in manifest.")

    run_git("add", "img/photos", "tools/photo_db.json")
    status = run_git("status", "--porcelain")
    if not status.stdout.strip():
        print("git: nothing staged (manifest/photos unchanged after all).")
        return

    run_git("commit", "-m", f"Sync {len(new_uuids)} new server photo(s)")
    if PUSH:
        run_git("push")
        print("Pushed.")
    else:
        print("Committed locally (PUSH=False, not pushed).")


if __name__ == "__main__":
    main()
