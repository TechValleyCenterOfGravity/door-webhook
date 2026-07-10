# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Cloudflare Worker named `door-webhook`. The project is currently the unmodified
`create-cloudflare` starter: `src/index.ts` exports a single `fetch` handler that returns
`"Hello World!"`. The intended webhook functionality has not been built yet — treat the
current code as a scaffold to build on, not a reference implementation.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` (`wrangler dev`) | Local dev server at http://localhost:8787 |
| `npm run deploy` (`wrangler deploy`) | Deploy to Cloudflare |
| `npm test` (`vitest`) | Run tests (watch mode by default) |
| `npm test -- run` | Run tests once and exit |
| `npm test -- test/index.spec.ts -t "unit style"` | Run a single test file / by name |
| `npm run cf-typegen` (`wrangler types`) | Regenerate `worker-configuration.d.ts` from `wrangler.jsonc` |

Run `wrangler types` after **any** change to bindings, vars, or compatibility settings in
`wrangler.jsonc` — the generated `Env` type in `worker-configuration.d.ts` is what typechecks
the Worker. That file is committed and large; it is generated, so do not edit it by hand.

## Architecture

- **`src/index.ts`** — the Worker entry point (`main` in `wrangler.jsonc`). Exports
  `satisfies ExportedHandler<Env>`; the `Env` type is global (from `worker-configuration.d.ts`),
  not imported. Add bindings (KV, D1, R2, secrets, etc.) in `wrangler.jsonc`, regenerate types,
  then access them via the `env` argument.
- **`wrangler.jsonc`** — all deploy/runtime config. `nodejs_compat` is enabled and
  `observability` is on. Bindings are added here (see the commented examples in the file).
- **Tests** use `@cloudflare/vitest-pool-workers`, which runs tests inside the actual
  `workerd` runtime (config in `vitest.config.mts` points the pool at `wrangler.jsonc`, so tests
  share the Worker's bindings). Two styles, both in `test/index.spec.ts`:
  - **unit** — import the `worker` default export, build a `Request`, call
    `worker.fetch(request, env, ctx)` with `createExecutionContext()` /
    `waitOnExecutionContext()` from `cloudflare:test`.
  - **integration** — `SELF.fetch(...)` dispatches through the full Worker.

## Conventions

- Formatting (`.prettierrc` / `.editorconfig`): **tabs**, single quotes, semicolons,
  140-char print width. `src` is tab-indented — match it.
- TypeScript is `strict`; `src` targets es2024. `test/` has its own `tsconfig.json` and is
  excluded from the root one.

## Cloudflare Workers guidance

See `AGENTS.md`: Workers/KV/R2/D1/DO/Queues/AI APIs and limits change often — retrieve current
docs (developers.cloudflare.com or the Cloudflare MCP server) before implementing against them
rather than relying on memory.
