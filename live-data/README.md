# live-data — static live feed for Live Transit Detroit

`vehicles.json` and `alerts.json` in this directory are **generated
files**, republished by the `Live transit feed (static JSON)` GitHub
Actions workflow (`.github/workflows/live-feed.yml`, script:
`tools/feed/build-feed.mjs`) on a 5-minute cron. Do not edit them by
hand; the next run overwrites them.

They carry the same payload envelopes the page consumed from the
retired Netlify proxy (`/api/vehicles`, `/api/alerts`) before Netlify
quota-paused that site on 2026-10-15:

- `vehicles.json`: `{generated_at, count, vehicles[], sources}` —
  DDOT (Clever Devices BusTime) + QLINE (public GTFS-RT). SMART was
  removed from the product on 2026-10-15 and is reported under
  `sources.smart` as an explicit removed state, never as data.
- `alerts.json`: `{generated_at, count, alerts[], sources}` — DDOT
  BusTime service bulletins.

The DDOT leg reads its BusTime key from the `DDOT_BUSTIME_KEY` GitHub
Actions secret. Until that secret is set, `sources.ddot` reports a
named not-configured state and the DDOT vehicle list is empty by
design — the QLINE leg publishes normally.

`generated_at` is the moment the file's content was generated; the
page displays it as the feed's "updated" time. A file is rewritten
only when its content changed materially (or after a 30-minute
heartbeat), so an older `generated_at` means the underlying data had
not changed — not that the pipeline stopped.
