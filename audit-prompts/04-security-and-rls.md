# Audit: Security and Row-Level Access

**Owning agent:** `auth-access-builder` (paired with `03-auth-and-permissions.md`)

**Status:** active: build to this and self-check against it. Re-read this file fresh before every check; don't rely on memory.

This is a pass/fail checklist and a definition of done, not build instructions.

For each item, tell me pass or fail with a specific example.

1. Data-level access enforcement on every table holding tenant or client data: every query filters by `organization_id` through a query-level guard (and Postgres RLS where adopted); a test proves org A cannot read or write org B.
2. No secrets in source or git history.
3. HTTPS everywhere, no mixed content.
4. Input sanitized/validated before queries and rendering (parameterized queries via Drizzle; no raw string SQL).
5. CORS restricted to known origins.
6. Every endpoint verifies identity and permissions.
7. Security headers set: CSP, X-Frame-Options, HSTS.
8. (Added) SSRF prevention: `inference_endpoint` only settable by an admin action and validated against an allow-list pattern; never from request input.
9. (Added) `audit_log` is append-only at the DB permission level; no PHI content stored in it.

Give me an overall score out of 9 and list the top 3 things to fix first.
