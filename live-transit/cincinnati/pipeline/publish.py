#!/usr/bin/env python3
"""publish.py — PUBLISH stage: the keyless single writer (KAES-19).

PHL REBUILD R2. Label: UNVERIFIED / legacy-unsigned.

The publisher makes ZERO source calls and holds NO keys (this
module imports no network library at all — verifiable by grep).
It takes the transform stage's output directory, verifies the
file family is complete (vehicles + alerts + trip-updates + the
tu/ derivative tree with its index), and publishes it into the
target data directory as one atomic swap: files are written to a
sibling staging directory, a publish-manifest.json with the
sha256 of every published file is written last, and the staging
directory is renamed over the target. One writer, one commit
unit — in production this stage's output directory is the exact
set of files the ship-gate chain commits to the repo's
live-transit/philadelphia/data/ tree, and nothing else writes
that tree (LT-D6).

Usage:
  publish.py --from-dir DIR --to-dir DIR
"""

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

REQUIRED = ["vehicles.json", "alerts.json", "trip-updates.json", "tu/index.json"]


def publish(from_dir, to_dir):
    src = Path(from_dir) / "data"
    for rel in REQUIRED:
        if not (src / rel).exists():
            raise RuntimeError(f"transform output missing data/{rel}")
    files = sorted(p for p in src.rglob("*") if p.is_file())
    target = Path(to_dir)
    staging = target.with_name(target.name + ".staging")
    if staging.exists():
        shutil.rmtree(staging)
    manifest_files = {}
    for p in files:
        rel = p.relative_to(src).as_posix()
        dest = staging / "data" / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        data = p.read_bytes()
        dest.write_bytes(data)
        manifest_files[f"data/{rel}"] = {
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
    transform_report = Path(from_dir) / "transform-report.json"
    generated_at = None
    if transform_report.exists():
        generated_at = json.loads(transform_report.read_text(encoding="utf-8"))[
            "generated_at"
        ]
    manifest = {
        "stage": "publish",
        "generated_at": generated_at,
        "file_count": len(manifest_files),
        "files": manifest_files,
    }
    (staging / "publish-manifest.json").write_text(
        json.dumps(manifest, indent=1), encoding="utf-8"
    )
    if target.exists():
        shutil.rmtree(target)
    staging.rename(target)
    print(
        f"publish: {len(manifest_files)} files -> {target} "
        f"(generated_at {generated_at})"
    )
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-dir", required=True)
    ap.add_argument("--to-dir", required=True)
    args = ap.parse_args()
    return publish(args.from_dir, args.to_dir)


if __name__ == "__main__":
    sys.exit(main())
