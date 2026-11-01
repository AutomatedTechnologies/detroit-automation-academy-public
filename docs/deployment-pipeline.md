# Deployment Pipeline — Dev → UAT → Production

**Effective:** 2026-10-09 · **Rule:** no site change reaches production without passing UAT.

## Environments

| Environment | Branch | URL | Purpose |
|---|---|---|---|
| Dev | `dev` | `https://daa-dev.netlify.app` | Build and iterate. Break things here. |
| UAT | `uat` | `https://daa-uat.netlify.app` | User-acceptance testing. Must mirror production. |
| Production | `main` | `https://www.detroitautomationacademy.com` | Live site. GitHub Pages. |

Dev and UAT are Netlify sites tracking the `dev` and `uat` branches of
`smit4786/detroit-automation-academy-public`. They serve from domain root, so
absolute paths behave exactly as in production. Production stays on GitHub
Pages from `main` (unchanged).

## Flow

```
feature work → dev → (dev auto-deploys) → merge dev→uat → (uat auto-deploys)
  → UAT PASS 1 (first-time user) → UAT PASS 2 (power user)
  → both pass → merge uat→main → (Pages deploys) → verify production live
```

1. **Build on Dev.** All site changes are committed to `dev` first (directly or
   via feature branches merged into `dev`). Every push to `dev` auto-deploys to
   the Dev URL. Iterate freely.
2. **Promote to UAT.** Merge `dev` into `uat`. Every push to `uat` auto-deploys
   to the UAT URL. No further code changes on `uat` except hotfixes that restart
   the UAT cycle.
3. **UAT — two passes, both required.** Run against the UAT URL (protocol below).
   Any failure: fix on `dev`, re-merge to `uat`, restart UAT from Pass 1.
4. **Promote to Production.** Merge `uat` into `main`. The Pages workflow
   deploys. Then verify production is live (protocol below).
5. **Done.** Record the change in `bugfix-log.md` (or the changelog) with the
   UAT result.

## UAT Protocol

### Pass 1 — First-time user
Simulates a new visitor. Fresh browser profile: no cache, no cookies, no
localStorage, no service workers.

- [ ] Changed page(s) load with no console errors.
- [ ] Primary content renders (for live-transit: 3D scene initializes, feed
      connects, buses appear on the map).
- [ ] Primary user flow completes (for live-transit: tap a stop, build a trip).
- [ ] Site nav works; no 404s on linked pages.
- [ ] Mobile viewport (iPhone): layout intact, menu reachable.

### Pass 2 — Power user
Simulates a returning visitor. Warm cache, exercises depth.

- [ ] Advanced/adjacent flows work (filters, trip planner modes, deep links).
- [ ] No regressions on untouched pages (spot-check 3).
- [ ] Repeat Pass 1's critical path to confirm stability.
- [ ] Performance sane (no hung loads, no runaway network retries).

Both passes are run by the agent via automated browser against the UAT URL,
unless the change needs his eyes (visual design) — then he is asked to check
UAT before the production merge.

## Production verification

After the `main` merge and Pages deploy:

- [ ] Served bytes: the changed asset contains the change (not just workflow green).
- [ ] Cache stamps bumped on every changed JS/CSS reference.
- [ ] Smoke UAT on the live URL: load the changed page, confirm the fix/feature.
- [ ] Homepage + one adjacent page spot-check.

## Rollback

If production breaks: `git revert` the merge commit on `main` and push. Pages
redeploys the previous state. Then diagnose on `dev`. Never hotfix `main`
directly — the fix goes through the pipeline like everything else.

## Standing rules this pipeline enforces

- Diff local files against the repo before pushing (2026-10-09 incident).
- Byte verification ≠ UAT. A deploy is done only after behavioral verification.
- `signal/` is never touched by site deploys.
