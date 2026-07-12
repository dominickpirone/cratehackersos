// ---------- tiny helpers ----------
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const api = async (url, opts) => {
  let r;
  try { r = await fetch(url, opts); }
  catch (e) { return { error: "Network error — check your connection and try again." }; }
  const text = await r.text().catch(() => "");
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (data == null) return { error: r.ok ? "Unexpected server response." : `Server error (${r.status})` + (text ? ": " + text.slice(0, 140) : ".") };
  if (!r.ok && !data.error) data.error = `Request failed (${r.status}).`;
  return data;
};
const post = (url, body) => api(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const fmt = (n) => (n == null ? "—" : n.toLocaleString());
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + "%" : "—");
// remember the active send so progress reattaches if the page is reloaded
const rememberJob = (id, total, kind) => { try { localStorage.setItem("ch_activeJob", JSON.stringify({ id, total, kind })); } catch {} };
const clearJob = () => { try { localStorage.removeItem("ch_activeJob"); } catch {} };

let TOAST_T;
function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast " + kind;
  clearTimeout(TOAST_T);
  TOAST_T = setTimeout(() => t.classList.add("hidden"), 4000);
}

// ---------- tabs ----------
$$(".tab").forEach((btn) => {
  btn.onclick = () => {
    $$(".tab").forEach((b) => b.classList.remove("active"));
    $$(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $("#" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "audiences") loadSegments();
    if (btn.dataset.tab === "sms") loadSms();
    if (btn.dataset.tab === "outreach") loadOutreach();
    if (btn.dataset.tab === "analytics") loadAnalytics();
    if (btn.dataset.tab === "funnel") loadFunnel();
    if (btn.dataset.tab === "dashboards") loadDashboardsDefault();
    if (btn.dataset.tab === "failed-payments") loadFailedPayments();
    if (btn.dataset.tab === "ad-library") { loadAds(); loadInfluencers(); }
    if (btn.dataset.tab === "settings") loadSettings();
    if (btn.dataset.tab === "compose") loadAudienceOptions(); // keep the audience list fresh (e.g. after an upload)
    if (btn.dataset.tab === "compose" || btn.dataset.tab === "sms") { loadUpcoming(); loadDrafts(); }
  };
});

// deep-link: opening /#funnel, /#failed-payments, etc. jumps straight to that tab
function openTabFromHash() {
  const name = decodeURIComponent(location.hash.slice(1));
  if (!name) return;
  const btn = $$(".tab").find((b) => b.dataset.tab === name);
  if (btn) btn.onclick();
}
window.addEventListener("hashchange", openTabFromHash);
openTabFromHash();

// ---------- dashboards ----------
const DASHBOARDS = {
  "exec-summary": { title: "Executive Summary", url: "/dashboards/exec-summary.html" },
  "weekly-health": { title: "Weekly Health", url: "/dashboards/weekly-health.html" },
  "ltv-intelligence": { title: "LTV Intelligence", url: "/dashboards/ltv-intelligence.html" },
};
function openDash(key) {
  const d = DASHBOARDS[key];
  if (!d || !$("#dashFrame")) return;
  $$(".dash-card").forEach((c) => c.classList.toggle("active", c.dataset.dash === key));
  $("#dashViewer").classList.remove("hidden");
  if ($("#dashFrame").getAttribute("src") !== d.url) $("#dashFrame").src = d.url;
  $("#dashTitle").textContent = d.title + " — live view";
  $("#dashPop").href = d.url;
  $("#dashViewer").scrollIntoView({ behavior: "smooth", block: "start" });
}
$$(".dash-card").forEach((c) => (c.onclick = () => openDash(c.dataset.dash)));
// first open of the tab shows the executive summary by default
function loadDashboardsDefault() {
  if ($("#dashFrame") && !$("#dashFrame").getAttribute("src")) openDash("exec-summary");
}

// ---------- connection badge ----------
async function refreshConn() {
  const s = await api("/api/settings");
  PROVIDER_STATE = s;
  const c = $("#conn");
  const connected = [];
  if (s.hasToken) connected.push("Postmark");
  if (s.hasMailgun) connected.push("Mailgun");
  if (connected.length) {
    c.className = "conn ok";
    c.innerHTML = `<span class="dot"></span>${connected.join(" + ")} connected · ${s.fromEmail}`;
  } else {
    c.className = "conn bad";
    c.innerHTML = `<span class="dot"></span>No sender configured — add Postmark or Mailgun in Settings`;
  }
  if (typeof updateProviderNote === "function") updateProviderNote();
  return s;
}

// ---------- compose ----------
async function loadAudienceOptions() {
  const sel = $("#audience");
  const hadOptions = sel.options.length > 0;
  const prev = new Set([...sel.selectedOptions].map((o) => o.value)); // keep the user's picks across refresh
  const { segments } = await api("/api/segments");
  sel.innerHTML = "";
  segments.forEach((s) => {
    const o = document.createElement("option");
    o.value = s.name;
    o.textContent = `${s.name} (${fmt(s.count)})`;
    if (prev.has(s.name)) o.selected = true;
    sel.appendChild(o);
  });
  // default to "members" only on the very first load — never override the user's selection on a refresh
  if (!hadOptions && !prev.size) { const m = sel.querySelector('[value="members"]'); if (m) m.selected = true; }
  filterAudienceOptions();
  return segments.length;
}
// filter the Compose audience list by the search box (hides non-matching options)
function filterAudienceOptions() {
  const q = (($("#audSearch") && $("#audSearch").value) || "").trim().toLowerCase();
  $$("#audience option").forEach((o) => { o.hidden = !!q && !o.textContent.toLowerCase().includes(q); });
}
if ($("#audSearch")) $("#audSearch").oninput = filterAudienceOptions;
const selectedSegments = () => [...$("#audience").selectedOptions].map((o) => o.value);
if ($("#audienceRefresh")) $("#audienceRefresh").onclick = async () => {
  const n = await loadAudienceOptions();
  toast(`Audiences refreshed — ${fmt(n)} list${n === 1 ? "" : "s"} available.`, "ok");
};

// Editor modes: HTML (raw) · Visual (WYSIWYG) · Preview (rendered, read-only)
function setComposeMode(mode) {
  // sync OUT of the visual editor before switching (visual edits are the source while active)
  if ($("#wysiwyg") && !$("#wysiwyg").classList.contains("hidden")) $("#html").value = $("#wysiwyg").innerHTML;
  const map = { html: "modeHtml", visual: "modeVisual", preview: "modePreview" };
  for (const [m, id] of Object.entries(map)) { const b = $("#" + id); if (b) b.classList.toggle("active", m === mode); }
  $("#html").classList.toggle("hidden", mode !== "html");
  $("#wysiwyg").classList.toggle("hidden", mode !== "visual");
  $("#wysiToolbar").classList.toggle("hidden", mode !== "visual");
  $("#previewFrame").classList.toggle("hidden", mode !== "preview");
  if (mode === "visual") $("#wysiwyg").innerHTML = $("#html").value || "";
  if (mode === "preview") {
    const html = ($("#html").value || "").replace(/\{\{first_name\}\}/g, "Dominick");
    $("#previewFrame").srcdoc = html || "<p style='font-family:sans-serif;color:#888;padding:20px'>Nothing to preview yet.</p>";
  }
}
$("#modeHtml").onclick = () => setComposeMode("html");
$("#modeVisual").onclick = () => setComposeMode("visual");
$("#modePreview").onclick = () => setComposeMode("preview");
// keep raw HTML in sync as the user types in the visual editor (so Send always uses current content)
if ($("#wysiwyg")) $("#wysiwyg").oninput = () => { $("#html").value = $("#wysiwyg").innerHTML; };
if ($("#wysiToolbar")) $("#wysiToolbar").onclick = (e) => {
  const btn = e.target.closest("button[data-cmd]"); if (!btn) return;
  e.preventDefault();
  const cmd = btn.dataset.cmd, val = btn.dataset.val;
  $("#wysiwyg").focus();
  if (cmd === "createLink") {
    const url = prompt("Link URL:", "https://"); if (!url) return;
    const sel = window.getSelection();
    if (sel && sel.toString()) document.execCommand("createLink", false, url);
    else document.execCommand("insertHTML", false, `<a href="${url}">${url}</a>`);
  } else if (cmd === "insertName") {
    document.execCommand("insertText", false, "{{first_name}}");
  } else if (cmd === "formatBlock") {
    document.execCommand("formatBlock", false, val);
  } else {
    document.execCommand(cmd, false, null);
  }
  $("#html").value = $("#wysiwyg").innerHTML;
};

const provider = () => ($("#provider") ? $("#provider").value : "postmark");

// Reflect the chosen service in the right rail + send button.
let PROVIDER_STATE = {};
function updateProviderNote() {
  const pv = provider();
  const note = $("#providerNote");
  if (note) {
    if (pv === "mailgun") {
      note.innerHTML = PROVIDER_STATE.hasMailgun
        ? `Mailgun · <b>${esc(PROVIDER_STATE.mailgunDomain || "")}</b> (${(PROVIDER_STATE.mailgunRegion || "us").toUpperCase()})`
        : `⚠ Mailgun not configured — add it in <b>Settings</b>.`;
    } else {
      note.innerHTML = PROVIDER_STATE.hasToken
        ? `Postmark · stream <b>${esc(PROVIDER_STATE.stream || "broadcast")}</b>`
        : `⚠ Postmark not configured — add it in <b>Settings</b>.`;
    }
  }
  const sb = $("#sendBtn");
  if (sb) sb.lastChild.textContent = pv === "mailgun" ? "Send via Mailgun →" : "Send to audience →";
  const db = $("#dripBox"); if (db) db.classList.toggle("hidden", pv !== "mailgun");
}
if ($("#provider")) $("#provider").onchange = updateProviderNote;

// ----- drip / warm-up controls (throttle sends to protect a new domain) -----
function dripBody() {
  if (!($("#dripOn") && $("#dripOn").checked)) return {};
  return { drip: { on: true, batchSize: parseInt($("#dripBatch").value, 10) || 50, everyMin: parseFloat($("#dripEvery").value) || 10 } };
}
function dripSummary() {
  const d = dripBody().drip;
  return d ? `\n\nDrip: ${d.batchSize} every ${d.everyMin} min (≈ ${Math.round(d.batchSize / d.everyMin * 60).toLocaleString()}/hr).` : "";
}
function updateDripRate() {
  const el = $("#dripRate"); if (!el) return;
  const b = parseInt($("#dripBatch") && $("#dripBatch").value, 10) || 0;
  const m = parseFloat($("#dripEvery") && $("#dripEvery").value) || 0;
  el.textContent = (b && m) ? `≈ ${Math.round(b / m * 60).toLocaleString()} emails/hour` : "";
}
if ($("#dripOn")) $("#dripOn").onchange = () => { const f = $("#dripFields"); if (f) f.classList.toggle("hidden", !$("#dripOn").checked); };
if ($("#dripBatch")) $("#dripBatch").oninput = updateDripRate;
if ($("#dripEvery")) $("#dripEvery").oninput = updateDripRate;
$$(".drip-preset").forEach((btn) => btn.onclick = () => {
  if ($("#dripOn")) { $("#dripOn").checked = true; const f = $("#dripFields"); if (f) f.classList.remove("hidden"); }
  if ($("#dripBatch")) $("#dripBatch").value = btn.dataset.b;
  if ($("#dripEvery")) $("#dripEvery").value = btn.dataset.m;
  updateDripRate();
});
updateDripRate();

$("#previewBtn").onclick = async () => {
  const segs = selectedSegments();
  if (!segs.length) return toast("Select at least one audience.", "err");
  $("#previewOut").innerHTML = "Calculating…";
  const r = await post("/api/preview", { segments: segs, provider: provider() });
  $("#previewOut").innerHTML = `
    <div><span class="big">${fmt(r.recipients)}</span> recipients</div>
    <div class="muted">${r.batches} batch(es) · ${fmt(r.suppressed)} suppressed · ${fmt(r.dupes)} duplicates removed · ${fmt(r.invalid)} invalid</div>`;
};

$("#testBtn").onclick = async () => {
  const subject = $("#subject").value.trim();
  const html = $("#html").value;
  const testEmail = $("#testEmail").value.trim();
  if (!subject || !html) return toast("Subject and body are required.", "err");
  if (!testEmail) return toast("Enter a test address.", "err");
  $("#testBtn").disabled = true;
  const r = await post("/api/send", { subject, html, text: $("#text").value, test: true, testEmail, provider: provider() });
  $("#testBtn").disabled = false;
  if (r.error) return toast(r.error, "err");
  toast(`Test sent to ${testEmail} via ${provider()} ✓`, "ok");
};

$("#sendBtn").onclick = async () => {
  const subject = $("#subject").value.trim();
  const html = $("#html").value;
  const segs = selectedSegments();
  const pv = provider();
  if (!subject || !html) return toast("Subject and body are required.", "err");
  if (!segs.length) return toast("Select at least one audience.", "err");

  const pre = await post("/api/preview", { segments: segs, provider: pv });
  if (!confirm(`Send "${subject}" to ${pre.recipients.toLocaleString()} recipients across [${segs.join(", ")}]\nvia ${pv.toUpperCase()}?${dripSummary()}\n\nThis sends real emails. Continue?`)) return;

  $("#sendBtn").disabled = true;
  const r = await post("/api/send", { subject, html, text: $("#text").value, segments: segs, provider: pv, ...dripBody() });
  if (r.error) { $("#sendBtn").disabled = false; return toast(r.error, "err"); }

  $("#sendProgress").classList.remove("hidden");
  rememberJob(r.jobId, r.total, "email");
  pollJob(r.jobId, r.total);
};

async function pollJob(jobId, total) {
  const t = setInterval(async () => {
    const j = await api("/api/send/status/" + jobId);
    if (j.error) { clearInterval(t); $("#sendBtn").disabled = false; return toast(j.error, "err"); }
    const pctDone = total ? Math.round((j.processed / total) * 100) : 0;
    $("#barFill").style.width = pctDone + "%";
    $("#progressText").textContent = `${fmt(j.processed)} / ${fmt(total)} processed · ${fmt(j.sent)} sent · ${fmt(j.failed)} failed`;
    if (j.done) {
      clearInterval(t); clearJob();
      $("#sendBtn").disabled = false;
      if (j.error) toast("Send blocked: " + j.error, "err");
      else toast(`Done — ${fmt(j.sent)} sent, ${fmt(j.failed)} failed.`, j.failed ? "" : "ok");
    }
  }, 800);
}

// ---------- audiences ----------
let ALL_SEGMENTS = [];
async function loadSegments() {
  const { segments } = await api("/api/segments");
  ALL_SEGMENTS = segments || [];
  renderSegList();
  // load suppression
  const sup = await api("/api/suppression");
  if ($("#suppressBox")) $("#suppressBox").value = (sup.list || []).join("\n");
}
function renderSegList() {
  const list = $("#segList"); if (!list) return;
  const q = (($("#segSearch") && $("#segSearch").value) || "").trim().toLowerCase();
  const rows = ALL_SEGMENTS.filter((s) => !q || s.name.toLowerCase().includes(q));
  list.innerHTML = "";
  if (!rows.length) { list.innerHTML = `<p class="muted small" style="padding:8px 0">No audiences${q ? ` match “${esc(q)}”` : " yet"}.</p>`; }
  rows.forEach((s) => {
    const div = document.createElement("div");
    div.className = "seg-item";
    div.innerHTML = `<span class="name">${esc(s.name)}</span>
      <span><span class="count">${fmt(s.count)}</span> &nbsp;
      <button class="secondary" data-del="${esc(s.name)}">Delete</button></span>`;
    list.appendChild(div);
  });
  if ($("#segCount")) $("#segCount").textContent = q ? `${rows.length} of ${ALL_SEGMENTS.length}` : `${ALL_SEGMENTS.length} list${ALL_SEGMENTS.length === 1 ? "" : "s"}`;
  $$("[data-del]").forEach((b) => b.onclick = async () => {
    if (!confirm(`Delete audience "${b.dataset.del}"? This can't be undone.`)) return;
    const r = await api("/api/segments/" + encodeURIComponent(b.dataset.del), { method: "DELETE" });
    if (r && r.error) { toast(r.error, "err"); return; }
    ALL_SEGMENTS = ALL_SEGMENTS.filter((s) => s.name !== b.dataset.del);
    renderSegList();
    if (typeof loadAudienceOptions === "function") loadAudienceOptions(); // keep the Compose picker in sync
    toast("Audience deleted.", "ok");
  });
}
if ($("#segSearch")) $("#segSearch").oninput = renderSegList;

// read a File as text → Promise (lets us upload several files in sequence)
const readTextFile = (file) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(new Error("read failed"));
  r.readAsText(file);
});
// segment name from filename (server slugifies it) — used when bulk-uploading
const nameFromFile = (f) => f.name.replace(/\.[^.]+$/, "");

$("#segUpload").onclick = async () => {
  const files = [...$("#segFile").files];
  if (!files.length) return toast("Choose one or more CSV files.", "err");
  const typed = $("#segName").value.trim();
  let ok = 0, fail = 0, total = 0;
  for (const file of files) {
    const name = files.length === 1 && typed ? typed : nameFromFile(file);
    try {
      const r = await post("/api/segments", { name, csv: await readTextFile(file) });
      if (r.error) { fail++; toast(`${file.name}: ${r.error}`, "err"); }
      else { ok++; total += r.count || 0; }
    } catch { fail++; toast(`${file.name}: couldn't read file`, "err"); }
  }
  if (ok) toast(`${ok} segment${ok > 1 ? "s" : ""} saved — ${fmt(total)} recipients${fail ? `, ${fail} failed` : ""}.`, fail ? "err" : "ok");
  $("#segName").value = ""; $("#segFile").value = "";
  loadSegments(); loadAudienceOptions();
};

$("#suppressSave").onclick = async () => {
  const r = await post("/api/suppression", { replace: $("#suppressBox").value });
  toast(`Suppression list saved — ${fmt(r.count)} addresses.`, "ok");
};

// ---------- analytics ----------
async function loadAnalytics() {
  const from = $("#anFrom").value, to = $("#anTo").value;
  const prov = $("#anProvider") ? $("#anProvider").value : "postmark";
  const qs = new URLSearchParams({ from, to, provider: prov }).toString();
  const a = await api("/api/analytics?" + qs);
  if ($("#kpiProvider")) $("#kpiProvider").textContent = "— via " + (prov === "mailgun" ? "Mailgun" : "Postmark");

  const k = $("#kpis");
  if (a.overview) {
    const o = a.overview;
    if (prov === "mailgun") {
      k.innerHTML = `
        ${kpi(fmt(o.delivered), "Delivered")}
        ${kpi(pct(o.opens, o.delivered), "Open rate", true)}
        ${kpi(pct(o.clicks, o.delivered), "Click rate", true)}
        ${kpi(fmt(o.bounced), "Failed")}
        ${kpi(fmt(o.unsubscribed), "Unsubscribes")}
        ${kpi(fmt(o.spam), "Complaints")}`;
    } else {
      k.innerHTML = `
        ${kpi(fmt(o.sent), "Emails sent")}
        ${kpi(pct(o.uniqueOpens, o.sent), "Open rate", true)}
        ${kpi(pct(o.uniqueClicks, o.sent), "Click rate", true)}
        ${kpi(pct(o.uniqueClicks, o.uniqueOpens), "Click-to-open")}
        ${kpi(fmt(o.bounced), "Bounces")}
        ${kpi(fmt(o.spam), "Spam reports")}`;
    }
  } else if (prov === "mailgun" && !a.hasMailgun) {
    k.innerHTML = `<div class="kpi"><div class="v">—</div><div class="l">Add Mailgun in Settings to see its stats</div></div>`;
  } else if (prov === "postmark" && !a.hasToken) {
    k.innerHTML = `<div class="kpi"><div class="v">—</div><div class="l">Add a Postmark token in Settings to see live stats</div></div>`;
  } else {
    k.innerHTML = `<div class="kpi"><div class="v">⚠</div><div class="l">${esc(a.statsError || "No stats yet")}</div></div>`;
  }

  loadLedger(from, to);
  loadSmsStats(from, to);

  // campaign table
  const tb = $("#campTable tbody");
  tb.innerHTML = "";
  if (!a.campaigns.length) { $("#campEmpty").classList.remove("hidden"); $("#campTable").classList.add("hidden"); }
  else {
    $("#campEmpty").classList.add("hidden"); $("#campTable").classList.remove("hidden");
    a.campaigns.forEach((c) => {
      const isSms = c.channel === "sms";
      const label = isSms ? "sms" : (c.provider === "mailgun" ? "mailgun" : "postmark");
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${c.date.slice(0, 10)}</td>
        <td>${esc(c.subject)} <span class="muted" style="font-size:11px">· ${label}</span></td>
        <td class="muted">${(c.segments || []).join(", ")}</td>
        <td class="num">${fmt(c.recipients)}</td>
        <td class="num">${fmt(c.sent)}</td>
        <td class="num" data-opens>${isSms ? "—" : "…"}</td>
        <td class="num" data-clicks>${isSms ? "—" : "…"}</td>`;
      tb.appendChild(tr);
      // per-campaign opens/clicks (email only; SMS has no open/click tracking)
      if (!isSms) {
        const cprov = c.provider === "mailgun" ? "mailgun" : "postmark";
        api(`/api/analytics/campaign?provider=${cprov}&tag=` + encodeURIComponent(c.tag)).then((s) => {
          if (!s || s.error) { tr.querySelector("[data-opens]").textContent = "—"; tr.querySelector("[data-clicks]").textContent = "—"; return; }
          tr.querySelector("[data-opens]").innerHTML = `${fmt(s.uniqueOpens)} <span class="rate">${pct(s.uniqueOpens, c.sent)}</span>`;
          tr.querySelector("[data-clicks]").innerHTML = `${fmt(s.uniqueClicks)} <span class="rate">${pct(s.uniqueClicks, c.sent)}</span>`;
        });
      }
    });
  }

  // sales (Stripe + PayPal + Kartra)
  const sb = $("#salesBox");
  sb.innerHTML = "Loading…";
  const salesQs = new URLSearchParams({ from, to }).toString();
  const sales = await api("/api/sales?" + salesQs);
  if (!sales.connected) {
    sb.innerHTML = `Not connected. Add <b>Stripe</b> and/or <b>PayPal</b> credentials in <b>Settings → Sales connections</b> to track revenue here.`;
  } else {
    const rows = [];
    const s = sales.sources || {};
    if (s.stripe) rows.push(s.stripe.error
      ? `<div class="src err">Stripe — ⚠ ${esc(s.stripe.error)}</div>`
      : `<div class="src"><b>Stripe</b> ${s.stripe.currency} ${fmt(s.stripe.net)} <span class="muted">net · ${fmt(s.stripe.count)} charges${s.stripe.refunds ? ` · ${s.stripe.currency} ${fmt(s.stripe.refunds)} refunded` : ""}</span></div>`);
    if (s.paypal) rows.push(s.paypal.error
      ? `<div class="src err">PayPal — ⚠ ${esc(s.paypal.error)}</div>`
      : `<div class="src"><b>PayPal</b> ${s.paypal.currency} ${fmt(s.paypal.gross)} <span class="muted">· ${fmt(s.paypal.count)} transactions</span></div>`);
    if (s.kartra) rows.push(s.kartra.error
      ? `<div class="src err">Kartra — ⚠ ${esc(s.kartra.error)}</div>`
      : s.kartra.note
        ? `<div class="src"><b>Kartra</b> <span class="muted">${esc(s.kartra.note)}</span></div>`
        : `<div class="src"><b>Kartra</b> ${s.kartra.currency} ${fmt(s.kartra.gross)} <span class="muted">· ${fmt(s.kartra.count)} transactions</span></div>`);
    sb.innerHTML = `<div class="big">${sales.currency} ${fmt(sales.total)}</div>
      <div class="muted small" style="margin-bottom:10px">total for selected period</div>
      ${rows.join("")}`;
  }
}
function kpi(v, l, accent) { return `<div class="kpi ${accent ? "accent" : ""}"><div class="v">${v}</div><div class="l">${l}</div></div>`; }
function esc(s) { const d = document.createElement("div"); d.textContent = s || ""; return d.innerHTML; }

// Sales ledger panel (revenue by product + daily trend)
async function loadLedger(from, to) {
  const box = $("#ledgerBox");
  if (!box) return;
  box.innerHTML = "Loading…";
  const l = await api("/api/ledger?" + new URLSearchParams({ from, to }).toString());
  if (!l.connected) { box.innerHTML = `Add your sales-ledger sheet URL in <b>Settings</b> to see product-level sales here.`; return; }
  if (l.error) { box.innerHTML = `⚠ ${esc(l.error)}`; return; }
  const maxP = Math.max(1, ...l.byProduct.map((p) => p.revenue));
  const prodRows = l.byProduct.map((p) => `
    <div class="src" style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center">
      <div><b>${esc(p.product)}</b> <span class="muted">· ${fmt(p.count)} sales</span>
        <div style="height:6px;background:var(--panel2,#1e222b);border-radius:4px;margin-top:5px;overflow:hidden">
          <div style="height:100%;width:${Math.round((p.revenue / maxP) * 100)}%;background:var(--ok,#34d399)"></div></div>
      </div>
      <div style="font-variant-numeric:tabular-nums">${l.currency} ${fmt(p.revenue)}</div>
    </div>`).join("");
  const maxD = Math.max(1, ...l.daily.map((d) => d.revenue));
  const bars = l.daily.map((d) =>
    `<div title="${d.date}: ${l.currency} ${fmt(d.revenue)}" style="flex:1;background:var(--accent2,#2dd4bf);height:${Math.max(3, Math.round((d.revenue / maxD) * 60))}px;border-radius:2px 2px 0 0"></div>`).join("");
  box.innerHTML = `
    <div class="big">${l.currency} ${fmt(l.total)}</div>
    <div class="muted small" style="margin-bottom:12px">${fmt(l.count)} sales in range</div>
    <div style="display:flex;align-items:flex-end;gap:3px;height:64px;margin-bottom:14px">${bars}</div>
    ${prodRows}`;
}

// SMS performance from Twilio (actual sends + cost)
async function loadSmsStats(from, to) {
  const box = $("#smsStatsBox"); if (!box) return;
  box.innerHTML = "Loading…";
  const s = await api("/api/analytics/sms?" + new URLSearchParams({ from, to }).toString());
  if (!s.connected) { box.innerHTML = `Connect <b>Twilio</b> in Settings to see SMS sends here.`; return; }
  if (s.error) { box.innerHTML = `⚠ ${esc(s.error)}`; return; }
  box.innerHTML = `
    <div class="big">${fmt(s.smsCount + s.mmsCount)}</div>
    <div class="muted small" style="margin-bottom:10px">messages sent in range · $${fmt(s.totalCost)} total cost</div>
    <div class="src"><b>SMS</b> ${fmt(s.smsCount)} sent <span class="muted">· $${fmt(s.smsCost)}</span></div>
    <div class="src"><b>MMS</b> ${fmt(s.mmsCount)} sent <span class="muted">· $${fmt(s.mmsCost)}</span></div>`;
}

$("#anRefresh").onclick = loadAnalytics;
if ($("#anProvider")) $("#anProvider").onchange = loadAnalytics;

// ---------- SMS sender accounts (Settings) ----------
async function renderSmsAcctList() {
  const box = $("#smsAcctList"); if (!box) return;
  const d = await api("/api/sms-accounts");
  const accts = (d && d.accounts) || [];
  if (!accts.length) { box.innerHTML = `<p class="muted small">No extra accounts yet — add one below to send SMS as another company.</p>`; return; }
  box.innerHTML = accts.map((a) => `<div class="seg-item"><span class="name">${esc(a.label)} <span class="muted small">${esc(a.accountSid ? a.accountSid.slice(0, 10) + "…" : "")}${a.configured ? "" : " · ⚠ needs credentials"}</span></span><span><button class="btn btn-ghost sm acct-test" data-id="${esc(a.id)}">Test</button> <button class="secondary acct-del" data-id="${esc(a.id)}">Delete</button></span></div>`).join("");
  $$(".acct-del").forEach((b) => b.onclick = async () => {
    if (!confirm("Delete this SMS sender account?")) return;
    await fetch("/api/sms-accounts/" + encodeURIComponent(b.dataset.id), { method: "DELETE" });
    renderSmsAcctList(); if (typeof loadSmsAccounts === "function") loadSmsAccounts();
  });
  $$(".acct-test").forEach((b) => b.onclick = async () => {
    const old = b.textContent; b.textContent = "Testing…";
    const r = await post("/api/twilio/test", { account: b.dataset.id });
    b.textContent = old;
    toast(r.ok ? ("✓ " + r.server) : ("⚠ " + (r.error || "failed")), r.ok ? "ok" : "err");
  });
}
if ($("#acctSave")) $("#acctSave").onclick = async () => {
  const body = {
    label: $("#acctLabel").value.trim(), accountSid: $("#acctSid").value.trim(),
    apiKeySid: $("#acctKeySid").value.trim(), apiKeySecret: $("#acctKeySecret").value.trim(),
    fromNumbers: $("#acctFrom").value.trim(), messagingServiceSid: $("#acctService").value.trim(),
  };
  if (!body.label) return toast("Give the account a label.", "err");
  $("#acctSave").disabled = true; $("#acctMsg").textContent = "Saving…";
  const r = await post("/api/sms-accounts", body);
  $("#acctSave").disabled = false; $("#acctMsg").textContent = r.error ? "" : "Saved ✓";
  if (r.error) return toast(r.error, "err");
  $("#acctKeySecret").value = "";
  renderSmsAcctList(); if (typeof loadSmsAccounts === "function") loadSmsAccounts();
  toast(`"${r.label}" saved — pick it under SMS → Send from → Account.`, "ok");
};

// ---------- settings ----------
async function loadSettings() {
  renderSmsAcctList();
  const s = await api("/api/settings");
  $("#setFromEmail").value = s.fromEmail || "";
  $("#setFromName").value = s.fromName || "";
  $("#setStream").value = s.stream || "";
  $("#setReplyTo").value = s.replyTo || "";
  $("#setTestEmail").value = s.testEmail || "";
  $("#setToken").placeholder = s.hasToken ? "•••••• (saved — leave blank to keep)" : "paste your Postmark server token";
  $("#setStripe").placeholder = s.hasStripe ? "•••••• (saved — leave blank to keep)" : "rk_live_… / sk_live_…";
  $("#setPaypalId").placeholder = s.hasPaypal ? "•••••• (saved — leave blank to keep)" : "PayPal client ID";
  $("#setPaypalSecret").placeholder = s.hasPaypal ? "•••••• (saved — leave blank to keep)" : "PayPal secret";
  $("#setPaypalEnv").value = s.paypalEnv || "live";
  $("#setKartraApp").placeholder = s.hasKartra ? "•••••• (saved — leave blank to keep)" : "Kartra app ID";
  $("#setKartraKey").placeholder = s.hasKartra ? "•••••• (saved — leave blank to keep)" : "Kartra API key";
  if ($("#setMgKey")) {
    $("#setMgKey").placeholder = s.hasMailgun ? "•••••• (saved — leave blank to keep)" : "paste your Mailgun private API key";
    $("#setMgDomain").value = s.mailgunDomain || "";
    $("#setMgRegion").value = s.mailgunRegion || "us";
    $("#setMgFromEmail").value = s.mailgunFromEmail || "";
    $("#setMgFromName").value = s.mailgunFromName || "";
    if ($("#setMgClicks")) $("#setMgClicks").checked = !!s.mailgunClickTracking;
  }
  if ($("#setTwSid")) {
    $("#setTwSid").placeholder = s.hasTwilio ? `•••••• (saved: ${s.twilioAccountSid})` : "AC…";
    $("#setTwToken").placeholder = s.hasTwilio ? "•••••• (saved — leave blank to keep)" : "Auth Token";
    $("#setTwFrom").value = (s.twilioFromNumbers || []).join(", ");
    $("#setTwService").value = s.twilioMessagingServiceSid || "";
    $("#setTwTestPhone").value = s.testPhone || "";
  }
  if ($("#setQuoKey")) {
    $("#setQuoKey").placeholder = s.hasQuo ? "•••••• (saved — leave blank to keep)" : "paste your Quo API key";
    $("#setQuoFrom").value = s.quoFromNumber || "";
  }
}
$("#setSave").onclick = async () => {
  const body = {
    fromEmail: $("#setFromEmail").value, fromName: $("#setFromName").value,
    stream: $("#setStream").value, replyTo: $("#setReplyTo").value, testEmail: $("#setTestEmail").value,
  };
  if ($("#setToken").value.trim()) body.postmarkToken = $("#setToken").value.trim();
  await post("/api/settings", body);
  $("#setToken").value = "";
  toast("Settings saved ✓", "ok");
  refreshConn(); loadSettings();
};
$("#setTest").onclick = async () => {
  $("#setMsg").textContent = "Testing…";
  const r = await post("/api/test-connection", { provider: "postmark" });
  $("#setMsg").textContent = r.ok ? `✓ Connected to "${r.server}"` : "✗ " + r.error;
  $("#setMsg").style.color = r.ok ? "var(--ok)" : "var(--err)";
};
$("#setMgSave").onclick = async () => {
  const body = {
    mailgunDomain: $("#setMgDomain").value.trim(), mailgunRegion: $("#setMgRegion").value,
    mailgunFromEmail: $("#setMgFromEmail").value.trim(), mailgunFromName: $("#setMgFromName").value.trim(),
    mailgunClickTracking: $("#setMgClicks") ? $("#setMgClicks").checked : false,
  };
  if ($("#setMgKey").value.trim()) body.mailgunApiKey = $("#setMgKey").value.trim();
  await post("/api/settings", body);
  $("#setMgKey").value = "";
  toast("Mailgun settings saved ✓", "ok");
  refreshConn(); loadSettings();
};
$("#setMgTest").onclick = async () => {
  $("#setMgMsg").textContent = "Testing…";
  const r = await post("/api/test-connection", { provider: "mailgun" });
  $("#setMgMsg").textContent = r.ok ? `✓ ${r.server}` : "✗ " + r.error;
  $("#setMgMsg").style.color = r.ok ? "var(--ok)" : "var(--err)";
};
$("#setSalesSave").onclick = async () => {
  const body = { paypalEnv: $("#setPaypalEnv").value };
  const map = {
    stripeKey: "#setStripe", paypalClientId: "#setPaypalId", paypalSecret: "#setPaypalSecret",
    kartraAppId: "#setKartraApp", kartraApiKey: "#setKartraKey", kartraApiPassword: "#setKartraPass",
  };
  for (const [k, sel] of Object.entries(map)) { const v = $(sel).value.trim(); if (v) body[k] = v; }
  await post("/api/settings", body);
  Object.values(map).forEach((sel) => ($(sel).value = ""));
  toast("Sales connections saved ✓", "ok");
  loadSettings();
};
$("#setSalesTest").onclick = async () => {
  $("#salesMsg").textContent = "Testing…";
  $("#salesMsg").style.color = "var(--muted)";
  const r = await post("/api/sales/test", {});
  const parts = Object.entries(r).map(([k, v]) =>
    `${k}: ${v.ok ? "✓ " + (v.id || v.env || v.note || "ok") : "✗ " + v.error}`);
  $("#salesMsg").innerHTML = parts.length ? parts.join(" &nbsp;·&nbsp; ") : "Nothing connected yet.";
};

$("#setTwSave").onclick = async () => {
  const body = { twilioFromNumbers: $("#setTwFrom").value.trim(), twilioMessagingServiceSid: $("#setTwService").value.trim(), testPhone: $("#setTwTestPhone").value.trim() };
  if ($("#setTwSid").value.trim()) body.twilioAccountSid = $("#setTwSid").value.trim();
  if ($("#setTwToken").value.trim()) body.twilioAuthToken = $("#setTwToken").value.trim();
  await post("/api/settings", body);
  $("#setTwSid").value = ""; $("#setTwToken").value = "";
  toast("Twilio settings saved ✓", "ok");
  loadSettings();
};
$("#setTwTest").onclick = async () => {
  $("#setTwMsg").textContent = "Testing…"; $("#setTwMsg").style.color = "var(--muted)";
  const r = await post("/api/twilio/test", {});
  $("#setTwMsg").textContent = r.ok ? `✓ ${r.server}` : "✗ " + r.error;
  $("#setTwMsg").style.color = r.ok ? "var(--ok)" : "var(--err)";
};

if ($("#setQuoSave")) $("#setQuoSave").onclick = async () => {
  const body = { quoFromNumber: $("#setQuoFrom").value.trim() };
  if ($("#setQuoKey").value.trim()) body.quoApiKey = $("#setQuoKey").value.trim();
  await post("/api/settings", body);
  $("#setQuoKey").value = "";
  toast("Quo settings saved ✓", "ok");
  refreshConn(); loadSettings();
};
if ($("#setQuoTest")) $("#setQuoTest").onclick = async () => {
  $("#setQuoMsg").textContent = "Testing…"; $("#setQuoMsg").style.color = "var(--muted)";
  const r = await post("/api/quo/test", {});
  $("#setQuoMsg").textContent = r.ok ? `✓ ${r.server}` : "✗ " + r.error;
  $("#setQuoMsg").style.color = r.ok ? "var(--ok)" : "var(--err)";
  if (r.ok) { PROVIDER_STATE = await api("/api/settings"); loadSettings(); }
};

// ---------- SMS / MMS tab ----------
const smsSelected = () => $("#smsAudience") ? [...$("#smsAudience").selectedOptions].map((o) => o.value) : [];
const smsProvider = () => ($("#smsProvider") ? $("#smsProvider").value : "twilio");
function smsCount() {
  const t = $("#smsBody").value;
  const unicode = /[^ -]/.test(t); // emoji / non-GSM → UCS-2
  const per = unicode ? 70 : 160, perMulti = unicode ? 67 : 153;
  const len = t.length;
  const segs = len === 0 ? 1 : len <= per ? 1 : Math.ceil(len / perMulti);
  $("#smsCount").textContent = `${len} characters · ${segs} segment${segs > 1 ? "s" : ""}${unicode ? " (unicode)" : ""}${segs > 1 ? " — billed as " + segs : ""}`;
}
let SMS_ACCOUNTS = [];
const currentSmsAccount = () => ($("#smsAccount") && $("#smsAccount").value) || "default";
function refreshSmsFrom(s) {
  const sel = $("#smsFrom"); sel.innerHTML = "";
  const isQuo = smsProvider() === "quo";
  // the account picker only applies to Twilio blasts; hide it for Quo or when there are no extra accounts
  if ($("#smsAccountField")) $("#smsAccountField").style.display = (!isQuo && SMS_ACCOUNTS.length) ? "" : "none";
  if (isQuo) {
    if (s.quoFromNumber) { const o = document.createElement("option"); o.value = s.quoFromNumber; o.textContent = s.quoFromNumber + " (Quo)"; sel.appendChild(o); }
    $("#smsFromNote").innerHTML = s.hasQuo
      ? (sel.options.length ? "Replies will land in your Quo inbox — text back or call from there. (Text-only — no MMS via Quo.)" : "⚠ No Quo number saved — hit <b>Test connection</b> in <b>Settings → Quo</b> to auto-fill it.")
      : "⚠ Quo not configured — add your API key in <b>Settings → Quo</b>.";
    return;
  }
  const acctId = currentSmsAccount();
  if (acctId !== "default") {
    const a = SMS_ACCOUNTS.find((x) => x.id === acctId);
    const nums = a ? (a.fromNumbers || "").split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean) : [];
    nums.forEach((n) => { const o = document.createElement("option"); o.value = n; o.textContent = n; sel.appendChild(o); });
    if (a && a.messagingServiceSid) { const o = document.createElement("option"); o.value = "service"; o.textContent = "Messaging Service"; sel.appendChild(o); }
    $("#smsFromNote").innerHTML = !a ? "⚠ Account not found."
      : !a.configured ? `⚠ <b>${esc(a.label)}</b> isn't fully configured — add its credentials in <b>Settings → SMS sender accounts</b>.`
      : sel.options.length ? `Sending as <b>${esc(a.label)}</b> — separate from Crate Hackers.`
      : `⚠ No sending number for ${esc(a.label)} — add one in <b>Settings → SMS sender accounts</b>.`;
    return;
  }
  (s.twilioFromNumbers || []).forEach((n) => { const o = document.createElement("option"); o.value = n; o.textContent = n; sel.appendChild(o); });
  if (s.twilioMessagingServiceSid) { const o = document.createElement("option"); o.value = "service"; o.textContent = "Messaging Service (" + s.twilioMessagingServiceSid.slice(0, 8) + "…)"; sel.appendChild(o); }
  $("#smsFromNote").innerHTML = s.hasTwilio
    ? (sel.options.length ? "" : "⚠ No sending number saved — add one in <b>Settings → Twilio</b>.")
    : "⚠ Twilio not configured — add it in <b>Settings → Twilio</b>.";
}
async function loadSmsAccounts() {
  const d = await api("/api/sms-accounts");
  SMS_ACCOUNTS = (d && d.accounts) || [];
  const sel = $("#smsAccount");
  if (sel) {
    const cur = sel.value || "default";
    sel.innerHTML = `<option value="default">Crate Hackers</option>` + SMS_ACCOUNTS.map((a) => `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join("");
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : "default";
  }
  refreshSmsFrom(PROVIDER_STATE || {});
}
if ($("#smsAccount")) $("#smsAccount").onchange = () => refreshSmsFrom(PROVIDER_STATE || {});
async function loadSms() {
  const s = PROVIDER_STATE && PROVIDER_STATE.hasTwilio !== undefined ? PROVIDER_STATE : await api("/api/settings");
  PROVIDER_STATE = s;
  refreshSmsFrom(s);
  loadSmsAccounts();
  $("#smsTestPhone").value = s.testPhone || "";
  // segments
  const { segments } = await api("/api/sms/segments");
  const a = $("#smsAudience"); a.innerHTML = "";
  segments.forEach((g) => { const o = document.createElement("option"); o.value = g.name; o.textContent = `${g.name} (${fmt(g.count)})`; a.appendChild(o); });
  // list with delete
  const list = $("#smsSegList"); list.innerHTML = "";
  segments.forEach((g) => {
    const d = document.createElement("div"); d.className = "seg-item";
    d.innerHTML = `<span class="name">${esc(g.name)}</span><span><span class="count">${fmt(g.count)}</span> &nbsp; <button class="secondary" data-smsdel="${esc(g.name)}">Delete</button></span>`;
    list.appendChild(d);
  });
  $$("[data-smsdel]").forEach((b) => b.onclick = async () => {
    if (!confirm(`Delete SMS list "${b.dataset.smsdel}"?`)) return;
    await fetch("/api/sms/segments/" + encodeURIComponent(b.dataset.smsdel), { method: "DELETE" });
    loadSms();
  });
  smsCount();
}
if ($("#smsProvider")) $("#smsProvider").onchange = () => refreshSmsFrom(PROVIDER_STATE || {});
if ($("#smsBody")) $("#smsBody").oninput = smsCount;
if ($("#smsInsertName")) $("#smsInsertName").onclick = () => {
  const t = $("#smsBody");
  const s = t.selectionStart ?? t.value.length, e = t.selectionEnd ?? t.value.length;
  const token = "{{first_name}}";
  t.value = t.value.slice(0, s) + token + t.value.slice(e);
  const pos = s + token.length;
  t.focus(); t.setSelectionRange(pos, pos);
  smsCount();
};
const mediaUrls = () => ($("#smsMedia").value || "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

if ($("#smsPreviewBtn")) $("#smsPreviewBtn").onclick = async () => {
  $("#smsPreviewOut").innerHTML = "Calculating…";
  const r = await post("/api/sms/preview", { segments: smsSelected(), pasted: $("#smsPaste").value });
  $("#smsPreviewOut").innerHTML = `<div><span class="big">${fmt(r.recipients)}</span> recipients</div>
    <div class="muted">${fmt(r.dupes)} duplicates removed · ${fmt(r.invalid)} invalid numbers</div>`;
};
if ($("#smsTestBtn")) $("#smsTestBtn").onclick = async () => {
  const testPhone = $("#smsTestPhone").value.trim();
  if (!testPhone) return toast("Enter a test phone number.", "err");
  if (!$("#smsBody").value && !mediaUrls().length) return toast("Add a message or MMS image.", "err");
  $("#smsTestBtn").disabled = true;
  const r = await post("/api/sms/send", { body: $("#smsBody").value, mediaUrls: mediaUrls(), from: $("#smsFrom").value, provider: smsProvider(), smsAccount: currentSmsAccount(), test: true, testPhone });
  $("#smsTestBtn").disabled = false;
  if (r.error) return toast(r.error, "err");
  toast("Test text sent to " + testPhone + " ✓", "ok");
};
if ($("#smsSendBtn")) $("#smsSendBtn").onclick = async () => {
  const segs = smsSelected();
  if (!$("#smsBody").value && !mediaUrls().length) return toast("Add a message or MMS image.", "err");
  if (!segs.length && !$("#smsPaste").value.trim()) return toast("Pick a list or paste numbers.", "err");
  const pre = await post("/api/sms/preview", { segments: segs, pasted: $("#smsPaste").value });
  if (!pre.recipients) return toast("No valid recipients.", "err");
  const acctLabel = (smsProvider() === "quo" || currentSmsAccount() === "default") ? "Crate Hackers" : ((SMS_ACCOUNTS.find((a) => a.id === currentSmsAccount()) || {}).label || currentSmsAccount());
  if (!confirm(`Text ${pre.recipients.toLocaleString()} recipients via ${smsProvider() === "quo" ? "Quo" : "Twilio"}, sending as “${acctLabel}”?\n\nThis sends real ${mediaUrls().length ? "MMS" : "SMS"} messages. Continue?`)) return;
  $("#smsSendBtn").disabled = true;
  const r = await post("/api/sms/send", { body: $("#smsBody").value, mediaUrls: mediaUrls(), from: $("#smsFrom").value, provider: smsProvider(), smsAccount: currentSmsAccount(), segments: segs, pasted: $("#smsPaste").value });
  if (r.error) { $("#smsSendBtn").disabled = false; return toast(r.error, "err"); }
  $("#smsProgress").classList.remove("hidden");
  rememberJob(r.jobId, r.total, "sms");
  smsPoll(r.jobId, r.total);
};
function smsPoll(jobId, total) {
  const t = setInterval(async () => {
    const j = await api("/api/send/status/" + jobId);
    if (j.error) { clearInterval(t); $("#smsSendBtn").disabled = false; return; }
    const pctDone = total ? Math.round((j.processed / total) * 100) : 0;
    $("#smsBar").style.width = pctDone + "%";
    $("#smsProgressText").textContent = `${fmt(j.processed)} / ${fmt(total)} · ${fmt(j.sent)} sent · ${fmt(j.failed)} failed`;
    if (j.done) { clearInterval(t); clearJob(); $("#smsSendBtn").disabled = false; toast(`Done — ${fmt(j.sent)} texts sent, ${fmt(j.failed)} failed.`, j.failed ? "" : "ok"); }
  }, 800);
}
if ($("#smsSegUpload")) $("#smsSegUpload").onclick = async () => {
  const files = [...$("#smsSegFile").files];
  if (!files.length) return toast("Choose one or more CSV files.", "err");
  const typed = $("#smsSegName").value.trim();
  let ok = 0, fail = 0, total = 0;
  for (const file of files) {
    const name = files.length === 1 && typed ? typed : nameFromFile(file);
    try {
      const r = await post("/api/sms/segments", { name, csv: await readTextFile(file) });
      if (r.error) { fail++; toast(`${file.name}: ${r.error}`, "err"); }
      else { ok++; total += r.count || 0; }
    } catch { fail++; toast(`${file.name}: couldn't read file`, "err"); }
  }
  if (ok) toast(`${ok} phone list${ok > 1 ? "s" : ""} saved — ${fmt(total)} numbers${fail ? `, ${fail} failed` : ""}.`, fail ? "err" : "ok");
  $("#smsSegName").value = ""; $("#smsSegFile").value = ""; loadSms();
};

// ---------- scheduling ----------
async function scheduleSend(channel) {
  const atInput = channel === "sms" ? $("#smsSchedAt") : $("#schedAt");
  if (!atInput.value) return toast("Pick a date & time first.", "err");
  const at = new Date(atInput.value).getTime();
  if (!at || at < Date.now()) return toast("Pick a time in the future.", "err");
  let payload;
  if (channel === "email") {
    if (!$("#subject").value.trim() || !$("#html").value) return toast("Subject and body are required.", "err");
    if (!selectedSegments().length) return toast("Select an audience.", "err");
    payload = { subject: $("#subject").value.trim(), html: $("#html").value, text: $("#text").value, segments: selectedSegments(), provider: provider() };
  } else {
    if (!$("#smsBody").value && !mediaUrls().length) return toast("Add a message or MMS image.", "err");
    if (!smsSelected().length && !$("#smsPaste").value.trim()) return toast("Pick a list or paste numbers.", "err");
    payload = { body: $("#smsBody").value, mediaUrls: mediaUrls(), from: $("#smsFrom").value, provider: smsProvider(), segments: smsSelected(), pasted: $("#smsPaste").value };
  }
  const r = await post("/api/schedule", { channel, at, payload });
  if (r.error) return toast(r.error, "err");
  toast(`Scheduled for ${new Date(at).toLocaleString()} ✓`, "ok");
  atInput.value = "";
  loadUpcoming();
}
if ($("#schedBtn")) $("#schedBtn").onclick = () => scheduleSend("email");
if ($("#smsSchedBtn")) $("#smsSchedBtn").onclick = () => scheduleSend("sms");

async function loadUpcoming() {
  const conts = $$(".upcoming-list"); if (!conts.length) return;
  const { scheduled } = await api("/api/scheduled");
  const all = scheduled || [];
  const upcoming = all.filter((s) => s.status === "scheduled").sort((a, b) => a.at - b.at);
  const recent = all.filter((s) => s.status !== "scheduled").sort((a, b) => b.at - a.at).slice(0, 3);
  const t = (ms) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const row = (s) => {
    const tag = s.channel === "sms" ? "SMS/MMS" : "Email";
    const right = s.status === "scheduled"
      ? `<button class="secondary" data-cancel="${s.id}" style="padding:3px 10px;font-size:12px">Cancel</button>`
      : `<span class="muted" style="font-size:12px">${esc(s.status)}${s.error ? " · " + esc(s.error) : s.sent != null ? " · " + fmt(s.sent) : ""}</span>`;
    return `<div class="up-item"><span><b>${t(s.at)}</b> · ${tag}<br><span class="muted">${esc(s.label || "")}</span></span>${right}</div>`;
  };
  const html = (upcoming.length || recent.length) ? [...upcoming, ...recent].map(row).join("") : `<div class="muted small">No scheduled sends.</div>`;
  conts.forEach((c) => (c.innerHTML = html));
  $$("[data-cancel]").forEach((b) => b.onclick = async () => {
    if (!confirm("Cancel this scheduled send?")) return;
    await fetch("/api/scheduled/" + encodeURIComponent(b.dataset.cancel), { method: "DELETE" });
    loadUpcoming();
  });
}

// ---------- drafts ----------
const editingDraft = { email: null, sms: null };
const emailPayload = () => ({ subject: $("#subject").value.trim(), html: $("#html").value, text: $("#text").value, segments: selectedSegments(), provider: provider(), ...dripBody() });
const smsPayloadOf = () => ({ body: $("#smsBody").value, mediaUrls: mediaUrls(), from: $("#smsFrom") ? $("#smsFrom").value : "", provider: smsProvider(), segments: smsSelected(), pasted: $("#smsPaste").value });
async function saveDraft(channel) {
  const payload = channel === "sms" ? smsPayloadOf() : emailPayload();
  if (channel === "email" && !payload.subject && !payload.html) return toast("Nothing to save yet.", "err");
  if (channel === "sms" && !payload.body && !payload.mediaUrls.length) return toast("Nothing to save yet.", "err");
  const label = channel === "sms" ? (payload.body || "(text draft)").slice(0, 60) : (payload.subject || "(untitled email)");
  const body = { channel, label, payload };
  if (editingDraft[channel]) body.id = editingDraft[channel];
  const r = await post("/api/drafts", body);
  if (r.error) return toast(r.error, "err");
  editingDraft[channel] = r.id;
  toast("Draft saved ✓", "ok");
  loadDrafts();
}
if ($("#saveDraftBtn")) $("#saveDraftBtn").onclick = () => saveDraft("email");
if ($("#smsSaveDraftBtn")) $("#smsSaveDraftBtn").onclick = () => saveDraft("sms");

async function loadDrafts() {
  const conts = $$(".drafts-list"); if (!conts.length) return;
  const { drafts } = await api("/api/drafts");
  const t = (s) => { try { return new Date(s).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return ""; } };
  for (const c of conts) {
    const ch = c.getAttribute("data-channel");
    const mine = (drafts || []).filter((d) => d.channel === ch);
    c.innerHTML = mine.length ? mine.map((d) => `
      <div class="up-item"><span><b>${esc(d.label || "(untitled)")}</b><br><span class="muted" style="font-size:11px">${t(d.updatedAt)}</span></span>
      <span style="white-space:nowrap"><button class="secondary" data-loaddraft="${d.id}" data-ch="${ch}" style="padding:3px 9px;font-size:12px">Load</button>
      <button class="secondary" data-deldraft="${d.id}" style="padding:3px 8px;font-size:12px">✕</button></span></div>`).join("")
      : `<div class="muted small">No drafts yet.</div>`;
  }
  $$("[data-loaddraft]").forEach((b) => b.onclick = () => loadDraftInto(b.dataset.loaddraft, b.dataset.ch));
  $$("[data-deldraft]").forEach((b) => b.onclick = async () => { if (!confirm("Delete this draft?")) return; await fetch("/api/drafts/" + encodeURIComponent(b.dataset.deldraft), { method: "DELETE" }); loadDrafts(); });
}
async function loadDraftInto(id, channel) {
  const d = await api("/api/drafts/" + encodeURIComponent(id));
  if (!d || d.error) return toast("Could not load draft.", "err");
  const p = d.payload || {};
  if (channel === "email") {
    $("#subject").value = p.subject || "";
    $("#html").value = p.html || "";
    $("#text").value = p.text || "";
    if (p.provider && $("#provider")) { $("#provider").value = p.provider; if (typeof updateProviderNote === "function") updateProviderNote(); }
    [...$("#audience").options].forEach((o) => o.selected = (p.segments || []).includes(o.value));
    editingDraft.email = id;
    document.querySelector("[data-tab=compose]").click();
    if (typeof setComposeMode === "function") setComposeMode("html");
    toast("Draft loaded — edit, then send/schedule when ready.", "ok");
  } else {
    document.querySelector("[data-tab=sms]").click();
    setTimeout(() => {
      if (p.provider && $("#smsProvider")) { $("#smsProvider").value = p.provider; refreshSmsFrom(PROVIDER_STATE || {}); }
      $("#smsBody").value = p.body || "";
      if ($("#smsMedia")) $("#smsMedia").value = (p.mediaUrls || []).join(", ");
      $("#smsPaste").value = p.pasted || "";
      if (p.from && $("#smsFrom")) $("#smsFrom").value = p.from;
      if ($("#smsAudience")) [...$("#smsAudience").options].forEach((o) => o.selected = (p.segments || []).includes(o.value));
      if (typeof smsCount === "function") smsCount();
    }, 450);
    editingDraft.sms = id;
    toast("Draft loaded — edit, then send/schedule when ready.", "ok");
  }
}

// ---------- outreach (call / text queue) ----------
let OUTREACH_ROWS = [];
async function loadOutreach() {
  const sel = $("#outreachList");
  const cur = sel.value;
  const r = await api("/api/outreach" + (cur ? "?list=" + encodeURIComponent(cur) : ""));
  sel.innerHTML = `<option value="">— pick a phone list —</option>`;
  (r.lists || []).forEach((l) => {
    const o = document.createElement("option");
    o.value = l.name; o.textContent = `${l.name} (${fmt(l.count)})`;
    if (l.name === cur) o.selected = true;
    sel.appendChild(o);
  });
  OUTREACH_ROWS = r.rows || [];
  renderOutreach();
}
function renderOutreach() {
  const tb = $("#outreachTable tbody");
  const filter = $("#outreachFilter").value;
  const rows = (filter ? OUTREACH_ROWS.filter((x) => x.status === filter) : OUTREACH_ROWS.slice());
  const sort = ($("#outreachSort") && $("#outreachSort").value) || "ltv-desc";
  const ltv = (x) => Number(x.ltv) || 0;
  rows.sort((a, b) =>
    sort === "ltv-asc" ? ltv(a) - ltv(b) :
    sort === "name" ? (a.name || "").localeCompare(b.name || "") :
    sort === "status" ? (a.status || "").localeCompare(b.status || "") :
    ltv(b) - ltv(a));
  const total = OUTREACH_ROWS.length;
  const worked = OUTREACH_ROWS.filter((x) => x.status !== "todo").length;
  $("#outreachStats").textContent = total ? `${fmt(worked)} of ${fmt(total)} worked` : "";
  $("#outreachEmpty").classList.toggle("hidden", !!total);
  $("#outreachTable").classList.toggle("hidden", !total);
  const STATUSES = ["todo", "called", "texted", "no-answer", "done"];
  tb.innerHTML = "";
  rows.forEach((x) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><button class="btn btn-secondary sm" data-otext="${esc(x.phone)}" style="padding:3px 10px;font-size:12px;white-space:nowrap">💬 Text</button></td>
      <td>${esc(x.name || "—")}</td>
      <td style="white-space:nowrap;font-variant-numeric:tabular-nums">${x.ltv ? "$" + fmt(Math.round(x.ltv)) : "—"}</td>
      <td><a href="tel:${esc(x.phone)}" style="color:var(--accent2,#2dd4bf)">${esc(x.phone)}</a></td>
      <td class="muted">${esc(x.email || "")}</td>
      <td><select data-ophone="${esc(x.phone)}" style="padding:4px 8px">${STATUSES.map((s) => `<option value="${s}" ${s === x.status ? "selected" : ""}>${s}</option>`).join("")}</select></td>
      <td><input type="text" data-onote="${esc(x.phone)}" value="${esc(x.note || "")}" placeholder="note…" style="width:100%;padding:4px 8px" /></td>`;
    tb.appendChild(tr);
  });
  $$("[data-otext]").forEach((b) => b.onclick = async () => {
    const phone = b.dataset.otext;
    const row = OUTREACH_ROWS.find((x) => x.phone === phone);
    const body = $("#outreachMsg").value.trim();
    if (!body) return toast("Write your opener message in the box above first.", "err");
    const preview = body.replace(/\{\{first_name\}\}/g, (row && row.name) || "there");
    if (!confirm(`Text ${row && row.name ? row.name + " " : ""}(${phone}) from your Quo number?\n\n"${preview}"`)) return;
    b.disabled = true; b.textContent = "Sending…";
    const r = await post("/api/outreach/text", { list: $("#outreachList").value, phone, name: (row && row.name) || "", body });
    b.disabled = false; b.textContent = "💬 Text";
    if (r.error) return toast(r.error, "err");
    if (row) row.status = "texted";
    const sel = document.querySelector(`[data-ophone="${CSS.escape(phone)}"]`);
    if (sel) sel.value = "texted";
    const total2 = OUTREACH_ROWS.length, worked2 = OUTREACH_ROWS.filter((x) => x.status !== "todo").length;
    $("#outreachStats").textContent = total2 ? `${fmt(worked2)} of ${fmt(total2)} worked` : "";
    toast(`Text sent via Quo ✓ — watch your Quo inbox for the reply`, "ok");
  });
  const save = async (phone, patch) => {
    const row = OUTREACH_ROWS.find((x) => x.phone === phone); if (!row) return;
    Object.assign(row, patch);
    await post("/api/outreach", { list: $("#outreachList").value, phone, status: row.status, note: row.note });
    const total2 = OUTREACH_ROWS.length, worked2 = OUTREACH_ROWS.filter((x) => x.status !== "todo").length;
    $("#outreachStats").textContent = total2 ? `${fmt(worked2)} of ${fmt(total2)} worked` : "";
  };
  $$("[data-ophone]").forEach((s) => s.onchange = () => save(s.dataset.ophone, { status: s.value }));
  $$("[data-onote]").forEach((i) => i.onchange = () => save(i.dataset.onote, { note: i.value }));
}
if ($("#outreachList")) $("#outreachList").onchange = loadOutreach;
if ($("#outreachFilter")) $("#outreachFilter").onchange = renderOutreach;
if ($("#outreachSort")) $("#outreachSort").onchange = renderOutreach;

// ---------- Level 11 funnel ----------
const fmtMoney = (n) => "$" + Math.round(n || 0).toLocaleString();
const fmtPct = (r) => ((r || 0) * 100).toFixed(1) + "%";
const funMetric = (label, value) =>
  `<div style="flex:1;min-width:120px;background:#151823;border:1px solid #242838;border-radius:12px;padding:14px 16px">
    <div style="font-size:12px;color:#8b93a7;text-transform:uppercase;letter-spacing:.04em">${label}</div>
    <div style="font-size:24px;font-weight:700;margin-top:4px">${value}</div></div>`;
const funBar = (label, val, max, color) => {
  const w = max > 0 ? Math.max(2, (val / max) * 100) : 0;
  return `<div style="margin:6px 0">
    <div style="display:flex;justify-content:space-between;font-size:12px;color:#aeb6cc;margin-bottom:3px"><span>${label}</span><span style="font-weight:700;color:#fff">${(val || 0).toLocaleString()}</span></div>
    <div style="height:10px;background:#0e0f12;border-radius:6px;overflow:hidden"><div style="height:100%;width:${w}%;background:${color}"></div></div></div>`;
};
const FUNNELS = {
  level11: { title: "Level 11 Funnel", desc: 'Live split-test performance for <b>lander.cratehackers.com/level11</b> — visitors → checkout clicks → conversions → revenue, per variant.', lead: false },
  "july4-sale": { title: "🎆 July 4 Sale", desc: 'Live Kartra sales for the 4th-of-July funnel (<b>/home-july4-26 → /oto-july26</b>), broken out by price point. Pulled from your sales ledger (near-live, ~2-min cache).', saleReport: true },
  "hackathon-popo": { title: "DJ POPO — R&B Hackathon", desc: 'Live A/B performance for <b>lander.cratehackers.com/hackathon-popo</b> — visitors → opt-in clicks → leads, per option. A "conversion" here = an opt-in (thank-you page load); the $27 sale happens off-site in Kartra.', lead: true, labels: { jewel: "Jewel & Gold", jewe: "Jewel & Gold", storm: "Quiet Storm", stor: "Quiet Storm" } },
  chicagohackathon: { title: "Chicago Hackathon", desc: 'Opt-in performance for <b>lander.cratehackers.com/chicagohackathon</b> — visitors → opt-in clicks → leads.', lead: true },
  chicago: { title: "Chicago (in-person)", desc: 'Opt-in performance for <b>lander.cratehackers.com/chicago</b> — visitors → opt-in clicks → leads.', lead: true },
};
function curFunnel() { return ($("#funSelect") && $("#funSelect").value) || "level11"; }
function funMeta() { return FUNNELS[curFunnel()] || FUNNELS.level11; }
(function initFunnelSelect() {
  const sel = $("#funSelect"); if (!sel) return;
  sel.innerHTML = Object.entries(FUNNELS).map(([id, m]) => `<option value="${id}">${m.title}</option>`).join("");
  sel.onchange = loadFunnel;
})();
function vLabel(m, v) { return (m && m.labels && m.labels[v]) || (v || "?").toUpperCase(); }
async function loadFunnel() {
  const m = funMeta();
  if ($("#funTitle")) $("#funTitle").textContent = m.title;
  if ($("#funDesc")) $("#funDesc").innerHTML = m.desc;
  if (m.saleReport) return loadSaleReport(m);
  if ($("#funVariantsHead")) { $("#funVariantsHead").style.display = ""; $("#funVariantsHead").innerHTML = 'By variant <span class="muted" style="font-weight:400;text-transform:none">— winner = highest earnings per visitor (EPC)</span>'; }
  if ($("#funTierWrap")) $("#funTierWrap").style.display = m.lead ? "none" : "";
  if ($("#funNote")) $("#funNote").style.display = m.lead ? "none" : "";
  $("#funMsg").textContent = "Loading…";
  const qs = new URLSearchParams();
  qs.set("funnel", curFunnel());
  if ($("#funFrom").value) qs.set("from", $("#funFrom").value);
  if ($("#funTo").value) qs.set("to", $("#funTo").value);
  let d; try { d = await api("/api/funnel?" + qs.toString()); } catch { $("#funMsg").textContent = "Couldn't load."; return; }
  $("#funMsg").textContent = "";
  renderFunnel(d, m);
}
function renderFunnel(d, m) {
  m = m || funMeta();
  const lead = !!m.lead;
  const t = d.totals;
  const totCells = [
    funMetric("Visitors", fmt(t.view)),
    funMetric(lead ? "Opt-in clicks" : "Checkout clicks", fmt(t.cta)),
    funMetric(lead ? "Leads" : "Conversions", fmt(t.conv)),
    funMetric(lead ? "Opt-in rate" : "Conv. rate", fmtPct(t.convRate)),
  ];
  if (!lead) totCells.push(funMetric("Revenue", fmtMoney(t.revenue)), funMetric("AOV", fmtMoney(t.aov)), funMetric("EPC / visitor", fmtMoney(t.epc)));
  $("#funTotals").innerHTML = `<div style="display:flex;gap:12px;flex-wrap:wrap">${totCells.join("")}</div>`;
  const variants = d.variants || [];
  const maxView = Math.max(1, ...variants.map((v) => v.view));
  let winner = null, winScore = -1;
  variants.filter((v) => v.view > 0).forEach((v) => { const s = lead ? v.convRate : v.epc; if (s > winScore) { winScore = s; winner = v; } });
  $("#funVariants").innerHTML = variants.length ? `<div style="display:flex;gap:14px;flex-wrap:wrap">` + variants.map((v) => {
    const win = winner && v.variant === winner.variant && t.conv > 0;
    const extra = lead ? "" : `
        <div style="flex:1;min-width:64px"><div style="font-size:11px;color:#8b93a7">AOV</div><div style="font-weight:700">${fmtMoney(v.aov)}</div></div>
        <div style="flex:1;min-width:64px"><div style="font-size:11px;color:#8b93a7">EPC</div><div style="font-weight:700;color:#FF7722">${fmtMoney(v.epc)}</div></div>
        <div style="flex:1;min-width:64px"><div style="font-size:11px;color:#8b93a7">Revenue</div><div style="font-weight:700">${fmtMoney(v.revenue)}</div></div>`;
    return `<div style="flex:1;min-width:240px;background:#151823;border:1px solid ${win ? "#FF7722" : "#242838"};border-radius:14px;padding:16px;position:relative">
      ${win ? `<span style="position:absolute;top:-10px;right:14px;background:#FF7722;color:#1a1206;font-size:11px;font-weight:800;padding:2px 8px;border-radius:6px">★ WINNER</span>` : ""}
      <div style="font-size:15px;font-weight:800;letter-spacing:.04em;margin-bottom:10px">${vLabel(m, v.variant)}</div>
      ${funBar("Visitors", v.view, maxView, "#3b82f6")}${funBar(lead ? "Opt-in clicks" : "Checkout clicks", v.cta, maxView, "#a855f7")}${funBar(lead ? "Leads" : "Conversions", v.conv, maxView, "#22c55e")}
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;border-top:1px solid #242838;padding-top:10px">
        <div style="flex:1;min-width:64px"><div style="font-size:11px;color:#8b93a7">${lead ? "Opt-in rate" : "Conv. rate"}</div><div style="font-weight:700">${fmtPct(v.convRate)}</div></div>${extra}
      </div></div>`;
  }).join("") + `</div>` : `<p class="muted">No funnel data yet for this range — once traffic hits the lander, it shows up here live.</p>`;
  if (!lead) {
    const tiers = ["monthly", "annual", "lifetime"];
    const maxTier = Math.max(1, ...tiers.map((k) => t.tiers[k] || 0));
    $("#funTiers").innerHTML = `<div style="background:#151823;border:1px solid #242838;border-radius:12px;padding:14px 16px;max-width:520px">` +
      tiers.map((k) => funBar(k.charAt(0).toUpperCase() + k.slice(1) + " (" + fmtMoney(d.prices[k]) + ")", t.tiers[k] || 0, maxTier, "#22c55e")).join("") + `</div>`;
  }
}
async function loadSaleReport(m) {
  if ($("#funTierWrap")) $("#funTierWrap").style.display = "none";
  if ($("#funNote")) $("#funNote").style.display = "none";
  if ($("#funVariantsHead")) $("#funVariantsHead").style.display = "none";
  $("#funMsg").textContent = "Loading…";
  const qs = new URLSearchParams();
  if ($("#funFrom").value) qs.set("from", $("#funFrom").value);
  if ($("#funTo").value) qs.set("to", $("#funTo").value);
  let d; try { d = await api("/api/sale-report?" + qs.toString()); } catch { $("#funMsg").textContent = "Couldn't load."; return; }
  $("#funMsg").textContent = d.connected ? "" : "";
  renderSaleReport(d);
}
function renderSaleReport(d) {
  if (!d.connected) {
    $("#funTotals").innerHTML = `<div class="card" style="max-width:560px">Connect your <b>sales ledger</b> (Settings → Sales ledger CSV URL) to see live sale numbers.${d.error ? ` <span class="muted">(${esc(d.error)})</span>` : ""}</div>`;
    $("#funVariants").innerHTML = ""; return;
  }
  const t = d.totals;
  const byId = {}; (d.buckets || []).forEach((b) => (byId[b.id] = b));
  const frontEnd = byId.pp8 || { count: 0, revenue: 0 };   // $2.50 first month
  const upgrade  = byId.pp39 || { count: 0, revenue: 0 };  // $148.50 annual upgrade (OTO)
  const bogo     = byId.pp34 || { count: 0, revenue: 0 };  // $250 BOGO annual
  const oto597   = byId.pp597 || { count: 0, revenue: 0 }; // $597 OTO offer
  const upgradeRate = frontEnd.count ? upgrade.count / frontEnd.count : 0;
  const aov = t.count ? t.revenue / t.count : 0;

  // ---- top metric strip (mirrors the Level 11 totals row) ----
  const cells = [
    funMetric("Sales", fmt(t.count)),
    funMetric("Revenue", fmtMoney(t.revenue)),
    funMetric("AOV", fmtMoney(aov)),
    funMetric("Upgrade rate", fmtPct(upgradeRate)),
  ];
  $("#funTotals").innerHTML =
    `<div style="display:flex;gap:12px;flex-wrap:wrap">${cells.join("")}</div>
     <p class="muted small" style="margin-top:8px"><b>Upgrade rate</b> = $2.50 first-month buyers who took the $148.50 annual upgrade — <b>${fmt(upgrade.count)}</b> of <b>${fmt(frontEnd.count)}</b>.</p>`;

  // ---- Conversions by price point (styled like Conversions-by-tier) ----
  const rows = [
    { label: "$2.50 first month",      count: frontEnd.count, revenue: frontEnd.revenue, color: "#3b82f6" },
    { label: "$148.50 annual upgrade", count: upgrade.count,  revenue: upgrade.revenue,  color: "#a855f7" },
    { label: "$250 BOGO annual",       count: bogo.count,     revenue: bogo.revenue,     color: "#22c55e" },
    { label: "$597 OTO offer",         count: oto597.count,   revenue: oto597.revenue,   color: "#FF7722" },
  ];
  if (d.other && d.other.count) rows.push({ label: "Other CH sales", count: d.other.count, revenue: d.other.revenue, color: "#5f6478" });
  const maxCount = Math.max(1, ...rows.map((r) => r.count));
  const tierBars = rows.map((r) =>
    `<div style="margin-bottom:13px">
       <div style="display:flex;justify-content:space-between;font-size:13.5px;margin-bottom:5px"><span>${esc(r.label)}</span><span><b style="font-size:16px">${fmt(r.count)}</b> <span class="muted">· ${fmtMoney(r.revenue)}</span></span></div>
       <div style="height:9px;border-radius:5px;background:#0e1018;overflow:hidden"><div style="width:${(r.count / maxCount * 100).toFixed(1)}%;height:100%;background:${r.color}"></div></div>
     </div>`).join("");

  // ---- where the money came from (revenue-share bar) ----
  const totalRev = Math.max(1, t.revenue);
  const mixSegs = rows.filter((r) => r.revenue > 0);
  const mixBar = mixSegs.map((s) => `<div title="${esc(s.label)}: ${fmtMoney(s.revenue)}" style="width:${(s.revenue / totalRev * 100).toFixed(1)}%;background:${s.color}"></div>`).join("");
  const legend = mixSegs.map((s) => `<span style="font-size:12px;color:#c9cdd8;white-space:nowrap"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${s.color};margin-right:5px"></span>${esc(s.label)} · ${Math.round(s.revenue / totalRev * 100)}%</span>`).join("");
  const mixBlock = `<h3 style="margin:24px 0 10px">Where the money came from</h3>
     <div style="max-width:660px"><div style="display:flex;height:26px;border-radius:6px;overflow:hidden;background:#0e1018">${mixBar}</div>
     <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:12px">${legend}</div></div>`;

  // ---- by day ----
  let dayBlock = "";
  if (d.byDay && d.byDay.length) {
    const maxDay = Math.max(1, ...d.byDay.map((x) => x.revenue));
    dayBlock = `<h3 style="margin:24px 0 10px">By day</h3><div style="display:flex;flex-direction:column;gap:8px;max-width:660px">${d.byDay.map((x) => `<div style="display:flex;align-items:center;gap:10px">
        <span style="width:92px;font-size:12px;color:#8b93a7">${esc(x.date)}</span>
        <div style="flex:1;height:24px;border-radius:5px;background:#0e1018;position:relative;overflow:hidden"><div style="width:${(x.revenue / maxDay * 100).toFixed(1)}%;height:100%;background:#FF7722;opacity:.85"></div><span style="position:absolute;left:9px;top:4px;font-size:12px;font-weight:600">${fmt(x.count)} sales · ${fmtMoney(x.revenue)}</span></div></div>`).join("")}</div>`;
  }

  // ---- spend vs sales (live Meta spend when a token is set, else your saved number) ----
  const ad = d.adSpend;
  const isLive = ad && ad.source === "meta" && typeof ad.spend === "number";
  const spendVal = ad && typeof ad.spend === "number" ? ad.spend : null;
  const spendCards = (spend) => {
    const roas = spend ? t.revenue / spend : 0;
    const net = t.revenue - spend;
    const cps = t.count ? spend / t.count : 0;
    return [
      funMetric("Ad spend", fmtMoney(spend)),
      funMetric("Sales", fmtMoney(t.revenue)),
      funMetric("ROAS", (roas ? roas.toFixed(2) : "0") + "×"),
      funMetric("Net", (net >= 0 ? "+" : "−") + fmtMoney(Math.abs(net))),
      funMetric("Cost / sale", fmtMoney(cps)),
    ].join("");
  };
  let spendBlock;
  if (isLive) {
    const camp = (ad.campaigns && ad.campaigns[0] && ad.campaigns[0].name) || "campaign";
    const more = ad.campaigns && ad.campaigns.length > 1 ? ` +${ad.campaigns.length - 1} more` : "";
    spendBlock = `<h3 style="margin:24px 0 10px">Spend vs sales <span class="muted" style="font-weight:400;text-transform:none">— live Meta spend vs real ledger sales</span></h3>
       <div style="display:flex;gap:12px;flex-wrap:wrap">${spendCards(ad.spend)}</div>
       <p class="muted small" style="margin-top:8px">Spend is live from Meta (<b>${esc(camp)}</b>${more}). <b>ROAS uses your real Kartra sales</b> — Meta's own ROAS undercounts because its pixel can't see Kartra checkouts.</p>`;
  } else {
    const cur = spendVal != null ? spendVal : "";
    spendBlock = `<h3 style="margin:24px 0 10px">Spend vs sales <span class="muted" style="font-weight:400;text-transform:none">— your ad spend vs real ledger sales</span></h3>
       ${spendVal != null ? `<div style="display:flex;gap:12px;flex-wrap:wrap">${spendCards(spendVal)}</div>` : ""}
       <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-top:${spendVal != null ? "12" : "0"}px">
         <div class="field" style="margin:0;max-width:190px"><span class="lab">Ad spend so far</span><input id="spendInput" type="number" step="0.01" min="0" placeholder="e.g. 1588.27" value="${cur}"></div>
         <button id="spendSave" class="btn btn-primary sm">Save</button>
         <span id="spendMsg" class="muted small"></span>
       </div>
       <p class="muted small" style="margin-top:8px">Type your current ad spend — ROAS, net & cost-per-sale update against your <b>live sales</b>. ${ad && ad.error ? `<span class="muted">(Meta live pull errored: ${esc(ad.error)})</span> ` : ""}Add a Meta token later and this flips to fully automatic.</p>`;
  }

  $("#funVariants").innerHTML =
    spendBlock +
    `<h3 style="margin:24px 0 10px">Conversions by price point <span class="muted" style="font-weight:400;text-transform:none">— what they bought</span></h3>
     <div style="background:#151823;border:1px solid #242838;border-radius:12px;padding:16px 18px;max-width:560px">${tierBars}</div>
     ${mixBlock}
     ${dayBlock}
     <p class="muted small" style="margin-top:18px">The July 4 sale runs on <b>Kartra</b> pages (<b>/home-july4-26 → /oto-july26</b>), so page <b>visitors</b> and <b>checkout clicks</b> aren't captured by our lander pixel — those live in Kartra's own stats. Everything above is real, pulled live from your sales ledger. Price points: <b>$2.50</b> first month → <b>$148.50</b> annual upgrade → <b>$250</b> BOGO annual.</p>`;
  if ($("#spendSave")) $("#spendSave").onclick = async () => {
    const v = parseFloat($("#spendInput").value);
    if (!(v >= 0)) { $("#spendMsg").textContent = "Enter a number."; return; }
    $("#spendMsg").textContent = "Saving…";
    const r = await post("/api/sale-report/spend", { spend: v });
    if (r && r.error) { $("#spendMsg").textContent = r.error; return; }
    loadSaleReport(funMeta());
  };
}
if ($("#funRefresh")) $("#funRefresh").onclick = loadFunnel;
$$(".fun-preset").forEach((b) => b.onclick = () => {
  const days = +b.dataset.days;
  if (days === 0) { $("#funFrom").value = ""; $("#funTo").value = ""; }
  else {
    $("#funFrom").value = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
    $("#funTo").value = new Date().toISOString().slice(0, 10);
  }
  loadFunnel();
});
// ---------- failed payments ----------
const FP_REASON_LABEL = { dead_card: "Dead card", insufficient_funds: "Insufficient funds", declined: "Declined", other: "Other" };
let FP_DATA = null;
async function loadFailedPayments(refresh) {
  if (!$("#fpMsg")) return;
  $("#fpMsg").textContent = refresh ? "Pulling from Stripe…" : "Loading…";
  const days = ($("#fpDays") && $("#fpDays").value) || "30";
  const qs = new URLSearchParams({ days });
  if (refresh) qs.set("refresh", "1");
  let d; try { d = await api("/api/failed-payments?" + qs.toString()); } catch { $("#fpMsg").textContent = "Couldn't load."; return; }
  FP_DATA = d;
  $("#fpMsg").textContent = d.updated ? "Updated " + new Date(d.updated).toLocaleString() : "";
  renderFailedPayments();
}
function renderFailedPayments() {
  const d = FP_DATA; if (!d) return;
  if (!d.configured) {
    $("#fpTotals").innerHTML = `<div class="card" style="max-width:520px">Connect <b>Stripe</b> in Settings to pull failed payments.</div>`;
    $("#fpTable").innerHTML = ""; return;
  }
  if (d.error) $("#fpMsg").textContent = "Stripe error: " + d.error;
  const s = d.summary;
  $("#fpTotals").innerHTML = `<div style="display:flex;gap:12px;flex-wrap:wrap">
    ${funMetric("People failing", fmt(s.people))}${funMetric("Failed attempts", fmt(s.attempts))}
    ${funMetric("$ at risk", fmtMoney(s.atRisk))}${funMetric("Dead-card repeat (3+)", fmt(s.repeat3plus))}
    ${funMetric("Insufficient funds", fmt(s.byReason.insufficient_funds || 0))}</div>`;
  const reasonFilter = ($("#fpReason") && $("#fpReason").value) || "";
  let rows = d.rows || [];
  if (reasonFilter) rows = rows.filter((r) => r.reason === reasonFilter);
  if (!rows.length) { $("#fpTable").innerHTML = `<p class="muted">No failed payments in this window${reasonFilter ? " for that reason" : ""}.</p>`; return; }
  const badge = (r) => {
    const dead = r.attempts >= 3;
    const col = dead ? "#ef4444" : r.reason === "insufficient_funds" ? "#f59e0b" : "#8b93a7";
    const lbl = dead ? "Dead card · " + r.attempts + "×" : (FP_REASON_LABEL[r.reason] || r.reason);
    return `<span style="background:${col}22;color:${col};border:1px solid ${col}55;font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;white-space:nowrap">${lbl}</span>`;
  };
  $("#fpTable").innerHTML = `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="text-align:left;color:#8b93a7;border-bottom:1px solid #242838">
      <th style="padding:8px">Name</th><th style="padding:8px">Email</th><th style="padding:8px">Reason</th>
      <th style="padding:8px;text-align:right">Attempts</th><th style="padding:8px;text-align:right">Amount</th><th style="padding:8px">Last failed</th><th style="padding:8px">Product</th></tr></thead>
    <tbody>${rows.map((r) => `<tr style="border-bottom:1px solid #1c2030">
      <td style="padding:8px;font-weight:600">${esc(r.name || "—")}</td>
      <td style="padding:8px"><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></td>
      <td style="padding:8px">${badge(r)}</td>
      <td style="padding:8px;text-align:right;font-weight:700">${r.attempts}</td>
      <td style="padding:8px;text-align:right">${fmtMoney(r.amount)}</td>
      <td style="padding:8px;color:#8b93a7">${r.lastCreated ? new Date(r.lastCreated * 1000).toLocaleDateString() : "—"}</td>
      <td style="padding:8px;color:#8b93a7">${esc((r.products || []).join(", ") || "—")}</td></tr>`).join("")}</tbody></table></div>`;
}
if ($("#fpRefresh")) $("#fpRefresh").onclick = () => loadFailedPayments(true);
if ($("#fpDays")) $("#fpDays").onchange = () => loadFailedPayments(false);
if ($("#fpReason")) $("#fpReason").onchange = renderFailedPayments;
if ($("#fpExport")) $("#fpExport").onclick = async () => {
  const reason = ($("#fpReason") && $("#fpReason").value) || "";
  const days = ($("#fpDays") && $("#fpDays").value) || "30";
  const nice = reason ? (FP_REASON_LABEL[reason] || reason) : "all failed";
  if (!confirm(`Export the "${nice}" failed-payment list (${days}d) as an audience segment?\nYou can then email it from Compose — nothing sends automatically.`)) return;
  $("#fpMsg").textContent = "Exporting…";
  const r = await post("/api/failed-payments/export", { reason, days: +days });
  if (r.error) { $("#fpMsg").textContent = ""; return toast(r.error, "err"); }
  $("#fpMsg").textContent = "";
  toast(`Exported ${fmt(r.count)} to audience "${r.segment}" — pick it in Compose.`, "ok");
};

// Reason-matched recovery emails. Links default to cratehackers.com — swap the
// CTA href for your Kartra billing/update-card link before sending.
const RECOVERY_TEMPLATES = {
  dead_card: {
    name: "Update-your-card",
    subject: "{{first_name}}, your Crate Hackers card didn't go through 💳",
    html: `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.6;color:#222;max-width:560px;margin:auto">
<p>Hey {{first_name}},</p>
<p>Quick heads-up — the card on file for your Crate Hackers membership didn't go through on the last billing (usually means it expired or got replaced). Nothing dramatic, but we don't want you to lose access to your crates.</p>
<p>Takes about 30 seconds to fix:</p>
<p style="text-align:center;margin:28px 0"><a href="https://cratehackers.com" style="background:#FF7722;color:#fff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:8px;display:inline-block">Update my card →</a></p>
<p>Do it before it lapses and you keep everything — your library, your settings, all of it.</p>
<p>If you meant to cancel, no hard feelings — just ignore this and you're all set.</p>
<p>— Dom, Crate Hackers</p></div>`,
  },
  insufficient_funds: {
    name: "Insufficient-funds downsell",
    subject: "{{first_name}}, let's keep you in — at a lower price",
    html: `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.6;color:#222;max-width:560px;margin:auto">
<p>Hey {{first_name}},</p>
<p>Your last Crate Hackers payment didn't clear. Money's tight for a lot of DJs right now — I get it, and I'd rather keep you than lose you over a few bucks.</p>
<p>So here's a lower rate to stay in and keep your crates:</p>
<p style="text-align:center;margin:28px 0"><a href="https://cratehackers.com" style="background:#FF7722;color:#fff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:8px;display:inline-block">Keep my spot — lower price →</a></p>
<p>No awkwardness, no downgrade in the app — same Crate Hackers, price that fits right now.</p>
<p>— Dom, Crate Hackers</p></div>`,
  },
  other: {
    name: "Generic billing fix",
    subject: "{{first_name}}, quick heads-up on your Crate Hackers billing",
    html: `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.6;color:#222;max-width:560px;margin:auto">
<p>Hey {{first_name}},</p>
<p>Your last Crate Hackers payment hit a snag. Update your billing in about 30 seconds so you don't lose your crates:</p>
<p style="text-align:center;margin:28px 0"><a href="https://cratehackers.com" style="background:#FF7722;color:#fff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:8px;display:inline-block">Fix my billing →</a></p>
<p>Reply to this email if you need a hand — happy to sort it out.</p>
<p>— Dom, Crate Hackers</p></div>`,
  },
};
if ($("#fpRecover")) $("#fpRecover").onclick = async () => {
  const reason = ($("#fpReason") && $("#fpReason").value) || "";
  const days = ($("#fpDays") && $("#fpDays").value) || "30";
  const key = reason === "insufficient_funds" ? "insufficient_funds" : (reason === "dead_card" || reason === "declined") ? "dead_card" : "other";
  const tpl = RECOVERY_TEMPLATES[key];
  const nice = reason ? (FP_REASON_LABEL[reason] || reason) : "all failed";
  if (!confirm(`Build a recovery campaign for "${nice}" (${days}d)?\n\nThis creates the audience and loads the "${tpl.name}" email into Compose. NOTHING sends — you review, set your billing link, and send it yourself.`)) return;
  $("#fpMsg").textContent = "Building…";
  const r = await post("/api/failed-payments/export", { reason, days: +days });
  if (r.error) { $("#fpMsg").textContent = ""; return toast(r.error, "err"); }
  $("#fpMsg").textContent = "";
  if ($("#subject")) $("#subject").value = tpl.subject;
  if ($("#html")) $("#html").value = tpl.html;
  const ct = document.querySelector('.tab[data-tab="compose"]'); if (ct) ct.click();
  toast(`Audience "${r.segment}" (${fmt(r.count)}) + "${tpl.name}" email loaded. Pick the audience, swap in your billing link, review, send.`, "ok");
};

// ---------- ad library ----------
let AD_LIST = [];
async function loadAds() {
  if (!$("#adList")) return;
  const d = await api("/api/ads");
  if ($("#adConfigNote")) $("#adConfigNote").textContent = d.configured ? "" : "⚠ Add your Groq API key in Settings (or Render env) to enable transcription + rewrites.";
  AD_LIST = d.ads || [];
  renderAds();
}
function adCard(a) {
  const beats = (a.structure || []).map((s) => `<li>${esc(s)}</li>`).join("");
  const hooks = (a.ch_hooks || []).map((h) => `<li>${esc(h)}</li>`).join("");
  const ideas = (a.ideas || []).map((h) => `<li>${esc(h)}</li>`).join("");
  return `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;justify-content:space-between;gap:10px">
      <div><b>${esc(a.summary || "(ad)")}</b>${a.sourceUrl ? ` · <a href="${esc(a.sourceUrl)}" target="_blank" rel="noopener" style="color:#FF7722">source ↗</a>` : ""}</div>
      <div style="display:flex;gap:6px;flex-shrink:0"><button class="btn btn-ghost sm ad-brief" data-id="${esc(a.id)}">✉ Brief</button><button class="btn btn-ghost sm ad-del" data-id="${esc(a.id)}">✕</button></div>
    </div>
    ${a.hook ? `<p class="muted small" style="margin:6px 0 0">Hook: ${esc(a.hook)}</p>` : ""}
    ${a.why_it_works ? `<p style="margin:10px 0 0;font-size:13px"><b>Why it works:</b> ${esc(a.why_it_works)}</p>` : ""}
    ${beats ? `<details style="margin-top:8px"><summary class="muted small">Structure</summary><ol style="margin:6px 0 0 18px;font-size:13px">${beats}</ol></details>` : ""}
    ${a.transcript ? `<details style="margin-top:8px"><summary class="muted small">Original transcript / script</summary><pre style="white-space:pre-wrap;font:inherit;font-size:12.5px;margin:6px 0 0;color:#aeb6cc;max-height:280px;overflow:auto;background:#0e1018;border:1px solid #242838;border-radius:8px;padding:10px">${esc((a.transcript || "").trim())}</pre></details>` : ""}
    <div style="margin-top:12px;background:#0e1018;border:1px solid #242838;border-radius:10px;padding:12px">
      <div style="display:flex;justify-content:space-between;align-items:center"><span style="font-weight:700;color:#FF7722">Crate Hackers script</span><button class="btn btn-ghost sm ad-copy" data-id="${esc(a.id)}">Copy</button></div>
      <pre style="white-space:pre-wrap;font:inherit;font-size:13px;margin:8px 0 0">${esc((a.ch_script || "").trim())}</pre>
    </div>
    ${hooks ? `<details style="margin-top:8px"><summary class="muted small">Alt hooks</summary><ul style="margin:6px 0 0 18px;font-size:13px">${hooks}</ul></details>` : ""}
    ${ideas ? `<div style="margin-top:12px"><div class="muted small" style="margin-bottom:4px">Ways to model this for Crate Hackers</div><ul style="margin:0 0 0 18px;font-size:13px">${ideas}</ul></div>` : ""}
    <div class="brief-box hidden" id="brief-${esc(a.id)}" style="margin-top:12px;border-top:1px solid #242838;padding-top:12px"></div>
  </div>`;
}
function renderAds() {
  if (!AD_LIST.length) { $("#adList").innerHTML = `<p class="muted">No ads yet. Add one on the left — the AI breaks it down and writes your Crate Hackers version.</p>`; return; }
  $("#adList").innerHTML = AD_LIST.map(adCard).join("");
  $$(".ad-del").forEach((b) => b.onclick = async () => { if (!confirm("Delete this ad?")) return; await fetch("/api/ads/" + b.dataset.id, { method: "DELETE" }); AD_LIST = AD_LIST.filter((a) => a.id !== b.dataset.id); renderAds(); });
  $$(".ad-copy").forEach((b) => b.onclick = () => { const a = AD_LIST.find((x) => x.id === b.dataset.id); if (a) { navigator.clipboard.writeText(a.ch_script || ""); toast("Script copied.", "ok"); } });
  $$(".ad-brief").forEach((b) => b.onclick = () => { const a = AD_LIST.find((x) => x.id === b.dataset.id); if (a) toggleBrief(a); });
}

// ---------- influencer briefs ----------
let INFLUENCERS = [];
async function loadInfluencers() {
  const d = await api("/api/influencers");
  INFLUENCERS = (d && d.influencers) || [];
  const dl = $("#influencerList");
  if (dl) dl.innerHTML = INFLUENCERS.map((i) => `<option value="${esc(i.email)}">${esc(i.name || i.instagram || "")}${i.ltv ? " · $" + fmt(Math.round(i.ltv)) : ""}</option>`).join("");
  if ($("#inflCount")) $("#inflCount").textContent = "Influencers: " + INFLUENCERS.length + (INFLUENCERS.length ? "" : " — import your CSV →");
}
if ($("#inflFile")) $("#inflFile").onchange = async () => {
  const f = $("#inflFile").files && $("#inflFile").files[0]; if (!f) return;
  $("#inflMsg").textContent = "Importing…";
  try {
    const csv = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error("read")); fr.readAsText(f); });
    const r = await post("/api/influencers/import", { csv });
    if (r.error) { $("#inflMsg").textContent = "⚠ " + r.error; return; }
    $("#inflMsg").textContent = r.count + " imported ✓"; await loadInfluencers();
  } catch { $("#inflMsg").textContent = "Couldn't read that file."; }
  $("#inflFile").value = "";
};
function briefBody(a, note) {
  const ideas = (a.ideas && a.ideas.length ? a.ideas : (a.ch_hooks || []));
  const ideaLis = ideas.map((x) => `<li>${esc(x)}</li>`).join("") || "<li>(re-analyze this ad to generate modeling ideas)</li>";
  return `<p>Hey {{name}},</p>
${note ? `<p>${esc(note)}</p>` : ""}
<p>We spotted an ad we think you'd crush for <b>Crate Hackers</b> — wanted to send it your way to model. 🎧</p>
<p><b>The ad to model:</b> ${a.sourceUrl ? `<a href="${esc(a.sourceUrl)}">${esc(a.sourceUrl)}</a>` : "(link)"}</p>
${a.summary ? `<p><b>What it is:</b> ${esc(a.summary)}</p>` : ""}
<p><b>Original transcript:</b></p>
<blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#555;white-space:pre-wrap">${esc((a.transcript || "").trim())}</blockquote>
<p><b>3–5 ways to turn it into a Crate Hackers ad:</b></p>
<ol>${ideaLis}</ol>
<p>If you're in, just reply — we'll send everything you need. 🙌</p>
<p>— The Crate Hackers team</p>`;
}
function toggleBrief(a) {
  const box = $("#brief-" + a.id);
  if (!box) return;
  if (!box.classList.contains("hidden")) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  box.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <div class="field" style="margin:0;flex:1;min-width:190px"><span class="lab">Send to (email)</span><input class="bf-to" list="influencerList" type="email" placeholder="pick or type an email"></div>
      <div class="field" style="margin:0;flex:1;min-width:130px"><span class="lab">Name</span><input class="bf-name" type="text" placeholder="first name"></div>
    </div>
    <div class="field" style="margin:8px 0 0"><span class="lab">Subject</span><input class="bf-subj" type="text" value="Content idea for you 🎧 — model this for Crate Hackers"></div>
    <div class="field" style="margin:8px 0 0"><span class="lab">Personal line <span class="muted">(optional)</span></span><input class="bf-note" type="text" placeholder="e.g. loved your last reel — this is right up your alley"></div>
    <details style="margin:8px 0 0"><summary class="muted small">Preview the brief</summary><div class="bf-preview" style="background:#fff;color:#111;border-radius:8px;padding:12px;margin-top:6px;font-size:13px;max-height:340px;overflow:auto"></div></details>
    <div style="display:flex;gap:8px;align-items:center;margin-top:10px"><button class="btn btn-primary sm bf-send">Send brief →</button><span class="bf-msg muted small"></span></div>`;
  const toI = box.querySelector(".bf-to"), nameI = box.querySelector(".bf-name"), subjI = box.querySelector(".bf-subj"), noteI = box.querySelector(".bf-note"), prev = box.querySelector(".bf-preview"), msg = box.querySelector(".bf-msg");
  const refresh = () => { prev.innerHTML = briefBody(a, noteI.value.trim()).replace(/\{\{name\}\}/g, nameI.value.trim() || "there"); };
  refresh(); noteI.oninput = refresh; nameI.oninput = refresh;
  toI.oninput = () => { const m = INFLUENCERS.find((i) => i.email.toLowerCase() === toI.value.trim().toLowerCase()); if (m && !nameI.value) { nameI.value = (m.name || "").split(" ")[0]; refresh(); } };
  box.querySelector(".bf-send").onclick = async () => {
    const to = toI.value.trim(); if (!to) { msg.textContent = "Enter a recipient email."; msg.style.color = "#ef6a6a"; return; }
    const html = briefBody(a, noteI.value.trim()).replace(/\{\{name\}\}/g, nameI.value.trim() || "there");
    msg.style.color = ""; msg.textContent = "Sending…";
    const r = await post("/api/ads/brief", { adId: a.id, to, toName: nameI.value.trim(), subject: subjI.value.trim(), html });
    if (r.error) { msg.style.color = "#ef6a6a"; msg.textContent = "⚠ " + r.error; return; }
    msg.style.color = "#4ea36a"; msg.textContent = "✅ Sent to " + to; toast("Brief sent to " + to, "ok");
  };
}
if ($("#adAdd")) $("#adAdd").onclick = async () => {
  const file = $("#adFile") && $("#adFile").files && $("#adFile").files[0];
  const body = { sourceUrl: $("#adSourceUrl").value.trim(), mediaUrl: $("#adMediaUrl").value.trim(), transcript: $("#adTranscript").value.trim(), notes: $("#adNotes").value.trim() };
  if (!body.transcript && !body.mediaUrl && !file) return toast("Paste a transcript/caption, upload a video, or add a media URL.", "err");
  if (file && file.size > 24 * 1024 * 1024) return toast("That video is over 24MB — trim it, or use the desktop Ad Clipper, or paste the transcript.", "err");
  const setMsg = (t, err) => { const m = $("#adMsg"); if (m) { m.textContent = t; m.style.color = err ? "#ef6a6a" : ""; } };
  $("#adAdd").disabled = true;
  setMsg((file || (body.mediaUrl && !body.transcript)) ? "Transcribing + analyzing… (uploads can take up to a minute)" : "Analyzing…");
  try {
    if (file) {
      body.fileName = file.name;
      body.fileBase64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error("couldn't read that file")); fr.readAsDataURL(file); });
    }
    const r = await post("/api/ads", body);
    if (r.error) { setMsg("⚠ " + r.error, true); toast(r.error, "err"); return; }
    if (!r.ad) { setMsg("⚠ No result came back — please try again.", true); return; }
    AD_LIST.unshift(r.ad); renderAds();
    $("#adSourceUrl").value = $("#adMediaUrl").value = $("#adTranscript").value = $("#adNotes").value = "";
    if ($("#adFile")) $("#adFile").value = "";
    setMsg(""); toast("Ad analyzed + Crate Hackers script ready.", "ok");
  } catch (e) {
    setMsg("⚠ Couldn't process that — " + ((e && e.message) || "unknown error") + ". Try a smaller file or paste the transcript.", true);
  } finally {
    $("#adAdd").disabled = false;
  }
};

// opener message: persist per browser, default to a friendly intro
const OUTREACH_MSG_KEY = "ch_outreachOpener";
if ($("#outreachMsg")) {
  $("#outreachMsg").value = localStorage.getItem(OUTREACH_MSG_KEY) ||
    "Hey {{first_name}}, it's Dom from Crate Hackers — this is my direct line. Got a sec for a quick call this week? Happy to text instead if that's easier.";
  $("#outreachMsg").oninput = () => { try { localStorage.setItem(OUTREACH_MSG_KEY, $("#outreachMsg").value); } catch {} };
}
if ($("#outreachInsertName")) $("#outreachInsertName").onclick = () => {
  const t = $("#outreachMsg");
  const s = t.selectionStart ?? t.value.length, e = t.selectionEnd ?? t.value.length;
  const token = "{{first_name}}";
  t.value = t.value.slice(0, s) + token + t.value.slice(e);
  try { localStorage.setItem(OUTREACH_MSG_KEY, t.value); } catch {}
  const pos = s + token.length;
  t.focus(); t.setSelectionRange(pos, pos);
};

// ---------- boot ----------
(async function init() {
  await refreshConn();
  await loadAudienceOptions();
  const s = await api("/api/settings");
  $("#testEmail").value = s.testEmail || "";
  // default analytics range: last 30 days
  const today = new Date(), ago = new Date(Date.now() - 30 * 86400000);
  $("#anTo").value = today.toISOString().slice(0, 10);
  $("#anFrom").value = ago.toISOString().slice(0, 10);
  loadUpcoming();
  loadDrafts();
  // reattach to an in-progress send if the page was reloaded
  try {
    const aj = JSON.parse(localStorage.getItem("ch_activeJob") || "null");
    if (aj && aj.id) {
      const j = await api("/api/send/status/" + aj.id);
      if (j && !j.error && !j.done) {
        if (aj.kind === "sms") { $("#smsProgress") && $("#smsProgress").classList.remove("hidden"); smsPoll(aj.id, aj.total); }
        else { $("#sendProgress") && $("#sendProgress").classList.remove("hidden"); pollJob(aj.id, aj.total); }
        toast("Reattached to a send already in progress…", "ok");
      } else { clearJob(); }
    }
  } catch {}
})();

// ---------- signed-in indicator (only shows when cloud Google auth is on) ----------
(async function () {
  try {
    const r = await fetch("/api/me");
    if (!r.ok) return;
    const me = await r.json();
    if (!me || !me.authEnabled || !me.email) return;
    const pill = document.createElement("div");
    pill.style.cssText =
      "position:fixed;right:14px;bottom:12px;z-index:9999;display:flex;gap:10px;align-items:center;" +
      "padding:7px 12px;background:rgba(20,23,34,.92);border:1px solid #2a2f42;border-radius:999px;" +
      "font:12px -apple-system,Segoe UI,Roboto,sans-serif;color:#aeb6cc;box-shadow:0 6px 20px rgba(0,0,0,.35)";
    const who = document.createElement("span");
    who.textContent = me.email;
    const out = document.createElement("a");
    out.href = "/auth/logout";
    out.textContent = "Log out";
    out.style.cssText = "color:#8fb4ff;text-decoration:none;font-weight:600";
    pill.appendChild(who);
    pill.appendChild(out);
    document.body.appendChild(pill);
  } catch {}
})();
