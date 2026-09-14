# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Cloudflare Worker named `door-webhook`: the public edge receiver for CiviCRM webhooks, and
one half of the `door-sync` system. It sits between CiviCRM (which fires a signed webhook from
a CiviRules custom action) and the `door-sync` daemon on a Raspberry Pi behind NAT.

```
CiviCRM (CiviRules action) ──HMAC POST──▶ door-webhook (this Worker)
                                              │  validate + buffer on a Queue
                                              ▼
                                          queue consumer ──HMAC POST + CF Access──▶
                                              door-sync (Pi, via Cloudflare Tunnel)
```

Buffering on the Queue is what makes a Pi reboot lossless: a failed delivery is retried and,
after `max_retries`, dead-lettered rather than dropped.

`wrangler.jsonc` deliberately carries no account id, hostname or secret, so it is safe to
publish. The account comes from `CLOUDFLARE_ACCOUNT_ID` in `.env`; every runtime value is a
secret (`ORIGIN_URL` included) set with `wrangler secret put`, and locally from `.dev.vars`,
which is also what `wrangler types` reads to type them. Both have committed `.example` files.

`ORIGIN_URL` is not set yet — the Cloudflare Tunnel to the Pi does not exist — so deliveries
fail the consumer's config preflight and dead-letter. The CiviCRM -> Worker half is live.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` (`wrangler dev`) | Local dev server at http://localhost:8787 |
| `npm run deploy` (`wrangler deploy`) | Deploy to Cloudflare |
| `npm test` (`vitest`) | Run tests (watch mode by default) |
| `npm test -- run` | Run tests once and exit |
| `npm test -- run -t verifySignature` | Run tests whose name matches (`-t` is a **regex** — escape or omit parens, so `-t "queue (consumer)"` matches nothing) |
| `npm run cf-typegen` (`wrangler types`) | Regenerate `worker-configuration.d.ts` from `wrangler.jsonc` |

There is no lint or typecheck script. Typecheck both projects directly —
`npx tsc --noEmit -p tsconfig.json` and `npx tsc --noEmit -p test/tsconfig.json` — since the
root config excludes `test/`. Formatting is `npx prettier --check .`.

Run `wrangler types` after **any** change to bindings, vars, or compatibility settings in
`wrangler.jsonc` — the generated `Env` type in `worker-configuration.d.ts` is what typechecks
the Worker. That file is committed and large; it is generated, so do not edit it by hand.

## Architecture

- **`src/index.ts`** — the whole Worker (`main` in `wrangler.jsonc`), exporting two handlers as
  `satisfies ExportedHandler<Env, WebhookEvent>`. The `Env` type is global (from
  `worker-configuration.d.ts`), not imported.
  - `fetch` — 404s anything that is not `POST /civicrm/membership-changed`, verifies the
    signature against `CIVICRM_WEBHOOK_SECRET` (401 on failure), normalizes the payload to a
    `WebhookEvent`, sends it to the `EVENTS` queue, returns 202. It never calls the Pi itself.
  - `queue` — delivers each message to `${ORIGIN_URL}/civicrm/membership-changed`, re-signing
    with `ORIGIN_HMAC_SECRET` and attaching CF Access service-token headers. Deliveries run
    concurrently under `Promise.all` and each message acks or retries on its own; a non-2xx or
    a timeout throws, which retries and eventually dead-letters. Order does not matter because
    every event makes the Pi reconcile its whole population.
- **`wrangler.jsonc`** — deploy config only: the `EVENTS` queue producer and the consumer
  (`max_batch_size` 10, `max_retries` 5, `retry_delay` 30s, DLQ `door-webhook-dlq`).
  `nodejs_compat` is on and `observability` is enabled. No `vars`, no `account_id`.
- **Secrets** (`ORIGIN_URL`, `CIVICRM_WEBHOOK_SECRET`, `ORIGIN_HMAC_SECRET`,
  `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`) are set with `wrangler secret put`, never
  in `wrangler.jsonc`. Locally they live in `.dev.vars`, which is git-ignored, which the test
  pool loads, and which `wrangler types` reads to generate their `Env` entries.
- **Tests** (`test/index.spec.ts`) use `@cloudflare/vitest-pool-workers`, which runs them inside
  the real `workerd` runtime; `vitest.config.mts` points the pool at `wrangler.jsonc`, so tests
  share the Worker's config. They import the `worker` default export and invoke handlers
  directly — `worker.fetch(...)` / `worker.queue(...)` with `createExecutionContext()` and
  `waitOnExecutionContext()` from `cloudflare:test` — with `env`, queue batches, and `fetch`
  itself faked via `vi.stubGlobal`. Nothing uses `SELF`.

## Signing contract

Both hops use the same scheme, shared with the Pi's Python receiver:

```
X-Door-Sync-Timestamp: <unix seconds>
X-Door-Sync-Signature: sha256=<hex>
hex = HMAC_SHA256(secret, `${timestamp}.` + rawBody)
```

Verification is fail-closed and constant-time (`crypto.subtle.verify`), accepts the signature
bare or `sha256=`-prefixed, and rejects a timestamp more than 300s from now as a replay. Sign
over the **raw body bytes**, never a re-serialized copy. The two hops use different secrets —
do not collapse them.

## Conventions

- **Never log member PII** (names, emails, card IDs). `contact_id` and the delivery UUID only.
- Formatting (`.prettierrc` / `.editorconfig`): **tabs**, single quotes, semicolons,
  140-char print width. `src` is tab-indented — match it.
- TypeScript is `strict`; `src` targets es2024. `test/` has its own `tsconfig.json` and is
  excluded from the root one.

## Cloudflare Workers guidance

See `AGENTS.md`: Workers/KV/R2/D1/DO/Queues/AI APIs and limits change often — retrieve current
docs (developers.cloudflare.com or the Cloudflare MCP server) before implementing against them
rather than relying on memory. This has already caught one incorrect review suggestion
(`retry_delay` vs a nonexistent `retry_delay_secs`); the installed
`node_modules/wrangler/config-schema.json` is the fastest authority for config keys.
