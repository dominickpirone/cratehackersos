# Deploying the Email Console to the cloud (Render + Google sign-in)

This puts the console online for the team, behind a **Sign in with Google** gate
that only admits **@cratehackers.com** accounts. Secrets live in Render's
environment (never in GitHub); customer data lives on a Render persistent disk.

Three things to do, roughly 30–40 minutes total. Steps marked **(Claude)** I can
do for you from here; **(you)** need your accounts.

---

## 1. GitHub — private repo  **(Claude, with your OK)**

- Repo is created **private** under your account.
- `.gitignore` already excludes `config.local.json`, `.env`, and the whole
  `data/` folder — so **no secrets and no customer PII ever reach GitHub.**
- I'll show you the exact file list before anything is pushed.

## 2. Google sign-in credentials  **(you — ~10 min)**

1. Go to **console.cloud.google.com** → create a project (e.g. "Email Console")
   or reuse an existing Crate Hackers project.
2. **APIs & Services → OAuth consent screen** → choose **Internal** (this alone
   restricts sign-in to your Workspace, i.e. @cratehackers.com) → fill app name
   + support email → Save.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   Application type **Web application**.
4. Under **Authorized redirect URIs**, add your Render URL + `/auth/callback`.
   You'll get the Render URL in step 3 — come back and paste it here. It looks
   like: `https://crate-hackers-email-console.onrender.com/auth/callback`
5. Copy the **Client ID** and **Client secret** — you'll paste them into Render.

> Note: "Internal" consent + our server-side check on the email domain are two
> independent locks. Even if someone got the link, they can't get in without a
> verified @cratehackers.com Google account.

## 3. Render — host it  **(you + Claude — ~15 min)**

1. Sign in at **render.com** with GitHub, authorize access to the repo.
2. **New + → Blueprint** → pick this repo. Render reads `render.yaml` and sets up
   a web service with a **1 GB persistent disk** mounted at `/data`.
   (Plan is **Starter, ~$7/mo** — required for the disk that keeps your data.)
3. It will ask you to fill the **secret** env vars (everything marked "sync:false"
   in `render.yaml`). Paste the values from your current `config.local.json`,
   plus the Google **Client ID** / **Client secret** from step 2. `SESSION_SECRET`
   is auto-generated. Reference list of keys is in `.env.example`.
4. Deploy. When it's live, copy the service URL (e.g.
   `https://crate-hackers-email-console.onrender.com`) and:
   - paste `<that URL>/auth/callback` into the Google redirect URIs (step 2.4),
   - the deploy log prints the exact redirect URI it expects — they must match.

## 4. Move your existing data onto the server  **(you + Claude)**

Your segments (the ~6,300-member list), phone↔email map, and send history are
on your laptop in `data/`, which we deliberately keep out of git. To get them
onto the Render disk, easiest path:

- Re-upload each audience via the **Audiences** tab (and SMS segments tab) once
  the cloud app is up — the files write straight to the persistent disk; **or**
- I can give you a one-time upload script / use Render's shell to copy them up.

Campaign history (`campaigns.json`) is optional to migrate — analytics will
rebuild going forward.

---

## How the team uses it afterward
Everyone just visits the Render URL, clicks **Sign in with Google**, and they're
in (if their email is @cratehackers.com). No passwords, no shared token.

## Rotating a key later
Change it in **Render → Environment**, then redeploy. One caveat: if you ever
*saved settings from the cloud UI*, the value also got written to
`/data/config.local.json` on the disk, which takes precedence over the env var —
update it there too (or clear that file) if a rotation doesn't seem to take.
