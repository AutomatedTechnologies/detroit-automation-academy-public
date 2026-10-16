#!/usr/bin/env python3
"""Apply the RSS feed entry points to the site's pages (idempotent).

For every content page (the homepage, the section hubs, and every article
in feed.xml's item set) this inserts, when absent:

  * a feed-discovery link in <head>:
        <link rel="alternate" type="application/rss+xml"
              title="Detroit Automation Academy — RSS feed" href="/feed.xml">
  * a visible "RSS feed" line in the standard footer, immediately before
    the copyright line. The visible line points at /feed/ — the feed's
    HTML page, which renders in every browser and links the raw XML —
    while the discovery link above keeps pointing at /feed.xml, which
    is what feed readers subscribe to.

Run from the repository root:  python3 tools/apply-feed-links.py
Safe to re-run; pages already carrying either element are left unchanged.
New article pages should be run through this once at publish time (the
publish workflow's head/footer pattern carries both elements).
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

HEAD_LINK = (
    '  <link rel="alternate" type="application/rss+xml" '
    'title="Detroit Automation Academy — RSS feed" href="/feed.xml">\n'
)
FOOTER_LINE = (
    '<p class="footer-line"><a href="/feed/">RSS feed</a> — every '
    "edition and installment, as it publishes.</p>\n    "
)
FOOTER_ANCHOR = '<p class="footer-fine">'
# Simpler footer used by the Live Transit Detroit and Press pages: the RSS
# line is added as a .fine paragraph after the footer's first line.
FOOTER2_ANCHOR = "Detroit Automation Academy — Where Detroit builds what's next.</p>\n"
FOOTER2_LINE = (
    '    <p class="fine"><a href="/feed/">RSS feed</a> — every edition '
    "and installment, as it publishes.</p>\n"
)

HUBS = [
    "index.html",
    "signal/index.html",
    "live-transit-detroit/index.html",
    "notes/index.html",
    "press/index.html",
]


def article_pages() -> list[Path]:
    sitemap = (ROOT / "sitemap.xml").read_text(encoding="utf-8")
    urls = [
        u
        for u in re.findall(r"<loc>([^<]+)</loc>", sitemap)
        if re.search(r"/(signal|live-transit-detroit|notes)/[^/]+/$", u)
    ]
    urls.append("https://www.detroitautomationacademy.com/signal/relaunch/")
    pages = []
    for url in urls:
        rel = url.split("detroitautomationacademy.com/")[1]
        path = ROOT / rel / "index.html"
        if path.exists():
            pages.append(path)
    return pages


def apply(path: Path) -> tuple[bool, bool]:
    text = path.read_text(encoding="utf-8")
    head_done = "application/rss+xml" in text
    foot_done = (
        '<a href="/feed/">RSS feed</a>' in text
        or '<a href="/feed.xml">RSS feed</a>' in text
    )
    changed = False
    if not head_done and "</head>" in text:
        text = text.replace("</head>", HEAD_LINK + "</head>", 1)
        head_done = changed = True
    if not foot_done and FOOTER_ANCHOR in text:
        text = text.replace(FOOTER_ANCHOR, FOOTER_LINE + FOOTER_ANCHOR, 1)
        foot_done = changed = True
    if not foot_done and FOOTER2_ANCHOR in text:
        text = text.replace(FOOTER2_ANCHOR, FOOTER2_ANCHOR + FOOTER2_LINE, 1)
        foot_done = changed = True
    if changed:
        path.write_text(text, encoding="utf-8")
    return head_done, foot_done


def main() -> int:
    targets = [ROOT / h for h in HUBS] + article_pages()
    seen: set[Path] = set()
    no_head: list[str] = []
    no_foot: list[str] = []
    for path in targets:
        if path in seen or not path.exists():
            continue
        seen.add(path)
        head_done, foot_done = apply(path)
        rel = str(path.relative_to(ROOT))
        if not head_done:
            no_head.append(rel)
        if not foot_done:
            no_foot.append(rel)
    print(f"processed {len(seen)} pages")
    if no_head:
        print("warning: no </head> graft point: " + ", ".join(no_head), file=sys.stderr)
    if no_foot:
        print("note: no standard footer on: " + ", ".join(no_foot), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
