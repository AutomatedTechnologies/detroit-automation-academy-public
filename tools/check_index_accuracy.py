#!/usr/bin/env python3
"""The Index accuracy check — the pre-commit form of The Index posture.

The Index (the-index/) is the Academy site's index of itself: every
public surface in one place. Its posture, approved by the owner
2026-11-07 and owned by the project "The Index — Academy documentation
page", is that the page (a) exists, (b) is reachable from the home
page, (c) never links to a page that does not exist, and (d) covers
every top-level public surface of the estate. This check enforces
that posture at commit time, before inaccuracy can be published:

1. EXISTENCE — the-index/index.html exists and carries The Index
   title. (Failure class of 2026-11-06: the footer linked a page
   that was never promoted.)
2. REACHABILITY — index.html (the home page) links to /the-index/.
3. NO DEAD ENTRIES — every internal link in The Index, and every
   <loc> in sitemap.xml, resolves to a file in the tree.
4. SECTION COVERAGE — every top-level public surface is linked from
   The Index. A surface is a root *.html page or a first-level
   directory with an index.html. Redirect stubs (meta refresh) and
   noindex pages are not public surfaces. "/x.html", "/x/" and "/x"
   are the same surface. Gaps recorded in
   tools/index-coverage-baseline.json are reported as KNOWN and do
   not fail the commit; any new gap fails it. A baseline entry that
   has been fixed is reported so the baseline can shrink — the
   baseline may only ever shrink.

Exit code 0 = the posture holds (known baseline gaps aside).
Exit code 1 = itemized failures on stdout.
"""

import json
import os
import re
import sys

SITE_HOST = re.compile(r"https?://(?:www\.)?detroitautomationacademy\.com(/.*)")
NON_PAGE_DIRS = {"assets", "tools", "docs", "live-data", "cad", "branding"}


def read_text(path):
    """Read a file as UTF-8 text, replacing undecodable bytes."""
    with open(path, encoding="utf-8", errors="replace") as handle:
        return handle.read()


def resolve_href(href, base):
    """Resolve one href found in a page at URL directory base.

    Returns the site-absolute path, or None for external, fragment,
    or non-page references.
    """
    href = href.split("?")[0].split("#")[0]
    if not href or href.startswith(("mailto:", "tel:", "#")):
        return None
    if href.startswith("http"):
        match = SITE_HOST.match(href)
        return match.group(1) if match else None
    return os.path.normpath(os.path.join(base, href))


def page_exists(root, path):
    """Return True when a site-absolute path resolves to a tree file."""
    if path == "/":
        return os.path.isfile(os.path.join(root, "index.html"))
    target = os.path.join(root, path.lstrip("/"))
    if os.path.isfile(target):
        return True
    if os.path.isfile(target + ".html"):
        return True
    return os.path.isfile(os.path.join(target, "index.html"))


def is_public_html(text):
    """Return True when an HTML page is a public surface.

    Redirect stubs (meta refresh) and noindex pages are not public
    surfaces and owe no Index coverage.
    """
    if 'http-equiv="refresh"' in text:
        return False
    if re.search(r'name="robots"[^>]*noindex', text):
        return False
    return True


def top_level_surfaces(root):
    """List the estate's top-level public surfaces as URL paths."""
    surfaces = set()
    for name in sorted(os.listdir(root)):
        full = os.path.join(root, name)
        if os.path.isfile(full) and name.endswith(".html"):
            if name == "404.html":
                continue
            if is_public_html(read_text(full)):
                surfaces.add("/" + name)
        elif os.path.isdir(full) and not name.startswith("."):
            if name in NON_PAGE_DIRS:
                continue
            index = os.path.join(full, "index.html")
            if os.path.isfile(index) and is_public_html(read_text(index)):
                surfaces.add("/" + name + "/")
    return surfaces


def surface_key(path):
    """Normalize a surface path so /x.html, /x/ and /x compare equal."""
    if path in ("/", "/index.html"):
        return "/"
    return path.rstrip("/").removesuffix(".html")


def main(argv):
    """Run all Index accuracy checks; return the process exit code."""
    root = os.path.abspath(argv[1]) if len(argv) > 1 else os.getcwd()
    failures = []
    notes = []

    index_path = os.path.join(root, "the-index", "index.html")
    if not os.path.isfile(index_path):
        print("FAIL existence: the-index/index.html is missing")
        return 1
    index_text = read_text(index_path)
    if "<title>The Index" not in index_text:
        failures.append("existence: the-index/index.html lacks The Index title")

    home_path = os.path.join(root, "index.html")
    home_hrefs = re.findall(r'href="([^"]+)"', read_text(home_path))
    home_links = {resolve_href(h, "/") for h in home_hrefs}
    if "/the-index" not in {surface_key(p) for p in home_links if p}:
        failures.append("reachability: home page does not link to /the-index/")

    index_hrefs = re.findall(r'href="([^"]+)"', index_text)
    linked = {resolve_href(h, "/the-index/") for h in index_hrefs}
    linked.discard(None)

    dead = sorted(p for p in linked if not page_exists(root, p))
    for path in dead:
        failures.append("dead entry: The Index links %s, not in the tree" % path)

    sitemap_path = os.path.join(root, "sitemap.xml")
    if os.path.isfile(sitemap_path):
        locs = re.findall(r"<loc>([^<]+)</loc>", read_text(sitemap_path))
        for url in locs:
            match = SITE_HOST.match(url)
            if match and not page_exists(root, match.group(1)):
                failures.append("dead sitemap entry: %s" % url)

    baseline_path = os.path.join(root, "tools", "index-coverage-baseline.json")
    known = set()
    if os.path.isfile(baseline_path):
        with open(baseline_path, encoding="utf-8") as handle:
            known = {surface_key(p) for p in json.load(handle)["known_gaps"]}

    linked_keys = {surface_key(p) for p in linked}
    gaps = set()
    for surface in sorted(top_level_surfaces(root)):
        if surface_key(surface) not in linked_keys:
            gaps.add(surface_key(surface))
    for gap in sorted(gaps - known):
        failures.append("coverage: %s is public but not linked from The Index" % gap)
    for gap in sorted(gaps & known):
        notes.append("known gap (baseline): %s" % gap)
    for fixed in sorted(known - gaps):
        notes.append("baseline entry now covered, shrink baseline: %s" % fixed)

    for note in notes:
        print("NOTE " + note)
    if failures:
        for failure in failures:
            print("FAIL " + failure)
        print("index accuracy: %d failure(s)" % len(failures))
        return 1
    print(
        "index accuracy: PASS (%d surfaces, %d links checked, %d known gap(s))"
        % (len(top_level_surfaces(root)), len(linked), len(gaps & known))
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
