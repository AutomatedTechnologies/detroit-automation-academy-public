#!/usr/bin/env python3
"""run_pipeline.py — local end-to-end driver for the R2 pipeline.

PHL REBUILD R2. Label: UNVERIFIED / legacy-unsigned.

Runs collect -> transform -> publish into one local staging run
directory and writes run-report.json joining the three stage
reports. This is the LOCAL verification driver; the production
chain (rebuild/chain/) runs the same three stages split across
the collect workflow and the VM publisher, per LT-D6.

  run_pipeline.py --staging-root DIR [--fail-leg LEG_ID]
                  [--static ZIP]

--fail-leg is the leg-kill test hook: the named leg is forced to
fail in the collect stage; a correct pipeline still completes,
publishes the family, and names the failed leg in every affected
envelope's per-source state (LT-KAES-20).
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import collect as collect_stage  # noqa: E402
import publish as publish_stage  # noqa: E402
import transform as transform_stage  # noqa: E402

DEFAULT_STATIC = HERE.parent / "static" / "google_transit-1.zip"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--staging-root", required=True)
    ap.add_argument("--fail-leg", default=None)
    ap.add_argument("--static", default=str(DEFAULT_STATIC))
    args = ap.parse_args()

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = Path(args.staging_root) / f"run-{stamp}"
    run_dir.mkdir(parents=True, exist_ok=True)
    bundle_dir = run_dir / "raw-bundle"
    transform_dir = run_dir / "transform-out"
    published_dir = run_dir / "published"

    rc = collect_stage.collect(bundle_dir, fail_leg=args.fail_leg)
    if rc != 0:
        print(f"run: collect failed rc={rc}", file=sys.stderr)
        return rc
    rc = transform_stage.transform(bundle_dir, transform_dir, args.static)
    if rc != 0:
        print(f"run: transform failed rc={rc}", file=sys.stderr)
        return rc
    rc = publish_stage.publish(transform_dir, published_dir)
    if rc != 0:
        print(f"run: publish failed rc={rc}", file=sys.stderr)
        return rc

    manifest = json.loads((bundle_dir / "manifest.json").read_text(encoding="utf-8"))
    treport = json.loads(
        (transform_dir / "transform-report.json").read_text(encoding="utf-8")
    )
    pmanifest = json.loads(
        (published_dir / "publish-manifest.json").read_text(encoding="utf-8")
    )
    report = {
        "run_dir": str(run_dir),
        "fail_leg": args.fail_leg,
        "collect": {
            "legs_ok": manifest["legs_ok"],
            "legs_total": manifest["legs_total"],
            "legs": {
                k: {"ok": v["ok"], "error": v["error"], "bytes": v["bytes"]}
                for k, v in manifest["legs"].items()
            },
        },
        "transform": treport,
        "publish": {
            "file_count": pmanifest["file_count"],
            "generated_at": pmanifest["generated_at"],
        },
    }
    (run_dir / "run-report.json").write_text(
        json.dumps(report, indent=1), encoding="utf-8"
    )
    print(f"run: complete -> {run_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
