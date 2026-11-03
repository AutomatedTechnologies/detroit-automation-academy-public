# Detroit Automation Academy — Public Site Source

Public website source for [detroitautomationacademy.com](https://www.detroitautomationacademy.com). Served via GitHub Pages from the `main` branch.

## Contents

- `index.html` — Homepage
- `live-transit.html` / `live-transit.js` — Live Transit Detroit: real-time 3D map of DDOT and SMART bus positions
- `signal/` — The Signal newsletter archive (transit-focused since October 2026)
- `watch/` — Multimedia hub: virtual tours and video content
- `apple-learning-coach/` — Apple Learning Coach certification page
- `assets/` — Images, video, 3D data files (`ddot-routes-3d.json`, `smart-routes-3d.json`)
- `voter-guide.html` — Detroit voter guide
- `press/` — Press page

## Deployment

Push to `main` triggers a GitHub Pages build. No build step; static files are served as-is.

Branch workflow for Live Transit changes: `dev` → `uat` (two passes: cold, then warm) → `main` → verify production.

JavaScript and CSS changes require a cache-stamp bump (`?v=YYYYMMDD-HHMM`) on the referencing tag.

## License

© 2026 Detroit Automation Academy. All rights reserved. See [LICENSE](./LICENSE).
