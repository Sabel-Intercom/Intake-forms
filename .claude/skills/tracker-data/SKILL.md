---
name: tracker-data
description: Read live project tracker data and the active client list from a script or from Claude. Use whenever a task needs tracker state for one or more clients (weekly client updates, Friday drafts, Monday roll-up, hours or status roll-ups, monthly close), or the list of active clients, or when a tracker request answers 401 "This hub is locked". Replaces fetching sabel-webhook /api/tracker or trackers.json on github.io directly.
---

# Reading tracker data

Client tracker keys are locked. A plain request to `sabel-webhook.vercel.app/api/tracker?key=...` now answers `401 This hub is locked`, and `trackers.json` on `github.io` is going away. Use the reader in this repo instead. It adds the team passcode for you and never prints it.

Run from an up-to-date checkout of `Sabel-Intercom/Intake-forms` (`git pull` first, so the client list is current).

## Client list

```
node scripts/tracker.mjs roster --active
```

JSON list of `{ name, key, file, sowHours, active }`. Without `--active`: every client. This reads `trackers.json` from the checkout. If it fails, stop and report; never guess a client list.

## Tracker state

```
node scripts/tracker.mjs get <key> [<key> ...]
```

JSON object keyed by tracker key: `{ "ok": true, "data": { ... } }` or `{ "ok": false, "status": 401, "error": "..." }`. Exit code 2 when any key failed. Pass every key in one call.

Report a failed key to the person as a failed key. Never fill in from memory, an old file or another client.

## The passcode (once per Mac)

```
node scripts/tracker.mjs check
```

If it says no passcode is stored, the person runs this themselves in Terminal, presses return, and pastes the team passcode at the hidden prompt:

```
security add-generic-password -U -s sabel-team-token -a sabel -w
```

Richard has the passcode. **Never ask for it in chat, never put it in a file, never echo or print it, never read the Keychain item yourself.** The reader is the only thing that touches it.

If `check` says the passcode was refused, it has been changed: the person stores the new one with the same command.

## Updating an older skill or script

Anything that still does one of these needs changing to the two commands above:

- `GET https://sabel-webhook.vercel.app/api/tracker?key=<key>`
- `https://sabel-intercom.github.io/Intake-forms/trackers.json` or the `raw.githubusercontent.com` copy

Writing tracker state is not covered here. Trackers are edited in the hub itself.
