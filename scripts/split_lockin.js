#!/usr/bin/env node
// Split lock-in registrants into active-members vs prospects (email + SMS), from source files.
// Usage (from webapp/): node scripts/split_lockin.js <registrant source csvs...>
const fs = require("fs"), path = require("path");
const FILES = process.argv.slice(2);
const WEBDATA = path.join(__dirname, "..", "data");
const SEG = path.join(WEBDATA, "segments"), SMS = path.join(WEBDATA, "sms-segments");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const BOT_DOMAINS = /@(fireflies\.ai|otter\.ai|read\.ai|fathom\.video|tldv\.io|avoma\.com|fellow\.app|notetaker)/i;

function parseCSV(content, delim) {
  delim = delim || ","; const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < content.length; i++) { const c = content[i];
    if (q) { if (c === '"' && content[i+1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && content[i+1] === "\n") i++; row.push(f); f=""; if (row.length>1||row[0]!=="") rows.push(row); row=[]; }
    else f += c; }
  if (f || row.length) { row.push(f); rows.push(row); } return rows;
}
function readTable(file) {
  const buf = fs.readFileSync(file); let content;
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

// build registrant records: email -> {name, phone}
const people = new Map();
function add(email, name, phone) {
  email = (email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || BOT_DOMAINS.test(email)) return;
  const cur = people.get(email) || { name: "", phone: "" };
  if (!cur.name && name) cur.name = fn(name);
  if (!cur.phone && phone) cur.phone = phone;
  people.set(email, cur);
}
for (const file of FILES) {
  if (!fs.existsSync(file)) { console.log("  ! missing:", path.basename(file)); continue; }
  const rows = readTable(file);
  const hi = rows.findIndex((r) => r.some((c) => c.toLowerCase().trim() === "email"));
  if (hi < 0) continue;
  const h = rows[hi].map((c) => c.toLowerCase().trim());
  const ei = h.indexOf("email");
  let ni = h.findIndex((c) => c === "first name" || c === "first_name"); if (ni < 0) ni = h.findIndex((c) => c.includes("name"));
  let pi = h.indexOf("phone"); if (pi < 0) pi = h.indexOf("phone_number");
  const cci = h.indexOf("phone_country_code");
  for (const r of rows.slice(hi + 1)) { if (!r[ei]) continue; const ph = pi >= 0 ? (e164(r[pi], cci >= 0 ? r[cci] : "") || "") : ""; add(r[ei], ni >= 0 ? r[ni] : "", ph); }
}
// fill missing phones from inverted phone→email map
try { const p2e = JSON.parse(fs.readFileSync(path.join(WEBDATA, "phone-email-map.json"), "utf8")); const e2p = {}; for (const [ph, em] of Object.entries(p2e)) if (!e2p[em]) e2p[em] = ph; for (const [email, v] of people) if (!v.phone && e2p[email]) v.phone = e2p[email]; } catch {}

// active member email sets
function emailsOf(seg) { const s = new Set(); try { fs.readFileSync(path.join(SEG, seg + ".csv"), "utf8").split(/\r?\n/).slice(1).forEach((l) => { const e = l.split(",")[0].trim().toLowerCase(); if (e.includes("@")) s.add(e); }); } catch {} return s; }
const active = new Set([...emailsOf("crate-hackers-active"), ...emailsOf("banger-button-active")]);

function write(name, recs) {
  fs.writeFileSync(path.join(SEG, name + ".csv"), ["email,first_name", ...recs.map(([e, v]) => `${e},${(v.name||"").replace(/[",\n]/g,"")}`)].join("\n"));
  const seen = new Set(); const sms = ["phone,first_name"]; let withPhone = 0;
  for (const [, v] of recs) { if (!v.phone || seen.has(v.phone)) continue; seen.add(v.phone); withPhone++; sms.push(`${v.phone},${(v.name||"").replace(/[",\n]/g,"")}`); }
  fs.writeFileSync(path.join(SMS, name + ".csv"), sms.join("\n"));
  return withPhone;
}
const members = [...people].filter(([e]) => active.has(e));
const prospects = [...people].filter(([e]) => !active.has(e));
const mP = write("lock-in-active-members", members);
const pP = write("lock-in-prospects", prospects);
console.log(`Registrants: ${people.size}`);
console.log(`  lock-in-active-members: ${members.length} email / ${mP} sms`);
console.log(`  lock-in-prospects:      ${prospects.length} email / ${pP} sms`);
