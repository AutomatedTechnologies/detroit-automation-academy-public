#!/usr/bin/env python3
"""evidence_verdict.py — evidence-class aggregation for CI output.

Every gate in this pipeline tags its verdict with the class of
evidence it rests on (directive 2026-11-01):

  behavior — real execution decided it: a browser booted the page
             (boot-smoke), or the real event handlers ran against
             the real tree (LT-U5 fixtures).
  bytes    — byte equality / static content decided it: shell
             contract, manifest recompute, referential integrity,
             served-byte verification.
  claim    — a report was taken at face value; nothing was
             independently checked. No current gate emits this
             class for a pass; it exists so a future report-only
             check can never silently dress as proof.

The headline release verdict carries the LOWEST evidence class
present in the set: a green that rests on byte checks at its
weakest point is a bytes-class green, and can never present as
behavior-verified. (On a FAIL, the headline class is the lowest
class among the failing gates.) Gates that were skipped are
listed but excluded from the set. If NO evidence lines are
found, the pipeline produced no evidence at all — that is a
process failure and this script exits 1 with verdict UNKNOWN /
class claim.

Usage: evidence_verdict.py GATE_LOG [GATE_LOG ...]
Reads EVIDENCE lines from the given logs, prints the per-gate
table + RELEASE-VERDICT line, appends a markdown summary to
$GITHUB_STEP_SUMMARY when set, and (when $GITHUB_OUTPUT is set)
exports verdict= and evidence_class= for downstream jobs.
"""

import os
import re
import sys

LINE_RE = re.compile(
    r"^EVIDENCE gate=(?P<gate>\S+) class=(?P<cls>bytes|behavior|claim) "
    r"verdict=(?P<verdict>pass|fail|skip)\s*$",
    re.M,
)
CLASS_RANK = {"claim": 0, "bytes": 1, "behavior": 2}


def main(argv):
    gates = []
    for path in argv:
        try:
            text = open(path, encoding="utf-8", errors="replace").read()
        except OSError as e:
            print(f"evidence-verdict: cannot read {path}: {e}", file=sys.stderr)
            return 1
        gates += LINE_RE.findall(text)
    if not gates:
        print("RELEASE-VERDICT verdict=UNKNOWN evidence-class=claim")
        print(
            "evidence-verdict: no EVIDENCE lines found — "
            "the pipeline produced no evidence",
            file=sys.stderr,
        )
        return 1
    present = [(g, c, v) for (g, c, v) in gates if v != "skip"]
    if not present:
        # Every gate was skipped: this stage verified nothing, so
        # its verdict rests on no evidence — class claim.
        print("RELEASE-VERDICT verdict=SKIP evidence-class=claim")
        _emit_outputs("SKIP", "claim")
        return 0
    failing = [(g, c) for (g, c, v) in present if v == "fail"]
    if failing:
        verdict = "FAIL"
        headline = min((c for _, c in failing), key=lambda c: CLASS_RANK[c])
    else:
        verdict = "PASS"
        headline = min((c for _, c, _ in present), key=lambda c: CLASS_RANK[c])
    strongest = max((c for _, c, _ in present), key=lambda c: CLASS_RANK[c])

    lines = ["Evidence set:"]
    for g, c, v in gates:
        lines.append(f"  {g:<20} class={c:<8} verdict={v}")
    lines.append(
        f"RELEASE-VERDICT verdict={verdict} evidence-class={headline} "
        f"(strongest present: {strongest})"
    )
    print("\n".join(lines))

    _emit_outputs(verdict, headline, gates, strongest)
    return 0


def _emit_outputs(verdict, headline, gates=None, strongest=None):
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write("### Release verdict\n\n")
            f.write(f"**{verdict}** — evidence class: **{headline}**")
            if strongest:
                f.write(" (headline = lowest class present; ")
                f.write(f"strongest present: {strongest})\n\n")
            else:
                f.write("\n\n")
            if gates:
                f.write("| Gate | Evidence class | Verdict |\n|---|---|---|\n")
                for g, c, v in gates:
                    f.write(f"| {g} | {c} | {v} |\n")
                f.write("\n")
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as f:
            f.write(f"verdict={verdict}\n")
            f.write(f"evidence_class={headline}\n")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
