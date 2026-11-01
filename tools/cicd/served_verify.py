#!/usr/bin/env python3
"""served_verify.py — post-deploy served-byte verification.

GitHub Pages propagation is file-by-file over minutes (proven in
the 2026-10-31 PHL D4 investigation), so "the deploy workflow went
green" does not prove riders are being served the new bytes. This
stage fetches the production bytes for every build-owned file and
compares MD5 against the deployed checkout:

  * per city: live-transit/<city>/<rel> for every bundleFiles
    entry of the city's build-manifest, EXCLUDING publisher-owned
    paths (data/**, publish-manifest.json — those legitimately
    advance with the next publisher cycle, minutes behind/ahead
    of any given deploy);
  * Detroit modular tree: the root build-manifest's entries
    (repo-relative keys);
  * Detroit page set: live-transit.html + the monolith scripts
    (whichever shell is live, its bytes must be the deployed ones);
  * terms.html and other slot files ARE included here — the
    comparison target is the checkout, not the manifest, so the
    slot exemptions of manifest_check.py do not apply.

Retries: full sweep every 30 s until all files match or the
budget (default 600 s) expires — a file that matches stays
matched (Pages never un-propagates a file).

Usage: served_verify.py [--root DIR] [--base URL] [--budget SECONDS]
Exit 0 = served == deployed for every checked file. Stdlib only.
"""

import hashlib
import json
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

DEFAULT_BASE = "https://www.detroitautomationacademy.com"
MONOLITH_FILES = [
    "live-transit.html",
    "live-transit.js",
    "raptor.js",
    "raptor-v2.js",
    "live-fusion.js",
    "ride-along.js",
    "ride-along.css",
]


def is_publisher_owned(rel):
    parts = rel.split("/")
    return rel == "publish-manifest.json" or (parts and parts[0] == "data")


def fetch_md5(url, timeout=30):
    if not url.startswith(("https://", "http://")):
        raise ValueError(f"refusing non-http(s) URL: {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "daa-served-verify"})
    h = hashlib.md5(usedforsecurity=False)
    # The URL is built from this script's own --base (default: the
    # production origin) plus manifest paths, and the scheme is
    # restricted to http/https by the check above — the urlopen
    # below carries a B310 nosec on this basis (estate pattern,
    # cf. live-transit/cincinnati/pipeline/collect.py).
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # nosec B310
        if resp.status != 200:
            return None
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def collect_targets(root, mode="full"):
    """Return {url_path: checkout_file} for every file to verify.

    mode "shells" (feed-cadence deploys): only the page shells —
    cheap enough to run every few minutes. mode "full" (code
    deploys): every build-owned file in every manifest plus the
    Detroit page set."""
    targets = {}
    for mp in sorted(root.glob("live-transit/*/build-manifest.json")):
        city = mp.parent.name
        m = json.loads(mp.read_text(encoding="utf-8"))
        for rel in m.get("bundleFiles", {}):
            if is_publisher_owned(rel):
                continue
            if mode == "shells" and rel != "index.html":
                continue
            targets[f"live-transit/{city}/{rel}"] = mp.parent / rel
    root_manifest = root / "build-manifest.json"
    if root_manifest.exists():
        m = json.loads(root_manifest.read_text(encoding="utf-8"))
        for rel in m.get("bundleFiles", {}):
            if mode == "shells":
                continue
            targets[rel] = root / rel
    if mode == "shells":
        # Cities without a build manifest (Philadelphia's stack
        # predates the discipline) still get their shell verified.
        for idx in sorted(root.glob("live-transit/*/index.html")):
            rel = f"live-transit/{idx.parent.name}/index.html"
            targets.setdefault(rel, idx)
    for name in MONOLITH_FILES:
        if mode == "shells" and name != "live-transit.html":
            continue
        p = root / name
        if p.exists():
            targets[name] = p
    return targets


def main(argv):
    root = Path(".")
    base = DEFAULT_BASE
    budget = 600
    mode = "full"
    if "--root" in argv:
        root = Path(argv[argv.index("--root") + 1])
    if "--base" in argv:
        base = argv[argv.index("--base") + 1].rstrip("/")
    if "--budget" in argv:
        budget = int(argv[argv.index("--budget") + 1])
    if "--mode" in argv:
        mode = argv[argv.index("--mode") + 1]
    root = root.resolve()
    targets = collect_targets(root, mode)
    if not targets:
        print("FAIL served-verify: no targets collected", file=sys.stderr)
        return 1
    want = {}
    for url_path, f in targets.items():
        if f.exists():
            want[url_path] = hashlib.md5(
                f.read_bytes(), usedforsecurity=False
            ).hexdigest()
    print(f"served-verify: {len(want)} files to confirm at {base}", flush=True)
    pending = dict(want)
    deadline = time.time() + budget

    def check(url_path):
        # Percent-encode: manifest paths legitimately contain
        # spaces (planner timetable filenames). Unencoded, those
        # fetches could never match — the defect that burned the
        # full budget and false-failed run 41275380038
        # (2026-11-01). Fetches run in parallel so a sweep takes
        # seconds, and each fetch's timeout shrinks to the time
        # left: the budget is a hard wall, checked per file, not
        # a between-sweeps suggestion.
        remaining = deadline - time.time()
        if remaining <= 0:
            return url_path, False
        url = f"{base}/{urllib.parse.quote(url_path)}"
        try:
            got = fetch_md5(url, timeout=max(1.0, min(30.0, remaining)))
        except Exception:  # noqa: BLE001 — a failed fetch is a miss
            got = None
        return url_path, got == want[url_path]

    while True:
        with ThreadPoolExecutor(max_workers=16) as pool:
            for url_path, ok in pool.map(check, list(pending)):
                if ok:
                    del pending[url_path]
        if not pending:
            print("EVIDENCE gate=served-verify class=bytes verdict=pass")
            print("served-verify: served == deployed for every checked file")
            return 0
        if time.time() >= deadline:
            print(
                f"FAIL served-verify: {len(pending)} files still not "
                "serving the deployed bytes after "
                f"{budget}s:",
                file=sys.stderr,
            )
            for url_path in sorted(pending):
                print(f"FAIL {url_path}: want md5 {pending[url_path]}", file=sys.stderr)
            print("EVIDENCE gate=served-verify class=bytes verdict=fail")
            return 1
        print(
            f"served-verify: {len(want) - len(pending)}/{len(want)} "
            "matched, next sweep in 30s",
            flush=True,
        )
        time.sleep(min(30.0, max(0.0, deadline - time.time())))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
