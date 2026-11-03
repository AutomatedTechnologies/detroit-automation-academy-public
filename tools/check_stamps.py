#!/usr/bin/env python3
"""Stamp-discipline check (project 28, register C-15).

The rule (AGENTS.md, 2026-10-16): a shared asset's content change
ships with a site-wide stamp bump in the same deploy, or returning
visitors keep the cached old asset indefinitely. The Find lane was
live in nav.js and invisible in the site nav for exactly this reason:
nav.js changed, its ?v= stamp did not, and fresh-profile verification
could not see it. Until now the rule was enforced by memory alone.

What this checks, for a base..HEAD diff (default HEAD~1..HEAD):

  Changed-without-bump: a SHARED stamped asset (referenced with a
  ?v=YYYYMMDD-HHMM stamp by at least --shared-min distinct pages)
  whose bytes differ between base and HEAD, while no page that
  referenced it at base carries a different stamp at HEAD.

  Deliberately NOT checked: mixed stamps at HEAD. The live-transit
  page stamps everything it loads with its own build stamp on every
  build, so a shared asset legitimately carries two stamps site-wide
  at almost all times (its page's build stamp + the site stamp). A
  plurality rule would warn on the standing convention forever; the
  guarded invariant is the founding failure — bytes moved, no stamp
  did.

Per-page app bundles (an asset referenced by one or two pages, e.g.
live-transit.js on its own page) are out of scope by design: their
stamp lives on the owning page and moves in the paired commit of the
standing two-commit push sequence, so a per-commit check on them
would fire on every legitimate build. The founding failure class is
shared assets, and shared is what is checked.

Modes: strict (default) exits 1 on any violation. --warn prints the
same findings as ::warning:: annotations and exits 0 — the warn-first
phase; promotion to a gate is dropping --warn from the CI step.

Usage: check_stamps.py [--base REF] [--warn] [--shared-min N] [--root DIR]
Stdlib only. Requires git and a checkout containing the base ref.
"""

import argparse
import re
import subprocess  # nosec B404 — list-form calls to the fixed git binary only
import sys

STAMP_REF = re.compile(r'(?:src|href)="([^"?]+)\?v=(\d{8}-\d{4})"')


def git(root, *args):
    out = subprocess.run(  # nosec B603 — no shell; argv is fixed + CI refs
        ["git", "-C", root] + list(args),
        capture_output=True,
        text=True,
        check=True,
    )
    return out.stdout


def tree_files(root, ref):
    out = git(root, "ls-tree", "-r", "--name-only", ref)
    return [line for line in out.splitlines() if line]


def blob(root, ref, path):
    try:
        return git(root, "show", f"{ref}:{path}")
    except subprocess.CalledProcessError:
        return None


def stamp_map(root, ref):
    """asset path -> {page: stamp} for one ref, from its HTML pages."""
    refs = {}
    for path in tree_files(root, ref):
        if not path.endswith(".html"):
            continue
        text = blob(root, ref, path)
        if text is None:
            continue
        for asset, stamp in STAMP_REF.findall(text):
            refs.setdefault(asset.lstrip("/"), {})[path] = stamp
    return refs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="HEAD~1")
    ap.add_argument("--warn", action="store_true")
    ap.add_argument("--shared-min", type=int, default=3)
    ap.add_argument("--root", default=".")
    args = ap.parse_args()

    base_refs = stamp_map(args.root, args.base)
    head_refs = stamp_map(args.root, "HEAD")
    base_files = set(tree_files(args.root, args.base))

    findings = []
    for asset, head_pages in sorted(head_refs.items()):
        base_pages = base_refs.get(asset, {})
        shared = len(head_pages) >= args.shared_min or (
            len(base_pages) >= args.shared_min
        )
        if not shared:
            continue
        # Changed-without-bump: bytes moved, no base page's stamp did.
        if asset not in base_files:
            continue  # not tracked at base; nothing cached under it
        if blob(args.root, args.base, asset) == blob(args.root, "HEAD", asset):
            continue  # bytes unchanged
        moved = [
            p
            for p in base_pages
            if head_pages.get(p) and head_pages[p] != base_pages[p]
        ]
        if base_pages and not moved:
            findings.append(
                f"{asset}: content changed {args.base}..HEAD with no "
                f"stamp change on any of its {len(base_pages)} "
                "referencing pages (returning visitors keep the "
                "cached asset)"
            )

    for finding in findings:
        if args.warn:
            print(f"::warning::stamp-discipline: {finding}")
        else:
            print(f"stamp-discipline VIOLATION: {finding}")
    if findings and not args.warn:
        return 1
    print(
        f"stamp-discipline: {len(findings)} finding(s), mode "
        f"{'warn' if args.warn else 'strict'}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
