---
name: onboard-hub
description: Put a client hub behind Cloudflare Access and lock its tracker key so only that client's email domain (and Sabel) can open it. Use when asked to "onboard <client> hub", "lock <client>'s tracker", "put <client> behind Access", "rotate <client>'s hub token", or when a new client hub is being published. Runs scripts/onboard-hub.mjs locally or the "Onboard a client hub" GitHub Action.
---

# Onboard a client hub

One command per client. Everything else (Zero Trust, Pages, the token function) is already set up and never repeats.

## What you need from the person

1. **Client slug**: lower-case, dashes, matches the tracker key `<slug>-tracker-v1` (e.g. `cookaborough`).
2. **Hub file**: the HTML file in this repo (e.g. `CookaboroughTracker.html`).
3. **Client email domain(s)**: what their staff addresses end in (e.g. `cookaborough.com`). Several: comma separated. Ask if unsure; never guess from the company name.

## Before running

- The key must already be in `ALLOWED_KEYS` in `sabel-webhook/api/tracker.js` and deployed. The script stops with a clear message if not.
- The hub file must be on `main` and already published at `https://hubs.sabelcustomersuccess.com/<HubFile>`.

## Run it

**From GitHub, no setup (preferred for Nikki):**
Actions > "Onboard a client hub" > Run workflow. Fill slug, hub file, email domains. Tick "dry run" first if nervous; read the log; run again without it.

**Locally** (needs three env vars in the shell, from 1Password / Vercel):
```
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... KICKOFF_TEAM_TOKEN=... \
node scripts/onboard-hub.mjs <slug> <HubFile.html> <domain> [--dry-run] [--rotate]
```

Never paste the API token, the team passcode or the client token into chat.

## After it runs

1. If the log says the hub-auth include was inserted (local run) or is missing (GitHub run), make sure this line is in the hub's `<head>` on `main`:
   `<script src="hub-auth.js" data-client="<slug>"></script>`
   Commit and push; Pages redeploys in about a minute.
2. Open `https://hubs.sabelcustomersuccess.com/<HubFile without .html>` in a private window: Cloudflare sign-in page, email code, hub loads with live data.
3. Open the old `https://sabel-intercom.github.io/Intake-forms/<HubFile>`: it forwards to the new link.
4. Send the client the new link. Wording that works:
   > Your hub has moved to https://hubs.sabelcustomersuccess.com/<HubFile without .html>. Open it, enter your work email, and type the code we email you. Your browser stays signed in after that.

## Rotating a token

Run again with `--rotate` (or tick "rotate" in the Action). The old token stops the moment the new one lands; the hub picks up the new one on next load, nothing to send the client.

## If something fails

| Message | Fix |
|---|---|
| `not in ALLOWED_KEYS` | Add the key to `sabel-webhook/api/tracker.js`, deploy, re-run |
| `KICKOFF_TEAM_TOKEN was refused` | Value differs from Vercel's; copy it again (watch for trailing spaces) |
| `Access API ... 403` | The Cloudflare token lacks Access: Apps and Policies: Edit |
| `pages/projects ... 403` | The token lacks Cloudflare Pages: Edit |
| Hub shows "cannot reach its saved data (401)" | Pages variables not deployed yet, or the include is missing from the hub file |
| Sign-in page says "not authorised" | Their email domain is not in the policy; re-run with the right domain(s) |

## What it does (for the curious)

1. Checks sabel-webhook knows the key.
2. Creates or updates the Access application "<Client> hub" with three destinations (hub, hub.html, api/hub-token/<slug>) and one Allow policy: emails ending in the client domain(s) plus @sabelcustomersuccess.com. Reads its AUD.
3. Locks the key via `/api/tracker-lock` (keeps an existing lock unless `--rotate`).
4. Sets `HUB_TOKEN_<SLUG>` (secret) and `HUB_AUD_<SLUG>` on the `sabel-hubs` Pages project and starts a deployment.
5. Adds the hub-auth include to the hub file if missing.

Related: `hub-auth.js` (the include), `functions/api/hub-token/[client].js` (hands the token to signed-in visitors), `sabel-webhook/api/tracker-lock.js` (the lock).
