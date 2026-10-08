# Audit: APIs and Backend

**Owning agent:** `backend-builder`

**Status:** active: build to this and self-check against it. Re-read this file fresh before every check; don't rely on memory.

This is a pass/fail checklist and a definition of done, not build instructions.

For each item, tell me pass or fail with a specific example.

1. Consistent endpoint naming and HTTP methods (see conventions in `API.md`).
2. Errors are graceful with correct status codes; no stack traces or internals in responses.
3. Input validation (schema) on every endpoint and server action.
4. Authentication and authorization on every protected endpoint (session, role, `organization_id`).
5. Responses return only needed fields: no secrets, password hashes, or other tenants' data.
6. No slow endpoints: pagination, no over-fetching, no N+1 queries.
7. (Added) Every route and server action is in `API.md`, and there are no orphan test routes or debug endpoints.
8. (Added) All inference goes through `lib/ai/inference.ts`; model IDs only from `lib/ai/models.ts`; methodology prompt loaded from `methodology_prompts`, never hardcoded; no silent cloud LLM fallback; SLM output is schema-validated before use.
9. (Added) Audit events written explicitly per `CLAUDE.md` (auth, sensitive reads, writes, exports, generation events) with ids only, no PHI content.

Give me an overall score out of 9 and list the top 3 things to fix first.
