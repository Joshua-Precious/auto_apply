# Milestone 3 report — grounded CV tailoring, artifacts and erasure

> **Cequre migration (2026-11-06):** the file paths and worker descriptions below record the original M3 implementation, which has since been replaced. The live code is `cequre/utilities/runs.ts`, `cequre/routes/index.ts` and `cequre/collections/*.cequre`; execution and retention now run in-process under Cequre cron. Current checks: 8 Cequre lifecycle tests (38 expects), typecheck and `cequre build` pass. The behavioural guarantees and remaining limitations below still apply.

Date: 2026-11-06. Status: **complete, verified**. No deployment, no model calls, no browser sessions, no external side effects.

## What was implemented

- **Extractive tailoring** (`src/intelligence.ts`): `tailor()` reorders only supplied candidate facts into Profile, Skills, Experience and Education sections. Each item is either the exact fact text or the exact `title at employer (start - end)` rendering. `validateTailoredCv()` rejects paraphrased text, altered employers or dates, unknown fact IDs, duplicate headings, score-like fields, invalid suggestion labels and empty documents. Job text cannot inject facts or documents.
- **Versioned artifacts** (`scripts/migrations/003-artifacts.sql`, `src/execution.ts`, `src/routes.ts`): `artifacts` stores tenant-scoped immutable `tailored_cv` content with a SHA-256 canonical checksum, a per-`(tenant, subject, kind)` version and the run's expiry. The artifact insert and the terminal run update share one transaction, so a completed run always points at a stored document and a stored document never belongs to an incomplete run.
- **Artifact retrieval** (`GET /v1/artifacts/{id}`): requires `artifacts:read` and the candidate grant, re-checks ownership on every read, returns `404` across tenants, `410` after retention and `null` download URLs while binary storage is disabled.
- **Candidate data deletion** (`src/deletion.ts`, `DELETE /v1/candidates/{ref}/data`, `GET /v1/deletions/{id}`): requires `data:delete` and the candidate grant. Acceptance is durable and coalesces an unfinished request per subject. The worker fences active runs, removes artifacts, candidate and job snapshots, clears results and sensitive run fields, and records counts. The deletion row is a pseudonymous tombstone with no candidate content, so a restored backup can replay the erasure.
- **Scheduled retention sweep** (`src/retention.ts`, `src/worker.ts`): every worker maintenance tick deletes up to `RETENTION_BATCH` expired artifacts, candidate snapshots, job snapshots and idempotency records per table, then clears expired run results and snapshot references while keeping run statuses and redacted events for audit. A snapshot still referenced by a retained run is left in place; `retention.purged` reports per-table counts and `expired_remaining`, so blocked work is visible instead of being reported as success.
- **MCP adapter** (`integrations/mcp/server.ts`, `bun run mcp`): newline-delimited JSON-RPC over stdio for local-first clients, protocol `2025-11-25` with older-version negotiation. Tools: `analyze_job`, `match_candidate`, `tailor_cv`, `get_run`, `get_artifact`. Origin and credential come only from the environment; there is no file access and no submission tool.
- **Workbench** (`web/src/App.tsx`): live tailoring scenario with run polling, separate artifact retrieval and validated section rendering, plus artifact/deletion limits and the M3 release markers.
- **Honest capability surface** (`src/capabilities.ts`, `src/http.ts`, `docs/openapi.json`): `cv_tailoring: true`; tailoring, artifacts, deletion and deletion status are in the live contract; approval, resume, webhooks and browser execution still fail closed with `422 FEATURE_DISABLED`.

## Architectural decisions

1. **Extractive before generative.** Passing a model's paraphrase off as the candidate's own history is the highest-risk failure in a CV tool. The first release therefore ships exact reuse only; suggestions are a separate, explicitly `unverified_suggestion` channel that never enters an approved document automatically.
2. **Artifact and terminal state are atomic.** Splitting them would allow a `completed` run whose artifact is missing, or an orphan artifact for a failed run. Both are written under the same fenced transaction.
3. **Versions are assigned in SQL.** `COALESCE(MAX(version),0)+1` inside the insert keeps concurrent runs from claiming the same version, backed by the unique constraint.
4. **Deletion is queued work.** A privacy purge spans several tables and must not hold an HTTP transaction open. The worker claims a queued deletion with `SKIP LOCKED` and performs idempotent, tenant-scoped deletes; failure is recorded as `failed` with a sanitized error, and a new request can follow.
5. **Expire content without erasing the audit trail.** Deleting a run at 30 days would contradict the longer redacted-audit promise. The sweep redacts content and references on terminal runs, then removes now-unreferenced snapshots and idempotency records; anything still referenced is reported as remaining rather than silently skipped.
6. **A thin MCP bridge, not a hosted dependency.** Local-first tools already own the candidate's files and the human's attention. The adapter keeps that cockpit local while durable execution stays here, and deliberately cannot read files, redirect its origin or submit anything.

## Files and modules changed

`scripts/migrations/003-artifacts.sql`, `src/intelligence.ts`, `src/contracts.ts`, `src/execution.ts`, `src/routes.ts`, `src/deletion.ts`, `src/retention.ts`, `src/http.ts`, `src/capabilities.ts`, `src/config.ts`, `src/worker.ts`, `src/database.ts`, `tests/artifacts.test.ts`, `tests/retention.test.ts`, `tests/mcp.test.ts`, `integrations/mcp/server.ts`, `package.json`, `web/src/App.tsx`, `web/src/style.css`, `docs/openapi.json`, `docs/setup.md`, `README.md`, `.env.example`.

## Tests executed and results

- `bun run typecheck` (server + web): **pass**, exit 0.
- `bun run test` — `tests/unit.test.ts`, `tests/intelligence.test.ts`, `tests/mcp.test.ts`: **23 pass, 0 fail, 116 expects**. Includes exact-text tailoring, refusal of paraphrase/altered employer/unknown fact ID/score fields, hostile job-text injection, MCP version negotiation, tool list, per-operation consent purpose, stored-checksum readback, idempotency-key reuse, origin non-redirection and honest tool errors.
- `bun run test:integration` — `tests/integration.test.ts`, `tests/runs.test.ts`, `tests/artifacts.test.ts`, `tests/retention.test.ts` against real PostgreSQL, Redis, HTTP and the worker: **31 pass, 0 fail, 255 expects**. Includes the full tailoring run through the worker, checksum verification, cross-tenant 404, missing-grant 403, anonymous 401, consent-purpose mismatch, deletion acceptance/coalescing, foreign-tenant deletion isolation, worker purge, post-purge artifact 404, expired-content deletion, audit-row retention, fresh-content preservation, blocked-reference reporting and an idempotent second sweep.
- `bun run build`: **pass**, exit 0 — Vite client 227.82 kB JS (70.27 kB gzip) / 21.38 kB CSS (5.40 kB gzip), Bun server 56.18 kB and worker 75.57 kB bundles, runtime assets staged.
- OpenAPI contract re-parsed and the live contract path filter re-exercised through the integration suite after the availability edits.

## Remaining risks and limitations

- The sweep is batched: a backlog larger than `RETENTION_BATCH` drains over multiple 15-second maintenance ticks. Content still referenced by a retained run stays and is reported in `expired_remaining` until the reference is released.
- A failed deletion stays `failed`; a caller must issue a new request to retry. There is no automatic retry schedule.
- Backup purge and restore replay are documented as a policy, not drilled against a real backup.
- Tailoring quality is section ordering and exact reuse, not rewriting; `suggestions` is always empty in deterministic mode.
- No binary document rendering or signed URLs; artifacts are structured JSON only.
- The MCP adapter's protocol surface is covered with an injected fetch. It was not exercised against a live server in this pass.
- Webhooks, browser execution, approval/resume and submission remain unimplemented and are reported as such.

## Next recommended milestone

**M4 — isolated browser provider and controlled preparation**: typed browser supervisor boundary, deterministic owned-test-target operations, restricted egress, ephemeral browser state, challenge/unsupported reporting, and a typed application draft with a digest. No real job-board accounts or applications.
