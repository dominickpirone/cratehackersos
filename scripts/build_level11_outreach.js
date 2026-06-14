#!/usr/bin/env node
// Build the three Level 11 outreach audiences (email + SMS segments) from the latest
// Zoom registration/participants reports and the founding-members (buyers) report:
//   level11-founding-members      bought Level 11 → thank-you outreach
//   lock-in-attended-not-bought   attended any challenge day but didn't buy → survey outreach
//   lock-in-registered-no-show    registered but never attended → follow-up outreach
// Phones are enriched from Kartra contact exports + the inverted phone-email-map.
// Usage (from webapp/):  node scripts/build_level11_outreach.js
const fs = require("fs"), path = require("path");
const WEBDATA = path.join(__dirname, "..", "data");
const MAP = path.join(WEBDATA, "phone-email-map.json");
const BASE = path.join(__dirname, "..", "..", ".."); // Crate Hackers folder
const LOCKIN = path.join(BASE, "LOCK-IN CHALLENGE (How to 10X Your Bookings with Claude Cowork & Claude Opus 4.8 and Claude AI");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const BOT_DOMAINS = /@(fireflies\.ai|otter\.ai|read\.ai|fathom\.video|tldv\.io|avoma\.com|fellow\.app|notetaker)/i;

const FILES = {
  registration: path.join(LOCKIN, "registration_86244463406_2026_06_11.csv"),
  participants: [
    path.join(LOCKIN, "282 day 1 participants_86244463406_2026_06_09 (1).csv"),
    path.join(LOCKIN, "189 day 2 participants_86244463406_2026_06_10.csv"),
    path.join(LOCKIN, "day 3 participants_86244463406_2026_06_11.csv"),
  ],
  buyers: path.join(BASE, "LEVEL11", "level 11 founding members report_11-06-2026_6a2b3d5d42805.csv"),
  kartra: [
    path.join(__dirname, "..", "..", "contacts_kartra_09-06-2026_6a2803f884d5c.csv"),
    path.join(__dirname, "..", "..", "contacts_kartra_08-06-2026_6a277407a4499.csv"),
  ],
};

function parseCSV(content) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < content.length; i++) { const c = content[i];
    if (q) { if (c === '"' && content[i+1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && content[i+1] === "\n") i++; row.push(f); f=""; if (row.length>1||row[0]!=="") rows.push(row); row=[]; }
    else f += c; }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
function readTable(file) {
  const content = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  return parseCSV(content);
}
function e164(phone, cc) { let d=(phone||"").replace(/\D/g,""); if(d.length<7) return null; let c=(cc||"").replace(/\D/g,"")||"1"; if((phone||"").trim().startsWith("+")&&d.length>=11&&d.length<=15) return "+"+d; if(d.length===10) return "+"+c+d; if(d.length===11&&d[0]==="1") return "+"+d; if(d.length>=11&&d.length<=15) return "+"+d; return null; }
const fn = (s) => (s || "").trim().split(/\s+/)[0] || "";
const norm = (e) => (e || "").trim().toLowerCase();

// Collect {email → first name} from a Zoom-style table (header row contains "email").
function collectPeople(file) {
  const out = new Map();
  if (!fs.existsSync(file)) { console.log("  ! missing:", file); return out; }
  const rows = readTable(file);
  const hi = rows.findIndex((r) => r.some((c) => norm(c) === "email"));
  if (hi < 0) { console.log("  ! no email column:", path.basename(file)); return out; }
  const h = rows[hi].map((c) => norm(c));
  const ei = h.indexOf("email");
  let ni = h.findIndex((c) => c === "first name" || c === "first_name");
  if (ni < 0) ni = h.findIndex((c) => c.includes("name"));
  for (const r of rows.slice(hi + 1)) {
    const email = norm(r[ei]);
    if (!EMAIL_RE.test(email) || BOT_DOMAINS.test(email)) continue;
    if (!out.has(email)) out.set(email, fn(ni >= 0 ? r[ni] : ""));
  }
  return out;
}

// Phone lookup: Kartra exports + inverted phone-email-map
const emailToPhone = {};
for (const file of FILES.kartra) {
  if (!fs.existsSync(file)) { console.log("  ! missing kartra export:", path.basename(file)); continue; }
  const rows = readTable(file);
  const h = rows[0].map((c) => norm(c));
  const ei = h.indexOf("email"), pi = h.indexOf("phone"), cci = h.indexOf("phone_country_code");
  for (const r of rows.slice(1)) {
    const email = norm(r[ei]);
    const ph = e164(r[pi], cci >= 0 ? r[cci] : "");
    if (email && ph && !emailToPhone[email]) emailToPhone[email] = ph;
  }
}
try {
  const p2e = JSON.parse(fs.readFileSync(MAP, "utf8"));
  for (const [ph, em] of Object.entries(p2e)) if (!emailToPhone[norm(em)]) emailToPhone[norm(em)] = ph;
} catch {}

const registrants = collectPeople(FILES.registration);
const attendees = new Map();
for (const f of FILES.participants) for (const [e, n] of collectPeople(f)) if (!attendees.has(e)) attendees.set(e, n);
const buyers = collectPeople(FILES.buyers);

const segs = {
  "level11-founding-members": buyers,
  "lock-in-attended-not-bought": new Map([...attendees].filter(([e]) => !buyers.has(e))),
  "lock-in-registered-no-show": new Map([...registrants].filter(([e]) => !attendees.has(e) && !buyers.has(e))),
};

console.log(`\n  registrants: ${registrants.size} · attendees (any day): ${attendees.size} · buyers: ${buyers.size}\n`);
for (const [name, people] of Object.entries(segs)) {
  const emailLines = ["email,first_name"];
  const smsLines = ["phone,first_name"];
  const seen = new Set(); let withPhone = 0;
  for (const [email, first] of people) {
    emailLines.push(`${email},${(first || "").replace(/[",\n]/g, "")}`);
    const ph = emailToPhone[email];
    if (ph && !seen.has(ph)) { seen.add(ph); withPhone++; smsLines.push(`${ph},${(first || "").replace(/[",\n]/g, "")}`); }
  }
  fs.writeFileSync(path.join(WEBDATA, "segments", name + ".csv"), emailLines.join("\n"));
  fs.writeFileSync(path.join(WEBDATA, "sms-segments", name + ".csv"), smsLines.join("\n"));
  console.log(`  ${name}: ${people.size} emails · ${withPhone} with phone`);
}
