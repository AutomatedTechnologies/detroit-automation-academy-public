# planner/ — the hosted engine bundle (R4)

**Label:** UNVERIFIED / legacy-unsigned. Local build only; nothing
here is deployed.

This directory is the staged planner bundle of record
(`hidden_files/integration-staging/bundle/`, verification PASS
7/7, LT-N12) copied **byte-identically** at R4 build time, per the
R1 planner-host contract (KAES-07 anti-fork: the bundle is hosted,
never re-derived). `modules/planner-host.mjs` wires it behind the
rebuilt client's contracts; `worker-entry.mjs` runs the same host
inside a worker.

Identities (MD5, re-verified in `harness/verify-planner.mjs` §A
against the staging verification record):

| File | MD5 |
|---|---|
| engine/raptor-v2-set.js | `6746dfbc3aae7c531e42206478d572da` |
| lib/selection.mjs | `d7d405600a49ea81fb152061fd8883ae` |
| lib/signature.mjs | `55d49c0c0a1eb98db4dbe5db0c1b1404` |
| lib/archetypes-v2.mjs | `79d5d6b9383ff4840f5b90281522a851` |
| lib/loader.mjs | `0153d149fa58931a19891c37e708eea1` |
| assets/planner-timetable-v202609271-v202609271.json | `c27c0d1326b4cbbd5718b5a78d1a423b` |
| assets/stops-sidecar.json | `ea3e1c14a7b81c0ffeee3e084ac2fd36` |
| assets/trip-map.json | `4b1366a746737ed156ff781a1a09988b` |
| config/phl-planner-config.json | `28d81f148f733e7273478fc9fbed62bd` |

Notes:

- `assets/trip-map.json` is compiler-side only — never read at
  runtime (carried for bundle completeness, as in staging).
- Deploy names at the ship gate differ for two assets
  (stops-sidecar.json ships as `planner-stops.json`); identity is
  the bytes, not the name.
- The timetable's rail vintage ends **2026-11-21**; the staged
  asset must be rebuilt from the successor rail zip before any
  page build ships after that date (refresh due by 2026-11-14,
  GATED — carried from R1 verbatim).
- The day-compiled timetables the host derives at runtime (M2)
  are in-memory derivatives of this asset — never written here.
