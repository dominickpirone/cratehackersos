# Crate Hackers — Email Console

A simple web app for sending broadcast emails through Postmark, with audience
segments and analytics. It replaces the `postmark-batch-send.js` command-line
script with a point-and-click interface: paste an email from Claude, pick who
gets it, hit send.

## Run it

```bash
cd webapp
node server.js
```

Then open **http://localhost:4321** in your browser. No `npm install` needed —
it uses only built-in Node (requires Node 18+).

## First-time setup (2 minutes)

1. Open the app → **Settings** tab.
2. Paste your **Postmark Broadcast server token** (Postmark → your server →
   API Tokens). This must be the *Broadcasts* stream server, not transactional.
3. Confirm the From email / name / stream, then **Save settings** and
   **Test connection**.
4. (Optional) Paste a read-only **Stripe key** to show revenue on the
   Analytics tab.

Settings are saved to `config.local.json` (gitignored — your token never leaves
this machine).

## How you'll use it

### Compose & Send
- Type a **subject** and paste the **HTML email** from Claude into the body.
  Use `{{first_name}}` anywhere and it's personalized per recipient.
- Hit **Preview** to render it exactly as recipients will see it.
- Pick one or more **audiences**. The **suppression list is always excluded.**
- **Preview recipients** shows the real count after dedupe/suppression.
- **Send test to me** first. Then **Send to audience →** (asks for confirmation
  and shows a live progress bar as it sends in batches of 500).

### Audiences
Each segment is just a CSV with an `email` column (and optional `first_name`).
Export from Kartra / Stripe / wherever, then upload here and name it — e.g.
`members`, `non-members`, `cancellations`. Update a segment any time by
uploading a CSV with the same name. The **suppression list** holds addresses to
permanently exclude (bounces, complaints, opt-outs).

> Members list is pre-loaded (`data/segments/members.csv`, ~6,300 people).
> To send to cancellations or non-members, export those lists and upload them
> as new segments.

### Analytics
- **Sent / open rate / click rate / click-to-open / bounces / spam** for any
  date range, pulled live from Postmark.
- **Campaign history** — every send is logged with per-campaign opens & clicks
  (tracked via a Postmark tag).
- **Sales** — revenue across **Stripe** (net of refunds), **PayPal**, and
  **Kartra**, with a combined total + per-source breakdown for the selected
  date range. Connect any/all under Settings → Sales connections.

### Sales connections (Settings)
Kartra runs its payments through Stripe & PayPal, so connecting those two gets
you the real money data directly:

- **Stripe** — paste a secret/restricted key (read access to Charges &
  Subscriptions). This also unlocks the **auto-built segments** below.
- **PayPal** — REST app **Client ID + Secret** (developer.paypal.com →
  Apps & Credentials). Choose Live or Sandbox. Pulls via the Transaction
  Search API (auto-chunked into 31-day windows).
- **Kartra** — App ID + API key + API password (beta; if your Kartra account
  uses different API action names, adjust `getKartraSales` in `server.js`).

Use **Test connections** to confirm each one before relying on the numbers.

### Auto-built segments from Stripe
On the **Audiences** tab, **Build active / canceled from Stripe** pulls live
subscription data and writes two segments:
- `stripe-active` — active, trialing, and past-due subscribers
- `stripe-canceled` — canceled subscribers (excluding anyone who resubscribed)

That's the easiest way to "email everyone with an active subscription" or
"email cancellations" without exporting CSVs by hand.

## Where things live

```
webapp/
  server.js              the app (zero dependencies)
  public/                the UI (index.html, app.js, styles.css)
  data/
    segments/*.csv       your audiences
    suppression.csv      always-excluded addresses
    campaigns.json       send history (powers analytics)
  config.local.json      your token + settings (gitignored)
```

## Notes
- Open & click tracking are enabled on every send, which is what makes the
  open/click rates work.
- If a batch has any failures (e.g. Postmark inactive/bounced addresses), they're
  saved to `data/failed_<tag>.json` so nothing is lost.
- This sends on your **broadcast** stream — never transactional — matching the
  original script.
```
