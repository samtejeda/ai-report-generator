# Audit: Caching and CDN

**Owning agent:** `resilience-builder`

**Status:** active: build to this and self-check against it. Re-read this file fresh before every check; don't rely on memory.

This is a pass/fail checklist and a definition of done, not build instructions.

For each item, tell me pass or fail with a specific example.

1. Modern image formats, properly sized, lazy loaded.
2. Static assets on a CDN with proper headers.
3. Long cache lifetimes with cache-busting (hashed filenames).
4. Cached dynamic content has an invalidation strategy.
5. Lighthouse performance and LCP are recorded (numbers and date).
6. Efficient font loading (`next/font`, no layout shift).
7. Code splitting in place.
8. (Added) Authenticated or PHI-bearing responses are never cached by shared caches or the CDN (`Cache-Control: private, no-store`); verified on report, client, and API responses.

Give me an overall score out of 8 and list the top 3 things to fix first.
