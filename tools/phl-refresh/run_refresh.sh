#!/usr/bin/env bash
# Board 65 item 3 - SEPTA rail static refresh ship (one-time, dispatch-only).
#
# Rebuilds the union planner asset from the tranche-verified inputs,
# proves it byte-identical to the asset the local acceptance battery
# passed (MD5 gate in tools/phl-refresh/manifest.json), replays the
# full acceptance battery in the runner, and only then commits the
# tranche's staged ship set to main with this workflow's own token.
# Any failure before the commit step ships nothing.
#
# Modes (PHL_REFRESH_MODE): "verify" runs everything except the
# commit/push; "ship" also commits and pushes.
set -euo pipefail

WS="${GITHUB_WORKSPACE:?}"
TOOLS="$WS/tools/phl-refresh"
CITY="$WS/live-transit/philadelphia"
WORK="${RUNNER_TEMP:?}/phl-refresh"
INPUTS="$WS/phl-inputs/inputs"
AUD=/tmp/phl-rail-refresh
ASSET_NAME="planner-timetable-v202609271u202611010-v202609271u202611010.json"
OLD_ASSET_NAME="planner-timetable-v202609271-v202609271.json"
STAMP="20261026-1449"
MODE="${PHL_REFRESH_MODE:-verify}"
export TZ=America/New_York
mkdir -p "$WORK" "$AUD/audit"

say() { echo "=== $*"; }
free -m || true

# --- 0. idempotence guard -------------------------------------------------
if [ -f "$CITY/planner/assets/$ASSET_NAME" ] \
  && grep -q "$STAMP" "$CITY/config/stamp.mjs"; then
  say "refresh already shipped (asset present, stamp $STAMP); exiting clean"
  exit 0
fi

# --- 1. inputs, hash-verified against the tranche manifest ----------------
say "fetch inputs"
cp "$INPUTS/google_bus.zip" "$WORK/google_bus_old.zip"
cp "$INPUTS/google_rail.zip" "$WORK/google_rail_old.zip"
curl -fsSL --retry 3 -o "$WORK/google_bus_new.zip" \
  https://www3.septa.org/developer/google_bus.zip
curl -fsSL --retry 3 -o "$WORK/google_rail_new.zip" \
  https://www3.septa.org/developer/google_rail.zip
python3 - "$TOOLS/manifest.json" "$WORK" <<'PY'
import hashlib
import json
import sys

man = json.load(open(sys.argv[1]))
work = sys.argv[2]
checks = [
    ("old_bus_zip", "google_bus_old.zip"),
    ("old_rail_zip", "google_rail_old.zip"),
    ("new_bus_zip", "google_bus_new.zip"),
    ("new_rail_zip", "google_rail_new.zip"),
]
for key, fn in checks:
    data = open(f"{work}/{fn}", "rb").read()
    md5 = hashlib.md5(data).hexdigest()
    assert len(data) == man[key]["bytes"], (key, len(data))
    assert md5 == man[key]["md5"], (key, md5)
    print("input OK", key, len(data), md5)
PY

# --- 2. union build (tranche tool, staged verbatim modulo CI format) ------
say "build unions"
python3 "$TOOLS/build_union.py" "$WORK/google_bus_old.zip" \
  "$WORK/google_bus_new.zip" "$WORK/google_bus_union.zip" \
  v202609271u202611010 20270220
python3 "$TOOLS/build_union.py" "$WORK/google_rail_old.zip" \
  "$WORK/google_rail_new.zip" "$WORK/google_rail_union.zip" \
  v202609271u202611010 20270220
cp "$WORK/google_bus_union.zip" "$WORK/google_rail_union.zip" "$AUD/"

# --- 3. compile + byte-identity gate --------------------------------------
say "compile union asset"
PHL_TOOLS_DIR="$TOOLS" PHL_WORK_DIR="$WORK" \
  python3 "$TOOLS/compile_refresh.py"
python3 - "$TOOLS/manifest.json" "$WORK/compiled" "$ASSET_NAME" <<'PY'
import hashlib
import json
import re
import sys

man = json.load(open(sys.argv[1]))
out = sys.argv[2]
asset = sys.argv[3]
# The compiler stamps meta.generated_at with the build clock (its one
# nondeterministic field), so the asset gate is byte-identity with
# that single field masked; the sidecars carry no timestamps and
# gate on their raw MD5s.
data = open(f"{out}/{asset}", "rb").read()
assert len(data) == man["asset"]["bytes"], ("asset bytes", len(data))
hits = re.findall(rb'"generated_at":"[^"]*"', data)
assert len(hits) == 1, hits
print("compiled asset raw md5:", hashlib.md5(data).hexdigest())
print("compiled asset", hits[0].decode())
masked = re.sub(
    rb'"generated_at":"[^"]*"', b'"generated_at":"MASKED"', data
)
mmd5 = hashlib.md5(masked).hexdigest()
assert mmd5 == man["asset"]["md5_masked_generated_at"], ("asset masked", mmd5)
print("compiled OK asset (generated_at masked)", len(data), mmd5)
for key, fn in [
    ("stops_sidecar", "stops-sidecar.json"),
    ("trip_map", "trip-map.json"),
]:
    data = open(f"{out}/{fn}", "rb").read()
    md5 = hashlib.md5(data).hexdigest()
    assert md5 == man[key]["md5"], (key, md5)
    print("compiled OK", key, len(data), md5)
PY

# --- 4. assemble the ship set in the working tree -------------------------
say "assemble ship set (8 staged blobs by SHA + compiled asset)"
fetch_blob() {
  gh api "repos/${GITHUB_REPOSITORY}/git/blobs/$1" --jq '.content' \
    | base64 -d > "$2"
  local got
  got=$(git -C "$WS" hash-object "$2")
  if [ "$got" != "$1" ]; then
    echo "blob hash mismatch at $2: $got != $1"
    exit 1
  fi
  echo "blob OK $1 -> $2"
}
python3 - "$TOOLS/manifest.json" > "$WORK/blobs.tsv" <<'PY'
import json
import sys

man = json.load(open(sys.argv[1]))
for path, sha in sorted(man["replacement_blobs"].items()):
    print(f"{sha}\t{path}")
PY
while IFS=$'\t' read -r sha path; do
  fetch_blob "$sha" "$WS/$path"
done < "$WORK/blobs.tsv"
# compiled sidecars must equal the staged blobs byte-for-byte
[ "$(git -C "$WS" hash-object "$WORK/compiled/stops-sidecar.json")" \
  = "79d6b3a0ea57396ace0696b37339439732773d43" ]
[ "$(git -C "$WS" hash-object "$WORK/compiled/trip-map.json")" \
  = "24ddd43dd0798f4445994eb5e1f22ce6ebad90aa" ]
cp "$WORK/compiled/$ASSET_NAME" "$CITY/planner/assets/$ASSET_NAME"
rm "$CITY/planner/assets/$OLD_ASSET_NAME"

# --- 5. acceptance battery replay -----------------------------------------
say "battery: stage harnesses"
mkdir -p "$CITY/harness"
cp "$TOOLS/battery/verify-exception-added.mjs" \
  "$TOOLS/battery/verify-planner-g.mjs" \
  "$TOOLS/battery/verify-foundation.mjs" "$CITY/harness/"
mkdir -p "$WS/hidden_files/integration-staging/verification" \
  "$WS/hidden_files/nav-harness/experiment-v2"
cp "$TOOLS/battery/data/od-pairs.json" \
  "$WS/hidden_files/integration-staging/verification/"
cp "$TOOLS/battery/data/results-phl-set-v2-2026-10-22-freqbound.json" \
  "$WS/hidden_files/nav-harness/experiment-v2/"
AUDRUN="$WORK/audit-run"
mkdir -p "$AUDRUN/inputs" "$AUDRUN/inputs-set"
cp "$TOOLS/battery/audit/audit-services-set-union.mjs" \
  "$TOOLS/battery/audit/audit-truth-union.py" "$AUDRUN/"
cp "$TOOLS/battery/audit/inputs/raptor-v2-set.js" "$AUDRUN/inputs/"
cp "$WORK/compiled/$ASSET_NAME" "$AUDRUN/inputs-set/asset.json"
cp "$WORK/compiled/trip-map.json" "$AUDRUN/inputs-set/trip-map.json"

say "battery: truth + full audit (294 cells)"
(cd "$AUDRUN" && python3 audit-truth-union.py)
cp "$AUD/audit/audit-truth-full.json" "$AUDRUN/audit-truth-full.json"
(cd "$AUDRUN" && node audit-services-set-union.mjs)
python3 - "$AUDRUN/audit-result-set.json" <<'PY'
import json
import sys

r = json.load(open(sys.argv[1]))
assert r["cellsChecked"] == 294, r["cellsChecked"]
assert r["mismatchCells"] == 0, r["mismatchCells"]
assert r["verdict"].startswith("PASS"), r["verdict"]
assert r["subsetVerdict"].startswith("PASS"), r["subsetVerdict"]
print("audit gate PASS:", r["verdict"], "|", r["subsetVerdict"])
PY

export ASSET_PATH="$CITY/planner/assets/$ASSET_NAME"
export REBUILD_ROOT="$CITY"
say "battery: exception-added probe"
(cd "$CITY" && node harness/verify-exception-added.mjs)
say "battery: planner-G probes"
(cd "$CITY" && node harness/verify-planner-g.mjs)
say "battery: golden pairs (rebased)"
(cd "$CITY" && node "$TOOLS/battery/golden_rebased.mjs")
say "battery: extension probes"
(cd "$CITY" && node "$TOOLS/battery/extension_probes.mjs")
say "battery: foundation"
(cd "$CITY" && node harness/verify-foundation.mjs)
say "BATTERY ALL PASS"

# --- 6. commit + push (ship mode only) ------------------------------------
if [ "$MODE" != "ship" ]; then
  say "verify mode: battery passed; not committing"
  exit 0
fi
say "commit ship set"
echo "SHIPPED_ASSET_MD5 $(md5sum "$CITY/planner/assets/$ASSET_NAME" | cut -d' ' -f1)"
cd "$WS"
git add -- \
  "live-transit/philadelphia/planner/assets/$ASSET_NAME" \
  "live-transit/philadelphia/planner/assets/$OLD_ASSET_NAME" \
  "live-transit/philadelphia/planner/assets/stops-sidecar.json" \
  "live-transit/philadelphia/planner/assets/trip-map.json" \
  "live-transit/philadelphia/planner/config/phl-planner-config.json" \
  "live-transit/philadelphia/planner/README.md" \
  "live-transit/philadelphia/config/city-config.mjs" \
  "live-transit/philadelphia/config/stamp.mjs" \
  "live-transit/philadelphia/index.html" \
  "live-transit/philadelphia/modules/planner-host.mjs"
STAGED=$(git diff --cached --name-only | sort)
EXPECTED=$(printf '%s\n' \
  "live-transit/philadelphia/config/city-config.mjs" \
  "live-transit/philadelphia/config/stamp.mjs" \
  "live-transit/philadelphia/index.html" \
  "live-transit/philadelphia/modules/planner-host.mjs" \
  "live-transit/philadelphia/planner/README.md" \
  "live-transit/philadelphia/planner/assets/$ASSET_NAME" \
  "live-transit/philadelphia/planner/assets/$OLD_ASSET_NAME" \
  "live-transit/philadelphia/planner/assets/stops-sidecar.json" \
  "live-transit/philadelphia/planner/assets/trip-map.json" \
  "live-transit/philadelphia/planner/config/phl-planner-config.json" | sort)
if [ "$STAGED" != "$EXPECTED" ]; then
  echo "staged set mismatch:"
  diff <(echo "$EXPECTED") <(echo "$STAGED") || true
  exit 1
fi
git -c user.name="github-actions[bot]" \
  -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit -m "PHL planner static refresh (Board 65 item 3): SEPTA wave v202611010 union-compiled with the v202609271 book through 2026-10-31; rail service validity extended past 2026-11-21 to 2027-02-20 (calendar-measured)"
for i in 1 2 3 4 5; do
  git fetch origin main
  if ! git rebase origin/main; then
    git rebase --abort || true
    echo "rebase conflict; refusing to force anything"
    exit 1
  fi
  if git push origin HEAD:main; then
    say "SHIPPED commit $(git rev-parse HEAD)"
    exit 0
  fi
  echo "push attempt $i raced; retrying"
  sleep 5
done
echo "push failed after 5 attempts"
exit 1
