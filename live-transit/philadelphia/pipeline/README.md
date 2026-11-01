# PHL rebuilt data pipeline (R2)

**Label:** UNVERIFIED / legacy-unsigned. Local build + verification
only — nothing here is deployed.

Three separated stages (LT-KAES-19), one shared wire library
(LT-KAES-08), per-leg fault isolation with published per-source
state (LT-KAES-20), the complete VP/TU/SA × bus/rail leg set
(LT-KAES-16), the canonical published family (LT-KAES-21/23/24),
§5 trip-matching classification (LT-KAES-25), and the per-route
trip-update derivative (LT-KAES-45). SEPTA is keyless
agency-direct throughout (A3 custody; LT-KAES-17).

| File | Stage / role |
|---|---|
| `wire.py` | shared protobuf wire reader (platform code) |
| `gtfs_rt.py` | typed GTFS-RT decoders (VP / TU / SA) on `wire.py` |
| `septa_config.py` | endpoint mirror of `../config/city-config.mjs` (harness-asserted identical) |
| `classify.py` | §5 trip-matching classification vs the static sets |
| `collect.py` | COLLECT: fetch-only → raw bundle, manifest last |
| `transform.py` | TRANSFORM: bundle → the full published family |
| `publish.py` | PUBLISH: keyless single writer, atomic swap, publish-manifest |
| `run_pipeline.py` | local end-to-end driver (collect→transform→publish) |
| `test_classify.py` | §5 classification unit cases (7/7) |

## Run it locally

```
python3 run_pipeline.py --staging-root ../staging
python3 run_pipeline.py --staging-root ../staging --fail-leg bus-sa   # leg-kill test
node ../harness/verify-pipeline.mjs ../staging/run-<stamp>            # validators + reconciliation
node ../harness/verify-foundation.mjs                                 # R1 foundation (must stay 48/48)
python3 test_classify.py
```

Statics for classification default to the retained A3 copies at
`../../gtfs/google_bus.zip` / `google_rail.zip` (bus: 35,810
trips / 168 routes; rail: 2,340 trips / 13 routes).
