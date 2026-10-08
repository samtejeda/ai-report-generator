# Audit: CI/CD and Version Control

**Owning agent:** `platform-ops-builder`

**Status:** active: build to this and self-check against it. Re-read this file fresh before every check; don't rely on memory.

This is a pass/fail checklist and a definition of done, not build instructions.

For each item, tell me pass or fail with a specific example.

1. Small, well-messaged commits (message says why).
2. Feature branches and PRs; nothing direct to `main`; `main` branch-protected on the checks job.
3. Automated lint, typecheck, tests, and build on every PR (plus the Drizzle migration check).
4. Auto-deploy on merge to `main`.
5. No secrets in code or git history (scan performed, command and result recorded).
6. Fast revert, tested.

Give me an overall score out of 6 and list the top 3 things to fix first.
