# Audit: Availability and Recovery

**Owning agent:** `resilience-builder`

**Status:** active: build to this and self-check against it. Re-read this file fresh before every check; don't rely on memory.

This is a pass/fail checklist and a definition of done, not build instructions.

For each item, tell me pass or fail with a specific example.

1. Uptime monitoring with alerts.
2. A health endpoint that checks dependencies (database and each organization's inference endpoint), not just that the server is up; it exposes no PHI or internals.
3. Automated off-site backups.
4. A restore has actually been performed once, with date and result recorded in `docs/RUNBOOK.md`.
5. Deployment rollback works (tested).
6. A runbook of step-by-step failure recovery exists in `docs/RUNBOOK.md` (deploy, DB, inference endpoint down, leaked secret, suspected PHI exposure).
7. (Added) When the local SLM is unreachable, the app degrades gracefully (clear error, drafts and edits still work) and never falls back to a cloud LLM.

Give me an overall score out of 7 and list the top 3 things to fix first.
