#!/usr/bin/env node
// Build/refresh an email + SMS audience from one or more CSVs, auto-detecting each file's type
// (Zoom registration report, Zoom participants report, or Kartra contacts export).
// Usage (run from webapp/):  node scripts/update_lists.js <segmentName> <file1.csv> [file2.csv ...]
const fs = require("fs"), path = require("path");
const NAME = process.argv[2];
const FILES = process.argv.slice(3);
const WEBDATA = path.join(__dirname, "..", "data");
const MAP = path.join(WEBDATA, "phone-email-map.json");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function parseCSV(content, delim) {
  delim = delim || ",";
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < content.length; i++) { const c = content[i];
    if (q) { if (c === '"' && content[i+1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && content[i+1] === "\n") i++; row.push(f); f=""; if (row.length>1||row[0]!=="") rows.push(row); row=[]; }
    else f += c; }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
// Read a CSV/TSV handling UTF-8, UTF-16 (Meta Lead Ads), and tab-vs-comma delimiters.
function readTable(file) {
  const buf = fs.readFileSync(file);
  let content;
  if (buf[0] === 0xFF && buf[1] === 0xFE) content = buf.toString("utf16le");
  else if (buf[0] === 0xFE && buf[1] === 0xFF) content = Buffer.from(buf).swap16().toString("utf16le");
  else content = buf.toString("utf8");
  content = content.replace(/^﻿/, "");
  const first = content.split(/\r?\n/)[0] || "";
  const delim = first.split("\t").length > first.split(",").length ? "\t" : ",";
  return parseCSV(content, delim);
}
function e164(phone, cc) { let d=(phone||"").replace(/\D/g,""); if(d.length<7) return null; let c=(cc||"").replace(/\D/g,"")||"1"; if((phone||"").trim().startsWith("+")&&d.length>=11&&d.length<=15) return "+"+d; if(d.length===10) return "+"+c+d; if(d.length===11&&d[0]==="1") return "+"+d; if(d.length>=11&&d.length<=15) return "+"+d; return null; }
const fn = (s) => (s || "").trim().split(/\s+/)[0] || "";

const BOT_DOMAINS = /@(fireflies\.ai|otter\.ai|read\.ai|fathom\.video|tldv\.io|avoma\.com|fellow\.app|notetaker)/i;
const people = new Map();
function add(email, name, phone) {
  email = (email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return;
  if (BOT_DOMAINS.test(email)) return; // skip AI notetaker bots that join Zoom
  const cur = people.get(email) || { name: "", phone: "" };
  if (!cur.name && name) cur.name = fn(name);
  if (!cur.phone && phone) cur.phone = phone;
  people.set(email, cur);
}

for (const file of FILES) {
  if (!fs.existsSync(file)) { console.log("  ! missing:", file); continue; }
  const rows = readTable(file);
  const hi = rows.findIndex((r) => r.some((c) => c.toLowerCase().trim() === "email"));
  if (hi < 0) { console.log("  ! no email column:", path.basename(file)); continue; }
  const h = rows[hi].map((c) => c.toLowerCase().trim());
  const ei = h.indexOf("email");
  let ni = h.findIndex((c) => c === "first name" || c === "first_name");
  if (ni < 0) ni = h.findIndex((c) => c.includes("name"));   // "name (original name)" / "name"
  let pi = h.indexOf("phone");
  if (pi < 0) pi = h.indexOf("phone_number");                // Meta Lead Ads
  const cci = h.indexOf("phone_country_code");
  let added = 0;
  for (const r of rows.slice(hi + 1)) {
    if (!r[ei]) continue;
    const ph = pi >= 0 ? (e164(r[pi], cci >= 0 ? r[cci] : "") || "") : "";
    add(r[ei], ni >= 0 ? r[ni] : "", ph); added++;
  }
  const type = pi >= 0 ? "Kartra contacts" : (h.includes("approval status") ? "Zoom registration" : "Zoom participants/other");
  console.log(`  ${path.basename(file)} → ${type}: ${added} rows`);
}

// fill missing phones from the phone→email map (inverted)
try { const p2e = JSON.parse(fs.readFileSync(MAP, "utf8")); const e2p = {}; for (const [ph, em] of Object.entries(p2e)) if (!e2p[em]) e2p[em] = ph; for (const [email, v] of people) if (!v.phone && e2p[email]) v.phone = e2p[email]; } catch {}

const emailLines = ["email,first_name"];
for (const [email, v] of people) emailLines.push(`${email},${(v.name || "").replace(/[",\n]/g, "")}`);
fs.writeFileSync(path.join(WEBDATA, "segments", NAME + ".csv"), emailLines.join("\n"));
const seen = new Set(); const smsLines = ["phone,first_name"]; let withPhone = 0;
for (const [, v] of people) { if (!v.phone || seen.has(v.phone)) continue; seen.add(v.phone); withPhone++; smsLines.push(`${v.phone},${(v.name || "").replace(/[",\n]/g, "")}`); }
fs.writeFileSync(path.join(WEBDATA, "sms-segments", NAME + ".csv"), smsLines.join("\n"));
console.log(`\n  EMAIL "${NAME}": ${people.size}  |  SMS "${NAME}": ${withPhone} with phone`);
