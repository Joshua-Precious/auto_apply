# Milestone 2 report — durable intelligence execution

> **Cequre migration (2026-11-06):** the raw-SQL queue, separate worker, leases and Redis rate limiting described below were retired. Durable run state, idempotency, events, cancellation and recovery now live in `cequre/` collections and are executed by the Cequre process plus a one-minute cron. This report is retained as the original M2 record.

Date: 2026-10-31. Status: **complete, verified**. No deployment, no model calls, no browser sessions, no external side effects.

## What was implemented

- **Durable runs** (`scripts/migrations/002-intelligence.sql`): `runs`, `run_events`, `job_snapshots`, `candidate_snapshots`, `idempotency_records`, `run_dispatches`, `worker_leases`, plus `api_clients.candidate_grants`. Tenant-qualified foreign keys, status/phase/attempt checks, one dispatch per run, ordered event sequences, and 30-day `expires_at` on inputs and runs.
- **Strict public contract** (`src/contracts.ts`): unknown properties rejected at every level, job text 20–30,000 characters, 1–200 facts with unique IDs and validated dates, consent purpose matched to the operation, bounded `timeout_seconds` (30–300), canonical sorted-key hashing for idempotency. Machine-readable `details[{path,code}]` on every 400.
- **Live endpoints** (`src/routes.ts`, `src/http.ts`): `POST /v1/jobs/analyze`, `POST /v1/matches`, `POST /v1/runs`, `GET /v1/runs/{id}`, `GET /v1/runs/{id}/events`, `POST /v1/runs/{id}/cancel`. Acceptance is 202 with `Location` and `Idempotency-Replayed`; approve/resume, CV tailoring, artifacts and webhooks stay `422 FEATURE_DISABLED` after permission checks.
- **Idempotency** (`src/runs.ts`): row-locked advisory serialization per `(tenant, client, key)`, 24-hour records, same key + same canonical payload returns the original run, same key + different payload returns `409 IDEMPOTENCY_CONFLICT`. Alias routes canonicalize to the same operation before hashing.
- **Authorization**: credential-derived tenant, per-endpoint scopes, separate candidate grant checked against `subject_ref`, cross-tenant resources return 404, per-tenant active-run quota (2) enforced inside the creation transaction.
- **Execution engine** (`src/execution.ts`, `src/worker.ts`): `FOR UPDATE SKIP LOCKED` claim with fencing tokens, lease expiry recovery, bounded retry with exponential backoff for transient failures, deadline expiry, cooperative cancellation, ordered events, `run_dispatches` completion, queue snapshot logging.
- **Intelligence** (`src/intelligence.ts`): provider-independent `InferenceProvider` with a deterministic implementation. Requirements carry verbatim `source_quote` values that are re-verified as literal substrings of the submitted text before storage; duration requirements cannot be marked `supported` without supplied dates; matching cites only supplied fact IDs and never emits a score. Output validators reject ungrounded quotes, unknown fact IDs and score-like fields for any provider.
- **Loopback demo** (`/v1/demo/*`): fixed least-privilege demo grant, exact-origin + custom-header check, caller-supplied job text under the same contract, a fixed synthetic candidate for matching. The browser never holds a credential; nothing from the demo can be submitted externally.
- **Workbench** (`web/src/App.tsx`): live demo for analysis and matching with run lifecycle, validated result rendering (requirements with quotes, evidence assessments by kind), ordered event timeline, cURL for the real authenticated call, status-code table, and updated limits/errors documentation.

## Architectural decisions

1. **PostgreSQL queue instead of BullMQ.** Acceptance and enqueue happen in one transaction, so an accepted run cannot be missing from the queue and Redis downtime cannot lose work. `FOR UPDATE SKIP LOCKED` plus fencing tokens gives multi-worker safety. Redis remains for rate limiting. The trade-off is polling (500 ms) rather than push delivery; the queue is behind `run_dispatches`, so a broker adapter can replace it without touching run state.
2. **Deterministic inference first.** It makes the pipeline, contracts, grounding checks and tests meaningful without model cost or provider approval. The provider interface and validators are the seam a model implementation must satisfy.
3. **Grounding is enforced at runtime, not documented.** Quotes must be literal substrings; fact IDs must exist in the snapshot. A model that fabricates either is rejected by the worker and retried/failed honestly.
4. **Retries only where they are safe.** Intelligence work has no external effect, so bounded retry is allowed. Submission paths will be exempt (documented in the architecture).
5. **Cancellation is honest.** Queued work cancels immediately; in-flight work records `cancel_requested_at` and is cancelled at the next safe point; terminal runs return 409.
6. **Cequre generated declarations stay outside the compiler graph.** `tsconfig.json` now excludes `cequre/_generated` (machine output with invalid self-references), matching the runtime adapter boundary established in M1.

## Files and modules changed

`scripts/migrations/002-intelligence.sql`, `scripts/setup.ts`, `scripts/demo.ts`, `src/contracts.ts`, `src/intelligence.ts`, `src/runs.ts`, `src/execution.ts`, `src/routes.ts`, `src/capabilities.ts`, `src/reply.ts`, `src/http.ts`, `src/worker.ts`, `src/config.ts`, `src/auth.ts`, `src/database.ts`, `tsconfig.json`, `package.json`, `tests/intelligence.test.ts`, `tests/runs.test.ts`, `tests/integration.test.ts`, `web/src/App.tsx`, `web/src/style.css`, `docs/setup.md`, `docs/openapi.json`, `README.md`, `.env.example`.

## Tests executed and results

- `bun run typecheck` (server + web): **pass**, exit 0.
- `bun test tests/unit.test.ts tests/intelligence.test.ts tests/integration.test.ts tests/runs.test.ts`: **31 pass, 0 fail, 201 expects**. Coverage includes: grounded extraction and refusal to invent, tenure caveat, validator rejection of fabricated quotes/fact IDs/scores, canonical hashing, contract rejections, full HTTP run lifecycle with worker execution, idempotent replay and conflict, candidate-grant denial, cross-tenant 404s, scope enforcement, cancellation semantics, lease recovery, quota, loopback demo isolation.
- `bun run build`: **pass** (Vite client + Bun server/worker bundles + runtime assets).
- Live smoke on the real processes (`bun src/server.ts`, `bun src/worker.ts`): analyze and match accepted 202, completed by the worker, events `run.created → run.started → run.completed`, capabilities deterministic.
- Browser verification (Preview): Overview, API explorer, live analysis (2 requirements with quotes), live match (not_evidenced / supported assessments citing synthetic facts), clean console, all demo requests 200/202.

## Remaining risks and limitations

- Polling queue adds latency (≤500 ms) and DB load; measure before scaling workers.
- Worker lease is 60 s and there is no mid-execution heartbeat yet. Deterministic work finishes in milliseconds; a slow future model provider needs a lease-extension loop before it ships.
- Requirement/matching quality is keyword-based by design; it is a starting point for a model provider, not a hiring signal.
- No deletion endpoint yet (`DELETE /v1/candidates/{ref}/data`), so retention is enforced by `expires_at`, not by purge jobs or erasure.
- Demo routes are loopback-only development scaffolding; they are excluded from the public contract.
- Webhooks, CV artifacts and browser execution remain unimplemented and are reported as such in `/v1/capabilities` and the contract.

## Next recommended milestone

**M3 — grounded CV tailoring and artifacts**: `POST /v1/cv/tailor`, immutable versioned `artifacts`, `GET /v1/artifacts/{id}`, extractive assembly with exact source text, stored checksums, artifact retrieval authorization, and deletion/retention jobs.
