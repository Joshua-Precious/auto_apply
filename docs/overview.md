# Product overview

## What jobauto is

jobauto is an independent, API-first **job-intelligence service** with a developer workbench and a Model Context Protocol (MCP) adapter. It turns a job posting and, when authorized, a candidate's explicitly supplied facts into structured, evidence-linked results.

It is deliberately **not** an auto-apply bot. It does not log in to job boards, fill forms, submit applications or predict hiring outcomes. The product prepares material; a human reviews and submits it.

## The shortest description

> Submit a job. Get quotable requirements. Match them only against facts the candidate authorized. Produce an extractive CV tailored to that job, with every line traceable to submitted data.

## Two ways to use it

**Developer workbench** - a React/Vite UI backed by the API. It is for inspecting runs, event history, matches and tailored artifacts.

**MCP / career-ops** - `bun run mcp` starts a local stdio MCP server. A local-first agent such as career-ops can call `analyze_job`, `match_candidate`, `tailor_cv`, `get_run` and `get_artifact`. The agent owns its files; jobauto never reads them directly. The connector only installs configuration and a skill, never a credential or candidate file.

## Runtime architecture

```text
Browser workbench                         career-ops / other MCP client
       |                                              |
       | HTTPS, scoped API key                        | stdio MCP
       v                                              v
   Reverse proxy / TLS  ----------------------->  jobauto HTTP API
                                                       |
                                             Cequre 1.0.8 runtime
                                                       |
                                                PostgreSQL
```

- **Cequre** owns the collections, routes, transactions, authentication hooks and in-process cron. There is no separate worker process.
- **PostgreSQL** is the system of record for tenants, clients, keys, runs, events, snapshots, artifacts, deletions and idempotency records.
- The API is stateless across replicas. A conditional database update gives exactly one replica the right to execute a queued run; a stale lease lets another replica recover it.
- The built artifact is one Bun server bundle plus static workbench assets, packaged as a non-root Docker image.

## Request lifecycle

1. **Authenticate.** A bearer key identifies the client and tenant. Scopes gate the operation; candidate facts additionally require a per-client subject grant.
2. **Validate and snapshot.** The request is parsed, bounded and snapshotted. The job text and authorized candidate facts are stored as immutable inputs for the run.
3. **Accept transactionally.** The run, first event, snapshots and idempotency record are written in one transaction. The same idempotency key and payload replay the original run; changed input returns 409.
4. **Enforce quota.** A per-tenant active-run quota prevents one tenant from exhausting intelligence work. Excess requests receive `429 ACTIVE_LIMIT_REACHED` with `Retry-After`.
5. **Claim once.** A conditional `UPDATE ... WHERE status = 'queued'` moves the run to `running` on exactly one replica. A run whose process dies is requeued after the ten-minute lease window.
6. **Execute deterministically.** Analysis extracts verbatim requirement quotes and verifies them against the submitted text. Matching cites supplied fact IDs only. Tailoring copies exact fact text into an immutable, checksummed artifact.
7. **Record evidence.** Ordered, redacted events track acceptance, progress, completion, failure or cancellation. The run result points to the stored artifact where applicable.
8. **Retain and erase.** A one-minute cron sweeps expired artifacts, snapshots and idempotency records. Candidate deletion cancels active work, removes snapshots/artifacts and nulls sensitive run fields, leaving a pseudonymous deletion record.

## Core operations

| Operation | Input | Output |
| --- | --- | --- |
| `job_analysis` | Job text | Normalized job, requirements, each with a verbatim source quote |
| `match` | Job text + authorized candidate facts | `supported`, `partial` or `not_evidenced` per requirement, with fact IDs and limitations |
| `cv_tailoring` | Job text + authorized candidate facts | Extractive tailored CV artifact with SHA-256 checksum |
| `application_prepare` | - | **Unavailable.** Fails closed with `422 FEATURE_DISABLED` |

The service returns the stable envelopes used by both clients:

```json
{ "data": { }, "request_id": "..." }
{ "error": { "code": "...", "message": "...", "retryable": false, "details": [] }, "request_id": "..." }
```

## Data model

| Collection | Purpose |
| --- | --- |
| `tenants` | Isolation boundary for clients, runs and data |
| `api_clients` | Scopes, candidate grants and tenant ownership |
| `api_keys` | Hashed credentials, expiry and revocation state |
| `job_snapshots` | Immutable submitted job inputs |
| `candidate_snapshots` | Authorized candidate facts and consent purpose |
| `runs` | Durable state machine, versions, result references and lease timestamps |
| `run_events` | Ordered, redacted event history |
| `artifacts` | Immutable tailored CV content, checksum and expiry |
| `deletions` | Pseudonymous erasure outcome |
| `idempotency_records` | Request replay and conflict detection |

All application collections are hidden from generated CRUD/admin surfaces. Every public operation goes through an explicit route.

## Safety and privacy boundaries

- Candidate facts must be supplied explicitly and are gated by a `candidate_grants` entry for that exact `subject_ref`.
- Consent is stored with the run purpose (`job_matching` or `cv_tailoring`).
- Tailoring is extractive: it does not paraphrase, invent or add facts. Every line is submitted text or an exact title, employer, institution, credential, project or date value.
- Matching never returns a numeric score or hiring probability.
- The loopback demo keeps its key server-side and is disabled by `ENABLE_LOCAL_DEMO=false` and `NODE_ENV=production`.
- No CV, credential, cookie or production key belongs in the repository. Operator keys are written once under the ignored `.local/` directory.
- The MCP adapter has no file-access or submission tool.

## Deployment shape

- One image, one HTTP port, any number of API replicas.
- PostgreSQL with a stable `API_KEY_PEPPER`; secrets injected by the platform, not baked into the image.
- TLS and request-rate limits at the reverse proxy or API gateway. The application ships a per-tenant active-run quota, not a distributed request limiter.
- Startup performs additive schema initialization. For a dedicated migration step, the image supports `SCHEMA_INIT_ONLY=1`; from source use `bun run db:init`.
- `GET /v1/health` is the readiness endpoint; it exposes only service status and backend type.

## Deliberate limits

- Deterministic keyword overlap; synonyms and unstated experience are not inferred.
- Matching is an evidence review, not a qualification or hiring prediction.
- No browser automation, form filling, application submission, webhooks or approval/resume workflow yet.
- No distributed request-rate limiter in the application; enforce that at the edge.
- The workbench is a developer tool, not a multi-user account product.

## Read next

- [Setup](setup.md) - local bootstrap, keys and development.
- [Production](production.md) - topology, secrets, backups and go-live checks.
- [OpenAPI](openapi.json) - the actual HTTP contract.
- [career-ops connector](../integrations/career-ops/README.md) - MCP installation and guardrails.