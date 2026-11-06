# Planning artifact validation

> **Superseded (2026-11-06):** this file records validation of the original planning artifacts, before implementation. The service is now implemented on native Cequre; current evidence is `bun run typecheck`, `bun run test`, `bun run test:integration` and `cequre build`, with lifecycle coverage in `tests/cequre.test.ts`.

Date: 2026-10-10. **This validates design documents only, not an implemented service.**

## Final checks executed

Validation ran using `uv run --no-project` with temporary validator dependencies. No application dependencies or project lockfiles were created.

| Check | Result |
|---|---|
| [OpenAPI contract](openapi.json) parsed and validated as OpenAPI 3.1 | PASS using `openapi-spec-validator` 0.9.0 |
| Local `$ref` targets resolve | PASS; initial full traversal found 183 references; final schema expansion and spec validation rerun after edits |
| JSON Schema component definitions | PASS using `jsonschema` 4.26.0 (Draft 2020-12) |
| Endpoint permissions, execution mode, rate class, idempotency, transitions, retention, availability metadata | PASS for all 15 operations |
| Embedded HTTP request/response examples conform to referenced schemas | PASS for 20 expanded examples with format checking |
| Unsafe/malformed creation payloads | PASS: draft schema rejects arbitrary prompt, caller tenant ID, unsupported shell operation, matching without candidate, and raw metadata URL input |
| [PostgreSQL reference schema](schema.sql) syntax | PASS: final 31 statements parsed using `pglast` 8.5 |
| [Architecture](architecture.md) and [README](../README.md) links | PASS in final link check |
| Mermaid artifact presence | PASS: system flowchart, complete execution sequence and state graph present |
| Repository/runtime assessment | Workspace inspected; no Git repository/application source. CLI/runtime versions captured; no installation/upgrade performed |

The first syntax/example check was rerun after retention/schema refinements. Final validation command returned exit code 0. SQL checks are **parser-only**, not a database migration or foreign-key/transaction behavior test.

## Not executed / not established

- No application build, TypeScript typecheck, service unit/integration tests or HTTP API flow: there is no implementation yet.
- No PostgreSQL DDL execution, Cequre schema compilation, transaction/lock/CAS test, Redis connection or queue worker test.
- No frontend build/dev preview or rendered UI: frontend implementation awaits architecture approval.
- Mermaid diagrams were not rendered or parser-validated; Markdown source is supplied.
- No Browser Use installation/run, Chromium sandbox/egress validation, real job-board navigation or application submission.
- No model API calls, vendor account provisioning or CV quality/cost/performance measurements.
- No production privacy, legal or licensing certification. Owner supplied <10-person eligibility; tagged Cequre terms cited for review.
- No deployment, commit, push or Git initialization.

## Validation command shape

The executed checks used these packages:

```bash
uv run --no-project \
  --with openapi-spec-validator==0.9.0 \
  --with jsonschema==4.26.0 \
  --with pglast==8.5 python - <<'PY'
import json
from pathlib import Path
from openapi_spec_validator import validate
from pglast import parse_sql
spec = json.loads(Path('docs/openapi.json').read_text())
validate(spec)
print('OpenAPI valid')
print('PostgreSQL statements:', len(parse_sql(Path('docs/schema.sql').read_text())))
PY
```

This shortened reproduction validates structure and SQL syntax; the actual final run additionally expanded local references, checked every component schema/example and per-operation policy, and tested the five negative creation payloads listed above. Runtime and end-to-end acceptance gates are defined in [the milestone plan](architecture.md#14-milestones-and-acceptance-gates).
