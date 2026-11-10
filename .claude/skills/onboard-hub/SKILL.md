---
name: onboard-hub
description: Publish a client hub or project tracker so only that client's email domain (and Sabel) can open it, and hand back the link to send. Use when asked to "publish the <client> tracker", "give <client> access to their tracker", "onboard <client> hub", "lock <client>'s tracker", "put <client> behind sign-in", "rotate <client>'s hub token", or straight after a new tracker file has been pushed to this repo. Runs the "Onboard a client hub" GitHub Action through gh; no secrets on the person's machine.
---

# Publish a client hub behind sign-in

One request per client. The person says something like "publish the Acme tracker for @acme.com" and you do everything below, in order, and finish with the link and the message to send.

The whole site `hubs.sabelcustomersuccess.com` is Sabel-staff-only by default. A client can open a page only after this has run for them.

## 1. Collect three things

1. **Client slug**: lower-case, dashes. The tracker key is `<slug>-tracker-v1` (e.g. `acme`).
2. **Hub file**: the HTML file name in this repo (e.g. `AcmeTracker_v2.html`).
3. **Client email domain(s)**: what their staff addresses end in (e.g. `acme.com`). Several: comma separated. **Ask; never guess from the company name.** Domains only, no single addresses.

Optional, when the client has more than a hub:

- **Their other pages** (`also`): the client's own intake or kick-off form, e.g. `SabelMigrationIntake_Acme.html`. Not the shared forms (`SabelReadinessCheck.html`, `SabelKickoff.html`, `SabelMigrationIntake.html`): those serve several clients and are not handled yet.
- **Their other keys** (`keys`): e.g. `migration-intake-acme-v1`. Locked with the same client token.

## 2. Check before running (stop and say what is missing)

```
gh auth status
gh api repos/Sabel-Intercom/Intake-forms/contents/<HubFile> --jq .name
curl -s https://raw.githubusercontent.com/Sabel-Intercom/sabel-webhook/main/api/tracker.js | grep -c "'<slug>-tracker-v1'"
```

- `gh` not signed in, or no write access to `Sabel-Intercom/Intake-forms`: stop, tell the person.
- Hub file not on `main`: it must be pushed first (the tracker skill does this).
- Key count is 0: the key is not in `ALLOWED_KEYS` in `sabel-webhook/api/tracker.js`. It must be added and deployed first (the tracker skill does this).

## 3. Run it

```
gh workflow run onboard-hub.yml -R Sabel-Intercom/Intake-forms \
  -f slug=<slug> -f hub_file=<HubFile> -f email_domains=<domain[,domain2]>
```

Add `-f also=<Page.html>` and `-f keys=<key-v1>` when given. Add `-f dry_run=true` if the person wants to see it first.

Then wait for it and read the result:

```
sleep 5
gh run list -R Sabel-Intercom/Intake-forms --workflow onboard-hub.yml --limit 1 --json databaseId,status,conclusion
gh run watch <databaseId> -R Sabel-Intercom/Intake-forms --exit-status
gh run view <databaseId> -R Sabel-Intercom/Intake-forms --log | grep -E "\[[0-9]\]|✖|policy:|inserted|already|Done"
```

The Action adds the one include line to the hub file and commits it to `main` by itself. Nothing for the person to edit.

## 4. Verify (about a minute after the run, while Pages redeploys)

```
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://hubs.sabelcustomersuccess.com/<HubFile without .html>
gh api repos/Sabel-Intercom/Intake-forms/contents/<HubFile> --jq .content | base64 -d | grep -c 'hub-auth.js" data-client="<slug>"'
```

Expect `302` to a `cloudflareaccess.com` login address, and an include count of `1`. Anything else: report it, do not send the link.

You cannot test the signed-in view yourself. Ask the person to open the link once and confirm live data shows.

## 5. Hand back

The link: `https://hubs.sabelcustomersuccess.com/<HubFile without .html>`

A message for the client:

> Your project hub is at https://hubs.sabelcustomersuccess.com/<HubFile without .html>. Open it, enter your work email, and type the code we email you. Your browser stays signed in for 24 hours. Only addresses at <domain> can open it.

If the client had an old `github.io` link, it now forwards to the new one.

## Rules

- Never paste or print the Cloudflare API token, the team passcode or a client token. The Action never prints them either.
- Never run "Lock down the hubs domain" from this skill. That one is Richard's.
- One onboarding at a time; the Action queues a second run behind the first.

## Other jobs

- **Rotate a client's token**: same command plus `-f rotate=true`. Nothing to send the client.
- **Add a second email domain**: run again with both domains, comma separated. The rule is replaced, not added to.
- **Run locally** (Richard only; needs the three secrets in the shell): `node scripts/onboard-hub.mjs <slug> <HubFile.html> <domain> [--also "Form.html"] [--keys "key-v1"] [--dry-run] [--rotate]`, then commit and push the hub file.

## If something fails

| Message | Fix |
|---|---|
| `not in ALLOWED_KEYS` | Add the key to `sabel-webhook/api/tracker.js`, deploy, re-run |
| `KICKOFF_TEAM_TOKEN was refused` | Repository secret differs from Vercel's value. Richard fixes it |
| `Access API ... 403` or `pages/projects ... 403` | The Cloudflare token lacks a permission. Richard fixes it |
| `already carries a different hub-auth include` | The file is wired to another client. Fix the line by hand, re-run |
| `Expected exactly one added line per file` | The file changed in an unexpected way. Nothing was committed; ask Richard |
| Push to `main` refused | Someone pushed at the same moment. Re-run; every step is safe to repeat |
| Hub shows "cannot reach its saved data (401)" | Pages has not redeployed yet (wait a minute), or the include is missing from the file on `main` |
| Sign-in page says not authorised | Their email domain is not in the rule; re-run with the right domain(s) |

## What it does (for the curious)

1. Checks sabel-webhook knows the key.
2. Creates or updates the Access application "<Client> hub": the hub, its `.html` form, `api/hub-token/<slug>`, plus any `also` pages. One Allow rule: emails ending in the client domain(s) plus `@sabelcustomersuccess.com`.
3. Locks the key via `/api/tracker-lock`. Keeps an existing client token unless `rotate`, extra `keys`, or the key was locked by the domain lock-down with no client token yet.
4. Sets `HUB_TOKEN_<SLUG>` (secret) and `HUB_AUD_<SLUG>` on the `sabel-hubs` Pages project and redeploys.
5. Adds `<script src="hub-auth.js" data-client="<slug>"></script>` before the page's first script and commits it.

Related: `hub-auth.js` (the include), `functions/api/hub-token/[client].js` (hands the token to signed-in visitors), `scripts/lock-down.mjs` (staff-only default), `sabel-webhook/api/tracker-lock.js` (the lock).
