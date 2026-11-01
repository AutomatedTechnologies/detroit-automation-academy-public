#!/usr/bin/env python3
"""manifest_check.py — build-manifest recompute gate.

Every assembled city bundle carries a build-manifest.json whose
bundleFiles map records the MD5 of each file at assembly time
(the assembler's G11 discipline). If a file's bytes change after
assembly without the manifest being regenerated — a hand-edit, a
graft onto the wrong base, a partial ship — the manifest and the
tree disagree, and the disagreement is exactly the class of drift
that put a mis-assembled Detroit bundle into production on
2026-10-31. This gate recomputes every recorded hash and compares.

Publisher-owned paths are excluded, by evidence: the chain
publishers rewrite live-transit/<city>/data/** and
publish-manifest.json every few minutes, so those entries' hashes
legitimately move after assembly (verified 2026-11-01: San Diego
data/vehicles.json and publish-manifest.json both differ from the
build manifest while every code file matches). Those paths are
governed by the publisher's own publish-manifest (sha256) and the
KAES-42 hourly checks, not by the build manifest. Everything else
in bundleFiles — code, shell, config, static geometry — must match
byte-for-byte.

Covers: live-transit/<city>/build-manifest.json for each city that
has one, plus the root build-manifest.json (Detroit's bundle, whose
keys are repo-relative). Cities without a build manifest (their
stack predates the discipline) are reported as SKIPs, not failures.

Usage: manifest_check.py [--root DIR]
Exit 0 = all recomputed hashes match. Stdlib only.
"""

import hashlib
import json
import sys
from pathlib import Path


def is_publisher_owned(rel):
    """rel: path relative to the city/bundle root."""
    parts = rel.split("/")
    return rel == "publish-manifest.json" or (parts and parts[0] == "data")


# Slot exceptions — files whose bytes are owned outside the bundle
# assembly, so the build manifest is not their authority. Each is
# printed loudly in the gate output; the list is deliberately tiny.
#   terms.html — per-city legal copy slot. The 2026-10-31 fold ship
#     sets already excluded it (production terms copy had diverged
#     from the assembler bases; fold build record). Owner edits land
#     without re-assembly.
SLOT_EXEMPT = {"terms.html"}


def root_exempt(rel):
    """Root (Detroit) manifest only: live-transit.html names the
    staged bundle's shell. After the 2026-10-31 revert the repo-root
    page is the monolith, so this entry is verified by the
    shell-contract gate at ship time, not against the production
    page's bytes."""
    return rel == "live-transit.html"


def check_manifest(manifest_path, base, label, is_root=False):
    m = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    files = m.get("bundleFiles")
    if not isinstance(files, dict) or not files:
        return [f"{label}: build-manifest has no bundleFiles map"]
    failures, checked, skipped, exempt = [], 0, 0, 0
    for rel, want in sorted(files.items()):
        tail = rel.split("/")[-1]
        if (tail in SLOT_EXEMPT and not is_root) or (is_root and root_exempt(rel)):
            exempt += 1
            print(f"NOTE {label}: slot-exempt {rel} (see manifest_check.py)")
            continue
        rel_check = rel
        if is_root and "/" in rel:
            rel_check = rel  # root manifest keys are repo-relative already
        if is_publisher_owned(rel if not is_root else rel.split("detroit/")[-1]):
            skipped += 1
            continue
        p = Path(base) / rel_check
        if not p.exists():
            failures.append(f"{label}: manifest lists missing file {rel}")
            continue
        got = hashlib.md5(p.read_bytes(), usedforsecurity=False).hexdigest()
        checked += 1
        if got != want:
            failures.append(
                f"{label}: {rel} md5 {got} != manifest {want} "
                "(bytes changed after assembly, or stale manifest)"
            )
    print(
        f"OK   {label}: {checked} files recomputed, {skipped} "
        f"publisher-owned skipped, {exempt} slot-exempt"
        if not failures
        else f"FAIL {label}: {len(failures)} mismatches"
    )
    return failures


def main(argv):
    root = Path(".")
    if "--root" in argv:
        root = Path(argv[argv.index("--root") + 1])
    root = root.resolve()
    failures, covered = [], 0
    for mp in sorted(root.glob("live-transit/*/build-manifest.json")):
        covered += 1
        failures += check_manifest(mp, mp.parent, mp.parent.name)
    root_manifest = root / "build-manifest.json"
    if root_manifest.exists():
        covered += 1
        failures += check_manifest(root_manifest, root, "detroit (root)", is_root=True)
    if covered == 0:
        print("FAIL manifest-check: no build manifests found", file=sys.stderr)
        return 1
    verdict = "fail" if failures else "pass"
    print(f"EVIDENCE gate=manifest-recompute class=bytes verdict={verdict}")
    if failures:
        print("\nMANIFEST VIOLATIONS:", file=sys.stderr)
        for f in failures:
            print(f"FAIL {f}", file=sys.stderr)
        return 1
    print("manifest-check: all build manifests recompute clean")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
