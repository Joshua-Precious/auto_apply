# Milestone 1 report — secure foundation + developer workbench

Date: 2026-10-10. Status: **complete, verified**. No deployment, no model calls, no browser sessions, no application submissions.

## What was implemented

Live behind `http://127.0.0.1:4310` (API) and `http://127.0.0.1:5175` (workbench):

- **Cequre 1.0.3 backend** (`cequre/schema/config.cequre`): `tenants`, `api_clients`, `api_keys` collections with `hideFromApi` + `hideFromAdmin`. No public signup, no session auth, GraphQL disabled, OpenAPI generation disabled (we serve a curated contract instead).
- **Security boundary** (`src/http.ts`): exact-origin check, cookie rejection, 256 KiB bounded body stream, JSON media-type + syntax pre-validation, Redis atomic rate limits (120 reads / 20 mutations per client-minute, 60/min/IP on health), sanitized error envelope `{error:{code,message,retryable,details},request_id}`, `Cache-Control: private, no-store` on everything, redacted structured logs (request id, status, duration only).
- **Scoped API keys** (`src/auth.ts`, `scripts/keys.ts`): `ja_live_<uuid>.<256-bit secret>`, HMAC-SHA-256 digest storage under versioned pepper, per-request active-status + scope-subset checks with constant-time comparison, create/rotate/revoke CLI with one-time private file issuance.
- **Live endpoints**: `GET /v1/health` (DB + Redis probes, 200/503), `GET /v1/capabilities` (honest disabled-features payload), `GET /v1/openapi.json` (curated live contract, health + capabilities only), `GET /v1/demo/capabilities` (loopback-only fixed read; checks a least-privilege server-side grant, no credential proxying). All work routes return `422 FEATURE_DISABLED`.
- **Independent worker** (`src/worker.ts`): separate Bun process, heartbeats to `worker_heartbeats` every 15s, graceful shutdown. Boots without API serving; declares `task_execution: not_implemented`.
- **Developer workbench** (`web/`): Overview, API explorer (live health + capabilities requests with timing, history, server-side cURL snippets, per-endpoint availability states), Webhooks (M6 contract preview, verification checklist), Security & limits (key lifecycle, guardrails, current limits). No secrets in the bundle; CSP on served assets; responsive 1440px → 390px.
- **Infrastructure**: Compose PostgreSQL 17 + Redis 7 on project-local loopback ports, transactional `001-foundation` migration (composite tenant FKs, digest checks, migration ledger, heartbeat table), multi-stage Dockerfile (pinned `oven/bun:1.4.2`, no CLI/secrets in image).

## Architectural decisions

1. **Cequre codegen isolated, not trusted blindly.** Installed 1.0.3 emits invalid declaration references (`Promise$1`, `Omit$1`, unresolved `graphql` import) and denies hidden collections with 403 instead of removing routes. `src/runtime.ts` loads the bundle dynamically behind a narrow typed contract; the public boundary allowlists `/v1/*` and converts everything else to 404 before dispatch.
2. **Transactions go through the adapter, not generated helpers.** Verified `adapter.transaction()` rollback and `SELECT … FOR UPDATE` serialization against real PostgreSQL in tests.
3. **No caching of private data.** Custom no-op cache replaces `MemoryCacheStore` (which Cequre refuses in production); Redis is used for rate limits and (later) queue coordination only.
4. **Demo is a fixed server-side read, not a proxy.** The browser sends no credential; the server checks a `capabilities:read`-only grant bound to `DEMO_KEY_ID`. Same-origin GETs may omit `Origin`, so Referer + `Sec-Fetch-Site` are verified as fallback — covered by an explicit test.
5. **Request-size defense in depth.** 1 MiB Bun transport cap + 256 KiB application stream cap; oversize and malformed bodies are rejected with the same sanitized envelope.

## Files and modules changed

`cequre/schema/config.cequre`, `package.json`, `tsconfig.json`, `web/tsconfig.json`, `compose.yaml`, `Dockerfile`, `.dockerignore`, `.env.example`, `.gitignore`, `src/{config,runtime,database,auth,validation,http,server,worker}.ts`, `scripts/{setup,keys,demo,build-assets}.ts`, `scripts/migrations/001-foundation.sql`, `tests/{unit,integration}.test.ts`, `web/{vite.config.ts,index.html,src/main.tsx,src/App.tsx,src/style.css}`, `docs/{setup.md,milestone-1.md}` (+ this report).

## Tests executed and results

- `bun run typecheck` (server + web projects): **pass**, exit 0.
- `bun test tests/unit.test.ts tests/integration.test.ts`: **13 pass, 0 fail, 53 expects** — key structure/HMAC, explicit scopes, demo/production config gates; real-HTTP health/capabilities, anonymous/malformed/wrong-scope/forged-cookie/foreign-origin denial, generated-surface lockdown (incl. direct `app.fetch` probe), key rotation/revocation immediacy, tenant-FK rejection, genuine transaction rollback, lock serialization, `FEATURE_DISABLED` + 413 + `INVALID_JSON`, demo origin matrix, Redis 429 with `Retry-After`.
- `bun run build`: **pass** — Vite client (211 kB JS / 66 kB gzip), Bun server + worker bundles, runtime/contract assets staged.
- Built bundle smoke test on port 4311: health, CSP-served frontend, hashed assets, live contract limited to 2 routes — **pass**. Worker heartbeat row fresh in PostgreSQL — **pass**.
- Browser verification (Preview tab): Overview renders "Operational", explorer health → `200 {"status":"ok"}`, capabilities → `200` disabled-features payload, clean console (duplicate-`createRoot` HMR artifact resolved by App/main split; verified absent on fresh load), 390px mobile layout verified.

## Remaining risks and limitations

- Cequre 1.0.3 is proprietary (solo/<10 covered; recheck on team growth) and pinned by local binary, not checksum — pin the binary hash in CI at M2.
- No run persistence, queue dispatch, AI adapter, browser runtime, webhooks, or console sessions exist; the worker heartbeats but processes nothing.
- Supplemental migration runs outside Cequre sync; `001` is additive-only and guarded by advisory lock — review before any destructive change (never `--force` in production).
- Resource sizing, cost metering, retention purges, and backup drills are unmeasured by design at this stage.
- Docker image `jobauto-foundation:local` (258 MB) built and boot-verified: container on the Compose network serves `200 {"status":"ok"}` on `/v1/health` and advertises only the 2 implemented routes. Two harness mistakes found and fixed during verification (pepper env extraction matched `API_KEY_PEPPER_VERSION`; production flag correctly rejected loopback HTTP origin — the guard worked as designed). Boot-check container removed afterwards.

## Next recommended milestone

**M2 — durable intelligence execution**: run/idempotency/event/outbox tables, BullMQ-backed worker dispatch with fencing, deterministic inference adapter, `jobs/analyze` + `matches` async flows with status/result polling, admission quotas, cancellation/deadlines, and deletion-status contract. Keep AI deterministic and browser disabled.
