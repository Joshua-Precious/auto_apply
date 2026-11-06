# career-ops connector

[career-ops](https://github.com/career-ops-hq/career-ops) is a local-first job-search agent. This connector exposes jobauto's grounded intelligence as a stdio MCP server inside a career-ops checkout. It does not modify career-ops's scoring, tracker, CV, or submission behavior.

## What it writes

Given a career-ops checkout, `connect.ts` merges a `jobauto` entry into:

- `.mcp.json` for Claude Code (`mcpServers.jobauto`)
- `opencode.json` for OpenCode (`mcp.jobauto`)

With `--with-skill`, it also appends a managed `jobauto` block to `modes/_custom.md`. Re-running replaces only that marked block.

It never writes an API key, candidate fact, report, or CV into the career-ops repository.

## Setup

1. Start jobauto and create a scoped key:

   ```bash
   bun run dev:api
   bun run keys create
   ```

2. Grant the candidate subject on the client. The default subject used by the skill is `career-ops`:

   ```sql
   UPDATE api_clients
   SET candidate_grants = '["career-ops"]'::jsonb
   WHERE id = '<client-id>';
   ```

3. Install the MCP entry and skill:

   ```bash
   bun run career-ops:connect --root /path/to/career-ops --with-skill
   ```

4. Launch career-ops's AI CLI from the career-ops directory with the credentials in its environment:

   ```bash
   export JOBAUTO_ORIGIN="http://127.0.0.1:4310"
   export JOBAUTO_API_KEY="$(cat /path/to/jobauto/.local/key-<id>.txt)"
   export JOBAUTO_SUBJECT_REF="career-ops"
   claude   # or opencode
   ```

   Use HTTPS for `JOBAUTO_ORIGIN` outside local development. The MCP server rejects non-loopback HTTP.

## Tools

The connector exposes only:

- `analyze_job` — grounded JD requirements with verbatim quotes
- `match_candidate` — supported / partial / not_evidenced assessments with fact IDs
- `tailor_cv` — immutable, checksummed extractive CV artifact
- `get_run` and `get_artifact` — authoritative recovery

There is no file, browser, email, or submission tool.

## Limits

- career-ops remains the owner of the candidate's files and the final documents.
- The API key must belong to a client with the required scopes and a candidate grant for `JOBAUTO_SUBJECT_REF`.
- The skill instructs the agent to use exact source text. It is still an AI workflow; review every output before use.
- `--dry-run` prints the merged JSON without changing either repository.
- Existing `.mcp.json` or `opencode.json` files must be valid JSON; the connector refuses to overwrite malformed configuration.
