#!/usr/bin/env python3
"""collect.py — COLLECT stage of the rebuilt PHL pipeline (KAES-19).

PHL REBUILD R2. Label: UNVERIFIED / legacy-unsigned.

Fetch-only. Downloads the six raw GTFS-RT payloads of the R1
config's endpoint set (LT-KAES-16) and writes them, untouched, as
a raw bundle: one .pb file per leg plus manifest.json written
LAST — the manifest is the completeness marker (LT-D6); a bundle
without a manifest is not a bundle and the transform refuses it.

Each leg is independently fault-isolated (LT-KAES-20): a failed
leg is recorded in the manifest with its error and the stage
still completes; the run fails only if EVERY leg fails (there
would be nothing truthful to publish). No transform happens here,
and no key exists anywhere in this chain (SEPTA is keyless
agency-direct, A3 custody record; LT-KAES-17 satisfied
vacuously).

Usage:
  collect.py --bundle-dir DIR [--fail-leg LEG_ID]
  --fail-leg forces one leg to raise (the leg-kill test hook).
"""

import argparse
import hashlib
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from septa_config import FETCH_TIMEOUT_SEC, LEGS, USER_AGENT  # noqa: E402


def iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch(url):
    # Scheme guard: the leg URLs are fixed agency endpoints from
    # septa_config; refuse anything but http/https rather than
    # letting urlopen follow file:/custom schemes. The urlopen
    # below carries a B310 nosec on this basis.
    if not url.startswith(("https://", "http://")):
        raise ValueError(f"refusing non-http(s) leg URL: {url!r}")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_SEC) as r:  # nosec B310
        return r.read()


def collect(bundle_dir, fail_leg=None):
    bundle = Path(bundle_dir)
    bundle.mkdir(parents=True, exist_ok=True)
    collected_at = datetime.now(timezone.utc)
    legs = {}
    ok_count = 0
    for leg_id, family, kind, url in LEGS:
        entry = {
            "id": leg_id,
            "family": family,
            "kind": kind,
            "url": url,
            "file": f"{leg_id}.pb",
            "ok": False,
            "error": None,
            "bytes": None,
            "sha256": None,
        }
        try:
            if fail_leg == leg_id:
                raise RuntimeError("forced leg failure (leg-kill test)")
            buf = fetch(url)
            (bundle / entry["file"]).write_bytes(buf)
            entry["ok"] = True
            entry["bytes"] = len(buf)
            entry["sha256"] = hashlib.sha256(buf).hexdigest()
            ok_count += 1
        except Exception as e:  # per-leg isolation: record, continue
            entry["error"] = f"{type(e).__name__}: {e}"[:300]
        legs[leg_id] = entry
        state = "ok" if entry["ok"] else f"ERROR {entry['error']}"
        print(f"collect {leg_id}: {state}", flush=True)
    manifest = {
        "stage": "collect",
        "city": "philadelphia",
        "agency": "septa",
        "collected_at": collected_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "collected_at_epoch": int(collected_at.timestamp()),
        "legs": legs,
        "legs_ok": ok_count,
        "legs_total": len(LEGS),
    }
    # Manifest LAST: its presence marks the bundle complete (LT-D6).
    tmp = bundle / "manifest.json.tmp"
    tmp.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    tmp.replace(bundle / "manifest.json")
    print(f"collect: {ok_count}/{len(LEGS)} legs ok -> {bundle}")
    if ok_count == 0:
        print("collect: ALL legs failed; no publishable bundle", file=sys.stderr)
        return 2
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle-dir", required=True)
    ap.add_argument(
        "--fail-leg", default=None, help="force this leg id to fail (leg-kill test)"
    )
    args = ap.parse_args()
    return collect(args.bundle_dir, fail_leg=args.fail_leg)


if __name__ == "__main__":
    sys.exit(main())
