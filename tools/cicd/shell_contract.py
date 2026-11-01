#!/usr/bin/env python3
"""shell_contract.py — the shell<->app mount-contract gate.

Born of the 2026-10-31 P0 S1: the T6.6 Detroit ship passed every
local gate while shipping a MONOLITH shell (monolith DOM) wired to
the MODULAR app entry. The modular app's 13 mount points were absent
from the shell, every render null-guarded into a no-op, and the page
sat on its static "connecting..." text forever — a silent dead boot
in production. No gate had ever parsed the shipped HTML against the
app's mount contract. This gate is that check.

Derivation, never hardcoded:
  * Modular app — the required mount set is parsed from the app's
    OWN modules/surfaces.mjs `SURFACE_MOUNTS` export (the list the
    module itself asserts against the shell). Each id must appear
    as id="<id>" in the shell that loads that app.
  * Monolith app — the shell's classic scripts are scanned for
    getElementById('...') / querySelector('#...') literals; ids the
    scripts create themselves (.id = '...' assignments, id="..."
    inside script string templates) are subtracted. What remains is
    the set the shell must provide. (The monolith self-builds most
    of its UI, so its shell contract is honestly smaller — that
    asymmetry is the monolith's nature, recorded in the CI/CD
    adoption record.)

Which app a shell runs is read from the shell itself: a module
<script> entry pointing at a modular app.mjs selects the modular
contract (derived from the surfaces.mjs sibling of that app);
otherwise the classic-script set selects the monolith contract.

Usage:
  shell_contract.py [--root DIR]            scan a repo tree (default: .)
  shell_contract.py --bundle DIR            scan an assembler bundle
                                            (live-transit.html +
                                             live-transit/detroit/**)
  shell_contract.py --check HTML --surfaces MJS
                                            single modular shell
  shell_contract.py --check HTML --scripts JS [JS ...]
                                            single classic shell

Exit 0 = every contract satisfied. Exit 1 = violations listed.
Stdlib only.
"""

import re
import sys
from pathlib import Path

MODULAR_CITIES_GLOB = "live-transit/*/modules/surfaces.mjs"


def parse_surface_mounts(surfaces_path):
    """Extract the SURFACE_MOUNTS id list from a surfaces.mjs file."""
    src = Path(surfaces_path).read_text(encoding="utf-8", errors="replace")
    m = re.search(r"SURFACE_MOUNTS\s*=\s*Object\.freeze\(\[(.*?)\]\)", src, re.S)
    if not m:
        return None
    body = re.sub(r"//[^\n]*", "", m.group(1))
    return re.findall(r"'([^']+)'", body)


def shell_ids(html_path):
    html = Path(html_path).read_text(encoding="utf-8", errors="replace")
    return set(re.findall(r'id="([^"]+)"', html)), html


CHECKED = []


def check_modular(html_path, surfaces_path, label):
    CHECKED.append(label)
    mounts = parse_surface_mounts(surfaces_path)
    if mounts is None:
        return [f"{label}: no SURFACE_MOUNTS export in {surfaces_path}"]
    ids, _ = shell_ids(html_path)
    missing = [i for i in mounts if i not in ids]
    if missing:
        return [
            f"{label}: shell {html_path} is missing {len(missing)}/"
            f"{len(mounts)} mount ids its app requires: " + ", ".join(missing)
        ]
    print(f"OK   {label}: {len(mounts)}/{len(mounts)} modular mounts present")
    return []


def monolith_required_ids(script_paths):
    referenced, created = set(), set()
    for p in script_paths:
        js = Path(p).read_text(encoding="utf-8", errors="replace")
        referenced |= set(re.findall(r"getElementById\(\s*['\"]([^'\"]+)['\"]", js))
        referenced |= set(
            re.findall(r"querySelector(?:All)?\(\s*['\"]#([A-Za-z0-9_-]+)", js)
        )
        created |= set(re.findall(r"\.id\s*=\s*['\"]([^'\"]+)['\"]", js))
        created |= set(re.findall(r"id=\"([^\"]+)\"", js))
        created |= set(re.findall(r"id='([^']+)'", js))
    return referenced - created


def check_monolith(html_path, script_paths, label):
    CHECKED.append(label)
    required = monolith_required_ids(script_paths)
    ids, _ = shell_ids(html_path)
    missing = sorted(i for i in required if i not in ids)
    if missing:
        return [
            f"{label}: shell {html_path} is missing {len(missing)} ids its "
            f"scripts require from the shell: " + ", ".join(missing)
        ]
    print(
        f"OK   {label}: {len(required)}/{len(required)} monolith "
        "shell-required ids present"
    )
    return []


def shell_script_srcs(html_path, base):
    """Local script files a shell loads (classic + module entries)."""
    _, html = shell_ids(html_path)
    out = []
    for src in re.findall(r'<script[^>]+src="([^"]+)"', html):
        clean = src.split("?")[0]
        p = (base / clean.lstrip("/")).resolve()
        if p.exists():
            out.append(p)
    return out


def module_entry(html_path):
    _, html = shell_ids(html_path)
    m = re.search(r'<script[^>]+type="module"[^>]+src="([^"]+)"', html)
    if not m:
        m = re.search(r'<script[^>]+src="([^"]+)"[^>]+type="module"', html)
    return m.group(1).split("?")[0] if m else None


def scan_repo(root):
    root = Path(root).resolve()
    failures = []
    # Modular city pages: live-transit/<city>/index.html vs its own surfaces.
    for surfaces in sorted(root.glob(MODULAR_CITIES_GLOB)):
        city_dir = surfaces.parent.parent
        html = city_dir / "index.html"
        if html.exists():
            failures += check_modular(html, surfaces, city_dir.name)
    # Detroit root page: contract follows the entry the shell declares.
    html = root / "live-transit.html"
    if html.exists():
        entry = module_entry(html)
        det_surfaces = root / "live-transit/detroit/modules/surfaces.mjs"
        if entry and "detroit" in entry and det_surfaces.exists():
            failures += check_modular(html, det_surfaces, "detroit (root, modular)")
        else:
            scripts = [
                p
                for p in shell_script_srcs(html, root)
                if p.suffix == ".js" and "detroit" not in str(p)
            ]
            failures += check_monolith(html, scripts, "detroit (root, monolith)")
    return failures


def scan_bundle(bundle):
    bundle = Path(bundle).resolve()
    failures = []
    html = bundle / "live-transit.html"
    surfaces = bundle / "live-transit/detroit/modules/surfaces.mjs"
    if html.exists() and surfaces.exists():
        failures += check_modular(html, surfaces, "bundle detroit (modular)")
    # Any per-city trees inside a bundle get their own contracts too.
    for s in sorted(bundle.glob("live-transit/*/modules/surfaces.mjs")):
        city_dir = s.parent.parent
        h = city_dir / "index.html"
        if h.exists():
            failures += check_modular(h, s, f"bundle {city_dir.name}")
    return failures


def main(argv):
    failures = []
    if "--bundle" in argv:
        failures = scan_bundle(argv[argv.index("--bundle") + 1])
    elif "--check" in argv:
        html = argv[argv.index("--check") + 1]
        if "--surfaces" in argv:
            failures = check_modular(html, argv[argv.index("--surfaces") + 1], "single")
        elif "--scripts" in argv:
            i = argv.index("--scripts")
            failures = check_monolith(html, argv[i + 1 :], "single")
        else:
            print(__doc__)
            return 2
    else:
        root = "."
        if "--root" in argv:
            root = argv[argv.index("--root") + 1]
        failures = scan_repo(root)
    if not CHECKED and not failures:
        print(
            "FAIL shell-contract: no shells were checked "
            "(wrong root?) — refusing a vacuous pass",
            file=sys.stderr,
        )
        return 1
    verdict = "fail" if failures else "pass"
    print(f"EVIDENCE gate=shell-contract class=bytes verdict={verdict}")
    if failures:
        print("\nSHELL CONTRACT VIOLATIONS:", file=sys.stderr)
        for f in failures:
            print(f"FAIL {f}", file=sys.stderr)
        return 1
    print("shell-contract: all contracts satisfied")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
