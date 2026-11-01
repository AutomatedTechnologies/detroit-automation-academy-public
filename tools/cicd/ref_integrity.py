#!/usr/bin/env python3
"""ref_integrity.py — per-city referential integrity gate.

For every city tree (live-transit/<city>/, plus Detroit's modular
tree at live-transit/detroit/ against the root shell):

  1. Every path in the city's build-manifest bundleFiles exists
     on disk (the manifest must not reference phantom files).
  2. The ES-module import graph reachable from the shell's module
     entry resolves: every relative import / dynamic-import target
     in every reachable .mjs/.js file exists. A single unresolved
     import kills the whole module graph in a real browser — this
     is the static half of the boot contract.
  3. The shell's local static references resolve: <script src>,
     <link href>, and importmap targets that are relative paths
     exist on disk (query strings stripped).

Bare specifiers (e.g. "three") are resolved through the shell's
importmap; unresolvable bare specifiers are failures. CDN /
absolute-URL references are out of scope (reported as notes).

Usage: ref_integrity.py [--root DIR]
Exit 0 = all references resolve. Stdlib only.
"""

import json
import re
import sys
from pathlib import Path

STATIC_IMPORT_RE = re.compile(
    r"""(?m)^\s*import\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]"""
)
EXPORT_FROM_RE = re.compile(r"""(?m)^\s*export\s+[^'";]+?\s+from\s*['"]([^'"]+)['"]""")
DYNAMIC_IMPORT_RE = re.compile(r"""import\s*\(\s*['"]([^'"]+)['"]\s*\)""")
# A real module specifier never contains whitespace or parentheses.
SPEC_SHAPE_RE = re.compile(r"^[A-Za-z0-9_@./:%+\-]+$")


def plausible_spec(spec):
    return bool(SPEC_SHAPE_RE.match(spec)) and len(spec) < 300


def resolve_spec(spec, from_file, tree_root, importmap, page_dir=None):
    """Return (ok, note). spec: raw import specifier."""
    spec = spec.split("?")[0].split("#")[0]
    if spec.startswith(("http://", "https://", "//")):
        return True, "external"
    if spec.startswith("/"):
        target = (tree_root / spec.lstrip("/")).resolve()
        return target.exists(), str(target)
    if spec.startswith("."):
        base = page_dir if page_dir is not None else from_file.parent
        target = (base / spec).resolve()
        return target.exists(), str(target)
    # Bare specifier: try the importmap (exact or prefix match).
    imports = importmap.get("imports", {}) if importmap else {}
    if spec in imports:
        return resolve_spec(imports[spec], from_file, tree_root, importmap, page_dir)
    for key, val in imports.items():
        if key.endswith("/") and spec.startswith(key):
            return resolve_spec(
                val + spec[len(key) :], from_file, tree_root, importmap, page_dir
            )
    return False, f"bare specifier {spec!r} not in importmap"


def parse_importmap(html):
    m = re.search(r'<script[^>]+type="importmap"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        return {}
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return {}


def module_graph(entry, tree_root, importmap, page_dir):
    """Walk relative imports from entry; return list of failures."""
    failures, seen, stack = [], set(), [entry]
    while stack:
        f = stack.pop()
        if f in seen or not f.exists():
            continue
        seen.add(f)
        src = f.read_text(encoding="utf-8", errors="replace")
        specs = (
            set(STATIC_IMPORT_RE.findall(src))
            | set(EXPORT_FROM_RE.findall(src))
            | set(DYNAMIC_IMPORT_RE.findall(src))
        )
        for spec in specs:
            if not plausible_spec(spec):
                continue
            if spec.startswith(("http://", "https://")):
                continue
            if spec.startswith("."):
                target = (f.parent / spec.split("?")[0]).resolve()
                if not target.exists():
                    failures.append(f"{f}: unresolved import {spec!r}")
                elif target.suffix in (".mjs", ".js"):
                    stack.append(target)
            else:
                ok, note = resolve_spec(spec, f, tree_root, importmap, page_dir)
                if not ok:
                    failures.append(f"{f}: {note}")
    return failures


def shell_refs(html_path, tree_root):
    html = html_path.read_text(encoding="utf-8", errors="replace")
    failures = []
    refs = re.findall(r'<script[^>]+src="([^"]+)"', html)
    refs += re.findall(r'<link[^>]+href="([^"]+)"', html)
    for ref in refs:
        if ref.startswith(("http://", "https://", "//", "data:", "#")):
            continue
        clean = ref.split("?")[0].split("#")[0]
        if not clean:
            continue
        if clean.startswith("/"):
            target = tree_root / clean.lstrip("/")
        else:
            target = (html_path.parent / clean).resolve()
        if not target.exists():
            failures.append(f"{html_path}: missing referenced file {ref!r}")
    return failures, parse_importmap(html)


def check_city(root, city_dir, html_path, label):
    failures = []
    manifest = city_dir / "build-manifest.json"
    if not manifest.exists() and city_dir.name == "detroit":
        manifest = root / "build-manifest.json"
    if manifest.exists():
        m = json.loads(manifest.read_text(encoding="utf-8"))
        base = manifest.parent
        for rel in m.get("bundleFiles", {}):
            if not (base / rel).exists():
                failures.append(f"{label}: manifest file missing on disk: {rel}")
    ref_failures, importmap = shell_refs(html_path, root)
    failures += ref_failures
    html = html_path.read_text(encoding="utf-8", errors="replace")
    m = re.search(r'<script[^>]+type="module"[^>]+src="([^"]+)"', html)
    if m:
        entry_ref = m.group(1).split("?")[0]
        if entry_ref.startswith("/"):
            entry = root / entry_ref.lstrip("/")
        else:
            entry = (html_path.parent / entry_ref).resolve()
        if entry.exists():
            failures += module_graph(entry, root, importmap, html_path.parent)
        else:
            failures.append(f"{label}: module entry missing: {entry_ref}")
    print(
        f"OK   {label}: all references resolve"
        if not failures
        else f"FAIL {label}: {len(failures)} unresolved references"
    )
    return failures


def main(argv):
    root = Path(".")
    if "--root" in argv:
        root = Path(argv[argv.index("--root") + 1])
    root = root.resolve()
    failures, covered = [], 0
    for city_dir in sorted((root / "live-transit").glob("*/")):
        html = city_dir / "index.html"
        if html.exists() and (city_dir / "modules").exists():
            covered += 1
            failures += check_city(root, city_dir, html, city_dir.name)
    det_html = root / "live-transit.html"
    det_dir = root / "live-transit" / "detroit"
    if det_html.exists() and det_dir.exists():
        covered += 1
        failures += check_city(root, det_dir, det_html, "detroit (root)")
    if covered == 0:
        print("FAIL ref-integrity: no city trees found", file=sys.stderr)
        return 1
    verdict = "fail" if failures else "pass"
    print(f"EVIDENCE gate=ref-integrity class=bytes verdict={verdict}")
    if failures:
        print("\nREFERENTIAL INTEGRITY VIOLATIONS:", file=sys.stderr)
        for f in failures:
            print(f"FAIL {f}", file=sys.stderr)
        return 1
    print("ref-integrity: all references resolve")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
