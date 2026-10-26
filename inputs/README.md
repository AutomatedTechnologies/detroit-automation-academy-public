# PHL refresh inputs — baked SEPTA wave v202609271 (custody copies)

Local custody copies of SEPTA's published GTFS downloads, byte-identical
to the inputs of the Board 65 item 3 verified union compile:

- `google_bus.zip` — 21,287,034 B, MD5 `22901c5d45f9ab7ffa572bae173a833b`
- `google_rail.zip` — 767,481 B, MD5 `01c96ba3040841a000809294d1e5f32d`

SEPTA's developer endpoints now serve only the successor wave
(v202611010), and no public archive carries this vintage (Wayback
Machine and Mobility Database mirrors checked 2026-10-26), so this
branch is the in-repo custody record the one-time refresh workflow
(`.github/workflows/phl-rail-refresh.yml` on main) builds from.
