# Audit: Rate Limiting and Cost Control

**Owning agent:** `resilience-builder` (paired with 10-13)

**Status:** active: build to this and self-check against it. Re-read this file fresh before every check; don't rely on memory.

This is a pass/fail checklist and a definition of done, not build instructions.

For each item, tell me pass or fail with a specific example.

1. Rate limits on expensive and auth endpoints (login, password reset, generation, regenerate-section) with stated thresholds.
2. Billing alerts on paid providers (Vercel, Neon, Resend).
3. Input-triggered calls are debounced (autosave, search).
4. Graceful 429 handling in the UI with retry/backoff.
5. Separate dev and prod keys/secrets (Neon, Resend, auth secrets, Tailscale auth keys), stored securely.
6. Usage dashboard or logging (generation events: model, tokens, latency recorded per `CLAUDE.md`).
7. Per-feature cost per user is estimated (token cost is zero for the SLM; estimate hardware load/latency per generation and Resend/Neon cost per user).
8. (Added) Per-organization concurrency cap on inference so one tenant cannot saturate its local box with queued requests.

Give me an overall score out of 8 and list the top 3 things to fix first.
