#!/usr/bin/env bash
# run_fixtures.sh — LT-U5 pick-harness fixture gate.
#
# Each vendored harness (tools/cicd/harness/test-pick-<slug>.mjs) is
# the city's own LT-U5 certifying fixture from the Cities V2 verify
# programme: it drives the REAL event handlers against the REAL
# shipped tree (it is placed as a sibling of the tree it tests and
# imports ./modules/*), with its own embedded feed fixtures, so it
# is deterministic against live publisher data. The runner copies
# each city tree to a scratch dir, drops the harness in, and runs
# it under the city's timezone (the T1 verification conditions).
#
# Coverage, honestly stated (2026-11-01):
#   covered: austin, cincinnati, columbus, denver, philadelphia,
#            sacramento, san-diego (22/22 each at adoption)
#   denver:  port vendored 2026-11-01 (correction: the port
#            existed all along at goals/live-transit-denver-aurora/
#            hidden_files/u5-port/test-pick-den.mjs, md5
#            86ae70180221d43408455beaf92d24c6; the adoption-night
#            search looked in the wrong goal directory and
#            reported a false gap — corrected in the adoption
#            record the same night).
#   detroit: its LT-U5 harness assumes the assembler bundle layout
#            (assets at the bundle root); the repo layout keeps
#            Detroit assets at the repo root, so the harness cannot
#            run against the repo tree. Detroit is held by the
#            shell-contract gate (both shells), manifest,
#            ref-integrity and boot-smoke gates.
#
# Usage: run_fixtures.sh [repo-root]   (default: .)
set -u
set -o pipefail
ROOT="${1:-.}"
HERE="$(cd "$(dirname "$0")" && pwd)"
FAIL=0

run_city() {
  local slug="$1" file="$2" tz="$3"
  local tmp
  tmp="$(mktemp -d)"
  cp -r "$ROOT/live-transit/$slug/." "$tmp/"
  cp "$HERE/harness/$file" "$tmp/"
  local out
  out="$(cd "$tmp" && TZ="$tz" timeout 300 node "$file" 2>&1 | tail -1)"
  local rc=$?
  if [ $rc -eq 0 ] && printf '%s' "$out" | grep -q "TEST PASS"; then
    echo "OK   $slug: $out"
  else
    echo "FAIL $slug: harness did not pass (rc=$rc): $out"
    FAIL=1
  fi
  rm -rf "$tmp"
}

run_city austin      test-pick-aus.mjs America/Chicago
run_city cincinnati  test-pick-cin.mjs America/New_York
run_city columbus    test-pick-col.mjs America/New_York
run_city denver      test-pick-den.mjs America/Denver
run_city philadelphia test-pick-phl.mjs America/New_York
run_city sacramento  test-pick-sac.mjs America/Los_Angeles
run_city san-diego   test-pick-sd.mjs  America/Los_Angeles

if [ $FAIL -ne 0 ]; then
  echo "EVIDENCE gate=lt-u5-fixtures class=behavior verdict=fail"
  echo "fixture-gate: FAILURES above" >&2
  exit 1
fi
echo "EVIDENCE gate=lt-u5-fixtures class=behavior verdict=pass"
echo "fixture-gate: all vendored LT-U5 harnesses pass"
