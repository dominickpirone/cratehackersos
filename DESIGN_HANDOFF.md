# Design handoff — Crate Hackers Email Console

Give this file (plus the three UI files) to any design tool/assistant. It explains
what the app is, what you can freely change, and the **one rule** that keeps the
app working: don't break the element IDs the JavaScript depends on.

## The only 3 files that control the UI
- `public/index.html` — markup / structure
- `public/styles.css` — all styling (colors, spacing, type, layout)
- `public/app.js` — behavior (talks to the backend). **Restyle freely; just keep the IDs below.**

You do **not** need to touch `server.js` — that's the backend and has no visual output.

## What the app does
A simple internal tool for one person (Dominick) to send broadcast emails to
Crate Hackers members and see analytics. It is NOT a public website — optimize for
fast, confident daily use, not marketing polish.

### Four screens (tabs)
1. **Compose & Send** — write a subject, paste an HTML email, preview it, pick an
   audience, preview the recipient count, send a test, then send to everyone with a
   live progress bar.
2. **Audiences** — manage recipient lists (CSV segments) + a suppression list, with
   a guide for exporting members from Kartra.
3. **Analytics** — KPIs (sent, open rate, click rate, bounces), a sales panel
   (Stripe/PayPal revenue), and a campaign history table.
4. **Settings** — Postmark token + sender info, and sales connections (Stripe,
   PayPal, Kartra).

## Current design language (change as you like)
- Dark theme. Tokens live at the top of `styles.css` under `:root` — edit those
  variables to re-skin the whole app at once (`--bg`, `--panel`, `--accent`, etc.).
- Accent is an orange (`--accent: #ff5a3c`); secondary teal (`--accent2`).
- System font stack, ~14px base.

## THE ONE RULE: keep these element IDs (JavaScript reads them)
You may restructure HTML, change classes, restyle anything — but every element
below must keep its `id`. If you rename or remove one, that feature stops working.
(If you'd rather rename them, you must also update the matching `$("#id")` lines in
`app.js`.)

**Global / nav**
`conn`, `toast`, plus the four `<button class="tab" data-tab="...">` with
`data-tab` values: `compose`, `audiences`, `analytics`, `settings`. The four
`<section>` panels have ids `compose`, `audiences`, `analytics`, `settings`.

**Compose & Send**
`subject`, `audience`, `modeHtml`, `modePreview`, `html`, `previewFrame`, `text`,
`previewBtn`, `previewOut`, `testEmail`, `testBtn`, `sendBtn`, `sendProgress`,
`barFill`, `progressText`

**Audiences**
`segList`, `segName`, `segFile`, `segUpload`, `suppressBox`, `suppressSave`
(delete buttons are generated with `data-del`)

**Analytics**
`anFrom`, `anTo`, `anRefresh`, `kpis`, `salesBox`, `campTable` (with its
`<tbody>`), `campEmpty` (rows are generated with `data-opens` / `data-clicks`)

**Settings**
`setToken`, `setFromEmail`, `setFromName`, `setStream`, `setReplyTo`,
`setTestEmail`, `setSave`, `setTest`, `setMsg`, `setStripe`, `setPaypalId`,
`setPaypalSecret`, `setPaypalEnv`, `setKartraApp`, `setKartraKey`,
`setKartraPass`, `setSalesSave`, `setSalesTest`, `salesMsg`

## How to preview your changes
```bash
cd webapp
node server.js      # then open http://localhost:4321
```
Edit the files, save, refresh the browser. No build step.

## Good things to improve (suggested brief)
- Make Compose feel like the primary action; reduce visual weight elsewhere.
- Clearer empty/loading/success states (sending, no-segments-yet, no-stats-yet).
- A more confident "send to everyone" confirmation step.
- Analytics KPIs that read at a glance; nicer campaign table.
- Mobile/narrow layout polish.
