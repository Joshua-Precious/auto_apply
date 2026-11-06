# Production deployment

This service is ready for a single-region deployment with:

- PostgreSQL 17 as the system of record
- two or more stateless API replicas
- TLS and request-rate limiting at the reverse proxy
- a one-off schema/seed job, not an API replica with migration privileges

It does not include browser automation, external submission, webhooks, or a hosted candidate-file store. Those remain explicitly unavailable.

## Topology

```
clients / career-ops MCP
        |
     TLS proxy  (rate limits, request logging, body-size cap)
        |
  +-----+-----+
  |           |
 API #1     API #2 ...    (same image, same DATABASE_URL)
  |           |
  +-----+-----+
        |
   PostgreSQL 17
```

There is no Redis requirement and no separate worker. Every replica runs a one-minute Cequre cron for queued-run recovery, stale-claim recovery, and retention. A run is claimed with a conditional database update, so the cron on multiple replicas cannot execute the same queued run twice. A process that dies after claiming leaves the run `running`; another replica requeues it after the 10-minute lease window. The maximum accepted operation timeout is 300 seconds, so this is above the normal execution ceiling.

Tailoring artifacts are reused by `run_id` during recovery, so a retried execution does not create a second artifact version.

## Build and release

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build                    # Vite assets + dist/server/server.js
docker build -t jobauto:<tag> .
```

The Docker image does not contain the Cequre CLI. Build `dist/server/server.js` in CI with the pinned Cequre 1.0.8 CLI, then build the image. The runtime copies only the bundle, public assets, and production dependencies.

Before the first production start:

1. Create a fresh PostgreSQL database; do not reuse a database containing the retired `legacy_*` tables.
2. Initialize the schema before serving traffic. From source, run `bun run db:init`. For the built image, run it once with `SCHEMA_INIT_ONLY=1` (for example `docker run --rm --env-file .env -e SCHEMA_INIT_ONLY=1 jobauto:production`). Startup sync is additive and creates missing tables; inspect `cequre db:diff --dir ./cequre` from the source checkout.
3. Seed a tenant/client/key with the operator scripts or an equivalent one-off job.
4. Confirm `GET /v1/health` returns 200 from behind the proxy.
5. Keep `ENABLE_LOCAL_DEMO=false`; do not expose `/v1/demo/*`.

The local `.env` contains a development-only password and pepper. Generate a new 32-byte hex `API_KEY_PEPPER` for production and store it in the platform secret manager. Never commit `.env`, key files under `.local/`, or database credentials.

## Required configuration

| Variable | Requirement |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection with TLS as required by the provider |
| `API_KEY_PEPPER` | 32+ random bytes as hex; stable for existing keys |
| `API_KEY_PEPPER_VERSION` | Integer; bump only with a planned key migration |
| `HOST` | `0.0.0.0` inside the container |
| `PORT` | Container listen port; default `4310` |
| `ENABLE_LOCAL_DEMO` | `false` |
| `APP_ORIGIN` | Only used by the demo; must not be a public demo deployment |
| `MAX_ACTIVE_INTELLIGENCE` | Per-tenant concurrency, default 2 |
| `IDEMPOTENCY_TTL_HOURS` | 1–72, default 24 |
| `RETENTION_DAYS` | 1–365, default 30 |

The API does not load `.env` when it runs inside the image; inject variables through the platform. The MCP server separately requires `JOBAUTO_ORIGIN` and `JOBAUTO_API_KEY` in the environment of the AI CLI that spawns it.

## Limits and edge policy

The repository does **not** ship a distributed per-client rate limiter. The workbench no longer claims Redis counters. Configure read/write/run-creation limits at the reverse proxy or API gateway, keyed by the authenticated client or a trusted forwarded identity. Do not trust client-supplied forwarding headers unless the proxy strips them.

The in-process active-run quota is enforced transactionally per tenant. It intentionally bounds intelligence work even if edge limits are absent or misconfigured. With multiple replicas, count it as a per-tenant safety valve, not a global scheduler.

## Keys and candidate grants

Create keys with:

```bash
bun run keys create
bun run keys rotate <key-id>
bun run keys revoke <key-id>
```

These commands need `DATABASE_URL` and `API_KEY_PEPPER`. Run them from a trusted administration environment, not from a public API pod.

Candidate access is separate from scopes. Grant only the subject references a client needs:

```sql
UPDATE api_clients
SET candidate_grants = '["candidate-42"]'::jsonb
WHERE id = '<client-id>';
```

The career-ops connector uses `JOBAUTO_SUBJECT_REF` (recommended: `career-ops`) and requires the same grant. See [the connector](../integrations/career-ops/README.md).

## Backups and recovery

- Enable PostgreSQL point-in-time recovery and automated daily backups.
- Test a restore into a separate database before relying on it.
- Back up the `API_KEY_PEPPER` separately; losing it invalidates every key digest.
- Retained run results and artifacts expire after `RETENTION_DAYS`; backups may retain older copies under the provider's policy. Document that in your privacy notice.
- Candidate deletion removes snapshots, artifacts, and sensitive run fields, but backups are not rewritten. Handle erasure requests against backup retention under your policy.

## Observability

The API writes JSON log lines. Route failures include `request_id`; run and deletion logs include their IDs. Use the proxy's access log for status codes, latency, and client identity. The health endpoint intentionally exposes only service status and backend type; it does not return tenant counts or database details.

There is no metrics or tracing exporter in this release. Add one at the proxy for request rate, error rate, and latency. Alert on:

- repeated 5xx responses
- `stale runs requeued` logs
- `run failed` logs
- database connection failures
- queue age (oldest `queued` run)
- disk and backup health

## Validation record

These checks were run against a freshly cleared local database on 2026-11-06. They prove the application paths, not a production deployment.

| Check | Result |
| --- | --- |
| Fresh schema bootstrap | Pass: `bun run setup` created all application and Cequre tables; `cequre db:diff` reported no changes |
| Two API replicas | Pass: both served health and the same authenticated run; one execution completed |
| Demo disabled | Pass: `/v1/demo/capabilities` returned 404 with `NODE_ENV=production` and `ENABLE_LOCAL_DEMO=false` |
| Active-run quota | Pass: synthetic active run caused `429 ACTIVE_LIMIT_REACHED` with `Retry-After: 60` |
| Key rotation and revocation | Pass: rotated key worked, old key worked during overlap, old key returned 401 after revocation |
| Candidate erasure | Pass: deletion completed and removed 2 snapshots and 1 artifact for the synthetic subject |
| Backup and restore | Pass: `pg_dump` restored into a scratch database with matching row counts |
| Career-ops MCP path | Pass: `match_candidate` completed with evidence assessments; `tailor_cv` returned a checksummed 3-section artifact |
| Container | Pass: non-root image served health and the 13-path OpenAPI contract |

Not verified locally: TLS termination, edge request-rate limits, a production secret manager, external monitoring, and restore into the production provider. Those remain deployment-owner steps.

## Go-live checklist

- [ ] Fresh database, schema diff reviewed, no `legacy_*` tables
- [ ] Production pepper stored and backed up
- [ ] Two replicas started with the same image and configuration
- [ ] Demo disabled and `/v1/demo/*` unreachable
- [ ] TLS and edge rate limits verified
- [ ] Health check and one authenticated analyze run pass
- [ ] Quota returns 429 with `Retry-After` once active runs reach `MAX_ACTIVE_INTELLIGENCE`
- [ ] Key rotation and revocation tested
- [ ] Candidate deletion tested with a synthetic subject
- [ ] Backup restore tested
- [ ] Career-ops connector tested against a staging key
