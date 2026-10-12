# API.md

Inventory of every endpoint and server action. Updated in the same commit as any new or changed route (owner: `backend-builder`). No orphan test routes.

## Conventions

- Resource-oriented paths under `app/api/`, plural nouns, kebab-case: `/api/clients`, `/api/reports/{id}/sections/{sectionId}`.
- Methods: `GET` read, `POST` create/action, `PATCH` partial update, `DELETE` remove (soft delete unless a hard-deletion request).
- Every handler: authenticate, authorize (role + `organization_id`), validate input with a schema, call a tenant-scoped data function, write an audit event, return minimal fields.
- Errors: JSON `{ "error": { "code": string, "message": string } }` with correct status codes (400 validation, 401 unauthenticated, 403 unauthorized, 404 not found within the caller's org, 409 conflict, 429 rate limited, 500 generic with no internals).
- Return 404 (not 403) for resources in another organization, to avoid leaking existence.
- Lists are paginated (cursor or limit/offset with a max).
- Never include `password_hash`, tokens, or other tenants' fields in responses.
- Never log request bodies; audit events carry ids, not PHI.
- Generation endpoints stream via the Vercel AI SDK and call inference only through `lib/ai/inference.ts`.

## Endpoints

| Method | Path | Auth / roles | Purpose | Audit event | Rate limit |
|---|---|---|---|---|---|
| GET | `/api/health` | Public (intentionally; no tenant data) | Liveness plus database reachability (`select 1`). Returns `{status:"ok"}` or 503 `{status:"unavailable"}`; no versions, hosts, or error text. | None (health noise excluded) | None yet (resilience-builder to add a coarse limit) |

## Server actions

| Action | File | Auth / roles | Purpose | Audit event |
|---|---|---|---|---|
| _none yet_ | | | | |
