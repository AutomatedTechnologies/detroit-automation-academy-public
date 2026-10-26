#!/usr/bin/env python3
"""Estate conformance audit for detroitautomationacademy.com.

The standing harness from DAA Estate Uplift U6 (2026-10-20). The
one-off domain audit of 2026-10-20 found defects that had each been
recorded at least once before without a mechanism that kept them
fixed; this tool is that mechanism. It re-measures the live estate
against a versioned baseline (``estate-baseline.json`` beside this
file) and reports every drift by rule, naming the offending URLs.

Rules (the baseline file carries the data; this list is the index):
  sitemap-set      served sitemap lists exactly the baseline's
                   classified public content pages — no missing, no
                   extra (the U1 discovery constitution, enforced)
  page-status      every listed page serves HTTP 200
  build-hash       the standing build files match their recorded
                   md5s (live-transit.html/js, raptor.js,
                   voter-guide.html)
  meta-description every listed page carries a meta description of
                   at most the baseline length (160)
  single-h1        every listed page carries exactly one <h1>
  jsonld-present   every listed page carries at least one parseable
                   JSON-LD block
  social-cards     og:title/description/image and
                   twitter:card/title/description present
  stamp-uniformity shared-asset ?v= stamps match the baseline
                   (styles.css, nav.js; per-page overrides recorded)
  ad-allowlist     the ad mount appears on exactly the allowlisted
                   pages and ad-slot.js still ships ADS_ENABLED false
  console-hardened the console path matches its recorded state:
                   live (200 + noindex,nofollow meta + robots.txt
                   Disallow) or retired (404, and robots.txt does
                   not advertise the path)
  feed-twin-clean  /feed/ serves with zero Google Fonts references
                   and /feed.xml serves (U6 R5 invariant)

Baseline-recorded exceptions (each filed in the uplift record) are
applied transparently: they are printed in the report's exception
section, never silently skipped.

Fetch discipline (2026-10-20 feed-driver lesson): every fetch is a
bounded, chunked read with a per-request timeout, retried up to 3
attempts on a fresh connection; proxies come from the environment
(the VM's standing proxy) unless --proxy is given. Runtime budget:
the full estate is ~55 fetches and normally completes in under
5 minutes; the hard budget is 15 minutes, after which the run
aborts and reports the unfinished checks as fetch defects.

The tool reads production; it never writes to it. Usage:

  python3 tools/estate_audit.py [--base-url URL] [--baseline PATH]
                                [--out PATH] [--proxy URL]

Exit code: 0 = conformant (0 defects), 1 = defects found,
2 = the run itself could not complete (e.g. sitemap unreachable).
"""

import argparse
import hashlib
import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

DEFAULT_BASE = "https://www.detroitautomationacademy.com"
UA = {"User-Agent": "Mozilla/5.0 (DAA estate conformance audit; read-only)"}
TIMEOUT = 30
ATTEMPTS = 3
BUDGET_SECS = 900
CTX = ssl.create_default_context()


class Fetcher:
    """Bounded, retrying fetcher. One opener per attempt (fresh
    connection); proxies from the environment unless overridden;
    localhost targets are never proxied."""

    def __init__(self, proxy=None):
        self.proxy = proxy
        self.count = 0
        self.failures = []

    def _opener(self, url):
        host = urlparse(url).hostname or ""
        if host in ("127.0.0.1", "localhost", "::1"):
            return urllib.request.build_opener(urllib.request.ProxyHandler({}))
        if self.proxy:
            proxies = {"http": self.proxy, "https": self.proxy}
            return urllib.request.build_opener(urllib.request.ProxyHandler(proxies))
        return urllib.request.build_opener()

    def fetch(self, url):
        """Return (status, body_bytes). status None on fetch failure."""
        last_error = None
        for attempt in range(ATTEMPTS):
            if attempt:
                time.sleep(attempt)
            try:
                req = urllib.request.Request(url, headers=UA)
                opener = self._opener(url)
                with opener.open(req, timeout=TIMEOUT) as resp:
                    chunks = []
                    while True:
                        chunk = resp.read(65536)
                        if not chunk:
                            break
                        chunks.append(chunk)
                    body = b"".join(chunks)
                    declared = resp.headers.get("Content-Length")
                    if declared is not None and len(body) != int(declared):
                        raise OSError(f"short read: {len(body)} of {declared} bytes")
                    self.count += 1
                    return resp.status, body
            except urllib.error.HTTPError as e:
                self.count += 1
                return e.code, b""
            except Exception as e:  # noqa: BLE001
                last_error = f"{type(e).__name__}: {e}"
        self.failures.append(f"{url} — {last_error}")
        return None, b""


class PageParser(HTMLParser):
    """The audit fields of one page: title, meta, og/twitter sets,
    h1 count, JSON-LD blocks, asset stamps, ad mount, robots meta."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.description = None
        self.robots = None
        self.og = set()
        self.twitter = set()
        self.h1_count = 0
        self.jsonld = []
        self._in_jsonld = False
        self._jsonld_parts = []
        self.scripts = []
        self.stylesheets = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "meta":
            key = a.get("name") or a.get("property") or ""
            if key == "description":
                self.description = a.get("content", "")
            elif key == "robots":
                self.robots = a.get("content", "")
            elif key.startswith("og:"):
                self.og.add(key)
            elif key.startswith("twitter:"):
                self.twitter.add(key)
        elif tag == "link":
            rel = a.get("rel", "")
            if "stylesheet" in rel and a.get("href"):
                self.stylesheets.append(a["href"])
        elif tag == "h1":
            self.h1_count += 1
        elif tag == "script":
            if a.get("src"):
                self.scripts.append(a["src"])
            if a.get("type") == "application/ld+json":
                self._in_jsonld = True
                self._jsonld_parts = []

    def handle_endtag(self, tag):
        if tag == "script" and self._in_jsonld:
            self._in_jsonld = False
            raw = "".join(self._jsonld_parts).strip()
            try:
                json.loads(raw)
                self.jsonld.append(True)
            except ValueError:
                self.jsonld.append(False)

    def handle_data(self, data):
        if self._in_jsonld:
            self._jsonld_parts.append(data)


def parse_page(body):
    text = body.decode("utf-8", errors="replace")
    p = PageParser()
    p.feed(text)
    styles = set()
    for href in p.stylesheets:
        m = re.search(r"styles\.css\?v=([0-9A-Za-z\-]+)", href)
        if m:
            styles.add(m.group(1))
    navs = set()
    for src in p.scripts:
        m = re.search(r"nav\.js\?v=([0-9A-Za-z\-]+)", src)
        if m:
            navs.add(m.group(1))
    return {
        "text": text,
        "description": p.description,
        "robots": p.robots,
        "og": p.og,
        "twitter": p.twitter,
        "h1_count": p.h1_count,
        "jsonld_ok": any(p.jsonld),
        "jsonld_any": bool(p.jsonld),
        "styles_stamps": styles,
        "nav_stamps": navs,
        "ad_mounted": ("ad-slot.js" in text) or ("daa-ad-slot" in text),
    }


class Report:
    def __init__(self):
        self.rules = []  # (name, defects[list], notes[list])
        self.exceptions = []  # (rule, path, reason)

    def add(self, name, defects, notes=None):
        self.rules.append((name, defects, notes or []))

    @property
    def defect_count(self):
        return sum(len(d) for _, d, _ in self.rules)


def sitemap_paths(body):
    text = body.decode("utf-8", errors="replace")
    paths = []
    for loc in re.findall(r"<loc>([^<]+)</loc>", text):
        paths.append(urlparse(loc.strip()).path or "/")
    return paths


def run(base_url, baseline, fetcher, deadline):
    rep = Report()
    host = base_url.rstrip("/")
    listed = baseline["sitemap"]["listed"]
    exc = baseline.get("exceptions", {})

    def note_exceptions(rule, paths):
        for p in paths:
            reason = exc.get("reasons", {}).get(p, "baseline-recorded")
            rep.exceptions.append((rule, p, reason))

    # --- sitemap ---
    status, sm_body = fetcher.fetch(host + baseline["sitemap"]["path"])
    if status != 200 or not sm_body:
        rep.add(
            "sitemap-set",
            [f"sitemap unreachable (status {status}); run cannot proceed"],
        )
        return rep, None
    served_paths = sitemap_paths(sm_body)
    defects = []
    for p in listed:
        if p not in served_paths:
            defects.append(f"{p} missing from served sitemap")
    for p in served_paths:
        if p not in listed:
            defects.append(f"{p} served in sitemap but not in baseline")
    rep.add("sitemap-set", defects, [f"{len(served_paths)} URLs served"])

    # --- fetch every listed page once ---
    pages = {}
    for path in listed:
        if time.time() > deadline:
            rep.add(
                "page-status",
                [f"runtime budget exhausted before fetching {path}"],
            )
            break
        st, body = fetcher.fetch(host + path)
        pages[path] = (st, body)

    defects = []
    for path in listed:
        st = pages.get(path, (None, b""))[0]
        if st != 200:
            defects.append(f"{path} serves status {st}, want 200")
    for f in fetcher.failures:
        defects.append(f"fetch failed: {f}")
    rep.add("page-status", defects)

    parsed = {}
    for path, (st, body) in pages.items():
        if st == 200 and body:
            parsed[path] = parse_page(body)

    # --- build hashes ---
    defects = []
    for path, want_md5 in baseline["build"]["md5"].items():
        if path in pages:
            st, body = pages[path]
        else:
            st, body = fetcher.fetch(host + path)
        if st != 200 or not body:
            defects.append(f"{path} unreachable for hashing (status {st})")
        else:
            got = hashlib.md5(body, usedforsecurity=False).hexdigest()
            if got != want_md5:
                defects.append(f"{path} md5 {got} != baseline {want_md5}")
    rep.add("build-hash", defects)

    # --- meta descriptions ---
    max_len = baseline["rules"]["meta_description_max"]
    exempt = exc.get("meta-description", [])
    defects = []
    for path, pg in parsed.items():
        if path in exempt:
            continue
        d = pg["description"]
        if d is None:
            defects.append(f"{path} has no meta description")
        elif len(d) > max_len:
            defects.append(f"{path} description is {len(d)} chars, max {max_len}")
    rep.add("meta-description", defects)
    note_exceptions("meta-description", [p for p in exempt if p in parsed])

    # --- single h1 ---
    defects = [
        f"{path} has {pg['h1_count']} <h1> elements, want exactly 1"
        for path, pg in parsed.items()
        if pg["h1_count"] != 1
    ]
    rep.add("single-h1", defects)

    # --- JSON-LD ---
    exempt = exc.get("jsonld-present", [])
    defects = []
    for path, pg in parsed.items():
        if path in exempt:
            continue
        if not pg["jsonld_any"]:
            defects.append(f"{path} has no JSON-LD block")
        elif not pg["jsonld_ok"]:
            defects.append(f"{path} has an unparseable JSON-LD block")
    rep.add("jsonld-present", defects)
    note_exceptions("jsonld-present", [p for p in exempt if p in parsed])

    # --- social cards ---
    og_need = {"og:title", "og:description", "og:image"}
    tw_need = {"twitter:card", "twitter:title", "twitter:description"}
    og_exempt = exc.get("social-cards-og", [])
    tw_exempt = exc.get("social-cards-twitter", [])
    defects = []
    for path, pg in parsed.items():
        if path not in og_exempt:
            missing = sorted(og_need - pg["og"])
            if missing:
                defects.append(f"{path} missing {', '.join(missing)}")
        if path not in tw_exempt:
            missing = sorted(tw_need - pg["twitter"])
            if missing:
                defects.append(f"{path} missing {', '.join(missing)}")
    rep.add("social-cards", defects)
    note_exceptions(
        "social-cards (og)",
        [p for p in og_exempt if p in parsed],
    )
    note_exceptions(
        "social-cards (twitter)",
        [p for p in tw_exempt if p in parsed],
    )

    # --- stamp uniformity ---
    styles_want = baseline["stamps"]["styles_css"]
    overrides = baseline["stamps"].get("styles_css_page_overrides", {})
    nav_want = baseline["stamps"]["nav_js"]
    defects = []
    for path, pg in parsed.items():
        want = overrides.get(path, styles_want)
        for s in pg["styles_stamps"]:
            if s != want:
                defects.append(f"{path} styles.css stamp {s}, want {want}")
        for s in pg["nav_stamps"]:
            if s != nav_want:
                defects.append(f"{path} nav.js stamp {s}, want {nav_want}")
    rep.add("stamp-uniformity", defects)

    # --- ad allowlist ---
    allow = set(baseline["ads"]["mounted_pages"])
    mounted = {p for p, pg in parsed.items() if pg["ad_mounted"]}
    defects = []
    for p in sorted(allow - mounted):
        defects.append(f"{p} is allowlisted but carries no ad mount")
    for p in sorted(mounted - allow):
        defects.append(f"{p} carries an ad mount but is not allowlisted")
    st, js_body = fetcher.fetch(host + baseline["ads"]["script_path"])
    if st != 200 or not js_body:
        defects.append(f"ad-slot.js unreachable (status {st})")
    else:
        m = re.search(r"ADS_ENABLED\s*=\s*(true|false)", js_body.decode())
        want = "true" if baseline["ads"]["enabled_must_be"] else "false"
        if not m:
            defects.append("ad-slot.js: ADS_ENABLED declaration not found")
        elif m.group(1) != want:
            defects.append(f"ad-slot.js ADS_ENABLED is {m.group(1)}, want {want}")
    rep.add("ad-allowlist", defects)

    # --- console hardening ---
    defects = []
    cbase = baseline["console"]
    cpath = cbase["path"]
    st, body = fetcher.fetch(host + cpath)
    if cbase.get("retired"):
        # Retired-state expectation (baseline v2, 2026-10-25): the
        # console was retired in the 2026-10-23 security remediation;
        # the hardened state is that the path serves 404 and is not
        # advertised anywhere, robots.txt included.
        want_status = cbase.get("expect_status", 404)
        if st != want_status:
            defects.append(f"{cpath} serves status {st}, want {want_status}")
    elif st != 200 or not body:
        defects.append(f"{cpath} serves status {st}, want 200")
    else:
        robots = parse_page(body)["robots"] or ""
        tokens = {t.strip() for t in robots.lower().split(",")}
        for need in cbase["robots_meta_required"]:
            if need not in tokens:
                defects.append(f"{cpath} robots meta lacks {need}")
    st, body = fetcher.fetch(host + "/robots.txt")
    if st != 200 or not body:
        defects.append(f"robots.txt serves status {st}, want 200")
    else:
        robots_txt = body.decode("utf-8", errors="replace")
        if cbase.get("retired"):
            if f"Disallow: {cpath}" in robots_txt:
                defects.append("robots.txt advertises the retired console path")
        elif f"Disallow: {cbase['robots_txt_disallow']}" not in robots_txt:
            defects.append("robots.txt lost its console.html Disallow")
    rep.add("console-hardened", defects)

    # --- feed twin ---
    defects = []
    st, body = fetcher.fetch(host + baseline["feed"]["page"])
    if st != 200 or not body:
        defects.append(f"{baseline['feed']['page']} serves status {st}")
    else:
        text = body.decode("utf-8", errors="replace")
        for banned in baseline["feed"]["banned_refs"]:
            if banned in text:
                defects.append(f"/feed/ references {banned}")
    st, _ = fetcher.fetch(host + baseline["feed"]["xml"])
    if st != 200:
        defects.append(f"{baseline['feed']['xml']} serves status {st}")
    rep.add("feed-twin-clean", defects)

    return rep, pages


def render(rep, base_url, baseline, started, fetcher, elapsed):
    lines = [
        "DAA estate conformance report",
        f"Base: {base_url}",
        f"Baseline: estate-baseline.json v{baseline['version']} "
        f"(recorded {baseline['recorded']})",
        f"Run: {started} — {elapsed:.1f}s, {fetcher.count} fetches",
    ]
    if rep.defect_count:
        lines.append(f"Result: FAIL — {rep.defect_count} defect(s)")
    else:
        lines.append("Result: PASS — 0 defects")
    lines.append("")
    for name, defects, notes in rep.rules:
        tag = "FAIL" if defects else "PASS"
        suffix = f" ({'; '.join(notes)})" if notes else ""
        lines.append(f"[{tag}] {name}{suffix}")
        for d in defects:
            lines.append(f"  - {d}")
    if rep.exceptions:
        lines.append("")
        lines.append("Known exceptions applied (baseline-recorded):")
        for rule, path, reason in rep.exceptions:
            lines.append(f"  - {rule}: {path} — {reason}")
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--base-url", default=DEFAULT_BASE)
    ap.add_argument("--baseline", default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--proxy", default=None)
    args = ap.parse_args(argv)

    baseline_path = (
        Path(args.baseline)
        if args.baseline
        else Path(__file__).with_name("estate-baseline.json")
    )
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    fetcher = Fetcher(proxy=args.proxy)
    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    t0 = time.time()
    rep, pages = run(args.base_url, baseline, fetcher, t0 + BUDGET_SECS)
    elapsed = time.time() - t0
    text = render(rep, args.base_url, baseline, started, fetcher, elapsed)
    sys.stdout.write(text)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    if pages is None:
        return 2
    return 1 if rep.defect_count else 0


if __name__ == "__main__":
    raise SystemExit(main())
