## jobauto MCP

Use the `jobauto` MCP server only for grounded job intelligence: JD extraction, evidence matching, and extractive CV tailoring. It does not browse, write files, send email, or submit applications.

### Source of truth

Read the candidate from career-ops's user layer only: `cv.md`, `config/profile.yml`, `config/cv-facts.json`, and the current conversation. Never infer a fact from a job posting, a company page, or another project.

Build each MCP candidate fact from exact source text. Use stable IDs such as `summary`, `experience-<company>-<role>`, `skill-<name>`, or `education-<institution>`. Keep the original wording in `text`; do not add metrics, titles, employers, dates, or skills that the source does not state. If a fact cannot be stated without inventing something, omit it and say what is missing.

### Calls

1. Call `analyze_job` with the complete job-description text. Use its requirements and verbatim quotes; do not replace them with a summary.
2. Call `match_candidate` with the same JD text and the explicitly sourced facts. Set `subject_ref` to the value of `JOBAUTO_SUBJECT_REF` (default recommendation: `career-ops`). Report `supported`, `partial`, and `not_evidenced` exactly as returned. Never turn the result into a hiring probability or a numeric score.
3. Call `tailor_cv` when a tailored artifact is useful. Treat the returned artifact as extractive evidence for career-ops's own CV/PDF flow. It is not a PDF and does not replace the human review of the final document.
4. Use `get_run` / `get_artifact` to recover a timed-out call. Artifacts can expire; a 410 is not a reason to invent content.

### Guardrails

- The human reviews every document and clicks Submit. Never submit, send, or claim an application was submitted.
- Do not pass filesystem paths, URLs, cookies, credentials, or browser content to the MCP tools.
- Do not ask the MCP server to read career-ops files. Build the facts here, from the user layer, and pass only the facts needed for the operation.
- If the API returns `CANDIDATE_DENIED`, stop and ask the operator to add this subject to the client's candidate grant. Do not work around the grant.
- If a run fails or times out, report its real state. Do not retry by fabricating a successful result.
