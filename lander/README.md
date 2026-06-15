# CrateHackers Landers

Static landing pages served from this repo via **Render → `lander.cratehackers.com`**.
Edit HTML → `git push` → live in ~30 seconds. Kartra still handles all checkouts.

## Structure

```
lander/
  level11/
    index.html       # A/B/C rotator — the entry point (/level11)
    sales-a.html     # "…doing it alone."
    sales-b.html     # "…buried in the noise."
    sales-c.html     # "…where to start."
    ty-monthly.html  # thank-you, Monthly tier
    ty-annual.html   # thank-you, Annual tier
    ty-lifetime.html # thank-you, Lifetime tier
  shared/
    level11.css      # ONE shared stylesheet for every page — edit a button once, all pages update
  render.yaml        # Render blueprint (move to repo root if lander/ is nested)
```

## Public URLs (after DNS + Render are live)

| URL | Serves |
|---|---|
| `lander.cratehackers.com/level11` | rotator → random sticky A/B/C |
| `lander.cratehackers.com/level11/sales-a.html` (b, c) | a specific variant directly |
| `lander.cratehackers.com/level11-ty-monthly` | Monthly thank-you |
| `lander.cratehackers.com/level11-ty-annual` | Annual thank-you |
| `lander.cratehackers.com/level11-ty-lifetime` | Lifetime thank-you |

Point each Kartra product's **post-purchase redirect** at the matching `…-ty-…` URL.

## The A/B/C rotator

`level11/index.html` assigns each visitor a variant at random, **remembers it** (localStorage + a 30-day cookie), and redirects to that variant. Returning visitors always see the same one.

- Force a variant for testing or a specific ad: `/level11?v=b`
- Every assignment pushes a `dataLayer` event `l11_variant_assigned` (and each sales page pushes `l11_sales_view`). Wire those into GA4 / a webhook where marked in the code to track which headline converts.
- The buyer's variant is also readable as `window.L11_VARIANT` on the sales page and the `l11_variant` cookie at checkout.

## Render setup (one time)

1. **Push this repo to GitHub** (the CrateHackers OS repo is fine — landers live in `/lander`).
2. Render Dashboard → **New → Static Site** → connect the repo.
   - **Publish directory:** `lander`  (or import `render.yaml` via **New → Blueprint** instead, which sets this + the pretty-URL routes automatically)
   - **Build command:** *(leave blank — static)*
3. After first deploy you get a `*.onrender.com` URL. Confirm the pages load.
4. Render → your site → **Settings → Custom Domains → Add** `lander.cratehackers.com`.

## DNS (at your domain registrar / DNS host for cratehackers.com)

Render will show the exact target, but it's a **CNAME**:

| Type | Name | Value |
|---|---|---|
| CNAME | `lander` | `<your-site>.onrender.com` (shown in Render) |

TLS is issued automatically by Render once the CNAME resolves (a few minutes). Done.

## Kartra checkout note

The pages use Kartra's embed (`pay.js` + `data-kt-*` popups) — that's just JavaScript and runs anywhere. **One setting to check:** in Kartra, make sure embeds are allowed on `lander.cratehackers.com` (Kartra may restrict embed domains). Test one checkout popup end-to-end before sending traffic.

## Editing the countdown

Each sales page has a `CLOSE_TARGET = Date.UTC(...)` line in its inline script — currently **Wed Jun 17 2026, 12:59 PM ET**. Change it there; it controls the compact countdown bar.
