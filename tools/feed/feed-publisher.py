#!/usr/bin/env python3
"""Project 30 keyless feed publisher (VM side).

Split design (2026-10-19): the API keys never leave GitHub Actions.
The Actions-side feed-collect workflow performs only the keyed source
fetches and commits raw payloads (feed-raw-bundle/v1) to the site
repo's feed-raw orphan branch. This publisher is the keyless half:

  - polls the feed-raw branch for new bundles,
  - verifies every payload's sha256 against the bundle manifest,
  - runs the production builder (fetched fresh from main each cycle)
    in FEED_REPLAY_DIR mode against an out dir seeded from the main
    tip, so generated_at anchors to the payloads' collect instant and
    the outputs are the builder's own bytes,
  - commits the finished feed files to main as ONE commit through the
    Git Data API (mirror semantics incl. deletions), and keeps at most
    one Pages deploy outstanding,
  - dispatches feed-collect when the newest bundle ages past the
    cadence threshold (the dispatch driver backstops this if the
    publisher itself dies; live-feed.yml backstops the whole chain).

It makes ZERO source calls — the builder in replay mode performs no
network fetches at all (proven by the split harness).

Mode is read from feed-publisher-mode.json next to this file:
{"mode": "shadow"} computes and compares without committing;
{"mode": "live"} commits and dispatches deploys.

Run pattern mirrors the feed driver: systemd timer, --once per tick,
state in feed-publisher-state.json, egress via the local forwarder.

Resilience (2026-10-26, feed-resilience-2026-10-26.md D2/D4): the
2026-10-26 rate-limit incident had this publisher retrying the same
bundle every minute, re-running the full ~110-call read+build path
and failing at the same upload, because a 403 was indistinguishable
from any other error. Now a rate-limit refusal raises RateLimitPark:
the publisher records parked_until (window reset + jitter) in its
state file, logs the park, and makes ZERO API calls while parked —
the park is checked before the first API call of the cycle. Two
caches cut the steady appetite without touching semantics: the tip
seed (feed files + builder) is served per-file from a persistent
seed store under work/tip-cache, each file verified against the
recursive tree map (still fetched every publish cycle and still
the only authority for the diff) — see the Tipseed paragraph
below; the whole-tip-SHA keying this paragraph originally
described was replaced the same day — and bundle downloads are
cached by bundle commit SHA (bundles are immutable per commit;
the manifest sha256 verification still runs locally on every
use).

Retry (2026-10-26 follow-on, resilience doc §7 — the audit the
doc recommended for this publisher): api() had no per-call
retry, so one stalled call (a socket read past the 60 s timeout
through the forwarder) killed the whole cycle — the failure the
PHL publisher died on at 2026-10-26T11:06:15Z. api() now retries
a transient transport failure (timeout, connection reset,
proxy-path 5xx) exactly once, on a fresh connection after a
short jittered backoff. A rate-limit refusal is never retried
(RateLimitPark propagates on first sight; the park owns it) and
neither is any other 4xx. If both attempts fail transiently, the
first failure surfaces in this function's existing contract —
the original (status, payload) for an HTTP failure, the original
exception for a transport failure — so the cycle dies on the
original error before any commit is made.

Treebatch (2026-10-26 structural tranche, resilience doc §9):
commit_to_main used to spend one blob POST per changed file
(~50 per publish). Changed files now ride as inline `content`
entries on chunked Create Tree calls (base_tree-chained; one
commit; the ref moves once, at the end). Inline content is only
safe for strict UTF-8 text — the API silently ignores an
`encoding` field on tree entries (measured 2026-10-26) — so a
non-UTF-8 or empty file still goes through the legacy blob
POST. Before the commit is created, the built tree is read
back and every managed path (the tip feed set with this
publish's changes and deletions applied) must hash to its
expected git blob SHA, or the cycle dies with the ref unmoved.
Companion cut in the same tranche: get_blob is backed by a
content-addressed cache (work/blob-cache/<sha>) — a git blob's
bytes are immutable for its SHA, the cache verifies the SHA on
every read, and a mismatch re-downloads. The D4 tip-seed cache
was keyed by the main tip SHA, so any main commit (Philadelphia
publishes to the same repo every few minutes) forced a ~54-blob
re-seed. The expectation recorded at the time — that the blob
cache underneath would make a re-seed cost ~0 GETs once warm —
proved wrong live (§9): the published outputs are uploaded as
inline tree content and never pass through get_blob, so their
blobs are never in the cache, and the tip key moved on nearly
every cycle anyway. Measured result: ~50 seed GETs per publish
survived the tranche. The tree map remains the only authority
for what the tip carries.

Tipseed (2026-10-26 final lever, resilience doc §10): the tip
seed is now a per-file question. seed_from_tip checks the
persistent seed store's copy of each seed file against the
fresh recursive tree map's blob SHA for that path and downloads
only the files that miss — missing, stale, or corrupt (a SHA
mismatch is a re-download; the stored bytes are never used
unverified). refresh_seed_from_out stores each successful
publish's output files in the store, so the next cycle seeds
the bytes it just published instead of fetching them back.
The tree map remains the only authority; the store is an
optimization only, never a source of truth. A steady-state
publish drops from ~66 API calls to ~16.

Carryforward (2026-10-28, SOP finding GF-1): a fresh bulletin
set rides in exactly one bundle — the hourly fresh-fetch bundle
carries the payloads; every later bundle is reuse-only. If that
one cycle's commit does not land, the tip keeps the prior
generation and every reuse replay re-emits it verbatim, so
alerts.json strands until the next hourly fetch (measured
2026-10-28: generations landing ~114 min apart; served still
on the 18:30:34Z generation while collect's freshest fetch was
20:22:24Z). This publisher now retains the last fresh bulletin
set it built (work/bulletin-carry.json) and, on any cycle whose
manifest still names that fetch as collect's freshest while the
built output is older, writes the retained set into the out dir
so the cycle's commit carries it forward — a lost publish
becomes a one-cycle delay. The carried body keeps its original
generated_at and sources verbatim (no freshness forgery);
alerts whose own active_period.end has passed are dropped at
carry time; a newer fetch replaces the retained set atomically
(the carry joins on fetched_at equality with the manifest).
See bulletin_carry_forward below.

Shadowed-fresh recovery (2026-10-31): the carry assumes this
publisher processes the fresh bundle and only its publish can
be lost. Measured 2026-10-31: a second collect run — the
publisher's bundle-age dispatch, the driver's served-age
dispatch, and the */15 schedule floor can all fire inside the
same minute — reads the fresh bundle as its own previous
bundle and lands a reuse bundle ~16 s after it, inside this
publisher's 1-minute poll. The fresh bundle is therefore never
the tip when polled and is never processed at all; four
consecutive hourly sets stranded (fetched 04:16:21Z,
05:14:21Z, 06:10:27Z, 07:06:17Z) while served alerts froze at
the 03:20:22Z generation for ~4 h. When a reuse bundle's
fetched_at has never been built (neither the tip's alerts nor
the carry file carries it), recover_shadowed_fresh walks the
bundle's ancestry to the fresh bundle that made that fetch
and merges its bulletin payloads into the current bundle for
the replay: vehicles/QLINE/SMART still build from the current
bundle, and the GF-1 carry retains the recovered set from
that cycle on. The builder's writeIfChanged treats a
stamp-only difference as no change, so when the recovered set
already reached the tip under a recovering bundle's stamp the
truthful stamp is never re-landed — stamp equality can never
prove the set was built. The recovery therefore records a
content-hash marker (work/bulletin-recovered.json) and stands
down while the tip's alerts hash to the recovered set; a lost
publish fails the hash check and the recovery fires again.
See recover_shadowed_fresh below.
"""

import base64
import hashlib
import http.client
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

# Actions port (2026-11-12, LTD VM removal): on the VM, auth comes
# from the connector surrogate; in GitHub Actions the job's
# GITHUB_TOKEN arrives as the GH_TOKEN env var and is used directly
# (see _api_once). No credential is stored in this file or the repo
# in either world.
try:
    sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
    from dynamic_credentials import add_surrogate_to_request  # noqa: E402
except ImportError:  # GitHub Actions runner: no surrogate present
    add_surrogate_to_request = None

REPO = "AutomatedTechnologies/detroit-automation-academy-public"
# Data-plane split (2026-11-10, Forge Line record): the same managed
# feed set is mirrored every live cycle into this tiny Pages-served
# repo under the same live-data/ paths, so rider pages fetch live
# data from a repo whose Pages deploy carries a few hundred KB —
# never the estate site's full deploy queue. The site repo remains
# the archive and the pages' fallback source. See mirror_to_data_repo.
DATA_REPO = "AutomatedTechnologies/detroit-live-data"
API = "https://api.github.com"
ALLOWED = ["api.github.com"]
HERE = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(HERE, "feed-publisher-state.json")
MODE_PATH = os.path.join(HERE, "feed-publisher-mode.json")
NODE = os.environ.get("FEED_NODE", "/usr/bin/node")  # Actions port: setup-node path differs

FEED_FILES = [
    "vehicles.json",
    "alerts.json",
    "smart-display.json",
    "smart-trip-updates.json",
    "trip-updates.json",
    # FULL INTEGRATION (2026-11-11): static extracts the builder joins
    # against (seeded in, committed out) + its accuracy outputs.
    "smart-headsigns.json",
    "smart-schedule-extract.json",
    "ddot-patterns.json",
    # ER-FIX-FEED-01 (2026-11-13): GTFS-derived route metadata
    # (routes.txt names + calendar/trip windows) the builder reads
    # for routes_dark and the SMART destination fallback.
    "route-meta.json",
    "adherence.json",
    "track-state.json",
]
FEED_PREFIX = "live-data/"
BUNDLE_DIRNAME = "raw-feed/current"

COLLECT_STALE_SEC = 180  # dispatch collect when newest bundle is older
COLLECT_MIN_INTERVAL_SEC = 180
API_WORKERS = 8  # parallel blob transfers; sequential was ~2x slower
DEPLOY_WORKFLOW = "deploy-pages.yml"
COLLECT_WORKFLOW = "feed-collect.yml"

# Resilience (2026-10-26): rate-limit park + caches (see docstring).
PARK_JITTER_SEC = (30, 180)
PARK_FALLBACK_SEC = 900
WORK_DIR = os.path.join(HERE, "work")
TIP_CACHE_DIR = os.path.join(WORK_DIR, "tip-cache")
BUNDLE_CACHE_ROOT = os.path.join(WORK_DIR, "bundle-cache")


class RateLimitPark(Exception):
    """A GitHub rate-limit refusal. Carries the window reset epoch."""

    def __init__(self, reset_epoch):
        super().__init__(f"rate limited; window resets at {reset_epoch}")
        self.reset_epoch = reset_epoch


def rate_limit_reset(code, headers, payload):
    """Reset epoch if this response is a rate-limit refusal, else
    None. A plain 403 is not a park signal."""
    if code not in (403, 429):
        return None
    msg = ""
    if isinstance(payload, dict):
        msg = str(payload.get("message") or "").lower()
    named = "rate limit" in msg or "secondary rate" in msg
    exhausted = str(headers.get("x-ratelimit-remaining", "")).strip() == "0"
    if not (named or exhausted):
        return None
    reset = headers.get("x-ratelimit-reset")
    if reset:
        try:
            return float(reset)
        except (TypeError, ValueError):
            pass
    retry_after = headers.get("retry-after")
    if retry_after:
        try:
            return time.time() + float(retry_after)
        except (TypeError, ValueError):
            pass
    return time.time() + PARK_FALLBACK_SEC


def now_s():
    return time.time()


def iso_of(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%S.000Z"
    )


def log(msg):
    print(f"[publisher {iso_of(now_s())}] {msg}", flush=True)


# Bounded per-call retry (2026-10-26 follow-on; see docstring).
API_MAX_ATTEMPTS = 2
RETRY_BACKOFF_SEC = (2.0, 5.0)
RETRYABLE_HTTP_CODES = (500, 502, 503, 504)


class _RetryableCall(Exception):
    """One attempt failed transiently. Exactly one of `surface_exc`
    (re-raised) or `surface_ret` (returned) is set, mirroring how
    api() surfaces that failure today: HTTP failures return a
    (status, payload) pair for the caller to judge; transport
    failures raise. The FIRST failure is what surfaces when every
    attempt fails, so an exhausted retry dies on the original
    error."""

    def __init__(self, surface_exc=None, surface_ret=None):
        super().__init__(str(surface_exc or surface_ret))
        self.surface_exc = surface_exc
        self.surface_ret = surface_ret


def _api_once(method, path, body):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        API + path,
        data=data,
        method=method,
        headers={
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
        },
    )
    gh_token = os.environ.get("GH_TOKEN")
    if gh_token:
        req.add_header("Authorization", f"Bearer {gh_token}")
    elif add_surrogate_to_request is not None:
        add_surrogate_to_request(req, "custom.github", allowed_hosts=ALLOWED)
    else:
        raise RuntimeError("no GitHub credential available (GH_TOKEN unset, no surrogate)")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        headers = (
            {k.lower(): v for k, v in e.headers.items()} if e.headers else {}
        )
        raw = e.read()
        try:
            payload = json.loads(raw) if raw else {}
        except ValueError:
            payload = {"raw": raw[:400].decode("utf-8", "replace")}
        reset = rate_limit_reset(e.code, headers, payload)
        if reset is not None:
            raise RateLimitPark(reset)
        if e.code in RETRYABLE_HTTP_CODES:
            raise _RetryableCall(surface_ret=(e.code, payload)) from e
        return e.code, payload
    except (OSError, http.client.HTTPException) as e:
        # Transport failure: a stalled socket read (TimeoutError),
        # connection reset/refused, a proxy disconnect. HTTPError
        # is an OSError subclass but is handled above, so anything
        # reaching here never got an HTTP response to judge.
        raise _RetryableCall(surface_exc=e) from e


# Treebatch measurement (2026-10-26): real HTTP attempts made
# through api() since the counter was last reset (a retry is a
# real call and counts). main() resets it per cycle;
# process_bundle reports the publish-path delta on its log line.
API_CALL_COUNT = {"n": 0}


def api(method, path, body=None):
    first = None
    for attempt in range(API_MAX_ATTEMPTS):
        API_CALL_COUNT["n"] += 1
        try:
            return _api_once(method, path, body)
        except _RetryableCall as retryable:
            if first is None:
                first = retryable
            if attempt + 1 < API_MAX_ATTEMPTS:
                # urlopen opens a fresh connection per call, so
                # the next attempt is a fresh connection.
                time.sleep(random.uniform(*RETRY_BACKOFF_SEC))
    if first.surface_ret is not None:
        return first.surface_ret
    raise first.surface_exc


def git_blob_sha(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state):
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_PATH)


def load_mode():
    try:
        with open(MODE_PATH) as f:
            return json.load(f).get("mode", "shadow")
    except (OSError, ValueError):
        return "shadow"


def ref_sha(branch, repo=REPO):
    st, d = api("GET", f"/repos/{repo}/git/ref/heads/{branch}")
    if st != 200:
        return None
    return d["object"]["sha"]


def tree_map(commit_sha, repo=REPO):
    """(path -> blob sha for every blob, tree sha) for a commit."""
    st, commit = api("GET", f"/repos/{repo}/git/commits/{commit_sha}")
    if st != 200:
        raise RuntimeError(f"commit {commit_sha}: HTTP {st}")
    st, tree = api(
        "GET", f"/repos/{repo}/git/trees/{commit['tree']['sha']}?recursive=1"
    )
    if st != 200:
        raise RuntimeError(f"tree: HTTP {st}")
    if tree.get("truncated"):
        raise RuntimeError("tree truncated; cannot mirror safely")
    paths = {e["path"]: e["sha"] for e in tree["tree"] if e["type"] == "blob"}
    return paths, commit["tree"]["sha"]


def get_blob(sha):
    # Treebatch companion (2026-10-26): content-addressed cache.
    # A blob's bytes are immutable for its SHA; a cached entry is
    # used only after its git blob SHA verifies, and any mismatch
    # falls through to the download. Cache failures never fail
    # the cycle — they just cost the GET they were saving.
    cache_path = os.path.join(WORK_DIR, "blob-cache", sha)
    try:
        with open(cache_path, "rb") as f:
            data = f.read()
        if git_blob_sha(data) == sha:
            return data
    except OSError:
        pass
    st, d = api("GET", f"/repos/{REPO}/git/blobs/{sha}")
    if st != 200:
        raise RuntimeError(f"blob {sha}: HTTP {st}")
    data = base64.b64decode(d["content"])
    try:
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        tmp = cache_path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, cache_path)
        entries = os.listdir(os.path.dirname(cache_path))
        if len(entries) > 4000:  # light hygiene, oldest first
            dirpath = os.path.dirname(cache_path)
            entries.sort(
                key=lambda n: os.path.getmtime(os.path.join(dirpath, n)))
            for old in entries[: len(entries) - 4000]:
                os.unlink(os.path.join(dirpath, old))
    except OSError:
        pass  # caching must never fail the cycle
    return data


def workflow_runs(workflow, per_page=10):
    st, d = api(
        "GET",
        f"/repos/{REPO}/actions/workflows/{workflow}/runs?per_page={per_page}",
    )
    if st != 200:
        raise RuntimeError(f"runs {workflow}: HTTP {st}")
    return d.get("workflow_runs", [])


def dispatch(workflow):
    body = {"ref": "main"}
    # Actions port: feed_only=true tells deploy-pages.yml to verify
    # the tip diff itself and take the data-only fast path (the same
    # path a data-only push takes), instead of the full-gates +
    # boot-smoke path every workflow_dispatch otherwise forces.
    if workflow == DEPLOY_WORKFLOW and os.environ.get("FEED_PUBLISHER_FEED_ONLY_DEPLOY") == "1":
        body["inputs"] = {"feed_only": "true"}
    st, d = api(
        "POST",
        f"/repos/{REPO}/actions/workflows/{workflow}/dispatches",
        body,
    )
    if st not in (201, 204):
        raise RuntimeError(f"dispatch {workflow}: HTTP {st} {d}")


def runs_active(runs):
    return [r for r in runs if r["status"] in ("queued", "in_progress")]


# ---------------------------------------------------------------- bundle

def fetch_bundle(bundle_commit):
    """Download raw-feed/current/ into a temp dir; return (dir, manifest)
    with every manifest payload's sha256 verified. Raises on any
    incompleteness — a partial bundle is never published.

    Resilience (2026-10-26): downloads land in a per-commit cache
    (work/bundle-cache/<sha>/, marker file written last). A bundle
    commit is immutable, so a complete cache entry is reused with
    zero blob GETs; every cached file's git blob SHA is checked
    against the tree map (fetched fresh above) and the manifest
    sha256 verification below still runs on every use. A torn or
    mismatched cache is wiped and downloaded once more."""
    paths, _tree = tree_map(bundle_commit)
    prefix = BUNDLE_DIRNAME + "/"
    wanted = {p: s for p, s in paths.items() if p.startswith(prefix)}
    if prefix + "bundle.json" not in wanted:
        raise RuntimeError("bundle.json missing (bootstrap or partial push)")
    items = sorted(wanted.items())
    tmp = os.path.join(BUNDLE_CACHE_ROOT, bundle_commit)
    marker = os.path.join(tmp, ".complete")
    cache_ok = os.path.exists(marker)
    if cache_ok:
        for path, sha in items:
            dest = os.path.join(tmp, path[len(prefix):])
            try:
                with open(dest, "rb") as f:
                    data = f.read()
            except OSError:
                cache_ok = False
                break
            if git_blob_sha(data) != sha:
                cache_ok = False
                break
    if not cache_ok:
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(tmp, exist_ok=True)
        with ThreadPoolExecutor(max_workers=API_WORKERS) as pool:
            blobs = list(pool.map(get_blob, [sha for _p, sha in items]))
        for (path, _sha), data in zip(items, blobs):
            dest = os.path.join(tmp, path[len(prefix):])
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as f:
                f.write(data)
        with open(marker, "w") as f:
            f.write("ok\n")
        # Keep only the two newest bundle caches on disk.
        try:
            dirs = sorted(
                (os.path.join(BUNDLE_CACHE_ROOT, d)
                 for d in os.listdir(BUNDLE_CACHE_ROOT)),
                key=os.path.getmtime, reverse=True)
            for old in dirs[2:]:
                if old != tmp:
                    shutil.rmtree(old, ignore_errors=True)
        except OSError:
            pass  # cache hygiene must never fail the cycle
    manifest = None
    with open(os.path.join(tmp, "bundle.json"), "rb") as f:
        manifest = json.loads(f.read())
    if not manifest or manifest.get("kind") != "feed-raw-bundle/v1":
        raise RuntimeError("manifest kind mismatch")
    if not manifest.get("collected_at"):
        raise RuntimeError("manifest collected_at null (bootstrap bundle)")

    def verify(entry):
        if not entry or not entry.get("file"):
            return
        with open(os.path.join(tmp, entry["file"]), "rb") as f:
            data = f.read()
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise RuntimeError(f"payload {entry['file']} failed sha256 check")
        if len(data) != entry["bytes"]:
            raise RuntimeError(f"payload {entry['file']} size mismatch")

    ddot = manifest.get("ddot", {})
    for b in ddot.get("vehicle_batches", []):
        verify(b)
    for e in (ddot.get("bulletins", {}).get("routes") or {}).values():
        verify(e)
    verify(manifest.get("qline"))
    verify((manifest.get("smart") or {}).get("vp"))
    verify((manifest.get("smart") or {}).get("tu"))
    return tmp, manifest


# ---------------------------------------------------------------- build

def _seed_store_path(repo_path):
    return os.path.join(TIP_CACHE_DIR, "files", repo_path)


def _seed_read(repo_path, sha):
    """The seed store's bytes for repo_path — but only when they
    hash to the tree map's blob SHA for that path, else None.
    The tree map is the only authority: a stale or corrupt
    stored copy is a miss, never a source."""
    try:
        with open(_seed_store_path(repo_path), "rb") as f:
            data = f.read()
    except OSError:
        return None
    return data if git_blob_sha(data) == sha else None


def _seed_store(repo_path, data):
    """Best-effort per-file write to the seed store (atomic
    tmp+replace). Failures are swallowed: a torn or missing
    entry is just a miss next cycle, caught by the SHA check."""
    try:
        dest = _seed_store_path(repo_path)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        tmp = dest + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, dest)
    except OSError:
        pass  # the seed store must never fail the cycle


def refresh_seed_from_out(out_dir):
    """Store a just-published out dir's feed files in the seed
    store. After a successful publish the out dir IS the new
    tip's feed set, and those bytes exist nowhere else locally —
    they were uploaded as inline tree content and never passed
    through get_blob — so without this the next cycle would
    re-download every file the builder changed. Stored files
    are still verified per-file against the fresh tree map
    when they are used as seed, so a store written ahead of a
    failed commit costs at most a re-download, never a wrong
    byte."""
    for root, _dirs, files in os.walk(out_dir):
        for name in files:
            if name == "build-feed.mjs":
                continue
            full = os.path.join(root, name)
            rel = os.path.relpath(full, out_dir).replace(os.sep, "/")
            try:
                with open(full, "rb") as f:
                    data = f.read()
            except OSError:
                continue
            _seed_store(FEED_PREFIX + rel, data)


def seed_from_tip(tip_sha):
    """Seed the out dir from main's tip feed files.
    Returns (out_dir, tree_sha, tip_feed_map, builder_path).

    Tipseed (2026-10-26, resilience doc §10): the seed is a
    per-file question, not a whole-tip one. The recursive tree
    map is fetched fresh on every publish cycle and remains
    the only authority: for each seed file (tip feed files +
    the builder), the persistent seed store's copy under
    work/tip-cache/files/<repo path> is used only when its git
    blob SHA equals the tree map's SHA for that path; a missing
    or mismatched file is downloaded on its own (through
    get_blob's content-addressed cache) and written through to
    the store. This replaces the D4 whole-tip keying, under
    which any main commit — Philadelphia publishes to this
    repo every few minutes, and this publisher's own publish
    moves the tip too — missed the cache and re-downloaded all
    ~54 seed blobs (§9 measured ~50 seed GETs per publish
    surviving the treebatch tranche). Output semantics are
    byte-identical: the seeded bytes are exactly the tree
    map's blobs, from whichever local source supplied them."""
    paths, tree_sha = tree_map(tip_sha)
    out = tempfile.mkdtemp(prefix="feed-out-")
    tip_feed = {}
    wanted = [
        (path, sha)
        for path, sha in paths.items()
        if path.startswith(FEED_PREFIX)
        and (
            path[len(FEED_PREFIX):] in FEED_FILES
            or path[len(FEED_PREFIX):].startswith("smart-tu/")
        )
    ]
    builder_repo_path = "tools/feed/build-feed.mjs"
    seed_set = dict(wanted)
    seed_set[builder_repo_path] = paths[builder_repo_path]

    def copy_seed(data_by_path):
        for path, _sha in wanted:
            rel = path[len(FEED_PREFIX):]
            dest = os.path.join(out, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as f:
                f.write(data_by_path[path])
            tip_feed[path] = _sha
        builder_path = os.path.join(out, "build-feed.mjs")
        with open(builder_path, "wb") as f:
            f.write(data_by_path[builder_repo_path])
        return builder_path

    data_by_path = {}
    missing = []
    for path, sha in seed_set.items():
        data = _seed_read(path, sha)
        if data is None:
            missing.append((path, sha))
        else:
            data_by_path[path] = data
    if missing:
        with ThreadPoolExecutor(max_workers=API_WORKERS) as pool:
            blobs = list(pool.map(get_blob, [sha for _p, sha in missing]))
        for (path, _sha), data in zip(missing, blobs):
            data_by_path[path] = data
            _seed_store(path, data)
    builder_path = copy_seed(data_by_path)
    return out, tree_sha, tip_feed, builder_path


def run_replay(builder_path, bundle_dir, out_dir):
    env = dict(os.environ)
    env["FEED_REPLAY_DIR"] = bundle_dir
    env["FEED_OUT_DIR"] = out_dir
    # No keys on this host, ever — replay must not see any even if the
    # environment somehow carried them.
    env.pop("DDOT_BUSTIME_KEY", None)
    env.pop("SWIFTLY_KEY", None)
    proc = subprocess.run(
        [NODE, builder_path],
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"builder replay failed rc={proc.returncode}: "
            f"{proc.stdout[-400:]} {proc.stderr[-400:]}"
        )
    lines = proc.stdout.strip().splitlines()
    # ER-FIX-FEED-01 standing alarm: the builder's named unmatched-
    # vehicle warnings must reach this run's log, not die in the
    # captured stdout (only the last line is returned as the summary).
    alarms = [ln for ln in lines if "UNMATCHED_VEHICLES_ALARM" in ln]
    for ln in alarms:
        log(ln)
    summary = lines[-1] if lines else ""
    if alarms:
        summary += f" | alarms={len(alarms)}"
    return summary


# ------------------------------------------- shadowed-fresh recovery

SHADOW_WALK_MAX = 40  # ancestor bundle commits probed per recovery
SHADOW_MAX_LAG_SEC = 7200  # fresh bundle at most this far behind tip
BULLETIN_RECOVERED_PATH = os.path.join(WORK_DIR, "bulletin-recovered.json")


def _alerts_hash(body):
    """sha256 over the canonical form of a body's alerts array
    — the recovered set's identity, independent of the stamps
    the builder's writeIfChanged declines to rewrite."""
    if not isinstance(body, dict) or not isinstance(body.get("alerts"), list):
        return None
    canon = json.dumps(body["alerts"], sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


def _write_recovered_marker(manifest, out_dir):
    """Record the set a shadow recovery just built: its fetch
    instant and the content hash of the out dir's alerts. Never
    raises — a missing marker only costs a repeated recovery."""
    try:
        mb = (manifest.get("ddot") or {}).get("bulletins") or {}
        h = _alerts_hash(_read_json_file(os.path.join(out_dir, "alerts.json")))
        if not mb.get("fetched_at") or not h:
            return
        rec = {
            "fetched_at": mb["fetched_at"],
            "alerts_sha256": h,
            "recorded_at": iso_of(now_s()),
        }
        tmp = BULLETIN_RECOVERED_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(rec, f, indent=2)
            f.write("\n")
        os.replace(tmp, BULLETIN_RECOVERED_PATH)
        log("bulletin shadow recovery: recorded recovered set "
            f"fetched_at={mb['fetched_at']}")
    except Exception as e:  # noqa: BLE001 - marker must not kill the cycle
        log(f"bulletin shadow recovery: marker write skipped "
            f"({type(e).__name__}: {e})")


def _commit_parents(commit_sha):
    st, d = api("GET", f"/repos/{REPO}/git/commits/{commit_sha}")
    if st != 200:
        return []
    return [p["sha"] for p in d.get("parents") or []]


def _manifest_light(commit_sha):
    """Only a bundle commit's manifest, via its tree map — the
    cheap probe the ancestry walk runs per step. The one bundle
    the walk finds is then fetched in full (verified) by
    fetch_bundle. A probe failure reads as no manifest, never
    as a wrong one."""
    try:
        paths, _tree = tree_map(commit_sha)
        sha = paths.get(BUNDLE_DIRNAME + "/bundle.json")
        if not sha:
            return None
        m = json.loads(get_blob(sha))
        return m if m and m.get("kind") == "feed-raw-bundle/v1" else None
    except (RuntimeError, ValueError):
        return None


def _merge_fresh_bulletins(cur_dir, cur_manifest, anc_dir, anc_manifest):
    """A bundle dir that builds like the current bundle for
    every leg except bulletins, which replay the ancestor's
    fresh payloads. Both source bundles were sha256-verified by
    fetch_bundle; the merge is a local copy plus the manifest's
    bulletins entry taken from the ancestor verbatim.

    The merged manifest also takes the ancestor's collected_at.
    The builder stamps every output from the bundle's
    collected_at, and for a fresh bundle collected_at IS the
    bulletins' fetched_at by construction — keeping the tip's
    collected_at would present the recovered bulletins as
    fetched later than they were and break the GF-1 carry's
    fetched_at join. The other legs' payloads are still the
    current bundle's; for this one cycle they are stamped with
    the ancestor's instant, reading older than they are — the
    conservative direction, and the next cycle re-stamps from
    the tip as usual."""
    merged = tempfile.mkdtemp(prefix="bundle-merged-", dir=WORK_DIR)
    try:
        shutil.copytree(cur_dir, merged, dirs_exist_ok=True)
        src = os.path.join(anc_dir, "ddot-bulletins")
        if os.path.isdir(src):
            shutil.copytree(
                src, os.path.join(merged, "ddot-bulletins"),
                dirs_exist_ok=True)
        m = json.loads(json.dumps(cur_manifest))
        m["ddot"] = dict(m.get("ddot") or {})
        m["ddot"]["bulletins"] = (
            anc_manifest.get("ddot") or {}).get("bulletins")
        if anc_manifest.get("collected_at"):
            m["collected_at"] = anc_manifest["collected_at"]
        with open(os.path.join(merged, "bundle.json"), "w") as f:
            json.dump(m, f, indent=2)
            f.write("\n")
        return merged, m
    except Exception:
        shutil.rmtree(merged, ignore_errors=True)
        raise


def recover_shadowed_fresh(raw_head, bundle_dir, manifest, out_dir):
    """If the incoming bundle is reuse-only and the bulletin
    fetch it names has never been built — the fresh bundle that
    made the fetch was superseded before this publisher polled
    (see the module docstring) — recover that fresh bundle from
    the ancestry and merge its bulletin payloads in. Returns
    (bundle_dir, manifest, cleanup_dir); the first two are the
    inputs unchanged when no recovery applies or none is found.
    Never raises: a recovery failure must not kill the cycle.
    Rate-limit parks still propagate — they are the cycle's
    stop signal, not a recovery failure."""
    try:
        return _recover_shadowed_fresh(raw_head, bundle_dir, manifest,
                                       out_dir)
    except RateLimitPark:
        raise
    except Exception as e:  # noqa: BLE001 - oneshot job: log, continue
        log(f"bulletin shadow recovery: skipped "
            f"({type(e).__name__}: {e})")
        return bundle_dir, manifest, None


def _recover_shadowed_fresh(raw_head, bundle_dir, manifest, out_dir):
    mb = (manifest.get("ddot") or {}).get("bulletins") or {}
    if mb.get("mode") != "reuse":
        return bundle_dir, manifest, None
    want = mb.get("fetched_at")
    if not want:
        return bundle_dir, manifest, None
    built_body = _read_json_file(os.path.join(out_dir, "alerts.json"))
    built = _bulletin_source(built_body)
    if built and built.get("fetched_at") == want:
        return bundle_dir, manifest, None  # tip already carries it
    carry = _bulletin_source(_read_json_file(BULLETIN_CARRY_PATH))
    if carry and carry.get("fetched_at") == want:
        return bundle_dir, manifest, None  # GF-1 carry holds it
    marker = _read_json_file(BULLETIN_RECOVERED_PATH)
    if (
        isinstance(marker, dict)
        and marker.get("fetched_at") == want
        and marker.get("alerts_sha256")
        and _alerts_hash(built_body) == marker["alerts_sha256"]
    ):
        # A prior recovery built this exact set and it is on
        # the tip; the tip's stamp differs only in the way
        # writeIfChanged treats as no change. Stand down.
        return bundle_dir, manifest, None
    try:
        tip_epoch = datetime.fromisoformat(
            manifest["collected_at"].replace("Z", "+00:00")).timestamp()
    except (KeyError, ValueError):
        return bundle_dir, manifest, None
    cur = raw_head
    for _step in range(SHADOW_WALK_MAX):
        parents = _commit_parents(cur)
        if not parents:
            break
        cur = parents[0]
        m = _manifest_light(cur)
        if m is None:
            continue
        try:
            m_epoch = datetime.fromisoformat(
                m["collected_at"].replace("Z", "+00:00")).timestamp()
        except (KeyError, ValueError):
            continue
        if tip_epoch - m_epoch > SHADOW_MAX_LAG_SEC:
            break  # ancestry older than the lag bound: stop
        mb2 = (m.get("ddot") or {}).get("bulletins") or {}
        if mb2.get("mode") == "fresh" and mb2.get("fetched_at") == want:
            anc_dir, anc_manifest = fetch_bundle(cur)
            merged_dir, merged_manifest = _merge_fresh_bulletins(
                bundle_dir, manifest, anc_dir, anc_manifest)
            log(
                "bulletin shadow recovery: fresh bundle "
                f"{cur[:8]} (fetched_at={want}) was superseded "
                f"before processing; its bulletin payloads are "
                f"merged into tip bundle {raw_head[:8]}"
            )
            return merged_dir, merged_manifest, merged_dir
    log(
        f"bulletin shadow recovery: no fresh bundle found for "
        f"fetched_at={want} within {SHADOW_WALK_MAX} ancestors / "
        f"{SHADOW_MAX_LAG_SEC}s; building the reuse tip as-is"
    )
    return bundle_dir, manifest, None


# ------------------------------------------------------- GF-1 carry

BULLETIN_CARRY_PATH = os.path.join(WORK_DIR, "bulletin-carry.json")


def _bulletin_source(body):
    """The DDOT realtime source state inside an alerts.json body,
    or None — the publisher-side mirror of the builder's
    priorDdotBulletinState."""
    if not isinstance(body, dict):
        return None
    for s in body.get("sources") or []:
        if (
            isinstance(s, dict)
            and s.get("agency") == "ddot"
            and s.get("kind") == "realtime"
            and isinstance(s.get("fetched_at"), str)
        ):
            return s
    return None


def _read_json_file(path):
    try:
        with open(path, "rb") as f:
            return json.loads(f.read())
    except (OSError, ValueError):
        return None


def _drop_expired_alerts(body, now_epoch):
    """(kept_body, dropped): a copy of `body` without the alerts
    whose own active_period.end has passed at now_epoch. An alert
    with no end, or an unparseable one, is kept — expiry must be
    proven from the alert's own window, never assumed."""
    alerts = body.get("alerts")
    if not isinstance(alerts, list):
        return body, 0
    kept, dropped = [], 0
    for a in alerts:
        end = None
        if isinstance(a, dict) and isinstance(a.get("active_period"), dict):
            end = a["active_period"].get("end")
        if isinstance(end, str) and end:
            try:
                end_epoch = datetime.fromisoformat(
                    end.replace("Z", "+00:00")
                ).timestamp()
            except ValueError:
                end_epoch = None
            if end_epoch is not None and end_epoch <= now_epoch:
                dropped += 1
                continue
        kept.append(a)
    if not dropped:
        return body, 0
    out = dict(body)
    out["alerts"] = kept
    out["count"] = len(kept)
    return out, dropped


def bulletin_carry_forward(manifest, out_dir):
    """GF-1: retain the last fresh bulletin set this publisher
    built; republish (carry) it on later cycles until a newer
    fetch lands. Returns a log note. Never raises — a carry
    failure must not kill the publish cycle.

    Retain: after each replay, if the built alerts carry an ok
    DDOT source state whose fetched_at is newer than the
    retained set's, the built file becomes the retained set
    (atomic tmp+replace). Retention happens before the cycle's
    commit on purpose: if the commit then fails, the set the
    commit was carrying is exactly the set the carry retains.
    Error-state envelopes (ok false) are never retained — they
    publish only through the normal fresh path, as before.

    Carry: when the bundle manifest's bulletins.fetched_at —
    collect's freshest fetch — equals the retained set's
    fetched_at, but this cycle's built output is older (the
    bundle was reuse-only and the seeded tip never received
    that fetch, because its one publish was lost), write the
    retained body into the out dir so diff_commit_set commits
    it in this cycle. The body rides verbatim — generated_at
    and sources keep the original collection timestamps —
    except that alerts expired at carry time are dropped.
    A newer fetch replaces the retained set (retention above)
    and moves the manifest's fetched_at, so the join breaks
    and the old set can never be carried again.
    """
    try:
        return _bulletin_carry_forward(manifest, out_dir)
    except Exception as e:  # noqa: BLE001 - carry must never kill a cycle
        return f"bulletin carry: skipped ({type(e).__name__}: {e})"


def _bulletin_carry_forward(manifest, out_dir):
    alerts_path = os.path.join(out_dir, "alerts.json")
    built = _read_json_file(alerts_path)
    built_src = _bulletin_source(built)
    built_fetched = built_src.get("fetched_at") if built_src else None

    carry = _read_json_file(BULLETIN_CARRY_PATH)
    carry_src = _bulletin_source(carry)
    carry_fetched = carry_src.get("fetched_at") if carry_src else None

    notes = []
    if (
        built is not None
        and built_src is not None
        and built_src.get("ok")
        and built_fetched
        and (carry_fetched is None or built_fetched > carry_fetched)
    ):
        with open(alerts_path, "rb") as f:
            data = f.read()
        os.makedirs(WORK_DIR, exist_ok=True)
        tmp = BULLETIN_CARRY_PATH + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, BULLETIN_CARRY_PATH)
        carry, carry_fetched = built, built_fetched
        notes.append(f"retained fetched_at={built_fetched}")

    mb = (manifest.get("ddot") or {}).get("bulletins") or {}
    collect_fetched = mb.get("fetched_at")
    if (
        carry is not None
        and collect_fetched
        and carry_fetched == collect_fetched
        and built_fetched != carry_fetched
    ):
        body, dropped = _drop_expired_alerts(carry, now_s())
        if dropped:
            payload = (json.dumps(body, indent=2, ensure_ascii=False) + "\n").encode(
                "utf-8"
            )
        else:
            with open(BULLETIN_CARRY_PATH, "rb") as f:
                payload = f.read()
        with open(alerts_path, "wb") as f:
            f.write(payload)
        notes.append(
            f"carried fetched_at={carry_fetched} "
            f"alerts={len(body.get('alerts') or [])} "
            f"expired_dropped={dropped}"
        )
    return "bulletin carry: " + ("; ".join(notes) if notes else "no-op")


def diff_commit_set(out_dir, tip_feed):
    """(changes {path: bytes}, deletions [path]) vs the tip feed files,
    restricted to the builder's managed set (mirror semantics)."""
    current = {}
    for root, _dirs, files in os.walk(out_dir):
        for name in files:
            if name == "build-feed.mjs":
                continue
            full = os.path.join(root, name)
            rel = os.path.relpath(full, out_dir).replace(os.sep, "/")
            current[FEED_PREFIX + rel] = full
    changes, deletions = {}, []
    for path in sorted(set(tip_feed) | set(current)):
        if path not in current:
            deletions.append(path)
            continue
        with open(current[path], "rb") as f:
            data = f.read()
        if tip_feed.get(path) != git_blob_sha(data):
            changes[path] = data
    return changes, deletions


# ---------------------------------------------------------------- commit

# Treebatch chunking (2026-10-26): a Create Tree call carries at
# most this many entries and this much inline content; a single
# larger file rides alone (probe-verified at 5 MB, 2026-10-26).
TREE_CHUNK_MAX_ENTRIES = 100
TREE_CHUNK_MAX_CONTENT_BYTES = 4 * 1024 * 1024


def tree_paths(tree_sha, repo=REPO):
    """{path: blob sha} for every blob under a TREE sha (recursive).
    A truncated listing cannot verify a publish — raise, as
    tree_map does for commits."""
    st, tree = api("GET", f"/repos/{repo}/git/trees/{tree_sha}?recursive=1")
    if st != 200:
        raise RuntimeError(f"tree {tree_sha}: HTTP {st}")
    if tree.get("truncated"):
        raise RuntimeError("tree truncated; cannot verify safely")
    return {e["path"]: e["sha"] for e in tree["tree"] if e["type"] == "blob"}


def _blob_entry(path, data, repo=REPO):
    """Legacy per-file blob POST — now only the fallback for
    files that cannot ride inline in a tree entry."""
    st, blob = api(
        "POST",
        f"/repos/{repo}/git/blobs",
        {"content": base64.b64encode(data).decode(), "encoding": "base64"},
    )
    if st != 201:
        raise RuntimeError(f"blob {path}: HTTP {st}")
    return {"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]}


def commit_to_main(tip_sha, tree_sha, changes, deletions, collected_at,
                   tip_feed=None, repo=REPO):
    """One commit on main applying `changes`/`deletions` on top of
    the tip tree; the ref moves once, at the end, after the built
    tree verifies against the expected managed map (tip_feed with
    this publish applied). See the module docstring (Treebatch).
    `repo` defaults to the site repo; the data-plane mirror passes
    DATA_REPO (same mechanics, same verification).
    """
    sha_entries = []
    chunks = []
    chunk = []
    chunk_bytes = 0

    def flush():
        nonlocal chunk, chunk_bytes
        if chunk:
            chunks.append(chunk)
        chunk = []
        chunk_bytes = 0

    for path, data in sorted(changes.items()):
        text = None
        if data:
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                text = None
        if text is None:
            # Empty or non-UTF-8: inline content cannot carry
            # these bytes faithfully (the API stores the string's
            # UTF-8 bytes and ignores any encoding field).
            sha_entries.append(_blob_entry(path, data, repo=repo))
            continue
        if chunk and (
            len(chunk) >= TREE_CHUNK_MAX_ENTRIES
            or chunk_bytes + len(data) > TREE_CHUNK_MAX_CONTENT_BYTES
        ):
            flush()
        chunk.append(
            {"path": path, "mode": "100644", "type": "blob",
             "content": text}
        )
        chunk_bytes += len(data)
    flush()
    for path in deletions:
        sha_entries.append(
            {"path": path, "mode": "100644", "type": "blob", "sha": None}
        )
    # Deletion/sha entries are tiny; they ride the last chunk (or
    # form the only chunk when nothing changed but deletions).
    if sha_entries:
        if chunks:
            chunks[-1] = chunks[-1] + sha_entries
        else:
            chunks = [sha_entries]
    new_tree = tree_sha
    for part in chunks:
        st, tree = api(
            "POST",
            f"/repos/{repo}/git/trees",
            {"base_tree": new_tree, "tree": part},
        )
        if st != 201:
            raise RuntimeError(f"tree: HTTP {st}")
        new_tree = tree["sha"]
    if tip_feed is not None:
        expected = dict(tip_feed)
        for path in deletions:
            expected.pop(path, None)
        for path, data in changes.items():
            expected[path] = git_blob_sha(data)
        built = tree_paths(new_tree, repo=repo)
        for path, sha in expected.items():
            if built.get(path) != sha:
                raise RuntimeError(
                    f"built tree mismatch at {path}; ref not moved")
        for path in deletions:
            if path in built:
                raise RuntimeError(
                    f"built tree still carries deleted {path}; "
                    "ref not moved")
    # Standing message shape on main: "live-data: feed update
    # 2026-10-19T19:09Z" — ISO instant truncated to the minute.
    msg = f"live-data: feed update {collected_at[:16]}Z"
    st, commit = api(
        "POST",
        f"/repos/{repo}/git/commits",
        {"message": msg, "tree": new_tree, "parents": [tip_sha]},
    )
    if st != 201:
        raise RuntimeError(f"commit: HTTP {st}")
    st, d = api(
        "PATCH",
        f"/repos/{repo}/git/refs/heads/main",
        {"sha": commit["sha"], "force": False},
    )
    if st != 200:
        raise RuntimeError(f"ref update: HTTP {st} {d}")
    return commit["sha"]


def mirror_to_data_repo(out_dir, collected_at):
    if os.environ.get("FEED_PUBLISHER_SKIP_MIRROR") == "1":
        log("data mirror: skipped (FEED_PUBLISHER_SKIP_MIRROR=1; "
            "the data repo's feed-mirror workflow owns the mirror)")
        return
    """Data-plane split (2026-11-10): mirror the managed feed set
    into DATA_REPO under the same live-data/ paths. The diff is
    computed against the DATA repo's own tip feed map (not the
    site changes), so a missed or failed mirror converges on the
    next cycle instead of drifting. A mirror failure never fails
    the cycle — the site publish already landed and the pages
    fall back to the site origin — except RateLimitPark, which
    propagates: the credential is shared, so the park is global.
    The data repo carries README/.nojekyll outside live-data/;
    the diff's managed set is the live-data/ prefix only, so
    those files are never touched."""
    try:
        tip = ref_sha("main", repo=DATA_REPO)
        if tip is None:
            log("data mirror: DATA_REPO main ref missing; skipped")
            return
        paths, tree_sha = tree_map(tip, repo=DATA_REPO)
        # Managed set only (same rule as seed_from_tip): the data
        # repo's seeded watch/ subtree belongs to another pipeline
        # and must never read as a deletion.
        data_tip_feed = {
            p: s for p, s in paths.items()
            if p.startswith(FEED_PREFIX)
            and (
                p[len(FEED_PREFIX):] in FEED_FILES
                or p[len(FEED_PREFIX):].startswith("smart-tu/")
            )
        }
        changes, deletions = diff_commit_set(out_dir, data_tip_feed)
        if not changes and not deletions:
            log("data mirror: identical to data tip; no commit")
            return
        new_tip = commit_to_main(
            tip, tree_sha, changes, deletions, collected_at,
            tip_feed=data_tip_feed, repo=DATA_REPO,
        )
        log(f"data mirror: published commit {new_tip[:8]} "
            f"changes={len(changes)} deletions={len(deletions)}")
    except RateLimitPark:
        raise
    except Exception as e:  # noqa: BLE001 - mirror must not kill the cycle
        log(f"data mirror: FAILED ({type(e).__name__}: {e}); "
            "site publish stands, will converge next cycle")


def ensure_deploy():
    """Dispatch a deploy whenever no active or completed deploy covers
    the current main tip. (Ledger #17ii, fixed 2026-11-11: previously
    ANY active run suppressed dispatch, so a tip landing while an
    older deploy ran waited for a later cycle's unrelated commit.)"""
    tip = ref_sha("main")
    runs = workflow_runs(DEPLOY_WORKFLOW)
    active = runs_active(runs)
    if any(r.get("head_sha") == tip for r in active):
        return "deploy already outstanding (covers tip)"
    if runs and runs[0].get("head_sha") == tip and runs[0].get("conclusion") == "success":
        return "tip already deployed"
    dispatch(DEPLOY_WORKFLOW)
    if active:
        return "deploy dispatched (queued behind active run for older head)"
    return "deploy dispatched"


# ---------------------------------------------------------------- cadence

def maybe_dispatch_collect(state, bundle_collected_at):
    if bundle_collected_at is None:
        age = float("inf")
        age_txt = "unknown"
    else:
        age = now_s() - bundle_collected_at
        age_txt = f"{age:.0f}s"
    last = state.get("last_collect_dispatch_at", 0)
    if age < COLLECT_STALE_SEC:
        return f"bundle fresh ({age_txt})"
    if now_s() - last < COLLECT_MIN_INTERVAL_SEC:
        return "collect min-interval not met"
    if runs_active(workflow_runs(COLLECT_WORKFLOW)):
        return "collect run already active"
    dispatch(COLLECT_WORKFLOW)
    state["last_collect_dispatch_at"] = now_s()
    return f"collect dispatched (bundle age {age_txt})"


# ---------------------------------------------------------------- main

def process_bundle(state, mode, raw_head):
    calls_at_entry = API_CALL_COUNT["n"]
    bundle_dir, manifest = fetch_bundle(raw_head)
    collected_epoch = datetime.fromisoformat(
        manifest["collected_at"].replace("Z", "+00:00")
    ).timestamp()
    state["bundle_collected_epoch"] = collected_epoch
    if raw_head == state.get("processed_bundle_sha"):
        state["seen_bundle_sha"] = raw_head
        return collected_epoch
    tip = ref_sha("main")
    out_dir, tree_sha, tip_feed, builder_path = seed_from_tip(tip)
    try:

        def veh_stats(path):
            try:
                with open(path) as f:
                    d = json.load(f)
                src = d.get("sources") or {}
                ddot = src.get("ddot") or {}
                qline = src.get("qline") or {}
                return (
                    f"gen={d.get('generated_at')} count={d.get('count')} "
                    f"ddot_ok={ddot.get('ok')} batches={ddot.get('batches_ok')}/"
                    f"{ddot.get('batches_failed')} qline_ok={qline.get('ok')} "
                    f"qline_n={qline.get('vehicles')}"
                )
            except (OSError, ValueError, TypeError):
                return "unreadable"

        tip_stats = veh_stats(os.path.join(out_dir, "vehicles.json"))
        bundle_dir, manifest, merged_dir = recover_shadowed_fresh(
            raw_head, bundle_dir, manifest, out_dir)
        try:
            summary = run_replay(builder_path, bundle_dir, out_dir)
        finally:
            if merged_dir:
                shutil.rmtree(merged_dir, ignore_errors=True)
        log(bulletin_carry_forward(manifest, out_dir))
        if merged_dir:
            _write_recovered_marker(manifest, out_dir)
        changes, deletions = diff_commit_set(out_dir, tip_feed)
        built_stats = veh_stats(os.path.join(out_dir, "vehicles.json"))
        log(
            f"bundle {raw_head[:8]} collected_at={manifest['collected_at']} "
            f"changes={len(changes)} deletions={len(deletions)} [{summary}]"
        )
        log(f"built: {built_stats}")
        log(f"tip:   {tip_stats}")
        if mode == "live":
            if changes or deletions:
                new_tip = commit_to_main(
                    tip, tree_sha, changes, deletions, manifest["collected_at"],
                    tip_feed=tip_feed,
                )
                log(f"published commit {new_tip[:8]} "
                    f"api_calls={API_CALL_COUNT['n'] - calls_at_entry}")
                # Tipseed: the out dir is now the tip's feed set —
                # store it so the next cycle seeds these bytes
                # locally instead of downloading them back.
                refresh_seed_from_out(out_dir)
                state["last_publish_at"] = now_s()
                state["last_publish_latency_sec"] = round(
                    now_s() - collected_epoch, 1
                )
            else:
                log("outputs identical to tip; no commit")
            # Data-plane split (2026-11-10): mirror runs on every
            # live cycle, changed or not, so the data repo converges
            # even when the site side had nothing to publish.
            mirror_to_data_repo(out_dir, manifest["collected_at"])
            state["processed_bundle_sha"] = raw_head
            log(ensure_deploy())
        else:
            log("SHADOW: no commit (mode=shadow)")
            hist = state.setdefault("shadow_bundles", [])
            hist.append(
                {
                    "sha": raw_head,
                    "collected_at": manifest["collected_at"],
                    "changes": len(changes),
                    "deletions": len(deletions),
                }
            )
            state["shadow_bundles"] = hist[-24:]
        # Advance the seen marker only after full success: a failure above
        # raises into main(), which leaves the bundle for the next tick.
        state["seen_bundle_sha"] = raw_head
        return collected_epoch
    finally:
        # Temp-dir lifecycle (2026-11-07): the out dir is this
        # run's alone — remove it on every exit path so /tmp
        # (512M tmpfs) cannot fill with one dir per cycle.
        shutil.rmtree(out_dir, ignore_errors=True)



FEED_OUT_RETENTION_SEC = 3600  # far beyond any single run's lifetime


def sweep_stale_feed_out():
    """Remove feed-out-* temp dirs orphaned by crashed or killed runs.

    Runs at cycle start, before this run creates its own out dir.
    The publisher is a single writer (oneshot service, 600s timeout),
    so a dir older than the retention margin cannot be in use."""
    cutoff = now_s() - FEED_OUT_RETENTION_SEC
    removed = 0
    try:
        names = os.listdir(tempfile.gettempdir())
    except OSError:
        return
    for name in names:
        if not name.startswith("feed-out-"):
            continue
        path = os.path.join(tempfile.gettempdir(), name)
        try:
            if os.path.isdir(path) and os.path.getmtime(path) < cutoff:
                shutil.rmtree(path, ignore_errors=True)
                removed += 1
        except OSError:
            continue
    if removed:
        log(f"swept {removed} stale feed-out temp dir(s)")


def main():
    API_CALL_COUNT["n"] = 0
    sweep_stale_feed_out()
    mode = load_mode()
    state = load_state()
    # Resilience (2026-10-26): the park is checked before the first
    # API call of the cycle — a parked cycle makes zero API calls.
    parked_until = float(state.get("parked_until") or 0)
    if parked_until > now_s():
        log(f"parked until {iso_of(parked_until)} (rate limit); "
            "zero API calls this cycle")
        return 0
    if parked_until:
        state.pop("parked_until", None)  # expired park; clear it
        save_state(state)
    try:
        raw_head = ref_sha("feed-raw")
        if raw_head is None:
            log("feed-raw branch missing; nothing to do")
            return 0
        collected_epoch = state.get("bundle_collected_epoch")
        if raw_head != state.get("seen_bundle_sha"):
            try:
                collected_epoch = process_bundle(state, mode, raw_head)
            except RuntimeError as e:
                log(f"bundle at {raw_head[:8]} not publishable: {e}")
            save_state(state)
        else:
            log(f"no new bundle (head {raw_head[:8]})")
        log(maybe_dispatch_collect(state, collected_epoch))
        save_state(state)
        return 0
    except RateLimitPark as park:
        until = park.reset_epoch + random.uniform(*PARK_JITTER_SEC)
        state["parked_until"] = until
        save_state(state)
        log(f"parked until {iso_of(until)} (rate limit)")
        return 0


if __name__ == "__main__":
    if not os.environ.get("GITHUB_ACTIONS"):
        os.environ.setdefault("https_proxy", "http://127.0.0.1:8888")
        os.environ.setdefault("http_proxy", "http://127.0.0.1:8888")
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 - oneshot job: log, exit nonzero
        log(f"ERROR: {e}")
        sys.exit(1)
