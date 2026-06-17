# Claude Design → Crate Hackers OS — Lander Deploy Handoff

How to get landing pages live on **lander.cratehackers.com** without going back to Claude Code.

## TL;DR
Landers are plain static HTML in this repo under `lander/`. To ship one: drop the `.html`
into `lander/level11/`, follow the conventions below, then **push** (double-click the
Desktop launcher). Render auto-deploys in ~30 seconds.

---

## Where things live
- **Repo:** `github.com/dominickpirone/cratehackersos` (private) — local copy at
  `…/Crate Hackers/challenge-send/webapp/`
- **Render static site:** publishes the `lander/` folder to **lander.cratehackers.com**
- `lander/level11/` — the funnel pages (`index.html` rotator, `sales-a/b/c.html`,
  `ty-monthly/annual/lifetime.html`, `lastcall.html`)
- `lander/shared/level11.css` — the ONE shared stylesheet for every page
- `lander/shared/level11-analytics.js` — funnel tracking (GTM + first-party pixel)

## Page authoring conventions — every new page MUST follow these
1. **Shared CSS:** `<link rel="stylesheet" href="../shared/level11.css">`
2. **Funnel tracking (required):** `<script src="../shared/level11-analytics.js"></script>` in `<head>`
3. **Name the variant** so the funnel can attribute it — right after `<body>`:
   `<script>window.L11_VARIANT="lastcall";</script>` (use a unique slug per page)
4. **Absolute internal paths only.** Use `/level11/sales-a.html`, never `sales-a.html`.
   Pretty URLs (no trailing slash) break relative paths — this bit us before.
5. **Kartra checkout:** keep the `data-kt-type="pay"` anchors + the `pay.js` script tag.
   Product IDs: **monthly = `ERtngCz5OV9c`**, **annual = `dfDUK7Z4QICp`**, owner `Pr2bAmrM`.
   The funnel auto-fires a `cta` event whenever one is clicked.
6. **Countdown:** edit the `CLOSE_TARGET = Date.UTC(YYYY, M-1, D, hourUTC, min, 0)` line in the
   page's inline script (1 PM ET = 17:00 UTC).
7. **Assets** (logo, screenshots) load from the CloudFront CDN — no local image files.
8. **Do NOT add a `render.yaml`** inside `lander/` — routing is managed on the Render service (below).

## Funnel tracking is automatic
Because of #2/#3, each page shows up in the OS **Funnel** tab as its own variant
(visitors → checkout clicks). Thank-you pages that include
`<div id="l11ty" data-tier="monthly|annual|lifetime">` also fire the conversion + revenue
event. Nothing extra to wire.

## Deploy — no Claude Code required
1. Put the page in `lander/level11/` (Finder, or have Claude Design save it there).
2. **Double-click `Deploy-Landers.command` on the Desktop.** (Or in Terminal:
   `cd <repo>/webapp && git add lander && git commit -m "lander update" && git push`.)
3. Render auto-deploys in ~30s. Page is live at `lander.cratehackers.com/level11/<name>.html`.
   - If it hasn't updated in ~2 min, open Render → **cratehackers-lander** →
     **Manual Deploy → Deploy latest commit**.

## Pretty URLs (e.g. `/lastcall` instead of `/level11/lastcall.html`)
One-time per page, in the **Render dashboard** (no code):
Render → the **cratehackers-lander** service → **Redirects/Rewrites** → **Add Rule** →
Type **Rewrite**, Source `/yourpath`, Destination `/level11/yourfile.html`.
Already configured: `/level11`, `/level11-ty-monthly`, `/level11-ty-annual`,
`/level11-ty-lifetime`, `/lastcall`.

## New-page checklist
- [ ] File saved in `lander/level11/`
- [ ] Links `../shared/level11.css`
- [ ] Includes `../shared/level11-analytics.js`
- [ ] Sets `window.L11_VARIANT`
- [ ] Absolute internal paths
- [ ] Kartra buttons + `pay.js` intact
- [ ] Countdown `CLOSE_TARGET` set
- [ ] Pushed (Deploy-Landers.command)
- [ ] (optional) Pretty-URL rewrite added in Render
