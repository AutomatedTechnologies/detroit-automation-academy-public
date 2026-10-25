# phl-feed-raw

Orphan branch: raw SEPTA GTFS-RT bundles from the rebuilt Philadelphia feed chain (phl-feed-rebuild workflow, fetch-only). bundles/<collected_at>/ holds one bundle per collect; manifest.json is written last and marks a bundle complete. The VM publisher (single writer) transforms bundles from this branch and commits the finished family to main under live-transit/philadelphia/data/.
