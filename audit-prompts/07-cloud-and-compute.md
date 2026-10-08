# Audit: Cloud and Compute

**Owning agent:** `platform-ops-builder`

**Status:** active: build to this and self-check against it. Re-read this file fresh before every check; don't rely on memory.

This is a pass/fail checklist and a definition of done, not build instructions.

For each item, tell me pass or fail with a specific example.

1. No needlessly frequent functions, queries, or calls (no polling where streaming or revalidation works).
2. Right-sized compute (Vercel function region near Neon; Neon compute size/autosuspend sensible).
3. Sane serverless timeouts, memory, and concurrency, including `maxDuration` on streaming generation routes.
4. Large assets are served via CDN, not the compute layer.
5. The first failure point at 10x traffic is known and written down (expected: the single local Ollama box's concurrency, then Neon connections).
6. Billing alerts and budget visibility on Vercel and Neon.

Give me an overall score out of 6 and list the top 3 things to fix first.
