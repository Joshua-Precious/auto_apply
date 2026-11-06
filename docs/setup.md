# Local setup and operation

Prerequisites: Bun 1.4.2, Docker, Cequre CLI 1.0.8 on PATH, ports 4310 / 5175 / 55432 free on loopback.

## First-time setup

```bash
docker compose up -d --wait postgres   # project-local PostgreSQL 17
bun install                            # pinned Bun lockfile
bun run setup                          # writes private .env, runs cequre db:sync
bun run keys create                    # operator key; secret saved once to .local/key-<id>.txt
bun run demo:enable                    # optional: loopback demo for the workbench
```

`bun run setup` is idempotent. It creates `.env` if absent and runs `cequre db:sync --dir ./cequre`; the `.cequre` collections are the canonical schema. There is no hand-written migration directory. Never use `cequre db:sync --force` against a database you care about. Regenerate types after schema edits with `bun run generate`; never edit `cequre/_generated/`.

If the database still contains the retired raw-SQL tables (`tenants`, `api_keys`, `runs`, …), rename them first so Cequre can create its schema without data loss:

```sql
ALTER TABLE api_keys RENAME TO legacy_api_keys;
-- repeat for tenants, api_clients, runs, artifacts, job_snapshots,
-- candidate_snapshots, run_events, idempotency_records, deletions.
```

Old API keys live in `legacy_api_keys` and are not valid in the new backend; issue new keys.

## Daily operation

```bash
bun run dev:api      # Cequre API on http://127.0.0.1:4310
bun run dev:web      # React workbench on http://127.0.0.1:5175 (proxies /v1 to the API)
```

There is no separate worker. `createRun` triggers execution immediately after acceptance and a Cequre cron job every minute recovers any queued run and performs retention. The per-tenant active-run quota (default 2) applies before acceptance.

Production-shaped check:

```bash
bun run build        # typecheck + Vite build + cequre build (dist/server/server.js)
PORT=4311 ENABLE_LOCAL_DEMO=false bun dist/server/server.js
```

## Key lifecycle (operator only)

```bash
bun run keys create          # new tenant + client + key; secret → .local/key-<id>.txt (once)
bun run keys rotate <key-id> # same scopes, new secret; old key stays active until revoked
bun run keys revoke <key-id> # immediate; next request returns 401
```

Secrets are stored as HMAC-SHA-256 digests under a versioned deployment pepper (`API_KEY_PEPPER`, 32 random bytes hex). Rotation overlap is explicit: revoke the old key after consumers switch.

**Candidate access is separate.** A key with `matches:write` still needs a grant for the specific `subject_ref`:

```sql
UPDATE api_clients
SET candidate_grants = '["candidate-42"]'::jsonb
WHERE id = '<client-id>';
```

Ungranted subjects return `403 CANDIDATE_DENIED`; another tenant's runs return `404`.

## Scopes

`capabilities:read`, `jobs:analyze`, `matches:write`, `cv:tailor`, `runs:write`, `runs:read`, `runs:control`, `artifacts:read`, `data:delete`. A key's scopes must be a subset of its client's scopes.

## Loopback demo (development only)

`bun run demo:enable` creates a least-privilege demo tenant/client, writes `ENABLE_LOCAL_DEMO=true` and `DEMO_KEY_ID` to `.env`, then restart the API. Routes under `/v1/demo/*` require `X-Jobauto-Demo: true` and, when an `Origin` is present, the configured `APP_ORIGIN`. The server uses its own key; no credential reaches the browser.

- `GET /v1/demo/capabilities`
- `GET /v1/demo/scenarios`
- `POST /v1/demo/runs` — `{scenario:"job_analysis"|"match"|"cv_tailoring", job_text:"..."}`
- `GET /v1/demo/runs/{id}` and `/v1/demo/runs/{id}/events`
- `GET /v1/demo/artifacts/{id}`

Demo routes are disabled in production and on non-loopback origins.

## CV artifacts and candidate deletion

`POST /v1/cv/tailor` queues an extractive tailoring run. The artifact is stored by the run engine with a canonical SHA-256 checksum and a per-`(tenant, subject, kind)` version. Retrieval is `GET /v1/artifacts/{id}` with `artifacts:read` plus the candidate grant.

- Each line is exact supplied fact text, or its exact `title at employer (start - end)` rendering. Paraphrase, altered employers/dates, unknown fact IDs and score-like fields are rejected before storage.
- Artifacts are immutable and versioned. A re-run creates a new version; it never edits an older one.
- Expired artifacts and snapshots are removed by the retention sweep; expired reads return 404.

The maintenance cron deletes up to 500 expired artifacts, candidate snapshots, job snapshots and idempotency records per collection each tick, then clears expired run results and references while keeping statuses and redacted events for audit. Referenced snapshots are left in place.

`DELETE /v1/candidates/{subject_ref}/data` requires `data:delete` and the candidate grant. Acceptance is durable and returns `202`; the purge cancels active runs, removes artifacts/snapshots and clears sensitive run fields. A repeated request coalesces onto the unfinished deletion, and `GET /v1/deletions/{id}` reports `queued`, `running`, `completed` or `failed`.

## MCP adapter

```bash
JOBAUTO_ORIGIN=http://127.0.0.1:4310 JOBAUTO_API_KEY="$JOBAUTO_API_KEY" bun run mcp
```

It exposes `analyze_job`, `match_candidate`, `tailor_cv`, `get_run` and `get_artifact`; no file access and no submission tool. Origin and key are read from the environment only. stderr carries diagnostics; stdout is the protocol channel.

## Environment

See [.env.example](../.env.example). Execution policy is deployment-controlled, never caller-controlled:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | — | PostgreSQL connection; required |
| `API_KEY_PEPPER` | — | 32 random bytes hex; required |
| `API_KEY_PEPPER_VERSION` | 1 | Digest version for new keys |
| `APP_ORIGIN` | `http://127.0.0.1:5175` | Workbench origin allowed by the demo |
| `PORT` / `SERVICE_PORT` | 4310 | Cequre listen port |
| `MAX_ACTIVE_INTELLIGENCE` | 2 | Active runs per tenant before `429 ACTIVE_LIMIT_REACHED` |
| `IDEMPOTENCY_TTL_HOURS` | 24 | Replay window for `Idempotency-Key` |
| `RETENTION_DAYS` | 30 | Input/result retention; expired reads return 410/404 |
| `ENABLE_LOCAL_DEMO` | false | Loopback demo only; rejected in production |

## Tests

```bash
bun run test               # Cequre lifecycle + MCP protocol
bun run test:integration   # Cequre lifecycle against real PostgreSQL
bun run typecheck
bun run build
```

The lifecycle suite creates synthetic tenants and exercises auth, idempotency conflict/replay, analysis execution, tailoring artifacts, cancellation, deletion and retention. It never calls a model, opens a browser, or submits anything external.

## Observability and recovery

The API logs one JSON object per line: route errors include `request_id`; run/list/deletion events include `run_id` or `deletion_id`; retention logs `retention purge complete` with per-table counts. No candidate content or credentials are logged.

Queued runs are executed immediately in the process. If the process stops after acceptance, the next cron tick (within one minute) picks up `queued` rows. A duplicate in-process execution is prevented with an execution lock; Postgres remains the source of truth after restart.

## Container build

```bash
bun run build                  # produces dist/server/server.js on the host
docker build -t jobauto-cequre:local .
```

The image does not contain the Cequre CLI or `.env`; it serves the prebuilt bundle and Vite assets. Run `bun run build` before `docker build` so `dist/server/server.js` exists.
