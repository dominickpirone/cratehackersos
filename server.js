#!/usr/bin/env node
/**
 * Crate Hackers — Email Console
 * =============================
 * A small zero-dependency web app that turns the Postmark batch-send script
 * into an easy paste-and-send interface with audience segments + analytics.
 *
 *   node server.js          # then open http://localhost:4321
 *
 * Everything lives in ./data:
 *   data/segments/*.csv     audiences (email,first_name)
 *   data/suppression.csv    addresses to always exclude
 *   data/campaigns.json     send history (powers analytics)
 *   config.local.json       Postmark token + settings (gitignored)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const auth = require("./auth");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
// DATA_DIR lets the cloud host point this at a persistent disk (e.g. Render /data).
const DATA = process.env.DATA_DIR || path.join(ROOT, "data");
const SEGMENTS = path.join(DATA, "segments");
const SMS_SEGMENTS = path.join(DATA, "sms-segments");
const RECIPIENTS = path.join(DATA, "recipients");
const JOBS_DIR = path.join(DATA, "jobs");
const PHONE_EMAIL_MAP = path.join(DATA, "phone-email-map.json");
const PHONE_LTV_MAP = path.join(DATA, "phone-ltv-map.json");
const SUPPRESSION = path.join(DATA, "suppression.csv");
const CAMPAIGNS = path.join(DATA, "campaigns.json");
// CONFIG_PATH lets settings saved via the UI persist on the cloud disk too.
const CONFIG = process.env.CONFIG_PATH || path.join(ROOT, "config.local.json");

const PORT = process.env.PORT || 4321;
const BATCH_SIZE = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ---------- config ----------
function loadConfig() {
  let cfg = {};
  if (fs.existsSync(CONFIG)) {
    try { cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch {}
  }
  return {
    postmarkToken: cfg.postmarkToken || process.env.POSTMARK_SERVER_TOKEN || "",
    fromEmail: cfg.fromEmail || process.env.FROM_EMAIL || "dom@cratehackers.com",
    fromName: cfg.fromName || process.env.FROM_NAME || "Dominick — Crate Hackers",
    stream: cfg.stream || process.env.POSTMARK_STREAM || "broadcast",
    replyTo: cfg.replyTo || process.env.REPLY_TO || "",
    stripeKey: cfg.stripeKey || process.env.STRIPE_SECRET_KEY || "",
    paypalClientId: cfg.paypalClientId || process.env.PAYPAL_CLIENT_ID || "",
    paypalSecret: cfg.paypalSecret || process.env.PAYPAL_SECRET || "",
    paypalEnv: cfg.paypalEnv || process.env.PAYPAL_ENV || "live",
    kartraAppId: cfg.kartraAppId || process.env.KARTRA_APP_ID || "",
    kartraApiKey: cfg.kartraApiKey || process.env.KARTRA_API_KEY || "",
    kartraApiPassword: cfg.kartraApiPassword || process.env.KARTRA_API_PASSWORD || "",
    mailgunApiKey: cfg.mailgunApiKey || process.env.MAILGUN_API_KEY || "",
    mailgunDomain: cfg.mailgunDomain || process.env.MAILGUN_DOMAIN || "",
    mailgunRegion: cfg.mailgunRegion || process.env.MAILGUN_REGION || "us",
    mailgunFromEmail: cfg.mailgunFromEmail || process.env.MAILGUN_FROM_EMAIL || "",
    mailgunFromName: cfg.mailgunFromName || process.env.MAILGUN_FROM_NAME || "",
    mailgunClickTracking: cfg.mailgunClickTracking === true, // default off → links go direct (secure), no redirect domain

    salesLedgerCsvUrl: cfg.salesLedgerCsvUrl || process.env.SALES_LEDGER_CSV_URL ||
      "https://docs.google.com/spreadsheets/d/1nsgP56EOuIkxynvCK0Qn7XuqRk8Bm4aRgMl3JExNGec/export?format=csv&gid=0",
    // Meta (Facebook/Instagram) ad spend — live spend vs sales in the July 4 funnel
    metaAccessToken: cfg.metaAccessToken || process.env.META_ACCESS_TOKEN || "",
    metaAdAccountId: cfg.metaAdAccountId || process.env.META_AD_ACCOUNT_ID || "706544896413478",
    metaCampaignFilter: cfg.metaCampaignFilter || process.env.META_CAMPAIGN_FILTER || "4th of july",
    // manual ad-spend fallback (used until a Meta token is set); editable in the July 4 view
    adSpendManual: (typeof cfg.adSpendManual === "number") ? cfg.adSpendManual
      : (process.env.ADSPEND_MANUAL ? parseFloat(process.env.ADSPEND_MANUAL) : null),
    twilioAccountSid: cfg.twilioAccountSid || process.env.TWILIO_ACCOUNT_SID || "",
    twilioAuthToken: cfg.twilioAuthToken || process.env.TWILIO_AUTH_TOKEN || "",
    twilioFromNumbers: cfg.twilioFromNumbers || process.env.TWILIO_FROM_NUMBERS || "",
    twilioMessagingServiceSid: cfg.twilioMessagingServiceSid || process.env.TWILIO_MESSAGING_SERVICE_SID || "",
    // additional Twilio sender accounts (e.g. other companies) — [{id,label,accountSid,apiKeySid,apiKeySecret,fromNumbers,messagingServiceSid}]
    smsAccounts: Array.isArray(cfg.smsAccounts) ? cfg.smsAccounts : [],
    quoApiKey: cfg.quoApiKey || process.env.QUO_API_KEY || "",
    quoFromNumber: cfg.quoFromNumber || process.env.QUO_FROM_NUMBER || "",
    // dedicated "Hacker Hotel HQ" Quo number for Sell By Chat texts; falls back to the main one
    hhFromNumber: cfg.hhFromNumber || process.env.HH_FROM_NUMBER || "",
    testEmail: cfg.testEmail || process.env.TEST_EMAIL || "dom@cratehackers.com",
    testPhone: cfg.testPhone || process.env.TEST_PHONE || "",
    groqApiKey: cfg.groqApiKey || process.env.GROQ_API_KEY || "",
    adIngestToken: cfg.adIngestToken || process.env.AD_INGEST_TOKEN || "",
    scrapeCreatorsKey: cfg.scrapeCreatorsKey || process.env.SCRAPECREATORS_API_KEY || "",
  };
}
function saveConfig(patch) {
  const cfg = loadConfig();
  const merged = { ...cfg, ...patch };
  fs.writeFileSync(CONFIG, JSON.stringify(merged, null, 2));
  return merged;
}

// ---------- CSV ----------
function parseCSV(content) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (inQuotes) {
      if (c === '"' && content[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && content[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------- flexible column detection (Skool, Kartra, Zoom, Stripe, generic) ----------
// Exact header names take priority; then substring; then we sniff by content.
const EMAIL_EXACT = ["email", "email address", "email_address", "e-mail", "e mail", "emailaddress",
  "work email", "personal email", "user email", "member email", "primary email", "contact email",
  "login email", "buyer email", "lead email", "your email", "email id"];
const EMAIL_SUBSTR = ["email", "e-mail"];
const PHONE_EXACT = ["phone", "phone number", "phone_number", "mobile", "mobile phone", "mobile number",
  "cell", "cell phone", "number", "sms", "sms number", "buyer_phone", "buyer phone", "contact number",
  "whatsapp", "telephone", "tel", "msisdn"];
const PHONE_SUBSTR = ["phone", "mobile", "cell", "whatsapp"];
const FIRST_NAME_EXACT = ["first_name", "first name", "firstname", "first", "given name", "given_name", "fname"];
const FULL_NAME_EXACT = ["name", "full name", "full_name", "fullname", "member name", "member",
  "contact name", "customer name", "attendee", "attendee name", "display name", "billing name"];

// Locate the header row (skipping any preamble/junk rows that exports like Zoom
// add on top) and the column to use. Falls back to sniffing the column by content
// when there's no usable header. Returns { headerRow, col, headerCells } or null.
function detectColumn(rows, exactList, substrWords, validator) {
  const scan = Math.min(rows.length, 30);
  const norm = (i) => rows[i].map((c) => (c || "").trim().toLowerCase());
  for (let i = 0; i < scan; i++) { // pass 1: exact header
    const cells = norm(i);
    const col = cells.findIndex((h) => exactList.includes(h));
    if (col !== -1) return { headerRow: i, col, headerCells: cells };
  }
  for (let i = 0; i < scan; i++) { // pass 2: substring header (guard against long sentence cells)
    const cells = norm(i);
    const col = cells.findIndex((h) => h && h.length <= 40 && substrWords.some((w) => h.includes(w)));
    if (col !== -1) return { headerRow: i, col, headerCells: cells };
  }
  // pass 3: by content — the column with the most cells that validate
  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  let bestCol = -1, bestCount = 0;
  for (let c = 0; c < maxCols; c++) {
    let n = 0;
    for (const r of rows) if (validator((r[c] || "").trim())) n++;
    if (n > bestCount) { bestCount = n; bestCol = c; }
  }
  return bestCount >= 1 ? { headerRow: -1, col: bestCol, headerCells: null } : null;
}

function detectNameCol(headerCells) {
  if (!headerCells) return -1;
  let c = headerCells.findIndex((h) => FIRST_NAME_EXACT.includes(h) || (h.includes("first") && h.includes("name")));
  if (c !== -1) return c;
  c = headerCells.findIndex((h) => FULL_NAME_EXACT.includes(h));
  if (c !== -1) return c;
  // any "*name*" column that isn't last/username/filename/company/etc
  return headerCells.findIndex((h) => /name/.test(h) && !/(last|sur|family|user|file|company|event|topic|screen|nick)/.test(h));
}

const firstNameOf = (v) => (v || "").trim().split(/\s+/)[0] || "";

function extractRecipients(csvText) {
  const rows = parseCSV((csvText || "").replace(/^﻿/, ""));
  if (!rows.length) return { recipients: [], invalid: 0, dupes: 0 };
  const found = detectColumn(rows, EMAIL_EXACT, EMAIL_SUBSTR, (v) => EMAIL_RE.test(v.toLowerCase()));
  if (!found) return { recipients: [], invalid: 0, dupes: 0, error: "No email column found" };
  const nameCol = detectNameCol(found.headerCells);
  const start = found.headerRow >= 0 ? found.headerRow + 1 : 0;
  const seen = new Set();
  const recipients = [];
  let invalid = 0, dupes = 0;
  for (const r of rows.slice(start)) {
    const email = (r[found.col] || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) { invalid++; continue; }
    if (seen.has(email)) { dupes++; continue; }
    seen.add(email);
    recipients.push({ email, name: nameCol >= 0 ? firstNameOf(r[nameCol]) : "" });
  }
  return { recipients, invalid, dupes };
}

function loadSuppression() {
  if (!fs.existsSync(SUPPRESSION)) return new Set();
  return new Set(
    fs.readFileSync(SUPPRESSION, "utf8")
      .split(/[\r\n,]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes("@"))
  );
}

function listSegments() {
  if (!fs.existsSync(SEGMENTS)) return [];
  return fs.readdirSync(SEGMENTS)
    .filter((f) => f.toLowerCase().endsWith(".csv"))
    .map((f) => {
      const name = f.replace(/\.csv$/i, "");
      const { recipients } = extractRecipients(fs.readFileSync(path.join(SEGMENTS, f), "utf8"));
      return { name, file: f, count: recipients.length };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Every address in the given lists, for use as a per-send exclusion. This is not
// the suppression list — those people are opted out forever. This is "don't send
// THIS email to people who already bought", which has to stay per-send.
function emailsInSegments(names) {
  const out = new Set();
  for (const seg of names || []) {
    const file = path.join(SEGMENTS, seg + ".csv");
    if (!fs.existsSync(file)) continue;
    for (const r of extractRecipients(fs.readFileSync(file, "utf8")).recipients) out.add(r.email);
  }
  return out;
}
function resolveAudience(segmentNames, excludeNames) {
  // Union of selected segments, minus suppression, minus the excluded lists, deduped.
  const suppress = loadSuppression();
  const excluded = emailsInSegments(excludeNames);
  const seen = new Set();
  const recipients = [];
  let invalid = 0, dupes = 0, suppressed = 0, excludedCount = 0;
  for (const seg of segmentNames) {
    const file = path.join(SEGMENTS, seg + ".csv");
    if (!fs.existsSync(file)) continue;
    const res = extractRecipients(fs.readFileSync(file, "utf8"));
    invalid += res.invalid;
    for (const r of res.recipients) {
      if (suppress.has(r.email)) { suppressed++; continue; }
      if (excluded.has(r.email)) { excludedCount++; continue; }
      if (seen.has(r.email)) { dupes++; continue; }
      seen.add(r.email);
      recipients.push(r);
    }
  }
  return { recipients, invalid, dupes, suppressed, excluded: excludedCount };
}

// ---------- campaigns log ----------
function loadCampaigns() {
  if (!fs.existsSync(CAMPAIGNS)) return [];
  try { return JSON.parse(fs.readFileSync(CAMPAIGNS, "utf8")); } catch { return []; }
}
function saveCampaigns(list) {
  fs.writeFileSync(CAMPAIGNS, JSON.stringify(list, null, 2));
}

// ---------- email helpers ----------
function personalize(tpl, name) {
  return (tpl || "").replace(/\{\{first_name\}\}/g, name || "DJ");
}
function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&mdash;/g, "—")
    .replace(/&rarr;/g, "→").replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/\n{3,}/g, "\n\n").trim();
}
function slugify(s) {
  return (s || "campaign").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

// ---------- Postmark ----------
async function postmark(pathname, method, body, token) {
  const res = await fetch("https://api.postmarkapp.com" + pathname, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Postmark-Server-Token": token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`Postmark ${res.status}: ${text}`);
  return json;
}

async function postmarkStats(pathname, params, token) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
  return postmark(pathname + (qs ? "?" + qs : ""), "GET", null, token);
}

// ---------- Stripe ----------
async function stripeGet(pathname, cfg) {
  const r = await fetch("https://api.stripe.com/v1/" + pathname, {
    headers: { Authorization: "Bearer " + cfg.stripeKey },
  });
  const j = await r.json();
  if (j && j.error) throw new Error(j.error.message);
  return j;
}

async function getStripeSales(cfg, gte, lte) {
  let after = "", gross = 0, refunds = 0, count = 0, currency = "usd", guard = 0;
  while (guard++ < 100) {
    const qs = new URLSearchParams({ limit: "100", "created[gte]": String(gte) });
    if (lte) qs.set("created[lte]", String(lte));
    if (after) qs.set("starting_after", after);
    const page = await stripeGet("charges?" + qs.toString(), cfg);
    for (const c of page.data || []) {
      if (c.paid && c.status === "succeeded") { gross += c.amount; count++; currency = c.currency; }
      refunds += c.amount_refunded || 0;
    }
    if (!page.has_more || !page.data.length) break;
    after = page.data[page.data.length - 1].id;
  }
  return { gross: gross / 100, refunds: refunds / 100, net: (gross - refunds) / 100, count, currency: currency.toUpperCase() };
}

// Build {email -> firstName} of subscribers in the given lifecycle bucket.
async function getStripeSubscribers(cfg, bucket) {
  const statuses = bucket === "active" ? ["active", "trialing", "past_due"] : ["canceled"];
  const map = new Map();
  for (const st of statuses) {
    let after = "", guard = 0;
    while (guard++ < 200) {
      const qs = new URLSearchParams({ status: st, limit: "100" });
      qs.append("expand[]", "data.customer");
      if (after) qs.set("starting_after", after);
      const page = await stripeGet("subscriptions?" + qs.toString(), cfg);
      for (const s of page.data || []) {
        const c = s.customer;
        if (c && typeof c === "object" && !c.deleted && c.email) {
          const email = c.email.trim().toLowerCase();
          if (!map.has(email)) map.set(email, (c.name || "").trim().split(" ")[0]);
        }
      }
      if (!page.has_more || !page.data.length) break;
      after = page.data[page.data.length - 1].id;
    }
  }
  return map;
}

function writeSegmentFromMap(name, map) {
  const lines = ["email,first_name"];
  for (const [email, fn] of map) lines.push(`${email},${(fn || "").replace(/["\n,]/g, "")}`);
  fs.writeFileSync(path.join(SEGMENTS, slugify(name) + ".csv"), lines.join("\n"));
}

// ---------- failed payments (dunning / recovery) ----------
// Phase 1 = visibility: pull recent failed charges from Stripe, classify by
// reason, group per person with attempt counts. (Recovery sequences come later.)
const FAILED_PAYMENTS_CACHE = path.join(DATA, "failed-payments.json");
function classifyFailure(code) {
  const c = (code || "").toLowerCase();
  if (c === "insufficient_funds") return "insufficient_funds";
  if (["expired_card", "lost_card", "stolen_card", "pickup_card", "incorrect_number", "invalid_account"].includes(c)) return "dead_card";
  if (c === "card_declined" || c === "do_not_honor" || c === "generic_decline") return "declined";
  return "other";
}
// Stripe events keep ~30 days and `charge.failed` returns ONLY failures, so this
// is far cheaper than scanning every charge.
async function getStripeFailedCharges(cfg, sinceTs) {
  const out = [];
  let after = "", guard = 0;
  while (guard++ < 60) {
    const qs = new URLSearchParams({ type: "charge.failed", limit: "100", "created[gte]": String(sinceTs) });
    if (after) qs.set("starting_after", after);
    const page = await stripeGet("events?" + qs.toString(), cfg);
    const evs = page.data || [];
    for (const ev of evs) {
      const ch = ev.data && ev.data.object;
      if (!ch || ch.object !== "charge") continue;
      const bd = ch.billing_details || {};
      const email = (bd.email || ch.receipt_email || "").trim().toLowerCase();
      if (!email) continue;
      out.push({
        email,
        name: (bd.name || "").trim(),
        amount: (ch.amount || 0) / 100,
        currency: (ch.currency || "usd").toUpperCase(),
        created: ch.created || ev.created,
        failureCode: ch.failure_code || "",
        failureMessage: ch.failure_message || "",
        reason: classifyFailure(ch.failure_code),
        product: (ch.statement_descriptor || ch.description || "").trim(),
        source: "stripe",
      });
    }
    if (!page.has_more || !evs.length) break;
    after = evs[evs.length - 1].id;
  }
  return out;
}
// One row per person: attempt count + the most recent failure details.
function buildFailedPayments(raw) {
  const byEmail = new Map();
  for (const r of raw) {
    let g = byEmail.get(r.email);
    if (!g) { g = { email: r.email, name: r.name, attempts: 0, amount: r.amount, currency: r.currency, lastCreated: 0, reason: r.reason, failureMessage: r.failureMessage, products: new Set(), sources: new Set() }; byEmail.set(r.email, g); }
    g.attempts++;
    if (r.name && !g.name) g.name = r.name;
    if (r.created > g.lastCreated) { g.lastCreated = r.created; g.amount = r.amount; g.reason = r.reason; g.failureMessage = r.failureMessage; }
    if (r.product) g.products.add(r.product);
    g.sources.add(r.source);
  }
  const rows = [...byEmail.values()].map((g) => ({
    email: g.email, name: g.name, attempts: g.attempts, amount: g.amount, currency: g.currency,
    lastCreated: g.lastCreated, reason: g.reason, failureMessage: g.failureMessage,
    products: [...g.products], sources: [...g.sources],
    segment: g.attempts >= 3 ? "dead_card_repeat" : g.reason,
  }));
  rows.sort((a, b) => (b.attempts - a.attempts) || (b.amount - a.amount));
  return rows;
}
async function aggregateFailedPayments(cfg, days) {
  const sinceTs = Math.floor(Date.now() / 1000) - days * 86400;
  const raw = await getStripeFailedCharges(cfg, sinceTs);
  const rows = buildFailedPayments(raw);
  const summary = { people: rows.length, attempts: raw.length, atRisk: 0, repeat3plus: 0, byReason: {}, byProduct: {} };
  for (const r of rows) {
    summary.atRisk += r.amount;
    if (r.attempts >= 3) summary.repeat3plus++;
    summary.byReason[r.reason] = (summary.byReason[r.reason] || 0) + 1;
    for (const p of (r.products.length ? r.products : ["(unlabeled)"])) summary.byProduct[p] = (summary.byProduct[p] || 0) + 1;
  }
  summary.atRisk = Math.round(summary.atRisk * 100) / 100;
  const result = { updated: Date.now(), days, summary, rows };
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(FAILED_PAYMENTS_CACHE, JSON.stringify(result)); } catch {}
  return result;
}
function loadFailedPaymentsCache() {
  try { return JSON.parse(fs.readFileSync(FAILED_PAYMENTS_CACHE, "utf8")); } catch { return null; }
}

// ---------- ad library (spy → transcribe → Crate Hackers script) ----------
const ADS_FILE = path.join(DATA, "ads.json");
function loadAds() { try { return JSON.parse(fs.readFileSync(ADS_FILE, "utf8")); } catch { return []; } }
function saveAds(list) { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(ADS_FILE, JSON.stringify(list, null, 2)); } catch {} }
const INFLUENCERS_FILE = path.join(DATA, "influencers.json");
function loadInfluencers() { try { return JSON.parse(fs.readFileSync(INFLUENCERS_FILE, "utf8")); } catch { return []; } }
function saveInfluencers(list) { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(INFLUENCERS_FILE, JSON.stringify(list, null, 2)); } catch {} }

// ---------- creators (ScrapeCreators: discover on TikTok / IG / YouTube, then enrich) ----------
// Every call costs one API credit, so search returns everything it can in a single
// hit (handle, name, followers) and a per-creator profile lookup is opt-in.
// ---------- Sell By Chat (shared pipeline for Dom / Travis / Jaymie) ----------
// One prospect per conversation. Three reps work the same IG/FB inboxes, so the
// point of keeping this server-side is that nobody opens a DM someone else is
// already working. Follow-up dates come off the playbook's 0-1-1-2-3-5-8-13 cadence.
// The Hacker Hotel offer lineup. Each offer is matched in the Kartra ledger by
// product + price band, because five of these have never sold before and amount
// alone isn't enough to tell them apart.
//   · mega starts at $2,900 so it can't swallow the historical $2,750 in-person ticket
//   · spinelli starts at $380 so it catches the $397 the Challenge has already taken
//   · bb-life is safe at $250 because Banger Button has only ever sold at
//     $9.99 / $67 / $90 / $91 / $99.99 — but "Crate Hackers" HAS 69 sales at $250
//     (the July 4 BOGO), which is why this matches on product too
const HH_OFFERS = [
  { id: "mega", label: "MEGA Offer (everything)", price: 3500, priceNote: "$3K–$4K — CONFIRM", match: /crate\s*hackers|hacker\s*hotel/i, min: 2900, max: 6000 },
  // Lifetime also goes out at $777, so the band opens at 700. It stops short of the
  // $597 July-4 OTO, which is a different offer on the same Kartra product.
  { id: "ch-life", label: "CH Lifetime (+ jacket)", price: 997, priceNote: "also counts $777", match: /^crate\s*hackers$/i, min: 700, max: 1050 },
  { id: "ddj-life", label: "DangerousDJs (+ jacket)", price: 997, match: /dangerous/i, min: 950, max: 1050, warn: "needs its own Kartra product — otherwise a $997 here is indistinguishable from CH Lifetime" },
  { id: "hh2027", label: "HH 2027 deposit", price: 497, match: /hacker\s*hotel/i, min: 470, max: 520 },
  { id: "spinelli", label: "Spinelli Social Media Challenge", price: 497, match: /spinelli/i, min: 380, max: 520 },
  { id: "l11-year", label: "Level 11 annual", price: 1500, match: /level\s*-?\s*11/i, min: 1400, max: 1600 },
  { id: "bb-life", label: "BB Lifetime", price: 250, match: /banger\s*button/i, min: 230, max: 270 },
  { id: "l11-mo", label: "Level 11 monthly", price: 150, match: /level\s*-?\s*11/i, min: 140, max: 160 },
];
function offerSalesFor(rows, from, to) {
  const out = [];
  for (const o of HH_OFFERS) {
    let conv = 0, revenue = 0;
    for (const r of rows) {
      if (r.type !== "sale" || !o.match.test(r.product)) continue;
      if (from && r.date < from) continue;
      if (to && r.date > to) continue;
      if (r.amount < o.min || r.amount > o.max) continue;
      conv++; revenue += r.amount;
    }
    out.push({ id: o.id, label: o.label, price: o.price, priceNote: o.priceNote || null, warn: o.warn || null, conv, revenue: Math.round(revenue * 100) / 100 });
  }
  return out;
}

// The playbook's rules, compressed into a system prompt so the AI suggestions obey
// the same process the reps are trained on rather than inventing a sales style.
const SBC_DOCTRINE = `You are the sales copilot for CRATE HACKERS, which sells software, coaching and events to working DJs (mobile, wedding, corporate). You coach a Sell By Chat team: Dom (closer), Travis and Jaymie (openers), Nick Spinelli (closes fence-sitters).

VOICE: DJ-to-DJ, confident, warm, anti-corporate. Short lines. Minimal punctuation. Emojis where natural (🤘🔥🎧). CAPS for emphasis, never for shouting. Never corporate-speak. Say things a chatbot couldn't.

PROCESS, in order — never skip ahead:
1. OPEN: name, appreciate the action, one personal observation, then an either-or question.
2. QUALIFY: A–B method. Point A (gigs per month, average rate) → Point B (where they want it in 12 months) → roadblock (#1 thing in between) → what's missing.
3. Reward every pain admission fast ("I hear you", "Struggle is real…", "That sucks"). Lean out when they lean out ("can only help the DJs swimming toward me").
4. BUYING ZONE: only offer inside it. Too hopeless → reframe up (their plan was never built to work). Too confident/DIY → anchor to cost (every month this stays the same is another $2-3K of gigs left on the table).
5. At least 9 messages before ANY offer talk. The sale happens in discovery.
6. OBJECTIONS: never answer them, reframe them. You compete with inaction, not other coaches. Never make them feel wrong for hesitating.

OFFERS (Hacker Hotel): MEGA bundle (everything, high ticket) · CH Lifetime $997 +jacket · DangerousDJs $997 +jacket · HH 2027 deposit $497 · Spinelli 6-Week Social Media Challenge $497 · Level 11 $150/mo or $1500/yr · Banger Button Lifetime $250.

Never invent a price, a guarantee, a seat count or a deadline. If one is needed, write it as [PRICE] / [SEATS] / [DATE] for the rep to fill.`;

async function sbcCopilot(cfg, { conversation, prospect }) {
  const p = prospect || {};
  const prompt = `${SBC_DOCTRINE}

PROSPECT ON FILE: name=${p.name || "unknown"} · stage=${p.stage || "lead"} · offer=${p.offer || "none yet"}${p.pain ? " · pain=" + p.pain : ""}${p.pointB ? " · point B=" + p.pointB : ""}

THE CONVERSATION SO FAR (oldest first; "them:" is the prospect, "me:" is us):
"""${String(conversation || "").slice(0, 6000)}"""

Read it and return ONLY a JSON object:
{
  "read": "2 sentences on where this conversation actually is and what they've revealed",
  "stage": "one of: opening | qualifying | buying_zone | offer | objection | closing | dead",
  "in_buying_zone": true or false,
  "message_count": <how many messages have been exchanged, integer>,
  "ready_for_offer": true or false,
  "known": { "pointA": "...or empty", "pointB": "...or empty", "roadblock": "...or empty", "pain": "...or empty" },
  "missing": ["the specific things still unknown that must be found before an offer"],
  "next_move": "the ONE thing the rep should do next, in a short sentence",
  "replies": ["3 send-ready messages, in the Crate Hackers voice, each on its own — short, ending in a question where natural"],
  "avoid": "the mistake a rep is most likely to make right here"
}`;
  const raw = await groqChat(cfg, [{ role: "user", content: prompt }], 1800, true);
  const j = firstJson(raw) || {};
  const arr = (v) => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);
  return {
    read: String(j.read || ""), stage: String(j.stage || "qualifying"),
    inBuyingZone: !!j.in_buying_zone, messageCount: Number(j.message_count) || 0,
    readyForOffer: !!j.ready_for_offer,
    known: { pointA: String((j.known || {}).pointA || ""), pointB: String((j.known || {}).pointB || ""), roadblock: String((j.known || {}).roadblock || ""), pain: String((j.known || {}).pain || "") },
    missing: arr(j.missing), nextMove: String(j.next_move || ""), replies: arr(j.replies).slice(0, 3),
    avoid: String(j.avoid || ""),
  };
}

async function sbcCoach(cfg, { conversation }) {
  const prompt = `${SBC_DOCTRINE}

Score this Sell By Chat conversation using the team's own review rubric.
Buyer-journey score 1–10, where 1 = they only just followed, 7 = they've got real value from our stuff, 10 = they're asking to work with us.

CONVERSATION:
"""${String(conversation || "").slice(0, 6000)}"""

Return ONLY a JSON object:
{
  "score": <1-10 integer>,
  "evidence": "the single line from the conversation that proves that score, quoted",
  "handoff": "where the opener should have handed to the closer — quote the line, or say 'not yet' / 'no handoff needed'",
  "leak": "the one place this conversation lost momentum or money",
  "did_well": ["1-3 things the rep genuinely did right"],
  "fixes": ["2-4 specific, concrete changes — reference what they actually said"],
  "rule_breaks": ["any playbook rules broken, e.g. offered before 9 messages, answered an objection instead of reframing, kept pushing when the lead leaned out. Empty array if none."]
}`;
  const raw = await groqChat(cfg, [{ role: "user", content: prompt }], 1600, true);
  const j = firstJson(raw) || {};
  const arr = (v) => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);
  let score = Math.round(Number(j.score));
  if (!(score >= 1 && score <= 10)) score = null;
  return {
    score, evidence: String(j.evidence || ""), handoff: String(j.handoff || ""),
    leak: String(j.leak || ""), didWell: arr(j.did_well), fixes: arr(j.fixes), ruleBreaks: arr(j.rule_breaks),
  };
}

const SBC_FILE = path.join(DATA, "sbc.json");
const SBC_STAGES = ["lead", "qualified", "offer_made", "closed_won", "closed_lost"];
// Nick closes fence-sitters, so he's a rep like the others — prospects get escalated
// to him rather than assigned from the start.
const SBC_REPS = ["dom", "travis", "jaymie", "nick"];
const SBC_CADENCE = [0, 1, 1, 2, 3, 5, 8, 13];
function loadSbc() {
  const dflt = { goal: 250000, from: "2026-07-30", to: "2026-08-31", prospects: [] };
  try {
    const d = JSON.parse(fs.readFileSync(SBC_FILE, "utf8"));
    return {
      goal: typeof d.goal === "number" ? d.goal : dflt.goal,
      from: d.from || dflt.from, to: d.to || dflt.to,
      prospects: Array.isArray(d.prospects) ? d.prospects : [],
    };
  } catch { return dflt; }
}
function saveSbc(d) { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(SBC_FILE, JSON.stringify(d, null, 2)); } catch {} }
const todayISO = () => new Date().toISOString().slice(0, 10);
// next touch = today + the nth gap in the cadence; past the end we hold at 13 days
function sbcNextDate(touches) {
  const i = Math.min(Math.max(0, touches), SBC_CADENCE.length - 1);
  const d = new Date();
  d.setDate(d.getDate() + SBC_CADENCE[i]);
  return d.toISOString().slice(0, 10);
}

const CREATORS_FILE = path.join(DATA, "creators.json");
function loadCreators() { try { return JSON.parse(fs.readFileSync(CREATORS_FILE, "utf8")); } catch { return []; } }
function saveCreators(list) { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(CREATORS_FILE, JSON.stringify(list, null, 2)); } catch {} }
const CREATOR_PLATFORMS = ["tiktok", "instagram", "youtube"];
// last credit balance the API reported, so the UI can show it without spending one to ask
let SC_CREDITS = null;

async function scrapeCreators(cfg, pathname, params) {
  if (!cfg.scrapeCreatorsKey) throw new Error("Add your ScrapeCreators API key in Settings first.");
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString();
  const r = await fetch("https://api.scrapecreators.com" + pathname + (qs ? "?" + qs : ""), {
    headers: { "x-api-key": cfg.scrapeCreatorsKey },
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = null; }
  if (r.status === 402) throw new Error("ScrapeCreators is out of credits.");
  if (!r.ok || !j) throw new Error(`ScrapeCreators ${r.status}: ${text.slice(0, 200)}`);
  if (typeof j.credits_remaining === "number") SC_CREDITS = j.credits_remaining;
  return j;
}

const creatorId = (platform, handle) => platform + ":" + String(handle || "").replace(/^@/, "").toLowerCase();
// Creators put their booking address in the bio far more often than in a real email field.
function emailFromText(s) {
  const m = String(s || "").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m ? m[0].toLowerCase() : "";
}
const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);

// --- search: one credit, returns as many creators as the platform will give us ---
async function searchCreators(cfg, platform, query) {
  if (platform === "tiktok") {
    const j = await scrapeCreators(cfg, "/v1/tiktok/search/users", { query });
    return (j.user_list || []).map((u) => u.user_info).filter(Boolean).map((i) => ({
      platform, handle: i.unique_id, name: i.nickname || "",
      followers: num(i.follower_count), posts: num(i.aweme_count),
      bio: i.signature || "",
      avatar: (i.avatar_168x168 && i.avatar_168x168.url_list && i.avatar_168x168.url_list[0]) || "",
      url: "https://www.tiktok.com/@" + i.unique_id,
    }));
  }
  if (platform === "youtube") {
    const j = await scrapeCreators(cfg, "/v1/youtube/search", { query, type: "channels" });
    return (j.channels || []).map((c) => {
      const handle = String(c.handle || "").replace(/^@/, "");
      return {
        platform, handle, name: c.channelName || "",
        followers: num(c.subscriberCountInt), verified: (c.badges || []).includes("Verified"),
        bio: c.description || "", avatar: c.thumbnail || "", channelId: c.id || "",
        url: "https://www.youtube.com/@" + handle,
      };
    }).filter((c) => c.handle);
  }
  if (platform === "instagram") {
    // No profile search on IG — search reels and collapse them to their owners. Handy
    // side effect: how many reels a creator landed for the query is a relevance signal,
    // and the view counts give us reach before spending a credit on their profile.
    const j = await scrapeCreators(cfg, "/v2/instagram/reels/search", { query });
    const by = new Map();
    for (const reel of j.reels || []) {
      const o = reel.owner || {};
      if (!o.username) continue;
      const prev = by.get(o.username) || {
        platform, handle: o.username, name: o.full_name || "",
        followers: num(o.follower_count) || num(o.edge_followed_by && o.edge_followed_by.count),
        verified: !!o.is_verified, avatar: o.profile_pic_url || "", bio: "",
        url: "https://www.instagram.com/" + o.username, hits: 0, views: 0,
      };
      prev.hits++;
      prev.views += num(reel.video_play_count) || num(reel.video_view_count);
      by.set(o.username, prev);
    }
    return [...by.values()].map((c) => ({ ...c, avgViews: c.hits ? Math.round(c.views / c.hits) : 0 }));
  }
  throw new Error("Unknown platform: " + platform);
}

// --- enrich: one credit per creator, fills bio / email / engagement ---
async function enrichCreator(cfg, platform, handle) {
  if (platform === "tiktok") {
    const j = await scrapeCreators(cfg, "/v1/tiktok/profile", { handle });
    const u = j.user || {}, s = j.stats || {};
    const followers = num(s.followerCount), posts = num(s.videoCount), hearts = num(s.heartCount);
    const avgLikes = posts ? hearts / posts : 0;
    return {
      name: u.nickname || "", bio: u.signature || "", verified: !!u.verified,
      followers, posts, link: (u.bioLink && u.bioLink.link) || "",
      email: emailFromText(u.signature),
      engagement: followers ? +((avgLikes / followers) * 100).toFixed(2) : null,
    };
  }
  if (platform === "instagram") {
    const j = await scrapeCreators(cfg, "/v1/instagram/profile", { handle });
    const u = (j.data && j.data.user) || {};
    const followers = num(u.edge_followed_by && u.edge_followed_by.count);
    const edges = (u.edge_owner_to_timeline_media && u.edge_owner_to_timeline_media.edges) || [];
    let eng = null;
    if (followers && edges.length) {
      const total = edges.reduce((sum, e) => {
        const n = (e && e.node) || {};
        return sum + num(n.edge_liked_by && n.edge_liked_by.count) + num(n.edge_media_to_comment && n.edge_media_to_comment.count);
      }, 0);
      eng = +(((total / edges.length) / followers) * 100).toFixed(2);
    }
    return {
      name: u.full_name || "", bio: u.biography || "", verified: !!u.is_verified,
      followers, posts: num(u.edge_owner_to_timeline_media && u.edge_owner_to_timeline_media.count),
      link: u.external_url || "",
      email: u.business_email || emailFromText(u.biography),
      engagement: eng,
    };
  }
  if (platform === "youtube") {
    const j = await scrapeCreators(cfg, "/v1/youtube/channel", { handle });
    const subs = num(j.subscriberCount), vids = num(j.videoCount), views = num(j.viewCount);
    return {
      name: j.name || "", bio: j.description || "", verified: !!j.isVerified,
      followers: subs, posts: vids, link: j.instagram || j.tik_tok || "",
      email: j.email || emailFromText(j.description),
      // YouTube gives lifetime views, so this is average views per video vs subscribers
      engagement: subs && vids ? +(((views / vids) / subs) * 100).toFixed(2) : null,
      avgViews: vids ? Math.round(views / vids) : 0,
    };
  }
  throw new Error("Unknown platform: " + platform);
}
async function groqTranscribeBuffer(cfg, buf, filename) {
  if (buf.length > 24 * 1024 * 1024) throw new Error("media too large (>24MB) — trim it or paste the transcript");
  const fd = new FormData();
  fd.append("file", new Blob([buf]), filename || "audio.mp4");
  fd.append("model", "whisper-large-v3");
  fd.append("response_format", "text");
  const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: "Bearer " + cfg.groqApiKey }, body: fd,
  });
  if (!r.ok) throw new Error("Groq transcribe " + r.status + ": " + (await r.text()).slice(0, 180));
  return (await r.text()).trim();
}
async function groqTranscribeUrl(cfg, mediaUrl) {
  const mr = await fetch(mediaUrl, { redirect: "follow" });
  if (!mr.ok) throw new Error("couldn't fetch media (" + mr.status + ")");
  return groqTranscribeBuffer(cfg, Buffer.from(await mr.arrayBuffer()), (mediaUrl.split("?")[0].split("/").pop() || "audio.mp4"));
}
// Resolve a transcript from a request body: pasted transcript > uploaded file > media URL.
async function transcriptFromBody(cfg, b) {
  let transcript = (b.transcript || "").trim();
  if (!transcript && b.fileBase64) {
    const raw = String(b.fileBase64).replace(/^data:[^;]+;base64,/, "");
    transcript = await groqTranscribeBuffer(cfg, Buffer.from(raw, "base64"), b.fileName || "upload.mp4");
  }
  if (!transcript && (b.mediaUrl || "").trim()) transcript = await groqTranscribeUrl(cfg, (b.mediaUrl || "").trim());
  return transcript;
}
async function groqChat(cfg, messages, maxTokens, jsonMode) {
  const payload = { model: "llama-3.3-70b-versatile", temperature: 0.6, max_tokens: maxTokens || 1600, messages };
  if (jsonMode) payload.response_format = { type: "json_object" };
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", headers: { Authorization: "Bearer " + cfg.groqApiKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error("Groq chat " + r.status + ": " + (await r.text()).slice(0, 180));
  const j = await r.json();
  return (j.choices && j.choices[0] && j.choices[0].message.content) || "";
}
function firstJson(s) {
  s = String(s).replace(/```json\s*/gi, "").replace(/```/g, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < 0) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
async function analyzeAd(cfg, { transcript, sourceUrl, notes }) {
  const prompt = `You are a direct-response ad strategist for CRATE HACKERS — software + community for working DJs. Brand voice: confident, irreverent, DJ-to-DJ, anti-corporate, a little funny. Core value: stop wasting hours crate-digging; the app preps your music for you.

Analyze the ad below and adapt it for Crate Hackers.
${sourceUrl ? "Ad source: " + sourceUrl + "\n" : ""}${notes ? "My notes: " + notes + "\n" : ""}AD CONTENT / TRANSCRIPT:
"""${(transcript || "").slice(0, 6000)}"""

Return ONLY a JSON object (no prose) with:
{
  "summary": "1-2 sentences on what this ad is and does",
  "hook": "the opening hook it uses",
  "structure": ["beat 1", "beat 2", "..."],
  "why_it_works": "the persuasion mechanics that make it convert",
  "ch_script": "a 30-45 second Crate Hackers VIDEO AD SCRIPT reusing this ad's structure + psychology but for DJs — spoken lines / shot directions, in the Crate Hackers voice",
  "ch_hooks": ["3 alternative scroll-stopping opening hooks for the Crate Hackers version"],
  "ideas": ["3 to 5 CONCRETE, distinct ways we could turn THIS ad into a Crate Hackers ad — each a single punchy sentence a creator could shoot (different angle/format each: e.g. talking-head, skit, screen-record demo, day-in-the-life, before/after)"]
}`;
  const raw = await groqChat(cfg, [{ role: "user", content: prompt }], 2200, true);
  const j = firstJson(raw) || { ch_script: raw };
  // the model sometimes returns fields as arrays/objects — normalize to strings / string-arrays
  const asStr = (v) => typeof v === "string" ? v
    : Array.isArray(v) ? v.map((x) => typeof x === "string" ? x : (x && (x.line || x.text || x.idea || x.hook)) || JSON.stringify(x)).join("\n")
    : v == null ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v));
  const asArr = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => typeof x === "string" ? x : (x && (x.line || x.text || x.idea || x.hook)) || JSON.stringify(x)).filter(Boolean);
  return {
    summary: asStr(j.summary), hook: asStr(j.hook), why_it_works: asStr(j.why_it_works), ch_script: asStr(j.ch_script),
    structure: asArr(j.structure), ch_hooks: asArr(j.ch_hooks), ideas: asArr(j.ideas),
  };
}

// ---------- PayPal ----------
async function paypalAuth(cfg) {
  const base = cfg.paypalEnv === "sandbox" ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
  const auth = Buffer.from(cfg.paypalClientId + ":" + cfg.paypalSecret).toString("base64");
  const r = await fetch(base + "/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(j.error_description || j.error || "auth failed");
  return { token: j.access_token, base };
}

// PayPal Transaction Search: max 31-day windows, so we chunk the range.
async function getPaypalSales(cfg, fromDate, toDate) {
  const { token, base } = await paypalAuth(cfg);
  let gross = 0, count = 0, currency = "USD";
  const end = new Date(toDate + "T23:59:59Z");
  let cursor = new Date(fromDate + "T00:00:00Z");
  let guard = 0;
  const iso = (d) => d.toISOString().replace(/\.\d+Z$/, "Z");
  while (cursor < end && guard++ < 40) {
    const wEnd = new Date(Math.min(cursor.getTime() + 30 * 86400000, end.getTime()));
    let page = 1, totalPages = 1;
    do {
      const qs = new URLSearchParams({
        start_date: iso(cursor), end_date: iso(wEnd),
        fields: "transaction_info", page_size: "500", page: String(page),
      });
      const r = await fetch(base + "/v1/reporting/transactions?" + qs.toString(), {
        headers: { Authorization: "Bearer " + token },
      });
      const j = await r.json();
      if (!j.transaction_details && j.message) throw new Error(j.message);
      for (const t of j.transaction_details || []) {
        const info = t.transaction_info || {};
        const amt = parseFloat((info.transaction_amount && info.transaction_amount.value) || "0");
        if (info.transaction_status === "S" && amt > 0) {
          gross += amt; count++;
          if (info.transaction_amount) currency = info.transaction_amount.currency_code;
        }
      }
      totalPages = j.total_pages || 1;
      page++;
    } while (page <= totalPages && page < 60);
    cursor = new Date(wEnd.getTime() + 1000);
  }
  return { gross: Math.round(gross * 100) / 100, count, currency };
}

// ---------- Kartra ----------
// Kartra's API is strictly lead-centric: every call must target one lead via a
// `lead[email]` array, and there is NO bulk transaction/sales report. So we use
// a single-lead `get_lead` call to validate the connection. (Bulk revenue comes
// from Stripe + PayPal, which is what actually processes Kartra's payments.)
async function kartraGetLead(cfg, email) {
  const body = new URLSearchParams();
  body.set("app_id", cfg.kartraAppId);
  body.set("api_key", cfg.kartraApiKey);
  body.set("api_password", cfg.kartraApiPassword);
  body.set("lead[email]", email);          // <-- the missing piece: lead must be an array
  body.set("actions[0][cmd]", "get_lead");
  const r = await fetch("https://app.kartra.com/api", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error("Unexpected Kartra response: " + text.slice(0, 160)); }
  return j;
}

function kartraIsAuthError(j) {
  const msg = JSON.stringify(j || {}).toLowerCase();
  return /app id|api[_ ]?key|api[_ ]?password|credential|not valid|inactive|unauthor|forbidden/.test(msg);
}

async function kartraTest(cfg) {
  const email = cfg.testEmail || "dom@cratehackers.com";
  const j = await kartraGetLead(cfg, email);
  const status = (j.status || "").toLowerCase();
  if (status === "success" || j.lead_details) return "credentials valid";
  if (kartraIsAuthError(j)) throw new Error(j.message || "Kartra credentials rejected");
  // auth worked but this email isn't a lead (or some non-auth message) — connection is fine
  return `connected (no lead match for ${email})`;
}

// ---------- Mailgun ----------
function mailgunBase(cfg) {
  return cfg.mailgunRegion === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
}
// Convert our {{first_name}} token into Mailgun's per-recipient variable syntax.
function mgVars(s) { return (s || "").replace(/\{\{first_name\}\}/g, "%recipient.first_name%"); }

async function mailgunSendBatch(cfg, opts, batch) {
  const auth = Buffer.from("api:" + cfg.mailgunApiKey).toString("base64");
  const vars = {};
  for (const r of batch) vars[r.email] = { first_name: r.name || "DJ" };
  const form = new URLSearchParams();
  form.set("from", opts.fromHeader);
  form.set("to", batch.map((r) => r.email).join(","));
  if (opts.replyTo) form.set("h:Reply-To", opts.replyTo);
  form.set("subject", mgVars(opts.subject)); // %recipient.first_name% so the SUBJECT personalizes too
  form.set("html", mgVars(opts.html));
  form.set("text", mgVars(opts.text));
  form.set("recipient-variables", JSON.stringify(vars));
  form.set("o:tag", opts.tag);
  form.set("o:tracking", "yes");
  form.set("o:tracking-opens", "yes");
  // Click tracking rewrites links through Mailgun's tracking domain (email.<domain>), which
  // shows an "unsecured" warning unless SSL is enabled there. Off by default → links go direct.
  form.set("o:tracking-clicks", opts.clickTracking ? "htmlonly" : "no");
  const res = await fetch(`${mailgunBase(cfg)}/v3/${encodeURIComponent(cfg.mailgunDomain)}/messages`, {
    method: "POST",
    headers: { Authorization: "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = { message: text }; }
  if (!res.ok) throw new Error(`Mailgun ${res.status}: ${j.message || text}`);
  return j; // { id, message }
}

async function mailgunTest(cfg) {
  const auth = Buffer.from("api:" + cfg.mailgunApiKey).toString("base64");
  const res = await fetch(`${mailgunBase(cfg)}/v4/domains/${encodeURIComponent(cfg.mailgunDomain)}`, {
    headers: { Authorization: "Basic " + auth },
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = {}; }
  if (!res.ok) throw new Error(`Mailgun ${res.status}: ${j.message || text}`);
  return j.domain ? (j.domain.name + " · " + j.domain.state) : "connected";
}

// Mailgun stats over a date range (sums the per-bucket totals). tag is optional.
async function getMailgunStats(cfg, fromDate, toDate, tag) {
  const auth = Buffer.from("api:" + cfg.mailgunApiKey).toString("base64");
  const events = ["accepted", "delivered", "opened", "clicked", "failed", "unsubscribed", "complained"];
  const qs = new URLSearchParams();
  events.forEach((e) => qs.append("event", e));
  qs.set("resolution", "day");
  if (fromDate) qs.set("start", new Date(fromDate + "T00:00:00Z").toUTCString());
  if (toDate) qs.set("end", new Date(toDate + "T23:59:59Z").toUTCString());
  if (tag) qs.set("tag", tag);
  const res = await fetch(`${mailgunBase(cfg)}/v3/${encodeURIComponent(cfg.mailgunDomain)}/stats/total?${qs}`, {
    headers: { Authorization: "Basic " + auth },
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error("Mailgun stats: " + text.slice(0, 120)); }
  if (!res.ok) throw new Error(`Mailgun ${res.status}: ${j.message || text}`);
  const sum = { accepted: 0, delivered: 0, opened: 0, clicked: 0, failed: 0, unsubscribed: 0, complained: 0 };
  for (const b of j.stats || []) {
    sum.accepted += (b.accepted && b.accepted.total) || 0;
    sum.delivered += (b.delivered && b.delivered.total) || 0;
    sum.opened += (b.opened && b.opened.total) || 0;
    sum.clicked += (b.clicked && b.clicked.total) || 0;
    sum.failed += (b.failed && ((b.failed.permanent && b.failed.permanent.total) || 0) + ((b.failed.temporary && b.failed.temporary.total) || 0)) || 0;
    sum.unsubscribed += (b.unsubscribed && b.unsubscribed.total) || 0;
    sum.complained += (b.complained && b.complained.total) || 0;
  }
  return sum;
}

// ---------- Sales ledger (Google Sheet CSV) ----------
let _ledgerCache = { url: "", at: 0, rows: null };
async function fetchLedger(url) {
  if (_ledgerCache.rows && _ledgerCache.url === url && Date.now() - _ledgerCache.at < 120000) return _ledgerCache.rows;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Ledger fetch ${res.status}`);
  const text = await res.text();
  const rows = parseCSV(text);
  const header = (rows[0] || []).map((h) => h.trim().toLowerCase());
  const ci = (n) => header.indexOf(n);
  const idx = { ts: ci("event_timestamp"), type: ci("event_type"), product: ci("product_name"), email: ci("customer_email"), amount: ci("amount"), cur: ci("currency") };
  const out = [];
  for (const r of rows.slice(1)) {
    const ts = (r[idx.ts] || "").trim();
    if (!ts) continue;
    out.push({
      ts, date: ts.slice(0, 10),
      type: (r[idx.type] || "").trim().toLowerCase(),
      product: (r[idx.product] || "").trim(),
      email: (r[idx.email] || "").trim().toLowerCase(),
      amount: parseFloat((r[idx.amount] || "0").replace(/[^0-9.\-]/g, "")) || 0,
      currency: (r[idx.cur] || "USD").trim() || "USD",
    });
  }
  _ledgerCache = { url, at: Date.now(), rows: out };
  return out;
}

function aggregateLedger(rows, from, to) {
  const inRange = (d) => (!from || d >= from) && (!to || d <= to);
  const sales = rows.filter((r) => r.type === "sale" && inRange(r.date));
  let total = 0, currency = "USD";
  const byProduct = {}, daily = {};
  for (const s of sales) {
    total += s.amount; currency = s.currency || currency;
    byProduct[s.product] = byProduct[s.product] || { product: s.product, count: 0, revenue: 0 };
    byProduct[s.product].count++; byProduct[s.product].revenue += s.amount;
    daily[s.date] = (daily[s.date] || 0) + s.amount;
  }
  return {
    total: Math.round(total * 100) / 100, count: sales.length, currency,
    byProduct: Object.values(byProduct).sort((a, b) => b.revenue - a.revenue)
      .map((p) => ({ ...p, revenue: Math.round(p.revenue * 100) / 100 })),
    daily: Object.entries(daily).sort().map(([date, revenue]) => ({ date, revenue: Math.round(revenue * 100) / 100 })),
  };
}

// ---------- sales attribution ----------
let _phoneMap = null;
function loadPhoneEmailMap() {
  if (_phoneMap) return _phoneMap;
  try { _phoneMap = JSON.parse(fs.readFileSync(PHONE_EMAIL_MAP, "utf8")); } catch { _phoneMap = {}; }
  return _phoneMap;
}
// Resolve a campaign's stored recipients to a Set of buyer emails (SMS phones → emails via map).
function recipientEmailSet(jobId) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(RECIPIENTS, jobId + ".json"), "utf8"));
    if (r.channel === "email") return new Set((r.emails || []).map((e) => e.toLowerCase()));
    if (r.channel === "sms") {
      const map = loadPhoneEmailMap(); const s = new Set();
      for (const ph of r.phones || []) { const e = map[ph]; if (e) s.add(e.toLowerCase()); }
      return s;
    }
  } catch {}
  return null;
}
// Last-touch attribution: each sale credited to the most-recent campaign the buyer received
// within `windowDays` before the sale.
function computeAttribution(campaigns, ledgerRows, windowDays) {
  const winMs = windowDays * 86400000;
  const camps = campaigns.map((c) => ({ id: c.id, t: Date.parse(c.date), set: recipientEmailSet(c.id) }))
    .filter((c) => c.set && c.set.size && !isNaN(c.t));
  const result = {}; // id -> { revenue, buyers:Set }
  for (const c of camps) result[c.id] = { revenue: 0, buyers: new Set() };
  const sales = ledgerRows.filter((r) => r.type === "sale");
  for (const s of sales) {
    const st = Date.parse(s.ts.replace(" ", "T"));
    if (isNaN(st)) continue;
    let best = null;
    for (const c of camps) {
      if (st >= c.t && st <= c.t + winMs && c.set.has(s.email)) {
        if (!best || c.t > best.t) best = c;
      }
    }
    if (best) { result[best.id].revenue += s.amount; result[best.id].buyers.add(s.email); }
  }
  const out = {};
  for (const [id, v] of Object.entries(result)) out[id] = { revenue: Math.round(v.revenue * 100) / 100, buyers: v.buyers.size };
  return out;
}

// ---------- Twilio (SMS / MMS) ----------
function normalizePhone(raw) {
  let s = (raw || "").trim();
  if (!s) return null;
  if (s.startsWith("+")) { const d = s.slice(1).replace(/\D/g, ""); return d.length >= 8 ? "+" + d : null; }
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;          // assume US/Canada
  if (d.length === 11 && d[0] === "1") return "+" + d;
  if (d.length >= 8) return "+" + d;             // already has country code
  return null;
}
function fromNumbersList(cfg) {
  return (cfg.twilioFromNumbers || "").split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
}
function twNums(s) { return (s || "").split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean); }
// Resolve a Twilio "sender account" → { id, label, accountSid, authUser, authPass, fromNumbers[], messagingServiceSid }.
// accountId "default"/empty = Crate Hackers (Account SID + Auth Token). Named accounts in cfg.smsAccounts
// may authenticate with an API Key (SK…) + secret, so the auth user/pass are separate from the URL Account SID.
function resolveTwilio(cfg, accountId) {
  if (accountId && accountId !== "default") {
    const a = (cfg.smsAccounts || []).find((x) => x.id === accountId);
    if (!a) return null;
    return { id: a.id, label: a.label || a.id, accountSid: a.accountSid || "", authUser: a.apiKeySid || a.accountSid || "", authPass: a.apiKeySecret || a.authToken || "", fromNumbers: twNums(a.fromNumbers), messagingServiceSid: a.messagingServiceSid || "" };
  }
  return { id: "default", label: "Crate Hackers", accountSid: cfg.twilioAccountSid, authUser: cfg.twilioAccountSid, authPass: cfg.twilioAuthToken, fromNumbers: fromNumbersList(cfg), messagingServiceSid: cfg.twilioMessagingServiceSid || "" };
}
function twConfigured(tw) { return !!(tw && tw.accountSid && tw.authUser && tw.authPass); }
async function twilioPost(tw, path, form) {
  const auth = Buffer.from(tw.authUser + ":" + tw.authPass).toString("base64");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${tw.accountSid}${path}`, {
    method: "POST",
    headers: { Authorization: "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = { message: text }; }
  if (!res.ok) throw new Error(j.message || `Twilio ${res.status}`);
  return j;
}
async function twilioGetAccount(tw) {
  const auth = Buffer.from(tw.authUser + ":" + tw.authPass).toString("base64");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${tw.accountSid}.json`, {
    headers: { Authorization: "Basic " + auth },
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = {}; }
  if (!res.ok) throw new Error(j.message || `Twilio ${res.status}`);
  return j; // { friendly_name, status, ... }
}
async function getTwilioStats(tw, fromDate, toDate) {
  const auth = Buffer.from(tw.authUser + ":" + tw.authPass).toString("base64");
  async function sumDaily(category) {
    const qs = new URLSearchParams({ Category: category, PageSize: "365" });
    if (fromDate) qs.set("StartDate", fromDate);
    if (toDate) qs.set("EndDate", toDate);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${tw.accountSid}/Usage/Records/Daily.json?${qs}`, { headers: { Authorization: "Basic " + auth } });
    const text = await res.text();
    let j; try { j = JSON.parse(text); } catch { throw new Error("Twilio stats parse error"); }
    if (!res.ok) throw new Error(j.message || `Twilio ${res.status}`);
    let count = 0, price = 0;
    for (const u of j.usage_records || []) { count += +u.count || 0; price += +u.price || 0; }
    return { count, price };
  }
  const [sms, mms] = await Promise.all([sumDaily("sms-outbound"), sumDaily("mms-outbound")]);
  return {
    smsCount: sms.count, smsCost: Math.round(sms.price * 100) / 100,
    mmsCount: mms.count, mmsCost: Math.round(mms.price * 100) / 100,
    totalCost: Math.round((sms.price + mms.price) * 100) / 100,
  };
}

// Send ONE email (used for influencer ad-briefs) via Postmark (preferred) or Mailgun.
async function sendOneEmail(cfg, { to, toName, subject, html }) {
  const text = htmlToText(html);
  if (cfg.postmarkToken) {
    const fromHeader = cfg.fromName ? `${cfg.fromName} <${cfg.fromEmail}>` : cfg.fromEmail;
    await postmark("/email", "POST", {
      From: fromHeader, To: toName ? `${toName} <${to}>` : to,
      ...(cfg.replyTo ? { ReplyTo: cfg.replyTo } : {}),
      Subject: subject, HtmlBody: html, TextBody: text,
      MessageStream: cfg.stream, Tag: "ad-brief", TrackOpens: true, TrackLinks: "HtmlAndText",
    }, cfg.postmarkToken);
    return { provider: "postmark" };
  }
  if (cfg.mailgunApiKey && cfg.mailgunDomain) {
    const fromEmail = cfg.mailgunFromEmail || cfg.fromEmail;
    const fromName = cfg.mailgunFromName || cfg.fromName;
    const fromHeader = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
    await mailgunSendBatch(cfg, { subject, html, text, fromHeader, replyTo: cfg.replyTo, tag: "ad-brief", clickTracking: cfg.mailgunClickTracking }, [{ email: to, name: toName || "" }]);
    return { provider: "mailgun" };
  }
  throw new Error("No email provider configured — add Postmark or Mailgun in Settings.");
}

async function twilioSendOne(tw, { to, from, body, mediaUrls }) {
  const form = new URLSearchParams();
  form.set("To", to);
  if (tw.messagingServiceSid && from === "service") form.set("MessagingServiceSid", tw.messagingServiceSid);
  else form.set("From", from);
  if (body) form.set("Body", body);
  for (const m of mediaUrls || []) form.append("MediaUrl", m);
  return twilioPost(tw, "/Messages.json", form);
}

// ---------- Quo (business texting + calling; API carried over from OpenPhone) ----------
const QUO_API = "https://api.openphone.com/v1";
async function quoFetch(cfg, pathName, opts = {}) {
  const res = await fetch(QUO_API + pathName, {
    ...opts,
    headers: { Authorization: cfg.quoApiKey, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let j; try { j = text ? JSON.parse(text) : {}; } catch { j = {}; }
  if (!res.ok) throw new Error(j.message || (j.errors && j.errors[0] && j.errors[0].message) || `Quo ${res.status}${res.status === 401 ? " — check API key" : ""}`);
  return j;
}
async function quoSendOne(cfg, { to, from, body }) {
  return quoFetch(cfg, "/messages", { method: "POST", body: JSON.stringify({ content: body, from, to: [to] }) });
}
// Recent conversations on an inbox — used to pull people out of Quo into the pipeline.
async function quoConversations(cfg, phoneNumberId, max) {
  const j = await quoFetch(cfg, `/conversations?phoneNumberId=${encodeURIComponent(phoneNumberId)}&maxResults=${max || 50}`);
  return j.data || [];
}
// One contact's thread. Quo returns newest-first; we flip it so it reads like a chat.
async function quoThread(cfg, phoneNumberId, participant, max) {
  const qs = `phoneNumberId=${encodeURIComponent(phoneNumberId)}&participants[]=${encodeURIComponent(participant)}&maxResults=${max || 50}`;
  const j = await quoFetch(cfg, "/messages?" + qs);
  return (j.data || [])
    .map((m) => ({
      id: m.id,
      direction: m.direction === "incoming" ? "in" : "out",
      at: m.createdAt || m.sentAt || "",
      body: m.text || m.body || "",
      from: m.from || "",
    }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
async function quoListNumbers(cfg) {
  const j = await quoFetch(cfg, "/phone-numbers");
  return (j.data || []).map((n) => ({ id: n.id, number: n.number, name: n.name }));
}

// ---------- SMS audience segments (phone,first_name) ----------
function extractPhones(csvText) {
  const rows = parseCSV((csvText || "").replace(/^﻿/, ""));
  if (!rows.length) return { recipients: [], invalid: 0, dupes: 0 };
  const found = detectColumn(rows, PHONE_EXACT, PHONE_SUBSTR, (v) => !!normalizePhone(v));
  if (!found) return { recipients: [], invalid: 0, dupes: 0, error: "No phone column found" };
  const nameCol = detectNameCol(found.headerCells);
  const start = found.headerRow >= 0 ? found.headerRow + 1 : 0;
  const seen = new Set(); const recipients = []; let invalid = 0, dupes = 0;
  for (const r of rows.slice(start)) {
    const phone = normalizePhone(r[found.col]);
    if (!phone) { invalid++; continue; }
    if (seen.has(phone)) { dupes++; continue; }
    seen.add(phone);
    recipients.push({ phone, name: nameCol >= 0 ? firstNameOf(r[nameCol]) : "" });
  }
  return { recipients, invalid, dupes };
}
function listSmsSegments() {
  if (!fs.existsSync(SMS_SEGMENTS)) return [];
  return fs.readdirSync(SMS_SEGMENTS).filter((f) => f.toLowerCase().endsWith(".csv")).map((f) => {
    const name = f.replace(/\.csv$/i, "");
    const { recipients } = extractPhones(fs.readFileSync(path.join(SMS_SEGMENTS, f), "utf8"));
    return { name, count: recipients.length };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
function resolveSmsAudience(segmentNames, pasted) {
  const seen = new Set(); const recipients = []; let invalid = 0, dupes = 0;
  const add = (phone, name) => {
    const p = normalizePhone(phone); if (!p) { invalid++; return; }
    if (seen.has(p)) { dupes++; return; }
    seen.add(p); recipients.push({ phone: p, name: name || "" });
  };
  for (const seg of segmentNames || []) {
    const file = path.join(SMS_SEGMENTS, seg + ".csv");
    if (!fs.existsSync(file)) continue;
    const res = extractPhones(fs.readFileSync(file, "utf8"));
    invalid += res.invalid;
    for (const r of res.recipients) add(r.phone, r.name);
  }
  for (const line of (pasted || "").split(/[\n,;]+/)) if (line.trim()) add(line, "");
  return { recipients, invalid, dupes };
}

// ---------- outreach state (call/text queue status per list) ----------
const OUTREACH = path.join(DATA, "outreach.json");
function loadOutreach() { try { return JSON.parse(fs.readFileSync(OUTREACH, "utf8")); } catch { return {}; } }
function saveOutreach(all) { fs.writeFileSync(OUTREACH, JSON.stringify(all, null, 2)); }

// ---------- funnel analytics (first-party pixel) ----------
const FUNNEL_LOG = path.join(DATA, "funnel-events.jsonl");
// $ value booked per tier conversion (initial cart value). Override in config.local.json → funnelPrices.
const FUNNEL_PRICES = { monthly: 99, annual: 891, lifetime: 1500, hh: 67, hhupsell: 97 };
const GIF_1x1 = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
function trackPixel(req, res, u) {
  try {
    const q = u.searchParams;
    const e = (q.get("e") || "").slice(0, 16);
    if (["view", "cta", "conv", "trial", "assign"].includes(e)) {
      const rec = {
        ts: Date.now(),
        e,
        v: (q.get("v") || "").slice(0, 24).toLowerCase(),
        tier: (q.get("tier") || "").slice(0, 16).toLowerCase(),
        f: (q.get("f") || "level11").slice(0, 32),
      };
      try { fs.mkdirSync(DATA, { recursive: true }); fs.appendFileSync(FUNNEL_LOG, JSON.stringify(rec) + "\n"); } catch {}
    }
  } catch {}
  res.writeHead(200, {
    "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache, must-revalidate",
    "Access-Control-Allow-Origin": "*", "Content-Length": GIF_1x1.length,
  });
  res.end(GIF_1x1);
}
function funnelPrices() { const c = loadConfig(); return { ...FUNNEL_PRICES, ...(c.funnelPrices || {}) }; }
function aggregateFunnel(fromTs, toTs, funnel) {
  const prices = funnelPrices();
  const V = () => ({ view: 0, cta: 0, conv: 0, trial: 0, revenue: 0, tiers: { monthly: 0, annual: 0, lifetime: 0 } });
  const byVariant = {}; const totals = V();
  if (fs.existsSync(FUNNEL_LOG)) {
    const lines = fs.readFileSync(FUNNEL_LOG, "utf8").split("\n");
    for (const ln of lines) {
      if (!ln.trim()) continue;
      let r; try { r = JSON.parse(ln); } catch { continue; }
      if (funnel && r.f !== funnel) continue;
      if (r.ts < fromTs || r.ts > toTs) continue;
      const v = r.v || "?";
      byVariant[v] = byVariant[v] || V();
      const slot = byVariant[v];
      if (r.e === "view") { slot.view++; totals.view++; }
      else if (r.e === "cta") { slot.cta++; totals.cta++; }
      else if (r.e === "conv") {
        slot.conv++; totals.conv++;
        const val = prices[r.tier] || 0;
        slot.revenue += val; totals.revenue += val;
        if (slot.tiers[r.tier] != null) { slot.tiers[r.tier]++; totals.tiers[r.tier]++; }
      }
      else if (r.e === "trial") { slot.trial++; totals.trial++; } // downstream step (e.g. 14-day-trial click)
    }
  }
  // Visitors come from our own pixel but conversions can come from the Kartra ledger, so
  // the two can disagree badly — if a lander stops pinging /t.gif you get 27 sales over 1
  // visitor and a 2700% "conversion rate". Anything derived from an impossible denominator
  // is returned as null (the UI shows "—") instead of a confident wrong number.
  const metrics = (s) => {
    const broken = s.conv > s.view;   // more conversions than visitors ⇒ views aren't being recorded
    return {
      ...s,
      convRate: s.view && !broken ? s.conv / s.view : null,  // visitor → buyer
      ctaRate: s.view ? s.cta / s.view : null,               // visitor → checkout click
      aov: s.conv ? s.revenue / s.conv : null,               // average order value
      epc: s.view && !broken ? s.revenue / s.view : null,    // earnings per visitor
      trackingBroken: broken,
    };
  };
  const variants = Object.keys(byVariant).sort().map((v) => ({ variant: v, ...metrics(byVariant[v]) }));
  return { funnel: funnel || "level11", prices, variants, totals: metrics(totals) };
}

// ---------- Meta (Facebook/Instagram) ad spend via Graph API ----------
// Live spend for the campaign(s) whose name matches metaCampaignFilter, so the
// July 4 view can show spend vs REAL ledger sales (Meta's own ROAS undercounts —
// its pixel can't see Kartra checkouts). Cached ~5 min.
let _metaCache = { key: "", at: 0, val: null };
async function getMetaSpend(cfg, from, to) {
  if (!cfg.metaAccessToken || !cfg.metaAdAccountId) return null; // not connected → view shows a connect prompt
  const since = from || "2026-07-04";
  const until = to || new Date().toISOString().slice(0, 10);
  const filter = cfg.metaCampaignFilter || "";
  const key = cfg.metaAdAccountId + "|" + filter + "|" + since + "|" + until;
  if (_metaCache.val && _metaCache.key === key && Date.now() - _metaCache.at < 300000) return _metaCache.val;
  const act = String(cfg.metaAdAccountId).startsWith("act_") ? cfg.metaAdAccountId : "act_" + cfg.metaAdAccountId;
  const tr = encodeURIComponent(JSON.stringify({ since, until }));
  const url = `https://graph.facebook.com/v21.0/${act}/insights?level=campaign&fields=campaign_name,spend&time_range=${tr}&limit=500&access_token=${encodeURIComponent(cfg.metaAccessToken)}`;
  const res = await fetch(url);
  const j = await res.json();
  if (j.error) throw new Error((j.error && j.error.message) || "Meta API error");
  const rx = filter ? new RegExp(filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
  let spend = 0; const campaigns = [];
  for (const row of (j.data || [])) {
    if (rx && !rx.test(row.campaign_name || "")) continue;
    const s = parseFloat(row.spend || "0") || 0;
    if (s <= 0) continue;
    spend += s; campaigns.push({ name: row.campaign_name, spend: Math.round(s * 100) / 100 });
  }
  campaigns.sort((a, b) => b.spend - a.spend);
  const val = { spend: Math.round(spend * 100) / 100, currency: "USD", campaigns, since, until };
  _metaCache = { key, at: Date.now(), val };
  return val;
}

// Real conversions come from the Kartra sales ledger, not the pixel: Kartra's
// post-purchase redirect bypasses the instrumented lander thank-you pages, so the
// `conv` pixel never fires. We pull actual Level 11 sales (count + $) from the ledger
// and fold them into the funnel. Tier is inferred from the charged amount; revenue is
// the real amount charged (not the list price).
// Which funnels reconcile against the Kartra ledger, and how to pick THEIR sales out of it.
// `min`/`max` matter when one Kartra product covers several offers — e.g. "Crate Hackers
// Hacker Hotel 2026" holds $27/$47 older passes, the $67 virtual pass, the $97 upsell and
// $497–$997 in-person tickets, so the funnel must only count its own price band.
// Price points we report separately for Hacker Hotel — $47 is the affiliate-code price,
// so the $47-vs-$67 split is the closest thing to affiliate-vs-house the ledger supports.
// (Declared before FUNNEL_LEDGER because that object references it.)
const HH_BANDS = [
  { id: "p17", label: "$17 deep discount", lo: 10, hi: 20 },
  { id: "p27", label: "$27 early bird", lo: 21, hi: 35 },
  { id: "p47", label: "$47 affiliate code", lo: 40, hi: 55 },
  { id: "p67", label: "$67 house price", lo: 56, hi: 80 },
  { id: "p97", label: "$97 full price", lo: 85, hi: 110 },
];
const FUNNEL_LEDGER = {
  "level11": { match: /level\s*-?\s*11/i, tier: (a) => (a >= 1200 ? "lifetime" : a >= 500 ? "annual" : "monthly") },
  // Every virtual pass, not just the $67 one. The pass has sold at $17 / $27 (early
  // bird) / $47 (affiliate-code price) / $67 (current house) / $97 (full), so the old
  // 55-80 band counted 27 of ~192 sales and hid every affiliate order. Anything from
  // $497 up is an in-person ticket on the same Kartra product; $0 rows are comps.
  "hacker-hotel": { match: /hacker\s*hotel/i, min: 1, max: 150, bands: HH_BANDS },
};
function ledgerSalesFor(rows, from, to, spec) {
  const inRange = (d) => (!from || d >= from) && (!to || d <= to);
  const out = { conv: 0, revenue: 0, tiers: { monthly: 0, annual: 0, lifetime: 0 }, bands: null, excluded: { comps: 0, aboveBand: 0 } };
  const bands = spec.bands ? spec.bands.map((b) => ({ ...b, count: 0, revenue: 0 })) : null;
  for (const r of rows) {
    if (r.type !== "sale" || !spec.match.test(r.product)) continue;
    if (!inRange(r.date)) continue;
    if (!(r.amount > 0)) { out.excluded.comps++; continue; }        // $0 comps / test rows
    if (spec.max != null && r.amount > spec.max) { out.excluded.aboveBand++; continue; } // e.g. in-person tickets
    if (spec.min != null && r.amount < spec.min) continue;
    out.conv++; out.revenue += r.amount;
    if (spec.tier) { const t = spec.tier(r.amount); if (out.tiers[t] != null) out.tiers[t]++; }
    if (bands) { const b = bands.find((x) => r.amount >= x.lo && r.amount <= x.hi); if (b) { b.count++; b.revenue += r.amount; } }
  }
  out.revenue = Math.round(out.revenue * 100) / 100;
  if (bands) { bands.forEach((b) => b.revenue = Math.round(b.revenue * 100) / 100); out.bands = bands; }
  return out;
}
// Fold real ledger conversions into a pixel-built funnel. Totals are exact. Per-variant
// conversions/revenue are *modeled* by each variant's checkout-click share (the variant
// the buyer saw isn't captured at the off-site Kartra checkout) -- flagged `estimated`.
function mergeLedgerConversions(funnel, sales) {
  const t = funnel.totals;
  t.conv = sales.conv; t.revenue = sales.revenue; t.tiers = sales.tiers;
  t.trackingBroken = t.conv > t.view;   // same guard as aggregateFunnel's metrics()
  t.convRate = t.view && !t.trackingBroken ? t.conv / t.view : null;
  t.aov = t.conv ? t.revenue / t.conv : null;
  t.epc = t.view && !t.trackingBroken ? t.revenue / t.view : null;
  funnel.bands = sales.bands || null;
  funnel.ledgerExcluded = sales.excluded || null;
  const vs = funnel.variants || [];
  const totalCta = vs.reduce((a, v) => a + (v.cta || 0), 0);
  const totalView = vs.reduce((a, v) => a + (v.view || 0), 0);
  const basis = totalCta > 0 ? "cta" : "view";
  const denom = totalCta > 0 ? totalCta : totalView;
  let convLeft = sales.conv, revLeft = sales.revenue;
  // The rounding remainder goes to the variant with the biggest share, not to whichever
  // one happens to sort last — otherwise a page with zero checkout clicks gets credited
  // with a sale (and, once rounding overshoots, negative revenue).
  let dumpIdx = 0, dumpShare = -1;
  vs.forEach((v, i) => {
    const s = denom > 0 ? (v[basis] || 0) / denom : 0;
    if (s > dumpShare) { dumpShare = s; dumpIdx = i; }
  });
  vs.forEach((v) => {
    const share = denom > 0 ? (v[basis] || 0) / denom : 0;
    v.conv = Math.round(sales.conv * share);
    v.revenue = Math.round(sales.revenue * share * 100) / 100;
    convLeft -= v.conv; revLeft -= v.revenue;
  });
  if (vs.length) {
    vs[dumpIdx].conv = Math.max(0, vs[dumpIdx].conv + convLeft);
    vs[dumpIdx].revenue = Math.max(0, Math.round((vs[dumpIdx].revenue + revLeft) * 100) / 100);
  }
  vs.forEach((v) => {
    v.trackingBroken = v.conv > v.view;
    v.convRate = v.view && !v.trackingBroken ? v.conv / v.view : null;
    v.aov = v.conv ? v.revenue / v.conv : null;
    v.epc = v.view && !v.trackingBroken ? v.revenue / v.view : null;
    v.estimated = true;
  });
  funnel.conversionSource = "ledger";
  funnel.variantConvEstimated = true;
  // Data health — the signature of this whole class of bug is "sales but no impressions".
  // Surfacing it beats waiting for someone to notice a 2700% rate.
  funnel.health = {
    pixelViews: t.view,
    ledgerConv: sales.conv,
    trackingBroken: !!t.trackingBroken,
    convNoViews: vs.filter((v) => v.conv > 0 && !v.view).map((v) => v.variant),
    viewsNoConv: vs.filter((v) => v.view > 0 && !v.conv).map((v) => v.variant),
  };
  return funnel;
}

// ---------- send jobs (in-memory progress, persisted to disk) ----------
const jobs = new Map();
function persistJob(job) {
  try { fs.mkdirSync(JOBS_DIR, { recursive: true }); fs.writeFileSync(path.join(JOBS_DIR, job.id + ".json"), JSON.stringify(job)); } catch {}
}
function readJob(id) {
  if (jobs.has(id)) return jobs.get(id);
  try { return JSON.parse(fs.readFileSync(path.join(JOBS_DIR, id + ".json"), "utf8")); } catch { return null; }
}

async function runSmsJob(jobId, opts) {
  const cfg = loadConfig();
  const job = jobs.get(jobId);
  const { body, from, mediaUrls, targets } = opts;
  const provider = opts.provider === "quo" ? "quo" : "twilio";
  const tw = resolveTwilio(cfg, opts.smsAccount); // Twilio sender account (Crate Hackers by default)
  if (!opts.isTest) {
    try { fs.mkdirSync(RECIPIENTS, { recursive: true }); fs.writeFileSync(path.join(RECIPIENTS, jobId + ".json"), JSON.stringify({ channel: "sms", phones: targets.map((t) => t.phone) })); } catch {}
  }
  let sent = 0; const failed = [];
  for (let i = 0; i < targets.length; i++) {
    if (job.cancelled) break;
    const r = targets[i];
    try {
      const personalized = (body || "").replace(/\{\{first_name\}\}/g, r.name || "there");
      if (provider === "quo") await quoSendOne(cfg, { to: r.phone, from, body: personalized });
      else await twilioSendOne(tw, { to: r.phone, from, body: personalized, mediaUrls });
      sent++;
    } catch (e) {
      failed.push({ To: r.phone, Message: e.message });
    }
    job.sent = sent; job.failed = failed.length; job.processed = i + 1;
    if (i + 1 < targets.length) await new Promise((res) => setTimeout(res, provider === "quo" ? 600 : 250)); // pacing for long-code limits
  }
  job.done = true; job.sent = sent; job.failed = failed.length; job.failures = failed;
  persistJob(job);
  if (!opts.isTest) {
    const list = loadCampaigns();
    list.unshift({ id: jobId, date: opts.now, subject: opts.preview, channel: "sms", provider,
      segments: opts.segments || [], recipients: targets.length, sent, failed: failed.length });
    saveCampaigns(list);
  }
  if (failed.length) fs.writeFileSync(path.join(DATA, `failed_sms_${jobId}.json`), JSON.stringify(failed, null, 2));
}

async function runSendJob(jobId, opts) {
  const cfg = loadConfig();
  const job = jobs.get(jobId);
  const { subject, html, text, fromEmail, fromName, replyTo, stream, tag, targets } = opts;
  const provider = opts.provider === "mailgun" ? "mailgun" : "postmark";
  const fromHeader = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  // Drip throttle (for warming a new sending domain) overrides the default batch size.
  const size = (opts.batchSize && opts.batchSize > 0) ? opts.batchSize : (provider === "mailgun" ? 1000 : BATCH_SIZE);
  // capture recipients for sales attribution (real sends only)
  if (!opts.isTest) {
    try { fs.mkdirSync(RECIPIENTS, { recursive: true }); fs.writeFileSync(path.join(RECIPIENTS, jobId + ".json"), JSON.stringify({ channel: "email", emails: targets.map((t) => t.email) })); } catch {}
  }
  let sent = 0, lastErr = "";
  const failed = [];
  for (let i = 0; i < targets.length; i += size) {
    if (job.cancelled) break;
    const batch = targets.slice(i, i + size);
    try {
      if (provider === "mailgun") {
        // Mailgun accepts the whole batch with per-recipient variables; bounces/suppressions
        // are handled server-side by Mailgun and surface later via its event log.
        await mailgunSendBatch(cfg, { subject, html, text, fromHeader, replyTo, tag, clickTracking: cfg.mailgunClickTracking }, batch);
        sent += batch.length;
      } else {
        const payload = batch.map((r) => ({
          From: fromHeader,
          To: r.email,
          ...(replyTo ? { ReplyTo: replyTo } : {}),
          Subject: personalize(subject, r.name),
          HtmlBody: personalize(html, r.name),
          TextBody: personalize(text, r.name),
          MessageStream: stream,
          Tag: tag,
          TrackOpens: true,
          TrackLinks: "HtmlAndText",
        }));
        const results = await postmark("/email/batch", "POST", payload, cfg.postmarkToken);
        for (let k = 0; k < results.length; k++) {
          if (results[k].ErrorCode === 0) sent++;
          else failed.push({ To: batch[k].email, Message: results[k].Message, ErrorCode: results[k].ErrorCode });
        }
      }
    } catch (e) {
      lastErr = e.message;
      failed.push(...batch.map((b) => ({ To: b.email, Message: e.message })));
    }
    job.sent = sent;
    job.failed = failed.length;
    job.processed = Math.min(i + size, targets.length);
    if (i + size < targets.length) await new Promise((r) => setTimeout(r, opts.batchDelayMs != null ? opts.batchDelayMs : (provider === "mailgun" ? 600 : 1200)));
  }
  job.done = true;
  job.sent = sent;
  job.failed = failed.length;
  job.failures = failed;
  if (!sent && lastErr) job.error = lastErr; // whole send blocked (e.g. Mailgun rate limit) — surface it
  persistJob(job);

  // log non-test campaigns
  if (!opts.isTest) {
    const list = loadCampaigns();
    list.unshift({
      id: jobId,
      date: opts.now,
      subject,
      segments: opts.segments,
      tag,
      provider,
      stream: provider === "mailgun" ? cfg.mailgunDomain : stream,
      recipients: targets.length,
      sent,
      failed: failed.length,
    });
    saveCampaigns(list);
  }
  if (failed.length) {
    fs.writeFileSync(path.join(DATA, `failed_${jobId}.json`), JSON.stringify(failed, null, 2));
  }
}

// ---------- shared launch helpers (used by /api/send, /api/sms/send, and the scheduler) ----------
function launchEmail(b) {
  const cfg = loadConfig();
  const provider = b.provider === "mailgun" ? "mailgun" : "postmark";
  if (provider === "postmark" && !cfg.postmarkToken) return { error: "Set your Postmark token in Settings first." };
  if (provider === "mailgun" && !(cfg.mailgunApiKey && cfg.mailgunDomain)) return { error: "Set your Mailgun API key and domain in Settings first." };
  if (!b.subject) return { error: "Subject is required." };
  if (!b.html) return { error: "Email body (HTML) is required." };
  const isTest = !!b.test;
  const segments = b.segments || [];
  const excludeSegments = b.excludeSegments || [];
  const targets = isTest ? [{ email: (b.testEmail || cfg.testEmail), name: "Dominick" }] : resolveAudience(segments, excludeSegments).recipients;
  if (!targets.length) return { error: "No recipients to send to." };
  const fromEmail = provider === "mailgun" ? (cfg.mailgunFromEmail || cfg.fromEmail) : cfg.fromEmail;
  const fromName = provider === "mailgun" ? (cfg.mailgunFromName || cfg.fromName) : cfg.fromName;
  const text = (b.text && b.text.trim()) ? b.text : htmlToText(b.html);
  const now = new Date().toISOString();
  const tag = (isTest ? "test-" : "") + slugify(b.subject) + "-" + now.slice(0, 10);
  const jobId = "job_" + now.replace(/[^0-9]/g, "").slice(0, 14) + "_" + Math.floor(targets.length);
  // Optional drip throttle — recommended when warming a new sending domain.
  // Sends `batchSize` recipients, waits `everyMin` minutes, repeats.
  const drip = (!isTest && b.drip && b.drip.on) ? {
    batchSize: Math.max(1, parseInt(b.drip.batchSize, 10) || 50),
    batchDelayMs: Math.max(0, Math.round((parseFloat(b.drip.everyMin) || 5) * 60000)),
  } : {};
  jobs.set(jobId, { id: jobId, total: targets.length, processed: 0, sent: 0, failed: 0, done: false, isTest, drip: drip.batchSize ? { batchSize: drip.batchSize, everyMin: drip.batchDelayMs / 60000 } : null });
  runSendJob(jobId, { provider, subject: b.subject, html: b.html, text, fromEmail, fromName, replyTo: cfg.replyTo, stream: cfg.stream, tag, targets, segments, isTest, now, ...drip });
  return { jobId, total: targets.length, tag, provider, drip: drip.batchSize ? { batchSize: drip.batchSize, everyMin: drip.batchDelayMs / 60000 } : null };
}
function launchSms(b) {
  const cfg = loadConfig();
  const provider = b.provider === "quo" ? "quo" : "twilio";
  if (!b.body && !(b.mediaUrls && b.mediaUrls.length)) return { error: "Add a message or an MMS image URL." };
  let from;
  if (provider === "quo") {
    if (!cfg.quoApiKey) return { error: "Set your Quo API key in Settings first." };
    if ((b.mediaUrls || []).filter(Boolean).length) return { error: "Quo sends are text-only here (no MMS) — switch to Twilio for MMS." };
    from = (b.from && b.from !== "service" ? b.from : "") || cfg.quoFromNumber;
    if (!from) return { error: "No Quo number. Add your Quo number in Settings (or hit Test to auto-detect it)." };
  } else {
    const tw = resolveTwilio(cfg, b.smsAccount);
    if (!twConfigured(tw)) return { error: (tw && tw.id !== "default") ? `Add credentials for the “${tw.label}” SMS account in Settings.` : (b.smsAccount && b.smsAccount !== "default") ? "That SMS sender account wasn't found." : "Set your Twilio credentials in Settings first." };
    from = b.from || (tw.messagingServiceSid ? "service" : tw.fromNumbers[0]);
    if (!from) return { error: `No sending number for ${tw.label}. Add a Twilio number (or Messaging Service) for this account in Settings.` };
  }
  const isTest = !!b.test;
  const segments = b.segments || [];
  let targets;
  if (isTest) { const ph = normalizePhone(b.testPhone || cfg.testPhone); if (!ph) return { error: "Enter a valid test phone number." }; targets = [{ phone: ph, name: "Dominick" }]; }
  else targets = resolveSmsAudience(segments, b.pasted || "").recipients;
  if (!targets.length) return { error: "No valid recipients." };
  const now = new Date().toISOString();
  const jobId = "sms_" + now.replace(/[^0-9]/g, "").slice(0, 14) + "_" + targets.length;
  jobs.set(jobId, { id: jobId, total: targets.length, processed: 0, sent: 0, failed: 0, done: false, isTest });
  runSmsJob(jobId, { body: b.body || "", from, provider, smsAccount: b.smsAccount || "default", mediaUrls: (b.mediaUrls || []).filter(Boolean), targets, segments, isTest, now, preview: (b.body || "(MMS)").slice(0, 60) });
  return { jobId, total: targets.length };
}

// ---------- scheduler (server-side; fires even if the browser is closed) ----------
const SCHEDULED = path.join(DATA, "scheduled");
const DRAFTS = path.join(DATA, "drafts");
// Normalize ANY draft file (our canonical {id,payload} OR a Cowork-style metadata file with
// sidecar .html / messages[]) into canonical drafts. One file may yield several (multi-message SMS).
function readDraftFile(file) {
  let raw; try { raw = JSON.parse(fs.readFileSync(path.join(DRAFTS, file), "utf8")); } catch { return []; }
  const baseId = file.replace(/\.json$/i, "");
  const updatedAt = raw.updatedAt || raw.createdAt || "";
  if (raw.payload) return [{ id: raw.id || baseId, channel: raw.channel, label: raw.label || baseId, payload: raw.payload, updatedAt }];
  if (raw.channel === "email") {
    let html = raw.html || "";
    if (raw.htmlFile) { try { html = fs.readFileSync(path.join(DRAFTS, raw.htmlFile), "utf8"); } catch {} }
    return [{ id: baseId, channel: "email", label: raw.label || raw.subject || baseId,
      payload: { subject: raw.subject || "", html, text: "", segments: raw.suggestedSegments || raw.segments || [], provider: raw.provider || "postmark" }, updatedAt }];
  }
  if (raw.channel === "sms" && Array.isArray(raw.messages)) {
    const links = raw.links || {};
    const sub = (t) => (t || "").replace(/\{\{link\}\}/g, links.link || "").replace(/\{\{room_link\}\}/g, links.room_link || "");
    return raw.messages.map((m, i) => ({ id: baseId + "#" + i, channel: "sms",
      label: (raw.label ? raw.label + " — " : "") + (m.when || "msg " + (i + 1)),
      payload: { body: sub(m.text), mediaUrls: [], from: "", segments: raw.suggestedSegments || [], pasted: "" }, updatedAt }));
  }
  if (raw.channel === "sms") return [{ id: baseId, channel: "sms", label: raw.label || baseId,
    payload: { body: raw.body || "", mediaUrls: raw.mediaUrls || [], from: raw.from || "", segments: raw.suggestedSegments || raw.segments || [], pasted: "" }, updatedAt }];
  return [];
}
function listDrafts() {
  if (!fs.existsSync(DRAFTS)) return [];
  const out = [];
  for (const f of fs.readdirSync(DRAFTS).filter((f) => f.endsWith(".json"))) out.push(...readDraftFile(f));
  return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}
function saveDraft(d) { fs.mkdirSync(DRAFTS, { recursive: true }); fs.writeFileSync(path.join(DRAFTS, d.id + ".json"), JSON.stringify(d)); }
function listScheduled() {
  if (!fs.existsSync(SCHEDULED)) return [];
  return fs.readdirSync(SCHEDULED).filter((f) => f.endsWith(".json"))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(SCHEDULED, f), "utf8")); } catch { return null; } })
    .filter(Boolean).sort((a, b) => a.at - b.at);
}
function saveScheduled(s) { fs.mkdirSync(SCHEDULED, { recursive: true }); fs.writeFileSync(path.join(SCHEDULED, s.id + ".json"), JSON.stringify(s)); }

// ---------- rename a list ----------
// The CSV filename IS the list name, so a rename is a file move. Both segment
// dirs share this; the caller passes SEGMENTS or SMS_SEGMENTS.
function renameSegmentFile(dir, from, to) {
  if (!from || !to) return { error: "Old and new name required." };
  if (from === to) return { ok: true, name: to };
  const src = path.join(dir, from + ".csv");
  if (!fs.existsSync(src)) return { error: `No list named "${from}".` };
  if (fs.existsSync(path.join(dir, to + ".csv"))) return { error: `A list named "${to}" already exists.` };
  fs.renameSync(src, path.join(dir, to + ".csv"));
  return { ok: true, name: to };
}
// A scheduled send stores its audience by name, so a rename would silently leave
// it pointing at nothing. Repoint anything still waiting to fire.
function repointScheduled(channel, from, to) {
  let touched = 0;
  const swap = (arr) => (Array.isArray(arr) && arr.includes(from) ? arr.map((n) => (n === from ? to : n)) : null);
  for (const s of listScheduled()) {
    if (s.status !== "scheduled" || s.channel !== channel) continue;
    const aud = swap(s.audience);
    const segs = s.payload && swap(s.payload.segments);
    if (!aud && !segs) continue;
    if (aud) s.audience = aud;
    if (segs) s.payload.segments = segs;
    saveScheduled(s);
    touched++;
  }
  return touched;
}
function runScheduler() {
  const now = Date.now();
  for (const s of listScheduled()) {
    if (s.status !== "scheduled" || s.at > now) continue;
    s.status = "sending"; saveScheduled(s);
    try {
      const r = s.channel === "sms" ? launchSms(s.payload) : launchEmail(s.payload);
      if (r.error) { s.status = "failed"; s.error = r.error; }
      else { s.status = "sent"; s.jobId = r.jobId; s.firedAt = new Date().toISOString(); s.total = r.total; }
    } catch (e) { s.status = "failed"; s.error = e.message; }
    saveScheduled(s);
    console.log(`  scheduler: fired ${s.id} (${s.channel}) → ${s.status}`);
  }
}
setInterval(runScheduler, 30000);
setTimeout(runScheduler, 3000);

// ---------- HTTP helpers ----------
function send(res, code, data, type = "application/json") {
  const body = type === "application/json" ? JSON.stringify(data) : data;
  res.writeHead(code, { "Content-Type": type });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon" };

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;
  try {
    // ----- health check (no auth — used by the host's uptime probe) -----
    if (p === "/healthz") return send(res, 200, { ok: true });

    // ----- funnel tracking pixel (public — the lander pages ping this) -----
    // /t.gif?e=view|cta|conv&v=<a|b|c>&tier=<monthly|annual|lifetime>&f=level11
    if (p === "/t.gif") return trackPixel(req, res, u);

    // ----- public ad-ingest endpoint for the Chrome extension (token-auth + CORS) -----
    if (p === "/api/ingest/ad") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
      if (req.method !== "POST") return send(res, 405, { error: "POST only" });
      const cfg = loadConfig();
      if (!cfg.adIngestToken) return send(res, 400, { error: "Ad ingest token not set on the server (AD_INGEST_TOKEN)." });
      const tok = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
      if (tok !== cfg.adIngestToken) return send(res, 401, { error: "Bad token." });
      if (!cfg.groqApiKey) return send(res, 400, { error: "Groq key not set on the server." });
      const b = await readBody(req);
      let transcript;
      try { transcript = await transcriptFromBody(cfg, b); }
      catch (e) { return send(res, 400, { error: "Transcription failed: " + ((e && e.message) || e) }); }
      if (!transcript) return send(res, 400, { error: "No transcript/caption, file, or media URL provided." });
      let analysis;
      try { analysis = await analyzeAd(cfg, { transcript, sourceUrl: (b.sourceUrl || "").trim(), notes: (b.notes || "").trim() }); }
      catch (e) { return send(res, 400, { error: "Analysis failed: " + ((e && e.message) || e) }); }
      const ad = { id: "ad_" + Date.now(), created: new Date().toISOString(), sourceUrl: (b.sourceUrl || "").trim(), mediaUrl: (b.mediaUrl || "").trim(), notes: (b.notes || "").trim(), transcript, ...analysis };
      const list = loadAds(); list.unshift(ad); saveAds(list);
      return send(res, 200, { ok: true, id: ad.id, summary: ad.summary });
    }

    // ----- auth gate -----
    if (p.startsWith("/auth/")) return auth.handleAuthRoute(req, res, u);
    const user = auth.requireUser(req, res, { isApi: p.startsWith("/api/") });
    if (!user) return; // requireUser already redirected / sent 401
    req._user = user;

    // ----- API -----
    if (p.startsWith("/api/")) {
      // who am I (for the UI's "signed in as … · Log out")
      if (p === "/api/me" && req.method === "GET") {
        return send(res, 200, { email: user.email, name: user.name, role: user.role, authEnabled: auth.enabled });
      }
      // Reps (outside sales team) only get Sell By Chat. Enforced here, not just by
      // hiding tabs — otherwise anyone could curl /api/settings and read the keys.
      if (user.role === "rep") {
        const repAllowed = p === "/api/sbc" || p.startsWith("/api/sbc/");
        if (!repAllowed) return send(res, 403, { error: "Your login only has access to Sell By Chat." });
      }
      // funnel analytics (visitors → checkout clicks → conversions → revenue, per variant)
      if (p === "/api/funnel" && req.method === "GET") {
        const from = u.searchParams.get("from") || "";
        const to = u.searchParams.get("to") || "";
        const fromTs = from ? new Date(from + "T00:00:00Z").getTime() : 0;
        const toTs = to ? new Date(to + "T23:59:59Z").getTime() : Date.now();
        const fn = u.searchParams.get("funnel") || "level11";
        const result = aggregateFunnel(fromTs, toTs, fn);
        // Conversions come from the real Kartra ledger (the lander pixel can't see them).
        if (FUNNEL_LEDGER[fn]) {
          try {
            const cfg = loadConfig();
            if (cfg.salesLedgerCsvUrl) {
              const rows = await fetchLedger(cfg.salesLedgerCsvUrl);
              mergeLedgerConversions(result, ledgerSalesFor(rows, from, to, FUNNEL_LEDGER[fn]));
            }
          } catch (e) { result.ledgerError = String(e && e.message || e); }
        }
        return send(res, 200, result);
      }
      // sale report: Kartra-ledger sales bucketed by price point (by amount) + by day.
      if (p === "/api/sale-report" && req.method === "GET") {
        const cfg = loadConfig();
        const empty = { connected: false, buckets: [], other: { count: 0, revenue: 0 }, byDay: [], totals: { count: 0, revenue: 0 } };
        if (!cfg.salesLedgerCsvUrl) return send(res, 200, empty);
        const from = u.searchParams.get("from") || "2026-07-04";
        const to = u.searchParams.get("to") || "";
        let rows; try { rows = await fetchLedger(cfg.salesLedgerCsvUrl); } catch (e) { return send(res, 200, { ...empty, error: String((e && e.message) || e) }); }
        const inRange = (dd) => (!from || dd >= from) && (!to || dd <= to);
        const buckets = [
          { id: "pp8", label: "$2.50 first month (PP8)", lo: 2.0, hi: 3.75, count: 0, revenue: 0 },
          { id: "pp39", label: "$148.50 annual — OTO (PP39)", lo: 140, hi: 156, count: 0, revenue: 0 },
          { id: "pp34", label: "$250 BOGO annual (PP34)", lo: 240, hi: 262, count: 0, revenue: 0 },
          { id: "pp597", label: "$597 OTO offer (oto-july26)", lo: 585, hi: 610, count: 0, revenue: 0 },
        ];
        let otherCount = 0, otherRev = 0; const byDay = {}; const totals = { count: 0, revenue: 0 };
        for (const r of rows) {
          if (r.type !== "sale" || !/crate\s*hackers/i.test(r.product)) continue;
          if (!inRange(r.date) || !(r.amount > 0)) continue;
          let hit = false;
          for (const b of buckets) { if (r.amount >= b.lo && r.amount <= b.hi) { b.count++; b.revenue += r.amount; hit = true; break; } }
          if (!hit) { otherCount++; otherRev += r.amount; }
          totals.count++; totals.revenue += r.amount;
          const day = byDay[r.date] || (byDay[r.date] = { count: 0, revenue: 0 });
          day.count++; day.revenue += r.amount;
        }
        buckets.forEach((b) => b.revenue = Math.round(b.revenue * 100) / 100);
        totals.revenue = Math.round(totals.revenue * 100) / 100;
        const byDayArr = Object.keys(byDay).sort().map((dd) => ({ date: dd, count: byDay[dd].count, revenue: Math.round(byDay[dd].revenue * 100) / 100 }));
        let adSpend = null, metaErr = null;
        try { const m = await getMetaSpend(cfg, from, to); if (m && typeof m.spend === "number") adSpend = { ...m, source: "meta" }; }
        catch (e) { metaErr = String((e && e.message) || e); }
        if (!adSpend && typeof cfg.adSpendManual === "number" && cfg.adSpendManual >= 0) adSpend = { spend: cfg.adSpendManual, manual: true };
        if (!adSpend && metaErr) adSpend = { error: metaErr };
        return send(res, 200, { connected: true, from, to, buckets, other: { count: otherCount, revenue: Math.round(otherRev * 100) / 100 }, byDay: byDayArr, totals, adSpend });
      }
      // set the manual ad-spend value shown in the July 4 view (used until a Meta token is set)
      if (p === "/api/sale-report/spend" && req.method === "POST") {
        const b = await readBody(req);
        const v = parseFloat(b.spend);
        if (!(v >= 0)) return send(res, 400, { error: "Enter a spend amount (a number ≥ 0)." });
        saveConfig({ adSpendManual: Math.round(v * 100) / 100 });
        return send(res, 200, { ok: true, spend: Math.round(v * 100) / 100 });
      }
      // failed payments (dunning / recovery) — Phase 1: visibility
      if (p === "/api/failed-payments" && req.method === "GET") {
        const cfg = loadConfig();
        const empty = { configured: !!cfg.stripeKey, summary: { people: 0, attempts: 0, atRisk: 0, repeat3plus: 0, byReason: {}, byProduct: {} }, rows: [], updated: 0 };
        if (!cfg.stripeKey) return send(res, 200, empty);
        const days = Math.min(90, Math.max(1, parseInt(u.searchParams.get("days") || "30", 10) || 30));
        const refresh = u.searchParams.get("refresh") === "1";
        let result = refresh ? null : loadFailedPaymentsCache();
        if (!result || result.days !== days) {
          try { result = await aggregateFailedPayments(cfg, days); }
          catch (e) { return send(res, 200, { ...empty, configured: true, error: String((e && e.message) || e) }); }
        }
        return send(res, 200, { configured: true, ...result });
      }
      // export the current failed-payment list (optionally filtered by reason) as an audience segment
      if (p === "/api/failed-payments/export" && req.method === "POST") {
        const cfg = loadConfig();
        if (!cfg.stripeKey) return send(res, 400, { error: "Connect Stripe first." });
        const b = await readBody(req);
        const reason = (b.reason || "").trim();
        const days = Math.min(90, Math.max(1, parseInt(b.days, 10) || 30));
        let result = loadFailedPaymentsCache();
        if (!result || result.days !== days) { try { result = await aggregateFailedPayments(cfg, days); } catch (e) { return send(res, 400, { error: String((e && e.message) || e) }); } }
        let rows = result.rows || [];
        if (reason === "dead_card_repeat") rows = rows.filter((r) => r.attempts >= 3);
        else if (reason) rows = rows.filter((r) => r.reason === reason);
        const map = new Map();
        for (const r of rows) if (r.email) map.set(r.email, (r.name || "").split(" ")[0] || "");
        const label = "failed-" + (reason || "all") + "-" + result.days + "d";
        writeSegmentFromMap(label, map);
        return send(res, 200, { segment: slugify(label), count: map.size });
      }
      // ad library
      if (p === "/api/ads" && req.method === "GET") {
        return send(res, 200, { configured: !!loadConfig().groqApiKey, ads: loadAds() });
      }
      if (p === "/api/ads" && req.method === "POST") {
        const cfg = loadConfig();
        if (!cfg.groqApiKey) return send(res, 400, { error: "Add your Groq API key in Settings first." });
        const b = await readBody(req);
        let transcript;
        try { transcript = await transcriptFromBody(cfg, b); }
        catch (e) { return send(res, 400, { error: "Transcription failed: " + ((e && e.message) || e) }); }
        if (!transcript) return send(res, 400, { error: "Paste the transcript/caption, upload a video, or give a direct media URL." });
        let analysis;
        try { analysis = await analyzeAd(cfg, { transcript, sourceUrl: (b.sourceUrl || "").trim(), notes: (b.notes || "").trim() }); }
        catch (e) { return send(res, 400, { error: "Analysis failed: " + ((e && e.message) || e) }); }
        const ad = { id: "ad_" + Date.now(), created: new Date().toISOString(), sourceUrl: (b.sourceUrl || "").trim(), mediaUrl: (b.mediaUrl || "").trim(), notes: (b.notes || "").trim(), transcript, ...analysis };
        const list = loadAds(); list.unshift(ad); saveAds(list);
        return send(res, 200, { ad });
      }
      // send an influencer/affiliate a brief for a specific ad
      if (p === "/api/ads/brief" && req.method === "POST") {
        const b = await readBody(req);
        const to = (b.to || "").trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return send(res, 400, { error: "Enter a valid recipient email." });
        const subject = (b.subject || "").trim() || "A Crate Hackers content idea for you";
        const html = (b.html || "").trim();
        if (!html) return send(res, 400, { error: "The brief is empty." });
        try { const r = await sendOneEmail(loadConfig(), { to, toName: (b.toName || "").trim(), subject, html }); return send(res, 200, { ok: true, provider: r.provider }); }
        catch (e) { return send(res, 400, { error: String((e && e.message) || e) }); }
      }
      // influencer/affiliate list for the brief recipient picker
      if (p === "/api/influencers" && req.method === "GET") {
        return send(res, 200, { influencers: loadInfluencers() });
      }
      if (p === "/api/influencers/import" && req.method === "POST") {
        const b = await readBody(req);
        const rows = parseCSV(b.csv || "");
        if (rows.length < 2) return send(res, 400, { error: "That CSV looks empty." });
        const header = rows[0].map((h) => h.trim().toLowerCase());
        const ci = (names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
        const iName = ci(["name", "full name", "contact"]);
        const iEmail = ci(["email", "email address", "customer_email"]);
        const iIg = ci(["instagram", "ig", "handle", "ig_normalized"]);
        const iLtv = ci(["customer_value", "ltv", "value", "revenue"]);
        if (iEmail < 0) return send(res, 400, { error: "No email column found in that CSV." });
        const out = []; const seen = new Set();
        for (const r of rows.slice(1)) {
          const email = (r[iEmail] || "").trim().toLowerCase();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || seen.has(email)) continue;
          seen.add(email);
          out.push({ name: (iName >= 0 ? r[iName] || "" : "").trim(), email, instagram: (iIg >= 0 ? r[iIg] || "" : "").trim(), ltv: parseFloat(String(iLtv >= 0 ? r[iLtv] || "" : "").replace(/[^0-9.]/g, "")) || 0 });
        }
        // merge into the existing list (dedupe by email) so influencers + affiliates coexist
        const byEmail = new Map(loadInfluencers().map((x) => [x.email, x]));
        for (const row of out) byEmail.set(row.email, { ...byEmail.get(row.email), ...row });
        const merged = [...byEmail.values()].sort((a, b) => b.ltv - a.ltv);
        saveInfluencers(merged);
        return send(res, 200, { ok: true, count: merged.length, imported: out.length });
      }
      // ---------- Sell By Chat ----------
      if (p === "/api/sbc" && req.method === "GET") {
        const d = loadSbc();
        const today = todayISO();
        const ps = d.prospects;
        const byStage = {}; SBC_STAGES.forEach((s) => byStage[s] = 0);
        const byRep = {}; SBC_REPS.forEach((r) => byRep[r] = { lead: 0, qualified: 0, offer_made: 0, closed_won: 0, closed_lost: 0, won: 0 });
        let pipelineValue = 0, wonValue = 0;
        for (const x of ps) {
          if (byStage[x.stage] != null) byStage[x.stage]++;
          const rep = byRep[x.rep] || (byRep[x.rep] = { lead: 0, qualified: 0, offer_made: 0, closed_won: 0, closed_lost: 0, won: 0 });
          if (rep[x.stage] != null) rep[x.stage]++;
          const v = Number(x.value) || 0;
          if (x.stage === "closed_won") { wonValue += v; rep.won += v; }
          else if (x.stage !== "closed_lost") pipelineValue += v;
        }
        // Pipeline health — the numbers that tell you WHERE it's leaking, not just totals.
        const now = Date.now();
        const hrs = (a, b2) => (a && b2 ? (new Date(b2).getTime() - new Date(a).getTime()) / 36e5 : null);
        const ttl = ps.map((x) => hrs(x.createdAt, x.firstTouchAt)).filter((v) => v != null && v >= 0);
        const untouched = ps.filter((x) => !x.firstTouchAt && x.stage !== "closed_won" && x.stage !== "closed_lost");
        const stalled = ps
          .filter((x) => x.stage !== "closed_won" && x.stage !== "closed_lost")
          .map((x) => ({ id: x.id, name: x.name || x.handle, rep: x.rep, stage: x.stage,
            idleDays: Math.floor((now - new Date(x.lastTouchAt || x.createdAt).getTime()) / 864e5) }))
          .filter((x) => x.idleDays >= 3)
          .sort((a, b2) => b2.idleDays - a.idleDays);
        const scored = ps.filter((x) => typeof x.lastScore === "number");
        const health = {
          speedToLeadHrs: ttl.length ? Math.round((ttl.reduce((a, v) => a + v, 0) / ttl.length) * 10) / 10 : null,
          untouched: untouched.length,
          stalled: stalled.slice(0, 12),
          stalledCount: stalled.length,
          avgScore: scored.length ? Math.round((scored.reduce((a, x) => a + x.lastScore, 0) / scored.length) * 10) / 10 : null,
          scoredCount: scored.length,
          // where conversations die: how many reached each stage at least once
          reached: SBC_STAGES.reduce((acc, s) => {
            acc[s] = ps.filter((x) => (x.history || []).some((h) => h.stage === s)).length;
            return acc;
          }, {}),
        };
        // Money actually banked in the campaign window, per offer, off the Kartra ledger
        let offers = null, banked = 0, ledgerError = null;
        try {
          const cfg = loadConfig();
          if (cfg.salesLedgerCsvUrl) {
            const rows = await fetchLedger(cfg.salesLedgerCsvUrl);
            offers = offerSalesFor(rows, d.from, d.to);
            banked = Math.round(offers.reduce((a, o) => a + o.revenue, 0) * 100) / 100;
          }
        } catch (e) { ledgerError = String((e && e.message) || e); }
        return send(res, 200, {
          goal: d.goal, from: d.from, to: d.to,
          reps: SBC_REPS, stages: SBC_STAGES, cadence: SBC_CADENCE,
          prospects: ps, byStage, byRep, pipelineValue: Math.round(pipelineValue * 100) / 100,
          wonValue: Math.round(wonValue * 100) / 100,
          dueToday: ps.filter((x) => x.nextAt && x.nextAt <= today && x.stage !== "closed_won" && x.stage !== "closed_lost").length,
          today, offers, banked, remaining: Math.round((d.goal - banked) * 100) / 100, ledgerError,
          health, aiReady: !!loadConfig().groqApiKey,
        });
      }
      if (p === "/api/sbc/goal" && req.method === "POST") {
        const b = await readBody(req);
        const d = loadSbc();
        if ("goal" in b) {
          const g = parseFloat(b.goal);
          if (!(g >= 0)) return send(res, 400, { error: "Enter a dollar goal." });
          d.goal = Math.round(g);
        }
        if (b.from) d.from = String(b.from).slice(0, 10);
        if (b.to) d.to = String(b.to).slice(0, 10);
        saveSbc(d);
        return send(res, 200, { ok: true, goal: d.goal, from: d.from, to: d.to });
      }
      if (p === "/api/sbc/prospect" && req.method === "POST") {
        const b = await readBody(req);
        const handle = String(b.handle || "").trim().replace(/^@/, "");
        if (!handle) return send(res, 400, { error: "Handle is required." });
        const d = loadSbc();
        const platform = String(b.platform || "ig").toLowerCase();
        const id = platform + ":" + handle.toLowerCase();
        if (d.prospects.some((x) => x.id === id)) return send(res, 400, { error: `${handle} is already in the pipeline — check who owns it before you DM.` });
        const rep = SBC_REPS.includes(b.rep) ? b.rep : "dom";
        d.prospects.unshift({
          id, platform, handle, name: String(b.name || "").trim(), rep,
          stage: "lead", offer: String(b.offer || "").trim(), value: Number(b.value) || 0,
          email: String(b.email || "").trim().toLowerCase(), phone: normalizePhone(b.phone || ""),
          escalated: false, source: String(b.source || "manual"),
          pointA: "", pointB: "", roadblock: "", pain: "", notes: String(b.notes || "").trim(),
          touches: 0, nextAt: sbcNextDate(0), createdAt: new Date().toISOString(), history: [{ at: new Date().toISOString(), stage: "lead" }],
        });
        saveSbc(d);
        return send(res, 200, { ok: true, id, total: d.prospects.length });
      }
      if (p.startsWith("/api/sbc/prospect/") && req.method === "PATCH") {
        const id = decodeURIComponent(p.slice("/api/sbc/prospect/".length));
        const b = await readBody(req);
        const d = loadSbc();
        const x = d.prospects.find((y) => y.id === id);
        if (!x) return send(res, 404, { error: "No such prospect." });
        if (b.stage && SBC_STAGES.includes(b.stage) && b.stage !== x.stage) {
          x.stage = b.stage;
          x.history = (x.history || []).concat([{ at: new Date().toISOString(), stage: b.stage }]);
        }
        if (b.rep && SBC_REPS.includes(b.rep)) x.rep = b.rep;
        for (const k of ["name", "offer", "pointA", "pointB", "roadblock", "pain", "notes"]) if (k in b) x[k] = String(b[k] || "");
        if ("value" in b) x.value = Number(b.value) || 0;
        if ("email" in b) x.email = String(b.email || "").trim().toLowerCase();
        if ("phone" in b) x.phone = normalizePhone(b.phone || "");
        // "on the fence" → hand to Nick to close
        if ("escalated" in b) {
          x.escalated = !!b.escalated;
          if (x.escalated) x.rep = "nick";
        }
        // "logged a touch" advances the cadence rather than making you pick a date
        if (b.touched) {
          x.touches = (x.touches || 0) + 1;
          x.nextAt = sbcNextDate(x.touches);
          x.lastTouchAt = new Date().toISOString();
          if (!x.firstTouchAt) x.firstTouchAt = x.lastTouchAt;   // speed-to-lead baseline
        }
        if (b.nextAt) x.nextAt = String(b.nextAt).slice(0, 10);
        saveSbc(d);
        return send(res, 200, { ok: true, prospect: x });
      }
      // Paste a DM thread → what to send next. The rep still works inside Instagram;
      // we can't read the thread for them without Meta's Messaging API.
      if (p === "/api/sbc/copilot" && req.method === "POST") {
        const b = await readBody(req);
        const cfg = loadConfig();
        if (!cfg.groqApiKey) return send(res, 400, { error: "Add your Groq API key in Settings to use the copilot." });
        const convo = String(b.conversation || "").trim();
        if (convo.length < 20) return send(res, 400, { error: "Paste the conversation first." });
        const prospect = b.id ? loadSbc().prospects.find((x) => x.id === b.id) : null;
        try { return send(res, 200, { ok: true, ...(await sbcCopilot(cfg, { conversation: convo, prospect })) }); }
        catch (e) { return send(res, 400, { error: String((e && e.message) || e) }); }
      }
      // Score a finished (or stalled) conversation against the playbook rubric.
      if (p === "/api/sbc/coach" && req.method === "POST") {
        const b = await readBody(req);
        const cfg = loadConfig();
        if (!cfg.groqApiKey) return send(res, 400, { error: "Add your Groq API key in Settings to use the coach." });
        const convo = String(b.conversation || "").trim();
        if (convo.length < 20) return send(res, 400, { error: "Paste the conversation first." });
        try {
          const out = await sbcCoach(cfg, { conversation: convo });
          // keep the score on the prospect so the pipeline can show coaching history
          if (b.id && out.score != null) {
            const d = loadSbc();
            const x = d.prospects.find((y) => y.id === b.id);
            if (x) { x.lastScore = out.score; x.lastScoredAt = new Date().toISOString(); saveSbc(d); }
          }
          return send(res, 200, { ok: true, ...out });
        } catch (e) { return send(res, 400, { error: String((e && e.message) || e) }); }
      }
      // ---- Quo: read the actual text threads, and pull people out of Quo ----
      if (p === "/api/sbc/quo/inboxes" && req.method === "GET") {
        const cfg = loadConfig();
        if (!cfg.quoApiKey) return send(res, 400, { error: "Add your Quo API key in Settings first." });
        try {
          const nums = await quoListNumbers(cfg);
          return send(res, 200, { ok: true, inboxes: (nums || []).map((n) => ({
            id: n.id, number: n.number || n.phoneNumber || "",
            name: n.name || "", users: (n.users || []).map((u) => u.name || u.email || "").filter(Boolean),
          })) });
        } catch (e) { return send(res, 400, { error: String((e && e.message) || e) }); }
      }
      // The thread for one prospect. Tries each inbox, because the three reps are on
      // different numbers and a conversation only lives on the one that had it.
      if (p === "/api/sbc/quo/thread" && req.method === "GET") {
        const cfg = loadConfig();
        if (!cfg.quoApiKey) return send(res, 400, { error: "Add your Quo API key in Settings first." });
        const id = u.searchParams.get("id") || "";
        const d = loadSbc();
        const x = d.prospects.find((y) => y.id === id);
        const phone = normalizePhone(u.searchParams.get("phone") || (x && x.phone) || "");
        if (!phone) return send(res, 400, { error: "No phone number on this prospect yet." });
        try {
          const nums = await quoListNumbers(cfg);
          const wanted = u.searchParams.get("inbox");
          const list = wanted ? (nums || []).filter((n) => n.id === wanted) : (nums || []);
          for (const n of list) {
            const msgs = await quoThread(cfg, n.id, phone, 50);
            if (msgs.length) {
              return send(res, 200, { ok: true, phone, inbox: { id: n.id, number: n.number, name: n.name }, messages: msgs });
            }
          }
          return send(res, 200, { ok: true, phone, inbox: null, messages: [] });
        } catch (e) { return send(res, 400, { error: String((e && e.message) || e) }); }
      }
      // Pull recent Quo conversations into the pipeline as prospects.
      if (p === "/api/sbc/quo/import" && req.method === "POST") {
        const b = await readBody(req);
        const cfg = loadConfig();
        if (!cfg.quoApiKey) return send(res, 400, { error: "Add your Quo API key in Settings first." });
        const d = loadSbc();
        const rep = SBC_REPS.includes(b.rep) ? b.rep : "dom";
        const inboxId = String(b.inbox || "").trim();
        if (!inboxId) return send(res, 400, { error: "Pick an inbox." });
        let added = 0, skipped = 0;
        try {
          const convos = await quoConversations(cfg, inboxId, Math.min(Number(b.limit) || 50, 100));
          const byPhone = new Map(d.prospects.filter((x) => x.phone).map((x) => [x.phone, x]));
          for (const c of convos) {
            // a conversation's participants exclude our own number
            const other = (c.participants || []).map((v) => normalizePhone(v)).filter(Boolean)[0];
            if (!other) { skipped++; continue; }
            if (byPhone.has(other)) { skipped++; continue; }
            const id = "quo:" + other;
            if (d.prospects.some((x) => x.id === id)) { skipped++; continue; }
            byPhone.set(other, true);
            d.prospects.unshift({
              id, platform: "quo", handle: other, name: (c.name || "").split(/\s+/)[0] || "",
              rep, stage: "lead", offer: "", value: 0, email: "", phone: other,
              escalated: false, source: "quo", applied: false,
              pointA: "", pointB: "", roadblock: "", pain: "",
              notes: `From Quo${c.lastActivityAt ? " · last activity " + String(c.lastActivityAt).slice(0, 10) : ""}.`,
              touches: 0, nextAt: sbcNextDate(0), createdAt: new Date().toISOString(),
              history: [{ at: new Date().toISOString(), stage: "lead" }],
            });
            added++;
          }
        } catch (e) { return send(res, 400, { error: String((e && e.message) || e) }); }
        saveSbc(d);
        return send(res, 200, { ok: true, added, skipped, total: d.prospects.length });
      }
      // Typeform application import (CSV export). The in-person application is where
      // the high-ticket money is, and it already asks the two questions the playbook
      // needs — "#1 goal" is their Point B and "what do you want to work on" is the
      // pain. Merged by email so an applicant who also bought a pass stays one row.
      if (p === "/api/sbc/import-typeform" && req.method === "POST") {
        const b = await readBody(req);
        const rows = parseCSV(b.csv || "");
        if (rows.length < 2) return send(res, 400, { error: "That CSV looks empty." });
        const hdr = rows[0].map((h) => (h || "").trim());
        // match on the question text, not column position — the forms differ
        const find = (...subs) => {
          for (const s of subs) {
            const i = hdr.findIndex((h) => h.toLowerCase().includes(s));
            if (i >= 0) return i;
          }
          return -1;
        };
        const iName = find("full name", "your name");
        const iEmail = find("best email", "email address", "your email", "email");
        const iPhone = find("enrich_phone", "phone number", "mobile");
        const iGoal = find("#1 goal", "goal for attending", "why do you want");
        const iPain = find("learn or work on", "want to learn", "biggest challenge", "struggling");
        const iGear = find("specific controller", "what dj gear");
        const iSoft = find("dj software");
        const iCity = find("enrich_city");
        const iWhen = find("submit date", "start date");
        if (iEmail < 0) return send(res, 400, { error: "No email column found in that export." });
        const d = loadSbc();
        const rep = SBC_REPS.includes(b.rep) ? b.rep : "dom";
        const at = (r, i) => (i >= 0 && i < r.length ? (r[i] || "").trim() : "");
        let added = 0, merged = 0, skipped = 0;
        for (const r of rows.slice(1)) {
          const email = at(r, iEmail).toLowerCase();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { skipped++; continue; }
          const goal = at(r, iGoal), pain = at(r, iPain);
          const gear = [at(r, iGear), at(r, iSoft), at(r, iCity)].filter(Boolean).join(" · ");
          const note = `Applied for Hacker Hotel in-person${at(r, iWhen) ? " on " + at(r, iWhen).slice(0, 10) : ""}.${gear ? " " + gear + "." : ""}`;
          const existing = d.prospects.find((x) => (x.email || "").toLowerCase() === email);
          if (existing) {
            // an application tells us more than a purchase row did — fill the gaps
            if (goal && !existing.pointB) existing.pointB = goal;
            if (pain && !existing.pain) existing.pain = pain;
            if (!existing.phone) existing.phone = normalizePhone(at(r, iPhone));
            if (!existing.name) existing.name = at(r, iName).split(/\s+/)[0] || "";
            existing.applied = true;
            // re-importing the same export shouldn't stack the same note over and over
            if (!(existing.notes || "").includes("Applied for Hacker Hotel in-person")) {
              existing.notes = (existing.notes ? existing.notes + " " : "") + note;
            }
            merged++;
          } else {
            d.prospects.unshift({
              id: "typeform:" + email, platform: "typeform", handle: email,
              name: at(r, iName).split(/\s+/)[0] || "", rep, stage: "lead",
              offer: "HH 2026 In-Person", value: 0, email,
              phone: normalizePhone(at(r, iPhone)), escalated: false, source: "typeform",
              applied: true, pointA: "", pointB: goal, roadblock: "", pain,
              notes: note, touches: 0, nextAt: sbcNextDate(0),
              createdAt: new Date().toISOString(), history: [{ at: new Date().toISOString(), stage: "lead" }],
            });
            added++;
          }
        }
        saveSbc(d);
        return send(res, 200, { ok: true, added, merged, skipped, total: d.prospects.length });
      }
      // Pull virtual-pass buyers out of the Kartra ledger and into the pipeline.
      // The ledger is the only place a purchase shows up, and it carries name + email
      // but NOT a phone, so phones are filled in per-prospect (see /api/sbc/enrich).
      if (p === "/api/sbc/sync" && req.method === "POST") {
        const cfg = loadConfig();
        if (!cfg.salesLedgerCsvUrl) return send(res, 400, { error: "No sales ledger URL configured." });
        const b = await readBody(req);
        const d = loadSbc();
        const rep = SBC_REPS.includes(b.rep) ? b.rep : "travis";
        let rows;
        try { rows = await fetchLedger(cfg.salesLedgerCsvUrl); }
        catch (e) { return send(res, 400, { error: "Ledger fetch failed: " + String((e && e.message) || e) }); }
        const seen = new Set(d.prospects.map((x) => x.id));
        const byEmail = new Set(d.prospects.map((x) => (x.email || "").toLowerCase()).filter(Boolean));
        const spec = FUNNEL_LEDGER["hacker-hotel"];
        let added = 0, skipped = 0;
        for (const r of rows) {
          if (r.type !== "sale" || !spec.match.test(r.product)) continue;
          if (!(r.amount >= spec.min && r.amount <= spec.max)) continue;   // virtual passes only
          if (d.from && r.date < d.from) continue;
          if (d.to && r.date > d.to) continue;
          const email = (r.email || "").toLowerCase();
          if (!email) { skipped++; continue; }
          const id = "kartra:" + email;
          if (seen.has(id) || byEmail.has(email)) { skipped++; continue; }
          seen.add(id); byEmail.add(email);
          const first = (r.name || "").trim().split(/\s+/)[0] || "";
          d.prospects.unshift({
            id, platform: "kartra", handle: email, name: first, rep,
            stage: "lead", offer: "HH 2026 Virtual Pass", value: 0,
            email, phone: "", escalated: false, source: "kartra-ledger",
            pointA: "", pointB: "", roadblock: "", pain: "",
            notes: `Bought the virtual pass for $${r.amount} on ${r.date}.`,
            touches: 0, nextAt: sbcNextDate(0), createdAt: new Date().toISOString(),
            history: [{ at: new Date().toISOString(), stage: "lead" }],
          });
          added++;
        }
        saveSbc(d);
        return send(res, 200, { ok: true, added, skipped, total: d.prospects.length });
      }
      // Best-effort phone lookup. Kartra's get_lead is the only source we have for a
      // number — the ledger sheet has no phone column at all.
      if (p === "/api/sbc/enrich" && req.method === "POST") {
        const b = await readBody(req);
        const cfg = loadConfig();
        if (!(cfg.kartraAppId && cfg.kartraApiKey)) return send(res, 400, { error: "Add your Kartra credentials in Settings to look up phone numbers." });
        const d = loadSbc();
        const ids = (Array.isArray(b.ids) ? b.ids : []).slice(0, 25);
        let found = 0; const misses = [];
        for (const id of ids) {
          const x = d.prospects.find((y) => y.id === id);
          if (!x || !x.email || x.phone) continue;
          try {
            const j = await kartraGetLead(cfg, x.email);
            const det = j && (j.lead_details || j.lead || {});
            const raw = det.phone || det.phone_number || det.mobile || det.cell || "";
            const ph = normalizePhone(raw);
            if (ph) { x.phone = ph; found++; } else misses.push(x.email);
          } catch (e) { misses.push(x.email + " (" + String((e && e.message) || e).slice(0, 60) + ")"); }
        }
        saveSbc(d);
        return send(res, 200, { ok: true, found, misses });
      }
      // Text a prospect from the Hacker Hotel HQ Quo number.
      if (p === "/api/sbc/text" && req.method === "POST") {
        const b = await readBody(req);
        const cfg = loadConfig();
        if (!cfg.quoApiKey) return send(res, 400, { error: "Add your Quo API key in Settings first." });
        const d = loadSbc();
        const x = d.prospects.find((y) => y.id === b.id);
        if (!x) return send(res, 404, { error: "No such prospect." });
        const phone = normalizePhone(x.phone || b.phone || "");
        if (!phone) return send(res, 400, { error: "No phone number for this prospect yet." });
        const body = String(b.body || "").trim();
        if (!body) return send(res, 400, { error: "Write something to send." });
        const from = cfg.hhFromNumber || cfg.quoFromNumber;
        if (!from) return send(res, 400, { error: "No Quo number set. Add one in Settings." });
        try {
          await quoSendOne(cfg, { to: phone, from, body: personalize(body, x.name) });
        } catch (e) { return send(res, 400, { error: String((e && e.message) || e) }); }
        x.phone = phone;
        x.touches = (x.touches || 0) + 1;
        x.nextAt = sbcNextDate(x.touches);
        x.lastTouchAt = new Date().toISOString();
        if (!x.firstTouchAt) x.firstTouchAt = x.lastTouchAt;
        x.texts = (x.texts || []).concat([{ at: x.lastTouchAt, by: user.email, body }]);
        saveSbc(d);
        return send(res, 200, { ok: true, nextAt: x.nextAt, touches: x.touches });
      }
      if (p.startsWith("/api/sbc/prospect/") && req.method === "DELETE") {
        const id = decodeURIComponent(p.slice("/api/sbc/prospect/".length));
        const d = loadSbc();
        d.prospects = d.prospects.filter((x) => x.id !== id);
        saveSbc(d);
        return send(res, 200, { ok: true });
      }

      // ---------- creators ----------
      if (p === "/api/creators" && req.method === "GET") {
        return send(res, 200, { creators: loadCreators(), credits: SC_CREDITS, configured: !!loadConfig().scrapeCreatorsKey });
      }
      // Balance check is free, so the tab can show it on load and Settings can
      // verify a key without spending anything. Heads-up: a bad key still returns
      // 200 with creditCount 0, so zero means "wrong key OR genuinely empty".
      if (p === "/api/creators/credits" && req.method === "GET") {
        const cfg = loadConfig();
        if (!cfg.scrapeCreatorsKey) return send(res, 200, { configured: false, credits: null });
        try {
          const j = await scrapeCreators(cfg, "/v1/account/credit-balance", {});
          const credits = typeof j.creditCount === "number" ? j.creditCount : null;
          SC_CREDITS = credits;
          return send(res, 200, { configured: true, credits });
        } catch (e) { return send(res, 400, { error: String((e && e.message) || e) }); }
      }
      // Live search — results are NOT saved, so you can look without committing.
      if (p === "/api/creators/search" && req.method === "POST") {
        const b = await readBody(req);
        const platform = String(b.platform || "").toLowerCase();
        const query = String(b.query || "").trim();
        if (!CREATOR_PLATFORMS.includes(platform)) return send(res, 400, { error: "Pick TikTok, Instagram or YouTube." });
        if (!query) return send(res, 400, { error: "Enter something to search for." });
        try {
          const found = await searchCreators(loadConfig(), platform, query);
          const saved = new Set(loadCreators().map((c) => c.id));
          const min = num(b.minFollowers);
          const results = found
            .map((c) => ({ ...c, id: creatorId(c.platform, c.handle), query, saved: saved.has(creatorId(c.platform, c.handle)) }))
            .filter((c) => c.followers >= min)
            .sort((a, b2) => b2.followers - a.followers);
          return send(res, 200, { ok: true, results, credits: SC_CREDITS });
        } catch (e) { return send(res, 400, { error: String((e && e.message) || e) }); }
      }
      // Keep the ones worth chasing. Merges by id so re-saving updates rather than duplicates.
      if (p === "/api/creators/save" && req.method === "POST") {
        const b = await readBody(req);
        const incoming = Array.isArray(b.creators) ? b.creators : [];
        if (!incoming.length) return send(res, 400, { error: "Nothing selected." });
        const byId = new Map(loadCreators().map((c) => [c.id, c]));
        let added = 0;
        for (const c of incoming) {
          const platform = String(c.platform || "").toLowerCase();
          const handle = String(c.handle || "").replace(/^@/, "");
          if (!CREATOR_PLATFORMS.includes(platform) || !handle) continue;
          const id = creatorId(platform, handle);
          if (!byId.has(id)) added++;
          byId.set(id, {
            status: "new", foundAt: new Date().toISOString(), enrichedAt: null, email: "", bio: "", link: "",
            ...byId.get(id),
            id, platform, handle,
            name: c.name || (byId.get(id) || {}).name || "",
            followers: num(c.followers) || num((byId.get(id) || {}).followers),
            posts: num(c.posts) || num((byId.get(id) || {}).posts),
            avgViews: num(c.avgViews) || num((byId.get(id) || {}).avgViews),
            verified: !!c.verified || !!(byId.get(id) || {}).verified,
            avatar: c.avatar || (byId.get(id) || {}).avatar || "",
            url: c.url || (byId.get(id) || {}).url || "",
            query: c.query || (byId.get(id) || {}).query || "",
          });
        }
        const merged = [...byId.values()].sort((a, b2) => b2.followers - a.followers);
        saveCreators(merged);
        return send(res, 200, { ok: true, added, total: merged.length });
      }
      // One credit per creator — the client sends a bounded batch and we report what it cost.
      if (p === "/api/creators/enrich" && req.method === "POST") {
        const b = await readBody(req);
        const ids = (Array.isArray(b.ids) ? b.ids : []).slice(0, 25);
        if (!ids.length) return send(res, 400, { error: "Nothing selected." });
        const cfg = loadConfig();
        const list = loadCreators();
        const byId = new Map(list.map((c) => [c.id, c]));
        let done = 0; const failed = [];
        for (const id of ids) {
          const c = byId.get(id);
          if (!c) continue;
          try {
            const extra = await enrichCreator(cfg, c.platform, c.handle);
            // a blank from the profile shouldn't wipe what search already gave us
            for (const [k, v] of Object.entries(extra)) if (v !== "" && v != null) c[k] = v;
            c.enrichedAt = new Date().toISOString();
            done++;
          } catch (e) {
            failed.push({ id, error: String((e && e.message) || e) });
            if (String(e && e.message).includes("out of credits")) break;
          }
        }
        saveCreators([...byId.values()].sort((a, b2) => b2.followers - a.followers));
        return send(res, 200, { ok: true, enriched: done, failed, credits: SC_CREDITS });
      }
      // Hand the ones with an email to the Ad Library brief sender.
      if (p === "/api/creators/to-influencers" && req.method === "POST") {
        const b = await readBody(req);
        const ids = new Set(Array.isArray(b.ids) ? b.ids : []);
        const picked = loadCreators().filter((c) => (ids.size ? ids.has(c.id) : true) && c.email);
        if (!picked.length) return send(res, 400, { error: "None of those have an email yet — enrich them first." });
        const byEmail = new Map(loadInfluencers().map((x) => [x.email, x]));
        for (const c of picked) {
          const prev = byEmail.get(c.email) || {};
          byEmail.set(c.email, {
            ...prev,
            name: c.name || prev.name || c.handle,
            email: c.email,
            instagram: c.platform === "instagram" ? c.handle : (prev.instagram || ""),
            ltv: prev.ltv || 0,
          });
        }
        const merged = [...byEmail.values()].sort((a, b2) => (b2.ltv || 0) - (a.ltv || 0));
        saveInfluencers(merged);
        return send(res, 200, { ok: true, pushed: picked.length, total: merged.length });
      }
      if (p.startsWith("/api/creators/") && req.method === "PATCH") {
        const id = decodeURIComponent(p.slice("/api/creators/".length));
        const b = await readBody(req);
        const list = loadCreators();
        const c = list.find((x) => x.id === id);
        if (!c) return send(res, 404, { error: "No such creator." });
        if (b.status) c.status = String(b.status);
        if ("email" in b) c.email = String(b.email || "").trim().toLowerCase();
        if ("notes" in b) c.notes = String(b.notes || "");
        saveCreators(list);
        return send(res, 200, { ok: true, creator: c });
      }
      if (p.startsWith("/api/creators/") && req.method === "DELETE") {
        const id = decodeURIComponent(p.slice("/api/creators/".length));
        saveCreators(loadCreators().filter((c) => c.id !== id));
        return send(res, 200, { ok: true });
      }
      if (p.startsWith("/api/ads/") && req.method === "DELETE") {
        const id = p.slice("/api/ads/".length);
        saveAds(loadAds().filter((a) => a.id !== id));
        return send(res, 200, { ok: true });
      }
      // settings
      if (p === "/api/settings" && req.method === "GET") {
        const c = loadConfig();
        return send(res, 200, {
          fromEmail: c.fromEmail, fromName: c.fromName, stream: c.stream,
          replyTo: c.replyTo, testEmail: c.testEmail,
          hasToken: !!c.postmarkToken, hasStripe: !!c.stripeKey,
          hasPaypal: !!(c.paypalClientId && c.paypalSecret), paypalEnv: c.paypalEnv,
          hasKartra: !!(c.kartraAppId && c.kartraApiKey),
          hasScrapeCreators: !!c.scrapeCreatorsKey,
          hasMailgun: !!(c.mailgunApiKey && c.mailgunDomain),
          mailgunDomain: c.mailgunDomain, mailgunRegion: c.mailgunRegion,
          mailgunFromEmail: c.mailgunFromEmail, mailgunFromName: c.mailgunFromName,
          mailgunClickTracking: c.mailgunClickTracking,
          salesLedgerCsvUrl: c.salesLedgerCsvUrl,
          hasTwilio: !!(c.twilioAccountSid && c.twilioAuthToken),
          twilioFromNumbers: fromNumbersList(c), twilioMessagingServiceSid: c.twilioMessagingServiceSid,
          twilioAccountSid: c.twilioAccountSid ? c.twilioAccountSid.slice(0, 6) + "…" + c.twilioAccountSid.slice(-4) : "",
          hasQuo: !!c.quoApiKey, quoFromNumber: c.quoFromNumber, hhFromNumber: c.hhFromNumber,
          testPhone: c.testPhone,
        });
      }
      if (p === "/api/settings" && req.method === "POST") {
        const b = await readBody(req);
        const patch = {};
        for (const k of ["fromEmail", "fromName", "stream", "replyTo", "testEmail", "paypalEnv",
          "mailgunDomain", "mailgunRegion", "mailgunFromEmail", "mailgunFromName", "salesLedgerCsvUrl", "groqApiKey", "adIngestToken", "scrapeCreatorsKey",
          "twilioFromNumbers", "twilioMessagingServiceSid", "testPhone", "quoFromNumber", "hhFromNumber"]) if (k in b) patch[k] = b[k];
        if (b.postmarkToken) patch.postmarkToken = b.postmarkToken.trim();
        if (b.mailgunApiKey) patch.mailgunApiKey = b.mailgunApiKey.trim();
        if ("mailgunClickTracking" in b) patch.mailgunClickTracking = !!b.mailgunClickTracking;
        if (b.twilioAccountSid) patch.twilioAccountSid = b.twilioAccountSid.trim();
        if (b.twilioAuthToken) patch.twilioAuthToken = b.twilioAuthToken.trim();
        if (b.quoApiKey) patch.quoApiKey = b.quoApiKey.trim();
        if (b.stripeKey) patch.stripeKey = b.stripeKey.trim();
        if (b.paypalClientId) patch.paypalClientId = b.paypalClientId.trim();
        if (b.paypalSecret) patch.paypalSecret = b.paypalSecret.trim();
        if (b.kartraAppId) patch.kartraAppId = b.kartraAppId.trim();
        if (b.kartraApiKey) patch.kartraApiKey = b.kartraApiKey.trim();
        if (b.kartraApiPassword) patch.kartraApiPassword = b.kartraApiPassword.trim();
        saveConfig(patch);
        return send(res, 200, { ok: true });
      }
      if (p === "/api/test-connection" && req.method === "POST") {
        const c = loadConfig();
        const b = await readBody(req);
        const provider = b.provider === "mailgun" ? "mailgun" : "postmark";
        if (provider === "mailgun") {
          if (!c.mailgunApiKey || !c.mailgunDomain) return send(res, 200, { ok: false, error: "Set your Mailgun API key and domain first." });
          try { const name = await mailgunTest(c); return send(res, 200, { ok: true, server: name }); }
          catch (e) { return send(res, 200, { ok: false, error: e.message }); }
        }
        if (!c.postmarkToken) return send(res, 200, { ok: false, error: "No Postmark token set." });
        try {
          const server = await postmark("/server", "GET", null, c.postmarkToken);
          return send(res, 200, { ok: true, server: server.Name });
        } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
      }

      // segments
      if (p === "/api/segments" && req.method === "GET") {
        return send(res, 200, { segments: listSegments(), suppression: loadSuppression().size });
      }
      if (p === "/api/segments" && req.method === "POST") {
        const b = await readBody(req);
        const name = slugify(b.name);
        if (!name || !b.csv) return send(res, 400, { error: "name and csv required" });
        const { recipients, error } = extractRecipients(b.csv);
        if (error) return send(res, 400, { error });
        fs.writeFileSync(path.join(SEGMENTS, name + ".csv"), b.csv);
        return send(res, 200, { ok: true, name, count: recipients.length });
      }
      if (p.startsWith("/api/segments/") && req.method === "DELETE") {
        const name = slugify(decodeURIComponent(p.split("/").pop()));
        const f = path.join(SEGMENTS, name + ".csv");
        if (fs.existsSync(f)) fs.unlinkSync(f);
        return send(res, 200, { ok: true });
      }
      if (p.startsWith("/api/segments/") && req.method === "PATCH") {
        const from = slugify(decodeURIComponent(p.split("/").pop()));
        const b = await readBody(req);
        const to = slugify(b.name || "");
        if (!to) return send(res, 400, { error: "New name required." });
        const r = renameSegmentFile(SEGMENTS, from, to);
        if (r.error) return send(res, 400, r);
        return send(res, 200, { ok: true, name: to, rescheduled: repointScheduled("email", from, to) });
      }

      // suppression
      if (p === "/api/suppression" && req.method === "GET") {
        return send(res, 200, { list: [...loadSuppression()] });
      }
      if (p === "/api/suppression" && req.method === "POST") {
        const b = await readBody(req);
        const cur = loadSuppression();
        if ("replace" in b) cur.clear(); // saving the box replaces the whole list, even when cleared
        const incoming = "replace" in b ? b.replace : (b.add || "");
        incoming.split(/[\s,;]+/).map((e) => e.trim().toLowerCase())
          .filter((e) => e.includes("@")).forEach((e) => cur.add(e));
        fs.writeFileSync(SUPPRESSION, [...cur].join("\n"));
        return send(res, 200, { ok: true, count: cur.size });
      }

      // preview audience
      if (p === "/api/preview" && req.method === "POST") {
        const b = await readBody(req);
        const r = resolveAudience(b.segments || [], b.excludeSegments || []);
        const size = b.provider === "mailgun" ? 1000 : BATCH_SIZE;
        return send(res, 200, {
          recipients: r.recipients.length, invalid: r.invalid,
          dupes: r.dupes, suppressed: r.suppressed, excluded: r.excluded,
          batches: Math.ceil(r.recipients.length / size),
          sample: r.recipients.slice(0, 5).map((x) => x.email),
        });
      }

      // send
      if (p === "/api/send" && req.method === "POST") {
        const r = launchEmail(await readBody(req));
        return send(res, r.error ? 400 : 200, r);
      }
      if (p.startsWith("/api/send/status/") && req.method === "GET") {
        const job = readJob(p.split("/").pop());
        if (!job) return send(res, 404, { error: "job not found" });
        return send(res, 200, job);
      }

      // analytics — overall + per campaign (provider = postmark | mailgun)
      if (p === "/api/analytics" && req.method === "GET") {
        const cfg = loadConfig();
        const campaigns = loadCampaigns();
        const providerSel = u.searchParams.get("provider") === "mailgun" ? "mailgun" : "postmark";
        const from = u.searchParams.get("from") || "";
        const to = u.searchParams.get("to") || "";
        const out = {
          campaigns, provider: providerSel,
          hasToken: !!cfg.postmarkToken,
          hasMailgun: !!(cfg.mailgunApiKey && cfg.mailgunDomain),
        };
        if (providerSel === "mailgun") {
          if (cfg.mailgunApiKey && cfg.mailgunDomain) {
            try {
              const s = await getMailgunStats(cfg, from, to);
              out.overview = {
                sent: s.delivered || s.accepted, accepted: s.accepted, delivered: s.delivered,
                bounced: s.failed, spam: s.complained, unsubscribed: s.unsubscribed,
                opens: s.opened, uniqueOpens: s.opened, clicks: s.clicked, uniqueClicks: s.clicked,
              };
            } catch (e) { out.statsError = e.message; }
          }
        } else if (cfg.postmarkToken) {
          const params = { fromdate: from, todate: to };
          try {
            const [overview, opens, clicks] = await Promise.all([
              postmarkStats("/stats/outbound", params, cfg.postmarkToken),
              postmarkStats("/stats/outbound/opens", params, cfg.postmarkToken),
              postmarkStats("/stats/outbound/clicks", params, cfg.postmarkToken),
            ]);
            out.overview = {
              sent: overview.Sent || 0,
              bounced: overview.Bounced || 0,
              bounceRate: overview.BounceRate || 0,
              spam: overview.SpamComplaints || 0,
              spamRate: overview.SpamComplaintsRate || 0,
              opens: opens.Opens || 0,
              uniqueOpens: opens.Unique || 0,
              clicks: clicks.Clicks || 0,
              uniqueClicks: clicks.Unique || 0,
            };
          } catch (e) { out.statsError = e.message; }
        }
        return send(res, 200, out);
      }

      // sales ledger (Google Sheet)
      if (p === "/api/ledger" && req.method === "GET") {
        const cfg = loadConfig();
        if (!cfg.salesLedgerCsvUrl) return send(res, 200, { connected: false });
        try {
          const rows = await fetchLedger(cfg.salesLedgerCsvUrl);
          const agg = aggregateLedger(rows, u.searchParams.get("from") || "", u.searchParams.get("to") || "");
          return send(res, 200, { connected: true, ...agg });
        } catch (e) { return send(res, 200, { connected: true, error: e.message }); }
      }

      // SMS analytics (Twilio usage) — defaults to Crate Hackers; ?account=<id> for another sender
      if (p === "/api/analytics/sms" && req.method === "GET") {
        const cfg = loadConfig();
        const tw = resolveTwilio(cfg, u.searchParams.get("account") || "default");
        if (!twConfigured(tw)) return send(res, 200, { connected: false });
        try {
          const s = await getTwilioStats(tw, u.searchParams.get("from") || "", u.searchParams.get("to") || "");
          return send(res, 200, { connected: true, ...s });
        } catch (e) { return send(res, 200, { connected: true, error: e.message }); }
      }

      // sales attribution — revenue per campaign (last-touch within window)
      if (p === "/api/analytics/attribution" && req.method === "GET") {
        const cfg = loadConfig();
        const windowDays = Math.max(1, Math.min(90, parseInt(u.searchParams.get("window") || "7", 10)));
        if (!cfg.salesLedgerCsvUrl) return send(res, 200, { connected: false });
        try {
          const rows = await fetchLedger(cfg.salesLedgerCsvUrl);
          const attr = computeAttribution(loadCampaigns(), rows, windowDays);
          const currency = rows.find((r) => r.currency) ? rows.find((r) => r.currency).currency : "USD";
          return send(res, 200, { connected: true, windowDays, currency, attribution: attr });
        } catch (e) { return send(res, 200, { connected: true, error: e.message }); }
      }

      // per-campaign stats by tag (provider-aware)
      if (p === "/api/analytics/campaign" && req.method === "GET") {
        const cfg = loadConfig();
        const tag = u.searchParams.get("tag");
        const prov = u.searchParams.get("provider") === "mailgun" ? "mailgun" : "postmark";
        try {
          if (prov === "mailgun") {
            if (!(cfg.mailgunApiKey && cfg.mailgunDomain)) return send(res, 200, { error: "No Mailgun" });
            const s = await getMailgunStats(cfg, "", "", tag);
            return send(res, 200, { sent: s.delivered || s.accepted, bounced: s.failed, uniqueOpens: s.opened, uniqueClicks: s.clicked });
          }
          if (!cfg.postmarkToken) return send(res, 200, { error: "No token" });
          const [overview, opens, clicks] = await Promise.all([
            postmarkStats("/stats/outbound", { tag }, cfg.postmarkToken),
            postmarkStats("/stats/outbound/opens", { tag }, cfg.postmarkToken),
            postmarkStats("/stats/outbound/clicks", { tag }, cfg.postmarkToken),
          ]);
          return send(res, 200, {
            sent: overview.Sent || 0, bounced: overview.Bounced || 0,
            uniqueOpens: opens.Unique || 0, uniqueClicks: clicks.Unique || 0,
          });
        } catch (e) { return send(res, 200, { error: e.message }); }
      }

      // sales — aggregate across Stripe + PayPal + Kartra
      if (p === "/api/sales" && req.method === "GET") {
        const cfg = loadConfig();
        const from = u.searchParams.get("from");
        const to = u.searchParams.get("to");
        const hasStripe = !!cfg.stripeKey;
        const hasPaypal = !!(cfg.paypalClientId && cfg.paypalSecret);
        const hasKartra = !!(cfg.kartraAppId && cfg.kartraApiKey);
        if (!hasStripe && !hasPaypal && !hasKartra) return send(res, 200, { connected: false });

        const gte = from ? Math.floor(new Date(from).getTime() / 1000) : Math.floor(Date.now() / 1000) - 30 * 86400;
        const lte = to ? Math.floor(new Date(to).getTime() / 1000) + 86399 : null;
        const fromDate = from || new Date(gte * 1000).toISOString().slice(0, 10);
        const toDate = to || new Date().toISOString().slice(0, 10);

        const sources = {};
        let total = 0, currency = "USD";
        if (hasStripe) {
          try { const s = await getStripeSales(cfg, gte, lte); sources.stripe = s; total += s.net; currency = s.currency; }
          catch (e) { sources.stripe = { error: e.message }; }
        }
        if (hasPaypal) {
          try { const pp = await getPaypalSales(cfg, fromDate, toDate); sources.paypal = pp; total += pp.gross; }
          catch (e) { sources.paypal = { error: e.message }; }
        }
        if (hasKartra) {
          // Kartra's API can't bulk-report sales (lead-lookup only), so it doesn't
          // contribute to the revenue total — Stripe + PayPal cover the actual money.
          sources.kartra = { note: "Lead-lookup API only — revenue tracked via Stripe + PayPal" };
        }
        return send(res, 200, { connected: true, total: Math.round(total * 100) / 100, currency, sources });
      }

      // test sales connections
      if (p === "/api/sales/test" && req.method === "POST") {
        const cfg = loadConfig();
        const out = {};
        if (cfg.stripeKey) {
          try { const a = await stripeGet("account", cfg); out.stripe = { ok: true, id: a.id || a.email || "connected" }; }
          catch (e) { out.stripe = { ok: false, error: e.message }; }
        }
        if (cfg.paypalClientId && cfg.paypalSecret) {
          try { await paypalAuth(cfg); out.paypal = { ok: true, env: cfg.paypalEnv }; }
          catch (e) { out.paypal = { ok: false, error: e.message }; }
        }
        if (cfg.kartraAppId && cfg.kartraApiKey) {
          try { const note = await kartraTest(cfg); out.kartra = { ok: true, note }; }
          catch (e) { out.kartra = { ok: false, error: e.message }; }
        }
        return send(res, 200, out);
      }

      // build active/canceled segments from Stripe subscriptions
      if (p === "/api/segments/from-stripe" && req.method === "POST") {
        const cfg = loadConfig();
        if (!cfg.stripeKey) return send(res, 400, { error: "Add a Stripe key in Settings first." });
        try {
          const active = await getStripeSubscribers(cfg, "active");
          const canceled = await getStripeSubscribers(cfg, "canceled");
          for (const e of active.keys()) canceled.delete(e); // resubscribed → keep as active only
          writeSegmentFromMap("stripe-active", active);
          writeSegmentFromMap("stripe-canceled", canceled);
          return send(res, 200, { ok: true, active: active.size, canceled: canceled.size });
        } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
      }

      // ----- Quo (business texting + calling) -----
      // list all numbers in the Quo account (for the SMS "send from" picker)
      if (p === "/api/sms/quo-numbers" && req.method === "GET") {
        const cfg = loadConfig();
        if (!cfg.quoApiKey) return send(res, 200, { numbers: [] });
        try { return send(res, 200, { numbers: await quoListNumbers(cfg) }); }
        catch (e) { return send(res, 200, { numbers: [], error: String((e && e.message) || e) }); }
      }
      if (p === "/api/quo/test" && req.method === "POST") {
        const cfg = loadConfig();
        if (!cfg.quoApiKey) return send(res, 200, { ok: false, error: "Add your Quo API key first (Quo → Settings → API)." });
        try {
          const nums = await quoListNumbers(cfg);
          if (!cfg.quoFromNumber && nums.length) saveConfig({ quoFromNumber: nums[0].number });
          return send(res, 200, { ok: true, server: nums.length ? nums.map((n) => `${n.number}${n.name ? " (" + n.name + ")" : ""}`).join(", ") : "Connected — no numbers found", numbers: nums.map((n) => n.number) });
        } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
      }

      // ----- outreach (call/text queue over an SMS segment; status + notes persisted) -----
      if (p === "/api/outreach" && req.method === "GET") {
        const list = u.searchParams.get("list") || "";
        const lists = listSmsSegments();
        if (!list) return send(res, 200, { lists });
        const file = path.join(SMS_SEGMENTS, slugify(list) + ".csv");
        if (!fs.existsSync(file)) return send(res, 404, { error: "list not found" });
        const raw = fs.readFileSync(file, "utf8");
        const { recipients } = extractPhones(raw);
        let p2e = {}; try { p2e = JSON.parse(fs.readFileSync(PHONE_EMAIL_MAP, "utf8")); } catch {}
        let ltvMap = {}; try { ltvMap = JSON.parse(fs.readFileSync(PHONE_LTV_MAP, "utf8")); } catch {}
        // LTV from the list's own "ltv" column (exact), if present
        const segLtv = {};
        try {
          const rr = parseCSV(raw.replace(/^﻿/, ""));
          const h = (rr[0] || []).map((x) => x.trim().toLowerCase());
          const pi = h.findIndex((x) => /phone|mobile|cell|number/.test(x));
          const li = h.findIndex((x) => x === "ltv" || x.includes("value") || x.includes("spent"));
          if (pi >= 0 && li >= 0) for (const r of rr.slice(1)) {
            const ph = normalizePhone(r[pi]); if (ph) segLtv[ph] = parseFloat(String(r[li] || "").replace(/[^0-9.]/g, "")) || 0;
          }
        } catch {}
        const state = loadOutreach()[slugify(list)] || {};
        const rows = recipients.map((r) => ({
          phone: r.phone, name: r.name, email: p2e[r.phone] || "",
          ltv: segLtv[r.phone] != null ? segLtv[r.phone] : (ltvMap[r.phone] || 0),
          status: (state[r.phone] && state[r.phone].status) || "todo",
          note: (state[r.phone] && state[r.phone].note) || "",
        }));
        return send(res, 200, { lists, list: slugify(list), rows });
      }
      // one-tap text-first opener: send a single personalized Quo text to one row
      if (p === "/api/outreach/text" && req.method === "POST") {
        const cfg = loadConfig();
        const b = await readBody(req);
        const phone = normalizePhone(b.phone || "");
        if (!phone) return send(res, 400, { error: "Invalid phone number." });
        if (!(b.body || "").trim()) return send(res, 400, { error: "Write an opener message first." });
        if (!cfg.quoApiKey) return send(res, 400, { error: "Set your Quo API key in Settings first." });
        if (!cfg.quoFromNumber) return send(res, 400, { error: "No Quo number — hit Test in Settings → Quo to auto-fill it." });
        const personalized = b.body.replace(/\{\{first_name\}\}/g, (b.name || "").trim() || "there");
        try {
          await quoSendOne(cfg, { to: phone, from: cfg.quoFromNumber, body: personalized });
          // mark the row "texted" server-side so the state is atomic with the send
          if (b.list) {
            const all = loadOutreach(); const list = slugify(b.list);
            all[list] = all[list] || {};
            all[list][phone] = { ...(all[list][phone] || {}), status: "texted", note: (all[list][phone] && all[list][phone].note) || "", updatedAt: new Date().toISOString() };
            saveOutreach(all);
          }
          return send(res, 200, { ok: true, sent: personalized });
        } catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (p === "/api/outreach" && req.method === "POST") {
        const b = await readBody(req);
        const list = slugify(b.list || ""); const phone = normalizePhone(b.phone || "");
        if (!list || !phone) return send(res, 400, { error: "list and phone required" });
        const all = loadOutreach();
        all[list] = all[list] || {};
        all[list][phone] = { status: b.status || "todo", note: b.note || "", updatedAt: new Date().toISOString() };
        saveOutreach(all);
        return send(res, 200, { ok: true });
      }

      // ----- Twilio / SMS -----
      if (p === "/api/twilio/test" && req.method === "POST") {
        const cfg = loadConfig();
        const bt = await readBody(req);
        const tw = resolveTwilio(cfg, (bt && bt.account) || "default");
        if (!twConfigured(tw)) return send(res, 200, { ok: false, error: "Add this account's Twilio credentials first." });
        try { const a = await twilioGetAccount(tw); return send(res, 200, { ok: true, server: `${a.friendly_name || tw.label} · ${a.status}` }); }
        catch (e) { return send(res, 200, { ok: false, error: e.message }); }
      }
      // extra SMS sender accounts (other companies) — list / add-or-update / delete
      if (p === "/api/sms-accounts" && req.method === "GET") {
        const cfg = loadConfig();
        const list = (cfg.smsAccounts || []).map((a) => ({ id: a.id, label: a.label, accountSid: a.accountSid, fromNumbers: a.fromNumbers || "", messagingServiceSid: a.messagingServiceSid || "", configured: !!(a.accountSid && (a.apiKeySecret || a.authToken)) }));
        return send(res, 200, { accounts: list });
      }
      if (p === "/api/sms-accounts" && req.method === "POST") {
        const cfg = loadConfig();
        const b = await readBody(req);
        const label = (b.label || "").trim();
        if (!label) return send(res, 400, { error: "Give the account a label (e.g. Both Lighting USA)." });
        const accountSid = (b.accountSid || "").trim();
        if (!/^AC[0-9a-zA-Z]{20,}$/.test(accountSid)) return send(res, 400, { error: "Enter a valid Account SID (starts with AC…)." });
        const id = ((b.id || "").trim()) || slugify(label);
        const accounts = (cfg.smsAccounts || []).slice();
        const existing = accounts.find((a) => a.id === id);
        const apiKeySid = (b.apiKeySid || "").trim() || (existing && existing.apiKeySid) || "";
        const apiKeySecret = (b.apiKeySecret || "").trim() || (existing && existing.apiKeySecret) || "";
        const authToken = (b.authToken || "").trim() || (existing && existing.authToken) || "";
        if (!(apiKeySid && apiKeySecret) && !authToken) return send(res, 400, { error: "Enter an API Key SID + Secret (or an Account Auth Token)." });
        const rec = { id, label, accountSid, apiKeySid, apiKeySecret, authToken, fromNumbers: (b.fromNumbers || "").trim(), messagingServiceSid: (b.messagingServiceSid || "").trim() };
        const idx = accounts.findIndex((a) => a.id === id);
        if (idx >= 0) accounts[idx] = rec; else accounts.push(rec);
        saveConfig({ smsAccounts: accounts });
        return send(res, 200, { ok: true, id, label });
      }
      if (p.startsWith("/api/sms-accounts/") && req.method === "DELETE") {
        const cfg = loadConfig();
        const id = decodeURIComponent(p.slice("/api/sms-accounts/".length));
        saveConfig({ smsAccounts: (cfg.smsAccounts || []).filter((a) => a.id !== id) });
        return send(res, 200, { ok: true });
      }
      if (p === "/api/sms/segments" && req.method === "GET") {
        return send(res, 200, { segments: listSmsSegments() });
      }
      if (p === "/api/sms/segments" && req.method === "POST") {
        const b = await readBody(req);
        const name = slugify(b.name);
        if (!name || !b.csv) return send(res, 400, { error: "name and csv required" });
        const { recipients, error } = extractPhones(b.csv);
        if (error) return send(res, 400, { error });
        fs.mkdirSync(SMS_SEGMENTS, { recursive: true });
        fs.writeFileSync(path.join(SMS_SEGMENTS, name + ".csv"), b.csv);
        return send(res, 200, { ok: true, name, count: recipients.length });
      }
      if (p.startsWith("/api/sms/segments/") && req.method === "DELETE") {
        const name = slugify(decodeURIComponent(p.split("/").pop()));
        const f = path.join(SMS_SEGMENTS, name + ".csv");
        if (fs.existsSync(f)) fs.unlinkSync(f);
        return send(res, 200, { ok: true });
      }
      if (p.startsWith("/api/sms/segments/") && req.method === "PATCH") {
        const from = slugify(decodeURIComponent(p.split("/").pop()));
        const b = await readBody(req);
        const to = slugify(b.name || "");
        if (!to) return send(res, 400, { error: "New name required." });
        const r = renameSegmentFile(SMS_SEGMENTS, from, to);
        if (r.error) return send(res, 400, r);
        return send(res, 200, { ok: true, name: to, rescheduled: repointScheduled("sms", from, to) });
      }
      if (p === "/api/sms/preview" && req.method === "POST") {
        const b = await readBody(req);
        const r = resolveSmsAudience(b.segments || [], b.pasted || "");
        return send(res, 200, { recipients: r.recipients.length, invalid: r.invalid, dupes: r.dupes, sample: r.recipients.slice(0, 5).map((x) => x.phone) });
      }
      if (p === "/api/sms/send" && req.method === "POST") {
        const r = launchSms(await readBody(req));
        return send(res, r.error ? 400 : 200, r);
      }

      // ----- scheduling -----
      if (p === "/api/schedule" && req.method === "POST") {
        const b = await readBody(req);
        const at = Number(b.at);
        if (!at || isNaN(at)) return send(res, 400, { error: "Pick a valid date & time." });
        if (at < Date.now() - 60000) return send(res, 400, { error: "That time is in the past." });
        const channel = b.channel === "sms" ? "sms" : "email";
        const payload = b.payload || {};
        // light validation (recipients are re-resolved at fire time)
        if (channel === "email") { if (!payload.subject) return send(res, 400, { error: "Subject is required." }); if (!payload.html) return send(res, 400, { error: "Email body is required." }); if (!(payload.segments || []).length) return send(res, 400, { error: "Pick an audience." }); }
        else { if (!payload.body && !((payload.mediaUrls || []).length)) return send(res, 400, { error: "Add a message or MMS image." }); if (!(payload.segments || []).length && !(payload.pasted || "").trim()) return send(res, 400, { error: "Pick a list or paste numbers." }); }
        const id = "sched_" + new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17) + "_" + Math.random().toString(36).slice(2, 7);
        const label = channel === "email" ? (payload.subject || "(email)") : ((payload.body || "(MMS)").slice(0, 60));
        saveScheduled({ id, channel, at, status: "scheduled", label, audience: payload.segments || [], payload, createdAt: new Date().toISOString() });
        return send(res, 200, { ok: true, id, at });
      }
      if (p === "/api/scheduled" && req.method === "GET") {
        return send(res, 200, { scheduled: listScheduled() });
      }
      if (p.startsWith("/api/scheduled/") && req.method === "DELETE") {
        const id = decodeURIComponent(p.split("/").pop());
        const f = path.join(SCHEDULED, id + ".json");
        try { const s = JSON.parse(fs.readFileSync(f, "utf8")); if (s.status === "scheduled") { fs.unlinkSync(f); return send(res, 200, { ok: true }); } return send(res, 200, { ok: false, error: "Already " + s.status }); }
        catch { return send(res, 404, { error: "not found" }); }
      }

      // ----- drafts (save a composition to finish/send later) -----
      if (p === "/api/drafts" && req.method === "POST") {
        const b = await readBody(req);
        const channel = b.channel === "sms" ? "sms" : "email";
        const now = new Date().toISOString();
        const id = b.id || ("draft_" + now.replace(/[^0-9]/g, "").slice(0, 17) + "_" + Math.random().toString(36).slice(2, 7));
        const label = (b.label || (channel === "email" ? (b.payload && b.payload.subject) : (b.payload && (b.payload.body || "").slice(0, 60))) || "(untitled)").trim() || "(untitled)";
        const existing = listDrafts().find((d) => d.id === id);
        saveDraft({ id, channel, label, payload: b.payload || {}, createdAt: (existing && existing.createdAt) || now, updatedAt: now });
        return send(res, 200, { ok: true, id });
      }
      if (p === "/api/drafts" && req.method === "GET") {
        // summaries only (no big payloads)
        return send(res, 200, { drafts: listDrafts().map((d) => ({ id: d.id, channel: d.channel, label: d.label, updatedAt: d.updatedAt })) });
      }
      if (p.startsWith("/api/drafts/") && req.method === "GET") {
        const id = decodeURIComponent(p.split("/").pop());
        const d = listDrafts().find((x) => x.id === id);
        return d ? send(res, 200, d) : send(res, 404, { error: "not found" });
      }
      if (p.startsWith("/api/drafts/") && req.method === "DELETE") {
        const id = decodeURIComponent(p.split("/").pop()).split("#")[0]; // strip sub-draft index
        const f = path.join(DRAFTS, id + ".json");
        if (fs.existsSync(f)) {
          try { const raw = JSON.parse(fs.readFileSync(f, "utf8")); if (raw.htmlFile) { try { fs.unlinkSync(path.join(DRAFTS, raw.htmlFile)); } catch {} } } catch {}
          fs.unlinkSync(f);
        }
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { error: "Unknown endpoint" });
    }

    // ----- static -----
    let file = p === "/" ? "/index.html" : p;
    const fp = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      return send(res, 200, fs.readFileSync(fp), MIME[path.extname(fp)] || "application/octet-stream");
    }
    return send(res, 404, "Not found", "text/plain");
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

// Ensure all data subdirs exist (a fresh disk — e.g. a new cloud volume —
// starts empty, and some write paths don't mkdir on their own).
for (const d of [DATA, SEGMENTS, SMS_SEGMENTS, RECIPIENTS, JOBS_DIR, DRAFTS, SCHEDULED]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
}

server.listen(PORT, () => {
  console.log(`\n  Crate Hackers Email Console`);
  console.log(`  → http://localhost:${PORT}\n`);
  if (auth.enabled) {
    console.log(`  🔒 Google sign-in ON — only @${auth.allowedDomain} accounts may enter.`);
    console.log(`     Google OAuth redirect URI: ${auth.redirectUriHint()}\n`);
  } else {
    console.log("  🔓 Google sign-in OFF (local mode). Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / SESSION_SECRET to enable it.\n");
  }
  const cfg = loadConfig();
  if (!cfg.postmarkToken) console.log("  ⚠  No Postmark token yet — add it in Settings before sending.\n");
});
