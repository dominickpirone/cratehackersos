#!/usr/bin/env node
// Rebuild lock-in-registrants email + SMS audiences from a Zoom registration report + Kartra contacts export.
// Usage: node scripts/build_registrants.js <zoom.csv> <kartra-contacts.csv> [segmentName]
// Run from the webapp/ dir. Writes data/segments/<name>.csv and data/sms-segments/<name>.csv
const fs = require("fs"), path = require("path");
const ZOOM = process.argv[2], KARTRA = process.argv[3];
const NAME = process.argv[4] || "lock-in-registrants";
const WEBDATA = path.join(__dirname, "..", "data");
const MAP = path.join(WEBDATA, "phone-email-map.json");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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
function e164(phone, cc) { let d=(phone||"").replace(/\D/g,""); if(d.length<7) return null; let c=(cc||"").replace(/\D/g,"")||"1"; if((phone||"").trim().startsWith("+")&&d.length>=11&&d.length<=15) return "+"+d; if(d.length===10) return "+"+c+d; if(d.length===11&&d[0]==="1") return "+"+d; if(d.length>=11&&d.length<=15) return "+"+d; return null; }
const fn = (s) => (s || "").trim().split(/\s+/)[0] || "";

const people = new Map();
function add(email, name, phone) {
  email = (email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return;
  const cur = people.get(email) || { name: "", phone: "" };
  if (!cur.name && name) cur.name = fn(name);
  if (!cur.phone && phone) cur.phone = phone;
  people.set(email, cur);
}

if (ZOOM && fs.existsSync(ZOOM)) {
  const zrows = parseCSV(fs.readFileSync(ZOOM, "utf8").replace(/^﻿/, ""));
  const zi = zrows.findIndex((r) => r.map((x) => x.toLowerCase().trim()).includes("email") && r.map((x) => x.toLowerCase().trim()).join().includes("first name"));
  if (zi >= 0) { const h = zrows[zi].map((x) => x.toLowerCase().trim()); const ei = h.indexOf("email"), ni = h.indexOf("first name");
    for (const r of zrows.slice(zi + 1)) { if (r[ei]) add(r[ei], r[ni], ""); } }
}
if (KARTRA && fs.existsSync(KARTRA)) {
  const krows = parseCSV(fs.readFileSync(KARTRA, "utf8").replace(/^﻿/, ""));
  const kh = krows[0].map((x) => x.toLowerCase().trim());
  const kE = kh.indexOf("email"), kN = kh.indexOf("first_name"), kP = kh.indexOf("phone"), kCC = kh.indexOf("phone_country_code");
  for (const r of krows.slice(1)) { if (r[kE]) add(r[kE], r[kN], e164(r[kP], r[kCC]) || ""); }
}
// fill missing phones from phone→email map (inverted)
try { const p2e = JSON.parse(fs.readFileSync(MAP, "utf8")); const e2p = {}; for (const [ph, em] of Object.entries(p2e)) if (!e2p[em]) e2p[em] = ph; for (const [email, v] of people) if (!v.phone && e2p[email]) v.phone = e2p[email]; } catch {}

const emailLines = ["email,first_name"];
for (const [email, v] of people) emailLines.push(`${email},${(v.name || "").replace(/[",\n]/g, "")}`);
fs.writeFileSync(path.join(WEBDATA, "segments", NAME + ".csv"), emailLines.join("\n"));
const seen = new Set(); const smsLines = ["phone,first_name"]; let withPhone = 0;
for (const [, v] of people) { if (!v.phone || seen.has(v.phone)) continue; seen.add(v.phone); withPhone++; smsLines.push(`${v.phone},${(v.name || "").replace(/[",\n]/g, "")}`); }
fs.writeFileSync(path.join(WEBDATA, "sms-segments", NAME + ".csv"), smsLines.join("\n"));
console.log(`Email "${NAME}": ${people.size} | SMS "${NAME}": ${withPhone} with phone`);
