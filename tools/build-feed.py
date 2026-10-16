#!/usr/bin/env python3
"""Build feed.xml (RSS 2.0) for detroitautomationacademy.com.

The feed is generated from the site's own canonical metadata — nothing is
hand-maintained in the feed itself:

  * Item set: every article URL in sitemap.xml under /signal/<slug>/,
    /live-transit-detroit/<slug>/, or /notes/<slug>/ (hub index pages are
    not items), plus EXTRA_URLS below for published articles that the
    sitemap does not yet list.
  * Title:       og:title, else the page's JSON-LD headline, else <title>.
  * Description: the page's meta description.
  * Date:        JSON-LD datePublished, else a "Published <date>" byline,
                 else the first full date on the page. Items with no
                 discoverable date are skipped with a warning, never
                 given an invented one.
  * Category:    derived from the URL section (The Signal / Detroit 2126 /
                 Live Transit Detroit / Notes).

Run from the repository root:  python3 tools/build-feed.py
It rewrites feed.xml in the repository root. The deploy workflow
(.github/workflows/deploy-pages.yml) copies feed.xml into the Pages
deployment. Re-run after publishing a new article so the feed picks it up.

Known source defects this script tolerates (found 2026-10-16):
  * sitemap.xml lists /live-transit-detroit/shut-down-by-the-meter/ but no
    such page exists in the repository (the piece lives under /signal/).
    The sitemap entry is skipped with a warning.
  * /signal/relaunch/ is published but absent from sitemap.xml; it is
    carried in EXTRA_URLS until the sitemap is corrected.
"""

import html
import json
import re
import sys
from datetime import datetime, time
from email.utils import format_datetime
from pathlib import Path
from zoneinfo import ZoneInfo


def escape(text: str) -> str:
    """Escape a string for XML element text (ampersand and angle brackets)."""
    return html.escape(text, quote=False)

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://www.detroitautomationacademy.com"
TZ = ZoneInfo("America/Detroit")

EXTRA_URLS = [
    f"{BASE}/signal/relaunch/",
]

ARTICLE_RE = re.compile(r"/(signal|live-transit-detroit|notes)/[^/]+/$")
MONTHS = (
    "January|February|March|April|May|June|July|August|September|October|"
    "November|December"
)
FULL_DATE_RE = re.compile(rf"\b({MONTHS}) (\d{{1,2}}), (\d{{4}})\b")
PUBLISHED_RE = re.compile(rf"[Pp]ublished\s+({MONTHS}) (\d{{1,2}}), (\d{{4}})")


def meta_content(page: str, key: str) -> str | None:
    m = re.search(
        r'<meta[^>]+(?:name|property)="' + re.escape(key) + r'"[^>]+content="([^"]*)"',
        page,
    )
    if not m:
        m = re.search(
            r'<meta[^>]+content="([^"]*)"[^>]+(?:name|property)="'
            + re.escape(key)
            + r'"',
            page,
        )
    return html.unescape(m.group(1)).strip() if m else None


def jsonld_field(page: str, field: str) -> str | None:
    # Parse the JSON-LD blocks properly so JSON string escapes (e.g. \u2014)
    # decode to real characters; fall back to a raw regex if parsing fails.
    for block in re.findall(
        r'<script[^>]+type="application/ld\+json"[^>]*>(.*?)</script>', page, re.S
    ):
        try:
            data = json.loads(block)
        except ValueError:
            continue
        nodes = data if isinstance(data, list) else [data]
        for node in nodes:
            if isinstance(node, dict):
                graphs = node.get("@graph") or [node]
                for g in graphs:
                    if isinstance(g, dict) and isinstance(g.get(field), str):
                        return html.unescape(g[field]).strip()
    m = re.search(r'"' + re.escape(field) + r'"\s*:\s*"([^"]*)"', page)
    return html.unescape(m.group(1)).strip() if m else None


TITLE_SUFFIXES = (
    "Detroit Automation Academy",
    "Live Transit Detroit",
    "The Signal",
    "Detroit 2126",
    "Notes",
)


def clean_title(title: str) -> str:
    title = title.strip()
    changed = True
    while changed:
        changed = False
        for suffix in TITLE_SUFFIXES:
            for sep in (" — ", " · ", " | "):
                if title.endswith(sep + suffix):
                    title = title[: -len(sep + suffix)].strip()
                    changed = True
    return title


def page_date(page: str) -> datetime | None:
    raw = jsonld_field(page, "datePublished")
    if raw:
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            pass
    for rx in (PUBLISHED_RE, FULL_DATE_RE):
        m = rx.search(page)
        if m:
            return datetime.strptime(
                f"{m.group(1)} {m.group(2)}, {m.group(3)}", "%B %d, %Y"
            )
    return None


def category_for(url: str) -> str:
    if "/live-transit-detroit/" in url:
        return "Live Transit Detroit"
    if "/notes/" in url:
        return "Notes"
    if "/signal/detroit-2126-" in url:
        return "Detroit 2126"
    return "The Signal"


def collect_items() -> tuple[list[dict], list[str]]:
    sitemap = (ROOT / "sitemap.xml").read_text(encoding="utf-8")
    urls = [
        u for u in re.findall(r"<loc>([^<]+)</loc>", sitemap) if ARTICLE_RE.search(u)
    ]
    for extra in EXTRA_URLS:
        if extra not in urls:
            urls.append(extra)

    items: list[dict] = []
    warnings: list[str] = []
    for url in urls:
        rel = url.split("detroitautomationacademy.com/")[1]
        path = ROOT / rel / "index.html"
        if not path.exists():
            warnings.append(f"SKIP {url}: no page file at {rel}index.html")
            continue
        page = path.read_text(encoding="utf-8", errors="ignore")
        title = (
            meta_content(page, "og:title")
            or jsonld_field(page, "headline")
            or re.search(r"<title>([^<]*)</title>", page).group(1)
        )
        title = clean_title(title)
        desc = meta_content(page, "description")
        when = page_date(page)
        if not desc:
            warnings.append(f"SKIP {url}: no meta description")
            continue
        if when is None:
            warnings.append(f"SKIP {url}: no discoverable date")
            continue
        if when.tzinfo is None:
            when = datetime.combine(when.date(), time(12, 0), TZ)
        else:
            when = when.astimezone(TZ)
        items.append(
            {
                "title": title,
                "link": url,
                "description": desc,
                "date": when,
                "category": category_for(url),
            }
        )
    items.sort(key=lambda i: (i["date"], i["title"]), reverse=True)
    return items, warnings


def render(items: list[dict]) -> str:
    newest = items[0]["date"]
    out = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
        "  <channel>",
        "    <title>Detroit Automation Academy</title>",
        f"    <link>{BASE}/</link>",
        f'    <atom:link href="{BASE}/feed.xml" rel="self"'
        ' type="application/rss+xml" />',
        "    <description>Robotics, drones, and automation training for Detroit's "
        "young builders — plus The Signal newsletter, the Live Transit Detroit "
        "series, and technical notes, as they publish.</description>",
        "    <language>en-us</language>",
        f"    <lastBuildDate>{format_datetime(newest)}</lastBuildDate>",
    ]
    for it in items:
        out += [
            "    <item>",
            f"      <title>{escape(it['title'])}</title>",
            f"      <link>{escape(it['link'])}</link>",
            f'      <guid isPermaLink="true">{escape(it["link"])}</guid>',
            f"      <pubDate>{format_datetime(it['date'])}</pubDate>",
            f"      <category>{escape(it['category'])}</category>",
            f"      <description>{escape(it['description'])}</description>",
            "    </item>",
        ]
    out += ["  </channel>", "</rss>", ""]
    return "\n".join(out)


def main() -> int:
    items, warnings = collect_items()
    for w in warnings:
        print(f"warning: {w}", file=sys.stderr)
    if not items:
        print("error: no items collected; feed.xml not written", file=sys.stderr)
        return 1
    (ROOT / "feed.xml").write_text(render(items), encoding="utf-8")
    print(
        f"feed.xml written: {len(items)} items, newest {items[0]['date'].date()} "
        f"({items[0]['title']}), oldest {items[-1]['date'].date()} "
        f"({items[-1]['title']})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
