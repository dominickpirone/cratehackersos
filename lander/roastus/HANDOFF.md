# Crate Hackers — Lander Handoff & Playbook

_How any Claude-built design gets onto **lander.cratehackers.com** — the whole pipeline in one place so we never re-figure it out._

---

## 0. TL;DR — shipping a new design

1. Claude builds the design as a self-contained folder: `index.html` + an `assets/` subfolder, **all asset paths relative** (`assets/foo.png`, never `/assets/...` or a cross-project path).
2. The folder drops into the repo at **`lander/<name>/`** (e.g. `lander/roastus/`).
3. It goes live at **`https://lander.cratehackers.com/<name>/`** after the repo updates (git push → ~30s) **or** a Render manual deploy.
4. Done. Kartra still handles all checkouts; this is just static pages.

---

## 1. Where everything lives

| Thing | Value |
|---|---|
| **GitHub repo** | `dominickpirone/cratehackersos` |
| **Branch** | `main` |
| **Lander folder** | `lander/` (this is the Render **publish directory**) |
| **A new design goes in** | `lander/<name>/index.html` (+ `lander/<name>/assets/…`) |
| **Live host** | Render → **Static Site** → `lander.cratehackers.com` |
| **Deploy trigger** | Push to `main` → Render auto-deploys the static site in ~30s |
| **Roast Us page** | `lander/roastus/` → `lander.cratehackers.com/roastus/` |

> Note: the repo's root `render.yaml` is for a **different** Render service (the Email Console / `server.js` node app). The **lander** is its own Render Static Site with publish dir `lander/`. Don't confuse the two.

---

## 2. The two ways to push a design live

### Method A — Git push (preferred, auto-deploys)
Commit the new/changed files under `lander/<name>/` to `main`. Render redeploys automatically.
- **Text files** (`.html`, `.css`, `.js`, `.gs`) commit cleanly.
- **Binary files** (PNG/JPG/QR images) must be committed via real **git** (desktop client, CLI, or GitHub's "Upload files" button) — the automated push tool can corrupt binaries, so add images by hand or `git add` them locally.

### Method B — Render manual deploy / zip upload (fallback)
If git access isn't available, download the design folder from Claude and upload it in the Render dashboard for the static site. This always works and is how the page was first shipped.

**Whichever method: after deploying, hard-refresh (or open incognito) — Render + browsers cache aggressively.** A "broken image" on the live site is almost always a stale deploy that doesn't yet contain the asset.

---

## 3. Shared infrastructure already wired in (reuse it on every page)

Copy these from `lander/roastus/index.html` into any new page so the whole stack stays consistent:

### a) Google Tag Manager (server-side, first-party)
- Container: **`GTM-53P4QHG`**, loaded first-party via **`load.gtm.cratehackers.com`** (Stape).
- Paste the GTM `<script>` in `<head>` and the `<noscript>` right after `<body>`.
- Push conversion events to `window.dataLayer` — already firing: **`roast_submitted`** (on form submit) and **`tee_claim_click`** (on the tee CTA). Build Meta/Google audiences off these in GTM.

### b) Open Graph / social preview
- Every page has `og:title`, `og:description`, and a **1200×630** `og:image` so Facebook/links show a proper big preview.
- The Roast Us banner is `assets/og-roastus.png`. New designs: generate a 1200×630 banner and point the OG/Twitter tags at its absolute URL.
- After deploy, run the URL through **Facebook Sharing Debugger** once and "Scrape Again" to bust FB's cache.

### c) Brand tokens (dark theme)
```
--bg:#0B0B0C  --bg-1:#0F0F11  --fg:#F5F3EF  --fg-dim:#B4B1AA  --accent:#ff7722
fonts: Space Grotesk (display) · Inter (body) · JetBrains Mono (mono)
logo: https://d11n7da8rpqbjy.cloudfront.net/thedjsvault/36735083587Square_Burning_Crate_Logo_VECTORIZED_TRANSPARENT_BACKGROUND.png
```

---

## 4. The lead-capture pipeline (Roast Us)

```
Roast form  →  hidden-iframe POST  →  Google Apps Script /exec  →  Google Sheet ("Roast Leads" tab)
```

- **Sheet:** `https://docs.google.com/spreadsheets/d/14s0PiTV9QmNqKmCPPSrd6mqzTvEbcpXtPqg1_x8UkxI/edit` (on the dom@ Workspace). Data lands in a tab named **`Roast Leads`** (auto-created on first submit).
- **Endpoint:** the Apps Script Web App URL is set in `index.html` as `SHEET_ENDPOINT`. The script source + deploy steps are in `lander/roastus/google-apps-script.gs`.
- Captured columns: Timestamp, Name, Email, Phone, DJ Type, Rating, Primary Use, Uses Instead Of Us, Where It Falls Apart, The Roast, Price Worth, Price No-Brainer, What Would Make A Fan, Down For Zoom?, User Agent.
- To reuse on a new page: copy the `<script>` block at the bottom of `roastus/index.html`, keep the same `SHEET_ENDPOINT` (or deploy a new Apps Script for a different sheet), and make sure the hidden `ch_hidden_iframe` is present.

### Offers wired on the page
- **Free tee:** code **`ROASTED`** on the dj.style store → `https://dj.style/discount/ROASTED?redirect=%2Fproducts%2Fcrate-hackers-sucks-unisex-t-shirt` (shipping not included). QR + button on the thanks page.
- **Roast Zoom:** Calendly `breakthedamninternet/crate-hackers-sucks-roast-us` (free month for their time).

---

## 5. Status of the CRM automation (Sheet → Kartra)

**NOT YET LIVE.** Leads are landing in the Google Sheet, but the Zap into Kartra is **not built**.

Ready on the Kartra side:
- **List:** `Crate Hackers - Roast Leads`
- **Tag:** `roast-us-leads` (in the "Crate Hackers" category)

To finish (the remaining step):
- **Zapier:** Trigger = Google Sheets "New Spreadsheet Row" (worksheet `Roast Leads`) → Action = Kartra "Create/Update Lead", map Name/Email/Phone, add to the list + apply the tag. If Kartra's native action is missing, fall back to Webhooks → Kartra inbound API.

---

## 6. Gotchas / lessons learned

- **Relative asset paths only.** `<img src="assets/x.png">` from inside `lander/<name>/`. Absolute `/assets/...` breaks because each design is its own subfolder.
- **Binary images need real git or a zip upload** — don't rely on the automated text-push tool for PNGs.
- **Stale deploy = broken images / old copy.** Redeploy and hard-refresh before assuming something's wrong.
- **GitHub access is split:** reading the repo and *writing* to it are separate grants. If a push 404s on a repo you can clearly see, the write side needs to be authorized for `dominickpirone/cratehackersos`.
- **Multiple Google logins** break Apps Script deploys — deploy from an incognito window signed in only as **dom@cratehackers…** (the Sheet owner), "Execute as: Me", "Who has access: Anyone".
