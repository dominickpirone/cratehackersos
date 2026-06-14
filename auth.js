/**
 * auth.js — Google sign-in gate for the Email Console
 * ===================================================
 * Zero-dependency Google OAuth 2.0 (authorization-code flow) that restricts
 * access to a single email domain (default: cratehackers.com).
 *
 * Enabled only when these env vars are present:
 *   GOOGLE_CLIENT_ID       OAuth client ID  (Google Cloud console)
 *   GOOGLE_CLIENT_SECRET   OAuth client secret
 *   SESSION_SECRET         random string used to sign session cookies
 * Optional:
 *   ALLOWED_DOMAIN         email domain allowed in (default cratehackers.com)
 *   OAUTH_BASE_URL         public https base URL, e.g. https://app.onrender.com
 *                          (Render sets RENDER_EXTERNAL_URL automatically)
 *
 * When the vars are absent (i.e. running locally) auth is OFF and the app
 * behaves exactly as before — so Dom's laptop workflow is untouched.
 */

const crypto = require("crypto");

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || "cratehackers.com").toLowerCase();
const OAUTH_BASE_URL = (process.env.OAUTH_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const enabled = !!(CLIENT_ID && CLIENT_SECRET && SESSION_SECRET);

// ---------- tiny base64url + signing ----------
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
function hmac(data) {
  return b64url(crypto.createHmac("sha256", SESSION_SECRET).update(data).digest());
}
function sign(obj) {
  const body = b64url(JSON.stringify(obj));
  return body + "." + hmac(body);
}
function verify(token) {
  if (!token || token.indexOf(".") < 0) return null;
  const [body, sig] = token.split(".");
  // constant-time compare
  const a = Buffer.from(hmac(body));
  const b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(fromB64url(body));
    if (obj.exp && Date.now() > obj.exp) return null;
    return obj;
  } catch { return null; }
}
function decodeJwt(t) {
  try {
    const parts = String(t).split(".");
    if (parts.length < 2) return null;
    return JSON.parse(fromB64url(parts[1]));
  } catch { return null; }
}

// ---------- cookies / urls ----------
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function isHttps(req) {
  return (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https" ||
    OAUTH_BASE_URL.startsWith("https://");
}
function appendSetCookie(res, c) {
  const prev = res.getHeader("Set-Cookie");
  if (!prev) res.setHeader("Set-Cookie", [c]);
  else res.setHeader("Set-Cookie", Array.isArray(prev) ? prev.concat(c) : [prev, c]);
}
function setCookie(res, req, name, value, { maxAgeMs, clear } = {}) {
  const parts = [`${name}=${clear ? "" : encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (isHttps(req)) parts.push("Secure");
  if (clear) parts.push("Max-Age=0");
  else if (maxAgeMs) parts.push("Max-Age=" + Math.floor(maxAgeMs / 1000));
  appendSetCookie(res, parts.join("; "));
}
function baseUrl(req) {
  if (OAUTH_BASE_URL) return OAUTH_BASE_URL;
  const proto = isHttps(req) ? "https" : "http";
  return `${proto}://${req.headers.host}`;
}
function redirectUri(req) { return baseUrl(req) + "/auth/callback"; }
function redirect(res, location) { res.writeHead(302, { Location: location }); res.end(); }

// ---------- pages ----------
function page(res, code, title, bodyHtml) {
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Crate Hackers Email Console</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    background:#0b0d12;color:#e6e8ee}
  .card{width:100%;max-width:420px;padding:40px 36px;background:#151823;border:1px solid #242838;
    border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.45);text-align:center}
  h1{margin:0 0 6px;font-size:20px}
  p{margin:8px 0 0;color:#9aa3b8;font-size:14px}
  .brand{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#7681a0;margin-bottom:22px}
  .btn{display:inline-flex;align-items:center;gap:10px;margin-top:24px;padding:12px 20px;
    background:#fff;color:#1f2330;font-weight:600;text-decoration:none;border-radius:10px;font-size:15px}
  .btn:hover{background:#eef0f6}
  .muted{margin-top:20px;font-size:12px;color:#5f6883}
  .g{width:18px;height:18px;display:inline-block;vertical-align:middle}
</style></head>
<body><div class="card">
<div class="brand">Crate Hackers</div>
${bodyHtml}
</div></body></html>`;
  res.writeHead(code, { "Content-Type": "text/html" });
  res.end(html);
}
const GOOGLE_G = `<svg class="g" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.6 2.4 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.3 13.2 17.6 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.5 3-2.2 5.5-4.7 7.2l7.3 5.7c4.3-4 6.8-9.9 6.8-17.4z"/><path fill="#FBBC05" d="M10.5 28.3c-.5-1.4-.7-2.9-.7-4.3s.3-2.9.7-4.3l-7.9-6.1C1 16.7 0 20.2 0 24s1 7.3 2.6 10.4l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.3-5.7c-2 1.4-4.7 2.3-8.6 2.3-6.4 0-11.7-3.7-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>`;

function loginPage(res, returnTo) {
  const r = returnTo && returnTo.startsWith("/") ? returnTo : "/";
  page(res, 200, "Sign in",
    `<h1>Email Console</h1>
     <p>Sign in with your Crate Hackers Google account to continue.</p>
     <a class="btn" href="/auth/google?return=${encodeURIComponent(r)}">${GOOGLE_G}<span>Sign in with Google</span></a>
     <div class="muted">Restricted to @${ALLOWED_DOMAIN} accounts.</div>`);
}

// ---------- OAuth route handler ----------
async function handleAuthRoute(req, res, u) {
  const p = u.pathname;

  if (!enabled) { return redirect(res, "/"); }

  if (p === "/auth/login") {
    return loginPage(res, u.searchParams.get("return") || "/");
  }

  if (p === "/auth/logout") {
    setCookie(res, req, "chsess", "", { clear: true });
    return loginPage(res, "/");
  }

  if (p === "/auth/google") {
    const state = b64url(crypto.randomBytes(16));
    const ret = u.searchParams.get("return") || "/";
    setCookie(res, req, "chstate", sign({ state, ret, exp: Date.now() + 10 * 60 * 1000 }), { maxAgeMs: 10 * 60 * 1000 });
    const a = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    a.searchParams.set("client_id", CLIENT_ID);
    a.searchParams.set("redirect_uri", redirectUri(req));
    a.searchParams.set("response_type", "code");
    a.searchParams.set("scope", "openid email profile");
    a.searchParams.set("hd", ALLOWED_DOMAIN);
    a.searchParams.set("state", state);
    a.searchParams.set("prompt", "select_account");
    return redirect(res, a.toString());
  }

  if (p === "/auth/callback") {
    const code = u.searchParams.get("code");
    const state = u.searchParams.get("state");
    const st = verify(parseCookies(req).chstate);
    setCookie(res, req, "chstate", "", { clear: true });
    if (!code || !st || st.state !== state) {
      return page(res, 400, "Sign-in error",
        `<h1>Sign-in expired</h1><p>That sign-in link expired or didn't match. Please try again.</p>
         <a class="btn" href="/auth/login">Try again</a>`);
    }
    let tok;
    try {
      const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
          redirect_uri: redirectUri(req), grant_type: "authorization_code",
        }),
      });
      tok = await r.json();
    } catch {
      return page(res, 502, "Sign-in error",
        `<h1>Couldn't reach Google</h1><p>Network hiccup talking to Google. Please try again.</p>
         <a class="btn" href="/auth/login">Try again</a>`);
    }
    const claims = tok && tok.id_token ? decodeJwt(tok.id_token) : null;
    // The id_token came directly from Google's token endpoint over TLS, so we
    // validate its claims but don't need to re-verify the signature (per Google's docs).
    const issOk = claims && (claims.iss === "accounts.google.com" || claims.iss === "https://accounts.google.com");
    const audOk = claims && claims.aud === CLIENT_ID;
    const expOk = claims && claims.exp && claims.exp * 1000 > Date.now();
    if (!claims || !issOk || !audOk || !expOk) {
      return page(res, 400, "Sign-in error",
        `<h1>Sign-in failed</h1><p>We couldn't validate your Google sign-in. Please try again.</p>
         <a class="btn" href="/auth/login">Try again</a>`);
    }
    const email = (claims.email || "").toLowerCase();
    const domainOk = claims.email_verified && email.endsWith("@" + ALLOWED_DOMAIN) &&
      (!claims.hd || String(claims.hd).toLowerCase() === ALLOWED_DOMAIN);
    if (!domainOk) {
      return page(res, 403, "Access restricted",
        `<h1>Access restricted</h1>
         <p>This console is limited to <b>@${ALLOWED_DOMAIN}</b> accounts.
         You signed in as ${email ? "<b>" + email + "</b>" : "an outside account"}.</p>
         <a class="btn" href="/auth/login">Use a different account</a>`);
    }
    setCookie(res, req, "chsess", sign({ email, name: claims.name || email, exp: Date.now() + SESSION_TTL_MS }), { maxAgeMs: SESSION_TTL_MS });
    return redirect(res, st.ret && st.ret.startsWith("/") ? st.ret : "/");
  }

  return redirect(res, "/auth/login");
}

// ---------- gate used by server.js ----------
// Returns the signed-in user, or null (in which case it has already responded
// with a redirect-to-login or a 401 for API calls).
function requireUser(req, res, { isApi } = {}) {
  if (!enabled) return { email: "local@localhost", name: "Local", local: true };
  const sess = verify(parseCookies(req).chsess);
  if (sess && sess.email) return sess;
  if (isApi) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "auth required", login: "/auth/login" }));
    return null;
  }
  redirect(res, "/auth/login?return=" + encodeURIComponent(req.url || "/"));
  return null;
}

module.exports = {
  enabled,
  allowedDomain: ALLOWED_DOMAIN,
  handleAuthRoute,
  requireUser,
  redirectUriHint: (host) => (OAUTH_BASE_URL || `https://${host || "<your-app>.onrender.com"}`) + "/auth/callback",
};
