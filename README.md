# AI Job Automation Service

Independent, API-first job intelligence service with a developer workbench. The backend is now **native Cequre** (CLI 1.0.8): collections, custom routes, local API transactions and in-process cron replace the retired hand-written HTTP server, SQL migrations and separate worker.

## What runs today

| Endpoint | Purpose | State |
| --- | --- | --- |
| `GET /v1/health` | Sanitised readiness | Live |
| `GET /v1/capabilities` | Implemented features and limits | Live |
| `POST /v1/jobs/analyze` | Queue job extraction and normalization | Live (async) |
| `POST /v1/matches` | Evidence assessment against authorized candidate facts | Live (async) |
| `POST /v1/runs` | Typed run creation (`job_analysis`, `match`, `cv_tailoring`) | Live (async) |
| `GET /v1/runs/{run_id}` | Authoritative status and result | Live |
| `GET /v1/runs/{run_id}/events` | Ordered, redacted event history | Live |
| `POST /v1/runs/{run_id}/cancel` | Version-checked cancellation | Live |
| `POST /v1/cv/tailor` | Queue extractive, versioned CV artifact creation | Live (async) |
| `GET /v1/artifacts/{id}` | Authorized immutable artifact retrieval | Live |
| `DELETE /v1/candidates/{ref}/data` | Durable candidate-data erasure | Live (async) |
| `GET /v1/deletions/{id}` | Deletion outcome | Live |
| `GET /v1/openapi.json` | Published contract | Live |
| `POST /v1/webhooks` | Signed event delivery | Planned (M6) |

Unimplemented capabilities fail closed with `422 FEATURE_DISABLED` and are reported as unavailable by `/v1/capabilities`. Responses keep the `{ "data": ..., "request_id": ... }` envelope used by the workbench and MCP adapter.

## Quick start

```bash
docker compose up -d --wait postgres   # PostgreSQL 17 on loopback
bun install
bun run setup                          # private .env + Cequre schema sync
bun run keys create                    # operator key, secret written once to .local/
bun run demo:enable                    # optional loopback demo for the workbench
bun run dev:api                        # Cequre API on http://127.0.0.1:4310
bun run dev:web                        # workbench on http://127.0.0.1:5175
```

There is no separate worker to start. Acceptance triggers execution immediately; a Cequre cron job (`*/1 * * * *`) recovers queued runs and runs the retention sweep.

Full instructions, schema workflow, limits, key rotation and container builds: [docs/setup.md](docs/setup.md).

## Try the flow

```bash
curl -X POST http://127.0.0.1:4310/v1/jobs/analyze \
  -H "Authorization: Bearer $JOBAUTO_API_KEY" \
  -H "Idempotency-Key: analyze-posting-001" \
  -H "Content-Type: application/json" \
  -d '{"job":{"kind":"text","text":"Example Ltd seeks a Backend Engineer with TypeScript experience. You must have 3+ years with Node.js. PostgreSQL is preferred."}}'
# 202 + Location: /v1/runs/<id>

curl http://127.0.0.1:4310/v1/runs/<id> -H "Authorization: Bearer $JOBAUTO_API_KEY"
```

Requirements carry verbatim quotes verified against the submitted text, and matching cites only supplied fact IDs. A tailoring run stores a separate immutable artifact (`result.artifact_id`) retrieved with `GET /v1/artifacts/{id}`.

## Cequre layout

```
cequre/config.cequre              system config only (prefix /v1, CORS/headers, admin off)
cequre/collections/*.cequre       11 hidden collections (no generated CRUD surface)
cequre/routes/index.ts            custom authenticated routes, demo surface, cron
cequre/utilities/                 contracts, deterministic intelligence, auth, run engine
cequre/app.ts                     PostgresAdapter + defaultSecurity + routes
cequre/index.ts                   process entrypoint
cequre/_generated/                generated runtime; never edit by hand
scripts/                          setup, key provisioning, loopback demo
integrations/mcp/                 stdio MCP adapter
tests/                            Cequre lifecycle and MCP protocol tests
web/                              React + Vite developer workbench
```

Collections are `hideFromApi`/`hideFromAdmin`; every public operation goes through an explicit route with scoped-key authentication. Postgres remains the system of record. `cequre generate` and `cequre db:sync` own the schema.

## Design guarantees

- **Durable acceptance.** Acceptance writes the job/candidate snapshots, run, first event and idempotency record in one Cequre transaction.
- **Idempotent creation.** `Idempotency-Key` is required; the same key and payload replay the original run, a changed payload returns 409.
- **Grounded over generated.** The deterministic provider invents nothing; validators reject ungrounded quotes, unknown fact IDs and score-like output.
- **Immutable artifacts.** Tailoring reuses exact supplied fact text in a versioned SHA-256-checksummed artifact. A re-run creates a new version.
- **Erasure is durable.** Candidate deletion cancels/fences runs and removes snapshots, artifacts and sensitive result fields, leaving only a pseudonymous deletion row.
- **Retention is swept.** Every maintenance tick deletes up to 500 expired artifacts, snapshots and idempotency records per collection, then clears expired run results and references while keeping statuses and redacted events.
- **Tenant isolation.** Identity comes from the credential. Another tenant's run is a 404; candidate facts need an explicit client grant.
- **Honest status.** Runs end as `completed`, `failed` or `cancelled`; no external submission capability is advertised.

## MCP adapter

`bun run mcp` starts a stdio Model Context Protocol server exposing `analyze_job`, `match_candidate`, `tailor_cv`, `get_run` and `get_artifact`. Origin and credential come only from `JOBAUTO_ORIGIN` and `JOBAUTO_API_KEY`; there is no file access or submission tool. `JOBAUTO_ORIGIN` must be HTTPS, or HTTP on loopback.

## Migration notes

This workstation previously held the legacy raw-SQL backend. Its tables were renamed to `legacy_*` (rows preserved) so Cequre could create its own schema without dropping data. Keys issued against the old `api_keys` table are not valid against the new one; run `bun run keys create`. API paths and the response envelope are unchanged; storage and execution internals are intentionally different.

## Architecture and planning

1. [Architecture, security, milestones](docs/architecture.md) — the separate-worker/BullMQ design is superseded for M1–M3 by the Cequre in-process runtime.
2. [OpenAPI contract](docs/openapi.json) — also served at `GET /v1/openapi.json`.
3. [Milestone 1](docs/milestone-1.md) · [Milestone 2](docs/milestone-2.md) · [Milestone 3](docs/milestone-3.md)
4. [Validation notes](docs/validation.md)

No real CVs, credentials, cookies or production application submissions belong in this repository. The loopback demo uses a fixed synthetic candidate and never exposes a key to the browser.
