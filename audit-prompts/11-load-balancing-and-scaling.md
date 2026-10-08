# Audit: Load Balancing and Scaling

**Owning agent:** `resilience-builder`

**Status:** active: build to this and self-check against it. Re-read this file fresh before every check; don't rely on memory.

This is a pass/fail checklist and a definition of done, not build instructions.

For each item, tell me pass or fail with a specific example.

1. Traffic is distributed, or there is a documented reason it isn't (Vercel handles the web tier; each tenant's single Ollama box is intentionally one node, documented).
2. Scaling has min/max and a trigger (Vercel/Neon autoscaling limits stated; for the local box, the plan when one machine is not enough).
3. Health checks pull unhealthy instances (per-organization inference endpoint health is checked and surfaced; a down endpoint fails generation clearly, with no cloud fallback).
4. Session state lives in a shared store (database or signed token), not in function memory.
5. DB connection pooling (Neon pooled connection string) in use.
6. A read-scaling plan exists (Neon read replicas, pgvector index growth).

Give me an overall score out of 6 and list the top 3 things to fix first.
