# Audit: Error Tracking and Logs

**Owning agent:** `resilience-builder`

**Status:** active: build to this and self-check against it. Re-read this file fresh before every check; don't rely on memory.

This is a pass/fail checklist and a definition of done, not build instructions.

For each item, tell me pass or fail with a specific example.

1. An error tracking service (Sentry) captures errors automatically.
2. Error boundaries show a useful fallback instead of a blank screen.
3. Structured logs (user id, organization id, action, timestamp, severity); no raw `console.log` in committed code.
4. Alerting on critical errors.
5. Source maps uploaded to the error tracker and not publicly served.
6. No passwords, tokens, card numbers, or PHI (client names, report content, request bodies) in logs or error reports; Sentry scrubbing config verified with a test event.
7. (Added) Application logs and `audit_log` are kept separate, per `CLAUDE.md`.

Give me an overall score out of 7 and list the top 3 things to fix first.
