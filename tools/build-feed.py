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
It rewrites feed.xml in the repository root and feed/index.html — a
static HTML rendering of the same items at /feed/, for browsers whose
XSLT support cannot render feed.xml through feed.xsl (current Chrome
builds among them). The deploy workflow (.github/workflows/
deploy-pages.yml) copies both into the Pages deployment. Re-run after
publishing a new article so the feed picks it up.

The feed also carries a channel <image>, declares feed.xsl (repository
root, deployed alongside it) as its browser stylesheet through an
xml-stylesheet processing instruction, and gives every item a
<content:encoded> body — the description plus links back to the article
and its section hub. Feed readers receive the raw RSS XML as before; the
stylesheet only changes how the feed renders when opened in a browser.

Template repair 2026-10-20 (DAA Estate Uplift U6, R5): render_html's
head predated the 2026-10-18 fonts self-host deploy — it linked Google
Fonts and styles.css?v=20261010-2130. The head now matches the served
estate standard: no Google Fonts references (the self-hosted @font-face
rules live in styles.css) and styles.css?v=20261031-0615. Note: the
first post-repair regeneration also refreshes item descriptions in
feed.xml and the /feed/ cards to the pages' current (U3-conformed)
meta descriptions; the item set, order, and dates are unchanged.

Template shell update 2026-10-31 (site-map redesign T2): the inline
header and footer now match the estate shell (lanes: Live Map, Cities,
Programs, Voter Guide, The Signal, Contact, Find; four footer groups),
and the nav.js / styles.css stamps move to v=20261031-0615. The {foot}
and {legal} lines are subsumed by the shared footer and no longer
rendered.

Source defects found 2026-10-16 and corrected the same day (UAT Pass 1a):
  * sitemap.xml listed /live-transit-detroit/shut-down-by-the-meter/ but no
    such page exists in the repository (the piece lives under /signal/).
    The phantom entry was removed from the sitemap; this script's skip
    guard remains as a defense.
  * /signal/relaunch/ was published but absent from sitemap.xml; the
    sitemap now lists it. It remains in EXTRA_URLS defensively (the
    generator dedupes by URL).
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


SECTION_HUBS = {
    "The Signal": "/signal/",
    "Detroit 2126": "/signal/",
    "Live Transit Detroit": "/live-transit-detroit/",
    "Notes": "/notes/",
}


def hub_url(category: str) -> str:
    """Absolute URL of the section hub a category belongs to."""
    return BASE + SECTION_HUBS.get(category, "/")


def content_html(it: dict) -> str:
    """HTML body for an item's <content:encoded>: the description plus a
    paragraph linking back to the article and to its section hub. The
    description is plain text, so it is HTML-escaped here; the assembled
    markup never contains a raw "]]>", which keeps the CDATA wrapper in
    render() safe."""
    link = it["link"]
    hub = hub_url(it["category"])
    category = html.escape(it["category"])
    description = html.escape(it["description"])
    return (
        f"<p>{description}</p>"
        f'<p><a href="{link}">Read on the site</a>'
        f' · More from <a href="{hub}">{category}</a>.</p>'
    )


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
        '<?xml-stylesheet type="text/xsl" href="/feed.xsl"?>',
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"'
        ' xmlns:content="http://purl.org/rss/1.0/modules/content/">',
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
        "    <image>",
        f"      <url>{BASE}/assets/logo.webp</url>",
        "      <title>Detroit Automation Academy</title>",
        f"      <link>{BASE}/</link>",
        "      <width>144</width>",
        "      <height>144</height>",
        "    </image>",
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
            "      <content:encoded><![CDATA["
            f"{content_html(it)}"
            "]]></content:encoded>",
            "    </item>",
        ]
    out += ["  </channel>", "</rss>", ""]
    return "\n".join(out)


FEED_URL_ENC = "https%3A%2F%2Fwww.detroitautomationacademy.com%2Ffeed.xml"

SUBSCRIBE_LINKS = [
    ("Feedly", f"https://feedly.com/i/subscription/feed/{FEED_URL_ENC}"),
    ("Inoreader", f"https://www.inoreader.com/?add_feed={FEED_URL_ENC}"),
    ("NewsBlur", f"https://newsblur.com/?url={FEED_URL_ENC}"),
]


def render_html(items: list[dict]) -> str:
    """Static HTML twin of the feed at /feed/: the same items, rendered
    with the site's own shell and styles so every browser shows the
    designed page (feed.xsl covers XSLT-capable browsers at /feed.xml
    itself). Generated, never hand-edited — re-run this script."""
    cards = []
    for it in items:
        d = it["date"]
        cards.append(
            '      <article class="feedp-card">\n'
            f'        <p class="feedp-meta"><a class="feedp-chip" '
            f'href="{SECTION_HUBS.get(it["category"], "/")}">'
            f'{html.escape(it["category"])}</a> '
            f'<time datetime="{d.date().isoformat()}">'
            f"{d.strftime('%d %b %Y')}</time></p>\n"
            f'        <h2><a href="{it["link"]}">'
            f'{html.escape(it["title"])}</a></h2>\n'
            f'        <p>{html.escape(it["description"])}</p>\n'
            f'        <p><a class="feedp-read" href="{it["link"]}">'
            "Read on the site</a></p>\n"
            "      </article>"
        )
    subs = "\n          ".join(
        f'<a class="feedp-btn" href="{url}">{name}</a>' for name, url in SUBSCRIBE_LINKS
    )
    viewport = "width=device-width, initial-scale=1.0, viewport-fit=cover"
    meta_desc = (
        "Every Signal edition, Live Transit Detroit installment, and note "
        "from the Detroit Automation Academy, as it publishes \u2014 subscribe "
        "in any feed reader, or read the latest here."
    )
    og_desc = (
        "Every edition and installment, as it publishes. Subscribe in any "
        "feed reader, or read the latest here."
    )
    lede = (
        "Every Signal edition, Live Transit Detroit installment, and "
        "note \u2014 as it publishes. Subscribe in your feed reader, or read "
        "the latest below."
    )
    feed_title = "Detroit Automation Academy \u2014 RSS feed"
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="{viewport}">
<title>RSS feed — Detroit Automation Academy</title>
<meta name="description" content="{meta_desc}">
<link rel="icon" type="image/webp" href="/assets/logo.webp">
<link rel="stylesheet" href="/styles.css?v=20261031-0615">
<link rel="canonical" href="{BASE}/feed/">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Detroit Automation Academy">
<meta property="og:title" content="RSS feed — Detroit Automation Academy">
<meta property="og:description" content="{og_desc}">
<meta property="og:url" content="{BASE}/feed/">
<meta property="og:image" content="{BASE}/assets/logo.webp">
<meta property="og:image:alt" content="Detroit Automation Academy — Forge D logo">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="RSS feed — Detroit Automation Academy">
<meta name="twitter:description" content="{og_desc}">
<meta name="twitter:image" content="{BASE}/assets/logo.webp">
<link rel="alternate" type="application/rss+xml" title="{feed_title}" href="/feed.xml">
<style>
  .feedp-hero {{ padding: 72px 0 8px; text-align: center; }}
  .feedp-sub {{
    max-width: 760px; margin: 26px auto 0; text-align: left;
    background: var(--card); border: 1px solid var(--line);
    border-radius: var(--radius); padding: 20px 22px;
  }}
  .feedp-sub h2 {{ margin-top: 0; font-size: 1.15rem; }}
  .feedp-btns {{ display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }}
  .feedp-btn {{
    font: inherit; font-weight: 600; text-decoration: none;
    background: var(--midnight-2); color: var(--paper);
    border: 1px solid var(--line); border-radius: 999px; padding: 6px 16px;
  }}
  .feedp-btn:hover {{ border-color: var(--amber); }}
  .feedp-url {{
    display: block; overflow-x: auto; white-space: nowrap;
    background: var(--midnight); border: 1px solid var(--line);
    border-radius: 8px; padding: 10px 12px; color: var(--amber);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: .92rem;
  }}
  .feedp-list {{
    max-width: 760px; margin: 34px auto 0; padding-bottom: 72px;
    display: grid; gap: 14px;
  }}
  .feedp-card {{
    background: var(--card); border: 1px solid var(--line);
    border-radius: var(--radius); padding: 20px 22px;
  }}
  .feedp-card h2 {{ margin: 8px 0; font-size: 1.3rem; }}
  .feedp-card h2 a {{ color: var(--paper); text-decoration: none; }}
  .feedp-card h2 a:hover {{ color: var(--amber); }}
  .feedp-meta {{ color: var(--concrete); margin: 0; font-size: var(--step--1); }}
  .feedp-chip {{
    color: var(--paper); text-decoration: none; font-weight: 600;
    border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px;
    margin-right: 8px;
  }}
  .feedp-chip:hover {{ border-color: var(--amber); }}
  .feedp-read {{ color: var(--amber); font-weight: 600; text-decoration: none; }}
  .feedp-read:hover {{ text-decoration: underline; }}
</style>
</head>
<body>
<a class="skip-link" href="#top">Skip to main content</a>

<div id="daa-nav"><header class="nav">
<a class="brand" href="/" aria-label="Detroit Automation Academy — home">
<img src="/assets/logo.webp" alt="" class="brand-mark"><span class="brand-word">
Detroit Automation <em>Academy</em></span></a>
<nav class="nav-links" id="daaNavLinks" aria-label="Primary">
<a class="lane" data-audience="user" href="/live-transit.html">Live Map</a>
<a class="lane" data-audience="user" href="/live-transit/">Cities</a>
<a class="lane" data-audience="visitor" href="/programs.html">Programs</a>
<a class="lane" data-audience="visitor" href="/voter-guide.html">Voter Guide</a>
<a class="lane" data-audience="reader" href="/signal/">The Signal</a>
<a class="lane" data-audience="visitor" href="/inquire.html">Contact</a>
<a class="lane" data-audience="visitor" href="/find.html">Find</a></nav> <button
class="nav-toggle" id="daaNavToggle" aria-label="Toggle navigation"
aria-expanded="false"><span></span><span></span><span></span></button></header></div>
<script src="/nav.js?v=20261031-0615"></script>

<main id="top">
  <section class="wrap feedp-hero">
    <p class="eyebrow">Detroit Automation Academy</p>
    <h1>RSS feed</h1>
    <p class="lede" style="margin-bottom:0">{lede}</p>
    <div class="feedp-sub">
      <h2>Subscribe</h2>
      <p style="margin:0">Add this feed in your reader:</p>
      <div class="feedp-btns">
          {subs}
          <a class="feedp-btn" href="/feed.xml">Open the raw feed (XML)</a>
      </div>
      <code class="feedp-url">{BASE}/feed.xml</code>
    </div>
  </section>

  <section class="wrap">
    <div class="feedp-list">
{chr(10).join(cards)}
    </div>
  </section>
</main>

<footer class="footer"> <div class="wrap footer-inner"> <div class="footer-brand">
<img src="/assets/logo.webp" alt="" class="brand-mark"> <span>
Detroit Automation Academy</span> </div> <p class="footer-fine">
Southfield, Michigan · <a href="mailto:justin@detroitautomationacademy.com">
justin@detroitautomationacademy.com</a></p>
<nav class="footer-groups" aria-label="Site"> <div class="footer-group"> <h3>Ride
</h3> <p class="footer-fine"><a href="/live-transit.html">Live Map</a> ·
<a href="/board/">Departure Board</a> · <a href="/live-transit/">Cities</a></p>
<p class="footer-fine"><a href="/live-transit.html">Detroit</a> ·
<a href="/live-transit/philadelphia/">Philadelphia</a> ·
<a href="/live-transit/cincinnati/">Cincinnati</a> ·
<a href="/live-transit/denver/">Denver</a> · <a href="/live-transit/austin/">Austin
</a> · <a href="/live-transit/sacramento/">Sacramento</a> ·
<a href="/live-transit/san-diego/">San Diego</a> ·
<a href="/live-transit/columbus/">Columbus</a></p> </div> <div class="footer-group">
 <h3>Read</h3> <p class="footer-fine"><a href="/signal/">The Signal</a> ·
<a href="/live-transit-detroit/">Live Transit Detroit stories</a> ·
<a href="/notes/">Notes</a> · <a href="/press/">The Press</a> · <a href="/feed/">
Latest</a> · <a href="/watch/">Watch</a></p> </div> <div class="footer-group"> <h3>
Learn &amp; work</h3> <p class="footer-fine"><a href="/programs.html">Programs</a>
 · <a href="/curriculum/online-safety/">Online Safety</a> ·
<a href="/voter-guide.html">Voter Guide</a> · <a href="/partners.html">Partners</a>
 · <a href="/api.html">API</a> · <a href="/inquire.html">Contact</a> ·
<a href="/apple-learning-coach/">Coach Profile</a> ·
<a href="/press/media-kit.html">Media Kit</a></p> </div> <div class="footer-group">
<h3>Trust</h3> <p class="footer-fine"><a href="/dashboard.html">Status</a> ·
<a href="/terms.html">Terms of Service</a> · <a href="/privacy.html">Privacy Policy
</a> · <a href="/live-transit/terms/">Live Transit Terms</a></p> </div> </nav>
<p class="footer-fine"><a href="/find.html">Find</a> (search) ·
<a href="mailto:justin@detroitautomationacademy.com">
justin@detroitautomationacademy.com</a></p> <p class="footer-fine">
© 2026 AutomatedTechnologies d/b/a Detroit Automation Academy</p> </div> </footer>

</body>
</html>
"""


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
    feed_dir = ROOT / "feed"
    feed_dir.mkdir(exist_ok=True)
    (feed_dir / "index.html").write_text(render_html(items), encoding="utf-8")
    print(f"feed/index.html written: {len(items)} cards")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
