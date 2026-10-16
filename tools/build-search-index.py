#!/usr/bin/env python3
"""Build search-index.json for the Find page (detroitautomationacademy.com).

Find ranks journeys, not pages: query -> (middle) -> answer page. This
script generates the index the in-browser engine runs on — the site's own
data, no external search service:

  * Page set: every URL in sitemap.xml, plus EXTRA_PAGES below for
    published pages the sitemap does not list (the sitemap is known to
    lag: /signal/relaunch/ is published but absent from it — the same
    documented defect tools/build-feed.py works around). A sitemap URL
    whose file is missing from the tree is skipped with a warning,
    never invented.
  * Per page: title, meta description, h1-h3 headings, cleaned body
    text (script, style, header, footer, and nav content excluded),
    a section label derived from the path, the page's outgoing internal
    links (kept only when they resolve to another indexed page), and
    a hub flag. A page is a hub when it is a section index (its URL is
    "/" or ends in "/") linking to at least HUB_MIN_LINKS indexed
    pages — the site's high-frequency connectors.
  * Concept nodes: the Defined Terms of the Live Transit Detroit
    installments. Each installment's "Defined terms" section is a
    table of term -> definition; this script lifts every term into a
    concept node carrying its definition, the page that defines it,
    and the other indexed pages that use the term (usedBy) — the
    onward edges a constructed path can travel. Term usage is matched
    as a stemmed multi-token phrase, with the same normalization and
    stemming rules find.js applies at query time.
  * Output: search-index.json in the repository root (the deploy
    workflow copies root *.json into the Pages deployment). Pages and
    concepts are sorted and the output carries no timestamps, so a
    rebuild on an unchanged tree is byte-identical.

Run from the repository root:  python3 tools/build-search-index.py
Re-run whenever a page is published or edited so the index, the hop
graph, and the concept nodes stay current.
"""

import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://www.detroitautomationacademy.com"
TEXT_CAP = 60000
HUB_MIN_LINKS = 4

EXTRA_PAGES = [
    "/apple-learning-coach/",
    "/live-transit-detroit/terms/",
    "/signal/relaunch/",
]

SKIP_TAGS = {"script", "style", "noscript", "header", "footer", "nav"}
HEADING_TAGS = {"h1", "h2", "h3"}


def section_for(url: str) -> str:
    if url == "/":
        return "Home"
    if url.startswith("/signal/"):
        return "The Signal"
    if url.startswith("/live-transit-detroit/"):
        return "Live Transit Detroit"
    if url.startswith("/live-transit.html"):
        return "Live Transit"
    if url.startswith("/notes/"):
        return "Notes"
    if url.startswith("/press/"):
        return "The Press"
    if url.startswith("/curriculum/"):
        return "Curriculum"
    if url.startswith("/apple-learning-coach/"):
        return "Apple Learning Coach"
    return "Site"


def file_for(url: str) -> Path:
    path = url.lstrip("/")
    if url.endswith("/"):
        path += "index.html"
    return ROOT / path


def canonical(url: str) -> str:
    """Normalize a site path: drop query/fragment, fold index.html."""
    path = urlsplit(url).path
    if path.endswith("/index.html"):
        path = path[: -len("index.html")]
    return path or "/"


def normalize_text(text: str) -> str:
    """Mirror find.js normalizeText: lowercase, words and digits only."""
    lowered = re.sub(r"[^a-z0-9\s]+", " ", text.lower())
    return " ".join(lowered.split())


def stem_word(word: str) -> str:
    """Mirror find.js stemWord exactly, so index and query time agree."""
    if len(word) > 4 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def stem_tokens(text: str) -> list[str]:
    return [stem_word(w) for w in normalize_text(text).split() if w]


def contains_phrase(haystack: list[str], needle: list[str]) -> bool:
    """True when needle occurs as a contiguous run inside haystack."""
    if not needle or len(needle) > len(haystack):
        return False
    first = needle[0]
    for i in range(len(haystack) - len(needle) + 1):
        if haystack[i] == first and haystack[i : i + len(needle)] == needle:
            return True
    return False


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title_parts: list[str] = []
        self.description = ""
        self.headings: list[str] = []
        self.text_parts: list[str] = []
        self.links: list[str] = []
        self.terms: list[dict[str, str]] = []
        self._skip_depth = 0
        self._in_title = False
        self._heading: str | None = None
        self._heading_parts: list[str] = []
        self._terms_open = False
        self._terms_level = 0
        self._row: dict[str, list[str]] | None = None
        self._cell: str | None = None

    def handle_starttag(self, tag, attrs):
        attr = dict(attrs)
        if tag in SKIP_TAGS:
            self._skip_depth += 1
        if tag == "title":
            self._in_title = True
        if tag in HEADING_TAGS and self._skip_depth == 0:
            self._heading = tag
            self._heading_parts = []
        if tag == "meta" and not self.description:
            if attr.get("name") == "description" and attr.get("content"):
                self.description = attr["content"].strip()
        if tag == "a" and attr.get("href"):
            self.links.append(attr["href"])
        if self._terms_open and tag == "tr":
            self._row = {"th": [], "td": []}
            self._cell = None
        if self._row is not None and tag in ("th", "td"):
            self._cell = tag

    def handle_endtag(self, tag):
        if tag in SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1
        if tag == "title":
            self._in_title = False
        if self._heading is not None and tag == self._heading:
            text = " ".join("".join(self._heading_parts).split())
            if text:
                self.headings.append(text)
            level = int(tag[1])
            if normalize_text(text) == "defined terms":
                self._terms_open = True
                self._terms_level = level
            elif self._terms_open and level <= self._terms_level:
                self._terms_open = False
            self._heading = None
        if self._row is not None and tag == "tr":
            term = " ".join(" ".join(self._row["th"]).split())
            definition = " ".join(" ".join(self._row["td"]).split())
            if term and definition:
                self.terms.append({"term": term, "definition": definition})
            self._row = None
            self._cell = None

    def handle_data(self, data):
        if self._in_title:
            self.title_parts.append(data)
        if self._row is not None and self._cell is not None:
            self._row[self._cell].append(data)
        if self._skip_depth > 0:
            return
        if self._heading is not None:
            self._heading_parts.append(data)
        self.text_parts.append(data)


def clean(parts: list[str]) -> str:
    return " ".join(" ".join(parts).split())


def collect_urls() -> list[str]:
    sitemap = (ROOT / "sitemap.xml").read_text(encoding="utf-8")
    urls = [canonical(u) for u in re.findall(r"<loc>([^<]+)</loc>", sitemap)]
    for extra in EXTRA_PAGES:
        if extra not in urls:
            urls.append(extra)
    return sorted(set(urls))


def build_concepts(pages: list[dict], parsers: dict[str, PageParser]) -> list[dict]:
    """Lift Defined Terms into concept nodes with their onward edges."""
    haystacks = {}
    for page in pages:
        joined = " ".join([page["title"], " ".join(page["headings"]), page["text"]])
        haystacks[page["url"]] = stem_tokens(joined)
    concepts = []
    for page in pages:
        for entry in parsers[page["url"]].terms:
            aliases = [a.strip() for a in entry["term"].split(";") if a.strip()]
            phrases = []
            for alias in aliases:
                tokens = stem_tokens(alias)
                if len(tokens) >= 2:
                    phrases.append(tokens)
            used_by = []
            for other in pages:
                if other["url"] == page["url"]:
                    continue
                stack = haystacks[other["url"]]
                if any(contains_phrase(stack, p) for p in phrases):
                    used_by.append(other["url"])
            concepts.append(
                {
                    "term": entry["term"],
                    "aliases": aliases,
                    "definition": entry["definition"],
                    "definedIn": page["url"],
                    "definedInTitle": page["title"],
                    "usedBy": sorted(used_by),
                }
            )
    concepts.sort(key=lambda c: (c["term"].lower(), c["definedIn"]))
    return concepts


def main() -> int:
    pages = []
    parsers: dict[str, PageParser] = {}
    warnings = []
    raw_links: dict[str, list[str]] = {}
    for url in collect_urls():
        path = file_for(url)
        if not path.exists():
            warnings.append(f"SKIP {url}: no file at {path.relative_to(ROOT)}")
            continue
        parser = PageParser()
        parser.feed(path.read_text(encoding="utf-8", errors="ignore"))
        parsers[url] = parser
        title = clean(parser.title_parts)
        title = re.sub(r"\s*·\s*Detroit Automation Academy\s*$", "", title)
        title = re.sub(r"\s*[—|]\s*Detroit Automation Academy\s*$", "", title)
        if not title and parser.headings:
            title = parser.headings[0]
        pages.append(
            {
                "url": url,
                "title": title.strip(),
                "description": parser.description,
                "section": section_for(url),
                "headings": parser.headings[:24],
                "text": clean(parser.text_parts)[:TEXT_CAP],
                "hub": False,
            }
        )
        resolved = []
        for href in parser.links:
            absolute = urljoin(BASE + url, href)
            if not absolute.startswith(BASE):
                continue
            target = canonical(absolute)
            if target != url and target not in resolved:
                resolved.append(target)
        raw_links[url] = resolved

    indexed = {p["url"] for p in pages}
    for page in pages:
        page["links"] = [t for t in raw_links[page["url"]] if t in indexed]
        is_index = page["url"] == "/" or page["url"].endswith("/")
        page["hub"] = is_index and len(page["links"]) >= HUB_MIN_LINKS

    concepts = build_concepts(pages, parsers)

    out = {
        "version": 2,
        "source": "tools/build-search-index.py",
        "pages": pages,
        "concepts": concepts,
    }
    target = ROOT / "search-index.json"
    target.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    for warning in warnings:
        print(f"warning: {warning}")
    sections: dict[str, int] = {}
    for page in pages:
        sections[page["section"]] = sections.get(page["section"], 0) + 1
    edges = sum(len(p["links"]) for p in pages)
    hubs = [p["url"] for p in pages if p["hub"]]
    print(
        f"search-index.json written: {len(pages)} pages, {edges} internal "
        f"links, {len(concepts)} concept nodes, {len(hubs)} hubs"
    )
    for name in sorted(sections):
        print(f"  {name}: {sections[name]}")
    print(f"  hubs: {', '.join(hubs)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
