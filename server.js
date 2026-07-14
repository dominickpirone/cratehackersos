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
    testEmail: cfg.testEmail || process.env.TEST_EMAIL || "dom@cratehackers.com",
    testPhone: cfg.testPhone || process.env.TEST_PHONE || "",
    groqApiKey: cfg.groqApiKey || process.env.GROQ_API_KEY || "",
    adIngestToken: cfg.adIngestToken || process.env.AD_INGEST_TOKEN || "",
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

function resolveAudience(segmentNames) {
  // Union of selected segments, minus suppression, deduped.
  const suppress = loadSuppression();
  const seen = new Set();
  const recipients = [];
  let invalid = 0, dupes = 0, suppressed = 0;
  for (const seg of segmentNames) {
    const file = path.join(SEGMENTS, seg + ".csv");
    if (!fs.existsSync(file)) continue;
    const res = extractRecipients(fs.readFileSync(file, "utf8"));
    invalid += res.invalid;
    for (const r of res.recipients) {
      if (suppress.has(r.email)) { suppressed++; continue; }
      if (seen.has(r.email)) { dupes++; continue; }
      seen.add(r.email);
      recipients.push(r);
    }
  }
  return { recipients, invalid, dupes, suppressed };
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
const FUNNEL_PRICES = { monthly: 99, annual: 891, lifetime: 1500 };
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
  const metrics = (s) => ({
    ...s,
    convRate: s.view ? s.conv / s.view : 0,       // visitor → buyer
    ctaRate: s.view ? s.cta / s.view : 0,         // visitor → checkout click
    aov: s.conv ? s.revenue / s.conv : 0,         // average order value
    epc: s.view ? s.revenue / s.view : 0,         // earnings per click/visitor
  });
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
function level11LedgerSales(rows, from, to) {
  const inRange = (d) => (!from || d >= from) && (!to || d <= to);
  const out = { conv: 0, revenue: 0, tiers: { monthly: 0, annual: 0, lifetime: 0 } };
  for (const r of rows) {
    if (r.type !== "sale" || !/level\s*-?\s*11/i.test(r.product)) continue;
    if (!inRange(r.date)) continue;
    if (!(r.amount > 0)) continue;               // skip $0 comps / test rows
    out.conv++; out.revenue += r.amount;
    const tier = r.amount >= 1200 ? "lifetime" : r.amount >= 500 ? "annual" : "monthly";
    out.tiers[tier]++;
  }
  out.revenue = Math.round(out.revenue * 100) / 100;
  return out;
}
// Fold real ledger conversions into a pixel-built funnel. Totals are exact. Per-variant
// conversions/revenue are *modeled* by each variant's checkout-click share (the variant
// the buyer saw isn't captured at the off-site Kartra checkout) -- flagged `estimated`.
function mergeLedgerConversions(funnel, sales) {
  const t = funnel.totals;
  t.conv = sales.conv; t.revenue = sales.revenue; t.tiers = sales.tiers;
  t.convRate = t.view ? t.conv / t.view : 0;
  t.aov = t.conv ? t.revenue / t.conv : 0;
  t.epc = t.view ? t.revenue / t.view : 0;
  const vs = funnel.variants || [];
  const totalCta = vs.reduce((a, v) => a + (v.cta || 0), 0);
  const totalView = vs.reduce((a, v) => a + (v.view || 0), 0);
  const basis = totalCta > 0 ? "cta" : "view";
  const denom = totalCta > 0 ? totalCta : totalView;
  let convLeft = sales.conv, revLeft = sales.revenue;
  vs.forEach((v, i) => {
    const last = i === vs.length - 1;
    const share = denom > 0 ? (v[basis] || 0) / denom : 0;
    v.conv = last ? convLeft : Math.round(sales.conv * share);
    v.revenue = last ? Math.round(revLeft * 100) / 100 : Math.round(sales.revenue * share * 100) / 100;
    convLeft -= v.conv; revLeft -= v.revenue;
    v.convRate = v.view ? v.conv / v.view : 0;
    v.aov = v.conv ? v.revenue / v.conv : 0;
    v.epc = v.view ? v.revenue / v.view : 0;
    v.estimated = true;
  });
  funnel.conversionSource = "ledger";
  funnel.variantConvEstimated = true;
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
  const targets = isTest ? [{ email: (b.testEmail || cfg.testEmail), name: "Dominick" }] : resolveAudience(segments).recipients;
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
        return send(res, 200, { email: user.email, name: user.name, authEnabled: auth.enabled });
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
        if (fn === "level11") {
          try {
            const cfg = loadConfig();
            if (cfg.salesLedgerCsvUrl) {
              const rows = await fetchLedger(cfg.salesLedgerCsvUrl);
              mergeLedgerConversions(result, level11LedgerSales(rows, from, to));
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
          hasMailgun: !!(c.mailgunApiKey && c.mailgunDomain),
          mailgunDomain: c.mailgunDomain, mailgunRegion: c.mailgunRegion,
          mailgunFromEmail: c.mailgunFromEmail, mailgunFromName: c.mailgunFromName,
          mailgunClickTracking: c.mailgunClickTracking,
          salesLedgerCsvUrl: c.salesLedgerCsvUrl,
          hasTwilio: !!(c.twilioAccountSid && c.twilioAuthToken),
          twilioFromNumbers: fromNumbersList(c), twilioMessagingServiceSid: c.twilioMessagingServiceSid,
          twilioAccountSid: c.twilioAccountSid ? c.twilioAccountSid.slice(0, 6) + "…" + c.twilioAccountSid.slice(-4) : "",
          hasQuo: !!c.quoApiKey, quoFromNumber: c.quoFromNumber,
          testPhone: c.testPhone,
        });
      }
      if (p === "/api/settings" && req.method === "POST") {
        const b = await readBody(req);
        const patch = {};
        for (const k of ["fromEmail", "fromName", "stream", "replyTo", "testEmail", "paypalEnv",
          "mailgunDomain", "mailgunRegion", "mailgunFromEmail", "mailgunFromName", "salesLedgerCsvUrl", "groqApiKey", "adIngestToken",
          "twilioFromNumbers", "twilioMessagingServiceSid", "testPhone", "quoFromNumber"]) if (k in b) patch[k] = b[k];
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
        const r = resolveAudience(b.segments || []);
        const size = b.provider === "mailgun" ? 1000 : BATCH_SIZE;
        return send(res, 200, {
          recipients: r.recipients.length, invalid: r.invalid,
          dupes: r.dupes, suppressed: r.suppressed,
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
