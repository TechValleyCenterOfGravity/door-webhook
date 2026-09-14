# door-webhook

Public edge receiver for CiviCRM webhooks, part of the [door-sync](../door-sync)
system. It sits between CiviCRM (which fires a signed webhook via a CiviRules
custom action) and the door-sync daemon on a Raspberry Pi behind NAT.

```
CiviCRM (CiviRules action) ──HMAC POST──▶ door-webhook (this Worker)
                                              │  validate + buffer on a Queue
                                              ▼
                                          Queue consumer ──HMAC POST + CF Access──▶
                                              door-sync (Pi, via Cloudflare Tunnel)
```

- **`fetch`** verifies the request signature (`CIVICRM_WEBHOOK_SECRET`),
  normalizes it to a `WebhookEvent`, sends it to the `EVENTS` queue, and returns
  `202` immediately. A bad/missing/stale signature returns `401`.
- **`queue`** consumer pushes each event to the Pi at `${ORIGIN_URL}/civicrm/membership-changed`,
  re-signing with `ORIGIN_HMAC_SECRET` and presenting a Cloudflare Access service
  token. A non-2xx response retries; after `max_retries` the message is
  dead-lettered (`door-webhook-dlq`) rather than dropped — so a Pi reboot never
  loses an event.

## Signing contract

Both hops use the same scheme (shared with the Pi's Python receiver):

```
X-Door-Sync-Timestamp: <unix seconds>
X-Door-Sync-Signature: sha256=<hex>
hex = HMAC_SHA256(secret, `${timestamp}.` + rawBody)
```

The verifier rejects a timestamp more than 300s from now (replay guard).

## Setup

```bash
npm install

# 1. Create the queues (once, in the Tech Valley Center of Gravity account):
npx wrangler queues create door-webhook-events
npx wrangler queues create door-webhook-dlq

# 2. Set the origin URL in wrangler.jsonc (vars.ORIGIN_URL) to the Pi's
#    Cloudflare Tunnel hostname, e.g. https://door-sync.example.org

# 3. Set secrets:
npx wrangler secret put CIVICRM_WEBHOOK_SECRET   # shared with the CiviRules action
npx wrangler secret put ORIGIN_HMAC_SECRET       # shared with the Pi (WEBHOOK_HMAC_SECRET)
npx wrangler secret put CF_ACCESS_CLIENT_ID      # Access service token for the tunnel
npx wrangler secret put CF_ACCESS_CLIENT_SECRET

# 4. Deploy:
npm run deploy
```

For local development, put the same keys in `.dev.vars` (git-ignored). Re-run
`npm run cf-typegen` after any change to `wrangler.jsonc`.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Local dev server at http://localhost:8787 |
| `npm test -- run` | Run the Vitest suite once |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` from `wrangler.jsonc` |
